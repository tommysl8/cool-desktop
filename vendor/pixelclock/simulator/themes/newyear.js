/*
 * New Year's Eve: a city skyline that follows the real time of day. By day it's a
 * crisp winter afternoon with a low sun, light snow and a few birds; at sunset the
 * windows light up one by one and after dark the fireworks start, building towards
 * midnight. From 23:59 to 00:15 the sky goes wild, the party tapers off by 2 am,
 * and New Year's Day is calm with confetti left in the street.
 * The coming year sits under the clock.
 * Shake: a volley of fireworks (any time of day).
 */
(function (PC) {
  'use strict';

  const { mix, dim, hash, clamp } = PC;

  const COL = {
    // night
    skyTop: 0x04051a,
    skyBottom: 0x2e2160,
    haze: 0x6a3f86,
    back: 0x15142c,
    backEdge: 0x2a2850,
    front: 0x07070d,
    frontEdge: 0x1a1a30,
    street: 0x07070e,
    winWarm: 0xffd27a,
    winCool: 0xbfe0ff,
    winOff: 0x161628,
    farWin: 0x3a3a62,
    beacon: 0xff3030,
    lamp: 0xffc870,
    // day
    backDay: 0x75839b,
    backEdgeDay: 0x8d9ab2,
    frontDay: 0x343c52,
    frontEdgeDay: 0x4a5369,
    streetDay: 0xc6d0dc,
    winOffDay: 0x587092,
    farWinDay: 0x93a3bb,
    beaconDay: 0x6a5560,
    snow: 0xf2f6ff,
    snowNight: 0x8f9bb8,
    bird: 0x2c3346,
    // text
    year: 0xffd23f,
    yearShadow: 0x2a1a00,
    clock: 0xfff4d6,
    clockShadow: 0x05040c,
  };

  const FIREWORK_COLORS = [0xffd23f, 0xf2f2ff, 0xff4f6a, 0x5aa8ff, 0xff7fd0, 0x7dff8a, 0xffa53a];
  const CONFETTI_COLORS = [0xffd23f, 0xff7fd0, 0x4fd8ff, 0xffffff, 0x7dff8a, 0xff8a3a];

  // Sky through a late-December day in the US Midwest: [hour, top, bottom].
  const SKY_NY = [
    [0, COL.skyTop, COL.skyBottom],
    [6.3, COL.skyTop, COL.skyBottom],
    [7, 0x2b3a78, 0xe8997a],
    [7.7, 0x6f9fd8, 0xd8e2ee],
    [9, 0x7fb4e8, 0xdbeaf6],
    [15.6, 0x7fb4e8, 0xdbeaf6],
    [16.4, 0x6c80c4, 0xf2b27c],
    [16.9, 0x3e3f88, 0xea7c6c],
    [17.5, 0x15133e, 0x5c3174],
    [18.3, COL.skyTop, COL.skyBottom],
    [24, COL.skyTop, COL.skyBottom],
  ];

  // Skyline: [x0, x1, top row]. Back row is taller and lighter (further away).
  const BACK = [
    [0, 6, 40], [7, 12, 34], [13, 19, 38], [20, 25, 31], [26, 33, 37],
    [34, 39, 33], [40, 47, 39], [48, 53, 30], [54, 63, 36],
  ];
  const FRONT = [
    [0, 4, 50], [5, 11, 45], [12, 16, 52], [17, 24, 47], [25, 29, 54],
    [30, 37, 44], [38, 42, 51], [48, 55, 46], [56, 63, 50],
  ];
  const SPIRE = { x: 45, top: 24, base: 42 }; // needle tower between front buildings
  const STREET_Y = 61;

  const smooth = (u) => u * u * (3 - 2 * u);
  const ramp = (v, a, b, ya, yb) => ya + (yb - ya) * clamp((v - a) / (b - a), 0, 1);

  // 0 by day, 1 at night, with smooth dawn (6:48-7:42) and dusk (16:18-17:30).
  function nightAt(hf) {
    if (hf < 6.8) return 1;
    if (hf < 7.7) return 1 - smooth((hf - 6.8) / 0.9);
    if (hf < 16.3) return 0;
    if (hf < 17.5) return smooth((hf - 16.3) / 1.2);
    return 1;
  }

  const isJan1 = (ctx) => ctx.month === 1 && ctx.day === 1;
  const isDec31 = (ctx) => ctx.month === 12 && ctx.day === 31;

  // 23:59 on New Year's Eve to 00:15 on New Year's Day.
  function isRush(ctx) {
    return (ctx.hours === 23 && ctx.minutes >= 59 && !isJan1(ctx)) ||
      (ctx.hours === 0 && ctx.minutes < 15 && !isDec31(ctx));
  }

  // Fireworks per second: none by day, a few from dusk, building to midnight,
  // then the after-party tapers off and it's quiet from 2 am.
  function fireworkRate(ctx) {
    if (isRush(ctx)) return 3.5;
    const hf = ctx.hourFloat;
    if (isJan1(ctx)) {
      if (hf < 1.5) return ramp(hf, 0.25, 1.5, 1.2, 0.1);
      return ramp(hf, 1.5, 2, 0.1, 0);
    }
    if (hf < 17.3) return 0;
    if (hf < 18.5) return ramp(hf, 17.3, 18.5, 0, 0.15);
    if (hf < 23) return ramp(hf, 18.5, 23, 0.15, 0.8);
    return ramp(hf, 23, 24, 0.8, 1.4);
  }

  // How festive the falling flakes are: 0 = plain snow, 1 = party confetti.
  function partyAt(ctx, night) {
    const hf = ctx.hourFloat;
    if (isJan1(ctx)) return hf < 12 ? night * clamp((2.5 - hf) / 1, 0, 1) : 0;
    return hf >= 12 ? night : 0;
  }

  function create(rng) {
    let t = 0;
    let lastHour = -1;
    let volley = 0; // rockets left to launch quickly
    let volleyTimer = 0;

    const fw = new PC.Fireworks(rng, {
      colors: FIREWORK_COLORS,
      rate: 0,
      x0: 8,
      x1: 56,
      launchY: 44,
      minY: 23,
      maxY: 33,
    });

    // Windows on the front buildings. `th` decides when each lights up at dusk.
    const windows = [];
    for (const [x0, x1, top] of FRONT) {
      for (let y = top + 2; y < STREET_Y - 1; y += 3) {
        for (let x = x0 + 1; x < x1; x += 2) {
          if (hash(x, y, 5) === 0) continue; // some walls have no window
          windows.push({ x, y, on: hash(x, y, 3) !== 0, warm: hash(y, x, 4) !== 0, th: hash(x + 11, y + 5, 97) / 97 });
        }
      }
    }
    // Faint windows on the far buildings never change.
    const farWindows = [];
    for (const [x0, x1, top] of BACK) {
      for (let y = top + 2; y < 52; y += 4) {
        for (let x = x0 + 1; x < x1; x += 3) if (hash(x, y, 4) === 0) farWindows.push([x, y]);
      }
    }

    // Snow by day that turns into confetti at the party.
    const confetti = [];
    function addConfetti(anywhere) {
      confetti.push({
        x: rng.float() * 64,
        y: anywhere ? rng.float() * 60 : -1 - rng.float() * 6,
        vy: 5 + rng.float() * 6,
        ph: rng.float() * 6.283,
        sway: 0.6 + rng.float() * 1.2,
        c: CONFETTI_COLORS[rng.int(CONFETTI_COLORS.length)],
      });
    }
    for (let i = 0; i < 14; i++) addConfetti(true);

    const birds = [];

    function update(dt, ctx) {
      t += dt;
      const night = nightAt(ctx.hourFloat);
      const party = partyAt(ctx, night);
      const rush = isRush(ctx);

      // The stroke of midnight: everything at once.
      if (lastHour === 23 && ctx.hours === 0) {
        volley += 10;
        for (let i = 0; i < 4; i++) fw.burst(10 + rng.float() * 44, 22 + rng.float() * 9, FIREWORK_COLORS[rng.int(FIREWORK_COLORS.length)]);
      }
      lastHour = ctx.hours;

      if (ctx.shake) volley += 8;
      if (volley > 0) {
        volleyTimer -= dt;
        if (volleyTimer <= 0) {
          fw.launch(8 + rng.float() * 48);
          volley--;
          volleyTimer = 0.12;
        }
      }

      fw.rate = fireworkRate(ctx);
      fw.update(dt);

      // Windows flick on and off now and then.
      if (rng.chance(dt * 2)) {
        const w = windows[rng.int(windows.length)];
        w.on = !w.on;
      }

      // A few birds cross the sky by day.
      if (night < 0.4 && birds.length < 2 && rng.chance(dt * 0.12)) {
        birds.push({ x: -3, y: 21 + rng.float() * 8, v: 6 + rng.float() * 4, ph: rng.float() * 6.283 });
      }
      for (let i = birds.length - 1; i >= 0; i--) {
        birds[i].x += birds[i].v * dt;
        if (birds[i].x > 67) birds.splice(i, 1);
      }

      const target = rush ? 70 : Math.round(10 + 6 * party);
      if (confetti.length < target && rng.chance(rush ? 0.9 : 0.25)) addConfetti(false);
      const speed = 0.55 + 0.45 * party; // snow drifts down slower than confetti
      for (let i = confetti.length - 1; i >= 0; i--) {
        const p = confetti[i];
        p.y += p.vy * speed * dt;
        p.x += Math.sin(t * 2.5 + p.ph) * p.sway * dt * 6;
        if (p.y > STREET_Y + 2) {
          if (confetti.length > target) confetti.splice(i, 1);
          else {
            p.y = -1;
            p.x = rng.float() * 64;
          }
        }
      }
    }

    // Low winter sun from 7:18 to 16:36, setting behind the skyline.
    function drawSun(cv, hf, day) {
      const u = (hf - 7.3) / (16.6 - 7.3);
      if (u <= 0 || u >= 1 || day <= 0) return;
      const s = Math.sin(u * Math.PI);
      const sx = 6 + u * 52;
      const sy = 33 - s * 9;
      const core = mix(0xffe7a3, 0xffa860, clamp(1 - s * 2.2, 0, 1));
      for (let dy = -3; dy <= 3; dy++) {
        for (let dx = -3; dx <= 3; dx++) {
          const d2 = dx * dx + dy * dy;
          if (d2 > 9) continue;
          if (d2 <= 2) cv.blend(sx + dx, sy + dy, core, day * (d2 === 2 ? 0.6 : 1));
          else cv.blend(sx + dx, sy + dy, core, day * 0.22);
        }
      }
    }

    function drawBird(cv, b, day) {
      if (day <= 0) return;
      const wy = Math.sin(t * 8 + b.ph) > 0 ? -1 : 1; // wings up or down
      cv.blend(b.x - 2, b.y + wy, COL.bird, day);
      cv.blend(b.x - 1, b.y, COL.bird, day);
      cv.blend(b.x, b.y, COL.bird, day);
      cv.blend(b.x + 1, b.y, COL.bird, day);
      cv.blend(b.x + 2, b.y + wy, COL.bird, day);
    }

    function drawSkyline(cv, night, jan1) {
      const back = mix(COL.backDay, COL.back, night);
      const backEdge = mix(COL.backEdgeDay, COL.backEdge, night);
      const front = mix(COL.frontDay, COL.front, night);
      const frontEdge = mix(COL.frontEdgeDay, COL.frontEdge, night);
      const winOff = mix(COL.winOffDay, COL.winOff, night);
      const farWin = mix(COL.farWinDay, COL.farWin, night);
      const street = mix(COL.streetDay, COL.street, night);
      const lit = 0.12 + 0.7 * night; // share of windows lit: a few offices by day, most at night
      const glow = 0.45 + 0.55 * night;

      for (const [x0, x1, top] of BACK) {
        cv.rect(x0, top, x1, STREET_Y, back);
        cv.rect(x0, top, x1, top, backEdge);
      }
      for (const [x, y] of farWindows) cv.set(x, y, farWin);

      // needle tower; its red beacon only shows after dark
      cv.rect(SPIRE.x - 1, SPIRE.base - 8, SPIRE.x + 1, STREET_Y, back);
      cv.rect(SPIRE.x - 2, SPIRE.base - 10, SPIRE.x + 2, SPIRE.base - 9, backEdge);
      cv.rect(SPIRE.x, SPIRE.top, SPIRE.x, SPIRE.base - 11, backEdge);
      const on = Math.floor(t * 1.2) % 2 === 0;
      cv.set(SPIRE.x, SPIRE.top - 1, mix(COL.beaconDay, on ? COL.beacon : dim(COL.beacon, 0.3), night));

      for (const [x0, x1, top] of FRONT) {
        cv.rect(x0, top, x1, STREET_Y, front);
        cv.rect(x0, top, x1, top, frontEdge);
      }
      for (const w of windows) {
        const isLit = w.on && w.th < lit;
        cv.set(w.x, w.y, isLit ? mix(winOff, w.warm ? COL.winWarm : COL.winCool, glow) : winOff);
      }

      cv.rect(0, STREET_Y + 1, 63, 63, street);
      const lamp = mix(street, COL.lamp, night);
      for (let x = 3; x < 64; x += 12) cv.set(x, STREET_Y + 1, lamp);

      // New Year's Day: confetti left over in the street
      if (jan1) {
        const k = 0.5 + 0.4 * (1 - night);
        for (let i = 0; i < 14; i++) {
          cv.set(hash(i, 9, 64), STREET_Y + 1 + hash(i, 10, 2), dim(CONFETTI_COLORS[hash(i, 11, CONFETTI_COLORS.length)], k));
        }
      }
    }

    function draw(cv, ctx) {
      const hf = ctx.hourFloat;
      const night = nightAt(hf);
      const day = 1 - night;
      const party = partyAt(ctx, night);

      const [top, bottom] = PC.skyAt(hf, SKY_NY);
      PC.vgradient(cv, 0, 0, 63, STREET_Y, top, bottom);
      // city glow just above the rooftops after dark
      if (night > 0) {
        for (let y = 24; y < 46; y++) {
          const a = ((y - 24) / 22) * 0.5 * night;
          for (let x = 0; x < 64; x++) cv.blend(x, y, COL.haze, a);
        }
      }
      PC.drawStars(cv, t, 0.7 * night, 0, 0, 63, 26, 22);
      drawSun(cv, hf, day);
      for (const b of birds) drawBird(cv, b, day);

      fw.draw(cv);
      drawSkyline(cv, night, isJan1(ctx));

      const snowCol = mix(COL.snow, COL.snowNight, night);
      for (const p of confetti) {
        const flip = Math.sin(t * 9 + p.ph);
        const c = mix(snowCol, p.c, party);
        cv.set(p.x, p.y, flip > 0 ? c : dim(c, 1 - 0.55 * party));
      }

      // the year below the clock: on Dec 31 it's the year that's coming
      const year = isDec31(ctx) ? ctx.year + 1 : ctx.year;
      const text = String(year);
      const x = Math.floor((64 - (text.length * 4 - 1)) / 2);
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) if (dx || dy) PC.drawSmallNumber(cv, text, x + dx, 16 + dy, COL.yearShadow);
      }
      const glint = mix(COL.year, 0xfff6c8, Math.max(0, Math.sin(t * 1.3)) ** 6);
      PC.drawSmallNumber(cv, text, x, 16, glint);

      PC.drawClock(cv, ctx, COL.clock, COL.clockShadow);
    }

    return { update, draw };
  }

  PC.registerTheme({ id: 'newyear', name: "New Year's Eve", kind: 'holiday', create });
})(globalThis.PixelClock);
