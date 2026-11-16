// Test helper (not a test file): load the synced engine the documented Node way:
// vendor engine.js, then src/shared/pcd-hook.js, then vendor tools/render.js (which reuses engine.js from the require
// cache and loads schedule, screens and the themes), then src/shared/pcd-engine.js.
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

export function loadEngine() {
  require(path.join(ROOT, 'vendor', 'pixelclock', 'simulator', 'engine.js'));
  require(path.join(ROOT, 'src', 'shared', 'pcd-hook.js'));
  const R = require(path.join(ROOT, 'vendor', 'pixelclock', 'tools', 'render.js'));
  require(path.join(ROOT, 'src', 'shared', 'pcd-engine.js'));
  return { PC: globalThis.PixelClock, PCD: globalThis.PCD, R, require };
}

/** A theme instance at `hour` on 2026-11-15 after `steps` updates (twins: same seed, same frames). */
export function instanceAt(PC, R, id, hour, { seed = 12345, steps = 30, date = [2026, 11, 15] } = {}) {
  const theme = PC.themeById(id);
  const inst = theme.create(new PC.Rng(seed));
  const ctx = { ...R.ctxAt({ hour, year: date[0], month: date[1], day: date[2] }), showDate: true };
  for (let i = 0; i < steps; i++) inst.update(1 / 30, ctx);
  return { inst, ctx };
}

/** Mean of the outer ring of a 64x64 frame, computed independently of the hook. */
export function ringMean(px, w = 64, h = 64) {
  const idx = [];
  for (let x = 0; x < w; x++) idx.push(x, (h - 1) * w + x);
  for (let y = 1; y < h - 1; y++) idx.push(y * w, y * w + w - 1);
  let r = 0, g = 0, b = 0;
  for (const i of idx) { r += (px[i] >> 16) & 255; g += (px[i] >> 8) & 255; b += px[i] & 255; }
  const n = idx.length;
  return ((Math.round(r / n) << 16) | (Math.round(g / n) << 8) | Math.round(b / n)) >>> 0;
}
