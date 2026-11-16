// node --test tests/engine-scene.test.mjs
// src/shared/pcd-engine.js: menu, autoId, seed, ctx and the scene (warm-up, shake, cross-fade, seeds, RGBA,
// theme errors, surprise) over the synced engine and over stub themes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadEngine } from './engine-load.mjs';

const { PC, PCD } = loadEngine();
const E = PCD.engine;
const STEP = 1 / 30;
const CTX = E.ctx(new Date(2026, 10, 15, 19, 30, 0, 0), { clock24: false });

/** A fake PixelClock with stub themes (real Canvas, Rng and mix). */
function fakePC(themes, { schedule = () => themes[0].id, holidays = [] } = {}) {
  return {
    Canvas: PC.Canvas, Rng: PC.Rng, mix: PC.mix, themes, HOLIDAYS: holidays,
    themeById: (id) => themes.find((t) => t.id === id) || null,
    themeIdForDate: schedule,
  };
}

/** A stub theme painting one solid colour; it records every update's dt and shake and every draw. */
function solid(id, colour, log = []) {
  return {
    id, name: `${id} stub`, kind: 'season',
    create(rng) {
      const me = { rng, updates: 0, shakes: [], dts: [], draws: 0 };
      log.push(me);
      return {
        update(dt, ctx) { me.updates++; me.dts.push(dt); me.shakes.push(!!ctx.shake); },
        draw(cv) { me.draws++; cv.px.fill(colour); },
      };
    },
  };
}

test('menu: auto, the seasons, the holidays in PC.HOLIDAYS order, then any other theme', () => {
  const ids = E.menu(PC).map((t) => t.id);
  assert.deepEqual(ids, ['auto', 'winter', 'spring', 'summer', 'autumn', ...PC.HOLIDAYS.map((h) => h.id)]);
  assert.deepEqual(E.menu(PC)[0], { id: 'auto', name: 'Auto (by date)', kind: 'auto' });
  assert.deepEqual(E.menu(PC).find((t) => t.id === 'autumn'), { id: 'autumn', name: 'Autumn forest', kind: 'season' });
  assert.deepEqual(E.menu().map((t) => t.id), ids, 'PC defaults to globalThis.PixelClock');
  const extra = solid('zz-extra', 1);
  const fake = fakePC([solid('summer', 1), extra, solid('winter', 2), solid('newyear', 3)], { holidays: [{ id: 'newyear' }, { id: 'missing' }] });
  assert.deepEqual(E.menu(fake).map((t) => t.id), ['auto', 'winter', 'summer', 'newyear', 'zz-extra']);
});

test('autoId: the clock schedule, else the first menu theme', () => {
  assert.equal(E.autoId(PC, 2026, 11, 15), 'autumn');
  assert.equal(E.autoId(PC, 2026, 10, 31), 'halloween');
  const fake = fakePC([solid('summer', 1), solid('winter', 2)], { schedule: () => 'removed-upstream' });
  assert.equal(E.autoId(fake, 2026, 1, 1), 'winter', 'an unknown id falls back to the first menu theme');
  const throwing = fakePC([solid('spring', 1)], { schedule: () => { throw new Error('no table'); } });
  assert.equal(E.autoId(throwing, 2036, 2, 1), 'spring');
});

function fnv1a(text) {
  let h = 0x811c9dc5;
  for (const b of Buffer.from(text, 'utf8')) { h ^= b; h = Math.imul(h, 0x01000193) >>> 0; }
  return h >>> 0;
}

test('seed: FNV-1a (32 bit) of "id:yyyy-mm-dd", zero-padded; 0 becomes 1', () => {
  assert.equal(fnv1a('a'), 0xe40c292c, 'reference vector');
  assert.equal(E.seed('autumn', 2026, 11, 15), fnv1a('autumn:2026-11-15'));
  assert.equal(E.seed('christmas', 2026, 1, 5), fnv1a('christmas:2026-01-05'));
  assert.notEqual(E.seed('autumn', 2026, 11, 15), E.seed('autumn', 2026, 11, 16));
  assert.notEqual(E.seed('autumn', 2026, 11, 15), E.seed('winter', 2026, 11, 15));
  for (let d = 1; d <= 31; d++) assert.ok(E.seed('x', 2026, 1, d) >= 1);
});

test('ctx: the full theme ctx of a local Date; hourFloat may be overridden; clock24 -> hour12 false', () => {
  const d = new Date(2026, 10, 15, 19, 30, 15, 250);
  assert.deepEqual(E.ctx(d), { hours: 19, minutes: 30, seconds: 15, ms: 250, hourFloat: 19 + 30 / 60 + 15 / 3600, year: 2026, month: 11, day: 15, hour12: true, showDate: true, shake: false });
  const c = E.ctx(d, { clock24: true, hourFloat: 17.25 });
  assert.equal(c.hour12, false);
  assert.equal(c.hourFloat, 17.25);
  assert.equal(c.hours, 19, 'the drawn time stays the wall clock');
  assert.equal(E.ctx(d.getTime()).minutes, 30, 'a timestamp works too');
});

test('warm-up: a new instance runs 45 updates of exactly 1/30 s (or opts.warmup) before its first frame', () => {
  for (const warmup of [undefined, 10, 0]) {
    const log = [];
    const scene = E.createScene({ PC: fakePC([solid('a', 0x112233, log)]), warmup });
    assert.equal(scene.want('a'), true);
    scene.frame(CTX);
    const want = warmup === undefined ? 45 : warmup;
    assert.equal(log.length, 1);
    assert.equal(log[0].updates, want, `warmup ${warmup}`);
    assert.equal(log[0].draws, 1);
    assert.ok(log[0].dts.every((dt) => dt === STEP));
    assert.ok(log[0].shakes.every((s) => s === false), 'warm-up never shakes');
    assert.equal(scene.stats().warmupSteps, want);
  }
  assert.equal(E.WARMUP, 45);
  assert.equal(E.STEP, STEP);
});

test('the seed comes from the theme id and the ctx date (the same layout everywhere that day)', () => {
  const log = [];
  const scene = E.createScene({ PC: fakePC([solid('a', 1, log)]), warmup: 0 });
  scene.want('a');
  scene.step(CTX);
  assert.equal(log[0].rng.s, E.seed('a', 2026, 11, 15));
});

test('shake(): the next step carries shake: true, exactly once', () => {
  const log = [];
  const scene = E.createScene({ PC: fakePC([solid('a', 1, log)]), warmup: 5 });
  scene.want('a');
  scene.step(CTX);
  scene.shake();
  scene.shake();
  assert.equal(scene.shakePending, true);
  scene.frame(CTX);
  assert.equal(scene.shakePending, true, 'a frame does not consume it');
  for (let i = 0; i < 4; i++) scene.step(CTX);
  const shakes = log[0].shakes.slice(5);
  assert.deepEqual(shakes, [false, true, false, false, false]);
  assert.equal(scene.stats().shakes, 1);
});

test('cross-fade: 45 steps of smoothstep from the old theme to the new; the old one keeps updating with shake false', () => {
  const log = [];
  const A = 0x000000;
  const B = 0xc8643c;
  const scene = E.createScene({ PC: fakePC([solid('a', A, log), solid('b', B, log)]), warmup: 3 });
  scene.want('a');
  scene.step(CTX);
  assert.equal(scene.frame(CTX).px[0], A);
  scene.want('b');
  scene.shake();
  assert.equal(scene.id, 'b', 'id reports the wanted theme at once');
  scene.step(CTX); // creates b (warm-up 3), then this step: fadeStep 1
  let steps = 1;
  const seen = [];
  for (;;) {
    const px = scene.frame(CTX).px[0];
    const t = scene.fading ? scene.fade : 1;
    seen.push({ steps, fading: scene.fading, px });
    if (scene.fading) assert.equal(px, PC.mix(A, B, t * t * (3 - 2 * t)), `step ${steps}`);
    if (!scene.fading) break;
    scene.step(CTX);
    steps++;
    if (steps > 100) assert.fail('the fade never ended');
  }
  assert.equal(steps, 45, 'the fade ends on the 45th step');
  assert.equal(seen[seen.length - 1].px, B);
  assert.equal(seen[22].steps, 23);
  assert.ok(seen[22].px !== A && seen[22].px !== B, 'blended half way (smoothstep starts and ends slowly)');
  const oldA = log[0];
  const newB = log[1];
  assert.equal(oldA.updates, 3 + 1 + 45, 'the old theme: 3 warm-up updates, 1 step before the switch, 45 while fading');
  assert.ok(oldA.shakes.every((s) => s === false), 'the old theme never shakes');
  assert.deepEqual(newB.shakes.slice(3, 5), [true, false], 'the new theme got the pending shake on its first step');
  assert.equal(E.FADE_STEPS, 45);
  scene.want('a', { fade: false });
  scene.step(CTX);
  assert.equal(scene.fading, false, 'fade: false cuts');
  assert.equal(scene.frame(CTX).px[0], A);
});

test('the same seed gives the same frames: two scenes of every theme agree pixel for pixel', () => {
  for (const id of PC.themes.map((t) => t.id)) {
    const a = E.createScene({ PC });
    const b = E.createScene({ PC });
    a.want(id, { fade: false });
    b.want(id, { fade: false });
    for (let i = 0; i < 20; i++) { a.step(CTX); b.step(CTX); }
    const fa = Array.from(a.frame(CTX).px);
    const fb = Array.from(b.frame(CTX).px);
    assert.deepEqual(fa, fb, id);
  }
});

test('rgba(): R, G, B from 0xRRGGBB and alpha 255, into a given or a new buffer', () => {
  const scene = E.createScene({ PC: fakePC([solid('a', 0x1a2b3c)]), warmup: 0 });
  scene.want('a');
  scene.frame(CTX);
  const u8 = scene.rgba();
  assert.ok(u8 instanceof Uint8ClampedArray);
  assert.equal(u8.length, 64 * 64 * 4);
  assert.deepEqual(Array.from(u8.subarray(0, 8)), [0x1a, 0x2b, 0x3c, 255, 0x1a, 0x2b, 0x3c, 255]);
  const mine = new Uint8Array(16384);
  assert.equal(scene.rgba(mine), mine);
  for (let i = 3; i < mine.length; i += 4) assert.equal(mine[i], 255);
  const real = E.createScene({ PC });
  real.want('autumn');
  real.frame(CTX);
  const px = real.canvas.px;
  const bytes = real.rgba();
  for (let i = 0; i < 4096; i += 97) {
    assert.deepEqual(Array.from(bytes.subarray(i * 4, i * 4 + 4)), [(px[i] >> 16) & 255, (px[i] >> 8) & 255, px[i] & 255, 255]);
  }
});

test('a theme that throws is reported once and the last good frame is kept', () => {
  let n = 0;
  const flaky = {
    id: 'flaky', name: 'Flaky', kind: 'season',
    create() {
      return {
        update() { if (n >= 3) throw new Error('update broke'); },
        draw(cv) { n++; if (n >= 3) throw new Error('draw broke'); cv.px.fill(0x445566 + n); },
      };
    },
  };
  const lines = [];
  const scene = E.createScene({ PC: fakePC([flaky]), warmup: 0, log: (m) => lines.push(m) });
  scene.want('flaky');
  scene.frame(CTX);
  const good = scene.frame(CTX).px[0];
  assert.equal(good, 0x445566 + 2);
  for (let i = 0; i < 5; i++) {
    scene.step(CTX);
    assert.equal(scene.frame(CTX).px[0], good, 'the last good frame stays');
  }
  assert.equal(lines.filter((l) => l.includes('draw broke')).length, 1, 'draw error reported once');
  assert.equal(lines.filter((l) => l.includes('update broke')).length, 1, 'update error reported once');
  assert.equal(scene.stats().errors, 9, '5 failed draws and 4 failed updates');
  const broken = { id: 'broken', name: 'Broken', kind: 'season', create() { throw new Error('create broke'); } };
  const s2 = E.createScene({ PC: fakePC([solid('ok', 0x010203), broken]), warmup: 0, log: (m) => lines.push(m) });
  s2.want('ok');
  s2.frame(CTX);
  s2.want('broken');
  assert.equal(s2.frame(CTX).px[0], 0x010203, 'a theme that cannot be created leaves the old one showing');
});

test('want(): unknown ids are refused; surprise() picks another menu theme and returns it', () => {
  const scene = E.createScene({ PC });
  assert.equal(scene.want('no-such-theme'), false);
  assert.equal(scene.want(42), false);
  assert.equal(scene.id, null);
  scene.want('autumn');
  scene.step(CTX);
  const picks = new Set();
  for (const r of [0, 0.2, 0.5, 0.75, 0.999999]) {
    const id = scene.surprise(() => r);
    assert.notEqual(id, 'auto');
    picks.add(id);
    scene.step(CTX);
    assert.equal(scene.id, id);
  }
  assert.ok(picks.size >= 4, `surprise covers the menu: ${[...picks].join(', ')}`);
  const only = E.createScene({ PC: fakePC([solid('solo', 1)]) });
  only.want('solo');
  assert.equal(only.surprise(() => 0.5), 'solo', 'nothing else to pick');
});

test('with nothing wanted the scene shows the auto theme for the ctx date', () => {
  const scene = E.createScene({ PC });
  scene.frame(E.ctx(new Date(2026, 9, 31, 21, 0)));
  assert.equal(scene.id, 'halloween');
  assert.equal(scene.name, 'Haunted hill');
});

test('600 frames per theme: <= 0.3 ms per frame (step + frame + rgba; after 300 warm-up frames, the fastest of 150 batches of 4) in Node', async () => {
  // The budget is the code's cost, not the scheduler's. node --test runs the files concurrently (headless Chrome
  // included) on a shared machine, so a timed stretch can be preempted, wait for a collector thread that gets no
  // core, or run before the JIT has tiered up. So each theme first runs 300 untimed frames (the JIT warms up), then
  // 600 timed frames in 150 short batches of 4 (well under a scheduler time slice): the fastest batch is the cost of
  // the code. A theme over budget is measured again after a short pause, up to 5 rounds in all, so a burst of load
  // on the machine passes while a real regression stays over budget in every round.
  const BUDGET = 0.3;
  const WARM = 300;
  const BATCHES = 150;
  const PER = 4;
  const ROUNDS = 5;
  const PAUSE_MS = 250;
  const u8 = new Uint8ClampedArray(16384);
  const measure = (id) => {
    const scene = E.createScene({ PC });
    scene.want(id, { fade: false });
    for (let i = 0; i < WARM; i++) { scene.step(CTX); scene.frame(CTX); scene.rgba(u8); }
    let best = Infinity;
    for (let batch = 0; batch < BATCHES; batch++) {
      const t0 = process.hrtime.bigint();
      for (let i = 0; i < PER; i++) { scene.step(CTX); scene.frame(CTX); scene.rgba(u8); }
      best = Math.min(best, Number(process.hrtime.bigint() - t0) / 1e6 / PER);
    }
    return best;
  };
  const rows = PC.themes.map((t) => ({ id: t.id, ms: measure(t.id), rounds: 1 }));
  for (let round = 1; round < ROUNDS; round++) {
    const slow = rows.filter((r) => r.ms > BUDGET);
    if (!slow.length) break;
    await new Promise((resolve) => setTimeout(resolve, PAUSE_MS));
    for (const r of slow) {
      r.ms = Math.min(r.ms, measure(r.id));
      r.rounds++;
    }
  }
  console.log(`ms per frame: ${rows.map((r) => `${r.id} ${r.ms.toFixed(3)}${r.rounds > 1 ? ` (${r.rounds} rounds)` : ''}`).join(', ')}`);
  for (const r of rows) assert.ok(r.ms <= BUDGET, `${r.id}: ${r.ms.toFixed(3)} ms per frame after ${r.rounds} rounds`);
});
