/* PixelClock Desktop wallpaper: the Lively Wallpaper callbacks.
 *
 * Lively calls `name(args)` in the page's global scope (WebView2 ExecuteScriptAsync), so these MUST stay
 * top-level function declarations in a classic, blocking script, loaded first in <head>. Inside a module, an
 * IIFE or a bundle they would silently never be called. Keep this file free of any wrapper.
 *
 * They are safe at any time: until the app (PCD.wpApp, js/wp-app.js) has taken over, every call is queued in
 * __pcdLivelyQueue and the app replays the queue in arrival order when it starts. Lively replays every saved
 * Customise value right after the page has loaded, in any order, so early calls are normal.
 *
 *   livelyPropertyListener(name, value)   the Customise panel: dropdown -> item index, checkbox -> boolean,
 *                                         slider -> number, textbox -> string on every keystroke, button -> true
 *   livelyWallpaperPlaybackChanged(data)  '{"IsPaused":true}' or '{"IsPaused":false}' (LivelyInfo.json passes
 *                                         --pause-event true); Lively sends it when a fullscreen app runs
 *   livelySystemInformation(data)         hardware usage; only sent with --system-information, which this
 *                                         wallpaper never passes: defined so a stray call is harmless (counted)
 */
var __pcdLivelyQueue = [];
/** Calls kept while the app is not there yet (a page that never starts must not grow without bound). */
var __pcdLivelyQueueMax = 256;

function __pcdLivelyCall(kind, args) {
  var app = typeof PCD !== 'undefined' && PCD ? PCD.wpApp : null;
  if (app && typeof app.handle === 'function') return app.handle(kind, args);
  if (__pcdLivelyQueue.length >= __pcdLivelyQueueMax) __pcdLivelyQueue.shift();
  __pcdLivelyQueue.push([kind, args]);
  return undefined;
}

/** Customise panel: (name, value). Textboxes arrive on every keystroke, buttons as true. */
function livelyPropertyListener(name, val) {
  __pcdLivelyCall('property', [name, val]);
}

/** Playback state, sent on a change: a JSON string {"IsPaused": true|false}. */
function livelyWallpaperPlaybackChanged(data) {
  __pcdLivelyCall('playback', [data]);
}

/** Hardware usage (never requested by this wallpaper): counted and otherwise ignored. */
function livelySystemInformation(data) {
  __pcdLivelyCall('sysinfo', [data]);
}
