#!/usr/bin/env node
/**
 * 引擎自对弈竞技场：两组搜索配置互弈 N 局，统计胜率并换算 ELO 差。
 * WASM 升级决策的前置测量工具（quantify「更深/更强配置的强度增益」）。
 *
 * 引擎为源码包（exports 指向 src），故经 esbuild（vite 内置依赖，零新增）
 * 打包后运行：
 *   npx esbuild scripts/elo-arena.mjs --bundle --platform=node --format=cjs \
 *     --alias:@webchess/core=./packages/core/src/index.ts \
 *     --alias:@webchess/engine=./packages/engine/src/index.ts \
 *     --outfile=/tmp/webchess-arena.cjs --log-level=error
 *   node /tmp/webchess-arena.cjs --games 20 --depth-a 4 --depth-b 6 --time-a 300 --time-b 300
 *
 * 后端开关（默认双方纯 TS；--legacy-engine 侧恒为纯 TS）：
 *   --wasm-a / --wasm-b  对应方启用 WASM 内核（须能读到 wasm 产物），
 *                        同参数对比即测 WASM 加速比（NPS）与行为一致性。
 *   --legacy-engine X    A 方外挂旧参数引擎 bundle（Texel 调参 A/B 基线，
 *                        由 git show HEAD 的 engine src 另行打包）。
 *
 * 终局语义与引擎一致：将死/困毙判走子方负；同局面三现、连续 120 半着
 * 无吃子、总 400 半着封顶均判和。A 方红黑各半局，消除先手优势偏差。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Board, Rule } from '@webchess/core';
import { Searcher, initEngineWasm } from '@webchess/engine';

function parseArgs(argv) {
  const args = {
    games: 20,
    depthA: 4,
    depthB: 6,
    timeA: 300,
    timeB: 300,
    legacy: false,
    wasmA: false,
    wasmB: false,
    legacyEngine: null,
  };
  for (let i = 2; i < argv.length; i++) {
    const key = argv[i];
    if (key === '--legacy') {
      args.legacy = true;
      continue;
    }

    if (key === '--wasm-a') {
      args.wasmA = true;
      continue;
    }

    if (key === '--wasm-b') {
      args.wasmB = true;
      continue;
    }

    if (key === '--legacy-engine') {
      args.legacyEngine = argv[++i];
      continue;
    }

    const value = Number(argv[++i]);
    if (!Number.isFinite(value)) {
      throw new Error(`参数 ${key} 缺少合法数值`);
    }

    if (key === '--games') args.games = value;
    else if (key === '--depth-a') args.depthA = value;
    else if (key === '--depth-b') args.depthB = value;
    else if (key === '--time-a') args.timeA = value;
    else if (key === '--time-b') args.timeB = value;
    else throw new Error(`未知参数 ${key}`);
  }
  return args;
}

/** 单局对弈：返回 1（A 胜）/ 0（A 负）/ 0.5（和）与统计信息。 */
function playGame(searcherA, searcherB, paramsA, paramsB, aIsRed) {
  const board = new Board();
  const seen = new Map();
  let quietHalfmoves = 0;
  let halfmoves = 0;
  let aDepthSum = 0;
  let aNodes = 0;
  let aElapsed = 0;
  let bDepthSum = 0;
  let bNodes = 0;
  let bElapsed = 0;
  let result = 0.5;
  let reason = '封顶';

  while (halfmoves < 400) {
    const red = board.redToMove;
    const aTurn = red === aIsRed;
    const searcher = aTurn ? searcherA : searcherB;
    const params = aTurn ? paramsA : paramsB;

    const outcome = searcher.search(board, params);
    const move = outcome.bestMove;
    if (move === null) {
      // 无着可走：将死或困毙，当前走子方（searcher 一方）负。
      result = aTurn ? 0 : 1;
      reason = '绝杀';
      break;
    }

    if (board.getPieceAt(move.to) === 0) {
      quietHalfmoves++;
    } else {
      quietHalfmoves = 0;
    }

    if (aTurn) {
      aDepthSum += outcome.stats.depth;
      aNodes += outcome.stats.nodes;
      aElapsed += outcome.stats.elapsedMs;
    } else {
      bDepthSum += outcome.stats.depth;
      bNodes += outcome.stats.nodes;
      bElapsed += outcome.stats.elapsedMs;
    }

    board.doMove(move);
    halfmoves++;

    // 三现判和：键取 FEN 前 4 段（盘面+走子方），回合计数段剔除。
    const fen = board.toFen().split(' ').slice(0, 4).join(' ');
    const count = (seen.get(fen) ?? 0) + 1;
    if (count >= 3) {
      result = 0.5;
      reason = '三现';
      break;
    }
    seen.set(fen, count);

    if (quietHalfmoves >= 120) {
      result = 0.5;
      reason = '限着';
      break;
    }

    if (Rule.isCheckmate(board, board.redToMove) || Rule.isStalemate(board, board.redToMove)) {
      // 对方无着可走（将死/困毙）：刚走子的一方（上一步的 searcher）胜。
      result = aTurn ? 1 : 0;
      reason = '绝杀';
      break;
    }
  }

  const aMoves = Math.ceil(halfmoves / 2);
  return {
    result,
    reason,
    halfmoves,
    a: { depthAvg: aDepthSum / Math.max(1, aMoves), nodes: aNodes, elapsed: aElapsed },
    b: { depthAvg: bDepthSum / Math.max(1, aMoves), nodes: bNodes, elapsed: bElapsed },
  };
}

const args = parseArgs(process.argv);

// WASM 内核：任一方启用时先加载（Searcher 构造期自动获取实例）。
// 路径依次尝试 cwd（仓库根运行）与 bundle 所在目录（任意位置运行）。
if (args.wasmA || args.wasmB) {
  const candidates = [
    resolve(process.cwd(), 'packages/engine/wasm/engine-core.wasm'),
    new URL('../packages/engine/wasm/engine-core.wasm', import.meta.url),
  ];
  let bytes = null;
  for (const p of candidates) {
    try {
      bytes = readFileSync(p).buffer;
      break;
    } catch {
      // 尝试下一候选路径。
    }
  }

  if (!bytes || !(await initEngineWasm(bytes))) {
    throw new Error('WASM 内核加载失败（检查 packages/engine/wasm/engine-core.wasm）');
  }
}

const paramsA = { maxDepth: args.depthA, moveTimeMs: args.timeA };
const paramsB = { maxDepth: args.depthB, moveTimeMs: args.timeB };
// 后端定型：默认纯 TS（wasm:false），--wasm-x 侧走自动获取。
const tsOnly = { wasm: false };
const optionsA = args.wasmA ? undefined : tsOnly;
const optionsB = args.wasmB ? undefined : tsOnly;
// --legacy-engine：A 方换用外挂旧参数引擎（纯 TS，无 wasm 接入）。
let legacySearcher = null;
if (args.legacyEngine) {
  const mod = await import(pathToFileURL(args.legacyEngine));
  legacySearcher = (mod.default ?? mod).Searcher;
}
// --legacy：A 方关闭全部新搜索特性作为基线（测阶段 1 特性增益）。
const legacyOptions = args.legacy
  ? { singularExtension: false, countermove: false, captureHistory: false, mateDistance: false }
  : undefined;
const searcherA = legacySearcher
  ? new legacySearcher({ ...legacyOptions, wasm: false })
  : new Searcher({ ...legacyOptions, ...optionsA });
const searcherB = new Searcher(optionsB);

console.log(
  `--- 自对弈竞技场：A(depth=${args.depthA}, ${args.timeA}ms, ` +
    `${legacySearcher ? 'legacy参数' : args.wasmA ? 'wasm' : 'ts'}) vs ` +
    `B(depth=${args.depthB}, ${args.timeB}ms, ${args.wasmB ? 'wasm' : 'ts'})，` +
    `共 ${args.games} 局${args.legacy ? '（legacy 特性）' : ''} ---`,
);

let aWins = 0;
let bWins = 0;
let draws = 0;
let aDepthTotal = 0;
let bDepthTotal = 0;
let aNodesTotal = 0;
let bNodesTotal = 0;
let aElapsedTotal = 0;
let bElapsedTotal = 0;
let totalHalfmoves = 0;
let reasonCount = { 绝杀: 0, 三现: 0, 限着: 0, 封顶: 0 };

for (let game = 0; game < args.games; game++) {
  const aIsRed = game % 2 === 0;
  const { result, reason, halfmoves, a, b } = playGame(
    searcherA,
    searcherB,
    paramsA,
    paramsB,
    aIsRed,
  );
  if (result === 1) aWins++;
  else if (result === 0) bWins++;
  else draws++;
  aDepthTotal += a.depthAvg;
  bDepthTotal += b.depthAvg;
  aNodesTotal += a.nodes;
  bNodesTotal += b.nodes;
  aElapsedTotal += a.elapsed;
  bElapsedTotal += b.elapsed;
  totalHalfmoves += halfmoves;
  reasonCount[reason]++;

  const mark = result === 1 ? 'A胜' : result === 0 ? 'B胜' : '和';
  console.log(
    `第 ${game + 1} 局  A执${aIsRed ? '红' : '黑'}  ${mark}（${reason}）  ${halfmoves} 半着  ` +
      `A均深 ${a.depthAvg.toFixed(1)} / B均深 ${b.depthAvg.toFixed(1)}`,
  );
}

const games = args.games;
const scoreA = (aWins + draws * 0.5) / games;
const elo = scoreA <= 0 ? -9999 : scoreA >= 1 ? 9999 : -400 * Math.log10(1 / scoreA - 1);
const npsA = aNodesTotal / (aElapsedTotal / 1000);
const npsB = bNodesTotal / (bElapsedTotal / 1000);

console.log('--- 汇总 ---');
console.log(`A ${aWins} 胜 / 和 ${draws} / ${bWins} 胜 B（A 得分率 ${(scoreA * 100).toFixed(1)}%）`);
console.log(`ELO 差（A-B）：${elo >= 0 ? '+' : ''}${elo.toFixed(0)}`);
console.log(
  `NPS：A ${(npsA / 1000).toFixed(1)}k vs B ${(npsB / 1000).toFixed(1)}k` +
    `（加速比 ${(npsA / npsB).toFixed(2)}x）`,
);
console.log(
  `平均深度 A ${aDepthTotal / games} vs B ${bDepthTotal / games}；` +
    `平均 ${totalHalfmoves / games} 半着/局；终局：` +
    `绝杀 ${reasonCount.绝杀}、三现 ${reasonCount.三现}、限着 ${reasonCount.限着}、封顶 ${reasonCount.封顶}`,
);
