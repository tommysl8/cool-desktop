#!/usr/bin/env node
// The style tile's visual gate: the console look, shot and checked in headless Chrome. Node built-ins only.
//
//   node tools/test-style-tile.mjs [--no-build] [--only <name>[,<name>...]] [--out wip/shots/console] [--list] [--sweep]
//
// Builds dist/style-tile (node tools/build.mjs style-tile --no-sync) unless --no-build, serves it on 127.0.0.1
// (tools/lib/serve.mjs) and opens it in headless Chrome through tools/lib/chrome.mjs (a fresh temp profile, the privacy
// guard on, every host but 127.0.0.1 unresolvable; the tile itself makes no request). Each device pixel ratio gets its
// own browser launched at that real scale factor (CDP's ratio emulation is not pixel-exact in Chrome 157).
//
// Shots (PNG in --out): the board at 1280x800@2 and 2560x1440@1 (full page: palette, contrast gate, type, glyphs and
// the glyph gate, the console's ASCII elements, every theme at dawn / day / sunset / night, and the console in 4
// themes x day and night on both sides); the new tab at ten reference moments (sizes from 800x500 to 3440x1440, with
// the font size and k each must keep); the wallpaper (column right; one flipped left, one without a taskbar) and
// the still's calendar face; the new tab's states (ringing, snoozed, no weather and no clock, 24 h with old weather,
// the settings sheet, no links); and the console driven live by PCD.host (the reference wiring of style-tile.js).
// --sweep adds each side at 20 sizes (the portrait, ultrawide, tiny and real-window ones included).
//
// Checks per console: the page is ready, zero console errors, exceptions and CSP reports, TermMono in use; no infinite
// animation, filter, backdrop-filter, shadow or gradient anywhere but the scene layer's one veil; the layer is crisp
// (every device px equals its k x k block: the dimmed frame, the band row, the seam column); every element sits on
// the cell grid (whole cells from the grid origin, whole device px); nothing is clipped (every element inside the
// screen); no two parts overlap; the wallpaper's text stays above the taskbar; what dropped is a prefix of
// PCD.console.DROPS; for the static full-size shots every text run keeps >= 4.5:1 against the brightest pixel behind
// it (a second load with ui=0 is the background; glyph-only runs are decorative); and the reference moments keep their
// numbers (font size, k). Theme thumbnails: crisp. Live: about 30 fps and 30 engine steps a second, the colon
// blinking, zero DOM mutations in the column (no per-frame text work); performance mode at 15 fps with 30 steps a
// second and a steady colon; a hidden tab runs no timer and no animation frame at all (a spy counts them) and resumes.
// Exit code 1 when a check fails.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch } from './lib/chrome.mjs';
import { serve } from './lib/serve.mjs';
import { ensureDir, writeBytes } from './lib/fsx.mjs';
import { decodePng } from './lib/png.mjs';
import { printReport } from './lib/report.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PKG = path.join(ROOT, 'dist', 'style-tile');
const DEFAULT_OUT = path.join(ROOT, 'wip', 'shots', 'console');
const MIN_CONTRAST = 4.5;
/** Glyph-only runs (lines, marks, brackets, the weather art): decorative, 3:1 is enough. */
const DECOR = /^[\s·─░⌂»›≡\[\]()|_\-.,'`\\/*O:]+$/;

/** The ten reference moments: name, viewport, knobs, the numbers each must keep (font size, k). */
const REFERENCE_MOMENTS = [
  ['1280x800@2-night', 1280, 800, 2, { at: '2026-11-15T20:40', wx: 'drizzle' }, { font: 18, k: 25 }],
  ['1280x800@2-fresh', 1280, 800, 2, { at: '2026-11-15T07:50', wx: 'partly' }, { font: 18, k: 25 }],
  ['1280x800@2-help', 1280, 800, 2, { at: '2027-01-12T13:05', wx: 'snow' }, { font: 18, k: 25 }],
  ['1280x620@2-real', 1280, 620, 2, { at: '2026-11-15T21:40', wx: 'cloudy', theme: 'winter' }, { font: 14 }],
  ['1440x900-winter-day', 1440, 900, 1, { at: '2027-01-12T13:05', wx: 'snow' }, { k: 15 }],
  ['1920x1080-summer-day', 1920, 1080, 1, { at: '2026-07-18T14:10', wx: 'clear' }, { k: 18 }],
  ['2560x1440-halloween', 2560, 1440, 1, { at: '2026-10-31T21:10', wx: 'clear' }, { k: 25 }],
  ['3440x1440-christmas', 3440, 1440, 1, { at: '2026-12-24T16:30', wx: 'snow' }, { k: 25 }],
  ['800x500-spring', 800, 500, 1, { at: '2026-04-20T08:15', wx: 'partly' }, { k: 8 }],
  ['800x500@2-spring', 800, 500, 2, { at: '2026-04-20T08:15', wx: 'partly' }, { k: 16 }],
];
/** The sweep: 20 sizes per side. */
export const SWEEP = [
  [1280, 620, 2], [1280, 800, 2], [1440, 900, 1], [1920, 1080, 1], [2560, 1440, 1], [3840, 2160, 1], [3440, 1440, 1],
  [800, 500, 1], [1080, 1920, 1], [320, 200, 1], [800, 500, 2], [1366, 768, 1], [1536, 864, 1], [1920, 969, 1],
  [2560, 700, 1], [5120, 1440, 1], [600, 900, 1], [420, 760, 2], [1600, 300, 1], [999, 777, 1],
];
const MOMENTS = [
  ['2026-11-15T20:40', 'drizzle'], ['2027-01-12T13:05', 'snow'], ['2026-07-18T14:10', 'clear'], ['2026-10-31T21:10', 'clear'],
  ['2026-04-20T08:15', 'partly'], ['2026-12-24T16:30', 'snow'], ['2026-11-15T12:30', 'partly'], ['2027-01-20T11:40', 'snow'],
];

export function shotList({ sweep = false } = {}) {
  const C = (q) => ({ view: 'console', ...q });
  const list = [
    { name: 'board-1280x800@2', w: 1280, h: 800, dpr: 2, q: { view: 'board' }, full: true },
    { name: 'board-2560x1440@1', w: 2560, h: 1440, dpr: 1, q: { view: 'board' }, full: true },
  ];
  for (const [name, w, h, dpr, q, expect] of REFERENCE_MOMENTS) {
    list.push({ name: `newtab-${name}`, w, h, dpr, q: C({ profile: 'newtab', status: 'next', ...q }), contrast: true, expect });
  }
  list.push(
    { name: 'wallpaper-1920x1080@1-night', w: 1920, h: 1080, dpr: 1, q: C({ profile: 'wallpaper', at: '2026-11-15T20:40', wx: 'drizzle' }), contrast: true },
    { name: 'wallpaper-2560x1440@1-halloween', w: 2560, h: 1440, dpr: 1, q: C({ profile: 'wallpaper', at: '2026-10-31T21:10', wx: 'clear' }), contrast: true },
    { name: 'wallpaper-3840x2160@1-winter-day', w: 3840, h: 2160, dpr: 1, q: C({ profile: 'wallpaper', at: '2027-01-20T11:40', wx: 'snow' }), contrast: true },
    { name: 'wallpaper-1280x800@2-christmas', w: 1280, h: 800, dpr: 2, q: C({ profile: 'wallpaper', at: '2026-12-24T21:30', wx: 'snow' }), contrast: true },
    { name: 'wallpaper-1920x1080@1-left', w: 1920, h: 1080, dpr: 1, q: C({ profile: 'wallpaper', side: 'left', at: '2026-07-18T14:10', wx: 'clear' }), contrast: true, expect: { side: 'left' } },
    { name: 'wallpaper-1920x1080@1-no-taskbar', w: 1920, h: 1080, dpr: 1, q: C({ profile: 'wallpaper', taskbar: '0', at: '2026-11-15T12:30', wx: 'partly' }), contrast: true },
    { name: 'still-1280x800@2-date', w: 1280, h: 800, dpr: 2, q: C({ profile: 'still', at: '2026-11-15T19:37', wx: 'drizzle' }), contrast: true },
    // the new tab's states
    { name: 'newtab-1280x800@2-ringing', w: 1280, h: 800, dpr: 2, q: C({ profile: 'newtab', at: '2026-12-25T07:00', wx: 'snow', status: 'ringing' }), contrast: true },
    { name: 'newtab-1280x800@2-snoozed', w: 1280, h: 800, dpr: 2, q: C({ profile: 'newtab', at: '2027-01-12T22:10', wx: 'clear', status: 'snoozed' }), contrast: true },
    { name: 'newtab-1280x800@2-bare', w: 1280, h: 800, dpr: 2, q: C({ profile: 'newtab', at: '2026-11-15T20:40', wx: 'off', status: 'off', suntimes: '0' }), contrast: true },
    { name: 'newtab-1280x800@2-24h-stale', w: 1280, h: 800, dpr: 2, q: C({ profile: 'newtab', at: '2026-11-15T20:40', wx: 'drizzle', clock: '24', stale: '130' }), contrast: true },
    { name: 'newtab-1280x800@2-sheet', w: 1280, h: 800, dpr: 2, q: C({ profile: 'newtab', at: '2026-11-15T12:30', wx: 'partly', sheet: '1' }) },
    { name: 'newtab-1280x800@2-no-links', w: 1280, h: 800, dpr: 2, q: C({ profile: 'newtab', at: '2026-11-15T20:40', wx: 'drizzle', links: '0' }), contrast: true },
    // the console driven by PCD.host (the reference wiring): the scene animates, the colon blinks, the column is still
    { name: 'live-newtab-1280x800@2', w: 1280, h: 800, dpr: 2, q: C({ profile: 'newtab', at: '2026-11-15T20:40', wx: 'drizzle', status: 'next', live: '1' }), live: 2500 },
    { name: 'live-wallpaper-1920x1080@1', w: 1920, h: 1080, dpr: 1, q: C({ profile: 'wallpaper', at: '2026-11-15T19:30', wx: 'drizzle', live: '1' }), live: 2500 },
    // performance mode: 15 fps, still 30 engine steps a second, a steady colon
    { name: 'live-perf-wallpaper-1920x1080@1', w: 1920, h: 1080, dpr: 1, q: C({ profile: 'wallpaper', at: '2026-11-15T19:30', wx: 'drizzle', live: '1', perf: '1' }), live: 3000, perf: true },
    // a hidden tab while the clock rings: no timer and no animation frame at all
    { name: 'live-hidden-newtab-1280x800@2', w: 1280, h: 800, dpr: 2, q: C({ profile: 'newtab', at: '2026-12-25T07:00', wx: 'snow', status: 'ringing', live: '1' }), live: 1500, hide: true },
  );
  if (sweep) {
    for (const profile of ['newtab', 'wallpaper']) {
      SWEEP.forEach(([w, h, dpr], i) => {
        const [at, wx] = MOMENTS[i % MOMENTS.length];
        list.push({ name: `sweep-${profile}-${w}x${h}@${dpr}`, w, h, dpr, q: C({ profile, at, wx, status: 'next', stale: i % 5 === 4 ? '130' : '0' }), contrast: true });
      });
    }
  }
  return list;
}

function parseArgs(argv) {
  const o = { build: true, only: null, out: DEFAULT_OUT, list: false, sweep: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--no-build') o.build = false;
    else if (a === '--only') o.only = String(argv[++i] || '').split(',').filter(Boolean);
    else if (a === '--out') o.out = path.resolve(argv[++i]);
    else if (a === '--list') o.list = true;
    else if (a === '--sweep') o.sweep = true;
    else throw new Error(`unknown option ${a}`);
  }
  return o;
}

function qs(q) {
  return Object.entries(q).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
}

/** Every k x k block of the scene's device rect equals the frame's pixel (tolerance 2 per channel). */
export function crisp(img, scene) {
  const { x, y, size, k, frame } = scene;
  if (!frame || frame.length !== 4096) return { ok: false, why: 'no frame' };
  if (size !== 64 * k) return { ok: false, why: `size ${size} != 64 x ${k}` };
  if (x < 0 || y < 0 || x + size > img.width || y + size > img.height) return { ok: false, why: `rect ${x},${y} ${size} outside the ${img.width}x${img.height} image` };
  let bad = 0;
  let first = null;
  for (let py = 0; py < 64; py++) {
    for (let px = 0; px < 64; px++) {
      const c = frame[py * 64 + px];
      const r = (c >> 16) & 255, g = (c >> 8) & 255, b = c & 255;
      for (let dy = 0; dy < k; dy++) {
        const row = (y + py * k + dy) * img.width;
        for (let dx = 0; dx < k; dx++) {
          const i = (row + x + px * k + dx) * 4;
          if (Math.abs(img.data[i] - r) > 2 || Math.abs(img.data[i + 1] - g) > 2 || Math.abs(img.data[i + 2] - b) > 2) {
            bad++;
            if (!first) first = { x: x + px * k + dx, y: y + py * k + dy, want: [r, g, b], got: [img.data[i], img.data[i + 1], img.data[i + 2]] };
          }
        }
      }
    }
  }
  return { ok: bad === 0, bad, first };
}

/**
 * The console's scene layer is crisp: inside the console's own device rect (at origin), every device px equals its
 * block: the dimmed frame inside the scene, the band row beside it, the seam column next to it (tolerance 2). Pixels
 * under the veil are not checked: pass a render without the veil and the text (ui=0&veil=0), or limit `rows` to the
 * console's rows that nothing covers.
 */
export function crispLayer(img, c) {
  const g = c.scene;
  if (!g || !c.frame) return { ok: false, why: 'no layer' };
  const { k } = g;
  let bad = 0;
  let first = null;
  for (let y = 0; y < g.Hd; y++) {
    const ry = Math.floor((y - g.y) / k);
    for (let x = 0; x < g.Wd; x++) {
      let want = null;
      if (ry >= 0 && ry < 64) {
        if (x >= g.x && x < g.x + g.size) want = c.frame[ry * 64 + Math.floor((x - g.x) / k)];
        else if (g.fade && x >= g.fade.x && x < g.fade.x + g.fade.w) want = c.fade[ry * c.fadeCols + Math.floor((x - g.fade.x) / k)];
        else if (g.band && x >= g.band.x && x < g.band.x + g.band.w) want = c.bandRows[ry];
      }
      const X = c.origin.x + x, Y = c.origin.y + y;
      if (X >= img.width || Y >= img.height) continue;
      const i = (Y * img.width + X) * 4;
      if (want === null || want === undefined || want < 0) {
        bad++;
        if (!first) first = { x, y, why: 'no layer here' };
        continue;
      }
      if (Math.abs(img.data[i] - ((want >> 16) & 255)) > 2 || Math.abs(img.data[i + 1] - ((want >> 8) & 255)) > 2 || Math.abs(img.data[i + 2] - (want & 255)) > 2) {
        bad++;
        if (!first) first = { x, y, want: [(want >> 16) & 255, (want >> 8) & 255, want & 255], got: [img.data[i], img.data[i + 1], img.data[i + 2]] };
      }
    }
  }
  return { ok: bad === 0, bad, first };
}

/** WCAG contrast of each text run against the brightest pixel behind it (bg: a render of the same moment, ui=0). */
export function contrastRuns(bgImg, dpr, runs) {
  const lin = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  const lum = (r, g, b) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  const out = [];
  for (const r of runs) {
    if (DECOR.test(r.text)) continue;
    const x0 = Math.max(0, Math.floor(r.x * dpr)), x1 = Math.min(bgImg.width, Math.ceil((r.x + r.w) * dpr));
    const y0 = Math.max(0, Math.floor(r.y * dpr)), y1 = Math.min(bgImg.height, Math.ceil((r.y + r.h) * dpr));
    let maxL = 0;
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      const i = (y * bgImg.width + x) * 4;
      const L = lum(bgImg.data[i], bgImg.data[i + 1], bgImg.data[i + 2]);
      if (L > maxL) maxL = L;
    }
    const Lt = lum(...r.color);
    out.push({ ...r, ratio: (Math.max(Lt, maxL) + 0.05) / (Math.min(Lt, maxL) + 0.05) });
  }
  return out;
}

/** The visible text runs under the console (Range client rects: exactly where the glyphs are). */
const RUNS = `(() => {
  const out = [];
  for (const root of document.querySelectorAll('.pcd-console')) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const t = n.nodeValue;
      if (!t || !t.trim()) continue;
      const el = n.parentElement;
      if (!el || el.closest('[hidden]') || el.closest('.pcd-sr') || getComputedStyle(el).visibility === 'hidden') continue;
      const m = /rgba?\\((\\d+), (\\d+), (\\d+)/.exec(getComputedStyle(el).color);
      const range = document.createRange();
      range.selectNodeContents(n);
      for (const r of range.getClientRects()) {
        if (r.width < 1 || r.height < 1) continue;
        const part = el.closest('[class*="pcd-"]');
        out.push({ text: t.trim().slice(0, 40), part: part ? part.className : '', color: m ? [+m[1], +m[2], +m[3]] : [255, 255, 255], x: r.left + scrollX, y: r.top + scrollY, w: r.width, h: r.height });
      }
    }
  }
  return out;
})()`;

function overlaps(a, b) {
  return a.x < b.x + b.w - 0.5 && b.x < a.x + a.w - 0.5 && a.y < b.y + b.h - 0.5 && b.y < a.y + a.h - 0.5;
}

/** The part an element belongs to (one part's elements may touch: the clock's shadow, pixels, colon and am/pm). */
function partOf(cls) {
  const m = /pcd-(clockpx|clock|colon|side|greet|date|status|striptext|strip|weather|link|rule|term|hint|caption|settings)\b/.exec(cls || '');
  if (!m) return cls;
  return { clockpx: 'clock', colon: 'clock', side: 'clock', striptext: 'strip' }[m[1]] || m[1];
}

/** Checks of one console (c: a report().consoles entry). */
function checkConsole(shot, rep, c, img, extra) {
  const rows = [];
  const row = (what, pass, detail) => rows.push({ name: `${shot.name}: ${c.name !== 'console' ? c.name + ' ' : ''}${what}`, pass, detail });
  const where = (t) => `${t.cls.split(' ').filter((x) => x.startsWith('pcd-') && x !== 'pcd-g').join('.')} at ${Math.round(t.x)},${Math.round(t.y)}`;
  row('ready', c.ready && c.fontFamily === 'TermMono', `${c.fontFamily} ${c.fontPx} px, cell ${c.cell.w}x${c.cell.h}, grid ${c.grid.cols}x${c.grid.rows}, column ${c.col.c}+${c.col.cols} (${c.side}), k ${c.scene && c.scene.k} ${c.scene && c.scene.place}`);
  // the layer is crisp (a live console's frame moves on, and the veil and the text cover it: the static shots load
  // a bare render for this)
  if (extra.bare) {
    const cr = crispLayer(extra.bare, c);
    row('crisp layer', cr.ok, cr.ok ? `every device px of ${c.scene.Wd}x${c.scene.Hd} on its k x k block (scene, band, seam)` : `${cr.bad} px off, first ${JSON.stringify(cr.first)}`);
  }
  // the cell grid
  const off = c.texts.filter((t) => {
    if (/pcd-colon/.test(t.cls)) return Math.abs(t.x - Math.round(t.x)) > 0.02 || Math.abs(t.y - Math.round(t.y)) > 0.02;
    const dx = (t.x - c.origin.x - c.grid.xDev) / c.cell.wDev;
    const dy = (t.y - c.origin.y) / c.cell.hDev;
    return Math.abs(dx - Math.round(dx)) > 0.01 || Math.abs(dy - Math.round(dy)) > 0.01;
  });
  row('on the cell grid', off.length === 0, off.length ? off.slice(0, 3).map(where).join('; ') : `${c.texts.length} elements on whole cells and device px`);
  // nothing clipped: every element inside the console's screen
  const W = c.scene ? c.scene.Wd : img.width, H = c.scene ? c.scene.Hd : img.height;
  const cut = c.texts.filter((t) => t.x - c.origin.x < -0.5 || t.y - c.origin.y < -0.5 || t.x - c.origin.x + t.w > W + 0.5 || t.y - c.origin.y + t.h > H + 0.5);
  row('nothing clipped', cut.length === 0, cut.length ? cut.slice(0, 3).map(where).join('; ') : `${c.texts.length} elements inside the ${W}x${H} screen`);
  // no two parts overlap (the text runs when we have them, else the elements)
  const boxes = (extra.runs ? extra.runs.map((r) => ({ part: partOf(r.part), x: r.x * rep.dpr, y: r.y * rep.dpr, w: r.w * rep.dpr, h: r.h * rep.dpr, text: r.text })) : c.texts.map((t) => ({ part: partOf(t.cls), ...t })))
    .filter((b) => b.x >= c.origin.x - 0.5 && b.y >= c.origin.y - 0.5 && b.x < c.origin.x + W && b.y < c.origin.y + H);
  if (extra.runs) for (const t of c.texts) if (/pcd-(clockpx|strip\b|term)/.test(t.cls)) boxes.push({ part: partOf(t.cls), ...t });
  const hits = [];
  for (let i = 0; i < boxes.length && hits.length < 3; i++) for (let j = i + 1; j < boxes.length; j++) {
    if (boxes[i].part !== boxes[j].part && overlaps(boxes[i], boxes[j])) hits.push(`${boxes[i].part} "${boxes[i].text}" x ${boxes[j].part} "${boxes[j].text}"`);
  }
  row('no overlap', hits.length === 0, hits.length ? hits.join(' | ') : `${boxes.length} boxes apart`);
  // the taskbar: the wallpaper's text stays above it
  if (c.profile === 'wallpaper' && c.taskbar) {
    const limit = c.origin.y + H - c.taskbar;
    const under = boxes.filter((b) => b.y + b.h > limit + 0.5);
    row('clear of the taskbar', under.length === 0, under.length ? under.slice(0, 3).map((b) => b.text).join('; ') : `everything above ${limit - c.origin.y} device px (taskbar ${c.taskbar})`);
  }
  // the drop order
  const d = c.dropped || [];
  const prefix = d.every((x, i) => x === extra.DROPS[i]);
  row('drop order', prefix, `dropped [${d.join(', ')}]; clock ${c.plan.clock}, weather ${c.plan.weather}, head ${c.plan.head}, strip ${c.plan.strip}${c.profile === 'newtab' ? `, links ${c.plan.links}, rule ${c.plan.rule}, terminal ${c.content.term || '-'}` : ''}`);
  // contrast
  if (extra.runs && extra.bg) {
    const res = contrastRuns(extra.bg, rep.dpr, extra.runs);
    const low = res.filter((r) => r.ratio < MIN_CONTRAST).sort((a, b) => a.ratio - b.ratio);
    const min = res.reduce((m, r) => Math.min(m, r.ratio), Infinity);
    row('contrast >= 4.5:1', low.length === 0, low.length ? low.slice(0, 3).map((r) => `${r.ratio.toFixed(2)} "${r.text}"`).join('; ') : `${res.length} text runs, min ${min === Infinity ? '-' : min.toFixed(2)}:1`);
  }
  // the reference numbers
  if (shot.expect) {
    const e = shot.expect;
    const ok = (e.font === undefined || e.font === c.fontPx) && (e.k === undefined || (c.scene && e.k === c.scene.k)) && (e.side === undefined || e.side === c.side);
    row('the reference numbers', ok, `expected ${JSON.stringify(e)}; got font ${c.fontPx} k ${c.scene && c.scene.k} side ${c.side}`);
  }
  return rows;
}

/** Checks of one shot's report and image; rows for the PASS/FAIL table. */
function checkShot(shot, rep, img, pageErrors, extra) {
  const rows = [];
  const row = (what, pass, detail) => rows.push({ name: `${shot.name}: ${what}`, pass, detail });
  const errs = [...pageErrors, ...(rep.errors || [])];
  row('no errors', errs.length === 0, errs.length ? errs.slice(0, 3).join(' | ') : 'console, exceptions and CSP clean');
  row('font', !!(rep.font && rep.font.family === 'TermMono'), rep.font ? `${rep.font.family} (${rep.font.active})` : 'no font info');
  row('motion and effects', rep.infiniteAnimations === 0 && rep.effects.length === 0,
    `${rep.infiniteAnimations} infinite animations; ${rep.effects.length ? 'effects on ' + rep.effects.slice(0, 3).join(', ') : 'no filter, shadow or gradient (the veil aside)'}`);
  if (rep.gate) {
    const g = rep.gate;
    row('glyph gate', g.every((x) => x.pass), g.map((x) => `${x.family} ${x.pass ? 'pass' : 'FAIL ' + x.fails.map((f) => f.cp).join(' ')} (${x.tested})`).join('; '));
  }
  if (rep.liveMs) {
    const lv = rep.live;
    const s = lv && lv.stats;
    const secs = rep.liveMs / 1000;
    if (rep.perf) {
      row('live: performance mode, 15 fps with 30 steps a second', !!s && s.frames >= 11 * secs && s.frames <= 17 * secs && s.steps >= 27 * secs,
        s ? `${s.frames} frames, ${s.steps} engine steps in ${secs} s (${s.fps} fps)` : 'no host stats');
      row('live: the colon is steady in performance mode', !!lv && lv.counts.colonOff === 0, lv ? `${lv.counts.colon} colon events, ${lv.counts.colonOff} off` : 'no counts');
    } else {
      row('live: the host drives the console', !!s && s.frames >= 20 * secs && s.steps >= 25 * secs && lv.counts.frames >= 20 * secs,
        s ? `${s.frames} frames (${lv.counts.frames} through con.frame), ${s.steps} engine steps in ${secs} s (${s.fps} fps, p95 ${s.p95} ms)` : 'no host stats');
      row('live: the colon blinks', !!lv && lv.counts.colon >= 3 && lv.counts.colonOff >= 1, lv ? `${lv.counts.colon} colon events, ${lv.counts.colonOff} off` : 'no counts');
    }
    row('live: no per-frame column work', !!lv && lv.counts.mutations === 0, lv ? `${lv.counts.mutations} DOM mutations in the column in ${secs} s (views ${lv.counts.views})` : 'no counts');
  }
  if (rep.hidden) {
    const h = rep.hidden;
    if (h.vis !== 'hidden') row('hidden: no timer and no animation frame', null, `the tab did not become hidden (visibilityState ${h.vis})`);
    else row('hidden: no timer and no animation frame', h.counts.setTimeout === 0 && h.counts.setInterval === 0 && h.counts.raf === 0,
      `in 1.5 s hidden: ${JSON.stringify(h.counts)}; after coming back: ${h.resumed} animation frames`);
  }
  // the theme thumbnails of the board are crisp
  const bad = [];
  for (const s of rep.scenes) {
    const c = crisp(img, s);
    if (!c.ok) bad.push(`${s.name}: ${c.why || c.bad + ' px off, first ' + JSON.stringify(c.first)}`);
  }
  if (rep.scenes.length) row('crisp theme thumbnails', bad.length === 0, bad.length ? bad.slice(0, 2).join(' | ') : `${rep.scenes.length} scenes, every k x k block exact`);
  for (const c of rep.consoles || []) {
    // the board's minis: the bare layer is the board itself where nothing covers it (no ui=0 render of a full board)
    rows.push(...checkConsole(shot, rep, c, img, { ...extra, bare: extra.bare || null, runs: extra.runs || null }));
  }
  return rows;
}

/** Counts every setTimeout, setInterval and animation frame the page asks for (installed before its scripts run). */
const TIMER_SPY = `(function () {
  var c = window.__timers = { setTimeout: 0, setInterval: 0, raf: 0 };
  var st = window.setTimeout, si = window.setInterval, raf = window.requestAnimationFrame;
  window.setTimeout = function () { c.setTimeout++; return st.apply(window, arguments); };
  window.setInterval = function () { c.setInterval++; return si.apply(window, arguments); };
  window.requestAnimationFrame = function (fn) { c.raf++; return raf.call(window, fn); };
})();`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function open(browser, base, shot, q) {
  const page = await browser.newPage();
  await page.setViewport(shot.w, shot.h, shot.dpr);
  if (shot.hide) await page.send('Page.addScriptToEvaluateOnNewDocument', { source: TIMER_SPY });
  await page.goto(`${base}index.html?${qs(q)}`);
  await page.waitFor("document.documentElement.dataset.ready === '1' || document.documentElement.dataset.ready === 'error'", { timeoutMs: 60000 });
  await page.evaluate('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))');
  return page;
}

async function shoot(browser, base, shot, out) {
  const page = await open(browser, base, shot, shot.q);
  try {
    let live = null;
    let hidden = null;
    if (shot.live) {
      await sleep(shot.live);
      live = await page.evaluate('window.__tile.live ? window.__tile.live() : null');
    }
    if (shot.hide) {
      // another tab in front: the page is hidden; nothing may run (the host's loop and text timers)
      const other = await browser.newPage();
      await browser.send('Target.activateTarget', { targetId: other.targetId });
      await sleep(400);
      const vis = await page.evaluate('document.visibilityState');
      const t0 = await page.evaluate('({ ...window.__timers })');
      await sleep(1500);
      const t1 = await page.evaluate('({ ...window.__timers })');
      await browser.send('Target.activateTarget', { targetId: page.targetId });
      await other.close();
      await sleep(600);
      const back = await page.evaluate('({ ...window.__timers })');
      hidden = { vis, counts: { setTimeout: t1.setTimeout - t0.setTimeout, setInterval: t1.setInterval - t0.setInterval, raf: t1.raf - t0.raf }, resumed: back.raf - t1.raf };
    }
    const rep = await page.evaluate('window.__tile.report()');
    const DROPS = await page.evaluate('PCD.console ? PCD.console.DROPS : []');
    const runs = shot.contrast ? await page.evaluate(RUNS) : null;
    rep.live = live;
    rep.liveMs = shot.live || 0;
    rep.perf = !!shot.perf;
    rep.hidden = hidden;
    const buf = await page.screenshot({ fullPage: !!shot.full });
    const file = path.join(out, `${shot.name}.png`);
    writeBytes(file, buf);
    const img = decodePng(buf);
    const errs = page.errors.map((e) => `${e.type}: ${e.text}`).filter((t) => !/favicon/.test(t));
    // the same static moment twice more: ui=0 (the background of the contrast check), ui=0&veil=0 (the crisp check)
    let bg = null;
    let bare = null;
    if (!shot.live && shot.q.view === 'console') {
      if (shot.contrast) {
        const p2 = await open(browser, base, shot, { ...shot.q, ui: '0' });
        bg = decodePng(await p2.screenshot());
        await p2.close();
      }
      const p3 = await open(browser, base, shot, { ...shot.q, ui: '0', veil: '0' });
      bare = decodePng(await p3.screenshot());
      await p3.close();
    }
    return { rep, img, file, errs, extra: { DROPS, runs, bg, bare } };
  } finally {
    await page.close();
  }
}

export async function run({ build = true, only = null, out = DEFAULT_OUT, sweep = false, log = console.log } = {}) {
  if (build) {
    const { main } = await import('./build.mjs');
    const code = await main({ argv: ['style-tile', '--no-sync'], log: () => {}, logError: log });
    if (code !== 0) throw new Error('the style-tile build failed');
  }
  if (!fs.existsSync(path.join(PKG, 'index.html'))) throw new Error('dist/style-tile is missing (build it first)');
  ensureDir(out);
  const shots = shotList({ sweep }).filter((s) => !only || only.some((n) => s.name.includes(n)));
  const server = await serve(PKG);
  const rows = [];
  const files = [];
  try {
    for (const dpr of [...new Set(shots.map((s) => s.dpr))]) {
      const browser = await launch({ deviceScaleFactor: dpr });
      try {
        for (const shot of shots.filter((s) => s.dpr === dpr)) {
          const t = Date.now();
          try {
            const r = await shoot(browser, server.url, shot, out);
            files.push(r.file);
            const pngOk = r.img.width === Math.round(shot.w * dpr) && (shot.full || r.img.height === Math.round(shot.h * dpr));
            rows.push({ name: `${shot.name}: screenshot`, pass: pngOk, detail: `${path.relative(ROOT, r.file)} ${r.img.width}x${r.img.height} in ${Date.now() - t} ms` });
            rows.push(...checkShot(shot, r.rep, r.img, r.errs, r.extra));
          } catch (e) {
            rows.push({ name: `${shot.name}: run`, pass: false, detail: String(e && e.message ? e.message : e).split('\n')[0] });
          }
        }
      } finally {
        await browser.close();
      }
      browser.assertNoViolations();
    }
  } finally {
    await server.close();
  }
  return { rows, files };
}

async function cli() {
  const o = parseArgs(process.argv.slice(2));
  if (o.list) {
    for (const s of shotList({ sweep: o.sweep })) console.log(s.name);
    return 0;
  }
  const { rows } = await run(o);
  const sum = printReport(rows, { title: 'style tile: the visual gate' });
  return sum.failed ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  cli().then((code) => process.exit(code), (e) => {
    console.error(e && e.stack ? e.stack : e);
    process.exit(1);
  });
}
