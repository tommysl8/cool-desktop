// The clock status line on the page (src/newtab/js/ntp-status.js: mountLine() and pulse()) with a tiny fake DOM
// and fake timers: the line's text, spans, kind and tone for every fixture in
// 12 h and 24 h; nothing before start(); the ringing hook (the page's ringing(on), or the built-in 2 Hz pulse on a
// ring target, steady under reduced motion); hidden tab -> no request and no pulse timer; 'online' asks at once;
// clockStatus off -> hidden and never fetched; preview pages never fetch (a sample() shows instead); destroy().
// The real browser run of the same page code is tools/test-newtab-status.mjs.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

function findRoot(dir) {
  for (let d = dir; ; d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, 'tools', 'build.mjs'))) return d;
    if (path.dirname(d) === d) throw new Error('repo root not found');
  }
}
const ROOT = findRoot(import.meta.dirname);
const require = createRequire(import.meta.url);
const S = require(path.join(ROOT, 'src', 'newtab', 'js', 'ntp-status.js'));
const { FIXTURES, loadFixtures } = await import(pathToFileURL(path.join(ROOT, 'tools', 'mock-clock.mjs')).href);
const RAW = loadFixtures();

// ------------------------------------------------------------------------------------------------ fakes

class FakeNode {
  constructor(doc, tag, text = '') {
    this.ownerDocument = doc;
    this.tagName = tag ? tag.toUpperCase() : null;
    this.nodeType = tag ? 1 : 3;
    this.childNodes = [];
    this.parentNode = null;
    this.attrs = new Map();
    this.hidden = false;
    this.className = '';
    this.text = text;
  }
  get firstChild() { return this.childNodes[0] || null; }
  get children() { return this.childNodes.filter((n) => n.nodeType === 1); }
  get classList() {
    const self = this;
    const list = () => self.className.split(/\s+/).filter(Boolean);
    return {
      add(c) { if (!list().includes(c)) self.className = [...list(), c].join(' '); },
      remove(c) { self.className = list().filter((x) => x !== c).join(' '); },
      contains(c) { return list().includes(c); },
    };
  }
  appendChild(n) {
    if (n.parentNode) n.parentNode.removeChild(n);
    n.parentNode = this;
    this.childNodes.push(n);
    return n;
  }
  removeChild(n) {
    const i = this.childNodes.indexOf(n);
    if (i >= 0) this.childNodes.splice(i, 1);
    n.parentNode = null;
    return n;
  }
  get textContent() { return this.nodeType === 3 ? this.text : this.childNodes.map((c) => c.textContent).join(''); }
  set textContent(v) {
    if (this.nodeType === 3) { this.text = String(v); return; }
    for (const c of this.childNodes) c.parentNode = null;
    this.childNodes = [];
    if (String(v)) this.appendChild(new FakeNode(this.ownerDocument, null, String(v)));
  }
  setAttribute(k, v) { this.attrs.set(k, String(v)); }
  getAttribute(k) { return this.attrs.has(k) ? this.attrs.get(k) : null; }
  removeAttribute(k) { this.attrs.delete(k); }
  hasAttribute(k) { return this.attrs.has(k); }
}

function emitter(extra = {}) {
  const listeners = {};
  return Object.assign({
    listeners,
    addEventListener(type, fn) { (listeners[type] ||= new Set()).add(fn); },
    removeEventListener(type, fn) { if (listeners[type]) listeners[type].delete(fn); },
    dispatch(type) { for (const fn of [...(listeners[type] || [])]) fn({ type }); },
    count() { return Object.values(listeners).reduce((n, s) => n + s.size, 0); },
  }, extra);
}

function fakeDocument() {
  const doc = emitter({ visibilityState: 'visible' });
  doc.createElement = (t) => new FakeNode(doc, t);
  doc.createTextNode = (t) => new FakeNode(doc, null, t);
  doc.body = new FakeNode(doc, 'body');
  return doc;
}

function fakeWindow({ reduce = false } = {}) {
  const mq = emitter({ matches: reduce });
  const win = emitter({ mq });
  win.matchMedia = (q) => { assert.equal(q, '(prefers-reduced-motion: reduce)'); return mq; };
  return win;
}

const T0 = 1794794400000;
function fakeTime(start = T0) {
  let t = start;
  let ids = 0;
  const timers = new Map();
  const flush = () => new Promise((r) => setImmediate(r));
  return {
    now: () => t,
    setTimeout: (fn, ms) => { const id = ++ids; timers.set(id, { at: t + Math.max(0, Number(ms) || 0), fn }); return id; },
    clearTimeout: (id) => { timers.delete(id); },
    timers,
    async advance(ms) {
      const end = t + ms;
      for (;;) {
        await flush();
        let pick = null;
        for (const [id, x] of timers) if (x.at <= end && (!pick || x.at < pick[1].at || (x.at === pick[1].at && id < pick[0]))) pick = [id, x];
        if (!pick) break;
        timers.delete(pick[0]);
        t = Math.max(t, pick[1].at);
        pick[1].fn();
      }
      t = end;
      await flush();
    },
  };
}

const answer = (text, code = 200) => Promise.resolve({ status: code, text: () => Promise.resolve(text) });

/** A mounted line with fake DOM, timers and fetch; `scenario` (a fixture name, 'error' or a function) is mutable. */
function setup({ settings = {}, start = true, sample, preview, onRinging, ring = true, reduce = false, chrome = null, cache } = {}) {
  const time = fakeTime();
  const doc = fakeDocument();
  const win = fakeWindow({ reduce });
  const win2 = new FakeNode(doc, 'pre');
  const parent = new FakeNode(doc, 'div');
  const calls = [];
  const ctl = { scenario: 'normal' };
  const fetch = (url, init) => {
    calls.push({ url, init, at: time.now() });
    const sc = ctl.scenario;
    if (typeof sc === 'function') return sc(url, init);
    if (sc === 'error') return answer('{"error":{"code":"internal"}}', 500);
    return answer(RAW[sc]);
  };
  const client = { fetch, now: time.now, setTimeout: time.setTimeout, clearTimeout: time.clearTimeout };
  if (cache !== undefined) client.cache = cache;
  const line = S.mountLine({
    parent, document: doc, window: win, chrome, settings, sample, preview, onRinging,
    ringTarget: ring ? win2 : undefined, client: preview ? { now: time.now, setTimeout: time.setTimeout, clearTimeout: time.clearTimeout } : client,
  });
  if (start) line.start();
  return { time, doc, win, target: win2, parent, calls, ctl, line };
}

const LINES12 = Object.fromEntries(FIXTURES.map((n) => [n, S.describe(S.parse(RAW[n]).status, { clock24: false })]));
const LINES24 = Object.fromEntries(FIXTURES.map((n) => [n, S.describe(S.parse(RAW[n]).status, { clock24: true })]));

// ------------------------------------------------------------------------------------------------ pulse()

test('pulse: ringing flips pcd-ring-on every 250 ms (frame/ring at 2 Hz); off removes every class and the timer', async () => {
  const time = fakeTime();
  const el = new FakeNode(null, 'pre');
  const p = S.pulse(el, { setTimeout: time.setTimeout, clearTimeout: time.clearTimeout });
  assert.equal(S.RING_TOGGLE_MS, 250);
  assert.equal(el.className, '');
  p.set(true);
  assert.deepEqual(el.className.split(' ').sort(), ['pcd-ring-on', 'pcd-ringing'], 'starts on the ring colour');
  const seen = [];
  for (let i = 0; i < 8; i++) {
    await time.advance(125);
    seen.push(el.classList.contains('pcd-ring-on') ? 1 : 0);
  }
  assert.deepEqual(seen, [1, 0, 0, 1, 1, 0, 0, 1], 'a flip every 250 ms');
  assert.equal(p.state().flips, 4);
  assert.equal(p.state().timer, true);
  p.set(false);
  assert.equal(el.className, '');
  assert.equal(time.timers.size, 0, 'no timer left');
  assert.deepEqual(p.state(), { on: false, ringOn: false, steady: false, paused: false, timer: false, flips: 4 });
});

test('pulse: reduced motion is a steady ring with no timer; turning it off while ringing starts the flips', async () => {
  const time = fakeTime();
  const el = new FakeNode(null, 'pre');
  const p = S.pulse(el, { reducedMotion: true, setTimeout: time.setTimeout, clearTimeout: time.clearTimeout });
  p.set(true);
  assert.deepEqual(el.className.split(' ').sort(), ['pcd-ring-on', 'pcd-ring-steady', 'pcd-ringing']);
  await time.advance(2000);
  assert.equal(time.timers.size, 0);
  assert.equal(p.state().flips, 0);
  assert.equal(p.state().steady, true);
  p.setReducedMotion(false);
  assert.equal(el.classList.contains('pcd-ring-steady'), false);
  await time.advance(250);
  assert.equal(p.state().flips, 1);
  p.setReducedMotion(true);
  assert.equal(time.timers.size, 0);
  assert.equal(el.classList.contains('pcd-ring-on'), true, 'steady on the ring colour');
});

test('pulse: paused (hidden tab) leaves no timer; resume starts again on the ring colour; dispose clears everything', async () => {
  const time = fakeTime();
  const el = new FakeNode(null, 'pre');
  const p = S.pulse(el, { setTimeout: time.setTimeout, clearTimeout: time.clearTimeout });
  p.set(true);
  await time.advance(250);
  p.pause();
  assert.equal(time.timers.size, 0);
  const flips = p.state().flips;
  await time.advance(5000);
  assert.equal(p.state().flips, flips, 'no flips while paused');
  p.resume();
  assert.equal(el.classList.contains('pcd-ring-on'), true);
  assert.equal(time.timers.size, 1);
  p.dispose();
  assert.equal(el.className, '');
  assert.equal(time.timers.size, 0);
  p.set(true);
  assert.equal(el.className, '', 'nothing after dispose');
});

test('motionReduced: on/off/booleans win; auto asks prefers-reduced-motion; no matchMedia means motion', () => {
  assert.equal(S.motionReduced('on'), true);
  assert.equal(S.motionReduced(true), true);
  assert.equal(S.motionReduced('off', fakeWindow({ reduce: true })), false);
  assert.equal(S.motionReduced(false), false);
  assert.equal(S.motionReduced('auto', fakeWindow({ reduce: true })), true);
  assert.equal(S.motionReduced('auto', fakeWindow({ reduce: false })), false);
  assert.equal(S.motionReduced('auto', {}), false);
  assert.equal(S.motionReduced('auto', { matchMedia() { throw new Error('x'); } }), false);
});

// ------------------------------------------------------------------------------------------------ mountLine()

test('mountLine: a hidden <p class="pcd-status" role="status"> in the parent; nothing is requested before start()', async () => {
  const { time, parent, calls, line } = setup({ start: false });
  assert.equal(parent.children.length, 1);
  const el = parent.children[0];
  assert.equal(el, line.el);
  assert.equal(el.tagName, 'P');
  assert.equal(el.className, 'pcd-status');
  assert.equal(el.getAttribute('role'), 'status');
  assert.equal(el.hidden, true);
  await time.advance(60000);
  assert.equal(calls.length, 0, 'no request before start()');
  line.start();
  await time.advance(299);
  assert.equal(calls.length, 0);
  await time.advance(1);
  assert.equal(calls.length, 1, 'the first request 300 ms after start()');
  assert.equal(calls[0].url, 'http://pixelclock.local/api/status');
  assert.equal(el.hidden, false);
});

test('lineText / describe().time: the line as the column shows it (no "pixelclock" segment), the time picked out', () => {
  const want = {
    normal: ['⌂ next alarm tomorrow 7:00 am · work', '7:00 am', '⌂ next alarm tomorrow 07:00 · work', '07:00'],
    ringing: ['⌂ ringing · work', null, '⌂ ringing · work', null],
    snoozed: ['⌂ snoozed until 8:09 pm · work', '8:09 pm', '⌂ snoozed until 20:09 · work', '20:09'],
    testing: ['⌂ ringing · test', null, '⌂ ringing · test', null],
    'first-boot': ['⌂ no alarm set', null, '⌂ no alarm set', null],
    'no-time': ['⌂ time not set', null, '⌂ time not set', null],
    'safe-mode': ['⌂ next alarm tomorrow 7:00 am · work', '7:00 am', '⌂ next alarm tomorrow 07:00 · work', '07:00'],
  };
  for (const name of FIXTURES) {
    assert.deepEqual([S.lineText(LINES12[name]), LINES12[name].time, S.lineText(LINES24[name]), LINES24[name].time], want[name], name);
  }
  assert.equal(S.lineText(S.describe(null)), '');
  assert.equal(S.describe(null).time, null);
  assert.equal(S.lineText(null), '');
});

test('mountLine: every fixture in 12 h and 24 h: the text, the spans (time inside), data-kind and data-tone', async () => {
  const { time, ctl, line } = setup({ onRinging: () => {} });
  for (const name of FIXTURES) {
    ctl.scenario = name;
    line.refresh();
    await time.advance(1);
    for (const [clock24, want] of [[false, LINES12[name]], [true, LINES24[name]]]) {
      line.update({ clock24 });
      const el = line.el;
      const label = `${name} ${clock24 ? '24' : '12'} h`;
      assert.equal(el.hidden, false, name);
      assert.equal(el.textContent, S.lineText(want), label);
      assert.equal(el.getAttribute('data-kind'), want.kind, name);
      assert.equal(el.getAttribute('data-tone'), want.tone, name);
      const spans = el.children.map((c) => [c.className, c.textContent]);
      assert.deepEqual(spans[0], ['pcd-status__glyph', '⌂']);
      assert.equal(el.children[0].getAttribute('aria-hidden'), 'true', 'the glyph is decoration');
      const parts = want.parts.slice(1);
      assert.deepEqual(spans.slice(1), parts.flatMap((p, i) => (i === 0 ? [['pcd-status__what', p]] : [['pcd-status__sep', ' · '], ['pcd-status__label', p]])), label);
      const what = el.children[1];
      const timeSpan = what.children.find((c) => c.className === 'pcd-status__time');
      assert.equal(timeSpan ? timeSpan.textContent : null, want.time, `${label}: the time span`);
      const st = line.state();
      assert.equal(st.text, S.lineText(want));
      assert.equal(st.shown, true);
    }
    line.update({ clock24: false });
  }
});

test('mountLine: the page\'s ringing(on) hears every change, once; ringing and testing ring, snoozed does not', async () => {
  const heard = [];
  const { time, ctl, line, target } = setup({ onRinging: (on) => heard.push(on) });
  await time.advance(300);
  assert.deepEqual(heard, []);
  ctl.scenario = 'ringing';
  line.refresh();
  await time.advance(1);
  assert.deepEqual(heard, [true]);
  ctl.scenario = 'testing';
  line.refresh();
  await time.advance(1);
  assert.deepEqual(heard, [true], 'still ringing: no second call');
  ctl.scenario = 'snoozed';
  line.refresh();
  await time.advance(1);
  assert.deepEqual(heard, [true, false]);
  assert.equal(target.className, '', 'with the page\'s hook the built-in pulse stays off');
  assert.equal(line.state().pulse, null);
});

test('mountLine: without the page\'s hook the ring target pulses; reduced motion (setting or system) holds it steady', async () => {
  const { time, ctl, line, target, win } = setup({ settings: { reducedMotion: 'auto' } });
  ctl.scenario = 'ringing';
  await time.advance(300);
  assert.equal(line.state().ringing, true);
  assert.equal(target.classList.contains('pcd-ringing'), true);
  const f0 = line.state().pulse.flips;
  await time.advance(1000);
  assert.equal(line.state().pulse.flips - f0, 4, 'four flips a second');
  line.update({ reducedMotion: 'on' });
  assert.equal(line.state().pulse.steady, true);
  assert.equal(target.classList.contains('pcd-ring-steady'), true);
  const f1 = line.state().pulse.flips;
  await time.advance(1000);
  assert.equal(line.state().pulse.flips, f1, 'no flips under reduced motion');
  line.update({ reducedMotion: 'auto' });
  assert.equal(line.state().pulse.steady, false);
  win.mq.matches = true;
  win.mq.dispatch('change');
  assert.equal(line.state().pulse.steady, true, 'the system setting follows while the setting is auto');
  assert.equal(line.state().reducedMotion, true);
  ctl.scenario = 'normal';
  line.refresh();
  await time.advance(1);
  assert.equal(target.className, '', 'not ringing any more: no class');
});

test('mountLine: a hidden tab asks nothing and stops the pulse; visible again it carries on', async () => {
  const { time, doc, ctl, calls, line } = setup();
  ctl.scenario = 'ringing';
  await time.advance(300);
  assert.equal(calls.length, 1);
  doc.visibilityState = 'hidden';
  doc.dispatch('visibilitychange');
  assert.equal(line.state().visible, false);
  assert.equal(line.state().pulse.timer, false);
  assert.equal(time.timers.size, 0, 'no timer at all while hidden');
  await time.advance(10 * 60000);
  assert.equal(calls.length, 1, 'no request while hidden');
  doc.visibilityState = 'visible';
  doc.dispatch('visibilitychange');
  assert.equal(line.state().pulse.timer, true);
  await time.advance(1);
  assert.equal(calls.length, 2, 'the overdue poll goes out on show');
});

test('mountLine: "online" asks at once', async () => {
  const { time, win, calls } = setup();
  await time.advance(300);
  assert.equal(calls.length, 1);
  win.dispatch('online');
  await time.advance(1);
  assert.equal(calls.length, 2);
});

test('mountLine: two failures in a row hide the line and stop the ringing', async () => {
  const heard = [];
  const { time, ctl, line } = setup({ onRinging: (on) => heard.push(on) });
  ctl.scenario = 'ringing';
  await time.advance(300);
  assert.equal(line.state().shown, true);
  ctl.scenario = 'error';
  line.refresh();
  await time.advance(1);
  assert.equal(line.state().shown, true, 'one failure: the line stays');
  line.refresh();
  await time.advance(1);
  assert.equal(line.state().shown, false, 'two: gone');
  assert.equal(line.el.hidden, true);
  assert.equal(line.el.textContent, '');
  assert.deepEqual(heard, [true, false]);
});

test('mountLine: clockStatus off never fetches and hides the line; on again it asks', async () => {
  const { time, ctl, calls, line } = setup({ settings: { clockStatus: false } });
  await time.advance(60000);
  assert.equal(calls.length, 0);
  assert.equal(line.state().enabled, false);
  line.update({ clockStatus: true });
  await time.advance(300);
  assert.equal(calls.length, 1);
  assert.equal(line.state().shown, true);
  ctl.scenario = 'ringing';
  line.refresh();
  await time.advance(1);
  assert.equal(line.state().ringing, true);
  line.update({ clockStatus: false });
  assert.equal(line.state().shown, false);
  assert.equal(line.state().ringing, false);
  await time.advance(60000);
  assert.equal(calls.length, 2);
  assert.equal(line.refresh(), false);
});

test('mountLine: preview pages never fetch; a sample shows instead (and still follows 12/24 h and clockStatus)', async () => {
  const { time, calls, line } = setup({ preview: true });
  await time.advance(60000);
  assert.equal(calls.length, 0);
  assert.equal(line.state().preview, true);
  assert.equal(line.state().shown, false);

  const s = setup({ sample: 'ringing', onRinging: () => {} });
  await s.time.advance(60000);
  assert.equal(s.calls.length, 0, 'a sample never fetches');
  assert.equal(s.line.el.textContent, '⌂ ringing · work');
  assert.equal(s.line.state().ringing, true);
  const sn = setup({ sample: 'snoozed', settings: { clock24: true } });
  assert.equal(sn.line.el.textContent, '⌂ snoozed until 20:09 · work');
  sn.line.update({ clockStatus: false });
  assert.equal(sn.line.el.hidden, true);
});

test('mountLine: an extension page (chrome.runtime.id) caches in chrome.storage.session; a plain page is a preview', async () => {
  const stored = {};
  const session = {
    get: (k) => Promise.resolve({ [k]: stored[k] }),
    set: (o) => { Object.assign(stored, o); return Promise.resolve(); },
  };
  const ext = setup({ chrome: { runtime: { id: 'abc' }, storage: { session } } });
  await ext.time.advance(300);
  assert.equal(ext.line.state().preview, false);
  assert.equal(stored.clockStatus && stored.clockStatus.status.next.time, '07:00', 'the normalized answer is cached');

  // no fetch/url override and no runtime id: a preview, even though fetch exists
  const doc = fakeDocument();
  const line = S.mountLine({ document: doc, window: fakeWindow(), chrome: { storage: { session } }, parent: doc.body });
  assert.equal(line.state().preview, true);
  line.start();
  line.destroy();
});

test('mountLine: destroy() stops everything, removes its listeners and the element it made', async () => {
  const heard = [];
  const { time, doc, win, ctl, calls, line, parent } = setup({ onRinging: (on) => heard.push(on) });
  ctl.scenario = 'ringing';
  await time.advance(300);
  assert.ok(doc.count() + win.count() + win.mq.count() > 0);
  line.destroy();
  assert.equal(doc.count() + win.count() + win.mq.count(), 0, 'every listener removed');
  assert.equal(parent.children.length, 0, 'its own element removed');
  assert.deepEqual(heard, [true, false]);
  win.dispatch('online');
  await time.advance(10 * 60000);
  assert.equal(calls.length, 1, 'nothing after destroy');
  line.update({ clock24: true });
  line.destroy();
});

test('mountLine: onView hears every change of what the line shows (for a page that draws the line itself)', async () => {
  const seen = [];
  const time = fakeTime();
  const doc = fakeDocument();
  const ctl = { scenario: 'normal' };
  const fetch = () => answer(RAW[ctl.scenario]);
  const line = S.mountLine({ document: doc, window: fakeWindow(), chrome: null, onView: (v) => seen.push([v.show, v.kind, S.lineText(v)]),
    client: { fetch, now: time.now, setTimeout: time.setTimeout, clearTimeout: time.clearTimeout } });
  line.start();
  await time.advance(300);
  ctl.scenario = 'ringing';
  line.refresh();
  await time.advance(1);
  line.refresh();
  await time.advance(1);
  line.update({ clockStatus: false });
  assert.deepEqual(seen, [
    [false, 'hidden', ''],
    [true, 'next', '⌂ next alarm tomorrow 7:00 am · work'],
    [true, 'ringing', '⌂ ringing · work'],
    [false, 'hidden', ''],
  ], 'once per change; the same answer twice is no change');
  line.destroy();
});

test('mountLine: onAnswer hears every answer (true) and failure (false) of the clock, also when the line does not change', async () => {
  const answers = [];
  const time = fakeTime();
  const doc = fakeDocument();
  const ctl = { scenario: 'normal' };
  const fetch = () => (ctl.scenario === 'down' ? Promise.reject(new TypeError('Failed to fetch')) : answer(RAW[ctl.scenario]));
  const line = S.mountLine({ document: doc, window: fakeWindow(), chrome: null, onAnswer: (ok) => answers.push(ok),
    client: { fetch, now: time.now, setTimeout: time.setTimeout, clearTimeout: time.clearTimeout } });
  await time.advance(1000);
  assert.deepEqual(answers, [], 'nothing before start()');
  line.start();
  await time.advance(300);
  assert.deepEqual(answers, [true]);
  line.refresh();
  await time.advance(1);
  assert.deepEqual(answers, [true, true], 'the same answer again is still an answer');
  ctl.scenario = 'down';
  line.refresh();
  await time.advance(1);
  assert.deepEqual(answers, [true, true, false], 'a failure while the line still shows');
  line.destroy();
});

test('mountLine: a given element is used as it is and stays after destroy()', () => {
  const doc = fakeDocument();
  const el = new FakeNode(doc, 'div');
  el.className = 'hud-line';
  doc.body.appendChild(el);
  const line = S.mountLine({ el, document: doc, window: fakeWindow(), chrome: null, sample: 'first-boot' });
  assert.equal(el.className, 'hud-line pcd-status');
  assert.equal(el.textContent, '⌂ no alarm set');
  line.destroy();
  assert.equal(el.parentNode, doc.body);
});
