// PCD_LIVE=1 node --test "tests/weather-live.test.mjs"
// Opt-in live check of src/shared/pcd-weather.js and pcd-sun.js against the real Open-Meteo, with the sample city
// Berlin only (never your configured city, never config/user.json). Skipped unless PCD_LIVE=1. About 6 requests.
// The computer's zone is pinned to Europe/Berlin so "today" is Berlin's day whatever the clock says here.
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
const skip = process.env.PCD_LIVE === '1' ? false : 'live Open-Meteo check: set PCD_LIVE=1 (Berlin only)';
const CITY = 'Berlin';

function client() {
  const seen = [];
  const c = W.createClient({ timeoutMs: 15000, fetch: (url, init) => { seen.push(url); return fetch(url, init); } });
  return { c, seen };
}

test('live: Berlin in C and F, exact URLs, units checked, today\'s sun times on Berlin\'s wall clock', { skip }, async () => {
  const { c, seen } = client();
  const st = await c.get({ city: CITY, units: 'C' });
  assert.equal(st.status, 'ok', st.error || '');
  assert.equal(st.place.country_code, 'DE');
  assert.ok(Math.abs(st.place.latitude - 52.52) < 0.1 && Math.abs(st.place.longitude - 13.41) < 0.1);
  assert.equal(seen[0], W.geocodeUrl(CITY));
  assert.equal(seen[1], W.forecastUrl(st.place.latitude, st.place.longitude, 'C'));
  const d = st.data;
  assert.ok(d.temp > -40 && d.temp < 45, `temp ${d.temp}`);
  assert.ok(W.KINDS.includes(d.kind) && d.kind !== 'unknown', `kind ${d.kind} (code ${d.code})`);
  for (const k of ['wind', 'windKmh', 'precip', 'cloud', 'high', 'low', 'day', 'sunrise', 'sunset', 'utcOffset', 'time']) {
    assert.equal(typeof d[k], 'number', k);
  }
  const sun = S.today(d, new Date());
  assert.ok(sun && sun.polar === null, 'Berlin always has a sunrise and a sunset');
  assert.ok(sun.rise > 4 && sun.rise < 9.5, `rise ${sun.rise}`);
  assert.ok(sun.set > 15.5 && sun.set < 22.5, `set ${sun.set}`);
  assert.equal(S.usable(sun), true);
  const f = await c.get({ city: CITY, units: 'F' });
  assert.equal(f.status, 'ok', f.error || '');
  assert.equal(seen[2], W.forecastUrl(st.place.latitude, st.place.longitude, 'F'));
  assert.ok(Math.abs(f.data.temp - (d.temp * 9 / 5 + 32)) < 4, `F ${f.data.temp} vs C ${d.temp}`);
  assert.ok(Math.abs(f.data.windKmh - d.windKmh) < 3, 'wind back in km/h');
  assert.deepEqual(S.today(f.data, new Date()), sun, 'the same sun times in both units');
});

test('live: "Berlin, DE" finds nothing as typed and is found by the countryCode retry', { skip }, async () => {
  const { c, seen } = client();
  const st = await c.get({ city: 'Berlin, DE', units: 'C' });
  assert.equal(st.status, 'ok', st.error || '');
  assert.equal(st.place.name, 'Berlin');
  assert.deepEqual(seen.slice(0, 2), [W.geocodeUrl('Berlin, DE'), W.geocodeUrl('Berlin', { countryCode: 'DE' })]);
});
