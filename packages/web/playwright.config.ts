import { defineConfig } from '@playwright/test';

/**
 * E2E 测试配置（参照 cndb 前端工程约定）：
 * - webServer 先构建再以 vite preview 提供生产产物（测的是真实构建结果，非开发态模块图）；
 * - reuseExistingServer 关闭：绝不复用来源不明的 4173 端口服务，保证每次运行环境可控。
 */
export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30_000,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: [['list']],
  webServer: {
    command: 'pnpm build && pnpm preview --port 4173 --strictPort',
    url: 'http://127.0.0.1:4173/',
    reuseExistingServer: false,
    timeout: 180_000,
  },
  use: {
    baseURL: 'http://127.0.0.1:4173',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    headless: true,
  },
});
