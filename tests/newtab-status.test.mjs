// The clock status line (src/newtab/js/ntp-status.js): the parser on every
// fixture, the line in 12 h and 24 h (today, tomorrow, weekday; next.at never read), the poller with
// fake fetch and timers (300 ms start, 30 s / 10 s polls, 2.5 s abort, one request at a time, hidden
// after 2 failures, 60 s then 5 min backoff, nothing while hidden or disabled, the session cache), and
// the poller against tools/mock-clock.mjs over real HTTP on 127.0.0.1.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
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
const { startMockClock, FIXTURES, SCENARIOS, loadFixtures } = await import(pathToFileURL(path.join(ROOT, 'tools', 'mock-clock.mjs')).href);
const RAW = loadFixtures();
const fixture = (name) => JSON.parse(RAW[name]);
const status = (name) => S.parse(RAW[name]).status;

// The pretend clock's answers, normalized (fixtures: 2026-11-15 20:00 CST, a Sunday).
const NORMAL = { state: 'none', label: '', until: null, next: { day: 1, time: '07:00', label: 'Work' }, known: true, epoch: 1794794400, offset: -21600 };
const EXPECTED = {
  normal: NORMAL,
  ringing: { ...NORMAL, state: 'ringing', label: 'Work' },
  snoozed: { ...NORMAL, state: 'snoozed', label: 'Work', until: 1794794940 },
  testing: { ...NORMAL, state: 'testing' },
  'first-boot': { ...NORMAL, next: null },
  'no-time': { ...NORMAL, next: null, known: false, epoch: null, offset: null },
  'safe-mode': NORMAL,
};
const LINES = {
  normal: ['⌂ pixelclock · next alarm tomorrow 7:00 am · work', '⌂ pixelclock · next alarm tomorrow 07:00 · work', 'next'],
  ringing: ['⌂ pixelclock · ringing · work', '⌂ pixelclock · ringing · work', 'ringing'],
  snoozed: ['⌂ pixelclock · snoozed until 8:09 pm · work', '⌂ pixelclock · snoozed until 20:09 · work', 'snoozed'],
  testing: ['⌂ pixelclock · ringing · test', '⌂ pixelclock · ringing · test', 'ringing'],
  'first-boot': ['⌂ pixelclock · no alarm set', '⌂ pixelclock · no alarm set', 'none'],
  'no-time': ['⌂ pixelclock · time not set', '⌂ pixelclock · time not set', 'unknown'],
  'safe-mode': ['⌂ pixelclock · next alarm tomorrow 7:00 am · work', '⌂ pixelclock · next alarm tomorrow 07:00 · work', 'next'],
};

// --------------------------------------------------------------------------------------------
// parse()

test('fixtures: one per scenario, compact JSON on one line with LF, the pretend clock\'s shape', () => {
  const files = fs.readdirSync(path.join(ROOT, 'tests', 'fixtures', 'status')).filter((f) => f.endsWith('.json')).sort();
  assert.deepEqual(files, FIXTURES.map((n) => n + '.json').sort(), 'every fixture has a scenario and every scenario a fixture');
  for (const name of FIXTURES) {
    const file = fs.readFileSync(path.join(ROOT, 'tests', 'fixtures', 'status', name + '.json'));
    assert.notEqual(file[0], 0xef, `${name}: no BOM`);
    assert.equal(file.toString('utf8'), RAW[name] + '\n', `${name}: one line + LF`);
    assert.equal(JSON.stringify(JSON.parse(RAW[name])), RAW[name], `${name}: compact, like the firmware`);
    assert.deepEqual(Object.keys(fixture(name)), ['api', 'app', 'version', 'boot', 'time', 'wifi', 'alarm', 'display', 'health', 'firmware', 'revs', 'problems']);
  }
});

test('parse: every fixture gives the expected normalized status', () => {
  for (const name of FIXTURES) {
    const r = S.parse(RAW[name]);
    assert.equal(r.ok, true, name);
    assert.deepEqual(r.status, EXPECTED[name], name);
    assert.deepEqual(S.parse(fixture(name)).status, EXPECTED[name], `${name} (already parsed)`);
    assert.equal(S.isStatus(r.status), true, name);
  }
});

test('parse: nothing about the network, the IP or the time zone is kept (privacy)', () => {
  for (const name of FIXTURES) {
    const text = JSON.stringify(status(name));
    for (const secret of ['Home', '192.168.1.50', 'America/Chicago', 'CST', 'e90ecd87', 'wifi', '1794834000']) {
      assert.ok(!text.includes(secret), `${name} keeps ${secret}`);
    }
  }
});

test('parse: rejects what is not a firmware api 1 status', () => {
  const n = fixture('normal');
  const bad = (doc) => S.parse(typeof doc === 'string' ? doc : JSON.stringify(doc)).error;
  assert.equal(bad(''), 'json');
  assert.equal(bad('{'), 'json');
  assert.equal(bad(RAW.normal.slice(0, Math.floor(RAW.normal.length / 2))), 'json', 'the garbage scenario');
  assert.equal(bad('<html>'), 'json');
  assert.equal(bad('null'), 'shape');
  assert.equal(bad('[]'), 'shape');
  assert.equal(bad('7'), 'shape');
  assert.equal(bad({ error: { code: 'internal', message: 'x' } }), 'api', 'an error document');
  assert.equal(bad({ ...n, api: 2 }), 'api');
  assert.equal(bad({ ...n, api: '1' }), 'api');
  assert.equal(bad({ ...n, alarm: undefined }), 'shape');
  assert.equal(bad({ ...n, alarm: { ...n.alarm, state: 'beeping' } }), 'shape');
  assert.equal(bad({ ...n, time: undefined }), 'shape');
  assert.equal(bad({ ...n, time: { ...n.time, known: 'yes' } }), 'shape');
  for (const next of [{ ...n.alarm.next, day: 7 }, { ...n.alarm.next, day: -1 }, { ...n.alarm.next, day: 1.5 },
    { ...n.alarm.next, time: '7:00' }, { ...n.alarm.next, time: '24:00' }, { ...n.alarm.next, time: '07:60' }, 'Mon 07:00', []]) {
    assert.equal(bad({ ...n, alarm: { ...n.alarm, next } }), 'shape', JSON.stringify(next));
  }
  assert.equal(S.parse('x'.repeat(70000)).error, 'size');
  assert.equal(S.parse(undefined).error, 'shape');
});

test('parse: unknown fields are ignored, missing optional ones are tolerated', () => {
  const n = fixture('normal');
  const doc = { ...n, future: { x: 1 }, display: { ...n.display, face: 'retro' }, alarm: { ...n.alarm, extra: true, next: { ...n.alarm.next, repeat: 'weekdays' } } };
  assert.deepEqual(S.parse(JSON.stringify(doc)).status, NORMAL);
  const lean = { api: 1, alarm: { state: 'none', next: null }, time: { known: true } };
  assert.deepEqual(S.parse(lean).status, { state: 'none', label: '', until: null, next: null, known: true, epoch: null, offset: null });
});

test('parse: the label only while something rings or snoozes, until only while snoozed, next only with the time', () => {
  const n = fixture('normal');
  assert.equal(S.parse({ ...n, alarm: { ...n.alarm, label: 'Work' } }).status.label, '', 'state none');
  assert.equal(S.parse({ ...n, alarm: { ...n.alarm, state: 'ringing', label: 'Work', until: 5 } }).status.until, null);
  assert.equal(S.parse({ ...n, alarm: { ...n.alarm, state: 'snoozed', label: 'Work', until: null } }).status.until, null);
  assert.equal(S.parse({ ...n, alarm: { ...n.alarm, state: 'snoozed', until: 1.5 } }).status.until, null);
  assert.equal(S.parse({ ...n, time: { ...n.time, known: false } }).status.next, null);
  assert.equal(S.parse({ ...n, time: { ...n.time, offset: 15 * 3600 } }).status.offset, null, 'offset beyond 14 h');
  assert.equal(S.parse({ ...n, time: { ...n.time, epoch: 'x' } }).status.epoch, null);
});

test('labels: invisible characters removed, spaces collapsed, at most 32 characters', () => {
  assert.equal(S.cleanLabel('  Work \n\t out  '), 'Work out');
  const ch = (...cps) => String.fromCodePoint(...cps);
  assert.equal(S.cleanLabel('Wo' + ch(0) + 'rk' + ch(7)), 'Work');
  assert.equal(S.cleanLabel(ch(0x202e) + 'evil' + ch(0x202c)), 'evil', 'bidi override');
  assert.equal(S.cleanLabel('zero' + ch(0x200b) + 'width' + ch(0xfeff)), 'zerowidth');
  assert.equal(S.cleanLabel('line' + ch(0x2028) + 'break' + ch(0x85)), 'linebreak');
  assert.equal(S.cleanLabel('Zahn' + ch(0xe4) + 'rztin ' + ch(0xfffd)), 'Zahn' + ch(0xe4) + 'rztin ' + ch(0xfffd), 'letters and U+FFFD stay');
  assert.equal(S.cleanLabel('x'.repeat(40)), 'x'.repeat(32));
  assert.equal(Array.from(S.cleanLabel(ch(0x1f600).repeat(40))).length, 32, 'counts characters, not UTF-16 units');
  assert.equal(S.cleanLabel(42), '');
  assert.equal(S.cleanLabel(null), '');
});

// --------------------------------------------------------------------------------------------
// describe()

test('describe: every fixture in 12 h and 24 h', () => {
  for (const name of FIXTURES) {
    const [l12, l24, kind] = LINES[name];
    const v12 = S.describe(status(name), { clock24: false });
    const v24 = S.describe(status(name), { clock24: true });
    assert.equal(v12.text, l12, `${name} 12 h`);
    assert.equal(v24.text, l24, `${name} 24 h`);
    assert.equal(v12.kind, kind, name);
    assert.equal(v12.show, true);
    assert.equal(v12.ringing, kind === 'ringing', `${name} ringing`);
    assert.equal(v12.text, '⌂ ' + v12.parts.join(' · '));
    assert.equal(v12.parts[0], 'pixelclock');
  }
  assert.equal(S.describe(status('ringing')).tone, 'accent');
  assert.equal(S.describe(status('testing')).tone, 'accent');
  assert.equal(S.describe(status('snoozed')).tone, 'text');
  assert.equal(S.describe(status('normal')).tone, 'muted');
  assert.equal(S.describe(status('normal')).text, LINES.normal[0], '12 h is the default');
});

test('describe: hidden when there is no status, never throws on a malformed one', () => {
  const v = S.describe(null, { clock24: true });
  assert.equal(v.show, false);
  assert.equal(v.text, '');
  assert.equal(v.ringing, false);
  assert.equal(v.kind, 'hidden');
  for (const bad of [undefined, 7, 'x', [], {}, { ...NORMAL, next: { day: 1, time: '7am', label: '' } }, { ...NORMAL, state: 'x' },
    { ...NORMAL, epoch: undefined }, { ...NORMAL, next: { day: 8, time: '07:00', label: '' } }, { ...NORMAL, label: 5 }]) {
    assert.equal(S.describe(bad).show, false, JSON.stringify(bad));
  }
});

test('describe: today, tomorrow and weekday from next.day and next.time against the clock\'s own day', () => {
  const at = (epoch, next) => S.describe({ ...NORMAL, epoch, next: { day: 1, time: '07:00', label: '', ...next } }).parts[1];
  const MON_0700 = 1794834000;  // Monday 2026-11-16 07:00 CST
  assert.equal(at(MON_0700 - 3600), 'next alarm today 7:00 am', 'Monday 06:00');
  assert.equal(at(MON_0700 - 60), 'next alarm today 7:00 am', 'Monday 06:59');
  assert.equal(at(MON_0700), 'next alarm mon 7:00 am', 'Monday 07:00: that minute is past, so next week (the firmware\'s rule)');
  assert.equal(at(MON_0700 - 7 * 3600 - 1), 'next alarm tomorrow 7:00 am', 'Sunday 23:59:59');
  assert.equal(at(MON_0700 - 7 * 3600), 'next alarm today 7:00 am', 'Monday 00:00');
  assert.equal(at(MON_0700 - 2 * 86400 - 11 * 3600), 'next alarm mon 7:00 am', 'Friday 20:00');
  assert.equal(at(MON_0700 - 3600, { day: 3, time: '18:30' }), 'next alarm wed 6:30 pm');
  assert.equal(at(MON_0700 - 3600, { day: 0, time: '00:00' }), 'next alarm sun 12:00 am');
  assert.equal(at(MON_0700 - 3600, { day: 2, time: '12:05' }), 'next alarm tomorrow 12:05 pm');
  assert.equal(S.describe({ ...NORMAL, epoch: null }).parts[1], 'next alarm mon 7:00 am', 'no epoch: the weekday');
});

test('describe: next.at is never read (it is an hour off across a DST change)', () => {
  const n = fixture('normal');
  const base = S.describe(S.parse(n).status).text;
  for (const atv of [0, -1, 1794834000 + 3600, 1e12, 'x', null]) {
    const doc = { ...n, alarm: { ...n.alarm, next: { ...n.alarm.next, at: atv } } };
    assert.equal(S.describe(S.parse(doc).status).text, base, `at ${atv}`);
  }
  const withAt = { ...NORMAL, next: { ...NORMAL.next, at: 0 } };
  assert.equal(S.describe(withAt).text, base, 'even when a status object carries it');
  // Saturday 2026-10-31 20:00 CDT: the next Monday 07:00 is after the change back to CST.
  const dst = { ...n, time: { ...n.time, epoch: 1793494800, offset: -18000, zone: 'CDT' }, alarm: { ...n.alarm, next: { ...n.alarm.next, at: 1793710800 } } };
  assert.equal(S.describe(S.parse(dst).status).text, '⌂ pixelclock · next alarm mon 7:00 am · work');
});

test('describe: 12 h and 24 h times', () => {
  const cases = [[0, 0, '12:00 am', '00:00'], [0, 5, '12:05 am', '00:05'], [9, 41, '9:41 am', '09:41'], [12, 0, '12:00 pm', '12:00'],
    [13, 7, '1:07 pm', '13:07'], [23, 59, '11:59 pm', '23:59']];
  for (const [h, m, t12, t24] of cases) {
    assert.equal(S.clockTime(h, m, false), t12);
    assert.equal(S.clockTime(h, m, true), t24);
  }
});

test('describe: labels in lower case, no empty segment, snoozed without a known time', () => {
  assert.equal(S.describe({ ...NORMAL, next: { day: 1, time: '07:00', label: 'Gym DAY' } }).parts[2], 'gym day');
  assert.equal(S.describe({ ...NORMAL, next: { day: 1, time: '07:00', label: '' } }).parts.length, 2);
  assert.equal(S.describe({ ...NORMAL, state: 'ringing', label: '' }).text, '⌂ pixelclock · ringing');
  assert.equal(S.describe({ ...EXPECTED.snoozed, offset: null }).text, '⌂ pixelclock · snoozed · work');
  assert.equal(S.describe({ ...EXPECTED.snoozed, label: '' }, { clock24: true }).text, '⌂ pixelclock · snoozed until 20:09');
  assert.equal(S.describe({ ...EXPECTED.ringing, known: false, next: null }).text, '⌂ pixelclock · ringing · work', 'ringing wins');
});

test('sample(): the fixtures\' normalized answers for previews', () => {
  for (const name of FIXTURES) assert.deepEqual(S.sample(name), EXPECTED[name], name);
  assert.deepEqual(S.sample(), EXPECTED.normal);
  assert.equal(S.sample('nope'), null);
  assert.equal(S.sample('toString'), null);
  assert.equal(S.sample('__proto__'), null);
  S.sample('normal').next.label = 'changed';
  assert.equal(S.sample('normal').next.label, 'Work', 'a fresh copy each time');
});

// --------------------------------------------------------------------------------------------
// createClient() with fake timers and fetch

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
    pending() { return [...timers.values()].map((x) => x.at - t).sort((a, b) => a - b); },
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
const hang = (url, init) => new Promise((resolve, reject) => {
  init.signal.addEventListener('abort', () => reject(Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' })));
});
const offline = () => Promise.reject(new TypeError('Failed to fetch'));

function setup({ script, cache, enabled, visible, start = true } = {}) {
  const time = fakeTime();
  const calls = [];
  const changes = [];
  const queue = Array.isArray(script) ? script.slice() : null;
  const fetch = (url, init) => {
    calls.push({ url, init, at: time.now() });
    const step = queue ? (queue.length > 1 ? queue.shift() : queue[0]) : script;
    return typeof step === 'function' ? step(url, init) : answer(RAW[step]);
  };
  const client = S.createClient({ fetch, now: time.now, setTimeout: time.setTimeout, clearTimeout: time.clearTimeout, cache, enabled, visible,
    onChange: (s) => changes.push({ at: time.now(), s }) });
  if (start) client.start();
  return { time, calls, changes, client };
}

test('client: first request 300 ms after start, exactly GET with no-store, no credentials, no headers, no redirects', async () => {
  const { time, calls, changes, client } = setup({ script: 'normal' });
  await time.advance(299);
  assert.equal(calls.length, 0);
  await time.advance(1);
  assert.equal(calls.length, 1);
  const { url, init } = calls[0];
  assert.equal(url, 'http://pixelclock.local/api/status');
  assert.deepEqual(Object.keys(init).sort(), ['cache', 'credentials', 'method', 'redirect', 'referrerPolicy', 'signal']);
  assert.equal(init.method, 'GET');
  assert.equal(init.cache, 'no-store');
  assert.equal(init.credentials, 'omit');
  assert.equal(init.redirect, 'error');
  assert.equal(init.referrerPolicy, 'no-referrer');
  assert.ok(init.signal instanceof AbortSignal);
  assert.equal(changes.length, 1);
  assert.deepEqual(changes[0].s, NORMAL);
  assert.deepEqual(client.status(), NORMAL);
  assert.equal(client.view({ clock24: false }).text, LINES.normal[0]);
  assert.equal(client.state().ok, 1);
});

test('client: polls every 30 s, every 10 s while ringing, testing or snoozed', async () => {
  const { time, calls } = setup({ script: ['normal', 'normal', 'ringing', 'ringing', 'snoozed', 'testing', 'normal', 'normal'] });
  await time.advance(300);
  await time.advance(30000);
  assert.equal(calls.length, 2);
  await time.advance(30000);  // -> ringing
  assert.equal(calls.length, 3);
  const gaps = [];
  for (let i = 0; i < 4; i++) {
    const before = calls.length;
    const t = time.now();
    while (calls.length === before) await time.advance(1000);
    gaps.push(time.now() - t);
  }
  assert.deepEqual(gaps, [10000, 10000, 10000, 10000], 'ringing, ringing, snoozed, testing -> 10 s each');
  const before = calls.length;
  await time.advance(29000);
  assert.equal(calls.length, before, 'back to 30 s after the normal answer');
  await time.advance(1000);
  assert.equal(calls.length, before + 1);
});

test('client: a slow clock is aborted at 2.5 s and counts as a failure', async () => {
  const { time, calls, client } = setup({ script: hang });
  await time.advance(300);
  assert.equal(calls.length, 1);
  assert.equal(client.state().inFlight, true);
  await time.advance(2499);
  assert.equal(calls[0].init.signal.aborted, false);
  await time.advance(1);
  assert.equal(calls[0].init.signal.aborted, true);
  assert.equal(client.state().inFlight, false);
  assert.equal(client.state().lastError, 'timeout');
  assert.equal(client.state().failures, 1);
});

test('client: one request at a time', async () => {
  const { time, calls, client } = setup({ script: hang });
  await time.advance(300);
  assert.equal(client.refresh(), false, 'refused while asking');
  await time.advance(1000);
  assert.equal(calls.length, 1);
});

test('client: the line stays after one failure, hides after two, then retries at 60 s and every 5 min', async () => {
  const { time, calls, changes, client } = setup({ script: ['normal', offline] });
  await time.advance(300);
  assert.deepEqual(client.status(), NORMAL);
  const times = [];
  for (let i = 0; i < 5; i++) {
    const before = calls.length;
    const t = time.now();
    while (calls.length === before) await time.advance(1000);
    times.push(time.now() - t);
    if (i === 0) assert.deepEqual(client.status(), NORMAL, 'one failure: still shown');
    if (i === 1) assert.equal(client.status(), null, 'two failures: hidden');
  }
  assert.deepEqual(times, [30000, 30000, 60000, 300000, 300000]);
  assert.deepEqual(changes.map((c) => c.s && c.s.state), ['none', null], 'shown once, hidden once, silently');
  assert.equal(client.state().fails, 5);
  assert.equal(client.state().lastError, 'Failed to fetch');
});

test('client: the second failure comes 10 s after the first while the clock was ringing', async () => {
  const { time, calls, client } = setup({ script: ['ringing', offline] });
  await time.advance(300);
  await time.advance(10000);
  assert.equal(calls.length, 2);
  assert.equal(client.status().state, 'ringing');
  await time.advance(10000);
  assert.equal(calls.length, 3);
  assert.equal(client.status(), null);
});

test('client: non-200, bad JSON, a wrong api and garbage are failures; a good answer resets the count', async () => {
  const half = RAW.normal.slice(0, 400);
  const { time, calls, client } = setup({ script: [() => answer('{"error":{"code":"internal"}}', 500), () => answer(half), 'normal',
    () => answer('{"api":2}'), () => answer('<html></html>'), 'normal'] });
  const seen = [];
  for (let i = 0; i < 6; i++) {
    const before = calls.length;
    while (calls.length === before) await time.advance(100);
    seen.push([client.state().lastError, client.state().fails]);
  }
  assert.deepEqual(seen, [['http 500', 1], ['json', 2], ['json', 0], ['api', 1], ['json', 2], ['json', 0]]);
  assert.equal(client.state().failures, 4);
  assert.equal(client.state().ok, 2);
  assert.deepEqual(client.status(), NORMAL);
});

test('client: no request while hidden; on show it asks when due', async () => {
  const { time, calls, client } = setup({ script: 'normal', visible: false });
  await time.advance(10 * 60000);
  assert.equal(calls.length, 0, 'started hidden: nothing');
  assert.equal(time.timers.size, 0, 'and no timer');
  client.setVisible(true);
  await time.advance(0);
  assert.equal(calls.length, 1, 'shown long after the first poll was due: at once');
  client.setVisible(false);
  assert.equal(time.timers.size, 0, 'hidden: every timer cleared');
  await time.advance(60 * 60000);
  assert.equal(calls.length, 1);
  client.setVisible(true);
  await time.advance(0);
  assert.equal(calls.length, 2);
  await time.advance(10000);
  client.setVisible(false);
  client.setVisible(true);
  await time.advance(19999);
  assert.equal(calls.length, 2, 'a short hide keeps the 30 s rhythm');
  await time.advance(1);
  assert.equal(calls.length, 3);
});

test('client: clockStatus off never fetches; turning it off hides the line and aborts', async () => {
  {
    const { time, calls, client } = setup({ script: 'normal', enabled: false });
    await time.advance(10 * 60000);
    assert.equal(calls.length, 0);
    assert.equal(time.timers.size, 0);
    assert.equal(client.refresh(), false);
    client.setEnabled(true);
    await time.advance(300);
    assert.equal(calls.length, 1);
  }
  {
    const { time, calls, changes, client } = setup({ script: ['normal', hang] });
    await time.advance(300);
    await time.advance(30000);
    assert.equal(client.state().inFlight, true);
    client.setEnabled(false);
    assert.equal(calls[1].init.signal.aborted, true, 'the request in flight is aborted');
    assert.equal(client.status(), null);
    assert.equal(changes.at(-1).s, null);
    await time.advance(60 * 60000);
    assert.equal(calls.length, 2);
    assert.equal(client.state().aborted, 1);
    assert.equal(client.state().failures, 0, 'an abort is not a failure');
  }
});

test('client: stop() ends polling and drops a late answer; refresh() asks at once', async () => {
  let release;
  const late = () => new Promise((r) => { release = () => r({ status: 200, text: () => Promise.resolve(RAW.ringing) }); });
  const { time, calls, client } = setup({ script: ['normal', late] });
  await time.advance(300);
  assert.equal(client.refresh(), true);
  await time.advance(0);
  assert.equal(calls.length, 2);
  client.stop();
  release();
  await time.advance(0);
  assert.equal(client.status().state, 'none', 'the late ringing answer is dropped');
  await time.advance(60 * 60000);
  assert.equal(calls.length, 2);
  assert.equal(client.refresh(), false);
});

test('client: onDone after every answer (true) and failure (false), never after an answer stop() dropped', async () => {
  let release;
  const late = () => new Promise((r) => { release = () => r({ status: 200, text: () => Promise.resolve(RAW.normal) }); });
  const steps = [() => answer(RAW.normal), offline, () => answer('{'), late];
  const done = [];
  const time = fakeTime();
  const client = S.createClient({ fetch: () => steps.shift()(), now: time.now, setTimeout: time.setTimeout, clearTimeout: time.clearTimeout,
    onDone: (ok) => done.push(ok) });
  client.start();
  await time.advance(300);
  assert.deepEqual(done, [true]);
  await time.advance(30000);
  assert.deepEqual(done, [true, false], 'a network failure (the line stays after one)');
  await time.advance(30000);
  assert.deepEqual(done, [true, false, false], 'bad JSON (the line hides after two)');
  await time.advance(60000);
  client.stop();
  release();
  await time.advance(0);
  assert.deepEqual(done, [true, false, false], 'the dropped answer is no answer');
});

function memoryCache(record) {
  const writes = [];
  return {
    writes,
    record,
    read: () => Promise.resolve(record === undefined ? null : JSON.parse(JSON.stringify(record))),
    write: (r) => { writes.push(JSON.parse(JSON.stringify(r))); return Promise.resolve(); },
  };
}

test('cache: a fresh answer from another tab shows at once; an old or wrong-shaped one does not', async () => {
  {
    const cache = memoryCache({ v: 1, at: T0 - 60000, status: EXPECTED.ringing, fails: 0, retryAt: 0 });
    const { time, calls, changes } = setup({ script: 'normal', cache });
    await time.advance(0);
    assert.equal(calls.length, 0);
    assert.equal(changes.length, 1);
    assert.equal(changes[0].s.state, 'ringing', 'shown before any request');
    await time.advance(300);
    assert.equal(calls.length, 1, 'then asked as usual');
    assert.equal(changes.at(-1).s.state, 'none');
  }
  for (const record of [
    { v: 1, at: T0 - 121000, status: EXPECTED.ringing, fails: 0, retryAt: 0 },
    { v: 1, at: T0 + 60000, status: EXPECTED.ringing, fails: 0, retryAt: 0 },
    { v: 2, at: T0, status: EXPECTED.ringing },
    { v: 1, at: T0, status: { ...EXPECTED.ringing, state: 'boom' } },
    { v: 1, at: T0, status: { ...EXPECTED.ringing, next: { day: 9 } } },
    'junk', 7, [],
  ]) {
    const { time, changes } = setup({ script: hang, cache: memoryCache(record) });
    await time.advance(300);
    assert.equal(changes.length, 0, JSON.stringify(record));
  }
});

test('cache: answers and the offline backoff are shared through it, normalized only', async () => {
  const cache = memoryCache(undefined);
  const { time } = setup({ script: ['snoozed', offline], cache });
  await time.advance(300);
  assert.deepEqual(cache.writes.at(-1), { v: 1, at: T0 + 300, status: EXPECTED.snoozed, fails: 0, retryAt: 0 });
  assert.ok(!JSON.stringify(cache.writes).includes('192.168'), 'no IP in the cache');
  await time.advance(10000);
  assert.equal(cache.writes.length, 1, 'one failure writes nothing');
  await time.advance(10000);
  assert.deepEqual(cache.writes.at(-1), { v: 1, at: T0 + 300, status: null, fails: 2, retryAt: T0 + 20300 + 60000 });

  // A new tab while that clock is known to be offline waits for the shared retry time.
  const tab2 = setup({ script: 'normal', cache: memoryCache({ v: 1, at: T0 - 600000, status: null, fails: 3, retryAt: T0 + 200000 }) });
  await tab2.time.advance(199999);
  assert.equal(tab2.calls.length, 0);
  await tab2.time.advance(1);
  assert.equal(tab2.calls.length, 1);
  assert.equal(tab2.client.state().fails, 0, 'a good answer clears it');
  // ...but not for a retry time that is already past or absurdly far away; then one more failure goes
  // straight to the 5-minute retry instead of the 30 s second try.
  for (const retryAt of [T0 - 1, T0 + 86400000]) {
    const tab3 = setup({ script: offline, cache: memoryCache({ v: 1, at: 0, status: null, fails: 2, retryAt }) });
    await tab3.time.advance(300);
    assert.equal(tab3.calls.length, 1, `retryAt ${retryAt - T0}`);
    assert.equal(tab3.client.state().fails, 3);
    await tab3.time.advance(299999);
    assert.equal(tab3.calls.length, 1, 'no 30 s retry for a clock known to be offline');
    await tab3.time.advance(1);
    assert.equal(tab3.calls.length, 2);
  }
  // A good answer in such a tab shows at once and resets the count.
  const tab4 = setup({ script: 'normal', cache: memoryCache({ v: 1, at: 0, status: null, fails: 7, retryAt: T0 - 5 }) });
  await tab4.time.advance(300);
  assert.equal(tab4.client.state().fails, 0);
  assert.deepEqual(tab4.client.status(), NORMAL);
});

test('cache: sessionCache() over a chrome.storage area never throws', async () => {
  const store = {};
  const area = {
    get: (k) => Promise.resolve(k in store ? { [k]: store[k] } : {}),
    set: (o) => { Object.assign(store, o); return Promise.resolve(); },
  };
  const c = S.sessionCache(area);
  assert.equal(await c.read(), null);
  await c.write({ v: 1, at: 5 });
  assert.deepEqual(store, { clockStatus: { v: 1, at: 5 } });
  assert.deepEqual(await c.read(), { v: 1, at: 5 });
  const broken = S.sessionCache({ get: () => { throw new Error('x'); }, set: () => Promise.reject(new Error('quota')) });
  assert.equal(await broken.read(), null);
  await broken.write({ v: 1 });
  const rejecting = S.sessionCache({ get: () => Promise.reject(new Error('x')), set: () => { throw new Error('y'); } });
  assert.equal(await rejecting.read(), null);
  await rejecting.write({ v: 1 });
  assert.equal(S.sessionCache(undefined), null);
  assert.equal(S.sessionCache({}), null);
  assert.equal(S.CACHE_KEY, 'clockStatus');
});

test('client: a wall clock set back an hour still polls within the longest planned wait', async () => {
  const time = fakeTime();
  let shift = 0;
  const calls = [];
  const client = S.createClient({ fetch: (u, i) => { calls.push(time.now()); return answer(RAW.normal); }, now: () => time.now() - shift,
    setTimeout: time.setTimeout, clearTimeout: time.clearTimeout });
  client.start();
  await time.advance(300);
  assert.equal(calls.length, 1);
  shift = 3600000;  // the wall clock jumps back one hour; the poll timer must not wait for it
  client.setVisible(false);
  client.setVisible(true);
  assert.ok(time.pending()[0] <= 300000, `next timer in ${time.pending()[0]} ms`);
  await time.advance(300000);
  assert.equal(calls.length, 2);
});

test('client: a cache read that resolves after refresh() asked does not override the fresher answer', async () => {
  const time = fakeTime();
  let release;
  const cache = { read: () => new Promise((r) => { release = () => r({ v: 1, at: T0, status: EXPECTED.ringing, fails: 0, retryAt: 0 }); }), write: () => {} };
  const changes = [];
  const client = S.createClient({ fetch: () => answer(RAW.normal), now: time.now, setTimeout: time.setTimeout, clearTimeout: time.clearTimeout,
    cache, onChange: (s) => changes.push(s) });
  client.start();
  await time.advance(0);
  assert.equal(client.refresh(), true);
  await time.advance(0);
  assert.deepEqual(changes, [NORMAL]);
  release();
  await time.advance(0);
  assert.deepEqual(changes, [NORMAL], 'the older cached ringing is not shown');
  assert.deepEqual(client.status(), NORMAL);
  await time.advance(30000);
  assert.equal(client.state().requests, 2, 'and the 30 s rhythm continues');
});

test('client: a cache whose read throws is ignored', async () => {
  const time = fakeTime();
  const client = S.createClient({ fetch: () => answer(RAW.normal), now: time.now, setTimeout: time.setTimeout, clearTimeout: time.clearTimeout,
    cache: { read: () => { throw new Error('gone'); }, write: () => {} } });
  client.start();
  await time.advance(300);
  assert.deepEqual(client.status(), NORMAL);
});

test('client: a throwing onChange or cache does not stop polling', async () => {
  const time = fakeTime();
  let n = 0;
  const client = S.createClient({
    fetch: () => answer(RAW.normal), now: time.now, setTimeout: time.setTimeout, clearTimeout: time.clearTimeout,
    onChange: () => { throw new Error('ui'); }, cache: { read: () => Promise.resolve(null), write: () => { n++; throw new Error('disk'); } },
  });
  client.start();
  await time.advance(300 + 30000 + 30000);
  assert.equal(client.state().ok, 3);
  assert.equal(n, 3);
});

// --------------------------------------------------------------------------------------------
// Against tools/mock-clock.mjs over real HTTP (Node's fetch, real timers)

function realClient(url, extra = {}) {
  const changes = [];
  const client = S.createClient({ url, firstDelayMs: 0, onChange: (s) => changes.push(s), ...extra });
  return { client, changes };
}

async function until(fn, ms = 4000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return false;
}

test('mock clock: every fixture scenario through the real client', async () => {
  const mock = await startMockClock();
  try {
    for (const name of FIXTURES) {
      mock.setScenario(name);
      const { client, changes } = realClient(mock.url);
      client.start();
      assert.ok(await until(() => changes.length === 1), name);
      client.stop();
      assert.deepEqual(changes[0], EXPECTED[name], name);
    }
    assert.ok(mock.requests.length >= FIXTURES.length);
    for (const r of mock.requests) {
      assert.equal(r.method, 'GET');
      assert.equal(r.path, '/api/status');
      assert.equal(r.answered, 200);
    }
  } finally {
    await mock.close();
  }
});

test('mock clock: garbage, 500 and a dropped connection are failures; the line hides after two', async () => {
  const mock = await startMockClock();
  try {
    for (const [name, error] of [['garbage', 'json'], ['error-500', 'http 500'], ['unreachable', null]]) {
      mock.setScenario(name);
      const { client, changes } = realClient(mock.url, { pollMs: 50 });
      client.start();
      assert.ok(await until(() => client.state().failures >= 2), name);
      client.stop();
      if (error) assert.equal(client.state().lastError, error, name);
      else assert.match(client.state().lastError, /fetch failed|socket|terminated|ECONNRESET/i, name);
      assert.deepEqual(changes, [], `${name}: never shown`);
    }
  } finally {
    await mock.close();
  }
});

test('mock clock: slow (5 s) is aborted by 2.6 s', async () => {
  const mock = await startMockClock({ scenario: 'slow' });
  try {
    let sentAt = 0;
    let ms = null;
    const watch = (url, init) => {
      sentAt = performance.now();
      init.signal.addEventListener('abort', () => { ms = performance.now() - sentAt; });
      return fetch(url, init);
    };
    const { client } = realClient(mock.url, { fetch: watch });
    client.start();
    assert.ok(await until(() => client.state().failures === 1, 4000));
    client.stop();
    assert.equal(client.state().lastError, 'timeout');
    assert.ok(ms >= 2450 && ms <= 2600, `aborted after ${ms} ms`);
  } finally {
    await mock.close();
  }
});

test('mock clock: nothing listening (connection refused) is a quiet failure', async () => {
  const port = await new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
  const { client, changes } = realClient(`http://127.0.0.1:${port}/api/status`, { pollMs: 50 });
  client.start();
  assert.ok(await until(() => client.state().failures >= 2));
  client.stop();
  assert.deepEqual(changes, []);
});

test('mock clock: answers like the firmware (head, OPTIONS, HEAD, 404, unknown host)', async () => {
  const mock = await startMockClock();
  try {
    const raw = (method, p, host) => new Promise((resolve, reject) => {
      const sock = net.connect(mock.port, '127.0.0.1', () => {
        sock.write(`${method} ${p} HTTP/1.1\r\nHost: ${host || `127.0.0.1:${mock.port}`}\r\n\r\n`);
      });
      let data = '';
      sock.on('data', (d) => { data += d; });
      sock.on('end', () => resolve(data));
      sock.on('error', reject);
    });
    const get = await raw('GET', '/api/status');
    const [head, body] = get.split('\r\n\r\n');
    assert.deepEqual(head.split('\r\n'), ['HTTP/1.1 200 OK', 'Content-Type: application/json', `Content-Length: ${RAW.normal.length}`,
      'Cache-Control: no-store', 'X-Content-Type-Options: nosniff', 'Connection: close']);
    assert.equal(body, RAW.normal, 'the fixture bytes, no LF');
    assert.ok(!/access-control/i.test(get), 'no CORS header');
    const headReply = await raw('HEAD', '/api/status', 'pixelclock.local');
    assert.match(headReply, /^HTTP\/1\.1 200 OK\r\n/);
    assert.ok(headReply.endsWith('\r\n\r\n'), 'HEAD: no body');
    const opt = await raw('OPTIONS', '/api/status', 'pixelclock.local');
    assert.match(opt, /^HTTP\/1\.1 405 Method Not Allowed\r\n/);
    assert.match(opt, /\r\nAllow: GET, HEAD\r\n/);
    assert.ok(opt.endsWith(`{"error":{"code":"method","message":"This address doesn't take that method."}}`));
    const slash = await raw('GET', '/api/status/', 'pixelclock.local');
    assert.match(slash, /^HTTP\/1\.1 404 Not Found\r\n/);
    assert.ok(slash.endsWith(`{"error":{"code":"not_found","message":"There's nothing at this address."}}`));
    const wrong = await raw('GET', '/api/status', 'evil.example');
    assert.match(wrong, /^HTTP\/1\.1 403 Forbidden\r\n/);
    assert.match(wrong, /"code":"unknown_host"/);
    const post = await raw('POST', '/api/status', 'pixelclock.local');
    assert.match(post, /^HTTP\/1\.1 405 /);
    assert.deepEqual(mock.requests.map((r) => [r.method, r.answered]), [['GET', 200], ['HEAD', 200], ['OPTIONS', 405], ['GET', 404], ['GET', 403], ['POST', 405]]);
    assert.deepEqual(SCENARIOS, ['normal', 'ringing', 'snoozed', 'testing', 'first-boot', 'no-time', 'safe-mode', 'garbage', 'error-500', 'slow', 'unreachable']);
    await assert.rejects(startMockClock({ port: 5174 }), /reserved/);
    assert.throws(() => mock.setScenario('nope'), /unknown scenario/);
  } finally {
    await mock.close();
  }
});
