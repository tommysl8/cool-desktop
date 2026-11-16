// node --test "tests/newtab-store.test.mjs"
// The new tab's settings storage (src/newtab/js/ntp-store.js, PCD.store) over a fake chrome.storage.sync
// that enforces Chrome's quotas (8192 bytes an item measured independently here, 102400 in total, 512
// items, 120 writes a minute, 1800 an hour) and can fail on purpose: the area picked per environment,
// load and the one-time rewrite of old formats, the 1 s debounce, onChanged across tabs, read-modify-
// write, the split of big shortcut lists into chunk items under 4 KB, quota and rate errors, partial
// failures (a half-done write never loses the stored settings), a pointer that arrives before its
// chunks, preview mode over localStorage, flush and dispose.
// Privacy: no real config is read; configs here are neutral.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);

function findRoot(dir) {
  for (let d = dir; ; d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, 'tools', 'build.mjs'))) return d;
    if (path.dirname(d) === d) throw new Error('repo root not found');
  }
}
const ROOT = findRoot(path.dirname(fileURLToPath(import.meta.url)));
const S = require(path.join(ROOT, 'src', 'newtab', 'js', 'ntp-settings.js'));
const St = require(path.join(ROOT, 'src', 'newtab', 'js', 'ntp-store.js'));

const ch = (...codes) => String.fromCodePoint(...codes);
const CONFIG = Object.freeze({
  city: '', units: 'C', clock: '24h', sunTimes: true, weather: true,
  shortcuts: [{ label: 'wiki', url: 'https://www.wikipedia.org' }], taskbarPx: 56,
});
const THEMES = ['winter', 'spring', 'summer', 'autumn', 'halloween', 'christmas'];
const OPTS = { config: CONFIG, scope: 'newtab', themes: THEMES };
const DEFAULTS = S.defaults(CONFIG, { scope: 'newtab' });

const QUOTA = { QUOTA_BYTES: 102400, QUOTA_BYTES_PER_ITEM: 8192, MAX_ITEMS: 512, MAX_WRITE_OPERATIONS_PER_MINUTE: 120, MAX_WRITE_OPERATIONS_PER_HOUR: 1800 };
const LT6 = '\\' + 'u003C';
const SEPS = new RegExp('[' + String.fromCharCode(0x2028, 0x2029) + ']', 'g');

/** What Chrome charges for one item, computed independently of the store: UTF-8 key + UTF-8 JSON with "<",
 *  U+2028 and U+2029 written as 6-byte escapes. */
function chromeBytes(key, value) {
  const json = JSON.stringify(value).split('<').join(LT6).replace(SEPS, (c) => '\\' + 'u' + c.charCodeAt(0).toString(16));
  return Buffer.byteLength(key) + Buffer.byteLength(json);
}

async function settle(n = 30) {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
}

/** Fake timers and clock: timers fire only inside advance(), in time order, with promises settled between. */
function fakeTime(start = Date.UTC(2026, 10, 15, 20, 0, 0)) {
  let t = start;
  let seq = 0;
  const timers = new Map();
  return {
    now: () => t,
    setTimeout(fn, ms) {
      const id = ++seq;
      timers.set(id, { at: t + Math.max(0, Number(ms) || 0), fn, seq: id });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
    pending: () => timers.size,
    async advance(ms) {
      const end = t + ms;
      for (;;) {
        await settle();
        const due = [...timers.entries()].filter(([, v]) => v.at <= end).sort((a, b) => a[1].at - b[1].at || a[1].seq - b[1].seq)[0];
        if (!due) break;
        t = due[1].at;
        timers.delete(due[0]);
        due[1].fn();
      }
      t = end;
      await settle();
    },
  };
}

/**
 * A fake chrome with storage.sync like Chrome 157's: promise API, quotas checked before anything is
 * written (all or nothing), write operations counted per minute and hour, onChanged on
 * chrome.storage (with areaName) and on chrome.storage.sync, delivered asynchronously to every tab.
 * failNext(method, message, { skip, partial, hang }) makes a later call fail: skip = let that many calls
 * through first; partial = a set() that writes half its items and then fails (Chrome never does this,
 * the store must survive it anyway); hang = a promise get() returns instead of an answer.
 */
function fakeChrome(time, { quota = {}, direct = true } = {}) {
  const q = { ...QUOTA, ...quota };
  const data = new Map();
  const anyListeners = new Set();
  const directListeners = new Set();
  const ops = [];
  const failures = [];
  const calls = [];
  const all = () => Object.fromEntries([...data].map(([k, v]) => [k, JSON.parse(v)]));
  const emit = (changes) => {
    if (!Object.keys(changes).length) return;
    const text = JSON.stringify(changes);
    setImmediate(() => {
      for (const fn of [...anyListeners]) fn(JSON.parse(text), 'sync');
      for (const fn of [...directListeners]) fn(JSON.parse(text));
    });
  };
  const take = (method) => {
    const f = failures.find((x) => x.method === method);
    if (!f) return null;
    if (f.skip > 0) {
      f.skip--;
      return null;
    }
    failures.splice(failures.indexOf(f), 1);
    return f;
  };
  const writeLimit = () => {
    const t = time.now();
    if (ops.filter((x) => t - x < 60000).length >= q.MAX_WRITE_OPERATIONS_PER_MINUTE) return 'This request exceeds the MAX_WRITE_OPERATIONS_PER_MINUTE quota.';
    if (ops.filter((x) => t - x < 3600000).length >= q.MAX_WRITE_OPERATIONS_PER_HOUR) return 'This request exceeds the MAX_WRITE_OPERATIONS_PER_HOUR quota.';
    return null;
  };
  const sync = {
    ...q,
    get(keys) {
      calls.push(['get']);
      const f = take('get');
      if (f) return f.hang || Promise.reject(new Error(f.message));
      const a = all();
      if (keys === null || keys === undefined) return Promise.resolve(a);
      const list = Array.isArray(keys) ? keys : typeof keys === 'string' ? [keys] : Object.keys(keys);
      return Promise.resolve(Object.fromEntries(list.filter((k) => k in a).map((k) => [k, a[k]])));
    },
    set(items) {
      calls.push(['set', Object.keys(items)]);
      const f = take('set');
      if (f && !f.partial) return Promise.reject(new Error(f.message));
      const limit = writeLimit();
      if (limit) return Promise.reject(new Error(limit));
      const after = all();
      for (const [k, v] of Object.entries(items)) {
        if (chromeBytes(k, v) > q.QUOTA_BYTES_PER_ITEM) return Promise.reject(new Error('Resource::kQuotaBytesPerItem quota exceeded'));
        after[k] = v;
      }
      const total = Object.entries(after).reduce((n, [k, v]) => n + chromeBytes(k, v), 0);
      if (total > q.QUOTA_BYTES) return Promise.reject(new Error('Resource::kQuotaBytes quota exceeded'));
      if (Object.keys(after).length > q.MAX_ITEMS) return Promise.reject(new Error('Resource::kMaxItems quota exceeded'));
      ops.push(time.now());
      const keys = Object.keys(items);
      const n = f ? Math.ceil(keys.length / 2) : keys.length;
      const changes = {};
      for (const k of keys.slice(0, n)) {
        changes[k] = data.has(k) ? { oldValue: JSON.parse(data.get(k)), newValue: items[k] } : { newValue: items[k] };
        data.set(k, JSON.stringify(items[k]));
      }
      emit(changes);
      return f ? Promise.reject(new Error(f.message)) : Promise.resolve();
    },
    remove(keys) {
      const list = Array.isArray(keys) ? keys : [keys];
      calls.push(['remove', list]);
      const f = take('remove');
      if (f) return Promise.reject(new Error(f.message));
      const limit = writeLimit();
      if (limit) return Promise.reject(new Error(limit));
      ops.push(time.now());
      const changes = {};
      for (const k of list) {
        if (!data.has(k)) continue;
        changes[k] = { oldValue: JSON.parse(data.get(k)) };
        data.delete(k);
      }
      emit(changes);
      return Promise.resolve();
    },
  };
  if (direct) sync.onChanged = { addListener: (fn) => directListeners.add(fn), removeListener: (fn) => directListeners.delete(fn) };
  const chrome = {
    runtime: { id: 'pcdtestextensionid' },
    storage: { sync, onChanged: { addListener: (fn) => anyListeners.add(fn), removeListener: (fn) => anyListeners.delete(fn) } },
  };
  return {
    chrome,
    data,
    all,
    calls,
    ops,
    writes: () => calls.filter((c) => c[0] !== 'get').length,
    failNext: (method, message, extra = {}) => failures.push({ method, message, skip: 0, ...extra }),
    /** another computer's change arriving through sync (silent: the event has not come yet) */
    put(items, { silent = false } = {}) {
      const changes = {};
      for (const [k, v] of Object.entries(items)) {
        changes[k] = { newValue: v };
        data.set(k, JSON.stringify(v));
      }
      if (!silent) emit(changes);
    },
    raise: (changes, areaName) => { for (const fn of [...anyListeners]) fn(changes, areaName); },
    listeners: () => anyListeners.size + directListeners.size,
  };
}

function fakeLocalStorage() {
  const m = new Map();
  return {
    get length() { return m.size; },
    key: (i) => [...m.keys()][i] ?? null,
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(String(k), String(v)); },
    removeItem: (k) => { m.delete(k); },
    clear: () => m.clear(),
  };
}

function fakeWindow() {
  const listeners = new Set();
  return {
    addEventListener: (type, fn) => { if (type === 'storage') listeners.add(fn); },
    removeEventListener: (type, fn) => { listeners.delete(fn); },
    dispatch: (e) => { for (const fn of [...listeners]) fn(e); },
    count: () => listeners.size,
  };
}

function makeStore(fake, time, extra = {}) {
  return St.create({ area: St.syncArea(fake.chrome), config: CONFIG, themes: THEMES, timers: time, now: time.now, ...extra });
}

const longUrl = (tag, i) => {
  const u = `https://${tag}${String(i).padStart(2, '0')}.example.com/`;
  return u + 'a'.repeat(S.URL_MAX - u.length);
};
/** 9 shortcuts (the most the console shows) at their size limits: about 4.2 KB, so they cannot share one 4 KB item. */
const bigList = (tag) => Array.from({ length: S.SHORTCUTS_MAX }, (_, i) => ({ label: '<'.repeat(S.LABEL_MAX), url: longUrl(tag, i) }));
const ourKeys = (fake) => Object.keys(fake.all()).sort();
const chunkKeys = (fake) => ourKeys(fake).filter((k) => k.startsWith(St.CHUNK_PREFIX));

test('openArea: chrome.storage.sync on the extension page, localStorage in preview, memory without storage', () => {
  const time = fakeTime();
  const fake = fakeChrome(time);
  const ls = fakeLocalStorage();
  assert.equal(St.openArea({ chrome: fake.chrome }).kind, 'chrome.storage.sync');
  assert.equal(St.openArea({ chrome: { runtime: {}, storage: fake.chrome.storage }, localStorage: ls, window: null }).kind, 'localStorage (preview)',
    'no chrome.runtime.id: preview mode');
  assert.equal(St.openArea({ chrome: undefined, localStorage: ls, window: null }).kind, 'localStorage (preview)');
  const blocked = { getItem() { throw new Error('SecurityError'); } };
  assert.equal(St.openArea({ chrome: undefined, localStorage: blocked, window: null }).kind, 'memory');
  assert.equal(St.openArea({ chrome: undefined, localStorage: null, window: null }).kind, 'memory');
  const throwing = { get runtime() { throw new Error('no'); } };
  assert.equal(St.openArea({ chrome: throwing, localStorage: null, window: null }).kind, 'memory');
  assert.deepEqual(St.syncArea(fakeChrome(time, { quota: { QUOTA_BYTES: 5000 } }).chrome).quota.QUOTA_BYTES, 5000, 'Chrome\'s own numbers win');
  assert.equal(St.syncArea(null), null);
  assert.throws(() => St.create({ area: St.memoryArea(), schema: {} }), /ntp-settings/);
});

test('load: the config defaults when nothing is stored, stored overrides on top, and reading never writes', async () => {
  const time = fakeTime();
  const fake = fakeChrome(time);
  const A = makeStore(fake, time);
  assert.deepEqual(A.get(), DEFAULTS, 'the defaults before load()');
  assert.deepEqual(await A.load(), DEFAULTS);
  assert.equal(A.load(), A.load(), 'load() runs once');
  await time.advance(5000);
  assert.equal(fake.writes(), 0);
  assert.deepEqual(A.status().pending, []);
  assert.equal(A.status().loaded, true);
  assert.equal(A.status().kind, 'chrome.storage.sync');

  const fake2 = fakeChrome(time);
  fake2.put({ settings: { v: 1, units: 'F', city: 'Oslo', theme: 'halloween', shortcuts: [{ label: 'maps', url: 'https://www.openstreetmap.org' }] } }, { silent: true });
  const B = makeStore(fake2, time);
  const s = await B.load();
  assert.equal(s.units, 'F');
  assert.equal(s.city, 'Oslo');
  assert.equal(s.theme, 'halloween');
  assert.deepEqual(s.shortcuts, [{ label: 'maps', url: 'https://www.openstreetmap.org' }]);
  assert.equal(s.clock24, true, 'not stored: the config default');
  await time.advance(5000);
  assert.equal(fake2.writes(), 0, 'a clean item is not rewritten');
});

test('load: an older format or this version\'s leftovers are rewritten once; a newer version never', async () => {
  const time = fakeTime();
  const fake = fakeChrome(time);
  fake.put({ settings: { clock: '12h', units: 'f', bogus: 1 } }, { silent: true }); // v0
  const A = makeStore(fake, time);
  const s = await A.load();
  assert.equal(s.clock24, false);
  assert.equal(s.units, 'F');
  await time.advance(999);
  assert.equal(fake.writes(), 0, 'the rewrite waits for the debounce');
  await time.advance(1);
  assert.deepEqual(fake.all(), { settings: { v: 1, clock24: false, units: 'F' } });
  assert.equal(fake.writes(), 1);
  await time.advance(5000);
  assert.equal(fake.writes(), 1, 'once');

  // an item with a key this version does not know: read without it, rewritten once, quietly
  const fake1 = fakeChrome(time);
  fake1.put({ settings: { v: 1, nope: 1, units: 'F' } }, { silent: true });
  const heard = [];
  const R = makeStore(fake1, time, { onError: (e) => heard.push(e) });
  const s1 = await R.load();
  assert.ok(!('nope' in s1));
  assert.equal(s1.units, 'F');
  await time.advance(1000);
  assert.deepEqual(fake1.all(), { settings: { v: 1, units: 'F' } });
  await time.advance(5000);
  assert.equal(fake1.writes(), 1, 'once');
  assert.deepEqual(heard, [], 'nothing to report');

  const fake2 = fakeChrome(time);
  const newer = { v: 9, units: 'F', performance: 'galaxy', future: { x: 1 } };
  fake2.put({ settings: newer }, { silent: true });
  const B = makeStore(fake2, time);
  const s2 = await B.load();
  assert.equal(s2.units, 'F', 'what this version understands');
  assert.equal(s2.performance, 'auto', 'what it does not: the default, in memory only');
  await time.advance(5000);
  assert.equal(fake2.writes(), 0, 'a newer version\'s item is never rewritten on load');
  const pset = B.set({ city: 'Oslo' });
  await time.advance(1000);
  assert.equal((await pset).written, true);
  assert.deepEqual(fake2.all().settings, { v: 9, city: 'Oslo', units: 'F', performance: 'galaxy', future: { x: 1 } },
    'a change from this tab keeps everything the newer version wrote');
});

test('set: applies at once, stores once after 1 s of quiet, and only on a real change', async () => {
  const time = fakeTime();
  const fake = fakeChrome(time);
  const A = makeStore(fake, time);
  await A.load();
  const events = [];
  A.subscribe((s, info) => events.push([info.source, info.changed.join(','), s.city]));
  const p1 = A.set({ city: 'B' });
  const p2 = A.set({ city: 'Be' });
  await time.advance(500);
  const p3 = A.set({ city: 'Berlin', units: 'F' });
  assert.equal(A.get().city, 'Berlin', 'in memory at once');
  assert.deepEqual(events, [['local', 'city', 'B'], ['local', 'city', 'Be'], ['local', 'city,units', 'Berlin']]);
  await time.advance(999);
  assert.equal(fake.writes(), 0, 'nothing stored while typing');
  await time.advance(1);
  assert.equal(fake.writes(), 1, 'one write for the whole burst');
  for (const r of await Promise.all([p1, p2, p3])) assert.equal(r.written, true);
  assert.deepEqual((await p3).changed, ['city', 'units']);
  assert.deepEqual(fake.all(), { settings: { v: 1, city: 'Berlin', units: 'F' } }, 'only overrides, canonical order');
  assert.ok(A.status().bytes.settings < 100);
  // the same value again: no change, nothing to store
  assert.deepEqual(await A.set({ units: 'F' }), { ok: true, written: false, changed: [] });
  // back to the default: the override goes
  A.set({ units: 'C' });
  await time.advance(1000);
  assert.deepEqual(fake.all(), { settings: { v: 1, city: 'Berlin' } });
  // toggled and back before the write: nothing stored
  const before = fake.writes();
  A.set({ weather: false });
  A.set({ weather: true });
  await time.advance(2000);
  assert.equal(fake.writes(), before);
  // refused values: reported per key, nothing changes
  const was = A.get();
  const bad = await A.set({ units: 'K', shakeHourly: false, nope: 1, city: 'x'.repeat(81), theme: 'aurora' });
  assert.equal(bad.ok, false);
  assert.deepEqual(Object.keys(bad.errors).sort(), ['city', 'nope', 'shakeHourly', 'theme', 'units']);
  assert.match(bad.errors.shakeHourly, /not a new tab setting/, 'a wallpaper setting');
  assert.match(bad.errors.nope, /not a new tab setting/, 'a key no piece has');
  assert.deepEqual(A.get(), was);
  // a mix: the good key is stored, the bad one reported
  const mix = A.set({ performance: 'off', units: 'K' });
  await time.advance(1000);
  const m = await mix;
  assert.equal(m.ok, false);
  assert.equal(m.written, true);
  assert.deepEqual(m.changed, ['performance']);
  assert.ok(m.errors.units);
  assert.equal(fake.all().settings.performance, 'off');
  assert.deepEqual(await A.set('nope'), { ok: false, written: false, changed: [], error: 'set() needs an object of settings' });
  // reset: back to the config defaults
  A.reset();
  await time.advance(1000);
  assert.deepEqual(fake.all(), { settings: { v: 1 } });
  assert.deepEqual(A.get(), DEFAULTS);
});

test('onChanged: a change in tab A shows in tab B; B\'s unsaved edit survives; the echo is silent', async () => {
  for (const direct of [true, false]) {
    const time = fakeTime();
    const fake = fakeChrome(time, { direct });
    const A = makeStore(fake, time);
    const B = makeStore(fake, time);
    await A.load();
    await B.load();
    const ea = [];
    const eb = [];
    A.subscribe((s, info) => ea.push(`${info.source}:${info.changed.join(',')}`));
    B.subscribe((s, info) => eb.push(`${info.source}:${info.changed.join(',')}`));
    A.set({ city: 'Oslo' });
    await time.advance(1000);
    assert.equal(B.get().city, 'Oslo', `B hears A (${direct ? 'storage.sync.onChanged' : 'storage.onChanged, area "sync"'})`);
    assert.deepEqual(eb, ['remote:city']);
    assert.deepEqual(ea, ['local:city'], 'A\'s own write echoes back silently');
    // B edits units; A's next change arrives before B stores it
    A.set({ performance: 'off' });
    await time.advance(500);
    B.set({ units: 'F' });
    await time.advance(500); // A writes now
    assert.equal(B.get().performance, 'off');
    assert.equal(B.get().units, 'F', 'the unsaved edit stays on top');
    await time.advance(500); // B writes now: read-modify-write keeps A's keys
    assert.deepEqual(fake.all().settings, { v: 1, city: 'Oslo', units: 'F', performance: 'off' });
    assert.equal(A.get().units, 'F');
    // changes in another area (storage.local) or to other keys are ignored
    const gets = fake.calls.filter((c) => c[0] === 'get').length;
    fake.raise({ settings: { newValue: {} } }, 'local');
    fake.raise({ weather: { newValue: 1 } }, 'sync');
    await settle();
    assert.equal(fake.calls.filter((c) => c[0] === 'get').length, gets);
    A.dispose();
    B.dispose();
  }
});

test('read-modify-write: another computer\'s change to another key survives this tab\'s write', async () => {
  const time = fakeTime();
  const fake = fakeChrome(time);
  const A = makeStore(fake, time);
  await A.load();
  A.set({ city: 'Oslo' });
  await time.advance(1000);
  // arrives through sync, the event not yet delivered
  fake.put({ settings: { v: 1, city: 'Oslo', clock24: false } }, { silent: true });
  const events = [];
  A.subscribe((s, info) => events.push(`${info.source}:${info.changed.join(',')}`));
  A.set({ weatherFx: false });
  await time.advance(1000);
  assert.deepEqual(fake.all().settings, { v: 1, clock24: false, city: 'Oslo', weatherFx: false });
  assert.equal(A.get().clock24, false, 'and this tab picks it up');
  assert.deepEqual(events, ['local:weatherFx', 'remote:clock24']);
});

test('quota: a list too big for one 4 KB item is split into chunk items; every tab reassembles it', async () => {
  const time = fakeTime();
  const fake = fakeChrome(time);
  const A = makeStore(fake, time);
  const B = makeStore(fake, time);
  await A.load();
  await B.load();
  const big = bigList('a');
  const want = S.validate('shortcuts', big).value;
  A.set({ shortcuts: big, city: '<'.repeat(S.CITY_MAX) });
  await time.advance(1000);
  const all = fake.all();
  const chunks = chunkKeys(fake);
  assert.ok(chunks.length >= 2, `chunks: ${chunks.join(', ')}`);
  for (const [k, v] of Object.entries(all)) assert.ok(chromeBytes(k, v) <= 4096, `${k}: ${chromeBytes(k, v)} bytes`);
  assert.deepEqual(Object.keys(all.settings.sc), ['rev', 'n']);
  assert.equal(all.settings.sc.n, chunks.length);
  assert.ok(!('shortcuts' in all.settings));
  assert.deepEqual(B.get().shortcuts, want, 'the other tab hears the whole list');
  assert.equal(A.status().split, true);
  for (const b of Object.values(A.status().bytes)) assert.ok(b <= 4096);
  const C = makeStore(fake, time);
  assert.deepEqual((await C.load()).shortcuts, want, 'a new tab reads the split layout');
  assert.equal(C.status().incomplete, false);
  // another change to a small key keeps the chunks as they are (no chunk rewrite)
  const sets = fake.calls.filter((c) => c[0] === 'set').length;
  A.set({ units: 'F' });
  await time.advance(1000);
  const setsNow = fake.calls.filter((c) => c[0] === 'set');
  assert.equal(setsNow.length, sets + 1);
  assert.deepEqual(setsNow[setsNow.length - 1][1], ['settings'], 'only the main item');
  assert.deepEqual(chunkKeys(fake), chunks);
  // a short list again: one item, the chunks are removed
  A.set({ shortcuts: [{ label: 'x', url: 'x.example.com' }] });
  await time.advance(1000);
  assert.deepEqual(ourKeys(fake), ['settings']);
  assert.deepEqual(B.get().shortcuts, [{ label: 'x', url: 'https://x.example.com' }]);
  assert.equal(A.status().split, false);
});

test('quota and rate errors: rate limits wait and retry, per-item shrinks the items, onError hears each', async () => {
  const time = fakeTime();
  const fake = fakeChrome(time);
  const errors = [];
  const A = makeStore(fake, time, { onError: (e) => errors.push(e.kind) });
  await A.load();
  // 120 writes a minute: wait a minute, a new edit does not cut the pause short
  fake.failNext('set', 'This request exceeds the MAX_WRITE_OPERATIONS_PER_MINUTE quota.');
  const p = A.set({ city: 'Oslo' });
  await time.advance(1000);
  const r = await p;
  assert.deepEqual([r.ok, r.written, r.error, r.retrying], [false, false, 'rate-minute', true]);
  assert.equal(A.status().lastError.kind, 'rate-minute');
  assert.deepEqual(A.status().pending, ['city']);
  assert.equal(A.get().city, 'Oslo', 'still applied in this tab');
  A.set({ units: 'F' });
  await time.advance(30000);
  assert.equal(fake.all().settings, undefined, 'nothing stored during the pause');
  await time.advance(30000);
  assert.deepEqual(fake.all().settings, { v: 1, city: 'Oslo', units: 'F' }, 'both stored after a minute');
  assert.equal(A.status().lastError, null);
  // 1800 writes an hour: retry after 10 minutes
  fake.failNext('set', 'This request exceeds the MAX_WRITE_OPERATIONS_PER_HOUR quota.');
  A.set({ performance: 'off' });
  await time.advance(1000);
  await time.advance(9 * 60000);
  assert.equal(fake.all().settings.performance, undefined);
  await time.advance(60000);
  assert.equal(fake.all().settings.performance, 'off');
  // Chrome counts an item bigger than we do: halve the items and retry at once
  fake.failNext('set', 'Resource::kQuotaBytesPerItem quota exceeded');
  A.set({ clock24: false });
  await time.advance(1000);
  assert.equal(fake.all().settings.clock24, false);
  assert.equal(A.status().budget, 2048);
  // any other error: 2 s, 10 s, 60 s, then it waits for the next edit
  for (let i = 0; i < 4; i++) fake.failNext('set', 'IO error');
  A.set({ sunTimes: false });
  await time.advance(1000 + 2000 + 10000 + 60000 + 120000);
  assert.equal(fake.all().settings.sunTimes, undefined);
  assert.equal(A.status().lastError.retrying, false);
  A.set({ weather: false });
  await time.advance(1000);
  assert.equal(fake.all().settings.sunTimes, false, 'the waiting change goes with the next one');
  assert.equal(fake.all().settings.weather, false);
  assert.deepEqual(errors, ['rate-minute', 'rate-hour', 'item', 'error', 'error', 'error', 'error']);
});

test('quota: a write that can never fit (QUOTA_BYTES, MAX_ITEMS) is refused before anything is written', async () => {
  const time = fakeTime();
  for (const [quota, kind] of [[{ QUOTA_BYTES: 3000 }, 'total'], [{ MAX_ITEMS: 2 }, 'items']]) {
    const fake = fakeChrome(time, { quota });
    const A = makeStore(fake, time);
    await A.load();
    A.set({ units: 'F' });
    await time.advance(1000);
    const before = fake.all();
    const sets = fake.calls.filter((c) => c[0] === 'set').length;
    const p = A.set({ shortcuts: bigList('q') });
    await time.advance(1000);
    const r = await p;
    assert.deepEqual([r.ok, r.error, r.retrying], [false, kind, false], JSON.stringify(quota));
    assert.match(r.message, /bytes/);
    assert.deepEqual(fake.all(), before, 'the stored settings are untouched');
    assert.equal(fake.calls.filter((c) => c[0] === 'set').length, sets, 'refused before calling set()');
    A.dispose();
  }
});

test('our own guard keeps a burst of edits under Chrome\'s 120 writes a minute', async () => {
  const time = fakeTime();
  const fake = fakeChrome(time);
  const A = makeStore(fake, time, { debounceMs: 0 });
  await A.load();
  for (let i = 0; i < 150; i++) {
    A.set({ city: 'c' + i });
    await time.advance(0);
  }
  assert.ok(fake.ops.length <= 100, `${fake.ops.length} writes in one minute`);
  assert.equal(A.status().lastError, null, 'Chrome never had to refuse');
  assert.ok(A.status().opsLastMinute <= 100);
  await time.advance(61000);
  assert.equal(fake.all().settings.city, 'c149', 'the last edit is stored once the window allows');
});

test('partial failure: a half-done write never loses the settings stored before', async () => {
  const time = fakeTime();
  const fake = fakeChrome(time);
  const errors = [];
  const A = makeStore(fake, time, { onError: (e) => errors.push(e.kind) });
  await A.load();
  const L1 = S.validate('shortcuts', bigList('one')).value;
  const L2 = S.validate('shortcuts', bigList('two')).value;
  const L3 = S.validate('shortcuts', bigList('tri')).value;
  const fresh = async () => {
    const T = makeStore(fake, time);
    const s = await T.load();
    T.dispose();
    return s.shortcuts;
  };
  A.set({ shortcuts: L1 });
  await time.advance(1000);
  assert.deepEqual(await fresh(), L1);
  const l1Chunks = chunkKeys(fake);

  // 1. the new chunks are stored, then the pointer write fails
  fake.failNext('set', 'IO error', { skip: 1 });
  const p = A.set({ shortcuts: L2 });
  await time.advance(1000);
  const r = await p;
  assert.deepEqual([r.ok, r.error, r.retrying], [false, 'error', true]);
  assert.deepEqual(await fresh(), L1, 'every reader still gets the old list: its pointer and chunks are intact');
  assert.ok(chunkKeys(fake).length > l1Chunks.length, 'the new chunks wait unreferenced');
  await time.advance(2000); // the retry
  assert.deepEqual(await fresh(), L2);
  const l2Chunks = chunkKeys(fake);
  assert.ok(l2Chunks.every((k) => !l1Chunks.includes(k)), 'the old chunks are gone');
  assert.equal(l2Chunks.length, fake.all().settings.sc.n, 'no leftovers');

  // 2. a non-atomic set that stores half of its chunks and fails
  fake.failNext('set', 'IO error', { partial: true });
  A.set({ shortcuts: L3 });
  await time.advance(1000);
  assert.deepEqual(await fresh(), L2, 'the half-written chunks are never used');
  await time.advance(2000);
  assert.deepEqual(await fresh(), L3);
  assert.equal(chunkKeys(fake).length, fake.all().settings.sc.n, 'no leftovers');

  // 3. removing the old chunks fails: the new settings are stored, the leftovers go with the next write
  const l3Chunks = chunkKeys(fake);
  fake.failNext('remove', 'IO error');
  A.set({ shortcuts: L1 });
  await time.advance(1000);
  assert.deepEqual(await fresh(), L1);
  assert.ok(l3Chunks.every((k) => chunkKeys(fake).includes(k)), 'leftovers still there');
  assert.equal(A.status().lastError.kind, 'cleanup');
  A.set({ units: 'F' });
  await time.advance(1000);
  assert.ok(l3Chunks.every((k) => !chunkKeys(fake).includes(k)), 'removed with the next write');
  assert.equal(chunkKeys(fake).length, fake.all().settings.sc.n);
  assert.deepEqual(await fresh(), L1);
  assert.deepEqual(errors, ['error', 'error', 'cleanup']);
});

test('load: a failing storage gives the defaults; a silent one too, after 2 s; both recover later', async () => {
  const time = fakeTime();
  const fake = fakeChrome(time);
  fake.put({ settings: { v: 1, units: 'F' } }, { silent: true });
  fake.failNext('get', 'storage is broken');
  const A = makeStore(fake, time);
  const s = await A.load();
  assert.equal(s.units, 'C');
  assert.equal(A.status().lastError.kind, 'read');
  fake.put({ settings: { v: 1, units: 'F', city: 'Oslo' } });
  await settle();
  assert.equal(A.get().units, 'F', 'the next change event reads again');
  assert.equal(A.get().city, 'Oslo');

  let release;
  const hang = new Promise((r) => { release = r; });
  fake.failNext('get', '', { hang });
  const B = makeStore(fake, time);
  const pb = B.load();
  await time.advance(1999);
  let done = false;
  pb.then(() => { done = true; });
  await settle();
  assert.equal(done, false);
  await time.advance(1);
  const sb = await pb;
  assert.equal(sb.units, 'C', 'the defaults after 2 s (the page never waits on storage)');
  assert.equal(B.status().lastError.kind, 'timeout');
  release(fake.all());
  await settle();
  assert.equal(B.get().units, 'F', 'the late answer still arrives');
});

test('sync between computers: a pointer that arrives before its chunks keeps the shortcuts this tab has', async () => {
  const time = fakeTime();
  const fake = fakeChrome(time);
  const A = makeStore(fake, time);
  await A.load();
  const L = S.validate('shortcuts', bigList('far')).value;
  const plan = St.layout(S.applyPatch(undefined, { shortcuts: L }, OPTS).stored);
  assert.equal(plan.split, true);
  fake.put({ settings: plan.items.settings }); // the pointer first
  await settle();
  assert.equal(A.status().incomplete, true);
  assert.deepEqual(A.get().shortcuts, DEFAULTS.shortcuts, 'the shortcuts it had');
  // an edit meanwhile keeps the pointer: nothing is lost
  A.set({ units: 'F' });
  await time.advance(1000);
  assert.deepEqual(fake.all().settings.sc, plan.items.settings.sc);
  assert.equal(fake.all().settings.units, 'F');
  // the chunks arrive
  fake.put(Object.fromEntries(plan.chunkKeys.map((k) => [k, plan.items[k]])));
  await settle();
  assert.equal(A.status().incomplete, false);
  assert.deepEqual(A.get().shortcuts, L);
  assert.equal(A.get().units, 'F');
  // a damaged pointer is not waited for
  fake.put({ settings: { v: 1, sc: { rev: 'nothex!', n: 3 }, units: 'F' } });
  await settle();
  assert.equal(A.status().incomplete, false);
  assert.deepEqual(A.get().shortcuts, DEFAULTS.shortcuts);
});

test('preview mode: localStorage keys pcd.sync.*, other tabs through the storage event, Chrome\'s item quota too', async () => {
  const time = fakeTime();
  const ls = fakeLocalStorage();
  const win = fakeWindow();
  ls.setItem('pcd.mirror', '{"theme":"auto"}');
  ls.setItem('unrelated', 'x');
  const area = St.openArea({ chrome: undefined, localStorage: ls, window: win });
  const A = St.create({ area, config: CONFIG, timers: time, now: time.now });
  assert.equal(A.kind, 'localStorage (preview)');
  await A.load();
  const events = [];
  A.subscribe((s, info) => events.push(`${info.source}:${info.changed.join(',')}`));
  A.set({ city: 'Oslo' });
  await time.advance(1000);
  assert.deepEqual(JSON.parse(ls.getItem('pcd.sync.settings')), { v: 1, city: 'Oslo' });
  assert.equal(ls.getItem('pcd.mirror'), '{"theme":"auto"}', 'other keys untouched');
  assert.equal(ls.getItem('unrelated'), 'x');
  // another tab writes; the storage event brings it in
  const old = ls.getItem('pcd.sync.settings');
  ls.setItem('pcd.sync.settings', JSON.stringify({ v: 1, city: 'Rome' }));
  win.dispatch({ key: 'pcd.sync.settings', oldValue: old, newValue: ls.getItem('pcd.sync.settings'), storageArea: ls });
  await settle();
  assert.equal(A.get().city, 'Rome');
  // events for other keys are ignored; a damaged value counts as missing
  win.dispatch({ key: 'pcd.mirror', oldValue: null, newValue: '{}', storageArea: ls });
  ls.setItem('pcd.sync.settings', '{broken');
  win.dispatch({ key: 'pcd.sync.settings', oldValue: null, newValue: '{broken', storageArea: ls });
  await settle();
  assert.equal(A.get().city, '');
  assert.deepEqual(events, ['local:city', 'remote:city', 'remote:city']);
  await assert.rejects(area.set({ big: 'x'.repeat(9000) }), /kQuotaBytesPerItem/);
  A.dispose();
  assert.equal(win.count(), 0, 'dispose removes the storage listener');
  // the memory area behaves the same
  const mem = St.memoryArea();
  const M = St.create({ area: mem, config: CONFIG, timers: time, now: time.now });
  await M.load();
  M.set({ units: 'F' });
  await time.advance(1000);
  assert.deepEqual(await mem.get(null), { settings: { v: 1, units: 'F' } });
});

test('itemBytes counts like Chrome: UTF-8 JSON, "<" and U+2028 escaped, big integers as doubles', () => {
  const cases = ['plain', '<<>>', ch(0xe9), ch(0x1f600), 'a' + ch(0x2028) + ch(0x2029), 'tab\tnew\nline' + ch(1) + '"\\',
    { a: [1, 2, { b: null }], c: true, d: false, e: '<' }, [], {}, 0, -1, 1.5, 2147483647, -2147483648, null, true];
  for (const v of cases) assert.equal(St.itemBytes('k', v), chromeBytes('k', v), JSON.stringify(v));
  assert.equal(St.itemBytes('k', 3e9), 1 + '3000000000.0'.length, 'beyond int32 Chrome writes a double with ".0"');
  assert.equal(St.itemBytes(ch(0xe9), 1), 3, 'the key counts in UTF-8');
  assert.equal(St.itemBytes('k', { a: undefined, b: 1 }), chromeBytes('k', { b: 1 }), 'undefined members are not written');
  // Chrome 157's own words (seen in headless Chrome) and the documented names of older versions
  assert.equal(St.classify(new Error('Resource::kQuotaBytesPerItem quota exceeded')), 'item');
  assert.equal(St.classify(new Error('Resource::kQuotaBytes quota exceeded')), 'total');
  assert.equal(St.classify(new Error('Resource::kMaxItems quota exceeded')), 'items');
  assert.equal(St.classify(new Error('This request exceeds the MAX_WRITE_OPERATIONS_PER_MINUTE quota.')), 'rate-minute');
  assert.equal(St.classify(new Error('This request exceeds the MAX_WRITE_OPERATIONS_PER_HOUR quota.')), 'rate-hour');
  assert.equal(St.classify(new Error('QUOTA_BYTES_PER_ITEM quota exceeded')), 'item');
  assert.equal(St.classify(new Error('QUOTA_BYTES quota exceeded')), 'total');
  assert.equal(St.classify(new Error('MAX_ITEMS quota exceeded')), 'items');
  assert.equal(St.classify(new Error('MAX_WRITE_OPERATIONS_PER_HOUR quota exceeded')), 'rate-hour');
  assert.equal(St.classify(new Error('MAX_WRITE_OPERATIONS_PER_MINUTE quota exceeded')), 'rate-minute');
  assert.equal(St.classify(new Error('MAX_SUSTAINED_WRITE_OPERATIONS_PER_MINUTE quota exceeded')), 'rate-minute');
  assert.equal(St.classify('weird'), 'error');
});

test('a custom area that throws: the edit stays pending and the retry stores it', async () => {
  const time = fakeTime();
  const mem = St.memoryArea();
  let throwNext = 0;
  const area = { ...mem, kind: 'custom', get: (k) => { if (throwNext > 0) { throwNext--; throw new Error('boom'); } return mem.get(k); } };
  const A = St.create({ area, config: CONFIG, timers: time, now: time.now });
  await A.load();
  throwNext = 1;
  const p = A.set({ units: 'F' });
  await time.advance(1000);
  const r = await p;
  assert.deepEqual([r.ok, r.written, r.error, r.retrying], [false, false, 'error', true]);
  assert.deepEqual(A.status().pending, ['units']);
  assert.equal(A.get().units, 'F');
  await time.advance(2000);
  assert.deepEqual(await mem.get(null), { settings: { v: 1, units: 'F' } });
  assert.deepEqual(A.status().pending, []);
  // a throwing get on load: the defaults, and the store keeps working
  throwNext = 1;
  const B = St.create({ area, config: CONFIG, timers: time, now: time.now });
  assert.equal((await B.load()).units, 'C');
  assert.equal(B.status().lastError.kind, 'read');
});

test('flush stores at once (pagehide); dispose stops every timer and listener and settles waiting edits', async () => {
  const time = fakeTime();
  const fake = fakeChrome(time);
  const A = makeStore(fake, time);
  await A.load();
  const listeners = fake.listeners();
  A.set({ city: 'Oslo' });
  const r = await A.flush();
  assert.equal(r.written, true);
  assert.equal(fake.all().settings.city, 'Oslo', 'no 1 s wait');
  assert.equal(time.pending(), 0, 'no timer left');
  assert.deepEqual(await A.flush(), { ok: true, written: false }, 'nothing to flush');
  const waiting = A.set({ units: 'F' });
  A.dispose();
  assert.deepEqual(await waiting, { ok: false, written: false, error: 'disposed', changed: ['units'] });
  assert.equal(time.pending(), 0);
  assert.equal(fake.listeners(), listeners - 1);
  fake.put({ settings: { v: 1, city: 'Rome' } });
  await settle();
  assert.equal(A.get().city, 'Oslo', 'a disposed store hears nothing');
  assert.equal((await A.set({ city: 'x' })).error, 'disposed');
  await time.advance(5000);
  assert.equal(fake.all().settings.units, undefined);
});
