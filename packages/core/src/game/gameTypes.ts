import { Move } from '../move.js';

/** 对局模式。 */
export enum GameMode {
  /** 双人本地对弈（同屏轮流走子）。 */
  TwoPlayers = 'two-players',

  /** 人机对弈（人类执红，引擎执黑）。 */
  PlayWithEngine = 'play-with-engine',
}

/**
 * 一条走子历史记录：move（结构化）、ucci（UCCI 字符串）、chs（中文纵线记谱）、isRedMove。
 * 悔棋从尾部弹出并重放恢复局面。
 */
export interface HistoryRecord {
  readonly move: Move;
  readonly ucci: string;
  readonly chs: string;
  readonly isRedMove: boolean;
}

/** 一步走子被应用后的事件参数（UI 据此播放动画与音效）。 */
export interface MoveAppliedEventArgs {
  /** 被应用的走法。 */
  readonly move: Move;
  /** 中文纵线记谱（如「炮二平五」）。 */
  readonly chinese: string;
  /** 是否吃子。 */
  readonly isCapture: boolean;
  /** 被吃棋子编码（无吃子为 Piece.Empty；UI 据此播放被吃子淡出动画）。 */
  readonly capturedPiece: number;
  /** 是否红方走子。 */
  readonly isRedMove: boolean;
  /** 走子后对方是否被将军。 */
  readonly isCheck: boolean;
  /** 走子后对方是否被将死。 */
  readonly isCheckmate: boolean;
  /** 走子后对方是否被困毙。 */
  readonly isStalemate: boolean;
}
