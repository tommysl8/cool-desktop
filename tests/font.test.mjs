// src/shared/pcd-font.js: the one-size-per-screen ladder (and the sizes it gives at common screens), the cell floored
// to device pixels, the FontFace load with its 250 ms Consolas fallback, apply(), and the glyph gate's maths. The real
// browser measurements (TermMono and Consolas, every safe glyph, the cells) are in tests/glyph-gate.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { sandbox, tokensScript, plain } from './look-load.mjs';

const ADV = 1200 / 2048; // Cascadia Mono's advance per em (58.59 at 100 px)

/** A page-like sandbox with fake FontFace, document.fonts and a canvas that knows the two fonts' 'M' widths. */
function fontPage({ loadMs = 5, reject = false, noFontFace = false, localCascadia = false } = {}) {
  const added = [];
  const created = [];
  let fontsAdded = false;
  const ctx2d = {
    font: '10px sans-serif',
    measureText(text) {
      const size = parseFloat(this.font) || 10;
      // the first family of the font string that exists: TermMono once added, a local Cascadia Mono, Consolas
      const cascadia = (/TermMono/.test(this.font) && fontsAdded) || (localCascadia && /Cascadia Mono/.test(this.font));
      const em = cascadia ? ADV : /Consolas/.test(this.font) ? 1126 / 2048 : 0.5;
      return { width: Array.from(text).length * size * em };
    },
  };
  class FakeFontFace {
    constructor(family, source, descriptors) {
      this.family = family;
      this.source = source;
      this.descriptors = descriptors;
      created.push(this);
    }
    load() {
      return new Promise((resolve, rejectP) => setTimeout(() => (reject ? rejectP(new Error('NetworkError: font not found')) : resolve(this)), loadMs));
    }
  }
  const document = {
    fonts: { add(f) { added.push(f); fontsAdded = true; }, ready: Promise.resolve() },
    createElement: (tag) => (tag === 'canvas' ? { getContext: () => ctx2d } : null),
  };
  const globals = { document, performance: { now: () => Date.now() } };
  if (!noFontFace) globals.FontFace = FakeFontFace;
  const ctx = sandbox(['src/shared/pcd-font.js'], globals);
  return { F: ctx.PCD.font, added, created };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('constants: TermMono first, Consolas fallback, the bundled file, 250 ms', () => {
  const F = sandbox(['src/shared/pcd-font.js']).PCD.font;
  assert.equal(F.FAMILY, 'TermMono');
  assert.equal(F.FALLBACK, 'Consolas');
  assert.equal(F.FILE, 'CascadiaMono-wght.ttf');
  assert.equal(F.STACK, "TermMono, 'Cascadia Mono', Consolas, monospace");
  assert.equal(F.TIMEOUT_MS, 250);
  assert.equal(F.classify(58.59), 'cascadia');
  assert.equal(F.classify(54.98), 'consolas');
  assert.equal(F.classify(60.5), 'other');
  assert.equal(F.classify(null), 'other');
  assert.equal(F.mWidth100(), null, 'no canvas in Node');
});

for (const withTokens of [false, true]) {
  test(`step(): the sizes at common screens (${withTokens ? 'PCD.TOKENS.type' : 'the built-in table'})`, async () => {
    const F = sandbox([...(withTokens ? [await tokensScript()] : []), 'src/shared/pcd-font.js']).PCD.font;
    const cases = [
      // [cssH, dpr, profile, step (device px), css px]
      [800, 2, 'newtab', 36, 18], [620, 2, 'newtab', 28, 14], [500, 2, 'newtab', 24, 12], [500, 1, 'newtab', 14, 14],
      [1080, 1, 'wallpaper', 24, 24], [1440, 1, 'wallpaper', 28, 28], [2160, 1, 'wallpaper', 48, 48], [800, 2, 'wallpaper', 32, 16],
      [800, 2, 'still', 32, 16], [1440, 1, 'still', 28, 28],
      [969, 1, 'newtab', 24, 24], [1329, 1, 'newtab', 32, 32], [2049, 1, 'newtab', 48, 48],
    ];
    for (const [cssH, dpr, profile, step, css] of cases) {
      assert.equal(F.step(cssH, dpr, profile), step, `${profile} ${cssH}@${dpr}`);
      assert.equal(F.cssPx(F.step(cssH, dpr, profile), dpr), css);
    }
    assert.equal(F.step(1440, 1, 'wallpaper'), 28, 'a tie (30 between 28 and 32) goes to the smaller step');
    assert.equal(F.step(300, 1, 'newtab'), 14, 'never under the floor');
    assert.equal(F.step(300, 1, 'wallpaper'), 16);
    assert.equal(F.step(400, 1.25, 'newtab'), 16, 'new tab floor at 1.25: ceil(15) -> 16');
    assert.equal(F.step(99999, 1, 'wallpaper'), 64);
    assert.equal(F.step(800, 2, 'something else'), 32, 'unknown profiles are the wallpaper');
    assert.deepEqual(plain(F.ladder('newtab')), [14, 16, 20, 24, 28, 32, 36, 40, 48, 56, 64]);
    assert.deepEqual(plain(F.ladder('wallpaper')), [16, 20, 24, 28, 32, 36, 40, 48, 56, 64]);
    assert.notEqual(F.ladder('still'), F.ladder('still'), 'a copy each time');
  });
}

test('floorPx and smaller(): the layout steps down the ladder, never under 12 CSS px on the new tab', () => {
  const F = sandbox(['src/shared/pcd-font.js']).PCD.font;
  assert.equal(F.floorPx('newtab', 1), 14);
  assert.equal(F.floorPx('newtab', 1.1), 14);
  assert.equal(F.floorPx('newtab', 1.25), 15);
  assert.equal(F.floorPx('newtab', 1.5), 18);
  assert.equal(F.floorPx('newtab', 2), 24);
  assert.equal(F.floorPx('wallpaper', 2), 16);
  assert.equal(F.smaller(36, 'newtab', 2), 32);
  assert.equal(F.smaller(28, 'newtab', 2), 24);
  assert.equal(F.smaller(24, 'newtab', 2), null);
  assert.equal(F.smaller(16, 'newtab', 1), 14);
  assert.equal(F.smaller(14, 'newtab', 1), null);
  assert.equal(F.smaller(24, 'wallpaper', 1), 20);
  assert.equal(F.smaller(16, 'wallpaper', 1), null);
});

test('cellFrom(): floored to whole device pixels with a letter-spacing correction', () => {
  const F = sandbox(['src/shared/pcd-font.js']).PCD.font;
  // advance = 1200/2048 em; the line heights are what Chrome lays out (tools/glyph-gate.mjs measures them)
  const cases = [[18, 2, 20.5, 10.5, 20.5], [24, 1, 28, 14, 28], [28, 1, 33, 16, 33], [48, 1, 56, 28, 56], [16, 2, 19, 9, 19], [12, 2, 14, 7, 14], [14, 1, 16, 8, 16], [18, 2, 20.92, 10.5, 20.5], [18, 1, 20.92, 10, 20]];
  for (const [size, dpr, line, w, h] of cases) {
    const c = F.cellFrom(size * ADV, line, dpr);
    assert.equal(c.w, w, `${size}px@${dpr} w`);
    assert.equal(c.h, h, `${size}px@${dpr} h`);
    assert.ok(Number.isInteger(c.wDev) && Number.isInteger(c.hDev));
    assert.equal(c.w * dpr, c.wDev);
    assert.ok(c.ls <= 0 && c.ls > -1 / dpr, `letter-spacing ${c.ls} is a fraction of a device pixel`);
    assert.ok(Math.abs(c.adv + c.ls - c.w) < 1e-12);
  }
  assert.equal(F.cellFrom(14, 28, 1).ls, 0, 'an exact advance needs no correction');
  assert.equal(F.cellFrom(0.1, 0.1, 1).wDev, 1, 'never a zero cell');
  assert.equal(F.cellFrom(9.375, 19, 0).dpr, 1, 'a bad dpr counts as 1');
});

test('measureCell(): 10 x 100 M in a hidden <pre> that inherits the host font (the UA monospace is overridden)', () => {
  const log = [];
  const host = {
    appendChild(el) { log.push(['append', el]); },
    removeChild(el) { log.push(['remove', el]); },
  };
  let probe = null;
  const document = {
    body: host,
    createElement(tag) {
      probe = { tag, style: { cssText: '' }, textContent: '', getBoundingClientRect: () => ({ width: 100 * 18 * ADV, height: 10 * 20.5 }) };
      return probe;
    },
  };
  const F = sandbox(['src/shared/pcd-font.js'], { document, devicePixelRatio: 2 }).PCD.font;
  const c = F.measureCell();
  assert.equal(probe.tag, 'pre');
  assert.match(probe.style.cssText, /font-family:inherit;/);
  assert.match(probe.style.cssText, /font-size:inherit;/);
  assert.match(probe.style.cssText, /line-height:normal;/);
  assert.match(probe.style.cssText, /letter-spacing:0;/);
  assert.match(probe.style.cssText, /visibility:hidden;/);
  assert.equal(probe.textContent.split('\n').length, 10);
  assert.ok(probe.textContent.split('\n').every((r) => r === 'M'.repeat(100)));
  assert.deepEqual(log.map((e) => e[0]), ['append', 'remove'], 'the probe is removed again');
  assert.equal(c.w, 10.5);
  assert.equal(c.h, 20.5);
  assert.equal(c.dpr, 2);
  F.measureCell({ sizePx: 24, family: 'Consolas', weight: 600, dpr: 1, host });
  assert.match(probe.style.cssText, /font-family:Consolas;font-size:24px;font-weight:600;/);
  const none = sandbox(['src/shared/pcd-font.js']).PCD.font;
  assert.equal(none.measureCell(), null, 'no DOM');
});

test('apply(): the font size and --cell-w, --cell-h, --cell-ls', () => {
  const F = sandbox(['src/shared/pcd-font.js']).PCD.font;
  const props = {};
  const el = { style: { setProperty: (k, v) => { props[k] = v; } } };
  const cell = F.cellFrom(18 * ADV, 20.5, 2);
  F.apply(el, cell, 18);
  assert.equal(el.style.fontSize, '18px');
  assert.equal(props['--cell-w'], '10.5px');
  assert.equal(props['--cell-h'], '20.5px');
  assert.equal(props['--cell-ls'], `${cell.ls}px`);
  F.apply(null, cell, 18);
});

test('load(): FontFace.load, then fonts.add and fonts.ready; one load per base; info and state()', async () => {
  const { F, added, created } = fontPage({ loadMs: 5 });
  assert.equal(F.state(), null);
  const p = F.load();
  assert.equal(F.load(), p, 'repeated calls share one load');
  const info = await p;
  assert.equal(info.loaded, true);
  assert.equal(info.family, 'TermMono');
  assert.equal(info.active, 'cascadia');
  assert.ok(Math.abs(info.mWidth100 - 58.59) < 0.01);
  assert.equal(info.timedOut, false);
  assert.equal(info.error, null);
  assert.equal(added.length, 1);
  assert.equal(created.length, 1);
  assert.equal(created[0].family, 'TermMono');
  assert.equal(created[0].source, 'url("fonts/CascadiaMono-wght.ttf") format("truetype")');
  assert.equal(created[0].descriptors.weight, '200 700');
  assert.equal(F.state(), info);
  const other = fontPage().F;
  other.load('../fonts');
  assert.ok(true);
});

test('load(): past the timeout the page carries on in Consolas and never switches font later', async () => {
  const { F, added } = fontPage({ loadMs: 120 });
  const info = await F.load('fonts/', { timeoutMs: 30 });
  assert.equal(info.loaded, false);
  assert.equal(info.family, 'Consolas');
  assert.equal(info.active, 'consolas');
  assert.equal(info.timedOut, true);
  assert.match(info.error, /timed out after 30 ms/);
  await sleep(200);
  assert.equal(added.length, 0, 'the late font is not added without onLate');
  assert.equal(F.state().family, 'Consolas');
  // a Windows with Cascadia Mono installed renders that through the stack: active says so
  const local = await fontPage({ loadMs: 120, localCascadia: true }).F.load('fonts/', { timeoutMs: 30 });
  assert.equal(local.family, 'Consolas');
  assert.equal(local.active, 'cascadia');
});

test('load(): a late font with onLate is added once and reported (the console re-measures)', async () => {
  const { F, added } = fontPage({ loadMs: 120 });
  const late = [];
  const info = await F.load('fonts/', { timeoutMs: 30, onLate: (i) => late.push(i) });
  assert.equal(info.family, 'Consolas');
  await sleep(200);
  assert.equal(added.length, 1);
  assert.equal(late.length, 1);
  assert.equal(late[0].loaded, true);
  assert.equal(late[0].late, true);
  assert.equal(late[0].family, 'TermMono');
  assert.equal(F.state(), late[0]);
});

test('load(): a failed download or no FontFace API resolves Consolas, never rejects', async () => {
  const failed = await fontPage({ reject: true }).F.load();
  assert.equal(failed.loaded, false);
  assert.equal(failed.family, 'Consolas');
  assert.match(failed.error, /NetworkError/);
  const none = await fontPage({ noFontFace: true }).F.load();
  assert.equal(none.family, 'Consolas');
  assert.equal(none.error, 'FontFace API unavailable');
  const bare = await sandbox(['src/shared/pcd-font.js']).PCD.font.load();
  assert.equal(bare.family, 'Consolas');
});

test('glyphGate(): |measureText(ch) - cellW| < tolerance per family; duplicates and line breaks skipped', () => {
  const F = sandbox(['src/shared/pcd-font.js']).PCD.font;
  const widths = { TermMono: 9.375, Consolas: 8.796875 };
  const ctx = {
    font: '',
    measureText(t) {
      const fam = /Consolas/.test(this.font) ? 'Consolas' : 'TermMono';
      const w = widths[fam];
      if (t.length > 1) return { width: t.length * w };
      if (t === '╭' && fam === 'Consolas') return { width: 9.6 };
      if (t === '•') return { width: w + 0.005 };
      return { width: w };
    },
  };
  const res = plain(F.glyphGate('ab╭\n╭•a', { ctx }));
  assert.equal(res.length, 2);
  assert.deepEqual(res.map((r) => r.family), ['TermMono', 'Consolas']);
  assert.equal(res[0].tested, 4);
  assert.equal(res[0].pass, true);
  assert.equal(res[0].cellW, 9.375);
  assert.equal(res[1].pass, false);
  assert.deepEqual(res[1].fails.map((f) => f.cp), ['U+256D']);
  assert.ok(Math.abs(res[1].fails[0].delta - (9.6 - 8.796875)) < 1e-9);
  const strict = F.glyphGate('•', { ctx, tolerance: 0.001, families: ['TermMono'] });
  assert.equal(strict[0].pass, false);
  assert.equal(ctx.font, '', 'the context font is restored');
  assert.throws(() => sandbox(['src/shared/pcd-font.js']).PCD.font.glyphGate('a'), /canvas 2D context/);
});
