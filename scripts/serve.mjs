// Local development only. Phone camera access on a LAN still requires HTTPS.
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const port = Number(process.env.PORT || 8080);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be between 1 and 65535.');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.md': 'text/plain', '.ico': 'image/x-icon' };
const server = http.createServer(async (req, res) => {
  try {
    if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405); res.end(); return; }
    const relative = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    if (relative.split('/').some(p => p.startsWith('.'))) { res.writeHead(403); res.end(); return; }
    let file = path.resolve(root, '.' + relative);
    if (!file.startsWith(root)) { res.writeHead(403); res.end(); return; }
    if ((await stat(file)).isDirectory()) file = path.join(file, 'index.html');
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': (types[path.extname(file)] || 'application/octet-stream') + ';charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.end(req.method === 'HEAD' ? undefined : body);
  } catch { res.writeHead(404); res.end('Not found'); }
});
server.on('error', error => { console.error(`Could not start the local server: ${error.message}. Try another PORT.`); process.exitCode = 1; });
server.listen(port, '127.0.0.1', () => console.log(`Lumen: http://127.0.0.1:${port}`));
