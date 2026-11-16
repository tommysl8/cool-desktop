// node --test tests/engine-calendar.test.mjs
// PCD.engine.autoId over the clock's own schedule: every day of 2026 against the expected calendar (seasons plus
// holiday windows, as the clock shows them).
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadEngine } from './engine-load.mjs';

const { PC, PCD } = loadEngine();

// [first month, first day, last month, last day, theme] for 2026, in order, covering every day.
const CALENDAR_2026 = [
  [1, 1, 1, 1, 'newyear'],
  [1, 2, 2, 10, 'winter'],
  [2, 11, 2, 14, 'valentines'],
  [2, 15, 2, 15, 'winter'],
  [2, 16, 2, 20, 'lunarnewyear'],
  [2, 21, 2, 28, 'winter'],
  [3, 1, 3, 13, 'spring'],
  [3, 14, 3, 17, 'stpatricks'],
  [3, 18, 4, 1, 'spring'],
  [4, 2, 4, 5, 'easter'],
  [4, 6, 5, 31, 'spring'],
  [6, 1, 6, 30, 'summer'],
  [7, 1, 7, 4, 'july4'],
  [7, 5, 8, 31, 'summer'],
  [9, 1, 10, 14, 'autumn'],
  [10, 15, 10, 31, 'halloween'],
  [11, 1, 11, 22, 'autumn'],
  [11, 23, 11, 26, 'thanksgiving'],
  [11, 27, 11, 30, 'autumn'],
  [12, 1, 12, 26, 'christmas'],
  [12, 27, 12, 30, 'winter'],
  [12, 31, 12, 31, 'newyear'],
];

function expected(m, d) {
  const key = m * 100 + d;
  const hit = CALENDAR_2026.find(([m0, d0, m1, d1]) => key >= m0 * 100 + d0 && key <= m1 * 100 + d1);
  return hit ? hit[4] : null;
}

test('every day of 2026 gets the theme of the calendar', () => {
  const wrong = [];
  let days = 0;
  for (let t = Date.UTC(2026, 0, 1); t < Date.UTC(2027, 0, 1); t += 86400000) {
    const d = new Date(t);
    const m = d.getUTCMonth() + 1;
    const day = d.getUTCDate();
    days++;
    const got = PCD.engine.autoId(PC, 2026, m, day);
    if (got !== expected(m, day)) wrong.push(`2026-${m}-${day}: ${got}, expected ${expected(m, day)}`);
  }
  assert.equal(days, 365);
  assert.deepEqual(wrong, []);
});

test('the calendar table covers 2026 without gaps or overlaps', () => {
  let prev = null;
  for (const [m0, d0, m1, d1] of CALENDAR_2026) {
    const start = Date.UTC(2026, m0 - 1, d0);
    const end = Date.UTC(2026, m1 - 1, d1);
    assert.ok(end >= start);
    if (prev !== null) assert.equal(start, prev + 86400000, `gap or overlap before ${m0}/${d0}`);
    prev = end;
  }
  assert.equal(prev, Date.UTC(2026, 11, 31));
});

test('auto across midnight and New Year: 12/31 newyear, 1/1 newyear, 1/2 winter; every theme appears in 2026', () => {
  assert.equal(PCD.engine.autoId(PC, 2026, 12, 31), 'newyear');
  assert.equal(PCD.engine.autoId(PC, 2027, 1, 1), 'newyear');
  assert.equal(PCD.engine.autoId(PC, 2027, 1, 2), 'winter');
  const seen = new Set(CALENDAR_2026.map((r) => r[4]));
  assert.deepEqual([...seen].sort(), PC.themes.map((t) => t.id).sort());
});

test('years after the Lunar New Year table (ends 2035, upstream) fall back to the season, never throw', () => {
  for (const [y, m, d] of [[2036, 2, 1], [2040, 1, 28], [2099, 12, 25]]) {
    const id = PCD.engine.autoId(PC, y, m, d);
    assert.ok(PC.themeById(id), `${y}-${m}-${d}: ${id}`);
  }
  assert.equal(PCD.engine.autoId(PC, 2036, 2, 10), 'winter');
});
