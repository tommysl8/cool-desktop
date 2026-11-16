// PixelClock Desktop still: the RGB image.
//
// An image is { width, height, data } with `data` a Buffer of width*height*3 RGB bytes: what PCD.bleed.compose paints
// the scene layer into (src/shared/pcd-bleed.js) and what the column's rects and glyphs (atlas.mjs) go over. Colours
// are 0xRRGGBB integers like the engine's. Pure and synchronous. Node built-ins only.
import { encodePng } from './png.mjs';

const R8 = (c) => (c >>> 16) & 255;
const G8 = (c) => (c >>> 8) & 255;
const B8 = (c) => c & 255;

/** '#rrggbb' from 0xRRGGBB. */
export function hex(c) {
  return '#' + (c >>> 0).toString(16).padStart(6, '0').slice(-6);
}

/** A new image filled with `color`. */
export function createImage(width, height, color = 0) {
  if (!(Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0)) {
    throw new Error(`image size must be positive integers (got ${width}x${height})`);
  }
  const data = Buffer.alloc(width * height * 3);
  data.fill(Buffer.from([R8(color), G8(color), B8(color)]));
  return { width, height, data };
}

/** Fill a rectangle (clipped to the image). */
export function fillRect(img, x, y, w, h, color) {
  const x0 = Math.max(0, Math.floor(x));
  const y0 = Math.max(0, Math.floor(y));
  const x1 = Math.min(img.width, Math.floor(x + w));
  const y1 = Math.min(img.height, Math.floor(y + h));
  if (x1 <= x0 || y1 <= y0) return;
  const row = Buffer.alloc((x1 - x0) * 3);
  row.fill(Buffer.from([R8(color), G8(color), B8(color)]));
  for (let yy = y0; yy < y1; yy++) row.copy(img.data, (yy * img.width + x0) * 3);
}

/** 0xRRGGBB at (x, y). */
export function pixel(img, x, y) {
  if (x < 0 || y < 0 || x >= img.width || y >= img.height) throw new RangeError(`pixel ${x},${y} is outside ${img.width}x${img.height}`);
  const o = (y * img.width + x) * 3;
  return (img.data[o] << 16) | (img.data[o + 1] << 8) | img.data[o + 2];
}

/** Encode with the still's PNG encoder (adaptive row filters; see png.mjs). */
export function encodeImage(img, { level = 6 } = {}) {
  return encodePng(img.width, img.height, img.data, 3, { level });
}
