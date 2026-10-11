import type { EngineOptions, GoParams, MultiPvInfo, SearchResult } from '@webchess/core';

/**
 * 主线程 ↔ 引擎 Worker 的消息协议。
 *
 * 引擎跑在 Web Worker 中，避免 alpha-beta 搜索阻塞 UI。
 * 小程序端可换用 Worker 或分片在主线程执行，协议不变。
 */

export type WorkerRequest =
  | { id: number; type: 'go'; params: GoParams }
  | { id: number; type: 'options'; options: EngineOptions }
  | { id: number; type: 'stop' }
  | { id: number; type: 'ping' };

export type WorkerResponse =
  | { id: number; type: 'info'; info: MultiPvInfo }
  | { id: number; type: 'result'; result: SearchResult }
  | { id: number; type: 'ack' }
  | { id: number; type: 'error'; message: string };

/** Worker 全局对象的最小类型（避免引入 WebWorker lib 与 DOM 冲突）。 */
export interface WorkerScopeLike {
  postMessage(message: WorkerResponse): void;
  addEventListener(
    type: 'message',
    listener: (event: { data: WorkerRequest }) => void,
  ): void;
}

export function asWorkerScope(): WorkerScopeLike {
  return globalThis as unknown as WorkerScopeLike;
}
