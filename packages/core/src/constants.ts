/**
 * 内核常量。单独成文件以避免 Board / Position / Fen 之间的模块循环依赖。
 * 移植自 SuperChess（Godot C#）Scripts/Core。
 */

/** 棋盘列数（x 方向，0-8，自左向右）。 */
export const BOARD_WIDTH = 9;

/** 棋盘行数（y 方向，0-9，自上向下）。 */
export const BOARD_HEIGHT = 10;

/** 棋盘格子总数。 */
export const BOARD_CELLS = BOARD_WIDTH * BOARD_HEIGHT;

/** 标准起始局面 FEN（https://www.xqbase.com/protocol/cchess_fen.htm）。 */
export const INITIAL_FEN = 'rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR w - - 0 1';

/** 格坐标 → 一维下标（行优先，原点左上）。 */
export function cellIndex(x: number, y: number): number {
  return y * BOARD_WIDTH + x;
}
