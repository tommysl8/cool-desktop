/* PixelClock Desktop, new tab: the page wiring (the scene filling the tab and the console column on the left).
 * Classic script, the last deferred script.
 *
 * What runs here, and who draws it:
 *   PCD.console  (src/shared/pcd-console.js) the live scene filling the tab (dimmed, its edge bands, the veil) and the
 *                console column on the left: clock, greeting, date, clock status, daylight strip, weather, the links
 *                [1]-[9], the terminal slot and the bottom row (hint, scene · phase, ≡ settings). It never fetches,
 *                stores or runs a timer.
 *   PCD.host     (src/shared/pcd-host.js) the clock's engine at 30 steps a second and every timer that moves: frames at
 *                30 fps (15 in performance mode; 'auto' = on battery), a still frame each minute under reduced motion
 *                (a shake plays 4 s), the colon, the minute, the ringing pulse; nothing at all while the tab is hidden.
 *   PCD.store    (js/ntp-store.js) the settings in chrome.storage.sync (localStorage in preview), live in every tab.
 *   PCD.weather  Open-Meteo for the settings' city and units, after the first frame, again when due (30 min) while
 *                visible and when back online; the forecast's sun times drive the scene and the strip.
 *   PCD.status   (js/ntp-status.js) the real clock's status line (GET http://pixelclock.local/api/status), after the
 *                first frame; ringing pulses the line at 2 Hz through the host.
 *   PCD.links    (js/ntp-links.js) the links: the settings' shortcuts, or top sites with the optional permission.
 *   PCD.term     (js/term/) the terminal in the console's slot; its app object is `app` below.
 *   PCD.panel    (js/ntp-panel.js) the settings sheet over the column, opened by "≡ settings" and the terminal's
 *                settings command; the focus goes back to the terminal when it closes.
 * First paint: the page is bg until the scene covers it; boot.js already applied the mirror
 * (localStorage pcd.mirror: the settings below; reduced motion) and, with focusTerminal on, the focus redirect; here the
 * console and the first scene frame come at once, from the mirrored settings, before the store answers; the network
 * starts after that frame. The mirror also keeps the last forecast shown (wx: today's, for the same city and units),
 * whether a clock line showed (st) and the links on show (lk), so the first frame already has the final layout: the
 * weather block, the sun times, a blank status row until the clock has had its say, and the links (a list edited in
 * the sheet, or top sites) until the store has answered. Nothing moves under the prompt when they land.
 * Test clock: ?at=YYYY-MM-DDTHH:MM (and &freeze=1) shifts the page's clock (PCD.core.clockFromParams); a preview page
 * (no chrome.runtime.id) shows ?status=<sample> instead of asking the clock.
 * Read-only test hooks: <html data-ready="1"> once the first frame and the column's text show; window.__pcd.
 */
(function (root) {
  'use strict';
  if (root.__pcdRedirecting) return; // boot.js is replacing this first document with newtab.html?focus

  var PCD = root.PCD || (root.PCD = {});
  var PC = root.PixelClock;
  var doc = root.document;
  var html = doc.documentElement;

  var MIRROR_KEY = 'pcd.mirror';
  var WEATHER_KEY = 'weather';
  var WEATHER_RETRY_MS = 60000; // a failed or not-yet-due refresh is asked again after this while visible
  var scriptMs = Math.round(performance.now());
  var reported = {};

  function report(what, e) {
    if (reported[what]) return;
    reported[what] = true;
    if (root.console) root.console.error('[pcd-newtab] ' + what + ': ' + (e && e.stack ? e.stack : e));
  }

  function warn(text) {
    if (root.console) root.console.warn('[pcd-newtab] ' + text);
  }

  function copy(v) { return v === undefined ? undefined : JSON.parse(JSON.stringify(v)); }

  var el = { root: doc.getElementById('console'), panel: doc.getElementById('panel') };
  var missing = ['engine', 'console', 'host', 'settings'].filter(function (k) {
    return k === 'engine' ? !PC || !PCD.engine : k === 'console' ? !PCD.console || !el.root : k === 'host' ? !PCD.host : !PCD.settings;
  });
  if (missing.length) {
    report('start', new Error('missing: ' + missing.join(', ') + ' (the build ships every script in order)'));
    return;
  }

  var S = PCD.settings;
  var CONFIG = PCD.CONFIG && typeof PCD.CONFIG === 'object' ? PCD.CONFIG : {};
  var isExtension = !!(root.chrome && root.chrome.runtime && root.chrome.runtime.id);
  var menu = PCD.engine.menu(PC);
  var themeIds = menu.filter(function (t) { return t.id !== 'auto'; }).map(function (t) { return t.id; });
  var clock = PCD.core && typeof PCD.core.clockFromParams === 'function' ? PCD.core.clockFromParams(root.location.search) : null;
  var nowMs = clock && clock.offsetMs ? clock.ms : function () { return Date.now(); };

  // ----------------------------------------------------------------------------------------------- settings

  var mirrorText = null;
  var mirrored = null; // what the last tab left in pcd.mirror (an object), or null
  var settings = S.defaults(CONFIG, { scope: 'newtab', themes: themeIds });
  try {
    mirrorText = root.localStorage.getItem(MIRROR_KEY);
    mirrored = JSON.parse(mirrorText || 'null');
    if (mirrored && typeof mirrored === 'object' && !Array.isArray(mirrored)) {
      // the last known values until the store answers (boot.js painted with them)
      var known = S.mirror(mirrored);
      Object.keys(known).forEach(function (k) { if (Object.prototype.hasOwnProperty.call(mirrored, k)) settings[k] = known[k]; });
    } else {
      mirrored = null;
    }
  } catch (e) {
    mirrorText = null;
    mirrored = null;
  }

  function hostSettings(s) {
    return {
      theme: S.effectiveTheme(s, themeIds), clock24: !!s.clock24, reducedMotion: s.reducedMotion, performance: s.performance,
      sunTimes: s.sunTimes !== false, weatherFx: s.weather !== false && s.weatherFx !== false
    };
  }

  var store = null;
  try {
    store = PCD.store.create({
      config: CONFIG,
      themes: themeIds,
      onError: function (e) { warn('settings storage: ' + (e && e.message ? e.message : e)); }
    });
  } catch (e) {
    report('settings store', e);
  }

  // ----------------------------------------------------------------------------------------------- console and host

  var con = PCD.console.mount(el.root, { profile: 'newtab', side: 'left', fontBase: 'fonts/' });
  var hostView = null;
  var firstFrameMs = null;
  // Every frame reaches the console through the host's paint option (PCD.host.create({ paint: con.frame })): the
  // scene layer dims it and draws its bands, and the host keeps no canvas of its own. The layer snaps its exposure
  // by itself on the first frame and on a frame that comes long after the last one (reduced motion: once a minute).
  var host = PCD.host.create({
    profile: 'newtab',
    paint: con.frame,
    sceneClock: 'none',
    settings: hostSettings(settings),
    now: nowMs
  });
  var weatherState = null; // the client's last state (shown while settings.weather is on and it has data)
  var statusView = null; // PCD.status.describe() view, or null: no line
  var statusAnswered = false; // the clock has answered or failed once in this tab (or showed a cached line)
  var links = []; // [{ n, label, url }]
  var linksWait = false; // the mirror's links show until the store has answered; then the link source takes over
  var term = null;
  var panel = null;
  var readyMs = null;
  var textShown = false;
  var started = false;

  /** <html data-ready="1"> once the first scene frame is painted and the column's text shows (the font, or 250 ms). */
  function maybeReady() {
    if (readyMs !== null || firstFrameMs === null || !textShown) return;
    html.setAttribute('data-ready', '1');
    readyMs = Math.round(performance.now());
  }

  /** A blank status row until the clock has had its say, when the last tab showed a line (the mirror's st). */
  function statusReserved() {
    return isExtension && !statusAnswered && !statusView && settings.clockStatus !== false && !!(mirrored && mirrored.st === true);
  }

  function viewNow() {
    var v = Object.assign({}, hostView || host.view());
    v.weather = settings.weather !== false && weatherState && weatherState.data ? weatherState : null;
    v.status = statusView;
    v.reserve = { status: statusReserved() };
    v.links = links.map(function (l) { return { label: l.label, url: l.url }; });
    v.settings = !!panel;
    return v;
  }

  function draw() {
    if (!started) return;
    try {
      con.update(viewNow());
    } catch (e) {
      report('console update', e);
    }
  }

  host.on('view', function (v) {
    var motionChanged = !!(hostView && hostView.reduced) !== !!v.reduced;
    hostView = v;
    html.classList.toggle('pcd-reduced', !!v.reduced);
    draw();
    writeMirror();
    // the prompt's caret starts or stops blinking with the new motion setting (its text and place stay)
    if (motionChanged && term && typeof term.motion === 'function') term.motion();
  });
  host.on('colon', function (on) { con.colon(on); });
  host.on('ring', function (on) { con.ring(on); });
  con.onShake(function () { host.shake(); });

  function viewport() {
    return { cssW: root.innerWidth, cssH: root.innerHeight, dpr: root.devicePixelRatio || 1 };
  }

  // ----------------------------------------------------------------------------------------------- the mirror

  /** The settings boot.js and the next tab's first frame need (no colour: the page is bg until the scene covers it),
   *  the forecast on show (wx: the next tab's first frame has the weather block and the sun times at once), whether
   *  a clock line shows (st: the next tab keeps its row) and the links on show (lk: the next tab's first frame has
   *  them before chrome.storage answers). */
  function writeMirror() {
    var m = { v: 1 };
    var keys = S.mirror(settings);
    Object.keys(keys).forEach(function (k) { m[k] = keys[k]; });
    m.wx = weatherWanted() && weatherState && weatherState.data && typeof weatherState.fetchedAt === 'number' ? {
      data: weatherState.data, units: weatherState.units, city: weatherState.city, place: weatherState.place || null,
      fetchedAt: weatherState.fetchedAt
    } : null;
    // until the clock has had its say in this tab, the last tab's answer stands
    m.st = settings.clockStatus !== false && (statusView ? true : statusAnswered ? false : !!(mirrored && mirrored.st === true));
    m.lk = links.slice(0, PCD.links.MAX).map(function (l) { return { label: l.label, url: l.url }; });
    var text = JSON.stringify(m);
    if (text === mirrorText) return;
    mirrorText = text;
    try {
      root.localStorage.setItem(MIRROR_KEY, text);
    } catch (e) {
      // storage blocked: the next tab paints bg first and redirects for focus (the defaults)
    }
  }

  // ----------------------------------------------------------------------------------------------- weather and sun

  var weatherClient = null;
  var weatherTimer = 0;
  var weatherSeq = 0;

  /** chrome.storage.local as { get(key), set(key, value) } (the weather cache, the terminal's history); a preview
   *  page (no chrome.runtime.id) keeps them in localStorage under pcd.<key>. */
  var localArea = (function () {
    var area = isExtension && root.chrome.storage && root.chrome.storage.local;
    if (area) {
      return {
        get: function (k) { return area.get(k).then(function (o) { return o ? o[k] : undefined; }); },
        set: function (k, v) { var o = {}; o[k] = v; return area.set(o); }
      };
    }
    return {
      get: function (k) {
        try { return JSON.parse(root.localStorage.getItem('pcd.' + k) || 'null'); } catch (e) { return null; }
      },
      set: function (k, v) {
        try { root.localStorage.setItem('pcd.' + k, JSON.stringify(v)); } catch (e) { /* this tab only */ }
      }
    };
  })();

  function weatherWanted() {
    return !!settings.city && (settings.weather !== false || settings.sunTimes !== false);
  }

  function clearWeatherTimer() {
    if (weatherTimer) root.clearTimeout(weatherTimer);
    weatherTimer = 0;
  }

  /** Ask the client (it serves its 30-minute cache, geocodes only on a new city, backs off on failures). */
  function refreshWeather(force) {
    clearWeatherTimer();
    if (!weatherClient) return;
    var my = ++weatherSeq;
    if (!weatherWanted()) {
      weatherState = null;
      host.setWeather(null);
      draw();
      return;
    }
    if (doc.visibilityState === 'hidden') return; // the visibilitychange handler asks when the tab shows
    weatherClient.get({ city: settings.city, units: settings.units, force: !!force }).then(function (st) {
      if (my !== weatherSeq) return;
      weatherState = st && st.data ? st : null;
      host.setWeather(weatherState ? weatherState.data : null);
      draw();
      writeMirror();
      if (st && st.status === 'not-found' && panel) panel.note('city', 'city not found', 'info');
      scheduleWeather(st);
    }, function (e) {
      report('weather', e);
    });
  }

  /** The next refresh while the tab is visible: when the cache is due (or the back-off ends); none when hidden or
   *  offline (the 'online' listener asks again), none for a city that needs a settings change; anything but a fresh
   *  answer waits at least WEATHER_RETRY_MS. */
  function scheduleWeather(st) {
    clearWeatherTimer();
    if (doc.visibilityState === 'hidden' || !weatherWanted()) return;
    if (root.navigator && root.navigator.onLine === false) return;
    if (st && /^(not-found|short|no-city)$/.test(st.status)) return;
    var at = st && typeof st.nextRefreshAt === 'number' ? st.nextRefreshAt : nowMs() + WEATHER_RETRY_MS;
    if (!st || st.status !== 'ok') at = Math.max(at, nowMs() + WEATHER_RETRY_MS);
    weatherTimer = root.setTimeout(function () {
      weatherTimer = 0;
      refreshWeather(false);
    }, Math.max(1000, at - nowMs()));
  }

  function cityKey(c) { return String(c == null ? '' : c).replace(/\s+/g, ' ').trim().toLowerCase(); }

  /** The last tab's forecast (the mirror's wx) for the first frame: today's, not from the future, for the same city and
   *  units. The block, the sun times and the scene's weather show at once; the client's answer replaces it a moment
   *  later (its cache, or the network when a refresh is due), and old data shows its age in the credit. */
  function weatherFromMirror() {
    var wx = mirrored && mirrored.wx;
    if (!wx || typeof wx !== 'object' || !wx.data || typeof wx.data !== 'object' || typeof wx.fetchedAt !== 'number') return;
    if (!weatherWanted() || wx.units !== settings.units || cityKey(wx.city) !== cityKey(settings.city)) return;
    var t = nowMs();
    if (wx.fetchedAt > t || new Date(wx.fetchedAt).toDateString() !== new Date(t).toDateString()) return;
    weatherState = {
      status: 'ok', stale: false, city: wx.city, units: wx.units, place: wx.place && typeof wx.place === 'object' ? wx.place : null,
      data: wx.data, fetchedAt: wx.fetchedAt, ageMs: t - wx.fetchedAt, mirrored: true
    };
    host.setWeather(wx.data);
  }

  function startWeather() {
    weatherClient = PCD.weather.createClient({ storage: localArea, now: nowMs, key: WEATHER_KEY });
    doc.addEventListener('visibilitychange', function () {
      if (doc.visibilityState === 'hidden') clearWeatherTimer();
      else refreshWeather(false); // the cache answers at once unless a refresh is due
    });
    root.addEventListener('online', function () { refreshWeather(false); });
    refreshWeather(false);
  }

  // ----------------------------------------------------------------------------------------------- the clock's status

  var statusLine = null;

  /** ?status=<sample> on a preview page: a sample line instead of the clock (never in the extension). */
  function statusSample() {
    if (isExtension) return undefined;
    try {
      return new URLSearchParams(root.location.search).get('status') || undefined;
    } catch (e) {
      return undefined;
    }
  }

  function startStatus() {
    statusLine = PCD.status.mountLine({
      settings: settings,
      onRinging: function (on) {
        host.ringing(on); // the 2 Hz pulse ('ring' events) and the view's ringing
        con.ringing(on);
        hostView = host.view();
        draw();
      },
      onView: function (v) {
        statusView = v && v.show ? v : null;
        if (statusView) statusAnswered = true;
        draw();
        writeMirror();
      },
      // the clock answered or failed: a reserved row (statusReserved) is laid out for good or goes
      onAnswer: function () {
        if (statusAnswered) return;
        statusAnswered = true;
        draw();
        writeMirror();
      },
      sample: statusSample()
    });
    statusLine.start();
  }

  // ----------------------------------------------------------------------------------------------- links

  var linkSource = PCD.links.create({
    chrome: root.chrome,
    onChange: function (st) {
      links = st.items;
      draw();
      writeMirror();
    }
  });

  /** The links the last tab showed (the mirror's lk) for the first frame. A list edited in the sheet, or top sites, is
   *  in chrome.storage, which answers a moment after that frame; until it has, the link source waits (startLinks). */
  function linksFromMirror() {
    var lk = mirrored && mirrored.lk;
    if (!store || !Array.isArray(lk)) return;
    links = PCD.links.items(lk);
    linksWait = true;
  }

  /** The link source's first list, for the settings the store answered with (an edited list or top sites starts it
   *  at once in applySettings). */
  function startLinks() {
    if (!linksWait) return;
    linksWait = false;
    linkSource.update(settings);
  }

  // ----------------------------------------------------------------------------------------------- the app seam

  function set(patch) {
    return store ? store.set(patch) : Promise.resolve({ ok: false, error: 'no settings store' });
  }

  function sceneInfo() {
    var v = host.view();
    return { id: v.id, name: String(v.name || '').toLowerCase(), tag: v.tag };
  }

  function surprise() {
    host.surprise({ until: 'tab' });
    return sceneInfo();
  }

  var actions = PCD.term && PCD.term.url && typeof PCD.term.url.actions === 'function'
    ? PCD.term.url.actions({ chrome: root.chrome, location: root.location, open: root.open.bind(root) }) : null;

  /** The page's seam for the terminal (the app object of js/term/term-shell.js; its header lists the members). */
  var app = {
    links: function () { return links.map(function (l) { return { name: l.label, url: l.url }; }); },
    openUrl: function (url, newTab) {
      return actions ? actions.openUrl(url, newTab) : Promise.reject(new Error('cannot open addresses here'));
    },
    search: function (text, newTab) {
      return actions ? actions.search(text, newTab) : Promise.reject(new Error('no search engine here'));
    },
    theme: function (which) {
      if (which === 'list') return menu.filter(function (t) { return t.id !== 'auto'; }).map(function (t) {
        return { id: t.id, name: String(t.name).toLowerCase(), kind: PC.themeById(t.id) ? PC.themeById(t.id).kind : '' };
      });
      var id = which === 'auto' || themeIds.indexOf(which) >= 0 ? which : null;
      if (!id) return Promise.reject(new Error('no scene called ' + which));
      settings.theme = id; // at once in this tab (the store echoes it and every other tab follows)
      // an explicit scene ends this tab's surprise, even when the stored theme is the one asked for
      host.set({ theme: S.effectiveTheme(settings, themeIds), surprise: null });
      return set({ theme: id }).then(sceneInfo, sceneInfo);
    },
    surprise: surprise,
    shake: function () { return host.shake(); },
    setClock24: function (on) {
      settings.clock24 = !!on;
      host.set({ clock24: !!on });
      return set({ clock24: !!on });
    },
    openSettings: function () { openSheet(); },
    view: viewNow,
    storage: localArea // the terminal's history (termHistory)
  };
  PCD.ntp = app;

  // ----------------------------------------------------------------------------------------------- the terminal

  function startTerminal() {
    if (!PCD.term || typeof PCD.term.mount !== 'function') {
      report('terminal', new Error('js/term/ did not load'));
      return;
    }
    try {
      // the console's slot (its element and size in cells; the console draws the rule above it)
      term = PCD.term.mount(con.term() || con.el('term'), app, {
        focus: false, // after the console's text shows (con.ready): a hidden prompt cannot take the focus
        reducedMotion: function () { return !!(hostView && hostView.reduced); }
      });
    } catch (e) {
      report('terminal', e);
      term = null;
      return;
    }
    // lines typed in other tabs reach this tab's history at once (Up offers the newest): an event, no timer
    var adopt = function (list) {
      if (term && term.shell && typeof term.shell.adopt === 'function') term.shell.adopt(list);
    };
    var area = isExtension && root.chrome.storage && root.chrome.storage.onChanged;
    if (area && typeof area.addListener === 'function') {
      area.addListener(function (changes, name) {
        if (name === 'local' && changes && changes.termHistory) adopt(changes.termHistory.newValue);
      });
    } else if (!isExtension) {
      // a preview page keeps the history in localStorage (pcd.termHistory): other tabs' writes come as storage events
      root.addEventListener('storage', function (e) {
        if (e.key !== 'pcd.termHistory') return;
        var list;
        try { list = e.newValue === null ? [] : JSON.parse(e.newValue); } catch (err) { return; }
        adopt(list);
      });
    }
  }

  function focusTerminal() {
    if (term) term.focus();
  }

  // ----------------------------------------------------------------------------------------------- the settings sheet

  function placeSheet() {
    if (!panel) return;
    var r = con.regions();
    panel.setRect(r && r.sheet ? r.sheet : null, r ? { fontPx: r.fontPx, cell: r.cell } : null);
  }

  function openSheet() {
    if (panel && !panel.isOpen()) panel.open(con.el('settings'));
  }

  function startSheet() {
    if (!store || !PCD.panel) return;
    panel = PCD.panel.mount({
      store: store,
      parent: el.panel,
      themes: menu,
      onSurprise: surprise,
      onTheme: function (id) { return app.theme(id); }, // this tab at once; it ends a surprise
      surpriseNow: function () { return host.view().tag === 'surprise' ? sceneInfo() : null; },
      requestTopSites: function () { return PCD.links.requestTopSites(root.chrome); },
      focusBack: function () { return term ? term.el.input : null; },
      onToggle: function (open) {
        con.sheet(open);
        if (open) placeSheet();
      },
      autoName: function () {
        var d = new Date(nowMs());
        var id = PCD.engine.autoId(PC, d.getFullYear(), d.getMonth() + 1, d.getDate());
        for (var i = 0; i < menu.length; i++) if (menu[i].id === id) return menu[i].name;
        return id || '';
      }
    });
    var button = con.el('settings');
    if (button) button.addEventListener('click', function () { panel.toggle(button); });
    draw(); // "≡ settings" shows once the sheet can open
  }

  // ----------------------------------------------------------------------------------------------- settings, live

  function applySettings(next, changedKeys) {
    if (!next || typeof next !== 'object') return;
    var prev = settings;
    var changed = changedKeys || Object.keys(next).filter(function (k) { return !S.equal(prev[k], next[k]); });
    if (!changed.length) return;
    settings = copy(next);
    var has = function (k) { return changed.indexOf(k) >= 0; };
    host.set(hostSettings(settings));
    if (statusLine) statusLine.update(settings);
    if (has('shortcuts') || has('shortcutsMode')) {
      linksWait = false;
      linkSource.update(settings);
    }
    if (weatherClient && (has('city') || has('units') || has('weather') || has('sunTimes'))) refreshWeather(false);
    draw();
    writeMirror();
  }

  // ----------------------------------------------------------------------------------------------- start

  function relayout() {
    con.setViewport(viewport());
    if (panel && panel.isOpen()) placeSheet();
  }

  function startParts() {
    try { startStatus(); } catch (e) { report('status', e); }
    try { startWeather(); } catch (e) { report('weather', e); }
  }

  function start() {
    con.setViewport(viewport());
    try { weatherFromMirror(); } catch (e) { weatherState = null; }
    try { linksFromMirror(); } catch (e) { links = []; linksWait = false; }
    // the first scene frame, at once, through con.frame: it never waits for the font, the settings or the network
    host.start();
    firstFrameMs = Math.round(performance.now());
    started = true; // the column's text from here: one draw below, not one more inside host.start()'s first view
    hostView = host.view();
    draw();
    startTerminal();
    con.onLayout(function () {
      if (term) term.layout(con.term()); // null (the slot dropped in a tiny window) keeps the terminal as it is
      if (panel && panel.isOpen()) placeSheet();
    });
    PCD.host.watchViewport(root, relayout);
    if (!linksWait) linkSource.update(settings);
    startSheet();
    if (store) {
      store.subscribe(function (s, info) { applySettings(s, info && info.changed); });
      store.load().then(function (s) {
        try {
          applySettings(s);
        } finally {
          startLinks();
        }
      }, function (e) {
        report('settings load', e);
        startLinks();
      });
      root.addEventListener('pagehide', function () {
        try { store.flush(); } catch (e) { /* the page is going away */ }
      });
    }
    con.ready.then(function () {
      textShown = true;
      maybeReady();
      focusTerminal(); // the column (and the prompt) can take the focus once its text shows
    });
    // the network (weather, the clock's status) starts after the first frame has been painted
    root.requestAnimationFrame(function () { root.setTimeout(startParts, 0); });
  }

  // ----------------------------------------------------------------------------------------------- test hooks (read-only)

  root.__pcd = Object.freeze({
    state: function () {
      var v = host.view();
      return {
        ready: html.getAttribute('data-ready') === '1', scriptMs: scriptMs, firstFrameMs: firstFrameMs, readyMs: readyMs,
        extension: isExtension, focus: { setting: settings.focusTerminal !== false, redirected: /[?&]focus(=|&|$)/.test(root.location.search),
          active: doc.activeElement ? doc.activeElement.className || doc.activeElement.tagName : null, has: doc.hasFocus() },
        theme: v.id, tag: v.tag, phase: v.phase, colon: v.colon,
        reduced: v.reduced, perf: v.perf, paused: v.paused, pauseReasons: v.reasons,
        store: store ? store.kind : null, sheet: !!(panel && panel.isOpen()), term: !!term,
        csp: Array.isArray(root.__pcdCsp) ? copy(root.__pcdCsp) : null, mirror: mirrorText
      };
    },
    settings: function () { return copy(settings); },
    scene: function () {
      var v = host.view();
      var s = host.stats();
      var m = con.metrics();
      return {
        id: v.id, name: v.name, tag: v.tag, fading: v.fading, k: m ? m.k : null, rect: m, fps: s.fps, targetFps: s.target,
        effectiveFps: s.effective, frames: s.frames, steps: s.steps, stillFrames: s.stillFrames, p95: s.p95, burst: s.burst,
        paused: s.paused, pauseReasons: s.reasons, shakes: s.shakes, surprises: s.surprises, onBattery: s.onBattery,
        hookMode: PCD.hook ? PCD.hook.mode : null, rendering: root.getComputedStyle(con.canvas).imageRendering
      };
    },
    view: function () { return copy(viewNow()); },
    /** The console's lines as shown (null: not shown). */
    lines: function () {
      var out = {};
      ['greet', 'date', 'status', 'weather', 'links', 'hint', 'caption', 'settings'].forEach(function (n) {
        var e = con.el(n);
        var cs = e ? root.getComputedStyle(e) : null;
        out[n] = e && !e.hidden && cs.display !== 'none' && cs.visibility !== 'hidden' ? e.textContent : null;
      });
      return out;
    },
    /** The scene canvas as painted (64 x 64 RGBA) and where it sits (device px): the crisp-block checks. */
    pixels: function () {
      var m = con.metrics();
      var d = con.canvas.getContext('2d').getImageData(0, 0, 64, 64).data;
      return { k: m && m.k, x: m && m.x, y: m && m.y, size: m && m.size, dpr: m && m.dpr, data: Array.prototype.slice.call(d) };
    },
    weather: function () {
      return weatherState ? { status: weatherState.status, stale: weatherState.stale, city: weatherState.city, units: weatherState.units,
        ageMs: weatherState.ageMs, kind: weatherState.data && weatherState.data.kind, nextRefreshAt: weatherState.nextRefreshAt,
        timer: !!weatherTimer, mirrored: !!weatherState.mirrored } : { status: null, timer: !!weatherTimer, wanted: weatherWanted() };
    },
    status: function () { return statusLine ? statusLine.state() : null; },
    /** The link source's state, plus the links on show and whether they are still the mirror's (the last tab's). */
    links: function () {
      var s = linkSource.state();
      s.shown = links.map(function (l) { return { n: l.n, label: l.label, url: l.url }; });
      s.mirrored = linksWait;
      return s;
    },
    console: function () { return con.info(); },
    term: function () { return term ? term.state() : null; },
    panel: function () { return panel ? panel.state() : null; },
    timers: function () {
      var t = host.timers();
      return { frame: t.frame, raf: t.raf, text: t.text, weather: !!weatherTimer, status: statusLine ? statusLine.state().nextInMs : null };
    }
  });

  try {
    start();
  } catch (e) {
    report('start', e);
  }
})(typeof window !== 'undefined' ? window : this);
