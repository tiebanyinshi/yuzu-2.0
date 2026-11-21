// 8.2.0 P08（docs/YUZU_REQ_V820.md 第 9 节，回测 3-1）：房态中心「在用」的房间上点水吧——只有在用的卡片有「点单」；
// 面板按分类、搜索、加份数、写备注、整单备注，下单后卡片写房内点单几单、多少钱；点单记录里逐行撤单（要原因），撤了以后记录里写谁退的。
// 依赖演示数据（店主 linlan，密码 yuzu2026；演示库有在用的派对房或在住的客房、水吧有「演示奶茶」）。下的单最后撤掉，可重复执行；只在门店电脑跑。
import { expect, test, type Page } from '@playwright/test';

async function login(page: Page) {
  await page.goto('/login');
  await page.fill('#username', 'linlan');
  await page.fill('#password', 'yuzu2026');
  await page.getByRole('button', { name: '登录' }).click();
  await expect(page.getByRole('navigation', { name: /主导航|后台/ }).first()).toBeVisible({ timeout: 30_000 });
}

/** 卡片上「房内点单 N 单」的 N（没点过为 0） */
async function orderCount(page: Page, code: string): Promise<number> {
  const line = page.getByTestId(`rc-room-${code}`).getByTestId('rc-orders');
  if ((await line.count()) === 0) return 0;
  const m = /房内点单\s*(\d+)\s*单/.exec(await line.innerText());
  return m ? Number(m[1]) : 0;
}

test.describe('8.2.0 房态点单', () => {
  test.skip(({ viewport }) => (viewport?.width ?? 0) < 1280, '只在门店电脑尺寸跑');

  test('在用的房间点水吧：面板、下单、卡片单数、点单记录里撤单', async ({ page }) => {
    await login(page);
    await page.goto('/room-center');
    await expect(page.getByTestId('rc-grid').first()).toBeVisible();
    // 只有「在用」的卡片有「点单」
    const free = page.locator('[data-testid^="rc-room-"][data-status="free"]');
    if ((await free.count()) > 0) await expect(free.first().locator('[data-testid^="rc-order-"]')).toHaveCount(0);
    const inUse = page.locator('[data-testid^="rc-room-"][data-status="in_use"]').filter({ has: page.locator('[data-testid^="rc-order-"]') });
    await expect(inUse.first()).toBeVisible();
    const code = ((await inUse.first().getAttribute('data-testid')) ?? '').replace('rc-room-', '');
    const before = await orderCount(page, code);

    await page.getByTestId(`rc-order-${code}`).click();
    const panel = page.getByTestId('room-order-panel');
    await expect(panel).toBeVisible();
    // 分类、搜索
    await panel.getByTestId('room-order-search').fill('奶茶');
    await expect(panel.getByTestId('room-order-dish-演示奶茶')).toBeVisible();
    await expect(panel.getByTestId('room-order-dish-演示牛肉面')).toHaveCount(0);
    await panel.getByTestId('room-order-add-演示奶茶').click();
    await panel.getByTestId('room-order-plus-演示奶茶').click();
    await expect(panel.getByTestId('room-order-qty-演示奶茶')).toHaveValue('2');
    await expect(panel.getByTestId('room-order-summary')).toContainText('2 份');
    await panel.getByTestId('room-order-minus-演示奶茶').click();
    await expect(panel.getByTestId('room-order-qty-演示奶茶')).toHaveValue('1');
    await panel.getByTestId('room-order-note-演示奶茶').fill('少冰');
    await panel.getByTestId('room-order-note').fill('送到房间门口');
    await expect(panel.getByTestId('room-order-summary')).toContainText('1 样');
    await page.getByTestId('room-order-submit').click();
    await expect(page.getByText(`已下单：${code} · 水吧`)).toBeVisible();
    await expect(panel).toHaveCount(0);
    await expect.poll(() => orderCount(page, code)).toBe(before + 1);

    // 点单记录：最新一单在最上面，逐行撤单
    await page.getByTestId(`rc-order-${code}`).click();
    await page.getByTestId('room-order-history-open').click();
    const row = page.getByTestId('room-order-row').first();
    await expect(row).toContainText('演示奶茶');
    await expect(row).toContainText('少冰');
    await expect(row).toContainText('整单备注：送到房间门口');
    await expect(row).toContainText('linlan');
    await row.getByTestId('room-order-void-演示奶茶').click();
    await expect(page.getByTestId('room-order-void-confirm')).toBeDisabled();
    await page.getByTestId('room-order-void-reason').fill('演示撤单');
    await page.getByTestId('room-order-void-confirm').click();
    await expect(page.getByText('已撤单')).toBeVisible();
    await expect(row.getByTestId('room-order-line').first()).toHaveAttribute('data-status', 'voided');
    await expect(row).toContainText('已退：演示撤单');
    await page.keyboard.press('Escape');
    await expect.poll(() => orderCount(page, code)).toBe(before);
  });

  test('后台：餐饮 → 档口与出品里能配房态点单的分类', async ({ page }) => {
    await login(page);
    await page.goto('/admin/dining/stations');
    const card = page.getByTestId('room-order-config');
    await expect(card).toBeVisible();
    await expect(card.getByTestId('room-order-config-water')).toContainText('水吧');
    await expect(card.getByTestId('room-order-config-fruit')).toContainText('果吧');
    await expect(card.getByTestId('room-order-config-save')).toBeDisabled();
  });
});
