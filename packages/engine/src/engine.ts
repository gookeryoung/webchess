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
import { captureScore } from './evaluate.js';

/**
 * 内置中国象棋引擎（实现内核的 EngineSession 契约）。
 *
 * 替代原 C# 的 Pikafish + UCI 进程方案（Web / 小程序无法启动子进程、无法加载 NNUE）。
 * 强度通过搜索深度与棋力等级映射调节，接口与上层完全解耦。
 */

/** 由棋力选项推导搜索深度。 */
function depthFromOptions(options: EngineOptions | undefined, fallback: number): number {
  if (options?.elo !== undefined && options.limitStrength === true) {
    // UCI_Elo 1280-3199 → 深度 2-8。
    const depth = Math.round((options.elo - 1280) / 274) + 2;
    return Math.min(8, Math.max(2, depth));
  }

  if (options?.skillLevel !== undefined) {
    // Skill Level 0-20 → 深度 1-8。
    return Math.min(8, Math.max(1, Math.round(options.skillLevel / 3) + 1));
  }

  return fallback;
}

export class BuiltinEngine implements EngineSession {
  private readonly searcher = new Searcher();
  private readonly infoEmitter = new Emitter<MultiPvInfo>();
  private readonly defaultDepth: number;
  private readonly defaultTimeMs: number;
  private stopRequested = false;

  isReady = true;

  constructor(defaultDepth = 4, defaultTimeMs = 1500) {
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
    this.searcher.clear();

    const depth = params.depth ?? this.defaultDepth;
    const moveTimeMs = params.moveTimeMs ?? (params.infinite === true ? 60000 : this.defaultTimeMs);
    const multiPv = params.multiPv ?? 1;
    const cancelled = () => this.stopRequested || token?.cancelled === true;

    if (multiPv > 1) {
      return this.searchMultiPv(board, depth, multiPv, cancelled);
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

  /** MultiPV：对若干候选着法分别搜索并逐路汇报。 */
  private searchMultiPv(
    board: Board,
    depth: number,
    multiPv: number,
    cancelled: () => boolean,
  ): SearchResult {
    const candidates = Rule.getAllLegalMoves(board, board.redToMove)
      .sort((a, b) => captureScore(board, b) - captureScore(board, a))
      .slice(0, multiPv);

    let bestUcci: string | null = null;
    let bestScore = -Infinity;
    let index = 1;

    for (const move of candidates) {
      const child = board.clone();
      child.doMove(move);
      const negamax = new Searcher();
      const outcome = negamax.search(child, {
        maxDepth: Math.max(1, depth - 1),
        moveTimeMs: 800,
        cancelled,
      });
      const score = -outcome.score;
      const pv = [move.toUcci(), ...outcome.pv.map((m) => m.toUcci())];

      this.infoEmitter.emit({
        index: index++,
        depth,
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
    void depthFromOptions(options, this.defaultDepth);
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
  const depth = depthFromOptions(options, 4);
  return new BuiltinEngine(depth, 1500);
}
