// 8.2.27 未交回、挂失手牌清单（docs/V82227_TAG_EXCEPTIONS.md）：结了账没还牌的登记「未交回」、丢牌换牌登记「挂失」，
// 清单带当时的客人；找回（解锁）清掉；没人用过、在店的牌不能这样登记。

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CheckoutPreview } from '../src/shared/checkout';
import type { TagException } from '../src/shared/frontdesk';
import { api, setup, type TestContext } from './helpers';

let ctx: TestContext;
const tagId: Record<string, number> = {};

const checkin = async (tagCode: string) => {
  const r = await api(ctx.app, ctx.clerk, 'POST', '/api/frontdesk/checkins', { clientKey: randomUUID(), guests: [{ tagCode, zone: 'male' }] });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.visits[0].id as number;
};
const checkout = async (visitId: number) => {
  const p = (await api<CheckoutPreview>(ctx.app, ctx.clerk, 'GET', `/api/frontdesk/checkout-preview?ids=${visitId}`)).body;
  const r = await api(ctx.app, ctx.clerk, 'POST', '/api/frontdesk/checkouts', {
    clientKey: randomUUID(),
    visitIds: [visitId],
    expectedTotal: p.totalAmount,
    payments: [{ method: 'cash', amount: p.totalAmount }],
  });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
};
const list = async () => {
  const r = await api<{ tags: TagException[] }>(ctx.app, ctx.clerk, 'GET', '/api/frontdesk/tag-exceptions');
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body.tags;
};
const code = (r: { body: unknown }) => (r.body as { error?: { code: string } }).error?.code;

beforeAll(async () => {
  ctx = await setup();
  expect((await api(ctx.app, ctx.owner, 'POST', '/api/frontdesk/tags/batch', { prefix: 'X', from: 1, to: 9, width: 2, zone: 'male' })).status).toBe(200);
  const tags = (await api<{ id: number; code: string }[]>(ctx.app, ctx.owner, 'GET', '/api/frontdesk/tags')).body;
  for (const t of tags) tagId[t.code] = t.id;
  await api(ctx.app, ctx.clerk, 'POST', '/api/shifts', { openingCash: 0 });
});
afterAll(async () => ctx.close());

describe('异常手牌清单', () => {
  it('结了账没还牌：登记未交回，清单带当时的客人；找回以后清掉、能再发', async () => {
    const v = await checkin('X01');
    await checkout(v);
    const r = await api(ctx.app, ctx.clerk, 'POST', `/api/frontdesk/tags/${tagId.X01}/lock`, { reason: '客人带走了', kind: 'unreturned' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const row = (await list()).find((t) => t.code === 'X01');
    expect(row).toMatchObject({ kind: 'unreturned', reason: '客人带走了', guest: { visitId: v } });
    expect(row!.guest!.checkedOutAt).not.toBeNull();
    // 锁着的牌发不出去
    expect((await api(ctx.app, ctx.clerk, 'POST', '/api/frontdesk/checkins', { clientKey: randomUUID(), guests: [{ tagCode: 'X01', zone: 'male' }] })).status).not.toBe(201);
    // 找回：解锁（值班经理以上），两列一起清
    expect((await api(ctx.app, ctx.owner, 'POST', `/api/frontdesk/tags/${tagId.X01}/unlock`, {})).status).toBe(200);
    expect((await list()).find((t) => t.code === 'X01')).toBeUndefined();
    const [db] = await ctx.sql<{ lockKind: string | null; lockVisitId: number | null }[]>`SELECT lock_kind, lock_visit_id FROM hand_tags WHERE id = ${tagId.X01!}`;
    expect(db).toEqual({ lockKind: null, lockVisitId: null });
    const [audit] = await ctx.sql<{ detail: { recovered?: string } }[]>`
      SELECT detail FROM audit_logs WHERE action = 'hand_tag_unlocked' AND target_id = ${String(tagId.X01!)} ORDER BY id DESC LIMIT 1`;
    expect(audit?.detail.recovered).toBe('unreturned');
    await checkout(await checkin('X01'));
  });

  it('丢牌换牌：原牌进挂失清单（记下这位客人）；只锁不登记丢失的照旧是手动锁定', async () => {
    const v = await checkin('X02');
    const r = await api(ctx.app, ctx.clerk, 'POST', `/api/frontdesk/visits/${v}/swap`, { clientKey: randomUUID(), toTagCode: 'X03', reason: '客人手牌丢失', lockOld: true, lost: true });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect((await list()).find((t) => t.code === 'X02')).toMatchObject({ kind: 'lost', guest: { visitId: v } });
    const w = await checkin('X04');
    expect((await api(ctx.app, ctx.clerk, 'POST', `/api/frontdesk/visits/${w}/swap`, { clientKey: randomUUID(), toTagCode: 'X05', reason: '柜锁坏了', lockOld: true })).status).toBe(200);
    expect((await list()).find((t) => t.code === 'X04')).toMatchObject({ kind: 'locked', guest: null });
    // 排序：挂失在手动锁定前面
    const kinds = (await list()).map((t) => t.kind);
    expect(kinds.indexOf('lost')).toBeLessThan(kinds.indexOf('locked'));
  });

  it('没人用过、在店的牌不能登记未交回 / 挂失', async () => {
    expect(code(await api(ctx.app, ctx.clerk, 'POST', `/api/frontdesk/tags/${tagId.X09}/lock`, { reason: '找不到了', kind: 'lost' }))).toBe('TAG_NEVER_USED');
    await checkin('X08');
    expect(code(await api(ctx.app, ctx.clerk, 'POST', `/api/frontdesk/tags/${tagId.X08}/lock`, { reason: '找不到了', kind: 'unreturned' }))).toBe('TAG_IN_USE');
    expect((await api(ctx.app, ctx.clerk, 'POST', `/api/frontdesk/tags/${tagId.X09}/lock`, { reason: '找不到了', kind: 'other' })).status).toBe(400);
  });
});
