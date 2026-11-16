// PCD.bleed in headless Chrome: the full-bleed scene layer on a test page built from the shared
// modules alone (tests/fixtures/bleed/bleed-page.js), served from a temp folder with the synced engine, each device
// ratio with the real scale factor (tools/lib/chrome.mjs: temp profile, privacy guard on):
//   crisp: at 23 sizes (DPR 1, 1.25, 1.5, 1.75, 2; portrait, ultrawide, odd sizes), both column sides, every device
//     pixel of the screenshot (gradient hidden) equals its k x k block: the dimmed frame, the seam, the band rows;
//   live: PCD.host paints through layer.draw at 30 fps; the draw costs p95 <= 0.5 ms (best of 3), the whole frame
//     p95 <= 1 ms (a size that misses a cost or fps gate on a busy machine is measured once more); a pause and a
//     hidden tab leave no timer and no animation frame; zero console errors;
//   look: the dimming at dawn, day, sunset and night for a bright and a dark theme (and two more) with the gradient,
//     saved as wip/shots/bleed/scene-*.png; the still's compose() in Node matches each screenshot.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { launch } from '../tools/lib/chrome.mjs';
import { serve } from '../tools/lib/serve.mjs';
import { decodePng } from '../tools/lib/png.mjs';
import { themeOrder } from '../tools/lib/vendor.mjs';
import { generate, toJs } from '../tools/lib/anchors.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PAGE_DIR = path.join(ROOT, 'tests', 'fixtures', 'bleed');
const VENDOR = path.join(ROOT, 'vendor', 'pixelclock');
const SHARED = path.join(ROOT, 'src', 'shared');
const SHOTS = path.join(ROOT, 'wip', 'shots', 'bleed');
const SCRIPTS = ['pcd-engine.js', 'pcd-sun.js', 'pcd-fx.js', 'pcd-ascii.js', 'pcd-layout.js', 'pcd-host.js', 'pcd-bleed.js'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const TIMER_SPY = `(function () {
  var c = window.__timers = { setTimeout: 0, setInterval: 0, raf: 0, rafRun: 0 };
  var st = window.setTimeout, si = window.setInterval, raf = window.requestAnimationFrame;
  window.setTimeout = function () { c.setTimeout++; return st.apply(window, arguments); };
  window.setInterval = function () { c.setInterval++; return si.apply(window, arguments); };
  window.requestAnimationFrame = function (fn) { c.raf++; return raf.call(window, function (t) { c.rafRun++; fn(t); }); };
})();`;

/** The page in a temp folder: the engine in page order, the generated anchors, the shared scripts, the page. */
function stage() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pcd-bleed-'));
  fs.mkdirSync(path.join(dir, 'js', 'pixelclock', 'themes'), { recursive: true });
  const cp = (from, to) => fs.copyFileSync(from, path.join(dir, to));
  cp(path.join(VENDOR, 'simulator', 'engine.js'), 'js/pixelclock/engine.js');
  cp(path.join(VENDOR, 'simulator', 'schedule.js'), 'js/pixelclock/schedule.js');
  const themes = themeOrder(VENDOR).map((e) => e.file);
  for (const t of themes) cp(path.join(VENDOR, 'simulator', t), 'js/pixelclock/' + t);
  for (const s of ['pcd-hook.js', ...SCRIPTS]) cp(path.join(SHARED, s), 'js/' + s);
  fs.writeFileSync(path.join(dir, 'js', 'pcd-anchors.js'), toJs(generate(VENDOR)));
  cp(path.join(PAGE_DIR, 'bleed-page.js'), 'bleed-page.js');
  const order = ['js/pixelclock/engine.js', 'js/pcd-hook.js', 'js/pixelclock/schedule.js', ...themes.map((t) => 'js/pixelclock/' + t),
    'js/pcd-anchors.js', ...SCRIPTS.map((s) => 'js/' + s), 'bleed-page.js'];
  fs.writeFileSync(path.join(dir, 'index.html'), [
    '<!doctype html>', '<html lang="en"><head>', '<meta charset="utf-8">', '<title>bleed</title>',
    '<style>html,body{margin:0;height:100%;overflow:hidden;background:#141016}',
    '#caption{position:fixed;display:none;z-index:2;white-space:pre;color:#ece4d8;margin:0}</style>',
    ...order.map((s) => `<script src="${s}" defer></script>`),
    '</head><body><div id="bleed"></div><pre id="caption"></pre></body></html>', ''].join('\n'));
  return dir;
}

/**
 * Every device pixel equals its k x k block's colour: the dimmed frame in the scene, the seam columns, the band (one
 * colour across, exactly k rows tall). CDP's capture clips an emulated fractional size down (777 CSS px at 1.25 is
 * 971.25: the page has 972 device rows, the capture 971), so the image may be one px short of the viewport.
 */
function checkCrisp(img, rep) {
  const g = rep.geo;
  const px = rep.pixels;
  const k = g.k;
  const { x: sx, y: sy, size } = g.scene;
  const W = img.width;
  const H = img.height;
  if (W > g.Wd || H > g.Hd || W < g.Wd - 1 || H < g.Hd - 1) return { bad: 1, first: { why: `png ${W}x${H} vs viewport ${g.Wd}x${g.Hd}` }, checked: 0, kinds: {} };
  let bad = 0;
  let first = null;
  let checked = 0;
  const kinds = { scene: 0, fade: 0, band: 0 };
  for (let y = 0; y < H; y++) {
    const ry = Math.floor((y - sy) / k);
    for (let x = 0; x < W; x++) {
      let want = null;
      let kind = '';
      if (ry < 0 || ry > 63) want = null;
      else if (x >= sx && x < sx + size) { want = px.frame[ry * 64 + Math.floor((x - sx) / k)]; kind = 'scene'; }
      else if (g.fade && x >= g.fade.x && x < g.fade.x + g.fade.w) { want = px.fade[ry * px.cols + Math.floor((x - g.fade.x) / k)]; kind = 'fade'; }
      else if (g.band && x >= g.band.x && x < g.band.x + g.band.w) { want = px.rows[ry]; kind = 'band'; }
      checked++;
      const i = (y * W + x) * 4;
      if (want === null || want === undefined) { bad++; if (!first) first = { x, y, why: 'no layer here' }; continue; }
      kinds[kind]++;
      if (img.data[i] !== ((want >> 16) & 255) || img.data[i + 1] !== ((want >> 8) & 255) || img.data[i + 2] !== (want & 255)) {
        bad++;
        if (!first) first = { x, y, kind, want: [(want >> 16) & 255, (want >> 8) & 255, want & 255], got: [img.data[i], img.data[i + 1], img.data[i + 2]] };
      }
    }
  }
  return { bad, first, checked, kinds };
}

async function openPage(browser, base, w, h, d, q, spy = false) {
  const page = await browser.newPage('about:blank');
  await page.setViewport(w, h, d);
  if (spy) await page.send('Page.addScriptToEvaluateOnNewDocument', { source: TIMER_SPY });
  await page.goto(base + 'index.html?' + new URLSearchParams(q));
  await page.waitFor("document.documentElement.getAttribute('data-ready') === '1'", { timeoutMs: 20000 });
  await sleep(120);
  return page;
}

const errorsOf = (page, rep) => [...page.errors.map((e) => `${e.type || 'error'}: ${e.text || e}`), ...(rep && rep.errors ? rep.errors : [])];

let srv = null;
let dir = null;
const browsers = new Map();
async function browserFor(d) {
  if (!browsers.has(d)) browsers.set(d, await launch({ deviceScaleFactor: d, windowSize: [1280, 800] }));
  return browsers.get(d);
}
test.before(async () => {
  dir = stage();
  srv = await serve(dir);
  fs.mkdirSync(SHOTS, { recursive: true });
});
test.after(async () => {
  for (const b of browsers.values()) await b.close();
  for (const b of browsers.values()) b.assertNoViolations();
  if (srv) await srv.close();
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

const SIZES = [
  [1280, 800, 2], [1280, 620, 2], [1440, 900, 1], [1920, 1080, 1], [2560, 1440, 1], [3440, 1440, 1], [800, 500, 1], [800, 500, 2],
  [1536, 864, 1.25], [1280, 720, 1.5], [2560, 1440, 1.5], [1097, 617, 1.75], [2194, 1234, 1.75], [1366, 768, 1], [3840, 2160, 1],
  [5120, 1440, 1], [600, 900, 1], [420, 760, 2], [999, 777, 1.25], [1600, 300, 1], [1001, 779, 1.25], [1003, 641, 1.75], [777, 555, 1.5],
];

test('crisp: every visible scene, seam and band pixel is its k x k block, 23 sizes, both sides', { timeout: 600000 }, async () => {
  const results = [];
  for (const [w, h, d] of SIZES) {
    const b = await browserFor(d);
    for (const side of ['left', 'right']) {
      const page = await openPage(b, srv.url, w, h, d, { side, veil: '0', at: '2026-11-15T20:40' });
      const rep = await page.evaluate('window.__bleed.report()');
      const img = decodePng(await page.screenshot());
      const c = checkCrisp(img, rep);
      results.push({ name: `${side} ${w}x${h}@${d}`, k: rep.geo.k, place: rep.geo.place, edge: rep.geo.edge, dpr: rep.dpr, c, errors: errorsOf(page, rep), info: rep.info });
      await page.close();
    }
  }
  for (const r of results) {
    assert.equal(r.errors.length, 0, `${r.name}: ${r.errors.join(' | ')}`);
    assert.equal(r.c.bad, 0, `${r.name}: ${JSON.stringify(r.c.first)}`);
    assert.ok(r.c.kinds.scene > 0, r.name + ' scene checked');
    if (r.place === 'flush') assert.ok(r.c.kinds.band > 0 && r.c.kinds.fade > 0, r.name + ' band and seam checked');
    assert.ok(r.info.visible.scene, r.name + ' the scene shows');
  }
  const fr = results.filter((r) => r.dpr % 1 !== 0).length;
  assert.ok(fr >= 16, `${fr} fractional-ratio layouts checked`);
  console.log(results.map((r) => `${r.name.padEnd(24)} k ${String(r.k).padStart(2)} ${r.place} ${r.c.checked} px`).join('\n'));
});

/**
 * One live measurement of a size and theme: 3 runs of 3 s (the first also pauses the page, then hides it behind
 * another tab), then the frozen frame's draw timed in batches.
 */
async function measureLive(b, w, h, d, theme, when) {
  const runs = [];
  for (let run = 0; run < 3; run++) {
    const page = await openPage(b, srv.url, w, h, d, { side: run === 1 ? 'right' : 'left', live: '1', at: when, theme }, true);
    await sleep(3000);
    const rep = await page.evaluate('window.__bleed.report()');
    runs.push({ draw: rep.info.cost, host: rep.stats, paints: rep.info.paints, targets: rep.info.targets, frames: rep.info.frames, errors: errorsOf(page, rep) });
    if (run === 0) {
      // a pause: no timer, no animation frame
      await page.evaluate("window.__bleed.host.pause('test')");
      const t0 = await page.evaluate('({ ...window.__timers })');
      const f0 = (await page.evaluate('window.__bleed.report()')).info.frames;
      await sleep(1000);
      const t1 = await page.evaluate('({ ...window.__timers })');
      const f1 = (await page.evaluate('window.__bleed.report()')).info.frames;
      await page.evaluate("window.__bleed.host.resume('test')");
      // a hidden tab: another tab in front
      const other = await b.newPage('about:blank');
      await b.send('Target.activateTarget', { targetId: other.targetId });
      await sleep(300);
      const h0 = await page.evaluate('({ ...window.__timers })');
      const g0 = (await page.evaluate('window.__bleed.report()')).info.frames;
      await sleep(1000);
      const h1 = await page.evaluate('({ ...window.__timers })');
      const g1 = (await page.evaluate('window.__bleed.report()')).info.frames;
      const vis = await page.evaluate('document.visibilityState');
      await b.send('Target.activateTarget', { targetId: page.targetId });
      await other.close();
      runs[0].paused = { setTimeout: t1.setTimeout - t0.setTimeout, setInterval: t1.setInterval - t0.setInterval, raf: t1.raf - t0.raf, frames: f1 - f0 };
      runs[0].hidden = { vis, setTimeout: h1.setTimeout - h0.setTimeout, raf: h1.raf - h0.raf, frames: g1 - g0 };
    }
    await page.close();
  }
  // the draw alone, precisely: back-to-back draws of a frozen frame, timed in batches (the page timer is 0.1 ms coarse)
  const fp = await openPage(b, srv.url, w, h, d, { side: 'left', at: when, theme });
  const batches = [];
  for (let i = 0; i < 40; i++) batches.push(await fp.evaluate('window.__bleed.batch(25)'));
  await fp.close();
  batches.sort((a, c) => a - c);
  return { name: `${theme} ${w}x${h}@${d}`, runs, batch: { p50: batches[20], p95: batches[38], min: batches[0] } };
}

/** The cost and frame-rate gates a live measurement misses, or '' when it keeps them all. */
function timingMiss(o) {
  const miss = [];
  const best = Math.min(...o.runs.map((r) => r.draw.p95));
  const bestHost = Math.min(...o.runs.map((r) => r.host.p95));
  if (!(best <= 0.5)) miss.push(`draw p95 ${best} ms (best of 3)`);
  if (!(o.batch.p95 <= 0.5)) miss.push(`draw ${o.batch.p95.toFixed(3)} ms in batches`);
  if (!(bestHost <= 1)) miss.push(`whole frame p95 ${bestHost} ms (best of 3)`);
  for (const r of o.runs) if (!(r.host.fps >= 27 && r.host.fps <= 33)) miss.push(`${r.host.fps} fps`);
  return miss.join(', ');
}

test('live: PCD.host paints through the layer; cost, 30 fps, nothing runs while paused or hidden', { timeout: 300000 }, async () => {
  const out = [];
  for (const [w, h, d, theme, when] of [[1280, 800, 2, 'autumn', '2026-11-15T20:40'], [1920, 1080, 1, 'christmas', '2026-12-24T16:30']]) {
    const b = await browserFor(d);
    const tries = [await measureLive(b, w, h, d, theme, when)];
    // On a busy machine (the suite runs files in parallel) one measurement can miss a cost or fps gate: measure once
    // more. The gates stay the same, and the error, pause and hidden checks hold for every measurement.
    const miss = timingMiss(tries[0]);
    if (miss) {
      console.log(`${tries[0].name}: ${miss}; measuring once more`);
      tries.push(await measureLive(b, w, h, d, theme, when));
    }
    out.push({ ...tries[tries.length - 1], tries });
  }
  for (const o of out) {
    for (const t of o.tries) {
      for (const r of t.runs) assert.equal(r.errors.length, 0, `${o.name}: ${r.errors.join(' | ')}`);
      const p = t.runs[0].paused;
      assert.deepEqual([p.setTimeout, p.setInterval, p.raf, p.frames], [0, 0, 0, 0], `${o.name}: paused ${JSON.stringify(p)}`);
      const hd = t.runs[0].hidden;
      assert.equal(hd.vis, 'hidden');
      assert.deepEqual([hd.setTimeout, hd.raf, hd.frames], [0, 0, 0], `${o.name}: hidden ${JSON.stringify(hd)}`);
    }
    console.log(`${o.name}: draw p95 ${o.runs.map((r) => r.draw.p95).join('/')} ms (live), ${o.batch.p50.toFixed(3)} / ${o.batch.p95.toFixed(3)} ms (batches p50/p95); ` +
      `whole frame p95 ${o.runs.map((r) => r.host.p95).join('/')} ms; fps ${o.runs.map((r) => r.host.fps).join('/')}; ` +
      `in ${o.runs[0].frames} frames: band ${o.runs[0].paints.band}, seam ${o.runs[0].paints.fade} repaints, ${o.runs[0].targets} band refreshes`);
    const miss = timingMiss(o);
    assert.equal(miss, '', `${o.name}: ${miss}`);
  }
});

test('look: the dimming at dawn, day, sunset and night; the still compose() matches the page', { timeout: 300000 }, async () => {
  const require = createRequire(import.meta.url);
  require(path.join(SHARED, 'pcd-layout.js'));
  const B = require(path.join(SHARED, 'pcd-bleed.js'));
  const b = await browserFor(2);
  const rows = [];
  for (const theme of ['winter', 'autumn', 'halloween', 'summer']) {
    for (const phase of ['dawn', 'day', 'sunset', 'night']) {
      const page = await openPage(b, srv.url, 1280, 800, 2, { side: 'left', theme, phase, caption: '1', at: '2026-11-15T12:00' });
      const rep = await page.evaluate('window.__bleed.report()');
      const raw = await page.evaluate('window.__bleed.raw()');
      const png = await page.screenshot();
      fs.writeFileSync(path.join(SHOTS, `scene-1280x800@2-${theme}-${phase}.png`), png);
      const errors = errorsOf(page, rep);
      await page.close();
      // the still: the same frame and inputs through compose() in Node
      const g = rep.geo;
      const geo = B.fit({ cssW: g.cssW, cssH: g.cssH, dpr: g.dpr, side: 'left', statusTop: g.statusTop, caption: g.caption });
      const img = decodePng(png);
      const mine = B.compose(null, geo, Uint32Array.from(raw)).img.data;
      // the caption text is the page's, not the layer's: leave its box out
      const c = g.caption;
      let max = 0;
      let over3 = 0;
      let n = 0;
      for (let y = 0; y < img.height; y++) {
        for (let x = 0; x < img.width; x++) {
          const cx = x / g.dpr;
          const cy = y / g.dpr;
          if (c && cx >= c.x - 2 && cx <= c.x + c.w + 2 && cy >= c.y - 2 && cy <= c.y + c.h + 2) continue;
          const i = (y * img.width + x) * 4;
          const o = (y * geo.Wd + x) * 3;
          for (let ch = 0; ch < 3; ch++) {
            const v = Math.abs(img.data[i + ch] - mine[o + ch]);
            if (v > max) max = v;
            if (v > 3) over3++;
          }
          n++;
        }
      }
      rows.push({ theme, phase, mix: rep.info.mix, luma: rep.info.luma, max, over3: over3 / n / 3, errors });
    }
  }
  for (const r of rows) {
    assert.equal(r.errors.length, 0, `${r.theme} ${r.phase}: ${r.errors.join(' | ')}`);
    assert.ok(r.mix >= 0.4 - 1e-9 && r.mix <= 0.5 + 1e-9, `${r.theme} ${r.phase}: mix ${r.mix}`);
    assert.ok(r.max <= 6 && r.over3 < 0.001, `${r.theme} ${r.phase}: compose vs page max ${r.max}, ${(r.over3 * 100).toFixed(3)} % over 3 levels`);
  }
  const by = (t, p) => rows.find((r) => r.theme === t && r.phase === p);
  for (const t of ['winter', 'autumn', 'halloween', 'summer']) assert.ok(by(t, 'night').mix < by(t, 'day').mix, `${t}: night keeps more light than day`);
  console.log(rows.map((r) => `${r.theme.padEnd(9)} ${r.phase.padEnd(6)} mix ${r.mix.toFixed(3)} luma ${r.luma.toFixed(0).padStart(3)}  compose vs page: max ${r.max}, over 3: ${(r.over3 * 100).toFixed(3)} %`).join('\n'));
});
