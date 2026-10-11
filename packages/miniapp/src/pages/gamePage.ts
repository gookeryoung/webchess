import { Board, GameMode } from '@webchess/core';
import { AppController } from '../../../web/src/app/AppController.js';
import { BoardRenderer } from '../../../web/src/board/BoardRenderer.js';
import { createGeometry, hitTest } from '../../../web/src/board/geometry.js';
import { createWxAudioPlayer } from '../audio.js';
import { WxWorkerEngineClient } from '../engineClient.js';
import { loadPieceImages } from '../pieceImages.js';
import { createWxStorage } from '../storage.js';
import { requireWx } from '../wx.js';

/**
 * 对局页控制器（原生小程序）。
 *
 * 直接复用 Web 版 AppController（UI 框架无关：subscribe/getSnapshot 驱动
 * setData）与 BoardRenderer（只依赖 CanvasRenderingContext2D 抽象，
 * 微信 2d canvas 接口同构）。MVP 范围：人机/双人对局 + 悔棋 + 提示；
 * 动画与箭头（MultiPV 分析）暂不接入，标注为待复核。
 */

/** 棋盘画布几何常量（与 createGeometry 的比例关系一致：宽 9.12 格、高 9.86 格）。 */
const CELL_RATIO_X = 0.56 * 2 + 8;
const CELL_RATIO_Y = 0.43 * 2 + 9;

interface GamePageData {
  status: string;
  busy: boolean;
  isGameOver: boolean;
  turnText: string;
  modeText: string;
  modeButton: string;
  lastText: string;
  moveCount: number;
  boardHeight: number;
  soundOn: boolean;
}

interface CanvasQueryResult {
  node: {
    getContext(kind: '2d'): unknown;
    width: number;
    height: number;
    createImage(): { src: string; onload: (() => void) | null; onerror: (() => void) | null };
  };
  width: number;
  height: number;
  left: number;
  top: number;
}

interface TouchEventLike {
  changedTouches: readonly { clientX: number; clientY: number }[];
}

/** Page 配置对象的最小类型（wx Page() 无类型包，宽松声明）。 */
interface GamePageConfig {
  data: GamePageData;
  setData(partial: Partial<GamePageData>): void;
  onLoad(): void;
  onUnload(): void;
  onTouchEnd(event: TouchEventLike): void;
  onNewGame(): void;
  onUndo(): void;
  onHint(): void;
  onToggleMode(): void;
  onToggleSound(): void;
}

/** 生成对局页 Page 配置对象（由 pages/game/game.js 调用 Page()）。 */
export function createGamePage(): GamePageConfig {
  const wx = requireWx();

  // ---- 可变运行状态（闭包持有，Page 方法通过闭包访问）----
  let controller: AppController | null = null;
  let unsubscribe: (() => void) | null = null;
  let renderer = new BoardRenderer({ get: () => null });
  let ctx: CanvasRenderingContext2D | null = null;
  let geometry = createGeometry(1);
  let canvasLeft = 0;
  let canvasTop = 0;

  const audio = createWxAudioPlayer();

  function render(): void {
    if (ctx === null || controller === null) {
      return;
    }

    const snapshot = controller.getSnapshot();
    const board = Board.fromFen(snapshot.fen);
    renderer.render(ctx, geometry, {
      board,
      selected: snapshot.selected,
      targets: snapshot.targets,
      lastMove: snapshot.lastMove,
      checkedKing: snapshot.checkedKing,
      arrows: [],
      hint: snapshot.hint,
      animation: null,
      animationCapture: null,
    });
  }

  function sync(): void {
    if (controller === null) {
      return;
    }

    const snapshot = controller.getSnapshot();
    pageRef.setData({
      status: snapshot.status,
      busy: snapshot.busy,
      isGameOver: snapshot.isGameOver,
      turnText: snapshot.redToMove ? '红方走子' : '黑方走子',
      modeText: snapshot.mode === GameMode.PlayWithEngine ? '人机对局' : '双人对局',
      modeButton: snapshot.mode === GameMode.PlayWithEngine ? '切双人' : '切人机',
      lastText: snapshot.history.length > 0 ? snapshot.history[snapshot.history.length - 1].chs : '—',
      moveCount: snapshot.history.length,
      soundOn: audio.enabled,
    });
    render();
  }

  function initCanvas(): void {
    wx
      .createSelectorQuery()
      .select('#board')
      .fields({ node: true, size: true, rect: true })
      .exec((results: unknown[]) => {
        const res = results[0] as CanvasQueryResult | undefined;
        if (res === undefined || res.node === undefined) {
          return;
        }

        const dpr = wx.getWindowInfo().pixelRatio;
        res.node.width = Math.round(res.width * dpr);
        res.node.height = Math.round(res.height * dpr);
        canvasLeft = res.left;
        canvasTop = res.top;
        ctx = res.node.getContext('2d') as CanvasRenderingContext2D;
        ctx.scale(dpr, dpr);
        render();

        // 贴图加载完成后切换为 PNG 渲染；失败则保持矢量兜底。
        void loadPieceImages(res.node).then((images) => {
          renderer = new BoardRenderer(images);
          render();
        });
      });
  }

  const pageRef: GamePageConfig = {
    data: {
      status: '正在初始化…',
      busy: false,
      isGameOver: false,
      turnText: '红方走子',
      modeText: '双人对局',
      modeButton: '切人机',
      lastText: '—',
      moveCount: 0,
      boardHeight: 0,
      soundOn: true,
    },

    // 真机运行时由微信 Page 运行时提供 setData；此处实现仅供 TS 与兜底使用。
    setData(partial): void {
      Object.assign(this.data, partial);
    },

    onLoad(): void {
      // 引擎不可用时降级为双人对局（AppController 兼容 null 引擎）。
      let engine: WxWorkerEngineClient | null = null;
      try {
        engine = WxWorkerEngineClient.create();
      } catch {
        engine = null;
      }

      controller = new AppController(createWxStorage(), audio, engine, false);
      if (engine !== null) {
        controller.toggleMode();
      }

      unsubscribe = controller.subscribe(sync);
      sync();

      const windowInfo = wx.getWindowInfo();
      const cell = windowInfo.windowWidth / CELL_RATIO_X;
      pageRef.setData({ boardHeight: Math.round(cell * CELL_RATIO_Y) });
      wx.nextTick(initCanvas);
    },

    onUnload(): void {
      unsubscribe?.();
      unsubscribe = null;
      void controller?.dispose();
      controller = null;
      ctx = null;
    },

    onTouchEnd(event: TouchEventLike): void {
      const touch = event.changedTouches[0];
      if (touch === undefined || controller === null) {
        return;
      }

      const pos = hitTest(geometry, touch.clientX - canvasLeft, touch.clientY - canvasTop);
      if (pos !== null) {
        controller.onBoardClick(pos);
      }
    },

    onNewGame(): void {
      controller?.newGame();
    },

    onUndo(): void {
      controller?.undo();
    },

    onHint(): void {
      void controller?.requestHint();
    },

    onToggleMode(): void {
      controller?.toggleMode();
    },

    onToggleSound(): void {
      audio.setEnabled(!audio.enabled);
      sync();
    },
  };

  return pageRef;
}
