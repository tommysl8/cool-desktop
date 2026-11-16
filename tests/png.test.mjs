// node --test tests/png.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { decodePng, encodePng, imageSize, isJpeg, isPng, jpegSize, pixelAt, pngSize } from '../tools/lib/png.mjs';
import { makeTempDir, rmrf } from '../tools/lib/fsx.mjs';

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function ihdr(w, h, colorType = 6) {
  const d = Buffer.alloc(13);
  d.writeUInt32BE(w, 0); d.writeUInt32BE(h, 4); d[8] = 8; d[9] = colorType;
  return chunk('IHDR', d);
}
const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function testImage(w, h, ch) {
  const data = Buffer.alloc(w * h * ch);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * ch;
    data[i] = (x * 37 + y * 11) & 255; data[i + 1] = (x * 5 + y * 71) & 255; data[i + 2] = (x * y + 3) & 255;
    if (ch === 4) data[i + 3] = (x + y * 7) & 255;
  }
  return data;
}

test('IHDR parsing of a hand-made header: 2560x1600', () => {
  const buf = Buffer.concat([SIG, ihdr(2560, 1600, 2)]);
  assert.equal(isPng(buf), true);
  const s = pngSize(buf);
  assert.equal(s.width, 2560);
  assert.equal(s.height, 1600);
  assert.equal(s.bitDepth, 8);
  assert.equal(s.colorType, 2);
});

test('pngSize rejects non-PNG data and truncated or misordered headers', () => {
  assert.equal(isPng(Buffer.from('GIF89a......')), false);
  assert.equal(isPng(Buffer.alloc(3)), false);
  assert.throws(() => pngSize(Buffer.from('not a png at all, definitely not a png')), /not a PNG/);
  assert.throws(() => pngSize(SIG), /truncated/);
  assert.throws(() => pngSize(Buffer.concat([SIG, chunk('tEXt', Buffer.alloc(13)), Buffer.alloc(8)])), /IHDR/);
});

test('encodePng -> decodePng round trip (RGBA and RGB) and pngSize from a file path', async () => {
  const dir = makeTempDir('pcd-pngtest-');
  try {
    for (const ch of [4, 3]) {
      const w = 13, h = 7;
      const data = testImage(w, h, ch);
      const png = encodePng({ width: w, height: h, data, channels: ch });
      assert.equal(isPng(png), true);
      const file = path.join(dir, `t${ch}.png`);
      fs.writeFileSync(file, png);
      assert.deepEqual({ w: pngSize(file).width, h: pngSize(file).height }, { w, h });
      assert.deepEqual(imageSize(file), { type: 'png', width: w, height: h });
      const img = decodePng(file);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const i = (y * w + x) * ch;
        assert.deepEqual(pixelAt(img, x, y), [data[i], data[i + 1], data[i + 2], ch === 4 ? data[i + 3] : 255]);
      }
    }
  } finally {
    await rmrf(dir);
  }
});

test('decodePng undoes all five filter types', () => {
  const w = 6, h = 5, ch = 4;
  const px = testImage(w, h, ch);
  const stride = w * ch;
  const raw = Buffer.alloc((stride + 1) * h);
  const paeth = (a, b, c) => { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); return pa <= pb && pa <= pc ? a : pb <= pc ? b : c; };
  for (let y = 0; y < h; y++) {
    const f = y % 5;
    raw[y * (stride + 1)] = f;
    for (let x = 0; x < stride; x++) {
      const v = px[y * stride + x];
      const a = x >= ch ? px[y * stride + x - ch] : 0;
      const b = y > 0 ? px[(y - 1) * stride + x] : 0;
      const c = x >= ch && y > 0 ? px[(y - 1) * stride + x - ch] : 0;
      const pred = [0, a, b, (a + b) >> 1, paeth(a, b, c)][f];
      raw[y * (stride + 1) + 1 + x] = (v - pred) & 255;
    }
  }
  const png = Buffer.concat([SIG, ihdr(w, h, 6), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
  const img = decodePng(png);
  assert.deepEqual(Buffer.from(img.data), px);
});

test('jpegSize reads the SOF0 marker; imageSize detects JPEG', () => {
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]);
  const sof0 = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, 0x06, 0x40, 0x0a, 0x00, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01]);
  const jpg = Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof0, Buffer.from([0xff, 0xd9])]);
  assert.equal(isJpeg(jpg), true);
  assert.deepEqual(jpegSize(jpg), { height: 1600, width: 2560 });
  assert.deepEqual(imageSize(jpg), { type: 'jpeg', width: 2560, height: 1600 });
  assert.throws(() => imageSize(Buffer.from('plain text')), /not a PNG or JPEG/);
});
