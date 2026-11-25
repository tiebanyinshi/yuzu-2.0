// Design 素材库（8.1.33，docs/BOARDS.md 第 4 节）：店主上传一张图 → 设成「门户页 · 顶部横幅」→ 门户页顶上出现横幅 → 切回不用素材，横幅消失。
// 只在门店电脑尺寸跑一次（会写数据；每次用不同颜色的图，免得同一个文件被认成已有的那份）。
import { expect, test, type Page } from '@playwright/test';
import { solidPng } from '../src/server/modules/legacy/samples';
import { passPortal } from './portal';

async function login(page: Page) {
  await page.goto('/login');
  await page.fill('#username', 'linlan');
  await page.fill('#password', 'yuzu2026');
  await page.getByRole('button', { name: '登录' }).click();
  await passPortal(page);
}

test.describe('Design 素材库', () => {
  test.skip(({ viewport }) => (viewport?.width ?? 0) < 1280, '会写数据的流程只在门店电脑尺寸执行一次');

  test('上传图片 → 设成门户横幅 → 门户看得到 → 切回不用素材', async ({ page }) => {
    await login(page);
    const stamp = Date.now();
    const name = `E2E横幅${stamp.toString(36)}`;
    await page.goto('/admin/design/library');
    await expect(page.getByTestId('design-slots')).toBeVisible();
    // 门户横幅这个用途先切成不用素材（之前跑过留下的）
    const slot = page.getByTestId('design-slot-portal.banner');
    if (await page.getByTestId('design-slot-none-portal.banner').count()) {
      await page.getByTestId('design-slot-none-portal.banner').click();
      await expect(page.getByTestId('design-slot-current-portal.banner')).toContainText('不用素材');
    }

    await page
      .locator('[data-testid="design-assets"] input[type=file]')
      .first()
      .setInputFiles({ name: `${name}.png`, mimeType: 'image/png', buffer: solidPng(stamp % 256, (stamp >> 8) % 256, (stamp >> 16) % 256) });
    await expect(page.getByTestId('design-asset-grid')).toContainText(name, { timeout: 20_000 });
    const assets = (await (await page.request.get('/api/design/assets?kind=image')).json()) as { id: number; name: string }[];
    const asset = assets.find((a) => a.name === name)!;

    await page.getByTestId('design-slot-change-portal.banner').click();
    await page.getByTestId(`design-pick-${asset.id}`).click();
    await expect(page.getByTestId('design-slot-current-portal.banner')).toContainText(`${name}（第 1 版）`);

    // 加了一版以后，旧的第 1 版也能直接换上（选更早的版本）
    const v2 = await page.request.post(`/api/design/upload?kind=image&assetId=${asset.id}`, {
      headers: { 'content-type': 'application/octet-stream' },
      data: solidPng((stamp + 1) % 256, (stamp >> 8) % 256, (stamp >> 16) % 256),
    });
    expect(v2.status()).toBe(201);
    const v1Id = ((await v2.json()) as { versions: { id: number; versionNo: number }[] }).versions.find((v) => v.versionNo === 1)!.id;
    await page.getByTestId('design-slot-none-portal.banner').click();
    await expect(page.getByTestId('design-slot-current-portal.banner')).toContainText('不用素材');
    await page.getByTestId('design-slot-change-portal.banner').click();
    await page.getByTestId(`design-pick-older-${asset.id}`).click();
    await page.getByTestId(`design-pick-version-${v1Id}`).click();
    await expect(page.getByTestId('design-slot-current-portal.banner')).toContainText(`${name}（第 1 版）`);

    await page.goto('/');
    await expect(page.getByTestId('portal-banner')).toBeVisible();

    await page.goto('/admin/design/library');
    await expect(slot).toBeVisible();
    await page.getByTestId('design-slot-none-portal.banner').click();
    await expect(page.getByTestId('design-slot-current-portal.banner')).toContainText('不用素材');
    await page.goto('/');
    await expect(page.getByTestId('portal')).toBeVisible();
    await expect(page.getByTestId('portal-banner')).toHaveCount(0);
  });
});
