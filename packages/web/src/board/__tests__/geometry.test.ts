import { describe, expect, it } from 'vitest';
import { Board, Position } from '@webchess/core';
import { cellCenter, createGeometry, hitTest } from '../geometry.js';

describe('createGeometry', () => {
  it('返回字段完整', () => {
    const g = createGeometry(136);
    expect(g).toHaveProperty('cell');
    expect(g).toHaveProperty('paddingX');
    expect(g).toHaveProperty('paddingY');
    expect(g).toHaveProperty('pieceSize');
    expect(g).toHaveProperty('width');
    expect(g).toHaveProperty('height');
  });

  it('cell 等于传入值', () => {
    expect(createGeometry(136).cell).toBe(136);
    expect(createGeometry(100).cell).toBe(100);
  });

  it('padding / pieceSize 按比例稳定', () => {
    const g = createGeometry(100);
    // paddingX = round(100 * 0.56) = 56
    expect(g.paddingX).toBe(56);
    // paddingY = round(100 * 0.43) = 43
    expect(g.paddingY).toBe(43);
    // pieceSize = round(100 * 0.81) = 81
    expect(g.pieceSize).toBe(81);
  });

  it('width / height 能容纳整个棋盘', () => {
    const g = createGeometry(100);
    // width = paddingX * 2 + (9 - 1) * cell = 56*2 + 8*100 = 912
    expect(g.width).toBe(56 * 2 + 8 * 100);
    // height = paddingY * 2 + (10 - 1) * cell = 43*2 + 9*100 = 986
    expect(g.height).toBe(43 * 2 + 9 * 100);
  });

  it('cell 变化时所有尺寸按比例缩放', () => {
    const a = createGeometry(100);
    const b = createGeometry(200);
    expect(b.paddingX / a.paddingX).toBeCloseTo(2, 0);
    expect(b.paddingY / a.paddingY).toBeCloseTo(2, 0);
    expect(b.pieceSize / a.pieceSize).toBeCloseTo(2, 0);
  });
});

describe('cellCenter', () => {
  it('返回 (paddingX + x*cell, paddingY + y*cell)', () => {
    const g = createGeometry(100);
    // (0,0) 应是左上角 padding 点
    expect(cellCenter(g, 0, 0)).toEqual({ x: 56, y: 43 });
    // (4,4) 中心
    expect(cellCenter(g, 4, 4)).toEqual({ x: 56 + 4 * 100, y: 43 + 4 * 100 });
    // (8,9) 右下角
    expect(cellCenter(g, 8, 9)).toEqual({ x: 56 + 800, y: 43 + 900 });
  });
});

describe('hitTest', () => {
  const g = createGeometry(100);

  it('命中棋盘正中心', () => {
    // (4, 4) 中心坐标
    const px = 56 + 4 * 100;
    const py = 43 + 4 * 100;
    const result = hitTest(g, px, py);
    expect(result).toBeInstanceOf(Position);
    expect(result?.x).toBe(4);
    expect(result?.y).toBe(4);
  });

  it('命中棋盘左上角交叉点', () => {
    const result = hitTest(g, 56, 43);
    expect(result).toBeInstanceOf(Position);
    expect(result?.x).toBe(0);
    expect(result?.y).toBe(0);
  });

  it('棋盘外返回 null', () => {
    // 在 padding 区域外
    expect(hitTest(g, 0, 0)).toBeNull();
    // 在右下角外
    expect(hitTest(g, g.width + 10, g.height + 10)).toBeNull();
    // 负数
    expect(hitTest(g, -10, -10)).toBeNull();
  });

  it('格子间隙正中点吸附到最近交叉点（无死区）', () => {
    // 两格中心之间的正中点：最近邻吸附（reach = cell/2 = 50），
    // 不再因 10% 死区而点空——修复"棋子选取困难"。
    const betweenX = 56 + 100 * 0.5; // x=0 与 x=1 中心正中间
    const result = hitTest(g, betweenX, 43);
    expect(result).toBeInstanceOf(Position);
    expect(result?.y).toBe(0);
    expect([0, 1]).toContain(result?.x);
  });

  it('靠近交叉点但有偏移仍能命中（触屏放宽规则）', () => {
    // 距离中心 40px 的位置应命中（< reach=50）
    const center = cellCenter(g, 4, 4);
    const result = hitTest(g, center.x + 40, center.y - 40);
    expect(result).toBeInstanceOf(Position);
  });

  it('网格内任意点必命中最近交叉点（全覆盖）', () => {
    // 在整个棋盘网格区域均匀采样，任何一点都应命中某个交叉点。
    for (let fx = 0; fx <= 8; fx += 0.25) {
      for (let fy = 0; fy <= 9; fy += 0.25) {
        const px = 56 + fx * 100;
        const py = 43 + fy * 100;
        const p = hitTest(g, px, py);
        expect(p).not.toBeNull();
        expect(Math.abs(p!.x - fx)).toBeLessThanOrEqual(0.5);
        expect(Math.abs(p!.y - fy)).toBeLessThanOrEqual(0.5);
      }
    }
  });

  it('Position 边界覆盖棋盘全部格', () => {
    // 确保 x=0..8, y=0..9 每个交叉点都能命中
    for (let x = 0; x < Board.Width; x++) {
      for (let y = 0; y < Board.Height; y++) {
        const c = cellCenter(g, x, y);
        const p = hitTest(g, c.x, c.y);
        expect(p).not.toBeNull();
        expect(p?.x).toBe(x);
        expect(p?.y).toBe(y);
      }
    }
  });
});
