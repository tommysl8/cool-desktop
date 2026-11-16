// node --test "tests/docs.test.mjs"
// The public docs, README.md, INSTALL.md and UNINSTALL.md, against the code and the config they describe: every
// command, path, file name, setting key, Lively label and terminal command in them has to exist, and they hold no
// placeholders, no links to files that are not published and nothing personal. Reads only: this test writes nothing
// and starts no process.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** The repo root: the nearest folder above this file that holds tools/install.mjs. */
const ROOT = (() => {
  let d = path.dirname(fileURLToPath(import.meta.url));
  for (;;) {
    if (fs.existsSync(path.join(d, 'tools', 'install.mjs'))) return d;
    const up = path.dirname(d);
    if (up === d) throw new Error('docs test: repo root not found');
    d = up;
  }
})();
const require = createRequire(import.meta.url);
const rel = (...p) => path.join(ROOT, ...p);
const imp = (p) => import(pathToFileURL(rel(...p.split('/'))).href);
const readText = (p) => fs.readFileSync(rel(...p.split('/')), 'utf8');
const readJson = (p) => JSON.parse(readText(p));

const glyphs = await imp('tools/lib/glyphs.mjs');
const { pngSize, decodePng, encodePng: encodePlainPng } = await imp('tools/lib/png.mjs');
const shots = await imp('tools/readme-shots.mjs');
const { berlinOffset, MOCK_WEATHER, mockForecast } = await imp('tools/lib/chrome.mjs');
const cfgLib = await imp('tools/lib/config.mjs');
const install = await imp('tools/install.mjs');
const build = await imp('tools/build.mjs');
const task = await imp('src/still/lib/task.mjs');
const stillEnv = await imp('src/still/lib/env.mjs');

/** The public docs, and the only Markdown files they may name. */
const PUBLIC = ['README.md', 'INSTALL.md', 'UNINSTALL.md'];
/** What of design/ the docs may name: the font and its licence, the colour tokens, the glyph atlas and the style tile. */
const DESIGN_FILES = ['design/fonts/', 'design/tokens.json', 'design/atlas/', 'design/style-tile.'];
/** External links the public docs may hold. */
const EXTERNAL_LINKS = ['https://open-meteo.com/', 'https://github.com/tommysl8/PixelClock'];
/** The pictures in docs/ and their exact sizes (tools/readme-shots.mjs draws them). */
const PICTURES = {
  'docs/newtab.png': [2560, 1600],
  'docs/wallpaper-night.png': [1920, 1080],
  'docs/wallpaper-day.png': [1920, 1080],
  'docs/still.png': [1920, 1080],
};
const EXAMPLE = readJson('config/user.example.json');
const MANIFEST = readJson('src/newtab/manifest.json');
const LIVELY_INFO = readJson('src/wallpaper/LivelyInfo.json');
const LOCALAPPDATA_DIR = `%LOCALAPPDATA%\\${install.FOLDER_NAME}`;
const STILL_DIR = `${LOCALAPPDATA_DIR}\\${install.STILL_DIR}`;
const NEWTAB_DIR = `${LOCALAPPDATA_DIR}\\${install.NEWTAB_DIR}`;

/**
 * Where the docs are read from: this repo, or PCD_DOCS_DIR (a folder with copies of them; it proves that broken
 * copies fail this test). Code, config and pictures always come from the repo.
 */
const DOCS_DIR = process.env.PCD_DOCS_DIR ? path.resolve(process.env.PCD_DOCS_DIR) : ROOT;

function readDoc(name) {
  const file = path.join(DOCS_DIR, name);
  if (!fs.existsSync(file)) return null;
  const buf = fs.readFileSync(file);
  const text = new TextDecoder('utf-8', { fatal: true }).decode(buf);
  return { name, buf, text };
}
const docs = Object.fromEntries(PUBLIC.map((n) => [n, readDoc(n)]));
const pub = () => PUBLIC.map((n) => docs[n]);
const README = () => docs['README.md'].text;
const INSTALL = () => docs['INSTALL.md'].text;
const UNINSTALL = () => docs['UNINSTALL.md'].text;

// ------------------------------------------------------------------------------------------------ markdown helpers

/** Lines with their number and whether they sit inside a ``` fence (fence lines count as inside). */
function lines(text) {
  const out = [];
  let fence = false;
  text.split('\n').forEach((line, i) => {
    if (/^\s*```/.test(line)) {
      fence = !fence;
      out.push({ n: i + 1, line, fence: true });
      return;
    }
    out.push({ n: i + 1, line, fence });
  });
  return out;
}

/** The text outside fences. */
const prose = (text) => lines(text).filter((l) => !l.fence).map((l) => l.line).join('\n');

/** Fenced blocks: [{ n, info, body: [lines] }]. */
function fences(text) {
  const out = [];
  let cur = null;
  text.split('\n').forEach((line, i) => {
    const m = /^\s*```(.*)$/.exec(line);
    if (m && !cur) { cur = { n: i + 1, info: m[1].trim(), body: [] }; return; }
    if (m && cur) { out.push(cur); cur = null; return; }
    if (cur) cur.body.push(line);
  });
  return out;
}

/** The text of the section under a heading that starts with `prefix` (up to the next heading of the same or a higher level). */
function section(text, prefix) {
  const ls = text.split('\n');
  const start = ls.findIndex((l) => /^#{2,3} /.test(l) && l.replace(/^#+ /, '').startsWith(prefix));
  if (start < 0) return null;
  const level = /^(#+)/.exec(ls[start])[1].length;
  let end = ls.length;
  for (let i = start + 1; i < ls.length; i++) {
    const h = /^(#+) /.exec(ls[i]);
    if (h && h[1].length <= level) { end = i; break; }
  }
  return ls.slice(start, end).join('\n');
}

function headings(text) {
  return lines(text).filter((l) => !l.fence).map((l) => /^(#{1,6}) (.+)$/.exec(l.line)).filter(Boolean).map((m) => ({ level: m[1].length, title: m[2].trim() }));
}

/** Numbered step blocks: [{ heading, steps: [{ num, text }] }]; indented lines continue the step above. */
function stepBlocks(text) {
  const blocks = [];
  let cur = null;
  let heading = '';
  for (const { line, fence } of lines(text)) {
    if (fence) { cur = null; continue; }
    const h = /^(#{1,6}) (.+)$/.exec(line);
    if (h) { heading = h[2]; cur = null; continue; }
    const m = /^(\d+)\. (.*)$/.exec(line);
    if (m) {
      if (!cur) { cur = { heading, steps: [] }; blocks.push(cur); }
      cur.steps.push({ num: Number(m[1]), text: m[2] });
      continue;
    }
    if (line.trim() === '') continue;
    if (cur && /^ {2,}\S/.test(line)) { cur.steps[cur.steps.length - 1].text += ' ' + line.trim(); continue; }
    cur = null;
  }
  return blocks;
}

/** Split a table row on unescaped pipes. */
function splitRow(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  const cells = [];
  let cur = '';
  for (let k = 0; k < s.length; k++) {
    if (s[k] === '\\' && s[k + 1] === '|') { cur += '|'; k++; continue; }
    if (s[k] === '|') { cells.push(cur.trim()); cur = ''; continue; }
    cur += s[k];
  }
  cells.push(cur.trim());
  return cells;
}

/** Tables: [{ header, rows }]. */
function tables(text) {
  const out = [];
  let cur = null;
  for (const { line, fence } of lines(text)) {
    if (!fence && line.startsWith('|')) {
      if (!cur) { cur = []; out.push(cur); }
      cur.push(splitRow(line));
    } else cur = null;
  }
  return out.map((t) => ({ header: t[0], rows: t.slice(2) }));
}

function tableWith(text, firstHeader) {
  const t = tables(text).filter((x) => x.header[0] === firstHeader);
  assert.equal(t.length, 1, `one table whose first column is "${firstHeader}"`);
  return t[0];
}

/** Inline code spans outside fences ("\|" read as "|"). */
function codeSpans(text) {
  const out = [];
  for (const { line, fence } of lines(text)) {
    if (fence) continue;
    for (const m of line.matchAll(/`([^`]+)`/g)) out.push(m[1].replace(/\\\|/g, '|'));
  }
  return out;
}

/** Code spans of a piece of text (a table cell, a step). */
const spansOf = (s) => [...String(s).matchAll(/`([^`]+)`/g)].map((m) => m[1]);
/** Bold spans outside fences. */
const bolds = (text) => [...prose(text).matchAll(/\*\*([^*]+)\*\*/g)].map((m) => m[1]);
/** Markdown links and images outside fences: [{ image, label, target }]. */
const links = (text) => [...prose(text).matchAll(/(!?)\[([^\]]*)\]\(([^)\s]+)\)/g)].map((m) => ({ image: m[1] === '!', label: m[2], target: m[3] }));
/** The rendered reading: a wrapped line reads as one space. */
const flat = (s) => s.replace(/[ ]*\n[ ]*/g, ' ');
const lc = (s) => String(s).toLowerCase();
/** A plain copy (values from a vm context carry that realm's prototypes, which deepStrictEqual compares). */
const plain = (v) => JSON.parse(JSON.stringify(v));
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const wordRe = (w) => new RegExp(`(^|[^a-z0-9])${escapeRe(lc(w))}($|[^a-z0-9])`);

// ------------------------------------------------------------------------------------------------ the code's own words

/** Classic UMD scripts in a fresh vm context, like a page loads them (one global PCD). */
function sandbox(files) {
  const ctx = { console };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  for (const f of files) vm.runInContext(readText(f), ctx, { filename: f });
  return ctx;
}
/** The clock's engine: engine.js, schedule.js and every theme, in a sandbox. */
function engine() {
  const themes = fs.readdirSync(rel('vendor', 'pixelclock', 'simulator', 'themes')).filter((f) => f.endsWith('.js')).sort();
  const ctx = sandbox(['vendor/pixelclock/simulator/engine.js', 'vendor/pixelclock/simulator/schedule.js', ...themes.map((t) => `vendor/pixelclock/simulator/themes/${t}`)]);
  return ctx.PixelClock;
}
const PC = engine();
const S = require(rel('src', 'newtab', 'js', 'ntp-settings.js'));
const P = require(rel('src', 'wallpaper', 'js', 'wp-props.js'));
const STATUS = require(rel('src', 'newtab', 'js', 'ntp-status.js'));
const PANEL = require(rel('src', 'newtab', 'js', 'ntp-panel.js'));
const GREET = require(rel('src', 'shared', 'pcd-greet.js'));
/** The theme menu the wallpaper builds its Theme dropdown from: auto, the seasons, then the holidays. */
const MENU = (() => {
  const ctx = sandbox(['vendor/pixelclock/simulator/engine.js', 'vendor/pixelclock/simulator/schedule.js',
    ...fs.readdirSync(rel('vendor', 'pixelclock', 'simulator', 'themes')).filter((f) => f.endsWith('.js')).sort().map((t) => `vendor/pixelclock/simulator/themes/${t}`),
    'src/shared/pcd-engine.js']);
  return JSON.parse(JSON.stringify(ctx.PCD.engine.menu(ctx.PixelClock)));
})();

/**
 * The new tab's terminal commands: the 'commands.js' module of src/newtab/js/term (classic scripts that register
 * their modules in PCD.termDefs; term-shell.js's lib() instantiates them the same way). null while it is missing.
 */
function terminal() {
  const dir = 'src/newtab/js/term';
  if (!fs.existsSync(rel(...dir.split('/'), 'term-commands.js'))) return null;
  const libs = fs.existsSync(rel(...dir.split('/'), 'lib')) ? fs.readdirSync(rel(...dir.split('/'), 'lib')).filter((f) => f.endsWith('.js')).sort().map((f) => `${dir}/lib/${f}`) : [];
  const ctx = sandbox([...libs, `${dir}/term-commands.js`]);
  const defs = (ctx.PCD && ctx.PCD.termDefs) || {};
  const cache = Object.create(null);
  const lib = (name) => {
    const key = String(name).replace(/^\.\//, '');
    if (cache[key]) return cache[key].exports;
    if (typeof defs[key] !== 'function') throw new Error(`terminal module ${key} is not loaded`);
    const mod = { exports: {} };
    cache[key] = mod;
    defs[key](lib, mod.exports);
    return mod.exports;
  };
  const mod = lib('commands.js');
  if (!mod || !Array.isArray(mod.BUILTINS)) return null;
  return { file: rel(...dir.split('/'), 'term-commands.js'), mod, names: new Set(mod.BUILTINS.flatMap((d) => [d.name, ...(d.aliases || [])])) };
}
const TERMINAL = terminal();
/** The new tab's own source text (every .js under src/newtab), for keys and messages. */
const NEWTAB_JS = (() => {
  const out = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.m?js$/.test(e.name)) out.push(fs.readFileSync(p, 'utf8'));
    }
  };
  walk(rel('src', 'newtab'));
  return out.join('\n');
})();

/** Your own answers, when config/user.json is here (never published): used only to prove the docs hold none of them. */
const OWN = (() => {
  const file = rel('config', 'user.json');
  if (!fs.existsSync(file)) return null;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
})();

// ------------------------------------------------------------------------------------------------ the checkers on synthetic input

test('checkers: fences, sections, steps, tables, spans and links parse as expected', () => {
  const md = '# T\n\n```text\n1. not a step\n`no`\n```\n\n## 1. A\n\n1. one. You see x.\n2. two\n   wrapped, you see y.\n\n### sub\n\nin a\n\n## 2. B\n\n| a | b |\n|---|---|\n| `c \\| d` | **e** |\n\n![p](docs/x.png) [l](INSTALL.md)\n';
  assert.deepEqual(fences(md).map((f) => f.body), [['1. not a step', '`no`']]);
  assert.match(section(md, '1. A'), /in a/);
  assert.doesNotMatch(section(md, '1. A'), /\| a \|/);
  const b = stepBlocks(md);
  assert.equal(b.length, 1);
  assert.deepEqual(b[0].steps.map((s) => s.num), [1, 2]);
  assert.match(b[0].steps[1].text, /wrapped, you see y/);
  assert.deepEqual(tables(md)[0].rows, [['`c | d`', '**e**']]);
  assert.deepEqual(codeSpans(md), ['c | d']);
  assert.deepEqual(bolds(md), ['e']);
  assert.deepEqual(links(md).map((l) => [l.image, l.target]), [[true, 'docs/x.png'], [false, 'INSTALL.md']]);
  assert.ok(wordRe('map').test('a map.') && !wordRe('map').test('maps'));
});

// ------------------------------------------------------------------------------------------------ every doc

test('docs: README, INSTALL and UNINSTALL are here; every doc is UTF-8 without BOM, LF, no tabs or trailing spaces', () => {
  for (const name of PUBLIC) assert.ok(docs[name], `${name} exists`);
  for (const d of Object.values(docs).filter(Boolean)) {
    assert.ok(!(d.buf[0] === 0xef && d.buf[1] === 0xbb && d.buf[2] === 0xbf), `${d.name}: no BOM`);
    assert.ok(!d.text.includes('\r'), `${d.name}: LF line endings only`);
    assert.ok(!d.text.includes('\t'), `${d.name}: no tabs`);
    assert.ok(d.text.endsWith('\n') && !d.text.endsWith('\n\n'), `${d.name}: ends with exactly one newline`);
    const trailing = d.text.split('\n').map((l, i) => (/ +$/.test(l) ? i + 1 : 0)).filter(Boolean);
    assert.deepEqual(trailing, [], `${d.name}: lines with trailing spaces`);
  }
});

test('docs: only the safe glyphs (the characters the pieces themselves may draw)', () => {
  for (const d of Object.values(docs).filter(Boolean)) assert.deepEqual(glyphs.unsafeChars(d.text), [], `${d.name}: characters outside the safe set`);
});

test('docs: no placeholders', () => {
  const placeholder = /\b(TODO|TBD|FIXME|XXX)\b|lorem ipsum|\.\.\.|\?\?\?|\{\{|\}\}|<[a-z][a-z _-]*>|\byour[-_ ]?(name|city)[-_ ]?here\b/i;
  for (const d of Object.values(docs).filter(Boolean)) {
    d.text.split('\n').forEach((line, i) => assert.doesNotMatch(line, placeholder, `${d.name}:${i + 1}: a placeholder`));
  }
});

/** Folders that .gitignore keeps out of the repo, except dist/ (the build makes it). */
const IGNORED_DIRS = readText('.gitignore').split('\n').map((l) => l.trim()).filter((l) => /^[\w.-]+\/$/.test(l) && l !== 'dist/');

/** Why a path the docs name would not be in a clone of the repo ('' when it is fine). */
function unpublished(p) {
  const s = p.replace(/\\/g, '/').replace(/^\.\//, '');
  if (s.startsWith('design/') && s !== 'design/' && !DESIGN_FILES.some((f) => s.startsWith(f))) return 'a part of design/ that is not published';
  if (/\.md$/i.test(s) && !PUBLIC.includes(s)) return 'a Markdown file that is not published';
  if (IGNORED_DIRS.some((d) => s.startsWith(d))) return 'a folder that .gitignore keeps out';
  return '';
}

test('docs: the public docs name only published files', () => {
  assert.ok(IGNORED_DIRS.includes('wip/'), '.gitignore keeps wip/ out');
  assert.equal(unpublished('design/fonts/OFL.txt'), '');
  assert.equal(unpublished('design/'), '');
  assert.notEqual(unpublished('design/notes.md'), '');
  assert.notEqual(unpublished('NOTES.md'), '');
  assert.notEqual(unpublished('wip/x.png'), '');
  for (const d of pub()) {
    const named = [
      ...[...d.text.matchAll(/(?<![\w.\/-])design\/[\w.\/-]*/g)].map((m) => m[0]),
      ...[...d.text.matchAll(/(?<![\w.\/-])[\w.\/-]+\.md\b/g)].map((m) => m[0]),
      ...IGNORED_DIRS.filter((dir) => new RegExp(`(^|[^\\w.-])${escapeRe(dir)}`).test(d.text)),
    ];
    for (const p of named) assert.equal(unpublished(p), '', `${d.name} names ${p}`);
  }
});

test('docs: every link resolves to a published file, or to an allowed web page', () => {
  for (const d of pub()) {
    for (const l of links(d.text)) {
      if (/^[a-z]+:/i.test(l.target)) {
        assert.ok(EXTERNAL_LINKS.includes(l.target), `${d.name}: external link ${l.target}`);
        continue;
      }
      const target = l.target.split('#')[0];
      assert.ok(fs.existsSync(rel(...target.split('/'))), `${d.name}: ${l.target} does not exist`);
      assert.equal(unpublished(target), '', `${d.name}: ${l.target} is not published`);
    }
  }
});

test('docs: nothing personal (no user folder, user name, own city or own links)', () => {
  const user = (() => { try { return os.userInfo().username; } catch { return ''; } })();
  const home = os.homedir();
  const needles = [];
  // account names that are ordinary words (Windows' own defaults among them) are not personal
  const commonNames = new Set(['user', 'users', 'admin', 'administrator', 'owner', 'runner', 'home', 'guest', 'default', 'public']);
  if (user && user.length >= 3 && !commonNames.has(lc(user))) needles.push({ what: 'the user name', re: wordRe(user) });
  if (home) needles.push({ what: 'the home folder', re: new RegExp(escapeRe(lc(home))) });
  if (OWN) {
    const city = typeof OWN.city === 'string' ? OWN.city.trim() : '';
    if (city.length >= 3 && lc(city) !== lc(EXAMPLE.city)) {
      needles.push({ what: 'the configured city', re: wordRe(city) });
      const first = city.split(',')[0].trim();
      if (first.length >= 3) needles.push({ what: 'the configured city', re: wordRe(first) });
    }
    // big sites and the words the terminal's own help uses (search google, youtube, github ...) are not personal
    const generic = new Set(['www', 'com', 'org', 'net', 'edu', 'gov', 'io', 'app', 'dev', 'co', 'uk', 'de', 'html', 'http', 'https', 'index',
      'google', 'youtube', 'github', 'wikipedia', 'openstreetmap']);
    if (TERMINAL) for (const def of TERMINAL.mod.BUILTINS) for (const w of `${def.help || ''} ${def.usage || ''}`.toLowerCase().split(/[^a-z0-9]+/)) generic.add(w);
    const exampleLabels = new Set((EXAMPLE.shortcuts || []).map((s) => lc(s.label)));
    (Array.isArray(OWN.shortcuts) ? OWN.shortcuts : []).forEach((s, i) => {
      if (!s || typeof s.url !== 'string') return;
      if ((EXAMPLE.shortcuts || []).some((e) => e.url === s.url)) return;
      let u = null;
      try { u = new URL(s.url); } catch { /* not an address: looked for as it is */ }
      // a big site's front page is not personal, and the docs may link deeper into that site
      const bigFront = !!u && !u.search && !u.hash && /^\/?$/.test(u.pathname) && /^(www\.)?(google|youtube|github|wikipedia|openstreetmap)\.(com|org)$/.test(u.hostname);
      if (!bigFront) needles.push({ what: `shortcut ${i + 1}'s address`, re: new RegExp(escapeRe(lc(s.url.replace(/\/+$/, '')))) });
      if (!u) return;
      const parts = [...u.hostname.split('.'), ...u.pathname.split('/')].map(lc).filter((w) => w.length >= 4 && !generic.has(w));
      for (const w of parts) needles.push({ what: `a word from shortcut ${i + 1}'s address`, re: wordRe(w) });
      if (typeof s.label === 'string' && s.label.length >= 3 && !exampleLabels.has(lc(s.label)) && !generic.has(lc(s.label))) needles.push({ what: `shortcut ${i + 1}'s label`, re: wordRe(s.label) });
    });
  }
  for (const d of Object.values(docs).filter(Boolean)) {
    assert.doesNotMatch(d.text, /[A-Za-z]:\\Users\\/i, `${d.name}: a path inside a user folder`);
    for (const n of needles) assert.ok(!n.re.test(lc(d.text)), `${d.name} contains ${n.what}`);
  }
});

// ------------------------------------------------------------------------------------------------ README

test('README: the welcome is drawn with the clock\'s own 3x5 digits; greeting, date and links fit it', () => {
  const block = fences(README())[0];
  assert.ok(block, 'README starts with a fenced welcome');
  const art = block.body;
  // the big clock: five rows, every lit pixel two characters wide, digits one pixel apart
  const rows = art.slice(0, 5);
  const width = Math.max(...rows.map((r) => r.length));
  const px = rows.map((r) => r.padEnd(width, ' '));
  for (const r of px) assert.match(r, /^(██|  )+$/, `clock row "${r}": only lit pixels (two full blocks) and gaps`);
  const lit = (x, y) => px[y].slice(2 * x, 2 * x + 2) === '██';
  const W = width / 2;
  const digits = [];
  for (let d = 0; d <= 9; d++) {
    const cv = new PC.Canvas(3, 5);
    PC.drawDigit(cv, d, 0, 0, 1, 1);
    digits.push([...cv.px].map((v) => (v ? 1 : 0)).join(''));
  }
  const read = [];
  for (let x = 0; x < W;) {
    const col = (cx) => [0, 1, 2, 3, 4].map((y) => (cx < W && lit(cx, y) ? 1 : 0));
    const c0 = col(x);
    if (c0.join('') === '01010') { read.push(':'); x += 2; continue; }
    const bits = [0, 1, 2, 3, 4].map((y) => [0, 1, 2].map((dx) => (x + dx < W && lit(x + dx, y) ? 1 : 0)).join('')).join('');
    const d = digits.indexOf(bits);
    assert.ok(d >= 0, `pixels at column ${x} are not one of the clock's digits`);
    read.push(String(d));
    x += 4;
  }
  const time = read.join('');
  assert.match(time, /^\d{1,2}:\d\d$/, `the welcome clock reads ${time}`);
  assert.equal(time, shots.SHOTS.find((s) => s.name === 'newtab').at.slice(11, 16), 'the welcome shows the moment of the new tab picture');
  const [h, m] = time.split(':').map(Number);
  assert.ok(h <= 23 && m <= 59, time);
  // then a blank line, the greeting for that hour, the date as the column writes it
  assert.equal(art[5], '', 'a blank line under the clock');
  const hour = EXAMPLE.clock === '24h' ? h : h; // 12 h faces would carry am/pm; the welcome uses the example's clock
  assert.equal(EXAMPLE.clock, '24h', 'the welcome follows the example config (24 h)');
  assert.equal(art[6], `${GREET.word(hour)}.`, 'the greeting for that hour');
  assert.match(art[7], /^(sun|mon|tue|wed|thu|fri|sat) (jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec) \d{1,2}$/, 'the date as the column writes it');
  // the numbered links are the example config's, in order
  const linkLine = art.find((l) => l.startsWith('[1] '));
  assert.ok(linkLine, 'a line of numbered links');
  const labels = [...linkLine.matchAll(/\[(\d)\] (\S+)/g)].map((x) => [Number(x[1]), x[2]]);
  assert.deepEqual(labels, EXAMPLE.shortcuts.slice(0, 9).map((s, i) => [i + 1, s.label]));
  // the terminal rule and a prompt with a real command
  assert.ok(art.some((l) => /^── terminal ─+$/.test(l)), 'the "── terminal ───" rule');
  const prompt = art.find((l) => l.startsWith('› '));
  assert.ok(prompt, 'a prompt line');
  const cmd = prompt.slice(2).trim();
  const m2 = /^theme (.+)$/.exec(cmd);
  assert.ok(m2, `the prompt types a theme command (${cmd})`);
  assert.ok(PC.themes.some((t) => lc(t.name) === m2[1] || t.id === m2[1]), `"${m2[1]}" is a scene of the clock`);
});

test('README: the pictures are the four shots in docs/, at their sizes, and each is used once', () => {
  const imgs = links(README()).filter((l) => l.image).map((l) => l.target);
  assert.deepEqual([...imgs].sort(), Object.keys(PICTURES).sort());
  for (const [file, [w, h]] of Object.entries(PICTURES)) {
    assert.ok(fs.existsSync(rel(...file.split('/'))), `${file} exists (node tools/readme-shots.mjs draws it)`);
    const size = pngSize(fs.readFileSync(rel(...file.split('/'))));
    assert.deepEqual([size.width, size.height], [w, h], `${file} size`);
  }
  const extra = fs.existsSync(rel('docs')) ? fs.readdirSync(rel('docs')).filter((f) => !Object.keys(PICTURES).includes(`docs/${f}`)) : [];
  assert.deepEqual(extra, [], 'docs/ holds only the README pictures');
  for (const l of links(README()).filter((x) => x.image)) assert.ok(l.label.length >= 10, `${l.target} has a description`);
});

test('README pictures: every picture README shows is a PNG in docs/ of at most MAX_BYTES (tools/readme-shots.mjs)', () => {
  assert.ok(Number.isInteger(shots.MAX_BYTES) && shots.MAX_BYTES > 0, 'tools/readme-shots.mjs exports MAX_BYTES');
  const imgs = links(README()).filter((l) => l.image).map((l) => l.target);
  assert.ok(imgs.length > 0, 'README shows pictures');
  for (const target of imgs) {
    assert.match(target, /^docs\/[\w.-]+\.png$/, `${target} is a PNG in docs/`);
    const file = rel(...target.split('/'));
    assert.ok(fs.existsSync(file), `${target} exists (node tools/readme-shots.mjs draws it)`);
    const bytes = fs.statSync(file).size;
    assert.ok(bytes <= shots.MAX_BYTES, `${target} is ${bytes} bytes, over ${shots.MAX_BYTES} (node tools/readme-shots.mjs draws it again)`);
  }
});

test('README pictures: tools/readme-shots.mjs draws exactly them, in Berlin time, the new tab at the welcome\'s moment', () => {
  assert.deepEqual(Object.fromEntries(shots.SHOTS.map((s) => [`${shots.OUT_DIR}/${s.file}`, [s.css[0] * s.dpr, s.css[1] * s.dpr]])), PICTURES);
  assert.equal(shots.TIME_ZONE, 'Europe/Berlin');
  assert.equal(EXAMPLE.city, 'Berlin', 'the pictures use the example config, whose city is the sample city');
  // Berlin wall time to epoch: CET in winter, CEST in summer
  assert.equal(shots.berlinMs('2026-11-15T20:40:00', berlinOffset), Date.UTC(2026, 10, 15, 19, 40));
  assert.equal(shots.berlinMs('2026-07-01T12:00:00', berlinOffset), Date.UTC(2026, 6, 1, 10, 0));
  // the page clock: Date moves to the shot's moment and runs on; explicit dates and Date.UTC are untouched
  const ctx = { console };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  const ms = Date.UTC(2026, 10, 15, 19, 40);
  vm.runInContext(`globalThis.Date = Date; ${shots.dateShim(ms)}`, ctx);
  const got = vm.runInContext('[Date.now(), new Date().getTime(), new Date(0).getTime(), Date.UTC(2000, 0, 1), new Date() instanceof Date, typeof Date()]', ctx);
  assert.ok(Math.abs(got[0] - ms) < 5000 && Math.abs(got[1] - ms) < 5000, 'now is the shot moment');
  assert.deepEqual(plain(got.slice(2)), [0, Date.UTC(2000, 0, 1), true, 'string']);
  // the new tab picture shows the welcome's time and date
  const nt = shots.SHOTS.find((s) => s.name === 'newtab');
  const art = fences(README())[0].body;
  const [d, t] = nt.at.split('T');
  const [y, mo, da] = d.split('-').map(Number);
  const wd = new Date(Date.UTC(y, mo - 1, da)).getUTCDay();
  assert.equal(art[7], `${['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'][wd]} ${['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'][mo - 1]} ${da}`);
  assert.equal(art[6], `${GREET.word(Number(t.slice(0, 2)))}.`);
  assert.deepEqual(shots.parseArgs(['--only', 'still,newtab', '--out', 'x']).only, ['still', 'newtab']);
  assert.ok(shots.parseArgs(['--only', 'nope']).errors.length === 1);
  // each picture has a day of its own: a high and a low around the temperature it shows, and no two alike; the
  // canned forecast answers with them
  for (const s of shots.SHOTS) {
    const now = s.weather.temperature_2m ?? MOCK_WEATHER.C.temperature_2m;
    assert.ok(Number.isFinite(s.weather.max) && Number.isFinite(s.weather.min), `${s.name}: a high and a low`);
    assert.ok(s.weather.min <= now && now <= s.weather.max, `${s.name}: ${s.weather.min} <= ${now} <= ${s.weather.max}`);
    const f = mockForecast('C', { now: shots.berlinMs(s.at, berlinOffset), overrides: s.weather });
    assert.deepEqual([f.daily.temperature_2m_max[0], f.daily.temperature_2m_min[0], f.current.temperature_2m], [s.weather.max, s.weather.min, now], `${s.name}: the forecast the page gets`);
  }
  assert.equal(new Set(shots.SHOTS.map((s) => `${Math.round(s.weather.max)}/${Math.round(s.weather.min)}`)).size, shots.SHOTS.length, 'no two pictures share a high and a low');
});

test('README pictures: compactPng keeps every pixel, drops an alpha channel nothing uses and makes the file smaller', () => {
  const [w, h] = [96, 40];
  const rgba = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const block = (Math.floor(x / 8) + Math.floor(y / 8)) % 3; // flat 8 x 8 blocks, like the scene
      rgba.set([20 + block * 40, 16 + block * 30, 22 + (x % 5), 255], i);
    }
  }
  const plainPng = encodePlainPng({ width: w, height: h, data: rgba, channels: 4 });
  const small = shots.compactPng(plainPng);
  assert.deepEqual(decodePng(small).data, rgba, 'the same pixels');
  assert.equal(pngSize(small).colorType, 2, 'RGB: nothing was transparent');
  assert.ok(small.length < plainPng.length, `${small.length} < ${plainPng.length} bytes`);
  rgba[3] = 128; // one see-through pixel keeps the alpha channel
  const withAlpha = shots.compactPng(encodePlainPng({ width: w, height: h, data: rgba, channels: 4 }));
  assert.equal(pngSize(withAlpha).colorType, 6);
  assert.deepEqual(decodePng(withAlpha).data, rgba);
  assert.ok(shots.MAX_BYTES <= 1000 * 1000, 'README pictures stay under 1 MB');
});

test('README: what it is, the three pieces, the engine, install, privacy, credits and the licence', () => {
  const t = flat(README());
  // the repo's name on top, then the name Chrome and Lively show
  assert.match(README(), /^# cool-desktop\n/);
  assert.equal(MANIFEST.name, 'PixelClock Desktop');
  assert.equal(LIVELY_INFO.Title, MANIFEST.name);
  assert.ok(README().split('\n').includes(`In Chrome and Lively it shows up as ${MANIFEST.name}.`), 'the line with the name Chrome and Lively show');
  for (const s of ['`vendor/pixelclock`', 'Chrome new tab', 'Lively Wallpaper', 'still wallpaper', 'every 15 minutes', '[INSTALL.md](INSTALL.md)', '[UNINSTALL.md](UNINSTALL.md)',
    '[PixelClock](https://github.com/tommysl8/PixelClock)', 'Open-Meteo', '`http://pixelclock.local`', 'CC BY 4.0', 'Cascadia Mono', 'SIL Open Font License 1.1', '`design/fonts/OFL.txt`']) {
    assert.ok(t.includes(s), `README mentions ${s}`);
  }
  // the version of Node.js the docs ask for runs the tests (the quoted glob needs 21 or newer)
  const node = /Node\.js (\d+) or newer/.exec(t);
  assert.ok(node, 'README says which Node.js');
  assert.ok(flat(INSTALL()).includes(`Node.js ${node[1]} or newer`), 'INSTALL asks for the same Node.js');
  assert.ok(Number(node[1]) >= 21);
  assert.ok(fs.readFileSync(rel('design', 'fonts', 'OFL.txt'), 'utf8').includes('SIL Open Font License, Version 1.1'), 'the font licence is OFL 1.1');
  assert.ok(fs.readFileSync(rel('design', 'fonts', 'OFL.txt'), 'utf8').includes('Microsoft Corporation'), 'Cascadia Mono is Microsoft\'s');
  // the project's licence is MIT (LICENSE), and README says so; the font keeps its own
  const license = fs.readFileSync(rel('LICENSE'), 'utf8');
  assert.match(license, /^MIT License\n/);
  assert.ok(license.includes('Permission is hereby granted, free of charge'), 'the MIT text');
  const licence = flat(section(README(), 'Licence') || '');
  assert.ok(licence.includes('MIT (see [LICENSE](LICENSE))'), 'README names the licence and links LICENSE');
  assert.ok(licence.includes('SIL Open Font License 1.1') && licence.includes('`design/fonts/OFL.txt`'), 'the font keeps its own licence');
  // the still is drawn every 15 minutes: the task repeats every 15 minutes
  const xml = task.taskXml({ stillDir: 'C:\\X\\still', userSid: 'S-1-5-21-1-2-3-1001', date: new Date(2026, 10, 15) });
  assert.match(xml, /<Interval>PT15M<\/Interval>/);
});

test('README: the privacy line matches the code: only the weather client and the clock status fetch anything', () => {
  const line = flat(section(README(), 'Privacy'));
  assert.match(line, /only talks to Open-Meteo/);
  assert.match(line, /your PixelClock on the local network/);
  assert.match(line, /sunrise and sunset/);
  assert.match(line, /Chrome's synced storage/);
  assert.match(readText('src/newtab/js/ntp-store.js'), /chrome\.storage\.sync/, 'the new tab keeps its settings in Chrome\'s synced storage');
  const allowed = new Set(['src/shared/pcd-weather.js', 'src/newtab/js/ntp-status.js']);
  const offenders = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!/\.m?js$/.test(e.name)) continue;
      const r = path.relative(ROOT, p).split(path.sep).join('/');
      const text = fs.readFileSync(p, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
      if (/(^|[^.\w])fetch\s*\(|XMLHttpRequest|sendBeacon|new\s+WebSocket|new\s+EventSource/.test(text) && !allowed.has(r)) offenders.push(r);
    }
  };
  walk(rel('src'));
  assert.deepEqual(offenders, [], 'network calls outside the weather client and the clock status');
  assert.match(readText('src/newtab/js/ntp-status.js'), /http:\/\/pixelclock\.local\/api\/status/);
  assert.match(readText('src/shared/pcd-weather.js'), /api\.open-meteo\.com/);
});

test('README: the seasons and holidays are the clock\'s own scenes', () => {
  const t = lc(flat(section(README(), 'What it does')));
  const HOLIDAY_WORDS = {
    newyear: "new year's eve", lunarnewyear: 'lunar new year', valentines: "valentine's day", stpatricks: "st. patrick's day",
    easter: 'easter', july4: 'fourth of july', halloween: 'halloween', thanksgiving: 'thanksgiving', christmas: 'christmas',
  };
  const seasons = plain(PC.themes.filter((th) => th.kind === 'season').map((th) => ({ id: th.id, name: th.name })));
  const holidays = plain(PC.themes.filter((th) => th.kind !== 'season').map((th) => th.id));
  assert.equal(seasons.length, 4);
  for (const th of seasons) assert.ok(t.includes(lc(th.name)), `README names the season scene "${lc(th.name)}"`);
  assert.deepEqual(holidays.sort(), Object.keys(HOLIDAY_WORDS).sort(), 'every holiday scene of the clock is named in README');
  for (const [id, words] of Object.entries(HOLIDAY_WORDS)) assert.ok(t.includes(words), `README names ${id} as "${words}"`);
  assert.deepEqual(plain(PC.HOLIDAYS.map((x) => x.id)).sort(), Object.keys(HOLIDAY_WORDS).sort());
  // the phases and the hourly shake are the code's
  const sun = require(rel('src', 'shared', 'pcd-sun.js'));
  for (const ph of sun.PHASES) assert.ok(t.includes(ph), `README names the phase "${ph}"`);
  assert.ok(t.includes('on the hour, from 10 am to midnight'));
  assert.ok(Object.values(P.TEXTS).includes('Surprise on the hour (10 am to midnight)'), 'the wallpaper has the hourly shake');
});

test('README: every terminal command and key in the tables is the new tab\'s own', { skip: TERMINAL ? false : 'the new tab has no command table yet' }, () => {
  const sec = section(README(), 'The terminal');
  const cmds = tableWith(sec, 'type');
  const words = new Set();
  for (const row of cmds.rows) {
    for (const span of spansOf(row[0])) {
      if (/^\d$/.test(span) || span === '&' || /\./.test(span) && !/\s/.test(span)) continue; // digits, the & suffix, an address
      words.add(span.split(/\s+/)[0]);
    }
  }
  const missing = [...words].filter((w) => !TERMINAL.names.has(w));
  assert.deepEqual(missing, [], `commands the new tab does not have (${path.relative(ROOT, TERMINAL.file)})`);
  // the theme examples are real scenes or subcommands
  for (const span of spansOf(sec)) {
    const m = /^theme (.+)$/.exec(span);
    if (m) assert.ok(['list', 'auto'].includes(m[1]) || PC.themes.some((t) => lc(t.name) === m[1] || t.id === m[1]), `theme ${m[1]}`);
  }
  const keys = tableWith(sec, 'key');
  const handled = { '↑ and ↓': ['ArrowUp', 'ArrowDown'], Tab: ['Tab'], Esc: ['Escape'] };
  assert.deepEqual(keys.rows.map((r) => r[0]), Object.keys(handled));
  for (const [k, names] of Object.entries(handled)) for (const n of names) assert.ok(NEWTAB_JS.includes(`'${n}'`) || NEWTAB_JS.includes(`"${n}"`), `the new tab handles ${k} (${n})`);
});

test('README: the build commands are real, with real flags', async () => {
  const block = fences(README()).find((f) => f.body.some((l) => l.startsWith('node ')));
  assert.ok(block, 'a block of build commands');
  for (const line of block.body.filter((l) => l.startsWith('node '))) checkCommand(line.split(/ {2,}/)[0].trim(), 'README');
  for (const span of codeSpans(README()).filter((s) => s.startsWith('node '))) checkCommand(span, 'README');
  // where the engine comes from, as the sync says
  const sync = await imp('tools/sync.mjs');
  const text = block.body.join('\n');
  assert.ok(text.includes(sync.SOURCE_ENV), `README names ${sync.SOURCE_ENV}`);
  assert.equal(sync.defaultSource({}, ROOT), path.resolve(ROOT, '..', 'PixelClock'));
  assert.ok(text.includes('../PixelClock') && text.includes('vendor/pixelclock'));
  assert.equal(path.relative(ROOT, sync.VENDOR_DIR).split(path.sep).join('/'), 'vendor/pixelclock');
  // a clone with no PixelClock checkout next to it builds from vendor/pixelclock, as README and INSTALL say (a stub
  // stands in for the sync; nothing is copied)
  assert.match(flat(INSTALL()), /otherwise it builds from the copy in `vendor\/pixelclock`/);
  let synced = 0;
  const alone = await build.defaultSync({ log: () => {}, env: {}, root: path.join(os.tmpdir(), 'pcd-docs-never-created', 'cool-desktop'), run: async () => { synced++; return { code: 0 }; } });
  assert.deepEqual([alone.code, synced], [0, 0], 'no checkout: the build goes on from vendor/pixelclock');
  await build.defaultSync({ log: () => {}, env: { [sync.SOURCE_ENV]: path.join(os.tmpdir(), 'pcd-docs-never-created', 'PixelClock') }, root: ROOT, run: async () => { synced++; return { code: 0 }; } });
  assert.equal(synced, 1, `${sync.SOURCE_ENV} asks for the refresh`);
});

test('README: the folder map lists real folders', () => {
  const block = fences(README()).find((f) => f.body.some((l) => l.startsWith('vendor/pixelclock/')));
  assert.ok(block, 'a folder map');
  for (const line of block.body) {
    const p = line.split(/ {2,}/)[0].trim();
    assert.ok(fs.existsSync(rel(...p.split('/').filter(Boolean))), `${p} exists`);
  }
});

// ------------------------------------------------------------------------------------------------ commands and paths

/** A `node ...` command: the script exists and every flag is one it knows. */
function checkCommand(cmd, where) {
  const words = cmd.match(/"[^"]*"|\S+/g);
  assert.equal(words[0], 'node', `${where}: ${cmd}`);
  if (words[1] === '--test') {
    assert.equal(cmd, 'node --test "tests/*.test.mjs"', `${where}: the unit tests run with the quoted glob`);
    return;
  }
  const script = words[1].replace(/^"|"$/g, '');
  let file;
  if (script.startsWith('%LOCALAPPDATA%')) {
    assert.equal(script, `${STILL_DIR}\\${task.SCRIPT_FILE}`, `${where}: ${cmd}`);
    file = rel('src', 'still', task.SCRIPT_FILE);
  } else {
    file = rel(...script.split(/[\\/]/));
    assert.ok(/^tools\/[\w-]+\.mjs$/.test(script.replace(/\\/g, '/')), `${where}: ${script} is a tool in tools/`);
  }
  assert.ok(fs.existsSync(file), `${where}: ${script} exists`);
  const text = fs.readFileSync(file, 'utf8');
  for (const flag of words.slice(2).filter((w) => w.startsWith('--'))) assert.ok(text.includes(`'${flag}'`) || text.includes(`"${flag}"`) || text.includes(`${flag} `), `${where}: ${script} knows ${flag}`);
  for (const arg of words.slice(2).filter((w) => !w.startsWith('--'))) assert.ok(build.PIECES.includes(arg), `${where}: ${arg} is a piece`);
}

/** A path in the docs, Windows or posix: where it lives, or what makes it. */
function checkPath(p, where) {
  const norm = p.replace(/\\/g, '/').replace(/\/$/, '');
  if (norm.startsWith('%LOCALAPPDATA%/')) {
    const parts = norm.split('/');
    assert.equal(parts[1], install.FOLDER_NAME, `${where}: ${p}`);
    if (parts.length > 2) assert.ok([install.NEWTAB_DIR, install.STILL_DIR].includes(parts[2]), `${where}: ${p}: an installed folder`);
    if (parts.length > 3) {
      assert.equal(parts[2], install.STILL_DIR, `${where}: ${p}`);
      assert.ok([stillEnv.STILL_JSON, task.TASK_FILE, task.LAUNCHER_FILE, task.SCRIPT_FILE, stillEnv.OUT_DIR].includes(parts[3]), `${where}: ${p}: a file of the installed still`);
    }
    return;
  }
  if (norm === '%LOCALAPPDATA%') return;
  if (norm === 'dist' || norm.startsWith('dist/')) {
    const r = norm.slice(5);
    assert.ok(r === '' || r === build.ZIP_NAME || install.GROUPS.some((g) => g.from === r), `${where}: ${p} is something the build makes`);
    assert.equal(build.ZIP_NAME, install.ZIP_NAME);
    return;
  }
  if (norm === cfgLib.CONFIG_REL) return; // you make it from the example
  assert.ok(fs.existsSync(rel(...norm.split('/'))), `${where}: ${p} exists`);
}

/** Every code span of a doc has to be accounted for: a command, a path, a setting, a terminal word or a known literal. */
function classify(span, d) {
  const where = d.name;
  const s = span.trim();
  if (/^node /.test(s)) return checkCommand(s, where);
  if (/^schtasks /.test(s)) {
    const c = task.schtasksCommands('C:\\X\\still');
    const known = Object.values(c).map((v) => v.split('C:\\X\\still').join(STILL_DIR));
    assert.ok(known.includes(s), `${where}: ${s} is one of the still's schtasks commands`);
    return;
  }
  if (/^(copy|notepad) /.test(s)) {
    assert.ok(['copy config\\user.example.json config\\user.json', 'notepad config\\user.json'].includes(s), `${where}: ${s}`);
    assert.ok(fs.existsSync(rel('config', 'user.example.json')));
    return;
  }
  if (/^"[a-zA-Z]+"$/.test(s) && cfgLib.CONFIG_KEYS.includes(s.slice(1, -1))) return;
  if (/^"[a-zA-Z0-9]+"$/.test(s) && Object.prototype.hasOwnProperty.call(stillEnv.STILL_DEFAULTS, s.slice(1, -1))) return; // a still.json key
  if (/^(https?|chrome|ms-settings):/.test(s)) {
    assert.ok(['http://pixelclock.local', 'chrome://extensions', 'ms-settings:personalization-background'].includes(s), `${where}: ${s}`);
    return;
  }
  if (/^[%\w.-]*[\\/][\w%.\\/-]*$/.test(s) || /^%LOCALAPPDATA%/.test(s)) return checkPath(s, where);
  if (/^[\w-]+\.(json|js|mjs|log|xml|png|md|txt)$/.test(s)) {
    const files = [stillEnv.STILL_JSON, task.TASK_FILE, task.LAUNCHER_FILE, task.SCRIPT_FILE, 'still.log'];
    assert.ok(files.includes(s) || fs.existsSync(rel(s)), `${where}: ${s} is a known file`);
    if (s === 'still.log') assert.match(readText('src/still/lib/env.mjs'), /still\.log/);
    return;
  }
  if (TERMINAL && TERMINAL.names.has(s.split(/\s+/)[0])) return;
  const LITERALS = new Map([
    ['dist', () => true], ['out', () => stillEnv.OUT_DIR === 'out'], ['cmd', () => true], ['cd', () => true],
    ['build OK', () => readText('tools/build.mjs').includes('build OK:')], ['install:', () => readText('tools/install.mjs').includes('`install: ')],
    ['next:', () => readText('tools/install.mjs').includes('`next: ')], ['detected', () => readText('src/still/pcd-still.mjs').includes('say(`detected ')],
    ['saved to', () => readText('src/still/pcd-still.mjs').includes('say(`saved to ')], ['SUCCESS:', () => true], ['--dry-run', () => install.parseArgs(['--dry-run']).dryRun === true],
    ['conhost.exe --headless', () => /conhost\.exe/.test(readText('src/still/run-hidden.js') + readText('src/still/lib/task.mjs'))],
    ['true', () => true], ['false', () => true], ['&', () => true], ['example.com', () => true],
  ]);
  if (LITERALS.has(s)) {
    assert.ok(LITERALS.get(s)(), `${where}: ${s}`);
    return;
  }
  if (/^\d+$/.test(s)) return; // numbers, checked with the config table
  if (/^"[^"]*"$/.test(s)) {
    // a config value: one the example holds, or one the config accepts in its place
    const v = s.slice(1, -1);
    const exampleValues = Object.values(EXAMPLE).filter((x) => typeof x === 'string');
    const accepted = (key) => cfgLib.validateConfig({ ...EXAMPLE, [key]: v }).length === 0;
    assert.ok(exampleValues.includes(v) || ['city', 'units', 'clock'].some((k) => accepted(k) && (k !== 'city' || /, [A-Z]{2}$/.test(v))), `${where}: ${s} is not a value the config takes`);
    return;
  }
  if (/^\{ "label"/.test(s)) {
    const item = JSON.parse(s);
    assert.ok(EXAMPLE.shortcuts.some((x) => x.label === item.label && x.url === item.url), `${where}: ${s} is one of the example's links`);
    return;
  }
  if (s.startsWith('⌂ ')) return; // the status line, checked against the code
  if (/^(-- )?[a-z].*/.test(s) && TERMINAL) {
    // a terminal example such as "theme snowy hills" or "= sqrt(2)*pi"
    assert.ok(TERMINAL.names.has(s.split(/\s+/)[0]), `${where}: \`${s}\` is not a command, path, setting or known literal`);
    return;
  }
  assert.fail(`${where}: \`${s}\` is not a command, path, setting or known literal`);
}

test('docs: every code span is a real command, path, file, setting, terminal command or known literal', () => {
  for (const d of pub()) for (const span of codeSpans(d.text)) classify(span, d);
});

// ------------------------------------------------------------------------------------------------ INSTALL

test('INSTALL: the sections the installer points to, in order', () => {
  const hs = headings(INSTALL()).filter((h) => h.level === 2).map((h) => h.title);
  assert.equal(hs[0], '1. Settings, build and install');
  for (const [key, title] of Object.entries(install.INSTALL_SECTIONS)) assert.ok(hs.includes(title), `INSTALL has "## ${title}" (tools/install.mjs, ${key})`);
  assert.deepEqual(hs, ['1. Settings, build and install', ...Object.values(install.INSTALL_SECTIONS)]);
});

test('INSTALL and UNINSTALL: numbered steps, at most 8 in a block, each saying what you see', () => {
  for (const d of [docs['INSTALL.md'], docs['UNINSTALL.md']]) {
    const blocks = stepBlocks(d.text);
    assert.ok(blocks.length >= 3, `${d.name} has step blocks`);
    for (const b of blocks) {
      assert.ok(b.steps.length <= 8, `${d.name} "${b.heading}": ${b.steps.length} steps (at most 8)`);
      b.steps.forEach((s, i) => {
        assert.equal(s.num, i + 1, `${d.name} "${b.heading}": numbered 1, 2, 3 ...`);
        assert.match(s.text, /\bYou see\b/, `${d.name} "${b.heading}" step ${s.num} says what you see`);
      });
    }
  }
});

test('INSTALL: the config table covers every key of config/user.example.json, with its example values', () => {
  const t = tableWith(section(INSTALL(), '1. '), 'key');
  const keys = t.rows.map((r) => /^`"(\w+)"`$/.exec(r[0])).map((m) => (m ? m[1] : null));
  assert.ok(keys.every(Boolean), 'every row names one key');
  assert.deepEqual([...keys].sort(), [...cfgLib.CONFIG_KEYS].sort(), 'the table lists exactly the config keys');
  assert.deepEqual(Object.keys(EXAMPLE).sort(), [...cfgLib.CONFIG_KEYS].sort(), 'the example has every key');
  for (const [i, k] of keys.entries()) {
    const cell = t.rows[i][2];
    const v = EXAMPLE[k];
    if (k === 'shortcuts') assert.equal(cell, v.map((s) => s.label).join(', '), 'the example links');
    else assert.equal(cell, `\`${JSON.stringify(v)}\``, `the example value of "${k}"`);
  }
  // the values the table offers are the ones the config accepts
  const units = t.rows[keys.indexOf('units')][1];
  for (const u of ['C', 'F']) assert.ok(units.includes(`\`"${u}"\``) && cfgLib.validateConfig({ ...EXAMPLE, units: u }).length === 0);
  const clock = t.rows[keys.indexOf('clock')][1];
  for (const c of ['24h', '12h']) assert.ok(clock.includes(`\`"${c}"\``) && cfgLib.validateConfig({ ...EXAMPLE, clock: c }).length === 0);
  assert.ok(cfgLib.validateConfig({ ...EXAMPLE, city: 'Berlin, DE' }).length === 0);
  // the links: as many as the config takes, which is as many as the new tab numbers
  assert.ok(t.rows[keys.indexOf('shortcuts')][1].includes(`at most ${cfgLib.LIMITS.shortcuts}`), 'the most links the config takes');
  assert.equal(cfgLib.LIMITS.shortcuts, S.SHORTCUTS_MAX, 'the config takes as many links as the new tab numbers');
  assert.equal(S.spec('shortcuts').max, 9, 'the new tab keeps 9 links');
});

test('INSTALL: what the installer copies where, with the names the code uses', () => {
  const t = flat(section(INSTALL(), '1. '));
  for (const g of install.GROUPS) assert.ok(t.includes(`\`dist\\${g.from}\` to \`${LOCALAPPDATA_DIR}\\${g.name}\``), `dist\\${g.from} -> ${g.name}`);
  for (const f of [stillEnv.STILL_JSON, task.LAUNCHER_FILE, task.TASK_FILE]) assert.ok(t.includes(`\`${f}\``), f);
  assert.ok(t.includes(`\`${stillEnv.OUT_DIR}\` folder`));
  assert.ok(t.includes('never registers the task'), 'it never registers the task');
  assert.match(readText('tools/install.mjs'), /never registers the scheduled task, never sets the wallpaper/);
});

test('INSTALL: the new tab steps use the extension\'s name and the installed folder', () => {
  const t = flat(section(INSTALL(), install.INSTALL_SECTIONS.newtab));
  assert.ok(t.includes(`**${MANIFEST.name}** card`));
  assert.ok(t.includes(`\`${NEWTAB_DIR}\``));
  // the installer's own next step names the same labels
  const plan = fakePlan();
  const out = install.nextSteps(plan).join('\n');
  for (const label of ['Developer mode', 'Load unpacked', 'Keep it']) {
    assert.ok(out.includes(label), `the installer says ${label}`);
    assert.ok(t.includes(`**${label}**`), `INSTALL says **${label}**`);
  }
  // the status line example is what the new tab draws for the sample clock in the example's clock
  const normal = JSON.parse(readText('tests/fixtures/status/normal.json'));
  const parsed = STATUS.parse(normal);
  assert.ok(parsed.ok);
  const example = spansOf(t).find((s) => s.startsWith('⌂ '));
  assert.equal(example, STATUS.lineText(STATUS.describe(parsed.status, { clock24: EXAMPLE.clock === '24h' })));
  assert.ok(MANIFEST.host_permissions.includes('http://pixelclock.local/*'));
  assert.ok(S.KEYS.some((k) => k.key === 'focusTerminal' && k.fallback === true), 'the terminal takes the focus by default');
});

test('INSTALL: the Lively steps and every Customise label, as the wallpaper defines them', () => {
  const sec = section(INSTALL(), install.INSTALL_SECTIONS.live);
  const t = flat(sec);
  assert.ok(t.includes(`**${LIVELY_INFO.Title}** tile`), 'the tile is called what LivelyInfo.json says');
  assert.ok(t.includes(`\`dist\\${build.ZIP_NAME}\``));
  // the installer's live step names the same labels (it prints that step only when dist holds the zip, so before
  // a build its source says it)
  const out = install.nextSteps(fakePlan()).join('\n');
  const said = out.includes('Live wallpaper') ? out : readText('tools/install.mjs');
  for (const label of ['Add Wallpaper', 'Browse']) assert.ok(said.includes(label) && t.includes(`**${label}**`), label);
  assert.ok(t.includes(`about ${P.DEBOUNCE_MS / 1000} seconds`), 'the text boxes wait as long as the code does');
  // the Customise table: every control with a text, in Customise order, with its real default
  const table = tableWith(sec, 'setting');
  const texts = P.CONTROLS.filter((c) => c.text);
  assert.deepEqual(table.rows.map((r) => r[0]), texts.map((c) => `**${c.text}**`), 'every Customise label, in order');
  const menu = P.themeMenu({ menu: MENU });
  const WS = typeof P.schemaFor === 'function' ? P.schemaFor(S) : S;
  const props = P.buildProperties(EXAMPLE, { schema: WS, menu });
  texts.forEach((c, i) => {
    const [, what, start] = table.rows[i];
    if (c.type === 'dropdown') {
      const items = c.k === 'theme' ? [menu[0].name] : c.items;
      for (const it of items) assert.ok(what.includes(`**${it}**`), `${c.text}: offers **${it}**`);
    }
    const spec = c.setting ? WS.spec(c.setting) : null;
    const fromConfig = /^from `"(\w+)"`$/.exec(start);
    if (c.type === 'button') assert.equal(start, '-', `${c.text} is a button`);
    else if (fromConfig) {
      assert.ok(spec && spec.config.includes(fromConfig[1]), `${c.text} starts from config "${fromConfig[1]}"`);
      assert.ok(cfgLib.CONFIG_KEYS.includes(fromConfig[1]));
    } else if (c.type === 'checkbox') assert.equal(start, props[c.k].value ? 'on' : 'off', `${c.text} starts ${props[c.k].value ? 'on' : 'off'}`);
    else if (c.type === 'dropdown') assert.equal(start, `**${props[c.k].items[props[c.k].value]}**`, `${c.text} starts as its default item`);
    else assert.fail(`${c.text}: say where it starts`);
  });
  for (const label of ['Customise', 'Settings', 'Performance', 'Applications fullscreen', 'When on Battery Saver', 'Pause', 'Wallpaper', 'Wallpaper input', 'Off', 'Delete']) {
    assert.ok(t.includes(`**${label}**`), `INSTALL quotes Lively's **${label}**`);
  }
  assert.match(readText('src/wallpaper/LivelyInfo.json'), /"Arguments":"--pause-event true"/, 'the page hears Lively\'s pause');
});

test('INSTALL: the still steps are the commands the installer prints, and the task runs when INSTALL says', () => {
  const sec = section(INSTALL(), install.INSTALL_SECTIONS.still);
  const t = flat(sec);
  const c = task.schtasksCommands('C:\\X\\still');
  const as = (cmd) => cmd.split('C:\\X\\still').join(STILL_DIR);
  for (const k of ['create', 'run', 'disable', 'enable', 'remove']) assert.ok(t.includes(`\`${as(c[k])}\``), `INSTALL gives ${k}: ${as(c[k])}`);
  assert.ok(t.includes(`\`node "${STILL_DIR}\\${task.SCRIPT_FILE}" --detect\``));
  const out = install.nextSteps(fakePlan());
  for (const k of ['create', 'run', 'disable', 'enable', 'remove']) assert.ok(out.some((l) => l.endsWith(c[k])), `the installer prints ${k}`);
  assert.ok(out.some((l) => l.endsWith(`node "C:\\X\\still\\${task.SCRIPT_FILE}" --detect`)), 'the installer prints --detect');
  // every 15 minutes, at sign-in and at unlock, as the task says
  const xml = task.taskXml({ stillDir: 'C:\\X\\still', userSid: 'S-1-5-21-1-2-3-1001', date: new Date(2026, 10, 15) });
  assert.ok(t.includes('every 15 minutes, when you sign in and when you unlock the computer'));
  assert.match(xml, /<Interval>PT15M<\/Interval>/);
  assert.match(xml, /<LogonTrigger>/);
  assert.match(xml, /<StateChange>SessionUnlock<\/StateChange>/);
  // it skips while Lively plays, and it shows the date instead of a time
  assert.ok(t.includes('While Lively plays a wallpaper the task does nothing'));
  assert.match(readText('src/still/pcd-still.mjs'), /skip: a Lively wallpaper is running/);
  assert.ok(stillEnv.isLivelyPlayer('Lively.Player.WebView2.exe'));
  assert.ok(t.includes('`--conhost`') || t.includes('--conhost'), '--conhost');
  assert.equal(install.parseArgs(['--conhost']).conhost, true);
});

/** A plan as the installer makes it on a first install (for nextSteps only). */
function fakePlan() {
  const files = task.stillFiles('C:\\X\\still');
  return {
    dist: rel('dist'), node: 'C:\\Program Files\\nodejs\\node.exe', files, stillJsonWritten: true,
    groups: [
      { name: install.NEWTAB_DIR, dst: 'C:\\X\\chrome-newtab', existed: false, entries: [], stale: [] },
      { name: install.STILL_DIR, dst: files.dir, existed: false, entries: [{ rel: task.TASK_FILE, same: false }], stale: [] },
    ],
  };
}

test('INSTALL and UNINSTALL: every bold label is the code\'s own or one of the few screen labels of Chrome, Lively and Windows', () => {
  const SCREEN = new Set([
    // Chrome
    'Developer mode', 'Load unpacked', 'Select Folder', 'Keep it', 'Reload', 'Remove', 'Errors',
    // Lively
    'Lively Wallpaper', 'Add Wallpaper', 'Browse', 'Customise', 'Settings', 'Performance', 'Applications fullscreen', 'When on Battery Saver',
    'Pause', 'Wallpaper', 'Wallpaper input', 'Off', 'Delete', 'Exit',
    // Windows
    'Background', 'PixelClockDesktop',
  ]);
  const CODE = new Set([MANIFEST.name, LIVELY_INFO.Title, ...Object.values(P.TEXTS)]);
  for (const c of P.CONTROLS) for (const it of c.items || []) CODE.add(it);
  CODE.add(P.themeMenu({ menu: MENU })[0].name);
  // the new tab's settings sheet: its row labels, texts and options (js/ntp-panel.js COPY)
  const rows = (PANEL.COPY && PANEL.COPY.rows) || {};
  for (const r of Object.values(rows)) {
    for (const k of ['label', 'text']) if (typeof r[k] === 'string') CODE.add(r[k]);
    for (const o of Object.values(r.options || {})) CODE.add(o);
  }
  for (const k of ['title', 'done']) if (PANEL.COPY && typeof PANEL.COPY[k] === 'string') CODE.add(PANEL.COPY[k]);
  for (const d of [docs['INSTALL.md'], docs['UNINSTALL.md']]) {
    for (const b of bolds(d.text)) assert.ok(CODE.has(b) || SCREEN.has(b), `${d.name}: **${b}** is not a known label`);
  }
  assert.equal(install.FOLDER_NAME, 'PixelClockDesktop');
});

// ------------------------------------------------------------------------------------------------ UNINSTALL

test('UNINSTALL: one section per piece, the task removed with the installer\'s own command, the folder last', () => {
  const hs = headings(UNINSTALL()).filter((h) => h.level === 2).map((h) => h.title);
  assert.deepEqual(hs, ['Chrome new tab', 'Live wallpaper (Lively)', 'Still wallpaper', 'Files']);
  const t = flat(UNINSTALL());
  assert.ok(t.includes(`\`${task.schtasksCommands('C:\\X\\still').remove}\``));
  assert.ok(t.includes(`**${MANIFEST.name}** card`) && t.includes(`**${LIVELY_INFO.Title}** tile`));
  assert.ok(t.includes(`**${install.FOLDER_NAME}**`));
});
