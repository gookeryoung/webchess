import { expect, test } from '@playwright/test';
import { clickIntersection, openApp } from '../helpers/app.js';

/**
 * 关键链路测试：走子 / 悔棋 / 新局 / 载入 FEN 全流程。
 * 交叉点坐标：x ∈ 0-8（左→右），y ∈ 0-9（上→下），红方在下（y=7 一线）。
 */

test('两段式选子落子：炮二平五，走子方切换', async ({ page }) => {
  const errors = await openApp(page);

  await clickIntersection(page, 7, 7); // 选中红炮（h2）
  await clickIntersection(page, 4, 7); // 落子 e2（炮二平五）

  await expect(page.getByText('黑方走子')).toBeVisible();
  expect(errors, errors.join('\n')).toEqual([]);
});

test('悔棋回退一手，走子方复原', async ({ page }) => {
  const errors = await openApp(page);

  await clickIntersection(page, 7, 7);
  await clickIntersection(page, 4, 7);
  await expect(page.getByText('黑方走子')).toBeVisible();

  await page.getByRole('button', { name: '悔棋' }).click();
  await expect(page.getByText('红方走子')).toBeVisible();
  expect(errors, errors.join('\n')).toEqual([]);
});

test('新局重置对局', async ({ page }) => {
  const errors = await openApp(page);

  await clickIntersection(page, 7, 7);
  await clickIntersection(page, 4, 7);
  await expect(page.getByText('黑方走子')).toBeVisible();

  await page.getByRole('button', { name: '新局' }).click();
  await expect(page.getByText('红方走子')).toBeVisible();
  expect(errors, errors.join('\n')).toEqual([]);
});

test('载入 FEN：弹窗输入并应用', async ({ page }) => {
  const errors = await openApp(page);

  await page.getByRole('button', { name: '载入 FEN' }).click();
  const input = page.getByPlaceholder('rnbakabnr/9/1c5c1/... w - - 0 1');
  await input.fill('4k4/9/9/9/9/9/9/9/9/4K4 w');
  // exact：避免误匹配 HUD 的「载入 FEN」按钮。
  await page.getByRole('button', { name: '载入', exact: true }).click();

  await expect(page.getByText('已载入 FEN 局面')).toBeVisible();
  expect(errors, errors.join('\n')).toEqual([]);
});

test('打谱：打开内置棋谱并逐步前进', async ({ page }) => {
  const errors = await openApp(page);

  await page.getByRole('button', { name: '打谱' }).click();
  await expect(page.getByRole('heading', { name: '选择打谱棋谱' })).toBeVisible();

  await page.getByRole('button', { name: '实战对局·中炮对屏风马（含变着）' }).click();
  // 棋谱载入后 HUD 出现打谱控制条与进度徽标。
  await expect(page.getByRole('button', { name: '前进 ⏩' })).toBeVisible();
  await expect(page.getByText(/^0\/\d+$/)).toBeVisible();

  await page.getByRole('button', { name: '前进 ⏩' }).click();
  await expect(page.getByText(/^1\/\d+$/)).toBeVisible();

  expect(errors, errors.join('\n')).toEqual([]);
});

test('人机模式：用户走子后引擎自动应手，无需切换模式', async ({ page }) => {
  const errors = await openApp(page);

  await page.getByRole('button', { name: '双人' }).click(); // 切换到人机模式
  await expect(page.getByText('人机模式：你执红先行')).toBeVisible();

  await clickIntersection(page, 7, 7); // 选红炮
  await clickIntersection(page, 4, 7); // 炮二平五

  // 引擎占用忙闲门闸：HUD 出现思考中提示。
  await expect(page.getByText('思考中…')).toBeVisible();

  // 引擎在走子时限内应手：状态栏出现黑方着法（回归：此前需反复切换模式才能触发）。
  await expect(page.getByText(/黑方：/)).toBeVisible({ timeout: 10000 });
  // 回合回到红方。
  await expect(page.getByText('红方走子')).toBeVisible();
  expect(errors, errors.join('\n')).toEqual([]);
});
