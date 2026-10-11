/**
 * 残局练习进度模型（零平台依赖）：按题目 Id 记录完成标记与尝试计数。
 *
 * 原 C# 实现由 Main 层用 Godot FileAccess 读写 `user://puzzle_progress.json`；
 * Web 版改为由适配层注入的 IStorage 读写（localStorage / wx.setStorageSync），
 * 本类只负责内存态与 JSON 契约，不碰任何存储 API。
 */
interface ProgressEntry {
  readonly Solved: boolean;
  readonly Attempts: number;
  readonly LastDate: string;
}

/** 当日日期字符串（yyyy-MM-dd，本地时间，与原 C# DateTime.Now 语义一致）。 */
function today(): string {
  const now = new Date();
  const month = `${now.getMonth() + 1}`.padStart(2, '0');
  const day = `${now.getDate()}`.padStart(2, '0');
  return `${now.getFullYear()}-${month}-${day}`;
}

export class PuzzleProgress {
  private readonly entries: Map<string, ProgressEntry>;

  constructor(entries?: Map<string, ProgressEntry>) {
    this.entries = entries ?? new Map();
  }

  /** 已过关的题目 Id 集合。 */
  get solvedIds(): readonly string[] {
    return [...this.entries.entries()].filter(([, e]) => e.Solved).map(([id]) => id);
  }

  /** 已过关的题目数。 */
  get solvedCount(): number {
    return [...this.entries.values()].filter((e) => e.Solved).length;
  }

  /** 题目是否已过关。 */
  isSolved(puzzleId: string): boolean {
    return this.entries.get(puzzleId)?.Solved ?? false;
  }

  /** 题目累计尝试次数（未挑战过为 0）。 */
  attempts(puzzleId: string): number {
    return this.entries.get(puzzleId)?.Attempts ?? 0;
  }

  /** 记录一次挑战（打开题目时调用，计数 +1）。 */
  markAttempt(puzzleId: string): void {
    this.bump(puzzleId, null);
  }

  /** 标记过关（幂等：重复过关仅刷新日期，不重复计数）。 */
  markSolved(puzzleId: string): void {
    this.bump(puzzleId, true);
  }

  /** 序列化为 JSON（供适配层写入存储）。 */
  toJson(): string {
    return JSON.stringify(Object.fromEntries(this.entries));
  }

  /**
   * 从 JSON 反序列化；输入为空或非法时返回空进度（进度文件损坏不阻塞启动）。
   */
  static fromJson(json: string | null | undefined): PuzzleProgress {
    if (json === null || json === undefined || json.trim().length === 0) {
      return new PuzzleProgress();
    }

    try {
      const parsed: unknown = JSON.parse(json);
      if (parsed === null || typeof parsed !== 'object') {
        return new PuzzleProgress();
      }

      const entries = new Map<string, ProgressEntry>();
      for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (value === null || typeof value !== 'object') {
          continue;
        }

        const raw = value as Record<string, unknown>;
        entries.set(id, {
          Solved: raw['Solved'] === true,
          Attempts: typeof raw['Attempts'] === 'number' ? raw['Attempts'] : 0,
          LastDate: typeof raw['LastDate'] === 'string' ? raw['LastDate'] : '',
        });
      }

      return new PuzzleProgress(entries);
    } catch {
      return new PuzzleProgress();
    }
  }

  /** 更新条目：solved 仅在 true 时置位（null 表示不动）；日期取当日。 */
  private bump(puzzleId: string, solved: boolean | null): void {
    const existing = this.entries.get(puzzleId);
    const isSolved = solved === true || (existing?.Solved ?? false);
    const attempts = (existing?.Attempts ?? 0) + (solved === null ? 1 : 0);
    this.entries.set(puzzleId, { Solved: isSolved, Attempts: attempts, LastDate: today() });
  }
}
