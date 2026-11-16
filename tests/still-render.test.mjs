// Still renderer and compositor: the wallpaper's scene layer (PCD.bleed) and column (PCD.console, profile still) drawn
// in pure Node with the glyph atlas; exact sizes (portrait too), crisp k x k blocks with pcd-bleed's k, no time digits,
// the big date, both column sides, the weather switches, the 4K budget as the best of N fresh runs, the PNG codec.
// Berlin sample weather through a fake fetch; no network; nothing is ever set.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import zlib from 'node:zlib';
import { decodePng as decodeRgba, encodePng as encodeRgba } from '../tools/lib/png.mjs';
import { BUDGET, bestOf, checkPicture } from '../tools/test-still.mjs';
import { main, parseArgs } from '../src/still/pcd-still.mjs';
import { createImage, fillRect, hex, pixel } from '../src/still/lib/compose.mjs';
import { drawRuns, loadAtlas } from '../src/still/lib/atlas.mjs';
import { atlasMeasure, consoleView, DEFAULT_SIDE, plan as planPicture, SIDES } from '../src/still/lib/frames.mjs';
import { decodePng, encodePng } from '../src/still/lib/png.mjs';
import { chooseTheme, daySeed, loadEngine, renderScene, timeParts } from '../src/still/lib/scene.mjs';
import { normalizeStill, pageTokens, readTokens, STILL_DEFAULTS, TOKEN_DEFAULTS } from '../src/still/lib/env.mjs';
import { collect, engineDeps, fakeFetch, REPO, rm, safeEnv, STILL, tempHome } from './still-helpers.mjs';

// the sample city's zone: its sun times then label the strip, whatever zone this machine is in
process.env.TZ = 'Europe/Berlin';

const AT = '2026-11-15T16:30';
const SIZES = [
  { width: 1920, height: 1080, scale: 1, k: 18 },
  { width: 2560, height: 1440, scale: 1, k: 25 },
  { width: 2560, height: 1600, scale: 2, k: 26 },
  { width: 3840, height: 2160, scale: 1, k: 37 },
];
/** Portrait screens: the type follows 0.9 x the width, so the column takes about half of it; the scene is cropped evenly. */
const PORTRAIT = [
  { width: 1080, height: 1920, scale: 1, k: 30, step: 20 },
  { width: 1440, height: 2560, scale: 1, k: 40, step: 28 },
];
const BERLIN = { width: 0, height: 0, scale: 1, theme: 'auto', clock24: false, units: 'C', city: 'Berlin', sunTimes: true, weather: true, weatherFx: true, taskbar: 56 };

const eng = loadEngine(engineDeps());
const { PC, PCD } = eng;
const atlas = loadAtlas(path.join(REPO, 'design', 'atlas'));
const deps = (extra = {}) => ({ env: safeEnv(), stillDir: STILL, engine: engineDeps(), fetch: () => { throw new Error('no network in tests'); }, ...collect(), ...extra });

/** Render through main() with --out; resolves { code, file, pic, d }. */
async function render(dir, name, argv, extra = {}) {
  const file = path.join(dir, name);
  let pic = null;
  const d = deps({ onPicture: (p) => { pic = p; }, ...extra });
  const code = await main(['--out', file, ...argv], d);
  return { code, file, pic, d };
}

test('png: the encoder round-trips grey, RGB and RGBA through every filter; it reads other encoders\' PNGs', () => {
  const W = 37;
  const H = 23;
  for (const ch of [1, 3, 4]) {
    const data = Buffer.alloc(W * H * ch);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W * ch; x++) {
        // a gradient (Sub), repeated rows (Up), noise (None)
        data[y * W * ch + x] = y < 8 ? (x * 7) & 255 : y < 16 ? (8 * 31 + x) & 255 : (x * 2654435761 + y * 40503) >>> 24;
      }
    }
    for (let y = 9; y < 14; y++) data.copy(data, y * W * ch, 8 * W * ch, 9 * W * ch);
    const png = encodePng(W, H, data, ch);
    const back = decodePng(png);
    assert.deepEqual([back.width, back.height, back.channels], [W, H, ch]);
    assert.ok(back.data.equals(data), `${ch} channels round trip`);
    assert.ok(encodePng(W, H, data, ch).equals(png), 'deterministic');
  }
  // tools/lib/png.mjs (Sub on every row, RGBA) and render.js's png() (None on every row, RGB) decode alike
  const rgba = Buffer.alloc(5 * 4 * 4).map((_, i) => (i * 13) & 255);
  const viaTools = decodePng(encodeRgba({ width: 5, height: 4, data: rgba, channels: 4 }));
  assert.ok(viaTools.data.equals(rgba));
  const rgb = Buffer.alloc(6 * 3 * 3).map((_, i) => (i * 29) & 255);
  const viaRender = decodePng(eng.png(6, 3, rgb));
  assert.ok(viaRender.data.equals(rgb));
  // a repeated row compresses to almost nothing: a flat 3840x2160 picture stays tiny
  const flat = createImage(3840, 2160, 0x141016);
  assert.ok(encodePng(3840, 2160, flat.data, 3).length < 30000);
  assert.throws(() => decodePng(Buffer.from('not a png')), /not a PNG/);
  assert.throws(() => encodePng(2, 2, Buffer.alloc(5), 3), /expected 12 bytes/);
  assert.ok(zlib.crc32, 'node:zlib crc32 (Node 22+)');
});

test('compose and the atlas: rects, pixels, glyphs on whole cells in token colours, bold its own glyphs', () => {
  const img = createImage(10, 8, 0x112233);
  assert.equal(pixel(img, 9, 7), 0x112233);
  fillRect(img, 8, 6, 5, 5, 0xabcdef);
  assert.equal(pixel(img, 9, 7), 0xabcdef);
  assert.equal(pixel(img, 7, 7), 0x112233);
  assert.equal(hex(0x0a0b0c), '#0a0b0c');
  const face = atlas.face(32);
  const W = face.cellW * 6;
  const H = face.cellH * 2;
  const a = createImage(W, H, 0x141016);
  const n = drawRuns(a, face, 0, 0, [{ text: 'ab ', tone: 'text' }, { text: 'ab', tone: 'muted', bold: true }], (t) => (t === 'muted' ? 0xa99d91 : 0xece4d8));
  assert.equal(n, 5);
  let ink = 0;
  let outside = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (pixel(a, x, y) === 0x141016) continue;
      ink++;
      if (y >= face.cellH + face.padY || x >= 5 * face.cellW + face.padX) outside++;
    }
  }
  assert.ok(ink > 100, 'glyphs drawn');
  assert.equal(outside, 0, 'no ink past the five cells (and their anti-aliasing)');
  const cellInk = (c) => {
    let s = 0;
    for (let y = 0; y < face.cellH; y++) for (let x = c * face.cellW; x < (c + 1) * face.cellW; x++) if (pixel(a, x, y) !== 0x141016) s++;
    return s;
  };
  assert.equal(cellInk(2), 0, 'the space is blank');
  assert.ok(cellInk(3) > cellInk(0), 'a bold a is heavier than a regular a');
});

test('plan: the wallpaper\'s own column (PCD.console, profile still, atlas cells) and scene layer (PCD.bleed), landscape and portrait', () => {
  for (const s of [...SIZES, ...PORTRAIT]) {
    for (const side of SIDES) {
      const view = { width: s.width, height: s.height, scale: s.scale, side, taskbar: 56, date: new Date(2026, 10, 15, 16, 37), clock24: false, day: { id: 'autumn', name: 'Autumn Forest', tag: 'auto', phase: 'sunset' }, PC, PCD, atlas };
      const p = planPicture(view);
      const cssW = s.width / s.scale;
      const cssH = s.height / s.scale;
      const L = PCD.console.compute({ cssW, cssH, dpr: s.scale, profile: 'still', side, taskbar: 56, measure: atlasMeasure(atlas, s.scale), parts: PCD.console.partsOf(consoleView(view), 'still') });
      assert.deepEqual(p.L, L, 'the plan is PCD.console.compute');
      const geo = PCD.bleed.fit({ cssW, cssH, dpr: s.scale, side, cell: L.cell, reach: side === 'right' ? cssW - L.edge.x : L.edge.x, bottomCss: L.taskbar.dev / s.scale, statusTop: L.rows.foot * L.cell.h, caption: null });
      assert.deepEqual(p.geo, geo, 'the scene layer is PCD.bleed.fit fed as the console feeds the live one');
      assert.equal(p.k, s.k, `${s.width}x${s.height}@${s.scale} ${side}: k`);
      assert.equal(p.step, PCD.console.parts.fontStep(cssH, s.scale, 'wallpaper', cssW), 'the wallpaper\'s type step: the height\'s, or 0.9 x the width\'s when less');
      if (s.step) assert.equal(p.step, s.step, `${s.width}x${s.height}: type ${s.step} px`);
      assert.equal(p.face.cellW, L.cell.wDev);
      assert.equal(p.sceneClock, 'none');
      if (s.width < s.height) assert.equal(geo.place, 'crop', 'a portrait screen crops the scene evenly');
      else assert.equal(geo.edge, side, 'the band runs under the column');
    }
  }
  assert.equal(DEFAULT_SIDE, 'right');
});

for (const s of [...SIZES, PORTRAIT[0]]) {
  test(`render ${s.width}x${s.height} (scale ${s.scale}), column right and left: size, crisp ${s.k} x ${s.k} blocks, no time digits, the big date, the column`, async () => {
    const home = tempHome(BERLIN);
    const dir = tempHome();
    try {
      for (const side of SIDES) {
        const r = await render(dir, `${side}.png`, ['--home', home, '--size', `${s.width}x${s.height}`, '--scale', String(s.scale), '--side', side, '--at', AT], { fetch: fakeFetch() });
        assert.equal(r.code, 0, r.d.text());
        assert.match(r.d.out.join('\n'), new RegExp(`autumn \\(auto\\) ${s.width}x${s.height} k=${s.k} side ${side}, type ${r.pic.plan.step} px, sunset, weather ok`));
        const t = timeParts(new Date(AT));
        const pick = chooseTheme(eng, { theme: 'auto', year: t.year, month: t.month, day: t.day });
        const seed = daySeed(eng, pick.id, t.year, t.month, t.day);
        const R = r.pic.render;
        assert.deepEqual([R.id, R.seed, R.hookMode], [pick.id, seed, 'none']);
        const independent = (hookMode) => renderScene(eng, { id: pick.id, seed, hourFloat: R.hourFloat, year: t.year, month: t.month, day: t.day, hookMode, before: R.before });
        const rows = checkPicture({ label: side, img: decodeRgba(r.file), W: s.width, H: s.height, pic: r.pic, PCD, independent, date: r.pic.plan.V.now });
        for (const row of rows) assert.ok(row.pass, `${row.name}: ${row.detail}`);
        const ct = r.pic.info.content;
        assert.ok(ct.weather && ct.weather.block.length === 4, 'the weather block');
        assert.match(ct.weather.block[3].map((x) => x.text).join(''), /weather: open-meteo\.com/, 'the credit');
        assert.match(ct.strip.block[0].map((x) => x.text).join(''), /^ *7:28 +4:13 *$/, 'the strip labels: Berlin\'s sun times (fixture: 07:28 and 16:13)');
        assert.equal(ct.strip.bars.rects.filter((b) => b.now).length, 1, 'one now bar');
        assert.equal(ct.caption.block[0].map((x) => x.text).join(''), 'autumn forest · sunset');
        assert.equal(ct.greet.block[0].map((x) => x.text).join(''), 'good afternoon.');
        if (s.width === 3840) assert.ok(fs.statSync(r.file).size <= BUDGET.bytes, `${fs.statSync(r.file).size} bytes at 4K`);
      }
    } finally {
      rm(home);
      rm(dir);
    }
  });
}

test('the 4K budget: the best of N fresh `node pcd-still.mjs` runs takes <= 1.5 s wall and <= 0.5 s CPU; PNG <= 600 KB', () => {
  const b = bestOf({ runs: 5, at: AT });
  console.log(`  4K still: best ${b.wallMs} ms wall (whole process), ${b.cpuMs} ms CPU, ${Math.round(b.bytes / 1024)} KB; runs ${b.all.map((x) => `${x.wallMs}/${x.cpuMs}`).join(' ')}`);
  assert.ok(b.wallMs <= BUDGET.ms, `best wall ${b.wallMs} ms of ${b.all.length} runs`);
  assert.ok(b.cpuMs <= BUDGET.cpuMs, `best CPU ${b.cpuMs} ms of ${b.all.length} runs`);
  assert.ok(b.bytes <= BUDGET.bytes, `${b.bytes} bytes`);
});

test('deterministic: the same time gives the same bytes; another time of day changes the picture', async () => {
  const dir = tempHome();
  try {
    const a = await render(dir, 'a.png', ['--size', '1920x1080', '--at', AT]);
    const b = await render(dir, 'b.png', ['--size', '1920x1080', '--at', AT]);
    const c = await render(dir, 'c.png', ['--size', '1920x1080', '--at', '2026-11-15T22:30']);
    for (const r of [a, b, c]) assert.equal(r.code, 0, r.d.text());
    assert.ok(fs.readFileSync(a.file).equals(fs.readFileSync(b.file)), 'identical PNG bytes');
    assert.ok(!fs.readFileSync(a.file).equals(fs.readFileSync(c.file)), 'night differs from dusk');
    assert.equal(c.pic.info.content.greet.block[0].map((x) => x.text).join(''), 'good night.', '22:37: good night');
  } finally {
    rm(dir);
  }
});

test('themes by date and pinned themes (halloween, christmas, thanksgiving, summer); an unknown pin means auto', async () => {
  const cases = [['2026-10-31T21:00', 'halloween', 'good evening · happy halloween'], ['2026-12-24T23:00', 'christmas', 'good night.'], ['2026-11-26T13:00', 'thanksgiving', 'good afternoon · happy thanksgiving'], ['2026-07-15T12:00', 'summer', 'good afternoon.']];
  const dir = tempHome();
  try {
    for (const [at, id, greet] of cases) {
      const r = await render(dir, `${id}.png`, ['--size', '1280x800', '--at', at]);
      assert.equal(r.code, 0, r.d.text());
      assert.match(r.d.out.join('\n'), new RegExp(`: ${id} \\(auto\\)`));
      assert.equal(r.pic.info.content.greet.block[0].map((x) => x.text).join(''), greet);
      const face = r.pic.info.content.clock;
      assert.equal(face.face.kind, 'day');
      assert.equal(face.side.block[0][0].text, PCD.core.MONTHS_LONG[new Date(at).getMonth()]);
    }
    const pin = await render(dir, 'pin.png', ['--size', '1280x800', '--at', AT, '--theme', 'winter']);
    assert.match(pin.d.out.join('\n'), /: winter \(pinned\)/);
    assert.match(pin.pic.info.content.caption.block[0].map((x) => x.text).join(''), /^snowy hills · pinned · (dawn|day|sunset|night)$/);
    const gone = await render(dir, 'gone.png', ['--size', '1280x800', '--at', AT, '--theme', 'notatheme']);
    assert.match(gone.d.out.join('\n'), /: autumn \(auto\)/);
  } finally {
    rm(dir);
  }
});

test('the column side: still.json "side" (right by default), --side wins; a bad side is a problem, not a failure', async () => {
  assert.deepEqual(normalizeStill({ side: 'left' }).config.side, 'left');
  assert.equal(normalizeStill({}).config.side, undefined, 'not written unless set: the install\'s still.json keeps its shape');
  assert.deepEqual(normalizeStill({ side: 'top' }).problems, ['side: invalid value, using "right"']);
  assert.deepEqual(Object.keys(STILL_DEFAULTS), ['width', 'height', 'scale', 'theme', 'clock24', 'units', 'city', 'sunTimes', 'weather', 'weatherFx', 'taskbar']);
  const left = tempHome({ ...BERLIN, city: '', side: 'left' });
  const dir = tempHome();
  try {
    const a = await render(dir, 'a.png', ['--home', left, '--size', '1280x800', '--at', AT]);
    assert.equal(a.pic.plan.side, 'left');
    assert.ok(a.pic.plan.geo.scene.x > 0, 'the scene sits flush right');
    const b = await render(dir, 'b.png', ['--home', left, '--size', '1280x800', '--at', AT, '--side', 'right']);
    assert.equal(b.pic.plan.side, 'right');
    assert.equal(b.pic.plan.geo.scene.x, 0, 'the scene sits flush left');
    const c = await render(dir, 'c.png', ['--size', '1280x800', '--at', AT]);
    assert.equal(c.pic.plan.side, 'right', 'right by default');
    assert.equal(c.pic.info.content.weather, null, 'no city: no weather block, no placeholder');
  } finally {
    rm(left);
    rm(dir);
  }
});

test('weather and sun times off: no Open-Meteo request and no weather drawn, even with weatherFx on', async () => {
  const off = tempHome({ ...BERLIN, weather: false, sunTimes: false, weatherFx: true });
  const noCity = tempHome({ ...BERLIN, city: '', weather: false, sunTimes: false, weatherFx: true });
  const sunOnly = tempHome({ ...BERLIN, weather: false, sunTimes: true, weatherFx: true });
  const dir = tempHome();
  try {
    const fetch = fakeFetch();
    const a = await render(dir, 'off.png', ['--home', off, '--size', '1280x800', '--at', AT], { fetch });
    assert.equal(a.code, 0, a.d.text());
    assert.deepEqual(fetch.urls, [], 'nothing is requested');
    assert.match(a.d.out.join('\n'), /, weather off, \d+ KB in /);
    assert.equal(a.pic.render.before, null, 'no weather effect');
    assert.equal(a.pic.info.content.weather, null, 'no weather block');
    const b = await render(dir, 'no-city.png', ['--home', noCity, '--size', '1280x800', '--at', AT], { fetch });
    assert.equal(b.code, 0, b.d.text());
    assert.deepEqual(fetch.urls, []);
    assert.ok(fs.readFileSync(a.file).equals(fs.readFileSync(b.file)), 'the same picture as without a city');
    // the real sun times alone: one forecast for them, still no effect and no weather block
    const sunFetch = fakeFetch();
    const c = await render(dir, 'sun-only.png', ['--home', sunOnly, '--size', '1280x800', '--at', AT], { fetch: sunFetch });
    assert.equal(c.code, 0, c.d.text());
    assert.equal(sunFetch.urls.length, 2, 'a geocode and a forecast, for the sun times');
    assert.equal(c.pic.render.before, null, 'no weather effect while the weather is off');
    assert.equal(c.pic.info.content.weather, null);
    assert.ok(c.pic.view.sun, 'the sun times label the strip');
  } finally {
    for (const d of [off, noCity, sunOnly, dir]) rm(d);
  }
});

test('arguments: --side; unknown arguments are refused', () => {
  assert.equal(parseArgs(['--side', 'left']).side, 'left');
  assert.match(parseArgs(['--side', 'middle']).errors[0], /--side is right or left/);
  assert.match(parseArgs(['--nope']).errors[0], /unknown argument --nope/);
});

test('the CLI renders from the source folder only with --out, and prints help', () => {
  const cli = path.join(STILL, 'pcd-still.mjs');
  const env = safeEnv();
  const help = spawnSync(process.execPath, [cli, '--help'], { encoding: 'utf8', windowsHide: true, env });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /--dry-run/);
  assert.match(help.stdout, /--side S/);
  const refuse = spawnSync(process.execPath, [cli, '--dry-run'], { encoding: 'utf8', windowsHide: true, env });
  assert.equal(refuse.status, 2, 'no still.json next to the source: refuses to write into the repo');
  assert.match(refuse.stderr, /no still\.json/);
  assert.equal(fs.existsSync(path.join(STILL, 'out')), false, 'nothing written into src/still');
  const bad = spawnSync(process.execPath, [cli, '--size', '12x12'], { encoding: 'utf8', windowsHide: true, env });
  assert.equal(bad.status, 2);
});

test('tokens: the pages\' PCD.TOKENS from design/tokens.json (faint #978d83); the built-in defaults without the file', () => {
  const t = pageTokens(path.join(REPO, 'design', 'tokens.json'));
  const doc = JSON.parse(fs.readFileSync(path.join(REPO, 'design', 'tokens.json'), 'utf8'));
  assert.equal(t.faint, doc.colors.faint.value);
  assert.equal(t.int.bg, 0x141016);
  assert.equal(t.woodDark, doc.colors['wood-dark'].value);
  assert.deepEqual(t.type.ladder.still, doc.type.ladder.still);
  assert.equal(PCD.TOKENS === undefined || PCD.TOKENS.int.bg === 0x141016, true);
  assert.equal(pageTokens(path.join(REPO, 'no-such-tokens.json')), null);
  assert.equal(TOKEN_DEFAULTS.faint, 0x8b8178);
  const rt = readTokens(path.join(REPO, 'design', 'tokens.json'));
  assert.equal(rt.tokens.faint, parseInt(doc.colors.faint.value.slice(1), 16), 'faint is read from the file');
});
