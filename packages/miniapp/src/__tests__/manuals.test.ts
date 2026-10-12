import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WxApi } from '../wx.js';
import { MANUAL_LIBRARY, loadManual, readManualBytes } from '../manuals.js';

function makeMockWx(readResult: ArrayBuffer, fail?: { errMsg: string }): WxApi {
  return {
    setStorageSync() {},
    getStorageSync() {
      return '';
    },
    removeStorageSync() {},
    createInnerAudioContext() {
      return {
        src: '',
        obeyMuteSwitch: false,
        play() {},
        stop() {},
        destroy() {},
        onError() {},
      };
    },
    createWorker() {
      return { postMessage() {}, onMessage() {}, terminate() {} };
    },
    createSelectorQuery() {
      return {
        select: (_selector: string) => ({
          fields: (_options: { node?: boolean; size?: boolean; rect?: boolean }) => ({
            exec: (_cb: (results: unknown[]) => void) => void {},
          }),
        }),
      };
    },
    getWindowInfo: () => ({ pixelRatio: 1, windowWidth: 375, windowHeight: 667 }),
    nextTick() {},
    navigateTo() {},
    navigateBack() {},
    getFileSystemManager: () => ({
      readFile: ({ success, fail: failCb }) => {
        if (fail !== undefined) {
          failCb(fail);
          return;
        }
        success({ data: readResult });
      },
    }),
  };
}

describe('MANUAL_LIBRARY', () => {
  it('导出三条内置棋谱', () => {
    expect(MANUAL_LIBRARY.length).toBe(3);
    expect(MANUAL_LIBRARY[0]!.file).toBe('realgame.xqf');
    expect(MANUAL_LIBRARY[0]!.name).toBeTruthy();
  });

  it('每条条目都有 name 和 file 字段', () => {
    for (const entry of MANUAL_LIBRARY) {
      expect(entry.name).toBeTypeOf('string');
      expect(entry.file).toBeTypeOf('string');
      expect(entry.file.endsWith('.xqf')).toBe(true);
    }
  });
});

describe('readManualBytes', () => {
  it('成功读取返回 Uint8Array', async () => {
    const data = new Uint8Array([0x41, 0x42, 0x43]);
    const api = makeMockWx(data.buffer);
    const bytes = await readManualBytes(api, 'demo_v10.xqf');
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes.length).toBe(3);
    expect(bytes[0]).toBe(0x41);
  });

  it('读取失败时抛出带错误信息', async () => {
    const api = makeMockWx(new ArrayBuffer(0), { errMsg: 'file not found' });
    await expect(readManualBytes(api, 'missing.xqf')).rejects.toThrow(/file not found/);
  });
});

describe('loadManual', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('成功：注入解码器 → 读文件 → 调 controller.openManual', async () => {
    const data = new Uint8Array([0xff, 0xfe]);
    const api = makeMockWx(data.buffer);
    const entry = MANUAL_LIBRARY[0]!;

    const controller = { openManual: vi.fn() };
    await loadManual(controller, entry, api);

    expect(controller.openManual).toHaveBeenCalledTimes(1);
    const [arg] = controller.openManual.mock.calls[0]!;
    expect(arg.name).toBe(entry.name);
    expect(arg.bytes).toBeInstanceOf(Uint8Array);
  });

  it('底层读文件失败时向上抛异常（controller 不被调用）', async () => {
    const api = makeMockWx(new ArrayBuffer(0), { errMsg: 'fs error' });
    const entry = MANUAL_LIBRARY[0]!;
    const controller = { openManual: vi.fn() };

    await expect(loadManual(controller, entry, api)).rejects.toThrow(/fs error/);
    expect(controller.openManual).not.toHaveBeenCalled();
  });
});
