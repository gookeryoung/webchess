import { Board, Move, Piece } from '@webchess/core';

/**
 * evaluateFast 的最小局面契约（FastPosition 结构满足，便于独立构造）。
 * 知识项所需计数与将位由调用方增量维护，评估自身不做全盘计数。
 */
interface EvalPosition {
  readonly cells: Uint8Array;
  baseScore: number;
  redToMove: boolean;
  /** 双方将/帅所在格下标。 */
  kingRed: number;
  kingBlack: number;
  /** 双方重子（马/车/炮）价值合计与士/象/马/炮数量。 */
  heavyRed: number;
  heavyBlack: number;
  advisorRed: number;
  advisorBlack: number;
  bishopRed: number;
  bishopBlack: number;
  knightRed: number;
  knightBlack: number;
  cannonRed: number;
  cannonBlack: number;
}

/**
 * 局面静态评估（子力 + 位置价值表 + 机动性）。
 *
 * 旧实现仅有「子力 + 粗糙中心距离」，无法区分马踩窝心、车占卒林线、
 * 当头炮等位置差异，是棋力弱的第二主因。现改为：
 * 1. 每类棋子一张红方视角位置价值表（黑方按行镜像取负，自动对称）；
 * 2. 子力 + 表值合并为 PIECE_SCORE[15][90]，由 FastPosition 在 make/unmake
 *    中增量维护，叶子节点评估只需补充少量动态项；
 * 3. 动态项：车/马机动性 + 中残局知识（阶段感知的马炮调整、王活跃、
 *    缺士象惩罚、空头炮受制），全部在单遍扫描内同步计算。
 */

/** 将死分值（搜索终局判定用，按层数衰减以鼓励更快的杀）。 */
export const MATE_SCORE = 100000;

/** 子力价值（与颜色无关，按棋子类型索引；captureScore 依赖具体数值，保持不变）。 */
const PieceValue: number[] = new Array(Piece.BlackPawn + 1).fill(0);
PieceValue[Piece.RedKing] = 10000;
PieceValue[Piece.RedAdvisor] = 220;
PieceValue[Piece.RedBishop] = 220;
PieceValue[Piece.RedKnight] = 420;
PieceValue[Piece.RedRook] = 920;
PieceValue[Piece.RedCannon] = 480;
PieceValue[Piece.RedPawn] = 100;
PieceValue[Piece.BlackKing] = 10000;
PieceValue[Piece.BlackAdvisor] = 220;
PieceValue[Piece.BlackBishop] = 220;
PieceValue[Piece.BlackKnight] = 420;
PieceValue[Piece.BlackRook] = 920;
PieceValue[Piece.BlackCannon] = 480;
PieceValue[Piece.BlackPawn] = 100;

/** 搜索内部使用的子力表（下标与 Piece 编码一致）。 */
export const PIECE_VALUE: readonly number[] = PieceValue;

/**
 * 红方视角位置价值表（index = y * 9 + x，y=0 为黑方底线）。
 * 黑方取「类型减 7 + 行镜像」位置的相反数，起始局面天然对称归零。
 * 兵：y=0 为老兵（只能底线平移将军，价值近零），y=1 卒林线价值最高。
 */
const PST_PAWN = [
  2, 4, 6, 8, 10, 8, 6, 4, 2,
  40, 48, 56, 64, 72, 64, 56, 48, 40,
  30, 38, 46, 54, 62, 54, 46, 38, 30,
  20, 26, 32, 38, 44, 38, 32, 26, 20,
  10, 14, 18, 22, 26, 22, 18, 14, 10,
  0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0,
];

const PST_KNIGHT = [
  4, 8, 16, 12, 4, 12, 16, 8, 4,
  4, 10, 12, 16, 14, 16, 12, 10, 4,
  10, 16, 20, 24, 22, 24, 20, 16, 10,
  8, 14, 20, 26, 26, 26, 20, 14, 8,
  6, 12, 18, 24, 28, 24, 18, 12, 6,
  4, 10, 16, 22, 24, 22, 16, 10, 4,
  2, 6, 12, 18, 18, 18, 12, 6, 2,
  0, 4, 8, 14, 14, 14, 8, 4, 0,
  -4, 0, 4, 8, 8, 8, 4, 0, -4,
  -4, -2, 0, 2, 2, 2, 0, -2, -4,
];

const PST_ROOK = [
  14, 14, 12, 18, 16, 18, 12, 14, 14,
  16, 20, 18, 24, 26, 24, 18, 20, 16,
  12, 12, 12, 18, 18, 18, 12, 12, 12,
  12, 18, 16, 22, 22, 22, 16, 18, 12,
  12, 14, 12, 20, 20, 20, 12, 14, 12,
  10, 12, 12, 16, 16, 16, 12, 12, 10,
  8, 10, 10, 14, 14, 14, 10, 10, 8,
  4, 8, 6, 14, 14, 14, 6, 8, 4,
  0, 4, 2, 10, 10, 10, 2, 4, 0,
  -2, 4, 4, 8, 8, 8, 4, 4, -2,
];

const PST_CANNON = [
  6, 4, 2, 8, 10, 8, 2, 4, 6,
  6, 4, 2, 8, 12, 8, 2, 4, 6,
  6, 4, 4, 10, 14, 10, 4, 4, 6,
  6, 4, 4, 10, 14, 10, 4, 4, 6,
  4, 2, 4, 10, 12, 10, 4, 2, 4,
  4, 2, 4, 8, 10, 8, 4, 2, 4,
  4, 2, 4, 10, 12, 10, 4, 2, 4,
  6, 4, 6, 12, 16, 12, 6, 4, 6,
  2, 0, 2, 8, 10, 8, 2, 0, 2,
  0, 0, 2, 6, 8, 6, 2, 0, 0,
];

/** 仕/相/帅仅在少数合法格有值，其余格到不了，置零即可。 */
const PST_ADVISOR = new Array<number>(90).fill(0);
const PST_BISHOP = new Array<number>(90).fill(0);
const PST_KING = new Array<number>(90).fill(0);
{
  // 仕：贴底安全、花心次之，顶仕略亏。
  PST_ADVISOR[9 * 9 + 3] = 8;
  PST_ADVISOR[9 * 9 + 5] = 8;
  PST_ADVISOR[8 * 9 + 4] = 6;
  PST_ADVISOR[7 * 9 + 3] = 2;
  PST_ADVISOR[7 * 9 + 5] = 2;
  // 相：正位最佳，中相易被兑且阻塞中路，边相次之。
  PST_BISHOP[9 * 9 + 2] = 8;
  PST_BISHOP[9 * 9 + 6] = 8;
  PST_BISHOP[7 * 9 + 0] = 4;
  PST_BISHOP[7 * 9 + 8] = 4;
  PST_BISHOP[7 * 9 + 4] = 2;
  // 帅：坐底线最佳，出宫格逐级惩罚，窝心最差。
  PST_KING[9 * 9 + 3] = 4;
  PST_KING[9 * 9 + 4] = 8;
  PST_KING[9 * 9 + 5] = 4;
  for (let x = 0; x < 9; x++) {
    PST_KING[8 * 9 + x] = -6;
    PST_KING[7 * 9 + x] = -10;
  }

  PST_KING[8 * 9 + 4] = -14;
}

const PST_BY_TYPE: readonly number[][] = [
  [], // 0=空
  PST_KING,
  PST_ADVISOR,
  PST_BISHOP,
  PST_KNIGHT,
  PST_ROOK,
  PST_CANNON,
  PST_PAWN,
];

/**
 * 子力 + 位置价值合并表：[棋子 15][格 90]，红方正、黑方负。
 * FastPosition 的 baseScore 与本表强耦合（make/unmake 增量维护）。
 */
export const PIECE_SCORE = new Int32Array(15 * 90);
for (let type = 1; type <= 7; type++) {
  const pst = PST_BY_TYPE[type];
  for (let sq = 0; sq < 90; sq++) {
    const value = PieceValue[type] + pst[sq];
    PIECE_SCORE[type * 90 + sq] = value;
    // 黑方镜像：黑子位于 (x, y) 的价值 = -(红子位于 (x, 9-y) 的价值)。
    const mirrorSq = (9 - ((sq / 9) | 0)) * 9 + (sq % 9);
    PIECE_SCORE[(type + 7) * 90 + sq] = -(PieceValue[type] + pst[mirrorSq]);
  }
}

/** 车机动性：四方向可直达空格数（遇子即止）。 */
function rookMobility(cells: Uint8Array, sq: number): number {
  const x = sq % 9;
  const y = (sq / 9) | 0;
  let count = 0;
  for (let dir = 0; dir < 4; dir++) {
    const dx = dir === 2 ? -1 : dir === 3 ? 1 : 0;
    const dy = dir === 0 ? 1 : dir === 1 ? -1 : 0;
    let tx = x + dx;
    let ty = y + dy;
    while (tx >= 0 && tx <= 8 && ty >= 0 && ty <= 9 && cells[ty * 9 + tx] === Piece.Empty) {
      count++;
      tx += dx;
      ty += dy;
    }
  }

  return count;
}

/** 马机动性：蹩马腿不挡且落点非己方的目标数。 */
function knightMobility(cells: Uint8Array, sq: number): number {
  const KNIGHT_X = [1, 1, -1, -1, 2, 2, -2, -2];
  const KNIGHT_Y = [2, -2, 2, -2, 1, -1, 1, -1];
  const LEG_X = [0, 0, 0, 0, 1, 1, -1, -1];
  const LEG_Y = [1, -1, 1, -1, 0, 0, 0, 0];
  const x = sq % 9;
  const y = (sq / 9) | 0;
  const red = cells[sq] === Piece.RedKnight;
  let count = 0;
  for (let i = 0; i < 8; i++) {
    const tx = x + KNIGHT_X[i];
    const ty = y + KNIGHT_Y[i];
    if (tx < 0 || tx > 8 || ty < 0 || ty > 9) {
      continue;
    }

    const target = cells[ty * 9 + tx];
    if (target !== Piece.Empty && (target <= Piece.RedPawn) === red) {
      continue;
    }

    if (cells[(y + LEG_Y[i]) * 9 + (x + LEG_X[i])] !== Piece.Empty) {
      continue;
    }

    count++;
  }

  return count;
}

/**
 * 局面阶段：双方重子（车 920 / 马 420 / 炮 480）价值合计。
 * 满编 = 双方各 2 车 2 马 2 炮 = 7280；合计越低越接近残局。
 */
const FULL_PHASE = 2 * (920 + 420 + 480) * 2;

/** 缺士惩罚基准（对手有重子施压时才计）。 */
const MISSING_ADVISOR = 24;
/** 缺象惩罚基准。 */
const MISSING_BISHOP = 20;
/** 空头炮惩罚（对方炮与己方将同线且中间无子，随时构成炮架威胁）。 */
const FACING_CANNON = 30;
/** 残局马升值 / 炮贬值幅度（马无蹩腿限制更灵活，炮缺炮架威力锐减）。 */
const ENDGAME_KNIGHT = 30;
const ENDGAME_CANNON = 25;
/** 残局王每前进一步（出宫助攻）的价值（需覆盖 PST 的出宫惩罚）。 */
const ENDGAME_KING_STEP = 15;
/** 对手重子价值达到该值时缺士象惩罚全额生效（不足时按比例缩放）。 */
const THREAT_FULL = 1840;

/**
 * 判断 sq 格（将位）沿纵向是否被对方空头炮瞄准：
 * 自将位向上/下扫描到的第一个子恰为对方炮（中间无炮架）。
 */
function isFacingCannon(cells: Uint8Array, kingSq: number, enemyCannon: number): boolean {
  const kx = kingSq % 9;
  const ky = (kingSq / 9) | 0;
  for (let ty = ky - 1; ty >= 0; ty--) {
    const piece = cells[ty * 9 + kx];
    if (piece !== Piece.Empty) {
      return piece === enemyCannon;
    }
  }

  for (let ty = ky + 1; ty <= 9; ty++) {
    const piece = cells[ty * 9 + kx];
    if (piece !== Piece.Empty) {
      return piece === enemyCannon;
    }
  }

  return false;
}

/**
 * 叶子节点静态评估：增量维护的子力 + 位置表分，加上动态知识项。
 * 返回「当前走子方」视角分值（negamax 约定）。
 *
 * 动态项（红正黑负，天然对称）：
 * - 车/马机动性（全盘扫描成本内同步计算）；
 * - 阶段感知：残局马升值/炮贬值、王出宫助攻；
 * - 防御知识：缺士/缺象惩罚（按对手重子威胁缩放）、空头炮受制惩罚。
 *
 * 知识项全部为整数运算（除法后取整），保证评估分恒为整数，
 * 与置换表 Int32 存储及 aspiration 窗口比较严格一致。
 */
export function evaluateFast(pos: EvalPosition): number {
  const cells = pos.cells;
  let score = pos.baseScore;

  for (let sq = 0; sq < 90; sq++) {
    const piece = cells[sq];
    if (piece === Piece.RedRook) {
      score += rookMobility(cells, sq) * 2;
    } else if (piece === Piece.BlackRook) {
      score -= rookMobility(cells, sq) * 2;
    } else if (piece === Piece.RedKnight) {
      score += knightMobility(cells, sq) * 4;
    } else if (piece === Piece.BlackKnight) {
      score -= knightMobility(cells, sq) * 4;
    }
  }

  // 残局程度分子：0 = 满编中局，FULL_PHASE = 子力枯竭残局。
  const egNum = FULL_PHASE - pos.heavyRed - pos.heavyBlack;
  // 残局马炮调整：马更灵活（升值），炮缺炮架（贬值）。
  if (egNum > 0) {
    score += (((pos.knightRed - pos.knightBlack) * ENDGAME_KNIGHT * egNum) / FULL_PHASE) | 0;
    score -= (((pos.cannonRed - pos.cannonBlack) * ENDGAME_CANNON * egNum) / FULL_PHASE) | 0;
    // 残局王活跃：出宫前移助攻（红方前进 = 行号减小，黑方相反）。
    const kingStep = ((ENDGAME_KING_STEP * egNum) / FULL_PHASE) | 0;
    score += kingStep * (9 - ((pos.kingRed / 9) | 0));
    score -= kingStep * ((pos.kingBlack / 9) | 0);
  }

  // 空头炮：己方将位被对方炮沿纵线隔空瞄准（无炮架即受制，开中局同样成立）。
  if (isFacingCannon(cells, pos.kingRed, Piece.BlackCannon)) {
    score -= FACING_CANNON;
  }
  if (isFacingCannon(cells, pos.kingBlack, Piece.RedCannon)) {
    score += FACING_CANNON;
  }

  // 缺士象：仅当对手仍有重子施压时计（残局无攻子时缺防御无害），
  // 威胁不足一车价值时按比例缩放。
  const redThreat = Math.min(pos.heavyBlack, THREAT_FULL);
  const blackThreat = Math.min(pos.heavyRed, THREAT_FULL);
  score -= (((2 - pos.advisorRed) * MISSING_ADVISOR * redThreat) / THREAT_FULL) | 0;
  score -= (((2 - pos.bishopRed) * MISSING_BISHOP * redThreat) / THREAT_FULL) | 0;
  score += (((2 - pos.advisorBlack) * MISSING_ADVISOR * blackThreat) / THREAT_FULL) | 0;
  score += (((2 - pos.bishopBlack) * MISSING_BISHOP * blackThreat) / THREAT_FULL) | 0;

  return pos.redToMove ? score : -score;
}

/** 内核 Board 视角的静态评估（兼容旧对外 API，语义与 evaluateFast 一致）。 */
export function evaluate(board: Board): number {
  const view = new Uint8Array(90);
  view.set(board.cells);
  const pos: EvalPosition = {
    cells: view,
    baseScore: 0,
    redToMove: board.redToMove,
    kingRed: -1,
    kingBlack: -1,
    heavyRed: 0,
    heavyBlack: 0,
    advisorRed: 0,
    advisorBlack: 0,
    bishopRed: 0,
    bishopBlack: 0,
    knightRed: 0,
    knightBlack: 0,
    cannonRed: 0,
    cannonBlack: 0,
  };
  for (let sq = 0; sq < 90; sq++) {
    const piece = view[sq];
    if (piece === Piece.Empty) {
      continue;
    }

    pos.baseScore += PIECE_SCORE[piece * 90 + sq];
    switch (piece) {
      case Piece.RedKing:
        pos.kingRed = sq;
        break;
      case Piece.BlackKing:
        pos.kingBlack = sq;
        break;
      case Piece.RedKnight:
        pos.knightRed++;
        pos.heavyRed += PIECE_VALUE[piece];
        break;
      case Piece.BlackKnight:
        pos.knightBlack++;
        pos.heavyBlack += PIECE_VALUE[piece];
        break;
      case Piece.RedRook:
        pos.heavyRed += PIECE_VALUE[piece];
        break;
      case Piece.BlackRook:
        pos.heavyBlack += PIECE_VALUE[piece];
        break;
      case Piece.RedCannon:
        pos.cannonRed++;
        pos.heavyRed += PIECE_VALUE[piece];
        break;
      case Piece.BlackCannon:
        pos.cannonBlack++;
        pos.heavyBlack += PIECE_VALUE[piece];
        break;
      case Piece.RedAdvisor:
        pos.advisorRed++;
        break;
      case Piece.BlackAdvisor:
        pos.advisorBlack++;
        break;
      case Piece.RedBishop:
        pos.bishopRed++;
        break;
      case Piece.BlackBishop:
        pos.bishopBlack++;
        break;
      default:
        break;
    }
  }

  return evaluateFast(pos);
}

/** 吃子启发式分值（MVV-LVA）：优先搜索「价值高的被吃子 + 价值低的吃子方」。 */
export function captureScore(board: Board, move: Move): number {
  const victim = board.getPieceAt(move.to);
  if (!Piece.isValid(victim)) {
    return 0;
  }

  const attacker = board.getPieceAt(move.from);
  return PieceValue[victim] * 10 - PieceValue[attacker];
}
