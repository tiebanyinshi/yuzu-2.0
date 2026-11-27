// 8.2.3 前台（发卡台与全店，docs/V8223_FRONTDESK.md）：
//   · 客人类别：发牌时选（默认「普通」、不在清单里的拒绝），手牌板与客人卡带出，发牌后能改（留经办记录）；发牌时写的预约技师记成单人备注；
//   · 偏好：会员的跟着会员走（撤销这次来访、下次来照样带出），散客的只这一次；全店刷手牌的地方（点单、钟房、房态）读得到；
//   · 客诉台账：带客诉类标签的备注按营业日、状态列出，标「已处理」只能一次；只有值班经理及以上能看；
//   · 高风险：挂账超过阈值的进提醒列表，按设定推给值班经理及以上（每位每样一次），「只在页面上提示」的不推；
//   · 技师预约单独一项权限：收银员（前台）没有，值班经理有；
//   · 消费记录带结账单编号（点单号打开明细）；
//   · 同行快捷移出：从组里任何一张牌把别的同行移出；
//   · 补单：有「补单」权限的人按实际时间、出单员补挂账，餐饮的菜不打厨房单（直接已上），明细标「补单 · 出单员」；接待、结账不能补单。

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FrontdeskBoard, VisitDetail } from '../src/shared/frontdesk';
import { backfillText } from '../src/shared/backfill';
import { crowdAdvice, DEFAULT_GUEST_RULES, highRiskOf, type ComplaintLedger, type GuestNotes, type RiskAlertRow } from '../src/shared/frontdesk-v8223';
import { can } from '../src/shared/permissions';
import { sweepRiskAlerts } from '../src/server/modules/frontdesk/index';
import { createStaff } from '../src/server/modules/staff';
import { todayIn } from '../src/server/lib/dates';
import { checkin } from '../src/server/modules/frontdesk/visits';
import { api, createMember, login, PASSWORD, rechargeBody, setup, type TestContext } from './helpers';

let ctx: TestContext;
let duty = '';
let dutyId = 0;
let tagNo = 0;
let dishId = 0;

const nextTag = () => {
  tagNo += 1;
  return `G${String(tagNo).padStart(3, '0')}`;
};
const enter = async (guests: Record<string, unknown>[], cookie = ctx.clerk, key = randomUUID()) => {
  const r = await api(ctx.app, cookie, 'POST', '/api/frontdesk/checkins', { clientKey: key, guests: guests.map((g) => ({ tagCode: nextTag(), zone: 'male', ...g })) });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.visits as { id: number; tagCode: string }[];
};
const visitOf = async (id: number) => (await api<VisitDetail>(ctx.app, ctx.clerk, 'GET', `/api/frontdesk/visits/${id}`)).body;
const boardVisit = async (code: string) => (await api<FrontdeskBoard>(ctx.app, ctx.clerk, 'GET', '/api/frontdesk/board')).body.tags.find((t) => t.code === code)!.visit!;

beforeAll(async () => {
  ctx = await setup({ keepDefaultSwitches: true });
  expect((await api(ctx.app, ctx.owner, 'POST', '/api/frontdesk/tags/batch', { prefix: 'G', from: 1, to: 60, width: 3, zone: 'male' })).status).toBe(200);
  dutyId = await createStaff(ctx.sql, { username: 'gduty', displayName: '值班乙', role: 'duty_manager', password: PASSWORD, mustChangePassword: false });
  duty = await login(ctx.app, 'gduty');
  const ri = await api(ctx.app, ctx.owner, 'POST', '/api/items', { name: '补单炒饭', category: '热菜', price: 3800 });
  expect(ri.status, JSON.stringify(ri.body)).toBe(200);
  dishId = ri.body.items.find((i: { name: string }) => i.name === '补单炒饭').id;
  const st = await api(ctx.app, ctx.owner, 'POST', '/api/admin/dining/stations', { name: '厨房' });
  expect(st.status, JSON.stringify(st.body)).toBe(200);
  const stationId = st.body.stations.find((s: { name: string }) => s.name === '厨房').id as number;
  expect((await api(ctx.app, ctx.owner, 'PUT', '/api/admin/dining/items', { items: [{ id: dishId, stationId }] })).status).toBe(200);
});
afterAll(async () => {
  await ctx?.close();
});

describe('客人类别（第 1 条）', () => {
  it('发牌时选类别，手牌板与客人卡带出；不选是「普通」；不在清单里的拒绝', async () => {
    expect(DEFAULT_GUEST_RULES.categories).toEqual(['普通', '港客', '外宾', '儿童']);
    const [hk, plain] = await enter([{ category: '港客' }, {}]);
    expect((await boardVisit(hk!.tagCode)).guestCategory).toBe('港客');
    expect((await boardVisit(plain!.tagCode)).guestCategory).toBe('普通');
    expect((await visitOf(hk!.id)).guest).toMatchObject({ category: '港客', owner: 'visit' });
    const bad = await api(ctx.app, ctx.clerk, 'POST', '/api/frontdesk/checkins', { clientKey: randomUUID(), guests: [{ tagCode: nextTag(), zone: 'male', category: '火星人' }] });
    expect(bad.status).toBe(422);
    expect(bad.body.error.code).toBe('GUEST_CATEGORY');
  });

  it('发牌后能改类别（经办记录、审计留痕）；后台加的类别能用', async () => {
    const [v] = await enter([{}]);
    const r = await api<VisitDetail>(ctx.app, ctx.clerk, 'POST', `/api/frontdesk/visits/${v!.id}/category`, { category: '外宾' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.guest.category).toBe('外宾');
    expect(r.body.history.find((h) => h.kind === 'guest')!.text).toBe('客人类别 普通 → 外宾');
    const [audit] = await ctx.sql<{ detail: { from: string; to: string } }[]>`SELECT detail FROM audit_logs WHERE action = 'visit_category' AND target_id = ${String(v!.id)}`;
    expect(audit!.detail).toMatchObject({ from: '普通', to: '外宾' });
    // 店员不能改后台规则；店主加一个「VIP 团客」
    expect((await api(ctx.app, ctx.clerk, 'PUT', '/api/frontdesk/guest-rules', { categories: ['普通', 'VIP 团客'] })).status).toBe(403);
    const saved = await api(ctx.app, ctx.owner, 'PUT', '/api/frontdesk/guest-rules', { categories: ['普通', '港客', '外宾', '儿童', 'VIP团客'] });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(saved.body.prefFields).toEqual(DEFAULT_GUEST_RULES.prefFields);
    expect((await api(ctx.app, ctx.clerk, 'POST', `/api/frontdesk/visits/${v!.id}/category`, { category: 'VIP团客' })).status).toBe(200);
    expect((await api(ctx.app, ctx.owner, 'PUT', '/api/frontdesk/guest-rules', { categories: ['普通', '普通'] })).status).toBe(400);
  });

  it('发牌时写的预约技师记成单人备注；同一个编号重提不多记一条', async () => {
    const key = randomUUID();
    const code = nextTag();
    const body = { clientKey: key, guests: [{ tagCode: code, zone: 'male', bookedTechnician: '12 号小林' }] };
    const first = await api(ctx.app, ctx.clerk, 'POST', '/api/frontdesk/checkins', body);
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    const again = await api(ctx.app, ctx.clerk, 'POST', '/api/frontdesk/checkins', body);
    expect(again.body.replayed).toBe(true);
    const v = await visitOf(first.body.visits[0].id);
    expect(v.remarks.map((r) => [r.tag, r.note])).toEqual([['预约技师', '预约技师：12 号小林']]);
  });
});

describe('偏好备注全店可见（第 2 条）', () => {
  it('会员的偏好跟着会员走：这次撤销，下次来自动带出；散客的只这一次', async () => {
    const m = await createMember(ctx, '偏好会员', '19900823001');
    const [v] = await enter([{ memberId: m.id }]);
    const r = await api<VisitDetail>(ctx.app, ctx.clerk, 'PUT', `/api/frontdesk/visits/${v!.id}/preferences`, { values: { diet: '不吃香菜', massage: '力度重' } });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.guest.owner).toBe('member');
    expect(r.body.guest.prefs.filter((p) => p.value).map((p) => [p.label, p.value])).toEqual([
      ['忌口', '不吃香菜'],
      ['按摩力度', '力度重'],
    ]);
    // 不认识的字段拒绝；填空 = 清掉
    expect((await api(ctx.app, ctx.clerk, 'PUT', `/api/frontdesk/visits/${v!.id}/preferences`, { values: { nope: 'x' } })).status).toBe(422);
    expect((await api(ctx.app, ctx.clerk, 'PUT', `/api/frontdesk/visits/${v!.id}/preferences`, { values: { massage: '' } })).status).toBe(200);
    expect((await api(ctx.app, ctx.owner, 'POST', `/api/frontdesk/visits/${v!.id}/cancel`, { reason: '开错手牌' })).status).toBe(200);
    const [next] = await enter([{ memberId: m.id }]);
    expect((await visitOf(next!.id)).guest.prefs.filter((p) => p.value).map((p) => p.value)).toEqual(['不吃香菜']);
    // 散客
    const [walk] = await enter([{}]);
    expect((await api(ctx.app, ctx.clerk, 'PUT', `/api/frontdesk/visits/${walk!.id}/preferences`, { values: { other: '怕冷' } })).status).toBe(200);
    const [walk2] = await enter([{}]);
    expect((await visitOf(walk2!.id)).guest.prefs.every((p) => !p.value)).toBe(true);
    // 全店刷手牌的地方：类别、偏好、备注一起读到
    await api(ctx.app, ctx.clerk, 'POST', `/api/frontdesk/visits/${next!.id}/remarks`, { clientKey: randomUUID(), scope: 'single', tag: '特殊关照', note: '腿脚不便' });
    const notes = await api<GuestNotes[]>(ctx.app, ctx.clerk, 'GET', `/api/frontdesk/guest-notes?visitIds=${next!.id},${walk!.id}`);
    expect(notes.status, JSON.stringify(notes.body)).toBe(200);
    expect(notes.body.find((n) => n.visitId === next!.id)).toMatchObject({
      category: '普通',
      categoryMark: null,
      prefs: [{ label: '忌口', value: '不吃香菜' }],
      remarks: [{ tag: '特殊关照', note: '腿脚不便' }],
    });
    expect(notes.body.find((n) => n.visitId === walk!.id)!.prefs).toEqual([{ label: '其他', value: '怕冷' }]);
  });
});

describe('客诉台账（第 3 条）', () => {
  it('按营业日、状态列出，标已处理只能一次；店员看不到台账', async () => {
    const [v] = await enter([{}]);
    const r = await api<VisitDetail>(ctx.app, ctx.clerk, 'POST', `/api/frontdesk/visits/${v!.id}/remarks`, { clientKey: randomUUID(), scope: 'single', tag: '客诉', note: '水温太低' });
    const remarkId = r.body.remarks[0]!.id;
    await api(ctx.app, ctx.clerk, 'POST', `/api/frontdesk/visits/${v!.id}/remarks`, { clientKey: randomUUID(), scope: 'single', note: '普通备注不进台账' });
    const today = (await api(ctx.app, ctx.owner, 'GET', '/api/auth/me')).body.today as string;
    const url = (status: string) => `/api/frontdesk/complaints?from=${today}&to=${today}&status=${status}`;
    expect((await api(ctx.app, ctx.clerk, 'GET', url('all'))).status).toBe(403);
    const open = (await api<ComplaintLedger>(ctx.app, duty, 'GET', url('open'))).body;
    expect(open.rows.find((x) => x.remarkId === remarkId)).toMatchObject({ tag: '客诉', note: '水温太低', tagCode: v!.tagCode, resolved: null });
    expect(open.rows.some((x) => x.note === '普通备注不进台账')).toBe(false);
    const done = await api(ctx.app, duty, 'POST', `/api/frontdesk/complaints/${remarkId}/resolve`, { note: '已调高水温并致歉' });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect((await api(ctx.app, duty, 'POST', `/api/frontdesk/complaints/${remarkId}/resolve`, { note: '再标一次' })).status).toBe(409);
    expect((await api<ComplaintLedger>(ctx.app, duty, 'GET', url('open'))).body.rows.some((x) => x.remarkId === remarkId)).toBe(false);
    expect((await api<ComplaintLedger>(ctx.app, duty, 'GET', url('resolved'))).body.rows.find((x) => x.remarkId === remarkId)!.resolved).toMatchObject({ note: '已调高水温并致歉', byName: '值班乙' });
    await expect(ctx.sql`DELETE FROM visit_remark_resolutions`).rejects.toThrow();
  });
});

describe('区域拥挤提示（第 4 条）', () => {
  const tag = (code: string, at: string | null) => ({
    code,
    zone: 'male' as const,
    kind: 'normal' as const,
    active: true,
    locked: false,
    serviceStatus: 'normal',
    visit: at ? { checkedInAt: at } : null,
  });
  it('连续往同一区发了 N 张提示换区，并建议人少的区；阈值都是 0 时不提示', () => {
    const tags = [
      tag('A001', '2026-11-27T10:00:00Z'),
      tag('A002', '2026-11-27T10:01:00Z'),
      tag('A003', '2026-11-27T10:02:00Z'),
      tag('A004', null),
      tag('B001', '2026-11-27T09:00:00Z'),
      tag('B002', null),
    ];
    const advice = crowdAdvice(tags, 'A004', { crowd: { streak: 3, areaMax: 0 } });
    expect(advice).toMatchObject({ area: 'A', streak: 3, inArea: 3, suggest: 'B' });
    expect(advice!.text).toContain('已连续往A 区发了 3 张');
    expect(crowdAdvice(tags, 'A004', { crowd: { streak: 4, areaMax: 0 } })).toBeNull();
    expect(crowdAdvice(tags, 'A004', { crowd: { streak: 0, areaMax: 3 } })!.text).toContain('A 区在店 3 人');
    expect(crowdAdvice(tags, 'A004', { crowd: { streak: 0, areaMax: 0 } })).toBeNull();
    // 发到别的区：连续数从 0 开始
    expect(crowdAdvice(tags, 'B002', { crowd: { streak: 1, areaMax: 0 } })).toBeNull();
  });
});

describe('高风险提示（第 5 条）', () => {
  it('挂账超过阈值进提醒列表；设成推给值班经理时每位每样推一次，「只在页面上提示」不推', async () => {
    expect(highRiskOf(24 * 60, 0, DEFAULT_GUEST_RULES)!.text).toBe('高风险 · 超 24 小时');
    expect(highRiskOf(60, 199_999, DEFAULT_GUEST_RULES)).toBeNull();
    expect(highRiskOf(60, 200_000, DEFAULT_GUEST_RULES)!.reasons).toEqual(['amount']);
    expect((await api(ctx.app, ctx.owner, 'PUT', '/api/frontdesk/guest-rules', { risk: { stayHours: 24, amountCents: 1000, notify: 'page' } })).status).toBe(200);
    const [v] = await enter([{}]);
    const post = await api(ctx.app, ctx.clerk, 'POST', `/api/frontdesk/visits/${v!.id}/charges`, { clientKey: randomUUID(), customLines: [{ name: '茶水', amount: 1500 }], expectedTotal: 1500 });
    expect(post.status, JSON.stringify(post.body)).toBe(200);
    const alerts = (await api<RiskAlertRow[]>(ctx.app, ctx.clerk, 'GET', '/api/frontdesk/risk-alerts')).body;
    expect(alerts.find((a) => a.visitId === v!.id)).toMatchObject({ amountCents: 1500, risk: { reasons: ['amount'] }, notified: [] });
    const deps = { sql: ctx.sql, config: ctx.config };
    expect(await sweepRiskAlerts(deps)).toBe(0);
    expect((await api(ctx.app, ctx.owner, 'PUT', '/api/frontdesk/guest-rules', { risk: { stayHours: 24, amountCents: 1000, notify: 'duty_manager' } })).status).toBe(200);
    const sent = await sweepRiskAlerts(deps);
    expect(sent).toBeGreaterThanOrEqual(1);
    expect(await sweepRiskAlerts(deps)).toBe(0);
    const notes = await ctx.sql<{ staffId: number; title: string }[]>`SELECT staff_id, title FROM oa_notifications WHERE ref_type = 'visit_risk_alert' AND title LIKE ${`%${v!.tagCode}`}`;
    expect(notes.map((n) => Number(n.staffId))).toContain(dutyId);
    expect(notes.map((n) => Number(n.staffId))).not.toContain(ctx.clerkId);
    expect((await api<RiskAlertRow[]>(ctx.app, ctx.clerk, 'GET', '/api/frontdesk/risk-alerts')).body.find((a) => a.visitId === v!.id)!.notified).toEqual(['amount']);
    await api(ctx.app, ctx.owner, 'PUT', '/api/frontdesk/guest-rules', { risk: { stayHours: 24, amountCents: 200_000, notify: 'page' } });
  });
});

describe('预约按种类分权限（第 6 条）', () => {
  it('收银员（前台）没有技师预约，值班经理有；收银员建技师预约被拒，派对房、客房照旧', async () => {
    expect(can({ role: 'clerk' }, 'booking.technician')).toBe(false);
    expect(can({ role: 'clerk' }, 'booking.manage')).toBe(true);
    expect(can({ role: 'duty_manager' }, 'booking.technician')).toBe(true);
    const body = { clientKey: randomUUID(), kind: 'technician', itemId: 1, startsAt: new Date(Date.now() + 3_600_000).toISOString() };
    const r = await api(ctx.app, ctx.clerk, 'POST', '/api/bookings', body);
    expect(r.status).toBe(403);
    expect(JSON.stringify(r.body)).toContain('技师预约');
    expect((await api(ctx.app, ctx.clerk, 'GET', '/api/bookings/slots?kind=technician&date=2026-11-27&itemId=1')).status).toBe(403);
    expect((await api(ctx.app, ctx.clerk, 'GET', `/api/bookings?date=${todayIn(ctx.config.timezone)}`)).status).toBe(200);
    const me = (await api(ctx.app, ctx.clerk, 'GET', '/api/auth/me')).body as { permissions: string[] };
    expect(me.permissions).toContain('booking.manage');
    expect(me.permissions).not.toContain('booking.technician');
  });
});

describe('消费记录跳转明细（第 7 条）', () => {
  it('会员储值结账的消费行带结账单编号，按它取得到结账单明细', async () => {
    const m = await createMember(ctx, '跳转会员', '19900823002');
    expect((await api(ctx.app, ctx.clerk, 'POST', '/api/recharges', rechargeBody(m.id, 100000, 0))).status).toBe(200);
    const [v] = await enter([{ memberId: m.id }]);
    const pv = await api(ctx.app, ctx.clerk, 'GET', `/api/frontdesk/checkout-preview?ids=${v!.id}`);
    const total = pv.body.totalAmount as number;
    const split = pv.body.members[0].split ?? { principal: total, bonus: 0 };
    const pay = await api(ctx.app, ctx.clerk, 'POST', '/api/frontdesk/checkouts', {
      clientKey: randomUUID(),
      visitIds: [v!.id],
      expectedTotal: total,
      payments: [{ method: 'wallet', memberId: m.id, amount: total, expectedSplit: { principal: split.principal ?? total, bonus: split.bonus ?? 0 } }],
    });
    expect(pay.status, JSON.stringify(pay.body)).toBe(200);
    const rows = (await api(ctx.app, ctx.clerk, 'GET', `/api/members/${m.id}/activity`)).body as { entryType: string; checkoutNo: string | null; checkoutId: number | null }[];
    const consume = rows.find((r) => r.entryType === 'consume')!;
    expect(consume).toMatchObject({ checkoutNo: pay.body.checkoutNo, checkoutId: pay.body.id });
    const detail = await api(ctx.app, ctx.clerk, 'GET', `/api/ledger/orders/checkouts/${consume.checkoutId}`);
    expect(detail.status, JSON.stringify(detail.body)).toBe(200);
  });
});

describe('同行快捷移出（第 8 条）', () => {
  it('从组里一张牌把另一位同行移出，那位不再在组里', async () => {
    const [a, b, c] = await enter([{}, {}, {}]);
    expect((await visitOf(a!.id)).group!.mates).toHaveLength(3);
    const r = await api<VisitDetail>(ctx.app, ctx.clerk, 'POST', `/api/frontdesk/visits/${b!.id}/group`, { action: 'leave' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.group).toBeNull();
    expect((await visitOf(a!.id)).group!.mates.map((m) => m.visitId).sort()).toEqual([a!.id, c!.id].sort());
  });
});

describe('全店补单（第 9 条）', () => {
  const at = () => new Date(Date.now() - 30 * 60_000).toISOString();
  it('有「补单」权限的人按实际时间、出单员补菜品：不打厨房单、明细标「补单 · 出单员」；店员没有权限', async () => {
    // 两小时前进店的客人，补半小时前的一道菜
    const r0 = await checkin(
      { sql: ctx.sql, config: ctx.config },
      { clientKey: randomUUID(), guests: [{ tagCode: nextTag(), zone: 'male' }] },
      { actor: { id: ctx.clerkId, username: 'clerk', displayName: '测试店员', role: 'clerk', duties: [], mustChangePassword: false }, at: new Date(Date.now() - 2 * 3_600_000) },
    );
    const v = r0.visits[0];
    const issuers = (await api(ctx.app, duty, 'GET', '/api/frontdesk/supplement/issuers')).body as { id: number; name: string }[];
    expect(issuers.find((i) => i.id === ctx.clerkId)!.name).toBe('测试店员');
    expect((await api(ctx.app, ctx.clerk, 'GET', '/api/frontdesk/supplement/issuers')).status).toBe(403);
    const body = (issuerId: number) => ({
      clientKey: randomUUID(),
      lines: [{ itemId: dishId, quantity: 1 }],
      expectedTotal: 3800,
      backfill: { slipNo: 'BD-1127-1000', at: at(), issuerId },
    });
    expect((await api(ctx.app, ctx.clerk, 'POST', `/api/frontdesk/visits/${v!.id}/charges`, body(ctx.clerkId))).status).toBe(403);
    const r = await api<VisitDetail>(ctx.app, duty, 'POST', `/api/frontdesk/visits/${v!.id}/charges`, body(ctx.clerkId));
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const line = r.body.lines.find((l) => l.itemId === dishId)!;
    expect(line.source).toBe('dining');
    expect(line.kitchen?.status).toBe('served');
    expect(line.backfill?.issuerName).toBe('测试店员');
    expect(backfillText(line.backfill!)).toBe('补单 · 出单员 测试店员，值班乙录入');
    const [sup] = await ctx.sql<{ issuerId: number; createdBy: number }[]>`SELECT issuer_id, created_by FROM bill_supplements WHERE op_key = ${line.postKey}`;
    expect(sup).toMatchObject({ issuerId: ctx.clerkId, createdBy: dutyId });
    // 出单员不在职拒绝
    expect((await api(ctx.app, duty, 'POST', `/api/frontdesk/visits/${v!.id}/charges`, body(999_999))).status).toBe(422);
    // 作废照常写原因
    expect((await api(ctx.app, duty, 'POST', `/api/frontdesk/lines/${line.id}/void`, { reason: '补错了' })).status).toBeLessThan(300);
  });

  it('接待、结账不能带补单（只认补录纸质单）', async () => {
    const r = await api(ctx.app, duty, 'POST', '/api/frontdesk/checkins', {
      clientKey: randomUUID(),
      guests: [{ tagCode: nextTag(), zone: 'male' }],
      backfill: { slipNo: 'BD-1', at: at(), issuerId: ctx.clerkId },
    });
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('SUPPLEMENT_ONLY_CHARGES');
  });
});
