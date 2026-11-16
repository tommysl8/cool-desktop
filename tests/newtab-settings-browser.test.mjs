// The settings module in a real browser (headless Chrome through tools/lib/chrome.mjs, fresh temp profile):
// - a throwaway MV3 extension (permission "storage" only) loads ntp-settings.js, ntp-store.js and wp-props.js
//   as classic scripts under the default extension CSP, with zero errors;
// - Chrome's own byte count (chrome.storage.sync.getBytesInUse) equals PCD.store.itemBytes for tricky values,
//   and its per-item quota accepts exactly 8192 bytes and refuses 8193 as QUOTA_BYTES_PER_ITEM (so the store's
//   4 KB budget is a real 4 KB);
// - the store in two tabs: a change in tab A shows in tab B, the worst-case shortcut list is split into
//   items Chrome counts at <= 4096 bytes each, and a new tab reads it back;
// - preview mode (a 127.0.0.1 page, no chrome.runtime.id) keeps the settings in localStorage and other tabs follow;
// - the wallpaper's files load as classic scripts from file:// (how Lively opens the page) and build a valid
//   LivelyProperties object there.
// No network: nothing here talks to Open-Meteo or pixelclock.local.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

function findRoot(dir) {
  for (let d = dir; ; d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, 'tools', 'build.mjs'))) return d;
    if (path.dirname(d) === d) throw new Error('repo root not found');
  }
}
const ROOT = findRoot(import.meta.dirname);
const imp = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href);
const chrome = await imp('tools/lib/chrome.mjs');
const { serve } = await imp('tools/lib/serve.mjs');
const NO_BROWSER = chrome.findBrowser() ? false : 'no Chrome or Edge installed';

const FILES = {
  'ntp-settings.js': path.join(ROOT, 'src', 'newtab', 'js', 'ntp-settings.js'),
  'ntp-store.js': path.join(ROOT, 'src', 'newtab', 'js', 'ntp-store.js'),
  'wp-props.js': path.join(ROOT, 'src', 'wallpaper', 'js', 'wp-props.js'),
};
const CONFIG = {
  city: 'Berlin', units: 'C', clock: '24h', sunTimes: true, weather: true,
  shortcuts: [{ label: 'wiki', url: 'https://www.wikipedia.org' }], taskbarPx: 56,
};
const MENU = [{ id: 'auto', name: 'Auto (by date)' }, { id: 'winter', name: 'Snowy hills' }, { id: 'autumn', name: 'Autumn forest' }];

function writePage(dir, scripts) {
  fs.mkdirSync(dir, { recursive: true });
  for (const name of scripts) fs.copyFileSync(FILES[name], path.join(dir, name));
  const tags = scripts.map((n) => `<script src="${n}"></script>`).join('\n');
  fs.writeFileSync(path.join(dir, 'test.html'), `<!doctype html>\n<meta charset="utf-8">\n<title>settings test</title>\n${tags}\n`);
}

/** The longest list the settings keep (9: the console's links [1]-[9]) at its size limits: more than one 4 KB item. */
function bigList() {
  return Array.from({ length: 9 }, (_, i) => {
    const u = `https://s${String(i).padStart(2, '0')}.example.com/`;
    return { label: '<'.repeat(24), url: u + 'a'.repeat(300 - u.length) };
  });
}

test('real Chrome: Chrome counts what PCD.store counts; the store across tabs; preview over localStorage; file:// for Lively',
  { skip: NO_BROWSER, timeout: 120000 }, async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pcd-settings-'));
    const ext = path.join(tmp, 'ext');
    writePage(ext, ['ntp-settings.js', 'ntp-store.js', 'wp-props.js']);
    fs.writeFileSync(path.join(ext, 'manifest.json'), JSON.stringify({ manifest_version: 3, name: 'PCD settings test', version: '1.0', permissions: ['storage'] }, null, 2) + '\n');
    const preview = path.join(tmp, 'preview');
    writePage(preview, ['ntp-settings.js', 'ntp-store.js']);
    const lively = path.join(tmp, 'lively');
    writePage(lively, ['ntp-settings.js', 'wp-props.js']);
    let browser = null;
    let srv = null;
    try {
      browser = await chrome.launch({ extensionDebugging: true });
      const id = await browser.loadUnpacked(ext);
      const A = await browser.newPage(`chrome-extension://${id}/test.html`);
      const B = await browser.newPage(`chrome-extension://${id}/test.html`);

      // Chrome's numbers are the store's numbers
      const q = await A.evaluate(`({ per: chrome.storage.sync.QUOTA_BYTES_PER_ITEM, total: chrome.storage.sync.QUOTA_BYTES,
        items: chrome.storage.sync.MAX_ITEMS, minute: chrome.storage.sync.MAX_WRITE_OPERATIONS_PER_MINUTE,
        hour: chrome.storage.sync.MAX_WRITE_OPERATIONS_PER_HOUR, kind: PCD.store.openArea().kind })`);
      assert.deepEqual(q, { per: 8192, total: 102400, items: 512, minute: 120, hour: 1800, kind: 'chrome.storage.sync' });
      assert.deepEqual(await A.evaluate('PCD.store.openArea().quota'), {
        QUOTA_BYTES: 102400, QUOTA_BYTES_PER_ITEM: 8192, MAX_ITEMS: 512, MAX_WRITE_OPERATIONS_PER_MINUTE: 120, MAX_WRITE_OPERATIONS_PER_HOUR: 1800,
      });

      // getBytesInUse (Chrome's own count) equals itemBytes, for the characters that cost extra
      const counts = await A.evaluate(async () => {
        const c = (...x) => String.fromCodePoint(...x);
        const vals = {
          a: 'plain', b: '<<>>', c: c(0xe9) + c(0x4e2d), d: c(0x1f600), e: 'x' + c(0x2028) + c(0x2029), f: { n: [1, 2.5, true, null, '<'] },
          g: 3e9, h: 2147483647, i: 'tab\t"q"\\' + c(1) + c(0x7f), j: [], k: {}, ['k' + c(0xe9)]: 1,
        };
        await chrome.storage.sync.clear();
        await chrome.storage.sync.set(vals);
        const out = {};
        for (const k of Object.keys(vals)) out[k] = [await chrome.storage.sync.getBytesInUse(k), PCD.store.itemBytes(k, vals[k])];
        await chrome.storage.sync.clear();
        return out;
      });
      for (const [k, [chromeCount, ours]] of Object.entries(counts)) assert.equal(ours, chromeCount, `${k}: Chrome ${chromeCount}, ours ${ours}`);

      // the per-item edge: exactly 8192 bytes (by itemBytes) is stored, 8193 is refused
      const edge = await A.evaluate(async () => {
        const key = 'edge';
        const make = (n) => '<' + 'x'.repeat(n - PCD.store.itemBytes(key, '<'));
        const res = {};
        for (const n of [8192, 8193]) {
          const v = make(n);
          let outcome = 'ok';
          try {
            await chrome.storage.sync.set({ [key]: v });
          } catch (e) {
            outcome = String(e && e.message);
          }
          res[n] = { outcome, ours: PCD.store.itemBytes(key, v), kind: outcome === 'ok' ? null : PCD.store.classify(new Error(outcome)) };
        }
        await chrome.storage.sync.clear();
        return res;
      });
      assert.equal(edge[8192].ours, 8192);
      assert.equal(edge[8192].outcome, 'ok');
      assert.equal(edge[8193].ours, 8193);
      assert.match(edge[8193].outcome, /kQuotaBytesPerItem|QUOTA_BYTES_PER_ITEM/);
      assert.equal(edge[8193].kind, 'item', `classify(${JSON.stringify(edge[8193].outcome)})`);

      // the store in two tabs (chrome.storage.onChanged applies changes live in every open tab)
      const start = (p) => p.evaluate(async (config) => {
        window.events = [];
        window.st = PCD.store.create({ config });
        st.subscribe((s, info) => events.push(info.source + ':' + info.changed.join(',')));
        return st.load();
      }, CONFIG);
      assert.equal((await start(A)).city, 'Berlin');
      await start(B);
      const wrote = await A.evaluate(async () => {
        const p = st.set({ city: 'Oslo', units: 'F' });
        await st.flush();
        return { r: await p, raw: await chrome.storage.sync.get(null) };
      });
      assert.equal(wrote.r.written, true);
      assert.deepEqual(wrote.raw, { settings: { v: 1, city: 'Oslo', units: 'F' } });
      await B.waitFor(`st.get().city === 'Oslo' && st.get().units === 'F'`, { timeoutMs: 5000 });
      assert.deepEqual(await B.evaluate('events'), ['remote:city,units']);
      assert.deepEqual(await A.evaluate('events'), ['local:city,units'], 'the echo of its own write is silent');

      // the worst case: split into items Chrome counts at <= 4096 bytes; the other tab and a new tab read it back
      const split = await A.evaluate(async (list) => {
        const p = st.set({ shortcuts: list, city: '<'.repeat(80) });
        await st.flush();
        await p;
        const all = await chrome.storage.sync.get(null);
        const bytes = {};
        for (const k of Object.keys(all)) bytes[k] = [await chrome.storage.sync.getBytesInUse(k), PCD.store.itemBytes(k, all[k])];
        return { keys: Object.keys(all).sort(), bytes, status: st.status(), shortcuts: st.get().shortcuts };
      }, bigList());
      assert.ok(split.keys.length >= 3 && split.keys.includes('settings'), split.keys.join(', '));
      for (const [k, [chromeCount, ours]] of Object.entries(split.bytes)) {
        assert.equal(ours, chromeCount, `${k}: counted alike`);
        assert.ok(chromeCount <= 4096, `${k}: ${chromeCount} bytes`);
      }
      assert.equal(split.status.split, true);
      assert.equal(split.shortcuts.length, 9);
      await B.waitFor(`st.get().shortcuts.length === 9 && st.get().city.length === 80`, { timeoutMs: 5000 });
      assert.deepEqual(await B.evaluate('st.get().shortcuts'), split.shortcuts);
      const C = await browser.newPage(`chrome-extension://${id}/test.html`);
      const fresh = await C.evaluate((config) => PCD.store.create({ config }).load(), CONFIG);
      assert.deepEqual(fresh.shortcuts, split.shortcuts);
      // a short list again: back to one item
      const back = await A.evaluate(async () => {
        const p = st.set({ shortcuts: [{ label: 'x', url: 'x.example.com' }] });
        await st.flush();
        await p;
        return Object.keys(await chrome.storage.sync.get(null)).sort();
      });
      assert.deepEqual(back, ['settings']);
      for (const p of [A, B, C]) assert.deepEqual(p.errors, [], 'no console error, exception or CSP violation');

      // preview mode: a 127.0.0.1 page has no chrome.runtime.id, so localStorage; other tabs follow
      srv = await serve(preview);
      const P1 = await browser.newPage(srv.url + 'test.html');
      const P2 = await browser.newPage(srv.url + 'test.html');
      assert.equal(await P1.evaluate('PCD.store.openArea().kind'), 'localStorage (preview)');
      await start(P1);
      await start(P2);
      const stored = await P1.evaluate(async () => {
        const p = st.set({ city: 'Rome', focusTerminal: false });
        await st.flush();
        await p;
        return localStorage.getItem('pcd.sync.settings');
      });
      assert.deepEqual(JSON.parse(stored), { v: 1, city: 'Rome', focusTerminal: false });
      await P2.waitFor(`st.get().city === 'Rome' && st.get().focusTerminal === false`, { timeoutMs: 5000 });
      assert.deepEqual(await P2.evaluate('events'), ['remote:city,focusTerminal'], 'the storage event carried it');
      for (const p of [P1, P2]) assert.deepEqual(p.errors, []);

      // Lively opens the page from a local folder: classic scripts from file:// work, modules would not
      const L = await browser.newPage(pathToFileURL(path.join(lively, 'test.html')).href);
      const wp = await L.evaluate((menu, config) => {
        const props = PCD.wpProps.buildProperties(config, { menu });
        return { problems: PCD.wpProps.checkProperties(props), theme: props.theme, state: PCD.wpProps.stateFromProperties(props, { menu, config }) };
      }, MENU, CONFIG);
      assert.deepEqual(wp.problems, []);
      assert.deepEqual(wp.theme.items, MENU.map((t) => t.name));
      assert.equal(wp.state.city, 'Berlin');
      assert.deepEqual(L.errors, []);

      // Chrome's own quota messages, each classified to the kind the store reacts to (last: the write
      // rate blocks set() for a minute)
      const real = await A.evaluate(async () => {
        const s = chrome.storage.sync;
        const msg = async (f) => {
          try {
            await f();
            return 'ok';
          } catch (e) {
            return String(e && e.message);
          }
        };
        const kind = (m) => (m === 'ok' ? 'ok' : PCD.store.classify(new Error(m)));
        await s.clear();
        const many = {};
        for (let i = 0; i < 13; i++) many['t' + i] = 'y'.repeat(7990);
        const total = await msg(() => s.set(many));
        const items = {};
        for (let i = 0; i < 513; i++) items['i' + i] = 1;
        const maxItems = await msg(() => s.set(items));
        await s.clear();
        let n = 0;
        let rate = 'ok';
        for (; n < 200 && rate === 'ok'; n++) rate = await msg(() => s.set({ w: n }));
        return { total: [total, kind(total)], maxItems: [maxItems, kind(maxItems)], rate: [rate, kind(rate), n] };
      });
      assert.equal(real.total[1], 'total', real.total[0]);
      assert.equal(real.maxItems[1], 'items', real.maxItems[0]);
      assert.equal(real.rate[1], 'rate-minute', real.rate[0]);
      assert.ok(real.rate[2] <= 121, `refused after ${real.rate[2]} writes in a minute`);
    } finally {
      if (browser) await browser.close();
      if (srv) await srv.close();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
