// 8.2.14 前台改良（docs/V82214_DESK_IMPROVE.md；店主 2026-11-27 收银员工作台 demo）：
//   接待发牌按人数分牌（只填男几位，按推荐区自动分）、结账记录按牌号搜、回车打开。
// 依赖 seed-demo、seed-frontdesk-demo（仅独立演示库）；账号前台 xiaozhou，密码 yuzu2026。可重复执行（发出去的牌最后撤销）。
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

test('按人数发牌、结账记录搜索', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== '门店电脑', '会登记单据，只在门店电脑尺寸执行一次');
  await login(page, 'xiaozhou');
  await page.goto('/crm/frontdesk');
  await page.getByTestId('open-checkin').click();
  // 只填男几位，回车：按推荐区分两张男宾牌
  await page.getByTestId('checkin-count-male').fill('２');
  await page.getByTestId('checkin-count-male').press('Enter');
  const tagInputs = page.locator('[data-tag-input]');
  await expect(tagInputs).toHaveCount(2);
  const codes = [await tagInputs.nth(0).inputValue(), await tagInputs.nth(1).inputValue()];
  expect(codes[0]).not.toBe('');
  expect(codes[1]).not.toBe('');
  expect(codes[0]).not.toBe(codes[1]);
  // 回车不发牌：数字框里的回车只分牌（还没点「确认发牌」）
  await expect(page.getByTestId('checkin-submit')).toBeVisible();
  await page.keyboard.press('Escape');

  // 结账记录搜索：搜一个对不上的，列表说没有
  await page.goto('/crm/cashier');
  await page.getByTestId('open-checkouts').click();
  const find = page.getByTestId('checkout-records-find');
  if (await find.count()) {
    await find.fill('不存在的牌号ZZZ');
    await expect(page.getByTestId('checkout-records')).toContainText('没有对上');
  }
});
