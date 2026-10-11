/**
 * XQF 解密密钥（移植自参考项目 XQFKey.java 与 XQFParser.initDecryptKey）：
 * 由头部 13 字节加密参数计算棋子布局（keyXY）、起点（keyXYf）、终点（keyXYt）、
 * 注解长度（keyRmkSize）四把钥匙，以及着法区流式解密的 32 字节钥匙表。
 *
 * 本文件为纯确定性数学，不引用任何平台 API（与原 C# 版本一致，零 using）。
 */
export class XqfKey {
  /** XQF 版权串：流式解密钥匙表的种子（长度恰为 32 字节）。 */
  private static readonly CopyrightKeys = '[(C) Copyright Mr. Dong Shiwei.]';

  private readonly f32Keys: Uint8Array;

  private constructor(
    readonly keyXY: number,
    readonly keyXYf: number,
    readonly keyXYt: number,
    readonly keyRmkSize: number,
    f32Keys: Uint8Array,
  ) {
    this.f32Keys = f32Keys;
  }

  /** 流式解密钥匙表（32 字节）。 */
  get F32Keys(): Uint8Array {
    return this.f32Keys;
  }

  /**
   * 从头部加密参数切片（13 字节）计算密钥。
   * 产品号 4 字节（下标 1-4）不参与计算，与参考项目一致忽略。
   */
  static fromHeader(cryptKeys: Uint8Array): XqfKey {
    const keyMask = cryptKeys[0];
    const keyOrA = cryptKeys[5];
    const keyOrB = cryptKeys[6];
    const keyOrC = cryptKeys[7];
    const keyOrD = cryptKeys[8];
    const keysSum = cryptKeys[9];
    const headKeyXY = cryptKeys[10];
    const headKeyXYf = cryptKeys[11];
    const headKeyXYt = cryptKeys[12];

    // 首把钥匙以自身为级联因子，后续钥匙以前一把为级联因子（参考 Pascal 源公式）
    const keyXY = XqfKey.computeKey(headKeyXY, headKeyXY);
    const keyXYf = XqfKey.computeKey(headKeyXYf, keyXY);
    const keyXYt = XqfKey.computeKey(headKeyXYt, keyXYf);
    const keyRmkSize = ((keysSum * 256 + headKeyXY) % 32000 + 767) & 0xffff;

    const fKeyBytes = new Uint8Array([
      (keysSum & keyMask) | keyOrA,
      (headKeyXY & keyMask) | keyOrB,
      (headKeyXYf & keyMask) | keyOrC,
      (headKeyXYt & keyMask) | keyOrD,
    ]);

    const seed = XqfKey.asciiBytes(XqfKey.CopyrightKeys);
    const f32Keys = new Uint8Array(seed.length);
    for (let i = 0; i < seed.length; i++) {
      f32Keys[i] = seed[i] & fKeyBytes[i % 4];
    }

    return new XqfKey(keyXY, keyXYf, keyXYt, keyRmkSize, f32Keys);
  }

  /** 多项式扰动公式：(((((b*b)*3+9)*3+8)*2+1)*3+8)*prev，结果截断为单字节。 */
  private static computeKey(b: number, prev: number): number {
    return (((((b * b * 3 + 9) * 3 + 8) * 2 + 1) * 3 + 8) * prev) & 0xff;
  }

  /** 纯 ASCII 编码（不使用 TextEncoder，规避小程序端可用性差异）。 */
  private static asciiBytes(text: string): Uint8Array {
    const out = new Uint8Array(text.length);
    for (let i = 0; i < text.length; i++) {
      out[i] = text.charCodeAt(i) & 0xff;
    }

    return out;
  }
}
