// 员工小程序上的「确认作废」（docs/STAFF_MP.md 第 2.8、8.1 节）：打卡、发起申请、处理审批原样重提被拒时，小程序先作废原编号再下结论。
// 作废登记上了，原请求之后才到也整笔回滚（打卡在锁编号以前先核对考勤组与位置，所以重提被拒不能断定前一次没生效）；
// 已经办了的回 found；只认这三类、只能作废自己的；网页的 /api/erp/ops 在员工小程序端口上不挂。

import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_STORE_ID } from '../src/server/lib/store-context';
import { createStaff } from '../src/server/modules/staff';
import { buildStaffMpApp } from '../src/server/modules/staffmp';
import { api, PASSWORD, setup, type TestContext } from './helpers';

let ctx: TestContext;
let staffApp: FastifyInstance;
let mine: { id: number; token: string };
let other: { id: number; token: string };

async function s<T = any>(method: 'GET' | 'POST', url: string, tok?: string | null, payload?: unknown) {
  const res = await staffApp.inject({ method, url, headers: tok ? { authorization: `Bearer ${tok}` } : {}, ...(payload === undefined ? {} : { payload: payload as object }) });
  const body = res.headers['content-type']?.toString().includes('json') ? res.json() : res.body;
  return { status: res.statusCode, body: body as T };
}

async function hire(username: string) {
  const id = await createStaff(ctx.sql, { username, displayName: username, role: 'clerk', position: 'front.staff', password: PASSWORD, mustChangePassword: false });
  await ctx.sql`UPDATE staff SET needs_position = false WHERE id = ${id}`;
  const r = await s('POST', '/api/staffmp/auth/login', null, { username, password: PASSWORD });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return { id, token: r.body.token as string };
}

const punch = (tok: string, clientKey: string) => s('POST', '/api/staffmp/oa/attendance/punch', tok, { clientKey, storeId: DEFAULT_STORE_ID });
const abandon = (tok: string | null, key: string, type: string) => s('POST', `/api/staffmp/ops/${key}/abandon`, tok, { type });

beforeAll(async () => {
  ctx = await setup();
  staffApp = await buildStaffMpApp(ctx.sql, ctx.config, { code2session: async (c) => `openid-${c}`, openCacheMs: 0 });
  mine = await hire('ops_mine');
  other = await hire('ops_other');
  const g = await api(ctx.app, ctx.owner, 'POST', '/api/oa/attendance/groups', {
    clientKey: randomUUID(),
    storeId: DEFAULT_STORE_ID,
    name: '前厅',
    gpsRequired: false,
    memberIds: [mine.id, other.id],
  });
  expect(g.status, JSON.stringify(g.body)).toBe(201);
});

afterAll(async () => {
  await staffApp?.close();
  await ctx?.close();
});

describe('员工小程序 · 确认作废', () => {
  it('没办过的打卡编号：作废登记上，原请求之后才到整笔回滚（OP_ABANDONED），不记打卡', async () => {
    const key = randomUUID();
    const r = await abandon(mine.token, key, 'oa_punch');
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ found: false, abandoned: true });
    const late = await punch(mine.token, key);
    expect([late.status, late.body.error?.code]).toEqual([409, 'OP_ABANDONED']);
    expect((await ctx.sql`SELECT 1 FROM idempotency_keys WHERE key = ${key}`).length).toBe(0);
    const [audit] = await ctx.sql`SELECT staff_id, detail FROM audit_logs WHERE action = 'erp_op_abandoned' AND target_id = ${key}`;
    expect(Number(audit!.staffId)).toBe(mine.id);
    expect(audit!.detail).toMatchObject({ idempotencyKey: key, type: 'oa_punch' });
    // 再作废一次：照旧回作废了（不重复记审计）
    expect((await abandon(mine.token, key, 'oa_punch')).body).toMatchObject({ found: false, abandoned: true });
    expect((await ctx.sql`SELECT 1 FROM audit_logs WHERE action = 'erp_op_abandoned' AND target_id = ${key}`).length).toBe(1);
  });

  it('已经办了的打卡：回 found（不登记作废），再原样重提拿回原来那一次', async () => {
    const key = randomUUID();
    const first = await punch(mine.token, key);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    const r = await abandon(mine.token, key, 'oa_punch');
    expect(r.body).toMatchObject({ found: true, abandoned: false, refId: first.body.punch.id });
    expect((await ctx.sql`SELECT 1 FROM op_fences WHERE key = ${key}`).length).toBe(0);
    const again = await punch(mine.token, key);
    expect([again.status, again.body.punch.id, again.body.replayed]).toEqual([200, first.body.punch.id, true]);
  });

  it('别人的编号（办过的、作废过的）：403，不登记作废', async () => {
    const done = randomUUID();
    expect((await punch(other.token, done)).status).toBe(200);
    expect((await abandon(mine.token, done, 'oa_punch')).status).toBe(403);
    expect((await ctx.sql`SELECT 1 FROM op_fences WHERE key = ${done}`).length).toBe(0);
    const fenced = randomUUID();
    expect((await abandon(other.token, fenced, 'oa_approval_submit')).body).toMatchObject({ abandoned: true });
    expect((await abandon(mine.token, fenced, 'oa_approval_submit')).status).toBe(403);
  });

  it('只认打卡、发起申请、处理审批；编号属于别的业务的不作废', async () => {
    for (const type of ['mall_terminate', 'oa_im_group', 'customer_note', 'nope']) {
      expect((await abandon(mine.token, randomUUID(), type)).status, type).toBe(400);
    }
    expect((await abandon(mine.token, 'not-a-uuid', 'oa_punch')).status).toBe(400);
    const key = randomUUID();
    expect((await punch(mine.token, key)).status).toBe(200);
    const wrong = await abandon(mine.token, key, 'oa_approval_act');
    expect([wrong.status, wrong.body.error?.code]).toEqual([409, 'IDEMPOTENCY_CONFLICT']);
    expect((await ctx.sql`SELECT 1 FROM op_fences WHERE key = ${key}`).length).toBe(0);
  });

  it('没登录 401；网页的查回、作废接口在员工小程序端口上一律 404', async () => {
    expect((await abandon(null, randomUUID(), 'oa_punch')).status).toBe(401);
    const key = randomUUID();
    expect((await s('POST', `/api/erp/ops/${key}/abandon`, mine.token, { type: 'oa_punch' })).status).toBe(404);
    expect((await s('GET', `/api/erp/ops/${key}?type=oa_punch`, mine.token)).status).toBe(404);
    expect((await s('GET', `/api/staffmp/erp/ops/${key}?type=oa_punch`, mine.token)).status).toBe(404);
  });
});
