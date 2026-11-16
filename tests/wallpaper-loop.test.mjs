// node --test "tests/wallpaper-loop.test.mjs"
// The wallpaper's frame loop (src/wallpaper/js/wp-loop.js) on a fake clock with fake timers and a
// 60 Hz fake vsync: 30 and 15 fps with 30 engine steps per second, pause stops every timer and rAF at once (reasons
// counted), resume never fast-forwards, at most 7 steps per frame, still mode (kick), the reduced-motion burst.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
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
const L = require(path.join(ROOT, 'src', 'wallpaper', 'js', 'wp-loop.js'));

/** Fake time: timeouts fire in order, rAF callbacks at the next 60 Hz vsync (requested during a frame: the next one). */
function fakeEnv() {
  let t = 0;
  let id = 0;
  const VSYNC = 1000 / 60;
  const timeouts = new Map();
  let rafs = new Map();
  const log = { timeoutsFired: 0, rafsFired: 0 };
  const env = {
    now: () => t,
    setTimeout: (fn, ms) => { const i = ++id; timeouts.set(i, { at: t + Math.max(0, ms), fn, i }); return i; },
    clearTimeout: (i) => { timeouts.delete(i); },
    requestAnimationFrame: (fn) => { const i = ++id; rafs.set(i, fn); return i; },
    cancelAnimationFrame: (i) => { rafs.delete(i); },
    pending: () => ({ timeouts: timeouts.size, rafs: rafs.size }),
    log,
    /** Move the clock by ms (the work itself may move it too: env.burn(ms) inside a callback). */
    burn: (ms) => { t += ms; },
    advance(ms) {
      const end = t + ms;
      for (;;) {
        let nextTimer = Infinity;
        for (const v of timeouts.values()) if (v.at < nextTimer) nextTimer = v.at;
        const nextVsync = rafs.size ? (Math.floor(t / VSYNC + 1e-9) + 1) * VSYNC : Infinity;
        const next = Math.min(nextTimer, nextVsync);
        if (next > end) break;
        t = Math.max(t, next);
        if (nextTimer <= nextVsync) {
          const due = [...timeouts.values()].filter((v) => v.at <= t).sort((a, b) => a.at - b.at || a.i - b.i);
          for (const v of due) {
            if (!timeouts.has(v.i)) continue;
            timeouts.delete(v.i);
            log.timeoutsFired++;
            v.fn();
          }
        } else {
          const batch = rafs;
          rafs = new Map();
          for (const fn of batch.values()) {
            log.rafsFired++;
            fn(t);
          }
        }
      }
      t = Math.max(t, end);
    },
  };
  return env;
}

function makeLoop(env, extra = {}) {
  const calls = { steps: 0, draws: 0, infos: [] };
  const loop = L.create({
    now: env.now, setTimeout: env.setTimeout, clearTimeout: env.clearTimeout,
    requestAnimationFrame: env.requestAnimationFrame, cancelAnimationFrame: env.cancelAnimationFrame,
    step: (n) => { calls.steps += n; if (extra.step) extra.step(n); },
    draw: (info) => { calls.draws++; calls.infos.push(info); if (extra.draw) extra.draw(info); },
    onError: extra.onError,
    fps: extra.fps,
  });
  return { loop, calls };
}

test('30 fps: about 30 frames and exactly-paced 30 engine steps per second; one rAF per frame, no rAF chain', () => {
  const env = fakeEnv();
  const { loop, calls } = makeLoop(env);
  loop.start();
  env.advance(10000);
  const s = loop.stats();
  assert.ok(Math.abs(s.frames - 300) <= 4, `frames ${s.frames}`);
  assert.ok(Math.abs(calls.steps - 300) <= 2, `steps ${calls.steps}`);
  assert.ok(Math.abs(s.fps - 30) <= 1, `fps ${s.fps}`);
  // every rAF draws a frame (no rAF at the display rate between frames)
  assert.ok(env.log.rafsFired <= s.frames + 2, `rafs ${env.log.rafsFired} for ${s.frames} frames`);
  assert.ok(s.maxSteps <= 2, `max steps per frame ${s.maxSteps}`);
  assert.equal(s.target, 30);
  assert.equal(L.MAX_STEPS, 7);
});

test('15 fps: about 15 frames per second and still 30 engine steps per second', () => {
  const env = fakeEnv();
  const { loop, calls } = makeLoop(env, { fps: 15 });
  loop.start();
  env.advance(10000);
  const s = loop.stats();
  assert.ok(Math.abs(s.frames - 150) <= 3, `frames ${s.frames}`);
  assert.ok(Math.abs(calls.steps - 300) <= 3, `steps ${calls.steps}`);
  assert.ok(Math.abs(s.fps - 15) <= 0.6, `fps ${s.fps}`);
  // switching back to 30 at run time
  loop.setFps(30);
  const f0 = loop.stats().frames;
  env.advance(2000);
  assert.ok(Math.abs(loop.stats().frames - f0 - 60) <= 3, `30 fps again: ${loop.stats().frames - f0} frames in 2 s`);
});

test('pause stops every timer and rAF at once; nothing fires while paused; reasons are counted', () => {
  const env = fakeEnv();
  const { loop, calls } = makeLoop(env);
  loop.start();
  env.advance(1000);
  assert.ok(env.pending().timeouts + env.pending().rafs >= 1, 'something is armed while running');
  assert.equal(loop.pause('lively'), true);
  assert.deepEqual(env.pending(), { timeouts: 0, rafs: 0 }, 'pause disarms synchronously (well within 100 ms)');
  assert.deepEqual(loop.pending(), { timer: false, raf: false });
  const before = { ...env.log, steps: calls.steps, draws: calls.draws };
  env.advance(5000);
  assert.equal(env.log.timeoutsFired, before.timeoutsFired, 'no timer fired while paused');
  assert.equal(env.log.rafsFired, before.rafsFired, 'no rAF fired while paused');
  assert.equal(calls.draws, before.draws);
  assert.equal(calls.steps, before.steps);
  // a second reason: resuming one keeps the loop paused
  assert.equal(loop.pause('hidden'), true);
  assert.equal(loop.pause('hidden'), false, 'the same reason twice is one reason');
  assert.equal(loop.resume('lively'), true);
  assert.equal(loop.paused(), true);
  assert.deepEqual(loop.reasons(), ['hidden']);
  env.advance(1000);
  assert.equal(calls.draws, before.draws, 'still paused by hidden');
  assert.deepEqual(env.pending(), { timeouts: 0, rafs: 0 });
  // kick, burst and setFps while paused never arm anything
  loop.kick();
  loop.burst(4000, 15);
  loop.setFps(15);
  loop.setFps(30);
  assert.deepEqual(env.pending(), { timeouts: 0, rafs: 0 }, 'nothing armed while paused');
  assert.equal(loop.stats().pauses, 1, 'one pause (two overlapping reasons)');
});

test('resume continues without fast-forward: the first frame carries 0-1 steps, then 30 steps per second', () => {
  const env = fakeEnv();
  const { loop, calls } = makeLoop(env);
  loop.start();
  env.advance(3000);
  loop.pause('lively');
  env.advance(60000);
  const s0 = calls.steps;
  loop.resume('lively');
  env.advance(100);
  const first = calls.infos.slice(-3);
  assert.ok(first.every((i) => i.steps <= 1), `steps right after the resume: ${first.map((i) => i.steps).join(', ')}`);
  env.advance(1900);
  const st = loop.stats();
  assert.ok(Math.abs(calls.steps - s0 - 60) <= 2, `${calls.steps - s0} steps in 2 s after a 60 s pause (want about 60)`);
  assert.ok(st.sinceResume.maxSteps <= 2, `max steps per frame since the resume ${st.sinceResume.maxSteps}`);
  assert.equal(st.resumes, 1);
});

test('a frame never carries more than 7 steps (a 1 s stall), and the pace resyncs instead of bursting', () => {
  const env = fakeEnv();
  let stall = false;
  const { loop, calls } = makeLoop(env, { draw: () => { if (stall) { stall = false; env.burn(1000); } } });
  loop.start();
  env.advance(1000);
  stall = true;
  const f0 = loop.stats().frames;
  env.advance(1100);
  const s = loop.stats();
  assert.ok(s.maxSteps <= 7, `max steps ${s.maxSteps}`);
  assert.ok(calls.infos.some((i) => i.steps === 7), 'the frame after the stall carries the capped 7 steps');
  // no burst of catch-up frames: about 30 per second again right away
  assert.ok(s.frames - f0 <= 6, `${s.frames - f0} frames in the 0.1 s after a 1 s stall`);
});

test('still mode (fps 0): no timer or rAF at all; kick() paints exactly one frame without steps', () => {
  const env = fakeEnv();
  const { loop, calls } = makeLoop(env, { fps: 0 });
  loop.start();
  env.advance(100);
  assert.equal(calls.draws, 1, 'start paints the first frame');
  assert.equal(calls.infos[0].still, true);
  assert.equal(calls.infos[0].steps, 0);
  env.advance(5000);
  assert.equal(calls.draws, 1, 'no loop');
  assert.deepEqual(env.pending(), { timeouts: 0, rafs: 0 });
  loop.kick();
  env.advance(100);
  assert.equal(calls.draws, 2);
  assert.equal(calls.steps, 0, 'a still frame advances no engine time');
  assert.deepEqual(env.pending(), { timeouts: 0, rafs: 0 });
  assert.equal(loop.stats().stillFrames, 2);
});

test('burst (a shake under reduced motion): 4 s at 15 fps, about 120 steps, then still again with nothing armed', () => {
  const env = fakeEnv();
  const { loop, calls } = makeLoop(env, { fps: 0 });
  loop.start();
  env.advance(1000);
  const d0 = calls.draws;
  loop.burst(4000, 15);
  env.advance(2000);
  assert.equal(loop.stats().burst, true);
  env.advance(3000);
  const frames = calls.draws - d0;
  assert.ok(frames >= 57 && frames <= 63, `${frames} frames in the burst`);
  assert.ok(calls.steps >= 115 && calls.steps <= 122, `${calls.steps} steps in the burst`);
  assert.equal(loop.stats().burst, false);
  assert.deepEqual(env.pending(), { timeouts: 0, rafs: 0 }, 'still again');
  const d1 = calls.draws;
  env.advance(5000);
  assert.equal(calls.draws, d1);
});

test('setFps(0) while running stops the loop; setFps(30) restarts it from a fresh step clock', () => {
  const env = fakeEnv();
  const { loop, calls } = makeLoop(env);
  loop.start();
  env.advance(1000);
  loop.setFps(0);
  assert.deepEqual(env.pending(), { timeouts: 0, rafs: 0 });
  const s0 = calls.steps;
  env.advance(10000);
  assert.equal(calls.steps, s0);
  loop.setFps(30);
  env.advance(1000);
  assert.ok(Math.abs(calls.steps - s0 - 30) <= 2, `${calls.steps - s0} steps in the first second (no catch-up of the still time)`);
});

test('a throwing draw is reported and the loop keeps going; stop() disarms for good', () => {
  const env = fakeEnv();
  const errors = [];
  let n = 0;
  const { loop } = makeLoop(env, { draw: () => { if (++n % 2) throw new Error('boom'); }, onError: (e) => errors.push(e.message) });
  loop.start();
  env.advance(1000);
  assert.ok(errors.length >= 10, `${errors.length} errors reported`);
  assert.ok(loop.stats().frames >= 28, 'the loop kept running');
  loop.stop();
  assert.deepEqual(env.pending(), { timeouts: 0, rafs: 0 });
  const f = loop.stats().frames;
  env.advance(1000);
  assert.equal(loop.stats().frames, f);
});
