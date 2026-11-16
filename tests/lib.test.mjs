// node --test tests/lib.test.mjs
// tools/lib/glyphs.mjs (the safe glyph set), tools/lib/config.mjs (config/user.json rules; the city is never printed)
// and tools/lib/vendor.mjs (SYNC.json integrity, theme order, the two dist layouts).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SAFE_EXTRA, allSafe, hex, isSafeChar, unsafeChars } from '../tools/lib/glyphs.mjs';
import { CONFIG_KEYS, EXAMPLE_REL, LIMITS, loadConfig, MISSING_CONFIG, shortcutHosts, validateConfig } from '../tools/lib/config.mjs';
import { checkVendor, themeOrder, vendorSourceOf, vendorTarget } from '../tools/lib/vendor.mjs';
import { makeTempDir, readJsonStrict, rmrf } from '../tools/lib/fsx.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VENDOR = path.join(ROOT, 'vendor', 'pixelclock');
const temps = [];
test.after(async () => { for (const d of temps) await rmrf(d); });

test('glyphs: ASCII, box drawing (rounded corners included) and exactly the listed extras', () => {
  assert.equal(SAFE_EXTRA, '▀▄█▌▐░▒▓°·»›•←↑→↓∙≈±≡⌂☼▸●○');
  for (const ch of ['a', '~', ' ', '╭', '╮', '╰', '╯', '─', '│', '┌', '░', '·', '›', '⌂', '☼', '●']) assert.equal(isSafeChar(ch), true, hex(ch.codePointAt(0)));
  for (const ch of ['✓', '∞', 'λ', '☃', 'é', '\t', '\n', '', 'ab', '😀', '▁']) assert.equal(isSafeChar(ch), false, JSON.stringify(ch));
  assert.deepEqual(unsafeChars('ok ✓✓ é\n\t░'), ['U+00E9', 'U+2713']);
  assert.equal(allSafe().length, 95 + 128 + 26);
});

const GOOD = {
  city: 'Berlin', units: 'C', clock: '24h', sunTimes: true, weather: false,
  shortcuts: [{ label: 'docs', url: 'https://example.org/a' }, { label: 'local', url: 'http://localhost:8080/' }], taskbarPx: 0,
};

const EXAMPLE_FILE = path.join(ROOT, 'config', 'user.example.json');
const USER_FILE = path.join(ROOT, 'config', 'user.json');
const sorted = (keys) => [...keys].sort();
const kindOf = (v) => (Array.isArray(v) ? 'array' : v === null ? 'null' : typeof v);
const HOSTNAME = /^(localhost|[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+)$/;

test('config: the neutral example is valid, with every key and its own sample values', () => {
  const example = readJsonStrict(EXAMPLE_FILE, 'config/user.example.json');
  assert.deepEqual(validateConfig(example), []);
  assert.deepEqual(sorted(Object.keys(example)), sorted(CONFIG_KEYS));
  assert.deepEqual([example.city, example.units, example.clock, example.taskbarPx], ['Berlin', 'C', '24h', 56]);
  assert.deepEqual(example.shortcuts.map((s) => s.label), ['wikipedia', 'maps', 'open-meteo']);
  assert.ok(example.shortcuts.length >= 1 && example.shortcuts.length <= LIMITS.shortcuts);
  assert.deepEqual(shortcutHosts(example), example.shortcuts.map((s) => new URL(s.url).hostname));
  assert.deepEqual(shortcutHosts(GOOD), ['example.org', 'localhost']);
  assert.deepEqual(validateConfig(GOOD), []);
});

test('config: every example link opens by its own name in the terminal (no label is a built-in command)', async () => {
  const example = readJsonStrict(EXAMPLE_FILE, 'config/user.example.json');
  const { loadTerm } = await import('./newtab-term-load.mjs');
  const C = loadTerm().lib('commands.js');
  assert.equal(C.isBuiltinName('weather'), true, 'the check itself knows a built-in');
  for (const s of example.shortcuts) assert.equal(C.isBuiltinName(s.label), false, `"${s.label}" is a built-in command, so typing it would never open the link`);
});

test('config: loadConfig() on a fresh clone says what to do; bad JSON and bad values are problems', () => {
  const root = makeTempDir('pcd-configtest-');
  temps.push(root);
  assert.equal(EXAMPLE_REL, 'config/user.example.json');
  assert.deepEqual(loadConfig(root), { config: null, problems: [MISSING_CONFIG] });
  assert.match(MISSING_CONFIG, /^config\/user\.json is missing: copy config\/user\.example\.json to config\/user\.json/);
  fs.mkdirSync(path.join(root, 'config'));
  fs.copyFileSync(EXAMPLE_FILE, path.join(root, 'config', 'user.json'));
  const ok = loadConfig(root);
  assert.deepEqual(ok.problems, []);
  assert.equal(ok.config.city, 'Berlin');
  fs.writeFileSync(path.join(root, 'config', 'user.json'), '{ "city": "Berlin", }\n');
  assert.match(loadConfig(root).problems[0], /^config\/user\.json: invalid JSON/);
  fs.writeFileSync(path.join(root, 'config', 'user.json'), JSON.stringify({ ...GOOD, units: 'K' }));
  assert.match(loadConfig(root).problems.join(), /"units" must be "F" or "C"/);
});

// config/user.json holds your settings and is gitignored. Only its shape is tested, against the example: the same
// keys, the same value kinds, shortcuts as { label, url } (any number up to the limit). No assertion and no message
// here carries one of its values.
test('config: your config/user.json (when present) is valid and agrees with the example on keys and shapes', (t) => {
  if (!fs.existsSync(USER_FILE)) { t.skip('config/user.json is absent (a fresh clone): only the example is checked'); return; }
  const example = readJsonStrict(EXAMPLE_FILE, 'config/user.example.json');
  const real = loadConfig(ROOT);
  assert.equal(real.problems.length, 0, `config/user.json has ${real.problems.length} problem(s): run node tools/validate.mjs`);
  assert.deepEqual(sorted(Object.keys(real.config)), sorted(Object.keys(example)), 'user.json and user.example.json have the same keys');
  for (const key of Object.keys(example)) assert.equal(kindOf(real.config[key]), kindOf(example[key]), `"${key}" has the example's kind`);
  const list = real.config.shortcuts;
  assert.ok(list.length <= LIMITS.shortcuts, `at most ${LIMITS.shortcuts} shortcuts`);
  list.forEach((s, i) => {
    assert.deepEqual(sorted(Object.keys(s)), ['label', 'url'], `shortcuts[${i}] is { label, url }`);
    assert.ok(typeof s.label === 'string' && s.label.trim().length > 0 && s.label.length <= LIMITS.label, `shortcuts[${i}].label`);
    let protocol = '';
    try { protocol = new URL(s.url).protocol; } catch { /* a URL error would carry the value: report the index only */ }
    assert.ok(['http:', 'https:'].includes(protocol), `shortcuts[${i}].url is an http(s) URL`);
  });
  const hosts = shortcutHosts(real.config);
  assert.ok(hosts.length >= Math.min(1, list.length) && hosts.length <= list.length, 'one host per shortcut at most');
  hosts.forEach((h, i) => assert.ok(HOSTNAME.test(h), `shortcut host ${i} is a lower-case host name`));
});

test('config: each rule rejects its bad value, and messages never carry the city', () => {
  const cases = [
    [{ city: 7 }, /"city" must be a string/],
    [{ city: 'x'.repeat(81) }, /at most 80 characters/],
    [{ units: 'K' }, /"units" must be "F" or "C"/],
    [{ clock: '12' }, /"clock" must be "12h" or "24h"/],
    [{ sunTimes: 'yes' }, /"sunTimes" must be true or false/],
    [{ shortcuts: {} }, /"shortcuts" must be an array/],
    [{ shortcuts: Array(10).fill({ label: 'a', url: 'https://a.example' }) }, /at most 9 \{ label, url \}/],
    [{ shortcuts: [{ label: '', url: 'https://a.example' }] }, /\.label must be 1-24 characters/],
    [{ shortcuts: [{ label: 'a', url: 'ftp://a.example' }] }, /\.url must be an http\(s\) URL/],
    [{ shortcuts: [{ label: 'a', url: 'https://a.example', icon: 'x' }] }, /unknown keys icon/],
    [{ taskbarPx: -1 }, /"taskbarPx" must be an integer from 0 to 200/],
    [{ taskbarPx: 56.5 }, /"taskbarPx" must be an integer from 0 to 200 \(got 56\.5\)/],
    [{ theme: 'mono' }, /unknown key "theme"/],
  ];
  for (const [change, re] of cases) {
    const p = validateConfig({ ...GOOD, ...change });
    assert.ok(p.some((m) => re.test(m)), `${JSON.stringify(change)} -> ${p.join('; ')}`);
  }
  const missing = { ...GOOD };
  delete missing.weather;
  assert.match(validateConfig(missing).join(), /"weather" is missing/);
  const cities = ['Berlin', 'Zzyzx Springs'];
  if (fs.existsSync(USER_FILE)) cities.push(readJsonStrict(USER_FILE, 'config/user.json').city);
  cities.forEach((city, i) => {
    const all = validateConfig({ ...GOOD, city, units: 'K', extra: 1, shortcuts: 'x' }).join(' ');
    assert.ok(all.length > 0, 'the bad values are reported');
    assert.equal(all.includes(city), false, `no message carries the city (probe ${i})`);
  });
});

test('vendor: theme order (seasons, then holidays in HOLIDAYS order) with ids, kinds and names', () => {
  const order = themeOrder(VENDOR);
  assert.deepEqual(order.map((t) => t.id), ['winter', 'spring', 'summer', 'autumn', 'newyear', 'lunarnewyear', 'valentines', 'stpatricks', 'easter', 'july4', 'halloween', 'thanksgiving', 'christmas']);
  assert.ok(order.every((t) => t.file === `themes/${t.id}.js`));
  assert.deepEqual(order.slice(0, 4).map((t) => t.kind), ['season', 'season', 'season', 'season']);
  assert.ok(order.slice(4).every((t) => t.kind === 'holiday'));
  assert.equal(order.find((t) => t.id === 'halloween').name, 'Haunted hill');
});

test('vendor: the page and render layouts map back to vendor paths', () => {
  const sync = JSON.parse(fs.readFileSync(path.join(VENDOR, 'SYNC.json'), 'utf8'));
  for (const f of sync.files) {
    for (const render of [false, true]) {
      const target = vendorTarget(f.path, { render, screens: true });
      if (target === null) {
        assert.equal(f.path, 'tools/render.js');
        continue;
      }
      assert.equal(vendorSourceOf(target), f.path, `${f.path} (render ${render})`);
    }
  }
  assert.equal(vendorTarget('simulator/screens.js', {}), null, 'pages skip screens.js unless asked');
  assert.equal(vendorTarget('simulator/themes/autumn.js', {}), 'themes/autumn.js');
  assert.equal(vendorSourceOf('main.js'), null);
});

test('vendor: checkVendor catches a missing SYNC.json, an edited file and an unlisted file', () => {
  const dir = path.join(makeTempDir('pcd-vendortest-'), 'pixelclock');
  temps.push(path.dirname(dir));
  fs.cpSync(VENDOR, dir, { recursive: true });
  assert.equal(checkVendor(dir).ok, true);
  fs.writeFileSync(path.join(dir, 'simulator', 'themes', 'zz.js'), '// unlisted\n');
  fs.appendFileSync(path.join(dir, 'simulator', 'engine.js'), '\n');
  const r = checkVendor(dir);
  assert.equal(r.ok, false);
  assert.ok(r.problems.some((p) => /simulator\/engine\.js: \d+ bytes, SYNC\.json says \d+/.test(p)), r.problems.join('\n'));
  assert.ok(r.problems.some((p) => /simulator\/themes\/zz\.js: not listed in SYNC\.json/.test(p)));
  fs.rmSync(path.join(dir, 'SYNC.json'));
  assert.match(checkVendor(dir).problems[0], /SYNC\.json: ENOENT/);
  assert.match(checkVendor(path.join(dir, 'nope')).problems[0], /does not exist \(run node tools\/sync\.mjs\)/);
});
