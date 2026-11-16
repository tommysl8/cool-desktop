#!/usr/bin/env node
// PixelClock Desktop validator: node tools/validate.mjs [piece ...]
//
// Core checks over dist/** (plus config/user.json and vendor/pixelclock/):
//   strict JSON parse of every .json (BOM = fail); text files UTF-8 without BOM, LF endings; every local
//   src / href / CSS url() reference exists inside its package folder; the font's licence beside every shipped font
//   file; CSP lint of shipped .html/.js (inline script bodies, on*= attributes, javascript: URLs, remote scripts and
//   stylesheets, eval, new Function, string timers, innerHTML/outerHTML/insertAdjacentHTML, document.write, remote
//   import, importScripts); safe glyphs in PCD-authored text (vendor copies and licence texts exempt); a URL
//   allowlist for shipped code (api.open-meteo.com, geocoding-api.open-meteo.com, the open-meteo.com credit link,
//   pixelclock.local, the config shortcuts); config/user.json values; vendor/pixelclock/ against SYNC.json; every
//   dist copy of the engine byte identical to vendor; drift between vendor and the live clock repo (a WARN,
//   read-only); the token contrast table when tools/lib/tokens.mjs provides contrastRows().
// Then piece plugins tools/validate/<piece>.mjs: `export async function validate(vctx)` returning
// [{ name, pass, detail }]. Prints a PASS/FAIL table; exit code 1 on any FAIL. Node built-ins only.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as fsx from './lib/fsx.mjs';
import { FONT_LICENCE } from './build.mjs';
import { contrast, formatRatio } from './lib/color.mjs';
import { CONFIG_REL, MISSING_CONFIG, shortcutHosts, validateConfig } from './lib/config.mjs';
import { hex, isSafeChar } from './lib/glyphs.mjs';
import { decodePng, imageSize, isPng, pngSize } from './lib/png.mjs';
import { printReport } from './lib/report.mjs';
import { checkVendor, vendorDir, vendorSourceOf } from './lib/vendor.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, '..');
export const PIECES = ['style-tile', 'newtab', 'wallpaper', 'still'];

/** Text files that are checked for encoding, line endings, glyphs and URLs. */
export const TEXT_EXTS = ['.html', '.js', '.mjs', '.cjs', '.css', '.json', '.txt', '.md', '.xml'];
/** Licence texts are shipped verbatim and exempt from the glyph scan. */
export const LICENCE_RE = /^(OFL|LICEN[CS]E|COPYING)(\.[A-Za-z0-9]+)?$/i;
/** Font files: each folder of them ships with the font's licence (FONT_LICENCE from tools/build.mjs). */
export const FONT_RE = /\.(ttf|otf|woff2?)$/i;
/** Hosts shipped code may name (plus the config shortcuts' hosts). The last four: the new tab terminal's g/yt/gh
 *  targets and a doc comment in the copied terminal libraries (the terminal's router.js and url.js): navigation you
 *  type, never fetched. */
export const ALLOWED_HOSTS = ['api.open-meteo.com', 'geocoding-api.open-meteo.com', 'open-meteo.com', 'pixelclock.local',
  'www.google.com', 'www.youtube.com', 'github.com', 'example.com'];
/** XML namespace names are identifiers, never fetched. */
export const NAMESPACE_URLS = ['http://www.w3.org/2000/svg', 'http://www.w3.org/1999/xhtml', 'http://www.w3.org/1999/xlink'];

/** Unsafe code points in text: Map(codePoint -> { count, line, col }). Tabs and line breaks are allowed. */
export function scanGlyphs(text, safe = isSafeChar) {
  const bad = new Map();
  let line = 1;
  let col = 0;
  for (const ch of text) {
    if (ch === '\n') { line++; col = 0; continue; }
    col++;
    if (ch === '\r' || ch === '\t') continue;
    if (safe(ch)) continue;
    const cp = ch.codePointAt(0);
    const e = bad.get(cp);
    if (e) e.count++;
    else bad.set(cp, { count: 1, line, col });
  }
  return bad;
}

/** Local references in HTML: src/href attributes plus url() in style blocks and attributes. */
export function htmlRefs(html) {
  const cleaned = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/(<script\b[^>]*>)[\s\S]*?(<\/script\s*>)/gi, '$1$2');
  const refs = [];
  const tagRe = /<[a-zA-Z][^>]*>/g;
  let m;
  while ((m = tagRe.exec(cleaned))) {
    const attrRe = /\s(src|href)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gi;
    let a;
    while ((a = attrRe.exec(m[0]))) refs.push({ ref: a[2] ?? a[3] ?? a[4] ?? '', kind: a[1].toLowerCase() });
  }
  for (const r of cssRefs(cleaned)) refs.push(r);
  return refs;
}

/** Local references in CSS: url(...) and @import "...". */
export function cssRefs(css) {
  const cleaned = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const refs = [];
  const urlRe = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)"'\s]*))\s*\)/gi;
  let m;
  while ((m = urlRe.exec(cleaned))) refs.push({ ref: m[1] ?? m[2] ?? m[3] ?? '', kind: 'url()' });
  const impRe = /@import\s+(?:"([^"]*)"|'([^']*)')/gi;
  while ((m = impRe.exec(cleaned))) refs.push({ ref: m[1] ?? m[2], kind: '@import' });
  return refs;
}

/** True for references that point at a packaged file (no scheme, not protocol-relative, not #frag). */
export function isLocalRef(ref) {
  const r = ref.trim();
  if (!r || r.startsWith('#') || r.startsWith('//')) return false;
  return !/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(r);
}

/** Resolve a local reference from a dist file; '/x' means the root of the file's package folder. */
export function resolveRef(dist, fileAbs, ref) {
  const rel = path.relative(dist, fileAbs).split(path.sep);
  const pkgRoot = rel.length > 1 ? path.join(dist, rel[0]) : dist;
  const bare = ref.trim().split('#')[0].split('?')[0];
  let decoded = bare;
  try { decoded = decodeURIComponent(bare); } catch { /* keep raw */ }
  const target = decoded.startsWith('/') ? path.join(pkgRoot, decoded) : path.resolve(path.dirname(fileAbs), decoded);
  if (!fsx.isInside(pkgRoot, target)) return { ok: false, why: 'escapes its package folder', target };
  if (!fs.existsSync(target)) return { ok: false, why: 'missing', target };
  return { ok: true, target };
}

/** CSP lint findings for one HTML file: inline script bodies, on*= attributes, javascript: URLs, remote scripts/styles. */
export function lintHtml(html) {
  const bad = [];
  const scriptRe = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
  let m;
  while ((m = scriptRe.exec(html))) {
    if (m[2].trim()) bad.push('inline <script> body');
    const src = /\ssrc\s*=\s*["']?([^"'\s>]+)/i.exec(m[1]);
    if (src && /^(https?:)?\/\//i.test(src[1])) bad.push(`remote script ${src[1]}`);
  }
  const tagRe = /<[a-zA-Z][^>]*>/g;
  while ((m = tagRe.exec(html))) {
    const on = /\son[a-z]+\s*=/i.exec(m[0]);
    if (on) bad.push(`event handler attribute in ${m[0].slice(0, 60)}`);
    if (/=\s*["']?\s*javascript:/i.test(m[0])) bad.push(`javascript: URL in ${m[0].slice(0, 60)}`);
    if (/^<link\b/i.test(m[0]) && /rel\s*=\s*["']?stylesheet/i.test(m[0]) && /href\s*=\s*["']?(https?:)?\/\//i.test(m[0])) bad.push(`remote stylesheet ${m[0]}`);
  }
  return bad;
}

/** The JS lint rules: [regexp, label]. */
export const JS_RULES = [
  [/\beval\s*\(/, 'eval('],
  [/\bnew\s+Function\s*\(/, 'new Function('],
  [/(^|[^.\w])Function\s*\(\s*['"`]/, 'Function("...")'],
  [/\bset(Timeout|Interval)\s*\(\s*['"`]/, 'string timer'],
  [/\.(innerHTML|outerHTML)\b/, 'innerHTML/outerHTML'],
  [/\binsertAdjacentHTML\b/, 'insertAdjacentHTML'],
  [/\bdocument\.write(ln)?\s*\(/, 'document.write'],
  [/\b(href|src|location)\s*=\s*['"`]\s*javascript:/i, 'javascript: URL'],
  [/\bimport\s*\(\s*['"`](https?:)?\/\//, 'remote import()'],
  [/\bfrom\s+['"`](https?:)?\/\//, 'remote import'],
  [/\bimportScripts\s*\(/, 'importScripts'],
];

/** CSP lint findings for one JS file (line numbers included). */
export function lintJs(text) {
  const bad = [];
  text.split('\n').forEach((line, i) => {
    for (const [re, what] of JS_RULES) if (re.test(line)) bad.push(`${what} (line ${i + 1})`);
  });
  return bad;
}

/** URLs in text that name a host outside `allowed`: [{ url, host, line }]. ws/wss URLs are always reported. */
export function foreignUrls(text, allowed) {
  const out = [];
  const re = /\b(https?|wss?):\/\/([^\s'"`<>()\\]+)/gi;
  const lines = text.split('\n');
  lines.forEach((lineText, i) => {
    let m;
    re.lastIndex = 0;
    while ((m = re.exec(lineText))) {
      const url = m[0].replace(/[.,;:]+$/, '');
      if (NAMESPACE_URLS.some((ns) => url === ns || url.startsWith(ns + '"'))) continue;
      let host = '';
      try { host = new URL(url).hostname.toLowerCase(); } catch { host = m[2].split(/[/:?#]/)[0].toLowerCase(); }
      if (/^wss?$/i.test(m[1]) || !allowed.includes(host)) out.push({ url, host, line: i + 1 });
    }
  });
  return out;
}

/** True for a dist path inside a vendor copy (a folder named pixelclock). */
export function isVendorCopy(rel) {
  return rel.split('/').includes('pixelclock');
}

function row(name, pass, detail = '', extra = {}) {
  return { name, pass, detail, ...extra };
}

function listDetail(items, max = 25) {
  const shown = items.slice(0, max);
  const more = items.length > max ? [`... and ${items.length - max} more`] : [];
  return [...shown, ...more].join('\n');
}

/** Drift between vendor/ and the live clock repo, read-only through tools/sync.mjs. A WARN row, never a FAIL. */
async function driftRow({ root, clockRepo }) {
  const name = 'core: vendor/pixelclock matches the live clock repo (drift)';
  const sync = await import(pathToFileURL(path.join(HERE, 'sync.mjs')).href);
  const source = clockRepo || sync.defaultSource(process.env, root);
  if (!fs.existsSync(path.join(source, 'simulator', 'engine.js'))) return row(name, null, `clock repo not found at ${source}: not compared`, { skip: true });
  try {
    const src = sync.readSource(source);
    const diff = sync.compare(src.files, sync.readVendor(vendorDir(root)));
    if (diff.same) return row(name, true, `${src.files.length} files identical (clock commit ${src.commit.slice(0, 7)})`);
    const parts = [...diff.added.map((p) => `+ ${p}`), ...diff.changed.map((p) => `~ ${p}`), ...diff.removed.map((p) => `- ${p}`)];
    return row(name, true, `the clock repo changed since the last sync (run node tools/sync.mjs):\n${listDetail(parts.length ? parts : ['SYNC.json differs'])}`, { warn: true });
  } catch (e) {
    return row(name, true, `could not compare: ${e.message}`, { warn: true });
  }
}

/** The core checks. Resolves { rows, contrastRows, config, files }. */
export async function coreChecks({ root, dist, clockRepo }) {
  const rows = [];
  const files = fsx.listFiles(dist);
  const textFiles = files.filter((f) => TEXT_EXTS.includes(path.extname(f).toLowerCase()));
  rows.push(row('core: dist files', true, fs.existsSync(dist) ? `${files.length} files (${textFiles.length} text) under dist/` : 'dist/ does not exist yet (nothing built); 0 files'));

  // Strict JSON (dist + config + SYNC.json); a missing config/user.json is reported by the config row below
  const jsonBad = [];
  const parsed = {};
  const configAbs = path.join(root, ...CONFIG_REL.split('/'));
  const jsonFiles = [
    ...(fs.existsSync(configAbs) ? [{ label: CONFIG_REL, abs: configAbs }] : []),
    ...(fs.existsSync(path.join(vendorDir(root), 'SYNC.json')) ? [{ label: 'vendor/pixelclock/SYNC.json', abs: path.join(vendorDir(root), 'SYNC.json') }] : []),
    ...files.filter((f) => f.toLowerCase().endsWith('.json')).map((f) => ({ label: `dist/${f}`, abs: path.join(dist, f) })),
  ];
  for (const j of jsonFiles) {
    try { parsed[j.label] = fsx.readJsonStrict(j.abs, j.label); } catch (e) { jsonBad.push(e.message); }
  }
  rows.push(row('core: strict JSON parse (BOM = fail)', jsonBad.length === 0, jsonBad.length ? listDetail(jsonBad) : `${jsonFiles.length} files`));

  // Encoding and line endings
  const encBad = [];
  const crlf = [];
  const texts = new Map();
  for (const f of textFiles) {
    const buf = fs.readFileSync(path.join(dist, f));
    if (fsx.hasBom(buf)) encBad.push(`dist/${f}: UTF-8 BOM`);
    let text;
    try { text = fsx.decodeUtf8Strict(buf, `dist/${f}`); } catch (e) { encBad.push(e.message); text = buf.toString('utf8'); }
    if (text.includes('\r\n')) crlf.push(`dist/${f}: CRLF line endings`);
    texts.set(f, text);
  }
  rows.push(row('core: text files are UTF-8 without BOM', encBad.length === 0, encBad.length ? listDetail(encBad) : `${textFiles.length} files`));
  rows.push(row('core: text files use LF line endings', crlf.length === 0, crlf.length ? listDetail(crlf) : `${textFiles.length} files`));

  // Local references
  const refBad = [];
  let refCount = 0;
  for (const f of textFiles) {
    const ext = path.extname(f).toLowerCase();
    if (ext !== '.html' && ext !== '.css') continue;
    const abs = path.join(dist, f);
    const refs = ext === '.html' ? htmlRefs(texts.get(f)) : cssRefs(texts.get(f));
    for (const r of refs) {
      if (!isLocalRef(r.ref)) continue;
      refCount++;
      const res = resolveRef(dist, abs, r.ref);
      if (!res.ok) refBad.push(`dist/${f}: ${r.kind} "${r.ref}" ${res.why}`);
    }
  }
  rows.push(row('core: local src/href/url() references exist', refBad.length === 0, refBad.length ? listDetail(refBad) : `${refCount} references`));

  // The font travels with its licence: every folder of shipped font files holds OFL.txt too
  const fontDirs = new Map();
  for (const f of files) {
    if (!FONT_RE.test(f)) continue;
    const dir = path.posix.dirname(f);
    if (!fontDirs.has(dir)) fontDirs.set(dir, []);
    fontDirs.get(dir).push(path.posix.basename(f));
  }
  const unlicensed = [...fontDirs.keys()].filter((dir) => !files.includes(`${dir}/${FONT_LICENCE}`));
  rows.push(row(`core: fonts/${FONT_LICENCE} beside every fonts/*.ttf`, unlicensed.length === 0, unlicensed.length
    ? listDetail(unlicensed.map((dir) => `dist/${dir}/: ${fontDirs.get(dir).join(', ')} without ${FONT_LICENCE}`))
    : (fontDirs.size ? `${fontDirs.size} font folder(s): ${[...fontDirs.keys()].map((dir) => `dist/${dir}/`).join(', ')}` : 'no font files under dist/')));

  // CSP lint
  const cspBad = [];
  let linted = 0;
  for (const f of textFiles) {
    const ext = path.extname(f).toLowerCase();
    if (ext === '.html') { linted++; for (const b of lintHtml(texts.get(f))) cspBad.push(`dist/${f}: ${b}`); }
    if (ext === '.js' || ext === '.mjs') { linted++; for (const b of lintJs(texts.get(f))) cspBad.push(`dist/${f}: ${b}`); }
  }
  rows.push(row('core: CSP lint (inline scripts, on*=, javascript:, eval, new Function, string timers, remote code, innerHTML)', cspBad.length === 0, cspBad.length ? listDetail(cspBad) : `${linted} files clean`));

  // Safe glyphs (PCD-authored text only)
  const glyphBad = [];
  let scanned = 0;
  for (const f of textFiles) {
    if (LICENCE_RE.test(path.posix.basename(f)) || isVendorCopy(f)) continue;
    scanned++;
    const bad = scanGlyphs(texts.get(f));
    if (bad.size) {
      const list = [...bad.entries()].sort((a, b) => a[0] - b[0]).map(([cp, e]) => `${hex(cp)} x${e.count} (first at ${e.line}:${e.col})`);
      glyphBad.push(`dist/${f}: ${list.join(', ')}`);
    }
  }
  rows.push(row('core: safe glyphs only (vendor copies and licence texts exempt)', glyphBad.length === 0, (glyphBad.length ? listDetail(glyphBad) + '\n' : '') + `${scanned} files scanned; glyph set: tools/lib/glyphs.mjs`));

  // URL allowlist
  const config = parsed[CONFIG_REL] || null;
  const allowed = [...ALLOWED_HOSTS, ...shortcutHosts(config)];
  const urlBad = [];
  for (const f of textFiles) {
    if (LICENCE_RE.test(path.posix.basename(f))) continue;
    for (const u of foreignUrls(texts.get(f), allowed)) urlBad.push(`dist/${f}:${u.line}: ${u.url}`);
  }
  // the configured link hosts are your own: counted, never printed
  const own = allowed.length - ALLOWED_HOSTS.length;
  rows.push(row('core: shipped URLs only name allowed hosts', urlBad.length === 0, urlBad.length ? listDetail(urlBad) : `allowed: ${ALLOWED_HOSTS.join(', ')}, and ${own} link host(s) from config/user.json (not printed)`));

  // config/user.json values (the city is never printed)
  if (config) {
    const cerrs = validateConfig(config);
    rows.push(row('core: config/user.json values', cerrs.length === 0, cerrs.length ? listDetail(cerrs) : `units ${config.units}, clock ${config.clock}, ${config.shortcuts.length} shortcuts, taskbarPx ${config.taskbarPx}`));
  } else if (!fs.existsSync(configAbs)) {
    rows.push(row('core: config/user.json values', false, MISSING_CONFIG));
  }

  // vendor/pixelclock against SYNC.json
  const vendor = checkVendor(vendorDir(root));
  rows.push(row('core: vendor/pixelclock matches SYNC.json', vendor.ok, vendor.ok ? `${vendor.files.length} files, clock commit ${String(vendor.sync.commit).slice(0, 7)}, synced ${vendor.sync.syncedAt}` : listDetail(vendor.problems)));

  // dist copies of the engine are byte identical to vendor
  const copyBad = [];
  let copies = 0;
  const vendorFiles = new Map(vendor.files.map((f) => [f.path, f]));
  for (const f of files) {
    const parts = f.split('/');
    const i = parts.indexOf('pixelclock');
    if (i === -1) continue;
    const inner = parts.slice(i + 1).join('/');
    const src = vendorSourceOf(inner);
    if (!src || !vendorFiles.has(src)) { copyBad.push(`dist/${f}: not a vendor file`); continue; }
    copies++;
    const a = fs.readFileSync(path.join(dist, f));
    const b = fs.readFileSync(path.join(vendorDir(root), ...src.split('/')));
    if (!a.equals(b)) copyBad.push(`dist/${f}: differs from vendor/pixelclock/${src}`);
  }
  rows.push(row('core: dist engine copies are byte identical to vendor', copyBad.length === 0, copyBad.length ? listDetail(copyBad) : `${copies} copies`));

  rows.push(await driftRow({ root, clockRepo }));

  // Token contrast (when tools/lib/tokens.mjs provides it)
  let contrastRows = [];
  const tokensMod = path.join(root, 'tools', 'lib', 'tokens.mjs');
  if (fs.existsSync(tokensMod)) {
    try {
      const mod = await import(pathToFileURL(tokensMod).href);
      if (typeof mod.contrastRows === 'function') {
        contrastRows = await mod.contrastRows({ root, config });
        const bad = contrastRows.filter((r) => !r.pass);
        rows.push(row('core: token contrast (WCAG 2.2)', bad.length === 0, bad.length
          ? listDetail(bad.map((r) => `${r.token} vs ${r.against}: ${formatRatio(r.ratio)}:1 < ${r.min}:1`))
          : `${contrastRows.length} pairs`));
      }
    } catch (e) {
      rows.push(row('core: token contrast (WCAG 2.2)', false, `tools/lib/tokens.mjs: ${e.message}`));
    }
  }
  return { rows, contrastRows, config, files };
}

/** The vctx handed to piece validators (rel paths are relative to dist/). */
export function createValidateContext({ root, dist, config }) {
  const abs = (rel = '') => {
    if (typeof rel !== 'string') throw new TypeError('vctx: rel path must be a string');
    const p = path.resolve(dist, rel);
    if (!fsx.isInside(dist, p)) throw new Error(`vctx: "${rel}" escapes dist/`);
    return p;
  };
  return {
    root,
    dist,
    config,
    readText: (rel) => fs.readFileSync(abs(rel), 'utf8'),
    readJson: (rel) => fsx.readJsonStrict(abs(rel), `dist/${rel}`),
    exists: (rel) => fs.existsSync(abs(rel)),
    listFiles: (rel = '') => fsx.listFiles(abs(rel), { base: dist }),
    pngSize: (p) => pngSize(path.isAbsolute(p) ? p : abs(p)),
    out: (...rel) => abs(path.join(...rel)),
    path: (...rel) => path.resolve(root, ...rel),
    imageSize: (p) => imageSize(path.isAbsolute(p) ? p : abs(p)),
    decodePng: (p) => decodePng(path.isAbsolute(p) ? p : abs(p)),
    isPng,
    contrast,
    lintHtml,
    lintJs,
    glyphs: {
      source: 'tools/lib/glyphs.mjs',
      isSafeChar,
      unsafeChars: (text) => [...scanGlyphs(text).keys()].sort((a, b) => a - b).map(hex),
    },
  };
}

/** Discover tools/validate/*.mjs: documented pieces first, then others by name. */
export function discoverPlugins(root) {
  const dir = path.join(root, 'tools', 'validate');
  if (!fs.existsSync(dir)) return [];
  const names = fs.readdirSync(dir).filter((n) => n.endsWith('.mjs') && !n.startsWith('_')).map((n) => n.slice(0, -4));
  const known = PIECES.filter((p) => names.includes(p));
  const other = names.filter((n) => !PIECES.includes(n)).sort();
  return [...known, ...other].map((piece) => ({ piece, file: path.join(dir, `${piece}.mjs`) }));
}

/** Run everything. Resolves { rows, failed, code }. */
export async function runValidate({ root = ROOT, dist, pieces = [], clockRepo, log = console.log } = {}) {
  root = path.resolve(root);
  dist = path.resolve(dist || path.join(root, 'dist'));
  const core = await coreChecks({ root, dist, clockRepo });
  const rows = [...core.rows];
  const vctx = createValidateContext({ root, dist, config: core.config });
  const plugins = discoverPlugins(root);
  const chosen = pieces.length ? plugins.filter((p) => pieces.includes(p.piece)) : plugins;
  for (const p of pieces) if (!plugins.some((x) => x.piece === p)) log(`skip ${p}: no validator plugin`);
  for (const { piece, file } of chosen) {
    try {
      const mod = await import(pathToFileURL(file).href);
      if (typeof mod.validate !== 'function') throw new Error(`tools/validate/${piece}.mjs does not export async function validate(vctx)`);
      const res = await mod.validate(vctx);
      if (!Array.isArray(res)) throw new Error('validate(vctx) must return an array of { name, pass, detail }');
      for (const r of res) {
        const item = r && typeof r === 'object' ? r : { name: String(r), pass: false, detail: 'not a { name, pass, detail } object' };
        const name = String(item.name || '(unnamed check)');
        const skip = !!item.skip || item.pass === null;
        rows.push({ name: name.startsWith(piece) ? name : `${piece}: ${name}`, pass: skip ? null : !!item.pass, skip, warn: !!item.warn, detail: item.detail !== undefined ? String(item.detail) : '' });
      }
    } catch (e) {
      rows.push(row(`${piece}: validator plugin`, false, `crashed: ${e && e.stack ? e.stack : e}`));
    }
  }
  const counts = printReport(rows, { title: `PixelClock Desktop validate (${path.relative(root, dist) || 'dist'}${pieces.length ? '; pieces: ' + pieces.join(', ') : ''})`, log });
  return { rows, failed: counts.failed, code: counts.failed ? 1 : 0 };
}

export async function main({ argv = process.argv.slice(2), root = ROOT, dist, log = console.log, logError = console.error } = {}) {
  const pieces = [];
  for (const a of argv) {
    if (a === '-h' || a === '--help') { log(`usage: node tools/validate.mjs [piece ...]\npieces: ${PIECES.join(', ')} (and any other tools/validate/<name>.mjs)`); return 0; }
    if (a.startsWith('-')) { logError(`unknown option ${a}`); return 1; }
    const known = PIECES.includes(a) || fs.existsSync(path.join(root, 'tools', 'validate', `${a}.mjs`));
    if (!known) { logError(`unknown piece "${a}" (known: ${PIECES.join(', ')})`); return 1; }
    pieces.push(a);
  }
  const { code } = await runValidate({ root, dist, pieces, log });
  return code;
}

function isMainModule() {
  if (typeof import.meta.main === 'boolean') return import.meta.main;
  if (!process.argv[1]) return false;
  try {
    return path.relative(fs.realpathSync(process.argv[1]), fileURLToPath(import.meta.url)) === '';
  } catch {
    return false;
  }
}

if (isMainModule()) {
  main().then(
    (code) => {
      process.exitCode = code;
      setTimeout(() => process.exit(code), 3000).unref();
    },
    (e) => {
      console.error(e);
      process.exit(1);
    },
  );
}
