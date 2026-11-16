// The terminal's shell (src/newtab/js/term/term-shell.js) against a stubbed app: every command, help that fits the
// terminal's rows, links by number, name and unique start, new tabs, failures that print instead of throwing, the
// history (memory, app.storage, other tabs, the caps), the ghost and Tab, and the pure key rules term-ui.js acts on.
// The sample data is Berlin's and sample links (tests/newtab-term-load.mjs stubApp).
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { ROOT, loadTerm, stubApp } from './newtab-term-load.mjs';

const T = loadTerm();
const require = createRequire(import.meta.url);
require(path.join(ROOT, 'src', 'shared', 'pcd-ascii.js'));
require(path.join(ROOT, 'src', 'shared', 'pcd-console.js')); // the weather command prints the column's own block
const S = require(path.join(ROOT, 'src', 'newtab', 'js', 'ntp-status.js'));

/** A shell on a stub app: { app, shell, lines (each { kind, text, runs }), last(), texts(), clears }. */
function make(over = {}, opts = {}) {
  const app = stubApp(over);
  const lines = [];
  let clears = 0;
  const shell = T.createShell(app, {
    print: (l) => lines.push({ kind: l.kind, runs: l.runs, text: l.runs.map((r) => (Array.isArray(r) ? r[0] : r.text)).join('') }),
    clear: () => { clears++; lines.length = 0; },
    cols: () => 44,
    ...opts,
  });
  return {
    app,
    shell,
    lines,
    get clears() { return clears; },
    last: () => (lines.length ? lines[lines.length - 1].text : ''),
    texts: () => lines.map((l) => l.text),
    async run(line, ropts) {
      lines.length = 0;
      app.calls.length = 0;
      return shell.run(line, ropts);
    },
  };
}

test('every line is echoed first: "› " in frame, the line in text; an empty line echoes and does nothing', async () => {
  const t = make();
  await t.run('pixel art');
  assert.deepEqual(t.lines[0].runs, [['› ', 'frame'], ['pixel art', 'text']]);
  assert.equal(t.lines[0].kind, 'cmd');
  const r = await t.run('   ');
  assert.deepEqual(r, { kind: 'empty', newTab: false });
  assert.deepEqual(t.texts(), ['›    ']);
  assert.deepEqual(t.app.calls, []);
  await t.run('a' + String.fromCharCode(0x202e) + 'b' + String.fromCharCode(7) + 'c');
  assert.equal(t.lines[0].text, '› abc', 'control and bidi characters never reach the screen');
});

test('links: 1-9, names (any case, with spaces), unique starts; " &" and ctrl+enter open a new tab', async () => {
  const t = make();
  const cases = [
    ['1', 'https://www.wikipedia.org', false],
    ['3', 'https://open-meteo.com', false],
    ['4 &', 'https://docs.example.org/start', true],
    ['maps', 'https://www.openstreetmap.org', false],
    ['MAPS', 'https://www.openstreetmap.org', false],
    ['docs', 'https://docs.example.org/start', false],
    ['my notes', 'http://notes.lan/', false],
    ['My Notes &', 'http://notes.lan/', true],
    ['wik', 'https://www.wikipedia.org', false],
    ['d', 'https://docs.example.org/start', false],
    ['ma &', 'https://www.openstreetmap.org', true],
  ];
  for (const [line, url, newTab] of cases) {
    const r = await t.run(line);
    assert.deepEqual(t.app.calls, [['openUrl', url, newTab]], line);
    assert.equal(r.kind, 'link', line);
    assert.match(t.last(), /^opening \S/, line);
  }
  await t.run('2', { newTab: true });
  assert.deepEqual(t.app.calls, [['openUrl', 'https://www.openstreetmap.org', true]], 'ctrl+enter');
  assert.equal(t.last(), 'opening maps  openstreetmap.org in a new tab');
  await t.run('1');
  assert.equal(t.last(), 'opening wikipedia  wikipedia.org');
  await t.run('m');
  assert.deepEqual(t.app.calls, [['search', 'm', false]], 'an ambiguous start (maps, my notes) is a search');
  await t.run('weather');
  assert.equal(t.app.calls.length, 0, 'a built-in wins over a link of the same name');
  await t.run('7');
  assert.equal(t.last(), '! no link 7: the links are 1-5');
  assert.deepEqual(t.app.calls, []);
  const none = make({ links: () => [] });
  await none.run('1');
  assert.equal(none.last(), '! no link 1: there are no links yet (add them in settings)');
  const bad = make({ links: () => [{ label: 'x', url: 'javascript:alert(1)' }, { label: 'ok', url: 'https://ok.example.com' }] });
  await bad.run('1');
  assert.match(bad.last(), /^! link 1 cannot be opened/);
  await bad.run('x');
  assert.match(bad.last(), /^! link x cannot be opened/, 'a link name too, in this app\'s words (never "alias")');
  await bad.run('2');
  assert.deepEqual(bad.app.calls, [['openUrl', 'https://ok.example.com', false]], 'numbers stay the console\'s numbers');
  assert.deepEqual(bad.shell.links().length, 2);
  const many = make({ links: () => Array.from({ length: 12 }, (_, i) => ({ name: 'Site ' + i, url: `https://s${i}.example.com` })) });
  assert.equal(many.shell.links().length, 9, 'nine links at most');
  assert.equal(many.shell.links()[0].name, 'site 0', 'names lower case');
});

test('g, yt, gh: their sites, with or without words, here or in a new tab', async () => {
  const t = make();
  const cases = [
    ['g pixel art', 'https://www.google.com/search?q=pixel%20art', false, 'searching google for pixel art'],
    ['g', 'https://www.google.com', false, 'opening google'],
    ['yt lofi beats &', 'https://www.youtube.com/results?search_query=lofi%20beats', true, 'searching youtube for lofi beats in a new tab'],
    ['yt', 'https://www.youtube.com', false, 'opening youtube'],
    ['gh pixelclock', 'https://github.com/search?q=pixelclock', false, 'searching github for pixelclock'],
    ['GH', 'https://github.com', false, 'opening github'],
  ];
  for (const [line, url, newTab, said] of cases) {
    await t.run(line);
    assert.deepEqual(t.app.calls, [['openUrl', url, newTab]], line);
    assert.equal(t.last(), said, line);
  }
});

test('addresses open with app.openUrl, everything else searches with app.search (the default engine)', async () => {
  const t = make();
  await t.run('example.com/path');
  assert.deepEqual(t.app.calls, [['openUrl', 'https://example.com/path', false]]);
  assert.equal(t.last(), 'opening https://example.com/path');
  await t.run('pixelclock.local &');
  assert.deepEqual(t.app.calls, [['openUrl', 'http://pixelclock.local/', true]]);
  await t.run('cozy rainy day music');
  assert.deepEqual(t.app.calls, [['search', 'cozy rainy day music', false]]);
  assert.equal(t.last(), 'searching for cozy rainy day music');
  await t.run('javascript:alert(1)');
  assert.deepEqual(t.app.calls, [['search', 'javascript:alert(1)', false]], 'other schemes are searched, never opened');
  await t.run('node.js', { newTab: true });
  assert.deepEqual(t.app.calls, [['search', 'node.js', true]]);
  assert.equal(t.last(), 'searching for node.js in a new tab');
});

test('theme: list, auto, ids, scene names, everyday words; typos explain and never switch', async () => {
  const t = make();
  await t.run('theme');
  assert.deepEqual(t.texts().slice(1), [
    'seasons   winter · spring',
    '          summer · autumn',
    'holidays  newyear · lunarnewyear',
    '          valentines · stpatricks · easter',
    '          july4 · halloween',
    '          thanksgiving · christmas',
    'now       autumn forest · auto',
  ], 'lists wrap between items in a 44-cell column: never a separator at the start of a line, never one item alone at the end');
  assert.ok(t.lines[2].runs.some((r) => r[0] === 'autumn' && r[1] === 'text bold'), 'the current scene stands out');
  assert.ok(t.lines.slice(1).every((l) => l.kind === 'hang'));
  assert.ok(t.lines.slice(1).every((l) => l.runs[1][0] !== ' · ' && l.runs.at(-1)[0] !== ' · '), 'separators only between items');
  await t.run('theme list');
  assert.equal(t.lines.length, 8);
  const wide = make({}, { cols: () => 64 });
  await wide.run('theme');
  assert.deepEqual(wide.texts().slice(1), ['seasons   winter · spring · summer · autumn', 'holidays  newyear · lunarnewyear · valentines · stpatricks',
    '          easter · july4 · halloween', '          thanksgiving · christmas', 'now       autumn forest · auto']);
  const mid = make({}, { cols: () => 54 });
  await mid.run('theme');
  assert.deepEqual(mid.texts().slice(2, 5), ['holidays  newyear · lunarnewyear · valentines', '          stpatricks · easter · july4 · halloween',
    '          thanksgiving · christmas'], 'two items on the last line stay as they are');
  for (const [line, id, name] of [['theme winter', 'winter', 'snowy hills'], ['theme snowy hills', 'winter', 'snowy hills'],
    ['theme xmas', 'christmas', 'christmas cabin'], ['theme hal', 'halloween', 'haunted hill'], ["theme St. Patrick's Day", 'stpatricks', "st. patrick's day"]]) {
    await t.run(line);
    assert.deepEqual(t.app.calls, [['theme', id]], line);
    assert.deepEqual(t.texts().slice(1), [`theme ${name} · pinned`, 'theme auto follows the date again'], line);
  }
  await t.run('theme wintr');
  assert.deepEqual(t.app.calls, []);
  assert.equal(t.last(), '! no scene "wintr"; did you mean winter?');
  assert.ok(Array.from(t.last()).length <= 42, 'fits the narrowest column');
  await t.run('theme su');
  assert.equal(t.last(), '! no scene "su"; did you mean summer?', 'a start under three letters is a near miss, not a scene');
  await t.run('theme zzzz zz');
  assert.deepEqual(t.app.calls, [['search', 'theme zzzz zz', false]], 'not a scene, not a near miss: a search');
  await t.run('theme auto');
  assert.deepEqual(t.app.calls, [['theme', 'auto']]);
  assert.equal(t.last(), 'theme autumn forest · auto, it follows the date');
  await t.run('theme park');
  assert.deepEqual(t.app.calls, [['search', 'theme park', false]]);
  // the app's own list wins; without one the engine's or the 13 ids
  const bare = make({ theme: (x) => (x === 'list' ? undefined : { id: x }) });
  await bare.run('theme halloween');
  assert.equal(bare.lines[1].text, 'theme halloween · pinned');
  const failing = make({ theme: (x) => (x === 'list' ? stubApp().theme('list') : Promise.reject(new Error('no scene called x'))) });
  await failing.run('theme winter');
  assert.equal(failing.last(), '! that did not work: no scene called x');
});

test('a slow app never mixes up the output: what is known prints at once, each run prints into its own block', async () => {
  let finish;
  const slow = new Promise((r) => { finish = r; });
  const app = stubApp({
    theme: (x) => (x === 'list' ? stubApp().theme('list') : slow.then(() => ({ id: x, tag: 'pinned' }))),
    setClock24: () => slow,
    openUrl: () => slow.then(() => { throw new Error('the tab is gone'); }),
  });
  const printed = [];
  let n = 0;
  const shell = T.createShell(app, { block: () => ++n, print: (l, place) => printed.push([place, l.runs.map((r) => r[0]).join('')]) });
  const a = shell.run('theme winter');
  const b = shell.run('clock 24');
  const c = shell.run('1');
  const d = shell.run('= 1+1');
  await d;
  assert.deepEqual(printed, [
    [1, '› theme winter'], [1, 'theme snowy hills · pinned'], [1, 'theme auto follows the date again'],
    [2, '› clock 24'], [2, 'clock: 24 hour'],
    [3, '› 1'], [3, 'opening wikipedia  wikipedia.org'],
    [4, '› = 1+1'], [4, '= 2'],
  ], 'confirmations print before the app answers');
  finish();
  await Promise.all([a, b, c]);
  assert.deepEqual(printed.at(-1), [3, '! that did not work: the tab is gone'], 'a late failure lands in its own run\'s block');
});

test('surprise, shake, settings and clock go through the app', async () => {
  const t = make();
  await t.run('surprise');
  assert.deepEqual(t.app.calls, [['surprise']]);
  assert.equal(t.last(), 'surprise: haunted hill (this tab only)');
  await t.run('shake');
  assert.deepEqual(t.app.calls, [['shake']]);
  assert.equal(t.last(), 'haunted hill shakes');
  await t.run('settings');
  assert.deepEqual(t.app.calls, [['openSettings']]);
  await t.run('clock');
  assert.equal(t.last(), 'clock: 12 hour (clock 12 or clock 24)');
  await t.run('clock 24');
  assert.deepEqual(t.app.calls, [['setClock24', true]]);
  assert.equal(t.last(), 'clock: 24 hour');
  await t.run('clock 12h');
  assert.deepEqual(t.app.calls, [['setClock24', false]]);
  await t.run('clock 13');
  assert.deepEqual(t.app.calls, []);
  assert.equal(t.last(), '! clock: "13" is not 12 or 24');
});

test('weather: exactly the console column\'s block (PCD.console), the credit linked; compact when narrow; a plain fallback; a hint without data', async () => {
  const data = { temp: 46.2, feels: 41, wind: 9, high: 49, low: 41, kind: 'drizzle', description: 'drizzle', isDay: false };
  const view = () => ({ ...stubApp().view(), weather: { data, units: 'F', city: 'Berlin', ageMs: 0 } });
  const t = make({ view });
  await t.run('weather');
  const block = ['    .--.     46°F drizzle · berlin', ' .-(    ).   feels 41° · wind 9 mph', '(___.__)__)  hi 49° · lo 41°', "  ' ' ' '    weather: open-meteo.com"];
  assert.deepEqual(t.texts().slice(1), block);
  assert.deepEqual(t.lines.slice(1).map((l) => l.kind), ['art', 'art', 'art', 'art']);
  // the very block the column draws at the terminal's width (44 cells, art lines two cells in)
  const K = globalThis.PCD.console;
  const column = K.parts.weatherBlock(K.view(view(), 'newtab'), { width: 42, link: true });
  assert.deepEqual(t.lines.slice(1).map((l) => l.runs), column);
  const credit = t.lines[4].runs.find((r) => r.text === 'open-meteo.com');
  assert.equal(credit.href, 'https://open-meteo.com/');
  assert.ok(t.texts()[1].includes('berlin') && !t.texts()[4].includes('berlin'), 'the city is on the first line, never in the credit');
  const state = make({ view: () => ({ ...stubApp().view(), weather: { status: 'ok', data, units: 'C', city: 'Berlin', fetchedAt: new Date(2026, 10, 15, 18, 0).getTime() } }) });
  await state.run('weather');
  assert.match(state.texts()[1], /46°C drizzle · berlin$/, 'a PCD.weather client state works as it is');
  assert.match(state.last(), / {4}open-meteo\.com · 2 h ago$/, 'its age comes from fetchedAt; the "weather: " prefix gives way so the age fits');
  const wide = make({ view: state.app.view }, { cols: () => 64 });
  await wide.run('weather');
  assert.match(wide.last(), / {4}weather: open-meteo\.com · 2 h ago$/, 'in a wider column the prefix stays');
  const long = make({ view: () => ({ ...view(), weather: { data, units: 'F', city: 'San Francisco de Campeche', ageMs: 0 } }) });
  await long.run('weather');
  assert.equal(long.texts()[1], '    .--.     46°F drizzle · san francisco', 'a long city keeps the whole words that fit');
  const narrow = make({ view }, { cols: () => 30 });
  await narrow.run('weather');
  assert.deepEqual(narrow.texts().slice(1), ['46°F drizzle · berlin', 'weather: open-meteo.com'], 'too narrow for the icon: the column\'s two compact lines');
  const kit = globalThis.PCD.console;
  try {
    delete globalThis.PCD.console;
    const plain = make({ view });
    await plain.run('weather');
    assert.deepEqual(plain.texts().slice(1), ['46°F drizzle · berlin', 'feels 41° · wind 9 mph', 'hi 49° · lo 41°', 'weather: open-meteo.com'],
      'the column\'s words: hi and lo, never h and l');
    assert.equal(plain.lines[4].runs[1][2], 'https://open-meteo.com/');
  } finally {
    globalThis.PCD.console = kit;
  }
  await make().run('weather').then(() => {});
  const none = make();
  await none.run('weather');
  assert.equal(none.last(), 'no weather yet · the city and the weather switch are in settings');
  const off = make({ view: () => ({ weather: { data: { temp: null } } }) });
  await off.run('weather');
  assert.equal(off.last(), 'no weather yet · the city and the weather switch are in settings');
});

test('date: the day, the time and the sun in 12 h and 24 h; the phase alone without real sun times', async () => {
  const t = make();
  await t.run('date');
  assert.deepEqual(t.texts().slice(1), ['sunday november 15 2026 · 8:40 pm', 'sunrise 7:27 am · sunset 4:15 pm · night', 'day 319 of 365']);
  const h24 = make({ view: () => ({ ...stubApp().view(), clock24: true }) });
  await h24.run('date');
  assert.deepEqual(h24.texts().slice(1, 3), ['sunday november 15 2026 · 20:40', 'sunrise 07:27 · sunset 16:15 · night']);
  const nosun = make({ view: () => ({ ...stubApp().view(), sun: null, date: new Date(2028, 1, 29, 9, 5) }) });
  await nosun.run('date');
  assert.deepEqual(nosun.texts().slice(1), ['tuesday february 29 2028 · 9:05 am · night', 'day 60 of 366']);
});

test('alarm: the clock status line of the view, ringing in amber; without a clock it says why', async () => {
  const t = make({ view: () => ({ ...stubApp().view(), status: S.describe(S.sample('normal'), { clock24: false }) }) });
  await t.run('alarm');
  assert.equal(t.last(), '⌂ next alarm tomorrow 7:00 am · work');
  const runs = t.lines[1].runs;
  assert.deepEqual(runs[0], ['⌂ ', 'frame']);
  assert.ok(runs.some((r) => r[0] === '7:00 am' && r[1] === 'text'), 'the time in text');
  assert.ok(!runs.some((r) => r[1] === 'accent'), 'no amber while nothing rings');
  const ring = make({ view: () => ({ ...stubApp().view(), status: S.describe(S.sample('ringing'), { clock24: true }) }) });
  await ring.run('alarm');
  assert.equal(ring.last(), '⌂ ringing · work');
  assert.ok(ring.lines[1].runs.filter((r) => r[1] !== 'frame').every((r) => r[1] === 'accent'), 'ringing is alive: amber');
  const none = make();
  await none.run('alarm');
  assert.equal(none.last(), 'no clock here · it shows when pixelclock.local answers on this network');
  assert.equal(T.statusRuns({ show: false, parts: [] }), null);
  assert.equal(T.statusRuns(null), null);
});

test('calc, help, links, history, clear and the eggs', async () => {
  const t = make();
  await t.run('= 2^10');
  assert.deepEqual(t.lines[1].runs, [['= ', 'muted'], ['1024', 'text bold']]);
  await t.run('calc sqrt(2)*pi');
  assert.equal(t.last(), '= 4.44288293816');
  await t.run('calc 2+');
  assert.match(t.last(), /^! calc: a number is missing/);
  await t.run('=');
  assert.match(t.last(), /^! calc: nothing to calculate/);
  await t.run('help');
  assert.equal(t.lines.length, 10);
  assert.ok(t.lines.slice(1).every((l) => l.kind === 'hang'));
  assert.equal(t.lines[1].text, 'open      1-5 · a link name · a url', 'the numbers there are, as links names them');
  assert.equal(t.last(), '          esc clears · ctrl+enter new tab');
  await t.run('help theme');
  assert.equal(t.lines[1].text, 'theme [<name>|list|auto]');
  assert.equal(t.lines[1].runs[0][1], 'text');
  await t.run('help docs');
  assert.equal(t.last(), 'docs: a link to https://docs.example.org/start');
  await t.run('help theem');
  assert.deepEqual(t.texts().slice(1), ['no command called "theem"; type help to list them', 'did you mean help theme?']);
  await t.run('links');
  assert.deepEqual(t.texts().slice(1), [
    '[1] wikipedia  wikipedia.org', '[2] maps       openstreetmap.org', '[3] weather    open-meteo.com',
    '[4] docs       docs.example.org/start', '[5] my notes   notes.lan',
    '1-5 or a name + enter · ctrl+enter new tab',
  ], 'the hint names the numbers there are, as the column does');
  assert.ok(Array.from(t.last()).length <= 42, 'the hint fits the narrowest column (44 cells, 2 in)');
  assert.deepEqual(t.lines[1].runs.slice(0, 3), [['[', 'faint'], ['1', 'accent'], ['] ', 'faint']]);
  const one = make({ links: () => [{ label: 'wikipedia', url: 'https://www.wikipedia.org' }] });
  await one.run('links');
  assert.equal(one.last(), '1 or a name + enter · ctrl+enter new tab');
  const nine = make({ links: () => Array.from({ length: 9 }, (_, i) => ({ label: 'site ' + i, url: `https://s${i}.example.com` })) });
  await nine.run('links');
  assert.equal(nine.last(), '1-9 or a name + enter · ctrl+enter new tab');
  await make({ links: () => [] }).run('links');
  const nolinks = make({ links: () => [] });
  await nolinks.run('links');
  assert.equal(nolinks.last(), 'no links yet · add them in settings');
  await one.run('help');
  assert.equal(one.lines[1].text, 'open      1 · a link name · a url', 'help with one link: its number alone');
  await nine.run('help');
  assert.equal(nine.lines[1].text, 'open      1-9 · a link name · a url');
  await nolinks.run('help');
  assert.deepEqual(nolinks.lines[1].runs, [['open      ', 'faint'], ['a url', 'text']], 'help with no links: only a url, no number or link name');
  assert.equal(nolinks.lines.length, 10, 'still one row per group');
  await t.run('history');
  assert.ok(t.texts().slice(1).every((l) => /^\s*\d+ {2}\S/.test(l)));
  assert.match(t.last(), /history$/);
  await t.run('history clean');
  assert.equal(t.last(), '! history: unknown action "clean"; try history or history clear');
  await t.run('history of rome');
  assert.deepEqual(t.app.calls, [['search', 'history of rome', false]], 'words that are no action: a search');
  await t.run('clear');
  assert.equal(t.clears, 1);
  for (const [line, want] of [['hello', 'hello. the terminal is listening.'], ['sudo make me a sandwich', '(nothing happened, and nothing was logged)'],
    ['exit', '(ctrl+w closes this one, if you must)'], ['rm -rf /', 'just kidding. a new tab cannot touch your files.'], ['rm', 'rm: there are no files here']]) {
    await t.run(line);
    assert.equal(t.last(), want, line);
    assert.deepEqual(t.app.calls, [], `${line}: no side effect`);
    assert.ok(!t.lines.some((l) => l.runs.some((r) => r[1] === 'accent')), `${line}: no amber`);
  }
});

test('help fits the terminal: the echo and "open" stay in view, and "help more" shows the rest a page at a time', async () => {
  const C = T.lib('commands.js');
  const full = make();
  await full.run('help');
  const table = full.texts().slice(1);
  assert.equal(table.length, C.HELP_ROWS.length, 'a tall terminal shows every row');
  const MORE = 'more      help more';
  // [terminal rows, the pages help and help more show]: 13 rows at 1280x800@2, 10 and 9 in a 1280x620@2 window with
  // 5 and 9 links, 8 at 1920x969, 6 at 800x500, 4 and 3 in short windows (about 400 px tall). Three rows hold the
  // echo, one row and the prompt: a page is one row, with no room for the 'help more' row.
  for (const [rows, pages] of [[13, [9]], [11, [9]], [10, [7, 2]], [9, [6, 3]], [8, [5, 4]], [6, [3, 3, 3]], [4, [1, 1, 1, 1, 1, 1, 1, 2]],
    [3, [1, 1, 1, 1, 1, 1, 1, 1, 1]]]) {
    const hint = rows > 3; // a page that leaves rows ends with the 'help more' row
    const t = make({}, { rows: () => rows });
    let at = 0;
    for (const [i, n] of pages.entries()) {
      await t.run(i ? 'help more' : 'help');
      const last = at + n >= table.length;
      assert.deepEqual(t.texts().slice(1), table.slice(at, at + n).concat(last || !hint ? [] : [MORE]), `${rows} rows, page ${i + 1}`);
      assert.ok(t.lines.length + 1 <= rows, `${rows} rows, page ${i + 1}: the echo, ${t.lines.length - 1} lines and the prompt fit`);
      assert.ok(t.lines.slice(1).every((l) => l.kind === 'hang'));
      if (!last && hint) assert.deepEqual(t.lines.at(-1).runs, [['more      ', 'faint'], ['help more', 'text']], 'the hint reads like a table row');
      at += n;
    }
    assert.equal(at, table.length, `${rows} rows: the pages hold the whole table`);
    assert.equal(make({}, { rows: () => rows }).shell.ghost('help mo').text, '', 'more is no command to complete');
    // help more on its own (no help before it, or after the last page): the page after the first, or the whole table
    for (const fresh of [make({}, { rows: () => rows }), t]) {
      await fresh.run('help more');
      const first = pages[0];
      const want = first >= table.length ? table : table.slice(first, first + pages[1]).concat(pages.length > 2 && hint ? [MORE] : []);
      assert.deepEqual(fresh.texts().slice(1), want, `${rows} rows: help more alone`);
    }
  }
  // two rows (only in a window under about 170 px tall) cannot hold the echo, a row and the prompt: help still shows
  // the first row, and help more the next one
  const two = make({}, { rows: () => 2 });
  await two.run('help');
  assert.deepEqual(two.texts().slice(1), table.slice(0, 1), '2 rows: help');
  await two.run('help more');
  assert.deepEqual(two.texts().slice(1), table.slice(1, 2), '2 rows: help more');
  const t = make({}, { rows: () => 8 });
  await t.run('help more please');
  assert.deepEqual(t.app.calls, [['search', 'help more please', false]], 'more words: a search, as before');
  await t.run('help help');
  assert.ok(t.texts().includes('  help more   the rest of the list'), 'help help names it');
});

test('failures print one line and never throw: missing members, rejections, throwing views and links', async () => {
  const t = make({ openUrl: undefined, search: () => Promise.reject(new Error('Error: search works in the installed new tab only')) });
  await t.run('example.com');
  assert.equal(t.last(), '! that did not work: openUrl is not available here');
  await t.run('pixel art');
  assert.equal(t.last(), '! that did not work: search works in the installed new tab only');
  const odd = make({ view: () => { throw new Error('boom'); }, links: () => { throw new Error('boom'); }, shake: () => { throw new Error('busy'); } });
  await odd.run('date');
  assert.match(odd.texts()[1], /^\w+day \w+ \d+ \d{4} · /, 'a broken view falls back to the computer clock');
  await odd.run('1');
  assert.match(odd.last(), /no links yet/);
  await odd.run('shake');
  assert.equal(odd.last(), '! that did not work: busy');
  const said = [];
  const empty = T.createShell(null, { print: (l) => said.push(l.runs.map((r) => r[0]).join('')) });
  assert.equal((await empty.run('theme winter')).kind, 'error', 'no app at all: it still answers');
  assert.equal(said.at(-1), '! that did not work: theme is not available here');
  assert.equal((await empty.run('= 6*7')).kind, 'builtin');
  assert.equal(said.at(-1), '= 42');
});

test('history: memory, app.storage (sync or async), merged with other tabs, capped at 50 lines and 4000 bytes', async () => {
  const store = new Map([['termHistory', ['older', 'from storage']]]);
  const asyncStore = { get: (k) => Promise.resolve(store.get(k)), set: (k, v) => Promise.resolve(store.set(k, v)) };
  const t = make({ storage: asyncStore });
  await t.shell.load();
  assert.deepEqual(t.shell.history(), ['older', 'from storage']);
  await t.run('date');
  await t.shell.flush();
  assert.deepEqual(store.get('termHistory'), ['older', 'from storage', 'date']);
  store.set('termHistory', [...store.get('termHistory'), 'from another tab']);
  await t.run('help');
  await t.shell.flush();
  assert.deepEqual(store.get('termHistory'), ['older', 'from storage', 'date', 'from another tab', 'help'], 'merged, not overwritten');
  assert.deepEqual(t.shell.history(), store.get('termHistory'));
  assert.equal(t.shell.up(''), 'help');
  assert.equal(t.shell.up(''), 'from another tab');
  assert.equal(t.shell.down(''), 'help');
  assert.equal(t.shell.down(''), '', 'past the newest: the draft');
  t.shell.resetCursor();
  for (let i = 0; i < 70; i++) await t.run('line ' + i);
  await t.shell.flush();
  assert.equal(store.get('termHistory').length, 50);
  assert.equal(store.get('termHistory').at(-1), 'line 69');
  await t.run('x'.repeat(300));
  await t.shell.flush();
  assert.ok(Buffer.byteLength(JSON.stringify(store.get('termHistory'))) <= T.HISTORY_BYTES, 'fits chrome.storage.sync');
  await t.run('y'.repeat(2001));
  await t.shell.flush();
  assert.ok(!store.get('termHistory').some((l) => l.startsWith('yyy')), 'a pasted page is never kept');
  await t.run('history clear');
  await t.shell.flush();
  assert.deepEqual(store.get('termHistory'), []);
  assert.deepEqual(t.shell.history(), []);
  // a broken or missing storage keeps the history in memory
  const broken = make({ storage: { get: () => { throw new Error('no'); }, set: () => Promise.reject(new Error('quota')) } });
  await broken.shell.load();
  await broken.run('date');
  await broken.shell.flush();
  assert.deepEqual(broken.shell.history(), ['date']);
  const memory = make({ storage: undefined });
  await memory.run('a');
  await memory.run('a');
  await memory.run('b');
  assert.deepEqual(memory.shell.history(), ['a', 'b'], 'a repeat of the newest line is kept once');
  // lines typed before the stored history arrives are kept after it
  let release;
  const gate = new Promise((r) => { release = () => r(['stored']); });
  const slow = make({ storage: { get: () => gate, set: () => {} } });
  const loading = slow.shell.load();
  await slow.run('early');
  release();
  await loading;
  assert.deepEqual(slow.shell.history(), ['stored', 'early']);
});

test('adopt: another tab\'s stored history becomes this tab\'s; a line still being written stays; a shown entry stays', async () => {
  const store = new Map([['termHistory', ['older']]]);
  let gate = null;
  const storage = { get: (k) => (gate ? gate.then(() => store.get(k)) : store.get(k)), set: (k, v) => { store.set(k, v); } };
  const t = make({ storage });
  await t.shell.load();
  await t.run('date');
  await t.shell.flush();
  assert.deepEqual(t.shell.history(), ['older', 'date']);
  // another tab typed a line: its storage event brings the whole stored list
  t.shell.adopt(['older', 'date', 'calc 3*3']);
  assert.deepEqual(t.shell.history(), ['older', 'date', 'calc 3*3']);
  assert.equal(t.shell.up(''), 'calc 3*3', 'Up offers the newest line typed in any tab');
  // while Up shows an entry the new list waits, so the walk goes on over the list it started with
  t.shell.adopt(['older', 'date', 'calc 3*3', 'weather']);
  assert.deepEqual(t.shell.history(), ['older', 'date', 'calc 3*3']);
  assert.equal(t.shell.up(''), 'date');
  assert.equal(t.shell.down(''), 'calc 3*3');
  assert.equal(t.shell.down(''), '', 'past the newest: the draft');
  assert.equal(t.shell.up(''), 'weather', 'the waiting list is taken once the cursor leaves the entries');
  t.shell.adopt(['older', 'date', 'calc 3*3', 'weather', 'links']);
  t.shell.resetCursor();
  assert.deepEqual(t.shell.history(), ['older', 'date', 'calc 3*3', 'weather', 'links'], 'esc or enter takes it too');
  // a line typed here whose write has not landed yet stays when another tab's list arrives first
  let open;
  gate = new Promise((r) => { open = r; });
  await t.run('mine');
  store.set('termHistory', ['older', 'date', 'from tab 2']);
  t.shell.adopt(store.get('termHistory'));
  assert.deepEqual(t.shell.history(), ['older', 'date', 'from tab 2', 'mine']);
  open();
  await t.shell.flush();
  assert.deepEqual(store.get('termHistory'), ['older', 'date', 'from tab 2', 'mine'], 'and the write merges as before');
  assert.deepEqual(t.shell.history(), store.get('termHistory'));
  // history clear in another tab, and junk cleaned like a stored list
  t.shell.adopt([]);
  assert.deepEqual(t.shell.history(), []);
  assert.equal(t.shell.up('draft'), 'draft');
  t.shell.resetCursor();
  t.shell.adopt(['a', 'a', '  b ', 7, '', 'x'.repeat(2001)]);
  assert.deepEqual(t.shell.history(), ['a', 'b']);
  t.shell.adopt(undefined);
  assert.deepEqual(t.shell.history(), [], 'a removed key empties it');
});

test('ghost: a digit shows its link, a partial word what Tab adds; nothing on a space, a miss or a missing link', () => {
  const { shell } = make();
  assert.deepEqual(shell.ghost('3'), { text: '  → weather', accept: '' });
  assert.deepEqual(shell.ghost('3 &'), { text: '  → weather, new tab', accept: '' });
  assert.deepEqual(shell.ghost('8'), { text: '', accept: '' });
  assert.deepEqual(shell.ghost('wik'), { text: 'ipedia', accept: 'ipedia' });
  assert.deepEqual(shell.ghost('the'), { text: 'me', accept: 'me' });
  assert.deepEqual(shell.ghost('theme chr'), { text: 'istmas', accept: 'istmas' });
  assert.deepEqual(shell.ghost('theme s'), { text: '', accept: '' }, 'spring, summer, stpatricks share only s');
  assert.deepEqual(shell.ghost('hi'), { text: 'story', accept: 'story' });
  assert.deepEqual(shell.ghost('theme '), { text: '', accept: '' });
  assert.deepEqual(shell.ghost(''), { text: '', accept: '' });
  assert.deepEqual(shell.ghost('pixel art'), { text: '', accept: '' });
  assert.deepEqual(shell.complete('theme s'), { line: 'theme s', matches: ['spring', 'summer', 'stpatricks', 'snowy hills'], word: 's' });
  assert.deepEqual(shell.complete('se'), { line: 'settings ', matches: ['settings'], word: 'se' });
});

test('Tab and the ghost complete scene names too, where the name does not start with its id', async () => {
  const t = make();
  const { shell } = t;
  assert.deepEqual(shell.ghost('theme sn'), { text: 'owy hills', accept: 'owy hills' });
  assert.equal(shell.complete('theme sn').line, 'theme snowy hills ');
  assert.deepEqual(shell.ghost('theme hau'), { text: 'nted hill', accept: 'nted hill' });
  assert.equal(shell.complete('theme fo').line, 'theme fourth of july ');
  assert.equal(shell.complete('theme harv').line, 'theme harvest field ');
  assert.deepEqual(shell.complete('theme ha').matches, ['halloween', 'haunted hill', 'harvest field']);
  // a name that spells its id out adds nothing: the id completes as before, with its space
  for (const [typed, line] of [['theme chr', 'theme christmas '], ['theme spr', 'theme spring '], ['theme new', 'theme newyear '],
    ['theme lun', 'theme lunarnewyear '], ['theme val', 'theme valentines '], ['theme stp', 'theme stpatricks ']]) {
    assert.equal(shell.complete(typed).line, line, typed);
  }
  assert.deepEqual(shell.complete('theme st').matches, ['stpatricks']);
  // what Tab gives runs as it reads
  await t.run(shell.complete('theme sn').line);
  assert.deepEqual(t.app.calls, [['theme', 'winter']]);
  await t.run(shell.complete('theme fo').line);
  assert.deepEqual(t.app.calls, [['theme', 'july4']]);
  // the second word of a name is not completed (Tab works on the last word only)
  assert.deepEqual(shell.ghost('theme snowy h'), { text: '', accept: '' });
});

test('keyAction: what each prompt key does, and that Ctrl/Alt/Meta and IME keys are left alone', () => {
  const k = (key, extra = {}, ctx = { value: 'abc', atEnd: true, accept: '' }) => T.keyAction({ key, ...extra }, ctx);
  assert.deepEqual(k('Enter'), { act: 'submit', prevent: false });
  assert.deepEqual(k('Enter', { shiftKey: true }), { act: 'submit', prevent: false });
  assert.deepEqual(k('Enter', { ctrlKey: true }), { act: 'submit-new', prevent: false }, 'ctrl+enter is never prevented');
  assert.equal(k('Enter', { altKey: true }), null);
  assert.equal(k('Enter', { metaKey: true }), null);
  assert.deepEqual(k('ArrowUp'), { act: 'up', prevent: true });
  assert.deepEqual(k('ArrowDown'), { act: 'down', prevent: true });
  assert.equal(k('ArrowUp', { shiftKey: true }), null, 'shift+up selects as usual');
  assert.deepEqual(k('Tab'), { act: 'complete', prevent: true });
  assert.equal(k('Tab', {}, { value: '  ' }), null, 'tab on an empty line moves the focus');
  assert.equal(k('Tab', { shiftKey: true }), null);
  assert.deepEqual(k('ArrowRight', {}, { value: 'wik', atEnd: true, accept: 'ipedia' }), { act: 'accept', prevent: true });
  assert.equal(k('ArrowRight', {}, { value: 'wik', atEnd: false, accept: 'ipedia' }), null);
  assert.equal(k('ArrowRight', {}, { value: '3', atEnd: true, accept: '' }), null, 'a link preview is not accepted');
  assert.deepEqual(k('Escape'), { act: 'clear-line', prevent: true });
  assert.deepEqual(k('Escape', {}, { value: '' }), { act: 'clear-screen', prevent: true });
  for (const mod of ['ctrlKey', 'altKey', 'metaKey']) {
    for (const key of ['a', 'c', 'v', 'l', 't', 'w', 'ArrowUp', 'Tab', 'Escape', 'ArrowRight']) assert.equal(k(key, { [mod]: true }), null, `${mod}+${key}`);
  }
  for (const key of ['Enter', 'ArrowUp', 'Tab', 'Escape']) {
    assert.equal(k(key, { isComposing: true }), null, `IME ${key}`);
    assert.equal(k(key, { keyCode: 229 }), null, `IME 229 ${key}`);
  }
  assert.equal(k('a'), null);
  assert.equal(T.keyAction(null), null);
});

test('redirectKey: typing anywhere goes to the prompt, but never from fields, dialogs or with shortcuts', () => {
  const r = (key, extra = {}, ctx = {}) => T.redirectKey({ key, getModifierState: (m) => m === 'AltGraph' && !!extra.altGraph, ...extra }, ctx);
  for (const key of ['a', 'Z', '3', '/', '=', ' ', 'é', 'Backspace']) assert.equal(r(key), true, key);
  for (const key of ['Enter', 'Tab', 'Escape', 'ArrowUp', 'F5', 'Shift', 'Control', 'Dead', 'Unidentified']) assert.equal(r(key), false, key);
  for (const mod of ['ctrlKey', 'altKey', 'metaKey']) assert.equal(r('t', { [mod]: true }), false, mod);
  assert.equal(r('@', { ctrlKey: true, altKey: true, altGraph: true }), true, 'AltGr types');
  assert.equal(r('@', { ctrlKey: true, altKey: true, metaKey: true, altGraph: true }), false);
  assert.equal(r('a', {}, { editable: true }), false);
  assert.equal(r('a', {}, { dialog: true }), false, 'the settings sheet keeps its keys');
  assert.equal(r('a', {}, { inPrompt: true }), false);
  assert.equal(r(' ', {}, { activatable: true }), false, 'space still presses a focused button or link');
  assert.equal(r('a', {}, { activatable: true }), true, 'a letter on a focused link goes to the prompt');
  assert.equal(r('a', { isComposing: true }), false);
  assert.equal(r('a', { defaultPrevented: true }), false);
  assert.equal(T.redirectKey(null), false);
});

test('the module loader: one instance per module, a clear error for a module that did not load', () => {
  assert.equal(T.lib('router.js'), T.lib('./router.js'));
  assert.throws(() => T.lib('nope.js'), /terminal: nope\.js is not loaded/);
  for (const name of ['format.js', 'parse.js', 'url.js', 'calc.js', 'history.js', 'aliases.js', 'router.js', 'complete.js', 'commands.js']) {
    assert.equal(typeof T.lib(name), 'object', name);
  }
});
