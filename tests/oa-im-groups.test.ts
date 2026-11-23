// OA-16 通讯录与群管理（docs/OA.md 第 19 节）：通讯录（部门树、在职员工、手机号可见范围）；部门群（谁能建、按部门进群、
// 入职 / 调岗 / 离职 / 复职自动进出）；离职退出所有群（群主转给最早的管理员或成员）；群管理（拉人、踢人、管理员、转让、改名、公告、解散）。
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Directory } from '../src/shared/oa-directory';
import type { ImConversationDetail, ImConversationList, ImMessagePage } from '../src/shared/oa-im';
import { createStaff } from '../src/server/modules/staff';
import { api, login, PASSWORD, setup, type TestContext } from './helpers';

let ctx: TestContext;
type Emp = { id: number; cookie: string; name: string };
const e: Record<string, Emp> = {};
const code = (r: { body: unknown }) => (r.body as { error: { code: string } }).error.code;

const hire = async (username: string, position: string): Promise<Emp> => {
  const r = await api(ctx.app, ctx.owner, 'POST', '/api/staff', { username, displayName: username, position, password: PASSWORD });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  await ctx.sql`UPDATE staff SET must_change_password = false WHERE username = ${username}`;
  return { id: (r.body as { id: number }).id, cookie: await login(ctx.app, username), name: username };
};
const detail = async (who: Emp, id: number) => api<ImConversationDetail>(ctx.app, who.cookie, 'GET', `/api/oa/im/conversations/${id}`);
const messages = async (who: Emp, id: number) => (await api<ImMessagePage>(ctx.app, who.cookie, 'GET', `/api/oa/im/conversations/${id}/messages`)).body.messages;
const lastSystem = async (who: Emp, id: number) => (await messages(who, id)).filter((m) => m.kind === 'system').at(-1)?.body;
const memberIds = (d: ImConversationDetail) => d.members.map((m) => m.staffId).sort((a, b) => a - b);
const profileVersion = async (id: number) => Number((await ctx.sql<{ version: number }[]>`SELECT version FROM staff_profiles WHERE staff_id = ${id}`)[0]?.version ?? 0);
const leave = async (id: number) => api(ctx.app, ctx.owner, 'POST', `/api/oa/employees/${id}/leave`, { leaveDate: new Date().toISOString().slice(0, 10), version: await profileVersion(id) });
const rehire = async (id: number) => api(ctx.app, ctx.owner, 'POST', `/api/oa/employees/${id}/rehire`, { version: await profileVersion(id) });
const move = async (who: Emp, position: string) => {
  const r = await api(ctx.app, ctx.owner, 'PUT', `/api/staff/${who.id}`, { displayName: who.name, position, active: true });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
};
const group = async (owner: Emp, members: Emp[], name = '测试群') => {
  const r = await api<{ id: number }>(ctx.app, owner.cookie, 'POST', '/api/oa/im/groups', { clientKey: randomUUID(), name, memberIds: members.map((m) => m.id) });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.id;
};

beforeAll(async () => {
  ctx = await setup();
  e.lead = await hire('g_lead', 'eng.lead');
  e.a = await hire('g_a', 'eng.staff');
  e.b = await hire('g_b', 'eng.staff');
  e.x = await hire('g_x', 'kitchen.staff');
  e.y = await hire('g_y', 'kitchen.staff');
  e.z = await hire('g_z', 'kitchen.staff');
});
afterAll(async () => {
  await ctx.close();
});

describe('OA-16 通讯录', () => {
  it('在职员工按部门列出；手机号默认主管以上能看，自己的总能看，看不到的打码；管组织架构的人能改成所有员工', async () => {
    await api(ctx.app, ctx.owner, 'PUT', `/api/oa/employees/${e.a!.id}/profile`, { empNo: 'G001', phone: '13900000001', hireDate: null, version: 0 });
    await api(ctx.app, ctx.owner, 'PUT', `/api/oa/employees/${e.x!.id}/profile`, { empNo: 'G002', phone: '13900000002', hireDate: null, version: 0 });
    const asX = (await api<Directory>(ctx.app, e.x!.cookie, 'GET', '/api/oa/directory')).body;
    expect(asX).toMatchObject({ phoneScope: 'managers', canSeePhones: false, canConfigure: false });
    expect(asX.people.find((p) => p.staffId === e.a!.id)).toMatchObject({ department: 'eng', empNo: 'G001', phone: '139****0001', phoneMasked: true });
    expect(asX.people.find((p) => p.staffId === e.x!.id)).toMatchObject({ phone: '13900000002', phoneMasked: false });
    expect(asX.departments.find((d) => d.key === 'eng')).toMatchObject({ headId: e.lead!.id, group: null, canCreateGroup: false });
    // 部门主管能看
    const asLead = (await api<Directory>(ctx.app, e.lead!.cookie, 'GET', '/api/oa/directory')).body;
    expect(asLead.canSeePhones).toBe(true);
    expect(asLead.people.find((p) => p.staffId === e.x!.id)).toMatchObject({ phone: '13900000002', phoneMasked: false });
    expect(asLead.people.find((p) => p.staffId === e.lead!.id)?.headOf).toEqual(['eng']);
    expect(asLead.departments.find((d) => d.key === 'eng')?.canCreateGroup).toBe(true);
    // 改设置：只有管组织架构的人
    expect((await api(ctx.app, e.x!.cookie, 'PUT', '/api/oa/directory/settings', { phoneScope: 'all' })).status).toBe(403);
    expect((await api(ctx.app, ctx.owner, 'PUT', '/api/oa/directory/settings', { phoneScope: 'all' })).status).toBe(200);
    expect((await api<Directory>(ctx.app, e.x!.cookie, 'GET', '/api/oa/directory')).body.people.find((p) => p.staffId === e.a!.id)?.phone).toBe('13900000001');
    expect((await api(ctx.app, ctx.owner, 'PUT', '/api/oa/directory/settings', { phoneScope: 'hr' })).status).toBe(200);
    expect((await api<Directory>(ctx.app, e.lead!.cookie, 'GET', '/api/oa/directory')).body.canSeePhones).toBe(false);
    await api(ctx.app, ctx.owner, 'PUT', '/api/oa/directory/settings', { phoneScope: 'managers' });
    // 专用账号打不开
    await createStaff(ctx.sql, { username: 'g_tablet', displayName: 'g_tablet', role: 'tablet', password: PASSWORD, mustChangePassword: false });
    expect((await api(ctx.app, await login(ctx.app, 'g_tablet'), 'GET', '/api/oa/directory')).status).toBe(403);
  });
});

describe('OA-16 部门群', () => {
  let dg: number;

  it('部门主管能建，本部门在职员工按部门进群；再点打开原来那个；普通员工不能建', async () => {
    expect((await api(ctx.app, e.a!.cookie, 'POST', '/api/oa/im/dept-groups', { deptKey: 'eng' })).status).toBe(403);
    const r = await api<{ id: number; created: boolean }>(ctx.app, e.lead!.cookie, 'POST', '/api/oa/im/dept-groups', { deptKey: 'eng' });
    expect(r.status).toBe(201);
    dg = r.body.id;
    const d = (await detail(e.a!, dg)).body;
    expect(d).toMatchObject({ title: '工程部群', deptKey: 'eng', myRole: 'member', dissolved: false });
    expect(memberIds(d)).toEqual([e.lead!.id, e.a!.id, e.b!.id].sort((x, y) => x - y));
    expect(d.members.every((m) => m.source === 'dept')).toBe(true);
    expect(d.members.find((m) => m.staffId === e.lead!.id)?.role).toBe('owner');
    const again = await api<{ id: number; created: boolean }>(ctx.app, e.lead!.cookie, 'POST', '/api/oa/im/dept-groups', { deptKey: 'eng' });
    expect(again.body).toEqual({ id: dg, created: false });
    // 管组织架构的人（总裁，不是本部门的）点：拉他进群再打开
    const own = await api<{ id: number; created: boolean }>(ctx.app, ctx.owner, 'POST', '/api/oa/im/dept-groups', { deptKey: 'eng' });
    expect(own.body).toEqual({ id: dg, created: false });
    expect((await api<Directory>(ctx.app, e.a!.cookie, 'GET', '/api/oa/directory')).body.departments.find((x) => x.key === 'eng')?.group).toEqual({ id: dg });
  });

  it('本部门的人不能被踢、不能自己退', async () => {
    expect(code(await api(ctx.app, e.a!.cookie, 'POST', `/api/oa/im/conversations/${dg}/leave`))).toBe('IM_DEPT_MEMBER');
    expect(code(await api(ctx.app, e.lead!.cookie, 'POST', `/api/oa/im/conversations/${dg}/members/${e.a!.id}/remove`))).toBe('IM_DEPT_MEMBER');
  });

  it('入职、调入的自动进群（没有积压的未读）；调走的自动出群；系统提示', async () => {
    await api(ctx.app, e.a!.cookie, 'POST', `/api/oa/im/conversations/${dg}/messages`, { clientKey: randomUUID(), kind: 'text', body: '早' });
    const c = await hire('g_c', 'eng.staff');
    expect(memberIds((await detail(e.a!, dg)).body)).toContain(c.id);
    expect(await lastSystem(e.a!, dg)).toBe('g_c加入了群聊');
    expect((await api<ImConversationList>(ctx.app, c.cookie, 'GET', '/api/oa/im/conversations')).body.items.find((x) => x.id === dg)?.unread).toBe(0);
    // 调到出品部：出工程部群
    await move(c, 'kitchen.staff');
    expect(memberIds((await detail(e.a!, dg)).body)).not.toContain(c.id);
    expect(await lastSystem(e.a!, dg)).toBe('g_c调离了部门，退出了群聊');
    expect((await detail(c, dg)).status).toBe(404);
    // 调回来：再进群
    await move(c, 'eng.staff');
    expect(memberIds((await detail(e.a!, dg)).body)).toContain(c.id);
    e.c = c;
  });

  it('离职退出所有群（群主转给最早的管理员）；复职只自动回部门群；停用同样退群', async () => {
    const g = await group(e.c!, [e.x!, e.y!, e.z!]);
    expect((await api(ctx.app, e.c!.cookie, 'PUT', `/api/oa/im/conversations/${g}/members/${e.y!.id}/role`, { role: 'admin' })).status).toBe(200);
    expect((await leave(e.c!.id)).status).toBe(200);
    const d = (await detail(e.x!, g)).body;
    expect(memberIds(d)).not.toContain(e.c!.id);
    expect(d.members.find((m) => m.role === 'owner')?.staffId).toBe(e.y!.id);
    expect(await lastSystem(e.x!, g)).toBe('g_c已离职，退出了群聊');
    expect(memberIds((await detail(e.a!, dg)).body)).not.toContain(e.c!.id);
    expect((await rehire(e.c!.id)).status).toBe(200);
    expect(memberIds((await detail(e.a!, dg)).body)).toContain(e.c!.id);
    expect(memberIds((await detail(e.x!, g)).body)).not.toContain(e.c!.id);
    // 后台停用账号
    const r = await api(ctx.app, ctx.owner, 'PUT', `/api/staff/${e.c!.id}`, { displayName: 'g_c', active: false });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(memberIds((await detail(e.a!, dg)).body)).not.toContain(e.c!.id);
  });
});

describe('OA-16 群管理', () => {
  let g: number;

  it('拉人：群主、管理员；在职员工；已经在的跳过；普通成员不能拉', async () => {
    g = await group(e.x!, [e.y!, e.z!], '出品群');
    expect((await api(ctx.app, e.y!.cookie, 'POST', `/api/oa/im/conversations/${g}/members`, { staffIds: [e.a!.id] })).status).toBe(403);
    const r = await api<ImConversationDetail>(ctx.app, e.x!.cookie, 'POST', `/api/oa/im/conversations/${g}/members`, { staffIds: [e.a!.id, e.y!.id] });
    expect(r.status).toBe(200);
    expect(memberIds(r.body)).toContain(e.a!.id);
    expect(await lastSystem(e.x!, g)).toBe('g_x邀请g_a加入了群聊');
    const before = (await messages(e.x!, g)).length;
    await api(ctx.app, e.x!.cookie, 'POST', `/api/oa/im/conversations/${g}/members`, { staffIds: [e.a!.id] });
    expect((await messages(e.x!, g)).length).toBe(before);
    expect(code(await api(ctx.app, e.x!.cookie, 'POST', `/api/oa/im/conversations/${g}/members`, { staffIds: [e.c!.id] }))).toBe('MEMBER_INVALID');
  });

  it('管理员：群主设、撤；管理员能踢成员、不能踢管理员与群主；群主能踢管理员；不能踢自己', async () => {
    expect((await api(ctx.app, e.y!.cookie, 'PUT', `/api/oa/im/conversations/${g}/members/${e.z!.id}/role`, { role: 'admin' })).status).toBe(403);
    await api(ctx.app, e.x!.cookie, 'PUT', `/api/oa/im/conversations/${g}/members/${e.y!.id}/role`, { role: 'admin' });
    await api(ctx.app, e.x!.cookie, 'PUT', `/api/oa/im/conversations/${g}/members/${e.z!.id}/role`, { role: 'admin' });
    expect(await lastSystem(e.x!, g)).toBe('g_x把g_z设为管理员');
    expect((await api(ctx.app, e.y!.cookie, 'POST', `/api/oa/im/conversations/${g}/members/${e.z!.id}/remove`)).status).toBe(403);
    expect((await api(ctx.app, e.y!.cookie, 'POST', `/api/oa/im/conversations/${g}/members/${e.x!.id}/remove`)).status).toBe(403);
    expect((await api(ctx.app, e.y!.cookie, 'POST', `/api/oa/im/conversations/${g}/members/${e.y!.id}/remove`)).status).toBe(403);
    expect((await api(ctx.app, e.y!.cookie, 'POST', `/api/oa/im/conversations/${g}/members/${e.a!.id}/remove`)).status).toBe(200);
    expect(await lastSystem(e.x!, g)).toBe('g_y把g_a移出了群聊');
    expect((await detail(e.a!, g)).status).toBe(404);
    // 已经不在的：算成功
    expect((await api(ctx.app, e.y!.cookie, 'POST', `/api/oa/im/conversations/${g}/members/${e.a!.id}/remove`)).status).toBe(200);
    expect((await api(ctx.app, e.x!.cookie, 'POST', `/api/oa/im/conversations/${g}/members/${e.z!.id}/remove`)).status).toBe(200);
  });

  it('改群名、群公告：群主、管理员；一样的不重复留提示', async () => {
    expect((await api(ctx.app, e.y!.cookie, 'PUT', `/api/oa/im/conversations/${g}/name`, { name: '出品部小群' })).status).toBe(200);
    expect(await lastSystem(e.x!, g)).toBe('g_y把群名改为「出品部小群」');
    const n = await api<ImConversationDetail>(ctx.app, e.x!.cookie, 'PUT', `/api/oa/im/conversations/${g}/notice`, { notice: '周五大扫除' });
    expect(n.body).toMatchObject({ title: '出品部小群', notice: { text: '周五大扫除', byName: 'g_x' } });
    const count = (await messages(e.x!, g)).length;
    await api(ctx.app, e.x!.cookie, 'PUT', `/api/oa/im/conversations/${g}/notice`, { notice: '周五大扫除' });
    await api(ctx.app, e.x!.cookie, 'PUT', `/api/oa/im/conversations/${g}/name`, { name: '出品部小群' });
    expect((await messages(e.x!, g)).length).toBe(count);
  });

  it('转让群主：原群主变成员，可以再退群；重复转让算成功', async () => {
    expect((await api(ctx.app, e.y!.cookie, 'POST', `/api/oa/im/conversations/${g}/transfer`, { staffId: e.y!.id })).status).toBe(403);
    const r = await api<ImConversationDetail>(ctx.app, e.x!.cookie, 'POST', `/api/oa/im/conversations/${g}/transfer`, { staffId: e.y!.id });
    expect(r.body.myRole).toBe('member');
    expect(r.body.members.find((m) => m.role === 'owner')?.staffId).toBe(e.y!.id);
    expect((await api(ctx.app, e.x!.cookie, 'POST', `/api/oa/im/conversations/${g}/transfer`, { staffId: e.y!.id })).status).toBe(200);
    expect((await api(ctx.app, e.x!.cookie, 'POST', `/api/oa/im/conversations/${g}/leave`)).status).toBe(200);
  });

  it('解散：群主；之后不能发、不能管，历史照看；列表标已解散；谁都能退', async () => {
    await api(ctx.app, e.y!.cookie, 'POST', `/api/oa/im/conversations/${g}/members`, { staffIds: [e.z!.id] });
    expect((await api(ctx.app, e.z!.cookie, 'POST', `/api/oa/im/conversations/${g}/dissolve`)).status).toBe(403);
    const r = await api<ImConversationDetail>(ctx.app, e.y!.cookie, 'POST', `/api/oa/im/conversations/${g}/dissolve`);
    expect(r.body.dissolved).toBe(true);
    expect((await api(ctx.app, e.y!.cookie, 'POST', `/api/oa/im/conversations/${g}/dissolve`)).status).toBe(200);
    expect(code(await api(ctx.app, e.z!.cookie, 'POST', `/api/oa/im/conversations/${g}/messages`, { clientKey: randomUUID(), kind: 'text', body: 'x' }))).toBe('GROUP_DISSOLVED');
    expect(code(await api(ctx.app, e.y!.cookie, 'PUT', `/api/oa/im/conversations/${g}/name`, { name: '复活' }))).toBe('GROUP_DISSOLVED');
    expect(await lastSystem(e.z!, g)).toBe('g_y解散了群聊');
    expect((await api<ImConversationList>(ctx.app, e.z!.cookie, 'GET', '/api/oa/im/conversations')).body.items.find((x) => x.id === g)?.dissolved).toBe(true);
    expect((await api(ctx.app, e.y!.cookie, 'POST', `/api/oa/im/conversations/${g}/leave`)).status).toBe(200);
  });

  it('解散了的部门群：可以再建一个新的', async () => {
    const [old] = await ctx.sql<{ id: number }[]>`SELECT id FROM oa_im_conversations WHERE dept_key = 'eng' AND dissolved_at IS NULL`;
    expect((await api(ctx.app, e.lead!.cookie, 'POST', `/api/oa/im/conversations/${old!.id}/dissolve`)).status).toBe(200);
    const r = await api<{ id: number; created: boolean }>(ctx.app, e.lead!.cookie, 'POST', '/api/oa/im/dept-groups', { deptKey: 'eng' });
    expect(r.body.created).toBe(true);
    expect(r.body.id).not.toBe(Number(old!.id));
  });
});

// Codex 审查 1adec4f：部门群也算建群限额；与调岗、离职串行；走光了的部门群第一个回来的接任群主
describe('OA-16 部门群的边界', () => {
  it('建部门群算建群限额，打开已有的不算', async () => {
    await ctx.sql`
      INSERT INTO oa_im_conversations (kind, name, created_by) SELECT 'group', '刷屏' || g, ${e.lead!.id} FROM generate_series(1, 8) g`;
    const open = await api<{ id: number; created: boolean }>(ctx.app, e.lead!.cookie, 'POST', '/api/oa/im/dept-groups', { deptKey: 'eng' });
    expect(open.status).toBe(200);
    expect(open.body.created).toBe(false);
    expect((await api(ctx.app, e.lead!.cookie, 'POST', `/api/oa/im/conversations/${open.body.id}/dissolve`)).status).toBe(200);
    expect(code(await api(ctx.app, e.lead!.cookie, 'POST', '/api/oa/im/dept-groups', { deptKey: 'eng' }))).toBe('GROUP_QUOTA');
  });

  it('部门群里的人走光了：第一个回来的接任群主', async () => {
    const fl = await hire('g_fl', 'finance.lead');
    const f1 = await hire('g_f1', 'finance.staff');
    const id = (await api<{ id: number }>(ctx.app, fl.cookie, 'POST', '/api/oa/im/dept-groups', { deptKey: 'finance' })).body.id;
    await move(fl, 'kitchen.staff');
    expect((await detail(f1, id)).body.members.find((m) => m.role === 'owner')?.staffId).toBe(f1.id);
    expect((await leave(f1.id)).status).toBe(200);
    const [left] = await ctx.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM oa_im_members WHERE conversation_id = ${id} AND left_at IS NULL`;
    expect(left!.n).toBe(0);
    expect((await rehire(f1.id)).status).toBe(200);
    f1.cookie = await login(ctx.app, 'g_f1');
    const d = (await detail(f1, id)).body;
    expect(d.myRole).toBe('owner');
    expect(await lastSystem(f1, id)).toBe('g_f1成为群主');
  });

  it('建部门群与在途的调岗串行：调岗先开始、后提交，调进来的人也在群里', async () => {
    const vl = await hire('g_vl', 'vip.lead');
    const v2 = await hire('g_v2', 'kitchen.staff');
    let creating: Promise<{ status: number; body: unknown }> | undefined;
    await ctx.sql.begin(async (tx) => {
      await tx`UPDATE staff SET position = 'vip.staff' WHERE id = ${v2.id}`;
      creating = api(ctx.app, vl.cookie, 'POST', '/api/oa/im/dept-groups', { deptKey: 'vip' });
      await new Promise((r) => setTimeout(r, 300));
    });
    const r = (await creating!) as { status: number; body: { id: number } };
    expect(r.status).toBe(201);
    expect(memberIds((await detail(vl, r.body.id)).body)).toContain(v2.id);
  });

  it('自己选的岗位（后台没核实）不自动进部门群；后台定了岗位再进', async () => {
    const [g] = await ctx.sql<{ id: number }[]>`SELECT id FROM oa_im_conversations WHERE dept_key = 'vip' AND dissolved_at IS NULL`;
    const vl = { ...e.lead!, cookie: await login(ctx.app, 'g_vl') };
    const v3 = await hire('g_v3', 'kitchen.staff');
    // 自选岗位那条路径：岗位与自选时间一起写
    await ctx.sql`UPDATE staff SET position = 'vip.staff', position_chosen_at = now() WHERE id = ${v3.id}`;
    expect(memberIds((await detail(vl, Number(g!.id))).body)).not.toContain(v3.id);
    await move(v3, 'vip.lead');
    expect(memberIds((await detail(vl, Number(g!.id))).body)).toContain(v3.id);
  });

  it('拉人与在途的离职串行：离职先开始、后提交，拉人被拒、他不在群里', async () => {
    const o = await hire('g_o', 'kitchen.staff');
    const p1 = await hire('g_p1', 'kitchen.staff');
    const p2 = await hire('g_p2', 'kitchen.staff');
    const q = await hire('g_q', 'kitchen.staff');
    const g = await group(o, [p1, p2]);
    let adding: Promise<{ status: number; body: unknown }> | undefined;
    await ctx.sql.begin(async (tx) => {
      // 模拟办理离职的事务：账号停用（触发器拿成员同步锁），还没提交时有人把他拉进群
      await tx`UPDATE staff SET active = false WHERE id = ${q.id}`;
      adding = api(ctx.app, o.cookie, 'POST', `/api/oa/im/conversations/${g}/members`, { staffIds: [q.id] });
      await new Promise((r) => setTimeout(r, 300));
    });
    const r = (await adding!) as { status: number; body: unknown };
    expect(code(r)).toBe('MEMBER_INVALID');
    expect(memberIds((await detail(o, g)).body)).not.toContain(q.id);
  });

  it('自己选成负责人（没核实）的不算主管：不能看手机号、不能建部门群；后台核实以后可以', async () => {
    const el = await hire('g_el', 'ent.lead');
    await ctx.sql`UPDATE staff SET position_chosen_at = now() WHERE id = ${el.id}`;
    const d = (await api<Directory>(ctx.app, el.cookie, 'GET', '/api/oa/directory')).body;
    expect(d.canSeePhones).toBe(false);
    expect(d.departments.find((x) => x.key === 'ent')?.canCreateGroup).toBe(false);
    expect((await api(ctx.app, el.cookie, 'POST', '/api/oa/im/dept-groups', { deptKey: 'ent' })).status).toBe(403);
    await ctx.sql`UPDATE staff SET position_chosen_at = NULL WHERE id = ${el.id}`;
    expect((await api<Directory>(ctx.app, el.cookie, 'GET', '/api/oa/directory')).body.canSeePhones).toBe(true);
    expect((await api(ctx.app, el.cookie, 'POST', '/api/oa/im/dept-groups', { deptKey: 'ent' })).status).toBe(201);
  });

  it('打开部门群时它正被解散：等解散提交，建一个新的，不往旧群里加人', async () => {
    const [old] = await ctx.sql<{ id: number }[]>`SELECT id FROM oa_im_conversations WHERE dept_key = 'ent' AND dissolved_at IS NULL`;
    let opening: Promise<{ status: number; body: unknown }> | undefined;
    await ctx.sql.begin(async (tx) => {
      await tx`SELECT 1 FROM oa_im_conversations WHERE id = ${old!.id} FOR UPDATE`;
      opening = api(ctx.app, ctx.owner, 'POST', '/api/oa/im/dept-groups', { deptKey: 'ent' });
      await new Promise((r) => setTimeout(r, 300));
      await tx`UPDATE oa_im_conversations SET dissolved_at = now() WHERE id = ${old!.id}`;
    });
    const r = (await opening!) as { status: number; body: { id: number; created: boolean } };
    expect(r.status).toBe(201);
    expect(r.body.id).not.toBe(Number(old!.id));
    const [n] = await ctx.sql<
      { n: number }[]
    >`SELECT count(*)::int AS n FROM oa_im_members WHERE conversation_id = ${old!.id} AND staff_id = (SELECT id FROM staff WHERE username = 'owner' OR role = 'owner' ORDER BY id LIMIT 1)`;
    expect(n!.n).toBe(0);
  });

  it('建群时建群人正被停用：等停用提交，再核对一次，不建', async () => {
    const k = await hire('g_k', 'kitchen.staff');
    const k1 = await hire('g_k1', 'kitchen.staff');
    const k2 = await hire('g_k2', 'kitchen.staff');
    let making: Promise<{ status: number; body: unknown }> | undefined;
    await ctx.sql.begin(async (tx) => {
      await tx`UPDATE staff SET active = false WHERE id = ${k.id}`;
      making = api(ctx.app, k.cookie, 'POST', '/api/oa/im/groups', { clientKey: randomUUID(), name: '停用前', memberIds: [k1.id, k2.id] });
      await new Promise((r) => setTimeout(r, 300));
    });
    const r = (await making!) as { status: number };
    expect([401, 403]).toContain(r.status);
    const [n] = await ctx.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM oa_im_conversations WHERE created_by = ${k.id}`;
    expect(n!.n).toBe(0);
  });

  it('自己选成人力负责人（hr.org 随岗位来、没核实）的不算管组织架构的人；核实以后算', async () => {
    const hl = await hire('g_hl', 'hr.lead');
    await ctx.sql`UPDATE staff SET position_chosen_at = now() WHERE id = ${hl.id}`;
    const d = (await api<Directory>(ctx.app, hl.cookie, 'GET', '/api/oa/directory')).body;
    expect(d).toMatchObject({ canSeePhones: false, canConfigure: false });
    expect(d.departments.find((x) => x.key === 'kitchen')?.canCreateGroup).toBe(false);
    expect((await api(ctx.app, hl.cookie, 'POST', '/api/oa/im/dept-groups', { deptKey: 'kitchen' })).status).toBe(403);
    expect((await api(ctx.app, hl.cookie, 'PUT', '/api/oa/directory/settings', { phoneScope: 'all' })).status).toBe(403);
    await ctx.sql`UPDATE staff SET position_chosen_at = NULL WHERE id = ${hl.id}`;
    expect((await api<Directory>(ctx.app, hl.cookie, 'GET', '/api/oa/directory')).body).toMatchObject({ canSeePhones: true, canConfigure: true });
    expect((await api(ctx.app, hl.cookie, 'PUT', '/api/oa/directory/settings', { phoneScope: 'managers' })).status).toBe(200);
  });

  it('解散了的群：离职也退出，复职后看不到', async () => {
    const m0 = await hire('g_m0', 'kitchen.staff');
    const m1 = await hire('g_m1', 'kitchen.staff');
    const m2 = await hire('g_m2', 'kitchen.staff');
    const g = await group(m0, [m1, m2]);
    expect((await api(ctx.app, m0.cookie, 'POST', `/api/oa/im/conversations/${g}/dissolve`)).status).toBe(200);
    expect((await detail(m1, g)).status).toBe(200);
    expect((await leave(m1.id)).status).toBe(200);
    expect((await rehire(m1.id)).status).toBe(200);
    m1.cookie = await login(ctx.app, 'g_m1');
    expect((await detail(m1, g)).status).toBe(404);
  });

  it('建部门群时主管正被调走：等调岗提交，再核对一次权限，不建', async () => {
    const ol = await hire('g_ol', 'outreach.lead');
    let making: Promise<{ status: number; body: unknown }> | undefined;
    await ctx.sql.begin(async (tx) => {
      await tx`UPDATE staff SET position = 'kitchen.staff' WHERE id = ${ol.id}`;
      making = api(ctx.app, ol.cookie, 'POST', '/api/oa/im/dept-groups', { deptKey: 'outreach' });
      await new Promise((r) => setTimeout(r, 300));
    });
    expect(((await making!) as { status: number }).status).toBe(403);
    const [n] = await ctx.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM oa_im_conversations WHERE dept_key = 'outreach'`;
    expect(n!.n).toBe(0);
  });
});
