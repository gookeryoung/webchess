/**
 * 微信小程序全局 API 的最小访问层。
 *
 * 为避免引入 `miniprogram-api-typings` 新依赖，wx / worker 全局对象
 * 以宽松类型引用；真实 API 契约以微信官方文档为准。后续如需更严格的
 * 类型检查，可单独评估引入官方类型包（属新增依赖，需单独决策）。
 */

/** 宽松 wx API 类型：仅标注本包用到的入口，其余按 any 处理。 */
export type WxApi = {
  setStorageSync(key: string, value: unknown): void;
  getStorageSync(key: string): string | '';
  removeStorageSync(key: string): void;
  createInnerAudioContext(): {
    src: string;
    obeyMuteSwitch: boolean;
    play(): void;
    stop(): void;
    destroy(): void;
    onError(cb: (error: unknown) => void): void;
  };
  createWorker(path: string): {
    postMessage(message: unknown): void;
    onMessage(cb: (message: unknown) => void): void;
    terminate(): void;
  };
  createSelectorQuery(): {
    select(selector: string): {
      fields(options: {
        node?: boolean;
        size?: boolean;
        rect?: boolean;
      }): { exec(cb: (results: unknown[]) => void): void };
    };
  };
  getWindowInfo(): { pixelRatio: number; windowWidth: number; windowHeight: number };
  nextTick(cb: () => void): void;
  navigateTo(options: { url: string }): void;
};

/** 读取全局 wx 对象；非小程序环境返回 null（便于单测注入 mock）。 */
export function getWx(): WxApi | null {
  return (globalThis as unknown as { wx?: WxApi }).wx ?? null;
}

/** 读取全局 wx 对象；小程序运行时必然存在，缺失即抛错（显式失败优于静默）。 */
export function requireWx(): WxApi {
  const api = getWx();
  if (api === null) {
    throw new Error('wx 全局对象不存在：本模块只能在微信小程序运行时使用');
  }

  return api;
}

/** 引擎 Worker 内部的全局 worker 对象（微信 Worker 运行时注入）。 */
export interface WxWorkerScope {
  postMessage(message: unknown): void;
  onMessage(cb: (message: unknown) => void): void;
}

/** 读取 Worker 内部的全局 worker 对象。 */
export function getWorkerScope(): WxWorkerScope {
  return (globalThis as unknown as { worker: WxWorkerScope }).worker;
}
