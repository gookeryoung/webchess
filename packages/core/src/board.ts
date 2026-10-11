import { BOARD_CELLS, BOARD_HEIGHT, BOARD_WIDTH, INITIAL_FEN, cellIndex } from './constants.js';
import { Fen } from './fen.js';
import { Move } from './move.js';
import { Piece } from './piece.js';
import { Position } from './position.js';

/**
 * 棋盘局面：Uint8Array(90)（index = y * 9 + x，y 行 x 列，原点左上），含走子方与回合数。
 * 移植自 SuperChess（Godot C#）Scripts/Core/Board.cs（不含 Zobrist/score，MVP 无需）。
 *
 * 说明：C# 原实现使用 `int[10,9]` 二维数组；TypeScript 中以一维 TypedArray 表示，
 * 既避免嵌套数组开销，也便于 clone 时整体复制。
 */
export class Board {
  /** 棋盘列数。 */
  static readonly Width = BOARD_WIDTH;

  /** 棋盘行数。 */
  static readonly Height = BOARD_HEIGHT;

  private readonly _cells: Uint8Array;
  private _redToMove: boolean;
  private _rounds: number;

  /**
   * 构造局面。
   * @param cells 棋子矩阵，省略时使用标准起始局面（会被复制，不共享引用）。
   * @param redToMove 当前是否轮到红方走子。
   * @param rounds 回合数（每走半着 +1）。
   */
  constructor(cells?: Uint8Array, redToMove = true, rounds = 1) {
    this._cells = cells ? Uint8Array.from(cells) : Board.createInitialCells();
    this._redToMove = redToMove;
    this._rounds = rounds;
  }

  /** 棋盘格子（行优先一维数组），仅供只读访问；改动请用 getPieceAt/setPiece/doMove。 */
  get cells(): Readonly<Uint8Array> {
    return this._cells;
  }

  /** 当前是否轮到红方走子。 */
  get redToMove(): boolean {
    return this._redToMove;
  }

  /** 回合数（每走半着 +1，与参考项目语义一致，写入 FEN 第 6 字段）。 */
  get rounds(): number {
    return this._rounds;
  }

  /** 从 FEN 构造局面；非法 FEN 抛 FenFormatException（含字段名与原因）。 */
  static fromFen(fen: string): Board {
    return Fen.toBoard(fen);
  }

  /** 编码为 6 字段 FEN 字符串。 */
  toFen(): string {
    return Fen.fromBoard(this);
  }

  /** 深拷贝局面。 */
  clone(): Board {
    return new Board(this._cells, this._redToMove, this._rounds);
  }

  /** 读取 (x, y) 处棋子；越界返回 -1。 */
  getPiece(x: number, y: number): number {
    return x >= 0 && x < BOARD_WIDTH && y >= 0 && y < BOARD_HEIGHT
      ? this._cells[cellIndex(x, y)]
      : -1;
  }

  /** 读取指定坐标处棋子；越界返回 -1。 */
  getPieceAt(pos: Position): number {
    return this.getPiece(pos.x, pos.y);
  }

  /**
   * 设置 (x, y) 处棋子（供走法模拟与局面编辑使用，不翻边、不计回合）；
   * 越界或非法棋子值返回 false。
   */
  setPiece(x: number, y: number, piece: number): boolean {
    if (x < 0 || x >= BOARD_WIDTH || y < 0 || y >= BOARD_HEIGHT) {
      return false;
    }

    if (piece !== Piece.Empty && !Piece.isValid(piece)) {
      return false;
    }

    this._cells[cellIndex(x, y)] = piece;
    return true;
  }

  /**
   * 在棋盘上执行一步走法：移动棋子、翻边、回合数 +1。
   * 走法合法性由 Rule 校验，本方法仅验证起点有子。
   * @returns 起点有子且坐标合法返回 true，否则返回 false 且棋盘不变。
   */
  doMove(move: Move): boolean {
    const piece = this.getPieceAt(move.from);
    if (!Piece.isValid(piece) || !move.from.isValid || !move.to.isValid) {
      return false;
    }

    this._cells[cellIndex(move.to.x, move.to.y)] = piece;
    this._cells[cellIndex(move.from.x, move.from.y)] = Piece.Empty;
    this._redToMove = !this._redToMove;
    this._rounds++;
    return true;
  }

  /** 定位指定方的将/帅位置；不存在返回 null。 */
  findKing(red: boolean): Position | null {
    const target = red ? Piece.RedKing : Piece.BlackKing;
    for (let y = 0; y < BOARD_HEIGHT; y++) {
      for (let x = 0; x < BOARD_WIDTH; x++) {
        if (this._cells[cellIndex(x, y)] === target) {
          return new Position(x, y);
        }
      }
    }

    return null;
  }

  /** 构造标准起始局面的棋子矩阵。 */
  private static createInitialCells(): Uint8Array {
    const cells = new Uint8Array(BOARD_CELLS);
    // 起始 FEN 为内置常量，解析必然成功，直接复用 Fen 的行解析逻辑。
    const boardField = INITIAL_FEN.split(' ')[0];
    const rows = boardField.split('/');
    for (let y = 0; y < BOARD_HEIGHT; y++) {
      let x = 0;
      for (const c of rows[y]) {
        if (c >= '1' && c <= '9') {
          x += c.charCodeAt(0) - 48;
        } else {
          const piece = Piece.fromFenChar(c);
          if (piece !== null) {
            cells[cellIndex(x, y)] = piece;
          }

          x++;
        }
      }
    }

    return cells;
  }
}
