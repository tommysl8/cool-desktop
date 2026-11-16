/* PixelClock Desktop, new tab: the real clock's status line. Classic script, UMD,
 * global PCD.status. No DOM at load time and no load-time dependencies; fetch, timers, the clock and the
 * cache are injectable, so Node tests drive it with fakes. Only mountLine() and pulse() (the page
 * integration, at the end of this file) touch the DOM, and only when called.
 *
 * Page wiring (ntp-app.js), right after the first scene frame (no element: the console draws the line):
 *   var line = PCD.status.mountLine({ settings: settings,
 *     onRinging: function (on) { host.ringing(on); con.ringing(on); },   // the 2 Hz pulse, the accent
 *     onView: function (v) { statusView = v.show ? v : null; draw(); },   // the console's view.status
 *     sample: <?status=NAME on a preview page> });                         // optional: a sample(), never a fetch
 *   line.start();
 *   line.update(settings);   // on every settings change: clockStatus, clock24, reducedMotion
 *   __pcd.status() -> line.state()
 * mountLine() handles visibilitychange (hidden: no request, no pulse timer), 'online' (ask at once) and
 * preview pages (no chrome.runtime.id: never fetch, the reply would be blocked by CORS anyway).
 *
 * - parse(): GET /api/status JSON (firmware api 1) -> a small normalized status, or { ok: false, error }.
 * - describe(): normalized status + the 12/24 h setting -> the line, e.g.
 *     ⌂ pixelclock · next alarm tomorrow 7:00 am · work
 *     ⌂ pixelclock · ringing · work            (ringing: true -> the page pulses, onRinging)
 *     ⌂ pixelclock · snoozed until 8:09 pm · work
 *   "today" / "tomorrow" / weekday come from next.day and next.time against the clock's own local time
 *   (time.epoch + time.offset) with the firmware's rule (today only while the minute is still to come);
 *   next.at is never read (it is computed with today's UTC offset, so it is an hour off across DST).
 * - createClient(): one GET at a time (2.5 s abort, no-store, no credentials, no custom headers, no
 *   redirects), 300 ms after start(), then every 30 s while visible (10 s while ringing, testing or
 *   snoozed), nothing while hidden or disabled. After 2 failures in a row (network, timeout, non-200,
 *   bad JSON or shape) the line hides silently and retries back off to 60 s, then 5 min. The last good
 *   status (normalized: no SSID, IP or time zone) goes to chrome.storage.session `clockStatus`; a
 *   cached answer under 120 s old shows at once in the next tab, and a known-offline clock's backoff
 *   is shared, so new tabs do not each probe a clock that is not there.
 *
 * Transport (checked in headless Chrome 157 against tools/mock-clock.mjs mapped as pixelclock.local):
 * - The clock sends no Access-Control-* header (OPTIONS gets 405), so only a CORS-exempt page can read
 *   the reply: the new tab, thanks to host_permissions ["http://pixelclock.local/*"]. Its request goes
 *   out without an Origin or Referer header and comes back as a "basic" response. Without the
 *   permission it fails with MissingAllowOriginHeader. Extension pages get no mixed-content warning and
 *   sit in the loopback address space, so Local Network Access never applies to them (also checked with
 *   the clock treated as a LAN device).
 * - The Lively wallpaper (an https://<hex>.localhost page in WebView2) cannot read it: Chrome only warns
 *   about the mixed content, but Local Network Access then needs a permission a wallpaper cannot get
 *   (LocalNetworkAccessPermissionDenied), and the reply has no CORS header anyway. So the status shows
 *   on the new tab only, and the wallpaper never contacts pixelclock.local.
 * - With no clock on the network each attempt fails fast (net::ERR_NAME_NOT_RESOLVED), and Chrome logs
 *   one "Failed to load resource" network line in the tab's console: not an exception. The shared
 *   backoff keeps that to about one attempt per new tab, then one every 5 minutes.
 */
(function (root, factory) {
  var api = factory(root.PCD || (root.PCD = {}), root);
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (PCD, root) {
  'use strict';

  var STATUS_URL = 'http://pixelclock.local/api/status';
  var TIMEOUT_MS = 2500;
  var FIRST_DELAY_MS = 300;
  var POLL_MS = 30000;
  var ACTIVE_POLL_MS = 10000;
  var RETRY_MS = [60000, 300000];
  var HIDE_AFTER = 2;
  var CACHE_KEY = 'clockStatus';
  var CACHE_MAX_AGE_MS = 120000;
  var MAX_TEXT = 65536;
  var LABEL_MAX = 32;
  var STATES = ['none', 'ringing', 'snoozed', 'testing'];
  var HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
  var DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
  var GLYPH = '⌂';
  var SEP = ' · ';
  // Control, zero-width, bidi and other invisible format characters (code point ranges): never shown
  // from a label. Built from numbers so the source stays plain ASCII.
  var INVISIBLE = new RegExp('[' + [[0x00, 0x1f], [0x7f, 0x9f], [0xad, 0xad], [0x61c, 0x61c], [0x115f, 0x1160],
    [0x180e, 0x180e], [0x200b, 0x200f], [0x2028, 0x202e], [0x2060, 0x206f], [0x3164, 0x3164], [0xfe00, 0xfe0f],
    [0xfeff, 0xfeff], [0xffa0, 0xffa0], [0xfff9, 0xfffb]].map(function (r) {
    return String.fromCharCode(r[0]) + (r[1] > r[0] ? '-' + String.fromCharCode(r[1]) : '');
  }).join('') + ']', 'g');

  function isObj(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
  function isInt(v) { return typeof v === 'number' && isFinite(v) && Math.floor(v) === v; }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  /** A user label as the line may show it: no invisible characters, single spaces, at most 32 characters. */
  function cleanLabel(s) {
    if (typeof s !== 'string') return '';
    var t = s.replace(INVISIBLE, '').replace(/\s+/g, ' ').trim();
    var cps = Array.from(t);
    return cps.length > LABEL_MAX ? cps.slice(0, LABEL_MAX).join('').trim() : t;
  }

  /**
   * GET /api/status's body (text or an already parsed object) -> { ok: true, status } or
   * { ok: false, error: 'size' | 'json' | 'shape' | 'api' }. Unknown fields are ignored; the parts read
   * must have the firmware's shape (api 1). status:
   *   { state: 'none'|'ringing'|'snoozed'|'testing', label, until (epoch s while snoozed, else null),
   *     next: null | { day 0-6 (0 = Sunday), time 'HH:MM' (24 h, clock-local), label },
   *     known (time.known), epoch, offset (seconds east of UTC; both null unless known) }
   */
  function parse(input) {
    var doc = input;
    if (typeof input === 'string') {
      if (input.length > MAX_TEXT) return { ok: false, error: 'size' };
      try {
        doc = JSON.parse(input);
      } catch (e) {
        return { ok: false, error: 'json' };
      }
    }
    if (!isObj(doc)) return { ok: false, error: 'shape' };
    if (doc.api !== 1) return { ok: false, error: 'api' };
    var a = doc.alarm;
    var t = doc.time;
    if (!isObj(a) || STATES.indexOf(a.state) < 0) return { ok: false, error: 'shape' };
    if (!isObj(t) || typeof t.known !== 'boolean') return { ok: false, error: 'shape' };
    var next = null;
    if (a.next !== null && a.next !== undefined) {
      var n = a.next;
      if (!isObj(n) || !isInt(n.day) || n.day < 0 || n.day > 6 || typeof n.time !== 'string' || !HHMM.test(n.time)) {
        return { ok: false, error: 'shape' };
      }
      next = { day: n.day, time: n.time, label: cleanLabel(n.label) };
    }
    var known = t.known;
    var epoch = known && isInt(t.epoch) ? t.epoch : null;
    var offset = known && isInt(t.offset) && Math.abs(t.offset) <= 14 * 3600 ? t.offset : null;
    return {
      ok: true,
      status: {
        state: a.state,
        label: a.state === 'none' ? '' : cleanLabel(a.label),
        until: a.state === 'snoozed' && isInt(a.until) ? a.until : null,
        next: known ? next : null,
        known: known,
        epoch: epoch,
        offset: offset
      }
    };
  }

  /** A normalized status as parse() makes it (used to trust what comes back from the session cache). */
  function isStatus(s) {
    if (!isObj(s) || STATES.indexOf(s.state) < 0 || typeof s.label !== 'string' || typeof s.known !== 'boolean') return false;
    if (s.until !== null && !isInt(s.until)) return false;
    if (s.epoch !== null && !isInt(s.epoch)) return false;
    if (s.offset !== null && !isInt(s.offset)) return false;
    if (s.next === null) return true;
    return isObj(s.next) && isInt(s.next.day) && s.next.day >= 0 && s.next.day <= 6 &&
      typeof s.next.time === 'string' && HHMM.test(s.next.time) && typeof s.next.label === 'string';
  }

  /** 19, 5 -> '7:05 pm' (12 h) or '19:05' (24 h). */
  function clockTime(hour, minute, clock24) {
    if (clock24) return pad2(hour) + ':' + pad2(minute);
    return (hour % 12 || 12) + ':' + pad2(minute) + ' ' + (hour < 12 ? 'am' : 'pm');
  }

  // Seconds of the clock's local time -> { day (since 1970), weekday 0-6, minute of the day }.
  function localParts(localSeconds) {
    var day = Math.floor(localSeconds / 86400);
    var sec = localSeconds - day * 86400;
    return { day: day, weekday: (((day + 4) % 7) + 7) % 7, minute: Math.floor(sec / 60) };
  }

  /**
   * 'today', 'tomorrow' or the weekday ('mon') of status.next, against the clock's local time when the
   * status was made. Like the firmware's nextAlarm(): today only while its minute is still to come.
   */
  function whenWord(s) {
    var n = s.next;
    var m = HHMM.exec(n.time);
    var minute = (+m[1]) * 60 + (+m[2]);
    if (s.epoch === null || s.offset === null) return DAYS[n.day];
    var now = localParts(s.epoch + s.offset);
    var ahead = (n.day - now.weekday + 7) % 7;
    if (ahead === 0 && minute <= now.minute) ahead = 7;
    return ahead === 0 ? 'today' : ahead === 1 ? 'tomorrow' : DAYS[n.day];
  }

  var HIDDEN = Object.freeze({ show: false, kind: 'hidden', text: '', parts: Object.freeze([]), ringing: false, tone: 'muted', time: null });

  /**
   * The line for a normalized status (null, or anything isStatus() refuses -> hidden; never throws).
   * opts.clock24: the new tab's 12/24 h setting.
   * -> { show, kind: 'ringing'|'snoozed'|'next'|'none'|'unknown'|'hidden', text, parts (the segments
   *    between ' · ', without the ⌂), ringing (the status line pulses), tone: 'accent'|'text'|'muted',
   *    time (the clock time inside parts[1], e.g. '7:00 am', or null) }
   * Labels are shown in lower case, like the rest of the console's copy. The page shows lineText() of it
   * (without the leading "pixelclock" segment).
   */
  function describe(s, opts) {
    if (!isStatus(s)) return HIDDEN;
    var clock24 = !!(opts && opts.clock24);
    var label = s.label ? s.label.toLowerCase() : '';
    var kind;
    var tone = 'muted';
    var parts;
    var time = null;
    if (s.state === 'ringing' || s.state === 'testing') {
      kind = 'ringing';
      tone = 'accent';
      parts = ['ringing'];
      if (s.state === 'testing') parts.push('test');
      else if (label) parts.push(label);
    } else if (s.state === 'snoozed') {
      kind = 'snoozed';
      tone = 'text';
      if (s.until !== null && s.offset !== null) {
        var u = localParts(s.until + s.offset).minute;
        time = clockTime(Math.floor(u / 60), u % 60, clock24);
        parts = ['snoozed until ' + time];
      } else {
        parts = ['snoozed'];
      }
      if (label) parts.push(label);
    } else if (!s.known) {
      kind = 'unknown';
      parts = ['time not set'];
    } else if (!s.next) {
      kind = 'none';
      parts = ['no alarm set'];
    } else {
      kind = 'next';
      var m = HHMM.exec(s.next.time);
      time = clockTime(+m[1], +m[2], clock24);
      parts = ['next alarm ' + whenWord(s) + ' ' + time];
      if (s.next.label) parts.push(s.next.label.toLowerCase());
    }
    parts.unshift('pixelclock');
    return { show: true, kind: kind, text: GLYPH + ' ' + parts.join(SEP), parts: parts, ringing: kind === 'ringing', tone: tone, time: time };
  }

  /** The line as the page shows it: '⌂ next alarm tomorrow 7:00 am · work' ('' when hidden). */
  function lineText(view) {
    return view && view.show ? GLYPH + ' ' + view.parts.slice(1).join(SEP) : '';
  }

  /** Normalized example statuses (the fixtures' answers) for previews and the style tile. */
  function sample(name) {
    var base = { state: 'none', label: '', until: null, next: { day: 1, time: '07:00', label: 'Work' }, known: true, epoch: 1794794400, offset: -21600 };
    var table = {
      normal: {},
      ringing: { state: 'ringing', label: 'Work' },
      snoozed: { state: 'snoozed', label: 'Work', until: 1794794940 },
      testing: { state: 'testing' },
      'first-boot': { next: null },
      'no-time': { known: false, epoch: null, offset: null, next: null },
      'safe-mode': {}
    };
    var key = name || 'normal';
    if (!Object.prototype.hasOwnProperty.call(table, key)) return null;
    var change = table[key];
    var s = JSON.parse(JSON.stringify(base));
    for (var k in change) if (Object.prototype.hasOwnProperty.call(change, k)) s[k] = change[k];
    return s;
  }

  /**
   * The session cache on a chrome.storage area (chrome.storage.session): { read() -> Promise<record|null>,
   * write(record) -> Promise }. Never throws; null when the area is missing.
   */
  function sessionCache(area, key) {
    key = key || CACHE_KEY;
    if (!area || typeof area.get !== 'function' || typeof area.set !== 'function') return null;
    return {
      read: function () {
        try {
          return Promise.resolve(area.get(key)).then(function (r) { return (r && r[key]) || null; }, function () { return null; });
        } catch (e) {
          return Promise.resolve(null);
        }
      },
      write: function (record) {
        var o = {};
        o[key] = record;
        try {
          return Promise.resolve(area.set(o)).then(function () {}, function () {});
        } catch (e) {
          return Promise.resolve();
        }
      }
    };
  }

  /**
   * The poller. opts (all optional):
   *   fetch, url (tests point it at the mock clock's /api/status on 127.0.0.1), timeoutMs, firstDelayMs,
   *   pollMs, activePollMs, retryMs [after the 2nd failure, after the 3rd and later], hideAfter,
   *   cache ({ read, write }, e.g. sessionCache(chrome.storage.session)), cacheMaxAgeMs,
   *   enabled (settings.clockStatus, default true), visible (default true),
   *   now, setTimeout, clearTimeout, onChange(status | null), onDone(ok) (after every answer, true, or failure,
   *   false; never after a request that was dropped by stop() or a disable).
   * Returns { start, stop, setVisible, setEnabled, refresh, status, view, state }.
   */
  function createClient(opts) {
    var o = opts || {};
    var url = o.url || STATUS_URL;
    var timeoutMs = o.timeoutMs > 0 ? o.timeoutMs : TIMEOUT_MS;
    var firstDelayMs = o.firstDelayMs >= 0 ? o.firstDelayMs : FIRST_DELAY_MS;
    var pollMs = o.pollMs > 0 ? o.pollMs : POLL_MS;
    var activePollMs = o.activePollMs > 0 ? o.activePollMs : ACTIVE_POLL_MS;
    var retryMs = Array.isArray(o.retryMs) && o.retryMs.length ? o.retryMs.slice() : RETRY_MS.slice();
    var hideAfter = o.hideAfter > 0 ? o.hideAfter : HIDE_AFTER;
    var cacheMaxAgeMs = o.cacheMaxAgeMs >= 0 ? o.cacheMaxAgeMs : CACHE_MAX_AGE_MS;
    var cache = o.cache || null;
    var now = o.now || function () { return Date.now(); };
    var setT = o.setTimeout || function (fn, ms) { return root.setTimeout(fn, ms); };
    var clearT = o.clearTimeout || function (id) { root.clearTimeout(id); };
    var onChange = typeof o.onChange === 'function' ? o.onChange : null;
    var onDone = typeof o.onDone === 'function' ? o.onDone : null;

    var enabled = o.enabled !== false;
    var visible = o.visible !== false;
    var running = false;
    var gen = 0;          // bumped by stop/disable: late answers of an older generation are dropped
    var timer = null;
    var nextDue = 0;      // when the next request is due (ms); 0 = none planned
    var inflight = null;  // { ctrl }
    var current = null;   // the status on show (null = hidden)
    var lastOkAt = 0;
    var fails = 0;
    var stats = { requests: 0, ok: 0, failures: 0, aborted: 0, lastError: '' };

    function emit(s) {
      var before = JSON.stringify(current);
      current = s;
      if (onChange && JSON.stringify(s) !== before) {
        try { onChange(s); } catch (e) { /* the page's problem */ }
      }
    }

    function active(s) {
      return !!s && (s.state === 'ringing' || s.state === 'testing' || s.state === 'snoozed');
    }

    function disarm() {
      if (timer !== null) clearT(timer);
      timer = null;
    }

    // The longest wait ever planned: a wall clock set back cannot push the next request out further.
    var maxWaitMs = Math.max(firstDelayMs, pollMs, activePollMs, retryMs[retryMs.length - 1]);

    function arm() {
      disarm();
      if (!running || !enabled || !visible || inflight || !nextDue) return;
      timer = setT(tick, Math.min(maxWaitMs, Math.max(0, nextDue - now())));
    }

    function plan(delayMs) {
      nextDue = now() + delayMs;
      arm();
    }

    function tick() {
      timer = null;
      if (!running || !enabled || !visible || inflight) return;
      request();
    }

    function save(record) {
      if (!cache) return;
      try {
        Promise.resolve(cache.write(record)).then(null, function () {});
      } catch (e) { /* a cache that throws only loses the cache */ }
    }

    function done(ok) {
      if (!onDone) return;
      try { onDone(ok); } catch (e) { /* the page's problem */ }
    }

    function failed(why) {
      stats.failures++;
      stats.lastError = why;
      fails++;
      if (fails >= hideAfter) {
        emit(null);
        var wait = retryMs[Math.min(fails - hideAfter, retryMs.length - 1)];
        save({ v: 1, at: lastOkAt, status: null, fails: fails, retryAt: now() + wait });
        plan(wait);
      } else {
        plan(active(current) ? activePollMs : pollMs);
      }
      done(false);
    }

    function succeeded(s) {
      stats.ok++;
      fails = 0;
      lastOkAt = now();
      emit(s);
      save({ v: 1, at: lastOkAt, status: s, fails: 0, retryAt: 0 });
      plan(active(s) ? activePollMs : pollMs);
      done(true);
    }

    function request() {
      var mine = gen;
      var ctrl = typeof AbortController === 'function' ? new AbortController() : null;
      var me = { ctrl: ctrl };
      var timedOut = false;
      var guard = setT(function () {
        timedOut = true;
        if (ctrl) ctrl.abort();
      }, timeoutMs);
      var doFetch = o.fetch || (typeof root.fetch === 'function' ? root.fetch.bind(root) : null);
      inflight = me;
      stats.requests++;
      var p;
      try {
        if (!doFetch) throw new Error('no fetch');
        p = Promise.resolve(doFetch(url, {
          method: 'GET',
          cache: 'no-store',
          credentials: 'omit',
          redirect: 'error',
          referrerPolicy: 'no-referrer',
          signal: ctrl ? ctrl.signal : undefined
        }));
      } catch (e) {
        p = Promise.reject(e);
      }
      p.then(function (res) {
        if (!res || res.status !== 200) throw new Error('http ' + (res ? res.status : '?'));
        return res.text();
      }).then(function (text) {
        var r = parse(text);
        if (!r.ok) throw new Error(r.error);
        return r.status;
      }).then(function (s) {
        clearT(guard);
        if (inflight === me) inflight = null;
        if (mine !== gen) {
          stats.aborted++;
          return;
        }
        succeeded(s);
      }, function (e) {
        clearT(guard);
        if (inflight === me) inflight = null;
        if (mine !== gen) {
          stats.aborted++;
          return;
        }
        failed(timedOut ? 'timeout' : (e && e.message) || 'network');
      });
    }

    // The cache another tab left: a fresh answer shows at once; a known-offline clock keeps its backoff.
    function begin() {
      var mine = gen;
      var asked = stats.requests;
      if (!cache) {
        plan(firstDelayMs);
        return;
      }
      Promise.resolve().then(function () { return cache.read(); }).then(function (rec) {
        // Stopped or disabled meanwhile, or refresh() already asked: the cache has nothing newer to say.
        if (mine !== gen || !running || !enabled || stats.requests !== asked) return;
        var t = now();
        var delay = firstDelayMs;
        if (isObj(rec) && rec.v === 1 && typeof rec.at === 'number') {
          if (rec.status && isStatus(rec.status) && rec.at <= t + 5000 && t - rec.at < cacheMaxAgeMs) {
            lastOkAt = rec.at;
            emit(rec.status);
          } else if (!rec.status && isInt(rec.fails) && rec.fails >= hideAfter && rec.fails < 1e6) {
            // Known offline: one more failure goes straight to the long retry, and a retry time still
            // ahead (and sane) is waited for instead of asking at once.
            fails = rec.fails;
            if (typeof rec.retryAt === 'number' && rec.retryAt > t && rec.retryAt - t <= retryMs[retryMs.length - 1]) {
              delay = Math.max(firstDelayMs, rec.retryAt - t);
            }
          }
        }
        plan(delay);
      }, function () {
        if (mine === gen && running && enabled && stats.requests === asked) plan(firstDelayMs);
      });
    }

    function halt() {
      gen++;
      disarm();
      nextDue = 0;
      if (inflight && inflight.ctrl) inflight.ctrl.abort();
      inflight = null;
    }

    return {
      /** Begin polling (call it right after the first scene frame). */
      start: function () {
        if (running) return;
        running = true;
        if (enabled) begin();
      },
      /** Stop everything (timers and the request in flight). The status on show stays. */
      stop: function () {
        running = false;
        halt();
      },
      /** document.visibilityState === 'visible': hidden -> no timer and no new request. */
      setVisible: function (v) {
        v = !!v;
        if (v === visible) return;
        visible = v;
        if (visible) arm();
        else disarm();
      },
      /** settings.clockStatus: off -> never fetch, line hidden. */
      setEnabled: function (v) {
        v = !!v;
        if (v === enabled) return;
        enabled = v;
        if (!enabled) {
          halt();
          fails = 0;
          emit(null);
        } else if (running) {
          begin();
        }
      },
      /** Ask now (e.g. on 'online'); ignored while hidden, disabled, stopped or already asking. */
      refresh: function () {
        if (!running || !enabled || !visible || inflight) return false;
        plan(0);
        return true;
      },
      /** The normalized status on show, or null when the line is hidden. */
      status: function () { return current; },
      /** describe(status(), opts). */
      view: function (opts2) { return describe(current, opts2); },
      /** For tests and the page's __pcd hook. */
      state: function () {
        var t = now();
        return {
          enabled: enabled,
          visible: visible,
          running: running,
          inFlight: !!inflight,
          fails: fails,
          nextInMs: nextDue && timer !== null ? Math.max(0, nextDue - t) : null,
          lastOkAgoMs: lastOkAt ? t - lastOkAt : null,
          requests: stats.requests,
          ok: stats.ok,
          failures: stats.failures,
          aborted: stats.aborted,
          lastError: stats.lastError
        };
      }
    };
  }

  // -----------------------------------------------------------------------------------------------------
  // The page: the line element and the ringing pulse. The only DOM code in this file; nothing here runs at
  // load time. The new tab passes onView and onRinging: PCD.console draws the line and PCD.host pulses (no element).
  // Without onView the line is an element (a page of its own, the tests; it brings no styles):
  //   <p class="pcd-status" role="status" data-kind="next|ringing|snoozed|none|unknown" data-tone="muted|text|accent">
  //     <span class="pcd-status__glyph" aria-hidden="true">⌂</span> <span class="pcd-status__what">next alarm
  //     tomorrow <span class="pcd-status__time">7:00 am</span></span><span class="pcd-status__sep"> · </span>
  //     <span class="pcd-status__label">work</span></p>
  // (its textContent is exactly lineText(describe(...))) and hidden while there is nothing to show. The ringing
  // pulse is the page's ringing(on) when it passes one; otherwise pulse() flips classes on opts.ringTarget:
  // pcd-ringing while ringing, pcd-ring-on every 250 ms (frame/ring at 2 Hz), pcd-ring-steady under reduced
  // motion (no timer).

  var RING_TOGGLE_MS = 250;
  var DEFAULT_RING_CLASS = 'pcd-ringing';
  var DEFAULT_RING_ON_CLASS = 'pcd-ring-on';
  var DEFAULT_RING_STEADY_CLASS = 'pcd-ring-steady';
  var LINE_CLASS = 'pcd-status';

  /** Add or remove one class, touching the element only when it changes (one style change per flip). */
  function setClass(el, name, on) {
    if (!el) return;
    if (el.classList) {
      if (el.classList.contains(name) === !!on) return;
      if (on) el.classList.add(name);
      else el.classList.remove(name);
      return;
    }
    var all = String(el.className || '').split(/\s+/).filter(Boolean);
    if ((all.indexOf(name) >= 0) === !!on) return;
    var list = all.filter(function (c) { return c !== name; });
    if (on) list.push(name);
    el.className = list.join(' ');
  }

  /**
   * The ringing pulse on one element (mountLine's ringTarget). While on: class pcd-ringing, and pcd-ring-on flips
   * every 250 ms (frame/ring at 2 Hz); under reduced motion pcd-ring-on stays and pcd-ring-steady is set,
   * with no timer. pause() (hidden tab) leaves no timer at all; resume() picks up with the ring colour.
   * opts: reducedMotion, toggleMs, setTimeout, clearTimeout, classes ({ ringing, on, steady }: other class names,
   * e.g. the page's own is-ringing).
   * -> { set(on), setReducedMotion(bool), pause(), resume(), state(), dispose() }
   */
  function pulse(target, opts) {
    var o = opts || {};
    var names = isObj(o.classes) ? o.classes : {};
    var RING_CLASS = typeof names.ringing === 'string' && names.ringing ? names.ringing : DEFAULT_RING_CLASS;
    var RING_ON_CLASS = typeof names.on === 'string' && names.on ? names.on : DEFAULT_RING_ON_CLASS;
    var RING_STEADY_CLASS = typeof names.steady === 'string' && names.steady ? names.steady : DEFAULT_RING_STEADY_CLASS;
    var toggleMs = o.toggleMs > 0 ? o.toggleMs : RING_TOGGLE_MS;
    var setT = o.setTimeout || function (fn, ms) { return root.setTimeout(fn, ms); };
    var clearT = o.clearTimeout || function (id) { root.clearTimeout(id); };
    var on = false;
    var reduced = !!o.reducedMotion;
    var paused = false;
    var phase = false;
    var timer = null;
    var flips = 0;
    var disposed = false;

    function stopTimer() {
      if (timer !== null) clearT(timer);
      timer = null;
    }

    function paint() {
      setClass(target, RING_CLASS, on);
      setClass(target, RING_STEADY_CLASS, on && reduced);
      setClass(target, RING_ON_CLASS, on && (reduced || phase));
    }

    function tick() {
      timer = null;
      if (disposed || !on || reduced || paused) return;
      phase = !phase;
      flips++;
      paint();
      timer = setT(tick, toggleMs);
    }

    function apply() {
      stopTimer();
      phase = on;
      paint();
      if (on && !reduced && !paused && !disposed) timer = setT(tick, toggleMs);
    }

    return {
      set: function (v) {
        v = !!v;
        if (v === on || disposed) return;
        on = v;
        apply();
      },
      setReducedMotion: function (v) {
        v = !!v;
        if (v === reduced || disposed) return;
        reduced = v;
        apply();
      },
      pause: function () {
        if (paused) return;
        paused = true;
        stopTimer();
      },
      resume: function () {
        if (!paused) return;
        paused = false;
        apply();
      },
      state: function () {
        return { on: on, ringOn: on && (reduced || phase), steady: on && reduced, paused: paused, timer: timer !== null, flips: flips };
      },
      dispose: function () {
        if (disposed) return;
        on = false;
        stopTimer();
        paint();
        disposed = true;
      }
    };
  }

  /** The reduced-motion setting ('auto' | 'on' | 'off' or a boolean) as a boolean; 'auto' asks the system. */
  function motionReduced(v, win) {
    if (v === true || v === 'on') return true;
    if (v === false || v === 'off') return false;
    try {
      return !!(win && typeof win.matchMedia === 'function' && win.matchMedia('(prefers-reduced-motion: reduce)').matches);
    } catch (e) {
      return false;
    }
  }

  function isExtensionPage(chromeApi) {
    try {
      return !!(chromeApi && chromeApi.runtime && chromeApi.runtime.id);
    } catch (e) {
      return false;
    }
  }

  /** Replace the line's children with the segments of a view (textContent === lineText(view)). */
  function renderParts(doc, el, view) {
    while (el.firstChild) el.removeChild(el.firstChild);
    if (!view.show) return;
    var span = function (parent, cls, text) {
      var s = doc.createElement('span');
      s.className = cls;
      if (text !== undefined) s.textContent = text;
      parent.appendChild(s);
      return s;
    };
    span(el, LINE_CLASS + '__glyph', GLYPH).setAttribute('aria-hidden', 'true');
    el.appendChild(doc.createTextNode(' '));
    view.parts.slice(1).forEach(function (part, i) {
      if (i > 0) {
        span(el, LINE_CLASS + '__sep', SEP);
        span(el, LINE_CLASS + '__label', part);
        return;
      }
      var what = span(el, LINE_CLASS + '__what');
      var at = view.time ? part.lastIndexOf(view.time) : -1;
      if (at < 0) {
        what.textContent = part;
        return;
      }
      if (at > 0) what.appendChild(doc.createTextNode(part.slice(0, at)));
      span(what, LINE_CLASS + '__time', view.time);
      if (at + view.time.length < part.length) what.appendChild(doc.createTextNode(part.slice(at + view.time.length)));
    });
  }

  /**
   * The status line on the new tab: the poller, the element, the ringing hook, visibility and the
   * settings. opts (all optional):
   *   el            the line element (default: a new <p> appended to opts.parent when given)
   *   parent, document, window, chrome   (defaults: the page's)
   *   settings      { clockStatus, clock24, reducedMotion: 'auto'|'on'|'off'|boolean }
   *   onRinging(on) the page's ringing(on) (the new tab: PCD.host's and PCD.console's), called on every change;
   *                 without it ringTarget pulses via pulse()
   *   ringTarget    an element to pulse when there is no onRinging (a page of its own, the tests)
   *   ringClasses   pulse()'s class names ({ ringing, on, steady }), e.g. { ringing: 'is-ringing' }
   *   onView(view)  every change of what the line shows: the describe() view (show false = no line), for a look
   *                 layer that draws the line itself (PCD.console: view.status); el may then be left out (no element)
   *   onAnswer(ok)  after every answer (true) or failure (false) of the clock: the page knows the clock has had its
   *                 say (the new tab keeps a blank status row until then when the last tab showed a line)
   *   sample        a sample() name: show that status and never fetch (previews, the style tile)
   *   preview       true: never fetch. Default: true on a page without chrome.runtime.id (CORS blocks the reply
   *                 there) unless opts.client.fetch or opts.client.url is given
   *   client        extra createClient() options (fetch, url, timings, now, setTimeout, clearTimeout, cache)
   * Nothing is requested before start() (call it right after the first scene frame: no network before it).
   * -> { el, client, start(), stop(), update(settings), refresh(), view(), state(), destroy() }
   */
  function mountLine(opts) {
    var o = opts || {};
    var win = o.window || root;
    var doc = o.document || (win && win.document) || root.document;
    var chromeApi = Object.prototype.hasOwnProperty.call(o, 'chrome') ? o.chrome : root.chrome;
    var extra = isObj(o.client) ? o.client : {};
    var settings = { clockStatus: true, clock24: false, reducedMotion: 'auto' };
    var sampleStatus = o.sample ? sample(String(o.sample)) : null;
    var preview = o.preview === true || !!sampleStatus ||
      (o.preview !== false && !isExtensionPage(chromeApi) && !extra.fetch && !extra.url);
    var onView = typeof o.onView === 'function' ? o.onView : null;
    var created = false;
    var el = o.el || null;
    if (!el) {
      el = doc.createElement('p');
      created = true;
      if (o.parent) o.parent.appendChild(el);
    }
    setClass(el, LINE_CLASS, true);
    el.setAttribute('role', 'status');
    el.hidden = true;

    var visible = !doc || doc.visibilityState === undefined || doc.visibilityState === 'visible';
    var reduced = false;
    var ringing = false;
    var started = false;
    var destroyed = false;
    var last = null;
    var onRinging = typeof o.onRinging === 'function' ? o.onRinging : null;
    var pulser = !onRinging && o.ringTarget ? pulse(o.ringTarget, {
      setTimeout: extra.setTimeout, clearTimeout: extra.clearTimeout, toggleMs: o.toggleMs, classes: o.ringClasses
    }) : null;

    var cache = extra.cache !== undefined ? extra.cache : null;
    if (extra.cache === undefined && !preview) {
      try {
        cache = chromeApi && chromeApi.storage && chromeApi.storage.session ? sessionCache(chromeApi.storage.session) : null;
      } catch (e) {
        cache = null;
      }
    }
    var clientOpts = {};
    Object.keys(extra).forEach(function (k) { clientOpts[k] = extra[k]; });
    clientOpts.cache = cache;
    clientOpts.enabled = false; // set from the settings below, never before them
    clientOpts.visible = visible;
    clientOpts.onChange = function () { render(); };
    var extraDone = clientOpts.onDone;
    clientOpts.onDone = function (ok) {
      if (typeof extraDone === 'function') extraDone(ok);
      if (typeof o.onAnswer === 'function') o.onAnswer(ok);
    };
    var client = createClient(clientOpts);

    function currentView() {
      if (!settings.clockStatus) return HIDDEN;
      if (sampleStatus) return describe(sampleStatus, { clock24: settings.clock24 });
      return client.view({ clock24: settings.clock24 });
    }

    function setRinging(on) {
      if (on === ringing) return;
      ringing = on;
      if (onRinging) {
        try { onRinging(on); } catch (e) { /* the page's own problem; the line carries on */ }
      } else if (pulser) {
        pulser.set(on);
      }
    }

    function render() {
      if (destroyed) return;
      var v = currentView();
      var key = v.show + '|' + v.kind + '|' + v.tone + '|' + v.text;
      if (key !== last) {
        last = key;
        renderParts(doc, el, v);
        el.hidden = !v.show;
        el.setAttribute('data-kind', v.kind);
        el.setAttribute('data-tone', v.tone);
        if (onView) {
          try { onView(v); } catch (e) { /* the page's problem */ }
        }
      }
      setRinging(v.ringing);
    }

    function applyMotion() {
      reduced = motionReduced(settings.reducedMotion, win);
      if (pulser) pulser.setReducedMotion(reduced);
    }

    var listeners = [];
    function listen(target, type, fn) {
      if (!target || typeof target.addEventListener !== 'function') return;
      target.addEventListener(type, fn);
      listeners.push(function () { target.removeEventListener(type, fn); });
    }

    listen(doc, 'visibilitychange', function () {
      visible = doc.visibilityState === 'visible';
      client.setVisible(visible);
      if (pulser) {
        if (visible) pulser.resume();
        else pulser.pause();
      }
    });
    listen(win, 'online', function () { client.refresh(); });
    var mq = null;
    try {
      mq = win && typeof win.matchMedia === 'function' ? win.matchMedia('(prefers-reduced-motion: reduce)') : null;
    } catch (e) {
      mq = null;
    }
    listen(mq, 'change', function () { if (settings.reducedMotion === 'auto' || settings.reducedMotion === undefined) applyMotion(); });

    function update(next) {
      if (destroyed || !isObj(next)) return;
      if (typeof next.clockStatus === 'boolean') settings.clockStatus = next.clockStatus;
      if (typeof next.clock24 === 'boolean') settings.clock24 = next.clock24;
      if (next.reducedMotion !== undefined) settings.reducedMotion = next.reducedMotion;
      applyMotion();
      client.setEnabled(settings.clockStatus && !preview);
      render();
    }

    update(o.settings || {});
    if (pulser && !visible) pulser.pause();

    return {
      el: el,
      client: client,
      /** Begin (right after the first scene frame): the first request goes 300 ms later. */
      start: function () {
        if (destroyed || started) return;
        started = true;
        client.start();
        render();
      },
      stop: function () {
        started = false;
        client.stop();
      },
      /** The new tab settings changed: { clockStatus, clock24, reducedMotion } (other keys are ignored). */
      update: update,
      /** Ask now (ignored while hidden, disabled, in preview or already asking). */
      refresh: function () { return client.refresh(); },
      view: currentView,
      /** For tests and window.__pcd.status(). */
      state: function () {
        var s = client.state();
        s.preview = preview;
        s.sample = sampleStatus ? String(o.sample) : null;
        s.shown = !el.hidden;
        s.text = el.hidden ? '' : el.textContent;
        s.kind = el.getAttribute('data-kind');
        s.tone = el.getAttribute('data-tone');
        s.ringing = ringing;
        s.reducedMotion = reduced;
        s.settings = { clockStatus: settings.clockStatus, clock24: settings.clock24, reducedMotion: settings.reducedMotion };
        s.pulse = pulser ? pulser.state() : null;
        return s;
      },
      destroy: function () {
        if (destroyed) return;
        client.stop();
        setRinging(false);
        destroyed = true;
        listeners.forEach(function (off) { off(); });
        listeners = [];
        if (pulser) pulser.dispose();
        if (created && el.parentNode) el.parentNode.removeChild(el);
      }
    };
  }

  var api = {
    URL: STATUS_URL,
    TIMEOUT_MS: TIMEOUT_MS,
    FIRST_DELAY_MS: FIRST_DELAY_MS,
    POLL_MS: POLL_MS,
    ACTIVE_POLL_MS: ACTIVE_POLL_MS,
    RETRY_MS: RETRY_MS.slice(),
    HIDE_AFTER: HIDE_AFTER,
    CACHE_KEY: CACHE_KEY,
    CACHE_MAX_AGE_MS: CACHE_MAX_AGE_MS,
    STATES: STATES.slice(),
    RING_TOGGLE_MS: RING_TOGGLE_MS,
    cleanLabel: cleanLabel,
    parse: parse,
    isStatus: isStatus,
    clockTime: clockTime,
    whenWord: whenWord,
    describe: describe,
    lineText: lineText,
    sample: sample,
    sessionCache: sessionCache,
    createClient: createClient,
    motionReduced: motionReduced,
    pulse: pulse,
    mountLine: mountLine
  };
  PCD.status = api;
  return api;
});
