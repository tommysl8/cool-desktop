// PCD.layout (src/shared/pcd-layout.js): the type ladder and the TermMono cell, which the console (PCD.console) and
// the scene layer (PCD.bleed) lay every screen out from. The console's own layout is tests/console.test.mjs.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const SRC = path.join(ROOT, 'src', 'shared', 'pcd-layout.js');
const Lay = require(SRC);

test('the surface: the ladder, the divisors, the step and the cell', () => {
  assert.deepEqual(Object.keys(Lay).sort(), ['DIVISORS', 'LADDER', 'cellFrom', 'fontStep', 'minStep', 'steps', 'termCell']);
  assert.deepEqual(Lay.LADDER, [14, 16, 20, 24, 28, 32, 36, 40, 48, 56, 64]);
  assert.deepEqual(Lay.DIVISORS, { newtab: 44, wallpaper: 48, still: 48 });
});

test('type: the ladder step nearest cssH x dpr / div, ties to the smaller step; the new tab floor', () => {
  assert.equal(Lay.fontStep(1080, 1, 'wallpaper'), 24);
  assert.equal(Lay.fontStep(1440, 1, 'wallpaper'), 28); // 30: a tie between 28 and 32 goes to 28
  assert.equal(Lay.fontStep(2160, 1, 'wallpaper'), 48);
  assert.equal(Lay.fontStep(800, 2, 'wallpaper'), 32);
  assert.equal(Lay.fontStep(1440, 1.5, 'still'), 48);
  assert.equal(Lay.fontStep(300, 1, 'wallpaper'), 16); // never under 16 on the wallpaper (the atlas)
  assert.equal(Lay.fontStep(800, 2), 32, 'the wallpaper is the default profile');
  assert.equal(Lay.fontStep(800, 2, 'newtab'), 36);
  assert.equal(Lay.fontStep(620, 2, 'newtab'), 28);
  assert.equal(Lay.fontStep(500, 2, 'newtab'), 24, '12 CSS px at DPR 2');
  assert.equal(Lay.fontStep(500, 1, 'newtab'), 14);
  assert.equal(Lay.fontStep(400, 1.25, 'newtab'), 16, 'max(14, ceil(12 x 1.25)) = 15, so 16');
  assert.deepEqual(Lay.steps('newtab', 2), [64, 56, 48, 40, 36, 32, 28, 24]);
  assert.deepEqual(Lay.steps('wallpaper', 1), [64, 56, 48, 40, 36, 32, 28, 24, 20, 16]);
  assert.equal(Lay.minStep('newtab', 2), 24);
  assert.equal(Lay.minStep('still', 3), 16);
});

test('termCell: TermMono cells exactly as headless Chrome 157 measured them at DPR 1, 1.25, 1.5 and 2', () => {
  // step -> [advance in device px, line height in device px]; identical at every DPR (Chrome lays text out at the
  // device size).
  const measured = { 12: [7, 14], 14: [8, 16], 16: [9, 19], 20: [11, 24], 24: [14, 28], 28: [16, 33], 32: [18, 38],
    36: [21, 41], 40: [23, 46], 48: [28, 56], 56: [32, 65], 64: [37, 74] };
  for (const d of [1, 1.25, 1.5, 2]) {
    for (const [step, [w, h]] of Object.entries(measured)) {
      const c = Lay.termCell(Number(step), d);
      assert.deepEqual([c.wDev, c.hDev], [w, h], `step ${step} @${d}`);
      assert.ok(Math.abs(c.w * d - w) < 1e-9 && Math.abs(c.h * d - h) < 1e-9);
      assert.ok(c.ls <= 0 && c.ls > -1 / d, 'the letter-spacing correction is a negative fraction of a device px');
    }
  }
  const m = Lay.cellFrom(10.546875, 20.5, 2);
  assert.deepEqual([m.w, m.h, m.wDev, m.hDev], [10.5, 20.5, 21, 41]);
  assert.equal(Lay.cellFrom(0, 0, 0).wDev, 1, 'never a zero cell; a bad dpr counts as 1');
});

test('pure: no screen.*, no DOM, no timers; the same input gives the same answer', () => {
  const code = fs.readFileSync(SRC, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.ok(!/\bscreen\s*\./.test(code), 'nothing reads screen.*');
  assert.ok(!/(^|[^.\w'])(document|window)\s*\.|setTimeout|requestAnimationFrame/.test(code), 'no DOM or timers');
  assert.deepEqual(Lay.termCell(36, 2), Lay.termCell(36, 2));
  assert.equal(Lay.fontStep(1440, 1.5, 'wallpaper'), Lay.fontStep(1440, 1.5, 'still'), 'the still uses the wallpaper ladder');
});
