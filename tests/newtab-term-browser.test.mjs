// The terminal in headless Chrome with real key events (CDP Input.dispatchKeyEvent): src/newtab/js/term/ mounted in a
// stand-in for the console's slot (section.pcd-term inside .pcd-console, with pcd-console.css: the real look) on a
// stubbed app that records every call and never navigates. Links by number and name, addresses, searches, commands,
// history, Tab and the ghost, the caret over a ghost, Ctrl/Alt/Meta combinations never prevented, IME composition,
// paste anywhere, the caret's blink (and none while blurred or under reduced motion, live changes included), the
// scrolled fade with the prompt kept as the last row, a terminal standing alone, and zero console errors.
// The page is built in a temp folder and served on 127.0.0.1 (tools/lib/serve.mjs); Chrome through tools/lib/chrome.mjs
// (fresh temp profile, privacy guard on); no request leaves 127.0.0.1. Sample data: config/user.example.json's links.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';

function findRoot(dir) {
  for (let d = dir; ; d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, 'tools', 'build.mjs'))) return d;
    if (path.dirname(d) === d) throw new Error('repo root not found');
  }
}
const ROOT = findRoot(path.dirname(fileURLToPath(import.meta.url)));
const tool = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------------------------------------ the page

const PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>terminal</title>
<link rel="stylesheet" href="css/tokens.css">
<link rel="stylesheet" href="css/pcd-base.css">
<link rel="stylesheet" href="css/pcd-console.css">
<link rel="stylesheet" href="css/ntp-term.css">
<link rel="stylesheet" href="css/page.css">
SCRIPTS
</head>
<body>
<div class="pcd-console pcd-ready" id="con">
  <div class="pcd-col" id="col"><section class="pcd-term" id="slot" aria-label="terminal"></section></div>
  <div id="empty"></div>
</div>
<p id="other"><a id="link" href="#x">a link</a> <button id="btn" type="button">a button</button></p>
<dialog id="dlg"><input id="field" type="text"></dialog>
</body>
</html>
`;

const PAGE_CSS = `@font-face { font-family: TermMono; src: url('../fonts/CascadiaMono-wght.ttf') format('truetype'); font-weight: 200 700; }
html, body { height: 100%; overflow: hidden; }
#con { width: 100%; height: 100%; font-size: 18px; }
#empty { position: absolute; left: 600px; top: 40px; width: 300px; height: 200px; }
#other { position: absolute; left: 600px; top: 300px; margin: 0; }
`;

// the stubbed app: records calls, never navigates; links from config/user.example.json; storage in localStorage
const PAGE_JS = `(function () {
  'use strict';
  var calls = window.__calls = [];
  var mods = window.__mods = [];
  window.addEventListener('keydown', function (e) {
    if (e.ctrlKey || e.altKey || e.metaKey) mods.push({ key: e.key, prevented: e.defaultPrevented });
  });
  var THEMES = [['winter', 'Snowy hills', 'season'], ['spring', 'Spring meadow', 'season'], ['summer', 'Summer beach', 'season'],
    ['autumn', 'Autumn forest', 'season'], ['newyear', "New Year's Eve", 'holiday'], ['lunarnewyear', 'Lunar New Year', 'holiday'],
    ['valentines', "Valentine's Day", 'holiday'], ['stpatricks', "St. Patrick's Day", 'holiday'], ['easter', 'Easter', 'holiday'],
    ['july4', 'Fourth of July', 'holiday'], ['halloween', 'Haunted hill', 'holiday'], ['thanksgiving', 'Harvest field', 'holiday'],
    ['christmas', 'Christmas cabin', 'holiday']].map(function (t) { return { id: t[0], name: t[1].toLowerCase(), kind: t[2] }; });
  var scene = { id: 'autumn', name: 'autumn forest', tag: 'auto' };
  var clock24 = false;
  var LINKS = LINKS_JSON;
  function info() { return { id: scene.id, name: scene.name, tag: scene.tag }; }
  var app = {
    links: function () { return LINKS.map(function (l) { return { name: l.label, url: l.url }; }); },
    openUrl: function (url, newTab) { calls.push(['openUrl', url, !!newTab]); return Promise.resolve({ did: 'navigate' }); },
    search: function (text, newTab) { calls.push(['search', text, !!newTab]); return Promise.resolve({ did: 'search' }); },
    theme: function (x) {
      if (x === 'list') return THEMES.slice();
      calls.push(['theme', x]);
      var t = THEMES.filter(function (e) { return e.id === (x === 'auto' ? 'autumn' : x); })[0];
      scene = { id: t.id, name: t.name, tag: x === 'auto' ? 'auto' : 'pinned' };
      return new Promise(function (r) { setTimeout(function () { r(info()); }, 300); });
    },
    surprise: function () { calls.push(['surprise']); scene = { id: 'halloween', name: 'haunted hill', tag: 'surprise' }; return info(); },
    shake: function () { calls.push(['shake']); },
    setClock24: function (b) { calls.push(['setClock24', !!b]); clock24 = !!b; return new Promise(function (r) { setTimeout(r, 300); }); },
    openSettings: function () { calls.push(['openSettings']); },
    view: function () {
      return { now: new Date(2026, 10, 15, 20, 40).getTime(), clock24: clock24, id: scene.id, name: scene.name, tag: scene.tag,
        phase: 'night', sun: { rise: 7.45, set: 16.25 },
        weather: { data: { temp: 46, feels: 41, wind: 9, high: 49, low: 41, kind: 'drizzle', description: 'drizzle', isDay: false }, units: 'F', city: 'Berlin', ageMs: 0 },
        status: PCD.status.describe(PCD.status.sample('normal'), { clock24: clock24 }) };
    },
    storage: {
      get: function (k) { try { return JSON.parse(localStorage.getItem('test.' + k) || 'null'); } catch (e) { return null; } },
      set: function (k, v) { localStorage.setItem('test.' + k, JSON.stringify(v)); }
    }
  };
  var reduced = false;
  window.__setReduced = function (b) { reduced = !!b; };
  function start() {
    var con = document.getElementById('con');
    var probe = document.createElement('span');
    probe.style.cssText = 'position:absolute;visibility:hidden;white-space:pre;line-height:normal;letter-spacing:0';
    probe.textContent = new Array(101).join('M');
    con.appendChild(probe);
    var r = probe.getBoundingClientRect();
    probe.remove();
    var dpr = window.devicePixelRatio || 1;
    var adv = r.width / 100;
    var cell = { w: Math.floor(adv * dpr + 1e-6) / dpr, h: Math.floor(r.height * dpr + 1e-6) / dpr };
    cell.ls = cell.w - adv;
    con.style.setProperty('--cell-w', cell.w + 'px');
    con.style.setProperty('--cell-h', cell.h + 'px');
    con.style.setProperty('--cell-ls', cell.ls + 'px');
    var slot = document.getElementById('slot');
    var cols = 44, rows = 12;
    slot.style.left = 4 * cell.w + 'px';
    slot.style.top = 2 * cell.h + 'px';
    slot.style.width = cols * cell.w + 'px';
    slot.style.height = rows * cell.h + 'px';
    slot.setAttribute('data-cols', String(cols));
    slot.setAttribute('data-rows', String(rows));
    window.__term = PCD.term.mount({ el: slot, cols: cols, rows: rows, cell: cell }, app, { reducedMotion: function () { return reduced; } });
    document.documentElement.setAttribute('data-ready', '1');
  }
  document.fonts.load('400 18px TermMono').then(start, start);
})();
`;

const TERM_SCRIPTS = ['lib/format.js', 'lib/parse.js', 'lib/url.js', 'lib/calc.js', 'lib/history.js', 'lib/aliases.js',
  'lib/router.js', 'lib/complete.js', 'term-commands.js', 'term-url.js', 'term-shell.js', 'term-ui.js'];

async function buildPage() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pcd-term-page-'));
  const put = (rel, data) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), data);
  };
  const copy = (from, to) => put(to, fs.readFileSync(path.join(ROOT, from)));
  const { loadTokens, tokensCss } = await tool('tools/lib/tokens.mjs');
  put('css/tokens.css', tokensCss(loadTokens(ROOT)));
  copy('src/shared/css/pcd-base.css', 'css/pcd-base.css');
  copy('src/shared/css/pcd-console.css', 'css/pcd-console.css');
  copy('src/newtab/css/ntp-term.css', 'css/ntp-term.css');
  copy('design/fonts/CascadiaMono-wght.ttf', 'fonts/CascadiaMono-wght.ttf');
  put('css/page.css', PAGE_CSS);
  const scripts = ['js/pcd-ascii.js', 'js/pcd-console.js', 'js/ntp-status.js', ...TERM_SCRIPTS.map((s) => `js/term/${s}`), 'js/page.js'];
  copy('src/shared/pcd-ascii.js', 'js/pcd-ascii.js');
  copy('src/shared/pcd-console.js', 'js/pcd-console.js'); // the weather command prints the column's own block
  copy('src/newtab/js/ntp-status.js', 'js/ntp-status.js');
  for (const s of TERM_SCRIPTS) copy(`src/newtab/js/term/${s}`, `js/term/${s}`);
  put('js/page.js', PAGE_JS.replace('LINKS_JSON', JSON.stringify(LINKS)));
  put('index.html', PAGE_HTML.replace('SCRIPTS', scripts.map((s) => `<script src="${s}" defer></script>`).join('\n')));
  return dir;
}

// the links: config/user.example.json's three, then one more; the checks read their names from here
const EXAMPLE = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'user.example.json'), 'utf8'));
const LINKS = [...EXAMPLE.shortcuts, { label: 'Docs', url: 'https://docs.example.org/start' }];
const NAME = LINKS.map((l) => l.label.toLowerCase());

// ------------------------------------------------------------------------------------------------ keys

const KEYS = {
  Enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' },
  Tab: { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 },
  Escape: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 },
  Backspace: { key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 },
  a: { key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 },
};
const CTRL = 2;

// the caret as drawn: its text, class, colours, place and width (CSS px), next to the ghost's place and the cell width
const CARET = `(() => {
  const c = document.querySelector('#slot .pcd-term-caret');
  const g = document.querySelector('#slot .pcd-term-ghost');
  const cs = getComputedStyle(c);
  const root = getComputedStyle(document.documentElement);
  const r = c.getBoundingClientRect();
  return { text: c.textContent, on: c.classList.contains('pcd-term-caret-on'), bg: cs.backgroundColor, color: cs.color,
    accent: root.getPropertyValue('--accent').trim().toLowerCase(), page: root.getPropertyValue('--bg').trim().toLowerCase(),
    left: r.left, width: r.width, ghostLeft: g.getBoundingClientRect().left, cell: window.__term.state().cell.w };
})()`;
const hex = (rgb) => '#' + (rgb.match(/\d+/g) || []).slice(0, 3).map((n) => Number(n).toString(16).padStart(2, '0')).join('');

async function press(page, name, modifiers = 0) {
  const k = KEYS[name];
  const down = { type: k.text && !modifiers ? 'keyDown' : 'rawKeyDown', modifiers, key: k.key, code: k.code, windowsVirtualKeyCode: k.windowsVirtualKeyCode };
  if (k.text && !(modifiers & CTRL)) down.text = k.text;
  await page.send('Input.dispatchKeyEvent', down);
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers, key: k.key, code: k.code, windowsVirtualKeyCode: k.windowsVirtualKeyCode });
}

async function typeChars(page, text) {
  for (const ch of text) {
    const code = ch === ' ' ? 'Space' : /[a-z]/i.test(ch) ? 'Key' + ch.toUpperCase() : /\d/.test(ch) ? 'Digit' + ch : '';
    const vk = /[a-z]/i.test(ch) ? ch.toUpperCase().charCodeAt(0) : /\d/.test(ch) ? ch.charCodeAt(0) : ch === ' ' ? 32 : 0;
    await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: ch, code, text: ch, unmodifiedText: ch, windowsVirtualKeyCode: vk });
    await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch, code, windowsVirtualKeyCode: vk });
  }
}

async function click(page, x, y) {
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
    await page.send('Input.dispatchMouseEvent', { type, x, y, button: type === 'mouseMoved' ? 'none' : 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1 });
  }
}

// ------------------------------------------------------------------------------------------------ the test

test('the terminal in headless Chrome: links, commands, history, Tab, focus, the caret, paste and IME with real key events', { timeout: 120000 }, async () => {
  const { launch } = await tool('tools/lib/chrome.mjs');
  const { serve } = await tool('tools/lib/serve.mjs');
  const dir = await buildPage();
  const server = await serve(dir);
  const browser = await launch();
  const fails = [];
  const ok = (cond, what) => { if (!cond) fails.push(what); };
  let page;
  try {
    page = await browser.newPage();
    await page.setViewport(1280, 800, 2);
    await page.goto(server.url + 'index.html');
    const ready = await page.waitFor("document.documentElement.getAttribute('data-ready') || ''", { timeoutMs: 15000 });
    assert.equal(ready, '1', 'the page mounted the terminal');
    const st = () => page.evaluate('window.__term.state()');
    const calls = () => page.evaluate('window.__calls.splice(0)');
    const last = () => page.evaluate("(() => { const l = document.querySelectorAll('#slot .pcd-term-ln'); return l.length ? l[l.length - 1].textContent : ''; })()");
    const enter = async (text, mod = 0) => { await typeChars(page, text); await press(page, 'Enter', mod); await sleep(30); };

    // focus and the digit preview
    ok((await st()).focused, 'the prompt is focused on mount');
    ok((await page.evaluate("document.activeElement.className")) === 'pcd-term-input', 'the input has the page focus');
    await typeChars(page, '3');
    ok((await st()).ghost.includes('→ ' + NAME[2]), `typing 3 shows the link it opens (→ ${NAME[2]})`);
    const block = await page.evaluate(CARET);
    ok(block.text === ' ' && block.on && Math.abs(block.width - block.cell) < 0.5 && hex(block.bg) === block.accent,
      `over a link preview (it starts with a space) the caret is a whole accent cell (${JSON.stringify(block)})`);
    await press(page, 'Enter');
    await sleep(30);
    ok(JSON.stringify(await calls()) === JSON.stringify([['openUrl', LINKS[2].url, false]]), '3 + enter opens link 3 in this tab');
    ok((await last()).includes('opening ' + NAME[2]), 'and says so');
    await enter(NAME[1]);
    ok(JSON.stringify(await calls()) === JSON.stringify([['openUrl', LINKS[1].url, false]]), 'a link name opens it');
    await enter('1', CTRL);
    ok(JSON.stringify(await calls()) === JSON.stringify([['openUrl', LINKS[0].url, true]]), 'ctrl+enter opens a new tab');
    ok(/in a new tab$/.test(await last()), 'and says so');
    await enter('2 &');
    ok(JSON.stringify(await calls()) === JSON.stringify([['openUrl', LINKS[1].url, true]]), 'a trailing " &" opens a new tab');
    await enter('do');
    ok(JSON.stringify(await calls()) === JSON.stringify([['openUrl', 'https://docs.example.org/start', false]]), 'a unique start of a link name opens it');
    await enter('example.com/path');
    ok(JSON.stringify(await calls()) === JSON.stringify([['openUrl', 'https://example.com/path', false]]), 'a url opens');
    await enter('pixelclock.local');
    ok(JSON.stringify(await calls()) === JSON.stringify([['openUrl', 'http://pixelclock.local/', false]]), 'a LAN name opens with http');
    await enter('g pixel art');
    ok(JSON.stringify(await calls()) === JSON.stringify([['openUrl', 'https://www.google.com/search?q=pixel%20art', false]]), 'g searches google');
    await enter('yt lofi');
    ok(JSON.stringify(await calls()) === JSON.stringify([['openUrl', 'https://www.youtube.com/results?search_query=lofi', false]]), 'yt searches youtube');
    await enter('gh pixelclock');
    ok(JSON.stringify(await calls()) === JSON.stringify([['openUrl', 'https://github.com/search?q=pixelclock', false]]), 'gh searches github');
    await enter('cozy rainy day music');
    ok(JSON.stringify(await calls()) === JSON.stringify([['search', 'cozy rainy day music', false]]), 'other text searches with the default engine');
    await enter('javascript:alert(1)');
    ok(JSON.stringify(await calls()) === JSON.stringify([['search', 'javascript:alert(1)', false]]), 'other schemes are searched, never opened');

    // the scene
    await enter('theme winter');
    ok((await last()).includes('theme auto follows the date again'), 'theme winter answers at once');
    ok(JSON.stringify(await calls()) === JSON.stringify([['theme', 'winter']]), 'theme winter pins the winter scene');
    await enter('theme haunted hill');
    ok(JSON.stringify(await calls()) === JSON.stringify([['theme', 'halloween']]), 'theme by its scene name');
    await enter('theme wintr');
    ok((await last()).includes('did you mean winter'), 'a theme typo suggests');
    ok((await calls()).length === 0, 'and switches nothing');
    await enter('theme auto');
    await sleep(350);
    ok(JSON.stringify(await calls()) === JSON.stringify([['theme', 'auto']]), 'theme auto follows the date');
    ok((await last()).includes('autumn forest · auto'), 'and names the scene');
    await enter('surprise');
    ok(JSON.stringify(await calls()) === JSON.stringify([['surprise']]) && (await last()).includes('haunted hill'), 'surprise picks another scene');
    await enter('shake');
    ok(JSON.stringify(await calls()) === JSON.stringify([['shake']]), 'shake');

    // info and math
    await enter('= 2^10');
    ok((await last()).trim() === '= 1024', '= 2^10');
    await enter('calc 2+');
    ok((await last()).includes('calc: a number is missing'), 'a calc error explains');
    await enter('weather');
    const credit = await page.evaluate("(() => { const a = document.querySelectorAll('#slot .pcd-term-art a'); return a.length ? a[a.length - 1].getAttribute('href') : ''; })()");
    ok(credit === 'https://open-meteo.com/', 'weather prints the block with the credit linked');
    const wx = await page.evaluate("Array.from(document.querySelectorAll('#slot .pcd-term-art')).slice(-4).map((e) => e.textContent)");
    ok(wx.length === 4 && /46°F drizzle · berlin$/.test(wx[0]) && /weather: open-meteo\.com$/.test(wx[3]), 'the column\'s block: the city on the first line, "weather: open-meteo.com" last');
    await enter('date');
    ok(/day \d+ of 36[56]/.test(await last()), 'date');
    await enter('alarm');
    ok((await last()) === '⌂ next alarm tomorrow 7:00 am · work', 'alarm prints the clock status line');
    await enter('clock 24');
    ok((await last()) === 'clock: 24 hour', 'clock 24 answers at once');
    await sleep(350);
    ok(JSON.stringify(await calls()) === JSON.stringify([['setClock24', true]]), 'clock 24 saves the setting');
    await enter('clock 12');
    await enter('settings');
    ok(JSON.stringify((await calls()).slice(-1)) === JSON.stringify([['openSettings']]), 'settings opens the sheet');
    await enter('help');
    ok((await st()).text.includes('ctrl+enter'), 'help lists the keys');

    // history, completion, esc
    await press(page, 'ArrowUp');
    ok((await st()).value === 'help', 'up recalls the last command');
    await press(page, 'ArrowUp');
    ok((await st()).value === 'settings', 'up again goes further back');
    await press(page, 'ArrowDown');
    ok((await st()).value === 'help', 'down comes back');
    await press(page, 'Escape');
    ok((await st()).value === '', 'esc clears the line');
    const stored = await page.evaluate("JSON.parse(localStorage.getItem('test.termHistory') || '[]')");
    ok(stored.at(-1) === 'help' && stored.includes('theme winter'), 'the history is in app.storage');
    await typeChars(page, 'the');
    ok((await st()).ghost === 'me', 'the ghost shows what tab adds');
    let caret = await page.evaluate(CARET);
    ok(caret.text === 'm' && caret.on, `over the ghost the caret is the ghost's first character (${JSON.stringify(caret)})`);
    ok(hex(caret.bg) === caret.accent && hex(caret.color) === caret.page, `drawn inverse: accent behind it, the page colour in front (${caret.bg} ${caret.color})`);
    ok(Math.abs(caret.left - caret.ghostLeft) < 0.5 && Math.abs(caret.width - caret.cell) < 0.5, `on the ghost's first cell, one cell wide (${caret.left} ${caret.ghostLeft} ${caret.width})`);
    await press(page, 'Tab');
    ok((await st()).value === 'theme ', 'tab completes the command');
    caret = await page.evaluate(CARET);
    ok(caret.text === '▌' && !caret.on && caret.bg === 'rgba(0, 0, 0, 0)', `no ghost: the plain block caret (${JSON.stringify(caret)})`);
    await typeChars(page, 'chr');
    await press(page, 'Tab');
    ok((await st()).value === 'theme christmas ', 'tab completes the theme');
    await press(page, 'Escape');
    await typeChars(page, 'theme sn');
    ok((await st()).ghost === 'owy hills', 'the ghost previews a scene name');
    await press(page, 'Tab');
    ok((await st()).value === 'theme snowy hills ', 'tab completes a scene name');
    await press(page, 'Escape');
    await typeChars(page, NAME[0].slice(0, 3));
    await press(page, 'ArrowRight');
    ok((await st()).value === NAME[0], 'right at the end of the line accepts the ghost');
    await press(page, 'Escape');
    await typeChars(page, 'theme s');
    await press(page, 'Tab');
    ok((await last()).includes('spring  summer  stpatricks'), 'an ambiguous tab lists the matches once');
    await press(page, 'Escape');

    // the keyboard belongs to Chrome for every Ctrl/Alt/Meta combination
    await typeChars(page, 'abc');
    await press(page, 'a', CTRL);
    await press(page, 'ArrowLeft', CTRL);
    await press(page, 'Enter', CTRL);
    const mods = await page.evaluate('window.__mods.splice(0)');
    ok(mods.length >= 3 && mods.every((m) => !m.prevented), `ctrl combinations are never prevented (${JSON.stringify(mods)})`);
    await calls();

    // typing anywhere, clicks, other fields
    await page.evaluate('document.activeElement.blur()');
    ok(!(await st()).focused, 'blurred');
    ok(!(await st()).caret.blinking, 'no blink timer while blurred');
    await typeChars(page, 'h');
    let s = await st();
    ok(s.focused && s.value === 'h', 'typing anywhere focuses the prompt and keeps the key');
    await press(page, 'Escape');
    await page.evaluate("document.getElementById('link').focus()");
    await typeChars(page, 'x');
    s = await st();
    ok(s.focused && s.value === 'x', 'a letter on a focused link goes to the prompt');
    await press(page, 'Escape');
    await page.evaluate("document.getElementById('btn').focus()");
    await typeChars(page, ' ');
    ok((await page.evaluate("document.activeElement.id")) === 'btn', 'space still presses a focused button');
    await page.evaluate("document.getElementById('dlg').showModal(); document.getElementById('field').focus()");
    await typeChars(page, 'zz');
    ok((await page.evaluate("document.getElementById('field').value")) === 'zz' && (await st()).value === '', 'typing in a dialog\'s field stays there');
    await page.evaluate("document.getElementById('dlg').close()");
    await page.evaluate('document.activeElement.blur()');
    const box = await page.evaluate("(() => { const r = document.getElementById('empty').getBoundingClientRect(); return { x: r.x + 20, y: r.y + 20 }; })()");
    await click(page, box.x, box.y);
    await sleep(60);
    ok((await st()).focused, 'a click on an empty part of the page focuses the prompt');

    // paste and IME
    await page.evaluate('document.activeElement.blur()');
    await page.evaluate("(() => { const dt = new DataTransfer(); dt.setData('text/plain', 'pasted\\nline'); document.body.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })); })()");
    s = await st();
    ok(s.focused && s.value === 'pasted line', `paste anywhere lands in the prompt as one line (${JSON.stringify(s.value)})`);
    await press(page, 'Escape');
    await page.send('Input.imeSetComposition', { text: 'ni', selectionStart: 2, selectionEnd: 2 });
    ok((await st()).ghost === '', 'no ghost while an IME composes');
    await page.evaluate("document.querySelector('.pcd-term-input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true }))");
    ok((await calls()).length === 0, 'enter inside a composition runs nothing');
    await page.send('Input.insertText', { text: 'nihao' });
    ok((await st()).value.endsWith('nihao'), 'the composition commits into the prompt');
    await press(page, 'Escape');

    // the caret
    await typeChars(page, 'x');
    s = await st();
    ok(s.caret.shown && s.caret.blinking, 'the caret shows and blinks while focused');
    await sleep(700);
    ok(await page.evaluate("document.querySelector('.pcd-term-prompt').classList.contains('pcd-blink-off')"), 'the caret blinked off after 530 ms');
    await page.evaluate('window.__setReduced(true)');
    await typeChars(page, 'y');
    await sleep(700);
    s = await st();
    ok(s.caret.shown && !s.caret.blinking, 'a steady caret under reduced motion');
    await page.evaluate('window.__setReduced(false)');
    await press(page, 'Escape');
    await typeChars(page, 'z');
    ok((await st()).caret.blinking, 'blinking again with motion back');
    await page.evaluate(`(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
      document.dispatchEvent(new Event('visibilitychange'));
    })()`);
    ok(!(await st()).caret.blinking, 'a hidden tab runs no timer at all');
    await page.evaluate(`(() => {
      delete document.hidden;
      delete document.visibilityState;
      document.dispatchEvent(new Event('visibilitychange'));
    })()`);
    ok((await st()).caret.blinking, 'the blink comes back with the tab');
    await press(page, 'Escape');

    // a live reduced-motion change: motion() only starts or stops the blink; the caret stays mid-line
    await typeChars(page, 'abcdef');
    for (let i = 0; i < 3; i++) await press(page, 'ArrowLeft');
    const sel = "(() => { const i = document.querySelector('.pcd-term-input'); return [i.selectionStart, i.selectionEnd, i.value]; })()";
    const mid = await page.evaluate(sel);
    ok(JSON.stringify(mid) === JSON.stringify([3, 3, 'abcdef']) && (await st()).caret.blinking, `mid-line and blinking (${JSON.stringify(mid)})`);
    await page.evaluate('window.__setReduced(true); window.__term.motion()');
    s = await st();
    ok(!s.caret.blinking && s.caret.shown, 'motion() under reduced motion: a steady caret');
    ok(JSON.stringify(await page.evaluate(sel)) === JSON.stringify(mid), 'and the caret stays where it was');
    await page.evaluate('window.__setReduced(false); window.__term.motion()');
    ok((await st()).caret.blinking, 'motion() with motion back: blinking again');
    ok(JSON.stringify(await page.evaluate(sel)) === JSON.stringify(mid), 'still where it was');
    await press(page, 'Escape');

    // scrollback: the prompt stays the last row, the top row fades once lines scroll away; esc on an empty line clears
    await enter('help');
    await enter('links');
    s = await st();
    const geo = await page.evaluate("(() => { const t = document.getElementById('slot'); const p = document.querySelector('.pcd-term-prompt').getBoundingClientRect(); const r = t.getBoundingClientRect(); return { bottom: Math.round(r.bottom - p.bottom), scrolled: t.classList.contains('pcd-term-scrolled') }; })()");
    ok(geo.scrolled && s.scrolled, 'the top row fades once lines scroll away');
    ok(Math.abs(geo.bottom) <= 1, `the prompt is the last row (${geo.bottom} px from the bottom)`);
    await press(page, 'Escape');
    ok((await st()).lines === 0, 'esc on an empty line clears the screen');
    await enter('7');
    ok((await last()).includes('no link 7'), 'a missing link number explains');
    await enter('clear');
    ok((await st()).lines === 0, 'clear empties the terminal');
    const late = await page.evaluate("(() => { const runs = document.querySelectorAll('#slot .pcd-term-run'); return runs.length; })()");
    ok(late === 0, 'clear removes every run block too');

    // stand-alone (outside .pcd-console): ntp-term.css alone gives it the same look; destroy() leaves nothing behind
    const solo = await page.evaluate(`(async () => {
      const box = document.createElement('div');
      box.id = 'solo';
      box.style.cssText = 'position:absolute;left:600px;top:420px;width:315px;height:84px;font:18px TermMono';
      document.body.appendChild(box);
      const cell = window.__term.state().cell;
      const t = PCD.term.mount({ el: box, cols: 30, rows: 4, cell: { w: cell.w, h: cell.h, ls: 0 } }, { links: () => [] },
        { focus: false, typeAnywhere: false, clickFocus: false });
      for (const l of ['help', 'date', '= 1+1']) await t.run(l);
      const css = (sel, prop) => getComputedStyle(box.querySelector(sel))[prop];
      const root = getComputedStyle(document.documentElement);
      const out = {
        solo: box.classList.contains('pcd-term-solo') && t.state().solo,
        scroll: getComputedStyle(box).overflowY,
        scrolled: box.classList.contains('pcd-term-scrolled'),
        pp: css('.pcd-term-pp', 'color'), accent: root.getPropertyValue('--accent').trim(),
        caretColor: css('.pcd-term-input', 'caretColor'),
        hang: css('.pcd-term-hang', 'textIndent'),
        bottom: Math.round(box.getBoundingClientRect().bottom - box.querySelector('.pcd-term-prompt').getBoundingClientRect().bottom),
      };
      t.destroy();
      out.left = box.children.length + (box.classList.contains('pcd-term-solo') ? 1 : 0);
      box.remove();
      return out;
    })()`);
    ok(solo.solo && solo.scroll === 'auto', 'a slot outside the console is a stand-alone scroll box');
    ok(hex(solo.pp) === solo.accent.toLowerCase(), `its prompt is accent (${solo.pp} vs ${solo.accent})`);
    ok(solo.caretColor === 'rgba(0, 0, 0, 0)' || solo.caretColor === 'transparent', 'its native caret is hidden');
    ok(solo.hang === '-105px', `its help table hangs at 10 cells (${solo.hang})`);
    ok(solo.scrolled && Math.abs(solo.bottom) <= 1, 'it scrolls with the prompt as its last row');
    ok(solo.left === 0, 'destroy() leaves no element and no class behind');
    await typeChars(page, 'q');
    ok((await st()).value === 'q', 'the console\'s terminal still has the keys');

    const errors = page.errors.map((e) => `${e.type}: ${e.text}`);
    ok(errors.length === 0, `zero console errors (${errors.join(' | ')})`);
  } finally {
    if (page) await page.close().catch(() => {});
    await browser.close();
    await server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
  assert.deepEqual(fails, [], `${fails.length} check(s) failed`);
});
