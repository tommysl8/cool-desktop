/* PixelClock Desktop shared: weather and sun times from Open-Meteo (no key). Classic script, UMD, global PCD.
 *
 * - WMO code -> kind (clear, partly, cloudy, fog, drizzle, freezing, rain, snow, thunder, unknown) and short lowercase
 *   descriptions ('light rain'); the ASCII icons live in pcd-ascii.js, the scene effects in pcd-fx.js.
 * - URL builders and parsers for the geocoding and forecast APIs. One forecast request carries the current weather
 *   and today's sunrise and sunset (daily, timeformat=unixtime): PCD.sun.today(state.data, now) reads them.
 * - createClient(): 30-minute cache per city, geocoding only when the city changes, a refetch once the local day has
 *   changed since the last fetch (new sun times), back-off 1/2/5/10/30 min, the cache served as STALE when offline or
 *   failing, no request for city names under 3 characters, never more than one request in flight. Storage, fetch, the
 *   clock and the online flag are injectable (tests use fakes; no test touches the network).
 *
 * City forms the client accepts: "City", "City, Country name", "City, State" (Open-Meteo narrows the search by an exact
 * country or first-level area name after a comma) and "City, CC" with an ISO 3166-1 alpha-2 code: Open-Meteo finds
 * nothing for that form, so the client retries ONCE with name=<the part before the last comma>&countryCode=CC.
 * Open-Meteo facts this file relies on (checked live with Berlin, 2026-11-15):
 *   - no match means no "results" key; empty fields (admin1, timezone, ...) are left out of a result;
 *   - errors are HTTP 400 with {"error":true,"reason":...}: detected from the status or error === true;
 *   - unknown parameter names are ignored silently (HTTP 200), so a misspelled unit parameter would return metric
 *     data: parseForecast(json, { units }) checks current_units against the request (the API writes "mp/h");
 *   - with timeformat=unixtime, daily.time[0] is the location's local midnight and daily.sunrise/sunset[0] are unix
 *     seconds; utc_offset_seconds is the location's current offset; the answer's coordinates are grid-snapped.
 * Terms: non-commercial use, data CC BY 4.0; always show CREDIT (linked to CREDIT_URL where links work).
 */
(function (root, factory) {
  var api = factory(root.PCD || (root.PCD = {}), root);
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (PCD, root) {
  'use strict';

  var GEOCODE_BASE = 'https://geocoding-api.open-meteo.com/v1/search';
  var FORECAST_BASE = 'https://api.open-meteo.com/v1/forecast';
  var CREDIT = 'weather: open-meteo.com';
  var CREDIT_URL = 'https://open-meteo.com/';
  var MIN_CITY = 3;
  var TTL_MS = 30 * 60 * 1000;
  var TIMEOUT_MS = 8000;
  var BACKOFF_MS = [1, 2, 5, 10, 30].map(function (m) { return m * 60 * 1000; });
  var STORAGE_KEY = 'pcd.weather';
  var CACHE_VERSION = 1;
  var MPH_TO_KMH = 1.609344;

  /** current_units each unit system must show (the API writes "mp/h"; "mph" is accepted should it ever change). */
  var API_UNITS = {
    F: { temperature_2m: ['°F'], wind_speed_10m: ['mp/h', 'mph'] },
    C: { temperature_2m: ['°C'], wind_speed_10m: ['km/h'] }
  };

  var KINDS = ['clear', 'partly', 'cloudy', 'fog', 'drizzle', 'freezing', 'rain', 'snow', 'thunder', 'unknown'];

  /** WMO weather interpretation codes (the ones Open-Meteo sends, plus 97) by kind. */
  var CODE_GROUPS = {
    clear: [0, 1],
    partly: [2],
    cloudy: [3],
    fog: [45, 48],
    drizzle: [51, 53, 55],
    freezing: [56, 57, 66, 67],
    rain: [61, 63, 65, 80, 81, 82],
    snow: [71, 73, 75, 77, 85, 86],
    thunder: [95, 96, 97, 99]
  };

  /** Short lowercase text per code, at most 18 characters (the weather panel line is "48°F light rain"). */
  var DESCRIPTIONS = {
    0: 'clear', 1: 'mostly clear', 2: 'partly cloudy', 3: 'overcast',
    45: 'fog', 48: 'freezing fog',
    51: 'light drizzle', 53: 'drizzle', 55: 'heavy drizzle',
    56: 'freezing drizzle', 57: 'freezing drizzle',
    61: 'light rain', 63: 'rain', 65: 'heavy rain',
    66: 'freezing rain', 67: 'freezing rain',
    71: 'light snow', 73: 'snow', 75: 'heavy snow', 77: 'snow grains',
    80: 'light showers', 81: 'showers', 82: 'heavy showers',
    85: 'snow showers', 86: 'heavy snow showers',
    95: 'thunderstorm', 96: 'thunder and hail', 97: 'thunderstorm', 99: 'thunder and hail'
  };

  /** Generic lowercase text per kind. */
  var LABELS = {
    clear: 'clear', partly: 'partly cloudy', cloudy: 'cloudy', fog: 'fog', drizzle: 'drizzle',
    freezing: 'freezing rain', rain: 'rain', snow: 'snow', thunder: 'thunderstorm', unknown: 'unknown'
  };

  var CODES = {};
  Object.keys(CODE_GROUPS).forEach(function (k) { CODE_GROUPS[k].forEach(function (c) { CODES[c] = k; }); });

  function codeNumber(code) {
    var n = typeof code === 'string' && code.trim() !== '' ? Number(code) : code;
    return typeof n === 'number' && isFinite(n) && n % 1 === 0 ? n : null;
  }

  /** WMO code -> kind; anything that is not a known code is 'unknown'. (Day or night does not change the kind.) */
  function kind(code) {
    var n = codeNumber(code);
    return n !== null && CODES[n] ? CODES[n] : 'unknown';
  }

  /** WMO code -> short lowercase description ('light rain'); 'unknown' for anything else. */
  function describe(code) {
    var n = codeNumber(code);
    return n !== null && DESCRIPTIONS[n] ? DESCRIPTIONS[n] : LABELS.unknown;
  }

  function label(k) {
    return LABELS[k] || LABELS.unknown;
  }

  /** 'F' for Fahrenheit-like input ('F', 'f', 'fahrenheit', 'imperial', '°F', 1 from a Lively dropdown), else 'C'. */
  function normUnits(units) {
    if (units === 1 || units === true) return 'F';
    var u = String(units == null ? '' : units).trim().toLowerCase();
    return u === 'f' || u === 'fahrenheit' || u === 'imperial' || u === '°f' ? 'F' : 'C';
  }

  /** Display labels (hard-coded: the API itself says "mp/h"). */
  function unitLabels(units) {
    return normUnits(units) === 'F' ? { units: 'F', temp: '°F', wind: 'mph' } : { units: 'C', temp: '°C', wind: 'km/h' };
  }

  function squash(s) {
    return String(s == null ? '' : s).trim().replace(/\s+/g, ' ');
  }

  function cells(s) {
    return Array.from(s).length;
  }

  /** '' when absent, the upper-cased code when it is two ASCII letters; throws otherwise. */
  function countryCodeArg(value, fn) {
    var cc = value == null ? '' : String(value).trim();
    if (cc === '') return '';
    if (!/^[A-Za-z]{2}$/.test(cc)) throw new Error(fn + ': countryCode must be two letters (ISO 3166-1 alpha-2), got "' + cc + '"');
    return cc.toUpperCase();
  }

  /** Geocoding URL (exact: one result, English names); opts.countryCode adds the &countryCode=XX filter (upper case). */
  function geocodeUrl(city, opts) {
    var url = GEOCODE_BASE + '?name=' + encodeURIComponent(squash(city)) + '&count=1&language=en&format=json';
    var cc = countryCodeArg(opts && opts.countryCode, 'geocodeUrl');
    return cc ? url + '&countryCode=' + cc : url;
  }

  /**
   * "City, CC" -> { name: 'City', countryCode: 'CC' } for the one geocoding retry, else null. Only when the part
   * after the LAST comma is exactly two ASCII letters and the part before it still has MIN_CITY characters:
   *   'Berlin, de' -> { name: 'Berlin', countryCode: 'DE' }; 'Portland, Oregon, US' -> { 'Portland, Oregon', 'US' }
   *   'Berlin', 'Berlin, Germany', 'Berlin, DEU', 'Be, DE' -> null
   */
  function splitCountryCode(city) {
    var s = squash(city);
    var i = s.lastIndexOf(',');
    if (i === -1) return null;
    var cc = s.slice(i + 1).trim();
    if (!/^[A-Za-z]{2}$/.test(cc)) return null;
    var name = s.slice(0, i).replace(/[\s,]+$/, '');
    if (cells(name) < MIN_CITY) return null;
    return { name: name, countryCode: cc.toUpperCase() };
  }

  function coord(v, name, lo, hi) {
    var n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
    if (typeof n !== 'number' || !isFinite(n) || n < lo || n > hi) throw new Error('forecastUrl: ' + name + ' must be a number from ' + lo + ' to ' + hi);
    return String(n);
  }

  /** Forecast URL (exact): current weather + today's high, low, sunrise and sunset in unix time. */
  function forecastUrl(lat, lon, units) {
    var url = FORECAST_BASE + '?latitude=' + coord(lat, 'latitude', -90, 90) + '&longitude=' + coord(lon, 'longitude', -180, 180) +
      '&current=temperature_2m,apparent_temperature,weather_code,wind_speed_10m,precipitation,cloud_cover,is_day' +
      '&daily=temperature_2m_max,temperature_2m_min,sunrise,sunset&timezone=auto&timeformat=unixtime&forecast_days=1';
    if (normUnits(units) === 'F') url += '&temperature_unit=fahrenheit&wind_speed_unit=mph';
    return url;
  }

  function num(v) {
    return typeof v === 'number' && isFinite(v) ? v : null;
  }

  function text(v) {
    return typeof v === 'string' ? v.trim() : '';
  }

  /** The reason of an Open-Meteo error body ({"error":true,"reason":...}, keys in any order), else null. */
  function apiError(json) {
    if (!json || typeof json !== 'object' || json.error !== true) return null;
    var reason = json.reason == null ? '' : String(json.reason).trim();
    return reason || 'request failed';
  }

  /**
   * Geocoding JSON -> { name, admin1, country_code, latitude, longitude, timezone } or null (no "results" key, an
   * empty list or no coordinates). An API error body throws. opts.countryCode: a result from another country counts
   * as no match, so a filter the API did not apply can never return the wrong place.
   */
  function parseGeocode(json, opts) {
    var want = countryCodeArg(opts && opts.countryCode, 'parseGeocode');
    if (!json || typeof json !== 'object') return null;
    var reason = apiError(json);
    if (reason !== null) throw new Error('Open-Meteo geocoding: ' + reason);
    var list = json.results;
    if (!Array.isArray(list) || list.length === 0) return null;
    var r = list[0];
    if (!r || typeof r !== 'object' || num(r.latitude) === null || num(r.longitude) === null) return null;
    var place = {
      name: text(r.name),
      admin1: text(r.admin1),
      country_code: text(r.country_code).toUpperCase(),
      latitude: r.latitude,
      longitude: r.longitude,
      timezone: text(r.timezone)
    };
    if (want && place.country_code && place.country_code !== want) return null;
    return place;
  }

  /** 'Berlin, DE' / 'Portland, Oregon, US' (admin1 only when it adds something). */
  function placeLabel(place) {
    if (!place || typeof place !== 'object') return '';
    var name = text(place.name);
    var admin1 = text(place.admin1);
    var cc = text(place.country_code);
    var parts = [];
    if (name) parts.push(name);
    if (admin1 && (!name || admin1.toLowerCase().indexOf(name.toLowerCase()) === -1)) parts.push(admin1);
    if (cc) parts.push(cc);
    return parts.join(', ');
  }

  function quoteUnit(v) {
    if (v === undefined || v === null) return 'missing';
    return typeof v === 'string' ? '"' + v + '"' : String(v);
  }

  /** Throws when current_units does not say what `units` ('F' or 'C') asked for, or precipitation is not in mm. */
  function checkUnits(json, units) {
    var want = API_UNITS[units];
    var cu = json.current_units && typeof json.current_units === 'object' ? json.current_units : {};
    var bad = [];
    Object.keys(want).forEach(function (field) {
      if (want[field].indexOf(cu[field]) === -1) bad.push(field + ' ' + quoteUnit(cu[field]));
    });
    if (cu.precipitation !== undefined && cu.precipitation !== 'mm') bad.push('precipitation ' + quoteUnit(cu.precipitation));
    if (bad.length) {
      throw new Error('Open-Meteo forecast: units do not match the request (asked for ' + want.temperature_2m[0] + ', ' +
        want.wind_speed_10m[0] + ' and mm; current_units has ' + bad.join(', ') + ')');
    }
  }

  function firstOf(a) {
    return Array.isArray(a) ? num(a[0]) : null;
  }

  /**
   * Forecast JSON -> data:
   *   { temp, feels, wind, windKmh, precip, cloud, code, isDay, kind, description, label, high, low,
   *     day, sunrise, sunset, utcOffset, timezone, latitude, time }
   * temp/feels/high/low/wind in the requested units, windKmh always km/h, precip mm, cloud %; day = the location's
   * local midnight, sunrise/sunset and time (the current block) in unix seconds, null when missing (polar day or night
   * may leave the sun times out; PCD.sun.today() sorts that out). Throws on an error body, a missing "current" block
   * or current temperature, and (with opts.units) on units that do not match the request.
   */
  function parseForecast(json, opts) {
    if (!json || typeof json !== 'object') throw new Error('Open-Meteo forecast: empty response');
    var reason = apiError(json);
    if (reason !== null) throw new Error('Open-Meteo forecast: ' + reason);
    var c = json.current;
    if (!c || typeof c !== 'object') throw new Error('Open-Meteo forecast: no "current" block');
    var units = opts && opts.units != null ? normUnits(opts.units) : null;
    if (units) checkUnits(json, units);
    var temp = num(c.temperature_2m);
    if (temp === null) throw new Error('Open-Meteo forecast: no current temperature');
    var code = num(c.weather_code);
    var k = kind(code);
    var wind = num(c.wind_speed_10m);
    var windUnit = json.current_units && json.current_units.wind_speed_10m;
    var mph = units ? units === 'F' : (windUnit === 'mp/h' || windUnit === 'mph');
    var d = json.daily && typeof json.daily === 'object' ? json.daily : {};
    return {
      temp: temp,
      feels: num(c.apparent_temperature),
      wind: wind,
      windKmh: wind === null ? null : Math.round((mph ? wind * MPH_TO_KMH : wind) * 10) / 10,
      precip: num(c.precipitation),
      cloud: num(c.cloud_cover),
      code: code,
      isDay: !(c.is_day === 0 || c.is_day === false),
      kind: k,
      description: describe(code),
      label: label(k),
      high: firstOf(d.temperature_2m_max),
      low: firstOf(d.temperature_2m_min),
      day: firstOf(d.time),
      sunrise: firstOf(d.sunrise),
      sunset: firstOf(d.sunset),
      utcOffset: num(json.utc_offset_seconds),
      timezone: text(json.timezone),
      latitude: num(json.latitude),
      time: num(c.time)
    };
  }

  function degrees(v) {
    return v === null || v === undefined || !isFinite(v) ? '-' : String(Math.round(v));
  }

  /** The weather as two plain text lines: ['48°F light rain', 'hi 52° · lo 39°'] (units: the data's units). */
  function lines(data, units) {
    if (!data || typeof data !== 'object') return ['', ''];
    var u = unitLabels(units);
    return [
      degrees(data.temp) + u.temp + ' ' + (data.description || label(data.kind)),
      'hi ' + degrees(data.high) + '° · lo ' + degrees(data.low) + '°'
    ];
  }

  function pad2(n) {
    return (n < 10 ? '0' : '') + n;
  }

  /** 'updated 9:41 pm' / 'updated 21:41' from a fetch time in ms; '' without one. */
  function updatedLabel(fetchedAt, clock24) {
    if (!fetchedAt) return '';
    var d = new Date(fetchedAt);
    var h = d.getHours();
    var t = clock24 ? pad2(h) + ':' + pad2(d.getMinutes()) : ((h % 12) || 12) + ':' + pad2(d.getMinutes()) + (h < 12 ? ' am' : ' pm');
    return 'updated ' + t;
  }

  // -------------------------------------------------------------------------------------------
  // Client

  function cityKey(city) {
    return squash(city).toLowerCase();
  }

  function errorText(e) {
    return String(e && e.message ? e.message : e || 'error');
  }

  /** 'HTTP 400: reason' (or 'HTTP 503'); the status is kept on the error as e.status. */
  function httpError(status, reason) {
    var code = status || 400;
    var e = new Error('HTTP ' + code + (reason ? ': ' + reason : ''));
    e.status = code;
    return e;
  }

  /** The local midnight that starts the day of `ms` (DST-safe: built from the local calendar date). */
  function dayStart(ms) {
    var d = new Date(ms);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  }

  /** Storage adapter: localStorage-like (getItem/setItem, strings) or async get(key)/set(key, value). */
  function makeStore(storage, key) {
    var memory = null;
    if (!storage) {
      return {
        load: function () { return Promise.resolve(memory); },
        save: function (v) { memory = v; return Promise.resolve(); }
      };
    }
    if (typeof storage.getItem === 'function') {
      return {
        load: function () {
          try {
            var raw = storage.getItem(key);
            return Promise.resolve(raw ? JSON.parse(raw) : memory);
          } catch (e) {
            return Promise.resolve(memory);
          }
        },
        save: function (v) {
          memory = v;
          try { storage.setItem(key, JSON.stringify(v)); } catch (e) { /* storage full or blocked: keep memory */ }
          return Promise.resolve();
        }
      };
    }
    return {
      load: function () {
        try {
          return Promise.resolve(storage.get(key)).then(function (v) { return v || memory; }, function () { return memory; });
        } catch (e) {
          return Promise.resolve(memory);
        }
      },
      save: function (v) {
        memory = v;
        try {
          return Promise.resolve(storage.set(key, v)).then(null, function () {});
        } catch (e) {
          return Promise.resolve();
        }
      }
    };
  }

  /** A cache object of the right shape (anything else in storage is ignored). */
  function cacheOk(c) {
    return !!c && typeof c === 'object' && c.v === CACHE_VERSION && typeof c.city === 'string' &&
      (c.place === null || (typeof c.place === 'object' && num(c.place.latitude) !== null && num(c.place.longitude) !== null)) &&
      (c.data === null || (typeof c.data === 'object' && num(c.data.temp) !== null)) &&
      typeof c.fetchedAt === 'number' && typeof c.fails === 'number' && typeof c.nextTryAt === 'number';
  }

  /**
   * createClient({ storage, fetch, now, ttlMs, online, timeoutMs, key }) -> client.
   *   client.get({ city, units, force }) -> Promise<state>: the cache while it is fresh (fetched less than ttlMs ago,
   *     on the current local day, in the requested units), otherwise a fetch (geocoding only when the city changed).
   *     force skips the TTL, the day rule and the back-off wait. A "City, CC" query that geocodes to nothing is
   *     retried once as name=City&countryCode=CC (an ordinary request: serialized, counted, a failure backs off).
   *   client.peek({ city, units }) -> Promise<state> from the cache only (never fetches).
   *   client.busy() -> true while a request is in flight; client.requests() -> requests made so far.
   * state: { status: 'ok'|'stale'|'error'|'not-found'|'short'|'no-city', stale, city, units, labels, place, data,
   *          fetchedAt, ageMs, error, fails, nextTryAt, nextRefreshAt, fetched }
   *   status 'stale' (stale true): cached data shown because a refresh was due but the browser is offline, the client
   *   is backing off, or the request failed. data is parseForecast()'s object; PCD.sun.today(state.data, now) gives
   *   today's sun times from it (null once the cached forecast is yesterday's).
   * Failures: network errors, timeouts, invalid JSON, HTTP status >= 400 and error bodies (error === true).
   * storage: localStorage-like ({ getItem, setItem }) or { get(key), set(key, value) } (may return promises, e.g. a
   *   chrome.storage.local wrapper); omitted = memory only. now() returns ms; online() returns a boolean.
   */
  function createClient(options) {
    var o = options || {};
    var ttl = o.ttlMs > 0 ? o.ttlMs : TTL_MS;
    var nowFn = typeof o.now === 'function' ? o.now : function () { return Date.now(); };
    var fetchFn = typeof o.fetch === 'function' ? o.fetch : (typeof root.fetch === 'function' ? root.fetch.bind(root) : null);
    var onlineFn = typeof o.online === 'function' ? o.online : function () {
      return !(root.navigator && root.navigator.onLine === false);
    };
    var timeoutMs = o.timeoutMs === undefined ? TIMEOUT_MS : o.timeoutMs;
    var store = makeStore(o.storage, o.key || STORAGE_KEY);
    var chain = Promise.resolve();
    var inFlight = 0;
    var requests = 0;

    function getJson(url) {
      if (!fetchFn) return Promise.reject(new Error('fetch is not available'));
      var controller = typeof root.AbortController === 'function' ? new root.AbortController() : null;
      var timer = null;
      inFlight++;
      requests++;
      var request = new Promise(function (resolve, reject) {
        if (timeoutMs > 0) {
          timer = setTimeout(function () {
            if (controller) controller.abort();
            reject(new Error('request timed out after ' + Math.round(timeoutMs / 1000) + ' s'));
          }, timeoutMs);
        }
        var init = { credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store' };
        if (controller) init.signal = controller.signal;
        Promise.resolve().then(function () { return fetchFn(url, init); }).then(function (res) {
          if (!res) throw new Error('no response');
          var status = typeof res.status === 'number' ? res.status : 0;
          var failed = res.ok === false || status >= 400;
          var body = typeof res.json === 'function' ? Promise.resolve().then(function () { return res.json(); }) : Promise.resolve(res);
          return body.then(function (json) {
            var reason = apiError(json);
            if (failed || reason !== null) throw httpError(status, reason);
            return json;
          }, function () {
            throw failed ? httpError(status, null) : new Error('invalid JSON');
          });
        }).then(resolve, reject);
      });
      return request.then(function (v) {
        if (timer) clearTimeout(timer);
        inFlight--;
        return v;
      }, function (e) {
        if (timer) clearTimeout(timer);
        inFlight--;
        throw e;
      });
    }

    /** Geocode a city: the query as typed, then (only for "City, CC" without a match) one countryCode retry. */
    async function geocode(cityText) {
      var place = parseGeocode(await getJson(geocodeUrl(cityText)));
      if (place) return place;
      var retry = splitCountryCode(cityText);
      if (!retry) return null;
      return parseGeocode(await getJson(geocodeUrl(retry.name, { countryCode: retry.countryCode })), { countryCode: retry.countryCode });
    }

    /** Fresh: fetched less than ttl ago, not in the future, on the current local day, in the requested units. */
    function isFresh(cache, req, t) {
      return !!(cache && cache.data) && cache.units === req.units && t >= cache.fetchedAt &&
        t - cache.fetchedAt < ttl && cache.fetchedAt >= dayStart(t);
    }

    function state(status, cache, req, extra) {
      var e = extra || {};
      var t = nowFn();
      var data = cache && cache.data ? cache.data : null;
      var dataUnits = data ? cache.units : req.units;
      var fetchedAt = data ? cache.fetchedAt : null;
      var nextTryAt = cache && cache.nextTryAt > t ? cache.nextTryAt : null;
      var nextRefreshAt = null;
      if (status === 'ok') {
        var tomorrow = new Date(dayStart(t));
        tomorrow.setDate(tomorrow.getDate() + 1);
        nextRefreshAt = Math.min(fetchedAt + ttl, tomorrow.getTime());
      } else if (status === 'stale' || status === 'error') {
        nextRefreshAt = nextTryAt || t;
      }
      return {
        status: status,
        stale: status === 'stale',
        city: req.city,
        units: dataUnits,
        labels: unitLabels(dataUnits),
        place: cache && cache.place ? cache.place : null,
        data: data,
        fetchedAt: fetchedAt,
        ageMs: fetchedAt ? t - fetchedAt : null,
        error: e.error || null,
        fails: cache ? cache.fails || 0 : 0,
        nextTryAt: nextTryAt,
        nextRefreshAt: nextRefreshAt,
        fetched: !!e.fetched
      };
    }

    function request(opts) {
      var cityText = squash(opts && opts.city != null ? opts.city : '');
      return { city: cityText, key: cityKey(cityText), units: normUnits(opts && opts.units), force: !!(opts && opts.force) };
    }

    function tooShort(req) {
      return cells(req.key) < MIN_CITY;
    }

    function shortState(req) {
      return state(req.key ? 'short' : 'no-city', null, req, { error: req.key ? 'type at least ' + MIN_CITY + ' characters' : 'no city set' });
    }

    function fromCache(cache, req, why, fetched) {
      if (cache && cache.data) return state('stale', cache, req, { error: why, fetched: fetched });
      return state('error', cache, req, { error: why, fetched: fetched });
    }

    function sameCity(cache, req) {
      return cacheOk(cache) && cache.city === req.key;
    }

    async function run(req) {
      var t = nowFn();
      var stored = await store.load();
      var cache = sameCity(stored, req) ? stored : null;
      if (cache && cache.notFound && !req.force) return state('not-found', cache, req, { error: 'city not found' });
      if (isFresh(cache, req, t) && !req.force) return state('ok', cache, req);
      if (!onlineFn()) return fromCache(cache, req, 'offline', false);
      if (cache && cache.nextTryAt > t && !req.force) return fromCache(cache, req, cache.lastError || 'waiting to retry', false);

      var next = cache ? JSON.parse(JSON.stringify(cache)) : {
        v: CACHE_VERSION, city: req.key, cityText: req.city, place: null, notFound: false,
        units: req.units, data: null, fetchedAt: 0, fails: 0, nextTryAt: 0, lastError: ''
      };
      try {
        if (!next.place) {
          var place = await geocode(req.city);
          if (!place) {
            next.notFound = true;
            next.fails = 0;
            next.nextTryAt = 0;
            next.lastError = '';
            await store.save(next);
            return state('not-found', next, req, { error: 'city not found', fetched: true });
          }
          next.place = place;
          next.notFound = false;
        }
        var data = parseForecast(await getJson(forecastUrl(next.place.latitude, next.place.longitude, req.units)), { units: req.units });
        next.data = data;
        next.units = req.units;
        next.fetchedAt = nowFn();
        next.fails = 0;
        next.nextTryAt = 0;
        next.lastError = '';
        await store.save(next);
        return state('ok', next, req, { fetched: true });
      } catch (e) {
        next.fails = (next.fails || 0) + 1;
        next.nextTryAt = nowFn() + BACKOFF_MS[Math.min(next.fails, BACKOFF_MS.length) - 1];
        next.lastError = errorText(e);
        await store.save(next);
        return fromCache(next, req, next.lastError, true);
      }
    }

    /** Serialize every get() so that at most one request is ever in flight. */
    function get(opts) {
      var req = request(opts);
      if (tooShort(req)) return Promise.resolve(shortState(req));
      var p = chain.then(function () { return run(req); });
      chain = p.then(function () {}, function () {});
      return p;
    }

    function peek(opts) {
      var req = request(opts);
      if (tooShort(req)) return Promise.resolve(shortState(req));
      return store.load().then(function (stored) {
        var cache = sameCity(stored, req) ? stored : null;
        if (cache && cache.notFound) return state('not-found', cache, req, { error: 'city not found' });
        if (!cache || !cache.data) return state('error', cache, req, { error: (cache && cache.lastError) || 'no data yet' });
        return isFresh(cache, req, nowFn()) ? state('ok', cache, req) : state('stale', cache, req, { error: cache.lastError || 'refresh due' });
      });
    }

    return {
      get: get,
      peek: peek,
      busy: function () { return inFlight > 0; },
      requests: function () { return requests; },
      ttlMs: ttl
    };
  }

  var api = {
    KINDS: KINDS,
    CODE_GROUPS: CODE_GROUPS,
    DESCRIPTIONS: DESCRIPTIONS,
    LABELS: LABELS,
    CREDIT: CREDIT,
    CREDIT_URL: CREDIT_URL,
    MIN_CITY: MIN_CITY,
    TTL_MS: TTL_MS,
    TIMEOUT_MS: TIMEOUT_MS,
    BACKOFF_MS: BACKOFF_MS,
    STORAGE_KEY: STORAGE_KEY,
    CACHE_VERSION: CACHE_VERSION,
    API_UNITS: API_UNITS,
    kind: kind,
    describe: describe,
    label: label,
    normUnits: normUnits,
    unitLabels: unitLabels,
    geocodeUrl: geocodeUrl,
    splitCountryCode: splitCountryCode,
    forecastUrl: forecastUrl,
    parseGeocode: parseGeocode,
    parseForecast: parseForecast,
    placeLabel: placeLabel,
    lines: lines,
    updatedLabel: updatedLabel,
    cacheOk: cacheOk,
    createClient: createClient
  };
  PCD.weather = api;
  return api;
});
