// @vitest-environment node
// 说明：本文件经 import.meta.url 读取 core/test-data 棋谱文件，jsdom 环境下
// import.meta.url 是 http 方案（readFileSync 拒绝非 file URL），故显式回到 node 环境。
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  GameMode,
  LessonLibrary,
  Piece,
  Position,
  PuzzleLibrary,
} from '@webchess/core';
import type {
  CancellationToken,
  EngineOptions,
  EngineSession,
  GoParams,
  MoveSource,
  MultiPvInfo,
  SearchResult,
} from '@webchess/core';
import type { AudioPlayer, KeyValueStorage, SoundEffect } from '@webchess/adapters';
import { AppController } from '../AppController.js';

/**
 * 五态模式路由集成测试（对应原 Godot Main.cs 的行为）。
 * AppController 不依赖 DOM，故可在 Node 环境中以内存适配器完整驱动。
 */

class MemoryStorage implements KeyValueStorage {
  readonly map = new Map<string, string>();
  read(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  write(key: string, value: string): void {
    this.map.set(key, value);
  }
  remove(key: string): void {
    this.map.delete(key);
  }
}

class RecordingAudio implements AudioPlayer {
  readonly played: SoundEffect[] = [];
  enabled = true;
  play(effect: SoundEffect): void {
    this.played.push(effect);
  }
  setEnabled(value: boolean): void {
    this.enabled = value;
  }
}

function lessonByTitle(title: string) {
  const lesson = LessonLibrary.find((l) => l.title === title);
  if (lesson === undefined) throw new Error(`缺少课程：${title}`);
  return lesson;
}

function puzzleById(id: string) {
  const puzzle = PuzzleLibrary.find((p) => p.id === id);
  if (puzzle === undefined) throw new Error(`缺少题目：${id}`);
  return puzzle;
}

function readManual(name: string): Uint8Array {
  const file = readFileSync(new URL(`../../../../core/test-data/${name}`, import.meta.url));
  return new Uint8Array(file);
}

/**
 * 测试引擎：分析请求（multiPv）立即返回；走子请求挂起待测试释放，
 * 用于精确控制引擎"思考"时长与应招内容。
 */
class ScriptedEngine implements EngineSession {
  readonly requests: GoParams[] = [];
  private readonly gates: ((result: SearchResult) => void)[] = [];
  private readonly infoListeners = new Set<(info: MultiPvInfo) => void>();
  isReady = true;
  /** 分析请求（multiPv）返回的 MultiPV 信息；空数组表示无 info。 */
  analysisInfos: readonly MultiPvInfo[] = [];

  onInfo(listener: (info: MultiPvInfo) => void): () => void {
    this.infoListeners.add(listener);
    return () => {
      this.infoListeners.delete(listener);
    };
  }

  async start(): Promise<void> {
    this.isReady = true;
  }

  async go(params: GoParams, _token?: CancellationToken): Promise<SearchResult> {
    this.requests.push(params);
    if (params.multiPv !== undefined) {
      for (const info of this.analysisInfos) {
        for (const listener of [...this.infoListeners]) {
          listener(info);
        }
      }

      return { bestMove: null, ponderMove: null };
    }

    return new Promise<SearchResult>((resolve) => {
      this.gates.push(resolve);
    });
  }

  async applyOptions(_options: EngineOptions): Promise<void> {}

  stop(): void {}

  async dispose(): Promise<void> {
    this.isReady = false;
  }

  /** 释放一次挂起的走子搜索并返回指定 bestmove（可标注着法来源）。 */
  releaseGo(bestMove: string, source?: MoveSource): void {
    this.gates.shift()?.(
      source === undefined
        ? { bestMove, ponderMove: null }
        : { bestMove, ponderMove: null, source },
    );
  }

  /** 已发出的走子（非分析）请求数。 */
  get moveRequests(): readonly GoParams[] {
    return this.requests.filter((p) => p.multiPv === undefined);
  }
}

describe('AppController 五态路由', () => {
  let storage: MemoryStorage;
  let audio: RecordingAudio;
  let controller: AppController;

  beforeEach(() => {
    storage = new MemoryStorage();
    audio = new RecordingAudio();
    controller = new AppController(storage, audio, null, true);
  });

  it('双人模式：两段式选子落子', () => {
    controller.onBoardClick(new Position(7, 7)); // 红炮
    expect(controller.getSnapshot().selected?.equals(new Position(7, 7))).toBe(true);
    expect(controller.getSnapshot().targets.length).toBeGreaterThan(0);

    controller.onBoardClick(new Position(4, 7)); // 炮二平五
    const snap = controller.getSnapshot();
    expect(snap.history).toHaveLength(1);
    expect(snap.lastMove?.toUcci()).toBe('h2e2');
    expect(snap.lastMoveCapture).toBeNull();
    expect(snap.redToMove).toBe(false);
    expect(audio.played).toContain('move');
  });

  it('吃子快照携带被吃棋子编码，悔棋后清空', () => {
    // 黑帅(4,0)、红车(4,4)、黑车(4,5)、红帅(3,9)：红车吃黑车。
    expect(controller.loadFen('4k4/9/9/9/4R4/4r4/9/9/9/3K5 w')).toBe(true);
    controller.onBoardClick(new Position(4, 4));
    controller.onBoardClick(new Position(4, 5));
    const snap = controller.getSnapshot();
    expect(snap.history).toHaveLength(1);
    expect(snap.lastMoveCapture).toBe(Piece.BlackRook);

    controller.undo();
    const reverted = controller.getSnapshot();
    expect(reverted.history).toHaveLength(0);
    expect(reverted.lastMove).toBeNull();
    expect(reverted.lastMoveCapture).toBeNull();
  });

  it('无引擎时切人机模式被拒绝', () => {
    controller.toggleMode();
    expect(controller.getSnapshot().mode).toBe(GameMode.TwoPlayers);
    expect(controller.getSnapshot().status).toContain('引擎未就绪');
  });

  it('悔棋回退一手', () => {
    controller.onBoardClick(new Position(7, 7));
    controller.onBoardClick(new Position(4, 7));
    expect(controller.getSnapshot().history).toHaveLength(1);
    controller.undo();
    expect(controller.getSnapshot().history).toHaveLength(0);
    expect(controller.getSnapshot().redToMove).toBe(true);
  });

  it('非法 FEN 载入被拒绝并给出提示', () => {
    expect(controller.loadFen('9/9 w')).toBe(false);
    expect(controller.getSnapshot().status).toContain('FEN 非法');
  });

  it('教学：完成马走日课程', () => {
    const lesson = lessonByTitle('马走日');
    controller.startLesson(lesson);
    let snap = controller.getSnapshot();
    expect(snap.practice).toBe('lesson');
    expect(snap.practiceTitle).toBe('马走日');

    const knight = new Position(4, 2);
    controller.onBoardClick(knight);
    controller.onBoardClick(new Position(3, 0));
    snap = controller.getSnapshot();
    expect(snap.history).toHaveLength(1);
    expect(snap.status).toContain(lesson.successText);
  });

  it('残局：走正解过关并持久化进度', () => {
    const puzzle = puzzleById('mate1-chongpao');
    controller.startPuzzle(puzzle);
    expect(controller.getSnapshot().practice).toBe('puzzle');

    // 先走一步错着：被拒绝且不推进。
    controller.onBoardClick(new Position(4, 3));
    controller.onBoardClick(new Position(4, 4));
    expect(controller.getSnapshot().status).toContain('请重试');

    // 正解：e7e8 = 车 (4,2) → (4,1)
    controller.onBoardClick(new Position(4, 2));
    controller.onBoardClick(new Position(4, 1));
    const snap = controller.getSnapshot();
    expect(snap.status).toContain('过关');
    expect(snap.solvedCount).toBe(1);
    // 进度已写入存储。
    expect(storage.read('puzzle_progress')).toContain('mate1-chongpao');
  });

  it('打谱：载入 XQF 棋谱并前进/回退', () => {
    controller.openManual({ name: '测试棋谱', bytes: readManual('test_manual_v10.xqf') });
    let snap = controller.getSnapshot();
    expect(snap.manualOpen).toBe(true);
    expect(snap.manualTotal).toBe(4);
    expect(snap.manualDepth).toBe(0);

    controller.manualForward();
    snap = controller.getSnapshot();
    expect(snap.manualDepth).toBe(1);
    expect(snap.history).toHaveLength(1);

    controller.undo();
    snap = controller.getSnapshot();
    expect(snap.manualDepth).toBe(0);
    expect(snap.history).toHaveLength(0);

    controller.manualForward();
    controller.manualRewind();
    expect(controller.getSnapshot().manualDepth).toBe(0);
  });

  it('打谱：PGN 棋谱可载入', () => {
    const text = readFileSync(
      new URL('../../../../core/test-data/manual_iccs.pgn', import.meta.url),
      'utf8',
    );
    controller.openManual({ name: 'ICCS 样例', text });
    expect(controller.getSnapshot().manualOpen).toBe(true);
    expect(controller.getSnapshot().manualTotal).toBeGreaterThan(0);
  });

  it('退出练习复位到新对局', () => {
    controller.startPuzzle(puzzleById('mate1-chongpao'));
    expect(controller.getSnapshot().practice).toBe('puzzle');
    controller.exitPractice();
    const snap = controller.getSnapshot();
    expect(snap.practice).toBe('none');
    expect(snap.history).toHaveLength(0);
    expect(snap.fen).toContain('rnbakabnr');
  });

  it('新局与音效开关', () => {
    controller.onBoardClick(new Position(7, 7));
    controller.onBoardClick(new Position(4, 7));
    controller.newGame();
    expect(controller.getSnapshot().history).toHaveLength(0);

    controller.setSoundEnabled(false);
    expect(audio.enabled).toBe(false);
  });

  it('订阅通知在状态变化时触发', () => {
    let notified = 0;
    const unsubscribe = controller.subscribe(() => {
      notified++;
    });
    controller.newGame();
    expect(notified).toBeGreaterThan(0);
    unsubscribe();
  });

  it('教学页行数据：列出课程并标记进行中', () => {
    const rows = controller.getLessonRows();
    expect(rows).toHaveLength(LessonLibrary.length);
    expect(rows.every((r) => r.title.length > 0 && r.intro.length > 0)).toBe(true);
    expect(rows.every((r) => !r.current)).toBe(true);

    controller.startLesson(lessonByTitle('马走日'));
    const current = controller.getLessonRows().filter((r) => r.current);
    expect(current).toHaveLength(1);
    expect(current[0]!.title).toBe('马走日');

    expect(controller.lessonAt(0)).not.toBeNull();
    expect(controller.lessonAt(999)).toBeNull();
  });

  it('残局页行数据：过关标记与尝试计数', () => {
    expect(controller.getPuzzleRows().every((r) => !r.solved && r.attempts === 0)).toBe(true);

    const puzzle = puzzleById('mate1-chongpao');
    controller.startPuzzle(puzzle);
    const row = controller.getPuzzleRows().find((r) => r.id === puzzle.id)!;
    expect(row.attempts).toBe(1);
    expect(row.current).toBe(true);

    expect(controller.puzzleAt(0)).not.toBeNull();
    expect(controller.puzzleAt(-1)).toBeNull();
  });

  it('打谱页行数据与着法跳转', () => {
    expect(controller.getManualRows()).toHaveLength(0);

    controller.openManual({ name: '测试棋谱', bytes: readManual('test_manual_v10.xqf') });
    const rows = controller.getManualRows();
    expect(rows).toHaveLength(4);
    expect(rows[0]!.depth).toBe(1);
    expect(rows[0]!.chinese.length).toBeGreaterThan(0);

    // 直接跳到终局
    controller.manualGotoDepth(4);
    let snap = controller.getSnapshot();
    expect(snap.manualDepth).toBe(4);
    expect(snap.history).toHaveLength(4);
    expect(snap.lastMove).not.toBeNull();
    expect(controller.getManualRows()[3]!.isCurrent).toBe(true);

    // 任意回跳
    controller.manualGotoDepth(2);
    snap = controller.getSnapshot();
    expect(snap.manualDepth).toBe(2);
    expect(snap.history).toHaveLength(2);

    // 越界跳转不生效
    controller.manualGotoDepth(9);
    expect(controller.getSnapshot().manualDepth).toBe(2);
  });
});

describe('AppController 人机模式回归（busy 门闸竞争 / 悔棋方向 / 点击反馈）', () => {
  let storage: MemoryStorage;
  let audio: RecordingAudio;
  let engine: ScriptedEngine;
  let controller: AppController;

  beforeEach(() => {
    storage = new MemoryStorage();
    audio = new RecordingAudio();
    engine = new ScriptedEngine();
    controller = new AppController(storage, audio, engine, true);
    controller.toggleMode(); // 切人机：用户执红先行
    expect(controller.getSnapshot().mode).toBe(GameMode.PlayWithEngine);
  });

  it('分析启用时按 MultiPV 给出未来步数箭头（分色序号由渲染按序绘制）', async () => {
    engine.analysisInfos = [
      {
        index: 1,
        depth: 14,
        scoreCp: 34,
        isMate: false,
        upperBound: false,
        lowerBound: false,
        pv: ['h2e2', 'h9g7'],
      },
      {
        index: 2,
        depth: 14,
        scoreCp: 12,
        isMate: false,
        upperBound: false,
        lowerBound: false,
        pv: ['b2e2', 'b9c7'],
      },
    ];

    await controller.analyze();
    const snap = controller.getSnapshot();
    expect(snap.analysisActive).toBe(true);
    expect(snap.evalLines).toHaveLength(2);
    expect(snap.arrows).toHaveLength(2);
    // 箭头按 PV 序排列：#1 炮二平五（h2e2）、#2 炮八平五（b2e2）。
    expect(snap.arrows[0]!.from.equals(new Position(7, 7))).toBe(true);
    expect(snap.arrows[0]!.to.equals(new Position(4, 7))).toBe(true);
    expect(snap.arrows[1]!.from.equals(new Position(1, 7))).toBe(true);
    expect(snap.arrows[1]!.to.equals(new Position(4, 7))).toBe(true);

    // 关闭分析后箭头与评估行一并清除。
    await controller.analyze();
    const off = controller.getSnapshot();
    expect(off.analysisActive).toBe(false);
    expect(off.arrows).toHaveLength(0);
    expect(off.evalLines).toHaveLength(0);
  });

  it('用户走子后引擎及时应手，无需切换模式（分析抢占门闸回归）', async () => {
    // 开启分析（历史上此处会抢占忙闲门闸，导致引擎走子请求被拒）。
    await controller.analyze();
    expect(engine.requests.filter((p) => p.multiPv !== undefined)).toHaveLength(1);

    controller.onBoardClick(new Position(7, 7)); // 选红炮
    controller.onBoardClick(new Position(4, 7)); // 炮二平五

    // 引擎走子请求已发出（未被分析抢占）。
    await vi.waitFor(() => {
      expect(engine.moveRequests).toHaveLength(1);
    });
    expect(controller.getSnapshot().busy).toBe(true);

    engine.releaseGo('h9g7'); // 引擎应招：马 8 进 7
    await vi.waitFor(() => {
      const snap = controller.getSnapshot();
      expect(snap.history).toHaveLength(2);
      expect(snap.busy).toBe(false);
      expect(snap.redToMove).toBe(true);
    });
    expect(controller.getSnapshot().lastMove?.toUcci()).toBe('h9g7');

    // 引擎落子后自动补跑挂起的分析（初始 1 次 + 引擎走子后 1 次）。
    await vi.waitFor(() => {
      expect(engine.requests.filter((p) => p.multiPv !== undefined)).toHaveLength(2);
    });
  });

  it('人机模式悔棋后轮到用户时引擎不代走（悔棋方向回归）', async () => {
    controller.onBoardClick(new Position(7, 7));
    controller.onBoardClick(new Position(4, 7)); // 用户走子
    await vi.waitFor(() => expect(engine.moveRequests).toHaveLength(1));
    engine.releaseGo('h9g7');
    await vi.waitFor(() => expect(controller.getSnapshot().history).toHaveLength(2));

    controller.undo(); // 人机模式连退两步：回到用户（红方）行棋
    const snap = controller.getSnapshot();
    expect(snap.history).toHaveLength(0);
    expect(snap.redToMove).toBe(true);

    // 等待若干事件循环后引擎仍未被请求走子（此前会替红方走一步）。
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(engine.moveRequests).toHaveLength(1);
    expect(controller.getSnapshot().history).toHaveLength(0);
  });

  it('引擎思考中点击棋盘给出提示而非静默忽略（点击反馈回归）', async () => {
    controller.onBoardClick(new Position(7, 7));
    controller.onBoardClick(new Position(4, 7)); // 用户走子，引擎开始思考
    await vi.waitFor(() => expect(controller.getSnapshot().busy).toBe(true));

    controller.onBoardClick(new Position(0, 0));
    expect(controller.getSnapshot().status).toBe('引擎思考中，请稍候…');

    engine.releaseGo('h9g7');
    await vi.waitFor(() => expect(controller.getSnapshot().history).toHaveLength(2));
  });

  it('切人机时轮到黑方则引擎立即应手', async () => {
    const fresh = new AppController(storage, audio, engine, true);
    // 双人模式先替黑方走一步，使切人机时轮黑。
    fresh.toggleMode(); // → 人机（红先，不触发）
    fresh.toggleMode(); // → 双人
    fresh.onBoardClick(new Position(7, 7));
    fresh.onBoardClick(new Position(4, 7)); // 红方走子，双人模式下轮黑
    fresh.toggleMode(); // → 人机且轮黑：引擎立即应手
    await vi.waitFor(() => expect(engine.moveRequests).toHaveLength(1));
    engine.releaseGo('h9g7');
    await vi.waitFor(() => expect(fresh.getSnapshot().history).toHaveLength(2));
  });

  it('引擎命中开局库（查表）时状态栏标注来源', async () => {
    controller.onBoardClick(new Position(7, 7));
    controller.onBoardClick(new Position(4, 7)); // 用户走子，引擎开始思考
    await vi.waitFor(() => expect(engine.moveRequests).toHaveLength(1));

    engine.releaseGo('h9g7', 'book');
    await vi.waitFor(() => expect(controller.getSnapshot().history).toHaveLength(2));

    const status = controller.getSnapshot().status;
    expect(status.startsWith('黑方：')).toBe(true);
    expect(status).toContain('（开局库）');
  });
});
