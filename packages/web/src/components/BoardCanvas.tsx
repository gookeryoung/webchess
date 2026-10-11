import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Board, Move } from '@webchess/core';
import { BoardRenderer, PieceImages, RenderState } from '../board/BoardRenderer.js';
import { BoardGeometry, createGeometry, hitTest } from '../board/geometry.js';
import { AppController, AppSnapshot } from '../app/AppController.js';

/**
 * 棋盘画布：负责尺寸自适应、渲染与输入。
 *
 * 输入统一走 Pointer Events——鼠标、触屏、手写笔共用一套事件，
 * 天然满足「同时支持鼠标与触屏」的要求（并在 CSS 侧禁用触摸滚动/缩放）。
 */
export function BoardCanvas({
  controller,
  snapshot,
  images,
}: {
  controller: AppController;
  snapshot: AppSnapshot;
  images: PieceImages | null;
}) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<BoardRenderer | null>(null);
  const [geom, setGeom] = useState<BoardGeometry | null>(null);
  const [animProgress, setAnimProgress] = useState(1);
  const animRef = useRef<{ move: Move; start: number } | null>(null);
  const prevMoveRef = useRef<Move | null>(null);

  // 渲染器随贴图就绪而创建。
  useEffect(() => {
    if (images !== null) {
      rendererRef.current = new BoardRenderer(images);
      setAnimProgress(1);
    }
  }, [images]);

  // 尺寸自适应（响应式布局）：容器宽度 → 格距。
  useLayoutEffect(() => {
    const wrapper = wrapperRef.current;
    if (wrapper === null) {
      return;
    }

    const measure = () => {
      const width = wrapper.clientWidth;
      if (width <= 0) {
        return;
      }

      const cell = width / 9.12;
      const next = createGeometry(cell);
      const maxHeight = Math.max(240, globalThis.innerHeight - 260);
      const scale = Math.min(1, maxHeight / next.height);
      setGeom(createGeometry(cell * scale));
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(wrapper);
    globalThis.addEventListener('orientationchange', measure);
    return () => {
      observer.disconnect();
      globalThis.removeEventListener('orientationchange', measure);
    };
  }, []);

  // 走子动画：最近一手变化时播放 150ms 缓动。
  useEffect(() => {
    const move = snapshot.lastMove;
    if (move !== null && !move.equals(prevMoveRef.current)) {
      animRef.current = { move, start: performance.now() };
      setAnimProgress(0);
      let raf = 0;
      const step = () => {
        const started = animRef.current?.start ?? 0;
        const t = Math.min(1, (performance.now() - started) / 150);
        setAnimProgress(t);
        if (t < 1) {
          raf = requestAnimationFrame(step);
        } else {
          animRef.current = null;
        }
      };

      raf = requestAnimationFrame(step);
      return () => cancelAnimationFrame(raf);
    }

    prevMoveRef.current = move;
    return undefined;
  }, [snapshot.lastMove]);

  // 绘制。
  useEffect(() => {
    const canvas = canvasRef.current;
    const renderer = rendererRef.current;
    if (canvas === null || geom === null) {
      return;
    }

    const dpr = Math.min(3, globalThis.devicePixelRatio || 1);
    if (canvas.width !== Math.round(geom.width * dpr)) {
      canvas.width = Math.round(geom.width * dpr);
      canvas.height = Math.round(geom.height * dpr);
    }

    const ctx = canvas.getContext('2d');
    if (ctx === null) {
      return;
    }

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const board = Board.fromFen(snapshot.fen);
    const anim = animRef.current;
    const state: RenderState = {
      board,
      selected: snapshot.selected,
      targets: snapshot.targets,
      lastMove: snapshot.lastMove,
      checkedKing: snapshot.checkedKing,
      arrows: snapshot.arrows,
      hint: snapshot.hint,
      animation: anim === null ? null : { move: anim.move, progress: animProgress },
      animationCapture: null,
    };

    if (renderer === null) {
      // 贴图未就绪时用矢量兜底渲染器，保证首屏即可交互。
      new BoardRenderer({ get: () => null }).render(ctx, geom, state);
      return;
    }

    renderer.render(ctx, geom, state);
  }, [geom, snapshot, animProgress, images]);

  const handlePointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (canvas === null || geom === null) {
      return;
    }

    const rect = canvas.getBoundingClientRect();
    const x = ((event.clientX - rect.left) / rect.width) * geom.width;
    const y = ((event.clientY - rect.top) / rect.height) * geom.height;
    const pos = hitTest(geom, x, y);
    if (pos !== null) {
      controller.onBoardClick(pos);
    }
  };

  return (
    <div className="board-wrapper" ref={wrapperRef}>
      <canvas
        ref={canvasRef}
        className="board-canvas"
        style={geom === null ? undefined : { width: geom.width, height: geom.height }}
        onPointerDown={handlePointerDown}
      />
    </div>
  );
}
