/* PixelClock Desktop, new tab terminal: the commands table and the rules for when a line is a built-in.
 * Pure: no DOM, no clock, no chrome APIs.
 *
 * Classic script. It registers the module 'commands.js' in PCD.termDefs: the module that the copied router.js,
 * complete.js and aliases.js import (src/newtab/js/term/lib/, byte-identical copies of the terminal libraries from an
 * earlier terminal project), with the same contract as the table they were written against; it adds settings, the
 * theme name rules and a few small easter eggs. PCD.term.lib('commands.js') returns it.
 *
 *   BUILTINS     [{ name, aliases[], group, usage, help, details[], args, bare, freeText, value, subcommands[], egg,
 *                hidden }]; args: 'none' (the bare word only, so "hello world" is a search), 'text' (anything may
 *                follow), 'sub' (bare, a subcommand, or a value: 'theme' names, 'command' names, 'flags' (-rf))
 *   GROUPS       [{ id, label }]                           THEME_NAMES  the clock's theme ids in menu order
 *   THEME_ALIASES  everyday words for scenes ('fall' -> autumn, 'xmas' -> christmas, ...)
 *   HELP_ROWS    the help screen: [[label, runs]] with runs [text, role] (roles: text, muted, faint, frame, ...), its
 *                open row as with nine links; helpRows(count) the same screen for count links: the open row names
 *                '1-3', or '1' with one link, as the links command does, and with no links only 'a url'
 *   getBuiltin(name), isBuiltinName(name), findSub(def, word), themeList(themes), aliasNameList(aliases)
 *   acceptsArgs(def, args, { themes, aliases })   true when the tokens fit the command; 'theme' joins its arguments,
 *                so "theme snowy hills" (a scene's name) is the command while "theme park" is a search
 *   nearMiss(word, target)   a strict prefix of 2+ letters, or one edit in a word of 4+ letters
 *   looksLikeAttempt(def, args, { themes })   a near miss ("theme wintr", "clock 13", "help theem") still goes to the
 *                command, which explains the mistake, instead of leaving the page
 *   visibleCommandNames(), helpLines(name?, { aliases, themes })
 *   themeEntries(list)       [{ id, name, kind }] from app.theme('list') entries, theme ids or nothing (the 13 ids)
 *   themeWords(list)         ids, scene names and THEME_ALIASES words, lower case (route()'s themes option)
 *   resolveTheme(text, list) the theme id for an id, a scene name, an alias word or a unique 3+ letter prefix; else null
 *   suggestTheme(text, list) the id one typo away (nearMiss on ids and on the first word of names); else null
 */
(function (root) {
  'use strict';
  var PCD = root.PCD || (root.PCD = {});
  var defs = PCD.termDefs || (PCD.termDefs = {});
  defs['commands.js'] = function (require, exports) {
    'use strict';
    const { pad, safeText } = require('./format.js');

    function deepFreeze(o) {
      if (o && typeof o === 'object' && !Object.isFrozen(o)) {
        Object.freeze(o);
        for (const v of Object.values(o)) deepFreeze(v);
      }
      return o;
    }

    const THEME_NAMES = deepFreeze([
      'winter', 'spring', 'summer', 'autumn', 'newyear', 'lunarnewyear', 'valentines', 'stpatricks', 'easter',
      'july4', 'halloween', 'thanksgiving', 'christmas',
    ]);
    const SEASONS = deepFreeze(['winter', 'spring', 'summer', 'autumn']);

    /** Everyday words for the scenes (the scene names themselves come from the engine: "snowy hills", ...). */
    const THEME_ALIASES = deepFreeze({
      fall: 'autumn', forest: 'autumn', snow: 'winter', snowy: 'winter', meadow: 'spring', beach: 'summer',
      xmas: 'christmas', cabin: 'christmas', nye: 'newyear', 'new year': 'newyear', lunar: 'lunarnewyear',
      valentine: 'valentines', 'st patricks': 'stpatricks', patricks: 'stpatricks', fourth: 'july4', 'july 4': 'july4',
      haunted: 'halloween', spooky: 'halloween', harvest: 'thanksgiving',
    });

    const GROUPS = deepFreeze([
      { id: 'open', label: 'open' },
      { id: 'scene', label: 'scene' },
      { id: 'info', label: 'info' },
      { id: 'setup', label: 'setup' },
      { id: 'core', label: 'terminal' },
      { id: 'fun', label: 'fun' },
    ]);

    function sub(name, usage, help, extra = {}) {
      return { name, aliases: [], usage, help, freeText: false, values: null, ...extra };
    }

    function cmd(name, group, args, usage, help, extra = {}) {
      return {
        name, aliases: [], group, usage, help, details: [], args, bare: true, freeText: args === 'text', value: null,
        subcommands: [], egg: group === 'fun', hidden: group === 'fun', ...extra,
      };
    }

    const BUILTINS = deepFreeze([
      cmd('g', 'open', 'text', 'g <search>', 'search google (alone: open google)'),
      cmd('yt', 'open', 'text', 'yt [search]', 'search youtube (alone: open youtube)'),
      cmd('gh', 'open', 'text', 'gh [search]', 'search github (alone: open github)'),
      cmd('links', 'open', 'none', 'links', 'the numbered links and where they go', {
        details: ['type its number + enter, a link name or the start of one', 'ctrl+enter or a trailing " &" opens a new tab'],
      }),

      cmd('theme', 'scene', 'sub', 'theme [<name>|list|auto]', 'switch the scene; auto follows the date', {
        value: 'theme',
        details: ['a name from theme list, or a scene name like "snowy hills"'],
        subcommands: [sub('list', 'theme list', 'show the scenes'), sub('auto', 'theme auto', 'follow the date again')],
      }),
      cmd('surprise', 'scene', 'none', 'surprise', 'a random scene, for this tab only'),
      cmd('shake', 'scene', 'none', 'shake', "the scene's shake (clicking the scene does it too)"),

      cmd('weather', 'info', 'none', 'weather', 'the weather where you are', {
        details: ['weather data by open-meteo.com; the city is in settings'],
      }),
      cmd('date', 'info', 'none', 'date', 'the date, the time and the sun'),
      cmd('alarm', 'info', 'none', 'alarm', "your pixelclock's next alarm", {
        details: ['it shows when pixelclock.local answers on this network'],
      }),
      cmd('calc', 'info', 'text', 'calc <expression>', 'calculator, e.g. calc 2^10 or = sqrt(2)*pi', {
        aliases: ['='],
        details: [
          'operators: + - * / % (remainder) ^ (power) and ( )',
          'functions: sqrt sin cos tan log ln abs round floor ceil',
          'constants: pi e   (angles in radians, log is base 10)',
        ],
      }),

      cmd('clock', 'setup', 'sub', 'clock 12|24', '12 or 24 hour clock', {
        subcommands: [
          sub('12', 'clock 12', '12 hour clock (8:40 pm)', { aliases: ['12h'] }),
          sub('24', 'clock 24', '24 hour clock (20:40)', { aliases: ['24h'] }),
        ],
      }),
      cmd('settings', 'setup', 'none', 'settings', 'open the settings sheet (esc closes it)'),

      cmd('help', 'core', 'sub', 'help [command]', 'list the commands, or explain one', {
        value: 'command',
        subcommands: [sub('more', 'help more', 'the rest of the list')],
      }),
      cmd('clear', 'core', 'none', 'clear', 'clear the terminal (esc on an empty line does too)', { aliases: ['cls'] }),
      cmd('history', 'core', 'sub', 'history [clear]', 'recent commands; up and down walk through them', {
        subcommands: [sub('clear', 'history clear', 'forget them')],
      }),

      // small easter eggs: hidden from help and completion, a line of text each
      cmd('hello', 'fun', 'none', 'hello', 'say hi'),
      cmd('sudo', 'fun', 'text', 'sudo <anything>', 'ask for more power'),
      cmd('exit', 'fun', 'none', 'exit', 'try to leave'),
      cmd('rm', 'fun', 'sub', 'rm -rf /', 'please do not', { value: 'flags' }),
    ]);

    const SEP = [' · ', 'frame'];

    /** The open row for count links: their numbers as the links command and the column's hint name them ('1-3', or
     * '1' with one link), a link name and a url; with no links only what still works, a url. */
    function openRuns(count) {
      const n = Math.max(0, Math.min(9, Math.floor(Number(count)) || 0));
      const url = ['a url', 'text'];
      return n ? [[n > 1 ? '1-' + n : '1', 'text'], SEP, ['a link name', 'text'], SEP, url] : [url];
    }

    /** The help screen (one short row per group, so it reads as a table in a 44-cell column), its open row as with
     * nine links. helpRows(count) is the same screen for the links there are. */
    const HELP_ROWS = deepFreeze([
      ['open', openRuns(9)],
      ['search', [['g', 'text'], SEP, ['yt', 'text'], SEP, ['gh', 'text'], [' <text>, or any text', 'muted']]],
      ['scene', [['theme', 'text'], SEP, ['surprise', 'text'], SEP, ['shake', 'text']]],
      ['info', [['weather', 'text'], SEP, ['date', 'text'], SEP, ['alarm', 'text'], SEP, ['links', 'text']]],
      ['math', [['calc 2^10', 'text'], [' or ', 'muted'], ['= 2^10', 'text']]],
      ['setup', [['settings', 'text'], SEP, ['clock 12|24', 'text']]],
      ['terminal', [['clear', 'text'], SEP, ['history', 'text'], SEP, ['help', 'text'], [' <command>', 'muted']]],
      ['keys', [['↑ ↓', 'text'], [' history', 'muted'], SEP, ['tab', 'text'], [' completes', 'muted']]],
      ['', [['esc', 'text'], [' clears', 'muted'], SEP, ['ctrl+enter', 'text'], [' new tab', 'muted']]],
    ]);

    /** The help screen for count links (0 to 9): HELP_ROWS with its open row for them. */
    function helpRows(count) {
      return deepFreeze([['open', openRuns(count)]].concat(HELP_ROWS.slice(1)));
    }

    const BY_NAME = new Map();
    for (const def of BUILTINS) {
      BY_NAME.set(def.name, def);
      for (const a of def.aliases) BY_NAME.set(a, def);
    }
    const BUILTIN_NAMES = deepFreeze([...BY_NAME.keys()]);

    function getBuiltin(name) {
      if (typeof name !== 'string') return null;
      return BY_NAME.get(name.trim().toLowerCase()) || null;
    }

    function isBuiltinName(name) {
      return getBuiltin(name) !== null;
    }

    function findSub(def, word) {
      if (!def || typeof word !== 'string') return null;
      const w = word.trim().toLowerCase();
      return def.subcommands.find((s) => s.name === w || s.aliases.includes(w)) || null;
    }

    function themeList(themes) {
      let names = null;
      if (Array.isArray(themes)) names = themes.map((t) => (t && typeof t === 'object' ? t.id : t));
      else if (themes && typeof themes === 'object') names = Object.keys(themes);
      const clean = (names || []).filter((n) => typeof n === 'string' && n.trim()).map((n) => n.trim().toLowerCase());
      return clean.length ? [...new Set(clean)] : [...THEME_NAMES];
    }

    function aliasNameList(aliases) {
      let names = [];
      if (Array.isArray(aliases)) names = aliases.map((a) => (typeof a === 'string' ? a : a && a.name));
      else if (aliases && typeof aliases === 'object') names = Object.keys(aliases);
      return [...new Set(names.filter((n) => typeof n === 'string' && n).map((n) => n.toLowerCase()))];
    }

    function acceptsArgs(def, args, opts = {}) {
      if (!def) return false;
      const list = Array.isArray(args) ? args.map((a) => String(a)) : [];
      switch (def.args) {
        case 'none':
          return list.length === 0;
        case 'text':
          return true;
        case 'sub': {
          if (list.length === 0) return def.bare !== false;
          if (list.length === 1 && findSub(def, list[0])) return true;
          const first = list[0].toLowerCase();
          switch (def.value) {
            case 'theme':
              return themeList(opts.themes).includes(list.join(' ').toLowerCase());
            case 'command':
              return list.length === 1 && (isBuiltinName(first) || aliasNameList(opts.aliases).includes(first));
            case 'flags':
              return first.startsWith('-');
            default:
              return false;
          }
        }
        default:
          return false;
      }
    }

    /** Optimal string alignment distance (insert, delete, change, swap neighbours), capped at 2. */
    function typoDistance(a, b) {
      if (Math.abs(a.length - b.length) > 1) return 2;
      const d = [];
      for (let i = 0; i <= a.length; i++) {
        d.push([i]);
        for (let j = 1; j <= b.length; j++) {
          if (i === 0) {
            d[i].push(j);
            continue;
          }
          const cost = a[i - 1] === b[j - 1] ? 0 : 1;
          let v = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
          if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, d[i - 2][j - 2] + 1);
          d[i].push(v);
        }
      }
      return Math.min(2, d[a.length][b.length]);
    }

    /** One typo away: a strict prefix of 2+ letters, or one edit in a word of 4+ letters. */
    function nearMiss(word, target) {
      if (word === target) return true;
      if (word.length >= 2 && word.length < target.length && target.startsWith(word)) return true;
      return target.length >= 4 && typoDistance(word, target) === 1;
    }

    function looksLikeAttempt(def, args, opts = {}) {
      if (!def || def.args !== 'sub') return false;
      const list = Array.isArray(args) ? args.map((a) => String(a)) : [];
      if (!list.length) return false;
      const first = list[0].toLowerCase();
      if (def.name === 'clock' && /^[-+.:\d]/.test(first)) return true;
      const words = [];
      for (const s of def.subcommands) for (const w of [s.name, ...s.aliases]) words.push({ word: w, max: 1 });
      if (def.value === 'theme') {
        for (const n of themeList(opts.themes)) words.push({ word: n.split(' ')[0], max: n.split(' ').length });
      }
      if (def.value === 'command') for (const n of visibleCommandNames()) words.push({ word: n, max: 1 });
      return words.some((w) => list.length <= w.max && nearMiss(first, w.word));
    }

    function visibleCommandNames() {
      const out = [];
      for (const def of BUILTINS) {
        if (def.hidden) continue;
        out.push(def.name);
        for (const a of def.aliases) if (a !== '=') out.push(a);
      }
      return out.sort();
    }

    function helpLines(name, opts = {}) {
      const wanted = typeof name === 'string' ? name.trim().toLowerCase() : '';
      if (!wanted) {
        const lines = [];
        for (const g of GROUPS) {
          const names = BUILTINS.filter((d) => d.group === g.id && !d.hidden).map((d) => d.name);
          if (names.length) lines.push(`${pad(g.label, 9)} ${names.join(' ')}`);
        }
        return lines;
      }
      const def = getBuiltin(wanted);
      if (def) {
        const lines = [def.usage, `  ${def.help}`];
        for (const d of def.details) lines.push(`  ${d}`);
        const width = Math.max(0, ...def.subcommands.map((s) => s.usage.length));
        for (const s of def.subcommands) lines.push(`  ${pad(s.usage, width)}   ${s.help}`);
        if (def.aliases.length) lines.push(`  also: ${def.aliases.join(' ')}`);
        if (wanted !== def.name) lines.push(`  (${wanted} is another name for ${def.name})`);
        return lines;
      }
      const list = Array.isArray(opts.aliases) ? opts.aliases : [];
      const hit = list.find((a) => a && typeof a.name === 'string' && a.name.toLowerCase() === wanted);
      if (hit) return [`${hit.name}: a link to ${safeText(hit.url, 200)}`];
      return [`no command called "${safeText(wanted, 30)}"; type help to list them`];
    }

    // ------------------------------------------------------------------------------------------ scene names

    const norm = (s) => String(s == null ? '' : s).trim().toLowerCase().replace(/\s+/g, ' ');

    /** [{ id, name, kind }]: entries ({ id, name?, kind? }) or ids; the 13 clock themes when there are none. */
    function themeEntries(list) {
      const out = [];
      const seen = new Set();
      for (const t of Array.isArray(list) ? list : []) {
        const id = norm(t && typeof t === 'object' ? t.id : t);
        if (!id || id === 'auto' || seen.has(id)) continue;
        seen.add(id);
        const name = t && typeof t === 'object' && typeof t.name === 'string' && t.name.trim() ? norm(t.name) : id;
        const kind = t && typeof t === 'object' && typeof t.kind === 'string' ? t.kind : SEASONS.includes(id) ? 'season' : 'holiday';
        out.push({ id, name, kind: kind === 'season' ? 'season' : 'holiday' });
      }
      if (out.length) return out;
      return THEME_NAMES.map((id) => ({ id, name: id, kind: SEASONS.includes(id) ? 'season' : 'holiday' }));
    }

    function themeWords(list) {
      const words = [];
      for (const t of themeEntries(list)) words.push(t.id, t.name);
      return [...new Set(words.concat(Object.keys(THEME_ALIASES)))];
    }

    function resolveTheme(text, list) {
      const s = norm(text);
      if (!s) return null;
      const all = themeEntries(list);
      for (const t of all) if (t.id === s || t.name === s) return t.id;
      const a = THEME_ALIASES[s];
      if (a && all.some((t) => t.id === a)) return a;
      if (s.length >= 3) {
        const pre = all.filter((t) => t.id.startsWith(s) || t.name.startsWith(s));
        if (pre.length === 1) return pre[0].id;
      }
      return null;
    }

    function suggestTheme(text, list) {
      const s = norm(text);
      if (!s) return null;
      const hit = themeEntries(list).find((t) => nearMiss(s, t.id) || nearMiss(s, t.name.split(' ')[0]));
      return hit ? hit.id : null;
    }

    Object.assign(exports, {
      THEME_NAMES, SEASONS, THEME_ALIASES, GROUPS, BUILTINS, BUILTIN_NAMES, HELP_ROWS, helpRows, getBuiltin, isBuiltinName,
      findSub, themeList, aliasNameList, acceptsArgs, nearMiss, looksLikeAttempt, visibleCommandNames, helpLines,
      themeEntries, themeWords, resolveTheme, suggestTheme,
    });
  };
}(typeof globalThis !== 'undefined' ? globalThis : this));
