// Build plugin: the Chrome new tab extension, an unpacked MV3 package in dist/newtab/ (the folder you load with
// "Load unpacked"; tools/install.mjs copies it to %LOCALAPPDATA%\PixelClockDesktop\chrome-newtab).
//   manifest.json      src/newtab/manifest.json, checked: exactly the keys and permissions of MANIFEST_SPEC plus the
//                      public "key", whose extension id must equal src/newtab/EXTENSION_ID.txt (tools/make-key.mjs)
//   newtab.html        src/newtab/newtab.html with the font preload, the stylesheets and the deferred scripts put in at
//                      its <!-- PCD:PRELOAD -->, <!-- PCD:STYLES --> and <!-- PCD:SCRIPTS --> marks
//   boot.js            the one blocking script, first in <head> (must stay under 2 KB)
//   js/pixelclock/     the synced engine, bytes unchanged (ctx.copyVendor; no screens.js: pages show no system screen)
//   js/ css/ fonts/    ctx.copyShared: pcd-hook.js, the generated pcd-tokens.js / pcd-anchors.js, src/shared/*.js,
//                      tokens.css + src/shared/css/*.css, the font and OFL.txt (the build stops without the font)
//   js/pcd-config.js   generated: PCD.CONFIG from config/user.json (PCD.settings.configJs of js/ntp-settings.js)
//   js/ntp-*.js        the new tab's own scripts in NEWTAB_SCRIPTS order (any other ntp-*.js before ntp-app.js)
//   js/term/           the terminal: term/lib/*.js (the terminal libraries from an earlier terminal project, as
//                      classic scripts, generated), then term/*.js, in TERM_SCRIPTS order (any other file by name),
//                      before ntp-app.js
//   css/*.css          the page's own styles after the shared ones: newtab.css, then the parts' sheets by name
//                      (ntp-panel.css, ntp-term.css)
//   icons/             the committed 16/32/48/128 px icons (tools/make-icons.mjs)
// Script order (all defer): engine.js, pcd-hook.js, schedule.js, the themes (seasons, then holidays),
// pcd-tokens.js, pcd-anchors.js, the shared scripts, pcd-config.js, the new tab's scripts, the terminal's,
// ntp-app.js last.
// Nothing named with a leading "_" (Chrome refuses those), no .pem, no private key. Node built-ins only.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { readJsonStrict } from '../lib/fsx.mjs';
import { extensionId, keyProblems } from '../make-key.mjs';

export const piece = 'newtab';
export const OUT = 'newtab';
export const MARKS = Object.freeze({ preload: '<!-- PCD:PRELOAD -->', styles: '<!-- PCD:STYLES -->', scripts: '<!-- PCD:SCRIPTS -->' });
export const ICON_SIZES = Object.freeze([16, 32, 48, 128]);
export const BOOT_MAX_BYTES = 2048;
export const FONT_FILE = 'CascadiaMono-wght.ttf';
/** The new tab's own scripts in load order; ntp-app.js (the wiring) always runs last. */
export const NEWTAB_SCRIPTS = Object.freeze(['ntp-settings.js', 'ntp-store.js', 'ntp-status.js', 'ntp-links.js', 'ntp-panel.js', 'ntp-app.js']);
/** The terminal's own scripts (js/term/) in load order, after its libraries (js/term/lib/*.js by name). */
export const TERM_SCRIPTS = Object.freeze(['term-commands.js', 'term-url.js', 'term-shell.js', 'term-ui.js']);
export const CONFIG_SCRIPT = 'pcd-config.js';

/** The manifest: these keys and values exactly, plus "description" (text) and "key" (the public key). */
export const MANIFEST_SPEC = Object.freeze({
  manifest_version: 3,
  name: 'PixelClock Desktop',
  version: '1.0.0',
  icons: { 16: 'icons/icon16.png', 32: 'icons/icon32.png', 48: 'icons/icon48.png', 128: 'icons/icon128.png' },
  chrome_url_overrides: { newtab: 'newtab.html' },
  permissions: ['storage', 'search'],
  optional_permissions: ['topSites'],
  host_permissions: ['http://pixelclock.local/*'],
});
export const MANIFEST_KEYS = Object.freeze([...Object.keys(MANIFEST_SPEC), 'description', 'key']);

const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** Problems with a manifest object ([] = exactly MANIFEST_SPEC with a valid public key). */
export function checkManifest(m) {
  const problems = [];
  if (!m || typeof m !== 'object' || Array.isArray(m)) return ['the manifest must be a JSON object'];
  for (const k of Object.keys(m)) if (!MANIFEST_KEYS.includes(k)) problems.push(`key "${k}" is not allowed (allowed: ${MANIFEST_KEYS.join(', ')})`);
  for (const [k, v] of Object.entries(MANIFEST_SPEC)) {
    if (!(k in m)) problems.push(`"${k}" is missing`);
    else if (!sameJson(m[k], v)) problems.push(`"${k}" must be ${JSON.stringify(v)} (got ${JSON.stringify(m[k])})`);
  }
  if (typeof m.description !== 'string' || !m.description.trim() || m.description.length > 132) problems.push('"description" must be 1-132 characters');
  problems.push(...keyProblems(m.key));
  return problems;
}

/** The extension id the manifest key gives, checked against EXTENSION_ID.txt (text). Throws on a mismatch. */
export function checkId(manifest, idText) {
  const id = extensionId(manifest.key);
  if (idText !== null && idText !== undefined && String(idText).trim() !== id) {
    throw new Error(`src/newtab/EXTENSION_ID.txt says ${String(idText).trim()}, but the manifest key gives ${id} (run node tools/make-key.mjs)`);
  }
  return id;
}

/** The .js file names of a folder (none when it is missing); names starting with "_" or "." are refused. */
function jsFiles(dir, label) {
  const names = fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile() && e.name.endsWith('.js')).map((e) => e.name) : [];
  const bad = names.filter((n) => n.startsWith('_') || n.startsWith('.'));
  if (bad.length) throw new Error(`${label}: file names must not start with "_" or "." (${bad.join(', ')})`);
  return names;
}

/**
 * src/newtab/js/**.js in load order, as paths under js/: NEWTAB_SCRIPTS that exist, other top-level scripts by name,
 * the terminal (term/lib/*.js by name, then TERM_SCRIPTS, then other term/*.js by name), ntp-app.js last.
 */
export function newtabScripts(jsDir) {
  const names = jsFiles(jsDir, 'src/newtab/js/');
  if (names.includes(CONFIG_SCRIPT)) throw new Error(`src/newtab/js/${CONFIG_SCRIPT} must not exist (the build generates it)`);
  if (!names.includes('ntp-app.js')) throw new Error('src/newtab/js/ntp-app.js is missing');
  const known = NEWTAB_SCRIPTS.filter((n) => n !== 'ntp-app.js' && names.includes(n));
  const other = names.filter((n) => !NEWTAB_SCRIPTS.includes(n)).sort();
  const termDir = path.join(jsDir, 'term');
  const lib = jsFiles(path.join(termDir, 'lib'), 'src/newtab/js/term/lib/').sort().map((n) => `term/lib/${n}`);
  const termNames = jsFiles(termDir, 'src/newtab/js/term/');
  const term = [...TERM_SCRIPTS.filter((n) => termNames.includes(n)), ...termNames.filter((n) => !TERM_SCRIPTS.includes(n)).sort()]
    .map((n) => `term/${n}`);
  return [...known, ...other, ...lib, ...term, 'ntp-app.js'];
}

/** src/newtab/css/*.css in link order: newtab.css (the page), then the parts' own sheets (ntp-*.css) by name. */
export function newtabStyles(cssDir) {
  const names = fs.existsSync(cssDir) ? fs.readdirSync(cssDir, { withFileTypes: true }).filter((e) => e.isFile() && e.name.endsWith('.css')).map((e) => e.name) : [];
  const bad = names.filter((n) => n.startsWith('_') || n.startsWith('.'));
  if (bad.length) throw new Error(`src/newtab/css/: file names must not start with "_" or "." (${bad.join(', ')})`);
  if (!names.includes('newtab.css')) throw new Error('src/newtab/css/newtab.css is missing');
  return ['newtab.css', ...names.filter((n) => n !== 'newtab.css').sort()];
}

/** newtab.html with the three marks filled in (each must appear exactly once). */
export function renderHtml(template, { preload = [], styles = [], scripts = [] }) {
  for (const mark of Object.values(MARKS)) {
    const n = template.split(mark).length - 1;
    if (n !== 1) throw new Error(`src/newtab/newtab.html must contain ${mark} exactly once (found ${n})`);
  }
  const fill = (lines) => () => lines.join('\n');
  return template
    .replace(MARKS.preload, fill(preload.map((f) => `<link rel="preload" href="${f}" as="font" type="font/ttf" crossorigin>`)))
    .replace(MARKS.styles, fill(styles.map((f) => `<link rel="stylesheet" href="${f}">`)))
    .replace(MARKS.scripts, fill(scripts.map((f) => `<script src="${f}" defer></script>`)))
    .replace(/\n{2,}/g, '\n');
}

/** PCD.CONFIG as a classic script, through js/ntp-settings.js (run in a private vm context with the URL class). */
export function configScript(settingsFile, config) {
  const context = vm.createContext({ URL, URLSearchParams });
  vm.runInContext(fs.readFileSync(settingsFile, 'utf8'), context, { filename: path.basename(settingsFile) });
  const S = context.PCD && context.PCD.settings;
  if (!S || typeof S.configJs !== 'function') throw new Error(`${settingsFile} does not provide PCD.settings.configJs`);
  const problems = S.checkConfig(config);
  if (problems.length) throw new Error(`config/user.json: ${problems.join('; ')}`);
  return S.configJs(config);
}

export async function build(ctx) {
  if (!fs.existsSync(ctx.path('design', 'fonts', FONT_FILE))) {
    throw new Error(`design/fonts/${FONT_FILE} is missing (the new tab's font, shipped with its licence design/fonts/OFL.txt)`);
  }
  const src = ctx.path('src', 'newtab');
  const manifest = readJsonStrict(path.join(src, 'manifest.json'), 'src/newtab/manifest.json');
  const problems = checkManifest(manifest);
  if (problems.length) throw new Error(`src/newtab/manifest.json:\n  ${problems.join('\n  ')}`);
  const idFile = path.join(src, 'EXTENSION_ID.txt');
  const id = checkId(manifest, fs.existsSync(idFile) ? fs.readFileSync(idFile, 'utf8') : null);

  const boot = fs.readFileSync(path.join(src, 'boot.js'), 'utf8');
  if (Buffer.byteLength(boot, 'utf8') >= BOOT_MAX_BYTES) throw new Error(`src/newtab/boot.js is ${Buffer.byteLength(boot, 'utf8')} bytes; it must stay under ${BOOT_MAX_BYTES}`);
  const jsDir = path.join(src, 'js');
  const own = newtabScripts(jsDir);
  const cssDir = path.join(src, 'css');
  const ownCss = newtabStyles(cssDir);
  const config = configScript(path.join(jsDir, 'ntp-settings.js'), ctx.config);

  ctx.clean(OUT);
  ctx.writeJson(`${OUT}/manifest.json`, manifest);
  ctx.write(`${OUT}/boot.js`, boot);
  const vendor = ctx.copyVendor(`${OUT}/js/pixelclock`);
  if (vendor.files.includes('screens.js')) throw new Error('screens.js must not ship in the new tab (pages show no system screen)');
  const shared = ctx.copyShared(OUT);
  ctx.write(`${OUT}/js/${CONFIG_SCRIPT}`, config);
  for (const name of own) ctx.write(`${OUT}/js/${name}`, fs.readFileSync(path.join(jsDir, name), 'utf8'));
  for (const name of ownCss) ctx.write(`${OUT}/css/${name}`, fs.readFileSync(path.join(cssDir, name), 'utf8'));
  for (const s of ICON_SIZES) ctx.copyFile(path.join(src, 'icons', `icon${s}.png`), `${OUT}/icons/icon${s}.png`);

  const scripts = [
    ...ctx.pageScripts({ js: 'js', vendor: 'js/pixelclock' }),
    `js/${CONFIG_SCRIPT}`,
    ...own.map((n) => `js/${n}`),
  ];
  const html = renderHtml(fs.readFileSync(path.join(src, 'newtab.html'), 'utf8'), {
    preload: shared.fonts.filter((f) => f.endsWith(FONT_FILE)),
    styles: [...shared.css, ...ownCss.map((n) => `css/${n}`)],
    scripts,
  });
  ctx.write(`${OUT}/newtab.html`, html);
  ctx.log(`extension id ${id}; ${scripts.length} deferred scripts; ${shared.css.length + ownCss.length} stylesheets; font bundled`);
}
