import { CancellationToken } from '../cancellation.js';
import {
  EngineOptions,
  EngineSession,
  GoParams,
  MultiPvInfo,
  SearchResult,
} from '../engine/engineTypes.js';

/** 测试替身：可挂起搜索、按需发射 info、可控地返回 bestmove。 */
export class FakeEngineSession implements EngineSession {
  readonly requests: GoParams[] = [];
  readonly options: EngineOptions[] = [];
  private readonly infoListeners = new Set<(info: MultiPvInfo) => void>();
  private releaseFn: ((bestMove: string | null) => void) | null = null;
  private waiters: (() => void)[] = [];
  private stopCount = 0;

  isReady = true;

  /** 已收到的 stop 次数。 */
  get stopCalled(): number {
    return this.stopCount;
  }

  onInfo(listener: (info: MultiPvInfo) => void): () => void {
    this.infoListeners.add(listener);
    return () => {
      this.infoListeners.delete(listener);
    };
  }

  async start(): Promise<void> {
    this.isReady = true;
  }

  async go(params: GoParams, token?: CancellationToken): Promise<SearchResult> {
    this.requests.push(params);
    this.notifyWaiters();
    return new Promise<SearchResult>((resolve) => {
      this.releaseFn = (bestMove) => resolve({ bestMove, ponderMove: null });
      token?.onCancel(() => {
        this.releaseFn = null;
        resolve({ bestMove: null, ponderMove: null });
      });
    });
  }

  async applyOptions(options: EngineOptions): Promise<void> {
    this.options.push(options);
  }

  stop(): void {
    this.stopCount++;
  }

  async dispose(): Promise<void> {
    this.isReady = false;
  }

  /** 等待引擎收到一次 go 请求。 */
  async waitGoRequestedAsync(): Promise<void> {
    if (this.requests.length > 0) {
      return;
    }

    await new Promise<void>((resolve) => {
      this.waiters.push(resolve);
    });
  }

  /** 发射一条 info（模拟引擎逐层刷新）。 */
  emitInfo(info: MultiPvInfo): void {
    for (const listener of [...this.infoListeners]) {
      listener(info);
    }
  }

  /** 释放挂起的搜索并返回 bestmove。 */
  release(bestMove: string | null = null): void {
    const fn = this.releaseFn;
    this.releaseFn = null;
    fn?.(bestMove);
  }

  private notifyWaiters(): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const waiter of waiters) {
      waiter();
    }
  }
}
