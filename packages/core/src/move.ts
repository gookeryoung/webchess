import { BOARD_HEIGHT, BOARD_WIDTH } from './constants.js';
import { Position } from './position.js';

/**
 * 一步走法（起点 + 终点）。吃子类型由走子前局面的终点棋子决定，不在本结构中携带。
 */
export class Move {
  readonly from: Position;
  readonly to: Position;

  constructor(from: Position, to: Position) {
    this.from = from;
    this.to = to;
  }

  /**
   * 解析 UCCI 着法字符串（如 "h2e2"：纵线 a-i 自左向右，横线 0-9 自下向上，y 取 9-y）。
   * @returns 解析成功返回着法，失败返回 null。
   */
  static fromUcci(ucci: string | null | undefined): Move | null {
    if (ucci === null || ucci === undefined || ucci.length !== 4) {
      return null;
    }

    const from = new Position(ucci.charCodeAt(0) - 97, 9 - (ucci.charCodeAt(1) - 48));
    const to = new Position(ucci.charCodeAt(2) - 97, 9 - (ucci.charCodeAt(3) - 48));
    if (!from.isValid || !to.isValid) {
      return null;
    }

    return new Move(from, to);
  }

  /** 编码为 UCCI 着法字符串（如 "h2e2"，y 取 9-y）。 */
  toUcci(): string {
    return (
      String.fromCharCode(97 + this.from.x) +
      (9 - this.from.y) +
      String.fromCharCode(97 + this.to.x) +
      (9 - this.to.y)
    );
  }

  /** 值相等比较（替代 C# record struct 的 ==）。 */
  equals(other: Move | null | undefined): boolean {
    return (
      other !== null &&
      other !== undefined &&
      this.from.equals(other.from) &&
      this.to.equals(other.to)
    );
  }

  toString(): string {
    return `${this.from.toString()}->${this.to.toString()}`;
  }
}

/** 供外部做边界校验（避免引入 Board 造成循环依赖）。 */
export const MOVE_BOUNDS = { width: BOARD_WIDTH, height: BOARD_HEIGHT };
