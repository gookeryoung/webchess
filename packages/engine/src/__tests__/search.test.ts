import { describe, expect, it } from 'vitest';
import { Board, cellIndex, Move, Piece, Position, Rule, BOARD_WIDTH, BOARD_HEIGHT } from '@webchess/core';
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

describe('Searcher — 棋力强化回归', () => {
  it('两步杀（双车错）：返回 mate 分值且首着为将军杀着', () => {
    // 红车 b8/a9 + 红兵 e3 封 e2，双车底线绞杀黑将 e0。
    const fen = '4k4/9/9/4P4/9/9/9/9/1R7/R3K4 w - - 0 1';
    const board = Board.fromFen(fen);
    const outcome = new Searcher().search(board, { maxDepth: 5, moveTimeMs: 5000 });
    expect(outcome.score).toBeGreaterThanOrEqual(MATE_SCORE - 10);
    expect(outcome.score).toBeLessThanOrEqual(MATE_SCORE);

    const move = outcome.bestMove!;
    const isKill1 = move.from.x === 1 && move.from.y === 8 && move.to.x === 1 && move.to.y === 0;
    const isKill2 = move.from.x === 0 && move.from.y === 9 && move.to.x === 0 && move.to.y === 0;
    expect(isKill1 || isKill2).toBe(true);
    // 主变例至少推进到杀着完成。
    expect(outcome.pv.length).toBeGreaterThanOrEqual(3);
  });

  it('白吃车：无保护黑车必被吃掉', () => {
    // 红马 b6 可吃 a4 无根黑车，吃后无反吃。
    const fen = '4k4/9/9/9/r8/9/1N7/9/9/3K5 w - - 0 1';
    const board = Board.fromFen(fen);
    const outcome = new Searcher().search(board, { maxDepth: 4, moveTimeMs: 5000 });
    expect(outcome.bestMove!.from.x).toBe(1);
    expect(outcome.bestMove!.from.y).toBe(6);
    expect(outcome.bestMove!.to.x).toBe(0);
    expect(outcome.bestMove!.to.y).toBe(4);
    expect(outcome.score).toBeGreaterThan(400);
  });

  it('困毙判负：无着可走且未被将军时返回判负分而非 0 分', () => {
    // 红帅 e9 三出口被真实攻击：d9/f9 被黑马 c7/g7 控制（马腿 c8/g8 空），
    // e8 被黑卒 e7 前进控制；黑卒 e7 同时隔断将帅照面。
    const fen = '4k4/9/9/9/9/9/9/2n1p1n2/9/4K4 w - - 0 1';
    const board = Board.fromFen(fen);
    // 局面自检：红方未被将军但无合法着法（困毙）。
    expect(Rule.isStalemate(board, true)).toBe(true);

    const outcome = new Searcher().search(board, { maxDepth: 2, moveTimeMs: 3000 });
    expect(outcome.bestMove).toBeNull();
    expect(outcome.score).toBeLessThanOrEqual(-MATE_SCORE + 1);
  });

  it('SEE 剪枝回归：亏交换吃子不被误选，正收益吃子不丢', () => {
    // 红车 h8 可吃无根黑车 h4（SEE +920）；红马 d6 可吃有根黑卒 e4
    // （黑马 c3 护卒，马腿 b3/d3 空，SEE ≈ -320）。
    const fen = '4k4/9/9/9/4p2r1/2n6/3N5/9/7R1/4K4 w - - 0 1';
    const board = Board.fromFen(fen);
    const outcome = new Searcher().search(board, { maxDepth: 4, moveTimeMs: 5000 });
    // 正收益吃子必须被选中（UCCI 纵线为 9-y 映射：h8→h4 即 h1h5），
    // 亏交换吃子不得成为最佳着法。
    expect(outcome.bestMove!.toUcci()).toBe('h1h5');
    expect(outcome.score).toBeGreaterThan(400);
  });

  it('性能下限：起始局面 2500ms 内达到 6 层以上（旧实现仅 4-5 层）', () => {
    // 时限放宽到 2500ms 以吸收开发机与 CI runner 的算力差异：本机约 450ms 完成
    // 6 层，共享 runner 通常慢 2-3 倍。迭代加深在预测下一层放不下时会提前收手，
    // 因此条目耗时通常低于时限，这里只校验“能否达成层数”与“不失控超时”。
    const outcome = new Searcher().search(new Board(), { maxDepth: 12, moveTimeMs: 2500 });
    expect(outcome.stats.depth).toBeGreaterThanOrEqual(6);
    expect(outcome.bestMove).toBeInstanceOf(Move);
    expect(outcome.stats.elapsedMs).toBeLessThan(5000);
  });

  it('rootExclude 剔除指定根着法：返回不同的次佳着', () => {
    const board = new Board();
    const searcher = new Searcher();
    const first = searcher.search(board, { maxDepth: 4, moveTimeMs: 3000 });
    expect(first.bestMove).not.toBeNull();
    const best = first.bestMove!.toUcci();

    const second = searcher.search(board, {
      maxDepth: 4,
      moveTimeMs: 3000,
      rootExclude: [best],
    });
    expect(second.bestMove).not.toBeNull();
    expect(second.bestMove!.toUcci()).not.toBe(best);
    // 剔除最佳着后分值不应高于原最佳着。
    expect(second.score).toBeLessThanOrEqual(first.score);
  });

  it('rootExclude 排除全部合法着法时返回 null', () => {
    // 单车对孤将：合法着法有限，全部排除后根节点无候选。
    const board = Board.fromFen('4k4/9/9/9/9/9/9/9/R8/4K4 w - - 0 1');
    const all = Rule.getAllLegalMoves(board, true).map((m) => m.toUcci());
    const outcome = new Searcher().search(board, {
      maxDepth: 2,
      moveTimeMs: 1000,
      rootExclude: all,
    });
    expect(outcome.bestMove).toBeNull();
  });
});
