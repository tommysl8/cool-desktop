/* PixelClock Desktop shared greeting. Classic script, UMD, global PCD; require() returns PCD.greet in Node. The clock's
 * schedule (globalThis.PixelClock.HOLIDAYS) is looked up when called, never at load time; pass PC explicitly in tests.
 *
 * The rule (the same in every piece; tests check every hour): 5-11 good morning, 12-16 good afternoon, 17-21 good
 * evening, 22-4 good night. On a holiday's own date (PC.HOLIDAYS, plus 1 January) the period goes and the holiday line
 * follows: 'good evening · happy halloween' (the ' · ' in frame, the line in text: amber stays for what is live, such
 * as the colon, the prompt and ringing).
 *
 * PCD.greet
 *   RULE                  [[5, 11, 'good morning'], [12, 16, 'good afternoon'], [17, 21, 'good evening'], [22, 4, 'good night']]
 *   LINES                 { newyear: "happy new year's eve", lunarnewyear: 'happy lunar new year', valentines:
 *                         "happy valentine's day", stpatricks: "happy st. patrick's day", easter: 'happy easter', july4:
 *                         'happy fourth of july', halloween: 'happy halloween', thanksgiving: 'happy thanksgiving',
 *                         christmas: 'merry christmas' }
 *   NEW_YEARS_DAY         'happy new year' (1 January)
 *   SEPARATOR             ' · '
 *   word(hourOrDate)      'good evening': a number is floored and wraps mod 24, a Date gives its local hour; anything
 *                         else (NaN, a string, an invalid Date) gives 'hello'
 *   holiday(date, PC?)    { id, line } on a holiday's own date, else null. A holiday id without a line, a schedule
 *                         without a date that year (the lunar table ends in 2035) or no PC at all: no line (never
 *                         invented). 1 January needs no schedule.
 *   parts(date, PC?)      { word, holiday, text, runs }; runs are [text, roles] with token roles (pcd-core roleClass):
 *                         [['good evening.', 'text bold']] or
 *                         [['good evening', 'text bold'], [' · ', 'frame'], ['happy halloween', 'text']]
 *   line(date, PC?)       the text alone: 'good evening.' or 'good evening · happy halloween'
 *   ownDates(year, PC?)   [{ id, month, day, line }] for every line in a year, in calendar order (tests, style tile)
 */
(function (root, factory) {
  var api = factory(root.PCD || (root.PCD = {}), root);
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (PCD, root) {
  'use strict';

  var RULE = [[5, 11, 'good morning'], [12, 16, 'good afternoon'], [17, 21, 'good evening'], [22, 4, 'good night']];
  var LINES = {
    newyear: "happy new year's eve",
    lunarnewyear: 'happy lunar new year',
    valentines: "happy valentine's day",
    stpatricks: "happy st. patrick's day",
    easter: 'happy easter',
    july4: 'happy fourth of july',
    halloween: 'happy halloween',
    thanksgiving: 'happy thanksgiving',
    christmas: 'merry christmas'
  };
  var NEW_YEARS_DAY = 'happy new year';
  var SEPARATOR = ' · ';

  /** A Date from any realm (instanceof fails across frames and vm contexts). */
  function isDate(d) {
    return Object.prototype.toString.call(d) === '[object Date]';
  }

  function word(hourOrDate) {
    var n = isDate(hourOrDate) ? hourOrDate.getHours() : hourOrDate;
    if (typeof n !== 'number' || !isFinite(n)) return 'hello';
    var h = ((Math.floor(n) % 24) + 24) % 24;
    if (h >= 5 && h <= 11) return 'good morning';
    if (h >= 12 && h <= 16) return 'good afternoon';
    if (h >= 17 && h <= 21) return 'good evening';
    return 'good night';
  }

  function schedule(PC) {
    var P = PC || root.PixelClock;
    return P && P.HOLIDAYS && typeof P.HOLIDAYS.length === 'number' ? P.HOLIDAYS : null;
  }

  function dateOf(h, year) {
    try {
      var d = h && typeof h.date === 'function' ? h.date(year) : null;
      return d && d.length >= 2 && isFinite(d[0]) && isFinite(d[1]) ? [+d[0], +d[1]] : null;
    } catch (e) {
      return null;
    }
  }

  function holiday(date, PC) {
    if (!isDate(date) || isNaN(date.getTime())) return null;
    var y = date.getFullYear(), m = date.getMonth() + 1, d = date.getDate();
    if (m === 1 && d === 1) return { id: 'newyear', line: NEW_YEARS_DAY };
    var list = schedule(PC);
    if (!list) return null;
    for (var i = 0; i < list.length; i++) {
      var h = list[i];
      if (!h || !Object.prototype.hasOwnProperty.call(LINES, h.id)) continue;
      var on = dateOf(h, y);
      if (on && on[0] === m && on[1] === d) return { id: h.id, line: LINES[h.id] };
    }
    return null;
  }

  function parts(date, PC) {
    var w = word(date);
    var hd = w === 'hello' ? null : holiday(date, PC);
    if (!hd) return { word: w, holiday: null, text: w + '.', runs: [[w + '.', 'text bold']] };
    return {
      word: w,
      holiday: hd,
      text: w + SEPARATOR + hd.line,
      runs: [[w, 'text bold'], [SEPARATOR, 'frame'], [hd.line, 'text']]
    };
  }

  function line(date, PC) {
    return parts(date, PC).text;
  }

  function ownDates(year, PC) {
    var out = [{ id: 'newyear', month: 1, day: 1, line: NEW_YEARS_DAY }];
    var list = schedule(PC) || [];
    for (var i = 0; i < list.length; i++) {
      var h = list[i];
      if (!h || !Object.prototype.hasOwnProperty.call(LINES, h.id)) continue;
      var on = dateOf(h, year);
      if (on) out.push({ id: h.id, month: on[0], day: on[1], line: LINES[h.id] });
    }
    out.sort(function (a, b) { return a.month - b.month || a.day - b.day; });
    return out;
  }

  var api = {
    RULE: RULE,
    LINES: LINES,
    NEW_YEARS_DAY: NEW_YEARS_DAY,
    SEPARATOR: SEPARATOR,
    word: word,
    holiday: holiday,
    parts: parts,
    line: line,
    ownDates: ownDates
  };
  PCD.greet = api;
  return api;
});
