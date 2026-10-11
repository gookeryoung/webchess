import {
  Board,
  BOARD_HEIGHT,
  BOARD_WIDTH,
  Move,
  Piece,
  cellIndex,
} from '@webchess/core';

/**
 * 局面静态评估（子力 + 位置）。
 *
 * 说明：原 C# 版本使用 Pikafish（NNUE 深度网络，48MB 权重）。Web / 小程序无法加载
 * 原生 NNUE 推理库，故以经典「子力价值 + 位置奖励」方案作等价替代：
 * 强度约业余中级（搜索深度 4-6），足以支撑人机对弈、提示与分析三个场景。
 * 若后续接入远程 UCI 服务或 WASM 引擎，只需替换 EngineSession 实现，上层无感。
 */

/** 子力价值（与颜色无关，按棋子类型索引）。 */
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

/** 过河兵额外奖励（按推进格数递增）。 */
const PawnAdvanceBonus: readonly number[] = [0, 0, 0, 10, 20, 35, 55, 80, 110, 150];

/** 中心控制奖励（马/车/炮鼓励占据中路与河口）。 */
function centrality(x: number, y: number): number {
  const dx = Math.abs(x - (BOARD_WIDTH - 1) / 2);
  const dy = Math.abs(y - (BOARD_HEIGHT - 1) / 2);
  return Math.round((8 - dx * 1.5 - dy * 0.8) * 2);
}

/** 将死分值（搜索终局判定用，按层数衰减以鼓励更快的杀）。 */
export const MATE_SCORE = 100000;

/**
 * 静态评估：返回「当前走子方」视角分值（negamax 约定）。
 */
export function evaluate(board: Board): number {
  let score = 0;
  for (let y = 0; y < BOARD_HEIGHT; y++) {
    for (let x = 0; x < BOARD_WIDTH; x++) {
      const piece = board.cells[cellIndex(x, y)];
      if (piece === Piece.Empty) {
        continue;
      }

      const red = Piece.isRed(piece);
      let value = PieceValue[piece];

      switch (piece) {
        case Piece.RedPawn:
          // 红兵向 y 减小方向推进；越靠近对方底线越大。
          value += PawnAdvanceBonus[BOARD_HEIGHT - 1 - y];
          break;
        case Piece.BlackPawn:
          value += PawnAdvanceBonus[y];
          break;
        case Piece.RedKnight:
        case Piece.RedRook:
        case Piece.RedCannon:
        case Piece.BlackKnight:
        case Piece.BlackRook:
        case Piece.BlackCannon:
          value += centrality(x, y);
          break;
        default:
          break;
      }

      score += red ? value : -value;
    }
  }

  return board.redToMove ? score : -score;
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
