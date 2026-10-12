import { describe, expect, it } from 'vitest';
import { Board, cellIndex, Move, Piece, Position } from '@webchess/core';
import { MATE_SCORE, captureScore, evaluate } from '../index.js';

describe('evaluate — 静态评估', () => {
  it('起始局面双方子力对称，评估分应接近 0', () => {
    const board = new Board();
    const score = evaluate(board);
    // 起始局面红方走子，双方子力完全相同 → 纯子力对称差为 0；
    // 位置偏好会给中心位置的红方棋子加少量分，但整体应在 ±100 以内。
    expect(score).toBeGreaterThan(-100);
    expect(score).toBeLessThan(100);
  });

  it('单方面多一车时评估应为大正值（红方视角）', () => {
    // 红方多一车：车 920，对称局面下应为 +920 左右。
    const fen = '4k4/9/9/9/9/9/9/9/R8/4K4 w - - 0 1';
    const board = Board.fromFen(fen);
    const score = evaluate(board);
    expect(score).toBeGreaterThan(500);
    expect(score).toBeLessThan(1100);
  });

  it('黑方多一车时评估应为负值（红方视角）', () => {
    // 局面：黑方 e0 帅 + a5 车；红方 e9 帅；轮到红走。
    const cells = new Uint8Array(90);
    cells.fill(Piece.Empty);
    cells[cellIndex(4, 0)] = Piece.BlackKing;
    cells[cellIndex(4, 9)] = Piece.RedKing;
    cells[cellIndex(0, 5)] = Piece.BlackRook;
    const board = new Board(cells, true, 1);
    const score = evaluate(board);
    expect(score).toBeLessThan(-500);
  });

  it('过河兵应有额外奖励', () => {
    const make = (pawnY: number) => {
      const cells = new Uint8Array(90);
      cells.fill(Piece.Empty);
      cells[cellIndex(4, 0)] = Piece.BlackKing;
      cells[cellIndex(4, 9)] = Piece.RedKing;
      cells[cellIndex(0, pawnY)] = Piece.RedPawn;
      return new Board(cells, true, 1);
    };

    // 红兵未过河（y=7，距对方底线 y=0 还有 7 格）vs 过河 5 格（y=4）
    const scoreNear = evaluate(make(7));
    const scoreFar = evaluate(make(4));
    // PawnAdvanceBonus[9-1-7] = PawnAdvanceBonus[1] = 0
    // PawnAdvanceBonus[9-1-4] = PawnAdvanceBonus[4] = 20
    // 差值至少 20
    expect(scoreFar - scoreNear).toBeGreaterThanOrEqual(10);
  });

  it('中心车比角落车应有更高位置奖励', () => {
    // 车放 y=5（离双方底线较远、centrality 生效）。红帅 e9、黑帅 b0 避免帅对脸。
    const make = (rookX: number) => {
      const cells = new Uint8Array(90);
      cells.fill(Piece.Empty);
      cells[cellIndex(1, 0)] = Piece.BlackKing;
      cells[cellIndex(4, 9)] = Piece.RedKing;
      cells[cellIndex(rookX, 5)] = Piece.RedRook;
      return new Board(cells, true, 1);
    };

    // 车在 e5（中心 x=4）vs a5（角落 x=0）
    const scoreCenter = evaluate(make(4));
    const scoreEdge = evaluate(make(0));
    // centrality 在中心位置更高 → 车占中路应加分更多
    expect(scoreCenter).toBeGreaterThan(scoreEdge);
  });

  it('返回值随走子方翻转为相反数', () => {
    const fenRed = '4k4/9/9/9/9/9/9/9/R8/4K4 w - - 0 1';
    const fenBlack = '4k4/9/9/9/9/9/9/9/R8/4K4 b - - 0 1';
    const boardRed = Board.fromFen(fenRed);
    const boardBlack = Board.fromFen(fenBlack);
    expect(evaluate(boardRed)).toBeCloseTo(-evaluate(boardBlack), 0);
  });
});

describe('captureScore — MVV-LVA 启发式', () => {
  it('红车吃黑卒应返回正分（卒×10 - 车）', () => {
    const cells = new Uint8Array(90);
    cells.fill(Piece.Empty);
    cells[cellIndex(4, 0)] = Piece.BlackKing;
    cells[cellIndex(4, 9)] = Piece.RedKing;
    cells[cellIndex(0, 4)] = Piece.RedRook;
    cells[cellIndex(1, 4)] = Piece.BlackPawn;
    const board = new Board(cells, true, 1);
    const move = new Move(new Position(0, 4), new Position(1, 4));
    const score = captureScore(board, move);
    // 卒 100 × 10 - 车 920 = 80
    expect(score).toBe(80);
  });

  it('红卒吃黑车应返回大正分（车×10 - 卒）', () => {
    const cells = new Uint8Array(90);
    cells.fill(Piece.Empty);
    cells[cellIndex(4, 0)] = Piece.BlackKing;
    cells[cellIndex(4, 9)] = Piece.RedKing;
    cells[cellIndex(0, 4)] = Piece.RedPawn;
    cells[cellIndex(1, 4)] = Piece.BlackRook;
    const board = new Board(cells, true, 1);
    const move = new Move(new Position(0, 4), new Position(1, 4));
    const score = captureScore(board, move);
    // 车 920 × 10 - 卒 100 = 9100
    expect(score).toBe(9100);
  });

  it('不吃子时返回 0', () => {
    const cells = new Uint8Array(90);
    cells.fill(Piece.Empty);
    cells[cellIndex(4, 0)] = Piece.BlackKing;
    cells[cellIndex(4, 9)] = Piece.RedKing;
    cells[cellIndex(0, 4)] = Piece.RedRook;
    const board = new Board(cells, true, 1);
    const move = new Move(new Position(0, 4), new Position(1, 4));
    expect(captureScore(board, move)).toBe(0);
  });

  it('非法子力也返回 0', () => {
    const cells = new Uint8Array(90);
    cells.fill(Piece.Empty);
    cells[cellIndex(4, 0)] = Piece.BlackKing;
    cells[cellIndex(4, 9)] = Piece.RedKing;
    const board = new Board(cells, true, 1);
    const move = new Move(new Position(0, 0), new Position(1, 0));
    expect(captureScore(board, move)).toBe(0);
  });
});

describe('MATE_SCORE 常量', () => {
  it('应大于任何子力组合的理论最大值', () => {
    // 最大子力价值 ≈ 双方各 14 枚棋子 PieceValue 总和 / 2 ≈ 14000 级别
    expect(MATE_SCORE).toBeGreaterThan(50000);
    expect(MATE_SCORE).toBeLessThan(1_000_000);
  });
});
