import { Move } from '../move.js';
import { PuzzleDefinition, PuzzleMoveNode, PuzzleMoveResult } from './puzzleTypes.js';

/**
 * 残局练习控制器（零平台依赖）：游标停在着法树当前节点，用户着与并列
 * 正解分支比对（任一命中即接受并推进），防守着唯一由 UI 延迟落子；偏离即拒绝
 * 并要求重试。Evaluate 接受时立即推进游标（题库完整性测试保证树着法在对应局面
 * 合法，落子失败不会发生）。
 */
export class PuzzleController {
  private _current: PuzzleDefinition | null = null;
  private _cursor: PuzzleMoveNode | null = null;

  /** 当前题目；未开始时为 null。 */
  get current(): PuzzleDefinition | null {
    return this._current;
  }

  /**
   * 已完成的用户着数（用于「第 x/N 步」进度提示）。
   * 注意：C# 原式为整数除法 `(Depth + 1) / 2`，TS 需显式取整，否则会出现 0.5 步。
   */
  get userMoveCount(): number {
    return this._cursor === null ? 0 : Math.floor((this._cursor.depth + 1) / 2);
  }

  /** 本题主线用户着总数（沿主线数用户着，与用户选择的正解分支无关）。 */
  get totalUserMoves(): number {
    if (this._current === null) {
      return 0;
    }

    let count = 0;
    for (
      let node: PuzzleMoveNode = this._current.root;
      node.children.length > 0;
      node = node.children[0]
    ) {
      if (node.depth % 2 === 0) {
        count++;
      }
    }

    return count;
  }

  /** 主线末位用户着是否已被接受（着法树走完、无防守着，即达成将死、过关）。 */
  get isSolved(): boolean {
    return (
      this._current !== null &&
      this._cursor !== null &&
      !this._cursor.isRoot &&
      this._cursor.depth % 2 === 1 &&
      this._cursor.children.length === 0
    );
  }

  /** 开始一道残局题（UI 先调 GameSession.loadFen 载入局面）。 */
  start(puzzle: PuzzleDefinition): void {
    this._current = puzzle;
    this._cursor = puzzle.root;
  }

  /** 重玩本题（UI 重新 loadFen 后调用）。 */
  reset(): void {
    if (this._current !== null) {
      this._cursor = this._current.root;
    }
  }

  /** 退出练习（返回对弈模式时调用）。 */
  clear(): void {
    this._current = null;
    this._cursor = null;
  }

  /**
   * 先行校验用户走子：与当前节点的任一并列正解分支一致则接受并推进；否则拒绝
   * （局面不变）。命中后有防守着则游标越过它一并推进（棋盘应用由 UI 延迟执行，
   * 树匹配不依赖棋盘），无防守着即过关。
   */
  evaluate(move: Move): PuzzleMoveResult {
    if (this._current === null || this._cursor === null) {
      return { accepted: false, message: '当前没有进行中的残局题', defenseReply: null };
    }

    if (this.isSolved) {
      return { accepted: false, message: '本题已过关', defenseReply: null };
    }

    const branch = this._cursor.children.find((child) => PuzzleController.matches(child, move));
    if (branch === undefined) {
      return { accepted: false, message: '此着不能达成目标，请重试', defenseReply: null };
    }

    this._cursor = branch;
    let defense: Move | null = null;
    if (branch.children.length > 0) {
      const defenseNode = branch.children[0];
      defense = defenseNode.toMove();
      this._cursor = defenseNode;
    }

    const message =
      branch.children.length === 0
        ? '过关！'
        : `第 ${this.userMoveCount}/${this.totalUserMoves} 步正确`;
    return { accepted: true, message, defenseReply: defense };
  }

  /** 分支着法与用户走子按起终点匹配。 */
  private static matches(node: PuzzleMoveNode, move: Move): boolean {
    const branchMove = Move.fromUcci(node.ucci);
    if (branchMove === null) {
      return false;
    }

    return branchMove.from.equals(move.from) && branchMove.to.equals(move.to);
  }
}
