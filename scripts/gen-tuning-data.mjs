#!/usr/bin/env node
/**
 * Texel 调参数据生成：引擎自对弈，导出「静默局面 + 对局结果」二进制训练集。
 *
 * 局面准入条件（近似静默，保证静态评估稳定）：
 * 1. 开局前 10 半着不入集（布局阶段评估噪声大）；
 * 2. 最近 2 半着均无吃子；
 * 3. 当前方未被将军；
 * 4. 搜索分值未进入杀棋区间（强制线不反映评估质量）。
 *
 * 随机化：每着以小概率从合法着法均匀采样（开局段概率更高），保证对局多样性。
 *
 * 打包运行（esbuild 用 node_modules/.pnpm 内的现成二进制）：
 *   node <esbuild> scripts/gen-tuning-data.mjs --bundle --platform=node --format=cjs \
 *     --alias:@webchess/core=./packages/core/src/index.ts \
 *     --alias:@webchess/engine=./packages/engine/src/index.ts \
 *     --outfile=F:\\DevCache\\gen-data.cjs --log-level=error
 *   node F:\\DevCache\\gen-data.cjs --games 800 --depth 5 --out F:\\DevCache\\tuning-data.bin
 *
 * 二进制格式：头 12 字节（magic "WCQD" + u32 版本 + u32 记录数），每记录 92 字节
 * （90 字节棋盘 + 1 字节走子方 1=红 + 1 字节结果 2=红胜/1=和/0=黑胜，红方视角）。
 */
import { Board, Piece, Rule } from '@webchess/core';
import { Searcher } from '@webchess/engine';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

function parseArgs(argv) {
  const args = { games: 800, depth: 5, out: 'F:\\DevCache\\tuning-data.bin', seed: 42 };
  for (let i = 2; i < argv.length; i++) {
    const key = argv[i];
    if (key === '--seed') {
      args.seed = Number(argv[++i]);
      continue;
    }

    if (key === '--out') {
      args.out = argv[++i];
      continue;
    }

    const value = Number(argv[++i]);
    if (!Number.isFinite(value)) {
      throw new Error(`参数 ${key} 缺少合法数值`);
    }

    if (key === '--games') args.games = value;
    else if (key === '--depth') args.depth = value;
    else throw new Error(`未知参数 ${key}`);
  }
  return args;
}

/** 可复现伪随机（mulberry32）。 */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 杀棋分界（与 search.ts MATE_BOUND 同量级，低一点留余量）。 */
const MATE_FILTER = 30000;

const args = parseArgs(process.argv);
const rand = mulberry32(args.seed);
const searcher = new Searcher();

/** 记录缓冲。 */
const records = [];
let recordCount = 0;

/** 采样一着：小概率随机走，否则搜索引擎最佳着。返回 { move, score }。 */
function pickMove(board, depth, halfmoves) {
  const randomProb = halfmoves < 40 ? 0.06 : 0.02;
  if (rand() < randomProb) {
    const moves = Rule.getAllLegalMoves(board, board.redToMove);
    if (moves.length === 0) {
      return null;
    }

    const move = moves[(rand() * moves.length) | 0];
    return { move, score: 0 };
  }

  const outcome = searcher.search(board, { maxDepth: depth });
  return { move: outcome.bestMove, score: outcome.score };
}

/**
 * 单局自对弈，过程中按准入条件收集静默局面。
 * @returns { result, startCount } —— result 为红方视角得分（1/0.5/0），startCount 为本局记录起始下标。
 */
function playGame(depth) {
  const startCount = recordCount;
  const board = new Board();
  const seen = new Map();
  let quietHalfmoves = 0;
  let halfmoves = 0;
  let result = 0.5;
  let lastCaptures = [1, 1]; // 最近两半着是否吃过子（1=吃过）。

  while (halfmoves < 400) {
    const red = board.redToMove;
    const inCheck = Rule.isInCheck(board, red);
    const outcome = pickMove(board, depth, halfmoves);
    if (outcome === null) {
      result = red ? 0 : 1; // 走子方无着可走：负。
      break;
    }

    // 局面准入：过开局、双静默、不被将军、非杀棋分。
    if (
      halfmoves >= 10 &&
      lastCaptures[0] === 0 &&
      lastCaptures[1] === 0 &&
      !inCheck &&
      Math.abs(outcome.score) < MATE_FILTER
    ) {
      const rec = new Uint8Array(92);
      rec.set(board.cells, 0);
      rec[90] = red ? 1 : 0;
      records.push(rec);
      recordCount++;
    }

    const move = outcome.move;
    const captured = board.getPieceAt(move.to) !== Piece.Empty;
    board.doMove(move);
    halfmoves++;
    lastCaptures = [lastCaptures[1], captured ? 1 : 0];
    if (captured) {
      quietHalfmoves = 0;
    } else {
      quietHalfmoves++;
    }

    // 三现判和。
    const fen = board.toFen().split(' ').slice(0, 4).join(' ');
    const count = (seen.get(fen) ?? 0) + 1;
    if (count >= 3) {
      result = 0.5;
      break;
    }
    seen.set(fen, count);

    if (quietHalfmoves >= 120) {
      result = 0.5;
      break;
    }

    if (Rule.isCheckmate(board, board.redToMove) || Rule.isStalemate(board, board.redToMove)) {
      result = red ? 1 : 0; // 走子方绝杀对方：胜。
      break;
    }
  }

  // 回填本局全部记录的结果字节。
  const rByte = Math.round(result * 2); // 2=红胜 1=和 0=黑胜。
  for (let i = startCount; i < recordCount; i++) {
    records[i][91] = rByte;
  }

  return { result, startCount };
}

console.log(
  `--- Texel 数据生成：${args.games} 局自对弈（depth=${args.depth}, seed=${args.seed}） ---`,
);
const start = Date.now();
let redWins = 0;
let blackWins = 0;
let draws = 0;
for (let game = 0; game < args.games; game++) {
  const { result } = playGame(args.depth);
  if (result === 1) redWins++;
  else if (result === 0) blackWins++;
  else draws++;

  if ((game + 1) % 25 === 0) {
    const elapsed = ((Date.now() - start) / 1000).toFixed(0);
    console.log(
      `第 ${game + 1} 局完成，累计局面 ${recordCount}，红胜 ${redWins}/和 ${draws}/黑胜 ${blackWins}，耗时 ${elapsed}s`,
    );
  }
}

mkdirSync(dirname(args.out), { recursive: true });
const header = Buffer.alloc(12);
header.write('WCQD', 0, 'ascii');
header.writeUInt32LE(1, 4);
header.writeUInt32LE(recordCount, 8);
const body = Buffer.concat(records.map((r) => Buffer.from(r.buffer, r.byteOffset, r.length)));
writeFileSync(args.out, Buffer.concat([header, body]));
console.log(
  `--- 完成：红胜 ${redWins}/和 ${draws}/黑胜 ${blackWins}，${recordCount} 条静默局面，输出 ${args.out}，总耗时 ${((Date.now() - start) / 1000).toFixed(0)}s ---`,
);
