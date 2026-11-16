// tools/glyph-gate.mjs: what it gathers, and the real gate in headless Chrome (TermMono and Consolas, every used
// glyph including the rounded corners), plus the shared base styles and PCD.font.measureCell as Chrome computes them.
// Headless runs use tools/lib/chrome.mjs (temp profile, privacy guard).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ROOT, lib } from './look-load.mjs';

const G = await lib('tools/glyph-gate.mjs');
const { isSafeChar, allSafe } = await lib('tools/lib/glyphs.mjs');
const { findBrowser, launch } = await lib('tools/lib/chrome.mjs');
const { serve } = await lib('tools/lib/serve.mjs');
const { makeTempDir, rmrf } = await lib('tools/lib/fsx.mjs');
const noBrowser = findBrowser() ? false : 'no Chrome or Edge on this machine';

test('deepStrings: nested strings, functions skipped, cycles survived', () => {
  const a = { x: 'one', y: ['two', { z: 'three' }], f() { return 'never'; } };
  a.self = a;
  assert.deepEqual(G.deepStrings(a), ['one', 'two', 'three']);
  assert.deepEqual(G.deepStrings('solo'), ['solo']);
  assert.deepEqual(G.deepStrings(null), []);
});

test('authoredFiles: src/ and design text, never the vendor copies or licence texts', () => {
  const files = G.authoredFiles({ root: ROOT }).map((f) => f.rel);
  assert.ok(files.includes('src/shared/pcd-core.js'));
  assert.ok(files.includes('src/shared/css/pcd-base.css'));
  assert.ok(files.includes('design/tokens.json'));
  assert.ok(!files.some((f) => f.split('/').includes('pixelclock')), 'vendor copies are exempt');
  assert.ok(!files.some((f) => /\/OFL\.txt$/.test(f)), 'licence texts are exempt');
  assert.ok(!files.some((f) => /\.(png|jpg|ttf)$/.test(f)));
  assert.ok(!G.authoredFiles({ root: ROOT, useDist: false }).some((f) => f.rel.startsWith('dist/')));
});

test('gatherChars: the safe set, the drawn glyphs, icons and sample lines, and what the emitters say', () => {
  const g = G.gatherChars({ root: ROOT, useDist: false });
  for (const ch of allSafe()) assert.ok(g.chars.has(ch), `safe-set ${ch}`);
  for (const ch of '╭╮╰╯─│├┤░▌›»·⌂☼≡↓→•°') assert.ok(g.used.has(ch), `the look draws ${ch}`);
  assert.ok(!g.used.has('╳'), 'an unused box-drawing character is measured but not "used"');
  assert.ok(g.emitters.includes('emit:greetings'));
  assert.ok(g.emitters.includes('emit:dates and times'));
  assert.ok(g.chars.get('·').some((s) => s === 'emit:greetings'), 'the holiday separator comes from pcd-greet');
  assert.deepEqual(g.badUtf8, []);
  for (const ch of g.used) assert.ok(isSafeChar(ch), `used ${ch} must be safe`);
  for (const rows of Object.values(G.WEATHER_ICONS)) {
    assert.equal(rows.length, 4);
    for (const r of rows) assert.equal(r.length, 11, JSON.stringify(r));
  }
});

test('the drawn glyphs and sample lines follow what the pieces draw', () => {
  // every glyph of the ASCII kit is listed, and every listed glyph is drawn by some source file or emitter
  const { PCD } = G.loadSandbox(ROOT);
  for (const ch of PCD.ascii.CHARS) assert.ok(G.DRAWN_GLYPHS.includes(ch), `PCD.ascii draws ${ch}`);
  const g = G.gatherChars({ root: ROOT, useDist: false });
  for (const ch of G.DRAWN_GLYPHS) {
    if (ch <= '~') continue;
    assert.ok(g.chars.get(ch).some((s) => s.startsWith('src/') || s.startsWith('emit:')), `${ch} is drawn somewhere (${g.chars.get(ch).join(', ')})`);
  }
  // the console's own words, as it draws them
  for (const line of ['hi 49° · lo 41°', '1-3 + enter opens a link · help lists commands', 'weather: open-meteo.com', '── terminal ───', '[1] wikipedia   [2] maps   [3] open-meteo']) {
    assert.ok(G.DRAWN_LINES.includes(line), line);
  }
});

test('gatherChars: a character outside the safe set in authored text is caught with its file', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pcd-gate-root-'));
  try {
    fs.mkdirSync(path.join(tmp, 'design'), { recursive: true });
    fs.mkdirSync(path.join(tmp, 'src', 'shared', 'css'), { recursive: true });
    fs.copyFileSync(path.join(ROOT, 'design', 'tokens.json'), path.join(tmp, 'design', 'tokens.json'));
    for (const n of ['pcd-core.js', 'pcd-greet.js']) fs.copyFileSync(path.join(ROOT, 'src', 'shared', n), path.join(tmp, 'src', 'shared', n));
    fs.writeFileSync(path.join(tmp, 'src', 'shared', 'bad.js'), '// a dash — and an ellipsis …\n');
    const g = G.gatherChars({ root: tmp, useDist: false });
    const unsafe = [...g.chars.keys()].filter((ch) => !isSafeChar(ch));
    assert.deepEqual(unsafe.sort(), ['—', '…']);
    assert.deepEqual(g.chars.get('—'), ['src/shared/bad.js']);
    assert.ok(g.notes.some((n) => /vendor/.test(n)), 'a missing engine is a note, not a crash');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('the gate passes in headless Chrome: TermMono and Consolas, 16 and 48 px, every used glyph', { skip: noBrowser, timeout: 180000 }, async () => {
  const lines = [];
  const errs = [];
  const shot = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pcd-gate-shot-')), 'sheet.png');
  try {
    const code = await G.main({ argv: ['--no-dist', '--shot', shot], log: (s) => lines.push(s), logError: (s) => errs.push(s) });
    const out = lines.join('\n');
    assert.equal(code, 0, out + '\n' + errs.join('\n'));
    assert.match(out, /glyph gate PASS/);
    assert.match(out, /PASS +\| gate: TermMono loaded through PCD\.font\.load/);
    for (const fam of ['TermMono', 'Consolas']) for (const px of [16, 48]) assert.match(out, new RegExp(`PASS +\\| gate: ${fam} @${px}px`));
    assert.match(out, /PASS +\| gate: the drawn glyphs, weather icons and sample lines/);
    assert.ok(fs.statSync(shot).size > 10000);
    assert.ok(fs.statSync(shot.replace(/\.png$/, '@2.png')).size > 10000);
  } finally {
    fs.rmSync(path.dirname(shot), { recursive: true, force: true });
  }
});

test('Chrome computes the base styles and the cell as designed (TermMono, ligatures off, art at line-height normal)', { skip: noBrowser, timeout: 120000 }, async () => {
  const dir = G.buildSite(ROOT, makeTempDir('pcd-gate-css-'), 'MW');
  const srv = await serve(dir);
  const browser = await launch();
  try {
    const page = await browser.newPage(srv.url + 'index.html');
    await page.waitFor('window.__gate && window.__gate.ready', { timeoutMs: 20000 });
    const r = await page.evaluate(() => {
      const cs = (el) => getComputedStyle(el);
      const body = cs(document.body);
      const art = document.createElement('pre');
      art.className = 'pcd-art';
      art.textContent = '╭─╮';
      document.body.appendChild(art);
      const accent = document.createElement('span');
      accent.className = 't-accent t-bold';
      document.body.appendChild(accent);
      const moving = document.createElement('div');
      moving.style.transition = 'color 1s linear';
      moving.style.animation = 'x 1s infinite';
      document.body.appendChild(moving);
      const before = cs(moving).animationName;
      document.documentElement.classList.add('pcd-reduced');
      const after = cs(moving).animationName;
      const cell = PCD.font.measureCell({ sizePx: 24, dpr: 1 });
      return {
        family: body.fontFamily, ligatures: body.fontVariantLigatures, kerning: body.fontKerning, synthesis: body.fontSynthesis,
        weight: body.fontWeight, bg: body.backgroundColor, color: body.color, artLine: cs(art).lineHeight, artFamily: cs(art).fontFamily,
        accent: cs(accent).color, accentWeight: cs(accent).fontWeight, transition: cs(moving).transitionDuration, before, after,
        cell: cell && { w: cell.w, h: cell.h }, active: PCD.font.active(), font: window.__gate.font,
      };
    });
    assert.match(r.family, /^TermMono, "Cascadia Mono", Consolas, monospace$/);
    assert.equal(r.ligatures, 'none');
    assert.equal(r.kerning, 'none');
    assert.equal(r.synthesis, 'none');
    assert.equal(r.weight, '400');
    assert.equal(r.bg, 'rgb(20, 16, 22)');
    assert.equal(r.color, 'rgb(236, 228, 216)');
    assert.equal(r.artLine, 'normal');
    assert.match(r.artFamily, /^TermMono/);
    assert.equal(r.accent, 'rgb(255, 154, 60)');
    assert.equal(r.accentWeight, '600');
    assert.equal(r.transition, '0s', 'no transitions');
    assert.equal(r.before, 'x');
    assert.equal(r.after, 'none', 'html.pcd-reduced stops animations');
    assert.deepEqual(r.cell, { w: 14, h: 28 }, 'TermMono 24 px at dpr 1 (the 1920x1080 wallpaper cell)');
    assert.equal(r.active, 'cascadia');
    assert.equal(r.font.loaded, true);
    assert.deepEqual(page.errors, []);
  } finally {
    await browser.close();
    await srv.close();
    await rmrf(dir);
  }
});
