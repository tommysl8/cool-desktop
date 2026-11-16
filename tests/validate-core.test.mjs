// node --test tests/validate-core.test.mjs
// tools/validate.mjs core checks: strict JSON (BOM = fail), LF, local references, the font's licence, each CSP lint
// rule, the glyph scan, the URL allowlist, vendor/ against SYNC.json, dist engine copies, drift (WARN) and plugin rows.
// Everything runs against temporary roots; the real dist/ is never touched and the real clock repo never read.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  JS_RULES, foreignUrls, htmlRefs, isLocalRef, isVendorCopy, lintHtml, lintJs, runValidate, scanGlyphs,
} from '../tools/validate.mjs';
import { formatReport, summarize } from '../tools/lib/report.mjs';
import { encodePng } from '../tools/lib/png.mjs';
import { makeTempDir, rmrf } from '../tools/lib/fsx.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VENDOR = path.join(ROOT, 'vendor', 'pixelclock');
const temps = [];
test.after(async () => { for (const d of temps) await rmrf(d); });

/** A config shaped like config/user.json, with the sample city. */
const CONFIG = {
  city: 'Berlin', units: 'C', clock: '24h', sunTimes: false, weather: true,
  shortcuts: [{ label: 'docs', url: 'https://example.org/docs' }], taskbarPx: 48,
};

function put(base, rel, data) {
  const p = path.join(base, ...rel.split('/'));
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, data);
  return p;
}

function makeRoot({ validate = {}, lib = {} } = {}) {
  const root = makeTempDir('pcd-validatetest-');
  temps.push(root);
  put(root, 'config/user.json', JSON.stringify(CONFIG, null, 2) + '\n');
  fs.cpSync(VENDOR, path.join(root, 'vendor', 'pixelclock'), { recursive: true });
  for (const [piece, code] of Object.entries(validate)) put(root, `tools/validate/${piece}.mjs`, code);
  for (const [name, code] of Object.entries(lib)) put(root, `tools/lib/${name}`, code);
  return root;
}

function goodDist(root) {
  const d = path.join(root, 'dist');
  put(d, 'good/index.html', [
    '<!doctype html><html><head><meta charset="utf-8"><title>t</title>',
    '<style>html,body{background:#141016}</style>',
    '<link rel="stylesheet" href="css/s.css"><link rel="icon" href="icon.png">',
    '<script defer src="js/pixelclock/engine.js"></script><script defer src="js/a.js"></script>',
    '<!-- <img src="commented-out.png"> -->',
    '</head><body><a href="https://open-meteo.com/">weather: open-meteo.com</a>',
    '<img src="data:image/png;base64,AAAA"><a href="#top">top</a><img src="/icon.png?v=1">',
    '<svg xmlns="http://www.w3.org/2000/svg"></svg>',
    '<pre>╭─ autumn forest ─╮ █░ 21° · → ●</pre></body></html>',
    '',
  ].join('\n'));
  put(d, 'good/js/a.js', "var a = 1;\nvar u = 'https://api.open-meteo.com/v1/forecast';\nvar g = 'https://geocoding-api.open-meteo.com/v1/search';\nvar c = 'http://pixelclock.local/api/status';\nvar s = 'https://example.org/docs';\nel.textContent = 'ok';\n");
  put(d, 'good/css/s.css', "@font-face{font-family:TermMono;src:url('../fonts/f.ttf') format('truetype')}\nb{background:url(#g)}\n");
  put(d, 'good/fonts/f.ttf', Buffer.from([0, 1, 0, 0]));
  put(d, 'good/fonts/OFL.txt', 'Licence text may contain anything ✓ https://openfontlicense.org\n');
  put(d, 'good/x.json', '{"a": 1}\n');
  put(d, 'good/icon.png', encodePng({ width: 3, height: 2, data: Buffer.alloc(3 * 2 * 4, 200) }));
  fs.mkdirSync(path.join(d, 'good', 'js', 'pixelclock', 'themes'), { recursive: true });
  fs.copyFileSync(path.join(VENDOR, 'simulator', 'engine.js'), path.join(d, 'good', 'js', 'pixelclock', 'engine.js'));
  fs.copyFileSync(path.join(VENDOR, 'simulator', 'themes', 'autumn.js'), path.join(d, 'good', 'js', 'pixelclock', 'themes', 'autumn.js'));
  put(d, 'still/pixelclock/tools/render.js', fs.readFileSync(path.join(VENDOR, 'tools', 'render.js')));
  return d;
}

const NO_CLOCK = (root) => path.join(root, 'no-clock-repo');

async function runVal(root, { pieces = [], clockRepo } = {}) {
  const lines = [];
  const res = await runValidate({ root, pieces, clockRepo: clockRepo ?? NO_CLOCK(root), log: (m) => lines.push(m) });
  const text = lines.join('\n');
  const get = (name) => res.rows.find((r) => r.name === name || r.name.startsWith(name)) || assert.fail(`no row ${name}\n${text}`);
  return { ...res, text, get };
}

const PLUGIN = `
export async function validate(vctx) {
  const png = vctx.pngSize('good/icon.png');
  const refused = (() => { try { vctx.readText('../outside.txt'); return false; } catch (e) { return true; } })();
  return [
    { name: 'exists', pass: vctx.exists('good/index.html') && !vctx.exists('good/nope.html') },
    { name: 'readJson', pass: vctx.readJson('good/x.json').a === 1 },
    { name: 'listFiles', pass: vctx.listFiles('good').includes('good/index.html') },
    { name: 'pngSize', pass: png.width === 3 && png.height === 2, detail: png.width + 'x' + png.height },
    { name: 'escape refused', pass: refused },
    { name: 'config', pass: vctx.config.units === 'C' },
    { name: 'glyph helper', pass: vctx.glyphs.unsafeChars('ok \\u2713 \\u2591').join() === 'U+2713' },
    { name: 'lint helpers', pass: vctx.lintJs('eval(x)').length === 1 && vctx.lintHtml('<a onclick="x">').length === 1 },
    { name: 'a warning', pass: true, warn: true, detail: 'looked odd' },
    { name: 'a skipped row', pass: null, detail: 'skipped' },
  ];
}
`;

test('a clean dist passes every core check; plugin rows are prefixed; WARN and SKIP rows never fail', async () => {
  const root = makeRoot({ validate: { newtab: PLUGIN } });
  goodDist(root);
  const r = await runVal(root);
  assert.equal(r.code, 0, r.text);
  assert.match(r.get('core: local src/href/url() references exist').detail, /^6 references$/);
  assert.equal(r.get('core: CSP lint').pass, true);
  assert.equal(r.get('core: safe glyphs only').pass, true);
  assert.equal(r.get('core: shipped URLs only name allowed hosts').pass, true, r.get('core: shipped URLs').detail);
  assert.equal(r.get('core: fonts/OFL.txt beside every fonts/*.ttf').pass, true);
  assert.equal(r.get('core: fonts/OFL.txt beside every fonts/*.ttf').detail, '1 font folder(s): dist/good/fonts/');
  // a.js ships the config's link host (example.org): allowed, and only counted (a real config's hosts are your own)
  assert.match(r.get('core: shipped URLs').detail, /, and 1 link host\(s\) from config\/user\.json \(not printed\)$/);
  assert.doesNotMatch(r.get('core: shipped URLs').detail, /example\.org/, 'the config\'s link hosts are never printed');
  assert.equal(r.get('core: config/user.json values').pass, true);
  assert.match(r.get('core: vendor/pixelclock matches SYNC.json').detail, /^17 files, clock commit/);
  assert.match(r.get('core: dist engine copies are byte identical to vendor').detail, /^3 copies$/);
  const drift = r.get('core: vendor/pixelclock matches the live clock repo');
  assert.equal(drift.pass, null);
  assert.match(drift.detail, /clock repo not found at .*no-clock-repo: not compared/);
  for (const n of ['exists', 'readJson', 'listFiles', 'pngSize', 'escape refused', 'config', 'glyph helper', 'lint helpers']) assert.equal(r.get(`newtab: ${n}`).pass, true, n);
  assert.equal(r.get('newtab: a warning').warn, true);
  assert.match(r.text, /\| WARN {3}\| newtab: a warning/);
  assert.match(r.text, /\| SKIP {3}\| newtab: a skipped row/);
  assert.match(r.text, /checks: \d+ PASS, 0 FAIL, 2 SKIP, 1 WARN/);
});

test('BOM, bad JSON, CRLF, invalid UTF-8, missing or escaping references FAIL', async () => {
  const root = makeRoot({ validate: { still: 'export async function validate() { throw new Error("plugin exploded"); }\n' } });
  const d = goodDist(root);
  put(d, 'bad/bom.json', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{"a":1}')]));
  put(d, 'bad/trailing.json', '{"a": 1,}\n');
  put(d, 'bad/crlf.css', 'a{}\r\nb{}\r\n');
  put(d, 'bad/page.html', '<script src="js/missing.js"></script><link href="../good/css/s.css" rel="stylesheet"><img src="/nope.png">\n');
  put(d, 'bad/latin1.txt', Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]));
  const r = await runVal(root);
  assert.equal(r.code, 1);
  const json = r.get('core: strict JSON parse (BOM = fail)');
  assert.equal(json.pass, false);
  assert.match(json.detail, /dist\/bad\/bom\.json: starts with a UTF-8 BOM/);
  assert.match(json.detail, /dist\/bad\/trailing\.json: invalid JSON/);
  const enc = r.get('core: text files are UTF-8 without BOM');
  assert.match(enc.detail, /dist\/bad\/bom\.json: UTF-8 BOM/);
  assert.match(enc.detail, /dist\/bad\/latin1\.txt: not valid UTF-8/);
  assert.match(r.get('core: text files use LF line endings').detail, /dist\/bad\/crlf\.css: CRLF/);
  const refs = r.get('core: local src/href/url() references exist').detail;
  assert.match(refs, /dist\/bad\/page\.html: src "js\/missing\.js" missing/);
  assert.match(refs, /dist\/bad\/page\.html: href "\.\.\/good\/css\/s\.css" escapes its package folder/);
  assert.match(refs, /dist\/bad\/page\.html: src "\/nope\.png" missing/);
  const crash = r.get('still: validator plugin');
  assert.equal(crash.pass, false);
  assert.match(crash.detail, /plugin exploded/);
});

test('fonts: a shipped font folder without OFL.txt FAILs; no fonts at all passes', async () => {
  const root = makeRoot();
  const d = goodDist(root);
  put(d, 'other/fonts/CascadiaMono-wght.ttf', Buffer.from([0, 1, 0, 0]));
  put(d, 'other/fonts/sub/extra.woff2', Buffer.from([0x77, 0x4f, 0x46, 0x32]));
  const r = await runVal(root);
  assert.equal(r.code, 1);
  const row = r.get('core: fonts/OFL.txt beside every fonts/*.ttf');
  assert.equal(row.pass, false);
  assert.match(row.detail, /^dist\/other\/fonts\/: CascadiaMono-wght\.ttf without OFL\.txt$/m);
  assert.match(row.detail, /^dist\/other\/fonts\/sub\/: extra\.woff2 without OFL\.txt$/m);
  assert.doesNotMatch(row.detail, /good/, 'the folder with its licence is fine');
  const empty = makeRoot();
  const none = await runVal(empty);
  assert.equal(none.get('core: fonts/OFL.txt beside every fonts/*.ttf').detail, 'no font files under dist/');
  assert.equal(none.get('core: fonts/OFL.txt beside every fonts/*.ttf').pass, true);
});

test('config: a missing config/user.json FAILs with what to do, and is not counted as a bad JSON file', async () => {
  const root = makeRoot();
  goodDist(root);
  fs.rmSync(path.join(root, 'config', 'user.json'));
  const r = await runVal(root);
  assert.equal(r.code, 1);
  const cfg = r.get('core: config/user.json values');
  assert.equal(cfg.pass, false);
  assert.match(cfg.detail, /^config\/user\.json is missing: copy config\/user\.example\.json to config\/user\.json/);
  assert.equal(r.get('core: strict JSON parse (BOM = fail)').pass, true);
  assert.doesNotMatch(r.text, /ENOENT/);
});

test('CSP lint: every HTML and JS rule fires on its sample and stays quiet on the safe twin', () => {
  const html = {
    'inline <script> body': ['<script>alert(1)</script>', '<script src="a.js"></script>'],
    'remote script': ['<script src="https://cdn.example/x.js"></script>', '<script src="js/x.js"></script>'],
    'remote script //': ['<script src="//cdn.example/x.js"></script>', '<script src="x.js"></script>'],
    'event handler attribute': ['<body onload="go()">', '<body data-onload="go()">'],
    'javascript: URL': ['<a href="javascript:go()">x</a>', '<a href="#go">x</a>'],
    'remote stylesheet': ['<link rel="stylesheet" href="https://fonts.example/x.css">', '<link rel="stylesheet" href="css/x.css">'],
  };
  for (const [what, [bad, good]] of Object.entries(html)) {
    const found = lintHtml(bad);
    assert.equal(found.length, 1, `${what}: ${JSON.stringify(found)}`);
    assert.match(found[0], new RegExp(what.replace(' //', '').split(' ')[0]), what);
    assert.deepEqual(lintHtml(good), [], `${what} (safe twin)`);
  }
  const js = {
    'eval(': ['eval(code);', 'evaluate(code);'],
    'new Function(': ['var f = new Function(a, b);', 'var f = function () { return 1; };'],
    'Function("...")': ['var f = Function("return 1");', 'var f = obj.Function;'],
    'string timer': ["setTimeout('tick()', 10);", 'setTimeout(tick, 10);'],
    'innerHTML/outerHTML': ['el.innerHTML = html;', 'el.textContent = text;'],
    insertAdjacentHTML: ["el.insertAdjacentHTML('beforeend', h);", 'el.append(node);'],
    'document.write': ['document.write("<p>");', 'document.title = "x";'],
    'javascript: URL': ["a.href = 'javascript:void(0)';", "a.href = '#';"],
    'remote import()': ["import('https://cdn.example/m.js');", "import('./m.js');"],
    'remote import': ["import x from 'https://cdn.example/m.js';", "import x from './m.js';"],
    importScripts: ["importScripts('w.js');", 'postMessage(1);'],
  };
  assert.deepEqual(Object.keys(js).sort(), JS_RULES.map((r) => r[1]).sort(), 'one sample per rule');
  for (const [what, [bad, good]] of Object.entries(js)) {
    const found = lintJs(`var ok = 1;\n${bad}\n`);
    assert.deepEqual(found, [`${what} (line 2)`], what);
    assert.deepEqual(lintJs(good), [], `${what} (safe twin)`);
  }
});

test('CSP lint, glyphs and URLs through runValidate: shipped code is checked, vendor copies and licences are exempt from glyphs', async () => {
  const root = makeRoot();
  const d = goodDist(root);
  put(d, 'good/js/evil.js', 'var x = eval("1");\n');
  put(d, 'good/js/text.js', "var s = 'ok █ then ✓ and ✓ and ☃';\n");
  put(d, 'good/js/net.js', "fetch('https://tracker.example/collect');\nnew WebSocket('wss://api.open-meteo.com/');\n");
  const r = await runVal(root);
  assert.equal(r.code, 1);
  assert.match(r.get('core: CSP lint').detail, /dist\/good\/js\/evil\.js: eval\( \(line 1\)/);
  const glyph = r.get('core: safe glyphs only');
  assert.match(glyph.detail, /dist\/good\/js\/text\.js: U\+2603 x1 \(first at 1:32\), U\+2713 x2 \(first at 1:20\)/);
  assert.doesNotMatch(glyph.detail, /OFL\.txt|U\+2588|pixelclock/);
  const urls = r.get('core: shipped URLs').detail;
  assert.match(urls, /dist\/good\/js\/net\.js:1: https:\/\/tracker\.example\/collect/);
  assert.match(urls, /dist\/good\/js\/net\.js:2: wss:\/\/api\.open-meteo\.com\//, 'websockets are always reported');
  assert.doesNotMatch(urls, /OFL|w3\.org|open-meteo\.com\/v1|pixelclock\.local|example\.org/);
  assert.equal(isVendorCopy('newtab/js/pixelclock/themes/autumn.js'), true);
  assert.equal(isVendorCopy('newtab/js/pcd-engine.js'), false);
  assert.deepEqual(foreignUrls('a "http://www.w3.org/2000/svg" b', []), []);
  assert.deepEqual(foreignUrls("x = 'https://evil.example/a.js'", ['open-meteo.com']).map((u) => u.host), ['evil.example']);
});

test('vendor: dist copies must equal vendor/, vendor/ must equal SYNC.json', async () => {
  const root = makeRoot();
  const d = goodDist(root);
  fs.appendFileSync(path.join(d, 'good', 'js', 'pixelclock', 'themes', 'autumn.js'), '// patched in dist\n');
  put(d, 'good/js/pixelclock/extra.js', 'var x;\n');
  fs.writeFileSync(path.join(root, 'vendor', 'pixelclock', 'simulator', 'schedule.js'), 'edited\n');
  const r = await runVal(root);
  assert.equal(r.code, 1);
  const copies = r.get('core: dist engine copies are byte identical to vendor').detail;
  assert.match(copies, /dist\/good\/js\/pixelclock\/themes\/autumn\.js: differs from vendor\/pixelclock\/simulator\/themes\/autumn\.js/);
  assert.match(copies, /dist\/good\/js\/pixelclock\/extra\.js: not a vendor file/);
  assert.match(r.get('core: vendor/pixelclock matches SYNC.json').detail, /simulator\/schedule\.js: \d+ bytes, SYNC\.json says 3296/);
});

test('drift against the clock repo is a WARN (read-only), identical is PASS', async () => {
  const root = makeRoot();
  goodDist(root);
  const clock = path.join(root, 'fake-clock');
  const sync = JSON.parse(fs.readFileSync(path.join(VENDOR, 'SYNC.json'), 'utf8'));
  for (const f of sync.files) put(clock, f.path, fs.readFileSync(path.join(VENDOR, ...f.path.split('/'))));
  const same = await runVal(root, { clockRepo: clock });
  assert.equal(same.code, 0, same.text);
  assert.match(same.get('core: vendor/pixelclock matches the live clock repo').detail, /^17 files identical \(clock commit unknown\)$/);
  fs.appendFileSync(path.join(clock, 'simulator', 'themes', 'summer.js'), '// newer\n');
  put(clock, 'simulator/themes/zzz.js', '// a new theme upstream\n');
  const drift = await runVal(root, { clockRepo: clock });
  assert.equal(drift.code, 0, 'a WARN does not fail the run');
  const row = drift.get('core: vendor/pixelclock matches the live clock repo');
  assert.equal(row.warn, true);
  assert.match(row.detail, /the clock repo changed since the last sync \(run node tools\/sync\.mjs\)/);
  assert.match(row.detail, /~ simulator\/themes\/summer\.js/);
  assert.match(row.detail, /\+ simulator\/themes\/zzz\.js/);
});

test('token contrast rows come from tools/lib/tokens.mjs when it provides contrastRows()', async () => {
  const lib = {
    'tokens.mjs': [
      'export async function contrastRows() {',
      "  return [{ token: 'text', against: 'bg', ratio: 14.9, min: 4.5, pass: true }, { token: 'frame', against: 'bg', ratio: 2.4, min: 3, pass: false }];",
      '}',
      '',
    ].join('\n'),
  };
  const root = makeRoot({ lib });
  goodDist(root);
  const r = await runVal(root);
  const row = r.get('core: token contrast');
  assert.equal(row.pass, false);
  assert.match(row.detail, /frame vs bg: 2\.40:1 < 3:1/);
});

test('helpers: reference extraction, local references, glyph scanning, report counts', () => {
  const refs = htmlRefs('<a href="x.html">x</a><script src=\'a.js\'></script><script>var s = "<img src=no.png>";</script><div style="background:url(bg.png)">');
  assert.deepEqual(refs.map((r) => r.ref), ['x.html', 'a.js', 'bg.png']);
  for (const nonLocal of ['https://open-meteo.com/', 'chrome-extension://abc/x', 'data:image/png;base64,AA', '#frag', '//cdn.example/x.js']) assert.equal(isLocalRef(nonLocal), false, nonLocal);
  assert.equal(isLocalRef('js/a.js'), true);
  const bad = scanGlyphs('a\tb\r\n✓ ╭─╮ · ☼');
  assert.deepEqual([...bad.keys()], [0x2713]);
  assert.deepEqual(bad.get(0x2713), { count: 1, line: 2, col: 1 });
  const rows = [{ name: 'a', pass: true }, { name: 'b', pass: false, detail: 'x\ny' }, { name: 'c', pass: null }, { name: 'd', pass: true, warn: true }];
  assert.deepEqual(summarize(rows), { total: 4, passed: 1, failed: 1, skipped: 1, warned: 1 });
  const text = formatReport(rows, { title: 'T' });
  assert.match(text, /\| FAIL {3}\| b /);
  assert.match(text, /Details:\n {2}\[FAIL\] b\n {4}y/);
  assert.match(text, /4 checks: 1 PASS, 1 FAIL, 1 SKIP, 1 WARN$/);
});
