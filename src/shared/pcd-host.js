/* PixelClock Desktop shared: the scene host. Classic script, UMD, global PCD (PCD.host). It owns the only thing that
 * moves: the clock's engine (PCD.engine) at exactly 30 steps of 1/30 s per second, its frames, and the text timers
 * (colon, minute, ringing pulse), so pausing it stops every timer and animation frame at once. With a steady colon
 * (reduced motion, 15 fps) the minute timer still looks at the wall clock every 10 s, so a clock change (a time sync,
 * a resume from sleep) shows within seconds. It also runs in Node with injected timers (tests); it touches the DOM
 * only through the objects it is given.
 *
 * PCD.host.create(opts) -> host                                            (the scene host)
 *   opts: { paint(frame, { first, fading }) (the pages: every frame goes through it, e.g. PCD.console's con.frame or
 *     PCD.bleed's layer.draw; frame is the engine's PC.Canvas, reused between frames: copy what you keep; the host then
 *     makes no canvas of its own and draws on none), canvas (without paint: a 64x64 <canvas> the host draws each frame
 *     on, made when missing, image-rendering pixelated), PC (default globalThis.PixelClock), doc, win,
 *     profile ('newtab'|'wallpaper'|'preview'), settings: { theme ('auto'|id), clock24, reducedMotion
 *     ('auto'|'on'|'off'), performance ('auto'|'on'|'off'; auto = on while the battery discharges), sunTimes (follow
 *     the real sunrise and sunset, default true), weatherFx (default true) },
 *     now() (the wall clock in ms; default Date.now: previews and tests shift it), perfNow, setTimeout, clearTimeout,
 *     requestAnimationFrame, cancelAnimationFrame (injected for tests), rand (surprise; default Math.random),
 *     warmup (engine warm-up steps, default 45), anchors (default PCD.ANCHORS), fpsCap (default 30, never more),
 *     watch: { visibility, motion, battery } (default true each: pause while hidden, follow prefers-reduced-motion,
 *     follow the battery for performance 'auto'), on: { event: fn } }
 *   The scene's own clock is always off (PCD.hook.mode 'none' while the scene draws): the console shows the clock. A
 *   sceneClock option ('none') is accepted and changes nothing.
 *   host.start() / host.stop()        paint the first frame at once, then run; stop clears everything
 *   host.pause(reason) / resume(reason)   counted reasons ('hidden' comes from visibilitychange, 'lively' from the
 *                                     wallpaper); while any is set there is no timer and no animation frame
 *   host.set(patch)                   settings, live (theme, clock24, reducedMotion, performance, sunTimes,
 *                                     weatherFx); a theme change ends a surprise, and { surprise: null } ends a
 *                                     running surprise (an explicit theme request, even for the stored theme)
 *   host.setWeather(data|null)        PCD.weather's parsed data: today's sun times and the scene's weather effect
 *   host.setSun(sun|null|undefined)   real sun times { rise, set } (wall-clock hours) without a forecast; undefined
 *                                     goes back to the forecast's
 *   host.shake()                      the theme's shake (300 ms debounce): one engine step carries shake: true, and a
 *                                     'shake' event; under reduced motion the scene plays 4 s at 15 fps and freezes
 *                                     again. Returns true when it shook.
 *   host.surprise({ until })          a random other theme, cross-faded, tag 'surprise'; until 'tab' (default: until
 *                                     the theme setting changes) or 'midnight' (the wallpaper). Returns its id.
 *   host.ringing(on)                  the status line's 2 Hz ringing pulse: 'ring' events (steady under reduced motion)
 *   host.attach(el, { keys })         pointerdown on el shakes; keys: any key outside form fields except Tab, '/' and
 *                                     Esc, never with Ctrl, Alt or Meta, never prevented. Returns detach().
 *   host.view()                       { reason, now, date, hours, minutes, clock24, id, name, tag, fading, phase,
 *                                     hourFloat, night, sun (real sun times in use, else null), source, curve (48
 *                                     strip levels), clockColor, colon, steady (the colon does not blink), ringing,
 *                                     ring, reduced, perf, fps, paused, reasons }
 *   host.on(event, fn) -> off()       events: 'view' (the view, at every minute and on every change: reason 'start',
 *                                     'minute', 'theme', 'fade', 'settings', 'weather', 'resume', 'motion'),
 *                                     'colon' (on), 'ring' (on), 'shake' (every accepted shake), 'resume', 'frame'
 *                                     (stats-light info, every frame: keep it cheap), 'error' (e)
 *   host.stats(), host.timers() -> { frame, raf, text }, host.ctx() (the ctx the next step gets), host.canvas (null
 *   with paint), host.scene (the PCD.engine scene), host.loop (the frame loop below)
 *   With PCD.console: PCD.host.create({ paint: con.frame, sceneClock: 'none', ... }); the host owns PCD.hook.before
 *   (the weather effect: use setWeather, not the hook) and every timer; feed con.update() from the 'view' event,
 *   con.colon() from 'colon' and con.ring() from 'ring'.
 *
 * PCD.host.loop(opts) -> the frame loop alone (the members of the wallpaper's PCD.wpLoop.create, so either can drive
 *   the other's app): opts { fps (30), step(n), draw(info { steps, still, burst, kick }), onError,
 *   now (monotonic ms), setTimeout, clearTimeout, requestAnimationFrame, cancelAnimationFrame, cap (30) }; members
 *   start, stop, pause(reason), resume(reason), paused, reasons, running, setFps(n), fps, kick, burst(ms, fps),
 *   pending -> { timer, raf }, stats, resetStats.
 *   Steps: acc += min(0.25 s, elapsed); a frame runs one step per 1/30 s of acc, rounded to the nearest step (so
 *   vsync jitter never turns 1, 1, 1 into 0, 2, 1) with the remainder carried, so the long-run rate is exactly 30 per
 *   second at 30 and at 15 fps; never more than 7 steps in a frame, and a resume restarts the step clock (no
 *   fast-forward). Frames: one setTimeout until the next frame is due, then one requestAnimationFrame that steps and
 *   draws; no rAF chain at the display rate. fps 0 = still: no loop; kick() paints one frame; burst(ms, fps) animates
 *   for a while.
 *
 * PCD.host.watchViewport(win, fn) -> unwatch: fn({ cssW, cssH, dpr }) on resize and on every devicePixelRatio change
 *   (a window moved to another monitor), each page laying out from its own size; nothing reads screen.*.
 * PCD.host.fpsFor({ reduced, perf, cap }) -> 0 | 15 | 30
 */
(function (root, factory) {
  var api = factory(root.PCD || (root.PCD = {}), root);
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (PCD, root) {
  'use strict';

  var STEP = 1 / 30;
  var STEP_MS = 1000 / 30;
  var MAX_ACC_MS = 250;
  var MAX_STEPS = 7;
  var EARLY_MS = 2;
  var FPS_WINDOW_MS = 5000;
  var COST_WINDOW = 150;
  var SHAKE_DEBOUNCE_MS = 300;
  var BURST_MS = 4000;
  var BURST_FPS = 15;
  var RING_MS = 250;
  var COLON_MS = 500;
  var MINUTE_SLACK_MS = 5;
  /** With a steady colon the text timer still looks at the wall clock this often (only while visible and running). */
  var STEADY_CHECK_MS = 10000;

  function defaultPerfNow() {
    var p = root.performance;
    return p && typeof p.now === 'function' ? p.now() : Date.now();
  }

  function fpsFor(o) {
    var x = o || {};
    var cap = typeof x.cap === 'number' && x.cap > 0 ? Math.min(30, x.cap) : 30;
    if (x.reduced) return 0;
    return Math.min(cap, x.perf ? 15 : 30);
  }

  function percentile(list, p) {
    if (!list.length) return 0;
    var a = list.slice().sort(function (x, y) { return x - y; });
    return a[Math.min(a.length - 1, Math.max(0, Math.ceil(a.length * p) - 1))];
  }

  // ------------------------------------------------------------------------------------------------ the frame loop

  function loop(opts) {
    var o = opts || {};
    var now = typeof o.now === 'function' ? o.now : defaultPerfNow;
    var setT = typeof o.setTimeout === 'function' ? o.setTimeout : function (fn, ms) { return root.setTimeout(fn, ms); };
    var clearT = typeof o.clearTimeout === 'function' ? o.clearTimeout : function (id) { root.clearTimeout(id); };
    var raf = typeof o.requestAnimationFrame === 'function' ? o.requestAnimationFrame
      : typeof root.requestAnimationFrame === 'function' ? function (fn) { return root.requestAnimationFrame(fn); }
        : function (fn) { return root.setTimeout(function () { fn(defaultPerfNow()); }, 0); };
    var caf = typeof o.cancelAnimationFrame === 'function' ? o.cancelAnimationFrame
      : typeof root.cancelAnimationFrame === 'function' ? function (id) { root.cancelAnimationFrame(id); }
        : function (id) { root.clearTimeout(id); };
    var onStep = typeof o.step === 'function' ? o.step : null;
    var onDraw = typeof o.draw === 'function' ? o.draw : null;
    var onError = typeof o.onError === 'function' ? o.onError : function (e) {
      if (root.console && root.console.error) root.console.error('[pcd-host] frame: ' + (e && e.stack ? e.stack : e));
    };
    var cap = typeof o.cap === 'number' && o.cap > 0 ? Math.min(30, o.cap) : 30;

    function sanitize(v) {
      var n = Number(v);
      if (!isFinite(n) || n <= 0) return 0;
      return Math.min(cap, n);
    }

    var fps = sanitize(o.fps === undefined ? 30 : o.fps);
    var started = false;
    var reasons = {};
    var timer = null;
    var rafId = null;
    var nextDue = 0;
    var stepClock = -1;
    var acc = 0;
    var kickWanted = false;
    var burstUntil = 0;
    var burstFps = 0;
    var frameTimes = [];
    var costs = [];
    var counts = { frames: 0, steps: 0, stillFrames: 0, pauses: 0, resumes: 0, maxSteps: 0, lastSteps: 0 };
    var since = { frames: 0, steps: 0, maxSteps: 0 };

    function isPaused() {
      for (var k in reasons) if (Object.prototype.hasOwnProperty.call(reasons, k)) return true;
      return false;
    }

    function running() {
      return started && !isPaused();
    }

    function bursting(t) {
      return burstUntil > 0 && t < burstUntil;
    }

    function effective(t) {
      return bursting(t) ? burstFps : fps;
    }

    function disarm() {
      if (timer !== null) {
        clearT(timer);
        timer = null;
      }
      if (rafId !== null) {
        caf(rafId);
        rafId = null;
      }
    }

    function arm() {
      if (!running() || timer !== null || rafId !== null) return;
      var t = now();
      var eff = effective(t);
      if (eff <= 0 && !kickWanted) return;
      var wait = kickWanted ? 0 : nextDue - EARLY_MS - t;
      if (wait > 1) timer = setT(onTimer, wait);
      else rafId = raf(onRaf);
    }

    function onTimer() {
      timer = null;
      if (!running()) return;
      rafId = raf(onRaf);
    }

    function restartClock(t) {
      stepClock = -1;
      acc = 0;
      nextDue = t;
    }

    function record(t, n, cost, still) {
      counts.frames++;
      if (still) counts.stillFrames++;
      counts.steps += n;
      counts.lastSteps = n;
      if (n > counts.maxSteps) counts.maxSteps = n;
      since.frames++;
      since.steps += n;
      if (n > since.maxSteps) since.maxSteps = n;
      frameTimes.push(t);
      while (frameTimes.length && t - frameTimes[0] > FPS_WINDOW_MS) frameTimes.shift();
      costs.push(cost);
      if (costs.length > COST_WINDOW) costs.shift();
    }

    function onRaf() {
      rafId = null;
      if (!running()) return;
      var t = now();
      var eff = effective(t);
      if (!kickWanted) {
        if (eff <= 0) {
          burstUntil = 0;
          return;
        }
        if (t < nextDue - EARLY_MS) {
          rafId = raf(onRaf);
          return;
        }
      }
      var wasKick = kickWanted;
      kickWanted = false;
      var n = 0;
      if (eff > 0) {
        if (stepClock < 0) stepClock = t - STEP_MS;
        var el = t - stepClock;
        stepClock = t;
        acc += Math.min(MAX_ACC_MS, Math.max(0, el));
        if (acc > MAX_ACC_MS) acc = MAX_ACC_MS;
        // One step per 1/30 s, rounded to the nearest step; the remainder (+-half a step) carries over.
        while (acc >= STEP_MS / 2 && n < MAX_STEPS) {
          n++;
          acc -= STEP_MS;
        }
        if (n >= MAX_STEPS && acc > 0) acc = 0;
      }
      var t0 = now();
      try {
        if (n > 0 && onStep) onStep(n);
        if (onDraw) onDraw({ steps: n, still: eff <= 0, burst: bursting(t), kick: wasKick });
      } catch (e) {
        try { onError(e); } catch (e2) { /* nothing else to do */ }
      }
      record(t, n, now() - t0, eff <= 0);
      if (eff > 0) {
        var interval = 1000 / eff;
        // A kicked frame (start, resume, a change) restarts the schedule from itself, so the step remainder settles
        // around zero instead of on the rounding edge; otherwise keep the cadence and resync only when far off.
        nextDue = wasKick ? t + interval : nextDue + interval;
        if (nextDue < t) nextDue = t + interval; // fell a whole frame behind: resync, never burst
      } else if (burstUntil > 0 && !bursting(t)) {
        burstUntil = 0;
      }
      arm();
    }

    function start() {
      if (started) return;
      started = true;
      restartClock(now());
      kickWanted = true;
      arm();
    }

    function stop() {
      started = false;
      disarm();
      kickWanted = false;
      burstUntil = 0;
    }

    function pause(reason) {
      var r = String(reason || 'pause');
      if (reasons[r]) return false;
      var was = isPaused();
      reasons[r] = true;
      if (!was) counts.pauses++;
      disarm();
      return true;
    }

    function resume(reason) {
      var r = String(reason || 'pause');
      if (!reasons[r]) return false;
      delete reasons[r];
      if (!isPaused()) {
        counts.resumes++;
        since.frames = 0;
        since.steps = 0;
        since.maxSteps = 0;
        var t = now();
        restartClock(t);
        if (burstUntil > 0 && !bursting(t)) burstUntil = 0;
        kickWanted = true;
        arm();
      }
      return true;
    }

    function setFps(v) {
      var next = sanitize(v);
      if (next === fps) return fps;
      var t = now();
      var wasStill = effective(t) <= 0;
      fps = next;
      if (!running()) return fps;
      disarm();
      if (wasStill && effective(t) > 0) restartClock(t);
      else nextDue = Math.min(nextDue, t + (fps > 0 ? 1000 / fps : 0));
      arm();
      return fps;
    }

    function kick() {
      kickWanted = true;
      if (!running()) return false;
      if (timer !== null) {
        clearT(timer);
        timer = null;
      }
      arm();
      return true;
    }

    function burst(ms, rate) {
      var t = now();
      var wasStill = effective(t) <= 0;
      burstFps = sanitize(rate === undefined ? BURST_FPS : rate) || BURST_FPS;
      burstUntil = t + Math.max(0, Number(ms) || 0);
      if (!running()) return false;
      if (wasStill) {
        disarm();
        restartClock(t);
        kickWanted = true;
      }
      arm();
      return true;
    }

    function measuredFps() {
      if (frameTimes.length < 2) return 0;
      var span = frameTimes[frameTimes.length - 1] - frameTimes[0];
      return span > 0 ? (frameTimes.length - 1) * 1000 / span : 0;
    }

    function reasonList() {
      return Object.keys(reasons).sort();
    }

    return {
      start: start,
      stop: stop,
      pause: pause,
      resume: resume,
      paused: isPaused,
      reasons: reasonList,
      running: running,
      setFps: setFps,
      fps: function () { return fps; },
      kick: kick,
      burst: burst,
      pending: function () { return { timer: timer !== null, raf: rafId !== null }; },
      stats: function () {
        var t = now();
        return {
          frames: counts.frames,
          steps: counts.steps,
          stillFrames: counts.stillFrames,
          fps: Math.round(measuredFps() * 100) / 100,
          p95: Math.round(percentile(costs, 0.95) * 1000) / 1000,
          target: fps,
          effective: running() ? effective(t) : 0,
          paused: isPaused(),
          reasons: reasonList(),
          pauses: counts.pauses,
          resumes: counts.resumes,
          maxSteps: counts.maxSteps,
          lastSteps: counts.lastSteps,
          sinceResume: { frames: since.frames, steps: since.steps, maxSteps: since.maxSteps },
          burst: bursting(t),
          pending: { timer: timer !== null, raf: rafId !== null }
        };
      },
      resetStats: function () {
        frameTimes = [];
        costs = [];
        counts.frames = 0;
        counts.steps = 0;
        counts.stillFrames = 0;
        counts.maxSteps = 0;
        counts.lastSteps = 0;
        since.frames = 0;
        since.steps = 0;
        since.maxSteps = 0;
      }
    };
  }

  // ------------------------------------------------------------------------------------------------ the canvas (no paint)

  function makeCanvas(doc) {
    var c = doc.createElement('canvas');
    c.width = 64;
    c.height = 64;
    c.className = 'pcd-scene';
    styleCanvas(c);
    return c;
  }

  function styleCanvas(c) {
    if (!c || !c.style) return;
    var st = c.style;
    if (!st.position) st.position = 'absolute';
    st.imageRendering = 'pixelated';
    // Its own compositor layer: each frame uploads a 64x64 texture and the GPU scales it (nearest, as
    // image-rendering asks); nothing around the scene repaints.
    st.willChange = 'transform';
  }

  // ------------------------------------------------------------------------------------------------ viewport watch

  function watchViewport(win, fn) {
    var w = win || root;
    var mq = null;
    var dead = false;
    function size() {
      return { cssW: w.innerWidth, cssH: w.innerHeight, dpr: w.devicePixelRatio || 1 };
    }
    function fire() {
      if (dead) return;
      try { fn(size()); } catch (e) { if (root.console) root.console.error('[pcd-host] viewport: ' + (e && e.stack ? e.stack : e)); }
    }
    function onDpr() {
      arm();
      fire();
    }
    function arm() {
      if (mq) {
        try { mq.removeEventListener('change', onDpr); } catch (e) { /* old engines */ }
      }
      mq = null;
      if (typeof w.matchMedia !== 'function') return;
      try {
        mq = w.matchMedia('(resolution: ' + (w.devicePixelRatio || 1) + 'dppx)');
        mq.addEventListener('change', onDpr);
      } catch (e) {
        mq = null;
      }
    }
    if (w.addEventListener) w.addEventListener('resize', fire);
    arm();
    return function unwatch() {
      dead = true;
      if (w.removeEventListener) w.removeEventListener('resize', fire);
      if (mq) {
        try { mq.removeEventListener('change', onDpr); } catch (e) { /* ignore */ }
      }
      mq = null;
    };
  }

  // ------------------------------------------------------------------------------------------------ the scene host

  var SETTING_KEYS = ['theme', 'clock24', 'reducedMotion', 'performance', 'sunTimes', 'weatherFx'];

  function normSettings(s, prev) {
    var o = s || {};
    var p = prev || { theme: 'auto', clock24: false, reducedMotion: 'auto', performance: 'auto', sunTimes: true, weatherFx: true };
    var out = {};
    SETTING_KEYS.forEach(function (k) { out[k] = Object.prototype.hasOwnProperty.call(o, k) ? o[k] : p[k]; });
    out.theme = typeof out.theme === 'string' && out.theme ? out.theme : 'auto';
    out.clock24 = !!out.clock24;
    out.reducedMotion = tri(out.reducedMotion);
    out.performance = tri(out.performance);
    out.sunTimes = out.sunTimes !== false;
    out.weatherFx = out.weatherFx !== false;
    return out;
  }

  function tri(v) {
    if (v === true || v === 'on') return 'on';
    if (v === false || v === 'off') return 'off';
    return 'auto';
  }

  /** The scene's own clock stays off while it draws (the console shows the clock). */
  function clockOff() {
    if (PCD.hook) PCD.hook.mode = 'none';
  }

  function dayKey(d) {
    return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate();
  }

  function create(opts) {
    var o = opts || {};
    var PC = o.PC || root.PixelClock;
    if (!PC || typeof PC.themeById !== 'function') throw new Error('PCD.host: the PixelClock engine is not loaded');
    if (!PCD.engine || typeof PCD.engine.createScene !== 'function') throw new Error('PCD.host: PCD.engine is not loaded');
    var doc = o.doc !== undefined ? o.doc : root.document || null;
    var win = o.win || (doc && doc.defaultView) || root;
    var wallNow = typeof o.now === 'function' ? o.now : function () { return Date.now(); };
    var perfNow = typeof o.perfNow === 'function' ? o.perfNow : defaultPerfNow;
    var setT = typeof o.setTimeout === 'function' ? o.setTimeout : function (fn, ms) { return root.setTimeout(fn, ms); };
    var clearT = typeof o.clearTimeout === 'function' ? o.clearTimeout : function (id) { root.clearTimeout(id); };
    var rand = typeof o.rand === 'function' ? o.rand : Math.random;
    var profile = o.profile || 'newtab';
    var watch = o.watch || {};
    var settings = normSettings(o.settings);
    var anchors = o.anchors || null;

    var listeners = {};
    var reported = {};
    function report(key, e) {
      if (reported[key]) return;
      reported[key] = true;
      if (root.console && root.console.error) root.console.error('[pcd-host] ' + key + ': ' + (e && e.stack ? e.stack : e));
      emit('error', e, true);
    }
    function on(name, fn) {
      if (typeof fn !== 'function') return function () {};
      (listeners[name] = listeners[name] || []).push(fn);
      return function off() {
        var l = listeners[name];
        var i = l ? l.indexOf(fn) : -1;
        if (i !== -1) l.splice(i, 1);
      };
    }
    function emit(name, arg, quiet) {
      var l = listeners[name];
      if (!l || !l.length) return;
      for (var i = 0; i < l.length; i++) {
        try {
          l[i](arg);
        } catch (e) {
          if (!quiet) report('listener ' + name, e);
        }
      }
    }
    if (o.on && typeof o.on === 'object') Object.keys(o.on).forEach(function (k) { on(k, o.on[k]); });

    // ---- the page's painter (or, without one, a canvas)
    var painter = typeof o.paint === 'function' ? o.paint : null;
    var canvas = o.canvas || (!painter && doc && typeof doc.createElement === 'function' ? makeCanvas(doc) : null);
    if (canvas && o.canvas && !painter) styleCanvas(canvas);
    var g2d = null;
    var img = null;
    if (!painter && canvas && typeof canvas.getContext === 'function') {
      if (canvas.width !== 64) canvas.width = 64;
      if (canvas.height !== 64) canvas.height = 64;
      try {
        g2d = canvas.getContext('2d', { alpha: false });
        img = g2d ? g2d.createImageData(64, 64) : null;
      } catch (e) {
        report('canvas', e);
      }
    }

    // ---- engine, weather, sun
    var scene = PCD.engine.createScene({ PC: PC, warmup: o.warmup, log: function (m) { report('engine', m); } });
    var fx = null;
    var fxOn = false;
    var weather = null;
    var sunOverride; // undefined: from the forecast
    var surpriseState = null;
    var tag = 'auto';
    var resolved = null;
    var curve = null;
    var clockCol = PCD.ascii ? PCD.ascii.clockColor(0xffffff) : 0xece4d8;
    var wasFading = false;
    var lastReason = 'start';
    var frameCtx = null;

    // ---- motion, power
    var mq = null;
    var mqHandler = null;
    var battery = null;
    var batteryHandler = null;
    var onBattery = false;
    var reduced = false;
    var perf = false;
    var colonOn = true;
    var isRinging = false;
    var ringOn = false;
    var lastShake = -Infinity;
    var started = false;
    var stopped = false;
    var textTimer = null;
    var minuteKey = '';
    var detachers = [];
    var counts = { minutes: 0, colonTicks: 0, ringTicks: 0, shakes: 0, shakesIgnored: 0, surprises: 0, themeSwitches: 0, views: 0 };

    var L = loop({
      fps: 30,
      cap: o.fpsCap,
      step: onSteps,
      draw: onDraw,
      now: perfNow,
      setTimeout: setT,
      clearTimeout: clearT,
      requestAnimationFrame: o.requestAnimationFrame,
      cancelAnimationFrame: o.cancelAnimationFrame,
      onError: function (e) { report('frame', e); }
    });

    function paused() {
      return L.paused();
    }

    function colonBlinks() {
      return !reduced && !perf && L.fps() >= 30;
    }

    function hourAt(d) {
      return d.getHours() + d.getMinutes() / 60 + d.getSeconds() / 3600 + d.getMilliseconds() / 3600000;
    }

    /** The sun times that drive the picture right now (null: the theme's own hours). */
    function sunInput(d) {
      if (!settings.sunTimes) return null;
      if (sunOverride !== undefined) return sunOverride;
      if (!weather || !PCD.sun) return null;
      try {
        return PCD.sun.today(weather, d);
      } catch (e) {
        report('sun', e);
        return null;
      }
    }

    function resolveSun(d) {
      if (!PCD.sun) {
        resolved = null;
        curve = null;
        return;
      }
      try {
        resolved = PCD.sun.resolve(d, { id: scene.id, anchors: anchors || undefined, sun: sunInput(d), follow: settings.sunTimes });
        curve = PCD.sun.curve(resolved.anchor, resolved.sun);
      } catch (e) {
        report('sun', e);
        resolved = null;
        curve = null;
      }
    }

    function hourFloatAt(d) {
      var h = hourAt(d);
      if (!resolved || !resolved.sun || !PCD.sun) return h;
      return PCD.sun.remap(h, resolved.sun, resolved.anchor);
    }

    function buildCtx(t) {
      var d = new Date(t);
      var c = PCD.engine.ctx(d, { clock24: settings.clock24, hourFloat: hourFloatAt(d) });
      // A steady colon (reduced motion, performance mode, still frames) keeps the scene's own colon lit too.
      if (!colonBlinks()) c.ms = 0;
      return c;
    }

    // ---- theme

    function menuIds() {
      try {
        return PCD.engine.menu(PC).map(function (t) { return t.id; }).filter(function (id) { return id !== 'auto'; });
      } catch (e) {
        return [];
      }
    }

    function wanted(d) {
      if (surpriseState && surpriseState.until === 'midnight' && surpriseState.day !== dayKey(d)) surpriseState = null;
      if (surpriseState && PC.themeById(surpriseState.id)) return { id: surpriseState.id, tag: 'surprise' };
      if (settings.theme !== 'auto' && PC.themeById(settings.theme)) return { id: settings.theme, tag: 'pinned' };
      return { id: PCD.engine.autoId(PC, d.getFullYear(), d.getMonth() + 1, d.getDate()), tag: 'auto' };
    }

    /** Show the theme the settings, the surprise and the date ask for. Returns true when the theme or tag changed. */
    function applyTheme(fade, reason) {
      var d = new Date(wallNow());
      var w = wanted(d);
      var changed = false;
      if (w.id && w.id !== scene.id) {
        scene.want(w.id, { fade: !!fade && !reduced && started });
        counts.themeSwitches++;
        changed = true;
      }
      if (w.tag !== tag) {
        tag = w.tag;
        changed = true;
      }
      if (changed) {
        resolveSun(d);
        updateFx();
        if (started) {
          L.kick();
          if (reason) notify(reason);
        }
      }
      return changed;
    }

    // ---- weather effect

    function updateFx() {
      var want = !!(PCD.fx && settings.weatherFx && weather);
      if (!want) {
        if (fx) fx.set(null);
        if (fxOn && PCD.hook && PCD.hook.before === (fx && fx.apply)) PCD.hook.before = null;
        fxOn = false;
        return;
      }
      try {
        if (!fx) {
          var d = new Date(wallNow());
          fx = PCD.fx.create(PCD.engine.seed('fx', d.getFullYear(), d.getMonth() + 1, d.getDate()));
        }
        var indoor = typeof PCD.fx.isIndoor === 'function' ? PCD.fx.isIndoor(scene.id) : false;
        fx.set(PCD.fx.input(weather, { indoor: indoor, reducedMotion: reduced }));
        if (PCD.hook) PCD.hook.before = fx.apply;
        fxOn = true;
      } catch (e) {
        report('fx', e);
        fxOn = false;
      }
    }

    // ---- frames

    function onSteps(n) {
      frameCtx = buildCtx(wallNow());
      for (var i = 0; i < n; i++) {
        scene.step(frameCtx);
        if (fxOn && fx) fx.step(STEP);
      }
    }

    function onDraw(info) {
      var c = frameCtx || buildCtx(wallNow());
      frameCtx = null;
      if (info.still && !info.steps) {
        // A still frame (reduced motion, a kick): one step keeps update-driven light and state on the hour.
        scene.step(c);
        if (fxOn && fx) fx.step(STEP);
      }
      clockOff();
      paintFrame(scene.frame(c), false);
      var fading = scene.fading;
      if (wasFading && !fading) {
        updateColours();
        notify('fade');
      }
      wasFading = fading;
      if (listeners.frame && listeners.frame.length) emit('frame', info);
    }

    /** One frame onto the canvas, or through the page's painter (opts.paint). */
    function paintFrame(fb, first) {
      if (painter) {
        painter(fb, { first: !!first, fading: scene.fading });
        return;
      }
      if (img && g2d) {
        scene.rgba(img.data);
        g2d.putImageData(img, 0, 0);
      }
    }

    /** The big clock's colour from the theme's own, at every minute and when a cross-fade ends. */
    function updateColours() {
      if (!PCD.ascii) return;
      var col = PCD.hook && PCD.hook.colors ? PCD.hook.colors.clock : null;
      clockCol = PCD.ascii.clockColor(col);
    }

    // ---- the view and the text timers

    function view() {
      var t = wallNow();
      var d = new Date(t);
      var hf = hourFloatAt(d);
      var useSun = !!(resolved && resolved.source === 'sun' && resolved.sun && typeof resolved.sun.rise === 'number');
      return {
        reason: lastReason,
        now: t,
        date: d,
        hours: d.getHours(),
        minutes: d.getMinutes(),
        clock24: settings.clock24,
        id: scene.id,
        name: scene.name,
        tag: tag,
        fading: scene.fading,
        phase: resolved ? resolved.phase : null,
        hourFloat: hf,
        night: typeof PC.daylight === 'function' ? 1 - PC.daylight(hf) : 0,
        sun: useSun ? { rise: resolved.sun.rise, set: resolved.sun.set } : null,
        source: resolved ? resolved.source : 'theme',
        curve: curve ? curve.slice() : null,
        clockColor: clockCol,
        colon: colonOn,
        steady: !colonBlinks(),
        ringing: isRinging,
        ring: ringOn,
        reduced: reduced,
        perf: perf,
        fps: L.fps(),
        paused: paused(),
        reasons: L.reasons()
      };
    }

    function notify(reason) {
      lastReason = reason;
      counts.views++;
      if (listeners.view && listeners.view.length) emit('view', view());
    }

    function minuteTick(reason) {
      var t = wallNow();
      var d = new Date(t);
      minuteKey = dayKey(d) + ' ' + d.getHours() + ':' + d.getMinutes();
      counts.minutes++;
      if (!applyTheme(true, null)) resolveSun(d);
      updateColours();
      if (L.fps() <= 0) L.kick();
      notify(reason);
    }

    function scheduleText() {
      if (textTimer !== null) {
        clearT(textTimer);
        textTimer = null;
      }
      if (!started || stopped || paused()) return;
      var t = wallNow();
      var ms = ((t % 60000) + 60000) % 60000;
      var wait = 60000 - ms + MINUTE_SLACK_MS;
      // A blinking colon ticks every half second. A steady one has no tick, so the timer still looks every
      // STEADY_CHECK_MS: a wall-clock jump (a time sync, a resume from sleep) shows within seconds, not a minute later.
      if (colonBlinks()) wait = Math.min(wait, COLON_MS - (((t % COLON_MS) + COLON_MS) % COLON_MS) + 1);
      else wait = Math.min(wait, STEADY_CHECK_MS);
      if (isRinging && !reduced) wait = Math.min(wait, RING_MS - (((t % RING_MS) + RING_MS) % RING_MS) + 1);
      textTimer = setT(onText, Math.max(1, wait));
    }

    function onText() {
      textTimer = null;
      if (!started || stopped || paused()) return;
      var t = wallNow();
      var d = new Date(t);
      var key = dayKey(d) + ' ' + d.getHours() + ':' + d.getMinutes();
      if (key !== minuteKey) minuteTick('minute');
      if (colonBlinks()) {
        var c = (((t % 1000) + 1000) % 1000) < 500;
        if (c !== colonOn) {
          colonOn = c;
          counts.colonTicks++;
          emit('colon', c);
        }
      }
      if (isRinging && !reduced) {
        var r = Math.floor(t / RING_MS) % 2 === 0;
        if (r !== ringOn) {
          ringOn = r;
          counts.ringTicks++;
          emit('ring', r);
        }
      }
      scheduleText();
    }

    function steadyColon() {
      if (!colonBlinks() && !colonOn) {
        colonOn = true;
        emit('colon', true);
      }
    }

    // ---- motion and power

    function applyMotion(reason) {
      var mqm = false;
      try {
        mqm = !!(mq && mq.matches);
      } catch (e) {
        mqm = false;
      }
      var r = settings.reducedMotion === 'on' || (settings.reducedMotion === 'auto' && mqm);
      var p = settings.performance === 'on' || (settings.performance === 'auto' && onBattery);
      var changed = r !== reduced || p !== perf;
      reduced = r;
      perf = p;
      var fps = fpsFor({ reduced: reduced, perf: perf, cap: o.fpsCap });
      L.setFps(fps);
      if (fps === 0) L.kick();
      steadyColon();
      if (isRinging) {
        if (reduced && !ringOn) {
          ringOn = true;
          emit('ring', true);
        }
      }
      updateFx();
      scheduleText();
      if (changed && started && reason !== 'start' && reason !== 'quiet') notify(reason || 'motion');
      return changed;
    }

    function watchMotion() {
      if (watch.motion === false || !win || typeof win.matchMedia !== 'function') return;
      try {
        mq = win.matchMedia('(prefers-reduced-motion: reduce)');
        mqHandler = function () { applyMotion('motion'); };
        if (typeof mq.addEventListener === 'function') mq.addEventListener('change', mqHandler);
      } catch (e) {
        mq = null;
      }
    }

    function watchBattery() {
      var nav = win && win.navigator;
      if (watch.battery === false || !nav || typeof nav.getBattery !== 'function') return;
      try {
        nav.getBattery().then(function (b) {
          if (stopped || !b) return;
          battery = b;
          batteryHandler = function () {
            onBattery = !battery.charging;
            applyMotion('motion');
          };
          if (typeof b.addEventListener === 'function') b.addEventListener('chargingchange', batteryHandler);
          batteryHandler();
        }, function () { /* no battery API here */ });
      } catch (e) {
        /* feature missing */
      }
    }

    function onVisibility() {
      if (!doc) return;
      if (doc.hidden) pause('hidden');
      else resume('hidden');
    }

    // ---- public

    function start() {
      if (started) return host;
      started = true;
      stopped = false;
      watchMotion();
      watchBattery();
      if (doc && watch.visibility !== false && typeof doc.addEventListener === 'function') {
        doc.addEventListener('visibilitychange', onVisibility);
        detachers.push(function () { doc.removeEventListener('visibilitychange', onVisibility); });
      }
      applyMotion('start');
      var d = new Date(wallNow());
      var w = wanted(d);
      tag = w.tag;
      if (w.id) scene.want(w.id, { fade: false });
      resolveSun(d);
      updateFx();
      // The first frame now: nothing waits for a timer or the font.
      try {
        var c = buildCtx(wallNow());
        clockOff();
        paintFrame(scene.frame(c), true);
      } catch (e) {
        report('first frame', e);
      }
      minuteKey = '';
      minuteTick('start');
      if (doc && watch.visibility !== false && doc.hidden) L.pause('hidden');
      L.start();
      scheduleText();
      return host;
    }

    function stop() {
      stopped = true;
      started = false;
      L.stop();
      if (textTimer !== null) {
        clearT(textTimer);
        textTimer = null;
      }
      if (mq && mqHandler && typeof mq.removeEventListener === 'function') mq.removeEventListener('change', mqHandler);
      mq = null;
      if (battery && batteryHandler && typeof battery.removeEventListener === 'function') battery.removeEventListener('chargingchange', batteryHandler);
      battery = null;
      detachers.splice(0).forEach(function (f) { try { f(); } catch (e) { /* ignore */ } });
      if (fxOn && PCD.hook && fx && PCD.hook.before === fx.apply) PCD.hook.before = null;
      fxOn = false;
      return host;
    }

    function pause(reason) {
      var changed = L.pause(reason);
      if (textTimer !== null) {
        clearT(textTimer);
        textTimer = null;
      }
      return changed;
    }

    function resume(reason) {
      var was = paused();
      var changed = L.resume(reason);
      if (was && !paused() && started) {
        // Back from hidden or a Lively pause: the auto theme, the sun times and the minute text, at once.
        minuteKey = '';
        minuteTick('resume');
        emit('resume', view());
        scheduleText();
      }
      return changed;
    }

    function set(patch) {
      var p = patch || {};
      var before = settings;
      settings = normSettings(p, settings);
      if (settings.theme !== before.theme || p.surprise === null) surpriseState = null;
      var motion = settings.reducedMotion !== before.reducedMotion || settings.performance !== before.performance;
      if (motion) applyMotion('quiet');
      if (settings.weatherFx !== before.weatherFx) updateFx();
      var d = new Date(wallNow());
      if (!applyTheme(true, null)) resolveSun(d);
      if (settings.clock24 !== before.clock24 || settings.sunTimes !== before.sunTimes) L.kick();
      if (started) notify('settings');
      return settings;
    }

    function setWeather(data) {
      weather = data && typeof data === 'object' ? data : null;
      resolveSun(new Date(wallNow()));
      updateFx();
      if (started) {
        if (L.fps() <= 0) L.kick();
        notify('weather');
      }
    }

    function setSun(sun) {
      sunOverride = sun === undefined ? undefined : sun && typeof sun === 'object' ? sun : null;
      resolveSun(new Date(wallNow()));
      if (started) {
        if (L.fps() <= 0) L.kick();
        notify('weather');
      }
    }

    function shake() {
      var t = perfNow();
      if (t - lastShake < SHAKE_DEBOUNCE_MS) {
        counts.shakesIgnored++;
        return false;
      }
      lastShake = t;
      counts.shakes++;
      scene.shake();
      if (reduced || L.fps() <= 0) L.burst(BURST_MS, BURST_FPS);
      emit('shake');
      return true;
    }

    function surprise(opts2) {
      var until = opts2 && opts2.until === 'midnight' ? 'midnight' : 'tab';
      var current = scene.id;
      var list = menuIds().filter(function (id) { return id !== current; });
      if (!list.length) return current;
      var i = Math.floor(Number(rand()) * list.length);
      if (!(i >= 0)) i = 0;
      if (i >= list.length) i = list.length - 1;
      surpriseState = { id: list[i], until: until, day: dayKey(new Date(wallNow())) };
      counts.surprises++;
      applyTheme(true, 'theme');
      return list[i];
    }

    function ringing(onFlag) {
      var next = !!onFlag;
      if (next === isRinging) return isRinging;
      isRinging = next;
      ringOn = next;
      emit('ring', next);
      scheduleText();
      return isRinging;
    }

    function inField(target) {
      var el = target;
      while (el && el.nodeType === 1) {
        var tn = String(el.tagName || '').toUpperCase();
        if (tn === 'INPUT' || tn === 'TEXTAREA' || tn === 'SELECT' || tn === 'BUTTON') return true;
        if (el.isContentEditable) return true;
        el = el.parentElement || el.parentNode;
      }
      return false;
    }

    var IGNORED_KEYS = ['Tab', '/', 'Escape', 'Esc', 'Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'NumLock',
      'ScrollLock', 'Dead', 'Process', 'Unidentified', 'Fn', 'OS', 'AltGraph'];

    function onKey(e) {
      if (!e || e.ctrlKey || e.altKey || e.metaKey || e.isComposing || e.repeat) return;
      if (IGNORED_KEYS.indexOf(e.key) !== -1) return;
      if (inField(e.target)) return;
      shake();
    }

    function attach(el, opts2) {
      var a = opts2 || {};
      var offs = [];
      if (el && typeof el.addEventListener === 'function') {
        var onPointer = function (e) {
          if (e && typeof e.button === 'number' && e.button !== 0) return;
          shake();
        };
        el.addEventListener('pointerdown', onPointer);
        offs.push(function () { el.removeEventListener('pointerdown', onPointer); });
      }
      if (a.keys && doc && typeof doc.addEventListener === 'function') {
        doc.addEventListener('keydown', onKey);
        offs.push(function () { doc.removeEventListener('keydown', onKey); });
      }
      var detach = function () { offs.splice(0).forEach(function (f) { f(); }); };
      detachers.push(detach);
      return detach;
    }

    function stats() {
      var s = L.stats();
      s.minutes = counts.minutes;
      s.colonTicks = counts.colonTicks;
      s.ringTicks = counts.ringTicks;
      s.shakes = counts.shakes;
      s.shakesIgnored = counts.shakesIgnored;
      s.surprises = counts.surprises;
      s.themeSwitches = counts.themeSwitches;
      s.views = counts.views;
      s.engine = scene.stats();
      s.timers = timers();
      s.reduced = reduced;
      s.perf = perf;
      s.onBattery = onBattery;
      return s;
    }

    function timers() {
      var p = L.pending();
      return { frame: p.timer, raf: p.raf, text: textTimer !== null };
    }

    var host = {
      start: start,
      stop: stop,
      pause: pause,
      resume: resume,
      set: set,
      setWeather: setWeather,
      setSun: setSun,
      shake: shake,
      surprise: surprise,
      ringing: ringing,
      attach: attach,
      view: view,
      on: on,
      stats: stats,
      timers: timers,
      ctx: function () { return buildCtx(wallNow()); },
      get canvas() { return canvas; },
      get scene() { return scene; },
      get loop() { return L; },
      get settings() { return normSettings({}, settings); },
      get profile() { return profile; }
    };
    return host;
  }

  var api = {
    STEP: STEP,
    STEP_MS: STEP_MS,
    MAX_STEPS: MAX_STEPS,
    SHAKE_DEBOUNCE_MS: SHAKE_DEBOUNCE_MS,
    BURST_MS: BURST_MS,
    BURST_FPS: BURST_FPS,
    fpsFor: fpsFor,
    loop: loop,
    create: create,
    watchViewport: watchViewport
  };
  PCD.host = api;
  return api;
});
