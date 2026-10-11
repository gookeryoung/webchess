import { describe, expect, it } from 'vitest';
import { Board } from '../board.js';
import { Fen, FenFormatException } from '../fen.js';
import { Move } from '../move.js';

describe('FEN 往返', () => {
  it('起始 FEN 编解码稳定', () => {
    const board = Board.fromFen(Fen.initial);
    expect(board.toFen()).toBe(Fen.initial);
  });

  it('自定义局面往返稳定', () => {
    const board = new Board();
    expect(board.doMove(Move.fromUcci('h2e2')!)).toBe(true);
    const fen = board.toFen();
    expect(Board.fromFen(fen).toFen()).toBe(fen);
    expect(Move.fromUcci('h2e2')!.toUcci()).toBe('h2e2');
  });

  it('两字段短格式使用默认计数', () => {
    const board = Board.fromFen(
      'rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR w',
    );
    expect(board.redToMove).toBe(true);
    expect(board.rounds).toBe(1);
  });

  it('走子方别名 r 与 w 均为红方', () => {
    expect(Board.fromFen(Fen.initial.replace(' w ', ' r ')).redToMove).toBe(true);
    expect(Board.fromFen(Fen.initial.replace(' w ', ' b ')).redToMove).toBe(false);
  });

  it('doMove 翻边并累加回合', () => {
    const board = new Board();
    expect(board.doMove(Move.fromUcci('h2e2')!)).toBe(true);
    expect(board.redToMove).toBe(false);
    expect(board.rounds).toBe(2);
  });
});

describe('非法 FEN 报出字段名', () => {
  const cases: Array<[string, string]> = [
    ['', '字段数'],
    ['rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR w w', '字段数'],
    ['rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9 w - - 0 1', '棋盘'],
    ['rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR/RNBAKABNR w - - 0 1', '棋盘'],
    ['rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNRX w - - 0 1', '棋盘'],
    ['rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKAB w - - 0 1', '棋盘'],
    ['rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBA1ABNR w - - 0 1', '棋盘'],
    ['rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/rnba1abnr w - - 0 1', '棋盘'],
    ['knbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR w - - 0 1', '棋盘'],
    ['rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNQ w - - 0 1', '棋盘'],
    ['rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR q - - 0 1', '走子方'],
    ['rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR w - - 0 abc', '回合数'],
    ['rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR w - - 0 0', '回合数'],
  ];

  it.each(cases)('%s 应报出字段「%s」', (fen, expectedField) => {
    expect(() => Board.fromFen(fen)).toThrow(FenFormatException);
    try {
      Board.fromFen(fen);
    } catch (error) {
      expect((error as FenFormatException).fieldName).toBe(expectedField);
    }
  });
});
