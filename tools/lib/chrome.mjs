// Headless Chrome (Edge fallback) helpers for screenshots and real-browser checks. Node built-ins only.
//
// - Always a fresh temporary profile (os.tmpdir()/pcd-headless-<random>), deleted afterwards. Your own Chrome
//   profile is never touched.
// - launch(): a browser driven over --remote-debugging-pipe (NUL-delimited JSON, we write fd 3 and read fd 4) with
//   flattened sessions; newPage(), evaluate(), screenshot(), setViewport(), error collection, and
//   Extensions.loadUnpacked when launched with extensionDebugging: true. screenshotCli(): one-shot --screenshot.
// - Network: every run gets ONE merged --host-resolver-rules flag (Chrome honours only one) plus --no-proxy-server:
//   pixelclock.local -> the mock clock's port (launch({ clock: port })) or ~NOTFOUND, the caller's MAP rules, then
//   "MAP * ~NOTFOUND" with EXCLUDE for 127.0.0.1, localhost and the two Open-Meteo hosts. Nothing else resolves.
// - Privacy guard (no opt-in; see "Privacy guard" below): config/user.json's city never reaches Open-Meteo, live
//   forecasts must carry coordinates within 1 degree of Berlin and live geocoding may only look up the sample city.
//   launch({ weather: 'mock' }) answers Open-Meteo with canned JSON (the shapes of the live API, sun times included).
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ensureDir, makeTempDir, rmrf, rmrfSync, sleep, writeBytes } from './fsx.mjs';
import { imageSize } from './png.mjs';

const IS_WIN = process.platform === 'win32';
const SYSTEM32 = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Flags that keep a throwaway profile quiet (no sync, no component updates, no pings). */
export const QUIET_ARGS = [
  '--disable-background-networking',
  '--disable-component-update',
  '--disable-sync',
  '--disable-default-apps',
  '--disable-domain-reliability',
  '--metrics-recording-only',
  '--no-pings',
  '--mute-audio',
];
const BASE_ARGS = ['--no-first-run', '--no-default-browser-check'];
/** sRGB output so pixel checks compare exact colours. */
const HEADLESS_ARGS = ['--headless', '--disable-gpu', '--hide-scrollbars', '--force-color-profile=srgb'];
const TEMP_PREFIX = 'pcd-headless-';

// ---------------------------------------------------------------------------------------------
// Finding the browser

/** Candidate executables in preference order (env PCD_BROWSER first). */
export function browserCandidates() {
  const list = [];
  if (process.env.PCD_BROWSER) {
    const p = process.env.PCD_BROWSER;
    list.push({ name: /msedge/i.test(p) ? 'edge' : 'chrome', path: p });
  }
  if (IS_WIN) {
    const pf = process.env.ProgramW6432 || process.env.ProgramFiles || 'C:\\Program Files';
    const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    const lad = process.env.LOCALAPPDATA;
    list.push({ name: 'chrome', path: path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe') });
    list.push({ name: 'chrome', path: path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe') });
    if (lad) list.push({ name: 'chrome', path: path.join(lad, 'Google', 'Chrome', 'Application', 'chrome.exe') });
    list.push({ name: 'edge', path: path.join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe') });
    list.push({ name: 'edge', path: path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe') });
  } else if (process.platform === 'darwin') {
    list.push({ name: 'chrome', path: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
    list.push({ name: 'edge', path: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge' });
  } else {
    for (const p of ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser']) list.push({ name: 'chrome', path: p });
    list.push({ name: 'edge', path: '/usr/bin/microsoft-edge' });
  }
  return list;
}

/**
 * The installed browser: Chrome first, Edge as the fallback.
 * Returns { name: 'chrome'|'edge', path } or null. `prefer: 'edge'` puts Edge first.
 */
export function findBrowser({ prefer } = {}) {
  let list = browserCandidates();
  if (prefer) list = [...list.filter((c) => c.name === prefer), ...list.filter((c) => c.name !== prefer)];
  for (const c of list) {
    try {
      if (fs.statSync(c.path).isFile()) return { name: c.name, path: c.path };
    } catch {
      // not installed there
    }
  }
  return null;
}

function resolveBrowser(browser) {
  if (!browser) {
    const b = findBrowser();
    if (!b) throw new Error('no Chrome or Edge found (set PCD_BROWSER to the browser executable)');
    return b;
  }
  if (typeof browser === 'string') return { name: /msedge/i.test(browser) ? 'edge' : 'chrome', path: browser };
  return browser;
}

/** http(s)/file/about/chrome URLs pass through; an absolute file path becomes a file:// URL. */
export function toUrl(target) {
  const s = String(target);
  if (/^[a-zA-Z]:[\\/]/.test(s) || (s.startsWith('/') && !s.startsWith('//'))) return pathToFileURL(s).href;
  return s;
}

// ---------------------------------------------------------------------------------------------
// Process helpers

function running(child) {
  return child && child.exitCode === null && child.signalCode === null;
}

function waitExit(child, ms) {
  if (!running(child)) return Promise.resolve(true);
  return new Promise((resolve) => {
    const t = setTimeout(() => { child.off('exit', done); resolve(false); }, ms);
    function done() { clearTimeout(t); resolve(true); }
    child.once('exit', done);
  });
}

/** Kill a process and its children (taskkill /T /F on Windows). */
function killTree(child) {
  if (!running(child)) return;
  if (IS_WIN) {
    spawnSync(path.join(SYSTEM32, 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  }
  try { child.kill('SIGKILL'); } catch { /* already gone */ }
}

/**
 * PIDs of chrome/msedge processes (browser, renderers, crashpad handler) whose command line
 * contains `marker`, e.g. a temp profile folder name. Read-only CIM query; Windows only ([] elsewhere).
 */
export function processesWithMarker(marker) {
  if (!IS_WIN || !/^[A-Za-z0-9._-]+$/.test(marker)) return [];
  const ps = path.join(SYSTEM32, 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const cmd = 'Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and ($_.Name -like \'chrome*\' -or $_.Name -like \'msedge*\')'
    + ` -and $_.CommandLine -like '*${marker}*' } | ForEach-Object { $_.ProcessId }`;
  const r = spawnSync(ps, ['-NoProfile', '-NonInteractive', '-Command', cmd], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  return String(r.stdout || '').split(/\s+/).filter((s) => /^\d+$/.test(s)).map(Number).filter((pid) => pid !== process.pid);
}

/** Last resort when the temp profile stays locked: end only the processes found by processesWithMarker. */
function killByMarker(marker) {
  const pids = processesWithMarker(marker);
  for (const pid of pids) spawnSync(path.join(SYSTEM32, 'taskkill.exe'), ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  return pids.length;
}

/**
 * Delete a temp profile, retrying while Chrome's helper processes release their handles.
 * Resolves { cleaned, ms, killed } (killed = leftover processes ended by the last-resort sweep).
 */
export async function removeProfile(dir) {
  const t0 = Date.now();
  if (!dir) return { cleaned: true, ms: 0, killed: 0 };
  let killed = 0;
  let ok = await rmrf(dir, { tries: 24, delayMs: 250 });
  if (!ok) {
    killed = killByMarker(path.basename(dir));
    if (killed > 0) ok = await rmrf(dir, { tries: 24, delayMs: 250 });
  }
  return { cleaned: ok, ms: Date.now() - t0, killed };
}

function tail(text, max = 2000) {
  const t = String(text || '').trim();
  return t.length > max ? '...' + t.slice(-max) : t;
}

// ---------------------------------------------------------------------------------------------
// Host resolver rules (one merged flag per run)

/** The real clock on your network: never reached by an automated run (a mock is mapped instead). */
export const CLOCK_HOST = 'pixelclock.local';
/** The two hosts PixelClock Desktop fetches weather from (geocoding and the forecast). */
export const WEATHER_HOSTS = ['api.open-meteo.com', 'geocoding-api.open-meteo.com'];
/** Hosts that keep resolving normally (unless a caller maps them, e.g. to a local sink). */
export const PASS_HOSTS = ['127.0.0.1', 'localhost', ...WEATHER_HOSTS];
const LOOPBACK_TARGET = /^(~NOTFOUND|127\.0\.0\.1(:\d{1,5})?|localhost(:\d{1,5})?|\[::1\](:\d{1,5})?)$/i;

function hostPatternMatches(pattern, host) {
  const re = new RegExp('^' + String(pattern).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i');
  return re.test(host);
}

/** Split rule text ("MAP a b, EXCLUDE c" or an array of such texts) into trimmed single rules. */
function splitRules(rules) {
  return [].concat(rules || []).flatMap((r) => String(r).replace(/^"|"$/g, '').split(',')).map((r) => r.trim().replace(/\s+/g, ' ')).filter(Boolean);
}

/**
 * The value of the single --host-resolver-rules flag:
 *   MAP pixelclock.local 127.0.0.1:<clockPort> (or ~NOTFOUND when clockPort is null),
 *   the caller's MAP rules (targets ~NOTFOUND or a loopback address only; never pixelclock.local),
 *   with weatherLocal: MAP for each Open-Meteo host to 127.0.0.1 (CLI renders while the privacy guard is active),
 *   MAP * ~NOTFOUND,
 *   EXCLUDE for 127.0.0.1, localhost and every Open-Meteo host that no earlier MAP rule covers
 *   (Chrome applies EXCLUDE before MAP, so an exclusion would defeat a caller's sink mapping).
 * Caller EXCLUDE rules (which could open other hosts) and unknown rule types throw.
 */
export function resolverRules({ clockPort = null, rules = [], weatherLocal = false } = {}) {
  if (clockPort !== null && clockPort !== undefined && !(Number.isInteger(clockPort) && clockPort > 0 && clockPort < 65536)) {
    throw new Error(`resolverRules: clockPort must be a TCP port number (got ${JSON.stringify(clockPort)})`);
  }
  const maps = [];
  for (const rule of splitRules(rules)) {
    const m = /^MAP (\S+) (\S+)$/i.exec(rule);
    if (!m) {
      if (/^EXCLUDE /i.test(rule)) throw new Error(`resolverRules: caller EXCLUDE rules are not allowed (only 127.0.0.1, localhost and Open-Meteo resolve): ${rule}`);
      throw new Error(`resolverRules: unsupported rule: ${rule}`);
    }
    if (!LOOPBACK_TARGET.test(m[2])) throw new Error(`resolverRules: a MAP target must be ~NOTFOUND or a loopback address: ${rule}`);
    if (hostPatternMatches(m[1], CLOCK_HOST)) throw new Error(`resolverRules: ${CLOCK_HOST} is mapped by the clock option only (launch({ clock: port })): ${rule}`);
    maps.push(`MAP ${m[1]} ${m[2]}`);
  }
  if (weatherLocal) for (const h of [...WEATHER_HOSTS, '*.open-meteo.com', 'open-meteo.com']) maps.push(`MAP ${h} 127.0.0.1`);
  const clock = `MAP ${CLOCK_HOST} ${clockPort ? `127.0.0.1:${clockPort}` : '~NOTFOUND'}`;
  const covered = (host) => maps.some((r) => hostPatternMatches(r.split(' ')[1], host));
  const excludes = PASS_HOSTS.filter((h) => h === '127.0.0.1' || h === 'localhost' || !covered(h)).map((h) => `EXCLUDE ${h}`);
  return [clock, ...maps, 'MAP * ~NOTFOUND', ...excludes].join(',');
}

/**
 * Command-line arguments with every --host-resolver-rules=... merged into the one flag of resolverRules() and
 * --no-proxy-server added (a proxy would resolve hosts itself).
 */
export function networkArgs(args = [], { clockPort = null, weatherLocal = false, rules = [] } = {}) {
  const rest = [];
  const caller = [...[].concat(rules || [])];
  for (const a of args) {
    const m = /^--host-resolver-rules=(.*)$/s.exec(String(a));
    if (m) caller.push(m[1]);
    else if (a !== '--no-proxy-server') rest.push(a);
  }
  return [...rest, `--host-resolver-rules=${resolverRules({ clockPort, rules: caller, weatherLocal })}`, '--no-proxy-server'];
}

// ---------------------------------------------------------------------------------------------
// Privacy guard (Open-Meteo)
//
// Your city must never reach the network from a build, test, screenshot or benchmark. No opt-in:
// - privacyPlan() always reads this repo's config/user.json. When its city is set and is not the sample city
//   Berlin, the guard is ACTIVE. Options and PCD_GUARD_CITIES can only ADD cities (tests). An unreadable
//   config/user.json fails closed (every Open-Meteo request is blocked); a missing one (a fresh clone) has no city
//   to guard.
// - launch(): CDP Fetch on a private browser-target session pauses every *open-meteo.com* request of the whole
//   browser (pages, popups, iframes, workers, extension pages) before it is sent. Blocked (Fetch.failRequest
//   BlockedByClient) and recorded as a violation:
//     'city'        the decoded URL, headers or body name a guarded city (case-insensitive, any encoding);
//     'config'      config/user.json cannot be read (every request, mock mode excepted);
//     'coords'      live mode: a forecast whose coordinates are not all within 1 degree of Berlin (or absent);
//     'sample-only' live mode: a geocoding request for anything but the sample city Berlin.
//   'city' from config/user.json, 'config' and 'coords' are real: the process exit code is forced to 1. Every other
//   request continues unchanged, or gets canned JSON in mock mode (launch({ weather: 'mock' })).
// - screenshotCli(): no CDP there, so while the guard is active the Open-Meteo hosts resolve to 127.0.0.1.

/** Your settings (gitignored); the guard always reads them. */
export const CONFIG_FILE = path.join(REPO_ROOT, 'config', 'user.json');
/** The sample city of the ground rules: tests may send it. */
export const SAMPLE_CITY = 'Berlin';
/** Live forecasts must stay within this many degrees of the sample place. */
export const SAMPLE_RADIUS_DEG = 1;
/** Fetch pattern for every Open-Meteo request (geocoding, forecast, the credit page). */
export const WEATHER_URL_PATTERN = '*open-meteo.com*';
/** Extra cities to guard (test hook): ';'-separated city texts. It can only add cities, never remove one. */
export const GUARD_CITIES_ENV = 'PCD_GUARD_CITIES';
const SQUASH_MIN = 5;

function foldText(s) {
  return String(s == null ? '' : s).normalize('NFC').toLowerCase().replace(/\s+/g, ' ').trim();
}

function squashText(s) {
  return s.replace(/[^\p{L}\p{N}]+/gu, '');
}

/**
 * Text as a server would read it: '+' is a space and every %XX run is percent-decoded (UTF-8, never throws),
 * repeated so that double encoding is undone too.
 */
export function decodeForMatch(text) {
  let cur = String(text == null ? '' : text);
  for (let i = 0; i < 4; i++) {
    const next = cur.replace(/\+/g, ' ').replace(/(?:%[0-9a-fA-F]{2})+/g, (run) => Buffer.from(run.replace(/%/g, ''), 'hex').toString('utf8'));
    if (next === cur) break;
    cur = next;
  }
  return cur;
}

/**
 * The name the guard looks for in a city text: the part before the first comma, NFC, lower case, whitespace
 * collapsed ('Portland, OR' -> 'portland'). '' for anything empty.
 */
export function cityNeedle(city) {
  if (typeof city !== 'string') return '';
  const text = foldText(city);
  if (!text) return '';
  return foldText(text.split(',')[0]) || foldText(text.replace(/,/g, ' '));
}

/** True for the sample city ('Berlin', 'berlin, DE', ...): tests may send it. */
export function isSampleCity(city) {
  return cityNeedle(city) === SAMPLE_CITY.toLowerCase();
}

/**
 * Does text (a URL, header or body) mention the city name `needle`? Decoded (raw, %-encoded, double-encoded,
 * '+' for spaces), case-insensitive, whitespace collapsed; for names of 5+ letters also with punctuation
 * and spaces ignored ('St.%20Louis' matches 'st louis').
 */
export function mentionsCity(text, needle) {
  const n = foldText(needle);
  if (!n) return false;
  const hay = foldText(decodeForMatch(text));
  if (hay.includes(n)) return true;
  const sn = squashText(n);
  return sn.length >= SQUASH_MIN && squashText(hay).includes(sn);
}

/** text decoded, with every guarded name replaced by '[city]' (for logs and reports). */
export function redactCities(text, needles) {
  let out = decodeForMatch(text);
  for (const n of needles || []) {
    const needle = typeof n === 'string' ? n : n && n.needle;
    if (!needle) continue;
    const re = new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s+'), 'giu');
    out = out.replace(re, '[city]');
  }
  return out;
}

function readConfigCity(file, source, real) {
  try {
    const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
    const config = JSON.parse(text);
    return { source, real, city: config && typeof config.city === 'string' ? config.city : '' };
  } catch (e) {
    // No config/user.json at all (a fresh clone): there is no city of your own to protect.
    if (real && e.code === 'ENOENT') return { source, real, city: '' };
    return { source, real, error: `cannot read ${file}: ${e.message}` };
  }
}

/**
 * The guard plan for a list of city entries ({ source, city, real } or { source, error, real }). The sample
 * city and empty cities need no guard. A real entry that cannot be read makes the plan block every
 * Open-Meteo request (fail closed); an injected one throws (a broken test setup).
 * Returns { active, blockAll, needles: [{ needle, source, real }], error }.
 */
export function planFromEntries(entries) {
  const needles = [];
  const errors = [];
  for (const e of entries) {
    if (e.error) {
      if (!e.real) throw new Error(`privacy guard: ${e.source}: ${e.error}`);
      errors.push(`${e.source}: ${e.error}`);
      continue;
    }
    const needle = cityNeedle(e.city);
    if (!needle || needle === SAMPLE_CITY.toLowerCase()) continue;
    const known = needles.find((n) => n.needle === needle);
    if (known) known.real = known.real || !!e.real;
    else needles.push({ needle, source: e.source, real: !!e.real });
  }
  const blockAll = errors.length > 0;
  return { active: blockAll || needles.length > 0, blockAll, needles, error: errors.length ? errors.join('; ') : null };
}

/**
 * The cities the guard protects. config/user.json of this repo is always read. opts (tests) can only add:
 * { config: object, configPath: file, cities: [city text] }; so can process.env.PCD_GUARD_CITIES.
 * Returns planFromEntries(...).
 */
export function privacyPlan(opts = {}) {
  const o = opts || {};
  const entries = [readConfigCity(CONFIG_FILE, 'config/user.json', true)];
  if (o.configPath) entries.push(readConfigCity(path.resolve(String(o.configPath)), `injected config ${path.basename(String(o.configPath))}`, false));
  if (o.config !== undefined && o.config !== null) {
    entries.push({ source: 'injected config', real: false, city: typeof o.config === 'object' && typeof o.config.city === 'string' ? o.config.city : '' });
  }
  for (const c of [].concat(o.cities || [])) entries.push({ source: 'injected city', real: false, city: String(c) });
  const env = process.env[GUARD_CITIES_ENV];
  if (env) for (const c of env.split(';')) entries.push({ source: GUARD_CITIES_ENV, real: false, city: c });
  return planFromEntries(entries);
}

/** A short public summary of a plan (no city names). */
function planSummary(plan) {
  return {
    active: plan.active,
    blockAll: plan.blockAll,
    cities: plan.needles.length,
    sources: [...new Set(plan.needles.map((n) => n.source))],
    error: plan.error,
  };
}

/** The place every mocked geocoding request finds (except MOCK_NOT_FOUND names): the live answer for Berlin. */
export const MOCK_PLACE = Object.freeze({
  id: 2950159, name: 'Berlin', latitude: 52.52437, longitude: 13.41053, elevation: 74, feature_code: 'PPLC', country_code: 'DE',
  admin1_id: 2950157, timezone: 'Europe/Berlin', population: 3426354, country_id: 2921044, country: 'Germany', admin1: 'State of Berlin',
});

/**
 * Live-mode check of one forecast URL: every latitude/longitude pair must lie within SAMPLE_RADIUS_DEG of Berlin.
 * Returns null when it does, else a reason string (no coordinates in it).
 */
export function forecastCoordsProblem(url) {
  let u;
  try { u = new URL(url); } catch { return 'unparsable URL'; }
  const lats = (u.searchParams.get('latitude') || '').split(',').filter((s) => s.trim() !== '').map(Number);
  const lons = (u.searchParams.get('longitude') || '').split(',').filter((s) => s.trim() !== '').map(Number);
  if (!lats.length || lats.length !== lons.length) return 'no latitude/longitude pair';
  for (let i = 0; i < lats.length; i++) {
    if (!(Math.abs(lats[i] - MOCK_PLACE.latitude) <= SAMPLE_RADIUS_DEG && Math.abs(lons[i] - MOCK_PLACE.longitude) <= SAMPLE_RADIUS_DEG)) {
      return `coordinates more than ${SAMPLE_RADIUS_DEG} degree from ${SAMPLE_CITY}`;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Mock mode: canned Open-Meteo answers, in the shapes of the live API (checked 2026-11-15 with Berlin:
// timeformat=unixtime gives integer seconds for current.time, daily.time (local midnight), sunrise and sunset;
// wind in mph is written "mp/h"; precipitation stays "mm" without precipitation_unit).

/** Names (case-insensitive, before the first comma) that a mocked geocoding request does not find. */
export const MOCK_NOT_FOUND = Object.freeze(['nowhere']);
/** Mocked current weather and today's high/low per unit system (an overcast, dry day; the same in both). */
export const MOCK_WEATHER = Object.freeze({
  C: Object.freeze({ temperature_2m: 6.9, apparent_temperature: 3.5, relative_humidity_2m: 84, weather_code: 3, wind_speed_10m: 12.4, precipitation: 0, cloud_cover: 89, max: 8.4, min: 0.4 }),
  F: Object.freeze({ temperature_2m: 44.3, apparent_temperature: 38.3, relative_humidity_2m: 84, weather_code: 3, wind_speed_10m: 7.7, precipitation: 0, cloud_cover: 89, max: 47.1, min: 32.7 }),
});
const CURRENT_FIELDS = ['temperature_2m', 'apparent_temperature', 'relative_humidity_2m', 'weather_code', 'wind_speed_10m', 'precipitation', 'cloud_cover', 'is_day'];
const DAILY_FIELDS = ['temperature_2m_max', 'temperature_2m_min', 'sunrise', 'sunset'];

/** Europe/Berlin's UTC offset in seconds at unix time t (CEST from the last Sunday of March to the last of October, 01:00 UTC). */
export function berlinOffset(tMs) {
  const y = new Date(tMs).getUTCFullYear();
  const lastSunday = (month) => {
    const d = new Date(Date.UTC(y, month + 1, 0));
    return Date.UTC(y, month, d.getUTCDate() - d.getUTCDay(), 1);
  };
  return tMs >= lastSunday(2) && tMs < lastSunday(9) ? 7200 : 3600;
}

/**
 * Sunrise and sunset (unix seconds) for the local day starting at midnightUtcSec, at lat/lon (degrees), with the
 * NOAA solar equations (refraction 0.833 degrees). Within about two minutes of Open-Meteo for Berlin.
 */
export function sunTimes(midnightUtcSec, lat = MOCK_PLACE.latitude, lon = MOCK_PLACE.longitude) {
  const rad = Math.PI / 180;
  const noonMs = (midnightUtcSec + 12 * 3600) * 1000;
  const start = Date.UTC(new Date(noonMs).getUTCFullYear(), 0, 1);
  const doy = Math.floor((noonMs - start) / 86400000) + 1;
  const g = (2 * Math.PI / 365) * (doy - 1);
  const eqtime = 229.18 * (0.000075 + 0.001868 * Math.cos(g) - 0.032077 * Math.sin(g) - 0.014615 * Math.cos(2 * g) - 0.040849 * Math.sin(2 * g));
  const decl = 0.006918 - 0.399912 * Math.cos(g) + 0.070257 * Math.sin(g) - 0.006758 * Math.cos(2 * g) + 0.000907 * Math.sin(2 * g)
    - 0.002697 * Math.cos(3 * g) + 0.00148 * Math.sin(3 * g);
  const cosHa = Math.cos(90.833 * rad) / (Math.cos(lat * rad) * Math.cos(decl)) - Math.tan(lat * rad) * Math.tan(decl);
  const ha = Math.acos(Math.max(-1, Math.min(1, cosHa))) / rad;
  const dayUtc = Math.floor(noonMs / 86400000) * 86400;
  return {
    sunrise: Math.round(dayUtc + (720 - 4 * (lon + ha) - eqtime) * 60),
    sunset: Math.round(dayUtc + (720 - 4 * (lon - ha) - eqtime) * 60),
  };
}

const pad2 = (n) => String(n).padStart(2, '0');
/** 'YYYY-MM-DDTHH:MM' of unix seconds shifted by offset seconds (Open-Meteo's iso8601 local time). */
function isoLocal(sec, offset) {
  const d = new Date((sec + offset) * 1000);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}T${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
}

/**
 * Mocked forecast JSON. opts: { units 'F'|'C', now (ms; default Date.now()), timeformat 'unixtime'|'iso8601',
 * current: [fields] (default all known), daily: [fields] (default all known; [] for none), days (default 1),
 * latitude, longitude, overrides: { field: value } for current (e.g. { weather_code: 61, precipitation: 1.2 }), plus
 * max and min for the daily high and low (e.g. { temperature_2m: 1, max: 2, min: -3 }) }. max and min are not current
 * fields, so they never show up in current.
 * The day is Berlin's local day of `now`; sunrise and sunset come from sunTimes(); is_day follows them.
 */
export function mockForecast(units = 'C', opts = {}) {
  const o = typeof units === 'object' && units !== null ? units : { ...opts, units };
  const u = o.units === 'F' ? 'F' : 'C';
  const w = MOCK_WEATHER[u];
  const nowMs = Number.isFinite(o.now) ? o.now : Date.now();
  const unix = o.timeformat === 'unixtime';
  const offset = berlinOffset(nowMs);
  const local = new Date(nowMs + offset * 1000);
  const midnight = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) / 1000 - offset;
  const days = Math.max(1, Math.min(16, Number(o.days) || 1));
  const t = u === 'F' ? '\u00b0F' : '\u00b0C';
  const currentFields = o.current || CURRENT_FIELDS;
  const dailyFields = o.daily || DAILY_FIELDS;
  const nowSec = Math.floor(nowMs / 1000);
  const slot = nowSec - (nowSec % 900);
  const today = sunTimes(midnight);
  const values = {
    ...w,
    is_day: nowSec >= today.sunrise && nowSec < today.sunset ? 1 : 0,
    ...(o.overrides || {}),
  };
  const unitOf = {
    temperature_2m: t, apparent_temperature: t, relative_humidity_2m: '%', weather_code: 'wmo code', wind_speed_10m: u === 'F' ? 'mp/h' : 'km/h',
    precipitation: 'mm', cloud_cover: '%', is_day: '', temperature_2m_max: t, temperature_2m_min: t, sunrise: unix ? 'unixtime' : 'iso8601', sunset: unix ? 'unixtime' : 'iso8601',
  };
  const body = {
    latitude: Number.isFinite(o.latitude) ? o.latitude : 52.528915,
    longitude: Number.isFinite(o.longitude) ? o.longitude : 13.423877,
    generationtime_ms: 0.05, utc_offset_seconds: offset, timezone: 'Europe/Berlin', timezone_abbreviation: offset === 7200 ? 'GMT+2' : 'GMT+1', elevation: 46,
  };
  if (currentFields.length) {
    body.current_units = { time: unix ? 'unixtime' : 'iso8601', interval: 'seconds' };
    body.current = { time: unix ? slot : isoLocal(slot, offset), interval: 900 };
    for (const f of currentFields) { body.current_units[f] = unitOf[f]; body.current[f] = values[f]; }
  }
  if (dailyFields.length) {
    body.daily_units = { time: unix ? 'unixtime' : 'iso8601' };
    body.daily = { time: [] };
    for (const f of dailyFields) { body.daily_units[f] = unitOf[f]; body.daily[f] = []; }
    for (let i = 0; i < days; i++) {
      const mid = midnight + i * 86400;
      const sun = sunTimes(mid);
      body.daily.time.push(unix ? mid : isoLocal(mid, offset).slice(0, 10));
      for (const f of dailyFields) {
        if (f === 'sunrise' || f === 'sunset') body.daily[f].push(unix ? sun[f] : isoLocal(sun[f], offset));
        else body.daily[f].push(f === 'temperature_2m_max' ? values.max : values.min);
      }
    }
  }
  return body;
}

/**
 * The canned answer for one Open-Meteo request: { status, headers: [{ name, value }], body (string) }.
 * Geocoding finds `place` (default MOCK_PLACE) for every name except `notFound` names (no "results" key, like the
 * real API); the forecast follows the URL (current= and daily= lists, temperature_unit, timeformat, forecast_days,
 * the coordinates) at `now`; an unknown variable is HTTP 400 {"error":true,"reason":...} like the live API;
 * OPTIONS gets a CORS 204; any other Open-Meteo URL gets 404. Every answer carries Access-Control-Allow-Origin: *.
 */
export function mockWeatherResponse(url, { method = 'GET', place = MOCK_PLACE, notFound = MOCK_NOT_FOUND, now, overrides } = {}) {
  const headers = [
    { name: 'Content-Type', value: 'application/json; charset=utf-8' },
    { name: 'Access-Control-Allow-Origin', value: '*' },
    { name: 'Cache-Control', value: 'no-store' },
  ];
  if (String(method).toUpperCase() === 'OPTIONS') {
    return { status: 204, headers: [...headers, { name: 'Access-Control-Allow-Methods', value: 'GET, OPTIONS' }, { name: 'Access-Control-Allow-Headers', value: '*' }], body: '' };
  }
  let u = null;
  try { u = new URL(url); } catch { /* not a URL */ }
  let status = 200;
  let body;
  if (u && u.hostname === 'geocoding-api.open-meteo.com' && u.pathname === '/v1/search') {
    const name = cityNeedle(u.searchParams.get('name') || '');
    body = (notFound || []).map(cityNeedle).includes(name) ? { generationtime_ms: 0.1 } : { results: [{ ...place }], generationtime_ms: 0.5 };
  } else if (u && u.hostname === 'api.open-meteo.com' && u.pathname === '/v1/forecast') {
    const list = (k) => (u.searchParams.has(k) ? u.searchParams.get(k).split(',').map((s) => s.trim()).filter(Boolean) : []);
    const current = list('current');
    const daily = list('daily');
    const unknown = [...current.filter((f) => !CURRENT_FIELDS.includes(f)), ...daily.filter((f) => !DAILY_FIELDS.includes(f))];
    const lat = Number(u.searchParams.get('latitude'));
    const lon = Number(u.searchParams.get('longitude'));
    if (unknown.length) {
      status = 400;
      body = { error: true, reason: `Cannot initialize variable from invalid String value ${unknown[0]} (mock)` };
    } else if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      status = 400;
      body = { error: true, reason: 'Parameter latitude and longitude are required (mock)' };
    } else {
      body = mockForecast({
        units: u.searchParams.get('temperature_unit') === 'fahrenheit' ? 'F' : 'C',
        timeformat: u.searchParams.get('timeformat') === 'unixtime' ? 'unixtime' : 'iso8601',
        current, daily, days: Number(u.searchParams.get('forecast_days')) || (daily.length ? 7 : 1),
        latitude: lat, longitude: lon, now, overrides,
      });
    }
  } else {
    status = 404;
    body = { error: true, reason: 'PixelClock Desktop mock: no canned answer for this Open-Meteo URL' };
  }
  return { status, headers, body: JSON.stringify(body) };
}

let realViolations = 0;

/**
 * A real violation (the config/user.json city, an unreadable config, or live coordinates outside Berlin): this
 * process must end with exit code 1 even if the harness sets its own code later (process.exitCode = 0 or
 * process.exit(0)), so an exit listener forces it.
 */
function failRun() {
  realViolations++;
  process.exitCode = 1;
  if (realViolations === 1) {
    process.on('exit', () => {
      process.exitCode = 1;
      console.error(`[privacy-guard] exit code 1: ${realViolations} Open-Meteo request(s) were blocked by the privacy guard in this run (none was sent)`);
    });
  }
}

function weatherOptions(weather) {
  const w = typeof weather === 'string' || weather == null ? { mode: weather || 'live' } : { ...weather, mode: weather.mode || 'live' };
  if (w.mode !== 'live' && w.mode !== 'mock') throw new Error(`weather mode must be 'live' or 'mock' (got ${JSON.stringify(w.mode)})`);
  return { mode: w.mode, mock: { place: w.place || MOCK_PLACE, notFound: w.notFound || MOCK_NOT_FOUND, now: w.now, overrides: w.overrides } };
}

/**
 * The launch()ed browser's Open-Meteo interceptor: CDP Fetch on a private browser-target session (its events
 * never reach browser.on() listeners, and a page's own Fetch.enable/disable cannot switch it off; a page-level
 * stub that answers a request itself is chained in front of it, so nothing it answers leaves the machine).
 */
export class WeatherGuard {
  constructor(conn, plan, { mode, mock }) {
    this.conn = conn;
    this.plan = plan;
    this.mode = mode;
    this.mock = mock;
    this.sessionId = null;
    this.starting = null;
    this.violations = [];
    this.requests = [];
  }

  get running() {
    return !!this.sessionId;
  }

  start() {
    if (!this.starting) {
      this.starting = (async () => {
        const { sessionId } = await this.conn.send('Target.attachToBrowserTarget', {});
        this.conn.privateSessions.add(sessionId);
        this.conn.sessions.set(sessionId, (method, params) => {
          if (method === 'Fetch.requestPaused') this.paused(sessionId, params);
        });
        await this.conn.send('Fetch.enable', { patterns: [{ urlPattern: WEATHER_URL_PATTERN, requestStage: 'Request' }] }, sessionId);
        this.sessionId = sessionId;
      })();
      this.starting.catch(() => { this.starting = null; });
    }
    return this.starting;
  }

  /** The guard's verdict for one request: null (no objection) or { reason, source, real }. */
  verdict(req, url) {
    const hay = [url, req.postData || '', ...Object.values(req.headers || {}).map(String)].join('\n');
    const hit = this.plan.needles.find((n) => mentionsCity(hay, n.needle));
    if (hit) return { reason: 'city', source: hit.source, real: hit.real };
    if (this.mode === 'mock') return null;
    if (this.plan.blockAll) return { reason: 'config', source: 'config/user.json (unreadable)', real: true };
    let u = null;
    try { u = new URL(url); } catch { /* checked below */ }
    if (u && u.hostname === 'api.open-meteo.com' && u.pathname.startsWith('/v1/forecast')) {
      const problem = forecastCoordsProblem(url);
      if (problem) return { reason: 'coords', source: problem, real: true };
    }
    if (u && u.hostname === 'geocoding-api.open-meteo.com' && !isSampleCity(u.searchParams.get('name') || '')) {
      return { reason: 'sample-only', source: `live geocoding may only look up ${SAMPLE_CITY}`, real: false };
    }
    return null;
  }

  paused(sessionId, p) {
    const req = p.request || {};
    const url = String(req.url || '') + (req.urlFragment || '');
    const v = this.verdict(req, url);
    const entry = {
      time: Date.now(),
      method: req.method || 'GET',
      url, // exact; a blocked request's URL is decoded with every guarded name as [city] (and its coordinates kept out)
      resourceType: p.resourceType || '',
      frameId: p.frameId || '',
      action: 'continued',
    };
    const send = (method, params) => this.conn.send(method, { requestId: p.requestId, ...params }, sessionId).catch(() => { /* target gone */ });
    if (v) {
      entry.action = 'blocked';
      entry.url = v.reason === 'coords' ? redactCoords(redactCities(url, this.plan.needles)) : redactCities(url, this.plan.needles);
      this.requests.push(entry);
      send('Fetch.failRequest', { errorReason: 'BlockedByClient' });
      this.report({ ...entry, ...v });
      return;
    }
    if (this.mode === 'mock') {
      const r = mockWeatherResponse(url, { method: req.method, ...this.mock });
      entry.action = 'mocked';
      entry.status = r.status;
      this.requests.push(entry);
      send('Fetch.fulfillRequest', { responseCode: r.status, responseHeaders: r.headers, body: Buffer.from(r.body, 'utf8').toString('base64') });
      return;
    }
    this.requests.push(entry);
    send('Fetch.continueRequest', {});
  }

  report(v) {
    this.violations.push(v);
    const why = {
      city: `it contains the city from ${v.source}`,
      config: 'config/user.json cannot be read, so every Open-Meteo request is blocked',
      coords: `live forecasts must use ${SAMPLE_CITY} (${v.source})`,
      'sample-only': v.source,
    }[v.reason] || v.reason;
    const text = `[privacy-guard] BLOCKED (never sent): ${v.method} ${v.url}: ${why}. Automated runs must use the sample city ${SAMPLE_CITY} or mocked weather (launch({ weather: 'mock' })).`;
    console.error(text);
    for (const page of this.conn.pages) if (page.frameIds.has(v.frameId)) page.errors.push({ type: 'privacy', text });
    if (v.real) failRun();
  }
}

/** latitude/longitude values replaced by [lat]/[lon] (a blocked live forecast may carry private coordinates). */
export function redactCoords(text) {
  return String(text).replace(/(latitude=)[^&#]*/gi, '$1[lat]').replace(/(longitude=)[^&#]*/gi, '$1[lon]');
}

/** Throws an Error listing the violations (none: returns quietly). */
function assertNoViolations(violations) {
  if (!violations.length) return;
  const lines = violations.map((v) => `${v.method} ${v.url} (${v.reason}: ${v.source})`);
  throw new Error(`privacy guard: ${violations.length} Open-Meteo request(s) were blocked; none was sent:\n  ${lines.join('\n  ')}`);
}

// ---------------------------------------------------------------------------------------------
// One-shot screenshot

/**
 * Render `url` with `chrome --headless --screenshot`. A .jpg/.jpeg `out` writes JPEG.
 * Fails when Chrome times out or writes no file (a network/file load error exits cleanly but
 * writes nothing; note an HTTP 404 page still renders and is written).
 * Network: the merged resolver rules (clock: a mock clock's port, else pixelclock.local is ~NOTFOUND); while the
 * privacy guard is active the Open-Meteo hosts resolve to 127.0.0.1, so a render cannot reach Open-Meteo at all.
 * Resolves { out, type, width, height, bytes, browser, exitCode, cleaned, ms, cleanupMs, args, privacy }.
 */
export async function screenshotCli({ url, out, width = 1280, height = 800, dpr = 1, budgetMs = 3000, timeoutMs = 60000, browser, args = [], rules = [], clock = null, quiet = true, privacy } = {}) {
  if (!url) throw new Error('screenshotCli: url is required');
  if (!out) throw new Error('screenshotCli: out is required');
  const plan = privacyPlan(privacy);
  const net = networkArgs(args, { clockPort: clock, rules, weatherLocal: plan.active });
  const b = resolveBrowser(browser);
  const outAbs = path.resolve(out);
  ensureDir(path.dirname(outAbs));
  fs.rmSync(outAbs, { force: true });
  const target = toUrl(url);
  const userDataDir = makeTempDir(TEMP_PREFIX);
  const argv = [
    ...HEADLESS_ARGS,
    ...BASE_ARGS,
    ...(quiet ? QUIET_ARGS : []),
    `--user-data-dir=${userDataDir}`,
    `--window-size=${width},${height}`,
    `--force-device-scale-factor=${dpr}`,
    `--virtual-time-budget=${budgetMs}`,
    `--screenshot=${outAbs}`,
    ...net,
    target,
  ];
  let output = '';
  let timedOut = false;
  const t0 = Date.now();
  const child = spawn(b.path, argv, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  child.stdout.on('data', (d) => { output = (output + d).slice(-8000); });
  child.stderr.on('data', (d) => { output = (output + d).slice(-8000); });
  const onExit = () => { killTree(child); rmrfSync(userDataDir); };
  process.on('exit', onExit);
  const result = await new Promise((resolve) => {
    const timer = setTimeout(() => { timedOut = true; killTree(child); }, timeoutMs);
    child.once('error', (error) => { clearTimeout(timer); resolve({ error }); });
    child.once('exit', (code, signal) => { clearTimeout(timer); resolve({ code, signal }); });
  });
  const ms = Date.now() - t0;
  const cleanup = await removeProfile(userDataDir);
  process.off('exit', onExit);
  if (result.error) throw new Error(`screenshotCli: cannot start ${b.path}: ${result.error.message}`);
  if (timedOut) throw new Error(`screenshotCli: timeout after ${timeoutMs} ms for ${target}\n${tail(output)}`);
  let bytes = 0;
  try { bytes = fs.statSync(outAbs).size; } catch { /* missing */ }
  if (!bytes) throw new Error(`screenshotCli: no file was written for ${target} (exit code ${result.code}); browser output:\n${tail(output)}`);
  const size = imageSize(outAbs);
  return {
    out: outAbs, type: size.type, width: size.width, height: size.height, bytes, browser: b.name,
    exitCode: result.code, cleaned: cleanup.cleaned, ms, cleanupMs: cleanup.ms, args: argv, privacy: planSummary(plan),
  };
}

// ---------------------------------------------------------------------------------------------
// DevTools protocol over the pipe

export class CdpError extends Error {
  constructor(method, error) {
    super(`${method}: ${error.message}${error.code !== undefined ? ` (${error.code})` : ''}${error.data ? ` ${error.data}` : ''}`);
    this.name = 'CdpError';
    this.method = method;
    this.code = error.code;
    this.cdpMessage = error.message;
  }
}

class PipeConnection {
  constructor(writable, readable) {
    this.writable = writable;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    this.sessions = new Map();
    /** Sessions whose events reach only their own handler, never on()/'*' listeners (the privacy guard). */
    this.privateSessions = new Set();
    /** Open Page objects (for privacy reports into page.errors). */
    this.pages = new Set();
    /** The WeatherGuard of this browser (set by launch()). */
    this.guard = null;
    this.chunks = [];
    this.closed = false;
    this.closeReason = '';
    readable.on('data', (chunk) => this._onData(chunk));
    readable.on('close', () => this._close('pipe closed'));
    readable.on('error', (e) => this._close('pipe error: ' + e.message));
    writable.on('error', (e) => this._close('pipe error: ' + e.message));
  }

  _onData(chunk) {
    let start = 0;
    for (;;) {
      const end = chunk.indexOf(0, start);
      if (end === -1) {
        if (start < chunk.length) this.chunks.push(chunk.subarray(start));
        return;
      }
      this.chunks.push(chunk.subarray(start, end));
      const text = Buffer.concat(this.chunks).toString('utf8');
      this.chunks = [];
      start = end + 1;
      let msg;
      try { msg = JSON.parse(text); } catch { continue; }
      this._dispatch(msg);
    }
  }

  _dispatch(msg) {
    if (msg.id !== undefined) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new CdpError(p.method, msg.error));
      else p.resolve(msg.result || {});
      return;
    }
    if (!msg.method) return;
    if (msg.sessionId) {
      const fn = this.sessions.get(msg.sessionId);
      if (fn) fn(msg.method, msg.params || {});
      if (this.privateSessions.has(msg.sessionId)) return;
    }
    for (const key of [msg.method, '*']) {
      const set = this.listeners.get(key);
      if (set) for (const fn of [...set]) {
        try { fn(msg.params || {}, msg.sessionId, msg.method); } catch { /* listener errors are not ours */ }
      }
    }
  }

  _close(reason) {
    if (this.closed) return;
    this.closed = true;
    this.closeReason = reason;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error(`${p.method}: connection closed (${reason})`));
    }
    this.pending.clear();
  }

  send(method, params = {}, sessionId, { timeoutMs = 30000 } = {}) {
    if (this.closed) return Promise.reject(new Error(`${method}: connection closed (${this.closeReason})`));
    const id = this.nextId++;
    const msg = { id, method, params };
    if (sessionId) msg.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method}: no answer after ${timeoutMs} ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, method, timer });
      this.writable.write(JSON.stringify(msg) + '\0');
    });
  }

  on(method, fn) {
    if (!this.listeners.has(method)) this.listeners.set(method, new Set());
    this.listeners.get(method).add(fn);
    return () => this.off(method, fn);
  }

  off(method, fn) {
    const set = this.listeners.get(method);
    if (set) set.delete(fn);
  }
}

function remoteObjectText(o) {
  if (!o) return '';
  if (o.value !== undefined) return typeof o.value === 'string' ? o.value : JSON.stringify(o.value);
  if (o.unserializableValue) return o.unserializableValue;
  return o.description || o.type || '';
}

function exceptionText(details) {
  if (!details) return '';
  const ex = details.exception;
  const base = (ex && (ex.description || remoteObjectText(ex))) || details.text || 'exception';
  const where = details.url ? ` (${details.url}:${(details.lineNumber || 0) + 1}:${(details.columnNumber || 0) + 1})` : '';
  return base + where;
}

/** A page (tab) attached with a flattened session. Created by browser.newPage(). */
export class Page {
  constructor(conn, targetId, sessionId) {
    this.conn = conn;
    this.targetId = targetId;
    this.sessionId = sessionId;
    /** Uncaught exceptions, console.error/assert calls and error-level Log entries. */
    this.errors = [];
    /** Every console API call: { type, text }. */
    this.console = [];
    /** Every Log.entryAdded entry: { source, level, text, url }. */
    this.logs = [];
    /** Frame ids seen in this page (the main frame id is the target id); privacy reports use them. */
    this.frameIds = new Set([targetId]);
    this.waiters = new Set();
    this.listeners = new Map();
    conn.sessions.set(sessionId, (method, params) => this._event(method, params));
    conn.pages.add(this);
  }

  /** Privacy-guard violations (blocked Open-Meteo requests) of this page's frames. */
  get violations() {
    const g = this.conn.guard;
    return g ? g.violations.filter((v) => this.frameIds.has(v.frameId)) : [];
  }

  _event(method, params) {
    if (method === 'Page.frameAttached' && params.frameId) {
      this.frameIds.add(params.frameId);
    } else if (method === 'Page.frameNavigated' && params.frame && params.frame.id) {
      this.frameIds.add(params.frame.id);
    }
    if (method === 'Runtime.exceptionThrown') {
      this.errors.push({ type: 'exception', text: exceptionText(params.exceptionDetails) });
    } else if (method === 'Runtime.consoleAPICalled') {
      const text = (params.args || []).map(remoteObjectText).join(' ');
      this.console.push({ type: params.type, text });
      if (params.type === 'error' || params.type === 'assert') this.errors.push({ type: 'console.' + params.type, text });
    } else if (method === 'Log.entryAdded') {
      const e = params.entry || {};
      const entry = { source: e.source, level: e.level, text: e.text, url: e.url };
      this.logs.push(entry);
      if (e.level === 'error') this.errors.push({ type: 'log.' + e.source, text: e.text + (e.url ? ` (${e.url})` : '') });
    } else if (method === 'Inspector.targetCrashed') {
      this.errors.push({ type: 'crash', text: 'renderer crashed' });
    }
    for (const w of [...this.waiters]) if (w.method === method) { this.waiters.delete(w); w.resolve(params); }
    const set = this.listeners.get(method);
    if (set) for (const fn of [...set]) { try { fn(params); } catch { /* ignore */ } }
  }

  /** Send a command to this page's session. */
  send(method, params = {}, opts) {
    return this.conn.send(method, params, this.sessionId, opts);
  }

  /** Listen to an event of this page only. Returns an unsubscribe function. */
  on(method, fn) {
    if (!this.listeners.has(method)) this.listeners.set(method, new Set());
    this.listeners.get(method).add(fn);
    return () => this.listeners.get(method).delete(fn);
  }

  /** Promise for the next `method` event (rejects after timeoutMs). Has .cancel(). */
  waitForEvent(method, timeoutMs = 30000) {
    let w;
    const p = new Promise((resolve, reject) => {
      w = { method, resolve };
      const t = setTimeout(() => { this.waiters.delete(w); reject(new Error(`timeout waiting for ${method}`)); }, timeoutMs);
      w.resolve = (v) => { clearTimeout(t); resolve(v); };
      w.cancel = () => { clearTimeout(t); this.waiters.delete(w); resolve(null); };
      this.waiters.add(w);
    });
    p.cancel = () => w.cancel();
    return p;
  }

  async _init() {
    await this.send('Page.enable');
    await this.send('Runtime.enable');
    await this.send('Log.enable');
    try { await this.send('Inspector.enable'); } catch { /* only for crash reports */ }
  }

  /** Navigate and wait for the load event. Throws on navigation errors (errorText). */
  async goto(url, { timeoutMs = 30000 } = {}) {
    const target = toUrl(url);
    const loaded = this.waitForEvent('Page.loadEventFired', timeoutMs);
    let res;
    try {
      res = await this.send('Page.navigate', { url: target }, { timeoutMs });
    } catch (e) {
      loaded.cancel();
      throw e;
    }
    if (res.errorText) {
      loaded.cancel();
      throw new Error(`navigate ${target}: ${res.errorText}`);
    }
    if (!res.loaderId) { loaded.cancel(); return res; } // same-document navigation: no load event
    await loaded;
    return res;
  }

  /**
   * Evaluate an expression (string) or a function (called with JSON-serializable args) in the page.
   * Promises are awaited; the result is returned by value. Page exceptions are thrown.
   */
  async evaluate(expr, ...args) {
    const expression = typeof expr === 'function' ? `(${expr.toString()})(...${JSON.stringify(args)})` : String(expr);
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (r.exceptionDetails) throw new Error('evaluate: ' + exceptionText(r.exceptionDetails));
    return r.result ? r.result.value : undefined;
  }

  /** Poll until `expr` is truthy; resolves its value. */
  async waitFor(expr, { timeoutMs = 10000, intervalMs = 100 } = {}) {
    const end = Date.now() + timeoutMs;
    let last;
    for (;;) {
      try {
        last = await this.evaluate(expr);
        if (last) return last;
      } catch (e) {
        last = e.message;
      }
      if (Date.now() > end) throw new Error(`waitFor timed out after ${timeoutMs} ms (last: ${JSON.stringify(last)})`);
      await sleep(intervalMs);
    }
  }

  /**
   * A viewport of width x height CSS px at a device pixel ratio. When dpr is the browser's real scale factor
   * (launch({ deviceScaleFactor })), only the size is overridden (deviceScaleFactor 0 keeps the real one); any other
   * dpr is emulated. Emulated ratios are fine for layout, but Chrome 157 then reports devicePixelContentBoxSize in
   * CSS px and can paint a fractional-ratio canvas 1 px off: crispness checks at a ratio other than 1 need the real
   * scale factor.
   */
  async setViewport(width, height, dpr = 1, { mobile = false } = {}) {
    const real = this.conn.deviceScaleFactor;
    const scale = real && Math.abs(real - dpr) < 1e-9 ? 0 : dpr;
    await this.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: scale, mobile, screenWidth: width, screenHeight: height });
  }

  /**
   * Page.captureScreenshot. format 'png'|'jpeg'|'webp'; fullPage captures the whole document
   * (Page.getLayoutMetrics + clip). Writes `path` when given. Resolves the image Buffer.
   */
  async screenshot({ format = 'png', quality, fullPage = false, clip, path: outPath } = {}) {
    const params = { format };
    if (quality !== undefined && format !== 'png') params.quality = quality;
    if (fullPage) {
      const m = await this.send('Page.getLayoutMetrics');
      const size = m.cssContentSize || m.contentSize;
      params.clip = { x: 0, y: 0, width: Math.ceil(size.width), height: Math.ceil(size.height), scale: 1 };
      params.captureBeyondViewport = true;
    } else if (clip) {
      params.clip = { scale: 1, ...clip };
    }
    const r = await this.send('Page.captureScreenshot', params, { timeoutMs: 60000 });
    const buf = Buffer.from(r.data, 'base64');
    if (outPath) writeBytes(path.resolve(outPath), buf);
    return buf;
  }

  /** Current URL of the page's main frame. */
  async url() {
    const r = await this.conn.send('Target.getTargetInfo', { targetId: this.targetId });
    return r.targetInfo.url;
  }

  async close() {
    this.conn.sessions.delete(this.sessionId);
    this.conn.pages.delete(this);
    try { await this.conn.send('Target.closeTarget', { targetId: this.targetId }, undefined, { timeoutMs: 5000 }); } catch { /* already closed */ }
  }
}

/**
 * Start the browser with --remote-debugging-pipe and a fresh temp profile.
 * Options: headless (default true, new headless mode), extensionDebugging (adds
 * --enable-unsafe-extension-debugging for Extensions.loadUnpacked), args (extra flags; a --host-resolver-rules=
 * among them is merged), rules (extra MAP rules: targets ~NOTFOUND or loopback only), clock (the port of a mock
 * clock on 127.0.0.1 that pixelclock.local should reach; default none: ~NOTFOUND), deviceScaleFactor (a real scale
 * factor via --force-device-scale-factor; page.setViewport(w, h, sameRatio) then keeps it instead of emulating it),
 * windowSize ([w, h] or null; a tab without setViewport() gets the window minus headless browser UI), browser ({ path } or a path), quiet
 * (QUIET_ARGS), privacy (tests: { config, configPath, cities } add cities to guard; config/user.json is always
 * guarded), weather ('live' (default) | 'mock' | { mode, place, notFound, now, overrides }: canned Open-Meteo answers).
 * The privacy guard starts before launch() resolves whenever it is active or weather is 'mock'; when it cannot
 * start, launch() closes the browser and throws (never runs unguarded).
 * Extra members: privacy (summary, no city names), resolverRules (the merged flag value), violations,
 * weatherRequests ({ time, method, url, resourceType, frameId, action: 'continued'|'mocked'|'blocked', status? }),
 * weatherMode, setWeatherMode(mode), assertNoViolations().
 */
export async function launch({ headless = true, extensionDebugging = false, args = [], rules = [], clock = null, deviceScaleFactor = null, windowSize = [1280, 800], browser, quiet = true, timeoutMs = 30000, privacy, weather } = {}) {
  const plan = privacyPlan(privacy);
  const weatherOpts = weatherOptions(weather);
  if (deviceScaleFactor !== null && deviceScaleFactor !== undefined && !(Number(deviceScaleFactor) > 0)) throw new Error(`launch: deviceScaleFactor must be a positive number (got ${JSON.stringify(deviceScaleFactor)})`);
  const dsf = deviceScaleFactor ? Number(deviceScaleFactor) : null;
  const net = networkArgs(args.filter((a) => !String(a).startsWith('--force-device-scale-factor=') || !dsf), { clockPort: clock, rules });
  const b = resolveBrowser(browser);
  const userDataDir = makeTempDir(TEMP_PREFIX);
  const argv = [
    ...(headless ? HEADLESS_ARGS : []),
    ...BASE_ARGS,
    ...(quiet ? QUIET_ARGS : []),
    `--user-data-dir=${userDataDir}`,
    '--remote-debugging-pipe',
    ...(extensionDebugging ? ['--enable-unsafe-extension-debugging'] : []),
    ...(windowSize ? [`--window-size=${windowSize[0]},${windowSize[1]}`] : []),
    ...(dsf ? [`--force-device-scale-factor=${dsf}`] : []),
    ...net,
    'about:blank',
  ];
  const child = spawn(b.path, argv, { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'], windowsHide: true });
  let stderr = '';
  child.stdio[2].on('data', (d) => { stderr = (stderr + d).slice(-16000); });
  const conn = new PipeConnection(child.stdio[3], child.stdio[4]);
  conn.deviceScaleFactor = dsf;
  let spawnError = null;
  child.once('error', (e) => { spawnError = e; conn._close('spawn error: ' + e.message); });
  child.once('exit', (code, signal) => conn._close(`browser exited (code ${code}${signal ? ', ' + signal : ''})`));
  const onProcessExit = () => { killTree(child); rmrfSync(userDataDir); };
  process.on('exit', onProcessExit);

  const guard = new WeatherGuard(conn, plan, weatherOpts);
  conn.guard = guard;

  let closing = null;
  const close = async () => {
    if (closing) return closing;
    closing = (async () => {
      if (running(child)) {
        try { await conn.send('Browser.close', {}, undefined, { timeoutMs: 5000 }); } catch { /* exits before answering */ }
        if (!(await waitExit(child, 8000))) {
          killTree(child);
          await waitExit(child, 5000);
        }
      }
      const cleanup = await removeProfile(userDataDir);
      process.off('exit', onProcessExit);
      if (guard.violations.length) {
        console.error(`[privacy-guard] this browser blocked ${guard.violations.length} Open-Meteo request(s) (none was sent); see the BLOCKED lines above`);
      }
      return { cleaned: cleanup.cleaned, cleanupMs: cleanup.ms, userDataDir, violations: guard.violations.length };
    })();
    return closing;
  };

  let version;
  try {
    version = await conn.send('Browser.getVersion', {}, undefined, { timeoutMs });
  } catch (e) {
    await close();
    const why = spawnError ? spawnError.message : e.message;
    throw new Error(`launch: browser did not answer over --remote-debugging-pipe (${why})\n${tail(stderr)}`);
  }

  if (plan.active || weatherOpts.mode === 'mock') {
    try {
      await guard.start();
    } catch (e) {
      await close();
      throw new Error(`launch: the privacy guard could not intercept Open-Meteo requests (${e.message}); refusing to run without it`);
    }
  }

  const api = {
    browser: b,
    process: child,
    pid: child.pid,
    userDataDir,
    version,
    args: argv,
    /** The real device scale factor (--force-device-scale-factor), or null. */
    deviceScaleFactor: dsf,
    /** The value of the one --host-resolver-rules flag of this run. */
    resolverRules: net.find((a) => a.startsWith('--host-resolver-rules=')).slice('--host-resolver-rules='.length),
    /** Privacy guard summary: { active, blockAll, cities (count), sources, error }; never the city names. */
    privacy: planSummary(plan),
    /** Blocked Open-Meteo requests: { time, method, url (redacted), resourceType, frameId, reason, source, real }. */
    get violations() { return guard.violations; },
    /** Every Open-Meteo request the guard saw (only while it runs: active or mock). */
    get weatherRequests() { return guard.requests; },
    /** 'live' (requests continue unless the guard objects) or 'mock' (canned answers). */
    get weatherMode() { return guard.mode; },
    /** Switch every page to 'live' or 'mock' ({ mode, place, notFound, now, overrides } too); starts the guard if needed. */
    async setWeatherMode(mode) {
      const w = weatherOptions(mode);
      guard.mode = w.mode;
      guard.mock = w.mock;
      if (!guard.running) await guard.start();
      return guard.mode;
    },
    /** Throws when any Open-Meteo request was blocked. */
    assertNoViolations() { assertNoViolations(guard.violations); },
    /** Browser-level command (or session command when sessionId is given). */
    send: (method, params, sessionId, opts) => conn.send(method, params, sessionId, opts),
    /** Listen to protocol events: fn(params, sessionId, method). '*' gets every event. */
    on: (method, fn) => conn.on(method, fn),
    off: (method, fn) => conn.off(method, fn),
    stderr: () => stderr,
    /** Target.getTargets -> targetInfos. */
    async targets() {
      return (await conn.send('Target.getTargets')).targetInfos;
    },
    /** Attach to an existing target (flattened session) and enable Page/Runtime/Log. */
    async attach(targetId) {
      const { sessionId } = await conn.send('Target.attachToTarget', { targetId, flatten: true });
      const page = new Page(conn, targetId, sessionId);
      await page._init();
      return page;
    },
    /**
     * New tab. By default it is created blank, attached, and then navigated with Page.navigate so
     * errors from the very first script are collected. `{ create: true }` instead passes the URL
     * to Target.createTarget (like typing it into a new tab) and waits for readyState complete.
     */
    async newPage(url = 'about:blank', { create = false, timeoutMs: navTimeout = 30000 } = {}) {
      const target = toUrl(url);
      const { targetId } = await conn.send('Target.createTarget', { url: create ? target : 'about:blank' });
      const page = await api.attach(targetId);
      if (create) {
        const ready = target === 'about:blank'
          ? "document.readyState === 'complete'"
          : "location.href !== 'about:blank' && document.readyState === 'complete'";
        await page.waitFor(ready, { timeoutMs: navTimeout });
      } else if (target !== 'about:blank') {
        await page.goto(target, { timeoutMs: navTimeout });
      }
      return page;
    },
    /**
     * Extensions.loadUnpacked over the pipe (branded Chrome ignores --load-extension). Resolves the extension id.
     * Pass extensionDebugging: true to launch().
     */
    async loadUnpacked(extPath) {
      try {
        const r = await conn.send('Extensions.loadUnpacked', { path: path.resolve(extPath) });
        return r.id;
      } catch (e) {
        if (!extensionDebugging) e.message += ' (launch with extensionDebugging: true)';
        throw e;
      }
    },
    /** Close the browser (Browser.close, then kill the tree) and delete the temp profile. */
    close,
  };
  return api;
}

/** launch(), run fn(browser), always close; then throw if the privacy guard blocked anything. */
export async function withBrowser(opts, fn) {
  const browser = await launch(opts);
  let result;
  try {
    result = await fn(browser);
  } finally {
    await browser.close();
  }
  browser.assertNoViolations();
  return result;
}
