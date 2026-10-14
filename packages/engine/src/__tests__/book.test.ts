import { describe, expect, it } from 'vitest';
import { Board, ChineseNotation, Move, Rule } from '@webchess/core';
import {
  BOOK_LINES,
  BOOK_MAX_PLIES,
  BuiltinEngine,
  bookMoveCount,
  bookPositionCount,
  buildBookTable,
  createBuiltinEngine,
  positionKey,
  probeBook,
  probeBookAtFen,
} from '../index.js';

/** 从起始局面重放着法序列，返回终局 Board。 */
function replay(moves: readonly string[]): Board {
  const board = new Board();
  for (const ucci of moves) {
    board.doMove(Move.fromUcci(ucci) as Move);
  }

  return board;
}

describe('内置开局库（局面键哈希表）', () => {
  it('全部变例逐着走子合法', () => {
    for (const line of BOOK_LINES) {
      const board = new Board();
      for (const ucci of line.moves) {
        const move = Move.fromUcci(ucci);
        expect(move, `${line.name} 着法 ${ucci} 无法解析`).not.toBeNull();
        expect(Rule.isLegalMove(board, move as Move), `${line.name} 着法 ${ucci} 非法`).toBe(true);
        board.doMove(move as Move);
      }
    }
  });

  it('首着中文记法与布局名相符', () => {
    const board = new Board();
    const firstMoves = new Set(BOOK_LINES.map((line) => line.moves[0]));
    for (const ucci of firstMoves) {
      const move = Move.fromUcci(ucci) as Move;
      const notation = ChineseNotation.toChinese(board, move);
      // 中炮类 / 仙人指路 / 飞相 / 起马 / 过宫炮 的首着均应属于这五种记法。
      expect(['炮二平五', '兵七进一', '相七进五', '马二进三', '炮八平六']).toContain(notation);
    }
  });

  it('表规模覆盖全部变例的局面', () => {
    // 局面数应显著大于 0 且不少于最长变例长度（逐着登记）。
    expect(bookPositionCount()).toBeGreaterThan(BOOK_MAX_PLIES);
    expect(bookMoveCount()).toBeGreaterThanOrEqual(bookPositionCount());
  });

  it('完整匹配前缀时返回下一着', () => {
    // rng 恒 0 → 多候选（中炮过河车/直车/巡河车共享前 6 着）时取首条线 h0h6。
    const history = ['h2e2', 'h9g7', 'h0g2', 'b9c7', 'i0h0', 'i9h9'];
    expect(probeBook(history, () => 0)).toBe('h0h6');
    // 候选集应包含其余中炮变例的续着。
    expect(['c3c4', 'h0h4']).toContain(probeBook(history, () => 0.99) as string);
  });

  it('换位可达同一局面时同样命中（旧线性前缀实现会漏）', () => {
    // 顺手炮缓开车变例的着法顺序为 「马二进三 → 马8进7 → 马八进七 → 马2进3」，
    // 交换两对马的行棋顺序后到达完全相同的局面。
    const bookOrder = ['h2e2', 'h7e7', 'h0g2', 'h9g7', 'b0c2', 'b9c7'];
    const transposed = ['h2e2', 'h7e7', 'b0c2', 'b9c7', 'h0g2', 'h9g7'];
    expect(replay(bookOrder).toFen()).toBe(replay(transposed).toFen());

    expect(probeBook(bookOrder, () => 0)).toBe('a0b0');
    expect(probeBook(transposed, () => 0)).toBe('a0b0');
    expect(probeBookAtFen(replay(transposed).toFen(), () => 0)).toBe('a0b0');
  });

  it('局面键剔除回合数字段（换位列参与键会导致漏命中）', () => {
    const board = new Board().toFen();
    const [, side] = board.split(' ');
    const boardField = board.split(' ')[0];
    expect(positionKey(`${boardField} ${side} - - 0 1`)).toBe(
      positionKey(`${boardField} ${side} - - 0 99`),
    );
    expect(positionKey(`${boardField} ${side} - - 0 1`)).not.toBe(
      positionKey(`${boardField} ${side === 'w' ? 'b' : 'w'} - - 0 1`),
    );
  });

  it('多线共享同一着法时权重累加', () => {
    const table = buildBookTable([
      { name: 'A', moves: ['h2e2', 'h9g7'], weight: 2 },
      { name: 'B', moves: ['h2e2', 'b9c7'], weight: 1 },
    ]);
    const start = table.get(positionKey(new Board().toFen()));
    expect(start).toHaveLength(1);
    expect(start?.[0].ucci).toBe('h2e2');
    expect(start?.[0].weight).toBe(3);
  });

  it('非法变例在建表时 fail fast', () => {
    // 第二着仍是红方走子（轮次错误）→ 立即抛错，而不是静默产出脏库。
    expect(() => buildBookTable([{ name: '轮次错误', moves: ['h2e2', 'h2e2'] }])).toThrow(/非法/);
    expect(() =>
      buildBookTable([{ name: '无法解析', moves: ['h2e2', 'zzzz'] }]),
    ).toThrow(/非法/);
  });

  it('确定随机源时结果确定且来自候选集', () => {
    // 起始局面候选 = 各变例首着集合。
    const expected = new Set(BOOK_LINES.map((line) => line.moves[0]));
    for (let seed = 0; seed < 20; seed++) {
      let value = seed;
      const rng = () => {
        value = (value * 1103515245 + 12345) & 0x7fffffff;
        return value / 0x7fffffff;
      };
      const move = probeBook([], rng);
      expect(expected.has(move as string)).toBe(true);
    }
  });

  it('未知布局与超出介入深度返回 null', () => {
    expect(probeBook(['h2e2', 'h7e7', 'i0h0', 'i9h9', 'b0c2'])).toBe(null);
    expect(probeBook(new Array(BOOK_MAX_PLIES).fill('h2e2'))).toBe(null);
  });
});

describe('内置引擎开局库接入', () => {
  it('时间制对局命中开局库即时出库（不搜索）', async () => {
    // rng 恒 0 → 多候选时取首个（中炮过河车线）→ h0h6。
    const engine = new BuiltinEngine(10, 100, () => 0);
    await engine.start();
    const result = await engine.go({
      fen: new Board().toFen(),
      moves: ['h2e2', 'h9g7', 'h0g2', 'b9c7', 'i0h0', 'i9h9'],
    });
    expect(result.bestMove).toBe('h0h6');
    expect(result.source).toBe('book');
  });

  it('人机对局链路（恒带 depth 上限）仍能出库——旧条件曾使开局库永不生效', async () => {
    // 真实链路：GameSession 传 fen=当前局面 + depth=12 + movetime，旧实现要求
    // depth === undefined 且 fen === 起始局面，导致永远走搜索。
    const engine = new BuiltinEngine(12, 1500, () => 0);
    await engine.start();
    const depths: number[] = [];
    engine.onInfo((info) => depths.push(info.depth));

    const result = await engine.go({
      fen: new Board().toFen(),
      depth: 12,
      moveTimeMs: 1000,
    });
    expect(result.source).toBe('book');
    expect(result.bestMove).toBe('h2e2');
    // 零搜索：只应有 depth 0 的出库 info。
    expect(depths).toEqual([0]);
  });

  it('useBook:false 与分析模式（MultiPV > 1）不出库', async () => {
    const engine = new BuiltinEngine(2, 800, () => 0);
    await engine.start();

    const plain = await engine.go({ fen: new Board().toFen(), depth: 2, useBook: false });
    expect(plain.source).toBe('search');

    const multi = await engine.go({ fen: new Board().toFen(), depth: 2, multiPv: 2, moveTimeMs: 400 });
    expect(multi.source).toBe('search');
  });
});

describe('内置引擎强度档位', () => {
  it('最高 ELO 档不再限制深度上限', () => {
    const engine = createBuiltinEngine({ elo: 3199, limitStrength: true });
    // 最高档无深度上限：显式 depth 应全额生效（不再被压到 10）。
    return engine.start().then(async () => {
      const depths: number[] = [];
      engine.onInfo((info) => depths.push(info.depth));
      // useBook:false —— 本用例校验搜索深度，起始局面已入库。
      await engine.go({ fen: new Board().toFen(), depth: 4, moveTimeMs: 5000, useBook: false });
      expect(Math.max(...depths)).toBe(4);
    });
  });

  it('弱化档失误采样在概率为 1 时必不返回搜索最佳着', async () => {
    // 深度上限 2 → blunderRate 0.48；注入恒触发随机源 → 必定采样。
    const engine = new BuiltinEngine(2, 1000, () => 0);
    await engine.applyOptions({ elo: 1500, limitStrength: true });
    const board = Board.fromFen('4k4/9/9/9/9/9/9/9/R8/4K2R1 w - - 0 1');
    const result = await engine.go({ fen: board.toFen(), depth: 2, moveTimeMs: 2000 });
    expect(result.bestMove).not.toBeNull();

    // 采样着法必须仍是合法着。
    const legal = new Set(
      Rule.getAllLegalMoves(board, board.redToMove).map((m) => m.toUcci()),
    );
    expect(legal.has(result.bestMove as string)).toBe(true);
  });
});
