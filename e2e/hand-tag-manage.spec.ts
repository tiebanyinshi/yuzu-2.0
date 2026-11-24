// 手牌管理（店主 2026-11-24，docs/FRONTDESK_TAGS_V8127.md）的浏览器验收：
//   ① 管理 → 手牌 →「批量添加与导入」：按规则（数量、起始号码、位数、前缀、排除尾数 4 和 7）预览，再添加，号码不重、不含尾数 4 / 7；
//   ② 手牌池点一张：标「维修中」带说明 → 手牌池里换色；前台看板上同色、点了提示换一张；改回正常 → 前台照常是空闲；
//   ③ 改牌号；删除要勾确认，删了的手牌池里没有了。
// 依赖演示数据（值班经理 zhangjl，密码 yuzu2026）。每次用一个新的号段（前缀 ZQ、起始号码随机），做完把建的牌都删掉；只在门店电脑尺寸执行。
import { expect, test, type Page } from '@playwright/test';

const PASSWORD = 'yuzu2026';

async function login(page: Page, username: string) {
  await page.goto('/login');
  await page.fill('#username', username);
  await page.fill('#password', PASSWORD);
  await page.getByRole('button', { name: '登录' }).click();
  await expect(page.getByRole('navigation', { name: '主导航' })).toBeVisible({ timeout: 30_000 });
}

type Tag = { id: number; code: string; serviceStatus: string };

test.describe('手牌管理', () => {
  test.beforeEach(({}, testInfo) => {
    test.skip(testInfo.project.name !== '门店电脑', '会建、删手牌，只在门店电脑尺寸执行一次');
  });

  test('按规则批量添加 → 维修中（前台发不出）→ 恢复 → 改牌号 → 二次确认删除', async ({ page }) => {
    await login(page, 'zhangjl');
    const start = 100 + Math.floor(Math.random() * 800);
    const created: string[] = [];
    try {
      // ① 批量添加
      await page.goto('/admin/tags/create');
      const card = page.getByTestId('tag-generate');
      await card.getByTestId('gen-count').fill('6');
      await card.getByTestId('gen-start').fill(String(start));
      await card.getByTestId('gen-width').fill('4');
      await card.getByTestId('gen-prefix').fill('ZQ');
      await card.getByTestId('gen-skip-end').getByRole('button', { name: '7', exact: true }).click();
      await expect(card.getByTestId('gen-create')).toBeDisabled();
      await card.getByTestId('gen-preview').click();
      const plan = card.getByTestId('gen-plan');
      await expect(plan).toContainText('将添加 6 张');
      const codes = (await plan.locator('span.num').allTextContents()).map((s) => s.trim());
      expect(codes).toHaveLength(6);
      expect(new Set(codes).size).toBe(6);
      for (const c of codes) expect(c).toMatch(/^ZQ\d{4}$/), expect(c).not.toMatch(/[47]$/);
      await card.getByTestId('gen-create').click();
      created.push(...codes);
      await expect(page.getByText(/已添加 6 张/)).toBeVisible();

      // ② 维修中
      const [first, second, third] = codes as [string, string, string];
      await page.goto('/admin/tags/pool');
      await page.getByTestId(`admin-tag-${first}`).click();
      const dialog = page.getByRole('dialog');
      const service = dialog.getByTestId('tag-service-field');
      await service.getByRole('radio', { name: '维修中' }).or(service.getByRole('button', { name: '维修中' })).first().click();
      await service.getByTestId('tag-service-note').fill('锁坏了');
      await service.getByTestId('tag-service-save').click();
      await expect(dialog).toHaveCount(0);
      await expect(page.getByTestId(`admin-tag-${first}`)).toHaveAttribute('data-service', 'repair');

      await page.goto('/frontdesk');
      const tile = page.getByTestId(`tag-${first}`);
      await expect(tile).toHaveAttribute('data-state', 'repair');
      await tile.click();
      await expect(page.getByText(`手牌 ${first} 维修中，请换一张`)).toBeVisible();
      await expect(page.getByRole('dialog')).toHaveCount(0);

      // 恢复正常 → 前台空闲
      await page.goto('/admin/tags/pool');
      await page.getByTestId(`admin-tag-${first}`).click();
      const service2 = page.getByRole('dialog').getByTestId('tag-service-field');
      await service2.getByRole('radio', { name: '正常' }).or(service2.getByRole('button', { name: '正常' })).first().click();
      await service2.getByTestId('tag-service-save').click();
      await expect(page.getByTestId(`admin-tag-${first}`)).toHaveAttribute('data-service', 'normal');
      await page.goto('/frontdesk');
      await expect(page.getByTestId(`tag-${first}`)).toHaveAttribute('data-state', 'free');

      // ③ 改牌号
      const renamed = `ZQ${String(start + 900).padStart(4, '0')}`.slice(0, 6);
      await page.goto('/admin/tags/pool');
      await page.getByTestId(`admin-tag-${second}`).click();
      await page.getByRole('dialog').getByTestId('tag-code').fill(renamed);
      await page.getByRole('dialog').getByTestId('tag-save').click();
      await expect(page.getByTestId(`admin-tag-${renamed}`)).toBeVisible();
      created.push(renamed);

      // 删除：要勾确认
      await page.getByTestId(`admin-tag-${third}`).click();
      const del = page.getByRole('dialog').getByTestId('tag-delete-field');
      await del.getByTestId('tag-delete').click();
      await expect(del.getByTestId('tag-delete-confirm')).toBeDisabled();
      await del.getByText(`确认删除手牌`).click();
      await del.getByTestId('tag-delete-confirm').click();
      await expect(page.getByTestId(`admin-tag-${third}`)).toHaveCount(0);
    } finally {
      // 清理：这次建的牌都删掉（删过的、改过名的接口按现有牌号找）
      const all = (await (await page.request.get('/api/frontdesk/tags')).json()) as Tag[];
      for (const t of all.filter((x) => created.includes(x.code))) await page.request.post(`/api/frontdesk/tags/${t.id}/delete`);
    }
  });
});
