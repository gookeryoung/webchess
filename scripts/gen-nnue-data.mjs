#!/usr/bin/env node
/**
 * NNUE 训练数据生成：引擎多进程并行自对弈，导出「静默局面 + 搜索分值 + 对局结果」。
 *
 * 与 gen-tuning-data.mjs（Texel 用）的差异：
 * 1. 每记录带 depth 搜索分值标签（NNUE 拟合目标），随机着法局面不入集；
 * 2. worker_threads 并行自对弈（每 worker 独立 seed 与分片输出，主进程合并）；
 * 3. 默认 depth 6（标签质量与生成速度折中；Texel 无标签可用 depth 5）。
 *
 * 打包运行（esbuild 用 node_modules/.pnpm 内的现成二进制）：
 *   node <esbuild> scripts/gen-nnue-data.mjs --bundle --platform=node --format=cjs \
 *     --alias:@webchess/core=./packages/core/src/index.ts \
 *     --alias:@webchess/engine=./packages/engine/src/index.ts \
 *     --outfile=F:\\DevCache\\gen-nnue.cjs --log-level=error
 *   node F:\\DevCache\\gen-nnue.cjs --games 2000 --depth 6 --workers 8 --out F:\\DevCache\\nnue-data.bin
 *
 * 二进制格式：头 12 字节（magic "WCND" + u32 版本 + u32 记录数），每记录 96 字节
 * （90 字节棋盘 + 1 字节走子方 1=红 + 1 字节结果 2=红胜/1=和/0=黑胜 + 4 字节 int32 LE 分值标签，
 * 分值与结果均为红方视角）。
 */
import { Worker, isMainThread, workerData } from 'node:worker_threads';
import { writeFileSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { Board, Piece, Rule } from '@webchess/core';
import { Searcher } from '@webchess/engine';

function parseArgs(argv) {
  const args = { games: 2000, depth: 6, workers: 8, out: 'F:\\DevCache\\nnue-data.bin', seed: 4200 };
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

    if (key === '--workers') {
      args.workers = Number(argv[++i]);
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

/** 记录 96 字节：90 棋盘 + side + result + int32 分值。 */
class RecordWriter {
  constructor() {
    this.chunks = [];
    this.count = 0;
    this.cur = new Uint8Array(96);
  }

  /** 记录一个局面（evalScore 为红方视角）。 */
  push(board, red, resultByte, evalScore) {
    const rec = new Uint8Array(96);
    rec.set(board.cells, 0);
    rec[90] = red ? 1 : 0;
    rec[91] = resultByte;
    const view = new DataView(rec.buffer);
    view.setInt32(92, evalScore, true);
    this.chunks.push(rec);
    this.count++;
  }

  toBuffer() {
    const header = Buffer.alloc(12);
    header.write('WCND', 0, 'ascii');
    header.writeUInt32LE(1, 4);
    header.writeUInt32LE(this.count, 8);
    const parts = this.chunks.map((r) => Buffer.from(r.buffer, r.byteOffset, r.length));
    return Buffer.concat([header, ...parts]);
  }
}

/**
 * 单局自对弈，过程中按准入条件收集静默局面。
 * 准入：过开局（10 半着）、最近 2 半着无吃子、不被将军、非随机着、搜索分未进杀棋区间。
 * @returns { result } 红方视角得分（1/0.5/0）。
 */
function playGame(writer, depth, rand) {
  const startCount = writer.count; // 本局记录起始下标（回填结果用）。
  const board = new Board();
  const searcher = new Searcher();
  const seen = new Map();
  let quietHalfmoves = 0;
  let halfmoves = 0;
  let result = 0.5;
  let lastCaptures = [1, 1]; // 最近两半着是否吃过子（1=吃过）。
  let lastScore = 0;
  let lastRandom = false;

  while (halfmoves < 400) {
    const red = board.redToMove;
    const inCheck = Rule.isInCheck(board, red);

    // 走子：小概率随机（开局段更高）保证多样性；随机着局面无可靠分值标签，不入集。
    const randomProb = halfmoves < 40 ? 0.06 : 0.02;
    let move = null;
    lastRandom = rand() < randomProb;
    if (lastRandom) {
      const moves = Rule.getAllLegalMoves(board, red);
      if (moves.length === 0) {
        result = red ? 0 : 1; // 走子方无着可走：负。
        break;
      }

      move = moves[(rand() * moves.length) | 0];
    } else {
      const outcome = searcher.search(board, { maxDepth: depth });
      if (outcome.bestMove === null) {
        result = red ? 0 : 1;
        break;
      }

      move = outcome.bestMove;
      lastScore = outcome.score;
    }

    if (
      halfmoves >= 10 &&
      !lastRandom &&
      lastCaptures[0] === 0 &&
      lastCaptures[1] === 0 &&
      !inCheck &&
      Math.abs(lastScore) < MATE_FILTER
    ) {
      writer.push(board, red, 0, red ? lastScore : -lastScore);
    }

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

  // 回填本局全部记录的结果字节（2=红胜 1=和 0=黑胜，红方视角）。
  const rByte = Math.round(result * 2);
  for (let i = startCount; i < writer.count; i++) {
    writer.chunks[i][91] = rByte;
  }

  return result;
}

/** worker 入口：跑分片对局并输出分片文件。 */
function runWorker(data) {
  const writer = new RecordWriter();
  const rand = mulberry32(data.seed);
  const start = Date.now();
  for (let game = 0; game < data.games; game++) {
    playGame(writer, data.depth, rand);
    if ((game + 1) % 20 === 0) {
      console.log(
        `[w${data.workerId}] 第 ${game + 1}/${data.games} 局，累计局面 ${writer.count}，耗时 ${((Date.now() - start) / 1000).toFixed(0)}s`,
      );
    }
  }

  mkdirSync(dirname(data.partPath), { recursive: true });
  writeFileSync(data.partPath, writer.toBuffer());
  console.log(`[w${data.workerId}] 完成：${writer.count} 局面 → ${data.partPath}`);
}

if (isMainThread) {
  const args = parseArgs(process.argv);
  console.log(
    `--- NNUE 数据生成：${args.games} 局 × depth=${args.depth}，${args.workers} workers，seed=${args.seed} ---`,
  );
  const start = Date.now();
  const perWorker = Math.floor(args.games / args.workers);
  const remainder = args.games % args.workers;
  const parts = [];
  let done = 0;
  for (let i = 0; i < args.workers; i++) {
    const games = perWorker + (i < remainder ? 1 : 0);
    if (games === 0) {
      continue;
    }

    const partPath = `${args.out}.part${i}`;
    parts.push(partPath);
    new Worker(__filename, {
      workerData: {
        workerId: i,
        games,
        depth: args.depth,
        seed: args.seed + i * 7919,
        partPath,
      },
    }).on('exit', (code) => {
      if (code !== 0) {
        console.error(`[w${i}] 异常退出 code=${code}`);
        process.exitCode = 1;
      }

      done++;
      if (done === parts.length) {
        mergeParts(parts, args, start);
      }
    });
  }
} else {
  runWorker(workerData);
}

/** 合并各 worker 分片为最终数据集（node v25 Windows 下主进程自然退出）。 */
function mergeParts(parts, args, start) {
  const merged = [];
  let count = 0;
  for (const p of parts) {
    const buf = readFileSync(p);
    const recCount = buf.readUInt32LE(8);
    merged.push(buf.subarray(12));
    count += recCount;
    rmSync(p);
  }

  const header = Buffer.alloc(12);
  header.write('WCND', 0, 'ascii');
  header.writeUInt32LE(1, 4);
  header.writeUInt32LE(count, 8);
  mkdirSync(dirname(args.out), { recursive: true });
  writeFileSync(args.out, Buffer.concat([header, ...merged]));
  console.log(
    `--- 完成：${count} 条局面 → ${args.out}，总耗时 ${((Date.now() - start) / 1000).toFixed(0)}s ---`,
  );
}
