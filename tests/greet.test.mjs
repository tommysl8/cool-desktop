// src/shared/pcd-greet.js: the greeting rule at every hour (5-11 morning, 12-16 afternoon, 17-21 evening, 22-4 night)
// and the holiday lines on each holiday's own date in 2026 and 2027 (from the clock's own schedule), never the day
// before; the line is plain text (amber stays for what is live).
import test from 'node:test';
import assert from 'node:assert/strict';
import { lib, sandbox, engineScripts, plain } from './look-load.mjs';

const { isSafeChar } = await lib('tools/lib/glyphs.mjs');
const page = sandbox([...(await engineScripts()), 'src/shared/pcd-greet.js']);
const G = page.PCD.greet;
const PC = page.PixelClock;

const EXPECTED = {
  2026: [
    ['01-01', 'newyear', 'happy new year'], ['02-14', 'valentines', "happy valentine's day"], ['02-17', 'lunarnewyear', 'happy lunar new year'],
    ['03-17', 'stpatricks', "happy st. patrick's day"], ['04-05', 'easter', 'happy easter'], ['07-04', 'july4', 'happy fourth of july'],
    ['10-31', 'halloween', 'happy halloween'], ['11-26', 'thanksgiving', 'happy thanksgiving'], ['12-25', 'christmas', 'merry christmas'],
    ['12-31', 'newyear', "happy new year's eve"],
  ],
  2027: [
    ['01-01', 'newyear', 'happy new year'], ['02-06', 'lunarnewyear', 'happy lunar new year'], ['02-14', 'valentines', "happy valentine's day"],
    ['03-17', 'stpatricks', "happy st. patrick's day"], ['03-28', 'easter', 'happy easter'], ['07-04', 'july4', 'happy fourth of july'],
    ['10-31', 'halloween', 'happy halloween'], ['11-25', 'thanksgiving', 'happy thanksgiving'], ['12-25', 'christmas', 'merry christmas'],
    ['12-31', 'newyear', "happy new year's eve"],
  ],
};

function ruleFor(h) {
  if (h >= 5 && h <= 11) return 'good morning';
  if (h >= 12 && h <= 16) return 'good afternoon';
  if (h >= 17 && h <= 21) return 'good evening';
  return 'good night';
}

const at = (y, mmdd, h = 19, min = 0) => new Date(y, Number(mmdd.slice(0, 2)) - 1, Number(mmdd.slice(3)), h, min);

test('every hour: 5-11 good morning, 12-16 good afternoon, 17-21 good evening, 22-4 good night', () => {
  const seen = [];
  for (let h = 0; h < 24; h++) {
    const want = ruleFor(h);
    assert.equal(G.word(h), want, `hour ${h}`);
    assert.equal(G.word(h + 0.99), want, `hour ${h}.99`);
    assert.equal(G.word(new Date(2026, 10, 16, h, 0)), want, `${h}:00`);
    assert.equal(G.word(new Date(2026, 10, 16, h, 59, 59)), want, `${h}:59:59`);
    assert.equal(G.line(new Date(2026, 10, 16, h, 30)), want + '.', `line at ${h}:30 on an ordinary day`);
    seen.push(want);
  }
  assert.deepEqual(seen, [
    'good night', 'good night', 'good night', 'good night', 'good night',
    'good morning', 'good morning', 'good morning', 'good morning', 'good morning', 'good morning', 'good morning',
    'good afternoon', 'good afternoon', 'good afternoon', 'good afternoon', 'good afternoon',
    'good evening', 'good evening', 'good evening', 'good evening', 'good evening',
    'good night', 'good night',
  ]);
  // the hour boundaries where an off-by-one would show
  assert.equal(G.word(new Date(2026, 0, 5, 4, 59)), 'good night');
  assert.equal(G.word(new Date(2026, 0, 5, 5, 0)), 'good morning');
  assert.equal(G.word(new Date(2026, 0, 5, 11, 59)), 'good morning');
  assert.equal(G.word(new Date(2026, 0, 5, 12, 0)), 'good afternoon');
  assert.equal(G.word(new Date(2026, 0, 5, 16, 59)), 'good afternoon');
  assert.equal(G.word(new Date(2026, 0, 5, 17, 0)), 'good evening');
  assert.equal(G.word(new Date(2026, 0, 5, 21, 59)), 'good evening');
  assert.equal(G.word(new Date(2026, 0, 5, 22, 0)), 'good night');
  assert.equal(G.word(-1), 'good night', 'wraps');
  assert.equal(G.word(29), 'good morning', 'wraps');
  for (const bad of [NaN, Infinity, '9', null, undefined, new Date(NaN)]) assert.equal(G.word(bad), 'hello', String(bad));
});

test('RULE lists the same hours as word()', () => {
  for (let h = 0; h < 24; h++) {
    const r = G.RULE.find(([a, b]) => (a <= b ? h >= a && h <= b : h >= a || h <= b));
    assert.equal(r[2], G.word(h), `hour ${h}`);
  }
});

for (const year of [2026, 2027]) {
  test(`${year}: each holiday line on its own date (the clock's schedule), none the day before`, () => {
    for (const [mmdd, id, line] of EXPECTED[year]) {
      const d = at(year, mmdd);
      assert.deepEqual(plain(G.holiday(d, PC)), { id, line }, `${year}-${mmdd}`);
      assert.equal(G.line(d, PC), `good evening · ${line}`);
      assert.deepEqual(plain(G.parts(d, PC).runs), [['good evening', 'text bold'], [' · ', 'frame'], [line, 'text']], 'the line in text, not amber');
      assert.equal(G.line(at(year, mmdd, 8), PC), `good morning · ${line}`);
      assert.equal(G.line(at(year, mmdd, 23, 59), PC), `good night · ${line}`);
      const before = new Date(d.getFullYear(), d.getMonth(), d.getDate() - 1, 19);
      const prev = G.holiday(before, PC);
      if (mmdd === '01-01') assert.deepEqual(plain(prev), { id: 'newyear', line: "happy new year's eve" }, 'the day before 1 January is the eve');
      else assert.equal(prev, null, `the day before ${year}-${mmdd}`);
    }
  });

  test(`${year}: no other day of the year has a holiday line (the themes' longer windows do not count)`, () => {
    const want = new Map(EXPECTED[year].map(([mmdd, id, line]) => [mmdd, line]));
    let days = 0;
    for (let d = new Date(year, 0, 1, 12); d.getFullYear() === year; d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, 12)) {
      const key = `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      const h = G.holiday(d, PC);
      assert.equal(h ? h.line : null, want.get(key) || null, `${year}-${key}`);
      days++;
    }
    assert.ok(days >= 365);
    // the halloween theme starts on 15 October and the christmas theme on 1 December, without a greeting line
    assert.equal(PC.themeIdForDate(year, 10, 30), 'halloween');
    assert.equal(G.line(at(year, '10-30'), PC), 'good evening.');
    assert.equal(PC.themeIdForDate(year, 12, 24), 'christmas');
    assert.equal(G.line(at(year, '12-24', 21), PC), 'good evening.');
  });

  test(`${year}: ownDates() lists the ten lines in calendar order`, () => {
    const got = G.ownDates(year, PC).map((d) => [`${String(d.month).padStart(2, '0')}-${String(d.day).padStart(2, '0')}`, d.id, d.line]);
    assert.deepEqual(plain(got), EXPECTED[year]);
  });
}

test('the page looks the schedule up on globalThis.PixelClock when called', () => {
  assert.equal(G.line(new Date(2026, 9, 31, 21)), 'good evening · happy halloween');
  assert.equal(G.line(new Date(2026, 11, 25, 7)), 'good morning · merry christmas');
  assert.equal(G.line(new Date(2026, 10, 26, 13)), 'good afternoon · happy thanksgiving');
});

test('without the clock\'s schedule only 1 January has a line; unknown ids and broken dates are skipped', () => {
  const bare = sandbox(['src/shared/pcd-greet.js']).PCD.greet;
  assert.equal(bare.line(new Date(2026, 0, 1, 10)), 'good morning · happy new year');
  assert.equal(bare.line(new Date(2026, 9, 31, 21)), 'good evening.');
  assert.equal(bare.holiday(new Date(2026, 11, 31)), null);
  const custom = {
    HOLIDAYS: [
      { id: 'diwali', date: () => [11, 8] },
      { id: 'halloween', date: () => { throw new Error('broken'); } },
      { id: 'christmas', date: () => null },
      { id: 'july4', date: () => [7, 4] },
    ],
  };
  assert.equal(bare.holiday(new Date(2026, 10, 8), custom), null, 'no line is invented for an unknown holiday');
  assert.equal(bare.holiday(new Date(2026, 9, 31), custom), null);
  assert.equal(bare.holiday(new Date(2026, 11, 25), custom), null);
  assert.deepEqual(plain(bare.holiday(new Date(2026, 6, 4), custom)), { id: 'july4', line: 'happy fourth of july' });
  // the lunar table ends in 2035 upstream: no line after it, and nothing throws
  assert.equal(G.ownDates(2036, PC).some((d) => d.id === 'lunarnewyear'), false);
  assert.equal(G.holiday(new Date(NaN), PC), null);
  assert.deepEqual(plain(G.parts(new Date(NaN), PC)), { word: 'hello', holiday: null, text: 'hello.', runs: [['hello.', 'text bold']] });
});

test('copy rules: lower case, no exclamation marks, safe glyphs only', () => {
  const texts = [...Object.values(G.LINES), G.NEW_YEARS_DAY, G.SEPARATOR, ...G.RULE.map((r) => r[2])];
  assert.equal(Object.keys(G.LINES).length, 9);
  for (const t of texts) {
    assert.equal(t, t.toLowerCase(), t);
    assert.ok(!t.includes('!'), t);
    for (const ch of t) assert.ok(isSafeChar(ch), `${t}: ${ch}`);
  }
  for (const id of Object.keys(G.LINES)) assert.ok(PC.HOLIDAYS.some((h) => h.id === id), `${id} is a clock holiday`);
  for (const h of PC.HOLIDAYS) assert.ok(G.LINES[h.id], `the clock holiday ${h.id} has a line`);
});
