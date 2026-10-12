#!/usr/bin/env node
/**
 * Texel 调参：对评估线性参数做批量梯度下降（Adam + sigmoid 损失）。
 *
 * 参数向量（638 维，全部线性可分，特征可离线预计算）：
 * - PST：7 类棋子 × 90 格（红方视角，黑子特征 = 红方行镜像下标取负）= 630 维；
 * - 知识项 8 维：车/马机动性权重、残局马/炮/王步调整、空头炮、缺士/缺象惩罚。
 *
 * 初始化自当前 evaluate.ts 导出的 PIECE_SCORE/PIECE_VALUE（PST = 合成分 - 子力值），
 * 保证调参从现状出发只做数据驱动的微调；无梯度覆盖的格（将帅不可达格等）保持初值。
 *
 * 打包运行：
 *   node <esbuild> scripts/texel-tune.mjs --bundle --platform=node --format=cjs \
 *     --alias:@webchess/core=./packages/core/src/index.ts \
 *     --alias:@webchess/engine=./packages/engine/src/index.ts \
 *     --outfile=F:\\DevCache\\texel.cjs --log-level=error
 *   node F:\\DevCache\\texel.cjs --data F:\\DevCache\\tuning-data.bin --epochs 3000
 *
 * 输出：F:\\DevCache\\tuned-params.json（PST 数组 + 知识项常量，供回写 evaluate.ts）。
 */
import { Piece } from '@webchess/core';
import { PIECE_SCORE, PIECE_VALUE } from '@webchess/engine';
import { readFileSync, writeFileSync } from 'node:fs';

function parseArgs(argv) {
  const args = {
    data: 'F:\\DevCache\\tuning-data.bin',
    epochs: 3000,
    lr: 0.08,
    k: 0.0058,
    out: 'F:\\DevCache\\tuned-params.json',
  };
  for (let i = 2; i < argv.length; i++) {
    const key = argv[i];
    if (key === '--data' || key === '--out') {
      args[key.slice(2)] = argv[++i];
      continue;
    }

    const value = Number(argv[++i]);
    if (!Number.isFinite(value)) {
      throw new Error(`参数 ${key} 缺少合法数值`);
    } else if (key === '--epochs') args.epochs = value;
    else if (key === '--lr') args.lr = value;
    else if (key === '--k') args.k = value;
    else throw new Error(`未知参数 ${key}`);
  }
  return args;
}

// ---- 参数布局 ----
// PST 下标 = t*90+sq（t=1..7），t=0 区 90 项闲置，N_PST 取 8*90 保证下标不越界。
const N_PST = 8 * 90;
const N_DYN = 8;
const N_PARAMS = N_PST + N_DYN;
const D_ROOK_MOB = 0;
const D_KNIGHT_MOB = 1;
const D_EG_KNIGHT = 2;
const D_EG_CANNON = 3;
const D_EG_KING = 4;
const D_FACING = 5;
const D_MISS_ADV = 6;
const D_MISS_BISH = 7;

/** 与 evaluate.ts 一致的知识项常量（重子阶段分母、威胁基准）。 */
const FULL_PHASE = 2 * (920 + 420 + 480) * 2;
const THREAT_FULL = 1840;

/** 当前知识项初值（与 evaluate.ts 保持一致）。 */
const DYN_INIT = [2, 4, 30, 25, 15, 30, 24, 20];

// ---- 数据加载 ----
const args = parseArgs(process.argv);
const buf = readFileSync(args.data);
if (buf.toString('ascii', 0, 4) !== 'WCQD') {
  throw new Error('数据文件格式错误（magic 不符）');
}

const count = buf.readUInt32LE(8);
console.log(`--- Texel 调参：${count} 条局面，${args.epochs} 轮，lr=${args.lr}，K=${args.k} ---`);

/** 棋盘数据提取：每记录 92 字节（90 cells + side + result）。 */
function recordCells(i) {
  const off = 12 + i * 92;
  return buf.subarray(off, off + 90);
}
/** 走子方与结果。 */
const sides = new Uint8Array(count);
const results = new Float64Array(count);
for (let i = 0; i < count; i++) {
  const off = 12 + i * 92 + 90;
  sides[i] = buf[off];
  results[i] = buf[off + 1] / 2; // 红方视角 1/0.5/0。
}

// ---- 特征预计算 ----
/** 每记录棋子特征（下标 + 符号），扁平存储；红子 +1、黑子 -1。 */
const pieceFeat = new Int32Array(count * 32);
const pieceSign = new Int8Array(count * 32);
const pieceFeatCount = new Uint8Array(count);
/** 每记录 8 维动态特征。 */
const dynFeat = new Float64Array(count * N_DYN);

/** 车四方向可直达空格数（遇子即止）。 */
function rookMobility(cells, sq) {
  const x = sq % 9;
  const y = (sq / 9) | 0;
  let n = 0;
  for (let dir = 0; dir < 4; dir++) {
    const dx = dir === 2 ? -1 : dir === 3 ? 1 : 0;
    const dy = dir === 0 ? 1 : dir === 1 ? -1 : 0;
    let tx = x + dx;
    let ty = y + dy;
    while (tx >= 0 && tx <= 8 && ty >= 0 && ty <= 9 && cells[ty * 9 + tx] === Piece.Empty) {
      n++;
      tx += dx;
      ty += dy;
    }
  }
  return n;
}

const KNIGHT_X = [1, 1, -1, -1, 2, 2, -2, -2];
const KNIGHT_Y = [2, -2, 2, -2, 1, -1, 1, -1];
const LEG_X = [0, 0, 0, 0, 1, 1, -1, -1];
const LEG_Y = [1, -1, 1, -1, 0, 0, 0, 0];

/** 马机动性：蹩马腿不挡且落点非己方的目标数。 */
function knightMobility(cells, sq) {
  const x = sq % 9;
  const y = (sq / 9) | 0;
  const red = cells[sq] === Piece.RedKnight;
  let n = 0;
  for (let i = 0; i < 8; i++) {
    const tx = x + KNIGHT_X[i];
    const ty = y + KNIGHT_Y[i];
    if (tx < 0 || tx > 8 || ty < 0 || ty > 9) {
      continue;
    }

    const target = cells[ty * 9 + tx];
    if (target !== Piece.Empty && (target <= Piece.RedPawn) === red) {
      continue;
    }

    if (cells[(y + LEG_Y[i]) * 9 + (x + LEG_X[i])] !== Piece.Empty) {
      continue;
    }

    n++;
  }
  return n;
}

/** 己方将位沿纵向第一个子是否为对方炮（空头炮）。 */
function facingCannon(cells, kingSq, enemyCannon) {
  const kx = kingSq % 9;
  const ky = (kingSq / 9) | 0;
  for (let ty = ky - 1; ty >= 0; ty--) {
    const piece = cells[ty * 9 + kx];
    if (piece !== Piece.Empty) {
      return piece === enemyCannon;
    }
  }
  for (let ty = ky + 1; ty <= 9; ty++) {
    const piece = cells[ty * 9 + kx];
    if (piece !== Piece.Empty) {
      return piece === enemyCannon;
    }
  }
  return false;
}

for (let i = 0; i < count; i++) {
  const cells = recordCells(i);
  let kingRed = -1;
  let kingBlack = -1;
  let heavyRed = 0;
  let heavyBlack = 0;
  let advisorRed = 0;
  let advisorBlack = 0;
  let bishopRed = 0;
  let bishopBlack = 0;
  let knightRed = 0;
  let knightBlack = 0;
  let cannonRed = 0;
  let cannonBlack = 0;
  let rookMobRed = 0;
  let rookMobBlack = 0;
  let knightMobRed = 0;
  let knightMobBlack = 0;

  let featN = 0;
  const base = i * 32;
  for (let sq = 0; sq < 90; sq++) {
    const piece = cells[sq];
    if (piece === Piece.Empty) {
      continue;
    }

    if (piece <= Piece.RedPawn) {
      pieceFeat[base + featN] = piece * 90 + sq;
      pieceSign[base + featN++] = 1;
      switch (piece) {
        case Piece.RedKing: kingRed = sq; break;
        case Piece.RedKnight:
          knightRed++;
          knightMobRed += knightMobility(cells, sq);
          heavyRed += PIECE_VALUE[piece];
          break;
        case Piece.RedRook:
          rookMobRed += rookMobility(cells, sq);
          heavyRed += PIECE_VALUE[piece];
          break;
        case Piece.RedCannon:
          cannonRed++;
          heavyRed += PIECE_VALUE[piece];
          break;
        case Piece.RedAdvisor: advisorRed++; break;
        case Piece.RedBishop: bishopRed++; break;
        default: break;
      }
    } else {
      const type = piece - 7;
      const mirrorSq = (9 - ((sq / 9) | 0)) * 9 + (sq % 9);
      pieceFeat[base + featN] = type * 90 + mirrorSq;
      pieceSign[base + featN++] = -1;
      switch (piece) {
        case Piece.BlackKing: kingBlack = sq; break;
        case Piece.BlackKnight:
          knightBlack++;
          knightMobBlack += knightMobility(cells, sq);
          heavyBlack += PIECE_VALUE[piece];
          break;
        case Piece.BlackRook:
          rookMobBlack += rookMobility(cells, sq);
          heavyBlack += PIECE_VALUE[piece];
          break;
        case Piece.BlackCannon:
          cannonBlack++;
          heavyBlack += PIECE_VALUE[piece];
          break;
        case Piece.BlackAdvisor: advisorBlack++; break;
        case Piece.BlackBishop: bishopBlack++; break;
        default: break;
      }
    }
  }
  pieceFeatCount[i] = featN;

  const egNum = FULL_PHASE - heavyRed - heavyBlack;
  const dyn = i * N_DYN;
  dynFeat[dyn + D_ROOK_MOB] = rookMobRed - rookMobBlack;
  dynFeat[dyn + D_KNIGHT_MOB] = knightMobRed - knightMobBlack;
  if (egNum > 0) {
    dynFeat[dyn + D_EG_KNIGHT] = ((knightRed - knightBlack) * egNum) / FULL_PHASE;
    dynFeat[dyn + D_EG_CANNON] = ((cannonRed - cannonBlack) * egNum) / FULL_PHASE;
    dynFeat[dyn + D_EG_KING] =
      (egNum / FULL_PHASE) * (9 - ((kingRed / 9) | 0) - ((kingBlack / 9) | 0));
  }

  dynFeat[dyn + D_FACING] =
    (facingCannon(cells, kingBlack, Piece.RedCannon) ? 1 : 0) -
    (facingCannon(cells, kingRed, Piece.BlackCannon) ? 1 : 0);

  const redThreat = Math.min(heavyBlack, THREAT_FULL) / THREAT_FULL;
  const blackThreat = Math.min(heavyRed, THREAT_FULL) / THREAT_FULL;
  dynFeat[dyn + D_MISS_ADV] = (2 - advisorBlack) * blackThreat - (2 - advisorRed) * redThreat;
  dynFeat[dyn + D_MISS_BISH] = (2 - bishopBlack) * blackThreat - (2 - bishopRed) * redThreat;
}

// ---- 初始参数 ----
const weights = new Float64Array(N_PARAMS);
for (let t = 1; t <= 7; t++) {
  for (let sq = 0; sq < 90; sq++) {
    weights[t * 90 + sq] = PIECE_SCORE[t * 90 + sq] - PIECE_VALUE[t];
  }
}
for (let d = 0; d < N_DYN; d++) {
  weights[N_PST + d] = DYN_INIT[d];
}

// ---- 训练 / 验证划分（每 10 条取 1 条做验证） ----
const isVal = new Uint8Array(count);
let valCount = 0;
for (let i = 0; i < count; i++) {
  isVal[i] = i % 10 === 0 ? 1 : 0;
  if (isVal[i]) valCount++;
}
const trainCount = count - valCount;

/** 前向：红方视角线性分。 */
function evaluateZ(i, w) {
  const base = i * 32;
  const n = pieceFeatCount[i];
  let z = 0;
  for (let k = 0; k < n; k++) {
    z += pieceSign[base + k] * w[pieceFeat[base + k]];
  }

  const dyn = i * N_DYN;
  for (let d = 0; d < N_DYN; d++) {
    z += w[N_PST + d] * dynFeat[dyn + d];
  }

  return z;
}

/** sigmoid。 */
function sigmoid(x) {
  return 1 / (1 + Math.exp(-x));
}

/** 验证集均方误差。 */
function valLoss(w) {
  let sum = 0;
  for (let i = 0; i < count; i++) {
    if (!isVal[i]) {
      continue;
    }

    const p = sigmoid(args.k * evaluateZ(i, w));
    sum += (p - results[i]) ** 2;
  }
  return sum / Math.max(1, valCount);
}

console.log(`初始验证损失：${valLoss(weights).toFixed(6)}`);

// ---- Adam 批量梯度下降 ----
const m = new Float64Array(N_PARAMS);
const v = new Float64Array(N_PARAMS);
const grad = new Float64Array(N_PARAMS);
const best = weights.slice();
let bestLoss = valLoss(weights);
const beta1 = 0.9;
const beta2 = 0.999;
const eps = 1e-8;
const k = args.k;

for (let epoch = 1; epoch <= args.epochs; epoch++) {
  grad.fill(0);
  for (let i = 0; i < count; i++) {
    if (isVal[i]) {
      continue;
    }

    const p = sigmoid(k * evaluateZ(i, weights));
    const g = (2 * (p - results[i]) * p * (1 - p) * k) / trainCount;
    const base = i * 32;
    const n = pieceFeatCount[i];
    for (let f = 0; f < n; f++) {
      grad[pieceFeat[base + f]] += pieceSign[base + f] * g;
    }

    const dyn = i * N_DYN;
    for (let d = 0; d < N_DYN; d++) {
      grad[N_PST + d] += dynFeat[dyn + d] * g;
    }
  }

  const b1t = 1 - Math.pow(beta1, epoch);
  const b2t = 1 - Math.pow(beta2, epoch);
  for (let j = 0; j < N_PARAMS; j++) {
    const g = grad[j];
    m[j] = beta1 * m[j] + (1 - beta1) * g;
    v[j] = beta2 * v[j] + (1 - beta2) * g * g;
    weights[j] -= (args.lr * (m[j] / b1t)) / (Math.sqrt(v[j] / b2t) + eps);
  }

  if (epoch % 100 === 0) {
    const loss = valLoss(weights);
    if (loss < bestLoss) {
      bestLoss = loss;
      best.set(weights);
    }
    console.log(`epoch ${epoch}: 验证损失 ${loss.toFixed(6)}（最佳 ${bestLoss.toFixed(6)}）`);
  }
}

if (valLoss(weights) < bestLoss) {
  bestLoss = valLoss(weights);
  best.set(weights);
}
console.log(`最终验证损失：${bestLoss.toFixed(6)}`);

// ---- 输出（取整；四舍五入会引入微小偏差，打印取整后损失供参考） ----
function roundedWeights() {
  const w = new Float64Array(N_PARAMS);
  for (let j = 0; j < N_PARAMS; j++) {
    w[j] = Math.round(best[j]);
  }
  return w;
}

const roundedLoss = valLoss(roundedWeights());
console.log(`取整后验证损失：${roundedLoss.toFixed(6)}`);

function roundPst(t) {
  const arr = new Array(90);
  for (let sq = 0; sq < 90; sq++) {
    arr[sq] = Math.round(best[t * 90 + sq]);
  }
  return arr;
}

const dynNames = [
  'rookMobility',
  'knightMobility',
  'endgameKnight',
  'endgameCannon',
  'endgameKingStep',
  'facingCannon',
  'missingAdvisor',
  'missingBishop',
];
const dynOut = {};
for (let d = 0; d < N_DYN; d++) {
  dynOut[dynNames[d]] = Math.round(best[N_PST + d]);
}

const out = {
  pst: {
    king: roundPst(1),
    advisor: roundPst(2),
    bishop: roundPst(3),
    knight: roundPst(4),
    rook: roundPst(5),
    cannon: roundPst(6),
    pawn: roundPst(7),
  },
  knowledge: dynOut,
  meta: {
    positions: count,
    epochs: args.epochs,
    k: args.k,
    valLoss: bestLoss,
    valLossRounded: roundedLoss,
  },
};
writeFileSync(args.out, JSON.stringify(out, null, 2));
console.log(`已输出调参结果：${args.out}`);

// 打印知识项与等效子力值漂移摘要。
console.log('--- 知识项变化（初值 → 调参值） ---');
for (let d = 0; d < N_DYN; d++) {
  console.log(`${dynNames[d]}: ${DYN_INIT[d]} → ${Math.round(best[N_PST + d])}`);
}

console.log('--- 等效子力值漂移（PST 全行均值偏移） ---');
for (let t = 1; t <= 7; t++) {
  let initSum = 0;
  let tunedSum = 0;
  for (let sq = 0; sq < 90; sq++) {
    initSum += weights[t * 90 + sq] - best[t * 90 + sq];
  }
  void initSum;
  void tunedSum;
  let drift = 0;
  for (let sq = 0; sq < 90; sq++) {
    drift += best[t * 90 + sq] - (PIECE_SCORE[t * 90 + sq] - PIECE_VALUE[t]);
  }
  console.log(`type ${t}: 平均漂移 ${(drift / 90).toFixed(1)}`);
}
