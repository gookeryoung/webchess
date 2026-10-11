import { describe, expect, it } from 'vitest';
import { Board } from '../board.js';
import { Rule } from '../rule.js';

/**
 * 起始局面 perft 对拍（移植自 SuperChess tests/Core.Tests/PerftTests.cs）。
 * 参考值 44 / 1920 / 79666 为业界公认数值，是走法生成器正确性的最强判据。
 */
function perft(board: Board, depth: number): number {
  const moves = Rule.getAllLegalMoves(board, board.redToMove);
  if (depth === 1) {
    return moves.length;
  }

  let nodes = 0;
  for (const move of moves) {
    const next = board.clone();
    next.doMove(move);
    nodes += perft(next, depth - 1);
  }

  return nodes;
}

describe('perft（起始局面）', () => {
  it.each([
    [1, 44],
    [2, 1920],
    [3, 79666],
  ])('depth %i 应等于 %i', (depth, expected) => {
    expect(perft(new Board(), depth)).toBe(expected);
  });
});
