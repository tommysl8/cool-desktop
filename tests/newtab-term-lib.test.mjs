// The new tab terminal's copies of the terminal libraries from an earlier terminal project (src/newtab/js/term/lib/):
// each is the original file byte for byte once the classic-script wrapper is undone (tests/newtab-term-wrap.mjs pins
// the SHA-256 of each), it is current, it is a classic script that passes the CSP lint and the safe glyph set, every
// import resolves, and it behaves exactly like the ES module it came from (the same calls in an ES module graph and in
// a classic vm realm, both on this terminal's own commands table).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { SOURCES, OWN_MODULES, LIB_DIR, SOURCE_ENV, checkCopy, sha256, unwrap, wrap, wrapInfo } from './newtab-term-wrap.mjs';
import { TERM_DIR, loadTerm, termFiles } from './newtab-term-load.mjs';
import { lintJs } from '../tools/validate.mjs';
import { isSafeChar } from '../tools/lib/glyphs.mjs';

const NAMES = Object.keys(SOURCES);
const read = (name) => fs.readFileSync(path.join(LIB_DIR, name), 'utf8');

test('every copy unwraps to its original file (SHA-256) and is current', () => {
  assert.deepEqual(fs.readdirSync(LIB_DIR).filter((f) => f.endsWith('.js')).sort(), [...NAMES].sort(), 'exactly the listed files');
  for (const name of NAMES) {
    const r = checkCopy(name, read(name));
    assert.ok(r.ok, `${name}: ${r.problems.join('; ')}`);
    assert.equal(sha256(unwrap(read(name)).source), SOURCES[name]);
  }
});

test('the copies equal the originals when PCD_TERM_LIB_SOURCE names their folder', (t) => {
  const dir = process.env[SOURCE_ENV];
  if (!dir || !fs.existsSync(dir)) {
    t.skip(`set ${SOURCE_ENV} to compare with the originals`);
    return;
  }
  for (const name of NAMES) {
    const live = fs.readFileSync(path.join(dir, name));
    assert.equal(sha256(live), SOURCES[name], `${name} changed: review it, then regenerate (tests/newtab-term-wrap.mjs --from <dir> --write)`);
    assert.equal(Buffer.compare(Buffer.from(unwrap(read(name)).source, 'utf8'), live), 0, name);
  }
});

test('wrap and unwrap: line for line, reversible, and loud on forms they do not know', () => {
  const src = "/** é → x */\nimport { a, b } from './x.js';\nexport const K = 'λ∞';\nexport function f() { return a + b + K; }\nconst s = '\\\\u2028 \\u00e9';\n";
  const info = wrapInfo('demo.js', src);
  assert.deepEqual(info.exports, ['K', 'f']);
  assert.deepEqual(info.imports, [{ names: ['a', 'b'], from: './x.js' }]);
  assert.match(info.text, /^const \{ a, b \} = require\('\.\/x\.js'\);$/m);
  assert.match(info.text, /^\/\*export\*\/const K = '\\u03BB\\u221E';$/m);
  assert.match(info.text, /^exports\.f = f;$/m);
  assert.ok(info.text.includes('→'), 'safe glyphs stay as they are');
  assert.ok(!info.text.includes('é'), 'an unsafe glyph in a comment is escaped too');
  assert.equal(unwrap(info.text).source, src);
  assert.equal(unwrap(info.text).name, 'demo.js');
  assert.throws(() => wrap('x.js', "import x from './y.js';\n"), /import form/);
  assert.throws(() => wrap('x.js', 'export default 1;\n'), /export form/);
  assert.throws(() => wrap('x.js', 'export { a };\n'), /export form/);
  assert.throws(() => wrap('x.js', 'const a = 1;\r\n'), /CR/);
  assert.throws(() => wrap('x.js', 'const a = 1;'), /final newline/);
  assert.throws(() => wrap('x.js', wrap('y.js', 'const a = 1;\n')), /already/);
  assert.throws(() => unwrap('const a = 1;\n'), /no begin line/);
  const upper = "const s = '" + String.fromCharCode(92) + "u221E';\n";
  assert.throws(() => wrap('x.js', upper), /upper-case escape/, 'an escape unwrap would decode is refused');
});

test('classic scripts: no module syntax, the CSP lint is clean, safe glyphs only', () => {
  for (const f of termFiles()) {
    const text = fs.readFileSync(path.join(TERM_DIR, f), 'utf8');
    assert.doesNotThrow(() => new vm.Script(text, { filename: f }), `${f} compiles as a classic script`);
    assert.deepEqual(lintJs(text), [], `${f}: CSP lint`);
    const bad = [...new Set([...text].filter((ch) => ch !== '\n' && !isSafeChar(ch)))];
    assert.deepEqual(bad, [], `${f}: characters outside the safe set`);
    assert.ok(!text.includes('\r') && !text.startsWith('\ufeff'), `${f}: LF, no BOM`);
  }
});

test('every name a copy imports is exported by the module it names (commands.js is the terminal\'s own)', () => {
  const T = loadTerm();
  const exportsOf = (name) => (OWN_MODULES.includes(name) ? Object.keys(T.lib(name)) : wrapInfo(name, unwrap(read(name)).source).exports);
  for (const name of NAMES) {
    for (const imp of wrapInfo(name, unwrap(read(name)).source).imports) {
      const target = imp.from.replace(/^\.\//, '');
      assert.ok(NAMES.includes(target) || OWN_MODULES.includes(target), `${name} imports ${target}, which is not shipped`);
      const have = exportsOf(target);
      for (const n of imp.names) assert.ok(have.includes(n), `${name} imports ${n} from ${target}`);
    }
  }
});

/** The copies as ES modules (unwrapped) in a temp folder; their commands.js hands out this terminal's own table. */
async function esmGraph() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pcd-term-esm-'));
  fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}\n');
  for (const name of NAMES) fs.writeFileSync(path.join(dir, name), unwrap(read(name)).source);
  const C = loadTerm().lib('commands.js');
  globalThis.__pcdTermCommands = C;
  fs.writeFileSync(path.join(dir, 'commands.js'), `const C = globalThis.__pcdTermCommands;\nexport const { ${Object.keys(C).join(', ')} } = C;\n`);
  const mods = {};
  for (const name of [...NAMES, 'commands.js']) mods[name] = await import(pathToFileURL(path.join(dir, name)).href);
  return { dir, mods };
}

/** The shipped classic copies and term-commands.js, as the page loads them, in a fresh vm realm. */
function classicRealm() {
  const context = vm.createContext({ URL, URLSearchParams, console });
  for (const name of NAMES) vm.runInContext(read(name), context, { filename: name });
  vm.runInContext(fs.readFileSync(path.join(TERM_DIR, 'term-commands.js'), 'utf8'), context, { filename: 'term-commands.js' });
  const cache = {};
  const req = (n) => {
    const key = n.replace(/^\.\//, '');
    if (!cache[key]) {
      cache[key] = { exports: {} };
      context.PCD.termDefs[key](req, cache[key].exports);
    }
    return cache[key].exports;
  };
  return req;
}

test('the classic copies behave exactly like the ES modules they came from', async () => {
  const { dir, mods } = await esmGraph();
  try {
    const req = classicRealm();
    const same = (a, b, what) => assert.equal(JSON.stringify(b), JSON.stringify(a), what);
    const links = [{ name: 'wikipedia', url: 'https://www.wikipedia.org' }, { name: 'maps', url: 'https://www.openstreetmap.org' }, { name: 'bad', url: 'ftp://x.example' }];
    const lines = ['', '3', '3 &', '9', 'maps', 'Maps &', 'bad', 'example.com', 'localhost:3000/x', 'javascript:alert(1)',
      'node.js', 'g pixel art', 'yt', 'gh   pixel clock  &', '= 2^10', '=2+2', 'calc sqrt(2)*pi', 'theme winter', 'theme park',
      'theme wintr', 'clock 13', 'clock 24', 'help', 'help theme', 'help maps', 'help more', 'history clear', 'history foo', 'clear',
      'cls', 'weather', 'weather in paris', 'surprise me', '"quoted words" here', 'C:\\temp\\x', 'user@example.com',
      'https://user:pw@example.com', 'example.com:99999', 'café', 'emoji 😀 text', '  spaced   out  '];
    for (const line of lines) {
      same(mods['router.js'].route(line, { aliases: links, newTab: false }), req('router.js').route(line, { aliases: links, newTab: false }), `route ${JSON.stringify(line)}`);
      same(mods['complete.js'].complete(line, { aliases: links }), req('complete.js').complete(line, { aliases: links }), `complete ${JSON.stringify(line)}`);
      same(mods['parse.js'].parseInput(line), req('parse.js').parseInput(line), `parseInput ${JSON.stringify(line)}`);
      same(mods['url.js'].normalizeUrl(line), req('url.js').normalizeUrl(line), `normalizeUrl ${JSON.stringify(line)}`);
      same(mods['url.js'].isUrlLike(line), req('url.js').isUrlLike(line), `isUrlLike ${JSON.stringify(line)}`);
      same(mods['format.js'].safeText(line, 20), req('format.js').safeText(line, 20), `safeText ${JSON.stringify(line)}`);
    }
    for (const e of ['2^10', 'sqrt(2)*pi', '1/0', '-0', '2+', '(1+2', 'log(1000) + ln(e)', '10 % 3', '1e400', 'abc']) {
      same(mods['calc.js'].calc(e), req('calc.js').calc(e), `calc ${e}`);
    }
    for (const eng of ['g', 'yt', 'gh', 'x']) same(mods['router.js'].searchUrl(eng, 'a b & c'), req('router.js').searchUrl(eng, 'a b & c'), `searchUrl ${eng}`);
    same(mods['format.js'].SAFE_EXTRA, req('format.js').SAFE_EXTRA, 'SAFE_EXTRA (escaped in the copy, equal at run time)');
    same(mods['format.js'].bar(42, 10), req('format.js').bar(42, 10), 'bar');
    let h1 = [];
    let h2 = [];
    for (const l of ['a', 'b', 'b', ' c ', '', 'x'.repeat(2001)]) {
      h1 = mods['history.js'].pushHistory(h1, l, 3);
      h2 = req('history.js').pushHistory(h2, l, 3);
    }
    same(h1, h2, 'pushHistory');
    same(mods['history.js'].historyLines(h1), req('history.js').historyLines(h2), 'historyLines');
    const c1 = mods['history.js'].createCursor(['a', 'b']);
    const c2 = req('history.js').createCursor(['a', 'b']);
    same([c1.up('draft'), c1.up(''), c1.up(''), c1.down(''), c1.down(''), c1.down('')], [c2.up('draft'), c2.up(''), c2.up(''), c2.down(''), c2.down(''), c2.down('')], 'cursor');
    same(mods['aliases.js'].normalizeAliases([{ name: 'A', url: 'a.example' }, { name: 'a', url: 'b.example' }, 7]), req('aliases.js').normalizeAliases([{ name: 'A', url: 'a.example' }, { name: 'a', url: 'b.example' }, 7]), 'normalizeAliases');
  } finally {
    delete globalThis.__pcdTermCommands;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
