import { Move } from '../move.js';

/**
 * 残局着法树节点：一着 UCCI 走法 + 分支子树。
 * 深度约定：根节点为空着法（深度 0），奇数深度为用户着（红），偶数深度为防守着（黑）。
 * 用户着节点在父节点 children 中并列多项即多正解；防守着节点恒唯一。
 */
export class PuzzleMoveNode {
  /** 本着 UCCI 串；根节点为空串。 */
  readonly ucci: string;

  /** 父节点；根节点为 null。 */
  parent: PuzzleMoveNode | null = null;

  /** 分支子树（用户着层为并列正解，防守着层恒单线）。 */
  readonly children: PuzzleMoveNode[] = [];

  constructor(ucci = '') {
    this.ucci = ucci;
  }

  /** 是否根节点（不持有走法）。 */
  get isRoot(): boolean {
    return this.ucci.length === 0;
  }

  /** 根到本节点的深度（根为 0，每着 +1）。 */
  get depth(): number {
    let depth = 0;
    for (let cursor = this as PuzzleMoveNode; cursor.parent !== null; cursor = cursor.parent) {
      depth++;
    }

    return depth;
  }

  /** 挂接已构建的子节点（重设其 parent 并追加到分支列表末尾）。 */
  addChild(child: PuzzleMoveNode): void {
    child.parent = this;
    this.children.push(child);
  }

  /** 解析本节点的走法（根节点抛异常）。 */
  toMove(): Move {
    const move = Move.fromUcci(this.ucci);
    if (move === null) {
      throw new Error(`节点含非法 UCCI 着法：${this.ucci}`);
    }

    return move;
  }
}

/** 一道残局练习题定义。 */
export interface PuzzleDefinition {
  /** 题目标识（如 "mate1-chongpao"）。 */
  readonly id: string;
  /** 题目标题。 */
  readonly title: string;
  /** 题目提示文案。 */
  readonly description: string;
  /** 难度（1=一步杀，2=两步杀，3=三步杀，4=四步及以上进阶）。 */
  readonly difficulty: number;
  /** 残局局面 FEN（走子方为用户方）。 */
  readonly fen: string;
  /** 着法树根节点。 */
  readonly root: PuzzleMoveNode;
}

/** 残局走子判定结果。 */
export interface PuzzleMoveResult {
  /** 是否接受该走子。 */
  readonly accepted: boolean;
  /** 提示文案：拒绝时为原因，接受时可为进度提示。 */
  readonly message: string;
  /** 主线防守着；用户着之后存在防守着时非空（UI 延迟落子），过关时为 null。 */
  readonly defenseReply: Move | null;
}
