// 8.2.27 前台改良（docs/V82227_DESK_IMPROVE.md）：POS 参考号当天查重（只读接口，前台提醒用）。

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, setup, type TestContext } from './helpers';

let ctx: TestContext;
let tagNo = 0;

const payByCard = async (ref: string) => {
  tagNo += 1;
  const tagCode = `K${String(tagNo).padStart(3, '0')}`;
  const c = await api(ctx.app, ctx.clerk, 'POST', '/api/frontdesk/checkins', { clientKey: randomUUID(), guests: [{ tagCode, zone: 'male' }] });
  expect(c.status, JSON.stringify(c.body)).toBe(201);
  const visitId = c.body.visits[0].id as number;
  const pre = (await api(ctx.app, ctx.clerk, 'GET', `/api/frontdesk/checkout-preview?ids=${visitId}`)).body;
  const r = await api(ctx.app, ctx.clerk, 'POST', '/api/frontdesk/checkouts', {
    clientKey: randomUUID(),
    visitIds: [visitId],
    expectedTotal: pre.totalAmount,
    payments: pre.totalAmount > 0 ? [{ method: 'bank_card', amount: pre.totalAmount, ref }] : [],
  });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body as { id: number; checkoutNo: string };
};
const check = async (ref: string) => (await api(ctx.app, ctx.clerk, 'GET', `/api/frontdesk/payment-ref-check?ref=${ref}`)).body;

beforeAll(async () => {
  ctx = await setup();
  expect((await api(ctx.app, ctx.owner, 'POST', '/api/frontdesk/tags/batch', { prefix: 'K', from: 1, to: 9, width: 3, zone: 'male' })).status).toBe(200);
  const items = await api(ctx.app, ctx.owner, 'POST', '/api/items', { name: '搓背', category: '康美', price: 5800 });
  expect(items.status).toBe(200);
});
afterAll(async () => ctx?.close());

describe('POS 参考号查重', () => {
  it('今天银行卡收款用过的参考号查得到（不分大小写）；没用过的为 0；太短的拒绝', async () => {
    expect(await check('AB12CD')).toEqual({ count: 0, checkoutNos: [] });
    const first = await payByCard('ab12cd');
    const r = await check('AB12CD');
    if (first.checkoutNo) expect(r.checkoutNos).toEqual([first.checkoutNo]);
    expect(r.count).toBe(1);
    expect((await check('ZZ9999')).count).toBe(0);
    expect((await api(ctx.app, ctx.clerk, 'GET', '/api/frontdesk/payment-ref-check?ref=12')).status).toBe(400);
  });
});
