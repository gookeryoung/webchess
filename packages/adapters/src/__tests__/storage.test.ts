import { describe, expect, it } from 'vitest';
import { createMemoryStorage, createWebStorage } from '../index.js';

describe('createMemoryStorage', () => {
  it('空存储 read 返回 null', () => {
    const s = createMemoryStorage();
    expect(s.read('key')).toBeNull();
  });

  it('write + read 能正确存取', () => {
    const s = createMemoryStorage();
    s.write('foo', 'bar');
    expect(s.read('foo')).toBe('bar');
  });

  it('remove 后 read 返回 null', () => {
    const s = createMemoryStorage();
    s.write('foo', 'bar');
    s.remove('foo');
    expect(s.read('foo')).toBeNull();
  });

  it('重复 write 同一 key 会覆盖', () => {
    const s = createMemoryStorage();
    s.write('k', 'v1');
    s.write('k', 'v2');
    expect(s.read('k')).toBe('v2');
  });

  it('不同实例相互隔离', () => {
    const a = createMemoryStorage();
    const b = createMemoryStorage();
    a.write('x', 'y');
    expect(b.read('x')).toBeNull();
  });
});

describe('createWebStorage', () => {
  it('默认 namespace 前缀', () => {
    // 在 jsdom 外（node environment），localStorage 应不存在 → 自动降级为内存存储。
    const s = createWebStorage();
    // 无论走 Web 还是 Memory 路径，read/write 行为都应正确。
    s.write('k', 'v');
    expect(s.read('k')).toBe('v');
  });

  it('自定义 namespace 隔离不同前缀', () => {
    const a = createWebStorage('nsA');
    const b = createWebStorage('nsB');
    a.write('k', 'va');
    b.write('k', 'vb');
    // 内存实现下，两个不同 namespace 的 WebStorage 应该是两个独立实例
    // （因为每次 createWebStorage 内部新建一个 Map 或独立 localStorage key 空间）。
    expect(a.read('k')).toBe('va');
    expect(b.read('k')).toBe('vb');
  });

  it('remove 后 read 为 null', () => {
    const s = createWebStorage();
    s.write('k', 'v');
    s.remove('k');
    expect(s.read('k')).toBeNull();
  });
});
