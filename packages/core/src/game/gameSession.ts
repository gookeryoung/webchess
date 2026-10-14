import { Board } from '../board.js';
import { ChineseNotation } from '../chineseNotation.js';
import { Fen } from '../fen.js';
import { Move } from '../move.js';
import { Piece } from '../piece.js';
import { Rule } from '../rule.js';
import { CancellationToken } from '../cancellation.js';
import { Emitter, Listener, Unsubscribe } from '../events.js';
import {
  EngineOptions,
  EngineSession,
  GoParams,
  MoveSource,
  MultiPvInfo,
} from '../engine/engineTypes.js';
import {
  DrawReason,
  GameMode,
  GameResult,
  HistoryRecord,
  MoveAppliedEventArgs,
} from './gameTypes.js';
import { endgamePhase, isMaterialDeadDraw } from './endgameTable.js';

/**
 * 对局会话（忙闲门闸）：持有局面与走子历史，驱动双人/人机对弈回合流转。
 * 引擎思考中（busy）拒绝走子/悔棋/提示等互斥操作；新对局取消搜索并以
 * 代际计数丢弃迟到的引擎结果。零平台依赖，可独立单测。
 *
 * 移植自 SuperChess Scripts/Game/GameSession.cs：
 * - C# `event Action<T>` → {@link Emitter}
 * - C# `CancellationToken` → `AbortSignal`
 * - C# `Task` → `Promise`
 */
export class GameSession {
  /** 引擎搜索默认深度。 */
  static readonly DefaultSearchDepth = 12;

  /**
   * 引擎走子默认时限（毫秒）：迭代加深在时限内尽量搜深，
   * 保证人机对局每步及时响应（深度只作为上限，不作为耗时保证）。
   */
  static readonly DefaultMoveTimeMs = 1000;

  /** 残局走子时限（毫秒）：子力少时同深度耗时更低，缩短等待而棋力基本不损。 */
  static readonly EndgameMoveTimeMs = 600;

  /** 自然限着（半着数）：连续无吃子达到该值判和（与自对弈竞技场终局语义一致）。 */
  static readonly NaturalLimitPlies = 120;

  /** 分析模式默认深度。 */
  static readonly DefaultAnalyzeDepth = 14;

  /** 分析模式默认 MultiPV 路数。 */
  static readonly DefaultAnalyzeMultiPv = 3;

  private readonly _history: HistoryRecord[] = [];
  private _board: Board = new Board();
  private _engine: EngineSession | null;
  private _searchGeneration = 0;
  private _searchToken: CancellationToken | null = null;
  private _busy = false;
  /** 局面键出现次数（含起始局面），用于三次重复判和。 */
  private _positionCounts = new Map<string, number>();
  /** 连续无吃子半着数，用于自然限着判和。 */
  private _noCapturePlies = 0;
  /** 和棋原因（非 null 即对局已判和；悔棋/新局/载入会重算）。 */
  private _drawReason: DrawReason | null = null;
  /** 最近一次引擎走子的来源（开局库 / 搜索），供 UI 标注。 */
  private _lastEngineSource: MoveSource | null = null;

  private readonly _moveApplied = new Emitter<MoveAppliedEventArgs>();
  private readonly _boardReverted = new Emitter<void>();
  private readonly _hintProvided = new Emitter<Move>();
  private readonly _busyChanged = new Emitter<boolean>();

  /** 构造对局会话；engine 为 null 时引擎功能不可用（双人模式仍可完整对弈）。 */
  constructor(engine: EngineSession | null = null) {
    this._engine = engine;
    this.recordPosition();
  }

  /** 当前对局模式。 */
  mode: GameMode = GameMode.TwoPlayers;

  /** 当前局面。 */
  get board(): Board {
    return this._board;
  }

  /** 走子历史（尾部为最新一手）。 */
  get history(): readonly HistoryRecord[] {
    return this._history;
  }

  /** 引擎是否可用（已附加引擎会话）。 */
  get engineAvailable(): boolean {
    return this._engine !== null;
  }

  /** 对局是否结束（将死、困毙或判和）。 */
  get isGameOver(): boolean {
    return this.result !== 'ongoing';
  }

  /** 对局结果：进行中 / 红胜 / 黑胜 / 和棋（将死、困毙、三次重复、自然限着）。 */
  get result(): GameResult {
    if (
      Rule.isCheckmate(this._board, this._board.redToMove) ||
      Rule.isStalemate(this._board, this._board.redToMove)
    ) {
      // 轮到走子的一方被将死或困毙，判负（对方胜）；将死/困毙优先于判和。
      return this._board.redToMove ? 'black-win' : 'red-win';
    }

    return this._drawReason !== null ? 'draw' : 'ongoing';
  }

  /** 是否判和（三次重复局面 / 自然限着）。 */
  get isDraw(): boolean {
    return this._drawReason !== null;
  }

  /** 和棋原因；未判和返回 null。 */
  get drawReason(): DrawReason | null {
    return this._drawReason;
  }

  /** 最近一次引擎走子来源（开局库 / 搜索）；尚未走过或已重置返回 null。 */
  get lastEngineSource(): MoveSource | null {
    return this._lastEngineSource;
  }

  /** 引擎是否思考中（忙闲门闸：busy 期间拒绝走子/悔棋/提示/切模式）。 */
  get busy(): boolean {
    return this._busy;
  }

  /** 引擎搜索深度。 */
  searchDepth = GameSession.DefaultSearchDepth;

  /** 自然限着（半着数）：连续无吃子达到该值判和；默认 120，可调整以便测试。 */
  naturalLimitPlies = GameSession.NaturalLimitPlies;

  /** 一步走子被应用（人类或引擎）。 */
  onMoveApplied(listener: Listener<MoveAppliedEventArgs>): Unsubscribe {
    return this._moveApplied.add(listener);
  }

  /** 局面被整体恢复（悔棋/新对局/载入 FEN），UI 应全量重绘。 */
  onBoardReverted(listener: Listener<void>): Unsubscribe {
    return this._boardReverted.add(listener);
  }

  /** 引擎给出提示着法（不落子）。 */
  onHintProvided(listener: Listener<Move>): Unsubscribe {
    return this._hintProvided.add(listener);
  }

  /** 忙闲状态切换（true=引擎开始思考）。 */
  onBusyChanged(listener: Listener<boolean>): Unsubscribe {
    return this._busyChanged.add(listener);
  }

  /**
   * 附加引擎会话；busy 期间拒绝。
   * 引擎经构造函数注入时同实例重复附加视为幂等成功。
   */
  attachEngine(engine: EngineSession): boolean {
    if (this.busy || (this._engine !== null && this._engine !== engine)) {
      return false;
    }

    this._engine = engine;
    return true;
  }

  /** 切换对局模式；引擎不可用或 busy 期间返回 false。 */
  setMode(mode: GameMode): boolean {
    if (this.busy || mode === this.mode) {
      return false;
    }

    if (mode === GameMode.PlayWithEngine && !this.engineAvailable) {
      return false;
    }

    this.mode = mode;
    return true;
  }

  /**
   * 应用一步人类走法：校验走子方归属与合法性后落子、记历史、发 moveApplied。
   * busy（引擎思考中）或对局已结束时返回 false。
   */
  tryPlayMove(move: Move): boolean {
    if (this.busy || this.isGameOver) {
      return false;
    }

    return this.applyMoveCore(move);
  }

  /**
   * 走法校验与落子的公共实现（不检查 busy：引擎代落的着法在 busy 期间到达）。
   * 走子方归属或走法非法返回 false。
   */
  private applyMoveCore(move: Move): boolean {
    const piece = this._board.getPieceAt(move.from);
    if (
      !Piece.isValid(piece) ||
      Piece.isRed(piece) !== this._board.redToMove ||
      !Rule.isLegalMove(this._board, move)
    ) {
      return false;
    }

    const isRedMove = Piece.isRed(piece);
    const captured = this._board.getPieceAt(move.to);
    const chinese = ChineseNotation.toChinese(this._board, move);
    this._board.doMove(move);
    this._history.push({ move, ucci: move.toUcci(), chs: chinese, isRedMove });

    // 终局跟踪：三次重复局面 + 自然限着（连续无吃子）。
    this._noCapturePlies = Piece.isValid(captured) ? 0 : this._noCapturePlies + 1;
    this.recordPosition();
    const isCheckmate = Rule.isCheckmate(this._board, this._board.redToMove);
    const isStalemate = Rule.isStalemate(this._board, this._board.redToMove);
    if (isCheckmate || isStalemate) {
      // 将死/困毙优先于判和。
      this._drawReason = null;
    } else if (isMaterialDeadDraw(this._board)) {
      // 残局查表命中「双方均无进攻子力」死和签名。
      this._drawReason = 'material';
    } else {
      const repetition = (this._positionCounts.get(this.currentPositionKey()) ?? 0) >= 3;
      const naturalLimit = this._noCapturePlies >= this.naturalLimitPlies;
      this._drawReason =
        repetition || naturalLimit ? (repetition ? 'repetition' : 'natural-limit') : null;
    }

    this._moveApplied.emit({
      move,
      chinese,
      isCapture: Piece.isValid(captured),
      capturedPiece: captured,
      isRedMove,
      isCheck: Rule.isInCheck(this._board, this._board.redToMove),
      isCheckmate,
      isStalemate,
      isDraw: this._drawReason !== null,
      drawReason: this._drawReason,
    });
    return true;
  }

  /** 当前局面的判重键（棋盘 + 走子方，剔除回合数）。 */
  private currentPositionKey(): string {
    return Fen.positionKey(this._board.toFen());
  }

  /** 当前局面在本次对局中的出现次数 +1。 */
  private recordPosition(): void {
    const key = this.currentPositionKey();
    this._positionCounts.set(key, (this._positionCounts.get(key) ?? 0) + 1);
  }

  /**
   * 从当前局面重放历史、重算判和状态（悔棋后必须重算，否则和棋标记会残留）。
   */
  private recomputeDrawState(): void {
    this._positionCounts = new Map<string, number>();
    this._noCapturePlies = 0;
    this._drawReason = null;

    const board = new Board();
    this.recordPositionFor(board);

    for (const record of this._history) {
      const captured = board.getPieceAt(record.move.to);
      board.doMove(record.move);
      this._noCapturePlies = Piece.isValid(captured) ? 0 : this._noCapturePlies + 1;
      this.recordPositionFor(board);
    }

    const repetition = (this._positionCounts.get(Fen.positionKey(board.toFen())) ?? 0) >= 3;
    const naturalLimit = this._noCapturePlies >= this.naturalLimitPlies;
    this._drawReason = isMaterialDeadDraw(board)
      ? 'material'
      : repetition || naturalLimit
        ? repetition
          ? 'repetition'
          : 'natural-limit'
        : null;
  }

  /** 指定局面的判重键计数 +1（重算路径用，避免依赖 _board 当前态）。 */
  private recordPositionFor(board: Board): void {
    const key = Fen.positionKey(board.toFen());
    this._positionCounts.set(key, (this._positionCounts.get(key) ?? 0) + 1);
  }

  /** 重置判和跟踪并登记当前局面（新局 / 载入 FEN 用）。 */
  private resetTracking(): void {
    this._positionCounts = new Map<string, number>();
    this._noCapturePlies = 0;
    this._lastEngineSource = null;
    this.recordPosition();
    // 载入的局面本身可能已是「无进攻子力」死和（残局查表命中）。
    this._drawReason = isMaterialDeadDraw(this._board) ? 'material' : null;
  }

  /**
   * 请求引擎走一步（人机模式）：搜索当前局面并把 bestmove 落子。
   * 新对局/悔棋导致的代际变化会丢弃过期结果。
   */
  async requestEngineMoveAsync(token?: CancellationToken): Promise<boolean> {
    if (
      this._engine === null ||
      this.mode !== GameMode.PlayWithEngine ||
      this.busy ||
      this.isGameOver
    ) {
      return false;
    }

    this.setBusy(true);
    try {
      const generation = ++this._searchGeneration;
      const controller = new CancellationToken();
      const unlink = controller.linkTo(token);
      this._searchToken = controller;
      try {
        const result = await this._engine.go(this.buildGoParams(), controller);
        if (generation !== this._searchGeneration || this.isGameOver || result.bestMove === null) {
          return false;
        }

        this._lastEngineSource = result.source ?? 'search';
        const move = Move.fromUcci(result.bestMove);
        return move !== null && this.applyMoveCore(move);
      } finally {
        unlink();
        this._searchToken = null;
      }
    } finally {
      this.setBusy(false);
    }
  }

  /**
   * 悔棋：人机模式连退两步（引擎 + 人类），双人模式退一步；历史不足则退到初始局面。
   * busy 期间返回 false。
   */
  undo(): boolean {
    if (this.busy || this._history.length === 0) {
      return false;
    }

    const popCount = this.mode === GameMode.PlayWithEngine ? Math.min(2, this._history.length) : 1;
    this._history.splice(this._history.length - popCount, popCount);
    this.rebuildBoard();
    // 悔棋可能撤销了导致判和的一着：重算判和状态，否则和棋标记会残留。
    this.recomputeDrawState();
    this._lastEngineSource = null;
    this._boardReverted.emit(undefined);
    return true;
  }

  /** 向引擎请求一步提示（不落子）；busy、对局结束或引擎不可用时返回 null。 */
  async hintAsync(token?: CancellationToken): Promise<Move | null> {
    if (this._engine === null || this.busy || this.isGameOver) {
      return null;
    }

    this.setBusy(true);
    try {
      const generation = ++this._searchGeneration;
      const controller = new CancellationToken();
      const unlink = controller.linkTo(token);
      this._searchToken = controller;
      try {
        const result = await this._engine.go(this.buildGoParams(), controller);
        if (generation !== this._searchGeneration || result.bestMove === null) {
          return null;
        }

        const move = Move.fromUcci(result.bestMove);
        if (move !== null) {
          this._hintProvided.emit(move);
        }

        return move;
      } finally {
        unlink();
        this._searchToken = null;
      }
    } finally {
      this.setBusy(false);
    }
  }

  /** 开始新对局：清空历史并复位初始局面；引擎思考中则先取消搜索。 */
  newGame(): void {
    if (this.busy) {
      this._searchGeneration++;
      this._searchToken?.cancel();
      this._engine?.stop();
    }

    this._history.length = 0;
    this._board = new Board();
    this.resetTracking();
    this._boardReverted.emit(undefined);
  }

  /** 载入 FEN 局面；清空历史。busy 期间返回 false，非法 FEN 抛 FenFormatException。 */
  loadFen(fen: string): boolean {
    if (this.busy) {
      return false;
    }

    this._board = Board.fromFen(fen);
    this._history.length = 0;
    this.resetTracking();
    this._boardReverted.emit(undefined);
    return true;
  }

  /** 下发引擎强度选项；busy 或引擎未附加时返回 false。 */
  async applyEngineOptionsAsync(options: EngineOptions): Promise<boolean> {
    if (this._engine === null || this.busy) {
      return false;
    }

    await this._engine.applyOptions(options);
    return true;
  }

  /**
   * 分析当前局面（MultiPV）：返回每路 PV 的最新评估，按 PV 序号升序。
   * 分析在忙闲门闸内进行（busy 期间返回空数组）；对局双方均可触发。
   */
  async analyzeAsync(
    multiPv: number,
    token?: CancellationToken,
  ): Promise<readonly MultiPvInfo[]> {
    if (this._engine === null || this.busy || multiPv < 1) {
      return [];
    }

    this.setBusy(true);
    try {
      const generation = ++this._searchGeneration;
      const controller = new CancellationToken();
      const unlink = controller.linkTo(token);
      this._searchToken = controller;

      // 每路 PV 保留最新一条 info（引擎逐层刷新，只取最终层）。
      const latest = new Map<number, MultiPvInfo>();
      const unsubscribe = this._engine.onInfo((info) => latest.set(info.index, info));
      try {
        await this._engine.go(
          {
            fen: this._board.toFen(),
            depth: GameSession.DefaultAnalyzeDepth,
            multiPv,
          },
          controller,
        );

        if (generation !== this._searchGeneration) {
          return [];
        }
      } finally {
        unsubscribe();
        unlink();
        this._searchToken = null;
      }

      return [...latest.values()].sort((a, b) => a.index - b.index);
    } finally {
      this.setBusy(false);
    }
  }

  /** 组装搜索请求参数（当前局面 + 深度上限 + 阶段自适应走子时限）。 */
  private buildGoParams(): GoParams {
    return {
      fen: this._board.toFen(),
      depth: this.searchDepth,
      moveTimeMs: this.moveTimeForPosition(),
    };
  }

  /**
   * 阶段自适应时限：残局（车马炮合计不超过阈值）用较短时限。
   * 子力少时同深度耗时显著更低，缩短时限可减少等待而棋力基本不损；
   * 开局阶段则由引擎侧开局库查表瞬时出库（0ms）。
   */
  private moveTimeForPosition(): number {
    return endgamePhase(this._board, this._board.rounds) === 'endgame'
      ? GameSession.EndgameMoveTimeMs
      : GameSession.DefaultMoveTimeMs;
  }

  /** 从初始局面重放历史恢复当前局面。 */
  private rebuildBoard(): void {
    const board = new Board();
    for (const record of this._history) {
      board.doMove(record.move);
    }

    this._board = board;
  }

  private setBusy(busy: boolean): void {
    this._busy = busy;
    this._busyChanged.emit(busy);
  }

  /** 释放引擎会话（退出应用时调用）。 */
  async dispose(): Promise<void> {
    this._searchToken?.cancel();
    if (this._engine !== null) {
      await this._engine.dispose();
      this._engine = null;
    }
  }
}
