#!/usr/bin/env node
// PixelClock Desktop: the still's glyph atlas.
//
//   node tools/make-atlas.mjs [--out <dir>] [--sizes 16,20,...] [--check] [--quiet]
//
// Renders every glyph the still draws (src/still/lib/atlas.mjs ATLAS_CHARS: weights 400 and 600) at every type size
// the still uses (the still's ladder in design/tokens.json, which equals the wallpaper's) in TermMono, the bundled
// Cascadia Mono, white on black, in headless Chrome at device scale 1 (tools/lib/chrome.mjs: a fresh temp profile, the
// privacy guard on, no network; the page is served from 127.0.0.1). Each glyph is drawn alone at a whole pixel, in a
// slot that leaves room around its cell, exactly as the wallpaper page draws a glyph (line-height normal, cells floored
// to whole device pixels). Writes design/atlas/atlas.json and one grey PNG per size (atlas-<px>.png);
// the PNGs are deterministic for a given browser and font. --check renders into a temp folder and compares with the
// committed atlas instead of writing (exit 1 when they differ). Node built-ins only.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findBrowser, launch } from './lib/chrome.mjs';
import { makeTempDir, rmrf, writeText } from './lib/fsx.mjs';
import { decodePng as decodeRgba } from './lib/png.mjs';
import { serve } from './lib/serve.mjs';
import { ATLAS_CHARS, ATLAS_FILE, ATLAS_VERSION, WEIGHTS } from '../src/still/lib/atlas.mjs';
import { encodePng } from '../src/still/lib/png.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, '..');
export const ATLAS_DIR = path.join(ROOT, 'design', 'atlas');
export const FONT_FILE = path.join(ROOT, 'design', 'fonts', 'CascadiaMono-wght.ttf');
/** Glyphs per slot row. */
export const COLS = 16;

/** The type sizes the still uses (device px): design/tokens.json type.ladder.still (and the wallpaper's, its twin). */
export function atlasSizes(root = ROOT) {
  const tokens = JSON.parse(fs.readFileSync(path.join(root, 'design', 'tokens.json'), 'utf8'));
  const lad = tokens.type && tokens.type.ladder;
  if (!lad || !Array.isArray(lad.still)) throw new Error('design/tokens.json has no type.ladder.still');
  const set = new Set([...lad.still, ...(Array.isArray(lad.wallpaper) ? lad.wallpaper : [])]);
  return [...set].map(Number).filter((n) => Number.isInteger(n) && n > 0).sort((a, b) => a - b);
}

/** Room around a cell inside its slot (pixels): enough for anti-aliasing and any ink past the cell. */
export function padFor(sizePx) {
  return Math.ceil(sizePx * 0.15) + 1;
}

/** The slot geometry of one size from its measured cell. */
export function sizeLayout(sizePx, m, chars = ATLAS_CHARS) {
  const pad = padFor(sizePx);
  const cellW = Math.floor(m.advance + 1e-6);
  const cellH = Math.floor(m.lineHeight + 1e-6);
  const slotW = cellW + 2 * pad;
  const slotH = cellH + 2 * pad;
  const rows = {};
  let r = 0;
  for (const w of WEIGHTS) {
    rows[w] = r;
    r += Math.ceil(chars[w].length / COLS);
  }
  return {
    advance: Math.round(m.advance * 1e4) / 1e4, cellW, cellH, baseline: Math.round(m.baseline), padX: pad, padY: pad,
    slotW, slotH, cols: COLS, rows, png: `atlas-${sizePx}.png`, width: COLS * slotW, height: r * slotH,
  };
}

const PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>atlas</title>
<link rel="stylesheet" href="css/atlas.css">
<script src="js/pcd-font.js" defer></script>
<script src="js/atlas-page.js" defer></script>
</head>
<body><main id="atlas"></main></body>
</html>
`;

const PAGE_CSS = `html, body { margin: 0; padding: 0; background: #000; color: #fff; overflow: hidden; }
.g { position: absolute; margin: 0; padding: 0; border: 0; white-space: pre; font-family: TermMono; font-style: normal;
  line-height: normal; letter-spacing: 0; font-variant-ligatures: none; font-kerning: none; font-synthesis: none;
  font-feature-settings: 'liga' 0, 'clig' 0, 'calt' 0; color: #fff; }
`;

/** The page: loads TermMono through PCD.font (as the pieces do), then measures and draws on request. */
const PAGE_JS = String.raw`(function () {
  'use strict';
  var A = window.__atlas = { ready: false, font: null, errors: [] };
  window.addEventListener('error', function (e) { A.errors.push(String(e.message || e)); });
  function box(size, weight, text) {
    var d = document.createElement('div');
    d.className = 'g';
    d.style.left = '0px';
    d.style.top = '0px';
    d.style.visibility = 'hidden';
    d.style.fontSize = size + 'px';
    d.style.fontWeight = String(weight);
    if (text) d.textContent = text;
    document.body.appendChild(d);
    return d;
  }
  A.measure = function (size, weight) {
    var row = new Array(101).join('M');
    var rows = [];
    for (var i = 0; i < 10; i++) rows.push(row);
    var d = box(size, weight, rows.join('\n'));
    var r = d.getBoundingClientRect();
    document.body.removeChild(d);
    var b = box(size, weight, '');
    var mark = document.createElement('span');
    mark.style.display = 'inline-block';
    mark.style.width = '0px';
    mark.style.height = '0px';
    b.appendChild(mark);
    b.appendChild(document.createTextNode('M'));
    var baseline = mark.getBoundingClientRect().top - b.getBoundingClientRect().top;
    var one = b.getBoundingClientRect().height;
    document.body.removeChild(b);
    var ctx = document.createElement('canvas').getContext('2d');
    ctx.font = weight + ' ' + size + 'px TermMono';
    return { advance: r.width / 100, lineHeight: r.height / 10, oneLine: one, baseline: baseline, canvasAdvance: ctx.measureText('M').width };
  };
  A.render = function (spec) {
    var host = document.getElementById('atlas');
    host.textContent = '';
    spec.groups.forEach(function (g) {
      Array.from(g.chars).forEach(function (ch, i) {
        var d = document.createElement('div');
        d.className = 'g';
        d.style.left = ((i % spec.cols) * spec.slotW + spec.padX) + 'px';
        d.style.top = ((g.row + Math.floor(i / spec.cols)) * spec.slotH + spec.padY) + 'px';
        d.style.fontSize = spec.size + 'px';
        d.style.fontWeight = String(g.weight);
        d.textContent = ch;
        host.appendChild(d);
      });
    });
    return host.childNodes.length;
  };
  PCD.font.load('fonts/', { timeoutMs: 20000 }).then(function (info) { A.font = info; A.ready = true; });
})();
`;

function buildSite(dir, root = ROOT) {
  writeText(path.join(dir, 'index.html'), PAGE_HTML);
  writeText(path.join(dir, 'css', 'atlas.css'), PAGE_CSS);
  writeText(path.join(dir, 'js', 'pcd-font.js'), fs.readFileSync(path.join(root, 'src', 'shared', 'pcd-font.js'), 'utf8'));
  writeText(path.join(dir, 'js', 'atlas-page.js'), PAGE_JS);
  fs.mkdirSync(path.join(dir, 'fonts'), { recursive: true });
  fs.copyFileSync(path.join(root, 'design', 'fonts', 'CascadiaMono-wght.ttf'), path.join(dir, 'fonts', 'CascadiaMono-wght.ttf'));
  return dir;
}

/** SHA-256 of a file (hex). */
export function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/**
 * Chrome draws text below 56 px with LCD (subpixel) anti-aliasing: coloured fringes that belong to one screen's
 * subpixel order. The atlas is a grey coverage mask, so it is rendered with grey anti-aliasing (what Chrome itself
 * uses from 56 px up): the same glyph shapes, valid on any screen.
 */
export const ATLAS_BROWSER_ARGS = ['--disable-lcd-text'];

/**
 * Open the atlas page in a fresh headless browser and run fn(page, browser). The page has TermMono loaded (it throws
 * otherwise). Used by make() and by tests/atlas.test.mjs to re-measure the cells.
 */
export async function withAtlasPage(fn, { root = ROOT } = {}) {
  if (!findBrowser()) throw new Error('no Chrome or Edge found (set PCD_BROWSER)');
  const site = buildSite(makeTempDir('pcd-atlas-'), root);
  const srv = await serve(site);
  const browser = await launch({ args: ATLAS_BROWSER_ARGS });
  try {
    const page = await browser.newPage('about:blank');
    await page.setViewport(800, 600, 1);
    await page.goto(srv.url + 'index.html');
    await page.waitFor('window.__atlas && window.__atlas.ready', { timeoutMs: 30000 });
    const font = await page.evaluate('window.__atlas.font');
    if (!font || !font.loaded || font.family !== 'TermMono') throw new Error(`TermMono did not load in the atlas page (${JSON.stringify(font)})`);
    const out = await fn(page, browser);
    const errors = await page.evaluate('window.__atlas.errors');
    if (errors.length || page.errors.length) throw new Error(`atlas page errors: ${JSON.stringify(errors.concat(page.errors))}`);
    return out;
  } finally {
    await browser.close();
    browser.assertNoViolations();
    await srv.close();
    await rmrf(site);
  }
}

/** Measure one size in both weights (they must agree: a monospace face keeps its advance at every weight). */
export async function measureSize(page, sizePx) {
  const m = {};
  for (const w of WEIGHTS) m[w] = await page.evaluate((s, wt) => window.__atlas.measure(s, wt), sizePx, w);
  const a = m[WEIGHTS[0]];
  for (const w of WEIGHTS.slice(1)) {
    if (Math.abs(m[w].advance - a.advance) > 1e-6 || Math.abs(m[w].lineHeight - a.lineHeight) > 1e-6) {
      throw new Error(`${sizePx} px: weight ${w} measures ${m[w].advance} x ${m[w].lineHeight}, 400 measures ${a.advance} x ${a.lineHeight}`);
    }
  }
  return a;
}

/**
 * Render the atlas into `outDir`. Returns { meta, files: [names], notes }. opts: { sizes, root, log }.
 */
export async function make(outDir, { sizes = atlasSizes(), root = ROOT, log = () => {} } = {}) {
  const notes = [];
  const files = [];
  const meta = {
    v: ATLAS_VERSION,
    about: 'The still\'s glyph atlas (tools/make-atlas.mjs; read by src/still/lib/atlas.mjs). One grey PNG per type size in device px: every glyph the still draws, white on black, rendered by headless Chrome in TermMono at device scale 1. Slot (col, row) holds chars[weight][i] with col = i % cols and row = rows[weight] + floor(i / cols); the glyph\'s cell starts padX, padY pixels into its slot.',
    font: { family: 'TermMono', file: 'CascadiaMono-wght.ttf', sha256: sha256File(path.join(root, 'design', 'fonts', 'CascadiaMono-wght.ttf')) },
    browser: '',
    chars: { 400: ATLAS_CHARS[400], 600: ATLAS_CHARS[600] },
    sizes: {},
  };
  await withAtlasPage(async (page, browser) => {
    meta.browser = String(browser.version && browser.version.product || '');
    for (const px of sizes) {
      const m = await measureSize(page, px);
      const L = sizeLayout(px, m);
      const spec = { size: px, cols: L.cols, slotW: L.slotW, slotH: L.slotH, padX: L.padX, padY: L.padY, groups: WEIGHTS.map((w) => ({ weight: w, chars: ATLAS_CHARS[w], row: L.rows[w] })) };
      await page.setViewport(L.width, L.height, 1);
      const n = await page.evaluate((s) => window.__atlas.render(s), spec);
      if (n !== ATLAS_CHARS[400].length + ATLAS_CHARS[600].length) throw new Error(`${px} px: drew ${n} glyphs`);
      const shot = decodeRgba(await page.screenshot({ clip: { x: 0, y: 0, width: L.width, height: L.height } }));
      if (shot.width !== L.width || shot.height !== L.height) throw new Error(`${px} px: screenshot ${shot.width}x${shot.height}, wanted ${L.width}x${L.height}`);
      // the coverage mask: white on black gives grey; a coloured fringe (LCD anti-aliasing) would be folded into it
      const grey = Buffer.alloc(L.width * L.height);
      let fringe = 0;
      for (let i = 0, j = 0; i < grey.length; i++, j += 4) {
        const r = shot.data[j];
        const g = shot.data[j + 1];
        const b = shot.data[j + 2];
        if (r !== g || g !== b) fringe = Math.max(fringe, Math.abs(r - g), Math.abs(g - b), Math.abs(r - b));
        grey[i] = Math.round((r + g + b) / 3);
      }
      if (fringe) notes.push(`${px} px: colour fringes up to ${fringe} levels (LCD anti-aliasing), folded into grey`);
      // every glyph but the space must have ink, the space none
      for (const w of WEIGHTS) {
        Array.from(ATLAS_CHARS[w]).forEach((ch, i) => {
          const col = i % L.cols;
          const row = L.rows[w] + Math.floor(i / L.cols);
          let ink = 0;
          for (let y = 0; y < L.slotH; y++) for (let x = 0; x < L.slotW; x++) ink += grey[(row * L.slotH + y) * L.width + col * L.slotW + x];
          if (ch === ' ' ? ink !== 0 : ink === 0) throw new Error(`${px} px weight ${w}: ${JSON.stringify(ch)} ${ch === ' ' ? 'has ink' : 'drew nothing'}`);
        });
      }
      fs.writeFileSync(path.join(outDir, L.png), encodePng(L.width, L.height, grey, 1, { level: 9 }));
      files.push(L.png);
      meta.sizes[px] = L;
      log(`${px} px: cell ${L.cellW} x ${L.cellH} (advance ${L.advance}, baseline ${L.baseline}), ${L.width} x ${L.height} PNG`);
    }
  }, { root });
  fs.writeFileSync(path.join(outDir, ATLAS_FILE), JSON.stringify(meta, null, 2) + '\n');
  files.push(ATLAS_FILE);
  return { meta, files, notes };
}

function parseArgs(argv) {
  const o = { out: ATLAS_DIR, sizes: null, check: false, quiet: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') o.out = path.resolve(argv[++i]);
    else if (a === '--sizes') o.sizes = String(argv[++i]).split(',').map(Number);
    else if (a === '--check') o.check = true;
    else if (a === '--quiet') o.quiet = true;
    else throw new Error(`unknown argument ${a} (use --out <dir>, --sizes 16,20,..., --check, --quiet)`);
  }
  if (o.sizes && !o.sizes.every((n) => Number.isInteger(n) && n >= 8 && n <= 128)) throw new Error('--sizes takes whole numbers from 8 to 128');
  return o;
}

async function cli() {
  const o = parseArgs(process.argv.slice(2));
  const log = o.quiet ? () => {} : (s) => console.log(s);
  const sizes = o.sizes || atlasSizes();
  if (o.check) {
    const tmp = makeTempDir('pcd-atlas-check-');
    try {
      const r = await make(tmp, { sizes, log });
      const differ = [];
      for (const f of r.files) {
        const a = path.join(tmp, f);
        const b = path.join(o.out, f);
        if (!fs.existsSync(b) || !fs.readFileSync(a).equals(fs.readFileSync(b))) differ.push(f);
      }
      for (const n of r.notes) log(`note: ${n}`);
      if (differ.length) {
        console.error(`make-atlas --check: ${differ.length} file(s) differ from ${o.out}: ${differ.join(', ')}`);
        return 1;
      }
      log(`make-atlas --check: ${r.files.length} files identical to ${o.out}`);
      return 0;
    } finally {
      await rmrf(tmp);
    }
  }
  fs.mkdirSync(o.out, { recursive: true });
  const r = await make(o.out, { sizes, log });
  for (const n of r.notes) log(`note: ${n}`);
  log(`wrote ${r.files.length} files to ${o.out}`);
  return 0;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) cli().then((c) => { process.exitCode = c; }, (e) => { console.error(`make-atlas: ${e && e.stack || e}`); process.exitCode = 1; });
