// Per-theme light anchors (each theme's own sunrise and sunset), generated from the vendored engine at build time.
//
// Each theme (seed 12345, no clock drawn, no weather) is rendered at the 96 quarter hours: a fresh instance, one
// update of 1/30 s, then one draw. The mean luminance of its 4096 pixels, normalized per theme to 0..1 (darkest
// sample 0, brightest 1), is the theme's light curve. Its 0.5 crossings are where the picture is half-way between
// night and day, i.e. the theme's own sunrise and sunset on the wall clock:
//   rise  = the first upward 0.5 crossing between 3 and 12 h,
//   set   = the last downward 0.5 crossing between 12 and 23 h (both linearly interpolated),
//   curve = the 48 half-hour values (h = 0, 0.5, ... 23.5), 2 decimals; the sun strip draws it.
// A missing crossing falls back to FALLBACK (the default sky's orange keys at 7 and 17 h).
//
// The engine files are compiled as functions whose `globalThis` parameter is a private object, so nothing here
// touches the caller's globalThis.PixelClock (loading engine.js twice would drop every registered theme) and
// PC.drawClock can be silenced safely. (A separate node:vm context isolates too, but runs the engine ~13x slower.)
// Node built-ins only.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

export const SEED = 12345;
export const STEP = 1 / 30;
export const QUARTERS = 96;
export const FALLBACK = Object.freeze({ rise: 7, set: 17 });
/** Sanity bounds every anchor must meet; pcd-sun.js only trusts anchors inside them. */
export const BOUNDS = Object.freeze({ rise: Object.freeze([5, 9]), set: Object.freeze([15.5, 21]) });
/** Only newyear reads the date (its Dec 31 / Jan 1 logic); a fixed ordinary date keeps every curve comparable. */
export const DATE = Object.freeze({ year: 2026, month: 11, day: 15 });

const round2 = (v) => Math.round(v * 100) / 100;

/** The folder that holds engine.js: `<vendorDir>/simulator` (the vendor layout) or `<vendorDir>` itself. */
export function simulatorDir(vendorDir) {
  const nested = path.join(vendorDir, 'simulator');
  if (fs.existsSync(path.join(nested, 'engine.js'))) return nested;
  if (fs.existsSync(path.join(vendorDir, 'engine.js'))) return vendorDir;
  throw new Error(`anchors: no engine.js in ${vendorDir} or its simulator folder`);
}

/**
 * engine.js, schedule.js and every themes/*.js (sorted), each run as a function of a private `globalThis` object;
 * returns that object's PixelClock (a private engine instance: the caller's globalThis is never read or written).
 */
export function loadEngine(vendorDir) {
  const dir = simulatorDir(vendorDir);
  const themeDir = path.join(dir, 'themes');
  const themes = fs.readdirSync(themeDir).filter((f) => f.endsWith('.js')).sort();
  const files = [path.join(dir, 'engine.js'), path.join(dir, 'schedule.js'), ...themes.map((f) => path.join(themeDir, f))];
  const scope = {};
  for (const file of files) vm.compileFunction(fs.readFileSync(file, 'utf8'), ['globalThis'], { filename: file })(scope);
  const PC = scope.PixelClock;
  if (!PC || !Array.isArray(PC.themes) || PC.themes.length === 0) throw new Error('anchors: the engine registered no themes');
  return PC;
}

/** Mean Rec. 709 luma of a 0xRRGGBB pixel array, 0..1. */
export function meanLuma(px) {
  let sum = 0;
  for (let i = 0; i < px.length; i++) {
    const c = px[i];
    sum += 0.2126 * ((c >>> 16) & 255) + 0.7152 * ((c >>> 8) & 255) + 0.0722 * (c & 255);
  }
  return sum / (px.length * 255);
}

function ctxAt(q) {
  const hourFloat = q / 4;
  return {
    hours: Math.floor(hourFloat), minutes: (q % 4) * 15, seconds: 0, ms: 0, hourFloat,
    year: DATE.year, month: DATE.month, day: DATE.day, hour12: true, showDate: false, shake: false,
  };
}

/** The 96 raw quarter-hour luminance values of one theme (drawClock must already be silenced on PC). */
export function measure(PC, id) {
  const theme = PC.themeById(id);
  if (!theme || theme.id !== id) throw new Error(`anchors: unknown theme ${id}`);
  const out = new Array(QUARTERS);
  for (let q = 0; q < QUARTERS; q++) {
    const ctx = ctxAt(q);
    const inst = theme.create(new PC.Rng(SEED));
    inst.update(STEP, ctx);
    const cv = new PC.Canvas();
    inst.draw(cv, ctx);
    out[q] = meanLuma(cv.px);
  }
  return out;
}

/** Min-max normalization to 0..1 (a flat curve becomes all zeros). */
export function normalize(values) {
  const lo = Math.min(...values);
  const span = Math.max(...values) - lo;
  return values.map((v) => (span > 1e-9 ? (v - lo) / span : 0));
}

/**
 * rise/set from 96 normalized quarter-hour values: the first upward 0.5 crossing inside [3, 12] h and the last downward
 * one inside [12, 23] h, linearly interpolated; null when there is none.
 */
export function crossings(norm) {
  const n = norm.length;
  const dh = 24 / n;
  let rise = null;
  let set = null;
  for (let i = 0; i + 1 < n; i++) {
    const h0 = i * dh;
    const h1 = h0 + dh;
    const a = norm[i];
    const b = norm[i + 1];
    if (rise === null && h0 >= 3 && h1 <= 12 && a < 0.5 && b >= 0.5) rise = h0 + ((0.5 - a) / (b - a)) * dh;
    if (h0 >= 12 && h1 <= 23 && a >= 0.5 && b < 0.5) set = h0 + ((a - 0.5) / (a - b)) * dh;
  }
  return { rise, set };
}

/** One theme's anchor: { rise, set, curve } (rise/set in wall-clock hours, 2 decimals). */
export function anchorFor(PC, id) {
  const norm = normalize(measure(PC, id));
  const c = crossings(norm);
  const curve = [];
  for (let q = 0; q < QUARTERS; q += 2) curve.push(round2(norm[q]));
  return {
    rise: round2(c.rise === null ? FALLBACK.rise : c.rise),
    set: round2(c.set === null ? FALLBACK.set : c.set),
    curve,
  };
}

/**
 * generate(vendorDir) -> { <themeId>: { rise, set, curve[48] } } for every theme the engine registers, keys sorted.
 * Deterministic: the same engine files always give the same object.
 */
export function generate(vendorDir) {
  const PC = loadEngine(vendorDir);
  PC.drawClock = function () {}; // hook mode 'none': the scene only (this context is private)
  const ids = PC.themes.map((t) => t.id).sort();
  const out = {};
  for (const id of ids) out[id] = anchorFor(PC, id);
  return out;
}

/** Problems with an anchors object (empty when every theme is inside BOUNDS with a 48-value curve). */
export function check(anchors) {
  const problems = [];
  const ids = Object.keys(anchors || {});
  if (ids.length === 0) problems.push('no themes');
  for (const id of ids) {
    const a = anchors[id];
    if (!a || typeof a !== 'object') { problems.push(`${id}: not an object`); continue; }
    if (!(a.rise >= BOUNDS.rise[0] && a.rise <= BOUNDS.rise[1])) problems.push(`${id}: rise ${a.rise} outside ${BOUNDS.rise.join('-')} h`);
    if (!(a.set >= BOUNDS.set[0] && a.set <= BOUNDS.set[1])) problems.push(`${id}: set ${a.set} outside ${BOUNDS.set.join('-')} h`);
    if (!Array.isArray(a.curve) || a.curve.length !== 48 || !a.curve.every((v) => typeof v === 'number' && v >= 0 && v <= 1)) {
      problems.push(`${id}: curve must be 48 numbers in 0..1`);
    }
  }
  return problems;
}

/** anchors.json text: one theme per line, LF, trailing newline. */
export function toJson(anchors) {
  const ids = Object.keys(anchors);
  const lines = ids.map((id, i) => `  ${JSON.stringify(id)}: ${JSON.stringify(anchors[id])}${i < ids.length - 1 ? ',' : ''}`);
  return `{\n${lines.join('\n')}\n}\n`;
}

/** js/pcd-anchors.js text: a classic UMD script that sets PCD.ANCHORS (and module.exports in Node). */
export function toJs(anchors) {
  const body = toJson(anchors).trimEnd().replace(/</g, '\\u003c');
  return [
    '/* PixelClock Desktop: per-theme light anchors. Generated by tools/lib/anchors.mjs from',
    ' * vendor/pixelclock at build time: do not edit. PCD.ANCHORS[id] = { rise, set, curve[48] } (wall-clock hours). */',
    '(function (root, factory) {',
    '  var api = factory(root.PCD || (root.PCD = {}));',
    "  if (typeof module === 'object' && module.exports) module.exports = api;",
    "})(typeof globalThis !== 'undefined' ? globalThis : this, function (PCD) {",
    "  'use strict';",
    `  PCD.ANCHORS = ${body.replace(/\n/g, '\n  ')};`,
    '  return PCD.ANCHORS;',
    '});',
    '',
  ].join('\n');
}
