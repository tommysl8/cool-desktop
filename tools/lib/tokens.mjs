// PixelClock Desktop tokens: design/tokens.json -> tokens.css (CSS variables) and pcd-tokens.js (PCD.TOKENS), plus the
// contrast gate: one palette JSON, a UMD table and CSS variables, a WCAG gate that stops the build.
//
// Contract with tools/build.mjs (generate stage) and tools/validate.mjs:
//   generate({ root, config }) -> { files: { 'pcd-tokens.js': text, 'tokens.css': text }, rows, tokens }
//                                 throws when tokens.json is invalid or a gated pair misses its minimum
//   contrastRows({ root })     -> [{ token, against, fg, bg, ratio, min, pass, design, why }] (the validator's table)
// Other exports: TOKENS_REL, REQUIRED_COLORS, RUNTIME_VARS, RESERVED_KEYS, tokensPath, loadTokens, validateTokens,
// jsKey, cssVar, colorOf, contrastReport, infoRows, describeRow, assertContrast, tokensTable, tokensJs, tokensCss, main.
//
// PCD.TOKENS (generated, see tokensTable): every colour by its token name as '#rrggbb' (and a camelCase alias for
// hyphenated names, e.g. woodDark), plus the reserved keys version, names (colour names in order), int (0xRRGGBB
// numbers), css (variable names), derived (the clock and bar colour mixes), type (stack, weights, ladders, divisors,
// floors), contrast ([{ fg, on, min, ratio }], ratio floored to 2 decimals), never ([{ fg, on }]) and mono (the stack).
//
// tokens.css: :root { --<token>: #rrggbb; ... --clock (the run-time default);
// --mono (the font stack); --weight; --weight-bold; color-scheme: dark }. Every text write is the build's
// (UTF-8 without BOM, LF). Node built-ins only. CLI: node tools/lib/tokens.mjs prints the contrast table.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { contrast, formatRatio, hexToRgb, isHex6 } from './color.mjs';
import { readJsonStrict } from './fsx.mjs';
import { printReport } from './report.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, '..', '..');
/** design/tokens.json, relative to the repo root. */
export const TOKENS_REL = 'design/tokens.json';
/** The palette's colour names (all must exist). */
export const REQUIRED_COLORS = ['bg', 'panel', 'field', 'line', 'text', 'muted', 'faint', 'accent', 'frame', 'ring', 'wood', 'wood-dark'];
/** CSS variables the console sets at run time (PCD.color), with the token each one defaults to in tokens.css. */
export const RUNTIME_VARS = Object.freeze({ clock: 'text' });
/** Keys of PCD.TOKENS that are not colours (a colour may not use them). */
export const RESERVED_KEYS = ['version', 'names', 'int', 'css', 'derived', 'type', 'contrast', 'never', 'mono'];
const NAME_RE = /^[a-z][a-z0-9-]*$/;
const PROFILES = ['wallpaper', 'still', 'newtab'];

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/** Absolute path of design/tokens.json under root. */
export function tokensPath(root = ROOT) {
  return path.join(root, ...TOKENS_REL.split('/'));
}

/** 'wood-dark' -> 'woodDark'. */
export function jsKey(name) {
  return String(name).replace(/-([a-z0-9])/g, (m, c) => c.toUpperCase());
}

/** 'wood-dark' -> '--wood-dark'. */
export function cssVar(name) {
  return '--' + name;
}

/** The '#rrggbb' (lower case) of a colour token; throws for an unknown name. */
export function colorOf(doc, name) {
  const c = doc && doc.colors && doc.colors[name];
  if (!c || !isHex6(c.value)) throw new Error(`tokens: no colour "${name}"`);
  return c.value.toLowerCase();
}

/** Structure check of a parsed tokens.json. Returns a list of problems (empty = valid). */
export function validateTokens(doc) {
  const errors = [];
  if (!isObject(doc)) return ['tokens.json: top level must be an object'];
  if (doc.version !== 1) errors.push(`tokens.json: "version" must be 1 (got ${JSON.stringify(doc.version)})`);
  const colors = doc.colors;
  if (!isObject(colors)) return [...errors, 'tokens.json: "colors" must be an object'];
  for (const name of REQUIRED_COLORS) if (!(name in colors)) errors.push(`colors.${name}: missing (every palette colour is required)`);
  const names = Object.keys(colors);
  for (const name of names) {
    const c = colors[name];
    if (!NAME_RE.test(name)) errors.push(`colors: invalid token name ${JSON.stringify(name)} (lower-case letters, digits, "-")`);
    if (RESERVED_KEYS.includes(name) || RESERVED_KEYS.includes(jsKey(name)) || name in RUNTIME_VARS) errors.push(`colors.${name}: reserved name`);
    if (name.includes('-') && names.includes(jsKey(name))) errors.push(`colors.${name}: its alias ${jsKey(name)} is also a token`);
    if (!isObject(c)) { errors.push(`colors.${name}: must be an object { value, source, role }`); continue; }
    if (!isHex6(c.value)) errors.push(`colors.${name}.value: ${JSON.stringify(c.value)} is not #rrggbb`);
    for (const k of ['source', 'role']) {
      if (typeof c[k] !== 'string' || !c[k].trim()) errors.push(`colors.${name}.${k}: must be a non-empty string`);
      else if (c[k].includes('*/') || /[\r\n]/.test(c[k])) errors.push(`colors.${name}.${k}: no line breaks or "*/" (it becomes a CSS comment)`);
    }
    if ('decorative' in c && typeof c.decorative !== 'boolean') errors.push(`colors.${name}.decorative: must be true or false`);
  }
  const known = (n) => typeof n === 'string' && isObject(colors[n]) && isHex6(colors[n].value);

  const con = doc.contrast;
  if (!isObject(con) || !Array.isArray(con.pairs) || con.pairs.length === 0) errors.push('contrast.pairs: must be a non-empty array');
  else {
    const seen = new Set();
    con.pairs.forEach((p, i) => {
      const where = `contrast.pairs[${i}]`;
      if (!isObject(p)) { errors.push(`${where}: must be an object { fg, on, min }`); return; }
      if (!known(p.fg)) errors.push(`${where}.fg: unknown colour ${JSON.stringify(p.fg)}`);
      if (!known(p.on)) errors.push(`${where}.on: unknown colour ${JSON.stringify(p.on)}`);
      if (!isNum(p.min) || p.min < 1 || p.min > 21) errors.push(`${where}.min: must be a ratio from 1 to 21`);
      if ('design' in p && (!isNum(p.design) || p.design < 1)) errors.push(`${where}.design: must be a ratio`);
      const key = `${p.fg}/${p.on}`;
      if (seen.has(key)) errors.push(`${where}: ${key} is listed twice`);
      seen.add(key);
    });
    for (const list of ['decorative', 'never']) {
      if (list in con && !Array.isArray(con[list])) { errors.push(`contrast.${list}: must be an array`); continue; }
      (con[list] || []).forEach((p, i) => {
        const where = `contrast.${list}[${i}]`;
        if (!isObject(p) || !known(p.fg)) errors.push(`${where}.fg: unknown colour`);
        else if (!known(p.on)) errors.push(`${where}.on: unknown colour ${JSON.stringify(p.on)}`);
        else if (list === 'never' && seen.has(`${p.fg}/${p.on}`)) errors.push(`${where}: ${p.fg}/${p.on} is also a gated pair`);
      });
    }
  }

  const d = doc.derived;
  if (!isObject(d)) errors.push('derived: must be an object');
  else {
    const frac = (v) => isNum(v) && v >= 0 && v <= 1;
    if (!isObject(d.clock) || !frac(d.clock.mix) || !known(d.clock.toward) || !known(d.clock.on) || !known(d.clock.fallback) || !isNum(d.clock.min)) errors.push('derived.clock: needs mix (0..1), toward, on, fallback (colours) and min');
    if (!isObject(d.bar) || !known(d.bar.from) || !known(d.bar.to) || !known(d.bar.now) || !(isNum(d.bar.gain) && d.bar.gain > 0)) errors.push('derived.bar: needs from, to, now (colours) and gain > 0');
  }

  const t = doc.type;
  if (!isObject(t)) errors.push('type: must be an object');
  else {
    for (const k of ['family', 'file', 'fallback', 'stack']) if (typeof t[k] !== 'string' || !t[k].trim()) errors.push(`type.${k}: must be a non-empty string`);
    if (typeof t.stack === 'string') {
      if (!t.stack.startsWith(t.family)) errors.push('type.stack: must start with type.family');
      if (!t.stack.includes(t.fallback)) errors.push('type.stack: must include type.fallback');
      if (!/monospace\s*$/.test(t.stack)) errors.push('type.stack: must end with monospace');
      if (/[;{}<>]/.test(t.stack)) errors.push('type.stack: no ; { } < > (it becomes CSS)');
    }
    if (!isObject(t.weights) || t.weights.normal !== 400 || t.weights.bold !== 600) errors.push('type.weights: must be { normal: 400, bold: 600 } (the look uses only these two)');
    if (!(Number.isInteger(t.fontTimeoutMs) && t.fontTimeoutMs > 0)) errors.push('type.fontTimeoutMs: must be a positive integer');
    for (const p of PROFILES) {
      const lad = isObject(t.ladder) ? t.ladder[p] : null;
      if (!Array.isArray(lad) || !lad.length || !lad.every((s, i) => Number.isInteger(s) && s > 0 && (i === 0 || s > lad[i - 1]))) errors.push(`type.ladder.${p}: must be ascending positive integers (device px)`);
      if (!isObject(t.div) || !(isNum(t.div[p]) && t.div[p] > 0)) errors.push(`type.div.${p}: must be a positive number`);
      const f = isObject(t.floor) ? t.floor[p] : null;
      if (!isObject(f) || !(isNum(f.device) && f.device >= 0) || !(isNum(f.css) && f.css >= 0)) errors.push(`type.floor.${p}: must be { device, css } (numbers >= 0)`);
    }
  }
  return errors;
}

/** Load (strict JSON: a BOM fails) and, by default, validate design/tokens.json. */
export function loadTokens(root = ROOT, { validate = true } = {}) {
  const doc = readJsonStrict(tokensPath(root), TOKENS_REL);
  if (validate) {
    const errors = validateTokens(doc);
    if (errors.length) throw new Error(`${TOKENS_REL} is invalid:\n  ${errors.join('\n  ')}`);
  }
  return doc;
}

/**
 * The gated pairs: [{ token, against, fg, bg, ratio, min, pass, design, why, kind: 'gate' }] in tokens.json order.
 * ratio is the exact WCAG 2.2 ratio (tools/lib/color.mjs).
 */
export function contrastReport(doc) {
  return doc.contrast.pairs.map((p) => {
    const fg = colorOf(doc, p.fg);
    const bg = colorOf(doc, p.on);
    const ratio = contrast(fg, bg);
    return { token: p.fg, against: p.on, fg, bg, ratio, min: p.min, pass: ratio >= p.min, design: p.design ?? null, why: p.why || '', kind: 'gate' };
  });
}

/** The pairs that are only reported: decorative ones and the forbidden (never) ones whose ratio is computable. */
export function infoRows(doc) {
  const out = [];
  for (const kind of ['decorative', 'never']) {
    for (const p of doc.contrast[kind] || []) {
      const row = { token: p.fg, against: p.on, fg: colorOf(doc, p.fg), bg: null, ratio: null, min: null, pass: null, design: p.design ?? null, why: p.why || '', kind };
      if (doc.colors[p.on]) {
        row.bg = colorOf(doc, p.on);
        row.ratio = contrast(row.fg, row.bg);
      }
      out.push(row);
    }
  }
  return out;
}

/** One line for a row: 'text #ece4d8 on bg #141016: 14.93:1 (min 4.5:1)'. */
export function describeRow(r) {
  const ratio = r.ratio === null ? 'run time' : `${formatRatio(r.ratio)}:1`;
  const min = r.min === null ? (r.kind === 'never' ? 'never shown' : 'decorative') : `min ${r.min}:1`;
  return `${r.token} ${r.fg} on ${r.against}${r.bg ? ' ' + r.bg : ''}: ${ratio} (${min}${r.design !== null ? `, designed ${r.design}:1` : ''})`;
}

/** The build gate: throws an Error listing every failing pair; returns the report when all pass. */
export function assertContrast(doc) {
  const rows = contrastReport(doc);
  const bad = rows.filter((r) => !r.pass);
  if (bad.length) {
    const err = new Error(`contrast gate failed (${bad.length} of ${rows.length} pairs):\n  ${bad.map(describeRow).join('\n  ')}`);
    err.rows = bad;
    throw err;
  }
  return rows;
}

/** The validator's table (tools/validate.mjs): the gated rows of design/tokens.json under root. */
export function contrastRows({ root = ROOT } = {}) {
  return contrastReport(loadTokens(root));
}

/** The plain object that pcd-tokens.js publishes as PCD.TOKENS (see the header). */
export function tokensTable(doc) {
  const names = Object.keys(doc.colors);
  const table = { version: doc.version };
  const int = {};
  const css = {};
  for (const name of names) {
    const hex = colorOf(doc, name);
    const [r, g, b] = hexToRgb(hex);
    const n = (r << 16) | (g << 8) | b;
    table[name] = hex;
    int[name] = n;
    css[name] = cssVar(name);
    const alias = jsKey(name);
    if (alias !== name) {
      table[alias] = hex;
      int[alias] = n;
      css[alias] = cssVar(name);
    }
  }
  const d = doc.derived;
  const t = doc.type;
  table.names = names;
  table.int = int;
  table.css = css;
  table.derived = {
    clock: { mix: d.clock.mix, toward: d.clock.toward, min: d.clock.min, on: d.clock.on, fallback: d.clock.fallback },
    bar: { from: d.bar.from, to: d.bar.to, gain: d.bar.gain, now: d.bar.now },
  };
  table.type = {
    family: t.family,
    file: t.file,
    fallback: t.fallback,
    stack: t.stack,
    weights: { normal: t.weights.normal, bold: t.weights.bold },
    fontTimeoutMs: t.fontTimeoutMs,
    ladder: Object.fromEntries(PROFILES.map((p) => [p, [...t.ladder[p]]])),
    div: Object.fromEntries(PROFILES.map((p) => [p, t.div[p]])),
    floor: Object.fromEntries(PROFILES.map((p) => [p, { device: t.floor[p].device, css: t.floor[p].css }])),
  };
  table.contrast = contrastReport(doc).map((r) => ({ fg: r.token, on: r.against, min: r.min, ratio: Number(formatRatio(r.ratio)) }));
  table.never = (doc.contrast.never || []).map((p) => ({ fg: p.fg, on: p.on }));
  table.mono = t.stack;
  return table;
}

function prettyJson(value, indent) {
  const json = JSON.stringify(value, null, 2)
    // keep short arrays of numbers / strings on one line
    .replace(/\[\n\s+(-?\d+(?:\.\d+)?(?:,\n\s+-?\d+(?:\.\d+)?)*)\n\s*\]/g, (m, inner) => '[' + inner.split(/,\n\s+/).join(', ') + ']')
    .replace(/\[\n\s+("[^"\n]*"(?:,\n\s+"[^"\n]*")*)\n\s*\]/g, (m, inner) => '[' + inner.split(/,\n\s+/).join(', ') + ']')
    // and short objects of plain values ({ "fg": "text", "on": "bg", ... }) too
    .replace(/\{\n\s+((?:"[^"\n]+": (?:"[^"\n]*"|-?\d+(?:\.\d+)?|true|false|null)(?:,\n\s+)?)+)\n\s*\}/g, (m, inner) => '{ ' + inner.split(/,\n\s+/).join(', ') + ' }');
  return json.split('\n').join('\n' + indent);
}

/** pcd-tokens.js: a classic-script UMD module that sets PCD.TOKENS (pages: global PCD; Node: module.exports). */
export function tokensJs(doc) {
  const table = tokensTable(doc);
  return [
    '/* PixelClock Desktop tokens: generated by tools/build.mjs (tools/lib/tokens.mjs) from design/tokens.json. Do not edit.',
    ' * PCD.TOKENS: each colour as \'#rrggbb\' by token name (plus a camelCase alias), and version, names, int (0xRRGGBB),',
    ' * css (variable names), derived (colour mixes), type (font and sizes), contrast, never and mono (the stack). */',
    '(function (root, factory) {',
    '  var api = factory(root.PCD || (root.PCD = {}));',
    "  if (typeof module === 'object' && module.exports) module.exports = api;",
    "})(typeof globalThis !== 'undefined' ? globalThis : this, function (PCD) {",
    "  'use strict';",
    `  var TOKENS = ${prettyJson(table, '  ')};`,
    '  PCD.TOKENS = TOKENS;',
    '  return TOKENS;',
    '});',
    '',
  ].join('\n');
}

/** tokens.css: the :root variables (see the header). */
export function tokensCss(doc) {
  const rows = contrastReport(doc);
  const never = (doc.contrast.never || []).map((p) => `${p.fg} on ${p.on}`);
  const lines = [
    '/* PixelClock Desktop tokens: generated by tools/build.mjs (tools/lib/tokens.mjs) from design/tokens.json. Do not edit.',
    '   Contrast (WCAG 2.2, gated by the build):',
    ...rows.map((r) => `     ${r.token} on ${r.against} ${formatRatio(r.ratio)}:1 (min ${r.min})`),
    never.length ? '   Never: ' + never.join(', ') + '. */' : '   */',
    '',
    ':root {',
  ];
  for (const name of Object.keys(doc.colors)) lines.push(`  ${cssVar(name)}: ${colorOf(doc, name)}; /* ${doc.colors[name].role} */`);
  lines.push('  /* set at run time by the console (PCD.color); this default holds until then */');
  for (const [name, from] of Object.entries(RUNTIME_VARS)) lines.push(`  ${cssVar(name)}: ${colorOf(doc, from)};`);
  lines.push(
    '  /* type: one monospace stack, weights 400 and 600 only */',
    `  --mono: ${doc.type.stack};`,
    `  --weight: ${doc.type.weights.normal};`,
    `  --weight-bold: ${doc.type.weights.bold};`,
    '  color-scheme: dark;',
    '}',
    '',
  );
  return lines.join('\n');
}

/** The build's generate stage (tools/build.mjs). Throws on an invalid file or a failing pair. */
export async function generate({ root = ROOT } = {}) {
  const doc = loadTokens(root);
  const rows = assertContrast(doc);
  return {
    files: { 'pcd-tokens.js': tokensJs(doc), 'tokens.css': tokensCss(doc) },
    rows,
    tokens: tokensTable(doc),
  };
}

/** CLI: print the contrast table (gated, decorative and never pairs). Returns the exit code. */
export function main({ root = ROOT, log = console.log, logError = console.error } = {}) {
  let doc;
  try {
    doc = loadTokens(root);
  } catch (e) {
    logError(e.message);
    return 1;
  }
  const rows = contrastReport(doc).map((r) => ({ name: `${r.token} on ${r.against}`, pass: r.pass, detail: describeRow(r) }));
  for (const r of infoRows(doc)) rows.push({ name: `${r.token} on ${r.against}`, pass: null, skip: true, detail: describeRow(r) });
  const counts = printReport(rows, { title: `${TOKENS_REL}: contrast (WCAG 2.2)`, log });
  return counts.failed ? 1 : 0;
}

function isMainModule() {
  if (typeof import.meta.main === 'boolean') return import.meta.main;
  if (!process.argv[1]) return false;
  try {
    return path.relative(fs.realpathSync(process.argv[1]), fileURLToPath(import.meta.url)) === '';
  } catch {
    return false;
  }
}

if (isMainModule()) process.exitCode = main();
