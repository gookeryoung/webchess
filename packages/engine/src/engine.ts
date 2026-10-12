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
import { Searcher } from './search.js';

/**
 * 内置中国象棋引擎（实现内核的 EngineSession 契约）。
 *
 * 替代原 C# 的 Pikafish + UCI 进程方案（Web / 小程序无法启动子进程、无法加载 NNUE）。
 * 强度通过 ELO / Skill Level 到搜索深度上限的映射调节；映射结果作为
 * 「深度上限」参与 go 参数合成，保证显式 depth 请求与强度限制同时生效。
 */

/** 由棋力选项推导搜索深度上限；未配置棋力选项时返回 undefined（不限制）。 */
export function depthFromOptions(options: EngineOptions | undefined): number | undefined {
  if (options?.elo !== undefined && options.limitStrength === true) {
    // UCI_Elo 1280-3199 → 深度 2-10（新 PVS 引擎在 1000ms 内可稳定达到）。
    const depth = Math.round(((options.elo - 1280) / (3199 - 1280)) * 8) + 2;
    return Math.min(10, Math.max(2, depth));
  }

  if (options?.skillLevel !== undefined) {
    // Skill Level 0-20 → 深度 1-10。
    return Math.min(10, Math.max(1, Math.round((options.skillLevel / 20) * 9) + 1));
  }

  return undefined;
}

/** MultiPV 每路搜索的时限下限/上限（毫秒）。 */
const MULTIPV_TIME_MIN = 150;
const MULTIPV_TIME_MAX = 800;

export class BuiltinEngine implements EngineSession {
  private readonly searcher = new Searcher();
  private readonly infoEmitter = new Emitter<MultiPvInfo>();
  private readonly defaultDepth: number;
  private readonly defaultTimeMs: number;
  /** 由 applyOptions 下发的强度深度上限（undefined 表示未限制）。 */
  private strengthDepth: number | undefined;
  private stopRequested = false;

  isReady = true;

  constructor(defaultDepth = 10, defaultTimeMs = 1500) {
    this.defaultDepth = defaultDepth;
    this.defaultTimeMs = defaultTimeMs;
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
          depth: reachedDepth,
          scoreCp: Math.round(score),
          isMate: Math.abs(score) > 90000,
          upperBound: false,
          lowerBound: false,
          pv: pv.map((m) => m.toUcci()),
        });
      },
    });

    if (this.stopRequested && outcome.stats.depth === 0) {
      return { bestMove: null, ponderMove: null };
    }

    return {
      bestMove: outcome.bestMove?.toUcci() ?? null,
      ponderMove: outcome.pv[1]?.toUcci() ?? null,
    };
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
      return { bestMove: null, ponderMove: null };
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
        depth: outcome.stats.depth + 1,
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

    return { bestMove: bestUcci, ponderMove: null };
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
