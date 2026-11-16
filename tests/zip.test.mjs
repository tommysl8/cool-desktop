// node --test tests/zip.test.mjs
// zip.py must write forward-slash names with no "./" and no top folder (Lively rejects backslashes).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { findPython, makeTempDir, rmrf, zipDir } from '../tools/lib/fsx.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ZIP_PY = path.join(ROOT, 'tools', 'lib', 'zip.py');
const TAR = process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
const py = findPython();

function makeTree(dir) {
  const files = {
    'LivelyInfo.json': '{"Title":"t"}\n',
    'LivelyProperties.json': '{}\n',
    'index.html': '<!doctype html><meta charset="utf-8"><title>t</title>\n',
    'js/app.js': 'var x = 1;\n',
    'js/scenes/rain.js': 'var y = 2;\n',
    'css/base.css': 'body{}\n',
    'fonts/OFL.txt': 'licence\n',
    'sub dir/with space.txt': 'spaces\n',
  };
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
  fs.writeFileSync(path.join(dir, 'thumbnail.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  fs.mkdirSync(path.join(dir, 'empty-folder'));
  return [...Object.keys(files), 'thumbnail.jpg'].sort();
}

function checkNames(names, expected, where) {
  for (const n of names) {
    assert.ok(!n.includes('\\'), `${where}: backslash in ${n}`);
    assert.ok(!n.startsWith('./'), `${where}: "./" prefix in ${n}`);
    assert.ok(!n.startsWith('/'), `${where}: absolute name ${n}`);
    assert.ok(!n.endsWith('/'), `${where}: directory entry ${n}`);
  }
  assert.deepEqual([...names].sort(), expected, `${where}: entry list`);
  for (const root of ['LivelyInfo.json', 'LivelyProperties.json', 'index.html']) assert.ok(names.includes(root), `${where}: ${root} at the zip root`);
}

test('zip.py: posix names, files only, root files at the top (python namelist + tar.exe -tf)', { skip: py ? false : 'Python 3 not found' }, async (t) => {
  const tmp = makeTempDir('pcd-ziptest-');
  try {
    const src = path.join(tmp, 'pkg');
    fs.mkdirSync(src);
    const expected = makeTree(src);
    const out = path.join(tmp, 'out', 'PixelClockDesktop-wallpaper.zip');

    // Via the Node wrapper ...
    const res = zipDir(src, out);
    assert.match(res.stdout, /wrote .*PixelClockDesktop-wallpaper\.zip \(9 files/);
    assert.ok(fs.statSync(out).size > 0);

    // ... Python's own view of the archive
    const list = spawnSync(py.cmd, [...py.args, '-I', '-c', 'import json, sys, zipfile; z = zipfile.ZipFile(sys.argv[1]); print(json.dumps(z.namelist())); print(json.dumps(sorted({i.compress_type for i in z.infolist()})))', out], { encoding: 'utf8' });
    assert.equal(list.status, 0, list.stderr);
    const [namesJson, typesJson] = list.stdout.trim().split(/\r?\n/);
    checkNames(JSON.parse(namesJson), expected, 'python namelist');
    assert.deepEqual(JSON.parse(typesJson), [8], 'every entry is ZIP_DEFLATED (8)');

    // ... and Windows' bsdtar
    const tar = spawnSync(TAR, ['-tf', out], { encoding: 'utf8' });
    assert.equal(tar.status, 0, tar.stderr);
    checkNames(tar.stdout.split(/\r?\n/).filter(Boolean), expected, 'tar -tf');
    t.diagnostic(`tar -tf: ${tar.stdout.split(/\r?\n/).filter(Boolean).join(' | ')}`);

    // Running zip.py directly works the same way and replaces an existing zip.
    const direct = spawnSync(py.cmd, [...py.args, ZIP_PY, src, out], { encoding: 'utf8' });
    assert.equal(direct.status, 0, direct.stderr);
    assert.match(direct.stdout, /add js\/scenes\/rain\.js/);
  } finally {
    await rmrf(tmp);
  }
});

test('zip.py: usage errors and refusing to zip into its own source', { skip: py ? false : 'Python 3 not found' }, async () => {
  const tmp = makeTempDir('pcd-ziptest-');
  try {
    const usage = spawnSync(py.cmd, [...py.args, ZIP_PY], { encoding: 'utf8' });
    assert.equal(usage.status, 2);
    assert.match(usage.stderr, /usage: python tools\/lib\/zip\.py <srcDir> <outZip>/);
    const missing = spawnSync(py.cmd, [...py.args, ZIP_PY, path.join(tmp, 'nope'), path.join(tmp, 'x.zip')], { encoding: 'utf8' });
    assert.equal(missing.status, 2);
    assert.match(missing.stderr, /source is not a folder/);
    fs.writeFileSync(path.join(tmp, 'a.txt'), 'a');
    const inside = spawnSync(py.cmd, [...py.args, ZIP_PY, tmp, path.join(tmp, 'self.zip')], { encoding: 'utf8' });
    assert.equal(inside.status, 2);
    assert.match(inside.stderr, /must not be inside the source folder/);
    assert.throws(() => zipDir(path.join(tmp, 'nope'), path.join(tmp, 'y.zip')), /zip\.py failed \(exit 2\)/);
  } finally {
    await rmrf(tmp);
  }
});
