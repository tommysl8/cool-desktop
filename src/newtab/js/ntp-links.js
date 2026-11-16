/* PixelClock Desktop, new tab: the links [1]-[9] of the console column and the terminal. Classic script, UMD, global
 * PCD.links (module.exports in Node). No DOM: the console draws the links (PCD.console, view.links) and the terminal
 * opens them (1-9 + Enter, a name or a unique prefix).
 *
 * Source: the settings' own list (settings.shortcuts; by default config/user.json "shortcuts", 9 at most), or with
 * settings.shortcutsMode 'top' Chrome's most visited sites (chrome.topSites.get()), which needs the optional
 * "topSites" permission. Without that permission 'top' quietly shows the own list. The settings sheet asks for the
 * permission with requestTopSites(), called directly inside its click (Chrome requires a user gesture); a refusal
 * leaves the own list. A granted or removed permission (chrome.permissions.onAdded / onRemoved) updates the list.
 *
 * Contract (K = PCD.links):
 *   K.MAX 9, K.LABEL_MAX 24
 *   K.items(list) -> [{ n, label, url }]: the first 9 entries with a label and an http(s) url, numbered from 1
 *   K.topLabel(url) -> a short name from the host: 'youtube' for www.youtube.com, 'learn.example' for
 *                      learn.example.edu, 'bbc' for bbc.co.uk, 'localhost:8080' for localhost on port 8080; '' when
 *                      not http(s)
 *   K.fromTopSites(list) -> [{ label, url }] from chrome.topSites entries ({ url, title }): http(s) only, one per url, 9
 *   K.hasTopSites(chrome) -> Promise<bool>; K.requestTopSites(chrome) -> Promise<bool> (call it inside a click)
 *   K.topSites(chrome) -> Promise<[{ label, url }] | null> (null: no permission or no API)
 *   K.create({ chrome, onChange(state) }) -> links:
 *     update(settings) -> Promise<state>   the list the settings ask for (onChange only when it changed)
 *     refresh() -> Promise<state>          update() with the last settings (e.g. after a permission change)
 *     items() -> [{ n, label, url }]       the links shown now
 *     state() -> { mode, source: 'custom'|'top', top: 'unknown'|'granted'|'denied', items }
 *     destroy()
 */
(function (root, factory) {
  var api = factory(root.PCD || (root.PCD = {}), root);
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (PCD, root) {
  'use strict';

  var MAX = 9;
  var LABEL_MAX = 24;
  var OCTET = '(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)';
  var IPV4_RE = new RegExp('^' + OCTET + '(?:\\.' + OCTET + '){3}$');

  function webUrl(url) {
    if (typeof url !== 'string' || !url) return null;
    var u;
    try {
      u = new URL(url);
    } catch (e) {
      return null;
    }
    if ((u.protocol !== 'http:' && u.protocol !== 'https:') || !u.hostname || u.username || u.password) return null;
    return u;
  }

  function cut(s, n) {
    var a = Array.from(s);
    return a.length > n ? a.slice(0, n).join('') : s;
  }

  /** One clean line: controls and invisible marks removed, spaces collapsed. */
  function cleanLabel(s) {
    var out = '';
    for (var ch of String(s)) {
      var cp = ch.codePointAt(0);
      var invisible = cp === 0xad || cp === 0xfeff || (cp >= 0x200b && cp <= 0x200f) || (cp >= 0x202a && cp <= 0x202e) ||
        (cp >= 0x2060 && cp <= 0x2069);
      if (invisible) continue;
      out += cp < 0x20 || (cp >= 0x7f && cp <= 0x9f) || cp === 0x2028 || cp === 0x2029 ? ' ' : ch;
    }
    return out.replace(/\s+/g, ' ').trim();
  }

  function items(list) {
    var out = [];
    if (!Array.isArray(list)) return out;
    for (var i = 0; i < list.length && out.length < MAX; i++) {
      var s = list[i];
      if (!s || typeof s !== 'object') continue;
      var u = webUrl(s.url);
      var label = typeof s.label === 'string' ? cut(cleanLabel(s.label), LABEL_MAX) : '';
      if (!u || !label) continue;
      out.push({ n: out.length + 1, label: label, url: s.url });
    }
    return out;
  }

  function topLabel(url) {
    var u = webUrl(url);
    if (!u) return '';
    var host = u.hostname.toLowerCase().replace(/\.$/, '');
    if (host.charAt(0) === '[' || IPV4_RE.test(host) || host.indexOf('.') < 0) return cut(host + (u.port ? ':' + u.port : ''), LABEL_MAX);
    host = host.replace(/^(?:www\d?|m)\./, '');
    var parts = host.split('.');
    if (parts.length > 2 && parts[parts.length - 1].length === 2 && parts[parts.length - 2].length <= 3) parts = parts.slice(0, -2);
    else if (parts.length > 1) parts = parts.slice(0, -1);
    return cut(parts.join('.') || host, LABEL_MAX);
  }

  function fromTopSites(list) {
    var out = [];
    var seen = Object.create(null);
    if (!Array.isArray(list)) return out;
    for (var i = 0; i < list.length && out.length < MAX; i++) {
      var s = list[i];
      var u = s && webUrl(s.url);
      if (!u || seen[u.href]) continue;
      var label = topLabel(u.href) || (typeof s.title === 'string' ? cut(cleanLabel(s.title).toLowerCase(), LABEL_MAX) : '');
      if (!label) continue;
      seen[u.href] = true;
      out.push({ label: label, url: s.url });
    }
    return out;
  }

  function hasTopSites(c) {
    var p = c && c.permissions && typeof c.permissions.contains === 'function' ? c.permissions : null;
    if (!p) return Promise.resolve(false);
    try {
      return Promise.resolve(p.contains({ permissions: ['topSites'] })).then(function (ok) { return ok === true; }, function () { return false; });
    } catch (e) {
      return Promise.resolve(false);
    }
  }

  /** Ask for the optional permission. Call it directly inside a click handler (a user gesture). */
  function requestTopSites(c) {
    var p = c && c.permissions && typeof c.permissions.request === 'function' ? c.permissions : null;
    if (!p) return Promise.resolve(false);
    try {
      return Promise.resolve(p.request({ permissions: ['topSites'] })).then(function (ok) { return ok === true; }, function () { return false; });
    } catch (e) {
      return Promise.resolve(false);
    }
  }

  function topSites(c) {
    return hasTopSites(c).then(function (ok) {
      if (!ok || !c.topSites || typeof c.topSites.get !== 'function') return null;
      try {
        return Promise.resolve(c.topSites.get()).then(fromTopSites, function () { return null; });
      } catch (e) {
        return null;
      }
    });
  }

  function sameItems(a, b) {
    if (a.length !== b.length) return false;
    for (var i = 0; i < a.length; i++) if (a[i].label !== b[i].label || a[i].url !== b[i].url) return false;
    return true;
  }

  function create(opts) {
    var o = opts || {};
    var c = Object.prototype.hasOwnProperty.call(o, 'chrome') ? o.chrome : root.chrome;
    var shown = [];
    var source = 'custom';
    var mode = 'custom';
    var top = 'unknown';
    var settings = null;
    var seq = 0;
    var first = true;
    var unlisten = [];

    function copyItems() {
      return shown.map(function (s) { return { n: s.n, label: s.label, url: s.url }; });
    }

    function state() {
      return { mode: mode, source: source, top: top, items: copyItems() };
    }

    function show(list, src) {
      var next = items(list);
      var changed = first || source !== src || !sameItems(next, shown);
      first = false;
      shown = next;
      source = src;
      if (changed && typeof o.onChange === 'function') {
        try {
          o.onChange(state());
        } catch (e) {
          // a broken listener must not break the list
        }
      }
      return state();
    }

    function update(next) {
      settings = next && typeof next === 'object' ? next : {};
      mode = settings.shortcutsMode === 'top' ? 'top' : 'custom';
      var own = Array.isArray(settings.shortcuts) ? settings.shortcuts : [];
      var my = ++seq;
      if (mode !== 'top') return Promise.resolve(show(own, 'custom'));
      return topSites(c).then(function (list) {
        top = list ? 'granted' : 'denied';
        if (my !== seq) return state(); // a newer update() won
        return list && list.length ? show(list, 'top') : show(own, 'custom');
      });
    }

    function refresh() {
      return update(settings || {});
    }

    var perms = c && c.permissions;
    ['onAdded', 'onRemoved'].forEach(function (name) {
      var ev = perms && perms[name];
      if (ev && typeof ev.addListener === 'function') {
        var fn = function (p) {
          if (p && Array.isArray(p.permissions) && p.permissions.indexOf('topSites') >= 0 && settings) refresh();
        };
        ev.addListener(fn);
        unlisten.push(function () { ev.removeListener(fn); });
      }
    });

    return {
      update: update,
      refresh: refresh,
      items: copyItems,
      state: state,
      destroy: function () {
        seq++;
        unlisten.forEach(function (f) { f(); });
        unlisten = [];
      }
    };
  }

  var api = {
    MAX: MAX,
    LABEL_MAX: LABEL_MAX,
    items: items,
    topLabel: topLabel,
    fromTopSites: fromTopSites,
    hasTopSites: hasTopSites,
    requestTopSites: requestTopSites,
    topSites: topSites,
    create: create
  };
  PCD.links = api;
  return api;
});
