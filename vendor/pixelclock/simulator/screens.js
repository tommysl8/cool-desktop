/*
 * System screens: what the clock shows instead of a theme while it joins WiFi, runs its
 * setup hotspot, shows its address, sets the time, installs an update, restarts, or runs
 * in safe mode.
 *
 * Mirrored line for line by firmware/lib/PixelClock/src/screens.cpp, and tools/compare.js
 * checks that both draw the same pixels. Integer maths only, so they stay identical.
 *
 *   PC.drawSystemScreen(canvas, {
 *     screen: 'connecting' | 'setup' | 'address' | 'settingTime' | 'noWifi' | 'updating'
 *             | 'restarting' | 'safe',
 *     t,          // seconds since the screen appeared, for the animations
 *     network,    // connecting: the WiFi name; setup: the hotspot's name
 *     address,    // address: the clock's IP address
 *     host,       // address: its name on the network
 *     progress,   // updating: 0-100
 *     safeLevel,  // safe: 1, or 2 with WiFi off. Any other screen with safeLevel > 0
 *                 //   gets a SAFE MODE tag at the top.
 *     clock,      // safe: the time, as a theme ctx, or null if it isn't known
 *   })
 */
(function (PC) {
  'use strict';

  const BG = 0x050814;
  const TEXT = 0xdfe7ff;
  const SUB = 0x7f8aa8;
  const ACCENT = 0xffd23f;
  const WARN = 0xffb000;
  const BLUE = 0x4fc3ff;
  const GREEN = 0x5ce87a;
  const UNLIT = 0x1c2438;

  // In the order the simulator lists them.
  const SYSTEM_SCREENS = [
    { id: 'connecting', name: 'Joining WiFi' },
    { id: 'setup', name: 'Setup hotspot' },
    { id: 'address', name: 'Connected, with its address' },
    { id: 'settingTime', name: 'Setting the time' },
    { id: 'noWifi', name: 'Can’t connect' },
    { id: 'updating', name: 'Installing an update' },
    { id: 'restarting', name: 'Restarting' },
    { id: 'safe', name: 'Safe mode' },
  ];

  const LINE = [31, 39, 47, 55]; // text rows under the WiFi symbol

  // At most 16 characters: as many as fit across the panel.
  const fit = (text) => [...String(text ?? '')].slice(0, 16).join('');

  function centered(cv, text, y, c) {
    const s = fit(text);
    PC.drawSmallText(cv, s, Math.floor((PC.W - PC.smallTextWidth(s)) / 2), y, c);
  }

  // The WiFi symbol: a dot and three arcs, 3 LEDs thick and 2 apart, fanning up from just
  // above (31.5, 24). ring(k) is the colour of ring k (0 is the dot). Works on doubled
  // coordinates so every test is whole numbers.
  function drawWifi(cv, ring) {
    for (let y = 6; y <= 24; y++) {
      for (let x = 13; x <= 50; x++) {
        const dx = 2 * x - 63;
        const dy = 2 * (y - 24);
        if (5 * Math.abs(dx) > -6 * dy) continue; // outside the upward fan
        const d2 = dx * dx + dy * dy; // four times the squared distance
        for (let k = 0; k <= 3; k++) {
          const r0 = 5 * k;
          const r1 = 5 * k + 3;
          if (d2 >= 4 * r0 * r0 && d2 < 4 * r1 * r1) {
            cv.set(x, y, ring(k));
            break;
          }
        }
      }
    }
  }

  // Three dots, one lit at a time, moving three times a second.
  function drawDots(cv, y, t) {
    const lit = Math.floor(t * 3) % 3;
    for (let i = 0; i < 3; i++) cv.rect(25 + i * 6, y, 26 + i * 6, y + 1, i === lit ? ACCENT : UNLIT);
  }

  function drawSystemScreen(cv, info) {
    const t = info.t || 0;
    const screen = info.screen;

    if (screen === 'safe') {
      cv.clear(0x000000);
      if (info.clock) PC.drawClock(cv, info.clock, 0xfff4e0, 0x000000);
      let y = info.clock ? 26 : 18;
      centered(cv, 'SAFE MODE', y, WARN);
      if (info.safeLevel === 2) {
        centered(cv, 'WIFI OFF', (y += 8), SUB);
        centered(cv, 'UNPLUG TO RETRY', (y += 8), SUB);
      }
      return;
    }

    cv.clear(BG);
    if (screen === 'connecting') {
      const phase = Math.floor(t * 3) % 4; // the arcs light up one after another
      drawWifi(cv, (k) => (k === 0 ? 0xffffff : k <= phase ? BLUE : UNLIT));
      centered(cv, 'CONNECTING', LINE[0], TEXT);
      centered(cv, info.network, LINE[1], SUB);
    } else if (screen === 'setup') {
      const p = Math.floor(t * 20) % 40; // a slow pulse
      const glow = (11 + (p < 20 ? p : 40 - p)) / 31;
      drawWifi(cv, (k) => PC.mix(BG, k === 0 ? 0xffffff : BLUE, glow));
      centered(cv, 'JOIN THE WIFI', LINE[0], TEXT);
      centered(cv, info.network, LINE[1], ACCENT);
      centered(cv, 'ON YOUR PHONE', LINE[2], SUB);
    } else if (screen === 'address') {
      drawWifi(cv, (k) => (k === 0 ? 0xffffff : GREEN));
      centered(cv, 'CONNECTED', LINE[0], TEXT);
      centered(cv, info.address, LINE[1], ACCENT);
      centered(cv, info.host, LINE[2], SUB);
    } else if (screen === 'settingTime') {
      drawWifi(cv, (k) => (k === 0 ? 0xffffff : BLUE));
      centered(cv, 'SETTING THE TIME', LINE[0], TEXT);
      drawDots(cv, LINE[1] + 2, t);
    } else if (screen === 'noWifi') {
      drawWifi(cv, (k) => (k === 0 ? WARN : UNLIT));
      centered(cv, "CAN'T CONNECT", LINE[0], WARN);
      centered(cv, 'HOLD UP+DOWN', LINE[1], TEXT);
      centered(cv, 'FOR 5 SECONDS', LINE[2], TEXT);
      centered(cv, 'TO SET UP WIFI', LINE[3], SUB);
    } else if (screen === 'updating') {
      const pct = Math.max(0, Math.min(100, Math.floor(info.progress || 0)));
      centered(cv, 'UPDATING', 14, TEXT);
      cv.rect(6, 24, 57, 30, UNLIT);
      cv.rect(7, 25, 56, 29, BG);
      const fill = Math.floor((48 * pct) / 100);
      if (fill > 0) cv.rect(8, 26, 7 + fill, 28, ACCENT);
      centered(cv, `${pct}%`, 36, ACCENT);
      centered(cv, 'DO NOT UNPLUG', 50, SUB);
    } else if (screen === 'restarting') {
      centered(cv, 'RESTARTING', 26, TEXT);
      drawDots(cv, 36, t);
    }
    if (info.safeLevel > 0) centered(cv, 'SAFE MODE', 0, WARN);
  }

  PC.SYSTEM_SCREENS = SYSTEM_SCREENS;
  PC.drawSystemScreen = drawSystemScreen;
})(globalThis.PixelClock);
