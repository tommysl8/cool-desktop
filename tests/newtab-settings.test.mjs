// node --test "tests/newtab-settings.test.mjs"
// The one settings schema (src/newtab/js/ntp-settings.js, PCD.settings): keys and scopes (the new tab's table and
// the wallpaper's), defaults from the config, validation of every kind, unknown keys, migration and the "v" field,
// overrides and patches, shortcut URLs, the worst case under 4 KB per stored item (with
// src/newtab/js/ntp-store.js), the boot mirror, the generated PCD.CONFIG script and source hygiene.
// Privacy: never reads config/user.json (your city). Configs here are neutral (Berlin, the
// project's sample city) or the committed config/user.example.json.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);

function findRoot(dir) {
  for (let d = dir; ; d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, 'tools', 'build.mjs'))) return d;
    if (path.dirname(d) === d) throw new Error('repo root not found');
  }
}
const ROOT = findRoot(path.dirname(fileURLToPath(import.meta.url)));
const S = require(path.join(ROOT, 'src', 'newtab', 'js', 'ntp-settings.js'));
const St = require(path.join(ROOT, 'src', 'newtab', 'js', 'ntp-store.js'));
const EXAMPLE_FILE = path.join(ROOT, 'config', 'user.example.json');

const ch = (...codes) => String.fromCodePoint(...codes);
const LT6 = '\\' + 'u003C'; // how Chrome's JSON writer spells "<"

/** A neutral config shaped like config/user.json. */
const BERLIN = Object.freeze({
  city: 'Berlin',
  units: 'C',
  clock: '24h',
  sunTimes: false,
  weather: true,
  shortcuts: [
    { label: 'wiki', url: 'https://www.wikipedia.org' },
    { label: 'maps', url: 'www.openstreetmap.org' },
  ],
  taskbarPx: 56,
});
/** A US-style neutral config: F and 12 h, a placeholder city. */
const PORTLAND = Object.freeze({
  city: 'Portland, OR', units: 'F', clock: '12h', sunTimes: true, weather: true, shortcuts: [], taskbarPx: 56,
});

const NEWTAB_KEYS = ['clock24', 'city', 'units', 'sunTimes', 'weather', 'weatherFx', 'theme', 'reducedMotion', 'performance',
  'shortcutsMode', 'shortcuts', 'clockStatus', 'focusTerminal'];
const WALLPAPER_KEYS = ['theme', 'shakeHourly', 'clock24', 'city', 'units', 'sunTimes', 'weather', 'weatherFx', 'reducedMotion',
  'performance', 'taskbarSpace', 'debugOverlay'];
const STILL_KEYS = ['theme', 'clock24', 'units', 'city', 'sunTimes', 'weather', 'weatherFx', 'taskbarSpace'];

test('keys and scopes: the new tab\'s settings table, the wallpaper\'s, still.json for the still', () => {
  assert.deepEqual(S.keys('newtab'), NEWTAB_KEYS, 'the new tab\'s order');
  assert.deepEqual([...S.keys('wallpaper')].sort(), [...WALLPAPER_KEYS].sort());
  assert.deepEqual([...S.keys('still')].sort(), [...STILL_KEYS].sort());
  assert.deepEqual(S.keys(), S.KEYS.map((d) => d.key));
  assert.equal(new Set(S.keys()).size, S.keys().length, 'no duplicate key');
  assert.throws(() => S.keys('desktop'), /unknown scope/);
  assert.throws(() => S.defaults({}, { scope: 'nope' }), /unknown scope/);
  assert.equal(S.VERSION, 1);
  assert.ok(Object.isFrozen(S.KEYS) && S.KEYS.every((d) => Object.isFrozen(d)));
  for (const d of S.KEYS) {
    assert.ok(typeof d.label === 'string' && d.label, `${d.key} has a label for the panels`);
    if (d.kind === 'enum') assert.equal(d.options.length, d.values.length, `${d.key}: one option label per value`);
    assert.ok(S.validate(d.key, d.fallback).ok, `${d.key}: the fallback is valid`);
  }
  assert.equal(S.spec('toString'), null);
  assert.equal(S.spec('__proto__'), null);
});

test('defaults come from the config; a missing or bad config field takes the built-in fallback', () => {
  const d = S.defaults(BERLIN, { scope: 'newtab' });
  assert.deepEqual(Object.keys(d), NEWTAB_KEYS);
  assert.deepEqual(d, {
    clock24: true, city: 'Berlin', units: 'C', sunTimes: false, weather: true, weatherFx: true, theme: 'auto',
    reducedMotion: 'auto', performance: 'auto', shortcutsMode: 'custom',
    shortcuts: [{ label: 'wiki', url: 'https://www.wikipedia.org' }, { label: 'maps', url: 'https://www.openstreetmap.org' }],
    clockStatus: true, focusTerminal: true,
  });
  const us = S.defaults(PORTLAND, { scope: 'newtab' });
  assert.equal(us.clock24, false, 'config clock "12h"');
  assert.equal(us.units, 'F');
  assert.deepEqual(us.shortcuts, [], 'an empty list stays empty');
  const wp = S.defaults(BERLIN, { scope: 'wallpaper' });
  assert.deepEqual(Object.keys(wp).sort(), [...WALLPAPER_KEYS].sort());
  assert.equal(wp.shakeHourly, true);
  assert.equal(wp.taskbarSpace, true);
  assert.equal(wp.debugOverlay, false);
  // no config at all: neutral fallbacks, and no built-in shortcut list
  for (const cfg of [undefined, null, {}, 'nope', []]) {
    const f = S.defaults(cfg, { scope: 'newtab' });
    assert.deepEqual(f, {
      clock24: false, city: '', units: 'F', sunTimes: true, weather: true, weatherFx: true, theme: 'auto',
      reducedMotion: 'auto', performance: 'auto', shortcutsMode: 'custom', shortcuts: [], clockStatus: true, focusTerminal: true,
    }, JSON.stringify(cfg));
  }
  const bad = S.defaults({ units: 'K', clock: '13h', city: 42, shortcuts: 'x', sunTimes: 'maybe' }, { scope: 'wallpaper' });
  assert.equal(bad.units, 'F');
  assert.equal(bad.clock24, false);
  assert.equal(bad.city, '42', 'a number is a valid city text');
  assert.equal(bad.sunTimes, true);
  // a config field no setting reads changes nothing
  for (const scope of S.SCOPES) assert.deepEqual(S.defaults({ ...BERLIN, nope: 1 }, { scope }), S.defaults(BERLIN, { scope }), scope);
  // the defaults are fresh copies: changing one never changes the next
  const a = S.defaults(BERLIN, { scope: 'newtab' });
  a.shortcuts.push({ label: 'x', url: 'https://x.org' });
  assert.equal(S.defaults(BERLIN, { scope: 'newtab' }).shortcuts.length, 2);
  // opts.config is the same as the first argument
  assert.deepEqual(S.defaults(undefined, { config: BERLIN, scope: 'newtab' }), d);
});

test('the committed example config is neutral and valid for the schema and for tools/lib/config.mjs', async () => {
  assert.ok(fs.existsSync(EXAMPLE_FILE), 'config/user.example.json exists');
  const text = fs.readFileSync(EXAMPLE_FILE, 'utf8');
  assert.notEqual(text.charCodeAt(0), 0xfeff, 'no BOM');
  assert.ok(!text.includes('\r'), 'LF only');
  const example = JSON.parse(text);
  assert.deepEqual(S.checkConfig(example), []);
  assert.equal(example.city, 'Berlin', 'the sample city, never a real person\'s');
  const d = S.defaults(example, { scope: 'newtab' });
  assert.ok(d.shortcuts.length >= 1 && d.shortcuts.length <= S.SHORTCUTS_MAX);
  const lib = path.join(ROOT, 'tools', 'lib', 'config.mjs');
  if (fs.existsSync(lib)) {
    const check = await import(pathToFileURL(lib).href);
    assert.deepEqual(check.validateConfig(example), [], 'tools/lib/config.mjs validateConfig accepts the example');
    assert.deepEqual([...check.CONFIG_KEYS].sort(), Object.keys(example).sort(), 'the example has exactly the config keys');
    // the limits agree with the config check of tools/lib/config.mjs
    assert.equal(check.LIMITS.city, S.CITY_MAX);
    assert.equal(check.LIMITS.label, S.LABEL_MAX);
    assert.equal(check.LIMITS.url, S.URL_MAX);
    // the config takes as many links as the console numbers ([1]-[9])
    assert.equal(check.LIMITS.shortcuts, S.SHORTCUTS_MAX);
    // every config key the config check knows is read by the schema (taskbarPx: the band the wallpapers keep clear)
    for (const k of check.CONFIG_KEYS) assert.ok(S.CONFIG_FIELDS.includes(k), `the schema reads config "${k}"`);
  }
});

// Your settings (city, links) live in config/user.json, which must stay out of git; the committed
// config/user.example.json is the neutral one.
test('privacy: .gitignore keeps config/user.json (your city and links) out of git', () => {
  const file = path.join(ROOT, '.gitignore');
  const lines = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').map((l) => l.trim()) : [];
  assert.ok(lines.some((l) => l === 'config/user.json' || l === '/config/user.json'), '.gitignore lists config/user.json');
});

test('validate: every kind takes lenient input and gives the canonical value', () => {
  const ok = (k, v, opts) => {
    const r = S.validate(k, v, opts);
    assert.ok(r.ok, `${k}=${JSON.stringify(v)}: ${r.error}`);
    return r.value;
  };
  const no = (k, v, opts) => {
    const r = S.validate(k, v, opts);
    assert.equal(r.ok, false, `${k}=${JSON.stringify(v)} must be refused`);
    assert.ok(typeof r.error === 'string' && r.error);
    return r.error;
  };
  // booleans
  for (const [v, want] of [[true, true], [false, false], ['on', true], ['OFF', false], ['true', true], [1, true], [0, false], ['yes', true], [' no ', false]]) {
    assert.equal(ok('weather', v), want);
  }
  for (const v of ['maybe', null, undefined, 2, {}, []]) no('weather', v);
  // 12/24 h
  for (const [v, want] of [['24h', true], ['12h', false], ['24', true], [12, false], [24, true], [true, true], ['off', false]]) assert.equal(ok('clock24', v), want);
  no('clock24', '13h');
  // enums
  for (const [v, want] of [['c', 'C'], ['Celsius', 'C'], ['metric', 'C'], ['F', 'F'], ['fahrenheit', 'F'], [' imperial ', 'F']]) assert.equal(ok('units', v), want);
  no('units', 'K');
  no('units', 5);
  for (const k of ['reducedMotion', 'performance']) {
    assert.equal(ok(k, true), 'on');
    assert.equal(ok(k, false), 'off');
    assert.equal(ok(k, 'AUTO'), 'auto');
    assert.equal(ok(k, 'on'), 'on');
    no(k, 'sometimes');
  }
  assert.equal(ok('shortcutsMode', 'top sites'), 'top');
  assert.equal(ok('shortcutsMode', 'custom'), 'custom');
  no('shortcutsMode', 'all');
  // city: one clean line, at most 80 characters (code points)
  assert.equal(ok('city', '  Berlin,   Germany  '), 'Berlin, Germany');
  assert.equal(ok('city', 'a\tb\nc'), 'a b c');
  assert.equal(ok('city', 'Ber' + ch(0x200b) + 'lin' + ch(0x202e)), 'Berlin', 'zero-width and bidi controls go');
  assert.equal(ok('city', 'a' + ch(0x2028) + 'b'), 'a b');
  assert.equal(ok('city', ''), '', 'no city is a valid choice');
  assert.equal(ok('city', 12345), '12345');
  assert.equal(ok('city', 'x'.repeat(80)), 'x'.repeat(80));
  assert.equal(ok('city', ch(0x1f600).repeat(80)).length, 160, '80 emoji are 80 characters');
  assert.match(no('city', 'x'.repeat(81)), /80 characters/);
  no('city', null);
  no('city', { name: 'Berlin' });
  // theme: 'auto' or a well-formed id; with the build's theme list, only its ids
  assert.equal(ok('theme', 'AUTO'), 'auto');
  assert.equal(ok('theme', ' halloween '), 'halloween');
  no('theme', 'Bad Id!');
  no('theme', 7);
  const themes = ['winter', 'autumn'];
  assert.equal(ok('theme', 'winter', { themes }), 'winter');
  assert.match(no('theme', 'halloween', { themes }), /unknown theme/);
  assert.equal(ok('theme', 'autumn', { themes: [{ id: 'auto', name: 'Auto (by date)' }, { id: 'autumn', name: 'Autumn forest' }] }), 'autumn');
  // unknown keys, Object.prototype members included
  for (const k of ['nope', 'toString', '__proto__', 'constructor', 'hasOwnProperty', 'v', '', null, 42]) assert.match(no(k, 1), /unknown setting/);
});

test('shortcuts: http(s) only, https:// added, labels 1-24 characters, at most 9 (the links [1]-[9])', () => {
  const url = (s) => S.normalizeUrl(s);
  const table = [
    ['example.com', 'https://example.com'],
    ['example.com/', 'https://example.com/'],
    ['Example.COM/Path?q=1#h', 'https://example.com/Path?q=1#h'],
    ['http://example.com/a?b#c', 'http://example.com/a?b#c'],
    ['HTTPS://example.com', 'https://example.com'],
    ['https://example.com:443', 'https://example.com'],
    ['localhost:3000', 'http://localhost:3000'],
    ['127.0.0.1:8080/x', 'http://127.0.0.1:8080/x'],
    ['app.localhost', 'http://app.localhost'],
    ['192.168.1.20', 'https://192.168.1.20'],
    ['b' + ch(0xfc) + 'cher.de', 'https://xn--bcher-kva.de'],
    ['https://xn--p1ai.xn--p1ai', 'https://xn--p1ai.xn--p1ai'],
  ];
  for (const [input, want] of table) {
    const r = url(input);
    assert.ok(r.ok, `${input}: ${r.reason}`);
    assert.equal(r.url, want, input);
    assert.deepEqual(url(r.url), r, `${input}: normalizing twice changes nothing`);
  }
  for (const bad of ['', '   ', 'not a url', 'example', 'javascript:alert(1)', 'data:text/html,x', 'ftp://example.com', 'mailto:a@b.cd',
    'file:///C:/x', 'chrome://extensions', 'https://user:pw@example.com', 'user@example.com', 'https://', 'http://exa mple.com',
    'https://example.com/' + 'a'.repeat(300), 42, null, undefined, {}]) {
    const r = url(bad);
    assert.equal(r.ok, false, `${JSON.stringify(bad)} must be refused`);
    assert.ok(r.reason);
  }
  assert.match(url('javascript:alert(1)').reason, /only http and https/);
  assert.match(url('https://user:pw@example.com').reason, /user name or password/);
  assert.match(url('https://example.com/' + 'a'.repeat(300)).reason, /300 characters/);
  assert.equal(url('https://example.com/' + 'a'.repeat(280)).url.length, 300, 'exactly 300 is fine');

  const sc = (item) => S.shortcut(item);
  assert.deepEqual(sc({ label: '  wiki  ', url: 'en.wikipedia.org' }).value, { label: 'wiki', url: 'https://en.wikipedia.org' });
  assert.equal(sc({ alias: 'yt', url: 'https://www.youtube.com' }).value.label, 'yt', 'a short alias label');
  assert.equal(sc({ title: 'A top site', url: 'https://example.org/' }).value.label, 'A top site', 'chrome.topSites title');
  assert.equal(sc({ url: 'https://www.example.com/x' }).value.label, 'example.com', 'a missing label comes from the host');
  assert.equal(sc({ label: '   ', url: 'https://www.example.com/x' }).value.label, 'example.com');
  assert.equal(sc({ label: 'x'.repeat(24), url: 'example.com' }).ok, true);
  assert.match(sc({ label: 'x'.repeat(25), url: 'example.com' }).error, /24 characters/);
  assert.equal(sc({ label: ch(0x1f600).repeat(24), url: 'example.com' }).ok, true, 'code points, not UTF-16 units');
  assert.equal(sc({ label: 'x' }).ok, false);
  assert.equal(sc('example.com').ok, false);
  assert.equal(sc({ label: 'bad', url: 'javascript:alert(1)' }).ok, false);
  assert.deepEqual(Object.keys(sc({ label: 'a', url: 'example.com', extra: 1, icon: 'x' }).value), ['label', 'url'], 'only label and url are kept');

  assert.equal(S.SHORTCUTS_MAX, 9);
  const many = Array.from({ length: 13 }, (_, i) => ({ label: `s${i}`, url: `s${i}.example.com` }));
  const r13 = S.validate('shortcuts', many);
  assert.ok(r13.ok);
  assert.equal(r13.value.length, 9);
  assert.deepEqual(r13.value.map((x) => x.label), ['s0', 's1', 's2', 's3', 's4', 's5', 's6', 's7', 's8'], 'the first 9, in order');
  assert.match(r13.problems.join('\n'), /first 9/);
  // a config with more than 9 shortcuts: the defaults keep its first 9, quietly
  const twelve = { ...BERLIN, shortcuts: Array.from({ length: 12 }, (_, i) => ({ label: `c${i}`, url: `https://c${i}.example.com` })) };
  assert.equal(S.defaults(twelve, { scope: 'newtab' }).shortcuts.length, 9);
  const mixed = S.validate('shortcuts', [{ label: 'a', url: 'a.example.com' }, { label: 'b', url: 'ftp://b' }, 'junk']);
  assert.deepEqual(mixed.value, [{ label: 'a', url: 'https://a.example.com' }]);
  assert.equal(mixed.problems.length, 2);
  assert.equal(S.validate('shortcuts', [{ url: 'ftp://b' }]).ok, false, 'a non-empty list with nothing usable is refused');
  assert.deepEqual(S.validate('shortcuts', []).value, [], 'no shortcuts at all is a valid choice');
  assert.equal(S.validate('shortcuts', { label: 'a', url: 'a.com' }).ok, false);
});

test('normalize and read: unknown keys dropped, bad values replaced by the defaults, nothing pollutes Object.prototype', () => {
  const opts = { config: BERLIN, scope: 'newtab' };
  const n = S.normalize({ city: 'Oslo', units: 'K', bogus: 1, shakeHourly: false, theme: 'nope!', clock24: 'off' }, opts);
  assert.equal(n.city, 'Oslo');
  assert.equal(n.units, 'C', 'bad units -> the config default');
  assert.equal(n.theme, 'auto');
  assert.equal(n.clock24, false);
  assert.ok(!('bogus' in n) && !('shakeHourly' in n), 'unknown and other-scope keys are dropped');
  assert.deepEqual(Object.keys(n), NEWTAB_KEYS);
  const r = S.read({ v: 1, city: 'Oslo', units: 'K', bogus: 1 }, opts);
  assert.equal(r.settings.city, 'Oslo');
  assert.deepEqual(r.valid, { city: 'Oslo' });
  assert.deepEqual(r.unknown, { bogus: 1 });
  assert.match(r.problems.join('\n'), /bogus/);
  assert.match(r.problems.join('\n'), /units/);
  assert.equal(r.from, 1);
  assert.equal(r.migrated, false);
  for (const junk of [null, undefined, 'text', 42, [1, 2]]) {
    assert.deepEqual(S.normalize(junk, opts), S.defaults(BERLIN, { scope: 'newtab' }), JSON.stringify(junk));
  }
  assert.match(S.read('text', opts).problems.join('\n'), /not an object/);
  const evil = JSON.parse('{"__proto__": {"polluted": true}, "constructor": {"prototype": {"polluted": true}}, "city": "Oslo"}');
  const e = S.read(evil, opts);
  assert.equal(e.settings.city, 'Oslo');
  assert.equal(({}).polluted, undefined, 'Object.prototype untouched');
  assert.equal(e.settings.polluted, undefined);
  // the scope decides which keys belong: a wallpaper read keeps shakeHourly, a new tab read drops it
  assert.equal(S.normalize({ shakeHourly: false }, { scope: 'wallpaper' }).shakeHourly, false);
  assert.deepEqual(Object.keys(S.normalize({}, { scope: 'still' })).sort(), [...STILL_KEYS].sort());
});

test('migration: v0 objects are upgraded, the "v" field is kept current, newer versions are left alone', () => {
  assert.deepEqual(S.migrate(undefined), { data: {}, from: null, to: 1, newer: false, migrated: false, problems: [] });
  assert.match(S.migrate('x').problems[0], /not an object/);
  // v0: no "v", older flat names and values
  const v0 = {
    clock: '24h', units: 'c', reduceMotion: false, performanceMode: true,
    sites: [{ alias: 'wiki', url: 'https://www.wikipedia.org' }, { alias: 'maps', url: 'openstreetmap.org' }],
  };
  const m = S.migrate(v0);
  assert.equal(m.from, 0);
  assert.equal(m.migrated, true);
  assert.equal(m.data.v, 1);
  const r = S.read(v0, { config: PORTLAND, scope: 'newtab' });
  assert.equal(r.migrated, true);
  assert.equal(r.settings.clock24, true);
  assert.equal(r.settings.units, 'C');
  assert.equal(r.settings.reducedMotion, 'auto', 'a v0 switch that was off meant "not forced"');
  assert.equal(r.settings.performance, 'on');
  assert.deepEqual(r.settings.shortcuts, [{ label: 'wiki', url: 'https://www.wikipedia.org' }, { label: 'maps', url: 'https://openstreetmap.org' }]);
  assert.deepEqual(r.problems, []);
  assert.equal(S.read({ hour12: true }, { scope: 'newtab' }).settings.clock24, false);
  assert.equal(S.read({ hour12: 'no' }, { scope: 'newtab' }).settings.clock24, true);
  assert.equal(S.read({ hour12: true, clock24: true }, { scope: 'newtab' }).settings.clock24, true, 'an explicit clock24 wins');
  // the version field
  for (const v of [undefined, 0, '0', 'abc', -1, 1.5, null]) assert.equal(S.migrate({ v, units: 'F' }).from, 0, `v=${JSON.stringify(v)} is v0`);
  assert.equal(S.migrate({ v: '1' }).from, 1);
  assert.equal(S.migrate({ v: 1, units: 'F' }).migrated, false);
  // migrating twice changes nothing
  assert.deepEqual(S.migrate(m.data).data, m.data);
  // a newer version (another computer runs a newer build) is never rewritten
  const newer = { v: 2, units: 'F', future: { mode: 'x' }, city: 'Oslo' };
  const mn = S.migrate(newer);
  assert.equal(mn.newer, true);
  assert.equal(mn.from, 2);
  assert.deepEqual(mn.data, newer);
  assert.notEqual(mn.data, newer, 'a copy, never the caller\'s object');
  const rn = S.read(newer, { config: BERLIN, scope: 'newtab' });
  assert.equal(rn.newer, true);
  assert.equal(rn.settings.units, 'F', 'what this version understands is used');
  assert.equal(rn.settings.city, 'Oslo');
  // migration never mutates its input
  const frozen = JSON.parse(JSON.stringify(v0));
  S.migrate(frozen);
  assert.deepEqual(frozen, v0);
});

test('overrides and applyPatch: only what differs from the defaults is stored, in canonical form and order', () => {
  const opts = { config: BERLIN, scope: 'newtab' };
  const defs = S.defaults(BERLIN, { scope: 'newtab' });
  assert.deepEqual(S.overrides(defs, opts), { v: 1 });
  assert.deepEqual(S.overrides({ ...defs, units: 'F', theme: 'halloween' }, opts), { v: 1, units: 'F', theme: 'halloween' });

  let r = S.applyPatch(undefined, { units: 'F' }, opts);
  assert.deepEqual(r.stored, { v: 1, units: 'F' });
  assert.deepEqual(r.changed, ['units']);
  r = S.applyPatch(r.stored, { units: 'C' }, opts);
  assert.deepEqual(r.stored, { v: 1 }, 'back to the default: the override goes, the key follows the config again');
  assert.deepEqual(r.changed, ['units']);
  // other stored keys stay (an explicit choice is kept even when it equals today's default); values are
  // rewritten canonically, in KEYS order, v first
  r = S.applyPatch({ units: 'f', v: 1, city: '  Oslo ', theme: 'AUTO' }, { clock24: false }, opts);
  assert.deepEqual(r.stored, { v: 1, clock24: false, city: 'Oslo', units: 'F', theme: 'auto' });
  assert.deepEqual(Object.keys(r.stored), ['v', 'clock24', 'city', 'units', 'theme']);
  // this version's garbage is dropped and reported
  r = S.applyPatch({ v: 1, units: 'K', bogus: 1, reducedMotion: 'off' }, {}, opts);
  assert.deepEqual(r.stored, { v: 1, reducedMotion: 'off' });
  assert.match(r.problems.join('\n'), /bogus/);
  assert.match(r.problems.join('\n'), /units/);
  // a bad patch value is reported and not applied
  r = S.applyPatch({ v: 1, units: 'F' }, { units: 'K', nope: 1 }, opts);
  assert.deepEqual(r.stored, { v: 1, units: 'F' });
  assert.equal(r.problems.length, 2);
  // a theme this build does not have (another computer's newer engine) is kept in storage, read as auto
  const themes = ['winter', 'autumn'];
  r = S.applyPatch({ v: 1, theme: 'aurora' }, { units: 'F' }, { ...opts, themes });
  assert.deepEqual(r.stored, { v: 1, units: 'F', theme: 'aurora' });
  assert.equal(S.read(r.stored, { ...opts, themes }).settings.theme, 'auto');
  assert.equal(S.effectiveTheme({ theme: 'aurora' }, themes), 'auto');
  // a newer version: everything kept, the version too; only the patched key changes
  r = S.applyPatch({ v: 2, units: 'F', future: { a: 1 }, theme: 'Not An Id' }, { city: 'Oslo' }, opts);
  assert.deepEqual(r.stored, { v: 2, city: 'Oslo', units: 'F', theme: 'Not An Id', future: { a: 1 } });
  // a v0 object comes out as v1
  r = S.applyPatch({ clock: '12h' }, {}, opts);
  assert.deepEqual(r.stored, { v: 1, clock24: false });
  // the shortcut list is one value
  r = S.applyPatch({ v: 1 }, { shortcuts: [{ label: 'a', url: 'a.example.com' }] }, opts);
  assert.deepEqual(r.stored.shortcuts, [{ label: 'a', url: 'https://a.example.com' }]);
  r = S.applyPatch(r.stored, { shortcuts: defs.shortcuts }, opts);
  assert.deepEqual(r.stored, { v: 1 });
});

test('worst case: every stored item stays under 4 KB and inside Chrome\'s sync quotas', () => {
  const opts = { config: PORTLAND, scope: 'newtab' };
  const longUrl = (i) => {
    const u = `https://s${String(i).padStart(2, '0')}.example.com/`;
    return u + 'a'.repeat(S.URL_MAX - u.length);
  };
  // "<" costs 6 bytes in Chrome's JSON and is the most expensive character a label or city can hold
  const worst = {
    clock24: true, city: '<'.repeat(S.CITY_MAX), units: 'C', sunTimes: false, weather: false, weatherFx: false, theme: 'thanksgiving',
    reducedMotion: 'off', performance: 'off', shortcutsMode: 'top', clockStatus: false, focusTerminal: false,
    shortcuts: Array.from({ length: S.SHORTCUTS_MAX }, (_, i) => ({ label: '<'.repeat(S.LABEL_MAX), url: longUrl(i) })),
  };
  const v = S.validate('shortcuts', worst.shortcuts);
  assert.ok(v.ok && v.value.length === 9 && v.value.every((s) => s.url.length === 300), 'the list is valid at its limits');
  const stored = S.applyPatch(undefined, worst, opts).stored;
  assert.deepEqual(Object.keys(stored), ['v', ...NEWTAB_KEYS], 'every key is an override');
  // independent of the store's own counting: UTF-8 JSON with "<" spelled as Chrome spells it
  const chromeBytes = (key, value) => Buffer.byteLength(key) + Buffer.byteLength(JSON.stringify(value).split('<').join(LT6));
  assert.ok(chromeBytes('settings', stored) > St.ITEM_BUDGET, `the worst case does not fit one item (${chromeBytes('settings', stored)} bytes)`);
  const plan = St.layout(stored);
  assert.equal(plan.split, true, 'the shortcuts move into chunk items');
  let total = 0;
  for (const k of plan.order) {
    const b = chromeBytes(k, plan.items[k]);
    assert.equal(b, St.itemBytes(k, plan.items[k]), `${k}: the store counts like Chrome`);
    assert.ok(b <= 4096, `${k}: ${b} bytes`);
    total += b;
  }
  assert.ok(total <= St.QUOTA.QUOTA_BYTES && plan.order.length <= St.QUOTA.MAX_ITEMS);
  assert.equal(plan.order[plan.order.length - 1], 'settings', 'the pointer item is written last');
  // the chunks reassemble into the same object
  const back = St.assemble(plan.items);
  assert.equal(back.missing, false);
  assert.deepEqual(back.raw, stored);
  assert.deepEqual(S.read(back.raw, opts).settings, S.normalize(worst, opts));
  // the usual case is one small item
  const usual = S.applyPatch(undefined, { units: 'C', clock24: true, shortcuts: BERLIN.shortcuts }, opts).stored;
  const one = St.layout(usual);
  assert.equal(one.split, false);
  assert.ok(one.bytes.settings < 400, `${one.bytes.settings} bytes`);
});

test('focusTerminal: a plain on/off switch, new tab only, on unless turned off', () => {
  const opts = { config: BERLIN, scope: 'newtab' };
  assert.equal(S.read({ v: 1, units: 'F' }, opts).settings.focusTerminal, true, 'the focus redirect is on unless turned off');
  assert.equal(S.validate('focusTerminal', 'off').value, false);
  assert.deepEqual(S.spec('focusTerminal').scopes, ['newtab']);
  assert.deepEqual(S.applyPatch({ v: 1 }, { focusTerminal: false }, opts).stored, { v: 1, focusTerminal: false });
  assert.deepEqual(S.applyPatch({ v: 1, focusTerminal: false }, { focusTerminal: true }, opts).stored, { v: 1 });
});

test('mirror (boot.js and the next tab\'s first frame: the scene, the clock, the weather and clock-line settings) and effectiveTheme', () => {
  const s = S.normalize({ theme: 'halloween', clock24: true, reducedMotion: 'on', performance: 'off', focusTerminal: false, city: 'Oslo', units: 'C', sunTimes: false,
    weatherFx: false, clockStatus: false }, { scope: 'newtab' });
  assert.deepEqual(S.mirror(s), { theme: 'halloween', clock24: true, reducedMotion: 'on', performance: 'off', focusTerminal: false, city: 'Oslo', units: 'C',
    weather: true, weatherFx: false, sunTimes: false, clockStatus: false });
  const none = { theme: 'auto', clock24: false, reducedMotion: 'auto', performance: 'auto', focusTerminal: true, city: '', units: 'F', weather: true, weatherFx: true,
    sunTimes: true, clockStatus: true };
  assert.deepEqual(S.mirror({}), none);
  assert.deepEqual(S.mirror({ nope: 1, clock24: 'yes', focusTerminal: 'maybe' }), { ...none, clock24: true }, 'an unknown key stays out; a bad focusTerminal keeps the redirect on');
  assert.deepEqual(S.mirror({ city: '  Ber' + ch(0x200b) + 'lin ', units: 'K', weather: 'nope', sunTimes: 'off' }), { ...none, city: 'Berlin', sunTimes: false },
    'the city cleaned; bad units and weather values take the defaults');
  assert.deepEqual(S.mirror({ weatherFx: 'off', clockStatus: 'nope' }), { ...none, weatherFx: false }, 'the weather in the scene off; a bad clockStatus keeps the line on');
  assert.deepEqual(S.mirror(null), S.mirror({}));
  assert.ok(!('shortcuts' in S.mirror(s)) && !('shortcutsMode' in S.mirror(s)),
    'the settings\' link list stays out: the page mirrors the links it shows (lk), whatever their source');
  assert.equal(S.effectiveTheme({ theme: 'halloween' }, ['winter', 'halloween']), 'halloween');
  assert.equal(S.effectiveTheme({ theme: 'halloween' }, [{ id: 'auto' }, { id: 'halloween' }]), 'halloween');
  assert.equal(S.effectiveTheme({ theme: 'halloween' }, ['winter']), 'auto', 'unknown here -> auto');
  assert.equal(S.effectiveTheme({ theme: 'auto' }, ['winter']), 'auto');
  assert.equal(S.effectiveTheme({}, ['winter']), 'auto');
});

test('configJs: PCD.CONFIG for the pages, ASCII only, the same defaults as the config itself', () => {
  const munich = { ...BERLIN, city: 'M' + ch(0xfc) + 'nchen <' + ch(0x2028) + '>', secret: 'not copied', shortcuts: [...BERLIN.shortcuts, { label: ch(0x1f600), url: 'example.com' }] };
  const js = S.configJs(munich);
  assert.ok([...js].every((c) => c.charCodeAt(0) < 127), 'ASCII only');
  assert.ok(!js.includes('<'), '"<" escaped');
  assert.ok(!js.includes('secret'), 'only the fields the settings read');
  assert.ok(!js.includes('\r') && js.endsWith('\n'));
  const sandbox = {};
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(js, sandbox);
  const CONFIG = JSON.parse(JSON.stringify(sandbox.PCD.CONFIG));
  assert.deepEqual(CONFIG, S.configValues(munich));
  assert.equal(CONFIG.city, munich.city, 'escapes decode to the same text');
  for (const scope of S.SCOPES) assert.deepEqual(S.defaults(CONFIG, { scope }), S.defaults(munich, { scope }), scope);
  assert.equal(CONFIG.taskbarPx, 56, 'the taskbar band travels with the config');
  // in Node the same file exports the object
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pcd-config-'));
  const tmp = path.join(dir, 'pcd-config.js');
  fs.writeFileSync(tmp, js);
  try {
    assert.deepEqual(JSON.parse(JSON.stringify(require(tmp))), CONFIG);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  assert.deepEqual(S.configValues(null), {});
  assert.deepEqual(S.checkConfig(BERLIN), []);
  const problems = S.checkConfig({ units: 'K', clock: 'noon', shortcuts: [{ label: '', url: 'ftp://x' }], taskbarPx: -1 });
  for (const k of ['units', 'clock', 'shortcuts', 'taskbarPx']) assert.ok(problems.some((p) => p.startsWith(k + ':')), `${k}: ${problems.join(' | ')}`);
  assert.deepEqual(S.checkConfig('x'), ['the config is not an object']);
  // a field no setting reads is no problem for the schema and never reaches PCD.CONFIG
  assert.deepEqual(S.checkConfig({ ...BERLIN, nope: 'x' }), []);
  assert.deepEqual(S.configValues({ ...BERLIN, nope: 'x' }), S.configValues(BERLIN));
  assert.equal(S.configJs({ ...BERLIN, nope: 'x' }), S.configJs(BERLIN));
});

test('shipped sources: UTF-8 ASCII, LF, no BOM, no hard-coded hosts or personal data, no network, CSP-safe', () => {
  const files = ['src/newtab/js/ntp-settings.js', 'src/newtab/js/ntp-store.js', 'src/wallpaper/js/wp-props.js'];
  for (const rel of files) {
    const file = path.join(ROOT, ...rel.split('/'));
    if (!fs.existsSync(file)) continue;
    const text = fs.readFileSync(file, 'utf8');
    assert.notEqual(text.charCodeAt(0), 0xfeff, `${rel}: BOM`);
    assert.ok(!text.includes('\r'), `${rel}: CR`);
    const bad = [...text].filter((c) => c.charCodeAt(0) > 126 || (c.charCodeAt(0) < 32 && c !== '\n'));
    assert.deepEqual(bad, [], `${rel}: ASCII only`);
    assert.deepEqual([...text.matchAll(/https?:\/\/([A-Za-z0-9.-]+)/g)].map((m) => m[1]), [], `${rel}: no URL with a host`);
    assert.ok(!/\bfetch\s*\(|XMLHttpRequest|WebSocket|sendBeacon/.test(text), `${rel}: no network`);
    assert.ok(!/\beval\s*\(|new Function|innerHTML|insertAdjacentHTML|document\.write/.test(text), `${rel}: CSP-safe`);
    assert.ok(!/setTimeout\s*\(\s*['"`]/.test(text), `${rel}: no string timers`);
    assert.ok(!/pixelclock\.local/i.test(text), `${rel}: never names the clock (ntp-settings.js ships in the wallpaper too)`);
    assert.ok(!/^\s*(import|export)\s/m.test(text), `${rel}: a classic script, no ES module syntax`);
    assert.ok(!/config\/user\.json['"]/.test(text) || rel.endsWith('ntp-settings.js'), `${rel}: never reads the config file`);
  }
});
