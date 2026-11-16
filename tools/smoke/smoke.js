/* Engine smoke page (tools/smoke.mjs drives it headless). Classic script, no build step.
 *
 * window.__smoke.render(opts) runs one PCD.engine scene over the synced clock engine and paints its frame into a
 * 64x64 canvas that CSS scales by a whole number k of device pixels (image-rendering: pixelated), letterboxed
 * over the match colour mix(edge, bg, 0.7). It resolves what the page did (k, the device rect, the measured
 * device-pixel box, the 4096 frame colours) so the runner can check the screenshot pixel by pixel.
 *   opts: { date 'YYYY-MM-DD', hour (decimal, local), theme ('auto' or an id), mode ('device'|'date'|'none'),
 *           layout ('fit'|'large'), steps (default 30), shake (bool), shakeSteps (default 12), label (phase text) }
 */
(function () {
  'use strict';

  var PC = globalThis.PixelClock;
  var PCD = globalThis.PCD;
  var BG = 0x141016;
  var DOT = ' · ';
  var canvas = document.getElementById('scene');
  var caption = document.getElementById('caption');
  var g = canvas.getContext('2d');
  var image = g.createImageData(64, 64);
  var violations = [];
  var lastBox = null;

  document.addEventListener('securitypolicyviolation', function (e) {
    violations.push(e.violatedDirective + ' ' + e.blockedURI);
  });

  var ro = new ResizeObserver(function (entries) {
    var e = entries[entries.length - 1];
    var s = e.devicePixelContentBoxSize && e.devicePixelContentBoxSize[0];
    lastBox = s ? [s.inlineSize, s.blockSize] : null;
  });
  ro.observe(canvas, { box: 'device-pixel-content-box' });

  function frames(n) {
    return new Promise(function (resolve) {
      var left = n;
      function tick() { if (--left <= 0) resolve(); else requestAnimationFrame(tick); }
      requestAnimationFrame(tick);
    });
  }

  function hex(c) {
    return '#' + (c >>> 0).toString(16).padStart(6, '0');
  }

  function clockText(h, m) {
    return (h % 12 || 12) + ':' + String(m).padStart(2, '0') + (h < 12 ? ' am' : ' pm');
  }

  function dateText(y, m, d) {
    return (PC.WEEKDAYS[PC.weekday(y, m, d)] + ' ' + PC.MONTHS[m - 1] + ' ' + d).toLowerCase();
  }

  // Whole-number layout in device pixels: 'large' fills the shorter side, 'fit' leaves room for the caption.
  function layout(mode, dpr) {
    var W = Math.round(innerWidth * dpr);
    var H = Math.round(innerHeight * dpr);
    var k;
    var room;
    if (mode === 'large') {
      k = Math.max(2, Math.floor(Math.min(W, H) / 64));
      room = H;
    } else {
      room = H - Math.round(40 * dpr);
      k = Math.max(2, Math.floor(Math.min(W * 0.9, room * 0.9) / 64));
    }
    var size = 64 * k;
    return { W: W, H: H, k: k, size: size, x: Math.floor((W - size) / 2), y: Math.floor((room - size) / 2) };
  }

  async function place(L, dpr) {
    var css = L.size / dpr;
    canvas.style.left = L.x / dpr + 'px';
    canvas.style.top = L.y / dpr + 'px';
    canvas.style.width = css + 'px';
    canvas.style.height = css + 'px';
    await frames(2);
    var nudges = 0;
    // Nudge the CSS size by 1/dpr until the device-pixel box is 64k (at most 2 tries).
    // Only a box within 2 px of 64k is trusted: under CDP ratio emulation Chrome reports it in CSS px instead.
    var near = function () { return lastBox && Math.abs(lastBox[0] - L.size) <= 2 && Math.abs(lastBox[1] - L.size) <= 2; };
    while (near() && (lastBox[0] !== L.size || lastBox[1] !== L.size) && nudges < 2) {
      css += (L.size > lastBox[0] ? 1 : -1) / dpr;
      canvas.style.width = css + 'px';
      canvas.style.height = css + 'px';
      nudges++;
      await frames(2);
    }
    return { css: css, nudges: nudges, box: lastBox ? lastBox.slice() : null };
  }

  function placeCaption(text, L, dpr, mode) {
    caption.textContent = text;
    caption.style.visibility = 'visible';
    var w = caption.getBoundingClientRect().width;
    var h = caption.getBoundingClientRect().height;
    var left;
    var top;
    if (mode === 'large') {
      left = 24;
      top = L.H / dpr - 24 - h;
      if (left + w > L.x / dpr - 24) caption.style.visibility = 'hidden';
    } else {
      left = Math.round((L.W / dpr - w) / 2);
      top = (L.y + L.size) / dpr + 14;
    }
    caption.style.left = left + 'px';
    caption.style.top = top + 'px';
    if (caption.style.visibility === 'hidden') return null;
    var r = caption.getBoundingClientRect();
    return [Math.floor(r.left * dpr), Math.floor(r.top * dpr), Math.ceil(r.right * dpr), Math.ceil(r.bottom * dpr)];
  }

  async function render(opts) {
    var o = opts || {};
    var parts = String(o.date || '2026-11-15').split('-').map(Number);
    var y = parts[0];
    var m = parts[1];
    var d = parts[2];
    var hour = typeof o.hour === 'number' ? o.hour : 12;
    var hh = Math.floor(hour);
    var mm = Math.round((hour - hh) * 60);
    var when = new Date(y, m - 1, d, hh, mm, 0, 0);
    var ctx = PCD.engine.ctx(when, { clock24: false });
    var id = !o.theme || o.theme === 'auto' ? PCD.engine.autoId(PC, y, m, d) : o.theme;
    var mode = o.mode || 'device';
    PCD.hook.mode = mode;
    PCD.hook.before = null;
    var calls0 = PCD.hook.calls;
    var scene = PCD.engine.createScene({ PC: PC });
    if (!scene.want(id, { fade: false })) throw new Error('unknown theme ' + id);
    var steps = o.steps == null ? 30 : o.steps;
    for (var i = 0; i < steps; i++) scene.step(ctx);
    if (o.shake) {
      scene.shake();
      var n = o.shakeSteps == null ? 12 : o.shakeSteps;
      for (var j = 0; j < n; j++) scene.step(ctx);
    }
    var frame = scene.frame(ctx);
    scene.rgba(image.data);
    g.putImageData(image, 0, 0);

    var dpr = window.devicePixelRatio || 1;
    var L = layout(o.layout || 'fit', dpr);
    var match = PC.mix(PCD.hook.edge, BG, 0.7);
    document.body.style.background = hex(match);
    var placed = await place(L, dpr);
    var text = [scene.name.toLowerCase(), dateText(y, m, d), clockText(hh, mm), o.label || ''].filter(Boolean).join(DOT);
    var captionRect = placeCaption(text, L, dpr, o.layout || 'fit');
    var r = canvas.getBoundingClientRect();
    PCD.hook.mode = 'device';
    return {
      id: scene.id,
      name: scene.name,
      mode: mode,
      layout: o.layout || 'fit',
      dpr: dpr,
      viewport: [innerWidth, innerHeight],
      k: L.k,
      canvas: [canvas.width, canvas.height],
      rendering: getComputedStyle(canvas).imageRendering,
      rect: { x: L.x, y: L.y, size: L.size },
      placed: { left: r.left * dpr, top: r.top * dpr, width: r.width * dpr, height: r.height * dpr },
      box: placed.box,
      css: placed.css,
      nudges: placed.nudges,
      match: hex(match),
      matchInt: match,
      edge: hex(PCD.hook.edge),
      colors: { clock: PCD.hook.colors.clock, shadow: PCD.hook.colors.shadow },
      hookCalls: PCD.hook.calls - calls0,
      stats: scene.stats(),
      caption: text,
      captionRect: captionRect,
      frame: Array.from(frame.px),
      violations: violations.slice()
    };
  }

  function info() {
    return {
      themes: PC.themes.map(function (t) { return t.id; }),
      menu: PCD.engine.menu(PC).map(function (t) { return t.id; }),
      hookInstalled: PCD.hook.isInstalled(PC),
      csp: !!document.querySelector('meta[http-equiv="Content-Security-Policy"]'),
      violations: violations.slice()
    };
  }

  window.__smoke = { ready: !!(PC && PCD && PCD.engine && PCD.hook), render: render, info: info };
})();
