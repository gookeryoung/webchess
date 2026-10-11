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
 * 命中测试：像素坐标 → 交叉点；落在棋子矩形之外返回 null。
 * 与原 BoardView.TryHit 同语义（只认棋子可点击区域，避免格子间空隙误触）。
 */
export function hitTest(g: BoardGeometry, px: number, py: number): Position | null {
  const ix = Math.round((px - g.paddingX) / g.cell);
  const iy = Math.round((py - g.paddingY) / g.cell);
  if (ix < 0 || ix >= Board.Width || iy < 0 || iy >= Board.Height) {
    return null;
  }

  const center = cellCenter(g, ix, iy);
  const half = g.pieceSize / 2;
  // 触屏手指较粗，命中判定放宽到整个格距的 90%。
  const reach = Math.max(half, g.cell * 0.45);
  if (Math.abs(px - center.x) > reach || Math.abs(py - center.y) > reach) {
    return null;
  }

  return new Position(ix, iy);
}
