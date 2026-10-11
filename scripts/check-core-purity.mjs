#!/usr/bin/env node
/**
 * 内核纯净度门禁：packages/core/src 不得出现任何 DOM / 浏览器 / Node 专有标识。
 * 这是「核心逻辑可平滑迁移至小程序」的机器可验证判据。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = new URL('../packages/core/src', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

/** 禁止出现的标识符（词边界匹配）。 */
const FORBIDDEN = [
  'window', 'document', 'navigator', 'localStorage', 'sessionStorage',
  'fetch', 'XMLHttpRequest', 'WebSocket', 'Worker', 'self',
  'process', 'require', '__dirname', 'Buffer',
  'globalThis', 'alert', 'requestAnimationFrame', 'canvas',
  'HTMLElement', 'Image', 'Audio',
];

/** 允许出现在注释或字符串中的例外（按行判断）。 */
const isCommentLine = (line) => {
  const t = line.trim();
  return t.startsWith('*') || t.startsWith('//') || t.startsWith('/*');
};

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === '__tests__') continue;
      out.push(...walk(full));
    } else if (name.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

const files = walk(ROOT);
const violations = [];

for (const file of files) {
  const lines = readFileSync(file, 'utf8').split(/\r?\n/);
  lines.forEach((line, i) => {
    if (isCommentLine(line)) return;
    for (const token of FORBIDDEN) {
      const re = new RegExp(`\\b${token}\\b`);
      if (re.test(line)) {
        violations.push(`${relative(ROOT, file)}:${i + 1}  命中禁用标识符「${token}」\n      ${line.trim()}`);
      }
    }
  });
}

if (violations.length > 0) {
  console.error(`[purity] FAIL — 内核存在 ${violations.length} 处平台耦合：`);
  for (const v of violations) console.error('  ' + v);
  process.exit(1);
}

console.log(`[purity] OK — ${files.length} 个内核文件零平台耦合（无 DOM / 浏览器 / Node 标识）`);
