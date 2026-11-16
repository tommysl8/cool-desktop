// PixelClock Desktop still: the scene.
//
// Loads the clock's engine the documented way (vendor engine.js, then shared/pcd-hook.js, then vendor
// tools/render.js, which takes engine.js from the require cache and loads schedule, screens and the
// themes), then renders one frame exactly the way the clock's tools/render.js does: its own run()
// with the theme's create(new Rng(seed)), 90 warm-up updates of 1/30 s and one draw. The hook decides
// what the scene's own clock shows: 'date' (date corners only), 'none' (nothing) or 'device'.
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);

/**
 * Shared UMD files the still loads after the engine when they are present: core, engine, sun, weather, fx, greet, ascii
 * and layout, then the scene layer and the column (pcd-bleed.js, pcd-console.js).
 */
export const SHARED_OPTIONAL = ['pcd-core.js', 'pcd-engine.js', 'pcd-sun.js', 'pcd-weather.js', 'pcd-fx.js', 'pcd-greet.js', 'pcd-ascii.js', 'pcd-layout.js', 'pcd-bleed.js', 'pcd-console.js'];

/** Warm-up before the frame, in seconds of 1/30 s updates (90 steps, as render.js's default). */
export const WARMUP_SECONDS = 3;

/**
 * Where the engine lives for a still folder: the package layout (`<still>/pixelclock`,
 * `<still>/shared`) or the repo layout (`src/still` -> `vendor/pixelclock`, `src/shared`).
 */
export function locateEngine(stillDir) {
  const pkg = { vendorDir: path.join(stillDir, 'pixelclock'), sharedDir: path.join(stillDir, 'shared'), layout: 'package' };
  if (fs.existsSync(path.join(pkg.vendorDir, 'tools', 'render.js'))) return pkg;
  const repo = path.resolve(stillDir, '..', '..');
  const dev = { vendorDir: path.join(repo, 'vendor', 'pixelclock'), sharedDir: path.join(repo, 'src', 'shared'), layout: 'repo' };
  if (fs.existsSync(path.join(dev.vendorDir, 'tools', 'render.js'))) return dev;
  throw new Error(`engine not found: neither ${pkg.vendorDir} nor ${dev.vendorDir} contains tools/render.js`);
}

let loaded = null;

/**
 * Load the engine once per process. opts: { vendorDir, sharedDir, hookFile, engineFile }. hookFile
 * and engineFile override `<sharedDir>/pcd-hook.js` and `pcd-engine.js` (tests). Returns
 * { PC, PCD, run, png, ctxAt, files }.
 */
export function loadEngine({ vendorDir, sharedDir, hookFile, engineFile } = {}) {
  const enginePath = path.resolve(vendorDir, 'simulator', 'engine.js');
  const renderPath = path.resolve(vendorDir, 'tools', 'render.js');
  const hookPath = path.resolve(hookFile || path.join(sharedDir, 'pcd-hook.js'));
  if (loaded) {
    if (loaded.files.engine !== enginePath || loaded.files.hook !== hookPath) {
      throw new Error('the engine is already loaded from another folder in this process (loading engine.js twice drops every theme)');
    }
    return loaded;
  }
  for (const f of [enginePath, renderPath, hookPath]) if (!fs.existsSync(f)) throw new Error(`missing ${f}`);
  if (globalThis.PixelClock) throw new Error('globalThis.PixelClock already exists: engine.js must be loaded exactly once');
  require(enginePath);
  const PC = globalThis.PixelClock;
  require(hookPath);
  const R = require(renderPath);
  if (!PC || R.PC !== PC || globalThis.PixelClock !== PC) throw new Error('engine.js was loaded twice; the theme registry would be lost');
  const shared = [];
  for (const name of SHARED_OPTIONAL) {
    const f = name === 'pcd-engine.js' && engineFile ? path.resolve(engineFile) : sharedDir ? path.resolve(sharedDir, name) : null;
    if (f && fs.existsSync(f)) {
      require(f);
      shared.push(name);
    }
  }
  const PCD = globalThis.PCD || {};
  if (!PCD.hook) throw new Error(`${hookPath} did not set PCD.hook`);
  if (typeof PC.themeIdForDate !== 'function' || !PC.themes || !PC.themes.length) throw new Error('render.js did not load the schedule and the themes');
  loaded = { PC, PCD, run: R.run, png: R.png, ctxAt: R.ctxAt, files: { engine: enginePath, render: renderPath, hook: hookPath }, shared };
  return loaded;
}

/** The theme for a date: a pinned id when the engine has it, else the clock's own schedule (auto). */
export function chooseTheme(eng, { theme = 'auto', year, month, day }) {
  const { PC, PCD } = eng;
  if (theme && theme !== 'auto' && PC.themeById(theme)) return { id: theme, tag: 'pinned' };
  const id = PCD.engine && typeof PCD.engine.autoId === 'function' ? PCD.engine.autoId(PC, year, month, day) : PC.themeIdForDate(year, month, day);
  return { id: PC.themeById(id) ? id : PC.themes[0].id, tag: 'auto' };
}

/** The day's seed (PCD.engine.seed: FNV-1a of `id:yyyy-mm-dd`), so the layout matches the new tab and the wallpaper. */
export function daySeed(eng, id, year, month, day) {
  const { PCD } = eng;
  if (!PCD.engine || typeof PCD.engine.seed !== 'function') throw new Error('PCD.engine.seed is missing (src/shared/pcd-engine.js)');
  return PCD.engine.seed(id, year, month, day);
}

/**
 * Render one frame with render.js's run(). opts: { id, seed, hourFloat, year, month, day,
 * hookMode = 'date', before = null (fx: called on scene pixels only), warmupSeconds = 3 }.
 * Returns { px (Uint32Array 4096), id, name, kind, edge, colors }.
 */
export function renderScene(eng, opts) {
  const { PC, PCD, run } = eng;
  const { id, seed, hourFloat, year, month, day, hookMode = 'date', before = null, warmupSeconds = WARMUP_SECONDS } = opts;
  const theme = PC.themeById(id);
  if (!theme) throw new Error(`unknown theme ${JSON.stringify(id)}`);
  if (!['date', 'none', 'device'].includes(hookMode)) throw new Error(`unknown hook mode ${JSON.stringify(hookMode)}`);
  if (!(hourFloat >= 0 && hourFloat < 24)) throw new Error(`hourFloat out of range: ${hourFloat}`);
  const hook = PCD.hook;
  const saved = { mode: hook.mode, before: hook.before };
  hook.mode = hookMode;
  hook.before = before;
  try {
    const frames = run(theme, { hour: hourFloat, year, month, day, warmup: warmupSeconds, frames: 1, gap: 0, seed, shake: false });
    const px = frames[0];
    if (!px || px.length !== 4096) throw new Error('render.js returned no 64x64 frame');
    return { px, id: theme.id, name: theme.name, kind: theme.kind, edge: hook.edge >>> 0, colors: hook.colors ? { ...hook.colors } : null };
  } finally {
    hook.mode = saved.mode;
    hook.before = saved.before;
  }
}

/** Local date parts and the light time: the picture shows `at + 7.5 min` (the middle of its 15-minute slot); the date is `at`'s. */
export function timeParts(at, { lightOffsetMin = 7.5 } = {}) {
  const d = at instanceof Date ? at : new Date(at);
  if (Number.isNaN(d.getTime())) throw new Error(`not a time: ${at}`);
  const light = new Date(d.getTime() + lightOffsetMin * 60000);
  const hourFloat = light.getHours() + light.getMinutes() / 60 + light.getSeconds() / 3600 + light.getMilliseconds() / 3600000;
  return { year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate(), hourFloat: hourFloat % 24, light };
}
