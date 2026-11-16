#!/usr/bin/env node
/*
 * Headless theme renderer: runs themes outside the browser and writes PNGs
 * that look like the real LED panel. Handy for reviewing themes and for
 * README screenshots.
 *
 *   node tools/render.js christmas                 one theme, now
 *   node tools/render.js halloween --hour 21       at 9 pm
 *   node tools/render.js all --hour 12             contact sheet of every theme
 *   node tools/render.js july4 --frames 4          4 frames, 0.5 s apart, side by side
 *   node tools/render.js winter --shake            trigger the shake effect first
 *   node tools/render.js auto --date 2026-10-31    whatever the schedule picks that day
 *   node tools/render.js screens                   contact sheet of the system screens
 *
 * Options: --hour H (decimal), --date YYYY-MM-DD, --seconds S (warm-up, default 3),
 *          --frames N, --gap S, --scale PX (per LED, default 6), --out FILE, --seed N
 *
 * Also used as a module by tools/compare.js.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const root = path.join(__dirname, '..', 'simulator');
require(path.join(root, 'engine.js'));
require(path.join(root, 'schedule.js'));
require(path.join(root, 'screens.js'));
const themeDir = path.join(root, 'themes');
for (const f of fs.readdirSync(themeDir).sort()) {
  if (f.endsWith('.js')) require(path.join(themeDir, f));
}
const PC = globalThis.PixelClock;

const STEP = 1 / 30;

// The theme ctx at o.hour (plus extraSeconds) on o's date, like render.cpp's ctxAt.
function ctxAt(o, extraSeconds = 0) {
  const hf = (o.hour + extraSeconds / 3600) % 24;
  const hours = Math.floor(hf);
  const minutes = Math.floor((hf - hours) * 60);
  return {
    hours, minutes, seconds: 0, ms: 0, hourFloat: hf, hour12: true, shake: false,
    year: o.year, month: o.month, day: o.day,
  };
}

// One system screen (simulator/screens.js), as a framebuffer.
// o: { screen, t, network, address, host, progress, safeLevel, clock (bool), hour, year, month, day }
function runScreen(o) {
  const fb = new PC.Canvas();
  PC.drawSystemScreen(fb, {
    screen: o.screen,
    t: o.t || 0,
    network: o.network || '',
    address: o.address || '',
    host: o.host || '',
    progress: o.progress || 0,
    safeLevel: o.safeLevel || 0,
    clock: o.clock ? ctxAt(o) : null,
  });
  return Uint32Array.from(fb.px);
}

// Lines of small text, white on black, 7 LEDs apart (like render.cpp --text).
function runText(lines) {
  const fb = new PC.Canvas();
  fb.clear(0);
  lines.forEach((line, i) => PC.drawSmallText(fb, line, 0, 1 + 7 * i, 0xffffff));
  return Uint32Array.from(fb.px);
}

// Sample data for each system screen, for the contact sheet and tools/compare.js.
const SCREEN_SAMPLES = [
  { screen: 'connecting', t: 0.5, network: 'Home WiFi' },
  { screen: 'setup', t: 0.3, network: 'PixelClock-Setup' },
  { screen: 'address', address: '192.168.1.42', host: 'pixelclock.local' },
  { screen: 'settingTime', t: 0.4 },
  { screen: 'noWifi' },
  { screen: 'updating', progress: 42 },
  { screen: 'restarting', t: 0.7 },
  { screen: 'safe', safeLevel: 1, clock: true, hour: 9.5, year: 2026, month: 11, day: 14 },
  { screen: 'safe', safeLevel: 2 },
];

// Run a theme and return an array of framebuffers (Uint32Array copies).
// o: { hour, year, month, day, warmup, frames, gap, seed, shake }
function run(theme, o) {
  const at = (extraSeconds) => ctxAt(o, extraSeconds);
  const rng = new PC.Rng(o.seed);
  const inst = theme.create(rng);
  const fb = new PC.Canvas();
  const out = [];
  let t = 0;
  const steps = (s) => Math.round(s / STEP);
  for (let i = 0; i < steps(o.warmup); i++, t += STEP) {
    const ctx = at(t);
    ctx.shake = !!o.shake && i === steps(o.warmup) - steps(1);
    inst.update(STEP, ctx);
  }
  for (let f = 0; f < o.frames; f++) {
    if (f > 0) for (let i = 0; i < steps(o.gap); i++, t += STEP) inst.update(STEP, at(t));
    inst.draw(fb, at(t));
    out.push(Uint32Array.from(fb.px));
  }
  return out;
}

// ---------- PNG ----------
const CRC = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(width, height, rgbBytes) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 3 + 1)] = 0;
    rgbBytes.copy(raw, y * (width * 3 + 1) + 1, y * width * 3, (y + 1) * width * 3);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// Lay out 64x64 panels in a grid, each drawn as LEDs with dark gaps.
function sheet(panels, cols, scale = 6) {
  const pad = scale * 2;
  const size = 64 * scale;
  const rows = Math.ceil(panels.length / cols);
  const W = cols * size + (cols + 1) * pad;
  const H = rows * size + (rows + 1) * pad;
  const buf = Buffer.alloc(W * H * 3, 0x14);
  panels.forEach((px, i) => {
    const ox = pad + (i % cols) * (size + pad);
    const oy = pad + Math.floor(i / cols) * (size + pad);
    for (let y = 0; y < 64; y++) {
      for (let x = 0; x < 64; x++) {
        let c = px[y * 64 + x];
        const lum = ((c >> 16) & 255) + ((c >> 8) & 255) + (c & 255);
        if (lum < 24) c = 0x0c0c0c;
        for (let dy = 0; dy < scale; dy++) {
          for (let dx = 0; dx < scale; dx++) {
            const edge = scale >= 4 && (dx === 0 || dy === 0 || dx === scale - 1 || dy === scale - 1);
            const v = edge ? 0x030303 : c;
            const o = ((oy + y * scale + dy) * W + ox + x * scale + dx) * 3;
            buf[o] = (v >> 16) & 255;
            buf[o + 1] = (v >> 8) & 255;
            buf[o + 2] = v & 255;
          }
        }
      }
    }
  });
  return png(W, H, buf);
}

module.exports = { PC, run, runScreen, runText, ctxAt, SCREEN_SAMPLES, sheet, png };

// ---------- command line ----------
if (require.main === module) {
  const args = process.argv.slice(2);
  const target = args[0] && !args[0].startsWith('--') ? args[0] : 'all';
  const opt = (name, fallback) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
  };

  if (target === 'screens') {
    const panels = SCREEN_SAMPLES.map(runScreen);
    const out = opt('out', path.join(process.cwd(), 'render-screens.png'));
    fs.writeFileSync(out, sheet(panels, 3, Number(opt('scale', 6))));
    console.log(`${SCREEN_SAMPLES.map((s) => s.screen).join(', ')} -> ${out}`);
    process.exit(0);
  }
  const now = new Date();
  const [year, month, day] = opt('date', `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`)
    .split('-')
    .map(Number);
  const o = {
    hour: Number(opt('hour', now.getHours() + now.getMinutes() / 60)),
    year,
    month,
    day,
    warmup: Number(opt('seconds', 3)),
    frames: Number(opt('frames', 1)),
    gap: Number(opt('gap', 0.5)),
    seed: Number(opt('seed', 12345)),
    shake: args.includes('--shake'),
  };

  let themes;
  if (target === 'all') themes = PC.themes;
  else if (target === 'auto') themes = [PC.themeById(PC.themeIdForDate(year, month, day))].filter(Boolean);
  else themes = [PC.themeById(target)].filter(Boolean);

  if (!themes.length) {
    console.error(`No theme "${target}". Installed: ${PC.themes.map((t) => t.id).join(', ')}`);
    process.exit(1);
  }

  const panels = [];
  for (const th of themes) panels.push(...run(th, o));
  const cols = target === 'all' ? Math.min(4, panels.length) : panels.length;
  const out = opt('out', path.join(process.cwd(), `render-${target}.png`));
  fs.writeFileSync(out, sheet(panels, cols, Number(opt('scale', 6))));
  console.log(`${themes.map((t) => t.id).join(', ')} @ ${o.hour.toFixed(2)}h ${year}-${month}-${day} -> ${out}`);
}
