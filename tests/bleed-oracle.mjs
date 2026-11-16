// Test helper (not a test file): a frozen reference implementation of the scene layer, kept verbatim to compare
// against. Its comments name the files it was first written in (kit.js, console.js), which are not part of this repo;
// only its globals (layout L, knobs, buffers, bg) became parameters or locals.

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const MAX_CROP = 0.1;
const FADE = 5;
const BG = 0x141016;

/** console.js sceneGeom(Wd, Hd, consoleRightDev), PLACE = 'right' (the knob's default). */
export function sceneGeom(Wd, Hd, consoleRightDev, PLACE = 'right') {
  const k0 = Math.max(2, Math.ceil(Hd / 64));
  const free = Math.max(0, Wd - consoleRightDev);
  const kMax = Math.max(k0, Math.floor(Hd / (64 * (1 - MAX_CROP))));
  const k = Math.max(k0, Math.min(Math.ceil(free / 64), kMax));
  const size = 64 * k;
  const sy = -Math.round((size - Hd) * 0.6);
  let sx, place;
  if (size >= Wd) { sx = -Math.round((size - Wd) / 2); place = 'crop'; }
  else if (PLACE === 'center' && free > size) { sx = consoleRightDev + Math.round((free - size) / 2); place = 'center'; }
  else { sx = Wd - size; place = 'right'; }
  const nL = sx > 0 ? Math.ceil(sx / k) : 0;
  const nR = Wd - sx - size > 0 ? Math.ceil((Wd - sx - size) / k) : 0;
  return { k, size, sx, sy, place, nL, nR, fadeL: Math.min(FADE, nL), fadeR: Math.min(FADE, nR) };
}

/** kit.js fontStep and console.js computeLayout's column part, with the cell given (the page measures it). */
const LADDER = [14, 16, 20, 24, 28, 32, 36, 40, 48, 56, 64];
export function fontStep(cssH, dpr, div, minDev) {
  const t = (cssH * dpr) / div;
  let best = 0;
  for (let i = 0; i < LADDER.length; i++) {
    const s = LADDER[i];
    if (s < minDev) continue;
    if (!best || Math.abs(s - t) < Math.abs(best - t)) best = s;
  }
  return best || LADDER[LADDER.length - 1];
}
export function computeLayout(cssW, cssH, dpr, cell) {
  const Wd = Math.round(cssW * dpr), Hd = Math.round(cssH * dpr);
  const cw = cell.w, ch = cell.h;
  const C = Math.max(1, Math.floor(cssW / cw)), R = Math.max(1, Math.floor(cssH / ch));
  const mx = C >= 100 ? 4 : C >= 60 ? 3 : C >= 24 ? 2 : 0;
  const colW = Math.max(1, Math.min(clamp(Math.round(C * 0.34), 44, 64), C - 2 * mx));
  const consoleRight = (mx + colW) * cw;
  const geo = sceneGeom(Wd, Hd, Math.round(consoleRight * dpr));
  return { dpr, cssW, cssH, Wd, Hd, cw, ch, C, R, mx, colW, consoleRight, ...geo };
}

/** console.js veilImage(), with L and capShade passed in. hintRow: L.rows.hint (-1: none). */
export function veilImage(L, hintRow, capShade) {
  const a = (v) => `rgba(20,16,22,${v.toFixed(3)})`;
  const W = L.cssW, x1 = Math.min(W, L.consoleRight + L.cw);
  const rest = Math.max(0, W - x1), ch = L.ch;
  const s = L.cssH - (hintRow >= 0 ? hintRow * ch : L.cssH - 1.6 * ch);
  const bottom = `linear-gradient(0deg, ${a(0.5)} 0px, ${a(0.36)} ${(s + 0.2 * ch).toFixed(1)}px, ${a(0.12)} ${(s + 0.9 * ch).toFixed(1)}px, ${a(0)} ${(s + 2 * ch).toFixed(1)}px)`;
  const left = rest < 40
    ? `linear-gradient(90deg, ${a(0.88)} 0px, ${a(0.82)} ${W}px)`
    : `linear-gradient(90deg, ${a(0.88)} 0px, ${a(0.82)} ${x1.toFixed(1)}px, ${a(0.5)} ${(x1 + 0.14 * rest).toFixed(1)}px, ` +
      `${a(0.2)} ${(x1 + 0.32 * rest).toFixed(1)}px, ${a(0.06)} ${(x1 + 0.5 * rest).toFixed(1)}px, ${a(0)} ${(x1 + 0.66 * rest).toFixed(1)}px)`;
  const layers = [bottom, left];
  if (capShade) {
    const c = capShade;
    layers.unshift(`radial-gradient(ellipse ${c.rx.toFixed(1)}px ${(3.4 * ch).toFixed(1)}px at ${c.cx.toFixed(1)}px ${c.cy.toFixed(1)}px, ` +
      `${a(0.7)} 0%, ${a(0.6)} 32%, ${a(0.32)} 62%, ${a(0.1)} 84%, ${a(0)} 100%)`);
  }
  return layers.join(', ');
}

/** console.js expose()/setLut() as a little machine: the same calls give the same tables. */
export function createExposure(DIM = null) {
  const LR = new Uint8Array(256), LG = new Uint8Array(256), LB = new Uint8Array(256);
  let bright = DIM == null ? 0.58 : DIM, lutFor = -1;
  function setLut(b) {
    if (Math.abs(b - lutFor) < 0.002) return;
    lutFor = b;
    const T = BG, br = (T >> 16) & 255, bgn = (T >> 8) & 255, bb = T & 255;
    for (let v = 0; v < 256; v++) {
      LR[v] = Math.round(br + (v - br) * b);
      LG[v] = Math.round(bgn + (v - bgn) * b);
      LB[v] = Math.round(bb + (v - bb) * b);
    }
  }
  function expose(px, snap) {
    if (DIM != null) { setLut(DIM); return; }
    let sum = 0;
    for (let i = 0; i < 4096; i += 2) {
      const c = px[i];
      sum += 0.2126 * ((c >> 16) & 255) + 0.7152 * ((c >> 8) & 255) + 0.0722 * (c & 255);
    }
    const target = 0.6 - 0.1 * smooth(30, 170, sum / 2048);
    bright = snap ? target : bright + (target - bright) * 0.3;
    setLut(bright);
  }
  // paint()'s first loop: the frame through the tables
  function dimmed(px) {
    const shown = new Uint32Array(4096);
    for (let i = 0; i < 4096; i++) {
      const c = px[i], r = LR[(c >> 16) & 255], g = LG[(c >> 8) & 255], b = LB[c & 255];
      shown[i] = (r << 16) | (g << 8) | b;
    }
    return shown;
  }
  return { expose, dimmed, get bright() { return bright; }, LR, LG, LB };
}

/** console.js rowMode / median5 / updateBands / paintBand / paintFade over one band state. */
export function createBands() {
  const band = new Float32Array(192);
  const bandRaw = new Float32Array(192), bandMed = new Float32Array(192), med5 = new Float32Array(5);
  const BAND_DIM = 0.16;
  const BG_RGB = [(BG >> 16) & 255, (BG >> 8) & 255, BG & 255];
  const FADE_T = new Float32Array(FADE + 1);
  for (let d = 1; d <= FADE; d++) { const x = 1 - d / (FADE + 1); FADE_T[d] = 1 - x * x; }
  const modeC = new Uint32Array(64), modeN = new Uint8Array(64);
  let shown = null;
  function rowMode(y, x0, x1) {
    let n = 0, best = shown[y * 64 + x0], bestN = 0;
    for (let x = x0; x < x1; x++) {
      const c = shown[y * 64 + x];
      let j = 0;
      while (j < n && modeC[j] !== c) j++;
      if (j === n) { modeC[n] = c; modeN[n] = 0; n++; }
      const cnt = ++modeN[j];
      if (cnt > bestN) { bestN = cnt; best = c; }
    }
    return best;
  }
  function median5(a, b, c, d, e) {
    med5[0] = a; med5[1] = b; med5[2] = c; med5[3] = d; med5[4] = e;
    for (let i = 1; i < 5; i++) { const v = med5[i]; let j = i - 1; while (j >= 0 && med5[j] > v) { med5[j + 1] = med5[j]; j--; } med5[j + 1] = v; }
    return med5[2];
  }
  function updateBands(s, snap) {
    shown = s;
    for (let y = 0; y < 64; y++) {
      const m = rowMode(y, 0, 64), i = y * 3;
      bandRaw[i] = (m >> 16) & 255; bandRaw[i + 1] = (m >> 8) & 255; bandRaw[i + 2] = m & 255;
    }
    const at = (y, ch) => bandRaw[clamp(y, 0, 63) * 3 + ch];
    for (let y = 0; y < 64; y++) {
      for (let ch = 0; ch < 3; ch++) bandMed[y * 3 + ch] = median5(at(y - 2, ch), at(y - 1, ch), at(y, ch), at(y + 1, ch), at(y + 2, ch));
    }
    const a = snap ? 1 : 0.12;
    for (let y = 0; y < 64; y++) {
      for (let ch = 0; ch < 3; ch++) {
        const i = y * 3 + ch;
        const v = (bandMed[Math.max(0, y - 1) * 3 + ch] + 2 * bandMed[i] + bandMed[Math.min(63, y + 1) * 3 + ch]) / 4;
        band[i] += (v + (BG_RGB[ch] - v) * BAND_DIM - band[i]) * a;
      }
    }
  }
  // paintBand's pixels as 0xRRGGBB
  function rows() {
    const out = new Uint32Array(64);
    for (let y = 0; y < 64; y++) {
      const i = y * 3;
      out[y] = (Math.round(band[i]) << 16) | (Math.round(band[i + 1]) << 8) | Math.round(band[i + 2]);
    }
    return out;
  }
  // paintFade's pixels as 0xRRGGBB, n columns, left or right of the scene
  function fade(n, left) {
    const out = new Uint32Array(64 * n);
    for (let y = 0; y < 64; y++) {
      const i3 = y * 3, br = band[i3], bgn = band[i3 + 1], bb = band[i3 + 2];
      for (let i = 0; i < n; i++) {
        const dist = left ? n - i : i + 1;
        const src = shown[y * 64 + (left ? dist - 1 : 64 - dist)];
        const t = FADE_T[dist], u = 1 - t;
        out[y * n + i] = (Math.round(((src >> 16) & 255) * u + br * t) << 16) | (Math.round(((src >> 8) & 255) * u + bgn * t) << 8) |
          Math.round((src & 255) * u + bb * t);
      }
    }
    return out;
  }
  return { updateBands, rows, fade, band };
}
