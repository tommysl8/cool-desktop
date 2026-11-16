#!/usr/bin/env node
// Browser checks of the built Lively wallpaper (dist/wallpaper) in headless Chrome: the Lively simulation, the look at
// seven screen sizes on both column sides, and the 10-minute memory soak.
//
//   node tools/test-wallpaper.mjs [--only sim,look,soak] [--no-shots] [--out wip/shots/wallpaper] [--fps-seconds 5]
//                                 [--fps-retries 1] [--soak [seconds]] [--warmup seconds] [--soak-only]
//
//   default        the simulation and the look (about 3 minutes); --soak adds the soak (600 s after a 300 s warm-up
//                  by default); --soak-only runs only the soak; --only picks sections (sim, look, soak)
//
// Build first: node tools/build.mjs --no-sync wallpaper. The package is served on 127.0.0.1 (tools/lib/serve.mjs) and
// opened in headless Chrome through tools/lib/chrome.mjs (temp profile, privacy guard on, Open-Meteo answered by the
// browser-level mock, everything else ~NOTFOUND). Every page runs in the sample city's time zone (Europe/Berlin, CDP
// Emulation.setTimezoneOverride), so the mocked Berlin sunrise and sunset are the page's own and the daylight strip
// shows them. Lively is played the way Lively plays it: livelyPropertyListener with Lively's value types (dropdown
// index, checkbox boolean, textbox string per keystroke, button true), livelyWallpaperPlaybackChanged('{"IsPaused":
// ...}'), calls before the app is ready and the replay after load. An injected tracker wraps setTimeout / setInterval
// / requestAnimationFrame before the page's scripts run, so "no timer and no rAF while paused" is measured
// independently of the app's own counters. Every page starts with a plugged-in fake battery (a check may install its
// own), so a laptop running on battery does not halve the frame rate under test.
//
// sim: the page loads (data-ready, the first frame drawn through the console, zero errors, IN_LIVELY false outside
// Lively and true with a fake WebView2, the scene's own clock off); the defaults equal what Lively replays from
// LivelyProperties.json; calls before the app is ready are queued and replayed; Lively's replay right after load in
// shuffled order (every value type) applies at once, textboxes included; every property type after the settle window
// (dropdowns: Column side, Theme, Units; checkboxes; the textbox debounce of 1.5 s with one weather lookup; buttons:
// surprise, shake, refresh weather coalesced); unknown and bad names and values ignored; pause stops every timer and
// rAF within 100 ms and nothing fires for 2 s; resume continues without fast-forward; visibility (a real hidden window)
// pauses and resumes; 30 fps +-10 % with 30 engine steps per second and one rAF per frame; battery (fake getBattery)
// -> 15 fps, plugged in or "Performance mode on battery" off -> 30, performance mode -> 15, no getBattery -> 30;
// reduced motion (setting and prefers-reduced-motion): no loop, a shake plays 4 s at 15 fps then freezes (a still
// window that meets a minute edge, where the app draws one still frame, is taken again); the hourly surprise
// (10:59:58 -> one shake at 11:00; none at 8:59:58, with the checkbox off, or while paused); the debug overlay's
// fields; the weather block and its credit (the exact Open-Meteo URLs).
// look: 1280x800@2 (a laptop at its real scale factor 2), 1920x1080, 2560x1440, 3840x2160, 3440x1440, portrait
// 1080x1920 and a two-screen span 3840x1080, each with the column right (°C, 24 h) and left (°F, 12 h), a different
// scene, time and weather: every device pixel of the world layer (scene, seam, band; the veil and the column
// hidden) equals the colour the page reports for its k x k block (crisp whole-number scaling) with pcd-bleed's own k
// (the page's geometry, PCD.bleed.fit() run in the page on the same inputs, and the k rule written out here); the
// scene flush on the far side and the band on the column's side; nothing of the column clipped, all of it above the
// taskbar band; every text run at least 4.5:1 against the brightest pixel behind it (the column hidden, the veil on),
// the big clock too; zero errors. Screenshots: <out>/wallpaper-<W>x<H>@<dpr>-<side>.png.
// soak: rain in the scene at 30 fps, every 30 s a surprise, the column flipped and back, a pause and a resume; the JS
// heap after a forced collection every 30 s through a warm-up and the soak: growth under 10 %, DOM nodes and
// listeners flat, no timer pile-up (a rain soak).
// Always: the network (only 127.0.0.1 and Open-Meteo, mocked; never the clock's host), privacy (no guard violation,
// the configured city never requested) and zero console errors. Exit code 1 when a check fails.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findBrowser, launch } from './lib/chrome.mjs';
import { serve } from './lib/serve.mjs';
import { ensureDir, sleep, writeBytes } from './lib/fsx.mjs';
import { decodePng } from './lib/png.mjs';
import { printReport } from './lib/report.mjs';
import { loadModel } from './build/wallpaper.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PKG = path.join(ROOT, 'dist', 'wallpaper');
const ALLOWED_HOSTS = ['127.0.0.1', 'api.open-meteo.com', 'geocoding-api.open-meteo.com'];
const GEOCODE_BERLIN = 'https://geocoding-api.open-meteo.com/v1/search?name=Berlin&count=1&language=en&format=json';
const FORECAST_START = 'https://api.open-meteo.com/v1/forecast?latitude=52.52437&longitude=13.41053&current=temperature_2m,apparent_temperature,weather_code,wind_speed_10m,precipitation,cloud_cover,is_day&daily=temperature_2m_max,temperature_2m_min,sunrise,sunset&timezone=auto&timeformat=unixtime&forecast_days=1';
/** The sample city's time zone: the mocked forecast is Berlin's day, so its sun times are the page's own. */
const TIMEZONE = 'Europe/Berlin';
const TASKBAR = 56;
const SECTIONS = ['sim', 'look', 'soak'];
/** A 10-minute soak, heap growth under 10 %, after a warm-up (V8 keeps optimizing for minutes). */
const SOAK = Object.freeze({ seconds: 600, warmup: 300, sampleMs: 30000, maxGrowth: 0.1, maxNodeSpread: 200 });
/** The text contrast every run keeps against the brightest pixel behind it. */
const MIN_CONTRAST = 4.5;

/**
 * The look sizes: [w, h, dpr, theme ('' = auto by date), time of day, mocked current weather].
 * Each size runs with the column right (the default) and left.
 */
const LOOK_SIZES = Object.freeze([
  [1280, 800, 2, '', [20, 40], {}],
  [1920, 1080, 1, 'summer', [14, 10], { weather_code: 0, cloud_cover: 3 }],
  [2560, 1440, 1, 'halloween', [21, 10], { weather_code: 1, cloud_cover: 20 }],
  [3840, 2160, 1, 'winter', [13, 5], { weather_code: 73, precipitation: 1.2, cloud_cover: 100 }],
  [3440, 1440, 1, 'christmas', [16, 30], { weather_code: 71, precipitation: 0.4, cloud_cover: 95 }],
  [1080, 1920, 1, 'spring', [8, 15], { weather_code: 2, cloud_cover: 45 }],
  [3840, 1080, 1, '', [20, 40], { weather_code: 53, precipitation: 0.4, cloud_cover: 100 }],
]);

function parseArgs(argv) {
  const o = { shots: true, fpsSeconds: 5, fpsRetries: 1, out: path.join(ROOT, 'wip', 'shots', 'wallpaper'), soak: 0, warmup: SOAK.warmup, only: null };
  const isNum = (s) => s !== undefined && /^\d+(\.\d+)?$/.test(String(s));
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const num = () => {
      const v = Number(argv[++i]);
      if (!Number.isFinite(v) || v < 0) throw new Error(`${a} needs a number`);
      return v;
    };
    if (a === '--no-shots') o.shots = false;
    else if (a === '--fps-seconds') o.fpsSeconds = Math.max(2, num());
    else if (a === '--fps-retries') o.fpsRetries = Math.floor(num());
    else if (a === '--out') o.out = path.resolve(argv[++i]);
    else if (a === '--soak') o.soak = isNum(argv[i + 1]) ? Math.max(60, num()) : SOAK.seconds;
    else if (a === '--warmup') o.warmup = num();
    else if (a === '--soak-only') o.only = new Set(['soak']);
    else if (a === '--only') {
      const list = String(argv[++i] || '').split(',').filter(Boolean);
      const bad = list.filter((s) => !SECTIONS.includes(s));
      if (bad.length || !list.length) throw new Error(`--only takes ${SECTIONS.join(', ')} (got ${list.join(', ') || 'nothing'})`);
      o.only = new Set(list);
    } else if (a === '-h' || a === '--help') {
      const lines = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n');
      console.log(lines.slice(1, lines.findIndex((l) => l.startsWith('import '))).join('\n'));
      process.exit(0);
    } else throw new Error(`unknown option ${a}`);
  }
  if (!o.only) o.only = new Set(o.soak ? SECTIONS : ['sim', 'look']);
  if (o.only.has('soak') && !o.soak) o.soak = SOAK.seconds;
  return o;
}

// ---------------------------------------------------------------------------------------------------------------
// Scripts injected before the page's own scripts (Page.addScriptToEvaluateOnNewDocument)

/** Wraps the page's timers and rAF: window.__tt.pending() / fired(); window.__tt.real keeps the originals. */
const TIMER_TRACKER = `(() => {
  const real = { setTimeout: window.setTimeout.bind(window), clearTimeout: window.clearTimeout.bind(window),
    setInterval: window.setInterval.bind(window), clearInterval: window.clearInterval.bind(window),
    raf: window.requestAnimationFrame.bind(window), caf: window.cancelAnimationFrame.bind(window) };
  const st = { timeouts: new Map(), intervals: new Set(), rafs: new Set(), fired: { timeouts: 0, intervals: 0, rafs: 0 } };
  window.setTimeout = function (fn, ms, ...args) {
    let id = 0;
    id = real.setTimeout(function () { st.timeouts.delete(id); st.fired.timeouts++; if (typeof fn === 'function') return fn.apply(this, args); }, ms);
    st.timeouts.set(id, performance.now() + (Number(ms) || 0));
    return id;
  };
  window.clearTimeout = function (id) { st.timeouts.delete(id); return real.clearTimeout(id); };
  window.setInterval = function (fn, ms, ...args) {
    const id = real.setInterval(function () { st.fired.intervals++; if (typeof fn === 'function') return fn.apply(this, args); }, ms);
    st.intervals.add(id);
    return id;
  };
  window.clearInterval = function (id) { st.intervals.delete(id); return real.clearInterval(id); };
  window.requestAnimationFrame = function (fn) {
    let id = 0;
    id = real.raf(function (ts) { st.rafs.delete(id); st.fired.rafs++; return fn(ts); });
    st.rafs.add(id);
    return id;
  };
  window.cancelAnimationFrame = function (id) { st.rafs.delete(id); return real.caf(id); };
  window.__tt = {
    real,
    pending: () => ({ timeouts: st.timeouts.size, intervals: st.intervals.size, rafs: st.rafs.size }),
    fired: () => ({ timeouts: st.fired.timeouts, intervals: st.fired.intervals, rafs: st.fired.rafs }),
  };
})();`;

const CLEAR_STORAGE = 'try { localStorage.clear(); } catch (e) {}';
const FAKE_WEBVIEW = 'window.chrome = window.chrome || {}; window.chrome.webview = { postMessage() {}, addEventListener() {}, removeEventListener() {} };';
const NO_BATTERY = 'delete Navigator.prototype.getBattery;';

function fakeBattery(charging, level) {
  return `(() => {
  const listeners = {};
  const bat = { charging: ${charging}, level: ${level}, chargingTime: Infinity, dischargingTime: 7200,
    addEventListener(t, f) { (listeners[t] = listeners[t] || []).push(f); }, removeEventListener() {}, dispatchEvent() { return true; } };
  window.__fakeBattery = { set(charging, level) {
    const c = bat.charging !== charging; bat.charging = charging; if (level !== undefined) bat.level = level;
    if (c) (listeners.chargingchange || []).forEach((f) => f());
    (listeners.levelchange || []).forEach((f) => f());
  } };
  Object.defineProperty(Navigator.prototype, 'getBattery', { configurable: true, writable: true, value: () => Promise.resolve(bat) });
})();`;
}
/** Every page starts plugged in, so the machine's own power state never sets the frame rate; a check may replace it. */
const PLUGGED_IN = fakeBattery(true, 1);

/**
 * The page clock. ADJUSTABLE_CLOCK: the harness sets it once the page is running (window.__setClock(h, m, s): today at
 * h:m:s, then running on), so slow page loads cannot move the hour boundary. clockAt(h, m): the same, set before the
 * page's scripts run (a scene at a given time of day from the first frame). Date and Date.now shift; performance.now
 * and timers do not. Times are local to the page's (emulated) time zone, on today's date.
 */
const ADJUSTABLE_CLOCK = `(() => {
  const Real = Date;
  let offset = 0;
  class AdjustableDate extends Real {
    constructor(...a) { if (a.length) super(...a); else super(Real.now() + offset); }
    static now() { return Real.now() + offset; }
  }
  window.Date = AdjustableDate;
  window.__setClock = (h, m, s) => { const t = new Real(Real.now()); t.setHours(h, m, s, 0); offset = t.getTime() - Real.now(); return true; };
})();`;

function clockAt(h, m) {
  return `${ADJUSTABLE_CLOCK}\nwindow.__setClock(${h}, ${m}, 0);`;
}

/** Lively-style calls once lively.js has run but before the deferred scripts (the app) have. */
function earlyCalls(calls) {
  return `document.addEventListener('readystatechange', () => {
  if (document.readyState !== 'interactive' || window.__early) return;
  const app = !!(window.PCD && window.PCD.wpApp);
  for (const c of ${JSON.stringify(calls)}) {
    if (c[0] === 'property') livelyPropertyListener(c[1], c[2]);
    else livelyWallpaperPlaybackChanged(c[1]);
  }
  window.__early = { app, queued: (window.__pcdLivelyQueue || []).length };
});`;
}

/** Lively replays the saved values right after the page has loaded (in any order). */
function replayAfterLoad(pairs) {
  return `window.addEventListener('load', () => window.__tt.real.setTimeout(() => {
  window.__replayAt = Date.now();
  for (const [k, v] of ${JSON.stringify(pairs)}) livelyPropertyListener(k, v);
}, 20));`;
}

// ---------------------------------------------------------------------------------------------------------------
// Helpers

const rows = [];
const numbers = {};
const allErrors = [];
const network = [];
let pageLoads = 0;
/** Pages not closed yet: a check that fails half-way can leave its page (and its server) open. */
const openPages = new Set();

function record(name, pass, detail) {
  rows.push({ name, pass, detail });
  console.log(`${pass === null ? 'SKIP' : pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -- ' + String(detail).split('\n')[0] : ''}`);
}

async function check(name, fn) {
  try {
    const r = await fn();
    if (r && typeof r === 'object' && 'pass' in r) record(name, r.pass, r.detail);
    else record(name, true, typeof r === 'string' ? r : '');
  } catch (e) {
    record(name, false, e && e.message ? e.message : String(e));
  }
}

function must(cond, msg) {
  if (!cond) throw new Error(msg);
}

const near = (v, want, tol) => Math.abs(v - want) <= tol;

/**
 * A page in its own headless window (every window is visible at once; tabs in one window would hide each other and
 * pause) served from its own 127.0.0.1 port (its own origin, so localStorage, i.e. the weather cache, is not shared),
 * in the sample city's time zone.
 */
async function openPage(browser, { query = '?city=Berlin', width = 1280, height = 800, dpr = 2, init = [], label, fresh = true, ready = true } = {}) {
  const site = await serve(PKG);
  const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank', newWindow: true });
  const page = await browser.attach(targetId);
  page.site = site;
  openPages.add(page);
  page.base = site.url;
  pageLoads++;
  page.label = label || `${width}x${height}@${dpr}${query}`;
  page.requests = [];
  await page.send('Network.enable');
  page.on('Network.requestWillBeSent', (p) => {
    page.requests.push(p.request.url);
    network.push({ page: page.label, url: p.request.url });
  });
  await page.send('Emulation.setTimezoneOverride', { timezoneId: TIMEZONE });
  for (const source of [TIMER_TRACKER, ...(fresh ? [CLEAR_STORAGE] : []), PLUGGED_IN, ...init]) await page.send('Page.addScriptToEvaluateOnNewDocument', { source });
  await page.setViewport(width, height, dpr);
  await page.goto(page.base + 'index.html' + query);
  if (ready) await page.waitFor("document.documentElement.getAttribute('data-ready') === '1'", { timeoutMs: 20000 });
  return page;
}

async function closePage(page, { keepErrors = true } = {}) {
  openPages.delete(page);
  if (keepErrors) {
    for (const e of page.errors) allErrors.push(`${page.label}: ${e.type}: ${e.text}`);
    try {
      const n = await page.evaluate('window.PCD && PCD.wpApp && PCD.wpApp.stats ? PCD.wpApp.stats.errorCount : 0');
      if (n) allErrors.push(`${page.label}: app errorCount ${n}: ${JSON.stringify(await page.evaluate('PCD.wpApp.stats.errors'))}`);
    } catch { /* closed */ }
  }
  await page.close();
  await page.site.close();
}

/** Closes what a check that failed half-way left open: a page's server would otherwise keep the run from ending. */
async function closeLeftovers() {
  for (const page of [...openPages]) {
    try {
      await closePage(page);
    } catch {
      try { await page.site.close(); } catch { /* already closed */ }
    }
  }
}

/** Minimize or restore the page's window (a real visibilitychange: minimized pages are hidden). */
async function setMinimized(browser, page, on) {
  const { windowId } = await browser.send('Browser.getWindowForTarget', { targetId: page.targetId });
  await browser.send('Browser.setWindowBounds', { windowId, bounds: { windowState: on ? 'minimized' : 'normal' } });
}

const snap = (page) => page.evaluate('window.__pcd.snapshot()');
const call = (page, js) => page.evaluate(`(() => { ${js}; return true; })()`);
const prop = (page, name, value) => call(page, `livelyPropertyListener(${JSON.stringify(name)}, ${JSON.stringify(value)})`);
const playback = (page, paused) => call(page, `livelyWallpaperPlaybackChanged(${JSON.stringify(JSON.stringify({ IsPaused: paused }))})`);
const tt = (page) => page.evaluate('({ pending: __tt.pending(), fired: __tt.fired() })');
const loopStats = (page) => page.evaluate('window.__pcd.loop()');
const weatherReqs = (page) => page.requests.filter((u) => /open-meteo\.com/.test(u));
const weatherOk = "(() => { const w = window.__pcd.weather(); return !!w && w.status === 'ok'; })()";

/** The column's text (the console keeps the time as text for screen readers too). */
const COLUMN_TEXT = "(document.querySelector('[data-wp-layer=column]') || {}).innerText || ''";
const CAPTION_TEXT = "(document.querySelector('[data-wp-layer=caption]') || {}).innerText || ''";

/** Frames and steps per second over a window, from the app's loop counters and the rAF tracker. */
async function measure(page, seconds) {
  const a = await page.evaluate('({ l: __pcd.loop(), f: __tt.fired(), t: performance.now() })');
  await sleep(Math.round(seconds * 1000));
  const b = await page.evaluate('({ l: __pcd.loop(), f: __tt.fired(), t: performance.now() })');
  const s = (b.t - a.t) / 1000;
  return {
    seconds: s,
    fps: (b.l.frames - a.l.frames) / s,
    sps: (b.l.steps - a.l.steps) / s,
    rafsPerFrame: (b.f.rafs - a.f.rafs) / Math.max(1, b.l.frames - a.l.frames),
    target: b.l.target,
    p95: b.l.p95,
  };
}

async function measureFps(page, seconds, retries, want) {
  const tries = [];
  for (let k = 0; k <= retries; k++) {
    const m = await measure(page, seconds);
    tries.push(m);
    if (near(m.fps, want, want * 0.1) && near(m.sps, 30, 3)) break;
  }
  return tries;
}

/** How long before a still window a minute edge still counts: the frame it draws may not have landed yet. */
const EDGE_MARGIN_MS = 1000;

/**
 * A still window under reduced motion: two samples `ms` apart of the loop's counters, the rAFs armed, the app's minute
 * count and the page clock. The app draws one still frame at each minute edge (the column's new minute), so a window
 * that meets a minute edge, or starts less than EDGE_MARGIN_MS after one, is taken again once. Minute edges are a
 * minute apart, so the second window is clear of them. Returns { a, b, again }.
 */
async function stillWindow(page, ms) {
  const sample = () => page.evaluate('({ loop: __pcd.loop(), rafs: __tt.pending().rafs, minutes: __pcd.stats().minutes, now: Date.now() })');
  let again = false;
  for (;;) {
    const a = await sample();
    await sleep(ms);
    const b = await sample();
    const edge = b.minutes !== a.minutes || Math.floor((a.now - EDGE_MARGIN_MS) / 60000) !== Math.floor(b.now / 60000);
    if (!edge || again) return { a, b, again };
    again = true;
    await sleep(EDGE_MARGIN_MS); // past the edge and its frame
  }
}

function relShot(file) {
  return path.relative(ROOT, file).split(path.sep).join('/');
}

function finish() {
  console.log('');
  const counts = printReport(rows, { title: 'PixelClock Desktop wallpaper: Lively simulation, look and soak (headless Chrome)' });
  console.log('\nnumbers: ' + JSON.stringify(numbers));
  process.exitCode = counts.failed ? 1 : 0;
}

// ---------------------------------------------------------------------------------------------------------------
// sim: the Lively simulation

async function simulation(browser, opts, { model, props, idx }) {
  const page = await openPage(browser, { query: '?city=Berlin', label: 'main 1280x800@2' });
  await check('page loads: data-ready, the first frame drawn through the console (a varied, dimmed 64x64 frame), IN_LIVELY false outside Lively, 30 fps target, the scene clock off', async () => {
    const s = await snap(page);
    const colours = await page.evaluate(`(() => { const c = document.querySelector('[data-wp-layer=scene]'); const d = c.getContext('2d').getImageData(0, 0, 64, 64).data;
      const set = new Set(); for (let i = 0; i < d.length; i += 4) set.add(d[i] << 16 | d[i + 1] << 8 | d[i + 2]); return set.size; })()`);
    must(s.stats.ready && s.running, `ready ${s.stats.ready}, running ${s.running}`);
    must(colours > 20, `${colours} colours in the first frame`);
    must(s.stats.inLively === false, 'IN_LIVELY should be false in plain Chrome');
    must(s.scene.target === 30 && s.loop.frames > 0, `target ${s.scene.target}, frames ${s.loop.frames}`);
    must(s.state.side === 'right' && s.look && s.look.side === 'right', `side ${s.state.side} / ${s.look && s.look.side}`);
    must(s.metrics && Number.isInteger(s.metrics.k) && s.metrics.k >= 2, JSON.stringify(s.metrics));
    must(s.scene.hookMode === 'none', `hook mode ${s.scene.hookMode}: the column shows the clock, never the scene`);
    must(/^PCD\.console \+ PCD\.bleed$/.test(s.stats.look), `look ${s.stats.look}`);
    return `theme ${s.scene.id} (${s.scene.tag}), column right, k ${s.metrics.k}, font ${s.layout.font.px} px, ${colours} colours in the frame, ${s.stats.look}`;
  });

  await check('defaults: the page renders exactly what Lively replays from LivelyProperties.json (nothing fetched for the configured city)', async () => {
    const p = await openPage(browser, { query: '?city=', label: 'defaults (?city=)' });
    await sleep(3200); // past the settle window: the first weather check would run now
    const d = await p.evaluate('window.__pcd.defaults()');
    const st = await p.evaluate('window.__pcd.state()');
    const reqs = weatherReqs(p);
    await closePage(p);
    const want = model.P.stateFromProperties(props, { menu: model.menu, schema: model.S, config: {} });
    const diff = Object.keys(want).filter((k) => JSON.stringify(want[k]) !== JSON.stringify(d[k]));
    must(!diff.length, `differs: ${diff.map((k) => `${k} page ${JSON.stringify(k === 'city' ? '[city]' : d[k])} vs props ${JSON.stringify(k === 'city' ? '[city]' : want[k])}`).join('; ')}`);
    must(Object.keys(d).sort().join() === Object.keys(want).sort().join(), `keys: page ${Object.keys(d).sort()} vs props ${Object.keys(want).sort()}`);
    must(d.side === 'right', `side ${d.side}`);
    must(st.city === '' && reqs.length === 0, `the ?city= page must not fetch (requests ${reqs.length})`);
    return `${Object.keys(want).length} settings agree (city as configured, not printed; side right); 0 weather requests with ?city=`;
  });

  await check('calls before the app is ready are queued (lively.js) and replayed in order: theme, column side, city, a pause and its end', async () => {
    const calls = [['property', 'theme', idx('winter')], ['property', 'side', 1], ['property', 'city', 'Berlin'], ['playback', '{"IsPaused":true}'], ['playback', '{"IsPaused":false}']];
    const p = await openPage(browser, { query: '?city=', init: [earlyCalls(calls)], label: 'early calls' });
    const early = await p.evaluate('window.__early');
    await sleep(400);
    const s = await snap(p);
    const q = await p.evaluate('(window.__pcdLivelyQueue || []).length');
    await closePage(p);
    must(early && early.app === false && early.queued === calls.length, `calls were not early: ${JSON.stringify(early)}`);
    must(s.state.theme === 'winter' && s.scene.id === 'winter' && s.scene.tag === 'pinned', `theme ${s.state.theme} / scene ${s.scene.id} (${s.scene.tag})`);
    must(s.state.side === 'left' && s.look.side === 'left', `side ${s.state.side} / console ${s.look.side}`);
    must(s.state.city === 'Berlin', 'city not replayed');
    must(s.running && s.stats.pauses.lively === 1, `running ${s.running}, lively pauses ${s.stats.pauses.lively}`);
    must(q === 0, `${q} calls left in the queue`);
    return `${early.queued} calls queued before PCD.wpApp existed; replayed: winter pinned, column left (k ${s.metrics.k}), Berlin, one pause and resume`;
  });

  await check("Lively's replay right after load (shuffled, every value type) applies at once, textboxes included; one weather lookup", async () => {
    const replay = [
      ['units', 1], ['debugOverlay', false], ['side', 1], ['shakeHourly', true], ['theme', idx('autumn')], ['clock24', true],
      ['lowPowerOnBattery', true], ['weather', true], ['city', 'Berlin'], ['sunTimes', true], ['weatherFx', true],
      ['reducedMotion', false], ['performance', false], ['taskbarSpace', true],
    ];
    for (let i = replay.length - 1; i > 0; i--) { const j = (i * 7 + 3) % (i + 1); [replay[i], replay[j]] = [replay[j], replay[i]]; }
    const p = await openPage(browser, { query: '?city=', init: [replayAfterLoad(replay)], label: 'replay after load' });
    await p.waitFor('window.__replayAt > 0', { timeoutMs: 10000 });
    await sleep(300);
    const s = await snap(p);
    await p.waitFor(weatherOk, { timeoutMs: 12000 });
    const reqs = weatherReqs(p);
    await closePage(p);
    const want = model.P.stateFromProperties(Object.fromEntries(replay.map(([k, v]) => [k, { value: v }])), { menu: model.menu, schema: model.S, config: {} });
    const diff = Object.keys(want).filter((k) => JSON.stringify(want[k]) !== JSON.stringify(s.state[k]));
    must(!diff.length, `0.3 s after the replay: ${diff.map((k) => `${k} ${JSON.stringify(s.state[k])} want ${JSON.stringify(want[k])}`).join('; ')}`);
    must(s.state.city === 'Berlin' && s.state.units === 'C' && s.state.clock24 === true && s.state.side === 'left', 'textbox/dropdown/checkbox not applied');
    must(s.look.side === 'left', `the console's side: ${s.look.side}`);
    must(reqs.length === 2 && reqs[0] === GEOCODE_BERLIN && reqs[1].startsWith(FORECAST_START) && !reqs[1].includes('fahrenheit'), `requests: ${reqs.join(' | ')}`);
    return `order: ${replay.map((r) => r[0]).join(', ')}; city applied at once; 1 geocode + 1 forecast (C), the exact Open-Meteo URLs`;
  });

  await page.waitFor(weatherOk, { timeoutMs: 12000 });
  await check('weather: one geocode + one forecast (the exact Open-Meteo URLs); the weather block with its credit and the strip times in the column', async () => {
    const reqs = weatherReqs(page);
    must(reqs.length === 2 && reqs[0] === GEOCODE_BERLIN && reqs[1].startsWith(FORECAST_START), `requests: ${reqs.join(' | ')}`);
    await sleep(300);
    const text = await page.evaluate(COLUMN_TEXT);
    must(/-?\d+°[CF] overcast/.test(text) && /feels -?\d+° · wind \d+ (mph|km\/h)/.test(text) && /hi -?\d+° · lo -?\d+°/.test(text), `column: ${text.replace(/\s+/g, ' ')}`);
    must(/open-meteo\.com/.test(text), `the credit (Open-Meteo's terms) is missing in: ${text}`);
    const s = await snap(page);
    must(s.scene.fx === true, 'weather fx off with data and Weather in the scene on');
    must(s.regions && s.regions.weather && s.regions.strip, `the column has the weather and strip rows: ${JSON.stringify(s.regions && { weather: s.regions.weather, strip: s.regions.strip })}`);
    must(s.view.sun && s.view.sun.rise < s.view.sun.set, `the real sun times label the strip (Berlin, page time zone ${TIMEZONE}): ${JSON.stringify(s.view.sun)}`);
    const strip = await page.evaluate("(document.querySelector('[data-wp-layer=column] .pcd-striptext') || {}).innerText || ''");
    must(/^\s*\d{1,2}:\d\d\s+\d{1,2}:\d\d\s*$/.test(strip), `the strip's sunrise and sunset times: "${strip}"`);
    return `"${(text.match(/(-?\d+°[CF] overcast)/) || ['', ''])[1]}", feels/wind, high/low, "${(text.match(/\S*open-meteo\.com/) || [''])[0]}"; strip "${strip.trim().replace(/\s+/g, ' ... ')}"; fx on`;
  });

  await check('dropdowns (index): Column side Left/Right flips the column and the scene live; theme pinned/auto; units Celsius (forecast only, no new geocode)', async () => {
    const W = 1280;
    await prop(page, 'side', 1);
    let s = await snap(page);
    const L1 = { col: s.regions.column, m: s.metrics, wd: s.layout.Wd };
    must(s.state.side === 'left' && s.look.side === 'left', `side ${s.state.side}`);
    must(L1.col.x < W / 2 && L1.m.x + L1.m.size >= L1.wd, `left: column x ${L1.col.x}, scene ${JSON.stringify(L1.m)} (flush right)`);
    await prop(page, 'side', 0);
    s = await snap(page);
    const L0 = { col: s.regions.column, m: s.metrics };
    must(s.state.side === 'right' && L0.col.x + L0.col.w > W / 2 && L0.m.x <= 0, `right: column ${JSON.stringify(L0.col)}, scene ${JSON.stringify(L0.m)} (flush left)`);
    await prop(page, 'theme', idx('halloween'));
    await sleep(1800); // the 1.5 s cross-fade
    s = await snap(page);
    must(s.state.theme === 'halloween' && s.scene.id === 'halloween' && s.scene.tag === 'pinned', `theme ${s.scene.id} ${s.scene.tag}`);
    const cap = await page.evaluate(CAPTION_TEXT);
    must(/haunted hill · pinned · (dawn|day|sunset|night)/.test(cap), `caption "${cap}"`);
    await prop(page, 'theme', 0);
    s = await snap(page);
    must(s.scene.tag === 'auto' && s.state.theme === 'auto', `auto: ${s.scene.tag}`);
    // Fahrenheit first, whatever units the build's config starts with, then Celsius: exactly one new forecast
    await prop(page, 'units', 0);
    await page.waitFor("(() => { const w = window.__pcd.weather(); return !!w && w.units === 'F'; })()", { timeoutMs: 8000 });
    const n0 = weatherReqs(page).length;
    await prop(page, 'units', 1);
    await page.waitFor("(() => { const w = window.__pcd.weather(); return !!w && w.units === 'C'; })()", { timeoutMs: 8000 });
    const r = weatherReqs(page).slice(n0);
    must(r.length === 1 && r[0].startsWith(FORECAST_START) && !r[0].includes('fahrenheit'), `units C: ${r.join(' | ')}`);
    await prop(page, 'units', 0);
    await page.waitFor("(() => { const w = window.__pcd.weather(); return !!w && w.units === 'F'; })()", { timeoutMs: 8000 });
    return `left: column at x ${L1.col.x}, scene flush right (k ${L1.m.k}); right: column at x ${L0.col.x}, scene at ${L0.m.x}; caption "${cap}"; auto; Celsius: 1 forecast request, no geocode`;
  });

  await check('checkboxes (boolean): 24-hour clock, weather in the scene, keep clear of the taskbar (the column moves into the band and back)', async () => {
    await prop(page, 'clock24', true);
    let col = await page.evaluate(COLUMN_TEXT);
    must(/(^|\D)\d\d:\d\d(?!\d)/.test(col) && !/\b(am|pm)\b/.test(col), `24 h clock in "${col.split('\n')[0]}"`);
    await prop(page, 'clock24', false);
    col = await page.evaluate(COLUMN_TEXT);
    must(/\d{1,2}:\d\d\s*[ap]m/.test(col) && /\b[ap]m\b/.test(col), `12 h clock in "${col.split('\n')[0]}"`);
    const clock = (col.match(/\d{1,2}:\d\d\s*[ap]m/) || [''])[0];
    await prop(page, 'weatherFx', false);
    let s = await snap(page);
    must(s.scene.fx === false, 'fx still on');
    await prop(page, 'weatherFx', true);
    const on = s.layout.taskbar;
    await prop(page, 'taskbarSpace', false);
    s = await snap(page);
    const off = s.layout.taskbar;
    must(s.taskbar === 0 && off.dev === 0 && on.dev === TASKBAR * 2, `taskbar band on ${JSON.stringify(on)}, off ${JSON.stringify(off)}`);
    await prop(page, 'taskbarSpace', true);
    s = await snap(page);
    const col1 = s.regions.column;
    must(s.taskbar === TASKBAR && col1.y + col1.h <= 800 - TASKBAR + 0.5, `the column ${JSON.stringify(col1)} keeps the ${TASKBAR} px band clear`);
    return `clock "${clock.trim()}"; fx off/on; taskbar band ${on.dev} device px, off 0, back on`;
  });

  await check('textbox: typing "Berlin" key by key applies once, 1.5 s after the last keystroke; one geocode', async () => {
    const p = await openPage(browser, { query: '?city=', label: 'typing' });
    await p.waitFor('!window.__pcd.snapshot().settling', { timeoutMs: 8000 }); // textboxes are debounced after the settle window
    for (const s of ['B', 'Be', 'Ber', 'Berl', 'Berli', 'Berlin']) {
      await prop(p, 'city', s);
      await sleep(120);
    }
    const a = await snap(p);
    await sleep(900);
    const b = await snap(p);
    await sleep(800);
    const c = await snap(p);
    await p.waitFor(weatherOk, { timeoutMs: 10000 });
    const reqs = weatherReqs(p);
    await closePage(p);
    must(a.state.city === '' && b.state.city === '', `applied too early: "${a.state.city}" / "${b.state.city}"`);
    must(c.state.city === 'Berlin', `city "${c.state.city}" 1.7 s after the last key`);
    must(reqs.length === 2 && reqs[0] === GEOCODE_BERLIN, `requests: ${reqs.join(' | ')}`);
    return '6 keystrokes -> nothing for 1.5 s, then city Berlin; 1 geocode + 1 forecast';
  });

  await check('buttons (true): Surprise me (tag surprise, another theme), Shake (one engine shake), Refresh weather (forced, coalesced)', async () => {
    let s = await snap(page);
    const before = s.scene.id;
    await prop(page, 'surprise', true);
    s = await snap(page);
    const picked = s.scene.id;
    must(s.scene.tag === 'surprise' && s.scene.id !== before && s.surprise && s.surprise.id === s.scene.id, `surprise: ${s.scene.id} (${s.scene.tag})`);
    // midnight in the page's own time zone (the harness runs pages in the sample city's)
    const untilHms = await page.evaluate(`(() => { const d = new Date(${s.surprise.until}); return [d.getHours(), d.getMinutes(), d.getSeconds()]; })()`);
    must(untilHms.join() === '0,0,0' && s.surprise.until > Date.now(), `a surprise lasts until local midnight (until ${untilHms.join(':')})`);
    const sh0 = s.scene.engine.shakes;
    await prop(page, 'shakeNow', true);
    await sleep(400);
    s = await snap(page);
    must(s.scene.engine.shakes === sh0 + 1, `engine shakes ${sh0} -> ${s.scene.engine.shakes}`);
    await prop(page, 'shakeNow', true);
    await prop(page, 'shakeNow', true);
    s = await snap(page);
    must(s.stats.shakesDebounced >= 1, 'presses within 300 ms are debounced');
    const n0 = weatherReqs(page).length;
    await prop(page, 'refreshWeather', true);
    await sleep(600);
    const n1 = weatherReqs(page).length;
    for (let i = 0; i < 20; i++) await prop(page, 'refreshWeather', true);
    await sleep(600);
    const n2 = weatherReqs(page).length;
    must(n1 - n0 === 1, `Refresh: ${n1 - n0} requests`);
    must(n2 - n1 === 0, `20 more presses within 15 s: ${n2 - n1} requests`);
    await prop(page, 'theme', 0); // a Theme change ends the surprise
    s = await snap(page);
    must(s.scene.tag === 'auto' && !s.surprise, `after a Theme change: ${s.scene.tag}`);
    return `surprise ${before} -> ${picked} until midnight, a Theme change -> auto; 1 shake (+ debounced presses); refresh: 1 forced request, 20 presses coalesced`;
  });

  await check('bad input is ignored and counted: unknown and Object.prototype names, out-of-range index, wrong types', async () => {
    const s0 = await snap(page);
    await call(page, "for (const k of ['toString', 'constructor', '__proto__', 'nope', 'sceneLabel']) livelyPropertyListener(k, 1); livelyPropertyListener('theme', 99); livelyPropertyListener('clock24', 'maybe'); livelyPropertyListener('side', 'middle'); livelyWallpaperPlaybackChanged('garbage')");
    const s = await snap(page);
    must(JSON.stringify(s.state) === JSON.stringify(s0.state), 'the state changed');
    must(s.stats.properties.ignored - s0.stats.properties.ignored === 8, `ignored ${s.stats.properties.ignored - s0.stats.properties.ignored}`);
    must(s.stats.playbackBad === s0.stats.playbackBad + 1 && s.running, 'a garbage playback event paused the page');
    return '8 bad property calls ignored, a garbage playback event ignored, state unchanged';
  });

  await check('pause ({"IsPaused":true}): every timer and rAF stops within 100 ms and nothing fires for 2 s', async () => {
    await sleep(500);
    const before = await tt(page);
    must(before.pending.timeouts + before.pending.rafs >= 1, 'nothing armed before the pause');
    const atPause = await page.evaluate(`(() => { livelyWallpaperPlaybackChanged('{"IsPaused":true}'); return { pending: __tt.pending(), fired: __tt.fired(), timers: __pcd.timers() }; })()`);
    await sleep(100);
    const t100 = await tt(page);
    const l0 = await loopStats(page);
    await sleep(2000);
    const t2 = await tt(page);
    const l2 = await loopStats(page);
    const timers = await page.evaluate('__pcd.timers()');
    must(atPause.pending.timeouts === 0 && atPause.pending.rafs === 0 && atPause.pending.intervals === 0, `right after the call: ${JSON.stringify(atPause.pending)} (${atPause.timers.join(', ')})`);
    must(t100.pending.timeouts === 0 && t100.pending.rafs === 0, `after 100 ms: ${JSON.stringify(t100.pending)}`);
    must(JSON.stringify(t2.fired) === JSON.stringify(atPause.fired), `fired while paused: ${JSON.stringify(atPause.fired)} -> ${JSON.stringify(t2.fired)}`);
    must(l2.frames === l0.frames && l2.steps === l0.steps && l2.paused && l2.reasons.join() === 'lively', `loop ${JSON.stringify({ f: [l0.frames, l2.frames], s: [l0.steps, l2.steps], r: l2.reasons })}`);
    must(timers.length === 0, `app timers: ${timers.join(', ')}`);
    numbers.pause = { pendingBefore: before.pending, pendingAt: atPause.pending, firedDuring: 0 };
    return `before: ${before.pending.timeouts} timeout(s) + ${before.pending.rafs} rAF; at the call and 100 ms later: 0 / 0; 2 s: 0 timeouts, 0 rAF fired, frames and steps unchanged`;
  });

  await check('resume ({"IsPaused":false}) continues without fast-forward: about 30 steps per second, at most 2 steps in a frame', async () => {
    const l0 = await loopStats(page);
    await playback(page, false);
    await sleep(2000);
    const l1 = await loopStats(page);
    const timers = await page.evaluate('__pcd.timers()');
    const steps = l1.steps - l0.steps;
    must(!l1.paused && l1.resumes >= 1, 'not running after the resume');
    must(steps >= 54 && steps <= 66, `${steps} steps in 2 s after a 2 s pause (want about 60)`);
    must(l1.sinceResume.maxSteps <= 2, `max steps in one frame since the resume: ${l1.sinceResume.maxSteps} (no catch-up)`);
    must(timers.includes('tick') && (timers.includes('frame') || timers.includes('raf')), `timers ${timers.join(', ')}`);
    numbers.resume = { steps2s: steps, frames2s: l1.frames - l0.frames, maxSteps: l1.sinceResume.maxSteps };
    return `+${l1.frames - l0.frames} frames, +${steps} steps in 2 s; max ${l1.sinceResume.maxSteps} step(s) per frame; timers ${timers.join(', ')}`;
  });

  await check('visibility: a hidden page (its window minimized) pauses (no timer, no rAF), visible again resumes', async () => {
    await setMinimized(browser, page, true);
    await page.waitFor("document.visibilityState === 'hidden'", { timeoutMs: 5000 });
    await sleep(100);
    const a = await tt(page);
    const l0 = await loopStats(page);
    await sleep(1500);
    const b = await tt(page);
    const l1 = await loopStats(page);
    await setMinimized(browser, page, false);
    await page.waitFor("document.visibilityState === 'visible'", { timeoutMs: 5000 });
    await sleep(1000);
    const l2 = await loopStats(page);
    must(a.pending.timeouts === 0 && a.pending.rafs === 0, `hidden: ${JSON.stringify(a.pending)}`);
    must(JSON.stringify(a.fired) === JSON.stringify(b.fired) && l1.frames === l0.frames, `fired while hidden: ${JSON.stringify(a.fired)} -> ${JSON.stringify(b.fired)}`);
    must(l1.reasons.join() === 'hidden', `reasons ${l1.reasons}`);
    must(!l2.paused && l2.frames - l1.frames >= 20, `visible again: ${l2.frames - l1.frames} frames in 1 s`);
    return `hidden: 0 timers, 0 rAF, nothing fired for 1.5 s; visible: +${l2.frames - l1.frames} frames in 1 s`;
  });

  await check(`frame rate: 30 fps +-10 % with 30 engine steps per second and one rAF per frame (${opts.fpsSeconds} s window)`, async () => {
    const tries = await measureFps(page, opts.fpsSeconds, opts.fpsRetries, 30);
    const m = tries[tries.length - 1];
    const cost = await page.evaluate("(() => { const s = window.__pcd.paint(); return s && s.layer ? s.layer.cost : null; })()");
    numbers.fps30 = tries.map((t) => ({ fps: +t.fps.toFixed(2), sps: +t.sps.toFixed(2), rafsPerFrame: +t.rafsPerFrame.toFixed(2), p95: t.p95 }));
    numbers.drawCost = cost;
    const ok = near(m.fps, 30, 3) && near(m.sps, 30, 3) && m.rafsPerFrame <= 1.2;
    return { pass: ok, detail: tries.map((t, i) => `window ${i + 1}: ${t.fps.toFixed(1)} fps, ${t.sps.toFixed(1)} steps/s, ${t.rafsPerFrame.toFixed(2)} rAF per frame, p95 ${t.p95} ms`).join('; ') + (cost ? `; the scene layer's draw p95 ${cost.p95} ms` : '') };
  });

  await check('debug overlay: viewport @ DPR, the look (column side, k, scene, font, taskbar), fps, p95, pause reasons, theme and tag, phase, sun, weather age, IN_LIVELY, origin, battery', async () => {
    await prop(page, 'debugOverlay', true);
    await sleep(1200);
    await playback(page, true);
    const paused = await page.evaluate("document.getElementById('debug').textContent");
    await playback(page, false);
    await sleep(1200);
    const t = await page.evaluate("document.getElementById('debug').textContent");
    const shown = await page.evaluate("!document.getElementById('debug').hidden");
    let file = null;
    if (opts.shots) {
      file = path.join(opts.out, 'wallpaper-debug-1280x800.png');
      writeBytes(file, await page.screenshot());
    }
    await prop(page, 'debugOverlay', false);
    const hidden = await page.evaluate("document.getElementById('debug').hidden");
    for (const k of ['viewport', '1280 x 800 @ 2', 'look', 'full screen, column right, taskbar 56 px', 'fps', 'target 30', 'p95', 'paused', 'theme', 'auto', 'phase', 'sun', 'weather', 'age', 'IN_LIVELY no', 'origin', page.base.replace(/\/$/, ''), 'battery', 'console', 'PCD.console + PCD.bleed']) {
      must(t.includes(k), `missing "${k}" in\n${t}`);
    }
    must(/\nscene\s+k \d+, \d+ px at -?\d+,-?\d+; font \d+ px, cell [\d.]+ x [\d.]+\n/.test(t), `the scene row in\n${t}`);
    must(/paused\s+lively/.test(paused), `while paused:\n${paused}`);
    must(shown && hidden, `shown ${shown}, hidden after off ${hidden}`);
    // centred over the scene side, clear of the column
    await prop(page, 'debugOverlay', true);
    const box = await page.evaluate("(() => { const r = document.getElementById('debug').getBoundingClientRect(); return { x: r.left, w: r.width }; })()");
    const col = (await snap(page)).regions.column;
    await prop(page, 'debugOverlay', false);
    must(box.x >= 0 && box.x + box.w <= col.x + 0.5, `the overlay ${JSON.stringify(box)} runs into the column at ${col.x}`);
    return `${t.split('\n').length} lines, over the scene side (x ${Math.round(box.x)}-${Math.round(box.x + box.w)}, the column from ${col.x})${file ? '; ' + relShot(file) : ''}`;
  });
  await closePage(page);

  await check('inside a (fake) Lively WebView2 host: IN_LIVELY true (window.chrome.webview), shown by ?debug=1', async () => {
    const p = await openPage(browser, { query: '?city=&debug=1', init: [FAKE_WEBVIEW], label: 'fake webview' });
    const s = await snap(p);
    const t = await p.evaluate("document.getElementById('debug').textContent");
    await closePage(p);
    must(s.stats.inLively === true && t.includes('IN_LIVELY yes'), `inLively ${s.stats.inLively}`);
    return 'IN_LIVELY yes';
  });

  await check('battery (fake getBattery, discharging): 15 fps with 30 steps per second; plugged in -> 30; "Performance mode on battery" off -> 30; performance mode -> 15', async () => {
    const p = await openPage(browser, { query: '?city=', init: [fakeBattery(false, 0.42)], label: 'battery' });
    await sleep(600);
    let s = await snap(p);
    must(s.stats.battery.supported && s.stats.battery.charging === false && s.scene.target === 15, `target ${s.scene.target}, battery ${JSON.stringify(s.stats.battery)}`);
    const tries = await measureFps(p, 4, opts.fpsRetries, 15);
    const m = tries[tries.length - 1];
    must(near(m.fps, 15, 1.5) && near(m.sps, 30, 3), `measured ${m.fps.toFixed(1)} fps, ${m.sps.toFixed(1)} steps/s`);
    await p.evaluate('window.__fakeBattery.set(true, 0.43)');
    s = await snap(p);
    must(s.scene.target === 30, `plugged in: ${s.scene.target}`);
    await p.evaluate('window.__fakeBattery.set(false, 0.40)');
    await prop(p, 'lowPowerOnBattery', false);
    s = await snap(p);
    must(s.scene.target === 30 && s.state.performance === 'off', `low power off: ${s.scene.target} (${s.state.performance})`);
    await prop(p, 'performance', true);
    s = await snap(p);
    must(s.scene.target === 15 && s.state.performance === 'on', `performance mode: ${s.scene.target}`);
    await closePage(p);
    numbers.battery = { fps: +m.fps.toFixed(2), sps: +m.sps.toFixed(2) };
    return `on battery: ${m.fps.toFixed(1)} fps, ${m.sps.toFixed(1)} steps/s; plugged in 30; low power off 30; performance mode 15`;
  });

  await check('no navigator.getBattery: battery not supported, 30 fps, nothing breaks', async () => {
    const p = await openPage(browser, { query: '?city=', init: [NO_BATTERY], label: 'no battery' });
    await sleep(400);
    const s = await snap(p);
    await closePage(p);
    must(s.stats.battery.supported === false && s.scene.target === 30, JSON.stringify(s.stats.battery));
    return 'battery: not supported; 30 fps';
  });

  await check('reduced motion (Customise): no frame loop, still frames only; a shake plays 4 s at about 15 fps, then freezes', async () => {
    const p = await openPage(browser, { query: '?city=', label: 'reduced motion' });
    try {
      await prop(p, 'reducedMotion', true);
      // the switch draws one still frame; then the loop has nothing armed
      await p.waitFor("(() => { const l = __pcd.loop(); return l.target === 0 && !l.pending.timer && !l.pending.raf; })()", { timeoutMs: 5000 })
        .catch(() => { throw new Error('the loop still had a timer or rAF armed 5 s after the switch to reduced motion'); });
      const again = (w) => (w.again ? ' (taken again after a minute edge)' : '');
      const still = await stillWindow(p, 1500);
      const [a, b] = [still.a.loop, still.b.loop];
      must(a.target === 0 && b.frames === a.frames && still.a.rafs === 0 && still.b.rafs === 0, `still: target ${a.target}, frames ${a.frames} -> ${b.frames}, rAF pending ${still.a.rafs} / ${still.b.rafs}${again(still)}`);
      // every shake must freeze again; under load a burst can lose frames, so a short count shakes again (--fps-retries)
      const tries = [];
      let from = b;
      for (;;) {
        await prop(p, 'shakeNow', true);
        await sleep(2000);
        const c = await loopStats(p);
        await sleep(3000);
        const frozen = await stillWindow(p, 1000);
        const [d, e] = [frozen.a.loop, frozen.b.loop];
        must(c.burst === true, `burst flag ${c.burst} 2 s after the shake`);
        must(e.frames === d.frames && frozen.b.rafs === 0 && !e.burst, `frozen again: ${d.frames} -> ${e.frames}${again(frozen)}`);
        // the shake's own frames: a minute edge on the way adds a still frame, which is not the burst's
        const shook = (d.frames - d.stillFrames) - (from.frames - from.stillFrames);
        tries.push({ shook, again: frozen.again });
        if ((shook >= 50 && shook <= 66) || tries.length > opts.fpsRetries) break;
        from = e;
      }
      const burst = tries[tries.length - 1].shook;
      const retried = tries.length > 1 ? ` (shaken ${tries.length} times: ${tries.map((t) => t.shook).join(', ')} frames)` : '';
      must(burst >= 50 && burst <= 66, `burst: ${burst} frames (want about 60)${retried}`);
      const s = await snap(p);
      must(s.view.steady === true, 'the colon is steady under reduced motion');
      const edges = [still, ...tries].filter((w) => w.again).length;
      return `0 frames in 1.5 s while still; shake: ${burst} frames in about 4 s${retried}; then frozen; colon steady` +
        (edges ? `; ${edges} window(s) taken again after a minute edge (the one still frame there is expected)` : '');
    } finally {
      await closePage(p);
    }
  });

  await check('prefers-reduced-motion (setting auto) is followed at run time: reduce -> still, no-preference -> 30 fps', async () => {
    const p = await openPage(browser, { query: '?city=', label: 'prefers-reduced-motion' });
    await p.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    await sleep(400);
    const a = await loopStats(p);
    await p.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
    await sleep(1000);
    const b = await loopStats(p);
    await closePage(p);
    must(a.target === 0, `reduce: target ${a.target}`);
    must(b.target === 30 && b.frames - a.frames >= 20, `no-preference: target ${b.target}, +${b.frames - a.frames} frames`);
    return `reduce: still; no-preference: +${b.frames - a.frames} frames in 1 s`;
  });

  await check('hourly surprise: 10:59:58 -> one shake at 11:00, 23:59:58 -> one at midnight; none at 8:59:58 (9 am rings no bell), with the checkbox off, or while paused', async () => {
    const at = [[10, 59, 58], [23, 59, 58], [8, 59, 58], [10, 59, 58], [10, 59, 58]];
    const pages = await Promise.all([
      openPage(browser, { query: '?city=', init: [ADJUSTABLE_CLOCK], label: '10:59:58' }),
      openPage(browser, { query: '?city=', init: [ADJUSTABLE_CLOCK], label: '23:59:58' }),
      openPage(browser, { query: '?city=', init: [ADJUSTABLE_CLOCK], label: '08:59:58' }),
      openPage(browser, { query: '?city=&shakeHourly=0', init: [ADJUSTABLE_CLOCK], label: '10:59:58 off' }),
      openPage(browser, { query: '?city=', init: [ADJUSTABLE_CLOCK], label: '10:59:58 paused' }),
    ]);
    await sleep(300); // every page is running
    await playback(pages[4], true);
    await Promise.all(pages.map((p, i) => p.evaluate(`window.__setClock(${at[i].join(', ')})`)));
    await sleep(4200);
    await playback(pages[4], false);
    await sleep(400);
    const s = await Promise.all(pages.map((p) => snap(p)));
    const clocks = await Promise.all(pages.map((p) => p.evaluate('new Date().toTimeString().slice(0, 8)')));
    for (const p of pages) await closePage(p);
    must(s[0].stats.hourly === 1 && s[0].stats.shakeSources.hourly === 1 && s[0].scene.engine.shakes >= 1, `10:59:58: hourly ${s[0].stats.hourly}, engine shakes ${s[0].scene.engine.shakes} (clock ${clocks[0]})`);
    must(s[1].stats.hourly === 1 && s[1].scene.engine.shakes >= 1, `23:59:58: hourly ${s[1].stats.hourly} (clock ${clocks[1]})`);
    must(s[2].stats.hourly === 0, `08:59:58: hourly ${s[2].stats.hourly}`);
    must(s[3].stats.hourly === 0, `checkbox off: hourly ${s[3].stats.hourly}`);
    must(s[4].stats.hourly === 0, `paused over the hour: hourly ${s[4].stats.hourly}`);
    return `11:00 and 00:00 rang once each (page clocks ${clocks[0]}, ${clocks[1]}); 9:00, checkbox off and paused: none`;
  });
}

// ---------------------------------------------------------------------------------------------------------------
// look: the scene and the column at the look sizes, both column sides

/** Text runs that are only box, shadow, icon or separator glyphs are decoration: the contrast check skips them. */
const DECOR = /^[\s·─░⌂»›[\]()|_\-.,'`\\/*O:]+$/;
const lin = (v) => { const x = v / 255; return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); };
const lum = (r, g, b) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
const ratio = (a, b) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);

/** Hide (or show again) the layers named (data-wp-layer) and the debug overlay: inline visibility, test only. */
function layers(page, hide) {
  return page.evaluate(`(() => {
    for (const e of document.querySelectorAll('[data-wp-layer]')) e.style.visibility = ${JSON.stringify(hide)}.includes(e.dataset.wpLayer) ? 'hidden' : '';
    const d = document.getElementById('debug');
    if (d) d.hidden = true;
    return true;
  })()`);
}

/** Every visible text run of the column and the caption, with its colour and CSS px rects; the big clock's box too. */
function textRuns(page) {
  return page.evaluate(`(() => {
    const out = [];
    const rgb = (s) => { const m = /rgba?\\((\\d+), (\\d+), (\\d+)/.exec(s); return m ? [+m[1], +m[2], +m[3]] : null; };
    for (const host of document.querySelectorAll('[data-wp-layer=column], [data-wp-layer=caption]')) {
      const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const t = n.nodeValue;
        if (!t || !t.trim()) continue;
        const el = n.parentElement;
        if (!el || el.closest('[hidden]') || el.closest('.pcd-sr')) continue;
        const cs = getComputedStyle(el);
        if (cs.visibility === 'hidden' || cs.display === 'none') continue;
        const range = document.createRange();
        range.selectNodeContents(n);
        for (const r of range.getClientRects()) {
          if (r.width < 1 || r.height < 1) continue;
          out.push({ text: t.trim().slice(0, 48), color: rgb(cs.color), x: r.left, y: r.top, w: r.width, h: r.height });
        }
      }
    }
    const clock = document.querySelector('[data-wp-layer=column] canvas.pcd-clockpx');
    const clockColor = getComputedStyle(document.getElementById('console')).getPropertyValue('--clock').trim();
    let clockBox = null;
    if (clock && !clock.hidden) { const r = clock.getBoundingClientRect(); if (r.width > 0) clockBox = { x: r.left, y: r.top, w: r.width, h: r.height }; }
    const parts = [];
    for (const e of document.querySelectorAll('[data-wp-layer=column] *, [data-wp-layer=caption]')) {
      if (e.closest('[hidden]') || e.classList.contains('pcd-sr')) continue;
      const cs = getComputedStyle(e);
      if (cs.visibility === 'hidden' || cs.display === 'none') continue;
      const r = e.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) parts.push({ cls: String(e.className || e.tagName), x: r.left, y: r.top, w: r.width, h: r.height });
    }
    return { runs: out, clockBox, clockColor, parts };
  })()`);
}

/** The brightest pixel (WCAG luminance) of a CSS px rect in a device px image. */
function brightest(img, dpr, r) {
  const x0 = Math.max(0, Math.floor(r.x * dpr));
  const x1 = Math.min(img.width, Math.ceil((r.x + r.w) * dpr));
  const y0 = Math.max(0, Math.floor(r.y * dpr));
  const y1 = Math.min(img.height, Math.ceil((r.y + r.h) * dpr));
  let max = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * img.width + x) * img.channels;
      const L = lum(img.data[i], img.data[i + 1], img.data[i + 2]);
      if (L > max) max = L;
    }
  }
  return max;
}

function hexRgb(h) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(h || '').trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/**
 * Crisp: every device pixel of the world layer (the veil and the column hidden) equals what the page reports for it:
 * the dimmed frame's colour for its k x k block inside the scene, the seam's for its k x k block, the band row's
 * across the band (one row of the scene, k device px tall). Tolerance 2 per channel.
 */
function crispCheck(img, rep) {
  const g = rep.scene;
  const k = g.k;
  if (img.width !== g.Wd || img.height !== g.Hd) return { ok: false, bad: -1, first: `png ${img.width}x${img.height} != ${g.Wd}x${g.Hd}` };
  const cols = rep.cols || 0;
  let bad = 0;
  let first = null;
  const flag = (x, y, why) => { bad++; if (!first) first = { x, y, ...why }; };
  for (let y = 0; y < img.height; y++) {
    const ry = Math.floor((y - g.y) / k);
    if (ry < 0 || ry > 63) { flag(0, y, { why: 'a row outside the scene' }); continue; }
    for (let x = 0; x < img.width; x++) {
      let want = null;
      if (x >= g.x && x < g.x + g.size) want = rep.frame[ry * 64 + Math.floor((x - g.x) / k)];
      else if (g.fade && cols && x >= g.fade.x && x < g.fade.x + g.fade.w) want = rep.fade[ry * cols + Math.floor((x - g.fade.x) / k)];
      else if (g.band && x >= g.band.x && x < g.band.x + g.band.w) want = rep.rows[ry];
      if (want === null || want === undefined) { flag(x, y, { why: 'no layer here' }); continue; }
      const i = (y * img.width + x) * img.channels;
      const r = (want >> 16) & 255;
      const gg = (want >> 8) & 255;
      const b = want & 255;
      if (Math.abs(img.data[i] - r) > 2 || Math.abs(img.data[i + 1] - gg) > 2 || Math.abs(img.data[i + 2] - b) > 2) {
        flag(x, y, { want: [r, gg, b], got: [img.data[i], img.data[i + 1], img.data[i + 2]] });
      }
    }
  }
  return { ok: bad === 0, bad, first, pixels: img.width * img.height };
}

/** The k rule: k0 covers the height, raised until the scene fills the room beside the column, at most kMax. */
function ruleK(Wd, Hd, reachDev) {
  const k0 = Math.max(2, Math.ceil(Hd / 64));
  const kMax = Math.max(k0, Math.floor(Hd / 57.6));
  return Math.max(k0, Math.min(Math.ceil((Wd - reachDev) / 64), kMax));
}

async function lookPage(browser, opts, [w, h, dpr, theme, [hh, mm], wx], side) {
  const name = `${w}x${h}@${dpr}-${side}`;
  await check(`look ${w}x${h}@${dpr}, column ${side}${theme ? `, ${theme}` : ', auto'} at ${hh}:${String(mm).padStart(2, '0')}: crisp k x k blocks with pcd-bleed's k, the scene flush on the far side, nothing clipped, the column above the taskbar, text >= ${MIN_CONTRAST}:1`, async () => {
    await browser.setWeatherMode({ mode: 'mock', overrides: wx });
    // both formats at every size, whatever the build's config: right in °C and 24 h, left in °F and 12 h
    const q = `?city=Berlin&side=${side}&units=${side === 'right' ? 'C' : 'F'}&clock24=${side === 'right' ? 1 : 0}${theme ? `&theme=${theme}` : ''}`;
    const p = await openPage(browser, { query: q, width: w, height: h, dpr, init: [clockAt(hh, mm)], label: `look ${name}` });
    try {
      await p.waitFor(weatherOk, { timeoutMs: 15000 });
      await sleep(1600); // the dimming re-reads every 15 frames and the bands ease: let them settle
      // freeze on a frame with the colon lit (it blinks at 1 Hz), then pause: nothing paints until the resume
      await p.waitFor("(() => { const c = document.querySelector('.pcd-colon'); return !c || getComputedStyle(c).visibility !== 'hidden'; })()", { timeoutMs: 3000 });
      await playback(p, true);
      await sleep(150);
      const s = await snap(p);
      const rep = await p.evaluate('window.__pcd.paint()');
      const g = rep.scene;
      // pcd-bleed's own k: PCD.bleed.fit() in the page on the inputs the console gave the layer
      const fit = await p.evaluate(`(() => { const L = window.__pcd.layout();
        const g = PCD.bleed.fit({ cssW: ${w}, cssH: ${h}, dpr: ${dpr}, side: ${JSON.stringify(side)}, cell: { w: L.cell.w, h: L.cell.h }, reach: ${g.reach}, bottomCss: ${s.taskbar} });
        return { k: g.k, scene: g.scene }; })()`);
      const problems = [];

      // k: the page's geometry, PCD.bleed.fit() on the same inputs, and the documented rule
      const reachDev = Math.round(g.reach * dpr);
      const kRule = ruleK(g.Wd, g.Hd, reachDev);
      if (g.k !== s.metrics.k) problems.push(`k ${g.k} vs metrics ${s.metrics.k}`);
      if (g.k !== kRule) problems.push(`k ${g.k}, the k rule gives ${kRule} (reach ${reachDev} device px)`);
      if (!Number.isInteger(g.x) || !Number.isInteger(g.y) || g.size !== 64 * g.k) problems.push(`scene ${JSON.stringify({ x: g.x, y: g.y, size: g.size })}`);
      const croppedRows = Math.round((g.size - g.Hd) / g.k);
      if (g.size > g.Hd && (g.size - g.Hd) / g.size > 0.1 + 1e-9) problems.push(`crops ${(100 * (g.size - g.Hd) / g.size).toFixed(1)} % of the rows (at most 10 %)`);

      // the scene flush on the far side, the band on the column's side
      const W = g.Wd;
      if (g.place !== 'crop') {
        if (side === 'right' && g.x !== 0) problems.push(`column right: the scene starts at ${g.x}, not flush left`);
        if (side === 'left' && g.x + g.size !== W) problems.push(`column left: the scene ends at ${g.x + g.size} of ${W}, not flush right`);
        if (g.edge && g.edge !== side) problems.push(`the band is on the ${g.edge}, the column on the ${side}`);
      }

      // the display shot
      let file = null;
      const shown = await p.screenshot();
      if (opts.shots) {
        file = path.join(opts.out, `wallpaper-${name}.png`);
        writeBytes(file, shown);
      }

      // crisp: the world alone (veil, column and caption hidden)
      await layers(p, ['veil', 'column', 'caption']);
      const worldPng = await p.screenshot();
      const crisp = crispCheck(decodePng(worldPng), rep);
      if (!crisp.ok) problems.push(`${crisp.bad} device px off their k x k block (first ${JSON.stringify(crisp.first)})`);

      // contrast: the background behind the text (column and caption hidden, the veil on), then the text runs
      await layers(p, ['column', 'caption']);
      const bg = decodePng(await p.screenshot());
      await layers(p, []);
      const t = await textRuns(p);
      const measured = t.runs.filter((r) => !DECOR.test(r.text) && r.color).map((r) => ({ ...r, ratio: ratio(lum(...r.color), brightest(bg, dpr, r)) }));
      const low = measured.filter((r) => r.ratio < MIN_CONTRAST).sort((a, b) => a.ratio - b.ratio);
      if (!measured.length) problems.push('no text runs found in the column');
      if (low.length) problems.push(`${low.length} text run(s) under ${MIN_CONTRAST}:1: ${low.slice(0, 4).map((r) => `"${r.text}" ${r.ratio.toFixed(2)}`).join(', ')}`);
      const minRun = measured.length ? Math.min(...measured.map((r) => r.ratio)) : 0;
      let clockRatio = null;
      const cc = hexRgb(t.clockColor);
      if (t.clockBox && cc) {
        clockRatio = ratio(lum(...cc), brightest(bg, dpr, t.clockBox));
        if (clockRatio < MIN_CONTRAST) problems.push(`the big clock ${clockRatio.toFixed(2)}:1`);
      }

      // nothing clipped; the column and its text above the taskbar band
      const limitY = h - s.taskbar;
      const out = t.parts.filter((r) => r.x < -0.5 || r.y < -0.5 || r.x + r.w > w + 0.5 || r.y + r.h > h + 0.5);
      const low2 = t.parts.filter((r) => r.y + r.h > limitY + 0.5);
      if (out.length) problems.push(`clipped: ${out.slice(0, 3).map((r) => `${r.cls} ${JSON.stringify([r.x, r.y, r.w, r.h].map((v) => +v.toFixed(1)))}`).join('; ')}`);
      if (low2.length) problems.push(`in the taskbar band (below ${limitY}): ${low2.slice(0, 3).map((r) => `${r.cls} bottom ${(r.y + r.h).toFixed(1)}`).join('; ')}`);
      const col = s.regions.column;
      const cw = s.regions.cell.w;
      if (side === 'right' && col.x + col.w < w - 6 * cw) problems.push(`column right ends at ${col.x + col.w} of ${w}`);
      if (side === 'left' && col.x > 6 * cw) problems.push(`column left starts at ${col.x}`);
      const cap = s.regions.caption;
      if (!cap) problems.push('no caption');
      else if (side === 'right' ? cap.x + cap.w < w - 6 * cw : cap.x > 6 * cw) problems.push(`the caption ${JSON.stringify([cap.x, cap.y, cap.w])} is not in the column's corner`);
      const capText = await p.evaluate(CAPTION_TEXT);
      if (!/^[a-z' .]+ · ([a-z]+ · )?(dawn|day|sunset|night)$/.test(capText.trim())) problems.push(`caption "${capText.trim()}"`);
      if (fit.k !== g.k || JSON.stringify(fit.scene) !== JSON.stringify({ x: g.x, y: g.y, size: g.size })) problems.push(`PCD.bleed.fit() in the page gives k ${fit.k}, scene ${JSON.stringify(fit.scene)}`);
      const errs = s.stats.errorCount + p.errors.length;
      if (errs) problems.push(`${errs} error(s)`);

      numbers.look = numbers.look || {};
      numbers.look[name] = {
        k: g.k, scene: { x: g.x, y: g.y, size: g.size }, cropRows: Math.max(0, croppedRows), place: g.place, edge: g.edge,
        font: s.layout.font.px, cell: [s.layout.cell.w, s.layout.cell.h], column: [col.x, col.y, col.w, col.h], plan: s.layout.plan,
        minContrast: +minRun.toFixed(2), clockContrast: clockRatio === null ? null : +clockRatio.toFixed(2), runs: measured.length,
        crisp: crisp.ok ? crisp.pixels : -crisp.bad, theme: s.scene.id, phase: s.scene.phase,
      };
      must(!problems.length, problems.join('; '));
      return `k ${g.k} (rule ${kRule}, PCD.bleed.fit ${fit.k}), scene ${g.size} px at ${g.x},${g.y} (${g.place}${croppedRows > 0 ? `, ${croppedRows} rows cropped` : ''}), font ${s.layout.font.px} px, column ${col.cols} cells at x ${col.x}; ${crisp.pixels} device px crisp; ${measured.length} text runs >= ${minRun.toFixed(2)}:1, clock ${clockRatio === null ? '-' : clockRatio.toFixed(2)}:1; caption "${capText.trim()}"${file ? '; ' + relShot(file) : ''}`;
    } finally {
      await closePage(p);
      await browser.setWeatherMode('mock');
    }
  });
}

async function look(browsers, opts) {
  for (const size of LOOK_SIZES) {
    const browser = size[2] === 2 ? browsers.dpr2 : browsers.dpr1;
    for (const side of ['right', 'left']) await lookPage(browser, opts, size, side);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// soak: the memory soak (10 minutes, heap growth under 10 %). The page
// runs at 30 fps with rain in the scene; every 30 s cycle it lives a little (a surprise, the column flipped to the left
// and back, a Lively pause and resume, the Theme dropdown back to auto) and is back in the same state when the next
// sample is taken: the JS heap after a forced collection (CDP HeapProfiler.collectGarbage, Runtime.getHeapUsage) and
// the DOM counters (Memory.getDOMCounters). Before the clock starts, every theme is shown once (a theme's code is
// compiled the first time it runs: a surprise landing on a new theme during the soak would otherwise read as growth).
// Samples run through a warm-up (V8 keeps optimizing for minutes, so early growth says nothing) and then the soak; the
// gate is the growth from the first soak sample to the last one.

/** The mocked forecast's current weather during the soak: moderate rain (WMO 63, 2.4 mm/h): drops in the scene. */
const SOAK_RAIN = Object.freeze({ weather_code: 63, precipitation: 2.4, cloud_cover: 100 });
/** What each 30 s cycle does, in seconds after its sample (the state is back to the sample's state by the next one). */
const SOAK_CYCLE = Object.freeze([
  [2, 'surprise', "livelyPropertyListener('surprise', true)"],
  [8, 'column left', "livelyPropertyListener('side', 1)"],
  [14, 'column right', "livelyPropertyListener('side', 0)"],
  [18, 'pause', "livelyWallpaperPlaybackChanged('{\"IsPaused\":true}')"],
  [20, 'resume', "livelyWallpaperPlaybackChanged('{\"IsPaused\":false}')"],
  [22, 'theme auto', "livelyPropertyListener('theme', 0)"],
]);

async function heapUsed(page) {
  try { await page.send('HeapProfiler.collectGarbage'); } catch { /* optional */ }
  const r = await page.send('Runtime.getHeapUsage');
  return r.usedSize;
}

async function domCounters(page) {
  try { return await page.send('Memory.getDOMCounters'); } catch { return null; }
}

/** One soak sample: the heap after a forced collection, the DOM counters and the app's counters. */
async function soakSample(page, t0, phase) {
  const heap = await heapUsed(page);
  const dom = await domCounters(page);
  const s = await page.evaluate(`(() => { const l = __pcd.loop(); const st = __pcd.stats(); const p = __tt.pending();
    return { frames: l.frames, steps: l.steps, errors: st.errorCount, theme: __pcd.scene().id, side: __pcd.state().side,
      pendingTimers: p.timeouts + p.intervals, pendingRafs: p.rafs }; })()`);
  return { t: Math.round((Date.now() - t0) / 1000), phase, heapKB: +(heap / 1024).toFixed(1), nodes: dom ? dom.nodes : null, listeners: dom ? dom.jsEventListeners : null, ...s };
}

/** Least-squares slope of the heap (KB) over time (minutes). */
function slopeKBperMin(samples) {
  if (samples.length < 2) return 0;
  const xs = samples.map((s) => s.t / 60);
  const ys = samples.map((s) => s.heapKB);
  const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
  const my = ys.reduce((a, b) => a + b, 0) / ys.length;
  let num = 0;
  let den = 0;
  for (let i = 0; i < xs.length; i++) { num += (xs[i] - mx) * (ys[i] - my); den += (xs[i] - mx) ** 2; }
  return den ? num / den : 0;
}

/** The soak's summary: growth from the first soak sample to the last, the warm-up's growth, slope, DOM ranges. */
function soakResult(samples) {
  const soak = samples.filter((s) => s.phase === 'soak');
  const base = soak[0];
  const last = soak[soak.length - 1];
  const first = samples[0];
  const range = (k) => [Math.min(...soak.map((s) => s[k])), Math.max(...soak.map((s) => s[k]))];
  return {
    base, last, growth: (last.heapKB - base.heapKB) / base.heapKB,
    peak: (Math.max(...soak.map((s) => s.heapKB)) - base.heapKB) / base.heapKB,
    warmGrowth: base === first ? null : (base.heapKB - first.heapKB) / first.heapKB,
    slope: slopeKBperMin(soak), maxKB: Math.max(...soak.map((s) => s.heapKB)),
    nodes: range('nodes'), listeners: range('listeners'), pendingTimers: range('pendingTimers'),
  };
}

async function soakRun(browser, opts, { menuSize }) {
  const { soak: seconds, warmup } = opts;
  const name = `memory soak: every theme once, ${warmup} s warm-up then ${seconds} s at 30 fps with rain in the scene (a surprise, the column flipped and back, a pause and a resume every 30 s), JS heap after a forced GC every 30 s: growth under ${SOAK.maxGrowth * 100} %`;
  await check(name, async () => {
    await browser.setWeatherMode({ mode: 'mock', overrides: SOAK_RAIN });
    const page = await openPage(browser, { query: '?city=Berlin', label: 'soak 1280x800@2' });
    try {
      await page.waitFor(weatherOk, { timeoutMs: 15000 });
      await sleep(1500);
      const s0 = await snap(page);
      must(s0.scene.fx === true, `no weather effect in the scene (fx ${s0.scene.fx})`);
      // the theme tour: every theme of the Theme dropdown for 3.5 s (its cross-fade included), then Auto again
      for (let i = 1; i < menuSize; i++) {
        await prop(page, 'theme', i);
        await sleep(3500);
      }
      await prop(page, 'theme', 0);
      await sleep(2000);
      const t0 = Date.now();
      const f0 = (await loopStats(page)).frames;
      const samples = [];
      const total = warmup + seconds;
      for (let k = 0; ; k++) {
        const due = t0 + k * SOAK.sampleMs;
        if (due - Date.now() > 0) await sleep(due - Date.now());
        const t = (Date.now() - t0) / 1000;
        const sample = await soakSample(page, t0, t < warmup - 1 ? 'warmup' : 'soak');
        samples.push(sample);
        console.log(`      soak ${sample.t} s (${sample.phase}): heap ${sample.heapKB} KB, nodes ${sample.nodes}, listeners ${sample.listeners}, timers ${sample.pendingTimers}, theme ${sample.theme}, side ${sample.side}, frames ${sample.frames}`);
        if (t >= total - 1) break;
        for (const [at, , js] of SOAK_CYCLE) {
          const when = due + at * 1000;
          if (when - Date.now() > 0) await sleep(when - Date.now());
          await call(page, js);
        }
      }
      const s1 = await snap(page);
      const fps = (s1.loop.frames - f0) * 1000 / (Date.now() - t0);
      const r = soakResult(samples);
      numbers.soak = {
        warmup, seconds, fps: +fps.toFixed(2), growthPct: +(r.growth * 100).toFixed(2), peakPct: +(r.peak * 100).toFixed(2),
        warmupGrowthPct: r.warmGrowth === null ? null : +(r.warmGrowth * 100).toFixed(2), slopeKBperMin: +r.slope.toFixed(2),
        baseKB: r.base.heapKB, lastKB: r.last.heapKB, maxKB: r.maxKB, nodes: r.nodes, listeners: r.listeners, pendingTimers: r.pendingTimers,
        errors: s1.stats.errorCount, surprises: s1.stats.surprises, pauses: s1.stats.pauses, samples,
      };
      must(s1.stats.errorCount === 0, `app errors: ${s1.stats.errors.join('; ')}`);
      must(r.nodes[1] - r.nodes[0] < SOAK.maxNodeSpread, `DOM nodes ${r.nodes.join('-')}`);
      must(r.listeners[1] === r.listeners[0], `JS event listeners ${r.listeners.join('-')}`);
      must(r.pendingTimers[1] <= 6, `pending timers up to ${r.pendingTimers[1]}`);
      must(s1.stats.surprises >= Math.floor(total / 30) - 1, `${s1.stats.surprises} surprises (the cycle did not run)`);
      return {
        pass: r.growth < SOAK.maxGrowth,
        detail: `heap ${r.base.heapKB} KB at ${r.base.t} s -> ${r.last.heapKB} KB at ${r.last.t} s (${(r.growth * 100).toFixed(1)} %; peak +${(r.peak * 100).toFixed(1)} %, slope ${r.slope.toFixed(1)} KB/min); ` +
          `warm-up ${r.warmGrowth === null ? 'none' : (r.warmGrowth * 100).toFixed(1) + ' %'}; ${fps.toFixed(1)} fps; DOM nodes ${r.nodes.join('-')}, listeners ${r.listeners.join('-')}; ` +
          `${s1.stats.surprises} surprises, ${s1.stats.pauses.lively} pauses; ${samples.length} samples`,
      };
    } finally {
      await closePage(page);
      await browser.setWeatherMode('mock');
    }
  });
}

// ---------------------------------------------------------------------------------------------------------------

function networkAndPrivacy(browsers) {
  record('network: only 127.0.0.1 and Open-Meteo (mocked), never the clock\'s host or any other host',
    network.every((r) => { try { return ALLOWED_HOSTS.includes(new URL(r.url).hostname) || r.url.startsWith('data:'); } catch { return false; } }),
    (() => {
      const bad = network.filter((r) => { try { return !ALLOWED_HOSTS.includes(new URL(r.url).hostname) && !r.url.startsWith('data:'); } catch { return true; } });
      const om = network.filter((r) => /open-meteo\.com/.test(r.url)).length;
      return bad.length ? bad.map((r) => `${r.page}: ${r.url}`).join('\n') : `${network.length} requests: ${network.length - om} to 127.0.0.1, ${om} to Open-Meteo`;
    })());
  const all = Object.values(browsers).filter(Boolean);
  const reqs = all.flatMap((b) => b.weatherRequests);
  const violations = all.reduce((n, b) => n + b.violations.length, 0);
  record('privacy: 0 guard violations, every Open-Meteo request mocked (the configured city never requested)',
    violations === 0 && reqs.every((r) => r.action === 'mocked'),
    `guard ${all.every((b) => b.privacy.active) ? 'active' : 'inactive'}; ${violations} blocked; ${reqs.length} Open-Meteo request(s), ${reqs.filter((r) => r.action === 'mocked').length} mocked`);
  record('zero console errors and exceptions (all pages; app errorCount 0)', allErrors.length === 0, allErrors.length ? allErrors.join('\n') : `${rows.length} checks across ${pageLoads} page loads`);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(path.join(PKG, 'index.html'))) throw new Error('dist/wallpaper is not built: run node tools/build.mjs --no-sync wallpaper');
  if (!findBrowser()) throw new Error('no Chrome or Edge found');
  if (opts.shots) {
    // only the shots this run writes again: the look's matrix, the simulation's debug overlay (a soak writes none)
    ensureDir(opts.out);
    const stale = [opts.only.has('look') && /^wallpaper-\d+x\d+@[\d.]+-(left|right)\.png$/, opts.only.has('sim') && /^wallpaper-debug-.*\.png$/].filter(Boolean);
    for (const f of fs.readdirSync(opts.out)) if (stale.some((re) => re.test(f))) fs.rmSync(path.join(opts.out, f), { force: true });
  }
  const model = loadModel(ROOT);
  const props = JSON.parse(fs.readFileSync(path.join(PKG, 'LivelyProperties.json'), 'utf8'));
  const menuIds = model.menu.map((t) => t.id);
  const idx = (id) => menuIds.indexOf(id);

  const browsers = { dpr1: null, dpr2: null };
  browsers.dpr1 = await launch({ windowSize: [1280, 800], weather: 'mock' });
  console.log(`test-wallpaper: ${browsers.dpr1.version.product}, serving ${PKG} on 127.0.0.1 (one port and one window per page), time zone ${TIMEZONE}; privacy guard ${browsers.dpr1.privacy.active ? 'active' : 'inactive'}, Open-Meteo ${browsers.dpr1.weatherMode}; sections ${[...opts.only].join(', ')}`);
  try {
    if (opts.only.has('sim')) await simulation(browsers.dpr1, opts, { model, props, idx });
    if (opts.only.has('look')) {
      // a 1280x800 laptop at 200 %, its real scale factor 2 (an emulated ratio measures cells a little differently)
      browsers.dpr2 = await launch({ windowSize: [1280, 800], weather: 'mock', deviceScaleFactor: 2 });
      await look(browsers, opts);
    }
    if (opts.only.has('soak')) await soakRun(browsers.dpr1, opts, { menuSize: menuIds.length });
    await closeLeftovers(); // their errors count below
    networkAndPrivacy(browsers);
  } finally {
    await closeLeftovers();
    for (const b of Object.values(browsers)) if (b) await b.close();
  }
  finish();
}

main().catch((e) => {
  console.error('test-wallpaper: ' + (e && e.stack ? e.stack : e));
  process.exitCode = 1;
});
