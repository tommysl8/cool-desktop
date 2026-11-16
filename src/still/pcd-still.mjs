#!/usr/bin/env node
// PixelClock Desktop: the low-power still wallpaper.
//
// Renders the current PixelClock scene in pure Node (no browser at run time) the way the live wallpaper shows it: the
// scene fills the screen, dimmed, flush left in whole-number k x k blocks, its rows continued as bands, under a fixed
// veil; the info column on the right (still.json "side": "left" moves it): the big date (the picture changes every
// 15 minutes, so it shows the date, never a time), the greeting, the date, the daylight strip, the weather and its
// credit, the scene's name and phase. Text comes from the glyph atlas (atlas/). It writes out/wall-a.png or
// out/wall-b.png and, with --set, makes it the desktop picture through a hidden Windows PowerShell 5.1
// -EncodedCommand. The scheduled task runs `pcd-still.mjs --set` every 15 minutes through run-hidden.js. Node built-ins
// only; run `node pcd-still.mjs --help`.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { atlasText, loadAtlas } from './lib/atlas.mjs';
import { encodeImage, hex } from './lib/compose.mjs';
import * as envLib from './lib/env.mjs';
import { compose, DEFAULT_SIDE, plan as planPicture, SIDES } from './lib/frames.mjs';
import { chooseTheme, daySeed, loadEngine, locateEngine, renderScene, timeParts } from './lib/scene.mjs';
import { DEFAULT_STYLE, runSetter, setterArgs } from './lib/setter.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Weather older than this is fetched again: the still accepts weather up to 60 minutes old. */
export const WEATHER_TTL_MS = 60 * 60 * 1000;
export const WEATHER_TIMEOUT_MS = 8000;
const INDOOR_THEMES = ['christmas'];

export const USAGE = `usage: node pcd-still.mjs [--set | --dry-run] [--out <file>] [--at <time>] [--size WxH] [--scale S]
                    [--detect] [--home <folder>] [--side right|left] [--theme <id>] [--quiet]

  (no flag)    render the picture into <home>/out (wall-a.png or wall-b.png) and stop
  --set        render, then set it as the desktop picture (what the scheduled task runs)
  --dry-run    render and report what --set would do; never starts PowerShell
               (PCD_NO_WALLPAPER=1 always forces a dry run)
  --out FILE   write the PNG to FILE instead (no state, no Lively check, never set)
  --at TIME    render for this local time, e.g. 2026-11-15T21:00 (default: now)
  --size WxH   picture size in device pixels (default: still.json, else the detected screen)
  --scale S    display scale (2 = 200 %): the type size and the taskbar reserve follow it
  --detect     read the screen size and scale (read-only) and save them in <home>/still.json
  --home DIR   the folder that holds still.json and out/ (default: this script's folder,
               or PCD_STILL_HOME)
  --side S     where the info column goes: right (default) or left (default: still.json)
  --theme ID   auto or a theme id (default: still.json)
  --quiet      print nothing (the log in <home>/out/still.log still gets one line)`;

/** Parsed command line: { set, dryRun, out, at, size, scale, detect, home, side, theme, quiet, help, errors }. */
export function parseArgs(argv) {
  const o = { set: false, dryRun: false, out: null, at: null, size: null, scale: null, detect: false, home: null, side: null, theme: null, quiet: false, help: false, errors: [] };
  const valueOf = (i, name) => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) {
      o.errors.push(`${name} needs a value`);
      return null;
    }
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--set') o.set = true;
    else if (a === '--dry-run') o.dryRun = true;
    else if (a === '--detect') o.detect = true;
    else if (a === '--quiet') o.quiet = true;
    else if (a === '-h' || a === '--help') o.help = true;
    else if (['--out', '--at', '--size', '--scale', '--home', '--side', '--theme'].includes(a)) {
      const v = valueOf(i, a);
      i++;
      if (v === null) continue;
      if (a === '--out') o.out = v;
      else if (a === '--home') o.home = v;
      else if (a === '--at') {
        const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:?\d{2})?$/.exec(v);
        if (!m) o.errors.push(`--at needs a date and time like 2026-11-15T21:00 (got ${v})`);
        else {
          // Date rolls an impossible day over (February 30 becomes March 2) and takes 24:00, so check the fields first
          const [y, mo, day, h, mi, s] = m.slice(1, 7).map((x) => (x === undefined ? 0 : Number(x)));
          const last = new Date(Date.UTC(y, mo, 0)).getUTCDate();
          const d = mo >= 1 && mo <= 12 && day >= 1 && day <= last && h <= 23 && mi <= 59 && s <= 59 ? new Date(v.replace(' ', 'T')) : null;
          if (!d || Number.isNaN(d.getTime())) o.errors.push(`--at: not a valid date and time: ${v}`);
          else o.at = d;
        }
      } else if (a === '--size') {
        const m = /^(\d{2,5})x(\d{2,5})$/i.exec(v);
        const w = m ? Number(m[1]) : 0;
        const h = m ? Number(m[2]) : 0;
        if (!m || w < 64 || h < 64 || w > 16384 || h > 16384) o.errors.push(`--size needs WxH between 64 and 16384 (got ${v})`);
        else o.size = { width: w, height: h };
      } else if (a === '--scale') {
        const s = Number(v);
        if (!(s >= 0.5 && s <= 4)) o.errors.push(`--scale needs a number from 0.5 to 4 (got ${v})`);
        else o.scale = s;
      } else if (a === '--side') {
        if (!SIDES.includes(v)) o.errors.push(`--side is right or left (got ${v})`);
        else o.side = v;
      } else if (a === '--theme') {
        if (!/^[a-z0-9_-]{1,40}$/.test(v)) o.errors.push(`--theme: not a theme id: ${v}`);
        else o.theme = v;
      }
    } else o.errors.push(`unknown argument ${a}`);
  }
  if (o.set && o.dryRun) o.errors.push('use either --set or --dry-run');
  if (o.out && o.set) o.errors.push('--out writes a file only; it cannot be combined with --set');
  if (o.detect && (o.set || o.out)) o.errors.push('--detect only saves the screen size; run it on its own');
  return o;
}

/** True when the environment forces a dry run (PCD_NO_WALLPAPER set to anything but "" or "0"). */
export function noWallpaper(env) {
  const v = env && env.PCD_NO_WALLPAPER;
  return v !== undefined && v !== '' && v !== '0';
}

/** Local ISO time with offset, for the log. */
export function isoLocal(d) {
  const p = (n) => String(Math.abs(n)).padStart(2, '0');
  const off = -d.getTimezoneOffset();
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}${off >= 0 ? '+' : '-'}${p(Math.trunc(off / 60))}:${p(off % 60)}`;
}

/** Package or repo locations of tokens.json, anchors.json and the glyph atlas. */
export function lookFiles(stillDir, layout) {
  if (layout === 'package') return { tokens: path.join(stillDir, 'tokens.json'), anchors: path.join(stillDir, 'anchors.json'), atlas: path.join(stillDir, 'atlas') };
  const repo = path.resolve(stillDir, '..', '..');
  return { tokens: path.join(repo, 'design', 'tokens.json'), anchors: path.join(repo, 'dist', 'still', 'anchors.json'), atlas: path.join(repo, 'design', 'atlas') };
}

let atlasCache = null;
function atlasAt(dir) {
  if (!atlasCache || atlasCache.dir !== dir) atlasCache = loadAtlas(dir);
  return atlasCache;
}

/**
 * The forecast for the column's weather block, the scene's effects and the real sun times (null when off, without a
 * city or without the module). As on the wallpaper and the new tab, only the weather and the sun times ask for it:
 * with both off nothing is requested, whatever weatherFx says (the effects need the weather on).
 */
async function getWeather({ config, PCD, files, fetchFn, nowMs, canWrite }) {
  if (!(config.sunTimes || config.weather)) return { state: null, note: 'weather off' };
  if (!config.city) return { state: null, note: 'no city' };
  if (!PCD.weather || typeof PCD.weather.createClient !== 'function') return { state: null, note: 'weather module missing' };
  if (!fetchFn) return { state: null, note: 'fetch unavailable' };
  const client = PCD.weather.createClient({
    storage: canWrite ? envLib.fileStorage(files.cache) : null,
    fetch: fetchFn,
    now: () => nowMs,
    online: () => true,
    ttlMs: WEATHER_TTL_MS,
    timeoutMs: WEATHER_TIMEOUT_MS,
  });
  try {
    const st = await client.get({ city: config.city, units: config.units });
    return { state: st, note: `weather ${st.status}` };
  } catch (e) {
    return { state: null, note: `weather failed (${String(e && e.message || e).slice(0, 80)})` };
  }
}

/** The city as the column shows it: the place's name (else the setting), lower case, in atlas glyphs. */
function cityLabel(state, config) {
  const name = state && state.place && state.place.name ? state.place.name : config.city;
  return atlasText(String(name || '').toLowerCase().replace(/\s+/g, ' ').trim());
}

/**
 * Run once. argv as on the command line; deps (all optional, for tests): { env, now() -> Date, stillDir,
 * engine: { vendorDir, sharedDir, hookFile, engineFile }, tokensFile, anchorsFile, atlasDir, tasklist, runPowerShell,
 * runSetter, fetch, stdout, stderr, onPicture(info) }. Resolves to the exit code: 0 done (or skipped), 1 failed,
 * 2 usage error.
 */
export async function main(argv = process.argv.slice(2), deps = {}) {
  const env = deps.env || process.env;
  const out = deps.stdout || ((s) => process.stdout.write(s + '\n'));
  const err = deps.stderr || ((s) => process.stderr.write(s + '\n'));
  const args = parseArgs(argv);
  const secrets = [];
  const say = (s) => { if (!args.quiet) out(envLib.redact(s, secrets)); };
  if (args.help) {
    out(USAGE);
    return 0;
  }
  if (args.errors.length) {
    err(args.errors.map((e) => `pcd-still: ${e}`).join('\n'));
    err(USAGE);
    return 2;
  }
  const stillDir = path.resolve(deps.stillDir || HERE);
  const explicitHome = args.home || env.PCD_STILL_HOME || null;
  const home = path.resolve(explicitHome || stillDir);
  const stillFile = path.join(home, envLib.STILL_JSON);
  const files = envLib.outFiles(home);
  const dryRun = args.dryRun || noWallpaper(env);
  const mode = args.out ? 'out' : args.set ? (dryRun ? 'dry-run' : 'set') : dryRun ? 'dry-run' : 'render';
  const started = Date.now();
  const nowDate = args.at || (deps.now ? deps.now() : new Date());
  const homeOk = explicitHome !== null || fs.existsSync(stillFile);
  let config = null;
  let logReady = false;
  const log = (line) => {
    if (!logReady) return;
    try {
      envLib.appendLog(files.log, `${isoLocal(new Date())} ${line}`, { secrets });
    } catch { /* the log is best effort */ }
  };

  try {
    if (args.detect) {
      if (!homeOk) {
        err(`pcd-still: no still.json in ${home}; pass --home <folder> to choose where to save the screen size`);
        return 2;
      }
      // a still.json that cannot be read stops here, before the screen query, and is never overwritten
      for (const p of envLib.readStillStrict(stillFile).problems) say(`still.json: ${p}`);
      const d = envLib.detectDisplay(deps);
      const saved = envLib.updateStill(stillFile, { width: d.width, height: d.height, scale: d.scale });
      say(`detected ${d.width}x${d.height} at scale ${d.scale} (${d.dpi || 'unknown'} dpi; ${d.adapters.map((a) => a.name || '?').join(', ')})`);
      say(`saved to ${stillFile}: ${saved.width}x${saved.height} scale ${saved.scale}`);
      return 0;
    }
    if (mode !== 'out' && !homeOk) {
      err(`pcd-still: no still.json in ${home} (this looks like the source folder); pass --home <folder> or --out <file>`);
      return 2;
    }
    const read = envLib.readStill(stillFile);
    config = read.config;
    if (config.city) secrets.push(config.city);
    logReady = mode !== 'out';
    // every problem reaches still.log too: the scheduled task's output is seen by nobody
    for (const p of read.problems) {
      say(`still.json: ${p}`);
      log(`still.json: ${p}`);
    }
    if (args.theme) config.theme = args.theme;
    if (args.scale) config.scale = args.scale;
    const side = args.side || config.side || DEFAULT_SIDE;
    let width = args.size ? args.size.width : config.width;
    let height = args.size ? args.size.height : config.height;
    if (!width || !height) {
      const d = envLib.detectDisplay(deps);
      width = d.width;
      height = d.height;
      if (!args.scale) config.scale = d.scale;
      say(`screen ${width}x${height} at scale ${d.scale} (detected; run --detect once to save it)`);
    }

    // Lively: a running player covers the desktop picture, so the task has nothing to do.
    if (mode === 'set' || mode === 'dry-run') {
      let lively = null;
      try {
        lively = envLib.livelyStatus(deps);
      } catch (e) {
        say(`lively check failed (${e.message}); continuing`);
      }
      if (lively && lively.running) {
        if (mode === 'set') {
          say(`skip: a Lively wallpaper is running (${lively.players.join(', ')})`);
          log(`skip lively ${lively.players.join(',')}`);
          return 0;
        }
        say(`dry run: a Lively wallpaper is running (${lively.players.join(', ')}); --set would skip`);
      }
    }

    // Engine, tokens, anchors, atlas.
    const where = deps.engine ? { ...deps.engine, layout: deps.engine.layout || 'custom' } : locateEngine(stillDir);
    const eng = loadEngine(where);
    const { PC, PCD } = eng;
    const look = lookFiles(stillDir, where.layout);
    // the pages' PCD.TOKENS (generated from the same tokens.json), so every shared module paints the pages' colours
    if (!PCD.TOKENS) {
      const pageTok = envLib.pageTokens(deps.tokensFile || look.tokens);
      if (pageTok) PCD.TOKENS = pageTok;
    }
    if (!PCD.ANCHORS) {
      const anchors = envLib.readAnchors(deps.anchorsFile || look.anchors);
      if (anchors) PCD.ANCHORS = anchors.themes && typeof anchors.themes === 'object' ? anchors.themes : anchors;
    }
    const atlas = atlasAt(path.resolve(deps.atlasDir || look.atlas));

    // Theme, time and light: the picture shows the middle of its 15-minute slot (now + 7.5 min); the date is now's.
    const t = timeParts(nowDate);
    const pick = chooseTheme(eng, { theme: config.theme, year: t.year, month: t.month, day: t.day });
    const theme = PC.themeById(pick.id);
    const seed = daySeed(eng, pick.id, t.year, t.month, t.day);
    const canWrite = mode !== 'out';
    const weather = await getWeather({ config, PCD, files, fetchFn: deps.fetch || globalThis.fetch, nowMs: nowDate.getTime(), canWrite });
    const data = weather.state && weather.state.data ? weather.state.data : null;
    const place = weather.state && weather.state.place;
    for (const v of [place && place.latitude, place && place.longitude, data && data.latitude, data && data.longitude]) if (typeof v === 'number') secrets.push(String(v));
    if (place && place.name) secrets.push(String(place.name));
    let hourFloat = t.hourFloat;
    let phase = null;
    let sunShown = null;
    let curve = null;
    if (PCD.sun && typeof PCD.sun.resolve === 'function') {
      const sun = config.sunTimes && data ? PCD.sun.today(data, nowDate) : null;
      const r = PCD.sun.resolve(t.light, { id: pick.id, sun, follow: config.sunTimes });
      hourFloat = r.hourFloat >= 0 && r.hourFloat < 24 ? r.hourFloat : t.hourFloat;
      phase = r.phase;
      // the strip's end labels show only while the real sun times set the picture's light
      if (r.source === 'sun' && r.sun && typeof r.sun.rise === 'number' && typeof r.sun.set === 'number') sunShown = { rise: r.sun.rise, set: r.sun.set };
      curve = typeof PCD.sun.curve === 'function' ? PCD.sun.curve(r.anchor, r.source === 'sun' ? r.sun : null) : null;
    }

    // Weather effects (only while the weather is on) with particles frozen after the warm-up, when pcd-fx.js is there.
    let before = null;
    if (config.weather && config.weatherFx && data && PCD.fx && typeof PCD.fx.create === 'function') {
      const fx = PCD.fx.create(seed);
      const indoor = typeof PCD.fx.isIndoor === 'function' ? PCD.fx.isIndoor(pick.id) : INDOOR_THEMES.includes(pick.id);
      // reducedMotion: a still never shows a lightning flash.
      const input = typeof PCD.fx.input === 'function'
        ? PCD.fx.input(data, { indoor, reducedMotion: true })
        : { kind: data.kind, precip: data.precip, wind: data.windKmh, isDay: data.isDay, indoor, flash: false };
      fx.set(input);
      for (let i = 0; i < 90; i++) fx.step(1 / 30);
      before = (cv, ctx) => fx.apply(cv, ctx);
    }

    // Geometry, scene (no clock in it: the column carries the date), picture.
    const fetchedAt = weather.state && typeof weather.state.fetchedAt === 'number' ? weather.state.fetchedAt : null;
    const view = {
      width, height, scale: config.scale, side, taskbar: config.taskbar, date: columnDate(nowDate, t.light),
      clock24: config.clock24, day: { id: pick.id, name: theme.name, tag: pick.tag, phase },
      weather: config.weather && data ? { data, units: weather.state.units || config.units, city: cityLabel(weather.state, config), ageMs: fetchedAt === null ? 0 : Math.max(0, nowDate.getTime() - fetchedAt) } : null,
      sun: sunShown, curve, PC, PCD, atlas,
    };
    const plan = planPicture(view);
    const render = { id: pick.id, seed, hourFloat, year: t.year, month: t.month, day: t.day, hookMode: plan.sceneClock, before };
    const scene = renderScene(eng, render);
    const pic = compose(view, plan, scene);
    const png = encodeImage(pic.img);
    if (deps.onPicture) deps.onPicture({ plan, scene, info: pic.info, png, render, view });
    const sha = envLib.sha256(png);
    const summary = `${pick.id} (${pick.tag}) ${width}x${height} k=${plan.k} side ${side}, type ${plan.step} px, ${phase || 'no phase'}, ${weather.note}`;

    if (mode === 'out') {
      envLib.writeBytesAtomic(path.resolve(args.out), png);
      say(`wrote ${path.resolve(args.out)}: ${summary}, ${Math.round(png.length / 1024)} KB in ${((Date.now() - started) / 1000).toFixed(2)} s`);
      return 0;
    }

    // out/: A/B pictures, skip when nothing changed.
    const removed = envLib.cleanupOut(files.dir);
    if (removed.length) say(`cleaned out/: ${removed.join(', ')}`);
    const state = envLib.readState(files.state);
    if (envLib.isSameAsSet(state, sha, files)) {
      say(`unchanged: the picture equals ${path.basename(files[state.slot])}, which is already set (${summary})`);
      log(`same ${pick.id} ${width}x${height} k${plan.k}`);
      return 0;
    }
    const slot = envLib.nextSlot(state);
    const target = files[slot];
    envLib.writeBytesAtomic(target, png);
    const next = { ...state, renderedAt: isoLocal(new Date()), last: { at: isoLocal(nowDate), theme: pick.id, tag: pick.tag, width, height, k: plan.k, side, slot, bytes: png.length, sha256: sha, phase } };
    let setNote = 'not set';
    let code = 0;
    if (mode === 'set') {
      const r = (deps.runSetter || runSetter)(target, { style: DEFAULT_STYLE, env });
      if (r.ok) {
        next.slot = slot;
        next.sha256 = sha;
        next.setAt = isoLocal(new Date());
        setNote = 'set';
      } else {
        setNote = `set failed (exit ${r.status}${r.error ? ', ' + r.error.message : ''}): ${(r.stdout.trim() || r.stderr).split('\n').pop()}`;
        code = 1;
      }
    } else if (mode === 'dry-run') {
      const a = setterArgs(target, { style: DEFAULT_STYLE });
      setNote = `dry run: --set would run powershell.exe ${a.slice(0, -1).join(' ')} <script, ${a[a.length - 1].length} base64 chars> for ${target}`;
    }
    envLib.writeJsonAtomic(files.state, next);
    say(`wrote ${target}: ${summary}, ${Math.round(png.length / 1024)} KB in ${((Date.now() - started) / 1000).toFixed(2)} s`);
    say(setNote);
    log(`${mode} ${pick.id} ${width}x${height} k${plan.k} ${side} ${slot} ${Math.round(png.length / 1024)}KB ${((Date.now() - started) / 1000).toFixed(2)}s ${setNote.split(':')[0]}`);
    return code;
  } catch (e) {
    err(envLib.redact(`pcd-still: ${e && e.message ? e.message : e}`, secrets));
    log(`error ${String(e && e.message || e).slice(0, 200)}`);
    return 1;
  }
}

/**
 * The moment the column describes: the middle of the picture's 15-minute slot (light: the greeting, the strip's now
 * marker), unless that is already tomorrow (a picture made at 23:55 still says today's date and greeting).
 */
export function columnDate(now, light) {
  if (light.getFullYear() === now.getFullYear() && light.getMonth() === now.getMonth() && light.getDate() === now.getDate()) return light;
  return now;
}

function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    const a = fs.realpathSync(path.resolve(process.argv[1]));
    const b = fs.realpathSync(fileURLToPath(import.meta.url));
    return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
  } catch {
    return pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
  }
}

if (isMainModule()) {
  main().then((code) => { process.exitCode = code; }, (e) => { process.stderr.write(`pcd-still: ${e && e.stack || e}\n`); process.exitCode = 1; });
}

export { hex };
