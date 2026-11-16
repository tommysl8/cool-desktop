// node --test "tests/wallpaper-package.test.mjs"
// The Lively package: the wallpaper build plugin run into a temp dist with the neutral example config
// (config/user.example.json; config/user.json is never read), then zipped by the zip helper (tools/lib/zip.py):
// LivelyInfo.json strict JSON with "Arguments" exactly "--pause-event true", LivelyProperties.json loadable by Lively
// with the theme dropdown in PCD.engine.menu order, index.html (lively.js first and blocking, then deferred classic
// scripts in build order), the zip namelist (the four root files, posix names, no "./", no folders), every entry equal
// to the staging folder. Needs Python 3 for the zip step (skipped without it).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

function findRoot(dir) {
  for (let d = dir; ; d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, 'tools', 'build.mjs'))) return d;
    if (path.dirname(d) === d) throw new Error('repo root not found');
  }
}
const ROOT = findRoot(path.dirname(fileURLToPath(import.meta.url)));
const imp = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href);
const B = await imp('tools/build.mjs');
const WB = await imp('tools/build/wallpaper.mjs');
const WV = await imp('tools/validate/wallpaper.mjs');
const FSX = await imp('tools/lib/fsx.mjs');
const CONFIG = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'user.example.json'), 'utf8'));
const HAVE_PYTHON = !!FSX.findPython();

let tmp = null;
let ctx = null;
let built = null;

async function buildOnce() {
  if (built) return built;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pcd-wp-pkg-'));
  const dist = path.join(tmp, 'dist');
  const gen = await B.generateStage({ root: ROOT, config: CONFIG, vendor: path.join(ROOT, 'vendor', 'pixelclock') });
  ctx = B.createContext({ root: ROOT, dist, config: CONFIG, tokens: gen.tokens, anchors: gen.anchors, generated: gen.generated, render: false, piece: 'wallpaper', log: () => {} });
  await WB.build(ctx);
  const dir = path.join(dist, WB.OUT);
  const zip = path.join(dist, WB.ZIP);
  if (HAVE_PYTHON) FSX.zipDir(dir, zip);
  built = { dist, dir, zip, files: FSX.listFiles(dir).sort() };
  return built;
}

test.after(() => {
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

test('LivelyInfo.json: strict JSON, the expected shape, "Arguments" exactly "--pause-event true" and no other flag', async () => {
  const b = await buildOnce();
  const text = fs.readFileSync(path.join(b.dir, 'LivelyInfo.json'), 'utf8');
  const info = JSON.parse(text);
  assert.equal(info.Arguments, '--pause-event true');
  assert.equal(info.Title, 'PixelClock Desktop');
  assert.equal(info.Type, 1);
  assert.equal(info.FileName, 'index.html');
  assert.equal(info.Thumbnail, 'thumbnail.jpg');
  assert.deepEqual(WV.checkLivelyInfoText(text), []);
  assert.equal(text, WB.LIVELY_INFO_TEXT);
  assert.ok(!text.includes('\r') && text.charCodeAt(0) !== 0xfeff, 'LF, no BOM');
  // the guard itself: Lively's own flags and repeats are refused
  assert.ok(WV.checkArguments('--pause-event true --pause-media true').length > 0);
  assert.ok(WV.checkArguments('--pause-event true --pause-event true').length > 0);
  assert.ok(WV.checkArguments('--pause-event  true').length > 0, 'a double space');
  assert.ok(WV.checkLivelyInfoText(text.replace('--pause-event true', '--system-information --pause-event true')).length > 0, 'any extra flag fails the exact check');
});

test('LivelyProperties.json: loadable by Lively, generated from the config, theme dropdown in PCD.engine.menu order', async () => {
  const b = await buildOnce();
  const props = JSON.parse(fs.readFileSync(path.join(b.dir, 'LivelyProperties.json'), 'utf8'));
  const model = WB.loadModel(ROOT);
  assert.deepEqual(model.P.checkProperties(props), []);
  assert.deepEqual(model.P.checkPropertiesContent(props, { config: CONFIG, menu: model.menu, schema: model.S }), []);
  assert.deepEqual(props.theme.items, model.menu.map((t) => t.name));
  assert.equal(props.theme.items[0], 'Auto (by date)');
  assert.equal(props.city.value, CONFIG.city);
  assert.equal(props.units.value, CONFIG.units === 'C' ? 1 : 0);
  assert.equal(props.clock24.value, CONFIG.clock === '24h');
  assert.deepEqual(props.side, { type: 'dropdown', text: 'Column side', items: ['Right', 'Left'], value: 0 }, 'the column on the right by default');
});

test('js/pcd-config.js carries only the wallpaper fields of the config (no shortcuts)', async () => {
  const b = await buildOnce();
  const text = fs.readFileSync(path.join(b.dir, 'js', WB.CONFIG_SCRIPT), 'utf8');
  assert.ok(!/shortcuts|https?:\/\//.test(text), text);
  assert.match(text, /"city": "Berlin"/);
  assert.match(text, /"taskbarPx": 56/);
  // the new tab's links and any field the wallpaper does not read change no package file
  const model = WB.loadModel(ROOT);
  const other = { ...CONFIG, shortcuts: [], nope: 1 };
  assert.equal(WB.genConfigJs(ROOT, other, model), text);
  assert.deepEqual(WB.genProperties(ROOT, other, model), WB.genProperties(ROOT, CONFIG, model));
});

test('index.html: lively.js first and blocking in <head>, then the deferred classic scripts in build order', async () => {
  const b = await buildOnce();
  const html = fs.readFileSync(path.join(b.dir, 'index.html'), 'utf8');
  const lists = { scripts: WB.deferredScripts(ctx), styles: WB.pageStyles(ctx) };
  assert.deepEqual(WV.checkIndexHtml(html, lists), []);
  assert.equal(lists.scripts[0], 'js/pixelclock/engine.js');
  assert.equal(lists.scripts[1], 'js/pcd-hook.js');
  assert.equal(lists.scripts[2], 'js/pixelclock/schedule.js');
  assert.deepEqual(lists.scripts.slice(3, 7), ['winter', 'spring', 'summer', 'autumn'].map((t) => `js/pixelclock/themes/${t}.js`), 'seasons first');
  assert.equal(lists.scripts[lists.scripts.length - 1], 'js/wp-app.js', 'the app comes last');
  assert.ok(lists.scripts.indexOf('js/pcd-config.js') < lists.scripts.indexOf('js/wp-props.js'));
  for (const s of lists.scripts) assert.ok(b.files.includes(s), `${s} is in the package`);
  assert.deepEqual(WV.checkCallbacks(fs.readFileSync(path.join(b.dir, 'js', 'lively.js'), 'utf8')), []);
  // a broken page is caught
  assert.ok(WV.checkIndexHtml(html.replace('<script src="js/lively.js"></script>', '<script src="js/lively.js" defer></script>'), lists).length > 0);
  assert.ok(WV.checkIndexHtml(html.replace('js/wp-app.js" defer', 'js/wp-app.js" type="module"'), lists).length > 0);
});

const shipsConsole = (files) => files.includes('js/pcd-console.js') && files.includes('css/pcd-console.css');

test('package files: exactly the expected set, with the shared console', async () => {
  const b = await buildOnce();
  for (const f of WB.ROOT_FILES) assert.ok(b.files.includes(f), `${f} at the package root`);
  const expected = WV.expectedFiles(ROOT, CONFIG);
  assert.deepEqual(b.files, expected);
  assert.deepEqual(WB.APP_SCRIPTS, ['wp-props.js', 'wp-loop.js', 'wp-app.js']);
  assert.ok(shipsConsole(b.files), 'the shared console ships (js/pcd-console.js, css/pcd-console.css)');
  const code = b.files.filter((f) => /\.(js|css|html)$/.test(f) && !f.startsWith('js/pixelclock/')).map((f) => ({ rel: f, text: fs.readFileSync(path.join(b.dir, f), 'utf8') }));
  assert.deepEqual(WV.checkShippedCode(code), []);
});

test('the zip: the four root files, posix names, no "./" or folders, deflated, every entry equal to the staging folder', { skip: !HAVE_PYTHON && 'Python 3 not found (tools/lib/zip.py)' }, async () => {
  const b = await buildOnce();
  const z = WV.checkZipFile(b.zip, b.dir, b.files);
  assert.deepEqual(z.errors, []);
  for (const f of WB.ROOT_FILES) assert.ok(z.names.includes(f), `${f} is a root entry`);
  assert.ok(z.names.every((n) => !n.includes('\\') && !n.startsWith('./') && !n.startsWith('/') && !n.endsWith('/')), z.names.join(', '));
  assert.ok(z.names.some((n) => n.startsWith('js/pixelclock/themes/')), 'nested posix paths');
  // the checker itself catches the classic mistakes
  assert.ok(WV.checkZipNames(['wallpaper/index.html', 'wallpaper/LivelyInfo.json'], null).length > 0, 'a top folder');
  assert.ok(WV.checkZipNames(['index.html', 'LivelyInfo.json', 'LivelyProperties.json', 'thumbnail.jpg', 'js\\app.js'], null).length > 0, 'a backslash');
  assert.ok(WV.checkZipNames(['./index.html', 'LivelyInfo.json', 'LivelyProperties.json', 'thumbnail.jpg'], null).length > 0, 'a ./ prefix');
});
