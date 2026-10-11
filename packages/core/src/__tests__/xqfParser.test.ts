import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { Fen } from '../fen.js';
import { ManualDocument, ManualFormatException, MoveNode } from '../manual/manualDocument.js';
import { XqfParser } from '../manual/xqfParser.js';

/**
 * XQF 解析测试：真实样例 sample_07（v16 加密、含多处变着与节点注释）
 * + 自制最小样例（v10 无加密 / v16 加密），对拍基准为原 C# 项目同一批数据。
 */

function load(name: string): ManualDocument {
  const bytes = readFileSync(new URL(`../../test-data/${name}`, import.meta.url));
  return XqfParser.parse(new Uint8Array(bytes));
}

function U(node: MoveNode): string {
  if (node.move === null) throw new Error('节点无走法');
  return node.move.toUcci();
}

function countNodes(node: MoveNode): number {
  let count = node.move === null ? 0 : 1;
  for (const child of node.children) {
    count += countNodes(child);
  }

  return count;
}

function mainline(root: MoveNode): string[] {
  const moves: string[] = [];
  for (
    let node: MoveNode | null = root.children.length > 0 ? root.children[0] : null;
    node !== null && node.move !== null;
    node = node.children.length > 0 ? node.children[0] : null
  ) {
    moves.push(node.move.toUcci());
  }

  return moves;
}

/** sample_07 主线 33 步（ICCS）。 */
const Sample07Mainline = [
  'g0e2', 'h7e7', 'h0g2', 'h9g7', 'i0h0', 'i9h9', 'b0c2', 'b9a7', 'h2h6', 'g6g5',
  'c3c4', 'b7d7', 'a0b0', 'a9b9', 'b2b6', 'd7d2', 'e2g0', 'a6a5', 'd0e1', 'd2d3',
  'h6g6', 'f9e8', 'h0h9', 'g7h9', 'g0e2', 'd3c3', 'i3i4', 'g9i7', 'g3g4', 'g5g4',
  'e2g4', 'h9f8', 'g2f4',
];

describe('XqfParser', () => {
  it('sample_07（v16 加密）：元信息与主线', () => {
    const doc = load('sample_07_XQStudio.xqf');
    expect(doc.version).toBe(16);
    expect(doc.category).toBe('布局');
    expect(doc.result).toBe('未知');
    expect(doc.title).toBe('');
    expect(doc.red).toBe('');
    expect(doc.annotation).toBeNull();
    expect(mainline(doc.root)).toEqual(Sample07Mainline);
    expect(countNodes(doc.root)).toBe(135);
    expect(doc.validateAllMoves()).toBe(true);
  });

  it('sample_07：变着与节点注释', () => {
    const doc = load('sample_07_XQStudio.xqf');
    let node: MoveNode = doc.root.children[0];
    for (let i = 1; i < 11; i++) {
      node = node.children[0];
    }

    expect(U(node)).toBe('c3c4');
    expect(node.children).toHaveLength(1);
    expect(U(node.children[0])).toBe('b7d7');

    const d7d2 = node.children[0].children[0].children[0].children[0].children[0];
    expect(U(d7d2)).toBe('d7d2');
    expect(d7d2.annotation).toBe('1');
    const b2b6 = d7d2.parent!;
    expect(U(b2b6)).toBe('b2b6');
    expect(b2b6.children).toHaveLength(2);
    expect(U(b2b6.children[1])).toBe('a7c8');
    expect(b2b6.children[1].annotation).toBe('2');
    expect(U(b2b6.children[1].children[0])).toBe('b6b8');

    const e2g0 = d7d2.children[0];
    expect(U(e2g0)).toBe('e2g0');
    const a6a5 = e2g0.children[0];
    expect(U(a6a5)).toBe('a6a5');
    expect(U(e2g0.children[1])).toBe('f9e8');
    expect(U(a6a5.children[1])).toBe('c2d4');
  });

  it('低版本 v10：无加密，含变着与注释', () => {
    const doc = load('test_manual_v10.xqf');
    expect(doc.version).toBe(10);
    expect(doc.result).toBe('红胜');
    expect(doc.category).toBe('全局');
    expect(doc.annotation).toBe('SuperChess 测试棋谱全局注释');

    expect(doc.root.children).toHaveLength(2);
    expect(U(doc.root.children[0])).toBe('h2e2');
    expect(U(doc.root.children[1])).toBe('e6e5');

    const main = doc.root.children[0];
    expect(U(main.children[0])).toBe('h9g7');
    expect(main.children[0].annotation).toBe('黑方进马（主线）');
    expect(U(main.children[0].children[0])).toBe('h0g2');
    expect(U(main.children[0].children[0].children[0])).toBe('i9h9');

    expect(U(doc.root.children[1].children[0])).toBe('h0g2');
    expect(countNodes(doc.root)).toBe(6);
    expect(doc.validateAllMoves()).toBe(true);
  });

  it('高版本 v16：加密并含注释', () => {
    const doc = load('test_manual_v16.xqf');
    expect(doc.version).toBe(16);
    expect(doc.result).toBe('平局');
    expect(doc.category).toBe('残局');

    expect(U(doc.root.children[0])).toBe('h2e2');
    const second = doc.root.children[0].children[0];
    expect(U(second)).toBe('h9g7');
    expect(second.annotation).toBe('高版本加密注释');
    expect(countNodes(doc.root)).toBe(2);
    expect(doc.validateAllMoves()).toBe(true);
  });

  it('全部样例初始局面为标准起始局面', () => {
    for (const name of [
      'sample_07_XQStudio.xqf',
      'test_manual_v10.xqf',
      'test_manual_v16.xqf',
    ]) {
      const doc = load(name);
      expect(doc.initialBoard.toFen(), name).toBe(Fen.initial);
      expect(doc.validateAllMoves(), name).toBe(true);
    }
  });

  it('magic 非法抛异常', () => {
    const data = new Uint8Array(0x410);
    data[0] = 0x58; // 'X'
    data[1] = 0x59; // 'Y'
    expect(() => XqfParser.parse(data)).toThrow(/文件头标识/);
  });

  it('文件过短抛异常', () => {
    expect(() => XqfParser.parse(new Uint8Array([0x58, 0x51, 0x10]))).toThrow(/过短/);
  });

  it('内置棋谱（Web 端资源）可解析', () => {
    // 与 packages/web/public/manuals 同源，验证内置样例未损坏。
    const bytes = readFileSync(new URL('../../test-data/test_manual_v16.xqf', import.meta.url));
    expect(() => XqfParser.parse(new Uint8Array(bytes))).not.toThrow(ManualFormatException);
  });
});
