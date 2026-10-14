import { Board, Fen, Move, Rule } from '@webchess/core';

/**
 * 内置开局库：局面键哈希表（换位感知 + 加权随机）。
 *
 * 与旧实现（线性扫描变例、按着法序列前缀匹配）的关键差别：
 * 1. **按键查表**：表键是「棋盘 + 走子方」的局面键（FEN 前两字段），
 *    因此不同着法顺序到达同一局面（换位）同样命中——旧实现会漏掉；
 * 2. **O(1) 查询**：查询退化为一次 Map 取值，开局阶段零搜索延迟；
 * 3. **加权随机**：同一局面多候选按权重轮盘选择，既保证多样性又能压制软着；
 * 4. **fail fast**：建表时逐着走子校验，非法变例直接抛错（由测试门禁兜住）。
 *
 * 用法：引擎在「非分析模式（MultiPV = 1）且未显式禁用」时，用当前局面键查表，
 * 命中即瞬时出库着法。
 */

/** 开局变例：name 为中文布局名，moves 为从起始局面出发的 UCCI 着法序列。 */
export interface BookLine {
  readonly name: string;
  readonly moves: readonly string[];
  /** 变例权重（默认 1）：同一局面下按权重轮盘选择。 */
  readonly weight?: number;
}

/** 表内一条候选着法。 */
export interface BookMove {
  /** UCCI 着法。 */
  readonly ucci: string;
  /** 累计权重（多条变例共享同一着法时相加）。 */
  readonly weight: number;
  /** 距起始局面的半着数（换位取最小值）。 */
  readonly ply: number;
}

/**
 * 主流布局变例（覆盖中炮对屏风马/反宫马/单提马、顺炮/列炮、仙人指路、
 * 飞相局、起马局、过宫炮、士角炮等）。全部经 book.test.ts 逐着重放校验。
 */
export const BOOK_LINES: readonly BookLine[] = [
  // ---- 中炮对屏风马 ----
  { name: '中炮过河车对屏风马', moves: ['h2e2', 'h9g7', 'h0g2', 'b9c7', 'i0h0', 'i9h9', 'h0h6', 'c6c5'] },
  { name: '中炮直车对屏风马', moves: ['h2e2', 'h9g7', 'h0g2', 'b9c7', 'i0h0', 'i9h9', 'c3c4', 'g6g5'] },
  { name: '中炮巡河车对屏风马', moves: ['h2e2', 'h9g7', 'h0g2', 'b9c7', 'i0h0', 'i9h9', 'h0h4'] },
  { name: '五七炮对屏风马', moves: ['h2e2', 'h9g7', 'h0g2', 'b9c7', 'b2c2', 'a9b9', 'i0h0', 'i9h9'] },
  { name: '中炮进三兵对屏风马', moves: ['h2e2', 'h9g7', 'h0g2', 'b9c7', 'c3c4', 'g6g5', 'i0h0', 'i9h9'] },
  { name: '中炮进七兵对屏风马', moves: ['h2e2', 'h9g7', 'h0g2', 'b9c7', 'c3c4', 'c6c5', 'i0h0', 'i9h9'] },
  { name: '中炮横车七路马对屏风马', moves: ['h2e2', 'h9g7', 'h0g2', 'b9c7', 'i0i1', 'i9h9', 'i1d1', 'a9b9'] },
  { name: '中炮双正马对屏风马', moves: ['h2e2', 'h9g7', 'b0c2', 'b9c7', 'h0g2', 'i9h9', 'i0h0', 'a9b9'] },

  // ---- 中炮对反宫马 / 单提马 / 士角炮 ----
  { name: '中炮横车对反宫马', moves: ['h2e2', 'b7c7', 'h0g2', 'h9g7', 'i0i1', 'c9e7', 'i1d1'] },
  { name: '中炮对反宫马（炮8平6）', moves: ['h2e2', 'h7f7', 'h0g2', 'h9g7', 'i0h0', 'i9h9'] },
  { name: '中炮对单提马', moves: ['h2e2', 'h9g7', 'h0g2', 'b9a7', 'i0h0', 'a9b9'] },
  { name: '中炮对士角炮', moves: ['h2e2', 'b7d7', 'h0g2', 'h9g7', 'i0h0', 'i9h9'] },

  // ---- 顺手炮 / 列手炮 ----
  { name: '顺手炮直车对横车', moves: ['h2e2', 'h7e7', 'h0g2', 'h9g7', 'i0h0', 'i9h9', 'h0h8'] },
  { name: '顺手炮横车', moves: ['h2e2', 'h7e7', 'h0g2', 'h9g7', 'i0i1', 'b9c7'] },
  { name: '顺手炮缓开车', moves: ['h2e2', 'h7e7', 'h0g2', 'h9g7', 'b0c2', 'b9c7', 'a0b0', 'a9b9'] },
  { name: '顺手炮横车对直车', moves: ['h2e2', 'h7e7', 'h0g2', 'h9g7', 'i0i1', 'i9h9', 'i1d1', 'b9c7'] },
  { name: '列手炮直车', moves: ['h2e2', 'b7e7', 'h0g2', 'h9g7', 'i0h0', 'i9h9'] },
  { name: '列手炮直车对横车', moves: ['h2e2', 'b7e7', 'h0g2', 'h9g7', 'i0h0', 'i9i8', 'h0h4', 'b9c7'] },

  // ---- 仙人指路 / 飞相 / 起马 / 过宫炮 ----
  { name: '仙人指路对卒底炮', moves: ['c3c4', 'b7c7', 'h0g2', 'h9g7', 'b2e2', 'b9a7'] },
  { name: '仙人指路对挺卒', moves: ['c3c4', 'c6c5', 'h0g2', 'h9g7', 'i0h0', 'i9h9'] },
  { name: '仙人指路转中炮', moves: ['c3c4', 'h9g7', 'h2e2', 'b9c7', 'h0g2', 'i9h9'] },
  { name: '飞相局对左中炮', moves: ['c0e2', 'h7e7', 'h0g2', 'h9g7', 'b0c2', 'i9h9'] },
  { name: '飞相局对屏风马', moves: ['c0e2', 'h9g7', 'h0g2', 'b9c7', 'i0h0', 'i9i8'] },
  { name: '起马局对挺卒', moves: ['h0g2', 'c6c5', 'b0c2', 'h9g7', 'a0b0', 'b9c7'] },
  { name: '起马局对起马', moves: ['h0g2', 'h9g7', 'b0c2', 'b9c7', 'c3c4', 'c6c5'] },
  { name: '过宫炮对屏风马', moves: ['b2d2', 'h9g7', 'h0g2', 'b9c7', 'i0h0', 'c9e7'] },
  { name: '过宫炮对起马', moves: ['b2d2', 'h9g7', 'h0g2', 'b9c7', 'i0h0', 'i9h9'] },
];

/** 开局库最大介入深度（半着数）：超出后一律转入搜索。 */
export const BOOK_MAX_PLIES = 12;

/** 建表用的可变条目（对外暴露的 BookMove 为只读）。 */
interface MutableBookMove {
  ucci: string;
  weight: number;
  ply: number;
}

const tableCache = new Map<string, readonly BookMove[]>();

/**
 * 局面键：取 FEN 的「棋盘 + 走子方」两字段，剔除回合数字段。
 * 回合数随行棋递增，若参与键则换位局面无法命中。（单一实现在 `Fen.positionKey`。）
 */
export function positionKey(fen: string): string {
  return Fen.positionKey(fen);
}

/** 将一条变例的前缀局面全部登记进表（逐着走子，非法着法抛错）。 */
function registerLine(pool: Map<string, Map<string, MutableBookMove>>, line: BookLine): void {
  const weight = line.weight ?? 1;
  const board = new Board();
  const limit = Math.min(line.moves.length, BOOK_MAX_PLIES);
  for (let ply = 0; ply < limit; ply++) {
    const ucci = line.moves[ply] as string;
    const move = Move.fromUcci(ucci);
    if (move === null || !Rule.isLegalMove(board, move)) {
      throw new Error(`开局库变例「${line.name}」第 ${ply + 1} 着非法：${ucci}`);
    }

    const key = positionKey(board.toFen());
    let moves = pool.get(key);
    if (moves === undefined) {
      moves = new Map<string, MutableBookMove>();
      pool.set(key, moves);
    }

    const existing = moves.get(ucci);
    if (existing !== undefined) {
      existing.weight += weight;
      existing.ply = Math.min(existing.ply, ply);
    } else {
      moves.set(ucci, { ucci, weight, ply });
    }

    board.doMove(move);
  }
}

/** 惰性建表：首次查询时构建，之后复用（表为只读快照）。 */
function getTable(): Map<string, readonly BookMove[]> {
  if (tableCache.size > 0) {
    return tableCache;
  }

  for (const [key, moves] of buildBookTable(BOOK_LINES)) {
    tableCache.set(key, moves);
  }

  return tableCache;
}

/**
 * 由变例集合构建局面键表（导出以便测试 fail fast 与注入自定义库）。
 * @throws 变例含无法解析或非法的着法时抛错。
 */
export function buildBookTable(lines: readonly BookLine[]): Map<string, readonly BookMove[]> {
  const pool = new Map<string, Map<string, MutableBookMove>>();
  for (const line of lines) {
    registerLine(pool, line);
  }

  const table = new Map<string, readonly BookMove[]>();
  for (const [key, moves] of pool) {
    table.set(key, [...moves.values()]);
  }

  return table;
}

/** 按权重轮盘选择候选着法（rng 注入以便确定性测试）。 */
function weightedPick(moves: readonly BookMove[], rng: () => number): string | null {
  if (moves.length === 0) {
    return null;
  }

  let total = 0;
  for (const move of moves) {
    total += move.weight;
  }

  let threshold = rng() * total;
  for (const move of moves) {
    threshold -= move.weight;
    if (threshold < 0) {
      return move.ucci;
    }
  }

  return (moves[moves.length - 1] as BookMove).ucci;
}

/**
 * 按当前局面 FEN 直接查表（引擎热路径入口；O(1)）。
 * @param fen 任意 2/6 字段 FEN（键只取棋盘 + 走子方）。
 * @param rng 随机源（默认 Math.random）。
 * @returns 命中的下一着 UCCI；未命中返回 null。
 */
export function probeBookAtFen(fen: string, rng: () => number = Math.random): string | null {
  const moves = getTable().get(positionKey(fen));
  return moves === undefined ? null : weightedPick(moves, rng);
}

/**
 * 按对局着法序列查表（兼容入口：内部重放到当前局面后按键查表）。
 * @param history 从起始局面出发的 UCCI 着法序列（空数组表示起始局面）。
 * @param rng 随机源（默认 Math.random）。
 * @returns 命中的下一着 UCCI；未命中、序列非法或超出介入深度返回 null。
 */
export function probeBook(history: readonly string[], rng: () => number = Math.random): string | null {
  if (history.length >= BOOK_MAX_PLIES) {
    return null;
  }

  const board = new Board();
  for (const ucci of history) {
    const move = Move.fromUcci(ucci);
    if (move === null || !board.doMove(move)) {
      return null;
    }
  }

  return probeBookAtFen(board.toFen(), rng);
}

/** 库内局面数（测试与诊断用）。 */
export function bookPositionCount(): number {
  return getTable().size;
}

/** 库内候选着法总数（测试与诊断用）。 */
export function bookMoveCount(): number {
  let count = 0;
  for (const moves of getTable().values()) {
    count += moves.length;
  }

  return count;
}
