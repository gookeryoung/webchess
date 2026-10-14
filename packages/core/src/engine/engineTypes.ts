import { CancellationToken } from '../cancellation.js';

/**
 * 引擎会话抽象（对应原 C# `IUciSession`）。
 *
 * 原实现绑定 Pikafish 独立进程 + UCI 协议；Web / 小程序无法启动子进程，
 * 故此处只保留「请求-响应」契约，具体实现由平台层注入：
 * - Web：内置 TypeScript 引擎（Web Worker 中运行 alpha-beta 搜索）
 * - 未来亦可为远程 UCI 服务，协议层无需改动
 *
 * 本文件零平台依赖，仅描述类型。
 */

/** 引擎搜索请求参数。 */
export interface GoParams {
  /** 6 字段 FEN。 */
  fen: string;
  /** FEN 之后的 UCCI 着法序列。 */
  moves?: readonly string[];
  /** 搜索深度。 */
  depth?: number;
  /** 限时（毫秒）。 */
  moveTimeMs?: number;
  /** 无限搜索（需显式 stop）。 */
  infinite?: boolean;
  /** MultiPV 路数。 */
  multiPv?: number;
  /**
   * 是否允许查开局库（默认 true）。
   * 分析模式（MultiPV > 1）与自对弈强度测量可显式置 false，保证纯搜索结果。
   */
  useBook?: boolean;
}

/** 着法来源：开局库查表命中 / 搜索得出。 */
export type MoveSource = 'book' | 'search';

/** 搜索结果。 */
export interface SearchResult {
  /** UCCI 最佳着法；无结果时为 null。 */
  bestMove: string | null;
  /** UCCI 思考着法（ponder）。 */
  ponderMove: string | null;
  /** 着法来源（未实现标注的引擎可省略）。 */
  source?: MoveSource;
}

/** MultiPV 单路评估信息。 */
export interface MultiPvInfo {
  /** PV 序号（1 起）。 */
  index: number;
  depth: number;
  /** 分值（厘兵）；mate 分数时为 0。 */
  scoreCp: number;
  isMate: boolean;
  /** 上界（UCI upperbound）。 */
  upperBound: boolean;
  /** 下界（UCI lowerbound）。 */
  lowerBound: boolean;
  /** 主变例着法（UCCI）。 */
  pv: readonly string[];
}

/** 引擎强度/资源选项（对应原 C# EngineOptions）。 */
export interface EngineOptions {
  /** 搜索线程数。 */
  threads?: number;
  /** 置换表大小（MB）。 */
  hashMb?: number;
  /** NNUE 权重路径（原生引擎用；内置 TS 引擎忽略）。 */
  evalFile?: string;
  /** 是否限制棋力。 */
  limitStrength?: boolean;
  /** UCI_Elo（1280-3199）。 */
  elo?: number;
  /** Skill Level 弱化等级（0-20）。 */
  skillLevel?: number;
}

/** 引擎会话：内核只依赖此接口，不感知具体引擎实现。 */
export interface EngineSession {
  /** 引擎是否就绪。 */
  readonly isReady: boolean;
  /** 注册 info 回调，返回退订函数。 */
  onInfo(listener: (info: MultiPvInfo) => void): () => void;
  /** 启动引擎（可重复调用，已启动时幂等）。 */
  start(options?: EngineOptions): Promise<void>;
  /** 发起一次搜索。 */
  go(params: GoParams, token?: CancellationToken): Promise<SearchResult>;
  /** 下发选项。 */
  applyOptions(options: EngineOptions): Promise<void>;
  /** 请求停止当前搜索。 */
  stop(): void;
  /** 释放资源。 */
  dispose(): Promise<void>;
}
