// The new tab's build and validate plugins (tools/build/newtab.mjs, tools/validate/newtab.mjs): a real build of the
// plugin into a temporary dist (never dist/ itself; the clock repo is not read) with the neutral
// config/user.example.json, the package's files and page order (the console, the terminal's scripts before
// ntp-app.js), the validator's rows on it, and the guards: exact manifest keys and permissions, the page rules (boot.js
// first and blocking, the rest deferred in build order), the template marks, the script and style order, the size of
// boot.js, the font.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

function findRoot(dir) {
  for (let d = dir; ; d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, 'tools', 'build.mjs'))) return d;
    if (path.dirname(d) === d) throw new Error('repo root not found');
  }
}
const ROOT = findRoot(import.meta.dirname);
const imp = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href);
const build = await imp('tools/build.mjs');
const plugin = await imp('tools/build/newtab.mjs');
const validator = await imp('tools/validate/newtab.mjs');
const core = await imp('tools/validate.mjs');
const { shortcutHosts, validateConfig } = await imp('tools/lib/config.mjs');
const EXAMPLE = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'user.example.json'), 'utf8'));

const SRC_MANIFEST = JSON.parse(fs.readFileSync(path.join(ROOT, 'src', 'newtab', 'manifest.json'), 'utf8'));
const OWN_FILES = ['boot.js', 'newtab.html', 'css/newtab.css', 'css/ntp-panel.css', 'js/ntp-app.js', 'js/ntp-links.js', 'js/ntp-panel.js',
  'js/ntp-settings.js', 'js/ntp-store.js', 'js/ntp-status.js'];

/** Build the newtab piece into a fresh temp dist once for the whole file. */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pcd-newtab-build-'));
const dist = path.join(tmp, 'dist');
const logs = [];
let code = 0;
try {
  assert.deepEqual(validateConfig(EXAMPLE), [], 'the example config is valid');
  const gen = await build.generateStage({ root: ROOT, config: EXAMPLE, vendor: path.join(ROOT, 'vendor', 'pixelclock') });
  const ctx = build.createContext({ root: ROOT, dist, config: EXAMPLE, tokens: gen.tokens, anchors: gen.anchors, generated: gen.generated, render: false, piece: 'newtab', log: (m) => logs.push(m) });
  await plugin.build(ctx);
} catch (e) {
  code = 1;
  logs.push(e && e.stack ? e.stack : String(e));
}
const PKG = path.join(dist, 'newtab');
process.on('exit', () => fs.rmSync(tmp, { recursive: true, force: true }));

const list = (dir, base = dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? list(path.join(dir, e.name), base) : [path.relative(base, path.join(dir, e.name)).split(path.sep).join('/')]));

test('the build writes dist/newtab only, with the manifest, page, boot.js, engine, shared and own scripts and icons', () => {
  assert.equal(code, 0, logs.join('\n'));
  assert.deepEqual(fs.readdirSync(dist), ['newtab']);
  const files = list(PKG);
  for (const f of ['manifest.json', 'newtab.html', 'boot.js', 'css/newtab.css', 'css/ntp-panel.css', 'css/pcd-console.css', 'js/pcd-config.js',
    'js/pcd-hook.js', 'js/pcd-engine.js', 'js/pcd-host.js', 'js/pcd-console.js', 'js/pixelclock/engine.js', 'js/pixelclock/schedule.js',
    'js/pixelclock/themes/autumn.js', 'js/ntp-settings.js', 'js/ntp-store.js', 'js/ntp-status.js', 'js/ntp-links.js', 'js/ntp-panel.js',
    'js/term/lib/router.js', 'js/term/term-shell.js', 'js/term/term-ui.js', 'js/ntp-app.js', 'icons/icon16.png', 'icons/icon32.png',
    'icons/icon48.png', 'icons/icon128.png']) {
    assert.ok(files.includes(f), `${f} is packaged`);
  }
  for (const f of files) {
    assert.ok(!f.split('/').some((p) => p.startsWith('_')), `${f}: no leading "_"`);
    assert.ok(!/(^|\/)(screens|render|main|sound)\.js$|\.pem$|\.crx$|EXTENSION_ID/.test(f), `${f} must not ship`);
  }
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(PKG, 'manifest.json'), 'utf8')), SRC_MANIFEST);
  for (const name of fs.readdirSync(path.join(ROOT, 'vendor', 'pixelclock', 'simulator', 'themes'))) {
    assert.ok(fs.readFileSync(path.join(PKG, 'js', 'pixelclock', 'themes', name)).equals(fs.readFileSync(path.join(ROOT, 'vendor', 'pixelclock', 'simulator', 'themes', name))), `${name} byte identical`);
  }
});

test('the page: boot.js first and blocking, then every script deferred in build order, ntp-app.js last', () => {
  const html = fs.readFileSync(path.join(PKG, 'newtab.html'), 'utf8');
  assert.deepEqual(validator.pageProblems(html), []);
  const tags = validator.scriptTags(html);
  const srcs = tags.map((t) => t.src);
  assert.equal(srcs[0], 'boot.js');
  assert.deepEqual(srcs.slice(1, 4), ['js/pixelclock/engine.js', 'js/pcd-hook.js', 'js/pixelclock/schedule.js']);
  const themes = srcs.filter((s) => s.startsWith('js/pixelclock/themes/')).map((s) => path.basename(s, '.js'));
  assert.deepEqual(themes.slice(0, 4), ['winter', 'spring', 'summer', 'autumn'], 'seasons first, then holidays');
  assert.equal(themes.length, fs.readdirSync(path.join(ROOT, 'vendor', 'pixelclock', 'simulator', 'themes')).length);
  assert.ok(srcs.indexOf('js/pcd-config.js') < srcs.indexOf('js/ntp-settings.js'));
  const term = srcs.filter((s) => s.startsWith('js/term/'));
  assert.ok(term.length >= 9 && term.every((s) => srcs.indexOf(s) < srcs.indexOf('js/ntp-app.js') && srcs.indexOf(s) > srcs.indexOf('js/ntp-panel.js')),
    'the terminal (its libraries first) loads after the new tab\'s modules and before ntp-app.js');
  assert.ok(srcs.indexOf('js/term/lib/router.js') < srcs.indexOf('js/term/term-shell.js'));
  assert.ok(srcs.indexOf('js/pcd-console.js') < srcs.indexOf('js/pcd-config.js'), 'the shared scripts (the console) first');
  assert.equal(srcs[srcs.length - 1], 'js/ntp-app.js');
  assert.ok(tags.slice(1).every((t) => t.defer && !t.async && !t.module && !t.inline));
  assert.match(html, /<link rel="stylesheet" href="css\/newtab\.css">/);
  assert.ok(!html.includes('PCD:'), 'every template mark is filled');
  for (const m of html.matchAll(/(?:src|href)="([^"]+)"/g)) assert.ok(fs.existsSync(path.join(PKG, m[1])), `${m[1]} exists`);
  assert.ok(fs.statSync(path.join(PKG, 'boot.js')).size < plugin.BOOT_MAX_BYTES);
});

test('js/pcd-config.js sets PCD.CONFIG to the config\'s values (ASCII only; the example config here)', () => {
  const text = fs.readFileSync(path.join(PKG, 'js', 'pcd-config.js'), 'utf8');
  assert.ok(/^[\x0a\x20-\x7e]*$/.test(text), 'ASCII only');
  const context = vm.createContext({});
  vm.runInContext(text, context);
  assert.equal(JSON.stringify(context.PCD.CONFIG.shortcuts), JSON.stringify(EXAMPLE.shortcuts));
  assert.equal(context.PCD.CONFIG.units, EXAMPLE.units);
  assert.equal(context.PCD.CONFIG.clock, EXAMPLE.clock);
  assert.equal(context.PCD.CONFIG.city, 'Berlin');
});

test('the validator plugin passes on the fresh package, and the core checks pass for the new tab\'s own files', async () => {
  const config = EXAMPLE;
  const vctx = core.createValidateContext({ root: ROOT, dist, config });
  const rows = await validator.validate(vctx);
  assert.ok(rows.length >= 8);
  for (const r of rows) assert.equal(r.pass, true, `${r.name}: ${r.detail}`);
  const allowed = [...core.ALLOWED_HOSTS, ...shortcutHosts(config)];
  for (const f of OWN_FILES) {
    const text = fs.readFileSync(path.join(PKG, f), 'utf8');
    assert.deepEqual(core.foreignUrls(text, allowed), [], `${f}: URLs`);
    if (f.endsWith('.js')) assert.deepEqual(core.lintJs(text), [], `${f}: CSP lint`);
    if (f.endsWith('.html')) assert.deepEqual(core.lintHtml(text), [], `${f}: CSP lint`);
    assert.equal(core.scanGlyphs(text).size, 0, `${f}: safe glyphs`);
    assert.ok(!text.includes('\r'), `${f}: LF`);
    assert.ok(text.charCodeAt(0) !== 0xfeff, `${f}: no BOM`);
  }
});

test('the validator plugin says when the package is missing, and catches a broken one', async () => {
  const empty = path.join(tmp, 'empty-dist');
  fs.mkdirSync(empty, { recursive: true });
  const rows = await validator.validate(core.createValidateContext({ root: ROOT, dist: empty, config: {} }));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].pass, false);
  // A copy with a deferred boot.js, an extra permission and a non-crisp icon.
  const broken = path.join(tmp, 'broken-dist');
  fs.cpSync(dist, broken, { recursive: true });
  const bp = path.join(broken, 'newtab');
  const m = JSON.parse(fs.readFileSync(path.join(bp, 'manifest.json'), 'utf8'));
  m.permissions.push('tabs');
  fs.writeFileSync(path.join(bp, 'manifest.json'), JSON.stringify(m, null, 2) + '\n');
  fs.writeFileSync(path.join(bp, 'newtab.html'), fs.readFileSync(path.join(bp, 'newtab.html'), 'utf8').replace('<script src="boot.js"></script>', '<script src="boot.js" defer></script>'));
  fs.copyFileSync(path.join(bp, 'icons', 'icon16.png'), path.join(bp, 'icons', 'icon32.png'));
  fs.writeFileSync(path.join(bp, 'js', 'orphan.js'), '// not loaded\n');
  const got = await validator.validate(core.createValidateContext({ root: ROOT, dist: broken, config: EXAMPLE }));
  const failed = got.filter((r) => r.pass === false).map((r) => r.name);
  assert.ok(failed.some((n) => /manifest keys and permissions/.test(n)), failed.join('; '));
  assert.ok(failed.some((n) => /boot\.js the only blocking script/.test(n)), failed.join('; '));
  assert.ok(failed.some((n) => /icons/.test(n)), failed.join('; '));
  assert.ok(failed.some((n) => /every packaged script is loaded/.test(n)), failed.join('; '));
});

test('checkManifest: exactly the expected keys and permissions (no CSP override, no worker) plus a valid public key', () => {
  assert.deepEqual(plugin.checkManifest(SRC_MANIFEST), []);
  const bad = (patch) => plugin.checkManifest({ ...SRC_MANIFEST, ...patch });
  assert.ok(bad({ permissions: ['storage', 'search', 'tabs'] }).length);
  assert.ok(bad({ permissions: ['storage'] }).length);
  assert.ok(bad({ optional_permissions: [] }).length);
  assert.ok(bad({ host_permissions: ['<all_urls>'] }).length);
  assert.ok(bad({ host_permissions: ['http://pixelclock.local/*', 'https://example.com/*'] }).length);
  assert.ok(bad({ content_security_policy: { extension_pages: "script-src 'self'" } }).length);
  assert.ok(bad({ background: { service_worker: 'sw.js' } }).length);
  assert.ok(bad({ web_accessible_resources: [] }).length);
  assert.ok(bad({ manifest_version: 2 }).length);
  assert.ok(bad({ chrome_url_overrides: { newtab: 'index.html' } }).length);
  assert.ok(bad({ description: '' }).length);
  assert.ok(bad({ description: 'x'.repeat(133) }).length);
  assert.ok(bad({ key: undefined }).length);
  assert.ok(bad({ key: '-----BEGIN ' + 'PRIVATE KEY-----\nMIIE\n-----END ' + 'PRIVATE KEY-----' }).length);
  assert.ok(bad({ key: 'bm90IGEga2V5' }).length);
  const { key, ...noKey } = SRC_MANIFEST;
  assert.ok(key);
  assert.ok(plugin.checkManifest(noKey).some((p) => /key/.test(p)));
  assert.deepEqual(plugin.checkManifest(null), ['the manifest must be a JSON object']);
  assert.throws(() => plugin.checkId(SRC_MANIFEST, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'), /EXTENSION_ID\.txt says/);
});

test('renderHtml: each mark exactly once; preload, styles and deferred scripts filled in', () => {
  const t = 'a\n<!-- PCD:PRELOAD -->\n<!-- PCD:STYLES -->\n<!-- PCD:SCRIPTS -->\nb\n';
  const out = plugin.renderHtml(t, { preload: ['fonts/F.ttf'], styles: ['css/a.css', 'css/b.css'], scripts: ['js/x.js'] });
  assert.equal(out, 'a\n<link rel="preload" href="fonts/F.ttf" as="font" type="font/ttf" crossorigin>\n<link rel="stylesheet" href="css/a.css">\n<link rel="stylesheet" href="css/b.css">\n<script src="js/x.js" defer></script>\nb\n');
  assert.equal(plugin.renderHtml(t, {}), 'a\nb\n', 'an empty group leaves no blank line');
  assert.throws(() => plugin.renderHtml('<!-- PCD:STYLES --><!-- PCD:SCRIPTS -->', {}), /PRELOAD/);
  assert.throws(() => plugin.renderHtml(t + '<!-- PCD:SCRIPTS -->', {}), /exactly once \(found 2\)/);
  assert.equal(plugin.renderHtml(t, { scripts: ['js/$&.js'] }).includes('js/$&.js'), true, 'no replacement patterns');
});

test('newtabScripts / newtabStyles: known order, other parts before ntp-app.js, generated and "_" names refused', () => {
  const dir = path.join(tmp, 'order');
  const js = path.join(dir, 'js');
  const css = path.join(dir, 'css');
  fs.mkdirSync(js, { recursive: true });
  fs.mkdirSync(css, { recursive: true });
  for (const n of ['ntp-app.js', 'ntp-links.js', 'ntp-zeta.js', 'ntp-settings.js', 'ntp-alpha.js', 'ntp-store.js']) fs.writeFileSync(path.join(js, n), '');
  assert.deepEqual(plugin.newtabScripts(js), ['ntp-settings.js', 'ntp-store.js', 'ntp-links.js', 'ntp-alpha.js', 'ntp-zeta.js', 'ntp-app.js']);
  // the terminal: its libraries by name, then its own scripts in TERM_SCRIPTS order (others by name), before ntp-app.js
  fs.mkdirSync(path.join(js, 'term', 'lib'), { recursive: true });
  for (const n of ['router.js', 'format.js']) fs.writeFileSync(path.join(js, 'term', 'lib', n), '');
  for (const n of ['term-ui.js', 'term-extra.js', 'term-shell.js', 'term-commands.js']) fs.writeFileSync(path.join(js, 'term', n), '');
  assert.deepEqual(plugin.newtabScripts(js).slice(5), ['term/lib/format.js', 'term/lib/router.js', 'term/term-commands.js', 'term/term-shell.js',
    'term/term-ui.js', 'term/term-extra.js', 'ntp-app.js']);
  fs.writeFileSync(path.join(js, 'term', '_old.js'), '');
  assert.throws(() => plugin.newtabScripts(js), /term\/: file names must not start with/);
  fs.rmSync(path.join(js, 'term'), { recursive: true });
  fs.writeFileSync(path.join(js, 'pcd-config.js'), '');
  assert.throws(() => plugin.newtabScripts(js), /generates it/);
  fs.rmSync(path.join(js, 'pcd-config.js'));
  fs.writeFileSync(path.join(js, '_draft.js'), '');
  assert.throws(() => plugin.newtabScripts(js), /must not start with/);
  fs.rmSync(path.join(js, '_draft.js'));
  fs.rmSync(path.join(js, 'ntp-app.js'));
  assert.throws(() => plugin.newtabScripts(js), /ntp-app\.js is missing/);
  for (const n of ['ntp-term.css', 'newtab.css', 'ntp-panel.css']) fs.writeFileSync(path.join(css, n), '');
  assert.deepEqual(plugin.newtabStyles(css), ['newtab.css', 'ntp-panel.css', 'ntp-term.css']);
  fs.rmSync(path.join(css, 'newtab.css'));
  assert.throws(() => plugin.newtabStyles(css), /newtab\.css is missing/);
});

test('the build stops with a clear message when the font is missing, before it cleans or writes anything', async () => {
  const root = path.join(tmp, 'no-font');
  fs.mkdirSync(root, { recursive: true });
  const out = path.join(root, 'dist');
  const ctx = build.createContext({ root, dist: out, config: EXAMPLE, render: false, piece: 'newtab', log: () => {} });
  await assert.rejects(plugin.build(ctx), /design\/fonts\/CascadiaMono-wght\.ttf is missing/);
  assert.equal(fs.existsSync(out), false, 'nothing is cleaned or written');
});

test('pageProblems: each page-order mistake is caught', () => {
  const html = fs.readFileSync(path.join(PKG, 'newtab.html'), 'utf8');
  const has = (h, re) => validator.pageProblems(h).some((p) => re.test(p));
  assert.ok(has(html.replace('<meta charset="utf-8">\n', '').replace('<title>', '<meta charset="utf-8">\n<title>'), /meta charset/));
  assert.ok(has(html.replace('<script src="js/ntp-app.js" defer>', '<script src="js/ntp-app.js" async>'), /deferred classic script/));
  assert.ok(has(html.replace('<script src="js/ntp-app.js" defer>', '<script src="js/ntp-app.js" type="module" defer>'), /deferred classic script/));
  assert.ok(has(html.replace('</head>', '<script>alert(1)</script>\n</head>'), /inline script|last script/));
  assert.ok(has(html.replace('</head>', '<script src="js/pixelclock/screens.js" defer></script>\n</head>'), /screens\.js|last script/));
  assert.ok(has(html.replace('<title>new tab</title>', '<title>tab</title>'), /title/));
  assert.ok(has(html.replace('</body>', '<script src="x.js"></script>\n</body>'), /<body>/));
  assert.ok(has(html.replace('<script src="js/pcd-hook.js" defer></script>\n', ''), /pcd-hook\.js/));
});
