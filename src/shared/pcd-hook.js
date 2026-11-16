/* PixelClock Desktop: the drawClock hook. Classic script, UMD, global PCD.
 *
 * Every theme's draw() ends with PC.drawClock(cv, ctx, color, shadow), looked up at call time. This file wraps
 * that one function, once, so the desktop can
 *   - run weather effects on the scene pixels before the clock is drawn (hook.before), so the clock stays on top,
 *   - keep the scene's own clock (mode 'device'), keep only its date corners (mode 'date': rows 56-63) or hide
 *     both (mode 'none'),
 *   - read the theme's clock colours (hook.colors) and the mean colour of the scene's outer ring (hook.edge).
 * The engine files are never edited. Load order: engine.js, this file, then schedule.js and the themes
 * (Node: require engine.js, then this file, then render.js, which reuses engine.js from the require cache).
 */
(function (root, factory) {
  var api = factory(root.PCD || (root.PCD = {}), root);
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (PCD, root) {
  'use strict';

  // Loaded twice (two script tags, or a second require): keep the first hook and its state; a PixelClock object
  // that is not wrapped yet (engine.js loaded again) gets wrapped, an already wrapped one is left alone.
  if (PCD.hook && PCD.hook.version === 1) {
    PCD.hook.install(root.PixelClock);
    return PCD.hook;
  }

  var MARK = '__pcdHook';
  var DATE_ROWS = 8; // the bottom 8 rows (56-63) hold the weekday and date corners
  var reported = {};

  function reportOnce(key, e) {
    if (reported[key]) return;
    reported[key] = true;
    if (typeof console !== 'undefined') console.error('[pcd-hook] ' + key + ' threw (reported once): ' + (e && e.stack ? e.stack : e));
  }

  // Mean colour of the outer ring of pixels (rows 0 and h-1, columns 0 and w-1) as 0xRRGGBB.
  function ringMean(cv) {
    var w = cv.w, h = cv.h, px = cv.px;
    var r = 0, g = 0, b = 0, n = 0, c, i, x, y;
    for (x = 0; x < w; x++) {
      c = px[x]; r += (c >> 16) & 255; g += (c >> 8) & 255; b += c & 255;
      c = px[(h - 1) * w + x]; r += (c >> 16) & 255; g += (c >> 8) & 255; b += c & 255;
      n += 2;
    }
    for (y = 1; y < h - 1; y++) {
      i = y * w;
      c = px[i]; r += (c >> 16) & 255; g += (c >> 8) & 255; b += c & 255;
      c = px[i + w - 1]; r += (c >> 16) & 255; g += (c >> 8) & 255; b += c & 255;
      n += 2;
    }
    if (!n) return 0;
    return ((Math.round(r / n) << 16) | (Math.round(g / n) << 8) | Math.round(b / n)) >>> 0;
  }

  var hook = {
    version: 1,
    /** 'device' (time + date), 'date' (only rows 56-63 of the original), 'none' (no clock at all). */
    mode: 'device',
    /** before(cv, ctx): called first, on the scene pixels only (weather effects). Errors are caught. */
    before: null,
    /** The theme's clock colours from its last call: { clock, shadow } (0xRRGGBB; shadow may be null). */
    colors: { clock: 0xffffff, shadow: null },
    /** Mean colour of the scene's outer ring from the last call (after before(), before the clock). */
    edge: 0x141016,
    /** drawClock calls seen (tests: exactly one per theme draw). */
    calls: 0,
    /** The PixelClock object the hook is installed on, and its unwrapped drawClock. */
    PC: null,
    original: null,
    MODES: ['device', 'date', 'none'],
    ringMean: ringMean,
    install: install,
    uninstall: uninstall,
    isInstalled: isInstalled
  };

  /** True when PC.drawClock is this hook's wrapper. */
  function isInstalled(PC) {
    PC = PC || root.PixelClock;
    return !!(PC && typeof PC.drawClock === 'function' && PC.drawClock[MARK]);
  }

  /**
   * Wrap PC.drawClock (default: globalThis.PixelClock). Returns true when installed now, false when there is
   * nothing to wrap or it is already wrapped (a second install is refused).
   */
  function install(PC) {
    PC = PC || root.PixelClock;
    if (!PC || typeof PC.drawClock !== 'function' || typeof PC.Canvas !== 'function') return false;
    if (PC.drawClock[MARK]) return false;
    var original = PC.drawClock;
    var scratch = null;
    function drawClock(cv, ctx, color, shadow, y) {
      hook.calls++;
      hook.colors = { clock: color, shadow: shadow === undefined ? null : shadow };
      if (typeof hook.before === 'function') {
        try {
          hook.before(cv, ctx);
        } catch (e) {
          reportOnce('before()', e);
        }
      }
      hook.edge = ringMean(cv);
      var mode = hook.mode;
      if (mode === 'none') return undefined;
      if (mode === 'date') {
        if (!scratch || scratch.w !== cv.w || scratch.h !== cv.h) scratch = new PC.Canvas(cv.w, cv.h);
        scratch.px.set(cv.px);
        original.call(this, scratch, ctx, color, shadow, y);
        var from = Math.max(0, cv.h - DATE_ROWS) * cv.w;
        cv.px.set(scratch.px.subarray(from), from);
        return undefined;
      }
      return original.apply(this, arguments);
    }
    drawClock[MARK] = true;
    drawClock.original = original;
    PC.drawClock = drawClock;
    hook.PC = PC;
    hook.original = original;
    return true;
  }

  /** Restore the original drawClock (tests). Returns true when something was restored. */
  function uninstall(PC) {
    PC = PC || hook.PC || root.PixelClock;
    if (!PC || !PC.drawClock || !PC.drawClock[MARK]) return false;
    PC.drawClock = PC.drawClock.original;
    if (hook.PC === PC) { hook.PC = null; hook.original = null; }
    return true;
  }

  PCD.hook = hook;
  install(root.PixelClock);
  return hook;
});
