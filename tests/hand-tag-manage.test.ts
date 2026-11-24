// 手牌管理（店主 2026-11-24，docs/FRONTDESK_TAGS_V8127.md；迁移 260）：按规则批量生成（数量、起始号码、排除尾数 / 含某数字、不重号）、
// 改牌号、删除（发过的留着历史、标已删除）、柜子标「暂停使用 / 维修中」（前台发不出、改回正常就能发），在店的都不能动。

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { planTagCodes } from '../src/shared/frontdesk';
import { api, setup, type TestContext } from './helpers';

let ctx: TestContext;
beforeAll(async () => {
  ctx = await setup();
});
afterAll(async () => ctx.close());

type Tag = { id: number; code: string; zone: string; active: boolean; serviceStatus: string; serviceNote: string | null; inUse: boolean };
const tags = async () => (await api(ctx.app, ctx.owner, 'GET', '/api/frontdesk/tags')).body as Tag[];
const tagOf = async (code: string) => (await tags()).find((t) => t.code === code);
const generate = (body: object, cookie = ctx.owner) =>
  api(ctx.app, cookie, 'POST', '/api/frontdesk/tags/generate', { prefix: 'A', start: 1, count: 10, width: 3, zone: 'male', clientKey: randomUUID(), storeId: 1, ...body });
const checkin = (code: string, zone = 'male') => api(ctx.app, ctx.clerk, 'POST', '/api/frontdesk/checkins', { clientKey: randomUUID(), guests: [{ tagCode: code, zone }] });

describe('按规则批量生成', () => {
  it('规则（纯函数）：尾数是 4、7 的跳过；含 4 的跳过；已有的跳过、接着往后凑够数量；号码用完了就停', () => {
    const end = planTagCodes({ prefix: 'A', start: 1, count: 10, width: 3, skipEndDigits: [4, 7], skipAnyDigits: [] }, new Set());
    expect(end.codes).toEqual(['A001', 'A002', 'A003', 'A005', 'A006', 'A008', 'A009', 'A010', 'A011', 'A012']);
    expect(end.skippedByRule).toBe(2);
    const any = planTagCodes({ prefix: '', start: 38, count: 5, width: 2, skipEndDigits: [], skipAnyDigits: [4] }, new Set(['39']));
    expect(any.codes).toEqual(['38', '50', '51', '52', '53']);
    expect(any.skippedExisting).toEqual(['39']);
    // 按补零以后的号码判断：排除含 0 时 001–009 都跳过（Codex 审查 PR #189）
    expect(planTagCodes({ prefix: 'A', start: 1, count: 3, width: 3, skipEndDigits: [], skipAnyDigits: [0] }, new Set()).codes).toEqual(['A111', 'A112', 'A113']);
    const out = planTagCodes({ prefix: 'B', start: 97, count: 5, width: 2, skipEndDigits: [], skipAnyDigits: [] }, new Set());
    expect(out).toMatchObject({ codes: ['B97', 'B98', 'B99'], exhausted: true });
  });

  it('预览不建；生成 10 张男宾牌（跳过尾数 4、7），再生成一次接着往后、不重号；店员不能生成；把 0–9 都排除了拒绝', async () => {
    const pv = await generate({ skipEndDigits: [4, 7], preview: true });
    expect(pv.status, JSON.stringify(pv.body)).toBe(200);
    expect(pv.body).toMatchObject({ created: 0, codes: ['A001', 'A002', 'A003', 'A005', 'A006', 'A008', 'A009', 'A010', 'A011', 'A012'] });
    expect(await tags()).toHaveLength(0);
    const made = await generate({ skipEndDigits: [4, 7] });
    expect(made.body).toMatchObject({ created: 10 });
    const again = await generate({ skipEndDigits: [4, 7], count: 3 });
    expect(again.body.codes).toEqual(['A013', 'A015', 'A016']);
    expect(again.body.skippedExisting).toHaveLength(10);
    const all = await tags();
    expect(all).toHaveLength(13);
    expect(new Set(all.map((t) => t.code)).size).toBe(13);
    expect(all.some((t) => /[47]$/.test(t.code))).toBe(false);
    expect(all.every((t) => t.serviceStatus === 'normal')).toBe(true);
    expect((await generate({ preview: true }, ctx.clerk)).status).toBe(403);
    expect((await generate({ skipAnyDigits: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9] })).status).toBe(400);
    expect((await generate({ prefix: 'B', zone: 'female', count: 5 })).body).toMatchObject({ created: 5 });
  });

  it('操作编号：没带拒绝；原样重提返回第一次的牌号、不再建一批；同一编号换内容拒绝；确认作废过的编号不再写入', async () => {
    expect((await generate({ prefix: 'C', clientKey: undefined })).status).toBe(400);
    const key = randomUUID();
    const first = await generate({ prefix: 'C', count: 4, clientKey: key });
    expect(first.body).toMatchObject({ created: 4, replayed: false, codes: ['C001', 'C002', 'C003', 'C004'] });
    expect(typeof first.body.opId).toBe('number');
    const again = await generate({ prefix: 'C', count: 4, clientKey: key });
    expect(again.body).toMatchObject({ created: 4, replayed: true, opId: first.body.opId, codes: ['C001', 'C002', 'C003', 'C004'] });
    // 已经建了的不能再作废：作废接口返回查到了，之后原样重提照旧返回原来那批（Codex 审查 PR #191）
    expect((await api(ctx.app, ctx.owner, 'POST', `/api/erp/ops/${key}/abandon`, { type: 'hand_tag_generate', summary: '测试' })).body).toMatchObject({ found: true });
    expect((await generate({ prefix: 'C', count: 4, clientKey: key })).body).toMatchObject({ replayed: true, created: 4 });
    // 换了门店重提拒绝；没带门店拒绝
    expect((await generate({ prefix: 'E', count: 1, storeId: 999 })).body.error.code).toBe('STORE_MISMATCH');
    expect((await generate({ prefix: 'E', count: 1, storeId: undefined })).status).toBe(400);
    expect((await tags()).filter((t) => t.code.startsWith('C'))).toHaveLength(4);
    expect((await generate({ prefix: 'C', count: 5, clientKey: key })).body.error.code).toBe('IDEMPOTENCY_CONFLICT');
    const found = await api(ctx.app, ctx.owner, 'GET', `/api/erp/ops/${key}?type=hand_tag_generate`);
    expect(found.body).toMatchObject({ found: true });
    // 作废在先：原请求晚到不写入
    const late = randomUUID();
    expect((await api(ctx.app, ctx.owner, 'POST', `/api/erp/ops/${late}/abandon`, { type: 'hand_tag_generate', summary: '测试' })).status).toBe(200);
    expect((await generate({ prefix: 'D', count: 2, clientKey: late })).body.error.code).toBe('OP_ABANDONED');
    expect((await tags()).some((t) => t.code.startsWith('D'))).toBe(false);
    expect((await api(ctx.app, ctx.clerk, 'GET', `/api/erp/ops/${key}?type=hand_tag_generate`)).status).toBe(403);
  });
});

describe('修改、删除', () => {
  it('改牌号、分区；重号拒绝；在店的不能改牌号、不能删；删掉的列表、前台都不再有（发过的历史照旧）、列表里不再有，按清单导入同一个牌号恢复', async () => {
    const a1 = (await tagOf('A001'))!;
    expect((await api(ctx.app, ctx.owner, 'PUT', `/api/frontdesk/tags/${a1.id}`, { code: 'a101', zone: 'male', active: true })).status).toBe(200);
    expect(await tagOf('A101')).toBeTruthy();
    expect((await api(ctx.app, ctx.owner, 'PUT', `/api/frontdesk/tags/${a1.id}`, { code: 'A002', zone: 'male', active: true })).body.error.code).toBe('TAG_CODE_TAKEN');
    // 在店：不能改牌号、不能删
    const a2 = (await tagOf('A002'))!;
    expect((await checkin('A002')).status).toBe(201);
    expect((await api(ctx.app, ctx.owner, 'PUT', `/api/frontdesk/tags/${a2.id}`, { code: 'A202', zone: 'male', active: true })).body.error.code).toBe('TAG_IN_USE');
    expect((await api(ctx.app, ctx.owner, 'POST', `/api/frontdesk/tags/${a2.id}/delete`)).body.error.code).toBe('TAG_IN_USE');
    // 没发过的：列表里没了（库里标已删除）
    const a3 = (await tagOf('A003'))!;
    expect((await api(ctx.app, ctx.owner, 'POST', `/api/frontdesk/tags/${a3.id}/delete`)).body).toMatchObject({ code: 'A003', kept: false });
    expect(await tagOf('A003')).toBeUndefined();
    // 发过的（离店）：同样标已删除，列表、前台都不再有，历史还在
    const a5 = (await tagOf('A005'))!;
    const v = await checkin('A005');
    expect(v.status).toBe(201);
    await ctx.sql`UPDATE visits SET status = 'cancelled', closed_at = now(), closed_by = ${ctx.ownerId} WHERE tag_id = ${a5.id}`;
    // 发过的牌不能改号（历史单据按牌号显示；Codex 审查 PR #189），改分区照常
    expect((await api(ctx.app, ctx.owner, 'PUT', `/api/frontdesk/tags/${a5.id}`, { code: 'A905', zone: 'male', active: true })).body.error.code).toBe('TAG_HAS_HISTORY');
    expect((await api(ctx.app, ctx.owner, 'POST', `/api/frontdesk/tags/${a5.id}/delete`)).body).toMatchObject({ code: 'A005', kept: true });
    // 删了的牌不能再绑芯片号（开着的绑卡窗口晚到也不行）
    expect((await api(ctx.app, ctx.owner, 'PUT', `/api/frontdesk/tags/${a5.id}/card`, { cardUid: '04AA11BB' })).status).toBe(404);
    expect(await tagOf('A005')).toBeUndefined();
    const [row] = await ctx.sql<{ active: boolean; deleted: boolean }[]>`SELECT active, deleted_at IS NOT NULL AS deleted FROM hand_tags WHERE id = ${a5.id}`;
    expect(row).toEqual({ active: false, deleted: true });
    expect((await checkin('A005')).body.error.code).toBe('TAG_INACTIVE');
    // 生成时跳过删除了的牌号（不重号）
    expect((await generate({ start: 5, count: 1, preview: true })).body.skippedExisting).toContain('A005');
    // 按清单导入同一个牌号：恢复
    const imp = await api(ctx.app, ctx.owner, 'POST', '/api/frontdesk/tags/import', { rows: [{ code: 'A005', zone: 'male', kind: 'normal', vipLevel: null }], dryRun: false });
    expect(imp.status, JSON.stringify(imp.body)).toBe(200);
    expect((await tagOf('A005'))!.active).toBe(true);
    // 店员不能删
    expect((await api(ctx.app, ctx.clerk, 'POST', `/api/frontdesk/tags/${a1.id}/delete`)).status).toBe(403);
  });
});

describe('暂停使用 / 维修中', () => {
  it('标了的前台发不出（发牌、换牌都拒绝）、看板上不算空闲；改回正常就能发；在店的不能标；恢复正常随时可以；留审计', async () => {
    const a6 = (await tagOf('A006'))!;
    expect((await api(ctx.app, ctx.owner, 'POST', `/api/frontdesk/tags/${a6.id}/service`, { status: 'repair', note: '锁坏了' })).status).toBe(200);
    expect(await tagOf('A006')).toMatchObject({ serviceStatus: 'repair', serviceNote: '锁坏了' });
    const refused = await checkin('A006');
    expect(refused.body.error.code).toBe('TAG_OUT_OF_SERVICE');
    expect(refused.body.error.message).toContain('维修中');
    const board = (await api(ctx.app, ctx.clerk, 'GET', '/api/frontdesk/board')).body;
    expect(board.tags.find((t: Tag) => t.code === 'A006')).toMatchObject({ serviceStatus: 'repair' });
    // 换牌换到它：拒绝
    const a8 = (await tagOf('A008'))!;
    expect((await api(ctx.app, ctx.owner, 'POST', `/api/frontdesk/tags/${a8.id}/service`, { status: 'paused' })).status).toBe(200);
    const visit = (await api(ctx.app, ctx.clerk, 'GET', '/api/frontdesk/board')).body.tags.find((t: { code: string; visit: unknown }) => t.code === 'A002').visit;
    const swap = await api(ctx.app, ctx.clerk, 'POST', `/api/frontdesk/visits/${visit.id}/swap`, { clientKey: randomUUID(), toTagCode: 'A008', reason: '手牌丢失' });
    expect(swap.body.error.code).toBe('TAG_OUT_OF_SERVICE');
    // 改回正常：能发
    expect((await api(ctx.app, ctx.owner, 'POST', `/api/frontdesk/tags/${a6.id}/service`, { status: 'normal' })).status).toBe(200);
    expect(await tagOf('A006')).toMatchObject({ serviceStatus: 'normal', serviceNote: null });
    expect((await checkin('A006')).status).toBe(201);
    // 在店的不能标暂停 / 维修
    expect((await api(ctx.app, ctx.owner, 'POST', `/api/frontdesk/tags/${a6.id}/service`, { status: 'paused' })).body.error.code).toBe('TAG_IN_USE');
    // 店员不能标
    expect((await api(ctx.app, ctx.clerk, 'POST', `/api/frontdesk/tags/${a8.id}/service`, { status: 'normal' })).status).toBe(403);
    const [audit] = await ctx.sql<{ detail: { summary: string } }[]>`SELECT detail FROM audit_logs WHERE action = 'hand_tag_updated' AND detail->>'code' = 'A008' ORDER BY id DESC LIMIT 1`;
    expect(audit!.detail.summary).toContain('暂停使用');
  });
});
