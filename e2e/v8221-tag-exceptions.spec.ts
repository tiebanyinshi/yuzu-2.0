// 8.2.27 未交回、挂失手牌清单（docs/V82227_TAG_EXCEPTIONS.md）：结了账的牌在「锁牌 / 解锁」里登记未交回 →
// 工具栏「异常手牌」里看到这张牌和客人 → 回车找回。
// 依赖 seed-demo、seed-frontdesk-demo（仅独立演示库）；账号店主 linlan，密码 yuzu2026。每次挑一张空闲手牌，可重复执行。
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

test('异常手牌：登记未交回、清单里看到客人、回车找回', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== '门店电脑', '会登记单据，只在门店电脑尺寸执行一次');
  await login(page, 'linlan');
  const board = (await (await page.request.get('/api/frontdesk/board')).json()) as { tags: BoardTag[] };
  const frees = board.tags.filter((t) => t.active && !t.locked && t.serviceStatus === 'normal' && !t.visit && t.kind === 'normal' && t.zone === 'male');
  const free = frees[Math.floor(Math.random() * frees.length)];
  test.skip(!free, '没有空闲的男宾普通柜');
  // 先让一位客人用这张牌、结账
  const checkin = await page.request.post('/api/frontdesk/checkins', { data: { clientKey: randomUUID(), guests: [{ tagCode: free!.code, zone: 'male' }] } });
  expect(checkin.ok(), await checkin.text()).toBe(true);
  const visitId = ((await checkin.json()) as { visits: { id: number }[] }).visits[0]!.id;
  await page.request.post('/api/shifts', { data: { openingCash: 0 } });
  const preview = (await (await page.request.get(`/api/frontdesk/checkout-preview?ids=${visitId}`)).json()) as { totalAmount: number };
  const done = await page.request.post('/api/frontdesk/checkouts', {
    data: { clientKey: randomUUID(), visitIds: [visitId], expectedTotal: preview.totalAmount, payments: [{ method: 'cash', amount: preview.totalAmount }] },
  });
  expect(done.ok(), await done.text()).toBe(true);

  await page.goto('/crm/frontdesk');
  await page.getByTestId('open-tag-exceptions').click();
  await expect(page.getByTestId('tag-exceptions')).toBeVisible();
  await page.getByTestId('tag-exceptions-register').click();
  await page.getByTestId('tag-lock-code').fill(free!.code);
  await expect(page.getByTestId('tag-lock-kind-unreturned')).toHaveAttribute('aria-checked', 'true');
  await page.getByLabel('锁定原因').fill('客人带走了');
  await page.getByTestId('tag-lock').click();
  await expect(page.getByText(`手牌 ${free!.code} 已登记未交回`)).toBeVisible();

  await page.getByTestId('open-tag-exceptions').click();
  const row = page.getByTestId(`tag-exception-${free!.code}`);
  await expect(row).toHaveAttribute('data-kind', 'unreturned');
  await expect(row).toContainText('客人带走了');
  // 键盘：↑↓ 选到这一行，回车找回
  await page.getByTestId('tag-exceptions').focus();
  const rows = page.getByTestId('tag-exceptions').getByRole('option');
  const n = await rows.count();
  for (let i = 0; i < n && (await row.getAttribute('aria-selected')) !== 'true'; i++) await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(page.getByText(`手牌 ${free!.code} 已找回，可以再发`)).toBeVisible();
  await expect(row).toHaveCount(0);
});
