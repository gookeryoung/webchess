import { Board } from '../board.js';
import { Move } from '../move.js';
import { Piece } from '../piece.js';
import { Rule } from '../rule.js';
import { LessonDefinition, LessonGoalKind, LessonMoveResult } from './lessonTypes.js';

/**
 * 入门指导控制器（零平台依赖）：对用户走子做课程目标先行校验。
 * UI 先调 Evaluate，拒绝的走子不进 GameSession.tryPlayMove；
 * 接受并落子后由 UI 调 consumeApplied 确认完成。课程目标均为单步达成。
 */
export class LessonController {
  private _current: LessonDefinition | null = null;
  private _completed = false;

  /** 当前课程；未开始时为 null。 */
  get current(): LessonDefinition | null {
    return this._current;
  }

  /** 当前课程是否已完成。 */
  get isCompleted(): boolean {
    return this._completed;
  }

  /** 开始一节课程（UI 先调 GameSession.loadFen 载入局面）。 */
  start(lesson: LessonDefinition): void {
    this._current = lesson;
    this._completed = false;
  }

  /** 退出课程（返回对弈模式时调用）。 */
  reset(): void {
    this._current = null;
    this._completed = false;
  }

  /**
   * 先行校验用户走子是否符合课程目标；走法本身的合法性由 GameSession.tryPlayMove 校验，
   * 本方法只做目标匹配（含模拟落子后的将军/将死判定）。
   */
  evaluate(board: Board, move: Move): LessonMoveResult {
    const lesson = this._current;
    if (lesson === null || this._completed) {
      return { accepted: false, message: '当前没有进行中的课程' };
    }

    switch (lesson.goal.kind) {
      case LessonGoalKind.AnyMoveOfPiece:
        return LessonController.evaluatePieceMove(board, move, lesson);
      case LessonGoalKind.ExactMove:
        return LessonController.evaluateExactMove(move, lesson);
      // doMove 已翻边：走子后的 redToMove 即应将方（被将军/被将死判定对象）。
      case LessonGoalKind.AnyCheckingMove:
        return LessonController.evaluatePredicate(
          board,
          move,
          (b) => Rule.isInCheck(b, b.redToMove),
          '这一步没有造成将军',
        );
      case LessonGoalKind.AnyMateMove:
        return LessonController.evaluatePredicate(
          board,
          move,
          (b) => Rule.isCheckmate(b, b.redToMove),
          '这一步没有将死对方',
        );
      case LessonGoalKind.AnyCaptureMove:
        return LessonController.evaluateCapture(board, move, lesson);
      default:
        return { accepted: false, message: '未知课程目标' };
    }
  }

  /** 走子被应用后调用；课程目标均为单步，应用即完成。 */
  consumeApplied(): boolean {
    if (this._current === null || this._completed) {
      return false;
    }

    this._completed = true;
    return true;
  }

  private static evaluatePieceMove(
    board: Board,
    move: Move,
    lesson: LessonDefinition,
  ): LessonMoveResult {
    const piece = board.getPieceAt(move.from);
    if (piece !== (lesson.goal.pieceCode ?? 0)) {
      return { accepted: false, message: '请移动指定的棋子' };
    }

    return { accepted: true, message: '' };
  }

  private static evaluateExactMove(move: Move, lesson: LessonDefinition): LessonMoveResult {
    const from = lesson.goal.from;
    const to = lesson.goal.to;
    if (from === undefined || to === undefined) {
      return { accepted: false, message: '课程目标缺少起终点坐标' };
    }

    return move.from.equals(from) && move.to.equals(to)
      ? { accepted: true, message: '' }
      : { accepted: false, message: '走子路线不符合目标，请按课程要求走子' };
  }

  private static evaluateCapture(
    board: Board,
    move: Move,
    lesson: LessonDefinition,
  ): LessonMoveResult {
    const captured = board.getPieceAt(move.to);
    if (!Piece.isValid(captured) || Piece.isRed(captured) === board.redToMove) {
      return { accepted: false, message: '这一步没有吃子，请吃掉目标棋子' };
    }

    const pieceCode = lesson.goal.pieceCode ?? 0;
    if (pieceCode !== 0 && captured !== pieceCode) {
      return { accepted: false, message: '请吃掉指定的棋子' };
    }

    return { accepted: true, message: '' };
  }

  /** 模拟落子后按谓词判定（将军/将死共用）；走子方归属与合法性由 tryPlayMove 兜底。 */
  private static evaluatePredicate(
    board: Board,
    move: Move,
    predicate: (board: Board) => boolean,
    rejectText: string,
  ): LessonMoveResult {
    const piece = board.getPieceAt(move.from);
    if (!Piece.isValid(piece) || Piece.isRed(piece) !== board.redToMove) {
      return { accepted: false, message: '请移动走子方的棋子' };
    }

    const simulated = board.clone();
    if (!simulated.doMove(move)) {
      return { accepted: false, message: '走法非法' };
    }

    return predicate(simulated)
      ? { accepted: true, message: '' }
      : { accepted: false, message: rejectText };
  }
}
