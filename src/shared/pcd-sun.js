/* PixelClock Desktop shared: sun times, the engine's time-of-day input and the four phases.
 * Classic script, UMD, global PCD (PCD.sun). Pure logic: no DOM, no timers, no network, no storage.
 *
 * The clock engine knows nothing about places: every theme lights its scene from ctx.hourFloat (0-24) through its own
 * hand-tuned curves (mid-latitude daylight: most themes cross half brightness near 7 and 17 h, summer near 6.2 and
 * 19.1, july4 near 5.6 and 20.3). tools/lib/anchors.mjs measures those crossings per theme (PCD.ANCHORS[id] = { rise,
 * set, curve }). To follow the real sun the host keeps ctx.hours/minutes real (the drawn time stays right) and only
 * bends the light:
 *     var s = PCD.sun.resolve(now, { id: themeId, sun: PCD.sun.today(weatherData, now), follow: settings.sunTimes });
 *     ctx.hourFloat = s.hourFloat;   // every step (or PCD.sun.remap(PCD.sun.hours(now), s.sun, s.anchor))
 *     view.phase = s.phase;          // 'dawn' | 'day' | 'sunset' | 'night', once a minute
 *
 * All hours here are wall-clock hours of the computer (0-24, the reading of its local clock), the same scale as
 * ctx.hourFloat, so a DST change needs no special case: on the day of the change the wall clock simply skips or repeats
 * an hour of night and both the sun times and the host's hourFloat are read off that same clock.
 *
 * Phase boundaries (the same in every piece): dawn = [sunrise - 1 h, sunrise + 1 h), day = [sunrise + 1 h,
 * sunset - 1 h), sunset = [sunset - 1 h, sunset + 1 h), night = the rest. Why one hour either side:
 *   - outdoors, civil twilight (sun 0-6 degrees below the horizon) lasts 30-40 min at 40-55 degrees of latitude and
 *     the golden hour (sun under 6 degrees) about as long on the other side, so +-1 h is the stretch people see as dawn
 *     (or dusk): the coloured sky before and the low warm light after;
 *   - in the engine, the default sky's warm keys sit at 7 and 17 h inside transitions from 5.5 to 9 and 15.5 to 18.5,
 *     and the anchors (half-brightness crossings) land right on those warm keys, so +-1 h around an anchor covers the
 *     visibly orange part of every theme (a narrower window, e.g. +-45 min, would label orange frames as day/night);
 *   - the remap has slope 1 inside both windows, so the window edges map exactly onto the theme's window edges: the
 *     label computed from the real sun always equals the label of the remapped theme hour (the picture).
 * Intervals are half-open, so every instant has exactly one phase.
 *
 * Polar day and night (no sunrise or no sunset on the day): today() returns { rise: null, set: null, polar: 'day' |
 * 'night' }; remap() then keeps the picture inside the theme's day or night all day and phase() says 'day' or 'night'.
 * Numeric sun times keep the identity rules (LIMITS): times that are missing, too early, too late or too close
 * together leave the theme's own light untouched.
 */
(function (root, factory) {
  var api = factory(root.PCD || (root.PCD = {}), root);
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (PCD, root) {
  'use strict';

  /** Hours either side of sunrise and sunset that count as dawn and sunset (see above). */
  var TWILIGHT = 1;
  var PHASES = ['dawn', 'day', 'sunset', 'night'];
  /** Real sun times outside these limits leave the theme's own curve untouched (the identity rules). */
  var LIMITS = { minRise: 1.5, maxSet: 22.5, minDay: 4 };
  var HOUR_MS = 3600000;
  var DAY_S = 86400;
  /** Phase edges are exact to 1e-9 h (3.6 microseconds); see within(). */
  var EDGE_EPS = 1e-9;

  function num(v) {
    return typeof v === 'number' && isFinite(v) ? v : null;
  }

  function round2(v) {
    return Math.round(v * 100) / 100;
  }

  function mod24(x) {
    var r = x % 24;
    return r < 0 ? r + 24 : r;
  }

  /** 0..24 inclusive stays as it is (24 is a valid end point); anything else wraps around the clock. */
  function wrap24(x) {
    return x >= 0 && x <= 24 ? x : mod24(x);
  }

  function toDate(now) {
    if (now instanceof Date) return isFinite(now.getTime()) ? now : null;
    if (typeof now === 'number' && isFinite(now)) return new Date(now);
    if (now == null) return new Date();
    return null;
  }

  /** A curve rising to full light 1.5 h after sunrise and falling 1.5 h before sunset: 0.5 at exactly rise and set. */
  function simpleCurve(rise, set) {
    var out = [];
    for (var i = 0; i < 48; i++) {
      var h = i / 2;
      var v = Math.min((h - (rise - 1.5)) / 3, ((set + 1.5) - h) / 3);
      out.push(round2(Math.max(0, Math.min(1, v))));
    }
    return out;
  }

  /** The default sky's orange keys (the anchors' own fallback), with a matching light curve for the sun strip. */
  var FALLBACK = Object.freeze({ rise: 7, set: 17, curve: Object.freeze(simpleCurve(7, 17)) });

  function hasTimes(r) {
    return !!r && typeof r === 'object' && num(r.rise) !== null && num(r.set) !== null && r.set > r.rise;
  }

  /** An anchor the remap can use: its four window edges strictly inside (0, 24) and in order. */
  function saneAnchor(a) {
    return hasTimes(a) && a.rise - TWILIGHT > 0 && a.set + TWILIGHT < 24 && a.set - a.rise > 2 * TWILIGHT;
  }

  function isPolar(sun) {
    return !!sun && typeof sun === 'object' && (sun.polar === 'day' || sun.polar === 'night');
  }

  /** Numeric sun times the remap follows (the identity rules, inverted). */
  function usableTimes(sun) {
    return hasTimes(sun) && sun.rise >= LIMITS.minRise && sun.set <= LIMITS.maxSet && sun.set - sun.rise >= LIMITS.minDay;
  }

  /** True when these sun times drive the picture: usable numeric times, or a polar day or night. */
  function usable(sun) {
    return isPolar(sun) || usableTimes(sun);
  }

  /** Wall-clock hours of a Date or ms timestamp (default: now): h + min/60 + s/3600 + ms/3600000. */
  function hours(now) {
    var d = toDate(now);
    if (!d) return NaN;
    return d.getHours() + d.getMinutes() / 60 + d.getSeconds() / 3600 + d.getMilliseconds() / HOUR_MS;
  }

  /**
   * Wall-clock hours of the instant `ms` measured from the local midnight that starts the day of `ref`: the plain
   * clock reading when both fall on the same local date, +24 per day later, -24 per day earlier.
   */
  function wallHours(ms, ref) {
    var d = new Date(ms);
    var r = toDate(ref);
    var days = Math.round((Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) -
      Date.UTC(r.getFullYear(), r.getMonth(), r.getDate())) / (24 * HOUR_MS));
    return days * 24 + d.getHours() + d.getMinutes() / 60 + d.getSeconds() / 3600 + d.getMilliseconds() / HOUR_MS;
  }

  /** Approximate solar declination in degrees (+23.4 in June, -23.4 in December) for the local date of `date`. */
  function declination(date) {
    var d = toDate(date);
    var n = Math.round((Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) - Date.UTC(d.getFullYear(), 0, 0)) / (24 * HOUR_MS));
    return -23.44 * Math.cos(2 * Math.PI * (n + 10) / 365.24);
  }

  function firstOf(a) {
    return Array.isArray(a) ? num(a[0]) : null;
  }

  /** The fields today() needs, from raw Open-Meteo JSON (timeformat=unixtime) or from PCD.weather's parsed data. */
  function sunFields(forecast) {
    if (!forecast || typeof forecast !== 'object') return null;
    if (forecast.daily && typeof forecast.daily === 'object') {
      var d = forecast.daily;
      return { day: firstOf(d.time), rise: firstOf(d.sunrise), set: firstOf(d.sunset),
        offset: num(forecast.utc_offset_seconds), lat: num(forecast.latitude) };
    }
    if (forecast.data && typeof forecast.data === 'object' && !('day' in forecast)) return sunFields(forecast.data);
    return { day: num(forecast.day), rise: num(forecast.sunrise), set: num(forecast.sunset),
      offset: num(forecast.utcOffset), lat: num(forecast.latitude) };
  }

  /** 'day' / 'night' when the day has no sunrise or no sunset, else null (bad data at an ordinary latitude). */
  function polarKind(f, length, now) {
    if (length >= DAY_S - 60) return 'day'; // rises as the day starts and sets as it ends
    // Polar days and nights only happen beyond about 65.7 degrees; 60 leaves room for grid-snapped coordinates.
    if (f.lat === null || Math.abs(f.lat) < 60) return null;
    var dec = declination(now);
    if (Math.abs(dec) < 1) return null; // around the equinoxes every place but the poles has a sunrise and a sunset
    return (f.lat > 0) === (dec > 0) ? 'day' : 'night';
  }

  /**
   * today(forecast, now) -> { rise, set, polar: null } in wall-clock hours of the computer (set may pass 24 when the
   * sun sets after midnight), { rise: null, set: null, polar: 'day' | 'night' } on a day without sunrise or sunset,
   * or null when the forecast is not for the computer's local today (e.g. yesterday's cache) or has no usable data.
   * forecast: raw Open-Meteo JSON (daily.time/sunrise/sunset in unix seconds, utc_offset_seconds, latitude) or the
   * parsed data of PCD.weather ({ day, sunrise, sunset, utcOffset, latitude }) or a PCD.weather state ({ data }).
   */
  function today(forecast, now) {
    var f = sunFields(forecast);
    var t = toDate(now);
    if (!f || f.day === null || !t) return null;
    // The forecast's calendar day at the location: its local midnight + 12 h (safe from a DST offset change),
    // read with the location's UTC offset (the computer's own offset when the forecast has none).
    var offset = f.offset !== null ? f.offset : -new Date(f.day * 1000).getTimezoneOffset() * 60;
    var noon = new Date((f.day + DAY_S / 2 + offset) * 1000);
    if (noon.getUTCFullYear() !== t.getFullYear() || noon.getUTCMonth() !== t.getMonth() || noon.getUTCDate() !== t.getDate()) return null;
    var lo = f.day - DAY_S / 2;
    var hi = f.day + 2 * DAY_S;
    var riseOk = f.rise !== null && f.rise >= lo && f.rise <= hi;
    var setOk = f.set !== null && f.set >= lo && f.set <= hi;
    var length = riseOk && setOk ? f.set - f.rise : NaN;
    if (length >= 60 && length <= DAY_S - 60) {
      return { rise: wallHours(f.rise * 1000, t), set: wallHours(f.set * 1000, t), polar: null };
    }
    var polar = polarKind(f, length, t);
    return polar ? { rise: null, set: null, polar: polar } : null;
  }

  /** The anchor of a theme: (anchors || PCD.ANCHORS)[id] when it is usable, else FALLBACK. */
  function anchor(id, anchors) {
    var table = anchors || PCD.ANCHORS || null;
    var a = table && typeof id === 'string' && Object.prototype.hasOwnProperty.call(table, id) ? table[id] : null;
    if (!saneAnchor(a)) return FALLBACK;
    if (Array.isArray(a.curve) && a.curve.length === 48) return a;
    return { rise: a.rise, set: a.set, curve: simpleCurve(a.rise, a.set) };
  }

  function polarHour(x, kind, a) {
    if (kind === 'night') {
      // Before noon: midnight .. the dawn window's start; after noon: the sunset window's end .. midnight. The
      // picture stays in the theme's night all day, brightest (its faintest twilight) around noon, midnight fixed.
      return x < 12 ? x * (a.rise - TWILIGHT) / 12 : a.set + TWILIGHT + (x - 12) * (24 - a.set - TWILIGHT) / 12;
    }
    // Polar day: the theme's day from just after its dawn window (00:00) to just before its sunset window (24:00).
    return a.rise + TWILIGHT + x * (a.set - a.rise - 2 * TWILIGHT) / 24;
  }

  /**
   * remap(h, sun, anchor) -> the hourFloat the theme should see at wall-clock hour h. Piecewise linear through
   * (0,0), (sun.rise -/+ 1, anchor.rise -/+ 1), (sun.set -/+ 1, anchor.set -/+ 1), (24,24): slope 1 inside both
   * twilight windows, an even stretch over day and night, midnight fixed. Identity when sun is null or its times are
   * not usable (rise < 1.5, set > 22.5, set - rise < 4, missing). Polar sun objects keep the theme in its night or day.
   * A missing or broken anchor means FALLBACK.
   */
  function remap(h, sun, anc) {
    var x = Number(h);
    if (!isFinite(x)) return h;
    x = wrap24(x);
    var a = saneAnchor(anc) ? anc : FALLBACK;
    if (isPolar(sun)) return polarHour(x, sun.polar, a);
    if (!usableTimes(sun)) return x;
    var xs = [0, sun.rise - TWILIGHT, sun.rise + TWILIGHT, sun.set - TWILIGHT, sun.set + TWILIGHT, 24];
    var ys = [0, a.rise - TWILIGHT, a.rise + TWILIGHT, a.set - TWILIGHT, a.set + TWILIGHT, 24];
    for (var i = 0; i < 5; i++) {
      if (x < xs[i + 1] || i === 4) return ys[i] + (x - xs[i]) * (ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i]);
    }
    return x;
  }

  /**
   * x inside the half-open interval [lo, hi) of the 24 h circle. Both edges are moved EDGE_EPS earlier, so an hour a
   * floating-point hair before an edge counts as on it (8.3 - 1 is 7.300000000000001 in binary): the label of a wall
   * hour and of its remapped theme hour then agree at the edges too.
   */
  function within(x, lo, hi) {
    if (!(hi > lo)) return false;
    if (hi - lo >= 24) return true;
    var l = lo - EDGE_EPS;
    var u = hi - EDGE_EPS;
    if (l >= 0 && u <= 24) return x >= l && x < u; // the usual case: no wrap
    l = mod24(l);
    u = mod24(u);
    return l < u ? x >= l && x < u : x >= l || x < u;
  }

  /**
   * phase(h, ref) -> 'dawn' | 'day' | 'sunset' | 'night' for wall-clock hour h: dawn [rise-1, rise+1), day
   * [rise+1, set-1), sunset [set-1, set+1), else night. ref: the real sun times when they drive the picture, else
   * the theme's anchor (use ref() to choose). A polar ref gives 'day' or 'night' all day; a missing ref uses
   * FALLBACK; windows crossing midnight wrap; when the two windows overlap (under 2 h of daylight) they meet at
   * solar noon and there is no day.
   */
  function phase(h, ref) {
    if (isPolar(ref)) return ref.polar;
    var r = hasTimes(ref) ? ref : FALLBACK;
    var x = wrap24(Number(h));
    if (!isFinite(x)) return 'night';
    if (x === 24) x = 0;
    var a = r.rise - TWILIGHT;
    var b = r.rise + TWILIGHT;
    var c = r.set - TWILIGHT;
    var e = r.set + TWILIGHT;
    if (b > c) b = c = (r.rise + r.set) / 2;
    if (within(x, a, b)) return 'dawn';
    if (within(x, b, c)) return 'day';
    if (within(x, c, e)) return 'sunset';
    return 'night';
  }

  /** The times phase() should use: the sun when usable(sun), else the anchor (FALLBACK when that is broken too). */
  function ref(sun, anc) {
    if (usable(sun)) return sun;
    return saneAnchor(anc) ? anc : FALLBACK;
  }

  /**
   * resolve(now, { id, anchors, sun, forecast, follow }) -> everything a host needs for one moment:
   *   { hour, hourFloat, phase, source: 'sun' | 'theme', polar, sun, ref, anchor }
   * now: a Date or ms (default: the current time); id: the theme shown; anchors: defaults to PCD.ANCHORS; sun: from
   * today(), or forecast to compute it here;
   * follow: the "follow the real sun" setting (sunTimes), default true. With follow off, no sun, or sun times that
   * are not usable, the theme keeps its own hours (hourFloat === hour) and phases come from its anchor.
   */
  function resolve(now, opts) {
    var o = opts || {};
    var t = toDate(now) || new Date(); // a missing or invalid time means now
    var h = hours(t);
    var anc = anchor(o.id, o.anchors);
    var sun = o.sun !== undefined ? o.sun : (o.forecast ? today(o.forecast, t) : null);
    if (o.follow === false || !usable(sun)) sun = null;
    var r = sun || anc;
    return {
      hour: h,
      hourFloat: sun ? remap(h, sun, anc) : h,
      phase: phase(h, r),
      source: sun ? 'sun' : 'theme',
      polar: sun && sun.polar ? sun.polar : null,
      sun: sun,
      ref: r,
      anchor: anc
    };
  }

  function level(c, h) {
    var x = wrap24(h) * 2;
    var i = Math.floor(x);
    var f = x - i;
    var v0 = c[i % 48];
    var v1 = c[(i + 1) % 48];
    return v0 + (v1 - v0) * f;
  }

  /**
   * curve(anchor, sun) -> 48 light levels 0..1, one per wall-clock half hour (cell i starts at i/2 h): the theme's
   * measured curve after the remap, for the sun strip. Without usable sun times it is the anchor's own curve.
   */
  function curve(anc, sun) {
    var a = saneAnchor(anc) ? anc : FALLBACK;
    var c = Array.isArray(a.curve) && a.curve.length === 48 ? a.curve : simpleCurve(a.rise, a.set);
    var out = [];
    for (var i = 0; i < 48; i++) out.push(round2(level(c, remap(i / 2, sun, a))));
    return out;
  }

  /**
   * phaseHour(name, anchor) -> a theme hourFloat that shows that phase at its most typical (previews, style tile,
   * contact sheets): dawn = the anchor's rise, day = midway, sunset = the anchor's set, night = the middle of the
   * night (0 for rise 7 / set 17). Throws for an unknown phase.
   */
  function phaseHour(name, anc) {
    var a = saneAnchor(anc) ? anc : FALLBACK;
    if (name === 'dawn') return a.rise;
    if (name === 'day') return (a.rise + a.set) / 2;
    if (name === 'sunset') return a.set;
    if (name === 'night') return mod24((a.set + a.rise + 24) / 2);
    throw new Error('phaseHour: unknown phase "' + name + '"');
  }

  function pad2(n) {
    return (n < 10 ? '0' : '') + n;
  }

  /** '7:05 am' (12 h) or '07:05' (24 h) for wall-clock hours (wrapped to 0-24, rounded to the minute). */
  function clockText(h, clock24) {
    var x = Number(h);
    if (!isFinite(x)) return '';
    var m = Math.round(mod24(x) * 60) % 1440;
    var hh = Math.floor(m / 60);
    var mm = m % 60;
    if (clock24) return pad2(hh) + ':' + pad2(mm);
    return ((hh % 12) || 12) + ':' + pad2(mm) + (hh < 12 ? ' am' : ' pm');
  }

  /** Short text for the sun times: '7:12 am - 4:38 pm', 'polar day', 'polar night', or '' without usable times. */
  function text(sun, clock24) {
    if (isPolar(sun)) return 'polar ' + sun.polar;
    if (!hasTimes(sun)) return '';
    return clockText(sun.rise, clock24) + ' - ' + clockText(sun.set, clock24);
  }

  var api = {
    TWILIGHT: TWILIGHT,
    PHASES: PHASES,
    LIMITS: LIMITS,
    FALLBACK: FALLBACK,
    hours: hours,
    wallHours: wallHours,
    declination: declination,
    today: today,
    usable: usable,
    anchor: anchor,
    remap: remap,
    phase: phase,
    ref: ref,
    resolve: resolve,
    curve: curve,
    phaseHour: phaseHour,
    clockText: clockText,
    text: text
  };
  PCD.sun = api;
  return api;
});
