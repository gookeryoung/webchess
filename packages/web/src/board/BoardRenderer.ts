import { Board, Move, Piece, Position } from '@webchess/core';
import { BoardGeometry, cellCenter } from './geometry.js';

/**
 * Canvas 2D 棋盘渲染器。
 *
 * 与原 Godot BoardView 的职责一一对应：底图、棋子、选中框、落点提示、走子动画、箭头。
 * 差异：棋盘底图由代码矢量绘制（原为 1240x1340 PNG），棋子仍用原 PNG 贴图。
 * 渲染只依赖 CanvasRenderingContext2D 这一抽象，小程序端换用同接口即可复用本文件。
 */

/** 棋子贴图文件名（索引 = 棋子编码 - 1）。 */
const PieceTextureNames: readonly string[] = [
  'r_shuai', 'r_shi', 'r_xiang', 'r_ma', 'r_ju', 'r_pao', 'r_bing',
  'b_jiang', 'b_shi', 'b_xiang', 'b_ma', 'b_ju', 'b_pao', 'b_zu',
];

export interface PieceImages {
  get(piece: number): CanvasImageSource | null;
}

/** 加载全部棋子贴图。 */
export async function loadPieceImages(baseUrl = '/pieces/'): Promise<PieceImages> {
  const entries = await Promise.all(
    PieceTextureNames.map(
      (name) =>
        new Promise<[number, HTMLImageElement | null]>((resolve) => {
          const img = new Image();
          img.onload = () => resolve([PieceTextureNames.indexOf(name) + 1, img]);
          img.onerror = () => resolve([PieceTextureNames.indexOf(name) + 1, null]);
          img.src = `${baseUrl}${name}.png`;
        }),
    ),
  );

  const map = new Map<number, CanvasImageSource>();
  for (const [piece, img] of entries) {
    if (img !== null) {
      map.set(piece, img);
    }
  }

  return { get: (piece) => map.get(piece) ?? null };
}

/** 一次渲染所需的全部状态。 */
export interface RenderState {
  board: Board;
  /** 当前选中的起点。 */
  selected: Position | null;
  /** 选中棋子的合法落点。 */
  targets: readonly Position[];
  /** 最近一步（起点 → 终点），用于高亮。 */
  lastMove: Move | null;
  /** 被将军方的将/帅位置（高亮提示）。 */
  checkedKing: Position | null;
  /** 建议箭头（按优劣排序）。 */
  arrows: readonly { from: Position; to: Position }[];
  /** 提示着法（方块高亮起终点）。 */
  hint: Move | null;
  /** 走子动画进度：null 表示无动画。 */
  animation: { move: Move; progress: number } | null;
  /** 动画期间被吃的棋子（用于淡出）。 */
  animationCapture: number | null;
}

export class BoardRenderer {
  constructor(private readonly images: PieceImages) {}

  /** 绘制完整画面。 */
  render(ctx: CanvasRenderingContext2D, g: BoardGeometry, state: RenderState): void {
    ctx.clearRect(0, 0, g.width, g.height);
    this.drawBoard(ctx, g);

    if (state.lastMove !== null) {
      this.drawLastMoveMarkers(ctx, g, state.lastMove);
    }

    if (state.checkedKing !== null) {
      this.drawCheckMarker(ctx, g, state.checkedKing);
    }

    this.drawPieces(ctx, g, state);

    if (state.selected !== null) {
      this.drawSelection(ctx, g, state.selected, state.board.getPieceAt(state.selected));
      for (const target of state.targets) {
        this.drawTarget(ctx, g, target, state.board.getPieceAt(target));
      }
    }

    if (state.hint !== null) {
      this.drawHint(ctx, g, state.hint);
    }

    state.arrows.forEach((arrow, index) => {
      this.drawArrow(ctx, g, arrow.from, arrow.to, index);
    });
  }

  /** 矢量绘制棋盘：底色、网格、河界、九宫斜线、外框、炮兵位标记。 */
  private drawBoard(ctx: CanvasRenderingContext2D, g: BoardGeometry): void {
    const inset = g.cell * 0.22;
    const left = g.paddingX - inset;
    const top = g.paddingY - inset;
    const right = g.paddingX + (Board.Width - 1) * g.cell + inset;
    const bottom = g.paddingY + (Board.Height - 1) * g.cell + inset;

    ctx.fillStyle = '#f2dcae';
    ctx.fillRect(0, 0, g.width, g.height);

    ctx.strokeStyle = '#8a5a2b';
    ctx.lineWidth = Math.max(1, g.cell * 0.035);
    ctx.lineCap = 'square';

    // 外框（双线）
    ctx.strokeRect(left, top, right - left, bottom - top);
    ctx.lineWidth = Math.max(1, g.cell * 0.015);
    ctx.strokeRect(
      left + g.cell * 0.09,
      top + g.cell * 0.09,
      right - left - g.cell * 0.18,
      bottom - top - g.cell * 0.18,
    );

    ctx.lineWidth = Math.max(1, g.cell * 0.022);

    // 横线 10 条
    for (let y = 0; y < Board.Height; y++) {
      const p = cellCenter(g, 0, y);
      const q = cellCenter(g, Board.Width - 1, y);
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
      ctx.lineTo(q.x, q.y);
      ctx.stroke();
    }

    // 纵线 9 条（中间被河界断开，最外两条贯通）
    for (let x = 0; x < Board.Width; x++) {
      const topPoint = cellCenter(g, x, 0);
      const bottomPoint = cellCenter(g, x, Board.Height - 1);
      if (x === 0 || x === Board.Width - 1) {
        ctx.beginPath();
        ctx.moveTo(topPoint.x, topPoint.y);
        ctx.lineTo(bottomPoint.x, bottomPoint.y);
        ctx.stroke();
        continue;
      }

      const upperEnd = cellCenter(g, x, 4);
      const lowerStart = cellCenter(g, x, 5);
      ctx.beginPath();
      ctx.moveTo(topPoint.x, topPoint.y);
      ctx.lineTo(upperEnd.x, upperEnd.y);
      ctx.moveTo(lowerStart.x, lowerStart.y);
      ctx.lineTo(bottomPoint.x, bottomPoint.y);
      ctx.stroke();
    }

    // 九宫斜线
    this.drawPalace(ctx, g, 0);
    this.drawPalace(ctx, g, 7);

    // 河界文字
    ctx.fillStyle = '#8a5a2b';
    ctx.font = `${Math.round(g.cell * 0.42)}px "KaiTi", "STKaiti", serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const riverY = (cellCenter(g, 0, 4).y + cellCenter(g, 0, 5).y) / 2;
    const qX = cellCenter(g, 2, 0).x;
    const hX = cellCenter(g, 6, 0).x;
    ctx.fillText('楚 河', qX, riverY);
    ctx.fillText('汉 界', hX, riverY);

    // 炮位与兵位标记
    this.drawStar(ctx, g, 1, 2);
    this.drawStar(ctx, g, 7, 2);
    this.drawStar(ctx, g, 1, 7);
    this.drawStar(ctx, g, 7, 7);
    for (const x of [0, 2, 4, 6, 8]) {
      this.drawStar(ctx, g, x, 3);
      this.drawStar(ctx, g, x, 6);
    }
  }

  private drawPalace(ctx: CanvasRenderingContext2D, g: BoardGeometry, topY: number): void {
    const a = cellCenter(g, 3, topY);
    const b = cellCenter(g, 5, topY + 2);
    const c = cellCenter(g, 5, topY);
    const d = cellCenter(g, 3, topY + 2);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.moveTo(c.x, c.y);
    ctx.lineTo(d.x, d.y);
    ctx.stroke();
  }

  /** 炮/兵位的直角标记。 */
  private drawStar(ctx: CanvasRenderingContext2D, g: BoardGeometry, x: number, y: number): void {
    const c = cellCenter(g, x, y);
    const len = g.cell * 0.16;
    const gap = g.cell * 0.08;
    ctx.lineWidth = Math.max(1, g.cell * 0.018);
    const leftBlocked = x === 0;
    const rightBlocked = x === Board.Width - 1;
    const corners: [number, number, number, number][] = [];
    if (!leftBlocked) {
      corners.push([-1, -1, -1, 1], [-1, 1, 1, 1]);
    }

    if (!rightBlocked) {
      corners.push([1, -1, 1, 1], [1, 1, -1, 1]);
    }

    for (const [sx, sy, dx, dy] of corners) {
      const ox = c.x + sx * gap;
      const oy = c.y + sy * gap;
      ctx.beginPath();
      ctx.moveTo(ox + dx * len, oy);
      ctx.lineTo(ox, oy);
      ctx.lineTo(ox, oy + dy * len);
      ctx.stroke();
    }
  }

  /** 绘制棋子；动画期间按插值移动。 */
  private drawPieces(ctx: CanvasRenderingContext2D, g: BoardGeometry, state: RenderState): void {
    const anim = state.animation;
    for (let y = 0; y < Board.Height; y++) {
      for (let x = 0; x < Board.Width; x++) {
        const piece = state.board.getPiece(x, y);
        if (!Piece.isValid(piece)) {
          continue;
        }

        const center = cellCenter(g, x, y);
        let px = center.x;
        let py = center.y;
        let alpha = 1;

        if (anim !== null && anim.move.to.x === x && anim.move.to.y === y) {
          const from = cellCenter(g, anim.move.from.x, anim.move.from.y);
          px = from.x + (center.x - from.x) * anim.progress;
          py = from.y + (center.y - from.y) * anim.progress;
        }

        if (
          anim !== null &&
          state.animationCapture !== null &&
          state.animationCapture !== Piece.Empty &&
          anim.move.to.x === x &&
          anim.move.to.y === y
        ) {
          // 被吃棋子淡出：此处以起点棋子覆盖绘制，被吃子不再单独绘制。
          alpha = 1;
        }

        if (anim !== null && anim.move.from.x === x && anim.move.from.y === y) {
          // 起点在动画中已搬走，不再重复绘制。
          continue;
        }

        this.drawPiece(ctx, g, piece, px, py, alpha);
      }
    }
  }

  private drawPiece(
    ctx: CanvasRenderingContext2D,
    g: BoardGeometry,
    piece: number,
    cx: number,
    cy: number,
    alpha: number,
  ): void {
    const image = this.images.get(piece);
    const size = g.pieceSize;
    if (image === null) {
      // 贴图缺失时的矢量兜底：保证功能不中断。
      const red = Piece.isRed(piece);
      ctx.beginPath();
      ctx.arc(cx, cy, size / 2, 0, Math.PI * 2);
      ctx.fillStyle = '#f7e6c4';
      ctx.fill();
      ctx.lineWidth = Math.max(1, size * 0.06);
      ctx.strokeStyle = red ? '#c0392b' : '#2c3e50';
      ctx.stroke();
      const name = Piece.toChineseName(piece);
      if (name !== null) {
        ctx.fillStyle = red ? '#c0392b' : '#2c3e50';
        ctx.font = `${Math.round(size * 0.5)}px "KaiTi", "STKaiti", serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(name, cx, cy);
      }

      return;
    }

    ctx.globalAlpha = alpha;
    ctx.drawImage(image, cx - size / 2, cy - size / 2, size, size);
    ctx.globalAlpha = 1;
  }

  private drawSelection(
    ctx: CanvasRenderingContext2D,
    g: BoardGeometry,
    pos: Position,
    piece: number,
  ): void {
    const c = cellCenter(g, pos.x, pos.y);
    ctx.strokeStyle = Piece.isRed(piece) ? '#e24b4a' : '#1d9e75';
    ctx.lineWidth = Math.max(2, g.cell * 0.06);
    const half = g.pieceSize / 2 + g.cell * 0.06;
    ctx.strokeRect(c.x - half, c.y - half, half * 2, half * 2);
  }

  private drawTarget(
    ctx: CanvasRenderingContext2D,
    g: BoardGeometry,
    pos: Position,
    piece: number,
  ): void {
    const c = cellCenter(g, pos.x, pos.y);
    const occupied = Piece.isValid(piece);
    const radius = g.cell * (occupied ? 0.42 : 0.16);
    ctx.beginPath();
    ctx.arc(c.x, c.y, radius, 0, Math.PI * 2);
    if (occupied) {
      ctx.strokeStyle = '#e24b4a';
      ctx.lineWidth = Math.max(2, g.cell * 0.05);
      ctx.stroke();
    } else {
      ctx.fillStyle = 'rgba(29, 158, 117, 0.75)';
      ctx.fill();
    }
  }

  private drawHint(ctx: CanvasRenderingContext2D, g: BoardGeometry, move: Move): void {
    ctx.strokeStyle = '#378add';
    ctx.lineWidth = Math.max(2, g.cell * 0.05);
    for (const pos of [move.from, move.to]) {
      const c = cellCenter(g, pos.x, pos.y);
      const half = g.pieceSize / 2 + g.cell * 0.05;
      ctx.strokeRect(c.x - half, c.y - half, half * 2, half * 2);
    }
  }

  private drawLastMoveMarkers(ctx: CanvasRenderingContext2D, g: BoardGeometry, move: Move): void {
    ctx.strokeStyle = 'rgba(186, 117, 23, 0.9)';
    ctx.lineWidth = Math.max(2, g.cell * 0.04);
    for (const pos of [move.from, move.to]) {
      const c = cellCenter(g, pos.x, pos.y);
      const half = g.pieceSize / 2;
      // 四角标记（与常见棋软的「上一手」提示一致）
      const len = g.cell * 0.2;
      for (const [sx, sy] of [
        [-1, -1],
        [1, -1],
        [-1, 1],
        [1, 1],
      ]) {
        ctx.beginPath();
        ctx.moveTo(c.x + sx * half, c.y + sy * half - sy * len);
        ctx.lineTo(c.x + sx * half, c.y + sy * half);
        ctx.lineTo(c.x + sx * half - sx * len, c.y + sy * half);
        ctx.stroke();
      }
    }
  }

  private drawCheckMarker(ctx: CanvasRenderingContext2D, g: BoardGeometry, pos: Position): void {
    const c = cellCenter(g, pos.x, pos.y);
    ctx.beginPath();
    ctx.arc(c.x, c.y, g.pieceSize * 0.62, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(226, 75, 74, 0.35)';
    ctx.fill();
  }

  /** 建议箭头（几何算法移植自原 ArrowLayer.BuildPolygon）。 */
  private drawArrow(
    ctx: CanvasRenderingContext2D,
    g: BoardGeometry,
    from: Position,
    to: Position,
    rank: number,
  ): void {
    const a = cellCenter(g, from.x, from.y);
    const b = cellCenter(g, to.x, to.y);
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    if (len < 1) {
      return;
    }

    const headLength = Math.min(g.cell * 0.6, len * 0.5);
    const headHalf = g.cell * 0.16;
    const tailHalf = g.cell * 0.06;
    const angle = Math.atan2(dy, dx);
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);

    const local: [number, number][] = [
      [0, -tailHalf],
      [len - headLength, -tailHalf],
      [len - headLength, -headHalf],
      [len, 0],
      [len - headLength, headHalf],
      [len - headLength, tailHalf],
      [0, tailHalf],
    ];

    ctx.beginPath();
    local.forEach(([lx, ly], index) => {
      const x = a.x + lx * cos - ly * sin;
      const y = a.y + lx * sin + ly * cos;
      if (index === 0) {
        ctx.moveTo(x, y);
      } else {
        ctx.lineTo(x, y);
      }
    });
    ctx.closePath();

    const colors = ['rgba(226,75,74,0.75)', 'rgba(55,138,221,0.6)', 'rgba(29,158,117,0.55)', 'rgba(186,117,23,0.5)', 'rgba(127,119,221,0.45)'];
    ctx.fillStyle = colors[Math.min(rank, colors.length - 1)];
    ctx.fill();

    // 排名角标
    ctx.fillStyle = '#ffffff';
    ctx.font = `${Math.round(g.cell * 0.26)}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(`${rank + 1}`, a.x + dx * 0.12, a.y + dy * 0.12);
  }
}
