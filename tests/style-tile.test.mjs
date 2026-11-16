// The style tile's build plugin (tools/build/style-tile.mjs) and validator (tools/validate/style-tile.mjs), and the
// pure helpers of its visual gate (tools/test-style-tile.mjs): the page is built into a temporary dist/ from the real
// repo and the example config (the generated tokens and anchors included), in the page order, and validates; the
// crisp checks find a single wrong device pixel (the theme thumbnails, and the console's whole layer: scene, band and
// seam); the shot list covers the board, the ten reference moments, both sides, the still, the new tab's states and
// the live host. The pixels are checked in headless Chrome by node tools/test-style-tile.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createContext, generateStage } from '../tools/build.mjs';
import { makeTempDir, readJsonStrict, rmrf } from '../tools/lib/fsx.mjs';
import { vendorDir } from '../tools/lib/vendor.mjs';
import { build, renderHtml, MARKS } from '../tools/build/style-tile.mjs';
import { validate } from '../tools/validate/style-tile.mjs';
import { crisp, crispLayer, contrastRuns, shotList, SWEEP } from '../tools/test-style-tile.mjs';
import { ROOT } from './look-load.mjs';

test('renderHtml fills the three marks once each and refuses a template without them', () => {
  const t = `<head>\n${MARKS.preload}\n${MARKS.styles}\n${MARKS.scripts}\n</head>`;
  const out = renderHtml(t, { preload: ['fonts/a.ttf'], styles: ['css/a.css', 'css/b.css'], scripts: ['js/a.js'] });
  assert.equal(out, '<head>\n<link rel="preload" href="fonts/a.ttf" as="font" type="font/ttf" crossorigin>\n<link rel="stylesheet" href="css/a.css">\n<link rel="stylesheet" href="css/b.css">\n<script src="js/a.js" defer></script>\n</head>');
  assert.throws(() => renderHtml('<head></head>', {}), /exactly once/);
  assert.throws(() => renderHtml(t + MARKS.scripts, {}), /exactly once/);
});

test('build: dist/style-tile in the page order, the tile last, byte copies, and the validator passes', async (t) => {
  const tmp = makeTempDir('pcd-tiletest-');
  t.after(() => rmrf(tmp));
  const dist = path.join(tmp, 'dist');
  const config = readJsonStrict(path.join(ROOT, 'config', 'user.example.json'));
  const gen = await generateStage({ root: ROOT, config, vendor: vendorDir(ROOT) });
  const ctx = createContext({ root: ROOT, dist, config, render: false, piece: 'style-tile', log: () => {}, generated: gen.generated, tokens: gen.tokens, anchors: gen.anchors });
  await build(ctx);
  const pkg = path.join(dist, 'style-tile');
  const html = fs.readFileSync(path.join(pkg, 'index.html'), 'utf8');
  const scripts = [...html.matchAll(/<script src="([^"]+)" defer><\/script>/g)].map((m) => m[1]);
  assert.equal(scripts[0], 'js/pixelclock/engine.js');
  assert.equal(scripts[1], 'js/pcd-hook.js');
  assert.equal(scripts.at(-1), 'js/style-tile.js');
  assert.ok(scripts.indexOf('js/pcd-console.js') > scripts.indexOf('js/pcd-ascii.js'));
  assert.ok(scripts.indexOf('js/pcd-bleed.js') > scripts.indexOf('js/pcd-layout.js'));
  assert.ok(!scripts.some((s) => s.endsWith('screens.js')));
  for (const s of scripts) assert.ok(fs.existsSync(path.join(pkg, ...s.split('/'))), s);
  assert.ok(fs.readFileSync(path.join(pkg, 'js', 'pcd-console.js')).equals(fs.readFileSync(path.join(ROOT, 'src', 'shared', 'pcd-console.js'))));
  assert.ok(fs.readFileSync(path.join(pkg, 'css', 'pcd-console.css')).equals(fs.readFileSync(path.join(ROOT, 'src', 'shared', 'css', 'pcd-console.css'))));
  assert.ok(fs.readFileSync(path.join(pkg, 'css', 'style-tile.css')).equals(fs.readFileSync(path.join(ROOT, 'design', 'style-tile.css'))));
  assert.ok(fs.existsSync(path.join(pkg, 'fonts', 'OFL.txt')), 'the font travels with its licence');
  assert.ok(!/\r/.test(html) && html.charCodeAt(0) !== 0xfeff, 'LF, no BOM');
  const rows = await validate({ root: ROOT, dist });
  for (const r of rows) assert.equal(r.pass, true, `${r.name}: ${r.detail}`);
});

test('crisp: every k x k block must equal the frame pixel; one wrong device pixel is found and located', () => {
  const k = 3, size = 64 * k, W = size + 10, H = size + 6, x0 = 4, y0 = 2;
  const frame = Array.from({ length: 4096 }, (_, i) => ((i * 2654435761) >>> 8) & 0xffffff);
  const data = Buffer.alloc(W * H * 4);
  for (let py = 0; py < 64; py++) {
    for (let px = 0; px < 64; px++) {
      const c = frame[py * 64 + px];
      for (let dy = 0; dy < k; dy++) {
        for (let dx = 0; dx < k; dx++) {
          const i = ((y0 + py * k + dy) * W + x0 + px * k + dx) * 4;
          data[i] = (c >> 16) & 255;
          data[i + 1] = (c >> 8) & 255;
          data[i + 2] = c & 255;
          data[i + 3] = 255;
        }
      }
    }
  }
  const img = { width: W, height: H, data };
  assert.equal(crisp(img, { x: x0, y: y0, size, k, frame }).ok, true);
  const i = ((y0 + 100) * W + x0 + 50) * 4;
  data[i] ^= 0x40;
  const bad = crisp(img, { x: x0, y: y0, size, k, frame });
  assert.equal(bad.ok, false);
  assert.equal(bad.bad, 1);
  assert.deepEqual([bad.first.x, bad.first.y], [x0 + 50, y0 + 100]);
  assert.equal(crisp(img, { x: x0 + 1, y: y0, size, k, frame }).ok, false, 'a block off by one device pixel is not crisp');
  assert.match(crisp(img, { x: W - 10, y: 0, size, k, frame }).why, /outside/);
});

test('crispLayer: the scene, band and seam of a console, each device px on its block; one wrong pixel is found', () => {
  const k = 4, W = 64 * k + 3 * k, H = 64 * k;
  const frame = Array.from({ length: 4096 }, (_, i) => ((i * 2654435761) >>> 8) & 0xffffff);
  const bandRows = Array.from({ length: 64 }, (_, y) => 0x101010 + y);
  const fadeCols = 2;
  const fade = Array.from({ length: 64 * fadeCols }, (_, i) => 0x202020 + i);
  // the column on the left: band (1 px), then the seam (2 scene px), then the scene flush right
  const scene = { k, x: 3 * k, y: 0, size: 64 * k, Wd: W, Hd: H, band: { x: 0, y: 0, w: k, h: H }, fade: { x: k, y: 0, w: 2 * k, h: H } };
  const data = Buffer.alloc(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const ry = Math.floor(y / k);
    const c = x >= 3 * k ? frame[ry * 64 + Math.floor((x - 3 * k) / k)] : x >= k ? fade[ry * fadeCols + Math.floor((x - k) / k)] : bandRows[ry];
    const i = (y * W + x) * 4;
    data[i] = (c >> 16) & 255; data[i + 1] = (c >> 8) & 255; data[i + 2] = c & 255; data[i + 3] = 255;
  }
  const c = { scene, frame, bandRows, fade, fadeCols, origin: { x: 0, y: 0 } };
  assert.equal(crispLayer({ width: W, height: H, data }, c).ok, true);
  data[((10 * W) + 2 * k) * 4] ^= 0x40;
  const bad = crispLayer({ width: W, height: H, data }, c);
  assert.equal(bad.bad, 1);
  assert.deepEqual([bad.first.x, bad.first.y], [2 * k, 10]);
});

test('contrastRuns: the brightest pixel behind a run decides; glyph-only runs are decorative', () => {
  const W = 20, H = 10, data = Buffer.alloc(W * H * 4);
  for (let i = 0; i < W * H; i++) { data[i * 4] = 20; data[i * 4 + 1] = 16; data[i * 4 + 2] = 22; data[i * 4 + 3] = 255; }
  const bright = (x, y) => { const i = (y * W + x) * 4; data[i] = 200; data[i + 1] = 200; data[i + 2] = 200; };
  bright(15, 5);
  const runs = [
    { text: 'faint words', color: [0x97, 0x8d, 0x83], x: 0, y: 0, w: 10, h: 10 },
    { text: 'over light', color: [0xa9, 0x9d, 0x91], x: 10, y: 0, w: 10, h: 10 },
    { text: '── ·', color: [0x6b, 0x44, 0x28], x: 0, y: 0, w: 4, h: 4 },
  ];
  const res = contrastRuns({ width: W, height: H, data }, 1, runs);
  assert.equal(res.length, 2, 'the glyph-only run is left out');
  assert.ok(res[0].ratio > 5.7 && res[0].ratio < 5.9, 'faint on bg: 5.8:1 since the lift');
  assert.ok(res[1].ratio < 4.5, 'muted over a bright pixel fails');
});

test('the shot list: the board, the ten reference moments, both sides, the still, the states and the live host', () => {
  const list = shotList();
  const names = list.map((s) => s.name);
  assert.equal(new Set(names).size, names.length, 'unique names');
  assert.ok(names.includes('board-1280x800@2') && names.includes('board-2560x1440@1'));
  for (const m of ['1280x800@2-night', '1280x800@2-fresh', '1280x800@2-help', '1280x620@2-real', '1440x900-winter-day', '1920x1080-summer-day',
    '2560x1440-halloween', '3440x1440-christmas', '800x500-spring', '800x500@2-spring']) {
    const s = list.find((x) => x.name === 'newtab-' + m);
    assert.ok(s, m);
    assert.ok(s.contrast && s.q.view === 'console' && s.q.profile === 'newtab', m);
    assert.ok(s.expect && (s.expect.font !== undefined || s.expect.k !== undefined), m + ': the numbers it must keep');
  }
  assert.equal(list.find((s) => s.name === 'newtab-1280x800@2-night').expect.font, 18);
  assert.equal(list.find((s) => s.name === 'newtab-1280x620@2-real').expect.font, 14);
  for (const p of ['wallpaper', 'still']) assert.ok(list.some((s) => s.q.profile === p && s.contrast), p);
  assert.ok(list.some((s) => s.q.profile === 'wallpaper' && s.q.side === 'left'), 'the flipped wallpaper');
  assert.ok(list.some((s) => s.live && s.hide) && list.some((s) => s.live && s.perf), 'live, perf and hidden');
  for (const s of list) {
    assert.ok([1, 2].includes(s.dpr), `${s.name}: a real scale factor of 1 or 2`);
    assert.ok(s.q.view === 'board' || s.q.view === 'console', s.name);
  }
  // --sweep: each side at the 20 sizes (the ten reference sizes among them)
  const sweep = shotList({ sweep: true }).filter((s) => s.name.startsWith('sweep-'));
  assert.equal(sweep.length, 40);
  assert.equal(SWEEP.length, 20);
  for (const [w, h, d] of [[1280, 620, 2], [1280, 800, 2], [1440, 900, 1], [1920, 1080, 1], [2560, 1440, 1], [3840, 2160, 1], [3440, 1440, 1], [800, 500, 1], [1080, 1920, 1], [320, 200, 1]]) {
    for (const p of ['newtab', 'wallpaper']) assert.ok(sweep.some((s) => s.w === w && s.h === h && s.dpr === d && s.q.profile === p && s.contrast), `${p} ${w}x${h}@${d}`);
  }
});
