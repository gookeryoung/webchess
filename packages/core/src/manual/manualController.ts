import { Move } from '../move.js';
import { ManualDocument, MoveNode } from './manualDocument.js';

/**
 * 打谱游标控制器（零平台依赖）：维护着法树游标，提供主线前进、后退、
 * 回开局与变着分支选择。局面落地由 UI 驱动 GameSession 完成（单步前进/后退走
 * tryPlayMove/undo 保留动画音效；游标与 GameSession 局面的同步不变量由调用顺序
 * 保证——仅在对应落子/悔棋/载入成功后调用 advanceTo/moveBack/rewind）。
 */
export class ManualController {
  private _document: ManualDocument | null = null;
  private _current: MoveNode | null = null;

  /** 当前棋谱文档；未打开时为 null。（命名避免遮蔽 DOM 全局 `document`） */
  get manual(): ManualDocument | null {
    return this._document;
  }

  /** 游标当前节点（着法树位置）；未打开时为 null。 */
  get current(): MoveNode | null {
    return this._current;
  }

  /** 是否已打开棋谱。 */
  get isOpen(): boolean {
    return this._document !== null;
  }

  /** 游标是否位于棋谱终局（无后续着法）。 */
  get isAtEnd(): boolean {
    return this._current === null || this._current.children.length === 0;
  }

  /** 当前节点的全部分支着法（单元素即主线，多元素含变着）。 */
  get branches(): readonly MoveNode[] {
    return this._current?.children ?? [];
  }

  /** 主线总着数（根节点沿第一个子节点到叶的长度）；未打开时为 0。 */
  get mainlineCount(): number {
    if (this._document === null) {
      return 0;
    }

    let count = 0;
    for (
      let node: MoveNode = this._document.root;
      node.children.length > 0;
      node = node.children[0]
    ) {
      count++;
    }

    return count;
  }

  /** 游标深度（根到当前节点走过的着数，开局为 0）。 */
  get currentDepth(): number {
    let depth = 0;
    for (let cursor = this._current; cursor?.move != null; cursor = cursor.parent) {
      depth++;
    }

    return depth;
  }

  /** 打开棋谱：游标复位到根节点（开局局面）。 */
  open(manual: ManualDocument): void {
    this._document = manual;
    this._current = manual.root;
  }

  /** 关闭棋谱（退出打谱时调用）。 */
  clear(): void {
    this._document = null;
    this._current = null;
  }

  /** 主线下一节点（第一个子节点）；无后续着法返回 null。 */
  peekDefaultForward(): MoveNode | null {
    return this._current !== null && this._current.children.length > 0
      ? this._current.children[0]
      : null;
  }

  /** 在当前节点的分支中按起终点查找节点（变着点击落点选择）；未命中返回 null。 */
  findBranch(move: Move): MoveNode | null {
    return (
      this._current?.children.find(
        (child) =>
          child.move !== null && child.move.from.equals(move.from) && child.move.to.equals(move.to),
      ) ?? null
    );
  }

  /**
   * 推进游标到目标节点（必须为当前节点的直接子节点）。
   * @throws Error 目标不是当前节点的子节点时抛出（编程错误）。
   */
  advanceTo(node: MoveNode): void {
    if (this._current === null || node.parent !== this._current) {
      throw new Error('目标节点不是当前游标的直接子节点');
    }

    this._current = node;
  }

  /** 游标后退一步；已在根节点（开局）返回 false。 */
  moveBack(): boolean {
    const parent = this._current?.parent;
    if (parent === undefined || parent === null) {
      return false;
    }

    this._current = parent;
    return true;
  }

  /** 游标复位到根节点（开局局面）。 */
  rewind(): void {
    if (this._document !== null) {
      this._current = this._document.root;
    }
  }

  /** 初始局面 FEN（回开局落地用）。 */
  get initialFen(): string {
    if (this._document === null) {
      throw new Error('尚未打开棋谱');
    }

    return this._document.initialBoard.toFen();
  }

  /**
   * 计算任意节点对应局面 FEN：从目标节点沿父链上溯到根收集走法序列，
   * 再从初始局面正向模拟（供跳转落地与测试断言）。
   */
  fenAt(node: MoveNode): string {
    if (this._document === null) {
      throw new Error('尚未打开棋谱');
    }

    const path: Move[] = [];
    for (let cursor: MoveNode | null = node; cursor?.move != null; cursor = cursor.parent) {
      path.push(cursor.move);
    }

    path.reverse();
    const board = this._document.initialBoard.clone();
    for (const move of path) {
      board.doMove(move);
    }

    return board.toFen();
  }
}
