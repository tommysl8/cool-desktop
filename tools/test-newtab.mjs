#!/usr/bin/env node
// node tools/test-newtab.mjs [--dist <folder>] [--shots <folder>] [--quick] [--only load,motion,scene,weather,status,terminal,sheet,focus,paint,shots]
//
// The checks for the real new tab (the scene and the console column), in the installed Chrome,
// headless, through tools/lib/chrome.mjs only: a fresh temporary profile (deleted afterwards; your own profile is
// never used), ONE merged --host-resolver-rules flag (every host but 127.0.0.1, localhost and the Open-Meteo hosts is
// unresolvable, so links, searches and addresses opened here never leave this machine), Open-Meteo answered with
// canned Berlin JSON (weather: 'mock'; the privacy guard fails any request naming the configured city), and
// pixelclock.local mapped to tools/mock-clock.mjs on 127.0.0.1 (never the real clock).
// The extension is built by tools/build.mjs's plugin into a temp folder with config/user.example.json (Berlin, the
// sample links), so nothing personal reaches a page, a log or a screenshot; --dist <folder> loads a built one instead.
//
// Sections (all by default):
//   load      Extensions.loadUnpacked, the id; chrome://newtab/ redirects ONCE to newtab.html?focus (two main-frame
//             documents, no loop) and the terminal's prompt has the keys; zero exceptions, console errors and CSP
//             violations; data-ready; settings from chrome.storage.sync; today's theme (auto) and the scene clock off;
//             two warm opens whose first frame already has the final layout (the forecast, the clock line's row, and
//             links and the weather in the scene that differ from the config), so nothing moves in any later frame.
//   motion   30 engine steps a second at 30 fps +-10 %; performance on -> 15 fps (steps still 30 a second); battery
//             discharging with performance auto -> 15 fps; reduced motion -> no loop (a still frame; a shake plays 4 s
//             at 15 fps); a hidden tab -> no animation frame and no timer firing (a wrapped setTimeout/setInterval/rAF
//             counts them), back when visible.
//   scene     shake by a click on the scene and by the terminal's shake; surprise (terminal); the theme override
//             (settings, then "theme snowy hills" in the terminal) and back to auto; injected dates (?at=): 2026-10-31
//             21:00 halloween, 2026-12-24 23:00 christmas, 2026-11-26 13:00 thanksgiving, 2026-07-15 12:00 summer,
//             with the greeting of each (PCD.greet's rule).
//   weather   the mock: the block and its credit; offline (CDP network emulation): no block, no error text; HTTP 400:
//             no block.
//   status    every fixture of tools/mock-clock.mjs: the console's line, ringing (accent, the 2 Hz pulse),
//             the line gone after two failures; only GET /api/status ever reaches the clock.
//   terminal  through the real page: typing anywhere focuses the prompt; a digit previews its link; 1-9 + Enter opens
//             it here, Ctrl+Enter in a new tab; an address opens; text searches with chrome.search.query; Tab
//             completes; Up recalls; Esc clears; help; clock 12|24 and theme persist; Ctrl/Alt/Meta never prevented.
//   sheet     "≡ settings" and the terminal's settings command open the sheet over the column (regions().sheet), its
//             box lines are text, a focus row; Esc closes it and the terminal has the keys again; a change reaches
//             chrome.storage.sync and the console (links) live; the mirror for boot.js.
//   focus     focusTerminal off (the sheet): the next tab does not redirect (one document); on again: it does.
//   paint     first paint: FCP <= 100 ms, first scene frame <= 150 ms, data-ready <= 300 ms, best of 7 opens, in
//             a browser of its own once the sections above are done (a shared machine: timing checks take the best).
//   shots     1280x620@2 (a 1280x620 Chrome window at 200 %), 1280x800@2, 1920x969@1, 2560x1329@1, 3840x2049@1 and
//             800x500@1: every visible scene pixel a uniform k x k block of the canvas colour, zero errors; PNGs to
//             look at (wip/shots/newtab).
// Prints a PASS/FAIL table; exit code 1 on any FAIL. Node built-ins only.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { findBrowser, launch } from './lib/chrome.mjs';
import { decodePng, pngSize } from './lib/png.mjs';
import { printReport } from './lib/report.mjs';
import { serve } from './lib/serve.mjs';
import { sleep } from './lib/fsx.mjs';
import { loadFixtures, startMockClock, FIXTURES } from './mock-clock.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const require = createRequire(import.meta.url);
const argv = process.argv.slice(2);
const argOf = (flag) => {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : null;
};
const SECTIONS = ['load', 'motion', 'scene', 'weather', 'status', 'terminal', 'sheet', 'focus', 'paint', 'shots'];
const ONLY = argOf('--only') ? argOf('--only').split(',').map((s) => s.trim()).filter(Boolean) : null;
const QUICK = argv.includes('--quick');
const want = (s) => (ONLY ? ONLY.includes(s) : !(QUICK && (s === 'paint' || s === 'shots')));
const SHOTS = path.resolve(argOf('--shots') || path.join(ROOT, 'wip', 'shots', 'newtab'));
const ID_FILE = path.join(ROOT, 'src', 'newtab', 'EXTENSION_ID.txt');
const EXAMPLE = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'user.example.json'), 'utf8'));
const ST = require(path.join(ROOT, 'src', 'newtab', 'js', 'ntp-status.js'));
const RAW = loadFixtures();
/** The console's terminal input (the console's only <input>; the sheet's inputs live in its dialog). */
const TERM_INPUT = '#console input';

/** No absolute path with a user name in a report line: the repo, the temp folder and the home folder are shortened. */
const SHORT = [[ROOT, '<repo>'], [os.tmpdir(), '%TEMP%'], [os.homedir(), '~']]
  .flatMap(([p, to]) => [[pathToFileURL(p).href, to], [p, to], [p.replace(/\\/g, '/'), to]]);
const scrub = (s) => SHORT.reduce((t, [from, to]) => t.split(from).join(to), String(s));

const rows = [];
function check(name, pass, detail = '', { warn = false } = {}) {
  detail = scrub(detail);
  rows.push({ name, pass: pass === null ? null : !!pass, skip: pass === null, warn, detail });
  const tag = pass === null ? 'SKIP' : !pass ? 'FAIL' : warn ? 'WARN' : 'PASS';
  console.log(`${tag}  ${name}${detail ? '  (' + String(detail).replace(/\s+/g, ' ').slice(0, 260) + ')' : ''}`);
  return !!pass;
}
const errText = (errs) => errs.map((e) => `${e.type}: ${e.text}`).join(' | ');
/** Chrome's own network line when a lookup fails (the clock off, a link with no route here) is not the page's error. */
const pageErrors = (page) => page.errors.filter((e) => !(e.type === 'log.network'));
const median = (xs) => {
  const s = xs.filter(Number.isFinite).sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : NaN;
};

// ------------------------------------------------------------------------------------------------ the build

async function buildExample(tmp) {
  const B = await import(new URL('./build.mjs', import.meta.url).href);
  const NB = await import(new URL('./build/newtab.mjs', import.meta.url).href);
  const dist = path.join(tmp, 'dist');
  const gen = await B.generateStage({ root: ROOT, config: EXAMPLE, vendor: path.join(ROOT, 'vendor', 'pixelclock') });
  const ctx = B.createContext({ root: ROOT, dist, config: EXAMPLE, tokens: gen.tokens, anchors: gen.anchors, generated: gen.generated, render: false, piece: 'newtab', log: () => {} });
  await NB.build(ctx);
  return path.join(dist, NB.OUT);
}

// ------------------------------------------------------------------------------------------------ input

const MODS = { alt: 1, ctrl: 2, meta: 4, shift: 8 };
const KEYS = {
  Enter: { key: 'Enter', code: 'Enter', vk: 13, text: '\r' },
  Escape: { key: 'Escape', code: 'Escape', vk: 27 },
  Tab: { key: 'Tab', code: 'Tab', vk: 9 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', vk: 38 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', vk: 39 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', vk: 37 },
  Backspace: { key: 'Backspace', code: 'Backspace', vk: 8 },
};
for (const ch of 'abdklxz') KEYS[ch] = { key: ch, code: `Key${ch.toUpperCase()}`, vk: ch.toUpperCase().charCodeAt(0), text: ch };
for (const d of '0123456789') KEYS[d] = { key: d, code: `Digit${d}`, vk: 48 + Number(d), text: d };

/** A real key press: rawKeyDown, char for printable keys without Ctrl/Alt/Meta, keyUp. */
async function press(page, name, mods = []) {
  const k = KEYS[name];
  const modifiers = mods.reduce((m, x) => m | MODS[x], 0);
  const base = { key: k.key, code: k.code, windowsVirtualKeyCode: k.vk, nativeVirtualKeyCode: k.vk, modifiers };
  await page.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base });
  if (k.text && !(modifiers & (MODS.ctrl | MODS.alt | MODS.meta))) await page.send('Input.dispatchKeyEvent', { type: 'char', ...base, text: k.text, unmodifiedText: k.text });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
}

/** Type into the focused element: Input.insertText fires input events like typing. */
const type = (page, text) => page.send('Input.insertText', { text });

async function click(page, x, y) {
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
}

/** Whether the page prevented the default of one key press (a window bubble listener sees the final state). */
async function keyPrevented(page, name, mods) {
  await page.evaluate(() => {
    window.__keyLog = [];
    if (!window.__keyLogOn) {
      window.__keyLogOn = true;
      window.addEventListener('keydown', (e) => window.__keyLog.push({ key: e.key, prevented: e.defaultPrevented }));
    }
  });
  await press(page, name, mods);
  await sleep(40);
  const log = await page.evaluate('window.__keyLog');
  return log.length ? log[0].prevented : null;
}

// ------------------------------------------------------------------------------------------------ pages

/** Wraps setTimeout, setInterval and requestAnimationFrame from the first script on: what fires, and when. */
const TRACKER = `(() => {
  const T = window.__track = { raf: 0, fired: [], intervals: 0, armed: [] };
  const st = window.setTimeout.bind(window), si = window.setInterval.bind(window), ra = window.requestAnimationFrame.bind(window);
  window.setTimeout = function (fn, ms, ...a) {
    const set = performance.now(), d = Number(ms) || 0;
    T.armed.push({ at: set, ms: d });
    if (T.armed.length > 4000) T.armed.splice(0, 2000);
    return st(function () { T.fired.push({ at: performance.now(), ms: d }); if (T.fired.length > 4000) T.fired.splice(0, 2000); if (typeof fn === 'function') return fn.apply(this, arguments); }, ms, ...a);
  };
  window.setInterval = function (fn, ms, ...a) { T.intervals++; return si(fn, ms, ...a); };
  window.requestAnimationFrame = function (fn) { return ra(function (t) { T.raf++; T.rafAt = performance.now(); return fn(t); }); };
})();`;

/** At data-ready (a MutationObserver: the same task that sets it, so the first frame with the column's text), the
 *  prompt's top, the column's plan of rows, its lines and whether the weather effect is on; then, for 2 s, every
 *  animation frame whose prompt, rows, links or weather effect differ from the frame before (window.__moves). The
 *  script runs before the document has its <html> element, so it watches the document's subtree. */
const AT_READY = `(() => {
  const snap = () => {
    const i = document.querySelector(${JSON.stringify(TERM_INPUT)});
    return { top: i ? i.getBoundingClientRect().top : null, plan: JSON.stringify(window.__pcd.console().plan), lines: window.__pcd.lines(),
      fx: !!(window.PCD && window.PCD.hook && window.PCD.hook.before) };
  };
  const mo = new MutationObserver(() => {
    const h = document.documentElement;
    if (!h || h.getAttribute('data-ready') !== '1' || window.__atReady) return;
    mo.disconnect();
    const first = window.__atReady = snap();
    const moves = window.__moves = [];
    const t0 = performance.now();
    let last = first;
    const tick = () => {
      const s = snap();
      if (s.top !== last.top || s.plan !== last.plan || s.lines.links !== last.lines.links || s.fx !== last.fx) {
        moves.push({ ms: Math.round(performance.now() - t0), top: s.top, links: s.lines.links, fx: s.fx, plan: s.plan === last.plan ? 'same' : s.plan });
      }
      last = s;
      if (performance.now() - t0 < 2000) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  mo.observe(document, { attributes: true, subtree: true, attributeFilter: ['data-ready'] });
})();`;

/** Mains power for the frame-rate checks: performance 'auto' runs 15 fps on battery, as it should. */
const AC_POWER = 'navigator.getBattery = () => Promise.resolve({ charging: true, level: 1, addEventListener() {}, removeEventListener() {} });';

/** Wrap chrome.search.query and chrome.tabs.create: calls go to window.__spy and are NOT made. */
async function spyChrome(page) {
  return page.evaluate(() => {
    window.__spy = [];
    const wrap = (obj, name, api) => {
      const fn = function (...args) {
        window.__spy.push({ api, args: JSON.parse(JSON.stringify(args)) });
        return Promise.resolve();
      };
      try { obj[name] = fn; } catch (e) { /* read-only: defineProperty below */ }
      if (obj[name] !== fn) Object.defineProperty(obj, name, { value: fn, configurable: true, writable: true });
      return obj[name] === fn;
    };
    return wrap(chrome.search, 'query', 'search.query') && wrap(chrome.tabs, 'create', 'tabs.create');
  });
}

/**
 * Open `url` (default chrome://newtab/) in `page` and wait until the new tab is ready (data-ready) in the document that
 * stays. Resolves { navs: [main-frame URLs], url, t: ms from navigate to ready }.
 */
async function openTab(page, url = 'chrome://newtab/', { focus = true, timeoutMs = 20000 } = {}) {
  page.errors.length = 0;
  const navs = [];
  const off = page.on('Page.frameNavigated', (p) => { if (!p.frame.parentId) navs.push(p.frame.url); });
  const t0 = Date.now();
  await page.send('Page.navigate', { url });
  const where = focus ? "/[?&]focus(=|&|$)/.test(location.search)" : "!/[?&]focus(=|&|$)/.test(location.search)";
  try {
    await page.waitFor(`document.documentElement.dataset.ready === '1' && ${where}`, { timeoutMs, intervalMs: 50 });
  } finally {
    await sleep(150); // a redirect that should not happen would show up in navs now
    off();
  }
  return { navs, url: await page.evaluate('location.href'), t: Date.now() - t0 };
}

/** Run a line in the terminal as typed: focus the prompt, type, Enter (mods: ['ctrl'] for a new tab). */
async function termRun(page, line, mods = []) {
  await page.evaluate((sel) => { const i = document.querySelector(sel); i.focus(); i.value = ''; i.dispatchEvent(new Event('input')); }, TERM_INPUT);
  await type(page, line);
  await press(page, 'Enter', mods);
  await sleep(200);
}

async function extensionPage(browser, id, url) {
  const page = await browser.newPage('about:blank');
  await page.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await page.send('Page.addScriptToEvaluateOnNewDocument', { source: TRACKER });
  if (url) await openTab(page, url);
  return page;
}

/** Settings through the extension's own storage (chrome.storage.sync item "settings", v1 overrides). */
const setSettings = (page, overrides) => page.evaluate((o) => chrome.storage.sync.set({ settings: Object.assign({ v: 1 }, o) }), overrides);

/** Frames and steps a second over the best of n windows of ms each (best = closest to the target fps). */
async function rate(page, target, { ms = 2000, n = 3 } = {}) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const a = await page.evaluate('__pcd.scene()');
    await sleep(ms);
    const b = await page.evaluate('__pcd.scene()');
    out.push({ fps: ((b.frames - a.frames) * 1000) / ms, steps: ((b.steps - a.steps) * 1000) / ms, p95: b.p95 });
  }
  out.sort((x, y) => Math.abs(x.fps - target) - Math.abs(y.fps - target));
  return { best: out[0], all: out };
}

/** Make `page` hidden by activating another tab (focus emulation off first); returns the visibilityState. */
async function hide(browser, page, other) {
  await page.send('Emulation.setFocusEmulationEnabled', { enabled: false });
  await browser.send('Target.activateTarget', { targetId: other.targetId });
  for (let i = 0; i < 20; i++) {
    if ((await page.evaluate('document.visibilityState')) === 'hidden') return 'hidden';
    await sleep(100);
  }
  return page.evaluate('document.visibilityState');
}

async function show(browser, page) {
  await browser.send('Target.activateTarget', { targetId: page.targetId });
  await page.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  for (let i = 0; i < 20; i++) {
    if ((await page.evaluate('document.visibilityState')) === 'visible') return 'visible';
    await sleep(100);
  }
  return page.evaluate('document.visibilityState');
}

async function targetUrl(browser, page) {
  const r = await browser.send('Target.getTargetInfo', { targetId: page.targetId });
  return r.targetInfo.url;
}

async function waitUrl(browser, page, test, timeoutMs = 8000) {
  const end = Date.now() + timeoutMs;
  let url = '';
  while (Date.now() < end) {
    url = await targetUrl(browser, page);
    if (test(url)) return url;
    await sleep(100);
  }
  return url;
}

/** A point on the scene that the column, the bottom row and the screen edge leave free (CSS px). */
async function scenePoint(page) {
  return page.evaluate(() => {
    const m = __pcd.scene().rect;
    const x = Math.min(innerWidth - 10, (m.x + m.size * 0.75) / m.dpr);
    const y = Math.min(innerHeight * 0.4, (m.y + m.size * 0.4) / m.dpr);
    return { x: Math.round(x), y: Math.round(y) };
  });
}

// ------------------------------------------------------------------------------------------------ crisp blocks

/**
 * The scene alone (everything else hidden for the capture, under reduced motion so no frame lands meanwhile): every
 * k x k block of device pixels that lies fully in the screenshot is uniform and equals the canvas pixel.
 */
async function crispCheck(page, label, file) {
  await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await page.waitFor('__pcd.state().reduced === true', { timeoutMs: 3000 });
  await sleep(300);
  const before = await page.evaluate('__pcd.scene()');
  const px = await page.evaluate('__pcd.pixels()');
  await page.evaluate(() => {
    const cv = [...document.querySelectorAll('#console canvas')].find((c) => c.width === 64 && c.height === 64);
    const keep = new Set();
    for (let e = cv; e; e = e.parentElement) keep.add(e);
    window.__crispHidden = [];
    for (const e of document.querySelectorAll('body *')) {
      if (keep.has(e)) continue;
      window.__crispHidden.push([e, e.style.visibility]);
      e.style.visibility = 'hidden';
    }
  });
  const shot = await page.screenshot();
  await page.evaluate(() => { for (const [e, v] of window.__crispHidden) e.style.visibility = v; });
  const after = await page.evaluate('__pcd.scene()');
  await page.send('Emulation.setEmulatedMedia', { features: [] });
  const img = decodePng(shot);
  const problems = [];
  if (after.frames !== before.frames) problems.push(`a frame landed during the capture (${before.frames} -> ${after.frames})`);
  if (!(Number.isInteger(px.k) && px.k >= 2)) problems.push(`k ${px.k}`);
  if (px.size !== 64 * px.k) problems.push(`size ${px.size} != 64k`);
  let checked = 0;
  let mixed = 0;
  for (let j = 0; j < 64 && !problems.length; j++) {
    for (let i = 0; i < 64; i++) {
      const x0 = px.x + i * px.k;
      const y0 = px.y + j * px.k;
      if (x0 < 0 || y0 < 0 || x0 + px.k > img.width || y0 + px.k > img.height) continue;
      checked++;
      const w = [px.data[(j * 64 + i) * 4], px.data[(j * 64 + i) * 4 + 1], px.data[(j * 64 + i) * 4 + 2]];
      let bad = false;
      for (let dy = 0; dy < px.k && !bad; dy++) {
        for (let dx = 0; dx < px.k; dx++) {
          const o = ((y0 + dy) * img.width + (x0 + dx)) * 4;
          if (img.data[o] !== w[0] || img.data[o + 1] !== w[1] || img.data[o + 2] !== w[2]) { bad = true; break; }
        }
      }
      if (bad) mixed++;
    }
  }
  if (!checked && !problems.length) problems.push('no whole block inside the screenshot');
  if (mixed) problems.push(`${mixed} of ${checked} visible k x k blocks are not uniform in the canvas colour`);
  const distinct = new Set();
  for (let p = 0; p < 4096; p++) distinct.add((px.data[p * 4] << 16) | (px.data[p * 4 + 1] << 8) | px.data[p * 4 + 2]);
  if (distinct.size < 12) problems.push(`only ${distinct.size} colours in the frame (blank?)`);
  if (file) fs.writeFileSync(file, shot);
  return {
    ok: problems.length === 0,
    k: px.k,
    detail: `${label}: k ${px.k}, scene ${px.size} at ${px.x},${px.y} (device px), ${checked} whole blocks checked, ${distinct.size} colours; ${problems.join('; ') || 'every visible block uniform and equal to the canvas pixel'}`,
  };
}

// ------------------------------------------------------------------------------------------------ sections

async function loadSection(ctx) {
  const { browser, id, expectedId, page } = ctx;
  check('extension id equals src/newtab/EXTENSION_ID.txt (the manifest key)', id === expectedId, `Chrome ${id}; file ${expectedId}`);
  const first = await openTab(page);
  const docs = first.navs.filter((u) => u.startsWith(`chrome-extension://${id}/newtab.html`));
  check('chrome://newtab/ redirects once to newtab.html?focus (focus on by default; two documents, no loop)',
    docs.length === 2 && !/focus/.test(docs[0]) && /\?focus$/.test(docs[1]) && first.url === `chrome-extension://${id}/newtab.html?focus`,
    `${first.navs.join(' -> ')} (${first.t} ms to data-ready)`);
  await sleep(1500);
  const again = await page.evaluate('location.href');
  check('the redirected tab stays put (no second redirect)', again === first.url, again);
  const s = await page.evaluate('__pcd.state()');
  const t = await page.evaluate('__pcd.term()');
  check('the terminal\'s prompt has the keys on load (the page has the focus; the caret blinks)', s.focus.has && t && t.focused && t.caret.blinking,
    `hasFocus ${s.focus.has}; active ${s.focus.active}; term ${JSON.stringify(t && { focused: t.focused, caret: t.caret })}`);
  check('zero exceptions and console errors after load', pageErrors(page).length === 0, errText(pageErrors(page)) || 'none');
  check('no CSP violations (boot.js listener)', Array.isArray(s.csp) && s.csp.length === 0, JSON.stringify(s.csp));
  check('<html data-ready="1">, extension mode, settings from chrome.storage.sync, the terminal mounted', s.ready && s.extension && s.store === 'chrome.storage.sync' && s.term,
    `ready ${s.ready}; extension ${s.extension}; store ${s.store}; term ${s.term}`);
  const sc = await page.evaluate('__pcd.scene()');
  const autoId = await page.evaluate(() => { const d = new Date(); return PCD.engine.autoId(PixelClock, d.getFullYear(), d.getMonth() + 1, d.getDate()); });
  check('the scene is today\'s theme (auto); the scene draws no clock of its own (the column shows it)', sc.id === autoId && sc.tag === 'auto' && sc.hookMode === 'none',
    `${sc.id} (${sc.name}), tag ${sc.tag}, hook mode ${sc.hookMode}`);
  check('whole-number scaling: k >= 2, image-rendering pixelated, 64k device px', Number.isInteger(sc.k) && sc.k >= 2 && sc.rendering === 'pixelated' && sc.rect.size === 64 * sc.k,
    `k ${sc.k}; ${sc.rendering}; ${JSON.stringify(sc.rect)}`);
  const lines = await page.evaluate('__pcd.lines()');
  const settings = await page.evaluate('__pcd.settings()');
  check('the column shows the greeting, the date, the links and the bottom row (the example config: Berlin, 3 links)',
    !!lines.greet && /^good (morning|afternoon|evening|night)/.test(lines.greet) && !!lines.date && settings.city === 'Berlin' &&
    EXAMPLE.shortcuts.every((l, i) => (lines.links || '').includes(`[${i + 1}]`) && (lines.links || '').includes(l.label)) &&
    (lines.hint || '').startsWith('1-' + EXAMPLE.shortcuts.length + ' + enter opens a link'),
    `${lines.greet} | ${lines.date} | ${lines.links} | ${lines.hint} | ${lines.caption}`);

  // a warm open (the mirror holds the last forecast, that a clock line showed and the links): the layout at data-ready
  // is final
  const laterState = `(() => {
    const i = document.querySelector(${JSON.stringify(TERM_INPUT)});
    return { top: i.getBoundingClientRect().top, plan: JSON.stringify(__pcd.console().plan), lines: __pcd.lines(), links: __pcd.links(),
      fx: !!(window.PCD && PCD.hook && PCD.hook.before), mirror: JSON.parse(localStorage.getItem('pcd.mirror')) };
  })()`;
  const moved = (m) => (m && m.length ? m.map((x) => `${x.ms} ms: prompt ${x.top}, links "${x.links}", fx ${x.fx}, rows ${x.plan === 'same' ? 'same' : 'changed'}`).join(' | ') : 'none');
  const hook = await page.send('Page.addScriptToEvaluateOnNewDocument', { source: AT_READY });
  try {
    await openTab(page);
    const at = await page.evaluate('window.__atReady || null');
    await sleep(1500);
    const later = await page.evaluate(laterState);
    const moves = await page.evaluate('window.__moves || null');
    check('a warm open: the prompt and the column\'s rows at data-ready stay put when the weather and the clock line land (1.5 s later, and in every frame)',
      !!at && at.top === later.top && at.plan === later.plan && !!at.lines.weather && !!later.lines.weather && !!later.lines.status &&
      !!later.mirror.wx && later.mirror.st === true && Array.isArray(moves) && moves.length === 0,
      `prompt ${at && at.top} -> ${later.top} px; rows ${at && at.plan === later.plan ? 'equal' : `${at && at.plan} -> ${later.plan}`}; ` +
      `weather at ready ${!!(at && at.lines.weather)}; status at ready ${JSON.stringify(at && at.lines.status)}, later ${JSON.stringify(later.lines.status)}; moves ${moved(moves)}`);

    // links and the weather in the scene from chrome.storage, unlike the config's (a list edited in the sheet): the
    // mirror keeps the links on show and the setting, so the first frame already has them
    const stored = Array.from({ length: 7 }, (_, i) => ({ label: `site${i + 1}`, url: `https://example.org/${i + 1}` }));
    await setSettings(page, { shortcuts: stored, weatherFx: false });
    await page.waitFor("(() => { const m = JSON.parse(localStorage.getItem('pcd.mirror')); return m.weatherFx === false && m.lk.length === 7; })()", { timeoutMs: 5000 }).catch(() => null);
    await openTab(page);
    const at2 = await page.evaluate('window.__atReady || null');
    await sleep(1500);
    const later2 = await page.evaluate(laterState);
    const moves2 = await page.evaluate('window.__moves || null');
    const all7 = (text) => stored.every((l, i) => (text || '').includes(`[${i + 1}] ${l.label}`));
    check('a warm open with 7 stored links and the weather in the scene off (not the config\'s): the first frame has the links and no weather effect, ' +
      'and nothing moves when chrome.storage answers (1.5 s later, and in every frame)',
      !!at2 && all7(at2.lines.links) && at2.fx === false && at2.top === later2.top && at2.plan === later2.plan && at2.lines.links === later2.lines.links &&
      later2.fx === false && later2.links.mirrored === false && later2.links.items.length === 7 && Array.isArray(moves2) && moves2.length === 0 &&
      Array.isArray(later2.mirror.lk) && all7(later2.mirror.lk.map((l, i) => `[${i + 1}] ${l.label}`).join('')) && later2.mirror.weatherFx === false,
      `links at ready "${at2 && at2.lines.links}"; prompt ${at2 && at2.top} -> ${later2.top} px; rows ${at2 && at2.plan === later2.plan ? 'equal' : 'changed'}; ` +
      `weather effect at ready ${at2 && at2.fx}, later ${later2.fx}; link source ${later2.links.source} (${later2.links.items.length}), mirrored ${later2.links.mirrored}; ` +
      `the mirror: ${later2.mirror.lk ? later2.mirror.lk.length : 'no'} links, weatherFx ${later2.mirror.weatherFx}; moves ${moved(moves2)}`);
  } finally {
    await page.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: hook.identifier });
    await setSettings(page, {});
  }
  await page.waitFor(`(() => { const m = JSON.parse(localStorage.getItem('pcd.mirror')); return m.weatherFx === true && m.lk.length === ${EXAMPLE.shortcuts.length}; })()`,
    { timeoutMs: 5000 }).catch(() => null);
}

async function motionSection(ctx) {
  const { browser, page } = ctx;
  // a laptop on battery would (rightly) run performance 'auto' at 15 fps: this page says it is on mains power
  const ac = await page.send('Page.addScriptToEvaluateOnNewDocument', { source: AC_POWER });
  await openTab(page);
  let r = await rate(page, 30);
  check('live scene (on mains power): 30 engine steps a second at 30 fps +-10 % (best of 3 two-second windows)', r.best.fps >= 27 && r.best.fps <= 33 && r.best.steps >= 27 && r.best.steps <= 33,
    `${r.best.fps.toFixed(1)} fps, ${r.best.steps.toFixed(1)} steps/s, p95 ${r.best.p95} ms; windows ${r.all.map((x) => x.fps.toFixed(1)).join(', ')}`);
  await setSettings(page, { performance: 'on' });
  await page.waitFor('__pcd.scene().targetFps === 15', { timeoutMs: 5000 }).catch(() => null);
  r = await rate(page, 15);
  check('performance on: 15 fps +-10 %, still 30 engine steps a second', r.best.fps >= 13.5 && r.best.fps <= 16.5 && r.best.steps >= 27 && r.best.steps <= 33,
    `${r.best.fps.toFixed(1)} fps, ${r.best.steps.toFixed(1)} steps/s; windows ${r.all.map((x) => x.fps.toFixed(1)).join(', ')}`);
  await setSettings(page, {});
  await page.waitFor('__pcd.scene().targetFps === 30', { timeoutMs: 5000 }).catch(() => null);

  // performance auto on battery: navigator.getBattery() says discharging before the page runs
  const bat = await browser.newPage('about:blank');
  await bat.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await bat.send('Page.addScriptToEvaluateOnNewDocument', { source: "navigator.getBattery = () => Promise.resolve({ charging: false, level: 0.5, addEventListener() {}, removeEventListener() {} });" });
  await openTab(bat);
  await bat.waitFor('__pcd.scene().targetFps === 15', { timeoutMs: 5000 }).catch(() => null);
  r = await rate(bat, 15);
  const bs = await bat.evaluate('__pcd.scene()');
  check('performance auto + on battery: 15 fps +-10 %', bs.onBattery && r.best.fps >= 13.5 && r.best.fps <= 16.5, `onBattery ${bs.onBattery}; ${r.best.fps.toFixed(1)} fps; windows ${r.all.map((x) => x.fps.toFixed(1)).join(', ')}`);
  await bat.close();
  await browser.send('Target.activateTarget', { targetId: page.targetId });

  // reduced motion: no loop; a click shakes and plays 4 s at 15 fps, then the scene stops again
  await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await page.waitFor('__pcd.state().reduced === true', { timeoutMs: 3000 });
  await sleep(400);
  const a = await page.evaluate('({ s: __pcd.scene(), t: __pcd.timers() })');
  await sleep(1500);
  const b = await page.evaluate('({ s: __pcd.scene(), t: __pcd.timers(), term: __pcd.term() })');
  // a still frame on a change (the minute, the weather arriving) is allowed: the loop itself must not run
  const moved = b.s.frames - a.s.frames;
  check('reduced motion: no loop (no animated frame for 1.5 s, no frame timer, no animation frame), a steady caret',
    moved <= 1 && b.s.stillFrames - a.s.stillFrames === moved && !b.t.frame && !b.t.raf && b.term.caret.shown && !b.term.caret.blinking,
    `frames +${moved} (still +${b.s.stillFrames - a.s.stillFrames}); timers ${JSON.stringify(b.t)}; caret ${JSON.stringify(b.term.caret)}`);
  const p = await scenePoint(page);
  await click(page, p.x, p.y);
  await sleep(2000);
  const c = await page.evaluate('__pcd.scene()');
  await sleep(2600);
  const d = await page.evaluate('__pcd.scene()');
  await sleep(1000);
  const e = await page.evaluate('__pcd.scene()');
  const burstFps = (c.frames - b.s.frames) / 2;
  check('reduced motion: a shake plays a burst at about 15 fps, then the scene freezes again', c.shakes === b.s.shakes + 1 && burstFps >= 10 && burstFps <= 17 && e.frames === d.frames,
    `shakes +${c.shakes - b.s.shakes}; ${burstFps.toFixed(1)} fps in the first 2 s; frames after the burst +${e.frames - d.frames}`);
  await page.send('Emulation.setEmulatedMedia', { features: [] });
  await page.waitFor('__pcd.state().reduced === false', { timeoutMs: 3000 });

  // hidden: nothing runs
  const other = await browser.newPage('about:blank');
  try {
    const vis = await hide(browser, page, other);
    if (vis !== 'hidden') {
      check('hidden tab: no animation frame and no timer', null, `the page never became hidden in headless Chrome (${vis})`);
    } else {
      await sleep(500);
      const h1 = await page.evaluate('({ now: performance.now(), raf: __track.raf, fired: __track.fired.length, s: __pcd.scene(), t: __pcd.timers(), st: __pcd.status() })');
      await sleep(3000);
      const h2 = await page.evaluate('({ now: performance.now(), raf: __track.raf, fired: __track.fired.slice(-50), n: __track.fired.length, s: __pcd.scene(), t: __pcd.timers(), term: __pcd.term() })');
      const firedHidden = h2.fired.filter((f) => f.at > h1.now);
      const frequent = firedHidden.filter((f) => f.ms < 60000);
      check('hidden tab: no animation frame, no frame, no timer firing (3 s), no pending frame timer or text timer',
        h2.raf === h1.raf && h2.s.frames === h1.s.frames && frequent.length === 0 && !h2.t.frame && !h2.t.raf && !h2.t.text && !h2.term.caret.blinking && h2.s.paused,
        `rAF +${h2.raf - h1.raf}, frames +${h2.s.frames - h1.s.frames}, timers fired ${firedHidden.length} (${firedHidden.map((f) => f.ms).join(', ') || 'none'}), pending ${JSON.stringify(h2.t)}, caret ${JSON.stringify(h2.term.caret)}, reasons ${h2.s.pauseReasons}`);
      // a settings change while hidden (as from another tab): the forecast waits until the tab shows
      const asked = browser.weatherRequests.length;
      await setSettings(page, { units: 'F' });
      await sleep(1500);
      const hiddenAsks = browser.weatherRequests.length - asked;
      check('hidden tab: a units change fetches no forecast while hidden', hiddenAsks === 0, `${hiddenAsks} Open-Meteo requests while hidden`);
      const vis2 = await show(browser, page);
      await sleep(1000);
      const h3 = await page.evaluate('__pcd.scene()');
      check('visible again: the loop runs again (no fast-forward)', vis2 === 'visible' && h3.frames - h2.s.frames >= 15, `${vis2}; frames +${h3.frames - h2.s.frames} in 1 s`);
    }
  } finally {
    await other.close();
    await show(browser, page);
    await setSettings(page, {});
    await page.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: ac.identifier });
  }
}

async function sceneSection(ctx) {
  const { page } = ctx;
  await openTab(page);
  await sleep(400);
  let a = await page.evaluate('__pcd.scene()');
  const p = await scenePoint(page);
  await click(page, p.x, p.y);
  await sleep(400);
  let b = await page.evaluate('__pcd.scene()');
  const focusAfterClick = await page.evaluate('__pcd.term().focused');
  check('a click on the scene shakes it (and the prompt keeps the keys)', b.shakes === a.shakes + 1 && focusAfterClick, `shakes +${b.shakes - a.shakes}; prompt focused ${focusAfterClick}`);
  await termRun(page, 'shake');
  const c = await page.evaluate('({ s: __pcd.scene(), out: __pcd.term().text })');
  check('the terminal\'s shake shakes the scene', c.s.shakes === b.shakes + 1, `shakes +${c.s.shakes - b.shakes}; output "${c.out.split('\n').slice(-1)[0]}"`);
  await termRun(page, 'surprise');
  await sleep(300);
  const d = await page.evaluate('({ s: __pcd.scene(), out: __pcd.term().text, stored: __pcd.settings().theme })');
  check('surprise (terminal): another theme for this tab, tag surprise, nothing stored', d.s.tag === 'surprise' && d.s.id !== c.s.id && d.stored === 'auto',
    `${c.s.id} -> ${d.s.id} (${d.s.tag}); stored theme ${d.stored}`);
  await setSettings(page, { theme: 'winter' });
  await page.waitFor("__pcd.scene().id === 'winter'", { timeoutMs: 5000 }).catch(() => null);
  const e = await page.evaluate('__pcd.scene()');
  check('theme override (settings): snowy hills, tag pinned; it ends the surprise', e.id === 'winter' && e.tag === 'pinned', `${e.id} (${e.tag})`);
  await termRun(page, 'theme auto');
  await page.waitFor("__pcd.settings().theme === 'auto'", { timeoutMs: 5000 }).catch(() => null);
  await termRun(page, 'theme snowy hills');
  await page.waitFor("__pcd.settings().theme === 'winter'", { timeoutMs: 5000 }).catch(() => null);
  await sleep(1700); // the cross-fade (1.5 s)
  const f = await page.evaluate('({ s: __pcd.scene(), stored: __pcd.settings().theme, lines: __pcd.lines() })');
  const stored = await page.evaluate("chrome.storage.sync.get('settings')");
  check('"theme snowy hills" (terminal): pinned, stored in chrome.storage.sync, the caption names it', f.s.id === 'winter' && f.s.tag === 'pinned' && stored.settings && stored.settings.theme === 'winter' && /snowy hills/.test(f.lines.caption || ''),
    `${f.s.id} (${f.s.tag}); stored ${JSON.stringify(stored.settings)}; caption ${f.lines.caption}`);
  await termRun(page, 'theme auto');
  await page.waitFor("__pcd.scene().tag === 'auto'", { timeoutMs: 5000 }).catch(() => null);
  check('"theme auto": back to the date\'s theme', (await page.evaluate('__pcd.scene().tag')) === 'auto', await page.evaluate('__pcd.scene().id'));

  // an explicit theme ends this tab's surprise, also when it is the stored one (terminal and sheet)
  const dateId = await page.evaluate(() => { const t = new Date(__pcd.view().now); return PCD.engine.autoId(PixelClock, t.getFullYear(), t.getMonth() + 1, t.getDate()); });
  await termRun(page, 'surprise');
  const s1 = await page.evaluate('__pcd.scene()');
  await termRun(page, 'theme auto');
  await page.waitFor("__pcd.scene().tag === 'auto'", { timeoutMs: 3000 }).catch(() => null);
  const s2 = await page.evaluate('({ s: __pcd.scene(), out: __pcd.term().text.split("\\n").slice(-1)[0] })');
  check('surprise, then "theme auto" (already stored): the surprise ends, the date\'s scene (tag auto) shows',
    s1.tag === 'surprise' && s2.s.tag === 'auto' && s2.s.id === dateId, `${s1.id} (${s1.tag}) -> ${s2.s.id} (${s2.s.tag}); date ${dateId}; "${s2.out}"`);
  await termRun(page, 'theme winter');
  await page.waitFor("__pcd.settings().theme === 'winter'", { timeoutMs: 5000 }).catch(() => null);
  await termRun(page, 'surprise');
  const s3 = await page.evaluate('__pcd.scene()');
  await termRun(page, 'theme winter');
  await page.waitFor("__pcd.scene().tag === 'pinned'", { timeoutMs: 3000 }).catch(() => null);
  const s4 = await page.evaluate('__pcd.scene()');
  check('"theme winter", surprise, "theme winter" again: snowy hills pinned', s3.tag === 'surprise' && s4.id === 'winter' && s4.tag === 'pinned',
    `${s3.id} (${s3.tag}) -> ${s4.id} (${s4.tag})`);
  await termRun(page, 'theme auto');
  await page.waitFor("__pcd.settings().theme === 'auto' && __pcd.scene().tag === 'auto'", { timeoutMs: 5000 }).catch(() => null);
  // the sheet: "☼ surprise me" shows a surprise line in the theme select; picking auto (stored) ends the surprise
  await page.evaluate('PCD.ntp.openSettings()');
  await sleep(250);
  await page.evaluate(() => document.querySelector('dialog.pcd-panel [data-action="surprise"]').click());
  await sleep(250);
  const s5 = await page.evaluate('({ s: __pcd.scene(), p: __pcd.panel() })');
  await page.evaluate(() => {
    const sel = document.querySelector('dialog.pcd-panel .pcd-panel__row[data-key="theme"] select');
    sel.value = 'auto';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.waitFor("__pcd.scene().tag === 'auto'", { timeoutMs: 3000 }).catch(() => null);
  const s6 = await page.evaluate('({ s: __pcd.scene(), p: __pcd.panel() })');
  await page.evaluate(() => document.querySelector('dialog.pcd-panel [data-action="close"]').click());
  check('the sheet: ☼ surprise me shows "surprise · <scene>" in the theme select; auto picked again ends it (tag auto)',
    s5.s.tag === 'surprise' && s5.p.surprise === `surprise · ${String(s5.s.name).toLowerCase()}` && s6.s.tag === 'auto' && s6.s.id === dateId && s6.p.surprise === null,
    `${s5.s.id} (${s5.s.tag}), select "${s5.p.surprise}" -> ${s6.s.id} (${s6.s.tag}), select "${s6.p.surprise}"`);

  // injected dates (?at=, local time): the theme of the date and its greeting
  const dates = [
    ['2026-10-31T21:00', 'halloween', /^good evening · happy halloween$/],
    ['2026-12-24T23:00', 'christmas', /^good night\.$/],
    ['2026-11-26T13:00', 'thanksgiving', /^good afternoon · happy thanksgiving$/],
    ['2026-07-15T12:00', 'summer', /^good afternoon\.$/],
  ];
  for (const [at, theme, greet] of dates) {
    await openTab(page, `${ctx.base}newtab.html?at=${at}`);
    const g = await page.evaluate('({ s: __pcd.scene(), lines: __pcd.lines(), url: location.search, rule: PCD.greet.line(new Date(__pcd.view().now)) })');
    check(`injected date ${at.replace('T', ' ')}: ${theme}, "${g.lines.greet}" (the query survives the focus redirect)`,
      g.s.id === theme && greet.test(g.lines.greet || '') && g.lines.greet === g.rule && /at=/.test(g.url) && /focus/.test(g.url),
      `${g.s.id}; greeting "${g.lines.greet}" (PCD.greet "${g.rule}"); ${g.lines.date}; ${g.url}`);
  }
}

async function weatherSection(ctx) {
  const { browser, page } = ctx;
  await openTab(page);
  await page.waitFor("__pcd.weather().status === 'ok' && !__pcd.weather().mirrored", { timeoutMs: 8000 }).catch(() => null);
  let w = await page.evaluate('({ w: __pcd.weather(), lines: __pcd.lines() })');
  check('weather (Open-Meteo mock, Berlin): the block with its credit; a 30-minute refresh timer while visible',
    w.w.status === 'ok' && /°C/.test(w.lines.weather || '') && /open-meteo\.com/.test(w.lines.weather || '') && w.w.timer,
    `${(w.lines.weather || '(none)').replace(/\n/g, ' / ')}; ${JSON.stringify(w.w)}`);
  check('privacy: only Berlin went to Open-Meteo (mocked), nothing blocked', browser.violations.length === 0 && browser.weatherRequests.every((q) => q.action === 'mocked'),
    `${browser.weatherRequests.length} requests, ${browser.violations.length} blocked`);
  // offline: no cache, the network down
  await page.evaluate("chrome.storage.local.remove('weather')");
  await page.send('Network.enable');
  await page.send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await openTab(page);
  await sleep(800);
  w = await page.evaluate('({ w: __pcd.weather(), lines: __pcd.lines() })');
  check('offline before the first forecast: no weather block and no error text', !w.lines.weather && !/error|offline/i.test(JSON.stringify(w.lines)),
    `weather line ${JSON.stringify(w.lines.weather)}; client ${JSON.stringify(w.w)}`);
  // offline: no weather timer and no cache read (the 'online' event asks again), counted over 5 s
  await page.evaluate(() => {
    window.__wReads = 0;
    const area = chrome.storage.local;
    const get = area.get.bind(area);
    const counted = (...a) => { window.__wReads++; return get(...a); };
    try { area.get = counted; } catch (e) { /* read-only: defineProperty below */ }
    if (area.get !== counted) Object.defineProperty(area, 'get', { value: counted, configurable: true, writable: true });
  });
  await sleep(5000);
  const poll = await page.evaluate('({ reads: window.__wReads, w: __pcd.weather() })');
  check('offline: no weather timer and no cache read in 5 s (the online event asks again)', poll.reads === 0 && !poll.w.timer,
    `${poll.reads} cache reads; client ${JSON.stringify(poll.w)}`);
  // leave the offline tab before the network comes back (its 'online' refresh would fill the cache again)
  await page.goto('about:blank');
  await page.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await page.send('Network.disable');
  // HTTP 400 from the forecast (no cache: the offline tab stored no data): the page's fetch answers like Open-Meteo's
  // errors do
  const stub = await page.send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => { const f = window.fetch.bind(window); window.fetch = (u, i) => String(u).startsWith('https://api.open-meteo.com/v1/forecast') ? Promise.resolve(new Response('{"error":true,"reason":"Invalid value (test)"}', { status: 400, headers: { 'Content-Type': 'application/json' } })) : f(u, i); })();` });
  await openTab(page);
  await page.waitFor("__pcd.weather().status !== null", { timeoutMs: 5000 }).catch(() => null);
  await sleep(500);
  w = await page.evaluate('({ w: __pcd.weather(), lines: __pcd.lines() })');
  await page.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: stub.identifier });
  check('HTTP 400 from the forecast: no weather block, no error text, a later retry', !w.lines.weather && !/error|invalid/i.test(JSON.stringify(w.lines)),
    `weather line ${JSON.stringify(w.lines.weather)}; client ${JSON.stringify(w.w)}`);
  await page.evaluate("chrome.storage.local.remove('weather')");
  check('zero exceptions and console errors in the weather runs', pageErrors(page).length === 0, errText(pageErrors(page)) || 'none');
}

async function statusSection(ctx) {
  const { page, clock } = ctx;
  await openTab(page);
  const clock24 = (await page.evaluate('__pcd.settings().clock24')) === true;
  const lineOf = (name) => ST.lineText(ST.describe(ST.parse(RAW[name]).status, { clock24 }));
  const shows = async (text, timeoutMs = 8000) => {
    const end = Date.now() + timeoutMs;
    let got = null;
    while (Date.now() < end) {
      got = await page.evaluate('({ line: __pcd.lines().status, st: __pcd.status() })');
      if (got.line === text) return got;
      if (!got.st.inFlight) await page.evaluate("window.dispatchEvent(new Event('online'))");
      await sleep(250);
    }
    return got;
  };
  for (const name of FIXTURES) {
    clock.setScenario(name);
    const want = lineOf(name);
    const got = await shows(want);
    check(`clock status "${name}": ${want}`, got && got.line === want, `shown ${JSON.stringify(got && got.line)}`);
    if (name === 'ringing') {
      const pulse = await page.evaluate(`(async () => {
        const seen = new Set();
        const t0 = performance.now();
        while (performance.now() - t0 < 1500) { seen.add(document.querySelector('#console').className.includes('ring-on') ? 'on' : 'off'); await new Promise((r) => setTimeout(r, 60)); }
        return { seen: [...seen], st: __pcd.status(), info: __pcd.console() };
      })()`);
      check('ringing: the console rings (the 2 Hz pulse on its status line) and the line is accent', pulse.seen.length === 2 && pulse.st.ringing && pulse.st.tone === 'accent' && pulse.info.ringing,
        `pulse states ${pulse.seen.join('/')}; status ringing ${pulse.st.ringing}, tone ${pulse.st.tone}; console ringing ${pulse.info.ringing}`);
    }
  }
  clock.setScenario('unreachable');
  let gone = null;
  for (let i = 0; i < 40; i++) {
    gone = await page.evaluate('({ line: __pcd.lines().status, st: __pcd.status() })');
    if (gone.line === null && gone.st.fails >= 2) break;
    if (!gone.st.inFlight) await page.evaluate("window.dispatchEvent(new Event('online'))");
    await sleep(300);
  }
  check('the clock unreachable: the line is gone after 2 failures, without an error text', gone.line === null && gone.st.fails >= 2 && pageErrors(page).every((e) => /pixelclock\.local/.test(e.text) || e.type !== 'exception'),
    `line ${JSON.stringify(gone.line)}, fails ${gone.st.fails}, ${gone.st.lastError}`);
  clock.setScenario('normal');
  const kinds = [...new Set(clock.requests.map((q) => `${q.method} ${q.path} origin=${q.origin}`))];
  check('only GET /api/status ever reached the clock (no Origin)', kinds.length === 1 && kinds[0] === 'GET /api/status origin=null', kinds.join('; '));
}

async function terminalSection(ctx) {
  const { browser, page, site } = ctx;
  await openTab(page);
  await spyChrome(page);
  // typing anywhere moves the focus to the prompt
  await page.evaluate((sel) => document.querySelector(sel).blur(), TERM_INPUT);
  await press(page, 'x');
  await sleep(100);
  let t = await page.evaluate('__pcd.term()');
  check('typing anywhere moves the focus to the prompt (the key types there)', t.focused && t.value === 'x', `focused ${t.focused}, value ${JSON.stringify(t.value)}`);
  await press(page, 'Escape');
  await press(page, '2');
  await sleep(100);
  t = await page.evaluate('__pcd.term()');
  const link2 = EXAMPLE.shortcuts[1].label;
  check(`a digit previews its link (2 -> ${link2})`, t.value === '2' && new RegExp(`→ ${link2}`).test(t.ghost), `value ${JSON.stringify(t.value)}, ghost ${JSON.stringify(t.ghost)}`);
  await press(page, 'Enter', ['ctrl']);
  await sleep(250);
  let calls = await page.evaluate('window.__spy.splice(0)');
  check('2 + Ctrl+Enter opens link 2 in a new tab (chrome.tabs.create)', calls.length === 1 && calls[0].api === 'tabs.create' && calls[0].args[0].url.startsWith(new URL(EXAMPLE.shortcuts[1].url).origin),
    JSON.stringify(calls));
  await termRun(page, 'pixel art clocks');
  calls = await page.evaluate('window.__spy.splice(0)');
  check('any other text searches with Chrome\'s default engine (chrome.search.query, this tab)', calls.length === 1 && calls[0].api === 'search.query' && calls[0].args[0].text === 'pixel art clocks' && calls[0].args[0].disposition === 'CURRENT_TAB',
    JSON.stringify(calls));
  await termRun(page, 'pixel art clocks', ['ctrl']);
  calls = await page.evaluate('window.__spy.splice(0)');
  check('Ctrl+Enter searches in a new tab', calls.length === 1 && calls[0].api === 'search.query' && calls[0].args[0].disposition === 'NEW_TAB', JSON.stringify(calls));
  await termRun(page, 'g cats &');
  calls = await page.evaluate('window.__spy.splice(0)');
  check('"g cats &": a Google search in a new tab', calls.length === 1 && calls[0].api === 'tabs.create' && /^https:\/\/www\.google\.com\/search\?q=cats/.test(calls[0].args[0].url), JSON.stringify(calls));
  await termRun(page, 'help');
  t = await page.evaluate('__pcd.term()');
  // a short terminal shows a page of help that ends with "more   help more"; the rest is one command away
  const paged = /more\s+help more\s*$/.test(t.text);
  if (paged) {
    await termRun(page, 'help more');
    t = await page.evaluate('__pcd.term()');
  }
  check(`help lists the commands${paged ? ' (two pages: help, then help more)' : ''}`, /open/.test(t.text) && /search/.test(t.text) && /theme/.test(t.text) && /settings/.test(t.text),
    t.text.split('\n').slice(-12).join(' / ').slice(0, 400));
  const lastTyped = paged ? 'help more' : 'help';
  await page.evaluate((sel) => document.querySelector(sel).focus(), TERM_INPUT);
  await type(page, 'surp');
  await press(page, 'Tab');
  await sleep(100);
  t = await page.evaluate('__pcd.term()');
  check('Tab completes ("surp" -> "surprise")', /^surprise\s?$/.test(t.value), JSON.stringify(t.value));
  await press(page, 'Escape');
  await sleep(50);
  t = await page.evaluate('__pcd.term()');
  check('Esc clears the line', t.value === '', JSON.stringify(t.value));
  await press(page, 'ArrowUp');
  await sleep(50);
  t = await page.evaluate('__pcd.term()');
  check(`Up recalls the last line ("${lastTyped}")`, t.value === lastTyped, JSON.stringify(t.value));
  await press(page, 'Escape');
  await termRun(page, 'clock 12');
  const c12 = await page.waitFor("chrome.storage.sync.get('settings').then((o) => o.settings && o.settings.clock24 === false ? o.settings : null)", { timeoutMs: 4000 }).catch(() => null);
  const shown12 = await page.evaluate('({ s: __pcd.settings().clock24, ampm: /\\b(am|pm)\\b/.test(document.querySelector("#console").textContent) })');
  check('"clock 12": the clock turns 12 h (am/pm shows) and the setting is stored (after the 1 s debounce)', !!c12 && shown12.s === false && shown12.ampm,
    `${JSON.stringify(c12)}; ${JSON.stringify(shown12)}`);
  await termRun(page, 'clock 24');
  // Ctrl/Alt/Meta combinations: never prevented, in the prompt and outside
  const combos = [['x', ['ctrl']], ['k', ['ctrl']], ['d', ['alt']], ['a', ['meta']], ['z', ['ctrl', 'shift']], ['ArrowLeft', ['ctrl']]];
  const prevented = [];
  const unseen = [];
  const probe = async (k, m, where) => {
    const r = await keyPrevented(page, k, m);
    if (r === true) prevented.push(`${where}${m.join('+')}+${k}`);
    else if (r === null) unseen.push(`${where}${m.join('+')}+${k}`);
  };
  await page.evaluate((sel) => document.querySelector(sel).focus(), TERM_INPUT);
  for (const [k, m] of combos) await probe(k, m, 'in the prompt: ');
  await page.evaluate((sel) => document.querySelector(sel).blur(), TERM_INPUT);
  for (const [k, m] of [...combos, ['l', ['ctrl']]]) await probe(k, m, '');
  const total = combos.length * 2 + 1;
  check('Ctrl/Alt/Meta combinations are never prevented', prevented.length === 0 && total - unseen.length >= total - 2,
    `${total - unseen.length} of ${total} reached the page, ${prevented.length} prevented${prevented.length ? ': ' + prevented.join(', ') : ''}${unseen.length ? '; kept by Chrome: ' + unseen.join(', ') : ''}`);
  // a link by number, Enter: this tab goes there; an address too (a local page really loads)
  await openTab(page);
  await termRun(page, '1');
  const u1 = await waitUrl(browser, page, (u) => /^https?:/.test(u));
  check(`1 + Enter opens link 1 in this tab (${EXAMPLE.shortcuts[0].label})`, u1.startsWith(new URL(EXAMPLE.shortcuts[0].url).origin), u1);
  await openTab(page);
  await termRun(page, `127.0.0.1:${site.port}/landing.html`);
  const lu = await waitUrl(browser, page, (u) => u.startsWith('http://127.0.0.1'));
  let title = '';
  try { title = await page.waitFor("document.readyState === 'complete' && document.title", { timeoutMs: 5000 }); } catch { title = ''; }
  check('an address opens in this tab (http for 127.0.0.1; the page loads)', lu === `http://127.0.0.1:${site.port}/landing.html` && title === 'landing', `${lu} -> "${title}"`);
}

async function sheetSection(ctx) {
  const { page } = ctx;
  await openTab(page);
  const btn = await page.evaluate(() => { const b = [...document.querySelectorAll('#console button')].find((x) => /settings/.test(x.textContent)); const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, text: b.textContent }; });
  await click(page, btn.x, btn.y);
  await sleep(300);
  let st = await page.evaluate('({ panel: __pcd.panel(), state: __pcd.state(), regions: null, info: __pcd.console() })');
  const geo = await page.evaluate(() => {
    const d = document.querySelector('dialog.pcd-panel');
    const r = d.getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height, open: d.open };
  });
  const p = st.panel;
  const frame = p && p.grid ? p.grid.frame : [];
  check(`"${btn.text.trim()}" opens the settings sheet over the column; the column hides`, p.open && st.state.sheet && st.info.sheet && p.placed,
    `open ${p.open}, placed ${p.placed}, ${p.grid && p.grid.cols}x${p.grid && p.grid.rows} cells at ${Math.round(geo.x)},${Math.round(geo.y)}`);
  check('the sheet\'s box lines are text (╭─ … ─╮ │ … │ ╰─ … ─╯), in whole cells', frame.length === p.grid.rows && frame[0].startsWith('╭─') && frame[0].endsWith('─╮') &&
    frame[frame.length - 1].startsWith('╰') && frame[frame.length - 1].endsWith('─╯') && frame.slice(1, -1).every((l) => l.startsWith('│') && l.endsWith('│')) &&
    Math.abs(geo.w - p.grid.cols * p.grid.cw) < 0.01 && Math.abs(geo.h - p.grid.rows * p.grid.ch) < 0.01,
    `${frame[0]} | ${frame[frame.length - 1]}`);
  check('the sheet has a "terminal [x] focus on open" row (13 settings, weather fx shares a row)', p.rows.includes('focusTerminal') && p.keys.length === 13,
    p.rows.join(' '));
  await press(page, 'Escape');
  await page.waitFor('!document.querySelector("dialog.pcd-panel").open', { timeoutMs: 3000 }).catch(() => null);
  await sleep(150);
  const back = await page.evaluate('({ term: __pcd.term(), state: __pcd.state(), info: __pcd.console() })');
  check('Esc closes it; the column shows again and the terminal has the keys', back.term.focused && !back.state.sheet && !back.info.sheet, `term focused ${back.term.focused}, sheet ${back.state.sheet}`);
  await termRun(page, 'settings');
  await sleep(300);
  st = await page.evaluate('__pcd.panel()');
  check('the terminal\'s settings command opens it too', st.open, `open ${st.open}`);
  // a change in the sheet: the links follow live and the store has it
  await page.evaluate(() => {
    const d = document.querySelector('dialog.pcd-panel');
    const row = d.querySelector('.pcd-panel__row[data-key="clockStatus"] input');
    row.click();
  });
  await sleep(200);
  const off = await page.evaluate('({ line: __pcd.lines().status, s: __pcd.settings().clockStatus })');
  check('a switch in the sheet applies at once (pixelclock off -> the status line goes)', off.s === false && off.line === null, JSON.stringify(off));
  await page.evaluate(() => document.querySelector('dialog.pcd-panel .pcd-panel__row[data-key="clockStatus"] input').click());
  await page.evaluate(() => document.querySelector('dialog.pcd-panel [data-action="close"]').click());
  await sleep(1300);
  await setSettings(page, { shortcuts: [{ label: 'docs', url: 'https://example.org/docs' }, { label: 'local', url: 'http://localhost:8080/' }] });
  await page.waitFor("(__pcd.lines().links || '').includes('docs')", { timeoutMs: 5000 }).catch(() => null);
  const links = await page.evaluate('({ lines: __pcd.lines().links, list: __pcd.links() })');
  check('the links follow the settings live (chrome.storage.sync -> onChanged)', /\[1\] docs/.test(links.lines || '') && /\[2\] local/.test(links.lines || '') && !/\[3\]/.test(links.lines || ''),
    `${links.lines} (${links.list.source})`);
  await setSettings(page, {});
  // a link named like a terminal command: a note under it, and it is still saved
  await page.evaluate('PCD.ntp.openSettings()');
  await sleep(250);
  const named = await page.evaluate(async () => {
    const d = document.querySelector('dialog.pcd-panel');
    d.querySelector('[data-action="edit"]').click();
    const input = d.querySelector('.pcd-panel__item .pcd-panel__item-label');
    input.value = 'weather';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 100));
    const note = d.querySelector('.pcd-panel__item .pcd-panel__item-note');
    return { note: note.hidden ? null : note.textContent, level: note.getAttribute('data-level'), invalid: d.querySelector('.pcd-panel__item').hasAttribute('data-invalid') };
  });
  await page.evaluate(() => document.querySelector('dialog.pcd-panel [data-action="close"]').click());
  const savedNamed = await page.waitFor("chrome.storage.sync.get('settings').then((o) => o.settings && o.settings.shortcuts && o.settings.shortcuts[0].label === 'weather')", { timeoutMs: 4000 }).catch(() => false);
  check('a link named "weather" (a command): the editor notes it, and it is still saved', named.note === '"weather" is also a command: type its number to open it' &&
    named.level === 'info' && !named.invalid && !!savedNamed, `${JSON.stringify(named)}; saved ${!!savedNamed}`);
  await setSettings(page, {});
  // a short window: no room for a blank line between every row, so one before each group of settings
  await page.setViewport(800, 500, 1);
  await sleep(300);
  await page.evaluate('PCD.ntp.openSettings()');
  await sleep(300);
  const short = await page.evaluate('__pcd.panel().grid');
  await page.evaluate(() => document.querySelector('dialog.pcd-panel [data-action="close"]').click());
  await page.setViewport(1920, 969, 1);
  await sleep(300);
  const used = short ? short.pad + short.lines + short.groups + short.pad + 1 : 0;
  check('800x500: no room for a blank line between every row, so the sheet keeps one before each of the 5 groups of settings (at most 5 rows left above [ done ])',
    !!short && short.gap === 0 && short.groups === 5 && short.rows - 2 - used <= 5, JSON.stringify(short && { rows: short.rows, lines: short.lines, gap: short.gap, pad: short.pad, groups: short.groups, left: short.rows - 2 - used }));
  const mirror = await page.evaluate(() => JSON.parse(localStorage.getItem('pcd.mirror')));
  check('the mirror for boot.js: the settings it needs', !!mirror &&
    ['theme', 'clock24', 'reducedMotion', 'performance', 'focusTerminal'].every((k) => k in mirror), JSON.stringify(mirror));
}

async function focusSection(ctx) {
  const { page, id } = ctx;
  await openTab(page);
  await page.evaluate('PCD.ntp.openSettings()');
  await sleep(250);
  await page.evaluate(() => document.querySelector('dialog.pcd-panel .pcd-panel__row[data-key="focusTerminal"] input').click());
  await page.evaluate(() => document.querySelector('dialog.pcd-panel [data-action="close"]').click());
  await page.waitFor("JSON.parse(localStorage.getItem('pcd.mirror')).focusTerminal === false", { timeoutMs: 4000 }).catch(() => null);
  const off = await openTab(page, 'chrome://newtab/', { focus: false });
  const docsOff = off.navs.filter((u) => u.startsWith(`chrome-extension://${id}/`));
  check('focus off (the sheet): the next tab does not redirect (one document, Chrome keeps its address bar)', docsOff.length === 1 && off.url === `chrome-extension://${id}/newtab.html`,
    off.navs.join(' -> '));
  check('focus off: zero errors, the page still works (data-ready)', pageErrors(page).length === 0 && (await page.evaluate('__pcd.state().ready')), errText(pageErrors(page)) || 'none');
  await setSettings(page, {});
  await page.waitFor("JSON.parse(localStorage.getItem('pcd.mirror')).focusTerminal === true", { timeoutMs: 4000 }).catch(() => null);
  const on = await openTab(page);
  const docsOn = on.navs.filter((u) => u.startsWith(`chrome-extension://${id}/`));
  check('focus on again: one redirect to ?focus, no loop', docsOn.length === 2 && /\?focus$/.test(on.url), on.navs.join(' -> '));
}

/** In a browser of its own, after the other sections' browser has closed: a real new tab opens in a browser that has
 *  not run them (no timer tracker, no tab still animating beside it). One open warms the extension up, unmeasured. */
async function paintSection(ctx) {
  const browser = await launch({ headless: true, extensionDebugging: true, weather: 'mock', clock: ctx.clock.port, deviceScaleFactor: 1, windowSize: [1920, 1100] });
  const t = [];
  try {
    const id = await browser.loadUnpacked(ctx.dist);
    const page = await browser.newPage('about:blank');
    await page.send('Emulation.setFocusEmulationEnabled', { enabled: true });
    await page.setViewport(1920, 969, 1);
    await openTab(page);
    for (let i = 0; i < 7; i++) {
      await openTab(page);
      await sleep(300);
      t.push(await page.evaluate(`(() => {
        const p = performance.getEntriesByType('paint').find((x) => x.name === 'first-contentful-paint');
        const s = __pcd.state();
        return { fcp: p ? p.startTime : NaN, frame: s.firstFrameMs, ready: s.readyMs, script: s.scriptMs };
      })()`));
    }
    check('first paint: its own browser, zero errors, nothing blocked', pageErrors(page).length === 0 && browser.violations.length === 0,
      `${errText(pageErrors(page)) || 'no errors'}; ${browser.violations.length} blocked`);
  } finally {
    await browser.close();
  }
  const best = (k) => Math.min(...t.map((x) => x[k]).filter(Number.isFinite));
  const med = (k) => median(t.map((x) => x[k]));
  const fcp = best('fcp');
  const frame = best('frame');
  const ready = best('ready');
  check('first paint (best of 7 opens of the ?focus document): FCP <= 100 ms', fcp <= 100, `best ${fcp.toFixed(0)} ms, median ${med('fcp').toFixed(0)}; all ${t.map((x) => Math.round(x.fcp)).join(', ')}; scripts start at ${best('script')} ms`);
  check('first paint: the first scene frame <= 150 ms', frame <= 150, `best ${frame} ms, median ${med('frame')}; all ${t.map((x) => x.frame).join(', ')}`);
  check('first paint: data-ready <= 300 ms', ready <= 300, `best ${ready} ms, median ${med('ready')}; all ${t.map((x) => x.ready).join(', ')}`);
}

const SIZES = [
  { w: 1280, h: 620, dpr: 2, name: 'chrome-window', at: null, extra: null },
  { w: 1280, h: 800, dpr: 2, name: 'night-help', at: '2026-11-15T20:40', extra: 'help' },
  { w: 1920, h: 969, dpr: 1, name: 'summer-day', at: '2026-07-15T12:00' },
  { w: 2560, h: 1329, dpr: 1, name: 'halloween', at: '2026-10-31T21:00' },
  { w: 3840, h: 2049, dpr: 1, name: 'christmas', at: '2026-12-24T23:00' },
  { w: 800, h: 500, dpr: 1, name: 'thanksgiving', at: '2026-11-26T13:00' },
];

async function shotsSection(ctx) {
  fs.mkdirSync(SHOTS, { recursive: true });
  for (const dpr of [2, 1]) {
    const browser = await launch({ headless: true, extensionDebugging: true, weather: 'mock', clock: ctx.clock.port, deviceScaleFactor: dpr, windowSize: [1920, 1100] });
    try {
      const id = await browser.loadUnpacked(ctx.dist);
      for (const s of SIZES.filter((x) => x.dpr === dpr)) {
        const page = await browser.newPage('about:blank');
        await page.send('Emulation.setFocusEmulationEnabled', { enabled: true });
        await page.send('Emulation.setTimezoneOverride', { timezoneId: 'Europe/Berlin' }); // the sample city's own day and sun
        await page.setViewport(s.w, s.h, dpr);
        if (s.at) await browser.setWeatherMode({ mode: 'mock', now: Date.parse(`${s.at}:00+01:00`) });
        await openTab(page, `chrome-extension://${id}/newtab.html${s.at ? `?at=${s.at}` : ''}`);
        await page.evaluate("chrome.storage.local.remove('weather')");
        await openTab(page, `chrome-extension://${id}/newtab.html${s.at ? `?at=${s.at}` : ''}`);
        await page.waitFor("__pcd.weather().status === 'ok' && !__pcd.weather().mirrored", { timeoutMs: 6000 }).catch(() => null);
        await page.waitFor("__pcd.lines().status !== null", { timeoutMs: 4000 }).catch(() => null);
        if (s.extra) await termRun(page, s.extra);
        await sleep(1200);
        const base = `newtab-${s.w}x${s.h}@${dpr}-${s.name}`;
        const crisp = await crispCheck(page, `${s.w}x${s.h}@${dpr}`, null);
        // the pictures show the colon and the caret lit: wait for the start of the colon's lit half (500 ms), then give
        // the prompt its focus back (the check above hid the column; a focus shows the caret solid for 530 ms) and shoot
        await page.waitFor('__pcd.state().colon === false', { timeoutMs: 1500, intervalMs: 20 }).catch(() => null);
        await page.waitFor('__pcd.state().colon === true', { timeoutMs: 1500, intervalMs: 20 }).catch(() => null);
        await page.evaluate((sel) => document.querySelector(sel).focus(), TERM_INPUT);
        const file = path.join(SHOTS, `${base}.png`);
        await page.screenshot({ path: file });
        const info = await page.evaluate('({ c: __pcd.console(), lines: __pcd.lines(), s: __pcd.scene() })');
        check(`${s.w}x${s.h}@${dpr} (${s.name}): crisp k x k blocks, zero errors; ${path.relative(ROOT, file)}`, crisp.ok && pageErrors(page).length === 0,
          `${crisp.detail}; font ${info.c.fontPx} px; dropped ${JSON.stringify(info.c.dropped)}; ${info.s.id}; ${errText(pageErrors(page)) || 'no errors'}`);
        await page.close();
      }
      await browser.setWeatherMode('mock');
    } finally {
      await browser.close();
    }
  }
}

// ------------------------------------------------------------------------------------------------ main

async function main() {
  if (!findBrowser()) {
    console.error('no Chrome or Edge found (set PCD_BROWSER)');
    return 1;
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pcd-newtab-test-'));
  fs.writeFileSync(path.join(tmp, 'landing.html'), '<!doctype html><meta charset="utf-8"><title>landing</title><p>local landing page</p>\n');
  const site = await serve(tmp);
  const clock = await startMockClock({ scenario: 'normal' });
  const t0 = Date.now();
  let browser = null;
  try {
    const dist = argOf('--dist') ? path.resolve(argOf('--dist')) : await buildExample(tmp);
    if (!fs.existsSync(path.join(dist, 'manifest.json'))) throw new Error(`${dist} is not a built new tab`);
    const ctx = { dist, site, clock, expectedId: fs.readFileSync(ID_FILE, 'utf8').trim() };
    const main = SECTIONS.filter((s) => s !== 'paint' && s !== 'shots' && want(s));
    if (main.length) {
      browser = await launch({ headless: true, extensionDebugging: true, weather: 'mock', clock: clock.port, deviceScaleFactor: 1, windowSize: [1920, 1100] });
      check('headless Chrome (temp profile, privacy guard on, Open-Meteo mocked, pixelclock.local -> the mock clock)', true,
        `${browser.version.product}; guard ${browser.privacy.active ? 'active' : 'idle'}`);
      ctx.browser = browser;
      ctx.id = await browser.loadUnpacked(dist);
      ctx.base = `chrome-extension://${ctx.id}/`;
      ctx.page = await extensionPage(browser, ctx.id);
      await ctx.page.setViewport(1920, 969, 1);
      const run = { load: loadSection, motion: motionSection, scene: sceneSection, weather: weatherSection, status: statusSection, terminal: terminalSection, sheet: sheetSection, focus: focusSection };
      for (const s of main) {
        try {
          await run[s](ctx);
        } catch (e) {
          check(`${s}: ran to the end`, false, e && e.stack ? e.stack.split('\n').slice(0, 3).join(' / ') : String(e));
          try { await ctx.page.close(); } catch { /* gone */ }
          ctx.page = await extensionPage(browser, ctx.id);
          await ctx.page.setViewport(1920, 969, 1);
        }
      }
      check('privacy guard: nothing blocked; the mock clock saw only GET /api/status', browser.violations.length === 0 && clock.requests.every((r) => r.method === 'GET' && r.path === '/api/status'),
        `${browser.violations.length} blocked; ${browser.weatherRequests.length} Open-Meteo requests (mocked); clock: ${clock.requests.length} requests`);
      const closed = await browser.close();
      browser = null;
      check('temporary profile removed', closed.cleaned, closed.userDataDir);
    }
    if (want('paint')) {
      try {
        await paintSection(ctx);
      } catch (e) {
        check('paint: ran to the end', false, e && e.stack ? e.stack.split('\n').slice(0, 3).join(' / ') : String(e));
      }
    }
    if (want('shots')) await shotsSection(ctx);
  } catch (e) {
    check('harness', false, e && e.stack ? e.stack : String(e));
  } finally {
    if (browser) await browser.close();
    await site.close();
    await clock.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  const shots = want('shots') && fs.existsSync(SHOTS) ? fs.readdirSync(SHOTS).filter((f) => f.endsWith('.png')).map((f) => `${path.relative(ROOT, path.join(SHOTS, f))} ${pngSize(path.join(SHOTS, f)).width}x${pngSize(path.join(SHOTS, f)).height}`) : [];
  const counts = printReport(rows, { title: `PixelClock Desktop new tab: gates (${((Date.now() - t0) / 1000).toFixed(0)} s)` });
  if (shots.length) console.log(`screenshots:\n  ${shots.join('\n  ')}`);
  return counts.failed ? 1 : 0;
}

main().then((code) => {
  process.exitCode = code;
  setTimeout(() => process.exit(code), 3000).unref();
}, (e) => {
  console.error(e);
  process.exit(1);
});
