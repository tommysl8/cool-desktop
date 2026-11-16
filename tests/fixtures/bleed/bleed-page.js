// Test page for PCD.bleed (src/shared/pcd-bleed.js): the full-bleed scene layer alone, frozen or live.
// Query: side=left|right  at=YYYY-MM-DDTHH:MM (local)  theme=<id>|auto  phase=dawn|day|sunset|night (the theme's own
// hours from PCD.ANCHORS; wins over the time in at)  veil=0|1  live=0|1 (PCD.host paints through layer.draw)
// bottom=<CSS px taskbar reserve>  caption=0|1 (a caption over the scene and its shade)  perf=1 (15 fps)
// Test hooks: window.__bleed { layer, host, report(), redraw(), freeze(), thaw() }; <html data-ready="1">.
(function () {
  'use strict';
  var q = new URLSearchParams(location.search);
  var PC = window.PixelClock;
  var PCD = window.PCD;
  var side = q.get('side') === 'right' ? 'right' : 'left';
  var live = q.get('live') === '1';
  var bottom = Number(q.get('bottom') || 0);
  var captionOn = q.get('caption') === '1';
  var errors = [];
  window.addEventListener('error', function (e) { errors.push(String(e.message || e.error)); });

  function parseLocal(s) {
    var m = /^(\d{4})-(\d\d)-(\d\d)(?:T(\d\d):(\d\d))?$/.exec(s || '');
    return m ? new Date(+m[1], +m[2] - 1, +m[3], +(m[4] || 12), +(m[5] || 0), 0, 0) : null;
  }
  var at = parseLocal(q.get('at')) || new Date(2026, 10, 15, 20, 40, 0, 0);
  var themeArg = q.get('theme') || 'auto';
  var id = themeArg !== 'auto' && PC.themeById(themeArg) ? themeArg : PCD.engine.autoId(PC, at.getFullYear(), at.getMonth() + 1, at.getDate());
  var phase = q.get('phase');
  if (phase && PCD.ANCHORS && PCD.ANCHORS[id]) {
    var an = PCD.ANCHORS[id];
    var h = phase === 'dawn' ? an.rise : phase === 'sunset' ? an.set : phase === 'day' ? (an.rise + an.set) / 2 : 22.5;
    at = new Date(at.getFullYear(), at.getMonth(), at.getDate(), Math.floor(h), Math.round((h % 1) * 60), 0, 0);
  }

  var rootEl = document.getElementById('bleed');
  var layer = PCD.bleed.mountScene(rootEl, { side: side, bottomCss: bottom });
  if (q.get('veil') === '0') layer.gradient.style.display = 'none';

  var cap = document.getElementById('caption');
  function phaseName() {
    if (phase) return phase;
    var an = PCD.ANCHORS && PCD.ANCHORS[id];
    var hf = at.getHours() + at.getMinutes() / 60;
    return an && PCD.sun ? PCD.sun.phase(hf, an) : 'night';
  }
  function layout() {
    var g = layer.setViewport(window.innerWidth, window.innerHeight, window.devicePixelRatio);
    if (captionOn) {
      var cell = g.column.cell;
      var text = PC.themeById(id).name.toLowerCase() + ' · ' + phaseName();
      var C = Math.floor(g.cssW / cell.w);
      var R = Math.floor(g.column.h / cell.h);
      var row = R - 1 - (R >= 18 ? 1 : 0);
      var mx = C >= 100 ? 4 : C >= 60 ? 3 : 2;
      var c0 = side === 'left' ? C - mx - text.length : mx;
      cap.textContent = text;
      cap.style.font = (cell.h * 0.8).toFixed(1) + 'px Consolas, monospace';
      cap.style.left = c0 * cell.w + 'px';
      cap.style.top = row * cell.h + 'px';
      cap.style.lineHeight = cell.h + 'px';
      cap.style.display = 'block';
      var w = cap.getBoundingClientRect().width;
      layer.shade({ statusTop: row * cell.h, caption: { x: c0 * cell.w, y: row * cell.h, w: w, h: cell.h } });
    }
    return g;
  }

  var host = null;
  var scene = null;
  var fb = null;
  var frozen = false;
  if (live) {
    var t0 = performance.now();
    host = PCD.host.create({
      canvas: layer.canvas,
      paint: layer.draw,
      sceneClock: 'none',
      profile: side === 'left' ? 'newtab' : 'wallpaper',
      settings: { theme: id, performance: q.get('perf') === '1' ? 'on' : 'off', reducedMotion: 'off' },
      now: function () { return at.getTime() + (performance.now() - t0); },
      watch: { battery: false, motion: false }
    });
    layout();
    host.start();
  } else {
    PCD.hook.mode = 'none';
    scene = PCD.engine.createScene({ PC: PC, warmup: 90 });
    scene.want(id, { fade: false });
    var ctx = PCD.engine.ctx(at, { clock24: false });
    for (var i = 0; i < 30; i++) scene.step(ctx);
    fb = scene.frame(ctx);
    layout();
    layer.draw(fb, { snap: true });
  }
  window.addEventListener('resize', layout);

  window.__bleed = {
    layer: layer,
    host: host,
    id: id,
    at: at.getTime(),
    errors: errors,
    report: function () {
      var g = layer.geo();
      return {
        cssW: window.innerWidth, cssH: window.innerHeight, dpr: window.devicePixelRatio, id: id, side: side,
        geo: g, info: layer.info(), pixels: layer.pixels(), errors: errors.slice(),
        boxes: layer.canvases.map(function (c) {
          var r = c.getBoundingClientRect();
          return { cls: c.className, display: c.style.display, x: r.left, y: r.top, w: r.width, h: r.height, cw: c.width, ch: c.height };
        }),
        stats: host ? host.stats() : null
      };
    },
    // Stop the live loop so a screenshot sees exactly the frame pixels() reports.
    freeze: function () { if (host) host.pause('test'); frozen = true; return true; },
    thaw: function () { if (host) host.resume('test'); frozen = false; return true; },
    redraw: function (snap) { if (fb) layer.draw(fb, { snap: !!snap }); return layer.info(); },
    // the engine's own frame (before the dimming), for the still's compose() in Node
    raw: function () { return fb ? Array.prototype.slice.call(fb.px) : null; },
    // ms per draw over n back-to-back draws of the frozen frame (the page's timer is too coarse for one draw)
    batch: function (n) {
      var t = performance.now();
      for (var i = 0; i < n; i++) layer.draw(fb, i === 0 ? { snap: false } : null);
      return (performance.now() - t) / n;
    },
    frozen: function () { return frozen; }
  };
  document.documentElement.setAttribute('data-ready', '1');
})();
