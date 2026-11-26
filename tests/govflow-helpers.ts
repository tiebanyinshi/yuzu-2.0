// 业财法审批流用例共用：建一批合成员工、配好角色映射与部门负责人（只在测试库里，合成数据）。

import { randomUUID } from 'node:crypto';
import { expect } from 'vitest';
import type { GfRole } from '../src/shared/govflow';
import { createStaff } from '../src/server/modules/staff';
import { api, login, PASSWORD, type TestContext } from './helpers';

export interface People {
  ids: Record<string, number>;
  cookies: Record<string, string>;
  deptId: number;
  dept2Id: number;
}

/** 合成员工：部门负责人、经办人、各角色各一位（财总、CFO 各两位，回避时有别人可审） */
export const GF_PEOPLE: [string, string, GfRole[]][] = [
  ['gf_head', '合成部门负责人', []],
  ['gf_clerk', '合成经办', []],
  ['gf_clerk2', '合成经办二', []],
  ['gf_fin', '合成财务审核', ['finance_reviewer']],
  ['gf_legal', '合成法务', ['legal']],
  ['gf_chief', '合成财总', ['finance_chief']],
  ['gf_cfo', '合成CFO', ['cfo']],
  ['gf_ceo', '合成CEO', ['entity_head']],
  ['gf_chair', '合成董事长', ['chairman']],
  ['gf_gm', '合成业态总经理', ['business_gm']],
  ['gf_perf', '合成履约执行人', ['performer']],
  ['gf_ic', '合成内控', ['internal_control']],
  ['gf_sc', '合成供应链负责人', ['supply_chain_head']],
  ['gf_cash', '合成出纳', ['cashier']],
  ['gf_seal', '合成章证管理员', ['seal_keeper']],
  ['gf_hr', '合成人力', ['hr']],
];

export async function setupPeople(ctx: TestContext): Promise<People> {
  const ids: Record<string, number> = {};
  const cookies: Record<string, string> = {};
  const [d1] = await ctx.sql<{ id: number }[]>`INSERT INTO departments (name, sort_order) VALUES ('合成业务部', 90) RETURNING id`;
  const [d2] = await ctx.sql<{ id: number }[]>`INSERT INTO departments (name, sort_order) VALUES ('合成采购部', 91) RETURNING id`;
  const deptId = Number(d1!.id);
  const dept2Id = Number(d2!.id);
  for (const [username, displayName] of GF_PEOPLE) {
    ids[username] = await createStaff(ctx.sql, { username, displayName, role: 'clerk', departmentId: deptId, password: PASSWORD, mustChangePassword: false });
    cookies[username] = await login(ctx.app, username);
  }
  await ctx.sql`UPDATE departments SET head_id = ${ids.gf_head!} WHERE id = ${deptId}`;
  await ctx.sql`UPDATE departments SET head_id = ${ids.gf_sc!} WHERE id = ${dept2Id}`;
  for (const [username, , roles] of GF_PEOPLE) for (const role of roles) await mapRole(ctx, role, ids[username]!);
  return { ids, cookies, deptId, dept2Id };
}

export async function mapRole(ctx: TestContext, role: GfRole, staffId: number) {
  const r = await api(ctx.app, ctx.owner, 'POST', '/api/gf/roles', { role, staffId });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
}

export const yuan = (n: number) => Math.round(n * 100);

export async function newDoc(ctx: TestContext, cookie: string, body: Record<string, unknown>) {
  return api(ctx.app, cookie, 'POST', '/api/gf/docs', { clientKey: randomUUID(), docType: 'general', title: '合成事项', ...body });
}

export async function act(ctx: TestContext, cookie: string, id: number, level: number, action: 'approve' | 'return' | 'reject' = 'approve', comment = '') {
  return api(ctx.app, cookie, 'POST', `/api/gf/docs/${id}/act`, { clientKey: randomUUID(), action, level, comment });
}
