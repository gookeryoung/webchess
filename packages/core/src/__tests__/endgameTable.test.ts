import { describe, expect, it } from 'vitest';
import { Board } from '../board.js';
import { Move } from '../move.js';
import {
  ENDGAME_TABLE,
  endgamePhase,
  endgameTableSize,
  isMaterialDeadDraw,
  lookupEndgame,
  materialSignature,
} from '../game/endgameTable.js';
import { GameSession } from '../game/gameSession.js';

/** K vs K（双方仅帅将）。 */
const K_VS_K = '3k5/9/9/9/9/9/9/9/9/4K4 w - - 0 1';
/** 士象全对士象全（双方仅帅将士象）。 */
const FULL_GUARDS_VS_FULL_GUARDS = '2bakab2/9/9/9/9/9/9/9/9/2BAKAB2 w - - 0 1';
/** 单兵对孤将（红有进攻子力）。 */
const PAWN_VS_K = '3k5/9/9/9/9/9/9/9/4P4/4K4 w - - 0 1';

describe('残局查表（子力签名表）', () => {
  it('表覆盖双方仕相的全部组合（每方仕、相各 0-2 枚 → 81 项）', () => {
    expect(endgameTableSize()).toBe(81);
    expect(ENDGAME_TABLE.size).toBe(81);
  });

  it('签名按固定次序拼接子力枚数', () => {
    expect(materialSignature(new Board())).toBe('K1R2C2N2B2A2P5vk1r2c2n2b2a2p5');
  });

  it('同一子力构成的不同摆法签名一致', () => {
    const a = Board.fromFen(K_VS_K);
    const b = Board.fromFen('4k4/9/9/9/9/9/9/9/9/3K5 w - - 0 1');
    expect(materialSignature(a)).toBe(materialSignature(b));
  });

  it('双方无进攻子力 → 查表命中死和', () => {
    expect(lookupEndgame(Board.fromFen(K_VS_K))?.deadDraw).toBe(true);
    expect(isMaterialDeadDraw(Board.fromFen(K_VS_K))).toBe(true);
    expect(isMaterialDeadDraw(Board.fromFen(FULL_GUARDS_VS_FULL_GUARDS))).toBe(true);
  });

  it('存在进攻子力 → 不命中死和签名', () => {
    expect(isMaterialDeadDraw(Board.fromFen(PAWN_VS_K))).toBe(false);
    expect(isMaterialDeadDraw(new Board())).toBe(false);
    expect(lookupEndgame(new Board())).toBeNull();
  });

  it('阶段判定：开局 / 中局 / 残局', () => {
    const start = new Board();
    expect(endgamePhase(start, 1)).toBe('opening');
    expect(endgamePhase(start, 40)).toBe('middlegame');
    // 单车对孤将：车马炮合计 1 ≤ 4 → 残局。
    expect(endgamePhase(Board.fromFen('5k3/9/9/9/9/9/9/9/9/2R1K4 w - - 0 1'), 40)).toBe('endgame');
  });
});

describe('GameSession 残局查表判和', () => {
  it('载入无进攻子力局面即判和（material），此后拒绝走子', () => {
    const session = new GameSession();
    expect(session.loadFen(K_VS_K)).toBe(true);
    expect(session.isDraw).toBe(true);
    expect(session.drawReason).toBe('material');
    expect(session.result).toBe('draw');
    expect(session.tryPlayMove(Move.fromUcci('e0e1') as Move)).toBe(false);
  });

  it('存在进攻子力（红车）时即使子力很少也不判和', () => {
    const session = new GameSession();
    expect(session.loadFen('5k3/9/9/9/9/9/9/9/3R5/4K4 w - - 0 1')).toBe(true);
    expect(session.isDraw).toBe(false);
    expect(session.result).toBe('ongoing');
  });
});
