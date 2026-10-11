/**
 * GB18030 解码注入点。
 *
 * 背景：XQF（象棋桥）棋谱的标题/赛事/棋手等头部字段以 GB18030 编码存储。
 * 原 C# 实现依赖 `System.Text.Encoding.GetEncoding("GB18030")`（需 CodePages 包）。
 *
 * Web 端：`TextDecoder('gb18030')` 原生支持，由 adapters 层注入。
 * 微信小程序端：**不内置 GB18030**，必须由 adapters 层注入等价的纯 JS 解码表实现。
 *
 * 内核保持纯净，不直接引用任何平台 API；未注入解码器时按 Latin-1 逐字节降级，
 * 保证 ASCII 字段可读且绝不抛异常（功能不删减，中文元信息等注入后即完整恢复）。
 */
export interface BytesDecoder {
  decode(bytes: Uint8Array): string;
}

let activeDecoder: BytesDecoder | null = null;

/** 注入 GB18030 解码器（由平台适配层在启动时调用）。 */
export function setGb18030Decoder(decoder: BytesDecoder | null): void {
  activeDecoder = decoder;
}

/** 当前是否已注入 GB18030 解码器。 */
export function hasGb18030Decoder(): boolean {
  return activeDecoder !== null;
}

/**
 * 按 GB18030 解码字节序列。
 * 无解码器时按 Latin-1 逐字节降级（ASCII 正确，中文暂不可读，注入后自动恢复）。
 */
export function decodeGb18030(bytes: Uint8Array): string {
  if (activeDecoder !== null) {
    try {
      return activeDecoder.decode(bytes);
    } catch {
      // 解码器异常不阻塞棋谱解析，降级处理。
    }
  }

  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    out += String.fromCharCode(bytes[i]);
  }

  return out;
}

/** 按 GB18030 解码切片（语义同 Encoding.GetString(data, offset, length)）。 */
export function decodeGb18030Slice(data: Uint8Array, offset: number, length: number): string {
  const end = Math.min(offset + length, data.length);
  return decodeGb18030(data.subarray(offset, end));
}
