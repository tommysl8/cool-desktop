// Validator plugin: dist/wallpaper (the Lively package) and dist/PixelClockDesktop-wallpaper.zip.
//
// - Package files: exactly the expected set (the four root files, js/lively.js, the page scripts in build order, the
//   styles, the fonts).
// - LivelyInfo.json: exactly LIVELY_INFO byte for byte (one line + LF), equal to src/wallpaper/LivelyInfo.json;
//   "Arguments" exactly "--pause-event true" (never a flag Lively passes itself, never a repeat: exit 87).
// - LivelyProperties.json: Lively's schema rules (PCD.wpProps.checkProperties) and exactly what the build generates
//   from config/user.json over the synced theme menu (the dropdown order equals PCD.engine.menu); the page's own
//   defaults (js/pcd-config.js) equal what Lively replays from that file.
// - index.html: charset first, the inline background, js/lively.js first and blocking in <head>, every other script a
//   deferred classic script in build order, stylesheets in order, nothing remote or outside the package.
// - js/lively.js: the three callbacks are top-level function declarations; calls before the app queue in order.
// - Shipped code: no ES modules, prefers-color-scheme, geolocation, "../", never pixelclock.local (the clock status
//   is the new tab's only: Local Network Access blocks it from a wallpaper page), URLs only to Open-Meteo.
// - Copies equal their sources; generated files equal what the build writes now.
// - thumbnail.jpg: JPEG, at most 1280x800, under 300 KB.
// - Zip gate: entries read by Node (central directory, CRC, inflated bytes == dist/wallpaper), Python zipfile and
//   tar.exe -tf: the four root files, posix names, no "./", no directory entries, no top folder, deflated.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { createContext, sharedLists, FONT_FILES } from '../build.mjs';
import {
  APP_SCRIPTS, APP_STYLES, CONFIG_SCRIPT, LIVELY_INFO, LIVELY_INFO_TEXT, LIVELY_SCRIPT, OUT, ROOT_FILES, SETTINGS_SCRIPT,
  SETTINGS_SRC, THUMB, ZIP, deferredScripts, genConfigJs, genProperties, loadModel, pageStyles, renderHtml,
} from '../build/wallpaper.mjs';
import { findPython, normalizeText } from '../lib/fsx.mjs';

export const piece = 'wallpaper';
/** The only Arguments value the wallpaper may carry: Lively's pause event, nothing else. */
export const ARGUMENTS = '--pause-event true';
/** Flags a Type 1 (web) wallpaper may put in Arguments (Lively rewrites "--x" to "--wallpaper-x"). */
export const ALLOWED_FLAGS = ['--system-information', '--system-nowplaying', '--pause-event', '--verbose-log', '--audio'];
/** Flags Lively passes to the player itself: passing one again is a repeated option and the player exits (87). */
export const FORBIDDEN_FLAGS = ['--pause-media', '--volume', '--scale', '--url', '--color-scheme', '--user-data', '--display', '--property', '--geometry', '--type', '--audio-id', '--debug'];
export const CALLBACKS = ['livelyPropertyListener', 'livelyWallpaperPlaybackChanged', 'livelySystemInformation'];
/** Hosts shipped wallpaper code may name. */
export const ALLOWED_HOSTS = ['api.open-meteo.com', 'geocoding-api.open-meteo.com', 'open-meteo.com'];

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Problems with an Arguments string ([] = fine): Lively splits on single spaces; values only true/false. */
export function checkArguments(args, { type = 1 } = {}) {
  const errors = [];
  if (typeof args !== 'string') return ['Arguments must be a string'];
  if (args === '') return errors;
  const seen = new Set();
  let prevFlag = null;
  args.split(' ').forEach((w, i) => {
    if (w === '') {
      errors.push(`empty word at position ${i + 1} (double, leading or trailing space)`);
      prevFlag = null;
      return;
    }
    if (w.startsWith('--')) {
      const flag = w.toLowerCase();
      if (FORBIDDEN_FLAGS.includes(flag)) errors.push(`${w}: Lively passes it to the player itself, so it would be repeated (exit 87)`);
      else if (!ALLOWED_FLAGS.includes(flag)) errors.push(`${w}: not a known player option (exit 87)`);
      else if (flag === '--audio' && type === 2) errors.push('--audio: Lively adds it for Type 2 already (exit 87)');
      if (seen.has(flag)) errors.push(`${w}: repeated (exit 87)`);
      seen.add(flag);
      prevFlag = flag;
      return;
    }
    if (!prevFlag) errors.push(`"${w}": a value without a flag`);
    else if (w !== 'true' && w !== 'false') errors.push(`"${w}" after ${prevFlag}: only true or false`);
    prevFlag = null;
  });
  return errors;
}

/** Problems with LivelyInfo.json text ([] = exactly LIVELY_INFO_TEXT with Arguments "--pause-event true"). */
export function checkLivelyInfoText(text) {
  const errors = [];
  if (typeof text !== 'string') return ['LivelyInfo.json is not text'];
  if (text.charCodeAt(0) === 0xfeff) errors.push('starts with a BOM');
  let info = null;
  try {
    info = JSON.parse(text);
  } catch (e) {
    return [...errors, `not strict JSON: ${e.message}`];
  }
  if (!isObj(info)) return [...errors, 'not a JSON object'];
  const want = Object.keys(LIVELY_INFO);
  const got = Object.keys(info);
  const missing = want.filter((k) => !got.includes(k));
  const extra = got.filter((k) => !want.includes(k));
  if (missing.length) errors.push(`missing keys: ${missing.join(', ')}`);
  if (extra.length) errors.push(`unknown keys: ${extra.join(', ')}`);
  for (const k of want) if (k in info && JSON.stringify(info[k]) !== JSON.stringify(LIVELY_INFO[k])) errors.push(`${k}: ${JSON.stringify(info[k])}, want ${JSON.stringify(LIVELY_INFO[k])}`);
  if (info.Arguments !== ARGUMENTS) errors.push(`Arguments ${JSON.stringify(info.Arguments)}, want exactly ${JSON.stringify(ARGUMENTS)}`);
  for (const e of checkArguments(info.Arguments, { type: info.Type })) errors.push(`Arguments: ${e}`);
  if (!errors.length && text !== LIVELY_INFO_TEXT) errors.push('bytes differ from LIVELY_INFO_TEXT (one line, no spaces, a final LF)');
  return errors;
}

function tagsOf(html, tag) {
  const out = [];
  const re = new RegExp(`<${tag}\\b[^>]*>`, 'gi');
  let m;
  while ((m = re.exec(html))) out.push({ tag: m[0], index: m.index });
  return out;
}

function attr(tag, name) {
  const m = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag);
  return m ? (m[1] ?? m[2] ?? m[3]) : null;
}

/** Problems with index.html ([] = fine). scripts: the deferred srcs in order; styles: the stylesheet hrefs in order. */
export function checkIndexHtml(html, { scripts, styles }) {
  const errors = [];
  const headM = /<head[^>]*>([\s\S]*?)<\/head>/i.exec(html);
  if (!headM) return ['no <head>'];
  const head = headM[1];
  const headStart = headM.index;
  const headEnd = headStart + headM[0].length;
  if (!/^\s*<meta\s+charset="utf-8">/i.test(head)) errors.push('<meta charset="utf-8"> must be the first thing in <head>');
  const inline = /<style>([\s\S]*?)<\/style>/i.exec(head);
  if (!inline || !/html\s*,\s*body\s*\{\s*background\s*:\s*#141016\s*;?\s*\}/i.test(inline[1])) errors.push('no inline <style>html,body{background:#141016}</style> in <head>');
  const firstLink = head.search(/<link\b[^>]*rel\s*=\s*["']?stylesheet/i);
  if (inline && firstLink !== -1 && head.indexOf(inline[0]) > firstLink) errors.push('the inline background must come before the stylesheets');
  if (!/<title>[^<]+<\/title>/i.test(head)) errors.push('no <title>');
  const tags = tagsOf(html, 'script');
  if (!tags.length) return [...errors, 'no scripts'];
  const first = tags[0];
  if (attr(first.tag, 'src') !== LIVELY_SCRIPT) errors.push(`the first script is ${attr(first.tag, 'src')}, want ${LIVELY_SCRIPT}`);
  if (/\b(defer|async)\b/i.test(first.tag) || /type\s*=\s*["']?module/i.test(first.tag)) errors.push(`${LIVELY_SCRIPT} must be a blocking classic script (no defer, async or module)`);
  if (first.index < headStart || first.index > headEnd) errors.push(`${LIVELY_SCRIPT} must be in <head>`);
  if (inline && first.index - headStart < head.indexOf(inline[0])) errors.push(`${LIVELY_SCRIPT} must come after the inline background`);
  const rest = tags.slice(1);
  for (const t of rest) {
    const src = attr(t.tag, 'src');
    if (src === null) errors.push('an inline <script> (use packaged files)');
    if (/type\s*=\s*["']?module/i.test(t.tag)) errors.push(`${src}: type="module" (classic scripts only: Lively's callbacks are global)`);
    if (/\basync\b/i.test(t.tag)) errors.push(`${src}: async (the load order must stay as built)`);
    if (!/\bdefer\b/i.test(t.tag)) errors.push(`${src}: not deferred (only ${LIVELY_SCRIPT} blocks)`);
  }
  const srcs = rest.map((t) => attr(t.tag, 'src'));
  if (JSON.stringify(srcs) !== JSON.stringify(scripts)) errors.push(`deferred scripts:\n  got  ${srcs.join(', ')}\n  want ${scripts.join(', ')}`);
  const links = tagsOf(html, 'link').filter((l) => /rel\s*=\s*["']?stylesheet/i.test(l.tag)).map((l) => attr(l.tag, 'href'));
  if (JSON.stringify(links) !== JSON.stringify(styles)) errors.push(`stylesheets ${links.join(', ')}; want ${styles.join(', ')}`);
  const refs = [...tagsOf(html, '[a-z]+')].flatMap((t) => [attr(t.tag, 'src'), attr(t.tag, 'href')]).filter((v) => v !== null);
  const remote = refs.filter((v) => /^(https?:)?\/\//i.test(v.trim()));
  if (remote.length) errors.push(`remote references: ${remote.join(', ')}`);
  const up = refs.filter((v) => v.includes('../') || v.startsWith('/'));
  if (up.length) errors.push(`references outside the package: ${up.join(', ')}`);
  return errors;
}

/** Problems with js/lively.js ([] = the three callbacks are global declarations and early calls queue in order). */
export function checkCallbacks(src) {
  const errors = [];
  for (const n of CALLBACKS) if (!new RegExp(`^function ${n}\\s*\\(`, 'm').test(src)) errors.push(`${n} is not a top-level "function ${n}(" declaration`);
  try {
    const sandbox = {};
    vm.createContext(sandbox);
    vm.runInContext(src, sandbox, { filename: 'lively.js' });
    for (const n of CALLBACKS) {
      const d = Object.getOwnPropertyDescriptor(sandbox, n);
      if (!d || typeof d.value !== 'function') errors.push(`${n} is not a global function after the script runs`);
    }
    vm.runInContext("livelyPropertyListener('theme', 1); livelyWallpaperPlaybackChanged('{\"IsPaused\":true}'); livelySystemInformation('{}');", sandbox);
    const q = sandbox.__pcdLivelyQueue;
    if (!Array.isArray(q) || q.length !== 3) errors.push('calls before the app loads are not queued');
    else if (q.map((c) => c[0]).join(',') !== 'property,playback,sysinfo') errors.push(`queue order ${q.map((c) => c[0]).join(',')}`);
    vm.runInContext("var seen = []; var PCD = { wpApp: { handle: function (k, a) { seen.push(k); return 'ok'; } } }; livelyPropertyListener('side', 1);", sandbox);
    if (sandbox.seen.length !== 1 || sandbox.__pcdLivelyQueue.length !== 3) errors.push('with PCD.wpApp present, calls do not go straight to its handle()');
  } catch (e) {
    errors.push(`lively.js does not run on its own: ${e.message}`);
  }
  return errors;
}

/** URLs, module syntax and forbidden APIs in shipped JS/CSS/HTML ([{ rel, text }]). */
export function checkShippedCode(files) {
  const errors = [];
  for (const { rel, text } of files) {
    const noComments = text.replace(/\/\*[\s\S]*?\*\//g, '');
    const code = rel.endsWith('.js') ? noComments.replace(/(^|[^:'"\\])\/\/[^\n]*/g, '$1') : noComments;
    if (rel.endsWith('.js') && /^\s*(import\s[^(]|export\s)/m.test(code)) errors.push(`${rel}: ES module syntax (pages use classic scripts)`);
    if (/prefers-color-scheme/.test(code)) errors.push(`${rel}: prefers-color-scheme (in Lively it follows Lively's theme, not Windows)`);
    if (/navigator\s*\.\s*geolocation/.test(code)) errors.push(`${rel}: navigator.geolocation (a permission prompt inside the wallpaper)`);
    if (/\.\.\//.test(code)) errors.push(`${rel}: "../" (Lively serves only the wallpaper folder)`);
    if (/pixelclock\.local/i.test(text)) errors.push(`${rel}: names pixelclock.local (the wallpaper never contacts the clock)`);
    for (const u of text.match(/https?:\/\/[^\s'"`)<>\\]+/g) || []) {
      let host = '';
      try { host = new URL(u).hostname; } catch { host = u; }
      if (!ALLOWED_HOSTS.includes(host)) errors.push(`${rel}: URL ${u} (only Open-Meteo)`);
    }
  }
  return errors;
}

/**
 * Entries of a zip (Buffer) from its central directory: [{ name, method, crc, size, csize, data() }]; data() inflates
 * the entry. Throws on a malformed archive. Node built-ins only (no Python).
 */
export function readZip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip: no end-of-central-directory record');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const entries = [];
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error(`central directory entry ${i} has a bad signature`);
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const csize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28);
    const xlen = buf.readUInt16LE(p + 30);
    const clen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString(flags & 0x800 ? 'utf8' : 'latin1', p + 46, p + 46 + nlen);
    entries.push({
      name, method, crc, csize, size,
      data() {
        if (buf.readUInt32LE(local) !== 0x04034b50) throw new Error(`${name}: bad local header`);
        const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
        const raw = buf.subarray(start, start + csize);
        if (method === 0) return Buffer.from(raw);
        if (method === 8) return zlib.inflateRawSync(raw);
        throw new Error(`${name}: compression method ${method}`);
      },
    });
    p += 46 + nlen + xlen + clen;
  }
  return entries;
}

/** Problems with zip entry names ([] = fine). expected: the staging folder's files (posix, relative). */
export function checkZipNames(names, expected) {
  const errors = [];
  if (!Array.isArray(names) || !names.length) return ['the zip has no entries'];
  for (const f of ROOT_FILES) if (!names.includes(f)) errors.push(`${f} is not a root entry`);
  const bs = names.filter((n) => n.includes('\\'));
  if (bs.length) errors.push(`backslashes in: ${bs.slice(0, 5).join(', ')}`);
  const dot = names.filter((n) => n.startsWith('./') || n.startsWith('/') || n.split('/').includes('..') || n.split('/').includes('.'));
  if (dot.length) errors.push(`"./", "/" or ".." in: ${dot.slice(0, 5).join(', ')}`);
  const dirs = names.filter((n) => n.endsWith('/'));
  if (dirs.length) errors.push(`directory entries: ${dirs.slice(0, 5).join(', ')}`);
  const tops = new Set(names.map((n) => n.split('/')[0]));
  if (tops.size === 1 && names.every((n) => n.includes('/'))) errors.push(`everything is inside one top folder "${[...tops][0]}"`);
  const dup = names.filter((n, i) => names.indexOf(n) !== i);
  if (dup.length) errors.push(`duplicate entries: ${[...new Set(dup)].join(', ')}`);
  if (expected) {
    const missing = expected.filter((f) => !names.includes(f));
    const extra = names.filter((n) => !expected.includes(n));
    if (missing.length) errors.push(`missing from the zip: ${missing.slice(0, 8).join(', ')}${missing.length > 8 ? ' ...' : ''}`);
    if (extra.length) errors.push(`not in dist/wallpaper: ${extra.slice(0, 8).join(', ')}${extra.length > 8 ? ' ...' : ''}`);
  }
  return errors;
}

/** Node's view of a zip against its staging folder: name problems, CRC, deflate and byte equality. */
export function checkZipFile(zipPath, stagingDir, expected) {
  const entries = readZip(fs.readFileSync(zipPath));
  const names = entries.map((e) => e.name);
  const errors = checkZipNames(names, expected);
  for (const e of entries) {
    if (e.method !== 8) errors.push(`${e.name}: not deflated (method ${e.method})`);
    let data;
    try {
      data = e.data();
    } catch (err) {
      errors.push(err.message);
      continue;
    }
    if (data.length !== e.size) errors.push(`${e.name}: ${data.length} bytes inflated, header says ${e.size}`);
    if (typeof zlib.crc32 === 'function' && (zlib.crc32(data) >>> 0) !== (e.crc >>> 0)) errors.push(`${e.name}: CRC mismatch`);
    const disk = path.join(stagingDir, ...e.name.split('/'));
    if (!fs.existsSync(disk)) errors.push(`${e.name}: not in the staging folder`);
    else if (!fs.readFileSync(disk).equals(data)) errors.push(`${e.name}: differs from the staging folder`);
  }
  return { names, errors };
}

const PY_ZIP = [
  'import json, sys, zipfile',
  'zf = zipfile.ZipFile(sys.argv[1])',
  'print(json.dumps({"names": zf.namelist(), "testzip": zf.testzip()}))',
  '',
].join('\n');

/** Python zipfile namelist and CRC test (the script goes in on stdin). */
export function pythonZipInfo(zipPath) {
  const py = findPython();
  if (!py) throw new Error('Python 3 not found (tried python, py -3, python3)');
  const r = spawnSync(py.cmd, [...py.args, '-', zipPath], { input: PY_ZIP, encoding: 'utf8', windowsHide: true, timeout: 60000 });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`python exited ${r.status}: ${(r.stderr || r.stdout || '').trim()}`);
  return JSON.parse(String(r.stdout).trim());
}

/** tar.exe -tf entries (Windows' bsdtar; plain "tar" elsewhere). */
export function tarZipNames(zipPath) {
  const sys32 = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
  const exe = process.platform === 'win32' && fs.existsSync(sys32) ? sys32 : 'tar';
  const r = spawnSync(exe, ['-tf', zipPath], { encoding: 'utf8', windowsHide: true, timeout: 60000 });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`tar -tf exited ${r.status}: ${(r.stderr || '').trim()}`);
  return String(r.stdout).split(/\r?\n/).filter((l) => l !== '');
}

/**
 * A ctx-like object with the build's script and style lists for this repo (generated files as the generate stage
 * would make them: pcd-tokens.js/tokens.css with tools/lib/tokens.mjs, pcd-anchors.js with tools/lib/anchors.mjs).
 */
export function listsFor(root, config) {
  const generated = {};
  if (fs.existsSync(path.join(root, 'tools', 'lib', 'tokens.mjs'))) { generated['pcd-tokens.js'] = ''; generated['tokens.css'] = ''; }
  if (fs.existsSync(path.join(root, 'tools', 'lib', 'anchors.mjs'))) generated['pcd-anchors.js'] = '';
  const ctx = createContext({ root, config, generated, render: false, piece: 'wallpaper', log: () => {} });
  return { ctx, scripts: deferredScripts(ctx), styles: pageStyles(ctx), shared: sharedLists(root) };
}

/** Every file the package must contain (posix paths relative to dist/wallpaper), sorted. */
export function expectedFiles(root, config) {
  const { scripts, styles } = listsFor(root, config);
  const fonts = FONT_FILES.filter((n) => fs.existsSync(path.join(root, 'design', 'fonts', n))).map((n) => `fonts/${n}`);
  return [...new Set([...ROOT_FILES, LIVELY_SCRIPT, ...scripts, ...styles, ...fonts])].sort();
}

function row(name, errors, okDetail) {
  return { name: `wallpaper: ${name}`, pass: errors.length === 0, detail: errors.length ? errors.join('\n') : okDetail };
}

export async function validate(vctx) {
  if (!vctx.exists(OUT)) return [{ name: 'wallpaper: built', pass: null, skip: true, detail: 'dist/wallpaper does not exist (run node tools/build.mjs --no-sync wallpaper)' }];
  const rows = [];
  const rel = (f) => `${OUT}/${f}`;
  const has = (f) => vctx.exists(rel(f));
  const read = (f) => vctx.readText(rel(f));
  const root = vctx.root;
  const config = vctx.config || {};
  const lists = listsFor(root, config);
  let model = null;
  try { model = loadModel(root); } catch (e) { rows.push(row('model (engine menu, settings schema, wp-props)', [e.message], '')); }

  // files
  const expected = expectedFiles(root, config);
  const present = vctx.listFiles(OUT).map((f) => f.slice(OUT.length + 1)).sort();
  const missing = expected.filter((f) => !present.includes(f));
  const extra = present.filter((f) => !expected.includes(f));
  rows.push(row('package files (exactly the expected set)', [...missing.map((f) => `missing ${f}`), ...extra.map((f) => `unexpected ${f}`)],
    `${expected.length} files: ${ROOT_FILES.join(', ')}, ${LIVELY_SCRIPT}, ${lists.scripts.length} deferred scripts, ${lists.styles.length} stylesheet(s)`));

  // LivelyInfo.json
  if (has('LivelyInfo.json')) {
    const text = read('LivelyInfo.json');
    const errs = checkLivelyInfoText(text);
    try {
      const srcText = fs.readFileSync(path.join(root, 'src', 'wallpaper', 'LivelyInfo.json'), 'utf8');
      if (normalizeText(srcText) !== text) errs.push('differs from src/wallpaper/LivelyInfo.json (rebuild)');
    } catch (e) {
      errs.push(e.message);
    }
    rows.push(row('LivelyInfo.json: strict JSON, exact keys and values, Arguments exactly "--pause-event true"', errs,
      `${Object.keys(LIVELY_INFO).length} keys, Type 1, FileName index.html, Thumbnail thumbnail.jpg, Arguments "${ARGUMENTS}"`));
  }

  // LivelyProperties.json
  let props = null;
  try { props = vctx.readJson(rel('LivelyProperties.json')); } catch (e) { rows.push(row('LivelyProperties.json', [e.message], '')); }
  if (props && model) {
    const types = [...new Set(Object.values(props).map((c) => c && c.type))].join(', ');
    rows.push(row("LivelyProperties.json: Lively's schema (types, required/allowed keys, key names, values)", model.P.checkProperties(props), `${Object.keys(props).length} controls; types ${types}`));
    const content = model.P.checkPropertiesContent(props, { config, menu: model.menu, schema: model.S });
    const items = props.theme && props.theme.items;
    if (JSON.stringify(items) !== JSON.stringify(model.menu.map((t) => t.name))) content.push(`theme items ${JSON.stringify(items)} differ from PCD.engine.menu`);
    rows.push(row('LivelyProperties.json: generated from config/user.json, theme dropdown = PCD.engine.menu order', content,
      `theme: ${model.menu.length} items (${model.menu.slice(0, 3).map((t) => t.name).join(', ')}, ...); defaults from the config`));
    // the page's own defaults (js/pcd-config.js) == what Lively replays from this file
    const errs = [];
    try {
      const sandbox = {};
      sandbox.globalThis = sandbox;
      vm.createContext(sandbox);
      vm.runInContext(read(`js/${CONFIG_SCRIPT}`), sandbox, { filename: CONFIG_SCRIPT });
      const cfg = sandbox.PCD && sandbox.PCD.CONFIG;
      if (!cfg) errs.push(`js/${CONFIG_SCRIPT} does not set PCD.CONFIG`);
      else {
        const opts = { menu: model.menu, schema: model.S };
        const page = model.P.defaults(JSON.parse(JSON.stringify(cfg)), opts);
        const replay = model.P.stateFromProperties(props, { ...opts, config: {} });
        for (const k of Object.keys(page)) if (JSON.stringify(page[k]) !== JSON.stringify(replay[k])) errs.push(`${k}: page default ${JSON.stringify(page[k])}, Lively replay ${JSON.stringify(replay[k])}`);
      }
    } catch (e) {
      errs.push(`cannot evaluate: ${e.message}`);
    }
    rows.push(row('page defaults (js/pcd-config.js) equal what Lively replays from LivelyProperties.json', errs, 'every wallpaper setting agrees'));
  }

  // index.html
  if (has('index.html')) {
    rows.push(row('index.html: charset, inline background, lively.js first and blocking, deferred classic scripts in order', checkIndexHtml(read('index.html'), lists),
      `${LIVELY_SCRIPT} blocking + ${lists.scripts.length} deferred scripts, ${lists.styles.length} stylesheet(s)`));
  }

  // callbacks
  if (has('js/lively.js')) rows.push(row('js/lively.js: three global callbacks, early calls queue in order', checkCallbacks(read('js/lively.js')), CALLBACKS.join(', ')));

  // shipped code
  const codeFiles = present.filter((f) => /\.(js|css|html)$/.test(f) && !f.startsWith('js/pixelclock/')).map((f) => ({ rel: f, text: read(f) }));
  rows.push(row('shipped code: classic scripts, no prefers-color-scheme, geolocation, ../ or pixelclock.local, URLs only Open-Meteo', checkShippedCode(codeFiles), `${codeFiles.length} js/css/html files (vendor engine exempt)`));

  // copies and generated files
  const stale = [];
  const copies = [
    [LIVELY_SCRIPT, path.join(root, 'src', 'wallpaper', 'js', 'lively.js')],
    [`js/${SETTINGS_SCRIPT}`, path.join(root, ...SETTINGS_SRC)],
    ...APP_SCRIPTS.map((n) => [`js/${n}`, path.join(root, 'src', 'wallpaper', 'js', n)]),
    ...APP_STYLES.map((n) => [`css/${n}`, path.join(root, 'src', 'wallpaper', 'css', n)]),
    ...lists.shared.scripts.map((n) => [`js/${n}`, path.join(lists.shared.jsDir, n)]),
    ...(lists.shared.hook ? [['js/pcd-hook.js', path.join(lists.shared.jsDir, 'pcd-hook.js')]] : []),
    ...lists.shared.styles.map((n) => [`css/${n}`, path.join(lists.shared.cssDir, n)]),
  ];
  for (const [f, src] of copies) {
    if (!has(f)) continue;
    if (!fs.existsSync(src) || read(f) !== normalizeText(fs.readFileSync(src, 'utf8'))) stale.push(f);
  }
  const generated = [
    ['index.html', () => renderHtml(fs.readFileSync(path.join(root, 'src', 'wallpaper', 'index.html'), 'utf8'), { scripts: lists.scripts, styles: lists.styles })],
    ['LivelyInfo.json', () => LIVELY_INFO_TEXT],
  ];
  if (model) {
    generated.push(['LivelyProperties.json', () => JSON.stringify(genProperties(root, config, model), null, 2) + '\n']);
    generated.push([`js/${CONFIG_SCRIPT}`, () => genConfigJs(root, config, model)]);
  }
  for (const [f, gen] of generated) {
    if (!has(f)) continue;
    try { if (read(f) !== normalizeText(gen())) stale.push(f); } catch (e) { stale.push(`${f} (cannot regenerate: ${e.message})`); }
  }
  rows.push(row('copies equal their sources; generated files are current', stale.map((f) => `stale: ${f} (rebuild)`), `${copies.length} copies and ${generated.length} generated files`));

  // thumbnail
  if (has('thumbnail.jpg')) {
    const errs = [];
    let detail = '';
    try {
      const s = vctx.imageSize(rel('thumbnail.jpg'));
      const bytes = fs.statSync(vctx.out(rel('thumbnail.jpg'))).size;
      if (s.type !== 'jpeg') errs.push(`not a JPEG (${s.type})`);
      if (s.width > THUMB.width || s.height > THUMB.height || s.width < 320) errs.push(`${s.width}x${s.height} (want at most ${THUMB.width}x${THUMB.height})`);
      if (bytes > THUMB.maxBytes) errs.push(`${bytes} bytes (want at most ${THUMB.maxBytes})`);
      detail = `${s.width}x${s.height} ${s.type}, ${bytes} bytes`;
    } catch (e) {
      errs.push(e.message);
    }
    rows.push(row('thumbnail.jpg (JPEG, at most 1280x800, under 300 KB)', errs, detail));
  } else rows.push(row('thumbnail.jpg (JPEG, at most 1280x800, under 300 KB)', ['missing (build with rendering, or add src/wallpaper/thumbnail.jpg)'], ''));

  // zip gate
  const zipAbs = vctx.out(ZIP);
  if (!fs.existsSync(zipAbs)) rows.push(row('zip gate', [`dist/${ZIP} missing (tools/build.mjs zips after the wallpaper plugin)`], ''));
  else {
    try {
      const z = checkZipFile(zipAbs, vctx.out(OUT), present);
      rows.push(row('zip gate: Node central directory (names, deflate, CRC, bytes == dist/wallpaper)', z.errors, `${z.names.length} entries; root: ${ROOT_FILES.filter((f) => z.names.includes(f)).join(', ')}`));
    } catch (e) {
      rows.push(row('zip gate: Node central directory (names, deflate, CRC, bytes == dist/wallpaper)', [e.message], ''));
    }
    try {
      const py = pythonZipInfo(zipAbs);
      const errs = checkZipNames(py.names, present);
      if (py.testzip) errs.push(`CRC check failed for ${py.testzip}`);
      rows.push(row('zip gate: Python zipfile namelist and testzip', errs, `${py.names.length} entries, CRC ok`));
    } catch (e) {
      rows.push({ name: 'wallpaper: zip gate: Python zipfile namelist and testzip', pass: null, skip: true, detail: e.message });
    }
    try {
      const names = tarZipNames(zipAbs);
      rows.push(row('zip gate: tar.exe -tf', checkZipNames(names, present), `${names.length} entries; root files present, no backslashes, no ./, no top folder`));
    } catch (e) {
      rows.push({ name: 'wallpaper: zip gate: tar.exe -tf', pass: null, skip: true, detail: e.message });
    }
  }
  return rows;
}
