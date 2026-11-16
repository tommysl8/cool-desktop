// PixelClock Desktop still: inputs and guards. still.json, the screen size for --detect (Win32_VideoController +
// AppliedDPI, read-only), the Lively check (tasklist), the out/ folder (A/B pictures, state.json, cache.json,
// still.log), the palette and atomic writes. Every process is started hidden. Node built-ins only.
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { encodeCommand, powershellPath } from './setter.mjs';

export const STILL_JSON = 'still.json';
export const OUT_DIR = 'out';
export const SLOTS = ['a', 'b'];
export const LOG_MAX_BYTES = 64 * 1024;
export const TMP_MAX_AGE_MS = 10 * 60 * 1000;

/** still.json keys and defaults. width/height 0 mean "detect at run time". taskbar is CSS px (true = 56, false = 0). */
export const STILL_DEFAULTS = Object.freeze({
  width: 0,
  height: 0,
  scale: 1,
  theme: 'auto',
  clock24: false,
  units: 'F',
  city: '',
  sunTimes: true,
  weather: true,
  weatherFx: true,
  taskbar: 56,
});

/**
 * Keys still.json may add (written only when set, so the install's file keeps its shape): side, where the info column
 * goes, 'right' (default: away from the desktop icons) or 'left'.
 */
export const STILL_OPTIONAL = Object.freeze({ side: 'right' });

const isInt = (v) => typeof v === 'number' && Number.isInteger(v);

/** The problems that mean still.json could not be read at all (its settings are lost until it is fixed). */
const NOT_AN_OBJECT = 'not an object; using defaults';
const UNREADABLE = /^(not valid JSON|not an object)\b/;

/**
 * Validate a parsed still.json: unknown keys dropped, invalid values replaced by defaults.
 * Returns { config, problems } (problems never contain the city).
 */
export function normalizeStill(raw) {
  const config = { ...STILL_DEFAULTS };
  const problems = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    if (raw !== undefined && raw !== null) problems.push(NOT_AN_OBJECT);
    return { config, problems };
  }
  const take = (key, ok, convert = (v) => v) => {
    if (!Object.prototype.hasOwnProperty.call(raw, key)) return;
    const v = raw[key];
    if (ok(v)) config[key] = convert(v);
    else problems.push(`${key}: invalid value, using ${JSON.stringify(STILL_DEFAULTS[key])}`);
  };
  take('width', (v) => v === 0 || (isInt(v) && v >= 64 && v <= 16384));
  take('height', (v) => v === 0 || (isInt(v) && v >= 64 && v <= 16384));
  take('scale', (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0.5 && v <= 4);
  take('theme', (v) => typeof v === 'string' && (v === 'auto' || /^[a-z0-9_-]{1,40}$/.test(v)));
  take('clock24', (v) => typeof v === 'boolean');
  take('units', (v) => v === 'F' || v === 'C');
  take('city', (v) => typeof v === 'string' && v.length <= 80, (v) => v.trim());
  take('sunTimes', (v) => typeof v === 'boolean');
  take('weather', (v) => typeof v === 'boolean');
  take('weatherFx', (v) => typeof v === 'boolean');
  take('taskbar', (v) => typeof v === 'boolean' || (isInt(v) && v >= 0 && v <= 200), (v) => (v === true ? 56 : v === false ? 0 : v));
  if (Object.prototype.hasOwnProperty.call(raw, 'side')) {
    if (raw.side === 'left' || raw.side === 'right') config.side = raw.side;
    else problems.push(`side: invalid value, using ${JSON.stringify(STILL_OPTIONAL.side)}`);
  }
  const known = (k) => Object.prototype.hasOwnProperty.call(STILL_DEFAULTS, k) || Object.prototype.hasOwnProperty.call(STILL_OPTIONAL, k);
  for (const k of Object.keys(raw)) if (!known(k)) problems.push(`${k}: unknown key ignored`);
  if ((config.width === 0) !== (config.height === 0)) {
    problems.push('width and height must both be set; detecting the screen instead');
    config.width = 0;
    config.height = 0;
  }
  return { config, problems };
}

/**
 * Why JSON.parse failed, without quoting the file: V8 quotes a piece of the text in some messages, and still.json may
 * hold the city. Gives V8's reason and the line and column when V8 names a position.
 */
export function jsonReason(e, text = '') {
  const msg = String(e && e.message ? e.message : e).split('\n')[0];
  const at = /\bat position (\d+)/.exec(msg);
  if (at) {
    const pos = Math.min(Number(at[1]), text.length);
    const head = text.slice(0, pos);
    let what = msg.slice(0, at.index).replace(/\s*in JSON\s*$/, '').trim();
    if (!what || what.includes('"') || what.length > 80) what = 'unexpected character';
    return `${what.charAt(0).toLowerCase()}${what.slice(1)} at line ${head.split('\n').length}, column ${pos - head.lastIndexOf('\n')}`;
  }
  if (/^Unexpected end of JSON input/.test(msg)) return 'it ends too early';
  return 'unexpected character';
}

/**
 * Read and normalize still.json. A missing file gives the defaults; a broken one gives defaults and a problem. A byte
 * order mark is skipped with a note: UTF-8's (some editors add one) and UTF-16 LE's (what Windows PowerShell 5.1 writes
 * with `>`). Problems never quote the file.
 */
export function readStill(file) {
  let bytes;
  try {
    bytes = fs.readFileSync(file);
  } catch (e) {
    if (e.code === 'ENOENT') return { config: { ...STILL_DEFAULTS }, problems: [], exists: false };
    throw e;
  }
  const notes = [];
  let text;
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    text = bytes.subarray(3).toString('utf8');
    notes.push('starts with a BOM; read anyway');
  } else if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    text = bytes.subarray(2).toString('utf16le');
    notes.push('is UTF-16 with a BOM; read anyway');
  } else {
    text = bytes.toString('utf8');
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return { ...normalizeStill(null), problems: [...notes, `not valid JSON (${jsonReason(e, text)}); using defaults`], exists: true };
  }
  const n = raw === null ? { ...normalizeStill(null), problems: [NOT_AN_OBJECT] } : normalizeStill(raw);
  return { config: n.config, problems: [...notes, ...n.problems], exists: true };
}

/**
 * readStill(), but it throws when the file exists and cannot be read at all (not JSON, not an object), naming the
 * problem: what --detect reads before it writes, so a typo never costs the settings in the file.
 */
export function readStillStrict(file) {
  const cur = readStill(file);
  const bad = cur.exists ? cur.problems.find((p) => UNREADABLE.test(p)) : null;
  if (bad) throw new Error(`${STILL_JSON} cannot be read: ${bad.replace(/; using defaults$/, '')}; fix it, then run --detect again`);
  return cur;
}

/** Write a JSON file atomically (temp file + rename), UTF-8 without BOM, LF, 2-space indent. */
export function writeJsonAtomic(file, obj) {
  writeBytesAtomic(file, Buffer.from(JSON.stringify(obj, null, 2) + '\n', 'utf8'));
}

/** Write bytes atomically: a temp file in the same folder, then rename over the target. */
export function writeBytesAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, data);
  try {
    renameRetry(tmp, file);
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
    throw e;
  }
}

function renameRetry(from, to, tries = 8) {
  for (let i = 0; ; i++) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (e) {
      // Windows: a reader (Explorer, the wallpaper service, antivirus) may hold the target briefly.
      if (i >= tries || !['EPERM', 'EACCES', 'EBUSY'].includes(e.code)) throw e;
      const until = Date.now() + 50 * (i + 1);
      while (Date.now() < until) { /* short spin; this runs once per 15 minutes */ }
    }
  }
}

/**
 * Merge `patch` into still.json (keeps other keys, drops unknown ones), atomically. Returns the written config. Throws
 * and writes nothing when the file exists but cannot be read (readStillStrict).
 */
export function updateStill(file, patch) {
  const cur = readStillStrict(file);
  const next = normalizeStill({ ...cur.config, ...patch });
  writeJsonAtomic(file, next.config);
  return next.config;
}

// ---------------------------------------------------------------------------------------------
// Hidden PowerShell (read-only queries) and the screen size.

/** Run a read-only PowerShell script hidden; returns { status, stdout, stderr, error }. */
export function runPowerShell(script, { env = process.env, timeoutMs = 60000, spawnSync: spawn = spawnSync } = {}) {
  const text = "$ProgressPreference = 'SilentlyContinue'\n" + script;
  const r = spawn(powershellPath(env), ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encodeCommand(text)], {
    encoding: 'utf8', windowsHide: true, timeout: timeoutMs, env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  return {
    status: r && typeof r.status === 'number' ? r.status : null,
    stdout: String((r && r.stdout) || ''),
    stderr: String((r && r.stderr) || '').replace(/#< CLIXML[\s\S]*$/, '').trim(),
    error: (r && r.error) || null,
  };
}

/** The read-only query --detect runs: video controllers (physical pixels) and AppliedDPI. */
export const DETECT_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  '$vc = @(Get-CimInstance -ClassName Win32_VideoController | ForEach-Object { [pscustomobject]@{ name = [string]$_.Name; width = $_.CurrentHorizontalResolution; height = $_.CurrentVerticalResolution } })',
  '$dpi = $null',
  "try { $dpi = (Get-ItemProperty -LiteralPath 'HKCU:\\Control Panel\\Desktop\\WindowMetrics' -Name AppliedDPI -ErrorAction Stop).AppliedDPI } catch { }",
  '[pscustomobject]@{ controllers = $vc; appliedDpi = $dpi } | ConvertTo-Json -Depth 4 -Compress',
].join('\n');

/**
 * Parse DETECT_SCRIPT's JSON. Returns { width, height, scale, dpi, adapters } where width/height come
 * from the first adapter with a current mode (0 when none) and scale = AppliedDPI / 96 (1 when unknown).
 */
export function parseDetect(jsonText) {
  let data;
  try {
    data = JSON.parse(String(jsonText).trim());
  } catch {
    throw new Error('screen detection returned no JSON');
  }
  const list = Array.isArray(data.controllers) ? data.controllers : data.controllers ? [data.controllers] : [];
  const adapters = list.map((c) => ({
    name: String(c && c.name || ''),
    width: Number(c && c.width) || 0,
    height: Number(c && c.height) || 0,
  }));
  const active = adapters.find((a) => isInt(a.width) && isInt(a.height) && a.width >= 64 && a.height >= 64) || null;
  const raw = data.appliedDpi;
  const dpi = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN;
  const usable = Number.isFinite(dpi) && dpi >= 48 && dpi <= 480;
  return {
    width: active ? active.width : 0,
    height: active ? active.height : 0,
    scale: usable ? Math.round((dpi / 96) * 100) / 100 : 1,
    dpi: usable ? dpi : null,
    adapters,
  };
}

/** Detect the screen (read-only). deps: { runPowerShell }. Throws when no adapter reports a mode. */
export function detectDisplay(deps = {}) {
  const run = deps.runPowerShell || runPowerShell;
  const r = run(DETECT_SCRIPT);
  if (r.status !== 0) throw new Error(`screen detection failed (exit ${r.status}${r.error ? ', ' + r.error.message : ''}${r.stderr ? ': ' + r.stderr.split('\n')[0] : ''})`);
  const d = parseDetect(r.stdout);
  if (!d.width || !d.height) throw new Error('no video controller reports a current resolution');
  return d;
}

// ---------------------------------------------------------------------------------------------
// Lively: while a Lively player runs, the live wallpaper covers the desktop picture.

/** Image names from `tasklist /FO CSV /NH` output. */
export function parseTasklistCsv(text) {
  const names = [];
  for (const line of String(text).split(/\r?\n/)) {
    const m = /^\s*"([^"]*)"/.exec(line);
    if (m && m[1]) names.push(m[1]);
  }
  return names;
}

/** True for Lively's wallpaper players (Lively.Player.WebView2.exe, Lively.Player.CefSharp.exe, ...). */
export function isLivelyPlayer(image) {
  return /^lively\.player/i.test(String(image));
}

/** One tasklist call, hidden. Returns its stdout (throws on failure). */
export function tasklist({ spawnSync: spawn = spawnSync, env = process.env } = {}) {
  const exe = path.win32.join(env.SystemRoot || env.windir || 'C:\\Windows', 'System32', 'tasklist.exe');
  const r = spawn(exe, ['/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true, timeout: 20000, stdio: ['ignore', 'pipe', 'pipe'] });
  if (!r || r.status !== 0) throw new Error(`tasklist failed (exit ${r && r.status}${r && r.error ? ', ' + r.error.message : ''})`);
  return String(r.stdout || '');
}

/** { running, players } from a tasklist run (deps.tasklist returns the CSV text). */
export function livelyStatus(deps = {}) {
  const text = (deps.tasklist || tasklist)();
  const players = [...new Set(parseTasklistCsv(text).filter(isLivelyPlayer))];
  return { running: players.length > 0, players };
}

// ---------------------------------------------------------------------------------------------
// out/: wall-a.png and wall-b.png in turn, state.json, cache.json, still.log.

/** The files of the out folder under `home` (or the given out folder). */
export function outFiles(home, outDir = path.join(home, OUT_DIR)) {
  return {
    dir: outDir,
    a: path.join(outDir, 'wall-a.png'),
    b: path.join(outDir, 'wall-b.png'),
    state: path.join(outDir, 'state.json'),
    cache: path.join(outDir, 'cache.json'),
    log: path.join(outDir, 'still.log'),
  };
}

export const EMPTY_STATE = Object.freeze({ v: 1, slot: null, sha256: null, setAt: null, renderedAt: null, last: null });

/** Read out/state.json; anything unreadable or wrong-shaped gives the empty state. */
export function readState(file) {
  try {
    const s = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!s || s.v !== 1) return { ...EMPTY_STATE };
    return {
      ...EMPTY_STATE,
      slot: SLOTS.includes(s.slot) ? s.slot : null,
      sha256: typeof s.sha256 === 'string' && /^[0-9a-f]{64}$/.test(s.sha256) ? s.sha256 : null,
      setAt: typeof s.setAt === 'string' ? s.setAt : null,
      renderedAt: typeof s.renderedAt === 'string' ? s.renderedAt : null,
      last: s.last && typeof s.last === 'object' ? s.last : null,
    };
  } catch {
    return { ...EMPTY_STATE };
  }
}

/** The slot to write next: never the one currently set as the desktop picture. */
export function nextSlot(state) {
  return state && state.slot === 'a' ? 'b' : 'a';
}

export function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/** SHA-256 of a file, or null when it cannot be read. */
export function fileSha256(file) {
  try {
    return sha256(fs.readFileSync(file));
  } catch {
    return null;
  }
}

/** True when `sha` is the picture last set and that file is still on disk unchanged. */
export function isSameAsSet(state, sha, files) {
  if (!state || !state.slot || state.sha256 !== sha) return false;
  return fileSha256(files[state.slot]) === sha;
}

/**
 * Keep out/ small: removes wall-*.png files other than wall-a.png and wall-b.png (older versions,
 * manual copies) and *.tmp files older than 10 minutes (an interrupted write). Never touches the A/B
 * pictures, state, cache or log. Returns the removed file names.
 */
export function cleanupOut(dir, { now = Date.now(), tmpMaxAgeMs = TMP_MAX_AGE_MS } = {}) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const removed = [];
  for (const e of entries) {
    if (!e.isFile()) continue;
    const name = e.name;
    const full = path.join(dir, name);
    let drop = false;
    if (/^wall-.*\.png$/i.test(name) && !['wall-a.png', 'wall-b.png'].includes(name)) drop = true;
    else if (/\.tmp$/i.test(name)) {
      try { drop = now - fs.statSync(full).mtimeMs > tmpMaxAgeMs; } catch { drop = false; }
    }
    if (!drop) continue;
    try {
      fs.rmSync(full, { force: true });
      removed.push(name);
    } catch { /* in use: try again next run */ }
  }
  return removed.sort();
}

/** Replace every private value (city, coordinates) in a log line. */
export function redact(text, secrets = []) {
  let out = String(text);
  for (const s of secrets) {
    const v = String(s ?? '').trim();
    if (v.length >= 2) out = out.split(v).join('[private]');
  }
  return out.replace(/[\r\n]+/g, ' ');
}

/** Append one line to still.log; at `maxBytes` the log moves to still.log.1 (replacing it). */
export function appendLog(file, line, { maxBytes = LOG_MAX_BYTES, secrets = [] } = {}) {
  const text = redact(line, secrets) + '\n';
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let size = 0;
  try { size = fs.statSync(file).size; } catch { size = 0; }
  if (size > 0 && size + Buffer.byteLength(text) > maxBytes) {
    try { fs.rmSync(file + '.1', { force: true }); } catch { /* ignore */ }
    try { fs.renameSync(file, file + '.1'); } catch { /* ignore: keep appending */ }
  }
  fs.appendFileSync(file, text, 'utf8');
}

// ---------------------------------------------------------------------------------------------
// Tokens (design/tokens.json, shipped as still/tokens.json) and anchors (still/anchors.json).

/** Built-in palette values, used only when tokens.json is missing or unreadable (or lacks one of them). */
export const TOKEN_DEFAULTS = Object.freeze({
  bg: 0x141016, panel: 0x1d181f, field: 0x2a2229, line: 0x3a3138, text: 0xece4d8,
  muted: 0xa99d91, faint: 0x8b8178, accent: 0xff9a3c, frame: 0x9a6a40, ring: 0xc47a2c, wood: 0x6b4428,
});

function colorValue(v) {
  if (typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v)) return parseInt(v.slice(1), 16);
  if (v && typeof v === 'object' && typeof v.value === 'string') return colorValue(v.value);
  return null;
}

/**
 * Colour tokens as 0xRRGGBB. Accepts a flat { bg: '#141016', ... } object or one nested under
 * "tokens" or "colors" (values may also be { value: '#...' }). Missing tokens keep the defaults.
 * Returns { tokens, source: 'file' | 'defaults', problems }.
 */
export function readTokens(file) {
  const tokens = { ...TOKEN_DEFAULTS };
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return { tokens, source: 'defaults', problems: [e.code === 'ENOENT' ? 'tokens.json not found; using the built-in defaults' : `tokens.json unreadable (${e.message.split('\n')[0]}); using the built-in defaults`] };
  }
  const candidates = [raw, raw && raw.tokens, raw && raw.colors, raw && raw.color].filter((o) => o && typeof o === 'object');
  const src = candidates.find((o) => colorValue(o.bg) !== null);
  if (!src) return { tokens, source: 'defaults', problems: ['tokens.json has no bg colour; using the built-in defaults'] };
  for (const k of Object.keys(TOKEN_DEFAULTS)) {
    const c = colorValue(src[k]);
    if (c !== null) tokens[k] = c;
  }
  return { tokens, source: 'file', problems: [] };
}

/**
 * PCD.TOKENS as the pages get it (tools/lib/tokens.mjs generates pcd-tokens.js from the same design/tokens.json):
 * each colour as '#rrggbb' by name (plus woodDark), int (0xRRGGBB), names and type. The shared modules read it when
 * called (PCD.ascii.token, PCD.bleed's bg, PCD.font's ladder), so the still paints the pages' colours. null when
 * tokens.json is missing or has no colours (the modules then use their built-in values).
 */
export function pageTokens(file) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
  const colors = raw && raw.colors && typeof raw.colors === 'object' ? raw.colors : null;
  if (!colors) return null;
  const out = { version: raw.version || 1, names: [], int: {} };
  for (const [name, v] of Object.entries(colors)) {
    const c = colorValue(v);
    if (c === null) continue;
    const hexText = '#' + c.toString(16).padStart(6, '0');
    out.names.push(name);
    out[name] = hexText;
    out.int[name] = c;
    const camel = name.replace(/-([a-z])/g, (m, ch) => ch.toUpperCase());
    if (camel !== name) {
      out[camel] = hexText;
      out.int[camel] = c;
    }
  }
  if (typeof out.int.bg !== 'number') return null;
  if (raw.type && typeof raw.type === 'object') out.type = JSON.parse(JSON.stringify(raw.type));
  if (raw.derived && typeof raw.derived === 'object') out.derived = JSON.parse(JSON.stringify(raw.derived));
  return out;
}

/** anchors.json ({ id: { rise, set, curve } }) or null. */
export function readAnchors(file) {
  try {
    const a = JSON.parse(fs.readFileSync(file, 'utf8'));
    return a && typeof a === 'object' && !Array.isArray(a) ? a : null;
  } catch {
    return null;
  }
}

/** A localStorage-like store kept in one JSON file (for the weather client's cache). */
export function fileStorage(file) {
  const load = () => {
    try {
      const o = JSON.parse(fs.readFileSync(file, 'utf8'));
      return o && typeof o === 'object' && !Array.isArray(o) ? o : {};
    } catch {
      return {};
    }
  };
  return {
    getItem(key) {
      const o = load();
      return Object.prototype.hasOwnProperty.call(o, key) ? String(o[key]) : null;
    },
    setItem(key, value) {
      const o = load();
      o[key] = String(value);
      writeJsonAtomic(file, o);
    },
    removeItem(key) {
      const o = load();
      if (Object.prototype.hasOwnProperty.call(o, key)) {
        delete o[key];
        writeJsonAtomic(file, o);
      }
    },
  };
}
