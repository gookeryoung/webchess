import { BOARD_HEIGHT } from './constants.js';
import { Board } from './board.js';
import { Move } from './move.js';
import { Piece } from './piece.js';
import { Position } from './position.js';

/**
 * 中文纵线着法生成（如「炮二平五」，移植自参考项目 Move.java getChsString）：
 * 红方用中文数字（纵线自右向左一至九），黑方用阿拉伯数字（自左向右 1-9）；
 * 同线同种棋子用前/后（三枚及以上含中，超过三枚用一至五）消歧。
 * 规范见 https://www.xqbase.com/protocol/cchess_move.htm。
 */
export class ChineseNotation {
  private static readonly ChineseNumerals: readonly string[] = [
    '一', '二', '三', '四', '五', '六', '七', '八', '九',
  ];

  /**
   * 生成一步走法的中文纵线记法。board 须为走子前局面。
   * @throws Error 起点无有效棋子时抛出。
   */
  static toChinese(board: Board, move: Move): string {
    const piece = board.getPieceAt(move.from);
    if (!Piece.isValid(piece)) {
      throw new Error(`走法起点 ${move.from.toString()} 无有效棋子`);
    }

    const name = Piece.toChineseName(piece) ?? '';
    const prefix = ChineseNotation.findSameFilePrefix(board, piece, move.from);

    if (Piece.isRed(piece)) {
      const num1 = ChineseNotation.ChineseNumerals[9 - move.from.x - 1];
      // 平取目标纵线；进退时直线棋子取步数、斜线棋子（马相仕）取目标纵线。
      const action =
        move.to.y < move.from.y ? '进' : move.to.y > move.from.y ? '退' : '平';
      const num2 =
        action === '平' || Piece.isDiagonalPiece(piece)
          ? ChineseNotation.ChineseNumerals[9 - move.to.x - 1]
          : ChineseNotation.ChineseNumerals[Math.abs(move.to.y - move.from.y) - 1];

      return prefix === null ? `${name}${num1}${action}${num2}` : `${prefix}${name}${action}${num2}`;
    }

    const num1 = (move.from.x + 1).toString();
    const action = move.to.y > move.from.y ? '进' : move.to.y < move.from.y ? '退' : '平';
    const num2 =
      action === '平' || Piece.isDiagonalPiece(piece)
        ? (move.to.x + 1).toString()
        : Math.abs(move.to.y - move.from.y).toString();

    return prefix === null ? `${name}${num1}${action}${num2}` : `${prefix}${name}${action}${num2}`;
  }

  /**
   * 同一纵线上存在同种棋子时的前/后/中/数字前缀；无歧义返回 null。
   * 局限（沿用参考项目）：多枚兵分居多条纵线时未按「从右到左再从前到后」全盘编号。
   */
  private static findSameFilePrefix(board: Board, piece: number, pos: Position): string | null {
    // 仕相与帅将纵线上同种棋子至多两枚且必然一进一退，无需消歧。
    if (
      piece === Piece.RedKing ||
      piece === Piece.BlackKing ||
      piece === Piece.RedAdvisor ||
      piece === Piece.BlackAdvisor ||
      piece === Piece.RedBishop ||
      piece === Piece.BlackBishop
    ) {
      return null;
    }

    // 扫描方向：红方自上向下（index 1 最靠近敌阵 = 前），黑方自下向上。
    const red = Piece.isRed(piece);
    const start = red ? 0 : BOARD_HEIGHT - 1;
    const end = red ? BOARD_HEIGHT : -1;
    const step = red ? 1 : -1;

    let count = 0;
    let index = 0;
    for (let y = start; y !== end; y += step) {
      if (board.getPiece(pos.x, y) === piece) {
        count++;
        if (y === pos.y) {
          index = count;
        }
      }
    }

    if (count === 1) {
      return null;
    }

    if (piece !== Piece.RedPawn && piece !== Piece.BlackPawn) {
      // 非兵卒同线同种棋子至多两枚。
      return index === 1 ? '前' : '后';
    }

    // 兵卒：三枚及以下用前/中/后，超过三枚用一至五（红中文、黑阿拉伯）。
    if (count <= 3) {
      if (index === 1) {
        return '前';
      }

      if (index === 2 && count === 3) {
        return '中';
      }

      return '后';
    }

    return red ? ChineseNotation.ChineseNumerals[index - 1] : index.toString();
  }
}
