// The clock status client in a real browser (headless Chrome 157 through tools/lib/chrome.mjs, temp profile):
// a throwaway MV3 extension with host_permissions ["http://pixelclock.local/*"] runs src/newtab/js/ntp-status.js
// while pixelclock.local is mapped to tools/mock-clock.mjs. It proves the transport the new tab relies on
// (CORS-exempt read of a reply without CORS headers, no Origin, nothing but GET /api/status), the line for every
// scenario, the 2.5 s abort, quiet failures, the session cache, and why the Lively page cannot do the same
// (an https secure page is stopped by Local Network Access before anything is sent). A second run treats the
// mock as a LAN device (--ip-address-space-overrides), as the real clock will be: the extension page is unaffected.
import assert from 'node:assert/strict';
import fs from 'node:fs';
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
const imp = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href);
const { startMockClock, loadFixtures, FIXTURES } = await imp('tools/mock-clock.mjs');
const chrome = await imp('tools/lib/chrome.mjs');
const RAW = loadFixtures();
const NO_BROWSER = chrome.findBrowser() ? false : 'no Chrome or Edge installed';
const HTTPS_ORIGIN = 'https://0123456789abcdef.localhost';
// The request headers Chrome itself adds; anything else would be a custom header.
const CHROME_HEADERS = ['accept', 'accept-encoding', 'accept-language', 'cache-control', 'connection', 'host', 'pragma', 'user-agent'];

function makeExtension(dir, hostPermission) {
  fs.mkdirSync(dir, { recursive: true });
  const manifest = { manifest_version: 3, name: 'PCD status test', version: '1.0', permissions: ['storage'] };
  if (hostPermission) manifest.host_permissions = ['http://pixelclock.local/*'];
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  fs.writeFileSync(path.join(dir, 'test.html'), '<!doctype html><meta charset="utf-8"><title>t</title><script src="ntp-status.js"></script>\n');
  fs.copyFileSync(path.join(ROOT, 'src', 'newtab', 'js', 'ntp-status.js'), path.join(dir, 'ntp-status.js'));
}

// In the page: a fresh session cache, one client run until its first answer or failure.
const RUN_CLIENT = `(async () => {
  await chrome.storage.session.clear();
  const changes = [];
  let sentAt = 0;
  let abortMs = null;
  const watch = (url, init) => {
    sentAt = performance.now();
    init.signal.addEventListener('abort', () => { abortMs = Math.round(performance.now() - sentAt); });
    return fetch(url, init);
  };
  const c = PCD.status.createClient({ fetch: watch, firstDelayMs: 0, onChange: (s) => changes.push(s), cache: PCD.status.sessionCache(chrome.storage.session) });
  const t0 = performance.now();
  c.start();
  while (performance.now() - t0 < 6000 && c.state().ok + c.state().failures === 0) await new Promise((r) => setTimeout(r, 10));
  c.stop();
  const cached = (await chrome.storage.session.get('clockStatus')).clockStatus || null;
  return { abortMs, state: c.state(), status: changes[0] || null, line12: PCD.status.describe(changes[0] || null, { clock24: false }).text, cached };
})()`;

const FETCH = `(async () => {
  try {
    const r = await fetch('http://pixelclock.local/api/status', { method: 'GET', cache: 'no-store', credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer' });
    return { ok: true, status: r.status, type: r.type, body: await r.text() };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
})()`;

test('browser: the new tab reads the clock through host_permissions; nothing else gets through', { skip: NO_BROWSER, timeout: 120000 }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pcd-status-ext-'));
  const mock = await startMockClock();
  let browser;
  try {
    makeExtension(path.join(tmp, 'with'), true);
    makeExtension(path.join(tmp, 'without'), false);
    browser = await chrome.launch({ extensionDebugging: true, clock: mock.port });
    const id = await browser.loadUnpacked(path.join(tmp, 'with'));
    const idNone = await browser.loadUnpacked(path.join(tmp, 'without'));
    const page = await browser.newPage(`chrome-extension://${id}/test.html`);

    // Every scenario: the real client, the line, the cache; the request is a bare GET.
    for (const name of FIXTURES) {
      mock.setScenario(name);
      mock.clearRequests();
      const r = await page.evaluate(RUN_CLIENT);
      const want = S.parse(RAW[name]).status;
      assert.equal(r.state.ok, 1, `${name}: ${r.state.lastError}`);
      assert.deepEqual(r.status, want, name);
      assert.equal(r.line12, S.describe(want, { clock24: false }).text, name);
      assert.deepEqual(r.cached.status, want, `${name}: cached normalized`);
      assert.deepEqual(mock.requests.map((q) => [q.method, q.path, q.host, q.origin, q.referer]), [['GET', '/api/status', 'pixelclock.local', null, null]], name);
      for (const h of mock.requests[0].headers) assert.ok(CHROME_HEADERS.includes(h), `${name}: unexpected request header ${h}`);
    }

    // Slow: aborted by the client at 2.5 s (by 2.6 s), silently.
    mock.setScenario('slow');
    const before = page.errors.length;
    const slow = await page.evaluate(RUN_CLIENT);
    assert.equal(slow.state.lastError, 'timeout');
    assert.ok(slow.abortMs >= 2450 && slow.abortMs <= 2600, `aborted after ${slow.abortMs} ms`);
    assert.equal(slow.status, null);
    assert.equal(page.errors.length, before, 'an abort logs nothing');

    // Garbage, 500, dropped: failures, never shown; only network-level log lines, never an exception.
    for (const name of ['garbage', 'error-500', 'unreachable']) {
      mock.setScenario(name);
      const r = await page.evaluate(RUN_CLIENT);
      assert.equal(r.state.failures, 1, name);
      assert.equal(r.status, null, name);
    }
    const ours = page.errors.filter((e) => !(e.type === 'log.network' && /pixelclock\.local\/api\/status/.test(e.text)));
    assert.deepEqual(ours, [], 'no errors but Chrome\'s own network lines');

    // Without host_permissions the same request is refused by CORS: the manifest needs it.
    mock.setScenario('normal');
    const pageNone = await browser.newPage(`chrome-extension://${idNone}/test.html`);
    const none = await pageNone.evaluate(FETCH);
    assert.equal(none.ok, false);
    assert.ok(pageNone.logs.some((l) => /blocked by CORS policy: No 'Access-Control-Allow-Origin'/.test(l.text)), 'CORS refusal logged');

    // With it, the reply is readable as a same-origin ("basic") answer.
    const direct = await page.evaluate(FETCH);
    assert.deepEqual([direct.ok, direct.status, direct.type, direct.body], [true, 200, 'basic', RAW.normal]);

    // A secure https page like Lively's WebView2 virtual host: stopped before anything is sent.
    const https = await browser.newPage();
    await https.send('Fetch.enable', { patterns: [{ urlPattern: HTTPS_ORIGIN + '/*', requestStage: 'Request' }] });
    https.on('Fetch.requestPaused', (p) => {
      https.send('Fetch.fulfillRequest', { requestId: p.requestId, responseCode: 200,
        responseHeaders: [{ name: 'Content-Type', value: 'text/html' }], body: Buffer.from('<!doctype html><title>w</title>').toString('base64') }).catch(() => {});
    });
    await https.goto(HTTPS_ORIGIN + '/');
    assert.equal(await https.evaluate('window.isSecureContext'), true);
    mock.clearRequests();
    const wp = await https.evaluate(FETCH);
    assert.equal(wp.ok, false);
    assert.equal(mock.requests.length, 0, 'the request never left the browser');
    assert.ok(https.logs.some((l) => /Permission was denied for this request to access the `loopback` address space/.test(l.text)),
      'Local Network Access refused it: ' + JSON.stringify(https.logs.map((l) => l.text)));
  } finally {
    if (browser) await browser.close();
    await mock.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('browser: with the clock as a LAN device (Local Network Access in force) the new tab still reads it', { skip: NO_BROWSER, timeout: 120000 }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pcd-status-ext-'));
  const mock = await startMockClock();
  let browser;
  try {
    makeExtension(path.join(tmp, 'with'), true);
    // The real clock sits on the LAN ("local" address space); the mock is on loopback, so tell Chrome otherwise.
    browser = await chrome.launch({ extensionDebugging: true, clock: mock.port, args: [`--ip-address-space-overrides=127.0.0.1:${mock.port}=local`] });
    const id = await browser.loadUnpacked(path.join(tmp, 'with'));
    const page = await browser.newPage(`chrome-extension://${id}/test.html`);
    const r = await page.evaluate(RUN_CLIENT);
    assert.equal(r.state.ok, 1, r.state.lastError);
    assert.equal(r.line12, '⌂ pixelclock · next alarm tomorrow 7:00 am · work');

    // The override is in force: an https page asking for the `local` space is refused by Local Network Access.
    const https = await browser.newPage();
    await https.send('Fetch.enable', { patterns: [{ urlPattern: HTTPS_ORIGIN + '/*', requestStage: 'Request' }] });
    https.on('Fetch.requestPaused', (p) => {
      https.send('Fetch.fulfillRequest', { requestId: p.requestId, responseCode: 200,
        responseHeaders: [{ name: 'Content-Type', value: 'text/html' }], body: Buffer.from('<!doctype html><title>w</title>').toString('base64') }).catch(() => {});
    });
    await https.goto(HTTPS_ORIGIN + '/');
    mock.clearRequests();
    const wp = await https.evaluate(`fetch('http://pixelclock.local/api/status', { targetAddressSpace: 'local' }).then(() => 'read', (e) => String(e))`);
    assert.notEqual(wp, 'read');
    assert.equal(mock.requests.length, 0);
    assert.ok(https.logs.some((l) => /access the `local` address space/.test(l.text)), JSON.stringify(https.logs.map((l) => l.text)));
  } finally {
    if (browser) await browser.close();
    await mock.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
