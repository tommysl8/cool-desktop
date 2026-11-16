// PCD.host (src/shared/pcd-host.js) in Node with a fake clock.
//   The frame loop: 30 engine steps per second at 30 and 15 fps on 60, 120 and 144 Hz displays with vsync jitter (one
//   step per frame at 30 fps, never 0-then-2), pause leaves no timer and no animation frame, a resume never
//   fast-forwards, still mode, kick and burst. The scene host on the real engine: the first frame at once, the page's
//   painter (no canvas of its own), theme override, surprise (and ending it on request), midnight, shake (one step,
//   debounce, a burst under reduced motion), reduced motion, performance and battery, hidden tabs, the colon and
//   ringing timers, a wall-clock jump under a steady colon, the sun-driven hourFloat, the weather effect hook and the
//   scene's own clock kept off.
process.env.TZ = 'Europe/Berlin';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { loadEngine, ROOT } from './engine-load.mjs';
import { fakeBattery, fakeCanvas, fakeDoc, fakeTime, fakeWin } from './look-host-env.mjs';
import { generate } from '../tools/lib/anchors.mjs';

const { PC, PCD, require } = loadEngine();
for (const f of ['pcd-sun.js', 'pcd-fx.js', 'pcd-weather.js', 'pcd-ascii.js', 'pcd-host.js']) require(path.join(ROOT, 'src', 'shared', f));
PCD.ANCHORS = generate(path.join(ROOT, 'vendor', 'pixelclock'));
const H = PCD.host;
const FORECAST = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests', 'fixtures', 'weather', 'forecast-berlin-c.json'), 'utf8'));

/** A loop on fake time, counting steps per frame. */
function runLoop({ fps = 30, vsyncHz = 120, jitterMs = 0, seconds = 10 } = {}) {
  const env = fakeTime({ vsyncHz, jitterMs });
  const perFrame = [];
  const L = H.loop({ fps, now: env.perfNow, setTimeout: env.setTimeout, clearTimeout: env.clearTimeout,
    requestAnimationFrame: env.requestAnimationFrame, cancelAnimationFrame: env.cancelAnimationFrame,
    step: (n) => perFrame.push(n), draw: (info) => { if (!info.steps) perFrame.push(0); } });
  L.start();
  env.advance(seconds * 1000);
  return { L, env, perFrame, stats: L.stats() };
}

test('loop: exactly 30 steps per second at 30 and 15 fps on 60, 120 and 144 Hz, with vsync jitter', () => {
  for (const vsyncHz of [60, 120, 144]) {
    for (const jitterMs of [0, 1.5]) {
      for (const fps of [30, 15]) {
        const { stats, perFrame } = runLoop({ fps, vsyncHz, jitterMs, seconds: 10 });
        const name = `${fps} fps @ ${vsyncHz} Hz jitter ${jitterMs}`;
        assert.ok(Math.abs(stats.steps - 300) <= 2, `${name}: ${stats.steps} steps in 10 s`);
        assert.ok(Math.abs(stats.frames - fps * 10) <= 2, `${name}: ${stats.frames} frames`);
        const per = fps === 30 ? 1 : 2;
        const odd = perFrame.slice(2).filter((n) => n !== per).length;
        if (vsyncHz !== 144) assert.equal(odd, 0, `${name}: every frame carries ${per} step(s): ${perFrame.join('')}`);
        else assert.ok(odd <= perFrame.length * 0.1, `${name}: ${odd} uneven frames`);
        assert.ok(stats.maxSteps <= 7);
      }
    }
  }
});

test('loop: pause leaves no timer and no animation frame; a resume never fast-forwards', () => {
  const env = fakeTime({ vsyncHz: 120 });
  let steps = 0;
  const L = H.loop({ now: env.perfNow, setTimeout: env.setTimeout, clearTimeout: env.clearTimeout,
    requestAnimationFrame: env.requestAnimationFrame, cancelAnimationFrame: env.cancelAnimationFrame, step: (n) => { steps += n; } });
  L.start();
  env.advance(1000);
  assert.ok(L.pause('lively'));
  assert.ok(!L.pause('lively'), 'counted once');
  assert.ok(L.pause('hidden'));
  assert.deepEqual(env.pending(), { timers: 0, rafs: 0 }, 'nothing armed while paused');
  assert.deepEqual(L.pending(), { timer: false, raf: false });
  const before = env.counts.timers + env.counts.rafs;
  const s0 = steps;
  env.advance(60000);
  assert.equal(env.counts.timers + env.counts.rafs, before, 'not one timer or frame in a minute of pause');
  assert.equal(steps, s0);
  L.resume('lively');
  assert.deepEqual(L.reasons(), ['hidden'], 'still paused for the other reason');
  env.advance(1000);
  assert.equal(steps, s0);
  L.resume('hidden');
  env.advance(100);
  assert.ok(L.stats().sinceResume.maxSteps <= 1, 'the first frame after a resume carries one step, not a minute');
  env.advance(1000);
  assert.ok(Math.abs(steps - s0 - 33) <= 2, 'and the rate continues at 30 per second: ' + (steps - s0));
  L.stop();
  assert.deepEqual(env.pending(), { timers: 0, rafs: 0 });
});

test('loop: a long stall is clamped to 7 steps; still mode arms nothing; kick and burst', () => {
  const env = fakeTime({ vsyncHz: 60 });
  const frames = [];
  const L = H.loop({ now: env.perfNow, setTimeout: env.setTimeout, clearTimeout: env.clearTimeout,
    requestAnimationFrame: env.requestAnimationFrame, cancelAnimationFrame: env.cancelAnimationFrame,
    draw: (info) => { frames.push(info); } });
  L.start();
  env.advance(500);
  // a 2 s stall (the main thread was busy): the next frame steps at most 7 times, then the rate is back to normal
  env.stall(2000);
  env.advance(100);
  assert.equal(L.stats().maxSteps, 7, 'the stall is clamped to 0.25 s = 7 steps');
  const s0 = L.stats().steps;
  env.advance(1000);
  assert.ok(Math.abs(L.stats().steps - s0 - 30) <= 1, 'no catch-up burst after the stall: ' + (L.stats().steps - s0));
  L.setFps(0);
  const n = frames.length;
  env.advance(5000);
  assert.ok(frames.length - n <= 1, 'still: at most the frame already due');
  assert.deepEqual(env.pending(), { timers: 0, rafs: 0 }, 'still mode arms nothing');
  L.kick();
  env.advance(100);
  assert.equal(frames[frames.length - 1].still, true);
  assert.equal(frames[frames.length - 1].kick, true);
  const k = frames.length;
  L.burst(4000, 15);
  env.advance(5000);
  const burst = frames.slice(k);
  assert.ok(burst.length >= 58 && burst.length <= 62, '4 s at 15 fps: ' + burst.length);
  assert.ok(burst.every((f) => f.steps === 2 || f.steps === 1 || f.kick));
  assert.deepEqual(env.pending(), { timers: 0, rafs: 0 }, 'frozen again after the burst');
});

/** A host on fake time. */
function makeHost({ wall, settings = {}, win = fakeWin(), doc = fakeDoc(), vsyncHz = 120, rand, profile = 'newtab', paint } = {}) {
  const env = fakeTime({ wall, vsyncHz });
  const canvas = paint ? undefined : fakeCanvas();
  const events = { view: [], colon: [], ring: [], shake: [], resume: [] };
  const host = H.create({ PC, canvas, paint, doc, win, profile, now: env.now, perfNow: env.perfNow, setTimeout: env.setTimeout,
    clearTimeout: env.clearTimeout, requestAnimationFrame: env.requestAnimationFrame, cancelAnimationFrame: env.cancelAnimationFrame,
    settings, rand,
    on: { view: (v) => events.view.push(v), colon: (c) => events.colon.push(c), ring: (r) => events.ring.push(r),
      shake: (s) => events.shake.push(s), resume: (v) => events.resume.push(v) } });
  return { host, env, canvas, doc, win, events };
}

test('host: the first frame at once, then 30 steps per second at 30 and 15 fps; the canvas gets every frame', () => {
  const { host, env, canvas, events } = makeHost({ wall: new Date(2026, 10, 15, 20, 40, 10).getTime() });
  host.start();
  assert.equal(canvas.ctx.puts, 1, 'the first frame is painted inside start()');
  assert.equal(canvas.width, 64);
  assert.equal(canvas.style.imageRendering, 'pixelated');
  assert.equal(events.view[0].reason, 'start');
  assert.equal(events.view[0].id, 'autumn');
  assert.equal(events.view[0].tag, 'auto');
  const px = canvas.ctx.last.data;
  assert.ok(px.some((v, i) => i % 4 !== 3 && v > 0), 'a real frame');
  host.loop.resetStats();
  env.advance(5000);
  let s = host.stats();
  assert.ok(Math.abs(s.steps - 150) <= 2, '30 fps: ' + s.steps + ' steps');
  assert.ok(Math.abs(s.frames - 150) <= 2);
  assert.ok(canvas.ctx.puts >= 150);
  host.set({ performance: 'on' });
  host.loop.resetStats();
  env.advance(5000);
  s = host.stats();
  assert.ok(Math.abs(s.steps - 150) <= 2, '15 fps: ' + s.steps + ' steps');
  assert.ok(Math.abs(s.frames - 75) <= 2, '15 fps: ' + s.frames + ' frames');
  host.stop();
  assert.deepEqual(env.pending(), { timers: 0, rafs: 0 });
});

test('host: the engine always gets exactly 1/30 s per update', () => {
  const { host, env } = makeHost({ wall: new Date(2026, 10, 15, 12, 0).getTime() });
  const theme = PC.themeById('autumn');
  const orig = theme.create;
  const dts = new Set();
  theme.create = function (rng) {
    const inst = orig.call(this, rng);
    const u = inst.update.bind(inst);
    inst.update = (dt, ctx) => { dts.add(dt); return u(dt, ctx); };
    return inst;
  };
  try {
    host.start();
    env.advance(3000);
    host.set({ performance: 'on' });
    env.advance(3000);
  } finally {
    theme.create = orig;
    host.stop();
  }
  assert.deepEqual([...dts], [1 / 30]);
});

test('host: pause (Lively, hidden) stops every timer and frame; resume re-checks and repaints at once', () => {
  const { host, env, canvas, doc, events } = makeHost({ wall: new Date(2026, 10, 15, 20, 40, 10).getTime() });
  host.start();
  env.advance(2000);
  host.pause('lively');
  assert.deepEqual(host.timers(), { frame: false, raf: false, text: false });
  assert.deepEqual(env.pending(), { timers: 0, rafs: 0 });
  const puts = canvas.ctx.puts;
  env.advance(120000);
  assert.equal(canvas.ctx.puts, puts, 'no frame while paused');
  doc.setHidden(true);
  host.resume('lively');
  assert.deepEqual(env.pending(), { timers: 0, rafs: 0 }, 'still hidden: nothing runs');
  doc.setHidden(false);
  assert.equal(events.resume.length, 1);
  assert.equal(events.view[events.view.length - 1].reason, 'resume');
  env.advance(200);
  assert.ok(canvas.ctx.puts > puts);
  assert.ok(host.stats().sinceResume.maxSteps <= 1, 'no fast-forward after two minutes away');
  host.stop();
});

test('host: a page that starts hidden runs nothing until it is shown', () => {
  const doc = fakeDoc();
  doc.hidden = true;
  const { host, env, canvas } = makeHost({ doc, wall: new Date(2026, 10, 15, 9, 0).getTime() });
  host.start();
  assert.equal(canvas.ctx.puts, 1, 'the first frame is still painted (behind the hidden tab)');
  assert.deepEqual(env.pending(), { timers: 0, rafs: 0 });
  env.advance(5000);
  assert.equal(canvas.ctx.puts, 1);
  doc.setHidden(false);
  env.advance(1000);
  assert.ok(canvas.ctx.puts > 20);
  host.stop();
});

test('host: theme override, surprise, and the auto theme at midnight', () => {
  let r = 0.42;
  const { host, env, events } = makeHost({ wall: new Date(2026, 10, 22, 23, 59, 50).getTime(), rand: () => r });
  host.start();
  assert.equal(host.view().id, 'autumn');
  env.advance(10500); // just past midnight: 2026-11-23 is thanksgiving
  const v = host.view();
  assert.equal(v.id, 'thanksgiving');
  assert.equal(v.tag, 'auto');
  assert.equal(v.fading, true, 'midnight cross-fades like the clock');
  env.advance(1600);
  assert.equal(host.view().fading, false, 'a 1.5 s cross-fade');
  assert.ok(events.view.some((x) => x.reason === 'fade'), 'the end of the fade is a view change (clock colour, title)');
  host.set({ theme: 'winter' });
  assert.deepEqual([host.view().id, host.view().tag], ['winter', 'pinned']);
  host.set({ theme: 'no-such-theme' });
  assert.deepEqual([host.view().id, host.view().tag], ['thanksgiving', 'auto'], 'an unknown id means auto');
  const id = host.surprise();
  assert.notEqual(id, 'thanksgiving');
  assert.deepEqual([host.view().id, host.view().tag], [id, 'surprise']);
  r = 0.99;
  const id2 = host.surprise();
  assert.notEqual(id2, id, 'a surprise is always another theme');
  host.set({ reducedMotion: 'on' }); // one frame a minute keeps a simulated day short
  env.advance(24 * 3600000);
  assert.equal(host.view().tag, 'surprise', 'the new tab\'s surprise lasts for the tab');
  host.set({ theme: 'auto' });
  assert.equal(host.view().tag, 'auto', 'a theme change ends a surprise');
  host.stop();
});

test('host: set({ surprise: null }) ends a surprise even when the theme asked for is the stored one', () => {
  for (const stored of ['winter', 'auto']) {
    const { host, env, events } = makeHost({ wall: new Date(2026, 10, 15, 12, 0).getTime(), rand: () => 0.5,
      settings: { theme: stored } });
    host.start();
    env.advance(2000);
    const home = [host.view().id, host.view().tag];
    assert.deepEqual(home, stored === 'auto' ? ['autumn', 'auto'] : ['winter', 'pinned'], stored);
    const id = host.surprise({ until: 'tab' });
    env.advance(2000);
    assert.deepEqual([host.view().id, host.view().tag], [id, 'surprise'], stored);
    host.set({ theme: stored });
    env.advance(50);
    assert.deepEqual([host.view().id, host.view().tag], [id, 'surprise'], stored + ': the same theme alone keeps the surprise');
    const n = events.view.length;
    host.set({ theme: stored, surprise: null });
    env.advance(50);
    const v = host.view();
    assert.deepEqual([v.id, v.tag], home, stored + ': the stored theme is back');
    assert.equal(v.fading, true, stored + ': with a cross-fade');
    assert.ok(events.view.slice(n).some((x) => x.tag === home[1] && x.id === home[0]), stored + ': a view event says so');
    env.advance(2000);
    host.set({ surprise: null });
    assert.deepEqual([host.view().id, host.view().tag], home, stored + ': nothing to end is harmless');
    host.stop();
  }
});

test('host: the wallpaper\'s surprise lasts until local midnight', () => {
  const { host, env } = makeHost({ profile: 'wallpaper', wall: new Date(2026, 6, 15, 23, 0).getTime(), rand: () => 0,
    settings: { reducedMotion: 'on' } });
  host.start();
  const id = host.surprise({ until: 'midnight' });
  assert.equal(host.view().id, id);
  env.advance(59 * 60000);
  assert.equal(host.view().tag, 'surprise');
  env.advance(2 * 60000);
  assert.deepEqual([host.view().id, host.view().tag], ['summer', 'auto']);
  host.stop();
});

test('host: shake reaches exactly one engine step; 300 ms debounce; an event each; a 4 s burst under reduced motion', () => {
  const { host, env, events } = makeHost({ wall: new Date(2026, 10, 15, 12, 0).getTime() });
  host.start();
  env.advance(1000);
  assert.equal(host.shake(), true);
  assert.equal(host.shake(), false, 'debounced');
  env.advance(100);
  assert.equal(host.shake(), false, 'still debounced at 100 ms');
  env.advance(250);
  assert.equal(host.shake(), true);
  env.advance(500);
  assert.equal(host.scene.stats().shakes, 2, 'each accepted shake is one step with shake: true');
  assert.deepEqual(events.shake, [undefined, undefined], 'one \'shake\' event per accepted shake (the full-screen scene never nudges)');
  host.set({ reducedMotion: 'on' });
  env.advance(70000);
  const before = host.stats().frames;
  host.shake();
  assert.equal(events.shake.length, 3, 'under reduced motion too');
  env.advance(6000);
  const burst = host.stats().frames - before;
  assert.ok(burst >= 58 && burst <= 63, 'the shake plays 4 s at 15 fps: ' + burst + ' frames');
  assert.deepEqual(host.timers().raf || host.timers().frame, false, 'then the scene freezes again');
  assert.equal(host.scene.stats().shakes, 3);
  host.stop();
});

test('host: reduced motion is one still frame a minute and on every change; steady colon', () => {
  const win = fakeWin({ reduce: true });
  const { host, env, events } = makeHost({ win, wall: new Date(2026, 10, 15, 20, 40, 30).getTime() });
  host.start();
  assert.equal(host.view().reduced, true, 'prefers-reduced-motion with the setting on auto');
  assert.equal(host.view().fps, 0);
  host.loop.resetStats();
  env.advance(3 * 60000);
  const s = host.stats();
  assert.ok(s.frames >= 3 && s.frames <= 4, 'about one frame a minute: ' + s.frames);
  assert.equal(events.colon.length, 0, 'the colon never blinks');
  assert.equal(host.view().colon, true);
  assert.equal(host.ctx().ms, 0, 'the scene\'s own colon stays lit too');
  const f = host.stats().frames;
  host.set({ theme: 'winter' });
  env.advance(50);
  assert.equal(host.stats().frames, f + 1, 'a change paints one frame');
  assert.equal(host.view().fading, false, 'no cross-fade under reduced motion');
  win.setReduce(false);
  assert.equal(host.view().reduced, false, 'follows the media query live');
  assert.equal(host.view().fps, 30);
  host.set({ reducedMotion: 'on' });
  assert.equal(host.view().fps, 0, 'the setting wins over the media query');
  host.stop();
});

test('host: the colon blinks at 1 Hz at 30 fps, steady in performance mode; the ringing pulse at 2 Hz', () => {
  const { host, env, events } = makeHost({ wall: new Date(2026, 10, 15, 20, 40, 0, 100).getTime() });
  host.start();
  env.advance(5000);
  assert.ok(events.colon.length >= 9 && events.colon.length <= 11, 'about 10 toggles in 5 s: ' + events.colon.length);
  assert.ok(events.colon.every((v, i) => i === 0 || v !== events.colon[i - 1]), 'alternating');
  host.set({ performance: 'on' });
  const n = events.colon.length;
  env.advance(5000);
  assert.ok(events.colon.length - n <= 1, 'steady in performance mode');
  assert.equal(host.view().colon, true);
  host.set({ performance: 'off' });
  host.ringing(true);
  const r = events.ring.length;
  env.advance(2000);
  assert.ok(events.ring.length - r >= 7 && events.ring.length - r <= 9, 'ring toggles at 2 Hz: ' + (events.ring.length - r));
  host.ringing(false);
  assert.equal(events.ring[events.ring.length - 1], false);
  host.set({ reducedMotion: 'on' });
  host.ringing(true);
  const q = events.ring.length;
  env.advance(2000);
  assert.equal(events.ring.length, q, 'steady ring under reduced motion');
  assert.equal(host.view().ring, true);
  host.stop();
});

test('host: with a steady colon a wall-clock jump shows within 10 s; nothing runs while hidden or paused', () => {
  for (const settings of [{ reducedMotion: 'on' }, { performance: 'on' }]) {
    const name = Object.keys(settings)[0];
    const { host, env, events, doc } = makeHost({ wall: new Date(2026, 10, 15, 1, 30, 5).getTime(), settings });
    host.start();
    env.advance(3000);
    assert.equal(host.view().steady, true, name + ': a steady colon');
    // the clock jumps 3 hours (a time sync, a resume from sleep)
    const n = events.view.length;
    const jump = new Date(2026, 10, 15, 4, 31, 0).getTime();
    env.setWall(jump);
    env.advance(11000);
    const v = events.view.slice(n).find((x) => x.reason === 'minute');
    assert.ok(v, name + ': a minute view after the jump');
    assert.deepEqual([v.hours, v.minutes], [4, 31], name);
    assert.ok(v.now - jump <= 10000 + 10, `${name}: shown ${v.now - jump} ms after the jump`);
    if (name === 'reducedMotion') {
      // a still scene: the text timer is about all that runs, six times a minute
      const t0 = env.counts.timers;
      env.advance(60000);
      assert.ok(env.counts.timers - t0 <= 8, `${name}: ${env.counts.timers - t0} timers in a minute`);
    }
    doc.setHidden(true);
    assert.deepEqual(host.timers(), { frame: false, raf: false, text: false }, name + ': hidden');
    assert.deepEqual(env.pending(), { timers: 0, rafs: 0 }, name + ': hidden');
    const t1 = env.counts.timers + env.counts.rafs;
    env.advance(60000);
    assert.equal(env.counts.timers + env.counts.rafs, t1, name + ': not one timer in a hidden minute');
    doc.setHidden(false);
    assert.equal(host.timers().text, true, name + ': shown again, the text timer is back');
    host.pause('lively');
    assert.equal(host.timers().text, false, name + ': paused, no text timer');
    host.stop();
  }
});

test('host: performance auto follows the battery', async () => {
  const battery = fakeBattery(true);
  const { host, env } = makeHost({ win: fakeWin({ battery }), wall: new Date(2026, 10, 15, 12, 0).getTime() });
  host.start();
  await new Promise((r) => setImmediate(r));
  assert.equal(host.view().fps, 30);
  battery.set(false);
  assert.equal(host.view().perf, true);
  assert.equal(host.view().fps, 15, 'on battery: 15 fps');
  battery.set(true);
  assert.equal(host.view().fps, 30);
  host.set({ performance: 'off' });
  battery.set(false);
  assert.equal(host.view().fps, 30, 'performance off ignores the battery');
  env.advance(100);
  host.stop();
});

test('host: real sun times drive hourFloat through PCD.sun; the view carries the phase, curve and labels', () => {
  // the Berlin fixture's day is 2026-11-15: sunrise 07:28, sunset 16:13 (TZ Europe/Berlin)
  const wall = new Date(2026, 10, 15, 16, 0).getTime();
  const { host, env } = makeHost({ wall });
  host.start();
  const data = PCD.weather.parseForecast(FORECAST, { units: 'C' });
  host.setWeather(data);
  const v = host.view();
  assert.equal(v.source, 'sun');
  assert.ok(Math.abs(v.sun.rise - 7.47) < 0.02 && Math.abs(v.sun.set - 16.22) < 0.02, JSON.stringify(v.sun));
  const sun = PCD.sun.today(data, new Date(wall));
  const want = PCD.sun.remap(16, sun, PCD.sun.anchor('autumn'));
  assert.ok(Math.abs(host.ctx().hourFloat - want) < 1e-6, 'ctx.hourFloat is the remapped hour');
  assert.equal(host.ctx().hours, 16, 'the drawn time stays real');
  assert.equal(v.phase, 'sunset');
  assert.equal(v.curve.length, 48);
  assert.deepEqual(PCD.ascii.stripLabels(v.sun, false), { rise: '7:28', set: '4:13' });
  host.set({ sunTimes: false });
  assert.equal(host.view().sun, null, 'sun times off: the strip has no labels');
  assert.equal(host.view().source, 'theme');
  assert.ok(Math.abs(host.ctx().hourFloat - 16) < 0.01);
  host.set({ sunTimes: true });
  host.setSun({ rise: 6.5, set: 18.5 });
  assert.ok(Math.abs(host.view().sun.rise - 6.5) < 1e-9, 'an explicit sun overrides the forecast');
  env.advance(100);
  host.stop();
});

test('host: the weather effect hook (PCD.fx through PCD.hook.before); weatherFx off clears it', () => {
  const { host, env } = makeHost({ wall: new Date(2026, 10, 15, 12, 0).getTime() });
  host.start();
  const data = { ...PCD.weather.parseForecast(FORECAST, { units: 'C' }), kind: 'rain', code: 63, precip: 2 };
  host.setWeather(data);
  assert.equal(typeof PCD.hook.before, 'function');
  env.advance(1000);
  host.set({ weatherFx: false });
  assert.equal(PCD.hook.before, null);
  host.set({ weatherFx: true });
  assert.equal(typeof PCD.hook.before, 'function');
  host.setWeather(null);
  assert.equal(PCD.hook.before, null, 'no data: no effect');
  host.stop();
});

test('host: the scene\'s own clock stays off (PCD.hook.mode \'none\' on every frame: the console shows the clock)', () => {
  const { host, env } = makeHost({ wall: new Date(2026, 10, 15, 12, 0).getTime() });
  PCD.hook.mode = 'device';
  host.start();
  assert.equal(PCD.hook.mode, 'none', 'from the first frame');
  PCD.hook.mode = 'device';
  env.advance(100);
  assert.equal(PCD.hook.mode, 'none', 'every frame draws without it');
  host.set({ sceneClock: 'device' });
  env.advance(100);
  assert.equal(PCD.hook.mode, 'none', 'set() ignores sceneClock');
  host.stop();
  assert.equal(H.placeCanvas, undefined, 'the scene layer places its own canvases');
  assert.equal(host.place, undefined);
});

test('host: with paint, every frame goes through the page\'s painter and the host makes no canvas of its own', () => {
  const calls = [];
  const { host, env } = makeHost({ wall: new Date(2026, 10, 15, 20, 40).getTime(), paint: (fb, info) => calls.push({ fb, info }) });
  assert.equal(host.canvas, null, 'no detached canvas');
  host.start();
  assert.equal(calls.length, 1, 'the first frame inside start()');
  assert.deepEqual(calls[0].info, { first: true, fading: false });
  assert.equal(typeof calls[0].fb.px, 'object', 'the engine\'s PC.Canvas');
  env.advance(1000);
  assert.ok(calls.length >= 29 && calls.length <= 32, '30 fps through the painter: ' + calls.length);
  assert.ok(calls.slice(1).every((c) => c.info.first === false));
  host.surprise();
  env.advance(200);
  assert.equal(calls[calls.length - 1].info.fading, true, 'the painter hears the cross-fade');
  host.stop();
});

test('host: keys and pointer shake the scene (never with Ctrl, Alt or Meta, never in form fields, never Tab / Esc)', () => {
  const { host, env, events, doc } = makeHost({ wall: new Date(2026, 10, 15, 12, 0).getTime() });
  host.start();
  const el = { l: {}, addEventListener(t, f) { this.l[t] = f; }, removeEventListener(t) { delete this.l[t]; } };
  const detach = host.attach(el, { keys: true });
  const key = (k, extra = {}) => { env.advance(400); doc.fire('keydown', { key: k, target: { nodeType: 1, tagName: 'BODY' }, ...extra }); };
  const n0 = events.shake.length;
  key('a');
  key(' ');
  key('Enter');
  assert.equal(events.shake.length - n0, 3);
  key('a', { ctrlKey: true });
  key('a', { altKey: true });
  key('a', { metaKey: true });
  key('Tab');
  key('/');
  key('Escape');
  key('Shift');
  key('a', { repeat: true });
  key('a', { target: { nodeType: 1, tagName: 'INPUT' } });
  key('x', { target: { nodeType: 1, tagName: 'SPAN', parentElement: { nodeType: 1, tagName: 'SELECT' } } });
  key('x', { target: { nodeType: 1, tagName: 'DIV', isContentEditable: true } });
  assert.equal(events.shake.length - n0, 3, 'none of those shook');
  env.advance(400);
  el.l.pointerdown({ button: 0 });
  assert.equal(events.shake.length - n0, 4, 'pointerdown on the window shakes');
  env.advance(400);
  el.l.pointerdown({ button: 2 });
  assert.equal(events.shake.length - n0, 4, 'not the right button');
  detach();
  env.advance(400);
  key('a');
  assert.equal(events.shake.length - n0, 4, 'detached');
  host.stop();
});

test('host: the view: the clock colour from the hook, night amount, test hooks', () => {
  const { host, env } = makeHost({ wall: new Date(2026, 10, 15, 21, 0).getTime() });
  host.start();
  env.advance(2000);
  const v = host.view();
  assert.equal(v.clockColor, PCD.ascii.clockColor(PCD.hook.colors.clock));
  assert.ok(PCD.ascii.contrast(v.clockColor, PCD.ascii.TOKENS.bg) >= 4.5);
  assert.equal(v.night, 1, '21 h: full night');
  assert.equal(v.name, 'Autumn forest');
  const st = host.stats();
  for (const k of ['frames', 'steps', 'fps', 'p95', 'paused', 'reasons', 'timers', 'engine']) assert.ok(k in st, k);
  host.stop();
  assert.deepEqual(host.timers(), { frame: false, raf: false, text: false });
});

test('watchViewport: resize and DPR changes (a window moved to another monitor)', () => {
  const l = {};
  const mqs = [];
  const win = { innerWidth: 1280, innerHeight: 800, devicePixelRatio: 2,
    addEventListener(t, f) { l[t] = f; }, removeEventListener(t) { delete l[t]; },
    matchMedia(q) { const m = { q, f: null, addEventListener(t, f) { this.f = f; }, removeEventListener() { this.f = null; } }; mqs.push(m); return m; } };
  const seen = [];
  const off = H.watchViewport(win, (v) => seen.push(v));
  assert.equal(mqs[0].q, '(resolution: 2dppx)');
  win.innerWidth = 1600;
  l.resize();
  win.devicePixelRatio = 1.5;
  mqs[0].f();
  assert.equal(mqs[1].q, '(resolution: 1.5dppx)', 're-armed for the new ratio');
  assert.deepEqual(seen, [{ cssW: 1600, cssH: 800, dpr: 2 }, { cssW: 1600, cssH: 800, dpr: 1.5 }]);
  off();
  assert.equal(l.resize, undefined);
});
