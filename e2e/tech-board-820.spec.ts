// 回测整改 P09（docs/YUZU_REQ_V820.md 第 10 节，回测 4-2）：技师上钟轮播——技师组里有入口；按项目 / 按区域切换；
// 筛选生效的条件写成小标签、能逐个去掉、能一键重置；暂停与继续、轮播间隔本机记住；全屏投屏只留看板，Esc 退出。只读，没有改钟的按钮。
// 只在独立演示库跑（CI 的五套 seed 或 demo-prepare 都行），数据自己备、可以重复跑：技师功能关着的打开，专用的技师项目（E2E 轮播足疗）、
// 技师（R96）没有就建；开始时技师上牌、接待一位客人点钟上钟，结束时下钟、下牌、客人结账离店。只在门店电脑跑。
// 账号：店主 linlan，密码 yuzu2026。
import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import type { BoardTag } from '../src/shared/frontdesk';

const ITEM = { name: 'E2E 轮播足疗', category: 'E2E 轮播', price: 9800, durationMinutes: 60, technicianRequired: true };
const TECH = { techNo: 'R96', name: 'E2E 轮播技师' };

async function login(page: Page) {
  await page.goto('/login');
  await page.fill('#username', 'linlan');
  await page.fill('#password', 'yuzu2026');
  await page.getByRole('button', { name: '登录' }).click();
  await expect(page.getByRole('navigation', { name: /主导航|后台/ }).first()).toBeVisible({ timeout: 30_000 });
}

async function getJson<T>(page: Page, url: string): Promise<T> {
  const res = await page.request.get(url);
  expect(res.ok(), `${url} → ${res.status()}`).toBe(true);
  return (await res.json()) as T;
}

async function send<T = unknown>(page: Page, method: 'post' | 'put', url: string, data?: unknown): Promise<T> {
  const res = await page.request[method](url, data === undefined ? {} : { data });
  expect(res.ok(), `${url} → ${res.status()} ${await res.text()}`).toBe(true);
  return (await res.json()) as T;
}

interface Board {
  technicians: { id: number; techNo: string; state: string; busy: { sessionId?: number; status: string } | null }[];
  sessions: { id: number; technicianId: number; visitId: number; status: string }[];
}
const techOf = async (page: Page) => {
  const b = await getJson<Board>(page, '/api/clockroom');
  const t = b.technicians.find((x) => x.techNo === TECH.techNo)!;
  return { tech: t, sessions: b.sessions.filter((s) => s.technicianId === t.id && (s.status === 'serving' || s.status === 'waiting')) };
};

/** 店主：技师功能、专用项目与技师；技师上牌，接待一位客人点钟上钟。返回技师功能原来开没开、来访 */
async function prepare(page: Page): Promise<{ wasEnabled: boolean; visitId: number }> {
  const items = (await getJson<{ items: { id: number; name: string; active: boolean }[] }>(page, '/api/catalog?all=1')).items;
  const item = items.find((i) => i.name === ITEM.name);
  if (!item) await send(page, 'post', '/api/items', ITEM);
  else if (!item.active) await send(page, 'put', `/api/items/${item.id}`, { ...ITEM, active: true });
  const itemId = (await getJson<{ items: { id: number; name: string }[] }>(page, '/api/catalog?all=1')).items.find((i) => i.name === ITEM.name)!.id;
  const admin = await getJson<{ rules: { enabled: boolean }; technicians: { techNo: string }[] }>(page, '/api/admin/technicians');
  if (!admin.rules.enabled) await send(page, 'put', '/api/admin/technicians/rules', { enabled: true });
  if (!admin.technicians.some((t) => t.techNo === TECH.techNo)) await send(page, 'post', '/api/admin/technicians', { ...TECH, gender: 'female', grade: 'standard' });
  // 上次中断留下的：下钟
  for (const s of (await techOf(page)).sessions) {
    if (s.status === 'serving') await send(page, 'post', `/api/clockroom/sessions/${s.id}/finish`);
    else await send(page, 'post', `/api/clockroom/sessions/${s.id}/void`, { reason: 'E2E：收掉上次留下的' });
  }
  const { tech } = await techOf(page);
  if (tech.state !== 'on') await send(page, 'post', `/api/clockroom/technicians/${tech.id}/state`, { action: tech.state === 'rest' ? 'back' : 'sign_in' });

  const board = await getJson<{ tags: (BoardTag & { id: number })[] }>(page, '/api/frontdesk/board');
  const tag = board.tags.filter((t) => t.zone === 'male' && t.kind === 'normal' && t.active && !t.locked && !t.visit).reverse()[0]!;
  await send(page, 'post', '/api/frontdesk/checkins', { clientKey: randomUUID(), guests: [{ tagCode: tag.code, zone: 'male', guestLabel: 'E2E 上钟轮播' }] });
  const visitId = (await getJson<{ tags: BoardTag[] }>(page, '/api/frontdesk/board')).tags.find((t) => t.code === tag.code)!.visit!.id;
  await send(page, 'post', '/api/clockroom/dispatch', {
    clientKey: randomUUID(),
    visitId,
    itemId,
    quantity: 1,
    technicianId: tech.id,
    callType: 'designated',
    startNow: true,
    expectedTotal: ITEM.price,
  });
  expect((await techOf(page)).sessions.map((s) => s.status)).toEqual(['serving']);
  return { wasEnabled: admin.rules.enabled, visitId };
}

/** 收尾：下钟、下牌；客人结账离店（没开班的临时开一个，结完交掉）；技师功能原来关着的关回去 */
async function release(page: Page, { wasEnabled, visitId }: { wasEnabled: boolean; visitId: number }) {
  for (const s of (await techOf(page)).sessions) {
    if (s.status === 'serving') await send(page, 'post', `/api/clockroom/sessions/${s.id}/finish`);
    else await send(page, 'post', `/api/clockroom/sessions/${s.id}/void`, { reason: 'E2E：收尾' });
  }
  const { tech } = await techOf(page);
  if (tech.state === 'on' || tech.state === 'rest') await send(page, 'post', `/api/clockroom/technicians/${tech.id}/state`, { action: 'sign_out' });
  const v = await getJson<{ status: string }>(page, `/api/frontdesk/visits/${visitId}`);
  if (v.status === 'open') {
    const opened = (await page.request.post('/api/shifts', { data: { openingCash: 0 } })).status() === 200;
    const preview = await getJson<{ totalAmount: number }>(page, `/api/frontdesk/checkout-preview?ids=${visitId}`);
    await send(page, 'post', '/api/frontdesk/checkouts', {
      clientKey: randomUUID(),
      visitIds: [visitId],
      expectedTotal: preview.totalAmount,
      payments: [{ method: 'cash', amount: preview.totalAmount }],
    });
    if (opened) {
      const { shift } = await getJson<{ shift: { id: number; summary: { cash: { expected: number } } } }>(page, '/api/shifts/current');
      const expected = shift.summary.cash.expected;
      await send(page, 'post', `/api/shifts/${shift.id}/close`, { countedCash: expected, expectedCash: expected, note: 'E2E：上钟轮播临时开的班' });
    }
  }
  if (!wasEnabled) await send(page, 'put', '/api/admin/technicians/rules', { enabled: false });
}

test.describe('技师上钟轮播', () => {
  test.skip(({ viewport }) => (viewport?.width ?? 0) < 1280, '只在门店电脑尺寸跑');

  test('入口、维度切换、筛选标签、暂停、间隔、全屏投屏', async ({ page }) => {
    await login(page);
    const prepared = await prepare(page);
    try {
      await page.goto('/tech-board');
      const board = page.getByTestId('tech-board');
      await expect(board).toHaveAttribute('data-mode', 'item');
      await expect(page.getByTestId('tech-board-order')).toBeVisible();
      await expect(page.getByTestId('tech-board-col').first()).toBeVisible();
      await expect(page.getByTestId('tech-board-card').first()).toBeVisible();
      await expect(page.getByTestId('tech-board-next')).toContainText('下一位排钟');
      // 只读：看板上没有改钟的按钮
      await expect(board.getByRole('button', { name: /上钟|下钟|派钟|叫号/ })).toHaveCount(0);

      // 按区域
      await page.getByRole('radio', { name: '按区域' }).click();
      await expect(board).toHaveAttribute('data-mode', 'area');
      await expect(page).toHaveURL(/mode=area/);
      await page.getByRole('radio', { name: '按项目' }).click();
      await expect(board).toHaveAttribute('data-mode', 'item');

      // 筛选：状态 + 项目两条生效，逐个去掉、一键重置
      await page.getByTestId('tech-board-status').selectOption('serving');
      const item = await page.getByTestId('tech-board-item').locator('option').nth(1).getAttribute('value');
      await page.getByTestId('tech-board-item').selectOption(item!);
      await expect(page.getByTestId('tech-board-active')).toContainText('状态：上钟中');
      await expect(page.getByTestId('tech-board-active')).toContainText(`项目：${item}`);
      await expect(page.locator('[data-testid^="tech-board-row-"]:not([data-status="serving"])')).toHaveCount(0);
      await page.getByTestId('tech-board-chip-status').click();
      await expect(page.getByTestId('tech-board-chip-status')).toHaveCount(0);
      await expect(page.getByTestId('tech-board-chip-item')).toBeVisible();
      await page.getByTestId('tech-board-reset').click();
      await expect(page.getByTestId('tech-board-active')).toHaveCount(0);

      // 暂停与继续；间隔记在本机
      await page.mouse.move(5, 5);
      await page.getByTestId('tech-board-pause').click();
      await expect(page.getByTestId('tech-board-pause')).toHaveText('继续');
      await expect(board).toHaveAttribute('data-paused', 'true');
      await page.getByTestId('tech-board-pause').click();
      await expect(page.getByTestId('tech-board-pause')).toHaveText('暂停');
      await page.getByTestId('tech-board-interval').selectOption('15');
      await page.reload();
      await expect(page.getByTestId('tech-board-interval')).toHaveValue('15');
      await page.getByTestId('tech-board-interval').selectOption('8');

      // 全屏投屏：只留看板，Esc 退出
      await page.getByTestId('tech-board-full').click();
      await expect(board).toHaveAttribute('data-full', 'true');
      await expect(page.getByTestId('tech-board-controls')).toHaveCount(0);
      const box = await board.boundingBox();
      expect(box?.width).toBeGreaterThanOrEqual((page.viewportSize()?.width ?? 0) - 1);
      await page.keyboard.press('Escape');
      await expect(board).not.toHaveAttribute('data-full', 'true');
      await expect(page.getByTestId('tech-board-controls')).toBeVisible();
    } finally {
      await release(page, prepared);
    }
  });
});
