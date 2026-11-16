// Still inputs and guards: still.json, --detect, the Lively skip, A/B pictures, skip-if-same, cleanup, the log (no
// city, no coordinates), weather through a fake fetch (Berlin) and offline, the --at argument. A child_process spy
// proves that no PowerShell ever starts in these runs; the setter is always a stub here.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { main, parseArgs, noWallpaper } from '../src/still/pcd-still.mjs';
import * as envLib from '../src/still/lib/env.mjs';
import { collect, engineDeps, fakeFetch, rm, safeEnv, spyChildProcess, STILL, TASKLIST_LIVELY, TASKLIST_PLAIN, tempHome } from './still-helpers.mjs';

const AT = '2026-11-15T16:30';
const BASE = { width: 1280, height: 800, scale: 1, theme: 'auto', clock24: false, units: 'C', city: '', sunTimes: true, weather: true, weatherFx: true, taskbar: 56 };

function deps(extra = {}) {
  return {
    env: safeEnv(),
    stillDir: STILL,
    engine: engineDeps(),
    tasklist: () => TASKLIST_PLAIN,
    fetch: () => { throw new Error('no network in tests'); },
    runSetter: () => { throw new Error('the setter must not run in this test'); },
    ...collect(),
    ...extra,
  };
}

/** A setter stub that records its calls and answers like a successful run. */
function setterStub(ok = true) {
  const calls = [];
  const fn = (file, opts) => {
    calls.push({ file, opts });
    return ok ? { status: 0, ok: true, stdout: `set: ${file}\n`, stderr: '', error: null } : { status: 3, ok: false, stdout: 'error: SystemParametersInfoW failed, Win32 error 5\n', stderr: '', error: null };
  };
  fn.calls = calls;
  return fn;
}

test('still.json: defaults, validation, unknown keys, BOM and broken JSON', () => {
  const n = envLib.normalizeStill({ width: 2560, height: 1600, scale: 2, theme: 'winter', units: 'C', city: ' Berlin ', taskbar: true, extra: 1 });
  assert.equal(n.config.width, 2560);
  assert.equal(n.config.scale, 2);
  assert.equal(n.config.theme, 'winter');
  assert.equal(n.config.city, 'Berlin');
  assert.equal(n.config.taskbar, 56);
  assert.deepEqual(n.problems, ['extra: unknown key ignored']);
  const bad = envLib.normalizeStill({ width: 10, height: 'x', units: 'K', taskbar: 999, scale: 9 });
  assert.equal(bad.config.width, 0);
  assert.equal(bad.config.units, 'F');
  assert.equal(bad.config.taskbar, 56);
  assert.equal(bad.config.scale, 1);
  assert.deepEqual(bad.problems.map((p) => p.split(':')[0]), ['width', 'height', 'scale', 'units', 'taskbar']);
  assert.ok(bad.problems.every((p) => !p.includes('Berlin')));
  const half = envLib.normalizeStill({ width: 1920 });
  assert.equal(half.config.width, 0, 'width without height: detect instead');
  const dir = tempHome();
  try {
    const f = path.join(dir, 'still.json');
    assert.equal(envLib.readStill(f).exists, false);
    // a byte order mark is skipped with a note: UTF-8's, and UTF-16 LE's (Windows PowerShell 5.1's `>`)
    const sample = '{"width":1920,"height":1080,"city":"Berlin","units":"C"}';
    fs.writeFileSync(f, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(sample)]));
    let r = envLib.readStill(f);
    assert.deepEqual(r.problems, ['starts with a BOM; read anyway']);
    assert.deepEqual([r.config.width, r.config.height, r.config.city, r.config.units], [1920, 1080, 'Berlin', 'C'], 'its values are read');
    fs.writeFileSync(f, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(sample, 'utf16le')]));
    r = envLib.readStill(f);
    assert.deepEqual(r.problems, ['is UTF-16 with a BOM; read anyway']);
    assert.deepEqual([r.config.width, r.config.city, r.config.units], [1920, 'Berlin', 'C']);
    // broken files: the defaults and a problem with the line and column, never a quote of the file (it may name a city)
    fs.writeFileSync(f, '{"width":1920,');
    assert.match(envLib.readStill(f).problems[0], /^not valid JSON \(.* at line 1, column 15\); using defaults$/);
    fs.writeFileSync(f, '{\n  "city": "Berlin",\n  "units": "C",\n}\n');
    assert.match(envLib.readStill(f).problems[0], /^not valid JSON \(.* at line 4, column 1\); using defaults$/);
    for (const text of ['{"city": Berlin}', '{"city": "Berlin"', '']) {
      fs.writeFileSync(f, text);
      const p = envLib.readStill(f);
      assert.equal(p.config.city, '', JSON.stringify(text));
      assert.equal(p.problems.length, 1);
      assert.match(p.problems[0], /^not valid JSON \(.+\); using defaults$/);
      assert.ok(!p.problems[0].includes('Berlin') && !p.problems[0].includes('"'), `${p.problems[0]} quotes the file`);
    }
    for (const text of ['null', '[]', '"Berlin"', '7']) {
      fs.writeFileSync(f, text);
      assert.deepEqual(envLib.readStill(f).problems, ['not an object; using defaults'], text);
    }
    fs.writeFileSync(f, JSON.stringify({ width: 1920, height: 1080, city: 'Berlin', nope: 1 }));
    assert.deepEqual(envLib.readStill(f).problems, ['nope: unknown key ignored']);
    const saved = envLib.updateStill(f, { width: 2560, height: 1600, scale: 2 });
    assert.equal(saved.city, 'Berlin');
    const text = fs.readFileSync(f, 'utf8');
    assert.ok(!text.startsWith('﻿') && !text.includes('\r'), 'UTF-8 without BOM, LF');
    assert.equal(JSON.parse(text).width, 2560);
    assert.deepEqual(Object.keys(JSON.parse(text)), Object.keys(envLib.STILL_DEFAULTS), 'the next --detect writes it without the unknown key');
  } finally {
    rm(dir);
  }
});

test('--detect parses Win32_VideoController and AppliedDPI output (stubbed) and saves still.json', async () => {
  const one = envLib.parseDetect('{"controllers":[{"name":"Intel(R) Graphics","width":2560,"height":1600}],"appliedDpi":192}');
  assert.deepEqual([one.width, one.height, one.scale, one.dpi], [2560, 1600, 2, 192]);
  const hybrid = envLib.parseDetect('{"controllers":[{"name":"NVIDIA","width":null,"height":null},{"name":"Intel","width":3840,"height":2160}],"appliedDpi":144}');
  assert.deepEqual([hybrid.width, hybrid.height, hybrid.scale], [3840, 2160, 1.5]);
  const single = envLib.parseDetect('{"controllers":{"name":"Intel","width":1920,"height":1080},"appliedDpi":null}');
  assert.deepEqual([single.width, single.height, single.scale, single.dpi], [1920, 1080, 1, null]);
  assert.throws(() => envLib.parseDetect('not json'), /no JSON/);
  assert.throws(() => envLib.detectDisplay({ runPowerShell: () => ({ status: 0, stdout: '{"controllers":[],"appliedDpi":96}', stderr: '' }) }), /no video controller/);
  assert.match(envLib.DETECT_SCRIPT, /Win32_VideoController/);
  assert.match(envLib.DETECT_SCRIPT, /AppliedDPI/);
  assert.doesNotMatch(envLib.DETECT_SCRIPT, /Forms|Set-ItemProperty|New-ItemProperty|Remove-Item/i);
  const dir = tempHome({ city: 'Berlin', units: 'C' });
  try {
    const scripts = [];
    const d = deps({ runPowerShell: (s) => { scripts.push(s); return { status: 0, stdout: '{"controllers":[{"name":"Intel(R) Graphics","width":2560,"height":1600}],"appliedDpi":192}', stderr: '' }; } });
    assert.equal(await main(['--detect', '--home', dir], d), 0, d.text());
    assert.equal(scripts.length, 1);
    const saved = JSON.parse(fs.readFileSync(path.join(dir, 'still.json'), 'utf8'));
    assert.deepEqual([saved.width, saved.height, saved.scale, saved.city], [2560, 1600, 2, 'Berlin']);
    assert.match(d.out.join('\n'), /detected 2560x1600 at scale 2/);
    const noHome = deps({ runPowerShell: () => { throw new Error('must not run'); } });
    assert.equal(await main(['--detect'], noHome), 2, 'no still.json beside the source: refuses');
  } finally {
    rm(dir);
  }
});

test('--detect never overwrites a still.json it cannot read; it keeps a BOM file\'s settings and saves them without the BOM', async () => {
  const dir = tempHome();
  const f = path.join(dir, 'still.json');
  const screen = { status: 0, stdout: '{"controllers":[{"name":"Intel(R) Graphics","width":2560,"height":1600}],"appliedDpi":192}', stderr: '' };
  try {
    // a trailing comma: refused before the screen query, the file left byte for byte
    const broken = Buffer.from('{\n  "city": "Berlin",\n  "units": "C",\n  "theme": "winter",\n  "side": "left",\n}\n');
    fs.writeFileSync(f, broken);
    const queries = [];
    const d = deps({ runPowerShell: (s) => { queries.push(s); return screen; } });
    assert.equal(await main(['--detect', '--home', dir], d), 1, d.text());
    assert.match(d.err.join('\n'), /^pcd-still: still\.json cannot be read: not valid JSON \(.* at line 6, column 1\); fix it, then run --detect again$/);
    assert.ok(!d.text().includes('Berlin'), 'the message never quotes the file');
    assert.ok(fs.readFileSync(f).equals(broken), 'still.json is unchanged');
    assert.equal(queries.length, 0, 'no screen query');
    assert.throws(() => envLib.updateStill(f, { width: 1920, height: 1080 }), /cannot be read/);
    assert.ok(fs.readFileSync(f).equals(broken));
    for (const text of ['{"city": Berlin}', 'null']) {
      fs.writeFileSync(f, text);
      const d2 = deps({ runPowerShell: () => screen });
      assert.equal(await main(['--detect', '--home', dir], d2), 1, text);
      assert.match(d2.err.join('\n'), /cannot be read: (not valid JSON \(unexpected character\)|not an object); fix it/);
      assert.equal(fs.readFileSync(f, 'utf8'), text);
    }
    // a BOM: read anyway (with a note), the settings kept, saved without the BOM
    fs.writeFileSync(f, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(JSON.stringify({ city: 'Berlin', units: 'C', theme: 'winter', side: 'left' }))]));
    const d3 = deps({ runPowerShell: () => screen });
    assert.equal(await main(['--detect', '--home', dir], d3), 0, d3.text());
    assert.match(d3.out.join('\n'), /^still\.json: starts with a BOM; read anyway$/m);
    const raw = fs.readFileSync(f);
    assert.ok(!(raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf), 'saved without the BOM');
    const saved = JSON.parse(raw.toString('utf8'));
    assert.deepEqual([saved.city, saved.units, saved.theme, saved.side, saved.width, saved.height, saved.scale], ['Berlin', 'C', 'winter', 'left', 2560, 1600, 2]);
  } finally {
    rm(dir);
  }
});

test('the scheduled run writes every still.json problem to still.log, never the city', async () => {
  const dir = tempHome();
  const f = path.join(dir, 'still.json');
  const log = path.join(dir, 'out', 'still.log');
  const spy = spyChildProcess();
  try {
    fs.writeFileSync(f, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(JSON.stringify({ ...BASE, city: '', colour: 'red' }))]));
    const setter = setterStub();
    const d = deps({ env: safeEnv({ PCD_NO_WALLPAPER: undefined }), runSetter: setter });
    assert.equal(await main(['--set', '--home', dir, '--at', AT], d), 0, d.text());
    assert.equal(setter.calls.length, 1);
    let text = fs.readFileSync(log, 'utf8');
    assert.match(text, /still\.json: starts with a BOM; read anyway\n/);
    assert.match(text, /still\.json: colour: unknown key ignored\n/);
    // unreadable: the defaults (the screen detected again), the reason in the log, the city nowhere
    fs.writeFileSync(f, '{"city": Berlin, "units": "C", "width": 1280, "height": 800}');
    const d2 = deps({ env: safeEnv({ PCD_NO_WALLPAPER: undefined }), runSetter: setter, runPowerShell: () => ({ status: 0, stdout: '{"controllers":[{"name":"Intel","width":1280,"height":800}],"appliedDpi":96}', stderr: '' }) });
    assert.equal(await main(['--set', '--home', dir, '--at', '2026-11-15T17:00'], d2), 0, d2.text());
    text = fs.readFileSync(log, 'utf8');
    assert.match(text, /still\.json: not valid JSON \(unexpected character\); using defaults\n/);
    assert.ok(!text.includes('Berlin') && !d2.text().includes('Berlin'), 'the log and the output never hold the city');
    assert.deepEqual(spy.powershell(), []);
  } finally {
    spy.restore();
    rm(dir);
  }
});

test('Lively: tasklist parsing; --set skips while a player runs (no render, no setter); --dry-run renders and reports', async () => {
  assert.deepEqual(envLib.parseTasklistCsv(TASKLIST_LIVELY).slice(-2), ['Lively.exe', 'Lively.Player.WebView2.exe']);
  assert.equal(envLib.isLivelyPlayer('Lively.Player.CefSharp.exe'), true);
  assert.equal(envLib.isLivelyPlayer('Lively.exe'), false);
  assert.deepEqual(envLib.livelyStatus({ tasklist: () => TASKLIST_LIVELY }), { running: true, players: ['Lively.Player.WebView2.exe'] });
  assert.deepEqual(envLib.livelyStatus({ tasklist: () => TASKLIST_PLAIN }), { running: false, players: [] });
  const dir = tempHome(BASE);
  const spy = spyChildProcess();
  try {
    const setter = setterStub();
    const d = deps({ env: safeEnv({ PCD_NO_WALLPAPER: undefined }), tasklist: () => TASKLIST_LIVELY, runSetter: setter });
    assert.equal(await main(['--set', '--home', dir, '--at', AT], d), 0, d.text());
    assert.match(d.out.join('\n'), /skip: a Lively wallpaper is running \(Lively\.Player\.WebView2\.exe\)/);
    assert.equal(setter.calls.length, 0);
    assert.equal(fs.existsSync(path.join(dir, 'out', 'wall-a.png')), false, 'nothing rendered');
    assert.match(fs.readFileSync(path.join(dir, 'out', 'still.log'), 'utf8'), /skip lively/);
    const dry = deps({ tasklist: () => TASKLIST_LIVELY });
    assert.equal(await main(['--dry-run', '--home', dir, '--at', AT], dry), 0, dry.text());
    assert.match(dry.out.join('\n'), /dry run: a Lively wallpaper is running .*--set would skip/);
    assert.ok(fs.existsSync(path.join(dir, 'out', 'wall-a.png')), 'the dry run still renders');
    assert.deepEqual(spy.powershell(), []);
  } finally {
    spy.restore();
    rm(dir);
  }
});

test('--dry-run and PCD_NO_WALLPAPER=1 never start PowerShell (child_process spy) and never call the setter', async () => {
  const dir = tempHome(BASE);
  const spy = spyChildProcess();
  try {
    const d1 = deps();
    d1.env = safeEnv({ PCD_NO_WALLPAPER: undefined });
    delete d1.runSetter; // the real setter: the spy would catch it
    assert.equal(await main(['--dry-run', '--home', dir, '--at', AT], d1), 0, d1.text());
    assert.match(d1.out.join('\n'), /dry run: --set would run powershell\.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand <script/);
    const d2 = deps({ env: safeEnv({ PCD_NO_WALLPAPER: '1' }) });
    delete d2.runSetter;
    assert.equal(await main(['--set', '--home', dir, '--at', '2026-11-15T18:00'], d2), 0, d2.text());
    assert.match(d2.out.join('\n'), /dry run: --set would run/);
    assert.deepEqual(spy.powershell(), [], 'no PowerShell process');
    const state = envLib.readState(path.join(dir, 'out', 'state.json'));
    assert.equal(state.slot, null, 'nothing was set');
    assert.equal(state.setAt, null);
    assert.equal(noWallpaper({ PCD_NO_WALLPAPER: '0' }), false);
    assert.equal(noWallpaper({ PCD_NO_WALLPAPER: 'yes' }), true);
    assert.equal(noWallpaper({}), false);
  } finally {
    spy.restore();
    rm(dir);
  }
});

test('A/B: --set writes wall-a, then wall-b, then wall-a; an identical picture writes and sets nothing; a failed set keeps the state', async () => {
  const dir = tempHome(BASE);
  const spy = spyChildProcess();
  const out = path.join(dir, 'out');
  try {
    const setter = setterStub();
    const run = async (at) => {
      const d = deps({ env: safeEnv({ PCD_NO_WALLPAPER: undefined }), runSetter: setter });
      const code = await main(['--set', '--home', dir, '--at', at], d);
      return { code, d };
    };
    let r = await run('2026-11-15T16:30');
    assert.equal(r.code, 0, r.d.text());
    assert.equal(setter.calls.at(-1).file, path.join(out, 'wall-a.png'));
    assert.equal(setter.calls.at(-1).opts.style, 'Fill');
    let state = envLib.readState(path.join(out, 'state.json'));
    assert.equal(state.slot, 'a');
    assert.equal(state.sha256, envLib.fileSha256(path.join(out, 'wall-a.png')));
    r = await run('2026-11-15T17:00');
    assert.equal(setter.calls.at(-1).file, path.join(out, 'wall-b.png'));
    assert.equal(envLib.readState(path.join(out, 'state.json')).slot, 'b');
    r = await run('2026-11-15T17:30');
    assert.equal(setter.calls.at(-1).file, path.join(out, 'wall-a.png'));
    // the same moment again: identical bytes -> nothing written, nothing set
    const before = fs.statSync(path.join(out, 'wall-b.png')).mtimeMs;
    const n = setter.calls.length;
    r = await run('2026-11-15T17:30');
    assert.equal(r.code, 0);
    assert.match(r.d.out.join('\n'), /unchanged: the picture equals wall-a\.png/);
    assert.equal(setter.calls.length, n, 'no second set');
    assert.equal(fs.statSync(path.join(out, 'wall-b.png')).mtimeMs, before, 'the other slot was not rewritten');
    // a failing setter: exit 1, the state still names the old picture
    const failing = setterStub(false);
    const d = deps({ env: safeEnv({ PCD_NO_WALLPAPER: undefined }), runSetter: failing });
    assert.equal(await main(['--set', '--home', dir, '--at', '2026-11-15T19:00'], d), 1);
    state = envLib.readState(path.join(out, 'state.json'));
    assert.equal(state.slot, 'a');
    assert.equal(failing.calls[0].file, path.join(out, 'wall-b.png'));
    assert.match(fs.readFileSync(path.join(out, 'still.log'), 'utf8'), /set failed/);
    assert.deepEqual(spy.powershell(), []);
    assert.deepEqual(fs.readdirSync(out).filter((f) => f.endsWith('.png')).sort(), ['wall-a.png', 'wall-b.png'], 'only the two pictures are kept');
  } finally {
    spy.restore();
    rm(dir);
  }
});

test('cleanup keeps only wall-a.png and wall-b.png (old pictures and stale temp files go; fresh temp files stay)', () => {
  const dir = tempHome();
  try {
    const out = path.join(dir, 'out');
    fs.mkdirSync(out);
    for (const f of ['wall-a.png', 'wall-b.png', 'wall-old.png', 'wall-20261114.png', 'state.json', 'cache.json', 'still.log', 'notes.txt', 'wall-a.png.1.ab.tmp', 'fresh.tmp']) fs.writeFileSync(path.join(out, f), 'x');
    const old = (Date.now() - 60 * 60 * 1000) / 1000;
    fs.utimesSync(path.join(out, 'wall-a.png.1.ab.tmp'), old, old);
    const removed = envLib.cleanupOut(out);
    assert.deepEqual(removed, ['wall-20261114.png', 'wall-a.png.1.ab.tmp', 'wall-old.png']);
    assert.deepEqual(fs.readdirSync(out).sort(), ['cache.json', 'fresh.tmp', 'notes.txt', 'state.json', 'still.log', 'wall-a.png', 'wall-b.png']);
    assert.deepEqual(envLib.cleanupOut(path.join(dir, 'missing')), []);
  } finally {
    rm(dir);
  }
});

test('the log rotates at 64 KB and never holds the city or coordinates', () => {
  const dir = tempHome();
  try {
    const log = path.join(dir, 'out', 'still.log');
    envLib.appendLog(log, 'first Berlin 52.52437 13.41053', { secrets: ['Berlin', '52.52437', '13.41053'] });
    assert.equal(fs.readFileSync(log, 'utf8'), 'first [private] [private] [private]\n');
    const line = 'x'.repeat(1000);
    for (let i = 0; i < 70; i++) envLib.appendLog(log, line);
    assert.ok(fs.statSync(log).size <= 64 * 1024);
    assert.ok(fs.existsSync(log + '.1'));
    assert.equal(envLib.redact('a\nb', []), 'a b');
  } finally {
    rm(dir);
  }
});

test('weather: a fake fetch (Berlin) feeds the scene, caches in out/cache.json, and neither the log nor the output names the city', async () => {
  const dir = tempHome({ ...BASE, city: 'Berlin', units: 'C' });
  const plain = tempHome({ ...BASE, city: '' });
  try {
    const fetch = fakeFetch();
    const d = deps({ fetch });
    assert.equal(await main(['--dry-run', '--home', dir, '--at', AT], d), 0, d.text());
    assert.equal(fetch.urls.length, 2);
    assert.match(fetch.urls[0], /^https:\/\/geocoding-api\.open-meteo\.com\/v1\/search\?name=Berlin&/);
    assert.match(fetch.urls[1], /^https:\/\/api\.open-meteo\.com\/v1\/forecast\?latitude=52\.52/);
    assert.match(d.out.join('\n'), /weather ok/);
    const cache = JSON.parse(fs.readFileSync(path.join(dir, 'out', 'cache.json'), 'utf8'));
    assert.ok(Object.keys(cache).length >= 1, 'the weather cache is kept in out/cache.json');
    const log = fs.readFileSync(path.join(dir, 'out', 'still.log'), 'utf8');
    for (const secret of ['Berlin', 'berlin', '52.52', '13.41', '13.42']) {
      assert.ok(!log.includes(secret), `log mentions ${secret}`);
      assert.ok(!d.text().includes(secret), `output mentions ${secret}`);
    }
    // a second run inside the hour uses the cache: no request
    const d2 = deps({ fetch });
    assert.equal(await main(['--dry-run', '--home', dir, '--at', '2026-11-15T16:45'], d2), 0);
    assert.equal(fetch.urls.length, 2, 'cached weather, no new request');
    // the weather changes the picture (overcast tint) compared with no weather
    const dp = deps();
    assert.equal(await main(['--dry-run', '--home', plain, '--at', AT], dp), 0);
    const a = fs.readFileSync(path.join(dir, 'out', 'wall-a.png'));
    const b = fs.readFileSync(path.join(plain, 'out', 'wall-a.png'));
    assert.ok(!a.equals(b), 'the weather effect is visible');
    // offline: the run still succeeds without weather
    const off = tempHome({ ...BASE, city: 'Berlin' });
    try {
      const d3 = deps({ fetch: fakeFetch({ mode: 'offline' }) });
      assert.equal(await main(['--dry-run', '--home', off, '--at', AT], d3), 0, d3.text());
      assert.match(d3.out.join('\n'), /weather error/);
    } finally {
      rm(off);
    }
  } finally {
    rm(dir);
    rm(plain);
  }
});

test('an impossible --at is a usage error (exit 2) and renders nothing', async () => {
  const dir = tempHome();
  try {
    const file = path.join(dir, 'x.png');
    const d = deps();
    assert.equal(await main(['--dry-run', '--out', file, '--size', '1920x1080', '--at', '2026-02-30T10:00'], d), 2);
    assert.match(d.err.join('\n'), /^pcd-still: --at: not a valid date and time: 2026-02-30T10:00$/m);
    assert.equal(fs.existsSync(file), false);
  } finally {
    rm(dir);
  }
});

test('arguments: errors, conflicts and the documented flags', () => {
  assert.deepEqual(parseArgs(['--set', '--dry-run']).errors, ['use either --set or --dry-run']);
  assert.match(parseArgs(['--at', '2026-11-15']).errors[0], /date and time/);
  assert.equal(parseArgs(['--at', '2026-11-15T21:00']).at.getHours(), 21);
  // impossible calendar dates and times are refused (Date alone would roll them over into another day)
  for (const v of ['2026-02-30T10:00', '2026-04-31T08:00', '2026-02-29T12:00', '2026-13-01T10:00', '2026-11-00T10:00', '2026-11-15T24:00', '2026-11-15T21:60', '2026-11-15T21:00:60']) {
    assert.deepEqual(parseArgs(['--at', v]).errors, [`--at: not a valid date and time: ${v}`], v);
  }
  const leap = parseArgs(['--at', '2028-02-29T12:00']);
  assert.deepEqual(leap.errors, []);
  assert.deepEqual([leap.at.getFullYear(), leap.at.getMonth(), leap.at.getDate(), leap.at.getHours()], [2028, 1, 29, 12], 'a leap day');
  assert.equal(parseArgs(['--at', '2026-12-31 23:59:59']).at.getDate(), 31);
  assert.deepEqual(parseArgs(['--size', '2560x1600']).size, { width: 2560, height: 1600 });
  assert.match(parseArgs(['--size', '20x20']).errors[0], /--size/);
  assert.match(parseArgs(['--scale', '9']).errors[0], /--scale/);
  assert.match(parseArgs(['--out', 'x.png', '--set']).errors[0], /--out/);
  assert.match(parseArgs(['--bogus']).errors[0], /unknown argument/);
  assert.match(parseArgs(['--home']).errors[0], /needs a value/);
  const ok = parseArgs(['--dry-run', '--side', 'left', '--theme', 'winter', '--quiet']);
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.side, 'left');
  assert.equal(ok.theme, 'winter');
});
