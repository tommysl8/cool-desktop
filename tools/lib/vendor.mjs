// The synced engine in vendor/pixelclock/ (written only by tools/sync.mjs): its integrity against SYNC.json, the
// page order of its theme files, and the two layouts the build copies it into. Node built-ins only. Never reads or
// touches the clock repo itself.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

export const VENDOR_REL = 'vendor/pixelclock';
export const SYNC_FILE = 'SYNC.json';
export const SEASON_ORDER = ['winter', 'spring', 'summer', 'autumn'];
const REQUIRED = ['simulator/engine.js', 'simulator/schedule.js', 'simulator/screens.js', 'tools/render.js'];

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const toPosix = (p) => String(p).split(path.sep).join('/');

export function vendorDir(root) {
  return path.join(root, ...VENDOR_REL.split('/'));
}

function listAll(dir) {
  const out = [];
  const walk = (d) => {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const abs = path.join(d, ent.name);
      if (ent.isDirectory()) walk(abs);
      else out.push(toPosix(path.relative(dir, abs)));
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return out.sort();
}

/**
 * vendor/pixelclock/ against its SYNC.json: every listed file present with its size and SHA-256, nothing unlisted,
 * engine, schedule, screens, render.js and at least one theme listed.
 * Returns { ok, problems, sync, files: [{ path, bytes, sha256 }] } (files as listed in SYNC.json).
 */
export function checkVendor(dir) {
  const problems = [];
  if (!fs.existsSync(dir)) return { ok: false, problems: [`${VENDOR_REL}/ does not exist (run node tools/sync.mjs)`], sync: null, files: [] };
  let sync = null;
  try {
    const buf = fs.readFileSync(path.join(dir, SYNC_FILE));
    if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) throw new Error('starts with a UTF-8 BOM');
    sync = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buf));
  } catch (e) {
    return { ok: false, problems: [`${VENDOR_REL}/${SYNC_FILE}: ${e.message}`], sync: null, files: [] };
  }
  const files = Array.isArray(sync.files) ? sync.files : [];
  if (!files.length) problems.push(`${SYNC_FILE} lists no files`);
  for (const key of ['source', 'commit', 'syncedAt']) if (typeof sync[key] !== 'string' || !sync[key]) problems.push(`${SYNC_FILE}: "${key}" missing`);
  for (const req of REQUIRED) if (!files.some((f) => f.path === req)) problems.push(`${SYNC_FILE} does not list ${req}`);
  if (!files.some((f) => /^simulator\/themes\/[^/]+\.js$/.test(f.path))) problems.push(`${SYNC_FILE} lists no theme`);
  for (const f of files) {
    const abs = path.join(dir, ...String(f.path).split('/'));
    let data;
    try { data = fs.readFileSync(abs); } catch { problems.push(`${f.path}: listed in ${SYNC_FILE} but missing`); continue; }
    if (data.length !== f.bytes) problems.push(`${f.path}: ${data.length} bytes, ${SYNC_FILE} says ${f.bytes}`);
    else if (sha256(data) !== f.sha256) problems.push(`${f.path}: SHA-256 differs from ${SYNC_FILE} (edited after the sync?)`);
  }
  const listed = new Set(files.map((f) => f.path));
  for (const p of listAll(dir)) if (p !== SYNC_FILE && !listed.has(p)) problems.push(`${p}: not listed in ${SYNC_FILE}`);
  return { ok: problems.length === 0, problems, sync, files };
}

/** Throws unless checkVendor(dir) passes. */
export function assertVendor(dir) {
  const r = checkVendor(dir);
  if (!r.ok) throw new Error(`${VENDOR_REL}/ is not a clean sync: ${r.problems.slice(0, 6).join('; ')} (run node tools/sync.mjs)`);
  return r;
}

/**
 * Theme files in page order: the seasons (winter, spring, summer, autumn), the holidays in PC.HOLIDAYS order, then
 * any other theme by id. Runs engine.js, schedule.js and each theme file in one fresh vm context (pure code, no
 * DOM) to see which id each file registers. Returns [{ file: 'themes/<name>.js', id, kind, name }].
 */
export function themeOrder(dir) {
  const read = (rel) => fs.readFileSync(path.join(dir, ...rel.split('/')), 'utf8');
  const context = vm.createContext({});
  vm.runInContext(read('simulator/engine.js'), context, { filename: 'engine.js' });
  vm.runInContext(read('simulator/schedule.js'), context, { filename: 'schedule.js' });
  const PC = context.PixelClock;
  const themeDir = path.join(dir, 'simulator', 'themes');
  const entries = [];
  for (const name of fs.readdirSync(themeDir).filter((n) => n.endsWith('.js')).sort()) {
    const before = PC.themes.length;
    vm.runInContext(read(`simulator/themes/${name}`), context, { filename: name });
    for (const t of Array.from(PC.themes).slice(before)) entries.push({ file: `themes/${name}`, id: t.id, kind: t.kind, name: t.name });
  }
  const holidays = Array.from(PC.HOLIDAYS || []).map((h) => h.id);
  const rank = (e) => {
    const s = SEASON_ORDER.indexOf(e.id);
    if (s !== -1) return [0, s];
    const h = holidays.indexOf(e.id);
    if (h !== -1) return [1, h];
    return [2, 0];
  };
  const sorted = entries.sort((a, b) => {
    const ra = rank(a);
    const rb = rank(b);
    return ra[0] - rb[0] || ra[1] - rb[1] || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  });
  const seen = new Set();
  return sorted.filter((e) => (seen.has(e.file) ? false : seen.add(e.file)));
}

/**
 * Where a vendor file goes inside a piece:
 *   pages (default): flat, engine.js schedule.js [screens.js] themes/*.js (render.js is not copied);
 *   render: true (the still): the vendor layout itself, simulator/... next to tools/render.js.
 * Returns the relative target path, or null when the file is not part of that layout.
 */
export function vendorTarget(relPath, { render = false, screens = false } = {}) {
  if (render) return relPath;
  if (relPath === 'tools/render.js') return null;
  if (relPath === 'simulator/screens.js' && !screens) return null;
  return relPath.replace(/^simulator\//, '');
}

/** The vendor path a dist copy corresponds to (inverse of vendorTarget for either layout), or null. */
export function vendorSourceOf(relInPixelclock) {
  const p = toPosix(relInPixelclock);
  if (p.startsWith('simulator/') || p === 'tools/render.js') return p;
  if (/^(engine|schedule|screens)\.js$/.test(p) || /^themes\/[^/]+\.js$/.test(p)) return `simulator/${p}`;
  return null;
}
