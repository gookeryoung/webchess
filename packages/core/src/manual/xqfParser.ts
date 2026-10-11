import { Board } from '../board.js';
import { decodeGb18030Slice } from '../codec/gb18030.js';
import { Move } from '../move.js';
import { Piece } from '../piece.js';
import { Position } from '../position.js';
import { ManualDocument, ManualFormatException, MoveNode } from './manualDocument.js';
import { XqfKey } from './xqfKey.js';
import { XqfReader } from './xqfReader.js';

/**
 * XQF（象棋桥）解析器：定长头部切片读取 + 高版本解密 + 0x400 起递归读着法树，
 * 移植自参考项目 XQFParser.java（JBBP 头部解析改为直接偏移读取，行为一致）。
 */
export class XqfParser {
  // 头部定长字段偏移（XQF 格式 0x00-0x3FF，着法区自 0x400 起）
  private static readonly OffsetCryptKeys = 0x03; // 13 字节加密参数
  private static readonly OffsetPiecePos = 0x10; // 32 字节棋子布局
  private static readonly OffsetResult = 0x33; // 对局结果字节
  private static readonly OffsetType = 0x40; // 棋谱类型字节
  private static readonly OffsetTitle = 0x50; // 64 字节（首字节为长度）
  private static readonly OffsetEvent = 0xd0; // 64 字节
  private static readonly OffsetDate = 0x110; // 16 字节
  private static readonly OffsetSite = 0x120; // 16 字节
  private static readonly OffsetRed = 0x130; // 16 字节
  private static readonly OffsetBlack = 0x140; // 16 字节
  private static readonly OffsetAnnotator = 0x1d0; // 16 字节
  private static readonly OffsetAuthor = 0x1e0; // 16 字节
  private static readonly OffsetSteps = 0x400;

  // 高版本着法记录第 3 字节标志位
  private static readonly MaskHasNext = 0x80;
  private static readonly MaskHasVar = 0x40;
  private static readonly MaskHasAnnotation = 0x20;
  // 低版本着法记录第 3 字节标志位（高半字节有后续，低半字节有变着）
  private static readonly MaskLowHasNext = 0xf0;
  private static readonly MaskLowHasVar = 0x0f;

  /** XQF 文件最小长度：头部 0x400 + 首条注释记录 4 字节。 */
  private static readonly MinLength = XqfParser.OffsetSteps + 4;

  // 棋子布局顺序：1-16 红方（车马相士帅士相马车炮炮+兵×5），17-32 黑方同序
  private static readonly PieceKinds: readonly number[] = [
    Piece.RedRook, Piece.RedKnight, Piece.RedBishop, Piece.RedAdvisor, Piece.RedKing,
    Piece.RedAdvisor, Piece.RedBishop, Piece.RedKnight, Piece.RedRook,
    Piece.RedCannon, Piece.RedCannon,
    Piece.RedPawn, Piece.RedPawn, Piece.RedPawn, Piece.RedPawn, Piece.RedPawn,
    Piece.BlackRook, Piece.BlackKnight, Piece.BlackBishop, Piece.BlackAdvisor, Piece.BlackKing,
    Piece.BlackAdvisor, Piece.BlackBishop, Piece.BlackKnight, Piece.BlackRook,
    Piece.BlackCannon, Piece.BlackCannon,
    Piece.BlackPawn, Piece.BlackPawn, Piece.BlackPawn, Piece.BlackPawn, Piece.BlackPawn,
  ];

  /** 解析 XQF 字节流；magic 非法或文件过短抛 ManualFormatException。 */
  static parse(data: Uint8Array): ManualDocument {
    if (data.length < XqfParser.MinLength) {
      throw new ManualFormatException('XQF 文件过短，不是有效的棋谱文件');
    }

    if (data[0] !== 0x58 /* 'X' */ || data[1] !== 0x51 /* 'Q' */) {
      throw new ManualFormatException('XQF 文件头标识非法（缺少 XQ magic）');
    }

    const version = data[2];

    // 高版本（>0x0A）启用加密：头部密钥 + 棋子布局 + 着法区三处解密
    const keys =
      version > 0x0a
        ? XqfKey.fromHeader(data.subarray(XqfParser.OffsetCryptKeys, XqfParser.OffsetCryptKeys + 13))
        : null;
    const piecePos = XqfParser.decryptPiecePos(
      data.subarray(XqfParser.OffsetPiecePos, XqfParser.OffsetPiecePos + 32),
      version,
      keys,
    );

    const board = new Board();
    for (let i = 0; i < 32; i++) {
      const value = piecePos[i];
      if (value === 0xff) {
        continue;
      }

      const pos = XqfParser.getPositionFromValue(value);
      board.setPiece(pos.x, pos.y, XqfParser.PieceKinds[i]);
    }

    // 着法区（高版本先流式解密）
    const stepBytes = keys === null ? data.subarray(XqfParser.OffsetSteps) : XqfParser.decodeBuff(keys, data.subarray(XqfParser.OffsetSteps));

    const reader = new XqfReader(stepBytes);
    const gameAnnotation = XqfParser.readAnnotationInfo(reader, version, keys);
    const doc = new ManualDocument(board);
    doc.version = version;
    doc.title = XqfParser.readXqfString(data, XqfParser.OffsetTitle, 64);
    doc.event = XqfParser.readXqfString(data, XqfParser.OffsetEvent, 64);
    doc.date = XqfParser.readXqfString(data, XqfParser.OffsetDate, 16);
    doc.site = XqfParser.readXqfString(data, XqfParser.OffsetSite, 16);
    doc.red = XqfParser.readXqfString(data, XqfParser.OffsetRed, 16);
    doc.black = XqfParser.readXqfString(data, XqfParser.OffsetBlack, 16);
    doc.result = XqfParser.parseResult(data[XqfParser.OffsetResult]);
    doc.category = XqfParser.parseCategory(data[XqfParser.OffsetType]);
    doc.annotator = XqfParser.readXqfString(data, XqfParser.OffsetAnnotator, 16);
    doc.author = XqfParser.readXqfString(data, XqfParser.OffsetAuthor, 16);
    doc.annotation = gameAnnotation;

    XqfParser.readSteps(reader, version, keys, doc.root);
    return doc;
  }

  /** 读取 XQF 头部字符串：首字节为内容长度，其后为 GB18030 文本。 */
  private static readXqfString(data: Uint8Array, offset: number, fieldSize: number): string {
    const length = Math.min(data[offset], fieldSize - 1);
    try {
      // 与原 C# 一致：GB18030 解码后去首尾空白，并剔除尾部 NUL 填充。
      return decodeGb18030Slice(data, offset + 1, length).replace(/\0+$/, '').trim();
    } catch {
      return '';
    }
  }

  /** 读取首条记录携带的整局注释（无着法语义，仅注解标志与长度）。 */
  private static readAnnotationInfo(
    reader: XqfReader,
    version: number,
    keys: XqfKey | null,
  ): string | null {
    const stepInfo = reader.readBytes(4);
    if (stepInfo.length < 4) {
      return null;
    }

    let annoteLen: number;
    if (version <= 0x0a) {
      // 低版本在标志字节后紧跟注释长度，为 0 则无注释
      annoteLen = reader.readInt32();
    } else {
      const flags = stepInfo[2] & 0xe0;
      annoteLen =
        (flags & XqfParser.MaskHasAnnotation) !== 0 ? reader.readInt32() - keys!.keyRmkSize : 0;
    }

    return annoteLen > 0 ? reader.readString(annoteLen) : null;
  }

  /**
   * 递归读取着法记录构建着法树：主线延续挂在当前节点，变着分支回挂到父节点。
   */
  private static readSteps(
    reader: XqfReader,
    version: number,
    keys: XqfKey | null,
    node: MoveNode,
  ): void {
    const stepInfo = reader.readBytes(4);
    if (stepInfo.length < 4) {
      return;
    }

    let annoteLen: number;
    let hasNextStep: boolean;
    let hasVarStep: boolean;
    let moveFrom: number;
    let moveTo: number;
    if (version <= 0x0a) {
      hasNextStep = (stepInfo[2] & XqfParser.MaskLowHasNext) !== 0;
      hasVarStep = (stepInfo[2] & XqfParser.MaskLowHasVar) !== 0;
      annoteLen = reader.readInt32();
      moveFrom = (stepInfo[0] - 0x18) & 0xff;
      moveTo = (stepInfo[1] - 0x20) & 0xff;
    } else {
      const flags = stepInfo[2] & 0xe0;
      hasNextStep = (flags & XqfParser.MaskHasNext) !== 0;
      hasVarStep = (flags & XqfParser.MaskHasVar) !== 0;
      annoteLen =
        (flags & XqfParser.MaskHasAnnotation) !== 0 ? reader.readInt32() - keys!.keyRmkSize : 0;
      moveFrom = ((stepInfo[0] - 0x18) & 0xff) - keys!.keyXYf & 0xff;
      moveTo = ((stepInfo[1] - 0x20) & 0xff) - keys!.keyXYt & 0xff;
    }

    const move = new Move(
      XqfParser.getPositionFromValue(moveFrom),
      XqfParser.getPositionFromValue(moveTo),
    );
    const annotation = annoteLen > 0 ? reader.readString(annoteLen) : null;
    const nextNode = MoveNode.append(move, node, annotation);

    if (hasNextStep) {
      XqfParser.readSteps(reader, version, keys, nextNode);
    }

    if (hasVarStep) {
      XqfParser.readSteps(reader, version, keys, node);
    }
  }

  /**
   * 解密棋子布局：先按版本 ≥12 的乱序规则重排，再逐字节减 keyXY；
   * 无效值（>89）置 0xFF（无子）。
   */
  private static decryptPiecePos(
    manStr: Uint8Array,
    version: number,
    keys: XqfKey | null,
  ): Uint8Array {
    if (keys === null) {
      return Uint8Array.from(manStr);
    }

    const tmpMan = new Uint8Array(32);
    for (let i = 0; i < 32; i++) {
      const target = version >= 12 ? (keys.keyXY + i + 1) & 0x1f : i;
      tmpMan[target] = manStr[i];
    }

    for (let i = 0; i < 32; i++) {
      tmpMan[i] = (tmpMan[i] - keys.keyXY) & 0xff;
      if (tmpMan[i] > 89) {
        tmpMan[i] = 0xff;
      }
    }

    return tmpMan;
  }

  /** 着法区流式解密：逐字节减去钥匙表对应字节（位置自 0x400 起循环取模）。 */
  private static decodeBuff(keys: XqfKey, buff: Uint8Array): Uint8Array {
    const deBuff = Uint8Array.from(buff);
    for (let i = 0; i < buff.length; i++) {
      deBuff[i] = (deBuff[i] - keys.F32Keys[(XqfParser.OffsetSteps + i) % 32]) & 0xff;
    }

    return deBuff;
  }

  /** XQF 坐标 value = X*10 + Y（原点左下）转为左上原点 Position(x, 9-y)。 */
  private static getPositionFromValue(value: number): Position {
    const y = value % 10;
    const x = (value - y) / 10;
    return new Position(x, 9 - y);
  }

  /** 对局结果字节转中文描述：0 未知、1 红胜、2 黑胜、3 平局。 */
  private static parseResult(result: number): string {
    switch (result) {
      case 0x01:
        return '红胜';
      case 0x02:
        return '黑胜';
      case 0x03:
        return '平局';
      default:
        return '未知';
    }
  }

  /** 棋谱类型字节转中文描述：0 全局、1 布局、2 中局、3 残局。 */
  private static parseCategory(type: number): string {
    switch (type) {
      case 0x00:
        return '全局';
      case 0x01:
        return '布局';
      case 0x02:
        return '中局';
      case 0x03:
        return '残局';
      default:
        return '';
    }
  }
}
