import { BuiltinEngine } from '@webchess/engine';
import type { WorkerRequest, WorkerResponse } from '../../../web/src/engine/protocol.js';
import { getWorkerScope } from '../wx.js';

/**
 * 引擎 Worker 入口（微信小程序版）：与 Web 版 engine.worker.ts 同一协议，
 * 仅消息接收 API 不同（addEventListener → worker.onMessage）。
 * 构建时由 esbuild 把 engine + core 打成单文件 workers/engine/index.js
 * （微信 Worker 不支持 require 包外模块）。
 */

const engine = new BuiltinEngine();
const scope = getWorkerScope();
let currentId = 0;

engine.onInfo((info) => {
  scope.postMessage({ id: currentId, type: 'info', info } satisfies WorkerResponse);
});

scope.onMessage((raw) => {
  const request = raw as WorkerRequest;
  currentId = request.id;

  const reply = (message: WorkerResponse) => scope.postMessage(message);

  if (request.type === 'ping') {
    reply({ id: request.id, type: 'ack' });
    return;
  }

  if (request.type === 'options') {
    void engine.applyOptions(request.options).then(() => reply({ id: request.id, type: 'ack' }));
    return;
  }

  if (request.type === 'stop') {
    engine.stop();
    reply({ id: request.id, type: 'ack' });
    return;
  }

  if (request.type === 'go') {
    void engine
      .go(request.params)
      .then((result) => reply({ id: request.id, type: 'result', result }))
      .catch((error: unknown) =>
        reply({
          id: request.id,
          type: 'error',
          message: error instanceof Error ? error.message : String(error),
        }),
      );
    return;
  }

  reply({ id: currentId, type: 'error', message: '未知请求类型' });
});
