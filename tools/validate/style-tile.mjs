// Validator plugin for dist/style-tile, the visual gate page. The core validator already checks encodings, local
// references, the CSP lint, glyphs and URLs for every file; this adds the page's own shape. Contract
// (tools/validate.mjs): export async function validate(vctx) -> [{ name, pass, detail }] (pass null = SKIP). The
// pixels themselves are checked in headless Chrome by node tools/test-style-tile.mjs.
//
//   - the page exists, keeps the CSP meta (script-src 'self') and loads only classic deferred scripts, in the page
//     order: the engine first, pcd-hook.js second, the shared scripts with pcd-console.js and pcd-bleed.js among them
//     (after pcd-ascii.js and pcd-layout.js), js/style-tile.js last; tokens.css is the first stylesheet, pcd-base.css
//     and pcd-console.css follow, style-tile.css is last; the font is preloaded; no screens.js
//   - every shared script and stylesheet is byte-identical to src/shared (generated files aside), the tile's own files
//     to design/, and the font and OFL.txt to design/fonts
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const piece = 'style-tile';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const GENERATED = ['pcd-tokens.js', 'pcd-anchors.js', 'tokens.css'];
const row = (name, pass, detail = '') => ({ name: `style-tile: ${name}`, pass, detail: String(detail) });

function same(a, b) {
  try {
    return fs.readFileSync(a).equals(fs.readFileSync(b));
  } catch {
    return false;
  }
}

export async function validate(vctx = {}) {
  const root = vctx.root || path.resolve(HERE, '..', '..');
  const dist = vctx.dist || path.join(root, 'dist');
  const pkg = path.join(dist, 'style-tile');
  const html = path.join(pkg, 'index.html');
  if (!fs.existsSync(html)) return [row('page', null, 'dist/style-tile/index.html not built (node tools/build.mjs --no-sync style-tile)')];
  const rows = [];
  const text = fs.readFileSync(html, 'utf8');

  const csp = /<meta http-equiv="Content-Security-Policy" content="script-src 'self'; object-src 'self'">/.test(text);
  rows.push(row('CSP meta', csp, csp ? "script-src 'self'; object-src 'self'" : 'the CSP meta is missing or changed'));

  const tags = [...text.matchAll(/<script\b([^>]*)>/g)].map((m) => m[1]);
  const scripts = tags.map((a) => (/\bsrc="([^"]+)"/.exec(a) || [])[1] || null);
  const classic = tags.every((a) => /\bsrc="[^"]+"/.test(a) && /\bdefer\b/.test(a) && !/type="module"/.test(a));
  rows.push(row('classic deferred scripts', classic && scripts.length > 0, `${scripts.length} <script src defer>, no inline, no module`));
  const at = (name) => scripts.indexOf(name);
  const order = scripts[0] === 'js/pixelclock/engine.js' && scripts[1] === 'js/pcd-hook.js' && scripts[2] === 'js/pixelclock/schedule.js' &&
    at('js/pcd-console.js') > at('js/pcd-ascii.js') && at('js/pcd-console.js') > at('js/pcd-layout.js') && at('js/pcd-bleed.js') > at('js/pcd-layout.js') &&
    at('js/pcd-ascii.js') > at('js/pcd-tokens.js') &&
    scripts[scripts.length - 1] === 'js/style-tile.js' && !scripts.some((s) => /screens\.js$/.test(s));
  rows.push(row('script order', order, order ? 'engine, hook, schedule, themes, generated, shared (console and bleed after ascii and layout), style-tile.js last' : scripts.join(' ')));

  const styles = [...text.matchAll(/<link rel="stylesheet" href="([^"]+)">/g)].map((m) => m[1]);
  const css = styles[0] === 'css/tokens.css' && styles.indexOf('css/pcd-base.css') > 0 && styles.indexOf('css/pcd-console.css') > styles.indexOf('css/pcd-base.css') &&
    styles[styles.length - 1] === 'css/style-tile.css';
  rows.push(row('stylesheet order', css, styles.join(' ')));
  const preload = /<link rel="preload" href="fonts\/CascadiaMono-wght\.ttf" as="font" type="font\/ttf" crossorigin>/.test(text);
  rows.push(row('font preload', preload, preload ? 'fonts/CascadiaMono-wght.ttf' : 'no preload of the font'));

  const copies = [];
  const shared = path.join(root, 'src', 'shared');
  for (const s of scripts) {
    const name = path.posix.basename(s);
    if (s.startsWith('js/pixelclock/') || GENERATED.includes(name)) continue;
    const src = name === 'style-tile.js' ? path.join(root, 'design', 'style-tile.js') : path.join(shared, name);
    copies.push([s, src]);
  }
  for (const s of styles) {
    const name = path.posix.basename(s);
    if (GENERATED.includes(name)) continue;
    copies.push([s, name === 'style-tile.css' ? path.join(root, 'design', 'style-tile.css') : path.join(shared, 'css', name)]);
  }
  copies.push(['fonts/CascadiaMono-wght.ttf', path.join(root, 'design', 'fonts', 'CascadiaMono-wght.ttf')], ['fonts/OFL.txt', path.join(root, 'design', 'fonts', 'OFL.txt')]);
  const stale = copies.filter(([rel, src]) => !same(path.join(pkg, ...rel.split('/')), src)).map(([rel]) => rel);
  rows.push(row('copies current', stale.length === 0, stale.length ? `differ from their source (rebuild): ${stale.join(', ')}` : `${copies.length} files byte-identical to src/shared, design/ and design/fonts`));
  return rows;
}
