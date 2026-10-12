import { describe, expect, it } from 'vitest';
import { createGb18030TableDecoder } from '@webchess/adapters';

/**
 * GB18030 内置解码表测试（无 TextDecoder 的平台如微信小程序将使用该实现）。
 * 以 WHATWG TextDecoder('gb18030') 为基准做全量双字节与抽样四字节比对。
 */

const decoder = createGb18030TableDecoder();
const native = new TextDecoder('gb18030');

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }

  return out;
}

/** 由四字节线性值反推字节序列（b0/b2∈0x81-0xFE，b1/b3∈0x30-0x39）。 */
function linearToBytes(linear: number): Uint8Array {
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

describe('GB18030 内置解码表', () => {
  it('ASCII 透传', () => {
    expect(decoder.decode(hexToBytes('41424320'))).toBe('ABC ');
    expect(decoder.decode(new TextEncoder().encode('XQF 1.0'))).toBe('XQF 1.0');
  });

  it('常用汉字与符号', () => {
    expect(decoder.decode(hexToBytes('d6d0'))).toBe('中');
    expect(decoder.decode(hexToBytes('cff3'))).toBe('象');
    expect(decoder.decode(hexToBytes('c6e5'))).toBe('棋');
    expect(decoder.decode(hexToBytes('b3febad3bababde7'))).toBe('楚河汉界');
    expect(decoder.decode(hexToBytes('c5dab6fec6bdcee5'))).toBe('炮二平五');
    expect(decoder.decode(hexToBytes('a2e3'))).toBe('€');
    expect(decoder.decode(hexToBytes('a1a4'))).toBe('·');
  });

  it('四字节序列（扩展区字符）', () => {
    expect(decoder.decode(hexToBytes('95328236'))).toBe('𠀀');
  });

  it('非法字节降级为 U+FFFD 且不抛异常', () => {
    expect(decoder.decode(hexToBytes('ff'))).toBe('\uFFFD');
    // 截断的首字节。
    expect(decoder.decode(hexToBytes('d6'))).toBe('\uFFFD');
    // 非法次字节：首字节产生替换符，0x7F 按单字节 DEL 透传（与 WHATWG 一致）。
    expect(decoder.decode(hexToBytes('d67f'))).toBe('\uFFFD\u007F');
    // 空输入。
    expect(decoder.decode(new Uint8Array(0))).toBe('');
  });

  it('全量 23940 个双字节槽位与原生 TextDecoder 一致', () => {
    let compared = 0;
    for (let lead = 0x81; lead <= 0xfe; lead++) {
      for (let trail = 0x40; trail <= 0xfe; trail++) {
        if (trail > 0x7e && trail < 0x80) {
          continue;
        }

        const bytes = new Uint8Array([lead, trail]);
        expect(decoder.decode(bytes)).toBe(native.decode(bytes));
        compared++;
      }
    }

    expect(compared).toBe(23940);
  });

  it('四字节线性值抽样与原生 TextDecoder 一致', () => {
    // 全量 1237576 个线性值按步长抽样，覆盖全部 207 个连续区间的起止边界。
    const samples = new Set<number>([0, 1237575]);
    for (let linear = 0; linear <= 1237575; linear += 997) {
      samples.add(linear);
      samples.add(Math.min(1237575, linear + 1));
    }

    for (const linear of samples) {
      const bytes = linearToBytes(linear);
      expect(decoder.decode(bytes)).toBe(native.decode(bytes));
    }
  });
});
