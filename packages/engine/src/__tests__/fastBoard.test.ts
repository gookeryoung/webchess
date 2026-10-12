import { describe, expect, it } from 'vitest';
import { Board, cellIndex, Move, Piece, Position, Rule } from '@webchess/core';
import { encodeMove, FastPosition, moveFrom, moveTo } from '../fastBoard.js';
import { PIECE_SCORE } from '../evaluate.js';

/** 走法编码 → UCCI（经内核 Move，保证坐标系语义一致）。 */
function moveToUcci(move: number): string {
  const from = moveFrom(move);
  const to = moveTo(move);
  return new Move(
    new Position(from % 9, (from / 9) | 0),
    new Position(to % 9, (to / 9) | 0),
  ).toUcci();
}

/** Rule 侧与 FastPosition.inCheck 等价的判定（被将军或将帅照面）。 */
function ruleInCheckEquiv(board: Board, red: boolean): boolean {
  return Rule.isInCheck(board, red) || Rule.isKingsFacing(board);
}

/** 收集 FastPosition 合法着法的 UCCI 集合。 */
function fastLegalSet(pos: FastPosition, buf: Int32Array): Set<string> {
  const count = pos.genLegalMoves(buf, 0);
  const set = new Set<string>();
  for (let i = 0; i < count; i++) {
    set.add(moveToUcci(buf[i]));
  }
  return set;
}

/** 全盘重算静态分（与 FastPosition.baseScore 增量维护对照）。 */
function fullBaseScore(cells: Uint8Array): number {
  let score = 0;
  for (let sq = 0; sq < 90; sq++) {
    const piece = cells[sq];
    if (piece !== Piece.Empty) {
      score += PIECE_SCORE[piece * 90 + sq];
    }
  }
  return score;
}

describe('FastPosition — 与内核 Rule 对照', () => {
  it('起始局面合法着法与 Rule 完全一致', () => {
    const board = new Board();
    const pos = new FastPosition().setFromBoard(board);
    const buf = new Int32Array(256);
    const fast = fastLegalSet(pos, buf);
    const rule = new Set(
      Rule.getAllLegalMoves(board, board.redToMove).map((m) => m.toUcci()),
    );
    expect(fast).toEqual(rule);
    expect(fast.size).toBeGreaterThan(30);
  });

  it('对局推进 12 步：每局面着法集合、将军判定、增量评估均与内核一致', () => {
    const board = new Board();
    const pos = new FastPosition().setFromBoard(board);
    const buf = new Int32Array(256);

    for (let step = 0; step < 12; step++) {
      const fast = fastLegalSet(pos, buf);
      const legal = Rule.getAllLegalMoves(board, board.redToMove);
      const rule = new Set(legal.map((m) => m.toUcci()));
      expect(fast).toEqual(rule);

      // 将军判定对照（FastPosition 将照面并入 inCheck 语义）。
      expect(pos.inCheck(true)).toBe(ruleInCheckEquiv(board, true));
      expect(pos.inCheck(false)).toBe(ruleInCheckEquiv(board, false));

      // 增量静态分与全盘重算一致。
      expect(pos.baseScore).toBe(fullBaseScore(pos.cells));

      if (legal.length === 0) {
        break;
      }

      // 两侧同步推进同一着法（取不同索引提升局面多样性）。
      const move = legal[(step * 5) % legal.length];
      board.doMove(move);
      pos.make(encodeMove(cellIndex(move.from.x, move.from.y), cellIndex(move.to.x, move.to.y)));
    }
  });

  it('多组推进序列覆盖中盘局面着法集合对照', () => {
    for (let offset = 0; offset < 3; offset++) {
      const board = new Board();
      const pos = new FastPosition().setFromBoard(board);
      const buf = new Int32Array(256);

      for (let step = 0; step < 10; step++) {
        const fast = fastLegalSet(pos, buf);
        const rule = new Set(
          Rule.getAllLegalMoves(board, board.redToMove).map((m) => m.toUcci()),
        );
        expect(fast).toEqual(rule);

        const legal = Rule.getAllLegalMoves(board, board.redToMove);
        if (legal.length === 0) {
          break;
        }

        const move = legal[(step * 5 + offset * 2) % legal.length];
        board.doMove(move);
        pos.make(
          encodeMove(cellIndex(move.from.x, move.from.y), cellIndex(move.to.x, move.to.y)),
        );
      }
    }
  });

  it('capturesOnly 仅生成吃子着法且包含相邻吃子', () => {
    // 红车 e5 与黑卒 e4 纵向相邻。
    const fen = '4k4/9/9/9/4p4/4R4/9/9/9/3K5 w - - 0 1';
    const board = Board.fromFen(fen);
    const pos = new FastPosition().setFromBoard(board);
    const capBuf = new Int32Array(256);
    const allBuf = new Int32Array(256);
    const capCount = pos.genMoves(capBuf, 0, true);
    const allCount = pos.genMoves(allBuf, 0, false);
    expect(allCount).toBeGreaterThan(capCount);
    expect(capCount).toBeGreaterThan(0);

    let hasRookTakesPawn = false;
    for (let i = 0; i < capCount; i++) {
      expect(pos.cells[moveTo(capBuf[i])]).not.toBe(Piece.Empty);
      if (capBuf[i] === encodeMove(cellIndex(4, 5), cellIndex(4, 4))) {
        hasRookTakesPawn = true;
      }
    }
    expect(hasRookTakesPawn).toBe(true);
  });
});

describe('FastPosition — Zobrist 与增量维护', () => {
  it('make/unmake 往返后键、静态分、局面矩阵完全复原', () => {
    const board = new Board();
    const pos = new FastPosition().setFromBoard(board);
    const keyLo0 = pos.keyLo;
    const keyHi0 = pos.keyHi;
    const score0 = pos.baseScore;
    const buf = new Int32Array(256);

    const made: number[] = [];
    for (let round = 0; round < 8; round++) {
      const count = pos.genLegalMoves(buf, 0);
      if (count === 0) {
        break;
      }
      const move = buf[(round * 3) % count];
      made.push(move);
      pos.make(move);
    }

    expect(pos.ply).toBe(made.length);
    expect(pos.baseScore).toBe(fullBaseScore(pos.cells));

    while (pos.ply > 0) {
      pos.unmake();
    }

    expect(pos.keyLo).toBe(keyLo0);
    expect(pos.keyHi).toBe(keyHi0);
    expect(pos.baseScore).toBe(score0);
    expect([...pos.cells]).toEqual([...board.cells]);
  });

  it('同一局面不同路径到达时键一致（重放等价）', () => {
    const board = new Board();
    const pos = new FastPosition().setFromBoard(board);
    const buf = new Int32Array(256);
    const applied: number[] = [];
    for (let i = 0; i < 4; i++) {
      const count = pos.genLegalMoves(buf, 0);
      const move = buf[(i * 3) % count];
      applied.push(move);
      pos.make(move);
    }

    // 内核侧重放同一序列得到相同局面。
    const replay = new Board();
    for (const move of applied) {
      const from = moveFrom(move);
      const to = moveTo(move);
      const m = new Move(
        new Position(from % 9, (from / 9) | 0),
        new Position(to % 9, (to / 9) | 0),
      );
      expect(replay.doMove(m)).toBe(true);
    }

    const fresh = new FastPosition().setFromBoard(replay);
    expect(fresh.keyLo).toBe(pos.keyLo);
    expect(fresh.keyHi).toBe(pos.keyHi);
    expect(fresh.baseScore).toBe(pos.baseScore);
  });

  it('起始局面静态分为 0（红黑位置表镜像对称）', () => {
    const pos = new FastPosition().setFromBoard(new Board());
    expect(pos.baseScore).toBe(0);
  });

  it('路径内同局面再现时 isRepetition 为真，离开循环后为假，unmake 恢复为真', () => {
    // 红车 a4 与黑士 e1 四半着循环回到初始局面；4 步循环中任何前缀局面
    // 都会周期重现，故以「离开循环的单向着法」验证回退语义。
    const fen = '4k4/4a4/9/9/R8/9/9/9/9/3K5 w - - 0 1';
    const pos = new FastPosition().setFromBoard(Board.fromFen(fen));
    const seq: [number, number][] = [
      [cellIndex(0, 4), cellIndex(0, 5)], // 车a4a5
      [cellIndex(4, 1), cellIndex(3, 0)], // 士e1d0
      [cellIndex(0, 5), cellIndex(0, 4)], // 车a5a4
      [cellIndex(3, 0), cellIndex(4, 1)], // 士d0e1 → 回到初始局面
    ];
    for (const [from, to] of seq) {
      pos.make(encodeMove(from, to));
    }

    expect(pos.isRepetition()).toBe(true);

    // 离开循环：车横移 b4，该局面在路径中唯一。
    pos.make(encodeMove(cellIndex(0, 4), cellIndex(1, 4)));
    expect(pos.isRepetition()).toBe(false);

    // unmake 回到循环点，重复状态随栈正确恢复。
    pos.unmake();
    expect(pos.isRepetition()).toBe(true);
  });

  it('起始局面前 3 半着内 isRepetition 恒为假', () => {
    const pos = new FastPosition().setFromBoard(new Board());
    const buf = new Int32Array(256);
    for (let i = 0; i < 3; i++) {
      const count = pos.genLegalMoves(buf, 0);
      pos.make(buf[i % count]);
      expect(pos.isRepetition()).toBe(false);
    }
  });
});
