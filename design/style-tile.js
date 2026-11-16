/* PixelClock Desktop: the style tile, the visual gate of the whole look. Classic
 * script, the last deferred script of dist/style-tile/index.html (tools/build/style-tile.mjs builds it; run
 * node tools/test-style-tile.mjs for the screenshots and checks). Everything on it is drawn by the real shared modules
 * (PCD.console over PCD.bleed, PCD.ascii, PCD.layout, PCD.font, PCD.core, PCD.color, PCD.greet, PCD.sun, PCD.weather,
 * PCD.engine over the synced clock engine). Static unless live=1: no network, no storage; scene frames are drawn once.
 *
 *   ?view=board (default)  palette and contrast gate, type, glyphs and the glyph gate, every ASCII element of the
 *                          console, every theme at dawn / day / sunset / night, and the full-screen console in 4 themes
 *                          x day and night on both sides: the new tab (column left) and the wallpaper (column right),
 *                          mini screens of 1240 x 776 device px without a taskbar
 *   ?view=console          one full-size console, as the real page would show it at that moment:
 *     profile=newtab|wallpaper|still (still: the wallpaper's console with the calendar face)  side=left|right
 *     theme=auto|<id>  tag=auto|pinned|surprise  at=YYYY-MM-DDTHH:MM (local; default 2026-11-15T20:40)  clock=12|24
 *     wx=<kind>|off (default drizzle)  status=next|snoozed|ringing|testing|none|unknown|off (new tab, default next)
 *     links=<0-9>  sheet=1  taskbar=<css px> (wallpaper, default 56)  suntimes=0 (theme hours)  stale=<min>
 *     live=1 (driven by PCD.host: the reference wiring)  ui=0 (no text: the contrast check's background)
 *     veil=0 (no veil: the crisp check)
 * The weather and the clock's status are samples (the sample city Berlin; Berlin's sun times from NOAA's formula).
 * window.__tile = { ready: Promise, report() } for tools/test-style-tile.mjs.
 */
(function (root) {
  'use strict';
  var PCD = root.PCD || {};
  var PC = root.PixelClock;
  var doc = root.document;
  var tile = doc.getElementById('tile');
  var errors = [];
  var scenes = [];
  var consoles = [];
  var notes = [];
  var gate = null;
  var DPR = root.devicePixelRatio || 1;
  var core = PCD.core;
  var C = PCD.color;
  var A = PCD.ascii;

  /** Lines of runs ({ text, tone, bold } or PCD.greet's [text, 'role bold']) into an element, as the console draws them. */
  function draw(el, block) {
    return A.fill(el, (block || []).map(function (line) { return A.toLine(line); }), {
      className: function (r) { return core.roleClass((r.tone || '') + (r.bold ? ' bold' : '')); }
    });
  }

  root.addEventListener('error', function (e) { errors.push(String(e && e.message ? e.message : e)); });

  function param(k, d) {
    return core && core.param ? core.param(k, d) : d;
  }

  // ------------------------------------------------------------------------------------------------ samples

  var CITY = 'Berlin';
  var LAT = 52.52;
  var LON = 13.405;
  /** One WMO code per weather kind (PCD.weather gives its kind and words) and a wind speed (mph). */
  var WX = {
    clear: { code: 0, wind: 4 },
    partly: { code: 2, wind: 8 },
    cloudy: { code: 3, wind: 10 },
    fog: { code: 45, wind: 2 },
    drizzle: { code: 53, wind: 9 },
    rain: { code: 61, wind: 9 },
    freezing: { code: 56, wind: 7 },
    snow: { code: 71, wind: 6 },
    thunder: { code: 95, wind: 14 }
  };
  /** Sample links: public sites the shipped-URL allowlist names (tools/validate.mjs), nothing personal. */
  var SHORTCUTS = [
    { label: 'weather', url: 'https://open-meteo.com/' },
    { label: 'github', url: 'https://github.com/' },
    { label: 'youtube', url: 'https://www.youtube.com/' },
    { label: 'search', url: 'https://www.google.com/' },
    { label: 'example', url: 'https://example.com/' }
  ];
  /** The console scenarios of the board: 4 themes, day and night (auto by date): [at, weather kind]. */
  var SCENARIOS = [
    { name: 'autumn', day: ['2026-11-15T12:30', 'partly'], night: ['2026-11-15T20:40', 'drizzle'] },
    { name: 'winter', day: ['2027-01-12T13:05', 'snow'], night: ['2027-01-12T22:10', 'clear'] },
    { name: 'summer', day: ['2026-07-18T14:10', 'clear'], night: ['2026-07-18T22:30', 'thunder'] },
    { name: 'halloween', day: ['2026-10-31T11:20', 'fog'], night: ['2026-10-31T21:10', 'clear'] }
  ];
  /** The clock status each scenario's new tab shows. */
  var STATUS = { autumn: 'next', winter: 'snoozed', summer: 'none', halloween: 'next' };
  /** Berlin's average daily high (°F) by month: the samples' temperature, so a summer sample does not read 38°F. */
  var MONTH_TEMP = [37, 40, 48, 58, 67, 73, 77, 76, 67, 56, 46, 39];

  /** Sunrise and sunset in local clock hours for a date (NOAA's simple solar equations; Berlin's CET / CEST). */
  function sunTimes(date) {
    var start = new Date(date.getFullYear(), 0, 0);
    var doy = Math.floor((new Date(date.getFullYear(), date.getMonth(), date.getDate()) - start) / 86400000);
    var g = ((2 * Math.PI) / 365) * (doy - 1);
    var eq = 229.18 * (0.000075 + 0.001868 * Math.cos(g) - 0.032077 * Math.sin(g) - 0.014615 * Math.cos(2 * g) - 0.040849 * Math.sin(2 * g));
    var decl = 0.006918 - 0.399912 * Math.cos(g) + 0.070257 * Math.sin(g) - 0.006758 * Math.cos(2 * g) +
      0.000907 * Math.sin(2 * g) - 0.002697 * Math.cos(3 * g) + 0.00148 * Math.sin(3 * g);
    var la = (LAT * Math.PI) / 180;
    var cosH = Math.cos((90.833 * Math.PI) / 180) / (Math.cos(la) * Math.cos(decl)) - Math.tan(la) * Math.tan(decl);
    var ha = (Math.acos(Math.max(-1, Math.min(1, cosH))) * 180) / Math.PI;
    var y = date.getFullYear();
    var lastSunday = function (m) { var x = new Date(y, m + 1, 0); return x.getDate() - x.getDay(); };
    var t = date.getMonth() * 100 + date.getDate();
    var tz = t >= 200 + lastSunday(2) && t < 900 + lastSunday(9) ? 2 : 1;
    return { rise: (720 - 4 * (LON + ha) - eq) / 60 + tz, set: (720 - 4 * (LON - ha) - eq) / 60 + tz };
  }

  /** A PCD.weather-shaped sample of a kind, its temperatures moved to the month's typical value. */
  function weatherSample(kind, date, sun) {
    var w = WX[kind];
    if (!w) return null;
    var h = date.getHours() + date.getMinutes() / 60;
    var t = MONTH_TEMP[date.getMonth()] + (kind === 'snow' ? -9 : kind === 'freezing' ? -7 : 0);
    return {
      data: {
        temp: t, feels: t - Math.round(w.wind / 2), wind: w.wind, high: t + 3, low: t - 8, code: w.code,
        kind: PCD.weather ? PCD.weather.kind(w.code) : kind, description: PCD.weather ? PCD.weather.describe(w.code) : kind,
        isDay: h >= sun.rise && h < sun.set
      },
      units: 'F', city: CITY, ageMs: 0
    };
  }

  /** PCD.status.describe() views, as the new tab passes them (the fixtures' words). */
  function statusSample(kind, clock24) {
    var t = clock24 ? '07:00' : '7:00 am';
    var s = clock24 ? '08:09' : '8:09 am';
    var table = {
      next: { show: true, kind: 'next', parts: ['pixelclock', 'next alarm tomorrow ' + t, 'work'], time: t, tone: 'muted', ringing: false },
      snoozed: { show: true, kind: 'snoozed', parts: ['pixelclock', 'snoozed until ' + s, 'work'], time: s, tone: 'text', ringing: false },
      ringing: { show: true, kind: 'ringing', parts: ['pixelclock', 'ringing', 'work'], time: null, tone: 'accent', ringing: true },
      testing: { show: true, kind: 'ringing', parts: ['pixelclock', 'ringing', 'test'], time: null, tone: 'accent', ringing: true },
      none: { show: true, kind: 'none', parts: ['pixelclock', 'no alarm set'], time: null, tone: 'muted', ringing: false },
      unknown: { show: true, kind: 'unknown', parts: ['pixelclock', 'time not set'], time: null, tone: 'muted', ringing: false }
    };
    return table[kind] || null;
  }

  // ------------------------------------------------------------------------------------------------ scenes

  /** One static engine frame: the theme at a date and (remapped) hour, the hook in `mode`. */
  function frameFor(id, date, hourFloat, mode) {
    var scene = PCD.engine.createScene({ PC: PC });
    scene.want(id, { fade: false });
    var ctx = PCD.engine.ctx(date, { clock24: false, hourFloat: hourFloat });
    ctx.ms = 0;
    var keep = PCD.hook.mode;
    PCD.hook.mode = mode || 'none';
    for (var i = 0; i < 30; i++) scene.step(ctx);
    var cv = scene.frame(ctx);
    var out = { px: Array.prototype.slice.call(cv.px), clock: PCD.hook.colors ? PCD.hook.colors.clock : null, edge: PCD.hook.edge };
    PCD.hook.mode = keep;
    return out;
  }

  function paintFrame(canvas, px) {
    var g = canvas.getContext('2d', { alpha: false });
    var img = g.createImageData(64, 64);
    for (var i = 0, j = 0; i < 4096; i++, j += 4) {
      var c = px[i];
      img.data[j] = (c >> 16) & 255;
      img.data[j + 1] = (c >> 8) & 255;
      img.data[j + 2] = c & 255;
      img.data[j + 3] = 255;
    }
    g.putImageData(img, 0, 0);
  }

  /** Remember a painted scene for the crisp check (its device rect is read when the report is made). */
  function track(name, canvas, k, px) {
    scenes.push({ name: name, canvas: canvas, k: k, frame: px });
  }

  /** Light, phase, curve and remapped hour of a theme at a moment (real Berlin sun times unless suntimes=0). */
  function sky(id, date, useSun) {
    var sun = useSun ? sunTimes(date) : null;
    var r = PCD.sun.resolve(date, { id: id, sun: sun, follow: !!sun });
    return { sun: sun, hourFloat: r.hourFloat, phase: r.phase, curve: PCD.sun.curve(r.anchor, r.source === 'sun' ? r.sun : null) };
  }

  // ------------------------------------------------------------------------------------------------ one console

  /**
   * Mount a console (PCD.console) in `host` (a screen of cssW x cssH CSS px), give it the view of a moment
   * and paint its scene once (a static frame through the frame hook, as the host would).
   * o { profile ('newtab'|'wallpaper'|'still': the still is the wallpaper's console with the calendar face), side,
   *     theme, at (Date), wx, status, clock24, tag, taskbar, useSun, stale, hook, name, links (count, default 5) }
   */
  function showConsole(host, cssW, cssH, o) {
    var date = o.at;
    var id = o.theme && o.theme !== 'auto' && PC.themeById(o.theme) ? o.theme : PCD.engine.autoId(PC, date.getFullYear(), date.getMonth() + 1, date.getDate());
    var still = o.profile === 'still';
    var NT = o.profile === 'newtab';
    var con = PCD.console.mount(host, { profile: NT ? 'newtab' : 'wallpaper', side: o.side, hook: o.hook !== false, fontBase: 'fonts/' });
    var s = sky(id, date, o.useSun !== false);
    var weather = o.wx && o.wx !== 'off' ? weatherSample(o.wx, date, s.sun || sunTimes(date)) : null;
    if (weather && o.stale) weather.ageMs = o.stale * 60000;
    var status = NT && o.status && o.status !== 'off' ? statusSample(o.status, o.clock24) : null;
    var entry = { name: o.name, con: con, host: host };
    consoles.push(entry);
    var f = frameFor(id, date, s.hourFloat, 'none');
    entry.frame = f.px;
    entry.view = {
      now: date, clock24: !!o.clock24, theme: id, tag: o.tag || (o.theme && o.theme !== 'auto' ? 'pinned' : 'auto'),
      phase: s.phase, themeClock: f.clock, hourFloat: s.hourFloat, sun: o.useSun === false ? null : s.sun, curve: s.curve,
      weather: weather, status: status, links: NT ? SHORTCUTS.slice(0, o.links == null ? 5 : o.links) : [], steady: true,
      reduced: true, face: still ? 'date' : 'time', ringing: !!(status && status.ringing)
    };
    con.update(entry.view);
    con.setViewport({ cssW: cssW, cssH: cssH, dpr: DPR, taskbar: NT ? 0 : o.taskbar });
    con.frame({ px: f.px }, { snap: true });
    if (NT && o.term !== false) sampleTerm(con);
    entry.ready = con.ready.then(function () {
      con.frame({ px: f.px }, { snap: true });
      if (o.sheet) con.sheet(true);
      return con;
    });
    return entry;
  }

  /**
   * A static sample in the new tab's terminal slot, in the classes pcd-console.css gives the terminal (the new tab's
   * own terminal renders the live one): a command, its answer and the prompt with the block caret, at the slot's end.
   */
  function sampleTerm(con) {
    var slot = con.el('term');
    if (!slot) return;
    while (slot.firstChild) slot.removeChild(slot.firstChild);
    function line(runs, cls) {
      var div = doc.createElement('div');
      div.className = 'pcd-term-ln' + (cls ? ' ' + cls : '');
      draw(div, [runs]);
      slot.appendChild(div);
    }
    line([['› ', 'frame'], ['= 6*7', 'text']]);
    line([['= ', 'muted'], ['42', 'text bold']], 'pcd-term-o');
    var prompt = doc.createElement('div');
    prompt.className = 'pcd-term-prompt pcd-focus';
    var pp = doc.createElement('span');
    pp.className = 'pcd-term-pp';
    pp.textContent = '›';
    var caret = doc.createElement('span');
    caret.className = 'pcd-term-caret';
    caret.textContent = '▌';
    caret.style.left = 'calc(var(--cell-w) * 2)';
    prompt.appendChild(pp);
    prompt.appendChild(caret);
    slot.appendChild(prompt);
  }

  /** ?view=console: one full-size console, as the real page would show it at that moment (the knobs of the header;
   *  profile=still shows the wallpaper with the still's calendar face). */
  function fullConsole() {
    var profile = param('profile', 'newtab');
    var at = core.parseLocal(param('at', '2026-11-15T20:40')) || new Date();
    var host = make('div', 'tile-full');
    var o = {
      profile: profile === 'wallpaper' || profile === 'still' ? profile : 'newtab',
      side: param('side', null), theme: param('theme', 'auto'), at: at, wx: param('wx', 'drizzle'),
      status: param('status', 'next'), clock24: param('clock', '12') === '24', tag: param('tag', null),
      sheet: param('sheet', '0') === '1', taskbar: +param('taskbar', 56), useSun: param('suntimes', '1') !== '0',
      stale: +param('stale', 0), links: +param('links', 5), name: 'console'
    };
    var e = showConsole(host, root.innerWidth, root.innerHeight, o);
    // test knobs: ui=0 hides the text (the contrast check's background), veil=0 the veil (the crisp check)
    if (param('ui', '1') === '0') {
      ['column', 'caption', 'settings'].forEach(function (n) {
        var x = e.con.el(n);
        if (x) x.style.visibility = 'hidden';
      });
    }
    if (param('veil', '1') === '0' && e.con.scene.veil) e.con.scene.veil.style.display = 'none';
    if (param('live', '0') !== '1') return e.ready;
    return e.ready.then(function () { return liveConsole(e, o); });
  }

  /**
   * ?view=console&live=1: the console driven by PCD.host, wired the way the pieces wire it (the reference wiring):
   *   host = PCD.host.create({ paint: con.frame, sceneClock: 'none', settings, now })   (the host paints through the
   *          console's frame hook: the scene layer dims and paints every frame; the host makes no canvas of its own)
   *   host 'view'   -> con.update(view + the page's own data: weather, status, links)
   *   host 'colon'  -> con.colon(on), 'ring' -> con.ring(on);  con.onShake -> host.shake()
   */
  function liveConsole(entry, o) {
    var con = entry.con;
    var clock = core.createClock({ at: o.at });
    var extra = { weather: entry.view.weather, status: entry.view.status, links: entry.view.links, face: entry.view.face };
    var counts = { views: 0, colon: 0, colonOff: 0, mutations: 0, frames: 0 };
    var host = PCD.host.create({
      profile: o.profile === 'newtab' ? 'newtab' : 'wallpaper', now: clock.ms, sceneClock: 'none',
      paint: function (fb, info) {
        counts.frames++;
        con.frame(fb, info);
      },
      settings: { theme: o.theme || 'auto', clock24: o.clock24, reducedMotion: 'off', performance: param('perf', '0') === '1' ? 'on' : 'off', sunTimes: true }
    });
    if (o.useSun !== false) host.setSun(sunTimes(o.at));
    if (entry.view.status && entry.view.status.ringing) host.ringing(true);
    host.on('view', function (v) {
      counts.views++;
      con.update(Object.assign({}, v, extra));
    });
    host.on('colon', function (onOff) {
      counts.colon++;
      if (!onOff) counts.colonOff++;
      con.colon(onOff);
    });
    host.on('ring', function (onOff) { con.ring(onOff); });
    con.onShake(function () { host.shake(); });
    var mo = new root.MutationObserver(function (list) { counts.mutations += list.length; });
    host.start();
    root.setTimeout(function () {
      mo.observe(con.el('column'), { childList: true, subtree: true, characterData: true });
    }, 50);
    root.__tile.live = function () {
      return { counts: counts, stats: host.stats(), timers: host.timers(), view: host.view() };
    };
    return true;
  }

  // ------------------------------------------------------------------------------------------------ the board

  var cell = null;
  var COLS = 140;

  function make(tag, cls, parent) {
    var e = doc.createElement(tag);
    if (cls) e.className = cls;
    (parent || tile).appendChild(e);
    return e;
  }

  /** A section of whole cells; text, swatches and canvases go in on the grid. */
  function section(rows) {
    var el = make('div', 'tile-sec');
    el.style.width = COLS * cell.wDev / DPR + 'px';
    el.style.height = rows * cell.hDev / DPR + 'px';
    function at(e, c, r) {
      e.style.left = c * cell.wDev / DPR + 'px';
      e.style.top = r * cell.hDev / DPR + 'px';
    }
    return {
      el: el,
      text: function (c, r, lines) {
        var p = make('pre', 'pcd-g', el);
        at(p, c, r);
        draw(p, lines);
        return p;
      },
      swatch: function (c, r, w, h, color) {
        var d = make('div', 'tile-sw', el);
        at(d, c, r);
        d.style.width = w * cell.wDev / DPR + 'px';
        d.style.height = h * cell.hDev / DPR + 'px';
        d.style.background = color;
        return d;
      },
      /** A canvas of wDev x hDev device px (its backing store is drawn 1:1), dx/dy device px past cell c, r. */
      canvas: function (c, r, wDev, hDev, dx, dy) {
        var cv = make('canvas', 'tile-px', el);
        cv.width = wDev;
        cv.height = hDev;
        cv.style.left = (c * cell.wDev + (dx || 0)) / DPR + 'px';
        cv.style.top = (r * cell.hDev + (dy || 0)) / DPR + 'px';
        cv.style.width = wDev / DPR + 'px';
        cv.style.height = hDev / DPR + 'px';
        return cv;
      },
      /** A 64x64 scene canvas scaled by k whole device px (image-rendering pixelated), dx/dy device px past cell c, r. */
      scene: function (c, r, k, dx, dy) {
        var cv = make('canvas', 'tile-px', el);
        cv.width = 64;
        cv.height = 64;
        cv.style.left = (c * cell.wDev + (dx || 0)) / DPR + 'px';
        cv.style.top = (r * cell.hDev + (dy || 0)) / DPR + 'px';
        cv.style.width = 64 * k / DPR + 'px';
        cv.style.height = 64 * k / DPR + 'px';
        return cv;
      }
    };
  }

  /** A section rule: '── title ──────── note ──' across the board. */
  function rule(title, right) {
    return A.edge('─', '─', COLS, [A.run(title, 'text', { bold: true })], right ? [A.run(right, 'faint')] : null);
  }

  function pad(s, n) {
    s = String(s);
    var len = Array.from(s).length;
    return len >= n ? s : s + new Array(n - len + 1).join(' ');
  }

  function ratio(fg, bg) {
    return C.contrast(fg, bg).toFixed(1);
  }

  /** A clock face (PCD.ascii.clockFace / dayFace) as the console draws it: the wood shadow as text, the pixels as rects. */
  function drawFace(sec, c, r, face, themeClock) {
    sec.text(c, r, face.shadow);
    var cw = cell.wDev, ch = cell.hDev;
    var pw = face.compact ? cw : 2 * cw, ph = face.compact ? Math.max(1, Math.round(ch / 2)) : ch;
    var cv = sec.canvas(c, r, face.W * pw, 5 * ph);
    var g = cv.getContext('2d');
    var clock = A.hex(A.clockColor(themeClock));
    var accent = A.hex(A.token('accent'));
    A.faceRects(face, cw, ch).forEach(function (q) {
      g.fillStyle = q.colon ? accent : clock;
      g.fillRect(q.x, q.y, q.w, q.h);
    });
  }

  /** The sun strip (PCD.ascii.strip / stripRects / stripLine) w cells wide. */
  function drawStrip(sec, c, r, w, curve, nowHour, sun, clock24) {
    var n = w - 14;
    sec.text(c, r, [A.stripLine(n, A.stripLabels(sun, clock24))]);
    var cw = cell.wDev, ch = cell.hDev;
    var cv = sec.canvas(c + 7, r, n * cw, ch);
    var g = cv.getContext('2d');
    A.stripRects(A.strip(curve, n, nowHour), cw, ch).forEach(function (q) {
      g.fillStyle = A.hex(q.color);
      g.fillRect(q.x, q.y, q.w, q.h);
    });
  }

  function board() {
    var tok = C.tokens();
    var names = ['bg', 'panel', 'field', 'line', 'text', 'muted', 'faint', 'accent', 'frame', 'ring', 'wood', 'wood-dark'];
    var today = core.parseLocal('2026-11-15T20:40');
    var fontName = ((PCD.font && PCD.font.state() && PCD.font.state().family) || '?').toLowerCase();

    // header
    var s = section(4);
    s.text(0, 0, [
      [['pixelclock desktop', 'text bold'], [' · ', 'frame'], ['style tile', 'muted']],
      [['the visual gate: every token, glyph, ascii element and theme, drawn by the shared modules', 'faint']]
    ]);
    var stamp = 'tokens v' + ((PCD.TOKENS && PCD.TOKENS.version) || 1) + ' · font ' + fontName;
    s.text(COLS - stamp.length, 0, [[[stamp, 'faint']]]);

    // palette
    s = section(names.length + 4);
    s.text(0, 0, [rule('palette', 'design/tokens.json')]);
    s.text(0, 1, [[[pad('', 6) + pad('token', 11) + pad('value', 9) + pad('on bg', 7) + pad('panel', 7) + pad('field', 7) + 'role', 'muted']]]);
    var roleText = {
      bg: 'page, what the dimmed scene mixes toward, the veil', panel: 'settings sheet fill', field: 'input wells',
      line: 'strip baseline (night bars)', text: 'main text, titles, values', muted: 'secondary text, tags, the phase',
      faint: 'credits, hints, strip times, the terminal ghost', accent: 'only what is alive', frame: 'box lines, glyphs ⌂ ≡ ·, the echo ›',
      ring: 'ringing status, sun and bolt, the ! marks', wood: 'clock shadow ░, the terminal rule, day bars', 'wood-dark': 'not on screen'
    };
    names.forEach(function (n, i) {
      var v = tok[n];
      s.swatch(0, 2 + i, 4, 1, C.hex(v));
      var deco = n === 'bg' || n === 'panel' || n === 'field' || n === 'wood-dark';
      var line = [[pad('', 6), ''], [pad(n, 11), 'text'], [pad(C.hex(v), 9), 'muted']];
      ['bg', 'panel', 'field'].forEach(function (b) { line.push([pad(deco ? '-' : ratio(v, tok[b]), 7), 'muted']); });
      line.push([roleText[n] || '', 'faint']);
      s.text(0, 2 + i, [line]);
    });

    // the contrast gate
    var pairs = PCD.TOKENS && PCD.TOKENS.contrast ? PCD.TOKENS.contrast : [];
    s = section(Math.ceil(pairs.length / 3) + 3);
    s.text(0, 0, [rule('contrast gate', 'wcag 2.2, text >= 4.5, lines >= 3')]);
    pairs.forEach(function (p, i) {
      var r = C.contrast(tok[p.fg], tok[p.on]);
      var ok = r + 1e-9 >= p.min;
      s.text((i % 3) * 46, 1 + Math.floor(i / 3), [[[pad(p.fg + ' on ' + p.on, 18), 'muted'], [pad(r.toFixed(2), 6), 'text'], [pad('min ' + p.min, 8), 'faint'], [ok ? 'pass' : 'FAIL', ok ? 'muted' : 'text bold']]]);
    });

    // type
    s = section(13);
    s.text(0, 0, [rule('type', 'one size per screen')]);
    var cases = [['new tab', 1280, 800, 2], ['new tab', 1280, 620, 2], ['wallpaper', 1920, 1080, 1], ['wallpaper', 2560, 1440, 1], ['wallpaper', 3840, 2160, 1], ['wallpaper', 1280, 800, 2]];
    s.text(0, 1, [[['termmono', 'text bold'], [' (cascadia mono, ofl)', 'muted'], [' · ', 'frame'], ['fallback consolas', 'muted'], [' · ', 'frame'], ['in use: ' + fontName, 'muted']]]);
    s.text(0, 2, [[['400 the clock keeps time by the light of the scene', 'text']], [['600 the clock keeps time by the light of the scene', 'text bold']]]);
    s.text(0, 4, [[['text', 'text'], ['  ', ''], ['muted', 'muted'], ['  ', ''], ['faint', 'faint'], ['  ', ''], ['accent', 'accent'], ['  ', ''], ['frame', 'frame'], ['  ', ''], ['ring', 'ring'], ['  ', ''], ['wood', 'wood']]]);
    cases.forEach(function (c, i) {
      var prof = c[0] === 'new tab' ? 'newtab' : 'wallpaper';
      var step = PCD.layout.fontStep(c[2], c[3], prof);
      var tc = PCD.layout.termCell(step, c[3]);
      s.text(0, 6 + i, [[[pad(c[0] + ' ' + c[1] + 'x' + c[2] + '@' + c[3], 26), 'muted'], [pad(step + ' device px', 14), 'text'], [pad('= ' + (step / c[3]) + ' css px', 16), 'muted'], ['cell ' + tc.w + ' x ' + tc.h, 'faint']]]);
    });

    // glyphs and the glyph gate
    var used = A.CHARS; // every glyph the kit draws ('╭╮╰╯─│├┤░▌›»·⌂☼≡↓•°')
    var ascii = '';
    for (var cp = 0x20; cp <= 0x7e; cp++) ascii += String.fromCharCode(cp);
    gate = PCD.font.glyphGate(used + ascii);
    s = section(8);
    s.text(0, 0, [rule('glyphs', 'the safe set; bars and clock pixels are rects')]);
    var glyphRuns = [];
    Array.from(used).forEach(function (ch, i) {
      if (i) glyphRuns.push(['   ', '']);
      glyphRuns.push([ch, 'text']);
    });
    s.text(0, 1, [glyphRuns]);
    s.text(0, 2, [[['box ', 'faint'], ['╭─╮ │ ╰─╯ ├ ┤', 'frame'], ['   shadow ', 'faint'], ['░░', 'wood'], ['   caret ', 'faint'], ['▌', 'accent'], ['   accents ', 'faint'], ['› » · ⌂ ☼ ≡ ↓ • °', 'frame']]]);
    s.text(0, 3, [[[ascii, 'muted']]]);
    gate.forEach(function (g, i) {
      var line = [[pad('glyph gate ' + g.family.toLowerCase(), 24), 'muted'], [pad(g.tested + ' glyphs at ' + g.sizePx + ' px', 20), 'faint'], [g.pass ? 'pass' : 'FAIL', g.pass ? 'muted' : 'text bold']];
      if (!g.pass) line.push(['  ' + g.fails.map(function (f) { return f.cp; }).join(' '), 'text']);
      s.text(0, 5 + i, [line]);
    });

    // ascii elements (PCD.ascii and PCD.console build them, drawn with the console's role classes)
    var Kc = PCD.console;
    s = section(40);
    s.text(0, 0, [rule('ascii elements', 'built by PCD.ascii and PCD.console')]);
    var f12 = A.clockFace(20, 40, { clock24: false });
    drawFace(s, 0, 2, f12, 0xffe2b0);
    s.text(f12.ampmAt.c, 2 + f12.ampmAt.r, [[[f12.ampm, 'muted']]]);
    drawFace(s, 40, 2, A.clockFace(20, 40, { clock24: true }), 0xff8c1a);
    var f15 = A.dayFace(15);
    drawFace(s, 82, 2, f15, 0xffe9c4);
    s.text(82 + f15.labelsAt.c, 2 + f15.labelsAt.monthRow, [[['november', 'text bold']], [], [], [['sunday', 'muted']]]);
    var fc = A.clockFace(9, 5, { clock24: false, compact: true });
    drawFace(s, 120, 2, fc, 0xffffff);
    s.text(120, 6, [[['compact', 'faint']]]);
    var greetLines = [7, 13, 19, 23].map(function (h) {
      return PCD.greet.parts(new Date(2026, 10, 15, h, 0), PC).runs.concat([[pad('', 2), ''], [String(h) + ' h', 'faint']]);
    });
    greetLines.push(PCD.greet.parts(new Date(2026, 9, 31, 21, 10), PC).runs);
    greetLines.push(PCD.greet.parts(new Date(2026, 11, 25, 7, 30), PC).runs);
    s.text(0, 9, greetLines);
    s.text(44, 9, [[[core.formatDate(today), 'muted']]].concat(['next', 'snoozed', 'ringing', 'none', 'unknown'].map(function (k) {
      return A.statusLine(statusSample(k, false));
    })));
    // the links, the terminal's rule and prompt, the bottom row (hint, caption, settings)
    var li = Kc.parts.linkItems(Kc.parts.linksOf(SHORTCUTS), 44);
    li.items.forEach(function (it) { s.text(it.x, 16 + it.row, it.block); });
    s.text(46, 16, [[['links ', 'muted'], ['[n] label', 'faint'], [', the number in accent: its number + enter opens it', 'faint']]]);
    s.text(0, 19, [Kc.parts.ruleLine(44)]);
    s.text(0, 20, [[['› ', 'frame'], ['theme winter', 'text']], [['  theme ', 'muted'], ['snowy hills', 'text'], [' · ', 'frame'], ['pinned', 'muted']], [['›', 'accent'], [' g cozy', 'text'], ['▌', 'accent']]]);
    s.text(46, 19, [[['the terminal', 'muted'], [' (the new tab\'s slot): its rule, output and prompt', 'faint']]]);
    var Vb = Kc.view({ now: today, name: 'autumn forest', tag: 'pinned', phase: 'night', links: SHORTCUTS }, 'newtab');
    s.text(0, 24, [Kc.parts.hintLine(Vb, 60)]);
    var capRuns = Kc.parts.captionLine(Vb);
    s.text(70, 24, [capRuns.concat([A.run('   ')], Kc.parts.settingsLine())]);
    // the weather icons, all of them, and the console's block (fresh, and 2 h old)
    Object.keys(A.ICONS).forEach(function (n, i) {
      var c = (i % 6) * 15, r = 26 + Math.floor(i / 6) * 6;
      s.text(c, r, A.icon(n).concat([[[n, 'faint']]]));
    });
    var wx = weatherSample('drizzle', today, sunTimes(today));
    var Vw = Kc.view({ now: today, weather: wx, sun: sunTimes(today) }, 'newtab');
    s.text(92, 26, Kc.parts.weatherBlock(Vw, { width: 44 }));
    wx = weatherSample('drizzle', today, sunTimes(today));
    wx.ageMs = 2 * 3600000;
    s.text(92, 31, Kc.parts.weatherBlock(Kc.view({ now: today, weather: wx, sun: sunTimes(today) }, 'newtab'), { width: 44 }));
    // the strip by day and by night, and without real sun times
    var au = sky('autumn', today, true);
    drawStrip(s, 0, 37, 61, au.curve, 12.5, au.sun, false);
    drawStrip(s, 64, 37, 61, au.curve, 20.67, au.sun, true);
    drawStrip(s, 0, 38, 61, au.curve, 20.67, au.sun, false);
    drawStrip(s, 64, 38, 61, au.curve, 7.2, null, false);
    s.text(0, 39, [[['the strip at 12:30 and 20:40 (12 h); at 20:40 (24 h); without real sun times (no labels)', 'faint']]]);

    // every theme at dawn, day, sunset and night
    var menu = PCD.engine.menu(PC).filter(function (t) { return t.id !== 'auto'; });
    var k = Math.max(2, 2 * Math.round(DPR));
    var sizeCss = 64 * k / DPR;
    var thumbCols = Math.ceil((sizeCss * 4 + 3 * cell.w) / cell.w) + 3;
    var groups = Math.ceil(menu.length / 2);
    var thumbRows = Math.ceil(sizeCss / cell.h) + 2;
    s = section(2 + groups * thumbRows);
    s.text(0, 0, [rule('themes', 'every theme at dawn, day, sunset and night (scale ' + k + ')')]);
    var phases = ['dawn', 'day', 'sunset', 'night'];
    menu.forEach(function (t, i) {
      var col = (i % 2) * (thumbCols + 2), row = 2 + Math.floor(i / 2) * thumbRows;
      s.text(col, row - 1, [[[String(t.name).toLowerCase(), 'text bold'], ['  ' + t.id, 'faint']]]);
      phases.forEach(function (ph, j) {
        var anchor = PCD.sun.anchor(t.id);
        var hf = PCD.sun.phaseHour(ph, anchor);
        var date = new Date(2026, 10, 15, Math.floor(hf), Math.round((hf % 1) * 60));
        var f = frameFor(t.id, date, hf, 'none');
        var x0 = col * cell.wDev + j * (64 * k + cell.wDev);
        var cv = s.scene(0, row, k, x0, 0);
        paintFrame(cv, f.px);
        track(t.id + '-' + ph, cv, k, f.px);
      });
    });

    // the console in 4 themes, day and night, on both sides: mini screens of 1240 x 776 device px (no taskbar)
    var sw = 1240 / DPR, shh = 776 / DPR;
    var gapPx = 20;
    var conSec = make('div', 'tile-sec');
    conSec.style.width = 2 * sw + gapPx + 'px';
    var titleSec = section(2);
    titleSec.text(0, 0, [rule('the console', '4 themes x day and night: the new tab (column left), the wallpaper (column right)')]);
    tile.insertBefore(titleSec.el, conSec);
    conSec.style.height = SCENARIOS.length * 2 * (shh + gapPx) + 'px';
    var all = [];
    SCENARIOS.forEach(function (sc, i) {
      ['newtab', 'wallpaper'].forEach(function (profile, p) {
        ['day', 'night'].forEach(function (when, j) {
          var screen = make('div', 'tile-screen', conSec);
          screen.style.left = j * (sw + gapPx) + 'px';
          screen.style.top = (i * 2 + p) * (shh + gapPx) + 'px';
          screen.style.width = sw + 'px';
          screen.style.height = shh + 'px';
          var host = make('div', '', screen);
          var at = core.parseLocal(sc[when][0]);
          var e = showConsole(host, sw, shh, { profile: profile, at: at, wx: sc[when][1], status: STATUS[sc.name], taskbar: 0, hook: false, name: sc.name + '-' + profile + '-' + when });
          all.push(e.ready);
        });
      });
    });
    return Promise.all(all);
  }

  // ------------------------------------------------------------------------------------------------ report (tests)

  function rectOf(el) {
    var r = el.getBoundingClientRect();
    return { x: r.left + root.scrollX, y: r.top + root.scrollY, w: r.width, h: r.height };
  }

  function report() {
    var anims = doc.getAnimations ? doc.getAnimations().filter(function (a) {
      var t = a.effect && a.effect.getTiming ? a.effect.getTiming() : null;
      return t && t.iterations === Infinity;
    }).length : 0;
    var bad = [];
    var all = doc.querySelectorAll('*');
    for (var i = 0; i < all.length; i++) {
      var cs = root.getComputedStyle(all[i]);
      // the scene layer's veil is the one allowed gradient: static, under the text, never animated
      var veil = all[i].classList && all[i].classList.contains('pcd-bleed-veil');
      if ((cs.filter && cs.filter !== 'none') || (cs.backdropFilter && cs.backdropFilter !== 'none') || (cs.boxShadow && cs.boxShadow !== 'none') ||
        (cs.textShadow && cs.textShadow !== 'none') || (!veil && cs.backgroundImage && cs.backgroundImage !== 'none')) bad.push(all[i].tagName.toLowerCase() + '.' + all[i].className);
    }
    var sceneList = scenes.map(function (s) {
      var r = rectOf(s.canvas);
      return { name: s.name, x: Math.round(r.x * DPR), y: Math.round(r.y * DPR), size: Math.round(r.w * DPR), k: s.k, frame: s.frame };
    });
    var consoleList = consoles.map(function (d) {
      var con = d.con;
      var rep = con.report();
      var info = con.info();
      var origin = rectOf(con.el('root'));
      var texts = [];
      var nodes = d.host.querySelectorAll('.pcd-g, .pcd-px, .pcd-colon, .pcd-term');
      for (var j = 0; j < nodes.length; j++) {
        var n = nodes[j];
        if (n.hidden || n.closest('[hidden]') || root.getComputedStyle(n).visibility === 'hidden') continue;
        if (!n.textContent && n.tagName !== 'CANVAS' && !n.classList.contains('pcd-colon') && !n.classList.contains('pcd-term')) continue;
        var nr = rectOf(n);
        texts.push({ cls: n.className, text: (n.textContent || '').slice(0, 40), x: nr.x * DPR, y: nr.y * DPR, w: nr.w * DPR, h: nr.h * DPR });
      }
      return {
        name: d.name, profile: info.profile, side: info.side, ready: info.ready, fontFamily: info.font, fontPx: info.fontPx,
        cell: info.cell, plan: info.plan, dropped: info.dropped, rows: rep.layout && rep.layout.rows, grid: rep.layout && rep.layout.grid,
        col: rep.layout && rep.layout.col, edge: rep.layout && rep.layout.edge, taskbar: rep.layout ? rep.layout.taskbar.dev : 0, scene: rep.scene, frame: rep.frame,
        bandRows: rep.rows, fade: rep.fade, fadeCols: rep.cols, layer: rep.layer ? { mix: rep.layer.mix, cost: rep.layer.cost, nudges: rep.layer.nudges } : null,
        origin: { x: Math.round(origin.x * DPR), y: Math.round(origin.y * DPR) }, regions: rep.regions, texts: texts,
        content: summary(con.content())
      };
    });
    return {
      dpr: DPR, w: root.innerWidth, h: root.innerHeight, docH: doc.documentElement.scrollHeight, errors: errors, notes: notes,
      gate: gate, scenes: sceneList, consoles: consoleList, infiniteAnimations: anims, effects: bad,
      font: PCD.font && PCD.font.state ? PCD.font.state() : null, view: param('view', 'board')
    };
  }

  /** A console's content as plain text per part (tests: the drop order, the copy). */
  function summary(ct) {
    if (!ct) return null;
    var out = {};
    Object.keys(ct).forEach(function (k) {
      var p = ct[k];
      if (!p) return;
      if (Array.isArray(p)) out[k] = p.map(function (x) { return A.plain(x.block)[0]; });
      else if (p.block) out[k] = A.plain(p.block);
      else if (k === 'clock') out[k] = p.text;
      else if (k === 'term') out[k] = p.cols + 'x' + p.rows;
    });
    return out;
  }

  // ------------------------------------------------------------------------------------------------ start

  var ready = (PCD.font && PCD.font.load ? PCD.font.load('fonts/') : Promise.resolve(null)).then(function () {
    var dpr = DPR;
    cell = PCD.font.measureCell({ host: tile, sizePx: 16, dpr: dpr });
    PCD.font.apply(tile, cell, 16);
    if (param('view', 'board') === 'console') return fullConsole();
    COLS = Math.min(140, Math.floor(root.innerWidth * dpr / cell.wDev) - 2);
    tile.style.marginLeft = cell.wDev / dpr + 'px';
    return board();
  }).then(function () {
    doc.documentElement.setAttribute('data-ready', '1');
    return true;
  }, function (e) {
    errors.push(String(e && e.stack ? e.stack : e));
    doc.documentElement.setAttribute('data-ready', 'error');
    return false;
  });

  root.__tile = { ready: ready, report: report };
})(typeof window !== 'undefined' ? window : this);
