import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Board, Piece } from '@webchess/core';
import { FastPosition } from '../fastBoard.js';
import {
  NnueAccumulator,
  loadNnueWeights,
  nnueEvaluateCells,
  nnueReady,
} from '../nnue.js';

const weightsBytes = readFileSync(
  join(import.meta.dirname, '../../wasm/nnue-weights.bin'),
);
const vectorBytes = readFileSync(join(import.meta.dirname, 'nnue-vectors.bin'));
const vectorEval: number[] = JSON.parse(
  readFileSync(join(import.meta.dirname, 'nnue-vectors.json'), 'utf-8'),
) as number[];

describe('NNUE 推理', () => {
  it('权重文件加载成功', () => {
    const buf = weightsBytes.buffer.slice(
      weightsBytes.byteOffset,
      weightsBytes.byteOffset + weightsBytes.byteLength,
    );
    expect(loadNnueWeights(buf)).toBe(true);
    expect(nnueReady()).toBe(true);
  });

  it('与 PyTorch 量化模拟逐位一致（64 条向量）', () => {
    expect(vectorEval.length).toBeGreaterThan(0);
    const count = vectorBytes.byteLength / 96;
    expect(count).toBe(vectorEval.length);
    for (let i = 0; i < count; i++) {
      const rec = vectorBytes.subarray(i * 96, (i + 1) * 96);
      const cells = rec.slice(0, 90);
      const redToMove = rec[90] === 1;
      const evalCp = nnueEvaluateCells(cells, redToMove);
      expect(evalCp).toBe(vectorEval[i]);
    }
  });

  it('增量 accumulator 与全量重算逐位一致（含 make/unmake 对称性）', () => {
    const pos = new FastPosition();
    pos.setFromBoard(new Board());
    const acc = new NnueAccumulator();
    acc.refresh(pos.cells);
    let seed = 12345;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x80000000;
    };

    for (let step = 0; step < 60; step++) {
      const before = acc.evaluate(pos.redToMove);
      const movesBuf = new Int32Array(256);
      const count = pos.genLegalMoves(movesBuf, 0);
      if (count === 0) {
        break;
      }

      const move = movesBuf[(rand() * count) | 0];
      const from = move & 127;
      const to = (move >>> 7) & 127;
      const moved = pos.cells[from];
      const captured = pos.cells[to];

      // make：增量评估与全量重算一致。
      acc.pushMove(moved, from, to, captured, step);
      pos.make(move);
      expect(acc.evaluate(pos.redToMove)).toBe(
        nnueEvaluateCells(pos.cells, pos.redToMove),
      );

      // unmake：popMove 恢复走子前评估。
      pos.unmake();
      acc.popMove(step);
      expect(acc.evaluate(pos.redToMove)).toBe(before);
    }
  });

  it('镜像局面评估一致（视角对称性）', () => {
    // 镜像棋盘 + 翻边后与原局面在网络视角下同构：走子方视角输出应完全相等。
    const board = new Board();
    const evalRed = nnueEvaluateCells(board.cells, true);
    // 构造行镜像棋盘 + 换边棋子。
    const mirrored = new Uint8Array(90);
    for (let sq = 0; sq < 90; sq++) {
      const piece = board.cells[sq];
      mirrored[sq] = piece === 0 ? 0 : piece <= Piece.RedPawn ? piece + 7 : piece - 7;
    }

    for (let y = 0; y < 5; y++) {
      for (let x = 0; x < 9; x++) {
        const a = mirrored[y * 9 + x];
        const b = mirrored[(9 - y) * 9 + x];
        mirrored[y * 9 + x] = b;
        mirrored[(9 - y) * 9 + x] = a;
      }
    }

    const evalBlack = nnueEvaluateCells(mirrored, false);
    expect(evalBlack).toBe(evalRed);
  });
});
