#!/usr/bin/env node
// 生成 GB18030 内置解码表（packages/adapters/src/gb18030Table.ts）。
//
// 数据来源：Node 内置 TextDecoder('gb18030')（WHATWG Encoding Standard 实现，
// 已覆盖 GB18030-2022 新增码位）：
// - 双字节序列（0x81-0xFE + 0x40-0x7E / 0x80-0xFE，共 23940 槽）→ BMP 码点，存为单一字符串常量；
// - 四字节序列 → 按 ICU 线性公式映射码点，压缩为连续区间表（linearStart, cpStart, count 三元组）。
//
// 用法：node scripts/generate-gb18030-table.mjs

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const TARGET = join(
  dirname(fileURLToPath(import.meta.url)),
  '../packages/adapters/src/gb18030Table.ts',
);

const HEADER = `\
/**
 * GB18030 内置解码表（自动生成，勿手改）。
 *
 * 生成方式：\`node scripts/generate-gb18030-table.mjs\`
 * 数据来源：Node 内置 TextDecoder('gb18030')（WHATWG Encoding 实现，
 * 覆盖 GB18030-2022 新增码位）。
 *
 * - {@link GB18030_TABLE2}：双字节映射，槽位下标 = (首字节-0x81)*190 + 次字节槽序；
 *   次字节槽序：0x40-0x7E 映射 0-62，0x80-0xFE 映射 63-189。
 * - {@link GB18030_LINEAR_RANGES}：四字节线性区间表，扁平三元组
 *   [linearStart, cpStart, count, ...]；四字节线性值
 *   = ((b0-0x81)*10 + (b1-0x30))*1260 + (b2-0x81)*10 + (b3-0x30)。
 */

/** 双字节映射表（23940 槽）。 */
export const GB18030_TABLE2 = {TABLE2};

/** 四字节线性区间表（扁平三元组 [linearStart, cpStart, count, ...]）。 */
export const GB18030_LINEAR_RANGES: readonly number[] = {RANGES};
`;

const decoder = new TextDecoder('gb18030');

/** 四字节线性值 → 字节序列（b0/b2∈0x81-0xFE，b1/b3∈0x30-0x39）。 */
function linearToBytes(linear) {
  let rest = linear;
  const b3 = 0x30 + (rest % 10);
  rest = Math.floor(rest / 10);
  const b2 = 0x81 + (rest % 126);
  rest = Math.floor(rest / 126);
  const b1 = 0x30 + (rest % 10);
  rest = Math.floor(rest / 10);
  const b0 = 0x81 + rest;
  return new Uint8Array([b0, b1, b2, b3]);
}

function buildTable2() {
  const parts = [];
  const trails = [
    ...Array.from({ length: 63 }, (_, i) => 0x40 + i),
    ...Array.from({ length: 127 }, (_, i) => 0x80 + i),
  ];
  for (let lead = 0x81; lead <= 0xfe; lead++) {
    for (const trail of trails) {
      parts.push(decoder.decode(new Uint8Array([lead, trail])));
    }
  }

  const table = parts.join('');
  if (table.length !== 126 * 190) {
    throw new Error(`双字节表长度异常：${table.length}`);
  }

  if (table.includes('\uFFFE')) {
    throw new Error('表中含 U+FFFE 占位冲突');
  }

  return table;
}

function buildLinearRanges() {
  // 四字节线性值全域扫描：结构合法的序列经 WHATWG 解码，assigned 线性值映射唯一码点。
  const MAX_LINEAR = 1587599; // ((0xFE-0x81)*10+9)*1260 + ((0xFE-0x81)*10+9)
  const pairs = [];
  for (let linear = 0; linear <= MAX_LINEAR; linear++) {
    const s = decoder.decode(linearToBytes(linear));
    const cp = s.codePointAt(0);
    if (cp !== undefined && cp !== 0xfffd) {
      pairs.push([linear, cp]);
    }
  }

  const ranges = [];
  let [linearStart, cpStart] = pairs[0];
  let count = 1;
  for (let i = 1; i < pairs.length; i++) {
    const [linear, cp] = pairs[i];
    if (linear === linearStart + count && cp === cpStart + count) {
      count++;
    } else {
      ranges.push(linearStart, cpStart, count);
      linearStart = linear;
      cpStart = cp;
      count = 1;
    }
  }

  ranges.push(linearStart, cpStart, count);
  return { ranges, assigned: pairs.length };
}

function main() {
  const table = buildTable2();
  const { ranges, assigned } = buildLinearRanges();
  const content = HEADER.replace('{TABLE2}', JSON.stringify(table)).replace(
    '{RANGES}',
    JSON.stringify(ranges),
  );
  writeFileSync(TARGET, content, 'utf8');
  console.log(`written ${TARGET} (${content.length} bytes, ${ranges.length / 3} ranges, ${assigned} assigned 4-byte linears)`);
}

main();
