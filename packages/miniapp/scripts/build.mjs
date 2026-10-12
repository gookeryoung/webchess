// 小程序构建脚本：把 TS 源（内核复用 + 小程序适配层）打包为微信小程序
// 可直接 require 的 CJS 单文件。产物目录已加入 .gitignore，每次构建重新生成。
import { build } from 'esbuild';
import { mkdirSync, copyFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const out = (...path) => join(root, 'miniprogram', ...path);
const webPublic = join(root, '..', '..', 'packages', 'web', 'public');

const common = {
  bundle: true,
  format: 'cjs',
  target: 'es2018',
  platform: 'neutral',
  logLevel: 'info',
  legalComments: 'none',
};

mkdirSync(out('lib'), { recursive: true });
mkdirSync(out('workers/engine'), { recursive: true });

// 主线程包：AppController（Web 版复用）+ 内核 + 小程序适配层与页面控制器。
await build({
  ...common,
  entryPoints: [join(root, 'src/entries/app.ts')],
  outfile: out('lib', 'app.js'),
});

// 引擎 Worker 包：engine + core 内联为单文件（微信 Worker 不能 require 包外模块）。
await build({
  ...common,
  entryPoints: [join(root, 'src/entries/engineWorker.ts')],
  outfile: out('workers', 'engine', 'index.js'),
});

// 复制 Web 版静态资源：棋子贴图、内置棋谱与受支持的音效（ogg 不复制——小程序不支持）。
const piecesDir = out('images', 'pieces');
mkdirSync(piecesDir, { recursive: true });
for (const file of readdirSync(join(webPublic, 'pieces'))) {
  copyFileSync(join(webPublic, 'pieces', file), join(piecesDir, file));
}

const manualsDir = out('manuals');
mkdirSync(manualsDir, { recursive: true });
for (const file of readdirSync(join(webPublic, 'manuals'))) {
  copyFileSync(join(webPublic, 'manuals', file), join(manualsDir, file));
}

const soundsDir = out('sounds');
mkdirSync(soundsDir, { recursive: true });
for (const file of readdirSync(join(webPublic, 'sounds'))) {
  if (file.endsWith('.ogg')) {
    continue; // checkmate.ogg：小程序不支持 ogg，音效层已显式降级为 check.mp3。
  }

  copyFileSync(join(webPublic, 'sounds', file), join(soundsDir, file));
}

console.log('[miniapp] 构建完成：packages/miniapp/miniprogram（用微信开发者工具打开该目录）');
