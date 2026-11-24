// 技师榜单第二批浏览器验收（docs/TECH_RANKING.md，店主 2026-11-24《技师榜单模块需求说明》第三节 7）：
//   技师管理 →「技师榜单」页签：工种标签（只看本用例的工种）、翻页（首页 / 上一页 / 页码 / 下一页 / 尾页）、搜索（技师号、姓名）、
//   状态筛选（上牌的空闲、没上牌的未当班）、综合榜 / 人气榜切换（切换后回到第 1 页）；没照片的显示占位头像；
//   在名册的编辑框里上传一张照片，榜单上换成照片；去掉（回复故意丢掉 → 结果待确认 → 原样重提）后回到占位头像。
// 依赖独立演示库；账号：店主 linlan，密码 yuzu2026。用自己的 13 位技师（RK01–RK13，工种「E2E榜单」，没有就建、有就改回来），
// 结束时（含失败）都下牌、去掉照片、停用，工种清单与技师功能的开关恢复成开始时的样子。可重复执行。
import { expect, test, type Page } from '@playwright/test';
import type { TechnicianAdminView } from '../src/shared/technician-admin';
import type { TechnicianRankingView } from '../src/shared/technician-ranking';

const PASSWORD = 'yuzu2026';
const KIND = 'E2E榜单';
const NOS = Array.from({ length: 13 }, (_, i) => `RK${String(i + 1).padStart(2, '0')}`);
const nameOf = (no: string) => `榜单${no.slice(2)}`;
// 最小的有效 PNG（1×1）
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

async function login(page: Page, username: string) {
  await page.goto('/login');
  await page.fill('#username', username);
  await page.fill('#password', PASSWORD);
  await page.getByRole('button', { name: '登录' }).click();
  await expect(page.getByRole('navigation', { name: '主导航' })).toBeVisible({ timeout: 30_000 });
}

async function send<T = unknown>(page: Page, method: 'get' | 'post' | 'put', url: string, data?: unknown): Promise<T> {
  const res = await page.request[method](url, data === undefined ? undefined : { data });
  expect(res.ok(), `${url} → ${res.status()} ${await res.text()}`).toBe(true);
  return (await res.json()) as T;
}

type AdminTech = { id: number; techNo: string; name: string; active: boolean };
const roster = async (page: Page) => (await send<{ technicians: AdminTech[] }>(page, 'get', '/api/admin/technicians')).technicians;
const mine = async (page: Page) => (await send<TechnicianRankingView>(page, 'get', '/api/technician-ranking')).techs.filter((t) => NOS.includes(t.techNo));
const body = (no: string, active: boolean) => ({ name: nameOf(no), nickname: '', kind: KIND, gender: 'female', grade: 'standard', skills: [] as string[], active, sortOrder: 0, note: '' });

/** 去掉照片：按名册读回现在的照片版本号带上（换、去掉照片都按版本号写） */
async function removePhoto(page: Page, id: number) {
  const t = (await send<TechnicianAdminView>(page, 'get', '/api/technician-admin')).technicians.find((x) => x.id === id);
  if (!t?.photoUrl) return;
  await send(page, 'put', `/api/admin/technicians/${id}/photo`, { remove: true, version: t.photoVersion });
}

async function prepare(page: Page) {
  const before = await send<{ rules: { enabled: boolean } }>(page, 'get', '/api/admin/technicians');
  await send(page, 'put', '/api/admin/technicians/rules', { enabled: true });
  const kinds = (await send<TechnicianAdminView>(page, 'get', '/api/technician-admin')).kinds;
  if (!kinds.includes(KIND)) await send(page, 'put', '/api/technician-admin/kinds', { kinds: [...kinds, KIND] });
  const list = await roster(page);
  for (const no of NOS) {
    const old = list.find((t) => t.techNo === no);
    await (old ? send(page, 'put', `/api/admin/technicians/${old.id}`, body(no, true)) : send(page, 'post', '/api/admin/technicians', { ...body(no, true), techNo: no }));
  }
  // RK01、RK02 上牌（空闲），其余没上牌（未当班）；照片都去掉
  for (const t of await mine(page)) {
    if (t.service) throw new Error(`${t.techNo} 号还有没走完的钟，请先在钟房处理`);
    const want = t.techNo === 'RK01' || t.techNo === 'RK02' ? 'idle' : 'off';
    if (want === 'off' && t.status !== 'off') await send(page, 'post', `/api/clockroom/technicians/${t.id}/state`, { action: 'sign_out' });
    if (want === 'idle' && t.status === 'off') await send(page, 'post', `/api/clockroom/technicians/${t.id}/state`, { action: 'sign_in' });
    if (t.note === 'rest') await send(page, 'post', `/api/clockroom/technicians/${t.id}/state`, { action: 'back' });
    if (t.photoUrl) await removePhoto(page, t.id);
  }
  const now = await mine(page);
  expect(now.map((t) => `${t.techNo}:${t.status}`).filter((x) => x.endsWith(':idle'))).toEqual(['RK01:idle', 'RK02:idle']);
  return { enabled: before.rules.enabled, kinds };
}

test.describe('技师榜单：工种、翻页、搜索、状态、综合 / 人气榜、占位头像与照片', () => {
  test.skip(({ viewport }) => (viewport?.width ?? 0) < 1280, '会改技师与规则的流程只在门店电脑尺寸执行一次');
  test.setTimeout(180_000);

  test('技师管理 → 技师榜单', async ({ page }) => {
    await login(page, 'linlan');
    const before = await prepare(page);
    try {
      await page.goto('/technicians/ranking');
      const ranking = page.getByTestId('tech-ranking');
      await expect(ranking).toBeVisible();
      const grid = page.getByTestId('ranking-grid');
      const cards = grid.locator('[data-testid^="ranking-card-"]');

      // ① 工种标签：只看本用例的工种 → 13 张，每页 12 张，共 2 页
      await page
        .getByTestId('ranking-kinds')
        .getByRole('button', { name: new RegExp(`^${KIND}`) })
        .click();
      await expect(page.getByTestId('ranking-page')).toHaveText('1/2');
      await expect(cards).toHaveCount(12);
      await expect(page.getByTestId('ranking-first')).toBeDisabled();
      await expect(page.getByTestId('ranking-prev')).toBeDisabled();
      // 没照片：占位头像，不是裂图
      await expect(page.getByTestId('ranking-card-RK01').getByTestId('ranking-placeholder')).toBeVisible();
      await expect(page.getByTestId('ranking-card-RK01').locator('img')).toHaveCount(0);

      // ② 翻页：下一页 1 张；尾页、首页、上一页
      await page.getByTestId('ranking-next').click();
      await expect(page.getByTestId('ranking-page')).toHaveText('2/2');
      await expect(cards).toHaveCount(1);
      await expect(page.getByTestId('ranking-next')).toBeDisabled();
      await expect(page.getByTestId('ranking-last')).toBeDisabled();
      await page.getByTestId('ranking-first').click();
      await expect(page.getByTestId('ranking-page')).toHaveText('1/2');
      await page.getByTestId('ranking-last').click();
      await expect(page.getByTestId('ranking-page')).toHaveText('2/2');
      await page.getByTestId('ranking-prev').click();
      await expect(page.getByTestId('ranking-page')).toHaveText('1/2');

      // ③ 状态筛选：空闲的只有上了牌的两位（换条件回到第 1 页）；未当班的 11 位
      await page.getByTestId('ranking-next').click();
      await page.getByTestId('ranking-status').selectOption('idle');
      await expect(page.getByTestId('ranking-page')).toHaveText('1/1');
      await expect(cards).toHaveCount(2);
      await expect(page.getByTestId('ranking-card-RK01')).toHaveAttribute('data-status', 'idle');
      await expect(page.getByTestId('ranking-card-RK01').getByTestId('ranking-status-tag')).toHaveText('空闲');
      await page.getByTestId('ranking-status').selectOption('off');
      await expect(cards).toHaveCount(11);
      await expect(page.getByTestId('ranking-card-RK13').getByTestId('ranking-status-tag')).toHaveText('未当班');
      await page.getByTestId('ranking-status').selectOption('all');

      // ④ 搜索：技师号（带不带 No. 都行）、姓名；与工种叠加
      await page.getByTestId('ranking-search').fill('No.RK13');
      await expect(cards).toHaveCount(1);
      await expect(page.getByTestId('ranking-card-RK13')).toContainText('No.RK13');
      await page.getByTestId('ranking-search').fill(nameOf('RK07'));
      await expect(cards).toHaveCount(1);
      await expect(page.getByTestId('ranking-card-RK07')).toBeVisible();
      await page.getByTestId('ranking-search').fill('rk1');
      await expect(cards).toHaveCount(4); // RK10–RK13
      await page.getByTestId('ranking-search').fill('');

      // ⑤ 综合榜 / 人气榜：切换后回到第 1 页、卡片上标人气值
      await page.getByTestId('ranking-next').click();
      await expect(page.getByTestId('ranking-board-overall')).toHaveAttribute('aria-selected', 'true');
      await expect(page.getByTestId('ranking-popularity')).toHaveCount(0);
      await page.getByTestId('ranking-board-popular').click();
      await expect(page.getByTestId('ranking-page')).toHaveText('1/2');
      await expect(page.getByTestId('ranking-card-RK01').getByTestId('ranking-popularity')).toHaveText('0');
      await page.getByTestId('ranking-board-overall').click();

      // ⑥ 名册里上传照片 → 榜单上换成照片；去掉 → 回到占位头像
      await page.getByTestId('tech-tab-roster').click();
      await page.getByTestId('tech-roster-search').fill('RK01');
      await page.getByTestId('tech-roster-edit-RK01').click();
      await page.getByTestId('technician-photo-input').setInputFiles({ name: 'rk01.png', mimeType: 'image/png', buffer: PNG });
      await expect(page.getByText('照片已更新')).toBeVisible();
      await expect(page.getByTestId('technician-photo').locator('img')).toBeVisible();
      await page.keyboard.press('Escape');
      await page.getByTestId('tech-tab-ranking').click();
      await page.getByTestId('ranking-search').fill('RK01');
      await expect(page.getByTestId('ranking-card-RK01').locator('img')).toBeVisible();
      await expect(page.getByTestId('ranking-card-RK01').getByTestId('ranking-placeholder')).toHaveCount(0);
      await page.getByTestId('tech-tab-roster').click();
      await page.getByTestId('tech-roster-edit-RK01').click();
      // 去掉照片：请求到了服务器、回复丢了（结果待确认）→ 原样重提，服务端认得出是同一个请求，原样返回
      let dropped = false;
      await page.route('**/api/admin/technicians/*/photo', async (route) => {
        if (dropped) return route.continue();
        dropped = true;
        await route.fetch(); // 服务器已经处理
        await route.abort('connectionreset'); // 回复没到页面
      });
      await page.getByTestId('technician-photo-remove').click();
      await expect(page.getByTestId('technician-photo-pending')).toBeVisible();
      await expect(page.getByTestId('technician-photo-pick')).toBeDisabled();
      await page.getByTestId('technician-photo-retry').click();
      await expect(page.getByText('照片已去掉')).toBeVisible();
      await expect(page.getByTestId('technician-photo-pending')).toHaveCount(0);
      await page.unroute('**/api/admin/technicians/*/photo');
      await page.keyboard.press('Escape');
      await page.getByTestId('tech-tab-ranking').click();
      await page.getByTestId('ranking-search').fill('RK01');
      await expect(page.getByTestId('ranking-card-RK01').getByTestId('ranking-placeholder')).toBeVisible();
    } finally {
      for (const t of await mine(page)) {
        if (!t.service && t.status !== 'off') await page.request.post(`/api/clockroom/technicians/${t.id}/state`, { data: { action: 'sign_out' } });
        if (t.photoUrl) await removePhoto(page, t.id);
      }
      for (const t of (await roster(page)).filter((x) => NOS.includes(x.techNo) && x.active)) {
        await page.request.put(`/api/admin/technicians/${t.id}`, { data: body(t.techNo, false) });
      }
      await page.request.put('/api/technician-admin/kinds', { data: { kinds: before.kinds } });
      await page.request.put('/api/admin/technicians/rules', { data: { enabled: before.enabled } });
    }
  });
});
