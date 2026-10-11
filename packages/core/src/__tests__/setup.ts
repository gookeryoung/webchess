/**
 * 测试前置：注入 GB18030 解码器。
 *
 * 内核本身不引用任何平台 API；XQF 棋谱的中文元信息需要 GB18030 解码，
 * 这里在测试环境（Node，内置完整 ICU）注入原生 TextDecoder 实现，
 * 与 Web 端适配层注入 `new TextDecoder('gb18030')` 的方式完全一致。
 */
import { setGb18030Decoder } from '../codec/gb18030.js';

interface TextDecoderLike {
  decode(bytes: Uint8Array): string;
}

type TextDecoderCtor = new (encoding: string) => TextDecoderLike;

const globals = globalThis as unknown as { TextDecoder?: TextDecoderCtor };
if (typeof globals.TextDecoder === 'function') {
  setGb18030Decoder(new globals.TextDecoder('gb18030'));
}
