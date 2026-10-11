import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { AppController } from './app/AppController.js';
import { createWebAudioPlayer, createWebStorage, registerGb18030Decoder } from '@webchess/adapters';
import { WorkerEngineClient } from './engine/engineClient.js';
import './styles.css';

/**
 * Web 端装配入口（对应原 Godot Main._Ready）：
 * 1) 注入 GB18030 解码器（XQF 中文元信息）
 * 2) 创建存储与音效适配器
 * 3) 启动引擎 Worker 并注入会话
 * 4) 挂载 React 界面
 */
async function bootstrap(): Promise<void> {
  const gb18030Ready = registerGb18030Decoder();
  const storage = createWebStorage();
  const audio = createWebAudioPlayer('sounds/');
  // 浏览器自动播放策略：默认关闭，首次用户交互后开启。
  audio.setEnabled(false);
  const enableAudio = () => {
    audio.setEnabled(true);
    globalThis.removeEventListener('pointerdown', enableAudio);
  };
  globalThis.addEventListener('pointerdown', enableAudio);

  let engine: WorkerEngineClient | null = null;
  try {
    engine = new WorkerEngineClient();
    await engine.start();
  } catch (error) {
    console.warn('引擎 Worker 启动失败，降级为双人模式', error);
    engine = null;
  }

  const controller = new AppController(storage, audio, engine, gb18030Ready);
  const container = document.getElementById('root');
  if (container === null) {
    throw new Error('未找到 #root 挂载点');
  }

  createRoot(container).render(
    <StrictMode>
      <App controller={controller} />
    </StrictMode>,
  );
}

void bootstrap();
