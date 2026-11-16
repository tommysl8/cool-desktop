/* PixelClock Desktop shared: the console column. Classic script, UMD, global PCD (PCD.console). The new tab, the
 * wallpaper and the still all lay out and draw their column with it.
 *
 * The live scene fills the screen (the scene layer: PCD.bleed.mountScene in src/shared/pcd-bleed.js; the console
 * mounts and lays it out), dimmed, and one console column of monospace text sits on it: the clock's 3x5 digits with
 * their wood shadow and amber colon, the greeting, the date, the clock status, the daylight strip, the ASCII weather
 * with its credit, the numbered links, the terminal (new tab), and a bottom row. One file, two halves:
 *
 * PURE (Node and pages; the still uses these with its glyph atlas, so it matches the live wallpaper cell for cell)
 *   PCD.console.compute(input) -> layout L
 *     input { cssW, cssH, dpr, profile 'newtab'|'wallpaper'|'still', side 'left'|'right' (where the column sits;
 *       default: new tab left, wallpaper and still right), measure(step) -> { w, h } (CSS px; the cell at a ladder step:
 *       the page measures the loaded font, the still passes its atlas metrics) or cell { w, h } (at the screen's step),
 *       default PCD.layout.termCell; fontStep (device px; default the profile's ladder step: new tab div 44 from 14 px,
 *       wallpaper and still div 48 from 16 px, of the height or, in a squarish or portrait window, of 0.8 x the width
 *       (new tab) or 0.9 x the width (wallpaper and still) when that is less); taskbar (CSS px kept clear at the
 *       bottom; wallpaper and still only, default 56, 0 = off); parts (what has content: partsOf(view, profile)) }
 *     L { profile, side, dpr, cssW, cssH, Wd, Hd (device px), font { step, px }, cell { w, h, wDev, hDev, ls },
 *       grid { cols, rows, usable (rows above the taskbar), xDev, x }, mx (margin cells), col { c, r, cols, rows, x, y,
 *       w, h } (the column), edge { side, xDev, x } (the column's inner edge: the scene layer sizes k from it),
 *       plan { my, bottom, gaps, clock 'full'|'compact'|'none', head [greet, date, status], strip, weather
 *       'full'|'compact'|'none', links, rule, term, termMin, foot } (what shows after the drop order),
 *       rows { clock, greet, date, status, strip, weather, links, rule, term { r, rows }, foot } (absent = dropped),
 *       links { n, per, rows, cols, widths, x, itemW } (parts.linkItems without the items), taskbar { dev, rows },
 *       parts }
 *   PCD.console.content(view, L) -> what each part shows, with its cell: { clock { c, r, face, shadow, rects (device
 *     px from the clock's top-left cell; colon rects carry colon: true), side { c, r, block } }, greet, date, status,
 *     weather, rule, hint, caption { c, r, block, cols }, settings { c, r, block, cols } (each { c, r, block }), strip
 *     { c, r, block, bars { c, r, n, rects } }, links [{ n, c, r, cols, label, url, block }], term { c, r, cols, rows } }
 *     (null when a part is absent). Blocks are PCD.ascii runs: lines of { text, tone, bold, href }.
 *   PCD.console.view(raw, profile) the view with every member filled (below); partsOf(view, profile) -> parts
 *   PCD.console.regions(L, content?) -> CSS px rects { x, y, w, h, c, r, cols, rows } of every part
 *   PCD.console.parts       pure helpers: weatherLines, weatherBlock, linkItems, linksOf, weatherOf, hintLine,
 *                           captionLine, settingsLine, ruleLine, plan, fontStep(cssH, dpr, profile, cssW?), cellAt
 *                           (statusLine, greetLine and wordsThatFit live in PCD.ascii)
 *   PCD.console.DROPS       the drop order (names), PCD.console.SIDES, PCD.console.PROFILES
 *
 * DOM (pages)
 *   PCD.console.mount(root, opts) -> con
 *     root  the element the console takes over (children replaced; positioned absolute at its parent's origin, sized
 *           to the viewport it is given)
 *     opts  { profile 'newtab'|'wallpaper', side, fontBase ('fonts/', for PCD.font.load), hook (default true: the
 *             console keeps PCD.hook.mode = 'none'; the column shows the clock), document }
 *   con
 *     setViewport({ cssW, cssH, dpr, taskbar, side }) -> L   lays everything out on whole device px (the scene layer
 *                       too); call it on load, on resize and on every devicePixelRatio change
 *     update(view)      draws what changed (a part showing or going lays out again)
 *     frame(fb, info)   the frame hook: the engine's 64x64 frame (a PC.Canvas, or a Uint32Array(4096) of 0xRRGGBB)
 *                       once per displayed frame, info { first, fading, snap }; the scene layer dims it (auto exposure,
 *                       about 60 % of the light at night to 50 % on bright days, eased), paints the scene canvas, the
 *                       band and the seam. With PCD.host: PCD.host.create({ paint: con.frame, sceneClock: 'none', ... })
 *     colon(on)         the clock's two amber colon pixels (two tiny elements; nothing is redrawn); on while steady
 *     ring(on)          one step of the 2 Hz ringing pulse (the status line's glyph and words between accent and
 *                       ring); ringing(on)
 *     sheet(open)       new tab: the settings sheet covers the column (regions().sheet); the column hides
 *     el(name)          'root' 'column' 'canvas' (the scene) 'term' (the terminal slot) 'links' (nav) 'link1'..'link9'
 *                       'settings' (the ≡ settings button) 'credit' (the open-meteo.com link) 'status' 'hint' 'caption'
 *                       'greet' 'date' 'weather' 'world' (the scene layer's element)
 *     term()            the terminal slot: { el, c, r, cols, rows, x, y, w, h, cell { w, h, wDev, hDev, ls }, fontPx,
 *                       dpr } (null when the terminal is dropped or not the new tab)
 *     layout()  content()  regions()  metrics() { k, dpr, x, y, size }  info()  report() (tests: geometry, frame)
 *     onLayout(fn)      fn(L) after every layout (font arrival, a part showing or going, a resize); returns off()
 *     onShake(fn)       fn(event) on a main-button pointerdown on the scene canvas; returns off()
 *     hit(target)       true for the scene canvas (the layer's isScene)
 *     ready             Promise: the font is in (or timed out: Consolas) and the text shows
 *     scene             the scene layer   canvas   the scene canvas   destroy()
 *
 * The view (every member optional; PCD.host.view() fits as it is, plus the page's own members)
 *   now (Date | ms), clock24, theme (id), name (the scene's name, shown lower case), tag ('auto'|'pinned'|'surprise'),
 *   phase ('dawn'|'day'|'sunset'|'night'), face ('date' = the still's calendar page), clockColor (as shown) or
 *   themeClock (the theme's own; softened here), sun ({ rise, set } real sun times in use, else null: strip labels),
 *   curve (48 light levels), weather ({ data, units, city, ageMs } or a PCD.weather client state; null = no block),
 *   status (new tab: a PCD.status.describe() view; null = no line), reserve (new tab: { status: true } keeps the
 *   status row in the layout, blank, until the status has a line, so nothing moves when it comes), links (new tab:
 *   [{ label, url }], 9 at most, labels of 24 code points at most), hint (new tab: runs or a string replacing
 *   '1-3 + enter opens a link · help lists commands', whose range is the links': '1-n', or '1' with one link),
 *   settings (new tab: false hides '≡ settings'), steady (the colon does not blink), reduced, ringing.
 *
 * Cost: no timers, no animation frames and no listeners on the window; the host drives everything. update() draws a
 * part again only when its text changed (a minute's changes; nothing per frame). frame() is the scene layer's draw
 * (PCD.bleed: the 64x64 scene, one 1x64 band, a seam of up to 5x64; scene.layer.info().cost has its numbers).
 */
(function (root, factory) {
  var api = factory(root.PCD || (root.PCD = {}), root);
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (PCD, root) {
  'use strict';

  var SEP = ' · ';
  var PROFILES = ['newtab', 'wallpaper', 'still'];
  var SIDES = ['left', 'right'];
  var MAX_LINKS = 9;
  var LABEL_MAX = 24;             // code points, as the settings count them
  var LINK_GAP = 3;               // cells between two links on a row
  var LINK_COL_MIN = 10;          // on several rows a column is at least '[1] ' and 6 cells, so short labels line up
  var ICON_W = 11;
  var TEXT_AT = 13;               // the weather's text starts after the icon and two spaces
  var CLOCK_FULL_W = 39;          // 36 cells of digits and shadow ('12:00'), then ' pm'
  var CLOCK_COMPACT_W = 22;
  var DATE_FACE_W = 27;           // the calendar page: '15' and 'september'
  var STRIP_MIN_W = 26;
  var WEATHER_MIN_W = 12;
  var HINT_EXTRA = 24;            // the hint may run this far past the column, never into the caption
  var CAPTION_GAP = 4;
  var SETTINGS_GAP = 3;
  var CREDIT = 'weather: ';
  var CREDIT_DOMAIN = 'open-meteo.com';
  var CREDIT_URL = 'https://open-meteo.com/';
  var DROPS = ['term-4', 'strip', 'rule', 'term-3', 'weather-compact', 'status', 'clock-compact', 'gaps', 'margin-1',
    'weather', 'date', 'term-2', 'clock', 'foot', 'head', 'links', 'margins', 'term-1'];

  function num(v, d) {
    return typeof v === 'number' && isFinite(v) ? v : d;
  }

  function clamp(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
  }

  function kit() {
    if (!PCD.ascii || typeof PCD.ascii.run !== 'function') throw new Error('PCD.console needs js/pcd-ascii.js (load it first)');
    return PCD.ascii;
  }

  function run(text, tone, bold, href) {
    return kit().run(text, tone, { bold: !!bold, href: href || null });
  }

  function width(line) {
    var n = 0;
    for (var i = 0; i < (line || []).length; i++) n += line[i].text.length;
    return n;
  }

  function rep(ch, n) {
    var s = '';
    for (var i = 0; i < n; i++) s += ch;
    return s;
  }

  /** Length and cut in whole code points (an emoji is one, never half of a surrogate pair). */
  function cpLen(s) {
    return Array.from(String(s)).length;
  }

  function cpCut(s, n) {
    return Array.from(String(s)).slice(0, Math.max(0, n)).join('');
  }

  /** A line cut to at most w cells (no padding). */
  function cut(line, w) {
    var out = [];
    var n = 0;
    for (var i = 0; i < (line || []).length && n < w; i++) {
      var r = line[i];
      var t = r.text;
      if (n + t.length > w) t = t.slice(0, w - n);
      if (t.length) out.push(t === r.text ? r : run(t, r.tone, r.bold, r.href));
      n += t.length;
    }
    return out;
  }

  function profileOf(p) {
    return p === 'wallpaper' || p === 'still' ? p : 'newtab';
  }

  function sideOf(s, profile) {
    if (s === 'left' || s === 'right') return s;
    return profile === 'newtab' ? 'left' : 'right';
  }

  // ------------------------------------------------------------------------------------------------ type and cell

  var LADDER = { newtab: [14, 16, 20, 24, 28, 32, 36, 40, 48, 56, 64], wallpaper: [16, 20, 24, 28, 32, 36, 40, 48, 56, 64] };
  var DIV = { newtab: 44, wallpaper: 48 };

  /** How much of the width counts as height for the type: a squarish or portrait screen sizes its type from the width
   *  too, so the column keeps to about half of it and the scene shows beside it (landscape screens: the height). */
  var TALL = { newtab: 0.8, wallpaper: 0.9, still: 0.9 };

  /** The ladder step (device px) for the screen: PCD.font.step (new tab: div 44 from 14 px, never under 12 CSS px;
   *  wallpaper and still: div 48 from 16 px, the atlas sizes) of the height, or of cssW x TALL when that is less. */
  function fontStep(cssH, dpr, profile, cssW) {
    var p = profileOf(profile);
    var h = num(cssW, 0) > 0 ? Math.min(cssH, cssW * TALL[p]) : cssH;
    if (PCD.font && typeof PCD.font.step === 'function') return PCD.font.step(h, dpr, p);
    if (PCD.layout && typeof PCD.layout.fontStep === 'function') return PCD.layout.fontStep(h, dpr, p);
    var key = p === 'newtab' ? 'newtab' : 'wallpaper';
    var d = dpr > 0 ? dpr : 1;
    var min = p === 'newtab' ? Math.max(14, Math.ceil(12 * d - 1e-9)) : 16;
    var t = h * d / DIV[key];
    var best = 0;
    LADDER[key].forEach(function (s) {
      if (s >= min && (!best || Math.abs(s - t) < Math.abs(best - t) - 1e-9)) best = s;
    });
    return best || 64;
  }

  /** TermMono's cell at a step without a DOM (Chrome's exact layout; PCD.layout.termCell). */
  function termCell(step, dpr) {
    if (PCD.layout && typeof PCD.layout.termCell === 'function') return PCD.layout.termCell(step, dpr);
    var d = dpr > 0 ? dpr : 1;
    var adv = step * 1200 / 2048;
    var wDev = Math.max(1, Math.floor(adv + 1e-6));
    var hDev = Math.max(1, Math.round(step * 1900 / 2048) + Math.round(step * 480 / 2048));
    return { w: wDev / d, h: hDev / d, wDev: wDev, hDev: hDev, ls: (wDev - adv) / d };
  }

  /** The cell at a step in whole device px: measure(step), else cell (CSS px), else termCell. */
  function cellAt(o, step, dpr) {
    var c = null;
    if (typeof o.measure === 'function') {
      try {
        c = o.measure(step);
      } catch (e) {
        c = null;
      }
    }
    if (!c && o.cell && o.cell.w > 0 && o.cell.h > 0) c = o.cell;
    if (!c || !(c.w > 0) || !(c.h > 0)) c = termCell(step, dpr);
    var wDev = c.wDev > 0 ? c.wDev : Math.max(1, Math.round(c.w * dpr));
    var hDev = c.hDev > 0 ? c.hDev : Math.max(1, Math.round(c.h * dpr));
    return { w: wDev / dpr, h: hDev / dpr, wDev: wDev, hDev: hDev, ls: num(c.ls, 0) };
  }

  // ------------------------------------------------------------------------------------------------ the view

  function colorInt(c) {
    if (typeof c === 'number' && isFinite(c)) return (c >>> 0) & 0xffffff;
    var m = /^#?([0-9a-f]{6})$/i.exec(String(c == null ? '' : c).trim());
    return m ? parseInt(m[1], 16) : null;
  }

  function hexOf(c) {
    var s = ((c >>> 0) & 0xffffff).toString(16);
    while (s.length < 6) s = '0' + s;
    return '#' + s;
  }

  function lower(s) {
    return String(s == null ? '' : s).replace(/\s+/g, ' ').trim().toLowerCase();
  }

  /** The weather of a view as { data, units, city, ageMs } or null (a PCD.weather client state works as it is). */
  function weatherOf(w, nowMs) {
    if (!w || typeof w !== 'object') return null;
    var data = w.data && typeof w.data === 'object' ? w.data : (typeof w.temp === 'number' ? w : null);
    if (!data || num(data.temp, null) === null) return null;
    var place = w.place && typeof w.place === 'object' ? w.place : null;
    var city = place && place.name ? place.name : (typeof w.city === 'string' ? w.city.split(',')[0] : '');
    var age = num(w.ageMs, null) !== null ? w.ageMs : (num(w.fetchedAt, null) !== null ? nowMs - w.fetchedAt : 0);
    return { data: data, units: String(w.units || 'F').toUpperCase() === 'C' ? 'C' : 'F', city: lower(city), ageMs: age };
  }

  /** The links: [{ label, url }] with an http(s) url and a label, lower case, 24 code points and 9 links at most. */
  function linksOf(list) {
    var out = [];
    (Array.isArray(list) ? list : []).forEach(function (l) {
      if (!l || out.length >= MAX_LINKS) return;
      var label = cpCut(lower(l.label != null ? l.label : l.name), LABEL_MAX).trim();
      var url = typeof l.url === 'string' ? l.url.trim() : '';
      if (label && /^https?:\/\//i.test(url)) out.push({ label: label, url: url });
    });
    return out;
  }

  /** A Date from any realm (instanceof fails across frames and vm contexts). */
  function isDate(d) {
    return Object.prototype.toString.call(d) === '[object Date]' && isFinite(d.getTime());
  }

  /** The view with every member filled (see the header). */
  function view(raw, profile) {
    var v = raw || {};
    var p = profileOf(profile);
    var t = isDate(v.now) ? v.now : isDate(v.date) ? v.date : null;
    var now = t || new Date(num(v.now, Date.now()));
    var PC = root.PixelClock;
    var id = v.theme || v.id || v.themeId || null;
    var theme = id && PC && typeof PC.themeById === 'function' ? PC.themeById(id) : null;
    var name = v.name || v.themeName || (theme ? theme.name : '');
    var sun = v.sun && num(v.sun.rise, null) !== null && num(v.sun.set, null) !== null ? { rise: v.sun.rise, set: v.sun.set } : null;
    return {
      now: now,
      wallHour: now.getHours() + now.getMinutes() / 60 + now.getSeconds() / 3600,
      clock24: !!v.clock24,
      theme: id,
      name: lower(name),
      tag: v.tag ? lower(v.tag) : '',
      phase: v.phase ? lower(v.phase) : '',
      face: p === 'still' || v.face === 'date' ? 'date' : 'time',
      clockColor: colorInt(v.clockColor),
      themeClock: colorInt(v.themeClock),
      sun: sun,
      curve: Array.isArray(v.curve) && v.curve.length === 48 ? v.curve : null,
      weather: weatherOf(v.weather, now.getTime()),
      status: p === 'newtab' && v.status && v.status.show ? v.status : null,
      reserve: { status: p === 'newtab' && !!(v.reserve && v.reserve.status) },
      links: p === 'newtab' ? linksOf(v.links || v.shortcuts) : [],
      hint: p === 'newtab' && v.hint != null ? v.hint : null,
      settings: p === 'newtab' && v.settings !== false,
      steady: !!v.steady,
      reduced: !!v.reduced,
      ringing: typeof v.ringing === 'boolean' ? v.ringing : null
    };
  }

  // ------------------------------------------------------------------------------------------------ the parts' text

  function deg(v) {
    var n = Math.round(Number(v));
    return isFinite(n) ? String(n === 0 ? 0 : n) : '-';
  }

  function agoText(ms) {
    if (PCD.core && typeof PCD.core.agoText === 'function') return PCD.core.agoText(ms);
    var m = Math.floor(Number(ms) / 60000);
    if (!(m >= 60)) return '';
    var h = Math.floor(m / 60);
    return h < 48 ? h + ' h ago' : Math.floor(h / 24) + ' d ago';
  }

  /**
   * The weather's text lines:
   *   46°F drizzle · berlin | feels 41° · wind 9 mph | hi 49° · lo 41° | weather: open-meteo.com[ · 2 h ago]
   * The city (muted) is cut to whole words to fit `width`, or left out with its ' · '. 'hi' and 'lo' (never 'h' and
   * 'l': 'l 33°' reads as '133°' at small sizes). o: { width, link, compact }.
   */
  function weatherLines(w, o) {
    if (!w || !w.data) return [];
    var opt = o || {};
    var d = w.data;
    var F = w.units !== 'C';
    var cond = lower(d.description || d.label || d.kind || '');
    var first = [run(deg(d.temp) + (F ? '°F' : '°C'), 'text', true)].concat(cond ? [run(' ' + cond, 'text')] : []);
    var room = num(opt.width, 0) > 0 ? opt.width - width(first) - SEP.length : 40;
    var city = w.city ? kit().wordsThatFit(lower(w.city), room) : '';
    if (city) first = first.concat([run(SEP, 'frame'), run(city, 'muted')]);
    var ago = agoText(w.ageMs);
    var credit = [run(CREDIT, 'faint'), run(CREDIT_DOMAIN, 'faint', false, opt.link ? CREDIT_URL : null)];
    if (ago) credit.push(run(SEP, 'frame'), run(ago, 'faint'));
    // old data: 'open-meteo.com · 2 h ago' when the 'weather: ' prefix leaves no room (the domain is the credit)
    if (num(opt.width, 0) > 0 && width(credit) > opt.width) credit = credit.slice(1);
    if (opt.compact) return [first, credit];
    return [
      first,
      [run('feels ' + deg(d.feels) + '°', 'muted'), run(SEP, 'frame'), run('wind ' + deg(d.wind) + ' ' + (F ? 'mph' : 'km/h'), 'muted')],
      [run('hi ' + deg(d.high) + '°', 'muted'), run(SEP, 'frame'), run('lo ' + deg(d.low) + '°', 'muted')],
      credit
    ];
  }

  /** The widest weather line without the city (and the credit at its shortest): the room the block needs beside the
   *  icon. */
  function weatherNeed(w) {
    var lines = weatherLines(w, { width: 1 });
    var n = 0;
    lines.forEach(function (l) { n = Math.max(n, width(l)); });
    return n;
  }

  /** Is it day for the icon: between the real sunrise and sunset, else the forecast's own flag. */
  function iconDay(V) {
    if (V.sun) return V.wallHour >= V.sun.rise && V.wallHour < V.sun.set;
    return V.weather && typeof V.weather.data.isDay === 'boolean' ? V.weather.data.isDay : true;
  }

  /** The weather block: the 11 x 4 icon, two spaces, the four lines (compact: two lines, no icon). */
  function weatherBlock(V, o) {
    var w = V.weather;
    if (!w) return [];
    var opt = o || {};
    var A = kit();
    if (opt.compact) return weatherLines(w, { width: opt.width, link: opt.link, compact: true }).map(function (l) { return cut(l, opt.width || 99); });
    var lines = weatherLines(w, { width: (opt.width || 99) - TEXT_AT, link: opt.link });
    var art = A.icon(A.iconKey(w.data.kind, iconDay(V)));
    var out = [];
    for (var i = 0; i < 4; i++) out.push(cut(art[i].concat([run('  ')], lines[i] || []), opt.width || 99));
    return out;
  }

  function sum(list) {
    return list.reduce(function (s, v) { return s + v; }, 0);
  }

  /**
   * Link items: '[1] wikipedia' ('[' and '] ' faint, the number accent, the label muted), lengths in code points.
   * One row when every item fits 3 cells apart. Else the most links a row whose columns, each as wide as its own
   * longest item (10 cells at least, so short labels line up), fit 3 cells apart, never one link alone on the last row
   * of 3 or more a row (5 links: 3 + 2); one link a row when nothing else fits, a label cut only when it is wider than
   * the column. The rows depend on the lengths alone, so compute() gets the same rows as content().
   *   -> { n, per, rows, cols (the block's width), widths (each column's), x (each column's first cell), itemW (the
   *        widest column and the gap), items [{ n, label, url, col, row, x (cells from the column's start), cols,
   *        block }] }
   */
  function linkItems(links, colW) {
    var list = Array.isArray(links) ? links : [];
    var n = list.length;
    var W = Math.max(1, Math.floor(num(colW, 44)));
    if (!n) return { n: 0, per: 0, rows: 0, cols: 0, widths: [], x: [], itemW: 0, items: [] };
    var need = list.map(function (l) { return 4 + cpLen(l.label); });
    var per = 1;
    var widths = [Math.min(W, Math.max.apply(null, need))];
    if (sum(need) + LINK_GAP * (n - 1) <= W) {
      per = n;
      widths = need;
    } else {
      for (var p = n - 1; p >= 2; p--) {
        if (p > 2 && n % p === 1) continue;
        var ws = [];
        for (var j = 0; j < p; j++) ws.push(LINK_COL_MIN);
        need.forEach(function (v, i) { ws[i % p] = Math.max(ws[i % p], v); });
        if (sum(ws) + LINK_GAP * (p - 1) <= W) {
          per = p;
          widths = ws;
          break;
        }
      }
    }
    var x = [];
    for (var k = 0, at = 0; k < widths.length; k++) {
      x.push(at);
      at += widths[k] + LINK_GAP;
    }
    var items = list.map(function (l, i) {
      var label = need[i] > W ? cpCut(l.label, Math.max(1, W - 4)) : l.label;
      var col = i % per;
      return {
        n: i + 1, label: label, url: l.url, col: col, row: Math.floor(i / per), x: x[col], cols: 4 + cpLen(label),
        block: [[run('[', 'faint'), run(String(i + 1), 'accent'), run('] ', 'faint'), run(label, 'muted')]]
      };
    });
    var last = widths.length - 1;
    return {
      n: n, per: per, rows: Math.ceil(n / per), cols: x[last] + widths[last], widths: widths, x: x,
      itemW: Math.max.apply(null, widths) + LINK_GAP, items: items
    };
  }

  /** The links' label lengths for compute() and plan(): parts.linkLens (code points, from partsOf), else parts.links
   *  labels of parts.linkW cells (8 when not given). */
  function linkLensOf(parts) {
    var lens = Array.isArray(parts.linkLens) ? parts.linkLens : [];
    var n = Math.max(0, Math.min(MAX_LINKS, Math.floor(num(parts.links, lens.length))));
    var out = [];
    for (var i = 0; i < n; i++) out.push(clamp(Math.round(num(lens[i], num(parts.linkW, 8))), 1, LABEL_MAX));
    return out;
  }

  /** Stand-in links of those lengths (the layout needs the rows, not the text). */
  function sizedLinks(lens) {
    return lens.map(function (len) { return { label: rep('x', len), url: '' }; });
  }

  /** '── terminal ─────': the lines wood, the word faint, exactly w cells. */
  function ruleLine(w) {
    if (w < 13) return [run(rep('─', Math.max(0, w)), 'wood')];
    return [run('── ', 'wood'), run('terminal', 'faint'), run(' ' + rep('─', w - 12), 'wood')];
  }

  /** The hint: '1-3 + enter opens a link · help lists commands' with the real range ('1' with one link; no link half
   *  with none), as much of it as fits w cells. */
  function hintLine(V, w) {
    if (V.hint != null) {
      var own = typeof V.hint === 'string' ? [run(V.hint, 'faint')] : kit().toLine(V.hint);
      return width(own) <= w ? own : [];
    }
    var parts = [];
    var n = V.links.length;
    if (n) parts.push([run(n > 1 ? '1-' + n : '1', 'muted'), run(' + enter opens a link', 'faint')]);
    parts.push([run('help', 'muted'), run(' lists commands', 'faint')]);
    var out = [];
    for (var i = 0; i < parts.length; i++) {
      var next = out.length ? out.concat([run(SEP, 'frame')], parts[i]) : parts[i].slice();
      if (width(next) > w) break;
      out = next;
    }
    return out;
  }

  /** The caption: the scene's name, the tag when it is not auto, the phase (text; separators frame). */
  function captionLine(V) {
    var out = [];
    if (V.name) out.push(run(V.name, 'text'));
    if (V.tag && V.tag !== 'auto') {
      if (out.length) out.push(run(SEP, 'frame'));
      out.push(run(V.tag, 'text'));
    }
    if (V.phase) {
      if (out.length) out.push(run(SEP, 'frame'));
      out.push(run(V.phase, 'text'));
    }
    return out;
  }

  /** '≡ settings': it sits on the scene beside the caption, so its word is text like the caption (muted measured
   *  4.2:1 over bright scenes); the glyph and the quiet place keep it calm. */
  function settingsLine() {
    return [run('≡ ', 'frame'), run('settings', 'text')];
  }

  /** What has content, for compute(): the parts that take rows and the widths that decide their modes. */
  function partsOf(raw, profile) {
    var p = profileOf(profile);
    var V = raw && raw.wallHour !== undefined ? raw : view(raw, p);
    return {
      // a reserved status row is laid out (and stays blank) until the line comes, so nothing moves when it does
      status: p === 'newtab' && (!!kit().statusLine(V.status) || !!(V.reserve && V.reserve.status)),
      weather: !!V.weather,
      weatherW: V.weather ? weatherNeed(V.weather) : 0,
      links: V.links.length,
      linkLens: V.links.map(function (l) { return cpLen(l.label); }),
      face: V.face
    };
  }

  // ------------------------------------------------------------------------------------------------ the row plan

  /**
   * The column's rows, top down, and what drops when the rows run short, in the order of DROPS: the terminal's spare
   * rows, the strip, the rule, the weather to two lines, the status line, the compact clock, the blank rows between
   * groups, the top margin, the weather, the date, the clock, the bottom row, the greeting, the links, the margins.
   */
  function plan(R, colW, profile, parts) {
    var NT = profile === 'newtab';
    var dateFace = parts.face === 'date';
    var wxFull = TEXT_AT + Math.max(parts.weatherW || 0, 23);
    var p = {
      my: R >= 34 ? 2 : R >= 18 ? 1 : 0,
      bottom: R >= 18 ? 1 : 0,
      gaps: true,
      clock: colW >= (dateFace ? DATE_FACE_W : CLOCK_FULL_W) ? 'full' : colW >= CLOCK_COMPACT_W ? 'compact' : 'none',
      head: ['greet'].concat(dateFace ? [] : ['date'], NT && parts.status ? ['status'] : []),
      strip: colW >= STRIP_MIN_W,
      weather: !parts.weather ? 'none' : colW >= wxFull ? 'full' : colW >= WEATHER_MIN_W ? 'compact' : 'none',
      links: NT && parts.links > 0,
      rule: NT,
      term: NT,
      termMin: NT ? 6 : 0,
      foot: true
    };
    var linkRows = NT && parts.links ? linkItems(sizedLinks(linkLensOf(parts)), colW).rows : 0;
    function groups() {
      var g = [];
      if (p.clock !== 'none') g.push(['clock', p.clock === 'full' ? 6 : 3]);
      if (p.head.length) g.push(['head', p.head.length]);
      if (p.strip) g.push(['strip', 1]);
      if (p.weather !== 'none') g.push(['weather', p.weather === 'full' ? 4 : 2]);
      if (p.links) g.push(['links', linkRows]);
      if (p.term) g.push(['term', (p.rule ? 1 : 0) + p.termMin]);
      return g;
    }
    function total() {
      var n = p.my + p.bottom + (p.foot ? 1 + (p.gaps ? 1 : 0) : 0);
      groups().forEach(function (x, i) { n += x[1] + (i && p.gaps ? 1 : 0); });
      return n;
    }
    var drops = {
      'term-4': function () { if (p.term) p.termMin = 4; },
      strip: function () { p.strip = false; },
      rule: function () { p.rule = false; },
      'term-3': function () { if (p.term) p.termMin = 3; },
      'weather-compact': function () { if (p.weather === 'full') p.weather = 'compact'; },
      status: function () { p.head = p.head.filter(function (h) { return h !== 'status'; }); },
      'clock-compact': function () { if (p.clock === 'full') p.clock = 'compact'; },
      gaps: function () { p.gaps = false; },
      'margin-1': function () { p.my = Math.min(p.my, 1); },
      weather: function () { p.weather = 'none'; },
      date: function () { p.head = p.head.filter(function (h) { return h !== 'date'; }); },
      'term-2': function () { if (p.term) p.termMin = 2; },
      clock: function () { p.clock = 'none'; },
      foot: function () { p.foot = false; },
      head: function () { p.head = []; },
      links: function () { p.links = false; },
      margins: function () { p.my = 0; p.bottom = 0; },
      'term-1': function () { if (p.term) p.termMin = 1; }
    };
    var dropped = [];
    for (var i = 0; total() > R && i < DROPS.length; i++) {
      drops[DROPS[i]]();
      dropped.push(DROPS[i]);
    }
    var rows = {};
    var r = p.my;
    groups().forEach(function (x, j) {
      if (j && p.gaps) r++;
      rows[x[0]] = r;
      r += x[1];
    });
    if (rows.head !== undefined) p.head.forEach(function (h, j) { rows[h] = rows.head + j; });
    rows.foot = p.foot ? R - 1 - p.bottom : -1;
    if (rows.term !== undefined) {
      var top = rows.term + (p.rule ? 1 : 0);
      if (p.rule) rows.rule = rows.term;
      var end = p.foot ? rows.foot - (p.gaps ? 1 : 0) : R - p.bottom;
      rows.term = { r: top, rows: Math.max(1, end - top) };
    }
    rows.end = r;
    return { p: p, rows: rows, dropped: dropped, fits: total() <= R };
  }

  // ------------------------------------------------------------------------------------------------ compute

  function compute(input) {
    var o = input || {};
    var profile = profileOf(o.profile);
    var NT = profile === 'newtab';
    var side = sideOf(o.side, profile);
    var dpr = num(o.dpr, 0) > 0 ? o.dpr : 1;
    var cssW = Math.max(1, num(o.cssW, 1));
    var cssH = Math.max(1, num(o.cssH, 1));
    var Wd = Math.max(1, Math.round(cssW * dpr));
    var Hd = Math.max(1, Math.round(cssH * dpr));
    var step = num(o.fontStep, 0) > 0 ? o.fontStep : fontStep(cssH, dpr, profile, cssW);
    var cell = cellAt(o, step, dpr);
    var cwD = cell.wDev;
    var chD = cell.hDev;
    var C = Math.max(1, Math.floor(Wd / cwD));
    var Rall = Math.max(1, Math.floor(Hd / chD));
    var tbDev = NT ? 0 : Math.max(0, Math.round(num(o.taskbar, 56) * dpr));
    var R = NT ? Rall : Math.max(1, Math.floor(Math.max(chD, Hd - tbDev) / chD));
    var mx = C >= 100 ? 4 : C >= 60 ? 3 : C >= 24 ? 2 : 0;
    var colW = Math.max(1, Math.min(clamp(Math.round(C * 0.34), 44, 64), C - 2 * mx));
    var parts = o.parts && typeof o.parts === 'object' ? o.parts : {};
    var lens = NT ? linkLensOf(parts) : [];
    parts = {
      status: !!parts.status, weather: parts.weather !== false && parts.weather !== 0, weatherW: num(parts.weatherW, 23),
      links: lens.length, linkLens: lens, face: profile === 'still' || parts.face === 'date' ? 'date' : 'time'
    };
    var P = plan(R, colW, profile, parts);
    var x0 = side === 'right' ? Wd - C * cwD : 0;
    var c0 = side === 'right' ? C - mx - colW : mx;
    var edgeDev = side === 'right' ? x0 + c0 * cwD : x0 + (c0 + colW) * cwD;
    var L = {
      profile: profile, side: side, dpr: dpr, cssW: cssW, cssH: cssH, Wd: Wd, Hd: Hd,
      font: { step: step, px: step / dpr },
      cell: { w: cwD / dpr, h: chD / dpr, wDev: cwD, hDev: chD, ls: cell.ls },
      grid: { cols: C, rows: Rall, usable: R, xDev: x0, x: x0 / dpr },
      mx: mx,
      col: null,
      edge: { side: side, xDev: edgeDev, x: edgeDev / dpr },
      plan: P.p,
      rows: P.rows,
      dropped: P.dropped,
      fits: P.fits,
      links: NT && P.p.links ? linkItems(sizedLinks(lens), colW) : null,
      taskbar: { dev: tbDev, rows: Rall - R },
      parts: parts
    };
    if (L.links) delete L.links.items;
    L.col = rect(L, c0, 0, colW, R);
    return L;
  }

  /** A cell rect with its CSS px box (whole device px). */
  function rect(L, c, r, cols, rows) {
    var cw = L.cell.wDev;
    var ch = L.cell.hDev;
    return {
      c: c, r: r, cols: cols, rows: rows,
      x: (L.grid.xDev + c * cw) / L.dpr, y: r * ch / L.dpr, w: cols * cw / L.dpr, h: rows * ch / L.dpr
    };
  }

  // ------------------------------------------------------------------------------------------------ content

  function content(raw, L) {
    var A = kit();
    var V = raw && raw.wallHour !== undefined ? raw : view(raw, L.profile);
    var P = L.plan;
    var R = L.rows;
    var c = L.col.c;
    var w = L.col.cols;
    var NT = L.profile === 'newtab';
    var out = {
      clock: null, greet: null, date: null, status: null, strip: null, weather: null, links: [], rule: null, term: null,
      hint: null, caption: null, settings: null
    };
    // the clock (the still: the calendar page)
    if (P.clock !== 'none' && R.clock !== undefined) {
      var compact = P.clock === 'compact';
      var dateFace = V.face === 'date';
      var face = dateFace ? A.dayFace(V.now.getDate(), { compact: compact })
        : A.clockFace(V.now.getHours(), V.now.getMinutes(), { clock24: V.clock24, colon: true, compact: compact });
      var side = null;
      if (dateFace) {
        var dp = PCD.core && PCD.core.dateParts ? PCD.core.dateParts(V.now) : null;
        var la = face.labelsAt;
        var block = [];
        for (var i = 0; i <= la.weekdayRow - la.monthRow; i++) block.push([]);
        block[0] = [run(dp ? dp.monthLong : '', 'text', true)];
        block[la.weekdayRow - la.monthRow] = [run(dp ? dp.weekdayLong : '', 'muted')];
        side = { c: c + la.c, r: R.clock + la.monthRow, block: block };
      } else if (face.ampm) {
        side = { c: c + face.ampmAt.c, r: R.clock + face.ampmAt.r, block: [[run(face.ampm, 'muted')]] };
      }
      out.clock = {
        c: c, r: R.clock, face: face, compact: compact, shadow: face.shadow,
        rects: A.faceRects(face, L.cell.wDev, L.cell.hDev), side: side,
        text: dateFace ? (PCD.core && PCD.core.formatDate ? PCD.core.formatDate(V.now) : '')
          : (PCD.core && PCD.core.formatTime ? PCD.core.formatTime(V.now, V.clock24) : '')
      };
    }
    // the greeting, the date, the status line
    if (R.greet !== undefined && PCD.greet && typeof PCD.greet.parts === 'function') {
      out.greet = { c: c, r: R.greet, block: [cut(A.greetLine(PCD.greet.parts(V.now, root.PixelClock), w), w)] };
    }
    if (R.date !== undefined) {
      var dt = PCD.core && PCD.core.formatDate ? PCD.core.formatDate(V.now) : '';
      if (dt) out.date = { c: c, r: R.date, block: [[run(dt, 'muted')]] };
    }
    if (R.status !== undefined) {
      var st = A.statusLine(V.status, w);
      if (st) out.status = { c: c, r: R.status, block: [cut(st, w)] };
    }
    // the daylight strip: [rise 5][2][n bars][2][set 5] across the column; without sun times (offline before the first
    // forecast, or real sun times off) the bars alone span the whole column
    if (P.strip && R.strip !== undefined) {
      var lab = A.stripLabels(V.sun, V.clock24);
      var bare = !lab.rise && !lab.set;
      var n = bare ? w : Math.max(0, w - 14);
      var curve = V.curve;
      if (!curve && PCD.sun && typeof PCD.sun.curve === 'function' && typeof PCD.sun.anchor === 'function' && V.theme) {
        try {
          curve = PCD.sun.curve(PCD.sun.anchor(V.theme), V.sun);
        } catch (e) {
          curve = null;
        }
      }
      out.strip = {
        c: c, r: R.strip, block: [bare ? [] : A.stripLine(n, lab)],
        bars: { c: bare ? c : c + 7, r: R.strip, n: n, rects: A.stripRects(A.strip(curve, n, V.wallHour), L.cell.wDev, L.cell.hDev) }
      };
    }
    // the weather
    if (P.weather !== 'none' && R.weather !== undefined && V.weather) {
      out.weather = { c: c, r: R.weather, block: weatherBlock(V, { width: w, link: NT, compact: P.weather === 'compact' }) };
    }
    // the links
    if (P.links && R.links !== undefined) {
      var li = linkItems(V.links, w);
      out.links = li.items.map(function (it) {
        return { n: it.n, label: it.label, url: it.url, c: c + it.x, r: R.links + it.row, cols: it.cols, block: it.block };
      });
    }
    // the terminal: the rule and the slot
    if (P.rule && R.rule !== undefined) out.rule = { c: c, r: R.rule, block: [ruleLine(w)] };
    if (R.term && typeof R.term === 'object') out.term = { c: c, r: R.term.r, cols: w, rows: R.term.rows };
    // the bottom row: the new tab's hint on the column side, the caption on the far side; the wallpaper and the still:
    // the caption in the column's bottom corner
    var C = L.grid.cols;
    var mx = L.mx;
    var footRow = R.foot >= 0 ? R.foot : L.grid.usable - 1 - P.bottom;
    var cap = captionLine(V);
    var set = NT && V.settings ? settingsLine() : null;
    var capW = width(cap);
    var setW = set ? width(set) : 0;
    var both = capW && setW ? capW + SETTINGS_GAP + setW : capW + setW;
    if (NT) {
      var left = L.side === 'left';
      var hint = [];
      if (P.foot && R.foot >= 0) {
        var room = Math.max(w, Math.min(w + HINT_EXTRA, C - 2 * mx - both - CAPTION_GAP - 2));
        hint = hintLine(V, room);
        if (hint.length) out.hint = { c: left ? c : C - mx - width(hint), r: R.foot, block: [hint] };
      }
      // the far side, beside the hint: it must clear the hint (or, with no hint row, the column)
      var used = hint.length ? width(hint) : (R.foot >= 0 ? 0 : w);
      var near = mx + used + (hint.length ? CAPTION_GAP : 2);
      var fits = function (n) { return footRow >= 0 && n > 0 && C - mx - n >= near; };
      var show = fits(both) ? both : fits(setW) ? setW : 0;
      if (show) {
        var x = left ? C - mx - show : mx;
        if (show === both && capW) {
          out.caption = { c: x, r: footRow, block: [cap], cols: capW };
          x += capW + (setW ? SETTINGS_GAP : 0);
        }
        if (setW) out.settings = { c: x, r: footRow, block: [set], cols: setW };
      }
    } else if (P.foot && R.foot >= 0 && capW) {
      var line = capW <= w ? cap : cut(cap, w);
      var cw2 = width(line);
      out.caption = { c: L.side === 'right' ? c + w - cw2 : c, r: R.foot, block: [line], cols: cw2 };
    }
    return out;
  }

  /** CSS px rects of every part of a layout (and of a content, when given). */
  function regions(L, ct) {
    if (!L) return null;
    var R = L.rows;
    var c = L.col.c;
    var w = L.col.cols;
    var out = {
      cell: { w: L.cell.w, h: L.cell.h, wDev: L.cell.wDev, hDev: L.cell.hDev, ls: L.cell.ls },
      fontPx: L.font.px,
      column: L.col,
      clock: R.clock !== undefined ? rect(L, c, R.clock, w, L.plan.clock === 'full' ? 6 : 3) : null,
      greet: R.greet !== undefined ? rect(L, c, R.greet, w, 1) : null,
      date: R.date !== undefined ? rect(L, c, R.date, w, 1) : null,
      status: R.status !== undefined ? rect(L, c, R.status, w, 1) : null,
      strip: R.strip !== undefined ? rect(L, c, R.strip, w, 1) : null,
      weather: R.weather !== undefined ? rect(L, c, R.weather, w, L.plan.weather === 'full' ? 4 : 2) : null,
      links: R.links !== undefined && L.links ? rect(L, c, R.links, w, L.links.rows) : null,
      rule: R.rule !== undefined ? rect(L, c, R.rule, w, 1) : null,
      term: R.term && typeof R.term === 'object' ? rect(L, c, R.term.r, w, R.term.rows) : null,
      foot: R.foot >= 0 ? rect(L, 0, R.foot, L.grid.cols, 1) : null,
      hint: null,
      caption: null,
      settings: null,
      sheet: null
    };
    if (ct) {
      if (ct.hint) out.hint = rect(L, ct.hint.c, ct.hint.r, width(ct.hint.block[0]), 1);
      if (ct.caption) out.caption = rect(L, ct.caption.c, ct.caption.r, ct.caption.cols, 1);
      if (ct.settings) out.settings = rect(L, ct.settings.c, ct.settings.r, ct.settings.cols, 1);
    }
    if (L.profile === 'newtab') {
      // the settings sheet covers the column (2 cells more on each side) from the top margin down to the row above
      // the bottom row
      var sc = Math.max(0, c - 2);
      var scols = Math.min(L.grid.cols - sc, w + 4);
      var top = L.plan.my;
      var bottom = R.foot >= 0 ? R.foot - 1 : L.grid.usable;
      out.sheet = rect(L, sc, top, scols, Math.max(1, bottom - top));
    }
    return out;
  }

  // ------------------------------------------------------------------------------------------------ the scene layer

  /**
   * The scene layer: PCD.bleed.mountScene (src/shared/pcd-bleed.js) in its own holder under the column, behind one
   * small adapter, so the console's members never depend on the layer's own names. The console
   * passes the layer the column's reach (from its own screen edge to its inner edge, margin included), its cell, the
   * taskbar reserve, the bottom row's top (the light band along the bottom leans on it) and the new tab's caption (the
   * soft shade behind it). The layer owns k, the crop, the dimming, the bands, the seam and the veil.
   */
  function mountScene(parent, opts) {
    if (!PCD.bleed || typeof PCD.bleed.mountScene !== 'function') {
      throw new Error('PCD.console needs js/pcd-bleed.js (the scene layer) for mount()');
    }
    var o = opts || {};
    var doc = o.document || parent.ownerDocument || root.document;
    var holder = doc.createElement('div');
    holder.className = 'pcd-world';
    parent.appendChild(holder);
    var layer = PCD.bleed.mountScene(holder, { side: o.side, profile: o.profile, doc: doc, style: false, pointer: o.profile !== 'wallpaper' });
    var foot = null;
    var last = null;

    function geometry() {
      var g = layer.geo();
      if (!g) return null;
      return {
        k: g.k, size: g.scene.size, x: g.scene.x, y: g.scene.y, place: g.place, edge: g.edge, band: g.band, fade: g.fade,
        Wd: g.Wd, Hd: g.Hd, dpr: g.dpr, side: g.side, reach: g.column.reach, crop: g.crop
      };
    }

    return {
      el: holder,
      veil: layer.gradient,
      canvas: layer.canvas,
      layer: layer,
      /** vp { cssW, cssH, dpr, side, edge (CSS px: the column's inner edge), cell { w, h }, taskbar, foot, caption } */
      setViewport: function (vp) {
        foot = vp.foot == null ? null : vp.foot;
        last = JSON.stringify(vp.caption || null);
        var reach = vp.side === 'right' ? vp.cssW - vp.edge : vp.edge;
        layer.setViewport(vp.cssW, vp.cssH, vp.dpr, {
          side: vp.side, cell: vp.cell, reach: reach, bottomCss: vp.taskbar || 0, statusTop: foot,
          caption: vp.caption || null
        });
        return geometry();
      },
      caption: function (r) {
        var key = JSON.stringify(r || null);
        if (key === last) return;
        last = key;
        layer.shade({ statusTop: foot, caption: r || null });
      },
      paint: function (fb, info) {
        layer.draw(fb, info);
        return true;
      },
      geometry: geometry,
      report: function () {
        var p = layer.pixels();
        return { geometry: geometry(), frame: p.frame, rows: p.rows, fade: p.fade, cols: p.cols, edge: p.edge, info: layer.info() };
      },
      hit: function (t) {
        return layer.isScene(t);
      },
      destroy: function () {
        layer.destroy();
        if (holder.parentNode) holder.parentNode.removeChild(holder);
      }
    };
  }

  // ------------------------------------------------------------------------------------------------ the DOM console

  function mount(rootEl, opts) {
    var o = opts || {};
    var doc = o.document || rootEl.ownerDocument || root.document;
    var win = doc.defaultView || root;
    var profile = o.profile === 'wallpaper' ? 'wallpaper' : 'newtab';
    var NT = profile === 'newtab';
    var side = sideOf(o.side, profile);
    var useHook = o.hook !== false;
    var A = kit();

    var L = null;
    var CT = null;
    var VP = null;
    var V = view({}, profile);
    var DPR = 1;
    var keys = {};
    var listeners = [];
    var layoutFns = [];
    var shakeFns = [];
    var state = { ready: false, colon: true, ringing: false, ringOn: false, sheet: false, font: null, destroyed: false };

    while (rootEl.firstChild) rootEl.removeChild(rootEl.firstChild);
    rootEl.classList.add('pcd-console');
    rootEl.setAttribute('data-profile', profile);
    rootEl.setAttribute('data-side', side);

    function make(tag, cls, parent, attrs) {
      var e = doc.createElement(tag);
      if (cls) e.className = cls;
      if (attrs) Object.keys(attrs).forEach(function (k) { e.setAttribute(k, attrs[k]); });
      (parent || rootEl).appendChild(e);
      return e;
    }

    function on(target, type, fn, opt) {
      target.addEventListener(type, fn, opt);
      listeners.push(function () { target.removeEventListener(type, fn, opt); });
    }

    // the scene layer, then the column over it
    var scene = mountScene(rootEl, { side: side, document: doc, profile: profile });
    var E = {};
    E.col = make('div', 'pcd-col', rootEl);
    E.time = make('div', 'pcd-sr', E.col);
    E.clock = make('pre', 'pcd-g pcd-clock', E.col, { 'aria-hidden': 'true' });
    E.clockPx = make('canvas', 'pcd-px pcd-clockpx', E.col, { 'aria-hidden': 'true' });
    E.colon = [make('div', 'pcd-colon', E.col, { 'aria-hidden': 'true' }), make('div', 'pcd-colon', E.col, { 'aria-hidden': 'true' })];
    E.side = make('pre', 'pcd-g pcd-side', E.col, { 'aria-hidden': 'true' });
    E.greet = make('pre', 'pcd-g pcd-greet', E.col);
    E.date = make('pre', 'pcd-g pcd-date', E.col);
    if (NT) E.status = make('pre', 'pcd-g pcd-status', E.col, { role: 'status' });
    E.stripText = make('pre', 'pcd-g pcd-striptext', E.col, { 'aria-hidden': 'true' });
    E.strip = make('canvas', 'pcd-px pcd-strip', E.col, { 'aria-hidden': 'true' });
    E.weather = make('pre', 'pcd-g pcd-weather', E.col);
    if (NT) {
      E.links = make('nav', 'pcd-links', E.col, { 'aria-label': 'links' });
      E.rule = make('pre', 'pcd-g pcd-rule', E.col, { 'aria-hidden': 'true' });
      E.term = make('section', 'pcd-term', E.col, { 'aria-label': 'terminal' });
      E.hint = make('pre', 'pcd-g pcd-hint', E.col);
    }
    E.caption = make('pre', 'pcd-g pcd-caption', rootEl);
    if (NT) {
      E.settings = make('button', 'pcd-g pcd-settings', rootEl, { type: 'button', 'aria-label': 'settings' });
      draw(E.settings, [settingsLine()]);
    }
    E.linkEls = [];

    function draw(el, block) {
      return A.fill(el, block, { className: runClass, doc: doc });
    }

    function runClass(r) {
      var roles = (r.tone || '') + (r.bold ? ' bold' : '');
      if (PCD.core && typeof PCD.core.roleClass === 'function') return PCD.core.roleClass(roles);
      return roles.split(/\s+/).filter(Boolean).map(function (x) { return 't-' + x; }).join(' ');
    }

    function drawKeyed(name, el, block) {
      var k = JSON.stringify(block);
      if (keys[name] === k) return false;
      keys[name] = k;
      draw(el, block);
      return true;
    }

    function px(dev) {
      return dev / DPR + 'px';
    }

    function put(e, c, r) {
      e.style.left = px(L.grid.xDev + c * L.cell.wDev);
      e.style.top = px(r * L.cell.hDev);
    }

    function show(e, onOff) {
      if (e) e.hidden = !onOff;
    }

    function setVar(name, value) {
      if (keys['var' + name] === value) return;
      keys['var' + name] = value;
      rootEl.style.setProperty(name, value);
    }

    function clockHex() {
      if (V.clockColor !== null) return hexOf(V.clockColor);
      return hexOf(A.clockColor(V.themeClock === null ? null : V.themeClock));
    }

    // ---------------------------------------------------------------------------------------- drawing

    function drawClock() {
      var k = CT.clock;
      show(E.clock, !!k && !k.compact);
      show(E.clockPx, !!k);
      show(E.side, !!(k && k.side));
      if (!k) {
        E.colon.forEach(function (el) { el.hidden = true; });
        E.time.textContent = '';
        return;
      }
      var key = JSON.stringify([k.c, k.r, k.face.lit, k.compact, L.cell.wDev, L.cell.hDev, keys['var--clock'], k.side]);
      E.time.textContent = k.text;
      if (keys.clock === key) return;
      keys.clock = key;
      if (!k.compact) {
        draw(E.clock, k.shadow);
        put(E.clock, k.c, k.r);
      }
      var cw = L.cell.wDev;
      var ch = L.cell.hDev;
      var pw = k.compact ? cw : 2 * cw;
      var ph = k.compact ? Math.max(1, Math.round(ch / 2)) : ch;
      var wD = Math.max(1, k.face.W * pw);
      var hD = 5 * ph;
      if (E.clockPx.width !== wD) E.clockPx.width = wD;
      if (E.clockPx.height !== hD) E.clockPx.height = hD;
      E.clockPx.style.width = px(wD);
      E.clockPx.style.height = px(hD);
      put(E.clockPx, k.c, k.r);
      var g = E.clockPx.getContext('2d');
      g.clearRect(0, 0, wD, hD);
      g.fillStyle = keys['var--clock'];
      var colon = [];
      k.rects.forEach(function (q) {
        if (q.colon) colon.push(q);
        else g.fillRect(q.x, q.y, q.w, q.h);
      });
      E.colon.forEach(function (el, i) {
        var q = colon[i];
        el.hidden = !q;
        if (!q) return;
        el.style.left = px(L.grid.xDev + k.c * cw + q.x);
        el.style.top = px(k.r * ch + q.y);
        el.style.width = px(q.w);
        el.style.height = px(q.h);
      });
      applyColon();
      if (k.side) {
        draw(E.side, k.side.block);
        put(E.side, k.side.c, k.side.r);
      }
    }

    function applyColon() {
      var onOff = state.colon || V.steady || V.face === 'date';
      E.colon.forEach(function (el) { el.style.visibility = onOff ? '' : 'hidden'; });
    }

    function drawLine(name, el, part) {
      show(el, !!part);
      if (!part) {
        keys[name] = '';
        return;
      }
      drawKeyed(name, el, part.block);
      put(el, part.c, part.r);
    }

    function drawStrip() {
      var s = CT.strip;
      show(E.stripText, !!s);
      show(E.strip, !!s);
      if (!s) {
        keys.strip = '';
        return;
      }
      drawKeyed('stripText', E.stripText, s.block);
      put(E.stripText, s.c, s.r);
      var key = JSON.stringify([s.bars.rects, s.bars.c, s.bars.r]);
      if (keys.strip === key) return;
      keys.strip = key;
      var cw = L.cell.wDev;
      var ch = L.cell.hDev;
      var wD = Math.max(1, s.bars.n * cw);
      if (E.strip.width !== wD) E.strip.width = wD;
      if (E.strip.height !== ch) E.strip.height = ch;
      E.strip.style.width = px(wD);
      E.strip.style.height = px(ch);
      put(E.strip, s.bars.c, s.bars.r);
      var g = E.strip.getContext('2d');
      g.clearRect(0, 0, wD, ch);
      s.bars.rects.forEach(function (q) {
        g.fillStyle = hexOf(q.color);
        g.fillRect(q.x, q.y, q.w, q.h);
      });
    }

    function drawLinks() {
      if (!E.links) return;
      var list = CT.links || [];
      show(E.links, list.length > 0);
      var key = JSON.stringify(list.map(function (l) { return [l.n, l.c, l.r, l.label, l.url]; }));
      if (keys.links === key) return;
      keys.links = key;
      while (E.linkEls.length > list.length) {
        var gone = E.linkEls.pop();
        if (gone.parentNode) gone.parentNode.removeChild(gone);
      }
      list.forEach(function (l, i) {
        var a = E.linkEls[i];
        if (!a) {
          a = make('a', 'pcd-g pcd-link', E.links);
          E.linkEls.push(a);
        }
        a.setAttribute('href', l.url);
        a.setAttribute('data-n', String(l.n));
        a.setAttribute('aria-label', l.n + ': ' + l.label);
        draw(a, l.block);
        put(a, l.c, l.r);
      });
    }

    function drawTerm() {
      if (!E.term) return;
      var t = CT.term;
      show(E.rule, !!CT.rule);
      if (CT.rule) {
        drawKeyed('rule', E.rule, CT.rule.block);
        put(E.rule, CT.rule.c, CT.rule.r);
      }
      show(E.term, !!t);
      if (!t) return;
      put(E.term, t.c, t.r);
      E.term.style.width = px(t.cols * L.cell.wDev);
      E.term.style.height = px(t.rows * L.cell.hDev);
      E.term.setAttribute('data-cols', String(t.cols));
      E.term.setAttribute('data-rows', String(t.rows));
    }

    function drawFoot() {
      if (E.hint) drawLine('hint', E.hint, CT.hint);
      drawLine('caption', E.caption, CT.caption);
      if (E.settings) {
        show(E.settings, !!CT.settings);
        if (CT.settings) put(E.settings, CT.settings.c, CT.settings.r);
      }
      scene.caption(shadeOf());
    }

    /** The new tab's caption sits on the scene (the far side): the soft shade goes behind it and '≡ settings'. The
     *  wallpaper's caption is in the column's corner, where the veil is dark already: no shade. */
    function shadeOf() {
      if (!NT || !CT || !(CT.caption || CT.settings)) return null;
      var rg = regions(L, CT);
      var a = rg.caption || rg.settings;
      var b = rg.settings || rg.caption;
      return { x: a.x, y: a.y, w: b.x + b.w - a.x, h: a.h };
    }

    function render() {
      if (!L || state.destroyed) return;
      CT = content(V, L);
      setVar('--clock', clockHex());
      scene.canvas.setAttribute('aria-label', [V.name, V.tag, V.phase].filter(Boolean).join(', ') || 'the pixelclock scene');
      drawClock();
      drawLine('greet', E.greet, CT.greet);
      drawLine('date', E.date, CT.date);
      if (E.status) drawLine('status', E.status, CT.status);
      drawStrip();
      drawLine('weather', E.weather, CT.weather);
      drawLinks();
      drawTerm();
      drawFoot();
      paintRing();
    }

    // ---------------------------------------------------------------------------------------- layout

    var cache = {};
    function measure(step) {
      var key = step + '@' + DPR + (state.font ? state.font.family : '');
      if (!(key in cache)) {
        cache[key] = PCD.font && PCD.font.measureCell ? PCD.font.measureCell({ host: rootEl, sizePx: step / DPR, dpr: DPR, doc: doc }) : null;
      }
      return cache[key];
    }

    function partsKey(v) {
      return JSON.stringify(partsOf(v, profile));
    }

    function setViewport(vp) {
      if (state.destroyed) return null;
      var v = vp || {};
      DPR = v.dpr > 0 ? v.dpr : (win.devicePixelRatio || 1);
      if (v.side === 'left' || v.side === 'right') {
        side = v.side;
        rootEl.setAttribute('data-side', side);
      }
      VP = {
        cssW: v.cssW > 0 ? v.cssW : win.innerWidth, cssH: v.cssH > 0 ? v.cssH : win.innerHeight, dpr: DPR,
        taskbar: v.taskbar, side: side
      };
      if (!(VP.cssW >= 1 && VP.cssH >= 1)) return null; // a zero-sized window (prerender, minimised): wait
      rootEl.style.width = VP.cssW + 'px';
      rootEl.style.height = VP.cssH + 'px';
      L = compute({
        cssW: VP.cssW, cssH: VP.cssH, dpr: DPR, profile: profile, side: side, taskbar: VP.taskbar,
        parts: partsOf(V, profile), measure: measure
      });
      keys = {};
      if (PCD.font && PCD.font.apply) PCD.font.apply(rootEl, L.cell, L.font.px);
      else rootEl.style.fontSize = L.font.px + 'px';
      rootEl.style.setProperty('--cell-w', L.cell.w + 'px');
      rootEl.style.setProperty('--cell-h', L.cell.h + 'px');
      rootEl.style.setProperty('--cell-ls', (L.cell.ls || 0) + 'px');
      if (useHook && PCD.hook) PCD.hook.mode = 'none';
      rootEl.setAttribute('data-place', L.plan.clock + '/' + L.plan.weather);
      CT = content(V, L);
      scene.setViewport({
        cssW: VP.cssW, cssH: VP.cssH, dpr: DPR, side: side, edge: L.edge.x, cell: { w: L.cell.w, h: L.cell.h },
        taskbar: profile === 'wallpaper' ? L.taskbar.dev / DPR : 0, foot: L.rows.foot >= 0 ? L.rows.foot * L.cell.h : null,
        caption: shadeOf()
      });
      render();
      layoutFns.slice().forEach(function (fn) {
        try {
          fn(L);
        } catch (e) { /* the piece reports its own errors */ }
      });
      return L;
    }

    function update(raw) {
      if (state.destroyed) return;
      var before = partsKey(V);
      V = view(raw, profile);
      if (V.ringing !== null) ringing(V.ringing);
      if (VP && partsKey(V) !== before) setViewport(VP);
      else render();
    }

    function colon(onOff) {
      state.colon = onOff !== false;
      applyColon();
    }

    // ---------------------------------------------------------------------------------------- ringing

    function paintRing() {
      rootEl.classList.toggle('pcd-ring-on', state.ringing && state.ringOn);
    }

    function ringing(onOff) {
      state.ringing = !!onOff;
      state.ringOn = state.ringing;
      paintRing();
    }

    function ring(onOff) {
      state.ringOn = !!onOff;
      paintRing();
    }

    // ---------------------------------------------------------------------------------------- shake, sheet

    function subscribe(list, fn) {
      if (typeof fn !== 'function') return function () {};
      list.push(fn);
      return function () {
        var i = list.indexOf(fn);
        if (i >= 0) list.splice(i, 1);
      };
    }

    function hit(t) {
      return !!scene.hit(t);
    }

    on(rootEl, 'pointerdown', function (e) {
      if (e && typeof e.button === 'number' && e.button !== 0) return;
      if (!hit(e.target)) return;
      shakeFns.slice().forEach(function (fn) {
        try {
          fn(e);
        } catch (err) { /* the piece reports its own errors */ }
      });
    });

    function sheet(open) {
      state.sheet = !!open;
      rootEl.classList.toggle('pcd-sheet-open', state.sheet);
    }

    // ---------------------------------------------------------------------------------------- the font

    var ready = new Promise(function (resolve) {
      function done(info) {
        if (state.destroyed) return resolve(false);
        state.font = info || null;
        state.ready = true;
        cache = {};
        if (VP) setViewport(VP);
        rootEl.classList.add('pcd-ready');
        resolve(true);
      }
      if (PCD.font && typeof PCD.font.load === 'function') {
        PCD.font.load(o.fontBase, { onLate: function (info) { done(info); } }).then(done, function () { done(null); });
      } else {
        done(null);
      }
    });

    function term() {
      if (!L || !CT || !CT.term || !E.term) return null;
      var t = CT.term;
      var r = rect(L, t.c, t.r, t.cols, t.rows);
      return {
        el: E.term, c: t.c, r: t.r, cols: t.cols, rows: t.rows, x: r.x, y: r.y, w: r.w, h: r.h,
        cell: { w: L.cell.w, h: L.cell.h, wDev: L.cell.wDev, hDev: L.cell.hDev, ls: L.cell.ls }, fontPx: L.font.px, dpr: DPR
      };
    }

    function el(name) {
      var m = /^link([1-9])$/.exec(String(name));
      if (m) return E.linkEls[+m[1] - 1] || null;
      var credit = name === 'credit' && E.weather ? E.weather.querySelector('a') : null;
      var map = {
        root: rootEl, column: E.col, canvas: scene.canvas, world: scene.el || null, term: E.term || null, links: E.links || null,
        settings: E.settings || null, credit: credit, status: E.status || null, hint: E.hint || null, caption: E.caption,
        greet: E.greet, date: E.date, weather: E.weather
      };
      return map[name] || null;
    }

    return {
      get canvas() { return scene.canvas; },
      scene: scene,
      ready: ready,
      setViewport: setViewport,
      update: update,
      frame: function (fb, opts2) { return scene.paint(fb, opts2); },
      colon: colon,
      ring: ring,
      ringing: ringing,
      sheet: sheet,
      hit: hit,
      onShake: function (fn) { return subscribe(shakeFns, fn); },
      onLayout: function (fn) { return subscribe(layoutFns, fn); },
      el: el,
      term: term,
      layout: function () { return L; },
      content: function () { return CT; },
      regions: function () { return regions(L, CT); },
      metrics: function () {
        var g = scene.geometry ? scene.geometry() : null;
        return g ? { k: g.k, dpr: DPR, x: g.x, y: g.y, size: g.size } : null;
      },
      info: function () {
        return {
          profile: profile, side: side, ready: state.ready, font: state.font ? state.font.family : null,
          fontPx: L ? L.font.px : 0, cell: L ? L.cell : null, plan: L ? L.plan : null, dropped: L ? L.dropped : [],
          sheet: state.sheet, ringing: state.ringing, scene: scene.geometry ? scene.geometry() : null
        };
      },
      report: function () {
        var s = scene.report();
        return { layout: L, regions: regions(L, CT), scene: s.geometry, frame: s.frame, rows: s.rows, fade: s.fade, cols: s.cols, layer: s.info };
      },
      destroy: function () {
        if (state.destroyed) return;
        state.destroyed = true;
        listeners.forEach(function (off) { off(); });
        listeners = [];
        shakeFns.length = 0;
        layoutFns.length = 0;
        if (scene.destroy) scene.destroy();
        while (rootEl.firstChild) rootEl.removeChild(rootEl.firstChild);
        rootEl.classList.remove('pcd-console', 'pcd-ready', 'pcd-sheet-open', 'pcd-ring-on');
      }
    };
  }

  var api = {
    PROFILES: PROFILES,
    SIDES: SIDES,
    DROPS: DROPS,
    compute: compute,
    content: content,
    view: view,
    partsOf: partsOf,
    regions: regions,
    mount: mount,
    mountScene: mountScene,
    parts: {
      weatherLines: weatherLines,
      weatherBlock: weatherBlock,
      linkItems: linkItems,
      hintLine: hintLine,
      captionLine: captionLine,
      settingsLine: settingsLine,
      ruleLine: ruleLine,
      plan: plan,
      fontStep: fontStep,
      cellAt: cellAt,
      weatherOf: weatherOf,
      linksOf: linksOf
    }
  };
  PCD.console = api;
  return api;
});
