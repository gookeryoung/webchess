import { BOARD_HEIGHT, BOARD_WIDTH } from './constants.js';

/**
 * 棋盘格坐标（x 列 0-8 自左向右，y 行 0-9 自上向下，原点在左上）。
 *
 * C# 原实现为 `readonly record struct`，具备值相等语义；TypeScript 无值类型，
 * 故显式实现 {@link Position.equals}，所有集合比较一律走该方法而非 `===`。
 */
export class Position {
  readonly x: number;
  readonly y: number;

  constructor(x: number, y: number) {
    this.x = x;
    this.y = y;
  }

  /** 坐标是否落在棋盘内。 */
  get isValid(): boolean {
    return this.x >= 0 && this.x < BOARD_WIDTH && this.y >= 0 && this.y < BOARD_HEIGHT;
  }

  /** 值相等比较（替代 C# record struct 的 ==）。 */
  equals(other: Position | null | undefined): boolean {
    return other !== null && other !== undefined && this.x === other.x && this.y === other.y;
  }

  toString(): string {
    return `(${this.x}, ${this.y})`;
  }
}
