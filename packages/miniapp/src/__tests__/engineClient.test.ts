import { INITIAL_FEN } from '@webchess/core';
import { describe, expect, it } from 'vitest';
import { WxWorkerEngineClient } from '../engineClient.js';
import type { WxEngineWorker } from '../engineClient.js';
import type { WorkerRequest, WorkerResponse } from '../../../web/src/engine/protocol.js';

/** 假引擎 Worker：按协议回包，记录收到的请求。 */
class FakeEngineWorker implements WxEngineWorker {
  readonly sent: WorkerRequest[] = [];
  terminated = false;
  private listener: ((message: WorkerResponse) => void) | null = null;

  postMessage(message: WorkerRequest): void {
    this.sent.push(message);
  }

  onMessage(cb: (message: WorkerResponse) => void): void {
    this.listener = cb;
  }

  terminate(): void {
    this.terminated = true;
  }

  /** 测试辅助：模拟 worker 回包。 */
  reply(message: WorkerResponse): void {
    this.listener?.(message);
  }
}

describe('WxWorkerEngineClient', () => {
  it('start 发送 ping 并等待 ack', async () => {
    const worker = new FakeEngineWorker();
    const client = new WxWorkerEngineClient(worker);

    const pending = client.start();
    await Promise.resolve();
    expect(worker.sent).toHaveLength(1);
    expect(worker.sent[0].type).toBe('ping');

    const ping = worker.sent[0];
    worker.reply({ id: ping.id, type: 'ack' });
    await pending;
    expect(client.isReady).toBe(true);
  });

  it('go 发送请求并解析搜索结果', async () => {
    const worker = new FakeEngineWorker();
    const client = new WxWorkerEngineClient(worker);

    const pending = client.go({ fen: INITIAL_FEN, depth: 2 });
    await Promise.resolve();
    await Promise.resolve();

    const goRequest = worker.sent.find((request) => request.type === 'go');
    expect(goRequest).toBeDefined();
    worker.reply({
      id: (goRequest as { id: number }).id,
      type: 'result',
      result: { bestMove: 'h2e2', ponderMove: null },
    });

    const result = await pending;
    expect(result.bestMove).toBe('h2e2');
  });

  it('onInfo 收到 info 回包时通知监听者，退订后不再通知', async () => {
    const worker = new FakeEngineWorker();
    const client = new WxWorkerEngineClient(worker);

    const infos: number[] = [];
    const unsubscribe = client.onInfo((info) => infos.push(info.depth));
    worker.reply({ id: 0, type: 'info', info: { depth: 5, index: 1 } as never });
    unsubscribe();
    worker.reply({ id: 0, type: 'info', info: { depth: 6, index: 1 } as never });
    expect(infos).toEqual([5]);
  });

  it('dispose 拒绝挂起请求并终止 worker', async () => {
    const worker = new FakeEngineWorker();
    const client = new WxWorkerEngineClient(worker);

    const pending = client.go({ fen: INITIAL_FEN, depth: 2 });
    const expectation = expect(pending).rejects.toThrow('引擎已释放');
    await Promise.resolve();
    await Promise.resolve();
    await client.dispose();
    await expectation;
    expect(worker.terminated).toBe(true);
    expect(client.isReady).toBe(false);
  });
});
