/*
 * Fourth of July: a waving flag on the shore of a lake, and a day that follows
 * the clock. A summer sun arcs over the lake while clouds drift by and a little
 * sailboat crosses the water; sunset turns the sky orange and pink, fireflies
 * come out at dusk, and after dark red, white and blue fireworks go up over the
 * treeline with their reflections shimmering on the lake.
 * Shake: grand finale.
 */
(function (PC) {
  'use strict';

  const { mix, dim, hash, clamp } = PC;

  const COL = {
    treesNight: 0x05080c,
    treesDay: 0x173d22,
    edgeNight: 0x131c26,
    edgeDay: 0x2f6a3a,
    shoreNight: 0x0a0d10,
    shoreDay: 0x4a3a26,
    waterTopNight: 0x0c1838,
    waterBottomNight: 0x040816,
    waterTopDay: 0x3c80c4,
    waterBottomDay: 0x16467e,
    glintNight: 0x9fb8e8,
    glintDay: 0xfff6dc,
    glitter: 0xfff2c0,
    sunLow: 0xff9a3c,
    sunHigh: 0xffe45e,
    sunGlow: 0xfff0a0,
    cloudTopDay: 0xf6f9ff,
    cloudBottomDay: 0xc6d6ea,
    cloudNight: 0x252b52,
    cloudWarm: 0xffb08a,
    hull: 0x6a3c1e,
    mast: 0x8a7a66,
    sail: 0xf4f4f0,
    sailStripe: 0xd8283a,
    lantern: 0xffd27a,
    firefly: 0xd8ff6a,
    pole: 0xb4b8c4,
    poleShade: 0x6a6e78,
    finial: 0xe8c547,
    red: 0xd8283a,
    white: 0xf2f2f2,
    blue: 0x1f3a8a,
    clock: 0xf4f6ff,
    clockShadow: 0x05070f,
  };

  const FIREWORK_COLORS = [0xff3b3b, 0xffffff, 0x4f8bff, 0xff3b3b, 0x4f8bff, 0xffe08a];

  // Sky through an early-July day in the US Midwest: sunrise ~5:35, a bright summer
  // day, golden hour ~7:30 pm, sunset ~8:30 pm, dark by ~9:15 pm.
  const SKY = [
    [0, 0x03061a, 0x1c2550],
    [4.4, 0x03061a, 0x1c2550],
    [5.1, 0x161d4c, 0x6a4874],
    [5.7, 0x3a4f94, 0xf2a46e],
    [6.7, 0x5596de, 0xc2e2f6],
    [9, 0x3c8ce6, 0xace0fb],
    [17.5, 0x3c8ce6, 0xace0fb],
    [19.3, 0x4a7ccc, 0xffd28c],
    [20.2, 0x363b86, 0xff7c52],
    [20.75, 0x24296a, 0xcf5f7c],
    [21.25, 0x10143e, 0x583a6a],
    [21.9, 0x050824, 0x26305e],
    [24, 0x03061a, 0x1c2550],
  ];

  const HORIZON = 46; // waterline: the reflection mirrors around this row
  const FLAG = { x: 11, y: 21, w: 17, h: 11 }; // flag cloth, attached to the pole at x - 1
  const POLE_X = 10;
  const SUNRISE = 5.6;
  const SUNSET = 20.5;

  // Clouds: [dx, dy, radius] blobs, squashed vertically. All stay below row 15.
  const CLOUDS = [
    { y: 21, speed: 0.6, parts: [[0, 0, 3.2], [3.5, -1.2, 3.6], [7, 0, 3], [10, 0.6, 2.2]] },
    { y: 26, speed: 0.9, parts: [[0, 0, 2.6], [3, -1, 3], [6, 0.2, 2.4]] },
    { y: 18.5, speed: 0.45, parts: [[0, 0, 2.2], [2.6, -0.8, 2.6], [5.2, 0, 2]] },
  ];

  function smoothstep(e0, e1, x) {
    const u = clamp((x - e0) / (e1 - e0), 0, 1);
    return u * u * (3 - 2 * u);
  }

  // 0 at night, 1 in full daylight, with eased ramps at dawn and dusk.
  function lightAt(hf) {
    return smoothstep(4.9, 6.6, hf) * (1 - smoothstep(19.4, 21.3, hf));
  }

  function bump(x, a, b, c) {
    return smoothstep(a, b, x) * (1 - smoothstep(b, c, x));
  }

  // Orange glow around sunrise and sunset (tints the clouds).
  function warmthAt(hf) {
    return bump(hf, 5.2, 6, 7) + bump(hf, 19, 20.3, 21.3);
  }

  // Fireworks launched per second: none by day, building from ~9 pm, peaking
  // ~9:30-10:30 pm, tapering by ~11:30 pm, and the odd one until about 2 am.
  function fireworkRate(hf) {
    const h = hf < 12 ? hf + 24 : hf;
    const show = smoothstep(20.9, 21.6, h) * (1 - smoothstep(22.6, 23.6, h));
    const late = 0.06 * smoothstep(23.2, 23.7, h) * (1 - smoothstep(25, 26, h));
    return 2 * show + late;
  }

  function create(rng) {
    let t = 0;
    let finale = 0; // seconds of finale left
    let volley = 0;
    let volleyTimer = 0;

    const fw = new PC.Fireworks(rng, {
      colors: FIREWORK_COLORS,
      rate: 0,
      x0: 24,
      x1: 58,
      launchY: HORIZON - 4,
      minY: 20,
      maxY: 31,
    });

    // Treeline heights per column: pines of varying sizes.
    const treeTop = new Int8Array(64);
    for (let x = 0; x < 64; x++) treeTop[x] = 44;
    let x = -2;
    while (x < 66) {
      const h = 3 + rng.int(6);
      const half = 1 + Math.floor(h / 2.5);
      for (let dx = -half; dx <= half; dx++) {
        const cx = x + dx;
        if (cx < 0 || cx > 63) continue;
        const top = 44 - h + Math.abs(dx) * 2;
        if (top < treeTop[cx]) treeTop[cx] = top;
      }
      x += 2 + rng.int(4);
    }

    // clouds start at random places along their drift
    const cloudX = CLOUDS.map(() => rng.float() * 84);

    // fireflies hovering near the treeline
    const flies = [];
    for (let i = 0; i < 7; i++) {
      const bx = 2 + rng.float() * 60;
      const by = 37 + rng.float() * 7;
      const ph = rng.float() * 6.283;
      const sp = 1.4 + rng.float() * 1.2;
      flies.push({ bx, by, ph, sp });
    }

    // the sailboat starts somewhere along its trip across the lake
    const boatX0 = rng.float() * 90;

    function update(dt, ctx) {
      t += dt;
      if (ctx.shake) {
        finale = 5;
        volley += 10;
      }
      if (volley > 0) {
        volleyTimer -= dt;
        if (volleyTimer <= 0) {
          fw.launch(24 + rng.float() * 34);
          volley--;
          volleyTimer = 0.1;
        }
      }
      if (finale > 0) finale -= dt;
      fw.rate = finale > 0 ? 5 : fireworkRate(ctx.hourFloat);
      fw.update(dt);
    }

    // The sun rises from behind the trees, arcs across the lake below the clock,
    // and sets behind the trees on the right. Returns where its glitter falls.
    function drawSun(cv, hf) {
      const f = (hf - SUNRISE) / (SUNSET - SUNRISE);
      if (f <= 0 || f >= 1) return { x: 0, vis: 0 };
      const h = Math.sin(Math.PI * f);
      const sx = 26 + 34 * f;
      const sy = 49 - 28 * h;
      const core = mix(COL.sunLow, COL.sunHigh, clamp(h * 2.2, 0, 1));
      const glowA = 0.38 * clamp(h * 3, 0, 1);
      const x0 = Math.floor(sx - 6);
      const y0 = Math.floor(sy - 6);
      for (let y = y0; y <= y0 + 12 && y <= HORIZON; y++) {
        for (let x = x0; x <= x0 + 12; x++) {
          const d = Math.hypot(x - sx, y - sy);
          if (d <= 2.2) cv.set(x, y, core);
          else if (d <= 2.9) cv.blend(x, y, core, 0.55);
          else if (d < 6) {
            const k = 1 - d / 6;
            cv.blend(x, y, COL.sunGlow, glowA * k * k);
          }
        }
      }
      return { x: sx, vis: clamp(h * 2.5, 0, 1) };
    }

    function drawClouds(cv, light, warm) {
      const vis = 0.12 + 0.78 * light;
      const topC = mix(mix(COL.cloudNight, COL.cloudTopDay, light), COL.cloudWarm, warm * 0.6);
      const botC = mix(mix(COL.cloudNight, COL.cloudBottomDay, light), COL.cloudWarm, warm * 0.45);
      CLOUDS.forEach((cl, i) => {
        const cx = ((cloudX[i] + t * cl.speed) % 84) - 18;
        for (let y = Math.floor(cl.y) - 5; y <= Math.floor(cl.y) + 3; y++) {
          for (let x = Math.floor(cx) - 4; x <= Math.floor(cx) + 15; x++) {
            let inside = false;
            for (const [dx, dy, r] of cl.parts) {
              const ex = x - (cx + dx);
              const ey = (y - (cl.y + dy)) * 1.25;
              if (ex * ex + ey * ey <= r * r) {
                inside = true;
                break;
              }
            }
            if (!inside || y > cl.y + 2) continue;
            cv.blend(x, y, mix(topC, botC, clamp((y - (cl.y - 3)) / 6, 0, 1)), vis);
          }
        }
      });
    }

    function drawFireflies(cv, night) {
      const a = clamp((night - 0.35) / 0.65, 0, 1);
      if (a <= 0) return;
      for (const f of flies) {
        const b = Math.sin(t * f.sp + f.ph);
        if (b <= 0.55) continue;
        const fx = f.bx + Math.sin(t * 0.7 + f.ph) * 2;
        const fy = f.by + Math.sin(t * 0.9 + f.ph * 1.3) * 1.5;
        cv.blend(fx, fy, COL.firefly, (a * (b - 0.55)) / 0.45);
      }
    }

    function drawFlag(cv, light) {
      const lit = 0.55 + 0.45 * light;
      // pole
      cv.rect(POLE_X, FLAG.y - 1, POLE_X, HORIZON, dim(COL.pole, lit));
      cv.set(POLE_X, FLAG.y - 2, dim(COL.finial, lit));
      cv.rect(POLE_X - 1, HORIZON - 1, POLE_X + 1, HORIZON, dim(COL.poleShade, lit));

      for (let c = 0; c < FLAG.w; c++) {
        // wave travels away from the pole and grows toward the free end
        const phase = t * 4 - c * 0.45;
        const dy = Math.round(Math.sin(phase) * 1.3 * (c / FLAG.w));
        const shade = (0.78 + 0.22 * Math.cos(phase)) * lit;
        for (let r = 0; r < FLAG.h; r++) {
          let col;
          if (c < 8 && r < 6) {
            col = COL.blue;
            if (c % 2 === 1 && r % 2 === 1 && c < 7) col = COL.white;
            else if (c % 2 === 0 && r % 2 === 0 && c > 0 && r > 0 && r < 5) col = COL.white;
          } else {
            col = r % 2 === 0 ? COL.red : COL.white;
          }
          cv.set(FLAG.x + c, FLAG.y + r + dy, dim(col, shade));
        }
      }
    }

    function drawWater(cv, light, sun) {
      const top = mix(COL.waterTopNight, COL.waterTopDay, light);
      const bottom = mix(COL.waterBottomNight, COL.waterBottomDay, light);
      const glint = mix(COL.glintNight, COL.glintDay, light);
      const glintA = 0.3 + 0.2 * light;
      const reflect = 0.55 - 0.15 * light;
      for (let y = HORIZON + 1; y < 64; y++) {
        const depth = (y - HORIZON - 1) / (63 - HORIZON - 1);
        const base = mix(top, bottom, depth);
        // Mirrored source row, squashed so the whole sky fits in the shallow lake.
        const sy = Math.round(HORIZON - (y - HORIZON) * 2.2);
        const a = reflect * (1 - depth * 0.6);
        const spread = 2 + depth * 4;
        for (let x = 0; x < 64; x++) {
          const wob = Math.round(Math.sin(y * 0.9 + t * 3 + x * 0.15) * (0.6 + depth * 1.4));
          const src = cv.get(clamp(x + wob, 0, 63), sy);
          let c = mix(base, src, a);
          // little horizontal glints that drift across the surface
          if (hash(x + Math.floor(t * 4), y, 97) === 0) c = mix(c, glint, glintA);
          // sun glitter: sparkles in a column under the sun
          if (sun.vis > 0 && Math.abs(x - sun.x) <= spread && hash(x * 3 + Math.floor(t * 6), y, 7) === 0) {
            c = mix(c, COL.glitter, 0.75 * sun.vis);
          }
          cv.set(x, y, c);
        }
      }
    }

    // A little sailboat drifting across the lake; its lantern glows after dark.
    function drawBoat(cv, light) {
      const bx = Math.floor((boatX0 + t * 1.2) % 90) - 13;
      const lit = 0.35 + 0.65 * light;
      const hull = dim(COL.hull, lit);
      cv.rect(bx, 55, bx + 6, 55, hull);
      cv.rect(bx + 1, 56, bx + 5, 56, hull);
      const mx = bx + 3;
      cv.rect(mx, 48, mx, 54, dim(COL.mast, lit));
      for (let r = 0; r < 6; r++) {
        const c = r === 3 ? dim(COL.sailStripe, lit) : dim(COL.sail, lit);
        cv.rect(mx + 1, 49 + r, mx + 1 + Math.floor(r * 0.6), 49 + r, c);
      }
      const lantern = clamp((0.6 - light) / 0.6, 0, 1);
      if (lantern > 0) cv.blend(mx, 47, COL.lantern, lantern);
    }

    function draw(cv, ctx) {
      const hf = ctx.hourFloat;
      const light = lightAt(hf);
      const night = 1 - light;

      const [top, bottom] = PC.skyAt(hf, SKY);
      PC.vgradient(cv, 0, 0, 63, HORIZON, top, bottom);
      PC.drawStars(cv, t, clamp((night - 0.25) / 0.75, 0, 1) * 0.9, 0, 0, 63, 34, 24);

      const sun = drawSun(cv, hf);
      drawClouds(cv, light, warmthAt(hf));
      fw.draw(cv);

      // treeline and shore
      const trees = mix(COL.treesNight, COL.treesDay, light);
      const edge = mix(COL.edgeNight, COL.edgeDay, light);
      for (let x = 0; x < 64; x++) {
        cv.rect(x, treeTop[x], x, HORIZON, trees);
        cv.set(x, treeTop[x], edge);
      }
      cv.rect(0, HORIZON - 1, 63, HORIZON, mix(COL.shoreNight, COL.shoreDay, light));

      drawFireflies(cv, night);
      drawFlag(cv, light);
      drawWater(cv, light, sun);
      drawBoat(cv, light);

      PC.drawClock(cv, ctx, COL.clock, COL.clockShadow);
    }

    return { update, draw };
  }

  PC.registerTheme({ id: 'july4', name: 'Fourth of July', kind: 'holiday', create });
})(globalThis.PixelClock);
