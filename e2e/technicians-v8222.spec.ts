// 8.2.2 浏览器验收（docs/V8222_TECHNICIANS.md）：预约「一报多」默认 3 行、能再加一行；后台技师名册下面有「导入技师」与模板下载。
// 依赖演示数据（仅独立演示库）；账号：店主 linlan，密码 yuzu2026。只看页面、不提交。
import { expect, test, type Page } from '@playwright/test';
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

test('一报多：默认 3 行，再加一行变 4 行；没填客人时不能提交', async ({ page }) => {
  await login(page, 'linlan');
  await page.goto('/bookings');
  await page.getByTestId('booking-batch').click();
  const rows = page.getByTestId('batch-booking-rows');
  await expect(rows.getByLabel(/第 \d+ 行客人姓氏/)).toHaveCount(3);
  await page.getByTestId('batch-booking-add').click();
  await expect(rows.getByLabel(/第 \d+ 行客人姓氏/)).toHaveCount(4);
  await expect(page.getByTestId('batch-booking-submit')).toBeDisabled();
});

test('后台技师名册：导入技师与模板下载', async ({ page }) => {
  await login(page, 'linlan');
  await page.goto('/admin/technicians/roster');
  await expect(page.getByTestId('technician-import')).toBeVisible();
  const res = await page.request.get('/api/admin/technicians/import-template.csv');
  expect(res.ok()).toBe(true);
  expect(await res.text()).toContain('工号,姓名,花名,性别,电话,组别');
});
