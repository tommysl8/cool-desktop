// The new tab's links [1]-[9] (src/newtab/js/ntp-links.js): the list rules (9 at most, http(s) only, clean labels),
// labels for top sites, the optional topSites permission through a fake chrome (granted, refused, missing, failing),
// and the live list (custom, top sites while granted, a newer update winning, permission events). The console draws
// them and the terminal opens them; the real-browser run is tools/test-newtab.mjs. Privacy: the neutral
// config/user.example.json, never config/user.json.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { test } from 'node:test';

function findRoot(dir) {
  for (let d = dir; ; d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, 'tools', 'build.mjs'))) return d;
    if (path.dirname(d) === d) throw new Error('repo root not found');
  }
}
const ROOT = findRoot(import.meta.dirname);
const FILE = path.join(ROOT, 'src', 'newtab', 'js', 'ntp-links.js');
const K = createRequire(import.meta.url)(FILE);
const S = createRequire(import.meta.url)(path.join(ROOT, 'src', 'newtab', 'js', 'ntp-settings.js'));
const EXAMPLE = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'user.example.json'), 'utf8'));

/** A fake chrome with the optional permission (granted or not) and top sites. */
function fakeChrome({ granted = true, sites = [], requestAnswer = false, noTopSites = false } = {}) {
  const added = [];
  const removed = [];
  const c = {
    state: { granted, requests: 0 },
    permissions: {
      contains: (q) => Promise.resolve(c.state.granted && JSON.stringify(q) === JSON.stringify({ permissions: ['topSites'] })),
      request: () => { c.state.requests++; return Promise.resolve(requestAnswer); },
      onAdded: { addListener: (f) => added.push(f), removeListener: (f) => added.splice(added.indexOf(f), 1) },
      onRemoved: { addListener: (f) => removed.push(f), removeListener: (f) => removed.splice(removed.indexOf(f), 1) },
    },
    fire: { added: (p) => added.forEach((f) => f(p)), removed: (p) => removed.forEach((f) => f(p)), count: () => added.length + removed.length },
  };
  if (!noTopSites) c.topSites = { get: () => Promise.resolve(sites) };
  return c;
}

const TOP = [
  { url: 'chrome://settings/', title: 'Settings' },
  { url: 'https://www.youtube.com/watch?v=1', title: 'YouTube' },
  { url: 'https://www.youtube.com/watch?v=1', title: 'YouTube again' },
  { url: 'https://learn.example.edu/courses', title: 'Learn' },
  { url: 'https://mail.example.com/mail/u/0/', title: 'Mail' },
  { url: 'https://www.bbc.co.uk/news', title: 'BBC' },
  { url: 'http://localhost:8080/', title: 'dev' },
  { url: 'http://192.168.1.50/', title: 'clock' },
  { url: 'https://github.com/', title: 'GitHub' },
  { url: 'https://m.wikipedia.org/', title: 'Wikipedia' },
  { url: 'https://news.ycombinator.com/', title: 'HN' },
  { url: 'https://www.openstreetmap.org/', title: 'OSM' },
];

const settle = () => new Promise((r) => setTimeout(r, 0));

test('items(): the first 9 usable entries, http(s) only, labels cleaned and cut to 24, numbered from 1', () => {
  const list = [
    { label: 'one', url: 'https://one.example.com/' },
    { label: 'bad', url: 'javascript:alert(1)' },
    { label: '', url: 'https://empty.example.com/' },
    { label: '  two\u0000 ​words\n', url: 'http://localhost:3000/' },
    { label: 'x'.repeat(40), url: 'https://long.example.com/' },
    null, 'text', { url: 'https://nolabel.example.com/' },
    ...Array.from({ length: 10 }, (_, i) => ({ label: `s${i}`, url: `https://s${i}.example.com/` })),
  ];
  const out = K.items(list);
  assert.equal(K.MAX, 9);
  assert.equal(K.MAX, S.SHORTCUTS_MAX, 'as many links as the settings keep');
  assert.equal(out.length, 9);
  assert.deepEqual(out.map((s) => s.n), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.deepEqual(out.slice(0, 3), [
    { n: 1, label: 'one', url: 'https://one.example.com/' },
    { n: 2, label: 'two words', url: 'http://localhost:3000/' },
    { n: 3, label: 'x'.repeat(24), url: 'https://long.example.com/' },
  ]);
  assert.equal(out[8].label, 's5');
  assert.deepEqual(K.items(null), []);
  assert.deepEqual(K.items('nope'), []);
});

test('the example config\'s shortcuts (the settings defaults) come through unchanged and in order', () => {
  const defaults = S.defaults(EXAMPLE, { scope: 'newtab' }).shortcuts;
  const out = K.items(defaults);
  assert.ok(out.length >= 1);
  assert.deepEqual(out.map((s) => s.label), EXAMPLE.shortcuts.map((s) => s.label));
  assert.deepEqual(out.map((s) => s.url), defaults.map((s) => s.url));
});

test('topLabel(): a short lower-case name from the host', () => {
  const table = [
    ['https://www.youtube.com/watch?v=x', 'youtube'],
    ['https://learn.example.edu/', 'learn.example'],
    ['https://www.bbc.co.uk/news', 'bbc'],
    ['https://m.facebook.com', 'facebook'],
    ['https://www2.example.org/', 'example'],
    ['https://GitHub.com', 'github'],
    ['http://localhost:8080/', 'localhost:8080'],
    ['http://192.168.1.50/', '192.168.1.50'],
    ['http://[::1]:3000/', '[::1]:3000'],
    ['https://a.very.long.subdomain.chain.example.com/', 'a.very.long.subdomain.ch'],
    ['chrome://settings', ''],
    ['javascript:alert(1)', ''],
    ['not a url', ''],
    ['', ''],
  ];
  for (const [url, want] of table) assert.equal(K.topLabel(url), want, url);
});

test('fromTopSites(): http(s) only, one per address, 9 at most, labels from the host', () => {
  const out = K.fromTopSites(TOP);
  assert.equal(out.length, 9);
  assert.deepEqual(out.map((s) => s.label), ['youtube', 'learn.example', 'mail.example', 'bbc', 'localhost:8080', '192.168.1.50', 'github',
    'wikipedia', 'news.ycombinator']);
  assert.equal(out[0].url, 'https://www.youtube.com/watch?v=1');
  assert.deepEqual(K.fromTopSites(null), []);
  assert.deepEqual(K.fromTopSites([{ url: 'ftp://x.example/' }, {}, null]), []);
});

test('the optional permission: contains, request (inside a click) and top sites through a fake chrome', async () => {
  assert.equal(await K.hasTopSites(fakeChrome({ granted: true })), true);
  assert.equal(await K.hasTopSites(fakeChrome({ granted: false })), false);
  assert.equal(await K.hasTopSites(null), false);
  assert.equal(await K.hasTopSites({ permissions: { contains: () => Promise.reject(new Error('x')) } }), false);
  assert.equal(await K.hasTopSites({ permissions: { contains: () => { throw new Error('sync'); } } }), false);
  assert.equal(await K.hasTopSites({ permissions: { contains: () => Promise.resolve('yes') } }), false, 'only true counts');
  const c = fakeChrome({ granted: false, requestAnswer: false });
  assert.equal(await K.requestTopSites(c), false);
  assert.equal(c.state.requests, 1);
  assert.equal(await K.requestTopSites(fakeChrome({ requestAnswer: true })), true);
  assert.equal(await K.requestTopSites({}), false);
  assert.equal(await K.requestTopSites({ permissions: { request: () => { throw new Error('no gesture'); } } }), false);
  assert.equal((await K.topSites(fakeChrome({ granted: true, sites: TOP }))).length, 9);
  assert.equal(await K.topSites(fakeChrome({ granted: false, sites: TOP })), null);
  assert.equal(await K.topSites(fakeChrome({ granted: true, noTopSites: true })), null, 'granted but the API is not there yet');
  assert.equal(await K.topSites({ permissions: { contains: () => Promise.resolve(true) }, topSites: { get: () => Promise.reject(new Error('x')) } }), null);
});

test('create(): custom list, top sites while granted, back to the own list when refused; onChange only on a change', async () => {
  const c = fakeChrome({ granted: true, sites: TOP });
  const changes = [];
  const links = K.create({ chrome: c, onChange: (s) => changes.push(`${s.source}:${s.items.length}`) });
  const own = S.defaults(EXAMPLE, { scope: 'newtab' }).shortcuts;
  let st = await links.update({ shortcutsMode: 'custom', shortcuts: own });
  assert.equal(st.source, 'custom');
  assert.equal(st.mode, 'custom');
  assert.equal(links.items().length, own.length);
  await links.update({ shortcutsMode: 'custom', shortcuts: own.map((s) => ({ ...s })) });
  assert.equal(changes.length, 1, 'the same list is not announced again');
  st = await links.update({ shortcutsMode: 'top', shortcuts: own });
  assert.equal(st.source, 'top');
  assert.equal(st.top, 'granted');
  assert.equal(links.items().length, 9);
  assert.equal(links.items()[0].label, 'youtube');
  assert.deepEqual(links.items().map((s) => s.n), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  c.state.granted = false;
  st = await links.refresh();
  assert.equal(st.source, 'custom');
  assert.equal(st.top, 'denied');
  assert.equal(links.items()[0].label, own[0].label);
  assert.deepEqual(changes, [`custom:${own.length}`, 'top:9', `custom:${own.length}`]);
  // A granted permission (chrome.permissions.onAdded) refreshes the list by itself.
  c.state.granted = true;
  c.fire.added({ permissions: ['topSites'] });
  await settle();
  await settle();
  assert.equal(links.state().source, 'top');
  c.fire.added({ permissions: ['storage'] });
  links.destroy();
  assert.equal(c.fire.count(), 0, 'destroy() removes the permission listeners');
});

test('create(): top with no top sites shows the own list; a newer update() wins over a slower one; no chrome is fine', async () => {
  let resolveSlow;
  const c = {
    permissions: { contains: () => new Promise((r) => { resolveSlow = () => r(true); }) },
    topSites: { get: () => Promise.resolve(TOP) },
  };
  const links = K.create({ chrome: c });
  const slow = links.update({ shortcutsMode: 'top', shortcuts: [{ label: 'a', url: 'https://a.example.com/' }] });
  await links.update({ shortcutsMode: 'custom', shortcuts: [{ label: 'b', url: 'https://b.example.com/' }] });
  resolveSlow();
  await slow;
  assert.deepEqual(links.items().map((l) => l.label), ['b'], 'the older top-sites answer arrived last and was dropped');
  const empty = K.create({ chrome: fakeChrome({ granted: true, sites: [] }) });
  const st = await empty.update({ shortcutsMode: 'top', shortcuts: [{ label: 'own', url: 'https://own.example.com/' }] });
  assert.equal(st.source, 'custom');
  assert.equal(st.items[0].label, 'own');
  const none = K.create({ chrome: null });
  assert.equal((await none.update({ shortcutsMode: 'top', shortcuts: [] })).items.length, 0);
  assert.equal((await K.create({}).update(null)).items.length, 0);
});

test('source hygiene: classic UMD, no DOM, no network, no innerHTML, ASCII only', () => {
  const src = fs.readFileSync(FILE, 'utf8');
  assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.|fetch\(|XMLHttpRequest|setTimeout|setInterval/.test(src));
  assert.ok(!/^\s*(import|export)\s/m.test(src));
  assert.ok(/^[\x09\x0a\x20-\x7e]*$/.test(src), 'ASCII only');
  assert.equal(createRequire(import.meta.url)(FILE), globalThis.PCD.links, 'UMD: the same object as the global');
});
