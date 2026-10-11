import type { KeyValueStorage } from '@webchess/adapters';
import { getWx } from './wx.js';

/**
 * 微信小程序持久化适配层：`wx.setStorageSync` / `wx.getStorageSync`。
 *
 * 与 Web 版 createWebStorage 同契约（KeyValueStorage），内核不感知实现。
 * 同步存储异常（配额超限等）静默降级，不阻塞对局，与 Web 版语义一致。
 */
export function createWxStorage(namespace = 'webchess'): KeyValueStorage {
  const prefix = `${namespace}:`;
  return {
    read(key: string): string | null {
      const api = getWx();
      if (api === null) {
        return null;
      }

      try {
        const value = api.getStorageSync(prefix + key);
        return value === '' || value === null || value === undefined ? null : String(value);
      } catch {
        return null;
      }
    },
    write(key: string, value: string): void {
      const api = getWx();
      if (api === null) {
        return;
      }

      try {
        api.setStorageSync(prefix + key, value);
      } catch {
        // 配额超限：静默降级，不阻塞对局。
      }
    },
    remove(key: string): void {
      const api = getWx();
      if (api === null) {
        return;
      }

      try {
        api.removeStorageSync(prefix + key);
      } catch {
        // 忽略移除失败。
      }
    },
  };
}
