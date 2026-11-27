// 物料发配记录（8.2.5，《汤崎 ERP｜采购商城模块 需求变更文档 v0.2》用例 B，docs/MALL_V825.md）：
// 部门申请 100 条毛巾、总仓只有 60 → 核库先发 60（部分发配，留在未完成）→ 剩下 40 转采购 → 到货合格 40 → 「补发物料」40 → 已完成、通知申请人。
// 另核对：不能超过待发配量与总仓结存、操作编号原样重提只发一次、时间与页签筛选、先申请先给、领料单作废以后不算。

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DispatchBoard, DispatchDetail } from '../src/shared/dispatch';
import type { PurchaseRequest } from '../src/shared/requests';
import { todayIn } from '../src/server/lib/dates';
import { createStaff } from '../src/server/modules/staff';
import { seedInventoryDemo } from '../src/server/seed-inventory';
import { api, login, PASSWORD, setup, type TestContext } from './helpers';

let ctx: TestContext;
let today: string;
let keeper: string;
let buyer: string;
let req: string;
let reqId: number;
let deptId: number;
let supplierId: number;
let towel: number;
const q = (n: number) => Math.round(n * 1000);

async function ok<T = any>(res: Promise<{ status: number; body: any }>, status = 200): Promise<T> {
  const r = await res;
  expect(r.status, JSON.stringify(r.body)).toBe(status);
  return r.body as T;
}
const board = (query = 'tab=all') => ok<DispatchBoard>(api(ctx.app, keeper, 'GET', `/api/inventory/dispatch?${query}`));
const rowOf = async (lineId: number, query = 'tab=all') => (await board(query)).rows.find((r) => r.lineId === lineId);
const issue = (lineId: number, qtyMilli: number, key = randomUUID(), cookie = keeper) =>
  api(ctx.app, cookie, 'POST', `/api/inventory/dispatch/lines/${lineId}/issue`, { clientKey: key, qtyMilli, note: '第二批到货' });
const central = async () => Number((await ctx.sql<{ s: number }[]>`SELECT stock_milli AS s FROM materials WHERE id = ${towel}`)[0]!.s);

async function submitTowels(qty: number, cookie = req): Promise<PurchaseRequest> {
  return (
    await ok<{ request: PurchaseRequest }>(
      api(ctx.app, cookie, 'POST', '/api/erp/requests', { clientKey: randomUUID(), lines: [{ materialId: towel, name: '发配毛巾', purpose: '客用消耗', qtyMilli: q(qty), unit: '条' }] }),
      201,
    )
  ).request;
}

/** 剩下的转采购单、确认、按合格数收货 */
async function buyAndReceive(lineId: number, qty: number, accepted = qty) {
  const po = (
    await ok<{ po: { id: number; lines: { id: number }[] } }>(
      api(ctx.app, buyer, 'POST', '/api/purchase-orders', {
        clientKey: randomUUID(),
        supplierId,
        orderDate: today,
        lines: [{ materialId: towel, purchaseQtyMilli: q(qty), priceCents: 1_000, requestLineIds: [lineId] }],
      }),
      201,
    )
  ).po;
  await ok(api(ctx.app, ctx.owner, 'POST', `/api/purchase-orders/${po.id}/approve`, {}));
  const rc = await ok<{ doc: { id: number; status: string } }>(
    api(ctx.app, keeper, 'POST', '/api/inventory/docs', {
      clientKey: randomUUID(),
      docType: 'receipt',
      docDate: today,
      supplierId,
      purchaseOrderId: po.id,
      lines: [{ materialId: towel, poLineId: po.lines[0]!.id, deliveredMilli: q(qty), acceptedMilli: q(accepted), rejectReason: accepted < qty ? '破损' : '' }],
    }),
    201,
  );
  if (rc.doc.status !== 'confirmed') await ok(api(ctx.app, ctx.owner, 'POST', `/api/inventory/docs/${rc.doc.id}/approve`, {}));
  return po;
}

beforeAll(async () => {
  ctx = await setup();
  today = todayIn(ctx.config.timezone);
  expect((await seedInventoryDemo(ctx.sql, ctx.config)).skipped).toBe(false);
  await ok(api(ctx.app, ctx.owner, 'PUT', '/api/inventory/purchase-rules', { stockCheckEnabled: true }));
  keeper = await login(ctx.app, 'lixiao', 'yuzu2026');
  buyer = await login(ctx.app, 'zhouyi', 'yuzu2026');
  await api(ctx.app, ctx.owner, 'POST', '/api/inventory/departments', { name: '客房布草' });
  deptId = ((await api(ctx.app, ctx.owner, 'GET', '/api/inventory/departments?all=1')).body as { id: number; name: string }[]).find((d) => d.name === '客房布草')!.id;
  reqId = await createStaff(ctx.sql, { username: 'dp_req', displayName: '布草阿珍', role: 'backoffice', duties: ['request'], departmentId: deptId, password: PASSWORD, mustChangePassword: false });
  req = await login(ctx.app, 'dp_req');
  towel = (
    await ok<{ id: number }>(api(ctx.app, ctx.owner, 'POST', '/api/inventory/materials', { code: 'DP-TW', name: '发配毛巾', inventoryUnit: '条', purchaseUnit: '条', purchaseFactorMilli: q(1) }), 201)
  ).id;
  await ok(
    api(ctx.app, ctx.owner, 'POST', '/api/inventory/docs', { clientKey: randomUUID(), docType: 'opening', docDate: today, approveNow: true, lines: [{ materialId: towel, qtyMilli: q(60) }] }),
    201,
  );
  const list = (await api(ctx.app, ctx.owner, 'POST', '/api/inventory/suppliers', { code: 'DP01', name: '发配测试供应商' })).body as { id: number; code: string }[];
  supplierId = list.find((x) => x.code === 'DP01')!.id;
}, 120_000);
afterAll(async () => ctx.close());

describe('分批发配：毛巾 100 条，先发 60，到货 40 再补发', () => {
  let lineId: number;
  let requestId: number;

  it('核库先发 60：部分发配，留在未完成；剩下的转采购、到货以后变成可发配；补发 40 以后已完成、通知申请人', async () => {
    const r = await submitTowels(100);
    lineId = r.lines[0]!.id;
    requestId = r.id;
    expect(r.stockCheck).toBe('pending');
    await ok(api(ctx.app, keeper, 'POST', `/api/erp/requests/${r.id}/stock-check`, { clientKey: randomUUID(), lines: [{ lineId, decision: 'issue', qtyMilli: q(60) }] }));
    // 审核以前不进发配记录（还没定要不要），但核库发的那一次已经记下
    const [rec] = await ctx.sql<{ qtyMilli: number; kind: string }[]>`SELECT qty_milli, kind FROM request_line_issues WHERE request_line_id = ${lineId}`;
    expect(rec).toMatchObject({ kind: 'stock' });
    expect(Number(rec!.qtyMilli)).toBe(q(60));
    await ok(api(ctx.app, buyer, 'POST', `/api/erp/requests/${r.id}/approve`, {}));

    let row = await rowOf(lineId, 'tab=open');
    expect(row).toMatchObject({ appliedMilli: q(100), issuedMilli: q(60), pendingMilli: q(40), availableMilli: 0, status: 'partial', departmentName: '客房布草', issueCount: 1 });
    expect(row!.lastIssue).toMatchObject({ kind: 'stock', qtyMilli: q(60) });
    // 部分发配不在已完成、也不在未发配申请
    expect(await rowOf(lineId, 'tab=done')).toBeUndefined();
    expect(await rowOf(lineId, 'tab=unissued')).toBeUndefined();
    // 还没到货：补发拦下（总仓没有）
    expect((await issue(lineId, q(40))).body.error.code).toBe('INSUFFICIENT_STOCK');

    // 采购 40、到货合格 40
    await buyAndReceive(lineId, 40);
    row = await rowOf(lineId, 'tab=open');
    expect(row).toMatchObject({ status: 'ready', availableMilli: q(40), pendingMilli: q(40), inTransitMilli: 0 });
    // 到货以后库管待办（ERP「库存」的角标）里有这一行
    expect((await ok<{ dispatchReady: number }>(api(ctx.app, keeper, 'GET', '/api/inventory/supply-todo'))).dispatchReady).toBeGreaterThanOrEqual(1);

    // 超过待发配量拒绝；部门申购补发不了
    expect((await issue(lineId, q(41))).body.error.code).toBe('DISPATCH_EXCEEDS');
    expect((await issue(lineId, q(10), randomUUID(), req)).status).toBe(403);

    const key = randomUUID();
    const done = await ok<DispatchDetail>(issue(lineId, q(40), key));
    expect(done.row).toMatchObject({ status: 'done', issuedMilli: q(100), pendingMilli: 0, issueCount: 2 });
    expect(done.issues.map((i) => [i.kind, i.qtyMilli])).toEqual([
      ['stock', q(60)],
      ['arrival', q(40)],
    ]);
    // 原样重提：不再发
    const stock = await central();
    await ok(issue(lineId, q(40), key));
    expect(await central()).toBe(stock);
    // 两次都关联同一张申请单与部门；领料单进了部门小仓
    const recs = await ctx.sql<{ requestId: number; departmentId: number; docType: string }[]>`
      SELECT i.request_id, i.department_id, d.doc_type FROM request_line_issues i JOIN inv_docs d ON d.id = i.inv_doc_id WHERE i.request_line_id = ${lineId}`;
    expect(recs.map((x) => [Number(x.requestId), Number(x.departmentId), x.docType])).toEqual([
      [requestId, deptId, 'issue'],
      [requestId, deptId, 'issue'],
    ]);
    // 转已完成、申请人收到通知
    expect(await rowOf(lineId, 'tab=open')).toBeUndefined();
    expect(await rowOf(lineId, 'tab=done')).toMatchObject({ status: 'done' });
    const [note] = await ctx.sql<{ title: string }[]>`SELECT title FROM oa_notifications WHERE staff_id = ${reqId} ORDER BY id DESC LIMIT 1`;
    expect(note!.title).toContain('已经发齐');
    expect((await issue(lineId, q(1))).body.error.code).toBe('DISPATCH_DONE');
  });

  it('时间筛选：今天、近一周、全部都查得到；页签计数；搜索按申请单号与部门', async () => {
    for (const range of ['today', 'week', 'month', 'all']) expect(await rowOf(lineId, `tab=done&range=${range}`), range).toBeDefined();
    const b = await board('tab=done&q=客房布草');
    expect(b.rows.some((r) => r.lineId === lineId)).toBe(true);
    expect(b.counts.done).toBeGreaterThanOrEqual(1);
    expect((await board('tab=done&q=不存在的部门')).rows).toEqual([]);
    expect((await board('tab=done&range=custom&from=2000-01-01&to=2000-01-02')).rows).toEqual([]);
  });

  it('先申请先给：同一物料两个部门在等，总仓只够一张时先提交的可发配；领料单作废以后那一次不算', async () => {
    const a = await submitTowels(5);
    const b = await submitTowels(5);
    // 总仓现在 0：都转采购
    for (const r of [a, b]) {
      if (r.stockCheck === 'pending')
        await ok(api(ctx.app, keeper, 'POST', `/api/erp/requests/${r.id}/stock-check`, { clientKey: randomUUID(), lines: [{ lineId: r.lines[0]!.id, decision: 'purchase' }] }));
      await ok(api(ctx.app, buyer, 'POST', `/api/erp/requests/${r.id}/approve`, {}));
    }
    expect((await rowOf(a.lines[0]!.id, 'tab=unissued'))!.status).toBe('pending');
    // 只到 5 条（挂在 b 的采购单上）：按提交先后，a 先可发
    await buyAndReceive(b.lines[0]!.id, 5);
    const rows = (await board('tab=unissued')).rows;
    const ra = rows.find((r) => r.lineId === a.lines[0]!.id)!;
    const rb = rows.find((r) => r.lineId === b.lines[0]!.id)!;
    expect([ra.status, ra.availableMilli]).toEqual(['ready', q(5)]);
    expect([rb.status, rb.availableMilli]).toEqual(['pending', 0]);
    // 可发配的置顶
    expect(rows.findIndex((r) => r.lineId === a.lines[0]!.id)).toBeLessThan(rows.findIndex((r) => r.lineId === b.lines[0]!.id));
    const done = await ok<DispatchDetail>(issue(a.lines[0]!.id, q(5)));
    expect(done.row.status).toBe('done');
    // 冲销那张领料单：这一次不算，回到未完成
    const docId = done.issues[0]!.docId;
    const voided = await api(ctx.app, ctx.owner, 'POST', `/api/inventory/docs/${docId}/void`, { reason: '发错了' });
    expect(voided.status, JSON.stringify(voided.body)).toBe(200);
    expect(await rowOf(a.lines[0]!.id, 'tab=open')).toMatchObject({ issuedMilli: 0, pendingMilli: q(5) });
  });
});
