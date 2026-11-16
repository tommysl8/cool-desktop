// Build plugin for the style tile: dist/style-tile/, the visual gate page.
//
//   index.html          design/style-tile.html with the font preload, the stylesheets and the deferred scripts put in at
//                       its <!-- PCD:PRELOAD -->, <!-- PCD:STYLES --> and <!-- PCD:SCRIPTS --> marks (each exactly once)
//   js/pixelclock/      the synced engine, bytes unchanged (ctx.copyVendor; no screens.js)
//   js/ css/ fonts/     ctx.copyShared: pcd-hook.js, the generated pcd-tokens.js / pcd-anchors.js, src/shared/*.js in the
//                       page order (ctx.pageScripts), tokens.css + src/shared/css/*.css, design/fonts (font + OFL.txt)
//   js/style-tile.js    design/style-tile.js (last), css/style-tile.css design/style-tile.css (last)
// The page is served over http by tools/test-style-tile.mjs (127.0.0.1). It never touches the network.
// Contract (tools/build.mjs): export const piece; export async function build(ctx). Node built-ins only.
import fs from 'node:fs';
import path from 'node:path';

export const piece = 'style-tile';
const OUT = 'style-tile';
const FONT_FILE = 'CascadiaMono-wght.ttf';
export const MARKS = Object.freeze({ preload: '<!-- PCD:PRELOAD -->', styles: '<!-- PCD:STYLES -->', scripts: '<!-- PCD:SCRIPTS -->' });

/** style-tile.html with the three marks filled in (each must appear exactly once). */
export function renderHtml(template, { preload = [], styles = [], scripts = [] }) {
  for (const mark of Object.values(MARKS)) {
    const n = template.split(mark).length - 1;
    if (n !== 1) throw new Error(`design/style-tile.html must contain ${mark} exactly once (found ${n})`);
  }
  const fill = (lines) => () => lines.join('\n');
  return template
    .replace(MARKS.preload, fill(preload.map((f) => `<link rel="preload" href="${f}" as="font" type="font/ttf" crossorigin>`)))
    .replace(MARKS.styles, fill(styles.map((f) => `<link rel="stylesheet" href="${f}">`)))
    .replace(MARKS.scripts, fill(scripts.map((f) => `<script src="${f}" defer></script>`)))
    .replace(/\n{2,}/g, '\n');
}

export async function build(ctx) {
  const design = ctx.path('design');
  const read = (name) => {
    const file = path.join(design, name);
    if (!fs.existsSync(file)) throw new Error(`design/${name} is missing`);
    return fs.readFileSync(file, 'utf8');
  };
  const template = read('style-tile.html');
  const script = read('style-tile.js');
  const style = read('style-tile.css');
  for (const f of ['pcd-console.js', 'pcd-bleed.js']) {
    if (!ctx.sharedScripts.includes(f)) throw new Error(`src/shared/${f} is missing (the style tile shows the console)`);
  }

  ctx.clean(OUT);
  const vendor = ctx.copyVendor(`${OUT}/js/pixelclock`);
  if (vendor.files.includes('screens.js')) throw new Error('screens.js must not ship in a page');
  const shared = ctx.copyShared(OUT);
  ctx.write(`${OUT}/js/style-tile.js`, script);
  ctx.write(`${OUT}/css/style-tile.css`, style);
  const scripts = [...ctx.pageScripts({ js: 'js', vendor: 'js/pixelclock' }), 'js/style-tile.js'];
  const html = renderHtml(template, {
    preload: shared.fonts.filter((f) => f.endsWith(FONT_FILE)),
    styles: [...shared.css, 'css/style-tile.css'],
    scripts,
  });
  ctx.write(`${OUT}/index.html`, html);
  ctx.log(`${scripts.length} deferred scripts; ${shared.css.length + 1} stylesheets; font ${shared.fonts.length ? 'bundled' : 'missing (design/fonts/)'}`);
}
