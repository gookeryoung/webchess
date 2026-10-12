import { Board, Piece } from '@webchess/core';
import { PIECE_SCORE, PIECE_VALUE } from './evaluate.js';

/**
 * 搜索专用快速局面（引擎内部实现，不对外暴露）。
 *
 * 针对旧实现的三个性能热点重写：
 * 1. 每节点 `Board.clone()` → 改为 make/unmake 原地走子还原（零分配）；
 * 2. 每节点 `toFen()` 字符串做置换表键 → 改为增量维护的 64 位 Zobrist 键；
 * 3. 合法性校验每次全盘扫描找将 → 增量维护双方将位，攻防检测直接扫射线。
 *
 * 走法编码为 16 位整数：`from | (to << 7)`（from/to 均为 0-89 格下标）。
 */

/** 搜索最大半着层数（主搜索 + 静态搜索共用栈空间）。 */
export const MAX_PLY = 128;

/** Zobrist 键：[棋子 15][格 90] 的 32 位低半 / 高半。 */
const ZOB_LO = new Int32Array(15 * 90);
const ZOB_HI = new Int32Array(15 * 90);
const ZOB_SIDE_LO = 0x1a2b3c4d | 0;
const ZOB_SIDE_HI = 0x4d3c2b1a | 0;

/** 由下标确定性派生 32 位伪随机数（固定种子的 xorshift 类步进，保证各平台键一致）。 */
function zobristWord(seed: number): number {
  let a = (0x9e3779b9 ^ Math.imul(seed, 0x85ebca6b)) >>> 0;
  a = (a + 0x6d2b79f5) | 0;
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return (t ^ (t >>> 14)) | 0;
}

for (let i = 0; i < ZOB_LO.length; i++) {
  ZOB_LO[i] = zobristWord(i * 2 + 1);
  ZOB_HI[i] = zobristWord(i * 2 + 2);
}

/** 区域编号表（0 棋盘外语义沿用 Rule：1 黑半场、2 黑九宫、3 红半场、4 红九宫）。 */
const AREA = new Int8Array(90);
{
  const rows = [
    [1, 1, 1, 2, 2, 2, 1, 1, 1],
    [1, 1, 1, 2, 2, 2, 1, 1, 1],
    [1, 1, 1, 2, 2, 2, 1, 1, 1],
    [1, 1, 1, 1, 1, 1, 1, 1, 1],
    [1, 1, 1, 1, 1, 1, 1, 1, 1],
    [3, 3, 3, 3, 3, 3, 3, 3, 3],
    [3, 3, 3, 3, 3, 3, 3, 3, 3],
    [3, 3, 3, 4, 4, 4, 3, 3, 3],
    [3, 3, 3, 4, 4, 4, 3, 3, 3],
    [3, 3, 3, 4, 4, 4, 3, 3, 3],
  ];
  for (let y = 0; y < 10; y++) {
    for (let x = 0; x < 9; x++) {
      AREA[y * 9 + x] = rows[y][x];
    }
  }
}

/** 帅/将四方向偏移。 */
const KING_X = [0, 0, 1, -1];
const KING_Y = [1, -1, 0, 0];
/** 仕/士四斜向偏移。 */
const ADV_X = [1, 1, -1, -1];
const ADV_Y = [1, -1, 1, -1];
/** 相/象田字偏移与象眼偏移。 */
const BISHOP_X = [2, 2, -2, -2];
const BISHOP_Y = [2, -2, 2, -2];
const EYE_X = [1, 1, -1, -1];
const EYE_Y = [1, -1, 1, -1];
/** 马日字偏移与马腿偏移（走法生成用）。 */
const KNIGHT_X = [1, 1, -1, -1, 2, 2, -2, -2];
const KNIGHT_Y = [2, -2, 2, -2, 1, -1, 1, -1];
const KNIGHT_LEG_X = [0, 0, 0, 0, 1, 1, -1, -1];
const KNIGHT_LEG_Y = [1, -1, 1, -1, 0, 0, 0, 0];
/** 反向马腿（受攻检测：以被攻击格为中心的马腿位置）。 */
const REV_LEG_X = [1, 1, -1, -1, 1, 1, -1, -1];
const REV_LEG_Y = [1, -1, 1, -1, 1, -1, 1, -1];

/** 由格下标与终点格下标编码走法。 */
export function encodeMove(from: number, to: number): number {
  return from | (to << 7);
}

/** 解码走法起点格下标。 */
export function moveFrom(move: number): number {
  return move & 127;
}

/** 解码走法终点格下标。 */
export function moveTo(move: number): number {
  return (move >>> 7) & 127;
}

/** 搜索专用快速局面。实例可复用：`setFromBoard` 重置后即可再次搜索。 */
export class FastPosition {
  /** 棋子矩阵（与内核 Board 同构：index = y * 9 + x）。 */
  readonly cells = new Uint8Array(90);
  /** 当前是否轮到红方走子。 */
  redToMove = true;
  /** 局面 Zobrist 键（低半 32 位 / 高半 32 位）。 */
  keyLo = 0;
  keyHi = 0;
  /** 红方视角静态分（子力 + 位置价值表，make/unmake 增量维护）。 */
  baseScore = 0;
  /** 双方将/帅所在格下标（-1 表示缺失）。 */
  kingRed = -1;
  kingBlack = -1;
  /** 双方重子（马/车/炮）数量，空步裁剪的守卫条件。 */
  heavyRed = 0;
  heavyBlack = 0;
  /** 已走半着数（栈深度）。 */
  ply = 0;

  private readonly undoMove = new Int32Array(MAX_PLY);
  private readonly undoCap = new Uint8Array(MAX_PLY);
  private readonly keyLoStack = new Int32Array(MAX_PLY + 1);
  private readonly keyHiStack = new Int32Array(MAX_PLY + 1);
  private readonly nullStack = new Uint8Array(MAX_PLY + 1);

  /**
   * 活跃棋子表（pieceSq 前 pieceCount 个为当前全部棋子所在格）：
   * 走法生成遍历此表而非全盘 90 格，make/unmake 增量维护。
   * slotOf[sq] 为该格棋子在 pieceSq 中的槽位（-1 表示空格）。
   */
  private readonly pieceSq = new Int32Array(32);
  private pieceCount = 0;
  private readonly slotOf = new Int32Array(90);

  /** 从内核 Board 重建局面（O(90) 初始化键、静态分与将位）。 */
  setFromBoard(board: Board): this {
    const cells = this.cells;
    const source = board.cells;
    cells.set(source);
    this.redToMove = board.redToMove;
    this.keyLo = 0;
    this.keyHi = 0;
    this.baseScore = 0;
    this.kingRed = -1;
    this.kingBlack = -1;
    this.heavyRed = 0;
    this.heavyBlack = 0;
    this.ply = 0;
    this.pieceCount = 0;
    this.slotOf.fill(-1);

    for (let sq = 0; sq < 90; sq++) {
      const piece = cells[sq];
      if (piece === Piece.Empty) {
        continue;
      }

      const idx = piece * 90 + sq;
      this.keyLo ^= ZOB_LO[idx];
      this.keyHi ^= ZOB_HI[idx];
      this.baseScore += PIECE_SCORE[idx];
      if (piece === Piece.RedKing) {
        this.kingRed = sq;
      } else if (piece === Piece.BlackKing) {
        this.kingBlack = sq;
      } else if (piece >= Piece.RedKnight && piece <= Piece.RedCannon) {
        this.heavyRed++;
      } else if (piece >= Piece.BlackKnight && piece <= Piece.BlackCannon) {
        this.heavyBlack++;
      }

      const slot = this.pieceCount++;
      this.pieceSq[slot] = sq;
      this.slotOf[sq] = slot;
    }

    if (!this.redToMove) {
      this.keyLo ^= ZOB_SIDE_LO;
      this.keyHi ^= ZOB_SIDE_HI;
    }

    this.keyLoStack[0] = this.keyLo;
    this.keyHiStack[0] = this.keyHi;
    this.nullStack[0] = 0;
    return this;
  }

  /**
   * 原地走子（伪合法即可）：增量更新棋子矩阵、Zobrist 键、静态分、将位与重子数。
   * 走后用 `inCheck(走子方)` 判定合法性；不合法则 `unmake` 回退。
   */
  make(move: number): void {
    const from = move & 127;
    const to = (move >>> 7) & 127;
    const cells = this.cells;
    const piece = cells[from];
    const captured = cells[to];
    const p = piece * 90;

    this.undoMove[this.ply] = move;
    this.undoCap[this.ply] = captured;

    this.keyLo ^= ZOB_LO[p + from] ^ ZOB_LO[p + to];
    this.keyHi ^= ZOB_HI[p + from] ^ ZOB_HI[p + to];
    this.baseScore += PIECE_SCORE[p + to] - PIECE_SCORE[p + from];

    if (captured !== Piece.Empty) {
      const c = captured * 90;
      this.keyLo ^= ZOB_LO[c + to];
      this.keyHi ^= ZOB_HI[c + to];
      this.baseScore -= PIECE_SCORE[c + to];
      if (captured >= Piece.RedKnight && captured <= Piece.RedCannon) {
        this.heavyRed--;
      } else if (captured >= Piece.BlackKnight && captured <= Piece.BlackCannon) {
        this.heavyBlack--;
      }

      // 尾交换删除被吃子。
      const capSlot = this.slotOf[to];
      const last = --this.pieceCount;
      const movedSq = this.pieceSq[last];
      this.pieceSq[capSlot] = movedSq;
      this.slotOf[movedSq] = capSlot;
      this.pieceSq[last] = 0;
    }

    // 走子方在表中的槽位改为终点格。
    const fromSlot = this.slotOf[from];
    this.pieceSq[fromSlot] = to;
    this.slotOf[to] = fromSlot;
    this.slotOf[from] = -1;

    cells[from] = Piece.Empty;
    cells[to] = piece;
    if (piece === Piece.RedKing) {
      this.kingRed = to;
    } else if (piece === Piece.BlackKing) {
      this.kingBlack = to;
    }

    this.redToMove = !this.redToMove;
    this.keyLo ^= ZOB_SIDE_LO;
    this.keyHi ^= ZOB_SIDE_HI;
    this.ply++;
    this.keyLoStack[this.ply] = this.keyLo;
    this.keyHiStack[this.ply] = this.keyHi;
    this.nullStack[this.ply] = 0;
  }

  /** 回退一步 `make`（XOR 与加减均自逆，按栈记录还原）。 */
  unmake(): void {
    this.ply--;
    const move = this.undoMove[this.ply];
    const captured = this.undoCap[this.ply];
    const from = move & 127;
    const to = (move >>> 7) & 127;
    const cells = this.cells;
    const piece = cells[to];
    const p = piece * 90;

    // 走子方槽位还原为起点格。
    const toSlot = this.slotOf[to];
    this.pieceSq[toSlot] = from;
    this.slotOf[from] = toSlot;
    this.slotOf[to] = -1;

    if (captured !== Piece.Empty) {
      // 被吃子追加回列表尾（unmake 后槽序与 make 前可能置换，但活跃子集恒一致，
      // 走法生成只依赖集合语义）。
      this.pieceSq[this.pieceCount] = to;
      this.slotOf[to] = this.pieceCount;
      this.pieceCount++;
    }

    cells[from] = piece;
    cells[to] = captured;

    this.keyLo ^= ZOB_LO[p + from] ^ ZOB_LO[p + to];
    this.keyHi ^= ZOB_HI[p + from] ^ ZOB_HI[p + to];
    this.baseScore -= PIECE_SCORE[p + to] - PIECE_SCORE[p + from];

    if (captured !== Piece.Empty) {
      const c = captured * 90;
      this.keyLo ^= ZOB_LO[c + to];
      this.keyHi ^= ZOB_HI[c + to];
      this.baseScore += PIECE_SCORE[c + to];
      if (captured >= Piece.RedKnight && captured <= Piece.RedCannon) {
        this.heavyRed++;
      } else if (captured >= Piece.BlackKnight && captured <= Piece.BlackCannon) {
        this.heavyBlack++;
      }
    }

    if (piece === Piece.RedKing) {
      this.kingRed = from;
    } else if (piece === Piece.BlackKing) {
      this.kingBlack = from;
    }

    this.redToMove = !this.redToMove;
    this.keyLo ^= ZOB_SIDE_LO;
    this.keyHi ^= ZOB_SIDE_HI;
  }

  /** 空步（null move）：仅翻边换键，供空步裁剪试探用。 */
  makeNull(): void {
    this.redToMove = !this.redToMove;
    this.keyLo ^= ZOB_SIDE_LO;
    this.keyHi ^= ZOB_SIDE_HI;
    this.ply++;
    this.keyLoStack[this.ply] = 0;
    this.keyHiStack[this.ply] = 0;
    this.nullStack[this.ply] = 1;
  }

  /** 回退空步。 */
  unmakeNull(): void {
    this.ply--;
    this.redToMove = !this.redToMove;
    this.keyLo ^= ZOB_SIDE_LO;
    this.keyHi ^= ZOB_SIDE_HI;
  }

  /**
   * 生成走子方全部伪合法着法（含蹩马腿/塞象眼/九宫/半场/过河兵限制，
   * 不含「走后被将军」过滤；将帅照面由走后的 inCheck 判定拦截）。
   * @param out 输出缓冲（扁平数组，调用方保证容量）。
   * @param base 写入起始下标（每搜索层独立区间，避免每节点分配切片）。
   * @param capturesOnly 仅生成吃子着法（静态搜索用）。
   * @returns 生成着法数。
   */
  genMoves(out: Int32Array, base: number, capturesOnly: boolean): number {
    const cells = this.cells;
    const red = this.redToMove;
    let n = base;

    for (let idx = 0; idx < this.pieceCount; idx++) {
      const sq = this.pieceSq[idx];
      const piece = cells[sq];

      const redPiece = piece <= Piece.RedPawn;
      if (redPiece !== red) {
        continue;
      }

      const x = sq % 9;
      const y = (sq / 9) | 0;

      switch (piece) {
        case Piece.RedKing:
        case Piece.BlackKing: {
          const palace = redPiece ? 4 : 2;
          for (let i = 0; i < 4; i++) {
            const tx = x + KING_X[i];
            const ty = y + KING_Y[i];
            if (tx < 0 || tx > 8 || ty < 0 || ty > 9) {
              continue;
            }

            const tsq = ty * 9 + tx;
            if (AREA[tsq] !== palace) {
              continue;
            }

            const target = cells[tsq];
            if (target !== Piece.Empty && (target <= Piece.RedPawn) === redPiece) {
              continue;
            }

            if (capturesOnly && target === Piece.Empty) {
              continue;
            }

            out[n++] = sq | (tsq << 7);
          }

          break;
        }

        case Piece.RedAdvisor:
        case Piece.BlackAdvisor: {
          const palace = redPiece ? 4 : 2;
          for (let i = 0; i < 4; i++) {
            const tx = x + ADV_X[i];
            const ty = y + ADV_Y[i];
            if (tx < 0 || tx > 8 || ty < 0 || ty > 9) {
              continue;
            }

            const tsq = ty * 9 + tx;
            if (AREA[tsq] !== palace) {
              continue;
            }

            const target = cells[tsq];
            if (target !== Piece.Empty && (target <= Piece.RedPawn) === redPiece) {
              continue;
            }

            if (capturesOnly && target === Piece.Empty) {
              continue;
            }

            out[n++] = sq | (tsq << 7);
          }

          break;
        }

        case Piece.RedBishop:
        case Piece.BlackBishop: {
          for (let i = 0; i < 4; i++) {
            const tx = x + BISHOP_X[i];
            const ty = y + BISHOP_Y[i];
            if (tx < 0 || tx > 8 || ty < 0 || ty > 9) {
              continue;
            }

            const tsq = ty * 9 + tx;
            const area = AREA[tsq];
            // 相/象不得过河：黑方 area 1-2、红方 area 3-4。
            if (area === 0 || (redPiece ? area < 3 : area > 2)) {
              continue;
            }

            const target = cells[tsq];
            if (target !== Piece.Empty && (target <= Piece.RedPawn) === redPiece) {
              continue;
            }

            if (capturesOnly && target === Piece.Empty) {
              continue;
            }

            // 塞象眼：田字中心须为空。
            if (cells[(y + EYE_Y[i]) * 9 + (x + EYE_X[i])] !== Piece.Empty) {
              continue;
            }

            out[n++] = sq | (tsq << 7);
          }

          break;
        }

        case Piece.RedKnight:
        case Piece.BlackKnight: {
          for (let i = 0; i < 8; i++) {
            const tx = x + KNIGHT_X[i];
            const ty = y + KNIGHT_Y[i];
            if (tx < 0 || tx > 8 || ty < 0 || ty > 9) {
              continue;
            }

            const target = cells[ty * 9 + tx];
            if (target !== Piece.Empty && (target <= Piece.RedPawn) === redPiece) {
              continue;
            }

            if (capturesOnly && target === Piece.Empty) {
              continue;
            }

            // 蹩马腿。
            if (cells[(y + KNIGHT_LEG_Y[i]) * 9 + (x + KNIGHT_LEG_X[i])] !== Piece.Empty) {
              continue;
            }

            out[n++] = sq | ((ty * 9 + tx) << 7);
          }

          break;
        }

        case Piece.RedRook:
        case Piece.BlackRook: {
          for (let dir = 0; dir < 4; dir++) {
            const dx = KING_X[dir];
            const dy = KING_Y[dir];
            let tx = x + dx;
            let ty = y + dy;
            while (tx >= 0 && tx <= 8 && ty >= 0 && ty <= 9) {
              const tsq = ty * 9 + tx;
              const target = cells[tsq];
              if (target === Piece.Empty) {
                if (!capturesOnly) {
                  out[n++] = sq | (tsq << 7);
                }
              } else {
                if ((target <= Piece.RedPawn) !== redPiece) {
                  out[n++] = sq | (tsq << 7);
                }

                break;
              }

              tx += dx;
              ty += dy;
            }
          }

          break;
        }

        case Piece.RedCannon:
        case Piece.BlackCannon: {
          for (let dir = 0; dir < 4; dir++) {
            const dx = KING_X[dir];
            const dy = KING_Y[dir];
            let tx = x + dx;
            let ty = y + dy;
            let screened = false;
            while (tx >= 0 && tx <= 8 && ty >= 0 && ty <= 9) {
              const tsq = ty * 9 + tx;
              const target = cells[tsq];
              if (!screened) {
                if (target === Piece.Empty) {
                  if (!capturesOnly) {
                    out[n++] = sq | (tsq << 7);
                  }
                } else {
                  // 第一个子作炮架。
                  screened = true;
                }
              } else if (target !== Piece.Empty) {
                // 越过恰一个炮架后的第一个子：敌方即可吃。
                if ((target <= Piece.RedPawn) !== redPiece) {
                  out[n++] = sq | (tsq << 7);
                }

                break;
              }

              tx += dx;
              ty += dy;
            }
          }

          break;
        }

        case Piece.RedPawn:
        case Piece.BlackPawn: {
          const forward = redPiece ? -1 : 1;
          const ty = y + forward;
          if (ty >= 0 && ty <= 9) {
            const tsq = ty * 9 + x;
            const target = cells[tsq];
            if (
              (target === Piece.Empty && !capturesOnly) ||
              (target !== Piece.Empty && (target <= Piece.RedPawn) !== redPiece)
            ) {
              out[n++] = sq | (tsq << 7);
            }
          }

          // 过河后可横走：黑方 home 区 1、红方 home 区 3，不在 home 即已过河。
          if (AREA[sq] !== (redPiece ? 3 : 1)) {
            for (const dx of [-1, 1]) {
              const tx = x + dx;
              if (tx < 0 || tx > 8) {
                continue;
              }

              const tsq = y * 9 + tx;
              const target = cells[tsq];
              if (
                (target === Piece.Empty && !capturesOnly) ||
                (target !== Piece.Empty && (target <= Piece.RedPawn) !== redPiece)
              ) {
                out[n++] = sq | (tsq << 7);
              }
            }
          }

          break;
        }

        default:
          break;
      }
    }

    return n - base;
  }

  /**
   * 生成走子方全部合法着法（伪合法过滤「走后被将军/将帅照面」），原地压缩写回。
   * @returns 合法着法数。
   */
  genLegalMoves(out: Int32Array, base: number): number {
    const count = this.genMoves(out, base, false);
    let w = base;
    for (let i = base; i < base + count; i++) {
      const move = out[i];
      this.make(move);
      const moverRed = !this.redToMove;
      const illegal = this.inCheck(moverRed);
      this.unmake();
      if (!illegal) {
        out[w++] = move;
      }
    }

    return w - base;
  }

  /** 指定方将/帅是否被攻击（含将帅照面判定；将位缺失时视为安全）。 */
  inCheck(red: boolean): boolean {
    const ksq = red ? this.kingRed : this.kingBlack;
    if (ksq < 0) {
      return false;
    }

    if (this.attacked(ksq, !red)) {
      return true;
    }

    // 将帅照面：沿本方将帅所在纵线找到的第一个子若为对方将帅，则不可走（视同被将军）。
    const enemyKing = red ? Piece.BlackKing : Piece.RedKing;
    const cells = this.cells;
    const kx = ksq % 9;
    const ky = (ksq / 9) | 0;
    for (let ty = ky - 1; ty >= 0; ty--) {
      const piece = cells[ty * 9 + kx];
      if (piece !== Piece.Empty) {
        return piece === enemyKing;
      }
    }

    for (let ty = ky + 1; ty <= 9; ty++) {
      const piece = cells[ty * 9 + kx];
      if (piece !== Piece.Empty) {
        return piece === enemyKing;
      }
    }

    return false;
  }

  /**
   * (sq) 格是否被 byRed 方攻击（不含将帅照面，由 inCheck 单独判定）：
   * 兵/卒（正向 + 过河横向）、马（反向蹩马腿）、车（第一个阻挡子）、炮（恰一炮架）。
   */
  private attacked(sq: number, byRed: boolean): boolean {
    const cells = this.cells;
    const x = sq % 9;
    const y = (sq / 9) | 0;
    const rook = byRed ? Piece.RedRook : Piece.BlackRook;
    const cannon = byRed ? Piece.RedCannon : Piece.BlackCannon;
    const knight = byRed ? Piece.RedKnight : Piece.BlackKnight;
    const pawn = byRed ? Piece.RedPawn : Piece.BlackPawn;

    // 兵/卒：正前一格；过河后横向两侧（以兵所在格区域判定是否过河）。
    if (byRed) {
      if (y < 9 && cells[sq + 9] === pawn) {
        return true;
      }

      if (x > 0 && cells[sq - 1] === pawn && AREA[sq - 1] !== 3) {
        return true;
      }

      if (x < 8 && cells[sq + 1] === pawn && AREA[sq + 1] !== 3) {
        return true;
      }
    } else {
      if (y > 0 && cells[sq - 9] === pawn) {
        return true;
      }

      if (x > 0 && cells[sq - 1] === pawn && AREA[sq - 1] !== 1) {
        return true;
      }

      if (x < 8 && cells[sq + 1] === pawn && AREA[sq + 1] !== 1) {
        return true;
      }
    }

    // 马：反向蹩马腿（以被攻击格为中心，检查马腿在马的一侧）。
    for (let i = 0; i < 8; i++) {
      const tx = x + KNIGHT_X[i];
      const ty = y + KNIGHT_Y[i];
      if (tx < 0 || tx > 8 || ty < 0 || ty > 9) {
        continue;
      }

      if (cells[ty * 9 + tx] !== knight) {
        continue;
      }

      const bx = x + REV_LEG_X[i];
      const by = y + REV_LEG_Y[i];
      if (bx < 0 || bx > 8 || by < 0 || by > 9) {
        continue;
      }

      if (cells[by * 9 + bx] === Piece.Empty) {
        return true;
      }
    }

    // 车/炮：四方向扫描第一个阻挡子（车）与其后第一个子（炮）。
    for (let dir = 0; dir < 4; dir++) {
      const dx = KING_X[dir];
      const dy = KING_Y[dir];
      let tx = x + dx;
      let ty = y + dy;
      let screened = false;
      while (tx >= 0 && tx <= 8 && ty >= 0 && ty <= 9) {
        const piece = cells[ty * 9 + tx];
        if (!screened) {
          if (piece !== Piece.Empty) {
            if (piece === rook) {
              return true;
            }

            screened = true;
          }
        } else if (piece !== Piece.Empty) {
          if (piece === cannon) {
            return true;
          }

          break;
        }

        tx += dx;
        ty += dy;
      }
    }

    return false;
  }

  /** 当前局面是否为搜索路径内的重复局面（同一 Zobrist 键再现，判和返回 0 分的依据）。 */
  isRepetition(): boolean {
    for (let i = this.ply - 4; i >= 0; i -= 2) {
      if (this.nullStack[i] === 1) {
        break;
      }

      if (this.keyLoStack[i] === this.keyLo && this.keyHiStack[i] === this.keyHi) {
        return true;
      }
    }

    return false;
  }

  /** SEE 专用：已虚拟移走标记（1=该格子参与交换的子已离开）。 */
  private readonly seeOcc = new Uint8Array(90);
  /** SEE 专用：攻击者格缓冲。 */
  private readonly seeAtk = new Int32Array(16);
  /** SEE 专用：交换收益表。 */
  private readonly seeGain = new Int32Array(32);
  /** SEE 专用：本轮动过的格（结束时清理 seeOcc）。 */
  private readonly seeTouched = new Int32Array(40);

  /**
   * 收集 byRed 方对 sq 格的全部直接攻击者（不含将帅，不含 xray 车穿透；
   * seeOcc 标记的「已移走」格视为空）。写入 seeAtk，返回数量。
   */
  private collectAttackers(sq: number, byRed: boolean): number {
    const cells = this.cells;
    const occ = this.seeOcc;
    const x = sq % 9;
    const y = (sq / 9) | 0;
    const rook = byRed ? Piece.RedRook : Piece.BlackRook;
    const cannon = byRed ? Piece.RedCannon : Piece.BlackCannon;
    const knight = byRed ? Piece.RedKnight : Piece.BlackKnight;
    const pawn = byRed ? Piece.RedPawn : Piece.BlackPawn;
    let n = 0;

    // 兵/卒：正前一格与过河后的横向两格。
    if (byRed) {
      if (y < 9 && cells[sq + 9] === pawn && !occ[sq + 9]) {
        this.seeAtk[n++] = sq + 9;
      }

      if (x > 0 && cells[sq - 1] === pawn && !occ[sq - 1] && AREA[sq - 1] !== 3) {
        this.seeAtk[n++] = sq - 1;
      }

      if (x < 8 && cells[sq + 1] === pawn && !occ[sq + 1] && AREA[sq + 1] !== 3) {
        this.seeAtk[n++] = sq + 1;
      }
    } else {
      if (y > 0 && cells[sq - 9] === pawn && !occ[sq - 9]) {
        this.seeAtk[n++] = sq - 9;
      }

      if (x > 0 && cells[sq - 1] === pawn && !occ[sq - 1] && AREA[sq - 1] !== 1) {
        this.seeAtk[n++] = sq - 1;
      }

      if (x < 8 && cells[sq + 1] === pawn && !occ[sq + 1] && AREA[sq + 1] !== 1) {
        this.seeAtk[n++] = sq + 1;
      }
    }

    // 马：反向蹩马腿（腿格被子实占才蹩；已移走视为空、马激活）。
    for (let i = 0; i < 8 && n < 16; i++) {
      const tx = x + KNIGHT_X[i];
      const ty = y + KNIGHT_Y[i];
      if (tx < 0 || tx > 8 || ty < 0 || ty > 9) {
        continue;
      }

      const tsq = ty * 9 + tx;
      if (cells[tsq] !== knight || occ[tsq]) {
        continue;
      }

      const bx = x + REV_LEG_X[i];
      const by = y + REV_LEG_Y[i];
      if (bx < 0 || bx > 8 || by < 0 || by > 9) {
        continue;
      }

      const legSq = by * 9 + bx;
      if (cells[legSq] !== Piece.Empty && !occ[legSq]) {
        continue;
      }

      this.seeAtk[n++] = tsq;
    }

    // 车/炮：四方向扫描（穿过已移走格）；无 xray——遇第一个实占子即停，
    // 炮需恰一个实占炮架。保守低估防守方，剪枝方向恒为「少剪不误剪」。
    for (let dir = 0; dir < 4 && n < 16; dir++) {
      const dx = KING_X[dir];
      const dy = KING_Y[dir];
      let tx = x + dx;
      let ty = y + dy;
      let screened = false;
      while (tx >= 0 && tx <= 8 && ty >= 0 && ty <= 9) {
        const tsq = ty * 9 + tx;
        const piece = cells[tsq];
        if (!occ[tsq] && piece !== Piece.Empty) {
          if (!screened) {
            if (piece === rook) {
              this.seeAtk[n++] = tsq;
            }

            screened = true;
          } else {
            if (piece === cannon) {
              this.seeAtk[n++] = tsq;
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

  /**
   * 静态交换评估（SEE）：以 firstFrom 的子攻击 to 格的完整交换序列净收益，
   * 攻方视角（当前走子方），小于 0 表示交换亏损。
   * 交替递推 + 负极大回溯取双方最优；帅不参战、无 xray（安全侧简化）。
   */
  see(to: number, firstFrom: number): number {
    const cells = this.cells;
    const occ = this.seeOcc;
    const gain = this.seeGain;
    const touched = this.seeTouched;
    let touchedN = 0;
    let d = 0;

    // 首攻击者虚拟移走；它吃掉 victim 后占据 to，成为下一轮被吃对象。
    occ[firstFrom] = 1;
    touched[touchedN++] = firstFrom;
    gain[0] = PIECE_VALUE[cells[to]];
    let onTo = cells[firstFrom];

    // 轮到守方反吃，交替至一方无攻击者。
    let side = !this.redToMove;
    for (;;) {
      if (++d >= 31) {
        break;
      }

      const count = this.collectAttackers(to, side);
      if (count === 0) {
        break;
      }

      // 最小价值攻击者先吃（双方都按最优次序）。
      let best = this.seeAtk[0];
      let bestVal = PIECE_VALUE[cells[best]];
      for (let i = 1; i < count; i++) {
        const v = PIECE_VALUE[cells[this.seeAtk[i]]];
        if (v < bestVal) {
          bestVal = v;
          best = this.seeAtk[i];
        }
      }

      gain[d] = PIECE_VALUE[onTo] - gain[d - 1];
      // 双方继续交换的最优结果均亏损时提前终止（剩余轮次必有一方弃吃）。
      if (Math.max(-gain[d - 1], gain[d]) < 0) {
        break;
      }

      occ[best] = 1;
      touched[touchedN++] = best;
      onTo = cells[best];
      side = !side;
    }

    while (--d > 0) {
      gain[d - 1] = -Math.max(-gain[d - 1], gain[d]);
    }

    for (let i = 0; i < touchedN; i++) {
      occ[touched[i]] = 0;
    }

    return gain[0];
  }
}
