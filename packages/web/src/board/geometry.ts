import { Board, Position } from '@webchess/core';

/**
 * 棋盘几何：原 Godot 版使用 1240x1340 底图（格距 136、棋子 110、交叉点原点 77/60）。
 * Web 版改为矢量绘制棋盘（规避 2.1MB 底图，同时解决小程序 2MB 包体限制），
 * 但沿用相同的比例关系，棋子贴图可直接复用。
 */
export interface BoardGeometry {
  /** 相邻交叉点间距（像素）。 */
  cell: number;
  /** 最左交叉点中心 X。 */
  paddingX: number;
  /** 最上交叉点中心 Y。 */
  paddingY: number;
  /** 棋子直径。 */
  pieceSize: number;
  /** 画布宽。 */
  width: number;
  /** 画布高。 */
  height: number;
}

export function createGeometry(cell: number): BoardGeometry {
  const paddingX = Math.round(cell * 0.56);
  const paddingY = Math.round(cell * 0.43);
  const pieceSize = Math.round(cell * 0.81);
  return {
    cell,
    paddingX,
    paddingY,
    pieceSize,
    width: paddingX * 2 + (Board.Width - 1) * cell,
    height: paddingY * 2 + (Board.Height - 1) * cell,
  };
}

/** 交叉点中心坐标。 */
export function cellCenter(g: BoardGeometry, x: number, y: number): { x: number; y: number } {
  return { x: g.paddingX + x * g.cell, y: g.paddingY + y * g.cell };
}

/**
 * 命中测试：像素坐标 → 最近交叉点；远离棋盘网格返回 null。
 * 命中半径为半个格距（最近邻吸附），交叉点之间无死区——
 * 触屏手指中心偏移也能稳定选中，不再出现"点不中棋子"。
 */
export function hitTest(g: BoardGeometry, px: number, py: number): Position | null {
  const ix = Math.round((px - g.paddingX) / g.cell);
  const iy = Math.round((py - g.paddingY) / g.cell);
  if (ix < 0 || ix >= Board.Width || iy < 0 || iy >= Board.Height) {
    return null;
  }

  const center = cellCenter(g, ix, iy);
  const reach = g.cell / 2;
  if (Math.abs(px - center.x) > reach || Math.abs(py - center.y) > reach) {
    return null;
  }

  return new Position(ix, iy);
}
