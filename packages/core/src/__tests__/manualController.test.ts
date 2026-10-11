import { describe, expect, it } from 'vitest';
import { Board } from '../board.js';
import { Move } from '../move.js';
import { ManualController } from '../manual/manualController.js';
import { ManualDocument, MoveNode } from '../manual/manualDocument.js';

function move(ucci: string): Move {
  const m = Move.fromUcci(ucci);
  if (m === null) throw new Error(`非法 UCCI：${ucci}`);
  return m;
}

/** 构造一条主线 h2e2 → h9g7 → h0g2，并在第二手挂一个变着 b0c2。 */
function buildDoc(): ManualDocument {
  const doc = new ManualDocument(new Board());
  const m1 = MoveNode.append(move('h2e2'), doc.root);
  const m2 = MoveNode.append(move('h9g7'), m1);
  MoveNode.append(move('h0g2'), m2);
  MoveNode.append(move('b0c2'), m2, '变着');
  return doc;
}

describe('ManualController', () => {
  it('未打开时全部查询安全返回', () => {
    const controller = new ManualController();
    expect(controller.isOpen).toBe(false);
    expect(controller.mainlineCount).toBe(0);
    expect(controller.currentDepth).toBe(0);
    expect(controller.branches).toHaveLength(0);
    expect(controller.peekDefaultForward()).toBeNull();
    expect(controller.moveBack()).toBe(false);
    expect(() => controller.initialFen).toThrow();
    expect(() => controller.fenAt(new MoveNode())).toThrow();
  });

  it('打开后游标在根，主线长度与分支正确', () => {
    const controller = new ManualController();
    controller.open(buildDoc());
    expect(controller.isOpen).toBe(true);
    expect(controller.currentDepth).toBe(0);
    expect(controller.mainlineCount).toBe(3);
    expect(controller.branches).toHaveLength(1);
    expect(controller.peekDefaultForward()?.move?.toUcci()).toBe('h2e2');
  });

  it('按主线前进并按 FEN 校验局面', () => {
    const controller = new ManualController();
    controller.open(buildDoc());

    const first = controller.peekDefaultForward()!;
    controller.advanceTo(first);
    expect(controller.currentDepth).toBe(1);

    const expected = new Board();
    expected.doMove(move('h2e2'));
    expect(controller.fenAt(controller.current!)).toBe(expected.toFen());
  });

  it('变着分支可被查找并推进', () => {
    const controller = new ManualController();
    controller.open(buildDoc());
    const second = controller.peekDefaultForward()!.children[0];
    controller.advanceTo(controller.peekDefaultForward()!);
    controller.advanceTo(second);
    expect(controller.currentDepth).toBe(2);
    expect(controller.branches).toHaveLength(2);

    const variation = controller.findBranch(move('b0c2'));
    expect(variation).not.toBeNull();
    expect(variation?.annotation).toBe('变着');
    controller.advanceTo(variation!);
    expect(controller.currentDepth).toBe(3);
    expect(controller.isAtEnd).toBe(true);
  });

  it('后退与回开局', () => {
    const controller = new ManualController();
    controller.open(buildDoc());
    controller.advanceTo(controller.peekDefaultForward()!);
    expect(controller.currentDepth).toBe(1);

    expect(controller.moveBack()).toBe(true);
    expect(controller.currentDepth).toBe(0);
    expect(controller.moveBack()).toBe(false);

    controller.advanceTo(controller.peekDefaultForward()!);
    controller.rewind();
    expect(controller.currentDepth).toBe(0);
  });

  it('推进非直接子节点抛异常', () => {
    const controller = new ManualController();
    controller.open(buildDoc());
    const grandchild = controller.peekDefaultForward()!.children[0];
    expect(() => controller.advanceTo(grandchild)).toThrow(/直接子节点/);
  });

  it('initialFen 与初始局面一致；clear 后关闭', () => {
    const controller = new ManualController();
    const doc = buildDoc();
    controller.open(doc);
    expect(controller.initialFen).toBe(doc.initialBoard.toFen());
    controller.clear();
    expect(controller.isOpen).toBe(false);
  });
});
