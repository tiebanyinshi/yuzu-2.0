// 回测整改 P09（docs/YUZU_REQ_V820.md 第 10 节，回测 4-2）：技师上钟轮播——技师组里有入口；按项目 / 按区域切换；
// 筛选生效的条件写成小标签、能逐个去掉、能一键重置；暂停与继续、轮播间隔本机记住；全屏投屏只留看板，Esc 退出。只读，没有改钟的按钮。
// 依赖演示数据（店主 linlan，密码 yuzu2026；演示库有在钟的技师）。只看不改，可重复执行；只在门店电脑跑。
import { expect, test, type Page } from '@playwright/test';

async function login(page: Page) {
  await page.goto('/login');
  await page.fill('#username', 'linlan');
  await page.fill('#password', 'yuzu2026');
  await page.getByRole('button', { name: '登录' }).click();
  await expect(page.getByRole('navigation', { name: /主导航|后台/ }).first()).toBeVisible({ timeout: 30_000 });
}

test.describe('技师上钟轮播', () => {
  test.skip(({ viewport }) => (viewport?.width ?? 0) < 1280, '只在门店电脑尺寸跑');

  test('入口、维度切换、筛选标签、暂停、间隔、全屏投屏', async ({ page }) => {
    await login(page);
    await page.goto('/tech-board');
    const board = page.getByTestId('tech-board');
    await expect(board).toHaveAttribute('data-mode', 'item');
    await expect(page.getByTestId('tech-board-order')).toBeVisible();
    await expect(page.getByTestId('tech-board-col').first()).toBeVisible();
    await expect(page.getByTestId('tech-board-card').first()).toBeVisible();
    await expect(page.getByTestId('tech-board-next')).toContainText('下一位排钟');
    // 只读：看板上没有改钟的按钮
    await expect(board.getByRole('button', { name: /上钟|下钟|派钟|叫号/ })).toHaveCount(0);

    // 按区域
    await page.getByRole('radio', { name: '按区域' }).click();
    await expect(board).toHaveAttribute('data-mode', 'area');
    await expect(page).toHaveURL(/mode=area/);
    await page.getByRole('radio', { name: '按项目' }).click();
    await expect(board).toHaveAttribute('data-mode', 'item');

    // 筛选：状态 + 项目两条生效，逐个去掉、一键重置
    await page.getByTestId('tech-board-status').selectOption('serving');
    const item = await page.getByTestId('tech-board-item').locator('option').nth(1).getAttribute('value');
    await page.getByTestId('tech-board-item').selectOption(item!);
    await expect(page.getByTestId('tech-board-active')).toContainText('状态：上钟中');
    await expect(page.getByTestId('tech-board-active')).toContainText(`项目：${item}`);
    await expect(page.locator('[data-testid^="tech-board-row-"]:not([data-status="serving"])')).toHaveCount(0);
    await page.getByTestId('tech-board-chip-status').click();
    await expect(page.getByTestId('tech-board-chip-status')).toHaveCount(0);
    await expect(page.getByTestId('tech-board-chip-item')).toBeVisible();
    await page.getByTestId('tech-board-reset').click();
    await expect(page.getByTestId('tech-board-active')).toHaveCount(0);

    // 暂停与继续；间隔记在本机
    await page.mouse.move(5, 5);
    await page.getByTestId('tech-board-pause').click();
    await expect(page.getByTestId('tech-board-pause')).toHaveText('继续');
    await expect(board).toHaveAttribute('data-paused', 'true');
    await page.getByTestId('tech-board-pause').click();
    await expect(page.getByTestId('tech-board-pause')).toHaveText('暂停');
    await page.getByTestId('tech-board-interval').selectOption('15');
    await page.reload();
    await expect(page.getByTestId('tech-board-interval')).toHaveValue('15');
    await page.getByTestId('tech-board-interval').selectOption('8');

    // 全屏投屏：只留看板，Esc 退出
    await page.getByTestId('tech-board-full').click();
    await expect(board).toHaveAttribute('data-full', 'true');
    await expect(page.getByTestId('tech-board-controls')).toHaveCount(0);
    const box = await board.boundingBox();
    expect(box?.width).toBeGreaterThanOrEqual((page.viewportSize()?.width ?? 0) - 1);
    await page.keyboard.press('Escape');
    await expect(board).not.toHaveAttribute('data-full', 'true');
    await expect(page.getByTestId('tech-board-controls')).toBeVisible();
  });
});
