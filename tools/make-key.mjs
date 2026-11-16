#!/usr/bin/env node
// node tools/make-key.mjs [--check] [--force] [--manifest <file>] [--id-file <file>]
//
// The new tab's fixed extension ID. Chrome derives an unpacked extension's ID from the manifest "key" (the base64 SPKI
// DER of an RSA public key): with a key the ID is the same in every folder and on every computer, so chrome.storage
// keeps your settings across reinstalls and the real-load test can check the ID.
//
// - No key yet: generates an RSA-2048 key pair in memory and writes ONLY the public key into src/newtab/manifest.json
//   ("key", added last or replaced in place) and the ID into src/newtab/EXTENSION_ID.txt. The private key is never
//   written anywhere and is not needed: the extension is loaded unpacked, never packed or published.
// - A key already there: kept (a new key would change the ID and orphan your stored settings);
//   EXTENSION_ID.txt is rewritten only when it is missing or does not match. --force makes a new key anyway.
// - --check: verifies the key (an RSA SPKI public key, nothing private) and that EXTENSION_ID.txt matches; writes
//   nothing; exit code 1 on any problem.
// Files are UTF-8 without BOM, LF. Node built-ins only.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJsonStrict, writeText } from './lib/fsx.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, '..');
export const MANIFEST_REL = 'src/newtab/manifest.json';
export const ID_REL = 'src/newtab/EXTENSION_ID.txt';
export const ID_RE = /^[a-p]{32}$/;

/** Chrome's extension ID for a base64 SPKI public key: SHA-256 of the DER, first 32 hex digits, 0-f -> a-p. */
export function extensionId(keyBase64) {
  const der = Buffer.from(String(keyBase64).replace(/-----[^-]+-----/g, '').replace(/\s+/g, ''), 'base64');
  const hex = crypto.createHash('sha256').update(der).digest('hex').slice(0, 32);
  return [...hex].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('');
}

/** A fresh RSA-2048 key pair; returns only { key (base64 SPKI DER), id }. The private half is dropped here. */
export function generateKey() {
  const { publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, publicExponent: 0x10001 });
  const key = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  return { key, id: extensionId(key) };
}

/** Problems with a manifest "key" value ([] = a valid RSA public key in base64 SPKI DER, nothing private). */
export function keyProblems(key) {
  if (typeof key !== 'string' || !key) return ['"key" is missing (run node tools/make-key.mjs)'];
  if (/PRIVATE|-----/i.test(key)) return ['"key" must be the bare base64 public key, never a PEM block or a private key'];
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(key)) return ['"key" is not plain base64'];
  try {
    const k = crypto.createPublicKey({ key: Buffer.from(key, 'base64'), format: 'der', type: 'spki' });
    if (k.asymmetricKeyType !== 'rsa') return [`"key" must be an RSA public key (got ${k.asymmetricKeyType})`];
    const bits = k.asymmetricKeyDetails && k.asymmetricKeyDetails.modulusLength;
    if (bits && bits < 2048) return [`"key" is only ${bits} bits (2048 expected)`];
  } catch (e) {
    return [`"key" is not a valid SPKI public key (${e.message})`];
  }
  return [];
}

/**
 * The whole check: { ok, id, problems }. idText is the content of EXTENSION_ID.txt (null when missing).
 */
export function checkKey(manifest, idText) {
  const key = manifest && typeof manifest === 'object' ? manifest.key : undefined;
  const problems = keyProblems(key);
  const id = problems.length ? null : extensionId(key);
  if (idText === null || idText === undefined) problems.push(`${ID_REL} is missing`);
  else {
    const want = String(idText).trim();
    if (!ID_RE.test(want)) problems.push(`${ID_REL} must hold one id of 32 letters a-p (got ${JSON.stringify(want.slice(0, 40))})`);
    else if (id && want !== id) problems.push(`${ID_REL} says ${want}, but the manifest key gives ${id}`);
  }
  return { ok: problems.length === 0, id, problems };
}

function readIdFile(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/** Run it. Returns { code, id, wrote: [files], messages: [text] }. */
export function makeKey({ manifestPath = path.join(ROOT, ...MANIFEST_REL.split('/')), idPath = path.join(ROOT, ...ID_REL.split('/')), force = false, check = false } = {}) {
  const messages = [];
  const wrote = [];
  const manifest = readJsonStrict(manifestPath, path.basename(manifestPath));
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw new Error(`${manifestPath}: not a JSON object`);
  if (check) {
    const r = checkKey(manifest, readIdFile(idPath));
    if (r.ok) messages.push(`OK: manifest key is an RSA public key; extension id ${r.id} matches ${path.basename(idPath)}`);
    for (const p of r.problems) messages.push(`FAIL: ${p}`);
    return { code: r.ok ? 0 : 1, id: r.id, wrote, messages };
  }
  let id;
  if (manifest.key !== undefined && !force) {
    const problems = keyProblems(manifest.key);
    if (problems.length) throw new Error(`${manifestPath}: ${problems.join('; ')} (fix it, or run with --force to make a new key and a new id)`);
    id = extensionId(manifest.key);
    messages.push(`kept the existing key (extension id ${id}); --force would make a new key and change the id`);
  } else {
    const fresh = generateKey();
    manifest.key = fresh.key;
    id = fresh.id;
    writeText(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
    wrote.push(manifestPath);
    messages.push(`wrote a new public key into ${path.basename(manifestPath)} (the private key was never written; it is not needed)`);
  }
  if (readIdFile(idPath) !== id + '\n') {
    writeText(idPath, id + '\n');
    wrote.push(idPath);
    messages.push(`wrote ${path.basename(idPath)}: ${id}`);
  }
  return { code: 0, id, wrote, messages };
}

export function parseArgs(argv) {
  const o = { force: false, check: false, manifestPath: undefined, idPath: undefined, help: false, errors: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--force') o.force = true;
    else if (a === '--check') o.check = true;
    else if (a === '-h' || a === '--help') o.help = true;
    else if (a === '--manifest' || a === '--id-file') {
      const v = argv[++i];
      if (!v) o.errors.push(`${a} needs a file`);
      else if (a === '--manifest') o.manifestPath = path.resolve(v);
      else o.idPath = path.resolve(v);
    } else o.errors.push(`unknown argument ${a}`);
  }
  if (o.force && o.check) o.errors.push('--force and --check do not go together');
  return o;
}

function isMainModule() {
  if (typeof import.meta.main === 'boolean') return import.meta.main;
  try {
    return !!process.argv[1] && path.relative(fs.realpathSync(process.argv[1]), fileURLToPath(import.meta.url)) === '';
  } catch {
    return false;
  }
}

if (isMainModule()) {
  const o = parseArgs(process.argv.slice(2));
  if (o.help || o.errors.length) {
    if (o.errors.length) console.error(o.errors.join('\n'));
    console.log('usage: node tools/make-key.mjs [--check] [--force] [--manifest <file>] [--id-file <file>]');
    process.exitCode = o.errors.length ? 1 : 0;
  } else {
    try {
      const r = makeKey({ manifestPath: o.manifestPath, idPath: o.idPath, force: o.force, check: o.check });
      for (const m of r.messages) console.log(m);
      process.exitCode = r.code;
    } catch (e) {
      console.error(e && e.message ? e.message : e);
      process.exitCode = 1;
    }
  }
}
