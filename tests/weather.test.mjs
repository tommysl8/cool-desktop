// node --test "tests/weather.test.mjs"
// src/shared/pcd-weather.js: WMO mapping and labels, units, the exact Open-Meteo URLs, the parsers
// (real Berlin captures in tests/fixtures/weather, 2026-11-15, both units) and the cached client with a fake clock, a
// fake fetch and fake storage: TTL, geocoding only on a city change, the "City, CC" retry, back-off, STALE, offline,
// timeouts, the next-day refetch for new sun times. No network (the opt-in live check is tests/weather-live.test.mjs).
process.env.TZ = 'Europe/Berlin';

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

function findRoot(start) {
  let d = start;
  while (!fs.existsSync(path.join(d, 'src', 'shared', 'pcd-weather.js'))) {
    const up = path.dirname(d);
    if (up === d) throw new Error('project root not found');
    d = up;
  }
  return d;
}
const ROOT = findRoot(path.dirname(fileURLToPath(import.meta.url)));
const require = createRequire(import.meta.url);
const W = require(path.join(ROOT, 'src', 'shared', 'pcd-weather.js'));
const S = require(path.join(ROOT, 'src', 'shared', 'pcd-sun.js'));
const FIX = path.join(ROOT, 'tests', 'fixtures', 'weather');
const text = (name) => fs.readFileSync(path.join(FIX, name), 'utf8');
const fixture = (name) => JSON.parse(text(name));

const MIN = 60 * 1000;
const DEG = String.fromCodePoint(0xb0);
const DOT = String.fromCodePoint(0xb7);
const GEO = 'https://geocoding-api.open-meteo.com/v1/search?';
const FC = 'https://api.open-meteo.com/v1/forecast?';
const FC_BERLIN_C = 'https://api.open-meteo.com/v1/forecast?latitude=52.52437&longitude=13.41053&current=temperature_2m,apparent_temperature,weather_code,wind_speed_10m,precipitation,cloud_cover,is_day&daily=temperature_2m_max,temperature_2m_min,sunrise,sunset&timezone=auto&timeformat=unixtime&forecast_days=1';
const FC_BERLIN_F = FC_BERLIN_C + '&temperature_unit=fahrenheit&wind_speed_unit=mph';
const GEO_BERLIN = 'https://geocoding-api.open-meteo.com/v1/search?name=Berlin&count=1&language=en&format=json';

// -------------------------------------------------------------------------------------------------------------------
// A fake Open-Meteo that answers like the real one (captured live for Berlin, 2026-11-15): "Berlin" (any case) and
// name=Berlin&countryCode=DE find Berlin, everything else finds nothing (as "Berlin, DE" does for real); forecasts
// follow the unit parameters and are re-dated to the fake clock's local day.

function response(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => JSON.parse(body) };
}

function fakeMeteo(clock, opts = {}) {
  const calls = [];
  let mode = opts.mode || 'ok'; // ok | 400 | 500 | badjson | throw | hang
  const fetch = (url, init) => {
    calls.push({ url, init });
    if (mode === 'throw') return Promise.reject(new TypeError('Failed to fetch'));
    if (mode === 'hang') return new Promise((resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted'))));
    if (mode === '400') return Promise.resolve(response(400, text('error-400.json')));
    if (mode === '500') return Promise.resolve(response(500, '<html>oops</html>'));
    if (mode === 'badjson') return Promise.resolve(response(200, '{"latitude":52.5,'));
    const u = new URL(url);
    if (u.host === 'geocoding-api.open-meteo.com') {
      const name = (u.searchParams.get('name') || '').toLowerCase();
      const cc = u.searchParams.get('countryCode');
      const hit = name === 'berlin' && (!cc || cc === 'DE');
      return Promise.resolve(response(200, text(hit ? 'geocode-berlin.json' : 'geocode-berlin-de.json')));
    }
    if (u.host === 'api.open-meteo.com') {
      const json = fixture(u.searchParams.get('temperature_unit') === 'fahrenheit' ? 'forecast-berlin-f.json' : 'forecast-berlin-c.json');
      const t = new Date(clock.now());
      const local = new Date(t.getFullYear(), t.getMonth(), t.getDate()).getTime() / 1000;
      const shift = local - json.daily.time[0] - (opts.lagDays || 0) * 86400;
      for (const k of ['time', 'sunrise', 'sunset']) json.daily[k] = [json.daily[k][0] + shift];
      json.current.time += shift;
      return Promise.resolve(response(200, JSON.stringify(json)));
    }
    return Promise.reject(new Error('unexpected host ' + u.host));
  };
  return { fetch, calls, setMode: (m) => { mode = m; } };
}

function memoryStorage() {
  const map = new Map();
  return { getItem: (k) => (map.has(k) ? map.get(k) : null), setItem: (k, v) => map.set(k, String(v)), map };
}

function setup(opts = {}) {
  const clock = { t: opts.start || new Date(2026, 10, 15, 12, 0).getTime(), now() { return this.t; } };
  const meteo = fakeMeteo(clock, opts);
  const storage = opts.storage === undefined ? memoryStorage() : opts.storage;
  let online = true;
  const client = W.createClient({
    storage, fetch: meteo.fetch, now: () => clock.t, online: () => online, timeoutMs: opts.timeoutMs,
  });
  return { clock, meteo, storage, client, setOnline: (v) => { online = v; }, advance: (ms) => { clock.t += ms; } };
}

// -------------------------------------------------------------------------------------------------------------------
// WMO codes, labels, units

const GROUPS = {
  clear: [0, 1], partly: [2], cloudy: [3], fog: [45, 48], drizzle: [51, 53, 55], freezing: [56, 57, 66, 67],
  rain: [61, 63, 65, 80, 81, 82], snow: [71, 73, 75, 77, 85, 86], thunder: [95, 96, 97, 99],
};

test('kind(): every WMO code group maps to its kind; day or night does not change it', () => {
  assert.deepEqual(W.KINDS, ['clear', 'partly', 'cloudy', 'fog', 'drizzle', 'freezing', 'rain', 'snow', 'thunder', 'unknown']);
  assert.deepEqual(W.CODE_GROUPS, GROUPS);
  for (const [k, codes] of Object.entries(GROUPS)) {
    for (const c of codes) {
      assert.equal(W.kind(c), k, `code ${c}`);
      assert.equal(W.kind(String(c)), k, 'numeric strings are accepted');
      assert.equal(W.kind(c, 0), k, 'is_day is not part of the kind');
    }
  }
});

test('kind(): anything else is unknown', () => {
  for (const c of [4, 5, 10, 44, 46, 49, 50, 52, 58, 60, 62, 64, 68, 70, 72, 76, 79, 83, 84, 87, 94, 98, 100, -1, 1.5, NaN, Infinity, null, undefined, '', ' ', 'abc', true, {}, []]) {
    assert.equal(W.kind(c), 'unknown', `code ${JSON.stringify(c)}`);
  }
});

test('describe(): a short lowercase ASCII description for every code; label() for every kind', () => {
  const all = Object.values(GROUPS).flat();
  assert.deepEqual(Object.keys(W.DESCRIPTIONS).map(Number).sort((a, b) => a - b), [...all].sort((a, b) => a - b));
  for (const c of all) {
    const d = W.describe(c);
    assert.match(d, /^[a-z][a-z ]*[a-z]$/, `code ${c}: "${d}"`);
    assert.ok(d.length <= 18, `code ${c}: "${d}" is too long for the panel`);
  }
  const some = { 0: 'clear', 1: 'mostly clear', 2: 'partly cloudy', 3: 'overcast', 45: 'fog', 48: 'freezing fog',
    51: 'light drizzle', 61: 'light rain', 63: 'rain', 65: 'heavy rain', 66: 'freezing rain', 71: 'light snow',
    75: 'heavy snow', 80: 'light showers', 82: 'heavy showers', 86: 'heavy snow showers', 95: 'thunderstorm', 99: 'thunder and hail' };
  for (const [c, d] of Object.entries(some)) assert.equal(W.describe(Number(c)), d);
  assert.equal(W.describe(42), 'unknown');
  assert.equal(W.describe(null), 'unknown');
  for (const k of W.KINDS) assert.match(W.label(k), /^[a-z ]+$/);
  assert.equal(W.label('thunder'), 'thunderstorm');
  assert.equal(W.label('nope'), 'unknown');
});

test('units: normUnits() and the display labels (degree sign, mph, km/h)', () => {
  for (const f of ['F', 'f', ' fahrenheit ', 'Imperial', DEG + 'F', 1, true]) assert.equal(W.normUnits(f), 'F', String(f));
  for (const c of ['C', 'c', 'celsius', 'metric', '', null, undefined, 0, false, 'x']) assert.equal(W.normUnits(c), 'C', String(c));
  assert.deepEqual(W.unitLabels('F'), { units: 'F', temp: DEG + 'F', wind: 'mph' });
  assert.deepEqual(W.unitLabels('C'), { units: 'C', temp: DEG + 'C', wind: 'km/h' });
  assert.deepEqual(W.API_UNITS, { F: { temperature_2m: [DEG + 'F'], wind_speed_10m: ['mp/h', 'mph'] }, C: { temperature_2m: [DEG + 'C'], wind_speed_10m: ['km/h'] } });
});

// -------------------------------------------------------------------------------------------------------------------
// URLs and parsers

test('geocodeUrl(): the exact string, encodeURIComponent, squashed spaces, optional countryCode', () => {
  assert.equal(W.geocodeUrl('Berlin'), GEO_BERLIN);
  assert.equal(W.geocodeUrl('  New   York, NY '), GEO + 'name=New%20York%2C%20NY&count=1&language=en&format=json');
  assert.equal(W.geocodeUrl('S' + String.fromCodePoint(0xe3) + 'o Paulo'), GEO + 'name=S%C3%A3o%20Paulo&count=1&language=en&format=json');
  assert.equal(W.geocodeUrl('A&B=C#'), GEO + 'name=A%26B%3DC%23&count=1&language=en&format=json');
  assert.equal(W.geocodeUrl('Berlin', { countryCode: ' de ' }), GEO_BERLIN + '&countryCode=DE');
  for (const none of [undefined, null, '', '  ']) assert.equal(W.geocodeUrl('Berlin', { countryCode: none }), GEO_BERLIN);
  for (const bad of ['DEU', 'D', 'D1', '12', 'D E']) assert.throws(() => W.geocodeUrl('Berlin', { countryCode: bad }), /two letters/);
});

test('splitCountryCode(): only "City, CC" gives the one retry', () => {
  const yes = { 'Berlin, DE': ['Berlin', 'DE'], 'berlin,de': ['berlin', 'DE'], ' Berlin ,  De ': ['Berlin', 'DE'],
    'Portland, Oregon, US': ['Portland, Oregon', 'US'], 'Berlin,, DE': ['Berlin', 'DE'] };
  for (const [city, [name, countryCode]] of Object.entries(yes)) assert.deepEqual(W.splitCountryCode(city), { name, countryCode }, city);
  for (const city of ['Berlin', 'Berlin, Germany', 'Berlin, DEU', 'Berlin, D', 'Berlin, 12', 'Be, DE', ', DE', '', null]) {
    assert.equal(W.splitCountryCode(city), null, String(city));
  }
});

test('forecastUrl(): the exact strings in both units; bad coordinates throw', () => {
  assert.equal(W.forecastUrl(52.52437, 13.41053, 'C'), FC_BERLIN_C);
  assert.equal(W.forecastUrl('52.52437', '13.41053', 'celsius'), FC_BERLIN_C);
  assert.equal(W.forecastUrl(52.52437, 13.41053, 'F'), FC_BERLIN_F);
  assert.equal(W.forecastUrl(-33.9, -70.65, 'C'), FC + 'latitude=-33.9&longitude=-70.65' + FC_BERLIN_C.slice(FC_BERLIN_C.indexOf('&current')));
  for (const [lat, lon] of [[NaN, 1], [1, null], ['x', 1], [91, 0], [0, 181], [undefined, 0]]) {
    assert.throws(() => W.forecastUrl(lat, lon, 'C'), /forecastUrl/, `${lat},${lon}`);
  }
});

test('parseGeocode(): the Berlin capture, no results, country filter, error bodies', () => {
  assert.deepEqual(W.parseGeocode(fixture('geocode-berlin.json')), {
    name: 'Berlin', admin1: 'State of Berlin', country_code: 'DE', latitude: 52.52437, longitude: 13.41053, timezone: 'Europe/Berlin',
  });
  assert.equal(W.parseGeocode(fixture('geocode-berlin-de.json')), null, 'no "results" key: not found');
  assert.equal(W.parseGeocode({ results: [] }), null);
  assert.equal(W.parseGeocode({ results: [{ name: 'X', latitude: 'a', longitude: 1 }] }), null);
  assert.equal(W.parseGeocode(fixture('geocode-berlin-cc.json'), { countryCode: 'US' }), null, 'another country is no match');
  assert.equal(W.parseGeocode(fixture('geocode-berlin-cc.json'), { countryCode: 'de' }).name, 'Berlin');
  assert.throws(() => W.parseGeocode(fixture('error-400.json')), /Open-Meteo geocoding: Cannot initialize/);
  assert.equal(W.parseGeocode(null), null);
  assert.equal(W.placeLabel(W.parseGeocode(fixture('geocode-berlin.json'))), 'Berlin, DE', 'admin1 that repeats the name is left out');
  assert.equal(W.placeLabel({ name: 'Portland', admin1: 'Oregon', country_code: 'US' }), 'Portland, Oregon, US');
  assert.equal(W.placeLabel(null), '');
});

test('parseForecast(): the Berlin captures in both units, with today\'s sun times', () => {
  const c = W.parseForecast(fixture('forecast-berlin-c.json'), { units: 'C' });
  assert.deepEqual(c, {
    temp: 6.9, feels: 3.5, wind: 12.4, windKmh: 12.4, precip: 0, cloud: 89, code: 3, isDay: false, kind: 'cloudy',
    description: 'overcast', label: 'cloudy', high: 8.4, low: 0.4, day: 1794697200, sunrise: 1794724084, sunset: 1794755589,
    utcOffset: 3600, timezone: 'Europe/Berlin', latitude: 52.528915, time: 1794781800,
  });
  const f = W.parseForecast(fixture('forecast-berlin-f.json'), { units: 'F' });
  assert.equal(f.temp, 44.3);
  assert.equal(f.wind, 7.7);
  assert.equal(f.windKmh, 12.4, 'mph converted for the scene effects');
  assert.deepEqual([f.high, f.low, f.sunrise, f.sunset], [47.1, 32.7, 1794724084, 1794755589]);
  assert.equal(W.parseForecast(fixture('forecast-berlin-f.json')).windKmh, 12.4, 'without opts.units the API unit is used');
  const sun = S.today(c, new Date(2026, 10, 15, 9));
  assert.ok(Math.abs(sun.rise - (7 + 28 / 60 + 4 / 3600)) < 1e-9);
});

test('parseForecast(): unit mismatches, error bodies and missing data throw', () => {
  assert.throws(() => W.parseForecast(fixture('forecast-berlin-f.json'), { units: 'C' }), /units do not match.*temperature_2m "°F".*wind_speed_10m "mp\/h"/);
  assert.throws(() => W.parseForecast(fixture('forecast-berlin-c.json'), { units: 'F' }), /units do not match/);
  const inch = fixture('forecast-berlin-c.json');
  inch.current_units.precipitation = 'inch';
  assert.throws(() => W.parseForecast(inch, { units: 'C' }), /precipitation "inch"/);
  const noUnits = fixture('forecast-berlin-c.json');
  delete noUnits.current_units;
  assert.throws(() => W.parseForecast(noUnits, { units: 'C' }), /temperature_2m missing/);
  assert.equal(W.parseForecast(noUnits).temp, 6.9, 'nothing checked without opts.units');
  assert.throws(() => W.parseForecast(fixture('error-400.json')), /Open-Meteo forecast: Cannot initialize/);
  assert.throws(() => W.parseForecast({ reason: 'x', error: true }), /Open-Meteo forecast: x/);
  assert.throws(() => W.parseForecast({ latitude: 1 }), /no "current" block/);
  assert.throws(() => W.parseForecast({ current: { temperature_2m: null } }), /no current temperature/);
  assert.throws(() => W.parseForecast(null), /empty response/);
  const bare = W.parseForecast({ current: { temperature_2m: -0.4, weather_code: 'x', is_day: 1 } });
  assert.deepEqual([bare.temp, bare.kind, bare.isDay, bare.high, bare.day, bare.sunrise, bare.windKmh], [-0.4, 'unknown', true, null, null, null, null]);
});

test('lines() and updatedLabel(): the weather as plain text, with hi and lo as the console says them', () => {
  const c = W.parseForecast(fixture('forecast-berlin-c.json'), { units: 'C' });
  assert.deepEqual(W.lines(c, 'C'), ['7' + DEG + 'C overcast', 'hi 8' + DEG + ' ' + DOT + ' lo 0' + DEG]);
  const f = W.parseForecast(fixture('forecast-berlin-f.json'), { units: 'F' });
  assert.deepEqual(W.lines(f, 'F'), ['44' + DEG + 'F overcast', 'hi 47' + DEG + ' ' + DOT + ' lo 33' + DEG]);
  assert.deepEqual(W.lines({ temp: -0.4, kind: 'snow', high: null, low: null }, 'C'), ['0' + DEG + 'C snow', 'hi -' + DEG + ' ' + DOT + ' lo -' + DEG]);
  assert.deepEqual(W.lines(null, 'C'), ['', '']);
  assert.equal(W.updatedLabel(new Date(2026, 10, 15, 21, 41).getTime(), false), 'updated 9:41 pm');
  assert.equal(W.updatedLabel(new Date(2026, 10, 15, 9, 5).getTime(), true), 'updated 09:05');
  assert.equal(W.updatedLabel(null), '');
  assert.equal(W.CREDIT, 'weather: open-meteo.com');
  assert.equal(W.CREDIT_URL, 'https://open-meteo.com/');
});

// -------------------------------------------------------------------------------------------------------------------
// Client

test('client: first get geocodes and fetches; the cache answers for 30 minutes; then only the forecast', async () => {
  const { client, meteo, storage, advance } = setup();
  const st = await client.get({ city: 'Berlin', units: 'C' });
  assert.equal(st.status, 'ok');
  assert.equal(st.stale, false);
  assert.equal(st.fetched, true);
  assert.equal(st.place.name, 'Berlin');
  assert.equal(st.data.temp, 6.9);
  assert.deepEqual(st.labels, { units: 'C', temp: DEG + 'C', wind: 'km/h' });
  assert.deepEqual(meteo.calls.map((c) => c.url), [GEO_BERLIN, FC_BERLIN_C]);
  for (const { init } of meteo.calls) {
    assert.equal(init.credentials, 'omit');
    assert.equal(init.referrerPolicy, 'no-referrer');
    assert.equal(init.cache, 'no-store');
    assert.ok(init.signal, 'an AbortSignal for the timeout');
  }
  const saved = JSON.parse(storage.getItem('pcd.weather'));
  assert.equal(saved.v, 1);
  assert.equal(saved.city, 'berlin');
  assert.equal(W.cacheOk(saved), true);
  assert.ok(S.today(st.data, new Date(2026, 10, 15, 12)), 'today\'s sun times come with the forecast');

  advance(29 * MIN);
  const cached = await client.get({ city: '  BERLIN ', units: 'C' });
  assert.equal(cached.status, 'ok');
  assert.equal(cached.fetched, false);
  assert.equal(cached.ageMs, 29 * MIN);
  assert.equal(meteo.calls.length, 2, 'served from the cache, same city in another case');

  advance(2 * MIN);
  const again = await client.get({ city: 'Berlin', units: 'C' });
  assert.equal(again.fetched, true);
  assert.deepEqual(meteo.calls.slice(2).map((c) => c.url), [FC_BERLIN_C], 'no second geocoding');
  assert.equal(client.requests(), 3);
  assert.equal(client.ttlMs, 30 * MIN);
});

test('client: a unit change refetches the forecast only; a city change geocodes again', async () => {
  const { client, meteo } = setup();
  await client.get({ city: 'Berlin', units: 'C' });
  const f = await client.get({ city: 'Berlin', units: 'F' });
  assert.equal(f.status, 'ok');
  assert.equal(f.data.temp, 44.3);
  assert.equal(f.units, 'F');
  assert.deepEqual(f.labels, { units: 'F', temp: DEG + 'F', wind: 'mph' });
  assert.deepEqual(meteo.calls.map((c) => c.url), [GEO_BERLIN, FC_BERLIN_C, FC_BERLIN_F]);
  const other = await client.get({ city: 'Nowhereville', units: 'F' });
  assert.equal(other.status, 'not-found');
  assert.equal(other.error, 'city not found');
  assert.equal(meteo.calls[3].url, GEO + 'name=Nowhereville&count=1&language=en&format=json');
  assert.equal(meteo.calls.length, 4);
  assert.equal((await client.get({ city: 'Nowhereville', units: 'F' })).status, 'not-found');
  assert.equal(meteo.calls.length, 4, 'a city that was not found is not asked again');
  await client.get({ city: 'Nowhereville', units: 'F', force: true });
  assert.equal(meteo.calls.length, 5, 'force asks again');
  const back = await client.get({ city: 'Berlin', units: 'F' });
  assert.equal(back.status, 'ok');
  assert.equal(meteo.calls[5].url, GEO_BERLIN, 'the cache holds one city: switching back geocodes again');
});

test('client: "Berlin, DE" finds nothing as typed, then retries once with countryCode=DE', async () => {
  const { client, meteo } = setup();
  const st = await client.get({ city: 'Berlin, DE', units: 'C' });
  assert.equal(st.status, 'ok');
  assert.equal(st.city, 'Berlin, DE');
  assert.deepEqual(meteo.calls.map((c) => c.url), [
    GEO + 'name=Berlin%2C%20DE&count=1&language=en&format=json', GEO_BERLIN + '&countryCode=DE', FC_BERLIN_C,
  ]);
  const { client: c2, meteo: m2 } = setup();
  assert.equal((await c2.get({ city: 'Nowhere, ZZ', units: 'C' })).status, 'not-found');
  assert.equal(m2.calls.length, 2, 'one retry only');
  const { client: c3, meteo: m3 } = setup();
  assert.equal((await c3.get({ city: 'Nowhere, Germany', units: 'C' })).status, 'not-found');
  assert.equal(m3.calls.length, 1, 'no retry without a two-letter code');
});

test('client: never asks for city names under 3 characters', async () => {
  const { client, meteo } = setup();
  for (const city of ['', '   ', 'B', 'Be', '  b  ', ' Be ']) {
    const st = await client.get({ city, units: 'C' });
    assert.ok(['short', 'no-city'].includes(st.status), city);
    assert.equal(st.data, null);
    const pk = await client.peek({ city, units: 'C' });
    assert.equal(pk.status, st.status);
  }
  assert.equal((await client.get({ city: '', units: 'C' })).error, 'no city set');
  assert.equal((await client.get({ city: 'Be', units: 'C' })).error, 'type at least 3 characters');
  assert.equal(meteo.calls.length, 0);
  assert.equal((await client.get({ city: 'Ber', units: 'C' })).status, 'not-found');
  assert.equal(meteo.calls.length, 1, '3 characters are enough');
});

test('client: HTTP 400 -> error, then the back-off sequence 1, 2, 5, 10, 30, 30 minutes', async () => {
  const { client, meteo, advance, clock } = setup({ mode: '400' });
  let st = await client.get({ city: 'Berlin', units: 'C' });
  assert.equal(st.status, 'error');
  assert.equal(st.error, 'HTTP 400: Cannot initialize WeatherVariable from invalid String value tempeture_2m for key current');
  assert.equal(st.fails, 1);
  assert.equal(st.nextTryAt, clock.t + 1 * MIN);
  const waits = [];
  for (let i = 0; i < 5; i++) {
    const n = meteo.calls.length;
    advance(st.nextTryAt - clock.t - 1);
    const early = await client.get({ city: 'Berlin', units: 'C' });
    assert.equal(meteo.calls.length, n, 'no request while backing off');
    assert.equal(early.status, 'error');
    advance(1);
    st = await client.get({ city: 'Berlin', units: 'C' });
    assert.equal(meteo.calls.length, n + 1);
    waits.push((st.nextTryAt - clock.t) / MIN);
  }
  assert.deepEqual(waits, [2, 5, 10, 30, 30]);
  assert.deepEqual(W.BACKOFF_MS.map((ms) => ms / MIN), [1, 2, 5, 10, 30]);
  // force skips the wait; success resets the counter.
  meteo.setMode('ok');
  st = await client.get({ city: 'Berlin', units: 'C', force: true });
  assert.equal(st.status, 'ok');
  assert.equal(st.fails, 0);
  assert.equal(st.nextTryAt, null);
});

test('client: failures with a cache are STALE (the data stays); invalid JSON, HTTP 500, network error, timeout', async () => {
  for (const [mode, err] of [['400', /^HTTP 400: /], ['500', /^HTTP 500$/], ['badjson', /^invalid JSON$/], ['throw', /Failed to fetch/]]) {
    const { client, meteo, advance } = setup();
    await client.get({ city: 'Berlin', units: 'C' });
    advance(31 * MIN);
    meteo.setMode(mode);
    const st = await client.get({ city: 'Berlin', units: 'C' });
    assert.equal(st.status, 'stale', mode);
    assert.equal(st.stale, true);
    assert.match(st.error, err);
    assert.equal(st.data.temp, 6.9, 'the last good data is still shown');
    assert.equal(st.ageMs, 31 * MIN);
    assert.equal(st.nextRefreshAt, st.nextTryAt);
  }
  const { client, meteo } = setup({ mode: 'hang', timeoutMs: 20 });
  const st = await client.get({ city: 'Berlin', units: 'C' });
  assert.equal(st.status, 'error');
  assert.equal(st.error, 'request timed out after 0 s');
  assert.equal(meteo.calls[0].init.signal.aborted, true, 'the request was aborted');
  assert.equal(client.busy(), false);
});

test('client: offline -> STALE from the cache (or error without one) and no request', async () => {
  const { client, meteo, advance, setOnline } = setup();
  setOnline(false);
  const none = await client.get({ city: 'Berlin', units: 'C' });
  assert.equal(none.status, 'error');
  assert.equal(none.error, 'offline');
  assert.equal(meteo.calls.length, 0);
  setOnline(true);
  await client.get({ city: 'Berlin', units: 'C' });
  advance(45 * MIN);
  setOnline(false);
  const st = await client.get({ city: 'Berlin', units: 'C' });
  assert.equal(st.status, 'stale');
  assert.equal(st.error, 'offline');
  assert.equal(st.data.temp, 6.9);
  assert.equal(meteo.calls.length, 2);
});

test('client: a new local day refetches within the TTL (new sun times); no refetch loop afterwards', async () => {
  const { client, meteo, clock, advance } = setup({ start: new Date(2026, 10, 15, 23, 50).getTime() });
  const first = await client.get({ city: 'Berlin', units: 'C' });
  assert.equal(first.status, 'ok');
  assert.equal(first.nextRefreshAt, new Date(2026, 10, 16).getTime(), 'due at local midnight, before the TTL');
  advance(15 * MIN); // 00:05 on 2026-11-16
  assert.equal(S.today(first.data, new Date(clock.t)), null, 'yesterday\'s sun times are not used');
  const peek = await client.peek({ city: 'Berlin', units: 'C' });
  assert.equal(peek.status, 'stale', 'peek: a new day makes the cache due');
  const st = await client.get({ city: 'Berlin', units: 'C' });
  assert.equal(st.fetched, true);
  assert.deepEqual(meteo.calls.map((c) => c.url), [GEO_BERLIN, FC_BERLIN_C, FC_BERLIN_C]);
  const sun = S.today(st.data, new Date(clock.t));
  assert.ok(sun && Math.abs(sun.rise - (7 + 28 / 60 + 4 / 3600)) < 1e-9, 'today\'s sun times again');
  // A location whose day lags behind the computer's (another time zone): the refetch happens once, not in a loop.
  const lag = setup({ start: new Date(2026, 10, 15, 23, 50).getTime(), lagDays: 1 });
  await lag.client.get({ city: 'Berlin', units: 'C' });
  lag.advance(15 * MIN);
  await lag.client.get({ city: 'Berlin', units: 'C' });
  lag.advance(5 * MIN);
  const again = await lag.client.get({ city: 'Berlin', units: 'C' });
  assert.equal(again.fetched, false);
  assert.equal(lag.meteo.calls.length, 3);
  assert.equal(S.today(again.data, new Date(lag.clock.t)), null, 'that forecast is not today\'s: the theme keeps its hours');
});

test('client: one request in flight; concurrent gets are served in turn', async () => {
  const { client, meteo } = setup();
  const p1 = client.get({ city: 'Berlin', units: 'C' });
  assert.equal(client.busy(), false, 'the request starts on a later tick');
  const p2 = client.get({ city: 'Berlin', units: 'C' });
  const [a, b] = await Promise.all([p1, p2]);
  assert.equal(a.fetched, true);
  assert.equal(b.fetched, false, 'the second waited and got the cache');
  assert.equal(meteo.calls.length, 2);
});

test('client: storage adapters (localStorage-like, async get/set, failing, none) and bad stored data', async () => {
  // Async get/set (a chrome.storage.local wrapper).
  const bag = {};
  const asyncStore = { get: async (k) => bag[k], set: async (k, v) => { bag[k] = v; } };
  const a = setup({ storage: asyncStore });
  await a.client.get({ city: 'Berlin', units: 'C' });
  assert.equal(bag['pcd.weather'].v, 1);
  // A store that throws (quota, blocked): memory keeps working.
  const broken = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('quota'); } };
  const b = setup({ storage: broken });
  assert.equal((await b.client.get({ city: 'Berlin', units: 'C' })).status, 'ok');
  assert.equal((await b.client.get({ city: 'Berlin', units: 'C' })).fetched, false);
  // No storage at all.
  const c = setup({ storage: null });
  await c.client.get({ city: 'Berlin', units: 'C' });
  assert.equal((await c.client.get({ city: 'Berlin', units: 'C' })).fetched, false);
  // Garbage or an old shape in storage is ignored.
  for (const junk of ['{', '"x"', '[]', JSON.stringify({ v: 0, city: 'berlin' }), JSON.stringify({ v: 1, city: 'berlin', place: { latitude: 'x' }, data: null, fetchedAt: 0, fails: 0, nextTryAt: 0 })]) {
    const store = memoryStorage();
    store.setItem('pcd.weather', junk);
    const d = setup({ storage: store });
    const st = await d.client.get({ city: 'Berlin', units: 'C' });
    assert.equal(st.status, 'ok', junk);
    assert.equal(d.meteo.calls.length, 2, junk);
  }
});

test('client: peek() never fetches and reports the cache', async () => {
  const { client, meteo, advance } = setup();
  const before = await client.peek({ city: 'Berlin', units: 'C' });
  assert.equal(before.status, 'error');
  assert.equal(before.error, 'no data yet');
  await client.get({ city: 'Berlin', units: 'C' });
  assert.equal((await client.peek({ city: 'Berlin', units: 'C' })).status, 'ok');
  assert.equal((await client.peek({ city: 'Berlin', units: 'F' })).status, 'stale', 'other units: due');
  advance(31 * MIN);
  const late = await client.peek({ city: 'Berlin', units: 'C' });
  assert.equal(late.status, 'stale');
  assert.equal(late.error, 'refresh due');
  assert.equal((await client.peek({ city: 'Paris', units: 'C' })).status, 'error', 'another city has no data');
  assert.equal(meteo.calls.length, 2);
});

test('client: requests go only to the two Open-Meteo hosts; the city only to geocoding', async () => {
  const { client, meteo, advance } = setup();
  await client.get({ city: 'Berlin, DE', units: 'F' });
  advance(31 * MIN);
  await client.get({ city: 'Berlin, DE', units: 'F' });
  for (const { url } of meteo.calls) {
    const u = new URL(url);
    assert.ok(['geocoding-api.open-meteo.com', 'api.open-meteo.com'].includes(u.host), url);
    assert.equal(u.protocol, 'https:');
    if (u.host === 'api.open-meteo.com') assert.doesNotMatch(url, /berlin/i, 'forecasts carry coordinates only');
  }
});

test('the shipped file: classic UMD, PCD.weather, safe glyphs only, no BOM, LF, no module syntax', () => {
  const buf = fs.readFileSync(path.join(ROOT, 'src', 'shared', 'pcd-weather.js'));
  assert.notDeepEqual([...buf.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  const src = buf.toString('utf8');
  assert.ok(!src.includes('\r'));
  const nonAscii = [...new Set([...src].filter((ch) => ch.codePointAt(0) > 0x7e))];
  assert.deepEqual(nonAscii.sort(), [DOT, DEG].sort(), 'only the degree sign and the middle dot');
  assert.doesNotMatch(src, /^\s*(import|export)\s/m);
  assert.match(src, /module\.exports = api/);
  assert.equal(globalThis.PCD.weather, W);
  for (const host of src.match(/https:\/\/[a-z0-9.-]+/g)) {
    assert.ok(['https://geocoding-api.open-meteo.com', 'https://api.open-meteo.com', 'https://open-meteo.com'].includes(host), host);
  }
});
