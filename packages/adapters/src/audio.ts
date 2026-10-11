/**
 * 音效适配层。
 *
 * 原 C# 使用 Godot `AudioStreamPlayer`（每种音效一个实例，允许叠加播放）。
 * Web 端等价物为 `HTMLAudioElement`（同样每种音效一个实例）。
 * 小程序端等价物为 `wx.createInnerAudioContext`。
 *
 * 注意：原资源混用 wav / mp3 / ogg 三种格式。Web 端 wav 与 mp3 全兼容，
 * ogg 在 Safari 上不支持——若需覆盖 Safari，将 checkmate.ogg 转码为 mp3 即可，
 * 播放失败会静默跳过，不影响对局。
 */

export type SoundEffect = 'select' | 'move' | 'capture' | 'check' | 'checkmate' | 'invalid';

/** 音效文件名映射（与 assets/sounds 一一对应）。 */
const SoundFiles: Record<SoundEffect, string> = {
  select: 'select.wav',
  move: 'move.mp3',
  capture: 'capture.mp3',
  check: 'check.mp3',
  checkmate: 'checkmate.ogg',
  invalid: 'invalid.mp3',
};

export interface AudioPlayer {
  play(effect: SoundEffect): void;
  setEnabled(enabled: boolean): void;
  readonly enabled: boolean;
}

export function createWebAudioPlayer(baseUrl = '/sounds/'): AudioPlayer {
  const players = new Map<SoundEffect, HTMLAudioElement>();
  let enabled = true;

  for (const effect of Object.keys(SoundFiles) as SoundEffect[]) {
    const audio = new Audio(`${baseUrl}${SoundFiles[effect]}`);
    audio.preload = 'auto';
    players.set(effect, audio);
  }

  return {
    get enabled() {
      return enabled;
    },
    setEnabled(value: boolean) {
      enabled = value;
    },
    play(effect: SoundEffect) {
      if (!enabled) {
        return;
      }

      const audio = players.get(effect);
      if (audio === undefined) {
        return;
      }

      try {
        audio.currentTime = 0;
        void audio.play().catch(() => undefined);
      } catch {
        // 自动播放策略拦截或格式不支持：静默跳过。
      }
    },
  };
}

/** 空实现（无声环境 / 测试）。 */
export function createSilentAudioPlayer(): AudioPlayer {
  let enabled = false;
  return {
    get enabled() {
      return enabled;
    },
    setEnabled(value: boolean) {
      enabled = value;
    },
    play() {
      /* 无操作 */
    },
  };
}
