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
    // 店员没有建档权限的不能生成（店员有建档权限：这里只验接口要登录、有权限）
    expect((await api(ctx.app, '', 'GET', '/api/gift-cards')).status).toBe(401);
  });
});
