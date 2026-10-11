import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createWxStorage } from '../storage.js';
import type { WxApi } from '../wx.js';

/** 构造内存版 wx 同步存储 mock。 */
function createWxMock(): { api: WxApi; store: Map<string, unknown>; setFailWrites(v: boolean): void } {
  const store = new Map<string, unknown>();
  let failWrites = false;
  const api = {
    setStorageSync(key: string, value: unknown): void {
      if (failWrites) {
        throw new Error('exceed storage max size');
      }

      store.set(key, value);
    },
    getStorageSync(key: string): string {
      const value = store.get(key);
      return typeof value === 'string' ? value : '';
    },
    removeStorageSync(key: string): void {
      store.delete(key);
    },
  };
  return {
    api: api as unknown as WxApi,
    store,
    setFailWrites: (value: boolean) => {
      failWrites = value;
    },
  };
}

describe('createWxStorage', () => {
  let mock: ReturnType<typeof createWxMock>;

  beforeEach(() => {
    mock = createWxMock();
    (globalThis as unknown as { wx: unknown }).wx = mock.api;
  });

  afterEach(() => {
    delete (globalThis as unknown as { wx?: unknown }).wx;
  });

  it('写入后可读回，读取时带命名空间前缀', () => {
    const storage = createWxStorage();
    storage.write('puzzle_progress', '{"solved":3}');
    expect(storage.read('puzzle_progress')).toBe('{"solved":3}');
    expect(mock.store.has('webchess:puzzle_progress')).toBe(true);
  });

  it('读取不存在的键返回 null（空串与缺失等价）', () => {
    const storage = createWxStorage();
    expect(storage.read('missing')).toBeNull();
  });

  it('remove 移除后读取返回 null', () => {
    const storage = createWxStorage();
    storage.write('k', 'v');
    storage.remove('k');
    expect(storage.read('k')).toBeNull();
  });

  it('写入抛异常时静默降级，不阻塞对局', () => {
    const storage = createWxStorage();
    mock.setFailWrites(true);
    expect(() => storage.write('k', 'v')).not.toThrow();
  });

  it('wx 缺失时读取返回 null 且写入不抛错', () => {
    delete (globalThis as unknown as { wx?: unknown }).wx;
    const storage = createWxStorage();
    expect(storage.read('k')).toBeNull();
    expect(() => storage.write('k', 'v')).not.toThrow();
  });
});
