// 8.2.20 休闲娱乐（docs/V82220_LEISURE.md）：网吧、桌球按「基础价含时长 + 加钟」计时；价目表「娱乐价格」一键建业态、计费、台位；
// 刷手牌开单就开始计时，结束按时长挂到手牌（各自的收银项目，部门「娱乐」）。全部是合成数据。

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LeisurePlan, LeisureSetupResult } from '../src/shared/leisure';
import type { PriceCatalogOverview } from '../src/shared/price-catalog';
import { blockUsageFee, usageEstimate, type UsageBoard, type UsageDetail, type UsageRules } from '../src/shared/usages';
import type { Deps, OpContext } from '../src/server/lib/context';
import { buildWorkbook } from '../src/server/lib/xlsx';
import { couponLines } from '../src/server/modules/coupon-checkout';
import { endUsage } from '../src/server/modules/usages';
import { api, setup, type TestContext } from './helpers';
import { priceSheet } from './price-workbook';

let ctx: TestContext;
let deps: Deps;
let tagNo = 0;

const enter = async () => {
  tagNo += 1;
  const code = `G${String(tagNo).padStart(3, '0')}`;
  const r = await api(ctx.app, ctx.clerk, 'POST', '/api/frontdesk/checkins', { clientKey: randomUUID(), guests: [{ tagCode: code, zone: 'male' }] });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  const visitId = r.body.visits[0].id as number;
  const [v] = await ctx.sql<{ billId: number }[]>`SELECT bill_id FROM visits WHERE id = ${visitId}`;
  return { visitId, tagCode: code, billId: Number(v!.billId) };
};
const actor = () => ({ id: ctx.clerkId, username: 'clerk', displayName: '店员', role: 'clerk' as const, duties: [], mustChangePassword: false });
const endAfter = (u: UsageDetail, minutes: number) =>
  endUsage(deps, u.id, { clientKey: randomUUID() }, { actor: actor(), at: new Date(new Date(u.openedAt).getTime() + minutes * 60_000) } satisfies OpContext);
const linesOf = (billId: number) =>
  ctx.sql<{ name: string; quantity: number; unitPrice: number; amount: number; category: string }[]>`
    SELECT l.name, l.quantity, l.unit_price, l.amount, si.category FROM bill_lines l LEFT JOIN service_items si ON si.id = l.item_id
    WHERE l.bill_id = ${billId} AND l.status = 'active' ORDER BY l.id`;

beforeAll(async () => {
  ctx = await setup();
  deps = { sql: ctx.sql, config: ctx.config };
  expect((await api(ctx.app, ctx.owner, 'POST', '/api/frontdesk/tags/batch', { prefix: 'G', from: 1, to: 20, width: 3, zone: 'male' })).status).toBe(200);
  // 价目表只导「娱乐价格」一张：网吧 20 台 39/2h 加钟 19.9；桌球 2 台 49/1h 没写加钟；畅玩卷按次（不计时，不建）
  const sheet = priceSheet('娱乐价格', [['合成门店'], ['类型', '数量', '价格', '备注'], ['网吧', 20, '39/2h', '加钟/19.9'], ['桌球', 2, '49/1h', ''], ['畅玩卷', '', '99', '']]);
  const xlsxBase64 = buildWorkbook([sheet]).toString('base64');
  const p = (await api(ctx.app, ctx.owner, 'POST', '/api/admin/price-catalog/import/preview', { fileName: 'entertainment.xlsx', xlsxBase64, sheet: 'entertainment' })).body;
  expect(p.issues.filter((i: { level: string }) => i.level === 'error')).toEqual([]);
  const imp = await api(ctx.app, ctx.owner, 'POST', '/api/admin/price-catalog/import', {
    fileName: 'entertainment.xlsx',
    xlsxBase64,
    sheet: 'entertainment',
    previewDigest: p.digest,
    opKey: randomUUID(),
  });
  expect(imp.status, JSON.stringify(imp.body)).toBe(201);
  const ov = (await api(ctx.app, ctx.owner, 'GET', '/api/admin/price-catalog')).body as PriceCatalogOverview;
  const act = await api(ctx.app, ctx.owner, 'POST', '/api/admin/price-catalog/activate', { draftId: ov.draft!.id, opKey: randomUUID(), countReason: '用例：只有娱乐价格' });
  expect(act.status, JSON.stringify(act.body)).toBe(200);
});
afterAll(async () => ctx?.close());

describe('基础价 + 加钟', () => {
  it('起步以内只收基础价；之后每个计费单位（不足按一个）收加钟价；估算与说明跟着走', () => {
    const p = { minMinutes: 120, stepMinutes: 60 };
    expect(blockUsageFee(0, p, 3900, 1990)).toMatchObject({ extraSteps: 0, amount: 3900, chargedMinutes: 120 });
    expect(blockUsageFee(120, p, 3900, 1990)).toMatchObject({ extraSteps: 0, amount: 3900 });
    expect(blockUsageFee(121, p, 3900, 1990)).toMatchObject({ extraSteps: 1, amount: 5890, chargedMinutes: 180 });
    expect(blockUsageFee(185, p, 3900, 1990)).toMatchObject({ extraSteps: 2, extraAmount: 3980, amount: 7880 });
    expect(usageEstimate(185, { hourPrice: 3900, minMinutes: 120, stepMinutes: 60, openFee: 0, extraPrice: 1990 })).toBe(7880);
    // 旧的每小时价照旧
    expect(usageEstimate(90, { hourPrice: 6000, minMinutes: 60, stepMinutes: 30, openFee: 0 })).toBe(9000);
  });
});

describe('按价目表一键建', () => {
  it('列出按时长收费的娱乐；建业态、计费、台位；再建不重复；只有后台设置权限能建', async () => {
    const plan = (await api(ctx.app, ctx.owner, 'GET', '/api/admin/leisure/plan')).body as LeisurePlan;
    expect(plan.rows.map((r) => r.name)).toEqual(['网吧', '桌球']);
    expect(plan.rows[0]).toMatchObject({ basePrice: 3900, minMinutes: 120, extraPrice: 1990, stepMinutes: 60, extraGuessed: false, units: 20, existing: 0, prefix: 'NB', problem: null });
    expect(plan.rows[0]!.itemId).not.toBeNull();
    // 桌球没写加钟：按基础价折算每小时
    expect(plan.rows[1]).toMatchObject({ basePrice: 4900, minMinutes: 60, extraPrice: 4900, extraGuessed: true, units: 2, prefix: 'ZQ' });
    const floorId = plan.floors[0]!.id;
    const body = {
      floorId,
      types: [
        { name: '网吧', prefix: 'NB' },
        { name: '桌球', prefix: 'ZQ' },
      ],
    };
    expect((await api(ctx.app, ctx.clerk, 'POST', '/api/admin/leisure/setup', body)).status).toBe(403);
    const r = await api<LeisureSetupResult>(ctx.app, ctx.owner, 'POST', '/api/admin/leisure/setup', body);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.created).toHaveLength(22);
    expect(r.body.created.slice(0, 2)).toEqual(['NB01', 'NB02']);
    const rules = (await api(ctx.app, ctx.owner, 'GET', '/api/admin/usage-rules')).body as UsageRules;
    expect(rules.businessTypes).toEqual(expect.arrayContaining(['网吧', '桌球']));
    expect(rules.leisureTypes).toEqual(['网吧', '桌球']);
    expect(rules.pricing['网吧']).toMatchObject({ feeItemId: plan.rows[0]!.itemId, minMinutes: 120, stepMinutes: 60, extraPrice: 1990, openFeeItemId: null });
    // 再建一次：台位都有了，不重复
    const again = await api<LeisureSetupResult>(ctx.app, ctx.owner, 'POST', '/api/admin/leisure/setup', body);
    expect(again.body.created).toEqual([]);
    // 前缀一样的拒绝
    expect(
      (
        await api(ctx.app, ctx.owner, 'POST', '/api/admin/leisure/setup', {
          floorId,
          types: [
            { name: '网吧', prefix: 'NB' },
            { name: '桌球', prefix: 'NB' },
          ],
        })
      ).status,
    ).toBe(400);
    const board = (await api(ctx.app, ctx.clerk, 'GET', '/api/usages/board')).body as UsageBoard;
    expect(board.leisureTypes).toEqual(['网吧', '桌球']);
    expect(board.spaces.filter((s) => s.businessType === '网吧')).toHaveLength(20);
    expect(board.spaces.find((s) => s.code === 'NB01')!.pricing).toMatchObject({ hourPrice: 3900, extraPrice: 1990 });
  });
});

describe('刷手牌计时', () => {
  it('开单就计时；结束按基础价 + 加钟挂到手牌（部门「娱乐」）；没超过起步只收基础价', async () => {
    const board = (await api(ctx.app, ctx.clerk, 'GET', '/api/usages/board')).body as UsageBoard;
    const sid = (code: string) => board.spaces.find((s) => s.code === code)!.id;
    const g = await enter();
    const open = await api<UsageDetail>(ctx.app, ctx.clerk, 'POST', '/api/usages', { clientKey: randomUUID(), spaceId: sid('NB01'), tagCode: g.tagCode });
    expect(open.status, JSON.stringify(open.body)).toBe(200);
    const done = await endAfter(open.body, 185);
    expect(done.fee).toEqual({ amount: 7880, chargedMinutes: 240, openFee: 0 });
    expect(await linesOf(g.billId)).toEqual([
      { name: '网吧 NB01 2 小时', quantity: 1, unitPrice: 3900, amount: 3900, category: '娱乐' },
      { name: '网吧 NB01 加钟（每 60 分钟）', quantity: 2, unitPrice: 1990, amount: 3980, category: '娱乐' },
    ]);
    const kinds = await ctx.sql<{ kind: string }[]>`SELECT kind FROM space_usage_charges WHERE usage_id = ${open.body.id} ORDER BY kind`;
    expect(kinds.map((k) => k.kind)).toEqual(['extra', 'fee']);
    // Codex 审查（P1）：休闲娱乐的基础价也记成 fee，但周一至周四不打包房房费折扣（只认派对房房费）——结束在周二或周三
    const k = await enter();
    const mid = await api<UsageDetail>(ctx.app, ctx.clerk, 'POST', '/api/usages', { clientKey: randomUUID(), spaceId: sid('NB02'), tagCode: k.tagCode });
    expect(mid.status, JSON.stringify(mid.body)).toBe(200);
    const shDay = (t: number) => new Date(t + 8 * 3_600_000).getUTCDay();
    let days = 1;
    while (![2, 3].includes(shDay(new Date(mid.body.openedAt).getTime() + days * 86_400_000))) days += 1;
    await endAfter(mid.body, days * 1440);
    const cl = await couponLines(ctx.sql, [k.billId]);
    const [dow] = await ctx.sql<{ d: number }[]>`SELECT extract(isodow FROM business_date)::int AS d FROM bill_lines WHERE bill_id = ${k.billId} LIMIT 1`;
    expect([1, 2, 3, 4]).toContain(Number(dow!.d));
    expect(cl.map((l) => [l.usageCharge, l.partyRoomDay])).toEqual([
      ['fee', false],
      ['extra', false],
    ]);

    const h = await enter();
    const short = await api<UsageDetail>(ctx.app, ctx.clerk, 'POST', '/api/usages', { clientKey: randomUUID(), spaceId: sid('ZQ01'), tagCode: h.tagCode });
    expect(short.status, JSON.stringify(short.body)).toBe(200);
    expect((await endAfter(short.body, 30)).fee).toEqual({ amount: 4900, chargedMinutes: 60, openFee: 0 });
    expect((await linesOf(h.billId)).map((l) => [l.name, l.amount])).toEqual([['桌球 ZQ01 1 小时', 4900]]);
  });
});
