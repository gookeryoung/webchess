/**
 * 棋子类型常量与判定（编码沿用参考项目 Piece.java）：
 * 0=空，1-7 红方（帅仕相马车炮兵），8-14 黑方（将士象马车炮卒）。
 */
export class Piece {
  static readonly Empty = 0;

  static readonly RedKing = 1; // K, 帅
  static readonly RedAdvisor = 2; // A, 仕
  static readonly RedBishop = 3; // B, 相
  static readonly RedKnight = 4; // N, 马
  static readonly RedRook = 5; // R, 车
  static readonly RedCannon = 6; // C, 炮
  static readonly RedPawn = 7; // P, 兵

  static readonly BlackKing = 8; // k, 将
  static readonly BlackAdvisor = 9; // a, 士
  static readonly BlackBishop = 10; // b, 象
  static readonly BlackKnight = 11; // n, 马
  static readonly BlackRook = 12; // r, 车
  static readonly BlackCannon = 13; // c, 炮
  static readonly BlackPawn = 14; // p, 卒

  /** 是否为有效棋子（非空且在 1-14 范围内）。 */
  static isValid(piece: number): boolean {
    return piece >= Piece.RedKing && piece <= Piece.BlackPawn;
  }

  /** 是否为红方棋子（对 Empty 返回值无意义，调用方须先验证 isValid）。 */
  static isRed(piece: number): boolean {
    return piece >= Piece.RedKing && piece <= Piece.RedPawn;
  }

  /** 是否为黑方棋子（对 Empty 返回值无意义，调用方须先验证 isValid）。 */
  static isBlack(piece: number): boolean {
    return piece >= Piece.BlackKing && piece <= Piece.BlackPawn;
  }

  /** 两枚棋子是否同方（空子视为不同方）。 */
  static isSameSide(a: number, b: number): boolean {
    return Piece.isValid(a) && Piece.isValid(b) && Piece.isRed(a) === Piece.isRed(b);
  }

  /** 是否为走斜线的棋子（马、相/象、仕/士），记谱时第二数字为目标纵线。 */
  static isDiagonalPiece(piece: number): boolean {
    return (
      piece === Piece.RedKnight ||
      piece === Piece.BlackKnight ||
      piece === Piece.RedBishop ||
      piece === Piece.BlackBishop ||
      piece === Piece.RedAdvisor ||
      piece === Piece.BlackAdvisor
    );
  }

  /** FEN 字符（红大写、黑小写）；非法值返回 null。 */
  static toFenChar(piece: number): string | null {
    switch (piece) {
      case Piece.RedKing: return 'K';
      case Piece.RedAdvisor: return 'A';
      case Piece.RedBishop: return 'B';
      case Piece.RedKnight: return 'N';
      case Piece.RedRook: return 'R';
      case Piece.RedCannon: return 'C';
      case Piece.RedPawn: return 'P';
      case Piece.BlackKing: return 'k';
      case Piece.BlackAdvisor: return 'a';
      case Piece.BlackBishop: return 'b';
      case Piece.BlackKnight: return 'n';
      case Piece.BlackRook: return 'r';
      case Piece.BlackCannon: return 'c';
      case Piece.BlackPawn: return 'p';
      default: return null;
    }
  }

  /** 由 FEN 字符解析棋子；非法字符返回 null。 */
  static fromFenChar(c: string): number | null {
    switch (c) {
      case 'K': return Piece.RedKing;
      case 'A': return Piece.RedAdvisor;
      case 'B': return Piece.RedBishop;
      case 'N': return Piece.RedKnight;
      case 'R': return Piece.RedRook;
      case 'C': return Piece.RedCannon;
      case 'P': return Piece.RedPawn;
      case 'k': return Piece.BlackKing;
      case 'a': return Piece.BlackAdvisor;
      case 'b': return Piece.BlackBishop;
      case 'n': return Piece.BlackKnight;
      case 'r': return Piece.BlackRook;
      case 'c': return Piece.BlackCannon;
      case 'p': return Piece.BlackPawn;
      default: return null;
    }
  }

  /** 中文棋子名（红：帅仕相马车炮兵；黑：将士象马车炮卒）；非法值返回 null。 */
  static toChineseName(piece: number): string | null {
    switch (piece) {
      case Piece.RedKing: return '帅';
      case Piece.RedAdvisor: return '仕';
      case Piece.RedBishop: return '相';
      case Piece.RedKnight: return '马';
      case Piece.RedRook: return '车';
      case Piece.RedCannon: return '炮';
      case Piece.RedPawn: return '兵';
      case Piece.BlackKing: return '将';
      case Piece.BlackAdvisor: return '士';
      case Piece.BlackBishop: return '象';
      case Piece.BlackKnight: return '马';
      case Piece.BlackRook: return '车';
      case Piece.BlackCannon: return '炮';
      case Piece.BlackPawn: return '卒';
      default: return null;
    }
  }
}
