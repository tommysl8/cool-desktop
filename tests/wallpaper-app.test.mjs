// node --test "tests/wallpaper-app.test.mjs"
// The wallpaper app's pure rules (src/wallpaper/js/wp-app.js, PCD.wpApp.logic) and the Lively callbacks
// (src/wallpaper/js/lively.js) in a vm: the clock's bell hours for the hourly surprise, the frame-rate policy (battery,
// performance, reduced motion), the taskbar band, the text-tick cadence, theme choice (auto, pinned, surprise until
// midnight), Lively's playback payload, preview query overrides (known settings only); the three callbacks are
// top-level declarations and early calls queue. The page itself (PCD.console mounted, frames, dimming, bands, the
// colon, both column sides) is checked in headless Chrome by tools/test-wallpaper.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);

function findRoot(dir) {
  for (let d = dir; ; d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, 'tools', 'build.mjs'))) return d;
    if (path.dirname(d) === d) throw new Error('repo root not found');
  }
}
const ROOT = findRoot(path.dirname(fileURLToPath(import.meta.url)));
const APP = require(path.join(ROOT, 'src', 'wallpaper', 'js', 'wp-app.js'));
const LG = APP.logic;
const LIVELY = fs.readFileSync(path.join(ROOT, 'src', 'wallpaper', 'js', 'lively.js'), 'utf8');

const at = (h, m = 0, s = 0, day = 15) => new Date(2026, 10, day, h, m, s, 0);

test('in Node the app does not boot: it exports the logic and a no-op handle', () => {
  assert.equal(typeof LG.bellDue, 'function');
  assert.equal(APP.handle('property', ['theme', 1]), undefined);
  assert.equal(globalThis.PCD.wpApp, APP);
});

test('bell hours: on the hour from 10 am through midnight, like the clock\'s bell', () => {
  const bells = [];
  for (let h = 0; h < 24; h++) if (LG.bellHour(h)) bells.push(h);
  assert.deepEqual(bells, [0, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23]);
});

test('hourly surprise: due at hh:00:00-02 in a bell hour, once per hour; never at 9:00 or at hh:00:03', () => {
  const a = LG.bellDue(at(11, 0, 0), '');
  assert.equal(a.due, true);
  assert.equal(LG.bellDue(at(11, 0, 1), a.key).due, false, 'once per hour');
  assert.equal(LG.bellDue(at(11, 0, 2), '').due, true);
  assert.equal(LG.bellDue(at(11, 0, 3), '').due, false, 'late: only the first seconds of the hour');
  assert.equal(LG.bellDue(at(11, 1, 0), '').due, false);
  assert.equal(LG.bellDue(at(9, 0, 0), '').due, false, '9 am is not a bell hour');
  assert.equal(LG.bellDue(at(0, 0, 1, 16), '').due, true, 'midnight rings');
  assert.equal(LG.bellDue(at(23, 59, 58), '').due, false);
  assert.notEqual(LG.bellDue(at(11, 0, 0, 15), '').key, LG.bellDue(at(11, 0, 0, 16), '').key, 'the key includes the date');
});

test('frame rate: 30; 15 in performance mode or on battery with auto; still (0) under reduced motion', () => {
  assert.equal(LG.targetFps({ performance: 'auto', onBattery: false }), 30);
  assert.equal(LG.targetFps({ performance: 'auto', onBattery: true }), 15);
  assert.equal(LG.targetFps({ performance: 'off', onBattery: true }), 30, 'Performance mode on battery unchecked');
  assert.equal(LG.targetFps({ performance: 'on', onBattery: false }), 15);
  assert.equal(LG.targetFps({ performance: 'on', reduced: true }), 0);
  assert.equal(LG.reducedFrom('on', false), true);
  assert.equal(LG.reducedFrom('off', true), false);
  assert.equal(LG.reducedFrom('auto', true), true);
  assert.equal(LG.reducedFrom('auto', false), false);
});

test('text tick: the next half second while the colon blinks, else the next second (debug) or the next 10 s, so a steady colon sees a clock change within seconds; never past a minute', () => {
  const t = Date.UTC(2026, 10, 15, 20, 41, 7, 120);
  assert.equal(LG.STEADY_CHECK_MS, 10000);
  assert.equal(LG.tickDelay(t, { blink: true }), 380 + 3);
  assert.equal(LG.tickDelay(t, { debug: true }), 880 + 3);
  assert.equal(LG.tickDelay(t, {}), 2880 + 3, 'a steady colon: the next 10 s mark, not the next minute');
  const nearMinute = Date.UTC(2026, 10, 15, 20, 41, 59, 900);
  assert.equal(LG.tickDelay(nearMinute, {}), 100 + 3);
  assert.equal(LG.tickDelay(nearMinute, { blink: true }), 100 + 3);
  for (let ms = 0; ms < 60000; ms += 777) assert.ok(LG.tickDelay(t + ms, {}) <= LG.STEADY_CHECK_MS + 3, `at +${ms} ms`);
  // six wake-ups a minute, one of them just after the minute edge
  const wakes = [];
  for (let x = Date.UTC(2026, 10, 15, 20, 41, 0, 3); wakes.length < 6;) {
    x += LG.tickDelay(x, {});
    wakes.push(new Date(x).toISOString().slice(14, 23));
  }
  assert.deepEqual(wakes, ['41:10.003', '41:20.003', '41:30.003', '41:40.003', '41:50.003', '42:00.003']);
});

test('theme choice: a surprise until it expires, then a known pinned theme, else auto by date', () => {
  const ids = ['winter', 'autumn', 'halloween', 'christmas'];
  const autoId = (y, m, d) => (m === 12 ? 'christmas' : 'autumn');
  const now = at(20).getTime();
  assert.deepEqual(LG.themeChoice({ now, ids, theme: 'auto', autoId }), { id: 'autumn', tag: 'auto' });
  assert.deepEqual(LG.themeChoice({ now, ids, theme: 'winter', autoId }), { id: 'winter', tag: 'pinned' });
  assert.deepEqual(LG.themeChoice({ now, ids, theme: 'removedtheme', autoId }), { id: 'autumn', tag: 'auto' }, 'an unknown id means auto');
  const surprise = { id: 'halloween', until: LG.nextMidnight(now) };
  assert.deepEqual(LG.themeChoice({ now, ids, theme: 'winter', surprise, autoId }), { id: 'halloween', tag: 'surprise' });
  assert.deepEqual(LG.themeChoice({ now: surprise.until, ids, theme: 'winter', surprise, autoId }), { id: 'winter', tag: 'pinned' }, 'the surprise ends at midnight');
  assert.equal(new Date(surprise.until).getHours(), 0);
  assert.equal(new Date(surprise.until).getDate(), 16);
  // auto follows the date it is given (y, m 1-12, d)
  assert.deepEqual(LG.themeChoice({ now: new Date(2026, 11, 24, 21).getTime(), ids, theme: 'auto', autoId }), { id: 'christmas', tag: 'auto' });
});

test('the taskbar band: the config taskbarPx (56 by default) while "Keep clear of the taskbar" is on, else 0', () => {
  assert.equal(LG.DEFAULT_TASKBAR, 56);
  assert.equal(LG.taskbarFor(true, { taskbarPx: 56 }), 56);
  assert.equal(LG.taskbarFor(true, { taskbarPx: 48 }), 48);
  assert.equal(LG.taskbarFor(true, {}), 56);
  assert.equal(LG.taskbarFor(true, { taskbarPx: 'tall' }), 56);
  assert.equal(LG.taskbarFor(false, { taskbarPx: 56 }), 0);
});

test('the console, not the app, derives the clock colour, the strip times and the weather age', () => {
  // the console softens the theme's clock colour and formats the strip and the weather block
  for (const k of ['CLOCK_MIX', 'mixRgb', 'contrast', 'clockColour', 'stripTime', 'agoText']) assert.equal(LG[k], undefined, k);
  const src = fs.readFileSync(path.join(ROOT, 'src', 'wallpaper', 'js', 'wp-app.js'), 'utf8');
  assert.match(src, /PCD\.console\.mount\(/);
  assert.match(src, /con\.frame\(/);
  assert.match(src, /con\.colon\(/);
});

test("Lively's playback payload: JSON strings and objects; anything else is unreadable (null)", () => {
  assert.equal(LG.playbackPaused('{"IsPaused":true}'), true);
  assert.equal(LG.playbackPaused('{"IsPaused":false}'), false);
  assert.equal(LG.playbackPaused({ IsPaused: true }), true);
  assert.equal(LG.playbackPaused({ IsPaused: 'false' }), false);
  for (const bad of ['not json', '{}', '{"IsPaused":1}', null, 42, '["IsPaused"]', '{"isPaused":true}']) assert.equal(LG.playbackPaused(bad), null, JSON.stringify(bad));
});

test('query overrides for previews and tests: known settings only (side included), debug=1, URL decoding', () => {
  assert.deepEqual(LG.queryOverrides('?city=Berlin&side=left&debug=1&foo=bar'), { city: 'Berlin', side: 'left', debugOverlay: true });
  assert.deepEqual(LG.queryOverrides('?city=New%20York%2C%20NY&units=C'), { city: 'New York, NY', units: 'C' });
  assert.deepEqual(LG.queryOverrides('?city='), { city: '' });
  assert.deepEqual(LG.queryOverrides(''), {});
  assert.deepEqual(LG.queryOverrides('?toString=1&__proto__=x'), {});
});

test('lively.js: three top-level function declarations; early calls queue in order; then they go straight to the app', () => {
  for (const n of ['livelyPropertyListener', 'livelyWallpaperPlaybackChanged', 'livelySystemInformation']) {
    assert.match(LIVELY, new RegExp(`^function ${n}\\s*\\(`, 'm'), `${n} must be a top-level declaration`);
  }
  assert.doesNotMatch(LIVELY, /^\s*\(function|^\s*export\s|^\s*import\s/m, 'no wrapper, no module syntax');
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(LIVELY, sandbox, { filename: 'lively.js' });
  for (const n of ['livelyPropertyListener', 'livelyWallpaperPlaybackChanged', 'livelySystemInformation']) assert.equal(typeof sandbox[n], 'function');
  vm.runInContext("livelyPropertyListener('theme', 3); livelyWallpaperPlaybackChanged('{\"IsPaused\":true}'); livelyPropertyListener('city', 'Ber'); livelySystemInformation('{}');", sandbox);
  assert.deepEqual(JSON.parse(JSON.stringify(sandbox.__pcdLivelyQueue)), [
    ['property', ['theme', 3]], ['playback', ['{"IsPaused":true}']], ['property', ['city', 'Ber']], ['sysinfo', ['{}']],
  ]);
  // a page whose app never starts: the queue stays bounded (the oldest calls go first)
  vm.runInContext('for (var i = 0; i < 1000; i++) livelyPropertyListener("city", "x" + i);', sandbox);
  assert.equal(sandbox.__pcdLivelyQueue.length, 256);
  assert.deepEqual(JSON.parse(JSON.stringify(sandbox.__pcdLivelyQueue[255])), ['property', ['city', 'x999']]);
  // once PCD.wpApp exists, calls reach its handle() directly
  vm.runInContext("var got = []; var PCD = { wpApp: { handle: function (k, a) { got.push([k, a]); return 'handled'; } } }; livelyPropertyListener('side', 1); livelyWallpaperPlaybackChanged('{\"IsPaused\":false}');", sandbox);
  assert.deepEqual(JSON.parse(JSON.stringify(sandbox.got)), [['property', ['side', 1]], ['playback', ['{"IsPaused":false}']]]);
  assert.equal(sandbox.__pcdLivelyQueue.length, 256, 'nothing more queued');
});
