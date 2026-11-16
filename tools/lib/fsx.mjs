// File-system helpers shared by build, validate and tests. Node built-ins only.
// Text is always written as UTF-8 without BOM, with LF line endings.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Backslashes to forward slashes (for logs and archive names). */
export function toPosix(p) {
  return String(p).split(path.sep).join('/').replace(/\\/g, '/');
}

/** True when `child` is `parent` itself or lies inside it (case-insensitive on Windows). */
export function isInside(parent, child) {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  if (rel === '') return true;
  return rel !== '..' && !rel.startsWith('..' + path.sep) && !rel.startsWith('../') && !path.isAbsolute(rel);
}

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** True when the bytes start with the UTF-8 BOM (EF BB BF). */
export function hasBom(buf) {
  return !!buf && buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
}

/** Decode UTF-8, throwing on invalid byte sequences. */
export function decodeUtf8Strict(buf, label = '<buffer>') {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buf);
  } catch {
    throw new Error(`${label}: not valid UTF-8`);
  }
}

/** Strip a leading BOM and turn CRLF into LF. */
export function normalizeText(text) {
  let t = String(text);
  if (t.charCodeAt(0) === 0xfeff) t = t.slice(1);
  return t.replace(/\r\n/g, '\n');
}

/** Read a file as UTF-8 text (lenient decode, BOM kept so callers can see it). */
export function readText(file) {
  return fs.readFileSync(file).toString('utf8');
}

/**
 * Strict JSON: fails on a BOM, on invalid UTF-8 and on any JSON syntax error
 * (no comments, no trailing commas). `input` is a Buffer or a string.
 */
export function parseJsonStrict(input, label = '<json>') {
  let text;
  if (Buffer.isBuffer(input) || input instanceof Uint8Array) {
    if (hasBom(input)) throw new Error(`${label}: starts with a UTF-8 BOM`);
    text = decodeUtf8Strict(input, label);
  } else {
    text = String(input);
    if (text.charCodeAt(0) === 0xfeff) throw new Error(`${label}: starts with a UTF-8 BOM`);
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`${label}: invalid JSON: ${e.message}`);
  }
}

export function readJsonStrict(file, label = file) {
  return parseJsonStrict(fs.readFileSync(file), label);
}

/** Write UTF-8 text without BOM, CRLF -> LF, creating folders. Returns the byte count. */
export function writeText(file, text) {
  const buf = Buffer.from(normalizeText(text), 'utf8');
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, buf);
  return buf.length;
}

/** Write bytes, creating folders. Returns the byte count. */
export function writeBytes(file, data) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, buf);
  return buf.length;
}

/** Copy one file (bytes unchanged), creating folders. Returns the byte count. */
export function copyFile(src, dst) {
  ensureDir(path.dirname(dst));
  fs.copyFileSync(src, dst);
  return fs.statSync(dst).size;
}

/**
 * Recursively copy a folder. `filter(rel, abs, isDir)` (rel is posix, relative to src) may return
 * false to skip a file or a whole sub-folder. Returns [{ rel, bytes }] for the copied files.
 */
export function copyDir(src, dst, { filter } = {}) {
  if (!fs.statSync(src).isDirectory()) throw new Error(`copyDir: not a folder: ${src}`);
  const copied = [];
  const walk = (relDir) => {
    const absDir = path.join(src, relDir);
    const entries = fs.readdirSync(absDir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const ent of entries) {
      const rel = relDir ? relDir + '/' + ent.name : ent.name;
      const abs = path.join(src, rel);
      const isDir = ent.isDirectory() || (ent.isSymbolicLink() && fs.statSync(abs).isDirectory());
      if (filter && filter(rel, abs, isDir) === false) continue;
      if (isDir) walk(rel);
      else copied.push({ rel, bytes: copyFile(abs, path.join(dst, rel)) });
    }
  };
  ensureDir(dst);
  walk('');
  return copied;
}

/**
 * Recursive list of files under `dir`, as sorted posix paths relative to `base` (default: dir).
 * Returns [] when `dir` does not exist.
 */
export function listFiles(dir, { base = dir } = {}) {
  const out = [];
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return out;
  const walk = (abs) => {
    for (const ent of fs.readdirSync(abs, { withFileTypes: true })) {
      const p = path.join(abs, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (ent.isFile()) out.push(toPosix(path.relative(base, p)));
      else if (ent.isSymbolicLink()) {
        const st = fs.statSync(p);
        if (st.isDirectory()) walk(p); else out.push(toPosix(path.relative(base, p)));
      }
    }
  };
  walk(dir);
  return out.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * Delete a file or folder tree, retrying while Windows still holds handles (EBUSY/EPERM after a
 * process exits). Resolves true when the path is gone.
 */
export async function rmrf(target, { tries = 20, delayMs = 250 } = {}) {
  for (let i = 0; i < tries; i++) {
    try {
      await fsp.rm(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } catch {
      // retried below
    }
    if (!fs.existsSync(target)) return true;
    await sleep(delayMs);
  }
  return !fs.existsSync(target);
}

/** Synchronous variant of rmrf (used from process 'exit' handlers). */
export function rmrfSync(target, { maxRetries = 10 } = {}) {
  try {
    fs.rmSync(target, { recursive: true, force: true, maxRetries, retryDelay: 100 });
  } catch {
    // reported by the return value
  }
  return !fs.existsSync(target);
}

/** New empty folder in os.tmpdir() named <prefix><random>. */
export function makeTempDir(prefix = 'pcd-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

let PYTHON = undefined;
/** { cmd, args } to start Python 3 ('python', else 'py -3'), or null. */
export function findPython() {
  if (PYTHON !== undefined) return PYTHON;
  const candidates = [{ cmd: 'python', args: [] }, { cmd: 'py', args: ['-3'] }, { cmd: 'python3', args: [] }];
  PYTHON = null;
  for (const c of candidates) {
    const r = spawnSync(c.cmd, [...c.args, '-c', 'import sys; print(sys.version_info[0])'], { encoding: 'utf8', windowsHide: true });
    if (r.status === 0 && String(r.stdout).trim() === '3') { PYTHON = c; break; }
  }
  return PYTHON;
}

/**
 * Zip a folder with tools/lib/zip.py (stdlib zipfile, ZIP_DEFLATED, posix names, files only).
 * Returns { out, stdout }. Throws with Python's output on failure.
 */
export function zipDir(srcDir, outZip) {
  const py = findPython();
  if (!py) throw new Error('zipDir: Python 3 not found (tried python, py -3, python3)');
  const script = path.join(HERE, 'zip.py');
  const r = spawnSync(py.cmd, [...py.args, script, path.resolve(srcDir), path.resolve(outZip)], { encoding: 'utf8', windowsHide: true });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`zip.py failed (exit ${r.status}): ${(r.stderr || '') + (r.stdout || '')}`.trim());
  return { out: path.resolve(outZip), stdout: r.stdout };
}
