import { Board } from '../board.js';
import { Move } from '../move.js';
import { Rule } from '../rule.js';

/** 棋谱解析异常：文件格式非法或内容不受支持时抛出。 */
export class ManualFormatException extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ManualFormatException';
  }
}

/** 着法树节点：一步走法 + 注解 + 全部分支子树。 */
export class MoveNode {
  /** 本步走法；根节点为 null。 */
  readonly move: Move | null;

  /** 父节点；根节点为 null。 */
  readonly parent: MoveNode | null;

  /** 本步注解；无注解为 null。 */
  readonly annotation: string | null;

  /** 分支子树（第一个元素为主线后续，其余为变着分支）。 */
  readonly children: MoveNode[] = [];

  /** 创建根节点（无走法、无父节点）。 */
  constructor();
  /** @internal 由 {@link MoveNode.append} 使用。 */
  constructor(move: Move, parent: MoveNode, annotation: string | null);
  constructor(move?: Move, parent?: MoveNode, annotation?: string | null) {
    this.move = move ?? null;
    this.parent = parent ?? null;
    this.annotation = annotation ?? null;
  }

  /** 创建持有走法的子节点并挂到 parent 的分支列表末尾。 */
  static append(move: Move, parent: MoveNode, annotation: string | null = null): MoveNode {
    const node = new MoveNode(move, parent, annotation);
    parent.children.push(node);
    return node;
  }
}

/**
 * 打谱棋谱文档：初始局面 + 着法树。
 * 根节点不持有走法，每个子节点持有一步走法与其分支子树（第一个子节点为主线，其余为变着）。
 */
export class ManualDocument {
  /** 初始局面（着法树展开之前的局面）。 */
  readonly initialBoard: Board;

  /** 着法树根节点（move 为 null）。 */
  readonly root: MoveNode;

  /** XQF 版本号；PGN 来源文档为 0。 */
  version = 0;
  title = '';
  event = '';
  date = '';
  site = '';
  red = '';
  black = '';
  /** 对局结果（XQF 存中文描述，PGN 存标签原值）。 */
  result = '';
  /** 棋谱类型（全局/布局/中局/残局）。 */
  category = '';
  annotator = '';
  author = '';
  /** 整局注释（XQF 0x400 首记录携带；无则为 null）。 */
  annotation: string | null = null;

  /** 以初始局面构造文档。 */
  constructor(initialBoard: Board) {
    this.initialBoard = initialBoard;
    this.root = new MoveNode();
  }

  /**
   * 递归校验全部着法在对应局面下合法（复用 Rule 走法生成；
   * 分支子树各自从父局面出发校验）。
   */
  validateAllMoves(): boolean {
    return ManualDocument.validateNode(this.initialBoard, this.root);
  }

  private static validateNode(board: Board, node: MoveNode): boolean {
    for (const child of node.children) {
      const move = child.move;
      if (move === null || !ManualDocument.isLegalMove(board, move)) {
        return false;
      }

      const next = board.clone();
      next.doMove(move);
      if (!ManualDocument.validateNode(next, child)) {
        return false;
      }
    }

    return true;
  }

  private static isLegalMove(board: Board, move: Move): boolean {
    return Rule.getLegalMoves(board, move.from).some((m) => m.equals(move));
  }
}
