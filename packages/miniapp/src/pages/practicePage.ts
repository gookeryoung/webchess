import { Board, hasGb18030Decoder } from '@webchess/core';
import { AppController } from '../../../web/src/app/AppController.js';
import { BoardRenderer } from '../../../web/src/board/BoardRenderer.js';
import { createGeometry, hitTest } from '../../../web/src/board/geometry.js';
import { createWxAudioPlayer } from '../audio.js';
import { loadManual, MANUAL_LIBRARY } from '../manuals.js';
import { loadPieceImages } from '../pieceImages.js';
import { createWxStorage } from '../storage.js';
import { requireWx } from '../wx.js';

/**
 * 练习页控制器（原生小程序）：教学 / 残局 / 打谱三合一，由路由参数 kind 区分。
 *
 * 直接复用 Web 版 AppController（练习控制器与五态路由均在其中，UI 框架无关）
 * 与 BoardRenderer。页面结构：棋盘在上，题库面板（列表）开合于下方；
 * 课程/残局点选即开局（走子走 AppController.onBoardClick 既有链路），
 * 打谱先选内置棋谱再逐着/跳转（着法列表点选 = manualGotoDepth）。
 */

/** 棋盘画布几何常量（与 gamePage 一致：宽 9.12 格、高 9.86 格）。 */
const CELL_RATIO_X = 0.56 * 2 + 8;
const CELL_RATIO_Y = 0.43 * 2 + 9;

const KIND_TITLES: Record<string, string> = {
  lesson: '入门课程',
  puzzle: '残局练习',
  manual: '打谱棋谱',
};

const DIFFICULTY_NAMES: Record<number, string> = {
  1: '一步杀',
  2: '两步杀',
  3: '三步杀',
  4: '进阶连杀',
};

/** 列表行数据（setData 可序列化的扁平结构）。 */
interface PracticeRowData {
  index: number;
  title: string;
  sub: string;
  flag: string;
  current: boolean;
  solved: boolean;
}

interface PracticePageData {
  kindText: string;
  status: string;
  hintText: string;
  boardHeight: number;
  showList: boolean;
  isManual: boolean;
  manualMode: boolean;
  depthText: string;
  rows: PracticeRowData[];
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

interface PickEventLike {
  currentTarget: { dataset: { index?: number } };
}

/** Page 配置对象的最小类型（wx Page() 无类型包，宽松声明）。 */
interface PracticePageConfig {
  data: PracticePageData;
  setData(partial: Partial<PracticePageData>): void;
  onLoad(query: Record<string, string | undefined>): void;
  onUnload(): void;
  onTouchEnd(event: TouchEventLike): void;
  onToggleList(): void;
  onPickRow(event: PickEventLike): void;
  onBack(): void;
  onForward(): void;
  onRewind(): void;
  onExit(): void;
}

/** 生成练习页 Page 配置对象（由 pages/practice/practice.js 调用 Page()）。 */
export function createPracticePage(): PracticePageConfig {
  const wx = requireWx();
  const audio = createWxAudioPlayer();

  // ---- 可变运行状态（闭包持有，Page 方法通过闭包访问）----
  let kind = 'lesson';
  let controller: AppController | null = null;
  let unsubscribe: (() => void) | null = null;
  let renderer = new BoardRenderer({ get: () => null });
  let ctx: CanvasRenderingContext2D | null = null;
  let geometry = createGeometry(1);
  let canvasLeft = 0;
  let canvasTop = 0;
  /** 题库面板开合（列表行仅在打开时重建，避免走子时频繁 setData）。 */
  let showList = true;
  /** 打谱已打开棋谱（决定列表内容是着法行还是棋谱来源行）。 */
  let manualMode = false;

  function render(): void {
    if (ctx === null || controller === null) {
      return;
    }

    const snapshot = controller.getSnapshot();
    renderer.render(ctx, geometry, {
      board: Board.fromFen(snapshot.fen),
      selected: snapshot.selected,
      targets: snapshot.targets,
      lastMove: snapshot.lastMove,
      checkedKing: snapshot.checkedKing,
      arrows: snapshot.arrows,
      hint: snapshot.hint,
      animation: null,
      animationCapture: null,
    });
  }

  /** 依据当前状态重建列表行（题库面板打开期间展示）。 */
  function buildRows(): PracticeRowData[] {
    if (controller === null) {
      return [];
    }

    if (kind === 'manual') {
      if (!manualMode) {
        return MANUAL_LIBRARY.map((entry, index) => ({
          index,
          title: entry.name,
          sub: '内置棋谱 · 点击打开',
          flag: '',
          current: false,
          solved: false,
        }));
      }

      return controller.getManualRows().map((row) => ({
        index: row.depth,
        title: row.chinese,
        sub: row.annotation !== null && row.annotation.length > 0 ? `注：${row.annotation}` : '',
        flag: row.branchCount > 1 ? `变${row.branchCount}` : '',
        current: row.isCurrent,
        solved: false,
      }));
    }

    if (kind === 'puzzle') {
      return controller.getPuzzleRows().map((row) => ({
        index: row.index,
        title: row.title,
        sub:
          (DIFFICULTY_NAMES[row.difficulty] ?? `${row.difficulty} 步`) +
          (row.attempts > 0 ? ` · 挑战 ${row.attempts} 次` : ''),
        flag: row.current ? '进行中' : '',
        current: row.current,
        solved: row.solved,
      }));
    }

    return controller.getLessonRows().map((row) => ({
      index: row.index,
      title: row.title,
      sub: row.intro,
      flag: row.current ? '进行中' : '',
      current: row.current,
      solved: false,
    }));
  }

  function sync(): void {
    if (controller === null) {
      return;
    }

    const snapshot = controller.getSnapshot();
    const manualActive = kind === 'manual' && manualMode;
    pageRef.setData({
      status: snapshot.status,
      hintText: snapshot.practiceHint,
      showList: showList,
      manualMode: manualActive,
      depthText: manualActive
        ? `第 ${snapshot.manualDepth}/${snapshot.manualTotal} 着`
        : kind === 'puzzle'
          ? `已过关 ${snapshot.solvedCount}/${snapshot.puzzleTotal} 题`
          : '',
      rows: showList ? buildRows() : pageRef.data.rows,
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

  const pageRef: PracticePageConfig = {
    data: {
      kindText: KIND_TITLES[kind] ?? '练习',
      status: '正在初始化…',
      hintText: '',
      boardHeight: 0,
      showList: true,
      isManual: false,
      manualMode: false,
      depthText: '',
      rows: [],
    },

    // 真机运行时由微信 Page 运行时提供 setData；此处实现仅供 TS 与兜底使用。
    setData(partial): void {
      Object.assign(this.data, partial);
    },

    onLoad(query): void {
      kind =
        typeof query.kind === 'string' && KIND_TITLES[query.kind] !== undefined
          ? query.kind
          : 'lesson';
      pageRef.setData({ kindText: KIND_TITLES[kind] ?? '练习', isManual: kind === 'manual' });

      // 练习不需要引擎：教学/残局由题库校验，打谱为人工重放，传 null 即可。
      controller = new AppController(createWxStorage(), audio, null, hasGb18030Decoder());
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

    onToggleList(): void {
      showList = !showList;
      sync();
    },

    onPickRow(event: PickEventLike): void {
      if (controller === null) {
        return;
      }

      const index = event.currentTarget.dataset.index;
      if (typeof index !== 'number') {
        return;
      }

      if (kind === 'manual') {
        if (!manualMode) {
          const entry = MANUAL_LIBRARY[index];
          if (entry === undefined) {
            return;
          }

          void loadManual(controller, entry, wx)
            .then(() => {
              if (controller === null) {
                return;
              }

              manualMode = true;
              sync();
            })
            .catch((error: unknown) => {
              if (controller !== null) {
                pageRef.setData({
                  status: `棋谱载入失败：${error instanceof Error ? error.message : String(error)}`,
                });
              }
            });
          return;
        }

        controller.manualGotoDepth(index);
        sync();
        return;
      }

      if (kind === 'puzzle') {
        const puzzle = controller.puzzleAt(index);
        if (puzzle !== null) {
          controller.startPuzzle(puzzle);
          showList = false;
          sync();
        }
        return;
      }

      const lesson = controller.lessonAt(index);
      if (lesson !== null) {
        controller.startLesson(lesson);
        showList = false;
        sync();
      }
    },

    onBack(): void {
      controller?.undo();
      sync();
    },

    onForward(): void {
      controller?.manualForward();
      sync();
    },

    onRewind(): void {
      controller?.manualRewind();
      sync();
    },

    onExit(): void {
      wx.navigateBack({ delta: 1 });
    },
  };

  return pageRef;
}
