// node --test "tests/sun.test.mjs"
// src/shared/pcd-sun.js: the hourFloat remap, the four phases, today()'s sun times from Open-Meteo
// unixtime forecasts (the real Berlin capture in tests/fixtures/weather plus synthetic DST, polar and after-midnight
// days), resolve(), the strip curve and the helpers. The computer's time zone is pinned to Europe/Berlin (the fixture's
// zone, with real DST days); one test switches to America/Chicago and back. No network.
process.env.TZ = 'Europe/Berlin';

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

function findRoot(start) {
  let d = start;
  while (!fs.existsSync(path.join(d, 'src', 'shared', 'pcd-sun.js'))) {
    const up = path.dirname(d);
    if (up === d) throw new Error('project root not found');
    d = up;
  }
  return d;
}
const ROOT = findRoot(path.dirname(fileURLToPath(import.meta.url)));
const require = createRequire(import.meta.url);
const S = require(path.join(ROOT, 'src', 'shared', 'pcd-sun.js'));
const W = require(path.join(ROOT, 'src', 'shared', 'pcd-weather.js'));
const FIX = path.join(ROOT, 'tests', 'fixtures', 'weather');
const fixture = (name) => JSON.parse(fs.readFileSync(path.join(FIX, name), 'utf8'));

// Anchors measured from the clock engine at faff40a (tools/lib/anchors.mjs); frozen here so these tests do not move
// when the engine changes (tests/anchors.test.mjs checks the generated ones).
const ANCHORS = {
  autumn: { rise: 7.16, set: 16.89 }, christmas: { rise: 7.36, set: 16.95 }, easter: { rise: 6.98, set: 17.12 },
  halloween: { rise: 7.16, set: 18.07 }, july4: { rise: 5.55, set: 20.3 }, lunarnewyear: { rise: 6.94, set: 17.38 },
  newyear: { rise: 7.19, set: 16.83 }, spring: { rise: 7, set: 16.99 }, stpatricks: { rise: 6.92, set: 17.05 },
  summer: { rise: 6.17, set: 19.11 }, thanksgiving: { rise: 7.03, set: 17.22 }, valentines: { rise: 7.5, set: 17 },
  winter: { rise: 6.95, set: 17.16 },
};
const ANCHOR_LIST = [...Object.values(ANCHORS), S.FALLBACK];
const WINTER_SUN = { rise: 8.3, set: 15.9 }; // Berlin-like, December
const SUMMER_SUN = { rise: 4.75, set: 21.55 }; // Berlin-like, June
const HOUR = 3600;
const MIN = 60;
const close = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;
const hm = (h, m = 0, s = 0) => h + m / 60 + s / 3600;
/** Unix seconds of a Berlin wall-clock time (TZ is Europe/Berlin). */
const berlin = (y, mo, d, h = 0, mi = 0, s = 0) => new Date(y, mo - 1, d, h, mi, s).getTime() / 1000;

/** A synthetic Open-Meteo unixtime forecast for the local day y-mo-d with the given sun times (unix s or null). */
function forecastFor(y, mo, d, sunrise, sunset, extra = {}) {
  const day = berlin(y, mo, d);
  return {
    latitude: 52.528915, longitude: 13.423877, utc_offset_seconds: -new Date(day * 1000 + 12 * HOUR * 1000).getTimezoneOffset() * 60,
    timezone: 'Europe/Berlin', current: { time: day + 12 * HOUR, temperature_2m: 5, weather_code: 3, is_day: 1 },
    daily: { time: [day], sunrise: [sunrise], sunset: [sunset] }, ...extra,
  };
}

// -------------------------------------------------------------------------------------------------------------------
// remap

const SUNS = [];
for (const rise of [1.5, 2, 4.75, 6, 7.47, 8.3, 9.5, 11]) {
  for (const set of [12, 15.9, 16.22, 18, 19.67, 21.55, 22.5]) if (set - rise >= 4) SUNS.push({ rise, set });
}

test('remap: strictly increasing over the day, midnight fixed, within 0..24', () => {
  for (const a of ANCHOR_LIST) {
    for (const sun of SUNS) {
      assert.equal(S.remap(0, sun, a), 0);
      assert.equal(S.remap(24, sun, a), 24);
      let prev = -1;
      for (let m = 0; m <= 1440; m++) {
        const y = S.remap(m / 60, sun, a);
        assert.ok(y > prev, `not increasing at ${m} min for ${JSON.stringify(sun)} / ${JSON.stringify(a)}`);
        assert.ok(y >= 0 && y <= 24);
        prev = y;
      }
    }
  }
});

test('remap: the four window edges land exactly on the anchor window edges', () => {
  for (const a of ANCHOR_LIST) {
    for (const sun of SUNS) {
      assert.equal(S.remap(sun.rise - 1, sun, a), a.rise - 1);
      assert.equal(S.remap(sun.rise + 1, sun, a), a.rise + 1);
      assert.equal(S.remap(sun.set - 1, sun, a), a.set - 1);
      assert.equal(S.remap(sun.set + 1, sun, a), a.set + 1);
      assert.ok(close(S.remap(sun.rise, sun, a), a.rise), 'sunrise shows the theme at its own sunrise');
      assert.ok(close(S.remap(sun.set, sun, a), a.set), 'sunset shows the theme at its own sunset');
    }
  }
});

test('remap: slope 1 inside both twilight windows (dawn and sunset play at their natural pace)', () => {
  for (const a of ANCHOR_LIST) {
    for (const sun of SUNS) {
      for (const edge of [sun.rise, sun.set]) {
        for (let k = -59; k <= 59; k++) {
          const h0 = edge + k / 60;
          const dy = S.remap(h0 + 0.5 / 60, sun, a) - S.remap(h0, sun, a);
          assert.ok(close(dy, 0.5 / 60, 1e-9), `slope at ${h0}`);
        }
      }
    }
  }
});

test('remap: Berlin-like winter and summer days on the autumn and summer themes', () => {
  const a = ANCHORS.autumn;
  assert.equal(S.remap(WINTER_SUN.rise - 1, WINTER_SUN, a), 6.16);
  assert.ok(close(S.remap(8.3, WINTER_SUN, a), 7.16));
  assert.ok(close(S.remap(15.9, WINTER_SUN, a), 16.89));
  assert.ok(close(S.remap(12.1, WINTER_SUN, a), 12.025), 'midday: a linear stretch of the theme day');
  assert.ok(close(S.remap(3, WINTER_SUN, a), 3 * 6.16 / 7.3), 'night before dawn: a linear squeeze');
  const s = ANCHORS.summer;
  assert.ok(close(S.remap(4.75, SUMMER_SUN, s), 6.17));
  assert.ok(close(S.remap(21.55, SUMMER_SUN, s), 19.11));
  assert.ok(close(S.remap(23, SUMMER_SUN, s), 20.11 + (23 - 22.55) * (24 - 20.11) / (24 - 22.55)));
});

test('remap: identity when the sun times are missing or not usable', () => {
  const a = ANCHORS.spring;
  const identity = [null, undefined, {}, { rise: 7 }, { set: 17 }, { rise: '7', set: '17' }, { rise: NaN, set: 17 },
    { rise: 1.49, set: 17 }, { rise: 7, set: 22.51 }, { rise: 9, set: 12.99 }, { rise: 12, set: 11 }, { rise: 0.5, set: 23.9 },
    { rise: 7, set: 24.5 }, { rise: null, set: null, polar: null }, { rise: null, set: null, polar: 'dusk' }];
  for (const sun of identity) {
    for (let m = 0; m <= 1440; m += 7) assert.equal(S.remap(m / 60, sun, a), m / 60, JSON.stringify(sun));
    assert.equal(S.usable(sun), false, JSON.stringify(sun));
  }
  for (const sun of [{ rise: 1.5, set: 17 }, { rise: 7, set: 22.5 }, { rise: 9, set: 13 }]) assert.equal(S.usable(sun), true);
  assert.ok(Number.isNaN(S.remap(NaN, WINTER_SUN, a)));
  assert.ok(close(S.remap(25, null, a), 1), 'hours outside 0..24 wrap');
});

test('remap: a missing or broken anchor falls back to rise 7 / set 17', () => {
  for (const bad of [null, undefined, {}, { rise: 0.5, set: 17 }, { rise: 7, set: 23.5 }, { rise: 9, set: 10.5 }, { rise: 'x', set: 17 }]) {
    assert.equal(S.remap(8.3, WINTER_SUN, bad), 7, JSON.stringify(bad));
    assert.equal(S.remap(15.9, WINTER_SUN, bad), 17);
  }
  assert.deepEqual([S.FALLBACK.rise, S.FALLBACK.set], [7, 17]);
});

test('remap: polar night stays in the theme night all day, polar day in the theme day; midnight kept for night', () => {
  for (const a of ANCHOR_LIST) {
    const night = { rise: null, set: null, polar: 'night' };
    const day = { rise: null, set: null, polar: 'day' };
    assert.equal(S.remap(0, night, a), 0);
    assert.equal(S.remap(24, night, a), 24);
    for (let m = 0; m < 1440; m++) {
      const h = m / 60;
      const yn = S.remap(h, night, a);
      assert.ok(yn < a.rise - 1 || yn >= a.set + 1, `polar night at ${h}: ${yn}`);
      assert.equal(S.phase(yn, a), 'night');
      const yd = S.remap(h, day, a);
      assert.ok(yd >= a.rise + 1 && yd < a.set - 1, `polar day at ${h}: ${yd}`);
      assert.equal(S.phase(yd, a), 'day');
    }
    for (let m = 1; m < 1440; m++) {
      if (m === 720) continue; // the one jump of a polar night: noon, from its pre-dawn to its after-dusk end
      assert.ok(S.remap(m / 60, night, a) > S.remap((m - 1) / 60, night, a));
      assert.ok(S.remap(m / 60, day, a) > S.remap((m - 1) / 60, day, a));
    }
    assert.equal(S.usable(night), true);
    assert.equal(S.usable(day), true);
  }
});

// -------------------------------------------------------------------------------------------------------------------
// phase

test('phase: exact boundaries (half-open): dawn [rise-1, rise+1), day [rise+1, set-1), sunset [set-1, set+1)', () => {
  const eps = 1e-7; // 0.36 ms; edges themselves are exact to 1e-9 h
  assert.equal(S.phase(7.3, { rise: 8.3, set: 15.9 }), 'dawn', '8.3 - 1 in floating point is still the edge');
  for (const r of [...SUNS, ...ANCHOR_LIST]) {
    const cases = [
      [r.rise - 1 - eps, 'night'], [r.rise - 1, 'dawn'], [r.rise, 'dawn'], [r.rise + 1 - eps, 'dawn'], [r.rise + 1, 'day'],
      [(r.rise + r.set) / 2, 'day'], [r.set - 1 - eps, 'day'], [r.set - 1, 'sunset'], [r.set, 'sunset'],
      [r.set + 1 - eps, 'sunset'], [r.set + 1, 'night'], [0, 'night'], [23.999, 'night'], [24, 'night'],
    ];
    for (const [h, want] of cases) {
      if (h < 0 || h > 24) continue;
      assert.equal(S.phase(h, r), want, `h ${h} for ${JSON.stringify(r)}`);
    }
  }
});

test('phase: every minute has exactly one of the four phases, in order dawn -> day -> sunset -> night', () => {
  assert.deepEqual(S.PHASES, ['dawn', 'day', 'sunset', 'night']);
  for (const r of [...SUNS, ...ANCHOR_LIST]) {
    const seq = [];
    for (let m = 0; m < 1440; m++) {
      const p = S.phase(m / 60, r);
      assert.ok(S.PHASES.includes(p));
      if (seq[seq.length - 1] !== p) seq.push(p);
    }
    assert.deepEqual(seq, ['night', 'dawn', 'day', 'sunset', 'night'], JSON.stringify(r));
  }
});

test('phase: windows that cross midnight wrap (early sunrise, sunset after midnight)', () => {
  const early = { rise: 0.5, set: 20 }; // dawn [23.5, 24) + [0, 1.5)
  assert.equal(S.phase(23.4, early), 'night');
  assert.equal(S.phase(23.5, early), 'dawn');
  assert.equal(S.phase(0.2, early), 'dawn');
  assert.equal(S.phase(1.5, early), 'day');
  const late = { rise: 3, set: 23.5 }; // sunset [22.5, 24) + [0, 0.5)
  assert.equal(S.phase(22.5, late), 'sunset');
  assert.equal(S.phase(0.25, late), 'sunset');
  assert.equal(S.phase(0.5, late), 'night');
  assert.equal(S.phase(2, late), 'dawn');
  const afterMidnight = { rise: 1.5, set: 24.5 }; // sets 00:30 the next day (today() gives set > 24)
  assert.equal(S.phase(23.6, afterMidnight), 'sunset');
  assert.equal(S.phase(0.2, afterMidnight), 'sunset');
  assert.equal(S.phase(1, afterMidnight), 'dawn', 'the next dawn wins where the windows meet');
  assert.equal(S.phase(12, afterMidnight), 'day');
});

test('phase: under 2 h of daylight the windows meet at solar noon and there is no day', () => {
  const short = { rise: 11, set: 12.5 };
  assert.equal(S.phase(9.99, short), 'night');
  assert.equal(S.phase(10, short), 'dawn');
  assert.equal(S.phase(11.74, short), 'dawn');
  assert.equal(S.phase(11.75, short), 'sunset');
  assert.equal(S.phase(13.49, short), 'sunset');
  assert.equal(S.phase(13.5, short), 'night');
  for (let m = 0; m < 1440; m++) assert.notEqual(S.phase(m / 60, short), 'day');
});

test('phase: polar refs, missing refs and bad hours', () => {
  for (let m = 0; m < 1440; m += 13) {
    assert.equal(S.phase(m / 60, { rise: null, set: null, polar: 'night' }), 'night');
    assert.equal(S.phase(m / 60, { rise: null, set: null, polar: 'day' }), 'day');
    assert.equal(S.phase(m / 60, null), S.phase(m / 60, S.FALLBACK), 'no ref: FALLBACK 7/17');
  }
  assert.equal(S.phase(6, undefined), 'dawn');
  assert.equal(S.phase(NaN, WINTER_SUN), 'night');
  assert.equal(S.phase(30.5, WINTER_SUN), S.phase(6.5, WINTER_SUN), 'hours wrap');
});

test('label agrees with the picture: phase(h, ref(sun, anchor)) === phase(remap(h, sun, anchor), anchor)', () => {
  const suns = [...SUNS, null, { rise: 1, set: 23 }, { rise: 11, set: 12.5 }, { rise: 7, set: 24.5 },
    { rise: null, set: null, polar: 'night' }, { rise: null, set: null, polar: 'day' }];
  let checks = 0;
  for (const a of ANCHOR_LIST) {
    for (const sun of suns) {
      const r = S.ref(sun, a);
      const hs = [];
      for (let m = 0; m < 1440; m += 3) hs.push(m / 60);
      if (S.usable(sun) && !sun.polar) {
        for (const e of [sun.rise - 1, sun.rise + 1, sun.set - 1, sun.set + 1]) hs.push(e, e - 1e-6, e + 1e-6);
      }
      for (const h of hs) {
        assert.equal(S.phase(h, r), S.phase(S.remap(h, sun, a), a), `h ${h} sun ${JSON.stringify(sun)} anchor ${JSON.stringify(a)}`);
        checks++;
      }
    }
  }
  assert.ok(checks > 50000);
});

test('ref(): the sun when usable, else the anchor, else FALLBACK', () => {
  assert.equal(S.ref(WINTER_SUN, ANCHORS.autumn), WINTER_SUN);
  assert.equal(S.ref(null, ANCHORS.autumn), ANCHORS.autumn);
  assert.equal(S.ref({ rise: 1, set: 17 }, ANCHORS.autumn), ANCHORS.autumn);
  assert.equal(S.ref(null, { rise: 0.2, set: 17 }), S.FALLBACK);
  const polar = { rise: null, set: null, polar: 'night' };
  assert.equal(S.ref(polar, ANCHORS.autumn), polar);
});

// -------------------------------------------------------------------------------------------------------------------
// today()

test('today(): the real Berlin capture of 2026-11-15 gives 07:28:04 and 16:13:09 on the wall clock', () => {
  for (const name of ['forecast-berlin-c.json', 'forecast-berlin-f.json']) {
    const json = fixture(name);
    const now = new Date(2026, 10, 15, 12, 0);
    const sun = S.today(json, now);
    assert.ok(close(sun.rise, hm(7, 28, 4)), String(sun.rise));
    assert.ok(close(sun.set, hm(16, 13, 9)), String(sun.set));
    assert.equal(sun.polar, null);
    assert.deepEqual(S.today(json, new Date(2026, 10, 15, 0, 0)), sun, 'the first minute of the day');
    assert.deepEqual(S.today(json, new Date(2026, 10, 15, 23, 59, 59)), sun, 'the last second of the day');
    // The same through PCD.weather's parsed data and through a client state.
    const data = W.parseForecast(json, { units: name.endsWith('-f.json') ? 'F' : 'C' });
    assert.deepEqual(S.today(data, now), sun);
    assert.deepEqual(S.today({ status: 'ok', data }, now), sun);
  }
});

test('today(): null for yesterday\'s or tomorrow\'s forecast and for anything unusable', () => {
  const json = fixture('forecast-berlin-c.json');
  assert.equal(S.today(json, new Date(2026, 10, 16, 0, 0)), null, 'yesterday\'s forecast after midnight');
  assert.equal(S.today(json, new Date(2026, 10, 16, 8, 0)), null);
  assert.equal(S.today(json, new Date(2026, 10, 14, 23, 59)), null, 'tomorrow\'s forecast');
  for (const bad of [null, undefined, 42, 'x', {}, { daily: {} }, { daily: { time: ['2026-11-15'], sunrise: ['2026-11-15T07:28'], sunset: ['2026-11-15T16:13'] } },
    { status: 'error', data: null }]) {
    assert.equal(S.today(bad, new Date(2026, 10, 15, 12)), null, JSON.stringify(bad));
  }
  assert.equal(S.today(json, new Date(NaN)), null);
  const noSun = forecastFor(2026, 11, 15, null, null);
  assert.equal(S.today(noSun, new Date(2026, 10, 15, 12)), null, 'no sun times at an ordinary latitude: bad data, not polar');
});

test('today(): DST days read the wall clock (spring forward 2026-03-29, fall back 2026-10-25)', () => {
  // Spring forward: 02:00 CET -> 03:00 CEST. Sunrise 06:58 CEST is only 5 h 58 min after midnight.
  const spring = forecastFor(2026, 3, 29, berlin(2026, 3, 29, 6, 58), berlin(2026, 3, 29, 19, 40));
  for (const offset of [3600, 7200]) {
    const sun = S.today({ ...spring, utc_offset_seconds: offset }, new Date(2026, 2, 29, 10));
    assert.ok(close(sun.rise, hm(6, 58)), `rise ${sun.rise} (offset ${offset})`);
    assert.ok(close(sun.set, hm(19, 40)));
    assert.equal((spring.daily.sunrise[0] - spring.daily.time[0]) / HOUR, hm(5, 58), 'elapsed time differs from the wall');
  }
  assert.equal(S.hours(new Date(Date.UTC(2026, 2, 29, 0, 59))), hm(1, 59));
  assert.equal(S.hours(new Date(Date.UTC(2026, 2, 29, 1, 0))), 3, '02:00 never happens');
  // Fall back: 03:00 CEST -> 02:00 CET. Sunrise 06:59 CET is 7 h 59 min after midnight.
  const fall = forecastFor(2026, 10, 25, berlin(2026, 10, 25, 6, 59), berlin(2026, 10, 25, 16, 41));
  for (const offset of [3600, 7200]) {
    const sun = S.today({ ...fall, utc_offset_seconds: offset }, new Date(2026, 9, 25, 1, 30));
    assert.ok(close(sun.rise, hm(6, 59)), `rise ${sun.rise} (offset ${offset})`);
    assert.ok(close(sun.set, hm(16, 41)));
  }
  assert.equal(S.hours(new Date(Date.UTC(2026, 9, 25, 0, 30))), 2.5, '02:30 CEST');
  assert.equal(S.hours(new Date(Date.UTC(2026, 9, 25, 1, 30))), 2.5, '02:30 CET, the repeated hour');
  // Through the whole day the remap and the phase follow the wall clock.
  const sun = S.today(fall, new Date(2026, 9, 25, 12));
  const st = S.resolve(new Date(2026, 9, 25, 6, 30), { id: 'autumn', anchors: ANCHORS, sun });
  assert.equal(st.phase, 'dawn');
  assert.equal(st.source, 'sun');
  assert.ok(close(st.hourFloat, ANCHORS.autumn.rise - 0.4833333333, 1e-6));
});

test('today(): sunset after midnight and sunrise before it are measured from today\'s midnight', () => {
  const f = forecastFor(2026, 6, 20, berlin(2026, 6, 20, 1, 30), berlin(2026, 6, 21, 0, 30), { latitude: 66 });
  const sun = S.today(f, new Date(2026, 5, 20, 12));
  assert.ok(close(sun.rise, 1.5));
  assert.ok(close(sun.set, 24.5));
  assert.equal(S.usable(sun), false, 'set > 22.5: the theme keeps its own hours');
  assert.equal(S.resolve(new Date(2026, 5, 20, 12), { sun, anchors: ANCHORS, id: 'summer' }).source, 'theme');
});

test('today(): polar night and polar day (no sunrise or no sunset), both hemispheres', () => {
  const dec = new Date(2026, 11, 15, 12);
  const jun = new Date(2026, 5, 15, 12);
  const night = { rise: null, set: null, polar: 'night' };
  const day = { rise: null, set: null, polar: 'day' };
  // Sun times missing (null), equal, or not on the day at all (0 = 1970) at Longyearbyen-like 78.2 N / 70 N.
  assert.deepEqual(S.today(forecastFor(2026, 12, 15, null, null, { latitude: 78.2 }), dec), night);
  assert.deepEqual(S.today(forecastFor(2026, 12, 15, 0, 0, { latitude: 78.2 }), dec), night);
  const noon = berlin(2026, 12, 15, 12);
  assert.deepEqual(S.today(forecastFor(2026, 12, 15, noon, noon, { latitude: 70 }), dec), night);
  assert.deepEqual(S.today(forecastFor(2026, 6, 15, null, null, { latitude: 78.2 }), jun), day);
  // Rises as the day starts and sets as it ends: polar day without needing the latitude.
  assert.deepEqual(S.today(forecastFor(2026, 6, 15, berlin(2026, 6, 15), berlin(2026, 6, 16), { latitude: null }), jun), day);
  // Southern hemisphere (McMurdo-like 77.8 S): day in December, night in June.
  assert.deepEqual(S.today(forecastFor(2026, 12, 15, null, null, { latitude: -77.8 }), dec), day);
  assert.deepEqual(S.today(forecastFor(2026, 6, 15, null, null, { latitude: -77.8 }), jun), night);
  // Around an equinox nobody but the poles lacks a sunrise: treated as bad data.
  assert.equal(S.today(forecastFor(2026, 3, 20, null, null, { latitude: 78.2 }), new Date(2026, 2, 20, 12)), null);
  // Through the parsed data of PCD.weather as well.
  const raw = forecastFor(2026, 12, 15, null, null, { latitude: 78.2, current_units: { temperature_2m: '°C', wind_speed_10m: 'km/h' } });
  assert.deepEqual(S.today(W.parseForecast(raw, { units: 'C' }), dec), night);
  // And resolve(): a polar night is night all day with the picture inside the theme's night.
  for (let h = 0; h < 24; h += 0.25) {
    const st = S.resolve(new Date(2026, 11, 15, Math.floor(h), (h % 1) * 60), { id: 'winter', anchors: ANCHORS, sun: night });
    assert.equal(st.phase, 'night');
    assert.equal(st.polar, 'night');
    assert.equal(S.phase(st.hourFloat, ANCHORS.winter), 'night');
  }
});

test('today(): another computer time zone (America/Chicago) reads its own wall clock', () => {
  const saved = process.env.TZ;
  process.env.TZ = 'America/Chicago';
  try {
    // A Chicago-like day, 2026-11-15 (CST, UTC-6): sunrise 06:41, sunset 16:31.
    const day = Date.UTC(2026, 10, 15, 6) / 1000;
    const f = { utc_offset_seconds: -21600, latitude: 41.9, daily: { time: [day], sunrise: [day + hm(6, 41) * HOUR], sunset: [day + hm(16, 31) * HOUR] } };
    const sun = S.today(f, new Date(2026, 10, 15, 9));
    assert.ok(close(sun.rise, hm(6, 41)));
    assert.ok(close(sun.set, hm(16, 31)));
    assert.equal(S.today(f, new Date(2026, 10, 16, 0, 1)), null, 'yesterday\'s after local midnight');
    // DST end in the US, 2026-11-01: 02:00 CDT -> 01:00 CST; sunrise 06:27 CST is 7 h 27 min after midnight.
    const d2 = Date.UTC(2026, 10, 1, 5) / 1000; // 00:00 CDT
    const f2 = { utc_offset_seconds: -21600, latitude: 41.9, daily: { time: [d2], sunrise: [d2 + hm(7, 27) * HOUR], sunset: [d2 + hm(17, 47) * HOUR] } };
    const s2 = S.today(f2, new Date(2026, 10, 1, 12));
    assert.ok(close(s2.rise, hm(6, 27)), String(s2.rise));
    assert.ok(close(s2.set, hm(16, 47)), String(s2.set));
  } finally {
    process.env.TZ = saved;
  }
  assert.equal(new Date(Date.UTC(2026, 6, 1, 12)).getHours(), 14, 'back on Berlin time');
});

// -------------------------------------------------------------------------------------------------------------------
// resolve(), anchor(), curve(), phaseHour(), text helpers

test('resolve(): follow the real sun on and off, forecasts, sources', () => {
  const json = fixture('forecast-berlin-c.json');
  const at = (h, m) => new Date(2026, 10, 15, h, m);
  const on = S.resolve(at(7, 50), { id: 'autumn', anchors: ANCHORS, forecast: json });
  assert.equal(on.source, 'sun');
  assert.equal(on.phase, 'dawn');
  assert.ok(close(on.hour, hm(7, 50)));
  assert.ok(close(on.hourFloat, ANCHORS.autumn.rise + (hm(7, 50) - hm(7, 28, 4)), 1e-9));
  assert.deepEqual([on.anchor.rise, on.anchor.set, on.anchor.curve.length], [ANCHORS.autumn.rise, ANCHORS.autumn.set, 48]);
  assert.ok(close(on.sun.rise, hm(7, 28, 4)));
  const off = S.resolve(at(7, 50), { id: 'autumn', anchors: ANCHORS, forecast: json, follow: false });
  assert.equal(off.source, 'theme');
  assert.equal(off.hourFloat, off.hour, 'the theme keeps its own hours');
  assert.equal(off.phase, 'dawn', 'the autumn theme itself is at dawn at 7:50 (its rise is 7.16)');
  assert.equal(off.sun, null);
  assert.equal(S.resolve(at(16, 30), { id: 'autumn', anchors: ANCHORS, forecast: json }).phase, 'sunset');
  assert.equal(S.resolve(at(16, 30), { id: 'summer', anchors: ANCHORS, forecast: json, follow: false }).phase, 'day', 'summer sets at 19.11');
  const none = S.resolve(at(12, 0), { id: 'nope', anchors: ANCHORS });
  assert.equal(none.anchor, S.FALLBACK, 'unknown theme: FALLBACK');
  assert.equal(none.source, 'theme');
  for (const bad of [new Date(NaN), undefined, 'x']) {
    const st = S.resolve(bad, { id: 'autumn', anchors: ANCHORS });
    assert.ok(Number.isFinite(st.hour) && st.hourFloat === st.hour, 'a missing or invalid time means now');
  }
  assert.ok(Number.isFinite(S.resolve(at(12, 0).getTime(), { id: 'autumn', anchors: ANCHORS }).hourFloat), 'ms timestamps');
  const yesterday = S.resolve(new Date(2026, 10, 16, 7, 50), { id: 'autumn', anchors: ANCHORS, forecast: json });
  assert.equal(yesterday.source, 'theme', 'a stale forecast falls back to the theme hours');
  // Without an anchors table, PCD.ANCHORS is used when present.
  const withCurve = { ...ANCHORS.autumn, curve: S.FALLBACK.curve.slice() };
  globalThis.PCD.ANCHORS = { autumn: withCurve };
  try {
    assert.equal(S.resolve(at(12, 0), { id: 'autumn' }).anchor, withCurve, 'a complete anchor passes through as is');
  } finally {
    delete globalThis.PCD.ANCHORS;
  }
  assert.equal(S.resolve(at(12, 0), { id: 'autumn' }).anchor, S.FALLBACK);
});

test('anchor(): sane table entries pass through; broken ones and unknown ids give FALLBACK; curves are completed', () => {
  const curve = Array.from({ length: 48 }, (_, i) => (i >= 14 && i < 34 ? 1 : 0));
  const table = { a: { rise: 7, set: 17, curve }, b: { rise: 0.9, set: 17 }, c: { rise: 6, set: 18 } };
  assert.equal(S.anchor('a', table), table.a);
  assert.equal(S.anchor('b', table), S.FALLBACK);
  assert.equal(S.anchor('zzz', table), S.FALLBACK);
  assert.equal(S.anchor('toString', table), S.FALLBACK, 'no prototype keys');
  const c = S.anchor('c', table);
  assert.deepEqual([c.rise, c.set, c.curve.length], [6, 18, 48]);
  assert.equal(S.FALLBACK.curve.length, 48);
  assert.ok(Object.isFrozen(S.FALLBACK));
});

test('curve(): 48 half-hour levels, the anchor curve itself without sun times, bent by real ones', () => {
  const curve = Array.from({ length: 48 }, (_, i) => Math.round(Math.max(0, Math.min(1, 1 - Math.abs(i - 24) / 12)) * 100) / 100);
  const a = { rise: 7, set: 17, curve };
  assert.deepEqual(S.curve(a, null), curve);
  const bent = S.curve(a, WINTER_SUN);
  assert.equal(bent.length, 48);
  for (const v of bent) assert.ok(v >= 0 && v <= 1);
  for (let i = 0; i < 48; i++) {
    const y = S.remap(i / 2, WINTER_SUN, a);
    const x = y * 2;
    const j = Math.floor(x);
    const want = curve[j % 48] + (curve[(j + 1) % 48] - curve[j % 48]) * (x - j);
    assert.ok(close(bent[i], Math.round(want * 100) / 100, 1e-9), `cell ${i}`);
  }
  assert.deepEqual(S.curve(null, null), S.FALLBACK.curve);
  const polar = S.curve(a, { rise: null, set: null, polar: 'night' });
  assert.ok(Math.max(...polar) <= curve[12], 'a polar night never gets brighter than the theme at its dawn window start');
});

test('phaseHour(): a typical theme hour for each phase, which phase() names back', () => {
  for (const a of ANCHOR_LIST) {
    for (const p of S.PHASES) assert.equal(S.phase(S.phaseHour(p, a), a), p, `${p} for ${JSON.stringify(a)}`);
  }
  assert.equal(S.phaseHour('night', { rise: 7, set: 17 }), 0);
  assert.equal(S.phaseHour('day', { rise: 7, set: 17 }), 12);
  assert.equal(S.phaseHour('dawn', null), 7);
  assert.throws(() => S.phaseHour('noon', null), /unknown phase/);
});

test('hours(), wallHours(), clockText(), text(), declination()', () => {
  assert.equal(S.hours(new Date(2026, 10, 15, 16, 30, 36, 500)), 16 + 30 / 60 + 36 / 3600 + 0.5 / 3600);
  assert.equal(S.hours(new Date(2026, 10, 15).getTime()), 0, 'ms timestamps work');
  assert.ok(Number.isNaN(S.hours(new Date(NaN))));
  const ref = new Date(2026, 10, 15, 12);
  assert.equal(S.wallHours(new Date(2026, 10, 16, 0, 30).getTime(), ref), 24.5);
  assert.equal(S.wallHours(new Date(2026, 10, 14, 23, 0).getTime(), ref), -1);
  assert.equal(S.clockText(hm(7, 28, 4), false), '7:28 am');
  assert.equal(S.clockText(hm(16, 13, 9), false), '4:13 pm');
  assert.equal(S.clockText(hm(16, 13, 31), true), '16:14', 'rounded to the minute');
  assert.equal(S.clockText(0, false), '12:00 am');
  assert.equal(S.clockText(12, false), '12:00 pm');
  assert.equal(S.clockText(24.5, true), '00:30');
  assert.equal(S.clockText(hm(23, 59, 50), true), '00:00');
  assert.equal(S.clockText(NaN, true), '');
  assert.equal(S.text({ rise: hm(7, 28), set: hm(16, 13) }, false), '7:28 am - 4:13 pm');
  assert.equal(S.text({ rise: hm(7, 28), set: hm(16, 13) }, true), '07:28 - 16:13');
  assert.equal(S.text({ rise: null, set: null, polar: 'night' }), 'polar night');
  assert.equal(S.text(null), '');
  assert.ok(S.declination(new Date(2026, 5, 21)) > 23.3);
  assert.ok(S.declination(new Date(2026, 11, 21)) < -23.3);
  assert.ok(Math.abs(S.declination(new Date(2026, 2, 20))) < 1.5);
});

test('the shipped file: classic UMD, PCD.sun, ASCII only, no BOM, LF, no module syntax, no timers or network', () => {
  const buf = fs.readFileSync(path.join(ROOT, 'src', 'shared', 'pcd-sun.js'));
  assert.notDeepEqual([...buf.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  const src = buf.toString('utf8');
  assert.ok(!src.includes('\r'));
  assert.ok(/^[\x0a\x20-\x7e]*$/.test(src), 'ASCII only');
  assert.doesNotMatch(src, /^\s*(import|export)\s/m);
  assert.doesNotMatch(src, /\b(setTimeout|setInterval|fetch|XMLHttpRequest|Math\.random)\s*\(|\b(document|window|localStorage)\./);
  assert.match(src, /module\.exports = api/);
  assert.equal(globalThis.PCD.sun, S);
});
