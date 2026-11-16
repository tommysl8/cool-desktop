// The terminal libraries from an earlier terminal project, as classic scripts for the new tab. A helper, not a test
// file: tests/newtab-term-lib.test.mjs imports it, and it doubles as the tool that regenerates the copies.
//
// The originals are ES modules. The new tab loads only deferred classic scripts (tools/validate/newtab.mjs) and its
// shipped text must stay in the safe glyph set (tools/lib/glyphs.mjs, tools/glyph-gate.mjs). wrap() turns one module
// into a classic script that registers a factory in PCD.termDefs (PCD.term.lib(name) instantiates it on first use),
// changing only what a classic script needs, line for line:
//   import { a, b } from './x.js';    ->  const { a, b } = require('./x.js');
//   export function f(                 ->  /*export*/function f(
//   export const X =                   ->  /*export*/const X =
//   a character outside the safe set   ->  its \uXXXX escape (in the copies only inside string literals)
// plus a header (what the file is and the factory's opening) and a footer (exports.name = name for each export).
// unwrap() undoes exactly that, so tests prove each shipped copy is the original file byte for byte (SOURCES pins the
// SHA-256 of each).
//
// CLI (Node built-ins only; it writes only src/newtab/js/term/lib/):
//   node tests/newtab-term-wrap.mjs --check                 the copies unwrap to SOURCES and are current
//   node tests/newtab-term-wrap.mjs --rewrap                rewrite each copy around its own unwrapped body (after a
//                                                           change to the wrapper; no originals needed)
//   node tests/newtab-term-wrap.mjs --from <dir> [--write]  compare <dir>/<name> (default: the folder named by
//                                                           PCD_TERM_LIB_SOURCE) with SOURCES; --write regenerates
//                                                           the copies from it (a changed hash needs --accept)
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isSafeChar } from '../tools/lib/glyphs.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, '..');
export const LIB_DIR = path.join(ROOT, 'src', 'newtab', 'js', 'term', 'lib');
/** The environment variable that may name a folder holding the original files (optional: nothing needs it). */
export const SOURCE_ENV = 'PCD_TERM_LIB_SOURCE';

/** The original files the terminal uses (every import they make is here, except commands.js: ours). SHA-256 of each. */
export const SOURCES = Object.freeze({
  'format.js': '236ff4a8c7a34f64103900704dbbb47d167d3aae0d9789dc2d274fef478e0b17',
  'parse.js': '2b04f0a8fda2c7e61848e5ed02c830b4d7e9432e871df0d1cb38772c93d96571',
  'url.js': 'd758e538bb9146a3b20d60a7cb72a7835a692aa5d2a73b278bcccfee94f73548',
  'calc.js': 'ac11116c8d0feed72076f250f1d2517a3236fb57386600e41434093aa49ea9a1',
  'history.js': '6ddd7348c83a7491bb37834ccb67b73d09946f7118100523f385ead5106b3ab4',
  'aliases.js': 'f84fc73f21d4600dd4de010fa9fc207999e0be36641de994ca17045a82582562',
  'router.js': '3df19bc5e2beefe93e3ee91805f923ac58d8be0b32e2737cdc2318e575e6dc31',
  'complete.js': 'c0acaab844e507e5508a8a3111deb06bfaa9d6245d77773fe2482d89c5ce5e05',
});
/** The one module the copies import that is not copied: the terminal's own table (src/newtab/js/term/term-commands.js). */
export const OWN_MODULES = Object.freeze(['commands.js']);

const IMPORT_RE = /^import \{ ([A-Za-z0-9_$, ]+) \} from '(\.\/[a-z0-9-]+\.js)';$/;
const REQUIRE_RE = /^const \{ ([A-Za-z0-9_$, ]+) \} = require\('(\.\/[a-z0-9-]+\.js)'\);$/;
const EXPORT_RE = /^export (function|const) ([A-Za-z_$][A-Za-z0-9_$]*)\b/;
const MARK = '/*export*/';
const MARKED_RE = /^\/\*export\*\/(function|const) ([A-Za-z_$][A-Za-z0-9_$]*)\b/;
const BEGIN = (name) => `// ---------- begin ${name} (unchanged but for the wrapper)`;
const BEGIN_RE = /^\/\/ ---------- begin ([a-z0-9-]+\.js) \(unchanged but for the wrapper\)$/;
const END = (name) => `// ---------- end ${name}`;

export function sha256(text) {
  return crypto.createHash('sha256').update(typeof text === 'string' ? Buffer.from(text, 'utf8') : text).digest('hex');
}

function backslashesBefore(line, at) {
  let n = 0;
  for (let i = at - 1; i >= 0 && line[i] === '\\'; i--) n++;
  return n;
}

/** The line with every character outside the safe set as \uXXXX (BMP only; tabs stay: they are layout). */
function escapeUnsafe(line, where) {
  let out = '';
  let i = 0;
  for (const ch of line) {
    const cp = ch.codePointAt(0);
    if (ch === '\t' || isSafeChar(ch)) {
      out += ch;
    } else {
      if (cp > 0xffff) throw new Error(`${where}: U+${cp.toString(16).toUpperCase()} is outside the BMP; the wrapper cannot escape it`);
      if (backslashesBefore(line, i) % 2) throw new Error(`${where}: an escaped U+${cp.toString(16).toUpperCase()}; the wrapper cannot escape it`);
      out += '\\u' + cp.toString(16).toUpperCase().padStart(4, '0');
    }
    i += ch.length;
  }
  return out;
}

/** The reverse of escapeUnsafe: \uXXXX (upper-case hex, not itself escaped) of a character outside the safe set. */
function unescapeUnsafe(line) {
  return line.replace(/\\u([0-9A-F]{4})/g, (m, hex, at) => {
    if (backslashesBefore(line, at) % 2) return m;
    const ch = String.fromCharCode(parseInt(hex, 16));
    return ch.charCodeAt(0) < 0x80 || isSafeChar(ch) ? m : ch;
  });
}

/**
 * The classic script for one module. Returns { text, imports: [{ names, from }], exports: [names] }.
 * Throws on anything the line rules do not cover (CR, a missing final newline, an unknown import or export form,
 * a source that already looks wrapped), so a changed upstream file fails loudly instead of shipping half-converted.
 */
export function wrapInfo(name, source) {
  if (!/^[a-z0-9-]+\.js$/.test(name)) throw new Error(`wrap: bad module name ${JSON.stringify(name)}`);
  if (typeof source !== 'string') throw new Error(`wrap ${name}: the source must be text`);
  if (source.includes('\r')) throw new Error(`wrap ${name}: CR line endings (the copies are LF)`);
  if (!source.endsWith('\n')) throw new Error(`wrap ${name}: no final newline`);
  const lines = source.slice(0, -1).split('\n');
  const imports = [];
  const exportsList = [];
  const body = lines.map((line, i) => {
    const where = `${name}:${i + 1}`;
    if (REQUIRE_RE.test(line) || line.startsWith(MARK) || line.startsWith('// ---------- ')) throw new Error(`wrap ${where}: the source already has the wrapper's form`);
    if (unescapeUnsafe(line) !== line) throw new Error(`wrap ${where}: an upper-case escape of a glyph outside the safe set; unwrap could not tell it from the wrapper's own`);
    let out = line;
    if (/^import\b/.test(line)) {
      const m = IMPORT_RE.exec(line);
      if (!m) throw new Error(`wrap ${where}: an import form the wrapper does not know: ${line}`);
      imports.push({ names: m[1].split(',').map((s) => s.trim()).filter(Boolean), from: m[2] });
      out = `const { ${m[1]} } = require('${m[2]}');`;
    } else if (/^export\b/.test(line)) {
      const m = EXPORT_RE.exec(line);
      if (!m) throw new Error(`wrap ${where}: an export form the wrapper does not know: ${line}`);
      if (exportsList.includes(m[2])) throw new Error(`wrap ${where}: ${m[2]} is exported twice`);
      exportsList.push(m[2]);
      out = MARK + line.slice('export '.length);
    } else if (/^\s+(import|export)\s/.test(line)) {
      throw new Error(`wrap ${where}: an indented import or export: ${line}`);
    }
    return escapeUnsafe(out, where);
  });
  const sha = sha256(source);
  const head = [
    `/* PixelClock Desktop new tab terminal: ${name} from an earlier terminal project, as a classic script.`,
    " * Its comments and messages may name that project's commands (todo, alias, timer, ...); this terminal's own commands",
    ' * are in term-commands.js.',
    ' * Generated by tests/newtab-term-wrap.mjs (do not edit) from the file whose SHA-256 is',
    ` * ${sha}.`,
    ' * Between the begin and end lines below it is that file line for line: only the import lines (now',
    ' * const { ... } = require(...)), the export keyword (now a marker comment) and characters outside the safe glyph set',
    ' * (now \\uXXXX escapes) differ, and tests/newtab-term-lib.test.mjs proves that undoing them gives the file back. */',
    '(function (root) {',
    "  'use strict';",
    '  var PCD = root.PCD || (root.PCD = {});',
    '  var defs = PCD.termDefs || (PCD.termDefs = {});',
    `  defs['${name}'] = function (require, exports) {`,
    "'use strict';",
    BEGIN(name),
  ];
  const foot = [
    END(name),
    ...exportsList.map((n) => `exports.${n} = ${n};`),
    '  };',
    "}(typeof globalThis !== 'undefined' ? globalThis : this));",
    '',
  ];
  return { text: [...head, ...body, ...foot].join('\n'), imports, exports: exportsList };
}

export function wrap(name, source) {
  return wrapInfo(name, source).text;
}

/** The original module text of a wrapped file (exactly the bytes wrap() was given). Throws when it is not one. */
export function unwrap(text) {
  if (typeof text !== 'string') throw new Error('unwrap: text expected');
  const lines = text.split('\n');
  const b = lines.findIndex((l) => BEGIN_RE.test(l));
  if (b < 0) throw new Error('unwrap: no begin line');
  const name = BEGIN_RE.exec(lines[b])[1];
  const e = lines.indexOf(END(name), b + 1);
  if (e < 0) throw new Error(`unwrap ${name}: no end line`);
  const body = lines.slice(b + 1, e).map((line) => {
    let out = unescapeUnsafe(line);
    const r = REQUIRE_RE.exec(out);
    if (r) return `import { ${r[1]} } from '${r[2]}';`;
    if (MARKED_RE.test(out)) out = 'export ' + out.slice(MARK.length);
    return out;
  });
  return { name, source: body.join('\n') + '\n' };
}

/** Checks one shipped copy: { name, ok, problems: [] }. */
export function checkCopy(name, text) {
  const problems = [];
  let src = null;
  try {
    const u = unwrap(text);
    if (u.name !== name) problems.push(`it wraps ${u.name}, not ${name}`);
    src = u.source;
  } catch (e) {
    problems.push(e.message);
  }
  if (src !== null) {
    if (SOURCES[name] && sha256(src) !== SOURCES[name]) problems.push(`unwrapped SHA-256 ${sha256(src)} is not the pinned hash ${SOURCES[name]}`);
    try {
      if (wrap(name, src) !== text) problems.push('not current: regenerate it (node tests/newtab-term-wrap.mjs --rewrap)');
    } catch (e) {
      problems.push(e.message);
    }
  }
  return { name, ok: problems.length === 0, problems };
}

/** The folder of the originals named by PCD_TERM_LIB_SOURCE, or '' (the copies never need it). */
function defaultFrom() {
  return process.env[SOURCE_ENV] || '';
}

/** --rewrap: each copy rewritten around its own unwrapped body (the body must still match its pinned hash). */
function rewrap() {
  let bad = 0;
  for (const name of Object.keys(SOURCES)) {
    const file = path.join(LIB_DIR, name);
    let src = null;
    try {
      src = unwrap(fs.readFileSync(file, 'utf8')).source;
    } catch (e) {
      console.log(`FAIL src/newtab/js/term/lib/${name}: ${e.message}`);
      bad++;
      continue;
    }
    if (sha256(src) !== SOURCES[name]) {
      console.log(`FAIL src/newtab/js/term/lib/${name}: its body is not the pinned file (SHA-256 ${sha256(src)}); left as it is`);
      bad++;
      continue;
    }
    const text = wrap(name, src);
    const same = text === fs.readFileSync(file, 'utf8');
    if (!same) fs.writeFileSync(file, text, 'utf8');
    console.log(`${same ? 'same     ' : 'rewrapped'} src/newtab/js/term/lib/${name}`);
  }
  return bad ? 1 : 0;
}

function main(argv) {
  const has = (f) => argv.includes(f);
  if (has('--rewrap')) return rewrap();
  const at = argv.indexOf('--from');
  const from = at >= 0 ? path.resolve(argv[at + 1] || '') : defaultFrom();
  let bad = 0;
  if (has('--check') || at < 0 && !has('--write')) {
    for (const name of Object.keys(SOURCES)) {
      const file = path.join(LIB_DIR, name);
      const r = fs.existsSync(file) ? checkCopy(name, fs.readFileSync(file, 'utf8')) : { ok: false, problems: ['missing'] };
      console.log(`${r.ok ? 'PASS' : 'FAIL'} src/newtab/js/term/lib/${name}${r.ok ? '' : ': ' + r.problems.join('; ')}`);
      if (!r.ok) bad++;
    }
    return bad ? 1 : 0;
  }
  if (!from || !fs.existsSync(from)) {
    console.error(`no folder with the original files${from ? ` at ${from}` : ''} (pass --from <dir> or set ${SOURCE_ENV})`);
    return 1;
  }
  for (const name of Object.keys(SOURCES)) {
    const buf = fs.readFileSync(path.join(from, name));
    const hash = sha256(buf);
    const same = hash === SOURCES[name];
    console.log(`${same ? 'same   ' : 'CHANGED'} ${name} ${hash}`);
    if (!same && !has('--accept')) bad++;
    if (has('--write') && (same || has('--accept'))) {
      fs.mkdirSync(LIB_DIR, { recursive: true });
      fs.writeFileSync(path.join(LIB_DIR, name), wrap(name, buf.toString('utf8')), 'utf8');
    }
  }
  if (bad) console.error(`${bad} file(s) differ from SOURCES: review the change, then update SOURCES (or pass --accept with --write)`);
  return bad ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
