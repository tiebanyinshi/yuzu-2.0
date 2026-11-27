// 8.2.6 收银台「锁牌外出」（docs/V8226_AWAY_LOCK.md）：账单里点「锁牌外出」→ 选时长、先收预售 → 锁住（清单上标「锁牌 到几点」）→ 客人回来解锁。
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

test('收银台：锁牌外出先收预售、锁到几点、客人回来解锁', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== '门店电脑', '会登记单据，只在门店电脑尺寸执行一次');
  await login(page, 'xiaozhou');
  const board = (await (await page.request.get('/api/frontdesk/board')).json()) as { tags: BoardTag[] };
  const frees = board.tags.filter((t) => t.active && !t.locked && t.serviceStatus === 'normal' && !t.visit && t.kind === 'normal' && t.zone === 'male');
  // 随机挑一张，并行的别的用例挑第一张时不撞车
  const free = frees[Math.floor(Math.random() * frees.length)];
  test.skip(!free, '没有空闲的男宾普通柜');
  const checkin = await page.request.post('/api/frontdesk/checkins', { data: { clientKey: randomUUID(), guests: [{ tagCode: free!.code, zone: 'male' }] } });
  expect(checkin.ok(), await checkin.text()).toBe(true);
  const visitId = ((await checkin.json()) as { visits: { id: number }[] }).visits[0]!.id;

  // 收预售要开班（演示库开着「收款要先开班」）：没开的开一个，已经开着的照旧
  await page.request.post('/api/shifts', { data: { openingCash: 0 } });
  await page.goto(`/crm/cashier?v=${visitId}`);
  const block = page.getByTestId('away-lock-block');
  await expect(block).toBeVisible();
  await block.getByTestId('away-lock-open').click();
  await page.getByTestId('away-lock-minutes-60').click();
  await expect(page.getByTestId('away-lock-amount')).not.toHaveValue('');
  await page.getByTestId('away-lock-amount').fill('150');
  await page.getByTestId('away-lock-submit').click();
  await expect(page.getByTestId('away-lock-state')).toContainText('锁到');
  await expect(page.getByTestId('away-lock-state')).toContainText('150.00');
  await expect(page.getByTestId(`queue-${free!.code}-away-lock`)).toBeVisible();
  // 押金里有这笔预售
  await expect(page.getByTestId('deposit-held')).toContainText('150.00');

  // 客人回来解锁
  await block.getByTestId('away-lock-open').click();
  await page.getByTestId('away-unlock-submit').click();
  await expect(page.getByTestId('away-lock-state')).toContainText('先收预售再锁牌');
  await expect(page.getByTestId(`queue-${free!.code}-away-lock`)).toHaveCount(0);
});
