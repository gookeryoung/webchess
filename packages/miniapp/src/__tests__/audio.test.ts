import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createWxAudioPlayer } from '../audio.js';
import type { WxApi } from '../wx.js';

interface FakeAudio {
  src: string;
  playCalls: number;
  stopCalls: number;
  play(): void;
  stop(): void;
  destroy(): void;
  onError(cb: (error: unknown) => void): void;
}

function createWxMock(): { api: WxApi; audios: FakeAudio[] } {
  const audios: FakeAudio[] = [];
  const api = {
    createInnerAudioContext(): FakeAudio {
      const audio: FakeAudio = {
        src: '',
        playCalls: 0,
        stopCalls: 0,
        play() {
          audio.playCalls += 1;
        },
        stop() {
          audio.stopCalls += 1;
        },
        destroy() {
          /* 测试中不关心 */
        },
        onError() {
          /* 测试中不关心 */
        },
      };
      audios.push(audio);
      return audio;
    },
  };
  return { api: api as unknown as WxApi, audios };
}

describe('createWxAudioPlayer', () => {
  let mock: ReturnType<typeof createWxMock>;

  beforeEach(() => {
    mock = createWxMock();
    (globalThis as unknown as { wx: unknown }).wx = mock.api;
  });

  afterEach(() => {
    delete (globalThis as unknown as { wx?: unknown }).wx;
  });

  it('为每种音效建立独立实例，路径指向 /sounds/', () => {
    createWxAudioPlayer();
    // 6 种音效各一实例。
    expect(mock.audios).toHaveLength(6);
    expect(mock.audios.every((audio) => audio.src.startsWith('/sounds/'))).toBe(true);
    expect(mock.audios.some((audio) => audio.src === '/sounds/move.mp3')).toBe(true);
  });

  it('checkmate 显式降级复用 check.mp3（小程序不支持 ogg）', () => {
    createWxAudioPlayer();
    const srcs = mock.audios.map((audio) => audio.src);
    expect(srcs).not.toContain('/sounds/checkmate.ogg');
    expect(srcs.filter((src) => src === '/sounds/check.mp3')).toHaveLength(2);
  });

  it('play 时先 stop 再 play（支持重复触发）', () => {
    const player = createWxAudioPlayer();
    player.play('move');
    player.play('move');
    const moveAudio = mock.audios.find((audio) => audio.src === '/sounds/move.mp3');
    expect(moveAudio?.stopCalls).toBe(2);
    expect(moveAudio?.playCalls).toBe(2);
  });

  it('setEnabled(false) 后 play 为无操作', () => {
    const player = createWxAudioPlayer();
    player.setEnabled(false);
    expect(player.enabled).toBe(false);
    player.play('capture');
    const captureAudio = mock.audios.find((audio) => audio.src === '/sounds/capture.mp3');
    expect(captureAudio?.playCalls).toBe(0);
  });
});
