import { describe, expect, it } from 'vitest';
import { createGb18030Decoder, createGb18030TableDecoder } from '../index.js';

describe('createGb18030TableDecoder — 纯表解码（不依赖 TextDecoder）', () => {
  const decoder = createGb18030TableDecoder();

  it('ASCII 单字节 0x00-0x7F 透传', () => {
    const bytes = new Uint8Array([0x48, 0x65, 0x6C, 0x6C, 0x6F]); // "Hello"
    expect(decoder.decode(bytes)).toBe('Hello');
  });

  it('0x80 → U+20AC（欧元符）', () => {
    expect(decoder.decode(new Uint8Array([0x80]))).toBe('\u20AC');
  });

  it('GB18030 双字节：中文基本区字符能正确解码', () => {
    // "汉" 的 GB18030 编码是 0xBABA
    // 让我们验证：
    const result = decoder.decode(new Uint8Array([0xBA, 0xBA]));
    expect(result).toBe('汉');
  });

  it('非法字节 0xFF 返回 U+FFFD', () => {
    expect(decoder.decode(new Uint8Array([0xFF]))).toBe('\uFFFD');
  });

  it('不完整双字节序列（只有首字节）按最大子段语义处理', () => {
    // 0x81 后没有第二字节 → 消耗首字节并输出 REPLACEMENT
    expect(decoder.decode(new Uint8Array([0x81]))).toBe('\uFFFD');
  });

  it('混合 ASCII + 中文 + 非法字节能安全解码', () => {
    // "Hi 汉\xFF"
    const result = decoder.decode(new Uint8Array([0x48, 0x69, 0x20, 0xBA, 0xBA, 0xFF]));
    expect(result).toBe('Hi 汉\uFFFD');
  });

  it('空数组返回空字符串', () => {
    expect(decoder.decode(new Uint8Array([]))).toBe('');
  });
});

describe('createGb18030Decoder — 平台解码器回退逻辑', () => {
  it('返回 BytesDecoder 类型且能解码（无论原生 TextDecoder 是否存在）', () => {
    const decoder = createGb18030Decoder();
    const result = decoder.decode(new Uint8Array([0x41, 0x42]));
    expect(result).toBe('AB');
  });

  it('与纯表解码器对同一输入输出一致（ASCII 子集）', () => {
    const platform = createGb18030Decoder();
    const table = createGb18030TableDecoder();
    const inputs = [
      new Uint8Array([]),
      new Uint8Array([0x41]),
      new Uint8Array([0x48, 0x65, 0x6C, 0x6C, 0x6F]),
    ];
    for (const input of inputs) {
      expect(platform.decode(input)).toBe(table.decode(input));
    }
  });
});
