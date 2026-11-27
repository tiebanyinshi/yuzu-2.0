// 8.2.13 前台界面（docs/V82213_DESK_UI.md；店主 2026-11-27 收银员工作台 demo）：发卡台没选手牌时右边是区域状态与最近发牌；
// 收银台账单里含门票的此刻应收用大字。依赖 seed-demo、seed-frontdesk-demo（仅独立演示库）；账号前台 xiaozhou，密码 yuzu2026。
import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { passPortal } from './portal';

async function login(page: Page, username: string) {
  await page.goto('/login');
  await page.fill('#username', username);
  await page.fill('#password', 'yuzu2026');
  await page.getByRole('button', { name: '登录' }).click();
  await passPortal(page);
  await expect(page.getByRole('navigation', { name: '主导航' })).toBeVisible({ timeout: 30_000 });
}

test('发卡台区域状态与最近发牌；收银台应收大字', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== '门店电脑', '会登记单据，只在门店电脑尺寸执行一次');
  await login(page, 'xiaozhou');
  const board = (await (await page.request.get('/api/frontdesk/board')).json()) as {
    tags: { code: string; zone: string; active: boolean; locked: boolean; serviceStatus: string; kind: string; visit: unknown }[];
  };
  const frees = board.tags.filter((t) => t.active && !t.locked && t.serviceStatus === 'normal' && !t.visit && t.kind === 'normal' && t.zone === 'male');
  const free = frees[Math.floor(Math.random() * frees.length)];
  test.skip(!free, '没有空闲的男宾普通柜');
  const checkin = await page.request.post('/api/frontdesk/checkins', { data: { clientKey: randomUUID(), guests: [{ tagCode: free!.code, zone: 'male' }] } });
  expect(checkin.ok(), await checkin.text()).toBe(true);
  const visitId = ((await checkin.json()) as { visits: { id: number }[] }).visits[0]!.id;

  await page.goto('/crm/frontdesk');
  const overview = page.getByTestId('desk-overview');
  await expect(overview).toBeVisible();
  // 每个有普通柜的分区推荐一个区
  await expect(overview.getByText('推荐往这里发').first()).toBeVisible();
  // 刚发的牌在最近发牌里，还能撤销；点一下打开客人卡
  const recent = page.getByTestId('recent-issues');
  await expect(recent).toContainText(free!.code);
  await expect(recent.getByRole('button', { name: new RegExp(free!.code) })).toContainText('可撤');
  await recent.getByRole('button', { name: new RegExp(free!.code) }).click();
  await expect(overview).toHaveCount(0);

  // 收银台：此刻应收（含门票）是大字
  await page.goto(`/crm/cashier?v=${visitId}`);
  await expect(page.getByTestId('bill-due')).toBeVisible();
  await expect(page.getByTestId('bill-total')).toBeVisible();
});
