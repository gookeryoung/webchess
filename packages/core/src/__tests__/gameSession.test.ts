import { beforeEach, describe, expect, it } from 'vitest';
import { Move } from '../move.js';
import { Piece } from '../piece.js';
import { Position } from '../position.js';
import { FenFormatException } from '../fen.js';
import { GameMode } from '../game/gameTypes.js';
import { GameSession } from '../game/gameSession.js';
import { FakeEngineSession } from './fakeEngineSession.js';

function move(ucci: string): Move {
  const m = Move.fromUcci(ucci);
  if (m === null) throw new Error(`非法 UCCI：${ucci}`);
  return m;
}

describe('GameSession 对局流转与忙闲门闸', () => {
  let fake: FakeEngineSession;
  let session: GameSession;

  beforeEach(() => {
    fake = new FakeEngineSession();
    session = new GameSession(fake);
    expect(session.attachEngine(fake)).toBe(true);
    expect(session.setMode(GameMode.PlayWithEngine)).toBe(true);
  });

  it('人走后引擎应手，两着均落地', async () => {
    expect(session.tryPlayMove(move('h2e2'))).toBe(true);
    const task = session.requestEngineMoveAsync();
    await fake.waitGoRequestedAsync();

    // 引擎思考中：门闸生效。
    expect(session.busy).toBe(true);
    expect(session.tryPlayMove(move('b0c2'))).toBe(false);
    expect(session.undo()).toBe(false);
    expect(await session.hintAsync()).toBeNull();

    fake.release('h9g7');
    expect(await task).toBe(true);

    expect(session.history).toHaveLength(2);
    expect(session.board.getPieceAt(new Position(6, 2))).toBe(Piece.BlackKnight);
    expect(session.board.redToMove).toBe(true);
  });

  it('引擎思考中新对局：取消搜索并丢弃迟到的 bestmove', async () => {
    expect(session.tryPlayMove(move('h2e2'))).toBe(true);
    const task = session.requestEngineMoveAsync();
    await fake.waitGoRequestedAsync();

    session.newGame();
    expect(session.history).toHaveLength(0);
    expect(session.board.redToMove).toBe(true);
    expect(session.board.getPieceAt(new Position(1, 7))).toBe(Piece.RedCannon);

    fake.release('h9g7');
    expect(await task).toBe(false);
    expect(session.board.getPieceAt(new Position(1, 7))).toBe(Piece.RedCannon);
    expect(session.busy).toBe(false);
  });

  it('人机模式悔棋连退两步', async () => {
    expect(session.tryPlayMove(move('h2e2'))).toBe(true);
    const task = session.requestEngineMoveAsync();
    await fake.waitGoRequestedAsync();
    fake.release('h9g7');
    expect(await task).toBe(true);
    expect(session.history).toHaveLength(2);

    expect(session.undo()).toBe(true);
    expect(session.history).toHaveLength(0);
    expect(session.board.getPieceAt(new Position(1, 7))).toBe(Piece.RedCannon);
  });

  it('双人模式悔棋只退一步', () => {
    const twoPlayer = new GameSession();
    twoPlayer.setMode(GameMode.TwoPlayers);
    expect(twoPlayer.mode).toBe(GameMode.TwoPlayers);
    expect(twoPlayer.tryPlayMove(move('h2e2'))).toBe(true);
    expect(twoPlayer.tryPlayMove(move('h9g7'))).toBe(true);

    expect(twoPlayer.undo()).toBe(true);
    expect(twoPlayer.history).toHaveLength(1);
    expect(twoPlayer.board.getPieceAt(new Position(7, 0))).toBe(Piece.BlackKnight);
  });

  it('非走子方与非法走法被拒绝', () => {
    expect(session.tryPlayMove(move('h9g7'))).toBe(false);
    expect(session.tryPlayMove(move('b0b1'))).toBe(false);
    expect(session.history).toHaveLength(0);
  });

  it('提示返回着法但不落子', async () => {
    const task = session.hintAsync();
    await fake.waitGoRequestedAsync();
    fake.release('h9g7');

    const hint = await task;
    expect(hint?.toUcci()).toBe('h9g7');
    expect(session.history).toHaveLength(0);
    expect(session.board.getPieceAt(new Position(7, 0))).toBe(Piece.BlackKnight);
  });

  it('引擎走子请求携带深度上限与走子时限（人机及时应手）', async () => {
    const task = session.requestEngineMoveAsync();
    await fake.waitGoRequestedAsync();
    expect(fake.requests[0].depth).toBe(GameSession.DefaultSearchDepth);
    expect(fake.requests[0].moveTimeMs).toBe(GameSession.DefaultMoveTimeMs);
    fake.release('h2e2');
    expect(await task).toBe(true);
  });

  it('分析（MultiPV）按 PV 序号收集最新 info', async () => {
    const task = session.analyzeAsync(3);
    await fake.waitGoRequestedAsync();

    fake.emitInfo({ index: 1, depth: 8, scoreCp: 30, isMate: false, upperBound: false, lowerBound: false, pv: ['h2e2'] });
    fake.emitInfo({ index: 2, depth: 8, scoreCp: -20, isMate: false, upperBound: false, lowerBound: false, pv: ['h9g7'] });
    fake.emitInfo({ index: 1, depth: 10, scoreCp: 55, isMate: false, upperBound: false, lowerBound: false, pv: ['h2e2', 'h9g7'] });
    fake.emitInfo({ index: 3, depth: 10, scoreCp: 0, isMate: false, upperBound: false, lowerBound: false, pv: ['b0c2'] });
    fake.release('h9g7');

    const infos = await task;
    expect(infos).toHaveLength(3);
    expect([infos[0].index, infos[0].depth, infos[0].scoreCp]).toEqual([1, 10, 55]);
    expect([infos[1].index, infos[1].scoreCp]).toEqual([2, -20]);
    expect(infos[2].index).toBe(3);
    expect(fake.requests[0].multiPv).toBe(3);
    expect(fake.requests[0].depth).toBe(GameSession.DefaultAnalyzeDepth);
  });

  it('引擎思考中分析被门闸拒绝（返回空列表）', async () => {
    session.tryPlayMove(move('h2e2'));
    const engineTask = session.requestEngineMoveAsync();
    await fake.waitGoRequestedAsync();

    expect(await session.analyzeAsync(3)).toHaveLength(0);

    fake.release('h9g7');
    await engineTask;
  });

  it('对局结束后走子与引擎请求均被拒绝', async () => {
    expect(session.loadFen('3k5/9/9/9/9/9/9/9/3R5/4K4 b - - 0 1')).toBe(true);
    expect(session.isGameOver).toBe(true);
    expect(session.tryPlayMove(move('d9e9'))).toBe(false);
    expect(await session.requestEngineMoveAsync()).toBe(false);
  });

  it('引擎思考中不切模式；attachEngine 拒绝异实例', async () => {
    session.tryPlayMove(move('h2e2'));
    const task = session.requestEngineMoveAsync();
    await fake.waitGoRequestedAsync();

    expect(session.setMode(GameMode.TwoPlayers)).toBe(false);
    expect(session.attachEngine(new FakeEngineSession())).toBe(false);

    fake.release('h9g7');
    await task;
  });

  it('LoadFen 非法 FEN 抛异常且保持局面不变', () => {
    session.tryPlayMove(move('h2e2'));
    expect(() => session.loadFen('9/9 w')).toThrow(FenFormatException);
    expect(session.history).toHaveLength(1);
    expect(session.board.getPieceAt(new Position(4, 7))).toBe(Piece.RedCannon);
  });

  it('无引擎时双人模式完整可用，切人机被拒绝', () => {
    const bare = new GameSession();
    expect(bare.setMode(GameMode.PlayWithEngine)).toBe(false);
    expect(bare.tryPlayMove(move('h2e2'))).toBe(true);
    expect(bare.tryPlayMove(move('h9g7'))).toBe(true);
    expect(bare.history).toHaveLength(2);
  });
});

describe('GameSession 对局收束（判和与时限）', () => {
  /** 两匹马来回跳：4 半着回到起始局面，8 半着第三次出现即判和。 */
  const SHUTTLE = ['h0g2', 'h9g7', 'g2h0', 'g7h9'];

  it('同一局面三次出现判和，此后拒绝继续走子', () => {
    const session = new GameSession();
    const draws: boolean[] = [];
    session.onMoveApplied((e) => draws.push(e.isDraw));

    for (let round = 0; round < 2; round++) {
      for (const ucci of SHUTTLE) {
        expect(session.tryPlayMove(move(ucci))).toBe(true);
      }
    }

    expect(draws.filter(Boolean)).toHaveLength(1);
    expect(session.isDraw).toBe(true);
    expect(session.drawReason).toBe('repetition');
    expect(session.result).toBe('draw');
    expect(session.isGameOver).toBe(true);
    // 判和后不再接受走子。
    expect(session.tryPlayMove(move('h0g2'))).toBe(false);
  });

  it('悔棋撤销导致判和的一着后恢复进行中', () => {
    const session = new GameSession();
    for (let round = 0; round < 2; round++) {
      for (const ucci of SHUTTLE) {
        session.tryPlayMove(move(ucci));
      }
    }

    expect(session.isDraw).toBe(true);
    expect(session.undo()).toBe(true);
    expect(session.isDraw).toBe(false);
    expect(session.result).toBe('ongoing');
    // 撤销后局面回到第 7 着后，轮到黑方，可继续走子并再次判和。
    expect(session.tryPlayMove(move('g7h9'))).toBe(true);
    expect(session.isDraw).toBe(true);
  });

  it('连续无吃子达到自然限着判和（阈值可配置）', () => {
    const session = new GameSession();
    session.naturalLimitPlies = 4;
    const reasons: (string | null)[] = [];
    session.onMoveApplied((e) => reasons.push(e.drawReason));

    for (const ucci of ['h0g2', 'h9g7', 'b0c2', 'b9c7']) {
      expect(session.tryPlayMove(move(ucci))).toBe(true);
    }

    expect(session.isDraw).toBe(true);
    expect(session.drawReason).toBe('natural-limit');
    expect(reasons[reasons.length - 1]).toBe('natural-limit');
  });

  it('吃子重置自然限着计数', () => {
    const session = new GameSession();
    session.naturalLimitPlies = 3;
    expect(session.loadFen('4k4/9/9/4p4/9/9/4P4/9/9/4K4 w - - 0 1')).toBe(true);
    expect(session.tryPlayMove(move('e3e4'))).toBe(true); // 红兵进一
    expect(session.tryPlayMove(move('e6e5'))).toBe(true); // 黑卒进一
    expect(session.tryPlayMove(move('e4e5'))).toBe(true); // 红兵吃卒 → 计数归零
    expect(session.isDraw).toBe(false);
  });

  it('将死局面 result 为胜方且 isDraw 为 false（胜优先于和）', () => {
    const session = new GameSession();
    expect(session.loadFen('3k5/9/9/9/9/9/9/9/3R5/4K4 b - - 0 1')).toBe(true);
    expect(session.isGameOver).toBe(true);
    expect(session.result).toBe('red-win');
    expect(session.isDraw).toBe(false);
  });

  it('残局子力少时走子时限缩短（人机等待更短）', async () => {
    const fake = new FakeEngineSession();
    const session = new GameSession(fake);
    session.attachEngine(fake);
    session.setMode(GameMode.PlayWithEngine);

    // 单车对孤将（车马炮合计 1 ≤ 阈值）→ 残局时限；该局面有进攻子力，非死和。
    expect(session.loadFen('5k3/9/9/9/9/9/9/9/9/2R1K4 w - - 0 1')).toBe(true);
    expect(session.isGameOver).toBe(false);
    const task = session.requestEngineMoveAsync();
    await fake.waitGoRequestedAsync();
    expect(fake.requests[0].moveTimeMs).toBe(GameSession.EndgameMoveTimeMs);
    fake.release('c0c1');
    expect(await task).toBe(true);
  });

  it('引擎着法来源被记录（开局库 / 搜索）', async () => {
    const fake = new FakeEngineSession();
    const session = new GameSession(fake);
    session.attachEngine(fake);
    session.setMode(GameMode.PlayWithEngine);

    const bookTask = session.requestEngineMoveAsync();
    await fake.waitGoRequestedAsync();
    fake.release('h2e2', 'book');
    expect(await bookTask).toBe(true);
    expect(session.lastEngineSource).toBe('book');

    const searchTask = session.requestEngineMoveAsync();
    await fake.waitGoRequestedAsync();
    fake.release('h9g7', 'search');
    expect(await searchTask).toBe(true);
    expect(session.lastEngineSource).toBe('search');
  });
});
