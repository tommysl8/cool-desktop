// Shared helpers for the still tests (tests/still-*.test.mjs, tests/atlas.test.mjs) and tools/test-still.mjs. Not a
// test file itself.
import cp from 'node:child_process';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** The repo root: the nearest folder above this file that holds tools/build.mjs. */
export const REPO = (() => {
  let dir = HERE;
  for (let i = 0; i < 4; i++) {
    if (fs.existsSync(path.join(dir, 'tools', 'build.mjs'))) return dir;
    dir = path.dirname(dir);
  }
  throw new Error('repo root not found');
})();
export const VENDOR = path.join(REPO, 'vendor', 'pixelclock');
export const SHARED = path.join(REPO, 'src', 'shared');
export const STILL = path.join(REPO, 'src', 'still');
export const WEATHER_FIXTURES = path.join(REPO, 'tests', 'fixtures', 'weather');

/** deps.engine for main(): the repo's vendor copy and shared modules. */
export function engineDeps() {
  return { vendorDir: VENDOR, sharedDir: SHARED, layout: 'repo' };
}

/** A fresh folder in os.tmpdir(); with `still` given, a still.json is written into it. */
export function tempHome(still) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pcd-still-test-'));
  if (still !== undefined) fs.writeFileSync(path.join(dir, 'still.json'), JSON.stringify(still, null, 2) + '\n');
  return dir;
}

export function rm(dir) {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

/** stdout/stderr collectors for main(). */
export function collect() {
  const out = [];
  const err = [];
  return { out, err, stdout: (s) => out.push(String(s)), stderr: (s) => err.push(String(s)), text: () => out.concat(err).join('\n') };
}

/** An environment for main() that can never set the wallpaper unless a test removes the guard on purpose. */
export function safeEnv(extra = {}) {
  const env = { ...process.env, PCD_NO_WALLPAPER: '1', ...extra };
  delete env.PCD_STILL_HOME;
  for (const [k, v] of Object.entries(extra)) if (v === undefined) delete env[k];
  return env;
}

/** A tasklist CSV line. */
export function tasklistLine(image, pid = 4242) {
  return `"${image}","${pid}","Console","1","12,345 K"`;
}

export const TASKLIST_PLAIN = [tasklistLine('System Idle Process', 0), tasklistLine('explorer.exe', 5000), tasklistLine('node.exe', 6000)].join('\r\n') + '\r\n';
export const TASKLIST_LIVELY = TASKLIST_PLAIN + [tasklistLine('Lively.exe', 7000), tasklistLine('Lively.Player.WebView2.exe', 7100)].join('\r\n') + '\r\n';

/**
 * A fake fetch for Open-Meteo with the Berlin fixtures (both units). Records every URL; any other
 * host fails the test. mode 'offline' rejects every request.
 */
export function fakeFetch({ mode = 'ok' } = {}) {
  const urls = [];
  const fixture = (name) => JSON.parse(fs.readFileSync(path.join(WEATHER_FIXTURES, name), 'utf8'));
  const fn = async (url) => {
    urls.push(String(url));
    const u = new URL(String(url));
    if (mode === 'offline') throw new TypeError('fetch failed (offline test)');
    let body;
    if (u.hostname === 'geocoding-api.open-meteo.com') body = fixture('geocode-berlin.json');
    else if (u.hostname === 'api.open-meteo.com') body = fixture(u.searchParams.get('temperature_unit') === 'fahrenheit' ? 'forecast-berlin-f.json' : 'forecast-berlin-c.json');
    else throw new Error(`unexpected host in a test: ${u.hostname}`);
    return { ok: true, status: 200, json: async () => body };
  };
  fn.urls = urls;
  return fn;
}

/**
 * Spy on node:child_process for the rest of the process (live ESM bindings updated with
 * syncBuiltinESMExports). Any PowerShell start throws and is recorded; other processes run.
 * Returns { calls, powershell(), restore() }.
 */
export function spyChildProcess() {
  const names = ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'exec', 'execSync', 'fork'];
  const orig = {};
  const calls = [];
  for (const n of names) {
    orig[n] = cp[n];
    cp[n] = function spy(...args) {
      const cmd = String(args[0]);
      calls.push({ fn: n, cmd, args: Array.isArray(args[1]) ? args[1].map(String) : [] });
      if (/powershell|pwsh/i.test(cmd)) throw new Error(`spy: PowerShell must not start (${n} ${cmd})`);
      return orig[n].apply(this, args);
    };
  }
  syncBuiltinESMExports();
  return {
    calls,
    powershell: () => calls.filter((c) => /powershell|pwsh/i.test(c.cmd)),
    restore() {
      for (const n of names) cp[n] = orig[n];
      syncBuiltinESMExports();
    },
  };
}
