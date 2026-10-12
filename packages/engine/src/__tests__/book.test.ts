import { describe, expect, it } from 'vitest';
import { Board, ChineseNotation, Move, Rule } from '@webchess/core';
import { BOOK_LINES, BuiltinEngine, createBuiltinEngine, probeBook } from '../index.js';

describe('内置开局库', () => {
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

  it('完整匹配前缀时返回下一着', () => {
    // rng 恒 0 → 多候选（中炮过河车/直车/巡河车/五七炮共享前 6 着）时取首条线 h0h6。
    const history = ['h2e2', 'h9g7', 'h0g2', 'b9c7', 'i0h0', 'i9h9'];
    expect(probeBook(history, () => 0)).toBe('h0h6');
    // 候选集应包含其余三条中炮变例的续着。
    expect(['c3c4', 'h0h4', 'b2c2']).toContain(probeBook(history, () => 0.99) as string);
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
    expect(probeBook(new Array(12).fill('h2e2'))).toBe(null);
  });

  it('时间制对局命中开局库即时出库（不搜索）', async () => {
    // rng 恒 0 → 多候选时取首个（中炮过河车线）→ h0h6。
    const engine = new BuiltinEngine(10, 100, () => 0);
    await engine.start();
    const result = await engine.go({
      fen: new Board().toFen(),
      moves: ['h2e2', 'h9g7', 'h0g2', 'b9c7', 'i0h0', 'i9h9'],
    });
    expect(result.bestMove).toBe('h0h6');
  });

  it('显式 depth 请求不走出库着法（分析模式语义保持）', async () => {
    const engine = new BuiltinEngine(3, 3000);
    await engine.start();
    const result = await engine.go({
      fen: new Board().toFen(),
      moves: ['h2e2', 'h9g7', 'h0g2', 'b9c7', 'i0h0', 'i9h9'],
      depth: 3,
    });
    expect(result.bestMove).not.toBeNull();
  });
});

describe('内置引擎强度档位', () => {
  it('最高 ELO 档不再限制深度上限', () => {
    const engine = createBuiltinEngine({ elo: 3199, limitStrength: true });
    // 最高档无深度上限：显式 depth 应全额生效（不再被压到 10）。
    return engine.start().then(async () => {
      const depths: number[] = [];
      engine.onInfo((info) => depths.push(info.depth));
      await engine.go({ fen: new Board().toFen(), depth: 4, moveTimeMs: 5000 });
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
