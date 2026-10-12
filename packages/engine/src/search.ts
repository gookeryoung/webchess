import { Board, Move, Rule } from '@webchess/core';
import { MATE_SCORE, captureScore, evaluate } from './evaluate.js';

/**
 * alpha-beta 搜索引擎（迭代加深 + 置换表 + 吃子静态搜索）。
 *
 * 纯 TypeScript，零平台依赖：既可在 Web Worker 中运行，也可在小程序 Worker 中运行。
 */

/** 置换表条目。 */
interface TTEntry {
  depth: number;
  score: number;
  flag: 0 | 1 | 2; // 0 精确、1 下界、2 上界
  best: Move | null;
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

const DEFAULT_DEPTH = 4;
const DEFAULT_TIME_MS = 1500;

/** 时间源：优先 performance.now，回退 Date.now（小程序兼容）。 */
function now(): number {
  const perf = (globalThis as unknown as { performance?: { now(): number } }).performance;
  return typeof perf?.now === 'function' ? perf.now() : Date.now();
}

export class Searcher {
  private readonly tt = new Map<string, TTEntry>();
  private nodes = 0;
  private deadline = Infinity;
  private cancelled: () => boolean = () => false;
  private aborted = false;

  /** 执行搜索，返回最佳着法与主变例。 */
  search(board: Board, params: SearchParams = {}): SearchOutcome {
    const maxDepth = params.maxDepth ?? DEFAULT_DEPTH;
    const moveTimeMs = params.moveTimeMs ?? DEFAULT_TIME_MS;
    this.nodes = 0;
    this.aborted = false;
    this.cancelled = params.cancelled ?? (() => false);
    const start = now();
    this.deadline = start + moveTimeMs;

    let bestMove: Move | null = null;
    let bestScore = -Infinity;
    let bestPv: Move[] = [];
    let reachedDepth = 0;

    const rootMoves = Rule.getAllLegalMoves(board, board.redToMove);
    if (rootMoves.length === 0) {
      return {
        bestMove: null,
        score: 0,
        pv: [],
        stats: { nodes: 0, depth: 0, elapsedMs: 0 },
      };
    }

    for (let depth = 1; depth <= maxDepth; depth++) {
      const result = this.searchRoot(board, rootMoves, depth, bestMove);
      if (this.aborted) {
        break;
      }

      bestMove = result.move;
      bestScore = result.score;
      bestPv = result.pv;
      reachedDepth = depth;
      params.onDepth?.(depth, bestScore, bestPv);

      // 找到必胜杀棋则提前结束。
      if (Math.abs(bestScore) > MATE_SCORE - 100) {
        break;
      }

      if (now() > this.deadline) {
        break;
      }
    }

    // 迭代加深被中断时，至少要有一个可走的着法。
    if (bestMove === null) {
      bestMove = rootMoves[0];
    }

    return {
      bestMove,
      score: bestScore === -Infinity ? evaluate(board) : bestScore,
      pv: bestPv,
      stats: { nodes: this.nodes, depth: reachedDepth, elapsedMs: now() - start },
    };
  }

  /**
   * 根节点搜索：逐着打分并维护主变例。
   * 迭代加深各层把上一轮最佳着法排在首位（PV 着法优先），
   * 使 alpha 剪枝更早发生——此前排序键漏掉了上轮最佳，与注释不符。
   */
  private searchRoot(
    board: Board,
    rootMoves: Move[],
    depth: number,
    prevBest: Move | null,
  ): { move: Move; score: number; pv: Move[] } {
    const ordered = [...rootMoves].sort((a, b) => {
      const aPv = prevBest !== null && a.equals(prevBest) ? 1_000_000 : 0;
      const bPv = prevBest !== null && b.equals(prevBest) ? 1_000_000 : 0;
      return bPv + captureScore(board, b) - (aPv + captureScore(board, a));
    });

    let alpha = -Infinity;
    let best = ordered[0];
    let bestPv: Move[] = [best];

    for (const move of ordered) {
      const child = board.clone();
      child.doMove(move);
      const score = -this.negamax(child, depth - 1, -Infinity, -alpha, 1);
      if (this.aborted) {
        break;
      }

      if (score > alpha) {
        alpha = score;
        best = move;
        bestPv = [move, ...this.extractPv(child, depth - 1)];
      }
    }

    return { move: best, score: alpha, pv: bestPv };
  }

  /** negamax + alpha-beta 剪枝 + 置换表。 */
  private negamax(board: Board, depth: number, alpha: number, beta: number, ply: number): number {
    if (this.aborted) {
      return 0;
    }

    // 时限检查每 256 节点一次：粒度过粗会显著超出时限（人机对局响应变慢）。
    if (this.cancelled() || (this.nodes & 255) === 0 && now() > this.deadline) {
      this.aborted = true;
      return 0;
    }

    this.nodes++;

    const moves = Rule.getAllLegalMoves(board, board.redToMove);
    if (moves.length === 0) {
      // 无着可走：被将军即为将死（负值），否则困毙记 0。
      return Rule.isInCheck(board, board.redToMove) ? -MATE_SCORE + ply : 0;
    }

    if (depth <= 0) {
      return this.quiescence(board, alpha, beta, ply, 0);
    }

    const key = board.toFen();
    const cached = this.tt.get(key);
    if (cached !== undefined && cached.depth >= depth) {
      if (cached.flag === 0) return cached.score;
      if (cached.flag === 1 && cached.score > alpha) alpha = cached.score;
      if (cached.flag === 2 && cached.score < beta) beta = cached.score;
      if (alpha >= beta) return cached.score;
    }

    const ordered = this.orderMoves(board, moves, cached?.best ?? null);
    const originalAlpha = alpha;
    let bestScore = -Infinity;
    let bestMove: Move | null = null;

    for (const move of ordered) {
      const child = board.clone();
      child.doMove(move);
      const score = -this.negamax(child, depth - 1, -beta, -alpha, ply + 1);
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
        break;
      }
    }

    const flag: 0 | 1 | 2 =
      bestScore <= originalAlpha ? 2 : bestScore >= beta ? 1 : 0;
    this.tt.set(key, { depth, score: bestScore, flag, best: bestMove });
    return bestScore;
  }

  /** 静态搜索：只展开吃子，消除地平线效应。 */
  private quiescence(
    board: Board,
    alpha: number,
    beta: number,
    ply: number,
    qDepth: number,
  ): number {
    this.nodes++;
    const stand = evaluate(board);
    if (qDepth >= 4 || this.aborted) {
      return stand;
    }

    if (stand >= beta) {
      return beta;
    }

    if (stand > alpha) {
      alpha = stand;
    }

    const captures = Rule.getAllLegalMoves(board, board.redToMove)
      .filter((m) => captureScore(board, m) > 0)
      .sort((a, b) => captureScore(board, b) - captureScore(board, a));

    for (const move of captures) {
      const child = board.clone();
      child.doMove(move);
      const score = -this.quiescence(child, -beta, -alpha, ply + 1, qDepth + 1);
      if (this.aborted) {
        return alpha;
      }

      if (score >= beta) {
        return beta;
      }

      if (score > alpha) {
        alpha = score;
      }
    }

    return alpha;
  }

  /** 着法排序：置换表着法 → 吃子 → 其余。 */
  private orderMoves(board: Board, moves: Move[], ttMove: Move | null): Move[] {
    return [...moves].sort((a, b) => {
      const aTt = ttMove !== null && a.equals(ttMove) ? 1_000_000 : 0;
      const bTt = ttMove !== null && b.equals(ttMove) ? 1_000_000 : 0;
      return bTt + captureScore(board, b) - (aTt + captureScore(board, a));
    });
  }

  /** 从置换表中回溯主变例。 */
  private extractPv(board: Board, depth: number): Move[] {
    const pv: Move[] = [];
    let cursor = board;
    for (let i = 0; i < depth; i++) {
      const entry = this.tt.get(cursor.toFen());
      if (entry === undefined || entry.best === null) {
        break;
      }

      pv.push(entry.best);
      cursor = cursor.clone();
      cursor.doMove(entry.best);
    }

    return pv;
  }

  /** 清空置换表。 */
  clear(): void {
    this.tt.clear();
  }
}
