/* PixelClock Desktop shared: the ASCII kit. Classic script, UMD, global PCD (PCD.ascii). It builds text and pixel
 * geometry; PCD.console (the pages, and the still with its glyph atlas) places them. Pure: no DOM except fill(), which
 * only runs when called; no timers. The engine (globalThis.PixelClock) is looked up when a function needs it (the
 * clock's own digit bits), never at load time.
 *
 * Runs and lines. A run is { text, tone, bold, href } (tone: a token name or null for plain; bold: weight 600; href:
 * a link, new tab only); a line is an array of runs; a block is an array of lines. Every builder pads or cuts lines to
 * exact cell widths, so blocks stack on the character grid. CLASSES maps tones to short CSS classes (className(run)
 * gives 'fr', 'tx tt', ...); fill(el, block) renders a block into a <pre> with text nodes and spans only (textContent,
 * CSP-safe; <a> for runs with href).
 *
 * API:
 *   TOKENS (the palette as 0xRRGGBB; PCD.TOKENS, the generated tokens, wins when it is loaded), token(name)
 *   TONES, CLASSES, className(run), CHARS (every non-ASCII glyph the kit emits, for the glyph gate), GLYPHS
 *   run(text, tone, opts) -> run;  width(runs);  fit(runs, w);  plain(block) -> [strings];  fill(el, block, opts)
 *   mix(a, b, t), contrast(a, b), hex(c)                            colour helpers (0xRRGGBB, WCAG ratios)
 *   clockColor(themeClock) -> mix(theme clock, text, 0.25), or text when that is under 4.5:1 on bg
 *   barColor(v) -> mix(line, wood, min(1, 1.4 v)) (a strip bar at light level v)
 *   edge(cornerL, cornerR, w, left, right, opts) -> line   one border line: corner, one line char, ' left ', the line,
 *                                                            ' right ', one line char, corner (labels cut to fit)
 *   digitBits(d, PC) -> 15 bits (row-major 3 x 5) from PC.drawDigit, the clock's own font
 *   clockFace(hours, minutes, { clock24, colon = true, compact, PC }) -> face (the big clock):
 *     { kind: 'time', W (clock pixels wide), lit (5 rows of W: 0 off, 1 lit, 2 colon), cols, rows, shadow (block of
 *       '░░' in wood, at +1 pixel right and down, the colon's shadow included so it never changes with the blink),
 *       ampm ('am'|'pm'|''), ampmAt: { c, r } (one cell after the shadow, on the digits' last row), colon: [{x, y}] }
 *   dayFace(day, { compact, PC }) -> the still's calendar face: the day of the month in the same digits and shadow,
 *     plus labelsAt: { c, monthRow: 1, weekdayRow: 4 } (two cells after the shadow)
 *   faceRects(face, cellWDev, cellHDev) -> [{ x, y, w, h, tone ('clock'|'accent'), colon }] in device px from the
 *     face's top-left cell: one rect per lit pixel, 2 cells x 1 row (compact: 1 cell x half a row)
 *   ICONS, ICON_KEYS, ICON_TONES;  iconKey(kind, isDay);  icon(key) -> block (4 rows of exactly 11 cells)
 *     (the weather's text lines and the whole block are the console's: PCD.console.parts.weatherLines / weatherBlock)
 *   strip(curve, n, nowH) -> [{ v, level (0..7), now }]: n bars over 24 h, sampled at each bar's centre
 *   stripRects(bars, cellWDev, cellHDev) -> [{ x, y, w, h, color, now }] device px from the bars' first cell
 *   stripLabels(sun, clock24) -> { rise, set } ('7:27' / '07:27'; '' when sun is null)
 *   stripLine(n, labels) -> line of n + 14 cells: [rise in 5] [2] [n blank cells for the bars] [2] [set in 5], the
 *     rise time from the first cell and the set time up to the last, so both sit flush with the column's edges
 *
 * The column's own lines (the console and the still share them; they always return runs of this kit):
 *   wordsThatFit(text, room) -> the longest run of whole words of text that fits room cells ('' when not even the
 *     first word fits; a trailing , or ; goes)
 *   toRun(run | [text, 'role bold', href]) -> run   toLine(runs) -> line   (PCD.greet's array runs into kit runs)
 *   statusLine(statusView, width?) -> line | null   the clock-status line from a PCD.status.describe()
 *     view: '⌂ ' and the parts without the leading 'pixelclock' segment, joined by ' · '; glyph and separators frame,
 *     words muted, the time text; ringing (kind 'ringing' or tone 'accent'): glyph and words accent. width cuts the
 *     alarm label (the last part) to whole words, or drops it with its ' · '; the part with the time is never cut
 *   greetLine(PCD.greet.parts(date, PC), width?) -> line   the greeting's runs; a holiday line longer than width
 *     falls back to the plain 'good afternoon.' (the holiday line is the add-on)
 *
 * Copy is lower case and short; every glyph is in the safe set of tools/lib/glyphs.mjs (tests check every builder).
 */
(function (root, factory) {
  var api = factory(root.PCD || (root.PCD = {}), root);
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (PCD, root) {
  'use strict';

  // ------------------------------------------------------------------------------------------------ tokens, colour

  /** The palette (the clock's style.css, plus frame and faint); design/tokens.json is the source. */
  var TOKENS = {
    bg: 0x141016, panel: 0x1d181f, field: 0x2a2229, line: 0x3a3138, text: 0xece4d8, muted: 0xa99d91,
    faint: 0x978d83, accent: 0xff9a3c, frame: 0x9a6a40, ring: 0xc47a2c, wood: 0x6b4428, woodDark: 0x4a2e1a
  };
  var TONES = ['text', 'muted', 'faint', 'accent', 'frame', 'ring', 'wood', 'clock'];
  /** Tone -> a short CSS class; bold adds 'tt'. */
  var CLASSES = { text: 'tx', muted: 'mu', faint: 'fa', accent: 'ac', frame: 'fr', ring: 'rg', wood: 'wd', clock: 'ck',
    field: 'fld' };
  var GLYPHS = {
    tl: '╭', tr: '╮', bl: '╰', br: '╯', h: '─', v: '│', lt: '├', rt: '┤', shade: '░', caret: '▌', prompt: '›',
    link: '»', dot: '·', home: '⌂', sun: '☼', menu: '≡', down: '↓', bullet: '•', degree: '°'
  };
  var CHARS = '╭╮╰╯─│├┤░▌›»·⌂☼≡↓•°';

  function parseColor(v) {
    if (typeof v === 'number' && isFinite(v)) return v >>> 0;
    var m = /^#?([0-9a-fA-F]{6})$/.exec(String(v == null ? '' : v).trim());
    return m ? parseInt(m[1], 16) : null;
  }

  /** A token as 0xRRGGBB: PCD.TOKENS (generated from design/tokens.json) when it has it, else the built-in value. */
  function token(name) {
    var t = PCD.TOKENS;
    if (t && typeof t === 'object') {
      var v = t[name];
      if (v === undefined && t.colors && typeof t.colors === 'object') v = t.colors[name];
      if (v === undefined && name === 'woodDark') v = t['wood-dark'];
      if (v && typeof v === 'object' && v.value !== undefined) v = v.value;
      var c = parseColor(v);
      if (c !== null) return c;
    }
    return TOKENS[name];
  }

  function clamp01(t) {
    var n = Number(t);
    return n < 0 ? 0 : n > 1 ? 1 : isFinite(n) ? n : 0;
  }

  /** Linear sRGB blend from a to b, rounded per channel like the engine's PC.mix. */
  function mix(a, b, t) {
    var k = clamp01(t);
    var r = Math.round(((a >> 16) & 255) + ((((b >> 16) & 255) - ((a >> 16) & 255)) * k));
    var g = Math.round(((a >> 8) & 255) + ((((b >> 8) & 255) - ((a >> 8) & 255)) * k));
    var bl = Math.round((a & 255) + (((b & 255) - (a & 255)) * k));
    return ((r << 16) | (g << 8) | bl) >>> 0;
  }

  function lin(v) {
    var x = v / 255;
    return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
  }

  function luminance(c) {
    return 0.2126 * lin((c >> 16) & 255) + 0.7152 * lin((c >> 8) & 255) + 0.0722 * lin(c & 255);
  }

  /** WCAG contrast ratio of two 0xRRGGBB colours. */
  function contrast(a, b) {
    var x = luminance(a) + 0.05;
    var y = luminance(b) + 0.05;
    return x > y ? x / y : y / x;
  }

  function hex(c) {
    var s = ((Number(c) >>> 0) & 0xffffff).toString(16);
    while (s.length < 6) s = '0' + s;
    return '#' + s;
  }

  /** The big clock's colour: the theme's clock colour softened toward text, or text when that reads too faint. */
  function clockColor(themeClock) {
    var text = token('text');
    var c = parseColor(themeClock);
    if (c === null) return text;
    var m = mix(c, text, 0.25);
    return contrast(m, token('bg')) >= 4.5 ? m : text;
  }

  /** A strip bar's colour at light level v (0..1). */
  function barColor(v) {
    return mix(token('line'), token('wood'), Math.min(1, 1.4 * clamp01(v)));
  }

  // ------------------------------------------------------------------------------------------------ runs

  function rep(ch, n) {
    var s = '';
    for (var i = 0; i < n; i++) s += ch;
    return s;
  }

  /** A run: { text, tone, bold, href }. */
  function run(text, tone, opts) {
    var o = opts || {};
    var r = { text: text == null ? '' : String(text), tone: tone || null, bold: !!o.bold };
    if (o.href) r.href = String(o.href);
    return r;
  }

  function toRuns(x, tone) {
    if (x == null || x === '') return [];
    if (typeof x === 'string') return [run(x, tone || 'muted')];
    if (Array.isArray(x)) return x.filter(Boolean);
    return [x];
  }

  /** Cells taken by a line (every glyph the kit uses is one cell wide). */
  function width(runs) {
    var n = 0;
    for (var i = 0; i < runs.length; i++) n += runs[i].text.length;
    return n;
  }

  function cut(runs, w) {
    var out = [];
    var n = 0;
    for (var i = 0; i < runs.length && n < w; i++) {
      var r = runs[i];
      var t = r.text;
      if (n + t.length > w) t = t.slice(0, w - n);
      if (t.length) out.push(t === r.text ? r : copyRun(r, t));
      n += t.length;
    }
    return out;
  }

  function copyRun(r, text) {
    var c = { text: text, tone: r.tone, bold: r.bold };
    if (r.href) c.href = r.href;
    return c;
  }

  /** A line cut or padded with plain spaces to exactly w cells. */
  function fit(runs, w) {
    var out = cut(runs || [], w);
    var n = width(out);
    if (n < w) out.push(run(rep(' ', w - n)));
    return out;
  }

  function merge(runs) {
    var out = [];
    for (var i = 0; i < runs.length; i++) {
      var r = runs[i];
      if (!r.text.length) continue;
      var last = out[out.length - 1];
      if (last && last.tone === r.tone && last.bold === r.bold && !last.href && !r.href) last.text += r.text;
      else out.push(copyRun(r, r.text));
    }
    return out;
  }

  /** The text of every line (tests, the still's atlas blit). */
  function plain(block) {
    return (block || []).map(function (line) {
      var s = '';
      for (var i = 0; i < line.length; i++) s += line[i].text;
      return s;
    });
  }

  function className(r) {
    var c = r && r.tone ? CLASSES[r.tone] || '' : '';
    if (r && r.bold) c = c ? c + ' tt' : 'tt';
    return c;
  }

  /**
   * Render a block into an element (a <pre>): text nodes for plain runs, spans for toned runs, links for runs with
   * an href. opts: { className: fn(run) -> class string (default className), doc }. textContent only.
   */
  function fill(el, block, opts) {
    var o = opts || {};
    var doc = o.doc || el.ownerDocument || root.document;
    var cls = typeof o.className === 'function' ? o.className : className;
    while (el.firstChild) el.removeChild(el.firstChild);
    (block || []).forEach(function (line, i) {
      if (i) el.appendChild(doc.createTextNode('\n'));
      for (var j = 0; j < line.length; j++) {
        var r = line[j];
        var c = cls(r);
        if (!c && !r.href) {
          el.appendChild(doc.createTextNode(r.text));
          continue;
        }
        var s = doc.createElement(r.href ? 'a' : 'span');
        if (c) s.className = c;
        if (r.href) s.setAttribute('href', r.href);
        s.textContent = r.text;
        el.appendChild(s);
      }
    });
    return el;
  }

  // ------------------------------------------------------------------------------------------------ border lines

  /**
   * One border line w cells wide: cornerL, one line char, ' left ', line chars, ' right ', one line char, cornerR
   * (the style tile's section rules). Labels are runs (or strings, then muted). The left label is cut first, then the
   * right one is dropped, so the line keeps at least one line char between them.
   */
  function edge(cornerL, cornerR, w, left, right, opts) {
    var o = opts || {};
    var tone = o.lineTone || 'frame';
    var L = toRuns(left);
    var R = toRuns(right);
    if (w < 2) return fit([run(cornerL, tone)], Math.max(0, w));
    if (w < 4) return [run(cornerL + rep(GLYPHS.h, w - 2) + cornerR, tone)];
    function used() { return 4 + (L.length ? width(L) + 2 : 0) + (R.length ? width(R) + 2 : 0); }
    if (used() > w - 1 && L.length) {
      var room = w - 1 - 4 - (R.length ? width(R) + 2 : 0) - 2;
      L = room >= 1 ? cut(L, room) : [];
    }
    if (used() > w - 1 && R.length) R = [];
    if (used() > w - 1) L = [];
    var out = [run(cornerL + GLYPHS.h, tone)];
    if (L.length) out = out.concat([run(' ')], L, [run(' ')]);
    out.push(run(rep(GLYPHS.h, Math.max(0, w - used())), tone));
    if (R.length) out = out.concat([run(' ')], R, [run(' ')]);
    out.push(run(GLYPHS.h + cornerR, tone));
    return merge(fit(out, w));
  }

  // ------------------------------------------------------------------------------------------------ the big clock

  var digitCache = {};

  function engine(PC) {
    var pc = PC || root.PixelClock;
    if (!pc || typeof pc.drawDigit !== 'function' || typeof pc.Canvas !== 'function') {
      throw new Error('PCD.ascii: the PixelClock engine is not loaded (vendor engine.js)');
    }
    return pc;
  }

  /** The clock's own 3x5 bits for digit d (row-major, 15 values 0/1), drawn with PC.drawDigit at scale 1. */
  function digitBits(d, PC) {
    var pc = engine(PC);
    var key = String(d);
    if (!digitCache[key] || digitCache[key].pc !== pc) {
      var cv = new pc.Canvas(3, 5);
      pc.drawDigit(cv, d, 0, 0, 1, 1);
      var bits = [];
      for (var i = 0; i < 15; i++) bits.push(cv.px[i] ? 1 : 0);
      digitCache[key] = { pc: pc, bits: bits };
    }
    return digitCache[key].bits.slice();
  }

  function blank(W) {
    var lit = [];
    for (var y = 0; y < 5; y++) {
      var row = [];
      for (var x = 0; x < W; x++) row.push(0);
      lit.push(row);
    }
    return lit;
  }

  function stamp(lit, bits, x0) {
    for (var i = 0; i < 15; i++) if (bits[i]) lit[Math.floor(i / 3)][x0 + (i % 3)] = 1;
  }

  /** The '░░' shadow: a cell pair is shaded where the pixel one up and one left is lit and the pixel itself is not. */
  function shadowBlock(lit, W) {
    var block = [];
    for (var y = 0; y < 6; y++) {
      var line = [];
      for (var x = 0; x <= W; x++) {
        var on = y < 5 && x < W ? lit[y][x] : 0;
        var sh = y >= 1 && x >= 1 ? lit[y - 1][x - 1] : 0;
        line.push(!on && sh ? run(GLYPHS.shade + GLYPHS.shade, 'wood') : run('  '));
      }
      block.push(merge(line));
    }
    return block;
  }

  /**
   * The big clock: HH:MM in the clock's digits. Digits sit one pixel apart, the colon is drawTime's (one column, rows 1
   * and 3); 12 h hides the leading zero like drawTime. colon: false leaves the colon dark (the blink); the shadow
   * always includes it, so the text layer only changes once a minute.
   */
  function clockFace(hours, minutes, opts) {
    var o = opts || {};
    var pc = engine(o.PC);
    var h24 = ((Math.floor(Number(hours)) % 24) + 24) % 24;
    var mm = ((Math.floor(Number(minutes)) % 60) + 60) % 60;
    var h = o.clock24 ? h24 : h24 % 12 || 12;
    var ds = [Math.floor(h / 10), h % 10, Math.floor(mm / 10), mm % 10];
    var hideLead = !o.clock24 && ds[0] === 0;
    var items = [];
    if (!hideLead) items.push(['d', ds[0]], ['g']);
    items.push(['d', ds[1]], ['g'], ['c'], ['g'], ['d', ds[2]], ['g'], ['d', ds[3]]);
    var W = 0;
    items.forEach(function (it) { W += it[0] === 'd' ? 3 : 1; });
    var lit = blank(W);
    var x0 = 0;
    var colonX = -1;
    items.forEach(function (it) {
      if (it[0] === 'd') {
        stamp(lit, digitBits(it[1], pc), x0);
        x0 += 3;
      } else {
        if (it[0] === 'c') colonX = x0;
        x0 += 1;
      }
    });
    var withColon = lit.map(function (row) { return row.slice(); });
    withColon[1][colonX] = 2;
    withColon[3][colonX] = 2;
    var colonOn = o.colon !== false;
    var face = {
      kind: 'time',
      compact: !!o.compact,
      W: W,
      lit: colonOn ? withColon : lit,
      colon: [{ x: colonX, y: 1 }, { x: colonX, y: 3 }],
      cols: o.compact ? W : (W + 1) * 2,
      rows: o.compact ? 3 : 6,
      shadow: o.compact ? [] : shadowBlock(withColon, W),
      ampm: o.clock24 ? '' : h24 < 12 ? 'am' : 'pm'
    };
    face.ampmAt = o.compact ? { c: W + 1, r: 2 } : { c: (W + 1) * 2 + 1, r: 4 };
    return face;
  }

  /** The still's calendar face (the day of the month; the month and weekday go beside it). */
  function dayFace(day, opts) {
    var o = opts || {};
    var pc = engine(o.PC);
    var n = Math.max(1, Math.min(31, Math.floor(Number(day)) || 1));
    var ds = n >= 10 ? [Math.floor(n / 10), n % 10] : [n];
    var W = ds.length * 4 - 1;
    var lit = blank(W);
    ds.forEach(function (d, i) { stamp(lit, digitBits(d, pc), i * 4); });
    return {
      kind: 'day',
      compact: !!o.compact,
      W: W,
      lit: lit,
      colon: [],
      cols: o.compact ? W : (W + 1) * 2,
      rows: o.compact ? 3 : 6,
      shadow: o.compact ? [] : shadowBlock(lit, W),
      ampm: '',
      ampmAt: null,
      labelsAt: { c: o.compact ? W + 2 : W * 2 + 4, monthRow: o.compact ? 0 : 1, weekdayRow: o.compact ? 2 : 4 }
    };
  }

  /**
   * Device-px rects of a face's lit pixels from its top-left cell: 2 cells x 1 row each (compact: 1 cell x half a
   * row). The colon pixels carry colon: true and tone 'accent' so the console can draw them as two separate elements.
   */
  function faceRects(face, cellWDev, cellHDev) {
    var cw = Math.max(1, Math.round(cellWDev));
    var ch = Math.max(1, Math.round(cellHDev));
    var pw = face.compact ? cw : 2 * cw;
    var ph = face.compact ? Math.max(1, Math.round(ch / 2)) : ch;
    var out = [];
    for (var y = 0; y < 5; y++) {
      for (var x = 0; x < face.W; x++) {
        var a = face.lit[y][x];
        if (!a) continue;
        out.push({ x: x * pw, y: y * ph, w: pw, h: ph, tone: a === 2 ? 'accent' : 'clock', colon: a === 2 });
      }
    }
    return out;
  }

  // ------------------------------------------------------------------------------------------------ weather

  /** The weather icons: plain ASCII, 4 rows of exactly 11 characters. */
  var CLOUD = ['    .--.   ', ' .-(    ). ', '(___.__)__)'];
  var CLOUD_KEY = ['    cccc   ', ' cccccccccc', 'ccccccccccc'];
  var ICONS = {
    'clear-day': ['   \\ | /   ', '  -- O --  ', '   / | \\   ', '           '],
    'clear-night': ['   .--.  · ', '  (    )   ', "   `--'  · ", '           '],
    'partly-day': ['  \\  /     ', ' -- .--.   ', ' .-(    ). ', '(___.__)__)'],
    'partly-night': [' ·  .--.   ', ' .-(    ). ', '(___.__)__)', '        ·  '],
    cloudy: [CLOUD[0], CLOUD[1], CLOUD[2], '           '],
    fog: [' _ - _ - _ ', '  - _ - _ -', ' _ - _ - _ ', '           '],
    drizzle: [CLOUD[0], CLOUD[1], CLOUD[2], "  ' ' ' '  "],
    rain: [CLOUD[0], CLOUD[1], CLOUD[2], '  / / / /  '],
    freezing: [CLOUD[0], CLOUD[1], CLOUD[2], '  * / * /  '],
    snow: [CLOUD[0], CLOUD[1], CLOUD[2], '  *  *  *  '],
    thunder: [CLOUD[0], CLOUD[1], CLOUD[2], '   _/  _/  '],
    unknown: ['           ', '   .---.   ', '   | ? |   ', "   '---'   "]
  };
  /** What each icon character is: c cloud, s sun, m moon, p precipitation, d star, f fog, b bolt, q unknown. */
  var ICON_KEYS = {
    'clear-day': ['   s s s   ', '  ss s ss  ', '   s s s   ', '           '],
    'clear-night': ['   mmmm  d ', '  m    m   ', '   mmmm  d ', '           '],
    'partly-day': ['  s  s     ', ' ss cccc   ', ' cccccccccc', 'ccccccccccc'],
    'partly-night': [' d  cccc   ', ' cccccccccc', 'ccccccccccc', '        d  '],
    cloudy: [CLOUD_KEY[0], CLOUD_KEY[1], CLOUD_KEY[2], '           '],
    fog: [' f f f f f ', '  f f f f f', ' f f f f f ', '           '],
    drizzle: [CLOUD_KEY[0], CLOUD_KEY[1], CLOUD_KEY[2], '  p p p p  '],
    rain: [CLOUD_KEY[0], CLOUD_KEY[1], CLOUD_KEY[2], '  p p p p  '],
    freezing: [CLOUD_KEY[0], CLOUD_KEY[1], CLOUD_KEY[2], '  p p p p  '],
    snow: [CLOUD_KEY[0], CLOUD_KEY[1], CLOUD_KEY[2], '  p  p  p  '],
    thunder: [CLOUD_KEY[0], CLOUD_KEY[1], CLOUD_KEY[2], '   bb  bb  '],
    unknown: ['           ', '   qqqqq   ', '   q q q   ', '   qqqqq   ']
  };
  var ICON_TONES = { c: 'muted', s: 'ring', m: 'text', p: 'text', d: 'faint', f: 'muted', b: 'ring', q: 'muted' };

  /** The icon for a weather kind (PCD.weather KINDS): the day variants between sunrise and sunset. */
  function iconKey(kind, isDay) {
    if (kind === 'clear') return isDay === false ? 'clear-night' : 'clear-day';
    if (kind === 'partly') return isDay === false ? 'partly-night' : 'partly-day';
    return typeof kind === 'string' && Object.prototype.hasOwnProperty.call(ICONS, kind) ? kind : 'unknown';
  }

  /** An icon as a block: 4 lines of exactly 11 cells, each character in its role's tone. */
  function icon(key) {
    var k = Object.prototype.hasOwnProperty.call(ICONS, key) ? key : 'unknown';
    var art = ICONS[k];
    var keys = ICON_KEYS[k];
    var block = [];
    for (var r = 0; r < 4; r++) {
      var line = [];
      for (var i = 0; i < 11; i++) {
        var ch = art[r].charAt(i);
        line.push(run(ch, ch === ' ' ? null : ICON_TONES[keys[r].charAt(i)] || 'muted'));
      }
      block.push(merge(line));
    }
    return block;
  }

  // ------------------------------------------------------------------------------------------------ the sun strip

  /**
   * The daylight strip: n bars over 24 h (wall-clock hours), each sampled from the 48-value light curve at the bar's
   * centre; level = round(7 v) (0..7: the bar is (level + 1) / 8 of the bar area); the bar holding nowH is `now`.
   */
  function strip(curve, n, nowH) {
    var c = Array.isArray(curve) && curve.length === 48 ? curve : null;
    var count = Math.max(0, Math.floor(Number(n)) || 0);
    var out = [];
    if (!count) return out;
    var h = Number(nowH);
    var nowCell = isFinite(h) ? Math.min(count - 1, Math.max(0, Math.floor((((h % 24) + 24) % 24) / 24 * count))) : -1;
    for (var i = 0; i < count; i++) {
      var hh = (i + 0.5) / count * 24;
      var j = Math.min(47, Math.floor(hh * 2));
      var v = c ? clamp01(c[j]) : 0;
      out.push({ v: v, level: Math.max(0, Math.min(7, Math.round(v * 7))), now: i === nowCell });
    }
    return out;
  }

  /**
   * Device-px rects of the bars from the first bar cell: each one cell wide, touching; the bar area is 0.66 of the
   * cell height with its bottom at 0.8 (the text baseline); a bar is (level + 1) / 8 of it; the "now" bar is full
   * height in accent.
   */
  function stripRects(bars, cellWDev, cellHDev) {
    var cw = Math.max(1, Math.round(cellWDev));
    var ch = Math.max(1, Math.round(cellHDev));
    var bottom = Math.round(ch * 0.8);
    var maxH = Math.max(1, Math.round(ch * 0.66));
    var accent = token('accent');
    return (bars || []).map(function (b, i) {
      var h = b.now ? maxH : Math.max(1, Math.round((b.level + 1) / 8 * maxH));
      return { x: i * cw, y: bottom - h, w: cw, h: h, color: b.now ? accent : barColor(b.v), now: !!b.now };
    });
  }

  function hm(h, clock24) {
    var x = Number(h);
    if (!isFinite(x)) return '';
    var m = Math.round((((x % 24) + 24) % 24) * 60) % 1440;
    var hh = Math.floor(m / 60);
    var mm = m % 60;
    var ms = (mm < 10 ? '0' : '') + mm;
    if (clock24) return (hh < 10 ? '0' : '') + hh + ':' + ms;
    return (hh % 12 || 12) + ':' + ms;
  }

  /** The strip's end labels from real sun times ({ rise, set } in wall-clock hours); blank without them. */
  function stripLabels(sun, clock24) {
    if (!sun || typeof sun.rise !== 'number' || typeof sun.set !== 'number') return { rise: '', set: '' };
    return { rise: hm(sun.rise, clock24), set: hm(sun.set, clock24) };
  }

  /**
   * The strip's text row, n + 14 cells: [rise in 5] [2] [n cells left blank for the bars] [2] [set in 5]. The rise time
   * starts at the row's first cell and the set time ends at its last, so both line up with the column's edges in 12 h
   * ('7:27') as in 24 h ('07:27').
   */
  function stripLine(n, labels) {
    var l = labels || {};
    var rise = String(l.rise || '').slice(0, 5);
    var set = String(l.set || '').slice(0, 5);
    var line = [];
    if (rise) line.push(run(rise, 'faint'));
    line.push(run(rep(' ', (5 - rise.length) + 2 + Math.max(0, n) + 2 + (5 - set.length))));
    if (set) line.push(run(set, 'faint'));
    return merge(line);
  }

  // ------------------------------------------------------------------------------------------------ the column's lines

  var SEP = ' ' + GLYPHS.dot + ' ';

  /** The longest run of whole words of `text` that fits `room` cells; '' when not even the first word fits. */
  function wordsThatFit(text, room) {
    var words = String(text == null ? '' : text).replace(/\s+/g, ' ').trim().split(' ');
    var out = '';
    for (var i = 0; i < words.length && words[i]; i++) {
      var next = out ? out + ' ' + words[i] : words[i];
      if (next.length > room) break;
      out = next;
    }
    return out.replace(/[,;]+$/, '');
  }

  /** A kit run from either form: { text, tone, bold, href } or [text, 'role bold', href] (PCD.greet's runs). */
  function toRun(r) {
    if (!Array.isArray(r)) return r && typeof r.text === 'string' ? r : run('', null);
    var roles = String(r[1] || '').split(/\s+/).filter(Boolean);
    var tone = roles.filter(function (x) { return x !== 'bold'; })[0] || null;
    return run(r[0] == null ? '' : r[0], tone, { bold: roles.indexOf('bold') >= 0, href: r[2] });
  }

  function toLine(runs) {
    return (runs || []).map(toRun);
  }

  /**
   * The clock-status line from a PCD.status.describe() view ({ show, kind, tone, parts, time }); null when
   * there is nothing to show. width (cells, optional): the alarm label is cut to whole words, or left out with its
   * ' · ', so the line never runs past the column; the part with the time is never cut.
   */
  function statusLine(st, w) {
    if (!st || !st.show || !Array.isArray(st.parts)) return null;
    var parts = st.parts[0] === 'pixelclock' ? st.parts.slice(1) : st.parts.slice();
    if (!parts.length) return null;
    parts = parts.map(function (p) { return String(p); });
    if (w > 0 && parts.length > 1 && ('⌂ ' + parts.join(SEP)).length > w) {
      var head = ('⌂ ' + parts.slice(0, -1).join(SEP)).length;
      var label = wordsThatFit(parts[parts.length - 1], w - head - SEP.length);
      if (label) parts[parts.length - 1] = label;
      else parts.pop();
    }
    var hot = st.kind === 'ringing' || st.tone === 'accent';
    var word = hot ? 'accent' : 'muted';
    var line = [run('⌂ ', hot ? 'accent' : 'frame')];
    parts.forEach(function (s, i) {
      if (i) {
        line.push(run(SEP, 'frame'), run(s, word));
        return;
      }
      var at = st.time ? s.lastIndexOf(st.time) : -1;
      if (at < 0) {
        line.push(run(s, word));
        return;
      }
      if (at > 0) line.push(run(s.slice(0, at), word));
      line.push(run(st.time, hot ? 'accent' : 'text'));
      if (at + st.time.length < s.length) line.push(run(s.slice(at + st.time.length), word));
    });
    return line;
  }

  /** The greeting's runs (a PCD.greet.parts() result) within `width` cells (a long holiday line falls back). */
  function greetLine(gp, w) {
    if (!gp || !Array.isArray(gp.runs)) return [];
    if (w > 0 && gp.holiday && String(gp.text).length > w) return [run(gp.word + '.', 'text', { bold: true })];
    return toLine(gp.runs);
  }

  var api = {
    TOKENS: TOKENS,
    TONES: TONES,
    CLASSES: CLASSES,
    GLYPHS: GLYPHS,
    CHARS: CHARS,
    ICONS: ICONS,
    ICON_KEYS: ICON_KEYS,
    ICON_TONES: ICON_TONES,
    token: token,
    mix: mix,
    contrast: contrast,
    hex: hex,
    clockColor: clockColor,
    barColor: barColor,
    run: run,
    width: width,
    fit: fit,
    plain: plain,
    className: className,
    fill: fill,
    edge: edge,
    digitBits: digitBits,
    clockFace: clockFace,
    dayFace: dayFace,
    faceRects: faceRects,
    iconKey: iconKey,
    icon: icon,
    strip: strip,
    stripRects: stripRects,
    stripLabels: stripLabels,
    stripLine: stripLine,
    wordsThatFit: wordsThatFit,
    toRun: toRun,
    toLine: toLine,
    statusLine: statusLine,
    greetLine: greetLine
  };
  PCD.ascii = api;
  return api;
});
