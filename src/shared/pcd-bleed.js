/* PixelClock Desktop shared: the full-bleed scene layer. Classic script, UMD, global PCD (PCD.bleed). The core has no
 * DOM and runs in Node (the still renderer, the tests); mountScene() is the browser part the new tab and the wallpaper
 * share, so all three draw the same picture.
 *
 * The look: the clock's 64x64 scene fills the screen, scaled by a whole number k (every scene pixel is a k x k block of
 * device px), flush to the side away from the text column, and mixed toward bg (it keeps 60 % of its light at night and
 * 50 % on bright days). Where the screen is wider than the scene, each scene row continues as a band of its own main
 * colour (its sky, hill or ground, never a stretched object), softened vertically and a little darker, reached through a
 * short mirrored fade at the seam. A fixed gradient is dark across the column and gone about two thirds of the way
 * across the rest; a light band runs along the bottom; a soft shade sits behind the scene caption only. Three tiny
 * canvases (64x64, 1x64, up to 5x64) scaled by CSS with image-rendering: pixelated and one gradient element: no
 * full-screen canvas, no blur, no backdrop-filter, no timers (the host's frame loop calls draw()).
 *
 * Core (no DOM):
 *   PCD.bleed.fit(input) -> geo                          whole-device-px geometry
 *     input: { cssW, cssH, dpr = 1,
 *       side        'left' | 'right': the column's side (default 'left'; the new tab's column is on the left, the
 *                   wallpaper's and the still's on the right); the scene sits flush on the other side
 *       cell        { w, h }: the text cell in CSS px (default: PCD.layout.termCell at the console's font step: the step
 *                   for the height, or for 0.8 x the width on the new tab and 0.9 x on the others when that is less)
 *       profile     'newtab' | 'wallpaper' | 'still' (only for the default cell; default 'newtab' when side is left)
 *       reach       CSS px from the column's own screen edge to its far edge, margin included (the new tab's
 *                   (margin + cols) x cellW); default: columnRule() below, the console column
 *       bottomCss   the taskbar reserve (default 0): the scene runs under it, the column never does
 *       statusTop   CSS px: the top of the status row the bottom band leans on (default: the console's hint row,
 *                   the zone's second-to-last cell row, its last when the zone has under 18 rows; null: no status row)
 *       caption     { x, y, w, h } CSS px of the scene caption's text (the shade behind it), or null }
 *     geo: { cssW, cssH, dpr, Wd, Hd (device px), side, k, k0 (the smallest k covering the height), kMax (the largest
 *       k the 10 % crop allows), place ('flush', or 'crop' when the screen is narrower than the scene: cropped evenly),
 *       scene { x, y, size } (device px, integers; x, y <= 0 where the screen crops it), sceneCss { x, y, size },
 *       crop { top, bottom (device px cut off), rows (scene rows cut off), share (of the 64 rows), first, last (the
 *       first and last visible scene rows) }, edge ('left' | 'right' | null: the band's side, always the column's),
 *       band { x, y, w, h, cols: 1 } | null (device px: the 1x64 band canvas, stretched), fade { x, y, w, h, cols } |
 *       null (device px: the seam canvas, cols <= 5 scene px wide), edgeCols (scene px the band stands for),
 *       column { side, x, y, w, h (CSS px: the column's zone, from its screen edge to the reach, clear of the
 *       taskbar), xDev, yDev, wDev, hDev, reach, reachDev, bottom, cell { w, h }, rule (columnRule() when it chose the
 *       column, else null) }, statusTop, caption, gradient (gradient(geo)) }
 *   PCD.bleed.columnRule({ cssW, cell, side }) -> { C, margin, cols, c, x, w, reach }: the console column
 *     on the top-left cell grid: C = floor(cssW / cell.w) cells, margin 4 / 3 / 2 / 0 cells (C >= 100 / 60 / 24),
 *     cols = round(0.34 C) kept to 44..64 and inside the margins; c and x (CSS px) where its text starts
 *   PCD.bleed.meanLuma(frame) -> 0..255: the frame's light (every other pixel, 0.2126 R + 0.7152 G + 0.0722 B)
 *   PCD.bleed.dim(brightness, prev) -> the mix toward bg: 0.4 at night up to 0.5 on bright days
 *     (0.4 + 0.1 x smoothstep(30, 170, brightness)); brightness is a meanLuma() or a frame; prev, a mix from before,
 *     eases by 0.3 (the live page re-reads the frame every 15 frames; the still uses the plain value). The time of day
 *     is not an input: the dimming reads the picture's own light, so dawn, day, sunset and night follow from it.
 *   PCD.bleed.dimLut(mix) -> { r, g, b } (Uint8Array(256) each: v -> round(bg + (v - bg) x (1 - mix)))
 *   PCD.bleed.dimColor(c, mix) -> 0xRRGGBB;  PCD.bleed.dimFrame(frame, mix, out?) -> Uint32Array(4096) as painted
 *   PCD.bleed.bands(frame, opts) -> { rows, fadeLeft, fadeRight, cols, shown, state }
 *     rows: Uint32Array(64), each scene row's band colour (0xRRGGBB, as painted: the row's vote, see rowMode below, a
 *     median of 5 rows, a [1 2 1] pass, 16 % toward bg); fadeLeft / fadeRight:
 *     Uint32Array(64 x cols), the seam on each side, row-major, columns left to right as painted (the column next to
 *     the scene keeps 69 % of the scene's mirrored edge, the farthest 3 %); shown: the dimmed frame the bands read
 *     opts: { mix (the frame is raw: dim it first), state (a previous result's state: ease toward the new rows),
 *       snap (no easing), ease (default 0.12 per frame), cols (default 5) }
 *   PCD.bleed.gradient(geo, { statusTop, caption }) -> { color, width, height, side { dir (90 | 270), x1, rest,
 *     stops }, bottom { s, stops }, caption { cx, cy, rx, ry, stops } | null, css }: stops are { at, a } with at in
 *     CSS px from the column's screen edge (side), from the bottom edge (bottom) or 0..1 of the caption ellipse, and a
 *     the alpha of bg; css is the gradient element's background-image
 *   PCD.bleed.gradientAlpha(g, x, y) -> 0..1: the gradient over CSS point (x, y), its layers combined as the browser
 *     composites them (1 - (1 - side)(1 - bottom)(1 - caption))
 *   PCD.bleed.compose(img, geo, frame, opts) -> { img, mix, luma, rows }: the whole layer (scene, band, seam,
 *     dimming and gradient) drawn into the still's image { width: Wd, height: Hd, data } (3 channels, or 4 when data
 *     holds 4 per pixel; null makes a 3-channel image, a Buffer in Node); opts: { mix (default dim(frame)), veil
 *     (default true; false leaves the gradient out), gradient (default geo.gradient), channels }
 *   Constants: SCENE, MAX_CROP, TOP_SHARE, FADE, FADE_T, BAND_DIM, BAND_EASE, DIM_EASE, DIM_EVERY, BAND_EVERY, BG.
 *
 * Browser:
 *   PCD.bleed.mountScene(root, opts) -> layer
 *     opts: the fit() inputs kept between viewports (side, cell, profile, reach, bottomCss, statusTop, caption), plus
 *       doc, win, perfNow, style (default true: root becomes a fixed full-window box with the bg colour, z-index 0),
 *       pointer (default true: the pointer cursor over the scene)
 *     layer.canvas (the 64x64 scene canvas), layer.band (1x64), layer.fade (up to 5x64), layer.canvases ([band, scene,
 *       fade]) and layer.gradient (the gradient element, over the canvases, pointer-events none), in root in that
 *       order; every canvas is display: none until it has a frame and a place
 *     layer.setViewport(cssW, cssH, dpr, patch?) -> geo: lays out (fit) with the kept inputs (patch changes them),
 *       places the canvases at device px / dpr (a ResizeObserver on the device-pixel-content-box nudges a size that
 *       lands 1-2 px off, at most twice), sets the gradient and repaints the edges at once from the last frame
 *     layer.shade({ statusTop, caption }) -> the gradient: the bottom band's anchor and the caption shade (call it when
 *       the status row or the caption moves; once a minute at most)
 *     layer.draw(frame, info?): frame is the engine's PC.Canvas (or 4096 0xRRGGBB); info { snap, first, fading }
 *       (PCD.host's paint option passes { first, fading }). It copies the frame through the dimming table into the
 *       scene canvas, re-reads the dimming every 15 frames, refreshes the band rows every 4th frame (every frame while
 *       a theme cross-fades or the dimming moved), eases them (0.12 per frame) and repaints the band and seam canvases
 *       only when a painted colour changes. A first frame, a snap, or a frame more than 0.5 s after the last one (a
 *       still frame under reduced motion, a resume) skips the easing.
 *     layer.isScene(target) -> true for the scene canvas (what a click that shakes the scene lands on)
 *     layer.geo() -> the last fit();  layer.info() -> { geo, k, side, mix, keep, luma, frames, paints { scene, band,
 *       fade }, targets, exposures, snaps, nudges, cost { last, p50, p95, max, n } (ms of draw over the last 150
 *       frames), visible { scene, band, fade } }
 *     layer.pixels() -> { frame (4096, the dimmed frame as painted), rows (64), fade (64 x cols), cols, edge } (tests)
 *     layer.destroy()
 *   With PCD.host: PCD.host.create({ canvas: layer.canvas, paint: layer.draw, sceneClock: 'none', ... }).
 */
(function (root, factory) {
  var api = factory(root.PCD || (root.PCD = {}), root);
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (PCD, root) {
  'use strict';

  var SCENE = 64;
  var N = SCENE * SCENE;
  /** k may grow until the scene fills the room beside the column, but never past cropping 10 % of the rows. */
  var MAX_CROP = 0.1;
  /** Of the rows a tall k crops, the top (the sky) gives 60 % and the ground 40 %. */
  var TOP_SHARE = 0.6;
  /** The seam: scene px of the scene's own edge, mirrored, fading into the band. */
  var FADE = 5;
  /** The bands sit a little darker than the scene: periphery, not window. */
  var BAND_DIM = 0.16;
  /** Band easing per frame, so drifting snow or a passing cloud never flickers. */
  var BAND_EASE = 0.12;
  /** Dimming: re-read every 15 frames, eased by 0.3. */
  var DIM_EASE = 0.3;
  var DIM_EVERY = 15;
  /** Band rows refresh every 4th frame (about 7.5 a second at 30 fps), every frame while a theme cross-fades. */
  var BAND_EVERY = 4;
  /** keep = 0.6 - 0.1 x smoothstep(30, 170, mean luma): the share of the scene's own light that stays. */
  var KEEP_NIGHT = 0.6;
  var KEEP_SPAN = 0.1;
  var LUMA_LO = 30;
  var LUMA_HI = 170;
  /** The dimming table is rebuilt only when keep moves by this much. */
  var LUT_STEP = 0.002;
  /** keep before the first frame (it snaps to the frame's own value on the first draw). */
  var START_KEEP = 0.58;
  /** A frame this long after the last one has nothing to ease from (a still frame, a resume): it snaps. */
  var SLOW_MS = 500;
  /** Room (CSS px) right of the column under which the side gradient stays dark all the way across. */
  var NARROW = 40;
  /** The caption shade: an ellipse 3.4 rows tall, 16 cells wider than the caption on each side. */
  var CAPTION_RY = 3.4;
  var CAPTION_PAD = 16;
  var COST_WINDOW = 150;
  var BG = 0x141016;

  /** Seam: the band's share at 1..FADE scene px from the scene (FADE_T[0] unused). */
  var FADE_T = new Float32Array(FADE + 1);
  (function () {
    for (var d = 1; d <= FADE; d++) {
      var x = 1 - d / (FADE + 1);
      FADE_T[d] = 1 - x * x;
    }
  })();

  // ------------------------------------------------------------------------------------------------ helpers

  function clamp(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
  }

  function smooth(a, b, x) {
    var t = clamp((x - a) / (b - a), 0, 1);
    return t * t * (3 - 2 * t);
  }

  function isNum(v) {
    return typeof v === 'number' && isFinite(v);
  }

  /** bg as 0xRRGGBB (the generated tokens win when loaded). */
  function bgColor() {
    var T = PCD.TOKENS;
    var v = T && T.int && T.int.bg;
    return typeof v === 'number' ? v : BG;
  }

  /** The 4096 0xRRGGBB values of a frame: a PC.Canvas, a typed array or an array. */
  function pixelsOf(frame) {
    var px = frame && frame.px ? frame.px : frame;
    if (!px || typeof px.length !== 'number' || px.length < N) throw new Error('PCD.bleed: a 64x64 frame (4096 0xRRGGBB values) is required');
    return px;
  }

  function bytes(n) {
    return typeof Buffer === 'function' && typeof Buffer.alloc === 'function' ? Buffer.alloc(n) : new Uint8Array(n);
  }

  // ------------------------------------------------------------------------------------------------ geometry

  /** The console column on the top-left cell grid: about a third of the width, 44 to 64 cells, inside its margins. */
  function columnRule(o) {
    var x = o || {};
    var cssW = Number(x.cssW);
    var cw = Number(x.cell && x.cell.w);
    if (!(cssW > 0) || !(cw > 0)) throw new Error('PCD.bleed.columnRule: cssW and cell.w must be positive');
    var C = Math.max(1, Math.floor(cssW / cw));
    var margin = C >= 100 ? 4 : C >= 60 ? 3 : C >= 24 ? 2 : 0;
    var cols = Math.max(1, Math.min(clamp(Math.round(C * 0.34), 44, 64), C - 2 * margin));
    var right = x.side === 'right';
    var c = right ? Math.max(0, C - margin - cols) : margin;
    var left = c * cw;
    return { C: C, margin: margin, cols: cols, c: c, x: left, w: cols * cw, reach: right ? cssW - left : (margin + cols) * cw };
  }

  /** The console's type rule for squarish and portrait screens: the step for min(height, TALL x width). */
  var TALL = { newtab: 0.8, wallpaper: 0.9, still: 0.9 };

  function cellOf(o, cssW, cssH, dpr, side) {
    var c = o.cell;
    if (c && Number(c.w) > 0 && Number(c.h) > 0) return { w: Number(c.w), h: Number(c.h) };
    var L = PCD.layout;
    if (L && typeof L.termCell === 'function' && typeof L.fontStep === 'function') {
      var profile = o.profile || (side === 'left' ? 'newtab' : 'wallpaper');
      var tall = TALL[profile] || TALL.wallpaper;
      var t = L.termCell(L.fontStep(Math.min(cssH, cssW * tall), dpr, profile), dpr);
      return { w: t.w, h: t.h };
    }
    throw new Error('PCD.bleed.fit: pass cell { w, h } (CSS px) or load pcd-layout.js first');
  }

  function rect(x, y, w, h, cols) {
    return { x: x, y: y, w: w, h: h, cols: cols };
  }

  /**
   * The k rule: the smallest whole k that covers the height, raised until the scene fills the room beside the column,
   * never cropping more than 10 % of the rows (the top gives 60 % of what is cropped). The scene sits flush to the side
   * away from the column; a screen narrower than the scene crops it evenly at both sides.
   */
  function fit(input) {
    var o = input || {};
    var cssW = Number(o.cssW);
    var cssH = Number(o.cssH);
    if (!(cssW > 0 && cssH > 0)) throw new Error('PCD.bleed.fit: cssW and cssH must be positive numbers');
    var dpr = Number(o.dpr) > 0 ? Number(o.dpr) : 1;
    var side = o.side === 'right' ? 'right' : 'left';
    var cell = cellOf(o, cssW, cssH, dpr, side);
    var bottom = Number(o.bottomCss) > 0 ? Math.min(cssH, Number(o.bottomCss)) : 0;
    var rule = null;
    var reach;
    if (o.reach !== undefined && o.reach !== null && isFinite(Number(o.reach))) {
      reach = clamp(Number(o.reach), 0, cssW);
    } else {
      rule = columnRule({ cssW: cssW, cell: cell, side: side });
      reach = rule.reach;
    }

    var Wd = Math.round(cssW * dpr);
    var Hd = Math.round(cssH * dpr);
    var reachDev = Math.round(reach * dpr);
    var k0 = Math.max(2, Math.ceil(Hd / SCENE));
    var free = Math.max(0, Wd - reachDev);
    var kMax = Math.max(k0, Math.floor(Hd / (SCENE * (1 - MAX_CROP))));
    var k = Math.max(k0, Math.min(Math.ceil(free / SCENE), kMax));
    var size = SCENE * k;
    var sy = 0 - Math.round((size - Hd) * TOP_SHARE);
    var sx;
    var place;
    if (size >= Wd) {
      sx = 0 - Math.round((size - Wd) / 2);
      place = 'crop';
    } else {
      sx = side === 'left' ? Wd - size : 0;
      place = 'flush';
    }
    var nL = sx > 0 ? Math.ceil(sx / k) : 0;
    var nR = Wd - sx - size > 0 ? Math.ceil((Wd - sx - size) / k) : 0;
    var edge = nL > 0 ? 'left' : nR > 0 ? 'right' : null;
    var band = null;
    var fade = null;
    var edgeCols = 0;
    if (edge === 'left') {
      edgeCols = nL;
      var cl = Math.min(FADE, nL);
      band = rect(0, sy, sx, size, 1);
      fade = rect(sx - cl * k, sy, cl * k, size, cl);
    } else if (edge === 'right') {
      edgeCols = nR;
      var cr = Math.min(FADE, nR);
      band = rect(sx + size, sy, Wd - sx - size, size, 1);
      fade = rect(sx + size, sy, cr * k, size, cr);
    }

    var colH = Math.max(0, cssH - bottom);
    var colHDev = Math.round(colH * dpr);
    var column = {
      side: side,
      x: side === 'left' ? 0 : cssW - reach,
      y: 0,
      w: reach,
      h: colH,
      xDev: side === 'left' ? 0 : Wd - reachDev,
      yDev: 0,
      wDev: reachDev,
      hDev: colHDev,
      reach: reach,
      reachDev: reachDev,
      bottom: bottom,
      cell: { w: cell.w, h: cell.h },
      rule: rule
    };
    // the console's hint row: one row above the zone's last row (the last row only when the zone is short)
    var R = Math.max(1, Math.floor(colH / cell.h));
    var statusTop = o.statusTop === null ? null : isNum(o.statusTop) ? o.statusTop : R >= 2 ? (R - 1 - (R >= 18 ? 1 : 0)) * cell.h : null;
    var caption = o.caption && Number(o.caption.w) > 0 ? { x: Number(o.caption.x) || 0, y: Number(o.caption.y) || 0, w: Number(o.caption.w), h: Number(o.caption.h) || cell.h } : null;

    var geo = {
      cssW: cssW,
      cssH: cssH,
      dpr: dpr,
      Wd: Wd,
      Hd: Hd,
      side: side,
      k: k,
      k0: k0,
      kMax: kMax,
      place: place,
      scene: { x: sx, y: sy, size: size },
      sceneCss: { x: sx / dpr, y: sy / dpr, size: size / dpr },
      crop: {
        top: 0 - sy,
        bottom: size + sy - Hd,
        rows: (size - Hd) / k,
        share: (size - Hd) / size,
        first: Math.floor((0 - sy) / k),
        last: Math.floor((Hd - 1 - sy) / k)
      },
      edge: edge,
      band: band,
      fade: fade,
      edgeCols: edgeCols,
      column: column,
      statusTop: statusTop,
      caption: caption,
      gradient: null
    };
    geo.gradient = gradient(geo);
    return geo;
  }

  // ------------------------------------------------------------------------------------------------ dimming

  /** The frame's light: every other pixel, 0.2126 R + 0.7152 G + 0.0722 B of the sRGB values (0..255). */
  function meanLuma(frame) {
    var px = pixelsOf(frame);
    var sum = 0;
    for (var i = 0; i < N; i += 2) {
      var c = px[i];
      sum += 0.2126 * ((c >> 16) & 255) + 0.7152 * ((c >> 8) & 255) + 0.0722 * (c & 255);
    }
    return sum / 2048;
  }

  /** The share of the scene's own light that stays: 0.6 at night down to 0.5 on bright days. */
  function keepFor(luma) {
    return KEEP_NIGHT - KEEP_SPAN * smooth(LUMA_LO, LUMA_HI, luma);
  }

  /** The mix toward bg for a brightness (a meanLuma or a frame); prev (a mix) eases by 0.3. */
  function dim(brightness, prev) {
    var luma = isNum(brightness) ? brightness : meanLuma(brightness);
    var target = keepFor(luma);
    var keep = isNum(prev) ? (1 - prev) + (target - (1 - prev)) * DIM_EASE : target;
    return 1 - keep;
  }

  /** v -> round(bg + (v - bg) x keep), per channel. */
  function lutKeep(keep, out) {
    var T = bgColor();
    var br = (T >> 16) & 255;
    var bgn = (T >> 8) & 255;
    var bb = T & 255;
    var o = out || { r: new Uint8Array(256), g: new Uint8Array(256), b: new Uint8Array(256) };
    for (var v = 0; v < 256; v++) {
      o.r[v] = Math.round(br + (v - br) * keep);
      o.g[v] = Math.round(bgn + (v - bgn) * keep);
      o.b[v] = Math.round(bb + (v - bb) * keep);
    }
    return o;
  }

  function dimLut(mix) {
    return lutKeep(1 - mix);
  }

  function dimColor(c, mix) {
    var keep = 1 - mix;
    var T = bgColor();
    var r = Math.round(((T >> 16) & 255) + (((c >> 16) & 255) - ((T >> 16) & 255)) * keep);
    var g = Math.round(((T >> 8) & 255) + (((c >> 8) & 255) - ((T >> 8) & 255)) * keep);
    var b = Math.round((T & 255) + ((c & 255) - (T & 255)) * keep);
    return ((r << 16) | (g << 8) | b) >>> 0;
  }

  function applyLut(px, lut, out) {
    var dst = out || new Uint32Array(N);
    var LR = lut.r;
    var LG = lut.g;
    var LB = lut.b;
    for (var i = 0; i < N; i++) {
      var c = px[i];
      dst[i] = (LR[(c >> 16) & 255] << 16) | (LG[(c >> 8) & 255] << 8) | LB[c & 255];
    }
    return dst;
  }

  function dimFrame(frame, mix, out) {
    return applyLut(pixelsOf(frame), dimLut(mix), out);
  }

  // ------------------------------------------------------------------------------------------------ bands

  var modeC = new Uint32Array(SCENE);
  var modeN = new Uint8Array(SCENE);
  var modeR = new Int16Array(SCENE);
  var modeG = new Int16Array(SCENE);
  var modeB = new Int16Array(SCENE);
  var modeS = new Int32Array(SCENE);
  var byGreen = new Uint8Array(SCENE);
  var med5 = new Float32Array(5);

  /**
   * The colour a row's band continues. The row's most frequent colour wins outright when it owns at least MODE_OWN of
   * the 64 pixels (the first to reach a count keeps a tie). Below that the row is dithered (a sunset sky, a patterned
   * wall), and a flat object could out-count each of its shades. Then every distinct colour scores the pixels within
   * MODE_NEAR levels of it on every channel, and the best score wins (the first colour of the row keeps a tie), so the
   * shades of the sky vote together and the object stays a minority. The scores come from one pass over the pairs of
   * distinct colours sorted by green, which stops as soon as green alone is too far apart (a busy row stays cheap).
   */
  var MODE_OWN = 22;
  var MODE_NEAR = 8;

  function rowMode(px, y) {
    var n = 0;
    var base = y * SCENE;
    var best = px[base];
    var bestN = 0;
    for (var x = 0; x < SCENE; x++) {
      var c = px[base + x];
      var j = 0;
      while (j < n && modeC[j] !== c) j++;
      if (j === n) {
        modeC[n] = c;
        modeN[n] = 0;
        n++;
      }
      var cnt = ++modeN[j];
      if (cnt > bestN) {
        bestN = cnt;
        best = c;
      }
    }
    if (bestN >= MODE_OWN) return best;
    var i;
    var k;
    for (i = 0; i < n; i++) {
      modeR[i] = (modeC[i] >> 16) & 255;
      modeG[i] = (modeC[i] >> 8) & 255;
      modeB[i] = modeC[i] & 255;
      modeS[i] = modeN[i];
      // insertion into the order by green
      k = i - 1;
      while (k >= 0 && modeG[byGreen[k]] > modeG[i]) {
        byGreen[k + 1] = byGreen[k];
        k--;
      }
      byGreen[k + 1] = i;
    }
    // each pair of near colours once: both get the other's pixels
    for (i = 0; i < n; i++) {
      var p = byGreen[i];
      for (k = i + 1; k < n; k++) {
        var q = byGreen[k];
        if (modeG[q] - modeG[p] > MODE_NEAR) break;
        var dr = modeR[q] - modeR[p];
        var db = modeB[q] - modeB[p];
        if (dr <= MODE_NEAR && dr >= -MODE_NEAR && db <= MODE_NEAR && db >= -MODE_NEAR) {
          modeS[p] += modeN[q];
          modeS[q] += modeN[p];
        }
      }
    }
    var top = -1;
    for (i = 0; i < n; i++) {
      if (modeS[i] > top) {
        top = modeS[i];
        best = modeC[i];
      }
    }
    return best;
  }

  function median5(a, b, c, d, e) {
    med5[0] = a;
    med5[1] = b;
    med5[2] = c;
    med5[3] = d;
    med5[4] = e;
    for (var i = 1; i < 5; i++) {
      var v = med5[i];
      var j = i - 1;
      while (j >= 0 && med5[j] > v) {
        med5[j + 1] = med5[j];
        j--;
      }
      med5[j + 1] = v;
    }
    return med5[2];
  }

  function createState() {
    return { band: new Float32Array(192), target: new Float64Array(192), raw: new Float32Array(192), med: new Float32Array(192), ready: false };
  }

  /**
   * The band rows a frame asks for: each row's main colour (objects are the minority of 64 pixels and come in many
   * shades), a vertical median of 5 rows and a [1 2 1] pass (a row of trees or a shelf never becomes a stripe across
   * the screen), then 16 % toward bg.
   */
  function bandTarget(st, shown) {
    var raw = st.raw;
    var med = st.med;
    var T = st.target;
    var B = bgColor();
    var bgc = [(B >> 16) & 255, (B >> 8) & 255, B & 255];
    var y;
    var ch;
    for (y = 0; y < SCENE; y++) {
      var m = rowMode(shown, y);
      var i = y * 3;
      raw[i] = (m >> 16) & 255;
      raw[i + 1] = (m >> 8) & 255;
      raw[i + 2] = m & 255;
    }
    for (y = 0; y < SCENE; y++) {
      for (ch = 0; ch < 3; ch++) {
        med[y * 3 + ch] = median5(raw[clamp(y - 2, 0, 63) * 3 + ch], raw[clamp(y - 1, 0, 63) * 3 + ch], raw[y * 3 + ch],
          raw[clamp(y + 1, 0, 63) * 3 + ch], raw[clamp(y + 2, 0, 63) * 3 + ch]);
      }
    }
    for (y = 0; y < SCENE; y++) {
      for (ch = 0; ch < 3; ch++) {
        var j = y * 3 + ch;
        var v = (med[Math.max(0, y - 1) * 3 + ch] + 2 * med[j] + med[Math.min(63, y + 1) * 3 + ch]) / 4;
        T[j] = v + (bgc[ch] - v) * BAND_DIM;
      }
    }
  }

  function bandEase(st, a) {
    var band = st.band;
    var T = st.target;
    for (var i = 0; i < 192; i++) band[i] += (T[i] - band[i]) * a;
    st.ready = true;
  }

  function bandRows(band, out) {
    var rows = out || new Uint32Array(SCENE);
    for (var y = 0; y < SCENE; y++) {
      var i = y * 3;
      rows[y] = ((Math.round(band[i]) << 16) | (Math.round(band[i + 1]) << 8) | Math.round(band[i + 2])) >>> 0;
    }
    return rows;
  }

  /** The seam on one side: the scene's own edge columns, mirrored, fading into the band (row-major, as painted). */
  function fadeColors(band, shown, side, cols, out) {
    var n = Math.max(0, Math.min(FADE, cols | 0));
    var dst = out || new Uint32Array(SCENE * n);
    var left = side === 'left';
    for (var y = 0; y < SCENE; y++) {
      var i3 = y * 3;
      var br = band[i3];
      var bgn = band[i3 + 1];
      var bb = band[i3 + 2];
      for (var i = 0; i < n; i++) {
        var dist = left ? n - i : i + 1;
        var src = shown[y * SCENE + (left ? dist - 1 : SCENE - dist)];
        var t = FADE_T[dist];
        var u = 1 - t;
        dst[y * n + i] = ((Math.round(((src >> 16) & 255) * u + br * t) << 16) |
          (Math.round(((src >> 8) & 255) * u + bgn * t) << 8) | Math.round((src & 255) * u + bb * t)) >>> 0;
      }
    }
    return dst;
  }

  function bands(frame, opts) {
    var o = opts || {};
    var px = pixelsOf(frame);
    var shown = isNum(o.mix) ? dimFrame(px, o.mix) : px;
    var st = o.state && o.state.band && o.state.target ? o.state : createState();
    var snap = !st.ready || !!o.snap;
    bandTarget(st, shown);
    bandEase(st, snap ? 1 : isNum(o.ease) ? o.ease : BAND_EASE);
    var cols = isNum(o.cols) ? Math.max(0, Math.min(FADE, o.cols | 0)) : FADE;
    return {
      rows: bandRows(st.band),
      fadeLeft: fadeColors(st.band, shown, 'left', cols),
      fadeRight: fadeColors(st.band, shown, 'right', cols),
      cols: cols,
      shown: shown,
      state: st
    };
  }

  // ------------------------------------------------------------------------------------------------ gradient

  function rgbaOf(c, a) {
    return 'rgba(' + ((c >> 16) & 255) + ',' + ((c >> 8) & 255) + ',' + (c & 255) + ',' + a.toFixed(3) + ')';
  }

  function stop(at, a) {
    return { at: at, a: a };
  }

  /**
   * The fixed gradient (the veil), in bg: deepest at the column's screen edge (0.88), 0.82 one cell past
   * the column, then 0.5 / 0.2 / 0.06 / 0 at 14 / 32 / 50 / 66 % of the rest; a light band along the bottom, 0.5 at
   * the edge, 0.36 / 0.12 / 0 at 0.2 / 0.9 / 2 rows above the status row's top; an oval shade behind the caption.
   */
  function gradient(geo, opts) {
    var o = opts || {};
    var W = geo.cssW;
    var H = geo.cssH;
    var cw = geo.column.cell.w;
    var ch = geo.column.cell.h;
    var col = bgColor();
    var statusTop = o.statusTop !== undefined ? o.statusTop : geo.statusTop;
    var capIn = o.caption !== undefined ? o.caption : geo.caption;
    var a = function (v) { return rgbaOf(col, v); };
    var dir = geo.side === 'right' ? 270 : 90;

    var x1 = Math.min(W, geo.column.reach + cw);
    var rest = Math.max(0, W - x1);
    var sideStops;
    var sideCss;
    if (rest < NARROW) {
      sideStops = [stop(0, 0.88), stop(W, 0.82)];
      sideCss = 'linear-gradient(' + dir + 'deg, ' + a(0.88) + ' 0px, ' + a(0.82) + ' ' + W + 'px)';
    } else {
      sideStops = [stop(0, 0.88), stop(x1, 0.82), stop(x1 + 0.14 * rest, 0.5), stop(x1 + 0.32 * rest, 0.2),
        stop(x1 + 0.5 * rest, 0.06), stop(x1 + 0.66 * rest, 0)];
      sideCss = 'linear-gradient(' + dir + 'deg, ' + a(0.88) + ' 0px, ' + a(0.82) + ' ' + x1.toFixed(1) + 'px, ' + a(0.5) + ' ' +
        (x1 + 0.14 * rest).toFixed(1) + 'px, ' + a(0.2) + ' ' + (x1 + 0.32 * rest).toFixed(1) + 'px, ' + a(0.06) + ' ' +
        (x1 + 0.5 * rest).toFixed(1) + 'px, ' + a(0) + ' ' + (x1 + 0.66 * rest).toFixed(1) + 'px)';
    }

    var s = H - (isNum(statusTop) ? statusTop : H - 1.6 * ch);
    var bottomStops = [stop(0, 0.5), stop(s + 0.2 * ch, 0.36), stop(s + 0.9 * ch, 0.12), stop(s + 2 * ch, 0)];
    var bottomCss = 'linear-gradient(0deg, ' + a(0.5) + ' 0px, ' + a(0.36) + ' ' + (s + 0.2 * ch).toFixed(1) + 'px, ' + a(0.12) + ' ' +
      (s + 0.9 * ch).toFixed(1) + 'px, ' + a(0) + ' ' + (s + 2 * ch).toFixed(1) + 'px)';

    var cap = null;
    var layers = [bottomCss, sideCss];
    if (capIn && Number(capIn.w) > 0) {
      var cy0 = Number(capIn.y) || 0;
      var chh = Number(capIn.h) > 0 ? Number(capIn.h) : ch;
      cap = {
        cx: (Number(capIn.x) || 0) + Number(capIn.w) / 2,
        cy: cy0 + chh / 2,
        rx: Number(capIn.w) / 2 + CAPTION_PAD * cw,
        ry: CAPTION_RY * ch,
        stops: [stop(0, 0.7), stop(0.32, 0.6), stop(0.62, 0.32), stop(0.84, 0.1), stop(1, 0)]
      };
      layers.unshift('radial-gradient(ellipse ' + cap.rx.toFixed(1) + 'px ' + cap.ry.toFixed(1) + 'px at ' + cap.cx.toFixed(1) + 'px ' +
        cap.cy.toFixed(1) + 'px, ' + a(0.7) + ' 0%, ' + a(0.6) + ' 32%, ' + a(0.32) + ' 62%, ' + a(0.1) + ' 84%, ' + a(0) + ' 100%)');
    }
    return {
      color: col,
      width: W,
      height: H,
      side: { dir: dir, x1: x1, rest: rest, stops: sideStops },
      bottom: { s: s, stops: bottomStops },
      caption: cap,
      css: layers.join(', ')
    };
  }

  /** Piecewise linear over stops (later stops never before earlier ones, as CSS fixes them up). */
  function along(stops, d) {
    var prevAt = stops[0].at;
    if (d <= prevAt) return stops[0].a;
    for (var i = 1; i < stops.length; i++) {
      var at = Math.max(prevAt, stops[i].at);
      if (d <= at) {
        var span = at - prevAt;
        return span > 0 ? stops[i - 1].a + (stops[i].a - stops[i - 1].a) * (d - prevAt) / span : stops[i].a;
      }
      prevAt = at;
    }
    return stops[stops.length - 1].a;
  }

  function sideAlpha(g, x) {
    return along(g.side.stops, g.side.dir === 270 ? g.width - x : x);
  }

  function bottomAlpha(g, y) {
    return along(g.bottom.stops, g.height - y);
  }

  function captionAlpha(g, x, y) {
    var c = g.caption;
    if (!c) return 0;
    var dx = (x - c.cx) / c.rx;
    var dy = (y - c.cy) / c.ry;
    return along(c.stops, Math.sqrt(dx * dx + dy * dy));
  }

  function gradientAlpha(g, x, y) {
    return 1 - (1 - sideAlpha(g, x)) * (1 - bottomAlpha(g, y)) * (1 - captionAlpha(g, x, y));
  }

  // ------------------------------------------------------------------------------------------------ compose (the still)

  function compose(img, geo, frame, opts) {
    var o = opts || {};
    var W = geo.Wd;
    var H = geo.Hd;
    var chans = o.channels === 4 || o.channels === 3 ? o.channels : img && img.data && img.data.length === W * H * 4 ? 4 : 3;
    var out = img || { width: W, height: H, data: bytes(W * H * chans) };
    if (out.width !== W || out.height !== H || !out.data || out.data.length < W * H * chans) {
      throw new Error('PCD.bleed.compose: the image must be ' + W + 'x' + H + ' with ' + chans + ' channels');
    }
    var px = pixelsOf(frame);
    var luma = meanLuma(px);
    var mix = isNum(o.mix) ? o.mix : dim(luma);
    var shown = applyLut(px, lutKeep(1 - mix));
    var cols = geo.fade ? geo.fade.cols : 0;
    var b = bands(shown, { cols: cols, snap: true });
    var fade = geo.edge === 'left' ? b.fadeLeft : b.fadeRight;
    var k = geo.k;
    var sx = geo.scene.x;
    var sy = geo.scene.y;
    var size = geo.scene.size;
    var dpr = geo.dpr;

    // what each device column shows: a scene column (>= 0), the band (-1) or a seam column (-2 - i)
    var kind = new Int32Array(W);
    var fx0 = geo.fade ? geo.fade.x : 0;
    var fx1 = geo.fade ? geo.fade.x + geo.fade.w : 0;
    for (var x = 0; x < W; x++) {
      if (x >= sx && x < sx + size) kind[x] = Math.floor((x - sx) / k);
      else if (x >= fx0 && x < fx1) kind[x] = -2 - Math.min(cols - 1, Math.floor((x - fx0) / k));
      else kind[x] = -1;
    }
    var g = o.veil === false ? null : o.gradient || geo.gradient;
    var ax = new Float32Array(W);
    var ay = new Float32Array(H);
    var y;
    if (g) {
      for (x = 0; x < W; x++) ax[x] = sideAlpha(g, (x + 0.5) / dpr);
      for (y = 0; y < H; y++) ay[y] = bottomAlpha(g, (y + 0.5) / dpr);
    }
    var cap = g && g.caption;
    var cx0 = 0;
    var cx1 = -1;
    var cy0 = 0;
    var cy1 = -1;
    if (cap) {
      cx0 = Math.max(0, Math.floor((cap.cx - cap.rx) * dpr));
      cx1 = Math.min(W - 1, Math.ceil((cap.cx + cap.rx) * dpr));
      cy0 = Math.max(0, Math.floor((cap.cy - cap.ry) * dpr));
      cy1 = Math.min(H - 1, Math.ceil((cap.cy + cap.ry) * dpr));
    }
    var B = bgColor();
    var bR = (B >> 16) & 255;
    var bG = (B >> 8) & 255;
    var bB = B & 255;
    var data = out.data;
    for (y = 0; y < H; y++) {
      var ry = clamp(Math.floor((y - sy) / k), 0, 63);
      var base = ry * SCENE;
      var bandC = b.rows[ry];
      var fadeBase = ry * cols;
      var keepY = 1 - ay[y];
      var inCapY = y >= cy0 && y <= cy1;
      var o4 = y * W * chans;
      for (x = 0; x < W; x++, o4 += chans) {
        var kx = kind[x];
        var c = kx >= 0 ? shown[base + kx] : kx === -1 ? bandC : fade[fadeBase + (-2 - kx)];
        var r = (c >> 16) & 255;
        var gg = (c >> 8) & 255;
        var bb = c & 255;
        if (g) {
          var keep = (1 - ax[x]) * keepY;
          if (inCapY && x >= cx0 && x <= cx1) keep *= 1 - captionAlpha(g, (x + 0.5) / dpr, (y + 0.5) / dpr);
          var A = 1 - keep;
          r = Math.round(r + (bR - r) * A);
          gg = Math.round(gg + (bG - gg) * A);
          bb = Math.round(bb + (bB - bb) * A);
        }
        data[o4] = r;
        data[o4 + 1] = gg;
        data[o4 + 2] = bb;
        if (chans === 4) data[o4 + 3] = 255;
      }
    }
    return { img: out, mix: mix, luma: luma, rows: b.rows };
  }

  // ------------------------------------------------------------------------------------------------ the browser part

  var LITTLE = (function () {
    try {
      return new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;
    } catch (e) {
      return false;
    }
  })();

  function mountScene(rootEl, opts) {
    if (!rootEl || typeof rootEl.appendChild !== 'function') throw new Error('PCD.bleed.mountScene: a root element is required');
    var o = opts || {};
    var doc = o.doc || rootEl.ownerDocument || root.document;
    var win = o.win || (doc && doc.defaultView) || root;
    var perfNow = typeof o.perfNow === 'function' ? o.perfNow : function () {
      var p = (win && win.performance) || root.performance;
      return p && typeof p.now === 'function' ? p.now() : Date.now();
    };
    var INPUT_KEYS = ['side', 'cell', 'profile', 'reach', 'bottomCss', 'statusTop', 'caption'];
    var input = {};
    INPUT_KEYS.forEach(function (key) { if (o[key] !== undefined) input[key] = o[key]; });

    // ---- elements
    var bg = bgColor();
    var bgHex = '#' + ('00000' + bg.toString(16)).slice(-6);
    if (o.style !== false) {
      var rs = rootEl.style;
      rs.position = 'fixed';
      rs.left = '0';
      rs.top = '0';
      rs.right = '0';
      rs.bottom = '0';
      rs.overflow = 'hidden';
      rs.zIndex = '0';
      rs.background = bgHex;
      rs.contain = 'strict';
    }
    rootEl.className = (rootEl.className ? rootEl.className + ' ' : '') + 'pcd-bleed';

    function makeCanvas(w, h, cls) {
      var c = doc.createElement('canvas');
      c.width = w;
      c.height = h;
      c.className = cls;
      var st = c.style;
      st.position = 'absolute';
      st.left = '0';
      st.top = '0';
      st.display = 'none';
      st.imageRendering = 'pixelated';
      // its own compositor layer: a change uploads the tiny canvas and the GPU scales it (nearest neighbour)
      st.willChange = 'transform';
      return c;
    }
    var bandCv = makeCanvas(1, SCENE, 'pcd-bleed-band');
    var sceneCv = makeCanvas(SCENE, SCENE, 'pcd-bleed-scene');
    var fadeCv = makeCanvas(FADE, SCENE, 'pcd-bleed-fade');
    if (o.pointer !== false) sceneCv.style.cursor = 'pointer';
    var veil = doc.createElement('div');
    veil.className = 'pcd-bleed-veil';
    veil.setAttribute('aria-hidden', 'true');
    var vs = veil.style;
    vs.position = 'absolute';
    vs.left = '0';
    vs.top = '0';
    vs.right = '0';
    vs.bottom = '0';
    vs.pointerEvents = 'none';
    rootEl.setAttribute('aria-hidden', 'true');
    rootEl.appendChild(bandCv);
    rootEl.appendChild(sceneCv);
    rootEl.appendChild(fadeCv);
    rootEl.appendChild(veil);

    function ctx2d(c) {
      try {
        return c.getContext('2d', { alpha: false });
      } catch (e) {
        return null;
      }
    }
    var sceneG = ctx2d(sceneCv);
    var bandG = ctx2d(bandCv);
    var fadeG = ctx2d(fadeCv);
    function image(g, w, h) {
      if (!g || typeof g.createImageData !== 'function') return null;
      var im = g.createImageData(w, h);
      for (var i = 3; i < im.data.length; i += 4) im.data[i] = 255;
      return im;
    }
    var sceneImg = image(sceneG, SCENE, SCENE);
    var scene32 = sceneImg && LITTLE && sceneImg.data.buffer ? new Uint32Array(sceneImg.data.buffer, sceneImg.data.byteOffset, N) : null;
    var bandImg = image(bandG, 1, SCENE);
    var fadeImg = image(fadeG, FADE, SCENE);

    // ---- state
    var geo = null;
    var keep = START_KEEP;
    var luma = -1;
    var lutAt = -1;
    var lut = { r: new Uint8Array(256), g: new Uint8Array(256), b: new Uint8Array(256) };
    var lutMoved = false;
    var shown = new Uint32Array(N);
    var hasFrame = false;
    var st = createState();
    var paintedRows = new Int32Array(SCENE);
    var paintedFade = new Int32Array(SCENE * FADE);
    var fadeBuf = new Uint32Array(SCENE * FADE);
    var fadeCols = 0;
    var fadeSide = null;
    paintedRows.fill(-1);
    paintedFade.fill(-1);
    var frames = 0;
    var lastAt = -Infinity;
    var costs = new Float64Array(COST_WINDOW);
    var costN = 0;
    var lastCost = 0;
    var counts = { scene: 0, band: 0, fade: 0, targets: 0, exposures: 0, snaps: 0 };
    var nudges = 0;
    var dead = false;

    // ---- placement: device px / dpr, and a nudge when the painted box lands 1-2 device px off
    var places = [];
    var ro = null;
    if (win && typeof win.ResizeObserver === 'function') {
      try {
        ro = new win.ResizeObserver(onBoxes);
      } catch (e) {
        ro = null;
      }
    }
    function placeOf(el) {
      for (var i = 0; i < places.length; i++) if (places[i].el === el) return places[i];
      var p = { el: el, w: 0, h: 0, dpr: 1, cssW: 0, cssH: 0, tries: 0, observed: false };
      places.push(p);
      return p;
    }
    function place(el, r, dpr) {
      var p = placeOf(el);
      var st2 = el.style;
      st2.left = r.x / dpr + 'px';
      st2.top = r.y / dpr + 'px';
      p.w = r.w;
      p.h = r.h;
      p.dpr = dpr;
      p.cssW = r.w / dpr;
      p.cssH = r.h / dpr;
      p.tries = 0;
      st2.width = p.cssW + 'px';
      st2.height = p.cssH + 'px';
      if (ro && !p.observed) {
        try {
          ro.observe(el, { box: 'device-pixel-content-box' });
          p.observed = true;
        } catch (e) {
          p.observed = false;
        }
      }
    }
    function onBoxes(entries) {
      for (var i = 0; i < entries.length; i++) {
        var e = entries[i];
        var s = e.devicePixelContentBoxSize && e.devicePixelContentBoxSize[0];
        if (!s) continue;
        var p = placeOf(e.target);
        if (!p.w || p.tries >= 2) continue;
        var dw = p.w - s.inlineSize;
        var dh = p.h - s.blockSize;
        // only a box within 2 px of the target is trusted (CDP's emulated ratios report CSS px here)
        if ((dw === 0 && dh === 0) || Math.abs(dw) > 2 || Math.abs(dh) > 2) continue;
        if (dw) {
          p.cssW += (dw > 0 ? 1 : -1) / p.dpr;
          e.target.style.width = p.cssW + 'px';
        }
        if (dh) {
          p.cssH += (dh > 0 ? 1 : -1) / p.dpr;
          e.target.style.height = p.cssH + 'px';
        }
        p.tries++;
        nudges++;
      }
    }

    function show(el, on) {
      var d = on ? 'block' : 'none';
      if (el.style.display !== d) el.style.display = d;
    }
    function display() {
      var on = !!geo && hasFrame;
      show(sceneCv, on);
      show(bandCv, on && !!geo.band);
      show(fadeCv, on && !!geo.fade);
    }

    var veilCss = '';
    function setVeil(css) {
      if (css === veilCss) return;
      veilCss = css;
      veil.style.backgroundImage = css;
    }

    // ---- painting

    function setLut(b) {
      if (Math.abs(b - lutAt) < LUT_STEP) return;
      lutAt = b;
      lutKeep(b, lut);
      lutMoved = true;
    }

    function expose(px, snap) {
      luma = meanLuma(px);
      var target = keepFor(luma);
      keep = snap ? target : keep + (target - keep) * DIM_EASE;
      setLut(keep);
      counts.exposures++;
    }

    function paintScene(px) {
      var LR = lut.r;
      var LG = lut.g;
      var LB = lut.b;
      var i;
      if (scene32) {
        for (i = 0; i < N; i++) {
          var c = px[i];
          var r = LR[(c >> 16) & 255];
          var g = LG[(c >> 8) & 255];
          var b = LB[c & 255];
          scene32[i] = 0xff000000 | (b << 16) | (g << 8) | r;
          shown[i] = (r << 16) | (g << 8) | b;
        }
      } else {
        applyLut(px, lut, shown);
        if (sceneImg) {
          var d = sceneImg.data;
          for (i = 0; i < N; i++) {
            var s = shown[i];
            var j = i * 4;
            d[j] = (s >> 16) & 255;
            d[j + 1] = (s >> 8) & 255;
            d[j + 2] = s & 255;
          }
        }
      }
      if (sceneG && sceneImg) {
        sceneG.putImageData(sceneImg, 0, 0);
        counts.scene++;
      }
    }

    function sizeFade(cols, side) {
      if (cols === fadeCols && side === fadeSide) return;
      fadeCols = cols;
      fadeSide = side;
      paintedFade.fill(-1);
      if (cols > 0 && fadeCv.width !== cols) {
        fadeCv.width = cols;
        fadeImg = image(fadeG, cols, SCENE);
      }
    }

    function paintEdges(force) {
      if (!geo || !hasFrame) return;
      var band = st.band;
      var y;
      if (geo.band) {
        var changed = !!force;
        for (y = 0; y < SCENE; y++) {
          var i3 = y * 3;
          var c = (Math.round(band[i3]) << 16) | (Math.round(band[i3 + 1]) << 8) | Math.round(band[i3 + 2]);
          if (c !== paintedRows[y]) {
            paintedRows[y] = c;
            changed = true;
          }
        }
        if (changed && bandG && bandImg) {
          var bd = bandImg.data;
          for (y = 0; y < SCENE; y++) {
            var v = paintedRows[y];
            bd[y * 4] = (v >> 16) & 255;
            bd[y * 4 + 1] = (v >> 8) & 255;
            bd[y * 4 + 2] = v & 255;
          }
          bandG.putImageData(bandImg, 0, 0);
          counts.band++;
        }
      }
      if (geo.fade && fadeCols > 0) {
        var n = fadeCols;
        fadeColors(band, shown, fadeSide, n, fadeBuf);
        var fchanged = !!force;
        for (var i = 0; i < SCENE * n; i++) {
          if (fadeBuf[i] !== paintedFade[i]) {
            paintedFade[i] = fadeBuf[i];
            fchanged = true;
          }
        }
        if (fchanged && fadeG && fadeImg) {
          var fd = fadeImg.data;
          for (var q = 0; q < SCENE * n; q++) {
            var w = paintedFade[q];
            fd[q * 4] = (w >> 16) & 255;
            fd[q * 4 + 1] = (w >> 8) & 255;
            fd[q * 4 + 2] = w & 255;
          }
          fadeG.putImageData(fadeImg, 0, 0);
          counts.fade++;
        }
      }
    }

    function draw(frame, info) {
      if (dead) return;
      var t0 = perfNow();
      var px = pixelsOf(frame);
      var inf = info || {};
      var snap = !hasFrame || !!inf.snap || !!inf.first || t0 - lastAt > SLOW_MS;
      lastAt = t0;
      lutMoved = false;
      if (snap) expose(px, true);
      else if (frames % DIM_EVERY === 0) expose(px, false);
      paintScene(px);
      var wasFrame = hasFrame;
      hasFrame = true;
      if (snap || inf.fading || lutMoved || frames % BAND_EVERY === 0) {
        bandTarget(st, shown);
        counts.targets++;
      }
      bandEase(st, snap ? 1 : BAND_EASE);
      if (snap) counts.snaps++;
      paintEdges(false);
      if (!wasFrame) display();
      frames++;
      lastCost = perfNow() - t0;
      costs[costN % COST_WINDOW] = lastCost;
      costN++;
    }

    function fitNow(cssW, cssH, dpr) {
      var fi = { cssW: cssW, cssH: cssH, dpr: dpr };
      INPUT_KEYS.forEach(function (key) { if (input[key] !== undefined) fi[key] = input[key]; });
      return fit(fi);
    }

    function setViewport(cssW, cssH, dpr, patch) {
      if (dead) return geo;
      if (patch && typeof patch === 'object') {
        INPUT_KEYS.forEach(function (key) {
          if (Object.prototype.hasOwnProperty.call(patch, key)) {
            if (patch[key] === undefined) delete input[key];
            else input[key] = patch[key];
          }
        });
      }
      var d = Number(dpr) > 0 ? Number(dpr) : (win && win.devicePixelRatio) || 1;
      var w = Number(cssW);
      var h = Number(cssH);
      // innerWidth / innerHeight are rounded CSS px: at a fractional ratio (777.6 px reads 778) they can miss the
      // device size by a pixel; the visual viewport has the exact size whenever it is not pinch-zoomed
      var vv = win && win.visualViewport;
      if (vv && Math.abs((Number(vv.scale) || 1) - 1) < 1e-6 && Math.abs(vv.width - w) < 1 && Math.abs(vv.height - h) < 1) {
        w = vv.width;
        h = vv.height;
      }
      var g = fitNow(w, h, d);
      geo = g;
      place(sceneCv, { x: g.scene.x, y: g.scene.y, w: g.scene.size, h: g.scene.size }, g.dpr);
      if (g.band) place(bandCv, g.band, g.dpr);
      if (g.fade) {
        sizeFade(g.fade.cols, g.edge);
        place(fadeCv, g.fade, g.dpr);
      } else {
        sizeFade(0, null);
      }
      setVeil(g.gradient.css);
      if (hasFrame) {
        paintedRows.fill(-1);
        paintEdges(true);
      }
      display();
      return g;
    }

    function shade(o2) {
      var p = o2 || {};
      if (Object.prototype.hasOwnProperty.call(p, 'statusTop')) {
        if (p.statusTop === undefined) delete input.statusTop;
        else input.statusTop = p.statusTop;
      }
      if (Object.prototype.hasOwnProperty.call(p, 'caption')) {
        if (p.caption === undefined) delete input.caption;
        else input.caption = p.caption;
      }
      if (!geo) return null;
      var g = fitNow(geo.cssW, geo.cssH, geo.dpr);
      geo.statusTop = g.statusTop;
      geo.caption = g.caption;
      geo.gradient = g.gradient;
      setVeil(geo.gradient.css);
      return geo.gradient;
    }

    function costStats() {
      var n = Math.min(costN, COST_WINDOW);
      var list = Array.prototype.slice.call(costs, 0, n).sort(function (a, b) { return a - b; });
      return {
        last: lastCost,
        n: n,
        p50: n ? list[Math.floor(n * 0.5)] : 0,
        p95: n ? list[Math.min(n - 1, Math.floor(n * 0.95))] : 0,
        max: n ? list[n - 1] : 0
      };
    }

    function info() {
      return {
        geo: geo,
        k: geo ? geo.k : 0,
        side: geo ? geo.side : input.side || 'left',
        mix: 1 - keep,
        keep: keep,
        luma: luma,
        frames: frames,
        paints: { scene: counts.scene, band: counts.band, fade: counts.fade },
        targets: counts.targets,
        exposures: counts.exposures,
        snaps: counts.snaps,
        nudges: nudges,
        cost: costStats(),
        visible: { scene: sceneCv.style.display !== 'none', band: bandCv.style.display !== 'none', fade: fadeCv.style.display !== 'none' }
      };
    }

    function pixels() {
      return {
        frame: Array.prototype.slice.call(shown),
        rows: Array.prototype.slice.call(paintedRows),
        fade: Array.prototype.slice.call(paintedFade, 0, SCENE * fadeCols),
        cols: fadeCols,
        edge: geo ? geo.edge : null
      };
    }

    function destroy() {
      if (dead) return;
      dead = true;
      if (ro) {
        try {
          ro.disconnect();
        } catch (e) {
          /* gone already */
        }
      }
      ro = null;
      [bandCv, sceneCv, fadeCv, veil].forEach(function (el) { if (el.parentNode) el.parentNode.removeChild(el); });
    }

    return {
      canvas: sceneCv,
      band: bandCv,
      fade: fadeCv,
      canvases: [bandCv, sceneCv, fadeCv],
      gradient: veil,
      root: rootEl,
      setViewport: setViewport,
      shade: shade,
      draw: draw,
      isScene: function (t) { return !!t && t === sceneCv; },
      geo: function () { return geo; },
      info: info,
      pixels: pixels,
      destroy: destroy
    };
  }

  var api = {
    SCENE: SCENE,
    MAX_CROP: MAX_CROP,
    TOP_SHARE: TOP_SHARE,
    FADE: FADE,
    FADE_T: Array.prototype.slice.call(FADE_T),
    BAND_DIM: BAND_DIM,
    BAND_EASE: BAND_EASE,
    DIM_EASE: DIM_EASE,
    DIM_EVERY: DIM_EVERY,
    BAND_EVERY: BAND_EVERY,
    BG: BG,
    fit: fit,
    columnRule: columnRule,
    meanLuma: meanLuma,
    dim: dim,
    dimLut: dimLut,
    dimColor: dimColor,
    dimFrame: dimFrame,
    bands: bands,
    gradient: gradient,
    gradientAlpha: gradientAlpha,
    compose: compose,
    mountScene: mountScene
  };
  PCD.bleed = api;
  return api;
});
