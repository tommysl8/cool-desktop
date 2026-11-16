/* PixelClock Desktop, new tab: the settings sheet. Classic script, UMD, global PCD.panel (module.exports in Node).
 * Needs PCD.settings (js/ntp-settings.js) and a PCD.store (js/ntp-store.js) when called; nothing runs at load time.
 * No network, no timers of its own.
 *
 * Every new tab setting of PCD.settings.KEYS gets a real form control (schema-driven: a new key shows up with the
 * control of its kind), in a modal <dialog> with no veil, so the scene stays visible and a theme change shows live.
 * Changes go through the store at once (store.set: validated, debounced 1 s, chrome.storage.sync; localStorage in
 * preview) and are flushed when the sheet closes or the page hides. Other tabs' changes (chrome.storage.onChanged, or
 * the storage event in preview) arrive through store.subscribe and update the controls live, except a text field
 * being typed in or a shortcut list being edited. "top sites" asks for the optional topSites permission from the click
 * itself; refused -> it stays on "custom".
 * Keys: Tab / Shift+Tab or Up / Down move between rows; Left / Right change a radio; Space toggles a checkbox; Enter
 * presses a button; Esc or [ done ] closes and gives the focus back to the opener. No key leaves the sheet (keydown
 * never bubbles out), so the page's keys (the terminal's type-anywhere) stay quiet while it is open.
 *
 * Page wiring: ntp-app.js mounts it and places it over the console column with panel.setRect({ x, y, w, h },
 * { fontPx, cell: { w, h, ls } }) (CSS px, the console's one text size and its cell); without a rect the sheet is
 * centred, 48 cells wide, in the page's own font. panel.note('city', 'city not found', 'error') shows a line under a
 * setting (e.g. from the weather client).
 *
 * The sheet sits on the character grid: its size is whole cells, and its box lines are text in a
 * <pre> (no CSS boxes), with the title and "esc" on the top border and the storage line on the bottom one:
 *   ╭─ settings ─────────────────── esc ─╮
 *   │                                    │   a blank row when the sheet has rows to spare
 *   │ › clock        (•) 12 h  ( ) 24 h  │   the rows, 2 cells in; a blank row between them when there is room
 *   │                          [ done ]  │
 *   ╰─────────────── synced with chrome ─╯
 * The words on the borders are real elements placed on the border rows (the title is the dialog's name, "esc" is a
 * button, the storage line is a status); P.frame() gives the lines with blanks where they go.
 *
 * Seam for the page (css/ntp-panel.css):
 *   <dialog class="pcd-panel" role="dialog" data-area="sync|preview|memory" data-sync="saved|saving|error" [data-open]
 *           [data-placed] [data-tight]>
 *     <pre class="pcd-panel__frame" aria-hidden="true">                 the box lines, drawn as text
 *     <header class="pcd-panel__head"><h2 class="pcd-panel__title">settings</h2>
 *       <button class="pcd-panel__close" data-action="close">esc</button></header>   both on the top border
 *     <p class="pcd-panel__sync" role="status">synced with chrome</p>  on the bottom border
 *     <form class="pcd-panel__box">
 *       <div class="pcd-panel__rows">
 *         <div class="pcd-panel__row" data-key="clock24" data-kind="radio|check|text|select|shortcuts" [data-sub]
 *              [data-group] [hidden]>                                   data-group: a blank line before it
 *           <span|label class="pcd-panel__label">clock</span>              the focused row shows the cursor before it
 *           <div class="pcd-panel__control">
 *             radio: <label class="pcd-panel__choice" data-key data-value="false"><input class="pcd-panel__input"
 *               type="radio"><span class="pcd-panel__mark" aria-hidden="true"><span class="pcd-panel__bracket">(</span>
 *               <span class="pcd-panel__dot">•</span><span class="pcd-panel__bracket">)</span></span>
 *               <span class="pcd-panel__text">12 h</span></label>
 *             check: the same with class pcd-panel__check, type checkbox and [ x ] (a joined setting, e.g. weatherFx,
 *               adds its choice to another row: <label class="pcd-panel__choice pcd-panel__check" data-key="weatherFx">)
 *             text: <span class="pcd-panel__well"><input class="pcd-panel__input pcd-panel__field"></span>
 *             select: <span class="pcd-panel__well pcd-panel__well--select"><select class="pcd-panel__input
 *               pcd-panel__select"></span> and <button class="pcd-panel__action" data-action="surprise">
 *             shortcuts: <button class="pcd-panel__action pcd-panel__edit" data-action="edit" aria-expanded>
 *               <div class="pcd-panel__editor" hidden><ol class="pcd-panel__list"><li class="pcd-panel__item">
 *               <span class="pcd-panel__num">[1]</span><span class="pcd-panel__well pcd-panel__well--label"><input
 *               class="pcd-panel__item-label"></span><span class="pcd-panel__well pcd-panel__well--url"><input
 *               class="pcd-panel__item-url"></span><button class="pcd-panel__icon" data-action="up|down|remove">
 *               <p class="pcd-panel__item-note"></li></ol><button class="pcd-panel__add" data-action="add"></div>
 *           </div>
 *           <p class="pcd-panel__note" data-for data-level="info|error" hidden></p>
 *         </div> ...
 *       </div>
 *       <footer class="pcd-panel__foot"><button class="pcd-panel__done" data-action="close">[ done ]</button></footer>
 *     </form></dialog>
 *   Buttons spell their brackets as <span class="pcd-panel__bracket" aria-hidden="true">. The copy (lower case)
 *   is PCD.panel.COPY; mount({ copy }) overrides any part of it.
 *
 * Contract (P = PCD.panel):
 *   P.COPY                          the sheet's words (row labels, option labels, footer texts)
 *   P.fields(schema, { scope, themes, copy }) -> [{ key, kind, label, text?, options?: [{ value, raw, label }],
 *                                   join?, sub?, max?, placeholder? }] in display order (pure)
 *   P.toValue(field, raw) / P.fromValue(field, value)   control value <-> setting value (pure)
 *   P.draftShortcuts(rows, schema) -> { values, valid: [{ index, value }], errors: [{ index, error }], blank, ok }
 *   P.syncText(storeStatus, copy)   the footer line for a store.status() (pure)
 *   P.editText(n, copy)             the shortcut editor's button text for n shortcuts (pure)
 *   P.commandName(label, commands, { themes })   true when that link name typed in the terminal runs a command (the
 *                                   editor then notes it under the link); commands: PCD.term.lib('commands.js')
 *   P.frame(cols, rows, { title, tag, foot }) -> { lines, title, tag, foot }: the box lines (strings of exactly cols
 *                                   characters) with blanks where the words go, and where they go ({ c, r, text } in
 *                                   cells, or null when a word does not fit) (pure)
 *   P.mount({ store, schema, themes, copy, parent, id, document, window, onSurprise, onTheme, surpriseNow, onToggle,
 *             requestTopSites, autoName, focusBack })
 *     -> { el, open(opener), close(), toggle(opener), isOpen(), contains(node), note(key, text, level),
 *          setRect(rect | null, { fontPx, cell }), autoTheme(name), refresh(), state(), destroy() }
 *     focusBack() -> the element that gets the focus when the sheet closes (the new tab: the terminal's prompt);
 *     without it (or when it gives nothing) the opener gets it back. The opener's aria-expanded follows the sheet.
 *     parent: where the <dialog> goes (default body; a hidden placeholder is un-hidden, the dialog hides itself);
 *     id: the dialog's id (when free); requestTopSites() -> Promise<true | false | null (no API)>, called inside the
 *     click (default: chrome.permissions.request({ permissions: ['topSites'] })); autoName() -> the name of the
 *     theme "auto" shows today, asked on every open ("auto · autumn forest").
 *     onSurprise() -> { id, name } (or a Promise of it): "☼ surprise me"; the theme select then shows a selected line
 *     "surprise · <name>", so picking the stored theme again is a change. onTheme(id): every theme picked in the
 *     select, before it is stored (the page switches this tab at once and ends a surprise). surpriseNow() -> the
 *     tab's running surprise { id, name } or null, asked on every open.
 */
(function (root, factory) {
  var api = factory(root.PCD || (root.PCD = {}), root);
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (PCD, root) {
  'use strict';

  var SCOPE = 'newtab';
  var THEME_ID_RE = /^[a-z][a-z0-9_-]{0,31}$/;
  /** The value of the theme select's surprise line (never a theme id). */
  var SURPRISE_RAW = '~surprise';

  /** The sheet's words. Row labels and option labels by setting value; join: shown in another row. */
  var COPY = {
    title: 'settings',
    close: 'esc',
    closeLabel: 'close settings',
    done: 'done',
    surprise: '☼ surprise me',
    edit: { none: 'add a link', one: 'edit the link', many: 'edit the %n links' },
    add: '+ add',
    up: '↑',
    down: '↓',
    remove: 'x',
    labelPlaceholder: 'name',
    urlPlaceholder: 'example.com',
    autoName: 'auto · %s',
    surpriseLine: 'surprise · %s',
    unknownTheme: ' (not in this build)',
    topSitesRefused: 'top sites need the permission; still showing my links',
    topSitesUnavailable: 'top sites work in the installed extension only',
    shortcutsInvalid: 'fix the marked link to save the list',
    alsoCommand: '"%s" is also a command: type its number to open it',
    saving: 'saving',
    notSaved: 'not saved: ',
    retrying: '; retrying',
    sync: {
      'chrome.storage.sync': 'synced with chrome',
      'localStorage (preview)': 'preview: saved in this browser',
      memory: 'not saved: no storage here'
    },
    aria: {
      label: 'link %n name',
      url: 'link %n address',
      up: 'move link %n up',
      down: 'move link %n down',
      remove: 'remove link %n'
    },
    rows: {
      clock24: { label: 'clock', options: { 'false': '12 h', 'true': '24 h' } },
      city: { label: 'city', placeholder: 'e.g. berlin' },
      units: { label: 'units', options: { F: '°F', C: '°C' } },
      sunTimes: { label: 'sun times', text: 'real sunrise and sunset' },
      weather: { label: 'weather', text: 'show' },
      weatherFx: { label: 'scene fx', text: 'in the scene', join: 'weather' },
      theme: { label: 'theme', options: { auto: 'auto' } },
      reducedMotion: { label: 'motion', options: { auto: 'auto', on: 'less', off: 'full' } },
      performance: { label: 'performance', options: { auto: 'auto', on: 'on', off: 'off' } },
      shortcutsMode: { label: 'links', options: { custom: 'my links', top: 'top sites' } },
      shortcuts: { label: 'my links', sub: 'yes' },
      clockStatus: { label: 'pixelclock', text: 'show my clock\'s alarms' },
      focusTerminal: { label: 'terminal', text: 'focus on open' }
    }
  };
  /** The frame's line glyphs: rounded corners, the box lines. */
  var BOX = { tl: '╭', tr: '╮', bl: '╰', br: '╯', h: '─', v: '│' };
  /** Sheet sizes in cells: the centred sheet's width, the smallest usable one. */
  var SHEET_COLS = 48;
  var MIN_COLS = 24;
  var MIN_ROWS = 8;
  /** The settings that start a group of rows (clock, city, units | sun times, weather | theme | motion, performance |
   *  links | pixelclock, terminal): a short sheet keeps a blank line before each of them while it has rows to spare. */
  var GROUP_STARTS = ['sunTimes', 'theme', 'reducedMotion', 'shortcutsMode', 'clockStatus'];

  var mounted = 0;

  function isObj(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
  function own(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }
  function str(v) { return v === null || v === undefined ? '' : String(v); }

  /** COPY with the overrides of `over` on top (rows, options, sync, aria and edit merged key by key). */
  function mergeCopy(over) {
    var out = JSON.parse(JSON.stringify(COPY));
    if (!isObj(over)) return out;
    Object.keys(over).forEach(function (k) {
      var v = over[k];
      if (k === 'rows' && isObj(v)) {
        Object.keys(v).forEach(function (key) {
          if (!isObj(v[key])) return;
          var base = out.rows[key] || (out.rows[key] = {});
          Object.keys(v[key]).forEach(function (f) {
            if (f === 'options' && isObj(v[key].options)) base.options = Object.assign({}, base.options || {}, v[key].options);
            else if (typeof v[key][f] === 'string') base[f] = v[key][f];
          });
        });
      } else if ((k === 'sync' || k === 'aria' || k === 'edit') && isObj(v)) {
        out[k] = Object.assign({}, out[k], v);
      } else if (typeof v === 'string') {
        out[k] = v;
      }
    });
    return out;
  }

  // ------------------------------------------------------------------------------------------ pure part

  function schemaOf(schema) {
    var S = schema || PCD.settings;
    if (!S || !Array.isArray(S.KEYS) || typeof S.keys !== 'function') throw new Error('PCD.panel: load js/ntp-settings.js first (or pass a schema)');
    return S;
  }

  function themeOptions(themes, copy) {
    var autoLabel = (copy.rows.theme && copy.rows.theme.options && copy.rows.theme.options.auto) || 'auto';
    var out = [{ value: 'auto', raw: 'auto', label: autoLabel }];
    var seen = { auto: true };
    (Array.isArray(themes) ? themes : []).forEach(function (t) {
      var id = typeof t === 'string' ? t : isObj(t) ? t.id : null;
      if (typeof id !== 'string' || own(seen, id) || !THEME_ID_RE.test(id)) return;
      seen[id] = true;
      var name = isObj(t) && typeof t.name === 'string' && t.name ? t.name : id;
      out.push({ value: id, raw: id, label: name.toLowerCase() });
    });
    return out;
  }

  /** The controls of a scope (default: the new tab), in the schema's display order. */
  function fields(schema, opts) {
    var S = schemaOf(schema);
    var o = isObj(opts) ? opts : {};
    var copy = mergeCopy(o.copy);
    var keys = S.keys(o.scope || SCOPE);
    return keys.map(function (key, index) {
      var d = S.spec(key);
      var c = copy.rows[key] || {};
      var opt = function (raw) { return c.options && typeof c.options[raw] === 'string' ? c.options[raw] : null; };
      var f = { key: key, schemaKind: d.kind, label: c.label || d.label || key };
      // join another row only when that row is shown earlier in this scope
      if (c.join && keys.indexOf(c.join) >= 0 && keys.indexOf(c.join) < index) f.join = c.join;
      if (c.sub) f.sub = true;
      switch (d.kind) {
        case 'bool':
          f.kind = 'check';
          f.text = c.text || 'on';
          break;
        case 'clock':
          f.kind = 'radio';
          f.options = [false, true].map(function (v) {
            return { value: v, raw: String(v), label: opt(String(v)) || (v ? '24 h' : '12 h') };
          });
          break;
        case 'enum':
          f.kind = 'radio';
          f.options = d.values.map(function (v, i) {
            return { value: v, raw: String(v), label: opt(String(v)) || (d.options && d.options[i]) || String(v) };
          });
          break;
        case 'theme':
          f.kind = 'select';
          f.options = themeOptions(o.themes, copy);
          break;
        case 'shortcuts':
          f.kind = 'shortcuts';
          f.max = d.max || S.SHORTCUTS_MAX || 12;
          f.labelMax = S.LABEL_MAX || 24;
          f.urlMax = S.URL_MAX || 300;
          break;
        default: // 'city' and anything new that is typed
          f.kind = 'text';
          if (d.max) f.max = d.max;
          if (c.placeholder) f.placeholder = c.placeholder;
          break;
      }
      if (f.join && f.kind !== 'check' && f.kind !== 'radio') delete f.join; // only choices can share a row
      return f;
    });
  }

  /** A control's value (checked state, option value, text) -> the setting value. */
  function toValue(field, raw) {
    switch (field.kind) {
      case 'check':
        return raw === true || raw === 'true' || raw === 'on';
      case 'radio':
      case 'select': {
        var list = field.options || [];
        for (var i = 0; i < list.length; i++) if (list[i].raw === str(raw)) return list[i].value;
        return str(raw);
      }
      case 'shortcuts':
        return Array.isArray(raw) ? raw : [];
      default:
        return str(raw);
    }
  }

  /** A setting value -> the control's value (checked state, option value, text, or rows for shortcuts). */
  function fromValue(field, value) {
    switch (field.kind) {
      case 'check':
        return value === true;
      case 'radio':
      case 'select': {
        var list = field.options || [];
        for (var i = 0; i < list.length; i++) if (list[i].value === value) return list[i].raw;
        return str(value);
      }
      case 'shortcuts':
        return (Array.isArray(value) ? value : []).map(function (s) {
          return { label: isObj(s) ? str(s.label) : '', url: isObj(s) ? str(s.url) : '' };
        });
      default:
        return str(value);
    }
  }

  /**
   * The shortcut editor's rows ({ label, url } as typed) -> what can be stored. Empty rows are ignored (blank);
   * every other row goes through PCD.settings.shortcut() (https:// added to a bare domain, a label from the host
   * when none is typed). values: the list to store (only meaningful when ok); valid: the normalized rows by index.
   */
  function draftShortcuts(rows, schema) {
    var S = schemaOf(schema);
    var max = S.SHORTCUTS_MAX || 12;
    var valid = [];
    var errors = [];
    var blank = 0;
    (Array.isArray(rows) ? rows : []).forEach(function (r, i) {
      var label = isObj(r) ? str(r.label) : '';
      var url = isObj(r) ? str(r.url) : '';
      if (!label.trim() && !url.trim()) {
        blank++;
        return;
      }
      var res = S.shortcut({ label: label, url: url });
      if (res.ok) valid.push({ index: i, value: res.value });
      else errors.push({ index: i, error: res.error });
    });
    return {
      values: valid.slice(0, max).map(function (v) { return v.value; }),
      valid: valid,
      errors: errors,
      blank: blank,
      ok: errors.length === 0
    };
  }

  /** The terminal's commands table (PCD.term.lib('commands.js')), or null when the terminal is not loaded. */
  function termCommands() {
    try {
      return PCD.term && typeof PCD.term.lib === 'function' ? PCD.term.lib('commands.js') : null;
    } catch (e) {
      return null;
    }
  }

  /**
   * True when typing this link name in the terminal runs one of its commands (built-ins come before link names, so
   * the name never opens the link; its number still does). commands: the commands table (default: the terminal's,
   * when it is loaded; without one the answer is false). opts.themes: the scene list ([{ id, name }]) for "theme <name>".
   */
  function commandName(label, commands, opts) {
    var C = commands === undefined ? termCommands() : commands;
    if (!C || typeof C.isBuiltinName !== 'function') return false;
    var words = str(label).trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return false;
    try {
      var def = typeof C.getBuiltin === 'function' ? C.getBuiltin(words[0]) : null;
      if (!def || typeof C.acceptsArgs !== 'function') return words.length === 1 && C.isBuiltinName(words[0]);
      var o = isObj(opts) ? opts : {};
      var themes = typeof C.themeWords === 'function' ? C.themeWords(Array.isArray(o.themes) ? o.themes : []) : undefined;
      var args = words.slice(1);
      return !!(C.acceptsArgs(def, args, { themes: themes }) ||
        (typeof C.looksLikeAttempt === 'function' && C.looksLikeAttempt(def, args, { themes: themes })));
    } catch (e) {
      return false;
    }
  }

  /** The footer line for a store.status(): an error, "saving", or where the settings live. */
  function syncText(status, copy) {
    var c = isObj(copy) && copy.sync ? copy : COPY;
    var s = isObj(status) ? status : {};
    if (s.lastError) {
      return c.notSaved + str(s.lastError.message || s.lastError.kind || 'error') + (s.lastError.retrying ? c.retrying : '');
    }
    if ((Array.isArray(s.pending) && s.pending.length) || s.writing || s.dirty) return c.saving;
    return (c.sync && typeof c.sync[s.kind] === 'string' ? c.sync[s.kind] : str(s.kind));
  }

  /** The editor button's words for n stored shortcuts. */
  function editText(n, copy) {
    var e = (isObj(copy) && isObj(copy.edit) ? copy : COPY).edit;
    if (!n) return e.none;
    if (n === 1) return e.one;
    return str(e.many).replace('%n', String(n));
  }

  function rep(ch, n) { return n > 0 ? new Array(n + 1).join(ch) : ''; }

  /**
   * The sheet's box lines, cols x rows cells: the title after "╭─ " on the top border, the tag (esc) right
   * before " ─╮", the foot (the storage line) right before " ─╯", each with one blank on both sides; every word is
   * left blank in the lines (the page puts a real element there) and its place is returned. A word that does not fit
   * is left out (the tag first, then the foot); the title is cut to fit.
   */
  function frame(cols, rows, labels) {
    var w = Math.max(2, Math.floor(cols) || 0);
    var hRows = Math.max(2, Math.floor(rows) || 0);
    var l = isObj(labels) ? labels : {};
    var title = str(l.title);
    var tag = str(l.tag);
    var foot = str(l.foot);
    // top: ╭─ title ─...─ tag ─╮ needs 4 + (title + 2) + 1 + (tag + 2) cells at least
    if (tag && 4 + (title ? title.length + 2 : 0) + 1 + tag.length + 2 > w) tag = '';
    if (title && 4 + title.length + 2 + 1 > w) title = title.slice(0, Math.max(0, w - 7));
    if (foot && 4 + foot.length + 2 + 1 > w) foot = '';
    var out = { lines: [], title: null, tag: null, foot: null };
    var top = BOX.tl + BOX.h;
    if (title) {
      out.title = { c: top.length + 1, r: 0, text: title };
      top += ' ' + rep(' ', title.length) + ' ';
    }
    var tail = tag ? ' ' + rep(' ', tag.length) + ' ' + BOX.h + BOX.tr : BOX.h + BOX.tr;
    top += rep(BOX.h, w - top.length - tail.length) + tail;
    if (tag) out.tag = { c: w - 3 - tag.length, r: 0, text: tag };
    out.lines.push(top);
    for (var i = 1; i < hRows - 1; i++) out.lines.push(BOX.v + rep(' ', w - 2) + BOX.v);
    var end = foot ? ' ' + rep(' ', foot.length) + ' ' + BOX.h + BOX.br : BOX.h + BOX.br;
    out.lines.push(BOX.bl + rep(BOX.h, w - 1 - end.length) + end);
    if (foot) out.foot = { c: w - 3 - foot.length, r: hRows - 1, text: foot };
    return out;
  }

  function areaName(kind) {
    if (kind === 'chrome.storage.sync') return 'sync';
    if (/preview/.test(str(kind))) return 'preview';
    if (kind === 'memory') return 'memory';
    return 'other';
  }

  function defaultThemes() {
    try {
      if (PCD.engine && typeof PCD.engine.menu === 'function' && root.PixelClock) return PCD.engine.menu(root.PixelClock);
    } catch (e) {
      // no engine on this page: auto only
    }
    return [];
  }

  // ------------------------------------------------------------------------------------------- DOM part

  /** An element from tag, attributes (text, className, hidden handled as properties) and children. */
  function h(doc, tag, attrs, kids) {
    var el = doc.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        var v = attrs[k];
        if (v === null || v === undefined || v === false) return;
        if (k === 'text') el.textContent = String(v);
        else if (k === 'className') el.className = String(v);
        else if (k === 'hidden') el.hidden = !!v;
        else el.setAttribute(k, v === true ? '' : String(v));
      });
    }
    (kids || []).forEach(function (c) {
      if (c) el.appendChild(typeof c === 'string' ? doc.createTextNode(c) : c);
    });
    return el;
  }

  function fill(template, n) { return str(template).replace('%n', String(n)); }

  var ARROWS = { ArrowUp: -1, ArrowDown: 1 };

  function mount(opts) {
    var o = isObj(opts) ? opts : {};
    var store = o.store;
    if (!store || typeof store.get !== 'function' || typeof store.set !== 'function' || typeof store.subscribe !== 'function') {
      throw new Error('PCD.panel.mount: opts.store (PCD.store.create(...)) is required');
    }
    var S = schemaOf(o.schema);
    var win = o.window || root;
    var doc = o.document || win.document;
    var copy = mergeCopy(o.copy);
    var list = fields(S, { scope: SCOPE, themes: Array.isArray(o.themes) ? o.themes : defaultThemes(), copy: copy });
    var byKey = {};
    list.forEach(function (f) { byKey[f.key] = f; });
    var uid = 'pcd-panel-' + (++mounted);
    var refs = {};
    var current = store.get();
    var lastOpener = null;
    var draftDirty = false;
    var listStale = false;
    var downOnBackdrop = false;
    var autoLabel = null;
    var writes = 0;
    var itemSeq = 0;
    var offs = [];
    var destroyed = false;
    var placed = null; // setRect's rect (CSS px), or null: centred
    var type = null; // setRect's { fontPx, cell }, or null: the page's own font
    var geo = null; // the last layout, in cells: { cols, rows, cw, ch, ls, x, y, gap, pad, lines, groups, frame }
    var syncWords = null; // the words on the bottom border
    var surpriseFrom = null; // the stored theme (raw) while the select shows this tab's surprise line, else null

    // ---- building

    function bracketed(cls, attrs, inner) {
      var b = h(doc, 'button', Object.assign({ type: 'button', className: cls }, attrs || {}));
      b.appendChild(h(doc, 'span', { className: 'pcd-panel__bracket', 'aria-hidden': 'true', text: '[ ' }));
      b.appendChild(h(doc, 'span', { className: 'pcd-panel__word', text: inner }));
      b.appendChild(h(doc, 'span', { className: 'pcd-panel__bracket', 'aria-hidden': 'true', text: ' ]' }));
      return b;
    }

    function mark(open, dot, close) {
      return h(doc, 'span', { className: 'pcd-panel__mark', 'aria-hidden': 'true' }, [
        h(doc, 'span', { className: 'pcd-panel__bracket', text: open }),
        h(doc, 'span', { className: 'pcd-panel__dot', text: dot }),
        h(doc, 'span', { className: 'pcd-panel__bracket', text: close })
      ]);
    }

    /** A radio or checkbox choice: hidden native input, the TUI mark, the words. */
    function choice(f, input, text, extra) {
      var radio = input.getAttribute('type') === 'radio';
      return h(doc, 'label', Object.assign({ className: 'pcd-panel__choice' + (radio ? '' : ' pcd-panel__check'), 'for': input.id, 'data-key': f.key }, extra || {}), [
        input,
        radio ? mark('(', '•', ')') : mark('[', 'x', ']'),
        h(doc, 'span', { className: 'pcd-panel__text', id: input.id + '-t', text: text })
      ]);
    }

    function buildRow(f) {
      var row = h(doc, 'div', { className: 'pcd-panel__row', 'data-key': f.key, 'data-kind': f.kind, 'data-sub': f.sub ? '1' : null });
      var labelId = uid + '-l-' + f.key;
      var ctrlId = uid + '-f-' + f.key;
      var noteId = uid + '-n-' + f.key;
      var ctl = h(doc, 'div', { className: 'pcd-panel__control' });
      var ref = { row: row, control: ctl, inputs: [], labelId: labelId };
      var label;
      if (f.kind === 'radio') {
        label = h(doc, 'span', { className: 'pcd-panel__label', id: labelId, text: f.label });
        ctl.setAttribute('role', 'radiogroup');
        ctl.setAttribute('aria-labelledby', labelId);
        f.options.forEach(function (opt, i) {
          var input = h(doc, 'input', { type: 'radio', className: 'pcd-panel__input', name: uid + '-' + f.key, value: opt.raw, id: ctrlId + '-' + i, 'aria-describedby': noteId });
          ref.inputs.push(input);
          ctl.appendChild(choice(f, input, opt.label, { 'data-value': opt.raw }));
        });
      } else if (f.kind === 'check') {
        label = h(doc, 'span', { className: 'pcd-panel__label', id: labelId, text: f.label });
        var box = h(doc, 'input', { type: 'checkbox', className: 'pcd-panel__input', id: ctrlId, 'aria-labelledby': labelId + ' ' + ctrlId + '-t', 'aria-describedby': noteId });
        ref.inputs.push(box);
        ref.wrap = choice(f, box, f.text);
        ctl.appendChild(ref.wrap);
      } else if (f.kind === 'select') {
        label = h(doc, 'label', { className: 'pcd-panel__label', id: labelId, 'for': ctrlId, text: f.label });
        var sel = h(doc, 'select', { className: 'pcd-panel__input pcd-panel__select', id: ctrlId, 'aria-describedby': noteId });
        f.options.forEach(function (opt) { sel.appendChild(h(doc, 'option', { value: opt.raw, text: opt.label })); });
        ref.inputs.push(sel);
        ctl.appendChild(h(doc, 'span', { className: 'pcd-panel__well pcd-panel__well--select' }, [sel]));
        if (f.key === 'theme' && typeof o.onSurprise === 'function') {
          ctl.appendChild(bracketed('pcd-panel__action', { 'data-action': 'surprise' }, copy.surprise));
        }
      } else if (f.kind === 'shortcuts') {
        label = h(doc, 'span', { className: 'pcd-panel__label', id: labelId, text: f.label });
        var editorId = uid + '-editor';
        ref.edit = bracketed('pcd-panel__action pcd-panel__edit', { 'data-action': 'edit', 'aria-expanded': 'false', 'aria-controls': editorId }, '');
        ref.list = h(doc, 'ol', { className: 'pcd-panel__list', 'aria-labelledby': labelId });
        ref.add = h(doc, 'button', { type: 'button', className: 'pcd-panel__add', 'data-action': 'add', text: copy.add });
        ref.editor = h(doc, 'div', { className: 'pcd-panel__editor', id: editorId, hidden: true }, [ref.list, ref.add]);
        ctl.appendChild(ref.edit);
        ctl.appendChild(ref.editor);
      } else {
        label = h(doc, 'label', { className: 'pcd-panel__label', id: labelId, 'for': ctrlId, text: f.label });
        var input = h(doc, 'input', {
          type: 'text', className: 'pcd-panel__input pcd-panel__field', id: ctrlId, 'aria-describedby': noteId, autocomplete: 'off',
          spellcheck: 'false', maxlength: f.max, placeholder: f.placeholder
        });
        ref.inputs.push(input);
        ctl.appendChild(h(doc, 'span', { className: 'pcd-panel__well' }, [input]));
      }
      ref.note = h(doc, 'p', { className: 'pcd-panel__note', id: noteId, 'data-for': f.key, hidden: true });
      row.appendChild(label);
      row.appendChild(ctl);
      row.appendChild(ref.note);
      refs[f.key] = ref;
      return row;
    }

    /** A setting that shares another row ("weather [x] show [x] in the scene"). */
    function joinRow(f) {
      var host = refs[f.join];
      var ctrlId = uid + '-f-' + f.key;
      var noteId = uid + '-n-' + f.key;
      var input = h(doc, 'input', {
        type: f.kind === 'radio' ? 'radio' : 'checkbox', className: 'pcd-panel__input', id: ctrlId,
        'aria-labelledby': host.labelId + ' ' + ctrlId + '-t', 'aria-describedby': noteId
      });
      var wrap = choice(f, input, f.text || f.label);
      var note = h(doc, 'p', { className: 'pcd-panel__note', id: noteId, 'data-for': f.key, hidden: true });
      host.control.appendChild(wrap);
      host.row.appendChild(note);
      refs[f.key] = { row: host.row, control: host.control, inputs: [input], wrap: wrap, note: note, joined: true };
    }

    var titleId = uid + '-title';
    var dialogId = typeof o.id === 'string' && o.id && !doc.getElementById(o.id) ? o.id : uid;
    // role="dialog" is the element's own role, spelled out for code that looks for the attribute
    var dialog = h(doc, 'dialog', { className: 'pcd-panel', id: dialogId, role: 'dialog', 'aria-labelledby': titleId, 'data-area': areaName(store.kind) });
    var form = h(doc, 'form', { className: 'pcd-panel__box', novalidate: true, autocomplete: 'off' });
    var rowsEl = h(doc, 'div', { className: 'pcd-panel__rows' });
    list.forEach(function (f) {
      if (f.join) joinRow(f);
      else rowsEl.appendChild(buildRow(f));
    });
    var syncEl = h(doc, 'p', { className: 'pcd-panel__sync', role: 'status' });
    var doneBtn = bracketed('pcd-panel__done', { 'data-action': 'close' }, copy.done);
    var frameEl = h(doc, 'pre', { className: 'pcd-panel__frame', 'aria-hidden': 'true' });
    var titleEl = h(doc, 'h2', { className: 'pcd-panel__title', id: titleId, text: copy.title });
    var closeBtn = h(doc, 'button', { type: 'button', className: 'pcd-panel__close', 'data-action': 'close', 'aria-label': copy.closeLabel, text: copy.close });
    var headEl = h(doc, 'header', { className: 'pcd-panel__head' }, [titleEl, closeBtn]);
    var footEl = h(doc, 'footer', { className: 'pcd-panel__foot' }, [doneBtn]);
    form.appendChild(rowsEl);
    form.appendChild(footEl);
    dialog.appendChild(frameEl);
    dialog.appendChild(headEl);
    dialog.appendChild(form);
    dialog.appendChild(syncEl);
    var parent = o.parent || doc.body;
    // A placeholder the page kept hidden (e.g. <aside id="panel" hidden>) would hide the dialog with it: the
    // dialog shows and hides itself, so its container stays rendered (it has no size of its own).
    if (parent !== doc.body && parent.hidden) parent.hidden = false;
    parent.appendChild(dialog);

    // ---- the shortcut editor

    function itemRow(item) {
      var id = uid + '-sc-' + (++itemSeq);
      var li = h(doc, 'li', { className: 'pcd-panel__item' });
      var lab = h(doc, 'input', { type: 'text', className: 'pcd-panel__input pcd-panel__item-label', maxlength: byKey.shortcuts.labelMax, placeholder: copy.labelPlaceholder, autocomplete: 'off', spellcheck: 'false' });
      var url = h(doc, 'input', { type: 'text', className: 'pcd-panel__input pcd-panel__item-url', maxlength: byKey.shortcuts.urlMax, placeholder: copy.urlPlaceholder, inputmode: 'url', autocomplete: 'off', spellcheck: 'false', 'aria-describedby': id + '-note' });
      lab.value = str(item.label);
      url.value = str(item.url);
      li.appendChild(h(doc, 'span', { className: 'pcd-panel__num', 'aria-hidden': 'true' }));
      li.appendChild(h(doc, 'span', { className: 'pcd-panel__well pcd-panel__well--label' }, [lab]));
      li.appendChild(h(doc, 'span', { className: 'pcd-panel__well pcd-panel__well--url' }, [url]));
      li.appendChild(h(doc, 'button', { type: 'button', className: 'pcd-panel__icon', 'data-action': 'up', text: copy.up }));
      li.appendChild(h(doc, 'button', { type: 'button', className: 'pcd-panel__icon', 'data-action': 'down', text: copy.down }));
      li.appendChild(h(doc, 'button', { type: 'button', className: 'pcd-panel__icon', 'data-action': 'remove', text: copy.remove }));
      li.appendChild(h(doc, 'p', { className: 'pcd-panel__item-note', id: id + '-note', hidden: true }));
      return li;
    }

    function part(li, cls) { return li.querySelector('.' + cls); }

    function items() {
      var ref = refs.shortcuts;
      return ref ? Array.prototype.slice.call(ref.list.children) : [];
    }

    function editorOpen() { return !!refs.shortcuts && !refs.shortcuts.editor.hidden; }

    function renumber() {
      var ref = refs.shortcuts;
      if (!ref) return;
      var all = items();
      all.forEach(function (li, i) {
        var n = i + 1;
        li.setAttribute('data-index', String(i));
        part(li, 'pcd-panel__num').textContent = '[' + n + ']';
        part(li, 'pcd-panel__item-label').setAttribute('aria-label', fill(copy.aria.label, n));
        part(li, 'pcd-panel__item-url').setAttribute('aria-label', fill(copy.aria.url, n));
        var up = li.querySelector('[data-action="up"]');
        var down = li.querySelector('[data-action="down"]');
        up.setAttribute('aria-label', fill(copy.aria.up, n));
        down.setAttribute('aria-label', fill(copy.aria.down, n));
        li.querySelector('[data-action="remove"]').setAttribute('aria-label', fill(copy.aria.remove, n));
        up.disabled = i === 0;
        down.disabled = i === all.length - 1;
      });
      ref.add.disabled = all.length >= byKey.shortcuts.max;
    }

    /** The editor button says how many links are stored ("[ edit the 4 links ]"). */
    function editLabel() {
      var ref = refs.shortcuts;
      if (!ref) return;
      var n = Array.isArray(current.shortcuts) ? current.shortcuts.length : 0;
      part(ref.edit, 'pcd-panel__word').textContent = editText(n, copy);
    }

    function renderShortcuts(value) {
      var ref = refs.shortcuts;
      if (!ref) return;
      while (ref.list.firstChild) ref.list.removeChild(ref.list.firstChild);
      fromValue(byKey.shortcuts, value).forEach(function (s) { ref.list.appendChild(itemRow(s)); });
      draftDirty = false;
      listStale = false;
      renumber();
      editLabel();
      markCommands(draftShortcuts(readRows(), S).valid);
    }

    function setEditor(openIt) {
      var ref = refs.shortcuts;
      if (!ref) return;
      ref.editor.hidden = !openIt;
      ref.edit.setAttribute('aria-expanded', openIt ? 'true' : 'false');
      relayout();
      if (openIt) {
        var first = items()[0];
        var target = first ? part(first, 'pcd-panel__item-label') : ref.add;
        if (target && !target.disabled) target.focus();
      }
    }

    function readRows() {
      return items().map(function (li) {
        return { label: part(li, 'pcd-panel__item-label').value, url: part(li, 'pcd-panel__item-url').value };
      });
    }

    /** A line under one link: an error (the row is not saved, its address marked invalid) or, with level 'info', a
     *  hint that leaves the row valid. */
    function itemNote(li, text, level) {
      var n = part(li, 'pcd-panel__item-note');
      n.textContent = text || '';
      n.hidden = !text;
      if (text) n.setAttribute('data-level', level === 'info' ? 'info' : 'error');
      else n.removeAttribute('data-level');
      var url = part(li, 'pcd-panel__item-url');
      if (text && level !== 'info') {
        url.setAttribute('aria-invalid', 'true');
        li.setAttribute('data-invalid', '');
      } else {
        url.removeAttribute('aria-invalid');
        li.removeAttribute('data-invalid');
      }
    }

    /** The scenes for "theme <name>" in commandName(): the theme select's options. */
    var sceneList = byKey.theme ? byKey.theme.options.filter(function (t) { return t.value !== 'auto'; }).map(function (t) {
      return { id: t.value, name: t.label };
    }) : [];

    /** An info line under each valid link whose name is also a terminal command (the row is still saved). */
    function markCommands(valid) {
      var lis = items();
      valid.forEach(function (v) {
        var li = lis[v.index];
        if (li && commandName(v.value.label, undefined, { themes: sceneList })) itemNote(li, str(copy.alsoCommand).replace('%s', v.value.label), 'info');
      });
    }

    function setIfIdle(input, value) {
      if (input && doc.activeElement !== input && input.value !== value) input.value = value;
    }

    function editingList() {
      var ref = refs.shortcuts;
      return !!ref && (draftDirty || (!!doc.activeElement && ref.list.contains(doc.activeElement)));
    }

    /** Validate the editor; store the list when every typed row is valid (else keep what is stored). */
    function commitShortcuts() {
      if (!refs.shortcuts) return;
      var lis = items();
      var d = draftShortcuts(readRows(), S);
      lis.forEach(function (li) { itemNote(li, ''); });
      d.errors.forEach(function (e) { itemNote(lis[e.index], e.error); });
      d.valid.forEach(function (v) {
        setIfIdle(part(lis[v.index], 'pcd-panel__item-label'), v.value.label);
        setIfIdle(part(lis[v.index], 'pcd-panel__item-url'), v.value.url);
      });
      markCommands(d.valid);
      relayout(); // a note line more or less in the editor
      draftDirty = !d.ok || d.blank > 0;
      if (!d.ok) {
        note('shortcuts', copy.shortcutsInvalid, 'error');
        return;
      }
      note('shortcuts', '');
      if (!S.equal(d.values, current.shortcuts)) commit('shortcuts', d.values);
    }

    function addItem() {
      var ref = refs.shortcuts;
      if (!ref || items().length >= byKey.shortcuts.max) return;
      var li = itemRow({ label: '', url: '' });
      ref.list.appendChild(li);
      draftDirty = true;
      renumber();
      relayout();
      part(li, 'pcd-panel__item-label').focus();
    }

    function removeItem(li) {
      var all = items();
      var i = all.indexOf(li);
      var next = all[i + 1] || all[i - 1] || null;
      li.parentNode.removeChild(li);
      renumber();
      relayout();
      var target = next ? next.querySelector('[data-action="remove"]') : refs.shortcuts.add;
      if (target && !target.disabled) target.focus();
      commitShortcuts();
    }

    function moveItem(li, dir) {
      var all = items();
      var i = all.indexOf(li);
      var j = i + dir;
      if (j < 0 || j >= all.length) return;
      var listEl = refs.shortcuts.list;
      if (dir < 0) listEl.insertBefore(li, all[j]);
      else listEl.insertBefore(li, all[j].nextSibling);
      renumber();
      var same = li.querySelector('[data-action="' + (dir < 0 ? 'up' : 'down') + '"]');
      var other = li.querySelector('[data-action="' + (dir < 0 ? 'down' : 'up') + '"]');
      (same && !same.disabled ? same : other).focus();
      commitShortcuts();
    }

    // ---- values in and out

    function note(key, text, level) {
      var ref = refs[key];
      if (!ref) return;
      var was = ref.note.hidden;
      ref.note.textContent = text || '';
      ref.note.hidden = !text;
      if (was !== ref.note.hidden) relayout(); // a line more or less in the sheet
      if (text) ref.note.setAttribute('data-level', level || 'info');
      else ref.note.removeAttribute('data-level');
      var invalid = !!text && level === 'error' && key !== 'shortcuts';
      ref.inputs.forEach(function (i) {
        if (invalid) i.setAttribute('aria-invalid', 'true');
        else i.removeAttribute('aria-invalid');
      });
    }

    function footer() {
      var st = typeof store.status === 'function' ? store.status() : { kind: store.kind };
      var busy = writes > 0 || (Array.isArray(st.pending) && st.pending.length > 0) || !!st.writing;
      var text = syncText(st, copy);
      dialog.setAttribute('data-sync', st.lastError ? 'error' : busy ? 'saving' : 'saved');
      if (text === syncWords) return;
      syncWords = text;
      syncEl.textContent = text;
      if (isOpen()) drawFrame(); // the words sit in the bottom border
    }

    function commit(key, value) {
      var patch = {};
      patch[key] = value;
      note(key, '');
      writes++;
      var p;
      try {
        p = store.set(patch);
      } catch (e) {
        p = Promise.resolve({ ok: false, error: 'error', message: String(e && e.message ? e.message : e) });
      }
      footer();
      return Promise.resolve(p).then(function (res) {
        writes--;
        if (destroyed) return res;
        if (res && res.errors && res.errors[key]) note(key, res.errors[key], 'error');
        footer();
        return res;
      }, function () {
        writes--;
        if (!destroyed) footer();
      });
    }

    function ensureOption(sel, raw) {
      for (var i = 0; i < sel.options.length; i++) if (sel.options[i].value === raw) return;
      sel.appendChild(h(doc, 'option', { value: raw, 'data-extra': '1', text: raw + copy.unknownTheme }));
    }

    /** The theme select's line for this tab's surprise ("surprise · snowy hills", selected), so that picking the
     *  stored scene again is a change too; info: { id, name } of the surprise scene. Any theme change drops it. */
    function showSurprise(info) {
      var ref = refs.theme;
      if (!ref || destroyed || !isObj(info)) return;
      var sel = ref.inputs[0];
      dropSurprise();
      var name = str(info.name || info.id).toLowerCase();
      sel.appendChild(h(doc, 'option', { value: SURPRISE_RAW, 'data-extra': 'surprise', text: str(copy.surpriseLine).replace('%s', name) }));
      sel.value = SURPRISE_RAW;
      surpriseFrom = fromValue(byKey.theme, current.theme);
    }

    function dropSurprise() {
      var ref = refs.theme;
      surpriseFrom = null;
      if (!ref) return;
      var sel = ref.inputs[0];
      for (var i = sel.options.length - 1; i >= 0; i--) if (sel.options[i].value === SURPRISE_RAW) sel.removeChild(sel.options[i]);
    }

    /** The page's running surprise (opts.surpriseNow), shown in the select; none: the stored theme shows. */
    function syncSurprise() {
      var info = null;
      if (typeof o.surpriseNow === 'function') {
        try { info = o.surpriseNow(); } catch (e) { info = null; }
      }
      if (isObj(info)) showSurprise(info);
    }

    function labelAuto() {
      var ref = refs.theme;
      if (!ref) return;
      var sel = ref.inputs[0];
      for (var i = 0; i < sel.options.length; i++) {
        if (sel.options[i].value !== 'auto') continue;
        sel.options[i].textContent = autoLabel ? str(copy.autoName).replace('%s', autoLabel) : byKey.theme.options[0].label;
      }
    }

    function dependents(s) {
      var fx = refs.weatherFx;
      if (fx && fx.inputs[0]) {
        var off = s.weather === false;
        fx.inputs[0].disabled = off;
        var box = fx.wrap || fx.row;
        if (off) box.setAttribute('data-disabled', '');
        else box.removeAttribute('data-disabled');
      }
      if (refs.shortcuts) refs.shortcuts.row.hidden = s.shortcutsMode === 'top';
    }

    function renderValues(s, source) {
      list.forEach(function (f) {
        var ref = refs[f.key];
        var v = s[f.key];
        if (f.kind === 'shortcuts') {
          if (editingList()) {
            if (source !== 'local') listStale = true;
          } else {
            var shown = draftShortcuts(readRows(), S);
            if (shown.blank || !shown.ok || !S.equal(shown.values, v)) renderShortcuts(v);
          }
          editLabel();
          return;
        }
        var raw = fromValue(f, v);
        if (f.kind === 'radio') {
          ref.inputs.forEach(function (i) { i.checked = i.value === raw; });
        } else if (f.kind === 'check') {
          ref.inputs[0].checked = raw === true;
        } else if (f.kind === 'select') {
          if (f.key === 'theme' && surpriseFrom !== null) {
            // this tab's surprise line stays while the stored theme is the one it was shown over
            if (surpriseFrom === raw && ref.inputs[0].value === SURPRISE_RAW) return;
            dropSurprise();
          }
          ensureOption(ref.inputs[0], raw);
          ref.inputs[0].value = raw;
        } else {
          setIfIdle(ref.inputs[0], raw);
        }
      });
      dependents(s);
    }

    /** Text typed but not committed yet (the sheet closes, the page hides): store it when it is valid. */
    function commitTyped() {
      list.forEach(function (f) {
        if (f.kind !== 'text') return;
        var v = toValue(f, refs[f.key].inputs[0].value);
        var r = S.validate(f.key, v);
        if (r.ok && !S.equal(r.value, current[f.key])) commit(f.key, v);
      });
      if (refs.shortcuts && draftDirty) commitShortcuts();
    }

    function flush() {
      if (typeof store.flush !== 'function') return Promise.resolve();
      try {
        return Promise.resolve(store.flush()).then(function () { if (!destroyed) footer(); }, function () { if (!destroyed) footer(); });
      } catch (e) {
        return Promise.resolve();
      }
    }

    function defaultTopSites() {
      var c = win.chrome;
      try {
        if (!c || !c.permissions || typeof c.permissions.request !== 'function') return Promise.resolve(null);
        return Promise.resolve(c.permissions.request({ permissions: ['topSites'] }));
      } catch (e) {
        return Promise.resolve(false);
      }
    }

    /** "top sites": ask for the optional permission inside this click; granted -> store it, else stay custom. */
    function chooseTop() {
      var ask = typeof o.requestTopSites === 'function' ? o.requestTopSites : defaultTopSites;
      var p;
      try {
        p = ask();
      } catch (e) {
        p = Promise.resolve(false);
      }
      var done = function (granted) {
        if (destroyed) return;
        if (granted === true) {
          note('shortcutsMode', '');
          commit('shortcutsMode', 'top');
        } else {
          note('shortcutsMode', granted === null ? copy.topSitesUnavailable : copy.topSitesRefused, 'info');
          renderValues(current, 'refused');
        }
      };
      Promise.resolve(p).then(done, function () { done(false); });
    }

    // ---- moving between rows with Up and Down

    /** The rows a person moves through, in order: { group (contains the focus), target (gets it) }. */
    function stops() {
      var out = [];
      Array.prototype.forEach.call(rowsEl.children, function (row) {
        if (row.hidden) return;
        var ref = refs[row.getAttribute('data-key')];
        if (!ref) return;
        if (ref.edit) {
          out.push({ group: ref.edit, target: ref.edit });
          if (editorOpen()) {
            items().forEach(function (li) { out.push({ group: li, target: part(li, 'pcd-panel__item-label') }); });
            out.push({ group: ref.add, target: ref.add });
          }
          return;
        }
        var target = ref.inputs.filter(function (i) { return i.checked && !i.disabled; })[0] ||
          ref.inputs.filter(function (i) { return !i.disabled; })[0];
        if (target) out.push({ group: row, target: target });
      });
      out.push({ group: doneBtn, target: doneBtn });
      return out;
    }

    function moveRow(dir) {
      var all = stops();
      var active = doc.activeElement;
      var at = -1;
      for (var i = 0; i < all.length; i++) if (all[i].group === active || all[i].group.contains(active)) at = i;
      var next = at < 0 ? (dir > 0 ? 0 : all.length - 1) : Math.max(0, Math.min(all.length - 1, at + dir));
      if (all[next] && all[next].target !== active) all[next].target.focus();
    }

    // ---- events

    function listen(target, type, fn) {
      if (!target || typeof target.addEventListener !== 'function') return;
      target.addEventListener(type, fn);
      offs.push(function () { target.removeEventListener(type, fn); });
    }

    function rowOf(node) {
      var row = node && typeof node.closest === 'function' ? node.closest('.pcd-panel__row') : null;
      return row && form.contains(row) ? row : null;
    }

    function keyOf(node) {
      var el = node && typeof node.closest === 'function' ? node.closest('[data-key]') : null;
      return el && form.contains(el) ? el.getAttribute('data-key') : null;
    }

    listen(form, 'submit', function (e) { e.preventDefault(); });

    listen(form, 'change', function (e) {
      var row = rowOf(e.target);
      var f = byKey[keyOf(e.target)];
      if (!row || !f) return;
      if (f.kind === 'shortcuts') {
        commitShortcuts();
        return;
      }
      if (f.kind === 'radio' && !e.target.checked) return;
      if (f.key === 'theme' && e.target.value === SURPRISE_RAW) return; // the surprise's own line: nothing to store
      var value = toValue(f, f.kind === 'check' ? e.target.checked : e.target.value);
      if (f.key === 'shortcutsMode' && value === 'top' && current.shortcutsMode !== 'top') {
        chooseTop();
        return;
      }
      if (f.key === 'shortcutsMode') note('shortcutsMode', '');
      if (f.key === 'theme') {
        // an explicit scene for this tab at once (it also ends a surprise, even when the stored theme is the same);
        // the store below saves it for every tab (the same value twice is one write)
        dropSurprise();
        if (typeof o.onTheme === 'function') {
          try {
            var asked = o.onTheme(value);
            if (asked && typeof asked.then === 'function') asked.then(null, function () { /* the page says why */ });
          } catch (err) {
            // the page's problem
          }
        }
      }
      commit(f.key, value);
    });

    listen(form, 'input', function (e) {
      if (keyOf(e.target) === 'shortcuts') draftDirty = true;
    });

    listen(dialog, 'click', function (e) {
      var btn = e.target && typeof e.target.closest === 'function' ? e.target.closest('[data-action]') : null;
      if (!btn || !dialog.contains(btn) || btn.disabled) return;
      var action = btn.getAttribute('data-action');
      if (action === 'close') {
        close();
      } else if (action === 'surprise') {
        var got = null;
        try { got = o.onSurprise(); } catch (err) { got = null; /* the page's problem */ }
        if (got && typeof got.then === 'function') got.then(showSurprise, function () {});
        else showSurprise(got);
      } else if (action === 'edit') {
        setEditor(!editorOpen());
      } else if (action === 'add') {
        addItem();
      } else {
        var li = btn.closest('.pcd-panel__item');
        if (!li) return;
        if (action === 'remove') removeItem(li);
        else if (action === 'up') moveItem(li, -1);
        else if (action === 'down') moveItem(li, 1);
      }
    });

    listen(form, 'focusout', function (e) {
      var ref = refs.shortcuts;
      if (!ref || !listStale || draftDirty) return;
      if (e.relatedTarget && ref.list.contains(e.relatedTarget)) return;
      renderShortcuts(current.shortcuts);
    });

    // The sheet's keys are its own: the page's key handlers (the terminal's type-anywhere) never see them. Esc closes
    // the dialog.
    listen(dialog, 'keydown', function (e) {
      e.stopPropagation();
      if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || !own(ARROWS, e.key)) return;
      e.preventDefault();
      moveRow(ARROWS[e.key]);
    });
    // A press and release on the backdrop (outside the box; the box lines are the dialog itself) closes the sheet.
    function onBackdrop(e) {
      if (e.target !== dialog) return false;
      var r = dialog.getBoundingClientRect();
      return e.clientX < r.left || e.clientX >= r.right || e.clientY < r.top || e.clientY >= r.bottom;
    }
    listen(dialog, 'pointerdown', function (e) { downOnBackdrop = onBackdrop(e); });
    listen(dialog, 'click', function (e) {
      if (downOnBackdrop && onBackdrop(e)) close();
      downOnBackdrop = false;
    });
    listen(win, 'resize', function () { if (!placed) relayout(); });
    listen(dialog, 'close', afterClose);
    listen(win, 'pagehide', function () {
      commitTyped();
      flush();
    });

    var unsubscribe = store.subscribe(function (s, info) {
      current = s;
      if (destroyed) return;
      renderValues(s, info && info.source);
      footer();
    });

    // ---- open and close

    function isOpen() {
      return dialog.open === true || (dialog.open === undefined && dialog.hasAttribute('open'));
    }

    function focusFirst() {
      var all = stops();
      if (all.length && typeof all[0].target.focus === 'function') {
        try { all[0].target.focus(); } catch (e) { /* not focusable */ }
      }
    }

    function toggled(on, opener) {
      if (opener && typeof opener.setAttribute === 'function') opener.setAttribute('aria-expanded', on ? 'true' : 'false');
      if (typeof o.onToggle !== 'function') return;
      try { o.onToggle(on); } catch (e) { /* the page's problem */ }
    }

    function open(opener) {
      if (destroyed || isOpen()) return;
      lastOpener = opener || doc.activeElement || null;
      current = store.get();
      if (typeof o.autoName === 'function') {
        try { autoLabel = str(o.autoName()).toLowerCase() || null; } catch (e) { autoLabel = null; }
      }
      Object.keys(refs).forEach(function (k) { note(k, ''); });
      renderShortcuts(current.shortcuts);
      setEditor(false);
      dropSurprise();
      renderValues(current, 'open');
      syncSurprise(); // a surprise running in this tab (from the sheet or the terminal) shows in the theme select
      labelAuto();
      footer();
      dialog.setAttribute('data-open', '1');
      try {
        if (typeof dialog.showModal === 'function') dialog.showModal();
        else dialog.setAttribute('open', '');
      } catch (e) {
        dialog.setAttribute('open', '');
      }
      layout(); // on the grid before the first paint of the open sheet
      focusFirst();
      toggled(true, opener || null);
    }

    function afterClose() {
      dialog.removeAttribute('data-open');
      commitTyped();
      flush();
      var opener = lastOpener;
      lastOpener = null;
      // the page first (it may show what the sheet covered: a hidden element cannot take the focus), then the focus
      toggled(false, opener && opener.hasAttribute && opener.hasAttribute('aria-expanded') ? opener : null);
      var back = null;
      if (typeof o.focusBack === 'function') {
        try { back = o.focusBack(); } catch (e) { back = null; }
      }
      back = back || opener;
      if (back && typeof back.focus === 'function' && doc.contains(back)) {
        try { back.focus(); } catch (e) { /* gone */ }
      }
    }

    function close() {
      if (!isOpen()) return;
      if (typeof dialog.close === 'function' && dialog.open !== undefined) {
        dialog.close();
      } else {
        dialog.removeAttribute('open');
        afterClose();
      }
    }

    // ---- on the character grid

    /** One cell of the sheet's text: the page's (setRect's type), else measured on the sheet's own font. */
    function cellNow() {
      if (type && isObj(type.cell) && type.cell.w > 0 && type.cell.h > 0) return { w: +type.cell.w, h: +type.cell.h, ls: +type.cell.ls || 0 };
      var probe = doc.createElement('span');
      probe.style.cssText = 'position:absolute;left:0;top:0;visibility:hidden;white-space:pre;font:inherit;letter-spacing:0;line-height:normal';
      probe.textContent = rep('M', 20);
      dialog.appendChild(probe);
      var r = probe.getBoundingClientRect();
      dialog.removeChild(probe);
      var dpr = win.devicePixelRatio || 1;
      var adv = r.width > 0 ? r.width / 20 : 8;
      var wDev = Math.max(1, Math.floor(adv * dpr + 1e-6));
      var hDev = Math.max(1, Math.floor((r.height > 0 ? r.height : 16) * dpr + 1e-6));
      return { w: wDev / dpr, h: hDev / dpr, ls: wDev / dpr - adv };
    }

    /** The box lines and the words on the borders, for the sheet's current size in cells. */
    function drawFrame() {
      if (!geo) return;
      var fr = frame(geo.cols, geo.rows, { title: copy.title, tag: copy.close, foot: syncWords || '' });
      frameEl.textContent = fr.lines.join('\n');
      var put = function (el, at) {
        el.hidden = !at;
        if (!at) return;
        el.style.left = at.c * geo.cw + 'px';
        el.style.top = at.r * geo.ch + 'px';
      };
      put(titleEl, fr.title);
      put(closeBtn, fr.tag);
      put(syncEl, fr.foot);
      geo.frame = { title: fr.title, tag: fr.tag, foot: fr.foot };
    }

    /**
     * Size and place the sheet in whole cells: over the rect setRect gave (the console column), else centred, 48 cells
     * wide and as tall as its rows need. Inside the box: the rows from the third line (the second when rows are
     * short), a blank line between settings when there is room for it, else one before each group of settings
     * (GROUP_STARTS, top down) while rows are left, [ done ] on the last line inside the box.
     */
    function layout() {
      if (destroyed || !isOpen()) return;
      var st = dialog.style;
      if (type && type.fontPx > 0) st.setProperty('font-size', type.fontPx + 'px');
      else st.removeProperty('font-size');
      var cell = cellNow();
      var cw = cell.w;
      var ch = cell.h;
      st.setProperty('line-height', ch + 'px');
      st.setProperty('letter-spacing', cell.ls + 'px');
      st.setProperty('--pcd-cw', cw + 'px');
      st.setProperty('--pcd-ch', ch + 'px');
      var vw = win.innerWidth || doc.documentElement.clientWidth || 0;
      var vh = win.innerHeight || doc.documentElement.clientHeight || 0;
      var cols = placed ? Math.floor(placed.w / cw + 1e-6) : Math.min(SHEET_COLS, Math.floor((vw - 2 * cw) / cw));
      cols = Math.max(MIN_COLS, cols);
      var scrolled = rowsEl.scrollTop;
      // the rows' natural height at this width, with no blank lines between them
      var shownRows = Array.prototype.filter.call(rowsEl.children, function (r) { return !r.hidden; });
      shownRows.forEach(function (r) { r.removeAttribute('data-group'); });
      form.style.width = (cols - 4) * cw + 'px';
      rowsEl.style.rowGap = '0px';
      rowsEl.style.height = 'auto';
      form.style.height = 'auto';
      var lines = Math.max(1, Math.round(rowsEl.scrollHeight / ch));
      var shown = shownRows.length;
      var roomy = 1 + lines + Math.max(0, shown - 1) + 1 + 1; // top blank, rows with blank lines, blank, [ done ]
      var rows = placed ? Math.floor(placed.h / ch + 1e-6) : Math.min(2 + roomy, Math.floor((vh - 2 * ch) / ch));
      rows = Math.max(MIN_ROWS, rows);
      var inside = rows - 2;
      var gap = inside >= roomy ? 1 : 0;
      var pad = inside >= 1 + lines + 1 + 1 ? 1 : 0; // the blank lines under the title and above [ done ]
      // no room for a blank line between every row: one before each group of settings, top down, while rows are left
      var spare = inside - pad - lines - pad - 1;
      var groups = 0;
      if (!gap) {
        shownRows.forEach(function (r, i) {
          if (i === 0 || groups >= spare || GROUP_STARTS.indexOf(r.getAttribute('data-key')) < 0) return;
          r.setAttribute('data-group', '');
          groups++;
        });
      }
      var dpr = win.devicePixelRatio || 1;
      var x = placed ? placed.x : Math.round(((vw - cols * cw) / 2) * dpr) / dpr;
      var y = placed ? placed.y : Math.round(((vh - rows * ch) / 2) * dpr) / dpr;
      st.setProperty('position', 'fixed');
      st.setProperty('margin', '0');
      st.setProperty('max-width', 'none');
      st.setProperty('max-height', 'none');
      st.setProperty('left', x + 'px');
      st.setProperty('top', y + 'px');
      st.setProperty('width', cols * cw + 'px');
      st.setProperty('height', rows * ch + 'px');
      form.style.left = 2 * cw + 'px';
      form.style.top = (1 + pad) * ch + 'px';
      form.style.height = (inside - pad) * ch + 'px';
      rowsEl.style.rowGap = gap * ch + 'px';
      rowsEl.style.height = '';
      rowsEl.scrollTop = scrolled;
      footEl.style.marginTop = pad * ch + 'px';
      if (placed) dialog.setAttribute('data-placed', '1');
      else dialog.removeAttribute('data-placed');
      if (gap) dialog.removeAttribute('data-tight');
      else dialog.setAttribute('data-tight', '');
      geo = { cols: cols, rows: rows, cw: cw, ch: ch, ls: cell.ls, x: x, y: y, gap: gap, pad: pad, lines: lines, groups: groups };
      drawFrame();
    }

    function relayout() {
      if (isOpen()) layout();
    }

    /**
     * Place the sheet over a rect (CSS px, viewport coordinates; whole cells are used) in the page's one text size
     * (type { fontPx, cell: { w, h, ls } }: one text size per screen); null: centred in the page's own font.
     */
    function setRect(rect, t) {
      placed = isObj(rect) && rect.w > 0 && rect.h > 0 ? { x: +rect.x || 0, y: +rect.y || 0, w: +rect.w, h: +rect.h } : null;
      type = isObj(t) ? { fontPx: +t.fontPx || 0, cell: isObj(t.cell) ? t.cell : null } : null;
      relayout();
    }

    function state() {
      var values = {};
      list.forEach(function (f) {
        var ref = refs[f.key];
        if (f.kind === 'shortcuts') {
          values[f.key] = readRows();
        } else if (f.kind === 'radio') {
          var on = ref.inputs.filter(function (i) { return i.checked; })[0];
          values[f.key] = on ? toValue(f, on.value) : null;
        } else if (f.kind === 'check') {
          values[f.key] = ref.inputs[0].checked;
        } else if (f.key === 'theme' && ref.inputs[0].value === SURPRISE_RAW) {
          values[f.key] = current[f.key]; // the surprise line shows over the stored theme
        } else {
          values[f.key] = toValue(f, ref.inputs[0].value);
        }
      });
      var notes = {};
      Object.keys(refs).forEach(function (k) { if (!refs[k].note.hidden) notes[k] = refs[k].note.textContent; });
      var themeSel = refs.theme ? refs.theme.inputs[0] : null;
      var surpriseOpt = themeSel && themeSel.value === SURPRISE_RAW ? themeSel.options[themeSel.selectedIndex] : null;
      return {
        open: isOpen(),
        surprise: surpriseOpt ? surpriseOpt.textContent : null,
        area: store.kind,
        keys: list.map(function (f) { return f.key; }),
        rows: Array.prototype.map.call(rowsEl.children, function (r) { return r.getAttribute('data-key'); }),
        values: values,
        notes: notes,
        sync: syncEl.textContent,
        editor: editorOpen(),
        draftDirty: draftDirty,
        listStale: listStale,
        placed: !!placed,
        grid: geo ? { cols: geo.cols, rows: geo.rows, cw: geo.cw, ch: geo.ch, gap: geo.gap, pad: geo.pad, lines: geo.lines,
          groups: geo.groups, frame: frameEl.textContent.split('\n') } : null
      };
    }

    function destroy() {
      if (destroyed) return;
      if (isOpen()) {
        lastOpener = null;
        try { dialog.close(); } catch (e) { dialog.removeAttribute('open'); }
      }
      destroyed = true;
      try { unsubscribe(); } catch (e) { /* gone */ }
      offs.forEach(function (off) { off(); });
      offs = [];
      if (dialog.parentNode) dialog.parentNode.removeChild(dialog);
    }

    renderShortcuts(current.shortcuts);
    renderValues(current, 'mount');
    footer();

    return {
      el: dialog,
      open: open,
      close: close,
      toggle: function (opener) {
        if (isOpen()) close();
        else open(opener);
      },
      isOpen: isOpen,
      contains: function (node) { return !!node && dialog.contains(node); },
      note: note,
      setRect: setRect,
      autoTheme: function (name) {
        autoLabel = str(name).toLowerCase() || null;
        labelAuto();
      },
      refresh: function () {
        current = store.get();
        renderValues(current, 'refresh');
        footer();
      },
      state: state,
      destroy: destroy
    };
  }

  var api = {
    COPY: COPY,
    fields: fields,
    toValue: toValue,
    fromValue: fromValue,
    draftShortcuts: draftShortcuts,
    syncText: syncText,
    editText: editText,
    commandName: commandName,
    frame: frame,
    mergeCopy: mergeCopy,
    mount: mount
  };
  PCD.panel = api;
  return api;
});
