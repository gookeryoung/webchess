import { BuiltinEngine } from '@webchess/engine';
import { asWorkerScope, WorkerRequest, WorkerResponse } from './protocol.js';

/**
 * 引擎 Worker 入口：在主线程之外执行 alpha-beta 搜索。
 */
const engine = new BuiltinEngine();
const scope = asWorkerScope();

engine.onInfo((info) => {
  scope.postMessage({ id: currentId, type: 'info', info });
});

let currentId = 0;

scope.addEventListener('message', (event) => {
  const request = event.data as WorkerRequest;
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
