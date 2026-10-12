import { expect, type Page } from '@playwright/test';

/**
 * E2E 公共助手。
 */

/** 打开首页并开始收集运行期错误；返回的数组引用在用例结束时断言为空。 */
export async function openApp(page: Page): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') {
      errors.push(`console.error: ${message.text()}`);
    }
  });

  await page.goto('/');
  await expect(page.locator('canvas.board-canvas')).toBeVisible();
  return errors;
}

/**
 * 画布交叉点点击：按 BoardRenderer 几何（格距 cell、内边距 0.56/0.43 倍）
 * 把交叉点坐标 (x: 0-8, y: 0-9) 换算为页面像素并点击。
 */
export async function clickIntersection(page: Page, x: number, y: number): Promise<void> {
  const box = await page.locator('canvas.board-canvas').boundingBox();
  if (box === null) {
    throw new Error('未找到棋盘画布');
  }

  const cell = box.width / 9.12;
  const padX = cell * 0.56;
  const padY = cell * 0.43;
  await page.mouse.click(box.x + padX + x * cell, box.y + padY + y * cell);
}
