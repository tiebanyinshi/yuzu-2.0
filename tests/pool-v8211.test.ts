// 8.2.21 男汤 / 女汤泡池（docs/V82221_POOL.md）：刷客人手牌（芯片号或牌号）、刷技师工牌（芯片号或工号）认人；
// 下单走钟房派钟（挂账、建钟单、立即上钟），服务记进技师的业绩；技师管理的岗位给技师绑工牌。全部是合成数据。

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PoolGuest, PoolTechnician } from '../src/shared/pool';
import { api, setup, type TestContext } from './helpers';

let ctx: TestContext;
let scrub = 0;
const tech: Record<string, number> = {};

const guest = (q: string) => api<PoolGuest>(ctx.app, ctx.clerk, 'GET', `/api/pool/guest?${q}`);
const techOf = (q: string) => api<PoolTechnician>(ctx.app, ctx.clerk, 'GET', `/api/pool/technician?${q}`);
const bind = (id: number, uid: string | null, cookie = ctx.owner) => api<PoolTechnician>(ctx.app, cookie, 'PUT', `/api/technicians/${id}/card`, { uid });

beforeAll(async () => {
  ctx = await setup();
  expect((await api(ctx.app, ctx.owner, 'POST', '/api/frontdesk/tags/batch', { prefix: 'P', from: 1, to: 9, width: 3, zone: 'male' })).status).toBe(200);
  const it = await api(ctx.app, ctx.owner, 'POST', '/api/items', { name: '搓澡', category: '泡池', price: 6800, durationMinutes: 30, technicianRequired: true, gender: 'male' });
  expect(it.status, JSON.stringify(it.body)).toBe(200);
  scrub = it.body.items.find((i: { name: string }) => i.name === '搓澡').id;
  for (const no of ['21', '22']) {
    const r = await api(ctx.app, ctx.owner, 'POST', '/api/admin/technicians', { techNo: no, name: `搓澡师${no}`, gender: 'male', grade: 'standard' });
    expect(r.status).toBe(200);
    tech[no] = r.body.technicians.find((t: { techNo: string }) => t.techNo === no).id;
  }
  expect((await api(ctx.app, ctx.owner, 'PUT', '/api/admin/technicians/rules', { enabled: true })).status).toBe(200);
  expect((await api(ctx.app, ctx.clerk, 'POST', '/api/clockroom/sign-in-all')).status).toBe(200);
});
afterAll(async () => ctx?.close());

describe('泡池认人', () => {
  it('客人：芯片号或牌号，只认在店的；技师：工牌芯片号或工号；绑工牌只给技师管理的岗位、不能用手牌的芯片、不能两人一张', async () => {
    const c = await api(ctx.app, ctx.clerk, 'POST', '/api/frontdesk/checkins', { clientKey: randomUUID(), guests: [{ tagCode: 'P001', zone: 'male' }] });
    expect(c.status, JSON.stringify(c.body)).toBe(201);
    expect((await guest('code=p001')).body).toMatchObject({ tagCode: 'P001', zone: 'male' });
    expect((await guest('code=P002')).status).toBe(404);
    // 手牌芯片号
    await ctx.sql`UPDATE hand_tags SET card_uid = 'AA11BB22' WHERE code = 'P001'`;
    expect((await guest('uid=aa:11:bb:22')).body.tagCode).toBe('P001');
    // 技师
    expect((await techOf('code=21')).body).toMatchObject({ id: tech['21'], techNo: '21' });
    expect((await techOf('uid=CC33DD44')).status).toBe(404);
    expect((await bind(tech['21']!, 'CC33DD44', ctx.clerk)).status).toBe(403);
    expect((await bind(tech['21']!, 'cc-33-dd-44')).status).toBe(200);
    expect((await techOf('uid=CC33DD44')).body.id).toBe(tech['21']);
    expect((await bind(tech['22']!, 'CC33DD44')).body).toMatchObject({ error: { code: 'TECH_CARD_TAKEN' } });
    expect((await bind(tech['22']!, 'AA11BB22')).body).toMatchObject({ error: { code: 'CARD_IS_TAG' } });
    expect((await bind(tech['22']!, '12')).status).toBe(400);
    // 解绑
    expect((await bind(tech['21']!, null)).status).toBe(200);
    expect((await techOf('uid=CC33DD44')).status).toBe(404);
    expect((await bind(tech['21']!, 'CC33DD44')).status).toBe(200);
  });
});

describe('泡池下单', () => {
  it('派钟上钟：挂到客人手牌上、钟单上钟中；结账后进技师业绩', async () => {
    const g = (await guest('code=P001')).body;
    const t = (await techOf('uid=CC33DD44')).body;
    const r = await api(ctx.app, ctx.clerk, 'POST', '/api/clockroom/dispatch', {
      clientKey: randomUUID(),
      visitId: g.visitId,
      itemId: scrub,
      quantity: 1,
      technicianId: t.id,
      callType: 'rotation',
      startNow: true,
      expectedTotal: 6800,
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const [line] = await ctx.sql<{ technicianId: number; amount: number; status: string }[]>`
      SELECT l.technician_id, l.amount, s.status FROM bill_lines l JOIN technician_sessions s ON s.id = l.session_id
      JOIN visits v ON v.bill_id = l.bill_id WHERE v.id = ${g.visitId}`;
    expect(line).toMatchObject({ technicianId: t.id, amount: 6800, status: 'serving' });
    const preview = (await api(ctx.app, ctx.clerk, 'GET', `/api/frontdesk/checkout-preview?ids=${g.visitId}`)).body;
    const paid = await api(ctx.app, ctx.clerk, 'POST', '/api/frontdesk/checkouts', {
      clientKey: randomUUID(),
      visitIds: [g.visitId],
      expectedTotal: preview.totalAmount,
      payments: [{ method: 'cash', amount: preview.totalAmount }],
    });
    expect(paid.status, JSON.stringify(paid.body)).toBe(200);
    const date = (await api(ctx.app, ctx.clerk, 'GET', '/api/clockroom')).body.businessDate as string;
    const report = (await api(ctx.app, ctx.owner, 'GET', `/api/reports/technicians?from=${date}&to=${date}`)).body as { rows: { techNo: string; amount: number }[] };
    expect(report.rows.find((x) => x.techNo === '21')).toMatchObject({ amount: 6800 });
  });
});
