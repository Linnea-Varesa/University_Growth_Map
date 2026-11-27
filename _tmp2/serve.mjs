import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = 'D:/projects/Qoder_CN/test/college-growth-atlas/web';
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json' };

http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/mock/chat/completions') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'access-control-allow-origin': '*' });
    const parts = ['根据你记录的数据，', '「算法工程师」方向已有 200+ 算法题基础，', '但体验卡「后端接口上线」停在 2/4。', '建议本周先完成第 3 步部署压测，', '并把结果写成量化证据。'];
    let i = 0;
    const t = setInterval(() => {
      if (i < parts.length) {
        res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: parts[i] } }] }) + '\n\n');
        i++;
      } else {
        res.write('data: [DONE]\n\n');
        clearInterval(t);
        res.end();
      }
    }, 120);
    req.on('close', () => clearInterval(t));
    return;
  }
  let p = path.join(ROOT, u.pathname === '/' ? 'index.html' : u.pathname).replace(/\\/g, '/');
  if (!p.startsWith(ROOT) || !fs.existsSync(p) || !fs.statSync(p).isFile()) {
    res.writeHead(404); res.end('not found'); return;
  }
  res.writeHead(200, { 'content-type': MIME[path.extname(p)] || 'application/octet-stream' });
  fs.createReadStream(p).pipe(res);
}).listen(4321, '127.0.0.1', () => console.log('test server on 4321'));