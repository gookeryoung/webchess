import { describe, expect, it } from 'vitest';
import { Board, Move, Piece } from '@webchess/core';
import { BoardRenderer, PieceImages, RenderState } from '../BoardRenderer.js';
import { createGeometry } from '../geometry.js';

/**
 * 走子动画渲染测试：验证被吃棋子在终点原位淡出（透明度递减、先于移动棋子绘制）。
 * 以记录型假 2D 上下文驱动，不依赖 DOM Canvas。
 */

class FakeContext {
  readonly drawCalls: { alpha: number; source: unknown }[] = [];
  globalAlpha = 1;
  fillStyle = '';
  strokeStyle = '';
  lineWidth = 0;
  lineCap = '';
  font = '';
  textAlign = '';
  textBaseline = '';

  drawImage(source: CanvasImageSource): void {
    this.drawCalls.push({ alpha: this.globalAlpha, source });
  }

  clearRect(): void {}
  fillRect(): void {}
  beginPath(): void {}
  moveTo(): void {}
  lineTo(): void {}
  stroke(): void {}
  strokeRect(): void {}
  arc(): void {}
  fill(): void {}
  fillText(): void {}
  closePath(): void {}
}

const images: PieceImages = { get: () => ({}) as CanvasImageSource };

function baseState(board: Board): RenderState {
  return {
    board,
    selected: null,
    targets: [],
    lastMove: null,
    checkedKing: null,
    arrows: [],
    hint: null,
    animation: null,
    animationCapture: null,
  };
}

describe('BoardRenderer 走子动画', () => {
  it('吃子动画：被吃子先于移动子绘制且透明度随进度递减', () => {
    // 黑帅(4,0)、红车(4,5)、红帅(3,9)；动画：红车 (4,4)→(4,5) 吃黑车（e5e4）。
    const board = Board.fromFen('4k4/9/9/9/9/4R4/9/9/9/3K5 w');
    const move = Move.fromUcci('e5e4');
    expect(move).not.toBeNull();
    const ctx = new FakeContext();
    const renderer = new BoardRenderer(images);
    const state: RenderState = {
      ...baseState(board),
      animation: { move: move!, progress: 0.25 },
      animationCapture: Piece.BlackRook,
    };

    renderer.render(ctx as unknown as CanvasRenderingContext2D, createGeometry(60), state);

    // 共 4 次贴图：黑帅、被吃黑车（淡出 0.75）、移动红车、红帅。
    expect(ctx.drawCalls.map((c) => c.alpha)).toEqual([1, 0.75, 1, 1]);
  });

  it('无吃子动画：不额外绘制被吃子', () => {
    const board = Board.fromFen('4k4/9/9/9/9/4R4/9/9/9/3K5 w');
    const move = Move.fromUcci('e5e4');
    const ctx = new FakeContext();
    const renderer = new BoardRenderer(images);
    const state: RenderState = {
      ...baseState(board),
      animation: { move: move!, progress: 0.5 },
      animationCapture: null,
    };

    renderer.render(ctx as unknown as CanvasRenderingContext2D, createGeometry(60), state);

    expect(ctx.drawCalls.map((c) => c.alpha)).toEqual([1, 1, 1]);
  });
});
