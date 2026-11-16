/* PixelClock Desktop shared: the type ladder and the text cell.
 * Classic script, UMD, global PCD (PCD.layout). Pure: no DOM, no timers, no screen.*; the same file runs in the pages
 * (new tab, wallpaper) and in Node (the still renderer, the tests). The console (PCD.console) and the scene layer
 * (PCD.bleed) lay every screen out from these: one font size per screen, cells in whole device px.
 *
 * API:
 *   PCD.layout.fontStep(cssH, dpr, profile = 'wallpaper') -> the ladder step (device px) for the screen
 *   PCD.layout.minStep(profile, dpr), PCD.layout.steps(profile, dpr) (the allowed steps, largest first)
 *   PCD.layout.termCell(step, dpr) -> the TermMono cell at a step (whole device px; see below)
 *   PCD.layout.cellFrom(adv, natural, dpr) -> a cell from a measured advance and line height (floored to
 *     whole device px, with the letter-spacing correction ls = w - adv)
 *   PCD.layout.LADDER, DIVISORS
 * profile: 'newtab' | 'wallpaper' | 'still'.
 *
 * The rules:
 *   - Type: one size per screen, the ladder step nearest cssH x dpr / div, ties to the smaller step. Wallpaper and
 *     still: div 48, ladder 16..64 (the atlas sizes). New tab: div 44, the ladder from 14, never under 12 CSS px.
 *   - Cells: whole device px (floored), so every grid line starts on a whole device pixel.
 *
 * Why termCell() is exact: Chrome on Windows lays text out at the device size (zoom for DSF), so a TermMono cell in
 * device px depends only on the step: advance floor(step x 1200 / 2048) (Cascadia Mono's 1200-unit advance on a
 * 2048-unit em) and line height round(step x 1900 / 2048) + round(step x 480 / 2048) (ascent and descent rounded
 * separately). Measured in headless Chrome 157 at DPR 1, 1.25, 1.5 and 2 for every step from 12 to 64 (36 -> 21 x 41
 * device px, so 18 px at DPR 2 is 10.5 x 20.5 CSS px).
 */
(function (root, factory) {
  var api = factory(root.PCD || (root.PCD = {}));
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (PCD) {
  'use strict';

  /** Font sizes in device px. The wallpaper and the still start at 16 (the atlas sizes); the new tab adds 14. */
  var LADDER = [14, 16, 20, 24, 28, 32, 36, 40, 48, 56, 64];
  var DIVISORS = { newtab: 44, wallpaper: 48, still: 48 };
  /** Cascadia Mono (TermMono): units per em, advance, ascent and descent (hhea and OS/2 typo metrics agree). */
  var EM = 2048;
  var ADVANCE = 1200;
  var ASCENT = 1900;
  var DESCENT = 480;
  var EPS = 1e-9;

  function num(v, d) {
    var n = Number(v);
    return isFinite(n) ? n : d;
  }

  function profileOf(p) {
    return p === 'newtab' || p === 'still' ? p : 'wallpaper';
  }

  function dprOf(d) {
    var n = Number(d);
    return isFinite(n) && n > 0 ? n : 1;
  }

  /** The smallest step allowed: 16 on the wallpaper and the still; max(14, 12 CSS px) on the new tab. */
  function minStep(profile, dpr) {
    if (profileOf(profile) !== 'newtab') return 16;
    return Math.max(14, Math.ceil(12 * dprOf(dpr) - EPS));
  }

  /** The allowed ladder steps for a profile and DPR, largest first. */
  function steps(profile, dpr) {
    var lo = minStep(profile, dpr);
    var out = [];
    for (var i = LADDER.length - 1; i >= 0; i--) if (LADDER[i] >= lo) out.push(LADDER[i]);
    if (!out.length) out.push(LADDER[LADDER.length - 1]);
    return out;
  }

  /** The step nearest cssH x dpr / div; a tie goes to the smaller step. */
  function fontStep(cssH, dpr, profile) {
    var d = dprOf(dpr);
    var target = Math.max(0, num(cssH, 800)) * d / DIVISORS[profileOf(profile)];
    var lo = minStep(profile, d);
    var best = 0;
    for (var i = 0; i < LADDER.length; i++) {
      var s = LADDER[i];
      if (s < lo) continue;
      if (!best || Math.abs(s - target) < Math.abs(best - target) - EPS) best = s;
    }
    return best || LADDER[LADDER.length - 1];
  }

  /** A TermMono cell at a ladder step, as Chrome lays it out (see the header): whole device px. */
  function termCell(step, dpr) {
    var d = dprOf(dpr);
    var s = Math.max(1, num(step, 16));
    var adv = s * ADVANCE / EM;
    var wDev = Math.max(1, Math.floor(adv + EPS));
    var hDev = Math.max(1, Math.round(s * ASCENT / EM) + Math.round(s * DESCENT / EM));
    return { w: wDev / d, h: hDev / d, wDev: wDev, hDev: hDev, adv: adv / d, ls: (wDev - adv) / d, step: s, px: s / d };
  }

  /** A cell from a measured advance and natural line height (CSS px), floored to whole device px. */
  function cellFrom(adv, natural, dpr) {
    var d = dprOf(dpr);
    var a = Math.max(0, num(adv, 0));
    var n = Math.max(0, num(natural, 0));
    var wDev = Math.max(1, Math.floor(a * d + 1e-6));
    var hDev = Math.max(1, Math.floor(n * d + 1e-6));
    return { w: wDev / d, h: hDev / d, wDev: wDev, hDev: hDev, adv: a, ls: wDev / d - a };
  }

  var api = {
    LADDER: LADDER.slice(),
    DIVISORS: DIVISORS,
    fontStep: fontStep,
    minStep: minStep,
    steps: steps,
    termCell: termCell,
    cellFrom: cellFrom
  };
  PCD.layout = api;
  return api;
});
