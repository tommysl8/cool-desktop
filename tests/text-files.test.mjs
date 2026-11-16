// node --test tests/text-files.test.mjs
// Every text file of the project is UTF-8 without BOM, with LF line endings: everything under src/, tools/ and
// tests/, the files in FILES and the synced engine in vendor/pixelclock/.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Folders whose text files are all checked. */
export const DIRS = ['src', 'tools', 'tests'];
/** Text files outside those folders. */
export const FILES = [
  '.gitattributes', '.gitignore', 'LICENSE', 'config/user.example.json', 'README.md', 'INSTALL.md', 'UNINSTALL.md',
  'design/tokens.json', 'design/style-tile.html', 'design/style-tile.css', 'design/style-tile.js',
  'design/atlas/atlas.json', 'design/fonts/OFL.txt',
];
const TEXT_RE = /\.(m?js|cjs|json|css|html|md|txt|py)$/i;

/** Text files under a folder, as posix paths relative to the repo root. */
function walk(rel) {
  const out = [];
  for (const ent of fs.readdirSync(path.join(ROOT, ...rel.split('/')), { withFileTypes: true })) {
    const child = `${rel}/${ent.name}`;
    if (ent.isDirectory()) out.push(...walk(child));
    else if (ent.isFile() && TEXT_RE.test(ent.name)) out.push(child);
  }
  return out;
}

/** Problems of one file: a BOM, a CR, invalid UTF-8. */
function problems(rel) {
  const buf = fs.readFileSync(path.join(ROOT, ...rel.split('/')));
  const bad = [];
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) bad.push(`${rel}: BOM`);
  if (buf.includes(13)) bad.push(`${rel}: CR`);
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    bad.push(`${rel}: not UTF-8`);
  }
  return bad;
}

test('text files: UTF-8 without BOM, LF only (src/, tools/, tests/, the listed files, the synced engine)', () => {
  const walked = DIRS.flatMap(walk);
  assert.ok(walked.length > 100, `${walked.length} text files under ${DIRS.join(', ')}`);
  for (const d of ['src/shared/pcd-engine.js', 'tools/build.mjs', 'tests/text-files.test.mjs']) assert.ok(walked.includes(d), `the walk finds ${d}`);
  const vendor = path.join(ROOT, 'vendor', 'pixelclock');
  const vendorFiles = JSON.parse(fs.readFileSync(path.join(vendor, 'SYNC.json'), 'utf8')).files.map((f) => `vendor/pixelclock/${f.path}`);
  const all = [...walked, ...FILES, ...vendorFiles, 'vendor/pixelclock/SYNC.json'];
  assert.deepEqual(all.flatMap(problems), []);
});

test('.gitattributes: LF for text, vendor/ bytes kept as they are', () => {
  const lines = fs.readFileSync(path.join(ROOT, '.gitattributes'), 'utf8').split('\n');
  assert.ok(lines.includes('vendor/** -text'));
  assert.ok(lines.includes('* text=auto eol=lf'));
});
