// tools/make-icons.mjs: one 16x16 pixel-art PixelClock drawn with the synced engine's own
// helpers, scaled by whole pixels to 16, 32, 48 and 128 px; RGBA PNGs with transparent corners; deterministic; the
// committed src/newtab/icons/ match a fresh render pixel for pixel.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

function findRoot(dir) {
  for (let d = dir; ; d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, 'tools', 'build.mjs'))) return d;
    if (path.dirname(d) === d) throw new Error('repo root not found');
  }
}
const ROOT = findRoot(import.meta.dirname);
const I = await import(pathToFileURL(path.join(ROOT, 'tools', 'make-icons.mjs')).href);
const { decodePng, pngSize } = await import(pathToFileURL(path.join(ROOT, 'tools', 'lib', 'png.mjs')).href);

const px = (img, x, y) => {
  const i = (y * img.width + x) * 4;
  return [img.data[i], img.data[i + 1], img.data[i + 2], img.data[i + 3]];
};
const rgb = (c) => [(c >> 16) & 255, (c >> 8) & 255, c & 255, 255];

test('the engine runs in a private context: no PixelClock global leaks into the caller', () => {
  const before = globalThis.PixelClock;
  const PC = I.loadEngine();
  assert.equal(typeof PC.drawDigit, 'function');
  assert.equal(globalThis.PixelClock, before);
});

test('the 16x16 art: light-wood frame, the clock\'s dusk sky, the "12" in cream, transparent corners; deterministic', () => {
  const a = I.drawArt();
  const b = I.drawArt();
  assert.deepEqual(Buffer.from(a.rgba), Buffer.from(b.rgba));
  const img = { width: 16, height: 16, data: a.rgba };
  for (const [x, y] of [[0, 0], [15, 0], [0, 15], [15, 15]]) assert.deepEqual(px(img, x, y), [0, 0, 0, 0], `corner ${x},${y}`);
  assert.deepEqual(px(img, 7, 0), rgb(I.PALETTE.frame));
  assert.deepEqual(px(img, 0, 7), rgb(I.PALETTE.frame));
  assert.deepEqual(px(img, 15, 8), rgb(I.PALETTE.frame));
  const PC = I.loadEngine();
  const [top] = PC.skyAt(17);
  assert.deepEqual(px(img, 13, 1), rgb(top), 'the engine\'s own sky at 17:00');
  assert.deepEqual(px(img, 5, 2), rgb(I.PALETTE.text), 'the top of the "1"');
  assert.deepEqual(px(img, 8, 2), rgb(I.PALETTE.text), 'the top of the "2"');
  for (let i = 0; i < 256; i++) assert.ok(a.rgba[i * 4 + 3] === 255 || a.rgba[i * 4 + 3] === 0, 'alpha is 0 or 255 only');
});

test('scaleArt(): every art pixel becomes an exact k x k block', () => {
  const art = I.drawArt();
  for (const k of [1, 2, 3, 8]) {
    const s = I.scaleArt(art, k);
    assert.equal(s.w, 16 * k);
    for (let y = 0; y < s.h; y++) {
      for (let x = 0; x < s.w; x++) {
        const d = (y * s.w + x) * 4;
        const o = (Math.floor(y / k) * 16 + Math.floor(x / k)) * 4;
        for (let c = 0; c < 4; c++) if (s.rgba[d + c] !== art.rgba[o + c]) assert.fail(`k ${k} at ${x},${y}`);
      }
    }
  }
  assert.throws(() => I.scaleArt(art, 1.5), /whole number/);
  assert.throws(() => I.scaleArt(art, 0), /whole number/);
});

test('renderIcons(): 8-bit RGBA PNGs of 16, 32, 48 and 128 px (x1, x2, x3, x8)', () => {
  const pngs = I.renderIcons();
  assert.deepEqual(Object.keys(pngs).map(Number), [16, 32, 48, 128]);
  for (const size of I.SIZES) {
    const info = pngSize(pngs[size]);
    assert.deepEqual([info.width, info.height, info.bitDepth, info.colorType], [size, size, 8, 6], `${size}`);
    assert.equal(I.SCALES[size] * 16, size);
  }
});

test('the committed icons in src/newtab/icons match a fresh render; --check writes nothing; a changed icon fails', () => {
  const r = I.makeIcons({ check: true });
  assert.deepEqual(r.problems, []);
  assert.equal(r.code, 0);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pcd-icons-'));
  try {
    const w = I.makeIcons({ outDir: tmp });
    assert.equal(w.code, 0);
    assert.deepEqual(fs.readdirSync(tmp).sort(), ['icon128.png', 'icon16.png', 'icon32.png', 'icon48.png']);
    for (const size of I.SIZES) {
      const a = decodePng(fs.readFileSync(path.join(tmp, `icon${size}.png`)));
      const b = decodePng(fs.readFileSync(path.join(ROOT, 'src', 'newtab', 'icons', `icon${size}.png`)));
      assert.deepEqual(a.data, b.data, `icon${size}.png`);
    }
    fs.copyFileSync(path.join(tmp, 'icon16.png'), path.join(tmp, 'icon32.png'));
    const bad = I.makeIcons({ outDir: tmp, check: true });
    assert.equal(bad.code, 1);
    assert.ok(bad.problems.some((p) => /icon32\.png is 16x16/.test(p)), bad.problems.join('; '));
    fs.rmSync(path.join(tmp, 'icon48.png'));
    assert.ok(I.makeIcons({ outDir: tmp, check: true }).problems.some((p) => /icon48\.png is missing/.test(p)));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
