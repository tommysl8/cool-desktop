/* PixelClock Desktop new tab: boot.js, blocking, first in <head> (before the first paint); under 2 KB.
 * 1. Focus redirect, on by default: only a navigation the page starts takes the keys from the address
 *    bar, so the first document replaces itself once with ?focus (its query kept) and starts nothing
 *    (__pcdRedirecting). Mirror focusTerminal false: off. A query with focus never redirects (no loop).
 * 2. CSP violations are logged from the start (__pcdCsp).
 * 3. The mirror (localStorage pcd.mirror, written by js/ntp-app.js) applies before anything else: pcd-reduced (reduced
 *    motion: the setting, else the system's). The first paint is bg (css/newtab.css) until the scene covers the tab.
 */
(function (w, d) {
  'use strict';
  var m = null;
  try { m = JSON.parse(w.localStorage.getItem('pcd.mirror') || 'null'); } catch (e) { m = null; }
  if (!m || typeof m !== 'object') m = {};
  var q = w.location.search;
  if (m.focusTerminal !== false && !/[?&]focus(=|&|$)/.test(q)) {
    w.__pcdRedirecting = true;
    w.location.replace(w.location.pathname + (q ? q + '&' : '?') + 'focus');
    return;
  }
  var csp = w.__pcdCsp = [];
  d.addEventListener('securitypolicyviolation', function (e) {
    csp.push({ directive: String(e.effectiveDirective || e.violatedDirective || ''), blocked: String(e.blockedURI || ''),
      source: String(e.sourceFile || ''), line: e.lineNumber || 0 });
  });
  if (m.reducedMotion === 'on' || (m.reducedMotion !== 'off' && !!w.matchMedia &&
    w.matchMedia('(prefers-reduced-motion: reduce)').matches)) d.documentElement.classList.add('pcd-reduced');
})(window, document);
