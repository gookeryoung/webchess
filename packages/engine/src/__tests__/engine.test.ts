import { describe, expect, it } from 'vitest';
import { Board, Move, Rule } from '@webchess/core';
import { BuiltinEngine, Searcher } from '../index.js';

function legalUcciSet(board: Board): Set<string> {
  return new Set(Rule.getAllLegalMoves(board, board.redToMove).map((m) => m.toUcci()));
}

describe('内置搜索引擎', () => {
  it('起始局面能返回一步合法着法', async () => {
    const engine = new BuiltinEngine(3, 3000);
    await engine.start();
    const fen = new Board().toFen();
    const result = await engine.go({ fen, depth: 3 });
    expect(result.bestMove).not.toBeNull();
    expect(legalUcciSet(new Board())).toContain(result.bestMove);
  });

  it('一步杀局面能找到制胜着法', async () => {
    // 重炮杀：e7e8 为唯一解（与题库 mate1-chongpao 同源局面）。
    const fen = '3aka3/4c4/4R4/4C4/9/2p6/9/9/4C4/3K5 w - - 0 1';
    const engine = new BuiltinEngine(3, 3000);
    await engine.start();
    const result = await engine.go({ fen, depth: 3 });
    expect(result.bestMove).toBe('e7e8');
  });

  it('被将死的局面无着可走时返回 null', async () => {
    const fen = '3rrk3/9/9/9/9/9/9/9/9/3K5 w - - 0 1';
    const engine = new BuiltinEngine(2, 1000);
    await engine.start();
    const result = await engine.go({ fen, depth: 2 });
    expect(result.bestMove).toBeNull();
  });

  it('非法 FEN 返回 null 而不抛异常', async () => {
    const engine = new BuiltinEngine(2, 1000);
    await engine.start();
    const result = await engine.go({ fen: '9/9 w', depth: 2 });
    expect(result.bestMove).toBeNull();
  });

  it('MultiPV 模式按路数汇报评估信息', async () => {
    const engine = new BuiltinEngine(3, 3000);
    await engine.start();
    const infos: number[] = [];
    engine.onInfo((info) => infos.push(info.index));
    const result = await engine.go({ fen: new Board().toFen(), depth: 3, multiPv: 3 });
    expect(infos.length).toBe(3);
    expect(infos).toEqual([1, 2, 3]);
    expect(result.bestMove).not.toBeNull();
  });

  it('Searcher 在大子力优势局面给出正分（红方视角）', () => {
    // 红方多一车：静态评估应为红方占优。
    const board = Board.fromFen('4k4/9/9/9/9/9/9/9/R8/4K2R1 w - - 0 1');
    const outcome = new Searcher().search(board, { maxDepth: 2, moveTimeMs: 2000 });
    expect(outcome.score).toBeGreaterThan(500);
    expect(outcome.bestMove).toBeInstanceOf(Move);
  });

  it('搜索统计节点数与深度合理', () => {
    const outcome = new Searcher().search(new Board(), { maxDepth: 3, moveTimeMs: 5000 });
    expect(outcome.stats.depth).toBeGreaterThanOrEqual(1);
    expect(outcome.stats.nodes).toBeGreaterThan(0);
  });
});
