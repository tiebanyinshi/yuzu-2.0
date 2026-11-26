// 8.1.44 收银台（docs/V8144_CASHIER.md）：
//   · 前台备注：记经办人与时间、同组 / 单人、可带标签；同一操作编号重提只记一条，内容对不上拒绝；只追加，撤下留原因；
//     手牌板带出标签（收银台清单标「客诉」）；权限：有发牌或结账权限的都能写，撤下限写的人或值班经理及以上；
//   · 买角代号：前台规则里的 buyCodes（默认空），只有店主能改，代号 1–4 位数字、不重复，项目要在售、有那一档价格；
//   · 接待发牌不带票种时照旧用默认票种（发卡台去掉「选择套餐」后的发牌请求），带票种的旧请求照旧能用。

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FrontdeskBoard, FrontdeskRules, VisitDetail } from '../src/shared/frontdesk';
import { DEFAULT_DICTIONARIES } from '../src/shared/custom-fields';
import { createStaff } from '../src/server/modules/staff';
import { api, login, PASSWORD, setup, type TestContext } from './helpers';

let ctx: TestContext;
let tagNo = 0;
let duty = '';
let itemId = 0;

const enter = async (n = 1) => {
  const guests = Array.from({ length: n }, () => {
    tagNo += 1;
    return { tagCode: `R${String(tagNo).padStart(3, '0')}`, zone: 'male' as const };
  });
  const r = await api(ctx.app, ctx.clerk, 'POST', '/api/frontdesk/checkins', { clientKey: randomUUID(), guests });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.visits as { id: number; tagCode: string }[];
};
const remark = (who: string, visitId: number, body: Record<string, unknown>) =>
  api<VisitDetail>(ctx.app, who, 'POST', `/api/frontdesk/visits/${visitId}/remarks`, { clientKey: randomUUID(), ...body });

beforeAll(async () => {
  ctx = await setup();
  expect((await api(ctx.app, ctx.owner, 'POST', '/api/frontdesk/tags/batch', { prefix: 'R', from: 1, to: 30, width: 3, zone: 'male' })).status).toBe(200);
  await createStaff(ctx.sql, { username: 'rduty', displayName: '值班甲', role: 'duty_manager', password: PASSWORD, mustChangePassword: false });
  duty = await login(ctx.app, 'rduty');
  const a = await api(ctx.app, ctx.owner, 'POST', '/api/items', { name: '买角茶水', category: '水吧', price: 1800 });
  itemId = a.body.items.find((i: { name: string }) => i.name === '买角茶水').id;
});
afterAll(async () => {
  await ctx?.close();
});

describe('前台备注：同组 / 单人，记经办人与时间', () => {
  it('单人备注写在这位客人上，带标签与经办人；默认标签清单是「客诉」「特殊关照」', async () => {
    expect(DEFAULT_DICTIONARIES.remarkTags).toEqual(['客诉', '特殊关照']);
    const [v] = await enter();
    const r = await remark(ctx.clerk, v!.id, { scope: 'single', tag: '客诉', note: '嫌水温低，已安排调高' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.remarks).toEqual([
      expect.objectContaining({ scope: 'single', tag: '客诉', note: '嫌水温低，已安排调高', tagCode: v!.tagCode, groupNo: null, createdByName: '测试店员', removed: null }),
    ]);
    expect(r.body.remarks[0]!.createdAt).toBeTruthy();
    // 手牌板带出标签（收银台清单标出来）
    const board = (await api<FrontdeskBoard>(ctx.app, ctx.clerk, 'GET', '/api/frontdesk/board')).body;
    expect(board.tags.find((t) => t.code === v!.tagCode)!.visit!.remarkTags).toEqual(['客诉']);
    // 经办记录：审计里记了是谁写的
    const [audit] = await ctx.sql<{ staffId: number; detail: { note: string; scope: string } }[]>`
      SELECT staff_id, detail FROM audit_logs WHERE action = 'visit_remark' AND target_id = ${String(v!.id)}`;
    expect(audit).toMatchObject({ staffId: ctx.clerkId, detail: { note: '嫌水温低，已安排调高', scope: 'single' } });
  });

  it('同组备注整组都看得到，单人备注只在那一位上；没有同行的不能写同组备注', async () => {
    const [lone] = await enter();
    const solo = await remark(ctx.clerk, lone!.id, { scope: 'group', note: '整组说明' });
    expect(solo.status).toBe(422);
    expect((solo.body as unknown as { error: { code: string } }).error.code).toBe('NO_GROUP');
    // 一次接待两位：自动成一个同行组
    const [a, b] = await enter(2);
    const g = await remark(ctx.clerk, a!.id, { scope: 'group', tag: '特殊关照', note: '一家人，老人行动不便' });
    expect(g.status, JSON.stringify(g.body)).toBe(200);
    expect((await remark(ctx.clerk, a!.id, { scope: 'single', note: '只这位要无糖' })).status).toBe(200);
    const vb = (await api<VisitDetail>(ctx.app, ctx.clerk, 'GET', `/api/frontdesk/visits/${b!.id}`)).body;
    expect(vb.remarks.map((r) => [r.scope, r.note, r.tagCode])).toEqual([['group', '一家人，老人行动不便', a!.tagCode]]);
    expect(vb.remarks[0]!.groupNo).toBe(vb.group!.groupNo);
    const va = (await api<VisitDetail>(ctx.app, ctx.clerk, 'GET', `/api/frontdesk/visits/${a!.id}`)).body;
    expect(va.remarks.map((r) => r.scope)).toEqual(['group', 'single']);
    const board = (await api<FrontdeskBoard>(ctx.app, ctx.clerk, 'GET', '/api/frontdesk/board')).body;
    expect(board.tags.find((t) => t.code === b!.tagCode)!.visit!.remarkTags).toEqual(['特殊关照']);
  });

  it('同一个操作编号原样重提只记一条；内容对不上拒绝；空备注、超长标签拒绝', async () => {
    const [v] = await enter();
    const key = randomUUID();
    const body = { clientKey: key, scope: 'single', note: '同一条' };
    expect((await api(ctx.app, ctx.clerk, 'POST', `/api/frontdesk/visits/${v!.id}/remarks`, body)).status).toBe(200);
    const again = await api<VisitDetail>(ctx.app, ctx.clerk, 'POST', `/api/frontdesk/visits/${v!.id}/remarks`, body);
    expect(again.status).toBe(200);
    expect(again.body.remarks).toHaveLength(1);
    const changed = await api(ctx.app, ctx.clerk, 'POST', `/api/frontdesk/visits/${v!.id}/remarks`, { ...body, note: '改了内容' });
    expect(changed.status).toBe(409);
    expect((await remark(ctx.clerk, v!.id, { scope: 'single', note: '  ' })).status).toBe(400);
    expect((await remark(ctx.clerk, v!.id, { scope: 'single', tag: '一'.repeat(21), note: '标签太长' })).status).toBe(400);
  });

  it('撤下：写的人自己或值班经理及以上，要原因，只能撤一次；撤下的照旧留着、标签不再算；备注表只追加', async () => {
    const [v] = await enter();
    const r = await remark(duty, v!.id, { scope: 'single', tag: '客诉', note: '值班经理记的客诉' });
    const id = r.body.remarks[0]!.id;
    // 店员不是写的人、也没有更正权限
    expect((await api(ctx.app, ctx.clerk, 'POST', `/api/frontdesk/remarks/${id}/remove`, { visitId: v!.id, reason: '写错客人' })).status).toBe(403);
    expect((await api(ctx.app, duty, 'POST', `/api/frontdesk/remarks/${id}/remove`, { visitId: v!.id, reason: '' })).status).toBe(400);
    const ok = await api<VisitDetail>(ctx.app, duty, 'POST', `/api/frontdesk/remarks/${id}/remove`, { visitId: v!.id, reason: '写错客人' });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.remarks[0]!.removed).toMatchObject({ byName: '值班甲', reason: '写错客人' });
    expect((await api(ctx.app, duty, 'POST', `/api/frontdesk/remarks/${id}/remove`, { visitId: v!.id, reason: '再撤一次' })).status).toBe(409);
    const board = (await api<FrontdeskBoard>(ctx.app, ctx.clerk, 'GET', '/api/frontdesk/board')).body;
    expect(board.tags.find((t) => t.code === v!.tagCode)!.visit!.remarkTags).toEqual([]);
    await expect(ctx.sql`UPDATE visit_remarks SET note = '改掉' WHERE id = ${id}`).rejects.toThrow();
    await expect(ctx.sql`DELETE FROM visit_remark_removals WHERE remark_id = ${id}`).rejects.toThrow();
  });

  it('没有前台权限的岗位不能写', async () => {
    await createStaff(ctx.sql, { username: 'rkitchen', displayName: '后厨乙', role: 'backoffice', password: PASSWORD, mustChangePassword: false });
    const kitchen = await login(ctx.app, 'rkitchen');
    const [v] = await enter();
    expect((await remark(kitchen, v!.id, { scope: 'single', note: '后厨写的' })).status).toBe(403);
  });
});

describe('买角代号（前台规则 buyCodes）', () => {
  it('默认没有代号；只有店主能改；代号格式、重复、项目在售都核对；看板带给收银台', async () => {
    const get = async () => (await api<FrontdeskRules>(ctx.app, ctx.clerk, 'GET', '/api/frontdesk/rules')).body;
    expect((await get()).buyCodes).toEqual([]);
    const put = (who: string, buyCodes: unknown) => api(ctx.app, who, 'PUT', '/api/frontdesk/rules', { buyCodes });
    expect((await put(ctx.clerk, [{ code: '8', itemId, tier: 'standard' }])).status).toBe(403);
    expect((await put(ctx.owner, [{ code: '12345', itemId, tier: 'standard' }])).status).toBe(400);
    expect((await put(ctx.owner, [{ code: 'A1', itemId, tier: 'standard' }])).status).toBe(400);
    expect(
      (
        await put(ctx.owner, [
          { code: '8', itemId, tier: 'standard' },
          { code: '8', itemId, tier: 'standard' },
        ])
      ).status,
    ).toBe(400);
    expect((await put(ctx.owner, [{ code: '8', itemId, tier: 'premium' }])).status).toBe(400);
    expect((await put(ctx.owner, [{ code: '8', itemId: 999999, tier: 'standard' }])).status).toBe(400);
    const ok = await put(ctx.owner, [{ code: '8', itemId, tier: 'standard' }]);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect((await get()).buyCodes).toEqual([{ code: '8', itemId, tier: 'standard' }]);
    // 只改别的规则不动代号
    expect((await api(ctx.app, ctx.owner, 'PUT', '/api/frontdesk/rules', { selfVoidMinutes: 15 })).status).toBe(200);
    const board = (await api<FrontdeskBoard>(ctx.app, ctx.clerk, 'GET', '/api/frontdesk/board')).body;
    expect(board.rules.buyCodes).toEqual([{ code: '8', itemId, tier: 'standard' }]);
  });
});

describe('接待发牌不选票种（发卡台去掉「选择套餐」）', () => {
  it('不带票种按默认票种发牌；带票种的旧请求照旧可用', async () => {
    const [v] = await enter();
    const d = (await api<VisitDetail>(ctx.app, ctx.clerk, 'GET', `/api/frontdesk/visits/${v!.id}`)).body;
    const types = (await api<{ id: number; isDefault: boolean }[]>(ctx.app, ctx.clerk, 'GET', '/api/frontdesk/ticket-types')).body;
    expect(d.ticket?.typeId).toBe(types.find((t) => t.isDefault)!.id);
    tagNo += 1;
    const withType = await api(ctx.app, ctx.clerk, 'POST', '/api/frontdesk/checkins', {
      clientKey: randomUUID(),
      guests: [{ tagCode: `R${String(tagNo).padStart(3, '0')}`, zone: 'male', ticketTypeId: types.find((t) => t.isDefault)!.id }],
    });
    expect(withType.status, JSON.stringify(withType.body)).toBe(201);
  });
});
