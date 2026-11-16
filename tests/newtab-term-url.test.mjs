// The terminal's one URL classifier (src/newtab/js/term/term-url.js): which typed text opens and which is searched,
// the browser actions behind app.openUrl / app.search with a fake chrome, location and window.open, and the proof that
// the terminal opens exactly what the classifier says (the looser url.js in term/lib/ never decides).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { TERM_DIR, loadTerm, stubApp } from './newtab-term-load.mjs';

const T = loadTerm();
const U = T.url;

// [typed text, the address it opens]
const ADDRESSES = [
  ['example.com', 'https://example.com/'],
  ['Example.COM', 'https://example.com/'],
  ['  example.com  ', 'https://example.com/'],
  ['example.com/path?q=1#top', 'https://example.com/path?q=1#top'],
  ['www.example.co.uk', 'https://www.example.co.uk/'],
  ['example.com:8443', 'https://example.com:8443/'],
  ['example.com.', 'https://example.com./'],
  ['https://example.com', 'https://example.com/'],
  ['HTTP://Example.com/a', 'http://example.com/a'],
  ['http://localhost:5173', 'http://localhost:5173/'],
  ['https://intranet', 'https://intranet/'],
  ['localhost', 'http://localhost/'],
  ['localhost:3000/app', 'http://localhost:3000/app'],
  ['app.localhost:8080', 'http://app.localhost:8080/'],
  ['127.0.0.1', 'http://127.0.0.1/'],
  ['127.0.0.1:8080/x', 'http://127.0.0.1:8080/x'],
  ['192.168.1.50', 'http://192.168.1.50/'],
  ['10.0.0.2:81', 'http://10.0.0.2:81/'],
  ['172.16.5.4', 'http://172.16.5.4/'],
  ['172.31.255.255', 'http://172.31.255.255/'],
  ['169.254.1.1', 'http://169.254.1.1/'],
  ['172.32.0.1', 'https://172.32.0.1/'],
  ['8.8.8.8', 'https://8.8.8.8/'],
  ['[::1]:3000', 'http://[::1]:3000/'],
  ['pixelclock.local', 'http://pixelclock.local/'],
  ['pixelclock.local/api/status', 'http://pixelclock.local/api/status'],
  ['nas.lan', 'http://nas.lan/'],
  ['router.home.arpa', 'http://router.home.arpa/'],
  ['svc.internal:8443', 'http://svc.internal:8443/'],
  ['example.ai', 'https://example.ai/'],
  ['docs.rs', 'https://docs.rs/'],
  ['bun.sh', 'https://bun.sh/'],
  ['learn.example.edu', 'https://learn.example.edu/'],
  ['b\u00fccher.de', 'https://xn--bcher-kva.de/'],
  ['xn--bcher-kva.de', 'https://xn--bcher-kva.de/'],
  ['news.xn--p1ai', 'https://news.xn--p1ai/'],
];

// typed text that is searched, never opened
const SEARCHES = [
  'hello', 'hello world', 'example.com is a domain', 'node.js', 'package.json', 'notes.txt', 'index.html', 'photo.jpeg',
  'v1.2.3', '3.14', 'e.g.', 'U.S.', 'javascript:alert(1)', 'JavaScript:void(0)', 'data:text/html,hi', 'file:///C:/x',
  'chrome://settings', 'about:blank', 'mailto:a@b.com', 'ftp://example.com/file', 'view-source:example.com',
  'user@example.com', 'user:pass@example.com', 'https://user:pw@example.com', 'example.com:99999', 'example.com:abc',
  'localhost:0', 'example.com:', '-bad.com', 'bad-.com', 'a..b.com', '999.1.1.1', '1.2.3', 'http://', 'example', 'what?',
  '#hash', '/path', '?q', 'c:\\windows', 'a\\b.com', 'how do i center a div',
];

test('addresses: https for domains, http for localhost, loopback, LAN addresses, IPv6 and *.local; exactly the URL', () => {
  for (const [text, url] of ADDRESSES) {
    assert.equal(U.toUrl(text), url, `toUrl(${JSON.stringify(text)})`);
    assert.deepEqual(U.classify(text), { kind: 'url', url }, `classify(${JSON.stringify(text)})`);
    assert.equal(U.isWebUrl(url), true, url);
  }
});

test('searches: words, file names that are no domain, other schemes, credentials and broken hosts never open', () => {
  for (const text of SEARCHES) {
    assert.equal(U.toUrl(text), null, `toUrl(${JSON.stringify(text)})`);
    const r = U.classify(text);
    assert.equal(r.kind, 'search', `classify(${JSON.stringify(text)})`);
    assert.equal(r.text, text.trim());
  }
  for (const empty of ['', '   ', '\t', null, undefined, 42]) assert.deepEqual(U.classify(empty), { kind: 'empty' });
  for (const bad of ['javascript:alert(1)', 'data:text/html,x', 'chrome://settings', 'file:///C:/', 'https://u:p@x.example', '', null, 7]) {
    assert.equal(U.isWebUrl(bad), false, String(bad));
  }
});

test('hostKind: lan, public or not a host; NOT_TLDS never holds a real top-level domain', () => {
  assert.equal(U.hostKind('localhost'), 'lan');
  assert.equal(U.hostKind('LOCALHOST.'), 'lan');
  assert.equal(U.hostKind('pixelclock.local'), 'lan');
  assert.equal(U.hostKind('192.168.0.1'), 'lan');
  assert.equal(U.hostKind('1.1.1.1'), 'public');
  assert.equal(U.hostKind('example.com'), 'public');
  assert.equal(U.hostKind('readme.md'), 'public'); // .md is Moldova: an address, as in Chrome
  assert.equal(U.hostKind('server.js'), null);
  assert.equal(U.hostKind('intranet'), null);
  assert.equal(U.hostKind(''), null);
  for (const ext of U.NOT_TLDS) assert.ok(ext.length >= 2 && /^[a-z]+$/.test(ext), ext);
  assert.ok(!U.NOT_TLDS.some((t) => ['ai', 'io', 'md', 'rs', 'sh', 'py', 'pl', 'co', 'me', 'tv', 'zip', 'mov', 'dev', 'app'].includes(t)), 'real TLDs are never on the list');
});

test('edges: one-letter endings, port limits, default ports, IPv6, IDN, upper case, underscores', () => {
  const table = [
    ['x.y', null], ['a.b.c.d', null], ['localhost:65535', 'http://localhost:65535/'], ['localhost:65536', null],
    ['[fe80::1]', 'http://[fe80::1]/'], ['[::1]:0', null], ['foo.local:80/x', 'http://foo.local/x'], ['foo.LAN', 'http://foo.lan/'],
    ['my-site.museum', 'https://my-site.museum/'], ['site.xn--p1ai', 'https://site.xn--p1ai/'], ['under_score.com', 'https://under_score.com/'],
    ['http://[::1]/', 'http://[::1]/'], ['HTTPS://EXAMPLE.COM/A?B#C', 'https://example.com/A?B#C'], ['readme.md', 'https://readme.md/'],
  ];
  for (const [text, url] of table) assert.equal(U.toUrl(text), url, JSON.stringify(text));
});

function fakeChrome({ searchResult = Promise.resolve(), noSearch = false, noTabs = false } = {}) {
  const calls = [];
  const c = {};
  if (!noSearch) c.search = { query: (o) => { calls.push(['search.query', o]); return typeof searchResult === 'function' ? searchResult() : searchResult; } };
  if (!noTabs) c.tabs = { create: (o) => { calls.push(['tabs.create', o]); return Promise.resolve({ id: 7 }); } };
  return { c, calls };
}

test('actions(): searches go to chrome.search.query (CURRENT_TAB or NEW_TAB); addresses to this tab or chrome.tabs.create', async () => {
  const assigned = [];
  const opened = [];
  const location = { assign: (u) => assigned.push(u) };
  const open = (...a) => opened.push(a);
  let f = fakeChrome();
  let A = U.actions({ chrome: f.c, location, open });
  assert.deepEqual(await A.search('pixel art', false), { did: 'search' });
  assert.deepEqual(f.calls, [['search.query', { text: 'pixel art', disposition: 'CURRENT_TAB' }]]);
  f = fakeChrome();
  A = U.actions({ chrome: f.c, location, open });
  assert.deepEqual(await A.search('pixel art', true), { did: 'search', newTab: true });
  assert.deepEqual(f.calls, [['search.query', { text: 'pixel art', disposition: 'NEW_TAB' }]]);
  assert.deepEqual(await A.openUrl('https://example.com/', false), { did: 'navigate' });
  assert.deepEqual(assigned, ['https://example.com/']);
  assert.deepEqual(f.calls.length, 1, 'this tab: location.assign, no chrome call');
  assert.deepEqual(await A.openUrl('https://x.example.com/', true), { did: 'navigate', newTab: true });
  assert.deepEqual(f.calls[1], ['tabs.create', { url: 'https://x.example.com/', active: true }]);
  f = fakeChrome({ noTabs: true });
  A = U.actions({ chrome: f.c, location, open });
  assert.deepEqual(await A.openUrl('https://example.com/', true), { did: 'navigate', newTab: true });
  assert.deepEqual(opened, [['https://example.com/', '_blank', 'noopener,noreferrer']]);
  // preview pages (no chrome.search) and failures reject with a short sentence
  await assert.rejects(U.actions({ chrome: fakeChrome({ noSearch: true }).c }).search('x'), /installed new tab/);
  await assert.rejects(U.actions({ chrome: null }).search('x'), /installed new tab/);
  await assert.rejects(A.search('   '), /nothing to search/);
  const failing = fakeChrome({ searchResult: () => Promise.reject(new Error('no engine')) });
  await assert.rejects(U.actions({ chrome: failing.c }).search('x'), /no engine/);
  await assert.rejects(U.actions({ chrome: { search: { query: () => { throw new Error('sync throw'); } } } }).search('x'), /sync throw/);
  // never anything but http(s), even when asked directly
  assigned.length = 0;
  for (const url of ['javascript:alert(1)', 'data:text/html,x', 'chrome://settings', 'file:///C:/', '', null]) {
    await assert.rejects(A.openUrl(url, false), /http and https/, String(url));
  }
  assert.deepEqual(assigned, []);
  await assert.rejects(U.actions({ chrome: null, location: {} }).openUrl('https://example.com/', false), /cannot navigate/);
  await assert.rejects(U.actions({ chrome: null, open: null }).openUrl('https://example.com/', true), /new tabs cannot be opened/);
});

test('the terminal opens exactly what the classifier says: every address opens it, every search searches', async () => {
  const app = stubApp({ links: () => [] });
  const shell = T.createShell(app, {});
  for (const [text, url] of ADDRESSES) {
    app.calls.length = 0;
    await shell.run(text);
    assert.deepEqual(app.calls, [['openUrl', url, false]], text);
  }
  for (const text of SEARCHES) {
    app.calls.length = 0;
    const r = await shell.run(text);
    if (r.kind === 'builtin') continue; // "hello" is the easter egg
    assert.deepEqual(app.calls, [['search', text.trim(), false]], text);
  }
  app.calls.length = 0;
  await shell.run('pixelclock.local &');
  assert.deepEqual(app.calls, [['openUrl', 'http://pixelclock.local/', true]], 'a trailing " &" opens a new tab');
  app.calls.length = 0;
  await shell.run('node.js', { newTab: true });
  assert.deepEqual(app.calls, [['search', 'node.js', true]], 'ctrl+enter searches in a new tab');
});

test('term-url.js is a classic UMD script: PCD.term.url, no DOM, network or storage at load time', () => {
  const src = fs.readFileSync(path.join(TERM_DIR, 'term-url.js'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.ok(!/\bsetInterval|setTimeout|fetch\(|XMLHttpRequest|\bdocument\.|localStorage|innerHTML|eval\(/.test(src));
  assert.equal(globalThis.PCD.term.url, U);
});
