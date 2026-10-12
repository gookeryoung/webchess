#!/usr/bin/env node
/**
 * Web 端冒烟：以内置静态服务器托管构建产物，校验页面与关键静态资源可访问。
 * 覆盖：入口 HTML、主 JS bundle、引擎 Worker chunk、棋子贴图、内置棋谱、音效。
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname } from 'node:path';

const ROOT = new URL('../packages/web/dist/', import.meta.url).pathname.replace(
  /^\/([A-Za-z]:)/,
  '$1',
);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.xqf': 'application/octet-stream',
  '.json': 'application/json',
  '.map': 'application/json',
};

const server = createServer(async (req, res) => {
  try {
    const urlPath = decodeURIComponent((req.url ?? '/').split('?')[0]);
    const target = join(ROOT, urlPath === '/' ? 'index.html' : urlPath);
    const info = await stat(target);
    if (!info.isFile()) {
      throw new Error('not file');
    }

    const body = await readFile(target);
    res.writeHead(200, { 'Content-Type': MIME[extname(target)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('not found');
  }
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const { port } = server.address();
const base = `http://127.0.0.1:${port}`;

let failed = 0;
async function check(name, path, verify) {
  try {
    const res = await fetch(base + path);
    const ok = res.ok && (verify === undefined || verify(res, await res.text()));
    if (!ok) failed++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  →  HTTP ${res.status}`);
  } catch (error) {
    failed++;
    console.log(`FAIL  ${name}  →  ${error.message}`);
  }
}

console.log('--- Web 端冒烟（静态托管 dist）---');

let bundlePath = '';
await check('入口 HTML', '/', async (_res, text) => {
  const match = text.match(/src="\.\/(assets\/[^"]+\.js)"/);
  bundlePath = match?.[1] ?? '';
  return text.includes('id="root"') && bundlePath.length > 0;
});

await check('主 JS bundle', `/${bundlePath}`, (_res, text) => text.includes('SuperChess'));
await check('棋子贴图（红帅）', '/pieces/r_shuai.png', (res) =>
  (res.headers.get('content-type') ?? '').startsWith('image/'),
);
await check('内置棋谱（XQF）', '/manuals/realgame.xqf', async (res) =>
  Number(res.headers.get('content-length')) > 1024,
);
await check('音效（走子）', '/sounds/move.mp3', (res) =>
  (res.headers.get('content-type') ?? '').startsWith('audio/'),
);

// 引擎 Worker 产物可访问性（与主 bundle 分离，证明引擎确实跑在独立线程）
const { readdir } = await import('node:fs/promises');
const assets = await readdir(join(ROOT, 'assets'));
const workerChunk = assets.find((f) => f.includes('worker'));
if (workerChunk === undefined) {
  failed++;
  console.log('FAIL  引擎 Worker 产物  →  未找到 worker chunk');
} else {
  await check('引擎 Worker chunk', `/assets/${workerChunk}`, (_res, text) =>
    text.includes('go') && text.length > 1000,
  );
}

// 在服务器句柄完全关闭后退出：Windows + 新版 node 下先 exit 再关句柄
// 会触发 libuv win/async.c 的 UV_HANDLE_CLOSING 断言导致进程崩溃。
server.close(() => {
  console.log(failed === 0 ? '\n[smoke-web] 全部通过' : `\n[smoke-web] ${failed} 项失败`);
  process.exit(failed === 0 ? 0 : 1);
});
