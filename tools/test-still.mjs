#!/usr/bin/env node
// The still's gate: renders the picture and checks it by its pixels.
//
//   node tools/test-still.mjs [--at <time>] [--tz <zone>] [--theme <id>] [--runs N] [--sizes 1920x1080@1,...] [--match]
//
// --match also builds the wallpaper into a temp folder and compares the still with the live page in headless Chrome
// (matchWallpaper below: the same size, time, theme, weather and frame) at 2560x1600@2 (right) and 3840x2160 (left).
//
// Renders the still with `--dry-run --out wip/shots/still/still-<W>x<H>@<s>-<side>.png` at 1920x1080, 2560x1440,
// 2560x1600 (scale 2) and 3840x2160, with the column on the right (the default) and on the left, with the sample
// city's weather (Berlin fixtures through a fake fetch: no network) in the sample city's time zone (--tz, default
// Europe/Berlin, so its sun times label the strip). Every picture is checked by its pixels:
//   - the exact size;
//   - k is pcd-bleed's k, and the rule's (the smallest k covering the height, raised to fill the room beside the
//     column, never cropping more than 10 % of the rows);
//   - every scene, seam and band pixel outside the column's glyphs and rects is the dimmed frame in whole k x k blocks,
//     the band rows or the seam, under the gradient (within 1 level: float32 against float64), and where the gradient is
//     clear every k x k block is uniform (crisp);
//   - no time digits: the scene is the engine's frame with its clock off (an independent render), whose rows 0-15 differ
//     from a render with the device clock (the control);
//   - the big date: the calendar face is the day of the month in the clock's digits, drawn as clock-colour rects, with
//     the month and weekday beside it; the column stays inside its cells and above the taskbar band;
//   - <= 1.5 s wall, <= 0.5 s CPU and <= 600 KB at 4K, as the best of N fresh `node pcd-still.mjs` runs (the machine is
//     shared: one slow run proves nothing);
//   - a child_process spy: --dry-run and PCD_NO_WALLPAPER=1 never start PowerShell (nothing here runs --set, wscript or
//     schtasks).
// Prints a PASS/FAIL table; exit 1 on any FAIL. Node built-ins only.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { decodePng } from './lib/png.mjs';
import { printReport } from './lib/report.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SHOTS = path.join(ROOT, 'wip', 'shots', 'still');
export const SIZES = [
  { width: 1920, height: 1080, scale: 1 },
  { width: 2560, height: 1440, scale: 1 },
  { width: 2560, height: 1600, scale: 2 },
  { width: 3840, height: 2160, scale: 1 },
];
export const SIDES = ['right', 'left'];
export const BUDGET = { ms: 1500, cpuMs: 500, bytes: 600 * 1024 };
const STILL = path.join(ROOT, 'src', 'still');
const ENGINE = { vendorDir: path.join(ROOT, 'vendor', 'pixelclock'), sharedDir: path.join(ROOT, 'src', 'shared'), layout: 'repo' };

const R8 = (c) => (c >>> 16) & 255;
const G8 = (c) => (c >>> 8) & 255;
const B8 = (c) => c & 255;

/** 0xRRGGBB at (x, y) of a decoded (RGBA) image. */
export function rgbAt(img, x, y) {
  const o = (y * img.width + x) * 4;
  return (img.data[o] << 16) | (img.data[o + 1] << 8) | img.data[o + 2];
}

/** Linear stops [{ at, a }] (at ascending) at position p; flat past both ends (the CSS gradient's rule). */
export function stopAlpha(stops, p) {
  if (!stops || !stops.length) return 0;
  if (p <= stops[0].at) return stops[0].a;
  for (let i = 1; i < stops.length; i++) {
    const s1 = stops[i];
    if (p <= s1.at) {
      const s0 = stops[i - 1];
      return s1.at === s0.at ? s1.a : s0.a + (s1.a - s0.a) * (p - s0.at) / (s1.at - s0.at);
    }
  }
  return stops[stops.length - 1].a;
}

/** bg over colour c at alpha a, one rounding per channel. */
export function veiled(c, a, bg) {
  if (!(a > 0)) return c;
  const one = (v, t) => Math.round(v + (t - v) * a);
  return (one(R8(c), R8(bg)) << 16) | (one(G8(c), G8(bg)) << 8) | one(B8(c), B8(bg));
}

/** The largest channel difference between two colours. */
export function channelDiff(a, b) {
  return Math.max(Math.abs(R8(a) - R8(b)), Math.abs(G8(a) - G8(b)), Math.abs(B8(a) - B8(b)));
}

/** The pixels the column covers: every glyph slot it draws and every rect. Uint8Array(W x H), 1 = covered. */
export function inkMask(W, H, info, face) {
  const mask = new Uint8Array(W * H);
  const mark = (x, y, w, h) => {
    for (let yy = Math.max(0, y); yy < Math.min(H, y + h); yy++) mask.fill(1, yy * W + Math.max(0, x), yy * W + Math.min(W, x + w));
  };
  for (const t of info.lines) {
    let c = 0;
    for (const r of t.runs) {
      for (const ch of r.text) {
        if (ch !== ' ') mark(t.x + c * face.cellW - face.padX, t.y - face.padY, face.slotW, face.slotH);
        c++;
      }
    }
  }
  for (const q of info.rects) mark(q.x, q.y, q.w, q.h);
  return mask;
}

/**
 * k by the rule, from the screen and the column's reach in device px: the smallest k covering the height, raised until
 * the scene fills the room beside the column, never cropping more than 10 % of the rows.
 */
export function ruleK(Wd, Hd, reachDev) {
  const k0 = Math.max(2, Math.ceil(Hd / 64));
  const kMax = Math.max(k0, Math.floor(Hd / (64 * 0.9)));
  return Math.max(k0, Math.min(Math.ceil(Math.max(0, Wd - reachDev) / 64), kMax));
}

/**
 * Check one picture by its pixels. pic: { plan, scene, info, render } from main()'s onPicture; img: the decoded PNG
 * (RGBA); independent(hookMode): the frame rendered again from the theme, seed, light and weather; date: the column's
 * date. Returns rows { name, pass, detail }.
 */
export function checkPicture({ label, img, W, H, pic, PCD, independent, date }) {
  const rows = [];
  const add = (name, pass, detail) => rows.push({ name: `${label}: ${name}`, pass: !!pass, detail: String(detail) });
  const B = PCD.bleed;
  const { plan, scene, info } = pic;
  const L = plan.L;
  const geo = plan.geo;
  const dpr = geo.dpr;
  const bg = PCD.ascii.token('bg');
  add('exact size', img.width === W && img.height === H, `${img.width}x${img.height}`);
  const k = ruleK(W, H, geo.column.reachDev);
  add('k: pcd-bleed\'s k, by the rule', plan.k === geo.k && geo.k === k, `k ${geo.k} (rule ${k}), scene ${geo.scene.size} px at ${geo.scene.x},${geo.scene.y}, ${Number(geo.crop.rows.toFixed(1))} rows cropped, band on the ${geo.edge}`);

  // no time digits: the scene is the engine's frame with its clock off
  const none = independent('none');
  const device = independent('device');
  let same = 0;
  for (let i = 0; i < 4096; i++) if (none.px[i] === scene.px[i]) same++;
  let topDiff = 0;
  for (let i = 0; i < 16 * 64; i++) if (device.px[i] !== none.px[i]) topDiff++;
  add('no time digits (a clock-off frame; the device clock would change rows 0-15)', same === 4096 && topDiff > 50, `${same}/4096 pixels equal the clock-off render; the device clock changes ${topDiff} pixels in rows 0-15`);

  // the layer's colours from the independent frame: dimmed (pcd-bleed's dimming), its band rows and seam
  const mix = B.dim(none.px);
  const shown = B.dimFrame(none.px, mix);
  const cols = geo.fade ? geo.fade.cols : 0;
  const bands = B.bands(shown, { cols, snap: true });
  const fade = geo.edge === 'left' ? bands.fadeLeft : bands.fadeRight;
  const g = geo.gradient;
  const capNone = !g.caption;
  // the gradient per device column and row (CSS stops at pixel centres)
  const ax = new Float64Array(W);
  for (let x = 0; x < W; x++) {
    const cx = (x + 0.5) / dpr;
    ax[x] = stopAlpha(g.side.stops, g.side.dir === 270 ? g.width - cx : cx);
  }
  const ay = new Float64Array(H);
  for (let y = 0; y < H; y++) ay[y] = stopAlpha(g.bottom.stops, g.height - (y + 0.5) / dpr);
  const { k: kk } = geo;
  const sx = geo.scene.x;
  const sy = geo.scene.y;
  const size = geo.scene.size;
  const fx0 = geo.fade ? geo.fade.x : 0;
  const fx1 = geo.fade ? geo.fade.x + geo.fade.w : 0;
  const mask = inkMask(W, H, info, plan.face);
  let checked = 0;
  let exact = 0;
  let worst = 0;
  let firstBad = '';
  for (let y = 0; y < H; y++) {
    const ry = Math.min(63, Math.max(0, Math.floor((y - sy) / kk)));
    for (let x = 0; x < W; x++) {
      if (mask[y * W + x]) continue;
      let c;
      if (x >= sx && x < sx + size) c = shown[ry * 64 + Math.floor((x - sx) / kk)];
      else if (x >= fx0 && x < fx1) c = fade[ry * cols + Math.min(cols - 1, Math.floor((x - fx0) / kk))];
      else c = bands.rows[ry];
      const want = veiled(c, 1 - (1 - ax[x]) * (1 - ay[y]), bg);
      const got = rgbAt(img, x, y);
      checked++;
      if (got === want) exact++;
      else {
        const d = channelDiff(got, want);
        if (d > worst) {
          worst = d;
          firstBad = `${x},${y}: ${got.toString(16)} vs ${want.toString(16)}`;
        }
      }
    }
  }
  add('scene, seam and bands under the gradient: every pixel outside the column\'s ink', capNone && worst <= 1 && checked > 0.5 * W * H,
    `${checked} pixels (${((checked / (W * H)) * 100).toFixed(1)} % of the picture): ${exact} exact, the rest within ${worst} level${worst === 1 ? '' : 's'}${worst > 1 ? ` (worst ${firstBad})` : ''}`);

  // crisp: where the gradient is clear, every whole k x k block is one colour, the dimmed frame's
  let blocks = 0;
  let blockBad = 0;
  for (let by = 0; by < 64; by++) {
    const y0 = sy + by * kk;
    if (y0 < 0 || y0 + kk > H || ay[y0 + kk - 1] > 0) continue;
    for (let bx = 0; bx < 64; bx++) {
      const x0 = sx + bx * kk;
      if (x0 < 0 || x0 + kk > W) continue;
      let clear = true;
      for (let x = x0; x < x0 + kk && clear; x++) if (ax[x] > 0) clear = false;
      if (!clear) continue;
      let masked = false;
      for (let y = y0; y < y0 + kk && !masked; y++) for (let x = x0; x < x0 + kk; x++) if (mask[y * W + x]) { masked = true; break; }
      if (masked) continue;
      blocks++;
      const c0 = rgbAt(img, x0, y0);
      let uniform = c0 === shown[by * 64 + bx];
      for (let y = y0; y < y0 + kk && uniform; y++) for (let x = x0; x < x0 + kk; x++) if (rgbAt(img, x, y) !== c0) { uniform = false; break; }
      if (!uniform) blockBad++;
    }
  }
  add(`crisp: every unveiled scene pixel is a uniform ${kk} x ${kk} block`, blocks >= 64 && blockBad === 0, `${blocks - blockBad}/${blocks} blocks uniform and equal to the dimmed frame`);

  // the big date: the day in the clock's digits, clock-colour rects, the month and weekday beside it
  const ct = info.content;
  const clock = ct.clock;
  let dateOk = false;
  let dateDetail = 'no calendar face';
  if (clock) {
    const want = PCD.ascii.dayFace(date.getDate(), { compact: clock.compact });
    const litSame = JSON.stringify(want.lit) === JSON.stringify(clock.face.lit);
    let rectPx = 0;
    let rectBad = 0;
    const digits = info.rects.filter((r) => r.tone === 'clock');
    for (const q of digits) {
      for (let y = q.y + 1; y < q.y + q.h - 1; y++) {
        for (let x = q.x + 1; x < q.x + q.w - 1; x++) {
          rectPx++;
          if (rgbAt(img, x, y) !== info.clockColor) rectBad++;
        }
      }
    }
    const words = clock.side && clock.side.block ? clock.side.block.map((l) => l.map((r) => r.text).join('')).filter(Boolean) : [];
    const want2 = [PCD.core.MONTHS_LONG[date.getMonth()], PCD.core.DAYS_LONG[date.getDay()]];
    dateOk = clock.face.kind === 'day' && litSame && rectPx > 0 && rectBad === 0 && JSON.stringify(words) === JSON.stringify(want2);
    dateDetail = `${date.getDate()} ${words.join(' / ')}: ${digits.length} digit rects, ${rectPx - rectBad}/${rectPx} inner pixels in #${info.clockColor.toString(16).padStart(6, '0')}`;
  }
  add('the big date (the calendar face) in place of a clock', dateOk, dateDetail);

  // the column: inside its cells, above the taskbar band, the caption in its bottom corner
  const tbTop = H - L.taskbar.dev;
  const low = Math.max(...info.lines.map((t) => t.y + L.cell.hDev), ...info.rects.map((q) => q.y + q.h));
  const colX0 = L.grid.xDev + L.col.c * L.cell.wDev;
  const colX1 = colX0 + L.col.cols * L.cell.wDev;
  const outside = info.lines.filter((t) => t.x < colX0 || t.x >= colX1);
  const cap = ct.caption;
  const capOk = !!cap && (plan.side === 'right' ? cap.c + cap.cols === L.col.c + L.col.cols : cap.c === L.col.c);
  add('the column: in its cells, above the taskbar, the caption in its corner', low <= tbTop && outside.length === 0 && capOk,
    `text down to y ${low} (taskbar from ${tbTop}); column x ${colX0}-${colX1}; caption '${cap ? cap.block[0].map((r) => r.text).join('') : ''}'`);
  return rows;
}

/** One render through main() (in this process); resolves { code, ms, file, bytes, pic, out }. */
export async function renderStill({ main, width, height, scale, side, at, theme, file, home, fetch, env }) {
  let pic = null;
  const lines = [];
  const argv = ['--dry-run', '--out', file, '--size', `${width}x${height}`, '--scale', String(scale), '--side', side, '--at', at];
  if (home) argv.push('--home', home);
  if (theme) argv.push('--theme', theme);
  const t0 = Date.now();
  const code = await main(argv, {
    env, stillDir: STILL, engine: ENGINE, fetch, stdout: (s) => lines.push(s), stderr: (s) => lines.push(s), onPicture: (p) => { pic = p; },
  });
  const ms = Date.now() - t0;
  return { code, ms, file, bytes: fs.existsSync(file) ? fs.statSync(file).size : 0, pic, out: lines.join('\n') };
}

/**
 * The best of up to `runs` fresh `node pcd-still.mjs --out` processes at a size (at least two; it stops once the
 * budget is met): { wallMs, cpuMs, bytes, all }.
 */
export function bestOf({ runs = 5, width = 3840, height = 2160, at = '2026-11-15T16:30', budget = BUDGET } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pcd-still-budget-'));
  const all = [];
  try {
    const file = path.join(dir, 'k4.png');
    const url = pathToFileURL(path.join(STILL, 'pcd-still.mjs')).href;
    const script = `const c0 = process.cpuUsage(); const t0 = Date.now();
      const m = await import(${JSON.stringify(url)});
      const code = await m.main(['--out', ${JSON.stringify(file)}, '--size', '${width}x${height}', '--at', ${JSON.stringify(at)}, '--quiet'], { env: { ...process.env, PCD_NO_WALLPAPER: '1' } });
      const c = process.cpuUsage(c0);
      console.log(JSON.stringify({ code, runMs: Date.now() - t0, cpuMs: (c.user + c.system) / 1000 }));`;
    for (let i = 0; i < runs; i++) {
      const env = { ...process.env, PCD_NO_WALLPAPER: '1' };
      delete env.PCD_STILL_HOME;
      const t0 = Date.now();
      const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', windowsHide: true, timeout: 60000, env });
      const wallMs = Date.now() - t0;
      if (r.status !== 0) throw new Error(`budget run failed: ${r.stderr}`);
      const m = JSON.parse(r.stdout.trim().split('\n').pop());
      if (m.code !== 0) throw new Error(`budget run exited ${m.code}`);
      all.push({ wallMs, runMs: m.runMs, cpuMs: Math.round(m.cpuMs), bytes: fs.statSync(file).size });
      const ok = all.some((a) => a.wallMs <= budget.ms) && all.some((a) => a.cpuMs <= budget.cpuMs);
      if (ok && i >= 1) break;
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
  return { wallMs: Math.min(...all.map((a) => a.wallMs)), cpuMs: Math.min(...all.map((a) => a.cpuMs)), bytes: all[0].bytes, all };
}

/**
 * The still against the live wallpaper page (headless) at the same size, time, theme, weather and frame:
 *   - builds the wallpaper into a temp dist with config/user.example.json (Berlin; never your own config);
 *   - opens it in headless Chrome (tools/lib/chrome.mjs: temp profile, privacy guard, Open-Meteo mocked at the instant)
 *     at the real device scale factor and in the time zone `tz`, with the page's clock frozen at the still's moment (an
 *     init script replaces Date) and its query overrides (city=Berlin units=C clock24=0 side=... reducedMotion=1: still
 *     frames snap);
 *   - renders the still in this process with the same mocked answers and hands the page the still's own 64x64 frame
 *     (the init script wraps PCD.engine.createScene so scene.frame() returns it), so both dim, band and veil one frame;
 *   - compares the scene geometry, the column's layout numbers, and every pixel outside both columns' text: identical
 *     where the gradient is clear; under it Chrome dithers the gradient and composites it in 8 bits while the still
 *     rounds the float once, so they may differ by a few levels (up to 4 measured).
 * Writes page-, still-, diff- and column- PNGs (page above, still below) into `out`. Returns rows.
 */
export async function matchWallpaper({ main, W, H, S, side, at, tz, out, theme = null, tolerance = 4 }) {
  const { createContext, generateStage } = await import('./build.mjs');
  const { makeTempDir, rmrf, writeBytes } = await import('./lib/fsx.mjs');
  const { vendorDir } = await import('./lib/vendor.mjs');
  const { launch, mockWeatherResponse } = await import('./lib/chrome.mjs');
  const { serve } = await import('./lib/serve.mjs');
  const { encodePng } = await import('./lib/png.mjs');
  const helpers = await import('../tests/still-helpers.mjs');
  const rows = [];
  const label = `match ${W}x${H}@${S} ${side}`;
  const add = (name, pass, detail) => rows.push({ name: `${label}: ${name}`, pass, detail: String(detail) });
  fs.mkdirSync(out, { recursive: true });
  const tag = `${W}x${H}@${S}-${side}`;
  const atMs = new Date(at).getTime();
  const T0 = atMs + 7.5 * 60000; // the column's moment: the middle of the still's 15-minute slot
  // the still
  const fetchMock = async (url) => {
    const r = mockWeatherResponse(String(url), { now: atMs });
    return { ok: r.status === 200, status: r.status, json: async () => JSON.parse(r.body) };
  };
  const home = helpers.tempHome({ width: W, height: H, scale: S, theme: theme || 'auto', clock24: false, units: 'C', city: 'Berlin', sunTimes: true, weather: true, weatherFx: true, taskbar: 56, side });
  const stillFile = path.join(out, `still-${tag}.png`);
  let pic = null;
  const log = [];
  let code;
  try {
    code = await main(['--dry-run', '--out', stillFile, '--home', home, '--at', at], {
      env: { ...process.env, PCD_NO_WALLPAPER: '1' }, fetch: fetchMock, onPicture: (p) => { pic = p; }, engine: ENGINE, stillDir: STILL,
      stdout: (s) => log.push(s), stderr: (s) => log.push(s),
    });
  } finally {
    helpers.rm(home);
  }
  if (code !== 0 || !pic) {
    add('the still', false, log.join(' | '));
    return rows;
  }
  // the page
  const tmp = makeTempDir('pcd-still-match-');
  let shot = null;
  let info = null;
  let errors = [];
  try {
    const dist = path.join(tmp, 'dist');
    const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'user.example.json'), 'utf8'));
    const gen = await generateStage({ root: ROOT, config, vendor: vendorDir(ROOT) });
    const mod = await import(pathToFileURL(path.join(ROOT, 'tools', 'build', 'wallpaper.mjs')).href);
    await mod.build(createContext({ root: ROOT, dist, config, render: false, piece: 'wallpaper', log: () => {}, generated: gen.generated, tokens: gen.tokens, anchors: gen.anchors }));
    const server = await serve(dist);
    const browser = await launch({ deviceScaleFactor: S, windowSize: [W / S, H / S], weather: { mode: 'mock', now: atMs } });
    try {
      const page = await browser.newPage();
      await page.send('Emulation.setTimezoneOverride', { timezoneId: tz });
      const init = `(() => {
        const T0 = ${T0};
        const Real = Date;
        class FrozenDate extends Real {
          constructor(...a) { if (a.length === 0) super(T0); else super(...a); }
          static now() { return T0; }
        }
        window.Date = FrozenDate;
        window.__stillFrame = ${JSON.stringify(Array.from(pic.scene.px))};
        const P = window.PCD || (window.PCD = {});
        let eng;
        Object.defineProperty(P, 'engine', {
          configurable: true, enumerable: true,
          get() { return eng; },
          set(v) {
            eng = v;
            if (v && typeof v.createScene === 'function' && !v.__still) {
              const orig = v.createScene;
              v.createScene = function (o) {
                const s = orig.call(this, o);
                const f = s.frame;
                s.frame = function () { const r = f.apply(this, arguments); if (r && r.px) r.px.set(window.__stillFrame); return r; };
                return s;
              };
              v.__still = true;
            }
          }
        });
      })();`;
      await page.send('Page.addScriptToEvaluateOnNewDocument', { source: init });
      await page.setViewport(W / S, H / S, S);
      await page.goto(`${server.url}wallpaper/index.html?city=Berlin&units=C&clock24=0&side=${side}&reducedMotion=1&weather=1&sunTimes=1&weatherFx=1&taskbarSpace=1${theme ? '&theme=' + theme : ''}`);
      await page.waitFor("document.documentElement.dataset.ready === '1'", { timeoutMs: 30000 });
      await page.waitFor('window.__pcd && window.__pcd.weather() && window.__pcd.weather().data', { timeoutMs: 30000 });
      await new Promise((r) => setTimeout(r, 1500));
      info = await page.evaluate('(() => { const s = window.__pcd.snapshot(); return { layout: s.layout, metrics: s.metrics, regions: s.regions }; })()');
      shot = await page.screenshot();
      writeBytes(path.join(out, `page-${tag}.png`), shot);
      errors = page.errors.map((e) => `${e.type}: ${e.text}`);
    } finally {
      await browser.close();
      await server.close();
    }
    browser.assertNoViolations();
  } catch (e) {
    add('the wallpaper page', false, e.message.split('\n')[0]);
    return rows;
  } finally {
    rmrf(tmp);
  }
  add('the wallpaper page loads without errors', errors.length === 0, errors.length ? errors.slice(0, 3).join('; ') : `${W / S}x${H / S}@${S}, clock frozen at the still's moment, the still's frame injected`);
  const A = decodePng(shot);
  const B = decodePng(stillFile);
  add('same size', A.width === W && B.width === W && A.height === H && B.height === H, `page ${A.width}x${A.height}, still ${B.width}x${B.height}`);
  const m = info.metrics || {};
  const g = pic.plan.geo;
  add('scene geometry (k, place, size)', m.k === g.k && m.x === g.scene.x && m.y === g.scene.y && m.size === g.scene.size, `page k ${m.k} at ${m.x},${m.y} size ${m.size}; still k ${g.k} at ${g.scene.x},${g.scene.y}`);
  const pick = (L) => L && { step: L.font.step, cell: [L.cell.wDev, L.cell.hDev], gridX: L.grid.xDev, cols: L.grid.cols, rows: L.grid.rows, usable: L.grid.usable, col: [L.col.c, L.col.cols], edge: L.edge.xDev, taskbar: L.taskbar.dev, foot: L.rows.foot };
  const a = JSON.stringify(pick(info.layout));
  const b = JSON.stringify(pick(pic.plan.L));
  add('the column\'s layout numbers (type step, cell, grid, column, edge, taskbar, bottom row)', a === b, a === b ? b : `page ${a}; still ${b}`);
  // pixels outside both columns' text, split by the gradient
  const mask = inkMask(W, H, pic.info, pic.plan.face);
  const pad = pic.plan.face.padX;
  for (const name of ['clock', 'greet', 'date', 'status', 'strip', 'weather', 'foot']) {
    const r = info.regions && info.regions[name];
    if (!r) continue;
    const x0 = Math.max(0, Math.floor(r.x * S) - pad);
    const y0 = Math.max(0, Math.floor(r.y * S) - pad);
    const x1 = Math.min(W, Math.ceil((r.x + r.w) * S) + pad);
    const y1 = Math.min(H, Math.ceil((r.y + r.h) * S) + pad);
    for (let y = y0; y < y1; y++) mask.fill(1, y * W + x0, y * W + x1);
  }
  const gr = g.gradient;
  const clearX = new Uint8Array(W);
  for (let x = 0; x < W; x++) {
    const cx = (x + 0.5) / S;
    clearX[x] = stopAlpha(gr.side.stops, gr.side.dir === 270 ? gr.width - cx : cx) === 0 ? 1 : 0;
  }
  const clearY = new Uint8Array(H);
  for (let y = 0; y < H; y++) clearY[y] = stopAlpha(gr.bottom.stops, gr.height - (y + 0.5) / S) === 0 ? 1 : 0;
  const zone = () => ({ n: 0, same: 0, worst: 0, hist: [0, 0, 0, 0], sum: 0 });
  const Z = { clear: zone(), veiled: zone() };
  const diff = Buffer.alloc(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const o = i * 4;
      diff[o + 3] = 255;
      if (mask[i]) {
        diff[o] = diff[o + 1] = diff[o + 2] = 40;
        continue;
      }
      const pa = rgbAt(A, x, y);
      const pb = rgbAt(B, x, y);
      const d = channelDiff(pa, pb);
      const z = clearX[x] && clearY[y] ? Z.clear : Z.veiled;
      z.n++;
      if (!d) z.same++;
      z.worst = Math.max(z.worst, d);
      z.hist[Math.min(3, d)]++;
      z.sum += (R8(pa) + G8(pa) + B8(pa)) - (R8(pb) + G8(pb) + B8(pb));
      if (d) {
        diff[o] = Math.min(255, 60 + d * 60);
        diff[o + 1] = d === 1 ? 120 : 0;
      }
    }
  }
  writeBytes(path.join(out, `diff-${tag}.png`), encodePng({ width: W, height: H, data: diff, channels: 4 }));
  const zs = (z) => `${z.n} px: ${z.same} identical (${z.n ? ((100 * z.same) / z.n).toFixed(2) : 0} %), off by 1: ${z.hist[1]}, by 2: ${z.hist[2]}, by 3+: ${z.hist[3]}; worst ${z.worst}; mean page - still ${(z.n ? z.sum / (3 * z.n) : 0).toFixed(2)}`;
  add('scene, seam and bands where the gradient is clear: identical', Z.clear.n > 0 && Z.clear.worst === 0, zs(Z.clear));
  add(`under the gradient: within ${tolerance} levels (Chrome dithers and composites in 8 bits; the still rounds once)`, Z.veiled.worst <= tolerance, zs(Z.veiled));
  // the column side by side: the page above, the still below
  const L = pic.plan.L;
  const cx0 = Math.max(0, L.grid.xDev + (L.col.c - 1) * L.cell.wDev);
  const cx1 = Math.min(W, L.grid.xDev + (L.col.c + L.col.cols + 1) * L.cell.wDev);
  const cy1 = Math.min(H, ((L.rows.weather !== undefined ? L.rows.weather + 5 : 20)) * L.cell.hDev);
  const cw = cx1 - cx0;
  const both = Buffer.alloc(cw * cy1 * 2 * 4);
  for (const [img, off] of [[A, 0], [B, cy1]]) for (let y = 0; y < cy1; y++) img.data.copy(both, (off + y) * cw * 4, (y * W + cx0) * 4, (y * W + cx1) * 4);
  writeBytes(path.join(out, `column-${tag}.png`), encodePng({ width: cw, height: cy1 * 2, data: both, channels: 4 }));
  add('files written', true, `${path.relative(ROOT, out)}: page-, still-, diff- and column-${tag}.png (the column: the page's clock and date line above, the still's calendar page below)`);
  return rows;
}

function parseArgs(argv) {
  const o = { at: '2026-11-15T16:30', tz: 'Europe/Berlin', theme: null, runs: 5, sizes: SIZES, match: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const v = () => argv[++i];
    if (a === '--at') o.at = v();
    else if (a === '--tz') o.tz = v();
    else if (a === '--theme') o.theme = v();
    else if (a === '--match') o.match = true;
    else if (a === '--runs') o.runs = Math.max(1, Number(v()) || 5);
    else if (a === '--sizes') {
      o.sizes = v().split(',').map((s) => {
        const m = /^(\d+)x(\d+)(?:@([\d.]+))?$/.exec(s);
        if (!m) throw new Error(`--sizes: ${s} is not WxH@S`);
        return { width: Number(m[1]), height: Number(m[2]), scale: Number(m[3] || 1) };
      });
    } else throw new Error(`unknown argument ${a} (use --at, --tz, --theme, --runs, --sizes, --match)`);
  }
  return o;
}

async function run() {
  const opt = parseArgs(process.argv.slice(2));
  // the sample city's zone, set before anything reads a date (Node applies TZ when it changes)
  if (opt.tz) process.env.TZ = opt.tz;
  const { main } = await import('../src/still/pcd-still.mjs');
  const { chooseTheme, daySeed, loadEngine, renderScene, timeParts } = await import('../src/still/lib/scene.mjs');
  const helpers = await import('../tests/still-helpers.mjs');
  fs.mkdirSync(SHOTS, { recursive: true });
  const eng = loadEngine(ENGINE);
  const { PCD } = eng;
  const rows = [];
  const env = { ...process.env, PCD_NO_WALLPAPER: '1' };
  delete env.PCD_STILL_HOME;
  const home = helpers.tempHome({ width: 0, height: 0, scale: 1, theme: opt.theme || 'auto', clock24: false, units: 'C', city: 'Berlin', sunTimes: true, weather: true, weatherFx: true, taskbar: 56 });
  const spy = helpers.spyChildProcess();
  try {
    for (const s of opt.sizes) {
      for (const side of SIDES) {
        const label = `${s.width}x${s.height}@${s.scale} ${side}`;
        const file = path.join(SHOTS, `still-${s.width}x${s.height}@${s.scale}-${side}.png`);
        const r = await renderStill({ main, ...s, side, at: opt.at, theme: opt.theme, file, home, fetch: helpers.fakeFetch(), env });
        if (r.code !== 0 || !r.pic) {
          rows.push({ name: `${label}: render`, pass: false, detail: r.out.split('\n').pop() });
          continue;
        }
        rows.push({ name: `${label}: render`, pass: true, detail: `${Math.round(r.bytes / 1024)} KB, ${r.ms} ms in this process -> ${path.relative(ROOT, file)}` });
        // the frame again, from the theme the date picks, the day's seed and the same light and weather
        const t = timeParts(new Date(opt.at));
        const pick = chooseTheme(eng, { theme: opt.theme || 'auto', year: t.year, month: t.month, day: t.day });
        const seed = daySeed(eng, pick.id, t.year, t.month, t.day);
        const R = r.pic.render;
        if (pick.id !== R.id || seed !== R.seed) rows.push({ name: `${label}: theme and seed`, pass: false, detail: `${R.id}/${R.seed}, wanted ${pick.id}/${seed}` });
        const independent = (hookMode) => renderScene(eng, { id: pick.id, seed, hourFloat: R.hourFloat, year: t.year, month: t.month, day: t.day, hookMode, before: R.before });
        const img = decodePng(file);
        rows.push(...checkPicture({ label, img, W: s.width, H: s.height, pic: r.pic, PCD, independent, date: r.pic.plan.V.now }));
        if (s.width === 3840) rows.push({ name: `${label}: PNG <= ${BUDGET.bytes / 1024} KB`, pass: r.bytes <= BUDGET.bytes, detail: `${Math.round(r.bytes / 1024)} KB` });
      }
    }
    // no PowerShell from --dry-run, and none with PCD_NO_WALLPAPER=1 (the plain render mode then reports a dry run);
    // still.json holds the screen size, as after the install's --detect (detecting it is a read-only PowerShell query)
    const sized = JSON.parse(fs.readFileSync(path.join(home, 'still.json'), 'utf8'));
    fs.writeFileSync(path.join(home, 'still.json'), JSON.stringify({ ...sized, width: 1280, height: 800 }, null, 2) + '\n');
    const before = spy.calls.length;
    const d1 = helpers.collect();
    const c1 = await main(['--dry-run', '--home', home, '--at', opt.at], { env: { ...env, PCD_NO_WALLPAPER: undefined }, stillDir: STILL, engine: ENGINE, fetch: helpers.fakeFetch(), ...d1 });
    const d2 = helpers.collect();
    const c2 = await main(['--home', home, '--at', opt.at], { env, stillDir: STILL, engine: ENGINE, fetch: helpers.fakeFetch(), ...d2 });
    const ps = spy.powershell();
    const procs = spy.calls.slice(before).map((c) => path.basename(c.cmd));
    rows.push({
      name: 'spawn spy: --dry-run and PCD_NO_WALLPAPER=1 never start PowerShell',
      pass: c1 === 0 && c2 === 0 && ps.length === 0 && /dry run: --set would run powershell/.test(d1.text()) && /dry run: --set would run powershell/.test(d2.text()),
      detail: `exit ${c1} and ${c2}; processes started: ${procs.length ? procs.join(', ') : 'none'} (tasklist: the read-only Lively check); PowerShell: ${ps.length}`,
    });
  } finally {
    spy.restore();
    helpers.rm(home);
  }
  // --match: the still against the live wallpaper page, at 2560x1600@2 and at 4K with the column on the left
  if (opt.match) {
    for (const m of [{ W: 2560, H: 1600, S: 2, side: 'right' }, { W: 3840, H: 2160, S: 1, side: 'left' }]) {
      rows.push(...await matchWallpaper({ main, ...m, at: opt.at, tz: opt.tz, theme: opt.theme, out: path.join(SHOTS, 'match') }));
    }
  }
  // the 4K budget, best of N fresh processes
  const b = bestOf({ runs: opt.runs, at: opt.at });
  rows.push({
    name: `4K budget, best of ${b.all.length} fresh runs (<= ${BUDGET.ms} ms wall, <= ${BUDGET.cpuMs} ms CPU, <= ${BUDGET.bytes / 1024} KB)`,
    pass: b.wallMs <= BUDGET.ms && b.cpuMs <= BUDGET.cpuMs && b.bytes <= BUDGET.bytes,
    detail: `best ${b.wallMs} ms wall (whole process), ${b.cpuMs} ms CPU, ${Math.round(b.bytes / 1024)} KB; runs (wall/CPU ms): ${b.all.map((a) => `${a.wallMs}/${a.cpuMs}`).join(' ')}`,
  });
  const counts = printReport(rows, { title: `Still gate (${opt.at} in ${opt.tz}, Berlin sample weather; screenshots in ${path.relative(ROOT, SHOTS)})` });
  return counts.failed ? 1 : 0;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();
if (isMain) run().then((code) => { process.exitCode = code; }, (e) => { console.error(`test-still: ${e && e.stack || e}`); process.exitCode = 1; });
