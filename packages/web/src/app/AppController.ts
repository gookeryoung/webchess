import {
  ChineseNotation,
  CancellationToken,
  EngineOptions,
  EngineSession,
  GameMode,
  GameSession,
  HistoryRecord,
  LessonController,
  LessonDefinition,
  LessonLibrary,
  ManualController,
  ManualDocument,
  ManualFormatException,
  Move,
  MoveNode,
  MultiPvInfo,
  Piece,
  PgnParser,
  Position,
  PuzzleController,
  PuzzleDefinition,
  PuzzleLibrary,
  PuzzleProgress,
  Rule,
  XqfParser,
} from '@webchess/core';
import { AudioPlayer, KeyValueStorage } from '@webchess/adapters';

/**
 * 应用控制器（对应原 Godot 版 Scripts/Main.cs）：装配内核会话与三个练习控制器，
 * 实现五态模式路由（双人 / 人机 / 教学 / 残局 / 打谱）与两段式选子落子交互。
 *
 * 与 UI 框架无关：只暴露 subscribe/getSnapshot，React 与小程序 setData 均可驱动。
 */

export type PracticeKind = 'none' | 'lesson' | 'puzzle' | 'manual';

export interface AppSnapshot {
  fen: string;
  redToMove: boolean;
  isGameOver: boolean;
  history: readonly HistoryRecord[];
  lastMove: Move | null;
  checkedKing: Position | null;
  selected: Position | null;
  targets: readonly Position[];
  hint: Move | null;
  arrows: readonly { from: Position; to: Position }[];
  mode: GameMode;
  busy: boolean;
  status: string;
  evalLines: readonly string[];
  analysisActive: boolean;
  practice: PracticeKind;
  practiceTitle: string;
  practiceHint: string;
  manualOpen: boolean;
  manualDepth: number;
  manualTotal: number;
  engineAvailable: boolean;
  solvedCount: number;
  puzzleTotal: number;
  gb18030Ready: boolean;
}

const PROGRESS_KEY = 'puzzle_progress';
const DEFENSE_DELAY_MS = 600;

export class AppController {
  private readonly session: GameSession;
  private readonly lessonController = new LessonController();
  private readonly puzzleController = new PuzzleController();
  private readonly manualController = new ManualController();
  private progress: PuzzleProgress;

  private readonly listeners = new Set<() => void>();
  private cached: AppSnapshot | null = null;

  // 可变 UI 状态（其余字段每次从内核派生）。
  private status = '欢迎使用 SuperChess Web';
  private selected: Position | null = null;
  private targets: readonly Position[] = [];
  private hint: Move | null = null;
  private arrows: readonly { from: Position; to: Position }[] = [];
  private lastMove: Move | null = null;
  private evalLines: readonly string[] = [];
  private analysisActive = false;
  private practice: PracticeKind = 'none';
  private practiceTitle = '';
  private practiceHint = '';

  constructor(
    private readonly storage: KeyValueStorage,
    private readonly audio: AudioPlayer,
    engine: EngineSession | null,
    private readonly gb18030Ready: boolean,
  ) {
    this.session = new GameSession(engine);
    if (engine !== null) {
      this.session.attachEngine(engine);
    }

    this.progress = PuzzleProgress.fromJson(this.storage.read(PROGRESS_KEY));

    this.session.onMoveApplied((e) => this.onMoveApplied(e));
    this.session.onBoardReverted(() => this.onBoardReverted());
    this.session.onHintProvided((move) => {
      this.hint = move;
      this.setStatus(`提示：${ChineseNotation.toChinese(this.session.board, move)}`);
    });
    this.session.onBusyChanged(() => this.emit());
  }

  // ---------- 订阅 ----------

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /**
   * 读取快照。缓存同一对象引用，供 React useSyncExternalStore 判定是否需要重渲染
   * （否则每次调用返回新对象会导致无限重渲染）。
   */
  getSnapshot = (): AppSnapshot => {
    if (this.cached === null) {
      this.cached = this.build();
    }

    return this.cached;
  };

  private build(): AppSnapshot {
    const board = this.session.board;
    return {
      fen: board.toFen(),
      redToMove: board.redToMove,
      isGameOver: this.session.isGameOver,
      history: this.session.history,
      lastMove: this.lastMove,
      checkedKing: Rule.isInCheck(board, board.redToMove) ? board.findKing(board.redToMove) : null,
      selected: this.selected,
      targets: this.targets,
      hint: this.hint,
      arrows: this.arrows,
      mode: this.session.mode,
      busy: this.session.busy,
      status: this.status,
      evalLines: this.evalLines,
      analysisActive: this.analysisActive,
      practice: this.practice,
      practiceTitle: this.practiceTitle,
      practiceHint: this.practiceHint,
      manualOpen: this.manualController.isOpen,
      manualDepth: this.manualController.currentDepth,
      manualTotal: this.manualController.mainlineCount,
      engineAvailable: this.session.engineAvailable,
      solvedCount: this.progress.solvedCount,
      puzzleTotal: PuzzleLibrary.length,
      gb18030Ready: this.gb18030Ready,
    };
  }

  /** 引擎就绪后由入口调用，刷新 engineAvailable 显示。 */
  notifyEngineReady(): void {
    this.emit();
  }

  // ---------- 交互 ----------

  /** 棋盘点击（两段式：选子 → 落子）。 */
  onBoardClick(pos: Position): void {
    if (this.session.busy) {
      return;
    }

    // 第二段：点击合法落点。
    if (this.selected !== null && this.targets.some((t) => t.equals(pos))) {
      const move = new Move(this.selected, pos);
      this.clearSelection();
      this.submitMove(move);
      return;
    }

    const board = this.session.board;
    const piece = board.getPieceAt(pos);
    if (Piece.isValid(piece) && Piece.isRed(piece) === board.redToMove) {
      this.selected = pos;
      this.targets = Rule.getLegalMoves(board, pos).map((m) => m.to);
      this.hint = null;
      this.audio.play('select');
      this.emit();
      return;
    }

    if (this.selected !== null) {
      this.audio.play('invalid');
    }
  }

  private clearSelection(): void {
    this.selected = null;
    this.targets = [];
    this.hint = null;
    this.emit();
  }

  /** 走子落地：练习控制器先行校验，再由会话统一落子。 */
  private submitMove(move: Move): void {
    if (this.lessonController.current !== null) {
      this.handleLessonMove(move);
      return;
    }

    if (this.puzzleController.current !== null) {
      this.handlePuzzleMove(move);
      return;
    }

    if (this.manualController.isOpen) {
      this.handleManualMove(move);
      return;
    }

    if (!this.session.tryPlayMove(move)) {
      this.audio.play('invalid');
      return;
    }

    if (this.session.mode === GameMode.PlayWithEngine) {
      void this.playEngineMove();
    }
  }

  private handleLessonMove(move: Move): void {
    const lesson = this.lessonController.current;
    if (lesson === null) {
      return;
    }

    const result = this.lessonController.evaluate(this.session.board, move);
    if (!result.accepted) {
      this.audio.play('invalid');
      this.setStatus(`【${lesson.title}】${result.message}`);
      return;
    }

    if (!this.session.tryPlayMove(move)) {
      this.audio.play('invalid');
      return;
    }

    if (this.lessonController.consumeApplied()) {
      this.audio.play('checkmate');
      this.setStatus(`【${lesson.title}】${lesson.successText}`);
    }
  }

  private handlePuzzleMove(move: Move): void {
    const puzzle = this.puzzleController.current;
    if (puzzle === null) {
      return;
    }

    const result = this.puzzleController.evaluate(move);
    if (!result.accepted) {
      this.audio.play('invalid');
      this.setStatus(`【${puzzle.title}】${result.message}`);
      return;
    }

    if (!this.session.tryPlayMove(move)) {
      this.audio.play('invalid');
      return;
    }

    if (result.defenseReply !== null) {
      this.setStatus(`【${puzzle.title}】${result.message}`);
      void this.playDefense(result.defenseReply);
      return;
    }

    this.audio.play('checkmate');
    this.progress.markSolved(puzzle.id);
    this.saveProgress();
    this.setStatus(`【${puzzle.title}】${result.message} 正解完成！`);
  }

  /** 延迟落防守着；期间锁定输入，退出练习则放弃。 */
  private async playDefense(defense: Move): Promise<void> {
    await delay(DEFENSE_DELAY_MS);
    if (this.puzzleController.current === null || this.puzzleController.isSolved) {
      return;
    }

    this.session.tryPlayMove(defense);
  }

  private handleManualMove(move: Move): void {
    const branch = this.manualController.findBranch(move);
    if (branch === null) {
      this.audio.play('invalid');
      const branches = this.manualController.branches.length;
      this.setStatus(
        branches > 1
          ? '【打谱】存在变着分支，请点击箭头落点选择分支着法'
          : this.manualController.isAtEnd
            ? '【打谱】已到棋谱终局'
            : '【打谱】棋谱无此着法，可点后退回溯',
      );
      return;
    }

    this.playManualMove(branch);
  }

  private playManualMove(node: MoveNode): void {
    const move = node.move;
    if (move === null) {
      return;
    }

    const chinese = ChineseNotation.toChinese(this.session.board, move);
    if (!this.session.tryPlayMove(move)) {
      this.audio.play('invalid');
      return;
    }

    this.manualController.advanceTo(node);
    this.reportManualPosition(node, chinese);
  }

  private reportManualPosition(current: MoveNode, chinese: string): void {
    const depth = this.manualController.currentDepth;
    const total = this.manualController.mainlineCount;
    let text = `【打谱】第 ${depth}/${total} 着 ${chinese}`;
    const branches = this.manualController.branches;
    if (branches.length > 1) {
      text += `（存在 ${branches.length} 个分支，点击落点选择）`;
      this.arrows = branches
        .filter((b) => b.move !== null)
        .map((b) => ({ from: b.move!.from, to: b.move!.to }));
    } else if (current.annotation !== null && current.annotation.length > 0) {
      text += `　注：${current.annotation}`;
      this.arrows = [];
    } else if (this.manualController.isAtEnd) {
      text += '（终局）';
      this.arrows = [];
    } else {
      this.arrows = [];
    }

    this.setStatus(text);
  }

  // ---------- 命令 ----------

  newGame(): void {
    this.exitPracticeControllers();
    this.session.newGame();
    this.practice = 'none';
    this.practiceTitle = '';
    this.practiceHint = '';
    this.arrows = [];
    this.setStatus('新对局：红先');
  }

  undo(): void {
    if (this.manualController.isOpen) {
      if (!this.manualController.moveBack()) {
        return;
      }

      this.session.undo();
      this.showBranchArrows();
      this.setStatus(
        `【打谱】第 ${this.manualController.currentDepth}/${this.manualController.mainlineCount} 着`,
      );
      return;
    }

    if (!this.session.undo()) {
      return;
    }

    this.setStatus('已悔棋');
    if (this.session.mode === GameMode.PlayWithEngine) {
      void this.playEngineMove();
    }
  }

  async requestHint(): Promise<void> {
    const move = await this.session.hintAsync(new CancellationToken());
    if (move === null) {
      this.setStatus('提示失败：引擎不可用或正在思考');
    }
  }

  async analyze(): Promise<void> {
    this.analysisActive = !this.analysisActive;
    if (!this.analysisActive) {
      this.evalLines = [];
      this.emit();
      return;
    }

    await this.refreshAnalysis();
  }

  private async refreshAnalysis(): Promise<void> {
    if (!this.analysisActive || this.session.busy) {
      return;
    }

    const infos = await this.session.analyzeAsync(GameSession.DefaultAnalyzeMultiPv);
    if (!this.analysisActive) {
      return;
    }

    this.evalLines = infos.map(
      (info) => `#${info.index} 深度 ${info.depth} ${formatScore(info)} ${info.pv.join(' ')}`,
    );
    this.emit();
  }

  toggleMode(): void {
    const next =
      this.session.mode === GameMode.PlayWithEngine ? GameMode.TwoPlayers : GameMode.PlayWithEngine;
    if (!this.session.setMode(next)) {
      this.setStatus(
        next === GameMode.PlayWithEngine
          ? '引擎未就绪，无法切换到人机模式'
          : '引擎思考中，暂不能切换模式',
      );
      return;
    }

    this.setStatus(next === GameMode.PlayWithEngine ? '人机模式：你执红先行' : '双人模式');
    if (next === GameMode.PlayWithEngine && !this.session.board.redToMove) {
      void this.playEngineMove();
    }
  }

  loadFen(fen: string): boolean {
    this.exitPracticeControllers();
    try {
      if (!this.session.loadFen(fen)) {
        this.setStatus('引擎思考中，暂不能载入局面');
        return false;
      }
    } catch (error) {
      this.setStatus(`FEN 非法：${error instanceof Error ? error.message : String(error)}`);
      return false;
    }

    this.practice = 'none';
    this.practiceTitle = '';
    this.practiceHint = '';
    this.arrows = [];
    this.setStatus('已载入 FEN 局面');
    return true;
  }

  async copyFen(): Promise<void> {
    const fen = this.session.board.toFen();
    try {
      await navigator.clipboard.writeText(fen);
      this.setStatus(`已复制 FEN：${fen}`);
    } catch {
      this.setStatus(`FEN：${fen}`);
    }
  }

  setEngineOptions(options: EngineOptions): void {
    void this.session.applyEngineOptionsAsync(options);
  }

  /** 音效开关（浏览器自动播放策略下默认静音直到首次交互）。 */
  setSoundEnabled(enabled: boolean): void {
    this.audio.setEnabled(enabled);
  }

  startLesson(lesson: LessonDefinition): void {
    this.exitPracticeControllers();
    if (!this.session.loadFen(lesson.fen)) {
      return;
    }

    this.lessonController.start(lesson);
    this.practice = 'lesson';
    this.practiceTitle = lesson.title;
    this.practiceHint = lesson.intro;
    this.setStatus(`【${lesson.title}】${lesson.intro}`);
  }

  startPuzzle(puzzle: PuzzleDefinition): void {
    this.exitPracticeControllers();
    if (!this.session.loadFen(puzzle.fen)) {
      return;
    }

    this.puzzleController.start(puzzle);
    this.progress.markAttempt(puzzle.id);
    this.saveProgress();
    this.practice = 'puzzle';
    this.practiceTitle = puzzle.title;
    this.practiceHint = puzzle.description;
    this.setStatus(`【${puzzle.title}】${puzzle.description}`);
  }

  /** 打开棋谱（PGN 文本或 XQF 字节）。 */
  openManual(source: { name: string; text?: string; bytes?: Uint8Array }): void {
    this.exitPracticeControllers();
    let doc: ManualDocument;
    try {
      if (source.bytes !== undefined) {
        doc = XqfParser.parse(source.bytes);
      } else if (source.text !== undefined) {
        doc = PgnParser.parse(source.text);
      } else {
        throw new ManualFormatException('缺少棋谱内容');
      }
    } catch (error) {
      this.setStatus(`棋谱解析失败：${error instanceof Error ? error.message : String(error)}`);
      return;
    }

    const valid = doc.validateAllMoves();
    this.session.loadFen(doc.initialBoard.toFen());
    this.manualController.open(doc);
    this.practice = 'manual';
    this.practiceTitle = source.name;
    this.practiceHint = [doc.title, doc.red && doc.black ? `${doc.red} vs ${doc.black}` : '', doc.result]
      .filter((s) => s.length > 0)
      .join(' · ');
    this.lastMove = null;
    this.showBranchArrows();
    this.setStatus(
      `【打谱】${source.name}${this.practiceHint ? ` · ${this.practiceHint}` : ''} — 共 ${this.manualController.mainlineCount} 着` +
        (valid ? '' : '（警告：含非法着法）'),
    );
  }

  manualForward(): void {
    const next = this.manualController.peekDefaultForward();
    if (next === null) {
      this.setStatus('【打谱】已到棋谱终局');
      return;
    }

    this.playManualMove(next);
  }

  manualRewind(): void {
    if (!this.manualController.isOpen) {
      return;
    }

    this.session.loadFen(this.manualController.initialFen);
    this.manualController.rewind();
    this.lastMove = null;
    this.showBranchArrows();
    this.setStatus(`【打谱】回到开局（共 ${this.manualController.mainlineCount} 着）`);
  }

  exitPractice(): void {
    this.exitPracticeControllers();
    this.session.newGame();
    this.practice = 'none';
    this.practiceTitle = '';
    this.practiceHint = '';
    this.arrows = [];
    this.setStatus('已退出练习，开始新对局');
  }

  private exitPracticeControllers(): void {
    this.lessonController.reset();
    this.puzzleController.clear();
    this.manualController.clear();
  }

  async playEngineMove(): Promise<void> {
    try {
      await this.session.requestEngineMoveAsync();
    } catch (error) {
      this.setStatus(`引擎走子失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // ---------- 内核事件 ----------

  private onMoveApplied(e: {
    move: Move;
    chinese: string;
    isCapture: boolean;
    isRedMove: boolean;
    isCheck: boolean;
    isCheckmate: boolean;
    isStalemate: boolean;
  }): void {
    this.audio.play(e.isCapture ? 'capture' : 'move');
    this.lastMove = e.move;
    if (this.manualController.isOpen === false) {
      this.arrows = [{ from: e.move.from, to: e.move.to }];
    }

    if (e.isCheckmate) {
      this.audio.play('checkmate');
      this.setStatus(e.isRedMove ? '红方胜（将死黑方）' : '黑方胜（将死红方）');
    } else if (e.isCheck) {
      this.audio.play('check');
      this.setStatus(`将军！${e.chinese}`);
    } else if (e.isStalemate) {
      this.setStatus(e.isRedMove ? '黑方困毙，红方胜' : '红方困毙，黑方胜');
    } else if (this.manualController.isOpen === false) {
      this.setStatus(`${e.isRedMove ? '红' : '黑'}方：${e.chinese}`);
    }

    void this.refreshAnalysis();
  }

  private onBoardReverted(): void {
    this.selected = null;
    this.targets = [];
    this.hint = null;
    this.evalLines = [];
    this.emit();
    if (this.manualController.isOpen) {
      this.showBranchArrows();
    }

    void this.refreshAnalysis();
  }

  private showBranchArrows(): void {
    this.arrows = this.manualController.branches
      .filter((b) => b.move !== null)
      .map((b) => ({ from: b.move!.from, to: b.move!.to }));
    this.emit();
  }

  // ---------- 内部 ----------

  private setStatus(status: string): void {
    this.status = status;
    this.emit();
  }

  private saveProgress(): void {
    this.storage.write(PROGRESS_KEY, this.progress.toJson());
  }

  /** 重算快照并通知订阅者。 */
  private emit(): void {
    this.cached = this.build();
    for (const listener of [...this.listeners]) {
      listener();
    }
  }

  async dispose(): Promise<void> {
    await this.session.dispose();
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function formatScore(info: Pick<MultiPvInfo, 'scoreCp' | 'isMate'>): string {
  return info.isMate ? `杀棋` : `${info.scoreCp > 0 ? '+' : ''}${info.scoreCp}`;
}

export { LessonLibrary, PuzzleLibrary };
