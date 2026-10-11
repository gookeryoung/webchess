import { describe, expect, it } from 'vitest';
import { Board } from '../board.js';
import { Move } from '../move.js';
import { Piece } from '../piece.js';
import { Position } from '../position.js';
import { Rule } from '../rule.js';
import { LessonController } from '../game/lessonController.js';
import { LessonLibrary, findLesson } from '../game/lessonLibrary.js';
import { LessonGoalKind } from '../game/lessonTypes.js';

function move(ucci: string): Move {
  const m = Move.fromUcci(ucci);
  if (m === null) throw new Error(`非法 UCCI：${ucci}`);
  return m;
}

function lesson(id: string) {
  const l = findLesson(id);
  if (l === undefined) throw new Error(`缺少课程：${id}`);
  return l;
}

describe('LessonController', () => {
  it('未开始时拒绝走子', () => {
    const controller = new LessonController();
    expect(controller.evaluate(new Board(), move('h2e2')).accepted).toBe(false);
    expect(controller.consumeApplied()).toBe(false);
  });

  it('AnyMoveOfPiece：走对棋子接受，走错拒绝', () => {
    const controller = new LessonController();
    const l = lesson('move-knight');
    controller.start(l);
    const board = Board.fromFen(l.fen);

    // 红帅在 (3,9)，不是马 → 拒绝。
    const wrong = controller.evaluate(board, new Move(new Position(3, 9), new Position(3, 8)));
    expect(wrong.accepted).toBe(false);
    expect(wrong.message).toBe('请移动指定的棋子');
    // 马在 (4,2)，跳到 (3,0) → 接受。
    expect(controller.evaluate(board, move('e7d9')).accepted).toBe(true);
  });

  it('AnyCheckingMove：将军着接受，非将军着拒绝', () => {
    const controller = new LessonController();
    const l = lesson('check-basic');
    controller.start(l);
    const board = Board.fromFen(l.fen);
    expect(l.goal.kind).toBe(LessonGoalKind.AnyCheckingMove);

    // 车 (3,5) 上移一格到 (3,4)：不构成将军。
    const rejected = controller.evaluate(board, new Move(new Position(3, 5), new Position(3, 4)));
    expect(rejected.accepted).toBe(false);
    expect(rejected.message).toBe('这一步没有造成将军');

    // 枚举出一步真正的将军着并断言接受。
    const checking = Rule.getAllLegalMoves(board, true).find((m) => {
      const sim = board.clone();
      sim.doMove(m);
      return Rule.isInCheck(sim, sim.redToMove);
    });
    expect(checking).toBeDefined();
    expect(controller.evaluate(board, checking!).accepted).toBe(true);
  });

  it('AnyMateMove：将死着接受，仅将军着拒绝', () => {
    const controller = new LessonController();
    const l = lesson('mate-basic');
    controller.start(l);
    const board = Board.fromFen(l.fen);

    // 枚举一步真正的将死着（该局面为一步杀）并断言接受。
    const mate = Rule.getAllLegalMoves(board, true).find((m) => {
      const sim = board.clone();
      sim.doMove(m);
      return Rule.isCheckmate(sim, sim.redToMove);
    });
    expect(mate).toBeDefined();
    expect(controller.evaluate(board, mate!).accepted).toBe(true);
  });

  it('AnyCaptureMove：吃指定棋子接受，吃错或未吃拒绝', () => {
    const controller = new LessonController();
    const l = lesson('capture-cannon');
    controller.start(l);
    const board = Board.fromFen(l.fen);
    expect(l.goal.pieceCode).toBe(Piece.BlackRook);

    // 炮 (0,5) 隔黑卒 (0,4) 打掉黑车 (0,1) → 接受。
    const captured = controller.evaluate(board, new Move(new Position(0, 5), new Position(0, 1)));
    expect(captured.accepted).toBe(true);

    // 炮空移一步未吃子 → 拒绝。
    const controller2 = new LessonController();
    controller2.start(l);
    const missed = controller2.evaluate(board, new Move(new Position(0, 5), new Position(1, 5)));
    expect(missed.accepted).toBe(false);
    expect(missed.message).toBe('这一步没有吃子，请吃掉目标棋子');
  });

  it('ExactMove：起终点必须精确一致', () => {
    const controller = new LessonController();
    const from = new Position(1, 9);
    const to = new Position(2, 7);
    controller.start({
      id: 'custom-exact',
      title: 't',
      intro: 'i',
      fen: 'rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR w',
      goal: { kind: LessonGoalKind.ExactMove, from, to },
      successText: 'ok',
    });
    const board = new Board();
    expect(controller.evaluate(board, new Move(from, new Position(2, 8))).accepted).toBe(false);
    expect(controller.evaluate(board, new Move(from, to)).accepted).toBe(true);
  });

  it('consumeApplied 标记完成，完成后拒绝继续走子', () => {
    const controller = new LessonController();
    controller.start(lesson('move-rook'));
    expect(controller.isCompleted).toBe(false);
    expect(controller.consumeApplied()).toBe(true);
    expect(controller.isCompleted).toBe(true);
    expect(controller.consumeApplied()).toBe(false);
    expect(controller.evaluate(new Board(), move('a5a6')).accepted).toBe(false);
  });

  it('reset 清空课程', () => {
    const controller = new LessonController();
    controller.start(lesson('move-pawn'));
    controller.reset();
    expect(controller.current).toBeNull();
    expect(controller.isCompleted).toBe(false);
  });

  it('全部课程 FEN 可解析且目标类型受支持', () => {
    for (const l of LessonLibrary) {
      expect(() => Board.fromFen(l.fen), l.id).not.toThrow();
      expect(Object.values(LessonGoalKind)).toContain(l.goal.kind);
    }
  });
});
