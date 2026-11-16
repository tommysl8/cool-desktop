/* PixelClock Desktop, new tab terminal: the one URL classifier and the browser actions.
 * Classic script, UMD: PCD.term.url (module.exports in Node). Pure rules; actions() only touches what it is given.
 * The terminal and the page share this one classifier; the looser url.js in term/lib/ (router.js needs it) never
 * decides what opens.
 *
 * What opens (toUrl) and what is searched:
 *   - an http(s) URL as typed; a bare domain.tld[:port][/path] gets the https scheme;
 *   - localhost, 127.x, private and link-local IPv4 (10/8, 172.16/12, 192.168/16, 169.254/16), IPv6 literals
 *     ([::1]:3000) and *.local, *.lan, *.internal, *.home.arpa, *.localhost names get the http scheme (a PixelClock
 *     answers plain http at pixelclock.local);
 *   - every other scheme (javascript:, data:, file:, chrome:, view-source:, mailto:, ftp:, ...) is never opened: that
 *     text is searched; so are user:password@ forms, bad ports and spaces;
 *   - a domain needs a top-level part of 2-63 letters (or xn--) that is not a common file extension which is no TLD:
 *     node.js, package.json and notes.txt are searches; example.ai, docs.rs and bun.sh are addresses, as in Chrome.
 *
 * Contract (U = PCD.term.url):
 *   U.toUrl(text) -> an http(s) URL (URL.href) | null      U.hostKind(host) -> 'lan' | 'public' | null
 *   U.isWebUrl(url) -> bool (an absolute http(s) URL with a host and no credentials)
 *   U.classify(text) -> { kind: 'empty' } | { kind: 'url', url } | { kind: 'search', text }
 *   U.NOT_TLDS  the file extensions that are no top-level domain
 *   U.actions({ chrome, location, open }) -> { openUrl(url, newTab) -> Promise, search(text, newTab) -> Promise }
 *     the browser side of app.openUrl and app.search, for the page to use: this tab: location.assign(url); a new tab:
 *     chrome.tabs.create({ url, active: true }) (window.open with noopener,noreferrer without it); searches:
 *     chrome.search.query({ text, disposition: 'CURRENT_TAB' | 'NEW_TAB' }) (Chrome's default engine). Each resolves
 *     { did: 'navigate' | 'search', newTab? } and rejects with a short lower-case message when it cannot act
 *     (not an http(s) address; no chrome.search, e.g. a preview page). Only http(s) is ever opened.
 */
(function (root, factory) {
  var api = factory(root.PCD || (root.PCD = {}), root);
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (PCD, root) {
  'use strict';

  var HTTP_RE = /^https?:\/\//i;
  var SCHEME_SLASHES_RE = /^[a-z][a-z0-9+.-]*:\/\//i;
  /** Schemes that are never opened (their text is searched instead). */
  var OTHER_SCHEME_RE = /^(?:javascript|vbscript|data|blob|file|about|chrome|chrome-extension|chrome-untrusted|chrome-search|devtools|edge|view-source|filesystem|intent|mailto|tel|sms|ftp|wss?|news|nntp|urn|magnet|irc):/i;
  var OCTET = '(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)';
  var IPV4_RE = new RegExp('^' + OCTET + '(?:\\.' + OCTET + '){3}$');
  var IPV6_AUTHORITY_RE = /^\[([0-9a-f:.]+)\](?::(\d{1,5}))?$/i;
  var HOST_PORT_RE = /^([^:]+)(?::(\d{1,5}))?$/;
  var LABEL_RE = /^[\p{L}\p{M}\p{N}_-]{1,63}$/u;
  var TLD_RE = /^(?:[\p{L}\p{M}]{2,63}|xn--[a-z0-9-]{1,59})$/iu;
  var LAN_SUFFIX_RE = /(?:^|\.)(?:local|lan|internal|localhost|home\.arpa)$/i;
  /** File extensions that are not top-level domains: "word.ext" with one of these is a search, never an address. */
  var NOT_TLDS = toSet(('js mjs cjs jsx ts tsx json jsonc txt yaml yml toml xml csv tsv log ini cfg conf env lock html htm ' +
    'xhtml css scss sass vue svelte cpp hpp cxx hxx java kt kts swift php rb pyc pyw lua sql exe dll bat cmd msi apk ' +
    'dmg iso pdf doc docx xls xlsx ppt pptx odt ods odp rtf png jpg jpeg gif svg webp bmp ico tif tiff heic psd wav ' +
    'flac ogg avi mkv webm rar tar tgz ipynb tex bib').split(' '));

  function toSet(list) {
    var s = Object.create(null);
    for (var i = 0; i < list.length; i++) s[list[i]] = true;
    return s;
  }

  function isPrivateV4(ip) {
    var p = ip.split('.').map(Number);
    return p[0] === 10 || p[0] === 127 || (p[0] === 169 && p[1] === 254) || (p[0] === 172 && p[1] >= 16 && p[1] <= 31) ||
      (p[0] === 192 && p[1] === 168);
  }

  function isDomain(host) {
    if (!host || host.length > 253) return false;
    var labels = host.split('.');
    if (labels.length < 2) return false;
    for (var i = 0; i < labels.length; i++) {
      var l = labels[i];
      if (!LABEL_RE.test(l) || l.charAt(0) === '-' || l.charAt(l.length - 1) === '-') return false;
    }
    return TLD_RE.test(labels[labels.length - 1]);
  }

  /** 'lan' (gets the http scheme), 'public' (https) or null (not a host) for a bare host name. */
  function hostKind(host) {
    var h = String(host || '').toLowerCase();
    if (h.charAt(h.length - 1) === '.') h = h.slice(0, -1);
    if (!h) return null;
    if (h === 'localhost') return 'lan';
    if (IPV4_RE.test(h)) return isPrivateV4(h) ? 'lan' : 'public';
    if (!isDomain(h)) return null;
    if (LAN_SUFFIX_RE.test(h)) return 'lan';
    var tld = h.slice(h.lastIndexOf('.') + 1);
    return NOT_TLDS[tld] ? null : 'public';
  }

  function webHref(candidate) {
    var u;
    try {
      u = new URL(candidate);
    } catch (e) {
      return null;
    }
    if ((u.protocol !== 'http:' && u.protocol !== 'https:') || !u.hostname || u.username || u.password) return null;
    return u.href;
  }

  /** The address to open for URL-like text, or null (then the text is a search). */
  function toUrl(text) {
    var t = typeof text === 'string' ? text.trim() : '';
    if (!t || /\s/.test(t)) return null;
    if (HTTP_RE.test(t)) return webHref(t);
    if (SCHEME_SLASHES_RE.test(t) || OTHER_SCHEME_RE.test(t)) return null;
    var cut = t.search(/[/?#]/);
    var authority = cut < 0 ? t : t.slice(0, cut);
    if (!authority || authority.indexOf('@') >= 0 || authority.indexOf('\\') >= 0) return null;
    var kind;
    var port;
    var m6 = IPV6_AUTHORITY_RE.exec(authority);
    if (m6) {
      kind = 'lan';
      port = m6[2];
    } else {
      var m = HOST_PORT_RE.exec(authority);
      if (!m) return null;
      kind = hostKind(m[1]);
      port = m[2];
    }
    if (!kind) return null;
    if (port !== undefined && !(Number(port) >= 1 && Number(port) <= 65535)) return null;
    return webHref((kind === 'public' ? 'https://' : 'http://') + t);
  }

  function isWebUrl(url) {
    return typeof url === 'string' && webHref(url) !== null;
  }

  function classify(text) {
    var t = typeof text === 'string' ? text.trim() : '';
    if (!t) return { kind: 'empty' };
    var url = toUrl(t);
    if (url) return { kind: 'url', url: url };
    return { kind: 'search', text: t };
  }

  function fail(message) {
    return Promise.reject(new Error(message));
  }

  function settle(p, extra) {
    return Promise.resolve(p).then(function () { return extra; });
  }

  /** The page's side of app.openUrl / app.search (see the contract above). */
  function actions(opts) {
    var o = opts || {};
    function chromeApi() {
      return o.chrome !== undefined ? o.chrome : root.chrome;
    }
    return {
      openUrl: function (url, newTab) {
        if (!isWebUrl(url)) return fail('only http and https addresses open from here');
        var c = chromeApi();
        if (newTab) {
          if (c && c.tabs && typeof c.tabs.create === 'function') {
            try {
              return settle(c.tabs.create({ url: url, active: true }), { did: 'navigate', newTab: true });
            } catch (e) {
              return Promise.reject(e);
            }
          }
          var open = o.open || (root.open && root.open.bind(root));
          if (typeof open !== 'function') return fail('new tabs cannot be opened from here');
          open(url, '_blank', 'noopener,noreferrer');
          return Promise.resolve({ did: 'navigate', newTab: true });
        }
        var loc = o.location || root.location;
        if (!loc || typeof loc.assign !== 'function') return fail('this page cannot navigate');
        loc.assign(url);
        return Promise.resolve({ did: 'navigate' });
      },
      search: function (text, newTab) {
        var t = typeof text === 'string' ? text.trim() : '';
        if (!t) return fail('nothing to search for');
        var c = chromeApi();
        if (!c || !c.search || typeof c.search.query !== 'function') return fail('search works in the installed new tab only');
        try {
          return settle(c.search.query({ text: t, disposition: newTab ? 'NEW_TAB' : 'CURRENT_TAB' }), newTab ? { did: 'search', newTab: true } : { did: 'search' });
        } catch (e) {
          return Promise.reject(e);
        }
      }
    };
  }

  var api = {
    NOT_TLDS: Object.keys(NOT_TLDS),
    toUrl: toUrl,
    hostKind: hostKind,
    isWebUrl: isWebUrl,
    classify: classify,
    actions: actions
  };
  var T = PCD.term || (PCD.term = {});
  T.url = api;
  return api;
});
