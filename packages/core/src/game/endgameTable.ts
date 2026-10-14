import { Board } from '../board.js';
import { Piece } from '../piece.js';

/**
 * 残局查表：按「子力签名」索引的知识表。
 *
 * 与开局库查表（按局面键）互补：残局阶段可变因素多、完整 DTM/DTC 表库工程量大，
 * 但「子力构成」本身就是最稳定的索引维度——国际象棋的 tablebase 与象棋残局谱
 * 均以子力签名检索。本表以签名查表，当前承载两类知识：
 * 1. **公认和局（deadDraw）**：双方除帅（将）、仕（士）、相（象）外无任何进攻子力，
 *    任何一方都无法组织杀棋，必为和棋。表项由 K/A/B 的全部组合（每方仕、相各 0-2 枚，
 *    共 3×3×3×3 = 81 项）在模块加载时生成，查询退化为一次 Map 取值。
 * 2. 可扩展的定式条目（note）：后续补充「例胜/例和」定式时只需向表内加项。
 */

/** 残局阶段。 */
export type EndgamePhase = 'opening' | 'middlegame' | 'endgame';

/** 残局知识表条目。 */
export interface EndgameEntry {
  /** 子力签名（规范序，见 {@link materialSignature}）。 */
  readonly signature: string;
  /** 是否公认和局（无任何可致杀的进攻子力）。 */
  readonly deadDraw: boolean;
  /** 人类可读说明。 */
  readonly note: string;
}

/** 单方子力签名：按 帅/车/炮/马/相/仕/兵 次序拼接「字母 + 枚数」，0 枚省略。 */
function sideSignature(cells: Readonly<Uint8Array>, red: boolean): string {
  const order: readonly (readonly [number, string])[] = red
    ? [
        [Piece.RedKing, 'K'],
        [Piece.RedRook, 'R'],
        [Piece.RedCannon, 'C'],
        [Piece.RedKnight, 'N'],
        [Piece.RedBishop, 'B'],
        [Piece.RedAdvisor, 'A'],
        [Piece.RedPawn, 'P'],
      ]
    : [
        [Piece.BlackKing, 'k'],
        [Piece.BlackRook, 'r'],
        [Piece.BlackCannon, 'c'],
        [Piece.BlackKnight, 'n'],
        [Piece.BlackBishop, 'b'],
        [Piece.BlackAdvisor, 'a'],
        [Piece.BlackPawn, 'p'],
      ];

  let out = '';
  for (const [piece, letter] of order) {
    let count = 0;
    for (const cell of cells) {
      if (cell === piece) {
        count++;
      }
    }

    if (count > 0) {
      out += `${letter}${count}`;
    }
  }

  return out;
}

/** 局面子力签名：`红方签名v黑方签名`，如 `K1R2C2N2B2A2P5vk1r2c2n2b2a2p5`。 */
export function materialSignature(board: Board): string {
  return `${sideSignature(board.cells, true)}v${sideSignature(board.cells, false)}`;
}

/** 生成「双方均无进攻子力」的全部 K/A/B 组合签名（每方仕、相各 0-2 枚）。 */
function buildDeadDrawSignatures(): string[] {
  const signatures: string[] = [];
  for (let redAdvisors = 0; redAdvisors <= 2; redAdvisors++) {
    for (let redBishops = 0; redBishops <= 2; redBishops++) {
      for (let blackAdvisors = 0; blackAdvisors <= 2; blackAdvisors++) {
        for (let blackBishops = 0; blackBishops <= 2; blackBishops++) {
          signatures.push(
            deadDrawSignature(
              'K',
              redAdvisors,
              redBishops,
              'k',
              blackAdvisors,
              blackBishops,
            ),
          );
        }
      }
    }
  }

  return signatures;
}

function deadDrawSignature(
  redKing: string,
  redAdvisors: number,
  redBishops: number,
  blackKing: string,
  blackAdvisors: number,
  blackBishops: number,
): string {
  const red =
    `${redKing}1` +
    (redBishops > 0 ? `B${redBishops}` : '') +
    (redAdvisors > 0 ? `A${redAdvisors}` : '');
  const black =
    `${blackKing}1` +
    (blackBishops > 0 ? `b${blackBishops}` : '') +
    (blackAdvisors > 0 ? `a${blackAdvisors}` : '');
  return `${red}v${black}`;
}

/** 残局知识表（只读）。 */
export const ENDGAME_TABLE: ReadonlyMap<string, EndgameEntry> = buildEndgameTable();

function buildEndgameTable(): ReadonlyMap<string, EndgameEntry> {
  const table = new Map<string, EndgameEntry>();
  for (const signature of buildDeadDrawSignatures()) {
    table.set(signature, {
      signature,
      deadDraw: true,
      note: '双方均无进攻子力（车/马/炮/兵），无法成杀，公认和局',
    });
  }

  return table;
}

/**
 * 按局面子力签名查表。
 * @returns 命中的表项；未登记返回 null（调用方不得据此推断「非和」）。
 */
export function lookupEndgame(board: Board): EndgameEntry | null {
  return ENDGAME_TABLE.get(materialSignature(board)) ?? null;
}

/** 局面是否触及「无进攻子力」死和签名（等价于表中 deadDraw 项）。 */
export function isMaterialDeadDraw(board: Board): boolean {
  return lookupEndgame(board)?.deadDraw === true;
}

/** 残局阶段判定：车马炮合计不超过 4 视为残局；前 12 回合为开局。 */
export function endgamePhase(board: Board, ply: number): EndgamePhase {
  let heavy = 0;
  for (const cell of board.cells) {
    if (
      cell === Piece.RedRook ||
      cell === Piece.RedKnight ||
      cell === Piece.RedCannon ||
      cell === Piece.BlackRook ||
      cell === Piece.BlackKnight ||
      cell === Piece.BlackCannon
    ) {
      heavy++;
    }
  }

  if (heavy <= 4) {
    return 'endgame';
  }

  return ply <= 12 ? 'opening' : 'middlegame';
}

/** 供测试统计：表中条目数。 */
export function endgameTableSize(): number {
  return ENDGAME_TABLE.size;
}
