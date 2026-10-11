import { describe, expect, it } from 'vitest';
import { Board } from '../board.js';
import { Move } from '../move.js';
import { Rule } from '../rule.js';
import { LessonGoalKind } from '../game/lessonTypes.js';
import { LessonLibrary } from '../game/lessonLibrary.js';
import { PuzzleLibrary } from '../game/puzzleLibrary.js';
import { PuzzleMoveNode } from '../game/puzzleTypes.js';
import { Piece } from '../piece.js';

/**
 * 题库/课程库完整性：FEN 合法、着法树每着在对应局面合法、末位是真将死。
 * 与原 C# LibraryIntegrityTests 同语义，是题库数据可信度的兜底判据。
 */

/** 递归校验：从 board 出发，node 的每个子分支着法均合法，且叶子处为将死。 */
function validateTree(board: Board, node: PuzzleMoveNode): boolean {
  if (node.children.length === 0) {
    return true;
  }

  for (const child of node.children) {
    const childMove = Move.fromUcci(child.ucci);
    if (childMove === null || !Rule.isLegalMove(board, childMove)) {
      return false;
    }

    const next = board.clone();
    next.doMove(childMove);
    if (!validateTree(next, child)) {
      return false;
    }
  }

  return true;
}

/** 收集全部叶子节点对应的局面，断言末位为将死。 */
function leavesMated(board: Board, node: PuzzleMoveNode, out: boolean[]): void {
  if (node.children.length === 0) {
    out.push(node.isRoot ? false : Rule.isCheckmate(board, board.redToMove));
    return;
  }

  for (const child of node.children) {
    const childMove = Move.fromUcci(child.ucci);
    if (childMove === null) {
      out.push(false);
      continue;
    }

    const next = board.clone();
    next.doMove(childMove);
    leavesMated(next, child, out);
  }
}

describe('残局题库完整性', () => {
  it('题目数量与难度分布符合基线', () => {
    expect(PuzzleLibrary).toHaveLength(50);
    // 难度分布基线（与原 C# PuzzleLibrary 一致）。
    expect(PuzzleLibrary.filter((p) => p.difficulty === 1)).toHaveLength(24);
    expect(PuzzleLibrary.filter((p) => p.difficulty === 2)).toHaveLength(14);
    expect(PuzzleLibrary.filter((p) => p.difficulty === 3)).toHaveLength(8);
    expect(PuzzleLibrary.filter((p) => p.difficulty === 4)).toHaveLength(4);
    // 难度升序排列。
    const difficulties = PuzzleLibrary.map((p) => p.difficulty);
    expect(difficulties).toEqual([...difficulties].sort((a, b) => a - b));
  });

  it('题目 Id 唯一', () => {
    expect(new Set(PuzzleLibrary.map((p) => p.id)).size).toBe(PuzzleLibrary.length);
  });

  it('每题 FEN 合法、着法树全部着法可回放且末位将死', () => {
    for (const puzzle of PuzzleLibrary) {
      const board = Board.fromFen(puzzle.fen);
      expect(puzzle.root.isRoot).toBe(true);
      expect(puzzle.root.children.length, `${puzzle.id} 应有正解首着`).toBeGreaterThan(0);
      expect(validateTree(board, puzzle.root), `${puzzle.id} 着法树含非法着`).toBe(true);

      const results: boolean[] = [];
      leavesMated(board, puzzle.root, results);
      expect(results.every(Boolean), `${puzzle.id} 末位非将死`).toBe(true);
    }
  });
});

describe('入门课程库完整性', () => {
  it('课程数量与 Id 唯一', () => {
    expect(LessonLibrary).toHaveLength(10);
    expect(new Set(LessonLibrary.map((l) => l.id)).size).toBe(LessonLibrary.length);
  });

  it('每课 FEN 合法，且指定棋子存在于局面中', () => {
    for (const lesson of LessonLibrary) {
      const board = Board.fromFen(lesson.fen);
      if (lesson.goal.kind === LessonGoalKind.AnyMoveOfPiece) {
        const code = lesson.goal.pieceCode ?? 0;
        const found = [...board.cells].includes(code);
        expect(found, `${lesson.id} 局面缺少目标棋子`).toBe(true);
      }

      if (lesson.goal.kind === LessonGoalKind.AnyCaptureMove) {
        expect(lesson.goal.pieceCode === Piece.BlackRook).toBe(true);
      }
    }
  });
});
