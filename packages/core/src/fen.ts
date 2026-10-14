import { BOARD_HEIGHT, BOARD_WIDTH, INITIAL_FEN, cellIndex } from './constants.js';
import { Board } from './board.js';
import { Piece } from './piece.js';
import { Position } from './position.js';

/**
 * FEN 解析失败异常：携带出错的 FEN 字段名与原因，供 UI 显示明确错误。
 */
export class FenFormatException extends Error {
  /** 出错的 FEN 字段名（如「棋盘」「走子方」「回合数」「字段数」）。 */
  readonly fieldName: string;

  constructor(fieldName: string, reason: string) {
    super(`FEN 字段「${fieldName}」非法：${reason}`);
    this.name = 'FenFormatException';
    this.fieldName = fieldName;
  }
}

/**
 * FEN 局面编解码（https://www.xqbase.com/protocol/cchess_fen.htm）。
 * 格式：`<棋盘> <走子方 w/b> - - <半回合计数> <回合数>`，走子方 w 与 r 等价。
 */
export class Fen {
  /** 标准起始局面 FEN。 */
  static readonly initial = INITIAL_FEN;

  /**
   * 解析 FEN 并构造局面。宽松兼容仅含「棋盘 走子方」两个字段的短格式（计数取默认值）。
   * @throws FenFormatException 任一字段非法时抛出，含字段名与原因。
   */
  static toBoard(fen: string): Board {
    if (fen === null || fen === undefined || fen.trim().length === 0) {
      throw new FenFormatException('字段数', 'FEN 为空');
    }

    const parts = fen.trim().split(/\s+/);
    if (parts.length !== 2 && parts.length !== 6) {
      throw new FenFormatException('字段数', `应为 2 或 6 个字段，实际为 ${parts.length} 个`);
    }

    const cells = Fen.parseBoard(parts[0]);
    const redToMove = Fen.parseSide(parts[1]);
    let rounds = 1;
    if (parts.length === 6) {
      const halfmove = Number(parts[4]);
      if (!Number.isInteger(halfmove)) {
        throw new FenFormatException('半回合计数', `「${parts[4]}」不是整数`);
      }

      const parsedRounds = Number(parts[5]);
      if (!Number.isInteger(parsedRounds) || parsedRounds < 1) {
        throw new FenFormatException('回合数', `「${parts[5]}」应为不小于 1 的整数`);
      }

      rounds = parsedRounds;
    }

    return new Board(cells, redToMove, rounds);
  }

  /** 将局面编码为 6 字段 FEN 字符串。 */
  static fromBoard(board: Board): string {
    const rows: string[] = [];
    for (let y = 0; y < BOARD_HEIGHT; y++) {
      let row = '';
      let emptyRun = 0;
      for (let x = 0; x < BOARD_WIDTH; x++) {
        const piece = board.getPiece(x, y);
        if (piece === Piece.Empty) {
          emptyRun++;
        } else {
          if (emptyRun > 0) {
            row += emptyRun.toString();
            emptyRun = 0;
          }

          row += Piece.toFenChar(piece) ?? '';
        }
      }

      if (emptyRun > 0) {
        row += emptyRun.toString();
      }

      rows.push(row);
    }

    const side = board.redToMove ? 'w' : 'b';
    return `${rows.join('/')} ${side} - - 0 ${board.rounds}`;
  }

  /**
   * 局面键：取 FEN 的「棋盘 + 走子方」两字段，剔除回合数。
   * 同一局面经不同着法顺序（换位）到达时键相同，供判重与开局库查表使用。
   */
  static positionKey(fen: string): string {
    const parts = fen.trim().split(/\s+/);
    return parts.length >= 2 ? `${parts[0]} ${parts[1]}` : fen.trim();
  }

  /** 解析棋盘字段并校验：10 行、每行 9 列、棋子合法、双方各一将帅且在九宫内。 */
  private static parseBoard(boardField: string): Uint8Array {
    const rows = boardField.split('/');
    if (rows.length !== BOARD_HEIGHT) {
      throw new FenFormatException('棋盘', `应为 ${BOARD_HEIGHT} 行，实际为 ${rows.length} 行`);
    }

    const cells = new Uint8Array(BOARD_HEIGHT * BOARD_WIDTH);
    for (let y = 0; y < BOARD_HEIGHT; y++) {
      let x = 0;
      for (const c of rows[y]) {
        if (c >= '1' && c <= '9') {
          x += c.charCodeAt(0) - 48;
        } else {
          const piece = Piece.fromFenChar(c);
          if (piece === null) {
            throw new FenFormatException('棋盘', `第 ${y + 1} 行含非法字符「${c}」`);
          }

          if (x >= BOARD_WIDTH) {
            throw new FenFormatException('棋盘', `第 ${y + 1} 行超出 ${BOARD_WIDTH} 列`);
          }

          cells[cellIndex(x, y)] = piece;
          x++;
        }
      }

      if (x !== BOARD_WIDTH) {
        throw new FenFormatException('棋盘', `第 ${y + 1} 行仅描述 ${x} 列，应为 ${BOARD_WIDTH} 列`);
      }
    }

    Fen.validateKings(cells);
    return cells;
  }

  /** 校验双方各恰有一枚将帅，且均在各自九宫内。 */
  private static validateKings(cells: Uint8Array): void {
    let redKingCount = 0;
    let blackKingCount = 0;
    let redKingPos: Position = new Position(-1, -1);
    let blackKingPos: Position = new Position(-1, -1);
    for (let y = 0; y < BOARD_HEIGHT; y++) {
      for (let x = 0; x < BOARD_WIDTH; x++) {
        switch (cells[cellIndex(x, y)]) {
          case Piece.RedKing:
            redKingCount++;
            redKingPos = new Position(x, y);
            break;
          case Piece.BlackKing:
            blackKingCount++;
            blackKingPos = new Position(x, y);
            break;
          default:
            break;
        }
      }
    }

    if (redKingCount !== 1 || blackKingCount !== 1) {
      throw new FenFormatException(
        '棋盘',
        `帅与将须各恰有一枚，实际红帅 ${redKingCount} 枚、黑将 ${blackKingCount} 枚`,
      );
    }

    if (!Fen.isInPalace(redKingPos, true)) {
      throw new FenFormatException('棋盘', `红帅位于 ${redKingPos.toString()}，不在红方九宫内`);
    }

    if (!Fen.isInPalace(blackKingPos, false)) {
      throw new FenFormatException('棋盘', `黑将位于 ${blackKingPos.toString()}，不在黑方九宫内`);
    }
  }

  /** 坐标是否在指定方九宫内（x 3-5，红 y 7-9，黑 y 0-2）。 */
  private static isInPalace(pos: Position, red: boolean): boolean {
    return (
      pos.x >= 3 && pos.x <= 5 && pos.y >= (red ? 7 : 0) && pos.y <= (red ? 9 : 2)
    );
  }

  /** 解析走子方字段：w/r 为红方，b 为黑方。 */
  private static parseSide(side: string): boolean {
    if (side === 'w' || side === 'r') {
      return true;
    }

    if (side === 'b') {
      return false;
    }

    throw new FenFormatException('走子方', `「${side}」应为 w、r 或 b`);
  }
}
