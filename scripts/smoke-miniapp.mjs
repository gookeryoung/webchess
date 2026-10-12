#!/usr/bin/env node
/**
 * 小程序构建冒烟：校验 esbuild 产物与小程序工程文件完整性。
 * 阶段验收用，仅依赖 Node 运行 ESM / require，不引入测试框架。
 */
import { createRequire } from 'node:module';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const mini = (...p) => join(root, 'packages', 'miniapp', 'miniprogram', ...p);

let failed = 0;
function check(name, ok) {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
}

console.log('--- 小程序构建冒烟 ---');

// 1. 工程文件
check('app.json 可解析', (() => {
  try {
    const config = JSON.parse(readFileSync(mini('app.json'), 'utf8'));
    return Array.isArray(config.pages) && config.pages.length === 3 && config.workers === 'workers';
  } catch {
    return false;
  }
})());

for (const page of ['pages/index/index', 'pages/game/game', 'pages/practice/practice']) {
  for (const ext of ['js', 'wxml', 'json']) {
    check(`页面文件 ${page}.${ext}`, existsSync(mini(page + '.' + ext)));
  }
}

check('project.config.json 存在', existsSync(join(root, 'packages', 'miniapp', 'project.config.json')));

// 2. 构建产物
const libPath = mini('lib', 'app.js');
check('lib/app.js 产物存在', existsSync(libPath) && statSync(libPath).size > 1024);
check('workers/engine/index.js 产物存在', existsSync(mini('workers', 'engine', 'index.js')));
check('worker 为单文件（无包外依赖）', (() => {
  try {
    const source = readFileSync(mini('workers', 'engine', 'index.js'), 'utf8');
    return !/require\(["'](?:\.\.?|@)/.test(source);
  } catch {
    return false;
  }
})());

// 3. 主线程包可在 Node 中 require（入口零副作用：不触碰 wx）
const requireCjs = createRequire(import.meta.url);
let appExports = null;
try {
  appExports = requireCjs(libPath);
  check('lib/app.js 可在 Node 加载且导出完整', [
    'createApp',
    'createIndexPage',
    'createGamePage',
    'createPracticePage',
    'createWxStorage',
    'createWxAudioPlayer',
    'WxWorkerEngineClient',
  ].every((name) => typeof appExports[name] === 'function'));
} catch {
  check('lib/app.js 可在 Node 加载且导出完整', false);
}

// 4. 静态资源
check('棋子贴图 14 张', (() => {
  try {
    return readdirSync(mini('images', 'pieces')).filter((f) => f.endsWith('.png')).length === 14;
  } catch {
    return false;
  }
})());

check('音效 5 个（ogg 已排除）', (() => {
  try {
    const files = readdirSync(mini('sounds')).filter((f) => !f.endsWith('.ogg'));
    return files.length === 5 && !files.some((f) => f.endsWith('.ogg'));
  } catch {
    return false;
  }
})());

check('内置棋谱 3 份（打谱用 XQF）', (() => {
  try {
    const files = readdirSync(mini('manuals')).filter((f) => f.endsWith('.xqf'));
    return files.length === 3;
  } catch {
    return false;
  }
})());

// 5. 工厂函数冒烟：createApp 返回生命周期骨架
try {
  const app = appExports.createApp();
  check('createApp 返回 onLaunch 骨架', typeof app.onLaunch === 'function');
} catch {
  check('createApp 返回 onLaunch 骨架', false);
}

console.log(failed === 0 ? '\n[smoke-miniapp] 全部通过' : `\n[smoke-miniapp] ${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
