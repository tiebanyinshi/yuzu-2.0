// 系统门户页（店主 2026-11-24《系统门户页改造需求说明》，docs/PORTAL.md）：登录后先到门户页；四大板块卡片；
// 顶栏右侧通知铃铛（面板）、环境标识、版本号、头像菜单；没有权限的板块置灰、点不进去；窄屏两列。
import { expect, test, type Page } from '@playwright/test';

const PASSWORD = 'yuzu2026';

async function loginToPortal(page: Page, username: string) {
  await page.goto('/login');
  await page.fill('#username', username);
  await page.fill('#password', PASSWORD);
  await page.getByRole('button', { name: '登录' }).click();
  await page.waitForURL((u) => u.pathname === '/portal', { timeout: 30_000 });
  await expect(page.getByTestId('portal')).toBeVisible();
}

test.describe('系统门户页', () => {
  test('店主登录后先到门户页：四个板块都能进，各自进到原来的系统；顶栏有铃铛、环境标识、版本号、头像', async ({ page }) => {
    await loginToPortal(page, 'linlan');
    for (const k of ['yuzu', 'erp', 'office', 'admin']) await expect(page.getByTestId(`portal-board-${k}`)).toBeVisible();
    await expect(page.getByTestId('portal-welcome')).toContainText('林岚');
    await expect(page.getByTestId('instance-badge')).toBeVisible();
    await expect(page.getByTestId('portal-version')).toContainText('v');

    // 通知铃铛：点开是面板，「查看全部通知」进「通知」页
    await page.getByTestId('notification-bell').click();
    await expect(page.getByTestId('notification-panel')).toBeVisible();
    await page.getByTestId('notification-panel-all').click();
    await expect(page).toHaveURL(/\/oa\/notifications$/);

    // 四个板块各进一遍
    const go = async (key: string, url: RegExp, check: () => Promise<void>) => {
      await page.goto('/portal');
      await page.getByTestId(`portal-board-${key}`).click();
      await expect(page).toHaveURL(url);
      await check();
    };
    await go('yuzu', /\/$/, () => expect(page.getByRole('heading', { name: '会员工作台' })).toBeVisible());
    await go('erp', /\/erp/, () => expect(page.getByTestId('erp-shell')).toBeVisible());
    await go('office', /\/oa/, async () => {});
    await go('admin', /\/admin/, () => expect(page.getByTestId('admin-shell')).toBeVisible());

    // 头像菜单：退出登录回到登录页
    await page.goto('/portal');
    await page.getByTestId('user-menu').click();
    await page.getByTestId('user-menu-logout').click();
    await expect(page).toHaveURL(/\/login$/);
  });

  test('没有权限的板块显示但置灰、点不进去', async ({ page }) => {
    // 店员（xiaozhou）没有 ERP
    await loginToPortal(page, 'xiaozhou');
    const erp = page.getByTestId('portal-board-erp');
    await expect(erp).toHaveAttribute('data-disabled', 'true');
    await expect(erp).toContainText('没有这个板块的权限');
    await erp.click({ force: true });
    await expect(page).toHaveURL(/\/portal$/);
    await expect(page.getByTestId('portal-board-yuzu')).not.toHaveAttribute('data-disabled', 'true');
  });

  test('窄屏：四张卡片两列两行，通知面板不伸出屏幕', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await loginToPortal(page, 'linlan');
    const boxes = await Promise.all(['yuzu', 'erp', 'office', 'admin'].map(async (k) => (await page.getByTestId(`portal-board-${k}`).boundingBox())!));
    expect(Math.abs(boxes[0]!.y - boxes[1]!.y)).toBeLessThan(2);
    expect(boxes[2]!.y).toBeGreaterThan(boxes[0]!.y + boxes[0]!.height - 2);
    expect(Math.abs(boxes[0]!.x - boxes[2]!.x)).toBeLessThan(2);
    // 窄屏顶栏也常显版本号（AGENTS.md）
    await expect(page.getByTestId('portal-version')).toBeVisible();
    // 页面不横向滚动
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    // 通知面板整个在屏幕里（Codex 审查 023cc78）
    await page.getByTestId('notification-bell').click();
    const panel = (await page.getByTestId('notification-panel').boundingBox())!;
    expect(panel.x).toBeGreaterThanOrEqual(0);
    expect(panel.x + panel.width).toBeLessThanOrEqual(390);
  });
});
