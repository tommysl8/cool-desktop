/* PixelClock Desktop wallpaper: the frame loop.
 * Classic script, UMD, global PCD.wpLoop (module.exports in Node; the tests run it with fake timers).
 *
 * The wallpaper's own frame loop (kept separate from PCD.host): js/wp-app.js uses PCD.wpLoop.create() through one
 * adapter (see its header). Nothing here touches the DOM, the engine or a clock other than the injected ones.
 *
 * Rules:
 * - Steps: an accumulator (acc += min(0.25 s, elapsed); while acc >= 1/30: one step) keeps 30 engine steps per
 *   second at any frame rate; acc is capped at 0.25 s, so a frame never carries more than 7 steps and a resume
 *   never fast-forwards (the step clock restarts at the resume).
 * - Frames: setTimeout until the next frame is due (33.3 ms at 30 fps, 66.7 ms at 15), then ONE
 *   requestAnimationFrame that steps and draws. No rAF chain at the display rate.
 * - Pause: named reasons ('lively', 'hidden', ...) are counted; while any is set there is no timer and no rAF.
 * - Still mode (fps 0, reduced motion): no loop at all; kick() paints one frame (no steps) in the next rAF.
 *   burst(ms, fps) animates for a while (a shake under reduced motion: 4 s at 15 fps), then the loop is still again.
 *
 * Contract (L = PCD.wpLoop.create(opts)):
 *   opts: { fps (30), step(n) (n steps of 1/30 s are due, inside rAF), draw(info) (paint, inside rAF;
 *           info = { steps, still, burst }), onError(e), now(), setTimeout, clearTimeout, requestAnimationFrame,
 *           cancelAnimationFrame }
 *   L.start() / L.stop()          begin / end for good (stop clears everything)
 *   L.pause(reason) / L.resume(reason) -> boolean (whether that changed the reason set)
 *   L.paused() -> boolean          any reason set; L.reasons() -> [names]
 *   L.setFps(n)                    0 = still; else frames per second (15, 30); takes effect at once
 *   L.kick()                       one frame as soon as possible (a change while still or between frames)
 *   L.burst(ms, fps)               animate at fps for ms even in still mode
 *   L.pending() -> { timer, raf }  what is armed right now (pause makes both false at once)
 *   L.stats() -> { frames, steps, stillFrames, fps, p95, target, effective, paused, reasons, pauses, resumes,
 *                  maxSteps, lastSteps, sinceResume: { frames, steps, maxSteps }, burst, pending }
 *   L.resetStats()                 clears the fps and cost windows and the counters since the last resume
 */
(function (root, factory) {
  var api = factory(root.PCD || (root.PCD = {}), root);
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (PCD, root) {
  'use strict';

  var STEP_MS = 1000 / 30;
  /** acc += min(0.25 s, elapsed), and acc never holds more than 0.25 s: at most 7 steps per frame. */
  var MAX_ACC_MS = 250;
  var MAX_STEPS = Math.floor(MAX_ACC_MS / STEP_MS);
  /** A frame within 2 ms of its due time counts as due (setTimeout fires late, rarely early). */
  var EARLY_MS = 2;
  var FPS_WINDOW_MS = 5000;
  var COST_WINDOW = 150;

  function defaultNow() {
    var p = root.performance;
    return p && typeof p.now === 'function' ? p.now() : Date.now();
  }

  function create(opts) {
    var o = opts || {};
    var now = typeof o.now === 'function' ? o.now : defaultNow;
    var setT = typeof o.setTimeout === 'function' ? o.setTimeout : function (fn, ms) { return root.setTimeout(fn, ms); };
    var clearT = typeof o.clearTimeout === 'function' ? o.clearTimeout : function (id) { root.clearTimeout(id); };
    var raf = typeof o.requestAnimationFrame === 'function' ? o.requestAnimationFrame : function (fn) { return root.requestAnimationFrame(fn); };
    var caf = typeof o.cancelAnimationFrame === 'function' ? o.cancelAnimationFrame : function (id) { root.cancelAnimationFrame(id); };
    var onStep = typeof o.step === 'function' ? o.step : null;
    var onDraw = typeof o.draw === 'function' ? o.draw : null;
    var onError = typeof o.onError === 'function' ? o.onError : function (e) {
      if (root.console && root.console.error) root.console.error('[pcd-wallpaper] frame: ' + (e && e.stack ? e.stack : e));
    };

    var fps = sanitizeFps(o.fps === undefined ? 30 : o.fps);
    var started = false;
    var reasons = {};
    var timer = null;
    var rafId = null;
    var nextDue = 0;
    var stepClock = -1;   // time of the last step accounting; -1 = restart the step clock at the next frame
    var acc = 0;
    var kickWanted = false;
    var burstUntil = 0;
    var burstFps = 0;
    var frameTimes = [];
    var costs = [];
    var counts = { frames: 0, steps: 0, stillFrames: 0, pauses: 0, resumes: 0, maxSteps: 0, lastSteps: 0 };
    var since = { frames: 0, steps: 0, maxSteps: 0 };

    function sanitizeFps(v) {
      var n = Number(v);
      if (!isFinite(n) || n <= 0) return 0;
      return Math.min(60, n);
    }

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

    /** The frame rate in force at time t: a burst wins over still mode. */
    function effective(t) {
      if (bursting(t)) return burstFps;
      return fps;
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
      stepClock = t;
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
          if (burstUntil > 0) burstUntil = 0; // the burst just ended: still again
          return;
        }
        if (t < nextDue - EARLY_MS) {
          rafId = raf(onRaf); // early (a timer fired ahead of time): wait for the next vsync
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
        while (acc >= STEP_MS - 1e-6 && n < MAX_STEPS) {
          n++;
          acc -= STEP_MS;
        }
        if (acc < 0) acc = 0;
      }
      var t0 = now();
      try {
        if (n > 0 && onStep) onStep(n);
        if (onDraw) onDraw({ steps: n, still: eff <= 0, burst: bursting(t), kick: wasKick });
      } catch (e) {
        try { onError(e); } catch (e2) { /* the error reporter itself failed: nothing else to do */ }
      }
      record(t, n, now() - t0, eff <= 0);
      if (eff > 0) {
        var interval = 1000 / eff;
        nextDue += interval;
        if (nextDue < t || t - nextDue > interval) nextDue = t + interval; // fell behind: resync, never burst
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
        restartClock(now());
        if (burstUntil > 0 && !bursting(now())) burstUntil = 0;
        kickWanted = true; // repaint at once: the picture may be stale
        arm();
      }
      return true;
    }

    function setFps(v) {
      var next = sanitizeFps(v);
      if (next === fps) return fps;
      var wasStill = effective(now()) <= 0;
      fps = next;
      if (!running()) return fps;
      disarm();
      if (wasStill && effective(now()) > 0) restartClock(now());
      else nextDue = Math.min(nextDue, now() + (fps > 0 ? 1000 / fps : 0));
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
      burstFps = sanitizeFps(rate === undefined ? 15 : rate) || 15;
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

    function percentile(list, p) {
      if (!list.length) return 0;
      var a = list.slice().sort(function (x, y) { return x - y; });
      return a[Math.min(a.length - 1, Math.max(0, Math.ceil(a.length * p) - 1))];
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
        since.frames = 0;
        since.steps = 0;
        since.maxSteps = 0;
      }
    };
  }

  var api = {
    STEP_MS: STEP_MS,
    MAX_ACC_MS: MAX_ACC_MS,
    MAX_STEPS: MAX_STEPS,
    EARLY_MS: EARLY_MS,
    FPS_WINDOW_MS: FPS_WINDOW_MS,
    create: create
  };
  PCD.wpLoop = api;
  return api;
});
