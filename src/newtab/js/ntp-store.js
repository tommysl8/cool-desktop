/* PixelClock Desktop, new tab: where the settings live. Classic script, UMD, global
 * PCD.store (module.exports in Node). Needs PCD.settings (js/ntp-settings.js) when called, or opts.schema.
 *
 * Storage: chrome.storage.sync, item "settings" = PCD.settings overrides plus "v" (only what differs
 * from the config defaults). Preview mode (no chrome.runtime.id, e.g. the page served from 127.0.0.1)
 * runs the same code over localStorage keys "pcd.sync.<key>"; with no storage at all, memory.
 *
 * Quota-aware (Chrome: QUOTA_BYTES_PER_ITEM 8192, QUOTA_BYTES 102400, MAX_ITEMS 512, 120 writes a
 * minute, 1800 an hour; the area's own constants win when present):
 * - Every item is measured the way Chrome counts it (key + its JSON in UTF-8, "<" counted as its 6-byte escape) and kept
 *   under ITEM_BUDGET (4096). When "settings" would be bigger, the shortcuts move out into
 *   chunk items "settings.sc.<rev>.<i>" and "settings" keeps a pointer { sc: { rev, n } }. rev hashes
 *   the list, so a new list never overwrites the chunks readers still use: the chunks are written
 *   first, then the pointer, then the old chunks are removed. A failed or half-done write therefore
 *   always leaves the previous settings readable.
 * - A reader that sees a pointer before its chunks arrive (sync between computers is per item) keeps
 *   the shortcuts it has (status().incomplete) until onChanged brings the rest. Chunks are only ever
 *   removed by the tab that replaced them (or, over quota, when nothing points at them).
 * - Before writing, the total and item count after the write are checked; errors from the area are
 *   classified (classify) and retried: per-minute rate 60 s, per-hour rate 10 min, other errors 2 s,
 *   10 s, 60 s; a write that can never fit (QUOTA_BYTES, MAX_ITEMS) is reported, not retried.
 * - Writes are debounced (1 s), run one at a time as read-modify-write (the patch goes over what is
 *   stored now, so another tab's change to another key survives) and happen only on a real change.
 *   chrome.storage.onChanged re-reads and updates every open tab; unsaved local edits stay on top.
 *
 * Contract (St = PCD.store):
 *   St.ITEM_KEY 'settings', St.CHUNK_PREFIX 'settings.sc.', St.ITEM_BUDGET 4096, St.DEBOUNCE_MS 1000,
 *   St.LS_PREFIX 'pcd.sync.', St.QUOTA (Chrome's numbers)
 *   St.itemBytes(key, value)      bytes Chrome charges for one item
 *   St.layout(stored, { budget, keep }) -> { items, order, bytes, split, kept, rev, chunkKeys }
 *   St.assemble(all) -> { raw, sc, missing, referenced, unreferenced }   (the inverse of layout)
 *   St.classify(error) -> 'item' | 'total' | 'items' | 'rate-minute' | 'rate-hour' | 'error'
 *   St.syncArea(chrome) | St.localArea(localStorage, { prefix, win, quota }) | St.memoryArea({ quota })
 *     -> area { kind, quota, get(keys|null), set(items), remove(keys), onChanged(fn) -> unsubscribe }
 *   St.openArea({ chrome, localStorage, window }) -> chrome.storage.sync when this is an extension
 *     page, else localStorage, else memory
 *   St.create({ area, schema, config, themes, debounceMs, budget, timers, now, onError, loadTimeoutMs })
 *     -> store:
 *       kind                      the area's kind
 *       load() -> Promise<settings>   read, migrate, validate; listen to onChanged (call once)
 *       get() -> settings         the current settings (a copy; the defaults until load() is done)
 *       set(patch) -> Promise<{ ok, written, changed, errors?, error?, retrying? }>
 *                                 applies at once (subscribers hear source 'local'), stores after 1 s
 *       reset(keys?)              back to the config defaults (all keys without a list)
 *       flush() -> Promise        store pending changes now (call on pagehide)
 *       subscribe(fn) -> unsubscribe    fn(settings, { source: 'local'|'remote'|'load', changed })
 *       status() -> { kind, loaded, pending, writing, incomplete, split, bytes, writes, lastError, opsLastMinute }
 *       dispose()
 */
(function (root, factory) {
  var api = factory(root.PCD || (root.PCD = {}), root);
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (PCD, root) {
  'use strict';

  var ITEM_KEY = 'settings';
  var CHUNK_PREFIX = 'settings.sc.';
  var ITEM_BUDGET = 4096;
  var DEBOUNCE_MS = 1000;
  var LOAD_TIMEOUT_MS = 2000;
  var LS_PREFIX = 'pcd.sync.';
  var QUOTA = Object.freeze({
    QUOTA_BYTES: 102400,
    QUOTA_BYTES_PER_ITEM: 8192,
    MAX_ITEMS: 512,
    MAX_WRITE_OPERATIONS_PER_MINUTE: 120,
    MAX_WRITE_OPERATIONS_PER_HOUR: 1800
  });
  var RETRY_MINUTE_MS = 60000;
  var RETRY_HOUR_MS = 600000;
  var RETRY_ERROR_MS = [2000, 10000, 60000];
  /** Our own guard, below Chrome's 120 a minute: a write that would pass it waits for the window. */
  var GUARD_PER_MINUTE = 100;
  var MIN_BUDGET = 1024;

  function isObj(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
  function own(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }
  function noop() {}
  function copy(v) { return v === undefined ? undefined : JSON.parse(JSON.stringify(v)); }

  // ------------------------------------------------------------------------------------ measuring

  /** UTF-8 bytes of a string (a lone surrogate counts as U+FFFD, 3 bytes). */
  function utf8Bytes(s) {
    var n = 0;
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      if (c < 0x80) n += 1;
      else if (c < 0x800) n += 2;
      else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
        n += 4;
        i++;
      } else n += 3;
    }
    return n;
  }

  /** A JSON string as Chrome's JSONWriter writes it: quotes, short escapes, \u00XX for other controls,
   *  "<" as the 6-byte escape u003C, U+2028 and U+2029 escaped too, the rest as UTF-8. */
  function jsonStringBytes(s) {
    var n = 2;
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      if (c === 0x22 || c === 0x5c || c === 0x08 || c === 0x0c || c === 0x0a || c === 0x0d || c === 0x09) n += 2;
      else if (c < 0x20 || c === 0x3c || c === 0x2028 || c === 0x2029) n += 6;
      else if (c < 0x80) n += 1;
      else if (c < 0x800) n += 2;
      else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
        n += 4;
        i++;
      } else if (c >= 0xd800 && c <= 0xdfff) n += 6;
      else n += 3;
    }
    return n;
  }

  function jsonBytes(v) {
    if (v === null || v === undefined) return 4;
    switch (typeof v) {
      case 'boolean':
        return v ? 4 : 5;
      case 'number': {
        if (!isFinite(v)) return 4;
        var s = String(v);
        // Chrome stores integers beyond int32 as doubles and writes them with ".0"
        var dbl = Math.floor(v) === v && (v > 2147483647 || v < -2147483648) && !/[.eE]/.test(s);
        return s.length + (dbl ? 2 : 0);
      }
      case 'string':
        return jsonStringBytes(v);
      case 'object': {
        var n = 2;
        var first = true;
        if (Array.isArray(v)) {
          for (var i = 0; i < v.length; i++) {
            n += (first ? 0 : 1) + jsonBytes(typeof v[i] === 'function' ? null : v[i]);
            first = false;
          }
          return n;
        }
        Object.keys(v).forEach(function (k) {
          if (v[k] === undefined || typeof v[k] === 'function') return;
          n += (first ? 0 : 1) + jsonStringBytes(k) + 1 + jsonBytes(v[k]);
          first = false;
        });
        return n;
      }
      default:
        return 4;
    }
  }

  function itemBytes(key, value) { return utf8Bytes(String(key)) + jsonBytes(value); }

  /** FNV-1a 32 of the JSON text, 8 hex digits. */
  function revOf(v) {
    var s = JSON.stringify(v);
    var h = 0x811c9dc5;
    for (var i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return ('0000000' + h.toString(16)).slice(-8);
  }

  function chunkKey(rev, i) { return CHUNK_PREFIX + rev + '.' + i; }

  function isChunkKey(k) { return typeof k === 'string' && k.indexOf(CHUNK_PREFIX) === 0; }

  function isOurKey(k) { return k === ITEM_KEY || isChunkKey(k); }

  function quotaError(kind, message) {
    var e = new Error(message);
    e.kind = kind;
    return e;
  }

  /** A pointer { rev, n } from a stored main item, or null when it has none or a bad one. */
  function pointer(sc) {
    if (!isObj(sc)) return null;
    var rev = sc.rev;
    var n = sc.n;
    if (typeof rev !== 'string' || !/^[0-9a-f]{8}$/.test(rev)) return null;
    if (!(typeof n === 'number' && Math.floor(n) === n && n >= 1 && n <= 64)) return null;
    return { rev: rev, n: n };
  }

  function chunkKeysOf(p) {
    var out = [];
    for (var i = 0; p && i < p.n; i++) out.push(chunkKey(p.rev, i));
    return out;
  }

  /**
   * How a stored object is written: one item, or the shortcuts in chunks (written first) plus the main
   * item with the pointer (written last). keep = a pointer whose chunks must stay as they are (they are
   * still syncing in): the main item keeps it and no chunk is written.
   */
  function layout(stored, opts) {
    var o = opts || {};
    var budget = o.budget || ITEM_BUDGET;
    var main = copy(isObj(stored) ? stored : {});
    delete main.sc;
    var items = {};
    var order = [];
    var bytes = {};
    function add(k, v) {
      items[k] = v;
      order.push(k);
      bytes[k] = itemBytes(k, v);
    }
    var keep = pointer(o.keep);
    if (keep) {
      delete main.shortcuts;
      main.sc = keep;
      if (itemBytes(ITEM_KEY, main) > budget) throw quotaError('item', 'the settings are bigger than ' + budget + ' bytes');
      add(ITEM_KEY, main);
      return { items: items, order: order, bytes: bytes, split: true, kept: true, rev: keep.rev, chunkKeys: chunkKeysOf(keep) };
    }
    var list = main.shortcuts;
    if (itemBytes(ITEM_KEY, main) <= budget || !Array.isArray(list) || !list.length) {
      if (itemBytes(ITEM_KEY, main) > budget) throw quotaError('item', 'the settings are bigger than ' + budget + ' bytes');
      add(ITEM_KEY, main);
      return { items: items, order: order, bytes: bytes, split: false, kept: false, rev: null, chunkKeys: [] };
    }
    delete main.shortcuts;
    var rev = revOf(list);
    var chunks = [];
    var cur = [];
    list.forEach(function (item) {
      var trial = cur.concat([item]);
      if (cur.length && itemBytes(chunkKey(rev, chunks.length), trial) > budget) {
        chunks.push(cur);
        trial = [item];
      }
      cur = trial;
      if (itemBytes(chunkKey(rev, chunks.length), cur) > budget) throw quotaError('item', 'one shortcut is bigger than ' + budget + ' bytes');
    });
    if (cur.length) chunks.push(cur);
    chunks.forEach(function (c, i) { add(chunkKey(rev, i), c); });
    main.sc = { rev: rev, n: chunks.length };
    if (itemBytes(ITEM_KEY, main) > budget) throw quotaError('item', 'the settings are bigger than ' + budget + ' bytes');
    add(ITEM_KEY, main);
    return { items: items, order: order, bytes: bytes, split: true, kept: false, rev: rev, chunkKeys: order.slice(0, -1) };
  }

  /** The stored object from every item of the area (get(null)). */
  function assemble(all) {
    var a = isObj(all) ? all : {};
    var chunks = Object.keys(a).filter(isChunkKey);
    var main = own(a, ITEM_KEY) ? a[ITEM_KEY] : undefined;
    if (!isObj(main)) return { raw: main, sc: null, missing: false, referenced: [], unreferenced: chunks };
    var raw = copy(main);
    var p = pointer(raw.sc);
    delete raw.sc;
    // no pointer, or a damaged one (nothing to wait for): the main item is all there is
    if (!p) return { raw: raw, sc: null, missing: false, referenced: [], unreferenced: chunks };
    var referenced = chunkKeysOf(p);
    var list = [];
    var missing = false;
    referenced.forEach(function (k) {
      if (Array.isArray(a[k])) list = list.concat(a[k]);
      else missing = true;
    });
    if (!missing) raw.shortcuts = list;
    else delete raw.shortcuts;
    return {
      raw: raw,
      sc: p,
      missing: missing,
      referenced: referenced,
      unreferenced: chunks.filter(function (k) { return referenced.indexOf(k) < 0; })
    };
  }

  /**
   * The kind of a storage error. Chrome 157 says "Resource::kQuotaBytesPerItem quota exceeded" (and
   * kQuotaBytes, kMaxItems) for the byte and item quotas, and "This request exceeds the
   * MAX_WRITE_OPERATIONS_PER_MINUTE quota." for the write rates (checked in headless Chrome); older
   * versions and the docs use QUOTA_BYTES_PER_ITEM etc. Both spellings count.
   */
  function classify(err) {
    var m = String(err && err.message ? err.message : err);
    if (err && typeof err.kind === 'string') return err.kind;
    if (/QUOTA_BYTES_PER_ITEM|kQuotaBytesPerItem/.test(m)) return 'item';
    if (/QUOTA_BYTES|kQuotaBytes/.test(m)) return 'total';
    if (/MAX_ITEMS|kMaxItems/.test(m)) return 'items';
    if (/MAX_WRITE_OPERATIONS_PER_HOUR|kMaxWriteOperationsPerHour/.test(m)) return 'rate-hour';
    if (/MAX_(SUSTAINED_)?WRITE_OPERATIONS_PER_MINUTE|kMaxWriteOperationsPerMinute/.test(m)) return 'rate-minute';
    return 'error';
  }

  // ---------------------------------------------------------------------------------------- areas

  function quotaOf(src) {
    var q = {};
    Object.keys(QUOTA).forEach(function (k) {
      var v = src && src[k];
      q[k] = typeof v === 'number' && isFinite(v) && v > 0 ? v : QUOTA[k];
    });
    return q;
  }

  function keyList(keys) {
    if (keys === null || keys === undefined) return null;
    if (Array.isArray(keys)) return keys.map(String);
    if (isObj(keys)) return Object.keys(keys);
    return [String(keys)];
  }

  /** Chrome's own checks for set(items) over the current items, with Chrome 157's messages. */
  function checkQuota(current, items, quota) {
    var after = {};
    Object.keys(current).forEach(function (k) { after[k] = current[k]; });
    var keys = Object.keys(items);
    for (var i = 0; i < keys.length; i++) {
      if (itemBytes(keys[i], items[keys[i]]) > quota.QUOTA_BYTES_PER_ITEM) return 'Resource::kQuotaBytesPerItem quota exceeded';
      after[keys[i]] = items[keys[i]];
    }
    var total = 0;
    var names = Object.keys(after);
    names.forEach(function (k) { total += itemBytes(k, after[k]); });
    if (total > quota.QUOTA_BYTES) return 'Resource::kQuotaBytes quota exceeded';
    if (names.length > quota.MAX_ITEMS) return 'Resource::kMaxItems quota exceeded';
    return null;
  }

  /** An area over a map (memory, or localStorage below); listeners hear every change, like Chrome. */
  function emitterArea(kind, quota, io) {
    var listeners = [];
    function emit(changes) {
      if (!Object.keys(changes).length) return;
      listeners.slice().forEach(function (fn) {
        Promise.resolve().then(function () { fn(changes); }).catch(noop);
      });
    }
    return {
      kind: kind,
      quota: quota,
      get: function (keys) {
        return Promise.resolve().then(function () {
          var all = io.all();
          var list = keyList(keys);
          if (!list) return all;
          var out = {};
          list.forEach(function (k) {
            if (own(all, k)) out[k] = all[k];
            else if (isObj(keys) && keys[k] !== undefined) out[k] = copy(keys[k]);
          });
          return out;
        });
      },
      set: function (items) {
        return Promise.resolve().then(function () {
          if (!isObj(items)) throw new Error('set() needs an object');
          var all = io.all();
          var clean = {};
          Object.keys(items).forEach(function (k) { if (items[k] !== undefined) clean[k] = copy(items[k]); });
          var why = checkQuota(all, clean, quota);
          if (why) throw new Error(why);
          var changes = {};
          Object.keys(clean).forEach(function (k) {
            io.put(k, clean[k]);
            changes[k] = own(all, k) ? { oldValue: all[k], newValue: copy(clean[k]) } : { newValue: copy(clean[k]) };
          });
          emit(changes);
        });
      },
      remove: function (keys) {
        return Promise.resolve().then(function () {
          var all = io.all();
          var changes = {};
          (keyList(keys) || []).forEach(function (k) {
            if (!own(all, k)) return;
            io.del(k);
            changes[k] = { oldValue: all[k] };
          });
          emit(changes);
        });
      },
      onChanged: function (fn) {
        listeners.push(fn);
        var off = io.listen ? io.listen(fn) : noop;
        return function () {
          var i = listeners.indexOf(fn);
          if (i >= 0) listeners.splice(i, 1);
          off();
        };
      }
    };
  }

  function memoryArea(opts) {
    var o = opts || {};
    var map = Object.create(null);
    return emitterArea('memory', quotaOf(o.quota), {
      all: function () {
        var out = {};
        Object.keys(map).forEach(function (k) { out[k] = JSON.parse(map[k]); });
        return out;
      },
      put: function (k, v) { map[k] = JSON.stringify(v); },
      del: function (k) { delete map[k]; }
    });
  }

  /** localStorage keys prefix + key, JSON values; other tabs' changes arrive through the storage event. */
  function localArea(ls, opts) {
    var o = opts || {};
    var prefix = typeof o.prefix === 'string' && o.prefix ? o.prefix : LS_PREFIX;
    var win = o.win === undefined ? root : o.win;
    function parse(text) {
      try {
        return text === null || text === undefined ? undefined : JSON.parse(text);
      } catch (e) {
        return undefined; // a damaged value counts as missing
      }
    }
    return emitterArea('localStorage (preview)', quotaOf(o.quota), {
      all: function () {
        var out = {};
        for (var i = 0; i < ls.length; i++) {
          var k = ls.key(i);
          if (typeof k !== 'string' || k.indexOf(prefix) !== 0) continue;
          var v = parse(ls.getItem(k));
          if (v !== undefined) out[k.slice(prefix.length)] = v;
        }
        return out;
      },
      put: function (k, v) { ls.setItem(prefix + k, JSON.stringify(v)); },
      del: function (k) { ls.removeItem(prefix + k); },
      listen: function (fn) {
        if (!win || typeof win.addEventListener !== 'function') return noop;
        var onStorage = function (e) {
          if (e && e.storageArea && e.storageArea !== ls) return;
          if (e && e.key === null) {
            fn({ settings: {} }); // storage cleared: re-read everything
            return;
          }
          if (!e || typeof e.key !== 'string' || e.key.indexOf(prefix) !== 0) return;
          var change = {};
          change[e.key.slice(prefix.length)] = { oldValue: parse(e.oldValue), newValue: parse(e.newValue) };
          fn(change);
        };
        win.addEventListener('storage', onStorage);
        return function () { win.removeEventListener('storage', onStorage); };
      }
    });
  }

  function syncArea(chromeApi) {
    var c = chromeApi;
    var a;
    try {
      if (!c || !c.runtime || !c.runtime.id || !c.storage || !c.storage.sync) return null;
      a = c.storage.sync;
    } catch (e) {
      return null;
    }
    function call(method, arg) {
      return Promise.resolve().then(function () { return a[method](arg); });
    }
    return {
      kind: 'chrome.storage.sync',
      quota: quotaOf(a),
      get: function (keys) {
        return call('get', keys === undefined ? null : keys).then(function (v) { return isObj(v) ? v : {}; });
      },
      set: function (items) { return call('set', items).then(noop); },
      remove: function (keys) { return call('remove', keys).then(noop); },
      onChanged: function (fn) {
        if (a.onChanged && typeof a.onChanged.addListener === 'function') {
          var direct = function (changes) { fn(changes || {}); };
          a.onChanged.addListener(direct);
          return function () { a.onChanged.removeListener(direct); };
        }
        if (c.storage.onChanged && typeof c.storage.onChanged.addListener === 'function') {
          var any = function (changes, areaName) { if (areaName === 'sync') fn(changes || {}); };
          c.storage.onChanged.addListener(any);
          return function () { c.storage.onChanged.removeListener(any); };
        }
        return noop;
      }
    };
  }

  function probeLocalStorage(given) {
    try {
      var ls = given !== undefined ? given : root.localStorage;
      if (!ls || typeof ls.getItem !== 'function') return null;
      ls.getItem(LS_PREFIX + ITEM_KEY);
      return ls;
    } catch (e) {
      return null;
    }
  }

  function openArea(env) {
    var e = isObj(env) ? env : {};
    var area = syncArea(own(e, 'chrome') ? e.chrome : root.chrome);
    if (area) return area;
    var ls = probeLocalStorage(own(e, 'localStorage') ? e.localStorage : undefined);
    if (ls) return localArea(ls, { win: own(e, 'window') ? e.window : root });
    return memoryArea();
  }

  // ---------------------------------------------------------------------------------------- store

  function create(opts) {
    var o = isObj(opts) ? opts : {};
    var S = o.schema || PCD.settings;
    if (!S || typeof S.applyPatch !== 'function') throw new Error('PCD.store: load js/ntp-settings.js first (or pass opts.schema)');
    var area = o.area || openArea();
    var quota = quotaOf(area.quota);
    var schemaOpts = { config: isObj(o.config) ? o.config : {}, themes: o.themes, scope: 'newtab' };
    var KEYS = S.keys('newtab');
    var debounceMs = typeof o.debounceMs === 'number' && o.debounceMs >= 0 ? o.debounceMs : DEBOUNCE_MS;
    var budget = Math.min(typeof o.budget === 'number' && o.budget > 0 ? o.budget : ITEM_BUDGET, quota.QUOTA_BYTES_PER_ITEM);
    var loadTimeoutMs = typeof o.loadTimeoutMs === 'number' && o.loadTimeoutMs > 0 ? o.loadTimeoutMs : LOAD_TIMEOUT_MS;
    var timers = o.timers || {
      setTimeout: function (fn, ms) { return root.setTimeout(fn, ms); },
      clearTimeout: function (id) { root.clearTimeout(id); }
    };
    var now = typeof o.now === 'function' ? o.now : function () { return Date.now(); };

    var settings = S.defaults(schemaOpts.config, schemaOpts);
    var pending = {};
    var dirty = false; // the stored object needs a rewrite (migration or cleanup) even without a patch
    var waiters = [];
    var timer = null;
    var chain = Promise.resolve();
    var loadPromise = null;
    var loaded = false;
    var incomplete = false;
    var lastLayout = null;
    var lastError = null;
    var retryUntil = 0;
    var errorTries = 0;
    var itemFailures = 0;
    var writes = 0;
    var writing = false;
    var ops = [];
    var orphans = [];
    var subs = [];
    var unlisten = null;
    var disposed = false;

    function enqueue(task) {
      var p = chain.then(function () { return disposed ? undefined : task(); });
      chain = p.then(noop, noop);
      return p;
    }

    function notify(changed, source) {
      if (!changed.length) return;
      var snapshot = S.clone(settings);
      subs.slice().forEach(function (fn) {
        try {
          fn(S.clone(snapshot), { source: source, changed: changed.slice() });
        } catch (e) {
          // a broken subscriber must not break the store
        }
      });
    }

    function diffKeys(a, b) {
      return KEYS.filter(function (k) { return !S.equal(a[k], b[k]); });
    }

    function report(kind, err, retrying) {
      lastError = { kind: kind, message: String(err && err.message ? err.message : err), at: now(), retrying: !!retrying };
      if (typeof o.onError === 'function') {
        try {
          o.onError(Object.assign({}, lastError));
        } catch (e) {
          // ignore
        }
      }
    }

    /** Settings from every stored item, with unsaved local edits on top. */
    function fromStored(all) {
      var a = assemble(all);
      var r = S.read(a.raw, schemaOpts);
      var next = r.settings;
      if (a.missing) next.shortcuts = S.clone(settings.shortcuts); // the rest is still syncing in
      Object.keys(pending).forEach(function (k) { next[k] = S.clone(pending[k]); });
      return { a: a, r: r, next: next };
    }

    function adopt(all, source) {
      var f = fromStored(all);
      incomplete = f.a.missing;
      var changed = diffKeys(settings, f.next);
      settings = f.next;
      if (changed.length) notify(changed, source);
      return f;
    }

    function arm(ms) {
      if (disposed) return;
      if (timer !== null) timers.clearTimeout(timer);
      // a rate-limit pause is never cut short by a new edit
      ms = Math.max(ms, retryUntil - now(), 0);
      timer = timers.setTimeout(function () {
        timer = null;
        var wait = guardWait();
        if (wait > 0) {
          arm(wait);
          return;
        }
        runWrite(false);
      }, ms);
    }

    function opsInLast(ms) {
      var t = now();
      while (ops.length && t - ops[0] >= 3600000) ops.shift();
      return ops.filter(function (x) { return t - x < ms; }).length;
    }

    /** ms until our own per-minute guard lets the next write through (0 = now). */
    function guardWait() {
      var t = now();
      var limit = Math.max(1, Math.min(GUARD_PER_MINUTE, quota.MAX_WRITE_OPERATIONS_PER_MINUTE - 10));
      var recent = ops.filter(function (x) { return t - x < 60000; });
      if (recent.length < limit) return 0;
      return Math.max(1, recent[recent.length - limit] + 60000 - t);
    }

    function op(promise) {
      ops.push(now());
      return promise;
    }

    function hasWork() { return dirty || Object.keys(pending).length > 0; }

    /** Every item of the area as a promise, even when a custom area throws. */
    function getAll() {
      try {
        return Promise.resolve(area.get(null)).then(function (all) { return isObj(all) ? all : {}; });
      } catch (e) {
        return Promise.reject(e);
      }
    }

    function runWrite(fast) {
      if (timer !== null) {
        timers.clearTimeout(timer);
        timer = null;
      }
      var mine = waiters;
      waiters = [];
      var settle = function (r) {
        mine.forEach(function (fn) { fn(r); });
        return r;
      };
      return enqueue(function () { return writeTask(fast); }).then(function (res) {
        return settle(res || { ok: true, written: false });
      }, function (err) {
        // never expected: writeTask handles its own errors; the edits stay pending
        return settle({ ok: false, written: false, error: classify(err), message: String(err && err.message ? err.message : err), retrying: false });
      });
    }

    function writeTask(fast) {
      if (!hasWork()) return Promise.resolve({ ok: true, written: false });
      var patch = pending;
      var wasDirty = dirty;
      pending = {};
      dirty = false;
      writing = true;
      var readAll = fast && lastLayout && lastLayout.all ? Promise.resolve(lastLayout.all) : getAll();
      var plan = null;
      return readAll.then(function (all) {
        var a = assemble(all);
        var keepPointer = a.missing && !own(patch, 'shortcuts') ? a.sc : null;
        var next = S.applyPatch(a.raw, patch, schemaOpts).stored;
        if (keepPointer) delete next.shortcuts;
        var empty = Object.keys(next).length === 1 && a.raw === undefined;
        if (empty || (a.raw !== undefined && S.equal(next, a.raw) && !a.unreferenced.some(isOwnOrphan))) {
          lastLayout = { all: all, a: a, layout: null };
          return { ok: true, written: false, all: all };
        }
        plan = layout(next, { budget: budget, keep: keepPointer });
        return write(all, a, plan).then(function (w) {
          writes++;
          errorTries = 0;
          itemFailures = 0;
          retryUntil = 0;
          lastError = null;
          if (plan.rev) orphans = orphans.filter(function (rev) { return rev !== plan.rev; });
          if (w.cleanupError) report('cleanup', w.cleanupError, false);
          lastLayout = { all: w.after, a: assemble(w.after), layout: plan };
          return { ok: true, written: true, all: w.after, bytes: plan.bytes, split: plan.split };
        });
      }).then(function (res) {
        writing = false;
        // what is stored now may hold other tabs' changes this tab has not heard about yet
        if (res.all) adopt(res.all, 'remote');
        delete res.all;
        return res;
      }, function (err) {
        writing = false;
        // nothing is lost: the patch goes back under any newer edit
        Object.keys(patch).forEach(function (k) { if (!own(pending, k)) pending[k] = patch[k]; });
        if (wasDirty) dirty = true;
        if (plan && plan.split && !plan.kept && orphans.indexOf(plan.rev) < 0) orphans.push(plan.rev);
        return failed(err);
      });
    }

    function isOwnOrphan(k) {
      for (var i = 0; i < orphans.length; i++) if (k.indexOf(CHUNK_PREFIX + orphans[i] + '.') === 0) return true;
      return false;
    }

    /** Chunks, then the main item, then removal of what nothing points at any more. Resolves to
     *  { after: the items now stored, cleanupError: the removal's error or null }. */
    function write(all, a, plan) {
      var after = {};
      Object.keys(all).forEach(function (k) { after[k] = all[k]; });
      var chunkItems = {};
      var newChunks = plan.kept ? [] : plan.chunkKeys;
      var sameChunks = plan.split && !plan.kept && a.sc && a.sc.rev === plan.rev && !a.missing;
      if (!sameChunks) newChunks.forEach(function (k) { chunkItems[k] = plan.items[k]; });
      var mainItem = {};
      mainItem[ITEM_KEY] = plan.items[ITEM_KEY];
      var keep = plan.split ? plan.chunkKeys : [];
      // removed afterwards: every chunk of the old pointer (even ones still syncing in) and this tab's
      // own leftovers; never another computer's unreferenced chunks (they may be in flight)
      var stale = a.referenced.concat(a.unreferenced.filter(isOwnOrphan)).filter(function (k) { return keep.indexOf(k) < 0; });
      var peak = Object.assign({}, chunkItems, mainItem);
      var over = checkQuota(after, peak, quota);
      var cleanup = Promise.resolve();
      if (over && (classify(over) === 'total' || classify(over) === 'items') && a.unreferenced.length) {
        // over quota: chunks nothing points at go first (another computer's half-written leftovers)
        var junk = a.unreferenced.filter(function (k) { return keep.indexOf(k) < 0; });
        cleanup = op(area.remove(junk)).then(function () { junk.forEach(function (k) { delete after[k]; }); });
      }
      return cleanup.then(function () {
        var why = checkQuota(after, peak, quota);
        if (why) throw quotaError(classify(why), why + ' (the settings need ' + sumBytes(peak) + ' bytes)');
        if (!Object.keys(chunkItems).length) return null;
        return op(area.set(chunkItems)).then(function () { Object.assign(after, chunkItems); });
      }).then(function () {
        return op(area.set(mainItem)).then(function () { Object.assign(after, mainItem); });
      }).then(function () {
        if (!stale.length) return { after: after, cleanupError: null };
        return op(area.remove(stale)).then(function () {
          stale.forEach(function (k) { delete after[k]; });
          orphans = orphans.filter(function (rev) { return !stale.some(function (k) { return k.indexOf(CHUNK_PREFIX + rev + '.') === 0; }); });
          return { after: after, cleanupError: null };
        }, function (err) {
          // the new settings are stored; the leftovers are harmless and go with the next write
          stale.forEach(function (k) {
            var rev = k.slice(CHUNK_PREFIX.length).split('.')[0];
            if (orphans.indexOf(rev) < 0) orphans.push(rev);
          });
          return { after: after, cleanupError: err };
        });
      });
    }

    function sumBytes(items) {
      var n = 0;
      Object.keys(items).forEach(function (k) { n += itemBytes(k, items[k]); });
      return n;
    }

    function failed(err) {
      var kind = classify(err);
      var retryIn = -1;
      if (kind === 'rate-minute') retryIn = RETRY_MINUTE_MS;
      else if (kind === 'rate-hour') retryIn = RETRY_HOUR_MS;
      else if (kind === 'item' && itemFailures < 2 && budget > MIN_BUDGET) {
        // Chrome counted more than we did: smaller items and try again at once
        itemFailures++;
        budget = Math.max(MIN_BUDGET, Math.floor(budget / 2));
        retryIn = 0;
      } else if (kind === 'error' && errorTries < RETRY_ERROR_MS.length) {
        retryIn = RETRY_ERROR_MS[errorTries++];
      }
      report(kind, err, retryIn >= 0);
      if (kind === 'rate-minute' || kind === 'rate-hour') retryUntil = now() + retryIn;
      if (retryIn >= 0 && hasWork()) arm(retryIn);
      return { ok: false, written: false, error: kind, message: lastError.message, retrying: retryIn >= 0 };
    }

    function attach() {
      if (unlisten || typeof area.onChanged !== 'function') return;
      unlisten = area.onChanged(function (changes) {
        if (disposed || !isObj(changes) || !Object.keys(changes).some(isOurKey)) return;
        enqueue(function () {
          return getAll().then(function (all) {
            lastLayout = { all: all, a: assemble(all), layout: null };
            adopt(all, 'remote');
          }, function (err) { report('read', err, false); });
        });
      });
    }

    /** Every item of the area, or null when it fails or takes longer than loadTimeoutMs (a late
     *  answer is still applied, as a change). */
    function readFirst() {
      var got = getAll();
      return new Promise(function (resolve) {
        var done = false;
        var t = timers.setTimeout(function () {
          if (done) return;
          done = true;
          report('timeout', 'the settings storage did not answer within ' + loadTimeoutMs + ' ms', false);
          resolve(null);
          got.then(function (all) {
            if (disposed) return;
            enqueue(function () {
              lastLayout = { all: all, a: assemble(all), layout: null };
              adopt(all, 'remote');
            });
          }, noop);
        }, loadTimeoutMs);
        got.then(function (all) {
          if (done) return;
          done = true;
          timers.clearTimeout(t);
          resolve(isObj(all) ? all : {});
        }, function (err) {
          if (done) return;
          done = true;
          timers.clearTimeout(t);
          report('read', err, false);
          resolve(null);
        });
      });
    }

    function load() {
      if (loadPromise) return loadPromise;
      attach();
      loadPromise = enqueue(function () {
        return readFirst().then(function (all) {
          if (all) {
            var f = adopt(all, 'load');
            lastLayout = { all: all, a: f.a, layout: null };
            var r = f.r;
            // an older format or this version's leftovers: rewrite once (never a newer version's data)
            var needsRewrite = !r.newer && f.a.raw !== undefined &&
              (r.migrated || r.problems.length > 0 || !S.equal(S.applyPatch(f.a.raw, {}, schemaOpts).stored, f.a.raw));
            if (needsRewrite) {
              dirty = true;
              arm(debounceMs);
            }
          }
          loaded = true;
          return S.clone(settings);
        });
      });
      return loadPromise;
    }

    function set(patch) {
      if (disposed) return Promise.resolve({ ok: false, written: false, changed: [], error: 'disposed' });
      if (!isObj(patch)) return Promise.resolve({ ok: false, written: false, changed: [], error: 'set() needs an object of settings' });
      var errors = {};
      var changed = [];
      var next = S.clone(settings);
      Object.keys(patch).forEach(function (k) {
        if (KEYS.indexOf(k) < 0) {
          errors[k] = 'not a new tab setting';
          return;
        }
        var r = S.validate(k, patch[k], schemaOpts);
        if (!r.ok) {
          errors[k] = r.error;
          return;
        }
        if (S.equal(next[k], r.value)) return;
        next[k] = r.value;
        pending[k] = S.clone(r.value);
        changed.push(k);
      });
      var hasErrors = Object.keys(errors).length > 0;
      if (!changed.length) {
        return Promise.resolve(hasErrors ? { ok: false, written: false, changed: [], errors: errors } : { ok: true, written: false, changed: [] });
      }
      settings = next;
      notify(changed, 'local');
      var done = new Promise(function (resolve) { waiters.push(resolve); });
      arm(debounceMs);
      return done.then(function (res) {
        var out = Object.assign({}, res, { changed: changed });
        if (hasErrors) {
          out.ok = false;
          out.errors = errors;
        }
        return out;
      });
    }

    function reset(keys) {
      var defs = S.defaults(schemaOpts.config, schemaOpts);
      var list = Array.isArray(keys) ? keys : KEYS;
      var patch = {};
      list.forEach(function (k) { if (own(defs, k)) patch[k] = defs[k]; });
      return set(patch);
    }

    function flush() {
      if (!hasWork() && !waiters.length) return Promise.resolve({ ok: true, written: false });
      return runWrite(true);
    }

    return {
      kind: area.kind,
      load: load,
      get: function () { return S.clone(settings); },
      set: set,
      reset: reset,
      flush: flush,
      subscribe: function (fn) {
        if (typeof fn !== 'function') return noop;
        subs.push(fn);
        return function () {
          var i = subs.indexOf(fn);
          if (i >= 0) subs.splice(i, 1);
        };
      },
      status: function () {
        var all = lastLayout ? lastLayout.all : null;
        var bytes = null;
        if (all) {
          bytes = {};
          Object.keys(all).filter(isOurKey).forEach(function (k) { bytes[k] = itemBytes(k, all[k]); });
        }
        return {
          kind: area.kind,
          loaded: loaded,
          pending: Object.keys(pending),
          dirty: dirty,
          writing: writing,
          incomplete: incomplete,
          split: !!(lastLayout && lastLayout.a && lastLayout.a.sc),
          bytes: bytes,
          budget: budget,
          writes: writes,
          opsLastMinute: opsInLast(60000),
          lastError: lastError ? Object.assign({}, lastError) : null
        };
      },
      dispose: function () {
        disposed = true;
        if (timer !== null) timers.clearTimeout(timer);
        timer = null;
        if (unlisten) unlisten();
        unlisten = null;
        subs = [];
        var left = waiters;
        waiters = [];
        left.forEach(function (fn) { fn({ ok: false, written: false, error: 'disposed' }); });
      }
    };
  }

  var api = {
    ITEM_KEY: ITEM_KEY,
    CHUNK_PREFIX: CHUNK_PREFIX,
    ITEM_BUDGET: ITEM_BUDGET,
    DEBOUNCE_MS: DEBOUNCE_MS,
    LS_PREFIX: LS_PREFIX,
    QUOTA: QUOTA,
    itemBytes: itemBytes,
    revOf: revOf,
    layout: layout,
    assemble: assemble,
    classify: classify,
    checkQuota: checkQuota,
    syncArea: syncArea,
    localArea: localArea,
    memoryArea: memoryArea,
    openArea: openArea,
    create: create
  };
  PCD.store = api;
  return api;
});
