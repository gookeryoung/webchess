import { Board } from '@webchess/core';
import {
  ENDGAME_CANNON,
  ENDGAME_KING_STEP,
  ENDGAME_KNIGHT,
  FACING_CANNON,
  MISSING_ADVISOR,
  MISSING_BISHOP,
  PIECE_SCORE,
  PIECE_VALUE,
  ROOK_MOBILITY,
  KNIGHT_MOBILITY,
} from './evaluate.js';
import { MAX_PLY, MOVES_PER_PLY, ZOB_HI, ZOB_LO } from './fastBoard.js';

/**
 * WASM 搜索核心胶水层：加载 engine-core.wasm 并提供与 FastPosition 同构的
 * WasmPosition。加载失败或未调用 initEngineWasm 时，Searcher 自动回退纯 TS
 * 实现（行为一致，仅速度差异）。
 *
 * 平台无关：字节来源由调用方注入（Web 用 fetch/vite 资产，Node 用 fs，
 * 小程序用 WXWebAssembly），本模块不做任何平台专有 IO。
 */

/** 与 assembly/engine-core.ts 保持一致的实例内存布局（字节偏移）；
 * 标量区（I_RED 起 17 个 i32）经 state 视图整体访问，无需逐字段偏移。 */
const I_CELLS = 0;
const I_RED = 96;
const I_MOVEBUF = 4096;

const INSTANCE_COUNT = 4;

/** AS 导出函数签名（usize 参数以 number 传递；STAGING 为导出全局）。 */
interface CoreExports {
  STAGING: WebAssembly.Global;
  instanceBase(index: number): number;
  initTables(
    zobLoPtr: number,
    zobHiPtr: number,
    pieceScorePtr: number,
    pieceValuePtr: number,
    knowledgePtr: number,
  ): void;
  setFromBoard(base: number, redToMove: number, useNnue: number): void;
  make(base: number, move: number): void;
  unmake(base: number): void;
  makeNull(base: number): void;
  unmakeNull(base: number): void;
  lastMove(base: number): number;
  genMoves(base: number, outBase: number, capturesOnly: number): number;
  inCheck(base: number, red: number): number;
  isRepetition(base: number): number;
  see(base: number, to: number, firstFrom: number): number;
  evaluateRed(base: number): number;
  /** NNUE 权重区地址与开关（旧版内核无这些导出，故可能为 undefined）。 */
  nnueWeightsPtr?: () => number;
  enableNnue?: () => void;
  evaluateNnue?: (base: number) => number;
  memory: WebAssembly.Memory;
}

/** WCNW 权重文件字节数（与 assembly/engine-core.ts 的 NNUE_BYTES 一致）。 */
const NNUE_BYTES = 84088;

let core: CoreExports | null = null;
/** 实例引用计数（0 = 空闲）；容量固定为 AS 侧的 INSTANCE_COUNT。 */
const instanceRefs: number[] = new Array(INSTANCE_COUNT).fill(0);
/** 全部占用时的轮转游标（安全复用，见 acquireWasmPosition 文档）。 */
let roundRobin = 0;
/** NNUE 权重是否已上传到 WASM 内核。 */
let nnueUploaded = false;

/** WASM 核心是否已加载。 */
export function isWasmCoreLoaded(): boolean {
  return core !== null;
}

/** WASM 侧 NNUE 是否可用（内核含 NNUE 且权重已上传）。 */
export function isWasmNnueReady(): boolean {
  return core !== null && nnueUploaded;
}

/**
 * 上传 NNUE 权重的原始 WCNW 字节到 WASM 内核并启用。
 *
 * 必须在 `initEngineWasm` 之后调用（Worker 中先加载 wasm、再加载权重）；
 * 内核不含 NNUE 导出或权重长度不符时返回 false（Searcher 回退 TS + NNUE）。
 */
export function uploadNnueWeights(data: ArrayBuffer | ArrayBufferView): boolean {
  if (core === null || core.nnueWeightsPtr === undefined || core.enableNnue === undefined) {
    return false;
  }

  const bytes =
    data instanceof ArrayBuffer
      ? new Uint8Array(data)
      : new Uint8Array(data.buffer as ArrayBuffer, data.byteOffset, data.byteLength);
  if (bytes.byteLength !== NNUE_BYTES) {
    return false;
  }

  new Uint8Array(core.memory.buffer, core.nnueWeightsPtr(), NNUE_BYTES).set(bytes);
  core.enableNnue();
  nnueUploaded = true;
  return true;
}

/**
 * 加载 WASM 搜索核心（幂等；失败静默返回 false，引擎回退纯 TS）。
 * @param bytes wasm 模块字节（调用方自行从平台获取）。
 *
 * 入参兼容 `ArrayBuffer` 与 `ArrayBufferView`：Node 的 `readFileSync` 对小文件
 * 返回**池化 Buffer**（`.buffer` 是整个 64KB 池，含无关数据），直接传 `.buffer`
 * 会让 `WebAssembly.instantiate` 解析失败；视图入参按 byteOffset/byteLength 精确切片。
 */
export async function initEngineWasm(bytes: ArrayBuffer | ArrayBufferView): Promise<boolean> {
  if (core !== null) {
    return true;
  }

  try {
    const module =
      bytes instanceof ArrayBuffer
        ? bytes
        : (bytes.buffer as ArrayBuffer).slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    const { instance } = await WebAssembly.instantiate(module, {
      env: { abort: () => {
        throw new Error('engine-core wasm abort');
      } },
    });
    const exports = instance.exports as unknown as CoreExports;
    // 注入共享表：Zobrist / 子力位置合成分 / 子力价值 / 知识项常量。
    const staging = exports.STAGING.value;
    const buf = exports.memory.buffer;
    const stagingI32 = new Int32Array(buf, staging, (1350 + 1350 + 1350 + 15 + 10));
    stagingI32.set(ZOB_LO, 0);
    stagingI32.set(ZOB_HI, 1350);
    stagingI32.set(PIECE_SCORE, 2700);
    stagingI32.set(Int32Array.from(PIECE_VALUE), 4050);
    // 知识项顺序与 AS 端 knowledge(i) 读取一致；FULL_PHASE/THREAT_FULL 与
    // evaluate.ts 常量保持同步。
    const FULL_PHASE = 2 * (920 + 420 + 480) * 2;
    stagingI32.set(
      [
        ROOK_MOBILITY,
        KNIGHT_MOBILITY,
        ENDGAME_KNIGHT,
        ENDGAME_CANNON,
        ENDGAME_KING_STEP,
        FACING_CANNON,
        MISSING_ADVISOR,
        MISSING_BISHOP,
        FULL_PHASE,
        1840,
      ],
      4065,
    );
    exports.initTables(staging, staging + 5400, staging + 10800, staging + 16200, staging + 16260);
    core = exports;
    instanceRefs.fill(0);
    roundRobin = 0;
    return true;
  } catch {
    core = null;
    return false;
  }
}

/**
 * 从实例池取一个 WasmPosition；内核未加载时返回 null。
 *
 * 池策略（容量 = AS 静态布局的 INSTANCE_COUNT，不可增长）：
 * 1. 优先取空闲实例（引用计数 0）；
 * 2. 全部占用时按轮转**复用**一个实例并递增其引用计数，而不是返回 null。
 *    这依赖一个不变量：`Searcher.search()` 是同步调用，同一时刻只有一个实例
 *    真正处于搜索中，且每次搜索都以 `setFromBoard` 重建全部增量状态，
 *    因此共享实例不会串扰。这样「池耗尽 → 静默降级为纯 TS」不再发生；
 *    若将来引入并发搜索（多 Worker 各自独立加载模块，不受影响；同模块内异步搜索
 *    则会破坏该不变量），必须改为拒绝复用。
 *
 * @param useNnue 该实例是否维护 NNUE 累加器（手工评估实例应传 false，
 *   否则每条 make/unmake 都会白付 64 项累加成本）。
 */
export function acquireWasmPosition(useNnue = false): WasmPosition | null {
  if (core === null) {
    return null;
  }

  let index = instanceRefs.indexOf(0);
  if (index < 0) {
    index = roundRobin % INSTANCE_COUNT;
    roundRobin = (roundRobin + 1) % INSTANCE_COUNT;
  }

  instanceRefs[index]++;
  return new WasmPosition(core, index, useNnue);
}

/**
 * 归还实例（按引用计数递减，幂等）。
 * 调用方必须保证该实例上没有正在进行的搜索（search 为同步调用，正常路径天然满足）。
 */
export function releaseWasmPosition(pos: WasmPosition): void {
  const index = pos.instanceIndex;
  if (index < 0 || index >= instanceRefs.length) {
    return;
  }

  if (instanceRefs[index] > 0) {
    instanceRefs[index]--;
  }
}

/** 实例池统计（测试与诊断用）。 */
export function wasmPoolStats(): {
  readonly capacity: number;
  readonly inUse: number;
  readonly free: number;
} {
  const inUse = instanceRefs.filter((refs) => refs > 0).length;
  return { capacity: instanceRefs.length, inUse, free: instanceRefs.length - inUse };
}

/**
 * WASM 搜索核心实例：与 FastPosition 同构的公开接口。
 * 走法缓冲直接使用 WASM 线性内存视图（genMoves 原地写入，零拷贝）。
 */
export class WasmPosition {
  /** 棋盘矩阵视图（与内核 Board 同构）。 */
  readonly cells: Uint8Array;
  /** 走法缓冲视图（Searcher 直接以 ply*MOVES_PER_PLY 为基址使用）。 */
  readonly moveBuffer: Int32Array;
  private readonly core: CoreExports;
  private readonly base: number;
  /** 池内实例下标（releaseWasmPosition 用）。 */
  readonly instanceIndex: number;
  /** 本实例是否维护 NNUE 累加器（构造时定型）。 */
  private readonly useNnue: boolean;
  /** 实例标量区视图（I_RED 起 17 个 i32）。 */
  private readonly state: Int32Array;

  constructor(core: CoreExports, index: number, useNnue: boolean) {
    this.core = core;
    this.base = core.instanceBase(index);
    this.instanceIndex = index;
    this.useNnue = useNnue;
    this.cells = new Uint8Array(core.memory.buffer, this.base + I_CELLS, 90);
    this.moveBuffer = new Int32Array(
      core.memory.buffer,
      this.base + I_MOVEBUF,
      MAX_PLY * MOVES_PER_PLY,
    );
    this.state = new Int32Array(core.memory.buffer, this.base + I_RED, 17);
  }

  get redToMove(): boolean {
    return this.state[0] === 1;
  }

  get keyLo(): number {
    return this.state[1];
  }

  get keyHi(): number {
    return this.state[2];
  }

  get baseScore(): number {
    return this.state[3];
  }

  get kingRed(): number {
    return this.state[4];
  }

  get kingBlack(): number {
    return this.state[5];
  }

  get heavyRed(): number {
    return this.state[6];
  }

  get heavyBlack(): number {
    return this.state[7];
  }

  get advisorRed(): number {
    return this.state[8];
  }

  get advisorBlack(): number {
    return this.state[9];
  }

  get bishopRed(): number {
    return this.state[10];
  }

  get bishopBlack(): number {
    return this.state[11];
  }

  get knightRed(): number {
    return this.state[12];
  }

  get knightBlack(): number {
    return this.state[13];
  }

  get cannonRed(): number {
    return this.state[14];
  }

  get cannonBlack(): number {
    return this.state[15];
  }

  get ply(): number {
    return this.state[16];
  }

  /** 从内核 Board 重建局面（棋盘矩阵复制进 WASM 内存后重建增量状态）。 */
  setFromBoard(board: Board): this {
    this.cells.set(board.cells);
    this.core.setFromBoard(this.base, board.redToMove ? 1 : 0, this.useNnue ? 1 : 0);
    return this;
  }

  make(move: number): void {
    this.core.make(this.base, move);
  }

  unmake(): void {
    this.core.unmake(this.base);
  }

  makeNull(): void {
    this.core.makeNull(this.base);
  }

  unmakeNull(): void {
    this.core.unmakeNull(this.base);
  }

  lastMove(): number {
    return this.core.lastMove(this.base);
  }

  genMoves(out: Int32Array, base: number, capturesOnly: boolean): number {
    if (out !== this.moveBuffer) {
      throw new Error('WasmPosition.genMoves 要求使用实例自带的 moveBuffer');
    }

    return this.core.genMoves(this.base, base, capturesOnly ? 1 : 0);
  }

  /** 生成合法着法（伪合法过滤走后被将军），原地压缩写回。 */
  genLegalMoves(out: Int32Array, base: number): number {
    const count = this.genMoves(out, base, false);
    let w = base;
    for (let i = base; i < base + count; i++) {
      const move = out[i];
      this.make(move);
      const moverRed = !this.redToMove;
      const illegal = this.inCheck(moverRed);
      this.unmake();
      if (!illegal) {
        out[w++] = move;
      }
    }

    return w - base;
  }

  inCheck(red: boolean): boolean {
    return this.core.inCheck(this.base, red ? 1 : 0) === 1;
  }

  isRepetition(): boolean {
    return this.core.isRepetition(this.base) === 1;
  }

  see(to: number, firstFrom: number): number {
    return this.core.see(this.base, to, firstFrom);
  }

  /**
   * 叶子静态评估（走子方视角，negamax 约定）。
   * 本实例按 NNUE 定型且权重已上传内核时走 WASM 侧 NNUE 前向，
   * 否则回退手工评估（红方视角取反）。
   */
  evaluateFull(): number {
    if (this.useNnue && nnueUploaded && this.core.evaluateNnue !== undefined) {
      return this.core.evaluateNnue(this.base);
    }

    const red = this.core.evaluateRed(this.base);
    return this.redToMove ? red : -red;
  }
}
