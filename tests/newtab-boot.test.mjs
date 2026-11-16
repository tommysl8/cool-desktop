// src/newtab/boot.js in a vm sandbox with a fake window and document: the focus redirect, ON by default (the
// terminal gets the keys on Ctrl+T) and off with the mirror's focusTerminal false (the settings sheet); the first
// document replaces itself once with ?focus (other query parameters kept) and starts nothing; a document with focus in
// its query never redirects (no loop); the CSP violation log; and the mirror (reduced motion) applied before first
// paint, with every bad or missing value ignored, nothing else painted from it (the first paint is bg) and blocked
// storage survived.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { test } from 'node:test';

function findRoot(dir) {
  for (let d = dir; ; d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, 'tools', 'build.mjs'))) return d;
    if (path.dirname(d) === d) throw new Error('repo root not found');
  }
}
const ROOT = findRoot(import.meta.dirname);
const FILE = path.join(ROOT, 'src', 'newtab', 'boot.js');
const CODE = fs.readFileSync(FILE, 'utf8');

function runBoot({ search = '?focus', storage = {}, reduced = false, blocked = false, noMatchMedia = false } = {}) {
  const replaced = [];
  const classes = [];
  const props = {};
  const attrs = {};
  const listeners = {};
  const window = {
    location: { search, pathname: '/newtab.html', replace: (u) => replaced.push(u) },
    get localStorage() {
      if (blocked) throw new Error('SecurityError: storage is blocked');
      return { getItem: (k) => (Object.prototype.hasOwnProperty.call(storage, k) ? storage[k] : null) };
    },
  };
  if (!noMatchMedia) window.matchMedia = (q) => ({ matches: reduced && /prefers-reduced-motion:\s*reduce/.test(q) });
  const document = {
    addEventListener: (t, fn) => { listeners[t] = fn; },
    documentElement: {
      style: { setProperty: (k, v) => { props[k] = v; } },
      classList: { add: (c) => classes.push(c) },
      setAttribute: (k, v) => { attrs[k] = v; },
    },
  };
  vm.runInNewContext(CODE, { window, document }, { filename: 'boot.js' });
  return { window, replaced, classes, props, attrs, listeners };
}

const mirror = (m) => ({ 'pcd.mirror': JSON.stringify(m) });

/** Follow the redirect like Chrome does: the next document runs boot.js with the new query. */
function openTab(opts) {
  const docs = [];
  let search = opts.search;
  for (let i = 0; i < 5; i++) {
    const r = runBoot({ ...opts, search });
    docs.push({ search, r });
    if (!r.replaced.length) break;
    search = r.replaced[0].slice('/newtab.html'.length);
  }
  return docs;
}

test('boot.js is a small classic script: under 2 KB, no module syntax, no network, no timers', () => {
  const bytes = fs.statSync(FILE).size;
  assert.ok(bytes < 2048, `${bytes} bytes`);
  assert.ok(!/\bimport\b|\bexport\b|fetch\(|XMLHttpRequest|setTimeout|setInterval|innerHTML|eval\(/.test(CODE));
  assert.doesNotThrow(() => new vm.Script(CODE));
});

test('focus redirect on by default: the first document replaces itself with ?focus once and starts nothing', () => {
  for (const storage of [{}, mirror({ theme: 'halloween' }), mirror({ focusTerminal: true }), mirror({ focusTerminal: 'no' })]) {
    const r = runBoot({ search: '', storage });
    assert.deepEqual(r.replaced, ['/newtab.html?focus'], JSON.stringify(storage));
    assert.equal(r.window.__pcdRedirecting, true);
    assert.equal(r.window.__pcdCsp, undefined, 'nothing else starts in the first document');
    assert.deepEqual(r.classes, []);
    assert.deepEqual(r.props, {});
    assert.deepEqual(r.attrs, {});
  }
  // the second document: no redirect, the CSP log and the mirror run
  const second = runBoot({ search: '?focus', storage: mirror({ reducedMotion: 'on' }) });
  assert.deepEqual(second.replaced, []);
  assert.equal(second.window.__pcdRedirecting, undefined);
  assert.ok(Array.isArray(second.window.__pcdCsp));
  assert.deepEqual(second.props, {}, 'no colour from the mirror: the page is bg');
  assert.deepEqual(second.classes, ['pcd-reduced']);
});

test('focus redirect: other query parameters are kept, and a query with focus never redirects (no loop)', () => {
  assert.deepEqual(runBoot({ search: '?at=2026-10-31T21:00' }).replaced, ['/newtab.html?at=2026-10-31T21:00&focus']);
  assert.deepEqual(runBoot({ search: '?nofocus=1' }).replaced, ['/newtab.html?nofocus=1&focus']);
  for (const search of ['?focus', '?focus=1', '?focus&at=2026-12-24T23:00', '?at=2026-12-24T23:00&focus', '?x=1&focus=', '?x=1&focus&y=2']) {
    assert.deepEqual(runBoot({ search }).replaced, [], search);
  }
  for (const search of ['', '?at=2026-11-26T13:00', '?status=ringing&x=%26focus']) {
    const docs = openTab({ search, storage: {} });
    assert.equal(docs.length, 2, `${search}: exactly one redirect, then the page runs`);
    assert.deepEqual(docs[1].r.replaced, []);
    assert.ok(Array.isArray(docs[1].r.window.__pcdCsp));
  }
});

test('focus redirect off (mirror focusTerminal false): no redirect, Chrome keeps its own focus; the mirror applies', () => {
  for (const search of ['', '?x=1', '?focus']) {
    const r = runBoot({ search, storage: mirror({ focusTerminal: false, reducedMotion: 'on' }) });
    assert.deepEqual(r.replaced, [], `search ${JSON.stringify(search)}`);
    assert.equal(r.window.__pcdRedirecting, undefined);
    assert.ok(Array.isArray(r.window.__pcdCsp));
    assert.deepEqual(r.props, {}, 'nothing painted from the mirror: the page is bg');
    assert.deepEqual(r.classes, ['pcd-reduced']);
  }
});

test('blocked storage: the redirect still works (on by default); the second document survives without a mirror', () => {
  assert.deepEqual(runBoot({ search: '', blocked: true }).replaced, ['/newtab.html?focus']);
  const r = runBoot({ search: '?focus', blocked: true });
  assert.deepEqual(r.replaced, []);
  assert.deepEqual(r.classes, []);
  assert.deepEqual(r.props, {});
  assert.ok(Array.isArray(r.window.__pcdCsp));
});

test('CSP violations are recorded from the start', () => {
  const r = runBoot();
  const log = () => JSON.parse(JSON.stringify(r.window.__pcdCsp)); // the sandbox has its own Array
  assert.deepEqual(log(), []);
  r.listeners.securitypolicyviolation({ effectiveDirective: 'script-src', blockedURI: 'inline', sourceFile: 'newtab.html', lineNumber: 3 });
  r.listeners.securitypolicyviolation({ violatedDirective: 'img-src' });
  assert.deepEqual(log(), [
    { directive: 'script-src', blocked: 'inline', source: 'newtab.html', line: 3 },
    { directive: 'img-src', blocked: '', source: '', line: 0 },
  ]);
});

test('the mirror paints nothing but reduced motion: the first paint is bg', () => {
  const r = runBoot({ storage: mirror({ v: 1, nope: '#231C23', theme: 'halloween', clock24: true, reducedMotion: 'on', performance: 'on' }) });
  assert.deepEqual(r.props, {}, 'no colour from the mirror: the first paint is bg');
  assert.deepEqual(r.classes, ['pcd-reduced']);
  assert.deepEqual(r.attrs, {}, 'the theme, the clock and the performance setting are the app\'s (it reads the same mirror)');
  const n = runBoot({ storage: mirror({ nope: '#141016', theme: 'auto', clock24: false, reducedMotion: 'off', performance: 'auto' }) });
  assert.deepEqual(n.classes, []);
  assert.deepEqual(n.attrs, {});
});

test('reduced motion "auto" follows prefers-reduced-motion; "off" wins over it; no matchMedia is fine', () => {
  assert.ok(runBoot({ reduced: true, storage: mirror({ reducedMotion: 'auto' }) }).classes.includes('pcd-reduced'));
  assert.ok(!runBoot({ reduced: false, storage: mirror({ reducedMotion: 'auto' }) }).classes.includes('pcd-reduced'));
  assert.ok(!runBoot({ reduced: true, storage: mirror({ reducedMotion: 'off' }) }).classes.includes('pcd-reduced'));
  assert.ok(runBoot({ noMatchMedia: true, storage: mirror({ reducedMotion: 'on' }) }).classes.includes('pcd-reduced'));
  assert.ok(!runBoot({ noMatchMedia: true, storage: mirror({ reducedMotion: 'auto' }) }).classes.includes('pcd-reduced'));
});

test('bad or missing mirror values are ignored, garbage never throws', () => {
  const bad = runBoot({ storage: mirror({ nope: 'red', theme: '<script>', clock24: 'yes', performance: true }) });
  assert.deepEqual(bad.props, {});
  assert.deepEqual(bad.attrs, {});
  assert.deepEqual(bad.classes, []);
  for (const raw of ['{', 'null', '"text"', '42', '[]', '']) {
    const first = runBoot({ search: '', storage: { 'pcd.mirror': raw } });
    assert.deepEqual(first.replaced, ['/newtab.html?focus'], `${raw}: garbage means the default (redirect on)`);
    const r = runBoot({ storage: { 'pcd.mirror': raw } });
    assert.ok(Array.isArray(r.window.__pcdCsp), raw);
    assert.deepEqual(r.props, {}, raw);
  }
});
