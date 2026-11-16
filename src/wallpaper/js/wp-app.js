/* PixelClock Desktop wallpaper: the app. Classic script, UMD, global PCD.wpApp. In Node it only exports
 * PCD.wpApp.logic (pure helpers, unit-tested); in a page it boots.
 *
 * What shows: the live scene fills the desktop, dimmed, flush on the side away from the info column; every scene row
 * continues as a band of its own colour under the column. The column (right by default; Lively's "Column side" puts
 * it on the left) holds the big clock with am/pm, the greeting, the date, the daylight strip and the weather block
 * with its credit, and `scene name · phase` sits in its bottom corner. No status line, terminal or links: Local
 * Network Access keeps your clock out of a wallpaper page's reach. The column and its text stay above the
 * taskbar band (the scene runs under it); the desktop icons sit on the dimmed scene.
 *
 * What it does
 * - One settings object: PCD.wpProps.createMapper over the wallpaper's view of PCD.settings (PCD.wpProps.schemaFor:
 *   the shared schema plus "side") with the build's PCD.CONFIG defaults.
 *   The page renders its defaults first; Lively's property replay after load (any order, maybe before this file ran:
 *   see js/lively.js) updates that one object. Textboxes wait 1.5 s after the last keystroke, except during the settle
 *   window (2.5 s after load), when Lively replays saved values and they apply at once.
 * - The scene: PCD.engine.createScene over the synced clock engine, 30 engine steps per second (wp-loop.js); every
 *   displayed frame goes to the console's frame hook, which dims it and paints the scene and its edge bands.
 * - Theme: auto by date (checked every minute and on resume, so midnight cross-fades like the clock), pinned from
 *   the Theme dropdown, or a surprise until local midnight or the next Theme change.
 * - Time of day: ctx.hourFloat through PCD.sun.resolve (the real sunrise and sunset from the forecast when
 *   "Follow the real sunrise and sunset" is on and a city is set); the phase once a minute.
 * - Weather: PCD.weather (Open-Meteo, cached 30 min in localStorage, which Lively empties at each start); the first
 *   request waits for the settle window, so a replayed city applies before anything is fetched. PCD.fx tints the
 *   scene through PCD.hook.before. Never any other network request (the clock status is the new tab's only).
 * - Pause: livelyWallpaperPlaybackChanged {"IsPaused":true} -> reason 'lively'; visibilitychange -> 'hidden'. While
 *   any reason is set: no timer and no requestAnimationFrame at all. Resume re-checks the auto theme, the sun times
 *   and stale weather, and never fast-forwards (at most 7 steps in a frame).
 * - Frame rate: 30 fps; 15 in performance mode or on battery with "Performance mode on battery"
 *   (navigator.getBattery, feature-detected); reduced motion (setting, else prefers-reduced-motion): a still frame
 *   each minute and on every change; a shake then plays 4 s at 15 fps.
 * - Text tick: the colon every half second. With a steady colon (reduced motion, 15 fps) the tick still looks at the
 *   wall clock every 10 s, so a clock change (a time sync, a resume from sleep) shows within seconds.
 * - Hourly surprise: on the hour from 10 am to midnight (the clock's bell hours) the scene shakes, only while
 *   running. Shake (button, pointerdown on the scene) has a 300 ms debounce.
 * - Layout: the console lays out from the page's own innerWidth, innerHeight and devicePixelRatio (one page per
 *   monitor in Lively, or one page across a span), the column side and the taskbar band.
 * - Debug overlay (Customise or ?debug=1): viewport @ DPR, the look (side, k, scene, font, taskbar), fps, p95, pause
 *   reasons, theme and tag, phase, sun times, weather age, IN_LIVELY, origin and battery state.
 *
 * How the app uses the console (js/pcd-console.js and css/pcd-console.css; their headers have the details):
 *   mount     PCD.console.mount(#console, { profile: 'wallpaper', side, fontBase: 'fonts/' }) -> con. Required:
 *             setViewport, update, frame, colon. Used when present: ready, onShake, layout, regions, metrics, info,
 *             report, el.
 *   viewport  con.setViewport({ cssW, cssH, dpr, taskbar, side }) on load, on resize, on a devicePixelRatio change and
 *             when "Column side" or "Keep clear of the taskbar" changes; taskbar = the config's taskbarPx (56) or 0.
 *   frames    con.frame(fb, { snap, fading }) once per displayed frame (the engine's blended 64x64 PC.Canvas): the
 *             scene layer (PCD.bleed, mounted by the console) dims it, paints the scene canvas, the band and the seam.
 *             Still frames (reduced motion, the one frame of a page paused from the start) snap, so the dimming lands
 *             at once; fading (a theme cross-fade) makes the bands follow every frame.
 *   view      con.update(view()) on every change and once a minute: now, clock24, theme, name, tag, phase, themeClock
 *             (the console softens it), sun, curve, weather, steady, reduced. The console draws only what changed.
 *   colon     con.colon(on) from the app's half-second tick (steady under reduced motion and at 15 fps).
 *   hook      the console keeps PCD.hook.mode 'none' (the column shows the clock); the app owns PCD.hook.before.
 *   loop      PCD.wpLoop.create (js/wp-loop.js) behind makeLoop().
 *
 * Test and preview hooks: <html data-ready="1"> once the first frame and the column are shown; window.__pcd and
 * PCD.wpApp (state, settings, defaults, scene, weather, timers, layout, stats, snapshot, paint, debugText). The
 * console's layers carry data-wp-layer="world|scene|veil|column|caption" for the screenshot checks. Query overrides
 * for previews and tests only (Lively passes none): ?city= ?side= ?theme= ?units= ?clock24= ?debug=1 ?reducedMotion=
 * ?performance= ?taskbarSpace= ?shakeHourly= ?weather= ?sunTimes= ?weatherFx=.
 */
(function (root, factory) {
  var api = factory(root.PCD || (root.PCD = {}), root);
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (PCD, root) {
  'use strict';

  // ---------------------------------------------------------------------------------------------------- logic

  var SETTLE_MS = 2500;
  var SHAKE_DEBOUNCE_MS = 300;
  var REDUCED_SHAKE_MS = 4000;
  var REDUCED_SHAKE_FPS = 15;
  var FORCE_GAP_MS = 15000;
  /** With a steady colon the text tick still looks at the wall clock this often (only while running). */
  var STEADY_CHECK_MS = 10000;
  var DEFAULT_TASKBAR = 56;
  var MAX_ERRORS = 50;
  var MAX_CONSOLE_ERRORS = 20;

  /** The clock's bell hours (its simulator/sound.js, bellCount): 10 am through midnight. */
  function bellHour(h) {
    return h >= 10 || h === 0;
  }

  /**
   * Whether the hourly surprise is due at date d: on the hour (seconds 0-2, like the clock's checkBells), in a
   * bell hour, not already done for this hour (lastKey). Returns { due, key }.
   */
  function bellDue(d, lastKey) {
    var key = d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate() + '-' + d.getHours();
    var due = d.getMinutes() === 0 && d.getSeconds() <= 2 && bellHour(d.getHours()) && key !== lastKey;
    return { due: due, key: key };
  }

  /** Reduced motion: the setting 'on' or 'off' wins; 'auto' follows prefers-reduced-motion. */
  function reducedFrom(setting, mediaMatches) {
    if (setting === 'on') return true;
    if (setting === 'off') return false;
    return !!mediaMatches;
  }

  /** Target frame rate: 0 (still) under reduced motion, 15 in performance mode or on battery with 'auto', else 30. */
  function targetFps(o) {
    var x = o || {};
    if (x.reduced) return 0;
    if (x.performance === 'on') return 15;
    if (x.performance === 'auto' && x.onBattery) return 15;
    return 30;
  }

  /** The taskbar band the column keeps clear (CSS px): the config's taskbarPx (else 56) while the setting is on. */
  function taskbarFor(keepClear, config) {
    if (!keepClear) return 0;
    var t = config && config.taskbarPx;
    return typeof t === 'number' && isFinite(t) && t >= 0 ? t : DEFAULT_TASKBAR;
  }

  /** ms of the next local midnight after t (ms). */
  function nextMidnight(t) {
    var d = new Date(t);
    d.setHours(24, 0, 0, 0);
    return d.getTime();
  }

  /** Delay (ms) to the next text tick: the next half second while the colon blinks, else the next second (debug
   * overlay) or the next 10 s (STEADY_CHECK_MS), so a clock change (a time sync, a resume from sleep) shows within
   * seconds; never past a minute boundary. A few ms of slack land it after the edge. */
  function tickDelay(t, o) {
    var x = o || {};
    var period = x.blink ? 500 : x.debug ? 1000 : STEADY_CHECK_MS;
    var toPeriod = period - (t % period);
    var toMinute = 60000 - (t % 60000);
    return Math.min(toPeriod, toMinute) + 3;
  }

  /**
   * The theme to show: { id, tag }. surprise ({ id, until }) wins until it expires; then a pinned theme this build
   * knows; else auto by date (autoId(y, m, d)).
   */
  function themeChoice(o) {
    var x = o || {};
    var t = typeof x.now === 'number' ? x.now : Date.now();
    var ids = x.ids || [];
    if (x.surprise && x.surprise.id && t < x.surprise.until && ids.indexOf(x.surprise.id) >= 0) return { id: x.surprise.id, tag: 'surprise' };
    if (x.theme && x.theme !== 'auto' && ids.indexOf(x.theme) >= 0) return { id: x.theme, tag: 'pinned' };
    var d = new Date(t);
    return { id: typeof x.autoId === 'function' ? x.autoId(d.getFullYear(), d.getMonth() + 1, d.getDate()) : null, tag: 'auto' };
  }

  /** The playback payload Lively sends ('{"IsPaused":true}', or an object): true, false, or null when unreadable. */
  function playbackPaused(data) {
    var v = data;
    if (typeof v === 'string') {
      try {
        v = JSON.parse(v);
      } catch (e) {
        return null;
      }
    }
    if (!v || typeof v !== 'object' || !Object.prototype.hasOwnProperty.call(v, 'IsPaused')) return null;
    if (v.IsPaused === true || v.IsPaused === 'true') return true;
    if (v.IsPaused === false || v.IsPaused === 'false') return false;
    return null;
  }

  /** Query overrides for previews and tests: { key: raw } for the settings keys the page accepts. */
  var QUERY_KEYS = ['city', 'side', 'theme', 'units', 'clock24', 'reducedMotion', 'performance', 'taskbarSpace', 'shakeHourly',
    'weather', 'sunTimes', 'weatherFx', 'debugOverlay'];
  function queryOverrides(search) {
    var out = {};
    var s = String(search || '').replace(/^\?/, '');
    if (!s) return out;
    s.split('&').forEach(function (pair) {
      if (!pair) return;
      var i = pair.indexOf('=');
      var k = decodeQuery(i < 0 ? pair : pair.slice(0, i));
      var v = i < 0 ? '' : decodeQuery(pair.slice(i + 1));
      if (k === 'debug') out.debugOverlay = v === '' || v === '1' || v === 'true' || v === 'on';
      else if (QUERY_KEYS.indexOf(k) >= 0) out[k] = v;
    });
    return out;
  }

  function decodeQuery(s) {
    try {
      return decodeURIComponent(String(s).replace(/\+/g, ' '));
    } catch (e) {
      return String(s);
    }
  }

  var logic = {
    SETTLE_MS: SETTLE_MS,
    SHAKE_DEBOUNCE_MS: SHAKE_DEBOUNCE_MS,
    REDUCED_SHAKE_MS: REDUCED_SHAKE_MS,
    REDUCED_SHAKE_FPS: REDUCED_SHAKE_FPS,
    STEADY_CHECK_MS: STEADY_CHECK_MS,
    DEFAULT_TASKBAR: DEFAULT_TASKBAR,
    QUERY_KEYS: QUERY_KEYS,
    bellHour: bellHour,
    bellDue: bellDue,
    reducedFrom: reducedFrom,
    targetFps: targetFps,
    taskbarFor: taskbarFor,
    nextMidnight: nextMidnight,
    tickDelay: tickDelay,
    themeChoice: themeChoice,
    playbackPaused: playbackPaused,
    queryOverrides: queryOverrides
  };

  var api = {
    logic: logic,
    /** Lively entry point (js/lively.js); replaced by the running app's handle() at boot. */
    handle: function () { return undefined; }
  };
  PCD.wpApp = api;

  var doc = root.document;
  if (!doc || !root.addEventListener || typeof root.requestAnimationFrame !== 'function') return api;

  // ----------------------------------------------------------------------------------------------- the page

  var IN_LIVELY = !!(root.chrome && root.chrome.webview);
  var perf = root.performance;
  var pnow = function () { return perf && perf.now ? perf.now() : Date.now(); };
  var loadedAt = Date.now();
  if (doc.readyState !== 'complete') root.addEventListener('load', function () { loadedAt = Date.now(); });

  var stats = {
    ready: false, inLively: IN_LIVELY, errors: [], errorCount: 0, starts: 0,
    properties: null, playback: 0, playbackBad: 0, sysinfo: 0,
    shakes: 0, shakesDebounced: 0, shakeSources: { button: 0, pointer: 0, hourly: 0 }, hourly: 0, surprises: 0,
    ticks: 0, minutes: 0, themeSwitches: 0, relayouts: 0, dprChanges: 0, viewUpdates: 0,
    weatherChecks: 0, weatherRequests: 0, refreshCoalesced: 0, weather: null,
    battery: { supported: false, pending: true }, storage: 'untested', reducedMotion: false, targetFps: 0,
    pauses: { lively: 0, hidden: 0 }, lastPauseAt: 0, lastResumeAt: 0, timerNames: [], activeTimers: 0, look: ''
  };

  function report(e, where) {
    var msg = (where ? where + ': ' : '') + String(e && e.stack ? e.stack : e);
    stats.errorCount++;
    stats.errors.push(msg);
    if (stats.errors.length > MAX_ERRORS) stats.errors.shift();
    if (!root.console || !root.console.error) return;
    if (stats.errorCount <= MAX_CONSOLE_ERRORS) root.console.error('[pcd-wallpaper] ' + msg);
    else if (stats.errorCount === MAX_CONSOLE_ERRORS + 1) root.console.error('[pcd-wallpaper] more errors: counted in stats.errorCount, not logged');
  }

  var PC = root.PixelClock;
  var P = PCD.wpProps;
  var needs = [['PixelClock', PC], ['PCD.engine', PCD.engine], ['PCD.wpProps', P], ['PCD.settings', PCD.settings], ['PCD.wpLoop', PCD.wpLoop]];
  var missing = needs.filter(function (n) { return !n[1]; }).map(function (n) { return n[0]; });
  if (missing.length) {
    report(new Error('missing scripts: ' + missing.join(', ')), 'boot');
    return api;
  }

  var S = P.schemaFor(PCD.settings);
  var CONFIG = PCD.CONFIG || {};
  var menu = PCD.engine.menu(PC);
  var menuIds = menu.map(function (t) { return t.id; }).filter(function (id) { return id !== 'auto'; });
  var mapper = P.createMapper({ config: CONFIG, menu: menu, schema: S });
  var defaults = mapper.state();
  var settings = S.clone(defaults);
  var query = queryOverrides(root.location ? root.location.search : '');
  Object.keys(query).forEach(function (k) {
    var r = S.validate(k, query[k], { scope: 'wallpaper', themes: menuIds });
    if (r.ok) settings[k] = r.value;
  });

  function settling() {
    return Date.now() - loadedAt < SETTLE_MS;
  }

  // ---- timers: every one is named, so a pause can stop them all and the tests can list them

  var timers = {};
  var running = false; // started and not paused

  function countTimers() {
    var names = Object.keys(timers);
    var pend = loop ? loop.pending() : { timer: false, raf: false };
    if (pend.timer) names.push('frame');
    if (pend.raf) names.push('raf');
    stats.timerNames = names;
    stats.activeTimers = names.length;
  }

  function setTimer(name, fn, ms) {
    clearTimer(name);
    if (!running) return false;
    timers[name] = root.setTimeout(function () {
      delete timers[name];
      try {
        fn();
      } catch (e) {
        report(e, 'timer ' + name);
      }
      countTimers();
    }, Math.max(0, ms));
    countTimers();
    return true;
  }

  function clearTimer(name) {
    if (timers[name] !== undefined) {
      root.clearTimeout(timers[name]);
      delete timers[name];
      countTimers();
    }
  }

  function clearAllTimers() {
    Object.keys(timers).forEach(clearTimer);
  }

  // ---- the router (Customise panel -> settings)

  var router = P.createRouter({
    mapper: mapper,
    apply: function (k, v, name) { applySetting(k, v, name); },
    action: function (name) { onAction(name); },
    setTimer: setTimer,
    clearTimer: clearTimer,
    immediate: settling
  });
  stats.properties = router.counts;

  // ---- scene, loop, console

  var scene = null;
  var loop = null;
  var con = null;
  var fx = null;
  var fxActive = false;
  var ready = false;
  var reasons = {};
  var reduced = false;
  var onBattery = false;
  var tag = 'auto';
  var surprise = null;
  var lastBellKey = '';
  var lastMinuteKey = '';
  var lastShakeAt = -1e9;
  var colonOn = true;
  var sunToday = null;
  var phase = '';
  var curve = null;
  var shownTheme = '';      // the theme whose clock colour the column shows (after a cross-fade has ended)
  var wx = null;            // the weather client
  var wxState = null;
  var wxBusy = false;
  var wxReq = 0;
  var lastForcedOkAt = 0;
  var debugEl = null;
  var mq = null;
  var dprWatch = null;
  var rand = Math.random;
  var taskbarPx = taskbarFor(true, CONFIG);

  function sceneName() {
    var id = scene && scene.id;
    var t = id && PC.themeById(id);
    return t ? t.name : '';
  }

  /** The engine ctx for now: real time, hourFloat through the sun remap, hour12 from the setting. */
  function ctxNow() {
    var d = new Date();
    var hf;
    try {
      hf = PCD.sun ? PCD.sun.resolve(d, { id: scene.id, sun: sunToday, follow: !!settings.sunTimes }).hourFloat : undefined;
    } catch (e) {
      hf = undefined;
    }
    return PCD.engine.ctx(d, { clock24: !!settings.clock24, hourFloat: hf });
  }

  function onSteps(n) {
    var c = ctxNow();
    for (var i = 0; i < n; i++) {
      scene.step(c);
      if (fxActive) fx.step(PCD.engine.STEP);
    }
  }

  /**
   * One displayed frame: the engine draws, the console dims and paints it (scene, band, seam). A still frame snaps
   * the dimming and the bands (nothing to ease from); during a cross-fade the bands follow every frame.
   */
  function onDraw(info) {
    var fb = scene.frame(ctxNow());
    con.frame(fb, { snap: !!(info && info.still), fading: !!scene.fading });
    if (!scene.fading && scene.id !== shownTheme) {
      // a switch has finished: the column takes the new theme's clock colour
      shownTheme = scene.id;
      renderView();
    }
    if (!stats.ready) markReady();
  }

  function makeLoop() {
    return PCD.wpLoop.create({
      fps: 30,
      step: onSteps,
      draw: onDraw,
      onError: function (e) { report(e, 'frame'); }
    });
  }

  /**
   * The console: the shared PCD.console (js/pcd-console.js). The app needs setViewport, update, frame and colon.
   * Throws (init reports it) when the console is missing or lacks those members.
   */
  function mountConsole(rootEl) {
    if (!PCD.console || typeof PCD.console.mount !== 'function') throw new Error('no console: js/pcd-console.js (PCD.console) is not loaded');
    var c = PCD.console.mount(rootEl, { profile: 'wallpaper', side: settings.side, fontBase: 'fonts/' });
    if (!c || ['setViewport', 'update', 'frame', 'colon'].some(function (k) { return typeof c[k] !== 'function'; })) {
      throw new Error('PCD.console.mount() lacks setViewport, update, frame or colon');
    }
    var tagLayer = function (name, layer) {
      var e = typeof c.el === 'function' ? c.el(name) : null;
      if (e && e.setAttribute) e.setAttribute('data-wp-layer', layer);
    };
    tagLayer('world', 'world');
    tagLayer('column', 'column');
    tagLayer('caption', 'caption');
    tagLayer('canvas', 'scene');
    var veil = c.scene && c.scene.veil;
    if (veil && veil.setAttribute) veil.setAttribute('data-wp-layer', 'veil');
    stats.look = 'PCD.console' + (PCD.bleed && typeof PCD.bleed.mountScene === 'function' ? ' + PCD.bleed' : '');
    return c;
  }

  /** data-ready once the first frame is painted and the column shows its text (its font is in, or timed out). */
  var frameDrawn = false;
  var textShown = false;
  function markReady() {
    frameDrawn = true;
    if (!textShown || stats.ready) return;
    stats.ready = true;
    doc.documentElement.setAttribute('data-ready', '1');
  }

  function watchReady(c) {
    var done = function () {
      textShown = true;
      if (frameDrawn) markReady();
      renderView();
    };
    if (c && c.ready && typeof c.ready.then === 'function') c.ready.then(done, done);
    else done();
  }

  // ---- theme

  function themeNow() {
    return themeChoice({
      now: Date.now(), ids: menuIds, theme: settings.theme, surprise: surprise,
      autoId: function (y, m, d) { return PCD.engine.autoId(PC, y, m, d); }
    });
  }

  function applyTheme(fade) {
    var t = themeNow();
    if (surprise && t.tag !== 'surprise') surprise = null;
    tag = t.tag;
    if (t.id && scene && t.id !== scene.id) {
      scene.want(t.id, { fade: !!fade && !reduced });
      stats.themeSwitches++;
      updateFx();
      if (loop) loop.kick();
    }
  }

  // ---- motion and power

  function applyMotion() {
    var mqm = false;
    try {
      mqm = !!(mq && mq.matches);
    } catch (e) {
      mqm = false;
    }
    reduced = reducedFrom(settings.reducedMotion, mqm);
    stats.reducedMotion = reduced;
    var fps = targetFps({ reduced: reduced, performance: settings.performance, onBattery: onBattery });
    stats.targetFps = fps;
    if (loop) {
      loop.setFps(fps);
      if (fps === 0) loop.kick();
    }
    colonOn = true;
    if (con) con.colon(true);
    updateFx();
    if (running) scheduleTick();
    renderView();
  }

  function steadyColon() {
    return reduced || stats.targetFps < 30;
  }

  function initBattery() {
    var nav = root.navigator;
    if (!nav || typeof nav.getBattery !== 'function') {
      stats.battery = { supported: false };
      return;
    }
    var p;
    try {
      p = nav.getBattery();
    } catch (e) {
      stats.battery = { supported: false, error: String(e && e.message ? e.message : e) };
      return;
    }
    Promise.resolve(p).then(function (b) {
      if (!b || typeof b.charging !== 'boolean') {
        stats.battery = { supported: false, error: 'no battery manager' };
        return;
      }
      var sync = function () {
        onBattery = b.charging === false;
        stats.battery = { supported: true, level: b.level, charging: b.charging };
      };
      sync();
      if (typeof b.addEventListener === 'function') {
        b.addEventListener('chargingchange', function () {
          try {
            sync();
            applyMotion();
          } catch (e) {
            report(e, 'battery');
          }
        });
        b.addEventListener('levelchange', function () { sync(); });
      }
      applyMotion();
    }, function (e) {
      stats.battery = { supported: false, error: String(e && e.message ? e.message : e) };
    });
  }

  // ---- weather and sun

  var WX_KEY = (PCD.weather && PCD.weather.STORAGE_KEY) || 'pcd.weather';

  function probeStorage() {
    var ls = null;
    try {
      ls = root.localStorage;
    } catch (e) {
      return { store: null, status: 'blocked (' + (e && e.name ? e.name : 'error') + ')' };
    }
    if (!ls) return { store: null, status: 'unavailable' };
    try {
      var key = 'pcd.probe';
      var v = String(Date.now());
      ls.setItem(key, v);
      var back = ls.getItem(key);
      ls.removeItem(key);
      if (back !== v) return { store: null, status: 'read-back mismatch' };
    } catch (e) {
      return { store: null, status: 'write failed (' + (e && e.name ? e.name : 'error') + ')' };
    }
    return {
      store: {
        getItem: function (k) {
          try {
            var raw = ls.getItem(k);
            if (raw && k === WX_KEY && PCD.weather && typeof PCD.weather.cacheOk === 'function') {
              var parsed = JSON.parse(raw);
              if (!PCD.weather.cacheOk(parsed)) return null;
            }
            return raw;
          } catch (e) {
            return null;
          }
        },
        setItem: function (k, v) {
          try { ls.setItem(k, v); } catch (e) { /* an optional cache */ }
        }
      },
      status: 'write/read OK'
    };
  }

  function cityKey(c) {
    return String(c || '').trim().replace(/\s+/g, ' ').toLowerCase();
  }

  /** A forecast is needed for the weather block, the scene effects or the real sun times (all need a city). */
  function forecastWanted() {
    return !!(PCD.weather && cityKey(settings.city).length >= (PCD.weather.MIN_CITY || 3) && (settings.weather || settings.sunTimes));
  }

  function wxData() {
    return wxState && wxState.data && cityKey(wxState.city) === cityKey(settings.city) ? wxState.data : null;
  }

  function weatherSoon(ms) {
    if (!forecastWanted() || !wx) {
      clearTimer('weather');
      return;
    }
    var settle = loadedAt + SETTLE_MS - Date.now();
    setTimer('weather', function () { weatherCheck(false); }, Math.max(ms || 0, settle));
  }

  function weatherCheck(force) {
    clearTimer('weather');
    if (!wx || !forecastWanted()) return;
    stats.weatherChecks++;
    var req = { city: settings.city, units: settings.units, force: !!force };
    var id = ++wxReq;
    wxBusy = true;
    wx.get(req).then(function (st) {
      if (id !== wxReq) return;
      wxBusy = false;
      stats.weatherRequests = wx.requests();
      if (req.force && st && st.fetched && st.status === 'ok') lastForcedOkAt = Date.now();
      if (cityKey(req.city) !== cityKey(settings.city) || req.units !== settings.units) return;
      wxState = st;
      stats.weather = { status: st.status, stale: st.stale, error: st.error, fetchedAt: st.fetchedAt, place: st.place ? st.place.name : null };
      onWeather();
      scheduleWeather(st);
    }, function (e) {
      if (id !== wxReq) return;
      wxBusy = false;
      report(e, 'weather');
      setTimer('weather', function () { weatherCheck(false); }, 60000);
    });
  }

  function scheduleWeather(st) {
    if (!forecastWanted()) return;
    if (!st || st.status === 'no-city' || st.status === 'short' || st.status === 'not-found') return;
    var at = st.nextRefreshAt || Date.now() + 30 * 60 * 1000;
    var delay = Math.min(30 * 60 * 1000, Math.max(30000, at - Date.now()));
    setTimer('weather', function () { weatherCheck(false); }, delay);
  }

  function refreshWeather() {
    router.flush();
    if (!forecastWanted()) return;
    if (wxBusy || (lastForcedOkAt && Date.now() - lastForcedOkAt < FORCE_GAP_MS)) {
      stats.refreshCoalesced++;
      return;
    }
    weatherCheck(true);
  }

  function onWeather() {
    updateSun(new Date());
    updateFx();
    renderView();
    if (loop && reduced) loop.kick();
  }

  function updateSun(d) {
    var data = wxData();
    sunToday = null;
    if (data && PCD.sun) {
      try {
        sunToday = PCD.sun.today(data, d);
      } catch (e) {
        sunToday = null;
      }
    }
    if (PCD.sun && scene && scene.id) {
      try {
        var r = PCD.sun.resolve(d, { id: scene.id, sun: sunToday, follow: !!settings.sunTimes });
        phase = r.phase;
        curve = PCD.sun.curve(r.anchor, r.source === 'sun' ? r.sun : null);
      } catch (e) {
        report(e, 'sun');
      }
    }
  }

  function updateFx() {
    if (!fx) return;
    var data = settings.weather && settings.weatherFx ? wxData() : null;
    var w = data && PCD.fx ? PCD.fx.input(data, { indoor: PCD.fx.isIndoor(scene && scene.id), reducedMotion: reduced }) : null;
    fx.set(w);
    fxActive = !!w;
  }

  /**
   * The weather block's data (the console formats it: icon, temperature and condition, feels and wind, high and low,
   * the credit with ' · 2 h ago' at 60 minutes or more). null when the weather is off or there is no data: the block
   * is gone.
   */
  function weatherView() {
    var data = settings.weather ? wxData() : null;
    if (!data) return null;
    var place = wxState.place && wxState.place.name ? String(wxState.place.name).toLowerCase() : cityKey(settings.city);
    return { data: data, units: wxState.units, city: place, ageMs: wxState.fetchedAt ? Math.max(0, Date.now() - wxState.fetchedAt) : null };
  }

  // ---- the view

  /** What the console shows, built on changes and once a minute, never per frame. */
  function view() {
    var sunUsed = !!(settings.sunTimes && sunToday && PCD.sun && PCD.sun.usable(sunToday));
    var colors = PCD.hook && PCD.hook.colors ? PCD.hook.colors : null;
    return {
      now: Date.now(),
      clock24: !!settings.clock24,
      theme: scene ? scene.id : null,
      name: sceneName(),
      tag: tag,
      phase: phase,
      // the theme's own clock colour: the console softens it for the big clock
      themeClock: colors && typeof colors.clock === 'number' ? colors.clock : null,
      // the real sun times in local hours while they set the scene's light (the strip's end labels), else null
      sun: sunUsed && typeof sunToday.rise === 'number' && typeof sunToday.set === 'number' ? { rise: sunToday.rise, set: sunToday.set } : null,
      curve: curve,
      weather: weatherView(),
      steady: steadyColon(),
      reduced: reduced
    };
  }

  function renderView() {
    if (!ready || !con) return;
    try {
      con.update(view());
      stats.viewUpdates++;
    } catch (e) {
      report(e, 'console update');
    }
    renderDebug();
  }

  // ---- layout

  function viewport() {
    return {
      cssW: root.innerWidth, cssH: root.innerHeight, dpr: root.devicePixelRatio || 1,
      taskbar: settings.taskbarSpace ? taskbarPx : 0, side: settings.side
    };
  }

  function relayout() {
    if (!ready) return;
    try {
      con.setViewport(viewport());
    } catch (e) {
      report(e, 'layout');
      return;
    }
    stats.relayouts++;
    renderDebug();
    if (loop) loop.kick();
  }

  function watchDpr() {
    if (dprWatch) {
      try { dprWatch.mq.removeEventListener('change', dprWatch.fn); } catch (e) { /* gone */ }
      dprWatch = null;
    }
    if (!root.matchMedia) return;
    var dpr = root.devicePixelRatio || 1;
    var m = root.matchMedia('(resolution: ' + dpr + 'dppx)');
    var fn = function () {
      stats.dprChanges++;
      watchDpr();
      relayout();
    };
    if (m && m.addEventListener) {
      m.addEventListener('change', fn);
      dprWatch = { mq: m, fn: fn };
    }
  }

  // ---- text tick (colon, minute work, debug overlay): the app's only periodic timer

  function scheduleTick() {
    if (!running) return;
    var blink = !steadyColon();
    setTimer('tick', onTick, tickDelay(Date.now(), { blink: blink, debug: !!settings.debugOverlay }));
  }

  function onTick() {
    stats.ticks++;
    var d = new Date();
    var key = Math.floor(d.getTime() / 60000);
    if (key !== lastMinuteKey) {
      lastMinuteKey = key;
      minuteWork(d, false);
    }
    if (!steadyColon()) {
      colonOn = d.getMilliseconds() < 500;
      con.colon(colonOn);
    }
    if (settings.debugOverlay) renderDebug();
    scheduleTick();
  }

  /** Once a minute and on resume: auto theme, surprise expiry, sun and phase, the hourly surprise, the column. */
  function minuteWork(d, resumed) {
    stats.minutes++;
    applyTheme(true);
    updateSun(d);
    if (!resumed && running && settings.shakeHourly) {
      var b = bellDue(d, lastBellKey);
      if (b.due) {
        lastBellKey = b.key;
        stats.hourly++;
        shake('hourly');
      }
    }
    if (reduced && loop) loop.kick();
    renderView();
  }

  // ---- shake, surprise

  function shake(source) {
    var t = pnow();
    if (t - lastShakeAt < SHAKE_DEBOUNCE_MS) {
      stats.shakesDebounced++;
      return false;
    }
    lastShakeAt = t;
    scene.shake();
    stats.shakes++;
    if (stats.shakeSources[source] !== undefined) stats.shakeSources[source]++;
    // the full-screen scene never nudges; under reduced motion the shake plays as a short burst
    if (reduced && loop) loop.burst(REDUCED_SHAKE_MS, REDUCED_SHAKE_FPS);
    return true;
  }

  function doSurprise() {
    var id = scene.surprise(rand);
    if (!id) return;
    scene.want(id, { fade: !reduced });
    surprise = { id: id, until: nextMidnight(Date.now()) };
    tag = 'surprise';
    stats.surprises++;
    stats.themeSwitches++;
    updateFx();
    updateSun(new Date());
    if (loop) loop.kick();
    renderView();
  }

  // ---- settings and actions from Customise

  function applySetting(k, v) {
    var before = settings[k];
    settings[k] = v;
    var changed = !S.equal(before, v);
    if (k === 'theme' && (changed || !settling())) surprise = null;
    if (!ready || !changed && k !== 'theme') return;
    switch (k) {
      case 'theme':
        applyTheme(true);
        renderView();
        break;
      case 'side':
      case 'taskbarSpace':
        relayout();
        break;
      case 'clock24':
        renderView();
        break;
      case 'city':
        wxState = null;
        sunToday = null;
        updateSun(new Date());
        updateFx();
        renderView();
        peekWeather();
        weatherSoon(0);
        break;
      case 'units':
        renderView();
        weatherSoon(300);
        break;
      case 'weather':
      case 'sunTimes':
      case 'weatherFx':
        updateSun(new Date());
        updateFx();
        renderView();
        if (forecastWanted()) weatherSoon(0);
        else clearTimer('weather');
        break;
      case 'reducedMotion':
      case 'performance':
        applyMotion();
        break;
      case 'debugOverlay':
        renderDebug();
        if (running) scheduleTick();
        break;
      default:
        break;
    }
  }

  function onAction(name) {
    if (name === 'surprise') doSurprise();
    else if (name === 'shakeNow') shake('button');
    else if (name === 'refreshWeather') refreshWeather();
  }

  function peekWeather() {
    if (!wx || !forecastWanted()) return;
    var req = { city: settings.city, units: settings.units };
    wx.peek(req).then(function (st) {
      if (wxState || !st || !st.data) return;
      if (cityKey(req.city) !== cityKey(settings.city) || req.units !== settings.units) return;
      wxState = st;
      onWeather();
    }, function () { /* no cache */ });
  }

  // ---- pause and resume

  function setPause(reason, on) {
    if (on) {
      if (reasons[reason]) return;
      reasons[reason] = true;
      stats.pauses[reason] = (stats.pauses[reason] || 0) + 1;
      stats.lastPauseAt = Date.now();
      if (loop) loop.pause(reason);
      syncRunning();
    } else {
      if (!reasons[reason]) return;
      delete reasons[reason];
      if (loop) loop.resume(reason);
      syncRunning();
    }
    renderDebug();
  }

  function anyReason() {
    for (var k in reasons) if (Object.prototype.hasOwnProperty.call(reasons, k)) return true;
    return false;
  }

  function syncRunning() {
    var should = ready && !anyReason();
    if (should && !running) {
      running = true;
      stats.starts++;
      stats.lastResumeAt = Date.now();
      router.resume();
      lastMinuteKey = Math.floor(Date.now() / 60000);
      minuteWork(new Date(), true);
      scheduleTick();
      weatherSoon(0);
    } else if (!should && running) {
      running = false;
      router.suspend();
      clearAllTimers();
    }
    countTimers();
  }

  function onPlayback(data) {
    var p = playbackPaused(data);
    if (p === null) {
      stats.playbackBad++;
      return false;
    }
    stats.playback++;
    setPause('lively', p);
    return true;
  }

  function handle(kind, args) {
    try {
      if (kind === 'property') return router.property(args[0], args[1]);
      if (kind === 'playback') return onPlayback(args[0]);
      if (kind === 'sysinfo') {
        stats.sysinfo++;
        return true;
      }
    } catch (e) {
      report(e, 'lively ' + kind);
    }
    return undefined;
  }

  // ---- debug overlay

  function fmt(v, d) {
    return typeof v === 'number' && isFinite(v) ? v.toFixed(d) : '-';
  }

  function clockText(ms) {
    if (!ms) return '-';
    var d = new Date(ms);
    var p = function (n) { return (n < 10 ? '0' : '') + n; };
    return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  }

  /** The debug overlay's look and scene rows: the column side and taskbar band; k, the scene's place, the cell. */
  function lookText() {
    return 'full screen, column ' + settings.side + ', taskbar ' + (settings.taskbarSpace ? taskbarPx + ' px' : 'off');
  }

  function sceneText() {
    var m = con && typeof con.metrics === 'function' ? con.metrics() : null;
    var L = con && typeof con.layout === 'function' ? con.layout() : null;
    var parts = [];
    if (m) parts.push('k ' + m.k + ', ' + m.size + ' px at ' + m.x + ',' + m.y);
    if (L && L.font && L.cell) parts.push('font ' + L.font.px + ' px, cell ' + +L.cell.w.toFixed(2) + ' x ' + +L.cell.h.toFixed(2));
    return parts.join('; ') || '-';
  }

  function debugLines() {
    var dpr = root.devicePixelRatio || 1;
    var ls = loop ? loop.stats() : {};
    var b = stats.battery || {};
    var bat = b.supported ? Math.round((b.level || 0) * 100) + ' %, ' + (b.charging ? 'charging' : 'on battery') : 'not supported' + (b.pending ? ' (pending)' : '');
    var reasonText = Object.keys(reasons).sort().join(', ') || 'running';
    var w = stats.weather;
    var age = wxState && wxState.fetchedAt ? Math.round((Date.now() - wxState.fetchedAt) / 60000) + ' min' : '-';
    var sun = sunToday && PCD.sun ? PCD.sun.text(sunToday, !!settings.clock24) || '-' : '-';
    var row = function (k, v) {
      var key = (k + '          ').slice(0, 10);
      return key + v;
    };
    return [
      row('viewport', root.innerWidth + ' x ' + root.innerHeight + ' @ ' + dpr),
      row('look', lookText()),
      row('scene', sceneText()),
      row('fps', fmt(ls.fps, 1) + ' (target ' + stats.targetFps + (onBattery ? ', on battery' : '') + (reduced ? ', reduced motion' : '') + ')'),
      row('p95', fmt(ls.p95, 3) + ' ms step + draw; frames ' + (ls.frames || 0) + ', steps ' + (ls.steps || 0)),
      row('paused', reasonText + '; pauses: lively ' + (stats.pauses.lively || 0) + ', hidden ' + (stats.pauses.hidden || 0) +
        (stats.lastPauseAt ? ', last ' + clockText(stats.lastPauseAt) : '')),
      row('theme', (scene && scene.id ? scene.id : '-') + ' (' + sceneName().toLowerCase() + '), ' + tag),
      row('phase', (phase || '-') + ', sun ' + sun + (settings.sunTimes ? '' : ' (off)')),
      row('weather', (w ? w.status + (w.stale ? ' stale' : '') : settings.weather ? 'none yet' : 'off') + ', age ' + age),
      row('lively', IN_LIVELY ? 'IN_LIVELY yes (window.chrome.webview)' : 'IN_LIVELY no (preview)'),
      row('origin', String(root.location ? root.location.origin : '?')),
      row('battery', bat),
      row('console', (stats.look || '-') + ', storage ' + stats.storage)
    ];
  }

  function renderDebug() {
    if (!debugEl) return;
    var on = !!settings.debugOverlay;
    debugEl.hidden = !on;
    if (!on) return;
    var text = debugLines().join('\n');
    if (debugEl.textContent !== text) debugEl.textContent = text;
    // centred over the scene side, clear of the column (css/wallpaper.css centres it on this point)
    var r = con && typeof con.regions === 'function' ? con.regions() : null;
    var col = r && r.column;
    var w = root.innerWidth;
    var x = col ? (settings.side === 'left' ? (col.x + col.w + w) / 2 : col.x / 2) : w / 2;
    debugEl.style.left = Math.round(x) + 'px';
  }

  // ---- test and preview hooks

  function copy(v) {
    return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
  }

  function sceneInfo() {
    var ls = loop ? loop.stats() : {};
    var m = con && typeof con.metrics === 'function' ? con.metrics() : null;
    return {
      id: scene ? scene.id : null, name: sceneName(), tag: tag, k: m ? m.k : 0, fps: ls.fps, target: stats.targetFps,
      frames: ls.frames, steps: ls.steps, paused: anyReason(), reasons: Object.keys(reasons).sort(), engine: scene ? scene.stats() : null,
      hookMode: PCD.hook ? PCD.hook.mode : null, fx: fxActive, phase: phase, reduced: reduced, side: settings.side
    };
  }

  function snapshot() {
    countTimers();
    var has = function (k) { return con && typeof con[k] === 'function'; };
    return {
      state: copy(settings),
      stats: copy(stats),
      loop: loop ? loop.stats() : null,
      scene: sceneInfo(),
      layout: has('layout') ? copy(con.layout()) : null,
      metrics: has('metrics') ? copy(con.metrics()) : null,
      regions: has('regions') ? copy(con.regions()) : null,
      look: has('info') ? copy(con.info()) : null,
      taskbar: settings.taskbarSpace ? taskbarPx : 0,
      view: copy(view()),
      weather: copy(wxState),
      sun: copy(sunToday),
      viewport: { width: root.innerWidth, height: root.innerHeight, dpr: root.devicePixelRatio || 1 },
      running: running,
      settling: settling(),
      surprise: copy(surprise)
    };
  }

  /** The console's paint report (tests: the scene geometry, the painted frame and the band data). */
  function paintReport() {
    return con && typeof con.report === 'function' ? copy(con.report()) : null;
  }

  // ---- boot

  function init() {
    var rootEl = doc.getElementById('console');
    debugEl = doc.getElementById('debug');
    if (!rootEl) throw new Error('index.html has no #console');
    con = mountConsole(rootEl);
    watchReady(con);
    scene = PCD.engine.createScene({ PC: PC, log: function (m) { report(m, 'engine'); } });
    fx = PCD.fx ? PCD.fx.create((Date.now() & 0x7fffffff) || 1) : null;
    if (PCD.hook) PCD.hook.before = function (cv, c) { if (fxActive && fx) fx.apply(cv, c); };
    if (typeof con.onShake === 'function') con.onShake(function () { if (running) shake('pointer'); });
    var st = probeStorage();
    stats.storage = st.status;
    wx = PCD.weather ? PCD.weather.createClient({ storage: st.store || undefined }) : null;
    try {
      mq = root.matchMedia ? root.matchMedia('(prefers-reduced-motion: reduce)') : null;
    } catch (e) {
      mq = null;
    }
    loop = makeLoop();
    // a pause that arrived before init (queued playback event)
    Object.keys(reasons).forEach(function (r) { loop.pause(r); });
    ready = true;
    applyTheme(false);
    updateSun(new Date());
    relayout();
    applyMotion();
    initBattery();
    peekWeather();
    if (mq && mq.addEventListener) {
      mq.addEventListener('change', function () {
        try { applyMotion(); } catch (e) { report(e, 'reduced motion'); }
      });
    }
    root.addEventListener('resize', function () {
      try { relayout(); } catch (e) { report(e, 'resize'); }
    });
    watchDpr();
    doc.addEventListener('visibilitychange', function () { setPause('hidden', !!doc.hidden); });
    if (doc.hidden) setPause('hidden', true);
    loop.start();
    syncRunning();
    if (anyReason()) {
      // paused from the start (Lively paused before load, or a hidden page): still show one frame
      try { onDraw({ still: true }); } catch (e) { report(e, 'first frame'); }
    }
    renderView();
  }

  api.handle = handle;
  api.inLively = IN_LIVELY;
  api.stats = stats;
  api.state = function () { return copy(settings); };
  api.defaults = function () { return copy(defaults); };
  api.snapshot = snapshot;
  api.paint = paintReport;
  api.debugText = function () { return debugLines().join('\n'); };
  api.shake = function () { return shake('button'); };
  root.__pcd = {
    state: function () { return copy(settings); },
    settings: function () { return copy(settings); },
    defaults: function () { return copy(defaults); },
    scene: sceneInfo,
    weather: function () { return copy(wxState); },
    timers: function () { countTimers(); return stats.timerNames.slice(); },
    layout: function () { return con && typeof con.layout === 'function' ? copy(con.layout()) : null; },
    stats: function () { return copy(stats); },
    loop: function () { return loop ? loop.stats() : null; },
    snapshot: snapshot,
    paint: paintReport,
    debugText: function () { return debugLines().join('\n'); }
  };

  // Calls that arrived before this file ran (js/lively.js queued them): replay in order.
  var queued = root.__pcdLivelyQueue;
  if (queued && queued.length) queued.splice(0).forEach(function (c) { handle(c[0], c[1]); });

  try {
    init();
  } catch (e) {
    report(e, 'init');
  }
  return api;
});
