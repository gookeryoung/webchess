import { Piece } from '@webchess/core';

/**
 * NNUE 推理内核（纯 TS 参考实现 + 增量 accumulator 维护）。
 *
 * 网络结构（与 trainer/train.py 量化方案逐位一致，全部 floor 除法）：
 * 1. 视角特征：14 类棋子 × 90 格 = 1260（红视角红子 class 0-6 / 黑子 7-13；
 *    黑视角黑子 0-6 / 红子 7-13，格行镜像）；
 * 2. l1: 1260→32 双视角共享权重，各自累加（增量维护的 int32 accumulator）；
 * 3. concat 64 → cReLU（量化域 [0,127]）→ l2a: 64→32 → cReLU →
 *    l2b: 32→32 → cReLU → l3: 32→1；
 * 4. eval = floor(out × 400 / 8128)，走子方视角 cp。
 *
 * 权重文件（WCNW 二进制 v2，由 trainer/train.py 导出）：
 *   头 20 字节（magic "WCNW" + u32 version + u32 features + u32 hidden + u32 qa1）
 *   W1 int16[1260×32]、B1 int16[32]、W2A int8[64×32]、B2A int32[32]、
 *   W2B int8[32×32]、B2B int32[32]、W3 int8[32]、B3 int32[1]。
 *
 * 增量维护：FastPosition 在 make/unmake 时调用 pushMove/popMove，
 * 对两个视角 accumulator 做 W1 列向量的加/减（每次 ≤3 特征 × 2 视角 × 32 列）。
 */

/** 特征维度（14 类棋子 × 90 格）。 */
const FEATURES = 1260;
/** 隐层宽度。 */
const HIDDEN = 32;
/** 输出层缩放分母（a1 量化 127 × W2/W3 权重量化 64）。 */
const SCALE_OUT = 8128;

/** 黑视角棋子类别：黑子（8-14）→ 0-6，红子（1-7）→ 7-13。 */
function blackViewClass(piece: number): number {
  return piece >= Piece.BlackKing ? piece - 8 : piece + 6;
}

/** 格下标行镜像（黑视角：只翻 y 不翻 x）。 */
function mirrorSq(sq: number): number {
  return (9 - ((sq / 9) | 0)) * 9 + (sq % 9);
}

/** 权重集合（加载后定型）。 */
interface NnueWeights {
  /** l1 权重（int16 已展开为 int32：[特征 (1260+1)×32]，末行为 PAD 恒零列）。 */
  w1: Int32Array;
  b1: Int32Array;
  /** l2a 权重与 bias（[64×32] / [32]，行主序 [输出][输入]）。 */
  w2: Int8Array;
  b2: Int32Array;
  /** l2b 权重与 bias（[32×32] / [32]，行主序 [输出][输入]）。 */
  w2b: Int8Array;
  b2b: Int32Array;
  /** 输出层权重与 bias（[32] / [1]）。 */
  w3: Int8Array;
  b3: Int32Array;
}

let weights: NnueWeights | null = null;

/** 读取小端 int16/int32/int8 到 TypedArray 的辅助。 */
function sliceInt16(data: DataView, offset: number, count: number): Int32Array {
  const out = new Int32Array(count);
  for (let i = 0; i < count; i++) {
    out[i] = data.getInt16(offset + i * 2, true);
  }

  return out;
}

function sliceInt32(data: DataView, offset: number, count: number): Int32Array {
  const out = new Int32Array(count);
  for (let i = 0; i < count; i++) {
    out[i] = data.getInt32(offset + i * 4, true);
  }

  return out;
}

function sliceInt8(data: DataView, offset: number, count: number): Int8Array {
  const out = new Int8Array(count);
  for (let i = 0; i < count; i++) {
    out[i] = data.getInt8(offset + i);
  }

  return out;
}

/**
 * 加载 NNUE 权重（WCNW 二进制）。重复加载以最后一次为准；
 * 格式不符返回 false（调用方回退手工评估）。
 */
export function loadNnueWeights(data: ArrayBuffer): boolean {
  try {
    const view = new DataView(data);
    if (data.byteLength < 20 || view.getUint32(0, true) !== 0x574e4357) {
      // magic "WCNW" 小端 u32。
      return false;
    }

    const features = view.getUint32(8, true);
    const hidden = view.getUint32(12, true);
    if (features !== FEATURES || hidden !== HIDDEN) {
      return false;
    }

    let off = 20;
    const w1i16 = sliceInt16(view, off, FEATURES * HIDDEN);
    off += FEATURES * HIDDEN * 2;
    const b1 = sliceInt16(view, off, HIDDEN);
    off += HIDDEN * 2;
    const w2 = sliceInt8(view, off, HIDDEN * 2 * HIDDEN);
    off += HIDDEN * 2 * HIDDEN;
    const b2 = sliceInt32(view, off, HIDDEN);
    off += HIDDEN * 4;
    const w2b = sliceInt8(view, off, HIDDEN * HIDDEN);
    off += HIDDEN * HIDDEN;
    const b2b = sliceInt32(view, off, HIDDEN);
    off += HIDDEN * 4;
    const w3 = sliceInt8(view, off, HIDDEN);
    off += HIDDEN;
    const b3 = sliceInt32(view, off, 1);
    off += 4;
    if (off > data.byteLength) {
      return false;
    }

    // l1 权重扩一行零（特征下标 1260 = PAD，恒零列）。
    const w1 = new Int32Array((FEATURES + 1) * HIDDEN);
    w1.set(w1i16);
    weights = { w1, b1, w2, b2, w2b, b2b, w3, b3 };
    return true;
  } catch {
    return false;
  }
}

/** NNUE 权重是否已加载。 */
export function nnueReady(): boolean {
  return weights !== null;
}

/**
 * 双视角 accumulator（int32，int16 值域充裕）。
 * acc[0..31] = 红视角，acc[32..63] = 黑视角；
 * undoStack 与 FastPosition 的 ply 一一对应（调用方传入 ply）。
 */
export class NnueAccumulator {
  private readonly acc = new Int32Array(HIDDEN * 2);
  /** a1/a2/a3 激活缓冲（evaluate 复用，避免叶子节点分配）。 */
  private readonly a1 = new Int32Array(HIDDEN * 2);
  private readonly a2 = new Int32Array(HIDDEN);
  private readonly a3 = new Int32Array(HIDDEN);
  private readonly undoStack = new Int32Array(128 * HIDDEN * 2);

  /** 从棋盘全量重建（O(32 子 × 2 视角)，setFromBoard 后调用）。 */
  refresh(cells: Uint8Array): void {
    if (weights === null) {
      return;
    }

    this.acc.set(weights.b1, 0);
    this.acc.set(weights.b1, HIDDEN);
    const w1 = weights.w1;
    for (let sq = 0; sq < 90; sq++) {
      const piece = cells[sq];
      if (piece === Piece.Empty) {
        continue;
      }

      const redIdx = (piece - 1) * 90 + sq;
      const blkIdx = blackViewClass(piece) * 90 + mirrorSq(sq);
      for (let j = 0; j < HIDDEN; j++) {
        this.acc[j] += w1[redIdx * HIDDEN + j];
        this.acc[HIDDEN + j] += w1[blkIdx * HIDDEN + j];
      }
    }
  }

  /**
   * make 时调用（在 accumulator 被修改前压栈）：对「移动子 + 被吃子」做特征增减。
   * @param movedPiece 移动棋子编码
   * @param from 起点格
   * @param to 终点格
   * @param captured 被吃棋子编码（0 无吃子）
   * @param ply FastPosition 当前 ply（make 递增前的值，作 undo 栈基址）
   */
  pushMove(movedPiece: number, from: number, to: number, captured: number, ply: number): void {
    if (weights === null) {
      return;
    }

    this.undoStack.set(this.acc, ply * HIDDEN * 2);
    const w1 = weights.w1;
    // 移动子：from 列减、to 列加（两视角各一组）。
    const redMove = (movedPiece - 1) * 90;
    const blkMove = blackViewClass(movedPiece) * 90;
    const redFrom = (redMove + from) * HIDDEN;
    const redTo = (redMove + to) * HIDDEN;
    const blkFrom = (blkMove + mirrorSq(from)) * HIDDEN;
    const blkTo = (blkMove + mirrorSq(to)) * HIDDEN;
    for (let j = 0; j < HIDDEN; j++) {
      this.acc[j] += w1[redTo + j] - w1[redFrom + j];
      this.acc[HIDDEN + j] += w1[blkTo + j] - w1[blkFrom + j];
    }

    if (captured !== Piece.Empty) {
      // 被吃子：to 列减。
      const redCap = ((captured - 1) * 90 + to) * HIDDEN;
      const blkCap = (blackViewClass(captured) * 90 + mirrorSq(to)) * HIDDEN;
      for (let j = 0; j < HIDDEN; j++) {
        this.acc[j] -= w1[redCap + j];
        this.acc[HIDDEN + j] -= w1[blkCap + j];
      }
    }
  }

  /** unmake 时调用（ply 已递减）：按栈恢复 make 前 accumulator。 */
  popMove(ply: number): void {
    if (weights === null) {
      return;
    }

    const base = ply * HIDDEN * 2;
    for (let i = 0; i < HIDDEN * 2; i++) {
      this.acc[i] = this.undoStack[base + i];
    }
  }

  /**
   * 当前局面的 NNUE 评估（走子方视角 cp）。
   * @param redToMove 当前是否轮红走子（决定双视角拼接顺序：走子方在前）。
   */
  evaluate(redToMove: boolean): number {
    if (weights === null) {
      return 0;
    }

    const { w2, b2, w2b, b2b, w3, b3 } = weights;
    const acc = this.acc;
    const a1 = this.a1;
    // cReLU：量化域 [0,127]，floor 语义与 Python 一致。
    // 拼接顺序：走子方视角在前。
    const myBase = redToMove ? 0 : HIDDEN;
    const oppBase = redToMove ? HIDDEN : 0;
    for (let i = 0; i < HIDDEN; i++) {
      let v = Math.floor((acc[myBase + i] * 127 + 128) / 256);
      a1[i] = v < 0 ? 0 : v > 127 ? 127 : v;
      v = Math.floor((acc[oppBase + i] * 127 + 128) / 256);
      a1[HIDDEN + i] = v < 0 ? 0 : v > 127 ? 127 : v;
    }

    // l2a: concat 64 → 32（w2 布局为 [输出 32][输入 64] 行主序，与导出一致）。
    const a2 = this.a2;
    for (let j = 0; j < HIDDEN; j++) {
      let h = b2[j];
      const row = j * HIDDEN * 2;
      for (let i = 0; i < HIDDEN * 2; i++) {
        h += w2[row + i] * a1[i];
      }

      const v = Math.floor((h * 127 + 4064) / SCALE_OUT);
      a2[j] = v < 0 ? 0 : v > 127 ? 127 : v;
    }

    // l2b: 32 → 32（w2b 布局 [输出 32][输入 32] 行主序）。
    const a3 = this.a3;
    for (let j = 0; j < HIDDEN; j++) {
      let h = b2b[j];
      const row = j * HIDDEN;
      for (let i = 0; i < HIDDEN; i++) {
        h += w2b[row + i] * a2[i];
      }

      const v = Math.floor((h * 127 + 4064) / SCALE_OUT);
      a3[j] = v < 0 ? 0 : v > 127 ? 127 : v;
    }

    let out = b3[0];
    for (let i = 0; i < HIDDEN; i++) {
      out += w3[i] * a3[i];
    }

    return Math.floor((out * 400) / SCALE_OUT);
  }
}

/**
 * 全量重算评估（不依赖增量状态；测试与增量校验用）。
 * 与 NnueAccumulator 增量路径必须产出相同结果。
 */
export function nnueEvaluateCells(cells: Uint8Array, redToMove: boolean): number {
  if (weights === null) {
    return 0;
  }

  const acc = new NnueAccumulator();
  acc.refresh(cells);
  return acc.evaluate(redToMove);
}
