// 安保巡场起始时间（店主 2026-11-24，docs/PATROL_V809.md 第 12 节，XC17、XC18）：
// 后台「安保巡场 → 设置」选巡查起始时间（只有整点）、间隔 2 小时，预览 9:00 起每 2 小时一轮（巡场的一天从起始时间起，XC19）；保存后再取回来是 9:00；用完恢复原来的设置。
import { expect, test, type Page } from '@playwright/test';
import { passPortal } from './portal';

const PASSWORD = 'yuzu2026';

async function login(page: Page, username: string) {
  await page.goto('/login');
  await page.fill('#username', username);
  await page.fill('#password', PASSWORD);
  await page.getByRole('button', { name: '登录' }).click();
  await passPortal(page);
  await page.waitForURL((u) => !u.pathname.startsWith('/login'));
}

test('巡查起始时间：只能选整点，预览按「起始 + N × 间隔」排，保存后生效', async ({ page }) => {
  await login(page, 'linlan');
  const modules = ((await (await page.request.get('/api/auth/me')).json()) as { erpModules: string[] }).erpModules;
  test.skip(!modules.includes('patrol'), '安保巡场模块没开');
  const before = (await (await page.request.get('/api/erp/patrol/settings')).json()) as { roundMinutes: number; startHour: number | null };

  await page.goto('/admin/patrol');
  await page.getByRole('radio', { name: '设置' }).click();
  const start = page.getByTestId('patrol-start-hour');
  await expect(start).toBeVisible();
  // 选项：「不设」+ 24 个整点，没有分钟
  const options = await start.locator('option').allTextContents();
  expect(options).toHaveLength(25);
  expect(options.slice(1)).toEqual(Array.from({ length: 24 }, (_, h) => `从 ${String(h).padStart(2, '0')}:00 起`));

  await page.getByTestId('patrol-round-minutes').selectOption('120');
  await start.selectOption('9');
  const preview = page.getByTestId('patrol-round-preview');
  await expect(preview).toContainText('09:00–11:00');
  await expect(preview).toContainText('11:00–13:00');
  await expect(preview).toContainText('13:00–15:00');

  await page.getByTestId('patrol-settings-save').click();
  await expect(page.getByText('已保存')).toBeVisible();
  const saved = (await (await page.request.get('/api/erp/patrol/settings')).json()) as { roundMinutes: number; startHour: number | null; rev: number; departmentIds: number[]; viewerIds: number[] };
  expect(saved).toMatchObject({ roundMinutes: 120, startHour: 9 });

  // 恢复原来的设置（不影响别的用例）
  const back = await page.request.put('/api/erp/patrol/settings', {
    data: { departmentIds: saved.departmentIds, viewerIds: saved.viewerIds, roundMinutes: before.roundMinutes, startHour: before.startHour, rev: saved.rev },
  });
  expect(back.ok()).toBe(true);
});
