import type { AudioPlayer, SoundEffect } from '@webchess/adapters';
import { requireWx } from './wx.js';

/**
 * 微信小程序音效适配层：`wx.createInnerAudioContext`（每种音效一个实例，
 * 与原 Godot / Web 版的叠加播放语义一致）。
 *
 * 资源差异：原资源含 checkmate.ogg，微信小程序不支持 ogg——
 * 将军终局音效显式降级复用 check.mp3（不静默删减，播放失败也会跳过）。
 */

/** 小程序端音效文件名映射（checkmate 复用 check.mp3）。 */
const SoundFiles: Record<SoundEffect, string> = {
  select: 'select.wav',
  move: 'move.mp3',
  capture: 'capture.mp3',
  check: 'check.mp3',
  checkmate: 'check.mp3',
  invalid: 'invalid.mp3',
};

/** 小程序端音效实现。baseUrl 默认指向包内 sounds 目录。 */
export function createWxAudioPlayer(baseUrl = '/sounds/'): AudioPlayer {
  const api = requireWx();
  const players = new Map<SoundEffect, ReturnType<typeof api.createInnerAudioContext>>();
  let enabled = true;

  for (const effect of Object.keys(SoundFiles) as SoundEffect[]) {
    const audio = api.createInnerAudioContext();
    audio.src = `${baseUrl}${SoundFiles[effect]}`;
    audio.onError(() => undefined);
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
        audio.stop();
        audio.play();
      } catch {
        // 播放失败静默跳过，不影响对局。
      }
    },
  };
}
