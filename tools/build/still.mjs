// Build plugin: dist/still, the low-power still wallpaper package.
//
// dist/still/
//   pcd-still.mjs, lib/*.mjs, run-hidden.js (template)       from src/still
//   shared/      the UMD files the still loads (from src/shared): the hook, the engine adapter, the column and the
//                scene layer (pcd-console.js, pcd-bleed.js) and what they need (core, greet, ascii, layout) are
//                required; sun, weather and fx are optional (the still runs without them)
//   pixelclock/  simulator/... next to tools/render.js         ctx.copyVendor(..., { render: true }), bytes unchanged
//   anchors.json per-theme light anchors                       the build's generate stage (ctx.generated / ctx.anchors)
//   tokens.json  the palette (the pages' PCD.TOKENS)           design/tokens.json (required)
//   atlas/       the column's glyph atlas                      design/atlas/ (required; tools/make-atlas.mjs)
// The install adds still.json, task.xml, the filled-in run-hidden.js and out/. Node built-ins only.
import fs from 'node:fs';
import path from 'node:path';

export const piece = 'still';
/** Shared UMD files the still loads after the engine, in load order. */
export const STILL_SHARED = ['pcd-hook.js', 'pcd-core.js', 'pcd-engine.js', 'pcd-sun.js', 'pcd-weather.js', 'pcd-fx.js', 'pcd-greet.js', 'pcd-ascii.js', 'pcd-layout.js', 'pcd-bleed.js', 'pcd-console.js'];
export const REQUIRED_SHARED = ['pcd-hook.js', 'pcd-engine.js', 'pcd-core.js', 'pcd-greet.js', 'pcd-ascii.js', 'pcd-layout.js', 'pcd-bleed.js', 'pcd-console.js'];
/** Files of the package from src/still besides lib/*.mjs. */
export const OWN_FILES = ['pcd-still.mjs', 'run-hidden.js'];
/**
 * Install-time modules that stay in the repo: tools/install.mjs imports src/still/lib/task.mjs to write task.xml
 * and the filled-in run-hidden.js. (It also names the Task Scheduler XML namespace, which is not a network URL.)
 */
export const INSTALL_ONLY = ['task.mjs'];

/** The lib/*.mjs files that ship in dist/still/lib. */
export function packageLibFiles(libDir) {
  return fs.readdirSync(libDir).filter((n) => n.endsWith('.mjs') && !INSTALL_ONLY.includes(n)).sort();
}

export async function build(ctx) {
  ctx.clean('still');
  for (const f of OWN_FILES) ctx.copyFile(ctx.path('src', 'still', f), path.join('still', f));
  const libDir = ctx.path('src', 'still', 'lib');
  for (const f of packageLibFiles(libDir)) ctx.copyFile(path.join(libDir, f), path.join('still', 'lib', f));

  for (const name of STILL_SHARED) {
    const src = ctx.path('src', 'shared', name);
    if (fs.existsSync(src)) ctx.copyFile(src, path.join('still', 'shared', name));
    else if (REQUIRED_SHARED.includes(name)) throw new Error(`still: src/shared/${name} is required`);
    else ctx.log(`src/shared/${name} is missing: the still runs without it`);
  }

  ctx.copyVendor(path.join('still', 'pixelclock'), { render: true });

  if (ctx.generated && typeof ctx.generated['anchors.json'] === 'string') ctx.write(path.join('still', 'anchors.json'), ctx.generated['anchors.json']);
  else if (ctx.anchors && typeof ctx.anchors === 'object') ctx.writeJson(path.join('still', 'anchors.json'), ctx.anchors);
  else ctx.log('no anchors from the generate stage: scenes keep their own hours');

  const tokens = ctx.path('design', 'tokens.json');
  if (!fs.existsSync(tokens)) throw new Error('still: design/tokens.json is required (the pages\' colours)');
  ctx.copyFile(tokens, path.join('still', 'tokens.json'));

  const atlas = ctx.path('design', 'atlas');
  if (!fs.existsSync(path.join(atlas, 'atlas.json'))) throw new Error('still: design/atlas/ is required (node tools/make-atlas.mjs)');
  ctx.copyDir(atlas, path.join('still', 'atlas'));
}
