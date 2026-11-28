// 8.2.27 前台快捷键（docs/V82227_HOTKEYS.md；店主 2026-11-27 收银员工作台 demo）：
//   ⌥0 全部功能搜索跳页；收银台 F9 买单 → ⌥数字加现金（光标落到金额）→ 实给填全角数字、找零大时 F9 先提醒、再按一次结清。
// 依赖 seed-demo、seed-frontdesk-demo（仅独立演示库）；账号前台 xiaozhou，密码 yuzu2026。每次挑一张空闲手牌，可重复执行。
import { randomUUID } from 'node:crypto';
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

interface BoardTag {
  code: string;
  zone: 'male' | 'female';
  active: boolean;
  locked: boolean;
  serviceStatus: string;
  kind: string;
  visit: unknown;
}

test('前台快捷键：⌥0 跳页、F9 买单、⌥数字加现金、找零大要再确认', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== '门店电脑', '会登记单据，只在门店电脑尺寸执行一次');
  await login(page, 'xiaozhou');

  // ⌥0：全部功能，搜「收银」回车
  await page.keyboard.press('Alt+Digit0');
  await expect(page.getByTestId('command-palette')).toBeVisible();
  await page.getByTestId('command-palette-input').fill('收银');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/crm\/cashier/);

  const board = (await (await page.request.get('/api/frontdesk/board')).json()) as { tags: BoardTag[] };
  const frees = board.tags.filter((t) => t.active && !t.locked && t.serviceStatus === 'normal' && !t.visit && t.kind === 'normal' && t.zone === 'male');
  const free = frees[Math.floor(Math.random() * frees.length)];
  test.skip(!free, '没有空闲的男宾普通柜');
  const checkin = await page.request.post('/api/frontdesk/checkins', { data: { clientKey: randomUUID(), guests: [{ tagCode: free!.code, zone: 'male' }] } });
  expect(checkin.ok(), await checkin.text()).toBe(true);
  const visitId = ((await checkin.json()) as { visits: { id: number }[] }).visits[0]!.id;
  await page.request.post('/api/shifts', { data: { openingCash: 0 } });
  await page.goto(`/crm/cashier?v=${visitId}`);
  await expect(page.getByTestId('receipt')).toBeVisible();

  // F9 买单
  await page.locator('body').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('F9');
  const dialog = page.getByTestId('checkout');
  await expect(dialog).toBeVisible();
  const ticket = page.getByTestId(`checkout-ticket-${free!.code}`).locator('select');
  if (await ticket.count()) await ticket.selectOption({ index: 1 });
  const cash = page.getByTestId('pay-add-cash');
  await expect(cash).toBeEnabled();
  const n = await cash.getAttribute('data-paykey');
  expect(n).not.toBeNull();
  await page.keyboard.press(`Alt+Digit${n}`);
  await expect(page.getByTestId('pay-row-cash')).toBeVisible();
  await expect(page.getByLabel('现金金额')).toBeFocused();
  // 实给填全角数字（输入法开着），找零大：F9 先提醒
  await page.getByLabel('客人实给现金').fill('１００００');
  await page.keyboard.press('F9');
  await expect(page.getByTestId('checkout-big-change')).toBeVisible();
  await expect(page.getByText(/已结清 · /)).toHaveCount(0);
  await page.keyboard.press('F9');
  await expect(page.getByText(/已结清 · /)).toBeVisible();
});
