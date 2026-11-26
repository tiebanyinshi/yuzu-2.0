// 福田店整改（2026-11-26《福田店餐饮与房态中心整改需求文档》，docs/FUTIAN_1126.md）浏览器验收：
//   批次 1：CY-03 点单页右侧边栏能滚、「下单」一直看得到；FT-01 点房间直接弹出「详情与动作」（没有右侧详情栏）；
//           FT-05 筛选类别（区域页签）在房态选项（统计卡）上面；FT-08 右键设置房态（待清 → 空闲），房间历史里有记录。
//   CY-02（已点菜品）在 e2e/dining.spec.ts 里核对（那条用例自己建档口与菜）。
//   批次 2：FT-02 输编号即选、默认不平铺；FT-07 括单；FT-06 限时换技师；FT-09 限时撤房（回空闲）；FT-19 补单；后台房态中心规则；CY-01 同组汇总。
//   批次 3：FT-03 过夜客人先开房、再在详情里拍照补传留宿确认单（待补传 → 已上传 1 张）；FT-04 退房后待清的卡片标「留宿」；
//           FT-13 康美部员工登录只看房态与手牌号（没有项目、技师、金额，详情里没有历史与动作）。
//           （时限超过以后拒绝、自定义时限、房费、同类型换房、业绩归属在 tests/futian-1126.test.ts 里按时刻核对）
// 只在独立演示库跑，数据自己备、可以重复跑：空间台账里没有专用的两个空间（三层的 Q385、Q386）就导入。
// 账号：店主 linlan，密码 yuzu2026。
import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import type { DiningAdmin } from '../src/shared/dining';
import type { BoardTag } from '../src/shared/frontdesk';
import type { RoomCenterBoard, RoomCheckoutPreview } from '../src/shared/room-center';
import type { RoomCenterRules } from '../src/shared/room-center-rules';
import type { SpaceLedger } from '../src/shared/spaces';
import { passPortal } from './portal';

const PASSWORD = 'yuzu2026';
const [R1, R2] = ['Q385', 'Q386'] as const;
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

/** 批次 2 用的项目（带编号）与两位技师 */
const ITEM = { name: 'E2E 福田足疗', category: 'E2E 福田', price: 9800, durationMinutes: 60, technicianRequired: true, code: 'FT02' };
const TECHS = [
  { techNo: 'R97', name: 'E2E 福田技师甲' },
  { techNo: 'R96', name: 'E2E 福田技师乙' },
] as const;

/** 店主：项目（编号 FT02）、两位技师建好并上牌；技师功能打开 */
async function ensureService(page: Page) {
  const items = (await getJson<{ items: { id: number; name: string; active: boolean; catalogCode: string | null }[] }>(page, '/api/catalog?all=1')).items;
  // 别的项目占了这个编号的先清掉（上次中断留下的同名项目除外）
  const old = items.find((i) => i.name === ITEM.name);
  if (!old) await send(page, 'post', '/api/items', ITEM);
  else await send(page, 'put', `/api/items/${old.id}`, { ...ITEM, active: true });
  const admin = await getJson<{ rules: { enabled: boolean }; technicians: { id: number; techNo: string }[] }>(page, '/api/admin/technicians');
  if (!admin.rules.enabled) await send(page, 'put', '/api/admin/technicians/rules', { enabled: true });
  for (const t of TECHS) if (!admin.technicians.some((x) => x.techNo === t.techNo)) await send(page, 'post', '/api/admin/technicians', { ...t, gender: 'female', grade: 'standard' });
  const clock = await getJson<{ technicians: { id: number; techNo: string; state: string; busy: unknown }[] }>(page, '/api/clockroom');
  for (const t of TECHS) {
    const x = clock.technicians.find((c) => c.techNo === t.techNo)!;
    if (x.state !== 'on') await send(page, 'post', `/api/clockroom/technicians/${x.id}/state`, { action: 'sign_in' });
  }
}

/** 店主：把这间房里留下的钟、登记收掉（下钟 / 取消派钟、退房、清洁完成） */
async function clearRoom(page: Page, code: string) {
  let r = await cardOf(page, code);
  for (const s of r.guests.flatMap((g) => g.sessions)) {
    if (s.status === 'serving') await send(page, 'post', `/api/clockroom/sessions/${s.id}/finish`);
    if (s.status === 'waiting') await send(page, 'post', `/api/clockroom/sessions/${s.id}/void`, { reason: 'E2E：收掉上次留下的' });
  }
  r = await cardOf(page, code);
  if (r.guests.some((g) => g.registrationId !== null)) {
    const p = await getJson<RoomCheckoutPreview>(page, `/api/room-center/rooms/${r.spaceId}/checkout-preview`);
    await send(page, 'post', `/api/room-center/rooms/${r.spaceId}/checkout`, { clientKey: randomUUID(), expectedVersion: p.version, seenUnpaid: p.unpaidTotal, inHouse: true });
  }
  await freeRoom(page, code);
}

/** 前台接待（接口办理）；backdateHours：按纸质单补录成几小时前入场的（补单要补在入场以后） */
async function checkin(page: Page, labels: string[], backdateHours = 0) {
  const board = await getJson<{ tags: (BoardTag & { id: number })[] }>(page, '/api/frontdesk/board');
  const tags = board.tags
    .filter((t) => t.zone === 'male' && t.kind === 'normal' && t.active && !t.locked && !t.visit)
    .reverse()
    .slice(0, labels.length);
  await send(page, 'post', '/api/frontdesk/checkins', {
    clientKey: randomUUID(),
    guests: labels.map((guestLabel, i) => ({ tagCode: tags[i]!.code, zone: 'male', guestLabel })),
    ...(backdateHours ? { backfill: { slipNo: 'E2E-FT', at: new Date(Date.now() - backdateHours * 3_600_000).toISOString() } } : {}),
  });
  const after = await getJson<{ tags: BoardTag[] }>(page, '/api/frontdesk/board');
  return tags.map((t) => ({ tag: t.code, visitId: after.tags.find((x) => x.code === t.code)!.visit!.id }));
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

  test('批次 2：FT-02 输编号即选；FT-07 括单；FT-06 换技师；FT-09 撤房；FT-19 补单；后台规则', async ({ page }) => {
    await login(page, 'linlan');
    await ensureSpaces(page);
    await ensureService(page);
    for (const code of SPACES.map((s) => s[0])) await clearRoom(page, code);
    const [g] = await checkin(page, ['E2E 福田括单']);

    // 后台「房态中心规则」：默认 15 分钟；改成 20 保存，房态中心看板跟着变；再改回 15
    await page.goto('/admin/spaces/room-categories');
    const rulesCard = page.getByTestId('room-center-rules');
    await expect(rulesCard).toBeVisible();
    await expect(rulesCard.getByTestId('rc-rule-revokeMinutes')).toHaveValue('15');
    await rulesCard.getByTestId('rc-rule-revokeMinutes').fill('20');
    await rulesCard.getByTestId('rc-rules-save').click();
    await expect(page.getByText('房态中心规则已保存')).toBeVisible();
    expect((await getJson<RoomCenterBoard>(page, '/api/room-center')).limits.revokeMinutes).toBe(20);
    await rulesCard.getByTestId('rc-rule-revokeMinutes').fill('15');
    await rulesCard.getByTestId('rc-rules-save').click();
    await expect.poll(async () => (await getJson<RoomCenterRules>(page, '/api/admin/room-center-rules')).revokeMinutes).toBe(15);

    // FT-02：登记时项目面板默认只有搜索框与分类；输编号（小写也行）直接选中
    await page.goto('/room-center');
    await page.getByTestId('rc-search').fill(R1);
    await page.getByTestId(`rc-open-${R1}`).click();
    await page.getByTestId('rc-act-register').click();
    const reg = page.getByRole('dialog').filter({ hasText: `登记 · ${R1}` });
    await expect(reg.getByTestId('rc-register')).toBeVisible();
    await expect(reg.getByTestId(`rc-register-item-${ITEM.name}`)).toHaveCount(0);
    await expect(reg.getByTestId('rc-register-hint')).toContainText('输入项目编号');
    await reg.getByTestId('rc-register-tag').fill(g!.tag);
    await expect(reg.getByTestId('rc-register-guest')).toContainText('E2E 福田括单');
    await reg.getByTestId('rc-register-search').fill('ft02');
    await expect(reg.getByTestId(`rc-register-item-${ITEM.name}`)).toHaveAttribute('aria-pressed', 'true');
    // FT-07：点钟才有括单
    await expect(reg.getByTestId('rc-register-bracket')).toHaveCount(0);
    await reg.getByRole('radiogroup', { name: '上钟方式' }).getByRole('radio', { name: /点钟/ }).click();
    await reg.getByTestId('rc-register-techno').fill(TECHS[0].techNo);
    await reg.getByTestId('rc-register-bracket').click();
    await expect(reg.getByTestId('rc-register-total')).toContainText('98.00');
    await reg.getByTestId('rc-register-submit').click();
    await expect(page.getByText(`${R1} 已登记`)).toBeVisible();
    const room = page.getByTestId(`rc-room-${R1}`);
    await expect(room).toHaveAttribute('data-status', 'in_use');
    await expect(room.getByTestId('rc-bracket')).toBeVisible();

    // FT-06：详情里钟单上有「换技师」（写着还剩几分钟），换给乙
    await page.getByTestId(`rc-open-${R1}`).click();
    const detail = page.getByTestId('rc-room-dialog');
    await expect(detail.getByTestId('rc-guest-bracket')).toBeVisible();
    const swap = detail.locator('[data-testid^="rc-swap-"]').first();
    await expect(swap).toContainText(/剩 1[45] 分/);
    await swap.click();
    const tr = page.getByRole('dialog').filter({ hasText: '换技师 ·' });
    await expect(tr).toContainText('还剩');
    await tr
      .getByRole('radio', { name: /点钟/ })
      .click()
      .catch(() => undefined);
    await tr.getByTestId(`transfer-tech-${TECHS[1].techNo}`).click();
    await tr.getByTestId('transfer-reason').fill('客人要换');
    await tr.getByTestId('transfer-submit').click();
    await expect(page.getByText(`${R1} 已换技师`)).toBeVisible();
    await expect.poll(async () => (await cardOf(page, R1)).guests[0]?.sessions.filter((s) => s.status !== 'done').map((s) => s.techNo)).toEqual([TECHS[1].techNo]);

    // FT-09：撤房（写原因）→ 不收费、房间直接回到空闲
    await page.getByTestId(`rc-open-${R1}`).click();
    await expect(detail.getByTestId('rc-act-revoke')).toContainText('剩');
    await detail.getByTestId('rc-act-revoke').click();
    const rv = page.getByTestId('rc-revoke');
    await expect(rv.getByTestId('rc-revoke-left')).toContainText('还剩');
    await rv.getByTestId('rc-revoke-reason').fill('E2E 开错房间');
    await page.getByTestId('rc-revoke-submit').click();
    await expect(page.getByText(`${R1} 已撤房`)).toBeVisible();
    await expect(room).toHaveAttribute('data-status', 'free');
    const bill = await getJson<{ bill: { amountCents: number } }>(page, `/api/frontdesk/visits/${g!.visitId}`);
    expect(bill.bill.amountCents).toBe(0);

    // FT-19：补单（客人两小时前入场，一小时前做的漏开了单）：挂到手牌上、房间仍空闲、历史里有「补单」
    const [late] = await checkin(page, ['E2E 福田补单'], 2);
    await page.getByTestId(`rc-open-${R1}`).click();
    await detail.getByTestId('rc-act-backfill').click();
    const bf = page.getByTestId('rc-backfill');
    await bf.getByTestId('rc-register-tag').fill(late!.tag);
    await expect(bf.getByTestId('rc-register-guest')).toContainText('E2E 福田补单');
    await bf.getByTestId('rc-backfill-search').fill('FT02');
    await expect(bf.getByTestId(`rc-backfill-item-${ITEM.name}`)).toHaveAttribute('aria-pressed', 'true');
    await bf.getByTestId('rc-backfill-techno').fill(TECHS[0].techNo);
    await bf.getByTestId('rc-backfill-slip').fill('SG-1126');
    await expect(page.getByTestId('rc-backfill-total')).toContainText('98.00');
    await page.getByTestId('rc-backfill-submit').click();
    await expect(page.getByText(`${R1} 已补单`)).toBeVisible();
    await expect(room).toHaveAttribute('data-status', 'free');
    expect((await getJson<{ bill: { amountCents: number } }>(page, `/api/frontdesk/visits/${late!.visitId}`)).bill.amountCents).toBe(9800);
    const history = await getJson<{ rows: { kind: string | null; text: string }[] }>(page, `/api/room-center/rooms/${(await cardOf(page, R1)).spaceId}/history`);
    expect(history.rows.some((r) => r.kind === 'backfill' && r.text.includes('SG-1126'))).toBe(true);
    expect(history.rows.some((r) => r.kind === 'revoke')).toBe(true);
  });

  test('批次 2：CY-01 同组客人的点单一屏汇总（单价、份数、合计）', async ({ page }) => {
    await login(page, 'linlan');
    await ensureDrinks(page);
    const [a, b] = await checkin(page, ['E2E 同组甲', 'E2E 同组乙']);
    const menu = (await getJson<{ items: { id: number; name: string; price: number }[] }>(page, '/api/catalog')).items;
    const d1 = menu.find((i) => i.name === DRINKS[0]!.name)!;
    await send(page, 'post', '/api/dining/orders', { clientKey: randomUUID(), visitId: a!.visitId, lines: [{ itemId: d1.id, quantity: 2 }], expectedTotal: d1.price * 2 });
    await send(page, 'post', '/api/dining/orders', { clientKey: randomUUID(), visitId: b!.visitId, lines: [{ itemId: d1.id, quantity: 1 }], expectedTotal: d1.price });
    await page.goto('/crm/dining');
    await page.getByTestId('dining-tag').fill(a!.tag);
    await page.getByTestId('dining-find').click();
    await expect(page.getByTestId('dining-guest')).toContainText('E2E 同组甲');
    await page.getByTestId('dining-group-open').click();
    const grp = page.getByTestId('dining-group');
    await expect(grp.getByTestId(`dining-group-${a!.tag}`)).toContainText('×2');
    await expect(grp.getByTestId(`dining-group-${b!.tag}`)).toContainText('×1');
    await expect(grp.getByTestId('dining-group-total')).toContainText('3');
    await expect(grp.getByTestId('dining-group-total')).toContainText(((d1.price * 3) / 100).toFixed(2));
    await page.keyboard.press('Escape');
    await send(page, 'put', '/api/admin/dining/rules', { enabled: false });
  });

  test('批次 3：FT-03 留宿确认单补传；FT-04 待清卡片标留宿；FT-13 康美部只看房态与手牌号', async ({ page }) => {
    await login(page, 'linlan');
    await ensureSpaces(page);
    await ensureService(page);
    for (const code of SPACES.map((s) => s[0])) await clearRoom(page, code);
    const [g] = await checkin(page, ['E2E 福田过夜']);
    const tech = (await getJson<{ technicians: { id: number; techNo: string }[] }>(page, '/api/clockroom')).technicians.find((t) => t.techNo === TECHS[0].techNo)!;
    const item = (await getJson<{ items: { id: number; name: string }[] }>(page, '/api/catalog')).items.find((i) => i.name === ITEM.name)!;
    const r2 = await cardOf(page, R2);
    await send(page, 'post', `/api/room-center/rooms/${r2.spaceId}/register`, {
      clientKey: randomUUID(),
      tagCode: g!.tag,
      itemId: item.id,
      tier: 'standard',
      quantity: 1,
      technicianId: tech.id,
      callType: 'designated',
      sellerNo: 'linlan',
      note: 'E2E 靠窗',
      start: 'now',
      overnight: true,
      expectedTotal: ITEM.price,
    });

    // FT-03：开房时没传照片照样开了；详情里写「待补传」，拍照上传以后「已上传 1 张」、有缩略图
    await page.goto('/room-center');
    await page.getByTestId('rc-search').fill(R2);
    await page.getByTestId(`rc-open-${R2}`).click();
    const box = page.getByTestId(`rc-overnight-photos-${g!.tag}`);
    await expect(box.getByTestId('rc-overnight-photo-state')).toHaveText('待补传');
    // 一张 2×2 的 PNG（浏览器里压成 JPEG 再传）
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP8z8DAwMDAxMDAwMDAAAANHQEDasKb6QAAAABJRU5ErkJggg==', 'base64');
    await box.getByTestId('rc-overnight-photo-input').setInputFiles({ name: '留宿确认单.png', mimeType: 'image/png', buffer: png });
    await expect(box.getByTestId('rc-overnight-photo-state')).toHaveText('已上传 1 张');
    await expect(box.getByRole('img', { name: '留宿确认单' })).toBeVisible();
    await page.keyboard.press('Escape');

    // FT-04：下钟、退房 → 待清的卡片上标「留宿」
    let r = await cardOf(page, R2);
    for (const s of r.guests.flatMap((x) => x.sessions)) if (s.status === 'serving') await send(page, 'post', `/api/clockroom/sessions/${s.id}/finish`);
    const p = await getJson<RoomCheckoutPreview>(page, `/api/room-center/rooms/${r.spaceId}/checkout-preview`);
    await send(page, 'post', `/api/room-center/rooms/${r.spaceId}/checkout`, { clientKey: randomUUID(), expectedVersion: p.version, seenUnpaid: p.unpaidTotal, inHouse: true });
    const card = page.getByTestId(`rc-room-${R2}`);
    await expect(card).toHaveAttribute('data-status', 'dirty');
    await expect(card.getByTestId('rc-dirty-overnight')).toBeVisible();

    // FT-13：康美部员工（新建账号、改好密码）只看房态与手牌号
    const [h] = await checkin(page, ['E2E 福田康美看']);
    r = await cardOf(page, R1);
    await send(page, 'post', `/api/room-center/rooms/${r.spaceId}/register`, {
      clientKey: randomUUID(),
      tagCode: h!.tag,
      itemId: item.id,
      tier: 'standard',
      quantity: 1,
      technicianId: tech.id,
      callType: 'designated',
      sellerNo: 'linlan',
      note: 'E2E 不该看到',
      start: 'later',
      expectedTotal: ITEM.price,
    });
    const username = `e2eftkm${String(Date.now()).slice(-7)}`;
    const made = await page.request.post('/api/staff', { data: { username, displayName: 'E2E 福田康美', position: 'kangmei.staff' } });
    expect(made.status(), await made.text()).toBe(201);
    const temp = ((await made.json()) as { temporaryPassword: string }).temporaryPassword;
    await page.request.post('/api/auth/logout');
    expect((await page.request.post('/api/auth/login', { data: { username, password: temp } })).ok()).toBe(true);
    expect((await page.request.post('/api/auth/change-password', { data: { currentPassword: temp, newPassword: `${temp}9` } })).ok()).toBe(true);
    await page.goto('/room-center');
    await expect(page.getByTestId('room-center')).toBeVisible({ timeout: 30_000 });
    await page.getByTestId('rc-search').fill(R1);
    const km = page.getByTestId(`rc-room-${R1}`);
    await expect(km).toHaveAttribute('data-status', 'in_use');
    await expect(km).toContainText(h!.tag);
    for (const hidden of [ITEM.name, TECHS[0].name, '98.00', 'E2E 福田康美看']) await expect(km).not.toContainText(hidden);
    await page.getByTestId(`rc-open-${R1}`).click();
    const d = page.getByTestId('rc-room-dialog');
    await expect(d).toHaveAttribute('data-status-only', 'true');
    await expect(d).toContainText(`手牌 ${h!.tag}`);
    await expect(d.getByTestId('rc-history')).toHaveCount(0);
    await expect(d.getByTestId('rc-actions')).toHaveCount(0);
    for (const hidden of [ITEM.name, TECHS[0].name, 'E2E 不该看到']) await expect(d).not.toContainText(hidden);
    await page.keyboard.press('Escape');
    // 收尾：店主取消派钟、退房
    await page.request.post('/api/auth/logout');
    await login(page, 'linlan');
    await clearRoom(page, R1);
    await clearRoom(page, R2);
  });
});
