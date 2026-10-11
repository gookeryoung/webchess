import { BOARD_HEIGHT, BOARD_WIDTH } from './constants.js';
import { Board } from './board.js';
import { Move } from './move.js';
import { Piece } from './piece.js';
import { Position } from './position.js';

/**
 * 走法生成与终局判定（移植自参考项目 Rule.java 的偏移表算法）：
 * 偏移表走法生成（含蹩马腿/塞象眼/过河兵/九宫限制/飞将），
 * 合法着 = 伪合法着过滤「走后被将军」与「走后将帅照脸」。
 */
export class Rule {
  /** 区域编号：0 棋盘外、1 黑方半场、2 黑方九宫、3 红方半场、4 红方九宫。 */
  private static readonly Area: readonly number[][] = [
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

  /**
   * 偏移表行号：0 帅将、1 仕士、2 相象、3 象眼、4 马、5 马腿、
   * 6 未过河卒、7 过河卒、8 未过河兵、9 过河兵、10 反向马腿（将帅受攻检测用）。
   */
  private static readonly OffsetX: readonly number[][] = [
    [0, 0, 1, -1],
    [1, 1, -1, -1],
    [2, 2, -2, -2],
    [1, 1, -1, -1],
    [1, 1, -1, -1, 2, 2, -2, -2],
    [0, 0, 0, 0, 1, 1, -1, -1],
    [0],
    [-1, 0, 1],
    [0],
    [-1, 0, 1],
    [1, 1, -1, -1, 1, 1, -1, -1],
  ];

  private static readonly OffsetY: readonly number[][] = [
    [1, -1, 0, 0],
    [1, -1, 1, -1],
    [2, -2, 2, -2],
    [1, -1, 1, -1],
    [2, -2, 2, -2, 1, -1, 1, -1],
    [1, -1, 1, -1, 0, 0, 0, 0],
    [1],
    [0, 1, 0],
    [-1],
    [0, -1, 0],
    [1, -1, 1, -1, 1, -1, 1, -1],
  ];

  /**
   * 生成指定坐标棋子的全部合法走法（过滤走后被将军与将帅照脸）。
   * 起点无子时返回空列表。
   */
  static getLegalMoves(board: Board, from: Position): Move[] {
    const moves: Move[] = [];
    const piece = board.getPieceAt(from);
    if (!Piece.isValid(piece)) {
      return moves;
    }

    const red = Piece.isRed(piece);
    for (const to of Rule.getPseudoTargets(board, piece, from.x, from.y)) {
      if (!Rule.leavesOwnKingUnsafe(board, from, to, piece, red)) {
        moves.push(new Move(from, to));
      }
    }

    return moves;
  }

  /** 生成指定走子方（redSide）的全部合法走法。 */
  static getAllLegalMoves(board: Board, redSide: boolean): Move[] {
    const moves: Move[] = [];
    for (let y = 0; y < BOARD_HEIGHT; y++) {
      for (let x = 0; x < BOARD_WIDTH; x++) {
        const piece = board.getPiece(x, y);
        if (Piece.isValid(piece) && Piece.isRed(piece) === redSide) {
          moves.push(...Rule.getLegalMoves(board, new Position(x, y)));
        }
      }
    }

    return moves;
  }

  /** 检查一步走法是否合法（起点有子且终点在合法走法集合内）。 */
  static isLegalMove(board: Board, move: Move): boolean {
    if (!Piece.isValid(board.getPieceAt(move.from))) {
      return false;
    }

    return Rule.getLegalMoves(board, move.from).some((m) => m.equals(move));
  }

  /** 指定方将/帅当前是否被攻击（不含将帅照脸，照脸由 isKingsFacing 判定）。 */
  static isInCheck(board: Board, redSide: boolean): boolean {
    const kingPos = board.findKing(redSide);
    return kingPos !== null && Rule.isKingInDanger(board, kingPos, redSide);
  }

  /** 指定方是否被将死（被将军且无合法着法）。 */
  static isCheckmate(board: Board, redSide: boolean): boolean {
    return Rule.isInCheck(board, redSide) && Rule.getAllLegalMoves(board, redSide).length === 0;
  }

  /** 指定方是否被困毙（未被将军但无合法着法）。 */
  static isStalemate(board: Board, redSide: boolean): boolean {
    return !Rule.isInCheck(board, redSide) && Rule.getAllLegalMoves(board, redSide).length === 0;
  }

  /** 将帅是否在同一纵线直接照面（中间无子，白脸将）。 */
  static isKingsFacing(board: Board): boolean {
    const redKing = board.findKing(true);
    const blackKing = board.findKing(false);
    if (redKing === null || blackKing === null || redKing.x !== blackKing.x) {
      return false;
    }

    const top = Math.min(redKing.y, blackKing.y);
    const bottom = Math.max(redKing.y, blackKing.y);
    for (let y = top + 1; y < bottom; y++) {
      if (board.getPiece(redKing.x, y) !== Piece.Empty) {
        return false;
      }
    }

    return true;
  }

  /** 模拟走子后己方将帅是否不安全（被将军或将帅照脸）。 */
  private static leavesOwnKingUnsafe(
    board: Board,
    from: Position,
    to: Position,
    piece: number,
    red: boolean,
  ): boolean {
    // 在克隆局面上做「走子-还原」，避免每次模拟整盘深拷贝。
    const sim = board.clone();
    const captured = sim.getPieceAt(to);
    sim.setPiece(from.x, from.y, Piece.Empty);
    sim.setPiece(to.x, to.y, piece);

    const target = red ? sim.findKing(true) : sim.findKing(false);
    const unsafeAfterMove =
      Rule.isKingsFacing(sim) || (target !== null && Rule.isKingInDanger(sim, target, red));

    sim.setPiece(to.x, to.y, captured);
    sim.setPiece(from.x, from.y, piece);
    return unsafeAfterMove;
  }

  /**
   * 生成棋子从 (fromX, fromY) 出发的全部伪合法落点（移植 PossibleToPositions）。
   * 含蹩马腿/塞象眼/九宫/半场限制/飞将过滤，不含「走后被将军」过滤。
   */
  private static getPseudoTargets(
    board: Board,
    piece: number,
    fromX: number,
    fromY: number,
  ): Position[] {
    const targets: Position[] = [];
    switch (piece) {
      case Piece.BlackKing:
      case Piece.RedKing:
        Rule.addOffsetTargets(piece, fromX, fromY, board, 0, targets, true);
        break;

      case Piece.BlackAdvisor:
      case Piece.RedAdvisor:
        Rule.addOffsetTargets(piece, fromX, fromY, board, 1, targets, true);
        break;

      case Piece.BlackBishop:
      case Piece.RedBishop: {
        // 走田字且塞象眼，目标须留在己方半场（黑 1-2、红 3-4）。
        const selfRed = Piece.isRed(piece);
        for (let i = 0; i < 4; i++) {
          const toX = fromX + Rule.OffsetX[2][i];
          const toY = fromY + Rule.OffsetY[2][i];
          const area = Rule.inArea(toX, toY);
          if (
            area !== 0 &&
            area >= (selfRed ? 3 : 1) &&
            area <= (selfRed ? 4 : 2) &&
            !Piece.isSameSide(piece, board.getPiece(toX, toY)) &&
            board.getPiece(fromX + Rule.OffsetX[3][i], fromY + Rule.OffsetY[3][i]) === Piece.Empty
          ) {
            targets.push(new Position(toX, toY));
          }
        }

        break;
      }

      case Piece.BlackKnight:
      case Piece.RedKnight: {
        // 走日字且蹩马腿。
        for (let i = 0; i < 8; i++) {
          const toX = fromX + Rule.OffsetX[4][i];
          const toY = fromY + Rule.OffsetY[4][i];
          if (
            Rule.inArea(toX, toY) !== 0 &&
            !Piece.isSameSide(piece, board.getPiece(toX, toY)) &&
            board.getPiece(fromX + Rule.OffsetX[5][i], fromY + Rule.OffsetY[5][i]) === Piece.Empty
          ) {
            targets.push(new Position(toX, toY));
          }
        }

        break;
      }

      case Piece.BlackRook:
      case Piece.RedRook:
        Rule.addRayTargets(piece, fromX, fromY, board, false, targets);
        break;

      case Piece.BlackCannon:
      case Piece.RedCannon:
        Rule.addRayTargets(piece, fromX, fromY, board, true, targets);
        break;

      case Piece.BlackPawn:
      case Piece.RedPawn: {
        const selfRed = Piece.isRed(piece);
        // 未过河（红 area 3 / 黑 area 1）只能前进；过河后可前进与左右平移。
        const crossed = Rule.inArea(fromX, fromY) !== (selfRed ? 3 : 1);
        const num = selfRed ? (crossed ? 9 : 8) : crossed ? 7 : 6;
        for (let i = 0; i < Rule.OffsetX[num].length; i++) {
          const toX = fromX + Rule.OffsetX[num][i];
          const toY = fromY + Rule.OffsetY[num][i];
          if (
            Rule.inArea(toX, toY) !== 0 &&
            !Piece.isSameSide(piece, board.getPiece(toX, toY))
          ) {
            targets.push(new Position(toX, toY));
          }
        }

        break;
      }

      default:
        break;
    }

    return targets;
  }

  /** 按偏移表生成落点；palaceOnly 为真时落点须在本方九宫内，帅另需过滤飞将。 */
  private static addOffsetTargets(
    piece: number,
    fromX: number,
    fromY: number,
    board: Board,
    num: number,
    targets: Position[],
    palaceOnly: boolean,
  ): void {
    const red = Piece.isRed(piece);
    const palaceArea = red ? 4 : 2;
    for (let i = 0; i < Rule.OffsetX[num].length; i++) {
      const toX = fromX + Rule.OffsetX[num][i];
      const toY = fromY + Rule.OffsetY[num][i];
      const area = Rule.inArea(toX, toY);
      if (
        area === 0 ||
        (palaceOnly && area !== palaceArea) ||
        Piece.isSameSide(piece, board.getPiece(toX, toY))
      ) {
        continue;
      }

      // 帅将落点不得与对方将帅直接照面（飞将过滤）。
      if (num === 0 && Rule.flyKingTarget(piece, toX, toY, board) !== null) {
        continue;
      }

      targets.push(new Position(toX, toY));
    }
  }

  /** 车炮沿四个方向生成落点：车遇子可吃后止；炮空移无遮挡、吃子须恰一炮架。 */
  private static addRayTargets(
    piece: number,
    fromX: number,
    fromY: number,
    board: Board,
    cannon: boolean,
    targets: Position[],
  ): void {
    const directions: readonly (readonly [number, number])[] = [
      [0, 1],
      [0, -1],
      [-1, 0],
      [1, 0],
    ];
    for (const [dx, dy] of directions) {
      let x = fromX + dx;
      let y = fromY + dy;
      let screenCount = 0;
      while (Rule.inArea(x, y) !== 0) {
        const target = board.getPiece(x, y);
        if (screenCount === 0) {
          if (target === Piece.Empty) {
            targets.push(new Position(x, y));
          } else {
            screenCount = 1;
            // 车：遇到的第一个子即可吃并停止；炮：该子成为炮架，继续扫描。
            if (!cannon) {
              if (!Piece.isSameSide(piece, target)) {
                targets.push(new Position(x, y));
              }

              break;
            }
          }
        } else if (cannon) {
          if (target !== Piece.Empty) {
            // 炮吃子：越过恰一个炮架后的第一个子。
            if (!Piece.isSameSide(piece, target)) {
              targets.push(new Position(x, y));
            }

            break;
          }
        }

        x += dx;
        y += dy;
      }
    }
  }

  /** 将/帅位于 (x, y) 时沿纵向是否与对方将帅直接照面；照面返回对方将帅位置。 */
  private static flyKingTarget(
    piece: number,
    x: number,
    y: number,
    board: Board,
  ): Position | null {
    const red = Piece.isRed(piece);
    const step = red ? -1 : 1;
    for (let i = y + step; i >= 0 && i < BOARD_HEIGHT; i += step) {
      const target = board.getPiece(x, i);
      if (target !== Piece.Empty) {
        return target === (red ? Piece.BlackKing : Piece.RedKing) ? new Position(x, i) : null;
      }
    }

    return null;
  }

  /** 指定方将帅是否被对方攻击（马/车/炮/卒兵四类，移植 isJiangShuaiInDanger）。 */
  private static isKingInDanger(board: Board, kingPos: Position, red: boolean): boolean {
    const x = kingPos.x;
    const y = kingPos.y;

    // 被对方马攻击（反向蹩马腿：以将帅为中心检查马腿位置）。
    const attackerKnight = red ? Piece.BlackKnight : Piece.RedKnight;
    for (let i = 0; i < 8; i++) {
      const toX = x + Rule.OffsetX[4][i];
      const toY = y + Rule.OffsetY[4][i];
      const blockX = x + Rule.OffsetX[10][i];
      const blockY = y + Rule.OffsetY[10][i];
      if (
        Rule.inArea(toX, toY) !== 0 &&
        board.getPiece(toX, toY) === attackerKnight &&
        board.getPiece(blockX, blockY) === Piece.Empty
      ) {
        return true;
      }
    }

    // 被对方车攻击。
    if (Rule.attackableByRookOrCannon(board, x, y, red ? Piece.BlackRook : Piece.RedRook)) {
      return true;
    }

    // 被对方炮攻击。
    if (Rule.attackableByRookOrCannon(board, x, y, red ? Piece.BlackCannon : Piece.RedCannon)) {
      return true;
    }

    // 被对方卒/兵攻击：横向两侧或正前方一格。
    const attackerPawn = red ? Piece.BlackPawn : Piece.RedPawn;
    const forward = red ? -1 : 1;
    return (
      board.getPiece(x - 1, y) === attackerPawn ||
      board.getPiece(x + 1, y) === attackerPawn ||
      board.getPiece(x, y + forward) === attackerPawn
    );
  }

  /**
   * (x, y) 是否被指定车/炮攻击：以「被攻击方颜色」的同类棋子生成 (x, y) 处的伪合法落点
   * （车炮走法双方对称，仅同侧判定依赖颜色），若任一落点上恰为该攻击者则处于其攻击范围。
   * 与参考项目 attackableByJuPao 语义一致：将帅留在原位参与同侧判定，攻击者因异色总可被"吃"。
   */
  private static attackableByRookOrCannon(
    board: Board,
    x: number,
    y: number,
    attacker: number,
  ): boolean {
    let probe: number;
    switch (attacker) {
      case Piece.BlackRook:
        probe = Piece.RedRook;
        break;
      case Piece.RedRook:
        probe = Piece.BlackRook;
        break;
      case Piece.BlackCannon:
        probe = Piece.RedCannon;
        break;
      default:
        probe = Piece.BlackCannon;
        break;
    }

    return Rule.getPseudoTargets(board, probe, x, y).some(
      (pos) => board.getPiece(pos.x, pos.y) === attacker,
    );
  }

  /** 查询 (x, y) 的区域编号（越界返回 0）。 */
  private static inArea(x: number, y: number): number {
    return x >= 0 && x < BOARD_WIDTH && y >= 0 && y < BOARD_HEIGHT ? Rule.Area[y][x] : 0;
  }
}
