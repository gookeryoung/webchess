import type {
  CancellationToken,
  EngineOptions,
  EngineSession,
  GoParams,
  MultiPvInfo,
  SearchResult,
} from '@webchess/core';
import { WorkerRequest, WorkerResponse } from './protocol.js';

/** 对联合类型逐个成员做 Omit（避免 Omit<Union,'id'> 退化成交叉类型）。 */
type DistributiveOmit<T, K extends keyof never> = T extends unknown ? Omit<T, K> : never;

/**
 * 引擎 Worker 客户端：把 postMessage 通道包装为内核的 EngineSession 契约。
 * 上层（GameSession）完全不感知引擎跑在 Worker 还是本地线程。
 */
export class WorkerEngineClient implements EngineSession {
  isReady = false;

  private readonly worker: Worker;
  private readonly infoListeners = new Set<(info: MultiPvInfo) => void>();
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (reason: Error) => void }
  >();
  private latestRequestId = 0;

  constructor() {
    this.worker = new Worker(new URL('./engine.worker.ts', import.meta.url), {
      type: 'module',
      name: 'webchess-engine',
    });
    this.worker.addEventListener('message', (event: MessageEvent<WorkerResponse>) => {
      this.handle(event.data);
    });
  }

  onInfo(listener: (info: MultiPvInfo) => void): () => void {
    this.infoListeners.add(listener);
    return () => {
      this.infoListeners.delete(listener);
    };
  }

  async start(): Promise<void> {
    await this.send({ type: 'ping' });
    this.isReady = true;
  }

  async go(params: GoParams, token?: CancellationToken): Promise<SearchResult> {
    const id = this.nextId++;
    this.latestRequestId = id;
    const promise = this.send({ id, type: 'go', params });

    token?.onCancel(() => {
      this.post({ id, type: 'stop' });
    });

    const outcome = (await promise) as { result?: SearchResult } | null;
    return outcome?.result ?? { bestMove: null, ponderMove: null };
  }

  async applyOptions(options: EngineOptions): Promise<void> {
    await this.send({ type: 'options', options });
  }

  stop(): void {
    this.post({ id: this.latestRequestId, type: 'stop' });
  }

  async dispose(): Promise<void> {
    for (const { reject } of this.pending.values()) {
      reject(new Error('引擎已释放'));
    }

    this.pending.clear();
    this.worker.terminate();
    this.isReady = false;
  }

  private handle(response: WorkerResponse): void {
    switch (response.type) {
      case 'info':
        for (const listener of [...this.infoListeners]) {
          listener(response.info);
        }

        break;
      case 'result':
        this.settle(response.id, { result: response.result });
        break;
      case 'ack':
        this.settle(response.id, null);
        break;
      case 'error':
        this.fail(response.id, new Error(response.message));
        break;
      default:
        break;
    }
  }

  private send(
    request: DistributiveOmit<WorkerRequest, 'id'> & { id?: number },
  ): Promise<unknown> {
    const id = request.id ?? this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.post({ ...request, id } as WorkerRequest);
    });
  }

  private post(request: WorkerRequest): void {
    this.worker.postMessage(request);
  }

  private settle(id: number, value: unknown): void {
    const entry = this.pending.get(id);
    if (entry === undefined) {
      return;
    }

    this.pending.delete(id);
    entry.resolve(value);
  }

  private fail(id: number, error: Error): void {
    const entry = this.pending.get(id);
    if (entry === undefined) {
      return;
    }

    this.pending.delete(id);
    entry.reject(error);
  }
}
