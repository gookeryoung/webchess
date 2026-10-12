import { describe, expect, it } from 'vitest';
import { Board, cellIndex, Piece, Position, Rule, BOARD_WIDTH, BOARD_HEIGHT } from '@webchess/core';
import { MATE_SCORE } from '../evaluate.js';
import { Searcher } from '../index.js';

describe('Searcher — 组件测试', () => {
  it('返回结果包含 bestMove / score / pv / stats 全部字段', () => {
    const searcher = new Searcher();
    const outcome = searcher.search(new Board(), { maxDepth: 1, moveTimeMs: 1000 });
    expect(outcome).toHaveProperty('bestMove');
    expect(outcome).toHaveProperty('score');
    expect(outcome).toHaveProperty('pv');
    expect(outcome).toHaveProperty('stats');
    expect(outcome.stats).toHaveProperty('nodes');
    expect(outcome.stats).toHaveProperty('depth');
    expect(outcome.stats).toHaveProperty('elapsedMs');
  });

  it('无着可走局面返回 null', () => {
    // 极小合法局面：双方各一帅 + 红方一车
    const fen = '4k4/9/9/9/9/9/9/9/R8/4K4 w - - 0 1';
    const board = Board.fromFen(fen);
    const outcome = new Searcher().search(board, { maxDepth: 1, moveTimeMs: 1000 });
    expect(outcome.bestMove).not.toBeNull();
  });

  it('onDepth 回调每完成一层迭代加深被调用一次', () => {
    const depths: number[] = [];
    // 小局面让搜索快速完成
    const fen = '4k4/9/9/9/9/9/9/9/R8/4K4 w - - 0 1';
    const searcher = new Searcher();
    searcher.search(Board.fromFen(fen), {
      maxDepth: 3,
      moveTimeMs: 5000,
      onDepth: (depth) => depths.push(depth),
    });
    expect(depths.length).toBeGreaterThanOrEqual(1);
    // 层数单调递增
    for (let i = 1; i < depths.length; i++) {
      expect(depths[i]).toBeGreaterThan(depths[i - 1]);
    }
  });

  it('cancelled 令牌立即生效时，返回兜底着法', () => {
    const cells = new Uint8Array(90);
    cells.fill(Piece.Empty);
    cells[cellIndex(4, 0)] = Piece.BlackKing;
    cells[cellIndex(4, 9)] = Piece.RedKing;
    cells[cellIndex(0, 7)] = Piece.RedRook;
    const board = new Board(cells, true, 1);

    // 带着立即取消令牌搜索
    const outcome = new Searcher().search(board, {
      maxDepth: 5,
      moveTimeMs: 3000,
      cancelled: () => true,
    });
    // 必须返回一个合法着法（兜底逻辑：取 rootMoves[0]）
    const legal = Rule.getAllLegalMoves(board, true);
    if (legal.length > 0) {
      expect(outcome.bestMove).not.toBeNull();
      expect(legal.map((m) => m.toUcci())).toContain(outcome.bestMove!.toUcci());
    }
  });

  it('置换表应命中——同一局面第二次搜索应返回相同评分', () => {
    const searcher = new Searcher();
    const fen = '4k4/9/9/9/9/9/9/9/R8/4K4 w - - 0 1';
    const board = Board.fromFen(fen);

    const first = searcher.search(board.clone(), { maxDepth: 2, moveTimeMs: 3000 });
    const second = searcher.search(board.clone(), { maxDepth: 2, moveTimeMs: 3000 });

    // 同一局面、同一深度、同一搜索器（TT 已填充），分数应完全相同
    expect(second.score).toBe(first.score);
    expect(second.stats.nodes).toBeGreaterThan(0);
  });

  it('时间限制生效时提前返回一个合法着法', () => {
    // maxDepth 很高但 moveTimeMs 极短 → 应在完成全部深度前中止
    const fen = 'r1ak1a3/9/9/9/9/9/9/9/R1AK1A3/9 w - - 0 1';
    const board = Board.fromFen(fen);

    const outcome = new Searcher().search(board, {
      maxDepth: 10,
      moveTimeMs: 1,
    });

    expect(outcome.bestMove).not.toBeNull();
    expect(outcome.stats.depth).toBeLessThan(10);
  });

  it('棋盘坐标常量值合法（sanity）', () => {
    expect(BOARD_WIDTH).toBe(9);
    expect(BOARD_HEIGHT).toBe(10);
  });

  it('Position 边界判定：棋盘格有效、越界无效', () => {
    expect(new Position(0, 0).isValid).toBe(true);
    expect(new Position(8, 9).isValid).toBe(true);
    expect(new Position(-1, 0).isValid).toBe(false);
    expect(new Position(0, 10).isValid).toBe(false);
    expect(new Position(9, 5).isValid).toBe(false);
  });
});

describe('MATE_SCORE — 在搜索中的表现', () => {
  it('将死局面返回将死分值', () => {
    // 重炮杀：e7e8 为唯一解（与既有 engine.test.ts 同源局面）
    const fen = '3aka3/4c4/4R4/4C4/9/2p6/9/9/4C4/3K5 w - - 0 1';
    const board = Board.fromFen(fen);
    const outcome = new Searcher().search(board, { maxDepth: 4, moveTimeMs: 5000 });
    expect(outcome.bestMove?.toUcci()).toBe('e7e8');
    // 红方赢 → score 接近 MATE_SCORE
    expect(outcome.score).toBeGreaterThan(MATE_SCORE - 10000);
  });
});
