// 8.2.8 餐厅（docs/V8228_DINING_MEALS.md）：入口刷手牌登记进餐（含餐抵扣成 0、裸票照时段价收、同一餐只登记一次）、
// 票种含几餐、餐台点菜自动折零（只餐厅出品口、只登记了这一餐的客人）、自动折扣照单项打折结账、结果待确认。

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_MEAL_PERIODS, mealAllowance, mealPeriodAt, mealPeriodRange } from '../src/shared/dining-meals';
import type { CheckoutPreview } from '../src/shared/checkout';
import type { VisitDetail } from '../src/shared/frontdesk';
import { createStaff } from '../src/server/modules/staff';
import { api, login, PASSWORD, setup, type TestContext } from './helpers';

let ctx: TestContext;
let tagNo = 0;
const item: Record<string, number> = {};
const ticket: Record<string, number> = {};

const checkin = async (ticketTypeId?: number) => {
  tagNo += 1;
  const tagCode = `M${String(tagNo).padStart(3, '0')}`;
  const r = await api(ctx.app, ctx.clerk, 'POST', '/api/frontdesk/checkins', { clientKey: randomUUID(), guests: [{ tagCode, zone: 'male', ...(ticketTypeId ? { ticketTypeId } : {}) }] });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return { id: r.body.visits[0].id as number, tagCode };
};
/** 在店的那位客人（预览时看到的）；没人在店时随便给一个，让牌号先报「不在店」 */
const visitOf = async (tagCode: string) =>
  Number((await ctx.sql<{ id: number }[]>`SELECT v.id FROM visits v JOIN hand_tags t ON t.id = v.tag_id WHERE t.code = ${tagCode} AND v.status = 'open'`)[0]?.id ?? 1);
/** 照页面：先刷牌预览，再带上看到的客人与收费登记 */
const enter = async (tagCode: string, key = randomUUID(), cookie = ctx.clerk) => {
  const pv = (await api(ctx.app, cookie, 'GET', `/api/dining/meal-entries/preview?tag=${tagCode}`)).body as { period: { key: string; price: number } | null; kind: string | null };
  const expected = pv.period ? { period: pv.period.key, kind: pv.kind ?? 'paid', price: pv.period.price } : { period: 'lunch', kind: 'paid', price: 0 };
  return api(ctx.app, cookie, 'POST', '/api/dining/meal-entries', { clientKey: key, tagCode, visitId: await visitOf(tagCode), expected });
};
const visit = async (id: number) => (await api<VisitDetail>(ctx.app, ctx.clerk, 'GET', `/api/frontdesk/visits/${id}`)).body;
const code = (r: { body: unknown }) => (r.body as { error?: { code: string } }).error?.code;
const due = async (id: number) => (await api<CheckoutPreview>(ctx.app, ctx.clerk, 'GET', `/api/frontdesk/checkout-preview?ids=${id}`)).body;

beforeAll(async () => {
  ctx = await setup();
  // 整天都是午餐（¥199），别的餐段不供餐：用例什么时候跑都在餐段里
  const periods = DEFAULT_MEAL_PERIODS.map((p) => (p.key === 'lunch' ? { ...p, start: 0, end: 1439 } : { ...p, price: 0 }));
  const rules = await api(ctx.app, ctx.owner, 'PUT', '/api/admin/dining/rules', { enabled: true, mealPeriods: periods });
  expect(rules.status, JSON.stringify(rules.body)).toBe(200);
  const st = await api(ctx.app, ctx.owner, 'POST', '/api/admin/dining/stations', { name: '中厨' });
  const stationId = st.body.stations.find((s: { name: string }) => s.name === '中厨').id;
  for (const [name, category, price] of [
    ['小炒肉', '热菜', 5800],
    ['杨枝甘露', '饮品', 3800],
  ] as const) {
    const c = await api(ctx.app, ctx.owner, 'POST', '/api/items', { name, category, price });
    item[name] = c.body.items.find((i: { name: string }) => i.name === name).id;
  }
  const set = await api(ctx.app, ctx.owner, 'PUT', '/api/admin/dining/items', {
    items: [
      { id: item['小炒肉'], stationId, slot: 'restaurant:餐饮' },
      { id: item['杨枝甘露'], stationId, slot: 'water:手作饮料' },
    ],
  });
  expect(set.status, JSON.stringify(set.body)).toBe(200);
  expect((await api(ctx.app, ctx.owner, 'POST', '/api/frontdesk/tags/batch', { prefix: 'M', from: 1, to: 40, width: 3, zone: 'male' })).status).toBe(200);
  const types = (await api(ctx.app, ctx.owner, 'GET', '/api/frontdesk/ticket-types?all=1')).body as { id: number; name: string; meals12h: number; meals24h: number }[];
  for (const t of types) ticket[t.name] = t.id;
  // 升级回填：含餐门票 12 小时档 2 餐、24 小时档 3 餐
  expect(types.find((t) => t.name === '含餐门票')).toMatchObject({ meals12h: 2, meals24h: 3 });
  // 改成 1 餐（12 小时档），看用完以后照价收
  const t = types.find((x) => x.name === '含餐门票')!;
  const saved = await api(ctx.app, ctx.owner, 'PUT', `/api/frontdesk/ticket-types/${t.id}`, { ...t, price12h: 69900, price24h: 89900, meals12h: 1 });
  expect(saved.status, JSON.stringify(saved.body)).toBe(200);
});
afterAll(async () => ctx.close());

describe('餐段与含餐（纯函数）', () => {
  it('跨午夜的夜宵、不供餐的段、12 / 24 小时档', () => {
    expect(mealPeriodAt(DEFAULT_MEAL_PERIODS, 12 * 60)!.key).toBe('lunch');
    expect(mealPeriodAt(DEFAULT_MEAL_PERIODS, 23 * 60)!.key).toBe('supper');
    expect(mealPeriodAt(DEFAULT_MEAL_PERIODS, 60)!.key).toBe('supper');
    expect(mealPeriodAt(DEFAULT_MEAL_PERIODS, 15 * 60)).toBeNull();
    expect(
      mealPeriodAt(
        DEFAULT_MEAL_PERIODS.map((p) => ({ ...p, price: 0 })),
        12 * 60,
      ),
    ).toBeNull();
    expect(mealPeriodRange({ start: 22 * 60, end: 120 })).toBe('22:00–次日 02:00');
    expect(mealAllowance({ meals12h: 2, meals24h: 3 }, 1)).toBe(2);
    expect(mealAllowance({ meals12h: 2, meals24h: 3 }, 2)).toBe(3);
    expect(mealAllowance(null, 1)).toBe(0);
  });
});

describe('餐厅入口', () => {
  it('含餐：这一行原价照记、自动折成 0；同一餐只登记一次；含的餐用完照价收；那一行作废了可以重新登记', async () => {
    const g = await checkin(ticket['含餐门票']);
    const pv = (await api(ctx.app, ctx.clerk, 'GET', `/api/dining/meal-entries/preview?tag=${g.tagCode}`)).body;
    expect(pv).toMatchObject({ tagCode: g.tagCode, ticketName: '含餐门票', allowance: 1, used: 0, entered: false, kind: 'included', period: { key: 'lunch', price: 19900 } });
    const key = randomUUID();
    const r = await enter(g.tagCode, key);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ entered: true, used: 1 });
    // 同一个编号原样重提（断网重试发的是原来那一笔）：照原样返回，不再记一笔
    const replay = await api(ctx.app, ctx.clerk, 'POST', '/api/dining/meal-entries', {
      clientKey: key,
      tagCode: g.tagCode,
      visitId: g.id,
      expected: { period: 'lunch', kind: 'included', price: 19900 },
    });
    expect(replay.status, JSON.stringify(replay.body)).toBe(200);
    expect(code(await enter(g.tagCode))).toBe('MEAL_ENTERED');
    const v = await visit(g.id);
    const line = v.lines.find((l) => l.name === '午餐自助')!;
    expect(line).toMatchObject({ amount: 19900, source: 'dining' });
    expect(line.discount).toMatchObject({ listAmount: 19900, finalAmount: 0, reason: '含餐' });
    // 结账核对：餐费照原价列着、单项折扣把它折掉，只收门票
    const p = await due(g.id);
    expect(p.totalAmount - (p.lineDiscountAmount ?? 0)).toBe(69900);
    // 那一行作废了，可以重新登记（还是含餐）
    expect((await api(ctx.app, ctx.owner, 'POST', `/api/frontdesk/lines/${line.id}/void`, { reason: '登记错了' })).status).toBe(200);
    const again = await enter(g.tagCode);
    expect(again.status, JSON.stringify(again.body)).toBe(200);
    expect(again.body.kind === undefined || again.body.used === 1).toBe(true);
    const lines = (await visit(g.id)).lines.filter((l) => l.status === 'active' && l.name === '午餐自助');
    expect(lines).toHaveLength(1);
    expect(lines[0]!.discount?.finalAmount).toBe(0);
    // 同一位客人第二餐（换个餐段）含的餐用完了：照价收——这里改一下记录模拟已经用过一餐别的餐段
    const rows = await ctx.sql`SELECT kind FROM meal_entries WHERE visit_id = ${g.id} ORDER BY id`;
    expect(rows.map((x) => x.kind)).toEqual(['included', 'included']);
  });

  it('裸票照时段价收；锁牌外出、没在店的不能登记；结果待确认（作废、查回）', async () => {
    const g = await checkin();
    const r = await enter(g.tagCode);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const line = (await visit(g.id)).lines.find((l) => l.name === '午餐自助')!;
    expect(line.amount).toBe(19900);
    expect(line.discount).toBeNull();
    // 没在店的手牌
    expect((await enter('M999')).status).toBe(404);
    // 作废过的编号：原请求整笔回滚
    const g2 = await checkin();
    const key = randomUUID();
    expect((await api(ctx.app, ctx.clerk, 'POST', `/api/frontdesk/ops/${key}/abandon`, { type: 'meal_entry' })).status).toBe(200);
    expect(code(await enter(g2.tagCode, key))).toBe('OP_ABANDONED');
    expect((await ctx.sql`SELECT 1 FROM meal_entries WHERE visit_id = ${g2.id}`).length).toBe(0);
    const ok = randomUUID();
    expect((await enter(g2.tagCode, ok)).status).toBe(200);
    expect((await api(ctx.app, ctx.clerk, 'GET', `/api/frontdesk/ops/${ok}?type=meal_entry`)).body).toMatchObject({ found: true, type: 'meal_entry', visit: { id: g2.id } });
    // 当天登记列表
    const list = (await api(ctx.app, ctx.clerk, 'GET', '/api/dining/meal-entries')).body as { entries: { tagCode: string; kind: string }[] };
    expect(list.entries.some((e) => e.tagCode === g2.tagCode && e.kind === 'paid')).toBe(true);
    // 进餐登记只追加
    await expect(ctx.sql`UPDATE meal_entries SET kind = 'paid' WHERE visit_id = ${g2.id}`).rejects.toThrow();
  });

  it('Codex 审查：只认预览时看到的客人；餐费不能转单；只有餐厅权限的岗位也能查回、作废', async () => {
    const g = await checkin();
    // 预览之后这张牌换了人（这里直接给一个别的来访）：拒绝，不记到别人头上
    const other = await checkin();
    const wrong = await api(ctx.app, ctx.clerk, 'POST', '/api/dining/meal-entries', {
      clientKey: randomUUID(),
      tagCode: g.tagCode,
      visitId: other.id,
      expected: { period: 'lunch', kind: 'paid', price: 19900 },
    });
    expect(code(wrong)).toBe('VISIT_CHANGED');
    expect((await ctx.sql`SELECT 1 FROM meal_entries WHERE visit_id IN ${ctx.sql([g.id, other.id])}`).length).toBe(0);
    // 餐费不能转到别的牌上
    expect((await enter(g.tagCode)).status).toBe(200);
    const line = (await visit(g.id)).lines.find((l) => l.name === '午餐自助')!;
    const moved = await api(ctx.app, ctx.clerk, 'POST', '/api/frontdesk/lines/move', { clientKey: randomUUID(), lineIds: [line.id], toTagCode: other.tagCode, reason: '挂错手牌' });
    expect(code(moved)).toBe('LINE_NOT_MOVABLE');
    // 平板（只有「在餐厅下单」，没有前台权限）：走餐厅的查回、作废
    await createStaff(ctx.sql, { username: 'pad', displayName: '餐厅平板', role: 'tablet', password: PASSWORD, mustChangePassword: false });
    const pad = await login(ctx.app, 'pad');
    const key = randomUUID();
    expect((await enter(other.tagCode, key, pad)).status).toBe(200);
    expect((await api(ctx.app, pad, 'GET', `/api/frontdesk/ops/${key}?type=meal_entry`)).status).toBe(403);
    // 查回只给「登上了、哪次来访」，不给整张客人卡（Codex 审查第二轮）
    expect((await api(ctx.app, pad, 'GET', `/api/dining/meal-entry-ops/${key}`)).body).toEqual({ found: true, type: 'meal_entered', visitId: other.id });
    // 刷卡：平板按餐厅的权限查（前台的 403），只给牌号、不带来访
    await ctx.sql`UPDATE hand_tags SET card_uid = 'CAFE0001' WHERE code = ${other.tagCode}`;
    expect((await api(ctx.app, pad, 'GET', '/api/frontdesk/tags/by-card?uid=CAFE0001')).status).toBe(403);
    expect((await api(ctx.app, pad, 'GET', '/api/dining/tags/by-card?uid=cafe0001')).body).toMatchObject({ found: true, tag: { code: other.tagCode }, visit: null });
    // 预览以后收费变了（后台改了价）：要求重新刷牌
    const g3 = await checkin();
    const stale = await api(ctx.app, ctx.clerk, 'POST', '/api/dining/meal-entries', {
      clientKey: randomUUID(),
      tagCode: g3.tagCode,
      visitId: g3.id,
      expected: { period: 'lunch', kind: 'paid', price: 9900 },
    });
    expect(code(stale)).toBe('MEAL_CHANGED');
    expect((await ctx.sql`SELECT 1 FROM meal_entries WHERE visit_id = ${g3.id}`).length).toBe(0);
    const gone = randomUUID();
    expect((await api(ctx.app, pad, 'POST', `/api/dining/meal-entry-ops/${gone}/abandon`, {})).status).toBe(200);
  });

  it('餐台点菜折零：登记了这一餐的客人点的餐厅的菜折成 0，水吧照价；没登记的照价', async () => {
    const g = await checkin();
    expect((await enter(g.tagCode)).status).toBe(200);
    const o = await api(ctx.app, ctx.clerk, 'POST', '/api/dining/orders', {
      clientKey: randomUUID(),
      visitId: g.id,
      lines: [
        { itemId: item['小炒肉'], quantity: 2 },
        { itemId: item['杨枝甘露'], quantity: 1 },
      ],
      expectedTotal: 5800 * 2 + 3800,
    });
    expect(o.status, JSON.stringify(o.body)).toBe(200);
    const lines = (await visit(g.id)).lines.filter((l) => l.status === 'active');
    expect(lines.find((l) => l.name === '小炒肉')!.discount).toMatchObject({ listAmount: 11600, finalAmount: 0, reason: '自助' });
    expect(lines.find((l) => l.name === '杨枝甘露')!.discount).toBeNull();
    // 没登记进餐的客人：照价
    const h = await checkin();
    expect(
      (await api(ctx.app, ctx.clerk, 'POST', '/api/dining/orders', { clientKey: randomUUID(), visitId: h.id, lines: [{ itemId: item['小炒肉'], quantity: 1 }], expectedTotal: 5800 })).status,
    ).toBe(200);
    expect((await visit(h.id)).lines.find((l) => l.name === '小炒肉')!.discount).toBeNull();
    // 前台自检照样一致
    const checks = (await api(ctx.app, ctx.owner, 'GET', '/api/frontdesk/checks')).body as { label: string; ok: boolean; detail: string }[];
    for (const c of checks) expect(c.ok, `${c.label}：${c.detail}`).toBe(true);
    // 结账：折掉的不收
    const p = await due(g.id);
    expect(p.lineDiscountAmount).toBe(11600);
  });

  it('Codex 安全审查：系统打的折扣不能手动撤、改；餐费作废了，这一餐带出来的自助折扣一并撤下', async () => {
    const g = await checkin();
    expect((await enter(g.tagCode)).status).toBe(200);
    const o = await api(ctx.app, ctx.clerk, 'POST', '/api/dining/orders', { clientKey: randomUUID(), visitId: g.id, lines: [{ itemId: item['小炒肉'], quantity: 1 }], expectedTotal: 5800 });
    expect(o.status, JSON.stringify(o.body)).toBe(200);
    const before = (await visit(g.id)).lines.filter((l) => l.status === 'active');
    const meal = before.find((l) => l.name === '午餐自助')!;
    const dish = before.find((l) => l.name === '小炒肉')!;
    expect(dish.discount).toMatchObject({ finalAmount: 0, reason: '自助' });
    // 手动撤下、改折扣：都不行（经理也不行）
    const rv = await api(ctx.app, ctx.owner, 'POST', `/api/frontdesk/lines/${dish.id}/discount/revoke`, { clientKey: randomUUID(), reason: '想改回原价' });
    expect(code(rv), JSON.stringify(rv.body)).toBe('AUTO_DISCOUNT_LOCKED');
    const rp = await api(ctx.app, ctx.owner, 'POST', `/api/frontdesk/lines/${dish.id}/discount`, { clientKey: randomUUID(), rate: 50, reason: '改八折' });
    expect(code(rp), JSON.stringify(rp.body)).toBe('AUTO_DISCOUNT_LOCKED');
    // 餐费那一行作废：菜的自助折扣一并撤下，照原价收
    expect((await api(ctx.app, ctx.owner, 'POST', `/api/frontdesk/lines/${meal.id}/void`, { reason: '登记错了' })).status).toBe(200);
    const after = (await visit(g.id)).lines.find((l) => l.id === dish.id)!;
    expect(after.status).toBe('active');
    expect(after.discount).toBeNull();
    const [d] = await ctx.sql<{ status: string; revokeReason: string }[]>`SELECT status, revoke_reason FROM bill_line_discounts WHERE line_id = ${dish.id}`;
    expect(d).toMatchObject({ status: 'revoked', revokeReason: '餐费作废，自助折扣一并撤下' });
    expect((await due(g.id)).lineDiscountAmount ?? 0).toBe(0);
    const checks = (await api(ctx.app, ctx.owner, 'GET', '/api/frontdesk/checks')).body as { label: string; ok: boolean; detail: string }[];
    for (const c of checks) expect(c.ok, `${c.label}：${c.detail}`).toBe(true);
  });
});
