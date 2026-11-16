// node --test tests/engine-hook.test.mjs
// src/shared/pcd-hook.js over the synced engine: one wrap of PC.drawClock, called once per theme draw, the three
// modes, the colours, the edge and before().
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { ROOT, instanceAt, loadEngine, ringMean } from './engine-load.mjs';

const { PC, PCD, R, require } = loadEngine();
const hook = PCD.hook;
const HOURS = [3, 7, 12, 19];
const IDS = PC.themes.map((t) => t.id);
const rows = (px, y0, y1) => Array.from(px.subarray(y0 * 64, (y1 + 1) * 64));

function reset() {
  hook.mode = 'device';
  hook.before = null;
}

test('the hook wraps PC.drawClock once; loading the file again or install() again is refused; render.js reuses the engine', () => {
  assert.equal(IDS.length, 13, 'all 13 themes registered through render.js');
  assert.equal(R.PC, PC);
  assert.equal(hook.isInstalled(PC), true);
  assert.equal(PC.drawClock.__pcdHook, true);
  assert.equal(typeof hook.original, 'function');
  assert.equal(hook.original.__pcdHook, undefined, 'the original is the engine function, not a wrapper');
  const wrapped = PC.drawClock;
  assert.equal(hook.install(PC), false, 'a second install is refused');
  const file = path.join(ROOT, 'src', 'shared', 'pcd-hook.js');
  delete require.cache[require.resolve(file)];
  const again = require(file);
  assert.equal(again, hook, 'a second load keeps the first hook object and its state');
  assert.equal(PC.drawClock, wrapped, 'and does not wrap twice');
  assert.equal(hook.install({}), false, 'nothing to wrap: refused');
});

test('the hook runs exactly once per draw for all 13 themes at 3, 7, 12 and 19 h, in every mode', () => {
  reset();
  try {
    for (const mode of hook.MODES) {
      hook.mode = mode;
      for (const id of IDS) {
        for (const hour of HOURS) {
          const { inst, ctx } = instanceAt(PC, R, id, hour);
          const fb = new PC.Canvas();
          const before = hook.calls;
          inst.draw(fb, ctx);
          assert.equal(hook.calls - before, 1, `${id} @ ${hour} h, mode ${mode}`);
        }
      }
    }
  } finally {
    reset();
  }
});

test("mode 'none': the final frame is the scene as it was when the clock would be drawn (rows 0-15 left to the scene)", () => {
  reset();
  try {
    for (const id of IDS) {
      for (const hour of HOURS) {
        let snap = null;
        hook.before = (cv) => { snap = Uint32Array.from(cv.px); };
        hook.mode = 'none';
        const a = instanceAt(PC, R, id, hour);
        const fbNone = new PC.Canvas();
        a.inst.draw(fbNone, a.ctx);
        assert.deepEqual(Array.from(fbNone.px), Array.from(snap), `${id} @ ${hour} h: nothing drawn after the hook`);
        hook.before = null;
        hook.mode = 'device';
        const b = instanceAt(PC, R, id, hour);
        const fbDev = new PC.Canvas();
        b.inst.draw(fbDev, b.ctx);
        const changed = rows(fbDev.px, 0, 15).filter((c, i) => c !== fbNone.px[i]).length;
        assert.ok(changed > 40, `${id} @ ${hour} h: device mode draws the time in rows 0-15 (${changed} pixels differ)`);
      }
    }
  } finally {
    reset();
  }
});

test("mode 'date': rows 56-63 equal 'device' and rows 0-55 equal 'none'", () => {
  reset();
  try {
    for (const id of IDS) {
      for (const hour of HOURS) {
        const frame = (mode) => {
          hook.mode = mode;
          const { inst, ctx } = instanceAt(PC, R, id, hour);
          const fb = new PC.Canvas();
          inst.draw(fb, ctx);
          return fb.px;
        };
        const dev = frame('device');
        const date = frame('date');
        const none = frame('none');
        assert.deepEqual(rows(date, 56, 63), rows(dev, 56, 63), `${id} @ ${hour} h: the date corners`);
        assert.deepEqual(rows(date, 0, 55), rows(none, 0, 55), `${id} @ ${hour} h: no time drawn`);
      }
    }
  } finally {
    reset();
  }
});

test("mode 'device' is the original drawClock exactly (a twin drawn with the hook uninstalled)", () => {
  reset();
  try {
    for (const id of IDS) {
      const a = instanceAt(PC, R, id, 19);
      const b = instanceAt(PC, R, id, 19);
      const hooked = new PC.Canvas();
      a.inst.draw(hooked, a.ctx);
      assert.equal(hook.uninstall(PC), true);
      const plain = new PC.Canvas();
      try {
        b.inst.draw(plain, b.ctx);
      } finally {
        assert.equal(hook.install(PC), true, 'reinstalled');
      }
      assert.deepEqual(Array.from(hooked.px), Array.from(plain.px), id);
    }
  } finally {
    reset();
  }
});

test('colors: the theme clock colours from its last call; edge: the mean of the outer ring before the clock', () => {
  reset();
  try {
    for (const id of IDS) {
      let snap = null;
      hook.before = (cv) => { snap = Uint32Array.from(cv.px); };
      const { inst, ctx } = instanceAt(PC, R, id, 12);
      const fb = new PC.Canvas();
      inst.draw(fb, ctx);
      const { clock, shadow } = hook.colors;
      assert.ok(Number.isInteger(clock) && clock >= 0 && clock <= 0xffffff, `${id}: clock colour ${clock}`);
      assert.ok(shadow === null || (Number.isInteger(shadow) && shadow <= 0xffffff), `${id}: shadow colour ${shadow}`);
      const clockPx = rows(fb.px, 0, 15).filter((c) => c === clock).length;
      assert.ok(clockPx >= 20, `${id}: ${clockPx} pixels of the reported clock colour in rows 0-15`);
      assert.equal(hook.edge, ringMean(snap), `${id}: edge`);
    }
  } finally {
    reset();
  }
});

test('before() runs first on scene pixels; a throwing before() is reported once and the clock still draws', () => {
  reset();
  const saved = console.error;
  const lines = [];
  console.error = (...a) => lines.push(a.join(' '));
  try {
    const seen = [];
    hook.before = (cv, ctx) => { seen.push(ctx.hours); cv.px[0] = 0x123456; };
    const a = instanceAt(PC, R, 'autumn', 19);
    const fb = new PC.Canvas();
    a.inst.draw(fb, a.ctx);
    assert.deepEqual(seen, [19], 'before(cv, ctx) got the draw ctx');
    assert.equal(fb.px[0], 0x123456, 'before() painted the scene (pixel 0,0 is not under the clock)');
    hook.before = () => { throw new Error('fx exploded'); };
    const b = instanceAt(PC, R, 'autumn', 19);
    const c = instanceAt(PC, R, 'autumn', 19);
    const fb1 = new PC.Canvas();
    b.inst.draw(fb1, b.ctx);
    b.inst.draw(new PC.Canvas(), b.ctx);
    hook.before = null;
    const fb2 = new PC.Canvas();
    c.inst.draw(fb2, c.ctx);
    assert.deepEqual(Array.from(fb1.px), Array.from(fb2.px), 'the frame is drawn as if there were no before()');
    assert.equal(lines.filter((l) => l.includes('fx exploded')).length, 1, 'reported once');
  } finally {
    console.error = saved;
    reset();
  }
});
