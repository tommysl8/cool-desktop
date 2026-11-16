// Tiny static file server for tests and headless rendering. Binds 127.0.0.1 only, random port.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { isInside } from './fsx.mjs';

export const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.zip': 'application/zip',
};

export function contentType(file) {
  return CONTENT_TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';
}

/**
 * Serve `dir` on http://127.0.0.1:<random port>/.
 * Resolves { url, port, dir, close() }; url ends with '/'. Folders serve their index.html.
 * GET/HEAD only, no caching, nothing outside `dir` (403). A missing /favicon.ico answers
 * 204 (unless `favicon204: false`) so Chrome's automatic favicon request does not log a 404
 * error into "zero console errors" checks.
 */
export function serve(dir, { port = 0, log = null, favicon204 = true } = {}) {
  const root = path.resolve(dir);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) return Promise.reject(new Error(`serve: not a folder: ${root}`));
  const sockets = new Set();
  const server = http.createServer((req, res) => {
    const send = (code, body, type = 'text/plain; charset=utf-8') => {
      res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(body) });
      res.end(req.method === 'HEAD' ? undefined : body);
    };
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(405, 'method not allowed\n');
    let pathname;
    try {
      pathname = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname);
    } catch {
      return send(400, 'bad request\n');
    }
    if (pathname.includes('\0')) return send(400, 'bad request\n');
    let file = path.resolve(root, '.' + pathname);
    if (!isInside(root, file)) return send(403, 'forbidden\n');
    try {
      let st = fs.statSync(file);
      if (st.isDirectory()) {
        file = path.join(file, 'index.html');
        st = fs.statSync(file);
      }
      if (!st.isFile()) return send(404, 'not found\n');
      res.writeHead(200, { 'Content-Type': contentType(file), 'Content-Length': st.size, 'Cache-Control': 'no-store' });
      if (req.method === 'HEAD') return res.end();
      fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
      if (log) log(`${req.method} ${pathname} 200`);
    } catch {
      if (favicon204 && pathname === '/favicon.ico') {
        res.writeHead(204, { 'Cache-Control': 'no-store' });
        return res.end();
      }
      if (log) log(`${req.method} ${pathname} 404`);
      send(404, 'not found\n');
    }
  });
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const actual = server.address().port;
      resolve({
        url: `http://127.0.0.1:${actual}/`,
        port: actual,
        dir: root,
        server,
        close() {
          return new Promise((done) => {
            for (const s of sockets) s.destroy();
            server.close(() => done());
          });
        },
      });
    });
  });
}
