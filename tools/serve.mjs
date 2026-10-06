// MIRRORFALL — tiny static file server for local play (ES modules need http://).
//   node tools/serve.mjs [port]   → http://localhost:8080
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.md': 'text/markdown; charset=utf-8',
};

export function startServer(port = 8080) {
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://x');
      const p = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, '');
      if (p.includes('..')) { res.writeHead(403); res.end(); return; }
      let file = join(ROOT, p || 'index.html');
      const st = await stat(file).catch(() => null);
      if (st && st.isDirectory()) file = join(file, 'index.html');
      const data = await readFile(file);
      res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
      res.end(data);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('404');
    }
  });
  return new Promise((ok) => server.listen(port, () => ok(server)));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = +(process.argv[2] || process.env.PORT || 8080);
  startServer(port).then(() => console.log(`MIRRORFALL läuft auf http://localhost:${port}`));
}
