import { expect, test } from '@playwright/test';
import { openApp } from '../helpers/app.js';

/**
 * 冒烟测试：应用加载 → 首屏有意义内容渲染 → 主要控件可见且可响应，
 * 且控制台无应用级报错。
 */

test('页面加载：标题、首屏与主要控件', async ({ page }) => {
  const errors = await openApp(page);

  await expect(page).toHaveTitle('SuperChess Web · 中国象棋');
  await expect(page.getByRole('heading', { name: 'SuperChess Web' })).toBeVisible();
  await expect(page.getByText('红方走子')).toBeVisible();

  for (const name of ['新局', '悔棋', '提示', '分析', '双人', '入门课程', '残局练习', '打谱']) {
    await expect(page.getByRole('button', { name })).toBeVisible();
  }

  expect(errors, errors.join('\n')).toEqual([]);
});

test('关于弹窗可打开关闭', async ({ page }) => {
  const errors = await openApp(page);

  await page.getByRole('button', { name: '关于' }).click();
  await expect(page.getByRole('heading', { name: '关于 SuperChess Web' })).toBeVisible();

  await page.getByRole('button', { name: '好的' }).click();
  await expect(page.getByRole('heading', { name: '关于 SuperChess Web' })).not.toBeVisible();

  expect(errors, errors.join('\n')).toEqual([]);
});

test('入门课程：课程列表打开、选课进入练习并可退出', async ({ page }) => {
  const errors = await openApp(page);

  await page.getByRole('button', { name: '入门课程' }).click();
  // 谱册页打开：列出课程。
  const dialog = page.getByRole('dialog', { name: '入门课程' });
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('.lesson-item').first()).toBeVisible();

  // 选择第一课进入练习态，HUD 出现「退出练习」。
  await dialog.locator('.lesson-item').first().click();
  await expect(page.getByRole('button', { name: '退出练习' })).toBeVisible();

  await page.getByRole('button', { name: '退出练习' }).click();
  await expect(page.getByRole('button', { name: '退出练习' })).not.toBeVisible();

  expect(errors, errors.join('\n')).toEqual([]);
});
