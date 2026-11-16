// The still's glyph atlas: design/atlas/ holds every glyph the still draws at every type size it uses; the PNGs match
// atlas.json; and a fresh headless Chrome measures the same cells (|advance - atlas| < 0.01).
// The browser part uses tools/lib/chrome.mjs (a fresh temp profile, the privacy guard on, 127.0.0.1 only).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { test } from 'node:test';
import { pngSize } from '../tools/lib/png.mjs';
import { findBrowser } from '../tools/lib/chrome.mjs';
import { atlasSizes, measureSize, sha256File, withAtlasPage } from '../tools/make-atlas.mjs';
import { ASCII, ATLAS_CHARS, ATLAS_FILE, atlasText, EXTRAS, FALLBACK_CHAR, loadAtlas, WEIGHTS } from '../src/still/lib/atlas.mjs';
import { decodePng } from '../src/still/lib/png.mjs';
import { isSafeChar } from '../tools/lib/glyphs.mjs';
import { engineDeps, REPO } from './still-helpers.mjs';
import { loadEngine } from '../src/still/lib/scene.mjs';

const DIR = path.join(REPO, 'design', 'atlas');
/** A character by code point (this file stays inside the safe glyph set). */
const u = (cp) => String.fromCodePoint(cp);
const META = JSON.parse(fs.readFileSync(path.join(DIR, ATLAS_FILE), 'utf8'));
const require = createRequire(import.meta.url);

test('atlas.json: version, font, every size of the still\'s ladder, the glyph lists', () => {
  assert.equal(META.v, 1);
  assert.equal(META.font.family, 'TermMono');
  assert.equal(META.font.sha256, sha256File(path.join(REPO, 'design', 'fonts', 'CascadiaMono-wght.ttf')), 'rendered from the bundled font (regenerate after a font change)');
  const sizes = atlasSizes();
  assert.deepEqual(Object.keys(META.sizes).map(Number).sort((a, b) => a - b), sizes, 'exactly the type sizes the still uses');
  assert.deepEqual(sizes, [16, 20, 24, 28, 32, 36, 40, 48, 56, 64], 'the wallpaper and still type ladder');
  assert.equal(META.chars[400], ATLAS_CHARS[400]);
  assert.equal(META.chars[600], ATLAS_CHARS[600]);
  for (const ch of META.chars[400] + META.chars[600]) assert.ok(isSafeChar(ch), `${ch} is in the safe glyph set`);
  assert.ok(ATLAS_CHARS[400].startsWith(ASCII) && ATLAS_CHARS[400].endsWith(EXTRAS));
});

test('every PNG matches atlas.json (size, grey 8-bit) and every glyph has ink at every size and weight', () => {
  for (const [px, s] of Object.entries(META.sizes)) {
    const file = path.join(DIR, s.png);
    const info = pngSize(file);
    assert.deepEqual([info.width, info.height, info.bitDepth, info.colorType], [s.width, s.height, 8, 0], `${s.png}: ${s.width}x${s.height} grey`);
    assert.equal(s.slotW, s.cellW + 2 * s.padX);
    assert.equal(s.slotH, s.cellH + 2 * s.padY);
    assert.equal(s.width, s.cols * s.slotW);
    const rows = WEIGHTS.reduce((n, w) => n + Math.ceil(META.chars[w].length / s.cols), 0);
    assert.equal(s.height, rows * s.slotH);
    const img = decodePng(fs.readFileSync(file));
    for (const w of WEIGHTS) {
      Array.from(META.chars[w]).forEach((ch, i) => {
        const col = i % s.cols;
        const row = s.rows[w] + Math.floor(i / s.cols);
        let ink = 0;
        for (let y = 0; y < s.slotH; y++) for (let x = 0; x < s.slotW; x++) ink += img.data[(row * s.slotH + y) * s.width + col * s.slotW + x];
        if (ch === ' ') assert.equal(ink, 0, `${px} px ${w}: the space is blank`);
        else assert.ok(ink > 0, `${px} px ${w}: ${JSON.stringify(ch)} has ink`);
      });
    }
  }
});

test('the loader: faces, glyph masks with their ink box, the fallback for a glyph it lacks', () => {
  const atlas = loadAtlas(DIR);
  assert.deepEqual(atlas.sizes, atlasSizes());
  const f = atlas.face(32);
  assert.deepEqual([f.cellW, f.cellH], [18, 38]);
  const a = f.glyph('a');
  assert.ok(a.ink && a.ink.x0 >= f.padX - 2 && a.ink.x1 <= f.padX + f.cellW + 2, 'a sits in its cell');
  const shade = f.glyph('░');
  assert.ok(shade.ink.y0 <= f.padY + 1 && shade.ink.y1 >= f.padY + f.cellH - 1, 'the shade fills its cell from top to bottom');
  assert.notDeepEqual([...f.glyph('a', 600).data], [...a.data], '600 is its own glyph');
  assert.equal(f.glyph(' ').ink, null);
  assert.equal(f.glyph(`${u(0xfc)}`).ch, FALLBACK_CHAR, 'a glyph it lacks draws the fallback');
  assert.equal(f.glyph('░', 600).weight, 400, '600 falls back to 400 for a glyph only 400 has');
  assert.throws(() => atlas.face(18), /no 18 px face/);
});

test('user text is folded into atlas glyphs: accents dropped, a few letters spelled out, anything else ?', () => {
  assert.equal(atlasText(`m${u(0xfc)}nchen`), 'munchen');
  assert.equal(atlasText(`s${u(0xe3)}o paulo`), 'sao paulo');
  assert.equal(atlasText(`krak${u(0xf3)}w ${u(0x142)}${u(0xf3)}d${u(0x17a)}`), 'krakow lodz');
  assert.equal(atlasText(`stra${u(0xdf)}e`), 'strasse');
  assert.equal(atlasText('saint-louis, mo'), 'saint-louis, mo');
  assert.equal(atlasText(`${u(0x6771)}${u(0x4eac)}`), '??');
  for (const s of [`m${u(0xfc)}nchen`, `${u(0xe5)}${u(0xe6)}${u(0xf8)}`, `x${u(0x2014)}y`]) for (const ch of atlasText(s)) assert.ok(ATLAS_CHARS[400].includes(ch));
});

test('every text the still draws is in the atlas (greetings, holidays, dates, weather, strip, captions)', () => {
  const eng = loadEngine(engineDeps());
  const { PC, PCD } = eng;
  const C = PCD.console;
  const have = { 400: new Set(ATLAS_CHARS[400]), 600: new Set(ATLAS_CHARS[600]) };
  const missing = new Set();
  const check = (runs) => {
    for (const r of runs || []) for (const ch of r.text) if (!have[r.bold ? 600 : 400].has(ch)) missing.add(`${ch} (${r.bold ? 600 : 400})`);
  };
  const L = C.compute({ cssW: 3840, cssH: 2160, dpr: 1, profile: 'still', side: 'right', taskbar: 56, parts: { weather: true, weatherW: 30, face: 'date' } });
  const wx = (kind, units) => ({ data: { temp: -12, feels: -20, wind: 123, high: 105, low: -40, kind, description: kind === 'partly' ? 'partly cloudy' : kind, isDay: true }, units, city: 'berlin', ageMs: 3 * 3600000 });
  for (let m = 0; m < 12; m++) {
    for (const day of [1, 15, 28]) {
      for (let h = 0; h < 24; h += 1) {
        const now = new Date(2026, m, day, h, 30);
        const V = C.view({ now, clock24: h % 2 === 0, theme: PC.themes[(m + h) % PC.themes.length].id, tag: h % 3 ? 'auto' : 'pinned', phase: ['dawn', 'day', 'sunset', 'night'][h % 4], face: 'date', sun: { rise: 7.25, set: 16.75 }, weather: wx(['clear', 'partly', 'cloudy', 'fog', 'drizzle', 'rain', 'freezing', 'snow', 'thunder', 'unknown'][h % 10], h % 2 ? 'F' : 'C') }, 'still');
        const ct = C.content(V, L);
        for (const part of Object.values(ct)) {
          if (!part) continue;
          for (const p of Array.isArray(part) ? part : [part]) {
            for (const line of (p.block || [])) check(line);
            if (p.shadow) for (const line of p.shadow) check(line);
            if (p.side) for (const line of p.side.block) check(line);
          }
        }
      }
    }
  }
  for (const y of [2026, 2027]) for (const d of PCD.greet.ownDates(y, PC)) check(PCD.greet.parts(new Date(y, d.month - 1, d.day, 19), PC).runs.map(([t, roles]) => ({ text: t, bold: /bold/.test(roles) })));
  assert.deepEqual([...missing], [], 'glyphs the still would draw but the atlas lacks');
  assert.ok(require.cache, 'loaded through require');
});

test('a fresh headless Chrome measures the atlas cells (|advance - atlas| < 0.01, cells and baselines equal)', { skip: !findBrowser() && 'no Chrome or Edge' }, async () => {
  const eng = loadEngine(engineDeps());
  const termCell = eng.PCD.layout.termCell;
  const got = await withAtlasPage(async (page) => {
    const out = {};
    for (const px of atlasSizes()) out[px] = await measureSize(page, px);
    return out;
  });
  for (const [px, s] of Object.entries(META.sizes)) {
    const m = got[px];
    assert.ok(Math.abs(m.advance - s.advance) < 0.01, `${px} px: advance ${m.advance} vs atlas ${s.advance}`);
    assert.ok(Math.abs(m.canvasAdvance - s.advance) < 0.01, `${px} px: canvas measureText ${m.canvasAdvance} vs atlas ${s.advance}`);
    assert.equal(Math.floor(m.advance + 1e-6), s.cellW, `${px} px cellW`);
    assert.equal(Math.floor(m.lineHeight + 1e-6), s.cellH, `${px} px cellH`);
    assert.equal(Math.round(m.baseline), s.baseline, `${px} px baseline`);
    const t = termCell(Number(px), 1);
    assert.deepEqual([t.wDev, t.hDev], [s.cellW, s.cellH], `${px} px: PCD.layout.termCell agrees`);
  }
});
