// 采购商城（8.1.32，docs/MALL_V8132.md）：店主建两家供应商的报价并审核上架 → 在商城里比价、加清单、提交 → 我的采购需求看到这张单；
// 自主申请；SKU 维护页。只在门店电脑尺寸跑一次（会写数据：SKU 与需求单）。
import { expect, test, type Page } from '@playwright/test';
import { passPortal } from './portal';

async function login(page: Page) {
  await page.goto('/login');
  await page.fill('#username', 'linlan');
  await page.fill('#password', 'yuzu2026');
  await page.getByRole('button', { name: '登录' }).click();
  await passPortal(page);
}

test.describe('采购商城', () => {
  test.skip(({ viewport }) => (viewport?.width ?? 0) < 1280, '会写数据的流程只在门店电脑尺寸执行一次');

  test('比价 → 加清单 → 提交 → 我的采购需求；自主申请；SKU 维护', async ({ page }) => {
    await login(page);
    const stamp = Date.now().toString(36);
    // 准备：两家供应商的报价，店主自己提交、自己审核上架（店主可以）
    const mats = (await (await page.request.get('/api/inventory/materials')).json()) as { id: number; active: boolean; tracked: boolean }[];
    const sups = (await (await page.request.get('/api/inventory/suppliers')).json()) as { id: number; active: boolean; admission: string }[];
    const mat = mats.find((m) => m.active && m.tracked)!;
    const ok = sups.filter((s) => s.active && s.admission === 'approved').slice(0, 2);
    expect(ok.length).toBe(2);
    const today = ((await (await page.request.get('/api/auth/me')).json()) as { calendarToday: string }).calendarToday;
    const valid = `${Number(today.slice(0, 4)) + 1}${today.slice(4)}`;
    const skuIds: number[] = [];
    for (const [i, s] of ok.entries()) {
      const r = await page.request.post('/api/erp/shop/skus', {
        data: {
          materialId: mat.id,
          supplierId: s.id,
          skuCode: `E2E-${stamp}-${i}`,
          priceCents: 1000 + i * 100,
          taxRateBp: 1300,
          moqMilli: 2000,
          leadDays: 3,
          freightCents: 0,
          validUntil: valid,
          storeIds: [],
        },
      });
      expect(r.status()).toBe(201);
      const id = ((await r.json()) as { id: number }).id;
      expect((await page.request.post(`/api/erp/shop/skus/${id}/submit`, { data: {} })).ok()).toBe(true);
      expect((await page.request.post(`/api/erp/shop/skus/${id}/approve`, { data: {} })).ok()).toBe(true);
      skuIds.push(id);
    }

    // 商城首页 → 比价
    await page.goto('/erp/shop');
    await expect(page.getByTestId('shop-home')).toBeVisible();
    await page.getByTestId(`shop-item-${mat.id}`).click();
    await expect(page.getByTestId(`shop-offer-${skuIds[0]}`)).toContainText('可采购');
    await expect(page.getByTestId(`shop-offer-${skuIds[1]}`)).toBeVisible();
    // 低于起订量加不进去
    await page.locator(`#shop-qty-${skuIds[0]}`).fill('1');
    await page.getByTestId(`shop-add-${skuIds[0]}`).click();
    await expect(page.getByText(/数量不能低于起订量/)).toBeVisible();
    await page.locator(`#shop-qty-${skuIds[0]}`).fill('3');
    await page.getByTestId(`shop-add-${skuIds[0]}`).click();
    await expect(page.getByText('已加入采购清单（3', { exact: false })).toBeVisible();

    // 清单 → 提交
    await page
      .getByTestId('shop-tabs')
      .getByRole('link', { name: /采购清单/ })
      .click();
    await expect(page.getByTestId(`shop-cart-line-${skuIds[0]}`)).toBeVisible();
    // 3 × 10.00 ×1.13 = 33.90
    await expect(page.getByTestId('shop-cart-total')).toContainText('33.90');
    await page.getByTestId('shop-to-checkout').click();
    // 第 1 步：采购业务信息（店主没有所属部门：替一个部门提，与 ERP 填单页一样）
    await page.locator('#shop-dept').selectOption({ index: 1 });
    if (!(await page.locator('#shop-entity').inputValue())) await page.locator('#shop-entity').selectOption({ index: 1 });
    await page.locator('#shop-budget').fill('E2E 预算');
    await page.getByTestId('shop-checkout-next').click();
    // 第 2 步：交付要求
    await page.locator('#shop-needby').fill(today);
    await page.locator('#shop-address').fill('本店仓库');
    await page.getByTestId('shop-priority-high').click();
    await page.getByTestId('shop-checkout-next').click();
    // 第 3 步：提交前确认 + 审批路由预览
    await expect(page.getByTestId('shop-route-preview-nodes')).toBeVisible();
    await page.getByTestId('shop-submit').click();
    await expect(page.getByTestId('shop-request-detail')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('shop-request-detail')).toContainText('XQ');
    await expect(page.getByTestId('shop-request-detail')).toContainText('E2E 预算');

    // 我的采购需求里有它；清单已清空
    await page.getByTestId('shop-tabs').getByRole('link', { name: '我的采购需求' }).click();
    await expect(page.getByTestId('shop-mine')).toBeVisible();
    await page
      .getByTestId('shop-tabs')
      .getByRole('link', { name: /采购清单/ })
      .click();
    await expect(page.getByTestId('shop-cart-empty')).toBeVisible();

    // 自主申请
    await page.getByTestId('shop-tabs').getByRole('link', { name: '自主申请' }).click();
    await page.locator('#sc-name').fill(`E2E 定制物品 ${stamp}`);
    await page.locator('#sc-details').fill('规格：蓝色，30cm');
    await page.locator('#sc-reason').fill('E2E 测试用');
    await page.locator('#shop-budget').fill('E2E 预算');
    await page.locator('#shop-needby').fill(today);
    await page.locator('#shop-address').fill('本店仓库');
    // 店主没有所属部门：替一个部门提（与 ERP 填单页一样）
    await page.locator('#shop-dept').selectOption({ index: 1 });
    if (!(await page.locator('#shop-entity').inputValue())) await page.locator('#shop-entity').selectOption({ index: 1 });
    await page.getByTestId('shop-custom-submit').click();
    await expect(page.getByTestId('shop-request-detail')).toContainText(`E2E 定制物品 ${stamp}`, { timeout: 20_000 });

    // SKU 维护：店主看得到、有「新建 SKU」
    await page.getByTestId('shop-tabs').getByRole('link', { name: 'SKU 维护' }).click();
    await expect(page.getByTestId(`shop-sku-${skuIds[0]}`)).toContainText('已上架');
    // 用完停掉，免得重复执行时清单里报价越来越多
    for (const id of skuIds) await page.request.post(`/api/erp/shop/skus/${id}/disable`, { data: {} });
  });

  test('商品图（8.1.48）：物料主档传一张图、保存 → 商城卡片与商品页都换上这张图', async ({ page }) => {
    await login(page);
    const cat = (await (await page.request.get('/api/erp/shop/catalog')).json()) as { items: { material: { id: number; imageIds: number[] } }[] };
    const item = cat.items[0];
    expect(item, '前一条用例上架过报价，目录里应该有东西').toBeTruthy();
    const id = item!.material.id;
    // 先清空（重复跑时从没有图开始）
    await page.request.put(`/api/erp/shop/materials/${id}/images`, { data: { imageIds: [], expectedImageIds: item!.material.imageIds } });
    await page.goto('/erp/shop/materials');
    await page.getByTestId(`shop-mat-open-${id}`).click();
    const box = page.getByTestId('shop-mat-images');
    await expect(box).toContainText('商品图');
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
    await page.getByTestId('shop-mat-images-add-input').setInputFiles({ name: 'cover.png', mimeType: 'image/png', buffer: png });
    await expect(box.locator('img')).toHaveCount(1);
    await page.getByTestId('shop-mat-images-save').click();
    await expect(page.getByText('商品图已保存')).toBeVisible();
    // 商城：卡片的封面是这张图（不是占位）
    await page.goto('/erp/shop');
    const card = page.getByTestId(`shop-item-${id}`);
    await expect(card.locator('img')).toHaveAttribute('src', /\/api\/erp\/shop\/images\/\d+$/);
    await card.click();
    await expect(page.getByTestId('shop-gallery').locator('img')).toHaveAttribute('src', /\/api\/erp\/shop\/images\/\d+$/);
    // 收尾：清空，别影响别的用例
    const now = (await (await page.request.get('/api/erp/shop/catalog')).json()) as { items: { material: { id: number; imageIds: number[] } }[] };
    const cur = now.items.find((i) => i.material.id === id)!.material.imageIds;
    expect((await page.request.put(`/api/erp/shop/materials/${id}/images`, { data: { imageIds: [], expectedImageIds: cur } })).ok()).toBe(true);
  });
});
