import { registerGb18030Decoder } from '@webchess/adapters';
import type { WxApi } from './wx.js';

/**
 * 内置棋谱载入（打谱）：与 Web 版 App.tsx / Godot assets/manuals 同源的三份 XQF。
 *
 * 小程序不能 fetch 包内资源，改经 FileSystemManager 以 binary 读出字节，
 * 再走 AppController.openManual 的 XQF 解析链路。XQF 头部为 GB18030 编码，
 * 小程序无原生 TextDecoder，读取前注入 adapters 内置解码表（幂等）。
 */

/** 内置棋谱条目（file 相对包内 manuals/ 目录）。 */
export interface ManualEntry {
  readonly name: string;
  readonly file: string;
}

/** 内置棋谱清单（顺序与 Web 版一致）。 */
export const MANUAL_LIBRARY: readonly ManualEntry[] = [
  { name: '实战对局·中炮对屏风马（含变着）', file: 'realgame.xqf' },
  { name: '开局演示·当头炮（变着与注释）', file: 'demo_v10.xqf' },
  { name: '残局短局·两步（高版本加密）', file: 'demo_v16.xqf' },
];

/** 读取包内棋谱文件字节（代码包路径以 / 开头；encoding=binary 返回 ArrayBuffer）。 */
export function readManualBytes(api: WxApi, file: string): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    api
      .getFileSystemManager()
      .readFile({
        filePath: `/manuals/${file}`,
        encoding: 'binary',
        success: (res) => {
          if (res.data instanceof ArrayBuffer) {
            resolve(new Uint8Array(res.data));
          } else {
            reject(new Error('棋谱文件内容非二进制数据'));
          }
        },
        fail: (error) => reject(new Error(error.errMsg ?? '读取棋谱失败')),
      });
  });
}

/** 打谱棋谱打开入口的最小契约（AppController 满足）。 */
interface ManualOpener {
  openManual(source: { name: string; bytes: Uint8Array }): void;
}

/**
 * 载入内置棋谱并打开打谱：先注入 GB18030 解码器再读文件解析。
 * 失败时抛出，由调用方提示（不静默删减）。
 */
export async function loadManual(
  controller: ManualOpener,
  entry: ManualEntry,
  api: WxApi,
): Promise<void> {
  registerGb18030Decoder();
  const bytes = await readManualBytes(api, entry.file);
  controller.openManual({ name: entry.name, bytes });
}
