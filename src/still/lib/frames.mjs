// PixelClock Desktop still: the picture, in the live wallpaper's look. plan(view) runs before the scene is rendered and
// fixes the geometry; compose(view, plan, scene) paints:
//   1. the scene layer (PCD.bleed, src/shared/pcd-bleed.js: the same code as the live wallpaper's): the engine's frame
//      dimmed toward bg, scaled by a whole k (every scene pixel a k x k block), flush on the far side and cropped from
//      the sky when taller than the screen; each scene row continued as a band of its main colour under the column,
//      through a short mirrored seam; a fixed gradient of bg over it, dark across the column and gone two thirds of the
//      way across the scene, plus a light band along the bottom row;
//   2. the column (PCD.console, src/shared/pcd-console.js, profile 'still', with the atlas's cell metrics, so it matches
//      the wallpaper cell for cell; right by default): the big date (the calendar face: the picture changes every 15
//      minutes, so it never shows a time), the greeting, the daylight strip, the weather and its credit, the scene's
//      name and phase in the bottom corner; text from the glyph atlas, the date's digits and the strip's bars as
//      device-pixel rects.
// Both shared modules get exactly the inputs the live page gives them, so the picture matches the wallpaper. Pure: no
// clock, no screen, no disk.
import { createImage, fillRect } from './compose.mjs';
import { drawRuns } from './atlas.mjs';

/** The column's side: right by default (the desktop icons sit on the left, over the dimmed scene). */
export const SIDES = ['right', 'left'];
export const DEFAULT_SIDE = 'right';

function need(PCD) {
  const C = PCD && PCD.console;
  const B = PCD && PCD.bleed;
  if (!C || typeof C.compute !== 'function' || typeof C.content !== 'function') {
    throw new Error('PCD.console is missing (src/shared/pcd-console.js): the still draws the wallpaper\'s own column');
  }
  if (!B || typeof B.fit !== 'function' || typeof B.compose !== 'function') {
    throw new Error('PCD.bleed is missing (src/shared/pcd-bleed.js): the still draws the wallpaper\'s own scene layer');
  }
  return { C, B };
}

/** The atlas's cell at a ladder step as PCD.console's measure() wants it (CSS px, plus the exact device px). */
export function atlasMeasure(atlas, dpr) {
  return (step) => {
    if (!atlas.sizes.includes(step)) return null;
    const f = atlas.face(step);
    return { w: f.cellW / dpr, h: f.cellH / dpr, wDev: f.cellW, hDev: f.cellH, ls: (f.cellW - f.advance) / dpr };
  };
}

/** The view PCD.console reads, from the still's own inputs (face 'date': the calendar page). */
export function consoleView(view) {
  const { C } = need(view.PCD);
  const d = view.day || {};
  return C.view({
    now: view.date, clock24: view.clock24, theme: d.id, name: d.name, tag: d.tag, phase: d.phase, face: 'date',
    sun: view.sun || null, curve: view.curve || null, weather: view.weather || null,
  }, 'still');
}

/**
 * The geometry, before the scene exists. view: { width, height, scale, side, taskbar (CSS px), date, day: { id, name,
 * tag, phase }, weather, sun, curve, clock24, PCD, atlas }. Returns { L (PCD.console.compute), V (its view), geo
 * (PCD.bleed.fit), face (the atlas face), step, side, k, scene: { x, y, size }, sceneClock: 'none' }.
 */
export function plan(view) {
  const { width: W, height: H, scale = 1, atlas, PCD } = view;
  const { C, B } = need(PCD);
  const side = SIDES.includes(view.side) ? view.side : DEFAULT_SIDE;
  const cssW = W / scale;
  const cssH = H / scale;
  const V = consoleView(view);
  const L = C.compute({
    cssW, cssH, dpr: scale, profile: 'still', side, taskbar: view.taskbar == null ? 56 : view.taskbar,
    measure: atlasMeasure(atlas, scale), parts: C.partsOf(V, 'still'),
  });
  if (L.Wd !== W || L.Hd !== H) throw new Error(`the column's grid is ${L.Wd}x${L.Hd}, the picture ${W}x${H} (scale ${scale})`);
  const face = atlas.face(L.font.step);
  if (face.cellW !== L.cell.wDev || face.cellH !== L.cell.hDev) throw new Error(`cell ${L.cell.wDev}x${L.cell.hDev} is not the atlas's ${face.cellW}x${face.cellH}`);
  // the scene layer, fed as the console feeds the live one
  const geo = B.fit({
    cssW, cssH, dpr: scale, side: L.side, cell: L.cell, reach: L.side === 'right' ? cssW - L.edge.x : L.edge.x,
    bottomCss: L.taskbar.dev / scale, statusTop: L.rows.foot >= 0 ? L.rows.foot * L.cell.h : null, caption: null,
  });
  if (geo.Wd !== W || geo.Hd !== H) throw new Error(`the scene layer is ${geo.Wd}x${geo.Hd}, the picture ${W}x${H}`);
  return { L, V, geo, face, step: L.font.step, side, k: geo.k, scene: geo.scene, sceneClock: 'none' };
}

/**
 * What the column paints, in the live page's stacking order (pcd-console.js mount(): the clock's shadow text, the
 * clock's pixel canvas over it, the month and weekday, the greeting, the date, the strip's text, the strip's bar canvas
 * over it, the weather, the caption): [{ kind: 'text', x, y, runs } | { kind: 'rect', x, y, w, h, tone | color }] in
 * device px, one text entry per line.
 */
export function paintOps(ct, L) {
  const out = [];
  const cw = L.cell.wDev;
  const ch = L.cell.hDev;
  const text = (part) => {
    if (!part || !part.block) return;
    part.block.forEach((runs, i) => {
      if (runs && runs.length) out.push({ kind: 'text', x: L.grid.xDev + part.c * cw, y: (part.r + i) * ch, runs });
    });
  };
  if (ct.clock) {
    text({ c: ct.clock.c, r: ct.clock.r, block: ct.clock.shadow });
    const x0 = L.grid.xDev + ct.clock.c * cw;
    const y0 = ct.clock.r * ch;
    for (const q of ct.clock.rects) out.push({ kind: 'rect', x: x0 + q.x, y: y0 + q.y, w: q.w, h: q.h, tone: q.tone === 'accent' ? 'accent' : 'clock' });
    text(ct.clock.side);
  }
  for (const name of ['greet', 'date', 'status', 'strip']) text(ct[name]);
  if (ct.strip && ct.strip.bars) {
    const x0 = L.grid.xDev + ct.strip.bars.c * cw;
    const y0 = ct.strip.bars.r * ch;
    for (const q of ct.strip.bars.rects) out.push({ kind: 'rect', x: x0 + q.x, y: y0 + q.y, w: q.w, h: q.h, color: q.color });
  }
  for (const name of ['weather', 'rule', 'hint']) text(ct[name]);
  for (const l of ct.links || []) text(l);
  text(ct.caption);
  text(ct.settings);
  return out;
}

/**
 * Token colours by tone, as the pages show them (PCD.ascii.token reads PCD.TOKENS, which the still builds from
 * tokens.json); 'clock' is the big date's softened theme colour; a plain run is text.
 */
export function palette(PCD, clockColor) {
  return (tone) => {
    if (tone === 'clock') return clockColor;
    const c = PCD.ascii.token(tone || 'text');
    return typeof c === 'number' ? c : PCD.ascii.token('text');
  };
}

/**
 * Paint the picture. view: as for plan(); p: plan(view); scene: { px, colors } from scene.mjs (hook mode none).
 * Returns { img, info: { mix, luma, rows (band colours), content, ops (paintOps), lines, rects, clockColor } }.
 */
export function compose(view, p, scene) {
  const { PCD } = view;
  const { C, B } = need(PCD);
  const img = createImage(view.width, view.height, PCD.ascii.token('bg'));
  const layer = B.compose(img, p.geo, scene.px);
  const ct = C.content(p.V, p.L);
  const clockColor = PCD.ascii.clockColor(scene.colors && typeof scene.colors.clock === 'number' ? scene.colors.clock : PCD.ascii.token('text'));
  const colorOf = palette(PCD, clockColor);
  const ops = paintOps(ct, p.L);
  for (const o of ops) {
    if (o.kind === 'rect') fillRect(img, o.x, o.y, o.w, o.h, o.color !== undefined ? o.color : colorOf(o.tone));
    else drawRuns(img, p.face, o.x, o.y, o.runs, colorOf);
  }
  const lines = ops.filter((o) => o.kind === 'text');
  const rects = ops.filter((o) => o.kind === 'rect');
  return { img, info: { mix: layer.mix, luma: layer.luma, rows: layer.rows, content: ct, ops, lines, rects, clockColor } };
}
