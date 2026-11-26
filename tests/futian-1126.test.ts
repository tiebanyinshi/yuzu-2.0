// 福田店整改（2026-11-26《福田店餐饮与房态中心整改需求文档》，docs/FUTIAN_1126.md）批次 2 的服务端用例：
//   FT-02 项目编号；FT-06 限时换技师；FT-07 括单与业绩归属；FT-09 限时撤房（免费、回空闲、留痕）；FT-10 下钟后免房费 + FT-17 ④ 按时间计费；
//   FT-11 换房只能换同类型；FT-19 补单（关联房间与时间、记「补单」、计入业绩）；CY-01 同组点单汇总。
// 三个时限都按默认 15 分钟测一遍、按自定义的值再测一遍（第七节）。时间用改库里的时刻模拟（登记时刻、上钟时刻、下钟时刻往前挪）。
// 全部是合成数据。

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DiningGroupSummary } from '../src/shared/dining';
import type { RoomCenterBoard, RoomCheckoutPreview, RoomHistory } from '../src/shared/room-center';
import { DEFAULT_ROOM_CENTER_RULES, roomTimeFee, type RoomCenterRules } from '../src/shared/room-center-rules';
import type { SpaceLedger } from '../src/shared/spaces';
import type { TechnicianReport } from '../src/shared/technicians';
import { api, login, PASSWORD, setup, type TestContext } from './helpers';

let ctx: TestContext;
let foot = 0;
let feeItem = 0;
const tech: Record<string, number> = {};
const spaceId: Record<string, number> = {};
let tagNo = 0;

const SPACES_CSV = [
  '楼层,区域字母,编码,业态,容量(人),建议显示名,面积,编码图原始标注,备注',
  'L3,S,S301,SPA,1,合成SPA 一号,,合成 S301,',
  'L3,S,S302,SPA,1,合成SPA 二号,,合成 S302,',
  'L3,S,S303,SPA,1,合成SPA 三号,,合成 S303,',
  'L3,S,S304,SPA,1,合成SPA 四号,,合成 S304,',
  'L3,F,F311,足浴,2,合成足浴一号,,合成 F311,',
  'L2,H,H201,休息大厅,1,合成大厅床位一,,合成 H201,',
  'L2,H,H202,休息大厅,1,合成大厅床位二,,合成 H202,',
  'L2,H,H203,休息大厅,1,合成大厅床位三,,合成 H203,',
  'L2,W,W201,虫洞,1,合成虫洞一号,,合成 W201,',
  'L2,W,W202,虫洞,1,合成虫洞二号,,合成 W202,',
].join('\r\n');

const board = async () => (await api(ctx.app, ctx.clerk, 'GET', '/api/room-center')).body as RoomCenterBoard;
const room = async (code: string) => (await board()).rooms.find((r) => r.code === code)!;
const on = (code: string, action: string) => `/api/room-center/rooms/${spaceId[code]}/${action}`;
const enter = async (n = 1) => {
  const guests = Array.from({ length: n }, () => {
    tagNo += 1;
    return { tagCode: `F${String(tagNo).padStart(3, '0')}`, zone: 'female' as const };
  });
  const r = await api(ctx.app, ctx.clerk, 'POST', '/api/frontdesk/checkins', { clientKey: randomUUID(), guests });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return (r.body.visits as { id: number }[]).map((v, i) => ({ visitId: v.id, tagCode: guests[i]!.tagCode }));
};
const register = (code: string, body: Record<string, unknown>, cookie = ctx.clerk) =>
  api(ctx.app, cookie, 'POST', on(code, 'register'), {
    clientKey: randomUUID(),
    itemId: foot,
    tier: 'standard',
    quantity: 1,
    callType: 'designated',
    sellerNo: 'clerk',
    note: '',
    start: 'now',
    expectedTotal: 19800,
    ...body,
  });
const act = async (code: string, action: string, body: Record<string, unknown> = {}, cookie = ctx.clerk) =>
  api(ctx.app, cookie, 'POST', on(code, action), { clientKey: randomUUID(), expectedVersion: (await room(code)).version, ...body });
const bill = async (visitId: number) =>
  (await api(ctx.app, ctx.clerk, 'GET', `/api/frontdesk/visits/${visitId}`)).body as {
    bill: { amountCents: number };
    lines: { id: number; name: string; status: string; amount: number; sessionId: number | null; source?: string }[];
  };
const finish = (sessionId: number) => api(ctx.app, ctx.clerk, 'POST', `/api/clockroom/sessions/${sessionId}/finish`);
const preview = async (code: string) => (await api(ctx.app, ctx.clerk, 'GET', on(code, 'checkout-preview'))).body as RoomCheckoutPreview;
const history = async (code: string) => (await api(ctx.app, ctx.clerk, 'GET', on(code, 'history'))).body as RoomHistory;
const rules = async (patch: Partial<RoomCenterRules>) => {
  const cur = (await api(ctx.app, ctx.owner, 'GET', '/api/admin/room-center-rules')).body as RoomCenterRules;
  const r = await api(ctx.app, ctx.owner, 'PUT', '/api/admin/room-center-rules', { ...cur, ...patch });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body as RoomCenterRules;
};
/** 把这间房里的登记往前挪 minutes 分钟（模拟开房已经过了多久） */
// 登记时刻有触发器拦着不让改（正常业务不能改）：测试里临时关掉用户触发器再挪
const ageRegistration = (code: string, minutes: number) =>
  ctx.sql.begin(async (tx) => {
    await tx`ALTER TABLE room_registrations DISABLE TRIGGER USER`;
    await tx`UPDATE room_registrations SET opened_at = opened_at - make_interval(mins => ${minutes}) WHERE space_id = ${spaceId[code]!} AND status = 'open'`;
    await tx`ALTER TABLE room_registrations ENABLE TRIGGER USER`;
  });
/** 把这间房里在钟上的钟单的上钟时刻往前挪 */
const ageStart = (code: string, minutes: number) =>
  ctx.sql`UPDATE technician_sessions SET started_at = started_at - make_interval(mins => ${minutes}) WHERE space_id = ${spaceId[code]!} AND status = 'serving'`;
/** 把这间房里已下钟的钟单的下钟时刻往前挪（模拟下钟后过了多久） */
const ageEnd = (code: string, minutes: number) =>
  ctx.sql`UPDATE technician_sessions SET ended_at = ended_at - make_interval(mins => ${minutes}), started_at = started_at - make_interval(mins => ${minutes})
          WHERE space_id = ${spaceId[code]!} AND status = 'done'`;
/** 收拾干净：在钟上的下钟、退房、清洁完成 */
const release = async (code: string) => {
  for (const g of (await room(code)).guests) for (const s of g.sessions) if (s.status === 'serving') expect((await finish(s.id)).status).toBe(200);
  const p = await preview(code);
  if (p.guests.length) expect((await act(code, 'checkout', { seenUnpaid: p.unpaidTotal, inHouse: true })).status).toBe(200);
  if ((await room(code)).status === 'dirty') expect((await act(code, 'cleaned')).status).toBe(200);
};
const pay = async (visitId: number) => {
  const p = (await api(ctx.app, ctx.clerk, 'GET', `/api/frontdesk/checkout-preview?ids=${visitId}`)).body;
  const r = await api(ctx.app, ctx.clerk, 'POST', '/api/frontdesk/checkouts', {
    clientKey: randomUUID(),
    visitIds: [visitId],
    expectedTotal: p.totalAmount,
    payments: [{ method: 'cash', amount: p.totalAmount }],
  });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
};
const report = async () => {
  const today = (await api(ctx.app, ctx.clerk, 'GET', '/api/business-day')).body.today as string;
  const from = new Date(Date.parse(`${today}T00:00:00Z`) - 3 * 86_400_000).toISOString().slice(0, 10);
  const r = await api(ctx.app, ctx.owner, 'GET', `/api/reports/technicians?from=${from}&to=${today}`);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body as TechnicianReport;
};

beforeAll(async () => {
  ctx = await setup();
  const imp = await api(ctx.app, ctx.owner, 'POST', '/api/admin/spaces/imports', { kind: 'spaces', fileName: 'spaces.csv', csv: SPACES_CSV, encoding: 'UTF-8', clientKey: randomUUID() });
  expect(imp.status, JSON.stringify(imp.body)).toBe(201);
  for (const s of ((await api(ctx.app, ctx.owner, 'GET', '/api/admin/spaces')).body as SpaceLedger).spaces) spaceId[s.code] = s.id;
  expect((await api(ctx.app, ctx.owner, 'POST', '/api/frontdesk/tags/batch', { prefix: 'F', from: 1, to: 60, width: 3, zone: 'female' })).status).toBe(200);
  const item = await api(ctx.app, ctx.owner, 'POST', '/api/items', { name: '足疗', category: '足疗', durationMinutes: 90, technicianRequired: true, price: 19800 });
  foot = item.body.items.find((i: { name: string }) => i.name === '足疗').id;
  // 房费项目：每小时 60 元
  const fee = await api(ctx.app, ctx.owner, 'POST', '/api/items', { name: 'SPA 房费', category: '房费', price: 6000 });
  feeItem = fee.body.items.find((i: { name: string }) => i.name === 'SPA 房费').id;
  for (const no of ['01', '02', '03', '04']) {
    const r = await api(ctx.app, ctx.owner, 'POST', '/api/admin/technicians', { techNo: no, name: `技师${no}`, gender: 'female', grade: 'standard' });
    tech[no] = r.body.technicians.find((t: { techNo: string }) => t.techNo === no).id;
  }
  expect((await api(ctx.app, ctx.owner, 'PUT', '/api/admin/technicians/rules', { enabled: true })).status).toBe(200);
  for (const no of Object.keys(tech)) expect((await api(ctx.app, ctx.clerk, 'POST', `/api/clockroom/technicians/${tech[no]}/state`, { action: 'sign_in' })).status).toBe(200);
});
afterAll(async () => ctx.close());

describe('房态中心规则（后台）', () => {
  it('没设过的按默认：三个时限 15 分钟、不收房费；看板带上时限；店员不能改；时限超范围拒绝', async () => {
    const r = (await api(ctx.app, ctx.owner, 'GET', '/api/admin/room-center-rules')).body as RoomCenterRules;
    expect(r).toMatchObject({ swapTechMinutes: 15, revokeMinutes: 15, freeAfterClockOffMinutes: 15, roomFees: [] });
    expect(DEFAULT_ROOM_CENTER_RULES.revokeMinutes).toBe(15);
    expect((await board()).limits).toEqual({ swapTechMinutes: 15, revokeMinutes: 15, freeAfterClockOffMinutes: 15 });
    expect((await api(ctx.app, ctx.clerk, 'PUT', '/api/admin/room-center-rules', r)).status).toBe(403);
    expect((await api(ctx.app, ctx.owner, 'PUT', '/api/admin/room-center-rules', { ...r, revokeMinutes: 999 })).status).toBe(400);
    // 开着的计费规则要选项目
    const bad = await api(ctx.app, ctx.owner, 'PUT', '/api/admin/room-center-rules', {
      ...r,
      roomFees: [{ businessType: 'SPA', enabled: true, feeItemId: null, minMinutes: 60, stepMinutes: 30, capCents: 0 }],
    });
    expect(bad.status).toBe(400);
  });

  it('房费算法（纯函数）：没到开始计费为 0；不足起步按起步；之后按计费单位向上取整；封顶', () => {
    const rule = { minMinutes: 60, stepMinutes: 30, capCents: 0 };
    const t0 = new Date('2026-11-26T10:00:00Z');
    const at = (m: number) => new Date(t0.getTime() + m * 60_000);
    expect(roomTimeFee(null, at(30), rule, 6000).amount).toBe(0);
    expect(roomTimeFee(t0, at(0), rule, 6000).amount).toBe(0);
    expect(roomTimeFee(t0, at(5), rule, 6000)).toMatchObject({ minutes: 5, chargedMinutes: 60, amount: 6000 });
    expect(roomTimeFee(t0, at(61), rule, 6000)).toMatchObject({ chargedMinutes: 90, amount: 9000 });
    expect(roomTimeFee(t0, at(240), { ...rule, capCents: 15000 }, 6000)).toMatchObject({ amount: 15000, capped: true });
  });
});

describe('FT-02 项目编号', () => {
  it('新建、修改带编号（转大写）；同一个编号不能给两个在用的项目；不带编号保持原值；清空', async () => {
    const a = await api(ctx.app, ctx.owner, 'POST', '/api/items', { name: '编号甲', category: '足疗', price: 9800, technicianRequired: true, code: 'a01' });
    expect(a.status, JSON.stringify(a.body)).toBe(200);
    const ia = a.body.items.find((i: { name: string }) => i.name === '编号甲');
    expect(ia.catalogCode).toBe('A01');
    const dup = await api(ctx.app, ctx.owner, 'POST', '/api/items', { name: '编号乙', category: '足疗', price: 9800, code: 'A01' });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('ITEM_CODE_TAKEN');
    expect((await api(ctx.app, ctx.owner, 'POST', '/api/items', { name: '编号丙', category: '足疗', price: 9800, code: 'A 0' })).status).toBe(400);
    // 编辑时不带编号（旧页面）：保持原值
    const kept = await api(ctx.app, ctx.owner, 'PUT', `/api/items/${ia.id}`, { name: '编号甲', category: '足疗', price: 9800, technicianRequired: true });
    expect(kept.body.items.find((i: { id: number }) => i.id === ia.id).catalogCode).toBe('A01');
    const cleared = await api(ctx.app, ctx.owner, 'PUT', `/api/items/${ia.id}`, { name: '编号甲', category: '足疗', price: 9800, technicianRequired: true, code: '' });
    expect(cleared.body.items.find((i: { id: number }) => i.id === ia.id).catalogCode).toBeNull();
    // 清空以后别的项目可以用
    expect((await api(ctx.app, ctx.owner, 'POST', '/api/items', { name: '编号乙', category: '足疗', price: 9800, code: 'A01' })).status).toBe(200);
  });
});

describe('FT-09 撤房', () => {
  it('默认 15 分钟内：撤房不收费（明细作废、账单减回去）、房间回到空闲（不转待清）、技师空出来、留操作记录与审计', async () => {
    const [g] = await enter();
    const r = await register('S301', { tagCode: g!.tagCode, technicianId: tech['01'] });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect((await bill(g!.visitId)).bill.amountCents).toBe(19800);
    expect((await act('S301', 'revoke', { reason: 'x' })).status).toBe(400);
    const ok = await act('S301', 'revoke', { reason: '开错房间' });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    const b = await bill(g!.visitId);
    expect(b.bill.amountCents).toBe(0);
    expect(b.lines.every((l) => l.status === 'voided')).toBe(true);
    const s = await room('S301');
    expect(s.status).toBe('free');
    expect(s.guests).toEqual([]);
    const [reg] = await ctx.sql<{ closeKind: string }[]>`SELECT close_kind FROM room_registrations WHERE visit_id = ${g!.visitId}`;
    expect(reg!.closeKind).toBe('revoked');
    const h = await history('S301');
    expect(h.rows.some((x) => x.kind === 'revoke' && x.text.includes('开错房间'))).toBe(true);
    const [audit] = await ctx.sql`SELECT detail FROM audit_logs WHERE action = 'room_center_revoke' ORDER BY id DESC LIMIT 1`;
    expect(audit).toBeTruthy();
    // 技师回来了：可以马上再派给别人
    const [g2] = await enter();
    expect((await register('S301', { tagCode: g2!.tagCode, technicianId: tech['01'] })).status).toBe(200);
    await release('S301');
  });

  it('换过技师再撤房：换掉的钟也不算用过房间，房间照样回到空闲', async () => {
    const [g] = await enter();
    expect((await register('S301', { tagCode: g!.tagCode, technicianId: tech['01'] })).status).toBe(200);
    const s = (await room('S301')).guests[0]!.sessions[0]!;
    const sw = await api(ctx.app, ctx.clerk, 'POST', on('S301', 'swap-tech'), { clientKey: randomUUID(), sessionId: s.id, technicianId: tech['02'], callType: 'designated', reason: '客人要换' });
    expect(sw.status, JSON.stringify(sw.body)).toBe(200);
    expect((await act('S301', 'revoke', { reason: '开错房间' })).status).toBe(200);
    expect((await room('S301')).status).toBe('free');
    expect((await bill(g!.visitId)).bill.amountCents).toBe(0);
  });

  it('默认 15 分钟：开房 16 分钟以后不能撤（REVOKE_TOO_LATE）；已经下钟的不能撤（REVOKE_DONE）', async () => {
    const [g] = await enter();
    expect((await register('S302', { tagCode: g!.tagCode, technicianId: tech['02'] })).status).toBe(200);
    await ageRegistration('S302', 14);
    expect((await board()).rooms.find((x) => x.code === 'S302')!.guests[0]!.since).toBeTruthy();
    await ageRegistration('S302', 2); // 一共 16 分钟
    const late = await act('S302', 'revoke', { reason: '客人不做了' });
    expect(late.status).toBe(422);
    expect(late.body.error.code).toBe('REVOKE_TOO_LATE');
    await release('S302');

    const [g2] = await enter();
    expect((await register('S302', { tagCode: g2!.tagCode, technicianId: tech['02'] })).status).toBe(200);
    for (const s of (await room('S302')).guests[0]!.sessions) expect((await finish(s.id)).status).toBe(200);
    const done = await act('S302', 'revoke', { reason: '客人不做了' });
    expect(done.status).toBe(409);
    expect(done.body.error.code).toBe('REVOKE_DONE');
    await release('S302');
  });

  it('自定义 30 分钟：20 分钟能撤、31 分钟不能；设成 0 是不开（REVOKE_OFF）', async () => {
    await rules({ revokeMinutes: 30 });
    expect((await board()).limits.revokeMinutes).toBe(30);
    const [g] = await enter();
    expect((await register('S303', { tagCode: g!.tagCode, technicianId: tech['03'] })).status).toBe(200);
    await ageRegistration('S303', 20);
    expect((await act('S303', 'revoke', { reason: '开错房间' })).status).toBe(200);
    const [g2] = await enter();
    expect((await register('S303', { tagCode: g2!.tagCode, technicianId: tech['03'] })).status).toBe(200);
    await ageRegistration('S303', 31);
    expect((await act('S303', 'revoke', { reason: '开错房间' })).body.error.code).toBe('REVOKE_TOO_LATE');
    await rules({ revokeMinutes: 0 });
    expect((await act('S303', 'revoke', { reason: '开错房间' })).body.error.code).toBe('REVOKE_OFF');
    await rules({ revokeMinutes: 15 });
    await release('S303');
  });
});

describe('FT-06 换技师', () => {
  const swap = (code: string, body: Record<string, unknown>) =>
    api(ctx.app, ctx.clerk, 'POST', on(code, 'swap-tech'), { clientKey: randomUUID(), callType: 'designated', reason: '客人要换', ...body });

  it('默认 15 分钟内能换：原明细作废、新技师挂同样的金额、新钟单在这间房里接着上钟；16 分钟以后不能换', async () => {
    const [g] = await enter();
    expect((await register('S304', { tagCode: g!.tagCode, technicianId: tech['01'] })).status).toBe(200);
    const s = (await room('S304')).guests[0]!.sessions[0]!;
    const ok = await swap('S304', { sessionId: s.id, technicianId: tech['02'] });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    const r = await room('S304');
    expect(r.status).toBe('in_use');
    const now = r.guests[0]!.sessions.filter((x) => x.status !== 'done');
    expect(now.map((x) => x.techNo)).toEqual(['02']);
    expect(now[0]!.status).toBe('serving');
    const b = await bill(g!.visitId);
    expect(b.bill.amountCents).toBe(19800);
    expect(b.lines.filter((l) => l.status === 'active')).toHaveLength(1);
    // 16 分钟以后不能再换
    await ageStart('S304', 16);
    const late = await swap('S304', { sessionId: now[0]!.id, technicianId: tech['03'] });
    expect(late.status).toBe(422);
    expect(late.body.error.code).toBe('SWAP_TOO_LATE');
    await release('S304');
  });

  it('自定义 30 分钟：上钟 20 分钟还能换、31 分钟不能；不在这间房的钟单拒绝', async () => {
    await rules({ swapTechMinutes: 30 });
    const [g] = await enter();
    expect((await register('S304', { tagCode: g!.tagCode, technicianId: tech['01'] })).status).toBe(200);
    await ageStart('S304', 20);
    const s = (await room('S304')).guests[0]!.sessions[0]!;
    expect((await swap('S301', { sessionId: s.id, technicianId: tech['02'] })).body.error.code).toBe('SESSION_NOT_IN_ROOM');
    expect((await swap('S304', { sessionId: s.id, technicianId: tech['02'] })).status).toBe(200);
    await ageStart('S304', 31);
    const s2 = (await room('S304')).guests[0]!.sessions.find((x) => x.status === 'serving')!;
    expect((await swap('S304', { sessionId: s2.id, technicianId: tech['03'] })).body.error.code).toBe('SWAP_TOO_LATE');
    await rules({ swapTechMinutes: 15 });
    await release('S304');
  });
});

describe('FT-07 括单', () => {
  it('括单要点钟；登记后客人与房间标「括单」；结账后业绩（点钟、金额）记在这位技师名下', async () => {
    const [g] = await enter();
    expect((await register('S301', { tagCode: g!.tagCode, technicianId: tech['04'], callType: 'rotation', bracket: true })).status).toBe(400);
    const before = (await report()).rows.find((r) => r.technicianId === tech['04']);
    const r = await register('S301', { tagCode: g!.tagCode, technicianId: tech['04'], bracket: true });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect((await room('S301')).guests[0]!.kind).toBe('bracket');
    await release('S301');
    await pay(g!.visitId);
    const after = (await report()).rows.find((x) => x.technicianId === tech['04'])!;
    expect(after.designated - (before?.designated ?? 0)).toBe(1);
    expect(after.amount - (before?.amount ?? 0)).toBe(19800);
  });
});

describe('FT-11 换房只能换同类型', () => {
  it('SPA 换足浴拒绝（MOVE_OTHER_TYPE）；SPA 换 SPA 照常', async () => {
    const [g] = await enter();
    expect((await register('S302', { tagCode: g!.tagCode, technicianId: tech['01'] })).status).toBe(200);
    const bad = await act('S302', 'move', { toSpaceId: spaceId.F311, note: '' });
    expect(bad.status).toBe(422);
    expect(bad.body.error.code).toBe('MOVE_OTHER_TYPE');
    expect((await act('S302', 'move', { toSpaceId: spaceId.S303, note: '' })).status).toBe(200);
    expect((await room('S303')).status).toBe('in_use');
    await release('S303');
    if ((await room('S302')).status === 'dirty') await act('S302', 'cleaned');
  });
});

describe('FT-10 下钟后免房费 + FT-17 按时间计费', () => {
  it('没设计费的业态不收房费；设了以后：下钟 10 分钟内（默认免 15 分钟）不收，20 分钟按起步收；记在手牌上、房间历史有「房费」', async () => {
    const [g] = await enter();
    expect((await register('S301', { tagCode: g!.tagCode, technicianId: tech['01'] })).status).toBe(200);
    for (const s of (await room('S301')).guests[0]!.sessions) expect((await finish(s.id)).status).toBe(200);
    expect((await preview('S301')).roomFee).toBeNull();
    await rules({ roomFees: [{ businessType: 'SPA', enabled: true, feeItemId: feeItem, minMinutes: 60, stepMinutes: 30, capCents: 0 }] });
    await ageEnd('S301', 10);
    let p = await preview('S301');
    expect(p.roomFee).toMatchObject({ amount: 0, freeMinutes: 15, tagCode: g!.tagCode });
    await ageEnd('S301', 10); // 下钟 20 分钟：计费 5 分钟，按起步 60 分钟 = 60 元
    p = await preview('S301');
    expect(p.roomFee).toMatchObject({ amount: 6000, chargedMinutes: 60 });
    const out = await act('S301', 'checkout', { seenUnpaid: p.unpaidTotal, inHouse: true });
    expect(out.status, JSON.stringify(out.body)).toBe(200);
    const b = await bill(g!.visitId);
    expect(b.bill.amountCents).toBe(19800 + 6000);
    expect(JSON.stringify(b.lines.filter((l) => l.status === 'active').map((l) => [l.name, l.amount]))).toContain('6000');
    expect(
      b.lines.some((l) => l.status === 'active' && l.name.includes('房费') && l.amount === 6000),
      JSON.stringify(b.lines),
    ).toBe(true);
    expect((await history('S301')).rows.some((x) => x.kind === 'room_fee')).toBe(true);
    await act('S301', 'cleaned');
  });

  it('自定义免费 30 分钟：下钟 20 分钟不收，40 分钟收；客人带手牌在店的才让退（房费也算没结的）', async () => {
    await rules({ freeAfterClockOffMinutes: 30 });
    const [g] = await enter();
    expect((await register('S302', { tagCode: g!.tagCode, technicianId: tech['02'] })).status).toBe(200);
    for (const s of (await room('S302')).guests[0]!.sessions) expect((await finish(s.id)).status).toBe(200);
    await ageEnd('S302', 20);
    expect((await preview('S302')).roomFee).toMatchObject({ amount: 0, freeMinutes: 30 });
    await ageEnd('S302', 20);
    const p = await preview('S302');
    expect(p.roomFee!.amount).toBe(6000);
    // 没勾「带手牌在店」拒绝
    expect((await act('S302', 'checkout', { seenUnpaid: p.unpaidTotal, inHouse: false })).status).not.toBe(200);
    expect((await act('S302', 'checkout', { seenUnpaid: p.unpaidTotal, inHouse: true })).status).toBe(200);
    expect((await bill(g!.visitId)).bill.amountCents).toBe(19800 + 6000);
    await act('S302', 'cleaned');
    await rules({ freeAfterClockOffMinutes: 15, roomFees: [] });
  });
});

describe('FT-19 补单', () => {
  it('要「补录纸质单」权限；挂到手牌上、钟单记在这间房、记为已下钟，房间不占也不转待清；登记单记「补单」；结账后计入技师业绩', async () => {
    // 客人 4 小时前入场（按纸质单补录的接待），3 小时前做的足疗漏开了单
    tagNo += 1;
    const code = `F${String(tagNo).padStart(3, '0')}`;
    const ci = await api(ctx.app, ctx.owner, 'POST', '/api/frontdesk/checkins', {
      clientKey: randomUUID(),
      guests: [{ tagCode: code, zone: 'female' }],
      backfill: { slipNo: 'CI-1', at: new Date(Date.now() - 4 * 3_600_000).toISOString() },
    });
    expect(ci.status, JSON.stringify(ci.body)).toBe(201);
    const g = { visitId: ci.body.visits[0].id as number, tagCode: code };
    const startedAt = new Date(Date.now() - 3 * 3_600_000).toISOString();
    const body = { tagCode: g!.tagCode, itemId: foot, tier: 'standard', technicianId: tech['03'], callType: 'designated', sellerNo: 'clerk', slipNo: 'SG-88', startedAt, expectedTotal: 19800 };
    expect((await api(ctx.app, ctx.clerk, 'POST', on('S304', 'backfill'), { clientKey: randomUUID(), ...body })).status).toBe(403);
    const before = (await report()).rows.find((r) => r.technicianId === tech['03']);
    const r = await api(ctx.app, ctx.owner, 'POST', on('S304', 'backfill'), { clientKey: randomUUID(), ...body });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect((await room('S304')).status).toBe('free');
    const [s] = await ctx.sql<{ status: string; spaceId: number; roomNeutral: boolean; startedAt: Date }[]>`
      SELECT s.status, s.space_id, s.room_neutral, s.started_at FROM technician_sessions s JOIN bill_lines l ON l.session_id = s.id
      WHERE l.bill_id = (SELECT bill_id FROM visits WHERE id = ${g!.visitId}) AND l.status = 'active'`;
    expect(s).toMatchObject({ status: 'done', spaceId: spaceId.S304, roomNeutral: true });
    expect(Math.abs(new Date(s!.startedAt).getTime() - new Date(startedAt).getTime())).toBeLessThan(60_000);
    const [reg] = await ctx.sql<{ kind: string; status: string; closeKind: string }[]>`SELECT kind, status, close_kind FROM room_registrations WHERE visit_id = ${g!.visitId}`;
    expect(reg).toEqual({ kind: 'backfill', status: 'closed', closeKind: 'backfill' });
    const h = await history('S304');
    expect(h.rows.some((x) => x.kind === 'backfill' && x.text.includes('SG-88'))).toBe(true);
    // 48 小时以前的不能补；客人不在店的不能补
    const old = await api(ctx.app, ctx.owner, 'POST', on('S304', 'backfill'), { clientKey: randomUUID(), ...body, startedAt: new Date(Date.now() - 49 * 3_600_000).toISOString() });
    expect(old.body.error.code).toBe('BACKFILL_WINDOW');
    await pay(g!.visitId);
    const after = (await report()).rows.find((x) => x.technicianId === tech['03'])!;
    expect(after.amount - (before?.amount ?? 0)).toBe(19800);
    const gone = await api(ctx.app, ctx.owner, 'POST', on('S304', 'backfill'), { clientKey: randomUUID(), ...body });
    expect(gone.body.error.code).toBe('TAG_NOT_IN_STORE');
  });
});

describe('CY-01 同组点单汇总', () => {
  it('同组客人每位的菜（单价、份数、金额）与全组合计；退掉的不算；没有同组的只列自己', async () => {
    const dish = await api(ctx.app, ctx.owner, 'POST', '/api/items', { name: '合成橙汁', category: '饮品', price: 2800 });
    const dishId = dish.body.items.find((i: { name: string }) => i.name === '合成橙汁').id;
    const st = await api(ctx.app, ctx.owner, 'POST', '/api/admin/dining/stations', { name: '合成水吧' });
    const stationId = st.body.stations.find((s: { name: string }) => s.name === '合成水吧').id;
    expect((await api(ctx.app, ctx.owner, 'PUT', '/api/admin/dining/items', { items: [{ id: dishId, stationId }] })).status).toBe(200);
    expect((await api(ctx.app, ctx.owner, 'PUT', '/api/admin/dining/rules', { enabled: true })).status).toBe(200);
    const [a, b] = await enter(2);
    const order = (visitId: number, quantity: number) =>
      api(ctx.app, ctx.clerk, 'POST', '/api/dining/orders', { clientKey: randomUUID(), visitId, lines: [{ itemId: dishId, quantity }], expectedTotal: 2800 * quantity });
    expect((await order(a!.visitId, 2)).status).toBe(200);
    expect((await order(b!.visitId, 1)).status).toBe(200);
    const sum = (await api(ctx.app, ctx.clerk, 'GET', `/api/dining/group?visit=${a!.visitId}`)).body as DiningGroupSummary;
    expect(sum.groupId).not.toBeNull();
    expect(sum.members.map((m) => [m.tagCode, m.quantity, m.amount])).toEqual([
      [a!.tagCode, 2, 5600],
      [b!.tagCode, 1, 2800],
    ]);
    expect(sum.members[0]!.lines[0]).toMatchObject({ name: '合成橙汁', unitPrice: 2800, quantity: 2, amount: 5600 });
    expect([sum.quantity, sum.amount]).toEqual([3, 8400]);
    const [solo] = await enter();
    expect((await order(solo!.visitId, 1)).status).toBe(200);
    const one = (await api(ctx.app, ctx.clerk, 'GET', `/api/dining/group?visit=${solo!.visitId}`)).body as DiningGroupSummary;
    expect(one.groupId).toBeNull();
    expect(one.members).toHaveLength(1);
  });
});

// ───────────────────────── 批次 3 ─────────────────────────

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);
const upload = async (cookie: string) => {
  const r = await api(ctx.app, cookie, 'POST', '/api/oa/attachments', { clientKey: randomUUID(), fileName: '留宿确认单.jpg', mime: 'image/jpeg', data: JPEG.toString('base64') });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.id as number;
};

describe('FT-03 留宿确认单照片 + FT-04 待清房标留宿', () => {
  it('过夜客人：不传照片照样开房（待补传）；补传以后详情里看得到（已上传）；没选过夜的不收；退房以后待清的卡片标「留宿」，清洁完成就没了', async () => {
    const [g] = await enter();
    const r = await register('S302', { tagCode: g!.tagCode, technicianId: tech['01'], overnight: true });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    let guest = (await room('S302')).guests[0]!;
    expect(guest.overnight).toBe(true);
    expect(guest.overnightPhotos).toEqual([]);
    const att = await upload(ctx.clerk);
    const body = { registrationId: guest.registrationId, attachmentId: att };
    const ok = await api(ctx.app, ctx.clerk, 'POST', on('S302', 'overnight-photo'), body);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    // 重提同一张照样成功、不重复
    expect((await api(ctx.app, ctx.clerk, 'POST', on('S302', 'overnight-photo'), body)).status).toBe(200);
    guest = (await room('S302')).guests[0]!;
    expect(guest.overnightPhotos).toHaveLength(1);
    expect((await api(ctx.app, ctx.owner, 'GET', guest.overnightPhotos[0]!.url)).status).toBe(200);
    // 挂到别的房间的登记上拒绝
    expect((await api(ctx.app, ctx.clerk, 'POST', on('S303', 'overnight-photo'), { registrationId: guest.registrationId, attachmentId: await upload(ctx.clerk) })).status).toBe(404);
    const [audit] = await ctx.sql`SELECT 1 FROM audit_logs WHERE action = 'room_center_overnight_photo'`;
    expect(audit).toBeTruthy();
    await release('S302'); // 退房 → 待清 → release 里清洁完成；这里分开看
  });

  it('待清的房间：上次的客人过夜标「留宿」，没过夜的不标；清洁完成以后不再标', async () => {
    const [a] = await enter();
    expect((await register('S303', { tagCode: a!.tagCode, technicianId: tech['01'], overnight: true })).status).toBe(200);
    const [b] = await enter();
    expect((await register('S304', { tagCode: b!.tagCode, technicianId: tech['02'] })).status).toBe(200);
    // 不过夜的客人传留宿确认单拒绝
    const reg = (await room('S304')).guests[0]!.registrationId;
    expect((await api(ctx.app, ctx.clerk, 'POST', on('S304', 'overnight-photo'), { registrationId: reg, attachmentId: await upload(ctx.clerk) })).body.error.code).toBe('NOT_OVERNIGHT');
    for (const code of ['S303', 'S304']) {
      for (const s of (await room(code)).guests[0]!.sessions) expect((await finish(s.id)).status).toBe(200);
      const p = await preview(code);
      expect((await act(code, 'checkout', { seenUnpaid: p.unpaidTotal, inHouse: true })).status).toBe(200);
    }
    expect(await room('S303')).toMatchObject({ status: 'dirty', dirtyOvernight: true });
    expect(await room('S304')).toMatchObject({ status: 'dirty', dirtyOvernight: false });
    expect((await act('S303', 'cleaned')).status).toBe(200);
    expect(await room('S303')).toMatchObject({ status: 'free', dirtyOvernight: false });
    expect((await act('S304', 'cleaned')).status).toBe(200);
  });
});

describe('FT-13 康美部只看房态与手牌号', () => {
  it('康美部员工、康美部主管：卡片只有房态与手牌号，没有项目、技师、金额、客人姓名；历史、结账预览、查客人都拒绝；店主照常看全', async () => {
    const hire = async (username: string, position: string) => {
      const r = await api(ctx.app, ctx.owner, 'POST', '/api/staff', { username, displayName: username, position, password: PASSWORD });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      await ctx.sql`UPDATE staff SET must_change_password = false WHERE username = ${username}`;
      return login(ctx.app, username);
    };
    const staff = await hire('km_staff', 'kangmei.staff');
    const lead = await hire('km_lead', 'kangmei.lead');
    const [g] = await enter();
    expect((await register('S301', { tagCode: g!.tagCode, technicianId: tech['03'], note: '靠窗' })).status).toBe(200);
    for (const cookie of [staff, lead]) {
      const b = (await api(ctx.app, cookie, 'GET', '/api/room-center')).body as RoomCenterBoard;
      expect(b.statusOnly).toBe(true);
      const card = b.rooms.find((r) => r.code === 'S301')!;
      expect(card.status).toBe('in_use');
      expect(card.guests.map((x) => x.tagCode)).toEqual([g!.tagCode]);
      expect(card.guestText).toBe(`手牌 ${g!.tagCode}`);
      const text = JSON.stringify(card);
      for (const secret of ['足疗', '技师03', '19800', '靠窗', 'clerk']) expect(text, secret).not.toContain(secret);
      expect([card.amount, card.techText, card.orders]).toEqual([null, null, null]);
      expect(b.todayBookings).toEqual([]);
      expect((await api(ctx.app, cookie, 'GET', on('S301', 'history'))).status).toBe(403);
      expect((await api(ctx.app, cookie, 'GET', `/api/room-center/guest?tag=${g!.tagCode}`)).status).toBe(403);
    }
    expect((await api(ctx.app, lead, 'GET', on('S301', 'checkout-preview'))).status).toBe(403);
    const full = (await api(ctx.app, ctx.owner, 'GET', '/api/room-center')).body as RoomCenterBoard;
    expect(full.statusOnly).toBe(false);
    expect(JSON.stringify(full.rooms.find((r) => r.code === 'S301'))).toContain('足疗');
    await release('S301');
  });
});

// ───────────────────────── 批次 4 ─────────────────────────

describe('FT-14 同一工位同时做多个项目', () => {
  it('登记以后再加一个项目（另一位技师）：两张钟单同时在钟、各自计费；分别下钟；结账后业绩各算各的', async () => {
    const [g] = await enter();
    expect((await register('S303', { tagCode: g!.tagCode, technicianId: tech['01'] })).status).toBe(200);
    const before = await report();
    const add = await api(ctx.app, ctx.clerk, 'POST', on('S303', 'add-item'), {
      clientKey: randomUUID(),
      visitId: g!.visitId,
      itemId: foot,
      tier: 'standard',
      technicianId: tech['02'],
      callType: 'designated',
      expectedTotal: 19800,
    });
    expect(add.status, JSON.stringify(add.body)).toBe(200);
    const r = await room('S303');
    expect(r.guests).toHaveLength(1);
    const ss = r.guests[0]!.sessions;
    expect(ss.map((x) => [x.techNo, x.status])).toEqual([
      ['01', 'serving'],
      ['02', 'serving'],
    ]);
    expect((await bill(g!.visitId)).bill.amountCents).toBe(39600);
    expect((await history('S303')).rows.some((x) => x.kind === 'add_item')).toBe(true);
    // 不在这间房的客人不能加
    const [other] = await enter();
    expect(
      (
        await api(ctx.app, ctx.clerk, 'POST', on('S303', 'add-item'), {
          clientKey: randomUUID(),
          visitId: other!.visitId,
          itemId: foot,
          technicianId: tech['03'],
          callType: 'designated',
          expectedTotal: 19800,
        })
      ).body.error.code,
    ).toBe('GUEST_NOT_IN_ROOM');
    expect((await finish(ss[0]!.id)).status).toBe(200);
    expect((await room('S303')).guests[0]!.sessions.find((x) => x.techNo === '02')!.status).toBe('serving');
    await release('S303');
    await pay(g!.visitId);
    const after = await report();
    const diff = (no: string) => (after.rows.find((x) => x.technicianId === tech[no])?.amount ?? 0) - (before.rows.find((x) => x.technicianId === tech[no])?.amount ?? 0);
    expect([diff('01'), diff('02')]).toEqual([19800, 19800]);
  });
});

describe('FT-15 休息大厅分区 + FT-16 大厅开单 + FT-12 下钟即空', () => {
  it('后台建分区、把床位归进去；看板卡片带分区；重名拒绝；停用分区床位挪出来', async () => {
    const z1 = await api(ctx.app, ctx.owner, 'POST', '/api/admin/hall-zones', { name: 'A 区', sortOrder: 1 });
    expect(z1.status, JSON.stringify(z1.body)).toBe(200);
    expect((await api(ctx.app, ctx.owner, 'POST', '/api/admin/hall-zones', { name: 'a 区' })).status).toBe(409);
    expect((await api(ctx.app, ctx.clerk, 'POST', '/api/admin/hall-zones', { name: 'C 区' })).status).toBe(403);
    const z2 = await api(ctx.app, ctx.owner, 'POST', '/api/admin/hall-zones', { name: '第二排', sortOrder: 2 });
    const zones = z2.body.zones as { id: number; name: string }[];
    const [a, b] = [zones.find((z) => z.name === 'A 区')!.id, zones.find((z) => z.name === '第二排')!.id];
    expect((z2.body.beds as { code: string }[]).map((x) => x.code)).toEqual(['H201', 'H202', 'H203']);
    // 不是床位的不能分区
    expect((await api(ctx.app, ctx.owner, 'PUT', '/api/admin/hall-zones/beds', { beds: [{ spaceId: spaceId.S301, zoneId: a }] })).status).toBe(422);
    const saved = await api(ctx.app, ctx.owner, 'PUT', '/api/admin/hall-zones/beds', {
      beds: [
        { spaceId: spaceId.H201, zoneId: a },
        { spaceId: spaceId.H202, zoneId: a },
        { spaceId: spaceId.H203, zoneId: b },
      ],
    });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    const bd = await board();
    expect(bd.hallZones.map((z) => z.name)).toEqual(['A 区', '第二排']);
    expect(bd.rooms.find((r) => r.code === 'H203')!.hallZone).toEqual({ id: b, name: '第二排' });
    // 停用第二排：H203 挪出来
    expect((await api(ctx.app, ctx.owner, 'PUT', `/api/admin/hall-zones/${b}`, { name: '第二排', sortOrder: 2, active: false })).status).toBe(200);
    expect((await room('H203')).hallZone).toBeNull();
  });

  it('大厅床位能登记（选床位、项目、技师）；技师下钟床位马上空闲（不转待清）；这位客人再去别的床位登记，原来那张自动收尾', async () => {
    const [g] = await enter();
    const r = await register('H201', { tagCode: g!.tagCode, technicianId: tech['03'] });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const bed = await room('H201');
    expect(bed.status).toBe('in_use');
    for (const s of bed.guests[0]!.sessions) expect((await finish(s.id)).status).toBe(200);
    expect(await room('H201')).toMatchObject({ status: 'free', guests: [] });
    // 这位客人还能马上登记别的床位（原来那张登记单自动按退房收尾）
    const look = await api(ctx.app, ctx.clerk, 'GET', `/api/room-center/guest?tag=${g!.tagCode}`);
    expect(look.body.registeredIn).toBeNull();
    expect((await register('H202', { tagCode: g!.tagCode, technicianId: tech['04'] })).status).toBe(200);
    const [old] = await ctx.sql<{ status: string; closeKind: string }[]>`
      SELECT status, close_kind FROM room_registrations WHERE visit_id = ${g!.visitId} AND space_id = ${spaceId.H201!}`;
    expect(old).toEqual({ status: 'closed', closeKind: 'checkout' });
    for (const s of (await room('H202')).guests[0]!.sessions) expect((await finish(s.id)).status).toBe(200);
    expect((await room('H202')).status).toBe('free');
    // 技师房间照旧：下钟以后不退房还是在用，退了才待清
    const [k] = await enter();
    expect((await register('S304', { tagCode: k!.tagCode, technicianId: tech['01'] })).status).toBe(200);
    for (const s of (await room('S304')).guests[0]!.sessions) expect((await finish(s.id)).status).toBe(200);
    expect((await room('S304')).status).toBe('in_use');
    await release('S304');
  });
});

describe('FT-17 零售与杂项', () => {
  it('后台设的分类里的项目能挂到房里客人的手牌上；别的分类、要技师的拒绝；手动金额要权限；房间历史有记录', async () => {
    const mk = async (name: string, category: string, price: number) =>
      ((await api(ctx.app, ctx.owner, 'POST', '/api/items', { name, category, price })).body.items as { id: number; name: string }[]).find((i) => i.name === name)!.id;
    const cig = await mk('合成香烟', '零售', 3500);
    const clean = await mk('合成清洁费', '杂项', 5000);
    const tea = await mk('合成茶位', '茶位', 1000);
    const [g] = await enter();
    expect((await register('S301', { tagCode: g!.tagCode, technicianId: tech['02'] })).status).toBe(200);
    const goods = (body: Record<string, unknown>, cookie = ctx.clerk) => api(ctx.app, cookie, 'POST', on('S301', 'goods'), { clientKey: randomUUID(), visitId: g!.visitId, ...body });
    const ok = await goods({
      lines: [
        { itemId: cig, quantity: 2 },
        { itemId: clean, quantity: 1 },
      ],
      expectedTotal: 12000,
    });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect((await bill(g!.visitId)).bill.amountCents).toBe(19800 + 12000);
    expect((await goods({ lines: [{ itemId: tea, quantity: 1 }], expectedTotal: 1000 })).body.error.code).toBe('GOODS_NOT_ALLOWED');
    expect((await goods({ lines: [{ itemId: foot, quantity: 1 }], expectedTotal: 19800 })).body.error.code).toBe('GOODS_NOT_ALLOWED');
    // 手动金额：前台有权限
    expect((await goods({ customLines: [{ name: '损坏赔偿', amount: 2000 }], expectedTotal: 2000 })).status).toBe(200);
    expect((await history('S301')).rows.filter((x) => x.kind === 'goods')).toHaveLength(2);
    // 后台改了分类：茶位也能挂
    await rules({ goodsCategories: ['零售', '杂项', '茶位'] });
    expect((await goods({ lines: [{ itemId: tea, quantity: 1 }], expectedTotal: 1000 })).status).toBe(200);
    await rules({ goodsCategories: ['零售', '杂项'] });
    await release('S301');
  });
});

describe('FT-18 虫洞位', () => {
  it('下单三步（手牌、性别、虫洞号）收后台设的费用；同一个虫洞、同一位客人同时一张；离开以后空闲；清洁时段里没人的是待清、不能下单', async () => {
    const fee = ((await api(ctx.app, ctx.owner, 'POST', '/api/items', { name: '合成虫洞费', category: '虫洞', price: 3800 })).body.items as { id: number; name: string }[]).find(
      (i) => i.name === '合成虫洞费',
    )!.id;
    const cur = (await api(ctx.app, ctx.owner, 'GET', '/api/admin/room-center-rules')).body as RoomCenterRules;
    await rules({ wormhole: { ...cur.wormhole, feeItemId: fee, cleanWindows: [] } });
    const bd = await board();
    expect(bd.wormholeFee).toMatchObject({ itemId: fee, price: 3800 });
    expect(bd.rooms.find((r) => r.code === 'W201')).toMatchObject({ status: 'free', wormhole: { stay: null } });
    const [g, h] = await enter(2);
    const open = (code: string, body: Record<string, unknown>) => api(ctx.app, ctx.clerk, 'POST', on(code, 'wormhole'), { clientKey: randomUUID(), gender: 'female', expectedFee: 3800, ...body });
    expect((await open('S302', { tagCode: g!.tagCode })).body.error.code).toBe('NOT_WORMHOLE');
    expect((await open('W201', { tagCode: g!.tagCode, expectedFee: 1000 })).status).toBe(409);
    const ok = await open('W201', { tagCode: g!.tagCode });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    const w = await room('W201');
    expect(w).toMatchObject({ status: 'in_use', guestText: `手牌 ${g!.tagCode}`, wormhole: { stay: { tagCode: g!.tagCode, gender: 'female', fee: 3800 } } });
    expect((await bill(g!.visitId)).bill.amountCents).toBe(3800);
    expect((await open('W201', { tagCode: h!.tagCode })).body.error.code).toBe('ROOM_IN_USE');
    expect((await open('W202', { tagCode: g!.tagCode })).body.error.code).toBe('GUEST_REGISTERED');
    const leave = await api(ctx.app, ctx.clerk, 'POST', on('W201', 'wormhole-leave'), { clientKey: randomUUID(), expectedVersion: w.version });
    expect(leave.status, JSON.stringify(leave.body)).toBe(200);
    expect((await room('W201')).status).toBe('free');
    expect((await history('W201')).rows.map((x) => x.kind).slice(0, 2)).toEqual(['wormhole_out', 'wormhole_in']);
    // 清洁时段（覆盖现在）：没人的虫洞是待清，不能下单；有人的照样在用
    expect((await open('W202', { tagCode: h!.tagCode })).status).toBe(200);
    const now = new Date();
    const hm = (d: Date) => new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d);
    await rules({ wormhole: { ...cur.wormhole, feeItemId: fee, cleanWindows: [{ start: hm(new Date(now.getTime() - 30 * 60_000)), end: hm(new Date(now.getTime() + 30 * 60_000)) }] } });
    expect((await room('W201')).status).toBe('dirty');
    expect((await room('W202')).status).toBe('in_use');
    expect((await open('W201', { tagCode: g!.tagCode })).body.error.code).toBe('ROOM_DIRTY');
    // 时段外：空闲
    await rules({ wormhole: { ...cur.wormhole, feeItemId: fee, cleanWindows: [{ start: hm(new Date(now.getTime() + 60 * 60_000)), end: hm(new Date(now.getTime() + 90 * 60_000)) }] } });
    expect((await room('W201')).status).toBe('free');
    // 客人结账离店：虫洞自动空出来
    await pay(h!.visitId);
    expect((await room('W202')).status).toBe('free');
    await rules({ wormhole: { ...cur.wormhole, feeItemId: null, cleanWindows: [] } });
  });
});
