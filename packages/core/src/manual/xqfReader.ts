import { decodeGb18030 } from '../codec/gb18030.js';

/**
 * XQF 字节流顺序读取器：提供字节数组、小端整数与 GB18030 字符串的顺序读取，
 * 越界时返回实际可读内容（容错优先，绝不抛异常）。
 */
export class XqfReader {
  private readonly buffer: Uint8Array;
  private index = 0;

  constructor(buffer: Uint8Array) {
    this.buffer = buffer;
  }

  /** 顺序读取指定长度字节；剩余不足时返回实际可读内容（可能为空数组）。 */
  readBytes(size: number): Uint8Array {
    const start = this.index;
    const stop = Math.min(this.index + size, this.buffer.length);
    this.index = stop;
    return this.buffer.subarray(start, stop);
  }

  /** 顺序读取 4 字节小端整数；剩余不足 4 字节时以 0 补齐。 */
  readInt32(): number {
    const bytes = this.readBytes(4);
    let result = 0;
    for (let i = 0; i < bytes.length; i++) {
      result |= bytes[i] << (8 * i);
    }

    return result;
  }

  /** 顺序读取指定长度 GB18030 字符串并去除首尾空白。 */
  readString(size: number): string {
    return this.readStringRaw(size).trim();
  }

  /** 同 {@link readString}，但不做 trim（保留原字节语义，供注解原文展示）。 */
  readStringRaw(size: number): string {
    try {
      return decodeGb18030(this.readBytes(size));
    } catch {
      return '';
    }
  }
}
