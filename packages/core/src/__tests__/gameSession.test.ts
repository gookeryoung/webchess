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
