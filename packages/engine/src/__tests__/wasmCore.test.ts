import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { Board, cellIndex, Move, Piece, Position, Rule } from '@webchess/core';
import { FastPosition, moveFrom, moveTo } from '../fastBoard.js';
import { acquireWasmPosition, initEngineWasm, isWasmCoreLoaded } from '../wasmCore.js';

/** 走法编码 → UCCI（经内核 Move，保证坐标系语义一致）。 */
function moveToUcci(move: number): string {
  const from = moveFrom(move);
  const to = moveTo(move);
  return new Move(
    new Position(from % 9, (from / 9) | 0),
    new Position(to % 9, (to / 9) | 0),
  ).toUcci();
}

/** 确定性伪随机数（mulberry32），保证测试可复现。 */
function mulberry32(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 缓冲区 [base, base+count) 的着法编码集合。 */
function moveSet(buf: Int32Array, base: number, count: number): number[] {
  const arr: number[] = [];
  for (let i = base; i < base + count; i++) {
    arr.push(buf[i]);
  }
  return arr.sort((a, b) => a - b);
}

/** 断言两后端在同一 Board 局面上的全部派生状态一致。 */
function expectSameState(tsPos: FastPosition, wasmPos: ReturnType<typeof acquireWasmPosition>, label: string): void {
  if (!wasmPos) {
    throw new Error('WasmPosition 未获取到');
  }

  expect(wasmPos.redToMove, `${label} 走子方`).toBe(tsPos.redToMove);
  expect(wasmPos.keyLo, `${label} keyLo`).toBe(tsPos.keyLo);
  expect(wasmPos.keyHi, `${label} keyHi`).toBe(tsPos.keyHi);
  expect(wasmPos.baseScore, `${label} baseScore`).toBe(tsPos.baseScore);
  expect(wasmPos.heavyRed, `${label} heavyRed`).toBe(tsPos.heavyRed);
  expect(wasmPos.heavyBlack, `${label} heavyBlack`).toBe(tsPos.heavyBlack);
  expect(Array.from(wasmPos.cells), `${label} 棋盘`).toEqual(Array.from(tsPos.cells));

  const tsMoves = new Int32Array(256);
  const tsCount = tsPos.genMoves(tsMoves, 0, false);
  const wasmCount = wasmPos.genMoves(wasmPos.moveBuffer, 0, false);
  expect(
    moveSet(wasmPos.moveBuffer, 0, wasmCount).map(moveToUcci),
    `${label} 伪合法着法`,
  ).toEqual(moveSet(tsMoves, 0, tsCount).map(moveToUcci));

  const tsCaps = new Int32Array(256);
  const tsCapCount = tsPos.genMoves(tsCaps, 0, true);
  const wasmCapCount = wasmPos.genMoves(wasmPos.moveBuffer, 0, true);
  expect(
    moveSet(wasmPos.moveBuffer, 0, wasmCapCount).map(moveToUcci),
    `${label} 吃子着法`,
  ).toEqual(moveSet(tsCaps, 0, tsCapCount).map(moveToUcci));

  expect(wasmPos.inCheck(true), `${label} 红被将`).toBe(tsPos.inCheck(true));
  expect(wasmPos.inCheck(false), `${label} 黑被将`).toBe(tsPos.inCheck(false));
  expect(wasmPos.evaluateFull(), `${label} 静态评估`).toBe(tsPos.evaluateFull());

  // SEE：对每个吃子着法逐一对比交换净收益。
  for (let i = 0; i < tsCapCount; i++) {
    const move = tsCaps[i];
    const to = moveTo(move);
    const from = moveFrom(move);
    expect(wasmPos.see(to, from), `${label} SEE ${moveToUcci(move)}`).toBe(
      tsPos.see(to, from),
    );
  }
}

describe('WasmPosition — 与 FastPosition 逐项一致', () => {
  beforeAll(async () => {
    const bytes = readFileSync(
      join(import.meta.dirname, '../../wasm/engine-core.wasm'),
    ).buffer as ArrayBuffer;
    const ok = await initEngineWasm(bytes);
    expect(ok).toBe(true);
    expect(isWasmCoreLoaded()).toBe(true);
  });

  it('随机对局推进：每局面着法/键/评估/SEE 与纯 TS 完全一致', () => {
    const wasmPos = acquireWasmPosition();
    expect(wasmPos).not.toBeNull();
    if (!wasmPos) {
      return;
    }

    for (let game = 0; game < 3; game++) {
      const rng = mulberry32(0xbeef + game);
      const board = new Board();
      const tsPos = new FastPosition();
      for (let halfmove = 0; halfmove < 60; halfmove++) {
        tsPos.setFromBoard(board);
        wasmPos.setFromBoard(board);
        expectSameState(tsPos, wasmPos, `第${game}局第${halfmove}步`);

        // 深层 make/unmake 往返：增量栈同步性。
        const moves = new Int32Array(256);
        const count = tsPos.genLegalMoves(moves, 0);
        if (count === 0) {
          break;
        }

        for (let k = 0; k < Math.min(3, count); k++) {
          const move = moves[(Math.floor(rng() * count) + k) % count];
          tsPos.make(move);
          wasmPos.make(move);
          expect(wasmPos.keyLo, `往返 keyLo ${moveToUcci(move)}`).toBe(tsPos.keyLo);
          expect(wasmPos.baseScore, `往返 baseScore ${moveToUcci(move)}`).toBe(
            tsPos.baseScore,
          );
          tsPos.unmake();
          wasmPos.unmake();
          expect(wasmPos.keyLo, `还原 keyLo ${moveToUcci(move)}`).toBe(tsPos.keyLo);
        }

        const legal = Rule.getAllLegalMoves(board, board.redToMove);
        if (legal.length === 0) {
          break;
        }

        board.doMove(legal[Math.floor(rng() * legal.length)]);
      }
    }

  });

  it('实例池：acquireWasmPosition 提供独立状态（两个实例互不串扰）', () => {
    const a = acquireWasmPosition();
    const b = acquireWasmPosition();
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    if (!a || !b) {
      return;
    }

    const boardA = new Board();
    boardA.doMove(
      new Move(new Position(4, 6), new Position(4, 5)),
    );
    const boardB = new Board();
    a.setFromBoard(boardA);
    b.setFromBoard(boardB);
    expect(a.cells[cellIndex(4, 6)]).toBe(Piece.Empty);
    expect(b.cells[cellIndex(4, 6)]).toBe(Piece.RedPawn);
    expect(a.keyLo).not.toBe(b.keyLo);
  });
});
