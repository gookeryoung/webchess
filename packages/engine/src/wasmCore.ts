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
  setFromBoard(base: number, redToMove: number): void;
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
  memory: WebAssembly.Memory;
}

let core: CoreExports | null = null;
let instancePool: (WasmPosition | null)[] = [];

/** WASM 核心是否已加载。 */
export function isWasmCoreLoaded(): boolean {
  return core !== null;
}

/**
 * 加载 WASM 搜索核心（幂等；失败静默返回 false，引擎回退纯 TS）。
 * @param bytes wasm 模块字节（调用方自行从平台获取）。
 */
export async function initEngineWasm(bytes: ArrayBuffer): Promise<boolean> {
  if (core !== null) {
    return true;
  }

  try {
    const { instance } = await WebAssembly.instantiate(bytes, {
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
    instancePool = new Array(INSTANCE_COUNT).fill(null);
    return true;
  } catch {
    core = null;
    return false;
  }
}

/** 从实例池取一个空闲 WasmPosition；池耗尽或未加载时返回 null。 */
export function acquireWasmPosition(): WasmPosition | null {
  if (core === null) {
    return null;
  }

  for (let i = 0; i < instancePool.length; i++) {
    if (instancePool[i] === null) {
      const pos = new WasmPosition(core, i);
      instancePool[i] = pos;
      return pos;
    }
  }

  return null;
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
  /** 实例标量区视图（I_RED 起 17 个 i32）。 */
  private readonly state: Int32Array;

  constructor(core: CoreExports, index: number) {
    this.core = core;
    this.base = core.instanceBase(index);
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
    this.core.setFromBoard(this.base, board.redToMove ? 1 : 0);
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

  /** 叶子静态评估（走子方视角，negamax 约定）。 */
  evaluateFull(): number {
    const red = this.core.evaluateRed(this.base);
    return this.redToMove ? red : -red;
  }
}
