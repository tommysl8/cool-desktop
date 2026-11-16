// design/tokens.json, tools/lib/tokens.mjs and the derived colours of PCD.color: the palette, the contrast table, the
// generated files, the build gate, and the clock colour for every theme at 3, 7, 12 and 19 h.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { ROOT, lib, sandbox, engineScripts, tokensScript, plain } from './look-load.mjs';

const T = await lib('tools/lib/tokens.mjs');
const { contrast } = await lib('tools/lib/color.mjs');
const { readJsonStrict } = await lib('tools/lib/fsx.mjs');
const { isSafeChar } = await lib('tools/lib/glyphs.mjs');

/** The palette, value for value. */
const PALETTE = {
  bg: '#141016', panel: '#1d181f', field: '#2a2229', line: '#3a3138', text: '#ece4d8', muted: '#a99d91', faint: '#978d83',
  accent: '#ff9a3c', frame: '#9a6a40', ring: '#c47a2c', wood: '#6b4428', 'wood-dark': '#4a2e1a',
};
/** The published contrast figures (on bg, on panel, on field); null = not listed. */
const RATIOS = {
  text: [14.9, 13.9, 12.3], muted: [7.1, 6.6, 5.8], faint: [5.8, 5.4, 4.7], accent: [8.9, 8.3, 7.3], frame: [4.0, 3.8, 3.3],
  ring: [5.5, 5.1, 4.5], wood: [2.2, null, null],
};
const HOURS = [3, 7, 12, 19];

function tempRootWith(doc) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pcd-tokens-test-'));
  fs.mkdirSync(path.join(dir, 'design'));
  fs.writeFileSync(path.join(dir, 'design', 'tokens.json'), JSON.stringify(doc, null, 2) + '\n');
  return dir;
}

test('tokens.json: strict JSON, UTF-8 without BOM, LF, valid', () => {
  const buf = fs.readFileSync(path.join(ROOT, 'design', 'tokens.json'));
  assert.notEqual(buf[0], 0xef, 'no BOM');
  assert.ok(!buf.includes(0x0d), 'no CR');
  const doc = readJsonStrict(path.join(ROOT, 'design', 'tokens.json'));
  assert.deepEqual(T.validateTokens(doc), []);
  for (const [name, c] of Object.entries(doc.colors)) for (const ch of c.role) assert.ok(isSafeChar(ch), `${name}.role: ${ch} is outside the safe set`);
});

test('palette: every token with its value, and no other', () => {
  const doc = T.loadTokens(ROOT);
  for (const [name, value] of Object.entries(PALETTE)) assert.equal(T.colorOf(doc, name), value, name);
  assert.deepEqual(Object.keys(doc.colors).sort(), Object.keys(PALETTE).sort());
  assert.deepEqual(Object.keys(doc.colors).sort(), [...T.REQUIRED_COLORS].sort());
});

test('palette: the clock tokens equal the clock\'s simulator/style.css (read-only; skipped without the clock repo)', (t) => {
  const repo = process.env.PCD_PIXELCLOCK || path.resolve(ROOT, '..', 'PixelClock');
  const css = path.join(repo, 'simulator', 'style.css');
  if (!fs.existsSync(css)) { t.skip(`no ${css}`); return; }
  const text = fs.readFileSync(css, 'utf8');
  const rootBlock = /:root\s*\{([^}]*)\}/.exec(text);
  assert.ok(rootBlock, 'style.css has a :root block');
  const vars = Object.fromEntries([...rootBlock[1].matchAll(/--([a-z-]+):\s*(#[0-9a-fA-F]{6})/g)].map((m) => [m[1], m[2].toLowerCase()]));
  const doc = T.loadTokens(ROOT);
  const fromClock = Object.entries(doc.colors).filter(([, c]) => c.source === 'clock').map(([n]) => n);
  assert.ok(fromClock.length >= 10);
  for (const name of fromClock) {
    if (name === 'ring') assert.ok(text.toLowerCase().includes(T.colorOf(doc, 'ring')), 'ring is the alarm glow border of style.css');
    else assert.equal(T.colorOf(doc, name), vars[name], `--${name}`);
  }
});

test('contrast: every gated pair passes and matches its published figure', () => {
  const doc = T.loadTokens(ROOT);
  const rows = T.contrastReport(doc);
  assert.ok(rows.length >= 18);
  for (const r of rows) {
    assert.ok(r.pass, T.describeRow(r));
    assert.equal(r.ratio, contrast(r.fg, r.bg));
    if (r.design !== null) assert.ok(Math.abs(r.ratio - r.design) <= 0.06, `${T.describeRow(r)}: the table says ${r.design}`);
  }
  const on = ['bg', 'panel', 'field'];
  for (const [token, figures] of Object.entries(RATIOS)) {
    figures.forEach((f, i) => {
      if (f === null) return;
      const ratio = contrast(T.colorOf(doc, token), T.colorOf(doc, on[i]));
      assert.ok(Math.abs(ratio - f) <= 0.06, `${token} on ${on[i]}: ${ratio.toFixed(3)} vs the published ${f}`);
    });
  }
  // text tokens >= 4.5 on bg and panel; frame >= 3 (the build gate)
  for (const token of ['text', 'muted', 'faint', 'accent']) for (const bg of ['bg', 'panel']) assert.ok(rows.some((r) => r.token === token && r.against === bg && r.min === 4.5), `${token}/${bg} gated at 4.5`);
  for (const bg of ['bg', 'panel']) assert.ok(rows.some((r) => r.token === 'frame' && r.against === bg && r.min === 3), `frame/${bg} gated at 3`);
});

test('contrast: the faint lift: 4.5:1 on field too; decorative pairs stay reported', () => {
  const doc = T.loadTokens(ROOT);
  const info = T.infoRows(doc);
  // lifted from #8b8178 (4.05:1 on field, so it was never used there) to #978d83: every faint run over the dimmed
  // scene keeps 4.5:1, and the field pair is now gated
  const field = T.contrastReport(doc).find((r) => r.token === 'faint' && r.against === 'field');
  assert.ok(field && field.pass && field.min === 4.5 && Math.abs(field.ratio - 4.75) < 0.01, field && T.describeRow(field));
  assert.ok(contrast('#8b8178', T.colorOf(doc, 'field')) < 4.5, 'the old value missed 4.5:1 on field');
  assert.ok(contrast(T.colorOf(doc, 'faint'), T.colorOf(doc, 'muted')) > 1.2, 'faint stays a step below muted');
  assert.ok(contrast(T.colorOf(doc, 'faint'), T.colorOf(doc, 'bg')) < contrast(T.colorOf(doc, 'muted'), T.colorOf(doc, 'bg')));
  const wood = info.find((r) => r.kind === 'decorative' && r.token === 'wood');
  assert.ok(Math.abs(wood.ratio - 2.2) < 0.06);
});

test('generate(): tokens.css and pcd-tokens.js, deterministic, rows for the build', async () => {
  const a = await T.generate({ root: ROOT });
  const b = await T.generate({ root: ROOT });
  assert.deepEqual(Object.keys(a.files).sort(), ['pcd-tokens.js', 'tokens.css']);
  assert.equal(a.files['tokens.css'], b.files['tokens.css']);
  assert.equal(a.files['pcd-tokens.js'], b.files['pcd-tokens.js']);
  assert.ok(a.rows.length >= 18 && a.rows.every((r) => r.pass));
  for (const text of Object.values(a.files)) {
    assert.ok(!text.includes('\r') && text.endsWith('\n'));
    for (const ch of text) if (ch !== '\n') assert.ok(isSafeChar(ch), `generated text has ${ch}`);
  }
  assert.ok(/^[\x0a\x20-\x7e]*$/.test(a.files['pcd-tokens.js']), 'pcd-tokens.js is pure ASCII');
});

test('tokens.css: every token, the run-time default, the font stack, no other values', async () => {
  const doc = T.loadTokens(ROOT);
  const css = (await T.generate({ root: ROOT })).files['tokens.css'];
  for (const name of Object.keys(doc.colors)) assert.match(css, new RegExp(`\\n  --${name}: ${T.colorOf(doc, name)}; /\\*`), name);
  assert.match(css, /--clock: #ece4d8;/);
  assert.deepEqual(Object.keys(T.RUNTIME_VARS), ['clock']);
  assert.match(css, /--mono: TermMono, 'Cascadia Mono', Consolas, monospace;/);
  assert.match(css, /--weight: 400;/);
  assert.match(css, /--weight-bold: 600;/);
  assert.match(css, /color-scheme: dark;/);
  assert.equal((css.match(/\{/g) || []).length, 1, 'one :root block');
  assert.ok(!/gradient|shadow|blur|filter|animation|transition/i.test(css.replace(/\/\*[\s\S]*?\*\//g, '')));
});

test('pcd-tokens.js: PCD.TOKENS in a page-like sandbox and through require()', async () => {
  const doc = T.loadTokens(ROOT);
  const js = (await T.generate({ root: ROOT })).files['pcd-tokens.js'];
  const ctx = sandbox([{ name: 'pcd-tokens.js', code: js }]);
  const K = plain(ctx.PCD.TOKENS);
  assert.deepEqual(K, plain(T.tokensTable(doc)));
  assert.equal(K.version, 1);
  assert.deepEqual(K.names, Object.keys(doc.colors));
  for (const name of K.names) {
    assert.equal(K[name], T.colorOf(doc, name));
    assert.equal(K.int[name], parseInt(K[name].slice(1), 16));
    assert.equal(K.css[name], `--${name}`);
  }
  assert.equal(K.woodDark, '#4a2e1a');
  assert.equal(K.int.woodDark, 0x4a2e1a);
  assert.deepEqual(K.derived.clock, { mix: 0.25, toward: 'text', min: 4.5, on: 'bg', fallback: 'text' });
  assert.equal(K.derived.bar.gain, 1.4);
  assert.deepEqual(Object.keys(K.derived).sort(), ['bar', 'clock'], 'the strip bar and the clock colour');
  assert.deepEqual(K.never, []);
  assert.equal(K.type.stack, "TermMono, 'Cascadia Mono', Consolas, monospace");
  assert.deepEqual(K.type.weights, { normal: 400, bold: 600 });
  assert.deepEqual(K.type.div, { wallpaper: 48, still: 48, newtab: 44 });
  assert.deepEqual(K.type.ladder.newtab, [14, 16, 20, 24, 28, 32, 36, 40, 48, 56, 64]);
  assert.equal(K.contrast.length, doc.contrast.pairs.length);
  // Node (CommonJS): module.exports is the same table
  const mod = { exports: {} };
  vm.runInNewContext(js, { module: mod, globalThis: {} });
  assert.deepEqual(plain(mod.exports), K);
});

test('the gate stops the build: a failing pair, a bad colour, a broken ladder', async () => {
  const good = T.loadTokens(ROOT);
  const cases = [
    [(d) => { d.colors.muted.value = '#3a3138'; }, /contrast gate failed/],
    [(d) => { d.colors.frame.value = '#3a3138'; }, /frame/],
    [(d) => { d.colors.text.value = 'ece4d8'; }, /not #rrggbb/],
    [(d) => { delete d.colors.faint; }, /colors\.faint: missing/],
    [(d) => { d.contrast.pairs.push({ fg: 'text', on: 'nope', min: 4.5 }); }, /unknown colour/],
    [(d) => { d.type.ladder.newtab = [16, 14]; }, /ascending/],
    [(d) => { d.derived.clock.mix = 2; }, /derived\.clock/],
    [(d) => { d.contrast.never.push({ fg: 'faint', on: 'nope' }); }, /never\[0\]\.on: unknown colour "nope"/],
    [(d) => { d.colors.names = { value: '#000000', source: 'x', role: 'y' }; }, /reserved/],
    [(d) => { d.colors.text.role = 'a */ b'; }, /CSS comment/],
  ];
  for (const [mutate, re] of cases) {
    const doc = structuredClone(good);
    mutate(doc);
    const dir = tempRootWith(doc);
    try {
      await assert.rejects(T.generate({ root: dir }), re);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('contrastRows(): the validator\'s rows; the build\'s generate stage uses the module', async () => {
  const rows = T.contrastRows({ root: ROOT });
  for (const r of rows) for (const k of ['token', 'against', 'ratio', 'min', 'pass']) assert.ok(k in r, k);
  const { generateStage } = await lib('tools/build.mjs');
  const { loadConfig } = await lib('tools/lib/config.mjs');
  const gen = await generateStage({ root: ROOT, config: loadConfig(ROOT).config, vendor: path.join(ROOT, 'vendor', 'pixelclock') });
  assert.equal(gen.generated['tokens.css'], (await T.generate({ root: ROOT })).files['tokens.css']);
  assert.ok(typeof gen.generated['pcd-tokens.js'] === 'string');
  assert.ok(gen.rows.length >= 18);
  assert.ok(gen.notes.some((n) => /contrast gate PASS/.test(n)));
});

test('built-in copies stay equal to tokens.json: PCD.color.FALLBACK and PCD.font.DEFAULT_TYPE', () => {
  const doc = T.loadTokens(ROOT);
  const ctx = sandbox(['src/shared/pcd-core.js', 'src/shared/pcd-font.js']);
  const F = plain(ctx.PCD.color.FALLBACK);
  for (const name of Object.keys(doc.colors)) assert.equal(F.colors[name], parseInt(T.colorOf(doc, name).slice(1), 16), name);
  assert.deepEqual(Object.keys(F.colors).sort(), Object.keys(doc.colors).sort());
  assert.deepEqual(F.derived, plain(T.tokensTable(doc).derived));
  const D = plain(ctx.PCD.font.DEFAULT_TYPE);
  assert.deepEqual(D, { ladder: doc.type.ladder, div: doc.type.div, floor: doc.type.floor });
  assert.equal(ctx.PCD.font.STACK, doc.type.stack);
  assert.equal(ctx.PCD.font.FILE, doc.type.file);
  assert.equal(ctx.PCD.font.TIMEOUT_MS, doc.type.fontTimeoutMs);
});

test('derived clock: mix(theme clock, text, 0.25) for all 13 themes at 3, 7, 12 and 19 h, never the fallback', async () => {
  const ctx = sandbox([...(await engineScripts()), await tokensScript(), 'src/shared/pcd-core.js']);
  const { PixelClock: PC, PCD } = ctx;
  const bg = PCD.TOKENS.bg;
  let min = null;
  let max = null;
  const ids = [];
  for (const theme of PC.themes) {
    ids.push(theme.id);
    for (const hour of HOURS) {
      const inst = theme.create(new PC.Rng(12345));
      const c = { hours: hour, minutes: 0, seconds: 0, ms: 0, hourFloat: hour, year: 2026, month: 11, day: 15, hour12: true, showDate: true, shake: false };
      for (let i = 0; i < 45; i++) inst.update(1 / 30, c);
      PCD.hook.mode = 'none';
      inst.draw(new PC.Canvas(), c);
      const themeClock = PCD.hook.colors.clock;
      const out = PCD.color.clock(themeClock);
      const mixed = PCD.color.hex(PCD.color.mix(themeClock, PCD.TOKENS.text, 0.25));
      assert.equal(out, mixed, `${theme.id} ${hour} h: no fallback needed`);
      const ratio = contrast(out, bg);
      assert.ok(ratio >= 4.5, `${theme.id} ${hour} h: ${ratio}`);
      if (!min || ratio < min.ratio) min = { ratio, out, id: theme.id };
      if (!max || ratio > max.ratio) max = { ratio, out, id: theme.id };
    }
  }
  assert.equal(ids.length, 13);
  // the clock colours: from 9.3 (haunted hill, #faa24a) to 17.8 (white clocks become #faf8f5)
  assert.equal(min.id, 'halloween');
  assert.equal(min.out, '#faa24a');
  assert.ok(Math.abs(min.ratio - 9.3) < 0.05, String(min.ratio));
  assert.equal(max.out, '#faf8f5');
  assert.ok(Math.abs(max.ratio - 17.8) < 0.05, String(max.ratio));
  // the fallback: a clock colour that would be too dark on bg gives text
  assert.equal(PCD.color.clock(0x101010), PCD.TOKENS.text);
  assert.equal(PCD.color.clock(null), PCD.TOKENS.text);
});

test('derived strip bars', () => {
  const ctx = sandbox(['src/shared/pcd-core.js']);
  const C = ctx.PCD.color;
  assert.equal(C.bar(0), '#3a3138');
  assert.equal(C.bar(1 / 1.4), '#6b4428');
  assert.equal(C.bar(1), '#6b4428');
  assert.equal(C.bar(0.25), C.hex(C.mix(0x3a3138, 0x6b4428, 0.35)));
  assert.equal(C.bar(NaN), '#3a3138');
});
