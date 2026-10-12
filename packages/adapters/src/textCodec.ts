import { BytesDecoder, setGb18030Decoder } from '@webchess/core';
import { GB18030_LINEAR_RANGES, GB18030_TABLE2 } from './gb18030Table.js';

/**
 * GB18030 解码适配层。
 *
 * XQF 棋谱头部（标题/赛事/棋手）以 GB18030 编码存储。
 * - Web：`TextDecoder('gb18030')` 原生支持（Chrome / Firefox / Safari 均内置）。
 * - 微信小程序：**不内置 GB18030**，回退到本模块内置的纯 JS 解码表实现
 *   （见 gb18030Table.ts，由 scripts/generate-gb18030-table.py 生成）。
 *
 * 未注入时内核按 Latin-1 降级：ASCII 字段正常，中文元信息暂不可读——
 * 这是「不静默删减」的显式降级，注入后功能即完整恢复。
 */

const REPLACEMENT = '\uFFFD';

/**
 * 内置解码表实现：不依赖任何平台 API（小程序可安全使用）。
 *
 * 解码规则与 WHATWG TextDecoder('gb18030') 对齐：
 * - 单字节 0x00-0x7F 透传，0x80 → U+20AC（欧元符）；
 * - 双字节（0x81-0xFE + 0x40-0x7E / 0x80-0xFE）查表；
 * - 四字节（0x81-0xFE + 0x30-0x39 + 0x81-0xFE + 0x30-0x39）按线性区间表映射；
 * - 非法字节按「最大子段」语义降级为 U+FFFD，绝不抛异常。
 */
export function createGb18030TableDecoder(): BytesDecoder {
  return { decode: decodeTable };
}

function decodeTable(bytes: Uint8Array): string {
  let out = '';
  let i = 0;
  const n = bytes.length;
  while (i < n) {
    const b = bytes[i]!;
    if (b < 0x80) {
      out += String.fromCharCode(b);
      i++;
      continue;
    }

    if (b === 0x80) {
      out += '\u20AC';
      i++;
      continue;
    }

    if (b >= 0x81 && b <= 0xFE) {
      const b1 = i + 1 < n ? bytes[i + 1]! : -1;
      if (b1 >= 0x30 && b1 <= 0x39) {
        // 四字节序列（b1 是第二字节，取值 0x30-0x39）。
        const b2 = i + 2 < n ? bytes[i + 2]! : -1;
        const b3 = i + 3 < n ? bytes[i + 3]! : -1;
        if (b2 >= 0x81 && b2 <= 0xFE && b3 >= 0x30 && b3 <= 0x39) {
          const linear =
            ((b - 0x81) * 10 + (b1 - 0x30)) * 1260 + (b2 - 0x81) * 10 + (b3 - 0x30);
          const cp = lookupLinear(linear);
          out += cp >= 0 ? String.fromCodePoint(cp) : REPLACEMENT;
          i += 4;
        } else {
          // 结构不完整：消耗首字节，后续字节重新处理（最大子段语义）。
          out += REPLACEMENT;
          i++;
        }
        continue;
      }

      if ((b1 >= 0x40 && b1 <= 0x7E) || (b1 >= 0x80 && b1 <= 0xFE)) {
        const slot = (b - 0x81) * 190 + (b1 <= 0x7E ? b1 - 0x40 : b1 - 0x80 + 63);
        out += GB18030_TABLE2[slot] ?? REPLACEMENT;
        i += 2;
      } else {
        out += REPLACEMENT;
        i++;
      }
      continue;
    }

    // 0xFF：非法单字节。
    out += REPLACEMENT;
    i++;
  }

  return out;
}

/** 四字节线性区间二分查找；未命中（未 assigned 线性值）返回 -1。 */
function lookupLinear(linear: number): number {
  const ranges = GB18030_LINEAR_RANGES;
  let lo = 0;
  let hi = ranges.length / 3 - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const base = mid * 3;
    const linearStart = ranges[base]!;
    const cpStart = ranges[base + 1]!;
    const count = ranges[base + 2]!;
    if (linear < linearStart) {
      hi = mid - 1;
    } else if (linear >= linearStart + count) {
      lo = mid + 1;
    } else {
      return cpStart + (linear - linearStart);
    }
  }

  return -1;
}

/** 平台解码器：优先原生 TextDecoder('gb18030')，缺失或不可用时回退内置解码表。 */
export function createGb18030Decoder(): BytesDecoder {
  const Ctor = (globalThis as unknown as {
    TextDecoder?: new (encoding: string) => { decode(input: Uint8Array): string };
  }).TextDecoder;

  if (typeof Ctor === 'function') {
    try {
      const decoder = new Ctor('gb18030');
      return { decode: (bytes) => decoder.decode(bytes) };
    } catch {
      // 原生不可用（如小程序），回退内置表。
    }
  }

  return createGb18030TableDecoder();
}

/** 启动时调用：把平台解码器注入内核。返回是否成功注入。 */
export function registerGb18030Decoder(): boolean {
  const decoder = createGb18030Decoder();
  setGb18030Decoder(decoder);
  return decoder !== null;
}
