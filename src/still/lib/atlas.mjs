// PixelClock Desktop still: the glyph atlas (built by tools/make-atlas.mjs).
//
// atlas/atlas.json describes one grey PNG per type size (device px): every glyph the still draws, rendered by headless
// Chrome in TermMono (the bundled Cascadia Mono) white on black at device scale 1, in weights 400 and 600. A glyph is
// a slot of slotW x slotH pixels; the glyph's character cell (cellW x cellH, the line box of line-height normal) starts
// padX, padY pixels into its slot, so ink outside the cell (anti-aliasing, the shade's edge) is kept. The still blends
// the slots as coverage masks in token colours, cell by cell, exactly where the wallpaper page puts its glyphs (every
// cell starts on a whole device pixel there too).
//
// atlas.json = { v, about, font: { family, file, sha256 }, browser, chars: { "400": "...", "600": "..." },
//   sizes: { "<px>": { advance, cellW, cellH, baseline, padX, padY, slotW, slotH, cols, rows: { "400": r0, "600": r1 },
//   png, width, height } } }: the glyph chars[w][i] sits in slot (cols, rows[w] + floor(i / cols)) at column i % cols.
// Node built-ins only; the PNGs are decoded once per size, on first use.
import fs from 'node:fs';
import path from 'node:path';
import { decodePng } from './png.mjs';

export const ATLAS_FILE = 'atlas.json';
export const ATLAS_VERSION = 1;
export const WEIGHTS = Object.freeze([400, 600]);
export const FALLBACK_CHAR = '?';

/** Printable ASCII, U+0020 to U+007E. */
export const ASCII = (() => {
  let s = '';
  for (let c = 0x20; c < 0x7f; c++) s += String.fromCharCode(c);
  return s;
})();
/** The look's glyphs beyond ASCII: box lines, the clock's shadow, the caret and the text accents. */
export const EXTRAS = '╭╮╰╯─│├┤░▌›»·∙⌂☼≡↓•°';
/**
 * Every glyph the still can draw, per weight. 400: all of ASCII (user text such as a city name is folded into it by
 * atlasText) and the look's glyphs above. 600 (the greeting, the temperature, the month): ASCII and the two accents a
 * bold run can hold.
 */
export const ATLAS_CHARS = Object.freeze({ 400: ASCII + EXTRAS, 600: ASCII + '·°' });

/**
 * Letters that do not decompose into a base letter and an accent, by code point (so this file stays inside the safe
 * glyph set): sharp s, ae, oe, o and l with a stroke, d with a stroke, eth, thorn, dotless i, eng, the curly quotes,
 * the dashes, the minus sign, the no-break space and the ellipsis.
 */
const FOLD = new Map([
  [0xdf, 'ss'], [0xe6, 'ae'], [0x153, 'oe'], [0xf8, 'o'], [0x142, 'l'], [0x111, 'd'], [0xf0, 'd'], [0xfe, 'th'],
  [0x131, 'i'], [0x14b, 'n'], [0x2018, "'"], [0x2019, "'"], [0x201a, "'"], [0x201c, '"'], [0x201d, '"'], [0x201e, '"'],
  [0x2013, '-'], [0x2014, '-'], [0x2212, '-'], [0xa0, ' '], [0x2026, '...'],
].map(([cp, s]) => [String.fromCodePoint(cp), s]));
/** Combining accents (NFD splits an accented letter into its base letter and one of these). */
const isAccent = (ch) => { const cp = ch.codePointAt(0); return cp >= 0x300 && cp <= 0x36f; };

/**
 * User text (a city name) in glyphs the atlas has at `weight`: accents dropped (NFD), a few letters folded (see FOLD),
 * anything else '?'. The still never shows a missing glyph box; the live page shows such text as typed.
 */
export function atlasText(text, weight = 400) {
  const have = ATLAS_CHARS[weight === 600 ? 600 : 400];
  let out = '';
  for (const ch of String(text == null ? '' : text).normalize('NFD')) {
    if (have.includes(ch)) out += ch;
    else if (isAccent(ch)) continue;
    else if (FOLD.has(ch)) out += FOLD.get(ch);
    else out += FALLBACK_CHAR;
  }
  return out;
}

function checkMeta(meta, file) {
  const bad = (why) => new Error(`${file}: ${why}`);
  if (!meta || typeof meta !== 'object') throw bad('not an object');
  if (meta.v !== ATLAS_VERSION) throw bad(`version ${meta.v} (this still reads ${ATLAS_VERSION})`);
  if (!meta.chars || typeof meta.chars !== 'object' || !meta.sizes || typeof meta.sizes !== 'object') throw bad('no chars or sizes');
  for (const [px, s] of Object.entries(meta.sizes)) {
    for (const k of ['cellW', 'cellH', 'baseline', 'padX', 'padY', 'slotW', 'slotH', 'cols', 'width', 'height']) {
      if (!Number.isInteger(s[k]) || s[k] < 0) throw bad(`size ${px}: ${k} must be a whole number`);
    }
    if (typeof s.png !== 'string' || !/^[\w.-]+\.png$/.test(s.png)) throw bad(`size ${px}: bad png name`);
  }
  return meta;
}

/** One type size of the atlas: metrics plus glyph masks. */
export class AtlasFace {
  constructor(dir, sizePx, meta, chars) {
    Object.assign(this, meta);
    this.size = Number(sizePx);
    this.dir = dir;
    this.chars = chars;
    this.img = null;
    this.cache = new Map();
  }

  /** The decoded PNG (grey), loaded once. */
  image() {
    if (!this.img) {
      const img = decodePng(fs.readFileSync(path.join(this.dir, this.png)));
      if (img.width !== this.width || img.height !== this.height || img.channels !== 1) {
        throw new Error(`atlas ${this.png}: ${img.width}x${img.height}x${img.channels}, atlas.json says ${this.width}x${this.height}x1`);
      }
      this.img = img;
    }
    return this.img;
  }

  /** True when the atlas has `ch` at `weight` (400 or 600). */
  has(ch, weight = 400) {
    const list = this.chars[weight === 600 ? 600 : 400] || '';
    return list.includes(ch);
  }

  /**
   * The mask of `ch` at `weight`: { data (slotW x slotH coverage, 0-255), w, h, ox, oy (the slot's offset from the
   * cell's top-left: -padX, -padY), ink: { x0, y0, x1, y1 } | null (the inked box inside the slot; null: blank) }.
   * A character the atlas does not have draws FALLBACK_CHAR; 600 falls back to 400 first.
   */
  glyph(ch, weight = 400) {
    const w = weight === 600 && this.has(ch, 600) ? 600 : 400;
    const c = this.has(ch, w) ? ch : FALLBACK_CHAR;
    const key = w + ':' + c;
    let g = this.cache.get(key);
    if (g) return g;
    const i = this.chars[w].indexOf(c);
    const col = i % this.cols;
    const row = this.rows[w] + Math.floor(i / this.cols);
    const img = this.image();
    const data = new Uint8Array(this.slotW * this.slotH);
    let x0 = this.slotW;
    let y0 = this.slotH;
    let x1 = -1;
    let y1 = -1;
    for (let y = 0; y < this.slotH; y++) {
      const src = (row * this.slotH + y) * img.width + col * this.slotW;
      for (let x = 0; x < this.slotW; x++) {
        const v = img.data[src + x];
        if (!v) continue;
        data[y * this.slotW + x] = v;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
    g = { ch: c, weight: w, data, w: this.slotW, h: this.slotH, ox: -this.padX, oy: -this.padY, ink: x1 < 0 ? null : { x0, y0, x1: x1 + 1, y1: y1 + 1 } };
    this.cache.set(key, g);
    return g;
  }
}

/** The atlas in `dir` (atlas.json + PNGs). Returns { dir, meta, sizes: [px...], face(px) }. */
export function loadAtlas(dir) {
  const file = path.join(dir, ATLAS_FILE);
  const meta = checkMeta(JSON.parse(fs.readFileSync(file, 'utf8')), file);
  const faces = new Map();
  const sizes = Object.keys(meta.sizes).map(Number).sort((a, b) => a - b);
  return {
    dir,
    meta,
    sizes,
    /** The face for a type size in device px (throws for a size the atlas does not have). */
    face(px) {
      const key = String(px);
      if (!meta.sizes[key]) throw new Error(`the atlas has no ${px} px face (it has ${sizes.join(', ')})`);
      if (!faces.has(key)) faces.set(key, new AtlasFace(dir, key, meta.sizes[key], meta.chars));
      return faces.get(key);
    },
  };
}

/**
 * Blend one glyph mask into an RGB image (see compose.mjs: { width, height, data }) with its cell's top-left at (x, y),
 * in colour `color` (0xRRGGBB): out = dst + (color - dst) x coverage. Only the inked box is visited.
 */
export function blendGlyph(img, g, x, y, color) {
  if (!g.ink) return;
  const r = (color >>> 16) & 255;
  const gr = (color >>> 8) & 255;
  const b = color & 255;
  const W = img.width;
  const H = img.height;
  const d = img.data;
  for (let my = g.ink.y0; my < g.ink.y1; my++) {
    const iy = y + g.oy + my;
    if (iy < 0 || iy >= H) continue;
    for (let mx = g.ink.x0; mx < g.ink.x1; mx++) {
      const a = g.data[my * g.w + mx];
      if (!a) continue;
      const ix = x + g.ox + mx;
      if (ix < 0 || ix >= W) continue;
      const o = (iy * W + ix) * 3;
      if (a === 255) {
        d[o] = r;
        d[o + 1] = gr;
        d[o + 2] = b;
      } else {
        const t = a / 255;
        d[o] = Math.round(d[o] + (r - d[o]) * t);
        d[o + 1] = Math.round(d[o + 1] + (gr - d[o + 1]) * t);
        d[o + 2] = Math.round(d[o + 2] + (b - d[o + 2]) * t);
      }
    }
  }
}

/**
 * Draw a line of runs ({ text, tone, bold } as PCD.ascii builds them) with its first cell's top-left at device (x, y),
 * one glyph per cell of face.cellW. colorOf(tone) gives 0xRRGGBB (plain runs, tone null, are 'text'). Returns the
 * number of cells drawn.
 */
export function drawRuns(img, face, x, y, runs, colorOf) {
  let c = 0;
  for (const run of runs || []) {
    const text = String(run.text == null ? '' : run.text);
    const color = colorOf(run.tone || 'text');
    for (const ch of text) {
      if (ch !== ' ') blendGlyph(img, face.glyph(ch, run.bold ? 600 : 400), x + c * face.cellW, y, color);
      c++;
    }
  }
  return c;
}
