#!/usr/bin/env node
// PixelClock Desktop installer. Node built-ins only. INSTALL.md (section 1) tells you when to run it.
//
//   node tools/install.mjs [--dry-run] [--target <dir>] [--dist <dir>] [--conhost | --no-conhost]
//
// Run it after node tools/build.mjs. The tests never install for real: they pass a --target inside a temp folder.
// Copies the built pieces from dist\ to their installed homes and prints every file it writes or deletes:
//   dist\newtab\  -> <target>\chrome-newtab\   Chrome: Load unpacked from here
//   dist\still\   -> <target>\still\           plus, made here with absolute install paths:
//                    run-hidden.js  the wscript launcher (node = the node.exe running this installer), always
//                                   regenerated from dist\still\run-hidden.js (the template)
//                    task.xml       the Task Scheduler definition (UTF-16LE with BOM, the current user's SID
//                                   from `whoami /user`), regenerated; never registered here
//                    still.json     the still's settings from config\user.json, on the first install only
//                    out\           created once; pictures, state, cache and log live there
// Default <target>: %LOCALAPPDATA%\PixelClockDesktop. The Lively zip is imported straight from dist\ (not copied).
//
// Safety rules:
// - Refuses when dist\ is missing a piece (and lists them), when the new tab manifest is not strict JSON, or when
//   dist\still holds a name the install owns (still.json, task.xml, out). Nothing is written then.
// - Writes and deletes only inside <target>\chrome-newtab and <target>\still. Inside them it removes files that are
//   no longer in dist, except your still.json and everything under still\out\, which it never writes, moves or
//   deletes once they exist. Links and junctions are never followed or deleted; one in the way of a write refuses
//   the run before anything changes.
// - Refuses destinations inside OneDrive, Desktop, Documents, Downloads, %TEMP%, the Windows folder, this repo or
//   the PixelClock repo (also when reached through a junction), and destinations that are links, not named
//   "PixelClockDesktop", relative or not on a local drive. The one exception: an explicit --target inside
//   os.tmpdir() (the tests).
// - Starts exactly one process, the read-only `whoami /user`, and only once the destination and dist checks
//   passed (known folders come from the environment and folder names, never from a PowerShell lookup). It
//   never registers the scheduled task, never sets the wallpaper and never runs the still: it prints the
//   schtasks commands for you to run instead.
// - --dry-run reads (and asks whoami) but writes nothing; no folder is created.
// - The next steps it prints follow INSTALL.md (sections 2, 3 and 4); tests/docs.test.mjs keeps the two in step.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, validateConfig } from './lib/config.mjs';
import { isInside, readJsonStrict } from './lib/fsx.mjs';
import { normalizeStill, OUT_DIR, readStill, STILL_DEFAULTS, STILL_JSON } from '../src/still/lib/env.mjs';
import {
  checkSid, LAUNCHER_FILE, runHiddenJs, schtasksCommands, stillFiles, TASK_FILE, taskXml, taskXmlBytes,
} from '../src/still/lib/task.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, '..');
export const FOLDER_NAME = 'PixelClockDesktop';
/** Installed group folders under <target> and the dist folders they come from. */
export const NEWTAB_DIR = 'chrome-newtab';
export const STILL_DIR = 'still';
export const GROUPS = Object.freeze([{ name: NEWTAB_DIR, from: 'newtab' }, { name: STILL_DIR, from: 'still' }]);
export const ZIP_NAME = 'PixelClockDesktop-wallpaper.zip';
/** Files dist\ must hold (posix, relative to dist). */
export const REQUIRED = Object.freeze([
  'newtab/manifest.json', 'newtab/newtab.html',
  'still/pcd-still.mjs', `still/${LAUNCHER_FILE}`,
  'still/shared/pcd-hook.js', 'still/shared/pcd-engine.js',
  'still/pixelclock/simulator/engine.js', 'still/pixelclock/tools/render.js',
]);
/** Names in still\ the install owns: dist\still must not hold them. */
export const OWNED_NAMES = Object.freeze([STILL_JSON, TASK_FILE, OUT_DIR]);
/** Folder names that mark a user's known folders wherever they live (a redirected Desktop keeps its name). */
export const KNOWN_FOLDER_NAMES = Object.freeze(['Desktop', 'Documents', 'Downloads', 'My Documents']);
/** The one process this installer starts (read-only): %SystemRoot%\System32\whoami.exe /user /fo csv /nh. */
export const WHOAMI_ARGS = Object.freeze(['/user', '/fo', 'csv', '/nh']);
const IS_WIN = process.platform === 'win32';

export const USAGE = `usage: node tools/install.mjs [--dry-run] [--target <dir>] [--dist <dir>] [--conhost | --no-conhost]
  --dry-run       show what would be written and deleted; change nothing
  --target <dir>  install folder (default %LOCALAPPDATA%\\${FOLDER_NAME}); an absolute path on a local
                  drive, to a folder named "${FOLDER_NAME}"
  --dist <dir>    build output to install from (default <repo>\\dist)
  --conhost       the still's launcher starts node through conhost.exe --headless (use it if a console
                  window flashes every 15 minutes)
  --no-conhost    the launcher starts node directly (the default); without either flag a reinstall keeps
                  the installed choice
Copies dist\\newtab to <target>\\${NEWTAB_DIR} and dist\\still to <target>\\${STILL_DIR}, writes run-hidden.js and
task.xml there (and still.json on the first install) and prints the schtasks commands. It never registers
the scheduled task and never sets the wallpaper.`;

// --- arguments and paths ------------------------------------------------------------------------

/** { target, dist, dryRun, conhost (true|false|null), help, errors } from command-line arguments. */
export function parseArgs(argv) {
  const res = { target: null, dist: null, dryRun: false, conhost: null, help: false, errors: [] };
  const valued = { '--target': 'target', '--dist': 'dist' };
  for (let i = 0; i < argv.length; i++) {
    const a = String(argv[i]);
    const eq = a.indexOf('=');
    const flag = a.startsWith('--') && eq > 0 ? a.slice(0, eq) : a;
    if (flag === '--dry-run' && eq < 0) res.dryRun = true;
    else if ((flag === '--conhost' || flag === '--no-conhost') && eq < 0) {
      const v = flag === '--conhost';
      if (res.conhost !== null && res.conhost !== v) res.errors.push('use either --conhost or --no-conhost');
      res.conhost = v;
    } else if ((flag === '-h' || flag === '--help') && eq < 0) res.help = true;
    else if (valued[flag]) {
      const value = eq > 0 ? a.slice(eq + 1) : argv[++i];
      if (value === undefined || value === '' || (eq < 0 && String(value).startsWith('--'))) res.errors.push(`${flag} needs a folder`);
      else if (res[valued[flag]] !== null) res.errors.push(`${flag} given twice`);
      else res[valued[flag]] = String(value);
    } else res.errors.push(`unknown argument ${JSON.stringify(a)}`);
  }
  return res;
}

/**
 * An environment variable by name, case-insensitively: Windows names are, but a copied env object is not
 * (Git Bash, for one, passes SYSTEMROOT and WINDIR). An exact match wins.
 */
export function envVar(env, name) {
  if (!env) return undefined;
  if (env[name] !== undefined) return env[name];
  const key = Object.keys(env).find((k) => k.toLowerCase() === name.toLowerCase());
  return key === undefined ? undefined : env[key];
}

/** The default install folder %LOCALAPPDATA%\PixelClockDesktop (null when %LOCALAPPDATA% is not set). */
export function defaultTarget(env = process.env) {
  const lad = envVar(env, 'LOCALAPPDATA');
  return typeof lad === 'string' && lad.trim() ? path.join(lad, FOLDER_NAME) : null;
}

/** Real path of `p`, or of its nearest existing ancestor joined with the missing rest. */
export function realish(p) {
  let cur = path.resolve(p);
  const rest = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync.native(cur), ...rest);
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return path.resolve(p);
      rest.unshift(path.basename(cur));
      cur = parent;
    }
  }
}

function realOrSelf(p) {
  try { return fs.realpathSync.native(p); } catch { return path.resolve(p); }
}

/** 'missing' | 'dir' | 'file' | 'link' (links and junctions are never followed). */
export function kindOf(p) {
  let st;
  try { st = fs.lstatSync(p); } catch { return 'missing'; }
  if (st.isSymbolicLink()) return 'link';
  if (st.isDirectory()) return 'dir';
  return st.isFile() ? 'file' : 'link';
}

/**
 * Folders no destination may be inside: [{ label, path, kind }] (kind 'temp' for temp folders). Known folders
 * come from the environment only (plus `known`, e.g. from a test); redirected ones are caught by their names.
 */
export function forbiddenRoots({ env = process.env, root = ROOT, tmpdir = os.tmpdir(), known = [] } = {}) {
  const list = [];
  const add = (label, p, kind = 'user') => {
    if (typeof p === 'string' && p.trim() && path.isAbsolute(p)) list.push({ label, path: path.resolve(p), kind });
  };
  const v = (name) => envVar(env, name);
  const home = v('USERPROFILE') || os.homedir();
  for (const n of ['Desktop', 'Documents', 'Downloads', 'OneDrive']) add(`${n} (profile)`, path.join(home, n));
  if (v('PUBLIC')) for (const n of ['Desktop', 'Documents', 'Downloads']) add(`Public ${n}`, path.join(v('PUBLIC'), n));
  for (const k of ['OneDrive', 'OneDriveConsumer', 'OneDriveCommercial']) add(`%${k}%`, v(k));
  for (const k of known) add(k.label, k.path);
  add('the repo', root);
  const siblings = path.dirname(path.resolve(root));
  add('the PixelClock repo', v('PCD_PIXELCLOCK') || path.join(siblings, 'PixelClock'));
  const sysRoot = v('SystemRoot') || v('windir');
  if (sysRoot) add('the Windows folder', sysRoot);
  for (const k of ['TEMP', 'TMP']) add(`%${k}%`, v(k), 'temp');
  add('os.tmpdir()', tmpdir, 'temp');
  if (sysRoot) add('%SystemRoot%\\Temp', path.join(sysRoot, 'Temp'), 'temp');
  return list;
}

/**
 * Problems with the install folder (empty = allowed). opts: { label, explicit, forbidden, tmpdir, win }.
 * Checked on the path as given and on its real path (junctions resolved).
 */
export function checkDestination(dir, { label = 'target', explicit = false, forbidden = [], tmpdir = os.tmpdir(), win = IS_WIN } = {}) {
  if (typeof dir !== 'string' || !dir.trim()) return [`${label}: no folder given`];
  if (/^[\\/]{2}/.test(dir)) return [`${label} ${dir}: not on a local drive (network and device paths are not allowed)`];
  if (!path.isAbsolute(dir) || (win && !/^[A-Za-z]:[\\/]/.test(dir))) return [`${label} ${JSON.stringify(dir)}: use an absolute path on a local drive, like C:\\...\\${FOLDER_NAME}`];
  const abs = path.resolve(dir);
  const problems = [];
  if (path.basename(abs).toLowerCase() !== FOLDER_NAME.toLowerCase()) problems.push(`${label} ${abs}: the folder must be named "${FOLDER_NAME}"`);
  if (path.dirname(abs) === abs) problems.push(`${label} ${abs}: a drive root is not allowed`);
  const real = realish(abs);
  const candidates = real.toLowerCase() === abs.toLowerCase() ? [abs] : [abs, real];
  const tmpReal = realOrSelf(tmpdir);
  const inTmp = candidates.every((c) => isInside(tmpdir, c) || isInside(tmpReal, c));
  for (const c of candidates) {
    const segs = c.split(/[\\/]+/).filter(Boolean);
    const od = segs.find((s) => /^OneDrive( - .*)?$/i.test(s));
    if (od) problems.push(`${label} ${c}: inside a OneDrive folder ("${od}")`);
    const kf = segs.slice(0, -1).find((s) => KNOWN_FOLDER_NAMES.some((n) => n.toLowerCase() === s.toLowerCase()));
    if (kf) problems.push(`${label} ${c}: inside a folder named "${kf}" (a Desktop, Documents or Downloads folder)`);
    for (const f of forbidden) {
      const fReal = realOrSelf(f.path);
      if (!isInside(f.path, c) && !isInside(fReal, c)) continue;
      if (f.kind === 'temp' && explicit && inTmp) continue; // the tests: an explicit folder inside os.tmpdir()
      problems.push(`${label} ${c}: inside ${f.label} (${f.path})`);
    }
  }
  const k = kindOf(abs);
  if (k === 'link') problems.push(`${label} ${abs}: is a link/junction`);
  else if (k === 'file') problems.push(`${label} ${abs}: exists and is not a folder`);
  return [...new Set(problems)];
}

// --- reading dist and the destination (never follows links) ------------------------------------

/**
 * Files, folders and links under `dir` (posix paths relative to it); empty lists when it does not exist.
 * prune(rel) = true lists a folder but does not look inside it.
 */
export function walk(dir, { prune = () => false } = {}) {
  const res = { files: [], dirs: [], links: [] };
  if (kindOf(dir) !== 'dir') return res;
  const rec = (abs, rel) => {
    for (const ent of fs.readdirSync(abs, { withFileTypes: true })) {
      const r = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.isSymbolicLink()) res.links.push(r);
      else if (ent.isDirectory()) {
        res.dirs.push(r);
        if (!prune(r)) rec(path.join(abs, ent.name), r);
      } else if (ent.isFile()) res.files.push(r);
      else res.links.push(r); // sockets, devices, other reparse points: never touched
    }
  };
  rec(dir, '');
  const sort = (a) => a.sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
  sort(res.files); sort(res.dirs); sort(res.links);
  return res;
}

function sameBytes(a, b) {
  try {
    const sa = fs.statSync(a);
    const sb = fs.statSync(b);
    if (!sa.isFile() || !sb.isFile() || sa.size !== sb.size) return false;
    return fs.readFileSync(a).equals(fs.readFileSync(b));
  } catch {
    return false;
  }
}

function sameAs(buf, file) {
  try {
    if (kindOf(file) !== 'file' || fs.statSync(file).size !== buf.length) return false;
    return fs.readFileSync(file).equals(buf);
  } catch {
    return false;
  }
}

const lc = (rel) => rel.toLowerCase();

/** { missing: [rel], broken: [message] } for dist\ (reads only). */
export function checkDist(dist) {
  const missing = REQUIRED.filter((rel) => kindOf(path.join(dist, ...rel.split('/'))) !== 'file');
  const broken = [];
  for (const g of GROUPS) {
    // a linked piece folder would look empty to the mirror, and everything installed would then be "stale"
    if (kindOf(path.join(dist, g.from)) === 'link') broken.push(`${g.from}: must be a real folder, not a link/junction`);
  }
  const manifest = path.join(dist, 'newtab', 'manifest.json');
  if (kindOf(manifest) === 'file') {
    try {
      const m = readJsonStrict(manifest, 'newtab/manifest.json');
      if (!m || m.manifest_version !== 3) broken.push('newtab/manifest.json: manifest_version is not 3');
    } catch (e) {
      broken.push(e.message);
    }
  }
  const stillDist = path.join(dist, 'still');
  if (kindOf(stillDist) === 'dir') {
    const owned = new Set(OWNED_NAMES.map(lc));
    for (const name of fs.readdirSync(stillDist)) {
      if (owned.has(lc(name))) broken.push(`still/${name}: dist must not hold it (the install makes it in the installed folder)`);
    }
  }
  for (const g of GROUPS) {
    for (const l of walk(path.join(dist, g.from)).links) broken.push(`${g.from}/${l}: links are not allowed in dist`);
  }
  return { missing, broken };
}

// --- the still's settings, the SID and the installed launcher ---------------------------------

/** still.json settings from config/user.json: the screen size is detected later (0 x 0). */
export function stillSettings(config) {
  const problems = validateConfig(config);
  if (problems.length) throw new Error(problems.join('; '));
  const { config: out, problems: p2 } = normalizeStill({
    ...STILL_DEFAULTS,
    clock24: config.clock === '24h',
    units: config.units,
    city: config.city,
    sunTimes: config.sunTimes,
    weather: config.weather,
    taskbar: config.taskbarPx,
  });
  if (p2.length) throw new Error(`config/user.json does not fit still.json: ${p2.join('; ')}`);
  return out;
}

/** still.json text: UTF-8 without BOM, LF, 2-space indent (as the still itself writes it). */
export function stillJsonText(config) {
  return JSON.stringify(stillSettings(config), null, 2) + '\n';
}

/** %SystemRoot%\System32\whoami.exe. */
export function whoamiPath(env = process.env) {
  return path.join(envVar(env, 'SystemRoot') || envVar(env, 'windir') || 'C:\\Windows', 'System32', 'whoami.exe');
}

/** The SID in `whoami /user /fo csv /nh` output ("DOMAIN\user","S-1-5-21-..."). */
export function parseWhoami(text) {
  const s = String(text ?? '');
  const m = /"(S-1-\d+(?:-\d+)+)"/.exec(s) || /\b(S-1-\d+(?:-\d+)+)\b/.exec(s);
  if (!m) throw new Error('whoami /user printed no SID');
  return checkSid(m[1]);
}

/** The current user's SID from the read-only `whoami /user` (hidden, no shell). Throws on failure. */
export function whoamiSid({ env = process.env, spawn = spawnSync } = {}) {
  if (!IS_WIN) throw new Error('whoami /user is only available on Windows');
  const r = spawn(whoamiPath(env), [...WHOAMI_ARGS], {
    encoding: 'utf8', windowsHide: true, timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (!r || r.status !== 0) throw new Error(`whoami /user failed (exit ${r && r.status}${r && r.error ? ', ' + r.error.message : ''})`);
  return parseWhoami(r.stdout);
}

/** true/false when the installed run-hidden.js was made with/without conhost --headless; null when unknown. */
export function installedHeadless(file) {
  try {
    if (kindOf(file) !== 'file') return null;
    const m = /^var HEADLESS = "(yes|no)";$/m.exec(fs.readFileSync(file, 'utf8'));
    return m ? m[1] === 'yes' : null;
  } catch {
    return null;
  }
}

/** The registration date of an installed task.xml (local time), or null. */
export function installedTaskDate(file) {
  try {
    if (kindOf(file) !== 'file') return null;
    const buf = fs.readFileSync(file);
    if (buf.length < 2 || buf[0] !== 0xff || buf[1] !== 0xfe) return null;
    const m = /<Date>(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})<\/Date>/.exec(buf.subarray(2).toString('utf16le'));
    if (!m) return null;
    const d = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
    return Number.isNaN(d.getTime()) ? null : d;
  } catch {
    return null;
  }
}

// --- the plan -----------------------------------------------------------------------------------

function finishGroup(g, protect = () => false) {
  const wanted = new Set(g.entries.map((e) => lc(e.rel)));
  g.links = g.tree.links.filter((r) => !protect(r));
  g.stale = g.tree.files.filter((rel) => !wanted.has(lc(rel)) && !protect(rel));
  const wantedDirs = new Set();
  for (const e of g.entries) {
    const parts = lc(e.rel).split('/');
    for (let i = 1; i < parts.length; i++) wantedDirs.add(parts.slice(0, i).join('/'));
  }
  const remaining = [...g.tree.files.filter((rel) => wanted.has(lc(rel)) || protect(rel)), ...g.entries.map((e) => e.rel), ...g.tree.links].map(lc);
  // folders left empty once the stale files are gone (deepest first)
  g.staleDirs = g.tree.dirs.filter((d) => !protect(d) && !wantedDirs.has(lc(d)) && !remaining.some((f) => f.startsWith(lc(d) + '/')))
    .sort((a, b) => b.split('/').length - a.split('/').length);
  delete g.tree;
  return g;
}

/**
 * Why a file cannot be written at `dst` without following a link (null when it can): the file itself or a
 * folder between the group root and it is a link/junction, or something of the wrong kind is in the way.
 */
export function blockedBy(dst, groupRoot) {
  const k = kindOf(dst);
  if (k === 'link') return `${dst} is a link/junction`;
  if (k === 'dir') return `${dst} is a folder where a file is needed`;
  for (let cur = path.dirname(dst); isInside(groupRoot, cur) && path.resolve(cur) !== path.resolve(groupRoot); cur = path.dirname(cur)) {
    const kk = kindOf(cur);
    if (kk === 'link') return `${cur} is a link/junction`;
    if (kk === 'file') return `${cur} is a file where a folder is needed`;
  }
  return null;
}

function mirrorEntries(srcDir, dstDir, exclude = []) {
  const skip = new Set(exclude.map(lc));
  return walk(srcDir).files.filter((rel) => !skip.has(lc(rel))).map((rel) => {
    const src = path.join(srcDir, ...rel.split('/'));
    const dst = path.join(dstDir, ...rel.split('/'));
    return { rel, src, dst, bytes: fs.statSync(src).size, same: sameBytes(src, dst) };
  });
}

/**
 * The install plan (reads only; starts no process). opts: { dist, target, sid, node, now (Date),
 * conhost (true|false|null), getConfig () -> config/user.json object (called only for a first install) }.
 * Returns { target, dist, node, files (the still's absolute files), headless, headlessFrom, stillJsonWritten,
 * groups } where each group is { name, src, dst, existed, entries: [{ rel, dst, bytes, same, src | data,
 * note }], create: [{ path, note }], keep: [{ path, note }], notes: [msg], stale: [rel], staleDirs: [rel],
 * links: [rel] }. Throws (nothing written) when the launcher, task.xml or still.json cannot be made.
 */
export function buildPlan({ dist, target, sid, node, now = new Date(), conhost = null, getConfig }) {
  const plan = { target, dist, node, groups: [] };

  // chrome-newtab: a mirror of dist\newtab.
  const nt = { name: NEWTAB_DIR, src: path.join(dist, 'newtab'), dst: path.join(target, NEWTAB_DIR) };
  nt.existed = kindOf(nt.dst) === 'dir';
  nt.tree = walk(nt.dst);
  nt.entries = mirrorEntries(nt.src, nt.dst);
  nt.create = [];
  nt.keep = [];
  nt.notes = [];
  plan.groups.push(finishGroup(nt));

  // still: a mirror of dist\still without the launcher template, plus the generated files.
  const st = { name: STILL_DIR, src: path.join(dist, 'still'), dst: path.join(target, STILL_DIR) };
  st.existed = kindOf(st.dst) === 'dir';
  const isOut = (rel) => lc(rel) === lc(OUT_DIR) || lc(rel).startsWith(lc(OUT_DIR) + '/');
  const protect = (rel) => lc(rel) === lc(STILL_JSON) || isOut(rel);
  st.tree = walk(st.dst, { prune: isOut });
  st.entries = mirrorEntries(st.src, st.dst, [LAUNCHER_FILE]);
  st.create = [];
  st.keep = [];
  st.notes = [];
  const files = stillFiles(st.dst); // throws unless the folder can be written into the launcher and task.xml
  plan.files = files;

  const launcher = path.join(st.dst, LAUNCHER_FILE);
  const was = installedHeadless(launcher);
  plan.headless = conhost !== null ? conhost : was === true;
  plan.headlessFrom = conhost !== null ? 'flag' : was === null ? 'default' : 'installed';
  const template = fs.readFileSync(path.join(st.src, LAUNCHER_FILE), 'utf8');
  const js = runHiddenJs({ node, stillDir: files.dir, headless: plan.headless, template });
  if (/[^\x20-\x7e\r\n\t]/.test(js)) {
    throw new Error(`run-hidden.js would hold non-ASCII characters (node ${node}, folder ${files.dir}): wscript.exe reads it in the ANSI code page, so the paths would break; install into an ASCII-only folder with --target`);
  }
  const jsBuf = Buffer.from(js, 'utf8');
  st.entries.push({
    rel: LAUNCHER_FILE, dst: launcher, data: jsBuf, bytes: jsBuf.length, same: sameAs(jsBuf, launcher),
    note: `launcher with absolute paths: starts node ${plan.headless ? 'through conhost.exe --headless' : 'with a hidden window'}`,
  });

  const taskFile = path.join(st.dst, TASK_FILE);
  const prev = installedTaskDate(taskFile);
  let xml = prev ? taskXmlBytes(taskXml({ stillDir: files.dir, userSid: sid, date: prev })) : null;
  if (!xml || !sameAs(xml, taskFile)) xml = taskXmlBytes(taskXml({ stillDir: files.dir, userSid: sid, date: now }));
  st.entries.push({
    rel: TASK_FILE, dst: taskFile, data: xml, bytes: xml.length, same: sameAs(xml, taskFile),
    note: 'task definition, UTF-16LE; never registered by this installer',
  });

  const sj = path.join(st.dst, STILL_JSON);
  const sjKind = kindOf(sj);
  plan.stillJsonWritten = false;
  if (sjKind === 'missing') {
    if (typeof getConfig !== 'function') throw new Error('still.json is missing and no config/user.json was given');
    let text;
    try {
      text = stillJsonText(getConfig());
    } catch (e) {
      throw new Error(`cannot make still.json from config/user.json: ${e.message}`);
    }
    const buf = Buffer.from(text, 'utf8');
    st.entries.push({ rel: STILL_JSON, dst: sj, data: buf, bytes: buf.length, same: false, once: true, note: 'first install: the still\'s settings from config/user.json; kept on every reinstall' });
    plan.stillJsonWritten = true;
  } else {
    st.keep.push({ path: sj, note: sjKind === 'file' ? 'your settings; never overwritten' : 'not a plain file; left as it is' });
    if (sjKind === 'file') {
      try {
        for (const p of readStill(sj).problems) st.notes.push(`${sj}: ${p}`);
      } catch (e) {
        st.notes.push(`${sj}: cannot be read (${e.code || e.message})`);
      }
    }
  }

  const outDir = path.join(st.dst, OUT_DIR);
  const outKind = kindOf(outDir);
  if (outKind === 'missing') st.create.push({ path: outDir, note: 'pictures, state, cache and log; kept across installs' });
  else if (outKind === 'dir') st.keep.push({ path: outDir + path.sep, note: 'pictures, state, cache and log; never touched' });
  else if (outKind === 'link') st.keep.push({ path: outDir + path.sep, note: 'a link/junction: not followed, left as it is' });
  else st.notes.push(`${outDir} exists and is not a folder: the still cannot write its pictures until it is removed`);
  plan.groups.push(finishGroup(st, protect));

  // Nothing is ever written through a link: a link (or a file or folder of the wrong kind) in the way of a
  // write refuses the whole run before anything changes.
  plan.problems = [];
  for (const g of plan.groups) {
    for (const e of g.entries) {
      const why = e.same ? null : blockedBy(e.dst, g.dst);
      if (why) plan.problems.push(`${why}: not followed or replaced; remove it, then run the installer again`);
    }
    for (const c of g.create) {
      const why = blockedBy(c.path, g.dst); // c.path is missing: only the folders above it are checked
      if (why) plan.problems.push(`${why}: not followed or replaced; remove it, then run the installer again`);
    }
  }
  plan.problems = [...new Set(plan.problems)];
  return plan;
}

// --- executing the plan -------------------------------------------------------------------------

/** A path is deletable only when it is a plain file/folder (no link) whose real parent is inside the group root. */
function safeToDelete(p, groupRoot, wantDir) {
  const k = kindOf(p);
  if (k !== (wantDir ? 'dir' : 'file')) return false;
  const realRoot = realOrSelf(groupRoot);
  const realParent = realOrSelf(path.dirname(p));
  return isInside(realRoot, realParent) && isInside(realRoot, path.join(realParent, path.basename(p)));
}

/** mkdir -p `dir`, but every existing folder from the group root down must be a real folder (no link). */
function ensureRealDir(dir, groupRoot) {
  if (!isInside(groupRoot, dir)) throw new Error(`${dir} is outside ${groupRoot}`);
  const rel = path.relative(groupRoot, dir);
  const parts = rel ? rel.split(path.sep) : [];
  let cur = groupRoot;
  for (const p of ['', ...parts]) {
    if (p) cur = path.join(cur, p);
    const k = kindOf(cur);
    if (k === 'link') throw new Error(`${cur} is a link/junction; refusing to write through it`);
    if (k === 'file') throw new Error(`${cur} exists and is not a folder`);
  }
  fs.mkdirSync(dir, { recursive: true });
}

/**
 * Apply (or, with dryRun, only print) the plan. Every write and delete is printed.
 * Returns { written, unchanged, deleted, created, failed: [msg], warnings: [msg] }.
 */
export function executePlan(plan, { dryRun = false, log = console.log } = {}) {
  const res = { written: 0, unchanged: 0, deleted: 0, created: 0, failed: [], warnings: [] };
  const tag = (verb) => (dryRun && verb !== 'keep' && verb !== 'skip' ? 'would ' : '') + verb.padEnd(7);
  for (const g of plan.groups) {
    const counts = { written: 0, unchanged: 0, deleted: 0 };
    const inGroup = (p) => {
      if (!isInside(g.dst, p) || path.resolve(p) === path.resolve(g.dst)) throw new Error(`${p} is not inside ${g.dst}`);
    };
    for (const l of g.links) {
      const msg = `${tag('skip')}${path.join(g.dst, ...l.split('/'))} (link/junction: not followed, not deleted)`;
      log(msg);
      res.warnings.push(msg);
    }
    for (const e of g.entries) {
      if (e.same) { counts.unchanged++; continue; }
      log(`${tag('write')}${e.dst} (${e.bytes} bytes${e.note ? `, ${e.note}` : ''})`);
      counts.written++;
      if (dryRun) continue;
      try {
        inGroup(e.dst);
        ensureRealDir(path.dirname(e.dst), g.dst);
        if (kindOf(e.dst) === 'link') throw new Error('a link/junction is in the way; not followed');
        if (e.data) fs.writeFileSync(e.dst, e.data, e.once ? { flag: 'wx' } : undefined); // still.json: never over a file
        else fs.copyFileSync(e.src, e.dst);
      } catch (err) {
        res.failed.push(`write ${e.dst}: ${err.message}`);
        counts.written--;
      }
    }
    for (const c of g.create) {
      log(`${tag('create')}${c.path}${path.sep} (${c.note})`);
      res.created++;
      if (dryRun) continue;
      try {
        inGroup(c.path);
        ensureRealDir(c.path, g.dst);
      } catch (err) {
        res.failed.push(`create ${c.path}: ${err.message}`);
        res.created--;
      }
    }
    for (const k of g.keep) log(`${tag('keep')}${k.path} (${k.note})`);
    for (const rel of g.stale) {
      const p = path.join(g.dst, ...rel.split('/'));
      if (!dryRun && !safeToDelete(p, g.dst, false)) { res.warnings.push(`kept ${p}: not a plain file inside ${g.dst}`); continue; }
      log(`${tag('delete')}${p} (no longer in dist)`);
      counts.deleted++;
      if (dryRun) continue;
      try {
        inGroup(p);
        fs.unlinkSync(p);
      } catch (err) {
        res.failed.push(`delete ${p}: ${err.message}`);
        counts.deleted--;
      }
    }
    for (const rel of g.staleDirs) {
      const p = path.join(g.dst, ...rel.split('/'));
      if (dryRun) { log(`${tag('delete')}${p}${path.sep} (empty folder no longer in dist)`); continue; }
      try {
        inGroup(p);
        if (safeToDelete(p, g.dst, true) && fs.readdirSync(p).length === 0) {
          fs.rmdirSync(p);
          log(`${tag('delete')}${p}${path.sep} (empty folder no longer in dist)`);
        }
      } catch (err) {
        res.warnings.push(`kept folder ${p}: ${err.message}`);
      }
    }
    for (const n of g.notes) res.warnings.push(n);
    log(`  ${g.name}: ${g.entries.length} file(s): ${counts.written} ${dryRun ? 'to write' : 'written'}, ${counts.unchanged} unchanged, ${counts.deleted} ${dryRun ? 'to delete' : 'deleted'}`);
    res.written += counts.written;
    res.unchanged += counts.unchanged;
    res.deleted += counts.deleted;
  }
  return res;
}

/** The INSTALL.md sections the next steps point to (tests/docs.test.mjs checks them against its headings). */
export const INSTALL_SECTIONS = Object.freeze({ newtab: '2. Chrome new tab', live: '3. Live wallpaper (Lively)', still: '4. Still wallpaper' });

/**
 * What you do next, in INSTALL.md's order (printed after a run; nothing here is ever run by the installer). Lines
 * that start with two spaces continue the step above them. The commands hold absolute paths, so they work as they
 * are in Command Prompt and in PowerShell.
 */
export function nextSteps(plan, { dist = plan.dist } = {}) {
  const out = [];
  const nt = plan.groups.find((g) => g.name === NEWTAB_DIR);
  const st = plan.groups.find((g) => g.name === STILL_DIR);
  const changed = (g) => g.entries.some((e) => !e.same) || g.stale.length > 0;
  const see = (key) => `(INSTALL.md, section ${INSTALL_SECTIONS[key].split('.')[0]})`;
  if (!nt.existed) {
    out.push(`New tab ${see('newtab')}: on chrome://extensions turn on Developer mode (leave it on), click Load unpacked and choose`);
    out.push(`  ${nt.dst}`);
    out.push('  Then press Ctrl+T, and click "Keep it" if Chrome asks.');
  } else if (changed(nt)) {
    out.push('New tab changed: on chrome://extensions click Reload on the "PixelClock Desktop" card. Your settings stay.');
  }
  const zip = path.join(dist, ZIP_NAME);
  if (kindOf(zip) === 'file') {
    out.push(`Live wallpaper ${see('live')}: in Lively click Add Wallpaper, then Browse, and pick`);
    out.push(`  ${zip}`);
    out.push('  Then click the new tile once. Lively keeps its own copy, so the zip stays in dist.');
  }
  const c = schtasksCommands(plan.files.dir);
  const task = st.entries.find((e) => e.rel === TASK_FILE);
  const row = (label, cmd) => `  ${(label + ':').padEnd(22)}${cmd}`;
  out.push(`Still wallpaper ${see('still')}, instead of the live one. This installer never registers the task and never sets the wallpaper; run these yourself:`);
  if (plan.stillJsonWritten) out.push(row('save the screen size', `node "${plan.files.script}" --detect`));
  out.push(row('register the task', c.create));
  if (st.existed && task && !task.same) out.push(row('task.xml changed', `if the task is registered already, replace it: ${c.create} /F`));
  out.push(row('see it at once', c.run));
  out.push(row('pause it', c.disable));
  out.push(row('resume it', c.enable));
  out.push(row('remove it', c.remove));
  return out;
}

// --- main ---------------------------------------------------------------------------------------

/**
 * Run the installer. Returns the exit code: 0 ok, 1 refused or failed, 2 bad arguments.
 * Options (for tests): argv, root, env, tmpdir, log, logError, knownFolders ([{ label, path }]), config (an
 * object instead of root/config/user.json), sid (instead of `whoami /user`), execPath (node.exe), now () -> Date.
 */
export async function main({
  argv = process.argv.slice(2), root = ROOT, env = process.env, tmpdir = os.tmpdir(), log = console.log, logError = console.error,
  knownFolders = [], config = null, sid = null, execPath = process.execPath, now = () => new Date(),
} = {}) {
  const args = parseArgs(argv);
  if (args.help) { log(USAGE); return 0; }
  if (args.errors.length) { logError(`install: ${args.errors.join('; ')}\n${USAGE}`); return 2; }
  const refuse = (problems) => {
    logError(`install: refusing to run; nothing was changed:\n  - ${problems.join('\n  - ')}`);
    return 1;
  };

  const target = args.target ?? defaultTarget(env);
  // dist is only read: a linked dist folder is read through (its piece folders must be real, see checkDist)
  const dist = realOrSelf(path.resolve(args.dist ?? path.join(root, 'dist')));
  const problems = [];
  if (!target) problems.push('no target: %LOCALAPPDATA% is not set; pass --target');
  else {
    const forbidden = forbiddenRoots({ env, root, tmpdir, known: knownFolders });
    problems.push(...checkDestination(target, { label: 'target', explicit: args.target !== null, forbidden, tmpdir }));
    if (path.isAbsolute(target)) {
      if (isInside(dist, target) || isInside(target, dist)) problems.push(`target ${path.resolve(target)} and dist ${dist} must not contain each other`);
      if (isInside(target, root)) problems.push(`target ${path.resolve(target)} must not contain the repo ${path.resolve(root)}`);
    }
  }
  if (kindOf(dist) !== 'dir') problems.push(`dist folder ${dist} does not exist: run node tools/build.mjs first`);
  else {
    const d = checkDist(dist);
    if (d.missing.length) problems.push(`dist is missing ${d.missing.length} piece(s): run node tools/build.mjs first\n      ${d.missing.map((m) => `dist/${m}`).join('\n      ')}`);
    if (d.broken.length) problems.push(`dist has broken files:\n      ${d.broken.join('\n      ')}`);
  }
  if (!problems.length) {
    for (const g of GROUPS) {
      const p = path.join(target, g.name);
      const k = kindOf(p);
      if (k === 'link') problems.push(`${p} is a link/junction`);
      else if (k === 'file') problems.push(`${p} exists and is not a folder`);
    }
  }
  if (problems.length) return refuse(problems);

  let userSid;
  try {
    userSid = checkSid(sid ?? whoamiSid({ env }));
  } catch (e) {
    return refuse([`cannot read the current user's SID for task.xml: ${e.message}`]);
  }
  const getConfig = () => {
    if (config) return config;
    const r = loadConfig(root);
    if (r.problems.length) throw new Error(r.problems.join('; '));
    return r.config;
  };
  let plan;
  try {
    plan = buildPlan({ dist, target: path.resolve(target), sid: userSid, node: execPath, now: now(), conhost: args.conhost, getConfig });
  } catch (e) {
    return refuse([e.message]);
  }
  if (plan.problems.length) return refuse(plan.problems);

  log(`PixelClock Desktop install${args.dryRun ? ' (dry run: nothing is written)' : ''}`);
  log(`  from      ${dist}`);
  log(`  target    ${plan.target}`);
  log(`  node      ${plan.node}`);
  log(`  launcher  ${plan.headless ? 'node through conhost.exe --headless' : 'node with a hidden window'} (${plan.headlessFrom === 'flag' ? 'from the command line' : plan.headlessFrom === 'installed' ? 'as installed' : 'default'})`);
  const res = executePlan(plan, { dryRun: args.dryRun, log });
  for (const w of res.warnings) if (!w.startsWith('skip')) log(`note: ${w}`);
  const summary = args.dryRun
    ? `dry run: ${res.written} file(s) would be written, ${res.unchanged} unchanged, ${res.deleted} would be deleted`
    : `install: ${res.written} file(s) written, ${res.unchanged} unchanged, ${res.deleted} deleted`;
  log(summary + (res.failed.length ? `, ${res.failed.length} FAILED` : ''));
  if (res.failed.length) {
    logError(`install: ${res.failed.length} operation(s) failed:\n  - ${res.failed.join('\n  - ')}`);
    return 1;
  }
  const steps = nextSteps(plan);
  if (args.dryRun) log('after a real install:');
  for (const s of steps) log(s.startsWith('  ') ? `      ${s.trimStart()}` : `next: ${s}`);
  return 0;
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

if (isMainModule()) {
  main().then(
    (code) => { process.exitCode = code; },
    (e) => { console.error(e); process.exit(1); },
  );
}
