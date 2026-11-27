// 8.2.4 餐饮（会议纪要「餐饮系统需求对接会」，docs/V8224_DINING.md）：分组默认档口与核对列表、临时项目进厨房、包房房型（低消 / 中消 / 只收房费）、
// 服务费门店默认、返台补低消、公司承担。

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createStaff } from '../src/server/modules/staff';
import { tableRuleOf, usesMidSpend } from '../src/shared/dining-v8224';
import { api, login, PASSWORD, setup, type TestContext } from './helpers';

let ctx: TestContext;
let boss: string;
const item: Record<string, number> = {};
const station: Record<string, number> = {};
const table: Record<string, number> = {};
const roomType: Record<string, number> = {};
let tagNo = 0;

type Line = { id: number; name: string; amount: number; status: string; source: string };
type Detail = { id: number; status: string; amount: number; parkedAt: string | null; lines: Line[] };

const checkin = async () => {
  tagNo += 1;
  const r = await api(ctx.app, ctx.clerk, 'POST', '/api/frontdesk/checkins', { clientKey: randomUUID(), guests: [{ tagCode: `D${String(tagNo).padStart(3, '0')}`, zone: 'male' }] });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.visits[0].id as number;
};
const wristOrder = (visitId: number, lines: Record<string, unknown>[], expectedTotal: number) =>
  api(ctx.app, ctx.clerk, 'POST', '/api/dining/orders', { clientKey: randomUUID(), visitId, lines, expectedTotal });
const open = async (tableId: number, guests = 4) => {
  const r = await api(ctx.app, ctx.clerk, 'POST', '/api/dining/tables/open', { clientKey: randomUUID(), tableId, guests });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body.id as number;
};
const order = (sessionId: number, lines: Record<string, unknown>[], expectedTotal: number) =>
  api(ctx.app, ctx.clerk, 'POST', `/api/dining/tables/sessions/${sessionId}/orders`, { clientKey: randomUUID(), lines, expectedTotal });
const detail = async (id: number) => (await api(ctx.app, ctx.clerk, 'GET', `/api/dining/tables/sessions/${id}`)).body as Detail;
const preview = async (ids: number[]) => (await api(ctx.app, ctx.clerk, 'GET', `/api/dining/tables/checkout-preview?ids=${ids.join(',')}`)).body;
const pay = (sessionIds: number[], expectedTotal: number, extra: Record<string, unknown> = {}) =>
  api(ctx.app, ctx.clerk, 'POST', '/api/dining/tables/checkout', {
    clientKey: randomUUID(),
    sessionIds,
    expectedTotal,
    payments: expectedTotal ? [{ method: 'cash', amount: expectedTotal }] : [],
    ...extra,
  });
const saveTable = async (name: string, patch: Record<string, unknown>) => {
  const t = (await api(ctx.app, boss, 'GET', '/api/admin/dining/tables')).body.tables.find((x: { name: string }) => x.name === name);
  const r = await api(ctx.app, boss, 'PUT', `/api/admin/dining/tables/${table[name]}`, { name, area: t.area, seats: t.seats, ...patch });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body.tables.find((x: { name: string }) => x.name === name);
};
const kitchenOf = (billLineName: string) => ctx.sql<{ itemId: number | null; stationId: number; status: string }[]>`
  SELECT k.item_id, k.station_id, k.status FROM kitchen_items k JOIN bill_lines l ON l.id = k.bill_line_id WHERE l.name = ${billLineName} ORDER BY k.id`;

beforeAll(async () => {
  ctx = await setup();
  await createStaff(ctx.sql, { username: 'boss', displayName: '店总', role: 'store_manager', password: PASSWORD, mustChangePassword: false });
  boss = await login(ctx.app, 'boss');
  for (const name of ['中厨', '茶点', '旧档口']) {
    const r = await api(ctx.app, boss, 'POST', '/api/admin/dining/stations', { name });
    station[name] = r.body.stations.find((s: { name: string }) => s.name === name).id;
  }
  for (const [name, category, price] of [
    ['虾饺', '点心', 3800],
    ['虾饼', '点心', 4200],
    ['小炒肉', '热菜', 5800],
  ] as const) {
    const c = await api(ctx.app, ctx.owner, 'POST', '/api/items', { name, category, price });
    item[name] = c.body.items.find((i: { name: string }) => i.name === name).id;
  }
  // 餐厅的小分类加上「点心」，三道菜都先挂在中厨
  const rules = await api(ctx.app, ctx.owner, 'PUT', '/api/admin/dining/rules', {
    enabled: true,
    tablesEnabled: true,
    clearAfterCheckout: true,
    outletGroups: { restaurant: ['餐饮', '酒水', '点心'], water: ['手作饮料', '糖水', '调酒'] },
  });
  expect(rules.status, JSON.stringify(rules.body)).toBe(200);
  const set = await api(ctx.app, boss, 'PUT', '/api/admin/dining/items', {
    items: [
      { id: item['虾饺'], stationId: station['中厨'], slot: 'restaurant:点心' },
      { id: item['虾饼'], stationId: station['中厨'], slot: 'restaurant:点心' },
      { id: item['小炒肉'], stationId: station['中厨'], slot: 'restaurant:餐饮' },
    ],
  });
  expect(set.status, JSON.stringify(set.body)).toBe(200);
  expect((await api(ctx.app, ctx.owner, 'POST', '/api/frontdesk/tags/batch', { prefix: 'D', from: 1, to: 40, width: 3, zone: 'male' })).status).toBe(200);
  for (const name of ['A1', '包A', '包B', '茶房']) {
    const t = await api(ctx.app, boss, 'POST', '/api/admin/dining/tables', { name, area: name === 'A1' ? '大厅' : '包间', seats: 8 });
    expect(t.status, JSON.stringify(t.body)).toBe(200);
    table[name] = t.body.tables.find((x: { name: string }) => x.name === name).id;
  }
});
afterAll(async () => ctx.close());

describe('菜单分组的默认档口（点心不再跑到中厨）', () => {
  it('分组设了默认档口：没单独设档口的菜按分组走，菜单、出品单都是分组的档口；核对列表列出不一致的菜', async () => {
    expect((await api(ctx.app, ctx.clerk, 'PUT', '/api/admin/dining/group-stations', { groupStations: { 'restaurant:点心': station['茶点'] } })).status).toBe(403);
    expect((await api(ctx.app, boss, 'PUT', '/api/admin/dining/group-stations', { groupStations: { 'restaurant:不存在': station['茶点'] } })).status).toBe(400);
    const r = await api(ctx.app, boss, 'PUT', '/api/admin/dining/group-stations', { groupStations: { 'restaurant:点心': station['茶点'] } });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.groupStations).toEqual({ 'restaurant:点心': station['茶点'] });
    expect(r.body.mismatches.map((m: { name: string; pinned: boolean; groupStationName: string }) => [m.name, m.pinned, m.groupStationName])).toEqual([
      ['虾饺', false, '茶点'],
      ['虾饼', false, '茶点'],
    ]);
    const menu = (await api(ctx.app, ctx.clerk, 'GET', '/api/dining/menu')).body as { dishes: { id: number; stationName: string }[] };
    expect(menu.dishes.find((d) => d.id === item['虾饺'])!.stationName).toBe('茶点');
    expect(menu.dishes.find((d) => d.id === item['小炒肉'])!.stationName).toBe('中厨');
    // 保存餐饮规则不动分组默认档口
    expect((await api(ctx.app, ctx.owner, 'PUT', '/api/admin/dining/rules', { warnMinutes: 20 })).body.rules.groupStations).toEqual({ 'restaurant:点心': station['茶点'] });

    // 虾饼确实在中厨做：单独设档口
    const pin = await api(ctx.app, boss, 'PUT', '/api/admin/dining/items/pinned', { items: [{ id: item['虾饼'], pinned: true }] });
    expect(pin.status, JSON.stringify(pin.body)).toBe(200);
    expect(pin.body.mismatches.find((m: { name: string }) => m.name === '虾饼').pinned).toBe(true);

    const v = await checkin();
    const o = await wristOrder(
      v,
      [
        { itemId: item['虾饺'], quantity: 1 },
        { itemId: item['虾饼'], quantity: 1 },
        { itemId: item['小炒肉'], quantity: 1 },
      ],
      3800 + 4200 + 5800,
    );
    expect(o.status, JSON.stringify(o.body)).toBe(200);
    expect((await kitchenOf('虾饺'))[0]!.stationId).toBe(station['茶点']);
    expect((await kitchenOf('虾饼'))[0]!.stationId).toBe(station['中厨']);
    expect((await kitchenOf('小炒肉'))[0]!.stationId).toBe(station['中厨']);

    // 小炒肉的分组（餐饮）没设默认档口：换档口不记成单独设
    await api(ctx.app, boss, 'PUT', '/api/admin/dining/items', { items: [{ id: item['小炒肉'], stationId: station['旧档口'] }] });
    const [row] = await ctx.sql<{ stationPinned: boolean }[]>`SELECT station_pinned FROM service_items WHERE id = ${item['小炒肉']!}`;
    expect(row!.stationPinned).toBe(false);
    await api(ctx.app, boss, 'PUT', '/api/admin/dining/items', { items: [{ id: item['小炒肉'], stationId: station['中厨'] }] });

    // 分组的默认档口停用：照菜自己的档口出
    const off = await api(ctx.app, boss, 'PUT', `/api/admin/dining/stations/${station['茶点']}`, { name: '茶点', active: false });
    expect(off.status).toBe(200);
    expect((await api(ctx.app, ctx.clerk, 'GET', '/api/dining/menu')).body.dishes.find((d: { id: number }) => d.id === item['虾饺']).stationName).toBe('中厨');
    await api(ctx.app, boss, 'PUT', `/api/admin/dining/stations/${station['茶点']}`, { name: '茶点', active: true });
    const [audit] = await ctx.sql<{ detail: { summary: string } }[]>`SELECT detail FROM audit_logs WHERE action = 'items_station_pinned' ORDER BY id DESC LIMIT 1`;
    expect(audit!.detail.summary).toContain('虾饼 → 单独设档口');
  });

  it('手工下的临时项目选了档口：记在餐饮、照常出厨房单；不选的照旧不进厨房；停用的档口拒绝', async () => {
    const v = await checkin();
    const post = (customLines: Record<string, unknown>[], total: number) =>
      api(ctx.app, ctx.clerk, 'POST', `/api/frontdesk/visits/${v}/charges`, { clientKey: randomUUID(), lines: [], customLines, expectedTotal: total });
    const r = await post(
      [
        { name: '临时点心拼盘', amount: 6600, stationId: station['茶点'] },
        { name: '临时毛巾', amount: 1000 },
      ],
      7600,
    );
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const k = await kitchenOf('临时点心拼盘');
    expect(k).toEqual([{ itemId: null, stationId: station['茶点'], status: 'queued' }]);
    expect(await kitchenOf('临时毛巾')).toEqual([]);
    const lines = (await api(ctx.app, ctx.clerk, 'GET', `/api/frontdesk/visits/${v}`)).body.lines as Line[];
    expect(lines.map((l) => [l.name, l.source])).toEqual([
      ['临时点心拼盘', 'dining'],
      ['临时毛巾', 'bath'],
    ]);
    // 厨房屏上看得到（菜名是账单上的名字）
    const board = (await api(ctx.app, ctx.clerk, 'GET', '/api/kitchen')).body as { items: { name: string; itemId: number | null; stationName: string }[] };
    expect(board.items.find((i) => i.name === '临时点心拼盘')).toMatchObject({ itemId: null, stationName: '茶点' });
    // 退掉：出品单一起退
    const line = lines.find((l) => l.name === '临时点心拼盘')!;
    const voided = await api(ctx.app, ctx.owner, 'POST', `/api/frontdesk/lines/${line.id}/void`, { reason: '客人不要了' });
    expect(voided.status, JSON.stringify(voided.body)).toBe(200);
    expect((await kitchenOf('临时点心拼盘'))[0]!.status).toBe('cancelled');
    // 停用的档口
    await api(ctx.app, boss, 'PUT', `/api/admin/dining/stations/${station['旧档口']}`, { name: '旧档口', active: false });
    expect((await post([{ name: '临时', amount: 100, stationId: station['旧档口'] }], 100)).body.error.code).toBe('STATION_INACTIVE');
    // 前台自检照样一致（餐饮明细都有出品单）
    const checks = (await api(ctx.app, ctx.owner, 'GET', '/api/frontdesk/checks')).body as { key: string; ok: boolean; detail: string }[];
    expect(checks.filter((c) => !c.ok)).toEqual([]);
  });

  it('8.2.5：临时项目进厨房也按出品口核对下单权限——没有「在餐厅下单」的不能借临时项目送进餐厅的档口（Codex 审查）', async () => {
    const v = await checkin();
    const post = (customLines: Record<string, unknown>[], total: number) =>
      api(ctx.app, ctx.clerk, 'POST', `/api/frontdesk/visits/${v}/charges`, { clientKey: randomUUID(), lines: [], customLines, expectedTotal: total });
    const overrides = (value: Record<string, unknown>) =>
      ctx.sql`INSERT INTO settings (key, value) VALUES ('role_permissions', ${ctx.sql.json(value as never)}) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`;
    await overrides({ clerk: { add: [], remove: ['dining.orderRestaurant'] } });
    try {
      const denied = await post([{ name: '临时点心', amount: 3000, stationId: station['茶点'] }], 3000);
      expect(denied.status).toBe(403);
      expect(denied.body.error.code).toBe('OUTLET_FORBIDDEN');
      expect(await kitchenOf('临时点心')).toEqual([]);
      // 不进厨房的临时项目照旧能挂
      expect((await post([{ name: '临时杂项', amount: 500 }], 500)).status).toBe(200);
    } finally {
      await overrides({});
    }
    expect((await post([{ name: '临时点心', amount: 3000, stationId: station['茶点'] }], 3000)).status).toBe(200);
  });
});

describe('包房房型：低消、中消、只收房费；服务费门店默认', () => {
  it('中消与桌台规则的先后（纯函数）', () => {
    const rt = { name: '中房', chargeMode: 'min_spend' as const, minSpend: 80000, midSpend: 50000, midStart: 14 * 60, midEnd: 17 * 60, midMaxGuests: 4, roomFee: 0 };
    expect(usesMidSpend(rt, { openedMinute: 15 * 60, guests: 8 })).toBe(true);
    expect(usesMidSpend(rt, { openedMinute: 19 * 60, guests: 4 })).toBe(true);
    expect(usesMidSpend(rt, { openedMinute: 19 * 60, guests: 6 })).toBe(false);
    // 跨零点的时段
    expect(usesMidSpend({ ...rt, midStart: 22 * 60, midEnd: 2 * 60, midMaxGuests: null }, { openedMinute: 60, guests: 9 })).toBe(true);
    const store = { serviceFeeBp: 1500, serviceFeeScope: 'rooms' as const };
    expect(tableRuleOf({ minSpend: 0, serviceFeeBp: null, roomType: rt }, store, { openedMinute: 19 * 60, guests: 6 })).toMatchObject({
      minSpend: 80000,
      minSpendFrom: 'room_type',
      serviceFeeBp: 1500,
    });
    expect(tableRuleOf({ minSpend: 30000, serviceFeeBp: 0, roomType: rt }, store, { openedMinute: 15 * 60, guests: 2 })).toMatchObject({ minSpend: 30000, minSpendFrom: 'table', serviceFeeBp: 0 });
    // 大厅（没挂房型）不收门店默认的服务费；设成所有桌台才收
    expect(tableRuleOf({ minSpend: 0, serviceFeeBp: null, roomType: null }, store, { openedMinute: 0, guests: 2 }).serviceFeeBp).toBe(0);
    expect(tableRuleOf({ minSpend: 0, serviceFeeBp: null, roomType: null }, { ...store, serviceFeeScope: 'all' }, { openedMinute: 0, guests: 2 }).serviceFeeBp).toBe(1500);
  });

  it('后台建房型、桌台挂房型；人数少用中消；桌台自己设的优先；只收房费的结账记一行房费；服务费跟门店默认', async () => {
    const add = (body: Record<string, unknown>) => api(ctx.app, boss, 'POST', '/api/admin/dining/room-types', body);
    expect((await api(ctx.app, ctx.clerk, 'POST', '/api/admin/dining/room-types', { name: '小房', chargeMode: 'min_spend', minSpend: 50000 })).status).toBe(403);
    expect((await add({ name: '小房', chargeMode: 'min_spend', minSpend: 50000, midSpend: 30000 })).status).toBe(400);
    const small = await add({ name: '小房', chargeMode: 'min_spend', minSpend: 50000, midSpend: 30000, midMaxGuests: 2 });
    expect(small.status, JSON.stringify(small.body)).toBe(200);
    expect((await add({ name: '小房', chargeMode: 'min_spend', minSpend: 1 })).body.error.code).toBe('ROOM_TYPE_NAME_TAKEN');
    const tea = await add({ name: '茶房', chargeMode: 'room_fee', roomFee: 8800, minSpend: 99999 });
    expect(tea.status, JSON.stringify(tea.body)).toBe(200);
    for (const r of tea.body.roomTypes) roomType[r.name] = r.id;
    // 只收房费的不留低消
    expect(tea.body.roomTypes.find((r: { name: string }) => r.name === '茶房')).toMatchObject({ chargeMode: 'room_fee', minSpend: 0, roomFee: 8800 });

    expect(await saveTable('包A', { roomTypeId: roomType['小房'] })).toMatchObject({ roomTypeId: roomType['小房'], serviceFeeBp: null, minSpend: 0 });
    await saveTable('包B', { roomTypeId: roomType['小房'], minSpend: 20000 });
    await saveTable('茶房', { roomTypeId: roomType['茶房'] });
    // 门店默认服务费 15%（只用在包房）
    const rules = await api(ctx.app, ctx.owner, 'PUT', '/api/admin/dining/rules', { serviceFeeBp: 1500 });
    expect(rules.status, JSON.stringify(rules.body)).toBe(200);
    expect((await api(ctx.app, boss, 'PUT', '/api/admin/dining/rules', { serviceFeeBp: 0 })).status).toBe(403);

    const two = await open(table['包A']!, 2);
    const four = await open(table['包B']!, 4);
    const hall = await open(table['A1']!, 2);
    const teaRoom = await open(table['茶房']!, 3);
    for (const s of [two, four, hall, teaRoom]) expect((await order(s, [{ itemId: item['小炒肉'], quantity: 2 }], 11600)).status).toBe(200);
    const p = await preview([two]);
    expect(p.sessions[0].charge).toMatchObject({ minSpend: 30000, minSpendFrom: 'mid', serviceFeeBp: 1500, serviceFee: 1740, roomTypeName: '小房', shortfall: 30000 - 11600 });
    expect((await preview([four])).sessions[0].charge).toMatchObject({ minSpend: 20000, minSpendFrom: 'table', serviceFee: 1740 });
    expect((await preview([hall])).sessions[0].charge).toMatchObject({ minSpend: 0, serviceFeeBp: 0, serviceFee: 0 });
    const tp = await preview([teaRoom]);
    expect(tp.sessions[0].charge).toMatchObject({ minSpend: 0, roomFee: 8800, serviceFee: 1740 });
    expect(tp.totalAmount).toBe(11600 + 1740 + 8800);
    // 只收房费：结账记一行房费
    const paid = await pay([teaRoom], tp.totalAmount);
    expect(paid.status, JSON.stringify(paid.body)).toBe(200);
    const lines = (await detail(teaRoom)).lines.filter((l) => l.status === 'active').map((l) => [l.name, l.amount]);
    expect(lines).toEqual([
      ['小炒肉', 11600],
      ['服务费 15%', 1740],
      ['房费（茶房）', 8800],
    ]);
    // 大厅照常结
    expect((await pay([hall], 11600)).status).toBe(200);
    // 桌台自己设 0：不收服务费
    expect(await saveTable('包B', { serviceFeeBp: 0 })).toMatchObject({ serviceFeeBp: 0 });
    expect((await preview([four])).sessions[0].charge).toMatchObject({ serviceFeeBp: 0, serviceFeeFrom: 'table' });
    table.two = two;
    table.four = four;
  });
});

describe('返台补低消', () => {
  const back = (sessionId: number, body: Record<string, unknown>, cookie = boss) => api(ctx.app, cookie, 'POST', `/api/dining/tables/sessions/${sessionId}/return`, body);

  it('转挂账的包房单：低消没够的返台回到桌台继续点；同一编号重提照第一次；低消够了不用返台；大厅不能返台', async () => {
    const s = table.two!;
    expect((await api(ctx.app, ctx.clerk, 'POST', `/api/dining/tables/sessions/${s}/park`, { reason: '客人去泡池子，账先挂着' })).status).toBe(200);
    const key = randomUUID();
    expect((await back(s, { clientKey: key, reason: '回来接着吃' }, ctx.clerk)).status).toBe(403);
    expect((await back(s, { clientKey: key, reason: '' })).status).toBe(400);
    // 8.2.5：返台进「结果待确认」——员工确认作废过的编号，原请求再到整笔回滚（Codex 审查）
    const fenced = randomUUID();
    const abandoned = await api(ctx.app, boss, 'POST', `/api/frontdesk/ops/${fenced}/abandon`, { type: 'table_return' });
    expect(abandoned.status, JSON.stringify(abandoned.body)).toBe(200);
    expect(abandoned.body).toMatchObject({ found: false, abandoned: true });
    expect((await back(s, { clientKey: fenced, reason: '回来接着吃' })).body.error.code).toBe('OP_ABANDONED');
    expect((await ctx.sql`SELECT 1 FROM table_session_returns WHERE session_id = ${s}`).length).toBe(0);
    const r = await back(s, { clientKey: key, reason: '回来接着吃' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.parkedAt).toBeNull();
    // 按编号查回得到这一桌；已经生效的不能再作废
    const found = await api(ctx.app, boss, 'GET', `/api/frontdesk/ops/${key}?type=table_return`);
    expect(found.body).toMatchObject({ found: true, type: 'table_return', session: { id: s } });
    expect((await api(ctx.app, boss, 'POST', `/api/frontdesk/ops/${key}/abandon`, { type: 'table_return' })).body).toMatchObject({ found: true });
    expect((await back(s, { clientKey: key, reason: '回来接着吃' })).status).toBe(200);
    expect((await ctx.sql`SELECT 1 FROM table_session_returns WHERE session_id = ${s}`).length).toBe(1);
    // 没转挂账的：直接点就行
    expect((await back(s, { clientKey: randomUUID(), reason: '再返一次' })).body.error.code).toBe('RETURN_NOT_ALLOWED');
    // 点够低消以后转挂账，再返台：低消够了
    expect((await order(s, [{ itemId: item['小炒肉'], quantity: 4 }], 23200)).status).toBe(200);
    expect((await api(ctx.app, ctx.clerk, 'POST', `/api/dining/tables/sessions/${s}/park`, { reason: '挂房账' })).status).toBe(200);
    expect((await back(s, { clientKey: randomUUID(), reason: '看看' })).body.error.code).toBe('RETURN_NOT_NEEDED');
    const [a] = await ctx.sql<{ detail: { from: string; minSpend: number } }[]>`SELECT detail FROM audit_logs WHERE action = 'table_return' AND target_id = ${s}`;
    expect(a!.detail).toMatchObject({ from: 'parked', minSpend: 30000 });
  });

  it('已结账、补了低消的包房单：客人没走（待清台）时返台——反结账、自动记的几行作废、桌台回到用餐中；清了台的不能返台', async () => {
    // 包B：低消 200，服务费 0；点了 116，补足低消结账
    await saveTable('包B', { minSpend: 20000 });
    const s = table.four!;
    const p = await preview([s]);
    expect(p.minSpendShortfall).toBe(8400);
    const paid = await pay([s], p.totalAmount + p.minSpendShortfall, { minSpendTopUp: true });
    expect(paid.status, JSON.stringify(paid.body)).toBe(200);
    const checkoutId = paid.body.id as number;
    expect((await detail(s)).status).toBe('settled');

    // 收银员（没有返台、反结账）不能；值班经理以上可以
    expect((await back(s, { clientKey: randomUUID(), reason: '客人还要点' }, ctx.clerk)).status).toBe(403);
    const key = randomUUID();
    const r = await back(s, { clientKey: key, reason: '客人还要点，补到低消' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.status).toBe('open');
    expect(r.body.lines.filter((l: Line) => l.status === 'active').map((l: Line) => l.name)).toEqual(['小炒肉']);
    expect(r.body.amount).toBe(11600);
    const [c] = await ctx.sql<{ status: string; voidReason: string }[]>`SELECT status, void_reason FROM checkouts WHERE id = ${checkoutId}`;
    expect(c).toEqual({ status: 'voided', voidReason: '返台补低消：客人还要点，补到低消' });
    const [t] = await ctx.sql<{ state: string }[]>`SELECT state FROM dining_tables WHERE id = ${table['包B']!}`;
    expect(t!.state).toBe('available');
    expect((await back(s, { clientKey: key, reason: '客人还要点，补到低消' })).status).toBe(200);

    // 补点到低消，再结账不用补足
    expect((await order(s, [{ itemId: item['小炒肉'], quantity: 2 }], 11600)).status).toBe(200);
    const p2 = await preview([s]);
    expect(p2.minSpendShortfall).toBe(0);
    expect((await pay([s], p2.totalAmount)).status).toBe(200);

    // 低消够了结的账不能返台；清了台的也不能
    expect((await back(s, { clientKey: randomUUID(), reason: '再来' })).body.error.code).toBe('RETURN_NOT_NEEDED');
    expect((await ctx.sql`SELECT 1 FROM checkouts WHERE status = 'completed' AND id IN (SELECT checkout_id FROM checkout_bills WHERE table_session_id = ${s})`).length).toBe(1);
  });

  it('清了台（客人走了）的已结账单不能返台，整笔不反结账', async () => {
    const s = await open(table['包A']!, 3);
    expect((await order(s, [{ itemId: item['小炒肉'], quantity: 1 }], 5800)).status).toBe(200);
    const p = await preview([s]);
    const paid = await pay([s], p.totalAmount + p.minSpendShortfall, { minSpendTopUp: true });
    expect(paid.status, JSON.stringify(paid.body)).toBe(200);
    const cleared = await api(ctx.app, ctx.clerk, 'POST', `/api/dining/tables/${table['包A']}/clear`, { clientKey: randomUUID() });
    expect(cleared.status, JSON.stringify(cleared.body)).toBe(200);
    expect((await back(s, { clientKey: randomUUID(), reason: '客人又回来了' })).body.error.code).toBe('RETURN_TABLE_CLEARED');
    const [c] = await ctx.sql<{ status: string }[]>`SELECT status FROM checkouts WHERE id = ${paid.body.id}`;
    expect(c!.status).toBe('completed');
  });
});

describe('公司承担', () => {
  const grant = (cookie: string, approver: string, scope: Record<string, unknown>) =>
    api(ctx.app, cookie, 'POST', '/api/auth/authorize', { username: approver, password: PASSWORD, purpose: 'company_charge', scope });

  it('选原因、当场授权；不进协议单位应收；日结单独列出；金额对不上的拒绝', async () => {
    const v = await checkin();
    expect((await wristOrder(v, [{ itemId: item['小炒肉'], quantity: 1 }], 5800)).status).toBe(200);
    const total = (await api(ctx.app, ctx.clerk, 'GET', `/api/frontdesk/checkout-preview?ids=${v}`)).body.totalAmount as number;
    // 收银员自己没有授权权限
    expect((await grant(ctx.clerk, 'clerk', { visitIds: [v], amount: total, reason: 'unwell' })).body.error.code).toBe('AUTH_NOT_ALLOWED');
    expect((await grant(ctx.clerk, 'boss', { visitIds: [v], amount: total, reason: 'other' })).status).toBe(400);
    const g = await grant(ctx.clerk, 'boss', { visitIds: [v], amount: total, reason: 'unwell', note: '吃坏肚子' });
    expect(g.status, JSON.stringify(g.body)).toBe(200);
    const checkout = (amount: number) =>
      api(ctx.app, ctx.clerk, 'POST', '/api/frontdesk/checkouts', {
        clientKey: randomUUID(),
        visitIds: [v],
        expectedTotal: total,
        payments: [{ method: 'company', amount, reason: 'unwell', note: '吃坏肚子', grantId: g.body.grantId }, ...(amount < total ? [{ method: 'cash', amount: total - amount }] : [])],
      });
    expect((await checkout(total - 100)).body.error.code).toBe('GRANT_SCOPE');
    const paid = await checkout(total);
    expect(paid.status, JSON.stringify(paid.body)).toBe(200);
    const [p] = await ctx.sql<{ method: string; ref: string; companyReason: string; arAccountId: number | null }[]>`
      SELECT method, ref, company_reason, ar_account_id FROM checkout_payments WHERE checkout_id = ${paid.body.id}`;
    expect(p).toEqual({ method: 'company', ref: '客人身体不适：吃坏肚子', companyReason: 'unwell', arAccountId: null });
    expect((await ctx.sql`SELECT 1 FROM ar_charges`).length).toBe(0);
    const date = paid.body.businessDate as string;
    const s = (await api(ctx.app, ctx.owner, 'GET', `/api/settlements/${date}`)).body as {
      anomalies: { kind: string; amount: number; description: string }[];
      business: { byMethod: { method: string; amount: number }[] };
    };
    expect(s.anomalies.filter((a) => a.kind === 'company_charge').map((a) => a.amount)).toEqual([total]);
    expect(s.anomalies.find((a) => a.kind === 'company_charge')!.description).toContain('店总当场授权');
    expect(s.business.byMethod.find((m) => m.method === 'company')!.amount).toBe(total);
    // 授权只能用一次
    expect((await checkout(total)).status).toBe(409);
  });
});
