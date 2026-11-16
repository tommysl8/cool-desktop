// node --test tests/sync.test.mjs
// tools/sync.mjs against a fake clock repo in os.tmpdir() (built from vendor/, never from the real clock repo):
// hashes and SYNC.json, an identical source writes nothing and starts nothing, a broken theme keeps the old vendor
// and exits 1, an fs spy proves no write outside vendor/ and the stage folder, a spawn spy proves the only process
// is one node in the stage. Then the real vendor/: 17 files with hashes matching SYNC.json.
import test from 'node:test';
import assert from 'node:assert/strict';
import cp from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isInside, main as syncMain, readCommit, runSync, writeGuard } from '../tools/sync.mjs';
import { checkVendor } from '../tools/lib/vendor.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VENDOR = path.join(ROOT, 'vendor', 'pixelclock');
const COMMIT = '0123456789abcdef0123456789abcdef01234567';
const temps = [];
test.after(() => { for (const d of temps) fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/** A fake clock repo (vendor's files at the repo's paths, plus files that must never be copied) and a project. */
function makeCase() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'pcd-synctest-'));
  temps.push(base);
  const clock = path.join(base, 'clock');
  const sync = JSON.parse(fs.readFileSync(path.join(VENDOR, 'SYNC.json'), 'utf8'));
  for (const f of sync.files) {
    const dst = path.join(clock, ...f.path.split('/'));
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(path.join(VENDOR, ...f.path.split('/')), dst);
  }
  for (const extra of ['simulator/main.js', 'simulator/sound.js', 'simulator/index.html', 'simulator/style.css', 'tools/pretend.js', 'README.md']) {
    const p = path.join(clock, ...extra.split('/'));
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, `// ${extra}: never copied\n`);
  }
  fs.mkdirSync(path.join(clock, '.git', 'refs', 'heads'), { recursive: true });
  fs.writeFileSync(path.join(clock, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  fs.writeFileSync(path.join(clock, '.git', 'refs', 'heads', 'main'), COMMIT + '\n');
  const project = path.join(base, 'project');
  fs.mkdirSync(project);
  return { base, clock, project, vendorDir: path.join(project, 'vendor', 'pixelclock'), files: sync.files };
}

const WRITE_FNS = ['writeFileSync', 'appendFileSync', 'mkdirSync', 'mkdtempSync', 'renameSync', 'rmSync', 'rmdirSync', 'unlinkSync', 'copyFileSync', 'cpSync', 'symlinkSync', 'linkSync', 'truncateSync', 'utimesSync', 'chmodSync',
  'writeFile', 'appendFile', 'mkdir', 'mkdtemp', 'rename', 'rm', 'rmdir', 'unlink', 'copyFile', 'cp', 'symlink', 'link', 'truncate', 'utimes', 'chmod', 'createWriteStream'];
const PROMISE_FNS = ['writeFile', 'appendFile', 'mkdir', 'mkdtemp', 'rename', 'rm', 'rmdir', 'unlink', 'copyFile', 'cp', 'symlink', 'link', 'truncate', 'utimes', 'chmod'];
const SPAWN_FNS = ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'];

/** Record every fs write-type call (with its path arguments) and every process start, passing them through. */
function spy() {
  const writes = [];
  const spawns = [];
  const restore = [];
  const wrap = (obj, name, record) => {
    const orig = obj[name];
    if (typeof orig !== 'function') return;
    obj[name] = function (...args) {
      const result = orig.apply(this, args);
      record(name, args, result);
      return result;
    };
    restore.push(() => { obj[name] = orig; });
  };
  // The path arguments of a call (two for rename/copy/link), plus the folder mkdtemp created.
  const paths = (name, args, result) => {
    const n = /^(rename|copyFile|cp|symlink|link)/.test(name) ? 2 : 1;
    const ps = args.slice(0, n).filter((a) => typeof a === 'string' || a instanceof URL).map(String);
    if (/^mkdtemp/.test(name) && typeof result === 'string') ps.push(result);
    return ps;
  };
  for (const n of WRITE_FNS) wrap(fs, n, (name, args, result) => writes.push({ fn: name, paths: paths(name, args, result) }));
  wrap(fs, 'openSync', (name, args) => { if (/[wa+]/.test(String(args[1] || 'r'))) writes.push({ fn: name, paths: [String(args[0])] }); });
  for (const n of PROMISE_FNS) wrap(fs.promises, n, (name, args, result) => writes.push({ fn: `promises.${name}`, paths: paths(name, args, result) }));
  for (const n of SPAWN_FNS) wrap(cp, n, (name, args) => spawns.push({ fn: name, cmd: String(args[0]), args: Array.isArray(args[1]) ? args[1].map(String) : [], cwd: (Array.isArray(args[1]) ? args[2] : args[1])?.cwd }));
  return { writes, spawns, restore: () => { for (const r of restore.reverse()) r(); } };
}

const quiet = () => {
  const lines = [];
  return { lines, log: (m) => lines.push(String(m)) };
};

test('first sync: 17 files byte for byte plus SYNC.json (source, commit, files, syncedAt); nothing else copied', () => {
  const c = makeCase();
  const q = quiet();
  const r = runSync({ source: c.clock, vendorDir: c.vendorDir, log: q.log, now: () => new Date('2026-11-15T22:00:00Z') });
  assert.equal(r.code, 0, q.lines.join('\n'));
  assert.equal(r.status, 'synced');
  const v = checkVendor(c.vendorDir);
  assert.equal(v.ok, true, v.problems.join('\n'));
  assert.equal(v.files.length, 17);
  for (const f of v.files) {
    const src = fs.readFileSync(path.join(c.clock, ...f.path.split('/')));
    assert.equal(f.sha256, sha(src), f.path);
    assert.equal(f.bytes, src.length, f.path);
    assert.ok(fs.readFileSync(path.join(c.vendorDir, ...f.path.split('/'))).equals(src), `${f.path} byte identical`);
  }
  const record = JSON.parse(fs.readFileSync(path.join(c.vendorDir, 'SYNC.json'), 'utf8'));
  assert.deepEqual(Object.keys(record), ['source', 'commit', 'files', 'syncedAt']);
  assert.equal(record.source, '../clock');
  assert.equal(record.commit, COMMIT);
  assert.equal(record.syncedAt, '2026-11-15T22:00:00.000Z');
  for (const never of ['main.js', 'sound.js', 'index.html', 'style.css']) assert.equal(fs.existsSync(path.join(c.vendorDir, 'simulator', never)), false, never);
  assert.equal(fs.existsSync(path.join(c.vendorDir, 'tools', 'pretend.js')), false);
  assert.deepEqual(fs.readdirSync(path.dirname(c.vendorDir)), ['pixelclock'], 'no .next/.old folders left in vendor/');
  assert.match(q.lines.join('\n'), /smoke test PASS: 13 themes, 104 draws at 3, 7, 12, 19 h/);
});

test('an identical source writes nothing and starts no process', () => {
  const c = makeCase();
  assert.equal(runSync({ source: c.clock, vendorDir: c.vendorDir, log: () => {} }).code, 0);
  const before = fs.readFileSync(path.join(c.vendorDir, 'SYNC.json'));
  const s = spy();
  let r;
  const q = quiet();
  try {
    r = runSync({ source: c.clock, vendorDir: c.vendorDir, log: q.log });
  } finally {
    s.restore();
  }
  assert.equal(r.status, 'unchanged');
  assert.equal(r.code, 0);
  assert.deepEqual(s.writes, [], 'no fs write of any kind');
  assert.deepEqual(s.spawns, [], 'no process');
  assert.ok(fs.readFileSync(path.join(c.vendorDir, 'SYNC.json')).equals(before), 'SYNC.json untouched (syncedAt kept)');
  assert.match(q.lines.join('\n'), /up to date \(17 files, clock commit 0123456\); nothing written/);
});

test('a changed theme: writes only inside vendor/ and the pcd-sync-* stage; one node process in the stage; never the clock repo', () => {
  const c = makeCase();
  assert.equal(runSync({ source: c.clock, vendorDir: c.vendorDir, log: () => {} }).code, 0);
  const theme = path.join(c.clock, 'simulator', 'themes', 'winter.js');
  fs.appendFileSync(theme, '// an upstream edit\n');
  const s = spy();
  let r;
  try {
    r = runSync({ source: c.clock, vendorDir: c.vendorDir, log: () => {} });
  } finally {
    s.restore();
  }
  assert.equal(r.status, 'synced');
  assert.deepEqual(r.diff.changed, ['simulator/themes/winter.js']);
  assert.ok(fs.readFileSync(path.join(c.vendorDir, 'simulator', 'themes', 'winter.js')).equals(fs.readFileSync(theme)));
  const stages = new Set(s.writes.filter((w) => w.fn === 'mkdtempSync').map((w) => w.paths[w.paths.length - 1]));
  assert.equal(stages.size, 1, 'one stage folder');
  const stage = [...stages][0];
  assert.equal(path.dirname(stage), path.resolve(os.tmpdir()));
  assert.match(path.basename(stage), /^pcd-sync-/);
  const vendorParent = path.dirname(c.vendorDir);
  const outside = [];
  for (const w of s.writes) {
    for (const p of w.paths) {
      const abs = path.resolve(p);
      // mkdtempSync's own argument is the prefix <tmp>/pcd-sync- (the folder it creates is the stage).
      const ok = isInside(vendorParent, abs) || isInside(stage, abs) || (w.fn === 'mkdtempSync' && path.dirname(abs) === path.resolve(os.tmpdir()));
      if (!ok || isInside(c.clock, abs)) outside.push(`${w.fn} ${abs}`);
    }
  }
  assert.deepEqual(outside, [], 'every write is inside vendor/ or the stage');
  assert.ok(s.writes.some((w) => w.fn === 'renameSync'), 'vendor/pixelclock replaced by rename');
  assert.equal(fs.existsSync(stage), false, 'the stage is removed');
  assert.equal(s.spawns.length, 1, JSON.stringify(s.spawns));
  const [sp] = s.spawns;
  assert.equal(sp.cmd, process.execPath, 'node itself');
  assert.equal(path.resolve(sp.cwd), path.resolve(stage), 'cwd is the stage');
  assert.ok(sp.args.every((a) => !isInside(c.clock, a) || !path.isAbsolute(a)), `no argument points into the clock repo: ${sp.args.join(' ')}`);
  assert.ok(isInside(stage, sp.args[0]) && isInside(stage, sp.args[1]), 'it runs the staged smoke script on the staged files');
});

test('a broken theme (draw throws, or a pixel left unpainted) keeps the old vendor copy and exits 1', () => {
  const breakers = {
    'draw throws': "\n;(function (PC) { const t = PC.themeById('winter'); const create = t.create; t.create = (rng) => { const i = create(rng); return { update: i.update, draw() { throw new Error('broken on purpose'); } }; }; })(globalThis.PixelClock);\n",
    'unpainted pixel': "\n;(function (PC) { const t = PC.themeById('winter'); const create = t.create; t.create = (rng) => { const i = create(rng); return { update: i.update, draw(cv, ctx) { const keep = cv.px[0]; i.draw(cv, ctx); cv.px[0] = keep; } }; }; })(globalThis.PixelClock);\n",
    'syntax error': '\nfunction ( {\n',
  };
  for (const [what, code] of Object.entries(breakers)) {
    const c = makeCase();
    assert.equal(runSync({ source: c.clock, vendorDir: c.vendorDir, log: () => {} }).code, 0);
    const before = fs.readFileSync(path.join(c.vendorDir, 'SYNC.json'), 'utf8');
    const winterBefore = fs.readFileSync(path.join(c.vendorDir, 'simulator', 'themes', 'winter.js'));
    fs.appendFileSync(path.join(c.clock, 'simulator', 'themes', 'winter.js'), code);
    const q = quiet();
    const s = spy();
    let r;
    try {
      r = runSync({ source: c.clock, vendorDir: c.vendorDir, log: q.log });
    } finally {
      s.restore();
    }
    assert.equal(r.code, 1, what);
    assert.equal(r.status, 'failed', what);
    assert.match(q.lines.join('\n'), /sync FAILED: smoke test (failed|printed no result)/, what);
    assert.match(q.lines.join('\n'), /keeps its last good copy/, what);
    if (what === 'draw throws') assert.match(r.reason, /winter @ 3 h: broken on purpose/);
    if (what === 'unpainted pixel') assert.match(r.reason, /winter @ 3 h: 1 pixels unpainted/);
    assert.equal(fs.readFileSync(path.join(c.vendorDir, 'SYNC.json'), 'utf8'), before, `${what}: SYNC.json unchanged`);
    assert.ok(fs.readFileSync(path.join(c.vendorDir, 'simulator', 'themes', 'winter.js')).equals(winterBefore), `${what}: the old theme stays`);
    assert.equal(checkVendor(c.vendorDir).ok, true);
    const vendorParent = path.dirname(c.vendorDir);
    assert.ok(s.writes.every((w) => w.paths.every((p) => !isInside(vendorParent, p))), `${what}: nothing written into vendor/`);
    const stage = s.writes.find((w) => w.fn === 'mkdtempSync');
    assert.equal(fs.existsSync(stage.paths[stage.paths.length - 1]), false, `${what}: stage removed`);
  }
});

test('a missing clock repo fails without writing; --check reports drift and writes nothing', () => {
  const c = makeCase();
  const s = spy();
  let missing;
  let drift;
  let dq;
  try {
    missing = runSync({ source: path.join(c.base, 'nope'), vendorDir: c.vendorDir, log: () => {} });
    dq = quiet();
    drift = runSync({ source: c.clock, vendorDir: c.vendorDir, check: true, log: dq.log });
  } finally {
    s.restore();
  }
  assert.equal(missing.code, 1);
  assert.match(missing.reason, /no PixelClock simulator at .*nope \(set PCD_PIXELCLOCK or pass --source\)/);
  assert.equal(drift.code, 1);
  assert.equal(drift.status, 'drift');
  assert.match(dq.lines.join('\n'), /\+ simulator\/engine\.js/);
  assert.deepEqual(s.writes, []);
  assert.deepEqual(s.spawns, []);
  assert.equal(fs.existsSync(c.vendorDir), false);
});

test('the write guard refuses the clock repo and anything outside vendor/ and the temp folder', () => {
  const c = makeCase();
  const guard = writeGuard({ roots: [path.join(c.project, 'vendor'), os.tmpdir()], forbidden: c.clock });
  assert.equal(guard(path.join(c.project, 'vendor', 'pixelclock', 'x.js'), 'write'), path.join(c.project, 'vendor', 'pixelclock', 'x.js'));
  assert.throws(() => guard(path.join(c.clock, 'simulator', 'engine.js'), 'write'), /refusing to write inside the clock repo/);
  assert.equal(guard(path.join(os.tmpdir(), 'pcd-sync-x', 'a.js'), 'stage'), path.join(os.tmpdir(), 'pcd-sync-x', 'a.js'));
  // The guard only checks paths (nothing is written): a made-up project at the root of the disk, outside the temp
  // folder (this checkout may itself live under the temp folder).
  const probe = path.join(path.parse(os.tmpdir()).root, 'pcd-guard-probe');
  assert.equal(isInside(os.tmpdir(), probe), false);
  const g2 = writeGuard({ roots: [path.join(probe, 'vendor'), os.tmpdir()], forbidden: c.clock });
  assert.equal(g2(path.join(probe, 'vendor', 'pixelclock', 'x.js'), 'write'), path.join(probe, 'vendor', 'pixelclock', 'x.js'));
  assert.throws(() => g2(path.join(probe, 'src', 'x.js'), 'write'), /refusing to write outside vendor\/ and the temp folder/);
  assert.throws(() => g2(path.join(probe, 'vendor-not', 'x.js'), 'write'), /refusing to write outside/);
});

test('readCommit: refs file, packed-refs, a detached HEAD, a worktree .git file, and "unknown"', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'pcd-synctest-git-'));
  temps.push(base);
  const repo = (name) => { const r = path.join(base, name); fs.mkdirSync(path.join(r, '.git'), { recursive: true }); return r; };
  const a = repo('a');
  fs.writeFileSync(path.join(a, '.git', 'HEAD'), 'ref: refs/heads/dev\n');
  fs.mkdirSync(path.join(a, '.git', 'refs', 'heads'), { recursive: true });
  fs.writeFileSync(path.join(a, '.git', 'refs', 'heads', 'dev'), COMMIT + '\n');
  assert.equal(readCommit(a), COMMIT);
  const b = repo('b');
  fs.writeFileSync(path.join(b, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  fs.writeFileSync(path.join(b, '.git', 'packed-refs'), `# pack-refs with: peeled fully-peeled sorted\n${'f'.repeat(40)} refs/heads/main\n`);
  assert.equal(readCommit(b), 'f'.repeat(40));
  const d = repo('d');
  fs.writeFileSync(path.join(d, '.git', 'HEAD'), 'e'.repeat(40) + '\n');
  assert.equal(readCommit(d), 'e'.repeat(40));
  const w = path.join(base, 'w');
  fs.mkdirSync(w);
  fs.writeFileSync(path.join(w, '.git'), `gitdir: ${path.join(a, '.git')}\n`);
  assert.equal(readCommit(w), COMMIT);
  assert.equal(readCommit(path.join(base, 'none')), 'unknown');
});

test('the real vendor/pixelclock: 17 files (engine, schedule, screens, 13 themes, render.js) with hashes matching SYNC.json', () => {
  const v = checkVendor(VENDOR);
  assert.equal(v.ok, true, v.problems.join('\n'));
  const paths = v.files.map((f) => f.path);
  assert.equal(paths.length, 17);
  assert.deepEqual(paths.filter((p) => !p.startsWith('simulator/themes/')), ['simulator/engine.js', 'simulator/schedule.js', 'simulator/screens.js', 'tools/render.js']);
  assert.deepEqual(paths.filter((p) => p.startsWith('simulator/themes/')).map((p) => path.posix.basename(p, '.js')),
    ['autumn', 'christmas', 'easter', 'halloween', 'july4', 'lunarnewyear', 'newyear', 'spring', 'stpatricks', 'summer', 'thanksgiving', 'valentines', 'winter']);
  for (const f of v.files) {
    const buf = fs.readFileSync(path.join(VENDOR, ...f.path.split('/')));
    assert.equal(sha(buf), f.sha256, f.path);
    assert.ok(!buf.includes(13), `${f.path}: LF only (bytes as synced)`);
  }
  assert.match(v.sync.commit, /^([0-9a-f]{40}|unknown)$/);
  assert.equal(v.sync.source, '../PixelClock');
});

test('CLI: --help, unknown arguments, --source without a folder', () => {
  const out = [];
  const err = [];
  assert.equal(syncMain(['--help'], { log: (m) => out.push(m), logError: (m) => err.push(m) }), 0);
  assert.match(out.join('\n'), /usage: node tools\/sync\.mjs \[--source <clock repo>\] \[--check\]/);
  assert.equal(syncMain(['--bogus'], { log: (m) => out.push(m), logError: (m) => err.push(m) }), 1);
  assert.equal(syncMain(['--source'], { log: (m) => out.push(m), logError: (m) => err.push(m) }), 1);
  assert.match(err.join('\n'), /unknown argument --bogus/);
  assert.match(err.join('\n'), /--source needs a folder/);
});
