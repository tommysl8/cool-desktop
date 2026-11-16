// The settings panel's pure part (src/newtab/js/ntp-panel.js): one control for every new
// tab setting of the schema, in its order and of its kind; control value <-> setting value for every option; the
// link editor's draft rules; the footer line; the box lines drawn as text (P.frame); the copy (lower case, safe glyphs
// only). The new tab's own files (ntp-panel.js, ntp-status.js, ntp-links.js, ntp-app.js, css/ntp-panel.css,
// css/newtab.css) pass the validator's per-file checks.
// The DOM behaviour (store round trip, other tabs, preview, keys, focus) runs in headless Chrome:
// node tools/test-newtab-status.mjs; the last test here mounts the sheet in headless Chrome too (the theme select and
// the surprise line, a link named like a terminal command).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

function findRoot(dir) {
  for (let d = dir; ; d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, 'tools', 'build.mjs'))) return d;
    if (path.dirname(d) === d) throw new Error('repo root not found');
  }
}
const ROOT = findRoot(import.meta.dirname);
const require = createRequire(import.meta.url);
const S = require(path.join(ROOT, 'src', 'newtab', 'js', 'ntp-settings.js'));
const P = require(path.join(ROOT, 'src', 'newtab', 'js', 'ntp-panel.js'));
const imp = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href);
const { lintJs, scanGlyphs, foreignUrls, ALLOWED_HOSTS } = await imp('tools/validate.mjs');
const { isSafeChar } = await imp('tools/lib/glyphs.mjs');
const chrome = await imp('tools/lib/chrome.mjs');
const { serve } = await imp('tools/lib/serve.mjs');
const { loadTerm, TERM_DIR, TERM_SCRIPTS } = await imp('tests/newtab-term-load.mjs');
const NO_BROWSER = chrome.findBrowser() ? false : 'no Chrome or Edge installed';

const MENU = [{ id: 'auto', name: 'Auto (by date)' }, { id: 'winter', name: 'Snowy hills' }, { id: 'autumn', name: 'Autumn forest' }];
const CONFIG = { city: 'Berlin', units: 'C', clock: '12h', sunTimes: true, weather: true, shortcuts: [{ label: 'wiki', url: 'https://www.wikipedia.org' }] };
const KIND = { bool: 'check', clock: 'radio', enum: 'radio', city: 'text', theme: 'select', shortcuts: 'shortcuts' };

test('fields: every new tab setting of the schema, in its order, with the control of its kind', () => {
  const f = P.fields(S, { themes: MENU });
  assert.deepEqual(f.map((x) => x.key), S.keys('newtab'));
  assert.deepEqual(f.map((x) => x.key), ['clock24', 'city', 'units', 'sunTimes', 'weather', 'weatherFx', 'theme',
    'reducedMotion', 'performance', 'shortcutsMode', 'shortcuts', 'clockStatus', 'focusTerminal']);
  for (const x of f) {
    const d = S.spec(x.key);
    assert.equal(x.kind, KIND[d.kind], x.key);
    assert.ok(typeof x.label === 'string' && x.label && x.label === x.label.toLowerCase(), `${x.key}: a lower-case label`);
    if (d.kind === 'enum') assert.deepEqual(x.options.map((o) => o.value), d.values, `${x.key}: every value`);
    if (d.kind === 'bool') assert.ok(x.text, `${x.key}: a caption`);
  }
  const by = Object.fromEntries(f.map((x) => [x.key, x]));
  // the sheet's rows and words
  assert.deepEqual(f.map((x) => x.label), ['clock', 'city', 'units', 'sun times', 'weather', 'scene fx', 'theme', 'motion',
    'performance', 'links', 'my links', 'pixelclock', 'terminal']);
  assert.deepEqual(by.clock24.options, [{ value: false, raw: 'false', label: '12 h' }, { value: true, raw: 'true', label: '24 h' }]);
  assert.deepEqual(by.units.options.map((o) => o.label), ['°F', '°C']);
  assert.deepEqual(by.reducedMotion.options.map((o) => [o.value, o.label]), [['auto', 'auto'], ['on', 'less'], ['off', 'full']]);
  assert.deepEqual(by.performance.options.map((o) => [o.value, o.label]), [['auto', 'auto'], ['on', 'on'], ['off', 'off']]);
  assert.deepEqual(by.shortcutsMode.options.map((o) => [o.value, o.label]), [['custom', 'my links'], ['top', 'top sites']]);
  assert.deepEqual([by.sunTimes.text, by.weather.text, by.weatherFx.text, by.clockStatus.text, by.focusTerminal.text],
    ['real sunrise and sunset', 'show', 'in the scene', 'show my clock\'s alarms', 'focus on open']);
  assert.equal(by.focusTerminal.kind, 'check');
  assert.equal(by.weatherFx.join, 'weather', '"weather [x] show [x] in the scene": one row');
  assert.deepEqual(f.filter((x) => x.join).map((x) => x.key), ['weatherFx']);
  assert.equal(by.shortcuts.sub, true, 'the editor button sits under the shortcuts row');
  assert.equal(by.city.max, S.CITY_MAX);
  assert.equal(by.shortcuts.max, S.SHORTCUTS_MAX);
  assert.equal(by.shortcuts.labelMax, S.LABEL_MAX);
  assert.equal(by.shortcuts.urlMax, S.URL_MAX);
});

test('fields: the theme list is auto first, then the menu in its order with lower-case names; junk is dropped', () => {
  const f = P.fields(S, { themes: [...MENU, 'winter', { id: 'Bad Id', name: 'x' }, { id: 'halloween' }, 7, null] });
  const theme = f.find((x) => x.key === 'theme');
  assert.deepEqual(theme.options.map((o) => [o.value, o.label]), [['auto', 'auto'], ['winter', 'snowy hills'],
    ['autumn', 'autumn forest'], ['halloween', 'halloween']]);
  assert.deepEqual(P.fields(S).find((x) => x.key === 'theme').options.map((o) => o.value), ['auto'], 'no menu: auto only');
});

test('fields: copy overrides change only what they name; joins only to an earlier row; other scopes get their own kinds', () => {
  const f = P.fields(S, { copy: { rows: { city: { label: 'town' }, units: { options: { C: 'celsius' } }, clock24: { join: 'performance' }, performance: { join: 'units' } } } });
  const by = Object.fromEntries(f.map((x) => [x.key, x]));
  assert.equal(by.city.label, 'town');
  assert.equal(by.clock24.label, 'clock', 'the other rows keep the default copy');
  assert.deepEqual(by.units.options.map((o) => o.label), ['°F', 'celsius']);
  assert.equal(by.clock24.join, undefined, 'a join to a later row is ignored');
  assert.equal(by.performance.join, 'units', 'a radio may share an earlier row');
  assert.equal(P.fields(S, { copy: { rows: { city: { join: 'clock24' } } } }).find((x) => x.key === 'city').join, undefined, 'only choices share rows');
  const wp = P.fields(S, { scope: 'wallpaper' });
  assert.deepEqual(wp.map((x) => x.key), S.keys('wallpaper'));
  assert.ok(!wp.some((x) => x.key === 'shortcuts'));
  for (const scope of S.SCOPES) {
    for (const x of P.fields(S, { scope })) assert.ok(['check', 'radio', 'text', 'select', 'shortcuts'].includes(x.kind), `${scope} ${x.key}: ${x.kind}`);
  }
  assert.equal(wp.find((x) => x.key === 'weatherFx').join, 'weather');
  assert.throws(() => P.fields({}), /load js\/ntp-settings\.js/);
});

test('editText: the link editor button says how many there are', () => {
  assert.equal(P.editText(0), 'add a link');
  assert.equal(P.editText(1), 'edit the link');
  assert.equal(P.editText(5), 'edit the 5 links');
  assert.equal(P.editText(9, P.mergeCopy({ edit: { many: '%n shortcuts' } })), '9 shortcuts');
});

test('frame: the box lines as text, the words left blank on the borders and placed in cells', () => {
  const fr = P.frame(48, 20, { title: 'settings', tag: 'esc', foot: 'synced with chrome' });
  assert.equal(fr.lines.length, 20);
  for (const line of fr.lines) assert.equal([...line].length, 48, JSON.stringify(line));
  assert.equal(fr.lines[0], '╭─ ' + ' '.repeat(8) + ' ' + '─'.repeat(29) + ' ' + '   ' + ' ─╮');
  for (const line of fr.lines.slice(1, -1)) assert.equal(line, '│' + ' '.repeat(46) + '│');
  assert.equal(fr.lines[19], '╰' + '─'.repeat(25) + ' ' + ' '.repeat(18) + ' ─╯');
  assert.deepEqual(fr.title, { c: 3, r: 0, text: 'settings' });
  assert.deepEqual(fr.tag, { c: 42, r: 0, text: 'esc' });
  assert.deepEqual(fr.foot, { c: 27, r: 19, text: 'synced with chrome' });
  // the words fill exactly the blanks: put them in and the borders read as the sheet draws them
  const put = (line, at) => line.slice(0, at.c) + at.text + line.slice(at.c + at.text.length);
  assert.equal(put(put(fr.lines[0], fr.title), fr.tag), '╭─ settings ' + '─'.repeat(29) + ' esc ─╮');
  assert.equal(put(fr.lines[19], fr.foot), '╰' + '─'.repeat(25) + ' synced with chrome ─╯');
  // narrow: the tag goes first, then the foot; the title is cut
  const narrow = P.frame(18, 4, { title: 'settings', tag: 'esc', foot: 'synced with chrome' });
  assert.equal(narrow.tag, null);
  assert.equal(narrow.foot, null);
  assert.deepEqual(narrow.title, { c: 3, r: 0, text: 'settings' });
  assert.equal(narrow.lines[0], '╭─ ' + ' '.repeat(8) + ' ' + '─'.repeat(4) + '─╮');
  assert.equal(narrow.lines[3], '╰' + '─'.repeat(16) + '╯');
  const tiny = P.frame(10, 3, { title: 'settings' });
  assert.equal(tiny.title.text, 'set');
  assert.ok(tiny.lines.every((l) => [...l].length === 10));
  // no words: plain lines
  assert.deepEqual(P.frame(4, 2, {}).lines, ['╭──╮', '╰──╯']);
  for (const line of fr.lines) for (const ch of line) assert.ok(isSafeChar(ch), `U+${ch.codePointAt(0).toString(16)}`);
});

test('toValue / fromValue: every option and value round-trips; the defaults map onto existing options', () => {
  const f = P.fields(S, { themes: MENU });
  for (const x of f) {
    if (x.options) {
      for (const o of x.options) {
        assert.equal(P.fromValue(x, o.value), o.raw, `${x.key} ${o.raw}`);
        assert.deepEqual(P.toValue(x, o.raw), o.value, `${x.key} ${o.raw}`);
      }
    }
  }
  const by = Object.fromEntries(f.map((x) => [x.key, x]));
  assert.equal(P.toValue(by.weather, true), true);
  assert.equal(P.toValue(by.weather, false), false);
  assert.equal(P.fromValue(by.weather, 'yes'), false, 'only true checks the box');
  assert.equal(P.toValue(by.city, ' Oslo '), ' Oslo ', 'the store cleans text, the panel passes it on');
  assert.equal(P.fromValue(by.city, null), '');
  assert.equal(P.fromValue(by.theme, 'gone'), 'gone', 'an unknown pinned theme keeps its id (the panel adds an option)');
  assert.deepEqual(P.fromValue(by.shortcuts, [{ label: 'a', url: 'https://a.example' }, 'junk']), [{ label: 'a', url: 'https://a.example' }, { label: '', url: '' }]);
  const defs = S.defaults(CONFIG, { scope: 'newtab', themes: MENU });
  for (const x of f) {
    const raw = P.fromValue(x, defs[x.key]);
    if (x.options) assert.ok(x.options.some((o) => o.raw === raw), `${x.key}: default ${JSON.stringify(defs[x.key])} has a control`);
  }
});

test('draftShortcuts: blank rows are ignored, bad rows reported by index, good rows normalized; 9 at most', () => {
  const d = P.draftShortcuts([
    { label: '', url: 'example.com' },
    { label: 'docs', url: 'http://localhost:8080/x' },
    { label: '  ', url: '' },
    { label: 'bad', url: 'not a url' },
    { label: 'ftp', url: 'ftp://example.com' },
    { label: 'x'.repeat(25), url: 'example.org' },
  ], S);
  assert.deepEqual(d.values, [{ label: 'example.com', url: 'https://example.com' }, { label: 'docs', url: 'http://localhost:8080/x' }]);
  assert.deepEqual(d.valid.map((v) => v.index), [0, 1]);
  assert.deepEqual(d.errors.map((e) => e.index), [3, 4, 5]);
  assert.match(d.errors[0].error, /spaces/);
  assert.match(d.errors[1].error, /only http and https/);
  assert.match(d.errors[2].error, /too long/);
  assert.equal(d.blank, 1);
  assert.equal(d.ok, false);
  const many = P.draftShortcuts(Array.from({ length: 14 }, (_, i) => ({ label: 's' + i, url: `s${i}.example.com` })), S);
  assert.equal(many.ok, true);
  assert.equal(many.values.length, 9);
  assert.deepEqual(P.draftShortcuts([], S), { values: [], valid: [], errors: [], blank: 0, ok: true });
  assert.deepEqual(P.draftShortcuts(null, S).values, []);
});

test('syncText: where the settings live, "saving" while a write waits, the error otherwise', () => {
  assert.equal(P.syncText({ kind: 'chrome.storage.sync', pending: [] }), 'synced with chrome');
  assert.equal(P.syncText({ kind: 'localStorage (preview)' }), 'preview: saved in this browser');
  assert.equal(P.syncText({ kind: 'memory' }), 'not saved: no storage here');
  assert.equal(P.syncText({ kind: 'chrome.storage.sync', pending: ['city'] }), 'saving');
  assert.equal(P.syncText({ kind: 'chrome.storage.sync', writing: true }), 'saving');
  assert.equal(P.syncText({ kind: 'chrome.storage.sync', lastError: { kind: 'rate-minute', message: 'too many writes', retrying: true } }), 'not saved: too many writes; retrying');
  assert.equal(P.syncText({ kind: 'x', lastError: { kind: 'item' } }), 'not saved: item');
  assert.equal(P.syncText({ kind: 'other area' }), 'other area');
  assert.equal(P.syncText(null), '');
  assert.equal(P.syncText({ kind: 'memory' }, P.mergeCopy({ sync: { memory: 'kept for this tab' } })), 'kept for this tab');
});

test('copy: lower case, safe glyphs only', () => {
  const texts = [];
  const walk = (v) => {
    if (typeof v === 'string') texts.push(v);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk(P.COPY);
  for (const t of texts) {
    for (const ch of t) assert.ok(isSafeChar(ch), `unsafe glyph U+${ch.codePointAt(0).toString(16)} in ${JSON.stringify(t)}`);
  }
  for (const [key, row] of Object.entries(P.COPY.rows)) assert.equal(row.label, row.label.toLowerCase(), key);
  assert.ok(P.mergeCopy({ title: 'prefs', rows: 'junk', sync: 3 }).title === 'prefs');
  assert.notEqual(P.mergeCopy({}).rows, P.COPY.rows, 'a copy, never the shared object');
});

test('mount: refuses to run without a store', () => {
  assert.throws(() => P.mount({}), /opts\.store/);
  assert.throws(() => P.mount({ store: { get() {} } }), /opts\.store/);
});

test('commandName: a link name the terminal runs as a command (built-ins come before link names)', () => {
  const C = loadTerm().lib('commands.js');
  const themes = [{ id: 'winter', name: 'snowy hills' }, { id: 'autumn', name: 'autumn forest' }];
  for (const label of ['weather', 'Weather', ' help ', 'g', 'yt', 'clock', 'theme', 'theme winter', 'theme snowy hills', 'g cats', 'clock 13', 'hello']) {
    assert.equal(P.commandName(label, C, { themes }), true, label);
  }
  for (const label of ['wikipedia', 'maps', 'open-meteo', 'theme park', 'hello world', 'help me', '', '   ']) {
    assert.equal(P.commandName(label, C, { themes }), false, JSON.stringify(label));
  }
  assert.equal(P.commandName('weather', undefined, { themes }), true, 'the loaded terminal\'s table by default');
  assert.equal(P.commandName('weather', null), false, 'no terminal: no note');
  assert.equal(P.commandName('weather', {}), false, 'a table without isBuiltinName: no note');
  assert.equal(P.commandName('weather', { isBuiltinName: (n) => n === 'weather' }), true, 'isBuiltinName alone is enough for one word');
  assert.equal(P.commandName('weather now', { isBuiltinName: () => true }), false, 'without acceptsArgs only a single word counts');
});

test('mount (headless Chrome): every theme pick reaches the page, the surprise line comes and goes, a link named like a command gets a note',
  { skip: NO_BROWSER, timeout: 120000 }, async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pcd-panel-'));
    const own = ['js/ntp-settings.js', 'js/ntp-store.js', 'js/ntp-panel.js'];
    for (const f of own) fs.copyFileSync(path.join(ROOT, 'src', 'newtab', f), path.join(tmp, path.basename(f)));
    fs.copyFileSync(path.join(ROOT, 'src', 'newtab', 'css', 'ntp-panel.css'), path.join(tmp, 'ntp-panel.css'));
    for (const f of TERM_SCRIPTS) {
      fs.mkdirSync(path.dirname(path.join(tmp, 'term', f)), { recursive: true });
      fs.copyFileSync(path.join(TERM_DIR, f), path.join(tmp, 'term', f));
    }
    const tags = [...own.map((f) => path.basename(f)), ...TERM_SCRIPTS.map((f) => `term/${f}`)].map((s) => `<script src="${s}"></script>`).join('\n');
    fs.writeFileSync(path.join(tmp, 'test.html'), `<!doctype html>\n<meta charset="utf-8">\n<title>panel test</title>\n<link rel="stylesheet" href="ntp-panel.css">\n${tags}\n<body></body>\n`);
    const config = { ...CONFIG, shortcuts: [{ label: 'wiki', url: 'https://www.wikipedia.org' }, { label: 'maps', url: 'https://www.openstreetmap.org' }] };
    let browser = null;
    let srv = null;
    try {
      srv = await serve(tmp);
      browser = await chrome.launch();
      const page = await browser.newPage(srv.url + 'test.html');
      await page.evaluate(async (menu, cfg) => {
        localStorage.clear();
        window.calls = [];
        window.running = null;
        window.st = PCD.store.create({ config: cfg, themes: menu });
        await st.load();
        window.panel = PCD.panel.mount({
          store: st, themes: menu,
          onSurprise: () => { calls.push('surprise'); return { id: 'winter', name: 'Snowy hills', tag: 'surprise' }; },
          onTheme: (id) => { calls.push('theme:' + id); },
          surpriseNow: () => window.running,
        });
      }, MENU, config);
      const SEL = 'dialog.pcd-panel .pcd-panel__row[data-key="theme"] select';
      const look = () => page.evaluate((sel) => {
        const e = document.querySelector(sel);
        return { st: panel.state(), value: e.value, extra: e.querySelectorAll('option[data-extra="surprise"]').length, calls: calls.slice() };
      }, SEL);
      const pick = (v) => page.evaluate((sel, val) => {
        const e = document.querySelector(sel);
        e.value = val;
        e.dispatchEvent(new Event('change', { bubbles: true }));
      }, SEL, v);

      await page.evaluate('panel.open()');
      let s = await look();
      assert.equal(s.st.surprise, null);
      assert.equal(s.value, 'auto');
      // ☼ surprise me: the select shows the surprise, the stored theme is still auto
      await page.evaluate(() => document.querySelector('dialog.pcd-panel [data-action="surprise"]').click());
      s = await look();
      assert.equal(s.st.surprise, 'surprise · snowy hills');
      assert.equal(s.st.values.theme, 'auto', 'the stored theme is unchanged');
      assert.equal(s.extra, 1);
      assert.deepEqual(s.calls, ['surprise']);
      // picking the stored theme again is a change the page hears, and the surprise line goes
      await pick('auto');
      s = await look();
      assert.deepEqual(s.calls, ['surprise', 'theme:auto']);
      assert.equal(s.st.surprise, null);
      assert.equal(s.value, 'auto');
      assert.equal(s.extra, 0);
      // another scene: heard and stored
      await pick('winter');
      await page.evaluate('st.flush()');
      s = await look();
      assert.deepEqual(s.calls.slice(-1), ['theme:winter']);
      assert.equal(await page.evaluate('st.get().theme'), 'winter');
      // a surprise running in the tab (the terminal's) shows when the sheet opens; none: the stored theme
      await page.evaluate("panel.close(); window.running = { id: 'autumn', name: 'Autumn forest' }; panel.open()");
      s = await look();
      assert.equal(s.st.surprise, 'surprise · autumn forest');
      assert.equal(s.st.values.theme, 'winter');
      await page.evaluate('panel.close(); window.running = null; panel.open()');
      s = await look();
      assert.equal(s.st.surprise, null);
      assert.equal(s.value, 'winter');

      // a link named like a terminal command: an info note under it, the row still valid and saved
      const named = await page.evaluate(async () => {
        const d = document.querySelector('dialog.pcd-panel');
        d.querySelector('[data-action="edit"]').click();
        const input = d.querySelectorAll('.pcd-panel__item .pcd-panel__item-label')[0];
        input.value = 'weather';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        await st.flush();
        const notes = [...d.querySelectorAll('.pcd-panel__item')].map((li) => {
          const n = li.querySelector('.pcd-panel__item-note');
          return n.hidden ? null : { text: n.textContent, level: n.getAttribute('data-level'), invalid: li.hasAttribute('data-invalid') };
        });
        return { notes, stored: st.get().shortcuts.map((x) => x.label), sheetNote: panel.state().notes.shortcuts || null };
      });
      assert.deepEqual(named.notes, [{ text: '"weather" is also a command: type its number to open it', level: 'info', invalid: false }, null]);
      assert.deepEqual(named.stored, ['weather', 'maps']);
      assert.equal(named.sheetNote, null, 'no "fix the marked link" line: nothing is wrong');
      // the note shows again when the sheet opens with that list
      const again = await page.evaluate(() => {
        panel.close();
        panel.open();
        document.querySelector('dialog.pcd-panel [data-action="edit"]').click();
        const n = document.querySelector('dialog.pcd-panel .pcd-panel__item .pcd-panel__item-note');
        return n.hidden ? null : n.textContent;
      });
      assert.equal(again, '"weather" is also a command: type its number to open it');
      assert.deepEqual(page.errors, [], 'no console error or exception');
    } finally {
      if (browser) await browser.close();
      if (srv) await srv.close();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

test('shipped files: classic UMD, CSP-clean, UTF-8 without BOM, LF, safe glyphs, no CSS motion', () => {
  const files = ['src/newtab/js/ntp-panel.js', 'src/newtab/js/ntp-status.js', 'src/newtab/js/ntp-links.js', 'src/newtab/js/ntp-app.js',
    'src/newtab/css/ntp-panel.css', 'src/newtab/css/newtab.css'];
  for (const rel of files) {
    const buf = fs.readFileSync(path.join(ROOT, rel));
    assert.notDeepEqual([...buf.subarray(0, 3)], [0xef, 0xbb, 0xbf], `${rel}: BOM`);
    const text = buf.toString('utf8');
    assert.ok(!text.includes('\r'), `${rel}: CRLF`);
    assert.deepEqual([...scanGlyphs(text).keys()], [], `${rel}: unsafe glyphs`);
    assert.deepEqual(foreignUrls(text, ALLOWED_HOSTS), [], `${rel}: only allowed hosts, comments included (the validator's URL rule)`);
    if (rel.endsWith('.js')) {
      assert.deepEqual(lintJs(text), [], `${rel}: CSP lint`);
      assert.ok(!/^\s*(import|export)\s/m.test(text), `${rel}: no module syntax`);
    } else {
      const css = text.replace(/\/\*[\s\S]*?\*\//g, '');
      assert.ok(!/\b(transition|animation)\s*:/.test(css), `${rel}: no transitions or animations`);
      assert.ok(!/url\(|@import/.test(css), `${rel}: nothing loaded from CSS`);
      assert.ok(!/border-radius\s*:\s*[1-9]/.test(css), `${rel}: no rounded CSS boxes`);
      assert.ok(!/cursor\s*:\s*pointer/.test(css), `${rel}: no pointer cursor (only the scene and links)`);
    }
  }
  assert.equal(require(path.join(ROOT, 'src', 'newtab', 'js', 'ntp-panel.js')), globalThis.PCD.panel, 'UMD: the same object as the global');
  const css = fs.readFileSync(path.join(ROOT, 'src', 'newtab', 'css', 'ntp-panel.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(!/\bborder(-[a-z]+)?\s*:\s*(?!0\b)[^;]*\b(solid|dashed|dotted|double)\b/.test(css), 'no CSS box lines: the frame is text');
});
