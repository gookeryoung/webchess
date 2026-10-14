/**
 * 搜索热路径 AssemblyScript 内核：FastPosition + 静态评估的 WASM 实现。
 *
 * 与 packages/engine/src/fastBoard.ts / evaluate.ts 保持语义 1:1：
 * - make/unmake 原地走子（增量维护 Zobrist 键、baseScore、将位、重子/兵种计数）；
 * - genMoves 伪合法着法生成（写入实例私有缓冲，供 TS 侧经内存视图零拷贝读取）；
 * - inCheck/attacked/see/isRepetition/evaluate（叶子静态评估）。
 *
 * 共享表（Zobrist / PIECE_SCORE / PIECE_VALUE / 知识项常量）由 TS 侧在实例化后
 * 经 initTables 注入，保证 WASM 与纯 TS 回退路径使用同一份调参结果。
 *
 * 多实例： INSTANCE_COUNT 个独立状态块（基址 = instanceBase(i)），供多个
 * Searcher 并存；实例内含 undo 栈与走法缓冲，内存总量编译期固定，不增长。
 */

const INSTANCE_COUNT: i32 = 4;
const MAX_PLY: i32 = 128;
const MOVES_PER_PLY: i32 = 256;

// ---- 实例内存布局（字节偏移） ----
// clang-format off
const I_CELLS: usize = 0; // 90 字节棋盘
const I_RED: usize = 96;
const I_KEYLO: usize = 100;
const I_KEYHI: usize = 104;
const I_BASE: usize = 108;
const I_KINGR: usize = 112;
const I_KINGB: usize = 116;
const I_HEAVYR: usize = 120;
const I_HEAVYB: usize = 124;
const I_ADVR: usize = 128;
const I_ADVB: usize = 132;
const I_BISR: usize = 136;
const I_BISB: usize = 140;
const I_KNR: usize = 144;
const I_KNB: usize = 148;
const I_CNR: usize = 152;
const I_CNB: usize = 156;
const I_PLY: usize = 160;
const I_UNDOMOVE: usize = 192; // MAX_PLY i32
const I_UNDOCAP: usize = 704; // MAX_PLY i32
const I_KLOSTACK: usize = 1216; // (MAX_PLY+1) i32
const I_KHISTACK: usize = 1736; // (MAX_PLY+1) i32
const I_NULLSTACK: usize = 2256; // (MAX_PLY+1) i32
const I_PIECESQ: usize = 2776; // 32 i32
const I_PCNT: usize = 2904; // 1 i32
const I_SLOTOF: usize = 2912; // 90 i32
const I_SEEOCC: usize = 3272; // 90 i32
const I_SEEATK: usize = 3632; // 16 i32
const I_SEEGAIN: usize = 3696; // 32 i32
const I_SEETOUCH: usize = 3824; // 40 i32
const I_MOVEBUF: usize = 4096; // MAX_PLY * MOVES_PER_PLY i32
// clang-format on

// ---- NNUE（WCNW 权重区 + 每实例双视角累加器）----
/** WCNW 权重文件字节数（与 nnue.ts / trainer 导出一致）。 */
const NNUE_BYTES: usize = 84088;
/** 双视角累加器宽度（i32 个数）：红视角 0..31，黑视角 32..63。 */
const NNUE_ACC: usize = 64;
/** 每层 undo 快照宽度（i32 个数），与累加器等宽。 */
const NNUE_UNDO: usize = 64;
/** 输出层缩放分母（127 × 64），与 nnue.ts SCALE_OUT 一致。 */
const NNUE_SCALE_OUT: i32 = 8128;

/** 每实例额外区：NNUE 累加器 + MAX_PLY 层 undo 快照 + 使用开关。 */
const I_NNUE_ACC_POS: usize = I_MOVEBUF + (<usize>(MAX_PLY * MOVES_PER_PLY)) * 4;
const I_NNUE_UNDO_POS: usize = I_NNUE_ACC_POS + NNUE_ACC * 4;
const I_NNUE_USE: usize = I_NNUE_UNDO_POS + (<usize>MAX_PLY) * NNUE_UNDO * 4;
const INSTANCE_SIZE: usize = I_NNUE_USE + 16;

// ---- 共享表布局（TABLES 基址起，i32 计） ----
const T_ZOB_LO: usize = 0; // 1350 i32
const T_ZOB_HI: usize = 5400; // 1350 i32
const T_SCORE: usize = 10800; // 1350 i32（PIECE_SCORE 15*90）
const T_VALUE: usize = 16200; // 15 i32（PIECE_VALUE）
const T_AREA: usize = 16260; // 90 i32
const T_OFF: usize = 16620; // 方向偏移表：KING8/ADV8/BISHOP8/EYE8/KNIGHT16/LEG16/REV16 = 80 i32（320 字节）
const T_KNOWLEDGE: usize = 16940; // 10 i32：机动性/知识项常量 + FULL_PHASE + THREAT_FULL（紧随 T_OFF 之后，避免重叠）
const TABLES_SIZE: usize = 16992; // T_KNOWLEDGE + 40 字节，向上 16 字节对齐
/** NNUE 权重区：紧随共享表，TS 侧把 WCNW 原始字节直接写入此处。 */
const T_NNUE: usize = TABLES_SIZE;
const TABLES_SIZE_FULL: usize = TABLES_SIZE + NNUE_BYTES;

/** initTables 输入暂存区（TS 侧经视图写入后传入其内部偏移）。 */
export const STAGING: usize = memory.data(16304);

/** NNUE 前向散射缓冲（a1[64] / a2[32] / a3[32]；评估不重入，模块级即可）。 */
const NNUE_SCRATCH: usize = memory.data(64 * 4 + 32 * 4 + 32 * 4 + 16);

/** 静态数据区：共享表 + NNUE 权重 + 实例块（编译期定容，运行期不增长）。 */
const BLOCK: usize = memory.data(
  <i32>(TABLES_SIZE_FULL + (<usize>INSTANCE_COUNT) * INSTANCE_SIZE),
);
const TABLES: usize = BLOCK;
const INSTANCES: usize = BLOCK + TABLES_SIZE_FULL;

/** NNUE 是否已注入权重（TS 侧上传后调用 enableNnue）。 */
let nnueOn: i32 = 0;

/** NNUE 权重区地址（TS 侧写入 NNUE_BYTES 字节）。 */
export function nnueWeightsPtr(): usize {
  return TABLES + T_NNUE;
}

/** 标记 NNUE 权重已就绪（各实例在下次 setFromBoard 时重建累加器）。 */
export function enableNnue(): void {
  nnueOn = 1;
}

export function instanceBase(index: i32): usize {
  return INSTANCES + (<usize>index) * INSTANCE_SIZE;
}

/** T_OFF 表内子偏移（i32 个数）。 */
const O_KING: usize = 0; // 8（dx/dy 交错）
const O_ADV: usize = 8;
const O_BISHOP: usize = 16;
const O_EYE: usize = 24;
const O_KNIGHT: usize = 32; // 16
const O_LEG: usize = 48; // 16
const O_REV: usize = 64; // 16

/** 棋子编码（与 core Piece 一致）。 */
const EMPTY: i32 = 0;
const RED_KING: i32 = 1;
const RED_KNIGHT: i32 = 4;
const RED_ROOK: i32 = 5;
const RED_CANNON: i32 = 6;
const RED_PAWN: i32 = 7;
const BLACK_KING: i32 = 8;
const BLACK_KNIGHT: i32 = 11;
const BLACK_ROOK: i32 = 12;
const BLACK_CANNON: i32 = 13;
const BLACK_PAWN: i32 = 14;

const ZOB_SIDE_LO: i32 = 0x1a2b3c4d;
const ZOB_SIDE_HI: i32 = 0x4d3c2b1a;

/**
 * 注入共享表（TS 侧内存布局，全部 i32）：
 * zobLo/zobHi 各 2700、pieceScore 1350、pieceValue 15、knowledge 10
 * （rookMob/knightMob/egKnight/egCannon/egKingStep/facing/missAdv/missBish/
 *   FULL_PHASE/THREAT_FULL）。同时构建 AREA 与方向偏移表。
 */
export function initTables(
  zobLoPtr: usize,
  zobHiPtr: usize,
  pieceScorePtr: usize,
  pieceValuePtr: usize,
  knowledgePtr: usize,
): void {
  for (let i: i32 = 0; i < 1350; i++) {
    store<i32>(TABLES + T_ZOB_LO + (<usize>i) * 4, load<i32>(zobLoPtr + (<usize>i) * 4));
    store<i32>(TABLES + T_ZOB_HI + (<usize>i) * 4, load<i32>(zobHiPtr + (<usize>i) * 4));
  }
  for (let i: i32 = 0; i < 1350; i++) {
    store<i32>(TABLES + T_SCORE + (<usize>i) * 4, load<i32>(pieceScorePtr + (<usize>i) * 4));
  }
  for (let i: i32 = 0; i < 15; i++) {
    store<i32>(TABLES + T_VALUE + (<usize>i) * 4, load<i32>(pieceValuePtr + (<usize>i) * 4));
  }
  for (let i: i32 = 0; i < 10; i++) {
    store<i32>(TABLES + T_KNOWLEDGE + (<usize>i) * 4, load<i32>(knowledgePtr + (<usize>i) * 4));
  }

  // 区域编号：1 黑半场、2 黑九宫、3 红半场、4 红九宫（无托管数组，stub 运行时安全）。
  for (let y: i32 = 0; y < 10; y++) {
    for (let x: i32 = 0; x < 9; x++) {
      let v: i32;
      if (y <= 4) {
        v = y <= 2 && x >= 3 && x <= 5 ? 2 : 1;
      } else {
        v = y >= 7 && x >= 3 && x <= 5 ? 4 : 3;
      }

      store<i32>(TABLES + T_AREA + (<usize>(y * 9 + x)) * 4, v);
    }
  }

  // 方向偏移（dx/dy 交错），逐个写入避免托管数组。
  const off = TABLES + T_OFF;
  // 帅/将四方向：上下左右。
  store<i32>(off + O_KING * 4 + 0, 0);
  store<i32>(off + O_KING * 4 + 4, 1);
  store<i32>(off + O_KING * 4 + 8, 0);
  store<i32>(off + O_KING * 4 + 12, -1);
  store<i32>(off + O_KING * 4 + 16, 1);
  store<i32>(off + O_KING * 4 + 20, 0);
  store<i32>(off + O_KING * 4 + 24, -1);
  store<i32>(off + O_KING * 4 + 28, 0);
  // 斜向族：仕(4)、相(4)、象眼(4)取前 4 项，反向马腿(8)取全部。
  // fastBoard.ts：ADV_X=[1,1,-1,-1] ADV_Y=[1,-1,1,-1]；REV 为同模式 8 项重复。
  for (let i: i32 = 0; i < 8; i++) {
    const dx: i32 = ((i >> 1) & 1) == 0 ? 1 : -1;
    const dy: i32 = (i & 1) == 0 ? 1 : -1;
    if (i < 4) {
      store<i32>(off + O_ADV * 4 + (<usize>i) * 8, dx);
      store<i32>(off + O_ADV * 4 + (<usize>i) * 8 + 4, dy);
      store<i32>(off + O_BISHOP * 4 + (<usize>i) * 8, dx * 2);
      store<i32>(off + O_BISHOP * 4 + (<usize>i) * 8 + 4, dy * 2);
      store<i32>(off + O_EYE * 4 + (<usize>i) * 8, dx);
      store<i32>(off + O_EYE * 4 + (<usize>i) * 8 + 4, dy);
    }

    store<i32>(off + O_REV * 4 + (<usize>i) * 8, dx);
    store<i32>(off + O_REV * 4 + (<usize>i) * 8 + 4, dy);
  }

  // 马日字与马腿（8 项，dx/dy 交错）：KNIGHT_X=[1,1,-1,-1,2,2,-2,-2]
  // KNIGHT_Y=[2,-2,2,-2,1,-1,1,-1] LEG_X=[0,0,0,0,1,1,-1,-1] LEG_Y=[1,-1,1,-1,0,0,0,0]。
  for (let i: i32 = 0; i < 8; i++) {
    const kdx: i32 = i < 2 ? 1 : i < 4 ? -1 : i < 6 ? 2 : -2;
    // 与 fastBoard.ts 的 KNIGHT_Y=[2,-2,2,-2,1,-1,1,-1] 一致；注意 i<4 段
    // 必须按奇偶交替（此前写成 i<2 恒为 2，导致 y=0 红马马腿下标为负越界）。
    const kdy: i32 = i < 4 ? ((i & 1) == 0 ? 2 : -2) : (i & 1) == 0 ? 1 : -1;
    // 注意 == 优先级高于 &（JS 语义），必须显式括号：((i >> 1) & 1) == 0。
    const klx: i32 = i < 4 ? 0 : (((i >> 1) & 1) == 0 ? 1 : -1);
    const kly: i32 = i < 4 ? ((i & 1) == 0 ? 1 : -1) : 0;
    store<i32>(off + O_KNIGHT * 4 + (<usize>i) * 8, kdx);
    store<i32>(off + O_KNIGHT * 4 + (<usize>i) * 8 + 4, kdy);
    store<i32>(off + O_LEG * 4 + (<usize>i) * 8, klx);
    store<i32>(off + O_LEG * 4 + (<usize>i) * 8 + 4, kly);
  }
}

// ---- 实例状态访问辅助 ----
// clang-format off
function cells(base: usize): usize { return base + I_CELLS; }
function getI(base: usize, off: usize): i32 { return load<i32>(base + off); }
function setI(base: usize, off: usize, v: i32): void { store<i32>(base + off, v); }
function zobLo(idx: i32): i32 { return load<i32>(TABLES + T_ZOB_LO + (<usize>idx) * 4); }
function zobHi(idx: i32): i32 { return load<i32>(TABLES + T_ZOB_HI + (<usize>idx) * 4); }
function pieceScore(idx: i32): i32 { return load<i32>(TABLES + T_SCORE + (<usize>idx) * 4); }
function pieceValue(piece: i32): i32 { return load<i32>(TABLES + T_VALUE + (<usize>piece) * 4); }
function area(sq: i32): i32 { return load<i32>(TABLES + T_AREA + (<usize>sq) * 4); }
// clang-format on

// ---- NNUE：权重层偏移与访问器（WCNW 头 20 字节，层序与 nnue.ts 一致）----
const N_W1: usize = 20; // int16[1260*32]
const N_B1: usize = N_W1 + 1260 * 32 * 2; // int16[32]
const N_W2: usize = N_B1 + 32 * 2; // int8[64*32]
const N_B2: usize = N_W2 + 64 * 32; // int32[32]
const N_W2B: usize = N_B2 + 32 * 4; // int8[32*32]
const N_B2B: usize = N_W2B + 32 * 32; // int32[32]
const N_W3: usize = N_B2B + 32 * 4; // int8[32]
const N_B3: usize = N_W3 + 32; // int32[1]

/** 视角棋子类别：黑子（8-14）→ 0-6，红子（1-7）→ 7-13（与 nnue.ts 一致）。 */
function blackViewClass(piece: i32): i32 {
  return piece >= BLACK_KING ? piece - 8 : piece + 6;
}

/** 黑视角格下标行镜像：(9 - y) * 9 + x。 */
function mirrorSq(sq: i32): i32 {
  return (9 - sq / 9) * 9 + sq % 9;
}

function nnW1(feature: i32, j: i32): i32 {
  return load<i16>(TABLES + T_NNUE + N_W1 + (<usize>(feature * 32 + j)) * 2);
}

function nnB1(j: i32): i32 {
  return load<i16>(TABLES + T_NNUE + N_B1 + (<usize>j) * 2);
}

function nnW2(j: i32, i: i32): i32 {
  return load<i8>(TABLES + T_NNUE + N_W2 + (<usize>(j * 64 + i)));
}

function nnB2(j: i32): i32 {
  return load<i32>(TABLES + T_NNUE + N_B2 + (<usize>j) * 4);
}

function nnW2B(j: i32, i: i32): i32 {
  return load<i8>(TABLES + T_NNUE + N_W2B + (<usize>(j * 32 + i)));
}

function nnB2B(j: i32): i32 {
  return load<i32>(TABLES + T_NNUE + N_B2B + (<usize>j) * 4);
}

function nnW3(i: i32): i32 {
  return load<i8>(TABLES + T_NNUE + N_W3 + (<usize>i));
}

function nnB3(): i32 {
  return load<i32>(TABLES + T_NNUE + N_B3);
}

function nnAcc(base: usize, i: i32): i32 {
  return load<i32>(base + I_NNUE_ACC_POS + (<usize>i) * 4);
}

function nnAccSet(base: usize, i: i32, v: i32): void {
  store<i32>(base + I_NNUE_ACC_POS + (<usize>i) * 4, v);
}

function nnAccAdd(base: usize, i: i32, delta: i32): void {
  const p = base + I_NNUE_ACC_POS + (<usize>i) * 4;
  store<i32>(p, load<i32>(p) + delta);
}

/** 向下取整除法（AS 的 `/` 为截断除法，负被除数需修正 —— 与 TS Math.floor 一致）。 */
function floorDiv(a: i32, b: i32): i32 {
  const q = a / b;
  return a % b != 0 && a < 0 ? q - 1 : q;
}

/** 从当前棋盘全量重建双视角累加器（NNUE 实例的 setFromBoard 时调用）。 */
function nnueRefresh(base: usize): void {
  if (nnueOn == 0 || getI(base, I_NNUE_USE) != 1) {
    return;
  }

  for (let j: i32 = 0; j < 32; j++) {
    const b = nnB1(j);
    nnAccSet(base, j, b);
    nnAccSet(base, 32 + j, b);
  }

  const cs = cells(base);
  for (let sq: i32 = 0; sq < 90; sq++) {
    const piece: i32 = load<u8>(cs + (<usize>sq));
    if (piece == EMPTY) {
      continue;
    }

    const redIdx = (piece - 1) * 90 + sq;
    const blkIdx = blackViewClass(piece) * 90 + mirrorSq(sq);
    for (let j: i32 = 0; j < 32; j++) {
      nnAccAdd(base, j, nnW1(redIdx, j));
      nnAccAdd(base, 32 + j, nnW1(blkIdx, j));
    }
  }
}

/** make 前压栈并增量更新累加器（移动子 + 被吃子；ply 为 make 前层数）。 */
function nnuePush(base: usize, piece: i32, from: i32, to: i32, captured: i32, ply: i32): void {
  if (nnueOn == 0 || getI(base, I_NNUE_USE) != 1) {
    return;
  }

  const undo = base + I_NNUE_UNDO_POS + (<usize>ply) * (NNUE_UNDO * 4);
  for (let i: i32 = 0; i < 64; i++) {
    store<i32>(undo + (<usize>i) * 4, nnAcc(base, i));
  }

  const redMoved = (piece - 1) * 90;
  const blkMoved = blackViewClass(piece) * 90;
  const redFrom = redMoved + from;
  const redTo = redMoved + to;
  const blkFrom = blkMoved + mirrorSq(from);
  const blkTo = blkMoved + mirrorSq(to);
  for (let j: i32 = 0; j < 32; j++) {
    nnAccAdd(base, j, nnW1(redTo, j) - nnW1(redFrom, j));
    nnAccAdd(base, 32 + j, nnW1(blkTo, j) - nnW1(blkFrom, j));
  }

  if (captured != EMPTY) {
    const redCap = (captured - 1) * 90 + to;
    const blkCap = blackViewClass(captured) * 90 + mirrorSq(to);
    for (let j: i32 = 0; j < 32; j++) {
      nnAccAdd(base, j, -nnW1(redCap, j));
      nnAccAdd(base, 32 + j, -nnW1(blkCap, j));
    }
  }
}

/** unmake 时按栈恢复累加器（ply 已递减，与 make 时的快照层号一致）。 */
function nnuePop(base: usize, ply: i32): void {
  if (nnueOn == 0 || getI(base, I_NNUE_USE) != 1) {
    return;
  }

  const undo = base + I_NNUE_UNDO_POS + (<usize>ply) * (NNUE_UNDO * 4);
  for (let i: i32 = 0; i < 64; i++) {
    nnAccSet(base, i, load<i32>(undo + (<usize>i) * 4));
  }
}

/**
 * NNUE 前向（走子方视角 cp）：双视角拼接 → cReLU → 32 → 32 → 1，
 * 逐位对齐 nnue.ts（全部整数运算；溢出已按权重上界核算，最坏 2.1e8 < 2^31）。
 */
export function evaluateNnue(base: usize): i32 {
  if (nnueOn == 0) {
    return 0;
  }

  const a1 = NNUE_SCRATCH;
  const a2 = NNUE_SCRATCH + 64 * 4;
  const a3 = NNUE_SCRATCH + 96 * 4;
  const red: i32 = getI(base, I_RED);
  const myBase: i32 = red == 1 ? 0 : 32;
  const oppBase: i32 = red == 1 ? 32 : 0;
  for (let i: i32 = 0; i < 32; i++) {
    let v = (nnAcc(base, myBase + i) * 127 + 128) >> 8;
    if (v < 0) {
      v = 0;
    } else if (v > 127) {
      v = 127;
    }

    store<i32>(a1 + (<usize>i) * 4, v);
    v = (nnAcc(base, oppBase + i) * 127 + 128) >> 8;
    if (v < 0) {
      v = 0;
    } else if (v > 127) {
      v = 127;
    }

    store<i32>(a1 + (<usize>(32 + i)) * 4, v);
  }

  for (let j: i32 = 0; j < 32; j++) {
    let h = nnB2(j);
    for (let i: i32 = 0; i < 64; i++) {
      h += nnW2(j, i) * load<i32>(a1 + (<usize>i) * 4);
    }

    let v = floorDiv(h * 127 + 4064, NNUE_SCALE_OUT);
    if (v < 0) {
      v = 0;
    } else if (v > 127) {
      v = 127;
    }

    store<i32>(a2 + (<usize>j) * 4, v);
  }

  for (let j: i32 = 0; j < 32; j++) {
    let h = nnB2B(j);
    for (let i: i32 = 0; i < 32; i++) {
      h += nnW2B(j, i) * load<i32>(a2 + (<usize>i) * 4);
    }

    let v = floorDiv(h * 127 + 4064, NNUE_SCALE_OUT);
    if (v < 0) {
      v = 0;
    } else if (v > 127) {
      v = 127;
    }

    store<i32>(a3 + (<usize>j) * 4, v);
  }

  let out = nnB3();
  for (let i: i32 = 0; i < 32; i++) {
    out += nnW3(i) * load<i32>(a3 + (<usize>i) * 4);
  }

  return floorDiv(out * 400, NNUE_SCALE_OUT);
}

function dirOff(off: usize, i: i32): i32 {
  return load<i32>(TABLES + T_OFF + (off + (<usize>i)) * 4);
}

/** 从 TS 侧已写入的棋盘矩阵重建全部增量状态（O(90)）。 */
export function setFromBoard(base: usize, redToMove: i32, useNnue: i32): void {
  setI(base, I_NNUE_USE, useNnue);
  const cs = cells(base);
  let keyLo: i32 = 0;
  let keyHi: i32 = 0;
  let baseScore: i32 = 0;
  let kingRed: i32 = -1;
  let kingBlack: i32 = -1;
  let heavyRed: i32 = 0;
  let heavyBlack: i32 = 0;
  let advisorRed: i32 = 0;
  let advisorBlack: i32 = 0;
  let bishopRed: i32 = 0;
  let bishopBlack: i32 = 0;
  let knightRed: i32 = 0;
  let knightBlack: i32 = 0;
  let cannonRed: i32 = 0;
  let cannonBlack: i32 = 0;
  let pieceCount: i32 = 0;

  for (let i: i32 = 0; i < 90; i++) {
    store<i32>(base + I_SLOTOF + (<usize>i) * 4, -1);
  }

  for (let sq: i32 = 0; sq < 90; sq++) {
    const piece: i32 = load<u8>(cs + (<usize>sq));
    if (piece == EMPTY) {
      continue;
    }

    const idx = piece * 90 + sq;
    keyLo ^= zobLo(idx);
    keyHi ^= zobHi(idx);
    baseScore += pieceScore(idx);
    if (piece == RED_KING) {
      kingRed = sq;
    } else if (piece == BLACK_KING) {
      kingBlack = sq;
    } else if (piece == RED_KNIGHT) {
      knightRed++;
      heavyRed += pieceValue(piece);
    } else if (piece == BLACK_KNIGHT) {
      knightBlack++;
      heavyBlack += pieceValue(piece);
    } else if (piece == RED_ROOK) {
      heavyRed += pieceValue(piece);
    } else if (piece == BLACK_ROOK) {
      heavyBlack += pieceValue(piece);
    } else if (piece == RED_CANNON) {
      cannonRed++;
      heavyRed += pieceValue(piece);
    } else if (piece == BLACK_CANNON) {
      cannonBlack++;
      heavyBlack += pieceValue(piece);
    } else if (piece == 2) {
      advisorRed++;
    } else if (piece == 9) {
      advisorBlack++;
    } else if (piece == 3) {
      bishopRed++;
    } else if (piece == 10) {
      bishopBlack++;
    }

    const slot = pieceCount++;
    store<i32>(base + I_PIECESQ + (<usize>slot) * 4, sq);
    store<i32>(base + I_SLOTOF + (<usize>sq) * 4, slot);
  }

  if (redToMove == 0) {
    keyLo ^= ZOB_SIDE_LO;
    keyHi ^= ZOB_SIDE_HI;
  }

  setI(base, I_RED, redToMove);
  setI(base, I_KEYLO, keyLo);
  setI(base, I_KEYHI, keyHi);
  setI(base, I_BASE, baseScore);
  setI(base, I_KINGR, kingRed);
  setI(base, I_KINGB, kingBlack);
  setI(base, I_HEAVYR, heavyRed);
  setI(base, I_HEAVYB, heavyBlack);
  setI(base, I_ADVR, advisorRed);
  setI(base, I_ADVB, advisorBlack);
  setI(base, I_BISR, bishopRed);
  setI(base, I_BISB, bishopBlack);
  setI(base, I_KNR, knightRed);
  setI(base, I_KNB, knightBlack);
  setI(base, I_CNR, cannonRed);
  setI(base, I_CNB, cannonBlack);
  setI(base, I_PLY, 0);
  setI(base, I_PCNT, pieceCount);
  setI(base, I_KLOSTACK, keyLo);
  setI(base, I_KHISTACK, keyHi);
  setI(base, I_NULLSTACK, 0);
  // NNUE 按实例开关：手工评估实例不维护累加器（避免每条 make/unmake 白付 64 项成本）。
  if (useNnue == 1) {
    nnueRefresh(base);
  }
}

/** 原地走子（伪合法即可），增量更新全部状态；走后用 inCheck 判定合法性。 */
export function make(base: usize, move: i32): void {
  const from = move & 127;
  const to = (move >>> 7) & 127;
  const cs = cells(base);
  const piece: i32 = load<u8>(cs + (<usize>from));
  const captured: i32 = load<u8>(cs + (<usize>to));
  const p = piece * 90;
  const ply: i32 = getI(base, I_PLY);

  // NNUE：压栈 + 更新双视角累加器（必须在棋盘变更前记录增量，ply 用 make 前层号）。
  nnuePush(base, piece, from, to, captured, ply);

  store<i32>(base + I_UNDOMOVE + (<usize>ply) * 4, move);
  store<i32>(base + I_UNDOCAP + (<usize>ply) * 4, captured);

  let keyLo: i32 = getI(base, I_KEYLO) ^ zobLo(p + from) ^ zobLo(p + to);
  let keyHi: i32 = getI(base, I_KEYHI) ^ zobHi(p + from) ^ zobHi(p + to);
  setI(base, I_BASE, getI(base, I_BASE) + pieceScore(p + to) - pieceScore(p + from));

  let pieceCount: i32 = getI(base, I_PCNT);
  if (captured != EMPTY) {
    const c = captured * 90;
    keyLo ^= zobLo(c + to);
    keyHi ^= zobHi(c + to);
    setI(base, I_BASE, getI(base, I_BASE) - pieceScore(c + to));
    if (captured >= RED_KNIGHT && captured <= RED_CANNON) {
      setI(base, I_HEAVYR, getI(base, I_HEAVYR) - pieceValue(captured));
      if (captured == RED_KNIGHT) {
        setI(base, I_KNR, getI(base, I_KNR) - 1);
      } else if (captured == RED_CANNON) {
        setI(base, I_CNR, getI(base, I_CNR) - 1);
      }
    } else if (captured >= BLACK_KNIGHT && captured <= BLACK_CANNON) {
      setI(base, I_HEAVYB, getI(base, I_HEAVYB) - pieceValue(captured));
      if (captured == BLACK_KNIGHT) {
        setI(base, I_KNB, getI(base, I_KNB) - 1);
      } else if (captured == BLACK_CANNON) {
        setI(base, I_CNB, getI(base, I_CNB) - 1);
      }
    } else if (captured == 2) {
      setI(base, I_ADVR, getI(base, I_ADVR) - 1);
    } else if (captured == 9) {
      setI(base, I_ADVB, getI(base, I_ADVB) - 1);
    } else if (captured == 3) {
      setI(base, I_BISR, getI(base, I_BISR) - 1);
    } else if (captured == 10) {
      setI(base, I_BISB, getI(base, I_BISB) - 1);
    }

    // 尾交换删除被吃子。
    const capSlot: i32 = getI(base, I_SLOTOF + (<usize>to) * 4);
    pieceCount--;
    const movedSq: i32 = load<i32>(base + I_PIECESQ + (<usize>pieceCount) * 4);
    store<i32>(base + I_PIECESQ + (<usize>capSlot) * 4, movedSq);
    store<i32>(base + I_SLOTOF + (<usize>movedSq) * 4, capSlot);
  }

  // 走子方槽位改为终点格。
  const fromSlot: i32 = getI(base, I_SLOTOF + (<usize>from) * 4);
  store<i32>(base + I_PIECESQ + (<usize>fromSlot) * 4, to);
  store<i32>(base + I_SLOTOF + (<usize>to) * 4, fromSlot);
  store<i32>(base + I_SLOTOF + (<usize>from) * 4, -1);

  store<u8>(cs + (<usize>from), 0);
  store<u8>(cs + (<usize>to), <u8>piece);
  if (piece == RED_KING) {
    setI(base, I_KINGR, to);
  } else if (piece == BLACK_KING) {
    setI(base, I_KINGB, to);
  }

  setI(base, I_PCNT, pieceCount);
  setI(base, I_RED, 1 - getI(base, I_RED));
  setI(base, I_KEYLO, keyLo ^ ZOB_SIDE_LO);
  setI(base, I_KEYHI, keyHi ^ ZOB_SIDE_HI);
  const newPly = ply + 1;
  setI(base, I_PLY, newPly);
  setI(base, I_KLOSTACK + (<usize>newPly) * 4, getI(base, I_KEYLO));
  setI(base, I_KHISTACK + (<usize>newPly) * 4, getI(base, I_KEYHI));
  setI(base, I_NULLSTACK + (<usize>newPly) * 4, 0);
}

/** 回退一步 make。 */
export function unmake(base: usize): void {
  const ply: i32 = getI(base, I_PLY) - 1;
  setI(base, I_PLY, ply);
  // NNUE：恢复 make 前压栈的累加器快照（ply 已递减到 make 时的层号）。
  nnuePop(base, ply);
  const move: i32 = load<i32>(base + I_UNDOMOVE + (<usize>ply) * 4);
  const captured: i32 = load<i32>(base + I_UNDOCAP + (<usize>ply) * 4);
  const from = move & 127;
  const to = (move >>> 7) & 127;
  const cs = cells(base);
  const piece: i32 = load<u8>(cs + (<usize>to));
  const p = piece * 90;

  // 走子方槽位还原为起点格。
  const toSlot: i32 = getI(base, I_SLOTOF + (<usize>to) * 4);
  store<i32>(base + I_PIECESQ + (<usize>toSlot) * 4, from);
  store<i32>(base + I_SLOTOF + (<usize>from) * 4, toSlot);
  store<i32>(base + I_SLOTOF + (<usize>to) * 4, -1);

  let pieceCount: i32 = getI(base, I_PCNT);
  if (captured != EMPTY) {
    // 被吃子追加回列表尾。
    store<i32>(base + I_PIECESQ + (<usize>pieceCount) * 4, to);
    store<i32>(base + I_SLOTOF + (<usize>to) * 4, pieceCount);
    pieceCount++;
  }

  store<u8>(cs + (<usize>from), <u8>piece);
  store<u8>(cs + (<usize>to), <u8>captured);

  let keyLo: i32 = getI(base, I_KEYLO) ^ zobLo(p + from) ^ zobLo(p + to);
  let keyHi: i32 = getI(base, I_KEYHI) ^ zobHi(p + from) ^ zobHi(p + to);
  setI(base, I_BASE, getI(base, I_BASE) - pieceScore(p + to) + pieceScore(p + from));

  if (captured != EMPTY) {
    const c = captured * 90;
    keyLo ^= zobLo(c + to);
    keyHi ^= zobHi(c + to);
    setI(base, I_BASE, getI(base, I_BASE) + pieceScore(c + to));
    if (captured >= RED_KNIGHT && captured <= RED_CANNON) {
      setI(base, I_HEAVYR, getI(base, I_HEAVYR) + pieceValue(captured));
      if (captured == RED_KNIGHT) {
        setI(base, I_KNR, getI(base, I_KNR) + 1);
      } else if (captured == RED_CANNON) {
        setI(base, I_CNR, getI(base, I_CNR) + 1);
      }
    } else if (captured >= BLACK_KNIGHT && captured <= BLACK_CANNON) {
      setI(base, I_HEAVYB, getI(base, I_HEAVYB) + pieceValue(captured));
      if (captured == BLACK_KNIGHT) {
        setI(base, I_KNB, getI(base, I_KNB) + 1);
      } else if (captured == BLACK_CANNON) {
        setI(base, I_CNB, getI(base, I_CNB) + 1);
      }
    } else if (captured == 2) {
      setI(base, I_ADVR, getI(base, I_ADVR) + 1);
    } else if (captured == 9) {
      setI(base, I_ADVB, getI(base, I_ADVB) + 1);
    } else if (captured == 3) {
      setI(base, I_BISR, getI(base, I_BISR) + 1);
    } else if (captured == 10) {
      setI(base, I_BISB, getI(base, I_BISB) + 1);
    }
  }

  setI(base, I_PCNT, pieceCount);
  if (piece == RED_KING) {
    setI(base, I_KINGR, from);
  } else if (piece == BLACK_KING) {
    setI(base, I_KINGB, from);
  }

  setI(base, I_RED, 1 - getI(base, I_RED));
  setI(base, I_KEYLO, keyLo ^ ZOB_SIDE_LO);
  setI(base, I_KEYHI, keyHi ^ ZOB_SIDE_HI);
}

/** 空步（null move）：仅翻边换键。 */
export function makeNull(base: usize): void {
  setI(base, I_RED, 1 - getI(base, I_RED));
  setI(base, I_KEYLO, getI(base, I_KEYLO) ^ ZOB_SIDE_LO);
  setI(base, I_KEYHI, getI(base, I_KEYHI) ^ ZOB_SIDE_HI);
  const ply: i32 = getI(base, I_PLY) + 1;
  setI(base, I_PLY, ply);
  setI(base, I_KLOSTACK + (<usize>ply) * 4, 0);
  setI(base, I_KHISTACK + (<usize>ply) * 4, 0);
  setI(base, I_NULLSTACK + (<usize>ply) * 4, 1);
}

/** 回退空步。 */
export function unmakeNull(base: usize): void {
  const ply: i32 = getI(base, I_PLY) - 1;
  setI(base, I_PLY, ply);
  setI(base, I_RED, 1 - getI(base, I_RED));
  setI(base, I_KEYLO, getI(base, I_KEYLO) ^ ZOB_SIDE_LO);
  setI(base, I_KEYHI, getI(base, I_KEYHI) ^ ZOB_SIDE_HI);
}

/** 上一步实走着法编码（根节点或上一步为空步时返回 0）。 */
export function lastMove(base: usize): i32 {
  const ply: i32 = getI(base, I_PLY);
  if (ply == 0 || getI(base, I_NULLSTACK + (<usize>ply) * 4) == 1) {
    return 0;
  }

  return load<i32>(base + I_UNDOMOVE + (<usize>(ply - 1)) * 4);
}

/**
 * 生成走子方全部伪合法着法，写入实例缓冲的 [outBase, outBase+n) 区间
 * （TS 侧以同一偏移读取内存视图），返回着法数。
 */
export function genMoves(base: usize, outBase: i32, capturesOnly: i32): i32 {
  const cs = cells(base);
  const red: i32 = getI(base, I_RED);
  const outPtr: usize = base + I_MOVEBUF + (<usize>outBase) * 4;
  let n: usize = 0;

  const pieceCount: i32 = getI(base, I_PCNT);
  for (let idx: i32 = 0; idx < pieceCount; idx++) {
    const sq: i32 = load<i32>(base + I_PIECESQ + (<usize>idx) * 4);
    const piece: i32 = load<u8>(cs + (<usize>sq));
    const redPiece: i32 = piece <= RED_PAWN ? 1 : 0;
    if (redPiece != red) {
      continue;
    }

    const x = sq % 9;
    const y = sq / 9;

    if (piece == RED_KING || piece == BLACK_KING) {
      const palace = redPiece == 1 ? 4 : 2;
      for (let i: i32 = 0; i < 4; i++) {
        const tx = x + dirOff(O_KING, i * 2);
        const ty = y + dirOff(O_KING, i * 2 + 1);
        if (tx < 0 || tx > 8 || ty < 0 || ty > 9) {
          continue;
        }

        const tsq = ty * 9 + tx;
        if (area(tsq) != palace) {
          continue;
        }

        const target: i32 = load<u8>(cs + (<usize>tsq));
        if (target != EMPTY && (target <= RED_PAWN ? 1 : 0) == redPiece) {
          continue;
        }

        if (capturesOnly != 0 && target == EMPTY) {
          continue;
        }

        store<i32>(outPtr + n * 4, sq | (tsq << 7));
        n++;
      }
    } else if (piece == 2 || piece == 9) {
      // 仕/士：四斜向，限九宫。
      const palace = redPiece == 1 ? 4 : 2;
      for (let i: i32 = 0; i < 4; i++) {
        const tx = x + dirOff(O_ADV, i * 2);
        const ty = y + dirOff(O_ADV, i * 2 + 1);
        if (tx < 0 || tx > 8 || ty < 0 || ty > 9) {
          continue;
        }

        const tsq = ty * 9 + tx;
        if (area(tsq) != palace) {
          continue;
        }

        const target: i32 = load<u8>(cs + (<usize>tsq));
        if (target != EMPTY && (target <= RED_PAWN ? 1 : 0) == redPiece) {
          continue;
        }

        if (capturesOnly != 0 && target == EMPTY) {
          continue;
        }

        store<i32>(outPtr + n * 4, sq | (tsq << 7));
        n++;
      }
    } else if (piece == 3 || piece == 10) {
      // 相/象：田字、不过河、塞象眼。
      for (let i: i32 = 0; i < 4; i++) {
        const tx = x + dirOff(O_BISHOP, i * 2);
        const ty = y + dirOff(O_BISHOP, i * 2 + 1);
        if (tx < 0 || tx > 8 || ty < 0 || ty > 9) {
          continue;
        }

        const tsq = ty * 9 + tx;
        const a: i32 = area(tsq);
        if (a == 0 || (redPiece == 1 ? a < 3 : a > 2)) {
          continue;
        }

        const target: i32 = load<u8>(cs + (<usize>tsq));
        if (target != EMPTY && (target <= RED_PAWN ? 1 : 0) == redPiece) {
          continue;
        }

        if (capturesOnly != 0 && target == EMPTY) {
          continue;
        }

        const eyeSq = (y + dirOff(O_EYE, i * 2 + 1)) * 9 + (x + dirOff(O_EYE, i * 2));
        if (load<u8>(cs + (<usize>eyeSq)) != EMPTY) {
          continue;
        }

        store<i32>(outPtr + n * 4, sq | (tsq << 7));
        n++;
      }
    } else if (piece == RED_KNIGHT || piece == BLACK_KNIGHT) {
      // 马：日字 + 蹩马腿。
      for (let i: i32 = 0; i < 8; i++) {
        const tx = x + dirOff(O_KNIGHT, i * 2);
        const ty = y + dirOff(O_KNIGHT, i * 2 + 1);
        if (tx < 0 || tx > 8 || ty < 0 || ty > 9) {
          continue;
        }

        const tsq = ty * 9 + tx;
        const target: i32 = load<u8>(cs + (<usize>tsq));
        if (target != EMPTY && (target <= RED_PAWN ? 1 : 0) == redPiece) {
          continue;
        }

        if (capturesOnly != 0 && target == EMPTY) {
          continue;
        }

        const legSq = (y + dirOff(O_LEG, i * 2 + 1)) * 9 + (x + dirOff(O_LEG, i * 2));
        if (load<u8>(cs + (<usize>legSq)) != EMPTY) {
          continue;
        }

        store<i32>(outPtr + n * 4, sq | (tsq << 7));
        n++;
      }
    } else if (piece == RED_ROOK || piece == BLACK_ROOK) {
      // 车：四方向直线扫描。
      for (let dir: i32 = 0; dir < 4; dir++) {
        const dx = dirOff(O_KING, dir * 2);
        const dy = dirOff(O_KING, dir * 2 + 1);
        let tx = x + dx;
        let ty = y + dy;
        while (tx >= 0 && tx <= 8 && ty >= 0 && ty <= 9) {
          const tsq = ty * 9 + tx;
          const target: i32 = load<u8>(cs + (<usize>tsq));
          if (target == EMPTY) {
            if (capturesOnly == 0) {
              store<i32>(outPtr + n * 4, sq | (tsq << 7));
              n++;
            }
          } else {
            if ((target <= RED_PAWN ? 1 : 0) != redPiece) {
              store<i32>(outPtr + n * 4, sq | (tsq << 7));
              n++;
            }

            break;
          }

          tx += dx;
          ty += dy;
        }
      }
    } else if (piece == RED_CANNON || piece == BLACK_CANNON) {
      // 炮：平移隔空打，恰一炮架。
      for (let dir: i32 = 0; dir < 4; dir++) {
        const dx = dirOff(O_KING, dir * 2);
        const dy = dirOff(O_KING, dir * 2 + 1);
        let tx = x + dx;
        let ty = y + dy;
        let screened: i32 = 0;
        while (tx >= 0 && tx <= 8 && ty >= 0 && ty <= 9) {
          const tsq = ty * 9 + tx;
          const target: i32 = load<u8>(cs + (<usize>tsq));
          if (screened == 0) {
            if (target == EMPTY) {
              if (capturesOnly == 0) {
                store<i32>(outPtr + n * 4, sq | (tsq << 7));
                n++;
              }
            } else {
              screened = 1;
            }
          } else if (target != EMPTY) {
            if ((target <= RED_PAWN ? 1 : 0) != redPiece) {
              store<i32>(outPtr + n * 4, sq | (tsq << 7));
              n++;
            }

            break;
          }

          tx += dx;
          ty += dy;
        }
      }
    } else if (piece == RED_PAWN || piece == BLACK_PAWN) {
      // 兵/卒：前进一格；过河后可横走。
      const forward = redPiece == 1 ? -1 : 1;
      const ty = y + forward;
      if (ty >= 0 && ty <= 9) {
        const tsq = ty * 9 + x;
        const target: i32 = load<u8>(cs + (<usize>tsq));
        const targetOk =
          target == EMPTY
            ? capturesOnly == 0
            : (target <= RED_PAWN ? 1 : 0) != redPiece;
        if (targetOk) {
          store<i32>(outPtr + n * 4, sq | (tsq << 7));
          n++;
        }
      }

      // 过河判定：不在己方半场即已过河（红 home 区 3、黑 home 区 1）。
      if (area(sq) != (redPiece == 1 ? 3 : 1)) {
        for (let d: i32 = 0; d < 2; d++) {
          const tx = x + (d == 0 ? -1 : 1);
          if (tx < 0 || tx > 8) {
            continue;
          }

          const tsq = y * 9 + tx;
          const target: i32 = load<u8>(cs + (<usize>tsq));
          const targetOk =
            target == EMPTY
              ? capturesOnly == 0
              : (target <= RED_PAWN ? 1 : 0) != redPiece;
          if (targetOk) {
            store<i32>(outPtr + n * 4, sq | (tsq << 7));
            n++;
          }
        }
      }
    }
  }

  return <i32>n;
}

/** 指定方将/帅是否被攻击（含将帅照面；将位缺失视为安全）。 */
export function inCheck(base: usize, red: i32): i32 {
  const ksq = red == 1 ? getI(base, I_KINGR) : getI(base, I_KINGB);
  if (ksq < 0) {
    return 0;
  }

  if (attacked(base, ksq, 1 - red) != 0) {
    return 1;
  }

  // 将帅照面：沿本方将帅纵线找到的第一个子若为对方将帅，视同被将军。
  const enemyKing = red == 1 ? BLACK_KING : RED_KING;
  const cs = cells(base);
  const kx = ksq % 9;
  const ky = ksq / 9;
  for (let ty = ky - 1; ty >= 0; ty--) {
    const piece: i32 = load<u8>(cs + (<usize>(ty * 9 + kx)));
    if (piece != EMPTY) {
      return piece == enemyKing ? 1 : 0;
    }
  }

  for (let ty = ky + 1; ty <= 9; ty++) {
    const piece: i32 = load<u8>(cs + (<usize>(ty * 9 + kx)));
    if (piece != EMPTY) {
      return piece == enemyKing ? 1 : 0;
    }
  }

  return 0;
}

/** (sq) 格是否被 byRed 方攻击（不含将帅照面）。 */
function attacked(base: usize, sq: i32, byRed: i32): i32 {
  const cs = cells(base);
  const x = sq % 9;
  const y = sq / 9;
  const rook = byRed == 1 ? RED_ROOK : BLACK_ROOK;
  const cannon = byRed == 1 ? RED_CANNON : BLACK_CANNON;
  const knight = byRed == 1 ? RED_KNIGHT : BLACK_KNIGHT;
  const pawn = byRed == 1 ? RED_PAWN : BLACK_PAWN;

  // 兵/卒：正前一格；过河后横向两侧（以攻击兵所在格区域判定）。
  if (byRed == 1) {
    if (y < 9 && load<u8>(cs + (<usize>(sq + 9))) == pawn) {
      return 1;
    }

    if (x > 0 && load<u8>(cs + (<usize>(sq - 1))) == pawn && area(sq - 1) != 3) {
      return 1;
    }

    if (x < 8 && load<u8>(cs + (<usize>(sq + 1))) == pawn && area(sq + 1) != 3) {
      return 1;
    }
  } else {
    if (y > 0 && load<u8>(cs + (<usize>(sq - 9))) == pawn) {
      return 1;
    }

    if (x > 0 && load<u8>(cs + (<usize>(sq - 1))) == pawn && area(sq - 1) != 1) {
      return 1;
    }

    if (x < 8 && load<u8>(cs + (<usize>(sq + 1))) == pawn && area(sq + 1) != 1) {
      return 1;
    }
  }

  // 马：反向蹩马腿。
  for (let i: i32 = 0; i < 8; i++) {
    const tx = x + dirOff(O_KNIGHT, i * 2);
    const ty = y + dirOff(O_KNIGHT, i * 2 + 1);
    if (tx < 0 || tx > 8 || ty < 0 || ty > 9) {
      continue;
    }

    if (load<u8>(cs + (<usize>(ty * 9 + tx))) != knight) {
      continue;
    }

    const bx = x + dirOff(O_REV, i * 2);
    const by = y + dirOff(O_REV, i * 2 + 1);
    if (bx < 0 || bx > 8 || by < 0 || by > 9) {
      continue;
    }

    if (load<u8>(cs + (<usize>(by * 9 + bx))) == EMPTY) {
      return 1;
    }
  }

  // 车/炮：四方向扫描第一个阻挡子（车）与其后第一个子（炮）。
  for (let dir: i32 = 0; dir < 4; dir++) {
    const dx = dirOff(O_KING, dir * 2);
    const dy = dirOff(O_KING, dir * 2 + 1);
    let tx = x + dx;
    let ty = y + dy;
    let screened: i32 = 0;
    while (tx >= 0 && tx <= 8 && ty >= 0 && ty <= 9) {
      const piece: i32 = load<u8>(cs + (<usize>(ty * 9 + tx)));
      if (screened == 0) {
        if (piece != EMPTY) {
          if (piece == rook) {
            return 1;
          }

          screened = 1;
        }
      } else if (piece != EMPTY) {
        if (piece == cannon) {
          return 1;
        }

        break;
      }

      tx += dx;
      ty += dy;
    }
  }

  return 0;
}

/** 当前局面是否为搜索路径内的重复局面。 */
export function isRepetition(base: usize): i32 {
  const ply: i32 = getI(base, I_PLY);
  const keyLo: i32 = getI(base, I_KEYLO);
  const keyHi: i32 = getI(base, I_KEYHI);
  for (let i = ply - 4; i >= 0; i -= 2) {
    if (getI(base, I_NULLSTACK + (<usize>i) * 4) == 1) {
      break;
    }

    if (
      getI(base, I_KLOSTACK + (<usize>i) * 4) == keyLo &&
      getI(base, I_KHISTACK + (<usize>i) * 4) == keyHi
    ) {
      return 1;
    }
  }

  return 0;
}

/** 收集 byRed 方对 sq 格的全部直接攻击者（SEE 用），写入 seeAtk，返回数量。 */
function collectAttackers(base: usize, sq: i32, byRed: i32): i32 {
  const cs = cells(base);
  const occ: usize = base + I_SEEOCC;
  const x = sq % 9;
  const y = sq / 9;
  const rook = byRed == 1 ? RED_ROOK : BLACK_ROOK;
  const cannon = byRed == 1 ? RED_CANNON : BLACK_CANNON;
  const knight = byRed == 1 ? RED_KNIGHT : BLACK_KNIGHT;
  const pawn = byRed == 1 ? RED_PAWN : BLACK_PAWN;
  let n: i32 = 0;
  const atk: usize = base + I_SEEATK;

  // 兵/卒。
  if (byRed == 1) {
    if (y < 9 && load<u8>(cs + (<usize>(sq + 9))) == pawn && load<i32>(occ + (<usize>(sq + 9)) * 4) == 0) {
      store<i32>(atk, sq + 9);
      n++;
    }

    if (x > 0 && load<u8>(cs + (<usize>(sq - 1))) == pawn && load<i32>(occ + (<usize>(sq - 1)) * 4) == 0 && area(sq - 1) != 3) {
      store<i32>(atk + (<usize>n) * 4, sq - 1);
      n++;
    }

    if (x < 8 && load<u8>(cs + (<usize>(sq + 1))) == pawn && load<i32>(occ + (<usize>(sq + 1)) * 4) == 0 && area(sq + 1) != 3) {
      store<i32>(atk + (<usize>n) * 4, sq + 1);
      n++;
    }
  } else {
    if (y > 0 && load<u8>(cs + (<usize>(sq - 9))) == pawn && load<i32>(occ + (<usize>(sq - 9)) * 4) == 0) {
      store<i32>(atk, sq - 9);
      n++;
    }

    if (x > 0 && load<u8>(cs + (<usize>(sq - 1))) == pawn && load<i32>(occ + (<usize>(sq - 1)) * 4) == 0 && area(sq - 1) != 1) {
      store<i32>(atk + (<usize>n) * 4, sq - 1);
      n++;
    }

    if (x < 8 && load<u8>(cs + (<usize>(sq + 1))) == pawn && load<i32>(occ + (<usize>(sq + 1)) * 4) == 0 && area(sq + 1) != 1) {
      store<i32>(atk + (<usize>n) * 4, sq + 1);
      n++;
    }
  }

  // 马：反向蹩马腿。
  for (let i: i32 = 0; i < 8 && n < 16; i++) {
    const tx = x + dirOff(O_KNIGHT, i * 2);
    const ty = y + dirOff(O_KNIGHT, i * 2 + 1);
    if (tx < 0 || tx > 8 || ty < 0 || ty > 9) {
      continue;
    }

    const tsq = ty * 9 + tx;
    if (load<u8>(cs + (<usize>tsq)) != knight || load<i32>(occ + (<usize>tsq) * 4) != 0) {
      continue;
    }

    const bx = x + dirOff(O_REV, i * 2);
    const by = y + dirOff(O_REV, i * 2 + 1);
    if (bx < 0 || bx > 8 || by < 0 || by > 9) {
      continue;
    }

    const legSq = by * 9 + bx;
    if (load<u8>(cs + (<usize>legSq)) != EMPTY && load<i32>(occ + (<usize>legSq) * 4) == 0) {
      continue;
    }

    store<i32>(atk + (<usize>n) * 4, tsq);
    n++;
  }

  // 车/炮：四方向扫描（穿过已移走格），无 xray。
  for (let dir: i32 = 0; dir < 4 && n < 16; dir++) {
    const dx = dirOff(O_KING, dir * 2);
    const dy = dirOff(O_KING, dir * 2 + 1);
    let tx = x + dx;
    let ty = y + dy;
    let screened: i32 = 0;
    while (tx >= 0 && tx <= 8 && ty >= 0 && ty <= 9) {
      const tsq = ty * 9 + tx;
      const piece: i32 = load<u8>(cs + (<usize>tsq));
      if (load<i32>(occ + (<usize>tsq) * 4) == 0 && piece != EMPTY) {
        if (screened == 0) {
          if (piece == rook) {
            store<i32>(atk + (<usize>n) * 4, tsq);
            n++;
          }

          screened = 1;
        } else {
          if (piece == cannon) {
            store<i32>(atk + (<usize>n) * 4, tsq);
            n++;
          }

          break;
        }
      }

      tx += dx;
      ty += dy;
    }
  }

  return n;
}

/** 静态交换评估（攻方视角，负值表示交换亏损）。 */
export function see(base: usize, to: i32, firstFrom: i32): i32 {
  const cs = cells(base);
  const occ: usize = base + I_SEEOCC;
  const gain: usize = base + I_SEEGAIN;
  const touched: usize = base + I_SEETOUCH;
  let touchedN: i32 = 0;
  let d: i32 = 0;

  store<i32>(occ + (<usize>firstFrom) * 4, 1);
  store<i32>(touched, firstFrom);
  touchedN++;
  store<i32>(gain, pieceValue(load<u8>(cs + (<usize>to))));
  let onTo: i32 = load<u8>(cs + (<usize>firstFrom));

  let side: i32 = 1 - getI(base, I_RED);
  for (;;) {
    d++;
    if (d >= 31) {
      break;
    }

    const count = collectAttackers(base, to, side);
    if (count == 0) {
      break;
    }

    // 最小价值攻击者先吃。
    let best: i32 = load<i32>(base + I_SEEATK);
    let bestVal: i32 = pieceValue(load<u8>(cs + (<usize>best)));
    for (let i: i32 = 1; i < count; i++) {
      const atkSq: i32 = load<i32>(base + I_SEEATK + (<usize>i) * 4);
      const v = pieceValue(load<u8>(cs + (<usize>atkSq)));
      if (v < bestVal) {
        bestVal = v;
        best = atkSq;
      }
    }

    const prevGain: i32 = load<i32>(gain + (<usize>(d - 1)) * 4);
    store<i32>(gain + (<usize>d) * 4, pieceValue(onTo) - prevGain);
    // 双方继续交换的最优结果均亏损时提前终止：Math.max(-gain[d-1], gain[d]) < 0。
    const curGain: i32 = load<i32>(gain + (<usize>d) * 4);
    if (-prevGain < 0 && curGain < 0) {
      break;
    }

    store<i32>(occ + (<usize>best) * 4, 1);
    store<i32>(touched + (<usize>touchedN) * 4, best);
    touchedN++;
    onTo = load<u8>(cs + (<usize>best));
    side = 1 - side;
  }

  let dd = d;
  while (dd > 1) {
    dd--;
    const a: i32 = load<i32>(gain + (<usize>(dd - 1)) * 4);
    const b: i32 = load<i32>(gain + (<usize>dd) * 4);
    const negA = -a;
    const maxab = negA > b ? negA : b;
    // gain[d-1] = -max(-gain[d-1], gain[d])
    store<i32>(gain + (<usize>(dd - 1)) * 4, -maxab);
  }

  for (let i: i32 = 0; i < touchedN; i++) {
    const sq: i32 = load<i32>(touched + (<usize>i) * 4);
    store<i32>(occ + (<usize>sq) * 4, 0);
  }

  return load<i32>(gain);
}

/** 车机动性：四方向可直达空格数。 */
function rookMobility(cs: usize, sq: i32): i32 {
  const x = sq % 9;
  const y = sq / 9;
  let count: i32 = 0;
  for (let dir: i32 = 0; dir < 4; dir++) {
    const dx = dir == 2 ? -1 : dir == 3 ? 1 : 0;
    const dy = dir == 0 ? 1 : dir == 1 ? -1 : 0;
    let tx = x + dx;
    let ty = y + dy;
    while (tx >= 0 && tx <= 8 && ty >= 0 && ty <= 9 && load<u8>(cs + (<usize>(ty * 9 + tx))) == EMPTY) {
      count++;
      tx += dx;
      ty += dy;
    }
  }

  return count;
}

/** 马机动性：蹩马腿不挡且落点非己方的目标数。 */
function knightMobility(cs: usize, sq: i32): i32 {
  const x = sq % 9;
  const y = sq / 9;
  const red: i32 = load<u8>(cs + (<usize>sq)) == RED_KNIGHT ? 1 : 0;
  let count: i32 = 0;
  for (let i: i32 = 0; i < 8; i++) {
    const tx = x + dirOff(O_KNIGHT, i * 2);
    const ty = y + dirOff(O_KNIGHT, i * 2 + 1);
    if (tx < 0 || tx > 8 || ty < 0 || ty > 9) {
      continue;
    }

    const target: i32 = load<u8>(cs + (<usize>(ty * 9 + tx)));
    if (target != EMPTY && (target <= RED_PAWN ? 1 : 0) == red) {
      continue;
    }

    if (load<u8>(cs + (<usize>((y + dirOff(O_LEG, i * 2 + 1)) * 9 + (x + dirOff(O_LEG, i * 2))))) != EMPTY) {
      continue;
    }

    count++;
  }

  return count;
}

/** 己方将位沿纵向第一个子是否为对方炮（空头炮）。 */
function facingCannon(cs: usize, kingSq: i32, enemyCannon: i32): i32 {
  const kx = kingSq % 9;
  const ky = kingSq / 9;
  for (let ty = ky - 1; ty >= 0; ty--) {
    const piece: i32 = load<u8>(cs + (<usize>(ty * 9 + kx)));
    if (piece != EMPTY) {
      return piece == enemyCannon ? 1 : 0;
    }
  }

  for (let ty = ky + 1; ty <= 9; ty++) {
    const piece: i32 = load<u8>(cs + (<usize>(ty * 9 + kx)));
    if (piece != EMPTY) {
      return piece == enemyCannon ? 1 : 0;
    }
  }

  return 0;
}

function knowledge(i: i32): i32 {
  return load<i32>(TABLES + T_KNOWLEDGE + (<usize>i) * 4);
}

/**
 * 叶子节点静态评估（红方视角分，TS 侧按走子方翻转）。
 * 与 evaluate.ts evaluateFast 的红方分值语义一致（整数运算，除法截断一致）。
 */
export function evaluateRed(base: usize): i32 {
  const cs = cells(base);
  let score: i32 = getI(base, I_BASE);

  for (let sq: i32 = 0; sq < 90; sq++) {
    const piece: i32 = load<u8>(cs + (<usize>sq));
    if (piece == RED_ROOK) {
      score += rookMobility(cs, sq) * knowledge(0);
    } else if (piece == BLACK_ROOK) {
      score -= rookMobility(cs, sq) * knowledge(0);
    } else if (piece == RED_KNIGHT) {
      score += knightMobility(cs, sq) * knowledge(1);
    } else if (piece == BLACK_KNIGHT) {
      score -= knightMobility(cs, sq) * knowledge(1);
    }
  }

  // 残局阶段感知项。
  const egNum: i32 = knowledge(8) - getI(base, I_HEAVYR) - getI(base, I_HEAVYB);
  if (egNum > 0) {
    const full = knowledge(8);
    score += (getI(base, I_KNR) - getI(base, I_KNB)) * knowledge(2) * egNum / full;
    score -= (getI(base, I_CNR) - getI(base, I_CNB)) * knowledge(3) * egNum / full;
    const kingStep: i32 = knowledge(4) * egNum / full;
    score += kingStep * (9 - getI(base, I_KINGR) / 9);
    score -= kingStep * (getI(base, I_KINGB) / 9);
  }

  if (facingCannon(cs, getI(base, I_KINGR), BLACK_CANNON) != 0) {
    score -= knowledge(5);
  }
  if (facingCannon(cs, getI(base, I_KINGB), RED_CANNON) != 0) {
    score += knowledge(5);
  }

  // 缺士象惩罚（按对手重子威胁缩放）。
  const threatFull = knowledge(9);
  const heavyR: i32 = getI(base, I_HEAVYR);
  const heavyB: i32 = getI(base, I_HEAVYB);
  const redThreat: i32 = heavyB < threatFull ? heavyB : threatFull;
  const blackThreat: i32 = heavyR < threatFull ? heavyR : threatFull;
  score -= (2 - getI(base, I_ADVR)) * knowledge(6) * redThreat / threatFull;
  score -= (2 - getI(base, I_BISR)) * knowledge(7) * redThreat / threatFull;
  score += (2 - getI(base, I_ADVB)) * knowledge(6) * blackThreat / threatFull;
  score += (2 - getI(base, I_BISB)) * knowledge(7) * blackThreat / threatFull;

  return score;
}
