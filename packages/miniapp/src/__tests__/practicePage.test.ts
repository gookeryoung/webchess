import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { WxApi } from '../wx.js';
import { createPracticePage } from '../pages/practicePage.js';

/**
 * 练习页控制器单测：以注入的 wx mock 驱动 Page 配置对象，
 * 验证教学 / 残局 / 打谱三种路由下列表构建、选课开局与打谱跳转。
 */

const webPublic = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'web', 'public');

interface PickEvent {
  currentTarget: { dataset: { index: number } };
}

function createWxMock(): { api: WxApi; state: { backCalls: number } } {
  const store = new Map<string, string>();
  const state = { backCalls: 0 };
  const api = {
    setStorageSync(key: string, value: unknown): void {
      store.set(key, String(value));
    },
    getStorageSync(key: string): string {
      return store.get(key) ?? '';
    },
    removeStorageSync(key: string): void {
      store.delete(key);
    },
    createInnerAudioContext(): unknown {
      return {
        src: '',
        play(): void {},
        stop(): void {},
        destroy(): void {},
        onError(): void {},
      };
    },
    createSelectorQuery(): unknown {
      return {
        select(): unknown {
          return {
            fields(): unknown {
              return {
                exec(cb: (results: unknown[]) => void): void {
                  cb([]);
                },
              };
            },
          };
        },
      };
    },
    getWindowInfo(): { pixelRatio: number; windowWidth: number; windowHeight: number } {
      return { pixelRatio: 2, windowWidth: 375, windowHeight: 667 };
    },
    nextTick(cb: () => void): void {
      cb();
    },
    navigateTo(): void {},
    navigateBack(): void {
      state.backCalls += 1;
    },
    getFileSystemManager(): unknown {
      return {
        readFile(options: {
          filePath: string;
          success: (res: { data: ArrayBuffer }) => void;
          fail: (error: { errMsg?: string }) => void;
        }): void {
          try {
            // 代码包路径 /manuals/<file> 映射到 web/public/manuals 真实样例。
            const file = options.filePath.replace('/manuals/', '');
            const bytes = readFileSync(join(webPublic, 'manuals', file));
            options.success({ data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) });
          } catch (error) {
            options.fail({ errMsg: String(error) });
          }
        },
      };
    },
  };
  return { api: api as unknown as WxApi, state };
}

/** 冲刷 loadManual 的 Promise 链（readFile 同步回调，宏任务一拍足够）。 */
async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

function pick(page: ReturnType<typeof createPracticePage>, index: number): void {
  page.onPickRow({ currentTarget: { dataset: { index } } } as PickEvent);
}

describe('createPracticePage', () => {
  let mock: ReturnType<typeof createWxMock>;

  beforeEach(() => {
    mock = createWxMock();
    (globalThis as unknown as { wx: unknown }).wx = mock.api;
  });

  afterEach(() => {
    delete (globalThis as unknown as { wx?: unknown }).wx;
  });

  it('教学页：初始为 10 门课程列表，点选即开局并收起列表', () => {
    const page = createPracticePage();
    page.onLoad({ kind: 'lesson' });

    expect(page.data.kindText).toBe('入门课程');
    expect(page.data.rows).toHaveLength(10);
    expect(page.data.showList).toBe(true);

    pick(page, 2);
    expect(page.data.showList).toBe(false);
    expect(page.data.status).toContain('【');
    expect(page.data.rows[2]!.current).toBe(true);
  });

  it('kind 非法时回退教学页', () => {
    const page = createPracticePage();
    page.onLoad({ kind: 'unknown' });

    expect(page.data.kindText).toBe('入门课程');
    expect(page.data.rows).toHaveLength(10);
  });

  it('残局页：50 题列表含过关统计，点选开局并收起列表', () => {
    const page = createPracticePage();
    page.onLoad({ kind: 'puzzle' });

    expect(page.data.kindText).toBe('残局练习');
    expect(page.data.rows).toHaveLength(50);
    expect(page.data.depthText).toBe('已过关 0/50 题');

    pick(page, 0);
    expect(page.data.showList).toBe(false);
    expect(page.data.status).toContain('【');

    // 重开列表后当前题标记为进行中，且尝试次数已记录。
    page.onToggleList();
    expect(page.data.showList).toBe(true);
    expect(page.data.rows[0]!.current).toBe(true);
    expect(page.data.rows[0]!.sub).toContain('挑战 1 次');
  });

  it('打谱页：先列 3 份内置棋谱，打开后为着法列表且可跳转/后退/回开局', async () => {
    const page = createPracticePage();
    page.onLoad({ kind: 'manual' });

    expect(page.data.isManual).toBe(true);
    expect(page.data.rows).toHaveLength(3);
    expect(page.data.rows[0]!.title).toContain('实战对局');

    pick(page, 0);
    await flush();

    expect(page.data.manualMode).toBe(true);
    const total = page.data.rows.length;
    expect(total).toBeGreaterThan(10);
    expect(page.data.depthText).toBe(`第 0/${total} 着`);

    // 着法跳转：点击第 5 着。
    pick(page, 5);
    expect(page.data.depthText).toBe(`第 5/${total} 着`);
    expect(page.data.rows[4]!.current).toBe(true);

    // 回开局与逐着前进。
    page.onRewind();
    expect(page.data.depthText).toBe(`第 0/${total} 着`);
    page.onForward();
    expect(page.data.depthText).toBe(`第 1/${total} 着`);

    // 后退（undo 走打谱回退链路）。
    page.onBack();
    expect(page.data.depthText).toBe(`第 0/${total} 着`);
  });

  it('退出按钮触发 navigateBack', () => {
    const page = createPracticePage();
    page.onLoad({ kind: 'lesson' });

    page.onExit();
    expect(mock.state.backCalls).toBe(1);
  });
});
