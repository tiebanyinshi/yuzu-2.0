// 业财法审批流 P01（docs/APPROVAL_V4.md，合成数据、测试库）：验收场景 12（终审人回避）、43（履约执行人 +1）、47（内控参与），
// 以及角色映射不拿店主顶替、4 级以上链路、财法并行分审、财总＋CFO 会签（任一人不同意即不通过）、知会（即时 / 日报、不重复）、
// 微信特批补登、状态机、操作编号幂等。

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { COSIGN_FINANCE_CFO } from '../src/shared/govflow';
import { loadDoc, sendCcDigest, submitFlow } from '../src/server/modules/govflow/engine';
import { act, newDoc, setupPeople, yuan, type People } from './govflow-helpers';
import { api, setup, type TestContext } from './helpers';

let ctx: TestContext;
let p: People;
const c = (u: string) => p.cookies[u]!;
const get = async (id: number, cookie = c('gf_clerk')) => (await api(ctx.app, cookie, 'GET', `/api/gf/docs/${id}`)).body;

beforeAll(async () => {
  ctx = await setup();
  p = await setupPeople(ctx);
});
afterAll(async () => {
  await ctx.app.close();
  await ctx.sql.end();
});

describe('角色映射', () => {
  it('只有有 gf.roles 的（店主）能配；重复配拒绝；店主不自动顶替这些角色', async () => {
    const r = await api(ctx.app, c('gf_clerk'), 'POST', '/api/gf/roles', { role: 'cfo', staffId: p.ids.gf_clerk });
    expect(r.status).toBe(403);
    const dup = await api(ctx.app, ctx.owner, 'POST', '/api/gf/roles', { role: 'cfo', staffId: p.ids.gf_cfo });
    expect(dup.status).toBe(409);
    const d = await newDoc(ctx, c('gf_clerk'), { departmentId: p.deptId, amountCents: yuan(500) });
    expect(d.status, JSON.stringify(d.body)).toBe(200);
    // 第 1 级部门负责人：店主不在里面
    const owner = await act(ctx, ctx.owner, d.body.id, 1);
    expect(owner.status).toBe(403);
    const meta = await api(ctx.app, c('gf_cfo'), 'GET', '/api/gf/meta');
    expect(meta.body.myRoles).toEqual(['cfo']);
  });
});

describe('4 级以上链路、并行分审、场景 43', () => {
  it('30 万合同类事项：部门负责人 → 履约执行人 → 财法分审 → CEO → 董事长，逐级走完', async () => {
    const d = await newDoc(ctx, c('gf_clerk'), { departmentId: p.deptId, amountCents: yuan(300_000), performerId: p.ids.gf_perf, payload: { contractLike: true } });
    expect(d.status, JSON.stringify(d.body)).toBe(200);
    const id = d.body.id;
    expect(d.body.nodes.map((n: { label: string }) => n.label)).toEqual(['部门负责人', '内部履约执行人', '财务、法务分别审核', 'CEO', '董事长']);
    expect(d.body.status).toBe('reviewing');
    // 级别对不上拒绝
    expect((await act(ctx, c('gf_head'), id, 2)).status).toBe(409);
    expect((await act(ctx, c('gf_head'), id, 1)).status).toBe(200);
    // 履约执行人这一级别人不能审
    expect((await act(ctx, c('gf_fin'), id, 2)).status).toBe(403);
    expect((await act(ctx, c('gf_perf'), id, 2)).status).toBe(200);
    // 并行分审：财务先审，还在第 3 级等法务
    const fin = await act(ctx, c('gf_fin'), id, 3);
    expect(fin.body.currentLevel).toBe(3);
    expect(fin.body.nodes[2].waiting).toEqual(['法务']);
    expect((await act(ctx, c('gf_fin'), id, 3)).status).toBe(409);
    expect((await act(ctx, c('gf_legal'), id, 3)).body.currentLevel).toBe(4);
    expect((await act(ctx, c('gf_ceo'), id, 4)).body.currentLevel).toBe(5);
    const done = await act(ctx, c('gf_chair'), id, 5);
    expect(done.body.status).toBe('to_execute');
  });

  it('场景 43：履约执行人与部门负责人同一人时不重复', async () => {
    await api(ctx.app, ctx.owner, 'POST', '/api/gf/roles', { role: 'performer', staffId: p.ids.gf_head });
    const d = await newDoc(ctx, c('gf_clerk'), { departmentId: p.deptId, amountCents: yuan(20_000), performerId: p.ids.gf_head, payload: { contractLike: true } });
    expect(d.body.nodes.map((n: { label: string }) => n.label)).toEqual(['部门负责人', '财务、法务分别审核', 'CFO']);
    expect(d.body.notes.join()).toContain('同一人');
  });

  it('合同类事项没选履约执行人不能建；选的人不在履约执行人角色里也不能', async () => {
    expect((await newDoc(ctx, c('gf_clerk'), { departmentId: p.deptId, amountCents: yuan(100), payload: { contractLike: true } })).status).toBe(422);
    const r = await newDoc(ctx, c('gf_clerk'), { departmentId: p.deptId, amountCents: yuan(100), performerId: p.ids.gf_clerk2, payload: { contractLike: true } });
    expect(r.body.error.code).toBe('GF_PERFORMER_ROLE');
  });

  it('部门负责人自己发起：负责人一级自动视同确认（记一条跳过）', async () => {
    const d = await newDoc(ctx, c('gf_head'), { departmentId: p.deptId, amountCents: yuan(800) });
    expect(d.body.currentLevel).toBe(2);
    expect(d.body.actions[0]).toMatchObject({ action: 'skip', seat: '部门负责人' });
  });
});

describe('场景 47：内控参与', () => {
  it('新供应商、单一来源：终审前加内控；常规库内业务不加', async () => {
    const d = await newDoc(ctx, c('gf_clerk'), { departmentId: p.deptId, amountCents: yuan(3_000), flags: ['new_supplier', 'single_source'] });
    const labels = d.body.nodes.map((n: { label: string }) => n.label);
    expect(labels).toEqual(['部门负责人', '财务、法务分别审核', '内控', '财总']);
    expect(d.body.notes.join()).toContain('单一来源、新供应商');
    const routine = await newDoc(ctx, c('gf_clerk'), { departmentId: p.deptId, amountCents: yuan(3_000) });
    expect(routine.body.nodes.map((n: { label: string }) => n.label)).not.toContain('内控');
  });
});

describe('场景 12：终审人回避', () => {
  it('财总发起自己的事项：财总终审上移到 CFO；财总审不了自己的单', async () => {
    const d = await newDoc(ctx, c('gf_chief'), { departmentId: p.deptId, amountCents: yuan(5_000) });
    const labels = d.body.nodes.map((n: { label: string }) => n.label);
    expect(labels.at(-1)).toBe('CFO');
    expect(d.body.notes.join()).toContain('财总回避');
  });

  it('事项本人是 CFO（报销人）：CFO 有两位时保留节点，本人审被拒、另一位能审', async () => {
    const [extra] = await ctx.sql<{ id: number }[]>`SELECT id FROM staff WHERE username = 'gf_clerk2'`;
    await api(ctx.app, ctx.owner, 'POST', '/api/gf/roles', { role: 'cfo', staffId: Number(extra!.id) });
    const d = await newDoc(ctx, c('gf_clerk'), { departmentId: p.deptId, amountCents: yuan(20_000), subjectStaffId: p.ids.gf_cfo });
    const id = d.body.id;
    expect(d.body.nodes.at(-1).label).toBe('CFO');
    await act(ctx, c('gf_head'), id, 1);
    await act(ctx, c('gf_fin'), id, 2);
    await act(ctx, c('gf_legal'), id, 2);
    const self = await act(ctx, c('gf_cfo'), id, 3);
    expect(self.status).toBe(403);
    expect(self.body.error.message).toContain('回避');
    expect((await act(ctx, c('gf_clerk2'), id, 3)).body.status).toBe('to_execute');
  });
});

describe('财总＋CFO 会签', () => {
  const cosignDoc = async () => {
    const d = await newDoc(ctx, c('gf_clerk'), { departmentId: p.deptId, amountCents: yuan(60_000), submit: false });
    await ctx.sql.begin(async (tx) => {
      const doc = await loadDoc(tx, d.body.id, true);
      await submitFlow(tx, doc, [COSIGN_FINANCE_CFO], { id: p.ids.gf_clerk!, username: 'gf_clerk', displayName: '合成经办', role: 'clerk', duties: [], mustChangePassword: false });
    });
    return d.body.id as number;
  };
  it('两人都同意才通过；同一人不能占两席', async () => {
    const id = await cosignDoc();
    const first = await act(ctx, c('gf_chief'), id, 1);
    expect(first.body.status).toBe('reviewing');
    expect(first.body.nodes[0].waiting).toEqual(['CFO']);
    expect((await act(ctx, c('gf_chief'), id, 1)).status).toBe(409);
    expect((await act(ctx, c('gf_cfo'), id, 1)).body.status).toBe('to_execute');
  });
  it('任一人不同意即不通过（驳回），驳回的不能再提交', async () => {
    const id = await cosignDoc();
    await act(ctx, c('gf_chief'), id, 1);
    expect((await act(ctx, c('gf_cfo'), id, 1, 'reject', '')).status).toBe(422);
    const r = await act(ctx, c('gf_cfo'), id, 1, 'reject', '额度依据不足');
    expect(r.body.status).toBe('rejected');
    const again = await api(ctx.app, c('gf_clerk'), 'POST', `/api/gf/docs/${id}/submit`, { version: r.body.version });
    expect(again.body.error.code).toBe('GF_REJECTED');
  });
});

describe('退回再提交、撤回、执行、幂等', () => {
  it('退回后改了再提交从第 1 级重新走（第 2 轮）', async () => {
    const d = await newDoc(ctx, c('gf_clerk'), { departmentId: p.deptId, amountCents: yuan(1_000) });
    const r = await act(ctx, c('gf_head'), d.body.id, 1, 'return', '附件不全');
    expect(r.body.status).toBe('returned');
    const s = await api(ctx.app, c('gf_clerk'), 'POST', `/api/gf/docs/${d.body.id}/submit`, { version: r.body.version });
    expect(s.body).toMatchObject({ status: 'reviewing', round: 2, currentLevel: 1 });
  });
  it('撤回在审的；审批通过后 待执行 → 执行中 → 已完成 → 已归档', async () => {
    const w = await newDoc(ctx, c('gf_clerk'), { departmentId: p.deptId, amountCents: yuan(100) });
    const wd = await api(ctx.app, c('gf_clerk'), 'POST', `/api/gf/docs/${w.body.id}/withdraw`, { version: w.body.version });
    expect(wd.body.status).toBe('withdrawn');
    const d = await newDoc(ctx, c('gf_clerk'), { departmentId: p.deptId, amountCents: yuan(100) });
    await act(ctx, c('gf_head'), d.body.id, 1);
    await act(ctx, c('gf_fin'), d.body.id, 2);
    await act(ctx, c('gf_legal'), d.body.id, 2);
    let x = (await act(ctx, c('gf_chief'), d.body.id, 3)).body;
    expect(x.status).toBe('to_execute');
    expect((await api(ctx.app, c('gf_clerk'), 'POST', `/api/gf/docs/${d.body.id}/execute`, { version: x.version, step: 'archive' })).status).toBe(409);
    for (const [step, status] of [
      ['start', 'executing'],
      ['complete', 'completed'],
      ['archive', 'archived'],
    ] as const) {
      x = (await api(ctx.app, c('gf_clerk'), 'POST', `/api/gf/docs/${d.body.id}/execute`, { version: x.version, step })).body;
      expect(x.status).toBe(status);
    }
  });
  it('同一操作编号重提返回同一个事项；同意重提不重复记', async () => {
    const clientKey = randomUUID();
    const body = { clientKey, docType: 'general', title: '幂等', departmentId: p.deptId, amountCents: yuan(10) };
    const a = await api(ctx.app, c('gf_clerk'), 'POST', '/api/gf/docs', body);
    const b = await api(ctx.app, c('gf_clerk'), 'POST', '/api/gf/docs', body);
    expect(b.body.id).toBe(a.body.id);
    expect((await api(ctx.app, c('gf_clerk'), 'POST', '/api/gf/docs', { ...body, amountCents: 11 })).status).toBe(409);
    const key = randomUUID();
    const act1 = await api(ctx.app, c('gf_head'), 'POST', `/api/gf/docs/${a.body.id}/act`, { clientKey: key, action: 'approve', level: 1 });
    const act2 = await api(ctx.app, c('gf_head'), 'POST', `/api/gf/docs/${a.body.id}/act`, { clientKey: key, action: 'approve', level: 1 });
    expect(act2.status).toBe(200);
    expect(act2.body.actions.length).toBe(act1.body.actions.length);
  });
  it('看不到别人的事项（不在审批链、不是知会对象）', async () => {
    const d = await newDoc(ctx, c('gf_clerk'), { departmentId: p.deptId, amountCents: yuan(10) });
    expect((await api(ctx.app, c('gf_clerk2'), 'GET', `/api/gf/docs/${d.body.id}`)).status).toBe(403);
    expect((await api(ctx.app, c('gf_head'), 'GET', `/api/gf/docs/${d.body.id}`)).status).toBe(200);
    expect((await api(ctx.app, c('gf_clerk2'), 'GET', '/api/gf/docs?box=all')).status).toBe(403);
    expect((await api(ctx.app, c('gf_ic'), 'GET', '/api/gf/docs?box=all')).status).toBe(200);
  });
});

describe('知会', () => {
  const approveSmall = async (amount: number) => {
    const d = await newDoc(ctx, c('gf_clerk'), { departmentId: p.deptId, amountCents: amount });
    const id = d.body.id;
    await act(ctx, c('gf_head'), id, 1);
    await act(ctx, c('gf_fin'), id, 2);
    await act(ctx, c('gf_legal'), id, 2);
    return id as number;
  };
  it('普通的进日报、18 点以后发一次，参与审批的不知会', async () => {
    const id = await approveSmall(yuan(500));
    const x = await act(ctx, c('gf_chief'), id, 3);
    expect(x.body.status).toBe('to_execute');
    const names = x.body.cc.map((r: { staffName: string }) => r.staffName).sort();
    // 财总审过了，不知会；董事长、业态总经理、CFO（两位）知会
    expect(names).not.toContain('合成财总');
    expect(names).toContain('合成董事长');
    expect(x.body.cc.every((r: { urgent: boolean; notifiedAt: string | null }) => !r.urgent && r.notifiedAt === null)).toBe(true);
    expect(await sendCcDigest(ctx.sql, 'Asia/Shanghai', new Date('2026-11-26T02:00:00Z'))).toBe(0);
    const n = await sendCcDigest(ctx.sql, 'Asia/Shanghai', new Date(Date.now() + 36 * 3600_000));
    expect(n).toBeGreaterThan(0);
    expect(await sendCcDigest(ctx.sql, 'Asia/Shanghai', new Date(Date.now() + 36 * 3600_000))).toBe(0);
    const [note] = await ctx.sql`SELECT title FROM oa_notifications WHERE staff_id = ${p.ids.gf_chair!} AND ref_type = 'gf_digest'`;
    expect(String(note!.title)).toContain('业财法知会日报');
  });
  it('大额（≥ 5 万）通过即时提醒', async () => {
    const d = await newDoc(ctx, c('gf_clerk'), { departmentId: p.deptId, amountCents: yuan(50_000) });
    const id = d.body.id;
    await act(ctx, c('gf_head'), id, 1);
    await act(ctx, c('gf_fin'), id, 2);
    await act(ctx, c('gf_legal'), id, 2);
    await act(ctx, c('gf_cfo'), id, 3);
    const x = await act(ctx, c('gf_ceo'), id, 4);
    expect(x.body.status).toBe('to_execute');
    expect(x.body.cc.length).toBeGreaterThan(0);
    expect(x.body.cc.every((r: { urgent: boolean; notifiedAt: string | null }) => r.urgent && r.notifiedAt)).toBe(true);
    // 知会对象看得到（只读）、待我审批里没有
    expect((await api(ctx.app, c('gf_chair'), 'GET', `/api/gf/docs/${id}`)).status).toBe(200);
    const cc = await api(ctx.app, c('gf_chair'), 'GET', '/api/gf/docs?box=cc');
    expect(cc.body.some((r: { id: number }) => r.id === id)).toBe(true);
  });
});

describe('微信特批补登', () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]).toString('base64');
  const pdf = Buffer.from('%PDF-1.4 合成需求说明').toString('base64');
  it('两人确认、唯一特批编号、关联原事项不重复审批；补登前是「特批待补登」，补齐需求说明与 OK 截图后恢复', async () => {
    const d = await newDoc(ctx, c('gf_clerk'), { departmentId: p.deptId, amountCents: yuan(100) });
    await act(ctx, c('gf_head'), d.body.id, 1);
    await act(ctx, c('gf_fin'), d.body.id, 2);
    await act(ctx, c('gf_legal'), d.body.id, 2);
    await act(ctx, c('gf_chief'), d.body.id, 3);
    const clientKey = randomUUID();
    const body = { clientKey, docId: d.body.id, title: '紧急付款', amountCents: yuan(100), reason: '设备抢修', confirmerIds: [p.ids.gf_cfo, p.ids.gf_ceo], confirmedAt: new Date().toISOString() };
    const s = await api(ctx.app, c('gf_clerk'), 'POST', '/api/gf/specials', body);
    expect(s.status, JSON.stringify(s.body)).toBe(200);
    expect(s.body.specialNo).toMatch(/^TP/);
    expect((await api(ctx.app, c('gf_clerk'), 'POST', '/api/gf/specials', body)).body.id).toBe(s.body.id);
    expect((await api(ctx.app, c('gf_clerk'), 'POST', '/api/gf/specials', { ...body, clientKey: randomUUID(), confirmerIds: [p.ids.gf_cfo, p.ids.gf_cfo] })).status).toBe(400);
    expect((await get(d.body.id)).status).toBe('special_backfill');
    const one = { purpose: 'need', fileName: '需求说明.pdf', mime: 'application/pdf', base64: pdf };
    const ok = { purpose: 'ok_screenshot', fileName: 'ok.png', mime: 'image/png', base64: png };
    expect((await api(ctx.app, c('gf_clerk2'), 'POST', `/api/gf/specials/${s.body.id}/backfill`, { files: [one, ok] })).status).toBe(403);
    expect((await api(ctx.app, c('gf_clerk'), 'POST', `/api/gf/specials/${s.body.id}/backfill`, { files: [one, one] })).status).toBe(422);
    expect((await api(ctx.app, c('gf_clerk'), 'POST', `/api/gf/specials/${s.body.id}/backfill`, { files: [one, { ...ok, mime: 'application/pdf' }] })).status).toBe(422);
    const b = await api(ctx.app, c('gf_clerk'), 'POST', `/api/gf/specials/${s.body.id}/backfill`, { files: [one, ok], note: '已补' });
    expect(b.status, JSON.stringify(b.body)).toBe(200);
    expect(b.body.files.length).toBe(2);
    expect((await api(ctx.app, c('gf_clerk'), 'POST', `/api/gf/specials/${s.body.id}/backfill`, { files: [one, ok] })).status).toBe(409);
    const after = await get(d.body.id);
    expect(after.status).toBe('to_execute');
    expect(after.round).toBe(1);
    // 特批即时知会（参与过审批的财总不重复）
    const [cc] = await ctx.sql`SELECT count(*)::int AS n FROM gf_cc WHERE doc_id = ${d.body.id} AND staff_id = ${p.ids.gf_chief!}`;
    expect(cc!.n).toBe(0);
    const file = await ctx.app.inject({ method: 'GET', url: `/api/gf/files/${b.body.files[0].id}`, headers: { cookie: c('gf_seal') } });
    expect(file.statusCode).toBe(403);
  });
});
