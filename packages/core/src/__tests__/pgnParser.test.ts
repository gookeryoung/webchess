import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { Fen } from '../fen.js';
import { Move } from '../move.js';
import { ManualFormatException } from '../manual/manualDocument.js';
import { PgnParser } from '../manual/pgnParser.js';

function readTestData(name: string): string {
  return readFileSync(new URL(`../../test-data/${name}`, import.meta.url), 'utf8');
}

function ucciOf(node: { move: Move | null }): string {
  if (node.move === null) throw new Error('节点无走法');
  return node.move.toUcci();
}

describe('PgnParser', () => {
  it('解析真实 ICCS PGN 样例：标签与主线', () => {
    const doc = PgnParser.parse(readTestData('manual_iccs.pgn'));
    expect(doc.event).toBe('SuperChess 测试对局');
    expect(doc.red).toBe('红方测试');
    expect(doc.black).toBe('黑方测试');
    expect(doc.result).toBe('1-0');
    expect(doc.initialBoard.toFen()).toBe(Fen.initial);
    expect(doc.root.children.length).toBeGreaterThan(0);
    expect(ucciOf(doc.root.children[0])).toBe('h2e2');
    expect(doc.validateAllMoves()).toBe(true);
  });

  it('花括号评注被剔除，不干扰着法解析', () => {
    // PGN 为线性着法链（每着的父节点是上一着），评注中含中文也不应进入着法流。
    const doc = PgnParser.parse(
      '[Event "T"]\n\n1. h2e2 {当头炮} h9g7 2. h0g2 {起马}\n',
    );
    const chain = [doc.root.children[0], doc.root.children[0].children[0],
      doc.root.children[0].children[0].children[0]];
    expect(chain.map(ucciOf)).toEqual(['h2e2', 'h9g7', 'h0g2']);
    expect(chain[2].children).toHaveLength(0);
  });

  it('FEN 标签生效', () => {
    const doc = PgnParser.parse(
      '[FEN "3k5/9/9/9/9/9/9/9/9/4K4 w - - 0 1"]\n\n1. e4e5\n',
    );
    expect(doc.initialBoard.toFen()).toBe('3k5/9/9/9/9/9/9/9/9/4K4 w - - 0 1');
  });

  it('非法 FEN 标签抛 ManualFormatException', () => {
    expect(() => PgnParser.parse('[FEN "9/9 w"]\n\n1. h2e2\n')).toThrow(ManualFormatException);
  });

  it('中文记谱 PGN 明确报不支持', () => {
    expect(() => PgnParser.parse('[Event "T"]\n\n1. 炮二平五 马8进7\n')).toThrow(
      /暂不支持中文记谱 PGN/,
    );
  });

  it('非 ICCS 的 ASCII 着法报格式错误', () => {
    expect(() => PgnParser.parse('[Event "T"]\n\n1. zzzz\n')).toThrow(/仅支持 ICCS 坐标记谱/);
  });

  it('isIccsMove 判定单 token', () => {
    expect(PgnParser.isIccsMove('h2e2')).toBe(true);
    expect(PgnParser.isIccsMove('炮二平五')).toBe(false);
  });
});
