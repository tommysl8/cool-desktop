#!/usr/bin/env node
// Draws the pictures in docs/ that README.md shows. Node built-ins only.
//
//   node tools/readme-shots.mjs [--only <name,...>] [--out <dir>] [--keep]
//
//   docs/newtab.png            the Chrome new tab, 1280 x 800 at DPR 2 (2560 x 1600), on an autumn evening, after
//                              `help` in the terminal
//   docs/wallpaper-night.png   the live wallpaper, 1920 x 1080, on a snowy winter night
//   docs/wallpaper-day.png     the live wallpaper, 1920 x 1080, on a spring morning
//   docs/still.png             the still wallpaper, 1920 x 1080, on halloween at sunset
//
// Nothing personal goes in: the pieces are built into a temp folder from config/user.example.json (the sample
// city Berlin and its links), never from config/user.json, and the run stops before keeping a picture when the
// build's config files or a page's text hold your own city or links (when config/user.json is here, it is read
// only for that check, and its values are never printed). The pages run in headless Chrome through
// tools/lib/chrome.mjs (a throwaway profile, every host but 127.0.0.1 blocked, Open-Meteo answered with canned
// Berlin weather, pixelclock.local answered by tools/mock-clock.mjs), with the page's clock and time zone set to a
// fixed Berlin time. The still renders in Node with the same canned weather and never sets a wallpaper. Every
// picture is encoded again before it is kept (the same pixels, a smaller file: see compactPng). Writes only into the
// temp folder and --out.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { decodePng, pixelAt, pngSize } from './lib/png.mjs';
import { encodePng } from '../src/still/lib/png.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, '..');
const imp = (rel) => import(pathToFileURL(path.join(ROOT, ...rel.split('/'))).href);

export const TIME_ZONE = 'Europe/Berlin';
export const OUT_DIR = 'docs';
/** The largest picture README should carry, in bytes. */
export const MAX_BYTES = 1000 * 1000;
/**
 * What the canned forecast answers with, by shot: a WMO weather code, a few current values (Open-Meteo names) and
 * the day's high and low (max, min), so each picture shows a believable day of its own.
 */
export const WX = Object.freeze({
  drizzle: { weather_code: 53, precipitation: 0.3, cloud_cover: 100, max: 9.3, min: 4.8 },
  snow: { weather_code: 73, precipitation: 1.1, cloud_cover: 100, temperature_2m: 0.6, apparent_temperature: -3.4, max: 1.8, min: -3.2 },
  partly: { weather_code: 2, precipitation: 0, cloud_cover: 46, temperature_2m: 7.8, apparent_temperature: 5.1, max: 12.9, min: 4.1 },
  clear: { weather_code: 1, precipitation: 0, cloud_cover: 12, max: 11.6, min: 6.2 },
});

/**
 * The pictures: what, where and when (local Berlin time). `ready` is the extra page text to wait for before the
 * picture (the weather credit always; the clock line on the new tab).
 */
export const SHOTS = Object.freeze([
  { name: 'newtab', file: 'newtab.png', piece: 'newtab', css: [1280, 800], dpr: 2, at: '2026-11-15T20:40:00', weather: WX.drizzle, ready: ['open-meteo.com', 'next alarm'], type: ['help'] },
  { name: 'wallpaper-night', file: 'wallpaper-night.png', piece: 'wallpaper', css: [1920, 1080], dpr: 1, at: '2026-12-28T22:10:00', weather: WX.snow, ready: ['open-meteo.com'] },
  { name: 'wallpaper-day', file: 'wallpaper-day.png', piece: 'wallpaper', css: [1920, 1080], dpr: 1, at: '2027-03-06T10:20:00', weather: WX.partly, ready: ['open-meteo.com'] },
  { name: 'still', file: 'still.png', piece: 'still', css: [1920, 1080], dpr: 1, at: '2026-10-31T17:20:00', weather: WX.clear },
]);

const USAGE = `usage: node tools/readme-shots.mjs [--only <name,...>] [--out <dir>] [--keep]
  --only   draw only these pictures: ${SHOTS.map((s) => s.name).join(', ')}
  --out    the folder to write them into (default ${OUT_DIR}/)
  --keep   keep the temp build (its folder is printed)`;

/** { only, out, keep, help, errors } from command-line arguments. */
export function parseArgs(argv) {
  const res = { only: null, out: null, keep: false, help: false, errors: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--keep') res.keep = true;
    else if (a === '-h' || a === '--help') res.help = true;
    else if (a === '--only' || a === '--out') {
      const v = argv[++i];
      if (!v || v.startsWith('--')) { res.errors.push(`${a} needs a value`); continue; }
      if (a === '--out') res.out = v;
      else {
        res.only = v.split(',').map((s) => s.trim()).filter(Boolean);
        const unknown = res.only.filter((n) => !SHOTS.some((s) => s.name === n));
        if (unknown.length) res.errors.push(`unknown picture ${unknown.join(', ')} (known: ${SHOTS.map((s) => s.name).join(', ')})`);
      }
    } else res.errors.push(`unknown argument ${a}`);
  }
  return res;
}

/** The epoch ms of a local Berlin time 'YYYY-MM-DDTHH:MM:SS' (CET or CEST, the rule of chrome.mjs's mock). */
export function berlinMs(at, berlinOffset) {
  const m = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)$/.exec(at);
  if (!m) throw new Error(`not a local time: ${at}`);
  const asUtc = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  let t = asUtc - 3600 * 1000;
  t = asUtc - berlinOffset(t) * 1000;
  return asUtc - berlinOffset(t) * 1000;
}

/**
 * A page script that moves the page's clock to `ms` and lets it run on from there (Date, Date.now; timers and
 * performance.now are untouched), so the pieces draw that moment as if it were now.
 */
export function dateShim(ms) {
  return `(() => {
  const Real = Date;
  const shift = ${Number(ms)} - Real.now();
  const now = () => Real.now() + shift;
  const Shifted = new Proxy(Real, {
    construct(target, args, newTarget) { return Reflect.construct(target, args.length ? args : [now()], newTarget); },
    apply() { return new Real(now()).toString(); },
    get(target, key, receiver) { return key === 'now' ? now : Reflect.get(target, key, receiver); },
  });
  globalThis.Date = Shifted;
})();`;
}

/** Text files under dir (relative posix paths). */
function textFiles(dir) {
  const out = [];
  const walk = (d, r) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      const rr = r ? `${r}/${e.name}` : e.name;
      if (e.isDirectory()) walk(p, rr);
      else if (/\.(js|mjs|json|html|css|txt|md)$/i.test(e.name)) out.push({ rel: rr, abs: p });
    }
  };
  walk(dir, '');
  return out;
}

/**
 * What of config/user.json (when it is here) must never reach a picture: the city and the links that are not the
 * example's. Returned as { what, needle } pairs; the values are never printed.
 */
export function ownValues(root = ROOT, example) {
  const file = path.join(root, 'config', 'user.json');
  if (!fs.existsSync(file)) return [];
  let own;
  try { own = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return []; }
  const out = [];
  const city = typeof own.city === 'string' ? own.city.trim() : '';
  if (city.length >= 3 && city.toLowerCase() !== String(example.city).toLowerCase()) {
    out.push({ what: 'your city', needle: city.toLowerCase() });
    const first = city.split(',')[0].trim();
    if (first.length >= 3) out.push({ what: 'your city', needle: first.toLowerCase() });
  }
  for (const [i, s] of (Array.isArray(own.shortcuts) ? own.shortcuts : []).entries()) {
    if (!s || typeof s.url !== 'string' || (example.shortcuts || []).some((e) => e.url === s.url)) continue;
    try {
      out.push({ what: `your link ${i + 1}`, needle: new URL(s.url).hostname.toLowerCase() });
    } catch { /* not a URL: nothing to look for */ }
  }
  return out;
}

/** The files a build writes from the config (the pages' PCD.CONFIG and Lively's panel): where your answers would land. */
const CONFIG_FILES = /(^|\/)(pcd-config\.js|LivelyProperties\.json|still\.json)$/;

/** Throws (naming only what, never the value) when one of the files holds one of the needles. */
function assertNothingOwn(files, needles, where = 'the temp build') {
  for (const f of files) {
    const text = fs.readFileSync(f.abs, 'utf8').toLowerCase();
    for (const n of needles) if (text.includes(n.needle)) throw new Error(`${where} holds ${n.what} in ${f.rel}; no picture was drawn`);
  }
  return files.length;
}

/** Throws when the text a page shows holds one of the needles (named, never printed). */
async function assertPageClean(page, needles, name) {
  if (!needles.length) return;
  const text = String(await evalSoft(page, 'document.body ? document.body.innerText : ""') || '').toLowerCase();
  for (const n of needles) if (text.includes(n.needle)) throw new Error(`${name}: the page shows ${n.what}; no picture was kept`);
}

/** The new tab, the wallpaper and the still built into `dist` from the example config (never config/user.json). */
async function buildPieces(dist, config, pieces, log) {
  const B = await imp('tools/build.mjs');
  const gen = await B.generateStage({ root: ROOT, config, vendor: path.join(ROOT, 'vendor', 'pixelclock') });
  for (const piece of pieces) {
    const ctx = B.createContext({ root: ROOT, dist, config, tokens: gen.tokens, anchors: gen.anchors, generated: gen.generated, render: false, piece, log: () => {} });
    const mod = await import(pathToFileURL(path.join(ROOT, 'tools', 'build', `${piece}.mjs`)).href);
    await mod.build(ctx);
    log(`built ${piece} into the temp folder (example config, Berlin)`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Evaluate, retrying while the page swaps documents (the new tab may reload itself once to take the focus). */
async function evalSoft(page, expr) {
  try { return await page.evaluate(expr); } catch { return null; }
}

async function waitText(page, needles, timeoutMs) {
  const expr = `(() => { const t = document.body ? document.body.innerText : ''; return document.documentElement.dataset.ready === '1' && ${JSON.stringify(needles)}.every((n) => t.includes(n)); })()`;
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await evalSoft(page, expr)) return true;
    await sleep(150);
  }
  const state = await evalSoft(page, `({ ready: document.documentElement.dataset.ready || null, text: (document.body ? document.body.innerText : '').slice(0, 400) })`);
  throw new Error(`the page never showed ${needles.join(' and ')} (${JSON.stringify(state)})`);
}

/** True for the amber of a lit colon pixel (#ff9a3c); a dark colon shows the background there. */
const isAmber = ([r, g, b]) => r >= 200 && b <= 130 && r - b >= 100 && g >= 100 && g <= 200;

/**
 * The clock's colon blinks once a second (lit for the first half of every second of the page's clock): take the
 * picture at the start of a lit half and keep it only when the picture itself shows both colon pixels amber.
 */
async function captureLit(page, dpr, tries = 8) {
  const where = await evalSoft(page, `[...document.querySelectorAll('.pcd-colon')].filter((e) => e.offsetParent !== null).map((e) => { const r = e.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })`);
  if (!where || !where.length) return page.screenshot({ format: 'png' }); // no clock on screen
  for (let i = 0; i < tries; i++) {
    const ms = await evalSoft(page, 'Date.now() % 1000');
    if (typeof ms === 'number') await sleep((1000 - ms) % 1000 + 40);
    const buf = await page.screenshot({ format: 'png' });
    const img = decodePng(buf);
    if (where.every(([x, y]) => isAmber(pixelAt(img, Math.round(x * dpr), Math.round(y * dpr))))) return buf;
  }
  throw new Error('the clock\'s colon never showed lit in a picture');
}

/**
 * The same pixels in a smaller PNG. Chrome encodes its screenshots for speed; the still's encoder picks a filter per
 * row and compresses at zlib level 9, and an opaque picture loses its alpha channel. Throws if a pixel would change.
 */
export function compactPng(buf) {
  const img = decodePng(buf); // RGBA, whatever the input was
  const n = img.width * img.height;
  let opaque = true;
  for (let i = 3; i < img.data.length; i += 4) if (img.data[i] !== 255) { opaque = false; break; }
  let data = img.data;
  if (opaque) {
    data = Buffer.alloc(n * 3);
    for (let i = 0, j = 0; j < data.length; i += 4, j += 3) {
      data[j] = img.data[i];
      data[j + 1] = img.data[i + 1];
      data[j + 2] = img.data[i + 2];
    }
  }
  const out = encodePng(img.width, img.height, data, opaque ? 3 : 4, { level: 9 });
  if (!decodePng(out).data.equals(img.data)) throw new Error('compactPng: the pixels changed');
  return out;
}

/** Type a line into the new tab's terminal and press Enter (as keys, the way a person would). */
async function typeLine(page, text) {
  await page.send('Input.insertText', { text });
  const enter = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 };
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', ...enter, text: '\r' });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', ...enter });
}

/** One page picture. */
async function shootPage(browser, shot, url, needles, log) {
  const ms = berlinMs(shot.at, browser.berlinOffset);
  await browser.setWeatherMode({ mode: 'mock', now: ms, overrides: shot.weather });
  const page = await browser.newPage('about:blank');
  try {
    await page.send('Emulation.setTimezoneOverride', { timezoneId: TIME_ZONE });
    await page.send('Page.addScriptToEvaluateOnNewDocument', { source: dateShim(ms) });
    await page.setViewport(shot.css[0], shot.css[1], shot.dpr);
    await page.send('Emulation.setFocusEmulationEnabled', { enabled: true });
    await page.send('Page.bringToFront');
    await page.goto(url);
    await waitText(page, shot.ready || [], 20000);
    for (const line of shot.type || []) {
      const input = await evalSoft(page, `(() => { const i = document.querySelector('.pcd-term-input'); if (!i) return false; i.focus(); return document.activeElement === i; })()`);
      if (!input) throw new Error(`${shot.name}: the terminal's prompt never took the keys`);
      await typeLine(page, line);
      await sleep(400);
    }
    await sleep(3500); // the weather in the scene fills the sky
    await assertPageClean(page, needles, shot.name);
    const buf = await captureLit(page, shot.dpr);
    const errors = page.errors.filter((e) => !/pixelclock\.local/.test(e.text));
    if (errors.length) throw new Error(`${shot.name}: page errors: ${errors.map((e) => e.text).join(' | ').slice(0, 600)}`);
    log(`${shot.name}: ${shot.at} Berlin, ${shot.css[0]}x${shot.css[1]} @${shot.dpr}`);
    return buf;
  } finally {
    await page.close();
  }
}

/** The still: rendered by the built package's own pcd-still.mjs in --out mode with canned Berlin weather. */
async function shootStill(dist, shot, outFile, chrome, config, needles, log) {
  const install = await imp('tools/install.mjs');
  const ms = berlinMs(shot.at, chrome.berlinOffset);
  const home = path.join(path.dirname(dist), 'still-home');
  fs.mkdirSync(home, { recursive: true });
  // still.json as the installer writes it from the example config, sized for the picture
  const settings = { ...install.stillSettings(config), width: shot.css[0], height: shot.css[1], scale: shot.dpr };
  const stillJson = path.join(home, 'still.json');
  fs.writeFileSync(stillJson, JSON.stringify(settings, null, 2) + '\n');
  assertNothingOwn([{ rel: 'still.json', abs: stillJson }], needles, 'the still\'s settings');
  const requests = [];
  const fetchMock = async (url) => {
    const u = String(url);
    if (!/^https:\/\/(api|geocoding-api)\.open-meteo\.com\//.test(u)) throw new Error(`readme-shots: the still asked for ${u}`);
    requests.push(u);
    const r = chrome.mockWeatherResponse(u, { now: ms, overrides: shot.weather });
    return new Response(r.body, { status: r.status, headers: Object.fromEntries(r.headers.map((h) => [h.name, h.value])) });
  };
  const still = await import(pathToFileURL(path.join(dist, 'still', 'pcd-still.mjs')).href);
  const lines = [];
  const code = await still.main(['--out', outFile, '--at', shot.at, '--size', `${shot.css[0]}x${shot.css[1]}`, '--home', home], {
    fetch: fetchMock, env: { ...process.env, PCD_NO_WALLPAPER: '1' }, stdout: (s) => lines.push(s), stderr: (s) => lines.push(s),
  });
  if (code !== 0) throw new Error(`still: pcd-still.mjs exited ${code}: ${lines.join(' | ')}`);
  for (const u of requests) if (/geocoding/.test(u) && !/name=Berlin(&|$)/.test(u)) throw new Error('still: geocoding asked for another city');
  fs.writeFileSync(outFile, compactPng(fs.readFileSync(outFile)));
  log(`${shot.name}: ${shot.at} Berlin, ${shot.css[0]}x${shot.css[1]} (${requests.length} canned weather answers)`);
}

/** Draw the pictures. Returns the exit code. */
export async function main({ argv = process.argv.slice(2), log = console.log, logError = console.error } = {}) {
  const args = parseArgs(argv);
  if (args.help) { log(USAGE); return 0; }
  if (args.errors.length) { logError(`readme-shots: ${args.errors.join('; ')}\n${USAGE}`); return 2; }
  // The pictures show Berlin, so the still (rendered here in Node) reads Berlin's wall clock too.
  process.env.TZ = TIME_ZONE;
  const shots = SHOTS.filter((s) => !args.only || args.only.includes(s.name));
  const out = path.resolve(ROOT, args.out || OUT_DIR);
  const chrome = await imp('tools/lib/chrome.mjs');
  const { startMockClock } = await imp('tools/mock-clock.mjs');
  const { serve } = await imp('tools/lib/serve.mjs');
  const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'user.example.json'), 'utf8'));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pcd-readme-shots-'));
  const dist = path.join(tmp, 'dist');
  const opened = [];
  try {
    const pieces = [...new Set(shots.map((s) => s.piece))];
    await buildPieces(dist, config, pieces, log);
    const needles = ownValues(ROOT, config);
    const cfgFiles = textFiles(dist).filter((f) => CONFIG_FILES.test(f.rel));
    if (pieces.some((p) => p !== 'still') && !cfgFiles.length) throw new Error('the temp build wrote no config file to check');
    if (cfgFiles.length) log(`privacy: the build's ${assertNothingOwn(cfgFiles, needles)} config files hold none of your own city or links`);
    fs.mkdirSync(out, { recursive: true });

    const pageShots = shots.filter((s) => s.piece !== 'still');
    const byDpr = new Map();
    for (const s of pageShots) byDpr.set(s.dpr, [...(byDpr.get(s.dpr) || []), s]);
    for (const [dpr, list] of byDpr) {
      const needsTab = list.some((s) => s.piece === 'newtab');
      const mock = needsTab ? await startMockClock({ scenario: 'normal' }) : null;
      if (mock) opened.push(() => mock.close());
      const widest = list.reduce((a, s) => [Math.max(a[0], s.css[0]), Math.max(a[1], s.css[1])], [0, 0]);
      const browser = await chrome.launch({ extensionDebugging: needsTab, clock: mock ? mock.port : null, deviceScaleFactor: dpr, windowSize: widest, weather: { mode: 'mock' } });
      browser.berlinOffset = chrome.berlinOffset;
      opened.push(() => browser.close());
      const id = needsTab ? await browser.loadUnpacked(path.join(dist, 'newtab')) : null;
      for (const s of list) {
        // each wallpaper picture on its own port: a fresh origin, so no weather cached by the one before
        const site = s.piece === 'wallpaper' ? await serve(path.join(dist, 'wallpaper')) : null;
        try {
          const url = s.piece === 'newtab' ? `chrome-extension://${id}/newtab.html` : `${site.url}index.html`;
          const buf = await shootPage(browser, s, url, needles, log);
          fs.writeFileSync(path.join(out, s.file), compactPng(buf));
        } finally {
          if (site) await site.close();
        }
      }
      const reqs = browser.weatherRequests;
      if (!reqs.every((r) => r.action === 'mocked')) throw new Error('an Open-Meteo request was not answered with canned weather');
      browser.assertNoViolations();
      log(`chrome @${dpr}: ${reqs.length} Open-Meteo request(s), all canned; nothing blocked`);
    }
    const still = shots.find((s) => s.piece === 'still');
    if (still) await shootStill(dist, still, path.join(out, still.file), chrome, config, needles, log);

    const big = [];
    for (const s of shots) {
      const file = path.join(out, s.file);
      const size = pngSize(fs.readFileSync(file));
      const want = [s.css[0] * s.dpr, s.css[1] * s.dpr];
      if (size.width !== want[0] || size.height !== want[1]) throw new Error(`${s.file} is ${size.width}x${size.height}, expected ${want.join('x')}`);
      const bytes = fs.statSync(file).size;
      if (bytes > MAX_BYTES) big.push(s.file);
      log(`wrote ${path.relative(ROOT, file)} (${size.width}x${size.height}, ${Math.round(bytes / 1024)} KB)`);
    }
    if (big.length) {
      logError(`readme-shots: over ${MAX_BYTES / 1000 / 1000} MB: ${big.join(', ')} (a smaller scale or a calmer moment keeps README light)`);
      return 1;
    }
    return 0;
  } catch (e) {
    logError(`readme-shots: ${e && e.stack ? e.stack : e}`);
    return 1;
  } finally {
    for (const close of opened.reverse()) {
      try { await close(); } catch { /* already closed */ }
    }
    if (args.keep) log(`kept the temp build in ${tmp}`);
    else fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

function isMainModule() {
  if (typeof import.meta.main === 'boolean') return import.meta.main;
  if (!process.argv[1]) return false;
  try {
    return path.relative(fs.realpathSync(process.argv[1]), fileURLToPath(import.meta.url)) === '';
  } catch {
    return false;
  }
}

if (isMainModule()) {
  main().then(
    (code) => { process.exitCode = code; setTimeout(() => process.exit(code), 3000).unref(); },
    (e) => { console.error(e); process.exit(1); },
  );
}
