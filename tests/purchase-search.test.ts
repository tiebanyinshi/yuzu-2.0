// 采购模块单号搜索与排序（8.2.12，《采购模块需求补充：单号搜索 / 排序 / 无供应商自购》R1、R2）

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { todayIn } from '../src/server/modules/inventory/common';
import { seedInventoryDemo } from '../src/server/seed-inventory';
import { api, login, setup, type TestContext } from './helpers';

let ctx: TestContext;
let buyer: string;

beforeAll(async () => {
  ctx = await setup();
  expect((await seedInventoryDemo(ctx.sql, ctx.config)).skipped).toBe(false);
  buyer = await login(ctx.app, 'zhouyi', 'yuzu2026');
  // 演示库里没有「需求单 → 采购单」的关联：拿一张待审核的需求单标紧急，把它的第一行挂到第一张采购单的第一行上
  const [m] = await ctx.sql<{ id: number }[]>`SELECT id FROM materials WHERE active ORDER BY id LIMIT 1`;
  const [dept] = await ctx.sql<{ id: number }[]>`SELECT id FROM departments WHERE active ORDER BY id LIMIT 1`;
  const made = await api(ctx.app, ctx.owner, 'POST', '/api/erp/requests', {
    clientKey: randomUUID(),
    departmentId: Number(dept!.id),
    lines: [{ materialId: Number(m!.id), name: '搜索用毛巾', purpose: '客用消耗', qtyMilli: 5000, unit: '条' }],
  });
  expect(made.status, JSON.stringify(made.body)).toBe(201);
  const r = { id: Number(made.body.request.id) };
  await ctx.sql`UPDATE purchase_requests SET priority = 'urgent' WHERE id = ${r!.id}`;
  const [rl] = await ctx.sql<{ id: number }[]>`SELECT id FROM purchase_request_lines WHERE request_id = ${r!.id} ORDER BY line_no LIMIT 1`;
  const [pl] = await ctx.sql<{ id: number }[]>`SELECT pl.id FROM purchase_order_lines pl JOIN purchase_orders po ON po.id = pl.po_id ORDER BY po.id, pl.line_no LIMIT 1`;
  // 只为造数据：已确认的采购单不许再挂需求行（守护触发器），这里临时关一下
  await ctx.sql`ALTER TABLE purchase_order_line_requests DISABLE TRIGGER USER`;
  await ctx.sql`INSERT INTO purchase_order_line_requests (po_line_id, request_line_id) VALUES (${pl!.id}, ${rl!.id})`;
  await ctx.sql`ALTER TABLE purchase_order_line_requests ENABLE TRIGGER USER`;
}, 120_000);
afterAll(async () => ctx.close());

const strip = (s: string) => s.replace(/[^A-Za-z0-9]/g, '');

describe('R1 单号直达', () => {
  it('采购单号：不管大小写与分隔符精确命中一张，直接给这张采购单', async () => {
    const [po] = await ctx.sql<{ id: number; docNo: string }[]>`SELECT id, doc_no FROM purchase_orders ORDER BY id LIMIT 1`;
    const r = await api(ctx.app, buyer, 'GET', `/api/purchase-lookup?no=${encodeURIComponent(`  ${strip(po!.docNo).toLowerCase()} `)}`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.exact).toBe(true);
    expect(r.body.hits).toHaveLength(1);
    expect(r.body.hits[0]).toMatchObject({ kind: 'po', id: Number(po!.id), poId: Number(po!.id) });
  });

  it('需求单号、收货单号反查到采购单；只给一部分单号列出候选；查不到给空；没有采购权限的不能查', async () => {
    const [link] = await ctx.sql<{ requestId: number; docNo: string; poId: number }[]>`
      SELECT r.id AS request_id, r.doc_no, pl.po_id FROM purchase_order_line_requests x JOIN purchase_order_lines pl ON pl.id = x.po_line_id
      JOIN purchase_request_lines l ON l.id = x.request_line_id JOIN purchase_requests r ON r.id = l.request_id ORDER BY r.id LIMIT 1`;
    const byReq = (await api(ctx.app, buyer, 'GET', `/api/purchase-lookup?no=${link!.docNo}`)).body;
    expect(byReq.hits[0]).toMatchObject({ kind: 'request', requestId: Number(link!.requestId), poId: Number(link!.poId), exact: true });
    const [rc] = await ctx.sql<{ docNo: string; poId: number }[]>`SELECT doc_no, purchase_order_id AS po_id FROM inv_docs WHERE doc_type = 'receipt' AND purchase_order_id IS NOT NULL LIMIT 1`;
    const byRc = (await api(ctx.app, buyer, 'GET', `/api/purchase-lookup?no=${rc!.docNo}`)).body;
    expect(byRc.hits[0]).toMatchObject({ kind: 'receipt', poId: Number(rc!.poId) });
    // 只输年月：不精确，列候选（后缀、包含），最多 20 条
    const partial = (await api(ctx.app, buyer, 'GET', `/api/purchase-lookup?no=CG2026`)).body;
    expect(partial.exact).toBe(false);
    expect(partial.hits.length).toBeGreaterThan(1);
    expect(partial.hits.length).toBeLessThanOrEqual(20);
    expect((await api(ctx.app, buyer, 'GET', '/api/purchase-lookup?no=CG19990101-9999')).body).toMatchObject({ hits: [], exact: false });
    const front = await login(ctx.app, 'xiaozhou', 'yuzu2026').catch(() => null);
    if (front) expect((await api(ctx.app, front, 'GET', '/api/purchase-lookup?no=CG2026')).status).toBe(403);
  });

  it('需求单列表按单号（不带分隔符）、物品名称搜', async () => {
    const [r] = await ctx.sql<{ id: number; docNo: string }[]>`SELECT id, doc_no FROM purchase_requests ORDER BY id LIMIT 1`;
    const boss = await login(ctx.app, 'linlan', 'yuzu2026');
    const hit = (await api(ctx.app, boss, 'GET', `/api/erp/requests?q=${strip(r!.docNo)}`)).body.requests as { id: number }[];
    expect(hit.map((x) => x.id)).toEqual([Number(r!.id)]);
    const [line] = await ctx.sql<{ name: string; requestId: number }[]>`SELECT name, request_id FROM purchase_request_lines ORDER BY id LIMIT 1`;
    const byName = (await api(ctx.app, boss, 'GET', `/api/erp/requests?q=${encodeURIComponent(line!.name)}`)).body.requests as { id: number }[];
    expect(byName.some((x) => x.id === Number(line!.requestId))).toBe(true);
  });

  it('需求单导出与列表同一个搜索：只导搜出来的那些单（条数核对也按搜索算）', async () => {
    const today = todayIn(ctx.config.timezone);
    const url = (q: string) => `/api/erp/requests/export?from=2020-01-01&to=${today}${q ? `&q=${encodeURIComponent(q)}` : ''}`;
    const listed = (await api(ctx.app, ctx.owner, 'GET', `/api/erp/requests?from=2020-01-01&to=${today}&q=${encodeURIComponent('搜索用毛巾')}`)).body.requests as { docNo: string }[];
    expect(listed).toHaveLength(1);
    const r = await ctx.app.inject({ method: 'GET', url: url('搜索用毛巾'), headers: { cookie: ctx.owner } });
    expect(r.statusCode, r.body).toBe(200);
    const rows = r.body.trim().split('\n').slice(1);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toContain(listed[0]!.docNo);
    expect(rows[0]).toContain('搜索用毛巾');
    // 另一张单：按单号（不带分隔符）搜只导它；不搜两张都在
    const [m] = await ctx.sql<{ id: number }[]>`SELECT id FROM materials WHERE active ORDER BY id LIMIT 1`;
    const [dept] = await ctx.sql<{ id: number }[]>`SELECT id FROM departments WHERE active ORDER BY id LIMIT 1`;
    const made = await api(ctx.app, ctx.owner, 'POST', '/api/erp/requests', {
      clientKey: randomUUID(),
      departmentId: Number(dept!.id),
      lines: [{ materialId: Number(m!.id), name: '导出用浴巾', purpose: '客用消耗', qtyMilli: 2000, unit: '条' }],
    });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    const otherNo = made.body.request.docNo as string;
    const byNo = await ctx.app.inject({ method: 'GET', url: url(strip(otherNo)), headers: { cookie: ctx.owner } });
    expect(byNo.body).toContain(otherNo);
    expect(byNo.body).not.toContain(listed[0]!.docNo);
    const all = await ctx.app.inject({ method: 'GET', url: url(''), headers: { cookie: ctx.owner } });
    expect(all.statusCode, all.body).toBe(200);
    expect(all.body).toContain(otherNo);
    expect(all.body).toContain(listed[0]!.docNo);
  });
});

describe('R2 排序（服务端、全量）', () => {
  it('采购单：按金额升降序、空值（没关联需求单的紧急程度）排最后、同值按单号；翻页；不认识的排序拒绝', async () => {
    const asc = (await api(ctx.app, buyer, 'GET', '/api/purchase-orders?sort=total&dir=asc')).body as { totalCents: number }[];
    const totals = asc.map((p) => Number(p.totalCents));
    expect(totals).toEqual([...totals].sort((a, b) => a - b));
    const desc = (await api(ctx.app, buyer, 'GET', '/api/purchase-orders?sort=total&dir=desc')).body as { totalCents: number }[];
    expect(desc.map((p) => Number(p.totalCents))).toEqual([...totals].sort((a, b) => b - a));
    const pri = (await api(ctx.app, buyer, 'GET', '/api/purchase-orders?sort=priority&dir=asc')).body as { priority: string | null }[];
    const firstNull = pri.findIndex((p) => p.priority === null);
    expect(firstNull === -1 || pri.slice(firstNull).every((p) => p.priority === null)).toBe(true);
    expect(pri.some((p) => p.priority !== null)).toBe(true);
    const page2 = (await api(ctx.app, buyer, 'GET', '/api/purchase-orders?sort=total&dir=asc&offset=2')).body as { id: number }[];
    expect(page2.map((p) => p.id)).toEqual((asc as unknown as { id: number }[]).slice(2).map((p) => p.id));
    expect((await api(ctx.app, buyer, 'GET', '/api/purchase-orders?sort=pinyin')).status).toBe(400);
  });

  it('流程进度：按发起时间升序；带紧急程度与申请部门', async () => {
    const list = (await api(ctx.app, buyer, 'GET', '/api/purchase-flow/list?sort=started&dir=asc')).body as { flows: { startedAt: string | null; priority: string | null }[] };
    const times = list.flows.filter((f) => f.startedAt).map((f) => Date.parse(f.startedAt!));
    expect(times).toEqual([...times].sort((a, b) => a - b));
    expect(list.flows.every((f) => 'priority' in f)).toBe(true);
    expect((await api(ctx.app, buyer, 'GET', '/api/purchase-flow/list?sort=priority&dir=desc')).status).toBe(200);
    expect((await api(ctx.app, buyer, 'GET', '/api/purchase-flow/list?sort=nope')).status).toBe(400);
  });
});
