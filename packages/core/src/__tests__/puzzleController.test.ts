import { describe, expect, it } from 'vitest';
import { Move } from '../move.js';
import { PuzzleController } from '../game/puzzleController.js';
import { PuzzleLibrary } from '../game/puzzleLibrary.js';
import { PuzzleDefinition } from '../game/puzzleTypes.js';

function move(ucci: string): Move {
  const m = Move.fromUcci(ucci);
  if (m === null) throw new Error(`非法 UCCI：${ucci}`);
  return m;
}

function byId(id: string): PuzzleDefinition {
  const puzzle = PuzzleLibrary.find((p) => p.id === id);
  if (puzzle === undefined) throw new Error(`缺少题目：${id}`);
  return puzzle;
}

describe('PuzzleController', () => {
  it('未开始时拒绝走子', () => {
    const controller = new PuzzleController();
    expect(controller.evaluate(move('h2e2')).accepted).toBe(false);
    expect(controller.current).toBeNull();
    expect(controller.totalUserMoves).toBe(0);
  });

  it('一步杀：命中即过关', () => {
    const controller = new PuzzleController();
    const puzzle = byId('mate1-chongpao');
    controller.start(puzzle);
    expect(controller.totalUserMoves).toBe(1);
    expect(controller.userMoveCount).toBe(0);

    const wrong = controller.evaluate(move('e4e5'));
    expect(wrong.accepted).toBe(false);

    const right = controller.evaluate(move('e7e8'));
    expect(right.accepted).toBe(true);
    expect(right.message).toBe('过关！');
    expect(right.defenseReply).toBeNull();
    expect(controller.isSolved).toBe(true);

    // 过关后再走子被拒绝。
    expect(controller.evaluate(move('e7e8')).accepted).toBe(false);
  });

  it('多正解：任一分支命中均接受', () => {
    const controller = new PuzzleController();
    controller.start(byId('mate1-wocaoma'));
    expect(controller.evaluate(move('e5d7')).accepted).toBe(true);

    controller.reset();
    expect(controller.isSolved).toBe(false);
    expect(controller.evaluate(move('e5f7')).accepted).toBe(true);
    expect(controller.isSolved).toBe(true);
  });

  it('两步杀：用户着后返回防守着并推进进度', () => {
    const controller = new PuzzleController();
    controller.start(byId('mate2-mapao'));
    expect(controller.totalUserMoves).toBe(2);

    const first = controller.evaluate(move('i4g5'));
    expect(first.accepted).toBe(true);
    expect(first.defenseReply?.toUcci()).toBe('e9e8');
    expect(controller.userMoveCount).toBe(1);
    expect(first.message).toBe('第 1/2 步正确');
    expect(controller.isSolved).toBe(false);

    const second = controller.evaluate(move('g5e6'));
    expect(second.accepted).toBe(true);
    expect(second.defenseReply).toBeNull();
    expect(controller.isSolved).toBe(true);
  });

  it('偏离主线被拒绝且游标不推进', () => {
    const controller = new PuzzleController();
    controller.start(byId('mate2-shuangche'));
    expect(controller.evaluate(move('i4i9')).accepted).toBe(false);
    expect(controller.userMoveCount).toBe(0);
    // 拒绝后仍可接受正确首着。
    expect(controller.evaluate(move('i4e4')).accepted).toBe(true);
  });

  it('clear 后回到未开始状态', () => {
    const controller = new PuzzleController();
    controller.start(byId('mate1-chongpao'));
    controller.clear();
    expect(controller.current).toBeNull();
    expect(controller.evaluate(move('e7e8')).accepted).toBe(false);
  });
});
