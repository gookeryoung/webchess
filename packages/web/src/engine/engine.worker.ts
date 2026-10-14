import wasmUrl from '@webchess/engine/wasm/engine-core.wasm?url';
import nnueUrl from '@webchess/engine/wasm/nnue-weights.bin?url';
import { BuiltinEngine, initEngineWasm, loadNnueWeights, uploadNnueWeights } from '@webchess/engine';
import { asWorkerScope, WorkerRequest, WorkerResponse } from './protocol.js';

/**
 * 引擎 Worker 入口：在主线程之外执行 alpha-beta 搜索。
 *
 * WASM 内核与 NNUE 权重预加载：均须在实例化引擎前完成（Searcher 构造时定型后端）；
 * 任一加载失败（网络异常 / 环境不支持）静默回退（纯 TS 内核 / 手工评估），不影响功能。
 *
 * 关键约束：下面两段预加载使用顶层 await，模块求值会在此处挂起，而挂起期间 Worker
 * 的事件循环照常派发消息任务——此时若还没注册 message 监听，消息就会被直接丢弃
 * （实测：Chromium 不会在模块求值完成后补投）。客户端 start() 发出的首个 ping 恰好
 * 落在这一窗口内，ping 一丢 ack 就永远不来，`await engine.start()` 永久挂起，
 * 界面因此完全挂不上（表现为白屏且控制台无任何报错）。
 * 所以监听必须在任何 await 之前注册：未就绪期间的请求先进队列，引擎建好后按序回放。
 */
const scope = asWorkerScope();
const pendingRequests: WorkerRequest[] = [];
let handleRequest: ((request: WorkerRequest) => void) | null = null;

scope.addEventListener('message', (event) => {
  const request = event.data as WorkerRequest;
  if (handleRequest === null) {
    pendingRequests.push(request);
    return;
  }

  handleRequest(request);
});

try {
  const response = await fetch(wasmUrl);
  if (response.ok) {
    await initEngineWasm(await response.arrayBuffer());
  }
} catch {
  // 回退纯 TS 内核。
}

try {
  const response = await fetch(nnueUrl);
  if (response.ok) {
    const weights = await response.arrayBuffer();
    // 同一份权重同时供 TS 推理与 WASM 内核：上传成功时走法生成 + NNUE 前向都在 WASM。
    loadNnueWeights(weights);
    uploadNnueWeights(weights);
  }
} catch {
  // 回退手工评估。
}

const engine = new BuiltinEngine();
let currentId = 0;

engine.onInfo((info) => {
  scope.postMessage({ id: currentId, type: 'info', info });
});

const processRequest = (request: WorkerRequest): void => {
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
};

handleRequest = processRequest;

// 回放预加载期间到达的请求（严格保持到达顺序，例如 ping 必须先于 go 被应答）。
for (const request of pendingRequests.splice(0)) {
  processRequest(request);
}
