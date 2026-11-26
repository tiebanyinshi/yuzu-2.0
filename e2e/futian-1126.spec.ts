// 福田店整改（2026-11-26《福田店餐饮与房态中心整改需求文档》，docs/FUTIAN_1126.md）浏览器验收：
//   批次 1：CY-03 点单页右侧边栏能滚、「下单」一直看得到；FT-01 点房间直接弹出「详情与动作」（没有右侧详情栏）；
//           FT-05 筛选类别（区域页签）在房态选项（统计卡）上面；FT-08 右键设置房态（待清 → 空闲），房间历史里有记录。
//   CY-02（已点菜品）在 e2e/dining.spec.ts 里核对（那条用例自己建档口与菜）。
// 只在独立演示库跑，数据自己备、可以重复跑：空间台账里没有专用的两个空间（三层的 Q395、Q396）就导入。
// 账号：店主 linlan，密码 yuzu2026。
import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import type { DiningAdmin } from '../src/shared/dining';
import type { BoardTag } from '../src/shared/frontdesk';
import type { RoomCenterBoard } from '../src/shared/room-center';
import type { SpaceLedger } from '../src/shared/spaces';
import { passPortal } from './portal';

const PASSWORD = 'yuzu2026';
const [R1, R2] = ['Q395', 'Q396'] as const;
const SPACES = [
  [R1, 'SPA', '1', 'E2E 福田 SPA 一号'],
  [R2, 'SPA', '1', 'E2E 福田 SPA 二号'],
] as const;

async function login(page: Page, username: string) {
  await page.goto('/login');
  await page.fill('#username', username);
  await page.fill('#password', PASSWORD);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await passPortal(page);
  await expect(page.getByRole('navigation', { name: '主导航' })).toBeVisible({ timeout: 30_000 });
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

/** CY-03 用的 8 道菜（都在一个水吧档口上，直接能点） */
const DRINKS = Array.from({ length: 8 }, (_, i) => ({ name: `E2E 福田饮品 ${i + 1}`, category: 'E2E 福田', price: 1000 + i * 100 }));
const DRINK_STATION = 'E2E 福田水吧';

/** 店主：建好 8 道饮品并挂在水吧档口上，开启餐饮（结束时关回去） */
async function ensureDrinks(page: Page) {
  const items = (await getJson<{ items: { id: number; name: string; active: boolean }[] }>(page, '/api/catalog?all=1')).items;
  for (const d of DRINKS) {
    const old = items.find((i) => i.name === d.name);
    if (!old) await send(page, 'post', '/api/items', d);
    else if (!old.active) await send(page, 'put', `/api/items/${old.id}`, { ...d, active: true });
  }
  let admin = await getJson<DiningAdmin>(page, '/api/admin/dining');
  const st = admin.stations.find((x) => x.name === DRINK_STATION);
  if (!st) admin = await send<DiningAdmin>(page, 'post', '/api/admin/dining/stations', { name: DRINK_STATION });
  else if (!st.active) admin = await send<DiningAdmin>(page, 'put', `/api/admin/dining/stations/${st.id}`, { name: DRINK_STATION, sortOrder: st.sortOrder, active: true });
  const stationId = admin.stations.find((x) => x.name === DRINK_STATION)!.id;
  await send(page, 'put', '/api/admin/dining/items', { items: DRINKS.map((d) => ({ id: admin.items.find((i) => i.name === d.name)!.id, stationId, slot: 'water:手作饮料' })) });
  await send(page, 'put', '/api/admin/dining/rules', { enabled: true });
}

const cardOf = async (page: Page, code: string) => (await getJson<RoomCenterBoard>(page, '/api/room-center')).rooms.find((r) => r.code === code)!;

async function ensureSpaces(page: Page) {
  const ledger = await getJson<SpaceLedger>(page, '/api/admin/spaces');
  const missing = SPACES.filter(([code]) => !ledger.spaces.some((s) => s.code === code));
  if (!missing.length) return;
  const rows = missing.map(([code, type, cap, name]) => `L3,Q,${code},${type},${cap},${name},,${name},E2E`);
  const csv = ['楼层,区域字母,编码,业态,容量(人),建议显示名,面积,编码图原始标注,备注', ...rows].join('\r\n');
  await send(page, 'post', '/api/admin/spaces/imports', { kind: 'spaces', fileName: 'e2e-futian-spaces.csv', csv, encoding: 'UTF-8', clientKey: randomUUID() });
}

/** 把这间房收拾成空闲（上次中断留下的待清、维修） */
async function freeRoom(page: Page, code: string) {
  let r = await cardOf(page, code);
  if (r.status === 'maintenance') await send(page, 'post', `/api/room-center/rooms/${r.spaceId}/restore`, { clientKey: randomUUID(), expectedVersion: r.version, note: '' });
  r = await cardOf(page, code);
  if (r.status === 'dirty') await send(page, 'post', `/api/room-center/rooms/${r.spaceId}/cleaned`, { clientKey: randomUUID(), expectedVersion: r.version });
  expect((await cardOf(page, code)).status).toMatch(/^(free|booked)$/);
}

test.describe('福田店整改 2026-11-26', () => {
  test.skip(({ viewport }) => (viewport?.width ?? 0) < 1280, '会写数据的流程只在门店电脑尺寸执行一次');
  test.setTimeout(180_000);

  test('批次 1：FT-05 页签在统计卡上面；FT-01 点房间直接弹出详情与动作；FT-08 右键设置房态', async ({ page }) => {
    await login(page, 'linlan');
    await ensureSpaces(page);
    for (const code of SPACES.map((s) => s[0])) await freeRoom(page, code);
    await page.goto('/room-center');
    await expect(page.getByTestId('room-center')).toBeVisible();

    // FT-05：筛选类别（区域页签）在房态选项（统计卡、状态数量）上面
    const tabsBox = await page.getByTestId('rc-category-filter').boundingBox();
    const statsBox = await page.getByTestId('rc-stats').boundingBox();
    expect(tabsBox && statsBox && tabsBox.y < statsBox.y, '区域页签在统计卡上面').toBe(true);

    // FT-01：点空闲的房间直接弹出「详情与动作」，里面有登记、标为待清、维修；没有右侧详情栏
    await page.getByTestId('rc-search').fill(R1);
    await page.getByTestId(`rc-open-${R1}`).click();
    const dialog = page.getByTestId('rc-room-dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByTestId('rc-act-register')).toBeVisible();
    await expect(dialog.getByTestId('rc-act-dirty')).toBeVisible();
    await expect(dialog.getByTestId('rc-act-maintenance')).toBeVisible();
    await expect(page.getByTestId('rc-panel')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);

    // FT-08：右键 → 待清，马上生效；再右键 → 空闲（清洁完成）
    const room = page.getByTestId(`rc-room-${R1}`);
    await room.click({ button: 'right' });
    const menu = page.getByTestId('rc-state-menu');
    await expect(menu).toBeVisible();
    await menu.getByTestId('rc-state-dirty').click();
    await expect(room).toHaveAttribute('data-status', 'dirty');
    await room.click({ button: 'right' });
    await expect(menu.getByTestId('rc-state-maintenance')).toBeVisible();
    await menu.getByTestId('rc-state-cleaned').click();
    await expect(room).toHaveAttribute('data-status', 'free');
    // 留了操作记录：房间历史里有「标待清」「清洁完成」
    const history = await getJson<{ rows: { label: string }[] }>(page, `/api/room-center/rooms/${(await cardOf(page, R1)).spaceId}/history`);
    expect(
      history.rows
        .slice(0, 2)
        .map((r) => r.label)
        .join(' '),
    ).toMatch(/清洁完成/);
    expect(history.rows.some((r) => /待清/.test(r.label))).toBe(true);
  });

  test('批次 1：CY-03 点单页选了很多菜，侧边栏能往下翻、「下单」一直在屏幕里', async ({ page }) => {
    await login(page, 'linlan');
    await ensureDrinks(page);
    const board = await getJson<{ tags: (BoardTag & { id: number })[] }>(page, '/api/frontdesk/board');
    const tag = board.tags.filter((t) => t.zone === 'male' && t.kind === 'normal' && t.active && !t.locked && !t.visit).reverse()[0]!.code;
    await send(page, 'post', '/api/frontdesk/checkins', { clientKey: randomUUID(), guests: [{ tagCode: tag, zone: 'male', guestLabel: 'E2E 福田点单' }] });
    await page.goto('/crm/dining');
    await page.getByTestId('dining-tag').fill(tag);
    await page.getByTestId('dining-find').click();
    await expect(page.getByTestId('dining-guest')).toContainText('E2E 福田点单');
    await page.getByTestId('dining-outlet-water').click();
    for (const d of DRINKS) await page.getByTestId(`dining-dish-${d.name}`).click();
    const added = await page.locator('[data-testid^="dining-line-"]').count();
    expect(added).toBe(DRINKS.length);
    const submit = page.getByTestId('dining-submit');
    const inView = async () => {
      const b = await submit.boundingBox();
      const vh = page.viewportSize()!.height;
      return !!b && b.y >= 0 && b.y + b.height <= vh;
    };
    expect(await inView(), '选了很多菜，「下单」照样在屏幕里').toBe(true);
    // 侧边栏自己能滚到底（最后一行菜看得到）
    const sidebar = page.getByTestId('dining-sidebar');
    expect(await sidebar.evaluate((el) => getComputedStyle(el).overflowY)).toBe('auto');
    await page.locator('[data-testid^="dining-line-"]').last().scrollIntoViewIfNeeded();
    await expect(page.locator('[data-testid^="dining-line-"]').last()).toBeInViewport();
    expect(await inView(), '翻到最后一行，「下单」照样在屏幕里').toBe(true);
    await page.getByTestId('dining-cart-clear').click();
    await send(page, 'put', '/api/admin/dining/rules', { enabled: false });
  });
});
