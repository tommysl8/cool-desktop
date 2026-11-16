// The terminal's commands table (src/newtab/js/term/term-commands.js): every documented command exists, when a line is
// a command (with the copied router.js on top of it), the scene names and their typos, the help lists (they fit the
// narrowest column) and completion. Pure Node, no DOM.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadTerm, stubApp } from './newtab-term-load.mjs';
import { isSafeChar } from '../tools/lib/glyphs.mjs';

const T = loadTerm();
const C = T.lib('commands.js');
const R = T.lib('router.js');
const K = T.lib('complete.js');
const THEMES = stubApp().theme('list');
const WORDS = C.themeWords(THEMES);
const LINKS = [{ name: 'wikipedia', url: 'https://www.wikipedia.org' }, { name: 'maps', url: 'https://www.openstreetmap.org' }];

test('the table: every documented command, unique names, groups, eggs hidden', () => {
  const documented = ['help', 'theme', 'surprise', 'shake', 'weather', 'date', 'alarm', 'links', 'calc', '=', 'clock', 'history',
    'clear', 'settings', 'g', 'yt', 'gh'];
  for (const name of documented) assert.ok(C.getBuiltin(name), name);
  assert.equal(C.getBuiltin(' THEME ').name, 'theme', 'case and spaces do not matter');
  assert.equal(C.getBuiltin('cls').name, 'clear');
  assert.equal(C.getBuiltin('=').name, 'calc');
  assert.equal(C.getBuiltin('nope'), null);
  assert.equal(C.getBuiltin(42), null);
  assert.equal(new Set(C.BUILTIN_NAMES).size, C.BUILTIN_NAMES.length, 'no name twice');
  const groups = C.GROUPS.map((g) => g.id);
  for (const def of C.BUILTINS) {
    assert.ok(groups.includes(def.group), `${def.name}: group ${def.group}`);
    assert.ok(def.usage.startsWith(def.name === 'calc' ? 'calc' : def.name), `${def.name}: usage starts with the name`);
    assert.ok(['none', 'text', 'sub'].includes(def.args), def.name);
    assert.equal(def.hidden, def.group === 'fun', `${def.name}: only the eggs are hidden`);
  }
  for (const egg of ['hello', 'sudo', 'exit', 'rm']) assert.ok(C.getBuiltin(egg).egg && C.getBuiltin(egg).hidden, egg);
  const visible = C.visibleCommandNames();
  assert.ok(!visible.includes('hello') && !visible.includes('sudo') && !visible.includes('='), 'eggs and = stay out of completion');
  assert.deepEqual(visible, [...visible].sort());
  assert.ok(Object.isFrozen(C.BUILTINS) && Object.isFrozen(C.BUILTINS[0]) && Object.isFrozen(C.HELP_ROWS));
});

test('copy: lower case, safe glyphs only, no exclamation marks', () => {
  const texts = [];
  for (const def of C.BUILTINS) {
    texts.push(def.usage, def.help, ...def.details);
    for (const s of def.subcommands) texts.push(s.usage, s.help);
  }
  for (const [label, runs] of C.HELP_ROWS) texts.push(label, runs.map((r) => r[0]).join(''));
  for (const t of texts) {
    for (const ch of t) assert.ok(isSafeChar(ch), `${JSON.stringify(t)}: ${ch}`);
    assert.ok(!t.includes('!'), t);
    assert.equal(t, t.replace(/[A-Z]/g, ''), `${t}: lower case`);
  }
});

test('the help screen: one row per group, every visible command named, fits the narrowest column (44 cells)', () => {
  const text = C.HELP_ROWS.map(([, runs]) => runs.map((r) => r[0]).join('')).join(' ');
  for (const def of C.BUILTINS.filter((d) => !d.hidden)) assert.ok(text.includes(def.name), `help names ${def.name}`);
  for (const [label, runs] of C.HELP_ROWS) {
    assert.ok(label.length <= 10, label);
    const w = runs.reduce((n, r) => n + Array.from(r[0]).length, 0);
    assert.ok(w <= 44 - 12, `"${label}" row is ${w} cells: it would wrap in a 44-cell column`);
    for (const r of runs) assert.ok(['text', 'muted', 'faint', 'frame'].includes(r[1]), `${label}: role ${r[1]} (no amber in help)`);
  }
  assert.deepEqual(C.HELP_ROWS.map((r) => r[0]), ['open', 'search', 'scene', 'info', 'math', 'setup', 'terminal', 'keys', '']);
});

test('acceptsArgs and looksLikeAttempt: commands only when their words fit; near misses still reach the command', () => {
  const fits = (line) => {
    const r = R.route(line, { aliases: LINKS, themes: WORDS });
    return r.kind === 'builtin' ? r.name : r.kind;
  };
  const table = {
    help: 'help', 'help theme': 'help', 'help wikipedia': 'help', 'help theem': 'help', 'help me now': 'search',
    'help more': 'help', 'help more please': 'search',
    theme: 'theme', 'theme list': 'theme', 'theme auto': 'theme', 'theme winter': 'theme', 'theme snowy hills': 'theme',
    "theme st. patrick's day": 'theme', 'theme xmas': 'theme', 'theme wintr': 'theme', 'theme hal': 'theme',
    'theme park': 'search', 'theme of the day': 'search', surprise: 'surprise', 'surprise me': 'search', shake: 'shake',
    'shake it off': 'search', weather: 'weather', 'weather in paris': 'search', date: 'date', 'date night ideas': 'search',
    alarm: 'alarm', 'alarm clock': 'search', links: 'links', 'links between': 'search', '= 2^10': 'calc', '=2+2': 'calc',
    'calc sqrt(2)*pi': 'calc', 'clock 12': 'clock', 'clock 24h': 'clock', 'clock 13': 'clock', 'clock tower': 'search',
    clock: 'clock', history: 'history', 'history clear': 'history', 'history clean': 'history', 'history of rome': 'search',
    clear: 'clear', cls: 'clear', 'clear skies': 'search', settings: 'settings', 'settings app': 'search', g: 'g',
    'g pixel art': 'g', yt: 'yt', 'yt lofi beats &': 'yt', 'gh pixelclock': 'gh', hello: 'hello', 'hello world': 'search',
    'sudo make me a sandwich': 'sudo', exit: 'exit', 'exit through the gift shop': 'search', 'rm -rf /': 'rm', rm: 'rm',
    'rm stuff': 'search', '3': 'link', wikipedia: 'alias', 'Maps &': 'alias', 'pixel art': 'search', 'example.com': 'url',
  };
  for (const [line, want] of Object.entries(table)) assert.equal(fits(line), want, JSON.stringify(line));
  assert.equal(C.acceptsArgs(null, []), false);
  assert.equal(C.acceptsArgs(C.getBuiltin('rm'), ['-rf', '/']), true);
  assert.equal(C.looksLikeAttempt(C.getBuiltin('theme'), ['wintr'], { themes: WORDS }), true);
  assert.equal(C.looksLikeAttempt(C.getBuiltin('theme'), ['park'], { themes: WORDS }), false);
  assert.equal(C.looksLikeAttempt(C.getBuiltin('date'), ['x']), false, 'only sub commands have near misses');
  assert.equal(C.nearMiss('wintr', 'winter'), true);
  assert.equal(C.nearMiss('w', 'winter'), false, 'one letter is no near miss');
  assert.equal(C.nearMiss('sumer', 'summer'), true);
  assert.equal(C.nearMiss('xyz', 'winter'), false);
});

test('scene names: ids, names, everyday words and unique starts; typos get a suggestion', () => {
  const r = (t) => C.resolveTheme(t, THEMES);
  assert.equal(r('winter'), 'winter');
  assert.equal(r('Snowy  Hills'), 'winter');
  assert.equal(r("st. patrick's day"), 'stpatricks');
  assert.equal(r('xmas'), 'christmas');
  assert.equal(r('fall'), 'autumn');
  assert.equal(r('spooky'), 'halloween');
  assert.equal(r('july 4'), 'july4');
  assert.equal(r('hal'), 'halloween');
  assert.equal(r('chr'), 'christmas');
  assert.equal(r('spr'), 'spring');
  assert.equal(r('su'), null, 'a start needs three letters');
  assert.equal(r('new'), 'newyear', "new matches newyear and new year's eve: one scene");
  assert.equal(r('wintr'), null);
  assert.equal(r(''), null);
  assert.equal(r('auto'), null, 'auto is not a scene');
  const s = (t) => C.suggestTheme(t, THEMES);
  assert.equal(s('wintr'), 'winter');
  assert.equal(s('sumer'), 'summer');
  assert.equal(s('haloween'), 'halloween');
  assert.equal(s('snowy'), 'winter');
  assert.equal(s('zzzz'), null);
  // without a list from the app: the clock's 13 ids
  assert.deepEqual(C.themeEntries(null).map((t) => t.id), [...C.THEME_NAMES]);
  assert.deepEqual(C.themeEntries(['autumn', { id: 'Winter', name: 'Snowy hills' }, 'auto', 'autumn']).map((t) => [t.id, t.name, t.kind]),
    [['autumn', 'autumn', 'season'], ['winter', 'snowy hills', 'season']]);
  assert.ok(WORDS.includes('snowy hills') && WORDS.includes('xmas') && WORDS.includes('winter'));
});

test('helpLines: one command, a link, or a friendly miss', () => {
  const t = C.helpLines('theme', { aliases: LINKS });
  assert.equal(t[0], 'theme [<name>|list|auto]');
  assert.ok(t.some((l) => l.includes('snowy hills')));
  assert.ok(C.helpLines('cls')[0].startsWith('clear'));
  assert.ok(C.helpLines('cls').some((l) => l.includes('cls is another name for clear')));
  assert.deepEqual(C.helpLines('wikipedia', { aliases: LINKS }), ['wikipedia: a link to https://www.wikipedia.org']);
  assert.match(C.helpLines('nope')[0], /no command called "nope"/);
  assert.ok(C.helpLines('').length >= 4, 'the grouped list');
});

test('completion: commands and link names first, then subcommands, theme ids and help topics', () => {
  const k = (s) => K.complete(s, { aliases: LINKS, themes: THEMES.map((t) => t.id) });
  assert.equal(k('the').line, 'theme ');
  assert.equal(k('theme w').line, 'theme winter ');
  assert.deepEqual(k('theme s').matches, ['spring', 'summer', 'stpatricks']);
  assert.equal(k('theme s').line, 'theme s');
  assert.equal(k('wik').line, 'wikipedia ');
  assert.equal(k('help se').line, 'help settings ');
  assert.equal(k('clock 2').line, 'clock 24 ');
  assert.equal(k('history c').line, 'history clear ');
  assert.deepEqual(k('h').matches, ['help', 'history']);
  assert.deepEqual(k('xyz').matches, []);
  assert.ok(!k('he').matches.includes('hello'), 'eggs never complete');
});
