// node --test "tests/fx.test.mjs"
// src/shared/pcd-fx.js: weather kind -> effect family and tint values, a fixed hash per kind at seed
// 1 after 60 steps, identity without weather, the tint and fog math, indoor (no particles, half tint), lightning
// (8-20 s apart, +35 % for 2 steps then +15 % for 2, never under reduced motion), particle counts and wind slant, the
// clock untouched with the real drawClock hook (mode 'device'), and the cost per frame (<= 0.05 ms).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

function findRoot(start) {
  let d = start;
  while (!fs.existsSync(path.join(d, 'src', 'shared', 'pcd-fx.js'))) {
    const up = path.dirname(d);
    if (up === d) throw new Error('project root not found');
    d = up;
  }
  return d;
}
const ROOT = findRoot(path.dirname(fileURLToPath(import.meta.url)));
const require = createRequire(import.meta.url);
const FX = require(path.join(ROOT, 'src', 'shared', 'pcd-fx.js'));
const W = require(path.join(ROOT, 'src', 'shared', 'pcd-weather.js'));
const FIX = path.join(ROOT, 'tests', 'fixtures', 'weather');
const STEP = 1 / 30;

/** A synthetic 64x64 scene (colour gradients), independent of the engine. */
function base() {
  const px = new Uint32Array(4096);
  for (let y = 0; y < 64; y++) {
    for (let x = 0; x < 64; x++) px[y * 64 + x] = (((x * 4) & 255) << 16) | (((y * 4) & 255) << 8) | (((x + y) * 2) & 255);
  }
  return { w: 64, h: 64, px };
}
function solid(c) {
  return { w: 64, h: 64, px: new Uint32Array(4096).fill(c) };
}
function fnv(px) {
  let h = 0x811c9dc5;
  for (let i = 0; i < px.length; i++) {
    const v = px[i];
    for (let s = 0; s < 32; s += 8) {
      h ^= (v >>> s) & 255;
      h = Math.imul(h, 0x01000193) >>> 0;
    }
  }
  return h.toString(16).padStart(8, '0');
}
const rgb = (c) => [(c >>> 16) & 255, (c >>> 8) & 255, c & 255];
function frameAfter(w, steps = 60, seed = 1, cv = base()) {
  const fx = FX.create(seed);
  fx.set(w);
  for (let i = 0; i < steps; i++) fx.step(STEP);
  fx.apply(cv);
  return cv;
}

const KINDS = ['clear', 'partly', 'cloudy', 'fog', 'drizzle', 'freezing', 'rain', 'snow', 'thunder', 'unknown'];

test('effect(): every kind and every WMO code group lands in one of the six families', () => {
  assert.deepEqual(W.KINDS, KINDS);
  const families = { clear: 'clear', unknown: 'clear', partly: 'cloud', cloudy: 'cloud', fog: 'fog', drizzle: 'rain', rain: 'rain', freezing: 'rain', snow: 'snow', thunder: 'storm' };
  for (const k of KINDS) assert.equal(FX.effect(k), families[k], k);
  const byCode = { clear: [0, 1], cloud: [2, 3], fog: [45, 48], rain: [51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82], snow: [71, 73, 75, 77, 85, 86], storm: [95, 96, 97, 99] };
  for (const [fam, codes] of Object.entries(byCode)) for (const c of codes) assert.equal(FX.effect(W.kind(c)), fam, `code ${c}`);
  assert.equal(FX.effect(W.kind(42)), 'clear', 'unknown codes change nothing');
  assert.equal(FX.effect('nope'), 'clear');
});

test('params(): the tint values for every kind', () => {
  const want = {
    clear: [0, 0], unknown: [0, 0], partly: [0.10, 0], cloudy: [0.30, 0.08], fog: [0, 0], drizzle: [0.30, 0.08],
    rain: [0.30, 0.08], freezing: [0.30, 0.08], snow: [0.15, 0], thunder: [0.30, 0.15],
  };
  for (const k of KINDS) {
    const p = FX.params({ kind: k });
    assert.deepEqual([p.sat, p.light], want[k], k);
    assert.equal(p.effect, FX.effect(k));
    assert.equal(p.fog === null, k !== 'fog', k);
    assert.equal(p.flash, k === 'thunder', k);
  }
  assert.deepEqual(FX.params({ kind: 'fog', isDay: true }).fog, { color: FX.FOG_DAY, top: 0.25, bottom: 0.5 });
  assert.equal(FX.params({ kind: 'fog', isDay: false }).fog.color, FX.FOG_NIGHT);
  for (const bad of [null, undefined, {}, { kind: 'hail' }, 'rain']) assert.equal(FX.params(bad), null, JSON.stringify(bad));
});

test('params(): particles per kind, heavy thresholds, wind slant, day and night drops', () => {
  const count = (w) => { const p = FX.params(w).particles; return p ? p.count : 0; };
  assert.equal(count({ kind: 'drizzle' }), 14);
  assert.equal(count({ kind: 'rain', precip: 3.9 }), 30);
  assert.equal(count({ kind: 'rain', precip: 4 }), 44);
  assert.equal(count({ kind: 'rain', code: 65 }), 44, 'heavy rain by code');
  assert.equal(count({ kind: 'freezing' }), 30);
  assert.equal(count({ kind: 'thunder', precip: 5 }), 44);
  assert.equal(count({ kind: 'snow', precip: 1.9 }), 36);
  assert.equal(count({ kind: 'snow', precip: 2 }), 54);
  assert.equal(count({ kind: 'snow', code: 75 }), 54);
  assert.equal(count({ kind: 'snow', code: 86 }), 54);
  for (const k of ['clear', 'partly', 'cloudy', 'fog', 'unknown']) assert.equal(FX.params({ kind: k }).particles, null, k);
  const rain = FX.params({ kind: 'rain' }).particles;
  assert.deepEqual([rain.speed, rain.len, rain.flakes], [[60, 60], 2, 0]);
  assert.deepEqual(FX.params({ kind: 'drizzle' }).particles.speed, [45, 45]);
  assert.deepEqual(FX.params({ kind: 'snow' }).particles.speed, [8, 14]);
  assert.equal(FX.params({ kind: 'freezing' }).particles.flakes, 0.5);
  assert.equal(FX.params({ kind: 'rain', wind: 0 }).particles.slant, 0);
  assert.ok(Math.abs(FX.params({ kind: 'rain', wind: 20 }).particles.slant - 0.3) < 1e-12);
  assert.equal(FX.params({ kind: 'rain', wind: 90 }).particles.slant, 0.6, 'at most 0.6 px per px');
  assert.equal(FX.params({ kind: 'rain', isDay: true }).particles.alpha, 0.55);
  assert.equal(FX.params({ kind: 'rain', isDay: false }).particles.alpha, 0.35);
  assert.equal(FX.params({ kind: 'snow' }).particles.flakeAlpha, 0.85);
});

test('params(): indoor themes get no particles and half the tint; flash only for thunder and not under reduced motion', () => {
  assert.deepEqual(FX.INDOOR, ['christmas']);
  assert.equal(FX.isIndoor('christmas'), true);
  assert.equal(FX.isIndoor('autumn'), false);
  const p = FX.params({ kind: 'thunder', indoor: true, precip: 9 });
  assert.equal(p.particles, null);
  assert.deepEqual([p.sat, p.light], [0.15, 0.075]);
  assert.deepEqual(FX.params({ kind: 'fog', indoor: true }).fog, { color: FX.FOG_DAY, top: 0.125, bottom: 0.25 });
  assert.equal(FX.params({ kind: 'thunder', flash: false }).flash, false);
  assert.equal(FX.params({ kind: 'thunder' }).flash, true);
});

test('input(): from PCD.weather data (wind in km/h), with indoor and reduced motion', () => {
  const data = W.parseForecast(JSON.parse(fs.readFileSync(path.join(FIX, 'forecast-berlin-f.json'), 'utf8')), { units: 'F' });
  assert.deepEqual(FX.input(data, { indoor: true, reducedMotion: true }), {
    kind: 'cloudy', code: 3, precip: 0, wind: 12.4, isDay: false, indoor: true, flash: false,
  });
  assert.deepEqual(FX.input(data), { kind: 'cloudy', code: 3, precip: 0, wind: 12.4, isDay: false, indoor: false, flash: true });
  assert.equal(FX.input(null), null);
  assert.equal(FX.params(FX.input(data)).effect, 'cloud');
});

test('a fixed hash per kind at seed 1 after 60 steps (synthetic scene; clear and unknown leave it untouched)', () => {
  const HASHES = {
    clear: '77b894c5', partly: 'e7df3427', cloudy: '1d61aee6', fog: '90e96173', drizzle: 'ecd5d6a6',
    freezing: 'f8e7017c', rain: '8dadb9cd', snow: '23f5d5fd', thunder: '0a1dfa30', unknown: '77b894c5',
  };
  assert.equal(fnv(base().px), HASHES.clear);
  for (const kind of KINDS) {
    const cv = frameAfter({ kind, precip: 1, wind: 10, isDay: true, indoor: false, flash: true });
    assert.equal(fnv(cv.px), HASHES[kind], kind);
  }
});

test('deterministic per seed; particles differ between seeds; no weather is the identity', () => {
  const w = { kind: 'rain', precip: 2, wind: 15 };
  assert.deepEqual(frameAfter(w, 90, 7).px, frameAfter(w, 90, 7).px);
  assert.notDeepEqual(frameAfter(w, 90, 7).px, frameAfter(w, 90, 8).px);
  const fx = FX.create(3);
  const cv = base();
  fx.apply(cv); // before set()
  assert.equal(fnv(cv.px), fnv(base().px));
  for (const off of [null, undefined, { kind: 'clear' }, { kind: 'unknown' }, { kind: 'nope' }]) {
    const f = FX.create(3);
    f.set({ kind: 'rain' });
    f.set(off); // weather switched off again
    for (let i = 0; i < 10; i++) f.step(STEP);
    const c = base();
    f.apply(c);
    assert.equal(fnv(c.px), fnv(base().px), JSON.stringify(off));
    assert.equal(f.state().particles, 0);
  }
});

test('tint math: saturation and light on one pixel; fog alpha from 0.25 at row 0 to 0.5 at row 63', () => {
  const c = 0xc86432; // 200, 100, 50
  const cv = frameAfter({ kind: 'cloudy' }, 0, 1, solid(c));
  const grey = 200 * 0.299 + 100 * 0.587 + 50 * 0.114;
  const want = [200, 100, 50].map((v) => Math.floor((grey + (v - grey) * 0.7) * 0.92 + 0.5));
  assert.deepEqual(rgb(cv.px[0]), want);
  assert.ok(cv.px.every((v) => v === cv.px[0]));
  const fogDay = frameAfter({ kind: 'fog', isDay: true }, 0, 1, solid(0));
  const [fr, fg, fb] = rgb(FX.FOG_DAY);
  assert.deepEqual(rgb(fogDay.px[0]), [fr, fg, fb].map((v) => Math.floor(v * 0.25 + 0.5)), 'row 0');
  assert.deepEqual(rgb(fogDay.px[63 * 64]), [fr, fg, fb].map((v) => Math.floor(v * 0.5 + 0.5)), 'row 63');
  const fogNight = frameAfter({ kind: 'fog', isDay: false }, 0, 1, solid(0xffffff));
  const [nr] = rgb(FX.FOG_NIGHT);
  assert.equal(rgb(fogNight.px[63 * 64])[0], Math.floor(255 + (nr - 255) * 0.5 + 0.5), 'night fog darkens');
  for (let y = 1; y < 64; y++) assert.ok(rgb(fogDay.px[y * 64])[0] >= rgb(fogDay.px[(y - 1) * 64])[0], 'denser toward the ground');
});

test('indoor: no particle ever drawn (indoor rain equals indoor cloudy); outdoors the drops show', () => {
  const rainIn = FX.create(5);
  const cloudIn = FX.create(5);
  rainIn.set({ kind: 'rain', precip: 8, indoor: true });
  cloudIn.set({ kind: 'cloudy', indoor: true });
  for (let i = 0; i < 120; i++) {
    rainIn.step(STEP);
    cloudIn.step(STEP);
    const a = base();
    const b = base();
    rainIn.apply(a);
    cloudIn.apply(b);
    assert.deepEqual(a.px, b.px, `step ${i}`);
  }
  assert.equal(rainIn.state().particles, 0);
  assert.notDeepEqual(frameAfter({ kind: 'rain', precip: 8 }).px, frameAfter({ kind: 'cloudy' }).px);
});

test('lightning: every 8-20 s, +35 % for 2 steps then +15 % for 2; never with flash off (reduced motion)', () => {
  const fx = FX.create(11);
  fx.set({ kind: 'thunder', precip: 2, isDay: false });
  const black = (f) => { const cv = solid(0); f.apply(cv); return cv.px; };
  // The median red of a frame drawn on black: the flash light (drops are a few dozen pixels at most).
  const medianRed = (px) => Array.from(px, (v) => (v >>> 16) & 255).sort((a, b) => a - b)[2048];
  const starts = [];
  const amounts = [];
  let prev = false;
  for (let i = 0; i < 30 * 120; i++) {
    fx.step(STEP);
    const st = fx.state();
    if (st.flashing) {
      // On black, with the thunder tint (light -15 %), a flash pixel is the flash colour times its amount.
      amounts.push(Math.round((medianRed(black(fx)) / 0xf2) * 100) / 100);
      if (!prev) starts.push(i);
    } else {
      assert.equal(medianRed(black(fx)), 0, `no flash light at step ${i}`);
    }
    prev = st.flashing;
  }
  assert.ok(starts.length >= 5, `flashes in 2 minutes: ${starts.length}`);
  assert.ok(starts[0] / 30 >= 8 && starts[0] / 30 <= 20.1, `first flash after ${starts[0] / 30} s`);
  for (let k = 1; k < starts.length; k++) {
    const gap = (starts[k] - starts[k - 1]) / 30;
    assert.ok(gap >= 8 && gap <= 20.2, `gap ${gap} s`);
  }
  assert.deepEqual(amounts.slice(0, 4), [0.35, 0.35, 0.15, 0.15]);
  assert.equal(amounts.length, starts.length * 4, 'each flash lasts exactly 4 steps');
  const calm = FX.create(11);
  calm.set({ kind: 'thunder', precip: 2, isDay: false, flash: false });
  for (let i = 0; i < 30 * 120; i++) {
    calm.step(STEP);
    assert.equal(calm.state().flashing, false);
  }
  assert.equal(calm.state().nextFlashIn, null);
  const lit = black(calm).filter((v) => v !== 0).length;
  assert.ok(lit > 0 && lit < 200, `only the drops are lit, no flash light (${lit} px)`);
  const indoor = FX.create(11);
  indoor.set({ kind: 'thunder', indoor: true });
  let peak = 0;
  for (let i = 0; i < 30 * 21; i++) {
    indoor.step(STEP);
    peak = Math.max(peak, (black(indoor)[0] >>> 16) & 255);
  }
  assert.equal(peak, Math.floor(0xf2 * 0.175 + 0.5), 'indoors the flash is half as bright');
});

test('particles fall, wrap and slant with the wind; snow drifts', () => {
  const fx = FX.create(2);
  fx.set({ kind: 'rain', precip: 1, wind: 40, isDay: true });
  assert.equal(fx.state().particles, 30);
  const frames = [];
  for (let i = 0; i < 90; i++) {
    fx.step(STEP);
    const cv = solid(0);
    fx.apply(cv);
    frames.push(cv.px);
    assert.ok(cv.px.some((v) => v !== 0), 'drops visible every frame');
  }
  assert.notDeepEqual(frames[0], frames[1], 'they move');
  // Changing only the wind keeps the drops (no reset), changing the intensity respawns them.
  fx.set({ kind: 'rain', precip: 1, wind: 10, isDay: true });
  assert.equal(fx.state().particles, 30);
  fx.set({ kind: 'rain', precip: 9, wind: 10, isDay: true });
  assert.equal(fx.state().particles, 44);
  const snow = FX.create(2);
  snow.set({ kind: 'snow', precip: 0.2 });
  for (let i = 0; i < 30 * 30; i++) snow.step(STEP);
  const cv = solid(0);
  snow.apply(cv);
  const lit = cv.px.filter((v) => v !== 0).length;
  assert.ok(lit >= 20 && lit <= 36, `about 36 flakes in view after 30 s: ${lit}`);
});

test('the clock stays untouched with the real hook (mode device), for every kind including a lightning frame', () => {
  require(path.join(ROOT, 'vendor', 'pixelclock', 'simulator', 'engine.js'));
  const PCD = require(path.join(ROOT, 'src', 'shared', 'pcd-hook.js')) && globalThis.PCD;
  const R = require(path.join(ROOT, 'vendor', 'pixelclock', 'tools', 'render.js'));
  const PC = R.PC;
  assert.ok(PCD.hook.isInstalled(PC), 'hook installed on the vendored engine');
  const ctxAt = (h) => ({ hours: Math.floor(h), minutes: Math.round((h % 1) * 60), seconds: 0, ms: 0, hourFloat: h, year: 2026, month: 11, day: 15, hour12: true, showDate: true, shake: false });
  const draw = (id, h, mode, before) => {
    const ctx = ctxAt(h);
    const inst = PC.themeById(id).create(new PC.Rng(12345));
    for (let i = 0; i < 30; i++) inst.update(STEP, ctx);
    PCD.hook.mode = mode;
    PCD.hook.before = before;
    const cv = new PC.Canvas();
    try {
      inst.draw(cv, ctx);
    } finally {
      PCD.hook.before = null;
      PCD.hook.mode = 'device';
    }
    return cv.px;
  };
  for (const [id, h] of [['autumn', 12.5], ['autumn', 21], ['christmas', 13], ['winter', 7.2]]) {
    const device = draw(id, h, 'device', null);
    const scene = draw(id, h, 'none', null);
    const clockPx = [];
    for (let i = 0; i < 4096; i++) if (device[i] !== scene[i]) clockPx.push(i);
    assert.ok(clockPx.length > 200, `${id}: the clock has pixels (${clockPx.length})`);
    for (const kind of ['partly', 'cloudy', 'fog', 'drizzle', 'freezing', 'rain', 'snow', 'thunder']) {
      const fx = FX.create(1);
      fx.set({ kind, precip: 6, wind: 30, isDay: h > 7 && h < 17, indoor: FX.isIndoor(id) });
      for (let i = 0; i < 60; i++) fx.step(STEP);
      if (kind === 'thunder') for (let i = 0; i < 30 * 21 && !fx.state().flashing; i++) fx.step(STEP);
      const withFx = draw(id, h, 'device', (cv, ctx) => fx.apply(cv, ctx));
      for (const i of clockPx) assert.equal(withFx[i], device[i], `${id} ${h} ${kind}: clock pixel ${i}`);
      assert.ok(withFx.some((v, i) => v !== device[i]), `${id} ${kind}: the scene changed`);
    }
  }
});

test('cost: step + apply <= 0.05 ms per frame for the heaviest cases (after 400 warm-up frames, the fastest of 40 batches of 50)', async () => {
  // The budget is the code's cost, not the scheduler's: node --test runs the files concurrently on a shared machine,
  // so a timed stretch can be preempted or catch a collection. 400 untimed frames let the JIT warm up, then 2000 timed
  // frames run in 40 short batches of 50 (under a millisecond each): the fastest batch is the cost of the code. A case
  // over budget is measured again after a short pause, up to 5 rounds in all, so a burst of load on the machine
  // passes while a real regression stays over budget in every round.
  const BUDGET = 0.05;
  const WARM = 400;
  const BATCHES = 40;
  const PER = 50;
  const ROUNDS = 5;
  const PAUSE_MS = 250;
  const src = base();
  const measure = (w) => {
    const fx = FX.create(9);
    fx.set(w);
    const cv = { w: 64, h: 64, px: new Uint32Array(4096) };
    for (let i = 0; i < WARM; i++) {
      cv.px.set(src.px);
      fx.step(STEP);
      fx.apply(cv);
    }
    let best = Infinity;
    for (let b = 0; b < BATCHES; b++) {
      const t0 = performance.now();
      for (let i = 0; i < PER; i++) {
        cv.px.set(src.px);
        fx.step(STEP);
        fx.apply(cv);
      }
      best = Math.min(best, (performance.now() - t0) / PER);
    }
    return best;
  };
  const cases = [{ kind: 'thunder', precip: 9, wind: 60, isDay: false }, { kind: 'snow', code: 75, wind: 20 }, { kind: 'fog' }];
  const rows = cases.map((w) => ({ w, ms: measure(w), rounds: 1 }));
  for (let round = 1; round < ROUNDS; round++) {
    const slow = rows.filter((r) => r.ms > BUDGET);
    if (!slow.length) break;
    await new Promise((resolve) => setTimeout(resolve, PAUSE_MS));
    for (const r of slow) {
      r.ms = Math.min(r.ms, measure(r.w));
      r.rounds++;
    }
  }
  for (const r of rows) assert.ok(r.ms <= BUDGET, `${r.w.kind}: ${r.ms.toFixed(4)} ms per frame after ${r.rounds} rounds`);
});

test('the shipped file: classic UMD, PCD.fx, ASCII only, no BOM, LF, no Math.random, timers or DOM', () => {
  const buf = fs.readFileSync(path.join(ROOT, 'src', 'shared', 'pcd-fx.js'));
  assert.notDeepEqual([...buf.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  const src = buf.toString('utf8');
  assert.ok(!src.includes('\r'));
  assert.ok(/^[\x0a\x20-\x7e]*$/.test(src), 'ASCII only');
  assert.doesNotMatch(src, /^\s*(import|export)\s/m);
  assert.doesNotMatch(src, /\b(setTimeout|setInterval|requestAnimationFrame|fetch)\s*\(|Math\.random\s*\(|\b(document|window)\./);
  assert.match(src, /module\.exports = api/);
  assert.equal(globalThis.PCD.fx, FX);
});
