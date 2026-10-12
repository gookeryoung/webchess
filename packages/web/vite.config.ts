import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: './',
  server: {
    port: 5173,
    host: '127.0.0.1',
  },
  preview: {
    port: 4173,
    host: '127.0.0.1',
  },
  build: {
    // 引擎 Worker 使用顶层 await 预加载 WASM 内核（ES module worker 本就要求现代浏览器）。
    target: 'es2022',
    outDir: 'dist',
    sourcemap: true,
  },
  worker: {
    format: 'es',
  },
});
