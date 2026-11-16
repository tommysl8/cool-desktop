/* PixelClock Desktop shared core: query params, reduced motion, time and date text, safe storage, role classes and the
 * derived colours. Classic script, UMD, one global PCD; require() returns PCD.core in Node. No DOM access at load time;
 * PCD.TOKENS and the DOM are looked up when called.
 *
 * PCD.core
 *   param(name, fallback, search)      query value ('+' is a space, first match wins), else fallback; search defaults
 *                                      to location.search
 *   params(search)                     { name: value } of every pair (first wins)
 *   flag(name, fallback, search)       1/true/yes/on -> true, 0/false/no/off -> false, anything else -> fallback
 *   num(name, fallback, { min, max, int }, search)   a finite number, clamped; else fallback
 *   bool(value)                        the same words as flag() for any value; null when it is none of them
 *   clamp(v, lo, hi)  pad(n, width = 2, ch = '0')  lower(s) (the copy rule: trimmed, spaces collapsed, lower case)
 *   DAYS MONTHS ('sun', 'jan')  DAYS_LONG MONTHS_LONG ('sunday', 'january')
 *   timeParts(date, clock24)           { h, m, s, ampm } (12 h: h 1-12, ampm 'am'|'pm'; 24 h: h 0-23, ampm '')
 *   formatClock(h, m, clock24, { ampm = true, seconds })   '9:41 pm' | '9:41' (ampm false) | '21:41' | '09:05'
 *   formatTime(date, clock24, { ampm = true, seconds = false })   the same from a Date ('' for an invalid Date)
 *   formatHours(hours, clock24, opts)  fractional local hours to the nearest minute, mod 24: 7.45 -> '7:27 am' (strip
 *                                      times: { ampm: false } -> '7:27'; 24 h '07:27')
 *   formatDate(date)                   'sun nov 15', as the clock's corners say it, lower case
 *   dateParts(date)                    { weekday 'sun', weekdayLong 'sunday', month 'nov', monthLong 'november', day, year }
 *   agoText(ms)                        '' under 60 minutes, then '1 h ago' ... '47 h ago', then '2 d ago' (the weather's age)
 *   parseLocal(s)                      'YYYY-MM-DD[THH:MM[:SS]]' as a local Date (no time: 12:00), else null
 *   createClock({ at, frozen, now })   { now() -> Date, ms() -> number, offsetMs, frozen }: real time shifted so it
 *                                      starts at `at` (a Date or parseLocal text), or stopped there when frozen
 *   clockFromParams(search)            createClock from ?at=2026-10-31T21:00 and ?freeze=1 (previews and tests only)
 *   MOTION_QUERY  REDUCED_CLASS        '(prefers-reduced-motion: reduce)'  'pcd-reduced'
 *   reducedMotionQuery()               the '(prefers-reduced-motion: reduce)' MediaQueryList, or null
 *   reducedMotion(setting, search)     ?reducedMotion=1|0 wins (tests); then true or 'on' -> true, 'off' -> false;
 *                                      anything else ('auto', false, undefined) follows the media query
 *   watchReducedMotion(fn)             fn(matches) on every change of the media query; returns an unsubscribe function
 *   applyMotion(reduced, el)           toggles the class pcd-reduced on el (default <html>): pcd-base.css then stops
 *                                      every CSS animation
 *   storage(area)                      safe Web Storage (default localStorage; every access in try/catch):
 *                                      { available, get(key, fallback), set(key, value), remove(key),
 *                                        getJson(key, fallback), setJson(key, value) }; writes return true/false
 *   ROLES, roleClass(roles)            token roles of text runs -> pcd-base.css classes: 'text bold' -> 't-text t-bold'
 *
 * PCD.color (the derived colours: computed once a minute, never transitioned; reads PCD.TOKENS when called, else FALLBACK)
 *   int(c) hex(c) rgb(c)               '#rrggbb' | '#rgb' | 0xRRGGBB | [r, g, b] -> 0xRRGGBB | '#rrggbb' | [r, g, b]
 *   mix(a, b, t)                       0xRRGGBB, per channel a + (b - a) * t rounded, t clamped to 0..1 (as PC.mix)
 *   luminance(c), contrast(a, b)       WCAG 2.2 (same maths as tools/lib/color.mjs)
 *   tokens()                           { token: 0xRRGGBB } of the palette in use
 *   clock(themeClock)                  the big clock: mix(theme clock, text, 0.25), or text when that is under 4.5:1 on bg
 *   bar(v)                             a strip bar: mix(line, wood, min(1, 1.4 v)) for the light level v (0..1)
 *   FALLBACK                           the built-in copy of design/tokens.json (tests keep the two equal)
 * clock and bar return '#rrggbb' strings, ready for CSS variables and canvas fills.
 */
(function (root, factory) {
  var api = factory(root.PCD || (root.PCD = {}), root);
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (PCD, root) {
  'use strict';

  var DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
  var MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  var DAYS_LONG = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  var MONTHS_LONG = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october',
    'november', 'december'];
  var ROLES = ['text', 'muted', 'faint', 'accent', 'frame', 'ring', 'wood', 'line', 'clock', 'bold', 'field'];
  var MOTION_QUERY = '(prefers-reduced-motion: reduce)';
  var REDUCED_CLASS = 'pcd-reduced';

  // ------------------------------------------------------------------------------------------------ query params

  function currentSearch() {
    try {
      return root.location && typeof root.location.search === 'string' ? root.location.search : '';
    } catch (e) {
      return '';
    }
  }

  function pairs(search) {
    var s = search === undefined ? currentSearch() : String(search || '');
    if (s.charAt(0) === '?') s = s.slice(1);
    var out = [];
    if (!s) return out;
    var parts = s.split('&');
    for (var i = 0; i < parts.length; i++) {
      if (!parts[i]) continue;
      var eq = parts[i].indexOf('=');
      var k = eq === -1 ? parts[i] : parts[i].slice(0, eq);
      var v = eq === -1 ? '' : parts[i].slice(eq + 1);
      try {
        k = decodeURIComponent(k.replace(/\+/g, ' '));
        v = decodeURIComponent(v.replace(/\+/g, ' '));
      } catch (e) {
        continue;
      }
      out.push([k, v]);
    }
    return out;
  }

  /** The query value of `name` (first match), or `fallback` when it is absent. */
  function param(name, fallback, search) {
    var list = pairs(search);
    for (var i = 0; i < list.length; i++) if (list[i][0] === name) return list[i][1];
    return fallback;
  }

  /** Every query pair as { name: value } (the first of repeated names wins). */
  function params(search) {
    var out = {};
    var list = pairs(search);
    for (var i = 0; i < list.length; i++) if (!Object.prototype.hasOwnProperty.call(out, list[i][0])) out[list[i][0]] = list[i][1];
    return out;
  }

  /** true for 1/true/yes/on, false for 0/false/no/off (any case, trimmed), null otherwise. Booleans pass through. */
  function bool(value) {
    if (value === true || value === false) return value;
    if (value === 1) return true;
    if (value === 0) return false;
    if (typeof value !== 'string') return null;
    var v = value.trim().toLowerCase();
    if (v === '1' || v === 'true' || v === 'yes' || v === 'on') return true;
    if (v === '0' || v === 'false' || v === 'no' || v === 'off') return false;
    return null;
  }

  function flag(name, fallback, search) {
    var b = bool(param(name, null, search));
    return b === null ? fallback : b;
  }

  function clamp(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
  }

  function num(name, fallback, opts, search) {
    var o = opts || {};
    var raw = param(name, null, search);
    if (raw === null || String(raw).trim() === '') return fallback;
    var n = Number(raw);
    if (!isFinite(n)) return fallback;
    if (o.int) n = Math.round(n);
    if (typeof o.min === 'number') n = Math.max(o.min, n);
    if (typeof o.max === 'number') n = Math.min(o.max, n);
    return n;
  }

  /** Left-pad n to width (default 2) with ch (default '0'). */
  function pad(n, width, ch) {
    var s = String(n);
    var w = width === undefined ? 2 : width;
    var c = ch === undefined ? '0' : String(ch);
    while (s.length < w) s = c + s;
    return s;
  }

  /** The copy rule: trimmed, runs of white space collapsed, lower case. */
  function lower(s) {
    return String(s == null ? '' : s).trim().replace(/\s+/g, ' ').toLowerCase();
  }

  // ------------------------------------------------------------------------------------------------ time and date

  /** A valid Date from any realm (instanceof fails across frames and vm contexts). */
  function validDate(d) {
    return Object.prototype.toString.call(d) === '[object Date]' && !isNaN(d.getTime());
  }

  function timeParts(date, clock24) {
    var h = date.getHours();
    return {
      h: clock24 ? h : (h % 12 || 12),
      m: date.getMinutes(),
      s: date.getSeconds(),
      ampm: clock24 ? '' : (h < 12 ? 'am' : 'pm')
    };
  }

  /** '9:41 pm' (12 h), '9:41' (12 h, ampm false), '21:41' / '09:05' (24 h); opts.seconds appends ':ss'. */
  function formatClock(h, m, clock24, opts) {
    var o = opts || {};
    if (!isFinite(h) || !isFinite(m)) return '';
    var hh = ((Math.floor(h) % 24) + 24) % 24;
    var mm = clamp(Math.floor(m), 0, 59);
    var t = (clock24 ? pad(hh) : String(hh % 12 || 12)) + ':' + pad(mm);
    if (o.seconds !== undefined && o.seconds !== null && isFinite(o.seconds)) t += ':' + pad(clamp(Math.floor(o.seconds), 0, 59));
    if (clock24 || o.ampm === false) return t;
    return t + ' ' + (hh < 12 ? 'am' : 'pm');
  }

  function formatTime(date, clock24, opts) {
    if (!validDate(date)) return '';
    var o = opts || {};
    return formatClock(date.getHours(), date.getMinutes(), clock24, { ampm: o.ampm, seconds: o.seconds ? date.getSeconds() : null });
  }

  function formatHours(hours, clock24, opts) {
    if (typeof hours !== 'number' || !isFinite(hours)) return '';
    var total = Math.round(hours * 60);
    total = ((total % 1440) + 1440) % 1440;
    return formatClock(Math.floor(total / 60), total % 60, clock24, opts);
  }

  function formatDate(date) {
    if (!validDate(date)) return '';
    return DAYS[date.getDay()] + ' ' + MONTHS[date.getMonth()] + ' ' + date.getDate();
  }

  function dateParts(date) {
    if (!validDate(date)) return null;
    return {
      weekday: DAYS[date.getDay()],
      weekdayLong: DAYS_LONG[date.getDay()],
      month: MONTHS[date.getMonth()],
      monthLong: MONTHS_LONG[date.getMonth()],
      day: date.getDate(),
      year: date.getFullYear()
    };
  }

  function agoText(ms) {
    if (typeof ms !== 'number' || !(ms >= 3600000)) return '';
    var h = Math.floor(ms / 3600000);
    if (h < 48) return h + ' h ago';
    return Math.floor(h / 24) + ' d ago';
  }

  function parseLocal(s) {
    var m = /^(\d{4})-(\d\d)-(\d\d)(?:[T ](\d\d):(\d\d)(?::(\d\d))?)?$/.exec(String(s == null ? '' : s).trim());
    if (!m) return null;
    var y = +m[1], mo = +m[2], d = +m[3];
    var hh = m[4] === undefined ? 12 : +m[4], mi = m[5] === undefined ? 0 : +m[5], ss = m[6] === undefined ? 0 : +m[6];
    if (mo < 1 || mo > 12 || d < 1 || d > 31 || hh > 23 || mi > 59 || ss > 59) return null;
    var date = new Date(y, mo - 1, d, hh, mi, ss, 0);
    if (date.getFullYear() !== y || date.getMonth() !== mo - 1 || date.getDate() !== d) return null;
    return date;
  }

  function createClock(opts) {
    var o = opts || {};
    var realNow = typeof o.now === 'function' ? o.now : function () { return Date.now(); };
    var at = Object.prototype.toString.call(o.at) === '[object Date]' ? o.at : (o.at ? parseLocal(o.at) : null);
    var start = at && validDate(at) ? at.getTime() : null;
    var frozen = !!o.frozen && start !== null;
    var offsetMs = start === null ? 0 : start - realNow();
    function ms() { return frozen ? start : realNow() + offsetMs; }
    return { now: function () { return new Date(ms()); }, ms: ms, offsetMs: offsetMs, frozen: frozen };
  }

  function clockFromParams(search) {
    return createClock({ at: param('at', null, search), frozen: flag('freeze', false, search) });
  }

  // ------------------------------------------------------------------------------------------------ reduced motion

  function reducedMotionQuery() {
    try {
      return root.matchMedia ? root.matchMedia(MOTION_QUERY) : null;
    } catch (e) {
      return null;
    }
  }

  function reducedMotion(setting, search) {
    var forced = bool(param('reducedMotion', null, search));
    if (forced !== null) return forced;
    if (setting === true || setting === 'on') return true;
    if (setting === 'off') return false;
    var mq = reducedMotionQuery();
    return !!(mq && mq.matches);
  }

  function watchReducedMotion(fn) {
    var mq = reducedMotionQuery();
    if (!mq || typeof fn !== 'function') return function () {};
    var h = function (e) { fn(!!(e && 'matches' in e ? e.matches : mq.matches)); };
    try {
      if (mq.addEventListener) mq.addEventListener('change', h);
      else if (mq.addListener) mq.addListener(h);
    } catch (e) {
      return function () {};
    }
    return function () {
      try {
        if (mq.removeEventListener) mq.removeEventListener('change', h);
        else if (mq.removeListener) mq.removeListener(h);
      } catch (e) { /* gone */ }
    };
  }

  function applyMotion(reduced, el) {
    var target = el || (root.document ? root.document.documentElement : null);
    if (target && target.classList) target.classList.toggle(REDUCED_CLASS, !!reduced);
    return !!reduced;
  }

  // ------------------------------------------------------------------------------------------------ storage

  function storage(area) {
    var s = area;
    if (s === undefined) {
      try {
        s = root.localStorage;
      } catch (e) {
        s = null;
      }
    }
    var available = false;
    if (s) {
      try {
        var probe = '__pcd_probe__';
        s.setItem(probe, '1');
        s.removeItem(probe);
        available = true;
      } catch (e) {
        available = false;
      }
    }
    function get(key, fallback) {
      var fb = fallback === undefined ? null : fallback;
      if (!s) return fb;
      try {
        var v = s.getItem(key);
        return v === null || v === undefined ? fb : String(v);
      } catch (e) {
        return fb;
      }
    }
    function set(key, value) {
      if (!s) return false;
      try {
        s.setItem(key, String(value));
        return true;
      } catch (e) {
        return false;
      }
    }
    function remove(key) {
      if (!s) return false;
      try {
        s.removeItem(key);
        return true;
      } catch (e) {
        return false;
      }
    }
    function getJson(key, fallback) {
      var fb = fallback === undefined ? null : fallback;
      var v = get(key, null);
      if (v === null) return fb;
      try {
        return JSON.parse(v);
      } catch (e) {
        return fb;
      }
    }
    function setJson(key, value) {
      var text;
      try {
        text = JSON.stringify(value);
      } catch (e) {
        return false;
      }
      return text === undefined ? false : set(key, text);
    }
    return { available: available, get: get, set: set, remove: remove, getJson: getJson, setJson: setJson };
  }

  function roleClass(roles) {
    return String(roles == null ? '' : roles).split(/\s+/).filter(Boolean).map(function (r) { return 't-' + r; }).join(' ');
  }

  // ------------------------------------------------------------------------------------------------ colour

  /** The built-in copy of design/tokens.json (palette and derived rules); PCD.TOKENS wins when it is loaded. */
  var FALLBACK = {
    colors: {
      bg: 0x141016, panel: 0x1d181f, field: 0x2a2229, line: 0x3a3138, text: 0xece4d8, muted: 0xa99d91, faint: 0x978d83,
      accent: 0xff9a3c, frame: 0x9a6a40, ring: 0xc47a2c, wood: 0x6b4428, 'wood-dark': 0x4a2e1a
    },
    derived: {
      clock: { mix: 0.25, toward: 'text', min: 4.5, on: 'bg', fallback: 'text' },
      bar: { from: 'line', to: 'wood', gain: 1.4, now: 'accent' }
    }
  };

  function channel(v) {
    var n = Math.round(Number(v));
    return n < 0 ? 0 : n > 255 ? 255 : (n || 0);
  }

  function int(c) {
    if (typeof c === 'number' && isFinite(c)) return (c >>> 0) & 0xffffff;
    if (typeof c === 'string') {
      var s = c.trim();
      if (/^#[0-9a-fA-F]{3}$/.test(s)) s = '#' + s[1] + s[1] + s[2] + s[2] + s[3] + s[3];
      if (/^#[0-9a-fA-F]{6}$/.test(s)) return parseInt(s.slice(1), 16);
    }
    if (c && typeof c === 'object' && typeof c.length === 'number' && c.length >= 3) return (channel(c[0]) << 16) | (channel(c[1]) << 8) | channel(c[2]);
    throw new TypeError('PCD.color: not a colour: ' + String(c));
  }

  function hex(c) {
    return '#' + ('00000' + int(c).toString(16)).slice(-6);
  }

  function rgb(c) {
    var n = int(c);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }

  function mix(a, b, t) {
    var x = int(a), y = int(b);
    var f = typeof t === 'number' && t === t ? clamp(t, 0, 1) : 0;
    var r = Math.round(((x >> 16) & 255) + (((y >> 16) & 255) - ((x >> 16) & 255)) * f);
    var g = Math.round(((x >> 8) & 255) + (((y >> 8) & 255) - ((x >> 8) & 255)) * f);
    var bl = Math.round((x & 255) + ((y & 255) - (x & 255)) * f);
    return (r << 16) | (g << 8) | bl;
  }

  function lin(c8) {
    var c = c8 / 255;
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  }

  function luminance(c) {
    var p = rgb(c);
    return 0.2126 * lin(p[0]) + 0.7152 * lin(p[1]) + 0.0722 * lin(p[2]);
  }

  function contrast(a, b) {
    var la = luminance(a), lb = luminance(b);
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
  }

  function table() {
    var T = PCD.TOKENS;
    return T && T.int && T.derived ? { colors: T.int, derived: T.derived } : FALLBACK;
  }

  function tokens() {
    var c = table().colors, out = {};
    for (var k in c) if (Object.prototype.hasOwnProperty.call(c, k)) out[k] = c[k];
    return out;
  }

  function clockColor(themeClock) {
    var t = table(), D = t.derived.clock, C = t.colors;
    if (themeClock === undefined || themeClock === null) return hex(C[D.fallback]);
    var c;
    try {
      c = mix(themeClock, C[D.toward], D.mix);
    } catch (e) {
      return hex(C[D.fallback]);
    }
    return contrast(c, C[D.on]) >= D.min ? hex(c) : hex(C[D.fallback]);
  }

  function barColor(v) {
    var t = table(), D = t.derived.bar, C = t.colors;
    var x = typeof v === 'number' && v === v ? clamp(v, 0, 1) : 0;
    return hex(mix(C[D.from], C[D.to], Math.min(1, D.gain * x)));
  }

  var color = {
    FALLBACK: FALLBACK,
    int: int,
    hex: hex,
    rgb: rgb,
    mix: mix,
    luminance: luminance,
    contrast: contrast,
    tokens: tokens,
    clock: clockColor,
    bar: barColor
  };

  var api = {
    param: param,
    params: params,
    flag: flag,
    num: num,
    bool: bool,
    clamp: clamp,
    pad: pad,
    lower: lower,
    DAYS: DAYS,
    MONTHS: MONTHS,
    DAYS_LONG: DAYS_LONG,
    MONTHS_LONG: MONTHS_LONG,
    timeParts: timeParts,
    formatClock: formatClock,
    formatTime: formatTime,
    formatHours: formatHours,
    formatDate: formatDate,
    dateParts: dateParts,
    agoText: agoText,
    parseLocal: parseLocal,
    createClock: createClock,
    clockFromParams: clockFromParams,
    MOTION_QUERY: MOTION_QUERY,
    REDUCED_CLASS: REDUCED_CLASS,
    reducedMotionQuery: reducedMotionQuery,
    reducedMotion: reducedMotion,
    watchReducedMotion: watchReducedMotion,
    applyMotion: applyMotion,
    storage: storage,
    ROLES: ROLES,
    roleClass: roleClass,
    color: color
  };
  PCD.core = api;
  PCD.color = color;
  return api;
});
