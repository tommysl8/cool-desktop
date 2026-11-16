/* PixelClock Desktop, new tab terminal: the shell. Classic script, UMD: PCD.term (module.exports in Node). No DOM: it
 * turns typed lines into calls on the page's app object and into printed lines; term-ui.js draws them. Also the loader
 * of the terminal's modules.
 *
 *   PCD.term.lib(name)  the module 'format.js', 'parse.js', 'url.js', 'calc.js', 'history.js', 'aliases.js',
 *                       'router.js', 'complete.js' (the copied libraries in term/lib/) or 'commands.js'
 *                       (term-commands.js), instantiated on first use from PCD.termDefs
 *   PCD.term.createShell(app, { print(line, block), block(), clear(), cols(), rows(), historyKey }) -> shell
 *     cols() and rows() are the terminal's size in cells (rows counts the prompt's row): lists wrap to the width, and
 *     help shows the rows that fit under its echo, then a 'help more' row when some are left ('help more' shows the
 *     next page the same way; a terminal of three rows shows one row a page and no 'help more' row)
 *     line = { kind: 'cmd' | 'out' | 'hang' | 'art' | 'error', runs: [[text, roles, href?], ...] } where roles is a space
 *     list of token roles (text muted faint accent frame ring wood bold: pcd-base.css t-<role>). Each run first asks
 *     block() for a place of its own and passes it back with every line it prints, so an answer that arrives late (an
 *     app call that resolves after the next line was typed) still lands under its own command.
 *     shell.run(line, { newTab }) -> Promise<outcome>   echo the line, then act on it; outcome = { kind: 'empty' |
 *         'builtin' | 'link' | 'url' | 'search' | 'error', name?, url?, text?, newTab }; failures print a '! ...' line
 *         and never throw
 *     shell.ghost(value) -> { text, accept }   what to show faint after the typed text: a link preview for 1-9
 *         ('  → maps'; accept '') or the completion of the last word (accept = the same text)
 *     shell.complete(value) -> { line, matches, word }   Tab (complete.js: commands, link names, subcommands, theme
 *         ids and the scene names that do not start with their id, such as 'snowy hills', help <command>)
 *     shell.up(current) / shell.down(current) -> string; shell.resetCursor()    the history cursor
 *     shell.history() -> [lines]; shell.load() -> Promise (history from app.storage, merged with this tab's lines);
 *     shell.flush() -> Promise (the history writes so far)
 *     shell.adopt(list)   the stored history as another tab just wrote it (a storage change event's newValue): it
 *         becomes this tab's list, so Up offers the newest line typed in any tab; lines typed here whose write is still
 *         on its way stay, and while Up/Down shows an entry the new list waits until the cursor leaves the entries
 *     shell.links() -> [{ name, url }] (app.links(), at most 9, names lower case); shell.themes() -> [{ id, name, kind }]
 *   PCD.term.keyAction(event, { value, atEnd, accept }) -> null | { act, prevent }  the prompt's keys (term-ui.js):
 *     Enter 'submit', Ctrl+Enter 'submit-new' (never prevented), Up/Down 'up'/'down', Tab 'complete' (only with text:
 *     on an empty line Tab moves the focus as usual), Right at the end with a ghost 'accept', Esc 'clear-line' or, on an
 *     empty line, 'clear-screen'. Ctrl/Alt/Meta combinations (but Ctrl+Enter) and IME composition give null.
 *   PCD.term.redirectKey(event, { inPrompt, editable, dialog, activatable }) -> bool   a key typed anywhere on the page
 *     moves the focus to the prompt: printable keys and Backspace, never with Ctrl/Alt/Meta (AltGr counts as typing),
 *     never inside other fields or dialogs, and not Space on a focused button or link
 *   PCD.term.statusRuns(view), PCD.term.HISTORY_KEY ('termHistory'), HISTORY_KEEP (50), HISTORY_BYTES (4000)
 *
 * The app object (the page's seam; every member may also return a Promise):
 *   links() -> [{ name | label, url }]    the console's numbered links, in order (up to 9)
 *   openUrl(url, newTab)                   open an http(s) address here or in a new tab (PCD.term.url.actions)
 *   search(text, newTab)                   Chrome's default engine (chrome.search.query, CURRENT_TAB or NEW_TAB)
 *   theme(id | 'auto' | 'list')            'list' -> [{ id, name, kind }] in menu order (synchronous); otherwise switch
 *                                          (cross-fade) and return { id, name, tag } of the scene now showing
 *   surprise() -> { id, name, tag }; shake(); setClock24(bool); openSettings()
 *   view() -> { now | date, clock24, id, name, tag, phase, sun: { rise, set } | null, weather: { data, units, city,
 *            ageMs } | null, status: PCD.status.describe() view | null }   (PCD.host.view() plus weather and status)
 *   storage: { get(key) -> value, set(key, value) }   the history (an array of strings, oldest first)
 * What the terminal knows before the app answers it prints at once (theme <name>, clock 24, opening, searching); the
 * app's promise only adds a '! ...' line when it fails.
 */
(function (root, factory) {
  var api = factory(root.PCD || (root.PCD = {}), root);
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (PCD, root) {
  'use strict';

  const T = PCD.term || (PCD.term = {});
  const cache = Object.create(null);

  /** One of the terminal's modules (see the header). Throws when its script was not loaded. */
  function lib(name) {
    const key = String(name == null ? '' : name).replace(/^\.\//, '');
    if (cache[key]) return cache[key].exports;
    const defs = PCD.termDefs || {};
    const def = Object.prototype.hasOwnProperty.call(defs, key) ? defs[key] : null;
    if (typeof def !== 'function') throw new Error(`terminal: ${key || 'a module'} is not loaded`);
    const mod = { exports: {} };
    cache[key] = mod;
    try {
      def(lib, mod.exports);
    } catch (e) {
      delete cache[key];
      throw e;
    }
    return mod.exports;
  }

  const HISTORY_KEY = 'termHistory';
  const HISTORY_KEEP = 50;
  const HISTORY_BYTES = 4000;
  const MAX_LINKS = 9;
  const NAME_MAX = 24;
  const WEATHER_MIN_W = 12; // the console's narrowest weather block (its two compact lines)
  const NO_WEATHER = 'no weather yet · the city and the weather switch are in settings';
  const ENGINES = { g: 'google', yt: 'youtube', gh: 'github' };
  const DAYS_LONG = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const MONTHS_LONG = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october',
    'november', 'december'];
  const SEP = [' · ', 'frame'];
  const NONE = Object.freeze({ text: '', accept: '' });
  /** A regexp escape (backslash, u, four hex digits) for one code point, built so this file stays plain ASCII. */
  function esc(cp) {
    return '\\u' + cp.toString(16).padStart(4, '0');
  }
  // control, zero-width, bidi and other invisible format characters: never echoed from typed text or labels
  const INVISIBLE = new RegExp('[' + [[0x00, 0x1f], [0x7f, 0x9f], [0xad, 0xad], [0x61c, 0x61c], [0x180e, 0x180e], [0x200b, 0x200f],
    [0x2028, 0x202e], [0x2060, 0x206f], [0xfeff, 0xfeff], [0xfff9, 0xfffb]].map((r) => esc(r[0]) + (r[1] > r[0] ? '-' + esc(r[1]) : '')).join('') + ']', 'g');

  const clean = (s) => String(s == null ? '' : s).replace(INVISIBLE, '');
  const norm = (s) => clean(s).trim().toLowerCase().replace(/\s+/g, ' ');
  const message = (e) => String(e && e.message ? e.message : e).replace(/^error:\s*/i, '');
  const isThenable = (v) => !!v && (typeof v === 'object' || typeof v === 'function') && typeof v.then === 'function';

  function bytes(s) {
    let n = 0;
    for (const ch of s) {
      const cp = ch.codePointAt(0);
      n += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
    }
    return n;
  }

  function pad2(n) {
    return (n < 10 ? '0' : '') + n;
  }

  function clockText(h, m, clock24, ampm) {
    if (clock24) return pad2(h) + ':' + pad2(m);
    return (h % 12 || 12) + ':' + pad2(m) + (ampm ? (h < 12 ? ' am' : ' pm') : '');
  }

  function hoursText(hf, clock24) {
    let h = Math.floor(hf);
    let m = Math.round((hf - h) * 60);
    if (m === 60) {
      h++;
      m = 0;
    }
    return clockText(((h % 24) + 24) % 24, m, clock24, true);
  }

  /** A link's address without the scheme, a leading www. or the final slash (links print short; addresses print as
   * they open). */
  function shortUrl(url) {
    return String(url).replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/\/$/, '');
  }

  /** The clock status line as runs: '⌂ next alarm tomorrow 7:00 am · work' (null when there is none). */
  function statusRuns(st) {
    if (!st || !st.show || !Array.isArray(st.parts)) return null;
    const parts = st.parts[0] === 'pixelclock' ? st.parts.slice(1) : st.parts.slice();
    if (!parts.length) return null;
    const hot = st.kind === 'ringing' || st.tone === 'accent';
    const word = hot ? 'accent' : 'muted';
    const runs = [['⌂ ', hot ? 'accent' : 'frame']];
    parts.forEach((p, i) => {
      const s = clean(p);
      if (i) {
        runs.push(SEP, [s, word]);
        return;
      }
      const at = st.time ? s.lastIndexOf(st.time) : -1;
      if (at < 0) {
        runs.push([s, word]);
        return;
      }
      if (at > 0) runs.push([s.slice(0, at), word]);
      runs.push([st.time, hot ? 'accent' : 'text']);
      if (at + st.time.length < s.length) runs.push([s.slice(at + st.time.length), word]);
    });
    return runs;
  }

  // ------------------------------------------------------------------------------------------------ keys (pure)

  function keyAction(e, ctx) {
    if (!e || e.isComposing || e.keyCode === 229) return null;
    const c = ctx || {};
    const value = typeof c.value === 'string' ? c.value : '';
    if (e.key === 'Enter') {
      if (e.altKey || e.metaKey) return null;
      return { act: e.ctrlKey ? 'submit-new' : 'submit', prevent: false };
    }
    if (e.ctrlKey || e.altKey || e.metaKey) return null;
    switch (e.key) {
      case 'ArrowUp':
        return e.shiftKey ? null : { act: 'up', prevent: true };
      case 'ArrowDown':
        return e.shiftKey ? null : { act: 'down', prevent: true };
      case 'Tab':
        return e.shiftKey || !value.trim() ? null : { act: 'complete', prevent: true };
      case 'ArrowRight':
        return !e.shiftKey && c.atEnd && c.accept ? { act: 'accept', prevent: true } : null;
      case 'Escape':
      case 'Esc':
        return { act: value ? 'clear-line' : 'clear-screen', prevent: true };
      default:
        return null;
    }
  }

  function redirectKey(e, ctx) {
    if (!e || e.defaultPrevented || e.isComposing || e.keyCode === 229) return false;
    const altGr = typeof e.getModifierState === 'function' && !!e.getModifierState('AltGraph');
    if (((e.ctrlKey || e.altKey) && !altGr) || e.metaKey) return false;
    const c = ctx || {};
    if (c.inPrompt || c.editable || c.dialog) return false;
    if (e.key === 'Backspace') return true;
    if (typeof e.key !== 'string' || Array.from(e.key).length !== 1) return false;
    if (e.key === ' ' && c.activatable) return false;
    return true;
  }

  // ------------------------------------------------------------------------------------------------ the shell

  function createShell(app, opts) {
    const A = app && typeof app === 'object' ? app : {};
    const o = opts || {};
    const print = typeof o.print === 'function' ? o.print : () => {};
    const block = typeof o.block === 'function' ? o.block : () => null;
    const clearScreen = typeof o.clear === 'function' ? o.clear : () => {};
    const cols = typeof o.cols === 'function' ? o.cols : () => 44;
    const rows = typeof o.rows === 'function' ? o.rows : () => 99;
    const historyKey = typeof o.historyKey === 'string' && o.historyKey ? o.historyKey : HISTORY_KEY;
    const F = lib('format.js');
    const P = lib('parse.js');
    const C = lib('commands.js');
    const R = lib('router.js');
    const K = lib('complete.js');
    const H = lib('history.js');
    const Q = lib('calc.js');
    const U = T.url;
    if (!U || typeof U.toUrl !== 'function') throw new Error('terminal: term-url.js is not loaded');

    // -------------------------------------------------------------------------------------- output

    /** The printing helpers of one run, all into that run's own block. */
    function sink(place) {
      const emit = (kind, runs) => print({ kind, runs }, place);
      const out = (runs) => emit('out', runs);
      return {
        emit,
        out,
        say: (text, role) => String(text).split('\n').forEach((t) => out([[t, role || 'muted']])),
        fail: (text) => emit('error', [['! ', 'ring'], [String(text), 'muted']]),
        hang: (label, runs) => emit('hang', [[F.pad(label, 10), 'faint']].concat(runs)),
      };
    }

    // -------------------------------------------------------------------------------------- the app

    function has(name) {
      return typeof A[name] === 'function';
    }

    /** app[name](...args) as a Promise; a missing member rejects with a plain sentence. */
    function call(name, ...args) {
      if (!has(name)) return Promise.reject(new Error(`${name} is not available here`));
      try {
        return Promise.resolve(A[name](...args));
      } catch (e) {
        return Promise.reject(e);
      }
    }

    function view() {
      let v = null;
      try {
        v = has('view') ? A.view() : null;
      } catch (e) {
        v = null;
      }
      return v && typeof v === 'object' ? v : {};
    }

    function now(v) {
      const w = v || view();
      if (w.date instanceof Date && !isNaN(w.date)) return w.date;
      if (w.now instanceof Date && !isNaN(w.now)) return w.now;
      if (typeof w.now === 'number' && isFinite(w.now)) return new Date(w.now);
      return new Date();
    }

    /** { id, name, tag } of the scene in a result or a view ({ id, name, tag }, { theme, ... } or { scene: {...} }). */
    function sceneOf(x) {
      if (!x || typeof x !== 'object') return null;
      const s = x.scene && typeof x.scene === 'object' ? x.scene : x;
      const id = typeof s.id === 'string' ? s.id : typeof s.theme === 'string' ? s.theme : s.theme && s.theme.id;
      if (!id) return null;
      const known = themes().find((t) => t.id === id);
      const name = typeof s.name === 'string' && s.name.trim() ? norm(s.name) : known ? known.name : id;
      return { id, name, tag: typeof s.tag === 'string' ? s.tag : null };
    }

    function links() {
      let raw = null;
      try {
        raw = has('links') ? A.links() : null;
      } catch (e) {
        raw = null;
      }
      const list = [];
      for (const l of Array.isArray(raw) ? raw : []) {
        if (!l || typeof l !== 'object') continue;
        const name = Array.from(norm(l.name != null ? l.name : l.label)).slice(0, NAME_MAX).join('');
        const url = typeof l.url === 'string' ? l.url.trim() : '';
        if (!name && !url) continue;
        list.push({ name: name || shortUrl(url), url });
        if (list.length === MAX_LINKS) break;
      }
      return list;
    }

    let themeCache = null;
    function themes() {
      if (themeCache) return themeCache;
      let raw = null;
      try {
        raw = has('theme') ? A.theme('list') : null;
      } catch (e) {
        raw = null;
      }
      if (isThenable(raw)) {
        raw.then((v) => { if (Array.isArray(v) && v.length) themeCache = C.themeEntries(v); }, () => {});
        raw = null;
      }
      if (!Array.isArray(raw) || !raw.length) {
        const PC = root.PixelClock;
        raw = PC && Array.isArray(PC.themes) && PC.themes.length ? PC.themes.map((t) => ({ id: t.id, name: t.name, kind: t.kind })) : null;
      }
      const list = C.themeEntries(raw);
      if (raw) themeCache = list;
      return list;
    }

    // -------------------------------------------------------------------------------------- history

    let hist = [];
    const cursor = H.createCursor(hist);
    let chain = Promise.resolve();
    let loaded = null;
    let saving = []; // lines typed here whose write has not landed yet
    let later = null; // a list that came in while Up/Down was on an entry: taken once the cursor leaves the entries

    function storage() {
      const s = A.storage;
      return s && typeof s.get === 'function' && typeof s.set === 'function' ? s : null;
    }

    function stored() {
      const s = storage();
      if (!s) return Promise.resolve([]);
      return Promise.resolve().then(() => s.get(historyKey)).then((v) => H.normalizeHistory(v, HISTORY_KEEP), () => []);
    }

    /** The newest lines that fit HISTORY_BYTES as JSON (chrome.storage.sync allows 8 KB per item). */
    function fit(list) {
      let l = list.slice(-HISTORY_KEEP);
      while (l.length && bytes(JSON.stringify(l)) > HISTORY_BYTES) l = l.slice(1);
      return l;
    }

    function adopt(list) {
      if (cursor.browsing) {
        later = list;
        return;
      }
      later = null;
      hist = list.slice();
      cursor.reset(hist);
    }

    /** Takes a list that waited while Up/Down was on an entry. */
    function settle() {
      if (later && !cursor.browsing) adopt(later);
    }

    /** The stored history as another tab just wrote it (storage change events): it replaces this tab's list, but the
     * lines typed here whose write is still on its way stay, and Up/Down keeps the entry it shows. */
    function adoptStored(value) {
      let list = H.normalizeHistory(value, HISTORY_KEEP);
      for (const line of saving) if (!list.includes(line)) list = H.pushHistory(list, line, HISTORY_KEEP);
      adopt(list);
    }

    function load() {
      if (loaded) return loaded;
      loaded = stored().then((list) => {
        let merged = list;
        for (const line of hist) merged = H.pushHistory(merged, line, HISTORY_KEEP);
        adopt(merged);
      });
      return loaded;
    }

    function write(update) {
      const s = storage();
      if (!s) return Promise.resolve();
      chain = chain.then(() => stored()).then((list) => {
        const next = fit(update(list));
        adopt(next);
        return s.set(historyKey, next);
      }).catch(() => {});
      return chain;
    }

    function remember(line) {
      hist = H.pushHistory(hist, line, HISTORY_KEEP);
      cursor.reset(hist);
      later = null;
      const kept = H.normalizeHistory([line], 1)[0];
      if (kept) saving.push(kept);
      write((list) => H.pushHistory(list, line, HISTORY_KEEP));
      chain = chain.then(() => {
        const i = saving.indexOf(kept);
        if (i >= 0) saving.splice(i, 1);
      });
      return chain;
    }

    function forget() {
      hist = [];
      saving = [];
      later = null;
      cursor.reset(hist);
      return write(() => []);
    }

    // -------------------------------------------------------------------------------------- opening

    async function open(io, url, newTab, label) {
      if (!U.isWebUrl(url)) {
        io.fail('only http and https addresses open from here');
        return;
      }
      io.out(label.concat(newTab ? [[' in a new tab', 'muted']] : []));
      await call('openUrl', url, !!newTab);
    }

    async function openNamed(io, link, newTab) {
      await open(io, link.url, newTab, [['opening ', 'muted'], [link.name, 'text'], ['  ' + shortUrl(link.url), 'faint']]);
      return { kind: 'link', name: link.name, url: link.url, newTab: !!newTab };
    }

    async function search(io, text, newTab) {
      io.out([['searching for ', 'muted'], [clean(text), 'text']].concat(newTab ? [[' in a new tab', 'muted']] : []));
      await call('search', text, !!newTab);
      return { kind: 'search', text, newTab: !!newTab };
    }

    /** Not a built-in, link number or one-word link name: a longer link name, a unique prefix, an address or a search. */
    async function other(io, text, newTab, L) {
      const key = norm(text);
      const exact = L.find((l) => l.name === key);
      if (exact) return openNamed(io, exact, newTab);
      if (key && !/\s/.test(key)) {
        const hits = L.filter((l) => l.name.startsWith(key));
        if (hits.length === 1) return openNamed(io, hits[0], newTab);
      }
      const url = U.toUrl(text);
      if (url) {
        await open(io, url, newTab, [['opening ', 'muted'], [url, 'text']]);
        return { kind: 'url', url, newTab: !!newTab };
      }
      return search(io, text, newTab);
    }

    async function web(io, engine, r) {
      const url = R.searchUrl(engine, r.rest);
      const q = clean(r.rest).trim();
      const label = q ? [[`searching ${ENGINES[engine]} for `, 'muted'], [q, 'text']] : [['opening ', 'muted'], [ENGINES[engine], 'text']];
      await open(io, url, r.newTab, label);
    }

    // -------------------------------------------------------------------------------------- the commands

    /** A labelled list that wraps between its items (never a ' · ' at the start of a line), each line a hang line.
     * Like the links grid, it never leaves one item alone on the last line when the line before can spare one. */
    function hangList(io, label, items) {
      const room = Math.max(8, cols() - 12);
      const len = (item) => Array.from(item[0]).length;
      const width = (line) => line.reduce((w, item, i) => w + (i ? 3 : 0) + len(item), 0);
      const lines = [];
      let line = [];
      for (const item of items) {
        if (line.length && width(line) + 3 + len(item) > room) {
          lines.push(line);
          line = [];
        }
        line.push(item);
      }
      lines.push(line);
      const last = lines[lines.length - 1];
      const prev = lines[lines.length - 2];
      if (prev && last.length === 1 && prev.length >= 3 && len(prev[prev.length - 1]) + 3 + len(last[0]) <= room) last.unshift(prev.pop());
      lines.forEach((l, i) => io.hang(i ? '' : label, l.flatMap((item, j) => (j ? [SEP, item] : [item]))));
    }

    function listThemes(io) {
      const all = themes();
      const cur = sceneOf(view());
      const items = (list) => list.map((t) => [t.id, cur && t.id === cur.id ? 'text bold' : 'muted']);
      hangList(io, 'seasons', items(all.filter((t) => t.kind === 'season')));
      hangList(io, 'holidays', items(all.filter((t) => t.kind !== 'season')));
      if (cur) io.hang('now', [[cur.name, 'text']].concat(cur.tag ? [SEP, [cur.tag, 'muted']] : []));
    }

    const autoLine = (cur) => [['theme ', 'muted'], [cur ? cur.name : 'auto', 'text']].concat(cur ? [SEP, ['auto', 'muted']] : [])
      .concat([[', it follows the date', 'muted']]);

    let helpNext = null; // the first help row 'help more' shows next (null: the table was shown to its end)

    /** The help rows from `from` on that fit between the echo and the prompt: { n, more }. All that are left, or as
     * many as leave a row for the 'help more' line. A terminal of three rows has room for one row only: it shows that
     * row and no 'help more' line, so the echo stays in view ('help more' still shows the next row). */
    function helpFits(from) {
      const room = Math.max(1, Math.floor(rows()) - 2);
      const left = C.HELP_ROWS.length - from;
      if (left <= room) return { n: left, more: false };
      return room >= 2 ? { n: room - 1, more: true } : { n: 1, more: false };
    }

    /** One page of the help table from `from`, then a 'help more' row when rows are left and it fits; returns where
     * the next page starts, or null at the end. */
    function helpPage(io, from) {
      const fit = helpFits(from);
      const table = C.helpRows(links().length); // the open row names the links there are, as the links command does
      for (const row of table.slice(from, from + fit.n)) io.hang(row[0], row[1].map((run) => run.slice()));
      if (from + fit.n >= C.HELP_ROWS.length) return null;
      if (fit.more) io.hang('more', [['help more', 'text']]);
      return from + fit.n;
    }

    const handlers = {
      help(r, io) {
        const arg = (r.args[0] || '').trim().toLowerCase();
        if (arg === 'more' && r.args.length === 1) {
          // the page after the last one shown; without one, the page after the first (the whole table when it fits)
          let from = helpNext !== null ? helpNext : helpFits(0).n;
          if (from >= C.HELP_ROWS.length) from = 0;
          helpNext = helpPage(io, from);
          return;
        }
        if (arg) {
          const L = links();
          C.helpLines(arg, { aliases: L, themes: themes().map((t) => t.id) }).forEach((t, i) => io.say(t, i ? 'muted' : 'text'));
          if (!C.getBuiltin(arg) && !L.some((l) => l.name === arg)) {
            const near = C.visibleCommandNames().find((n) => C.nearMiss(arg, n));
            if (near) io.say(`did you mean help ${near}?`, 'faint');
          }
          return;
        }
        helpNext = helpPage(io, 0);
      },
      clear() {
        clearScreen();
      },
      history(r, io) {
        const a = (r.args[0] || '').toLowerCase();
        if (a === 'clear') {
          forget();
          io.say('history cleared');
          return;
        }
        if (r.args.length) {
          io.fail(`history: unknown action "${clean(r.args.join(' '))}"; try history or history clear`);
          return;
        }
        H.historyLines(hist).forEach((t) => io.say(t));
      },
      g: (r, io) => web(io, 'g', r),
      yt: (r, io) => web(io, 'yt', r),
      gh: (r, io) => web(io, 'gh', r),
      links(r, io) {
        const L = links();
        if (!L.length) {
          io.say('no links yet · add them in settings');
          return;
        }
        const w = Math.max(...L.map((l) => l.name.length));
        L.forEach((l, i) => io.out([['[', 'faint'], [String(i + 1), 'accent'], ['] ', 'faint'], [F.pad(l.name, w + 2), 'text'], [shortUrl(l.url), 'muted']]));
        // the numbers there are, as the column's hint says them ('1-3', or '1' alone)
        const range = L.length > 1 ? '1-' + L.length : '1';
        io.out([[range + ' or a name + enter', 'faint'], SEP, ['ctrl+enter new tab', 'faint']]);
      },
      async theme(r, io) {
        const arg = norm(r.args.join(' '));
        if (!arg || arg === 'list') {
          listThemes(io);
          return;
        }
        if (arg === 'auto') {
          const p = call('theme', 'auto');
          const at = sceneOf(view());
          if (at && at.tag === 'auto') {
            io.out(autoLine(at)); // the app switched at once: say so now, its promise only reports a failure
            await p;
            return;
          }
          const res = await p;
          io.out(autoLine(sceneOf(res) || sceneOf(view())));
          return;
        }
        const all = themes();
        const id = C.resolveTheme(arg, all);
        if (!id) {
          const s = C.suggestTheme(arg, all);
          io.fail(`no scene "${clean(arg)}"; ` + (s ? `did you mean ${s}?` : 'theme list shows them'));
          return;
        }
        const cur = sceneOf({ id });
        io.out([['theme ', 'muted'], [cur.name, 'text'], SEP, ['pinned', 'muted']]);
        io.say('theme auto follows the date again', 'faint');
        await call('theme', id);
      },
      async surprise(r, io) {
        const res = await call('surprise');
        const cur = sceneOf(res) || sceneOf(view());
        io.out([['surprise: ', 'muted'], [cur ? cur.name : 'a new scene', 'text'], [' (this tab only)', 'muted']]);
      },
      async shake(r, io) {
        const p = call('shake');
        const cur = sceneOf(view());
        io.say(`${cur ? cur.name : 'the scene'} shakes`);
        await p;
      },
      async clock(r, io) {
        const a = (r.args[0] || '').toLowerCase().replace(/h$/, '');
        if (!a) {
          io.say(`clock: ${view().clock24 ? '24' : '12'} hour (clock 12 or clock 24)`);
          return;
        }
        if (a !== '12' && a !== '24') {
          io.fail(`clock: "${clean(r.args[0])}" is not 12 or 24`);
          return;
        }
        io.say(`clock: ${a} hour`);
        await call('setClock24', a === '24');
      },
      weather(r, io) {
        const v = view();
        // art lines sit two cells in and never wrap: the block gets the rest of the terminal's width
        const width = Math.max(WEATHER_MIN_W, cols() - 2);
        const K = PCD.console;
        if (K && K.parts && typeof K.parts.weatherBlock === 'function' && typeof K.view === 'function') {
          // the column's own block (PCD.console.parts.weatherBlock): the 11 x 4 icon, then '46°F drizzle · berlin'
          // ... 'weather: open-meteo.com' with the credit linked; compact (two lines) where the column would be compact
          const V = K.view(v, 'newtab');
          const fits = typeof K.parts.plan === 'function' && typeof K.partsOf === 'function'
            ? K.parts.plan(99, width, 'newtab', K.partsOf(V, 'newtab')).p.weather : 'full'; // the column's rule at this width
          const lines = V.weather ? K.parts.weatherBlock(V, { width, link: true, compact: fits === 'compact' }) : [];
          if (lines.length) lines.forEach((line) => io.emit('art', line));
          else io.say(NO_WEATHER);
          return;
        }
        // a terminal mounted without the console (js/pcd-console.js): the column's four lines as plain text, no icon
        const w = v.weather && typeof v.weather === 'object' ? v.weather : null;
        const data = w && w.data && typeof w.data === 'object' ? w.data : w && typeof w.temp === 'number' ? w : null;
        if (!data || typeof data.temp !== 'number' || !isFinite(data.temp)) {
          io.say(NO_WEATHER);
          return;
        }
        const fahrenheit = String(w.units || 'F').toUpperCase() !== 'C';
        const deg = (x) => (typeof x === 'number' && isFinite(x) ? String(Math.round(x) || 0) : '-');
        const cond = norm(data.description || data.kind || '');
        const city = norm(String(w.city || '').split(',')[0]);
        io.out([[deg(data.temp) + (fahrenheit ? '°F' : '°C'), 'text bold']].concat(cond ? [[' ' + cond, 'text']] : [], city ? [SEP, [city, 'muted']] : []));
        io.out([['feels ' + deg(data.feels) + '°', 'muted'], SEP, ['wind ' + deg(data.wind) + (fahrenheit ? ' mph' : ' km/h'), 'muted']]);
        io.out([['hi ' + deg(data.high) + '°', 'muted'], SEP, ['lo ' + deg(data.low) + '°', 'muted']]);
        io.out([['weather: ', 'faint'], ['open-meteo.com', 'faint', 'https://open-meteo.com/']]);
      },
      date(r, io) {
        const v = view();
        const d = now(v);
        const c24 = !!v.clock24;
        const time = clockText(d.getHours(), d.getMinutes(), c24, true);
        const sun = v.sun && typeof v.sun.rise === 'number' && typeof v.sun.set === 'number' ? v.sun : null;
        const phase = typeof v.phase === 'string' && v.phase ? v.phase : null;
        const head = [[`${DAYS_LONG[d.getDay()]} ${MONTHS_LONG[d.getMonth()]} ${d.getDate()} ${d.getFullYear()}`, 'text'], SEP, [time, 'text']];
        io.out(sun || !phase ? head : head.concat([SEP, [phase, 'muted']]));
        if (sun) {
          io.out([['sunrise ', 'muted'], [hoursText(sun.rise, c24), 'text'], SEP, ['sunset ', 'muted'], [hoursText(sun.set, c24), 'text']]
            .concat(phase ? [SEP, [phase, 'muted']] : []));
        }
        const start = new Date(d.getFullYear(), 0, 1);
        const day = Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate()) - start) / 86400000) + 1;
        io.say(`day ${day} of ${new Date(d.getFullYear(), 1, 29).getMonth() === 1 ? 366 : 365}`);
      },
      alarm(r, io) {
        const runs = statusRuns(view().status);
        if (runs) io.out(runs);
        else io.say('no clock here · it shows when pixelclock.local answers on this network');
      },
      calc(r, io) {
        const res = Q.calc(r.rest);
        if (res.ok) io.out([['= ', 'muted'], [res.text, 'text bold']]);
        else io.fail(`calc: ${res.error}`);
      },
      async settings(r, io) {
        io.say('opening settings · esc closes them');
        await call('openSettings');
      },
      hello(r, io) {
        io.say('hello. the terminal is listening.', 'text');
      },
      sudo(r, io) {
        io.say('nice try. root is not available in a new tab.', 'text');
        io.say('(nothing happened, and nothing was logged)', 'faint');
      },
      exit(r, io) {
        io.say('there is no exit. there is only the next tab.', 'text');
        io.say('(ctrl+w closes this one, if you must)', 'faint');
      },
      rm(r, io) {
        if (/^-[a-z]*r[a-z]*f|^-[a-z]*f[a-z]*r/i.test(r.args[0] || '') && (r.args[1] || '') === '/') {
          io.say('removing / ...');
          io.say('just kidding. a new tab cannot touch your files.', 'text');
        } else {
          io.say('rm: there are no files here');
        }
      },
    };

    // -------------------------------------------------------------------------------------- run

    async function run(raw, ropts) {
      const line = raw == null ? '' : String(raw);
      const io = sink(block());
      io.emit('cmd', [['› ', 'frame'], [clean(line), 'text']]);
      if (!line.trim()) return { kind: 'empty', newTab: false };
      remember(line);
      const L = links();
      const r = R.route(line, { aliases: L, links: L, themes: C.themeWords(themes()), newTab: !!(ropts && ropts.newTab) });
      try {
        if (r.kind === 'builtin') {
          const h = handlers[r.name];
          if (h) await h(r, io);
          else io.fail(`${r.name}: not in this terminal`);
          return { kind: 'builtin', name: r.name, newTab: r.newTab };
        }
        if (r.kind === 'link' || r.kind === 'alias') {
          if (!r.url) {
            const err = r.kind === 'link' && !L.length ? `no link ${r.index}: there are no links yet (add them in settings)` : String(r.error || 'that link cannot be opened').replace(/^alias /, 'link ');
            io.fail(err);
            return { kind: 'link', name: r.name, url: null, newTab: r.newTab };
          }
          return await openNamed(io, { name: r.name || shortUrl(r.url), url: r.url }, r.newTab);
        }
        return await other(io, P.parseInput(line).text, r.newTab, L);
      } catch (e) {
        io.fail(`that did not work: ${message(e)}`);
        return { kind: 'error', error: message(e), newTab: !!r.newTab };
      }
    }

    // -------------------------------------------------------------------------------------- typing help

    /** What Tab offers after 'theme ': every id, then each scene name that does not start with its id ('snowy hills',
     * 'haunted hill', 'fourth of july'). A name that spells its id out ('spring meadow', "new year's eve", "st.
     * patrick's day") is left out: the id already completes there and opens the same scene. */
    function themeWords() {
      const all = themes();
      const letters = (s) => s.replace(/[^a-z0-9]/g, '');
      return all.map((t) => t.id).concat(all.filter((t) => !letters(t.name).startsWith(t.id)).map((t) => t.name));
    }

    function ghost(value) {
      const v = value == null ? '' : String(value);
      if (!v.trim() || /\s$/.test(v)) return NONE;
      const L = links();
      const m = /^\s*([1-9])(\s+&)?$/.exec(v);
      if (m) {
        const l = L[Number(m[1]) - 1];
        return l ? { text: '  → ' + l.name + (m[2] ? ', new tab' : ''), accept: '' } : NONE;
      }
      const c = K.complete(v, { aliases: L, themes: themeWords() });
      let rest = '';
      if (c.matches.length === 1) rest = c.matches[0].slice(c.word.length);
      else if (c.matches.length > 1 && c.common.length > c.word.length) rest = c.common.slice(c.word.length);
      return rest ? { text: rest, accept: rest } : NONE;
    }

    function complete(value) {
      const c = K.complete(value == null ? '' : String(value), { aliases: links(), themes: themeWords() });
      return { line: c.line, matches: c.matches.slice(), word: c.word };
    }

    return {
      run,
      ghost,
      complete,
      up: (current) => {
        settle();
        return cursor.up(current);
      },
      down: (current) => cursor.down(current),
      resetCursor: () => {
        cursor.reset();
        settle();
      },
      history: () => hist.slice(),
      load,
      adopt: adoptStored,
      links,
      themes,
      view,
      flush: () => chain,
    };
  }

  T.lib = lib;
  T.createShell = createShell;
  T.keyAction = keyAction;
  T.redirectKey = redirectKey;
  T.statusRuns = statusRuns;
  T.HISTORY_KEY = HISTORY_KEY;
  T.HISTORY_KEEP = HISTORY_KEEP;
  T.HISTORY_BYTES = HISTORY_BYTES;
  return T;
});
