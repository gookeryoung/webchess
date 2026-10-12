import { createGamePage } from '../pages/gamePage.js';
import { createIndexPage } from '../pages/indexPage.js';
import { createPracticePage } from '../pages/practicePage.js';

/**
 * 小程序应用与页面的统一入口（esbuild 打包为 miniprogram/lib/app.js，
 * 由 app.js 与各页面 js（pages 目录）require）。
 *
 * 注意：本入口必须保持零副作用——require 时不得触碰 wx 全局对象，
 * 以便构建冒烟能在 Node 环境直接加载验证。
 */

/** App() 配置：MVP 无全局逻辑，保留生命周期骨架。 */
export function createApp(): { onLaunch(): void } {
  return {
    onLaunch(): void {
      /* 全局初始化：后续接入进度恢复、GB18030 解码表注入等 */
    },
  };
}

export { createGamePage, createIndexPage, createPracticePage };
export { createWxStorage } from '../storage.js';
export { createWxAudioPlayer } from '../audio.js';
export { WxWorkerEngineClient } from '../engineClient.js';
