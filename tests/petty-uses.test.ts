// 备用金申用（8.1.42，docs/V8142_PETTY.md；由 8.1.9 零采备用金的用例 petty-pool.test.ts 改过来，迁移 182 → 340）：
// 只有一个备用金——申用记在部门的备用金上：权限（看：查看报销或备用金申用；办：备用金申用）、没打款时没有可用、
// 申用占用与超额（可用 = 余额 − 已占用）、提交报销（未补单 / 已补单 + 采购单）、财务按申用登记报销（钱从备用金来、同一部门）
// → 确认后不再占用、余额少了这一笔 → 冲销后又占用 → 按「建议补足」打款回到定额、撤回与作废的拦截、同一笔申用不能挂两张有效报销单、
// 结果待确认、导出、自检。

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { todayIn } from '../src/server/modules/inventory/common';
import { pettyAccountChecks } from '../src/server/modules/petty-accounts';
import { createStaff } from '../src/server/modules/staff';
import { seedInventoryDemo } from '../src/server/seed-inventory';
import { api, login, PASSWORD, setup, type TestContext } from './helpers';

let ctx: TestContext;
let today: string;
let boss: string;
let buyer: string; // 采购经办 zhouyi：备用金申用
let keeper: string; // 物资经办 lixiao：只能看（查看报销与备用金）
let coster: string; // 成本核算：登记报销、打款
let approver: string; // 负责人：确认超门槛的报销
let outsider: string; // 前台：看不到
let buyerId: number;
let deptId: number;
let otherDeptId: number;
let advanceId: number;
let poId: number;
let poNo: string;
const use: Record<string, { id: number; version: number; docNo: string }> = {};

const board = async (cookie = buyer, query = '') => (await api(ctx.app, cookie, 'GET', `/api/erp/petty/uses?departmentId=${deptId}${query}`)).body;
const newUse = (body: Record<string, unknown> = {}, cookie = buyer, clientKey = randomUUID()) =>
  api(ctx.app, cookie, 'POST', '/api/erp/petty/uses', {
    clientKey,
    useDate: today,
    departmentId: deptId,
    applicantId: buyerId,
    purpose: '前台补货',
    content: '网购：一次性拖鞋 2 箱',
    amountCents: 30_000,
    ...body,
  });
const advance = (amountCents: number, departmentId = deptId) =>
  api(ctx.app, coster, 'POST', '/api/erp/petty/advances', {
    clientKey: randomUUID(),
    departmentId,
    handlerId: buyerId,
    advanceDate: today,
    amountCents,
    method: 'wechat',
    evidence: '转账尾号 0042',
  });
const claim = (body: Record<string, unknown> = {}, cookie = coster) =>
  api(ctx.app, cookie, 'POST', '/api/erp/expenses', {
    clientKey: randomUUID(),
    expenseDate: today,
    departmentId: deptId,
    handlerId: buyerId,
    purpose: '客用消耗',
    paySource: 'petty',
    advanceId,
    invoiceType: 'receipt',
    taxRateBp: 0,
    lines: [{ name: '一次性拖鞋', category: 'low_value', unit: '箱', boughtMilli: 2000, receivedMilli: 2000, amountCents: 28_000 }],
    ...body,
  });
const refresh = async (name: string) => {
  const u = (await api(ctx.app, buyer, 'GET', `/api/erp/petty/uses/${use[name]!.id}`)).body;
  use[name] = { id: u.id, version: u.version, docNo: u.docNo };
  return u;
};
const account = async () => (await api(ctx.app, coster, 'GET', '/api/erp/petty/accounts')).body.find((r: { department: { id: number } }) => r.department.id === deptId);

beforeAll(async () => {
  ctx = await setup();
  today = todayIn(ctx.config.timezone);
  expect((await seedInventoryDemo(ctx.sql, ctx.config)).skipped).toBe(false);
  boss = await login(ctx.app, 'linlan', 'yuzu2026');
  buyer = await login(ctx.app, 'zhouyi', 'yuzu2026');
  keeper = await login(ctx.app, 'lixiao', 'yuzu2026');
  buyerId = Number((await ctx.sql<{ id: number }[]>`SELECT id FROM staff WHERE username = 'zhouyi'`)[0]!.id);
  await createStaff(ctx.sql, { username: 'pu-cost', displayName: '成本岗', role: 'backoffice', duties: ['cost'], password: PASSWORD, mustChangePassword: false });
  await createStaff(ctx.sql, { username: 'pu-appr', displayName: '负责人', role: 'backoffice', duties: ['approve'], password: PASSWORD, mustChangePassword: false });
  await createStaff(ctx.sql, { username: 'pu-desk', displayName: '前台', role: 'clerk', password: PASSWORD, mustChangePassword: false });
  coster = await login(ctx.app, 'pu-cost');
  approver = await login(ctx.app, 'pu-appr');
  outsider = await login(ctx.app, 'pu-desk');
  await api(ctx.app, boss, 'POST', '/api/inventory/departments', { name: '供应链部' });
  await api(ctx.app, boss, 'POST', '/api/inventory/departments', { name: '工程部备用' });
  const depts = (await api(ctx.app, boss, 'GET', '/api/inventory/departments?all=1')).body as { id: number; name: string }[];
  deptId = depts.find((d) => d.name === '供应链部')!.id;
  otherDeptId = depts.find((d) => d.name === '工程部备用')!.id;
  const [po] = await ctx.sql<{ id: number; docNo: string }[]>`SELECT id, doc_no FROM purchase_orders WHERE status IN ('approved', 'closed') ORDER BY id LIMIT 1`;
  poId = Number(po!.id);
  poNo = po!.docNo;
}, 120_000);
afterAll(async () => ctx.close());

describe('备用金申用', () => {
  it('看：查看报销与备用金、或备用金申用；办：只有备用金申用（店主、采购）；前台看不到；只有一个「备用金」，没有零采备用金', async () => {
    expect((await api(ctx.app, outsider, 'GET', '/api/erp/petty/uses')).status).toBe(403);
    expect((await api(ctx.app, keeper, 'GET', '/api/erp/petty/uses')).status).toBe(200);
    expect((await api(ctx.app, coster, 'GET', '/api/erp/petty/uses')).status).toBe(200);
    expect((await api(ctx.app, buyer, 'GET', '/api/erp/petty/uses')).status).toBe(200);
    expect((await newUse({}, keeper)).status).toBe(403);
    expect((await newUse({}, coster)).status).toBe(403);
    // 原来零采备用金的接口没了
    expect((await api(ctx.app, boss, 'GET', '/api/erp/pool')).status).toBe(404);
    expect((await api(ctx.app, boss, 'GET', '/api/erp/pool/settings')).status).toBe(404);
    // 报销「钱从哪来」不能再写 pool
    expect((await claim({ paySource: 'pool', advanceId: null })).status).toBe(400);
  });

  it('部门还没有打款：余额 0、没有可用，不能申用；打款以后可用 = 余额', async () => {
    const b = await board();
    expect(b.department).toEqual({ id: deptId, name: '供应链部' });
    expect(b.summary).toMatchObject({ limitCents: null, balanceCents: 0, occupiedCents: 0, availableCents: 0, pendingCount: 0 });
    expect((await newUse()).body.error.code).toBe('PETTY_EXCEEDED');
    // 采购设不了定额（登记备用金打款、退回、补付的权限）
    expect((await api(ctx.app, buyer, 'PUT', `/api/erp/petty/accounts/${deptId}`, { custodianId: buyerId, limitCents: 500_000, note: '', version: 0 })).status).toBe(403);
    expect((await api(ctx.app, coster, 'PUT', `/api/erp/petty/accounts/${deptId}`, { custodianId: buyerId, limitCents: 500_000, note: '', version: 0 })).status).toBe(200);
    const a = await advance(500_000);
    expect(a.status, JSON.stringify(a.body)).toBe(201);
    advanceId = a.body.advance.id;
    expect((await board()).summary).toMatchObject({ limitCents: 500_000, balanceCents: 500_000, availableCents: 500_000, topUpCents: null });
    // 部门可以选：设了备用金的在名单里
    expect((await board()).departments.map((d: { id: number }) => d.id)).toContain(deptId);
  });

  it('申用即占用；超过可用拦下；同一编号原样重提只记一次', async () => {
    const key = randomUUID();
    const a = await newUse({}, buyer, key);
    expect(a.status, JSON.stringify(a.body)).toBe(201);
    expect(a.body.use).toMatchObject({ state: 'open', amountCents: 30_000, department: { id: deptId }, applicant: { id: buyerId }, backfill: null, claim: null });
    expect(a.body.use.docNo).toMatch(/^LC\d{8}-\d{4}$/);
    use.u1 = a.body.use;
    expect((await newUse({}, buyer, key)).body).toMatchObject({ replayed: true, use: { id: a.body.use.id } });
    expect((await newUse({ amountCents: 31_000 }, buyer, key)).body.error.code).toBe('IDEMPOTENCY_CONFLICT');
    const b = await newUse({ amountCents: 250_000, content: '网购：前台电脑一台' });
    use.u2 = b.body.use;
    const over = await newUse({ amountCents: 300_000 });
    expect(over.body.error).toMatchObject({ code: 'PETTY_EXCEEDED', details: { availableCents: 220_000 } });
    expect((await newUse({ useDate: '2999-01-01' })).body.error.code).toBe('FUTURE_DATE');
    // 别的部门没有打款：不能申用
    expect((await newUse({ departmentId: otherDeptId, amountCents: 100 })).body.error.code).toBe('PETTY_EXCEEDED');
    use.u3 = (await newUse({ amountCents: 10_000, content: '网购：抹布' })).body.use;
    expect((await board()).summary).toMatchObject({ balanceCents: 500_000, occupiedCents: 290_000, availableCents: 210_000, pendingCount: 3 });
    // 部门备用金那一行也写出占用与可用
    expect(await account()).toMatchObject({ balanceCents: 500_000, occupiedCents: 290_000, availableCents: 210_000 });
  });

  it('提交报销：已补单要选已确认的采购单，未补单不选；版本号对不上拒绝；原样重提直接返回', async () => {
    const submit = (name: string, body: Record<string, unknown>) => api(ctx.app, buyer, 'POST', `/api/erp/petty/uses/${use[name]!.id}/submit`, { version: use[name]!.version, ...body });
    expect((await submit('u2', { backfill: 'done' })).body.error.code).toBe('PO_REQUIRED');
    expect((await submit('u1', { backfill: 'pending', purchaseOrderId: poId })).status).toBe(400);
    expect((await api(ctx.app, buyer, 'POST', `/api/erp/petty/uses/${use.u1!.id}/submit`, { version: 99, backfill: 'pending' })).body.error.code).toBe('VERSION_CONFLICT');
    const ok1 = await submit('u1', { backfill: 'pending', note: '发票随后补' });
    expect(ok1.body).toMatchObject({ state: 'submitted', backfill: 'pending', purchaseOrder: null, submitNote: '发票随后补' });
    expect((await submit('u1', { backfill: 'pending', note: '发票随后补' })).status).toBe(200);
    expect((await submit('u1', { backfill: 'done', purchaseOrderId: poId })).body.error.code).toBe('ALREADY_SUBMITTED');
    const ok2 = await submit('u2', { backfill: 'done', purchaseOrderId: poId });
    expect(ok2.body).toMatchObject({ state: 'submitted', backfill: 'done', purchaseOrder: { id: poId, docNo: poNo } });
    await refresh('u1');
    await refresh('u2');
    const options = (await api(ctx.app, buyer, 'GET', `/api/erp/petty/uses/po-options?q=${encodeURIComponent(poNo)}`)).body;
    expect(options.map((o: { id: number }) => o.id)).toContain(poId);
    expect(options.every((o: { status: string }) => ['approved', 'closed'].includes(o.status))).toBe(true);
    expect((await board()).summary.byState).toMatchObject({ open: { count: 1, cents: 10_000 }, submitted: { count: 2, cents: 280_000 } });
  });

  it('财务登记报销（钱从备用金来、勾申用）：确认后不再占用、余额少了这一笔；冲销后又占用；按建议补足打款回到定额', async () => {
    expect((await api(ctx.app, buyer, 'GET', `/api/erp/expenses/petty-uses?departmentId=${deptId}`)).status).toBe(403);
    const list = (await api(ctx.app, coster, 'GET', `/api/erp/expenses/petty-uses?departmentId=${deptId}`)).body;
    expect(list.map((u: { id: number }) => u.id).sort()).toEqual([use.u1!.id, use.u2!.id].sort());
    expect(list.find((u: { id: number }) => u.id === use.u2!.id)).toMatchObject({ departmentId: deptId, backfill: 'done', purchaseOrderId: poId, poNo });
    expect((await api(ctx.app, coster, 'GET', `/api/erp/expenses/petty-uses?departmentId=${otherDeptId}`)).body).toEqual([]);
    // 互校：公司直付不能勾申用；没提交的、别的部门的不能报
    expect((await claim({ paySource: 'company', advanceId: null, useIds: [use.u1!.id] })).status).toBe(400);
    expect((await claim({ useIds: [use.u3!.id] })).body.error.code).toBe('PETTY_USE_NOT_SUBMITTED');
    expect((await claim({ departmentId: otherDeptId, useIds: [use.u1!.id] })).body.error.code).toBe('PETTY_USE_DEPARTMENT_MISMATCH');
    expect((await claim({ useIds: [use.u1!.id] }, buyer)).status).toBe(403);
    // 门槛以内：登记即确认 → u1 不再占用；余额少了实际报销的 ¥280
    const a = await claim({ useIds: [use.u1!.id] });
    expect(a.status, JSON.stringify(a.body)).toBe(201);
    expect(a.body.claim).toMatchObject({ status: 'confirmed', paySource: 'petty', advance: { id: advanceId }, uses: [{ id: use.u1!.id, docNo: use.u1!.docNo, amountCents: 30_000 }] });
    expect((await refresh('u1')).state).toBe('reimbursed');
    expect((await board()).summary).toMatchObject({
      balanceCents: 472_000,
      occupiedCents: 260_000,
      availableCents: 212_000,
      topUpCents: 28_000,
      pendingCount: 2,
      reimbursedThisMonth: { count: 1, cents: 30_000 },
    });
    // 没勾申用的备用金报销照旧能登记
    const plain = await claim({ lines: [{ name: '打印纸', category: 'office', unit: '包', boughtMilli: 1000, receivedMilli: 1000, amountCents: 1_000 }] });
    expect(plain.body.claim).toMatchObject({ status: 'confirmed', paySource: 'petty', uses: [] });
    // 超门槛（¥2,000）：待确认 → 审核中，仍占用
    const b = await claim({ useIds: [use.u2!.id], lines: [{ name: '前台电脑', category: 'fixed_asset', unit: '台', boughtMilli: 1000, receivedMilli: 1000, amountCents: 249_900 }] });
    expect(b.body.claim.status).toBe('submitted');
    expect((await refresh('u2')).state).toBe('reviewing');
    expect((await claim({ useIds: [use.u2!.id] })).body.error.code).toBe('PETTY_USE_CLAIMED');
    expect((await api(ctx.app, buyer, 'POST', `/api/erp/petty/uses/${use.u2!.id}/unsubmit`, { version: use.u2!.version })).body.error.code).toBe('CLAIM_ACTIVE');
    expect((await api(ctx.app, buyer, 'POST', `/api/erp/petty/uses/${use.u2!.id}/void`, { version: use.u2!.version, reason: '买错了' })).body.error.code).toBe('CLAIM_ACTIVE');
    expect((await board()).summary.byState.reviewing).toEqual({ count: 1, cents: 250_000 });
    expect((await api(ctx.app, approver, 'POST', `/api/erp/expenses/${b.body.claim.id}/approve`, {})).body.status).toBe('confirmed');
    expect((await refresh('u2')).state).toBe('reimbursed');
    expect((await board()).summary).toMatchObject({ balanceCents: 221_100, occupiedCents: 10_000, availableCents: 211_100, pendingCount: 1 });
    // 采购台账：勾申用的报销就是「备用金」的支出（没有单独的零采一栏）
    const ledger = (await api(ctx.app, ctx.owner, 'GET', `/api/erp/ledger?from=${today}&to=${today}`)).body;
    expect(ledger.totals.pettySpentCents).toBe(28_000 + 1_000 + 249_900);
    expect(ledger.totals).not.toHaveProperty('poolSpentCents');
    const ledgerCsv = String((await api(ctx.app, ctx.owner, 'GET', `/api/erp/ledger/export?from=${today}&to=${today}`)).body);
    expect(ledgerCsv).not.toContain('零采备用金');
    // 财务冲销 u1 的报销单 → u1 回到「已提交报销」，又占用；余额加回来
    expect((await api(ctx.app, coster, 'POST', `/api/erp/expenses/${a.body.claim.id}/void`, { reason: '发票有误重开' })).body.status).toBe('voided');
    const u1 = await refresh('u1');
    expect(u1).toMatchObject({ state: 'submitted', claim: null });
    expect(u1.claims.map((c: { status: string }) => c.status)).toEqual(['voided']);
    const s = (await board()).summary;
    expect(s).toMatchObject({ balanceCents: 249_100, occupiedCents: 40_000, availableCents: 209_100, topUpCents: 250_900 });
    expect((await api(ctx.app, coster, 'GET', `/api/erp/expenses/petty-uses?departmentId=${deptId}`)).body.map((u: { id: number }) => u.id)).toEqual([use.u1!.id]);
    // 回补：按建议补足打款，余额回到定额
    expect((await advance(s.topUpCents)).status).toBe(201);
    expect((await board()).summary).toMatchObject({ balanceCents: 500_000, availableCents: 460_000, topUpCents: null });
    // 台账与平账一致（部门备用金自检）
    expect((await pettyAccountChecks(ctx.sql))[0]).toMatchObject({ key: 'petty_accounts', ok: true });
    expect((await board(buyer, '&state=reimbursed')).uses.map((u: { id: number }) => u.id)).toEqual([use.u2!.id]);
  });

  it('更新补单（已报销的也能改）；撤回报销；作废以后不再占用', async () => {
    const u2 = await api(ctx.app, buyer, 'POST', `/api/erp/petty/uses/${use.u2!.id}/backfill`, { version: use.u2!.version, backfill: 'pending' });
    expect(u2.body).toMatchObject({ state: 'reimbursed', backfill: 'pending', purchaseOrder: null });
    await refresh('u2');
    const u1 = await api(ctx.app, buyer, 'POST', `/api/erp/petty/uses/${use.u1!.id}/backfill`, { version: use.u1!.version, backfill: 'done', purchaseOrderId: poId });
    expect(u1.body).toMatchObject({ state: 'submitted', backfill: 'done', purchaseOrder: { id: poId } });
    await refresh('u1');
    const back = await api(ctx.app, buyer, 'POST', `/api/erp/petty/uses/${use.u1!.id}/unsubmit`, { version: use.u1!.version });
    expect(back.body).toMatchObject({ state: 'open', backfill: 'done' });
    await refresh('u1');
    expect((await api(ctx.app, buyer, 'POST', `/api/erp/petty/uses/${use.u3!.id}/void`, { version: use.u3!.version, reason: 'x' })).status).toBe(400);
    const v = await api(ctx.app, buyer, 'POST', `/api/erp/petty/uses/${use.u3!.id}/void`, { version: use.u3!.version, reason: '不买了' });
    expect(v.body).toMatchObject({ state: 'voided', voidReason: '不买了' });
    expect((await board()).summary).toMatchObject({ occupiedCents: 30_000, pendingCount: 1 });
    expect((await api(ctx.app, buyer, 'POST', `/api/erp/petty/uses/${use.u3!.id}/submit`, { version: v.body.version, backfill: 'pending' })).body.error.code).toBe('USE_VOIDED');
    // 登记后内容（含部门）不能改（触发器兜底）
    await expect(ctx.sql`UPDATE petty_uses SET amount_cents = 1 WHERE id = ${use.u1!.id}`).rejects.toThrow();
    await expect(ctx.sql`UPDATE petty_uses SET department_id = ${otherDeptId} WHERE id = ${use.u1!.id}`).rejects.toThrow();
    await expect(ctx.sql`DELETE FROM petty_uses WHERE id = ${use.u1!.id}`).rejects.toThrow();
  });

  it('结果待确认：查回、作废以后原请求不再登记', async () => {
    const key = randomUUID();
    expect((await newUse({}, buyer, key)).status).toBe(201);
    expect((await api(ctx.app, buyer, 'GET', `/api/erp/ops/${key}?type=petty_use`)).body).toMatchObject({ found: true });
    const lost = randomUUID();
    expect((await api(ctx.app, keeper, 'POST', `/api/erp/ops/${lost}/abandon`, { type: 'petty_use' })).status).toBe(403);
    expect((await api(ctx.app, buyer, 'POST', `/api/erp/ops/${lost}/abandon`, { type: 'petty_use' })).body).toMatchObject({ found: false, abandoned: true });
    expect((await newUse({}, buyer, lost)).body.error.code).toBe('OP_ABANDONED');
    expect((await api(ctx.app, buyer, 'GET', `/api/erp/petty/uses/by-key/${key}`)).body.state).toBe('open');
  });

  it('导出台账；自检「备用金申用一致」', async () => {
    const csv = await api(ctx.app, buyer, 'GET', `/api/erp/petty/uses/export?departmentId=${deptId}`);
    expect(csv.status).toBe(200);
    expect(String(csv.body)).toContain('申用金额（元）');
    expect(String(csv.body)).toContain(use.u2!.docNo);
    expect(String(csv.body)).toContain('供应链部');
    const checks = (await api(ctx.app, boss, 'GET', '/api/erp/expenses/checks')).body;
    expect(checks.find((c: { key: string }) => c.key === 'petty_uses')).toMatchObject({ ok: true });
    // 人为挂错：公司直付的报销单挂申用 → 自检报出来
    const other = await claim({
      paySource: 'company',
      advanceId: null,
      purpose: '办公',
      lines: [{ name: '打印纸', category: 'office', unit: '包', boughtMilli: 1000, receivedMilli: 1000, amountCents: 3_000 }],
    });
    await ctx.sql`INSERT INTO expense_claim_petty_uses (claim_id, use_id) VALUES (${other.body.claim.id}, ${use.u3!.id})`;
    const bad = (await api(ctx.app, boss, 'GET', '/api/erp/expenses/checks')).body.find((c: { key: string }) => c.key === 'petty_uses');
    expect(bad.ok).toBe(false);
    expect(bad.detail).toContain('不是备用金的报销单挂了申用');
  });
});
