/**
 * 持久化适配层。
 *
 * 原 C# 使用 Godot `user://` 私有目录（FileAccess）。
 * Web 端等价物为 localStorage；小程序端等价物为 `wx.setStorageSync`。
 * 内核只依赖本接口，不感知具体存储实现。
 */
export interface KeyValueStorage {
  read(key: string): string | null;
  write(key: string, value: string): void;
  remove(key: string): void;
}

/** localStorage 实现（隐私模式或禁用 Cookie 时自动降级为内存存储）。 */
export function createWebStorage(namespace = 'webchess'): KeyValueStorage {
  const backend = (() => {
    try {
      const probe = '__webchess_probe__';
      globalThis.localStorage.setItem(probe, '1');
      globalThis.localStorage.removeItem(probe);
      return globalThis.localStorage;
    } catch {
      return null;
    }
  })();

  if (backend === null) {
    return createMemoryStorage();
  }

  const store = backend;
  const prefix = `${namespace}:`;
  return {
    read: (key) => store.getItem(prefix + key),
    write: (key, value) => {
      try {
        store.setItem(prefix + key, value);
      } catch {
        // 配额超限：静默降级，不阻塞对局。
      }
    },
    remove: (key) => store.removeItem(prefix + key),
  };
}

/** 内存实现（测试与降级路径使用）。 */
export function createMemoryStorage(): KeyValueStorage {
  const map = new Map<string, string>();
  return {
    read: (key) => map.get(key) ?? null,
    write: (key, value) => {
      map.set(key, value);
    },
    remove: (key) => {
      map.delete(key);
    },
  };
}
