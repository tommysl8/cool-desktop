// PNG/JPEG helpers: signature checks, IHDR/SOF size reading, a small 8-bit PNG encoder and decoder.
// Node built-ins only.
import fs from 'node:fs';
import zlib from 'node:zlib';

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function toBuffer(input, bytes) {
  if (Buffer.isBuffer(input)) return input;
  if (input instanceof Uint8Array) return Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  if (typeof input !== 'string') throw new TypeError('expected a file path or a Buffer');
  if (!bytes) return fs.readFileSync(input);
  const fd = fs.openSync(input, 'r');
  try {
    const buf = Buffer.alloc(bytes);
    const n = fs.readSync(fd, buf, 0, bytes, 0);
    return buf.subarray(0, n);
  } finally {
    fs.closeSync(fd);
  }
}

function label(input) {
  return typeof input === 'string' ? input : '<buffer>';
}

/** True when the buffer starts with the 8-byte PNG signature. */
export function isPng(buf) {
  return !!buf && buf.length >= 8 && Buffer.from(buf.subarray(0, 8)).equals(PNG_SIG);
}

/**
 * Size from the IHDR chunk. Accepts a file path or a Buffer.
 * Returns { width, height, bitDepth, colorType, interlace }; throws when the data is not a PNG.
 */
export function pngSize(input) {
  const buf = toBuffer(input, 33);
  if (!isPng(buf)) throw new Error(`not a PNG (bad signature): ${label(input)}`);
  if (buf.length < 33) throw new Error(`truncated PNG: ${label(input)}`);
  const len = buf.readUInt32BE(8);
  const type = buf.toString('latin1', 12, 16);
  if (type !== 'IHDR' || len !== 13) throw new Error(`PNG does not start with a 13-byte IHDR chunk: ${label(input)}`);
  return {
    width: buf.readUInt32BE(16),
    height: buf.readUInt32BE(20),
    bitDepth: buf[24],
    colorType: buf[25],
    interlace: buf[28],
  };
}

/** True when the buffer starts with a JPEG SOI marker. */
export function isJpeg(buf) {
  return !!buf && buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
}

/** { width, height } from the first SOFn marker of a JPEG file path or Buffer. */
export function jpegSize(input) {
  const buf = toBuffer(input);
  if (!isJpeg(buf)) throw new Error(`not a JPEG: ${label(input)}`);
  let i = 2;
  while (i + 4 <= buf.length) {
    if (buf[i] !== 0xff) { i++; continue; }
    const marker = buf[i + 1];
    if (marker === 0xff) { i++; continue; }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
    if (marker === 0xd9 || marker === 0xda) break; // EOI or start of scan before any SOF
    const len = buf.readUInt16BE(i + 2);
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      if (i + 9 > buf.length) break;
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    }
    i += 2 + len;
  }
  throw new Error(`JPEG has no SOF marker: ${label(input)}`);
}

/** Size of a PNG or JPEG (by signature): { type: 'png'|'jpeg', width, height }. */
export function imageSize(input) {
  const buf = toBuffer(input);
  if (isPng(buf)) { const s = pngSize(buf); return { type: 'png', width: s.width, height: s.height }; }
  if (isJpeg(buf)) return { type: 'jpeg', ...jpegSize(buf) };
  throw new Error(`not a PNG or JPEG: ${label(input)}`);
}

// ---------------------------------------------------------------------------------------------
// CRC32 (zlib.crc32 exists since Node 22.2; keep a table fallback).
let CRC_TABLE = null;
function crc32(buf) {
  if (typeof zlib.crc32 === 'function') return zlib.crc32(buf) >>> 0;
  if (!CRC_TABLE) {
    CRC_TABLE = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

const CHANNELS = { 0: 1, 2: 3, 4: 2, 6: 4 };

/**
 * Encode 8-bit pixels as a PNG.
 * data: Uint8Array/Buffer of width*height*channels bytes, channels 4 (RGBA, default) or 3 (RGB).
 */
export function encodePng({ width, height, data, channels = 4 }) {
  if (!(width > 0 && height > 0)) throw new Error('encodePng: width and height must be positive');
  if (channels !== 3 && channels !== 4) throw new Error('encodePng: channels must be 3 or 4');
  const stride = width * channels;
  if (!data || data.length !== stride * height) throw new Error(`encodePng: expected ${stride * height} bytes, got ${data ? data.length : 0}`);
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const o = y * (stride + 1);
    raw[o] = 1; // filter: Sub
    for (let x = 0; x < stride; x++) {
      const cur = data[y * stride + x];
      const left = x >= channels ? data[y * stride + x - channels] : 0;
      raw[o + 1 + x] = (cur - left) & 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = channels === 4 ? 6 : 2;
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    PNG_SIG,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/**
 * Decode a non-interlaced 8-bit PNG (gray, gray+alpha, RGB, RGBA or 8-bit palette).
 * Returns { width, height, channels: 4, data } with data as RGBA bytes.
 */
export function decodePng(input) {
  const buf = toBuffer(input);
  const info = pngSize(buf);
  const { width, height, bitDepth, colorType, interlace } = info;
  if (bitDepth !== 8) throw new Error(`decodePng: only 8-bit PNGs are supported (got ${bitDepth})`);
  if (interlace !== 0) throw new Error('decodePng: interlaced PNGs are not supported');
  const srcCh = colorType === 3 ? 1 : CHANNELS[colorType];
  if (!srcCh) throw new Error(`decodePng: unsupported color type ${colorType}`);
  const idat = [];
  let palette = null;
  let trns = null;
  let off = 8;
  while (off + 12 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('latin1', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IDAT') idat.push(data);
    else if (type === 'PLTE') palette = data;
    else if (type === 'tRNS') trns = data;
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  if (colorType === 3 && !palette) throw new Error('decodePng: palette PNG without PLTE');
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * srcCh;
  if (raw.length < (stride + 1) * height) throw new Error('decodePng: image data is truncated');
  const px = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    for (let x = 0; x < stride; x++) {
      const v = raw[src + x];
      const a = x >= srcCh ? px[dst + x - srcCh] : 0;
      const b = y > 0 ? px[dst - stride + x] : 0;
      const c = x >= srcCh && y > 0 ? px[dst - stride + x - srcCh] : 0;
      let out;
      switch (f) {
        case 0: out = v; break;
        case 1: out = v + a; break;
        case 2: out = v + b; break;
        case 3: out = v + ((a + b) >> 1); break;
        case 4: out = v + paeth(a, b, c); break;
        default: throw new Error(`decodePng: bad filter type ${f} on row ${y}`);
      }
      px[dst + x] = out & 255;
    }
  }
  const rgba = Buffer.alloc(width * height * 4);
  for (let i = 0, j = 0; i < width * height; i++, j += 4) {
    const s = i * srcCh;
    if (colorType === 6) { rgba[j] = px[s]; rgba[j + 1] = px[s + 1]; rgba[j + 2] = px[s + 2]; rgba[j + 3] = px[s + 3]; }
    else if (colorType === 2) { rgba[j] = px[s]; rgba[j + 1] = px[s + 1]; rgba[j + 2] = px[s + 2]; rgba[j + 3] = 255; }
    else if (colorType === 0) { rgba[j] = rgba[j + 1] = rgba[j + 2] = px[s]; rgba[j + 3] = 255; }
    else if (colorType === 4) { rgba[j] = rgba[j + 1] = rgba[j + 2] = px[s]; rgba[j + 3] = px[s + 1]; }
    else {
      const k = px[s];
      rgba[j] = palette[k * 3]; rgba[j + 1] = palette[k * 3 + 1]; rgba[j + 2] = palette[k * 3 + 2];
      rgba[j + 3] = trns && k < trns.length ? trns[k] : 255;
    }
  }
  return { width, height, channels: 4, data: rgba };
}

/** [r, g, b, a] of a decoded image (from decodePng) at integer x, y. */
export function pixelAt(img, x, y) {
  if (x < 0 || y < 0 || x >= img.width || y >= img.height) throw new RangeError(`pixel ${x},${y} is outside ${img.width}x${img.height}`);
  const i = (y * img.width + x) * 4;
  return [img.data[i], img.data[i + 1], img.data[i + 2], img.data[i + 3]];
}
