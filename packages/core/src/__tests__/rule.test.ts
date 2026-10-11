import { describe, expect, it } from 'vitest';
import { Board } from '../board.js';
import { Move } from '../move.js';
import { Piece } from '../piece.js';
import { Position } from '../position.js';
import { Rule } from '../rule.js';

/** 仅含双方将帅（不同纵线，避免白脸将干扰）的空局面。 */
function emptyBoard(): Board {
  return Board.fromFen('3k5/9/9/9/9/9/9/9/9/4K4 w - - 0 1');
}

function toTargets(moves: Move[]): Set<string> {
  return new Set(moves.map((m) => `${m.to.x},${m.to.y}`));
}

function hasMove(moves: Move[], from: Position, to: Position): boolean {
  return moves.some((m) => m.from.equals(from) && m.to.equals(to));
}

describe('走法生成', () => {
  it('马被蹩腿时减少两个落点', () => {
    const board = emptyBoard();
    board.setPiece(4, 4, Piece.RedKnight);
    expect(Rule.getLegalMoves(board, new Position(4, 4))).toHaveLength(8);

    // 在 (5,4) 放置车辆蹩马腿：(6,3) 与 (6,5) 两方向不可达。
    board.setPiece(5, 4, Piece.BlackRook);
    const hobbled = Rule.getLegalMoves(board, new Position(4, 4));
    expect(hobbled).toHaveLength(6);
    expect(hasMove(hobbled, new Position(4, 4), new Position(6, 3))).toBe(false);
    expect(hasMove(hobbled, new Position(4, 4), new Position(6, 5))).toBe(false);
  });

  it('象被塞眼时不能过河', () => {
    const board = emptyBoard();
    board.setPiece(2, 9, Piece.RedBishop);
    expect(toTargets(Rule.getLegalMoves(board, new Position(2, 9)))).toEqual(
      new Set(['0,7', '4,7']),
    );

    board.setPiece(1, 8, Piece.BlackPawn);
    expect(toTargets(Rule.getLegalMoves(board, new Position(2, 9)))).toEqual(new Set(['4,7']));
  });

  it('兵未过河只能前进', () => {
    const board = emptyBoard();
    board.setPiece(4, 6, Piece.RedPawn);
    expect(toTargets(Rule.getLegalMoves(board, new Position(4, 6)))).toEqual(new Set(['4,5']));
  });

  it('兵过河后可前进与平移', () => {
    const board = emptyBoard();
    board.setPiece(4, 3, Piece.RedPawn);
    expect(toTargets(Rule.getLegalMoves(board, new Position(4, 3)))).toEqual(
      new Set(['4,2', '3,3', '5,3']),
    );
  });

  it('卒到底线只能平移', () => {
    const board = emptyBoard();
    board.setPiece(0, 9, Piece.BlackPawn);
    expect(toTargets(Rule.getLegalMoves(board, new Position(0, 9)))).toEqual(new Set(['1,9']));
  });

  it('帅限于九宫', () => {
    // 空局面将帅异线；红帅移到 (3,9) 会与黑将同线照面，被合法着过滤排除。
    expect(toTargets(Rule.getLegalMoves(emptyBoard(), new Position(4, 9)))).toEqual(
      new Set(['5,9', '4,8']),
    );
  });

  it('遮挡子平移离开纵线造成白脸将，判为非法', () => {
    const board = Board.fromFen('4k4/9/9/9/9/9/9/9/9/4K4 w - - 0 1');
    board.setPiece(4, 5, Piece.RedRook);
    const moves = Rule.getLegalMoves(board, new Position(4, 5));
    expect(hasMove(moves, new Position(4, 5), new Position(4, 6))).toBe(true);
    expect(hasMove(moves, new Position(4, 5), new Position(3, 5))).toBe(false);
    expect(hasMove(moves, new Position(4, 5), new Position(5, 5))).toBe(false);
  });
});

describe('将军与终局判定', () => {
  it('同纵线车将军，且遮挡可解除', () => {
    const board = Board.fromFen('3kr4/9/9/9/9/9/9/9/9/4K4 w - - 0 1');
    expect(Rule.isInCheck(board, true)).toBe(true);
    board.setPiece(4, 5, Piece.RedAdvisor);
    expect(Rule.isInCheck(board, true)).toBe(false);
  });

  it('马将军遵守蹩马腿', () => {
    const board = Board.fromFen('4k4/9/9/9/9/9/9/3n5/9/4K4 w - - 0 1');
    expect(Rule.isInCheck(board, true)).toBe(true);
    board.setPiece(3, 8, Piece.RedAdvisor);
    expect(Rule.isInCheck(board, true)).toBe(false);
  });

  it('双车错将死', () => {
    const board = Board.fromFen('3rrk3/9/9/9/9/9/9/9/9/3K5 w - - 0 1');
    expect(Rule.isInCheck(board, true)).toBe(true);
    expect(Rule.isCheckmate(board, true)).toBe(true);
    expect(Rule.isStalemate(board, true)).toBe(false);
  });

  it('双车困毙（未被将但无着）', () => {
    const board = Board.fromFen('3k5/9/9/9/9/9/9/9/3r1r3/4K4 w - - 0 1');
    expect(Rule.isInCheck(board, true)).toBe(false);
    expect(Rule.isStalemate(board, true)).toBe(true);
    expect(Rule.isCheckmate(board, true)).toBe(false);
  });

  it('起始局面无将军无照面', () => {
    const board = new Board();
    expect(Rule.isInCheck(board, true)).toBe(false);
    expect(Rule.isInCheck(board, false)).toBe(false);
    expect(Rule.isKingsFacing(board)).toBe(false);
    expect(Rule.isCheckmate(board, true)).toBe(false);
    expect(Rule.isStalemate(board, true)).toBe(false);
  });

  it('isLegalMove 拒绝蹩腿马、接受炮二平五', () => {
    const board = new Board();
    expect(Rule.isLegalMove(board, new Move(new Position(1, 9), new Position(2, 7)))).toBe(true);
    expect(Rule.isLegalMove(board, new Move(new Position(1, 9), new Position(3, 8)))).toBe(false);
    expect(Rule.isLegalMove(board, new Move(new Position(7, 7), new Position(4, 7)))).toBe(true);
  });
});
