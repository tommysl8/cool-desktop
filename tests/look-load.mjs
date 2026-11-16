// Test helper (not a test file) for the unit tests of the shared look modules: the repo root, the modules, and node:vm
// sandboxes that load the classic UMD scripts the way pages do (one global PCD), isolated from each other.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath, pathToFileURL } from 'node:url';

function findRoot(dir) {
  for (let d = dir; ; d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, 'design', 'tokens.json')) && fs.existsSync(path.join(d, 'tools', 'build.mjs'))) return d;
    if (path.dirname(d) === d) throw new Error('look-load: repo root not found above ' + dir);
  }
}

export const ROOT = findRoot(path.dirname(fileURLToPath(import.meta.url)));
export const SHARED = path.join(ROOT, 'src', 'shared');

/** import() a repo module by its repo-relative path. */
export function lib(rel) {
  return import(pathToFileURL(path.join(ROOT, ...rel.split('/'))).href);
}

/**
 * A fresh vm context with `globals` (window-like extras: matchMedia, location, localStorage, document, ...) that runs
 * the given scripts in order. Entries are repo-relative paths or { name, code }. Resolves the context (ctx.PCD).
 */
export function sandbox(scripts, globals = {}) {
  const context = { console, setTimeout, clearTimeout };
  Object.defineProperties(context, Object.getOwnPropertyDescriptors(globals)); // keeps getters (a throwing localStorage)
  context.globalThis = context;
  vm.createContext(context);
  for (const s of scripts) {
    const code = typeof s === 'string' ? fs.readFileSync(path.join(ROOT, ...s.split('/')), 'utf8') : s.code;
    const name = typeof s === 'string' ? s : s.name;
    vm.runInContext(code, context, { filename: name });
  }
  return context;
}

/** The engine scripts in page order (vendor engine, the hook, schedule, the themes), for sandbox(). */
export async function engineScripts() {
  const { themeOrder } = await lib('tools/lib/vendor.mjs');
  const vdir = path.join(ROOT, 'vendor', 'pixelclock');
  return [
    'vendor/pixelclock/simulator/engine.js',
    'src/shared/pcd-hook.js',
    'vendor/pixelclock/simulator/schedule.js',
    ...themeOrder(vdir).map((t) => `vendor/pixelclock/simulator/${t.file}`),
  ];
}

/** The generated pcd-tokens.js as a sandbox() entry. */
export async function tokensScript() {
  const { tokensJs, loadTokens } = await lib('tools/lib/tokens.mjs');
  return { name: 'pcd-tokens.js (generated)', code: tokensJs(loadTokens(ROOT)) };
}

/** Plain-object copy (vm objects carry another realm's prototypes; deepStrictEqual compares prototypes). */
export function plain(v) {
  return JSON.parse(JSON.stringify(v));
}
