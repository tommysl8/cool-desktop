// Validator plugin: dist/newtab, the Chrome new tab extension (the build is tools/build/newtab.mjs). The core checks
// (JSON, encoding, references, CSP lint, glyphs, URL allowlist, vendor bytes) run in tools/validate.mjs; these are the
// piece's own:
//   manifest      exactly the expected keys and permissions (checkManifest in tools/build/newtab.mjs), a valid RSA
//                 public "key", no other permission, no CSP override, no background worker; the id the key gives
//                 equals src/newtab/EXTENSION_ID.txt
//   no secrets    no private key, .pem, .crx or .key file anywhere in src/newtab or dist/newtab
//   page          newtab.html: <meta charset> first, boot.js the first and only blocking script (under 2 KB), every
//                 other script deferred and classic, in build order (engine.js, pcd-hook.js, schedule.js, the
//                 themes, ... ntp-app.js last), no screens.js, title "new tab", the icon link and the inline bg style;
//                 every packaged script loaded exactly once; nothing named with a leading "_"
//   config        js/pcd-config.js sets PCD.CONFIG to the values of config/user.json
//   icons         icon16/32/48/128.png: RGBA PNGs of those sizes; 32, 48 and 128 are whole-pixel (x2, x3, x8)
//                 scale-ups of the 16 px art, so every icon is crisp
// Node built-ins only.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { BOOT_MAX_BYTES, CONFIG_SCRIPT, ICON_SIZES, OUT, checkManifest } from '../build/newtab.mjs';
import { CONFIG_KEYS } from '../lib/config.mjs';
import { ID_RE, extensionId } from '../make-key.mjs';

export const piece = 'newtab';
const SCALE = { 16: 1, 32: 2, 48: 3, 128: 8 };
const SECRET_FILE_RE = /\.(pem|crx|key|p12|pfx)$/i;
const SECRET_TEXT_RE = /-----BEGIN [A-Z ]*PRIVATE KEY-----|PRIVATE KEY/;

function row(name, pass, detail = '', extra = {}) {
  return { name: `newtab: ${name}`, pass, detail: String(detail), ...extra };
}

/** The <script> tags of an HTML text: [{ src, defer, async, module, inline }] in document order. */
export function scriptTags(html) {
  const out = [];
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
  let m;
  while ((m = re.exec(html))) {
    const attrs = m[1];
    const src = /\ssrc\s*=\s*["']?([^"'\s>]+)/i.exec(attrs);
    out.push({
      src: src ? src[1] : null,
      defer: /\sdefer\b/i.test(attrs),
      async: /\sasync\b/i.test(attrs),
      module: /\stype\s*=\s*["']?module/i.test(attrs),
      inline: !!m[2].trim(),
    });
  }
  return out;
}

/** Problems with the page structure of newtab.html: what loads first, what is deferred, and in which order. */
export function pageProblems(html) {
  const p = [];
  const head = (/<head>([\s\S]*?)<\/head>/i.exec(html) || [])[1] || '';
  const firstTag = (/<([a-z][a-z0-9-]*)\b[^>]*>/i.exec(head) || [])[0] || '';
  if (!/^<meta\s+charset=["']?utf-8["']?\s*\/?>$/i.test(firstTag)) p.push(`the first element in <head> must be <meta charset="utf-8"> (got ${firstTag || 'nothing'})`);
  if (!/<title>new tab<\/title>/.test(head)) p.push('<title>new tab</title> is missing');
  if (!/<link rel="icon" href="icons\/icon32\.png">/.test(head)) p.push('<link rel="icon" href="icons/icon32.png"> is missing');
  if (!/<style>html,body\{background:#141016\}<\/style>/.test(head)) p.push('the inline <style>html,body{background:#141016}</style> is missing');
  const tags = scriptTags(html);
  const inBody = scriptTags((/<body\b[\s\S]*$/i.exec(html) || [''])[0]);
  if (inBody.length) p.push(`${inBody.length} script(s) in <body> (all scripts belong in <head>)`);
  if (!tags.length || tags[0].src !== 'boot.js') p.push(`boot.js must be the first script (got ${tags.length ? tags[0].src : 'none'})`);
  else if (tags[0].defer || tags[0].async || tags[0].module) p.push('boot.js must be a plain blocking classic script');
  for (const t of tags.slice(1)) {
    if (!t.src) p.push('an inline script');
    else if (!t.defer || t.async || t.module) p.push(`${t.src} must be a deferred classic script (defer, no async, no module)`);
  }
  const srcs = tags.slice(1).map((t) => t.src);
  const want = ['js/pixelclock/engine.js', 'js/pcd-hook.js', 'js/pixelclock/schedule.js'];
  want.forEach((w, i) => { if (srcs[i] !== w) p.push(`deferred script ${i + 1} must be ${w} (got ${srcs[i] || 'none'})`); });
  if (srcs[srcs.length - 1] !== 'js/ntp-app.js') p.push(`js/ntp-app.js must be the last script (got ${srcs[srcs.length - 1] || 'none'})`);
  const firstOwn = srcs.findIndex((s) => /^js\/(ntp-|pcd-config)/.test(s));
  const lastTheme = srcs.map((s) => /^js\/pixelclock\/themes\//.test(s)).lastIndexOf(true);
  if (lastTheme < 0) p.push('no theme script');
  if (firstOwn >= 0 && lastTheme > firstOwn) p.push('a theme script loads after the new tab\'s own scripts');
  if (srcs.some((s) => /screens\.js$/.test(s))) p.push('screens.js must not load');
  const dup = srcs.filter((s, i) => srcs.indexOf(s) !== i);
  if (dup.length) p.push(`scripts loaded twice: ${[...new Set(dup)].join(', ')}`);
  return p;
}

export async function validate(vctx) {
  const rows = [];
  if (!vctx.exists(`${OUT}/manifest.json`)) {
    return [row('package', false, `dist/${OUT}/ is not built (run node tools/build.mjs --no-sync newtab)`)];
  }
  const files = vctx.listFiles(OUT); // paths relative to dist/
  const rel = (f) => f.slice(OUT.length + 1);

  // Manifest and id
  let manifest = null;
  try {
    manifest = vctx.readJson(`${OUT}/manifest.json`);
    const problems = checkManifest(manifest);
    rows.push(row('manifest keys and permissions exactly as expected', problems.length === 0,
      problems.length ? problems.join('; ') : `permissions ${manifest.permissions.join(', ')}; optional ${manifest.optional_permissions.join(', ')}; host ${manifest.host_permissions.join(', ')}; no CSP override, no background worker`));
  } catch (e) {
    rows.push(row('manifest keys and permissions exactly as expected', false, e.message));
  }
  const idFile = vctx.path('src', 'newtab', 'EXTENSION_ID.txt');
  const idText = fs.existsSync(idFile) ? fs.readFileSync(idFile, 'utf8').trim() : '';
  if (manifest && typeof manifest.key === 'string') {
    const id = extensionId(manifest.key);
    rows.push(row('extension id from the manifest key equals src/newtab/EXTENSION_ID.txt', ID_RE.test(idText) && id === idText, `key -> ${id}; EXTENSION_ID.txt ${idText || '(missing)'}`));
  } else {
    rows.push(row('extension id from the manifest key equals src/newtab/EXTENSION_ID.txt', false, 'the manifest has no key'));
  }

  // No secrets anywhere in the package or its source
  const secretBad = [];
  const scan = (dir, label) => {
    const walk = (d) => {
      for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
        const abs = path.join(d, ent.name);
        const shown = `${label}/${path.relative(dir, abs).split(path.sep).join('/')}`;
        if (ent.isDirectory()) { walk(abs); continue; }
        if (SECRET_FILE_RE.test(ent.name)) { secretBad.push(`${shown}: key or package file`); continue; }
        if (/\.(png|ttf)$/i.test(ent.name)) continue;
        if (SECRET_TEXT_RE.test(fs.readFileSync(abs, 'utf8'))) secretBad.push(`${shown}: contains private key text`);
      }
    };
    if (fs.existsSync(dir)) walk(dir);
  };
  scan(vctx.path('src', 'newtab'), 'src/newtab');
  scan(vctx.out(OUT), `dist/${OUT}`);
  rows.push(row('no private key, .pem, .crx or .key file (src/newtab and the package)', secretBad.length === 0, secretBad.length ? secretBad.join('; ') : 'none: the key in the manifest is public, the private half was never written'));

  // Names Chrome refuses
  const under = files.filter((f) => rel(f).split('/').some((part) => part.startsWith('_')));
  rows.push(row('no file or folder name starts with "_" (Chrome refuses to load those)', under.length === 0, under.length ? under.join(', ') : `${files.length} files`));

  // The page
  let html = '';
  try {
    html = vctx.readText(`${OUT}/newtab.html`);
    const problems = pageProblems(html);
    const tags = scriptTags(html);
    rows.push(row('newtab.html: meta charset first, boot.js the only blocking script, the rest deferred in build order, ntp-app.js last', problems.length === 0,
      problems.length ? problems.join('; ') : `${tags.length - 1} deferred scripts after boot.js`));
    const loaded = new Set(tags.map((t) => t.src).filter(Boolean));
    const shipped = files.map(rel).filter((f) => f.endsWith('.js'));
    const orphans = shipped.filter((f) => !loaded.has(f));
    const missing = [...loaded].filter((s) => !shipped.includes(s));
    rows.push(row('every packaged script is loaded by newtab.html, and every loaded script is packaged', !orphans.length && !missing.length,
      [orphans.length ? `not loaded: ${orphans.join(', ')}` : '', missing.length ? `missing: ${missing.join(', ')}` : ''].filter(Boolean).join('; ') || `${shipped.length} scripts`));
  } catch (e) {
    rows.push(row('newtab.html structure', false, e.message));
  }
  if (vctx.exists(`${OUT}/boot.js`)) {
    const n = fs.statSync(vctx.out(OUT, 'boot.js')).size;
    rows.push(row(`boot.js is under ${BOOT_MAX_BYTES} bytes (first paint)`, n < BOOT_MAX_BYTES, `${n} bytes`));
  } else {
    rows.push(row(`boot.js is under ${BOOT_MAX_BYTES} bytes (first paint)`, false, 'boot.js is missing'));
  }

  // The generated config
  try {
    const context = vm.createContext({});
    vm.runInContext(vctx.readText(`${OUT}/js/${CONFIG_SCRIPT}`), context, { filename: CONFIG_SCRIPT });
    const got = context.PCD && context.PCD.CONFIG;
    const cfg = vctx.config || {};
    const keys = CONFIG_KEYS.filter((k) => k in cfg); // the known keys only
    const differ = keys.filter((k) => got && JSON.stringify(got[k]) !== JSON.stringify(cfg[k]));
    rows.push(row(`js/${CONFIG_SCRIPT} sets PCD.CONFIG from config/user.json`, !!got && differ.length === 0,
      !got ? 'PCD.CONFIG not set' : differ.length ? `differs in ${differ.join(', ')} (rebuild)` : `${Object.keys(got).length} fields (the city is not printed)`));
  } catch (e) {
    rows.push(row(`js/${CONFIG_SCRIPT} sets PCD.CONFIG from config/user.json`, false, e.message));
  }

  // Icons
  const iconBad = [];
  let base = null;
  for (const s of ICON_SIZES) {
    const f = `${OUT}/icons/icon${s}.png`;
    if (!vctx.exists(f)) { iconBad.push(`icon${s}.png missing`); continue; }
    try {
      const img = vctx.decodePng(f);
      const info = vctx.pngSize(f);
      if (img.width !== s || img.height !== s) { iconBad.push(`icon${s}.png is ${img.width}x${img.height}`); continue; }
      if (info.colorType !== 6 || info.bitDepth !== 8) iconBad.push(`icon${s}.png is not 8-bit RGBA`);
      if (s === 16) { base = img; continue; }
      if (!base) continue;
      const k = SCALE[s];
      let off = 0;
      for (let y = 0; y < s; y++) {
        for (let x = 0; x < s; x++) {
          const a = (y * s + x) * 4;
          const b = (Math.floor(y / k) * 16 + Math.floor(x / k)) * 4;
          for (let c = 0; c < 4; c++) if (img.data[a + c] !== base.data[b + c]) off++;
        }
      }
      if (off) iconBad.push(`icon${s}.png is not a whole-pixel x${k} scale of icon16.png (${off} values differ)`);
    } catch (e) {
      iconBad.push(`icon${s}.png: ${e.message}`);
    }
  }
  rows.push(row('icons 16/32/48/128: RGBA PNGs, whole-pixel scale-ups of the 16 px art (crisp)', iconBad.length === 0, iconBad.length ? iconBad.join('; ') : 'x1, x2, x3, x8'));

  // Size (information)
  const bytes = files.reduce((n, f) => n + fs.statSync(vctx.out(f)).size, 0);
  rows.push(row('package size', true, `${files.length} files, ${(bytes / 1024).toFixed(1)} KB`));
  return rows;
}
