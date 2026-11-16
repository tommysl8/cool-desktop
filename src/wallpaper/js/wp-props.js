/* PixelClock Desktop wallpaper: the Lively "Customise" panel (LivelyProperties.json) over the one
 * settings schema, and the mapper from livelyPropertyListener(name, value) to those settings.
 * Classic script, UMD, global PCD.wpProps (module.exports in Node). Needs, when
 * called: PCD.settings (js/ntp-settings.js, copied into the package from src/newtab/js) or
 * opts.schema, and the theme menu (opts.menu, else PCD.engine.menu(globalThis.PixelClock)).
 *
 * The build generates LivelyProperties.json with buildProperties(config, { menu }) from the same
 * config the page gets as PCD.CONFIG, so the panel, the page defaults and the docs cannot drift.
 *
 * Lively's rules (learned the hard way, Store build 20262.5.6.0):
 * - Control types: slider, textbox, dropdown, folderDropdown, button, label, color, checkbox. One
 *   unknown type and NO property loads. Every control has "type" and "value"; all but labels need
 *   "text"; no other keys. Keys start with a lower-case letter and hold only letters and digits (no
 *   dots). The file is strict JSON.
 * - What the page receives: dropdown -> the item index, checkbox -> a boolean, slider -> a number,
 *   textbox -> a string on EVERY keystroke (debounced here, 1.5 s), button -> true, label -> never.
 * - After load Lively replays every saved value except buttons and labels, in any order, maybe before
 *   the app is ready, and an old saved copy may lack newer keys: the page renders its defaults first,
 *   every key has a default, and during the settle window after load (createRouter's immediate())
 *   replayed textboxes apply at once.
 *
 * Panel -> settings: each control drives one setting. Two need care:
 *   reducedMotion  checked -> 'on'; unchecked -> 'auto' (the system decides), or 'off' when the
 *                  config default is 'off'
 *   performance    "Performance mode" checked -> 'on'; else "Performance mode on battery"
 *                  (lowPowerOnBattery) checked -> 'auto', unchecked -> 'off'
 * The mapper keeps the panel's control values, so the replay order does not matter.
 * Buttons are actions, not settings: surprise, shakeNow, refreshWeather.
 *
 * The wallpaper's settings are the shared schema's 'wallpaper' scope seen through schemaFor(), which adds
 *   LOCAL_KEYS  settings only the wallpaper has, in the schema's KEYS shape: side ('right' | 'left', default
 *               'right'), the side of the screen the info column takes (the scene fills the desktop and the
 *               column sits on the right by default, away from the desktop icons; a Lively property may flip
 *               it). A key the shared schema defines itself wins over the local one.
 * A name no control has is refused as an unknown property and counted as ignored. The panel uses no slider;
 * checkProperties still knows Lively's slider rules, so a hand-edited copy is checked like any other.
 *
 * Contract (P = PCD.wpProps; opts = { config, menu, schema }):
 *   P.CONTROL_TYPES, P.TYPE_KEYS, P.TYPE_REQUIRED, P.KEY_RE   Lively's schema rules
 *   P.CONTROLS          [{ k, type, text?, value? (labels, buttons), setting? }] in Customise order
 *   P.STATE_CONTROLS    names of the controls that carry a value (not labels or buttons)
 *   P.BUTTONS, P.TEXTS (name -> text, the docs quote them), P.DEBOUNCE_MS 1500, P.SETTLE_MS 2500
 *   P.LOCAL_KEYS, P.SIDES ['right', 'left']
 *   P.schemaFor(S) -> the wallpaper's schema: S (PCD.settings) plus LOCAL_KEYS, with the same members (KEYS,
 *                     keys, spec, defaults, validate, normalize, clone, equal, cleanLine, ...)
 *   P.settingKeys(opts) -> the wallpaper's setting keys in schema order
 *   P.themeMenu(opts) -> [{ id, name }]          'auto' first
 *   P.defaults(config, opts) -> settings          the wallpaper schema's defaults, scope 'wallpaper'
 *   P.controlValues(settings, opts) -> { name: Lively value } for every state control
 *   P.buildProperties(config, opts) -> the LivelyProperties.json object (keys in Customise order)
 *   P.checkProperties(props) -> problems          Lively's schema rules ([] = loadable)
 *   P.checkPropertiesContent(props, opts) -> problems   props equal buildProperties(opts.config, opts)
 *   P.coerce(name, raw, opts) -> { ok, name, kind: 'value'|'action', value } | { ok: false, name, reason }
 *   P.createMapper(opts) -> { coerce, commit(name, value) -> { key, value }, property(name, raw),
 *                             state(), controls() }
 *   P.stateFromProperties(props, opts) -> settings   what the page holds after Lively replays props
 *   P.createRouter(opts) -> { property(name, raw), flush(), suspend(), resume(), pending(), counts, mapper }
 *     opts.apply(key, value, name)   a setting changed (textboxes debounced)
 *     opts.action(name)              a button
 *     opts.setTimer(id, fn, ms) / opts.clearTimer(id)   named timers (the app counts and stops them)
 *     opts.immediate()               true during the settle window: textboxes apply at once
 *     opts.debounceMs                default 1500
 */
(function (root, factory) {
  var api = factory(root.PCD || (root.PCD = {}), root);
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (PCD, root) {
  'use strict';

  /** Lively's control types: one unknown type and no property loads. */
  var CONTROL_TYPES = ['slider', 'textbox', 'dropdown', 'folderDropdown', 'button', 'label', 'color', 'checkbox'];
  /** Keys each type may carry (Lively's schema: additionalProperties false). */
  var TYPE_KEYS = {
    slider: ['type', 'text', 'value', 'min', 'max', 'step', 'help'],
    textbox: ['type', 'text', 'value', 'help'],
    dropdown: ['type', 'text', 'value', 'items', 'help'],
    folderDropdown: ['type', 'text', 'value', 'filter', 'folder', 'help'],
    button: ['type', 'text', 'value', 'help'],
    label: ['type', 'value', 'help'],
    color: ['type', 'text', 'value', 'help'],
    checkbox: ['type', 'text', 'value', 'help']
  };
  /** Keys each type must carry. */
  var TYPE_REQUIRED = {
    slider: ['type', 'text', 'value', 'min', 'max', 'step'],
    textbox: ['type', 'text', 'value'],
    dropdown: ['type', 'text', 'value', 'items'],
    folderDropdown: ['type', 'text', 'value', 'filter', 'folder'],
    button: ['type', 'text', 'value'],
    label: ['type', 'value'],
    color: ['type', 'text', 'value'],
    checkbox: ['type', 'text', 'value']
  };
  var KEY_RE = /^[a-z][A-Za-z0-9]*$/;
  var DEBOUNCE_MS = 1500;
  var SETTLE_MS = 2500;

  /** The sides the info column can take; the first is the default. */
  var SIDES = ['right', 'left'];
  /**
   * Settings only the wallpaper has (the shared schema's KEYS shape; enums only). No config field feeds them
   * (config/user.json has none): the default is the fallback, and Lively replays your choice.
   */
  var LOCAL_KEYS = [
    { key: 'side', kind: 'enum', values: SIDES, options: ['right', 'left'], fallback: 'right', config: [], scopes: ['wallpaper'], label: 'column side' }
  ];

  /**
   * The Customise panel in display order (types used: label, dropdown, button, checkbox, textbox).
   * "text" is fixed: INSTALL.md quotes it. setting = the settings key the control drives.
   */
  var CONTROLS = [
    { k: 'sceneLabel', type: 'label', value: '-- Scene --' },
    { k: 'theme', type: 'dropdown', text: 'Theme', setting: 'theme' },
    { k: 'surprise', type: 'button', text: 'Surprise me', value: 'Surprise' },
    { k: 'shakeNow', type: 'button', text: 'Shake', value: 'Shake' },
    { k: 'shakeHourly', type: 'checkbox', text: 'Surprise on the hour (10 am to midnight)', setting: 'shakeHourly' },
    { k: 'timeLabel', type: 'label', value: '-- Time and weather --' },
    { k: 'clock24', type: 'checkbox', text: '24-hour clock', setting: 'clock24' },
    { k: 'sunTimes', type: 'checkbox', text: 'Follow the real sunrise and sunset', setting: 'sunTimes' },
    { k: 'city', type: 'textbox', text: 'City', setting: 'city' },
    { k: 'units', type: 'dropdown', text: 'Units', setting: 'units', items: ['Fahrenheit', 'Celsius'], values: ['F', 'C'] },
    { k: 'weather', type: 'checkbox', text: 'Show weather', setting: 'weather' },
    { k: 'weatherFx', type: 'checkbox', text: 'Weather in the scene', setting: 'weatherFx' },
    { k: 'refreshWeather', type: 'button', text: 'Refresh weather', value: 'Refresh' },
    { k: 'motionLabel', type: 'label', value: '-- Motion and power --' },
    { k: 'reducedMotion', type: 'checkbox', text: 'Reduced motion', setting: 'reducedMotion' },
    { k: 'performance', type: 'checkbox', text: 'Performance mode (15 fps)', setting: 'performance' },
    { k: 'lowPowerOnBattery', type: 'checkbox', text: 'Performance mode on battery', setting: 'performance' },
    { k: 'deskLabel', type: 'label', value: '-- Desktop --' },
    { k: 'side', type: 'dropdown', text: 'Column side', setting: 'side', items: ['Right', 'Left'], values: SIDES },
    { k: 'taskbarSpace', type: 'checkbox', text: 'Keep clear of the taskbar', setting: 'taskbarSpace' },
    { k: 'debugOverlay', type: 'checkbox', text: 'Debug overlay', setting: 'debugOverlay' }
  ];
  [CONTROLS, LOCAL_KEYS].forEach(function freeze(o) {
    if (o && typeof o === 'object') {
      Object.keys(o).forEach(function (k) { freeze(o[k]); });
      Object.freeze(o);
    }
  });

  var BY_NAME = Object.create(null);
  CONTROLS.forEach(function (c) { BY_NAME[c.k] = c; });
  var STATE_CONTROLS = CONTROLS.filter(function (c) { return c.setting; }).map(function (c) { return c.k; });
  var BUTTONS = CONTROLS.filter(function (c) { return c.type === 'button'; }).map(function (c) { return c.k; });
  var TEXTS = {};
  CONTROLS.forEach(function (c) { if (c.text) TEXTS[c.k] = c.text; });

  function isObj(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
  function own(o, k) { return !!o && typeof k === 'string' && Object.prototype.hasOwnProperty.call(o, k); }

  /** The control for a property name, or null (never an Object.prototype member such as "toString"). */
  function control(name) {
    return typeof name === 'string' && own(BY_NAME, name) ? BY_NAME[name] : null;
  }

  // ------------------------------------------------------------------------------ the wallpaper's schema

  var WRAPPED = '__pcdWallpaperSchema';

  /**
   * The wallpaper's view of a settings schema (PCD.settings): every member of S, with LOCAL_KEYS added to KEYS,
   * keys(), spec(), defaults(), validate() and normalize(). Idempotent.
   */
  function schemaFor(S) {
    if (!S || typeof S.defaults !== 'function') throw new Error('PCD.wpProps: load js/ntp-settings.js first (or pass opts.schema)');
    if (S[WRAPPED]) return S;
    var local = LOCAL_KEYS.filter(function (d) { return !S.spec(d.key); });
    var byKey = Object.create(null);
    local.forEach(function (d) { byKey[d.key] = d; });
    var isLocal = function (k) { return typeof k === 'string' && own(byKey, k); };
    var inScope = function (d, opts) { var sc = opts && opts.scope; return !sc || d.scopes.indexOf(sc) >= 0; };

    function validateLocal(d, value) {
      if (typeof value === 'string') {
        var s = value.trim().toLowerCase();
        for (var i = 0; i < d.values.length; i++) if (d.values[i] === s || String(d.options[i]).toLowerCase() === s) return { ok: true, value: d.values[i] };
      }
      return { ok: false, error: 'use ' + d.values.join(', ') };
    }

    function localDefault(d, config) {
      var c = isObj(config) ? config : {};
      for (var i = 0; i < d.config.length; i++) {
        var f = d.config[i];
        if (!own(c, f) || c[f] === undefined || c[f] === null) continue;
        var r = validateLocal(d, c[f]);
        return r.ok ? r.value : d.fallback;
      }
      return d.fallback;
    }

    var X = {};
    Object.keys(S).forEach(function (k) { X[k] = S[k]; });
    X[WRAPPED] = true;
    X.base = S;
    X.KEYS = S.KEYS.concat(local);
    X.spec = function (key) { return isLocal(key) ? byKey[key] : S.spec(key); };
    X.keys = function (scope) {
      return S.keys(scope).concat(local.filter(function (d) { return inScope(d, { scope: scope }); }).map(function (d) { return d.key; }));
    };
    X.validate = function (key, value, opts) {
      return isLocal(key) ? validateLocal(byKey[key], value) : S.validate(key, value, opts);
    };
    X.defaults = function (config, opts) {
      var out = S.defaults(config, opts);
      var cfg = config !== undefined ? config : opts && opts.config;
      local.forEach(function (d) { if (inScope(d, opts)) out[d.key] = localDefault(d, cfg); });
      return out;
    };
    X.normalize = function (obj, opts) {
      var o = isObj(obj) ? obj : {};
      var shared = {};
      Object.keys(o).forEach(function (k) { if (!isLocal(k)) shared[k] = o[k]; });
      var out = S.normalize(shared, opts);
      local.forEach(function (d) {
        if (!inScope(d, opts)) return;
        var r = own(o, d.key) ? validateLocal(d, o[d.key]) : { ok: false };
        out[d.key] = r.ok ? r.value : localDefault(d, opts && opts.config);
      });
      return out;
    };
    return X;
  }

  function schema(opts) {
    return schemaFor((opts && opts.schema) || PCD.settings);
  }

  /** The wallpaper's setting keys, in schema order. */
  function settingKeys(opts) {
    return schema(opts).keys('wallpaper');
  }

  /** [{ id, name }] with 'auto' first: opts.menu, else PCD.engine.menu(globalThis.PixelClock). */
  function themeMenu(opts) {
    var src = opts && Array.isArray(opts.menu) ? opts.menu : null;
    if (!src && PCD.engine && typeof PCD.engine.menu === 'function' && root.PixelClock) {
      try {
        src = PCD.engine.menu(root.PixelClock);
      } catch (e) {
        src = null;
      }
    }
    var out = [];
    (src || []).forEach(function (t) {
      if (!isObj(t) || typeof t.id !== 'string' || !t.id) return;
      if (out.some(function (x) { return x.id === t.id; })) return;
      out.push({ id: t.id, name: typeof t.name === 'string' && t.name ? t.name : t.id });
    });
    if (!out.length || out[0].id !== 'auto') {
      out = out.filter(function (x) { return x.id !== 'auto'; });
      out.unshift({ id: 'auto', name: 'Auto (by date)' });
    }
    return out;
  }

  function menuIds(menu) { return menu.map(function (t) { return t.id; }).filter(function (id) { return id !== 'auto'; }); }

  function defaults(config, opts) {
    var menu = themeMenu(opts);
    return schema(opts).defaults(isObj(config) ? config : {}, { scope: 'wallpaper', themes: menuIds(menu) });
  }

  /** Lively values for every state control, from settings. */
  function controlValues(settings, opts) {
    var S = schema(opts);
    var menu = themeMenu(opts);
    var s = S.normalize(settings, { scope: 'wallpaper', themes: menuIds(menu) });
    var out = {};
    CONTROLS.forEach(function (c) {
      if (!c.setting) return;
      var v = s[c.setting];
      switch (c.k) {
        case 'theme': {
          var i = menu.map(function (t) { return t.id; }).indexOf(v);
          out[c.k] = i >= 0 ? i : 0;
          break;
        }
        case 'reducedMotion':
          out[c.k] = v === 'on';
          break;
        case 'performance':
          out[c.k] = v === 'on';
          break;
        case 'lowPowerOnBattery':
          out[c.k] = v !== 'off';
          break;
        default:
          if (c.values) out[c.k] = Math.max(0, c.values.indexOf(v));
          else out[c.k] = v;
      }
    });
    return out;
  }

  /** The setting value of control c given every control value (performance reads two). */
  function settingOf(c, controls, defs, menu) {
    switch (c.k) {
      case 'theme':
        return menu[controls.theme] ? menu[controls.theme].id : 'auto';
      case 'reducedMotion':
        return controls.reducedMotion ? 'on' : defs.reducedMotion === 'off' ? 'off' : 'auto';
      case 'performance':
      case 'lowPowerOnBattery':
        return controls.performance ? 'on' : controls.lowPowerOnBattery ? 'auto' : 'off';
      default:
        return c.values ? c.values[controls[c.k]] : controls[c.k];
    }
  }

  function buildProperties(config, opts) {
    var S = schema(opts);
    var menu = themeMenu(opts);
    if (menu.length < 2) throw new Error('LivelyProperties: no theme menu (pass opts.menu or load the engine and pcd-engine.js first)');
    var o = { schema: S, menu: menu };
    var values = controlValues(defaults(config, o), o);
    var out = {};
    CONTROLS.forEach(function (c) {
      var p = { type: c.type };
      if (c.type === 'label') {
        p.value = c.value;
      } else {
        p.text = c.text;
        if (c.type === 'dropdown') p.items = c.k === 'theme' ? menu.map(function (t) { return t.name; }) : c.items.slice();
        p.value = c.type === 'button' ? c.value : values[c.k];
      }
      out[c.k] = p;
    });
    return out;
  }

  // ------------------------------------------------------------------------------------- checks

  function checkProperties(props) {
    var errors = [];
    if (!isObj(props) || !Object.keys(props).length) return ['LivelyProperties.json must be a non-empty object'];
    try {
      if (JSON.stringify(JSON.parse(JSON.stringify(props))) !== JSON.stringify(props)) errors.push('not plain JSON');
    } catch (e) {
      errors.push('not plain JSON (' + e.message + ')');
    }
    Object.keys(props).forEach(function (key) {
      var c = props[key];
      var at = key + ':';
      if (!KEY_RE.test(key)) errors.push(at + ' a key starts with a lower-case letter and has only letters and digits (no dots)');
      if (!isObj(c)) {
        errors.push(at + ' must be an object');
        return;
      }
      if (CONTROL_TYPES.indexOf(c.type) < 0) {
        errors.push(at + ' unknown type ' + JSON.stringify(c.type) + ' (Lively then loads NO properties)');
        return;
      }
      TYPE_REQUIRED[c.type].forEach(function (k) { if (!own(c, k)) errors.push(at + ' a ' + c.type + ' needs "' + k + '"'); });
      Object.keys(c).forEach(function (k) { if (TYPE_KEYS[c.type].indexOf(k) < 0) errors.push(at + ' "' + k + '" is not allowed on a ' + c.type); });
      if (c.type !== 'label' && !(typeof c.text === 'string' && c.text.trim())) errors.push(at + ' "text" must be a non-empty string');
      var v = c.value;
      switch (c.type) {
        case 'slider': {
          var nums = ['min', 'max', 'step'].every(function (k) { return typeof c[k] === 'number' && isFinite(c[k]); });
          if (!nums) errors.push(at + ' min, max and step must be numbers');
          else {
            if (!(c.min < c.max)) errors.push(at + ' min must be below max');
            if (!(c.step > 0)) errors.push(at + ' step must be positive');
            if (!(typeof v === 'number' && v >= c.min && v <= c.max)) errors.push(at + ' value ' + JSON.stringify(v) + ' outside ' + c.min + '-' + c.max);
          }
          break;
        }
        case 'dropdown':
          if (!Array.isArray(c.items) || !c.items.length || !c.items.every(function (s) { return typeof s === 'string' && s.length > 0; })) {
            errors.push(at + ' items must be a non-empty list of strings');
          } else if (!(typeof v === 'number' && Math.floor(v) === v && v >= 0 && v < c.items.length)) {
            errors.push(at + ' value must be an item index 0-' + (c.items.length - 1));
          }
          break;
        case 'checkbox':
          if (typeof v !== 'boolean') errors.push(at + ' value must be true or false');
          break;
        case 'color':
          if (!(typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v))) errors.push(at + ' value must be #RRGGBB');
          break;
        case 'folderDropdown':
          if (typeof c.filter !== 'string' || typeof c.folder !== 'string') errors.push(at + ' filter and folder must be strings');
          if (typeof v !== 'string') errors.push(at + ' value must be a string');
          break;
        default:
          if (typeof v !== 'string') errors.push(at + ' value must be a string');
      }
    });
    return errors;
  }

  function checkPropertiesContent(props, opts) {
    var o = opts || {};
    var want = buildProperties(o.config, o);
    var errors = [];
    if (!isObj(props)) return ['LivelyProperties.json must be an object'];
    var got = Object.keys(props);
    var keys = Object.keys(want);
    keys.forEach(function (k) {
      if (!own(props, k)) errors.push(k + ': missing');
      else if (JSON.stringify(props[k]) !== JSON.stringify(want[k])) errors.push(k + ': ' + JSON.stringify(props[k]) + ', want ' + JSON.stringify(want[k]));
    });
    got.forEach(function (k) { if (!own(want, k)) errors.push(k + ': not a control of this page'); });
    if (!errors.length && got.join(',') !== keys.join(',')) errors.push('the controls are not in Customise order: ' + got.join(', '));
    return errors;
  }

  // ------------------------------------------------------------------------------------- coercion

  function coerceWith(c, name, raw, menu, S) {
    var bad = function (why) { return { ok: false, name: name, reason: why }; };
    var good = function (v) { return { ok: true, name: name, kind: c.type === 'button' ? 'action' : 'value', value: v }; };
    var n;
    switch (c.type) {
      case 'label':
        return bad('labels carry no value');
      case 'button':
        return raw === true || raw === 'true' || raw === 1 || raw === c.value ? good(true) : bad('button value ' + JSON.stringify(raw));
      case 'checkbox':
        if (raw === true || raw === false) return good(raw);
        if (raw === 'true' || raw === 1 || raw === '1') return good(true);
        if (raw === 'false' || raw === 0 || raw === '0') return good(false);
        return bad('not a boolean');
      case 'textbox': {
        if (typeof raw === 'number' && isFinite(raw)) raw = String(raw);
        if (typeof raw !== 'string') return bad('not text');
        var max = S.spec(c.setting).max || 80;
        var t = S.cleanLine(raw);
        var a = Array.from(t);
        return good(a.length > max ? a.slice(0, max).join('').trim() : t);
      }
      case 'dropdown': {
        var labels = c.k === 'theme' ? menu.map(function (t) { return t.name; }) : c.items;
        var values = c.k === 'theme' ? menu.map(function (t) { return t.id; }) : c.values;
        if (typeof raw === 'string') {
          var s = raw.trim();
          if (/^\d+$/.test(s)) n = Number(s);
          else {
            // a value or label by name (a Livelycu "setprop" or a hand-edited copy)
            var l = s.toLowerCase();
            for (var i = 0; i < values.length; i++) {
              if (String(values[i]).toLowerCase() === l || String(labels[i]).toLowerCase() === l) return good(i);
            }
            return bad('unknown ' + c.k + ' ' + JSON.stringify(s));
          }
        } else n = raw;
        if (typeof n !== 'number' || !isFinite(n) || Math.floor(n) !== n) return bad('not an index');
        if (n < 0 || n >= values.length) return bad('index ' + n + ' out of range 0-' + (values.length - 1));
        return good(n);
      }
      default:
        return bad('unsupported control type ' + c.type);
    }
  }

  function coerce(name, raw, opts) {
    var c = control(name);
    if (!c) return { ok: false, name: name, reason: 'unknown property' };
    return coerceWith(c, name, raw, themeMenu(opts), schema(opts));
  }

  function createMapper(opts) {
    var o = opts || {};
    var S = schema(o);
    var menu = themeMenu(o);
    var sOpts = { scope: 'wallpaper', themes: menuIds(menu) };
    var defs = S.defaults(isObj(o.config) ? o.config : {}, sOpts);
    var o2 = { schema: S, menu: menu };
    var controls = controlValues(defs, o2);
    var state = S.clone(defs);

    function commit(name, value) {
      var c = control(name);
      controls[name] = value;
      var v = settingOf(c, controls, defs, menu);
      var r = S.validate(c.setting, v, sOpts);
      if (r.ok) state[c.setting] = r.value;
      return { key: c.setting, value: S.clone(state[c.setting]) };
    }

    function coerceName(name, raw) {
      var c = control(name);
      if (!c) return { ok: false, name: name, reason: 'unknown property' };
      return coerceWith(c, name, raw, menu, S);
    }

    return {
      menu: menu,
      coerce: coerceName,
      commit: commit,
      property: function (name, raw) {
        var r = coerceName(name, raw);
        if (!r.ok || r.kind === 'action') return r;
        var s = commit(name, r.value);
        return { ok: true, name: name, kind: 'value', value: r.value, key: s.key, setting: s.value };
      },
      state: function () { return S.clone(state); },
      controls: function () { return S.clone(controls); }
    };
  }

  function stateFromProperties(props, opts) {
    var m = createMapper(opts);
    STATE_CONTROLS.forEach(function (name) {
      var p = isObj(props) ? props[name] : null;
      if (isObj(p) && own(p, 'value')) m.property(name, p.value);
    });
    return m.state();
  }

  // --------------------------------------------------------------------------------------- router

  function createRouter(opts) {
    var o = opts || {};
    var mapper = o.mapper || createMapper(o);
    var wait = typeof o.debounceMs === 'number' ? o.debounceMs : DEBOUNCE_MS;
    var pending = Object.create(null);
    var suspended = false;
    var counts = { received: 0, applied: 0, ignored: 0, actions: 0 };

    function timerId(name) { return 'deb:' + name; }

    function apply(name, value) {
      var s = mapper.commit(name, value);
      counts.applied++;
      if (typeof o.apply === 'function') o.apply(s.key, s.value, name);
    }

    function fire(name) {
      if (!own(pending, name)) return;
      var v = pending[name];
      delete pending[name];
      apply(name, v);
    }

    function arm(name) {
      if (suspended || typeof o.setTimer !== 'function') return;
      o.setTimer(timerId(name), function () { fire(name); }, wait);
    }

    function now() {
      return wait <= 0 || (typeof o.immediate === 'function' && !!o.immediate());
    }

    function drop(name) {
      if (typeof o.clearTimer === 'function') o.clearTimer(timerId(name));
      delete pending[name];
    }

    function property(name, raw) {
      counts.received++;
      var r = mapper.coerce(name, raw);
      if (!r.ok) {
        counts.ignored++;
        return r;
      }
      if (r.kind === 'action') {
        counts.actions++;
        if (typeof o.action === 'function') o.action(name);
        return r;
      }
      var c = control(name);
      if (c.type === 'textbox' && !now()) {
        pending[name] = r.value;
        if (typeof o.clearTimer === 'function') o.clearTimer(timerId(name));
        arm(name);
        r.pending = true;
        return r;
      }
      // an immediate value replaces an older typed one that is still waiting
      if (own(pending, name)) drop(name);
      apply(name, r.value);
      return r;
    }

    return {
      mapper: mapper,
      property: property,
      flush: function () {
        Object.keys(pending).forEach(function (name) {
          if (typeof o.clearTimer === 'function') o.clearTimer(timerId(name));
          fire(name);
        });
      },
      suspend: function () {
        suspended = true;
        Object.keys(pending).forEach(function (name) { if (typeof o.clearTimer === 'function') o.clearTimer(timerId(name)); });
      },
      resume: function () {
        suspended = false;
        Object.keys(pending).forEach(arm);
      },
      pending: function () {
        var out = {};
        Object.keys(pending).forEach(function (k) { out[k] = pending[k]; });
        return out;
      },
      counts: counts
    };
  }

  var api = {
    CONTROL_TYPES: CONTROL_TYPES,
    TYPE_KEYS: TYPE_KEYS,
    TYPE_REQUIRED: TYPE_REQUIRED,
    KEY_RE: KEY_RE,
    CONTROLS: CONTROLS,
    STATE_CONTROLS: STATE_CONTROLS,
    BUTTONS: BUTTONS,
    TEXTS: TEXTS,
    DEBOUNCE_MS: DEBOUNCE_MS,
    SETTLE_MS: SETTLE_MS,
    SIDES: SIDES,
    LOCAL_KEYS: LOCAL_KEYS,
    schemaFor: schemaFor,
    settingKeys: settingKeys,
    themeMenu: themeMenu,
    defaults: defaults,
    controlValues: controlValues,
    buildProperties: buildProperties,
    checkProperties: checkProperties,
    checkPropertiesContent: checkPropertiesContent,
    coerce: coerce,
    createMapper: createMapper,
    stateFromProperties: stateFromProperties,
    createRouter: createRouter
  };
  PCD.wpProps = api;
  return api;
});
