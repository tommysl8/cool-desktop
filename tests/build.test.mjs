// node --test tests/build.test.mjs
// tools/build.mjs: the ctx contract (out() refuses paths outside dist, write() gives LF without BOM, clean() scope,
// copyShared, copyVendor, pageScripts), the generate stage, plugin discovery and order, --no-sync / --no-render,
// and the zip step. Everything runs against temporary roots; the real dist/ and vendor/ are never touched.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { anchorsJs, createContext, defaultSync, FONT_FILES, FONT_LICENCE, generateStage, main as buildMain, PIECES, parseArgs, sharedLists, ZIP_NAME } from '../tools/build.mjs';
import { findPython, makeTempDir, rmrf } from '../tools/lib/fsx.mjs';
import { themeOrder } from '../tools/lib/vendor.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VENDOR = path.join(ROOT, 'vendor', 'pixelclock');
const temps = [];
test.after(async () => { for (const d of temps) await rmrf(d); });

/** A config shaped like config/user.json, with the sample city and links of config/user.example.json. */
const CONFIG = {
  city: 'Berlin', units: 'F', clock: '12h', sunTimes: true, weather: true,
  shortcuts: [{ label: 'wikipedia', url: 'https://www.wikipedia.org' }, { label: 'maps', url: 'https://www.openstreetmap.org' }],
  taskbarPx: 56,
};

function put(base, rel, data) {
  const p = path.join(base, ...rel.split('/'));
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, data);
  return p;
}

/**
 * A throwaway repo root (a new temp folder, or `at`): config, a copy of the synced vendor/, optional shared files,
 * fonts, plugins and libs.
 */
function makeRoot({ at, config = CONFIG, configText, shared = {}, css = {}, fonts = true, build = {}, validate = {}, lib = {}, vendor = true } = {}) {
  const root = at || makeTempDir('pcd-buildtest-');
  if (at) fs.mkdirSync(at, { recursive: true });
  else temps.push(root);
  put(root, 'config/user.json', configText ?? JSON.stringify(config, null, 2) + '\n');
  if (vendor) fs.cpSync(VENDOR, path.join(root, 'vendor', 'pixelclock'), { recursive: true });
  for (const [name, text] of Object.entries(shared)) put(root, `src/shared/${name}`, text);
  for (const [name, text] of Object.entries(css)) put(root, `src/shared/css/${name}`, text);
  if (fonts) {
    put(root, 'design/fonts/CascadiaMono-wght.ttf', Buffer.from([0, 1, 0, 0, 0, 13, 10, 255]));
    put(root, 'design/fonts/OFL.txt', 'SIL Open Font License\n');
  }
  for (const [piece, code] of Object.entries(build)) put(root, `tools/build/${piece}.mjs`, code);
  for (const [piece, code] of Object.entries(validate)) put(root, `tools/validate/${piece}.mjs`, code);
  for (const [name, code] of Object.entries(lib)) put(root, `tools/lib/${name}`, code);
  return root;
}

function ctxFor(root, { dist, piece = 'testpiece', log, generated } = {}) {
  return createContext({ root, dist: dist ?? path.join(root, 'dist'), config: CONFIG, render: true, piece, log: log ?? (() => {}), generated });
}

function plugin(piece, body = '') {
  return [
    `export const piece = '${piece}';`,
    'export async function build(ctx) {',
    '  (globalThis.__buildOrder ||= []).push(ctx.piece);',
    body,
    '}',
    '',
  ].join('\n');
}

async function runBuild(root, argv = ['--no-sync'], opts = {}) {
  const out = [];
  const err = [];
  globalThis.__buildOrder = [];
  const code = await buildMain({ argv, root, log: (m) => out.push(m), logError: (m) => err.push(m), ...opts });
  return { code, out: out.join('\n'), err: err.join('\n'), order: [...globalThis.__buildOrder] };
}

// ---------------------------------------------------------------------------------------------
// ctx

test('ctx.out() resolves inside dist and refuses escapes; ctx.path() stays in the root', () => {
  const root = makeRoot();
  const dist = path.join(root, 'dist');
  const ctx = ctxFor(root);
  assert.equal(ctx.dist, dist);
  assert.equal(ctx.out('newtab', 'js', 'a.js'), path.join(dist, 'newtab', 'js', 'a.js'));
  assert.equal(ctx.out('newtab/js/a.js'), path.join(dist, 'newtab', 'js', 'a.js'));
  assert.equal(ctx.out(), dist);
  for (const bad of [['..'], ['../x'], ['a/../../x'], ['a', '..', '..', 'x'], ['..\\x'], ['C:\\Windows\\x'], ['/etc/x'], ['\\\\server\\share\\x'], ['c:x']]) {
    assert.throws(() => ctx.out(...bad), /escapes dist|absolute path not allowed/, JSON.stringify(bad));
  }
  assert.throws(() => ctx.out(5), /must be strings/);
  assert.equal(ctx.path('config', 'user.json'), path.join(root, 'config', 'user.json'));
  assert.throws(() => ctx.path('..', 'elsewhere'), /escapes the repo root/);
});

test('ctx.clean() refuses empty paths, dist itself and escapes; it recreates only dist/<piece>', () => {
  const root = makeRoot();
  const dist = path.join(root, 'dist');
  const ctx = ctxFor(root);
  put(root, 'dist/keep/keep.txt', 'k');
  put(root, 'sibling/keep.txt', 's');
  for (const bad of [undefined, '', '   ', '.', './', 'a/..', '..', '../sibling', 'C:\\x', '/x']) {
    assert.throws(() => ctx.clean(bad), /refusing|escapes dist|absolute path/, JSON.stringify(bad));
  }
  assert.ok(fs.existsSync(path.join(root, 'sibling', 'keep.txt')), 'sibling folder untouched');
  assert.ok(fs.existsSync(path.join(dist, 'keep', 'keep.txt')), 'dist untouched');
  put(root, 'dist/piece/old/stale.txt', 'old');
  assert.equal(ctx.clean('piece'), path.join(dist, 'piece'));
  assert.deepEqual(fs.readdirSync(path.join(dist, 'piece')), []);
  assert.ok(fs.existsSync(path.join(dist, 'keep', 'keep.txt')), 'other pieces untouched');
});

test('ctx.write gives UTF-8 without BOM with LF; writeJson, writeBytes, copyFile, copyDir; stats', () => {
  const root = makeRoot();
  const dist = path.join(root, 'dist');
  const logs = [];
  const ctx = ctxFor(root, { log: (m) => logs.push(m) });
  ctx.write('p/a.txt', '\uFEFFline1\r\nline2\r\n');
  assert.deepEqual(fs.readFileSync(path.join(dist, 'p', 'a.txt')), Buffer.from('line1\nline2\n'));
  assert.ok(logs.includes('[testpiece] write dist/p/a.txt (12 bytes)'), logs.join('\n'));
  ctx.write('p/u.txt', 'caf\u00e9 \u2591\u2592\u2593 \u00b7\n');
  const u = fs.readFileSync(path.join(dist, 'p', 'u.txt'));
  assert.notEqual(u[0], 0xef, 'no BOM');
  assert.equal(u.toString('utf8'), 'caf\u00e9 \u2591\u2592\u2593 \u00b7\n');
  ctx.writeJson('p/b.json', { a: 1, b: [1, 2] });
  assert.equal(fs.readFileSync(path.join(dist, 'p', 'b.json'), 'utf8'), '{\n  "a": 1,\n  "b": [\n    1,\n    2\n  ]\n}\n');
  ctx.writeBytes('p/c.bin', Buffer.from([0, 13, 10, 255]));
  assert.deepEqual(fs.readFileSync(path.join(dist, 'p', 'c.bin')), Buffer.from([0, 13, 10, 255]), 'bytes are not normalized');
  ctx.copyFile(path.join(root, 'config', 'user.json'), 'p/t.json');
  assert.deepEqual(fs.readFileSync(path.join(dist, 'p', 't.json')), fs.readFileSync(path.join(root, 'config', 'user.json')));
  const src = path.join(root, 'srcdir');
  put(src, 'a.txt', 'a'); put(src, 'sub/b.txt', 'b'); put(src, 'sub/c.skip', 'c'); put(src, 'skipdir/d.txt', 'd');
  const copied = ctx.copyDir(src, 'p/dir', { filter: (rel, abs, isDir) => !rel.endsWith('.skip') && !(isDir && rel === 'skipdir') });
  assert.deepEqual(copied, ['a.txt', 'sub/b.txt']);
  assert.ok(!fs.existsSync(path.join(dist, 'p', 'dir', 'skipdir')));
  assert.throws(() => ctx.write('../escape.txt', 'x'), /escapes dist/);
  assert.throws(() => ctx.write('p/x.txt', Buffer.from('x')), /text must be a string/);
  assert.throws(() => ctx.writeBytes('', Buffer.from('x')), /dist\/ itself/);
  assert.equal(ctx.stats.files, 7);
});

test('ctx.copyShared: pcd-hook.js first, the generated scripts, src/shared in documented order, CSS, fonts', () => {
  const root = makeRoot({
    shared: {
      'pcd-console.js': '/* console */\r\nvar d = 1;\r\n',
      'pcd-engine.js': '/* engine */\n',
      'pcd-hook.js': '/* hook */\n',
      'pcd-core.js': '/* core */\n',
      'zz-extra.js': '/* extra */\n',
      'notes.md': 'not copied\n',
    },
    css: { 'pcd-console.css': '.d{}\n', 'pcd-base.css': 'body{}\n', 'aa-extra.css': '.x{}\n' },
  });
  const dist = path.join(root, 'dist');
  const generated = { 'pcd-tokens.js': '/* tokens */\n', 'pcd-anchors.js': anchorsJs({ autumn: { rise: 7, set: 17 } }), 'tokens.css': ':root{}\n' };
  const ctx = ctxFor(root, { generated });
  assert.deepEqual(ctx.sharedScripts, ['pcd-core.js', 'pcd-engine.js', 'pcd-console.js', 'zz-extra.js']);
  assert.deepEqual(ctx.sharedStyles, ['pcd-base.css', 'pcd-console.css', 'aa-extra.css']);
  const written = ctx.copyShared('newtab');
  assert.deepEqual(written, {
    js: ['js/pcd-hook.js', 'js/pcd-tokens.js', 'js/pcd-anchors.js', 'js/pcd-core.js', 'js/pcd-engine.js', 'js/pcd-console.js', 'js/zz-extra.js'],
    css: ['css/tokens.css', 'css/pcd-base.css', 'css/pcd-console.css', 'css/aa-extra.css'],
    fonts: ['fonts/CascadiaMono-wght.ttf', 'fonts/OFL.txt'],
  });
  assert.equal(fs.readFileSync(path.join(dist, 'newtab', 'js', 'pcd-console.js'), 'utf8'), '/* console */\nvar d = 1;\n', 'CRLF normalized');
  assert.deepEqual(fs.readFileSync(path.join(dist, 'newtab', 'fonts', 'CascadiaMono-wght.ttf')), Buffer.from([0, 1, 0, 0, 0, 13, 10, 255]), 'font bytes unchanged');
  assert.ok(!fs.existsSync(path.join(dist, 'newtab', 'js', 'notes.md')));
  const only = ctx.copyShared('wallpaper', { js: 'shared', css: false, fonts: false });
  assert.deepEqual([only.css, only.fonts], [[], []]);
  assert.ok(fs.existsSync(path.join(dist, 'wallpaper', 'shared', 'pcd-hook.js')));
  assert.throws(() => ctx.copyShared(''), /rel .* is required/);
  const conflict = makeRoot({ shared: { 'pcd-tokens.js': '/* hand-written */\n' } });
  assert.throws(() => ctxFor(conflict).copyShared('x'), /must not contain pcd-tokens\.js/);
  assert.deepEqual(sharedLists(conflict).conflicts, ['pcd-tokens.js']);
  const bare = makeRoot({ fonts: false });
  assert.deepEqual(ctxFor(bare).copyShared('p'), { js: [], css: [], fonts: [] }, 'nothing there: nothing copied');
});

test('ctx.copyShared: the font never ships without its licence (OFL.txt)', async () => {
  assert.equal(FONT_LICENCE, 'OFL.txt');
  assert.ok(FONT_FILES.includes(FONT_LICENCE));
  const root = makeRoot({ fonts: false, shared: { 'pcd-core.js': '/* core */\n' } });
  put(root, 'design/fonts/CascadiaMono-wght.ttf', Buffer.from([0, 1, 0, 0]));
  const ctx = ctxFor(root);
  assert.throws(() => ctx.copyShared('p'), /^Error: design\/fonts\/OFL\.txt is missing: the font must travel with its licence$/);
  assert.equal(fs.existsSync(path.join(root, 'dist', 'p')), false, 'nothing is written first');
  assert.deepEqual(ctx.copyShared('q', { fonts: false }).js, ['js/pcd-core.js'], 'without fonts the licence is not needed');
  // through a build: the piece that copies the shared files fails, the summary says why
  const r = await runBuild(makeRoot({ fonts: false, build: { newtab: plugin('newtab', "  ctx.clean('newtab'); ctx.copyShared('newtab');") } }));
  assert.equal(r.code, 0, 'no font at all: nothing to license');
  const lone = makeRoot({ fonts: false, build: { newtab: plugin('newtab', "  ctx.clean('newtab'); ctx.copyShared('newtab');") } });
  put(lone, 'design/fonts/CascadiaMono-wght.ttf', Buffer.from([0, 1, 0, 0]));
  const bad = await runBuild(lone);
  assert.equal(bad.code, 1);
  assert.match(bad.out, /^ {2}newtab {6}ERROR .*design\/fonts\/OFL\.txt is missing: the font must travel with its licence$/m);
  assert.equal(fs.existsSync(path.join(lone, 'dist', 'newtab', 'fonts')), false);
});

test('ctx.copyVendor: byte-identical engine copies in the page layout and the render layout; a damaged vendor/ is refused', () => {
  const root = makeRoot();
  const dist = path.join(root, 'dist');
  const ctx = ctxFor(root);
  const page = ctx.copyVendor('newtab/js/pixelclock');
  assert.ok(page.files.includes('engine.js') && page.files.includes('schedule.js') && page.files.includes('themes/autumn.js'));
  assert.ok(!page.files.includes('screens.js') && !page.files.some((f) => f.includes('render')), 'pages get neither screens.js nor render.js');
  assert.equal(page.files.length, 15);
  assert.deepEqual(page.scripts.slice(0, 6), ['engine.js', 'schedule.js', 'themes/winter.js', 'themes/spring.js', 'themes/summer.js', 'themes/autumn.js']);
  assert.equal(page.scripts.length, 15);
  for (const f of page.files) {
    const src = f.startsWith('themes/') || ['engine.js', 'schedule.js'].includes(f) ? `simulator/${f}` : f;
    assert.ok(fs.readFileSync(path.join(dist, 'newtab', 'js', 'pixelclock', ...f.split('/'))).equals(fs.readFileSync(path.join(VENDOR, ...src.split('/')))), f);
  }
  const withScreens = ctx.copyVendor('style-tile/js/pixelclock', { screens: true });
  assert.ok(withScreens.files.includes('screens.js'));
  const still = ctx.copyVendor('still/pixelclock', { render: true });
  assert.equal(still.files.length, 17);
  assert.ok(still.files.includes('tools/render.js') && still.files.includes('simulator/screens.js') && still.files.includes('simulator/engine.js'));
  assert.deepEqual(still.scripts, []);
  assert.ok(fs.readFileSync(path.join(dist, 'still', 'pixelclock', 'tools', 'render.js')).equals(fs.readFileSync(path.join(VENDOR, 'tools', 'render.js'))));
  fs.appendFileSync(path.join(root, 'vendor', 'pixelclock', 'simulator', 'themes', 'winter.js'), '// edited by hand\n');
  assert.throws(() => ctxFor(root).copyVendor('x/pixelclock'), /not a clean sync: simulator\/themes\/winter\.js: .*\(run node tools\/sync\.mjs\)/);
});

test('ctx.pageScripts: the page load order', () => {
  const root = makeRoot({ shared: { 'pcd-hook.js': '', 'pcd-engine.js': '', 'pcd-core.js': '', 'pcd-host.js': '', 'pcd-sun.js': '' } });
  const ctx = ctxFor(root, { generated: { 'pcd-anchors.js': '', 'pcd-tokens.js': '' } });
  const holidays = themeOrder(VENDOR).filter((t) => t.kind === 'holiday').map((t) => `js/pixelclock/${t.file}`);
  assert.deepEqual(ctx.pageScripts(), [
    'js/pixelclock/engine.js', 'js/pcd-hook.js', 'js/pixelclock/schedule.js',
    'js/pixelclock/themes/winter.js', 'js/pixelclock/themes/spring.js', 'js/pixelclock/themes/summer.js', 'js/pixelclock/themes/autumn.js',
    ...holidays,
    'js/pcd-tokens.js', 'js/pcd-anchors.js',
    'js/pcd-core.js', 'js/pcd-engine.js', 'js/pcd-sun.js', 'js/pcd-host.js',
  ]);
  assert.deepEqual(holidays.map((h) => path.posix.basename(h, '.js')), ['newyear', 'lunarnewyear', 'valentines', 'stpatricks', 'easter', 'july4', 'halloween', 'thanksgiving', 'christmas']);
  assert.deepEqual(ctx.pageScripts({ js: 'lib', vendor: 'engine' }).slice(0, 3), ['engine/engine.js', 'lib/pcd-hook.js', 'engine/schedule.js']);
});

// ---------------------------------------------------------------------------------------------
// main()

test('parseArgs: pieces, --no-sync, --no-render, unknown names', () => {
  assert.deepEqual(PIECES, ['style-tile', 'newtab', 'wallpaper', 'still']);
  assert.deepEqual(parseArgs(['still', '--no-render', 'newtab', 'still', '--no-sync']), { pieces: ['still', 'newtab'], sync: false, render: false, help: false, errors: [] });
  assert.match(parseArgs(['nope']).errors[0], /unknown piece "nope"/);
  assert.match(parseArgs(['--fast']).errors[0], /unknown option --fast/);
});

test('build: no plugins -> every piece is skipped, exit 0; the sync runs unless --no-sync', async () => {
  const root = makeRoot();
  const r = await runBuild(root);
  assert.equal(r.code, 0, r.err);
  for (const p of PIECES) assert.match(r.out, new RegExp(`^skip ${p}: no plugin$`, 'm'));
  assert.match(r.out, /config\/user\.json OK \(units F, clock 12h, 2 shortcuts\)/);
  assert.match(r.out, /vendor\/pixelclock OK: 17 files/);
  assert.match(r.out, /build OK: 0 built, 4 skipped/);
  let synced = 0;
  const ok = await runBuild(root, [], { sync: async ({ log }) => { synced++; log('fake sync'); return { code: 0 }; } });
  assert.equal(ok.code, 0, ok.err);
  assert.equal(synced, 1);
  assert.match(ok.out, /\[sync\] fake sync/);
  await runBuild(root, ['--no-sync'], { sync: async () => { synced++; return { code: 0 }; } });
  assert.equal(synced, 1, '--no-sync skips it');
});

test('defaultSync: no PixelClock checkout -> the build uses vendor/pixelclock/ as it is; a checkout or PCD_PIXELCLOCK runs the sync', async () => {
  // A stub stands in for the sync: nothing here ever copies the engine.
  const parent = makeTempDir('pcd-syncdefault-');
  temps.push(parent);
  const root = path.join(parent, 'project');
  fs.mkdirSync(root);
  const calls = [];
  const run = async (o) => { calls.push(o); return { code: 0, status: 'unchanged' }; };
  const logs = [];
  const log = (m) => logs.push(m);

  assert.deepEqual(await defaultSync({ log, env: {}, root, run }), { code: 0, status: 'skipped' });
  assert.equal(calls.length, 0, 'no checkout: the sync never runs');
  assert.deepEqual(logs, ['no PixelClock checkout next to this folder: building from vendor/pixelclock/ as it is']);

  // a PixelClock folder without the simulator is not a checkout either
  fs.mkdirSync(path.join(parent, 'PixelClock'));
  assert.equal((await defaultSync({ log, env: {}, root, run })).status, 'skipped');
  assert.equal(calls.length, 0);

  // a checkout next to the project: the sync runs from it into this project's vendor/
  put(parent, 'PixelClock/simulator/engine.js', '// engine\n');
  assert.deepEqual(await defaultSync({ log, env: {}, root, run }), { code: 0, status: 'unchanged' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].source, path.join(parent, 'PixelClock'));
  assert.equal(calls[0].vendorDir, path.join(root, 'vendor', 'pixelclock'));
  assert.equal(typeof calls[0].log, 'function');

  // PCD_PIXELCLOCK always runs the sync, even when that folder is missing (the sync then fails and says why)
  const named = path.join(parent, 'elsewhere');
  const failing = async (o) => { calls.push(o); return { code: 1, status: 'failed' }; };
  assert.deepEqual(await defaultSync({ log, env: { PCD_PIXELCLOCK: named }, root, run: failing }), { code: 1, status: 'failed' });
  assert.equal(calls.length, 2);
  assert.equal(calls[1].source, named);

  // through main(): the build hands its root to the sync, and a skipped sync builds on
  const lone = makeTempDir('pcd-syncdefault-');
  temps.push(lone);
  const project = makeRoot({ at: path.join(lone, 'project') });
  const r = await runBuild(project, [], { sync: (o) => defaultSync({ ...o, env: {}, run }) });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^\[sync\] no PixelClock checkout next to this folder: building from vendor\/pixelclock\/ as it is$/m);
  assert.match(r.out, /build OK: 0 built, 4 skipped/);
  assert.equal(calls.length, 2, 'still no sync');
  // with a checkout next to it, main() runs the sync for its own root
  put(lone, 'PixelClock/simulator/engine.js', '// engine\n');
  const r2 = await runBuild(project, [], { sync: (o) => defaultSync({ ...o, env: {}, run }) });
  assert.equal(r2.code, 0, r2.err);
  assert.equal(calls.length, 3);
  assert.equal(calls[2].vendorDir, path.join(project, 'vendor', 'pixelclock'));
});

test('build: a failed sync stops the build before any piece', async () => {
  const root = makeRoot({ build: { newtab: plugin('newtab') } });
  const r = await runBuild(root, [], { sync: async () => ({ code: 1 }) });
  assert.equal(r.code, 1);
  assert.deepEqual(r.order, []);
  assert.match(r.err, /the engine sync failed \(vendor\/pixelclock\/ keeps its last good copy; rerun with --no-sync/);
});

test('build: plugins run in documented order, --no-render reaches ctx, piece filters', async () => {
  const root = makeRoot({
    build: {
      still: plugin('still', "  ctx.clean('still'); ctx.write('still/render.txt', String(ctx.render));"),
      'style-tile': plugin('style-tile', "  ctx.clean('style-tile'); ctx.write('style-tile/index.html', '<!doctype html>\\n');"),
      newtab: plugin('newtab', "  ctx.clean('newtab'); ctx.writeJson('newtab/manifest.json', { manifest_version: 3 });"),
      wallpaper: plugin('wallpaper'),
    },
  });
  const all = await runBuild(root, ['--no-sync', '--no-render']);
  assert.equal(all.code, 0, all.err);
  assert.deepEqual(all.order, ['style-tile', 'newtab', 'wallpaper', 'still']);
  assert.equal(fs.readFileSync(path.join(root, 'dist', 'still', 'render.txt'), 'utf8'), 'false');
  assert.match(all.out, /build OK: 4 built, 0 skipped/);
  assert.match(all.out, /zip: dist\/wallpaper\/ is empty, nothing to zip/);
  assert.doesNotMatch(all.out, /zip dist\/wallpaper/, 'an empty wallpaper is not zipped');
  const one = await runBuild(root, ['--no-sync', 'still']);
  assert.equal(one.code, 0, one.err);
  assert.deepEqual(one.order, ['still']);
  assert.equal(fs.readFileSync(path.join(root, 'dist', 'still', 'render.txt'), 'utf8'), 'true');
  assert.ok(fs.existsSync(path.join(root, 'dist', 'newtab', 'manifest.json')), 'other pieces are left alone');
});

test('build: a failing plugin -> exit 1, the others still run, the summary shows ERROR', async () => {
  const root = makeRoot({
    build: {
      newtab: plugin('newtab', "  throw new Error('boom');"),
      wallpaper: plugin('wrong-name'),
      still: plugin('still', "  ctx.clean('still');"),
    },
  });
  const r = await runBuild(root);
  assert.equal(r.code, 1);
  assert.deepEqual(r.order, ['newtab', 'still']);
  assert.match(r.err, /\[newtab\] ERROR: Error: boom/);
  assert.match(r.err, /exports piece = "wrong-name", expected "wallpaper"/);
  assert.match(r.out, /^ {2}newtab {6}ERROR .*boom$/m);
  assert.match(r.err, /build FAILED: 2 step\(s\) with errors \(newtab, wallpaper\)/);
});

test('build: unknown piece or option, a bad config or a damaged vendor/ -> exit 1 before any plugin', async () => {
  const root = makeRoot({ build: { still: plugin('still') } });
  const r1 = await runBuild(root, ['nope']);
  assert.equal(r1.code, 1);
  assert.match(r1.err, /unknown piece "nope"/);
  const r2 = await runBuild(root, ['--fast']);
  assert.equal(r2.code, 1);
  assert.deepEqual([...r1.order, ...r2.order], []);
  const cases = [
    [{ configText: '\uFEFF' + JSON.stringify(CONFIG) }, /config\/user\.json: starts with a UTF-8 BOM/],
    [{ configText: '{"city": "Berlin",}' }, /config\/user\.json: invalid JSON/],
    [{ config: { ...CONFIG, units: 'K' } }, /"units" must be "F" or "C"/],
    [{ config: { ...CONFIG, taskbarPx: 999 } }, /"taskbarPx" must be an integer from 0 to 200 \(got 999\)/],
    [{ config: { ...CONFIG, shortcuts: [{ label: 'x', url: 'javascript:alert(1)' }] } }, /shortcuts"\[0\]\.url must be an http\(s\) URL/],
    [{ config: { ...CONFIG, extra: 1 } }, /unknown key "extra"/],
    [{ vendor: false }, /vendor\/pixelclock\/ does not exist \(run node tools\/sync\.mjs\)/],
  ];
  for (const [opts, re] of cases) {
    const rr = await runBuild(makeRoot({ ...opts, build: { still: plugin('still') } }));
    assert.equal(rr.code, 1, String(re));
    assert.deepEqual(rr.order, [], 'no plugin runs');
    assert.match(rr.err, /FAILED before any piece ran/);
    assert.match(rr.err, re);
  }
  // a fresh clone before its first step: the build says which file to copy
  const fresh = makeRoot({ build: { still: plugin('still') } });
  fs.rmSync(path.join(fresh, 'config', 'user.json'));
  const rf = await runBuild(fresh);
  assert.equal(rf.code, 1);
  assert.deepEqual(rf.order, []);
  assert.match(rf.err, /FAILED before any piece ran:\n {2}- config\/user\.json is missing: copy config\/user\.example\.json to config\/user\.json/);
  assert.doesNotMatch(rf.err, /ENOENT/);
});

test('generate stage: tools/lib/tokens.mjs and tools/lib/anchors.mjs; a throwing gate stops the build', async () => {
  const tokens = [
    'export function generate({ root, config }) {',
    "  if (!root || !config) throw new Error('missing args');",
    "  return { files: { 'pcd-tokens.js': '/* tokens */\\n', 'tokens.css': ':root{--bg:#141016}\\n' }, rows: [{ token: 'text', against: 'bg', ratio: 14.9, min: 4.5, pass: true }] };",
    '}',
    '',
  ].join('\n');
  const anchors = "export function generate(vendorDir) { return { autumn: { rise: 7.25, set: 17.5, curve: [0.1] }, vendor: typeof vendorDir }; }\n";
  const root = makeRoot({
    lib: { 'tokens.mjs': tokens, 'anchors.mjs': anchors },
    shared: { 'pcd-hook.js': '/* hook */\n' },
    build: { newtab: plugin('newtab', "  ctx.clean('newtab'); const w = ctx.copyShared('newtab'); ctx.writeJson('newtab/list.json', { js: w.js, css: w.css, anchors: ctx.anchors, json: ctx.generated['anchors.json'] });") },
  });
  const r = await runBuild(root);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /tokens: pcd-tokens\.js, tokens\.css; contrast gate PASS \(1 pairs\)/);
  assert.match(r.out, /anchors: 2 entries/);
  const list = JSON.parse(fs.readFileSync(path.join(root, 'dist', 'newtab', 'list.json'), 'utf8'));
  assert.deepEqual(list.js, ['js/pcd-hook.js', 'js/pcd-tokens.js', 'js/pcd-anchors.js']);
  assert.deepEqual(list.css, ['css/tokens.css']);
  assert.equal(list.anchors.autumn.rise, 7.25);
  assert.equal(list.anchors.vendor, 'string');
  assert.equal(JSON.parse(list.json).autumn.set, 17.5);
  const js = fs.readFileSync(path.join(root, 'dist', 'newtab', 'js', 'pcd-anchors.js'), 'utf8');
  const sandbox = vm.createContext({});
  vm.runInContext(js, sandbox, { filename: 'pcd-anchors.js' });
  assert.equal(sandbox.PCD.ANCHORS.autumn.rise, 7.25);

  const failing = makeRoot({ lib: { 'tokens.mjs': "export function generate() { throw new Error('contrast gate failed: text vs bg 3.1:1 (min 4.5:1)'); }\n" }, build: { newtab: plugin('newtab') } });
  const f = await runBuild(failing);
  assert.equal(f.code, 1);
  assert.deepEqual(f.order, []);
  assert.match(f.err, /FAILED in the generate stage: Error: contrast gate failed/);
  const gen = await generateStage({ root: makeRoot(), config: CONFIG, vendor: VENDOR });
  assert.deepEqual(gen.generated, {}, 'neither module present: nothing generated');
});

test('zip: a built wallpaper piece is zipped to dist/PixelClockDesktop-wallpaper.zip with posix names', { skip: findPython() ? false : 'Python 3 not found' }, async () => {
  const root = makeRoot({
    build: {
      wallpaper: plugin('wallpaper', [
        "  ctx.clean('wallpaper');",
        "  ctx.write('wallpaper/index.html', '<!doctype html>\\n');",
        "  ctx.writeJson('wallpaper/LivelyInfo.json', { Type: 1 });",
        "  ctx.write('wallpaper/js/app.js', 'var a = 1;\\n');",
      ].join('\n')),
    },
  });
  const r = await runBuild(root);
  assert.equal(r.code, 0, r.err);
  assert.equal(ZIP_NAME, 'PixelClockDesktop-wallpaper.zip');
  const zip = path.join(root, 'dist', ZIP_NAME);
  assert.ok(fs.statSync(zip).size > 0);
  assert.match(r.out, /zip dist\/wallpaper\/ -> dist\/PixelClockDesktop-wallpaper\.zip/);
  const names = [];
  const buf = fs.readFileSync(zip);
  for (let i = buf.indexOf('PK\u0001\u0002'); i !== -1; i = buf.indexOf('PK\u0001\u0002', i + 4)) {
    const n = buf.readUInt16LE(i + 28);
    names.push(buf.toString('utf8', i + 46, i + 46 + n));
  }
  assert.deepEqual(names.sort(), ['LivelyInfo.json', 'index.html', 'js/app.js']);
});
