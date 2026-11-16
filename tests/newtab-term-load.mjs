// Loads the new tab terminal's classic scripts (src/newtab/js/term/) into this Node process the way the page loads
// them: each registers on globalThis.PCD. A helper for tests/newtab-term-*.test.mjs, not a test file.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, '..');
export const TERM_DIR = path.join(ROOT, 'src', 'newtab', 'js', 'term');
/** Every script of the terminal in the canonical load order (any order works: nothing runs until mount). */
export const TERM_SCRIPTS = Object.freeze([
  'lib/format.js', 'lib/parse.js', 'lib/url.js', 'lib/calc.js', 'lib/history.js', 'lib/aliases.js', 'lib/router.js',
  'lib/complete.js', 'term-commands.js', 'term-url.js', 'term-shell.js', 'term-ui.js',
]);

/** PCD.term with every script loaded. */
export function loadTerm() {
  const require = createRequire(import.meta.url);
  for (const f of TERM_SCRIPTS) require(path.join(TERM_DIR, f));
  return globalThis.PCD.term;
}

/** Every .js file under src/newtab/js/term/ (posix paths relative to it), sorted. */
export function termFiles() {
  const out = [];
  const walk = (dir, rel) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(dir, e.name), r);
      else if (e.name.endsWith('.js')) out.push(r);
    }
  };
  walk(TERM_DIR, '');
  return out.sort();
}

/** A stub app (the page's seam) that records every call; links and themes from config/user.example.json-like data. */
export function stubApp(over = {}) {
  const calls = [];
  const store = new Map();
  const state = { clock24: false, id: 'autumn', name: 'Autumn forest', tag: 'auto' };
  const THEMES = [
    { id: 'winter', name: 'Snowy hills', kind: 'season' }, { id: 'spring', name: 'Spring meadow', kind: 'season' },
    { id: 'summer', name: 'Summer beach', kind: 'season' }, { id: 'autumn', name: 'Autumn forest', kind: 'season' },
    { id: 'newyear', name: "New Year's Eve", kind: 'holiday' }, { id: 'lunarnewyear', name: 'Lunar New Year', kind: 'holiday' },
    { id: 'valentines', name: "Valentine's Day", kind: 'holiday' }, { id: 'stpatricks', name: "St. Patrick's Day", kind: 'holiday' },
    { id: 'easter', name: 'Easter', kind: 'holiday' }, { id: 'july4', name: 'Fourth of July', kind: 'holiday' },
    { id: 'halloween', name: 'Haunted hill', kind: 'holiday' }, { id: 'thanksgiving', name: 'Harvest field', kind: 'holiday' },
    { id: 'christmas', name: 'Christmas cabin', kind: 'holiday' },
  ];
  const nameOf = (id) => (THEMES.find((t) => t.id === id) || { name: id }).name;
  const app = {
    calls,
    store,
    state,
    links: () => [
      { label: 'wikipedia', url: 'https://www.wikipedia.org' },
      { label: 'maps', url: 'https://www.openstreetmap.org' },
      { label: 'weather', url: 'https://open-meteo.com' },
      { label: 'Docs', url: 'https://docs.example.org/start' },
      { label: 'my notes', url: 'http://notes.lan/' },
    ],
    openUrl: (url, newTab) => { calls.push(['openUrl', url, newTab]); },
    search: (text, newTab) => { calls.push(['search', text, newTab]); },
    theme: (x) => {
      if (x === 'list') return THEMES.map((t) => ({ ...t }));
      calls.push(['theme', x]);
      if (x === 'auto') Object.assign(state, { id: 'autumn', name: nameOf('autumn'), tag: 'auto' });
      else Object.assign(state, { id: x, name: nameOf(x), tag: 'pinned' });
      return { id: state.id, name: state.name, tag: state.tag };
    },
    surprise: () => {
      calls.push(['surprise']);
      Object.assign(state, { id: 'halloween', name: nameOf('halloween'), tag: 'surprise' });
      return { id: state.id, name: state.name, tag: state.tag };
    },
    shake: () => { calls.push(['shake']); },
    setClock24: (b) => { calls.push(['setClock24', b]); state.clock24 = !!b; },
    openSettings: () => { calls.push(['openSettings']); },
    view: () => ({
      now: new Date(2026, 10, 15, 20, 40).getTime(), clock24: state.clock24, id: state.id, name: state.name, tag: state.tag,
      phase: 'night', sun: { rise: 7.45, set: 16.25 }, weather: null, status: null,
    }),
    storage: { get: (k) => store.get(k), set: (k, v) => { store.set(k, v); } },
    ...over,
  };
  return app;
}
