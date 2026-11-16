#!/usr/bin/env node
// Engine smoke test in headless Chrome: node tools/smoke.mjs [--out <dir>] [--quick]
//
// Loads tools/smoke/index.html: the synced engine straight from vendor/pixelclock/ plus src/shared/pcd-hook.js and
// pcd-engine.js, as classic scripts under the MV3 default CSP, with no build step. Over http://127.0.0.1 it renders
// themes x times of day (dawn, day, sunset, night), the hook modes, a shake, and whole screens (1080p, 1440p, 4K,
// 4K at 150 %, 1280x800 at 200 %, 1536x864 at 125 %); over file:// (how Lively opens a wallpaper) it renders one
// frame again. Every screenshot is checked pixel by pixel:
//   - the canvas is 64x64, scaled by a whole number k >= 2 of device pixels at integer device coordinates, and the
//     measured device-pixel box is exactly 64k,
//   - crisp: every k x k block is one flat colour, exactly the engine's frame pixel (no smoothing, no bleeding),
//   - the 1-pixel ring around the scene and the screen corners are the match colour mix(edge, bg, 0.7),
//   - zero console errors, zero CSP violations, drawClock once per frame.
// Writes <out>/smoke-*.png and smoke-sheet.png (a contact sheet labelled in the clock's own 3x5 letters), default
// dist/screens/, and prints a PASS/FAIL table; exit code 1 on any FAIL. Node built-ins only; the browser runs
// headless with a fresh temp profile and no network (the page makes no request; weather is mocked anyway).
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { launch } from './lib/chrome.mjs';
import { ensureDir, toPosix } from './lib/fsx.mjs';
import { decodePng, encodePng } from './lib/png.mjs';
import { printReport } from './lib/report.mjs';
import { serve } from './lib/serve.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, '..');
export const PAGE_REL = 'tools/smoke/index.html';
const BG = 0x141016;

/** Themes with a date on which the clock's own schedule picks them (autoId), so the auto path is exercised too. */
export const THEMES = [
  { theme: 'winter', date: '2026-01-20' },
  { theme: 'spring', date: '2026-04-22' },
  { theme: 'summer', date: '2026-07-15' },
  { theme: 'autumn', date: '2026-11-15' },
  { theme: 'halloween', date: '2026-10-31' },
  { theme: 'christmas', date: '2026-12-24' },
];
/** Times of day on the engine's default sky keys (engine.js SKY): dawn 7:00, day, sunset 17:00, night. */
export const TIMES = [
  { label: 'dawn', hour: 7 },
  { label: 'day', hour: 12.5 },
  { label: 'sunset', hour: 17 },
  { label: 'night', hour: 22 },
];
/** Whole screens (no taskbar band here): k = floor(min(device w, h) / 64). */
export const SCREENS = [
  { name: '1080p', w: 1920, h: 1080, dpr: 1, k: 16, theme: 'autumn', date: '2026-11-15', hour: 19, label: 'evening' },
  { name: '1440p', w: 2560, h: 1440, dpr: 1, k: 22, theme: 'winter', date: '2026-01-20', hour: 21.5, label: 'night' },
  { name: '4k', w: 3840, h: 2160, dpr: 1, k: 33, theme: 'christmas', date: '2026-12-24', hour: 18.5, label: 'evening' },
  { name: '4k-150pct', w: 2560, h: 1440, dpr: 1.5, k: 33, theme: 'summer', date: '2026-07-15', hour: 13, label: 'day' },
  { name: 'laptop-200pct', w: 1280, h: 800, dpr: 2, k: 25, theme: 'halloween', date: '2026-10-31', hour: 20.5, label: 'night' },
  { name: '1080p-125pct', w: 1536, h: 864, dpr: 1.25, k: 16, theme: 'spring', date: '2026-04-22', hour: 7, label: 'dawn' },
];
const FIT_VIEW = { w: 960, h: 540, dpr: 1 };

function hex(c) {
  return '#' + (c >>> 0).toString(16).padStart(6, '0');
}

/**
 * Check a screenshot against what the page reports (r from __smoke.render). Returns { ok, problems, notes }.
 * Every device pixel of the scene must equal its engine pixel; the ring around it and the corners the match colour.
 */
export function checkShot(png, r, { expectK } = {}) {
  const problems = [];
  const img = decodePng(png);
  const { k, rect } = r;
  const W = Math.round(r.viewport[0] * r.dpr);
  const H = Math.round(r.viewport[1] * r.dpr);
  if (img.width !== W || img.height !== H) problems.push(`screenshot ${img.width}x${img.height}, expected ${W}x${H}`);
  if (!r.canvas || r.canvas[0] !== 64 || r.canvas[1] !== 64) problems.push(`the canvas is ${JSON.stringify(r.canvas)}, not 64x64`);
  if (r.rendering !== 'pixelated') problems.push(`image-rendering is ${JSON.stringify(r.rendering)}, not pixelated`);
  if (!Number.isInteger(k) || k < 2) problems.push(`k = ${k} is not a whole number >= 2`);
  if (expectK !== undefined && k !== expectK) problems.push(`k = ${k}, expected ${expectK}`);
  if (![rect.x, rect.y, rect.size].every(Number.isInteger) || rect.size !== 64 * k) problems.push(`device rect ${JSON.stringify(rect)} is not integer 64k`);
  if (!r.box || r.box[0] !== 64 * k || r.box[1] !== 64 * k) problems.push(`device-pixel box ${JSON.stringify(r.box)} != ${64 * k}`);
  const p = r.placed;
  if (Math.abs(p.left - rect.x) > 0.02 || Math.abs(p.top - rect.y) > 0.02) problems.push(`canvas placed at ${p.left.toFixed(3)},${p.top.toFixed(3)} device px, expected ${rect.x},${rect.y}`);
  if (r.frame.length !== 4096) problems.push(`frame has ${r.frame.length} pixels, not 4096`);
  const at = (x, y) => {
    const i = (y * img.width + x) * 4;
    return (img.data[i] << 16) | (img.data[i + 1] << 8) | img.data[i + 2];
  };
  let badBlocks = 0;
  let badPixels = 0;
  let firstBad = '';
  if (!problems.length) {
    for (let sy = 0; sy < 64; sy++) {
      for (let sx = 0; sx < 64; sx++) {
        const want = r.frame[sy * 64 + sx] >>> 0;
        let bad = 0;
        for (let dy = 0; dy < k; dy++) {
          const yy = rect.y + sy * k + dy;
          for (let dx = 0; dx < k; dx++) if (at(rect.x + sx * k + dx, yy) !== want) bad++;
        }
        if (bad) {
          if (!badBlocks) firstBad = `scene pixel ${sx},${sy}: ${bad} of ${k * k} device pixels differ from ${hex(want)} (e.g. ${hex(at(rect.x + sx * k, rect.y + sy * k))})`;
          badBlocks++;
          badPixels += bad;
        }
      }
    }
    if (badBlocks) problems.push(`${badBlocks} of 4096 blocks not crisp/exact (${badPixels} device pixels); first: ${firstBad}`);
    // The ring just outside the scene and the four corners: the match colour.
    let ringBad = 0;
    const m = r.matchInt >>> 0;
    const ring = [];
    for (let x = rect.x - 1; x <= rect.x + rect.size; x++) ring.push([x, rect.y - 1], [x, rect.y + rect.size]);
    for (let y = rect.y; y < rect.y + rect.size; y++) ring.push([rect.x - 1, y], [rect.x + rect.size, y]);
    for (const [x, y] of ring) if (x >= 0 && y >= 0 && x < img.width && y < img.height && at(x, y) !== m) ringBad++;
    if (ringBad) problems.push(`${ringBad} pixels of the ring around the scene are not the match colour ${r.match}`);
    for (const [x, y] of [[0, 0], [img.width - 1, 0], [0, img.height - 1], [img.width - 1, img.height - 1]]) {
      if (at(x, y) !== m) problems.push(`corner ${x},${y} is ${hex(at(x, y))}, not the match colour ${r.match}`);
    }
  }
  const colours = new Set(r.frame).size;
  if (colours < 8) problems.push(`the frame has only ${colours} colours (blank?)`);
  if (r.hookCalls !== 1) problems.push(`drawClock ran ${r.hookCalls} times for one frame`);
  if (r.mode === 'device') {
    let clockPx = 0;
    for (let i = 0; i < 16 * 64; i++) if ((r.frame[i] >>> 0) === (r.colors.clock >>> 0)) clockPx++;
    if (clockPx < 20) problems.push(`device mode: only ${clockPx} pixels of the clock colour in rows 0-15`);
  }
  if (r.violations.length) problems.push(`CSP violations: ${r.violations.join('; ')}`);
  return { ok: problems.length === 0, problems, notes: `64x64 canvas, k=${k} (${rect.size} px at ${rect.x},${rect.y}, @${r.dpr}x${r.nudges ? `, ${r.nudges} nudge(s)` : ''}), 4096/4096 blocks exact, ring + corners ${r.match}, ${colours} colours` };
}

/** A contact sheet of frames, labelled with the clock's own 3x5 letters (vendor drawSmallText). Returns PNG bytes. */
export function contactSheet(rows, cols, { scale = 4, gap = 16, textScale = 3, PC } = {}) {
  const tile = 64 * scale;
  const label = 7 * textScale + 8;
  const W = gap + cols.length * (tile + gap);
  const H = gap + label + rows.length * (label + tile + gap);
  const data = Buffer.alloc(W * H * 3);
  for (let i = 0; i < W * H; i++) { data[i * 3] = (BG >> 16) & 255; data[i * 3 + 1] = (BG >> 8) & 255; data[i * 3 + 2] = BG & 255; }
  const put = (x, y, c) => {
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    const o = (y * W + x) * 3;
    data[o] = (c >> 16) & 255; data[o + 1] = (c >> 8) & 255; data[o + 2] = c & 255;
  };
  const text = (s, x0, y0, colour) => {
    const cv = new PC.Canvas(PC.smallTextWidth(s) + 2, 7);
    cv.clear(BG);
    PC.drawSmallText(cv, s, 1, 1, colour);
    for (let y = 0; y < cv.h; y++) for (let x = 0; x < cv.w; x++) {
      const c = cv.px[y * cv.w + x];
      if (c === BG) continue;
      for (let dy = 0; dy < textScale; dy++) for (let dx = 0; dx < textScale; dx++) put(x0 + x * textScale + dx, y0 + y * textScale + dy, c);
    }
  };
  cols.forEach((c, j) => text(c.toUpperCase(), gap + j * (tile + gap), gap - 3, 0xa99d91));
  rows.forEach((row, i) => {
    const top = gap + label + i * (label + tile + gap);
    text(row.title.toUpperCase(), gap, top - 3, 0xece4d8);
    row.frames.forEach((px, j) => {
      const left = gap + j * (tile + gap);
      for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) {
        const c = px[y * 64 + x] >>> 0;
        for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) put(left + x * scale + dx, top + label + y * scale + dy, c);
      }
    });
  });
  return encodePng({ width: W, height: H, data, channels: 3 });
}

/**
 * Run the smoke test. opts: { out (folder for smoke-*.png; default dist/screens), quick (fewer cases, for unit
 * tests), log }. Resolves { code, rows, shots, results }.
 */
export async function runSmoke({ out = path.join(ROOT, 'dist', 'screens'), quick = false, log = console.log } = {}) {
  const rows = [];
  const shots = [];
  const results = {};
  const add = (name, pass, detail) => rows.push({ name, pass, detail });
  ensureDir(out);
  for (const f of fs.readdirSync(out)) if (/^smoke-.*\.png$/.test(f)) fs.rmSync(path.join(out, f), { force: true });

  const themes = quick ? THEMES.filter((t) => ['winter', 'summer', 'autumn', 'christmas'].includes(t.theme)) : THEMES;
  const screens = quick ? SCREENS.filter((s) => ['laptop-200pct', '1080p-125pct'].includes(s.name)) : SCREENS;
  const srv = await serve(ROOT);
  const browser = await launch({ weather: 'mock' });
  const save = (name, buf) => {
    const file = path.join(out, `smoke-${name}.png`);
    fs.writeFileSync(file, buf);
    shots.push(file);
    return file;
  };
  const pageErrors = [];
  try {
    const page = await browser.newPage();
    await page.setViewport(FIT_VIEW.w, FIT_VIEW.h, FIT_VIEW.dpr);
    const url = srv.url + PAGE_REL;
    await page.goto(url);
    await page.waitFor('window.__smoke && window.__smoke.ready', { timeoutMs: 15000 });
    const info = await page.evaluate('window.__smoke.info()');
    const vendorThemes = JSON.parse(fs.readFileSync(path.join(ROOT, 'vendor', 'pixelclock', 'SYNC.json'), 'utf8')).files.filter((f) => f.path.startsWith('simulator/themes/')).length;
    add('page: synced engine loads with no build step (http://127.0.0.1, MV3 default CSP meta)', info.csp && info.hookInstalled && info.themes.length === vendorThemes && !info.violations.length,
      `${info.themes.length} themes registered (vendor has ${vendorThemes}), hook installed: ${info.hookInstalled}, CSP meta: ${info.csp}, violations: ${info.violations.length}`);
    add('page: theme menu order (auto, seasons, holidays)', info.menu[0] === 'auto' && info.menu.slice(1, 5).join() === 'winter,spring,summer,autumn', info.menu.join(', '));

    const shootOn = async (pg, name, opts, { expectK } = {}) => {
      const r = await pg.evaluate((o) => window.__smoke.render(o), opts);
      const png = await pg.screenshot();
      const file = save(name, png);
      const c = checkShot(png, r, { expectK });
      results[name] = r;
      add(`shot ${name}: ${r.id} ${opts.label || ''} ${r.mode}`.replace(/\s+/g, ' ').trim(), c.ok, c.ok ? `${c.notes}; ${toPosix(path.relative(ROOT, file))}` : c.problems.join('\n'));
      return r;
    };
    const shoot = (name, opts, more) => shootOn(page, name, opts, more);

    // Themes x times of day (fit layout at 960x540): the auto schedule picks each theme from its date.
    const sheetRows = [];
    for (const t of themes) {
      const frames = [];
      for (const tm of TIMES) {
        const r = await shoot(`${t.theme}-${tm.label}`, { date: t.date, hour: tm.hour, theme: 'auto', mode: 'device', layout: 'fit', label: tm.label });
        if (r.id !== t.theme) add(`auto schedule picks ${t.theme} on ${t.date}`, false, `got ${r.id}`);
        frames.push(r.frame);
      }
      sheetRows.push({ title: `${t.theme} ${t.date}`, frames });
    }
    add('auto schedule picks every theme from its date', rows.every((r) => !r.name.startsWith('auto schedule')), themes.map((t) => `${t.date} ${t.theme}`).join(', '));

    // Hook modes and the shake effect (fit layout).
    const base = { date: '2026-11-15', hour: 19, theme: 'auto', layout: 'fit', label: 'evening' };
    const dev = await shoot('mode-device', { ...base, mode: 'device' });
    const none = await shoot('mode-none', { ...base, mode: 'none' });
    const date = await shoot('mode-date', { ...base, mode: 'date' });
    const rowsDiffer = (a, b, y0, y1) => { let n = 0; for (let i = y0 * 64; i < (y1 + 1) * 64; i++) if (a[i] !== b[i]) n++; return n; };
    const clockGone = rowsDiffer(dev.frame, none.frame, 0, 15);
    const dateSame = rowsDiffer(dev.frame, date.frame, 56, 63);
    const dateNoTime = rowsDiffer(none.frame, date.frame, 0, 55);
    add('hook modes: none hides the scene clock, date keeps only rows 56-63', clockGone > 50 && dateSame === 0 && dateNoTime === 0,
      `rows 0-15 device vs none: ${clockGone} pixels differ; rows 56-63 date vs device: ${dateSame}; rows 0-55 date vs none: ${dateNoTime}`);
    const calm = await page.evaluate((o) => window.__smoke.render(o), { date: '2026-01-20', hour: 13, theme: 'winter', mode: 'none', layout: 'fit', steps: 42 });
    const shaken = await shoot('shake-winter', { date: '2026-01-20', hour: 13, theme: 'winter', mode: 'none', layout: 'fit', steps: 30, shake: true, shakeSteps: 12, label: 'shake' });
    const moved = calm.frame.filter((c, i) => c !== shaken.frame[i]).length;
    add('shake(): the theme effect shows (winter blizzard vs. a calm twin run)', moved > 20, `${moved} pixels differ after 12 steps`);

    // Whole screens in the large layout. A ratio other than 1 gets its own browser with that real scale factor:
    // CDP ratio emulation reports devicePixelContentBoxSize in CSS px and can paint fractional ratios 1 px off.
    const byDpr = new Map();
    for (const s of screens) byDpr.set(s.dpr, [...(byDpr.get(s.dpr) || []), s]);
    for (const [dpr, list] of byDpr) {
      const b = dpr === 1 ? browser : await launch({ weather: 'mock', deviceScaleFactor: dpr });
      try {
        const pg = dpr === 1 ? page : await b.newPage();
        if (pg !== page) {
          await pg.setViewport(list[0].w, list[0].h, dpr);
          await pg.goto(url);
          await pg.waitFor('window.__smoke && window.__smoke.ready', { timeoutMs: 15000 });
        }
        for (const s of list) {
          await pg.setViewport(s.w, s.h, s.dpr);
          await shootOn(pg, `screen-${s.name}`, { date: s.date, hour: s.hour, theme: s.theme, mode: 'device', layout: 'large', label: s.label }, { expectK: s.k });
        }
        if (pg !== page) pageErrors.push(...pg.errors);
      } finally {
        if (b !== browser) {
          const c = await b.close();
          if (!c.cleaned) add(`headless Chrome @${dpr}x: temp profile removed`, false, c.userDataDir);
        }
      }
    }

    // file:// (how Lively opens a wallpaper): the same frame, the same crispness.
    await page.setViewport(FIT_VIEW.w, FIT_VIEW.h, FIT_VIEW.dpr);
    const fileUrl = pathToFileURL(path.join(ROOT, ...PAGE_REL.split('/'))).href;
    await page.goto(fileUrl);
    await page.waitFor('window.__smoke && window.__smoke.ready', { timeoutMs: 15000 });
    const fr = await shoot('file-url', { ...base, mode: 'device' });
    const same = fr.frame.every((c, i) => c === dev.frame[i]);
    add('file:// loads the same classic scripts and renders the identical frame', same, same ? `${fileUrl.replace(/^file:\/\/\/[^]*?\/tools\//, 'file:///.../tools/')}: 4096/4096 pixels equal` : 'frame differs from the http run');

    pageErrors.push(...page.errors);
    add('pages: zero console errors', pageErrors.length === 0, pageErrors.length ? pageErrors.map((e) => `${e.type}: ${e.text}`).join('\n') : `${shots.length} renders`);

    // The labels use the clock's own 3x5 letters: vendor engine.js in this Node process (it sets globalThis.PixelClock).
    if (!globalThis.PixelClock) createRequire(import.meta.url)(path.join(ROOT, 'vendor', 'pixelclock', 'simulator', 'engine.js'));
    const sheet = contactSheet(sheetRows, TIMES.map((t) => t.label), { PC: globalThis.PixelClock });
    save('sheet', sheet);
    add('contact sheet', true, toPosix(path.relative(ROOT, path.join(out, 'smoke-sheet.png'))));
  } catch (e) {
    add('smoke run', false, e && e.stack ? e.stack : String(e));
  } finally {
    const closed = await browser.close();
    await srv.close();
    add('headless Chrome closed, temp profile removed', closed.cleaned, closed.userDataDir ? path.basename(closed.userDataDir) : '');
  }
  const counts = printReport(rows, { title: `PixelClock Desktop engine smoke (${rows.length} checks; screenshots in ${toPosix(path.relative(ROOT, out)) || out})`, log });
  return { code: counts.failed ? 1 : 0, rows, shots, results };
}

export async function main(argv = process.argv.slice(2)) {
  let out;
  let quick = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out') out = path.resolve(argv[++i]);
    else if (argv[i] === '--quick') quick = true;
    else if (argv[i] === '-h' || argv[i] === '--help') { console.log('usage: node tools/smoke.mjs [--out <dir>] [--quick]'); return 0; }
    else { console.error(`unknown argument ${argv[i]}`); return 1; }
  }
  const r = await runSmoke({ out, quick });
  return r.code;
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
  main().then((code) => {
    process.exitCode = code;
    setTimeout(() => process.exit(code), 3000).unref();
  }, (e) => {
    console.error(e);
    process.exit(1);
  });
}
