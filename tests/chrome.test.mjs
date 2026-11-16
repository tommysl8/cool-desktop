// node --test tests/chrome.test.mjs
// tools/lib/chrome.mjs and tools/lib/serve.mjs: the merged resolver rules, the mock forecast (sun fields), the
// privacy guard's decisions, and real headless runs (skipped without a browser): the temp profile is removed, a
// mapped probe host proves the rules, pixelclock.local does not resolve unless a mock clock is mapped, a request
// naming the config city is blocked (in a child process, with Open-Meteo also mapped to a local sink so nothing could
// leave even if the guard failed), mocked weather reaches the page, a real device scale factor, loadUnpacked.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  CLOCK_HOST, CONFIG_FILE, GUARD_CITIES_ENV, MOCK_PLACE, MOCK_WEATHER, PASS_HOSTS, SAMPLE_CITY, WeatherGuard, berlinOffset, cityNeedle, findBrowser,
  forecastCoordsProblem, isSampleCity, launch, mockForecast, mockWeatherResponse, networkArgs, planFromEntries, privacyPlan,
  processesWithMarker, redactCoords, resolverRules, screenshotCli, sunTimes,
} from '../tools/lib/chrome.mjs';
import { serve } from '../tools/lib/serve.mjs';
import { decodePng, pixelAt, pngSize } from '../tools/lib/png.mjs';
import { makeTempDir, rmrf, sleep } from '../tools/lib/fsx.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const browser = findBrowser();
const SKIP = browser ? false : 'no Chrome or Edge installed: browser checks skipped';
const T = { timeout: 180000 };
const CONFIG_PATH = path.join(ROOT, 'config', 'user.json');
const CONFIG = fs.existsSync(CONFIG_PATH) ? JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) : null;
const NEEDLE = CONFIG && typeof CONFIG.city === 'string' ? cityNeedle(CONFIG.city) : ''; // never printed
/** The config-city checks need a city of your own in config/user.json (not on a fresh clone, not the sample Berlin). */
const NO_CITY = NEEDLE && !isSampleCity(CONFIG.city) ? false : 'config/user.json has no city of your own (a fresh clone or the sample Berlin): the config-city checks skip';
const FORECAST = (lat, lon, f) => `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,apparent_temperature,weather_code,wind_speed_10m,precipitation,cloud_cover,is_day&daily=temperature_2m_max,temperature_2m_min,sunrise,sunset&timezone=auto&timeformat=unixtime&forecast_days=1${f ? '&temperature_unit=fahrenheit&wind_speed_unit=mph' : ''}`;
const temps = [];
let site;
let server;

const PAGES = {
  'index.html': '<!doctype html><html><head><meta charset="utf-8"><title>ok</title><style>html,body{margin:0;height:100%;background:#141016;color:#ece4d8}</style></head><body></body></html>\n',
  'errors.html': '<!doctype html><html><head><meta charset="utf-8"><title>errors</title><script src="missing.js"></script></head><body><script src="errors.js"></script></body></html>\n',
  'errors.js': 'console.error("harness-console-error");\nsetTimeout(function () { throw new Error("harness-exception"); }, 0);\n',
  'box.html': '<!doctype html><html><head><meta charset="utf-8"><title>box</title><style>html,body{margin:0;background:#000}canvas{position:absolute;left:10px;top:5px;width:320px;height:320px;image-rendering:pixelated}</style></head><body><canvas id="c" width="64" height="64"></canvas></body></html>\n',
};

test.before(async () => {
  site = makeTempDir('pcd-chrometest-site-');
  for (const [name, text] of Object.entries(PAGES)) fs.writeFileSync(path.join(site, name), text);
  server = await serve(site);
});

test.after(async () => {
  if (server) await server.close();
  if (site) await rmrf(site);
  for (const d of temps) await rmrf(d);
});

const exited = (child) => child.exitCode !== null || child.signalCode !== null;

async function eventually(fn, { timeoutMs = 30000, intervalMs = 250 } = {}) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    if (await fn()) return true;
    if (Date.now() > end) return false;
    await sleep(intervalMs);
  }
}

/** A TCP server on 127.0.0.1 that counts connections and closes each at once (it never reads a byte). */
async function tcpSink() {
  const sink = { connections: 0 };
  const srv = net.createServer((s) => { sink.connections++; s.on('error', () => {}); s.destroy(); });
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  sink.port = srv.address().port;
  sink.close = () => new Promise((resolve) => srv.close(() => resolve()));
  return sink;
}

// ---------------------------------------------------------------------------------------------
// no browser

test('serve.mjs: 127.0.0.1 on a random port, content types, 403/404/405, HEAD, favicon 204', async () => {
  const dir = makeTempDir('pcd-servetest-');
  temps.push(dir);
  const files = { 'index.html': 'home', 'a.js': 'js', 's.css': 'css', 'x.json': '{}', 'f.ttf': 'ttf', 'i.png': 'png' };
  for (const [n, v] of Object.entries(files)) fs.writeFileSync(path.join(dir, n), v);
  const secret = path.join(path.dirname(dir), `${path.basename(dir)}-secret.txt`);
  fs.writeFileSync(secret, 'secret');
  const srv = await serve(dir);
  try {
    assert.match(srv.url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
    assert.equal(srv.server.address().address, '127.0.0.1');
    const expect = { 'index.html': 'text/html; charset=utf-8', 'a.js': 'text/javascript; charset=utf-8', 's.css': 'text/css; charset=utf-8', 'x.json': 'application/json; charset=utf-8', 'f.ttf': 'font/ttf', 'i.png': 'image/png' };
    for (const [n, type] of Object.entries(expect)) {
      const r = await fetch(srv.url + n);
      assert.equal(r.status, 200, n);
      assert.equal(r.headers.get('content-type'), type, n);
      assert.equal(r.headers.get('cache-control'), 'no-store');
      assert.equal(await r.text(), files[n]);
    }
    assert.equal(await (await fetch(srv.url)).text(), 'home');
    assert.equal((await fetch(srv.url + 'missing.txt')).status, 404);
    assert.equal((await fetch(srv.url + `..%5C${path.basename(dir)}-secret.txt`)).status, 403);
    assert.equal((await fetch(srv.url + 'a.js', { method: 'POST' })).status, 405);
    assert.equal((await fetch(srv.url + 'f.ttf', { method: 'HEAD' })).headers.get('content-length'), '3');
    assert.equal((await fetch(srv.url + 'favicon.ico')).status, 204);
  } finally {
    await srv.close();
    fs.rmSync(secret, { force: true });
  }
});

test('resolverRules: one flag, pixelclock.local first (~NOTFOUND or the mock port), MAP * ~NOTFOUND, loopback and Open-Meteo excluded', () => {
  assert.equal(resolverRules(), 'MAP pixelclock.local ~NOTFOUND,MAP * ~NOTFOUND,EXCLUDE 127.0.0.1,EXCLUDE localhost,EXCLUDE api.open-meteo.com,EXCLUDE geocoding-api.open-meteo.com');
  assert.deepEqual(PASS_HOSTS, ['127.0.0.1', 'localhost', 'api.open-meteo.com', 'geocoding-api.open-meteo.com']);
  assert.equal(CLOCK_HOST, 'pixelclock.local');
  assert.equal(resolverRules({ clockPort: 8123, rules: ['MAP probe.pcd.test 127.0.0.1'] }),
    'MAP pixelclock.local 127.0.0.1:8123,MAP probe.pcd.test 127.0.0.1,MAP * ~NOTFOUND,EXCLUDE 127.0.0.1,EXCLUDE localhost,EXCLUDE api.open-meteo.com,EXCLUDE geocoding-api.open-meteo.com');
  // A sink for Open-Meteo: its EXCLUDE rules must go (Chrome applies EXCLUDE before MAP).
  assert.equal(resolverRules({ rules: 'MAP *.open-meteo.com 127.0.0.1:9, MAP open-meteo.com 127.0.0.1:9' }),
    'MAP pixelclock.local ~NOTFOUND,MAP *.open-meteo.com 127.0.0.1:9,MAP open-meteo.com 127.0.0.1:9,MAP * ~NOTFOUND,EXCLUDE 127.0.0.1,EXCLUDE localhost');
  assert.equal(resolverRules({ weatherLocal: true }),
    'MAP pixelclock.local ~NOTFOUND,MAP api.open-meteo.com 127.0.0.1,MAP geocoding-api.open-meteo.com 127.0.0.1,MAP *.open-meteo.com 127.0.0.1,MAP open-meteo.com 127.0.0.1,MAP * ~NOTFOUND,EXCLUDE 127.0.0.1,EXCLUDE localhost');
  assert.throws(() => resolverRules({ rules: ['EXCLUDE example.com'] }), /caller EXCLUDE rules are not allowed/);
  assert.throws(() => resolverRules({ rules: ['MAP x.test 93.184.215.14'] }), /must be ~NOTFOUND or a loopback address/);
  assert.throws(() => resolverRules({ rules: ['MAP pixelclock.local 127.0.0.1:80'] }), /mapped by the clock option only/);
  assert.throws(() => resolverRules({ rules: ['MAP *.local 127.0.0.1'] }), /mapped by the clock option only/);
  assert.throws(() => resolverRules({ rules: ['RULE x'] }), /unsupported rule/);
  assert.throws(() => resolverRules({ clockPort: 70000 }), /clockPort must be a TCP port/);
  const args = networkArgs(['--hide-scrollbars', '--host-resolver-rules=MAP a.test 127.0.0.1', '--no-proxy-server', '--host-resolver-rules=MAP b.test ~NOTFOUND'], { clockPort: 5555 });
  assert.equal(args.filter((a) => a.startsWith('--host-resolver-rules=')).length, 1, 'merged into one flag');
  assert.equal(args.filter((a) => a === '--no-proxy-server').length, 1);
  assert.match(args.find((a) => a.startsWith('--host-resolver-rules=')), /^--host-resolver-rules=MAP pixelclock\.local 127\.0\.0\.1:5555,MAP a\.test 127\.0\.0\.1,MAP b\.test ~NOTFOUND,MAP \* ~NOTFOUND,/);
  assert.equal(args[0], '--hide-scrollbars');
});

test('mock forecast: the live shape (2026-11-15, Berlin) with daily sunrise/sunset in unixtime, precipitation and cloud cover; overrides for current and the daily high and low', () => {
  const now = Date.UTC(2026, 10, 15, 22, 35);
  const r = mockWeatherResponse(FORECAST(52.52437, 13.41053, true), { now });
  assert.equal(r.status, 200);
  assert.deepEqual(r.headers.find((h) => h.name === 'Access-Control-Allow-Origin'), { name: 'Access-Control-Allow-Origin', value: '*' });
  const f = JSON.parse(r.body);
  assert.equal(f.utc_offset_seconds, 3600);
  assert.equal(f.timezone, 'Europe/Berlin');
  assert.deepEqual(f.current_units, { time: 'unixtime', interval: 'seconds', temperature_2m: '°F', apparent_temperature: '°F', weather_code: 'wmo code', wind_speed_10m: 'mp/h', precipitation: 'mm', cloud_cover: '%', is_day: '' });
  assert.deepEqual(Object.keys(f.current), ['time', 'interval', 'temperature_2m', 'apparent_temperature', 'weather_code', 'wind_speed_10m', 'precipitation', 'cloud_cover', 'is_day']);
  assert.equal(f.current.time, 1794781800, 'the 15-minute slot, in unix seconds');
  assert.equal(f.current.is_day, 0, '23:35 in Berlin');
  assert.equal(typeof f.current.precipitation, 'number');
  assert.equal(typeof f.current.cloud_cover, 'number');
  assert.deepEqual(f.daily_units, { time: 'unixtime', temperature_2m_max: '°F', temperature_2m_min: '°F', sunrise: 'unixtime', sunset: 'unixtime' });
  assert.deepEqual(f.daily.time, [1794697200], 'local midnight');
  // Live Open-Meteo for this day said sunrise 1794724084 (07:28 CET) and sunset 1794755589 (16:13 CET).
  assert.ok(Math.abs(f.daily.sunrise[0] - 1794724084) <= 180, `sunrise ${f.daily.sunrise[0]}`);
  assert.ok(Math.abs(f.daily.sunset[0] - 1794755589) <= 180, `sunset ${f.daily.sunset[0]}`);
  assert.ok(f.daily.time[0] < f.daily.sunrise[0] && f.daily.sunrise[0] < f.daily.sunset[0] && f.daily.sunset[0] < f.daily.time[0] + 86400);
  const c = JSON.parse(mockWeatherResponse(FORECAST(52.52, 13.41, false), { now }).body);
  assert.equal(c.current_units.temperature_2m, '°C');
  assert.equal(c.current_units.wind_speed_10m, 'km/h');
  const iso = mockForecast({ units: 'C', now: Date.UTC(2026, 5, 21, 10, 0) });
  assert.equal(iso.utc_offset_seconds, 7200, 'CEST in June');
  assert.equal(iso.daily.time[0], '2026-06-21');
  assert.match(iso.daily.sunrise[0], /^2026-06-21T04:4\d$/);
  assert.match(iso.daily.sunset[0], /^2026-06-21T21:3\d$/);
  assert.equal(iso.current.is_day, 1);
  const rainy = mockForecast({ units: 'C', now, overrides: { weather_code: 63, precipitation: 4.2 } });
  assert.deepEqual([rainy.current.weather_code, rainy.current.precipitation], [63, 4.2]);
  assert.deepEqual([rainy.daily.temperature_2m_max[0], rainy.daily.temperature_2m_min[0]], [MOCK_WEATHER.C.max, MOCK_WEATHER.C.min], 'the canned high and low by default');
  // max and min set the day's high and low, and never show up in current
  const snowy = mockForecast({ units: 'C', now, overrides: { temperature_2m: 1, weather_code: 73, max: 2, min: -3 } });
  assert.deepEqual([snowy.current.temperature_2m, snowy.daily.temperature_2m_max[0], snowy.daily.temperature_2m_min[0]], [1, 2, -3]);
  assert.deepEqual(Object.keys(snowy.current), Object.keys(rainy.current), 'max and min are not current fields');
  const viaUrl = JSON.parse(mockWeatherResponse(FORECAST(52.52, 13.41, true), { now, overrides: { max: 50, min: 41 } }).body);
  assert.deepEqual([viaUrl.daily.temperature_2m_max[0], viaUrl.daily.temperature_2m_min[0]], [50, 41]);
  assert.equal(viaUrl.current.temperature_2m, MOCK_WEATHER.F.temperature_2m, 'the rest stays canned');
  assert.ok(!('max' in viaUrl.current) && !('min' in viaUrl.current));
  const bad = mockWeatherResponse(FORECAST(52.5, 13.4, false).replace('cloud_cover', 'cloud_cover_typo'), { now });
  assert.equal(bad.status, 400);
  assert.equal(JSON.parse(bad.body).error, true);
  const geo = JSON.parse(mockWeatherResponse('https://geocoding-api.open-meteo.com/v1/search?name=Berlin&count=1&language=en&format=json').body);
  assert.equal(geo.results[0].name, 'Berlin');
  assert.equal(geo.results[0].latitude, MOCK_PLACE.latitude);
  assert.equal(JSON.parse(mockWeatherResponse('https://geocoding-api.open-meteo.com/v1/search?name=Nowhere').body).results, undefined);
  assert.equal(mockWeatherResponse('https://open-meteo.com/en/terms').status, 404);
  assert.deepEqual([berlinOffset(Date.UTC(2026, 2, 29, 0, 59)), berlinOffset(Date.UTC(2026, 2, 29, 1, 0)), berlinOffset(Date.UTC(2026, 9, 25, 0, 59)), berlinOffset(Date.UTC(2026, 9, 25, 1, 0))], [3600, 7200, 7200, 3600]);
  const s = sunTimes(1794697200);
  assert.ok(s.sunrise < s.sunset);
});

const guardReq = (url, extra = {}) => ({ url, method: 'GET', headers: {}, ...extra });
const geoUrl = (name) => `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(name)}&count=1&language=en&format=json`;

test('guard decisions: live forecasts must be near Berlin; live geocoding only Berlin; mock answers; an added city is blocked', () => {
  const FAKE = 'Zzyzxville, QQ';
  const plan = privacyPlan({ cities: [FAKE] });
  assert.equal(plan.active, true, 'an added city turns the guard on');
  assert.ok(plan.needles.some((n) => !n.real && n.source === 'injected city' && n.needle === 'zzyzxville'));
  assert.equal(isSampleCity(SAMPLE_CITY), true);
  const conn = { pages: new Set(), send: async () => ({}) };
  const live = new WeatherGuard(conn, plan, { mode: 'live', mock: {} });
  const mock = new WeatherGuard(conn, plan, { mode: 'mock', mock: {} });
  const fakeUrl = geoUrl(FAKE);
  assert.deepEqual(live.verdict(guardReq(fakeUrl), fakeUrl), { reason: 'city', source: 'injected city', real: false });
  assert.equal(mock.verdict(guardReq(fakeUrl), fakeUrl).reason, 'city', 'blocked in mock mode too');
  const viaBody = 'https://api.open-meteo.com/v1/forecast?latitude=52.5&longitude=13.4';
  assert.equal(live.verdict(guardReq(viaBody, { method: 'POST', postData: 'q=ZZYZXVILLE' }), viaBody).reason, 'city');
  assert.equal(live.verdict(guardReq(FORECAST(52.52437, 13.41053, true)), FORECAST(52.52437, 13.41053, true)), null, 'Berlin continues');
  assert.equal(live.verdict(guardReq(geoUrl('Berlin')), geoUrl('Berlin')), null);
  const far = FORECAST(45.52, -122.68, true);
  assert.deepEqual(live.verdict(guardReq(far), far), { reason: 'coords', source: 'coordinates more than 1 degree from Berlin', real: true });
  assert.equal(live.verdict(guardReq('https://api.open-meteo.com/v1/forecast?current=is_day'), 'https://api.open-meteo.com/v1/forecast?current=is_day').reason, 'coords', 'no coordinates at all');
  assert.equal(mock.verdict(guardReq(far), far), null, 'mock mode answers locally, nothing leaves');
  assert.deepEqual(live.verdict(guardReq(geoUrl('Paris')), geoUrl('Paris')), { reason: 'sample-only', source: 'live geocoding may only look up Berlin', real: false });
  assert.equal(forecastCoordsProblem(FORECAST(53.4, 12.5, false)), null, 'within 1 degree');
  assert.match(forecastCoordsProblem('https://api.open-meteo.com/v1/forecast?latitude=52.5,45.5&longitude=13.4,-122.7'), /more than 1 degree/);
  assert.equal(redactCoords('https://x/f?latitude=45.52&longitude=-122.68&a=1'), 'https://x/f?latitude=[lat]&longitude=[lon]&a=1');
  const blockAll = new WeatherGuard(conn, planFromEntries([{ source: 'config/user.json', real: true, error: 'unreadable' }]), { mode: 'live', mock: {} });
  assert.equal(blockAll.verdict(guardReq(geoUrl('Berlin')), geoUrl('Berlin')).reason, 'config', 'fail closed');
  assert.equal(GUARD_CITIES_ENV, 'PCD_GUARD_CITIES');
  assert.equal(CONFIG_FILE, path.join(ROOT, 'config', 'user.json'));
});

test('guard plan: no config/user.json needs no guard; an unreadable one blocks everything; an empty or sample city is not guarded', () => {
  assert.deepEqual(planFromEntries([{ source: 'config/user.json', real: true, city: '' }]), { active: false, blockAll: false, needles: [], error: null });
  assert.deepEqual(planFromEntries([{ source: 'config/user.json', real: true, city: 'berlin, DE' }]), { active: false, blockAll: false, needles: [], error: null });
  const broken = planFromEntries([{ source: 'config/user.json', real: true, error: 'cannot read it' }]);
  assert.deepEqual([broken.active, broken.blockAll], [true, true]);
  const dir = makeTempDir('pcd-chrometest-plan-');
  temps.push(dir);
  assert.throws(() => privacyPlan({ configPath: path.join(dir, 'missing.json') }), /privacy guard: injected config missing\.json: cannot read/, 'a missing injected config is a broken test setup');
  fs.writeFileSync(path.join(dir, 'bad.json'), '{ "city": ');
  assert.throws(() => privacyPlan({ configPath: path.join(dir, 'bad.json') }), /privacy guard: injected config bad\.json: cannot read/);
});

test('guard decisions: the config city is always blocked, in live and in mock mode', { skip: NO_CITY }, () => {
  const plan = privacyPlan();
  assert.equal(plan.active, true, 'config/user.json names a city other than Berlin: the guard is on');
  assert.ok(plan.needles.some((n) => n.real && n.source === 'config/user.json'));
  const conn = { pages: new Set(), send: async () => ({}) };
  const live = new WeatherGuard(conn, plan, { mode: 'live', mock: {} });
  const mock = new WeatherGuard(conn, plan, { mode: 'mock', mock: {} });
  const cityUrl = geoUrl(CONFIG.city);
  assert.equal(live.verdict(guardReq(cityUrl), cityUrl).reason, 'city');
  assert.equal(live.verdict(guardReq(cityUrl), cityUrl).real, true);
  assert.equal(mock.verdict(guardReq(cityUrl), cityUrl).reason, 'city', 'blocked in mock mode too');
  const viaBody = 'https://api.open-meteo.com/v1/forecast?latitude=52.5&longitude=13.4';
  assert.equal(live.verdict(guardReq(viaBody, { method: 'POST', postData: `q=${encodeURIComponent(CONFIG.city.toUpperCase())}` }), viaBody).reason, 'city');
});

/** A child process that feeds one request ('city', 'coords' or 'sample') through a live guard: { code, out, err, raw }. */
function guardChild() {
  const dir = makeTempDir('pcd-chrometest-exit-');
  temps.push(dir);
  const script = path.join(dir, 'case.mjs');
  fs.writeFileSync(script, [
    `import fs from 'node:fs';`,
    `import { WeatherGuard, privacyPlan } from ${JSON.stringify(pathToFileURL(path.join(ROOT, 'tools', 'lib', 'chrome.mjs')).href)};`,
    'const sent = [];',
    'const conn = { pages: new Set(), send: async (method) => { sent.push(method); return {}; } };',
    "const g = new WeatherGuard(conn, privacyPlan(), { mode: 'live', mock: {} });",
    "const which = process.argv[2];",
    `const city = which === 'city' ? JSON.parse(fs.readFileSync(${JSON.stringify(CONFIG_FILE)}, 'utf8')).city : '';`,
    "const url = which === 'city' ? 'https://geocoding-api.open-meteo.com/v1/search?name=' + encodeURIComponent(city) + '&count=1' : which === 'coords' ? 'https://api.open-meteo.com/v1/forecast?latitude=45.52&longitude=-122.68&current=is_day' : 'https://geocoding-api.open-meteo.com/v1/search?name=Paris';",
    "g.paused('S', { requestId: 'r1', request: { url, method: 'GET', headers: {} }, frameId: 'F' });",
    "g.paused('S', { requestId: 'r2', request: { url: 'https://api.open-meteo.com/v1/forecast?latitude=52.52&longitude=13.41&current=is_day', method: 'GET', headers: {} }, frameId: 'F' });",
    "setTimeout(() => { console.log(JSON.stringify({ sent, violations: g.violations.map((v) => ({ reason: v.reason, url: v.url, real: v.real })) })); process.exitCode = 0; }, 20);",
    '',
  ].join('\n'));
  return (which) => {
    const r = spawnSync(process.execPath, [script, which], { encoding: 'utf8', timeout: 60000 });
    return { code: r.status, out: JSON.parse(r.stdout.trim()), err: r.stderr, raw: r.stdout + r.stderr };
  };
}

test('real violations force exit code 1 (child process): far coordinates, redacted in the logs; a non-sample geocode is not a real one', () => {
  const run = guardChild();
  const coords = run('coords');
  assert.equal(coords.code, 1);
  assert.deepEqual(coords.out.sent, ['Fetch.failRequest', 'Fetch.continueRequest']);
  assert.deepEqual(coords.out.violations.map((v) => [v.reason, v.real]), [['coords', true]]);
  assert.match(coords.out.violations[0].url, /latitude=\[lat\]&longitude=\[lon\]/);
  assert.doesNotMatch(coords.raw, /45\.52|-122\.68/, 'coordinates are redacted');
  assert.match(coords.err, /\[privacy-guard\] exit code 1/);
  const sample = run('sample');
  assert.equal(sample.code, 0, 'a non-sample test city is a violation but not a real one');
  assert.deepEqual(sample.out.violations.map((v) => [v.reason, v.real]), [['sample-only', false]]);
});

test('real violations force exit code 1 (child process): the config city, never in any output', { skip: NO_CITY }, () => {
  const city = guardChild()('city');
  assert.equal(city.code, 1);
  assert.deepEqual(city.out.sent, ['Fetch.failRequest', 'Fetch.continueRequest']);
  assert.deepEqual(city.out.violations.map((v) => [v.reason, v.real]), [['city', true]]);
  assert.match(city.out.violations[0].url, /name=\[city\]/);
  assert.equal(city.raw.toLowerCase().includes(NEEDLE), false, 'the city never appears in any output');
  assert.match(city.err, /\[privacy-guard\] exit code 1/);
});

// ---------------------------------------------------------------------------------------------
// real browser

test('launch: one merged resolver flag and --no-proxy-server; evaluate; screenshot; the temp profile is removed', { ...T, skip: SKIP }, async (t) => {
  const b = await launch();
  let closed;
  try {
    t.diagnostic(`product ${b.version.product}`);
    assert.match(b.version.product, /Chrome\/|Edg\//);
    assert.equal(b.args.filter((a) => a.startsWith('--host-resolver-rules=')).length, 1);
    assert.ok(b.args.includes('--no-proxy-server'));
    assert.equal(b.resolverRules, resolverRules());
    assert.match(path.basename(b.userDataDir), /^pcd-headless-/);
    assert.equal(b.privacy.active, privacyPlan().active);
    if (NO_CITY === false) assert.equal(b.privacy.active, true, 'a city of your own in config/user.json turns the guard on');
    if (NEEDLE) assert.equal(JSON.stringify(b.privacy).toLowerCase().includes(NEEDLE), false, 'the summary never names the city');
    const page = await b.newPage(server.url + 'index.html');
    await page.setViewport(1280, 800, 1);
    assert.deepEqual(await page.evaluate('({ w: innerWidth, h: innerHeight })'), { w: 1280, h: 800 });
    assert.equal(await page.evaluate((a, c) => a + c, 2, 3), 5);
    const img = decodePng(await page.screenshot());
    assert.deepEqual(pixelAt(img, 640, 400).slice(0, 3), [0x14, 0x10, 0x16], 'sRGB-exact colours');
    assert.deepEqual(page.errors, []);
  } finally {
    closed = await b.close();
  }
  assert.equal(closed.cleaned, true);
  assert.equal(fs.existsSync(b.userDataDir), false, 'temp profile deleted');
  assert.ok(await eventually(() => exited(b.process)), 'browser process exited');
  if (process.platform === 'win32') assert.ok(await eventually(() => processesWithMarker(path.basename(b.userDataDir)).length === 0), 'no process carries the profile marker');
});

test('a mapped probe host proves the resolver rules; other hosts and pixelclock.local do not resolve', { ...T, skip: SKIP }, async () => {
  const b = await launch({ rules: ['MAP probe.pcd.test 127.0.0.1'] });
  try {
    const page = await b.newPage();
    await page.goto(`http://probe.pcd.test:${server.port}/index.html`, { timeoutMs: 15000 });
    assert.equal(await page.evaluate('document.title'), 'ok', 'the mapped probe host reached the local server');
    for (const url of ['https://example.com/', 'http://pixelclock.local/api/status', 'https://pixelclock.local/', 'http://neverssl.com/']) {
      const r = await page.send('Page.navigate', { url });
      assert.equal(r.errorText, 'net::ERR_NAME_NOT_RESOLVED', url);
    }
  } finally {
    await b.close();
  }
});

test('launch({ clock: port }) maps pixelclock.local to a mock clock on 127.0.0.1', { ...T, skip: SKIP }, async () => {
  const seen = [];
  const clock = http.createServer((req, res) => {
    seen.push({ method: req.method, url: req.url, host: req.headers.host });
    if (req.url === '/api/status') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ api: 1, alarm: { state: 'none', label: '', until: null, next: null }, time: { known: true } }));
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((resolve) => clock.listen(0, '127.0.0.1', resolve));
  const b = await launch({ clock: clock.address().port });
  try {
    assert.match(b.resolverRules, new RegExp(`^MAP pixelclock\\.local 127\\.0\\.0\\.1:${clock.address().port},`));
    const page = await b.newPage();
    await page.goto('http://pixelclock.local/api/status', { timeoutMs: 15000 });
    const body = JSON.parse(await page.evaluate("(document.querySelector('pre') || document.body).textContent"));
    assert.equal(body.api, 1);
    assert.ok(seen.some((s) => s.method === 'GET' && s.url === '/api/status' && s.host === 'pixelclock.local'), JSON.stringify(seen));
  } finally {
    await b.close();
    await new Promise((resolve) => clock.close(resolve));
  }
});

test('a request naming the config city is blocked before it leaves (child process; Open-Meteo also mapped to a sink)', { ...T, skip: SKIP || NO_CITY }, async () => {
  const dir = makeTempDir('pcd-chrometest-city-');
  temps.push(dir);
  const script = path.join(dir, 'city.mjs');
  fs.writeFileSync(script, [
    "import fs from 'node:fs';",
    "import net from 'node:net';",
    `import { launch } from ${JSON.stringify(pathToFileURL(path.join(ROOT, 'tools', 'lib', 'chrome.mjs')).href)};`,
    `const city = JSON.parse(fs.readFileSync(${JSON.stringify(CONFIG_FILE)}, 'utf8')).city;`,
    'const sink = { connections: 0 };',
    "const srv = net.createServer((s) => { sink.connections++; s.on('error', () => {}); s.destroy(); });",
    "await new Promise((r) => srv.listen(0, '127.0.0.1', r));",
    'const port = srv.address().port;',
    "const b = await launch({ rules: [`MAP *.open-meteo.com 127.0.0.1:${port}`, `MAP open-meteo.com 127.0.0.1:${port}`] });",
    'let result;',
    'try {',
    '  const page = await b.newPage();',
    "  result = await page.evaluate((c) => fetch('https://geocoding-api.open-meteo.com/v1/search?name=' + encodeURIComponent(c) + '&count=1&language=en&format=json').then(() => 'sent', (e) => 'failed: ' + e.name), city);",
    '  await new Promise((r) => setTimeout(r, 300));',
    '} finally {',
    '  await b.close();',
    '}',
    'await new Promise((r) => srv.close(r));',
    'console.log(JSON.stringify({ result, sink: sink.connections, violations: b.violations.map((v) => ({ reason: v.reason, real: v.real, url: v.url })), requests: b.weatherRequests.map((r) => r.action) }));',
    'process.exitCode = 0;',
    '',
  ].join('\n'));
  const r = spawnSync(process.execPath, [script], { encoding: 'utf8', timeout: 120000 });
  const raw = `${r.stdout}\n${r.stderr}`;
  if (NEEDLE) assert.equal(raw.toLowerCase().includes(NEEDLE), false, 'the city appears in no output');
  assert.equal(r.status, 1, 'a real violation forces exit code 1');
  const out = JSON.parse(r.stdout.trim().split(/\r?\n/).pop());
  assert.match(out.result, /^failed: TypeError/);
  assert.equal(out.sink, 0, 'nothing reached even the local sink');
  assert.deepEqual(out.violations.map((v) => [v.reason, v.real]), [['city', true]]);
  assert.match(out.violations[0].url, /^https:\/\/geocoding-api\.open-meteo\.com\/v1\/search\?name=\[city\]/, 'recorded decoded, the city name as [city]');
  assert.deepEqual(out.requests, ['blocked']);
  assert.match(r.stderr, /\[privacy-guard\] BLOCKED \(never sent\): GET https:\/\/geocoding-api\.open-meteo\.com\/v1\/search\?name=\[city\]/);
});

test('guard (injected made-up cities): every way a page can send a city is blocked before it leaves; the rest continues', { ...T, skip: SKIP }, async () => {
  const FAKE = 'Zzyzxville, QQ';
  const FAKE2 = 'Lake  Qqmoorvale';
  const geo = (name, mark) => `https://geocoding-api.open-meteo.com/v1/search?name=${name}&count=1&language=en&format=json&k=${mark}`;
  const dir = makeTempDir('pcd-chrometest-guard-');
  temps.push(dir);
  const files = {
    'page.html': '<!doctype html><html><head><meta charset="utf-8"><title>guard</title></head><body>guard test</body></html>\n',
    'early.html': '<!doctype html><html><head><meta charset="utf-8"><title>early</title>'
      + `<script>window.__early = fetch(${JSON.stringify(geo('Zzyzxville', 'early-fetch'))}).then(function () { return 'sent'; }, function (e) { return 'failed: ' + e.message; });</script>`
      + `</head><body><img alt="" src="${geo('Zzyzxville', 'early-img')}"></body></html>\n`,
    'popup.html': `<!doctype html><html><head><meta charset="utf-8"><title>popup</title><script>fetch(${JSON.stringify(geo('Zzyzxville', 'popup'))}).catch(function () {});</script></head><body></body></html>\n`,
    'worker.js': `fetch(${JSON.stringify(geo('Zzyzxville', 'worker'))}).then(function () { postMessage('sent'); }, function (e) { postMessage('failed: ' + e.message); });\n`,
  };
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text);
  const srv = await serve(dir);
  const sink = await tcpSink();
  const savedErr = console.error;
  const errLines = [];
  console.error = (...a) => errLines.push(a.map(String).join(' '));
  const savedExit = process.exitCode;
  const b = await launch({ privacy: { config: { city: FAKE }, cities: [FAKE2] }, rules: [`MAP *.open-meteo.com 127.0.0.1:${sink.port}`, `MAP open-meteo.com 127.0.0.1:${sink.port}`] });
  try {
    assert.ok(b.privacy.sources.includes('injected config') && b.privacy.sources.includes('injected city'));
    const page = await b.newPage(srv.url + 'page.html?from=Zzyzxville');
    const fetches = await page.evaluate(async (urls) => {
      const out = {};
      for (const [k, u, init] of urls) out[k] = await fetch(u, init || {}).then(() => 'sent', (e) => 'failed: ' + e.message);
      return out;
    }, [
      ['encoded', geo(encodeURIComponent(FAKE), 'encoded')],
      ['upper', geo('ZZYZXVILLE', 'upper')],
      ['double', geo('%255A%257A%2579%257A%2578%2576%2569%256C%256C%2565', 'double')],
      ['plus', geo('Lake+Qqmoorvale', 'plus')],
      ['post', 'https://api.open-meteo.com/v1/forecast?k=post', { method: 'POST', body: 'city=Zzyzxville' }],
      ['referer', 'https://api.open-meteo.com/v1/forecast?latitude=52.5&longitude=13.4&k=referer', { referrerPolicy: 'unsafe-url' }],
    ]);
    for (const [k, v] of Object.entries(fetches)) assert.match(v, /^failed: /, `${k}: ${v}`);
    await page.evaluate(`(() => { const i = new Image(); i.src = ${JSON.stringify(geo('Zzyzxville', 'img'))}; document.body.appendChild(i);
      navigator.sendBeacon(${JSON.stringify('https://api.open-meteo.com/v1/forecast?city=Zzyzxville&k=beacon')}, 'x');
      window.open(${JSON.stringify(srv.url + 'popup.html')}, '_blank'); return 1; })()`);
    const worker = await page.evaluate("new Promise((res) => { const w = new Worker('worker.js'); w.onmessage = (e) => res(e.data); setTimeout(() => res('timeout'), 8000); })");
    assert.match(worker, /^failed: /, `worker: ${worker}`);
    const early = await b.newPage(srv.url + 'early.html', { create: true });
    assert.match(await early.evaluate('window.__early'), /^failed: /, 'a page created with its URL is guarded from its first script');
    const marks = ['encoded', 'upper', 'double', 'plus', 'post', 'referer', 'img', 'beacon', 'popup', 'worker', 'early-fetch', 'early-img'];
    const end = Date.now() + 45000;
    while (!marks.every((m) => b.violations.some((v) => v.url.includes('k=' + m))) && Date.now() < end) await sleep(100);
    assert.deepEqual(marks.filter((m) => !b.violations.some((v) => v.url.includes('k=' + m))), [], 'every way was blocked');
    await sleep(300);
    assert.equal(sink.connections, 0, 'nothing reached the network (the sink saw no connection)');
    assert.ok(b.violations.every((v) => v.reason === 'city' && !/zzyzx|qqmoorvale/i.test(v.url)), 'recorded with the city redacted');
    assert.ok(page.errors.some((e) => e.type === 'privacy' && /BLOCKED \(never sent\)/.test(e.text)));
    assert.equal(process.exitCode, savedExit, 'injected (test) cities do not set the exit code');
    assert.throws(() => b.assertNoViolations(), /privacy guard: \d+ Open-Meteo request\(s\) were blocked/);
    const other = await page.evaluate(`fetch(${JSON.stringify(FORECAST(52.52437, 13.41053, true))}).then(() => 'answered', (e) => 'failed: ' + e.message)`);
    const until = Date.now() + 20000;
    while (sink.connections === 0 && Date.now() < until) await sleep(50);
    assert.ok(sink.connections > 0, 'a Berlin forecast continues (here into the sink, which closes it)');
    assert.match(other, /^failed: /);
    assert.ok(b.weatherRequests.some((r) => r.action === 'continued' && r.url === FORECAST(52.52437, 13.41053, true)));
  } finally {
    await b.close();
    console.error = savedErr;
    process.exitCode = savedExit;
    await srv.close();
    await sink.close();
  }
  assert.ok(errLines.filter((l) => l.startsWith('[privacy-guard] BLOCKED')).length >= 12, 'loud console.error lines');
});

test("launch({ weather: 'mock' }): a page gets the canned forecast with sun times, the high and low of the overrides and the Berlin geocode; nothing is sent", { ...T, skip: SKIP }, async () => {
  const sink = await tcpSink();
  const b = await launch({ weather: { mode: 'mock', now: Date.UTC(2026, 10, 15, 12, 0), overrides: { max: 50, min: 41 } }, rules: [`MAP *.open-meteo.com 127.0.0.1:${sink.port}`] });
  try {
    const page = await b.newPage(server.url + 'index.html');
    const r = await page.evaluate(async (urls) => {
      const f = await (await fetch(urls[0])).json();
      const g = await (await fetch(urls[1])).json();
      return { sunrise: f.daily.sunrise[0], sunset: f.daily.sunset[0], day: f.daily.time[0], hi: f.daily.temperature_2m_max[0], lo: f.daily.temperature_2m_min[0], cloud: f.current.cloud_cover, rain: f.current.precipitation, isDay: f.current.is_day, place: g.results[0].name };
    }, [FORECAST(52.52437, 13.41053, true), 'https://geocoding-api.open-meteo.com/v1/search?name=Berlin&count=1&language=en&format=json']);
    assert.equal(r.day, 1794697200);
    assert.deepEqual([r.hi, r.lo], [50, 41], 'the high and low from the overrides');
    assert.ok(r.sunrise > r.day && r.sunset > r.sunrise);
    assert.equal(r.isDay, 1, 'noon UTC is daytime in Berlin');
    assert.equal(typeof r.cloud, 'number');
    assert.equal(typeof r.rain, 'number');
    assert.equal(r.place, 'Berlin');
    assert.deepEqual(b.weatherRequests.map((q) => q.action), ['mocked', 'mocked']);
    assert.equal(sink.connections, 0);
    b.assertNoViolations();
  } finally {
    await b.close();
    await sink.close();
  }
});

test('deviceScaleFactor: a real ratio keeps devicePixelContentBoxSize in device px (CDP emulation reports CSS px)', { ...T, skip: SKIP }, async (t) => {
  const measure = (page) => page.evaluate(async () => {
    const c = document.getElementById('c');
    const box = await new Promise((res) => {
      const ro = new ResizeObserver((es) => { const s = es[0].devicePixelContentBoxSize; ro.disconnect(); res(s ? [s[0].inlineSize, s[0].blockSize] : null); });
      ro.observe(c, { box: 'device-pixel-content-box' });
    });
    return { dpr: devicePixelRatio, box, w: innerWidth, h: innerHeight };
  });
  const real = await launch({ deviceScaleFactor: 2 });
  try {
    assert.ok(real.args.includes('--force-device-scale-factor=2'));
    const page = await real.newPage();
    await page.setViewport(640, 400, 2);
    await page.goto(server.url + 'box.html');
    const m = await measure(page);
    assert.deepEqual(m, { dpr: 2, box: [640, 640], w: 640, h: 400 });
    const shot = pngSize(await page.screenshot());
    assert.deepEqual([shot.width, shot.height], [1280, 800]);
  } finally {
    await real.close();
  }
  const emu = await launch();
  try {
    const page = await emu.newPage();
    await page.setViewport(640, 400, 2);
    await page.goto(server.url + 'box.html');
    const m = await measure(page);
    t.diagnostic(`emulated ratio 2: devicePixelContentBoxSize ${JSON.stringify(m.box)} for a 320 CSS px canvas (a real ratio gives [640,640])`);
    assert.equal(m.dpr, 2);
  } finally {
    await emu.close();
  }
});

test('launch: collects exceptions, console errors and failed loads', { ...T, skip: SKIP }, async () => {
  const b = await launch();
  try {
    const page = await b.newPage(server.url + 'errors.html');
    for (let i = 0; i < 50 && page.errors.length < 3; i++) await sleep(100);
    const types = page.errors.map((e) => e.type);
    assert.ok(types.includes('console.error'), JSON.stringify(page.errors));
    assert.ok(types.includes('exception'), JSON.stringify(page.errors));
    assert.ok(types.includes('log.network'), JSON.stringify(page.errors));
    assert.match(page.errors.find((e) => e.type === 'exception').text, /harness-exception/);
  } finally {
    await b.close();
  }
});

test('screenshotCli: 1280x800 @ 2 -> 2560x1600; with the guard on, its one resolver flag maps Open-Meteo to 127.0.0.1 and pixelclock.local to ~NOTFOUND', { ...T, skip: SKIP }, async () => {
  const tmp = makeTempDir('pcd-chrometest-out-');
  temps.push(tmp);
  const out = path.join(tmp, 'shot.png');
  // an added made-up city turns the guard on, as a city of your own in config/user.json does
  const r = await screenshotCli({ url: server.url + 'index.html', out, width: 1280, height: 800, dpr: 2, budgetMs: 1500, privacy: { cities: ['Zzyzxville, QQ'] } });
  assert.deepEqual([r.width, r.height], [2560, 1600]);
  assert.equal(r.cleaned, true);
  assert.equal(r.privacy.active, true);
  const rules = r.args.filter((a) => a.startsWith('--host-resolver-rules='));
  assert.equal(rules.length, 1);
  assert.equal(rules[0], `--host-resolver-rules=${resolverRules({ weatherLocal: true })}`);
  assert.ok(r.args.includes('--no-proxy-server'));
  const img = decodePng(out);
  assert.deepEqual(pixelAt(img, 2559, 1599).slice(0, 3), [0x14, 0x10, 0x16]);
});

test('Extensions.loadUnpacked over the pipe and the chrome://newtab override', { ...T, skip: SKIP }, async (t) => {
  if (browser.name !== 'chrome') { t.skip('Extensions.loadUnpacked is only checked on Chrome'); return; }
  const ext = makeTempDir('pcd-chrometest-ext-');
  temps.push(ext);
  fs.writeFileSync(path.join(ext, 'manifest.json'), JSON.stringify({ manifest_version: 3, name: 'PCD harness test', version: '1.0.0', chrome_url_overrides: { newtab: 'newtab.html' } }, null, 2) + '\n');
  fs.writeFileSync(path.join(ext, 'newtab.html'), '<!doctype html><html><head><meta charset="utf-8"><title>new tab</title><script src="newtab.js"></script></head><body>ok</body></html>\n');
  fs.writeFileSync(path.join(ext, 'newtab.js'), 'window.__harness = chrome.runtime.id;\n');
  const b = await launch({ extensionDebugging: true });
  try {
    assert.ok(b.args.includes('--enable-unsafe-extension-debugging'));
    const id = await b.loadUnpacked(ext);
    assert.match(id, /^[a-p]{32}$/);
    const nav = await b.newPage('chrome://newtab/');
    assert.equal(await nav.evaluate('location.href'), `chrome-extension://${id}/newtab.html`);
    assert.equal(await nav.evaluate('window.__harness'), id);
    assert.deepEqual(nav.errors, []);
  } finally {
    await b.close();
  }
});
