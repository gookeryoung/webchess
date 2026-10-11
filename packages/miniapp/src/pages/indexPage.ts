import { requireWx } from '../wx.js';

/**
 * 首页控制器（原生小程序）：模式菜单，MVP 仅提供「开始对局」入口。
 * 残局 / 教学 / 打谱入口在后续迭代接入（内核控制器已就绪）。
 */
export function createIndexPage(): { data: Record<string, unknown> } & Record<string, unknown> {
  return {
    data: {
      title: 'SuperChess 象棋',
      subtitle: '人机对局 · 残局 · 教学（陆续开放）',
    },

    onGoGame(): void {
      requireWx().navigateTo({ url: '/pages/game/game' });
    },
  };
}
