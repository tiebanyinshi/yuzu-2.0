// OA-03 浏览器验收：左侧导航的通知铃铛与「通知」页（docs/OA.md 第 6 节）。
// 依赖演示数据（仅独立演示库），账号：店主 linlan，密码 yuzu2026。只读，可重复执行。
// 通知由各模块在服务端发（OA-04 起接上）；这里核对入口、未读 / 全部切换、全部标为已读后铃铛清零。
import { expect, test, type Page } from '@playwright/test';
import { passPortal } from './portal';

async function login(page: Page, username: string) {
  await page.goto('/login');
  await page.fill('#username', username);
  await page.fill('#password', 'yuzu2026');
  await page.getByRole('button', { name: '登录' }).click();
  await passPortal(page);
  await page.waitForURL((u) => !u.pathname.startsWith('/login'));
}

test.describe('OA-03 站内通知', () => {
  test('铃铛进「通知」页；未读 / 全部切换；全部标为已读后没有未读', async ({ page }) => {
    await login(page, 'linlan');
    const bell = page.getByTestId('notification-bell');
    await expect(bell).toBeVisible();
    await bell.click();
    await expect(page).toHaveURL(/\/oa\/notifications$/);
    await expect(page.getByRole('heading', { level: 1, name: '通知' })).toBeVisible();

    // 等列表取回来；有未读就全部标为已读；之后未读列表是空的、铃铛不显示数字
    const list = page.getByTestId('notifications-list');
    await expect(list.or(page.getByTestId('notifications-empty'))).toBeVisible();
    const readAll = page.getByTestId('notifications-read-all');
    if (await list.isVisible()) {
      await expect(readAll).toBeEnabled();
      await readAll.click();
    }
    await expect(readAll).toBeDisabled();
    await expect(page.getByTestId('notifications-empty')).toContainText('没有未读的通知');
    await expect(page.getByTestId('notification-unread')).toHaveCount(0);

    // 全部：有就是列表，没有就是空状态
    await page.getByRole('radio', { name: '全部' }).click();
    await expect(page.getByTestId('notifications-list').or(page.getByTestId('notifications-empty'))).toBeVisible();
  });
});
