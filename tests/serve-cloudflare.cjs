// Serveur de test qui imite les redirections de Cloudflare Pages.
// Usage : node tests/serve-cloudflare.cjs . 8090
// Imite Cloudflare Pages : /index.html -> 308 vers /, /foo.html -> /foo
const http = require('http'), fs = require('fs'), path = require('path');
const root = process.argv[2], port = +process.argv[3];
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png' };
http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p.endsWith('/index.html')) { res.writeHead(308, { Location: p.slice(0, -10) }); return res.end(); }
  if (p.endsWith('/')) p += 'index.html';
  const f = path.join(root, p);
  fs.readFile(f, (e, d) => { if (e) { res.writeHead(404); return res.end('nf'); } res.writeHead(200, { 'Content-Type': types[path.extname(f)] || 'application/octet-stream' }); res.end(d); });
}).listen(port);
