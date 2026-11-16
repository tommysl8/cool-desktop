/*
 * Haunted hill: a haunted house on a hill, a dead tree, tombstones, two
 * jack-o'-lanterns and a little ghost, under a sky that follows the real time
 * of day. A moody overcast day with crows and a pale sun behind the clouds, an
 * orange-and-purple sunset, then after dark a full moon, bats, windows lighting
 * up one by one, glowing pumpkins and thicker fog. Everything fades smoothly.
 * Shake: lightning strikes and a swarm of bats bursts out of the house.
 */
(function (PC) {
  'use strict';

  const { mix, clamp } = PC;
  // Stable per-pixel noise in [0, n).
  const hash = (x, y, n) => ((PC.hash(x, y, n) % n) + n) % n;

  const COL = {
    moon: 0xf6d58a,
    moonShade: 0xdcb46a,
    moonGlow: 0xffb060,
    sun: 0xfff2dc,
    sunset: 0xff9450,
    cloudDay: 0xd2ccdc,
    cloudDusk: 0xe8946a,
    cloudNight: 0x140a20,
    duskTint: 0x6a3a3a,
    window: 0xffcc4a,
    windowDim: 0x8a5a18,
    windowDark: 0x34304a,
    pumpkin: 0xe0701a,
    pumpkinShade: 0xa84a10,
    pumpkinFace: 0x5a2c0c,
    stem: 0x3a6a20,
    candle: 0xffd84a,
    candleLow: 0xffa020,
    glow: 0xff9a30,
    ghost: 0xe8ecff,
    ghostEye: 0x1a1030,
    bat: 0x05030a,
    crow: 0x16121c,
    fog: 0x9484b8,
    fogDay: 0xb4acc4,
    house: 0x0a0610,
    clock: 0xff8c1a,
    clockShadow: 0x1a0800,
  };

  // Late October in the US Midwest: [hour, sky top, sky bottom].
  const SKY = [
    [0, 0x120a26, 0x4a2460],
    [6.0, 0x120a26, 0x4a2460],
    [6.8, 0x2a1c44, 0x8a4a5a],
    [7.4, 0x5a5878, 0xd08a6a],
    [8.5, 0x7a7a94, 0xb4aec0],
    [12, 0x84809c, 0xbcb4c8],
    [16.5, 0x7a7090, 0xb8a4b4],
    [17.6, 0x6a5078, 0xe08850],
    [18.2, 0x4a2a5e, 0xd8602a],
    [18.8, 0x2a163e, 0x7a3460],
    [19.3, 0x120a26, 0x4a2460],
    [24, 0x120a26, 0x4a2460],
  ];

  const smooth = (x) => {
    x = clamp(x, 0, 1);
    return x * x * (3 - 2 * x);
  };

  // 0 in daylight, 1 after dark: dawn 6:30-7:45, dusk 5:36-7:00 pm.
  function nightAmount(h) {
    if (h < 6.5) return 1;
    if (h < 7.75) return 1 - smooth((h - 6.5) / 1.25);
    if (h < 17.6) return 0;
    if (h < 19.0) return smooth((h - 17.6) / 1.4);
    return 1;
  }

  // Warm light around sunset, strongest just after 6 pm.
  const duskAmount = (h) => clamp(1 - Math.abs(h - 18.0) / 0.9, 0, 1);

  // What each pixel of the still scene is made of; colours depend on the time of day.
  const M = { SKY: 0, MOON: 1, MOON_SHADE: 2, HILL: 3, HOUSE: 4, GROUND: 5, TUFT: 6, STONE: 7, STONE_SHADE: 8, STONE_LIGHT: 9 };
  const NIGHT_COL = [0, 0, 0, 0x170c22, 0x0a0610, 0x1c1028, 0x2a1a3e, 0x6a6a7e, 0x45455a, 0x9494ae];
  const DAY_COL = [0, 0, 0, 0x3b3046, 0x1e1828, 0x433848, 0x564a5e, 0x8c8a98, 0x66647a, 0xa8a6b8];

  const MOON = { x: 47, y: 24, r: 7.5 };
  const TOWER_WINDOW = [21, 25];

  const hillY = (x) => Math.min(47, Math.round(33 + ((x - 15) * (x - 15)) / 40));

  const PUMPKIN_BIG = [
    '...ss...',
    '.oOOOOo.',
    'oOyOOyOo',
    'oOOOOOOo',
    'oOyyyyOo',
    '.oOyOyo.',
    '..oooo..',
  ];
  const PUMPKIN_SMALL = ['..s..', '.oOo.', 'oyOyo', 'oyyyo', '.ooo.'];
  const GHOST_A = ['.WWW.', 'WkWkW', 'WWWWW', 'WWWWW', 'WWWWW', 'W.W.W'];
  const GHOST_B = ['.WWW.', 'WkWkW', 'WWWWW', 'WWWWW', 'WWWWW', '.W.W.'];
  const BAT_UP = ['B...B', '.BBB.', '..B..'];
  const BAT_DOWN = ['.....', '.BBB.', 'B.B.B'];
  const CROW_GLIDE = ['C.....C', '.CCCCC.', '...C...'];
  const CROW_FLAP = ['.......', '.CCCCC.', 'C..C..C'];

  const WINDOWS = [
    [9, 29],
    [15, 29],
    [9, 33],
    [16, 33],
    [13, 23],
    [21, 25],
    [21, 31],
  ];

  // A sprite blended over the scene with opacity a (a = 1 draws it solid).
  function blendSprite(cv, rows, ox, oy, pal, a) {
    for (let y = 0; y < rows.length; y++) {
      const row = rows[y];
      for (let x = 0; x < row.length; x++) {
        const c = pal[row[x]];
        if (c !== undefined) cv.blend(ox + x, oy + y, c, a);
      }
    }
  }

  function create(rng) {
    let t = 0;
    const mat = new Uint8Array(64 * 64); // M.* per pixel
    const scene = new PC.Canvas(); // still scene for the current time of day
    let sceneHour = -1;
    const skyRow = new Uint32Array(48);
    const matColor = new Uint32Array(NIGHT_COL.length);

    // ---------- still scene layout (built once) ----------
    function setSolid(x, y, m) {
      if (x >= 0 && x < 64 && y >= 0 && y < 64) mat[y * 64 + x] = m;
    }

    function line(x0, y0, x1, y1, m) {
      const n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0));
      for (let i = 0; i <= n; i++) setSolid(Math.round(x0 + ((x1 - x0) * i) / n), Math.round(y0 + ((y1 - y0) * i) / n), m);
    }

    function buildLayout() {
      mat.fill(M.SKY);

      // moon with craters
      for (let y = 10; y <= 40; y++) {
        for (let x = 32; x <= 63; x++) {
          if (Math.hypot(x - MOON.x, y - MOON.y) <= MOON.r) {
            const crater = hash(Math.floor((x - 30) / 2), Math.floor((y - 10) / 2), 5) === 0;
            mat[y * 64 + x] = crater || (x - MOON.x) + (y - MOON.y) > 6 ? M.MOON_SHADE : M.MOON;
          }
        }
      }

      // hill
      for (let x = 0; x < 64; x++) for (let y = hillY(x); y < 64; y++) setSolid(x, y, M.HILL);

      // haunted house
      for (let y = 27; y <= 37; y++) for (let x = 7; x <= 20; x++) setSolid(x, y, M.HOUSE);
      for (let y = 20; y <= 26; y++) {
        const half = (y - 19) * 1.2;
        for (let x = Math.round(13.5 - half); x <= Math.round(13.5 + half); x++) setSolid(x, y, M.HOUSE);
      }
      for (let y = 22; y <= 37; y++) for (let x = 19; x <= 24; x++) setSolid(x, y, M.HOUSE);
      for (let y = 14; y <= 21; y++) {
        const half = (y - 14) * 0.45;
        for (let x = Math.round(21.5 - half); x <= Math.round(21.5 + half); x++) setSolid(x, y, M.HOUSE);
      }
      for (let y = 18; y <= 23; y++) for (let x = 9; x <= 10; x++) setSolid(x, y, M.HOUSE);
      setSolid(5, 26, M.HOUSE); // sagging eave
      setSolid(26, 22, M.HOUSE);

      // dead tree reaching across the moon
      line(58, 50, 58, 30, M.HOUSE);
      line(59, 50, 59, 36, M.HOUSE);
      line(58, 36, 52, 31, M.HOUSE);
      line(52, 31, 49, 30, M.HOUSE);
      line(54, 33, 53, 28, M.HOUSE);
      line(58, 33, 62, 27, M.HOUSE);
      line(60, 30, 63, 31, M.HOUSE);
      line(58, 31, 56, 25, M.HOUSE);
      line(56, 25, 54, 23, M.HOUSE);

      // foreground ground with tufts
      for (let x = 0; x < 64; x++) {
        const gy = 48 + Math.round(Math.sin(x * 0.2) * 0.8);
        for (let y = gy; y < 64; y++) setSolid(x, y, hash(x, y, 9) === 0 ? M.TUFT : M.GROUND);
        if (hash(x, 3, 4) === 0) setSolid(x, gy - 1, M.TUFT);
      }

      // tombstones (lit from the right)
      const stone = (x0, y0, w, h) => {
        for (let y = y0; y < y0 + h; y++) {
          for (let x = x0; x < x0 + w; x++) {
            if (y === y0 && (x === x0 || x === x0 + w - 1)) continue;
            let m = M.STONE;
            if (x === x0) m = M.STONE_SHADE;
            if (x === x0 + w - 1) m = M.STONE_LIGHT;
            if (y === y0 + h - 1) m = M.STONE_SHADE;
            setSolid(x, y, m);
          }
        }
      };
      stone(31, 47, 5, 7);
      setSolid(33, 49, M.STONE_SHADE); // engraving
      setSolid(33, 51, M.STONE_SHADE);
      stone(51, 50, 4, 6);
      // cross
      for (let y = 47; y <= 54; y++) setSolid(42, y, y === 54 ? M.STONE_SHADE : M.STONE_LIGHT);
      for (let y = 47; y <= 54; y++) setSolid(41, y, M.STONE);
      for (let x = 39; x <= 44; x++) setSolid(x, 49, x === 44 ? M.STONE_LIGHT : M.STONE);
    }
    buildLayout();

    // ---------- still scene colours for a time of day ----------
    function compose(hf) {
      const night = nightAmount(hf);
      const dusk = duskAmount(hf);
      const [top, bottom] = PC.skyAt(hf, SKY);
      for (let y = 0; y < 48; y++) skyRow[y] = mix(top, bottom, y / 47);
      for (let m = M.HILL; m < NIGHT_COL.length; m++) {
        let c = mix(DAY_COL[m], NIGHT_COL[m], night);
        if (m === M.HILL || m === M.GROUND || m === M.TUFT) c = mix(c, COL.duskTint, 0.25 * dusk);
        matColor[m] = c;
      }
      for (let y = 0; y < 64; y++) {
        for (let x = 0; x < 64; x++) {
          const i = y * 64 + x;
          const m = mat[i];
          if (m === M.SKY) scene.px[i] = skyRow[Math.min(y, 47)];
          else if (m === M.MOON || m === M.MOON_SHADE) {
            scene.px[i] = mix(skyRow[Math.min(y, 47)], m === M.MOON ? COL.moon : COL.moonShade, night);
          } else scene.px[i] = matColor[m];
        }
      }

      // pale sun glowing through the overcast, low in the east at dawn, west at dusk
      const sunUp = 1 - night;
      if (sunUp > 0.01) {
        const u = clamp((hf - 7.0) / (18.3 - 7.0), 0, 1);
        const sx = 8 + 46 * u;
        const sy = 31 - 13 * Math.sin(Math.PI * u);
        const sc = mix(COL.sun, COL.sunset, dusk);
        for (let y = Math.max(0, Math.floor(sy - 11)); y <= Math.min(47, Math.ceil(sy + 11)); y++) {
          for (let x = Math.max(0, Math.floor(sx - 11)); x <= Math.min(63, Math.ceil(sx + 11)); x++) {
            if (mat[y * 64 + x] !== M.SKY) continue;
            const d = Math.hypot(x - sx, y - sy);
            if (d >= 11) continue;
            const a = 0.26 * (1 - d / 11) + (d < 3.5 ? 0.5 * (1 - d / 3.5) : 0);
            scene.blend(x, y, sc, sunUp * a);
          }
        }
      }

      // moon glow after dark
      if (night > 0.01) {
        for (let y = 10; y <= 40; y++) {
          for (let x = 32; x <= 63; x++) {
            if (mat[y * 64 + x] !== M.SKY) continue;
            const d = Math.hypot(x - MOON.x, y - MOON.y);
            if (d > MOON.r && d < 14) scene.blend(x, y, COL.moonGlow, 0.2 * (1 - (d - MOON.r) / (14 - MOON.r)) * night);
          }
        }
      }
    }

    const stars = [];
    for (let i = 0; i < 40 && stars.length < 18; i++) {
      const x = hash(i, 41, 64);
      const y = 16 + hash(i, 43, 16);
      if (mat[y * 64 + x] === M.SKY) stars.push([x, y, i]);
    }

    // ---------- moving things ----------
    const winLevel = WINDOWS.map(() => 1);
    let towerShadow = 0;

    const bats = [];
    for (let i = 0; i < 5; i++) {
      bats.push({
        x: rng.float() * 64,
        y0: 20 + rng.float() * 11,
        y: 0,
        vx: (rng.chance(0.5) ? 1 : -1) * (7 + rng.float() * 6),
        vy: 0,
        amp: 1.5 + rng.float() * 2.5,
        ph: rng.float() * 6.283,
        flap: rng.float(),
        free: false,
      });
    }

    // slow clouds, kept below the clock (rows 15 and down)
    const clouds = [];
    for (let i = 0; i < 4; i++) {
      clouds.push({
        x: rng.float() * 80 - 8,
        y: 17 + rng.float() * 10,
        w: 8 + rng.float() * 7,
        h: 1.6 + rng.float() * 1.4,
        v: 0.5 + rng.float() * 0.7,
      });
    }

    // a couple of crows in the daytime
    const crows = [];
    for (let i = 0; i < 2; i++) {
      crows.push({
        x: rng.float() * 64,
        y0: 19 + rng.float() * 9,
        y: 0,
        vx: (rng.chance(0.5) ? 1 : -1) * (4 + rng.float() * 3),
        ph: rng.float() * 6.283,
        flap: rng.float() * 2,
      });
    }

    const ghost = { x: -6 };
    let candle = 1;

    let sinceStrike = 99;
    let bolt = [];

    // Lightning brightness over time: a flash, a dip, a second flash, then fade.
    function flashLevel(s) {
      if (s < 0.12) return 1;
      if (s < 0.25) return 0.2;
      if (s < 0.45) return 0.85;
      if (s < 1.2) return 0.85 * (1 - (s - 0.45) / 0.75);
      return 0;
    }

    function strike() {
      sinceStrike = 0;
      bolt = [];
      let x = 30 + rng.int(14);
      for (let y = 15; y <= 40; y++) {
        bolt.push([x, y]);
        if (rng.chance(0.45)) x += rng.chance(0.5) ? 1 : -1;
        if (rng.chance(0.12) && y < 34) {
          // a small fork
          let fx = x;
          for (let k = 1; k < 5; k++) bolt.push([(fx += rng.chance(0.5) ? 1 : 2), y + k]);
        }
      }
      for (let i = 0; i < 10; i++) {
        const a = -Math.PI * (0.1 + rng.float() * 0.8);
        const s = 22 + rng.float() * 18;
        bats.push({
          x: TOWER_WINDOW[0],
          y: TOWER_WINDOW[1],
          vx: Math.cos(a) * s,
          vy: Math.sin(a) * s,
          ph: rng.float() * 6.283,
          flap: rng.float(),
          free: true,
        });
      }
    }

    function update(dt, ctx) {
      t += dt;

      for (let i = 0; i < WINDOWS.length; i++) {
        let target = 0.75 + rng.float() * 0.25;
        if (rng.chance(0.004)) winLevel[i] = 0.15; // a light gutters out for a moment
        winLevel[i] += (target - winLevel[i]) * Math.min(1, dt * 2.5);
      }
      if (towerShadow > 0) towerShadow -= dt;
      else if (rng.chance(dt / 9)) towerShadow = 1.2;

      candle += (0.7 + rng.float() * 0.3 - candle) * 0.5;

      for (let i = bats.length - 1; i >= 0; i--) {
        const b = bats[i];
        b.flap += dt * (b.free ? 10 : 7);
        if (b.free) {
          b.x += b.vx * dt;
          b.y += (b.vy + Math.sin(t * 9 + b.ph) * 10) * dt;
          if (b.x < -8 || b.x > 70 || b.y < -6 || b.y > 70) bats.splice(i, 1);
        } else {
          b.x += b.vx * dt;
          b.y = b.y0 + Math.sin(t * 1.7 + b.ph) * b.amp;
          if (b.x > 70) b.x = -7;
          if (b.x < -7) b.x = 70;
        }
      }

      for (const c of clouds) {
        c.x += c.v * dt;
        if (c.x - c.w > 64) c.x = -c.w;
      }

      for (const c of crows) {
        c.flap += dt * 2.2;
        c.x += c.vx * dt;
        c.y = c.y0 + Math.sin(t * 1.1 + c.ph) * 1.2;
        if (c.x > 72) c.x = -9;
        if (c.x < -9) c.x = 72;
      }

      ghost.x += 5 * dt;
      if (ghost.x > 72) ghost.x = -8;

      if (ctx.shake) strike();
      sinceStrike += dt;
    }

    function drawClouds(cv, night, dusk) {
      const col = mix(mix(COL.cloudDay, COL.cloudDusk, dusk), COL.cloudNight, night);
      const strength = 0.38 + 0.04 * night;
      for (const c of clouds) {
        const x0 = Math.max(0, Math.floor(c.x - c.w));
        const x1 = Math.min(63, Math.ceil(c.x + c.w));
        const y0 = Math.max(15, Math.floor(c.y - c.h));
        const y1 = Math.min(47, Math.ceil(c.y + c.h));
        for (let y = y0; y <= y1; y++) {
          for (let x = x0; x <= x1; x++) {
            if (mat[y * 64 + x] > M.MOON_SHADE) continue; // only over sky and moon
            const dx = (x - c.x) / c.w;
            const dy = (y - c.y) / c.h;
            const e = 1 - (dx * dx + dy * dy);
            if (e > 0) cv.blend(x, y, col, strength * Math.min(1, e * 2));
          }
        }
      }
    }

    function drawFog(cv, night) {
      const amount = 0.4 + 0.6 * night;
      const col = mix(COL.fogDay, COL.fog, night);
      for (let y = 42; y <= 60; y++) {
        const band = 1 - Math.abs(y - 51) / 9;
        if (band <= 0) continue;
        for (let x = 0; x < 64; x++) {
          const n = Math.sin(x * 0.23 + t * 0.6) + Math.sin(x * 0.11 - t * 0.35 + y * 0.6) * 0.8;
          const a = clamp((n + 0.6) / 2.4, 0, 1) * band * 0.32 * amount;
          if (a > 0.02) cv.blend(x, y, col, a);
        }
      }
    }

    function draw(cv, ctx) {
      const hf = ctx.hourFloat;
      if (sceneHour < 0 || Math.abs(hf - sceneHour) > 0.004) {
        compose(hf);
        sceneHour = hf;
      }
      cv.px.set(scene.px);
      const night = nightAmount(hf);
      const dusk = duskAmount(hf);

      if (night > 0.01) {
        for (const [x, y, i] of stars) {
          const tw = 0.4 + 0.4 * Math.sin(t * (1.3 + (i % 4) * 0.5) + i * 2.3);
          cv.blend(x, y, 0xd8d0ff, tw * night);
        }
      }

      drawClouds(cv, night, dusk);

      // windows light up one by one through dusk (and go out again at dawn)
      WINDOWS.forEach(([x, y], i) => {
        const on = clamp((night - (0.12 + i * 0.09)) / 0.12, 0, 1);
        const lit = mix(COL.windowDim, COL.window, winLevel[i]);
        cv.rect(x, y, x + 1, y + 1, mix(COL.windowDark, lit, on));
      });
      const towerOn = clamp((night - (0.12 + 5 * 0.09)) / 0.12, 0, 1);
      if (towerShadow > 0 && towerOn > 0.5) {
        // someone walks past the tower window
        const sx = TOWER_WINDOW[0] + (towerShadow > 0.6 ? 0 : 1);
        cv.set(sx, TOWER_WINDOW[1], COL.house);
        cv.set(sx, TOWER_WINDOW[1] + 1, COL.house);
      }

      // ghost drifting over the hill: barely there by day
      const gy = Math.round(36 + Math.sin(t * 2) * 2);
      blendSprite(cv, Math.floor(t * 4) % 2 ? GHOST_A : GHOST_B, Math.round(ghost.x), gy,
        { W: COL.ghost, k: COL.ghostEye }, 0.12 + 0.88 * night);

      drawFog(cv, night);

      // jack-o'-lanterns: carved faces by day, candle glow after dusk
      const glowOn = clamp((night - 0.15) / 0.35, 0, 1);
      const lit = mix(COL.candleLow, COL.candle, candle);
      if (glowOn > 0) {
        for (const [cx, cy, r] of [[18, 55, 9], [26, 57, 6]]) {
          for (let y = cy - r; y <= cy + r; y++) {
            for (let x = cx - r; x <= cx + r; x++) {
              const d = Math.hypot(x - cx, (y - cy) * 1.3);
              if (d < r) cv.blend(x, y, COL.glow, 0.28 * candle * (1 - d / r) * glowOn);
            }
          }
        }
      }
      const pal = { O: COL.pumpkin, o: COL.pumpkinShade, s: COL.stem, y: mix(COL.pumpkinFace, lit, glowOn) };
      cv.sprite(PUMPKIN_BIG, 14, 52, pal);
      cv.sprite(PUMPKIN_SMALL, 24, 55, pal);

      // crows by day, bats after dark (bats from a lightning strike always show)
      const day = 1 - night;
      if (day > 0.01) {
        for (const c of crows) {
          blendSprite(cv, Math.floor(c.flap) % 2 ? CROW_FLAP : CROW_GLIDE, Math.round(c.x) - 3, Math.round(c.y) - 1,
            { C: COL.crow }, day);
        }
      }
      for (const b of bats) {
        const a = b.free ? 1 : night;
        if (a > 0.01) {
          blendSprite(cv, Math.floor(b.flap * 2) % 2 ? BAT_UP : BAT_DOWN, Math.round(b.x) - 2, Math.round(b.y) - 1,
            { B: COL.bat }, a);
        }
      }

      const f = flashLevel(sinceStrike);
      if (f > 0) {
        const k = f * (0.3 + 0.2 * night);
        for (let i = 14 * 64; i < cv.px.length; i++) cv.px[i] = mix(cv.px[i], 0xd8d8ff, k);
        if (sinceStrike < 0.5) for (const [x, y] of bolt) cv.set(x, y, 0xffffff);
      }

      PC.drawClock(cv, ctx, COL.clock, COL.clockShadow);
    }

    return { update, draw };
  }

  PC.registerTheme({ id: 'halloween', name: 'Haunted hill', kind: 'holiday', create });
})(globalThis.PixelClock);
