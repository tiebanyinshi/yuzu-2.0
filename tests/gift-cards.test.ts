// 8.1.40 礼品卡先出卡、后绑手机号（docs/V8140.md 第 5 节）：一批匿名卡会员，会员号就是卡号；转实名时填手机号；储值照常充值。

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, rechargeBody, setup, type TestContext } from './helpers';

let ctx: TestContext;
beforeAll(async () => {
  ctx = await setup();
});
afterAll(async () => ctx.close());

describe('礼品卡批次', () => {
  it('生成一批：不要手机号，会员号就是卡号；同一编号重提返回同一批；充值、转实名照常；批次写已绑几张、预存多少', async () => {
    const key = randomUUID();
    const body = { clientKey: key, label: '新年礼品卡', quantity: 3, note: '年会' };
    expect((await api(ctx.app, ctx.owner, 'POST', '/api/gift-cards', { ...body, quantity: 201 })).status).toBe(400);
    const r = await api(ctx.app, ctx.owner, 'POST', '/api/gift-cards', body);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.batch).toMatchObject({ label: '新年礼品卡', quantity: 3, bound: 0, principal: 0 });
    const again = await api(ctx.app, ctx.owner, 'POST', '/api/gift-cards', body);
    expect(again.status).toBe(200);
    expect(again.body.batch.id).toBe(r.body.batch.id);
    expect((await api(ctx.app, ctx.owner, 'POST', '/api/gift-cards', { ...body, quantity: 2 })).body.error.code).toBe('IDEMPOTENCY_CONFLICT');

    const cards = (await api(ctx.app, ctx.owner, 'GET', `/api/gift-cards/${r.body.batch.id}/cards`)).body as { id: number; memberNo: string; bound: boolean }[];
    expect(cards).toHaveLength(3);
    expect(cards.every((c) => /^YZ\d+$/.test(c.memberNo) && !c.bound)).toBe(true);
    const [m] = await ctx.sql<{ cardType: string; phone: string | null }[]>`SELECT card_type, phone FROM members WHERE id = ${cards[0]!.id}`;
    expect(m).toEqual({ cardType: 'anonymous', phone: null });

    // 预存：按这张卡照常充值
    const rc = await api(ctx.app, ctx.owner, 'POST', '/api/recharges', rechargeBody(cards[0]!.id, 50000, 0, { paymentMethod: 'cash', bonusMode: 'custom' }));
    expect(rc.status, JSON.stringify(rc.body)).toBe(200);
    const list = (await api(ctx.app, ctx.owner, 'GET', '/api/gift-cards')).body as { id: number; principal: number; bound: number }[];
    expect(list.find((b) => b.id === r.body.batch.id)).toMatchObject({ principal: 50000, bound: 0 });

    // 送出去以后绑手机号：转实名
    const bind = await api(ctx.app, ctx.owner, 'PUT', `/api/members/${cards[0]!.id}`, { name: '王小明', phone: '19911150001', convertToNamed: true, phoneReason: '礼品卡送出，绑定手机号' });
    expect(bind.status, JSON.stringify(bind.body)).toBe(200);
    expect((await api(ctx.app, ctx.owner, 'GET', '/api/gift-cards')).body.find((b: { id: number }) => b.id === r.body.batch.id)).toMatchObject({ bound: 1 });
    const csv = await ctx.app.inject({ method: 'GET', url: `/api/gift-cards/${r.body.batch.id}/cards.csv`, headers: { cookie: ctx.owner } });
    expect(csv.body).toContain(cards[1]!.memberNo);
    // 要登录；与「发券」页同一项权限（管券的）：前台有建档权限也不能生成、看卡号（合并前 Codex 审查 c79ca75）
    expect((await api(ctx.app, '', 'GET', '/api/gift-cards')).status).toBe(401);
    expect((await api(ctx.app, ctx.clerk, 'GET', '/api/gift-cards')).status).toBe(403);
    expect((await api(ctx.app, ctx.clerk, 'POST', '/api/gift-cards', { clientKey: randomUUID(), label: '前台', quantity: 1 })).status).toBe(403);
    expect((await api(ctx.app, ctx.clerk, 'GET', `/api/gift-cards/${r.body.batch.id}/cards`)).status).toBe(403);
  });

  it('没收到结果（Codex 审查 8a7023d）：按编号查回那一批；没生成的确认作废以后，迟到的原请求不再生成', async () => {
    const key = randomUUID();
    const made = await api(ctx.app, ctx.owner, 'POST', '/api/gift-cards', { clientKey: key, label: '查回礼品卡', quantity: 2 });
    expect(made.status).toBe(201);
    expect((await api(ctx.app, ctx.owner, 'GET', `/api/erp/ops/${key}?type=gift_card_batch`)).body).toMatchObject({ found: true, abandoned: false, refId: made.body.batch.id });
    // 生成过的不能作废（照实回答已经生成）
    expect((await api(ctx.app, ctx.owner, 'POST', `/api/erp/ops/${key}/abandon`, { type: 'gift_card_batch' })).body).toMatchObject({ found: true, abandoned: false });

    const lost = randomUUID();
    expect((await api(ctx.app, ctx.owner, 'POST', `/api/erp/ops/${lost}/abandon`, { type: 'gift_card_batch', summary: '作废礼品卡 × 5 张' })).body).toMatchObject({ found: false, abandoned: true });
    const late = await api(ctx.app, ctx.owner, 'POST', '/api/gift-cards', { clientKey: lost, label: '作废了的', quantity: 5 });
    expect(late.body.error?.code).toBe('OP_ABANDONED');
    const [n] = await ctx.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM gift_card_batches WHERE client_key = ${lost}`;
    expect(n!.n).toBe(0);
  });

  it('导出卡号：名字以 = + @ 开头的当文本，表格不会当公式执行（Codex 审查 305508f）', async () => {
    const r = await api(ctx.app, ctx.owner, 'POST', '/api/gift-cards', { clientKey: randomUUID(), label: '=HYPERLINK("x")', quantity: 1 });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const csv = await ctx.app.inject({ method: 'GET', url: `/api/gift-cards/${r.body.batch.id}/cards.csv`, headers: { cookie: ctx.owner } });
    expect(csv.body).toContain(`"'=HYPERLINK(""x"")"`);
    expect(csv.body).not.toMatch(/,=HYPERLINK/);
  });

  it('别的店生成的批次：本店按编号看不到卡号、导不出（合并前 Codex 审查 1a89c41）', async () => {
    const [b] = await ctx.sql<{ id: number }[]>`INSERT INTO stores (code, name, entity_id) VALUES ('GC2', '礼品卡乙店', 1) RETURNING id`;
    expect((await api(ctx.app, ctx.owner, 'POST', '/api/auth/store', { storeId: b!.id })).status).toBe(200);
    let otherId = 0;
    try {
      const r = await api(ctx.app, ctx.owner, 'POST', '/api/gift-cards', { clientKey: randomUUID(), label: '乙店礼品卡', quantity: 1 });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      otherId = r.body.batch.id;
    } finally {
      expect((await api(ctx.app, ctx.owner, 'POST', '/api/auth/store', { storeId: 1 })).status).toBe(200);
    }
    expect((await api(ctx.app, ctx.owner, 'GET', `/api/gift-cards/${otherId}/cards`)).status).toBe(404);
    expect((await ctx.app.inject({ method: 'GET', url: `/api/gift-cards/${otherId}/cards.csv`, headers: { cookie: ctx.owner } })).statusCode).toBe(404);
    expect(((await api(ctx.app, ctx.owner, 'GET', '/api/gift-cards')).body as { id: number }[]).some((x) => x.id === otherId)).toBe(false);
  });
});
