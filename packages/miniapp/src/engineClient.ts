import type {
  CancellationToken,
  EngineOptions,
  EngineSession,
  GoParams,
  MultiPvInfo,
  SearchResult,
} from '@webchess/core';
import type { WorkerRequest, WorkerResponse } from '../../web/src/engine/protocol.js';
import { getWx } from './wx.js';

/** 对联合类型逐个成员做 Omit（与 Web 版 WorkerEngineClient 同约定）。 */
type DistributiveOmit<T, K extends keyof never> = T extends unknown ? Omit<T, K> : never;

/**
 * 微信小程序引擎 Worker 通道的最小结构（wx.createWorker 返回值）。
 * 消息协议与 Web 版完全一致（WorkerRequest / WorkerResponse）。
 */
export interface WxEngineWorker {
  postMessage(message: WorkerRequest): void;
  onMessage(cb: (message: WorkerResponse) => void): void;
  terminate(): void;
}

/**
 * 引擎 Worker 客户端（小程序版）：把 wx Worker 消息通道包装为内核
 * EngineSession 契约。与 Web 版 WorkerEngineClient 同构，仅通道 API 不同
 * （addEventListener/onmessage → onMessage，terminate 同名）。
 */
export class WxWorkerEngineClient implements EngineSession {
  isReady = false;

  private readonly worker: WxEngineWorker;
  private readonly infoListeners = new Set<(info: MultiPvInfo) => void>();
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (reason: Error) => void }
  >();
  private latestRequestId = 0;

  constructor(worker: WxEngineWorker) {
    this.worker = worker;
    this.worker.onMessage((message) => this.handle(message));
  }

  /** 小程序便捷构造：用 wx.createWorker 建立引擎 Worker。 */
  static create(path = 'workers/engine/index.js'): WxWorkerEngineClient {
    const api = getWx();
    if (api === null) {
      throw new Error('wx 全局对象不存在：引擎 Worker 只能在微信小程序运行时创建');
    }

    return new WxWorkerEngineClient(api.createWorker(path) as unknown as WxEngineWorker);
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
