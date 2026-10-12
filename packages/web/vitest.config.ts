import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // jsdom：组件测试需要 DOM；既有纯逻辑测试（AppController/BoardRenderer）在 jsdom 下同样可跑。
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    // 每个用例结束后自动 restore 所有 spyOn mock，防止异常分支的 mock 泄漏到后续用例。
    restoreMocks: true,
    // 单元/组件测试遵循就近放置约定：src 下的 *.test.ts(x)
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
  },
});
