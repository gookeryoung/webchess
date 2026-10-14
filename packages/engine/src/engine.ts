import {
  Board,
  CancellationToken,
  Emitter,
  EngineOptions,
  EngineSession,
  GoParams,
  Move,
  MultiPvInfo,
  Rule,
  SearchResult,
} from '@webchess/core';
import { probeBookAtFen } from './book.js';
import { Searcher } from './search.js';

/**
 * 内置中国象棋引擎（实现内核的 EngineSession 契约）。
 *
 * 替代原 C# 的 Pikafish + UCI 进程方案（Web / 小程序无法启动子进程、无法加载 NNUE）。
 * 强度通过 ELO / Skill Level 到搜索深度上限的映射调节；最高档不再压深度
 * （时间制自然加深）；弱化档在浅深度之上叠加概率性失误采样，模拟人类失误。
 */

/** ELO 最高档：不再限制深度，由时限自然决定。 */
const ELO_UNLIMITED = 3100;

/**
 * 由棋力选项推导搜索深度上限；最高档/未配置时返回 undefined（不限制）。
 * 映射保持低端不变：ELO 1500 → 3，Skill 0 → 1。
 */
export function depthFromOptions(options: EngineOptions | undefined): number | undefined {
  if (options?.elo !== undefined && options.limitStrength === true) {
    if (options.elo >= ELO_UNLIMITED) {
      return undefined;
    }

    // UCI_Elo 1280-3100 → 深度 2-12。
    const depth = Math.round(((options.elo - 1280) / (ELO_UNLIMITED - 1280)) * 10) + 2;
    return Math.min(12, Math.max(2, depth));
  }

  if (options?.skillLevel !== undefined) {
    if (options.skillLevel >= 20) {
      return undefined;
    }

    // Skill Level 0-19 → 深度 1-13。
    return Math.min(13, Math.max(1, Math.round((options.skillLevel / 19) * 12) + 1));
  }

  return undefined;
}

/** MultiPV 每路搜索的时限下限/上限（毫秒）。 */
const MULTIPV_TIME_MIN = 150;
const MULTIPV_TIME_MAX = 800;

/** 失误采样：弱化档位以该概率放弃最佳着、随机走合法着（模拟人类失误）。 */
function blunderRate(strengthDepth: number | undefined): number {
  if (strengthDepth === undefined || strengthDepth >= 6) {
    return 0;
  }

  // 深度上限 2 → 0.48，5 → 0.12，6 以上 → 0。
  return Math.min(0.5, (6 - strengthDepth) * 0.12);
}

export class BuiltinEngine implements EngineSession {
  private readonly searcher = new Searcher();
  private readonly infoEmitter = new Emitter<MultiPvInfo>();
  private readonly defaultDepth: number;
  private readonly defaultTimeMs: number;
  /** 由 applyOptions 下发的强度深度上限（undefined 表示未限制）。 */
  private strengthDepth: number | undefined;
  private stopRequested = false;
  /** 失误采样随机源（测试可注入确定性实现）。 */
  private readonly rng: () => number;

  isReady = true;

  constructor(defaultDepth = 10, defaultTimeMs = 1500, rng: () => number = Math.random) {
    this.defaultDepth = defaultDepth;
    this.defaultTimeMs = defaultTimeMs;
    this.rng = rng;
  }

  onInfo(listener: (info: MultiPvInfo) => void): () => void {
    return this.infoEmitter.add(listener);
  }

  async start(): Promise<void> {
    this.isReady = true;
  }

  async go(params: GoParams, token?: CancellationToken): Promise<SearchResult> {
    if (!this.isReady) {
      return { bestMove: null, ponderMove: null };
    }

    let board: Board;
    try {
      board = Board.fromFen(params.fen);
      if (params.moves !== undefined) {
        for (const ucci of params.moves) {
          const move = Move.fromUcci(ucci);
          if (move === null || !board.doMove(move)) {
            break;
          }
        }
      }
    } catch {
      return { bestMove: null, ponderMove: null };
    }

    this.stopRequested = false;

    // 深度合成：显式 depth 为上限，强度设置（ELO/Skill）进一步收紧。
    let depth = params.depth ?? this.defaultDepth;
    if (this.strengthDepth !== undefined) {
      depth = Math.min(depth, this.strengthDepth);
    }

    const moveTimeMs = params.moveTimeMs ?? (params.infinite === true ? 60000 : this.defaultTimeMs);
    const multiPv = params.multiPv ?? 1;
    const cancelled = () => this.stopRequested || token?.cancelled === true;

    // 开局库（查表）：非分析模式（MultiPV = 1）、非无限搜索且未显式禁用时，
    // 用当前局面键直查哈希表（换位感知），命中即零延迟出库。
    // 注意：不能要求 `params.depth === undefined`——人机对局恒带深度上限，
    // 旧条件导致开局库在真实对局中从未生效。
    if (params.useBook !== false && params.infinite !== true && multiPv <= 1) {
      const bookMove = probeBookAtFen(board.toFen(), this.rng);
      if (bookMove !== null && this.isLegalUcci(board, bookMove)) {
        this.infoEmitter.emit({
          index: 1,
          depth: 0,
          scoreCp: 0,
          isMate: false,
          upperBound: false,
          lowerBound: false,
          pv: [bookMove],
        });
        return { bestMove: bookMove, ponderMove: null, source: 'book' };
      }
    }

    if (multiPv > 1) {
      return this.searchMultiPv(board, depth, multiPv, moveTimeMs, cancelled);
    }

    const outcome = this.searcher.search(board, {
      maxDepth: depth,
      moveTimeMs,
      cancelled,
      onDepth: (reachedDepth, score, pv) => {
        this.infoEmitter.emit({
          index: 1,
          depth: Math.min(reachedDepth, depth),
          scoreCp: Math.round(score),
          isMate: Math.abs(score) > 90000,
          upperBound: false,
          lowerBound: false,
          pv: pv.map((m) => m.toUcci()),
        });
      },
    });

    if (this.stopRequested && outcome.stats.depth === 0) {
      return { bestMove: null, ponderMove: null, source: 'search' };
    }

    let bestUcci = outcome.bestMove?.toUcci() ?? null;

    // 弱化档失误采样：以 blunderRate 概率随机走一步合法着（棋感类失误，
    // 比单纯压深度的「变笨」更接近真人对手）。
    const blunder = blunderRate(this.strengthDepth);
    if (bestUcci !== null && blunder > 0 && this.rng() < blunder) {
      const legal = Rule.getAllLegalMoves(board, board.redToMove);
      if (legal.length > 1) {
        bestUcci = legal[Math.floor(this.rng() * legal.length)].toUcci();
      }
    }

    return {
      bestMove: bestUcci,
      ponderMove: outcome.pv[1]?.toUcci() ?? null,
      source: 'search',
    };
  }

  /** 校验 UCCI 着法在当前 board（已应用 params.moves 后）是否合法。 */
  private isLegalUcci(board: Board, ucci: string): boolean {
    try {
      const move = Move.fromUcci(ucci);
      return move !== null && Rule.isLegalMove(board, move);
    } catch {
      return false;
    }
  }

  /**
   * MultiPV：先以浅层搜索给全部根着法预评分（避免只按吃子分挑选而漏掉
   * 安静的强着法），取前 N 路再做完整搜索并逐路汇报。
   */
  private searchMultiPv(
    board: Board,
    depth: number,
    multiPv: number,
    moveTimeMs: number,
    cancelled: () => boolean,
  ): SearchResult {
    const rootMoves = Rule.getAllLegalMoves(board, board.redToMove);
    if (rootMoves.length === 0) {
      return { bestMove: null, ponderMove: null, source: 'search' };
    }

    // 阶段一：浅层预评分（depth ≤ 2，每着短时限，通常几毫秒即完成）。
    const shallowDepth = Math.max(1, Math.min(2, depth - 1));
    const scored = rootMoves.map((move) => {
      const child = board.clone();
      child.doMove(move);
      const outcome = this.searcher.search(child, {
        maxDepth: shallowDepth,
        moveTimeMs: 50,
        cancelled,
      });
      return { move, score: -outcome.score };
    });
    scored.sort((a, b) => b.score - a.score);
    const chosen = scored.slice(0, multiPv);

    // 阶段二：对前 N 路完整搜索，时限均分并夹在上下限之间。
    const perMoveMs = Math.max(
      MULTIPV_TIME_MIN,
      Math.min(MULTIPV_TIME_MAX, Math.floor(moveTimeMs / chosen.length)),
    );
    let bestUcci: string | null = null;
    let bestScore = -Infinity;
    let index = 1;

    for (const { move } of chosen) {
      const child = board.clone();
      child.doMove(move);
      const outcome = this.searcher.search(child, {
        maxDepth: Math.max(1, depth - 1),
        moveTimeMs: perMoveMs,
        cancelled,
      });
      const score = -outcome.score;
      const pv = [move.toUcci(), ...outcome.pv.map((m) => m.toUcci())];

      this.infoEmitter.emit({
        index: index++,
        depth: Math.min(outcome.stats.depth + 1, depth),
        scoreCp: Math.round(score),
        isMate: Math.abs(score) > 90000,
        upperBound: false,
        lowerBound: false,
        pv,
      });

      if (score > bestScore) {
        bestScore = score;
        bestUcci = move.toUcci();
      }
    }

    return { bestMove: bestUcci, ponderMove: null, source: 'search' };
  }

  applyOptions(options: EngineOptions): Promise<void> {
    this.strengthDepth = depthFromOptions(options);
    return Promise.resolve();
  }

  stop(): void {
    this.stopRequested = true;
  }

  async dispose(): Promise<void> {
    this.isReady = false;
    this.searcher.clear();
  }
}

/**
 * 工厂：按引擎选项构造（供上层按用户设置的棋力重建引擎实例）。
 */
export function createBuiltinEngine(options?: EngineOptions): BuiltinEngine {
  const engine = new BuiltinEngine(10, 1500);
  if (options) {
    engine.applyOptions(options);
  }
  return engine;
}
