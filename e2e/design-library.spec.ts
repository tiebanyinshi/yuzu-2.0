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
  test('一直开着的门户页：别处换了横幅，一分钟内自己跟上（不用刷新）', async ({ page }) => {
    await page.clock.install();
    await login(page);
    const stamp = Date.now();
    const cur = (await (await page.request.get('/api/design/current')).json()) as Record<string, number | null>;
    const before = cur['portal.banner'] ?? null;
    const set = (versionId: number | null, fromVersionId: number | null) =>
      page.request.post('/api/design/slots/portal.banner/assign', { data: { versionId, fromVersionId, opKey: crypto.randomUUID(), reason: 'E2E 自动跟上' } });
    if (before !== null) expect((await set(null, before)).status()).toBe(200);
    await page.goto('/');
    await expect(page.getByTestId('portal')).toBeVisible();
    await expect(page.getByTestId('portal-banner')).toHaveCount(0);
    // 「另一台电脑」换上横幅
    const up = await page.request.post(`/api/design/upload?kind=image&name=E2E跟上${stamp.toString(36)}`, {
      headers: { 'content-type': 'application/octet-stream' },
      data: solidPng((stamp + 7) % 256, (stamp >> 9) % 256, (stamp >> 17) % 256),
    });
    const v = ((await up.json()) as { latest: { id: number } }).latest.id;
    expect((await set(v, null)).status()).toBe(200);
    await page.clock.fastForward(61_000);
    await expect(page.getByTestId('portal-banner')).toBeVisible();
    expect((await set(null, v)).status()).toBe(200);
    await page.clock.fastForward(61_000);
    await expect(page.getByTestId('portal-banner')).toHaveCount(0);
  });
  test('两个窗口：一个窗口作废了待确认的一笔、又记下另一笔，另一个窗口跟着换，不会拿旧的一笔重提盖掉（Codex 审查）', async ({ page, context }) => {
    await login(page);
    const me = (await (await page.request.get('/api/auth/me')).json()) as { store: { id: number; name: string } };
    const cur = ((await (await page.request.get('/api/design/current')).json()) as Record<string, number | null>)['portal.banner'] ?? null;
    const record = (opKey: string) => ({
      slot: 'portal.banner',
      storeName: me.store.name,
      body: { versionId: null, fromVersionId: cur, opKey, reason: 'E2E 两个窗口', storeId: me.store.id },
    });
    const x = crypto.randomUUID();
    const y = crypto.randomUUID();
    await page.goto('/admin/design/library');
    await page.evaluate((r) => localStorage.setItem('yuzu.design.pendingAssign', JSON.stringify(r)), record(x));
    await page.reload();
    const tabB = await context.newPage();
    await tabB.goto('/admin/design/library');
    await expect(page.getByTestId('design-assign-op')).toHaveAttribute('data-op', x);
    await expect(tabB.getByTestId('design-assign-op')).toHaveAttribute('data-op', x);
    // B 作废 X：A 跟着没有了
    await tabB.getByTestId('design-assign-abandon').click();
    await expect(tabB.getByTestId('design-assign-pending')).toHaveCount(0);
    await expect(page.getByTestId('design-assign-pending')).toHaveCount(0);
    // B 又记下一笔 Y（模拟没收到结果）：A 显示的也是 Y
    await tabB.evaluate((r) => localStorage.setItem('yuzu.design.pendingAssign', JSON.stringify(r)), record(y));
    await expect(page.getByTestId('design-assign-op')).toHaveAttribute('data-op', y);
    // 收尾：作废 Y
    await page.getByTestId('design-assign-abandon').click();
    await expect(page.getByTestId('design-assign-pending')).toHaveCount(0);
    expect(await tabB.evaluate(() => localStorage.getItem('yuzu.design.pendingAssign'))).toBeNull();
    await tabB.close();
  });
});
