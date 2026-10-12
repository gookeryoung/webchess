import { Board, Move, Position } from '@webchess/core';
import { FastPosition, MAX_PLY, moveFrom, moveTo } from './fastBoard.js';
import { MATE_SCORE, PIECE_VALUE } from './evaluate.js';
import { acquireWasmPosition } from './wasmCore.js';

/**
 * 搜索用局面抽象：FastPosition（纯 TS）与 WasmPosition（WASM 内核）的公共结构。
 * Searcher 全程面向该接口编程，后端在构造时定型，运行路径完全一致。
 */
interface SearchPosition {
  readonly cells: Uint8Array;
  readonly moveBuffer: Int32Array;
  readonly redToMove: boolean;
  readonly keyLo: number;
  readonly keyHi: number;
  readonly baseScore: number;
  readonly heavyRed: number;
  readonly heavyBlack: number;
  setFromBoard(board: Board): unknown;
  make(move: number): void;
  unmake(): void;
  makeNull(): void;
  unmakeNull(): void;
  lastMove(): number;
  genMoves(out: Int32Array, base: number, capturesOnly: boolean): number;
  genLegalMoves(out: Int32Array, base: number): number;
  inCheck(red: boolean): boolean;
  isRepetition(): boolean;
  see(to: number, firstFrom: number): number;
  evaluateFull(): number;
}

/**
 * PVS 搜索引擎（迭代加深 + 数值键置换表 + 杀手/历史启发 + 空步裁剪 +
 * 静态搜索 + 重复局面检测 + 将军延伸 + LMR 晚着裁剪）。
 *
 * 相比旧 alpha-beta 实现的结构性升级：
 * 1. 每节点不再 `Board.clone()`/`toFen()`，全部在 FastPosition 上 make/unmake（零分配）；
 * 2. 置换表由 FEN 字符串 Map 改为固定容量开寻址表（双 32 位键校验，数值键零 GC）；
 * 3. 着法排序引入置换表着法/杀手/历史启发，配合 PVS 零窗口与 LMR 大幅提深。
 *
 * 纯 TypeScript，零平台依赖：Web Worker 与小程序 Worker 均可运行。
 */

/** 置换表容量（2^19 条目，约 10MB，兼顾小程序内存上限）。 */
const TT_BITS = 19;
const TT_SIZE = 1 << TT_BITS;
const TT_MASK = TT_SIZE - 1;

/** 置换表标志：精确值 / 下界（>= beta 截断）/ 上界（<= alpha 全搜）。 */
const FLAG_EXACT = 0;
const FLAG_LOWER = 1;
const FLAG_UPPER = 2;

/** mate 分界（|score| 超过即按将死处理，存储/读取须按 ply 平移）。 */
const MATE_BOUND = MATE_SCORE - MAX_PLY;

/** 每层走法缓冲容量（单节点着法数上限约 200，留余量）。 */
const MOVES_PER_PLY = 256;

/** 着法打分档位（保证 TT > 吃子 > 杀手 > 反制 > 历史）。 */
const SCORE_TT = 1 << 28;
const SCORE_CAPTURE = 1 << 26;
const SCORE_KILLER1 = 1 << 25;
const SCORE_KILLER2 = SCORE_KILLER1 - 1;
const SCORE_COUNTER = SCORE_KILLER2 - 1;

/**
 * 搜索特性开关（默认全开；elo-arena 用旧特性子集做 A/B 强度测量）。
 */
export interface SearcherOptions {
  /** 奇异延伸：TT 主着法显著优于其余着法时延伸一层。 */
  singularExtension?: boolean;
  /** countermove 反制着法表（安静着法排序，位于杀手之后历史之前）。 */
  countermove?: boolean;
  /** 吃子历史表（在吃子档位内细调排序）。 */
  captureHistory?: boolean;
  /** mate distance pruning（将死距离裁剪）。 */
  mateDistance?: boolean;
  /**
   * WASM 搜索内核：默认自动（核心已加载则优先使用，未加载回退纯 TS）；
   * 显式 false 强制纯 TS（A/B 基线与降级测试用）。
   */
  wasm?: boolean;
}

/** 搜索统计（供 UI 显示与测试断言）。 */
export interface SearchStats {
  nodes: number;
  depth: number;
  elapsedMs: number;
}

/** 搜索结果。 */
export interface SearchOutcome {
  bestMove: Move | null;
  score: number;
  pv: Move[];
  stats: SearchStats;
}

/** 搜索参数。 */
export interface SearchParams {
  /** 最大深度（迭代加深上限）。 */
  maxDepth?: number;
  /** 时限（毫秒）。 */
  moveTimeMs?: number;
  /** 取消令牌。 */
  cancelled?: () => boolean;
  /** 进度回调（每层完成）。 */
  onDepth?: (depth: number, score: number, pv: readonly Move[]) => void;
}

const DEFAULT_DEPTH = 8;
const DEFAULT_TIME_MS = 1500;
/** 负无穷窗口哨兵（绝对值大于任何合法分值，避免 Infinity 参与数值运算）。 */
const NEG_INF = -2 * MATE_SCORE;

/** 时间源：优先 performance.now，回退 Date.now（小程序兼容）。 */
function now(): number {
  const perf = (globalThis as unknown as { performance?: { now(): number } }).performance;
  return typeof perf?.now === 'function' ? perf.now() : Date.now();
}

export class Searcher {
  /** 置换表（开寻址，键双字段校验）。 */
  private readonly ttKeyA = new Int32Array(TT_SIZE);
  private readonly ttKeyB = new Int32Array(TT_SIZE);
  private readonly ttScoreArr = new Int32Array(TT_SIZE);
  private readonly ttMoveArr = new Int32Array(TT_SIZE);
  private readonly ttMeta = new Int16Array(TT_SIZE);

  /** 搜索局面（构造时定型：WASM 实例或纯 TS 实现）。 */
  private readonly pos: SearchPosition;
  /** 走法缓冲（即 pos.moveBuffer，WASM 后端为零拷贝线性内存视图）。 */
  private readonly moveBuf: Int32Array;
  private readonly scoreBuf = new Int32Array(MAX_PLY * MOVES_PER_PLY);
  private readonly killers = new Int32Array(MAX_PLY * 2);
  private readonly history = new Int32Array(15 * 90);
  /** countermove 表：[上一着棋子 * 90 + 上一着终点] → 反制着法。 */
  private readonly counterMoves = new Int32Array(15 * 90);
  /** 吃子历史：[吃方子 * 90 + 终点] → 累计增益（>> 8 后参与吃子排序）。 */
  private readonly capHistory = new Int32Array(15 * 90);

  /** 特性开关（构造时定型，运行期不变）。 */
  private readonly opt = {
    singularExtension: true,
    countermove: true,
    captureHistory: true,
    mateDistance: true,
  };

  constructor(options?: SearcherOptions) {
    Object.assign(this.opt, options);
    // 后端定型：核心已加载且未显式禁用时用 WASM 实例，否则纯 TS。
    this.pos =
      (options?.wasm === false ? null : acquireWasmPosition()) ?? new FastPosition();
    this.moveBuf = this.pos.moveBuffer;
    this.rootMoves = this.pos.moveBuffer.subarray(0, MOVES_PER_PLY);
  }

  /** 根着法缓冲（moveBuffer 前 256 项：根节点 ply=0，与 searchNode 的 ply≥1 区间无冲突）。 */
  private readonly rootMoves: Int32Array;
  private readonly rootScores = new Int32Array(MOVES_PER_PLY);
  private rootCount = 0;

  private nodes = 0;
  private deadline = Infinity;
  private cancelled: () => boolean = () => false;
  private aborted = false;

  /** 执行搜索，返回最佳着法与主变例（分值为走子方视角，negamax 约定）。 */
  search(board: Board, params: SearchParams = {}): SearchOutcome {
    const maxDepth = Math.max(1, Math.min(params.maxDepth ?? DEFAULT_DEPTH, MAX_PLY - 16));
    const moveTimeMs = params.moveTimeMs ?? DEFAULT_TIME_MS;
    this.nodes = 0;
    this.aborted = false;
    this.cancelled = params.cancelled ?? (() => false);
    this.killers.fill(0);
    this.history.fill(0);
    this.counterMoves.fill(0);
    this.capHistory.fill(0);
    const start = now();
    this.deadline = start + moveTimeMs;

    this.pos.setFromBoard(board);
    // 根节点 base=0：直接传实例 moveBuf 本体（WASM 后端校验缓冲身份，
    // rootMoves 视图仅作同一段内存的只读别名）。
    this.rootCount = this.pos.genLegalMoves(this.moveBuf, 0);
    if (this.rootCount === 0) {
      // 无着可走（将死或困毙）：当前走子方已输。
      return {
        bestMove: null,
        score: -MATE_SCORE,
        pv: [],
        stats: { nodes: 0, depth: 0, elapsedMs: now() - start },
      };
    }

    // 根着法初始排序：MVV-LVA（首轮后由各层实搜分接管）。
    for (let i = 0; i < this.rootCount; i++) {
      const move = this.rootMoves[i];
      const victim = this.pos.cells[moveTo(move)];
      this.rootScores[i] =
        victim !== 0
          ? SCORE_CAPTURE +
            PIECE_VALUE[victim] * 32 -
            PIECE_VALUE[this.pos.cells[moveFrom(move)]]
          : 0;
    }
    this.sortRoot();

    let bestMove = 0;
    let bestScore = 0;
    let bestPv: number[] = [];
    let reachedDepth = 0;

    /** 上轮完成层的分值（aspiration 窗口中心）。 */
    let prevScore = 0;
    /** 上轮完成层的最佳着法（稳定性判据）。 */
    let prevBestMove = 0;

    for (let depth = 1; depth <= maxDepth; depth++) {
      const iterStart = now();
      // aspiration 窗口：自第 3 层起以上轮分值为中心收窄根窗口，
      // 越界（fail-high/low）时退全窗复搜一次（最多重搜一轮）。
      const windowed = depth >= 3 && Math.abs(prevScore) < MATE_BOUND;
      const alphaStart = windowed ? prevScore - 50 : NEG_INF;
      const betaStart = windowed ? prevScore + 50 : -NEG_INF;
      let alpha = alphaStart;
      let beta = betaStart;
      let layerScore = NEG_INF;
      let layerBestMove = 0;

      for (let attempt = 0; attempt < 2; attempt++) {
        layerScore = NEG_INF;
        layerBestMove = 0;

        for (let i = 0; i < this.rootCount; i++) {
          const move = this.rootMoves[i];
          this.pos.make(move);
          let score: number;
          if (i === 0) {
            score = -this.searchNode(depth - 1, -beta, -alpha, 1, true);
          } else {
            // PVS：零窗口试探，超 alpha 再开全窗口复搜。
            score = -this.searchNode(depth - 1, -alpha - 1, -alpha, 1, true);
            if (score > alpha) {
              score = -this.searchNode(depth - 1, -beta, -alpha, 1, true);
            }
          }
          this.pos.unmake();
          if (this.aborted) {
            break;
          }

          this.rootScores[i] = score;
          if (score > layerScore) {
            layerScore = score;
            layerBestMove = move;
          }
          if (score > alpha) {
            alpha = score;
          }
        }

        if (this.aborted || !windowed) {
          break;
        }

        if (layerScore >= beta) {
          // fail-high：上界失效，放宽 beta 复搜（alpha 保留已提升值）。
          beta = -NEG_INF;
          continue;
        }

        if (layerScore <= alphaStart) {
          // fail-low：下界失效，放宽 alpha 复搜。
          alpha = NEG_INF;
          continue;
        }

        break;
      }

      if (this.aborted) {
        // 本层作废保留上轮结果；首轮即中止则兜底首个合法着法。
        if (reachedDepth === 0) {
          bestMove = this.rootMoves[0];
          bestScore = 0;
          bestPv = [bestMove];
        }
        break;
      }

      // 完成层：按实搜分重排，使下一层首着为本层最佳（PVS 主着法前置）。
      this.sortRoot();
      bestMove = layerBestMove !== 0 ? layerBestMove : this.rootMoves[0];
      bestScore = layerScore;
      prevScore = layerScore;
      reachedDepth = depth;
      this.ttStore(depth, bestScore, FLAG_EXACT, bestMove, 0);

      // PV 长度不绑定当前迭代深度：将军延伸会使杀棋线长于名义深度。
      const pvMoves = this.extractPv(maxDepth);
      bestPv = pvMoves.length > 0 ? pvMoves : [bestMove];
      params.onDepth?.(
        depth,
        bestScore,
        bestPv.map((m) => this.toMove(m)),
      );

      // 找到必胜/必败杀棋提前收敛。
      if (bestScore > MATE_BOUND || bestScore < -MATE_BOUND) {
        break;
      }

      // 时间预算：按本层实耗预估下一层（迭代加深分支因子约 3 倍），
      // bestMove 与上轮一致视为稳定、系数下调鼓励加深（即使中途作废也
      // 保留上轮结果无损失）；不稳定时上调系数尽早收敛。
      const iterElapsed = now() - iterStart;
      const stable = bestMove === prevBestMove;
      prevBestMove = bestMove;
      const estimate = iterElapsed * (stable ? 2 : 3);
      if (now() > this.deadline || estimate > moveTimeMs - (now() - start)) {
        break;
      }
    }

    if (bestMove === 0) {
      bestMove = this.rootMoves[0];
      bestScore = 0;
      bestPv = [bestMove];
    }

    return {
      bestMove: this.toMove(bestMove),
      score: bestScore,
      pv: (bestPv.length > 0 ? bestPv : [bestMove]).map((m) => this.toMove(m)),
      stats: { nodes: this.nodes, depth: reachedDepth, elapsedMs: now() - start },
    };
  }

  /** PVS 主搜索：将军延伸 + 置换表 + 空步裁剪 + LMR + 奇异延伸 + MDP。 */
  private searchNode(
    depth: number,
    alpha: number,
    beta: number,
    ply: number,
    canNull: boolean,
    excludedMove = 0,
  ): number {
    if (this.aborted) {
      return 0;
    }

    // 时限/取消检查每 1024 节点一次（粒度兼顾开销与响应）。
    if ((this.nodes & 1023) === 0 && (this.cancelled() || now() > this.deadline)) {
      this.aborted = true;
      return 0;
    }

    this.nodes++;

    const pos = this.pos;

    // 路径内重复局面判和（0 分），置于置换表之前防止 TT 蒙蔽循环路径。
    if (pos.isRepetition()) {
      return 0;
    }

    const inCheck = pos.inCheck(pos.redToMove);
    if (inCheck) {
      // 将军延伸：应将节点不减深度（受 ply 上限与重复检测双重兜底）。
      depth++;
    }

    // mate distance pruning：当前路径上不可能出现比「立即被将死」更差、
    // 也不可能比「下一着将死对手」更好的分值，据此收紧窗口，提前截断。
    if (this.opt.mateDistance) {
      alpha = Math.max(alpha, -MATE_SCORE + ply);
      beta = Math.min(beta, MATE_SCORE - ply);
      if (alpha >= beta) {
        return alpha;
      }
    }

    if (depth <= 0 || ply >= MAX_PLY - 8) {
      return this.quiescence(alpha, beta, ply, true);
    }

    // 置换表探测（命中即取着法/深度/标志/分值；分值按当前 ply 平移还原）。
    const idx = this.ttIndex();
    let ttMove = 0;
    let ttDepth = -1;
    let ttFlag = -1;
    let ttValue = 0;
    if (this.ttKeyA[idx] === pos.keyLo && this.ttKeyB[idx] === pos.keyHi) {
      ttMove = this.ttMoveArr[idx];
      const meta = this.ttMeta[idx];
      ttDepth = meta & 0xff;
      ttFlag = meta >> 8;
      ttValue = this.ttScoreArr[idx];
      if (ttValue > MATE_BOUND) {
        ttValue -= ply;
      } else if (ttValue < -MATE_BOUND) {
        ttValue += ply;
      }

      if (
        excludedMove === 0 &&
        ttDepth >= depth &&
        (ttFlag === FLAG_EXACT ||
          (ttFlag === FLAG_LOWER && ttValue >= beta) ||
          (ttFlag === FLAG_UPPER && ttValue <= alpha))
      ) {
        return ttValue;
      }
    }

    // 静态分（走子方视角）：futility 与空步裁剪共用（增量维护，O(1)）。
    const staticEval = pos.redToMove ? pos.baseScore : -pos.baseScore;

    // 走法裁剪（futility）：浅层安静节点静态分远低于 alpha 时，
    // 安静着法难有作为，直接降级为静态搜索。
    if (
      !inCheck &&
      depth <= 2 &&
      beta < MATE_BOUND &&
      Math.abs(alpha) < MATE_BOUND &&
      staticEval + 150 * depth <= alpha
    ) {
      return this.quiescence(alpha, beta, ply, true);
    }

    // 空步裁剪：非将军、有重子且非连续空步时以浅层试探直接截断。
    // baseScore 虽无机动性项，但试探消耗 2-3 层深度本身即是安全边际，
    // 加静态分守卫会收回空步裁剪的大部分收益（固定深度节点数 +60%）。
    const heavy = pos.redToMove ? pos.heavyRed : pos.heavyBlack;
    if (canNull && !inCheck && depth >= 3 && beta < MATE_BOUND && heavy > 0) {
      const r = depth >= 6 ? 3 : 2;
      pos.makeNull();
      const score = -this.searchNode(depth - 1 - r, -beta, -beta + 1, ply + 1, false);
      pos.unmakeNull();
      if (this.aborted) {
        return 0;
      }
      if (score >= beta) {
        return beta;
      }
    }

    // 生成伪合法着法并按启发式打分排序（含 countermove 反制着法）。
    const prevMove = this.opt.countermove ? pos.lastMove() : 0;
    const counter =
      prevMove !== 0 ? this.counterMoves[pos.cells[moveTo(prevMove)] * 90 + moveTo(prevMove)] : 0;

    const base = ply * MOVES_PER_PLY;
    const count = pos.genMoves(this.moveBuf, base, false);
    this.scoreMoves(base, count, ttMove, ply, counter);
    this.sortMoves(base, count);

    let bestScore = NEG_INF;
    let bestMove = 0;
    let legalCount = 0;
    const originalAlpha = alpha;
    const killer1 = this.killers[ply * 2];
    const killer2 = this.killers[ply * 2 + 1];

    for (let i = 0; i < count; i++) {
      const move = this.moveBuf[base + i];
      if (move === excludedMove) {
        // 奇异延伸的验证搜索：跳过被排除着法。
        continue;
      }

      // 奇异延伸：TT 主着法在排除自身后的验证搜索中仍守住奇异下界，
      // 说明它显著优于其余候选，延伸一层看清战术后果。
      // 排除搜索内不再递归触发（excludedMove !== 0）。
      let extension = 0;
      if (
        this.opt.singularExtension &&
        excludedMove === 0 &&
        move === ttMove &&
        depth >= 6 &&
        ttDepth >= depth - 3 &&
        ttFlag !== FLAG_UPPER &&
        Math.abs(ttValue) < MATE_BOUND
      ) {
        const singularBeta = Math.max(ttValue - depth * 2, -MATE_BOUND);
        const singularScore = this.searchNode(
          (depth - 1) >> 1,
          singularBeta - 1,
          singularBeta,
          ply,
          false,
          move,
        );
        if (this.aborted) {
          return 0;
        }

        if (singularScore < singularBeta) {
          extension = 1;
        }
      }

      const isCapture = pos.cells[moveTo(move)] !== 0;
      pos.make(move);
      if (pos.inCheck(!pos.redToMove)) {
        // 走后被将军：伪合法过滤。
        pos.unmake();
        continue;
      }

      legalCount++;
      let score: number;
      if (legalCount === 1) {
        score = -this.searchNode(depth - 1 + extension, -beta, -alpha, ply + 1, true);
      } else {
        // LMR：晚着安静着法按深搜与序位减 1-2 层零窗口试探，
        // 超 alpha 时先还原再开全窗复搜（保证不丢精确值）。
        const quiet = !isCapture && move !== killer1 && move !== killer2;
        const reduce =
          quiet && depth >= 3
            ? legalCount > 12 && depth >= 5
              ? 2
              : legalCount > 3
                ? 1
                : 0
            : 0;
        score = -this.searchNode(
          depth - 1 + extension - reduce,
          -alpha - 1,
          -alpha,
          ply + 1,
          true,
        );
        if (score > alpha && reduce > 0) {
          score = -this.searchNode(depth - 1 + extension, -alpha - 1, -alpha, ply + 1, true);
        }
        if (score > alpha && score < beta) {
          score = -this.searchNode(depth - 1 + extension, -beta, -alpha, ply + 1, true);
        }
      }
      pos.unmake();
      if (this.aborted) {
        return 0;
      }

      if (score > bestScore) {
        bestScore = score;
        bestMove = move;
      }
      if (score > alpha) {
        alpha = score;
      }
      if (alpha >= beta) {
        this.updateHeuristics(move, isCapture, depth, ply, prevMove);
        break;
      }
    }

    if (legalCount === 0) {
      // 排除搜索全被跳过属人为结果，返回当前窗口下界而非将死分。
      if (excludedMove !== 0) {
        return alpha;
      }

      // 无着可走：被将军为将死，否则困毙；中国象棋规则二者均判负。
      return -MATE_SCORE + ply;
    }

    const flag =
      bestScore >= beta ? FLAG_LOWER : bestScore <= originalAlpha ? FLAG_UPPER : FLAG_EXACT;
    if (excludedMove === 0) {
      // 排除搜索（奇异验证）的结果不含被排除着法，不写入置换表。
      this.ttStore(depth, bestScore, flag, bestMove, ply);
    }
    return bestScore;
  }

  /**
   * 静态搜索：只展开吃子着法消除地平线效应（主搜索的将军延伸保证入口非将军）。
   * 首层全量评估（含车/马机动性），深层递归仅用增量静态分——quiescence 节点
   * 是节点数大头，机动性全盘扫描只保留在主搜索叶上。
   */
  private quiescence(alpha: number, beta: number, ply: number, full: boolean): number {
    if (this.aborted) {
      return 0;
    }

    if ((this.nodes & 1023) === 0 && (this.cancelled() || now() > this.deadline)) {
      this.aborted = true;
      return 0;
    }

    this.nodes++;

    const pos = this.pos;
    const stand = full
      ? pos.evaluateFull()
      : pos.redToMove
        ? pos.baseScore
        : -pos.baseScore;
    if (ply >= MAX_PLY - 2) {
      return stand;
    }

    if (stand >= beta) {
      return stand;
    }
    if (stand > alpha) {
      alpha = stand;
    }

    const base = ply * MOVES_PER_PLY;
    const count = pos.genMoves(this.moveBuf, base, true);
    for (let i = 0; i < count; i++) {
      const move = this.moveBuf[base + i];
      const victim = pos.cells[moveTo(move)];
      const attacker = pos.cells[moveFrom(move)];
      this.scoreBuf[base + i] = SCORE_CAPTURE + PIECE_VALUE[victim] * 32 - PIECE_VALUE[attacker];
    }
    this.sortMoves(base, count);

    let best = stand;
    for (let i = 0; i < count; i++) {
      const move = this.moveBuf[base + i];
      const victim = pos.cells[moveTo(move)];
      // delta 剪枝：即使吃到该子加上安全边际仍无法超过 alpha，直接跳过。
      if (stand + PIECE_VALUE[victim] + 100 <= alpha) {
        continue;
      }

      // SEE 剪枝：大子吃小子且交换净亏（对手有更小攻击者吃回）时跳过展开，
      // 静态分已含被吃子价值，剪掉后仍以 stand 兜底不丢着法。
      const attacker = pos.cells[moveFrom(move)];
      if (
        PIECE_VALUE[victim] < PIECE_VALUE[attacker] &&
        pos.see(moveTo(move), moveFrom(move)) < 0
      ) {
        continue;
      }

      pos.make(move);
      if (pos.inCheck(!pos.redToMove)) {
        pos.unmake();
        continue;
      }

      const score = -this.quiescence(-beta, -alpha, ply + 1, false);
      pos.unmake();
      if (this.aborted) {
        return 0;
      }

      if (score > best) {
        best = score;
      }
      if (score > alpha) {
        alpha = score;
      }
      if (alpha >= beta) {
        break;
      }
    }

    return best;
  }

  /** 主搜索着法打分：TT 着法 > 吃子（MVV-LVA + 吃子历史）> 杀手 > 反制 > 历史。 */
  private scoreMoves(base: number, count: number, ttMove: number, ply: number, counter: number): void {
    const pos = this.pos;
    const killer1 = this.killers[ply * 2];
    const killer2 = this.killers[ply * 2 + 1];
    const useCap = this.opt.captureHistory;
    const useCounter = this.opt.countermove && counter !== 0 && counter !== ttMove;
    for (let i = 0; i < count; i++) {
      const move = this.moveBuf[base + i];
      let score: number;
      if (move === ttMove) {
        score = SCORE_TT;
      } else {
        const victim = pos.cells[moveTo(move)];
        if (victim !== 0) {
          score =
            SCORE_CAPTURE + PIECE_VALUE[victim] * 32 - PIECE_VALUE[pos.cells[moveFrom(move)]];
          if (useCap) {
            // 吃子历史：MVV-LVA 之上的细调项（归一化到 ±数百）。
            score += Math.max(-512, Math.min(512, this.capHistory[victim * 90 + moveTo(move)] >> 8));
          }
        } else if (move === killer1) {
          score = SCORE_KILLER1;
        } else if (move === killer2) {
          score = SCORE_KILLER2;
        } else if (useCounter && move === counter) {
          score = SCORE_COUNTER;
        } else {
          score = this.history[pos.cells[moveFrom(move)] * 90 + moveTo(move)];
        }
      }
      this.scoreBuf[base + i] = score;
    }
  }

  /** 走法插入排序（对启发式近排序输入 O(n)，双缓冲同步移动）。 */
  private sortMoves(base: number, count: number): void {
    for (let i = 1; i < count; i++) {
      const move = this.moveBuf[base + i];
      const score = this.scoreBuf[base + i];
      let j = i - 1;
      while (j >= 0 && this.scoreBuf[base + j] < score) {
        this.moveBuf[base + j + 1] = this.moveBuf[base + j];
        this.scoreBuf[base + j + 1] = this.scoreBuf[base + j];
        j--;
      }
      this.moveBuf[base + j + 1] = move;
      this.scoreBuf[base + j + 1] = score;
    }
  }

  /** beta 截断时更新杀手、历史、反制与吃子历史表。 */
  private updateHeuristics(
    move: number,
    isCapture: boolean,
    depth: number,
    ply: number,
    prevMove: number,
  ): void {
    if (isCapture) {
      // 吃子历史：以被吃子与终点为键累计增益，走差了（未截断）时衰减。
      if (this.opt.captureHistory) {
        const idx = this.pos.cells[moveTo(move)] * 90 + moveTo(move);
        this.capHistory[idx] += depth << 8;
        if (this.capHistory[idx] > 1 << 22) {
          for (let i = 0; i < this.capHistory.length; i++) {
            this.capHistory[i] >>= 1;
          }
        }
      }
      return;
    }

    if (this.killers[ply * 2] !== move) {
      this.killers[ply * 2 + 1] = this.killers[ply * 2];
      this.killers[ply * 2] = move;
    }

    const index = this.pos.cells[moveFrom(move)] * 90 + moveTo(move);
    this.history[index] += depth * depth;
    if (this.history[index] > 1 << 22) {
      // 溢出防护：全表衰减一半。
      for (let i = 0; i < this.history.length; i++) {
        this.history[i] >>= 1;
      }
    }

    // 反制着法：上一着（对方刚走的子与落点）→ 我方引发截断的应着。
    if (this.opt.countermove && prevMove !== 0) {
      this.counterMoves[this.pos.cells[moveTo(prevMove)] * 90 + moveTo(prevMove)] = move;
    }
  }

  /** 置换表索引：高低键混淆后取位（分布均匀）。 */
  private ttIndex(): number {
    return (Math.imul(this.pos.keyHi, 0x9e3779b1) ^ this.pos.keyLo) & TT_MASK;
  }

  /** 写入置换表：同局面更深的条目优先保留；mate 分按 ply 平移为路径无关值。 */
  private ttStore(depth: number, score: number, flag: number, move: number, ply: number): void {
    const idx = this.ttIndex();
    const pos = this.pos;
    if (
      this.ttKeyA[idx] === pos.keyLo &&
      this.ttKeyB[idx] === pos.keyHi &&
      (this.ttMeta[idx] & 0xff) > depth
    ) {
      return;
    }

    const adjusted = score > MATE_BOUND ? score + ply : score < -MATE_BOUND ? score - ply : score;
    this.ttKeyA[idx] = pos.keyLo;
    this.ttKeyB[idx] = pos.keyHi;
    this.ttScoreArr[idx] = adjusted;
    this.ttMoveArr[idx] = move;
    this.ttMeta[idx] = depth | (flag << 8);
  }

  /** 从置换表回溯主变例（校验走子方归属与合法性，最多 maxLen 步）。 */
  private extractPv(maxLen: number): number[] {
    const pos = this.pos;
    const pv: number[] = [];
    while (pv.length < maxLen) {
      const idx = this.ttIndex();
      if (this.ttKeyA[idx] !== pos.keyLo || this.ttKeyB[idx] !== pos.keyHi) {
        break;
      }

      const move = this.ttMoveArr[idx];
      if (move === 0) {
        break;
      }

      const piece = pos.cells[moveFrom(move)];
      if (piece === 0 || (pos.redToMove ? piece > 7 : piece <= 7)) {
        break;
      }

      pos.make(move);
      if (pos.inCheck(!pos.redToMove)) {
        pos.unmake();
        break;
      }
      pv.push(move);
    }

    for (let i = 0; i < pv.length; i++) {
      pos.unmake();
    }
    return pv;
  }

  /** 根着法按实搜分降序（选择排序，根着法数 ≤ 200）。 */
  private sortRoot(): void {
    for (let i = 0; i < this.rootCount - 1; i++) {
      let maxJ = i;
      for (let j = i + 1; j < this.rootCount; j++) {
        if (this.rootScores[j] > this.rootScores[maxJ]) {
          maxJ = j;
        }
      }
      if (maxJ !== i) {
        const move = this.rootMoves[i];
        this.rootMoves[i] = this.rootMoves[maxJ];
        this.rootMoves[maxJ] = move;
        const score = this.rootScores[i];
        this.rootScores[i] = this.rootScores[maxJ];
        this.rootScores[maxJ] = score;
      }
    }
  }

  /** 走法编码 → 内核 Move 对象。 */
  private toMove(move: number): Move {
    const from = moveFrom(move);
    const to = moveTo(move);
    return new Move(new Position(from % 9, (from / 9) | 0), new Position(to % 9, (to / 9) | 0));
  }

  /** 清空置换表与启发式表。 */
  clear(): void {
    this.ttKeyA.fill(0);
    this.ttKeyB.fill(0);
    this.ttScoreArr.fill(0);
    this.ttMoveArr.fill(0);
    this.ttMeta.fill(0);
    this.killers.fill(0);
    this.history.fill(0);
  }
}
