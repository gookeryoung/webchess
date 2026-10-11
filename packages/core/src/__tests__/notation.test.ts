import { describe, expect, it } from 'vitest';
import { Board } from '../board.js';
import { ChineseNotation } from '../chineseNotation.js';
import { Move } from '../move.js';
import { Piece } from '../piece.js';
import { Position } from '../position.js';

function note(board: Board, from: Position, to: Position): string {
  return ChineseNotation.toChinese(board, new Move(from, to));
}

describe('中文纵线记谱', () => {
  it('起始局面炮二平五 / 炮八平五', () => {
    const board = new Board();
    expect(note(board, new Position(7, 7), new Position(4, 7))).toBe('炮二平五');
    expect(note(board, new Position(1, 7), new Position(4, 7))).toBe('炮八平五');
  });

  it('马八进七取目标纵线', () => {
    expect(note(new Board(), new Position(1, 9), new Position(2, 7))).toBe('马八进七');
  });

  it('帅将进退取步数', () => {
    const board = new Board();
    expect(note(board, new Position(4, 9), new Position(4, 8))).toBe('帅五进一');
    expect(note(board, new Position(4, 0), new Position(4, 1))).toBe('将5进1');
  });

  it('车进退取步数', () => {
    const board = new Board();
    expect(note(board, new Position(0, 9), new Position(0, 7))).toBe('车九进二');
    const empty = Board.fromFen('3k5/9/9/9/9/9/9/9/9/4K4 w - - 0 1');
    empty.setPiece(0, 3, Piece.BlackRook);
    expect(note(empty, new Position(0, 3), new Position(0, 1))).toBe('车1退2');
  });

  it('黑方使用阿拉伯数字', () => {
    expect(note(new Board(), new Position(1, 2), new Position(4, 2))).toBe('炮2平5');
  });

  it('同线两炮用前/后消歧', () => {
    const board = Board.fromFen('3k5/9/9/9/9/9/9/9/9/4K4 w - - 0 1');
    board.setPiece(1, 2, Piece.BlackCannon);
    board.setPiece(1, 6, Piece.BlackCannon);
    expect(note(board, new Position(1, 6), new Position(4, 6))).toBe('前炮平5');
    expect(note(board, new Position(1, 2), new Position(4, 2))).toBe('后炮平5');
  });

  it('同线两兵用前/后消歧', () => {
    const board = Board.fromFen('3k5/9/9/9/9/9/9/9/9/4K4 w - - 0 1');
    board.setPiece(0, 3, Piece.RedPawn);
    board.setPiece(0, 6, Piece.RedPawn);
    expect(note(board, new Position(0, 3), new Position(1, 3))).toBe('前兵平八');
    expect(note(board, new Position(0, 6), new Position(1, 6))).toBe('后兵平八');
  });

  it('同线三兵用前/中/后', () => {
    const board = Board.fromFen('3k5/9/9/9/9/9/9/9/9/4K4 w - - 0 1');
    board.setPiece(0, 2, Piece.RedPawn);
    board.setPiece(0, 4, Piece.RedPawn);
    board.setPiece(0, 6, Piece.RedPawn);
    expect(note(board, new Position(0, 2), new Position(1, 2))).toBe('前兵平八');
    expect(note(board, new Position(0, 4), new Position(1, 4))).toBe('中兵平八');
    expect(note(board, new Position(0, 6), new Position(1, 6))).toBe('后兵平八');
  });

  it('同线两车用前/后消歧', () => {
    const board = Board.fromFen('3k5/9/9/9/9/9/9/9/9/4K4 w - - 0 1');
    board.setPiece(0, 5, Piece.RedRook);
    board.setPiece(0, 8, Piece.RedRook);
    expect(note(board, new Position(0, 5), new Position(1, 5))).toBe('前车平八');
    expect(note(board, new Position(0, 8), new Position(1, 8))).toBe('后车平八');
  });

  it('仕相从不加前缀', () => {
    const board = new Board();
    expect(note(board, new Position(3, 9), new Position(4, 8))).toBe('仕六进五');
    expect(note(board, new Position(5, 9), new Position(4, 8))).toBe('仕四进五');
    expect(note(board, new Position(2, 9), new Position(4, 7))).toBe('相七进五');
  });
});
