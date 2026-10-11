import { describe, expect, it } from 'vitest';
import { Board } from '../board.js';
import { Move } from '../move.js';
import { Piece } from '../piece.js';
import { Position } from '../position.js';

describe('Board 基本语义', () => {
  it('起始局面棋子数与将帅位置正确', () => {
    const board = new Board();
    let count = 0;
    for (let y = 0; y < Board.Height; y++) {
      for (let x = 0; x < Board.Width; x++) {
        if (Piece.isValid(board.getPiece(x, y))) {
          count++;
        }
      }
    }

    expect(count).toBe(32);
    expect(board.findKing(true)!.equals(new Position(4, 9))).toBe(true);
    expect(board.findKing(false)!.equals(new Position(4, 0))).toBe(true);
  });

  it('越界读取返回 -1', () => {
    const board = new Board();
    expect(board.getPiece(-1, 0)).toBe(-1);
    expect(board.getPiece(0, 10)).toBe(-1);
  });

  it('clone 为深拷贝，互不影响', () => {
    const board = new Board();
    const before = board.toFen();
    const copy = board.clone();
    copy.doMove(Move.fromUcci('h2e2')!);
    expect(board.toFen()).toBe(before);
    expect(copy.toFen()).not.toBe(before);
  });

  it('doMove 起点无子时返回 false 且局面不变', () => {
    const board = new Board();
    const before = board.toFen();
    expect(board.doMove(new Move(new Position(4, 5), new Position(4, 4)))).toBe(false);
    expect(board.toFen()).toBe(before);
  });

  it('setPiece 拒绝非法棋子值与越界坐标', () => {
    const board = new Board();
    expect(board.setPiece(0, 0, 99)).toBe(false);
    expect(board.setPiece(-1, 0, Piece.RedRook)).toBe(false);
    expect(board.setPiece(0, 0, Piece.RedRook)).toBe(true);
    expect(board.getPiece(0, 0)).toBe(Piece.RedRook);
  });

  it('Position 具备值相等语义', () => {
    expect(new Position(1, 2).equals(new Position(1, 2))).toBe(true);
    expect(new Position(1, 2).equals(new Position(2, 1))).toBe(false);
    expect(new Position(1, 2).equals(null)).toBe(false);
    expect(new Position(1, 2).isValid).toBe(true);
    expect(new Position(9, 0).isValid).toBe(false);
  });
});
