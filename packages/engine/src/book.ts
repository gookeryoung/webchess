/**
 * 内置开局库：主流布局的着法序列（UCCI 记法，红方先行）。
 *
 * 用法：引擎在「非显式 depth、非分析模式」下按对局着法序列查最长匹配前缀，
 * 命中则即时出库着法（零搜索延迟），开局阶段不再浪费算力走软着。
 * 着法序列全部经 Board 逐着走子验证（见 book.test.ts），保证库内无非法着法。
 */

/** 开局变例：name 为中文布局名，moves 为从起始局面出发的 UCCI 着法序列。 */
export interface BookLine {
  name: string;
  moves: string[];
}

/** 主流布局变例（覆盖中炮/屏风马/反宫马/顺炮/列炮/仙人指路/飞相/起马/过宫炮等）。 */
export const BOOK_LINES: readonly BookLine[] = [
  // 中炮过河车对屏风马
  { name: '中炮过河车对屏风马', moves: ['h2e2', 'h9g7', 'h0g2', 'b9c7', 'i0h0', 'i9h9', 'h0h6', 'c6c5'] },
  // 中炮直车七路马对屏风马
  { name: '中炮直车对屏风马', moves: ['h2e2', 'h9g7', 'h0g2', 'b9c7', 'i0h0', 'i9h9', 'c3c4', 'g6g5'] },
  // 中炮巡河车对屏风马
  { name: '中炮巡河车', moves: ['h2e2', 'h9g7', 'h0g2', 'b9c7', 'i0h0', 'i9h9', 'h0h4'] },
  // 五七炮对屏风马
  { name: '五七炮对屏风马', moves: ['h2e2', 'h9g7', 'h0g2', 'b9c7', 'b2c2', 'a9b9', 'i0h0', 'i9h9'] },
  // 中炮横车对反宫马
  { name: '中炮横车对反宫马', moves: ['h2e2', 'b7c7', 'h0g2', 'h9g7', 'i0i1', 'c9e7', 'i1d1'] },
  // 顺手炮直车对横车
  { name: '顺手炮直车', moves: ['h2e2', 'h7e7', 'h0g2', 'h9g7', 'i0h0', 'i9h9', 'h0h8'] },
  // 顺手炮横车
  { name: '顺手炮横车', moves: ['h2e2', 'h7e7', 'h0g2', 'h9g7', 'i0i1', 'b9c7'] },
  // 列手炮
  { name: '列手炮', moves: ['h2e2', 'b7e7', 'h0g2', 'h9g7', 'i0h0', 'i9h9'] },
  // 飞相局对屏风马
  { name: '飞相局', moves: ['c0e2', 'h9g7', 'h0g2', 'b9c7', 'i0h0', 'i9i8'] },
  // 仙人指路对卒底炮（红还架中炮）
  { name: '仙人指路对卒底炮', moves: ['c3c4', 'b7c7', 'h0g2', 'h9g7', 'b2e2', 'b9a7'] },
  // 起马局对挺卒
  { name: '起马局', moves: ['h0g2', 'h9g7', 'b0c2', 'b9c7', 'c3c4', 'c6c5'] },
  // 过宫炮对屏风马
  { name: '过宫炮', moves: ['b2d2', 'h9g7', 'h0g2', 'b9c7', 'i0h0', 'c9e7'] },
];

/** 开局库最大介入深度（半着数）：超出后一律转入搜索。 */
const BOOK_MAX_PLIES = 12;

/**
 * 按对局着法序列查询开局库。
 * @param history 从起始局面出发的 UCCI 着法序列（空数组表示起始局面）。
 * @param rng 随机源（默认 Math.random；同分支多候选时随机选择以增加变化）。
 * @returns 命中的下一着 UCCI 着法；未命中或超出介入深度返回 null。
 */
export function probeBook(history: readonly string[], rng: () => number = Math.random): string | null {
  if (history.length >= BOOK_MAX_PLIES) {
    return null;
  }

  // 收集所有「前缀完全匹配」变例的下一着（多线共享着法自动去重）。
  const candidates = new Set<string>();
  for (const line of BOOK_LINES) {
    if (line.moves.length <= history.length) {
      continue;
    }

    let matched = true;
    for (let i = 0; i < history.length; i++) {
      if (line.moves[i] !== history[i]) {
        matched = false;
        break;
      }
    }
    if (matched) {
      candidates.add(line.moves[history.length]);
    }
  }

  if (candidates.size === 0) {
    return null;
  }

  const pool = [...candidates];
  return pool[Math.floor(rng() * pool.length)] ?? null;
}
