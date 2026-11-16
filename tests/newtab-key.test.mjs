// tools/make-key.mjs: Chrome's extension id from a manifest key (a vector Chrome itself produced), fresh keys
// (RSA 2048, public half only), the write / keep / --force / --check paths on temporary files, refusal of anything
// private, and the repo's own manifest key agreeing with src/newtab/EXTENSION_ID.txt.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

function findRoot(dir) {
  for (let d = dir; ; d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, 'tools', 'build.mjs'))) return d;
    if (path.dirname(d) === d) throw new Error('repo root not found');
  }
}
const ROOT = findRoot(import.meta.dirname);
const K = await import(pathToFileURL(path.join(ROOT, 'tools', 'make-key.mjs')).href);

// A public key of an earlier unpacked extension and the ID Chrome 157 gave it (its real-load test compared them):
// an outside vector. A public key only: no private key is ever in the repo.
const OUTSIDE_KEY = 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAp1qeALTv3Kd94qWhXtUMBqnsMXKVDjc7Sw0y78tO69Gr5wG9wFiPvXIdBM2sO3tBffpqiDTDvDVQ8qjxHobsfDLqCfZT3zaoaKL9ygzEceBLwkCR3TJDGBJF5TBuk1aOBDFy+utEFpCZRE7rrsrKDZMbQI/4nnibjrmiYxjMUFeY2/pBkjUXS+rLy45716vNRmyZVjL01G9hl6lFO3SvJsKLC8gmb0UErTshL77XrkzkQB9qAmo4y93m9HxLwiFe6WDZKArc2suq09wbaKpMy4ytx7L+tG2MqplVncYftzVd4cVJ75sXr9JHyqQIA3suOOauTp6Cjg7QEgCtV+mgyQIDAQAB';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pcd-make-key-'));
process.on('exit', () => fs.rmSync(tmp, { recursive: true, force: true }));
function files(name, manifest = { manifest_version: 3, name: 'x', version: '1' }) {
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir, { recursive: true });
  const manifestPath = path.join(dir, 'manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  return { dir, manifestPath, idPath: path.join(dir, 'EXTENSION_ID.txt') };
}

test('extensionId(): the id Chrome derives (SHA-256 of the DER, 32 hex digits as a-p)', () => {
  assert.equal(K.extensionId(OUTSIDE_KEY), 'elmhpcpijajogbgjlgeehmnbcociadim');
  assert.equal(K.extensionId(`-----BEGIN PUBLIC KEY-----\n${OUTSIDE_KEY.match(/.{1,64}/g).join('\n')}\n-----END PUBLIC KEY-----`), 'elmhpcpijajogbgjlgeehmnbcociadim');
});

test('generateKey(): an RSA 2048 SPKI public key in base64 and its id; the private half is never returned', () => {
  const g = K.generateKey();
  assert.deepEqual(Object.keys(g).sort(), ['id', 'key']);
  assert.match(g.key, /^[A-Za-z0-9+/]+={0,2}$/);
  assert.match(g.id, K.ID_RE);
  assert.equal(g.id, K.extensionId(g.key));
  const pub = crypto.createPublicKey({ key: Buffer.from(g.key, 'base64'), format: 'der', type: 'spki' });
  assert.equal(pub.asymmetricKeyType, 'rsa');
  assert.equal(pub.asymmetricKeyDetails.modulusLength, 2048);
  assert.deepEqual(K.keyProblems(g.key), []);
  assert.notEqual(K.generateKey().id, g.id);
});

test('keyProblems(): nothing private, no PEM, RSA of 2048 bits or more only', () => {
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const privDer = privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64');
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const ec = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }).publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  const small = crypto.generateKeyPairSync('rsa', { modulusLength: 1024 }).publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  assert.ok(K.keyProblems(privDer).length, 'a private key in DER');
  assert.ok(K.keyProblems(pem).length, 'a private PEM');
  assert.ok(K.keyProblems(ec).some((p) => /RSA/.test(p)));
  assert.ok(K.keyProblems(small).some((p) => /1024/.test(p)));
  assert.ok(K.keyProblems('not base64!').length);
  assert.ok(K.keyProblems('').length);
  assert.ok(K.keyProblems(undefined).length);
  assert.deepEqual(K.keyProblems(OUTSIDE_KEY), []);
});

test('makeKey(): writes the key and the id once, keeps them after, --force makes new ones, --check verifies', () => {
  const f = files('fresh');
  const first = K.makeKey({ manifestPath: f.manifestPath, idPath: f.idPath });
  assert.equal(first.code, 0);
  assert.deepEqual(first.wrote.map((p) => path.basename(p)), ['manifest.json', 'EXTENSION_ID.txt']);
  const m = JSON.parse(fs.readFileSync(f.manifestPath, 'utf8'));
  assert.deepEqual(Object.keys(m), ['manifest_version', 'name', 'version', 'key'], 'the key is added last; the rest is kept');
  assert.equal(fs.readFileSync(f.idPath, 'utf8'), `${first.id}\n`);
  assert.equal(K.extensionId(m.key), first.id);
  const text = fs.readFileSync(f.manifestPath);
  assert.ok(!text.includes('\r') && text[0] !== 0xef, 'LF, no BOM');
  const again = K.makeKey({ manifestPath: f.manifestPath, idPath: f.idPath });
  assert.equal(again.id, first.id);
  assert.deepEqual(again.wrote, [], 'nothing changes on a second run');
  fs.writeFileSync(f.idPath, 'stale\r\n');
  const fixed = K.makeKey({ manifestPath: f.manifestPath, idPath: f.idPath });
  assert.deepEqual(fixed.wrote.map((p) => path.basename(p)), ['EXTENSION_ID.txt']);
  assert.equal(fixed.id, first.id, 'a stale id file is rewritten from the kept key');
  assert.equal(K.makeKey({ manifestPath: f.manifestPath, idPath: f.idPath, check: true }).code, 0);
  fs.writeFileSync(f.idPath, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n');
  const bad = K.makeKey({ manifestPath: f.manifestPath, idPath: f.idPath, check: true });
  assert.equal(bad.code, 1);
  assert.ok(bad.messages.some((x) => /says aaaa/.test(x)));
  assert.equal(fs.readFileSync(f.idPath, 'utf8'), 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n', '--check writes nothing');
  const forced = K.makeKey({ manifestPath: f.manifestPath, idPath: f.idPath, force: true });
  assert.notEqual(forced.id, first.id);
  assert.equal(fs.readFileSync(f.idPath, 'utf8'), `${forced.id}\n`);
  for (const name of fs.readdirSync(f.dir)) {
    const body = fs.readFileSync(path.join(f.dir, name), 'utf8');
    assert.ok(!/PRIVATE/.test(body), `${name}: no private key`);
  }
  assert.deepEqual(fs.readdirSync(f.dir).sort(), ['EXTENSION_ID.txt', 'manifest.json'], 'no other file (no .pem)');
});

test('makeKey(): a broken key is never replaced silently; parseArgs', () => {
  const f = files('broken', { manifest_version: 3, key: 'bm90IGEga2V5' });
  assert.throws(() => K.makeKey({ manifestPath: f.manifestPath, idPath: f.idPath }), /--force/);
  assert.equal(K.makeKey({ manifestPath: f.manifestPath, idPath: f.idPath, check: true }).code, 1);
  assert.deepEqual(K.parseArgs(['--check']).errors, []);
  assert.ok(K.parseArgs(['--check', '--force']).errors.length);
  assert.ok(K.parseArgs(['--manifest']).errors.length);
  assert.ok(K.parseArgs(['--what']).errors.length);
});

test('the repo: src/newtab/manifest.json has a public key whose id is EXTENSION_ID.txt; nothing private in src/newtab', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'src', 'newtab', 'manifest.json'), 'utf8'));
  const idText = fs.readFileSync(path.join(ROOT, 'src', 'newtab', 'EXTENSION_ID.txt'), 'utf8');
  const r = K.checkKey(manifest, idText);
  assert.deepEqual(r.problems, []);
  assert.equal(idText, `${r.id}\n`);
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  for (const file of walk(path.join(ROOT, 'src', 'newtab'))) {
    assert.ok(!/\.(pem|crx|key|p12|pfx)$/i.test(file), file);
    if (!/\.png$/i.test(file)) assert.ok(!/PRIVATE KEY/.test(fs.readFileSync(file, 'utf8')), file);
  }
});
