// 8.2.1 批 1 收银台（docs/V8221_CASHIER.md）：没打开手牌时按 F9 先弹「选手牌」，选好接着打开结账；
// 账单一行旁边的「折」九折以内直接打，行上有「折」角标、写原价与经办人；按「?」看快捷键一览。
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

test('收银台：F9 先选手牌再结账、单项打折、快捷键一览', async ({ page }) => {
  await login(page, 'xiaozhou');
  const board = (await (await page.request.get('/api/frontdesk/board')).json()) as { tags: BoardTag[] };
  const free = board.tags.find((t) => t.active && !t.locked && t.serviceStatus === 'normal' && !t.visit && t.kind === 'normal' && t.zone === 'male');
  test.skip(!free, '没有空闲的男宾普通柜');
  const checkin = await page.request.post('/api/frontdesk/checkins', { data: { clientKey: randomUUID(), guests: [{ tagCode: free!.code, zone: 'male' }] } });
  expect(checkin.ok(), await checkin.text()).toBe(true);
  const visitId = ((await checkin.json()) as { visits: { id: number }[] }).visits[0]!.id;
  const post = await page.request.post(`/api/frontdesk/visits/${visitId}/charges`, { data: { clientKey: randomUUID(), customLines: [{ name: '开瓶费', amount: 10000 }], expectedTotal: 10000 } });
  expect(post.ok(), await post.text()).toBe(true);

  await page.goto('/crm/cashier');
  await page.keyboard.press('?');
  await expect(page.getByTestId('hotkey-help')).toContainText('买单（结账）');
  await page.keyboard.press('Escape');

  // 没打开手牌时按 F9：先选手牌，选好接着打开结账
  await page.keyboard.press('F9');
  await expect(page.getByTestId('hotkey-pick-tag')).toBeVisible();
  await page.getByTestId('hotkey-pick-input').fill(free!.code);
  await page.getByTestId('hotkey-pick-input').press('Enter');
  await expect(page.getByTestId('checkout')).toBeVisible();
  await page.keyboard.press('Escape');

  // 单项打折：九折以内直接打
  const line = page.locator('[data-testid^="line-"][data-testid$="-discount-open"]').first();
  await line.click();
  await page.getByRole('button', { name: '9 折', exact: true }).click();
  await page.getByTestId('line-discount-submit').click();
  await expect(page.locator('[data-testid$="-discount"]').first()).toContainText('9 折');
  await expect(page.getByTestId('bill-line-discount')).toContainText('单项打折已减');
});
