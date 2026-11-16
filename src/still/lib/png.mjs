// PixelClock Desktop still: a small PNG encoder and decoder (8-bit grey, RGB or RGBA, no interlace). Node built-ins only.
//
// The encoder picks a filter per row from what the still is made of, with native comparisons instead of per-byte cost
// sums: a row equal to the one above is Up and all zeros (most rows: every scene row is k device rows of the same
// pixels); a row that mostly repeats the one above (the column's text over the layer) is Up too; any other row is Sub
// (the first row of a scene row: flat k-wide blocks and bands, the smooth gradient in small steps). A 3840x2160 picture
// comes out about 40 % smaller than with render.js's png() (filter None on every row: 149 KB against 236 KB, measured),
// in about the same time; the atlas needs grey PNGs, which render.js's png() does not write. The decoder reads the atlas
// PNGs (grey) at run time and any 8-bit PNG in tests.
import zlib from 'node:zlib';

const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** Bytes per native comparison when a row is checked for how much of the row above it repeats. */
const SEGMENT = 192;
const COLOR_TYPE = { 1: 0, 3: 2, 4: 6 };
const CHANNELS = { 0: 1, 2: 3, 6: 4 };

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(body) >>> 0);
  return Buffer.concat([len, body, crc]);
}

/**
 * Encode `data` (width * height * channels bytes, row-major) as a PNG. channels: 1 (grey), 3 (RGB) or 4 (RGBA).
 * opts: { level = 6 (zlib) }. Deterministic: the same pixels always give the same bytes.
 */
export function encodePng(width, height, data, channels = 3, { level = 6 } = {}) {
  if (!(Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0)) throw new Error(`png: bad size ${width}x${height}`);
  if (!COLOR_TYPE.hasOwnProperty(channels)) throw new Error(`png: channels must be 1, 3 or 4 (got ${channels})`);
  const stride = width * channels;
  if (!data || data.length !== stride * height) throw new Error(`png: expected ${stride * height} bytes, got ${data && data.length}`);
  const src = Buffer.isBuffer(data) ? data : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const s = y * stride;
    const o = y * (stride + 1);
    if (y > 0) {
      if (src.compare(src, s - stride, s, s, s + stride) === 0) {
        raw[o] = 2; // Up: a repeated row is all zeros (Buffer.alloc already zeroed it)
        continue;
      }
      // a row that mostly repeats the one above (text over the repeated layer): Up leaves zeros around the glyphs
      let same = 0;
      for (let a = 0; a < stride; a += SEGMENT) {
        const b = Math.min(stride, a + SEGMENT);
        if (src.compare(src, s - stride + a, s - stride + b, s + a, s + b) === 0) same += b - a;
      }
      if (same * 2 >= stride) {
        raw[o] = 2;
        for (let i = 0; i < stride; i++) raw[o + 1 + i] = (src[s + i] - src[s - stride + i]) & 255;
        continue;
      }
    }
    // Sub: flat runs (k-wide blocks, bands) become zeros and the smooth veil small steps
    raw[o] = 1;
    for (let i = 0; i < channels; i++) raw[o + 1 + i] = src[s + i];
    for (let i = channels; i < stride; i++) raw[o + 1 + i] = (src[s + i] - src[s + i - channels]) & 255;
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = COLOR_TYPE[channels];
  return Buffer.concat([SIG, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level })), chunk('IEND', Buffer.alloc(0))]);
}

/**
 * Decode an 8-bit, non-interlaced grey, RGB or RGBA PNG (a Buffer). Returns { width, height, channels, data } with
 * `data` the raw pixels (no filter bytes). Throws on anything else.
 */
export function decodePng(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 33 || !buf.subarray(0, 8).equals(SIG)) throw new Error('png: not a PNG');
  let pos = 8;
  let width = 0;
  let height = 0;
  let channels = 0;
  const idat = [];
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('latin1', pos + 4, pos + 8);
    const body = buf.subarray(pos + 8, pos + 8 + len);
    if (body.length !== len) throw new Error('png: truncated chunk');
    if (type === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      if (body[8] !== 8) throw new Error(`png: bit depth ${body[8]} (only 8)`);
      if (!CHANNELS.hasOwnProperty(body[9])) throw new Error(`png: colour type ${body[9]} (only grey, RGB, RGBA)`);
      if (body[12] !== 0) throw new Error('png: interlaced');
      channels = CHANNELS[body[9]];
    } else if (type === 'IDAT') {
      idat.push(body);
    } else if (type === 'IEND') {
      break;
    }
    pos += 12 + len;
  }
  if (!width || !height || !channels) throw new Error('png: no IHDR');
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  if (raw.length < (stride + 1) * height) throw new Error('png: image data too short');
  const out = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)];
    const s = y * (stride + 1) + 1;
    const o = y * stride;
    const p = o - stride;
    for (let i = 0; i < stride; i++) {
      const x = raw[s + i];
      const a = i >= channels ? out[o + i - channels] : 0;
      const b = y > 0 ? out[p + i] : 0;
      const c = y > 0 && i >= channels ? out[p + i - channels] : 0;
      let v;
      if (f === 0) v = x;
      else if (f === 1) v = x + a;
      else if (f === 2) v = x + b;
      else if (f === 3) v = x + ((a + b) >> 1);
      else if (f === 4) {
        const pp = a + b - c;
        const pa = Math.abs(pp - a);
        const pb = Math.abs(pp - b);
        const pc = Math.abs(pp - c);
        v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
      } else throw new Error(`png: unknown filter ${f}`);
      out[o + i] = v & 255;
    }
  }
  return { width, height, channels, data: out };
}
