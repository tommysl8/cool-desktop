// src/shared/css/pcd-base.css: the font stack with ligatures and kerning off, line-height normal for art, the grid
// cell variables, the role classes, focus and selection, no transitions, and nothing from the "do not" list.
// Computed styles in Chrome: tests/glyph-gate.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, lib, sandbox } from './look-load.mjs';

const CSS_FILE = path.join(ROOT, 'src', 'shared', 'css', 'pcd-base.css');
const raw = fs.readFileSync(CSS_FILE);
const css = raw.toString('utf8');
const code = css.replace(/\/\*[\s\S]*?\*\//g, '');
const T = await lib('tools/lib/tokens.mjs');
const { isSafeChar } = await lib('tools/lib/glyphs.mjs');

/** The declarations of the rule whose selector is exactly `selector`, else of the first list that contains it. */
function rule(selector) {
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  let inList = null;
  while ((m = re.exec(code))) {
    const sels = m[1].split(',').map((s) => s.trim());
    if (sels.length === 1 && sels[0] === selector) return m[2];
    if (inList === null && sels.includes(selector)) inList = m[2];
  }
  return inList;
}

test('UTF-8 without BOM, LF, safe glyphs only', () => {
  assert.notEqual(raw[0], 0xef);
  assert.ok(!css.includes('\r'));
  assert.ok(css.endsWith('\n'));
  for (const ch of css) if (ch !== '\n') assert.ok(isSafeChar(ch), `unsafe ${ch}`);
});

test('the page: bg, text, the one monospace stack, weight 400, ligatures, kerning and synthesis off', () => {
  const page = rule('body');
  assert.ok(page);
  assert.match(page, /font-family: var\(--mono\);/);
  assert.match(page, /font-weight: var\(--weight, 400\);/);
  assert.match(page, /font-variant-ligatures: none;/);
  assert.match(page, /font-kerning: none;/);
  assert.match(page, /font-synthesis: none;/);
  assert.match(page, /font-feature-settings: 'liga' 0, 'clig' 0, 'calt' 0;/);
  assert.match(code, /html,\s*body\s*\{[^}]*background: var\(--bg\);[^}]*color: var\(--text\);/);
  assert.match(rule('html'), /color-scheme: dark;/);
  assert.match(rule('[hidden]'), /display: none !important;/);
});

test('text art keeps line-height normal; grid text uses the floored cell', () => {
  const art = rule('.pcd-art');
  assert.match(art, /line-height: normal;/);
  assert.match(art, /white-space: pre;/);
  assert.match(art, /letter-spacing: 0;/);
  assert.match(art, /font-variant-ligatures: none;/);
  const g = rule('.pcd-g');
  assert.match(g, /line-height: var\(--cell-h, normal\);/);
  assert.match(g, /letter-spacing: var\(--cell-ls, 0\);/);
  assert.match(g, /white-space: pre;/);
  assert.match(g, /position: absolute;/);
  assert.match(rule('.pcd-pixels'), /image-rendering: pixelated;/);
});

test('role classes: one per PCD.core role, each the token\'s variable', () => {
  const roles = sandbox(['src/shared/pcd-core.js']).PCD.core.ROLES;
  for (const role of roles) {
    const decl = rule(`.t-${role}`);
    assert.ok(decl, `.t-${role}`);
    if (role === 'bold') assert.match(decl, /font-weight: var\(--weight-bold, 600\);/);
    else if (role === 'field') assert.match(decl, /background: var\(--field\);/);
    else assert.match(decl, new RegExp(`^ ?color: var\\(--${role}\\); ?$`), `.t-${role} { ${decl} }`);
  }
});

test('links, focus, selection and the plain-control reset', () => {
  assert.match(rule('a'), /text-decoration: none;/);
  assert.match(rule('a'), /color: inherit;/);
  assert.match(rule('a:hover'), /color: var\(--text\);/);
  assert.match(rule(':focus-visible'), /outline: 1px solid var\(--accent\);/);
  assert.match(rule(':focus-visible'), /outline-offset: 2px;/);
  assert.match(rule('::selection'), /background: var\(--wood\);/);
  assert.match(rule('::selection'), /color: var\(--text\);/);
  assert.match(rule('.pcd-plain'), /all: unset;/);
  assert.ok(T.contrastReport(T.loadTokens(ROOT)).some((r) => r.token === 'text' && r.against === 'wood' && r.pass), 'the selection colours are gated');
});

test('motion: no transitions anywhere, html.pcd-reduced stops CSS animations', () => {
  assert.match(rule('*'), /transition: none !important;/);
  assert.match(rule('html.pcd-reduced *'), /animation: none !important;/);
  assert.ok(!/@keyframes/.test(code));
  assert.ok(!/animation\s*:(?!\s*none)/.test(code), 'no animation is started here');
});

test('nothing from the "do not" list: no gradients, glow, blur, shadows, rounded CSS boxes, remote fonts or colour literals', () => {
  for (const banned of [/gradient/i, /blur\(/i, /backdrop-filter/i, /box-shadow/i, /text-shadow/i, /border-radius/i, /\binfinite\b/i, /@font-face/i, /@import/i, /url\(/i, /\bfilter\s*:/i, /drop-shadow/i, /opacity\s*:/i]) {
    assert.ok(!banned.test(code), `pcd-base.css must not use ${banned}`);
  }
  assert.ok(!/#[0-9a-f]{3,8}\b/i.test(code), 'colours come from tokens.css variables only');
  assert.ok(!/rgba?\(/i.test(code));
});

test('every variable it reads is defined by tokens.css (or has a fallback)', async () => {
  const tokensCss = (await T.generate({ root: ROOT })).files['tokens.css'];
  const defined = new Set([...tokensCss.matchAll(/(--[a-z0-9-]+):/g)].map((m) => m[1]));
  for (const m of code.matchAll(/var\((--[a-z0-9-]+)(,[^)]*)?\)/g)) {
    assert.ok(defined.has(m[1]) || m[2], `${m[1]} is neither in tokens.css nor given a fallback`);
  }
});
