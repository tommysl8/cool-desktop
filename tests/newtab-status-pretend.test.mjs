// Opt-in (PCD_PRETEND=1): the clock's own pretend server (PixelClock tools/pretend.js, the firmware's C++
// API core in WebAssembly) confirms the status fixtures and tools/mock-clock.mjs.
// pretend.js runs from a temporary COPY, never in place: it rebuilds firmware/native/build/* when that is
// stale, which would write inside the read-only clock repo. The copy keeps file times; when pretend's own
// checks find its build stale, the test skips instead of building. Port: random on 127.0.0.1 (never 5173
// or 5174); POSTs go only to this temp instance's /_sim/ controls, never /_sim/result.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

function findRoot(dir) {
  for (let d = dir; ; d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, 'tools', 'build.mjs'))) return d;
    if (path.dirname(d) === d) throw new Error('repo root not found');
  }
}
const ROOT = findRoot(import.meta.dirname);
const require = createRequire(import.meta.url);
const S = require(path.join(ROOT, 'src', 'newtab', 'js', 'ntp-status.js'));
const { startMockClock, loadFixtures } = await import(pathToFileURL(path.join(ROOT, 'tools', 'mock-clock.mjs')).href);
const RAW = loadFixtures();
const ON = process.env.PCD_PRETEND === '1';
const REPO = path.resolve(process.env.PCD_PIXELCLOCK || path.join(ROOT, '..', 'PixelClock'));
const TIME = '2026-11-15T20:00:00';

const COPY = ['tools/pretend.js', 'tools/wasm.js', 'tools/pretend', 'firmware/native/pretend.cpp', 'firmware/native/sim_clock.cpp',
  'firmware/native/sim_clock.h', 'firmware/native/build/pretend.wasm', 'firmware/native/build/web', 'firmware/src',
  'firmware/lib/PixelClock/src', 'firmware/test', 'firmware/web', 'firmware/scripts/web_bundle.py',
  'firmware/.pio/libdeps/matrixportal/ArduinoJson/src/ArduinoJson.h'];

// Reads the clock repo only (copy with times kept), then runs pretend's own staleness checks on the copy.
function copyPretend() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pcd-pretend-'));
  for (const rel of COPY) {
    const from = path.join(REPO, rel);
    if (!fs.existsSync(from)) throw Object.assign(new Error(`the clock repo has no ${rel}`), { dir });
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.cpSync(from, path.join(dir, rel), { recursive: true, preserveTimestamps: true });
  }
  const wasm = require(path.join(dir, 'tools', 'wasm.js'));
  const FW = wasm.FW;
  const sources = [path.join(FW, 'native', 'pretend.cpp'), path.join(FW, 'native', 'sim_clock.cpp'),
    ...fs.readdirSync(path.join(FW, 'src', 'core')).filter((f) => f.endsWith('.cpp')).sort().map((f) => path.join(FW, 'src', 'core', f)),
    path.join(FW, 'lib', 'PixelClock', 'src', 'schedule.cpp')];
  const wasmStale = wasm.isStale(path.join(FW, 'native', 'build', 'pretend.wasm'), sources, [path.join(FW, 'native'), ...wasm.INCLUDE_DIRS]);
  const stamp = path.join(FW, 'native', 'build', 'web', 'assets.json');
  const t = fs.existsSync(stamp) ? fs.statSync(stamp).mtimeMs : -1;
  const web = path.join(FW, 'web');
  const bundleStale = t < 0 || [path.join(FW, 'scripts', 'web_bundle.py'), ...fs.readdirSync(web).map((f) => path.join(web, f))]
    .some((f) => fs.statSync(f).mtimeMs > t);
  return { dir, stale: wasmStale || bundleStale ? `wasm stale ${wasmStale}, bundle stale ${bundleStale}` : '' };
}

async function freePort() {
  for (;;) {
    const port = await new Promise((resolve, reject) => {
      const s = net.createServer();
      s.once('error', reject);
      s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
    });
    if (port !== 5173 && port !== 5174) return port;
  }
}

// A raw HTTP/1.1 exchange: the head lines exactly as sent, and the body.
function raw(port, method, p, host) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, '127.0.0.1', () => sock.write(`${method} ${p} HTTP/1.1\r\nHost: ${host}\r\n\r\n`));
    let data = '';
    sock.setEncoding('latin1');
    sock.on('data', (d) => { data += d; });
    sock.on('end', () => {
      const i = data.indexOf('\r\n\r\n');
      resolve({ head: data.slice(0, i).split('\r\n'), body: Buffer.from(data.slice(i + 4), 'latin1').toString('utf8') });
    });
    sock.on('error', reject);
    setTimeout(() => { sock.destroy(); reject(new Error('raw: timeout')); }, 8000);
  });
}

test('pretend clock: its answers parse and read exactly like the fixtures; the mock answers like it', { skip: ON ? false : 'set PCD_PRETEND=1 (reads the PixelClock repo, runs pretend.js from a temp copy)' }, async (t) => {
  let copy;
  try {
    copy = copyPretend();
  } catch (e) {
    if (e.dir) fs.rmSync(e.dir, { recursive: true, force: true });
    t.skip(e.message);
    return;
  }
  const { dir } = copy;
  let child = null;
  let mock = null;
  try {
    if (copy.stale) {
      t.skip(`pretend's build is stale in the clock repo (${copy.stale}); not building`);
      return;
    }
    const port = await freePort();
    child = spawn(process.execPath, [path.join(dir, 'tools', 'pretend.js'), '--port', String(port), '--quiet', '--time', TIME],
      { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    const started = await new Promise((resolve) => {
      const end = setTimeout(() => resolve(false), 20000);
      const check = () => { if (/PixelClock pretend clock/.test(out)) { clearTimeout(end); resolve(true); } };
      child.stdout.on('data', check);
      child.once('exit', () => { clearTimeout(end); resolve(false); });
    });
    assert.ok(started, `pretend did not start: ${out.slice(-500)}`);
    const origin = `http://127.0.0.1:${port}`;
    const sim = async (p, body) => {
      const r = await fetch(origin + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      assert.equal(r.status, 200, `${p} ${JSON.stringify(body)}: ${await r.text()}`);
    };
    const statusText = async () => (await fetch(origin + '/api/status')).text();

    // Every scenario, read through the real client's parser and line, equals its fixture.
    const steps = [
      ['normal', null],
      ['ringing', () => sim('/_sim/alarm', { ringNow: true })],
      ['snoozed', () => sim('/_sim/alarm', { press: 'tap' })],
      ['normal', () => sim('/_sim/alarm', { press: 'hold' })],
      ['testing', () => sim('/_sim/alarm', { test: true })],
      ['first-boot', () => sim('/_sim/reset', { scenario: 'first-boot', time: TIME })],
      ['no-time', () => sim('/_sim/reset', { scenario: 'no-time', time: TIME })],
      ['safe-mode', () => sim('/_sim/reset', { scenario: 'safe-mode', time: TIME })],
    ];
    const strip = (doc) => { const d = JSON.parse(JSON.stringify(doc)); delete d.boot.id; delete d.revs; return d; };
    for (const [name, act] of steps) {
      if (act) await act();
      const text = await statusText();
      const got = S.parse(text);
      assert.equal(got.ok, true, `${name}: ${text.slice(0, 200)}`);
      assert.deepEqual(got.status, S.parse(RAW[name]).status, name);
      for (const clock24 of [false, true]) {
        assert.equal(S.describe(got.status, { clock24 }).text, S.describe(S.parse(RAW[name]).status, { clock24 }).text, `${name} ${clock24}`);
      }
      assert.deepEqual(strip(JSON.parse(text)), strip(JSON.parse(RAW[name])), `${name}: the whole document but boot.id and revs`);
    }

    // The real client against pretend (Host 127.0.0.1:<port>, like the clock's own app on the pretend clock).
    await sim('/_sim/reset', { scenario: 'normal', time: TIME });
    const changes = [];
    const client = S.createClient({ url: origin + '/api/status', firstDelayMs: 0, onChange: (s) => changes.push(s) });
    client.start();
    for (let i = 0; i < 200 && !changes.length; i++) await new Promise((r) => setTimeout(r, 10));
    client.stop();
    assert.deepEqual(changes[0], S.parse(RAW.normal).status);

    // A latency fault longer than the client's 2.5 s abort, then a dropped connection: quiet failures.
    await sim('/_sim/fault', { route: '/api/status', type: 'latency', ms: 3500 });
    const slow = S.createClient({ url: origin + '/api/status', firstDelayMs: 0 });
    const t0 = Date.now();
    slow.start();
    for (let i = 0; i < 400 && !slow.state().failures; i++) await new Promise((r) => setTimeout(r, 10));
    slow.stop();
    assert.equal(slow.state().lastError, 'timeout');
    assert.ok(Date.now() - t0 < 2700, `aborted after ${Date.now() - t0} ms`);
    await new Promise((r) => setTimeout(r, 1200));  // let pretend finish the slow reply (one connection at a time)
    await sim('/_sim/fault', { route: '/api/status', type: 'badjson' });
    assert.equal(S.parse(await statusText()).error, 'json', 'badjson = the mock\'s garbage');
    await sim('/_sim/fault', { clear: true });

    // The mock's head, OPTIONS, HEAD, 404 and 403 against the firmware's (Content-Length aside).
    await sim('/_sim/reset', { scenario: 'normal', time: TIME });
    mock = await startMockClock();
    const pairs = [['GET', '/api/status'], ['HEAD', '/api/status'], ['OPTIONS', '/api/status'], ['POST', '/api/status'],
      ['GET', '/api/status/'], ['GET', '/api/nope'], ['GET', '/nope'], ['GET', '/api/status?x=1']];
    const noLength = (lines) => lines.filter((l) => !/^Content-Length:/i.test(l));
    for (const [method, p] of pairs) {
      const a = await raw(port, method, p, `127.0.0.1:${port}`);
      const b = await raw(mock.port, method, p, `127.0.0.1:${mock.port}`);
      assert.deepEqual(noLength(b.head), noLength(a.head), `${method} ${p}: head`);
      if (a.head[0] !== 'HTTP/1.1 200 OK') assert.equal(b.body, a.body, `${method} ${p}: body`);  // status bodies differ in boot.id and revs only (checked above)
    }
    const foreignA = await raw(port, 'GET', '/api/status', 'pixelclock.local');
    const foreignB = await raw(mock.port, 'GET', '/api/status', 'elsewhere.example');
    assert.equal(foreignA.head[0], 'HTTP/1.1 403 Forbidden', 'pretend only answers at localhost/127.0.0.1');
    assert.equal(foreignB.head[0], foreignA.head[0]);
    assert.equal(JSON.parse(foreignB.body).error.code, JSON.parse(foreignA.body).error.code);
    assert.equal(JSON.parse(foreignB.body).error.message, JSON.parse(foreignA.body).error.message);
  } finally {
    if (mock) await mock.close();
    if (child && child.exitCode === null) {
      child.kill();
      await new Promise((r) => { child.once('exit', r); setTimeout(r, 3000); });
    }
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
