// 采购商城 v0.2（8.2.6，docs/MALL_V826.md）：退回逐项标「本次必补」、仅补必补项 / 重新填写、版本快照、终止申购。
// 需求变更文档 v0.2 第 10 章用例 A（定制 + 退回补资料，验证「不是直接终止」）与用例 C（终止）。

import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { todayIn } from '../src/server/modules/inventory/common';
import { createStaff } from '../src/server/modules/staff';
import { seedInventoryDemo } from '../src/server/seed-inventory';
import { shiftDate } from '../src/shared/labels';
import { api, login, PASSWORD, setup, type TestContext } from './helpers';

let ctx: TestContext;
let boss: string;
let buyer: string;
let bar: string; // 水吧部申购
let barHead: string; // 水吧部主管
let other: string; // 别的部门
let storeId: number;
let entityId: number;
let today: string;
const q = (n: number) => Math.round(n * 1000);

interface Req {
  id: number;
  docNo: string;
  status: string;
  updatedAt: string;
  displayLabel: string;
  reason: string | null;
  deptConfirm: { state: string };
  sourcingOwner: { id: number } | null;
  lines: { id: number; name: string; qtyMilli: number; customSpec: Record<string, unknown> | null; imageIds: number[]; details: string }[];
  fixItems: { id: number; round: number; lineId: number | null; field: string; originalValue: string; suppliedValue: string | null; resolvedAt: string | null }[];
  versions: { versionNo: number; mode: string }[];
  termination: { status: string; reason: string } | null;
  can: { resubmit: boolean; terminate: 'direct' | 'request' | null; decideTermination: boolean };
  approvals: { action: string; reason: string }[];
}

const spec = (over: Record<string, unknown> = {}) => ({
  size: '面板 140 × 105 mm，底座 140 × 40 mm',
  material: '不锈钢 304',
  craft: '激光切割',
  scene: '水果吧台展示',
  sample: false,
  budgetCents: null,
  drawingUrl: 'https://example.com/v1.pdf',
  ...over,
});
const png = () => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), randomBytes(64)]).toString('base64');
const upload = async (cookie: string) => {
  const res = await api(ctx.app, cookie, 'POST', '/api/erp/images', { mime: 'image/png', data: png() });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.id as number;
};
const submit = (cookie: string, s: Record<string, unknown>, name = '水吧台展示立牌', imageIds: number[] = []) =>
  api(ctx.app, cookie, 'POST', '/api/erp/shop/requests', {
    clientKey: randomUUID(),
    storeId,
    entityId,
    contactName: '水吧小李',
    budgetProject: '水吧物料',
    needBy: shiftDate(today, 13),
    deliveryAddress: '总店水吧',
    paymentIntent: 'company_direct',
    priority: 'normal',
    note: '',
    kind: 'custom',
    line: { name, qtyMilli: q(12), unit: '件', details: '', reasonText: '水吧上新', customKind: 'custom', customSpec: s, imageIds },
  });
const detail = async (cookie: string, id: number) => (await api(ctx.app, cookie, 'GET', `/api/erp/shop/requests/${id}`)).body as Req;
const resubmit = (cookie: string, r: Req, over: Record<string, unknown>) =>
  api(ctx.app, cookie, 'PUT', `/api/erp/shop/requests/${r.id}/resubmit`, {
    clientKey: randomUUID(),
    expectedUpdatedAt: r.updatedAt,
    contactName: '水吧小李',
    budgetProject: '水吧物料',
    needBy: shiftDate(today, 13),
    deliveryAddress: '总店水吧',
    priority: 'normal',
    note: '',
    lines: r.lines.map((l) => ({ id: l.id, qtyMilli: l.qtyMilli })),
    ...over,
  });
/** 一张走到「待审核、核库完、主管确认过」的定制单 */
const ready = async (name: string, s = spec(), imageIds: number[] = []) => {
  const res = await submit(bar, s, name, imageIds);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  const r = res.body.request as Req;
  expect((await api(ctx.app, barHead, 'POST', `/api/erp/requests/${r.id}/dept-confirm`, {})).status).toBe(200);
  return detail(bar, r.id);
};

beforeAll(async () => {
  ctx = await setup();
  today = todayIn(ctx.config.timezone);
  expect((await seedInventoryDemo(ctx.sql, ctx.config)).skipped).toBe(false);
  boss = await login(ctx.app, 'linlan', 'yuzu2026');
  buyer = await login(ctx.app, 'zhouyi', 'yuzu2026');
  const mk = async (name: string) => {
    await api(ctx.app, boss, 'POST', '/api/inventory/departments', { name });
    return ((await api(ctx.app, boss, 'GET', '/api/inventory/departments?all=1')).body as { id: number; name: string }[]).find((d) => d.name === name)!.id;
  };
  const barDept = await mk('水吧部');
  const otherDept = await mk('工程部');
  await createStaff(ctx.sql, { username: 'fix_bar', displayName: '水吧申购', role: 'backoffice', duties: ['request'], departmentId: barDept, password: PASSWORD, mustChangePassword: false });
  await createStaff(ctx.sql, { username: 'fix_head', displayName: '水吧主管', role: 'backoffice', duties: ['request'], departmentId: barDept, password: PASSWORD, mustChangePassword: false });
  await createStaff(ctx.sql, { username: 'fix_other', displayName: '工程申购', role: 'backoffice', duties: ['request'], departmentId: otherDept, password: PASSWORD, mustChangePassword: false });
  await ctx.sql`UPDATE departments SET head_id = (SELECT id FROM staff WHERE username = 'fix_head') WHERE id = ${barDept}`;
  bar = await login(ctx.app, 'fix_bar');
  barHead = await login(ctx.app, 'fix_head');
  other = await login(ctx.app, 'fix_other');
  storeId = Number((await ctx.sql<{ id: number }[]>`SELECT id FROM stores ORDER BY id LIMIT 1`)[0]!.id);
  entityId = Number((await ctx.sql<{ id: number }[]>`SELECT id FROM legal_entities ORDER BY id LIMIT 1`)[0]!.id);
}, 120_000);
afterAll(async () => ctx.close());

describe('定制的必填（Q1）', () => {
  it('尺寸要带单位、材质要写、图纸文件或链接至少一项', async () => {
    expect((await submit(bar, spec({ size: '140 × 105' }))).body.error.code).toBe('CUSTOM_SIZE_UNIT');
    expect((await submit(bar, spec({ size: '' }))).body.error.code).toBe('CUSTOM_SIZE_REQUIRED');
    expect((await submit(bar, spec({ material: '' }))).body.error.code).toBe('CUSTOM_MATERIAL_REQUIRED');
    expect((await submit(bar, spec({ drawingUrl: '' }))).body.error.code).toBe('CUSTOM_DRAWING_REQUIRED');
    expect((await submit(bar, spec({ drawingUrl: 'ftp://x' }))).body.error.code).toBe('LINK_INVALID');
    const ok = await submit(bar, spec({ tolerance: '±1 mm', color: '原色乱纹', designVersion: 'V1' }));
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    const line = ok.body.request.lines[0];
    expect(line.details).toContain('材质：不锈钢 304');
    expect(line.details).toContain('工艺要求：激光切割');
    expect(line.details).toContain('图纸链接：https://example.com/v1.pdf');
    expect(ok.body.request.versions).toMatchObject([{ versionNo: 1, mode: 'submit' }]);
  });
});

describe('用例 A：定制 + 退回补资料（不是直接终止）', () => {
  it('逐项标必补 → 仅补必补项（其余锁定、没补点名）→ 单号不变、V2、主管不再确认、BP 不变 → 再退回重新填写 V3', async () => {
    const r = await ready('展示立牌 A');
    expect(r.deptConfirm.state).toBe('confirmed');
    expect((await api(ctx.app, buyer, 'POST', `/api/erp/shop/requests/${r.id}/claim`, { clientKey: randomUUID() })).status).toBe(200);
    const lineId = r.lines[0]!.id;
    // 商城单退回不标必补：拦下
    expect((await api(ctx.app, buyer, 'POST', `/api/erp/requests/${r.id}/return`, { reason: '请补尺寸单位和定版图' })).body.error.code).toBe('FIX_ITEMS_REQUIRED');
    // 整张单的项不用选行、行上的项要选行
    expect((await api(ctx.app, buyer, 'POST', `/api/erp/requests/${r.id}/return`, { reason: '请补', fixItems: [{ lineId, field: 'needBy', requirement: 'x' }] })).body.error.code).toBe(
      'FIX_ITEM_INVALID',
    );
    const ret = await api(ctx.app, buyer, 'POST', `/api/erp/requests/${r.id}/return`, {
      reason: '请补尺寸单位和板材厚度，并提供可用于报价的定版图及版本',
      fixItems: [
        { lineId, field: 'spec.size', requirement: '写清面板和底座的尺寸单位，再注明板材厚度' },
        { lineId, field: 'spec.drawing', requirement: '添加图纸文件或可查看的链接' },
        { lineId, field: 'spec.designVersion', requirement: '填版本号，例如 V2 定版图' },
      ],
    });
    expect(ret.status, JSON.stringify(ret.body)).toBe(200);
    const back = await detail(bar, r.id);
    expect(back).toMatchObject({ status: 'returned', docNo: r.docNo, reason: '请补尺寸单位和板材厚度，并提供可用于报价的定版图及版本' });
    expect(back.can.resubmit).toBe(true);
    expect(back.can.terminate).toBe('request'); // 提单人：申请终止（用例 C 细看）
    expect(back.fixItems).toHaveLength(3);
    expect(back.fixItems.find((f) => f.field === 'spec.size')).toMatchObject({ round: 1, originalValue: '面板 140 × 105 mm，底座 140 × 40 mm', resolvedAt: null });
    expect(back.fixItems.find((f) => f.field === 'spec.drawing')!.originalValue).toContain('https://example.com/v1.pdf');

    const s0 = back.lines[0]!.customSpec!;
    const fixed = { ...s0, size: '面板 140 × 105 mm，底座 140 × 40 mm，板厚 3 mm', drawingUrl: 'https://example.com/v2.pdf', designVersion: 'V2 定版图' };
    // 改了没要求补的（名称、材质）：拦下
    expect((await resubmit(bar, back, { mode: 'fix', lines: [{ id: lineId, qtyMilli: q(12), name: '改名', customSpec: fixed }] })).body.error.code).toBe('FIELD_LOCKED');
    expect((await resubmit(bar, back, { mode: 'fix', lines: [{ id: lineId, qtyMilli: q(12), customSpec: { ...fixed, material: '铝' } }] })).body.error.code).toBe('FIELD_LOCKED');
    expect((await resubmit(bar, back, { mode: 'fix', lines: [{ id: lineId, qtyMilli: q(20), customSpec: fixed }] })).body.error.code).toBe('FIELD_LOCKED');
    expect((await resubmit(bar, back, { mode: 'fix', priority: 'high', lines: [{ id: lineId, qtyMilli: q(12), customSpec: fixed }] })).body.error.code).toBe('FIELD_LOCKED');
    // 漏了一项：点名
    const miss = await resubmit(bar, back, { mode: 'fix', lines: [{ id: lineId, qtyMilli: q(12), customSpec: { ...fixed, designVersion: '' } }] });
    expect(miss.body.error.code).toBe('FIX_ITEM_MISSING');
    expect(miss.body.error.message).toContain('设计版本');
    // 补齐：单号不变、回到待审核、V2、必补项记下补的内容；主管确认过的不再确认（Q4），接单的 BP 不变
    const ok = await resubmit(bar, back, { mode: 'fix', lines: [{ id: lineId, qtyMilli: q(12), customSpec: fixed }] });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    const v2 = ok.body as Req;
    expect(v2).toMatchObject({ id: r.id, docNo: r.docNo, status: 'submitted', reason: null });
    expect(v2.deptConfirm.state).toBe('confirmed');
    expect(v2.sourcingOwner).not.toBeNull();
    expect(v2.versions.map((v) => `${v.versionNo}:${v.mode}`)).toEqual(['1:submit', '2:fix']);
    expect(v2.fixItems.every((f) => f.resolvedAt)).toBe(true);
    expect(v2.fixItems.find((f) => f.field === 'spec.designVersion')!.suppliedValue).toBe('V2 定版图');
    expect(v2.lines[0]!.details).toContain('设计版本：V2 定版图');
    expect(v2.approvals.map((a) => `${a.action}:${a.reason}`)).toContain('revise:补必补项：补齐必补项：第 1 行 尺寸 / 规格；第 1 行 图纸文件或链接；第 1 行 设计版本');
    // 历史版本只读可查：V1 还是原来的尺寸
    const v1 = (await api(ctx.app, bar, 'GET', `/api/erp/shop/requests/${r.id}/versions/1`)).body;
    expect(v1.snapshot.lines[0].customSpec.size).toBe('面板 140 × 105 mm，底座 140 × 40 mm');
    expect((await api(ctx.app, other, 'GET', `/api/erp/shop/requests/${r.id}/versions/1`)).status).toBeGreaterThanOrEqual(403);

    // 可以多轮退回：第二轮标整张单的期望到货日；这次用「重新填写」，没标的也能改
    const ret2 = await api(ctx.app, buyer, 'POST', `/api/erp/requests/${r.id}/return`, { reason: '交期太紧', fixItems: [{ lineId: null, field: 'needBy', requirement: '往后挪一周' }] });
    expect(ret2.status, JSON.stringify(ret2.body)).toBe(200);
    const back2 = await detail(bar, r.id);
    expect(back2.fixItems.filter((f) => f.round === 2)).toHaveLength(1);
    expect((await resubmit(bar, back2, { mode: 'rewrite', needBy: shiftDate(today, 20) })).body.error.code).toBe('REMARK_REQUIRED');
    const rw = await resubmit(bar, back2, {
      mode: 'rewrite',
      needBy: shiftDate(today, 20),
      remark: '交期往后挪、数量改 10',
      lines: [{ id: lineId, qtyMilli: q(10), customKind: 'custom', customSpec: { ...fixed, sample: true } }],
    });
    expect(rw.status, JSON.stringify(rw.body)).toBe(200);
    const v3 = rw.body as Req;
    expect(v3.versions.map((v) => v.mode)).toEqual(['submit', 'fix', 'rewrite']);
    expect(v3.lines[0]!.qtyMilli).toBe(q(10));
    // 重新填写整张都能改：主管要重新确认，不沿用退回前的确认（Codex 审查）
    expect(v3.deptConfirm.state).toBe('pending');
    expect(v3.fixItems.find((f) => f.round === 2)).toMatchObject({ suppliedValue: shiftDate(today, 20) });
  });

  it('升级前提交的单（没有版本）第一次补资料：先补记原版本 V1', async () => {
    const r = await ready('展示立牌 旧单');
    await ctx.sql`DELETE FROM purchase_request_versions WHERE request_id = ${r.id}`;
    expect(
      (await api(ctx.app, buyer, 'POST', `/api/erp/requests/${r.id}/return`, { reason: '请补颜色', fixItems: [{ lineId: r.lines[0]!.id, field: 'spec.color', requirement: '写表面颜色' }] })).status,
    ).toBe(200);
    const back = await detail(bar, r.id);
    const ok = await resubmit(bar, back, { mode: 'fix', lines: [{ id: r.lines[0]!.id, qtyMilli: q(12), customSpec: { ...back.lines[0]!.customSpec, color: '哑光黑' } }] });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect((ok.body as Req).versions.map((v) => `${v.versionNo}:${v.mode}`)).toEqual(['1:baseline', '2:fix']);
  });
});

describe('Codex 审查修正', () => {
  it('图纸换一张图（张数不变、链接不变）算补了；原样不动照旧点名', async () => {
    const wrong = await upload(bar);
    const r = await ready('展示立牌 图纸', spec({ drawingUrl: '' }), [wrong]);
    const lineId = r.lines[0]!.id;
    const ret = await api(ctx.app, buyer, 'POST', `/api/erp/requests/${r.id}/return`, {
      reason: '图纸传错了',
      fixItems: [{ lineId, field: 'spec.drawing', requirement: '换成定版图' }],
    });
    expect(ret.status, JSON.stringify(ret.body)).toBe(200);
    const back = await detail(bar, r.id);
    const s0 = back.lines[0]!.customSpec!;
    // 原样不动：点名没补
    expect((await resubmit(bar, back, { mode: 'fix', lines: [{ id: lineId, qtyMilli: q(12), customSpec: s0, imageIds: [wrong] }] })).body.error.code).toBe('FIX_ITEM_MISSING');
    const right = await upload(bar);
    const ok = await resubmit(bar, back, { mode: 'fix', lines: [{ id: lineId, qtyMilli: q(12), customSpec: s0, imageIds: [right] }] });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect((ok.body as Req).lines[0]!.imageIds).toEqual([right]);
    expect((ok.body as Req).fixItems.every((f) => f.resolvedAt)).toBe(true);
  });

  it('从商城清单选的行只能标「数量」：标别的项退回时拦下（FIX_ITEM_NOT_EDITABLE）；非定制的行不能标定制要求', async () => {
    const r = await ready('选品立牌');
    const lineId = r.lines[0]!.id;
    // 当作选品的行（有 SKU）
    await ctx.sql`UPDATE purchase_request_lines SET mall_sku_code = 'FIX-SKU-1', custom_kind = NULL WHERE id = ${lineId}`;
    for (const field of ['details', 'name', 'images', 'spec.size']) {
      const res = await api(ctx.app, buyer, 'POST', `/api/erp/requests/${r.id}/return`, { reason: '请补', fixItems: [{ lineId, field, requirement: '补一下' }] });
      expect(res.status, field).toBe(422);
      expect(res.body.error.code, field).toBe('FIX_ITEM_NOT_EDITABLE');
    }
    // 非定制的自主申请行：没有定制要求可补
    await ctx.sql`UPDATE purchase_request_lines SET mall_sku_code = '', custom_kind = 'standard' WHERE id = ${lineId}`;
    expect((await api(ctx.app, buyer, 'POST', `/api/erp/requests/${r.id}/return`, { reason: '请补', fixItems: [{ lineId, field: 'spec.size', requirement: '补' }] })).body.error.code).toBe(
      'FIX_ITEM_NOT_EDITABLE',
    );
    await ctx.sql`UPDATE purchase_request_lines SET mall_sku_code = 'FIX-SKU-1', custom_kind = NULL WHERE id = ${lineId}`;
    const ok = await api(ctx.app, buyer, 'POST', `/api/erp/requests/${r.id}/return`, { reason: '数量不对', fixItems: [{ lineId, field: 'qty', requirement: '改成 10 件' }] });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
  });

  it('只补必补项：主管确认过的照旧不再确认；重新填写：主管重新确认', async () => {
    const r = await ready('展示立牌 重填');
    const lineId = r.lines[0]!.id;
    expect((await api(ctx.app, buyer, 'POST', `/api/erp/requests/${r.id}/return`, { reason: '请补', fixItems: [{ lineId, field: 'reasonText', requirement: '写清用途' }] })).status).toBe(200);
    const back = await detail(bar, r.id);
    expect(back.deptConfirm.state).toBe('confirmed');
    const rw = await resubmit(bar, back, { mode: 'rewrite', remark: '数量改大', lines: [{ id: lineId, qtyMilli: q(500), reasonText: '水吧全线上新' }] });
    expect(rw.status, JSON.stringify(rw.body)).toBe(200);
    expect((rw.body as Req).deptConfirm.state).toBe('pending');
    // 主管确认以后才进审核
    expect((await api(ctx.app, barHead, 'POST', `/api/erp/requests/${r.id}/dept-confirm`, {})).status).toBe(200);
    expect((await detail(bar, r.id)).deptConfirm.state).toBe('confirmed');
  });
});

describe('用例 C：终止该申购（Q5：部门负责人或 BP 确认）', () => {
  it('提单人申请 → 等确认；负责人驳回 → 照常；再申请 → BP 确认 → 已终止、不能再改', async () => {
    const r = await ready('展示立牌 C');
    expect((await api(ctx.app, buyer, 'POST', `/api/erp/requests/${r.id}/return`, { reason: '请补', fixItems: [{ lineId: null, field: 'note', requirement: '写用途' }] })).status).toBe(200);
    const back = await detail(bar, r.id);
    expect(back.can.terminate).toBe('request');
    // 别的部门不能终止
    expect((await api(ctx.app, other, 'POST', `/api/erp/shop/requests/${r.id}/terminate`, { clientKey: randomUUID(), reason: '不要了' })).status).toBe(403);
    const key = randomUUID();
    const asked = await api(ctx.app, bar, 'POST', `/api/erp/shop/requests/${r.id}/terminate`, { clientKey: key, reason: '活动取消' });
    expect(asked.status, JSON.stringify(asked.body)).toBe(200);
    expect(asked.body.result).toBe('pending');
    expect(asked.body.request.termination).toMatchObject({ status: 'pending', reason: '活动取消' });
    expect(asked.body.request.status).toBe('returned');
    // 原样重提认得；再申请拦下
    expect((await api(ctx.app, bar, 'POST', `/api/erp/shop/requests/${r.id}/terminate`, { clientKey: key, reason: '活动取消' })).body.result).toBe('pending');
    expect((await api(ctx.app, bar, 'POST', `/api/erp/shop/requests/${r.id}/terminate`, { clientKey: randomUUID(), reason: '活动取消' })).body.error.code).toBe('TERMINATION_PENDING');
    // 提单人不能自己确认；负责人看得到确认按钮，驳回
    expect((await api(ctx.app, bar, 'POST', `/api/erp/shop/requests/${r.id}/terminate/decide`, { approve: true })).status).toBe(403);
    expect((await detail(barHead, r.id)).can.decideTermination).toBe(true);
    const declined = await api(ctx.app, barHead, 'POST', `/api/erp/shop/requests/${r.id}/terminate/decide`, { approve: false, note: '先补资料' });
    expect(declined.status, JSON.stringify(declined.body)).toBe(200);
    expect(declined.body).toMatchObject({ status: 'returned', termination: { status: 'declined' } });
    // 再申请；BP 确认
    expect((await api(ctx.app, bar, 'POST', `/api/erp/shop/requests/${r.id}/terminate`, { clientKey: randomUUID(), reason: '确定不要了' })).body.result).toBe('pending');
    const done = await api(ctx.app, buyer, 'POST', `/api/erp/shop/requests/${r.id}/terminate/decide`, { approve: true });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    const end = done.body as Req;
    expect(end).toMatchObject({ status: 'cancelled', displayLabel: '已终止', reason: '终止：确定不要了', termination: { status: 'approved' } });
    expect(end.can).toMatchObject({ resubmit: false, terminate: null });
    expect((await resubmit(bar, end, { mode: 'rewrite', remark: 'x' })).body.error.code).toBe('INVALID_STATE');
    const n = await ctx.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM oa_notifications WHERE title LIKE ${`需求单 ${r.docNo}%`}`;
    expect(n[0]!.n).toBeGreaterThanOrEqual(3);
  });

  it('负责人自己点：直接终止；已通过的不能终止', async () => {
    const r = await ready('展示立牌 D');
    expect((await detail(barHead, r.id)).can.terminate).toBe('direct');
    const res = await api(ctx.app, barHead, 'POST', `/api/erp/shop/requests/${r.id}/terminate`, { clientKey: randomUUID(), reason: '重复申请' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ result: 'terminated', request: { status: 'cancelled', displayLabel: '已终止' } });
    expect((await api(ctx.app, barHead, 'POST', `/api/erp/shop/requests/${r.id}/terminate`, { clientKey: randomUUID(), reason: '重复申请' })).body.error.code).toBe('INVALID_STATE');
  });
});
