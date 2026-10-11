import { Position } from '../position.js';

/** 课程目标类型（入门指导的走子判定语义）。 */
export enum LessonGoalKind {
  /** 目标棋子任意合法走法（棋子走法教学课）。 */
  AnyMoveOfPiece = 'any-move-of-piece',

  /** 精确走子：从指定起点到指定终点。 */
  ExactMove = 'exact-move',

  /** 任意一步造成将军的走法。 */
  AnyCheckingMove = 'any-checking-move',

  /** 任意一步造成将死的走法。 */
  AnyMateMove = 'any-mate-move',

  /** 任意吃子走法；pieceCode 非 0 时须吃掉指定棋子。 */
  AnyCaptureMove = 'any-capture-move',
}

/** 课程目标：kind 决定判定语义，其余字段按 kind 取用。 */
export interface LessonGoal {
  readonly kind: LessonGoalKind;
  /** AnyMoveOfPiece / AnyCaptureMove 的目标棋子编码（AnyCaptureMove 为 0 表示任意吃子）。 */
  readonly pieceCode?: number;
  /** ExactMove 的起点。 */
  readonly from?: Position;
  /** ExactMove 的终点。 */
  readonly to?: Position;
}

/** 一节入门课程定义：指定局面下完成一个走子目标。 */
export interface LessonDefinition {
  readonly id: string;
  readonly title: string;
  readonly intro: string;
  readonly fen: string;
  readonly goal: LessonGoal;
  readonly successText: string;
}

/** 课程走子判定结果。 */
export interface LessonMoveResult {
  readonly accepted: boolean;
  readonly message: string;
}
