import { BytesDecoder, setGb18030Decoder } from '@webchess/core';

/**
 * GB18030 解码适配层。
 *
 * XQF 棋谱头部（标题/赛事/棋手）以 GB18030 编码存储。
 * - Web：`TextDecoder('gb18030')` 原生支持（Chrome / Firefox / Safari 均内置）。
 * - 微信小程序：**不内置 GB18030**，需注入等价的纯 JS 解码表实现（见 createGb18030Decoder 返回值判空）。
 *
 * 未注入时内核按 Latin-1 降级：ASCII 字段正常，中文元信息暂不可读——
 * 这是「不静默删减」的显式降级，注入后功能即完整恢复。
 */

/** Web 端解码器：优先使用原生 TextDecoder。 */
export function createGb18030Decoder(): BytesDecoder | null {
  const Ctor = (globalThis as unknown as {
    TextDecoder?: new (encoding: string) => { decode(input: Uint8Array): string };
  }).TextDecoder;

  if (typeof Ctor !== 'function') {
    return null;
  }

  try {
    const decoder = new Ctor('gb18030');
    return { decode: (bytes) => decoder.decode(bytes) };
  } catch {
    return null;
  }
}

/** 启动时调用：把平台解码器注入内核。返回是否成功注入。 */
export function registerGb18030Decoder(): boolean {
  const decoder = createGb18030Decoder();
  setGb18030Decoder(decoder);
  return decoder !== null;
}
