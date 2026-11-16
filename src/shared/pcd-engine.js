/* PixelClock Desktop: the engine adapter. Classic script, UMD, global PCD.
 *
 * A thin layer over the clock's own engine (globalThis.PixelClock, synced byte for byte into vendor/pixelclock/):
 *   PCD.engine.menu(PC)             the theme menu: auto, the seasons, the holidays (PC.HOLIDAYS order), any other
 *   PCD.engine.autoId(PC, y, m, d)  the clock's schedule (PC.themeIdForDate), else the first menu theme
 *   PCD.engine.seed(id, y, m, d)    FNV-1a of "id:yyyy-mm-dd" (0 -> 1): the same layout everywhere on the same day
 *   PCD.engine.ctx(date, opts)      the full theme ctx for a Date
 *   PCD.engine.createScene(opts)    a scene: steps of exactly 1/30 s, the clock's cross-fade, shake, RGBA output
 * It never draws a pixel itself: every pixel comes from the clock's themes (the clock part through PCD.hook).
 * Like the clock's simulator/main.js (in the PixelClock repo, not copied into vendor/), the scene reuses its
 * framebuffers without clearing them between frames.
 */
(function (root, factory) {
  var api = factory(root.PCD || (root.PCD = {}), root);
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (PCD, root) {
  'use strict';

  var STEP = 1 / 30;      // the clock's fixed update step; update() must always get exactly this
  var FADE_STEPS = 45;    // main.js FADE_SECONDS = 1.5 s at 30 steps per second
  var WARMUP = 45;        // steps a new theme instance runs before its first frame
  var SEASONS = ['winter', 'spring', 'summer', 'autumn'];

  function engineOf(PC) {
    var pc = PC || root.PixelClock;
    if (!pc || typeof pc.themeById !== 'function' || typeof pc.Canvas !== 'function') {
      throw new Error('PCD.engine: the PixelClock engine is not loaded (load vendor engine.js, schedule.js and the themes first)');
    }
    return pc;
  }

  /** [{ id: 'auto', name: 'Auto (by date)', kind: 'auto' }, ...seasons, ...holidays, ...others] as { id, name, kind }. */
  function menu(PC) {
    PC = engineOf(PC);
    var seen = [];
    var list = [{ id: 'auto', name: 'Auto (by date)', kind: 'auto' }];
    function add(t) {
      if (!t || seen.indexOf(t) !== -1) return;
      seen.push(t);
      list.push({ id: t.id, name: t.name, kind: t.kind || 'other' });
    }
    SEASONS.forEach(function (id) { add(PC.themeById(id)); });
    (PC.HOLIDAYS || []).forEach(function (h) { add(PC.themeById(h.id)); });
    (PC.themes || []).forEach(add);
    return list;
  }

  /** The theme the clock shows on y-m-d (months 1-12); the first menu theme when the schedule has none. */
  function autoId(PC, y, m, d) {
    PC = engineOf(PC);
    var id = null;
    try {
      id = PC.themeIdForDate(y, m, d);
    } catch (e) {
      id = null;
    }
    if (id && PC.themeById(id)) return id;
    var list = menu(PC);
    return list.length > 1 ? list[1].id : null;
  }

  function pad(n, width) {
    var v = Math.trunc(Number(n)) || 0;
    var s = String(Math.abs(v));
    while (s.length < width) s = '0' + s;
    return (v < 0 ? '-' : '') + s;
  }

  /** FNV-1a (32 bit) of "id:yyyy-mm-dd"; 0 becomes 1 (an xorshift seed must not be 0). */
  function seed(id, y, m, d) {
    var text = String(id) + ':' + pad(y, 4) + '-' + pad(m, 2) + '-' + pad(d, 2);
    var h = 0x811c9dc5;
    for (var i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i) & 255;
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return (h >>> 0) || 1;
  }

  /**
   * The full theme ctx for a Date (local time): { hours, minutes, seconds, ms, hourFloat, year, month, day, hour12,
   * showDate: true, shake: false }. opts: { clock24 (default false), hourFloat (the light; default the wall clock) }.
   */
  function ctx(date, opts) {
    var o = opts || {};
    var d = date instanceof Date ? date : new Date(date == null ? Date.now() : date);
    var hours = d.getHours();
    var minutes = d.getMinutes();
    var seconds = d.getSeconds();
    var hf = typeof o.hourFloat === 'number' && isFinite(o.hourFloat) ? o.hourFloat : hours + minutes / 60 + seconds / 3600;
    return {
      hours: hours,
      minutes: minutes,
      seconds: seconds,
      ms: d.getMilliseconds(),
      hourFloat: hf,
      year: d.getFullYear(),
      month: d.getMonth() + 1,
      day: d.getDate(),
      hour12: !o.clock24,
      showDate: true,
      shake: false
    };
  }

  function withShake(c, shake) {
    var out = {};
    for (var k in c) if (Object.prototype.hasOwnProperty.call(c, k)) out[k] = c[k];
    out.shake = !!shake;
    return out;
  }

  /**
   * A scene. opts: { PC (default globalThis.PixelClock), warmup (default 45), log (error logger) }.
   *   want(id, { fade = true })  switch theme (false for an unknown id); applied by the next step() or frame(),
   *                              which know the date for the seed; the new instance runs `warmup` steps first
   *   surprise(rand)             want a random menu theme other than the current one; returns its id
   *   shake()                    the next step() carries shake: true, exactly once
   *   step(ctx)                  one update of exactly 1/30 s (the old instance too while fading, with shake: false)
   *   frame(ctx)                 draw and return the blended PC.Canvas (reused: copy it to keep it)
   *   rgba(u8)                   the last frame as RGBA bytes (alpha 255) into u8 (default: a new Uint8ClampedArray)
   *   id, name, colors, edge, fading, fade, canvas, stats()
   * With no want() before the first step or frame, the scene shows autoId for that ctx's date. A theme that throws
   * is reported once and the last good frame is kept.
   */
  function createScene(opts) {
    var o = opts || {};
    var PC = engineOf(o.PC);
    var warmup = o.warmup == null ? WARMUP : Math.max(0, Math.floor(Number(o.warmup)) || 0);
    var log = typeof o.log === 'function' ? o.log : function (msg) { if (typeof console !== 'undefined') console.error(msg); };
    var fb = new PC.Canvas();
    var prevFb = new PC.Canvas();
    var out = new PC.Canvas();
    var cur = null;       // { id, inst }
    var prev = null;      // { id, inst } fading out
    var fadeStep = FADE_STEPS;
    var wanted = null;    // { id, fade } until the next step() or frame()
    var shakeNext = false;
    var reported = {};
    var counts = { steps: 0, frames: 0, created: 0, errors: 0, shakes: 0, warmupSteps: 0 };

    function report(key, e) {
      counts.errors++;
      if (reported[key]) return;
      reported[key] = true;
      log('[pcd-engine] ' + key + ' threw (reported once; the last good frame is kept): ' + (e && e.stack ? e.stack : e));
    }

    function materialize(c) {
      if (!wanted) {
        if (cur) return;
        var auto = autoId(PC, c.year, c.month, c.day);
        if (!auto) return;
        wanted = { id: auto, fade: false };
      }
      var w = wanted;
      wanted = null;
      if (cur && w.id === cur.id) return;
      var theme = PC.themeById(w.id);
      if (!theme) return;
      var inst;
      try {
        inst = theme.create(new PC.Rng(seed(w.id, c.year, c.month, c.day)));
        var calm = withShake(c, false);
        for (var i = 0; i < warmup; i++) {
          inst.update(STEP, calm);
          counts.warmupSteps++;
        }
      } catch (e) {
        report(w.id + ' create/warm-up', e);
        return;
      }
      counts.created++;
      if (cur && w.fade) {
        prev = cur;
        fadeStep = 0;
      } else {
        prev = null;
        fadeStep = FADE_STEPS;
      }
      cur = { id: w.id, inst: inst };
    }

    function want(id, opts2) {
      if (typeof id !== 'string' || !PC.themeById(id)) return false;
      wanted = { id: id, fade: !(opts2 && opts2.fade === false) };
      return true;
    }

    function surprise(rand) {
      var r = typeof rand === 'function' ? rand : Math.random;
      var current = scene.id;
      var list = menu(PC).filter(function (t) { return t.id !== 'auto' && t.id !== current; });
      if (!list.length) return current;
      var i = Math.floor(Number(r()) * list.length);
      if (!(i >= 0)) i = 0;
      if (i >= list.length) i = list.length - 1;
      want(list[i].id);
      return list[i].id;
    }

    function shake() {
      shakeNext = true;
    }

    function step(c) {
      materialize(c);
      if (!cur) return false;
      var s = shakeNext;
      shakeNext = false;
      if (s) counts.shakes++;
      try {
        cur.inst.update(STEP, withShake(c, s));
      } catch (e) {
        report(cur.id + ' update', e);
      }
      if (prev) {
        try {
          prev.inst.update(STEP, withShake(c, false));
          fadeStep++;
        } catch (e) {
          report(prev.id + ' update', e);
          fadeStep = FADE_STEPS;
        }
        if (fadeStep >= FADE_STEPS) {
          prev = null;
          fadeStep = FADE_STEPS;
        }
      }
      counts.steps++;
      return true;
    }

    function frame(c) {
      materialize(c);
      if (!cur) return out;
      var dc = withShake(c, false);
      if (prev) {
        try {
          prev.inst.draw(prevFb, dc);
        } catch (e) {
          report(prev.id + ' draw', e);
          prev = null;
          fadeStep = FADE_STEPS;
        }
      }
      try {
        cur.inst.draw(fb, dc);
      } catch (e) {
        report(cur.id + ' draw', e);
        return out;
      }
      var n = out.px.length;
      if (prev) {
        var t = fadeStep / FADE_STEPS;
        var f = t * t * (3 - 2 * t); // main.js: ease in and out
        for (var i = 0; i < n; i++) out.px[i] = PC.mix(prevFb.px[i], fb.px[i], f);
      } else {
        out.px.set(fb.px);
      }
      counts.frames++;
      return out;
    }

    function rgba(u8) {
      var px = out.px;
      var n = px.length;
      var dst = u8 || new Uint8ClampedArray(n * 4);
      for (var i = 0, j = 0; i < n; i++, j += 4) {
        var c = px[i];
        dst[j] = (c >> 16) & 255;
        dst[j + 1] = (c >> 8) & 255;
        dst[j + 2] = c & 255;
        dst[j + 3] = 255;
      }
      return dst;
    }

    var scene = {
      want: want,
      surprise: surprise,
      shake: shake,
      step: step,
      frame: frame,
      rgba: rgba,
      /** The theme shown (or about to be shown) by this scene. */
      get id() { return wanted ? wanted.id : cur ? cur.id : null; },
      get name() {
        var t = scene.id && PC.themeById(scene.id);
        return t ? t.name : '';
      },
      get colors() { return PCD.hook ? PCD.hook.colors : null; },
      get edge() { return PCD.hook ? PCD.hook.edge : null; },
      get fading() { return !!prev; },
      /** Cross-fade progress 0..1 (1 when not fading). */
      get fade() { return prev ? fadeStep / FADE_STEPS : 1; },
      /** The output PC.Canvas (the last good frame). */
      get canvas() { return out; },
      get shakePending() { return shakeNext; },
      stats: function () {
        return {
          id: scene.id, steps: counts.steps, frames: counts.frames, created: counts.created, errors: counts.errors,
          shakes: counts.shakes, warmupSteps: counts.warmupSteps, fading: !!prev
        };
      }
    };
    return scene;
  }

  var engine = {
    STEP: STEP,
    FADE_STEPS: FADE_STEPS,
    WARMUP: WARMUP,
    SEASONS: SEASONS.slice(),
    menu: menu,
    autoId: autoId,
    seed: seed,
    ctx: ctx,
    createScene: createScene
  };
  PCD.engine = engine;
  return engine;
});
