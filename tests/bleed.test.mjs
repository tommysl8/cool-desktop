// PCD.bleed (src/shared/pcd-bleed.js), the full-bleed scene layer, in Node.
//   The geometry against the reference implementation (bleed-oracle.mjs) and the measured k table, both column sides,
//   the taskbar reserve, the 10 % crop, whole device px and tiling over a sweep, determinism; the dimming and the
//   bands of real theme frames at night and by day, bit for bit against the reference (the band vote of dithered rows
//   checked on its own); the gradient string and its alpha; the still's compose(); the browser part on a fake DOM
//   (cadence, repaint on change, snaps, shade, sides, destroy); PCD.host's paint seam.
process.env.TZ = 'Europe/Berlin';
import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { loadEngine, ROOT } from './engine-load.mjs';
import { fakeTime, fakeDoc, fakeCanvas } from './look-host-env.mjs';
import { generate } from '../tools/lib/anchors.mjs';
import * as O from './bleed-oracle.mjs';

const { PC, PCD, require } = loadEngine();
for (const f of ['pcd-layout.js', 'pcd-sun.js', 'pcd-ascii.js', 'pcd-host.js', 'pcd-bleed.js']) require(path.join(ROOT, 'src', 'shared', f));
PCD.ANCHORS = PCD.ANCHORS || generate(path.join(ROOT, 'vendor', 'pixelclock'));
const B = PCD.bleed;
const BG = 0x141016;

/** The new tab's cell at a viewport (measured in headless Chrome; termCell is Chrome's layout).
 *  With the width, the console's rule for squarish and portrait windows: the type from min(height, 0.8 x width). */
const newtabCell = (cssH, dpr, cssW) => {
  const c = PCD.layout.termCell(PCD.layout.fontStep(cssW > 0 ? Math.min(cssH, 0.8 * cssW) : cssH, dpr, 'newtab'), dpr);
  return { w: c.w, h: c.h };
};

/** A real frame: a theme at local y-m-d h:m, the scene's own clock off, after `steps` updates. */
function frames(id, when, n = 1, steps = 30) {
  PCD.hook.mode = 'none';
  const scene = PCD.engine.createScene({ PC, warmup: 90 });
  scene.want(id, { fade: false });
  const out = [];
  for (let f = 0; f < n; f++) {
    const ctx = PCD.engine.ctx(new Date(when.getTime() + f * 1000 / 30), { clock24: false });
    for (let s = 0; s < (f ? 1 : steps); s++) scene.step(ctx);
    out.push(Uint32Array.from(scene.frame(ctx).px));
  }
  return out;
}
const at = (y, m, d, h, min = 0) => new Date(y, m - 1, d, h, min);
const lum = (c) => 0.2126 * ((c >> 16) & 255) + 0.7152 * ((c >> 8) & 255) + 0.0722 * (c & 255);
const isInt = (v) => Number.isInteger(v);

// ------------------------------------------------------------------------------------------------ geometry

test('fit: the measured k table (new tab cells), the same k with the column on the right', () => {
  const table = [[1280, 800, 2, 25], [1440, 900, 1, 15], [1920, 1080, 1, 18], [2560, 1440, 1, 25], [3440, 1440, 1, 25], [800, 500, 1, 8], [800, 500, 2, 16]];
  // the measured cells (18 px at 1280x800@2 is 10.5 wide; 14 px at 800x500 is 8)
  const widths = [10.5, 11, 14, 18, 18, 8, 7];
  table.forEach(([w, h, d, k], i) => {
    const cell = newtabCell(h, d);
    assert.equal(cell.w, widths[i], `${w}x${h}@${d}: cell width`);
    const left = B.fit({ cssW: w, cssH: h, dpr: d, side: 'left', cell });
    assert.equal(left.k, k, `${w}x${h}@${d}: k`);
    assert.equal(left.place, 'flush');
    assert.equal(left.scene.x + left.scene.size, left.Wd, 'flush right');
    // the default cell is the same one
    assert.equal(B.fit({ cssW: w, cssH: h, dpr: d }).k, k, 'the default cell (PCD.layout.termCell) gives the same k');
    const right = B.fit({ cssW: w, cssH: h, dpr: d, side: 'right', cell });
    assert.equal(right.k, k, `${w}x${h}@${d}: k with the column on the right`);
    assert.equal(right.scene.x, 0, 'flush left');
    assert.equal(right.scene.y, left.scene.y, 'the same crop');
    assert.equal(right.edge, 'right');
    assert.equal(left.edge, 'left');
  });
});

test('fit: scene geometry and console column over a sweep of sizes and ratios', () => {
  let n = 0;
  for (const d of [1, 1.25, 1.5, 1.75, 2, 3]) {
    for (let w = 320; w <= 5200; w += 173) {
      for (let h = 200; h <= 2200; h += 137) {
        const cell = newtabCell(h, d);
        const L = O.computeLayout(w, h, d, cell);
        const g = B.fit({ cssW: w, cssH: h, dpr: d, side: 'left', cell });
        const name = `${w}x${h}@${d}`;
        assert.equal(g.column.reach, L.consoleRight, name + ' reach');
        assert.equal(g.column.rule.margin, L.mx, name + ' margin');
        assert.equal(g.column.rule.cols, L.colW, name + ' cols');
        assert.equal(g.column.rule.C, L.C, name + ' C');
        assert.equal(g.k, L.k, name + ' k');
        assert.equal(g.scene.x, L.sx + 0, name + ' x'); // + 0: the reference's -Math.round(0) is -0
        assert.equal(g.scene.y, L.sy + 0, name + ' y');
        assert.equal(g.scene.size, L.size, name + ' size');
        assert.equal(g.place, L.place === 'crop' ? 'crop' : 'flush', name + ' place');
        if (L.nL > 0) {
          assert.deepEqual({ ...g.band }, { x: 0, y: L.sy + 0, w: L.sx, h: L.size, cols: 1 }, name + ' band');
          assert.deepEqual({ ...g.fade }, { x: L.sx - L.fadeL * L.k, y: L.sy + 0, w: L.fadeL * L.k, h: L.size, cols: L.fadeL }, name + ' fade');
          assert.equal(g.edgeCols, L.nL);
        } else {
          assert.equal(g.band, null, name + ' no band');
          assert.equal(g.fade, null, name + ' no fade');
        }
        n++;
      }
    }
  }
  assert.ok(n > 800, `${n} layouts compared`);
});

test('fit: the column on the right mirrors the scene; a given reach is honoured', () => {
  for (const [w, h, d] of [[1920, 1080, 1], [1280, 800, 2], [3440, 1440, 1], [1536, 864, 1.25], [800, 500, 1]]) {
    const cell = newtabCell(h, d);
    for (const reach of [300, 480.5, 716]) {
      const L = B.fit({ cssW: w, cssH: h, dpr: d, side: 'left', cell, reach });
      const R = B.fit({ cssW: w, cssH: h, dpr: d, side: 'right', cell, reach });
      const name = `${w}x${h}@${d} reach ${reach}`;
      assert.equal(L.column.reach, reach);
      assert.equal(L.column.rule, null, 'no rule when the reach is given');
      assert.equal(R.k, L.k, name + ' k');
      assert.equal(R.scene.y, L.scene.y, name + ' y');
      if (L.place === 'crop') { assert.equal(R.scene.x, L.scene.x); continue; }
      assert.equal(R.scene.x, 0, name);
      assert.equal(R.scene.x + R.scene.size, L.Wd - L.scene.x, name + ' mirrored');
      assert.deepEqual({ ...R.band }, { x: R.scene.size, y: R.scene.y, w: L.scene.x, h: R.scene.size, cols: 1 }, name + ' band');
      assert.equal(R.fade.x, R.scene.size, name + ' the seam starts at the scene');
      assert.equal(R.fade.cols, L.fade.cols);
      assert.equal(R.column.x, w - reach);
      assert.equal(R.column.xDev, R.Wd - R.column.reachDev);
    }
  }
  // the rule on the right: the text block ends margin cells from the right of the top-left grid
  const r = B.columnRule({ cssW: 1920, cell: { w: 14, h: 28 }, side: 'right' });
  assert.deepEqual({ ...r }, { C: 137, margin: 4, cols: 47, c: 86, x: 1204, w: 658, reach: 716 });
});

test('fit: the taskbar reserve keeps the column clear; the scene still runs under it', () => {
  for (const [w, h, d] of [[1920, 1080, 1], [1280, 800, 2], [2560, 1440, 1], [1536, 864, 1.25]]) {
    const cell = newtabCell(h, d);
    const a = B.fit({ cssW: w, cssH: h, dpr: d, side: 'right', cell });
    const b = B.fit({ cssW: w, cssH: h, dpr: d, side: 'right', cell, bottomCss: 56 });
    assert.equal(b.k, a.k, 'k ignores the reserve');
    assert.deepEqual({ ...b.scene }, { ...a.scene }, 'the scene ignores the reserve');
    assert.ok(b.scene.y + b.scene.size >= b.Hd, 'the scene reaches the bottom edge (under the taskbar)');
    assert.equal(b.column.h, h - 56, 'the column zone stops at the taskbar');
    assert.equal(b.column.bottom, 56);
    assert.equal(b.column.hDev, Math.round((h - 56) * d));
    assert.ok(b.statusTop + cell.h <= h - 56 + 1e-9, 'the default status row sits above the taskbar');
    assert.ok(b.statusTop < a.statusTop, 'and higher than without the reserve');
  }
});

test('fit: whole device px, tiling, the 10 % crop, every size and ratio', () => {
  let n = 0;
  let raised = 0;
  for (const d of [1, 1.25, 1.5, 1.75, 2, 2.5, 3]) {
    for (let w = 160; w <= 7000; w += 211) {
      for (let h = 100; h <= 2600; h += 97) {
        for (const side of ['left', 'right']) {
          const cell = newtabCell(h, d);
          const g = B.fit({ cssW: w, cssH: h, dpr: d, side, cell, bottomCss: side === 'right' ? 56 : 0 });
          const name = `${side} ${w}x${h}@${d}`;
          const s = g.scene;
          for (const v of [g.k, s.x, s.y, s.size, g.Wd, g.Hd, g.column.reachDev, g.column.xDev, g.column.wDev, g.column.hDev]) assert.ok(isInt(v), name + ' integers');
          for (const r of [g.band, g.fade]) if (r) for (const v of [r.x, r.y, r.w, r.h, r.cols]) assert.ok(isInt(v), name + ' rect integers');
          assert.ok(g.k >= 2 && s.size === 64 * g.k, name + ' k');
          assert.ok(s.y <= 0 && s.y + s.size >= g.Hd, name + ' covers the height');
          assert.ok(g.crop.top >= 0 && g.crop.bottom >= 0 && g.crop.top + g.crop.bottom === s.size - g.Hd, name + ' crop');
          assert.ok(Math.abs(g.crop.top - 0.6 * (s.size - g.Hd)) <= 0.5 + 1e-9, name + ' the top gives 60 %');
          if (g.k > g.k0) { raised++; assert.ok(g.crop.share <= 0.1 + 1e-12, `${name} crop ${g.crop.share} after raising k`); }
          if (g.Hd >= 640) assert.ok(g.crop.share <= 0.1 + 1e-12, `${name} crop ${g.crop.share}`);
          assert.ok(g.crop.first >= 0 && g.crop.last <= 63 && g.crop.first <= g.crop.last, name + ' visible rows');
          if (g.place === 'crop') {
            assert.ok(s.size >= g.Wd && s.x <= 0 && s.x + s.size >= g.Wd, name + ' cropped evenly');
            assert.equal(g.band, null);
          } else if (side === 'left') {
            assert.equal(s.x + s.size, g.Wd, name + ' flush right');
            assert.deepEqual([g.band.x, g.band.x + g.band.w], [0, s.x], name + ' the band fills the rest');
            assert.equal(g.fade.x + g.fade.w, s.x, name + ' the seam ends at the scene');
          } else {
            assert.equal(s.x, 0, name + ' flush left');
            assert.deepEqual([g.band.x, g.band.x + g.band.w], [s.size, g.Wd], name + ' the band fills the rest');
            assert.equal(g.fade.x, s.size, name + ' the seam starts at the scene');
          }
          if (g.fade) assert.ok(g.fade.cols >= 1 && g.fade.cols <= 5 && g.fade.w === g.fade.cols * g.k, name + ' seam');
          if (g.band) assert.ok(g.band.y === s.y && g.band.h === s.size, name + ' band rows are scene rows');
          assert.ok(g.column.reach <= w && g.column.w === g.column.reach && g.column.h <= h, name + ' column zone');
          n++;
        }
      }
    }
  }
  assert.ok(n > 10000 && raised > 1000, `${n} layouts, ${raised} with k raised`);
});

test('fit, bands, gradient and compose are deterministic', () => {
  const input = { cssW: 1920, cssH: 1080, dpr: 1, side: 'right', bottomCss: 56, statusTop: 980, caption: { x: 60, y: 980, w: 260, h: 28 } };
  const a = B.fit(input);
  const b = B.fit({ ...input, caption: { ...input.caption } });
  assert.deepEqual(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b)));
  const [f] = frames('autumn', at(2026, 11, 15, 20, 40));
  const x = B.bands(f, { mix: B.dim(f) });
  const y = B.bands(Uint32Array.from(f), { mix: B.dim(f) });
  assert.deepEqual(Array.from(x.rows), Array.from(y.rows));
  assert.deepEqual(Array.from(x.fadeRight), Array.from(y.fadeRight));
  const g = B.fit({ cssW: 320, cssH: 200, dpr: 1, side: 'right' });
  const p = B.compose(null, g, f).img.data;
  const q = B.compose(null, g, Uint32Array.from(f)).img.data;
  assert.ok(Buffer.compare(Buffer.from(p), Buffer.from(q)) === 0, 'compose');
});

test('fit: without a cell, the console\'s type rule (portrait and squarish windows take it from the width)', () => {
  for (const f of ['pcd-core.js', 'pcd-greet.js', 'pcd-console.js']) require(path.join(ROOT, 'src', 'shared', f));
  const K = PCD.console.parts;
  let narrow = 0;
  for (const [w, h, d] of [[900, 1400, 1], [960, 969, 1], [640, 620, 2], [768, 1024, 1], [1080, 1920, 1], [1440, 2560, 1], [420, 760, 2],
    [1280, 620, 2], [1280, 800, 2], [1920, 1080, 1], [800, 500, 1]]) {
    for (const [side, profile] of [['left', 'newtab'], ['right', 'wallpaper'], ['right', 'still']]) {
      const t = PCD.layout.termCell(K.fontStep(h, d, profile, w), d);
      const g = B.fit({ cssW: w, cssH: h, dpr: d, side, profile });
      assert.deepEqual(g.column.cell, { w: t.w, h: t.h }, `${profile} ${w}x${h}@${d}`);
      if (K.fontStep(h, d, profile, w) !== PCD.layout.fontStep(h, d, profile)) narrow++;
    }
  }
  assert.ok(narrow >= 6, `${narrow} portrait or squarish cases take a smaller step than the height alone`);
});

// ------------------------------------------------------------------------------------------------ dimming

test('dim: 0.4 at night up to 0.5 on bright days, eased by 0.3', () => {
  for (let l = 0; l <= 255; l += 0.5) {
    const want = 0.6 - 0.1 * (() => { const t = Math.min(1, Math.max(0, (l - 30) / 140)); return t * t * (3 - 2 * t); })();
    assert.equal(1 - B.dim(l), want, `luma ${l}`);
  }
  assert.equal(B.dim(0), 1 - 0.6);
  assert.equal(B.dim(30), 1 - 0.6);
  assert.equal(B.dim(255), 1 - 0.5);
  // eased from an earlier mix
  const prev = 0.4;
  const target = B.dim(200);
  assert.ok(Math.abs(B.dim(200, prev) - (prev + (target - prev) * 0.3)) < 1e-12);
  // real frames: the oracle's exposure on the same frames (snap) gives the same keep
  const cases = [['autumn', at(2026, 11, 15, 22, 30)], ['autumn', at(2026, 11, 15, 13, 0)], ['winter', at(2027, 1, 12, 13, 5)],
    ['winter', at(2027, 1, 12, 22, 0)], ['summer', at(2026, 7, 18, 14, 10)], ['halloween', at(2026, 10, 31, 21, 10)],
    ['christmas', at(2026, 12, 24, 16, 30)], ['spring', at(2026, 4, 20, 8, 15)]];
  const seen = {};
  for (const [id, when] of cases) {
    const [f] = frames(id, when);
    const ex = O.createExposure();
    ex.expose(f, true);
    assert.equal(1 - B.dim(f), ex.bright, `${id} ${when.getHours()} h: the reference's keep`);
    const lut = B.dimLut(B.dim(f));
    for (let v = 0; v < 256; v++) assert.deepEqual([lut.r[v], lut.g[v], lut.b[v]], [ex.LR[v], ex.LG[v], ex.LB[v]], `${id} table ${v}`);
    assert.deepEqual(Array.from(B.dimFrame(f, B.dim(f))), Array.from(ex.dimmed(f)), `${id} dimmed frame`);
    seen[`${id}@${when.getHours()}`] = +B.dim(f).toFixed(3);
  }
  // night keeps 60 % (mix 0.4), bright snow by day is dimmed hardest
  assert.ok(seen['autumn@22'] <= 0.41 && seen['winter@22'] <= 0.41 && seen['halloween@21'] <= 0.41, JSON.stringify(seen));
  assert.ok(seen['winter@13'] > seen['autumn@13'] && seen['winter@13'] >= 0.45, JSON.stringify(seen));
  for (const v of Object.values(seen)) assert.ok(v >= 0.4 - 1e-9 && v <= 0.5 + 1e-9);
  // the dimmed frame never gets brighter and moves toward bg
  const [f] = frames('summer', at(2026, 7, 18, 14, 10));
  const sh = B.dimFrame(f, 0.5);
  for (let i = 0; i < 4096; i++) assert.ok(lum(sh[i]) <= Math.max(lum(f[i]), lum(BG)) + 1e-9);
  assert.equal(B.dimColor(0xffffff, 0.5), ((Math.round(20 + 235 * 0.5) << 16) | (Math.round(16 + 239 * 0.5) << 8) | Math.round(22 + 233 * 0.5)) >>> 0);
});

// ------------------------------------------------------------------------------------------------ bands

/** How many pixels a row's most frequent colour owns. */
function ownOf(px, y) {
  const counts = new Map();
  let own = 0;
  for (let x = 0; x < 64; x++) {
    const c = px[y * 64 + x];
    const n = (counts.get(c) || 0) + 1;
    counts.set(c, n);
    if (n > own) own = n;
  }
  return own;
}

/**
 * The vote, written out again: the row's most frequent colour when it owns 22 or more of the 64 pixels (the first to
 * reach a count keeps a tie); otherwise the colour with the most pixels within 8 levels of it on every channel (the
 * first colour of the row keeps a tie).
 */
function voteOf(px, y) {
  const row = Array.from(px.subarray(y * 64, y * 64 + 64));
  const counts = new Map();
  let best = row[0];
  let own = 0;
  for (const c of row) {
    const n = (counts.get(c) || 0) + 1;
    counts.set(c, n);
    if (n > own) { own = n; best = c; }
  }
  if (own >= 22) return best;
  const near = (a, b) => [16, 8, 0].every((s) => Math.abs(((a >> s) & 255) - ((b >> s) & 255)) <= 8);
  let top = -1;
  for (const c of counts.keys()) {
    const n = row.filter((p) => near(p, c)).length;
    if (n > top) { top = n; best = c; }
  }
  return best;
}
const rawAt = (st, y) => ((st.raw[y * 3] << 16) | (st.raw[y * 3 + 1] << 8) | st.raw[y * 3 + 2]) >>> 0;
const part = (a, y, n) => Array.from(a.subarray(y * n, y * n + n));

test('bands: updateBands, paintBand and paintFade bit for bit, real frames by night and by day', () => {
  // The vote is the reference's exact mode wherever that mode owns 22 or more of a row's pixels. A band row reads the
  // votes of its own row and the 3 above and below (the median of 5 and the [1 2 1] pass), and the easing remembers, so
  // the reference is compared bit for bit on the rows whose reads were all such rows in every frame so far. The vote
  // itself is checked on every row, and the steps after it on frames whose rows are their own votes.
  const cases = [['autumn', at(2026, 11, 15, 20, 40)], ['autumn', at(2026, 11, 15, 13, 0)], ['winter', at(2027, 1, 12, 13, 5)],
    ['summer', at(2026, 7, 18, 14, 10)], ['halloween', at(2026, 10, 31, 21, 10)], ['christmas', at(2026, 12, 24, 16, 30)],
    ['spring', at(2026, 4, 20, 7, 0)], ['newyear', at(2026, 12, 31, 23, 50)], ['autumn', at(2026, 11, 15, 7, 50)]];
  let compared = 0;
  let total = 0;
  for (const [id, when] of cases) {
    const name = `${id} ${when.getHours()}:${String(when.getMinutes()).padStart(2, '0')}`;
    const list = frames(id, when, 40);
    const ex = O.createExposure();
    const ob = O.createBands();
    const flatRef = O.createBands();
    let state = null;
    let flatState = null;
    const mixed = new Set();
    list.forEach((f, i) => {
      if (i === 0) ex.expose(f, true);
      else if (i % 15 === 0) ex.expose(f, false);
      const shown = ex.dimmed(f);
      ob.updateBands(shown, i === 0);
      const mine = B.bands(shown, { state, snap: i === 0 });
      state = mine.state;
      const flat = new Uint32Array(4096);
      for (let y = 0; y < 64; y++) {
        const v = voteOf(shown, y);
        assert.equal(rawAt(state, y), v, `${name} frame ${i} row ${y}: the vote`);
        flat.fill(v, y * 64, y * 64 + 64);
        if (ownOf(shown, y) < 22) for (let r = Math.max(0, y - 3); r <= Math.min(63, y + 3); r++) mixed.add(r);
      }
      const rows = ob.rows();
      const left = ob.fade(5, true);
      const right = ob.fade(5, false);
      const three = B.bands(shown, { state: { ...state, band: Float32Array.from(state.band), target: Float64Array.from(state.target), ready: true }, ease: 0, cols: 3 });
      const left3 = ob.fade(3, true);
      // the autumn canopy at dawn (a reference look: dithered leaves that must not become a slab) keeps the reference's
      // bands on every row
      const dawn = id === 'autumn' && when.getHours() === 7;
      for (let y = 0; y < 64; y++) {
        total++;
        if (mixed.has(y) && !dawn) continue;
        compared++;
        assert.deepEqual(part(state.band, y, 3), part(ob.band, y, 3), `${name} frame ${i} row ${y}: band state`);
        assert.equal(mine.rows[y], rows[y], `${name} frame ${i} row ${y}: band row`);
        assert.deepEqual(part(mine.fadeLeft, y, 5), part(left, y, 5), `${name} frame ${i} row ${y}: left seam`);
        assert.deepEqual(part(mine.fadeRight, y, 5), part(right, y, 5), `${name} frame ${i} row ${y}: right seam`);
        assert.deepEqual(part(three.fadeLeft, y, 3), part(left3, y, 3), `${name} frame ${i} row ${y}: three seam columns`);
      }
      // the same frame with every row filled with its own vote: the reference's exact mode is the vote on every row, so
      // the median, the [1 2 1] pass, the dimming toward bg, the easing and the seams match it everywhere
      flatRef.updateBands(flat, i === 0);
      const flatMine = B.bands(flat, { state: flatState, snap: i === 0 });
      flatState = flatMine.state;
      assert.deepEqual(Array.from(flatState.band), Array.from(flatRef.band), `${name} frame ${i}: band state, rows as their votes`);
      assert.deepEqual(Array.from(flatMine.rows), Array.from(flatRef.rows()), `${name} frame ${i}: rows, rows as their votes`);
      assert.deepEqual(Array.from(flatMine.fadeLeft), Array.from(flatRef.fade(5, true)), `${name} frame ${i}: left seam, rows as their votes`);
    });
  }
  assert.ok(compared > total * 0.6, `the reference compared on ${compared} of ${total} band rows`);
});

test('bands read as the scene rows: sky rows are the sky, objects and one-row stripes never stretch, night is darker', () => {
  const mixBg = (c) => {
    const ch = (s) => { const v = (c >> s) & 255; const b = (BG >> s) & 255; return Math.round(v + (b - v) * 0.16); };
    return ((ch(16) << 16) | (ch(8) << 8) | ch(0)) >>> 0;
  };
  // a sky with a moon (an object in rows 10-19) and one bright shelf row: neither shows in the bands
  const S = 0x223355;
  const f = new Uint32Array(4096).fill(S);
  for (let y = 10; y < 20; y++) for (let x = 40; x < 50; x++) f[y * 64 + x] = 0xf0e0a0;
  for (let x = 0; x < 64; x++) f[30 * 64 + x] = 0xc08040;
  const r = B.bands(f);
  for (let y = 0; y < 64; y++) assert.equal(r.rows[y], mixBg(S), `row ${y}`);
  // a ground below the sky: the band changes there and stays the ground below
  const G = 0x335522;
  const g2 = Uint32Array.from(f);
  for (let y = 40; y < 64; y++) for (let x = 0; x < 64; x++) g2[y * 64 + x] = (x % 7 === 3) ? 0x887766 : G;
  const r2 = B.bands(g2);
  for (let y = 0; y < 36; y++) assert.equal(r2.rows[y], mixBg(S), `sky row ${y}`);
  for (let y = 44; y < 64; y++) assert.equal(r2.rows[y], mixBg(G), `ground row ${y}`);
  // a sky dithered in 5 near shades (10 or 11 pixels of each in a row) behind a flat dark object 12 pixels wide and 12
  // rows tall (a house at sunset): the object out-counts every single shade, so an exact vote alone stretches it as a
  // bar; here the shades vote together and every band row is a sky colour
  const shades = [0x283a5c, 0x2a3c5e, 0x2c3e60, 0x2e4062, 0x304264];
  const OBJ = 0x101018;
  const dith = new Uint32Array(4096);
  for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) dith[y * 64 + x] = shades[(x + 2 * y) % 5];
  for (let y = 20; y < 32; y++) for (let x = 30; x < 42; x++) dith[y * 64 + x] = OBJ;
  const exact = O.createBands();
  exact.updateBands(dith, true);
  assert.equal(exact.rows()[26], mixBg(OBJ), 'the exact vote alone turns the object into a bar');
  const rd = B.bands(dith).rows;
  for (let y = 0; y < 64; y++) {
    for (const s of [16, 8, 0]) {
      const v = (rd[y] >> s) & 255;
      assert.ok(v >= ((mixBg(shades[0]) >> s) & 255) && v <= ((mixBg(shades[4]) >> s) & 255), `dithered sky row ${y}: a sky colour, not the object`);
    }
  }
  // the seam: next to the scene 69 % of the mirrored edge, the far end 3 %
  const t1 = B.FADE_T[1];
  const t5 = B.FADE_T[5];
  assert.ok(Math.abs(t1 - 11 / 36) < 1e-6 && Math.abs(t5 - 35 / 36) < 1e-6);
  // real frames: the top rows of a night sky are dark, day bands are lighter than night bands
  const night = frames('autumn', at(2026, 11, 15, 22, 30))[0];
  const day = frames('autumn', at(2026, 11, 15, 13, 0))[0];
  const bn = B.bands(night, { mix: B.dim(night) }).rows;
  const bd = B.bands(day, { mix: B.dim(day) }).rows;
  const mean = (rows) => Array.from(rows).reduce((s, c) => s + lum(c), 0) / 64;
  assert.ok(mean(bn) < mean(bd), `night ${mean(bn).toFixed(1)} < day ${mean(bd).toFixed(1)}`);
  assert.ok(lum(bn[2]) < 40, 'a night sky band is dark');
  // every band row of a real frame is a colour of the frame's neighbourhood: between bg and the brightest pixel
  for (const fr of [night, day]) {
    const sh = B.dimFrame(fr, B.dim(fr));
    const rows = B.bands(sh).rows;
    for (let y = 0; y < 64; y++) {
      let hi = 0;
      for (let yy = Math.max(0, y - 3); yy <= Math.min(63, y + 3); yy++) for (let x = 0; x < 64; x++) hi = Math.max(hi, lum(sh[yy * 64 + x]));
      assert.ok(lum(rows[y]) <= hi + 1e-9, `row ${y} no brighter than its neighbourhood`);
    }
  }
});

// ------------------------------------------------------------------------------------------------ gradient

test('gradient: the veil for the same layout, mirrored for the right column', () => {
  const sizes = [[1280, 800, 2], [1280, 620, 2], [1440, 900, 1], [1920, 1080, 1], [2560, 1440, 1], [3440, 1440, 1], [800, 500, 1],
    [800, 500, 2], [420, 760, 2], [600, 900, 1], [360, 640, 1], [1536, 864, 1.25]];
  let narrow = 0;
  for (const [w, h, d] of sizes) {
    const cell = newtabCell(h, d, w);
    const L = O.computeLayout(w, h, d, cell);
    for (const hintRow of [L.R - 2, L.R - 1, -1]) {
      for (const capW of [0, 22, 31]) {
        const capC = L.C - L.mx - capW;
        const capRow = hintRow >= 0 ? hintRow : L.R - 1;
        const capShade = capW ? { cx: (capC + capW / 2) * L.cw, cy: (capRow + 0.5) * L.ch, rx: (capW / 2 + 16) * L.cw } : null;
        const caption = capW ? { x: capC * L.cw, y: capRow * L.ch, w: capW * L.cw, h: L.ch } : null;
        const g = B.fit({ cssW: w, cssH: h, dpr: d, cell, statusTop: hintRow >= 0 ? hintRow * L.ch : null, caption });
        assert.equal(g.gradient.css, O.veilImage(L, hintRow, capShade), `${w}x${h}@${d} hint ${hintRow} caption ${capW}`);
        const gr = B.fit({ cssW: w, cssH: h, dpr: d, cell, side: 'right', reach: g.column.reach, statusTop: hintRow >= 0 ? hintRow * L.ch : null, caption });
        assert.equal(gr.gradient.css, O.veilImage(L, hintRow, capShade).replace('linear-gradient(90deg', 'linear-gradient(270deg'), 'mirrored');
        if (g.gradient.side.rest < 40) narrow++;
      }
    }
  }
  assert.ok(narrow > 0, 'the narrow case (the column fills the screen) is covered');
});

test('gradientAlpha: the stops, the bottom band, the caption shade, layers combined', () => {
  const g = B.fit({ cssW: 1280, cssH: 800, dpr: 2, statusTop: 37 * 20.5, caption: { x: 1000, y: 37 * 20.5, w: 231, h: 20.5 } }).gradient;
  const { x1, rest } = g.side;
  const only = (x, y) => B.gradientAlpha(g, x, y);
  const mid = 300; // a row far from the bottom band and the caption
  assert.ok(Math.abs(only(0, mid) - 0.88) < 1e-9);
  assert.ok(Math.abs(only(x1, mid) - 0.82) < 1e-9);
  assert.ok(Math.abs(only(x1 + 0.14 * rest, mid) - 0.5) < 1e-9);
  assert.ok(Math.abs(only(x1 + 0.5 * rest, mid) - 0.06) < 1e-9);
  assert.equal(only(x1 + 0.66 * rest, mid), 0);
  assert.equal(only(1279, mid), 0);
  // the bottom band: 0.5 at the edge, 0.36 0.2 rows above the status row, gone 2 rows above it (no caption here)
  const nc = { ...g, caption: null };
  assert.ok(Math.abs(B.gradientAlpha(nc, 1279, 800) - 0.5) < 1e-9);
  assert.ok(Math.abs(B.gradientAlpha(nc, 1279, 37 * 20.5 - 0.2 * 20.5) - 0.36) < 1e-9);
  assert.equal(B.gradientAlpha(nc, 1279, 37 * 20.5 - 2 * 20.5 - 1), 0);
  assert.ok(B.gradientAlpha(g, 1279, 37 * 20.5 - 2 * 20.5 - 1) > 0, 'the caption shade reaches there');
  // the caption: 0.7 at its centre (combined with the bottom band there)
  const c = g.caption;
  const b = 1 - (1 - 0.7) * (1 - B.gradientAlpha({ ...g, caption: null }, c.cx, c.cy));
  assert.ok(Math.abs(B.gradientAlpha(g, c.cx, c.cy) - b) < 1e-9);
  assert.equal(B.gradientAlpha({ ...g, caption: null, bottom: { s: 0, stops: [{ at: 0, a: 0 }] } }, c.cx + c.rx + 1, c.cy), 0);
  // mirrored: the right column darkens the right edge
  const r = B.fit({ cssW: 1280, cssH: 800, dpr: 2, side: 'right' }).gradient;
  assert.ok(Math.abs(B.gradientAlpha(r, 1280, mid) - 0.88) < 1e-9 && B.gradientAlpha(r, 1, mid) === 0);
});

// ------------------------------------------------------------------------------------------------ compose (the still)

test('compose: the still draws the same layer: k x k blocks, band rows, the seam, the gradient', () => {
  const [f] = frames('autumn', at(2026, 11, 15, 20, 40));
  for (const [w, h, d, side] of [[640, 400, 1, 'right'], [400, 250, 2, 'left'], [301, 497, 1.5, 'right'], [960, 300, 1, 'right']]) {
    const g = B.fit({ cssW: w, cssH: h, dpr: d, side, bottomCss: side === 'right' ? 28 : 0 });
    const { img, mix, rows } = B.compose(null, g, f, { veil: false });
    assert.equal(img.data.length, g.Wd * g.Hd * 3);
    assert.ok(Buffer.isBuffer(img.data), 'a Buffer in Node (render.js png() copies from it)');
    const shown = B.dimFrame(f, mix);
    const seam = B.bands(shown, { cols: g.fade ? g.fade.cols : 0 });
    const fade = g.edge === 'left' ? seam.fadeLeft : seam.fadeRight;
    let bad = 0;
    for (let y = 0; y < g.Hd; y++) {
      const ry = Math.floor((y - g.scene.y) / g.k);
      for (let x = 0; x < g.Wd; x++) {
        let want;
        if (x >= g.scene.x && x < g.scene.x + g.scene.size) want = shown[ry * 64 + Math.floor((x - g.scene.x) / g.k)];
        else if (g.fade && x >= g.fade.x && x < g.fade.x + g.fade.w) want = fade[ry * g.fade.cols + Math.floor((x - g.fade.x) / g.k)];
        else want = rows[ry];
        const o = (y * g.Wd + x) * 3;
        if (img.data[o] !== ((want >> 16) & 255) || img.data[o + 1] !== ((want >> 8) & 255) || img.data[o + 2] !== (want & 255)) bad++;
      }
    }
    assert.equal(bad, 0, `${w}x${h}@${d} ${side}: every device px is its block`);
    // with the gradient: each pixel is its block mixed toward bg by the gradient's alpha at the pixel centre
    const veiled = B.compose(null, g, f).img.data;
    for (const [x, y] of [[0, 0], [g.Wd - 1, g.Hd - 1], [Math.floor(g.Wd / 2), Math.floor(g.Hd / 3)], [g.Wd - 2, 5], [3, g.Hd - 4]]) {
      const A = B.gradientAlpha(g.gradient, (x + 0.5) / d, (y + 0.5) / d);
      const o = (y * g.Wd + x) * 3;
      for (let ch = 0; ch < 3; ch++) {
        const v = img.data[o + ch];
        const b = (BG >> (16 - 8 * ch)) & 255;
        assert.ok(Math.abs(veiled[o + ch] - (v + (b - v) * A)) <= 0.5 + 1e-9, `${w}x${h} at ${x},${y}`);
      }
    }
  }
  // 4 channels, into a given image
  const g = B.fit({ cssW: 200, cssH: 120, dpr: 1, side: 'right' });
  const img = { width: g.Wd, height: g.Hd, data: new Uint8ClampedArray(g.Wd * g.Hd * 4) };
  B.compose(img, g, f);
  assert.equal(img.data[3], 255);
  assert.throws(() => B.compose({ width: 10, height: 10, data: new Uint8Array(300) }, g, f), /must be 200x120/);
});

test('compose: a 4K still in good time (CPU time, best of 3)', () => {
  // CPU time, not wall time: the suite runs files in parallel, and on a busy machine wall time went from 60 to 800 ms.
  // The still's whole budget at 3840x2160 is 0.5 s CPU; the layer takes about 60 ms of it.
  const [f] = frames('winter', at(2027, 1, 12, 13, 5));
  const g = B.fit({ cssW: 3840, cssH: 2160, dpr: 1, side: 'right', bottomCss: 56, caption: { x: 200, y: 2050, w: 400, h: 56 } });
  const img = { width: g.Wd, height: g.Hd, data: Buffer.alloc(g.Wd * g.Hd * 3) };
  let best = Infinity;
  let wall = Infinity;
  for (let i = 0; i < 3; i++) {
    const c = process.cpuUsage();
    const t = performance.now();
    B.compose(img, g, f);
    wall = Math.min(wall, performance.now() - t);
    const d = process.cpuUsage(c);
    best = Math.min(best, (d.user + d.system) / 1000);
  }
  assert.ok(best < 300, `compose at 3840x2160: ${best.toFixed(0)} ms CPU (${wall.toFixed(0)} ms wall)`);
});

// ------------------------------------------------------------------------------------------------ the browser part

/** A small DOM: elements with style, className, attributes and children; canvases with a counting 2D context. */
function fakeDom({ vv = null } = {}) {
  const roObserved = [];
  function element(tag) {
    const el = {
      tagName: tag.toUpperCase(), style: {}, className: '', children: [], attrs: {}, parentNode: null,
      setAttribute(k, v) { this.attrs[k] = String(v); },
      appendChild(c) { c.parentNode = this; this.children.push(c); return c; },
      removeChild(c) { this.children.splice(this.children.indexOf(c), 1); c.parentNode = null; return c; },
    };
    if (tag === 'canvas') {
      const cv = fakeCanvas();
      el.width = 300;
      el.height = 150;
      el.ctx = cv.ctx;
      el.getContext = () => cv.ctx;
    }
    return el;
  }
  const doc = { createElement: element };
  const win = {
    devicePixelRatio: 2,
    visualViewport: vv,
    performance: { now: () => win.t },
    t: 0,
    ResizeObserver: function (fn) { this.fn = fn; this.observe = (el, o) => roObserved.push([el, o]); this.disconnect = () => { this.dead = true; }; win.ro = this; },
  };
  doc.defaultView = win;
  const root = element('div');
  root.ownerDocument = doc;
  return { doc, win, root, roObserved };
}

test('mountScene: elements, placement, cadence, repaint only on change, snaps, shade, sides, destroy', () => {
  const { doc, win, root, roObserved } = fakeDom();
  const layer = B.mountScene(root, { doc, win, side: 'left' });
  assert.deepEqual(root.children.map((c) => c.className), ['pcd-bleed-band', 'pcd-bleed-scene', 'pcd-bleed-fade', 'pcd-bleed-veil']);
  assert.equal(root.style.position, 'fixed');
  assert.equal(layer.gradient.style.pointerEvents, 'none');
  for (const c of layer.canvases) assert.equal(c.style.imageRendering, 'pixelated');
  assert.deepEqual([layer.canvas.width, layer.canvas.height, layer.band.width, layer.band.height], [64, 64, 1, 64]);
  // a frame before a place: nothing shows yet
  const list = frames('autumn', at(2026, 11, 15, 20, 40), 70);
  layer.draw(list[0]);
  assert.equal(layer.canvas.style.display, 'none');
  const geo = layer.setViewport(1280, 800, 2);
  assert.equal(geo.k, 25);
  assert.equal(layer.canvas.style.display, 'block');
  assert.equal(layer.band.style.display, 'block');
  assert.equal(layer.fade.style.display, 'block');
  assert.equal(layer.canvas.style.left, 960 / 2 + 'px');
  assert.equal(layer.canvas.style.width, 1600 / 2 + 'px');
  assert.equal(layer.band.style.width, 960 / 2 + 'px');
  assert.equal(layer.fade.width, 5);
  assert.equal(layer.gradient.style.backgroundImage, geo.gradient.css);
  assert.ok(roObserved.every(([, o]) => o.box === 'device-pixel-content-box'));
  // 60 frames at 30 fps: the dimming every 15 frames, the band rows every 4th frame
  const before = layer.info();
  for (let i = 1; i <= 60; i++) { win.t += 33; layer.draw(list[i]); }
  const after = layer.info();
  assert.equal(after.frames - before.frames, 60);
  assert.equal(after.exposures - before.exposures, 4, 'frames 15, 30, 45, 60');
  assert.equal(after.targets - before.targets, 15, 'every 4th frame');
  assert.equal(after.paints.scene - before.paints.scene, 60, 'the scene every frame');
  assert.equal(after.snaps, 1, 'only the first frame snapped');
  // a still scene: the edges stop repainting once the eased colours settle
  const still = list[61];
  for (let i = 0; i < 90; i++) { win.t += 33; layer.draw(still); }
  const settled = layer.info();
  for (let i = 0; i < 30; i++) { win.t += 33; layer.draw(still); }
  const later = layer.info();
  assert.equal(later.paints.band - settled.paints.band, 0, 'no band repaint for an unchanged picture');
  assert.equal(later.paints.fade - settled.paints.fade, 0, 'no seam repaint for an unchanged picture');
  // the painted pixels are the core's for the same frame
  const px = layer.pixels();
  const want = B.bands(px.frame);
  assert.deepEqual(px.rows, Array.from(want.rows));
  assert.deepEqual(px.fade, Array.from(want.fadeLeft));
  // a frame long after the last one (a still frame, a resume) snaps
  win.t += 60000;
  layer.draw(list[62]);
  assert.equal(layer.info().snaps, 2);
  // shade: only the gradient changes
  const g0 = layer.gradient.style.backgroundImage;
  const sh = layer.shade({ statusTop: 700, caption: { x: 1000, y: 700, w: 200, h: 20.5 } });
  assert.notEqual(layer.gradient.style.backgroundImage, g0);
  assert.equal(layer.gradient.style.backgroundImage, sh.css);
  assert.ok(sh.caption && sh.caption.cx === 1100);
  assert.equal(layer.geo().k, 25);
  // the column moves to the right: the band and the seam follow, the edges repaint at once from the last frame
  const paints = layer.info().paints;
  const right = layer.setViewport(1920, 1080, 1, { side: 'right', bottomCss: 56 });
  assert.equal(right.edge, 'right');
  assert.equal(layer.canvas.style.left, '0px');
  assert.equal(layer.band.style.left, right.scene.size + 'px');
  assert.ok(layer.info().paints.band > paints.band && layer.info().paints.fade > paints.fade, 'repainted without a new frame');
  assert.ok(layer.gradient.style.backgroundImage.includes('270deg') && layer.gradient.style.backgroundImage.includes('radial-gradient'), 'the shade is kept');
  // a narrow screen crops the scene: no band, no seam
  layer.setViewport(600, 900, 1);
  assert.equal(layer.band.style.display, 'none');
  assert.equal(layer.fade.style.display, 'none');
  assert.equal(layer.isScene(layer.canvas), true);
  assert.equal(layer.isScene(layer.band), false);
  // the cost window
  const cost = layer.info().cost;
  assert.ok(cost.n > 0 && cost.p95 >= cost.p50 && cost.max >= cost.p95);
  // the nudge: a box 1 px short grows by one device px, at most twice
  layer.setViewport(1280, 800, 2, { side: 'left', bottomCss: 0 });
  win.ro.fn([{ target: layer.canvas, devicePixelContentBoxSize: [{ inlineSize: 1599, blockSize: 1600 }] }]);
  assert.equal(layer.canvas.style.width, (800 + 0.5) + 'px');
  win.ro.fn([{ target: layer.canvas, devicePixelContentBoxSize: [{ inlineSize: 1700, blockSize: 1600 }] }]);
  assert.equal(layer.canvas.style.width, (800 + 0.5) + 'px', 'a box far off (emulated ratios) is not trusted');
  layer.destroy();
  assert.equal(root.children.length, 0);
  assert.ok(win.ro.dead);
});

test('mountScene: the visual viewport refines a rounded innerHeight at a fractional ratio', () => {
  const { doc, win, root } = fakeDom({ vv: { width: 999.2000122070312, height: 777.5999755859375, scale: 1 } });
  const layer = B.mountScene(root, { doc, win });
  const g = layer.setViewport(999, 778, 1.25);
  assert.equal(g.Hd, 972, '777.6 x 1.25, not round(778 x 1.25) = 973');
  assert.equal(g.Wd, 1249);
  win.visualViewport = { width: 500, height: 400, scale: 2 };
  assert.equal(layer.setViewport(999, 778, 1.25).Hd, 973, 'a pinch-zoomed visual viewport is not used');
});

// ------------------------------------------------------------------------------------------------ PCD.host's paint seam

test('PCD.host paint option: every frame goes through the painter, the canvas is left alone', () => {
  const env = fakeTime({ wall: new Date(2026, 10, 15, 20, 40).getTime(), vsyncHz: 60 });
  const doc = fakeDoc();
  const canvas = fakeCanvas();
  let got = 0;
  let first = null;
  let px = null;
  const host = PCD.host.create({
    canvas, doc, win: { matchMedia: () => ({ matches: false, addEventListener() {} }), navigator: {} },
    paint: (fb, info) => { got++; if (first === null) first = info.first; px = fb.px; assert.equal(typeof info.fading, 'boolean'); },
    sceneClock: 'none', settings: { theme: 'autumn' }, now: env.now, perfNow: env.perfNow, setTimeout: env.setTimeout,
    clearTimeout: env.clearTimeout, requestAnimationFrame: env.requestAnimationFrame, cancelAnimationFrame: env.cancelAnimationFrame,
    watch: { battery: false, motion: false },
  });
  host.start();
  assert.equal(got, 1, 'the first frame at once');
  assert.equal(first, true);
  env.advance(1000);
  assert.ok(got >= 29 && got <= 32, `${got} frames in a second`);
  assert.equal(canvas.ctx.puts, 0, 'the host never draws on the canvas itself');
  assert.equal(canvas.width, 0, 'nor sizes it');
  assert.equal(px.length, 4096);
  host.stop();
  // without paint: unchanged
  const c2 = fakeCanvas();
  const h2 = PCD.host.create({ canvas: c2, doc: fakeDoc(), win: { navigator: {} }, settings: { theme: 'autumn' }, now: env.now, perfNow: env.perfNow,
    setTimeout: env.setTimeout, clearTimeout: env.clearTimeout, requestAnimationFrame: env.requestAnimationFrame, cancelAnimationFrame: env.cancelAnimationFrame,
    watch: { battery: false, motion: false, visibility: false } });
  h2.start();
  assert.equal(c2.ctx.puts, 1);
  assert.equal(c2.width, 64);
  h2.stop();
});
