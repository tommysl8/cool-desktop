// A stand-in for the real clock's GET /api/status. Node built-ins only.
// Binds 127.0.0.1 on a random port (never 5173 or 5174, which a local dev server may use). Answers like
// the firmware (core/api.cpp, core/http.cpp): the same body bytes as the fixtures, the same head in the same order
// (Content-Type: application/json, Content-Length, Cache-Control: no-store,
// X-Content-Type-Options: nosniff, Connection: close), no Access-Control-* header, OPTIONS -> 405
// with "Allow: GET, HEAD", other /api/ paths such as "/api/status/" -> 404, other paths -> 303 to "/"
// (the mock has no app, so "/" itself is 404), and 403 unknown_host for a Host it does not answer to.
// It answers to Host pixelclock.local (a browser with --host-resolver-rules "MAP pixelclock.local
// 127.0.0.1:<port>") and to 127.0.0.1:<port> / localhost:<port> (Node tests, like the pretend clock).
//
//   node tools/mock-clock.mjs [--scenario normal] [--port 0]
//
// Scenarios: the fixtures in tests/fixtures/status/ (normal, ringing, snoozed, testing, first-boot,
// no-time, safe-mode) and the failures garbage (the normal body cut in half, like pretend's badjson
// fault), error-500 (the firmware's 500 "internal"), slow (the normal answer after slowMs, 5 s by
// default) and unreachable (the connection is dropped without a reply, like pretend's drop fault).
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const FIXTURE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'tests', 'fixtures', 'status');
export const FIXTURES = ['normal', 'ringing', 'snoozed', 'testing', 'first-boot', 'no-time', 'safe-mode'];
export const FAILURES = ['garbage', 'error-500', 'slow', 'unreachable'];
export const SCENARIOS = [...FIXTURES, ...FAILURES];
export const STATUS_PATH = '/api/status';
export const RESERVED_PORTS = [5173, 5174];

const ERRORS = {
  internal: [500, 'internal', "The reply didn't fit in the clock's memory."],
  notFound: [404, 'not_found', "There's nothing at this address."],
  method: [405, 'method', "This address doesn't take that method."],
  unknownHost: [403, 'unknown_host', 'The clock only answers at its own addresses.'],
};

/** The fixtures' bodies: { name: text } (the file without its final LF). */
export function loadFixtures(dir = FIXTURE_DIR) {
  const out = {};
  for (const name of FIXTURES) out[name] = fs.readFileSync(path.join(dir, name + '.json'), 'utf8').replace(/\r?\n$/, '');
  return out;
}

/** The --host-resolver-rules entry that sends pixelclock.local to this mock. */
export function resolverRule(port) {
  return `MAP pixelclock.local 127.0.0.1:${port}`;
}

function errorBody(code, message, extra) {
  const o = { error: { code, message } };
  if (extra) Object.assign(o, extra);
  return JSON.stringify(o);
}

/**
 * Start the mock. Options: scenario ('normal'), port (0 = random), slowMs (5000), cors (false; true adds
 * "Access-Control-Allow-Origin: *", which the real clock never sends: only for transport probes),
 * fixtures ({ name: text } to override), log (fn(line)).
 * Resolves { url, origin, port, scenario, setScenario(name), requests, clearRequests(), close() };
 * requests: { time, method, path, host, origin, referer, headers (lower-case names), answered }.
 */
export function startMockClock({ scenario = 'normal', port = 0, slowMs = 5000, cors = false, fixtures, log = null } = {}) {
  if (RESERVED_PORTS.includes(Number(port))) return Promise.reject(new Error(`mock-clock: port ${port} is reserved (a local dev server may use it); use another`));
  const bodies = { ...loadFixtures(), ...(fixtures || {}) };
  const state = { scenario: check(scenario) };
  const requests = [];
  const sockets = new Set();
  const timers = new Set();

  function check(name) {
    if (!SCENARIOS.includes(name) && !(fixtures && name in fixtures)) throw new Error(`mock-clock: unknown scenario ${name}`);
    return name;
  }

  function send(req, res, status, body, extra = []) {
    const head = [
      ...(body ? [['Content-Type', 'application/json']] : []),
      ['Content-Length', String(Buffer.byteLength(body))],
      ['Cache-Control', 'no-store'],
      ['X-Content-Type-Options', 'nosniff'],
      ...extra,
      ...(cors ? [['Access-Control-Allow-Origin', '*']] : []),
      ['Connection', 'close'],
    ];
    res.writeHead(status, head.flat());
    res.end(req.method === 'HEAD' ? undefined : body);
  }

  const server = http.createServer((req, res) => {
    res.sendDate = false;
    const entry = {
      time: Date.now(),
      method: req.method,
      path: req.url,
      host: req.headers.host || '',
      origin: req.headers.origin || null,
      referer: req.headers.referer || null,
      headers: Object.keys(req.headers).sort(),
      answered: null,
    };
    requests.push(entry);
    const actual = server.address().port;
    const host = String(req.headers.host || '').toLowerCase();
    const hosts = ['pixelclock.local', 'pixelclock.local:80', 'pixelclock', `127.0.0.1:${actual}`, `localhost:${actual}`];
    const reply = (status, body, extra) => {
      entry.answered = status;
      if (log) log(`${req.method} ${req.url} ${status} (${state.scenario})`);
      send(req, res, status, body, extra);
    };
    if (!hosts.includes(host)) {
      const [s, c, m] = ERRORS.unknownHost;
      return reply(s, errorBody(c, m, { use: [`http://127.0.0.1:${actual}/`, `http://localhost:${actual}/`] }));
    }
    const pathname = String(req.url || '').split('?')[0];
    if (pathname !== STATUS_PATH && (pathname.startsWith('/api/') || pathname === '/')) {
      const [s, c, m] = ERRORS.notFound;  // the clock serves its app at "/"; the mock has none
      return reply(s, errorBody(c, m));
    }
    if (pathname !== STATUS_PATH) return reply(303, '', [['Location', '/']]);  // like the clock: other paths go to its app
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      const [s, c, m] = ERRORS.method;
      return reply(s, errorBody(c, m), [['Allow', 'GET, HEAD']]);
    }
    const sc = state.scenario;
    if (sc === 'unreachable') {
      entry.answered = 'dropped';
      if (log) log(`${req.method} ${req.url} dropped (${sc})`);
      return req.socket.destroy();
    }
    if (sc === 'error-500') {
      const [s, c, m] = ERRORS.internal;
      return reply(s, errorBody(c, m));
    }
    if (sc === 'garbage') {
      const body = bodies.normal;
      return reply(200, body.slice(0, Math.max(1, Math.floor(body.length / 2))));
    }
    if (sc === 'slow') {
      const t = setTimeout(() => {
        timers.delete(t);
        if (!res.destroyed && !res.writableEnded) reply(200, bodies.normal);
      }, slowMs);
      timers.add(t);
      res.on('close', () => { clearTimeout(t); timers.delete(t); });
      return undefined;
    }
    return reply(200, bodies[sc]);
  });
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const actual = server.address().port;
      if (RESERVED_PORTS.includes(actual)) {
        server.close();
        return reject(new Error(`mock-clock: got port ${actual}, which is reserved; try again`));
      }
      const origin = `http://127.0.0.1:${actual}`;
      resolve({
        url: origin + STATUS_PATH,
        origin,
        port: actual,
        get scenario() { return state.scenario; },
        setScenario(name) { state.scenario = check(name); },
        requests,
        clearRequests() { requests.length = 0; },
        close() {
          return new Promise((done) => {
            for (const t of timers) clearTimeout(t);
            for (const s of sockets) s.destroy();
            server.close(() => done());
          });
        },
      });
    });
  });
}

function parseArgs(argv) {
  const o = { scenario: 'normal', port: 0 };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--scenario') o.scenario = argv[++i];
    else if (argv[i] === '--port') o.port = Number(argv[++i]);
    else throw new Error(`mock-clock: unknown argument ${argv[i]} (use --scenario NAME, --port N)`);
  }
  return o;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const o = parseArgs(process.argv.slice(2));
    const m = await startMockClock({ ...o, log: (line) => console.log(line) });
    console.log(`mock clock: ${m.url} (scenario ${m.scenario}); browsers: --host-resolver-rules="${resolverRule(m.port)}"`);
    console.log(`scenarios: ${SCENARIOS.join(', ')}. Ctrl+C stops it.`);
  } catch (e) {
    console.error(e.message);
    process.exitCode = 1;
  }
}
