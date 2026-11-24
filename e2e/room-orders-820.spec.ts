// 回测整改 P08（docs/YUZU_REQ_V820.md 第 9 节，回测 3-1）：房态中心「在用」的房间上点水吧——只有在用的卡片有「点单」；
// 面板按分类、搜索、加份数、写备注、整单备注，下单后卡片写房内点单几单、多少钱；点单记录里逐行撤单（要原因），撤了以后记录里写谁退的。
// 只在独立演示库跑（CI 的五套 seed 或 demo-prepare 都行），数据自己备、可以重复跑：空间台账里没有专用的派对房（三层 Q395）就导入，
// 水吧没有专用的饮品（E2E 房态奶茶）就建；接待一位客人、在这间派对房开单，最后结束使用、清洁完成、客人结账离店。只在门店电脑跑。
// 账号：店主 linlan，密码 yuzu2026。
import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import type { BoardTag } from '../src/shared/frontdesk';
import type { DiningAdmin } from '../src/shared/dining';
import type { RoomCard, RoomCenterBoard } from '../src/shared/room-center';
import type { SpaceLedger } from '../src/shared/spaces';
import { passPortal } from './portal';

const ROOM = 'Q395';
const DISH = { name: 'E2E 房态奶茶', category: '手作饮料', price: 1800 };

async function login(page: Page) {
  await page.goto('/login');
  await page.fill('#username', 'linlan');
  await page.fill('#password', 'yuzu2026');
  await page.getByRole('button', { name: '登录' }).click();
  await passPortal(page);
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

const cardOf = async (page: Page): Promise<RoomCard> => (await getJson<RoomCenterBoard>(page, '/api/room-center')).rooms.find((r) => r.code === ROOM)!;

/** 店主：专用的派对房、水吧的专用饮品（有水吧档口、点单开着）；房间收拾成空闲后接待一位客人、开单。返回来访 */
async function prepare(page: Page): Promise<number> {
  const ledger = await getJson<SpaceLedger>(page, '/api/admin/spaces');
  if (!ledger.spaces.some((s) => s.code === ROOM)) {
    const csv = ['楼层,区域字母,编码,业态,容量(人),建议显示名,面积,编码图原始标注,备注', `L3,Q,${ROOM},派对房,,E2E 房态点单派对房,,E2E 房态点单派对房,E2E`].join('\r\n');
    await send(page, 'post', '/api/admin/spaces/imports', { kind: 'spaces', fileName: 'e2e-room-orders-spaces.csv', csv, encoding: 'UTF-8', clientKey: randomUUID() });
  }
  let admin = await getJson<DiningAdmin>(page, '/api/admin/dining');
  if (!admin.rules.enabled) await send(page, 'put', '/api/admin/dining/rules', { enabled: true });
  let station = admin.stations.find((s) => s.name.includes('水吧'));
  if (!station) {
    admin = await send<DiningAdmin>(page, 'post', '/api/admin/dining/stations', { name: '水吧' });
    station = admin.stations.find((s) => s.name === '水吧')!;
  }
  const items = (await getJson<{ items: { id: number; name: string; active: boolean }[] }>(page, '/api/catalog?all=1')).items;
  const item = items.find((i) => i.name === DISH.name);
  if (!item) await send(page, 'post', '/api/items', DISH);
  else if (!item.active) await send(page, 'put', `/api/items/${item.id}`, { ...DISH, active: true });
  const id = (await getJson<{ items: { id: number; name: string }[] }>(page, '/api/catalog?all=1')).items.find((i) => i.name === DISH.name)!.id;
  await send(page, 'put', '/api/admin/dining/items', { items: [{ id, stationId: station.id }] });
  // 门店限定了水吧能点的分类的：放开（这条用例只看手作饮料）
  const config = await getJson<{ outlets: Record<'water' | 'fruit', { categories: string[] | null }> }>(page, '/api/admin/room-order-config');
  if (config.outlets.water.categories !== null && !config.outlets.water.categories.includes(DISH.category))
    await send(page, 'put', '/api/admin/room-order-config', { outlets: { ...config.outlets, water: { categories: null } } });

  // 上次中断留下的：结束使用、清洁完成
  let r = await cardOf(page);
  if (r.usage) await send(page, 'post', `/api/usages/${r.usage.id}/end`, { clientKey: randomUUID() });
  r = await cardOf(page);
  if (r.status === 'dirty') await send(page, 'post', `/api/room-center/rooms/${r.spaceId}/cleaned`, { clientKey: randomUUID(), expectedVersion: r.version });
  r = await cardOf(page);
  expect(r.status, `${ROOM} 收拾好了`).toBe('free');

  const board = await getJson<{ tags: (BoardTag & { id: number })[] }>(page, '/api/frontdesk/board');
  const tag = board.tags.filter((t) => t.zone === 'male' && t.kind === 'normal' && t.active && !t.locked && !t.visit).reverse()[0]!;
  await send(page, 'post', '/api/frontdesk/checkins', { clientKey: randomUUID(), guests: [{ tagCode: tag.code, zone: 'male', guestLabel: 'E2E 房态点单' }] });
  await send(page, 'post', `/api/room-center/rooms/${r.spaceId}/usage`, { clientKey: randomUUID(), tagCode: tag.code, guests: 2 });
  return (await getJson<{ tags: BoardTag[] }>(page, '/api/frontdesk/board')).tags.find((t) => t.code === tag.code)!.visit!.id;
}

/** 收尾：结束使用、清洁完成；客人在收银台结账离店（没开班的临时开一个，结完交掉） */
async function release(page: Page, visitId: number) {
  let r = await cardOf(page);
  if (r.usage) await send(page, 'post', `/api/usages/${r.usage.id}/end`, { clientKey: randomUUID() });
  r = await cardOf(page);
  if (r.status === 'dirty') await send(page, 'post', `/api/room-center/rooms/${r.spaceId}/cleaned`, { clientKey: randomUUID(), expectedVersion: r.version });
  const v = await getJson<{ status: string }>(page, `/api/frontdesk/visits/${visitId}`);
  if (v.status !== 'open') return;
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
    await send(page, 'post', `/api/shifts/${shift.id}/close`, { countedCash: expected, expectedCash: expected, note: 'E2E：房态点单临时开的班' });
  }
}

/** 卡片上「房内点单 N 单」的 N（没点过为 0） */
async function orderCount(page: Page, code: string): Promise<number> {
  const line = page.getByTestId(`rc-room-${code}`).getByTestId('rc-orders');
  if ((await line.count()) === 0) return 0;
  const m = /房内点单\s*(\d+)\s*单/.exec(await line.innerText());
  return m ? Number(m[1]) : 0;
}

test.describe('回测整改 房态点单', () => {
  test.skip(({ viewport }) => (viewport?.width ?? 0) < 1280, '只在门店电脑尺寸跑');

  test('在用的房间点水吧：面板、下单、卡片单数、点单记录里撤单', async ({ page }) => {
    await login(page);
    const visitId = await prepare(page);
    try {
      await page.goto('/room-center');
      const code = ROOM;
      const partyKey = (await cardOf(page)).categoryKey;
      await page.getByTestId(`rc-tab-${partyKey}`).click();
      await expect(page.getByTestId(`rc-room-${code}`)).toHaveAttribute('data-status', 'in_use');
      // 只有「在用」的卡片有「点单」
      const free = page.locator('[data-testid^="rc-room-"][data-status="free"]');
      if ((await free.count()) > 0) await expect(free.first().locator('[data-testid^="rc-order-"]')).toHaveCount(0);
      const before = await orderCount(page, code);

      await page.getByTestId(`rc-order-${code}`).click();
      const panel = page.getByTestId('room-order-panel');
      await expect(panel).toBeVisible();
      // 分类、搜索
      await panel.getByTestId('room-order-search').fill('房态奶茶');
      await expect(panel.getByTestId(`room-order-dish-${DISH.name}`)).toBeVisible();
      await expect(panel.locator('[data-testid^="room-order-dish-"]')).toHaveCount(1);
      await panel.getByTestId(`room-order-add-${DISH.name}`).click();
      await panel.getByTestId(`room-order-plus-${DISH.name}`).click();
      await expect(panel.getByTestId(`room-order-qty-${DISH.name}`)).toHaveValue('2');
      await expect(panel.getByTestId('room-order-summary')).toContainText('2 份');
      await panel.getByTestId(`room-order-minus-${DISH.name}`).click();
      await expect(panel.getByTestId(`room-order-qty-${DISH.name}`)).toHaveValue('1');
      await panel.getByTestId(`room-order-note-${DISH.name}`).fill('少冰');
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
      await expect(row).toContainText(DISH.name);
      await expect(row).toContainText('少冰');
      await expect(row).toContainText('整单备注：送到房间门口');
      await expect(row).toContainText('linlan');
      await row.getByTestId(`room-order-void-${DISH.name}`).click();
      await expect(page.getByTestId('room-order-void-confirm')).toBeDisabled();
      await page.getByTestId('room-order-void-reason').fill('演示撤单');
      await page.getByTestId('room-order-void-confirm').click();
      await expect(page.getByText('已撤单')).toBeVisible();
      await expect(row.getByTestId('room-order-line').first()).toHaveAttribute('data-status', 'voided');
      await expect(row).toContainText('已退：演示撤单');
      await page.keyboard.press('Escape');
      await expect.poll(() => orderCount(page, code)).toBe(before);
    } finally {
      await release(page, visitId);
    }
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
