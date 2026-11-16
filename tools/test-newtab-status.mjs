#!/usr/bin/env node
// PixelClock Desktop: headless checks of the new tab's clock status line and settings panel.
// Headless Chrome only through tools/lib/chrome.mjs (fresh temp profile each run, privacy guard on); the clock is
// tools/mock-clock.mjs on 127.0.0.1, mapped as pixelclock.local. Nothing here contacts a real clock or the weather.
//
//   node tools/test-newtab-status.mjs                 status line + settings sheet + the real new tab
//   node tools/test-newtab-status.mjs --probe         only the transport probe (how the page reaches the clock)
//   node tools/test-newtab-status.mjs --only status,panel,page,probe
//   node tools/test-newtab-status.mjs --page dist/newtab   the real page from a built folder (default: a fresh build)
//
// Sections:
//   probe   can an extension page read GET http://pixelclock.local/api/status? Direct,
//           as chrome://newtab/, with the clock on loopback and posing as a LAN device; controls: a Lively-like https
//           page (Local Network Access refuses it) and an http preview page (CORS blocks the reply).
//   status  a harness extension page runs the shipped ntp-settings/ntp-store/ntp-status/ntp-panel files (short poll
//           timings through the page URL): the line for every fixture in 12 h and 24 h, the ringing
//           pulse on a ring target (2 Hz; steady under reduced motion), the line gone after 2 failures, a slow
//           clock aborted by 2.6 s, no request and no pulse timer while the tab is hidden, clockStatus off -> no
//           request, only GET /api/status ever sent, no console error but Chrome's own network lines.
//   panel   the settings sheet in two extension tabs and a third opened later: one row per new tab
//           setting (weather and "in the scene" share one; the terminal's focus row), the TUI words, the
//           box lines drawn as text on whole cells, Up/Down between rows and Left/Right on radios, every setting
//           changed through the UI, the link editor behind its button (add, invalid -> not saved, fix, move, remove),
//           top sites refused and granted, keys stay inside the sheet, Esc and [ done ] close it and give the focus
//           back, chrome.storage.sync holds exactly the overrides (flushed on close), the other tab follows live, a
//           new tab reads them back; preview pages (127.0.0.1, no chrome.runtime.id) keep the settings in
//           localStorage, never fetch the clock, and show a sample line on ?status=NAME.
//   page    the real new tab (the console column), built with the plugin and config/user.example.json (Berlin) into a
//           temp folder (or --page <dir>): the console's status line from the mock (ringing: the 2 Hz pulse), the
//           sheet from "≡ settings" (clockStatus off hides the line at once, the focus row turns the redirect off),
//           Esc gives the keys back to the terminal, the settings reach chrome.storage.sync, and the next tab
//           reads the mirror first (boot.js: no redirect with focusTerminal off).
// Prints a PASS/FAIL table; exit code 1 on any FAIL. Node built-ins only.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath } from 'node:url';
import * as chrome from './lib/chrome.mjs';
import { sleep } from './lib/fsx.mjs';
import { printReport } from './lib/report.mjs';
import { serve } from './lib/serve.mjs';
import { FIXTURES, loadFixtures, startMockClock } from './mock-clock.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const ST = require(path.join(ROOT, 'src', 'newtab', 'js', 'ntp-status.js'));
const SETTINGS = require(path.join(ROOT, 'src', 'newtab', 'js', 'ntp-settings.js'));
const RAW = loadFixtures();
const SECTIONS = ['probe', 'status', 'panel', 'page'];
const LINE = (name, clock24 = false) => ST.describe(ST.parse(RAW[name]).status, { clock24 });
const SHOWN = (name, clock24 = false) => ST.lineText(LINE(name, clock24));

// ------------------------------------------------------------------------------------------- the harness

/** The shipped files the harness page runs (copied as they are). */
const SHIPPED = {
  'js/ntp-settings.js': 'src/newtab/js/ntp-settings.js',
  'js/ntp-store.js': 'src/newtab/js/ntp-store.js',
  'js/ntp-status.js': 'src/newtab/js/ntp-status.js',
  'js/ntp-panel.js': 'src/newtab/js/ntp-panel.js',
  'css/ntp-panel.css': 'src/newtab/css/ntp-panel.css',
};

/** The config the harness page's settings default to: the sample city, never yours. */
export const HARNESS_CONFIG = {
  city: 'Berlin', units: 'C', clock: '12h', sunTimes: true, weather: true,
  shortcuts: [{ label: 'wiki', url: 'https://www.wikipedia.org' }, { label: 'mdn', url: 'https://developer.mozilla.org' }],
};
export const HARNESS_THEMES = [{ id: 'auto', name: 'Auto (by date)' }, { id: 'winter', name: 'Snowy hills' }, { id: 'autumn', name: 'Autumn forest' }];

const HARNESS_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>pcd status and panel harness</title>
<link rel="stylesheet" href="css/harness.css">
<link rel="stylesheet" href="css/ntp-panel.css">
<script defer src="js/ntp-settings.js"></script>
<script defer src="js/ntp-store.js"></script>
<script defer src="js/ntp-status.js"></script>
<script defer src="js/ntp-panel.js"></script>
<script defer src="js/harness.js"></script>
</head>
<body>
<pre class="win" id="win">ring target</pre>
<div class="hud" id="hud"></div>
<p><button type="button" id="open" aria-controls="settings-panel" aria-expanded="false">settings</button></p>
<aside id="panel" hidden></aside>
</body>
</html>
`;

const HARNESS_CSS = `html, body { margin: 0; background: #141016; color: #ece4d8; font: 16px Consolas, monospace; }
.win { margin: 8px; padding: 8px; border: 1px solid #9a6a40; }
.hud { margin: 8px; min-height: 1.3em; }
`;

// Runs in the page (extension or preview). Mirrors what ntp-app.js does with these modules; the poll timings come
// from the URL (?poll=&first=&active=&retry=&retry2=), ?status=NAME shows a sample, ?top=default uses the panel's
// own chrome.permissions path (otherwise window.__h.top answers: 'yes' | 'no' | 'none').
const HARNESS_JS = `(function () {
  'use strict';
  var q = new URLSearchParams(location.search);
  function num(k, d) { var v = Number(q.get(k)); return q.has(k) && isFinite(v) ? v : d; }
  var ext = !!(window.chrome && chrome.runtime && chrome.runtime.id);
  var config = ${JSON.stringify(HARNESS_CONFIG)};
  var themes = ${JSON.stringify(HARNESS_THEMES)};
  var h = window.__h = { keys: 0, surprises: 0, top: 'no', toggles: [], fetches: [], ready: false };
  document.addEventListener('keydown', function () { h.keys++; });
  function watch(url, init) {
    var rec = { at: performance.now(), abortedAt: null, url: String(url), method: init && init.method };
    h.fetches.push(rec);
    if (init && init.signal) init.signal.addEventListener('abort', function () { rec.abortedAt = performance.now(); });
    return fetch(url, init);
  }
  var store = PCD.store.create({ config: config, themes: themes, debounceMs: num('debounce', 1000) });
  h.store = store;
  store.load().then(function (s) {
    var client = {};
    if (ext) client.fetch = watch;
    if (q.has('poll')) {
      client.firstDelayMs = num('first', 300);
      client.pollMs = num('poll', 30000);
      client.activePollMs = num('active', 10000);
      client.retryMs = [num('retry', 60000), num('retry2', 300000)];
    }
    var line = PCD.status.mountLine({ parent: document.getElementById('hud'), settings: s,
      ringTarget: document.getElementById('win'), sample: q.get('status') || undefined, client: client });
    var top = q.get('top') === 'default' ? undefined : function () {
      return Promise.resolve(h.top === 'yes' ? true : h.top === 'none' ? null : false);
    };
    var panel = PCD.panel.mount({ store: store, themes: themes, parent: document.getElementById('panel'), id: 'settings-panel',
      onSurprise: function () { h.surprises++; }, onToggle: function (on) { h.toggles.push(on); }, requestTopSites: top,
      autoName: function () { return 'Autumn forest'; } });
    store.subscribe(function (next) { line.update(next); });
    var btn = document.getElementById('open');
    btn.addEventListener('click', function () { panel.toggle(btn); });
    h.line = line;
    h.panel = panel;
    window.__pcd = { status: line.state, panel: panel.state, settings: store.get };
    line.start();
    h.ready = true;
    document.documentElement.setAttribute('data-ready', '1');
  });
})();
`;

/** The harness folder: the shipped files plus the harness page; with `extension`, an MV3 manifest (the new tab's shape). */
export function buildHarness(dir, { extension = true } = {}) {
  fs.mkdirSync(path.join(dir, 'js'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'css'), { recursive: true });
  for (const [to, from] of Object.entries(SHIPPED)) fs.copyFileSync(path.join(ROOT, from), path.join(dir, to));
  fs.writeFileSync(path.join(dir, 'harness.html'), HARNESS_HTML);
  fs.writeFileSync(path.join(dir, 'css', 'harness.css'), HARNESS_CSS);
  fs.writeFileSync(path.join(dir, 'js', 'harness.js'), HARNESS_JS);
  if (extension) {
    const manifest = {
      manifest_version: 3, name: 'PCD status and panel harness', version: '1.0.0',
      permissions: ['storage'], optional_permissions: ['topSites'], host_permissions: ['http://pixelclock.local/*'],
    };
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  }
  return dir;
}

// In the page: helpers to drive the sheet like a person would (labels clicked, real change events). Every control
// sits under an element with its data-key (its row, or its own choice when it shares a row, like weatherFx).
// `opener` is a selector of the button that opens the sheet (#open in the harness, the console's "≡ settings" in the
// real page).
const UI = (opener = '#open') => `window.__ui = {
  ctl: function (k) { return document.querySelector('.pcd-panel [data-key="' + k + '"]'); },
  row: function (k) { return document.querySelector('.pcd-panel__row[data-key="' + k + '"]'); },
  pick: function (k, raw) { document.querySelector('.pcd-panel__choice[data-key="' + k + '"][data-value="' + raw + '"]').click(); },
  tick: function (k) { __ui.ctl(k).querySelector('input[type=checkbox]').click(); },
  choose: function (k, v) { var s = __ui.ctl(k).querySelector('select'); s.value = v; s.dispatchEvent(new Event('change', { bubbles: true })); },
  focus: function (el) { el.focus(); if (el.select) el.select(); return document.activeElement === el; },
  field: function (k) { return __ui.ctl(k).querySelector('input'); },
  item: function (i, part) { return document.querySelectorAll('.pcd-panel__item')[i].querySelector('.pcd-panel__item-' + part); },
  act: function (i, a) { document.querySelectorAll('.pcd-panel__item')[i].querySelector('[data-action="' + a + '"]').click(); },
  click: function (sel) { document.querySelector(sel).click(); },
  focusKey: function () { var a = document.activeElement; var r = a && a.closest('[data-key]'); return r ? r.getAttribute('data-key') : (a && (a.id || a.className)); },
  cursor: function () {
    var r = document.activeElement && document.activeElement.closest('.pcd-panel__row');
    return r ? getComputedStyle(r.querySelector('.pcd-panel__label'), '::before').content : null;
  },
  open: function () { var b = document.querySelector(${JSON.stringify(opener)}); b.focus(); b.click(); return document.querySelector('dialog.pcd-panel').open; }
}; true`;

const KEYS = {
  Enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: '\r', unmodifiedText: '\r' },
  Tab: { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 },
  Escape: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40, nativeVirtualKeyCode: 40 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38, nativeVirtualKeyCode: 38 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39, nativeVirtualKeyCode: 39 },
};

async function press(page, name) {
  const k = KEYS[name] || { key: name, code: 'Key' + name.toUpperCase(), text: name, unmodifiedText: name, windowsVirtualKeyCode: name.toUpperCase().charCodeAt(0) };
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', ...k });
  const { text, unmodifiedText, ...up } = k;
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', ...up });
}

async function typeText(page, text) {
  await page.send('Input.insertText', { text });
}

/** Page errors except Chrome's own network lines for the clock's address (a missing clock is not an error). */
function pageErrors(page) {
  return page.errors.filter((e) => !(e.type === 'log.network' && /pixelclock\.local\/api\/status/.test(e.text)));
}

function errText(list) {
  return list.map((e) => `${e.type}: ${e.text}`).join(' | ').slice(0, 600);
}

function makeTemp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

async function openPage(browser, url, { focus = true } = {}) {
  const page = await browser.newPage(url);
  if (focus) await page.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await page.waitFor('window.__h && window.__h.ready === true', { timeoutMs: 15000 });
  return page;
}

/** Make `page` hidden by activating `other` (focus emulation off first); returns document.visibilityState. */
async function hide(browser, page, other) {
  await page.send('Emulation.setFocusEmulationEnabled', { enabled: false });
  await browser.send('Target.activateTarget', { targetId: other.targetId });
  for (let i = 0; i < 30; i++) {
    if ((await page.evaluate('document.visibilityState')) === 'hidden') return 'hidden';
    await sleep(100);
  }
  return page.evaluate('document.visibilityState');
}

async function show(browser, page) {
  await browser.send('Target.activateTarget', { targetId: page.targetId });
  for (let i = 0; i < 30; i++) {
    if ((await page.evaluate('document.visibilityState')) === 'visible') return 'visible';
    await sleep(100);
  }
  return page.evaluate('document.visibilityState');
}

// ------------------------------------------------------------------------------------------- probe

const PROBE_FETCH = `(async () => {
  const env = { href: location.href, secure: window.isSecureContext, runtimeId: !!(window.chrome && chrome.runtime && chrome.runtime.id) };
  try {
    const r = await fetch('http://pixelclock.local/api/status', { method: 'GET', cache: 'no-store', credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer' });
    return { env, ok: true, status: r.status, type: r.type, body: await r.text() };
  } catch (e) {
    return { env, ok: false, error: String(e) };
  }
})()`;

async function probeSection(check) {
  const HTTPS_ORIGIN = 'https://0123456789abcdef.localhost';
  const mock = await startMockClock();
  try {
    for (const lan of [false, true]) {
      const tag = lan ? 'clock as a LAN device' : 'clock on loopback';
      const tmp = makeTemp('pcd-probe-');
      let browser = null;
      let srv = null;
      try {
        const ext = path.join(tmp, 'ext');
        fs.mkdirSync(ext);
        fs.writeFileSync(path.join(ext, 'manifest.json'), JSON.stringify({
          manifest_version: 3, name: 'PCD transport probe', version: '1.0.0', chrome_url_overrides: { newtab: 'newtab.html' },
          permissions: ['storage', 'search'], optional_permissions: ['topSites'], host_permissions: ['http://pixelclock.local/*'],
        }, null, 2));
        fs.writeFileSync(path.join(ext, 'newtab.html'), '<!doctype html><meta charset="utf-8"><title>new tab</title>\n');
        fs.mkdirSync(path.join(tmp, 'preview'));
        fs.writeFileSync(path.join(tmp, 'preview', 'index.html'), '<!doctype html><meta charset="utf-8"><title>preview</title>\n');
        srv = await serve(path.join(tmp, 'preview'));
        browser = await chrome.launch({ extensionDebugging: true, clock: mock.port, args: lan ? [`--ip-address-space-overrides=127.0.0.1:${mock.port}=local`] : [] });
        const id = await browser.loadUnpacked(ext);
        const lines = (p) => p.logs.map((l) => l.text);
        const run = async (p) => {
          mock.clearRequests();
          const r = await p.evaluate(PROBE_FETCH);
          await sleep(200);
          return { r, saw: mock.requests.slice(), logs: lines(p) };
        };
        for (const [label, url] of [['extension page', `chrome-extension://${id}/newtab.html`], ['chrome://newtab/ override', 'chrome://newtab/']]) {
          const p = await browser.newPage(url);
          const { r, saw, logs } = await run(p);
          const mixed = logs.some((t) => /mixed content/i.test(t));
          const lna = logs.some((t) => /address space|local network/i.test(t));
          check(`probe (${tag}): ${label} reads the status`, r.ok && r.status === 200 && r.type === 'basic' && r.body === RAW.normal && r.env.runtimeId,
            r.ok ? `${r.status} ${r.type}, body = fixture: ${r.body === RAW.normal}, page ${r.env.href.replace(/[a-p]{32}/, '<id>')}` : r.error);
          check(`probe (${tag}): ${label} sends a bare GET (no Origin, no Referer)`,
            saw.length === 1 && saw[0].method === 'GET' && saw[0].path === '/api/status' && saw[0].host === 'pixelclock.local' && !saw[0].origin && !saw[0].referer,
            saw.map((q) => `${q.method} ${q.path} host=${q.host} origin=${q.origin} referer=${q.referer}`).join('; ') || 'nothing');
          check(`probe (${tag}): ${label}: no mixed content, no Local Network Access prompt`, !mixed && !lna, logs.join(' | ') || 'no log lines');
        }
        const https = await browser.newPage();
        await https.send('Fetch.enable', { patterns: [{ urlPattern: HTTPS_ORIGIN + '/*', requestStage: 'Request' }] });
        https.on('Fetch.requestPaused', (e) => {
          https.send('Fetch.fulfillRequest', { requestId: e.requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'text/html' }],
            body: Buffer.from('<!doctype html><title>w</title>').toString('base64') }).catch(() => {});
        });
        await https.goto(HTTPS_ORIGIN + '/');
        const w = await run(https);
        check(`probe (${tag}): control: a Lively-like https page is refused before sending (Local Network Access)`,
          !w.r.ok && w.saw.length === 0 && w.logs.some((t) => /Permission was denied for this request to access the `(loopback|local)` address space/.test(t)),
          `${w.r.ok ? 'read it' : w.r.error}; clock saw ${w.saw.length}`);
        const pv = await browser.newPage(srv.url + 'index.html');
        const v = await run(pv);
        check(`probe (${tag}): control: an http preview page cannot read the reply (CORS)`,
          !v.r.ok && v.logs.some((t) => /blocked by CORS policy: No 'Access-Control-Allow-Origin'/.test(t)),
          `${v.r.ok ? 'read it' : v.r.error}; clock saw ${v.saw.length} (with Origin ${v.saw[0] && v.saw[0].origin ? 'set' : 'none'})`);
      } finally {
        if (browser) await browser.close();
        if (srv) await srv.close();
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    }
  } finally {
    await mock.close();
  }
}

// ------------------------------------------------------------------------------------------- status

const STATUS_QUERY = '?poll=1500&first=50&active=900&retry=1500&retry2=3000';

/** Wait until the line shows `text`, asking now ('online') only while it does not (no request is left in flight). */
async function lineShows(page, text, timeoutMs = 6000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const st = await page.evaluate('__pcd.status()');
    if (st.text === text && !st.inFlight) return st;
    if (Date.now() > end) return st;
    if (!st.inFlight) await page.evaluate(`window.dispatchEvent(new Event('online'))`);
    await sleep(150);
  }
}

/** One request of our own: wait for one in flight to settle, then 'online' and wait for that answer (or failure). */
const SETTLE = `(async () => {
  const st = () => __pcd.status();
  const nap = () => new Promise((r) => setTimeout(r, 5));
  const t0 = performance.now();
  while (st().inFlight && performance.now() - t0 < 8000) await nap();
  const before = st().ok + st().failures;
  const t1 = performance.now();
  window.dispatchEvent(new Event('online'));
  while (st().ok + st().failures === before && performance.now() - t1 < 8000) await nap();
  return Object.assign(st(), { elapsed: Math.round(performance.now() - t1) });
})()`;

const OBSERVE = (ms) => `(async () => {
  const win = document.getElementById('win');
  let n = 0;
  const mo = new MutationObserver((list) => { for (const m of list) if (m.attributeName === 'class') n++; });
  mo.observe(win, { attributes: true, attributeFilter: ['class'] });
  const p0 = __pcd.status().pulse;
  await new Promise((r) => setTimeout(r, ${ms}));
  mo.disconnect();
  const p1 = __pcd.status().pulse;
  return { mutations: n, flips: p1.flips - p0.flips, timer: p1.timer, cls: win.className };
})()`;

async function statusSection(check) {
  const mock = await startMockClock();
  const tmp = makeTemp('pcd-status-');
  let browser = null;
  try {
    const ext = buildHarness(path.join(tmp, 'ext'));
    browser = await chrome.launch({ extensionDebugging: true, clock: mock.port });
    const id = await browser.loadUnpacked(ext);
    const page = await openPage(browser, `chrome-extension://${id}/harness.html${STATUS_QUERY}`, { focus: false });
    const store = (patch) => page.evaluate(`__h.store.set(${JSON.stringify(patch)}).then(() => true)`);

    // the line for every fixture, 12 h then 24 h, with its kind, tone and spans; the ring only for ringing/testing
    const bad = [];
    const ringBad = [];
    for (const clock24 of [false, true]) {
      await store({ clock24 });
      for (const name of FIXTURES) {
        mock.setScenario(name);
        const want = LINE(name, clock24);
        const text = SHOWN(name, clock24);
        const st = await lineShows(page, text);
        const dom = await page.evaluate(`(() => { const el = document.querySelector('#hud .pcd-status'); const t = el.querySelector('.pcd-status__time');
          return { text: el.textContent, hidden: el.hidden, kind: el.dataset.kind, tone: el.dataset.tone, time: t ? t.textContent : null,
            glyphHidden: el.firstElementChild && el.firstElementChild.getAttribute('aria-hidden'),
            spans: [...el.children].map((c) => c.className), win: document.getElementById('win').className }; })()`);
        if (st.text !== text || dom.text !== text || dom.hidden || dom.kind !== want.kind || dom.tone !== want.tone || dom.time !== want.time ||
          dom.spans[0] !== 'pcd-status__glyph' || dom.glyphHidden !== 'true' || dom.spans[1] !== 'pcd-status__what') {
          bad.push(`${name} ${clock24 ? 24 : 12}h: ${JSON.stringify(dom)}`);
        }
        if (dom.win.includes('pcd-ringing') !== want.ringing) ringBad.push(`${name}: window "${dom.win}"`);
      }
    }
    check('status: the line for every fixture in 12 h and 24 h (its text, the time span, data-kind, data-tone)', bad.length === 0,
      bad.join('\n') || `${FIXTURES.length * 2} lines, e.g. "${SHOWN('normal')}" / "${SHOWN('snoozed', true)}"`);
    check('status: the ring target rings only while the clock rings or tests', ringBad.length === 0, ringBad.join('; ') || 'ringing, testing: pcd-ringing; the rest: none');
    await store({ clock24: false });

    // the pulse: 2 Hz (a flip every 250 ms), steady under reduced motion
    mock.setScenario('ringing');
    await lineShows(page, SHOWN('ringing'));
    const p = await page.evaluate(OBSERVE(2000));
    check('status: ringing pulses the ring target at 2 Hz (pcd-ring-on flips every 250 ms)', p.flips >= 7 && p.flips <= 9 && p.mutations === p.flips && p.timer,
      `${p.flips} flips and ${p.mutations} class changes in 2 s; class "${p.cls}"`);
    await store({ reducedMotion: 'on' });
    const steady = await page.evaluate(OBSERVE(1500));
    check('status: reduced motion holds the ring steady (no flips, no timer)', steady.flips === 0 && steady.mutations === 0 && !steady.timer &&
      steady.cls.includes('pcd-ring-steady') && steady.cls.includes('pcd-ring-on'), `${steady.flips} flips in 1.5 s; class "${steady.cls}"`);
    await store({ reducedMotion: 'off' });

    // two failures in a row: the line stays after one, goes after two (and the ring with it)
    mock.setScenario('error-500');
    const f1 = await page.evaluate(SETTLE);
    const f2 = await page.evaluate(SETTLE);
    const after = await page.evaluate(`({ st: __pcd.status(), win: document.getElementById('win').className, hidden: document.querySelector('#hud .pcd-status').hidden })`);
    check('status: one failure keeps the line; the second hides it silently and stops the ring',
      f1.failures >= 1 && f1.shown && !f2.shown && after.hidden && !after.win.includes('pcd-ringing') && pageErrors(page).length === 0,
      `after 1: shown ${f1.shown} (fails ${f1.fails}); after 2: shown ${f2.shown} (fails ${f2.fails}); window "${after.win}"`);

    // slow: aborted at 2.5 s, by 2.6 s
    mock.setScenario('normal');
    await lineShows(page, SHOWN('normal'));
    mock.setScenario('slow');
    const before = await page.evaluate('__h.fetches.length');
    const slow = await page.evaluate(SETTLE);
    const rec = await page.evaluate(`__h.fetches.slice(${before}).filter((f) => f.abortedAt !== null).map((f) => Math.round(f.abortedAt - f.at))`);
    check('status: a slow clock (5 s) is aborted at 2.5 s, by 2.6 s, quietly', slow.lastError === 'timeout' && rec.length >= 1 && rec[0] >= 2450 && rec[0] <= 2600 &&
      slow.elapsed <= 2700, `abort after ${rec.join(', ')} ms (seen by the page after ${slow.elapsed} ms); lastError ${slow.lastError}`);

    // hidden: no request and no pulse timer; visible again: both carry on
    mock.setScenario('ringing');
    await lineShows(page, SHOWN('ringing'));
    const other = await browser.newPage('about:blank');
    await browser.send('Target.activateTarget', { targetId: page.targetId });
    const vis = await hide(browser, page, other);
    if (vis !== 'hidden') {
      check('status: a hidden tab sends nothing and stops the pulse', null, `the page never became hidden in headless Chrome (${vis}); covered by tests/newtab-status-line.test.mjs`);
    } else {
      const n0 = mock.requests.length;
      const s0 = await page.evaluate('__pcd.status()');
      await sleep(3000);
      const s1 = await page.evaluate('__pcd.status()');
      const n1 = mock.requests.length;
      check('status: a hidden tab sends nothing and stops the pulse (3 s at a 900 ms poll)', n1 === n0 && s1.pulse.flips === s0.pulse.flips && !s1.pulse.timer && s1.visible === false,
        `requests ${n0} -> ${n1}, flips ${s0.pulse.flips} -> ${s1.pulse.flips}, pulse timer ${s1.pulse.timer}`);
      await show(browser, page);
      await sleep(1500);
      const s2 = await page.evaluate('__pcd.status()');
      check('status: visible again, polling and the pulse carry on', mock.requests.length > n1 && s2.pulse.flips > s1.pulse.flips && s2.visible,
        `requests ${n1} -> ${mock.requests.length}, flips ${s1.pulse.flips} -> ${s2.pulse.flips}`);
    }
    await other.close();

    // clockStatus off: hidden, nothing sent; on again: it asks
    await store({ clockStatus: false });
    const off0 = mock.requests.length;
    const offState = await page.evaluate(`({ st: __pcd.status(), win: document.getElementById('win').className })`);
    await sleep(2500);
    const off1 = mock.requests.length;
    check('status: clockStatus off hides the line and sends nothing (2.5 s at a 900 ms poll)', off1 === off0 && !offState.st.shown && !offState.st.enabled &&
      !offState.win.includes('pcd-ringing'), `requests ${off0} -> ${off1}, shown ${offState.st.shown}, window "${offState.win}"`);
    await store({ clockStatus: true });
    await sleep(800);
    check('status: clockStatus on again asks at once (first request 50 ms here, 300 ms in the page)', mock.requests.length > off1, `requests ${off1} -> ${mock.requests.length}`);

    // only GET /api/status, never anything else; no errors but Chrome's network lines
    const kinds = [...new Set(mock.requests.map((q) => `${q.method} ${q.path} ${q.host} origin=${q.origin} referer=${q.referer}`))];
    check('status: only GET /api/status was ever sent (no Origin, no Referer)', kinds.length === 1 && kinds[0] === 'GET /api/status pixelclock.local origin=null referer=null',
      `${mock.requests.length} requests: ${kinds.join('; ')}`);
    const errs = pageErrors(page);
    check('status: no console error, exception or CSP violation (Chrome\'s network lines for the clock allowed)', errs.length === 0, errText(errs) || 'none');
  } finally {
    if (browser) await browser.close();
    await mock.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// ------------------------------------------------------------------------------------------- panel

const DEFAULTS = SETTINGS.defaults(HARNESS_CONFIG, { scope: 'newtab', themes: HARNESS_THEMES });
const FINAL_SHORTCUTS = [
  { label: 'w', url: 'https://www.wikipedia.org' },
  { label: 'bad', url: 'https://example.org' },
  { label: 'cal', url: 'https://cal.example.com' },
];
const FINAL = {
  ...DEFAULTS, clock24: true, city: 'Oslo', units: 'F', sunTimes: false, weather: false, weatherFx: false, theme: 'winter',
  reducedMotion: 'on', performance: 'off', shortcutsMode: 'top', shortcuts: FINAL_SHORTCUTS, clockStatus: false, focusTerminal: false,
};
const FINAL_STORED = { v: 1, ...Object.fromEntries(Object.entries(FINAL).filter(([k, v]) => !isDeepStrictEqual(v, DEFAULTS[k]))) };
const ROW_KINDS = { bool: 'check', clock: 'radio', enum: 'radio', city: 'text', theme: 'select', shortcuts: 'shortcuts' };

// In the page: what a choice shows, from the computed visibility of its mark ("(•) 12 h", "( ) 24 h", "[x] show").
const SHOWN_CHOICE = `function (c) {
  return Array.prototype.map.call(c.querySelectorAll('.pcd-panel__mark > span'), function (s) {
    return getComputedStyle(s).visibility === 'hidden' ? ' ' : s.textContent;
  }).join('') + ' ' + c.querySelector('.pcd-panel__text').textContent;
}`;

/** The sheet as it opens: rows, controls, focus, cursor, words. `opener`: the button's id. */
const SHEET = (opener) => `(() => {
  const shown = ${SHOWN_CHOICE};
  const dlg = document.querySelector('dialog.pcd-panel');
  const a = document.activeElement;
  const auto = dlg.querySelector('select option[value="auto"]');
  return { opened: dlg.open, inPanel: !!a.closest('dialog.pcd-panel'), focusKey: __ui.focusKey(), focusValue: a.value, cursor: __ui.cursor(),
    rows: [...dlg.querySelectorAll('.pcd-panel__row')].map((r) => r.dataset.key + ':' + r.dataset.kind),
    clock: [...dlg.querySelectorAll('.pcd-panel__choice[data-key="clock24"]')].map(shown),
    weather: [...dlg.querySelectorAll('.pcd-panel__row[data-key="weather"] .pcd-panel__choice')].map((c) => c.dataset.key + '=' + shown(c)),
    edit: dlg.querySelector('[data-action="edit"]').textContent, editor: !dlg.querySelector('.pcd-panel__editor').hidden,
    done: dlg.querySelector('.pcd-panel__done').textContent, auto: auto && auto.textContent,
    backdrop: getComputedStyle(dlg, '::backdrop').backgroundColor, expanded: document.querySelector(${JSON.stringify(opener)}).getAttribute('aria-expanded'),
    area: dlg.dataset.area, sync: dlg.querySelector('.pcd-panel__sync').textContent, frame: (() => {
      // the frame's lines, with the words put where the sheet placed them (cells from their offsets)
      const g = __pcd.panel().grid;
      const lines = g.frame.slice();
      const r0 = dlg.getBoundingClientRect();
      const at = (sel) => { const e = dlg.querySelector(sel); const r = e.getBoundingClientRect(); return { c: Math.round((r.left - r0.left) / g.cw), r: Math.round((r.top - r0.top) / g.ch), text: e.textContent }; };
      const put = (w) => { lines[w.r] = lines[w.r].slice(0, w.c) + w.text + lines[w.r].slice(w.c + w.text.length); };
      [at('.pcd-panel__title'), at('.pcd-panel__close'), at('.pcd-panel__sync')].forEach(put);
      const box = [r0.width, r0.height];
      const ok = /^╭─ settings ─+ esc ─╮$/.test(lines[0]) && /^╰─+ synced with chrome ─╯$/.test(lines[lines.length - 1]) &&
        lines.slice(1, -1).every((l) => /^│ *│$/.test(l)) && lines.every((l) => l.length === g.cols) &&
        Math.abs(box[0] - g.cols * g.cw) < 0.01 && Math.abs(box[1] - g.rows * g.ch) < 0.01 && !/solid/.test(getComputedStyle(dlg).borderStyle);
      return { ok, top: lines[0], bottom: lines[lines.length - 1], cols: g.cols, rows: g.rows, box };
    })() };
})()`;

async function panelSection(check) {
  const mock = await startMockClock();
  const tmp = makeTemp('pcd-panel-');
  let browser = null;
  let srv = null;
  try {
    const ext = buildHarness(path.join(tmp, 'ext'));
    const preview = buildHarness(path.join(tmp, 'preview'), { extension: false });
    browser = await chrome.launch({ extensionDebugging: true, clock: mock.port });
    const id = await browser.loadUnpacked(ext);
    const url = `chrome-extension://${id}/harness.html`;
    const B = await openPage(browser, url);
    const A = await openPage(browser, url + '?debounce=5000');
    for (const p of [A, B]) await p.evaluate(UI());

    // B opens its sheet first and keeps it open: it must follow A live
    await B.evaluate('__ui.open()');
    await browser.send('Target.activateTarget', { targetId: A.targetId });
    const opened = await A.evaluate('__ui.open()');
    const first = await A.evaluate(SHEET('#open'));
    const st0 = await A.evaluate('__pcd.panel()');
    const wantRows = SETTINGS.keys('newtab').filter((k) => k !== 'weatherFx').map((k) => `${k}:${ROW_KINDS[SETTINGS.spec(k).kind]}`);
    check('panel: one row per new tab setting in the schema\'s order; "in the scene" shares the weather row',
      isDeepStrictEqual(first.rows, wantRows) && isDeepStrictEqual(first.weather, ['weather=[x] show', 'weatherFx=[x] in the scene']) &&
      isDeepStrictEqual(st0.keys, SETTINGS.keys('newtab')), `${first.rows.join(' ')} | ${first.weather.join(', ')}`);
    check('panel: TUI words: (•) / ( ) radios, [x] boxes, [ edit the 2 links ], [ done ], "auto · <today\'s theme>"',
      isDeepStrictEqual(first.clock, ['(•) 12 h', '( ) 24 h']) && first.edit === '[ edit the 2 links ]' && !first.editor &&
      first.done === '[ done ]' && first.auto === 'auto · autumn forest' && first.rows.includes('focusTerminal:check'), JSON.stringify({ clock: first.clock, edit: first.edit, done: first.done, auto: first.auto }));
    check('panel: the box lines are text on whole cells (╭─ settings ─── esc ─╮ … ╰─── synced with chrome ─╯); title, esc and the storage line sit on the borders',
      first.frame.ok, JSON.stringify(first.frame));
    check('panel: opens as a modal sheet with no veil; focus and the › cursor on the first row; the button says expanded', opened && first.opened &&
      first.inPanel && first.focusKey === 'clock24' && first.focusValue === 'false' && first.cursor === '"› "' && first.expanded === 'true' &&
      first.backdrop === 'rgba(0, 0, 0, 0)', `focus ${first.focusKey}=${first.focusValue}, cursor ${first.cursor}, backdrop ${first.backdrop}, aria-expanded ${first.expanded}`);
    check('panel: shows the stored settings (the config defaults here) and where they live', isDeepStrictEqual(st0.values, DEFAULTS) &&
      first.sync === 'synced with chrome' && first.area === 'sync', `${first.sync}; ${JSON.stringify(st0.values).slice(0, 300)}`);

    // Up / Down move between rows, Left / Right change a radio
    await press(A, 'ArrowDown');
    const nav1 = await A.evaluate('({ key: __ui.focusKey(), cursor: __ui.cursor() })');
    await press(A, 'ArrowDown');
    const nav2 = await A.evaluate('__ui.focusKey()');
    await press(A, 'ArrowRight');
    const nav3 = await A.evaluate('({ key: __ui.focusKey(), units: __pcd.settings().units })');
    await press(A, 'ArrowUp');
    const nav4 = await A.evaluate('__ui.focusKey()');
    check('panel: Up and Down move between rows (the › follows); Left and Right change a radio', nav1.key === 'city' && nav1.cursor === '"› "' &&
      nav2 === 'units' && nav3.key === 'units' && nav3.units === 'F' && nav4 === 'city', JSON.stringify({ nav1, nav2, nav3, nav4 }));

    // every other setting through the UI
    await A.evaluate(`(__ui.pick('clock24', 'true'), __ui.tick('sunTimes'), __ui.tick('weatherFx'), __ui.tick('weather'),
      __ui.choose('theme', 'winter'), __ui.pick('reducedMotion', 'on'), __ui.pick('performance', 'off'), __ui.tick('focusTerminal'), true)`);
    const fx = await A.evaluate(`({ disabled: __ui.field('weatherFx').disabled, wrap: __ui.ctl('weatherFx').hasAttribute('data-disabled') })`);
    check('panel: "in the scene" is disabled while the weather is off', fx.disabled && fx.wrap, JSON.stringify(fx));
    await A.evaluate(`__ui.focus(__ui.field('city'))`);
    await typeText(A, 'Osl');
    await press(A, 'o');
    await press(A, 'Enter');
    const city = await A.evaluate(`({ city: __pcd.settings().city, keys: __h.keys, open: __pcd.panel().open })`);
    check('panel: the city is typed and committed with Enter; no key reaches the page', city.city === 'Oslo' && city.keys === 0 && city.open,
      `city ${JSON.stringify(city.city)}, keys seen by the page ${city.keys}, still open ${city.open}`);

    // the shortcut editor, behind its button
    await A.evaluate(`__ui.click('[data-action="edit"]')`);
    const editor = await A.evaluate(`({ open: __pcd.panel().editor, focus: document.activeElement.className, expanded: document.querySelector('[data-action="edit"]').getAttribute('aria-expanded') })`);
    await A.evaluate(`__ui.focus(__ui.item(0, 'label'))`);
    await typeText(A, 'w');
    await press(A, 'Tab');
    await A.evaluate(`document.querySelector('.pcd-panel__add').click()`);
    await typeText(A, 'cal');
    await press(A, 'Tab');
    await typeText(A, 'cal.example.com');
    await press(A, 'Tab');
    const added = await A.evaluate('__pcd.settings().shortcuts');
    await A.evaluate(`document.querySelector('.pcd-panel__add').click()`);
    await typeText(A, 'bad');
    await press(A, 'Tab');
    await typeText(A, 'not a url');
    await press(A, 'Tab');
    const invalid = await A.evaluate(`({ list: __pcd.settings().shortcuts, st: __pcd.panel(),
      note: document.querySelectorAll('.pcd-panel__item')[3].querySelector('.pcd-panel__item-note').textContent,
      aria: __ui.item(3, 'url').getAttribute('aria-invalid') })`);
    check('panel: links: "[ edit ... ]" opens the editor at the first name; an edited name and an added row are stored (https:// added)',
      editor.open && /pcd-panel__item-label/.test(editor.focus) && editor.expanded === 'true' && isDeepStrictEqual(added, [
        { label: 'w', url: 'https://www.wikipedia.org' }, { label: 'mdn', url: 'https://developer.mozilla.org' }, { label: 'cal', url: 'https://cal.example.com' }]),
    `${JSON.stringify(editor)} ${JSON.stringify(added)}`);
    check('panel: links: an invalid address is marked and nothing is stored until it is fixed', invalid.list.length === 3 && invalid.aria === 'true' &&
      /spaces/.test(invalid.note) && invalid.st.notes.shortcuts === 'fix the marked link to save the list' && invalid.st.draftDirty,
    `stored ${invalid.list.length}; note "${invalid.note}"; sheet note "${invalid.st.notes.shortcuts}"`);
    await A.evaluate(`__ui.focus(__ui.item(3, 'url'))`);
    await typeText(A, 'example.org');
    await press(A, 'Tab');
    await A.evaluate(`(__ui.act(3, 'up'), __ui.act(1, 'remove'), true)`);
    const edited = await A.evaluate(`({ list: __pcd.settings().shortcuts, st: __pcd.panel(), nums: [...document.querySelectorAll('.pcd-panel__num')].map((n) => n.textContent),
      ups: [...document.querySelectorAll('[data-action="up"]')].map((b) => b.disabled), edit: document.querySelector('[data-action="edit"]').textContent })`);
    check('panel: links: fixed, moved up, removed: stored in the new order, renumbered, the button counts 3', isDeepStrictEqual(edited.list, FINAL_SHORTCUTS) &&
      !edited.st.notes.shortcuts && isDeepStrictEqual(edited.nums, ['[1]', '[2]', '[3]']) && isDeepStrictEqual(edited.ups, [true, false, false]) &&
      edited.edit === '[ edit the 3 links ]', `${JSON.stringify(edited.list)}; ${edited.nums.join(' ')}; ${edited.edit}`);

    // surprise, top sites refused then granted, the clock status switch
    await A.evaluate(`document.querySelector('[data-action="surprise"]').click()`);
    await A.evaluate(`(__h.top = 'no', __ui.pick('shortcutsMode', 'top'), true)`);
    await sleep(100);
    const refused = await A.evaluate(`({ mode: __pcd.settings().shortcutsMode, shown: __pcd.panel().values.shortcutsMode, note: __pcd.panel().notes.shortcutsMode, surprises: __h.surprises })`);
    check('panel: "[ ☼ surprise me ]" calls the page; top sites refused -> stays custom with a note', refused.surprises === 1 && refused.mode === 'custom' &&
      refused.shown === 'custom' && refused.note === 'top sites need the permission; still showing my links', JSON.stringify(refused));
    await A.evaluate(`(__h.top = 'yes', __ui.pick('shortcutsMode', 'top'), true)`);
    await sleep(100);
    await A.evaluate(`__ui.tick('clockStatus')`);
    const granted = await A.evaluate(`({ mode: __pcd.settings().shortcutsMode, rowHidden: __ui.row('shortcuts').hidden, line: __pcd.status().shown, enabled: __pcd.status().enabled })`);
    check('panel: top sites granted -> stored, the editor row hides; clockStatus off hides the line at once', granted.mode === 'top' && granted.rowHidden &&
      !granted.line && !granted.enabled, JSON.stringify(granted));

    // Esc closes, gives focus back; the store is flushed: exactly the overrides in chrome.storage.sync. Tab A runs
    // with a 5 s write debounce, so only the flush on close can have written within 1.5 s of closing.
    const pendingBefore = await A.evaluate('__h.store.status().pending.length');
    await press(A, 'Escape');
    await A.waitFor('!__pcd.panel().open && __h.toggles.length === 2', { timeoutMs: 3000 }).catch(() => false);
    const closedAt = Date.now();
    const closed = await A.evaluate(`({ focus: document.activeElement.id, expanded: document.getElementById('open').getAttribute('aria-expanded'), toggles: __h.toggles, keys: __h.keys })`);
    check('panel: Esc closes it and gives the focus back to the settings button', closed.focus === 'open' && closed.expanded === 'false' &&
      isDeepStrictEqual(closed.toggles, [true, false]) && closed.keys === 0, JSON.stringify(closed));
    let stored = null;
    while (Date.now() - closedAt < 1500) {
      stored = await A.evaluate(`chrome.storage.sync.get(null)`);
      if (isDeepStrictEqual(stored, { settings: FINAL_STORED })) break;
      await sleep(100);
    }
    check('panel: chrome.storage.sync holds exactly the overrides, flushed on close (debounce 5 s here)', pendingBefore > 0 && isDeepStrictEqual(stored, { settings: FINAL_STORED }),
      `${pendingBefore} keys pending before Esc; written ${Date.now() - closedAt} ms after closing: ${JSON.stringify(stored)}`);

    // the other tab (sheet open all along) follows; a new tab reads the same and closes with [ done ]
    let bValues = null;
    const endB = Date.now() + 5000;
    while (Date.now() < endB) {
      bValues = await B.evaluate('({ panel: __pcd.panel().values, settings: __pcd.settings(), open: __pcd.panel().open })');
      if (isDeepStrictEqual(bValues.panel, FINAL)) break;
      await sleep(150);
    }
    check('panel: the other tab\'s open sheet follows every change live (chrome.storage.onChanged)', isDeepStrictEqual(bValues.panel, FINAL) &&
      isDeepStrictEqual(bValues.settings, FINAL) && bValues.open, JSON.stringify(bValues.panel).slice(0, 300));
    const C = await openPage(browser, url);
    await C.evaluate(UI());
    await C.evaluate('__ui.open()');
    const cValues = await C.evaluate('__pcd.panel().values');
    await C.evaluate(`__ui.click('.pcd-panel__done')`);
    await C.waitFor('!__pcd.panel().open && __h.toggles.length === 2', { timeoutMs: 3000 }).catch(() => false);
    const cClosed = await C.evaluate(`({ focus: document.activeElement.id, toggles: __h.toggles })`);
    check('panel: a new tab opens with the stored settings; [ done ] closes it and gives the focus back', isDeepStrictEqual(cValues, FINAL) &&
      cClosed.focus === 'open', `${JSON.stringify(cValues).slice(0, 200)}; focus ${cClosed.focus}`);
    await browser.send('Target.activateTarget', { targetId: A.targetId });
    await A.evaluate('__ui.open()');
    const reopened = await A.evaluate(`({ v: __pcd.panel().values, items: document.querySelectorAll('.pcd-panel__item').length, editor: __pcd.panel().editor })`);
    check('panel: reopened, it shows what is stored (no leftover draft rows, the editor closed)', isDeepStrictEqual(reopened.v, FINAL) && reopened.items === 3 &&
      !reopened.editor, `${reopened.items} rows, editor ${reopened.editor}`);
    // the page's placement: over the console column at its one text size, in whole cells; then
    // centred again in the page's own font
    const placed = await A.evaluate(`(() => {
      const dlg = document.getElementById('settings-panel');
      const box = () => { const r = dlg.getBoundingClientRect(); return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)]; };
      __h.panel.setRect({ x: 40, y: 30, w: 504, h: 560 }, { fontPx: 18, cell: { w: 10.5, h: 21, ls: -0.05 } });
      const at = { box: box(), font: getComputedStyle(dlg).fontSize, line: getComputedStyle(dlg).lineHeight, ls: getComputedStyle(dlg).letterSpacing,
        placed: dlg.dataset.placed, grid: __pcd.panel().grid };
      __h.panel.setRect(null);
      const r = dlg.getBoundingClientRect();
      const back = { font: getComputedStyle(dlg).fontSize, placed: dlg.dataset.placed || null, centred: Math.abs(r.left + r.width / 2 - innerWidth / 2) <= 1 };
      return { at, back };
    })()`);
    check('panel: setRect() places the sheet where the page says, in whole cells of its text size (504 x 560 px -> 48 x 26 cells); null centres it again',
      isDeepStrictEqual(placed.at.box, [40, 30, 504, 546]) && placed.at.grid.cols === 48 && placed.at.grid.rows === 26 && placed.at.font === '18px' &&
      placed.at.line === '21px' && placed.at.ls === '-0.05px' && placed.at.placed === '1' && placed.back.placed === null && placed.back.centred &&
      placed.back.font !== '18px', JSON.stringify({ at: { ...placed.at, grid: placed.at.grid && [placed.at.grid.cols, placed.at.grid.rows] }, back: placed.back }));
    for (const [name, p] of [['A', A], ['B', B], ['C', C]]) {
      const errs = pageErrors(p);
      check(`panel: tab ${name}: no console error, exception or CSP violation`, errs.length === 0, errText(errs) || 'none');
    }

    // preview pages: localStorage, the storage event, no clock requests, a sample line
    srv = await serve(preview);
    const P1 = await openPage(browser, srv.url + 'harness.html?top=default');
    const P2 = await openPage(browser, srv.url + 'harness.html?top=default');
    await P1.evaluate(UI());
    await P1.evaluate('__ui.open()');
    const pv = await P1.evaluate(`({ area: document.getElementById('settings-panel').dataset.area, sync: __pcd.panel().sync, status: __pcd.status() })`);
    await P1.evaluate(`__ui.focus(__ui.field('city'))`);
    await typeText(P1, 'Rome');
    await press(P1, 'Enter');
    await P1.evaluate(`(__ui.pick('performance', 'off'), __ui.pick('shortcutsMode', 'top'), true)`);
    await sleep(150);
    const topNote = await P1.evaluate('({ note: __pcd.panel().notes.shortcutsMode, mode: __pcd.settings().shortcutsMode })');
    await press(P1, 'Escape');
    await P1.waitFor('!__pcd.panel().open', { timeoutMs: 3000 });
    let ls = null;
    const endP = Date.now() + 5000;
    while (Date.now() < endP) {
      ls = await P1.evaluate(`localStorage.getItem('pcd.sync.settings')`);
      if (ls && isDeepStrictEqual(JSON.parse(ls), { v: 1, city: 'Rome', performance: 'off' })) break;
      await sleep(150);
    }
    check('panel: preview (127.0.0.1, no chrome.runtime.id): saved in localStorage, said so on the bottom border', pv.area === 'preview' &&
      pv.sync === 'preview: saved in this browser' && ls !== null && isDeepStrictEqual(JSON.parse(ls), { v: 1, city: 'Rome', performance: 'off' }),
    `${pv.sync}; pcd.sync.settings = ${ls}`);
    check('panel: preview: top sites are refused with a note (no chrome.permissions there)', topNote.mode === 'custom' &&
      topNote.note === 'top sites work in the installed extension only', JSON.stringify(topNote));
    await P2.waitFor(`__pcd.settings().city === 'Rome' && __pcd.settings().performance === 'off'`, { timeoutMs: 5000 }).catch(() => false);
    const p2 = await P2.evaluate('__pcd.settings()');
    check('panel: preview: another preview tab follows (storage event)', p2.city === 'Rome' && p2.performance === 'off', `${p2.city} ${p2.performance}`);
    const P3 = await openPage(browser, srv.url + 'harness.html?status=ringing');
    const sample = await P3.evaluate(`({ text: document.querySelector('#hud .pcd-status').textContent, win: document.getElementById('win').className, st: __pcd.status() })`);
    const previewAsked = mock.requests.filter((q) => q.origin && q.origin.startsWith(srv.url.replace(/\/$/, '')));
    check('panel: preview pages never ask the clock; ?status=ringing shows the sample and rings', pv.status.preview && !pv.status.requests && previewAsked.length === 0 &&
      sample.text === '⌂ ringing · work' && sample.win.includes('pcd-ringing') && sample.st.requests === 0,
    `preview requests ${previewAsked.length}; sample "${sample.text}", window "${sample.win}"`);
    for (const [name, p] of [['P1', P1], ['P2', P2], ['P3', P3]]) {
      const errs = pageErrors(p);
      check(`panel: preview tab ${name}: no console error or exception`, errs.length === 0, errText(errs) || 'none');
    }
  } finally {
    if (browser) await browser.close();
    if (srv) await srv.close();
    await mock.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// ------------------------------------------------------------------------------------------- the real page

/** Records, from document creation on, the first change of <html>'s class/style (boot.js applying the mirror: reduced
 *  motion only, a class; boot.js never sets a style, so the first paint is bg). */
const FIRST_PAINT_PROBE = `(() => {
  window.__firstHtml = null;
  new MutationObserver(function (list, mo) {
    for (const m of list) {
      if (m.target !== document.documentElement || window.__firstHtml) continue;
      window.__firstHtml = { cls: document.documentElement.className, style: document.documentElement.getAttribute('style') || '',
        appRan: !!(window.PCD && window.PCD.ntp), search: location.search };
      mo.disconnect();
    }
  }).observe(document, { attributes: true, subtree: true, attributeFilter: ['class', 'style'] });
})();`;

/** The new tab built with the plugin and the neutral example config (Berlin, sample links) into `into`. */
async function buildNewtab(into) {
  try {
    const B = await import(new URL('./build.mjs', import.meta.url).href);
    const NB = await import(new URL('./build/newtab.mjs', import.meta.url).href);
    const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'user.example.json'), 'utf8'));
    const gen = await B.generateStage({ root: ROOT, config, vendor: path.join(ROOT, 'vendor', 'pixelclock') });
    const ctx = B.createContext({ root: ROOT, dist: into, config, tokens: gen.tokens, anchors: gen.anchors, generated: gen.generated, render: false, piece: 'newtab', log: () => {} });
    await NB.build(ctx);
    return { code: 0, dir: path.join(into, NB.OUT), log: '' };
  } catch (e) {
    return { code: 1, dir: null, log: e && e.stack ? e.stack : String(e) };
  }
}

/** The console's "≡ settings" button and the terminal's input in the real page. */
const SETTINGS_BUTTON = '#console .pcd-settings';
const TERM_INPUT = '#console input';

async function pageSection(check, pageDir) {
  const tmp = makeTemp('pcd-page-');
  let dir = pageDir ? path.resolve(ROOT, pageDir) : null;
  const mock = await startMockClock();
  let browser = null;
  try {
    if (!dir) {
      const b = await buildNewtab(tmp);
      if (b.code !== 0) {
        check('page: the real new tab builds (the newtab plugin, the example config, into a temp folder)', false, b.log.split('\n').slice(0, 4).join(' / '));
        return;
      }
      dir = b.dir;
    }
    if (!fs.existsSync(path.join(dir, 'manifest.json')) || !fs.existsSync(path.join(dir, 'newtab.html'))) {
      check('page: the real new tab wires the status line and the sheet', null, `no built new tab at ${dir}`);
      return;
    }
    const html = fs.readFileSync(path.join(dir, 'newtab.html'), 'utf8');
    const wired = ['js/ntp-status.js', 'js/ntp-panel.js', 'js/ntp-links.js', 'js/ntp-app.js', 'js/pcd-console.js', 'css/ntp-panel.css', 'css/pcd-console.css']
      .filter((f) => !html.includes(`"${f}"`));
    check('page: newtab.html loads the console, the status line, the sheet, the links and the app', wired.length === 0, wired.length ? `missing: ${wired.join(', ')}` : 'all seven');
    browser = await chrome.launch({ extensionDebugging: true, clock: mock.port, weather: 'mock' });
    const id = await browser.loadUnpacked(dir);
    const page = await browser.newPage('about:blank');
    await page.send('Emulation.setFocusEmulationEnabled', { enabled: true });
    await page.send('Page.navigate', { url: 'chrome://newtab/' });
    const ready = await page.waitFor(`document.documentElement.dataset.ready === '1' && location.search === '?focus' && !!(window.__pcd && __pcd.state().term)`, { timeoutMs: 15000 })
      .then(() => true, () => false);
    if (!ready) {
      const st = await page.evaluate(`({ ready: document.documentElement.dataset.ready, href: location.href, state: window.__pcd && __pcd.state() })`).catch((e) => ({ error: e.message }));
      check('page: the real new tab starts (the redirect to ?focus, data-ready, the terminal)', false, JSON.stringify(st) + ' ' + errText(pageErrors(page)));
      return;
    }
    await page.evaluate(UI(SETTINGS_BUTTON));
    const clock24 = (await page.evaluate('__pcd.settings().clock24')) === true;

    // the line from the mock clock, drawn by the console under the app's own hook
    await page.waitFor(`__pcd.lines().status === ${JSON.stringify(SHOWN('normal', clock24))}`, { timeoutMs: 8000 }).catch(() => false);
    const line = await page.evaluate('({ shown: __pcd.lines().status, hook: __pcd.status() && __pcd.status().text, view: __pcd.view().status })');
    check('page: the console shows the clock\'s line, also through __pcd.status()', line.shown === SHOWN('normal', clock24) &&
      line.hook === SHOWN('normal', clock24) && line.view && line.view.show, JSON.stringify({ shown: line.shown, hook: line.hook }));
    mock.setScenario('ringing');
    await page.evaluate(`window.dispatchEvent(new Event('online'))`);
    await page.waitFor(`__pcd.status().ringing === true`, { timeoutMs: 5000 }).catch(() => false);
    const ring = await page.evaluate(`(async () => {
      const seen = new Set();
      const t0 = performance.now();
      while (performance.now() - t0 < 1200) {
        seen.add(document.getElementById('console').classList.contains('pcd-ring-on') ? 'on' : 'off');
        await new Promise((r) => setTimeout(r, 50));
      }
      return { st: __pcd.status(), app: !!(PCD.ntp && PCD.ntp.view().ringing), console: __pcd.console().ringing, seen: [...seen], line: __pcd.lines().status };
    })()`);
    check('page: ringing: the line in accent, the app\'s view says ringing and the console pulses at 2 Hz', ring.st.ringing && ring.st.tone === 'accent' &&
      ring.app && ring.console && ring.seen.length === 2 && ring.line === SHOWN('ringing', clock24), `tone ${ring.st.tone}, app ${ring.app}, console ${ring.console}, pulse ${ring.seen.join('/')}; ${ring.line}`);
    mock.setScenario('normal');

    // the sheet through the console's "≡ settings"
    const open = await page.evaluate('__ui.open()');
    const sheet = await page.evaluate(SHEET(SETTINGS_BUTTON));
    const placed = await page.evaluate('({ panel: __pcd.panel(), info: __pcd.console() })');
    check('page: "≡ settings" opens the sheet over the column at the first row; auto names today\'s theme; the column hides', open && sheet.opened &&
      sheet.focusKey === 'clock24' && sheet.expanded === 'true' && /^auto · [a-z]/.test(sheet.auto) && sheet.rows.length === SETTINGS.keys('newtab').length - 1 &&
      placed.panel.placed && placed.info.sheet && sheet.frame.ok,
    `focus ${sheet.focusKey}, auto "${sheet.auto}", ${sheet.rows.length} rows, aria-expanded ${sheet.expanded}, placed ${placed.panel.placed}, frame ${sheet.frame.top}`);
    await page.evaluate(`(__ui.tick('clockStatus'), __ui.tick('focusTerminal'), true)`);
    const off = await page.evaluate(`({ line: __pcd.lines().status, enabled: __pcd.status().enabled, focus: __pcd.settings().focusTerminal })`);
    await press(page, 'Escape');
    // the dialog's close event (aria-expanded, the focus, the flush) runs a task after dialog.open turns false
    await page.waitFor(`!document.querySelector('dialog.pcd-panel').open && document.querySelector(${JSON.stringify(SETTINGS_BUTTON)}).getAttribute('aria-expanded') === 'false'`,
      { timeoutMs: 3000 }).catch(() => false);
    await sleep(100);
    const after = await page.evaluate(`({ term: document.activeElement === document.querySelector(${JSON.stringify(TERM_INPUT)}),
      expanded: document.querySelector(${JSON.stringify(SETTINGS_BUTTON)}).getAttribute('aria-expanded'), mirror: localStorage.getItem('pcd.mirror'), column: !__pcd.console().sheet })`);
    let stored = null;
    const end = Date.now() + 3000;
    while (Date.now() < end) {
      stored = await page.evaluate(`chrome.storage.sync.get('settings')`);
      if (stored.settings && stored.settings.clockStatus === false && stored.settings.focusTerminal === false) break;
      await sleep(100);
    }
    check('page: the sheet\'s clockStatus switch hides the line and stops the client at once', off.line === null && off.enabled === false && off.focus === false, JSON.stringify(off));
    check('page: Esc closes the sheet, the column shows and the terminal has the keys; the settings are in chrome.storage.sync', after.term && after.column &&
      after.expanded === 'false' && stored.settings && stored.settings.clockStatus === false && stored.settings.focusTerminal === false,
    `${JSON.stringify(stored)}; terminal focused ${after.term}, aria-expanded ${after.expanded}`);

    // the next open, with focusTerminal off, stays the one document Chrome opened (no redirect) and paints bg first:
    // nothing colours <html> before the scene
    const next = await browser.newPage('about:blank');
    await next.send('Page.addScriptToEvaluateOnNewDocument', { source: FIRST_PAINT_PROBE });
    await next.send('Page.navigate', { url: 'chrome://newtab/' });
    await next.waitFor(`document.documentElement.dataset.ready === '1'`, { timeoutMs: 15000 }).catch(() => false);
    await sleep(300);
    const firstHtml = await next.evaluate('window.__firstHtml');
    const nextUrl = await next.evaluate('location.href');
    const htmlBg = await next.evaluate('getComputedStyle(document.documentElement).backgroundColor');
    const mirror = after.mirror ? JSON.parse(after.mirror) : {};
    check('page: the next tab paints bg first (boot.js puts no style on <html>) and does not redirect (focusTerminal off)',
      mirror.focusTerminal === false && (!firstHtml || firstHtml.appRan || !firstHtml.style) && htmlBg === 'rgb(20, 16, 22)' &&
      nextUrl === `chrome-extension://${id}/newtab.html`, `first <html> change: ${JSON.stringify(firstHtml)}; background ${htmlBg}; ${nextUrl}; mirror ${after.mirror}`);

    const kinds = [...new Set(mock.requests.map((q) => `${q.method} ${q.path} origin=${q.origin}`))];
    check('page: only GET /api/status went to the clock (no Origin)', kinds.length === 1 && kinds[0] === 'GET /api/status origin=null', kinds.join('; '));
    for (const [name, p] of [['first tab', page], ['next tab', next]]) {
      const errs = pageErrors(p).concat((await p.evaluate('(window.__pcd && __pcd.state().csp) || []')).map((v) => ({ type: 'csp', text: JSON.stringify(v) })));
      check(`page: ${name}: no console error, exception or CSP violation`, errs.length === 0, errText(errs) || 'none');
    }
    check('page: the privacy guard blocked nothing (the sample city only)', browser.violations.length === 0, `${browser.violations.length} blocked`);
  } finally {
    if (browser) await browser.close();
    await mock.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// ------------------------------------------------------------------------------------------- main

export function parseArgs(argv) {
  const o = { only: null, page: null, help: false, errors: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--probe') o.only = ['probe'];
    else if (a === '--only') o.only = String(argv[++i] || '').split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--page') o.page = argv[++i] || null;
    else if (a === '-h' || a === '--help') o.help = true;
    else o.errors.push(`unknown argument ${a}`);
  }
  for (const s of o.only || []) if (!SECTIONS.includes(s)) o.errors.push(`unknown section ${s} (known: ${SECTIONS.join(', ')})`);
  return o;
}

export async function run({ only = null, page = null, log = () => {} } = {}) {
  const rows = [];
  const check = (name, pass, detail = '') => {
    rows.push({ name, pass, detail: String(detail) });
    log(`${pass === null ? 'SKIP' : pass ? 'PASS' : 'FAIL'}  ${name}`);
  };
  const want = only || ['status', 'panel', 'page'];
  if (!chrome.findBrowser()) {
    check('headless Chrome', null, 'no Chrome or Edge installed');
    return rows;
  }
  const sections = { probe: () => probeSection(check), status: () => statusSection(check), panel: () => panelSection(check), page: () => pageSection(check, page) };
  for (const s of SECTIONS) {
    if (!want.includes(s)) continue;
    try {
      await sections[s]();
    } catch (e) {
      check(`${s}: ran to the end`, false, e && e.stack ? e.stack.split('\n').slice(0, 4).join(' / ') : String(e));
    }
  }
  return rows;
}

function isMain() {
  return process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isMain()) {
  const o = parseArgs(process.argv.slice(2));
  if (o.help || o.errors.length) {
    for (const e of o.errors) console.error(e);
    console.log('usage: node tools/test-newtab-status.mjs [--probe] [--only probe,status,panel,page] [--page <built newtab dir>]');
    process.exitCode = o.errors.length ? 2 : 0;
  } else {
    const t0 = Date.now();
    const rows = await run({ only: o.only, page: o.page, log: (l) => console.log(l) });
    console.log('');
    const s = printReport(rows, { title: `new tab: clock status and settings panel, ${((Date.now() - t0) / 1000).toFixed(1)} s` });
    if (s.failed) process.exitCode = 1;
  }
}
