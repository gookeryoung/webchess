import '@testing-library/jest-dom/vitest';

/**
 * Vitest 全局测试设施：
 * - jest-dom 断言扩展（toBeInTheDocument 等）；
 * - jsdom 缺失的浏览器 API 兜底（ResizeObserver），组件挂载不因环境缺口崩溃。
 */

class ResizeObserverStub implements ResizeObserver {
  observe(): void {
    /* 测试环境无需真实测量 */
  }

  unobserve(): void {
    /* no-op */
  }

  disconnect(): void {
    /* no-op */
  }
}

if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = ResizeObserverStub;
}
