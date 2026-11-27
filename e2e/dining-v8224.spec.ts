// 8.2.4 餐饮浏览器验收（docs/V8224_DINING.md）：后台建包房房型、桌台挂房型；分组默认档口与核对列表；餐饮规则里的门店服务费、返台时限。
// 依赖演示数据（仅独立演示库）；账号：店主 linlan，密码 yuzu2026。房型名带随机后缀，可重复执行（房型不删，留着停用也行）。
import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import type { TablesAdmin } from '../src/shared/dining';
import { passPortal } from './portal';

const PASSWORD = 'yuzu2026';

async function login(page: Page, username: string) {
  await page.goto('/login');
  await page.fill('#username', username);
  await page.fill('#password', PASSWORD);
  await page.getByRole('button', { name: '登录' }).click();
  await passPortal(page);
  await expect(page.getByRole('navigation', { name: '主导航' })).toBeVisible({ timeout: 30_000 });
}

test.describe('8.2.4 餐饮后台', () => {
  test('建房型（低消 + 中消按人数）→ 列表写明低消与中消；分组默认档口卡片与核对列表在「档口与出品」里', async ({ page }) => {
    await login(page, 'linlan');
    const name = `E2E${randomUUID().slice(0, 4)}`;
    await page.goto('/admin/dining/tables');
    await page.getByTestId('room-type-new').click();
    await page.getByTestId('room-type-name').fill(name);
    await page.getByTestId('room-type-min').fill('500');
    await page.getByTestId('room-type-mid').fill('300');
    await page.getByLabel('或人数不超过').fill('2');
    await page.getByTestId('room-type-save').click();
    await expect(page.getByTestId(`room-type-${name}`)).toContainText('低消 ¥500.00 · 中消 ¥300.00（2 人以下）');
    const admin = (await (await page.request.get('/api/admin/dining/tables')).json()) as TablesAdmin;
    expect(admin.roomTypes.find((r) => r.name === name)).toMatchObject({ chargeMode: 'min_spend', minSpend: 50000, midSpend: 30000, midMaxGuests: 2 });

    await page.goto('/admin/dining/stations');
    await expect(page.getByTestId('dining-group-stations')).toBeVisible();
    await expect(page.getByTestId('dining-group-stations')).toContainText('核对：菜自己的档口与分组默认不一致的菜');

    await page.goto('/admin/dining/rules');
    await expect(page.getByTestId('dining-service-fee')).toBeVisible();
    await expect(page.getByTestId('dining-return-window')).toHaveValue('30');
  });
});
