#!/usr/bin/env node
// node tools/make-icons.mjs [--check] [--out <folder>]
//
// The new tab's icons: ONE 16x16 pixel-art PixelClock, drawn with the clock's own engine
// helpers (PC.Canvas, PC.skyAt, PC.vgradient, PC.drawDigit and PC.Canvas.sprite from vendor/pixelclock/simulator/
// engine.js, run in a private vm context: no DOM, no browser), then scaled by whole pixels x1, x2, x3 and x8 into
// icon16.png, icon32.png, icon48.png and icon128.png (nearest neighbour: every art pixel is a k x k block, so the
// icons stay crisp). RGBA PNGs from tools/lib/png.mjs; the four corner pixels are transparent.
//
// The picture: a light-wood frame (token frame) around the clock's LED screen at dusk (the engine's own sky at 17:00),
// the hour "12" in the clock's 3x5 digits in cream (token text) with the clock's dark drop shadow, a setting sun and
// dark hills. The palette is the clock's warm dark one (design/tokens.json where a token fits).
//
// The PNGs are committed in src/newtab/icons/ so the build never draws. --check renders again and compares the pixels
// with the committed files (writes nothing; exit code 1 on any difference). Node built-ins only.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { decodePng, encodePng } from './lib/png.mjs';
import { ensureDir, writeBytes } from './lib/fsx.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, '..');
export const ICON_DIR = path.join(ROOT, 'src', 'newtab', 'icons');
export const ART_SIZE = 16;
/** Output size -> whole-pixel scale of the 16x16 art. */
export const SCALES = Object.freeze({ 16: 1, 32: 2, 48: 3, 128: 8 });
export const SIZES = Object.freeze([16, 32, 48, 128]);

/** The colours (0xRRGGBB). Tokens of design/tokens.json where one fits, the rest the clock's own. */
export const PALETTE = Object.freeze({
  frame: 0x9a6a40, // token frame: light wood
  text: 0xece4d8, // token text: the digits
  shadow: 0x141016, // token bg: the digits' drop shadow
  sun: 0xffd27a,
  hill: 0x2b1d1a,
  ground: 0x3a2a20,
});

/** The synced engine (vendor/pixelclock/simulator/engine.js) in a private context: its PixelClock object. */
export function loadEngine(root = ROOT) {
  const file = path.join(root, 'vendor', 'pixelclock', 'simulator', 'engine.js');
  const context = vm.createContext({});
  vm.runInContext(fs.readFileSync(file, 'utf8'), context, { filename: 'engine.js' });
  const PC = context.PixelClock;
  for (const name of ['Canvas', 'skyAt', 'vgradient', 'drawDigit']) {
    if (!PC || typeof PC[name] !== 'function') throw new Error(`vendor engine.js has no PixelClock.${name} (run node tools/sync.mjs)`);
  }
  return PC;
}

/**
 * The 16x16 art: { w, h, rgba (Uint8Array, 16*16*4) }. Drawn with the engine helpers on a PC.Canvas(16, 16).
 */
export function drawArt(PC = loadEngine()) {
  const P = PALETTE;
  const cv = new PC.Canvas(ART_SIZE, ART_SIZE);
  cv.clear(P.frame);
  // The LED screen inside the 1-pixel frame: the clock's own sky at 17:00, hills and ground below the horizon.
  const [top, bottom] = PC.skyAt(17);
  PC.vgradient(cv, 1, 1, 14, 10, top, bottom);
  cv.sprite(['..ss', '.ssss'], 9, 9, { s: P.sun });
  cv.sprite(['hh', 'hhhh', 'hhhhhhh'], 1, 8, { h: P.hill });
  cv.rect(1, 11, 14, 14, P.ground);
  cv.sprite(['hhhhhhhhhhhhhh'], 1, 11, { h: P.hill });
  // "12" in the clock's 3x5 digits at 1x, with the clock's drop shadow one pixel down and right.
  PC.drawDigit(cv, 1, 5, 3, P.shadow, 1);
  PC.drawDigit(cv, 2, 9, 3, P.shadow, 1);
  PC.drawDigit(cv, 1, 4, 2, P.text, 1);
  PC.drawDigit(cv, 2, 8, 2, P.text, 1);
  const rgba = new Uint8Array(ART_SIZE * ART_SIZE * 4);
  for (let i = 0; i < ART_SIZE * ART_SIZE; i++) {
    const c = cv.px[i];
    rgba[i * 4] = (c >> 16) & 255;
    rgba[i * 4 + 1] = (c >> 8) & 255;
    rgba[i * 4 + 2] = c & 255;
    rgba[i * 4 + 3] = 255;
  }
  // Rounded corners: the four corner pixels are transparent (colour kept black so the PNG is canonical).
  for (const [x, y] of [[0, 0], [ART_SIZE - 1, 0], [0, ART_SIZE - 1], [ART_SIZE - 1, ART_SIZE - 1]]) {
    rgba.fill(0, (y * ART_SIZE + x) * 4, (y * ART_SIZE + x) * 4 + 4);
  }
  return { w: ART_SIZE, h: ART_SIZE, rgba };
}

/** Nearest-neighbour scale by a whole number k: every source pixel becomes a k x k block. */
export function scaleArt(art, k) {
  if (!(Number.isInteger(k) && k >= 1)) throw new Error(`scaleArt: k must be a whole number >= 1 (got ${k})`);
  const w = art.w * k;
  const h = art.h * k;
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const s = (Math.floor(y / k) * art.w + Math.floor(x / k)) * 4;
      const d = (y * w + x) * 4;
      out[d] = art.rgba[s];
      out[d + 1] = art.rgba[s + 1];
      out[d + 2] = art.rgba[s + 2];
      out[d + 3] = art.rgba[s + 3];
    }
  }
  return { w, h, rgba: out };
}

/** { size: PNG Buffer } for every icon size. */
export function renderIcons(PC = loadEngine()) {
  const art = drawArt(PC);
  const out = {};
  for (const size of SIZES) {
    const img = scaleArt(art, SCALES[size]);
    out[size] = encodePng({ width: img.w, height: img.h, data: img.rgba, channels: 4 });
  }
  return out;
}

/**
 * Differences between a PNG (file path or Buffer) and the expected icon of `size`: [] when every pixel matches.
 * Compares decoded RGBA pixels, not bytes (another zlib may compress the same pixels differently).
 */
export function compareIcon(png, size, expected) {
  let img;
  try {
    img = decodePng(png);
  } catch (e) {
    return [`icon${size}.png: ${e.message}`];
  }
  if (img.width !== size || img.height !== size) return [`icon${size}.png is ${img.width}x${img.height}, expected ${size}x${size}`];
  const want = decodePng(expected);
  let diff = 0;
  for (let i = 0; i < want.data.length; i++) if (want.data[i] !== img.data[i]) diff++;
  return diff ? [`icon${size}.png: ${diff} channel values differ from a fresh render (run node tools/make-icons.mjs)`] : [];
}

/** Write (or, with check, compare) the icons. Returns { code, files, problems }. */
export function makeIcons({ outDir = ICON_DIR, check = false, root = ROOT } = {}) {
  const pngs = renderIcons(loadEngine(root));
  const files = [];
  const problems = [];
  if (!check) ensureDir(outDir);
  for (const size of SIZES) {
    const file = path.join(outDir, `icon${size}.png`);
    files.push(file);
    if (check) {
      if (!fs.existsSync(file)) problems.push(`icon${size}.png is missing`);
      else problems.push(...compareIcon(fs.readFileSync(file), size, pngs[size]));
    } else {
      writeBytes(file, pngs[size]);
    }
  }
  return { code: problems.length ? 1 : 0, files, problems, bytes: Object.fromEntries(SIZES.map((s) => [s, pngs[s].length])) };
}

function isMainModule() {
  if (typeof import.meta.main === 'boolean') return import.meta.main;
  try {
    return !!process.argv[1] && path.relative(fs.realpathSync(process.argv[1]), fileURLToPath(import.meta.url)) === '';
  } catch {
    return false;
  }
}

if (isMainModule()) {
  const argv = process.argv.slice(2);
  const check = argv.includes('--check');
  const i = argv.indexOf('--out');
  const outDir = i >= 0 && argv[i + 1] ? path.resolve(argv[i + 1]) : ICON_DIR;
  const unknown = argv.filter((a, j) => a !== '--check' && a !== '--out' && !(j > 0 && argv[j - 1] === '--out'));
  if (unknown.length) {
    console.error(`unknown argument(s): ${unknown.join(' ')}\nusage: node tools/make-icons.mjs [--check] [--out <folder>]`);
    process.exitCode = 1;
  } else {
    try {
      const r = makeIcons({ outDir, check });
      if (check) {
        for (const p of r.problems) console.log(`FAIL: ${p}`);
        if (!r.problems.length) console.log(`OK: ${r.files.length} icons match a fresh render (${SIZES.join(', ')} px)`);
      } else {
        for (const f of r.files) console.log(`write ${f} (${path.basename(f).replace(/\D/g, '')} px, ${r.bytes[Number(path.basename(f).replace(/\D/g, ''))]} bytes, RGBA)`);
      }
      process.exitCode = r.code;
    } catch (e) {
      console.error(e && e.stack ? e.stack : e);
      process.exitCode = 1;
    }
  }
}
