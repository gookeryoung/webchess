import { Board } from '../board.js';
import { FenFormatException } from '../fen.js';
import { Move } from '../move.js';
import { ManualDocument, ManualFormatException, MoveNode } from './manualDocument.js';

/**
 * PGN（ICCS 坐标记谱）解析器：解析 [Tag] 标签与着法序列构建棋谱树；
 * 检测到中文记谱着法时明确报「暂不支持中文记谱 PGN」，其余非法着法按格式错误处理。
 *
 * 移植说明：原 C# 使用 `[GeneratedRegex]` 源生成器（编译期生成正则）。
 * TypeScript 无此机制，改为模块级 `RegExp` 常量——语义等价，且浏览器与小程序均支持。
 */
export class PgnParser {
  /** 花括号评注（可能跨行，解析着法前整体剔除）。 */
  private static readonly CommentPattern = /\{[^}]*\}/gs;

  /** ICCS 坐标着法：4 字符 [a-i][0-9][a-i][0-9]。 */
  private static readonly IccsPattern = /^[a-i][0-9][a-i][0-9]$/;

  /** 回合号 token（如 "1."、"12..."）。 */
  private static readonly MoveNumberPattern = /^\d+\.*$/;

  private static readonly ResultTokens: readonly string[] = ['1-0', '0-1', '1/2-1/2', '*'];

  /** 解析 PGN 文本；FEN 非法或着法不受支持抛 ManualFormatException。 */
  static parse(text: string): ManualDocument {
    const { tags, movesSection } = PgnParser.splitTagsAndMoves(text);

    const doc = new ManualDocument(PgnParser.resolveInitialBoard(tags));
    doc.event = tags['Event'] ?? '';
    doc.date = tags['Date'] ?? '';
    doc.site = tags['Site'] ?? '';
    doc.red = tags['Red'] ?? '';
    doc.black = tags['Black'] ?? '';
    doc.result = tags['Result'] ?? '';

    let node: MoveNode = doc.root;
    for (const token of PgnParser.tokenizeMoves(movesSection)) {
      const move = Move.fromUcci(token);
      if (move === null) {
        const isAscii = /^[\x20-\x7F]$/.test(token[0]);
        throw new ManualFormatException(
          isAscii
            ? `不支持的 PGN 着法「${token}」（仅支持 ICCS 坐标记谱）`
            : `暂不支持中文记谱 PGN（检测到非 ICCS 着法「${token}」）`,
        );
      }

      node = MoveNode.append(move, node);
    }

    return doc;
  }

  /** 分离 [Tag "value"] 标签区与其余着法文本。 */
  private static splitTagsAndMoves(text: string): {
    tags: Record<string, string>;
    movesSection: string;
  } {
    const tags: Record<string, string> = {};
    const moves: string[] = [];
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.startsWith('[') && trimmed.endsWith(']') && trimmed.includes('"')) {
        const tag = PgnParser.parseTagLine(trimmed);
        if (tag !== null) {
          tags[tag.key] = tag.value;
          continue;
        }
      }

      moves.push(line);
    }

    return { tags, movesSection: moves.join('\n') };
  }

  /** 解析单行标签；格式不符返回 null（该行归入着法段）。 */
  private static parseTagLine(line: string): { key: string; value: string } | null {
    const open = line.indexOf('"');
    const close = line.lastIndexOf('"');
    if (open < 0 || close <= open) {
      return null;
    }

    const key = line.slice(1, open).trim();
    return key.length === 0 ? null : { key, value: line.slice(open + 1, close) };
  }

  /** 从 FEN 标签构造初始局面；无标签用标准起始局面，FEN 非法抛 ManualFormatException。 */
  private static resolveInitialBoard(tags: Record<string, string>): Board {
    const fen = tags['FEN'] ?? '';
    if (fen.length === 0) {
      return new Board();
    }

    try {
      return Board.fromFen(fen);
    } catch (error) {
      if (error instanceof FenFormatException) {
        throw new ManualFormatException(`PGN FEN 标签非法：${error.message}`);
      }

      throw error;
    }
  }

  /** 剔除花括号评注后按空白切分着法 token，过滤回合号与结果标记。 */
  private static tokenizeMoves(movesSection: string): string[] {
    const cleaned = movesSection.replace(PgnParser.CommentPattern, ' ');
    const tokens: string[] = [];
    for (const token of cleaned.split(/[\s]+/)) {
      if (token.length === 0) {
        continue;
      }

      if (PgnParser.MoveNumberPattern.test(token) || PgnParser.ResultTokens.includes(token)) {
        continue;
      }

      tokens.push(token);
    }

    return tokens;
  }

  /** 供外部预判单 token 是否为 ICCS 着法（UI 高亮与错误提示用）。 */
  static isIccsMove(token: string): boolean {
    return PgnParser.IccsPattern.test(token);
  }
}
