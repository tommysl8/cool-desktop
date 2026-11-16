/* PixelClock Desktop shared font: TermMono (the bundled Cascadia Mono variable font, SIL OFL 1.1, fonts/OFL.txt), the
 * one-size-per-screen ladder and the character cell. Classic script, UMD, global PCD; require() returns PCD.font in
 * Node, where the pure parts (ladder, step, cellFrom, glyphGate with a given ctx) work. PCD.TOKENS.type is read when
 * called (else DEFAULT_TYPE).
 *
 * Loading: FontFace.load() raced against a timeout (250 ms), then document.fonts.add() and document.fonts.ready.
 * document.fonts.check() and document.fonts.load() prove nothing for a FontFace that was never added. There is no
 * @font-face anywhere: this is the only place TermMono comes from. A page may preload the file with
 * <link rel="preload" href="fonts/CascadiaMono-wght.ttf" as="font" type="font/ttf" crossorigin> (FontFace requests are
 * CORS-mode, so the preload needs crossorigin to be reused).
 *
 * PCD.font
 *   FAMILY 'TermMono'  FALLBACK 'Consolas'  FILE 'CascadiaMono-wght.ttf'  STACK "TermMono, 'Cascadia Mono', Consolas, monospace"
 *   TIMEOUT_MS 250  M100 { cascadia: 58.59, consolas: 54.98 } ('M' at 100 px)  DEFAULT_TYPE (copy of tokens.json type)
 *   load(baseUrl = 'fonts/', { timeoutMs = 250, onLate }) -> Promise<info>, never rejects; repeated calls with the same
 *       base share one load (the first call's options count).
 *       info = { loaded, family: 'TermMono'|'Consolas', active: 'cascadia'|'consolas'|'other', mWidth100, ms, timedOut,
 *       late, error }: family is what load() settled on, active what the stack really renders ('cascadia' also when
 *       Windows has a local Cascadia Mono). Past the timeout the page carries on in the fallback (the scene never
 *       waits, the console measures the cell again). The font is added later only when onLate is given; onLate(info)
 *       then runs once, so the console re-measures and lays out again. Without onLate a grid measured in Consolas never
 *       changes font under the console.
 *   state()                            the last info (null before load() settles)
 *   mWidth100(family), classify(w), active(family)   which font really renders: 'cascadia'|'consolas'|'other'
 *   ladder(profile)                    the steps in device px: 'wallpaper' and 'still' 16..64, 'newtab' 14..64
 *   floorPx(profile, dpr)              the smallest step allowed: 16; new tab max(14, ceil(12 x dpr))
 *   step(cssH, dpr, profile)           the step nearest cssH x dpr / div (48; new tab 44), ties to the smaller, never
 *                                      under the floor (1280x800@2 new tab 36 = 18 CSS px, 1920x1080@1 wallpaper 24)
 *   smaller(stepPx, profile, dpr)      the next step down that is still allowed, or null (the layout's first fallback)
 *   cssPx(stepPx, dpr)                 stepPx / dpr
 *   cellFrom(advance, lineHeight, dpr) { w, h, ls, adv, natural, wDev, hDev, dpr }: w = floor(advance x dpr) / dpr,
 *                                      h = floor(lineHeight x dpr) / dpr, ls = w - advance (the letter-spacing that makes
 *                                      the advance exact): every glyph and box line starts on a device pixel
 *   measureCell({ host, sizePx, dpr, family, weight, doc })   cellFrom() of 10 rows of 100 'M' in a hidden <pre> with
 *                                      line-height normal, appended to host (default body; it inherits the host's font
 *                                      unless sizePx/family/weight are given); null without a DOM
 *   apply(el, cell, sizePx)            sets font-size and --cell-w, --cell-h, --cell-ls on el (pcd-base.css .pcd-g)
 *   glyphGate(chars, { families = [TermMono, Consolas], sizePx = 16, tolerance = 0.01, ctx })
 *                                      per family { family, sizePx, cellW, tested, pass, fails: [{ cp, ch, width, delta }] }:
 *                                      every character must satisfy |measureText(ch) - cellW| < tolerance
 */
(function (root, factory) {
  var api = factory(root.PCD || (root.PCD = {}), root);
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (PCD, root) {
  'use strict';

  var FAMILY = 'TermMono';
  var FALLBACK = 'Consolas';
  var FILE = 'CascadiaMono-wght.ttf';
  var STACK = "TermMono, 'Cascadia Mono', Consolas, monospace";
  var TIMEOUT_MS = 250;
  var M100 = { cascadia: 58.59, consolas: 54.98 };
  var M100_TOLERANCE = 0.5;
  /** The type table of design/tokens.json (tests keep this copy equal to it). */
  var DEFAULT_TYPE = {
    ladder: {
      wallpaper: [16, 20, 24, 28, 32, 36, 40, 48, 56, 64],
      still: [16, 20, 24, 28, 32, 36, 40, 48, 56, 64],
      newtab: [14, 16, 20, 24, 28, 32, 36, 40, 48, 56, 64]
    },
    div: { wallpaper: 48, still: 48, newtab: 44 },
    floor: { wallpaper: { device: 16, css: 0 }, still: { device: 16, css: 0 }, newtab: { device: 14, css: 12 } }
  };

  // ------------------------------------------------------------------------------------------------ which font

  var scratch = null;
  function scratchCtx() {
    if (scratch) return scratch;
    var doc = root.document;
    if (!doc || typeof doc.createElement !== 'function') return null;
    try {
      var c = doc.createElement('canvas');
      scratch = c && c.getContext ? c.getContext('2d') : null;
    } catch (e) {
      scratch = null;
    }
    return scratch;
  }

  function quoteFamily(family) {
    return /^[A-Za-z][A-Za-z0-9-]*$/.test(family) ? family : '"' + String(family).replace(/"/g, '') + '"';
  }

  /** measureText('M').width at 100 px for a family or a stack (null without a canvas). */
  function mWidth100(family, ctx) {
    var c = ctx || scratchCtx();
    if (!c) return null;
    var prev = c.font;
    c.font = '100px ' + (family || STACK);
    var w = c.measureText('M').width;
    c.font = prev;
    return w;
  }

  function classify(w) {
    if (typeof w !== 'number' || !isFinite(w)) return 'other';
    if (Math.abs(w - M100.cascadia) < M100_TOLERANCE) return 'cascadia';
    if (Math.abs(w - M100.consolas) < M100_TOLERANCE) return 'consolas';
    return 'other';
  }

  function active(family, ctx) {
    return classify(mWidth100(family || STACK, ctx));
  }

  // ------------------------------------------------------------------------------------------------ loading

  var loading = null;
  var loadingBase = null;
  var last = null;

  function message(e) {
    return String(e && e.message ? e.message : e);
  }

  function nowMs() {
    return root.performance && typeof root.performance.now === 'function' ? root.performance.now() : Date.now();
  }

  function load(baseUrl, opts) {
    var o = opts || {};
    var base = baseUrl === undefined || baseUrl === null ? 'fonts/' : String(baseUrl);
    if (base && base.charAt(base.length - 1) !== '/') base += '/';
    if (loading && loadingBase === base) return loading;
    loadingBase = base;
    var timeoutMs = o.timeoutMs === undefined ? TIMEOUT_MS : o.timeoutMs;
    var doc = o.doc || root.document;
    var FontFaceCtor = o.FontFace || root.FontFace;
    var t0 = nowMs();

    function info(loaded, family, extra) {
      // loaded: TermMono itself; else what the stack really renders (a local Cascadia Mono, else Consolas)
      var w = mWidth100(loaded ? family : STACK);
      var out = { loaded: loaded, family: family, active: classify(w), mWidth100: w, ms: Math.round(nowMs() - t0), timedOut: false, late: false, error: null };
      for (var k in extra) if (Object.prototype.hasOwnProperty.call(extra, k)) out[k] = extra[k];
      return out;
    }

    if (typeof FontFaceCtor !== 'function' || !doc || !doc.fonts || typeof doc.fonts.add !== 'function') {
      last = info(false, FALLBACK, { error: 'FontFace API unavailable' });
      loading = Promise.resolve(last);
      return loading;
    }

    loading = new Promise(function (resolve) {
      var settled = false;
      var timer = 0;
      var face;
      function settle(v) {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        last = v;
        resolve(v);
      }
      try {
        face = new FontFaceCtor(FAMILY, 'url("' + base + FILE + '") format("truetype")', { weight: '200 700', style: 'normal' });
      } catch (e) {
        settle(info(false, FALLBACK, { error: message(e) }));
        return;
      }
      if (timeoutMs > 0) {
        timer = setTimeout(function () {
          timer = 0;
          settle(info(false, FALLBACK, { timedOut: true, error: 'font load timed out after ' + timeoutMs + ' ms' }));
        }, timeoutMs);
      }
      var p;
      try {
        p = face.load();
      } catch (e) {
        settle(info(false, FALLBACK, { error: message(e) }));
        return;
      }
      Promise.resolve(p).then(function (loaded) {
        if (!settled) {
          // in time: stop the clock before adding, so a timeout can never report Consolas for a font that is in use
          if (timer) {
            clearTimeout(timer);
            timer = 0;
          }
          doc.fonts.add(loaded || face);
          return Promise.resolve(doc.fonts.ready).then(function () { settle(info(true, FAMILY, {})); });
        }
        if (typeof o.onLate !== 'function') return undefined;
        doc.fonts.add(loaded || face);
        return Promise.resolve(doc.fonts.ready).then(function () {
          last = info(true, FAMILY, { late: true });
          try {
            o.onLate(last);
          } catch (e) { /* the console's problem, not the font's */ }
        });
      }).then(null, function (e) {
        settle(info(false, FALLBACK, { error: message(e) }));
      });
    });
    return loading;
  }

  function state() {
    return last;
  }

  // ------------------------------------------------------------------------------------------------ the ladder

  function typeTable() {
    var T = PCD.TOKENS && PCD.TOKENS.type;
    return T && T.ladder && T.div && T.floor ? T : DEFAULT_TYPE;
  }

  function profileOf(profile) {
    return profile === 'newtab' || profile === 'still' ? profile : 'wallpaper';
  }

  function ladder(profile) {
    return typeTable().ladder[profileOf(profile)].slice();
  }

  function floorPx(profile, dpr) {
    var f = typeTable().floor[profileOf(profile)];
    var d = dpr > 0 ? dpr : 1;
    return Math.max(f.device, Math.ceil(f.css * d - 1e-9));
  }

  function step(cssH, dpr, profile) {
    var p = profileOf(profile);
    var T = typeTable();
    var d = dpr > 0 ? dpr : 1;
    var lad = T.ladder[p];
    var target = (cssH * d) / T.div[p];
    var min = floorPx(p, d);
    var best = 0;
    for (var i = 0; i < lad.length; i++) {
      var s = lad[i];
      if (s < min) continue;
      if (!best || Math.abs(s - target) < Math.abs(best - target) - 1e-9) best = s;
    }
    return best || lad[lad.length - 1];
  }

  function smaller(stepPx, profile, dpr) {
    var p = profileOf(profile);
    var lad = typeTable().ladder[p];
    var min = floorPx(p, dpr);
    for (var i = lad.length - 1; i >= 0; i--) if (lad[i] < stepPx && lad[i] >= min) return lad[i];
    return null;
  }

  function cssPx(stepPx, dpr) {
    return stepPx / (dpr > 0 ? dpr : 1);
  }

  // ------------------------------------------------------------------------------------------------ the cell

  function cellFrom(advance, lineHeight, dpr) {
    var d = dpr > 0 ? dpr : 1;
    var wDev = Math.max(1, Math.floor(advance * d + 1e-6));
    var hDev = Math.max(1, Math.floor(lineHeight * d + 1e-6));
    return { w: wDev / d, h: hDev / d, ls: wDev / d - advance, adv: advance, natural: lineHeight, wDev: wDev, hDev: hDev, dpr: d };
  }

  function measureCell(opts) {
    var o = opts || {};
    var doc = o.doc || root.document;
    if (!doc || typeof doc.createElement !== 'function') return null;
    var host = o.host || doc.body || doc.documentElement;
    if (!host || typeof host.appendChild !== 'function') return null;
    var dpr = o.dpr || root.devicePixelRatio || 1;
    var probe = doc.createElement('pre');
    // a <pre> gets font-family: monospace from the UA sheet: every font property is set here (inherit by default)
    probe.style.cssText = 'position:absolute;left:-99999px;top:0;margin:0;padding:0;border:0;visibility:hidden;' +
      'white-space:pre;line-height:normal;letter-spacing:0;word-spacing:0;font-style:normal;' +
      'font-family:' + (o.family || 'inherit') + ';font-size:' + (o.sizePx ? o.sizePx + 'px' : 'inherit') + ';' +
      'font-weight:' + (o.weight || 'inherit') + ';font-variant-ligatures:none;font-kerning:none;font-synthesis:none;';
    var row = new Array(101).join('M');
    var rows = [];
    for (var i = 0; i < 10; i++) rows.push(row);
    probe.textContent = rows.join('\n');
    host.appendChild(probe);
    var r = probe.getBoundingClientRect();
    host.removeChild(probe);
    if (!(r.width > 0) || !(r.height > 0)) return null;
    return cellFrom(r.width / 100, r.height / 10, dpr);
  }

  function apply(el, cell, sizePx) {
    if (!el || !el.style) return;
    if (sizePx) el.style.fontSize = sizePx + 'px';
    if (cell) {
      el.style.setProperty('--cell-w', cell.w + 'px');
      el.style.setProperty('--cell-h', cell.h + 'px');
      el.style.setProperty('--cell-ls', cell.ls + 'px');
    }
  }

  // ------------------------------------------------------------------------------------------------ the glyph gate

  function hexCp(cp) {
    var s = cp.toString(16).toUpperCase();
    while (s.length < 4) s = '0' + s;
    return 'U+' + s;
  }

  function glyphGate(chars, opts) {
    var o = opts || {};
    var families = o.families || [FAMILY, FALLBACK];
    var sizePx = o.sizePx || 16;
    var tolerance = o.tolerance === undefined ? 0.01 : o.tolerance;
    var ctx = o.ctx || scratchCtx();
    if (!ctx) throw new Error('PCD.font.glyphGate needs a canvas 2D context');
    var list = [];
    var seen = {};
    var s = String(chars == null ? '' : chars);
    for (var i = 0; i < s.length;) {
      var cp = s.codePointAt(i);
      var ch = String.fromCodePoint(cp);
      i += ch.length;
      if (ch === '\n' || ch === '\r' || ch === '\t' || seen[cp]) continue;
      seen[cp] = true;
      list.push(ch);
    }
    var prev = ctx.font;
    var results = families.map(function (family) {
      ctx.font = sizePx + 'px ' + quoteFamily(family);
      var cellW = ctx.measureText(new Array(65).join('M')).width / 64;
      var fails = [];
      list.forEach(function (c) {
        var w = ctx.measureText(c).width;
        var delta = w - cellW;
        if (!(Math.abs(delta) < tolerance)) fails.push({ cp: hexCp(c.codePointAt(0)), ch: c, width: w, delta: delta });
      });
      return { family: family, sizePx: sizePx, cellW: cellW, tested: list.length, pass: fails.length === 0, fails: fails };
    });
    ctx.font = prev;
    return results;
  }

  var api = {
    FAMILY: FAMILY,
    FALLBACK: FALLBACK,
    FILE: FILE,
    STACK: STACK,
    TIMEOUT_MS: TIMEOUT_MS,
    M100: M100,
    DEFAULT_TYPE: DEFAULT_TYPE,
    load: load,
    state: state,
    mWidth100: mWidth100,
    classify: classify,
    active: active,
    ladder: ladder,
    floorPx: floorPx,
    step: step,
    smaller: smaller,
    cssPx: cssPx,
    cellFrom: cellFrom,
    measureCell: measureCell,
    apply: apply,
    glyphGate: glyphGate
  };
  PCD.font = api;
  return api;
});
