/**
 * @webchess/core — 平台无关的中国象棋内核。
 *
 * 硬约束：本包不得引用 DOM、浏览器专有 API 或 Node 环境 API，
 * 以便同一份代码在 Web 与微信小程序中复用。该约束由
 * `scripts/check-core-purity.mjs` 与 tsconfig（lib 仅 ES2022，types 为空）双重校验。
 *
 * 分层：
 * - 根：规则与局面（Board / Rule / Fen / Piece / Move / Position / ChineseNotation）
 * - `game/`  对局会话、残局题库、入门课程
 * - `manual/` 棋谱（PGN / XQF）解析与打谱游标
 * - `engine/` 引擎会话抽象（具体实现由平台层注入）
 * - `codec/`  GB18030 解码注入点（Web 原生 / 小程序内置表）
 */

// ---- 规则与局面 ----
export { BOARD_CELLS, BOARD_HEIGHT, BOARD_WIDTH, INITIAL_FEN, cellIndex } from './constants.js';
export { Position } from './position.js';
export { Piece } from './piece.js';
export { Move } from './move.js';
export { Board } from './board.js';
export { Fen, FenFormatException } from './fen.js';
export { Rule } from './rule.js';
export { ChineseNotation } from './chineseNotation.js';

// ---- 基础设施 ----
export { Emitter } from './events.js';
export type { Listener, Unsubscribe } from './events.js';
export { CancellationToken } from './cancellation.js';
export {
  decodeGb18030,
  decodeGb18030Slice,
  hasGb18030Decoder,
  setGb18030Decoder,
} from './codec/gb18030.js';
export type { BytesDecoder } from './codec/gb18030.js';

// ---- 引擎抽象 ----
export type {
  EngineOptions,
  EngineSession,
  GoParams,
  MoveSource,
  MultiPvInfo,
  SearchResult,
} from './engine/engineTypes.js';

// ---- 对局 / 练习 ----
export type {
  DrawReason,
  GameResult,
  HistoryRecord,
  MoveAppliedEventArgs,
} from './game/gameTypes.js';
export { GameMode } from './game/gameTypes.js';
export {
  ENDGAME_TABLE,
  endgamePhase,
  endgameTableSize,
  isMaterialDeadDraw,
  lookupEndgame,
  materialSignature,
} from './game/endgameTable.js';
export type { EndgameEntry, EndgamePhase } from './game/endgameTable.js';
export { GameSession } from './game/gameSession.js';
export type { PuzzleDefinition, PuzzleMoveResult } from './game/puzzleTypes.js';
export { PuzzleMoveNode } from './game/puzzleTypes.js';
export { PuzzleController } from './game/puzzleController.js';
export { PuzzleLibrary } from './game/puzzleLibrary.js';
export { PuzzleProgress } from './game/puzzleProgress.js';
export type { LessonDefinition, LessonGoal, LessonMoveResult } from './game/lessonTypes.js';
export { LessonGoalKind } from './game/lessonTypes.js';
export { LessonController } from './game/lessonController.js';
export { LessonLibrary, findLesson } from './game/lessonLibrary.js';

// ---- 棋谱（打谱） ----
export { ManualDocument, ManualFormatException, MoveNode } from './manual/manualDocument.js';
export { ManualController } from './manual/manualController.js';
export { PgnParser } from './manual/pgnParser.js';
export { XqfParser } from './manual/xqfParser.js';
export { XqfKey } from './manual/xqfKey.js';
export { XqfReader } from './manual/xqfReader.js';
