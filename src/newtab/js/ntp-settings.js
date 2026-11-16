/* PixelClock Desktop: the settings schema, one for every piece (the new tab, the wallpaper and the still).
 * Classic script, UMD, global PCD.settings (module.exports in Node). Pure: no DOM, no chrome.*,
 * no storage, no timers, no network, no clock.
 *
 * The new tab keeps these settings in chrome.storage.sync (js/ntp-store.js), the Lively wallpaper
 * maps its Customise panel onto them (src/wallpaper/js/wp-props.js; the wallpaper package ships a
 * copy of this file) and the still can check still.json with them, so every piece shares one set of
 * keys, defaults, limits and rules.
 *
 * Defaults come from the build config (config/user.json: your own values, kept out of git; a
 * neutral config/user.example.json shows the format). The build writes the config into each page
 * with configJs(config) as PCD.CONFIG, so nothing personal is hard-coded here.
 *
 * Settings (scopes: n = new tab, w = wallpaper, s = still):
 *   clock24 bool (config clock "24h")      n w s   theme 'auto' | theme id ('auto')          n w s
 *   city text <= 80 (config city)          n w s   reducedMotion 'auto' | 'on' | 'off'       n w
 *   units 'F' | 'C' (config units)         n w s   performance 'auto' | 'on' | 'off'         n w
 *   sunTimes bool (config, true)           n w s   shortcutsMode 'custom' | 'top'            n
 *   weather bool (config, true)            n w s   shortcuts <= 9 { label <= 24, url <= 300 } n
 *   weatherFx bool (true)                  n w s   focusTerminal bool (true)                 n
 *   clockStatus bool (true)                n       taskbarSpace bool (true)                  w s
 *   shakeHourly bool (true)                w       debugOverlay bool (false)                 w
 * "Surprise me" is an action, not a setting (the new tab's surprise lasts for that tab only).
 * A stored key the schema does not know is dropped on read and removed by the store's next write, quietly. The new
 * tab's links [1]-[9] are the shortcuts, so at most 9 are kept (a longer list keeps its first 9). focusTerminal: the
 * focus redirect in boot.js, on by default.
 *
 * Contract (S = PCD.settings; opts = { config, scope, themes } wherever a function takes opts):
 *   S.VERSION                     1: the "v" field of the stored object
 *   S.KEYS                        frozen [{ key, kind, scopes, label, fallback, config, values?, options?,
 *                                 max? }] in display order (labels and options for panels)
 *   S.keys(scope)                 setting keys of 'newtab' | 'wallpaper' | 'still' (all without a scope)
 *   S.defaults(config, opts)      every setting of opts.scope; a missing or bad config field takes the
 *                                 built-in fallback
 *   S.validate(key, value, opts)  { ok: true, value[, problems] } | { ok: false, error }: lenient input
 *                                 ('24h', 'on', 'celsius'), canonical output
 *   S.normalize(obj, opts)        complete settings: obj over the defaults, unknown keys dropped, bad
 *                                 values replaced by the defaults
 *   S.read(stored, opts)          { settings, stored (migrated), valid, unknown, problems, from, newer,
 *                                 migrated }: the whole read path of a stored object
 *   S.migrate(stored)             { data, from, to, newer, migrated, problems }: older formats upgraded
 *                                 step by step; a newer format (v > VERSION) is left untouched
 *   S.overrides(settings, opts)   { v, ...the keys whose value differs from the default }
 *   S.applyPatch(stored, patch, opts) -> { stored, changed, problems }: the stored object with a patch
 *                                 applied (a patch value equal to its default removes the override);
 *                                 what a newer version wrote is kept, garbage of this version dropped
 *   S.equal(a, b)                 deep equality of setting values
 *   S.normalizeUrl(text)          { ok, url } | { ok: false, reason }: http(s) only; https:// is added
 *                                 to a bare domain, http:// to localhost and 127.x.x.x
 *   S.shortcut(item)              { ok, value: { label, url } } | { ok: false, error } (label from
 *                                 label, alias, name or title; derived from the host when missing)
 *   S.mirror(settings)            { theme, clock24, reducedMotion, performance, focusTerminal, city, units,
 *                                 weather, weatherFx, sunTimes, clockStatus }: the settings part of localStorage
 *                                 'pcd.mirror' (boot.js and the next tab's first frame; the page adds the links it
 *                                 shows, not the settings' list)
 *   S.effectiveTheme(settings, themes)  the pinned id when this build has it, else 'auto'
 *   S.checkConfig(config)         problems with the config fields the settings read ([] = fine)
 *   S.configValues(config)        those config fields (plus taskbarPx), as plain JSON
 *   S.configJs(config)            the text of a classic script that sets PCD.CONFIG (ASCII only)
 * opts.themes: the theme ids this build knows (strings or PCD.engine.menu entries); with it, an
 * unknown pinned theme reads as 'auto', without it any well-formed theme id is accepted.
 */
(function (root, factory) {
  var api = factory(root.PCD || (root.PCD = {}), root);
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (PCD) {
  'use strict';

  var VERSION = 1;
  var CITY_MAX = 80;
  var LABEL_MAX = 24;
  var URL_MAX = 300;
  var SHORTCUTS_MAX = 9; // the console's links [1]-[9]
  var SCOPES = ['newtab', 'wallpaper', 'still'];
  var THEME_ID_RE = /^[a-z][a-z0-9_-]{0,31}$/;
  var N = 'newtab';
  var W = 'wallpaper';
  var T = 'still';

  /**
   * Every setting in display order. fallback: the default when the config has no (valid) value;
   * config: the config fields that give the default, the first one present wins.
   */
  var KEYS = [
    { key: 'clock24', kind: 'clock', fallback: false, config: ['clock', 'clock24'], scopes: [N, W, T], label: '24-hour clock' },
    { key: 'city', kind: 'city', fallback: '', config: ['city'], scopes: [N, W, T], label: 'city', max: CITY_MAX },
    {
      key: 'units', kind: 'enum', values: ['F', 'C'], options: ['fahrenheit', 'celsius'], fallback: 'F', config: ['units'],
      scopes: [N, W, T], label: 'units'
    },
    { key: 'sunTimes', kind: 'bool', fallback: true, config: ['sunTimes'], scopes: [N, W, T], label: 'real sunrise and sunset' },
    { key: 'weather', kind: 'bool', fallback: true, config: ['weather'], scopes: [N, W, T], label: 'weather' },
    { key: 'weatherFx', kind: 'bool', fallback: true, config: ['weatherFx'], scopes: [N, W, T], label: 'weather in the scene' },
    { key: 'theme', kind: 'theme', fallback: 'auto', config: ['theme'], scopes: [N, W, T], label: 'theme' },
    {
      key: 'reducedMotion', kind: 'enum', values: ['auto', 'on', 'off'], options: ['auto (system)', 'on', 'off'], fallback: 'auto',
      config: ['reducedMotion'], scopes: [N, W], label: 'reduced motion'
    },
    {
      key: 'performance', kind: 'enum', values: ['auto', 'on', 'off'], options: ['auto (on battery)', 'on', 'off'], fallback: 'auto',
      config: ['performance'], scopes: [N, W], label: 'performance mode'
    },
    {
      key: 'shortcutsMode', kind: 'enum', values: ['custom', 'top'], options: ['my shortcuts', 'top sites'], fallback: 'custom',
      config: ['shortcutsMode'], scopes: [N], label: 'shortcuts'
    },
    { key: 'shortcuts', kind: 'shortcuts', fallback: [], config: ['shortcuts'], scopes: [N], label: 'my shortcuts', max: SHORTCUTS_MAX },
    { key: 'clockStatus', kind: 'bool', fallback: true, config: ['clockStatus'], scopes: [N], label: 'pixelclock status' },
    { key: 'focusTerminal', kind: 'bool', fallback: true, config: ['focusTerminal'], scopes: [N], label: 'focus the terminal on open' },
    { key: 'shakeHourly', kind: 'bool', fallback: true, config: ['shakeHourly'], scopes: [W], label: 'surprise on the hour' },
    { key: 'taskbarSpace', kind: 'bool', fallback: true, config: ['taskbarSpace'], scopes: [W, T], label: 'keep clear of the taskbar' },
    { key: 'debugOverlay', kind: 'bool', fallback: false, config: ['debugOverlay'], scopes: [W], label: 'debug overlay' }
  ];

  function deepFreeze(o) {
    if (o && typeof o === 'object' && !Object.isFrozen(o)) {
      Object.keys(o).forEach(function (k) { deepFreeze(o[k]); });
      Object.freeze(o);
    }
    return o;
  }
  deepFreeze(KEYS);

  var BY_KEY = Object.create(null);
  KEYS.forEach(function (d) { BY_KEY[d.key] = d; });

  /** Lenient words for the enums (lower case); the canonical values themselves always pass. */
  var TRI = { auto: 'auto', on: 'on', off: 'off', 'true': 'on', 'false': 'off' };
  var ALIASES = {
    units: { f: 'F', fahrenheit: 'F', imperial: 'F', c: 'C', celsius: 'C', metric: 'C' },
    reducedMotion: TRI,
    performance: TRI,
    shortcutsMode: { custom: 'custom', top: 'top', 'top sites': 'top', topsites: 'top' }
  };

  // ------------------------------------------------------------------------------------------ helpers

  function isObj(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
  function own(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }

  function spec(key) {
    return typeof key === 'string' && own(BY_KEY, key) ? BY_KEY[key] : null;
  }

  function inScope(d, scope) { return !scope || d.scopes.indexOf(scope) >= 0; }

  function keys(scope) {
    checkScope(scope);
    return KEYS.filter(function (d) { return inScope(d, scope); }).map(function (d) { return d.key; });
  }

  function checkScope(scope) {
    if (scope !== undefined && scope !== null && SCOPES.indexOf(scope) < 0) {
      throw new Error('PCD.settings: unknown scope ' + JSON.stringify(scope) + ' (use ' + SCOPES.join(', ') + ')');
    }
  }

  /** A JSON copy (settings values are plain JSON). */
  function clone(v) { return v === undefined ? undefined : JSON.parse(JSON.stringify(v)); }

  function equal(a, b) {
    if (a === b) return true;
    if (Array.isArray(a)) {
      if (!Array.isArray(b) || a.length !== b.length) return false;
      for (var i = 0; i < a.length; i++) if (!equal(a[i], b[i])) return false;
      return true;
    }
    if (isObj(a) && isObj(b)) {
      var ka = Object.keys(a);
      if (ka.length !== Object.keys(b).length) return false;
      for (var j = 0; j < ka.length; j++) if (!own(b, ka[j]) || !equal(a[ka[j]], b[ka[j]])) return false;
      return true;
    }
    return false;
  }

  /** A regex character class from code points and [from, to] ranges (built from numbers, so this
   *  source stays plain ASCII). */
  function charClass(list) {
    function esc(cp) { return '\\u' + ('000' + cp.toString(16)).slice(-4); }
    return list.map(function (r) { return typeof r === 'number' ? esc(r) : esc(r[0]) + '-' + esc(r[1]); }).join('');
  }

  // C0 and C1 controls, DEL and the line/paragraph separators become spaces; bidi controls, zero-width
  // marks and the BOM go: one clean line of text.
  var CTRL_RE = new RegExp('[' + charClass([[0x00, 0x1f], [0x7f, 0x9f], 0x2028, 0x2029]) + ']', 'g');
  var INVISIBLE_RE = new RegExp('[' + charClass([0xad, [0x200b, 0x200f], [0x202a, 0x202e], [0x2060, 0x2064], [0x2066, 0x2069], 0xfeff]) + ']', 'g');

  function cleanLine(s) {
    return String(s).replace(INVISIBLE_RE, '').replace(CTRL_RE, ' ').replace(/\s+/g, ' ').trim();
  }

  function charCount(s) { return Array.from(s).length; }

  function cut(s, n) {
    var a = Array.from(s);
    return a.length > n ? a.slice(0, n).join('') : s;
  }

  /** Short, one-line text for messages. */
  function show(v) {
    var s = typeof v === 'string' ? v : JSON.stringify(v);
    return cut(cleanLine(s === undefined ? String(v) : s), 40);
  }

  function good(value, problems) {
    return problems && problems.length ? { ok: true, value: value, problems: problems } : { ok: true, value: value };
  }

  function bad(error) { return { ok: false, error: error }; }

  /** The ids of opts.themes (strings or { id } entries, 'auto' left out), or null = any well-formed id. */
  function themeIds(list) {
    if (!Array.isArray(list)) return null;
    var out = [];
    list.forEach(function (t) {
      var id = typeof t === 'string' ? t : isObj(t) ? t.id : null;
      if (typeof id === 'string' && id !== 'auto' && THEME_ID_RE.test(id) && out.indexOf(id) < 0) out.push(id);
    });
    return out.length ? out : null;
  }

  function options(opts) {
    var o = isObj(opts) ? opts : {};
    checkScope(o.scope);
    return { config: isObj(o.config) ? o.config : {}, scope: o.scope || null, themes: themeIds(o.themes) };
  }

  // ------------------------------------------------------------------------------------- shortcut URLs

  var SCHEME_SLASHES_RE = /^([a-z][a-z0-9+.-]*):\/\//i;
  var SCHEME_RE = /^([a-z][a-z0-9+.-]*):/i;
  var OCTET = '(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)';
  var IPV4_RE = new RegExp('^' + OCTET + '(?:\\.' + OCTET + '){3}$');
  var LABEL_RE = /^[\p{L}\p{M}\p{N}_-]{1,63}$/u;
  var TLD_RE = /^(?:[\p{L}\p{M}]{2,63}|xn--[a-z0-9-]{1,59})$/iu;

  function isDomain(host) {
    var h = host.charAt(host.length - 1) === '.' ? host.slice(0, -1) : host;
    if (!h || h.length > 253) return false;
    var labels = h.split('.');
    if (labels.length < 2) return false;
    for (var i = 0; i < labels.length; i++) {
      var l = labels[i];
      if (!LABEL_RE.test(l) || l.charAt(0) === '-' || l.charAt(l.length - 1) === '-') return false;
    }
    return TLD_RE.test(labels[labels.length - 1]);
  }

  /** 'local' | 'ip' | 'domain' for scheme-less text shaped like host[:port][/path], else null. */
  function bareKind(t) {
    var cutAt = t.search(/[/?#\\]/);
    var authority = cutAt < 0 ? t : t.slice(0, cutAt);
    if (!authority || authority.indexOf('@') >= 0) return null;
    var m = /^(.+?)(?::(\d{1,5}))?$/.exec(authority);
    if (!m) return null;
    var host = m[1].toLowerCase();
    var bare = host.charAt(host.length - 1) === '.' ? host.slice(0, -1) : host;
    if (bare === 'localhost' || (/\.localhost$/.test(bare) && isDomain(bare))) return 'local';
    if (IPV4_RE.test(host)) return host.indexOf('127.') === 0 ? 'local' : 'ip';
    return isDomain(host) ? 'domain' : null;
  }

  function urlFail(reason) { return { ok: false, reason: reason }; }

  function normalizeUrl(text) {
    if (typeof text !== 'string') return urlFail('type an address, e.g. example.com');
    var t = text.trim();
    if (!t) return urlFail('type an address, e.g. example.com');
    if (/\s/.test(t)) return urlFail('an address cannot contain spaces');
    var kind = SCHEME_SLASHES_RE.test(t) ? null : bareKind(t);
    var candidate;
    if (kind) {
      candidate = (kind === 'local' ? 'http://' : 'https://') + t;
    } else {
      var m = SCHEME_RE.exec(t);
      if (!m) return urlFail('that does not look like a web address (try example.com)');
      var scheme = m[1].toLowerCase();
      if (scheme !== 'http' && scheme !== 'https') return urlFail('only http and https addresses work here, not ' + scheme + ':');
      candidate = t;
    }
    var u;
    try {
      u = new URL(candidate);
    } catch (e) {
      return urlFail('that address is not valid');
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return urlFail('only http and https addresses work here');
    if (!u.hostname) return urlFail('that address has no host name');
    if (u.username || u.password) return urlFail('addresses with a user name or password are not allowed');
    var url = u.href;
    // a bare host keeps no trailing slash: typed "example.com" gives no "/" after the host either
    if (u.pathname === '/' && !u.search && !u.hash && url.charAt(url.length - 1) === '/' && !/[/?#]$/.test(t)) url = url.slice(0, -1);
    if (url.length > URL_MAX) return urlFail('that address is too long (' + URL_MAX + ' characters at most)');
    return { ok: true, url: url };
  }

  /** A label from the host when a shortcut has none: "www.example.com" -> "example.com". */
  function hostLabel(url) {
    try {
      return cut(new URL(url).hostname.replace(/^www\./, ''), LABEL_MAX);
    } catch (e) {
      return '';
    }
  }

  function firstString(o, names) {
    for (var i = 0; i < names.length; i++) {
      var v = o[names[i]];
      if (typeof v === 'string' || (typeof v === 'number' && isFinite(v))) return String(v);
    }
    return null;
  }

  function shortcut(item) {
    if (!isObj(item)) return bad('a shortcut is { label, url }');
    var typed = firstString(item, ['label', 'alias', 'name', 'title']);
    var u = normalizeUrl(item.url);
    if (!u.ok) return bad((typed ? '"' + show(typed) + '": ' : '') + u.reason);
    var label = typed === null ? '' : cleanLine(typed);
    if (!label) label = hostLabel(u.url);
    if (!label) return bad('a shortcut needs a label');
    if (charCount(label) > LABEL_MAX) return bad('the label "' + show(label) + '" is too long (' + LABEL_MAX + ' characters at most)');
    return good({ label: label, url: u.url });
  }

  // ---------------------------------------------------------------------------------------- validation

  function toBool(v) {
    if (v === true || v === false) return v;
    if (v === 1 || v === 0) return v === 1;
    if (typeof v === 'string') {
      var s = v.trim().toLowerCase();
      if (s === 'true' || s === 'on' || s === 'yes' || s === '1') return true;
      if (s === 'false' || s === 'off' || s === 'no' || s === '0') return false;
    }
    return null;
  }

  function toClock24(v) {
    if (v === 24 || v === 12) return v === 24;
    if (typeof v === 'string') {
      var s = v.trim().toLowerCase();
      if (s === '24' || s === '24h') return true;
      if (s === '12' || s === '12h') return false;
    }
    return toBool(v);
  }

  function toEnum(d, v) {
    if (typeof v === 'boolean' && d.values.indexOf('on') >= 0) return v ? 'on' : 'off';
    if (typeof v !== 'string') return null;
    var s = v.trim();
    if (d.values.indexOf(s) >= 0) return s;
    var words = ALIASES[d.key];
    var l = s.toLowerCase().replace(/\s+/g, ' ');
    return words && own(words, l) ? words[l] : null;
  }

  function toShortcuts(v) {
    if (!Array.isArray(v)) return bad('shortcuts are a list of { label, url }');
    var out = [];
    var problems = [];
    var extra = 0;
    v.forEach(function (item, i) {
      var r = shortcut(item);
      if (!r.ok) problems.push('skipped shortcut ' + (i + 1) + ': ' + r.error);
      else if (out.length >= SHORTCUTS_MAX) extra++;
      else out.push(r.value);
    });
    if (v.length && !out.length) return bad('no usable shortcut (' + problems[0] + ')');
    if (extra) problems.push('kept the first ' + SHORTCUTS_MAX + ' shortcuts, dropped ' + extra);
    return good(out, problems);
  }

  function validateWith(d, value, o) {
    var r;
    switch (d.kind) {
      case 'bool':
        r = toBool(value);
        return r === null ? bad('use on or off (true or false)') : good(r);
      case 'clock':
        r = toClock24(value);
        return r === null ? bad('use 12h or 24h') : good(r);
      case 'enum':
        r = toEnum(d, value);
        return r === null ? bad('use ' + d.values.join(', ')) : good(r);
      case 'city': {
        if (typeof value === 'number' && isFinite(value)) value = String(value);
        if (typeof value !== 'string') return bad('type a city name, e.g. Berlin');
        var city = cleanLine(value);
        if (charCount(city) > CITY_MAX) return bad('that city name is too long (' + CITY_MAX + ' characters at most)');
        return good(city);
      }
      case 'theme': {
        if (typeof value !== 'string') return bad('a theme is "auto" or a theme id');
        var id = value.trim().toLowerCase();
        if (id === 'auto') return good('auto');
        if (!THEME_ID_RE.test(id)) return bad('"' + show(value) + '" is not a theme id');
        if (o.themes && o.themes.indexOf(id) < 0) return bad('unknown theme "' + id + '"');
        return good(id);
      }
      case 'shortcuts':
        return toShortcuts(value);
      default:
        return bad('no rule for ' + d.kind);
    }
  }

  function validate(key, value, opts) {
    var d = spec(key);
    if (!d) return bad('unknown setting "' + show(key) + '"');
    return validateWith(d, value, options(opts));
  }

  // ------------------------------------------------------------------------------------------ defaults

  function defaultsFor(o) {
    var c = o.config;
    var out = {};
    KEYS.forEach(function (d) {
      if (!inScope(d, o.scope)) return;
      var v = clone(d.fallback);
      for (var i = 0; i < d.config.length; i++) {
        var f = d.config[i];
        if (!own(c, f) || c[f] === undefined || c[f] === null) continue;
        var r = validateWith(d, c[f], o);
        if (r.ok) v = r.value;
        break;
      }
      out[d.key] = v;
    });
    return out;
  }

  function defaults(config, opts) {
    var o = options(opts);
    if (config !== undefined) o.config = isObj(config) ? config : {};
    return defaultsFor(o);
  }

  // ------------------------------------------------------------------------------ normalize and read

  function merge(obj, o) {
    var settings = defaultsFor(o);
    var valid = {};
    var unknown = {};
    var problems = [];
    if (obj === undefined || obj === null) return { settings: settings, valid: valid, unknown: unknown, problems: problems };
    if (!isObj(obj)) {
      problems.push('the settings are not an object; ignored');
      return { settings: settings, valid: valid, unknown: unknown, problems: problems };
    }
    Object.keys(obj).forEach(function (k) {
      if (k === 'v') return;
      var d = spec(k);
      if (!d || !inScope(d, o.scope)) {
        unknown[k] = obj[k];
        problems.push('ignored unknown setting "' + show(k) + '"');
        return;
      }
      var r = validateWith(d, obj[k], o);
      if (!r.ok) {
        problems.push(k + ': ' + r.error + '; using the default');
        return;
      }
      settings[k] = r.value;
      valid[k] = r.value;
      if (r.problems) r.problems.forEach(function (p) { problems.push(k + ': ' + p); });
    });
    return { settings: settings, valid: valid, unknown: unknown, problems: problems };
  }

  function normalize(obj, opts) {
    return merge(obj, options(opts)).settings;
  }

  // ------------------------------------------------------------------------------------------ migration

  function versionOf(v) {
    if (typeof v === 'number' && isFinite(v) && Math.floor(v) === v && v >= 0) return v;
    if (typeof v === 'string' && /^\d{1,6}$/.test(v.trim())) return Number(v.trim());
    return 0;
  }

  function moveKey(o, from, to) {
    if (!own(o, from)) return;
    if (!own(o, to)) o[to] = o[from];
    delete o[from];
  }

  /**
   * v0 (no "v": drafts and older flat objects) -> v1: clock '12h' | '24h' -> clock24,
   * hour12 -> clock24, sites / links ([{ alias, url }]) -> shortcuts, reduceMotion -> reducedMotion,
   * performanceMode -> performance; a v0 switch that is off meant "not forced", so false -> 'auto'.
   */
  function fromV0(o) {
    var out = {};
    Object.keys(o).forEach(function (k) { if (k !== 'v' && k !== 'version') out[k] = o[k]; });
    moveKey(out, 'clock', 'clock24');
    if (own(out, 'hour12')) {
      var h12 = toBool(out.hour12);
      if (!own(out, 'clock24') && h12 !== null) out.clock24 = !h12;
      delete out.hour12;
    }
    moveKey(out, 'sites', 'shortcuts');
    moveKey(out, 'links', 'shortcuts');
    moveKey(out, 'reduceMotion', 'reducedMotion');
    moveKey(out, 'performanceMode', 'performance');
    ['reducedMotion', 'performance'].forEach(function (k) { if (out[k] === false) out[k] = 'auto'; });
    return out;
  }

  /** MIGRATIONS[n] turns version n into version n + 1. */
  var MIGRATIONS = [fromV0];

  function migrate(stored) {
    if (stored === undefined || stored === null) return { data: {}, from: null, to: VERSION, newer: false, migrated: false, problems: [] };
    if (!isObj(stored)) {
      return { data: {}, from: null, to: VERSION, newer: false, migrated: false, problems: ['the stored settings are not an object; ignored'] };
    }
    var v = versionOf(stored.v);
    if (v > VERSION) return { data: clone(stored), from: v, to: v, newer: true, migrated: false, problems: [] };
    var data = clone(stored);
    var from = v;
    while (v < VERSION) {
      data = MIGRATIONS[v](data);
      v++;
    }
    data.v = VERSION;
    return { data: data, from: from, to: VERSION, newer: false, migrated: from !== VERSION, problems: [] };
  }

  function read(stored, opts) {
    var o = options(opts);
    var m = migrate(stored);
    var r = merge(m.data, o);
    return {
      settings: r.settings,
      stored: m.data,
      valid: r.valid,
      unknown: r.unknown,
      problems: m.problems.concat(r.problems),
      from: m.from,
      newer: m.newer,
      migrated: m.migrated
    };
  }

  // ------------------------------------------------------------------------------- what gets stored

  function overrides(settings, opts) {
    var o = options(opts);
    var defs = defaultsFor(o);
    var s = merge(settings, o).settings;
    var out = { v: VERSION };
    KEYS.forEach(function (d) {
      if (inScope(d, o.scope) && !equal(s[d.key], defs[d.key])) out[d.key] = clone(s[d.key]);
    });
    return out;
  }

  /**
   * The stored object after a patch. Keys are rewritten in canonical form and order: v first, then
   * KEYS order, then (newer versions only) the keys this version does not know. A patch value that
   * equals the default removes the override, so the key follows the config again.
   * Kept as stored: everything when the stored object comes from a newer version, and a well-formed
   * theme id this build does not have (another build may). Dropped: unknown keys and bad values of
   * this version or older.
   */
  function applyPatch(stored, patch, opts) {
    var o = options(opts);
    var m = migrate(stored);
    var base = m.data;
    var defs = defaultsFor(o);
    var kept = {};
    var problems = m.problems.slice();
    var changed = [];
    Object.keys(base).forEach(function (k) {
      if (k === 'v') return;
      var d = spec(k);
      if (!d || !inScope(d, o.scope)) {
        if (m.newer) kept[k] = base[k];
        else problems.push('dropped unknown setting "' + show(k) + '"');
        return;
      }
      var r = validateWith(d, base[k], o);
      if (r.ok) kept[k] = r.value;
      else if (m.newer || (d.kind === 'theme' && typeof base[k] === 'string' && THEME_ID_RE.test(base[k]))) kept[k] = base[k];
      else problems.push('dropped ' + k + ': ' + r.error);
    });
    if (isObj(patch)) {
      Object.keys(patch).forEach(function (k) {
        if (k === 'v') return;
        var d = spec(k);
        if (!d || !inScope(d, o.scope)) {
          problems.push('patch: unknown setting "' + show(k) + '"');
          return;
        }
        var r = validateWith(d, patch[k], o);
        if (!r.ok) {
          problems.push('patch: ' + k + ': ' + r.error);
          return;
        }
        var before = own(kept, k) ? kept[k] : undefined;
        if (equal(r.value, defs[k])) delete kept[k];
        else kept[k] = r.value;
        if (!equal(before, kept[k])) changed.push(k);
      });
    }
    var out = { v: m.newer ? m.from : VERSION };
    KEYS.forEach(function (d) { if (own(kept, d.key)) out[d.key] = kept[d.key]; });
    Object.keys(kept).forEach(function (k) { if (!own(out, k)) out[k] = kept[k]; });
    return { stored: out, changed: changed, problems: problems };
  }

  // --------------------------------------------------------------------------------------- page helpers

  /** The settings the next tab needs before its store answers: boot.js (motion, the focus redirect) and the first
   *  frame (the scene, the clock, the city, units, weather and sun times that decide the weather block, the weather
   *  in the scene, and whether the clock's status line may show). */
  var MIRROR_KEYS = ['theme', 'clock24', 'reducedMotion', 'performance', 'focusTerminal', 'city', 'units', 'weather', 'weatherFx',
    'sunTimes', 'clockStatus'];

  function mirror(settings) {
    var s = isObj(settings) ? settings : {};
    var d = defaultsFor(options({}));
    var out = {};
    MIRROR_KEYS.forEach(function (k) {
      var r = own(s, k) ? validateWith(BY_KEY[k], s[k], options({})) : null;
      out[k] = r && r.ok ? r.value : d[k];
    });
    return out;
  }

  function effectiveTheme(settings, themes) {
    var id = isObj(settings) && typeof settings.theme === 'string' ? settings.theme : 'auto';
    var ids = themeIds(themes);
    return id !== 'auto' && ids && ids.indexOf(id) >= 0 ? id : 'auto';
  }

  // ----------------------------------------------------------------------------------------- config

  /** Config fields the defaults read, plus taskbarPx (the band the wallpapers keep clear of the taskbar; not a setting). */
  var CONFIG_FIELDS = (function () {
    var out = [];
    KEYS.forEach(function (d) { d.config.forEach(function (f) { if (out.indexOf(f) < 0) out.push(f); }); });
    out.push('taskbarPx');
    return out;
  })();

  function checkConfig(config) {
    if (!isObj(config)) return ['the config is not an object'];
    var problems = [];
    var o = options({ config: config });
    KEYS.forEach(function (d) {
      d.config.forEach(function (f) {
        if (!own(config, f) || config[f] === undefined) return;
        var r = validateWith(d, config[f], o);
        if (!r.ok) problems.push(f + ': ' + r.error);
        else if (r.problems) r.problems.forEach(function (p) { problems.push(f + ': ' + p); });
      });
    });
    if (own(config, 'taskbarPx')) {
      var t = config.taskbarPx;
      if (!(typeof t === 'number' && Math.floor(t) === t && t >= 0 && t <= 200)) problems.push('taskbarPx: use a whole number from 0 to 200');
    }
    return problems;
  }

  function configValues(config) {
    var c = isObj(config) ? config : {};
    var out = {};
    CONFIG_FIELDS.forEach(function (f) {
      if (!own(c, f) || c[f] === undefined) return;
      var v = clone(c[f]);
      if (v !== undefined) out[f] = v;
    });
    return out;
  }

  /** JSON with everything outside printable ASCII escaped, and < > & too: safe in any page or file. */
  function asciiJson(value) {
    return JSON.stringify(value, null, 2).replace(/[^\x20-\x7e\n]|[<>&]/g, function (ch) {
      return '\\u' + ('0000' + ch.charCodeAt(0).toString(16)).slice(-4);
    });
  }

  function configJs(config) {
    var json = asciiJson(configValues(config));
    return [
      '/* PixelClock Desktop: the build config (generated from config/user.json by PCD.settings.configJs;',
      ' * do not edit). PCD.settings.defaults(PCD.CONFIG, { scope }) gives the defaults of every setting. */',
      '(function (root) {',
      '  var PCD = root.PCD || (root.PCD = {});',
      '  PCD.CONFIG = ' + json.split('\n').join('\n  ') + ';',
      "  if (typeof module === 'object' && module.exports) module.exports = PCD.CONFIG;",
      "})(typeof globalThis !== 'undefined' ? globalThis : this);",
      ''
    ].join('\n');
  }

  var api = {
    VERSION: VERSION,
    CITY_MAX: CITY_MAX,
    LABEL_MAX: LABEL_MAX,
    URL_MAX: URL_MAX,
    SHORTCUTS_MAX: SHORTCUTS_MAX,
    SCOPES: SCOPES.slice(),
    THEME_ID_RE: THEME_ID_RE,
    KEYS: KEYS,
    CONFIG_FIELDS: CONFIG_FIELDS,
    keys: keys,
    spec: spec,
    defaults: defaults,
    validate: validate,
    normalize: normalize,
    read: read,
    migrate: migrate,
    overrides: overrides,
    applyPatch: applyPatch,
    equal: equal,
    clone: clone,
    cleanLine: cleanLine,
    normalizeUrl: normalizeUrl,
    shortcut: shortcut,
    mirror: mirror,
    effectiveTheme: effectiveTheme,
    checkConfig: checkConfig,
    configValues: configValues,
    configJs: configJs,
    asciiJson: asciiJson
  };
  PCD.settings = api;
  return api;
});
