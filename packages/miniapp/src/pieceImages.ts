import type { PieceImages } from '../../web/src/board/BoardRenderer.js';

/**
 * 小程序端棋子贴图加载：用 `canvas.createImage()`（微信 2d canvas 专用）
 * 替代 Web 版的 `new Image()`，产出同一 PieceImages 契约供 BoardRenderer 复用。
 * 单张贴图加载失败不中断（返回全 null，BoardRenderer 自带矢量兜底）。
 */

/** 棋子贴图文件名（索引 = 棋子编码 - 1），与 Web 版保持一致。 */
const PieceTextureNames: readonly string[] = [
  'r_shuai', 'r_shi', 'r_xiang', 'r_ma', 'r_ju', 'r_pao', 'r_bing',
  'b_jiang', 'b_shi', 'b_xiang', 'b_ma', 'b_ju', 'b_pao', 'b_zu',
];

/** 加载全部棋子贴图（需传入已创建的 2d canvas 节点）。 */
export function loadPieceImages(
  canvas: { createImage(): { src: string; onload: (() => void) | null; onerror: (() => void) | null } },
  baseUrl = '/images/pieces/',
): Promise<PieceImages> {
  const imageFactory = canvas.createImage.bind(canvas);

  return Promise.all(
    PieceTextureNames.map(
      (name) =>
        new Promise<[number, unknown | null]>((resolve) => {
          const index = PieceTextureNames.indexOf(name) + 1;
          try {
            const img = imageFactory();
            img.onload = () => resolve([index, img]);
            img.onerror = () => resolve([index, null]);
            img.src = `${baseUrl}${name}.png`;
          } catch {
            resolve([index, null]);
          }
        }),
    ),
  ).then((entries) => {
    const map = new Map<number, CanvasImageSource>();
    for (const [piece, img] of entries) {
      if (img !== null) {
        map.set(piece, img as CanvasImageSource);
      }
    }

    return { get: (piece: number) => map.get(piece) ?? null };
  });
}
