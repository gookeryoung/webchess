import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { Board, Move, Position, Rule } from '@webchess/core';
import { FastPosition } from '../fastBoard.js';
import { loadNnueWeights, nnueEvaluateCells, nnueReady } from '../nnue.js';
import { Searcher } from '../search.js';
import {
  acquireWasmPosition,
  initEngineWasm,
  isWasmNnueReady,
  uploadNnueWeights,
  wasmPoolStats,
} from '../wasmCore.js';
import type { WasmPosition } from '../wasmCore.js';
import { BuiltinEngine } from '../engine.js';

/**
 * WASM 内核的 NNUE（累加器 + 前向）与 TS 实现必须逐位一致：
 * - 静态评估：WASM vs FastPosition(NNUE) vs nnueEvaluateCells 三路一致；
 * - 增量维护：make/unmake 随机走子序列中每步一致，unmake 后精确还原。
 * 这是把 NNUE 下沉 WASM（NPS 提升）的正确性前提。
 */

const weightsBytes = readFileSync(join(import.meta.dirname, '../../wasm/nnue-weights.bin'));
const wasmBytes = readFileSync(join(import.meta.dirname, '../../wasm/engine-core.wasm'));

function asArrayBuffer(bytes: Buffer): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

/** 格下标（y*9+x）→ Position。 */
function toPosition(sq: number): Position {
  return new Position(sq % 9, Math.floor(sq / 9));
}

/** 打包着法（from | to<<7）→ 内核 Move。 */
function toMove(move: number): Move {
  return new Move(toPosition(move & 127), toPosition((move >>> 7) & 127));
}

/** 全文件共享一个 WASM 实例（池只有 4 个，逐个 acquire 会耗尽）。 */
let wasmPos: WasmPosition;
let tsPos: FastPosition;

beforeAll(async () => {
  loadNnueWeights(asArrayBuffer(weightsBytes));
  // NNUE 必须真的加载成功，否则本文件测的就变成手工评估（历史上踩过这个坑）。
  expect(nnueReady()).toBe(true);
  expect(await initEngineWasm(asArrayBuffer(wasmBytes))).toBe(true);
  expect(uploadNnueWeights(asArrayBuffer(weightsBytes))).toBe(true);
  wasmPos = acquireWasmPosition(true) as WasmPosition;
  expect(wasmPos).not.toBeNull();
  tsPos = new FastPosition({ nnue: true });
});

describe('WASM NNUE 与 TS NNUE 一致性', () => {
  it('内核已支持并启用 NNUE 权重', () => {
    expect(isWasmNnueReady()).toBe(true);
  });

  it('Searcher 后端定型为 nnue+wasm（权重与内核都就绪时）', () => {
    const wasmSearcher = new Searcher();
    expect(wasmSearcher.backend).toBe('nnue+wasm');
    wasmSearcher.dispose();

    const tsSearcher = new Searcher({ wasm: false });
    expect(tsSearcher.backend).toBe('nnue');
    tsSearcher.dispose();
  });

  it('dispose 归还实例：反复创建/释放不占用池，且始终不降级', () => {
    const baseline = wasmPoolStats().inUse;
    for (let i = 0; i < 8; i++) {
      const searcher = new Searcher();
      expect(searcher.backend, `第 ${i + 1} 次创建`).toBe('nnue+wasm');
      expect(wasmPoolStats().inUse).toBe(baseline + 1);

      searcher.dispose();
      // 归还后退化为纯 TS + NNUE（仍可继续搜索，仅速度回落）。
      expect(searcher.backend).toBe('nnue');
      expect(wasmPoolStats().inUse).toBe(baseline);

      // 释放后仍能正常搜索（不因归还实例而失效）。
      const outcome = searcher.search(new Board(), { maxDepth: 2, moveTimeMs: 2000 });
      expect(outcome.bestMove).not.toBeNull();
    }

    expect(wasmPoolStats().inUse).toBe(baseline);
  });

  it('BuiltinEngine.dispose 会归还实例（引擎重建不泄漏实例池）', async () => {
    const baseline = wasmPoolStats().inUse;
    for (let i = 0; i < 6; i++) {
      const engine = new BuiltinEngine(4, 500);
      await engine.start();
      await engine.go({ fen: new Board().toFen(), depth: 2, moveTimeMs: 500 });
      await engine.dispose();
    }

    expect(wasmPoolStats().inUse).toBe(baseline);
  });

  it('静态评估三路逐位一致', () => {
    const fens = [
      new Board().toFen(),
      // 黑方走子 + 满子力
      'rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR b - - 0 1',
      // 残局（车兵对士象全）
      '3ak4/4a4/4b4/9/9/9/4P4/9/3R5/4K4 w - - 0 1',
    ];

    for (const fen of fens) {
      const board = Board.fromFen(fen);
      tsPos.setFromBoard(board);
      wasmPos.setFromBoard(board);
      const reference = nnueEvaluateCells(board.cells, board.redToMove);
      expect(tsPos.evaluateFull(), `TS ${fen}`).toBe(reference);
      expect(wasmPos.evaluateFull(), `WASM ${fen}`).toBe(reference);
    }
  });

  it('随机走子序列中增量维护逐步一致，unmake 精确还原', () => {
    const board = new Board();
    wasmPos.setFromBoard(board);
    tsPos.setFromBoard(board);
    const initial = wasmPos.evaluateFull();

    const applied: number[] = [];
    let seed = 20261014;
    const nextSeed = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed;
    };

    // genLegalMoves 要求传入实例自带的 moveBuffer（零拷贝约定）。
    const buf = wasmPos.moveBuffer;
    for (let step = 0; step < 40; step++) {
      const count = wasmPos.genLegalMoves(buf, 0);
      if (count === 0) {
        break;
      }

      const move = buf[nextSeed() % count];
      board.doMove(toMove(move));
      wasmPos.make(move);
      tsPos.make(move);
      applied.push(move);

      const reference = nnueEvaluateCells(wasmPos.cells, wasmPos.redToMove);
      expect(tsPos.evaluateFull(), `第 ${step + 1} 步 TS`).toBe(reference);
      expect(wasmPos.evaluateFull(), `第 ${step + 1} 步 WASM`).toBe(reference);
      expect(wasmPos.redToMove, `第 ${step + 1} 步走子方`).toBe(board.redToMove);
    }

    expect(applied.length).toBeGreaterThan(20);
    for (let i = applied.length - 1; i >= 0; i--) {
      wasmPos.unmake();
      tsPos.unmake();
    }

    expect(wasmPos.evaluateFull()).toBe(initial);
    expect(tsPos.evaluateFull()).toBe(initial);
  });

  it('走子方视角翻边正确（镜像局面同号）', () => {
    // 黑方多一车、轮红：走子方（红）视角为负。
    const redToMove = Board.fromFen('3k5/9/9/9/9/3r5/9/9/9/4K4 w - - 0 1');
    wasmPos.setFromBoard(redToMove);
    const view = wasmPos.evaluateFull();
    expect(view).toBe(nnueEvaluateCells(redToMove.cells, true));
    expect(view).toBeLessThan(0);

    // 行镜像 + 换色：红方多一车、轮黑，走子方（黑）视角应同样为负且数值相等。
    const blackToMove = Board.fromFen('4k4/9/9/9/3R5/9/9/9/9/3K5 b - - 0 1');
    wasmPos.setFromBoard(blackToMove);
    expect(wasmPos.evaluateFull()).toBe(nnueEvaluateCells(blackToMove.cells, false));
    expect(wasmPos.evaluateFull()).toBe(view);
  });

  it('走法生成与规则一致（WASM 与内核 Rule 同集）', () => {
    const board = new Board();
    wasmPos.setFromBoard(board);
    const buf = wasmPos.moveBuffer;
    const count = wasmPos.genLegalMoves(buf, 0);
    const wasmSet = new Set<string>();
    for (let i = 0; i < count; i++) {
      wasmSet.add(toMove(buf[i]).toUcci());
    }

    const ruleSet = new Set(Rule.getAllLegalMoves(board, true).map((m) => m.toUcci()));
    expect(wasmSet).toEqual(ruleSet);
  });
});
