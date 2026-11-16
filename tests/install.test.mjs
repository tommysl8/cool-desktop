// node --test "tests/install.test.mjs"
// tools/install.mjs. The installer only ever runs here with --target inside os.tmpdir() (removed afterwards) or
// refuses before writing; %LOCALAPPDATA% is pointed into the temp folder as a second safety net, so the real
// %LOCALAPPDATA%\PixelClockDesktop is never written. The config is the Berlin example (config/user.example.json),
// never your own. No test registers a task, runs wscript or sets the wallpaper; the only process any test lets the
// installer start is the read-only `whoami /user`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import cp from 'node:child_process';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import vm from 'node:vm';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** The repo root: the nearest folder above this file that holds tools/install.mjs. */
const ROOT = (() => {
  let dir = HERE;
  for (let i = 0; i < 4; i++) {
    if (fs.existsSync(path.join(dir, 'tools', 'install.mjs'))) return dir;
    dir = path.dirname(dir);
  }
  throw new Error('repo root not found');
})();
const INSTALL = path.join(ROOT, 'tools', 'install.mjs');
const inst = await import(pathToFileURL(INSTALL).href);
const task = await import(pathToFileURL(path.join(ROOT, 'src', 'still', 'lib', 'task.mjs')).href);
const stillEnv = await import(pathToFileURL(path.join(ROOT, 'src', 'still', 'lib', 'env.mjs')).href);

const IS_WIN = process.platform === 'win32';
const SID = 'S-1-5-21-1111111111-2222222222-3333333333-1001';
const NODE_EXE = 'C:\\Program Files\\nodejs\\node.exe';
const NOW = new Date(2026, 10, 15, 16, 30, 5);
const NOW2 = new Date(2026, 10, 16, 9, 0, 0);
/** The sample answers (Berlin): tests never read or send your own city. */
const BERLIN = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'user.example.json'), 'utf8'));
assert.equal(BERLIN.city, 'Berlin', 'the tests use the Berlin sample config');

// --- helpers (temp folders only) -----------------------------------------------------------------

function cleanup(dir) {
  if (!dir || !path.resolve(dir).startsWith(path.resolve(os.tmpdir()) + path.sep)) return;
  // unlink every link/junction first, so nothing below can ever be reached through one
  const unlinkLinks = (d) => {
    let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isSymbolicLink()) { try { fs.unlinkSync(p); } catch { /* reported by rmSync below */ } } else if (e.isDirectory()) unlinkLinks(p);
    }
  };
  unlinkLinks(dir);
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

function writeFile(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data);
}

/** Files under `dir` as sorted posix paths; empty folders end in "/", links in "@" (never followed). */
function tree(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  const rec = (abs, rel) => {
    const ents = fs.readdirSync(abs, { withFileTypes: true });
    if (!ents.length && rel) out.push(rel + '/');
    for (const ent of ents) {
      const r = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.isSymbolicLink()) out.push(r + '@');
      else if (ent.isDirectory()) rec(path.join(abs, ent.name), r);
      else out.push(r);
    }
  };
  rec(dir, '');
  return out.sort();
}

/** A complete fake dist/: small stand-ins plus the real launcher template (src/still/run-hidden.js). */
function makeFakeDist(dir) {
  const dist = path.join(dir, 'dist');
  const files = {
    'newtab/manifest.json': JSON.stringify({ manifest_version: 3, name: 'PixelClock Desktop', version: '1.0.0', chrome_url_overrides: { newtab: 'newtab.html' } }, null, 2) + '\n',
    'newtab/newtab.html': '<!doctype html><meta charset="utf-8"><title>new tab</title>\n',
    'newtab/boot.js': '/* boot */\n',
    'newtab/js/ntp-app.js': '/* app */\n',
    'newtab/icons/icon16.png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]),
    'still/pcd-still.mjs': '// stand-in for the still renderer\n',
    'still/run-hidden.js': fs.readFileSync(path.join(ROOT, 'src', 'still', 'run-hidden.js')),
    'still/lib/env.mjs': '// stand-in\n',
    'still/shared/pcd-hook.js': '/* hook */\n',
    'still/shared/pcd-engine.js': '/* engine adapter */\n',
    'still/pixelclock/simulator/engine.js': '/* engine */\n',
    'still/pixelclock/simulator/themes/autumn.js': '/* theme */\n',
    'still/pixelclock/tools/render.js': '/* render */\n',
    'still/anchors.json': '{}\n',
    // never installed:
    'PixelClockDesktop-wallpaper.zip': Buffer.from('PK fake zip: Lively imports it straight from dist'),
    'wallpaper/index.html': '<!doctype html><title>wallpaper</title>\n',
    'style-tile/index.html': '<!doctype html><title>style tile</title>\n',
  };
  for (const [rel, data] of Object.entries(files)) writeFile(path.join(dist, ...rel.split('/')), data);
  return { dist, files };
}

/** A copy of process.env with `overrides` set; every other spelling of an overridden name is dropped. */
function envWith(base, overrides) {
  const env = { ...base };
  for (const name of Object.keys(overrides)) {
    for (const k of Object.keys(env)) if (k.toLowerCase() === name.toLowerCase()) delete env[k];
    env[name] = overrides[name];
  }
  return env;
}

/** A sandbox: fake dist, a target and a fake %LOCALAPPDATA% (never created), all inside one temp folder. */
function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pcd-install-test-'));
  const { dist, files } = makeFakeDist(dir);
  const lad = path.join(dir, 'LocalAppData');
  const target = path.join(dir, 'Local', 'PixelClockDesktop');
  return { dir, dist, files, lad, target, still: path.join(target, 'still'), newtab: path.join(target, 'chrome-newtab'), env: envWith(process.env, { LOCALAPPDATA: lad }) };
}

async function run(sb, extra = [], opts = {}) {
  const lines = [];
  const argv = opts.argv || ['--dist', sb.dist, '--target', sb.target, ...extra];
  const code = await inst.main({
    argv, env: sb.env, config: BERLIN, sid: SID, execPath: NODE_EXE, now: () => NOW,
    log: (m) => lines.push(String(m)), logError: (m) => lines.push(String(m)), ...opts.main,
  });
  return { code, out: lines.join('\n'), lines };
}

/**
 * Spy on node:child_process (live ESM bindings updated with syncBuiltinESMExports): every start is recorded,
 * and anything but whoami.exe throws instead of starting.
 */
function spyChildProcess() {
  const names = ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'exec', 'execSync', 'fork'];
  const orig = {};
  const calls = [];
  for (const n of names) {
    orig[n] = cp[n];
    cp[n] = function spy(...args) {
      calls.push({ fn: n, cmd: String(args[0]), args: Array.isArray(args[1]) ? args[1].map(String) : [] });
      if (!/\\whoami\.exe$/i.test(String(args[0]))) throw new Error(`spy: only whoami.exe may start (${n} ${args[0]})`);
      return orig[n].apply(this, args);
    };
  }
  syncBuiltinESMExports();
  return { calls, restore() { for (const n of names) cp[n] = orig[n]; syncBuiltinESMExports(); } };
}

/** Spy on every fs call that writes, creates or deletes: records the path it changes (the destination of a copy). */
function spyFs() {
  const names = ['writeFileSync', 'copyFileSync', 'mkdirSync', 'unlinkSync', 'rmdirSync', 'rmSync', 'renameSync', 'appendFileSync', 'symlinkSync', 'cpSync', 'truncateSync', 'writeSync', 'openSync'];
  const orig = {};
  const calls = [];
  for (const n of names) {
    orig[n] = fs[n];
    fs[n] = function spy(...args) {
      if (n === 'openSync' && !/[wa+x]/.test(String(args[1] ?? 'r'))) return orig[n].apply(this, args);
      if (n !== 'writeSync') calls.push({ fn: n, path: path.resolve(String(['copyFileSync', 'renameSync', 'symlinkSync', 'cpSync'].includes(n) ? args[1] : args[0])) });
      return orig[n].apply(this, args);
    };
  }
  syncBuiltinESMExports();
  return { calls, restore() { for (const n of names) fs[n] = orig[n]; syncBuiltinESMExports(); } };
}

/** Run the launcher with a fake Windows Script Host; returns what it asked the shell to run. */
function simulate(src, exitCode = 0) {
  const runs = [];
  let quit = null;
  const shell = {
    Run(cmd, style, wait) { runs.push({ cmd, style, wait }); return exitCode; },
    ExpandEnvironmentStrings(s) { return s.replace('%SystemRoot%', 'C:\\Windows'); },
  };
  const WScript = { CreateObject(name) { assert.equal(name, 'WScript.Shell'); return shell; }, Quit(c) { quit = c; } };
  vm.runInNewContext(src, { WScript });
  return { runs, quit };
}

const EXPECT_TREE = [
  'chrome-newtab/boot.js', 'chrome-newtab/icons/icon16.png', 'chrome-newtab/js/ntp-app.js', 'chrome-newtab/manifest.json', 'chrome-newtab/newtab.html',
  'still/anchors.json', 'still/lib/env.mjs', 'still/out/', 'still/pcd-still.mjs',
  'still/pixelclock/simulator/engine.js', 'still/pixelclock/simulator/themes/autumn.js', 'still/pixelclock/tools/render.js',
  'still/run-hidden.js', 'still/shared/pcd-engine.js', 'still/shared/pcd-hook.js', 'still/still.json', 'still/task.xml',
].sort();
/** Files one fresh install writes (every file in EXPECT_TREE). */
const N_FILES = EXPECT_TREE.filter((f) => !f.endsWith('/')).length;
/** dist files that are mirrored byte for byte (the launcher template is filled in instead). */
const MIRRORED = EXPECT_TREE.filter((f) => !f.endsWith('/') && !['still/run-hidden.js', 'still/still.json', 'still/task.xml'].includes(f));
const distOf = (rel) => rel.replace(/^chrome-newtab\//, 'newtab/');

// --- tests ---------------------------------------------------------------------------------------

test('arguments, defaults and usage', async () => {
  assert.deepEqual(inst.parseArgs(['--dry-run', '--target', 'C:\\x\\PixelClockDesktop', '--dist=C:\\d']), {
    target: 'C:\\x\\PixelClockDesktop', dist: 'C:\\d', dryRun: true, conhost: null, help: false, errors: [],
  });
  assert.equal(inst.parseArgs(['--conhost']).conhost, true);
  assert.equal(inst.parseArgs(['--no-conhost']).conhost, false);
  assert.match(inst.parseArgs(['--conhost', '--no-conhost']).errors.join(), /either --conhost or --no-conhost/);
  assert.match(inst.parseArgs(['--target']).errors.join(), /--target needs a folder/);
  assert.match(inst.parseArgs(['--target', '--dry-run']).errors.join(), /--target needs a folder/);
  assert.match(inst.parseArgs(['--force']).errors.join(), /unknown argument "--force"/);
  assert.match(inst.parseArgs(['--register']).errors.join(), /unknown argument "--register"/);
  assert.match(inst.parseArgs(['--target', 'a', '--target', 'b']).errors.join(), /given twice/);
  assert.equal(inst.defaultTarget({ LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' }), path.join('C:\\Users\\u\\AppData\\Local', 'PixelClockDesktop'));
  assert.equal(inst.defaultTarget({ LocalAppData: 'C:\\L' }), path.join('C:\\L', 'PixelClockDesktop'), 'names are case-insensitive');
  assert.equal(inst.defaultTarget({}), null);
  // a copied env keeps the spelling it came with (Git Bash passes SYSTEMROOT): lookups ignore case, exact names win
  assert.equal(inst.envVar({ SYSTEMROOT: 'C:\\W' }, 'SystemRoot'), 'C:\\W');
  assert.equal(inst.envVar({ SystemRoot: 'C:\\A', SYSTEMROOT: 'C:\\B' }, 'SystemRoot'), 'C:\\A');
  assert.equal(inst.whoamiPath({ WINDIR: 'D:\\Win' }), path.join('D:\\Win', 'System32', 'whoami.exe'));
  const roots = inst.forbiddenRoots({ env: { SYSTEMROOT: 'C:\\Win', ONEDRIVE: 'C:\\Users\\u\\OneDrive', USERPROFILE: 'C:\\Users\\u' }, known: [] });
  for (const [label, p] of [['the Windows folder', 'C:\\Win'], ['%SystemRoot%\\Temp', 'C:\\Win\\Temp'], ['%OneDrive%', 'C:\\Users\\u\\OneDrive']]) {
    assert.ok(roots.some((f) => f.label === label && f.path === path.resolve(p)), label);
  }
  assert.match(inst.USAGE, /never registers\s+the scheduled task and never sets the wallpaper/);
  const lines = [];
  assert.equal(await inst.main({ argv: ['--help'], log: (m) => lines.push(m), logError: (m) => lines.push(m) }), 0);
  assert.match(lines.join('\n'), /^usage: node tools\/install\.mjs/);
  lines.length = 0;
  assert.equal(await inst.main({ argv: ['--bogus'], log: (m) => lines.push(m), logError: (m) => lines.push(m) }), 2);
  assert.match(lines.join('\n'), /unknown argument "--bogus"[\s\S]*usage:/);
});

test('fresh install: exactly the pieces plus the generated files, every write printed and inside the target; a re-run writes nothing', async () => {
  const sb = sandbox();
  const procs = spyChildProcess();
  const writes = spyFs();
  let r1;
  let r2;
  try {
    r1 = await run(sb);
    r2 = await run(sb, [], { main: { now: () => NOW2 } }); // later: task.xml keeps its registration date
  } finally {
    writes.restore();
    procs.restore();
  }
  try {
    assert.equal(r1.code, 0, r1.out);
    assert.deepEqual(tree(sb.target), EXPECT_TREE);
    for (const rel of MIRRORED) {
      assert.ok(fs.readFileSync(path.join(sb.target, ...rel.split('/'))).equals(fs.readFileSync(path.join(sb.dist, ...distOf(rel).split('/')))), rel);
    }
    // every file written is printed, and every printed file is written
    const printed = r1.lines.filter((l) => l.startsWith('write  ')).map((l) => /^write {2}(.+?) \(\d+ bytes/.exec(l)[1]).sort();
    assert.deepEqual(printed, EXPECT_TREE.filter((f) => !f.endsWith('/')).map((f) => path.join(sb.target, ...f.split('/'))).sort());
    const written = writes.calls.filter((c) => c.fn === 'copyFileSync' || c.fn === 'writeFileSync').map((c) => c.path);
    assert.deepEqual([...new Set(written)].sort(), printed, 'the files written are the files printed');
    for (const c of writes.calls) assert.ok(c.path === sb.target || c.path.startsWith(sb.target + path.sep), `${c.fn} ${c.path} is inside the target`);
    assert.deepEqual(writes.calls.filter((c) => ['unlinkSync', 'rmdirSync', 'rmSync', 'renameSync'].includes(c.fn)), [], 'a fresh install deletes and renames nothing');
    assert.deepEqual(procs.calls, [], 'no process at all (the SID was given)');
    assert.ok(r1.out.includes(`create ${path.join(sb.still, 'out')}${path.sep} (pictures, state, cache and log; kept across installs)`), r1.out);
    assert.ok(r1.out.includes(`install: ${N_FILES} file(s) written, 0 unchanged, 0 deleted`), r1.out);
    // the next steps, in INSTALL.md's order: new tab, live wallpaper, still wallpaper
    const nextAt = (prefix) => r1.lines.findIndex((l) => l.startsWith(prefix));
    const iNew = nextAt('next: New tab (INSTALL.md, section 2): on chrome://extensions turn on Developer mode (leave it on), click Load unpacked and choose');
    const iLive = nextAt('next: Live wallpaper (INSTALL.md, section 3): in Lively click Add Wallpaper, then Browse, and pick');
    const iStill = nextAt('next: Still wallpaper (INSTALL.md, section 4), instead of the live one. This installer never registers the task and never sets the wallpaper; run these yourself:');
    assert.ok(iNew >= 0 && iLive > iNew && iStill > iLive, r1.out);
    assert.deepEqual(r1.lines.slice(iNew + 1, iNew + 3), [`      ${sb.newtab}`, '      Then press Ctrl+T, and click "Keep it" if Chrome asks.']);
    assert.deepEqual(r1.lines.slice(iLive + 1, iLive + 3), [`      ${path.join(sb.dist, 'PixelClockDesktop-wallpaper.zip')}`, '      Then click the new tile once. Lively keeps its own copy, so the zip stays in dist.']);
    const c = task.schtasksCommands(sb.still);
    const rows = [
      ['save the screen size', `node "${path.join(sb.still, 'pcd-still.mjs')}" --detect`],
      ['register the task', c.create], ['see it at once', c.run], ['pause it', c.disable], ['resume it', c.enable], ['remove it', c.remove],
    ];
    assert.deepEqual(r1.lines.slice(iStill + 1, iStill + 1 + rows.length), rows.map(([label, cmd]) => `      ${(label + ':').padEnd(22)}${cmd}`));
    assert.equal(c.create, `schtasks /Create /TN "PixelClock Desktop\\Still wallpaper" /XML "${path.join(sb.still, 'task.xml')}"`);
    assert.ok(!r1.lines.slice(iNew).some((l) => l.includes(NODE_EXE)), 'the printed commands use node from the PATH, which works in Command Prompt and PowerShell alike');
    for (const notInstalled of ['wallpaper', 'style-tile', 'PixelClockDesktop-wallpaper.zip']) assert.equal(fs.existsSync(path.join(sb.target, notInstalled)), false, `${notInstalled} stays in dist`);
    assert.equal(fs.existsSync(sb.lad), false, 'nothing written to the fake %LOCALAPPDATA%');
    assert.ok(!r1.out.includes(BERLIN.city) && !r2.out.includes(BERLIN.city), 'the city is never printed');

    assert.equal(r2.code, 0, r2.out);
    assert.ok(r2.out.includes(`install: 0 file(s) written, ${N_FILES - 1} unchanged, 0 deleted`), r2.out); // still.json is kept, not compared
    assert.ok(!/^(write|delete|create) /m.test(r2.out), r2.out);
    assert.ok(r2.out.includes(`keep   ${path.join(sb.still, 'still.json')} (your settings; never overwritten)`), r2.out);
    assert.ok(r2.out.includes(`keep   ${path.join(sb.still, 'out')}${path.sep} (pictures, state, cache and log; never touched)`), r2.out);
    assert.ok(!r2.out.includes('next: New tab'), 'no new tab step when nothing changed');
    assert.ok(!r2.out.includes('task.xml changed'), r2.out);
    assert.ok(!r2.out.includes('--detect'), 'the screen-size hint only follows a new still.json');
  } finally {
    cleanup(sb.dir);
  }
});

test('generated files: task.xml and run-hidden.js hold the absolute install paths; still.json comes from the config', async () => {
  const sb = sandbox();
  try {
    const r = await run(sb);
    assert.equal(r.code, 0, r.out);
    // task.xml: UTF-16LE with BOM, the installed launcher, folder and SID
    const bytes = fs.readFileSync(path.join(sb.still, 'task.xml'));
    assert.deepEqual([...bytes.subarray(0, 2)], [0xff, 0xfe]);
    const t = task.parseXml(task.decodeTaskXml(bytes));
    assert.equal(task.xmlText(t, 'Actions/Exec/Command'), '%SystemRoot%\\System32\\wscript.exe');
    assert.equal(task.xmlText(t, 'Actions/Exec/Arguments'), `//B //Nologo //E:jscript "${path.join(sb.still, 'run-hidden.js')}"`);
    assert.equal(task.xmlText(t, 'Actions/Exec/WorkingDirectory'), sb.still);
    assert.equal(task.xmlText(t, 'Principals/Principal/UserId'), SID);
    assert.equal(task.xmlText(t, 'Triggers/LogonTrigger/UserId'), SID);
    assert.equal(task.xmlText(t, 'RegistrationInfo/Date'), '2026-11-15T16:30:05');
    assert.ok(bytes.equals(task.taskXmlBytes(task.taskXml({ stillDir: sb.still, userSid: SID, date: NOW }))), 'exactly the still group\'s task.xml');
    assert.ok(r.out.includes(`write  ${path.join(sb.still, 'task.xml')} (${bytes.length} bytes, task definition, UTF-16LE; never registered by this installer)`), r.out);

    // run-hidden.js: compiles, holds only absolute paths, runs node hidden with --set
    const js = fs.readFileSync(path.join(sb.still, 'run-hidden.js'), 'utf8');
    assert.equal(js, task.runHiddenJs({ node: NODE_EXE, stillDir: sb.still }));
    new vm.Script(js, { filename: 'run-hidden.js' });
    const literals = [...js.matchAll(/^var (NODE|SCRIPT) = (".*");$/gm)].map((m) => [m[1], JSON.parse(m[2])]);
    assert.deepEqual(literals, [['NODE', NODE_EXE], ['SCRIPT', path.join(sb.still, 'pcd-still.mjs')]]);
    for (const [, p] of literals) assert.match(p, /^[A-Za-z]:\\/, 'absolute');
    assert.ok(!/@(NODE|SCRIPT|ARGS|HEADLESS)@/.test(js), 'no placeholder left');
    assert.ok(!/[^\x20-\x7e\n]/.test(js), 'ASCII only (wscript reads it in the ANSI code page)');
    const sim = simulate(js, 3);
    assert.deepEqual(sim.runs, [{ cmd: `"${NODE_EXE}" "${path.join(sb.still, 'pcd-still.mjs')}" --set`, style: 0, wait: true }]);
    assert.equal(sim.quit, 3, 'quits with node\'s exit code');

    // still.json: the config's answers in the still's own shape, UTF-8 without BOM, LF
    const raw = fs.readFileSync(path.join(sb.still, 'still.json'));
    assert.ok(!(raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf) && !raw.includes(13), 'UTF-8 without BOM, LF');
    const sj = JSON.parse(raw.toString('utf8'));
    assert.deepEqual(sj, {
      width: 0, height: 0, scale: 1, theme: 'auto', clock24: BERLIN.clock === '24h', units: BERLIN.units, city: BERLIN.city,
      sunTimes: BERLIN.sunTimes, weather: BERLIN.weather, weatherFx: true, taskbar: BERLIN.taskbarPx,
    });
    assert.deepEqual(Object.keys(sj), Object.keys(stillEnv.STILL_DEFAULTS), 'the still\'s own key order');
    assert.deepEqual(stillEnv.normalizeStill(sj).problems, [], 'the still accepts it as it is');
    // the mapping for other answers (12 h, F, no taskbar band)
    const other = inst.stillSettings({ ...BERLIN, clock: '12h', units: 'F', taskbarPx: 0, sunTimes: false, weather: false });
    assert.deepEqual([other.clock24, other.units, other.taskbar, other.sunTimes, other.weather], [false, 'F', 0, false, false]);
    assert.throws(() => inst.stillSettings({ ...BERLIN, units: 'K' }), /units/);
    // a config with a key it does not know is refused, like any config that does not fit
    assert.throws(() => inst.stillSettings({ ...BERLIN, nope: 1 }), /unknown key "nope"/);
  } finally {
    cleanup(sb.dir);
  }
});

test('reinstall keeps still.json and out\\ untouched and regenerates run-hidden.js and task.xml', async () => {
  const sb = sandbox();
  try {
    assert.equal((await run(sb)).code, 0);
    const sj = path.join(sb.still, 'still.json');
    const yours = JSON.stringify({ ...JSON.parse(fs.readFileSync(sj, 'utf8')), nope: 1, width: 2560, height: 1600, scale: 2 }, null, 2) + '\n';
    fs.writeFileSync(sj, yours);
    const outFiles = { 'wall-a.png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 5]), 'state.json': '{"v":1}\n', 'still.log': 'one line\n', 'cache.json': '{}\n', 'old/keep.txt': 'x' };
    for (const [rel, data] of Object.entries(outFiles)) writeFile(path.join(sb.still, 'out', ...rel.split('/')), data);
    const outBefore = tree(path.join(sb.still, 'out'));
    // a damaged launcher and task.xml (an editor, a bad copy)
    fs.appendFileSync(path.join(sb.still, 'run-hidden.js'), 'WScript.Echo("tampered");\n');
    fs.writeFileSync(path.join(sb.still, 'task.xml'), 'not a task');

    const r = await run(sb, [], { main: { now: () => NOW2 } });
    assert.equal(r.code, 0, r.out);
    assert.equal(fs.readFileSync(sj, 'utf8'), yours, 'your still.json is kept byte for byte');
    assert.deepEqual(tree(path.join(sb.still, 'out')), outBefore, 'out\\ keeps every file');
    for (const [rel, data] of Object.entries(outFiles)) assert.ok(fs.readFileSync(path.join(sb.still, 'out', ...rel.split('/'))).equals(Buffer.from(data)), rel);
    assert.ok(r.out.includes(`keep   ${sj} (your settings; never overwritten)`), r.out);
    assert.ok(r.out.includes(`keep   ${path.join(sb.still, 'out')}${path.sep} (pictures, state, cache and log; never touched)`), r.out);
    assert.ok(!r.out.includes(`write  ${sj}`) && !/delete .*\\out\\/.test(r.out), r.out);
    assert.equal(fs.readFileSync(path.join(sb.still, 'run-hidden.js'), 'utf8'), task.runHiddenJs({ node: NODE_EXE, stillDir: sb.still }));
    const t = task.parseXml(task.decodeTaskXml(fs.readFileSync(path.join(sb.still, 'task.xml'))));
    assert.equal(task.xmlText(t, 'RegistrationInfo/Date'), '2026-11-16T09:00:00', 'a broken task.xml is made anew (date now)');
    assert.ok(r.out.includes(`install: 2 file(s) written, ${N_FILES - 3} unchanged, 0 deleted`), r.out);
    assert.ok(r.lines.includes(`      ${'task.xml changed:'.padEnd(22)}if the task is registered already, replace it: ${task.schtasksCommands(sb.still).create} /F`), r.out);
    assert.ok(!r.out.includes('next: New tab'), 'the new tab did not change');

    // node moved (a new Node install): only the launcher changes; the registered task keeps working
    const moved = await run(sb, [], { main: { execPath: 'C:\\Tools\\node-v24\\node.exe', now: () => NOW } });
    assert.equal(moved.code, 0, moved.out);
    assert.ok(moved.out.includes(`install: 1 file(s) written, ${N_FILES - 2} unchanged, 0 deleted`), moved.out);
    assert.match(fs.readFileSync(path.join(sb.still, 'run-hidden.js'), 'utf8'), /^var NODE = "C:\\\\Tools\\\\node-v24\\\\node\.exe";$/m);
    assert.ok(!moved.out.includes('task.xml changed'), 'task.xml does not depend on node');
    assert.equal(fs.readFileSync(sj, 'utf8'), yours);
  } finally {
    cleanup(sb.dir);
  }
});

test('--conhost makes the launcher start node through conhost --headless; reinstalls keep the choice until --no-conhost', async () => {
  const sb = sandbox();
  try {
    const on = await run(sb, ['--conhost']);
    assert.equal(on.code, 0, on.out);
    assert.match(on.out, /launcher {2}node through conhost\.exe --headless \(from the command line\)/);
    const launcher = path.join(sb.still, 'run-hidden.js');
    assert.equal(fs.readFileSync(launcher, 'utf8'), task.runHiddenJs({ node: NODE_EXE, stillDir: sb.still, headless: true }));
    assert.equal(simulate(fs.readFileSync(launcher, 'utf8')).runs[0].cmd, `"C:\\Windows\\System32\\conhost.exe" --headless "${NODE_EXE}" "${path.join(sb.still, 'pcd-still.mjs')}" --set`);
    const kept = await run(sb);
    assert.equal(kept.code, 0, kept.out);
    assert.match(kept.out, /launcher {2}node through conhost\.exe --headless \(as installed\)/);
    assert.ok(!kept.out.includes(`write  ${launcher}`), 'unchanged');
    const off = await run(sb, ['--no-conhost']);
    assert.equal(off.code, 0, off.out);
    assert.ok(off.out.includes(`write  ${launcher} (`), off.out);
    assert.equal(fs.readFileSync(launcher, 'utf8'), task.runHiddenJs({ node: NODE_EXE, stillDir: sb.still }));
    assert.match((await run(sb)).out, /launcher {2}node with a hidden window \(as installed\)/);
  } finally {
    cleanup(sb.dir);
  }
});

test('stale files inside chrome-newtab and still are removed; still.json, out\\ and everything outside the two folders are untouched', async () => {
  const sb = sandbox();
  try {
    assert.equal((await run(sb)).code, 0);
    const stale = [
      path.join(sb.newtab, 'old.js'),
      path.join(sb.newtab, 'lib', 'deep', 'gone.js'),
      path.join(sb.still, 'old-renderer.mjs'),
      path.join(sb.still, 'lib', 'unused.mjs'),
      path.join(sb.still, 'pixelclock', 'simulator', 'themes', 'unused.js'),
    ];
    const outside = [
      path.join(sb.target, 'notes.txt'),
      path.join(sb.target, 'other', 'keep.txt'),
      path.join(sb.target, 'wallpaper', 'index.html'),
      path.join(path.dirname(sb.target), 'sibling.txt'),
      path.join(sb.still, 'out', 'wall-old.png'),
      path.join(sb.still, 'out', 'nested', 'deep.txt'),
      path.join(sb.dir, 'outside-target.txt'),
    ];
    for (const f of [...stale, ...outside]) writeFile(f, 'x');
    const sj = fs.readFileSync(path.join(sb.still, 'still.json'));

    const dry = await run(sb, ['--dry-run']);
    assert.equal(dry.code, 0, dry.out);
    for (const f of stale) {
      assert.ok(dry.out.includes(`would delete ${f} (no longer in dist)`), `planned ${f}`);
      assert.ok(fs.existsSync(f), 'a dry run deletes nothing');
    }
    assert.ok(dry.out.includes(`would delete ${path.join(sb.newtab, 'lib', 'deep')}${path.sep} (empty folder no longer in dist)`), dry.out);

    const writes = spyFs();
    let r;
    try {
      r = await run(sb);
    } finally {
      writes.restore();
    }
    assert.equal(r.code, 0, r.out);
    for (const f of stale) {
      assert.equal(fs.existsSync(f), false, `removed ${f}`);
      assert.ok(r.out.includes(`delete ${f} (no longer in dist)`), `printed ${f}`);
    }
    assert.equal(fs.existsSync(path.join(sb.newtab, 'lib')), false, 'emptied folders are removed');
    for (const f of outside) assert.equal(fs.readFileSync(f, 'utf8'), 'x', `untouched ${f}`);
    assert.ok(fs.readFileSync(path.join(sb.still, 'still.json')).equals(sj));
    assert.ok(r.out.includes(`install: 0 file(s) written, ${N_FILES - 1} unchanged, ${stale.length} deleted`), r.out);
    for (const c of writes.calls) {
      assert.ok(c.path.startsWith(sb.newtab + path.sep) || c.path.startsWith(sb.still + path.sep), `${c.fn} ${c.path} is inside chrome-newtab or still`);
      assert.ok(!c.path.startsWith(path.join(sb.still, 'out') + path.sep) && c.path !== path.join(sb.still, 'still.json'), `${c.fn} ${c.path} never touches out\\ or still.json`);
    }
    assert.deepEqual(writes.calls.filter((c) => c.fn === 'unlinkSync').map((c) => c.path).sort(), [...stale].sort());
    assert.match(r.out, /next: New tab changed: on chrome:\/\/extensions click Reload on the "PixelClock Desktop" card\. Your settings stay\./);
  } finally {
    cleanup(sb.dir);
  }
});

test('a file whose name only changed case in dist is replaced, not deleted', async () => {
  const sb = sandbox();
  try {
    assert.equal((await run(sb)).code, 0);
    const nt = path.join(sb.dist, 'newtab');
    fs.renameSync(path.join(nt, 'js'), path.join(nt, 'JS'));
    fs.renameSync(path.join(nt, 'boot.js'), path.join(nt, 'tmp-rename.js'));
    fs.renameSync(path.join(nt, 'tmp-rename.js'), path.join(nt, 'Boot.js'));
    fs.writeFileSync(path.join(nt, 'Boot.js'), '/* boot 2 */\n');
    const r = await run(sb);
    assert.equal(r.code, 0, r.out);
    assert.ok(!/delete .*(boot\.js|ntp-app\.js)/i.test(r.out), r.out);
    assert.equal(fs.readFileSync(path.join(sb.newtab, 'Boot.js'), 'utf8'), '/* boot 2 */\n');
    assert.ok(fs.existsSync(path.join(sb.newtab, 'JS', 'ntp-app.js')));
  } finally {
    cleanup(sb.dir);
  }
});

test('dry run prints the whole plan and creates nothing', async () => {
  const sb = sandbox();
  const writes = spyFs();
  let r;
  try {
    r = await run(sb, ['--dry-run']);
  } finally {
    writes.restore();
  }
  try {
    assert.equal(r.code, 0, r.out);
    assert.deepEqual(writes.calls, [], 'a dry run calls no writing fs function');
    assert.match(r.out, /^PixelClock Desktop install \(dry run: nothing is written\)$/m);
    for (const rel of EXPECT_TREE.filter((f) => !f.endsWith('/'))) assert.ok(r.out.includes(`would write  ${path.join(sb.target, ...rel.split('/'))} (`), rel);
    assert.ok(r.out.includes(`would create ${path.join(sb.still, 'out')}${path.sep} (`), r.out);
    assert.ok(r.out.includes(`dry run: ${N_FILES} file(s) would be written, 0 unchanged, 0 would be deleted`), r.out);
    assert.match(r.out, /after a real install:\nnext: New tab \(INSTALL\.md, section 2\): /);
    assert.ok(r.out.includes(task.schtasksCommands(sb.still).create), r.out);
    assert.equal(fs.existsSync(path.join(sb.dir, 'Local')), false, 'no folder created');
  } finally {
    cleanup(sb.dir);
  }
});

test('refuses unsafe destinations (OneDrive, Desktop, Documents, Downloads, Temp, the repo, names, paths, overlap) before starting any process', async () => {
  const sb = sandbox();
  const procs = spyChildProcess();
  try {
    const refuse = async (argv, re, mainOpts = {}) => {
      const r = await run(sb, [], { argv: [...argv, '--dry-run'], main: { sid: null, ...mainOpts } });
      assert.equal(r.code, 1, `${argv.join(' ')}\n${r.out}`);
      assert.match(r.out, re);
      assert.match(r.out, /refusing to run; nothing was changed/);
      assert.ok(!r.out.includes('would write'), r.out);
    };
    const t = (...parts) => ['--dist', sb.dist, '--target', path.join(...parts)];
    // the repo, and the repo folder itself (whatever it is called)
    await refuse(t(ROOT, '.tmp-install-test-never-created', 'PixelClockDesktop'), /inside the repo/);
    assert.equal(fs.existsSync(path.join(ROOT, '.tmp-install-test-never-created')), false);
    await refuse(['--dist', sb.dist, '--target', ROOT], /inside the repo/);
    // %TEMP%: the default target in a temp %LOCALAPPDATA% is not explicit, so it is refused
    await refuse(['--dist', sb.dist], /target .*inside (%TEMP%|%TMP%|os\.tmpdir\(\))/);
    if (IS_WIN && process.env.SystemRoot) await refuse(t(process.env.SystemRoot, 'Temp', 'PixelClockDesktop'), /inside (the Windows folder|%SystemRoot%\\Temp)/);
    // OneDrive, by name anywhere on the path
    await refuse(t(sb.dir, 'OneDrive', 'PixelClockDesktop'), /inside a OneDrive folder \("OneDrive"\)/);
    await refuse(t(sb.dir, 'OneDrive - Contoso', 'PixelClockDesktop'), /inside a OneDrive folder \("OneDrive - Contoso"\)/);
    // Desktop, Documents, Downloads: by name (redirected known folders keep their names), in the profile, or known
    for (const n of ['Desktop', 'Documents', 'Downloads']) await refuse(t(sb.dir, n, 'PixelClockDesktop'), new RegExp(`inside a folder named "${n}"`));
    const profile = path.join(sb.dir, 'profile');
    await refuse(t(profile, 'Desktop', 'PixelClockDesktop'), /inside Desktop \(profile\)/, { env: envWith(sb.env, { USERPROFILE: profile }) });
    const fakeDesk = path.join(sb.dir, 'FakeDesk');
    await refuse(t(fakeDesk, 'PixelClockDesktop'), /inside Desktop \(known folder\)/, { knownFolders: [{ label: 'Desktop (known folder)', path: fakeDesk }] });
    // names and paths
    await refuse(t(sb.dir, 'Install'), /must be named "PixelClockDesktop"/);
    await refuse(['--dist', sb.dist, '--target', 'PixelClockDesktop'], /use an absolute path on a local drive/);
    await refuse(['--dist', sb.dist, '--target', '\\\\server\\share\\PixelClockDesktop'], /not on a local drive/);
    await refuse(t(sb.dist, 'PixelClockDesktop'), /dist .* must not contain each other/);
    writeFile(path.join(sb.dir, 'file', 'PixelClockDesktop'), 'a file, not a folder');
    await refuse(t(sb.dir, 'file', 'PixelClockDesktop'), /exists and is not a folder/);
    assert.equal(fs.existsSync(sb.target), false);
    assert.deepEqual(procs.calls, [], 'no process starts before every check passed (not even whoami)');
  } finally {
    procs.restore();
    cleanup(sb.dir);
  }
});

test('the PixelClock repo is refused too (path check only)', () => {
  const forbidden = inst.forbiddenRoots({ known: [] });
  const problems = inst.checkDestination(path.join(path.dirname(ROOT), 'PixelClock', 'never-created', 'PixelClockDesktop'), { label: 'target', explicit: true, forbidden });
  assert.ok(problems.some((p) => p.includes('inside the PixelClock repo')), problems.join('\n'));
  const viaEnv = inst.forbiddenRoots({ env: { ...process.env, PCD_PIXELCLOCK: path.join(os.tmpdir(), 'clock-copy') }, known: [] });
  assert.ok(viaEnv.some((f) => f.label === 'the PixelClock repo' && f.path === path.join(os.tmpdir(), 'clock-copy')), 'PCD_PIXELCLOCK is honoured');
});

test('junctions: linked destinations are refused, links inside the managed folders are never followed, and a linked out\\ is left alone', { skip: !IS_WIN && 'Windows only' }, async () => {
  const sb = sandbox();
  try {
    const elsewhere = path.join(sb.dir, 'elsewhere');
    writeFile(path.join(elsewhere, 'precious.txt'), 'keep me');
    // the target itself is a junction
    const linkedTarget = path.join(sb.dir, 'linked', 'PixelClockDesktop');
    fs.mkdirSync(path.dirname(linkedTarget), { recursive: true });
    fs.symlinkSync(elsewhere, linkedTarget, 'junction');
    let r = await run(sb, [], { argv: ['--dist', sb.dist, '--target', linkedTarget] });
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /is a link\/junction/);
    // a path that reaches a known folder through a junction
    const fakeDesk = path.join(sb.dir, 'FakeDesk');
    fs.mkdirSync(fakeDesk);
    fs.symlinkSync(fakeDesk, path.join(sb.dir, 'via'), 'junction');
    r = await run(sb, [], { argv: ['--dist', sb.dist, '--target', path.join(sb.dir, 'via', 'PixelClockDesktop')], main: { knownFolders: [{ label: 'Desktop (known folder)', path: fakeDesk }] } });
    assert.equal(r.code, 1, r.out);
    assert.ok(r.out.includes(`inside Desktop (known folder) (${fakeDesk})`), r.out);
    const named = path.join(sb.dir, 'x', 'Desktop');
    fs.mkdirSync(named, { recursive: true });
    fs.symlinkSync(named, path.join(sb.dir, 'via2'), 'junction');
    r = await run(sb, [], { argv: ['--dist', sb.dist, '--target', path.join(sb.dir, 'via2', 'PixelClockDesktop')] });
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /inside a folder named "Desktop"/);
    assert.equal(fs.readdirSync(fakeDesk).length + fs.readdirSync(named).length, 0, 'nothing written through the junctions');

    // a managed folder that is a junction is refused
    assert.equal((await run(sb)).code, 0);
    const still = sb.still;
    fs.renameSync(still, still + '-real');
    fs.symlinkSync(elsewhere, still, 'junction');
    r = await run(sb);
    assert.equal(r.code, 1, r.out);
    assert.ok(r.out.includes(`${still} is a link/junction`), r.out);
    fs.unlinkSync(still);
    fs.renameSync(still + '-real', still);

    // a link in the way of a write (a folder on the way, or the file itself) refuses the run: nothing is
    // written through it; so does a file where a folder is needed
    const js = path.join(sb.newtab, 'js');
    fs.rmSync(js, { recursive: true });
    fs.symlinkSync(elsewhere, js, 'junction');
    r = await run(sb);
    assert.equal(r.code, 1, r.out);
    assert.ok(r.out.includes(`${js} is a link/junction: not followed or replaced; remove it, then run the installer again`), r.out);
    fs.unlinkSync(js);
    const manifest = path.join(sb.newtab, 'manifest.json');
    fs.rmSync(manifest);
    fs.symlinkSync(elsewhere, manifest, 'junction');
    r = await run(sb);
    assert.equal(r.code, 1, r.out);
    assert.ok(r.out.includes(`${manifest} is a link/junction: not followed or replaced`), r.out);
    fs.unlinkSync(manifest);
    const icons = path.join(sb.newtab, 'icons');
    fs.rmSync(icons, { recursive: true });
    fs.writeFileSync(icons, 'a file, not a folder');
    r = await run(sb);
    assert.equal(r.code, 1, r.out);
    assert.ok(r.out.includes(`${icons} is a file where a folder is needed`), r.out);
    fs.rmSync(icons);
    assert.deepEqual(fs.readdirSync(elsewhere), ['precious.txt'], 'nothing written through a link');
    // a linked piece folder in dist would look empty (and make every installed file "stale"): refused
    const distLinked = path.join(sb.dir, 'dist-linked');
    fs.cpSync(path.join(sb.dist, 'newtab'), path.join(distLinked, 'newtab'), { recursive: true });
    fs.symlinkSync(path.join(sb.dist, 'still'), path.join(distLinked, 'still'), 'junction');
    r = await run(sb, [], { argv: ['--dist', distLinked, '--target', sb.target] });
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /still: must be a real folder, not a link\/junction/);
    assert.ok(fs.existsSync(path.join(still, 'pcd-still.mjs')), 'nothing deleted');

    // a junction inside chrome-newtab is reported and left alone; its target keeps its files
    const inner = path.join(sb.newtab, 'linked');
    fs.symlinkSync(elsewhere, inner, 'junction');
    // out\ as a junction (you moved the pictures elsewhere): never followed, never replaced
    const outReal = path.join(sb.dir, 'pictures');
    writeFile(path.join(outReal, 'wall-a.png'), 'png');
    fs.rmSync(path.join(still, 'out'), { recursive: true });
    fs.symlinkSync(outReal, path.join(still, 'out'), 'junction');
    r = await run(sb);
    assert.equal(r.code, 0, r.out);
    assert.ok(r.out.includes(`skip   ${inner} (link/junction: not followed, not deleted)`), r.out);
    assert.ok(r.out.includes(`keep   ${path.join(still, 'out')}${path.sep} (a link/junction: not followed, left as it is)`), r.out);
    assert.equal(fs.readFileSync(path.join(elsewhere, 'precious.txt'), 'utf8'), 'keep me');
    assert.deepEqual(fs.readdirSync(elsewhere), ['precious.txt']);
    assert.deepEqual(fs.readdirSync(outReal), ['wall-a.png']);
    assert.ok(fs.lstatSync(inner).isSymbolicLink() && fs.lstatSync(path.join(still, 'out')).isSymbolicLink());
  } finally {
    cleanup(sb.dir);
  }
});

test('refuses a broken dist, a template without placeholders, a config that does not fit and paths the launcher cannot hold; nothing is written', async () => {
  const sb = sandbox();
  try {
    const refused = async (re, opts) => {
      const r = await run(sb, [], opts);
      assert.equal(r.code, 1, r.out);
      assert.match(r.out, re);
      assert.match(r.out, /refusing to run; nothing was changed/);
      assert.equal(fs.existsSync(path.join(sb.dir, 'Local')), false, 'nothing created');
      return r;
    };
    const keep = (rel) => fs.readFileSync(path.join(sb.dist, ...rel.split('/')));
    const html = keep('newtab/newtab.html');
    const render = keep('still/pixelclock/tools/render.js');
    fs.rmSync(path.join(sb.dist, 'newtab', 'newtab.html'));
    fs.rmSync(path.join(sb.dist, 'still', 'pixelclock', 'tools', 'render.js'));
    const manifest = path.join(sb.dist, 'newtab', 'manifest.json');
    const good = fs.readFileSync(manifest);
    fs.writeFileSync(manifest, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), good]));
    writeFile(path.join(sb.dist, 'still', 'still.json'), '{}\n');
    const r = await refused(/dist is missing 2 piece\(s\)/);
    assert.ok(r.out.includes('dist/newtab/newtab.html') && r.out.includes('dist/still/pixelclock/tools/render.js'), r.out);
    assert.match(r.out, /newtab\/manifest\.json: starts with a UTF-8 BOM/);
    assert.match(r.out, /still\/still\.json: dist must not hold it/);
    fs.writeFileSync(path.join(sb.dist, 'newtab', 'newtab.html'), html);
    fs.writeFileSync(path.join(sb.dist, 'still', 'pixelclock', 'tools', 'render.js'), render);
    fs.writeFileSync(manifest, good);
    fs.rmSync(path.join(sb.dist, 'still', 'still.json'));

    await refused(/does not exist: run node tools\/build\.mjs first/, { argv: ['--dist', path.join(sb.dir, 'nope'), '--target', sb.target] });
    const tpl = path.join(sb.dist, 'still', 'run-hidden.js');
    const template = fs.readFileSync(tpl);
    fs.writeFileSync(tpl, 'WScript.Quit(0);\n');
    await refused(/run-hidden\.js template must contain "@NODE@" exactly once/);
    fs.writeFileSync(tpl, template);
    await refused(/cannot make still\.json from config\/user\.json: .*"units"/, { main: { config: { ...BERLIN, units: 'K' } } });
    // paths the launcher cannot hold: non-ASCII (wscript reads it as ANSI) and % (expanded by Windows)
    for (const [dir, re] of [['Zo\u00eb', /non-ASCII/], ['100%', /must not contain %/]]) {
      const target = path.join(sb.dir, 'Local', dir, 'PixelClockDesktop');
      await refused(re, { argv: ['--dist', sb.dist, '--target', target] });
    }
    // a SID that whoami cannot give
    await refused(/cannot read the current user's SID/, { main: { sid: 'someone' } });
    assert.equal((await run(sb)).code, 0, 'the repaired dist installs');
  } finally {
    cleanup(sb.dir);
  }
});

test('the only process is the read-only whoami /user (the SID for task.xml)', { skip: !IS_WIN && 'Windows only', timeout: 60000 }, async () => {
  assert.equal(inst.parseWhoami('"laptop\\ann","S-1-5-21-1-2-3-1001"\r\n'), 'S-1-5-21-1-2-3-1001');
  assert.equal(inst.parseWhoami('USER INFORMATION\n\nUser Name   SID\n=========== ===\nlaptop\\ann S-1-5-21-9-8-7-500\n'), 'S-1-5-21-9-8-7-500');
  assert.throws(() => inst.parseWhoami('ERROR: something'), /no SID/);
  assert.throws(() => inst.whoamiSid({ spawn: () => ({ status: 1, stdout: '' }) }), /whoami \/user failed \(exit 1\)/);
  const fake = [];
  assert.equal(inst.whoamiSid({ env: { SystemRoot: 'C:\\Windows' }, spawn: (exe, args, opts) => { fake.push({ exe, args, opts }); return { status: 0, stdout: `"a\\b","${SID}"\r\n` }; } }), SID);
  assert.deepEqual(fake.map((c) => [c.exe, c.args, c.opts.windowsHide, c.opts.shell]), [['C:\\Windows\\System32\\whoami.exe', ['/user', '/fo', 'csv', '/nh'], true, undefined]]);

  const sb = sandbox();
  const procs = spyChildProcess();
  let r;
  try {
    r = await run(sb, [], { main: { sid: null } });
  } finally {
    procs.restore();
  }
  try {
    assert.equal(r.code, 0, r.out);
    assert.deepEqual(procs.calls.map((c) => [c.fn, path.basename(c.cmd).toLowerCase(), c.args]), [['spawnSync', 'whoami.exe', ['/user', '/fo', 'csv', '/nh']]]);
    assert.equal(procs.calls[0].cmd, inst.whoamiPath(process.env));
    const t = task.parseXml(task.decodeTaskXml(fs.readFileSync(path.join(sb.still, 'task.xml'))));
    assert.match(task.xmlText(t, 'Principals/Principal/UserId'), /^S-1-5-\d+(-\d+)+$/, 'the real SID (not printed)');
    assert.ok(!r.out.includes(task.xmlText(t, 'Principals/Principal/UserId')), 'the SID is not printed');
  } finally {
    cleanup(sb.dir);
  }
});

test('the real default target on this machine passes the safety rules (path check only; nothing is installed)', { skip: !IS_WIN && 'Windows only' }, () => {
  const target = inst.defaultTarget(process.env);
  assert.ok(target && process.env.LOCALAPPDATA);
  assert.equal(target, path.join(process.env.LOCALAPPDATA, 'PixelClockDesktop'));
  assert.deepEqual(inst.checkDestination(target, { label: 'target', explicit: false, forbidden: inst.forbiddenRoots() }), []);
  const desktop = path.join(process.env.USERPROFILE || os.homedir(), 'Desktop', 'PixelClockDesktop');
  assert.ok(inst.checkDestination(desktop, { label: 'target', explicit: true, forbidden: inst.forbiddenRoots() }).length > 0, 'the profile Desktop is refused');
});

test('the real built pieces (stand-ins for a piece not built yet) install into a temp target, and the installed still renders from there', { timeout: 120000 }, async (t) => {
  const built = (piece, file) => fs.existsSync(path.join(ROOT, 'dist', piece, file));
  const realNewtab = built('newtab', 'manifest.json') && built('newtab', 'newtab.html');
  const realStill = built('still', 'pcd-still.mjs') && built('still', 'run-hidden.js');
  if (!realNewtab && !realStill) {
    t.skip('neither dist/newtab nor dist/still is built yet (node tools/build.mjs --no-sync)');
    return;
  }
  const sb = sandbox();
  try {
    const dist = path.join(sb.dir, 'dist-real');
    for (const [piece, real] of [['newtab', realNewtab], ['still', realStill]]) {
      fs.cpSync(real ? path.join(ROOT, 'dist', piece) : path.join(sb.dist, piece), path.join(dist, piece), { recursive: true });
    }
    // still.json given first, weather off: the render below never touches the network
    writeFile(path.join(sb.still, 'still.json'), JSON.stringify({ ...stillEnv.STILL_DEFAULTS, city: BERLIN.city, weather: false, sunTimes: false, weatherFx: false }, null, 2) + '\n');
    const dry = await run(sb, [], { argv: ['--dist', dist, '--target', sb.target, '--dry-run'] });
    assert.equal(dry.code, 0, dry.out);
    const r = await run(sb, [], { argv: ['--dist', dist, '--target', sb.target] });
    assert.equal(r.code, 0, r.out);
    for (const [piece, group] of [['newtab', sb.newtab], ['still', sb.still]]) {
      for (const rel of inst.walk(path.join(dist, piece)).files) {
        const dst = path.join(group, ...rel.split('/'));
        assert.ok(dry.out.includes(`would write  ${dst} (`), `planned ${piece}/${rel}`);
        assert.ok(r.out.includes(`write  ${dst} (`), `printed ${piece}/${rel}`);
        if (piece === 'still' && rel === 'run-hidden.js') continue;
        assert.ok(fs.readFileSync(dst).equals(fs.readFileSync(path.join(dist, piece, ...rel.split('/')))), `${piece}/${rel} byte for byte`);
      }
    }
    const template = fs.readFileSync(path.join(dist, 'still', 'run-hidden.js'), 'utf8');
    assert.equal(fs.readFileSync(path.join(sb.still, 'run-hidden.js'), 'utf8'), task.runHiddenJs({ node: NODE_EXE, stillDir: sb.still, template }));
    if (!realStill) return;
    // the installed renderer runs from its installed folder: a picture into the sandbox, never set
    const png = path.join(sb.dir, 'installed.png');
    const env = envWith(sb.env, { PCD_NO_WALLPAPER: '1' });
    for (const k of Object.keys(env)) if (k.toLowerCase() === 'pcd_still_home') delete env[k];
    const res = cp.spawnSync(process.execPath, [path.join(sb.still, 'pcd-still.mjs'), '--out', png, '--size', '1280x800', '--at', '2026-11-15T12:00', '--quiet'], { encoding: 'utf8', env, cwd: sb.dir, windowsHide: true, timeout: 60000 });
    assert.equal(res.status, 0, res.stdout + res.stderr);
    const head = fs.readFileSync(png).subarray(0, 24);
    assert.equal(head.toString('latin1', 1, 4), 'PNG');
    assert.equal(`${head.readUInt32BE(16)}x${head.readUInt32BE(20)}`, '1280x800');
    assert.deepEqual(fs.readdirSync(path.join(sb.still, 'out')), [], 'an --out render leaves out\\ empty');
  } finally {
    cleanup(sb.dir);
  }
});

test('CLI end to end (subprocess): --help, a bad argument, --dry-run, then a real run into os.tmpdir() that keeps a given still.json', { skip: !IS_WIN && 'Windows only', timeout: 120000 }, () => {
  const sb = sandbox();
  try {
    const cli = (args) => cp.spawnSync(process.execPath, [INSTALL, ...args], { encoding: 'utf8', env: sb.env, windowsHide: true, timeout: 60000 });
    const help = cli(['--help']);
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /^usage: node tools\/install\.mjs/);
    assert.equal(cli(['--nope']).status, 2);
    // still.json given first: the repo's config/user.json is never read (a fresh clone has none, and your own city
    // never reaches a test)
    const given = JSON.stringify({ ...stillEnv.STILL_DEFAULTS, city: BERLIN.city, units: 'C' }, null, 2) + '\n';
    writeFile(path.join(sb.still, 'still.json'), given);
    const dry = cli(['--dist', sb.dist, '--target', sb.target, '--dry-run']);
    assert.equal(dry.status, 0, dry.stdout + dry.stderr);
    assert.ok(dry.stdout.includes(`dry run: ${N_FILES - 1} file(s) would be written`), dry.stdout);
    assert.deepEqual(tree(sb.target), ['still/still.json'], 'the dry run wrote nothing');
    const real = cli(['--dist', sb.dist, '--target', sb.target]);
    assert.equal(real.status, 0, real.stdout + real.stderr);
    assert.deepEqual(tree(sb.target), EXPECT_TREE);
    assert.equal(fs.readFileSync(path.join(sb.still, 'still.json'), 'utf8'), given);
    assert.ok(real.stdout.includes(`install: ${N_FILES - 1} file(s) written, 0 unchanged, 0 deleted`), real.stdout);
    assert.match(fs.readFileSync(path.join(sb.still, 'run-hidden.js'), 'utf8'), new RegExp(`^var NODE = ${JSON.stringify(process.execPath).replace(/\\/g, '\\\\').replace(/\./g, '\\.')};$`, 'm'));
    assert.equal(fs.existsSync(sb.lad), false);
  } finally {
    cleanup(sb.dir);
  }
  assert.equal(fs.existsSync(sb.dir), false, 'sandbox removed');
});
