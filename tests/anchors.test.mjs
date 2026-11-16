// node --test "tests/anchors.test.mjs"
// tools/lib/anchors.mjs: per-theme light anchors measured from the vendored engine. Every theme
// inside the bounds (rise 5-9 h, set 15.5-21 h) with a 48-value curve, deterministic, the engine kept private (the
// caller's globalThis.PixelClock is never touched), plus the crossing math and the anchors.json / pcd-anchors.js text.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath, pathToFileURL } from 'node:url';

function findRoot(start) {
  let d = start;
  while (!fs.existsSync(path.join(d, 'tools', 'lib', 'anchors.mjs'))) {
    const up = path.dirname(d);
    if (up === d) throw new Error('project root not found');
    d = up;
  }
  return d;
}
const ROOT = findRoot(path.dirname(fileURLToPath(import.meta.url)));
const A = await import(pathToFileURL(path.join(ROOT, 'tools', 'lib', 'anchors.mjs')).href);
const VENDOR = path.join(ROOT, 'vendor', 'pixelclock');
const HAVE_VENDOR = fs.existsSync(path.join(VENDOR, 'simulator', 'engine.js'));
const skip = HAVE_VENDOR ? false : 'vendor/pixelclock is missing (node tools/sync.mjs)';

let generated = null;
function anchors() {
  if (!generated) generated = A.generate(VENDOR);
  return generated;
}

/** Linear interpolation of a 48-value half-hour curve at hour h. */
function level(curve, h) {
  const x = (((h % 24) + 24) % 24) * 2;
  const i = Math.floor(x);
  return curve[i % 48] + (curve[(i + 1) % 48] - curve[i % 48]) * (x - i);
}

test('generate(): every vendored theme, keys sorted, inside the bounds, check() clean', { skip }, () => {
  const a = anchors();
  const files = fs.readdirSync(path.join(VENDOR, 'simulator', 'themes')).filter((f) => f.endsWith('.js'));
  assert.equal(Object.keys(a).length, files.length, 'one anchor per theme file');
  assert.deepEqual(Object.keys(a), [...Object.keys(a)].sort());
  for (const [id, v] of Object.entries(a)) {
    assert.ok(v.rise >= 5 && v.rise <= 9, `${id} rise ${v.rise}`);
    assert.ok(v.set >= 15.5 && v.set <= 21, `${id} set ${v.set}`);
    assert.equal(Math.round(v.rise * 100) / 100, v.rise, 'rise has 2 decimals');
    assert.equal(Math.round(v.set * 100) / 100, v.set, 'set has 2 decimals');
  }
  assert.deepEqual(A.check(a), []);
  assert.deepEqual(A.BOUNDS, { rise: [5, 9], set: [15.5, 21] });
});

test('generate(): 48-value curves, dark at night, bright at noon, crossing 0.5 around rise and set', { skip }, () => {
  for (const [id, v] of Object.entries(anchors())) {
    assert.equal(v.curve.length, 48, id);
    for (const x of v.curve) {
      assert.ok(x >= 0 && x <= 1, `${id}: ${x}`);
      assert.equal(Math.round(x * 100) / 100, x, `${id}: 2 decimals`);
    }
    assert.ok(v.curve[0] < 0.2 && v.curve[47] < 0.2, `${id}: midnight is dark`);
    assert.ok(v.curve[24] > 0.8, `${id}: noon is bright`);
    assert.ok(level(v.curve, v.rise - 1) < 0.5 && level(v.curve, v.rise + 1) > 0.5, `${id}: rises through 0.5 near ${v.rise}`);
    assert.ok(level(v.curve, v.set - 1) > 0.5 && level(v.curve, v.set + 1) < 0.5, `${id}: sets through 0.5 near ${v.set}`);
  }
});

test('generate(): deterministic, and the caller\'s globalThis.PixelClock is never read or written', { skip }, () => {
  const before = globalThis.PixelClock;
  const sentinel = { sentinel: true };
  globalThis.PixelClock = sentinel;
  try {
    const again = A.generate(VENDOR);
    assert.deepEqual(again, anchors());
    assert.equal(globalThis.PixelClock, sentinel);
    const PC = A.loadEngine(VENDOR);
    assert.notEqual(PC, sentinel);
    assert.ok(PC.themes.length >= 13);
    assert.equal(typeof PC.themeIdForDate, 'function', 'schedule.js loaded into the private engine');
  } finally {
    if (before === undefined) delete globalThis.PixelClock;
    else globalThis.PixelClock = before;
  }
});

test('generate(): the clock is not drawn (hook mode none) and measure() gives 96 values', { skip }, () => {
  const PC = A.loadEngine(VENDOR);
  let calls = 0;
  PC.drawClock = () => { calls++; };
  const raw = A.measure(PC, 'autumn');
  assert.equal(raw.length, 96);
  assert.equal(calls, 96, 'one draw per quarter hour, each ending in drawClock');
  assert.ok(raw.every((x) => x >= 0 && x <= 1));
  assert.throws(() => A.measure(PC, 'nope'), /unknown theme/);
});

test('crossings(): first upward 0.5 crossing in 3-12 h, last downward one in 12-23 h, interpolated', () => {
  const at = (fn) => Array.from({ length: 96 }, (_, q) => fn(q / 4));
  const trapezoid = at((h) => Math.max(0, Math.min(1, Math.min((h - 6) / 2, (18 - h) / 2))));
  const c = A.crossings(trapezoid);
  assert.ok(Math.abs(c.rise - 7) < 1e-9, String(c.rise));
  assert.ok(Math.abs(c.set - 17) < 1e-9, String(c.set));
  // An early bump (2 h) is outside the rise window; two dips keep the last downward crossing.
  const bumps = at((h) => (h >= 1.5 && h < 2.5 ? 1 : h >= 8 && h < 14 ? 1 : h >= 15 && h < 19 ? 1 : 0));
  const b = A.crossings(bumps);
  assert.ok(b.rise > 7.75 && b.rise <= 8, String(b.rise));
  assert.ok(b.set > 18.75 && b.set <= 19, String(b.set));
  assert.deepEqual(A.crossings(at(() => 0)), { rise: null, set: null });
  assert.deepEqual(A.crossings(at((h) => (h < 12 ? 0 : 1))), { rise: 11.875, set: null }, 'a crossing ending at 12 h still counts');
  assert.deepEqual(A.crossings(at((h) => (h < 12.25 ? 0 : 1))), { rise: null, set: null }, 'an upward crossing after 12 h is no sunrise');
  assert.deepEqual(A.crossings(at((h) => (h < 23.25 ? 1 : 0))), { rise: null, set: null }, 'a downward crossing after 23 h is no sunset');
  assert.deepEqual(A.normalize([2, 2, 2]), [0, 0, 0]);
  assert.deepEqual(A.normalize([1, 3, 2]), [0, 1, 0.5]);
});

test('meanLuma(): Rec. 709 weights, 0 for black, 1 for white', () => {
  assert.equal(A.meanLuma(new Uint32Array(4096)), 0);
  assert.ok(Math.abs(A.meanLuma(new Uint32Array(4096).fill(0xffffff)) - 1) < 1e-12);
  assert.ok(Math.abs(A.meanLuma(new Uint32Array([0x00ff00])) - 0.7152) < 1e-12);
  assert.ok(Math.abs(A.meanLuma(new Uint32Array([0xff0000, 0x0000ff])) - (0.2126 + 0.0722) / 2) < 1e-12);
});

test('simulatorDir(): the vendor layout or a bare simulator folder; anything else throws', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pcd-anchors-'));
  try {
    fs.mkdirSync(path.join(tmp, 'v', 'simulator'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'v', 'simulator', 'engine.js'), '');
    fs.mkdirSync(path.join(tmp, 'bare'));
    fs.writeFileSync(path.join(tmp, 'bare', 'engine.js'), '');
    assert.equal(A.simulatorDir(path.join(tmp, 'v')), path.join(tmp, 'v', 'simulator'));
    assert.equal(A.simulatorDir(path.join(tmp, 'bare')), path.join(tmp, 'bare'));
    assert.throws(() => A.simulatorDir(tmp), /no engine\.js/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('check(): flags themes outside the bounds and bad curves', () => {
  const curve = new Array(48).fill(0.5);
  assert.deepEqual(A.check({ a: { rise: 7, set: 17, curve } }), []);
  const problems = A.check({ a: { rise: 4.9, set: 17, curve }, b: { rise: 7, set: 21.5, curve }, c: { rise: 7, set: 17, curve: [1] }, d: null });
  assert.equal(problems.length, 4);
  assert.match(problems.join('\n'), /a: rise 4.9 outside 5-9 h/);
  assert.match(problems.join('\n'), /b: set 21.5 outside 15.5-21 h/);
  assert.match(problems.join('\n'), /c: curve must be 48 numbers/);
  assert.deepEqual(A.check({}), ['no themes']);
});

test('toJson() and toJs(): anchors.json and a classic UMD pcd-anchors.js (ASCII, LF, no BOM) that set PCD.ANCHORS', () => {
  const sample = { autumn: { rise: 7.16, set: 16.89, curve: new Array(48).fill(0.25) }, winter: { rise: 6.95, set: 17.16, curve: new Array(48).fill(0) } };
  const json = A.toJson(sample);
  assert.deepEqual(JSON.parse(json), sample);
  assert.equal(json.split('\n').length, 5, 'one theme per line');
  assert.ok(json.endsWith('}\n'));
  const js = A.toJs(sample);
  assert.ok(/^[\x0a\x20-\x7e]*$/.test(js), 'ASCII only');
  assert.ok(!js.includes('\r'));
  assert.doesNotMatch(js, /^\s*(import|export)\s/m);
  const box = { PCD: { other: 1 } };
  vm.runInNewContext(js, box);
  assert.deepEqual(JSON.parse(JSON.stringify(box.PCD.ANCHORS)), sample);
  assert.equal(box.PCD.other, 1, 'other PCD members stay');
  const empty = {};
  vm.runInNewContext(js, empty);
  assert.deepEqual(JSON.parse(JSON.stringify(empty.PCD.ANCHORS)), sample, 'creates PCD when missing');
  const mod = { exports: {} };
  vm.runInNewContext(js, { module: mod });
  assert.deepEqual(JSON.parse(JSON.stringify(mod.exports)), sample, 'module.exports in Node');
});

test('the shipped generator: Node built-ins only, LF, no BOM', () => {
  const src = fs.readFileSync(path.join(ROOT, 'tools', 'lib', 'anchors.mjs'), 'utf8');
  assert.ok(!src.includes('\r'));
  assert.notEqual(src.charCodeAt(0), 0xfeff);
  for (const m of src.matchAll(/^import .* from '([^']+)';$/gm)) assert.match(m[1], /^node:/, m[1]);
});
