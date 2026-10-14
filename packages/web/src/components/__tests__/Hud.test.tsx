import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { EngineOptions, GameMode } from '@webchess/core';
import { AppController, AppSnapshot } from '../../app/AppController.js';
import { Hud } from '../Hud.js';

/** 构造快照基线（覆盖 Hud 读取的全部字段，用例按需覆盖差异字段）。 */
function makeSnapshot(overrides: Partial<AppSnapshot> = {}): AppSnapshot {
  return {
    fen: 'rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR w',
    redToMove: true,
    isGameOver: false,
    result: 'ongoing',
    isDraw: false,
    history: [],
    lastMove: null,
    lastMoveCapture: null,
    checkedKing: null,
    selected: null,
    targets: [],
    hint: null,
    arrows: [],
    mode: GameMode.TwoPlayers,
    busy: false,
    status: '欢迎使用 SuperChess Web',
    evalLines: [],
    analysisActive: false,
    practice: 'none',
    practiceTitle: '',
    practiceHint: '',
    manualOpen: false,
    manualDepth: 0,
    manualTotal: 0,
    engineAvailable: true,
    solvedCount: 0,
    puzzleTotal: 50,
    gb18030Ready: true,
    ...overrides,
  };
}

/** Hud 只调用控制器的事件方法，用 mock 替身即可驱动全部交互分支。 */
function makeController() {
  return {
    newGame: vi.fn(),
    undo: vi.fn(),
    requestHint: vi.fn(() => Promise.resolve()),
    analyze: vi.fn(() => Promise.resolve()),
    toggleMode: vi.fn(),
    exitPractice: vi.fn(),
    copyFen: vi.fn(() => Promise.resolve()),
    loadFen: vi.fn(),
    setEngineOptions: vi.fn(),
    setSoundEnabled: vi.fn(),
    manualRewind: vi.fn(),
    manualForward: vi.fn(),
  } as unknown as AppController;
}

function renderHud(snapshot: AppSnapshot, controller: AppController) {
  return render(
    <Hud
      controller={controller}
      snapshot={snapshot}
      onOpenLessons={() => undefined}
      onOpenPuzzles={() => undefined}
      onOpenManuals={() => undefined}
    />,
  );
}

describe('Hud', () => {
  it('渲染状态行与基础操作按钮', () => {
    renderHud(makeSnapshot(), makeController());

    expect(screen.getByText('欢迎使用 SuperChess Web')).toBeInTheDocument();
    for (const name of ['新局', '悔棋', '提示', '分析', '双人', '入门课程', '残局练习', '打谱']) {
      expect(screen.getByRole('button', { name })).toBeInTheDocument();
    }
  });

  it('点击新局/悔棋/提示/分析转发到控制器', async () => {
    const user = userEvent.setup();
    const controller = makeController();
    renderHud(makeSnapshot(), controller);

    await user.click(screen.getByRole('button', { name: '新局' }));
    await user.click(screen.getByRole('button', { name: '悔棋' }));
    await user.click(screen.getByRole('button', { name: '提示' }));
    await user.click(screen.getByRole('button', { name: '分析' }));

    expect(controller.newGame).toHaveBeenCalledTimes(1);
    expect(controller.undo).toHaveBeenCalledTimes(1);
    expect(controller.requestHint).toHaveBeenCalledTimes(1);
    expect(controller.analyze).toHaveBeenCalledTimes(1);
  });

  it('人机模式按钮点亮并显示「人机」', () => {
    renderHud(makeSnapshot({ mode: GameMode.PlayWithEngine }), makeController());

    const toggle = screen.getByRole('button', { name: '人机' });
    expect(toggle).toHaveClass('btn-on');
  });

  it('练习态出现「退出练习」并转发退出事件', async () => {
    const user = userEvent.setup();
    const controller = makeController();
    renderHud(
      makeSnapshot({ practice: 'lesson', practiceTitle: '第一课：棋盘与走子' }),
      controller,
    );

    // 练习标题徽标由 App 层渲染，Hud 不重复展示。
    expect(screen.queryByText('第一课：棋盘与走子')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '退出练习' }));
    expect(controller.exitPractice).toHaveBeenCalledTimes(1);
  });

  it('打谱态显示进度徽标与前进/后退/开局按钮', async () => {
    const user = userEvent.setup();
    const controller = makeController();
    renderHud(
      makeSnapshot({ manualOpen: true, manualDepth: 3, manualTotal: 12 }),
      controller,
    );

    expect(screen.getByText('3/12')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '⏮ 开局' }));
    await user.click(screen.getByRole('button', { name: '⏪ 后退' }));
    await user.click(screen.getByRole('button', { name: '前进 ⏩' }));
    expect(controller.manualRewind).toHaveBeenCalledTimes(1);
    expect(controller.undo).toHaveBeenCalledTimes(1);
    expect(controller.manualForward).toHaveBeenCalledTimes(1);
  });

  it('分析态渲染引擎输出行', () => {
    renderHud(
      makeSnapshot({ analysisActive: true, evalLines: ['depth 8 +0.35', 'depth 8 -0.12'] }),
      makeController(),
    );

    expect(screen.getByText('depth 8 +0.35')).toBeInTheDocument();
    expect(screen.getByText('depth 8 -0.12')).toBeInTheDocument();
  });

  it('元信息行：走子方 / 残局进度 / 忙闲 / 结束标志', () => {
    renderHud(
      makeSnapshot({ busy: true, isGameOver: true, result: 'black-win', solvedCount: 6 }),
      makeController(),
    );

    expect(screen.getByText('红方走子')).toBeInTheDocument();
    expect(screen.getByText('残局 6/50 已过关')).toBeInTheDocument();
    expect(screen.getByText('思考中…')).toBeInTheDocument();
    expect(screen.getByText('黑方胜')).toBeInTheDocument();
  });

  it('判和局面显示和棋标志', () => {
    renderHud(
      makeSnapshot({ isGameOver: true, isDraw: true, result: 'draw' }),
      makeController(),
    );

    expect(screen.getByText('和棋')).toBeInTheDocument();
  });

  it('GB18030 未就绪时给出降级提示', () => {
    renderHud(makeSnapshot({ gb18030Ready: false }), makeController());

    expect(
      screen.getByText('GB18030 未就绪（中文棋谱元信息降级）'),
    ).toBeInTheDocument();
  });

  it('载入 FEN：打开弹窗输入后回调控制器', async () => {
    const user = userEvent.setup();
    const controller = makeController();
    renderHud(makeSnapshot(), controller);

    await user.click(screen.getByRole('button', { name: '载入 FEN' }));
    const input = screen.getByPlaceholderText('rnbakabnr/9/1c5c1/... w - - 0 1');
    await user.type(input, '4k4/9/9/9/9/9/9/9/9/4K4 w');

    await user.click(screen.getByRole('button', { name: '载入' }));
    expect(controller.loadFen).toHaveBeenCalledWith('4k4/9/9/9/9/9/9/9/9/4K4 w');
    // 弹窗随确认关闭。
    expect(screen.queryByPlaceholderText('rnbakabnr/9/1c5c1/... w - - 0 1')).not.toBeInTheDocument();
  });

  it('载入 FEN：空输入不回调', async () => {
    const user = userEvent.setup();
    const controller = makeController();
    renderHud(makeSnapshot(), controller);

    await user.click(screen.getByRole('button', { name: '载入 FEN' }));
    await user.click(screen.getByRole('button', { name: '载入' }));

    expect(controller.loadFen).not.toHaveBeenCalled();
  });

  it('引擎设置：限制棋力并应用 Elo', async () => {
    const user = userEvent.setup();
    const controller = makeController();
    renderHud(makeSnapshot(), controller);

    await user.click(screen.getByRole('button', { name: '引擎设置' }));
    await user.click(screen.getByLabelText('限制棋力（UCI_Elo）'));
    // 滑杆默认 1600。
    await user.click(screen.getByRole('button', { name: '应用' }));

    const expected: EngineOptions = { limitStrength: true, elo: 1600 };
    expect(controller.setEngineOptions).toHaveBeenCalledWith(expected);
  });

  it('音效开关：点击后关闭音效并再次点击恢复', async () => {
    const user = userEvent.setup();
    const controller = makeController();
    renderHud(makeSnapshot(), controller);

    const toggle = screen.getByRole('button', { name: '音效' });
    expect(toggle).toHaveClass('btn-on'); // 默认开启

    await user.click(toggle);
    expect(controller.setSoundEnabled).toHaveBeenLastCalledWith(false);

    await user.click(toggle);
    expect(controller.setSoundEnabled).toHaveBeenLastCalledWith(true);
  });

  it('关于弹窗可打开关闭', async () => {
    const user = userEvent.setup();
    renderHud(makeSnapshot(), makeController());

    await user.click(screen.getByRole('button', { name: '关于' }));
    expect(screen.getByRole('heading', { name: '关于 SuperChess Web' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '好的' }));
    expect(
      screen.queryByRole('heading', { name: '关于 SuperChess Web' }),
    ).not.toBeInTheDocument();
  });
});
