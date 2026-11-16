#!/usr/bin/env node
// PixelClock Desktop engine sync: node tools/sync.mjs [--source <dir>] [--check]
//
// Copies the clock's engine files byte for byte into vendor/pixelclock/:
//   simulator/engine.js, simulator/schedule.js, simulator/screens.js, simulator/themes/*.js, tools/render.js.
// Never main.js, sound.js, index.html or style.css. Nothing is edited, reformatted or re-encoded.
//
// - Source: --source <dir>, else env PCD_PIXELCLOCK, else the sibling folder ../PixelClock.
// - Read-only on the clock repo: inside it this tool only reads, lists and stats. It never starts a process
//   there (no git, no node) and every path it writes is checked to be inside vendor/ or os.tmpdir() and not
//   inside the clock repo. The commit id is read from .git/HEAD and the refs files ("unknown" if that fails).
// - Smoke test: the files are staged in os.tmpdir()/pcd-sync-*; one child Node process (cwd = the stage) loads
//   them through the staged render.js with a counting wrapper on drawClock installed first, checks the API
//   surface the adapter uses, renders every theme at 3, 7, 12 and 19 h with and without a shake (no throw,
//   4096 values <= 0xffffff over a sentinel fill, drawClock once per draw) and resolves three dates.
// - Commit: pass -> vendor/pixelclock/ is replaced by rename and SYNC.json written; identical hashes -> nothing
//   is written at all (no stage, no process); fail -> the old copy stays, the reason is printed, exit code 1.
// - --check: compare only (exit 0 when vendor/ matches the clock repo, 1 when it differs); writes nothing.
//
// Node built-ins only. fs and child_process are used through their module objects so tests can spy on them.
import cp from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const VENDOR_DIR = path.join(ROOT, 'vendor', 'pixelclock');
export const SOURCE_ENV = 'PCD_PIXELCLOCK';
export const SYNC_FILE = 'SYNC.json';
/** The PixelClock API the adapter relies on (checked by the smoke test). */
export const API = ['Canvas', 'Rng', 'drawClock', 'drawDigit', 'drawTime', 'drawSmallText', 'smallTextWidth', 'mix', 'themes', 'themeById', 'themeIdForDate', 'holidayFor', 'seasonFor', 'HOLIDAYS'];
export const SMOKE_HOURS = [3, 7, 12, 19];
export const SMOKE_DATES = [[2026, 11, 15], [2026, 10, 31], [2026, 12, 25]];
const FIXED = ['simulator/engine.js', 'simulator/schedule.js', 'simulator/screens.js'];
const RENDER = 'tools/render.js';
const SENTINEL = 0xdeadbeef; // > 0xffffff: a pixel a theme forgot to paint fails the value check

const toPosix = (p) => String(p).split(path.sep).join('/');
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/** True when `child` is `parent` itself or inside it (case-insensitive on Windows). */
export function isInside(parent, child) {
  const r = path.relative(path.resolve(parent), path.resolve(child));
  if (r === '') return true;
  return r !== '..' && !r.startsWith('..' + path.sep) && !r.startsWith('../') && !path.isAbsolute(r);
}

/** The clock repo: env PCD_PIXELCLOCK, else ../PixelClock next to this project. */
export function defaultSource(env = process.env, root = ROOT) {
  return env[SOURCE_ENV] ? path.resolve(env[SOURCE_ENV]) : path.resolve(root, '..', 'PixelClock');
}

/** The files to copy, in vendor order: [{ path (posix, vendor-relative), abs }]. Lists and stats only. */
export function sourceList(source) {
  const themeDir = path.join(source, 'simulator', 'themes');
  const themes = fs.readdirSync(themeDir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.js'))
    .map((e) => `simulator/themes/${e.name}`)
    .sort();
  return [...FIXED, ...themes, RENDER].map((rel) => ({ path: rel, abs: path.join(source, ...rel.split('/')) }));
}

/** The commit the clock repo's HEAD points at, read from .git files (never git itself); 'unknown' on failure. */
export function readCommit(source) {
  try {
    let gitDir = path.join(source, '.git');
    const st = fs.statSync(gitDir);
    if (st.isFile()) {
      const m = /^gitdir:\s*(.+)\s*$/m.exec(fs.readFileSync(gitDir, 'utf8'));
      if (!m) return 'unknown';
      gitDir = path.resolve(source, m[1].trim());
    }
    const head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
    if (/^[0-9a-f]{40}$/.test(head)) return head;
    const ref = /^ref:\s*(\S+)$/.exec(head);
    if (!ref) return 'unknown';
    const refFile = path.join(gitDir, ...ref[1].split('/'));
    if (fs.existsSync(refFile)) {
      const id = fs.readFileSync(refFile, 'utf8').trim();
      if (/^[0-9a-f]{40}$/.test(id)) return id;
    }
    const packed = path.join(gitDir, 'packed-refs');
    if (fs.existsSync(packed)) {
      for (const line of fs.readFileSync(packed, 'utf8').split(/\r?\n/)) {
        const m = /^([0-9a-f]{40}) (\S+)$/.exec(line.trim());
        if (m && m[2] === ref[1]) return m[1];
      }
    }
  } catch {
    // unreadable: unknown
  }
  return 'unknown';
}

/** Read every source file: { files: [{ path, bytes, sha256, data }], commit }. Throws when the repo is missing. */
export function readSource(source) {
  if (!fs.existsSync(path.join(source, 'simulator', 'engine.js'))) {
    throw new Error(`no PixelClock simulator at ${source} (set ${SOURCE_ENV} or pass --source)`);
  }
  const files = sourceList(source).map((f) => {
    const st = fs.lstatSync(f.abs);
    if (!st.isFile()) throw new Error(`${f.path} is not a regular file in the clock repo`);
    const data = fs.readFileSync(f.abs);
    return { path: f.path, bytes: data.length, sha256: sha256(data), data };
  });
  return { files, commit: readCommit(source) };
}

/** What vendor/ holds now: { sync (parsed SYNC.json or null), syncError, files: [{ path, bytes, sha256 }] }. */
export function readVendor(vendorDir) {
  const out = { sync: null, syncError: null, files: [] };
  if (!fs.existsSync(vendorDir)) return out;
  try {
    const buf = fs.readFileSync(path.join(vendorDir, SYNC_FILE));
    if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) throw new Error('starts with a BOM');
    out.sync = JSON.parse(buf.toString('utf8'));
  } catch (e) {
    out.syncError = e.message;
  }
  const walk = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(abs);
      else {
        const rel = toPosix(path.relative(vendorDir, abs));
        if (rel === SYNC_FILE) continue;
        const data = fs.readFileSync(abs);
        out.files.push({ path: rel, bytes: data.length, sha256: sha256(data) });
      }
    }
  };
  walk(vendorDir);
  out.files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return out;
}

/** Differences between source files and vendor files: { same, added, changed, removed, syncOk }. */
export function compare(sourceFiles, vendor) {
  const have = new Map(vendor.files.map((f) => [f.path, f]));
  const want = new Map(sourceFiles.map((f) => [f.path, f]));
  const added = sourceFiles.filter((f) => !have.has(f.path)).map((f) => f.path);
  const changed = sourceFiles.filter((f) => have.has(f.path) && have.get(f.path).sha256 !== f.sha256).map((f) => f.path);
  const removed = vendor.files.filter((f) => !want.has(f.path)).map((f) => f.path);
  const listed = vendor.sync && Array.isArray(vendor.sync.files) ? vendor.sync.files : null;
  const syncOk = !!listed && listed.length === sourceFiles.length
    && sourceFiles.every((f) => listed.some((l) => l.path === f.path && l.sha256 === f.sha256 && l.bytes === f.bytes));
  return { same: !added.length && !changed.length && !removed.length && syncOk, added, changed, removed, syncOk };
}

/** A write guard: every mutated path must be inside one of `roots` and never inside `forbidden`. */
export function writeGuard({ roots, forbidden }) {
  const allowed = roots.map((r) => path.resolve(r));
  const deny = path.resolve(forbidden);
  return (p, op) => {
    const abs = path.resolve(p);
    if (isInside(deny, abs)) throw new Error(`sync: refusing to ${op} inside the clock repo: ${abs}`);
    if (!allowed.some((r) => isInside(r, abs))) throw new Error(`sync: refusing to ${op} outside vendor/ and the temp folder: ${abs}`);
    return abs;
  };
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** fs.renameSync with retries (OneDrive or a scanner may hold a handle for a moment). */
function renameRetry(from, to, tries = 20) {
  for (let i = 0; ; i++) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (e) {
      if (i >= tries || !['EPERM', 'EBUSY', 'EACCES', 'ENOTEMPTY'].includes(e.code)) throw e;
      sleepSync(150);
    }
  }
}

// The smoke test, run by a child Node process inside the stage folder (CommonJS, Node built-ins only).
export const SMOKE_SCRIPT = `'use strict';
const path = require('path');
const [dir, apiJson, hoursJson, datesJson] = process.argv.slice(2);
const API = JSON.parse(apiJson);
const HOURS = JSON.parse(hoursJson);
const DATES = JSON.parse(datesJson);
const out = { ok: false, problems: [], themes: [], draws: 0, dates: {} };
try {
  require(path.join(dir, 'simulator', 'engine.js'));
  const PC = globalThis.PixelClock;
  if (!PC || typeof PC.drawClock !== 'function') throw new Error('engine.js did not define PixelClock.drawClock');
  let calls = 0;
  const original = PC.drawClock;
  const counting = function () { calls++; return original.apply(this, arguments); };
  PC.drawClock = counting;
  const R = require(path.join(dir, 'tools', 'render.js'));
  if (R.PC !== PC || globalThis.PixelClock.drawClock !== counting) out.problems.push('render.js did not reuse engine.js from the require cache (a wrapper installed first was lost)');
  const missing = API.filter((k) => PC[k] === undefined);
  if (missing.length) out.problems.push('API missing: ' + missing.join(', '));
  if (typeof R.png !== 'function' || typeof R.run !== 'function' || typeof R.ctxAt !== 'function') out.problems.push('render.js no longer exports png, run and ctxAt');
  if (!Array.isArray(PC.themes) || !PC.themes.length) out.problems.push('no themes registered');
  for (const theme of PC.themes) {
    out.themes.push(theme.id);
    for (const hour of HOURS) {
      for (const shake of [false, true]) {
        const label = theme.id + ' @ ' + hour + ' h' + (shake ? ' with a shake' : '');
        try {
          const inst = theme.create(new PC.Rng(12345));
          const ctx = { hours: Math.floor(hour), minutes: 0, seconds: 0, ms: 0, hourFloat: hour, year: 2026, month: 11, day: 15, hour12: true, showDate: true, shake: false };
          for (let i = 0; i < 30; i++) inst.update(1 / 30, Object.assign({}, ctx, { shake: shake && i === 5 }));
          const fb = new PC.Canvas();
          fb.px.fill(${SENTINEL});
          const before = calls;
          inst.draw(fb, ctx);
          if (calls - before !== 1) out.problems.push(label + ': drawClock called ' + (calls - before) + ' times');
          if (fb.px.length !== 4096) out.problems.push(label + ': ' + fb.px.length + ' pixels, not 4096');
          let bad = 0;
          for (let i = 0; i < fb.px.length; i++) if (!(fb.px[i] >= 0 && fb.px[i] <= 0xffffff)) bad++;
          if (bad) out.problems.push(label + ': ' + bad + ' pixels unpainted or outside 0..0xffffff');
          out.draws++;
        } catch (e) {
          out.problems.push(label + ': ' + (e && e.message ? e.message : e));
        }
      }
    }
  }
  for (const [y, m, d] of DATES) {
    const id = PC.themeIdForDate(y, m, d);
    out.dates[y + '-' + m + '-' + d] = id;
    if (!PC.themeById(id)) out.problems.push('themeIdForDate(' + y + ', ' + m + ', ' + d + ') = ' + id + ': not a registered theme');
  }
  out.ok = out.problems.length === 0;
} catch (e) {
  out.problems.push('exception: ' + (e && e.stack ? e.stack : e));
}
process.stdout.write(JSON.stringify(out) + '\\n');
process.exitCode = out.ok ? 0 : 1;
`;

/** Run the smoke test on a staged copy. Resolves { ok, reason, result }. */
export function smokeTest(stageDir, { timeoutMs = 60000 } = {}) {
  const script = path.join(stageDir, 'smoke.cjs');
  const r = cp.spawnSync(process.execPath, [script, path.join(stageDir, 'pixelclock'), JSON.stringify(API), JSON.stringify(SMOKE_HOURS), JSON.stringify(SMOKE_DATES)], {
    cwd: stageDir, encoding: 'utf8', windowsHide: true, timeout: timeoutMs,
  });
  if (r.error) return { ok: false, reason: `smoke test could not run: ${r.error.message}`, result: null };
  let result = null;
  try {
    result = JSON.parse(String(r.stdout || '').trim().split(/\r?\n/).pop());
  } catch {
    return { ok: false, reason: `smoke test printed no result (exit ${r.status}): ${String(r.stderr || '').trim().slice(0, 600)}`, result: null };
  }
  if (r.status !== 0 || !result.ok) return { ok: false, reason: `smoke test failed: ${result.problems.slice(0, 8).join('; ')}${result.problems.length > 8 ? ` (and ${result.problems.length - 8} more)` : ''}`, result };
  return { ok: true, reason: '', result };
}

function rel(from, to) {
  const r = path.relative(from, to);
  return path.isAbsolute(r) ? toPosix(to) : toPosix(r) || '.';
}

/**
 * Sync (or with check: compare). Options: { source, vendorDir, check, log, now }.
 * Resolves { code, status: 'unchanged'|'synced'|'failed'|'drift', files, commit, diff, smoke, reason }.
 */
export function runSync({ source = defaultSource(), vendorDir = VENDOR_DIR, check = false, log = console.log, now = () => new Date() } = {}) {
  source = path.resolve(source);
  vendorDir = path.resolve(vendorDir);
  const projectRoot = path.dirname(path.dirname(vendorDir));
  let src;
  try {
    src = readSource(source);
  } catch (e) {
    log(`sync FAILED: ${e.message}; ${rel(projectRoot, vendorDir)}/ keeps its current copy`);
    return { code: 1, status: 'failed', reason: e.message };
  }
  const vendor = readVendor(vendorDir);
  const diff = compare(src.files, vendor);
  const summary = { files: src.files.length, commit: src.commit, diff };
  if (diff.same) {
    log(`sync: ${rel(projectRoot, vendorDir)}/ is up to date (${src.files.length} files, clock commit ${src.commit.slice(0, 7)}); nothing written`);
    return { code: 0, status: 'unchanged', ...summary };
  }
  const lines = [
    ...diff.added.map((p) => `  + ${p}`),
    ...diff.changed.map((p) => `  ~ ${p}`),
    ...diff.removed.map((p) => `  - ${p}`),
  ];
  if (!diff.syncOk && !lines.length) lines.push(`  ${SYNC_FILE} ${vendor.sync ? 'does not list the files' : `missing or unreadable${vendor.syncError ? ` (${vendor.syncError})` : ''}`}`);
  if (check) {
    log(`sync --check: ${rel(projectRoot, vendorDir)}/ differs from the clock repo (commit ${src.commit.slice(0, 7)}):\n${lines.join('\n')}`);
    return { code: 1, status: 'drift', ...summary };
  }

  const guard = writeGuard({ roots: [path.dirname(vendorDir), os.tmpdir()], forbidden: source });
  const tmpRoot = guard(os.tmpdir(), 'stage');
  let stage = null;
  let next = null;
  try {
    stage = fs.mkdtempSync(path.join(tmpRoot, 'pcd-sync-'));
    guard(stage, 'stage');
    for (const f of src.files) {
      const dst = guard(path.join(stage, 'pixelclock', ...f.path.split('/')), 'stage');
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.writeFileSync(dst, f.data);
    }
    fs.writeFileSync(guard(path.join(stage, 'smoke.cjs'), 'stage'), SMOKE_SCRIPT);
    const smoke = smokeTest(stage);
    if (!smoke.ok) {
      log(`sync FAILED: ${smoke.reason}\n${rel(projectRoot, vendorDir)}/ keeps its last good copy (clock commit ${vendor.sync && vendor.sync.commit ? String(vendor.sync.commit).slice(0, 7) : 'none'}).`);
      return { code: 1, status: 'failed', reason: smoke.reason, smoke: smoke.result, ...summary };
    }
    const record = {
      source: rel(projectRoot, source),
      commit: src.commit,
      files: src.files.map((f) => ({ path: f.path, bytes: f.bytes, sha256: f.sha256 })),
      syncedAt: now().toISOString(),
    };
    const parent = guard(path.dirname(vendorDir), 'create');
    fs.mkdirSync(parent, { recursive: true });
    const tag = `${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
    next = guard(path.join(parent, `.${path.basename(vendorDir)}-next-${tag}`), 'write');
    for (const f of src.files) {
      const dst = guard(path.join(next, ...f.path.split('/')), 'write');
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.writeFileSync(dst, f.data);
    }
    fs.writeFileSync(guard(path.join(next, SYNC_FILE), 'write'), JSON.stringify(record, null, 2) + '\n');
    let old = null;
    if (fs.existsSync(vendorDir)) {
      old = guard(path.join(parent, `.${path.basename(vendorDir)}-old-${tag}`), 'rename');
      renameRetry(guard(vendorDir, 'rename'), old);
    }
    try {
      renameRetry(next, guard(vendorDir, 'rename'));
      next = null;
    } catch (e) {
      if (old) renameRetry(old, vendorDir);
      throw e;
    }
    if (old) fs.rmSync(guard(old, 'remove'), { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    const r = smoke.result;
    log(`sync: ${src.files.length} files copied into ${rel(projectRoot, vendorDir)}/ (clock commit ${src.commit.slice(0, 7)}):\n${lines.join('\n')}\n`
      + `  smoke test PASS: ${r.themes.length} themes, ${r.draws} draws at ${SMOKE_HOURS.join(', ')} h with and without a shake; `
      + `dates ${Object.entries(r.dates).map(([d, id]) => `${d} ${id}`).join(', ')}`);
    return { code: 0, status: 'synced', smoke: r, record, ...summary };
  } catch (e) {
    log(`sync FAILED: ${e.message}; ${rel(projectRoot, vendorDir)}/ keeps its current copy`);
    return { code: 1, status: 'failed', reason: e.message, ...summary };
  } finally {
    if (next) {
      try { fs.rmSync(guard(next, 'remove'), { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* best effort */ }
    }
    if (stage) {
      try { fs.rmSync(guard(stage, 'remove'), { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* best effort */ }
    }
  }
}

export function parseArgs(argv) {
  const res = { source: null, check: false, help: false, errors: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--check') res.check = true;
    else if (a === '--source') {
      if (!argv[i + 1]) res.errors.push('--source needs a folder');
      else res.source = argv[++i];
    } else if (a === '-h' || a === '--help') res.help = true;
    else res.errors.push(`unknown argument ${a}`);
  }
  return res;
}

export function main(argv = process.argv.slice(2), { log = console.log, logError = console.error } = {}) {
  const args = parseArgs(argv);
  const usage = `usage: node tools/sync.mjs [--source <clock repo>] [--check]\n  source: --source, else ${SOURCE_ENV}, else ../PixelClock`;
  if (args.help) { log(usage); return 0; }
  if (args.errors.length) { logError(`${args.errors.join('; ')}\n${usage}`); return 1; }
  const r = runSync({ source: args.source ? path.resolve(args.source) : defaultSource(), check: args.check, log });
  return r.code;
}

function isMainModule() {
  if (typeof import.meta.main === 'boolean') return import.meta.main;
  if (!process.argv[1]) return false;
  try {
    return path.relative(fs.realpathSync(process.argv[1]), fileURLToPath(import.meta.url)) === '';
  } catch {
    return false;
  }
}

if (isMainModule()) process.exitCode = main();
