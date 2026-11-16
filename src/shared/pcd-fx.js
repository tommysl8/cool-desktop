/* PixelClock Desktop shared: weather in the scene. Classic script, UMD, global PCD (PCD.fx).
 *
 * The weather kind (PCD.weather.kind(WMO code)) picks one of six effect families, each a subtle tint of the finished
 * scene plus, for precipitation, a few falling pixels:
 *   clear (clear, unknown) | cloud (partly, cloudy) | fog | rain (drizzle, rain, freezing) | snow | storm (thunder)
 * TINTS and PARTICLES hold the exact values (one entry per family); params() returns them for one situation
 * so any host (or the still renderer) can apply them its own way. create(seed) is the stock implementation:
 *   var fx = PCD.fx.create(seed);
 *   fx.set(PCD.fx.input(weatherState.data, { indoor: PCD.fx.isIndoor(themeId), reducedMotion: rm }));
 *   PCD.hook.before = fx.apply;   // scene pixels only, before the clock is drawn
 *   ...each engine step: fx.step(1 / 30);
 * Weather off or no data: fx.set(null), and apply() changes nothing. Deterministic for a seed (tests hash frames).
 * Pure JS on the engine's 64x64 0xRRGGBB pixel array: no DOM, no timers, no Math.random.
 */
(function (root, factory) {
  var api = factory(root.PCD || (root.PCD = {}), root);
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (PCD, root) {
  'use strict';

  var W = 64;
  var H = 64;
  var STEP = 1 / 30;

  /** Kind -> effect family. */
  var EFFECTS = {
    clear: 'clear', unknown: 'clear', partly: 'cloud', cloudy: 'cloud', fog: 'fog',
    drizzle: 'rain', rain: 'rain', freezing: 'rain', snow: 'snow', thunder: 'storm'
  };

  /**
   * Tint per kind: sat = share of saturation removed, light = share of brightness removed (0..1). Fog blends toward
   * FOG_DAY or FOG_NIGHT with an alpha growing from fog[0] at row 0 to fog[1] at row 63 (denser near the ground).
   */
  var TINTS = {
    clear: { sat: 0, light: 0, fog: null },
    unknown: { sat: 0, light: 0, fog: null },
    partly: { sat: 0.10, light: 0, fog: null },
    cloudy: { sat: 0.30, light: 0.08, fog: null },
    fog: { sat: 0, light: 0, fog: [0.25, 0.5] },
    drizzle: { sat: 0.30, light: 0.08, fog: null },
    rain: { sat: 0.30, light: 0.08, fog: null },
    freezing: { sat: 0.30, light: 0.08, fog: null },
    snow: { sat: 0.15, light: 0, fog: null },
    thunder: { sat: 0.30, light: 0.15, fog: null }
  };
  var FOG_DAY = 0xc9ccd2;
  var FOG_NIGHT = 0x1e2230;

  /**
   * Falling pixels per kind: count (heavy: when precipitation >= HEAVY_MM, or a heavy WMO code), speed range in px/s,
   * streak length in px, share drawn as flakes.
   */
  var PARTICLES = {
    drizzle: { count: 14, heavy: 14, speed: [45, 45], len: 1, flakes: 0 },
    rain: { count: 30, heavy: 44, speed: [60, 60], len: 2, flakes: 0 },
    freezing: { count: 30, heavy: 44, speed: [60, 60], len: 2, flakes: 0.5 },
    thunder: { count: 30, heavy: 44, speed: [60, 60], len: 2, flakes: 0 },
    snow: { count: 36, heavy: 54, speed: [8, 14], len: 1, flakes: 1 }
  };
  /** mm/h of precipitation from which rain counts as heavy; snow (water equivalent) from half of it. */
  var HEAVY_MM = 4;
  var HEAVY_CODES = [65, 67, 75, 82, 86, 99];
  var DROP_DAY = 0xcfdcf2;
  var DROP_NIGHT = 0x9fb2d6;
  var FLAKE = 0xf4f6ff;
  var ALPHA = { dropDay: 0.55, dropNight: 0.35, flake: 0.85 };
  /** Wind (km/h) at which drops reach the full slant of MAX_SLANT px sideways per px of fall. */
  var FULL_WIND_KMH = 40;
  var MAX_SLANT = 0.6;
  /** Lightning: the next flash 8-20 s after the last, then +35 % for 2 steps and +15 % for 2 (toward FLASH). */
  var FLASH = 0xf2f0ff;
  var FLASH_STEPS = [0.35, 0.35, 0.15, 0.15];
  var FLASH_GAP = [8, 20];
  /** Themes drawn indoors (the scene is a room with a window): no particles and half the tint. */
  var INDOOR = ['christmas'];

  function num(v) {
    return typeof v === 'number' && isFinite(v) ? v : null;
  }

  function clamp(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
  }

  /** mulberry32: a small deterministic PRNG, 0 <= r() < 1. */
  function rng(seed) {
    var a = (seed >>> 0) || 1;
    return function () {
      a = (a + 0x6d2b79f5) >>> 0;
      var t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function isIndoor(themeId) {
    return INDOOR.indexOf(themeId) !== -1;
  }

  function effect(kind) {
    return EFFECTS[kind] || 'clear';
  }

  /**
   * input(data, { indoor, reducedMotion }) -> the set() argument from PCD.weather's parsed data (null without data).
   * wind goes in km/h (data.windKmh), precipitation in mm/h.
   */
  function input(data, opts) {
    if (!data || typeof data !== 'object') return null;
    var o = opts || {};
    return {
      kind: data.kind,
      code: num(data.code),
      precip: num(data.precip) || 0,
      wind: num(data.windKmh) || 0,
      isDay: data.isDay !== false,
      indoor: !!o.indoor,
      flash: !o.reducedMotion
    };
  }

  function isHeavy(w) {
    if (w.heavy === true) return true;
    if (w.code !== null && HEAVY_CODES.indexOf(w.code) !== -1) return true;
    var p = w.precip || 0;
    return w.kind === 'snow' ? p >= HEAVY_MM / 2 : p >= HEAVY_MM;
  }

  function normalize(w) {
    if (!w || typeof w !== 'object' || !TINTS[w.kind]) return null;
    return {
      kind: w.kind,
      code: num(w.code),
      precip: Math.max(0, num(w.precip) || 0),
      wind: Math.max(0, num(w.wind) || 0),
      isDay: w.isDay !== false,
      indoor: !!w.indoor,
      flash: w.flash !== false,
      heavy: w.heavy === true
    };
  }

  /**
   * params(w) -> the exact effect for one situation: { kind, effect, indoor, sat, light, fog: { color, top, bottom }
   * | null, particles: { count, speed: [min, max], len, flakes, color, alpha, flakeColor, flakeAlpha, slant } | null,
   * flash: boolean } (null for no weather). w is set()'s argument ({ kind, code, precip, wind (km/h), isDay, indoor,
   * flash }). Indoor halves sat, light, fog and the lightning flash, and has no particles.
   */
  function params(w) {
    var s = normalize(w);
    if (!s) return null;
    var tint = TINTS[s.kind];
    var k = s.indoor ? 0.5 : 1;
    var p = PARTICLES[s.kind];
    var particles = null;
    if (p && !s.indoor) {
      var heavy = isHeavy(s);
      particles = {
        count: heavy ? p.heavy : p.count,
        speed: p.speed.slice(),
        len: p.len,
        flakes: p.flakes,
        color: s.isDay ? DROP_DAY : DROP_NIGHT,
        alpha: s.isDay ? ALPHA.dropDay : ALPHA.dropNight,
        flakeColor: FLAKE,
        flakeAlpha: ALPHA.flake,
        slant: MAX_SLANT * clamp(s.wind / FULL_WIND_KMH, 0, 1)
      };
    }
    return {
      kind: s.kind,
      effect: effect(s.kind),
      indoor: s.indoor,
      sat: tint.sat * k,
      light: tint.light * k,
      fog: tint.fog ? { color: s.isDay ? FOG_DAY : FOG_NIGHT, top: tint.fog[0] * k, bottom: tint.fog[1] * k } : null,
      particles: particles,
      flash: s.kind === 'thunder' && s.flash
    };
  }

  /**
   * create(seed) -> fx: set(w) (null = no weather), step(dt) once per engine step, apply(cv) on the scene pixels
   * (cv.px: Uint32Array of 0xRRGGBB, 64x64), plus state() for tests and debug overlays.
   */
  function create(seed) {
    var rand = rng(seed);
    var cur = null;       // params() of the current weather
    var key = '';
    var parts = [];       // { x, y, vy, flake, phase }
    var t = 0;
    var flashIn = 0;      // seconds until the next flash
    var flashStep = -1;   // index into FLASH_STEPS while flashing
    var fogA = new Float32Array(H);

    function spawn(p, anywhere) {
      var pr = cur.particles;
      var flake = pr.flakes >= 1 || (pr.flakes > 0 && rand() < pr.flakes);
      p.vy = pr.speed[0] + (pr.speed[1] - pr.speed[0]) * rand();
      p.y = anywhere ? rand() * (H + pr.len) - pr.len : -pr.len - rand() * 6;
      // Spread x over everything the slant can carry into view during the fall.
      var reach = pr.slant * (H + pr.len);
      p.x = rand() * (W + reach) - reach;
      p.flake = flake;
      p.phase = rand() * Math.PI * 2;
      return p;
    }

    function set(w) {
      var next = params(w);
      var k = next ? JSON.stringify(next) : '';
      if (k === key) return;
      var prevParts = cur && cur.particles;
      cur = next;
      key = k;
      if (cur && cur.fog) {
        for (var y = 0; y < H; y++) fogA[y] = cur.fog.top + (cur.fog.bottom - cur.fog.top) * (y / (H - 1));
      }
      if (!cur || !cur.particles) {
        parts = [];
      } else if (!prevParts || prevParts.count !== cur.particles.count || prevParts.flakes !== cur.particles.flakes ||
        prevParts.speed[0] !== cur.particles.speed[0]) {
        parts = [];
        for (var i = 0; i < cur.particles.count; i++) parts.push(spawn({}, true));
      }
      if (cur && cur.flash) {
        if (flashIn <= 0) flashIn = FLASH_GAP[0] + (FLASH_GAP[1] - FLASH_GAP[0]) * rand();
      } else {
        flashIn = 0;
        flashStep = -1;
      }
    }

    function step(dt) {
      var d = typeof dt === 'number' && dt > 0 ? dt : STEP;
      t += d;
      if (!cur) return;
      var pr = cur.particles;
      if (pr) {
        for (var i = 0; i < parts.length; i++) {
          var p = parts[i];
          p.y += p.vy * d;
          p.x += p.vy * pr.slant * d;
          if (p.flake && pr.speed[1] < 30) p.x += Math.sin(t * 1.7 + p.phase) * 6 * d; // snow drifts
          if (p.y - pr.len > H || p.x > W + 1) spawn(p, false);
        }
      }
      if (cur.flash) {
        if (flashStep >= 0) {
          flashStep++;
          if (flashStep >= FLASH_STEPS.length) flashStep = -1;
        } else {
          flashIn -= d;
          if (flashIn <= 0) {
            flashStep = 0;
            flashIn = FLASH_GAP[0] + (FLASH_GAP[1] - FLASH_GAP[0]) * rand();
          }
        }
      }
    }

    function blend(px, x, y, c, a) {
      var xi = Math.round(x);
      var yi = Math.round(y);
      if (xi < 0 || xi >= W || yi < 0 || yi >= H) return;
      var i = yi * W + xi;
      var o = px[i];
      var r = (o >>> 16) & 255;
      var g = (o >>> 8) & 255;
      var b = o & 255;
      r += (((c >>> 16) & 255) - r) * a;
      g += (((c >>> 8) & 255) - g) * a;
      b += ((c & 255) - b) * a;
      px[i] = ((r + 0.5) << 16) | ((g + 0.5) << 8) | (b + 0.5);
    }

    function apply(cv) {
      if (!cur || !cv || !cv.px) return;
      var px = cv.px;
      var keep = 1 - cur.sat;
      var lit = 1 - cur.light;
      var fog = cur.fog;
      var flash = flashStep >= 0 ? FLASH_STEPS[flashStep] * (cur.indoor ? 0.5 : 1) : 0;
      if (keep !== 1 || lit !== 1 || fog || flash > 0) {
        var fr = fog ? (fog.color >>> 16) & 255 : 0;
        var fg = fog ? (fog.color >>> 8) & 255 : 0;
        var fb = fog ? fog.color & 255 : 0;
        var lr = (FLASH >>> 16) & 255;
        var lg = (FLASH >>> 8) & 255;
        var lb = FLASH & 255;
        for (var y = 0, i = 0; y < H; y++) {
          var fa = fog ? fogA[y] : 0;
          for (var x = 0; x < W; x++, i++) {
            var c = px[i];
            var r = (c >>> 16) & 255;
            var g = (c >>> 8) & 255;
            var b = c & 255;
            var grey = r * 0.299 + g * 0.587 + b * 0.114;
            r = (grey + (r - grey) * keep) * lit;
            g = (grey + (g - grey) * keep) * lit;
            b = (grey + (b - grey) * keep) * lit;
            if (fa > 0) {
              r += (fr - r) * fa;
              g += (fg - g) * fa;
              b += (fb - b) * fa;
            }
            if (flash > 0) {
              r += (lr - r) * flash;
              g += (lg - g) * flash;
              b += (lb - b) * flash;
            }
            px[i] = ((r + 0.5) << 16) | ((g + 0.5) << 8) | (b + 0.5);
          }
        }
      }
      var pr = cur.particles;
      if (!pr) return;
      for (var n = 0; n < parts.length; n++) {
        var p = parts[n];
        if (p.flake) {
          blend(px, p.x, p.y, pr.flakeColor, pr.flakeAlpha);
        } else {
          for (var s = 0; s < pr.len; s++) blend(px, p.x - pr.slant * s, p.y - s, pr.color, pr.alpha * (s === 0 ? 1 : 0.6));
        }
      }
    }

    function state() {
      return {
        kind: cur ? cur.kind : null,
        effect: cur ? cur.effect : 'clear',
        params: cur,
        particles: parts.length,
        flashing: flashStep >= 0,
        nextFlashIn: cur && cur.flash && flashStep < 0 ? flashIn : null
      };
    }

    return { set: set, step: step, apply: apply, state: state };
  }

  var api = {
    EFFECTS: EFFECTS,
    TINTS: TINTS,
    PARTICLES: PARTICLES,
    HEAVY_MM: HEAVY_MM,
    HEAVY_CODES: HEAVY_CODES,
    FOG_DAY: FOG_DAY,
    FOG_NIGHT: FOG_NIGHT,
    ALPHA: ALPHA,
    MAX_SLANT: MAX_SLANT,
    FULL_WIND_KMH: FULL_WIND_KMH,
    FLASH_STEPS: FLASH_STEPS,
    FLASH_GAP: FLASH_GAP,
    INDOOR: INDOOR,
    effect: effect,
    isIndoor: isIndoor,
    input: input,
    params: params,
    create: create
  };
  PCD.fx = api;
  return api;
});
