// src/shared/pcd-core.js: query params, time and date text, reduced motion, safe storage, role classes and the colour
// maths of PCD.color.
import test from 'node:test';
import assert from 'node:assert/strict';
import { lib, sandbox, engineScripts, plain } from './look-load.mjs';

const color = await lib('tools/lib/color.mjs');
const core = (globals) => sandbox(['src/shared/pcd-core.js'], globals).PCD.core;

function fakeStorage({ failSet = false, failGet = false } = {}) {
  const m = new Map();
  return {
    m,
    getItem(k) { if (failGet) throw new Error('denied'); return m.has(k) ? m.get(k) : null; },
    setItem(k, v) { if (failSet) throw new Error('QuotaExceededError'); m.set(k, String(v)); },
    removeItem(k) { m.delete(k); },
  };
}

function fakeMql(matches) {
  const listeners = new Set();
  return {
    matches,
    media: '(prefers-reduced-motion: reduce)',
    addEventListener(type, fn) { if (type === 'change') listeners.add(fn); },
    removeEventListener(type, fn) { listeners.delete(fn); },
    fire(v) { this.matches = v; for (const fn of listeners) fn({ matches: v }); },
    get count() { return listeners.size; },
  };
}

test('UMD: PCD.core and PCD.color in a page sandbox; module.exports in Node', async () => {
  const ctx = sandbox(['src/shared/pcd-core.js']);
  assert.equal(typeof ctx.PCD.core.formatDate, 'function');
  assert.equal(ctx.PCD.core.color, ctx.PCD.color);
  const { createRequire } = await import('node:module');
  const req = createRequire(import.meta.url);
  const { ROOT } = await import('./look-load.mjs');
  const api = req(`${ROOT}/src/shared/pcd-core.js`);
  assert.equal(typeof api.param, 'function');
  assert.equal(globalThis.PCD.core, api);
});

test('param, params, flag, num, bool', () => {
  const C = core();
  const s = '?theme=autumn&city=New+York&x=%E2%8C%82&theme=winter&empty=&flag&bad=%E2%8C';
  assert.equal(C.param('theme', 'auto', s), 'autumn');
  assert.equal(C.param('city', null, s), 'New York');
  assert.equal(C.param('x', null, s), '⌂');
  assert.equal(C.param('empty', 'd', s), '');
  assert.equal(C.param('flag', 'd', s), '');
  assert.equal(C.param('bad', 'd', s), 'd', 'a malformed escape is skipped');
  assert.equal(C.param('missing', 'd', s), 'd');
  assert.equal(C.param('a', 'd', ''), 'd');
  assert.deepEqual(plain(C.params('a=1&b=2&a=3')), { a: '1', b: '2' });
  assert.equal(core({ location: { search: '?at=2026-10-31T21:00' } }).param('at', null), '2026-10-31T21:00');
  assert.equal(core({ get location() { throw new Error('no'); } }).param('at', 'x'), 'x');
  for (const v of ['1', 'true', 'YES', ' on ']) assert.equal(C.bool(v), true, v);
  for (const v of ['0', 'false', 'No', 'off']) assert.equal(C.bool(v), false, v);
  for (const v of ['', 'maybe', null, undefined, 2, {}]) assert.equal(C.bool(v), null, String(v));
  assert.equal(C.flag('debug', false, '?debug=1'), true);
  assert.equal(C.flag('debug', true, '?debug=0'), false);
  assert.equal(C.flag('debug', 'fb', '?debug=wat'), 'fb');
  assert.equal(C.num('k', 7, { min: 2, max: 64, int: true }, '?k=12.6'), 13);
  assert.equal(C.num('k', 7, { min: 2, max: 64 }, '?k=999'), 64);
  assert.equal(C.num('k', 7, {}, '?k=abc'), 7);
  assert.equal(C.num('k', 7, {}, '?k='), 7);
});

test('clamp, pad, lower (the copy rule)', () => {
  const C = core();
  assert.equal(C.clamp(5, 0, 3), 3);
  assert.equal(C.clamp(-1, 0, 3), 0);
  assert.equal(C.pad(7), '07');
  assert.equal(C.pad(7, 3), '007');
  assert.equal(C.pad(12), '12');
  assert.equal(C.pad(5, 4, ' '), '   5');
  assert.equal(C.lower('  Haunted   Hill '), 'haunted hill');
  assert.equal(C.lower(null), '');
});

test('formatTime: 12 h with lower-case am/pm and no leading zero, 24 h with two digits, every hour', () => {
  const C = core();
  for (let h = 0; h < 24; h++) {
    const d = new Date(2026, 10, 15, h, 7, 9);
    const h12 = h % 12 || 12;
    const ampm = h < 12 ? 'am' : 'pm';
    assert.equal(C.formatTime(d, false), `${h12}:07 ${ampm}`, `12 h ${h}`);
    assert.equal(C.formatTime(d, false, { ampm: false }), `${h12}:07`);
    assert.equal(C.formatTime(d, true), `${String(h).padStart(2, '0')}:07`, `24 h ${h}`);
    assert.equal(C.formatTime(d, true, { seconds: true }), `${String(h).padStart(2, '0')}:07:09`);
    assert.deepEqual(plain(C.timeParts(d, false)), { h: h12, m: 7, s: 9, ampm });
    assert.deepEqual(plain(C.timeParts(d, true)), { h, m: 7, s: 9, ampm: '' });
  }
  assert.equal(C.formatTime(new Date(2026, 0, 1, 0, 0), false), '12:00 am');
  assert.equal(C.formatTime(new Date(2026, 0, 1, 12, 0), false), '12:00 pm');
  assert.equal(C.formatTime(new Date(2026, 0, 1, 9, 41), false), '9:41 am');
  assert.equal(C.formatTime(new Date(2026, 0, 1, 21, 41), true), '21:41');
  assert.equal(C.formatTime(new Date(NaN), false), '');
  assert.equal(C.formatTime('9:41', false), '');
  assert.equal(C.formatClock(7, 0, false), '7:00 am');
  assert.equal(C.formatClock(19, 5, true), '19:05');
  assert.equal(C.formatClock(25, 5, true), '01:05', 'hours wrap');
  assert.equal(C.formatClock(-1, 5, false), '11:05 pm');
  assert.equal(C.formatClock(NaN, 5, false), '');
});

test('formatHours: fractional local hours to the nearest minute (the strip times 7:27 and 4:15)', () => {
  const C = core();
  assert.equal(C.formatHours(7.45, false, { ampm: false }), '7:27');
  assert.equal(C.formatHours(16.25, false, { ampm: false }), '4:15');
  assert.equal(C.formatHours(7.45, true), '07:27');
  assert.equal(C.formatHours(16.25, false), '4:15 pm');
  assert.equal(C.formatHours(7 + 27.5 / 60, true), '07:28', 'half a minute rounds up');
  assert.equal(C.formatHours(23.999, true), '00:00', 'rounds over midnight');
  assert.equal(C.formatHours(-0.5, true), '23:30');
  assert.equal(C.formatHours(NaN, true), '');
  assert.equal(C.formatHours('7', true), '');
});

test('formatDate: "sun nov 15", every weekday and month, no leading zero; dateParts', () => {
  const C = core();
  assert.equal(C.formatDate(new Date(2026, 10, 15, 20)), 'sun nov 15');
  assert.equal(C.formatDate(new Date(2026, 9, 31, 21)), 'sat oct 31');
  assert.equal(C.formatDate(new Date(2026, 10, 1)), 'sun nov 1');
  const days = new Set();
  for (let i = 0; i < 7; i++) days.add(C.formatDate(new Date(2026, 10, 15 + i)).split(' ')[0]);
  assert.deepEqual([...days], ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']);
  for (let m = 0; m < 12; m++) assert.equal(C.formatDate(new Date(2026, m, 10)).split(' ')[1], C.MONTHS[m]);
  assert.deepEqual(plain(C.MONTHS), ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']);
  assert.deepEqual(plain(C.dateParts(new Date(2026, 10, 15))), { weekday: 'sun', weekdayLong: 'sunday', month: 'nov', monthLong: 'november', day: 15, year: 2026 });
  assert.equal(C.formatDate(new Date(NaN)), '');
  assert.equal(C.dateParts(null), null);
  for (const s of [...C.DAYS, ...C.MONTHS, ...C.DAYS_LONG, ...C.MONTHS_LONG]) assert.equal(s, s.toLowerCase());
});

test('agoText: nothing under 60 minutes, then hours, then days', () => {
  const C = core();
  const min = 60000;
  assert.equal(C.agoText(59 * min), '');
  assert.equal(C.agoText(60 * min), '1 h ago');
  assert.equal(C.agoText(125 * min), '2 h ago');
  assert.equal(C.agoText(47 * 60 * min + 59 * min), '47 h ago');
  assert.equal(C.agoText(48 * 60 * min), '2 d ago');
  assert.equal(C.agoText(-5), '');
  assert.equal(C.agoText(NaN), '');
  assert.equal(C.agoText('3600000'), '');
});

test('parseLocal, createClock and clockFromParams (?at= and ?freeze=)', () => {
  const C = core();
  const d = C.parseLocal('2026-10-31T21:00');
  assert.equal(d.getFullYear(), 2026);
  assert.equal(d.getMonth(), 9);
  assert.equal(d.getDate(), 31);
  assert.equal(d.getHours(), 21);
  assert.equal(C.parseLocal('2026-10-31').getHours(), 12, 'no time: noon');
  assert.equal(C.parseLocal('2026-10-31 07:05:09').getSeconds(), 9);
  for (const bad of ['2026-02-30', '2026-13-01', '2026-10-31T24:00', 'tomorrow', '', null]) assert.equal(C.parseLocal(bad), null, String(bad));
  let real = 1000;
  const clock = C.createClock({ at: '2026-12-24T23:00', now: () => real });
  assert.equal(clock.now().getHours(), 23);
  real += 90000;
  assert.equal(clock.now().getMinutes(), 1, 'runs from the start');
  const frozen = C.createClock({ at: '2026-12-24T23:00', frozen: true, now: () => real });
  real += 600000;
  assert.equal(frozen.now().getMinutes(), 0);
  assert.equal(frozen.frozen, true);
  const plainClock = C.createClock({ now: () => 42 });
  assert.equal(plainClock.ms(), 42);
  assert.equal(plainClock.offsetMs, 0);
  assert.equal(C.clockFromParams('?at=2026-07-15T12:00&freeze=1').now().getMonth(), 6);
  assert.equal(C.clockFromParams('').frozen, false);
});

test('reducedMotion: query override, then the setting, then prefers-reduced-motion', () => {
  const on = core({ matchMedia: () => fakeMql(true) });
  const off = core({ matchMedia: () => fakeMql(false) });
  assert.equal(on.reducedMotion('auto', ''), true);
  assert.equal(on.reducedMotion(undefined, ''), true);
  assert.equal(on.reducedMotion(false, ''), true, 'an unticked wallpaper checkbox follows the system');
  assert.equal(on.reducedMotion('off', ''), false, 'the new tab\'s "full" (off) wins over the system');
  assert.equal(off.reducedMotion('auto', ''), false);
  assert.equal(off.reducedMotion('on', ''), true);
  assert.equal(off.reducedMotion(true, ''), true);
  assert.equal(off.reducedMotion('auto', '?reducedMotion=1'), true);
  assert.equal(on.reducedMotion('on', '?reducedMotion=0'), false);
  assert.equal(core().reducedMotion('auto', ''), false, 'no matchMedia');
  assert.equal(core({ matchMedia: () => { throw new Error('x'); } }).reducedMotion('auto', ''), false);
  assert.equal(core().reducedMotionQuery(), null);
});

test('watchReducedMotion and applyMotion', () => {
  const mql = fakeMql(false);
  const C = core({ matchMedia: () => mql });
  const seen = [];
  const stop = C.watchReducedMotion((v) => seen.push(v));
  mql.fire(true);
  mql.fire(false);
  stop();
  mql.fire(true);
  assert.deepEqual(seen, [true, false]);
  assert.equal(mql.count, 0);
  assert.equal(typeof core().watchReducedMotion(() => {}), 'function');
  const classes = new Set();
  const el = { classList: { toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)) } };
  assert.equal(C.applyMotion(true, el), true);
  assert.ok(classes.has('pcd-reduced'));
  C.applyMotion(false, el);
  assert.ok(!classes.has('pcd-reduced'));
  const html = { classList: { toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)) } };
  core({ document: { documentElement: html } }).applyMotion(1);
  assert.ok(classes.has('pcd-reduced'));
});

test('storage: never throws; JSON round trip; unavailable, read-only and missing storage', () => {
  const s = fakeStorage();
  const C = core({ localStorage: s });
  const st = C.storage();
  assert.equal(st.available, true);
  assert.equal(st.get('pcd.x'), null);
  assert.equal(st.get('pcd.x', 'd'), 'd');
  assert.equal(st.set('pcd.x', 5), true);
  assert.equal(st.get('pcd.x'), '5');
  assert.equal(st.setJson('pcd.mirror', { theme: 'auto', clock24: false }), true);
  assert.deepEqual(plain(st.getJson('pcd.mirror')), { theme: 'auto', clock24: false });
  s.m.set('pcd.bad', '{oops');
  assert.deepEqual(st.getJson('pcd.bad', { v: 1 }), { v: 1 });
  assert.equal(st.setJson('pcd.fn', () => 1), false);
  assert.equal(st.remove('pcd.x'), true);
  assert.ok(!s.m.has('pcd.x'));
  assert.ok(!s.m.has('__pcd_probe__'), 'the probe is removed');
  const full = C.storage(fakeStorage({ failSet: true }));
  assert.equal(full.available, false);
  assert.equal(full.set('k', 'v'), false);
  const locked = C.storage(fakeStorage({ failGet: true }));
  assert.equal(locked.get('k', 'd'), 'd');
  const none = core({ get localStorage() { throw new Error('SecurityError'); } }).storage();
  assert.equal(none.available, false);
  assert.equal(none.get('k'), null);
  assert.equal(none.set('k', 1), false);
  assert.equal(none.remove('k'), false);
  assert.equal(C.storage(null).available, false);
});

test('roleClass maps token roles to the pcd-base.css classes', () => {
  const C = core();
  assert.equal(C.roleClass('text bold'), 't-text t-bold');
  assert.equal(C.roleClass('  accent '), 't-accent');
  assert.equal(C.roleClass(''), '');
  assert.equal(C.roleClass(null), '');
  assert.ok(C.ROLES.includes('frame') && C.ROLES.includes('faint') && C.ROLES.includes('clock'));
});

test('PCD.color: int, hex, rgb, mix (as PC.mix), luminance and contrast (as tools/lib/color.mjs)', async () => {
  const ctx = sandbox([...(await engineScripts()), 'src/shared/pcd-core.js']);
  const C = ctx.PCD.color;
  const PC = ctx.PixelClock;
  assert.equal(C.int('#141016'), 0x141016);
  assert.equal(C.int('#FFF'), 0xffffff);
  assert.equal(C.int(0x1ff9a3c), 0xff9a3c);
  assert.equal(C.int([255, 154, 60]), 0xff9a3c);
  assert.equal(C.hex(0x0a0b0c), '#0a0b0c');
  assert.deepEqual(plain(C.rgb('#ff9a3c')), [255, 154, 60]);
  for (const bad of ['141016', '#12345', 'abc', 'red', null, undefined, {}]) assert.throws(() => C.int(bad), /not a colour/, String(bad));
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296);
  for (let i = 0; i < 500; i++) {
    const a = Math.floor(rnd() * 0x1000000), b = Math.floor(rnd() * 0x1000000), t = rnd() * 1.4 - 0.2;
    assert.equal(C.mix(a, b, t), PC.mix(a, b, t), `mix(${a}, ${b}, ${t})`);
  }
  assert.equal(C.mix('#000000', '#ffffff', NaN), 0);
  const tokens = ['#141016', '#1d181f', '#2a2229', '#ece4d8', '#a99d91', '#978d83', '#ff9a3c', '#9a6a40', '#c47a2c', '#6b4428'];
  for (const a of tokens) {
    assert.ok(Math.abs(C.luminance(a) - color.relLuminance(a)) < 1e-12);
    for (const b of tokens) assert.ok(Math.abs(C.contrast(a, b) - color.contrast(a, b)) < 1e-12);
  }
});

test('PCD.color follows PCD.TOKENS when it is loaded (else its built-in copy)', () => {
  const fallback = sandbox(['src/shared/pcd-core.js']).PCD.color;
  assert.equal(fallback.clock(0xffffff), '#faf8f5');
  assert.equal(fallback.tokens().accent, 0xff9a3c);
  const custom = {
    name: 'custom tokens',
    code: `globalThis.PCD = { TOKENS: { int: { bg: 0x000000, text: 0xffffff, line: 0x000000, wood: 0xffffff, accent: 0xff0000 },
      derived: { clock: { mix: 0.5, toward: 'text', min: 4.5, on: 'bg', fallback: 'text' }, bar: { from: 'line', to: 'wood', gain: 1, now: 'accent' } } } };`,
  };
  const C = sandbox([custom, 'src/shared/pcd-core.js']).PCD.color;
  assert.equal(C.clock(0xff0000), '#ff8080');
  assert.equal(C.bar(0.5), '#808080');
  assert.equal(C.tokens().accent, 0xff0000);
});
