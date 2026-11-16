#!/usr/bin/env node
// PixelClock Desktop glyph gate: every character the pieces draw keeps the one-cell grid in both fonts.
//
//   node tools/glyph-gate.mjs [--chars] [--shot <file.png>] [--no-dist]
//
// 1. Gathers every distinct character of
//    - the safe set itself (tools/lib/glyphs.mjs: printable ASCII, box drawing U+2500-257F, the extras);
//    - the glyphs the look draws (DRAWN_GLYPHS), the eleven-by-four weather icons (WEATHER_ICONS) and a sample line of
//      every part of the console, the wallpaper column and the settings sheet (DRAWN_LINES);
//    - PCD-authored text: src/**, design/tokens.json, design/style-tile.*, and the shipped text under dist/ (vendor
//      copies in pixelclock/ folders and licence texts such as OFL.txt are exempt, as in tools/validate.mjs);
//    - what the shared emitters produce at run time (loaded in a node:vm sandbox on the vendor engine): every
//      greeting and holiday line, every date word, time samples, the weather and clock-status texts, and every
//      string constant of PCD.ascii.
// 2. Checks that every used character is in the safe set (FAIL lists each one with its sources).
// 3. Serves a temp page on 127.0.0.1 (the font, tokens.css, pcd-base.css, pcd-tokens.js, pcd-core.js, pcd-font.js) and
//    measures in headless Chrome (tools/lib/chrome.mjs: fresh temp profile, privacy guard on) with PCD.font.glyphGate:
//    |measureText(ch) - cellW| < 0.01 at 16 px and < 0.03 at 48 px, in TermMono and in Consolas. Used characters
//    must pass; an unused safe-set character that fails is a WARN (the set should shrink).
// 4. Measures the cell (PCD.font.measureCell, floored to device pixels) at the sizes in CELLS, once at device scale
//    factor 1 and once at a real factor 2, and compares with the reference figures there (a difference is a WARN: the
//    scale-2 figures were measured under CDP emulation, which lays fonts out in CSS px; a real factor 2 lays them out
//    at device size, e.g. 18 px @2 is 10.5 x 20.5, not 21). A cell at a real factor 2 must equal the cell at twice
//    the size at factor 1 in device pixels (the still's atlas): FAIL otherwise.
// --shot <file.png> writes screenshots of the specimen sheet (both fonts, seams, sample lines): <file.png> at device
// scale 1 and <file>@2.png at a real scale 2; --no-dist skips dist/; --chars lists every character with its widths and
// sources. Prints a PASS/FAIL table; exit code 1 on any FAIL (a cell that differs from its reference is a WARN). Node
// built-ins only.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { decodeUtf8Strict, listFiles, makeTempDir, rmrf, writeText } from './lib/fsx.mjs';
import { allSafe, hex, isSafeChar } from './lib/glyphs.mjs';
import { findBrowser, launch } from './lib/chrome.mjs';
import { serve } from './lib/serve.mjs';
import { printReport } from './lib/report.mjs';
import { tokensCss, tokensJs, loadTokens } from './lib/tokens.mjs';
import { themeOrder, vendorDir } from './lib/vendor.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, '..');
/** The text types tools/validate.mjs scans. */
export const GATE_EXTS = ['.html', '.js', '.mjs', '.cjs', '.css', '.json', '.txt', '.md', '.xml'];
export const LICENCE_RE = /^(OFL|LICEN[CS]E|COPYING)(\.[A-Za-z0-9]+)?$/i;
export const FAMILIES = ['TermMono', 'Consolas'];
/** Sizes measured: 16 px (a small text size) and 48 px (the still's 4K size), the tolerance scaled with the size. */
export const SIZES = [{ sizePx: 16, tolerance: 0.01 }, { sizePx: 48, tolerance: 0.03 }];
/** Every glyph the look draws outside plain letters (the brackets are ASCII; → is the terminal's link preview). */
export const DRAWN_GLYPHS = '╭╮╰╯─│├┤░▌›»·⌂☼≡↓→•°()[]/';
/** The weather icons, row by row (each row exactly 11 characters). */
export const WEATHER_ICONS = {
  'clear-day': ['   \\ | /   ', '  -- O --  ', '   / | \\   ', '           '],
  'clear-night': ['   .--.  · ', '  (    )   ', "   `--'  · ", '           '],
  'partly-day': ['  \\  /     ', ' -- .--.   ', ' .-(    ). ', '(___.__)__)'],
  'partly-night': [' ·  .--.   ', ' .-(    ). ', '(___.__)__)', '        ·  '],
  cloudy: ['    .--.   ', ' .-(    ). ', '(___.__)__)', '           '],
  fog: [' _ - _ - _ ', '  - _ - _ -', ' _ - _ - _ ', '           '],
  drizzle: ['    .--.   ', ' .-(    ). ', '(___.__)__)', "  ' ' ' '  "],
  rain: ['    .--.   ', ' .-(    ). ', '(___.__)__)', '  / / / /  '],
  freezing: ['    .--.   ', ' .-(    ). ', '(___.__)__)', '  * / * /  '],
  snow: ['    .--.   ', ' .-(    ). ', '(___.__)__)', '  *  *  *  '],
  thunder: ['    .--.   ', ' .-(    ). ', '(___.__)__)', '   _/  _/  '],
  unknown: ['           ', '   .---.   ', '   | ? |   ', "   '---'   "],
};
/** A sample of every line the console, the wallpaper column and the settings sheet draw, as it reads on screen. */
export const DRAWN_LINES = [
  'good evening · happy halloween', 'sun nov 15', '⌂ next alarm tomorrow 7:00 am · work', '⌂ snoozed until 8:09 am · work',
  '⌂ no alarm set', '⌂ time not set', '⌂ ringing · work', '7:27', '4:15', '░░',
  '46°F drizzle · berlin', 'feels 41° · wind 9 mph', 'hi 49° · lo 41°', 'weather: open-meteo.com', 'weather: open-meteo.com · 2 h ago',
  '[1] wikipedia   [2] maps   [3] open-meteo', '── terminal ───', '› ▌', '  → wikipedia',
  '1-3 + enter opens a link · help lists commands', 'autumn forest · night   ≡ settings',
  '╭─ settings ─── esc ─╮', '│ › clock   (•) 12 h  ( ) 24 h │', '[x] real sunrise and sunset', '[ auto · autumn forest   ↓ ]',
  '[ ☼ surprise me ]', '[ edit the 3 links ]', '[ done ]', '╰─── synced with chrome ─╯',
];
/** Reference cells (CSS px): the font size, the device scale factor, then w x h, and where that size is used. */
export const CELLS = [
  { sizePx: 24, dpr: 1, w: 14, h: 28, where: 'wallpaper 1920x1080@1' },
  { sizePx: 28, dpr: 1, w: 16, h: 33, where: 'wallpaper 2560x1440@1' },
  { sizePx: 48, dpr: 1, w: 28, h: 56, where: 'wallpaper 3840x2160@1' },
  { sizePx: 14, dpr: 1, w: 8, h: 16, where: 'new tab 800x500@1' },
  { sizePx: 18, dpr: 2, w: 10.5, h: 21, where: 'new tab 1280x800@2' },
  { sizePx: 16, dpr: 2, w: 9, h: 19, where: 'wallpaper 1280x800@2' },
  { sizePx: 14, dpr: 2, w: 8, h: 16, where: 'new tab 1280x620@2' },
  { sizePx: 12, dpr: 2, w: 7, h: 14, where: 'new tab 800x500@2' },
];

const isLayout = (ch) => ch === '\n' || ch === '\r' || ch === '\t';
const posix = (p) => p.split(path.sep).join('/');

// --------------------------------------------------------------------------------------------- gathering

/** Strings anywhere inside value (objects, arrays; functions skipped), depth-limited. */
export function deepStrings(value, out = [], depth = 0, seen = new Set()) {
  if (typeof value === 'string') { out.push(value); return out; }
  if (!value || typeof value !== 'object' || depth > 6 || seen.has(value)) return out;
  seen.add(value);
  for (const k of Object.keys(value)) {
    let v;
    try { v = value[k]; } catch { continue; }
    if (typeof v === 'function') continue;
    deepStrings(v, out, depth + 1, seen);
  }
  return out;
}

/**
 * The shared modules in a node:vm sandbox on the vendor engine (in page order; anything that fails to load is a note).
 * Resolves { PCD, PC, notes }.
 */
export function loadSandbox(root = ROOT) {
  const notes = [];
  const sandbox = { console: { log() {}, info() {}, warn() {}, error() {} }, setTimeout, clearTimeout };
  sandbox.globalThis = sandbox;
  const context = vm.createContext(sandbox);
  const run = (file, label = posix(path.relative(root, file))) => {
    try {
      vm.runInContext(fs.readFileSync(file, 'utf8'), context, { filename: label });
      return true;
    } catch (e) {
      notes.push(`${label}: ${String(e && e.message ? e.message : e).split('\n')[0]}`);
      return false;
    }
  };
  const vdir = vendorDir(root);
  const shared = path.join(root, 'src', 'shared');
  if (fs.existsSync(path.join(vdir, 'simulator', 'engine.js'))) {
    run(path.join(vdir, 'simulator', 'engine.js'));
    if (fs.existsSync(path.join(shared, 'pcd-hook.js'))) run(path.join(shared, 'pcd-hook.js'));
    run(path.join(vdir, 'simulator', 'schedule.js'));
    try {
      for (const t of themeOrder(vdir)) run(path.join(vdir, 'simulator', ...t.file.split('/')));
    } catch (e) {
      notes.push(`theme order: ${e.message}`);
    }
  } else {
    notes.push('vendor/pixelclock: missing (no engine in the sandbox)');
  }
  try {
    vm.runInContext(tokensJs(loadTokens(root)), context, { filename: 'pcd-tokens.js (generated)' });
  } catch (e) {
    notes.push(`pcd-tokens.js: ${e.message.split('\n')[0]}`);
  }
  const order = ['pcd-core.js', 'pcd-font.js', 'pcd-engine.js', 'pcd-sun.js', 'pcd-weather.js', 'pcd-fx.js', 'pcd-greet.js', 'pcd-ascii.js'];
  for (const name of order) if (fs.existsSync(path.join(shared, name))) run(path.join(shared, name));
  const status = path.join(root, 'src', 'newtab', 'js', 'ntp-status.js');
  if (fs.existsSync(status)) run(status);
  return { PCD: sandbox.PCD || {}, PC: sandbox.PixelClock || null, notes };
}

/** { source: text } of what the shared emitters produce (see the header). */
export function emitterTexts(root = ROOT) {
  const { PCD, PC, notes } = loadSandbox(root);
  const out = {};
  const add = (source, fn) => {
    try {
      const v = fn();
      const text = deepStrings(v).join('\n');
      if (text) out[source] = text;
    } catch (e) {
      notes.push(`${source}: ${String(e && e.message ? e.message : e).split('\n')[0]}`);
    }
  };
  if (PCD.greet) {
    add('emit:greetings', () => {
      const lines = [];
      for (let h = 0; h < 24; h++) lines.push(PCD.greet.line(new Date(2026, 10, 15, h, 30)));
      for (const y of [2026, 2027]) for (const d of PCD.greet.ownDates(y, PC)) lines.push(PCD.greet.parts(new Date(y, d.month - 1, d.day, 19), PC).runs);
      return lines;
    });
  }
  if (PCD.core) {
    add('emit:dates and times', () => {
      const lines = [];
      for (let m = 0; m < 12; m++) for (let d = 1; d <= 7; d++) lines.push(PCD.core.formatDate(new Date(2026, m, d)), PCD.core.dateParts(new Date(2026, m, d)));
      for (let h = 0; h < 24; h++) lines.push(PCD.core.formatTime(new Date(2026, 10, 15, h, 7, 9), false, { seconds: true }), PCD.core.formatTime(new Date(2026, 10, 15, h, 7), true));
      lines.push(PCD.core.agoText(2 * 3600000), PCD.core.agoText(72 * 3600000), PCD.core.formatHours(7.45, false, { ampm: false }));
      return lines;
    });
  }
  if (PCD.weather) add('emit:weather texts', () => PCD.weather);
  if (PCD.sun) add('emit:sun texts', () => [PCD.sun.text && PCD.sun.text({ rise: 7.45, set: 16.25 }, false), PCD.sun.text && PCD.sun.text({ rise: null, set: null, polar: 'night' }, true)]);
  if (PCD.status && typeof PCD.status.sample === 'function' && typeof PCD.status.describe === 'function') {
    add('emit:clock status lines', () => {
      const lines = [];
      for (const name of ['normal', 'ringing', 'snoozed', 'testing', 'first-boot', 'no-time', 'safe-mode']) {
        for (const clock24 of [false, true]) lines.push(PCD.status.describe(PCD.status.sample(name), { clock24 }));
      }
      return lines;
    });
  }
  if (PCD.ascii) add('emit:ascii kit constants', () => PCD.ascii);
  return { texts: out, notes };
}

/** The PCD-authored text files: [{ rel, abs }] (rel is repo-relative, posix). */
export function authoredFiles({ root = ROOT, dist = path.join(root, 'dist'), useDist = true } = {}) {
  const files = [];
  const take = (base, prefix) => {
    if (!fs.existsSync(base)) return;
    for (const f of listFiles(base)) {
      const parts = f.split('/');
      if (!GATE_EXTS.includes(path.extname(f).toLowerCase())) continue;
      if (LICENCE_RE.test(parts[parts.length - 1])) continue;
      if (parts.includes('pixelclock')) continue; // vendor copies: byte-identical to the clock, checked elsewhere
      files.push({ rel: `${prefix}/${f}`, abs: path.join(base, ...parts) });
    }
  };
  take(path.join(root, 'src'), 'src');
  for (const name of ['tokens.json', 'style-tile.html', 'style-tile.js', 'style-tile.css']) {
    const p = path.join(root, 'design', name);
    if (fs.existsSync(p)) files.push({ rel: `design/${name}`, abs: p });
  }
  if (useDist) take(dist, 'dist');
  return files;
}

/**
 * Every distinct character to gate: { chars: Map(char -> sorted sources), used: Set(char), files, badUtf8, notes }.
 * `used` holds the characters found outside the bare safe-set listing (authored text, the drawn glyphs, icons and
 * lines, emitters).
 */
export function gatherChars({ root = ROOT, dist = path.join(root, 'dist'), useDist = true } = {}) {
  const chars = new Map();
  const used = new Set();
  const add = (text, source, isUse = true) => {
    for (const ch of String(text)) {
      if (isLayout(ch)) continue;
      if (!chars.has(ch)) chars.set(ch, new Set());
      chars.get(ch).add(source);
      if (isUse) used.add(ch);
    }
  };
  add(allSafe(), 'safe set', false);
  add(DRAWN_GLYPHS, 'drawn glyphs');
  add(Object.values(WEATHER_ICONS).flat().join(''), 'weather icons');
  add(DRAWN_LINES.join(''), 'sample lines');
  const files = authoredFiles({ root, dist, useDist });
  const badUtf8 = [];
  for (const f of files) {
    try {
      add(decodeUtf8Strict(fs.readFileSync(f.abs), f.rel), f.rel);
    } catch (e) {
      badUtf8.push(e.message);
    }
  }
  const { texts, notes } = emitterTexts(root);
  for (const [source, text] of Object.entries(texts)) add(text, source);
  const sorted = new Map([...chars.entries()].sort((a, b) => a[0].codePointAt(0) - b[0].codePointAt(0)).map(([k, v]) => [k, [...v].sort()]));
  return { chars: sorted, used, files, badUtf8, notes, emitters: Object.keys(texts) };
}

// --------------------------------------------------------------------------------------------- the page

/** The specimen page script (written into the temp site; no inline script, text through textContent only). */
export const PAGE_JS = String.raw`/* glyph gate page: loads TermMono through PCD.font, then draws the specimen sheet (?sheet=1). */
(function () {
  'use strict';
  var gate = window.__gate = { ready: false, font: null, errors: [], cells: {} };
  window.addEventListener('error', function (e) { gate.errors.push(String(e.message || e)); });
  var doc = document;
  function span(parent, text, roles) {
    var s = doc.createElement('span');
    if (roles) s.className = PCD.core.roleClass(roles);
    s.textContent = text;
    parent.appendChild(s);
    return s;
  }
  function rep(ch, n) { return n > 0 ? new Array(n + 1).join(ch) : ''; }
  function len(runs) { var n = 0; runs.forEach(function (r) { n += r[0].length; }); return n; }
  function edge(l, r, w, left, right) {
    var runs = [[l + '─', 'frame']];
    var used = 4 + (left ? len(left) + 2 : 0) + (right ? len(right) + 2 : 0);
    if (left) runs = runs.concat([[' ', '']], left, [[' ', '']]);
    runs.push([rep('─', w - used), 'frame']);
    if (right) runs = runs.concat([[' ', '']], right, [[' ', '']]);
    runs.push(['─' + r, 'frame']);
    return runs;
  }
  function boxLines(w, title, tag, body) {
    var lines = [edge('╭', '╮', w, title, tag)];
    body.forEach(function (runs) {
      var n = len(runs);
      lines.push([['│', 'frame'], [' ', '']].concat(runs, [[rep(' ', w - 3 - n), ''], ['│', 'frame']]));
    });
    lines.push(edge('╰', '╯', w, null, [['16 px', 'muted']]));
    return lines;
  }
  function draw(pre, lines) {
    lines.forEach(function (runs, i) {
      if (i) pre.appendChild(doc.createTextNode('\n'));
      runs.forEach(function (r) { if (r[0]) span(pre, r[0], r[1]); });
    });
  }
  function chunk(s, n) { var out = [], a = Array.from(s); for (var i = 0; i < a.length; i += n) out.push(a.slice(i, i + n).join('')); return out; }
  function sheet() {
    var root = doc.getElementById('sheet');
    var safe = window.__gateSafe || '';
    var ascii = '', box = '', extra = '';
    Array.from(safe).forEach(function (c) {
      var cp = c.codePointAt(0);
      if (cp < 0x7f) ascii += c; else if (cp >= 0x2500 && cp <= 0x257f) box += c; else extra += c;
    });
    var W = 52, top = 0, x = 16;
    ['TermMono', 'Consolas'].forEach(function (family) {
      var pre = doc.createElement('pre');
      pre.className = 'pcd-g';
      pre.style.fontFamily = family + ', monospace';
      pre.style.fontSize = '16px';
      root.appendChild(pre);
      var cell = PCD.font.measureCell({ host: pre, dpr: window.devicePixelRatio || 1 });
      gate.cells[family] = cell;
      PCD.font.apply(pre, cell, 16);
      pre.style.left = x + 'px';
      pre.style.top = '16px';
      var body = [[['the safe set, one cell each', 'muted']], []];
      chunk(ascii, W - 4).forEach(function (row) { body.push([[row, 'text']]); });
      body.push([]);
      chunk(box, W - 4).forEach(function (row) { body.push([[row, 'frame']]); });
      body.push([]);
      body.push([[extra, 'text']]);
      body.push([]);
      body.push([['seams', 'muted']]);
      body.push([['╭──┬──╮  ', 'frame'], ['░░░░░░', 'wood'], ['  ▀▄█▌▐ ░▒▓', 'text']]);
      body.push([['├──┼──┤  ', 'frame'], ['░░░░░░', 'wood'], ['  ▀▄█▌▐ ░▒▓', 'text']]);
      body.push([['╰──┴──╯  ', 'frame'], ['░░░░░░', 'wood'], ['  ', ''], ['▌', 'accent']]);
      body.push([]);
      body.push([['good evening', 'text bold'], [' · ', 'frame'], ['happy halloween', 'text']]);
      body.push([['sun nov 15', 'muted']]);
      body.push([['⌂ ', 'frame'], ['next alarm tomorrow ', 'muted'], ['7:00 am', 'text'], [' · ', 'frame'], ['work', 'muted']]);
      body.push([['[', 'faint'], ['1', 'accent'], ['] ', 'faint'], ['wikipedia', 'muted'], ['   ', ''], ['[', 'faint'], ['2', 'accent'], ['] ', 'faint'], ['maps', 'muted'], ['   ', ''],
        ['[', 'faint'], ['3', 'accent'], ['] ', 'faint'], ['open-meteo', 'muted']]);
      body.push([['── ', 'wood'], ['terminal', 'faint'], [' ' + rep('─', 20), 'wood']]);
      body.push([['› ', 'accent'], ['3', 'text'], ['  → open-meteo', 'faint'], ['▌', 'accent']]);
      body.push([['1-3', 'muted'], [' + enter opens a link', 'faint'], [' · ', 'frame'], ['help', 'muted'], [' lists commands', 'faint']]);
      body.push([['(', 'faint'], ['•', 'accent'], [') ', 'faint'], ['12 h', 'text'], ['  ', ''], ['( ) ', 'faint'], ['24 h', 'muted'], ['   ', ''], ['[', 'faint'], ['x', 'accent'], ['] ', 'faint'], ['show', 'text'], ['  ↓ °', 'muted'], ['  ≡ ', 'frame'], ['settings', 'text']]);
      body.push([]);
      var icon = window.__gateIcon || [];
      var wx = [[['46°F', 'text bold'], [' drizzle', 'text'], [' · ', 'frame'], ['berlin', 'muted']], [['feels 41°', 'muted'], [' · ', 'frame'], ['wind 9 mph', 'muted']], [['hi 49°', 'muted'], [' · ', 'frame'], ['lo 41°', 'muted']], [['weather: ', 'faint'], ['open-meteo.com', 'faint']]];
      icon.forEach(function (row, i) { body.push([[row, i < 3 ? 'muted' : 'text'], ['  ', '']].concat(wx[i] || [])); });
      draw(pre, boxLines(W, [[family.toLowerCase(), 'text bold']], [[cell.w.toFixed(2) + ' x ' + cell.h.toFixed(2), 'muted']], body));
      var r = pre.getBoundingClientRect();
      top = Math.max(top, r.bottom);
      x = Math.ceil(r.right + 3 * cell.w);
    });
    gate.sheetBottom = Math.ceil(top + 16);
  }
  PCD.font.load('fonts/', { timeoutMs: 15000 }).then(function (info) {
    gate.font = info;
    if (/[?&]sheet=1/.test(location.search)) { try { sheet(); } catch (e) { gate.errors.push('sheet: ' + e.message); } }
    gate.ready = true;
  });
})();
`;

/** The specimen page HTML (classic deferred scripts, the shared CSS). */
export const PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width">
<title>glyph gate</title>
<link rel="stylesheet" href="css/tokens.css">
<link rel="stylesheet" href="css/pcd-base.css">
<script src="js/pcd-tokens.js" defer></script>
<script src="js/pcd-core.js" defer></script>
<script src="js/pcd-font.js" defer></script>
<script src="js/gate-data.js" defer></script>
<script src="js/gate.js" defer></script>
</head>
<body>
<main id="sheet"></main>
</body>
</html>
`;

/** Write the temp site; resolves its folder. */
export function buildSite(root, dir, safeText) {
  const doc = loadTokens(root);
  writeText(path.join(dir, 'index.html'), PAGE_HTML);
  writeText(path.join(dir, 'css', 'tokens.css'), tokensCss(doc));
  writeText(path.join(dir, 'css', 'pcd-base.css'), fs.readFileSync(path.join(root, 'src', 'shared', 'css', 'pcd-base.css'), 'utf8'));
  writeText(path.join(dir, 'js', 'pcd-tokens.js'), tokensJs(doc));
  for (const n of ['pcd-core.js', 'pcd-font.js']) writeText(path.join(dir, 'js', n), fs.readFileSync(path.join(root, 'src', 'shared', n), 'utf8'));
  writeText(path.join(dir, 'js', 'gate-data.js'), `window.__gateSafe = ${JSON.stringify(safeText)};\nwindow.__gateIcon = ${JSON.stringify(WEATHER_ICONS.drizzle)};\n`);
  writeText(path.join(dir, 'js', 'gate.js'), PAGE_JS);
  fs.mkdirSync(path.join(dir, 'fonts'), { recursive: true });
  for (const n of ['CascadiaMono-wght.ttf', 'OFL.txt']) fs.copyFileSync(path.join(root, 'design', 'fonts', n), path.join(dir, 'fonts', n));
  return dir;
}

// --------------------------------------------------------------------------------------------- measuring

async function openGate(browser, url, { width = 1440, height = 1100, dpr = 1 } = {}) {
  const page = await browser.newPage('about:blank');
  await page.setViewport(width, height, dpr);
  await page.goto(url);
  await page.waitFor('window.__gate && window.__gate.ready', { timeoutMs: 20000 });
  return page;
}

/** Measure in headless Chrome. Resolves { results, widths, font, info, cells, errors, url, shot }. */
export async function measureInBrowser({ root = ROOT, text, shot = null } = {}) {
  if (!findBrowser()) throw new Error('no Chrome or Edge found (set PCD_BROWSER)');
  if (!fs.existsSync(path.join(root, 'design', 'fonts', 'CascadiaMono-wght.ttf'))) throw new Error('design/fonts/CascadiaMono-wght.ttf is missing');
  const dir = buildSite(root, makeTempDir('pcd-glyph-'), allSafe());
  const srv = await serve(dir);
  const out = { cells: [], errors: [] };
  const cellsAt = (list) => list.map((c) => {
    const dpr = window.devicePixelRatio || 1;
    const t = PCD.font.measureCell({ sizePx: c.sizePx, dpr, family: 'TermMono' });
    const k = PCD.font.measureCell({ sizePx: c.sizePx, dpr, family: 'Consolas' });
    return { ...c, realDpr: dpr, got: t && { w: t.w, h: t.h, adv: t.adv, natural: t.natural, ls: t.ls }, consolas: k && { w: k.w, h: k.h } };
  });
  // device scale factor 1 (glyphs, cells, the sheet) and a real factor 2 (cells; emulated ratios misreport, see
  // tools/lib/chrome.mjs), side by side: closing a headless browser takes seconds on Windows.
  const one = async () => {
    const browser = await launch();
    try {
      const url = srv.url + 'index.html?sheet=1';
      const page = await openGate(browser, url);
      const r = await page.evaluate((chars, families, sizes) => {
        const results = sizes.map((s) => PCD.font.glyphGate(chars, { families, sizePx: s.sizePx, tolerance: s.tolerance }).map((g) => ({
          family: g.family, sizePx: g.sizePx, tolerance: s.tolerance, cellW: g.cellW, tested: g.tested, pass: g.pass,
          fails: g.fails.map((f) => ({ cp: f.cp, ch: f.ch, width: f.width, delta: f.delta })),
        })));
        const ctx = document.createElement('canvas').getContext('2d');
        const list = Array.from(new Set(Array.from(chars)));
        const widths = {};
        for (const fam of families) {
          ctx.font = '16px ' + fam;
          widths[fam] = list.map((c) => ctx.measureText(c).width);
        }
        return { results: results.flat(), widths, list, font: window.__gate.font, info: { active: PCD.font.active(), m100: PCD.font.mWidth100() }, errors: window.__gate.errors, sheetBottom: window.__gate.sheetBottom };
      }, text, FAMILIES, SIZES);
      Object.assign(out, r);
      out.url = url;
      const cells = await page.evaluate(cellsAt, CELLS.filter((c) => c.dpr === 1));
      // the same device sizes at scale 1 (what the still's atlas measures): 18 px @2 is 36 device px
      out.twins = await page.evaluate(cellsAt, CELLS.filter((c) => c.dpr === 2).map((c) => ({ sizePx: c.sizePx * 2, dpr: 1, twinOf: c.sizePx })));
      if (shot) {
        const h = Math.min(4000, Math.max(400, r.sheetBottom || 1100));
        await page.setViewport(1440, h, 1);
        await page.screenshot({ path: shot });
        out.shot = shot;
      }
      const errors = page.errors.map((e) => `${e.type}: ${e.text}`);
      await page.close();
      return { cells, errors };
    } finally {
      await browser.close();
    }
  };
  const two = async () => {
    const browser = await launch({ deviceScaleFactor: 2 });
    try {
      const page = await openGate(browser, srv.url + 'index.html?sheet=1', { width: 1280, height: 800, dpr: 2 });
      const cells = await page.evaluate(cellsAt, CELLS.filter((c) => c.dpr === 2));
      if (shot) {
        const bottom = await page.evaluate('window.__gate.sheetBottom');
        await page.setViewport(1280, Math.min(2000, Math.max(400, bottom || 800)), 2);
        const shot2 = shot.replace(/(\.png)?$/i, '@2.png');
        await page.screenshot({ path: shot2 });
        out.shot2 = shot2;
      }
      return { cells, errors: page.errors.map((e) => `${e.type}: ${e.text}`) };
    } finally {
      await browser.close();
    }
  };
  try {
    const [a, b] = await Promise.all([one(), two()]);
    out.cells.push(...a.cells, ...b.cells);
    out.errors.push(...a.errors, ...b.errors);
  } finally {
    await srv.close();
    await rmrf(dir);
  }
  return out;
}

// --------------------------------------------------------------------------------------------- report

function sourcesText(list, max = 3) {
  return list.slice(0, max).join(', ') + (list.length > max ? ` +${list.length - max}` : '');
}

function block(cp) {
  if (cp >= 0x20 && cp <= 0x7e) return 'ASCII';
  if (cp >= 0x2500 && cp <= 0x257f) return 'box drawing';
  if (cp >= 0x2580 && cp <= 0x259f) return 'blocks and shades';
  return 'symbols';
}

export async function main({ argv = process.argv.slice(2), root = ROOT, log = console.log, logError = console.error } = {}) {
  let shot = null;
  let showChars = false;
  let useDist = true;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') {
      log('usage: node tools/glyph-gate.mjs [--chars] [--shot <file.png>] [--no-dist]   (needs Chrome or Edge)');
      return 0;
    }
    if (a === '--chars') showChars = true;
    else if (a === '--no-dist') useDist = false;
    else if (a === '--shot' && argv[i + 1]) shot = path.resolve(argv[++i]);
    else {
      logError(`unknown argument ${a}`);
      return 1;
    }
  }
  const g = gatherChars({ root, useDist });
  const list = [...g.chars.keys()];
  const text = list.join('');
  const rows = [];
  rows.push({
    name: 'gate: characters gathered',
    pass: g.badUtf8.length === 0 && g.used.size > 0,
    detail: `${list.length} distinct: the safe set (${allSafe().length}), the drawn glyphs, weather icons and sample lines, ${g.files.length} authored text files (src/, design/, dist/), emitters: ${g.emitters.join(', ') || 'none'}` +
      (g.badUtf8.length ? `\n${g.badUtf8.join('\n')}` : '') + (g.notes.length ? `\nsandbox notes: ${g.notes.join('; ')}` : ''),
  });
  const unsafe = list.filter((ch) => !isSafeChar(ch));
  rows.push({
    name: 'gate: every used character is in the safe set (tools/lib/glyphs.mjs)',
    pass: unsafe.length === 0,
    detail: unsafe.length ? unsafe.map((ch) => `${hex(ch.codePointAt(0))} in ${sourcesText(g.chars.get(ch))}`).join('\n') : `${g.used.size} used characters, all safe`,
  });

  let m;
  try {
    m = await measureInBrowser({ root, text, shot });
  } catch (e) {
    rows.push({ name: 'gate: browser measurement', pass: false, detail: e.message });
    printReport(rows, { title: 'PixelClock Desktop glyph gate', log });
    logError(`glyph gate FAILED: ${e.message}`);
    return 1;
  }
  const font = m.font || {};
  rows.push({
    name: 'gate: TermMono loaded through PCD.font.load (font-active)',
    pass: !!font.loaded && font.active === 'cascadia' && m.info.active === 'cascadia',
    detail: `${font.loaded ? `TermMono loaded in ${font.ms} ms` : 'TermMono NOT loaded: ' + font.error}; stack renders ${m.info.active}; M@100px ${typeof m.info.m100 === 'number' ? m.info.m100.toFixed(2) : '?'} (Cascadia ~58.59, Consolas ~54.98)`,
  });
  const failingUsed = new Set();
  const failingUnused = new Map();
  for (const res of m.results) {
    const usedFails = res.fails.filter((f) => g.used.has(f.ch));
    const unusedFails = res.fails.filter((f) => !g.used.has(f.ch));
    for (const f of usedFails) failingUsed.add(f.cp);
    for (const f of unusedFails) failingUnused.set(f.cp, `${f.cp} ${f.ch} (${res.family} ${res.sizePx}px ${f.delta > 0 ? '+' : ''}${f.delta.toFixed(3)})`);
    const nUsed = list.filter((ch) => g.used.has(ch)).length;
    rows.push({
      name: `gate: ${res.family} @${res.sizePx}px |measureText(ch) - cellW| < ${res.tolerance}`,
      pass: usedFails.length === 0,
      detail: `cellW ${res.cellW.toFixed(4)} px; used ${nUsed - usedFails.length}/${nUsed} pass; whole safe set ${res.tested - res.fails.length}/${res.tested}` +
        (usedFails.length ? `\nFAIL: ${usedFails.map((f) => `${f.cp} ${f.ch} (w ${f.width.toFixed(3)}, ${f.delta > 0 ? '+' : ''}${f.delta.toFixed(3)})`).join(', ')}` : ''),
    });
  }
  const drawnChars = new Set([...DRAWN_GLYPHS, ...Object.values(WEATHER_ICONS).flat().join(''), ...DRAWN_LINES.join('')].filter((c) => !isLayout(c)));
  const drawnFails = [...drawnChars].filter((c) => m.results.some((res) => res.fails.some((f) => f.ch === c)));
  rows.push({
    name: 'gate: the drawn glyphs, weather icons and sample lines in both fonts, both sizes (rounded corners included)',
    pass: drawnFails.length === 0,
    detail: drawnFails.length ? `FAIL: ${drawnFails.map((c) => hex(c.codePointAt(0))).join(' ')} (the square corners ┌┐└┘ are the fallback for rounded ones)` : `${drawnChars.size} characters, including ╭ ╮ ╰ ╯ ░ ▌ › » · ⌂ ☼ ≡ ↓ → • °`,
  });
  rows.push({
    name: 'gate: unused safe-set characters',
    pass: true,
    warn: failingUnused.size > 0,
    detail: failingUnused.size ? `measure off in a font (not used anywhere; consider dropping them from the set): ${[...failingUnused.values()].join(', ')}` : 'every safe-set character passes in both fonts',
  });
  for (const c of m.cells) {
    const got = c.got;
    const ok = !!got && Math.abs(got.w - c.w) < 1e-6 && Math.abs(got.h - c.h) < 1e-6;
    rows.push({
      name: `cell: TermMono ${c.sizePx}px @${c.dpr} = ${c.w} x ${c.h} (${c.where})`,
      pass: !!got,
      warn: !!got && !ok,
      detail: got ? `measured ${got.w} x ${got.h} (advance ${got.adv.toFixed(4)}, line ${got.natural.toFixed(3)}, letter-spacing ${got.ls.toFixed(4)}), real dpr ${c.realDpr}; Consolas ${c.consolas ? `${c.consolas.w} x ${c.consolas.h}` : '?'}` +
        (ok ? '' : ` -- the reference figure differs (it was measured under CDP dpr emulation; a real scale factor ${c.dpr} lays fonts out at device size: the layout must use measured cells)`) : 'not measured',
    });
  }
  // a page at a real scale factor 2 and the still's atlas (scale 1, twice the size) must agree in device pixels
  for (const c of m.cells.filter((x) => x.dpr === 2)) {
    const twin = (m.twins || []).find((t) => t.twinOf === c.sizePx);
    const a = c.got;
    const b = twin && twin.got;
    const same = !!a && !!b && Math.round(a.w * 2) === Math.round(b.w) && Math.round(a.h * 2) === Math.round(b.h);
    rows.push({
      name: `cell: TermMono ${c.sizePx}px @2 equals ${c.sizePx * 2}px @1 in device px (pages vs the still's atlas)`,
      pass: same,
      detail: a && b ? `${a.w * 2} x ${a.h * 2} vs ${b.w} x ${b.h} device px` : 'not measured',
    });
  }
  rows.push({ name: 'gate: specimen page without errors', pass: m.errors.length === 0, detail: m.errors.length ? m.errors.join('\n') : `${m.url} (served on 127.0.0.1)${m.shot ? `; screenshots ${m.shot} and ${m.shot2}` : ''}` });

  const blocks = new Map();
  m.list.forEach((ch, i) => {
    const b = block(ch.codePointAt(0));
    if (!blocks.has(b)) blocks.set(b, { n: 0, used: 0, fails: Object.fromEntries(FAMILIES.map((f) => [f, 0])) });
    const e = blocks.get(b);
    e.n++;
    if (g.used.has(ch)) e.used++;
    for (const fam of FAMILIES) {
      const cell = m.results.find((r) => r.family === fam && r.sizePx === 16).cellW;
      if (!(Math.abs(m.widths[fam][i] - cell) < 0.01)) e.fails[fam]++;
    }
  });
  log(`Glyph gate @16px: ${m.list.length} characters (${g.used.size} used)`);
  log(`  ${'block'.padEnd(18)} ${'chars'.padStart(5)} ${'used'.padStart(5)}  ${FAMILIES.map((f) => (f + ' fails').padStart(15)).join('  ')}`);
  for (const [b, e] of blocks) log(`  ${b.padEnd(18)} ${String(e.n).padStart(5)} ${String(e.used).padStart(5)}  ${FAMILIES.map((f) => String(e.fails[f]).padStart(15)).join('  ')}`);
  log('');
  if (showChars) {
    log(`  ${'code'.padEnd(7)} ch  ${FAMILIES.map((f) => f.padStart(9)).join(' ')}  sources`);
    m.list.forEach((ch, i) => {
      const cp = ch.codePointAt(0);
      log(`  ${hex(cp).padEnd(7)} ${cp < 0x21 ? ' ' : ch}   ${FAMILIES.map((f) => m.widths[f][i].toFixed(3).padStart(9)).join(' ')}  ${sourcesText(g.chars.get(ch) || [], 4)}`);
    });
    log('');
  }
  const counts = printReport(rows, { title: 'PixelClock Desktop glyph gate (headless Chrome: TermMono and Consolas)', log });
  if (counts.failed) {
    const cps = [...new Set([...failingUsed, ...unsafe.map((ch) => hex(ch.codePointAt(0)))])].sort();
    logError(`glyph gate FAILED${cps.length ? ': ' + cps.join(' ') : ''}`);
    return 1;
  }
  log('glyph gate PASS');
  return 0;
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

if (isMainModule()) {
  main().then(
    (code) => {
      process.exitCode = code;
      setTimeout(() => process.exit(code), 3000).unref();
    },
    (e) => {
      console.error(e);
      process.exit(1);
    },
  );
}
