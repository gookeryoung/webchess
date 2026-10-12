import { requireWx } from '../wx.js';

/**
 * 首页控制器（原生小程序）：模式菜单，提供对局与三类练习入口。
 */
export function createIndexPage(): { data: Record<string, unknown> } & Record<string, unknown> {
  return {
    data: {
      title: 'SuperChess 象棋',
      subtitle: '人机对局 · 残局 · 教学 · 打谱',
    },

    onGoGame(): void {
      requireWx().navigateTo({ url: '/pages/game/game' });
    },

    onGoPractice(event: { currentTarget: { dataset: { kind?: string } } }): void {
      const kind = event.currentTarget.dataset.kind ?? 'lesson';
      requireWx().navigateTo({ url: `/pages/practice/practice?kind=${kind}` });
    },
  };
}
