// 8.2.15 业财法「流程与阈值」（《业财法审批与 WCP 需求变更》A2，WB4，docs/V8215_GF_CONFIG.md），合成数据、测试库：
// 阈值默认值 = 原来的常量、改了以后分级与提示跟着变、权限；各类事项自己设的流程只管之后提交的单（在途单不变）、知会角色、
// 校验、零星采购超额的合并特批照样追加；试算列出每一级是谁、排链调整，没人能审的只提示不报错；清除后回到内置流程。

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { act, newDoc, setupPeople, yuan, type People } from './govflow-helpers';
import { api, setup, type TestContext } from './helpers';

let ctx: TestContext;
let p: People;
const c = (u: string) => p.cookies[u]!;
const doc = async (id: number, cookie = c('gf_clerk')) => (await api(ctx.app, cookie, 'GET', `/api/gf/docs/${id}`)).body;
const labels = (d: { nodes: { label: string }[] }) => d.nodes.map((x) => x.label);
const config = async () => (await api(ctx.app, ctx.owner, 'GET', '/api/gf/config')).body;
const putRules = (body: Record<string, unknown>, cookie = ctx.owner) => api(ctx.app, cookie, 'PUT', '/api/gf/config/rules', body);
const putFlow = (docType: string, body: Record<string, unknown>, cookie = ctx.owner) => api(ctx.app, cookie, 'PUT', `/api/gf/config/flows/${docType}`, body);
const clearFlow = (docType: string) => api(ctx.app, ctx.owner, 'POST', `/api/gf/config/flows/${docType}/clear`, {});
const preview = (body: Record<string, unknown>, cookie = ctx.owner) => api(ctx.app, cookie, 'POST', '/api/gf/config/preview', body);
let n = 0;
async function dept(name: string, headUser: string | null = 'gf_head') {
  const [d] = await ctx.sql<{ id: number }[]>`INSERT INTO departments (name, sort_order, head_id) VALUES (${name}, 99, ${headUser ? p.ids[headUser]! : null}) RETURNING id`;
  return Number(d!.id);
}
const petty = (cookie: string, departmentId: number, body: Record<string, unknown> = {}) =>
  api(ctx.app, cookie, 'POST', '/api/gf/petty', { clientKey: randomUUID(), departmentId, supplierName: `合成配置五金${n++}`, items: '合成物资', qty: 1, amountCents: yuan(100), ...body });
const OLD = { pettyBasicCents: 300_000, pettyBasicQty: 50, deptDailyCents: 1_000_000, deptMonthlyCents: 5_000_000, purchaseDeptDailyCents: 1_000_000, pettyAcceptDays: 7 };

beforeAll(async () => {
  ctx = await setup();
  p = await setupPeople(ctx);
});
afterAll(async () => {
  await ctx.app.close();
  await ctx.sql.end();
});

describe('阈值（WB4）', () => {
  it('没改过的等于原来的常量（升级后行为不变），升级审核默认财总；员工能读到现在的阈值', async () => {
    const cfg = await config();
    expect(cfg.rules).toEqual({ ...OLD, pettyEscalationRole: 'finance_chief' });
    expect(cfg.defaults).toEqual(cfg.rules);
    expect(cfg.rulesUpdatedBy).toBe(null);
    expect(cfg.flows.every((f: { active: unknown }) => f.active === null)).toBe(true);
    expect((await api(ctx.app, c('gf_clerk'), 'GET', '/api/gf/settings')).body.rules).toMatchObject(OLD);
  });

  it('只有店主（gf.roles）能看、能改、能试算', async () => {
    expect((await api(ctx.app, c('gf_clerk'), 'GET', '/api/gf/config')).status).toBe(403);
    expect((await api(ctx.app, c('gf_chief'), 'GET', '/api/gf/config')).status).toBe(403);
    expect((await putRules({ ...OLD, pettyEscalationRole: null }, c('gf_chief'))).status).toBe(403);
    expect((await putFlow('general', { ccRoles: [] }, c('gf_chief'))).status).toBe(403);
    expect((await api(ctx.app, c('gf_chief'), 'POST', '/api/gf/config/flows/general/clear', {})).status).toBe(403);
    expect((await preview({ docType: 'general' }, c('gf_clerk'))).status).toBe(403);
  });

  it('改基础审核线：分级与提示跟着变；改前改后记操作日志；没改动、月小于日拒绝', async () => {
    const d = await dept('配置分级');
    const r = await putRules({ ...OLD, pettyBasicCents: yuan(5000), pettyBasicQty: 20, pettyEscalationRole: 'finance_chief', reason: '试点调高' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.rules.pettyBasicCents).toBe(yuan(5000));
    expect(r.body.rulesUpdatedBy).toBeTruthy();
    // 4,000 元原来要比价，现在基础审核
    const basic = await petty(c('gf_clerk'), d, { amountCents: yuan(4000) });
    expect(basic.status, JSON.stringify(basic.body)).toBe(200);
    expect(labels(await doc(basic.body.docId))).toEqual(['部门负责人', '财务审核人']);
    // 5,000.01 元或 21 件超出：提示写现在的数
    const over = await petty(c('gf_clerk'), d, { amountCents: yuan(5000) + 1 });
    expect(over.body.error.code).toBe('GF_QUOTE_REQUIRED');
    expect(over.body.error.message).toContain('5,000 元或 20 件');
    expect((await petty(c('gf_clerk'), d, { qty: 21 })).body.error.code).toBe('GF_QUOTE_REQUIRED');
    // 超出的升级由财总审（不加层级）；改成不升级就照旧财务审核人
    const up = await petty(c('gf_clerk'), d, { amountCents: yuan(5000) + 1, quoteNote: '三家比价' });
    expect(labels(await doc(up.body.docId))).toEqual(['部门负责人', '财总']);
    expect((await putRules({ ...OLD, pettyBasicCents: yuan(5000), pettyBasicQty: 20, pettyEscalationRole: null })).status).toBe(200);
    const flat = await petty(c('gf_clerk'), await dept('配置分级二'), { amountCents: yuan(5000) + 1, quoteNote: '三家比价' });
    expect(labels(await doc(flat.body.docId))).toEqual(['部门负责人', '财务审核人']);

    const [audit] = await ctx.sql<{ detail: { before: { pettyBasicCents: number }; after: { pettyBasicCents: number }; reason: string } }[]>`
      SELECT detail FROM audit_logs WHERE action = 'gf_config' AND detail->>'op' = 'rules' ORDER BY id LIMIT 1`;
    expect(audit!.detail.before.pettyBasicCents).toBe(OLD.pettyBasicCents);
    expect(audit!.detail.after.pettyBasicCents).toBe(yuan(5000));
    expect(audit!.detail.reason).toBe('试点调高');
    expect((await putRules({ ...OLD, pettyBasicCents: yuan(5000), pettyBasicQty: 20, pettyEscalationRole: null })).body.error.code).toBe('GF_RULES_SAME');
    expect((await putRules({ ...OLD, deptDailyCents: yuan(60_000), pettyEscalationRole: null })).status).toBe(400);
    expect((await putRules({ ...OLD, pettyEscalationRole: 'nobody' })).status).toBe(400);
  });

  it('改默认日额度：没核定过的部门按新的算，超了加合并特批', async () => {
    expect((await putRules({ ...OLD, deptDailyCents: yuan(500), pettyEscalationRole: 'finance_chief' })).status).toBe(200);
    const d = await dept('配置额度');
    expect((await api(ctx.app, c('gf_ic'), 'GET', `/api/gf/petty/quota/${d}`)).body.dailyLimit).toBe(yuan(500));
    const ok = await petty(c('gf_clerk'), d, { amountCents: yuan(500) });
    expect(labels(await doc(ok.body.docId))).toEqual(['部门负责人', '财务审核人']);
    const over = await petty(c('gf_clerk'), d, { amountCents: 1 });
    expect(labels(await doc(over.body.docId)).at(-1)).toBe('财总＋CFO 合并特批');
    expect((await putRules({ ...OLD, pettyEscalationRole: 'finance_chief' })).status).toBe(200);
    expect((await config()).rules).toEqual({ ...OLD, pettyEscalationRole: 'finance_chief' });
  });
});

describe('各类事项的流程', () => {
  it('校验：1–6 级、会签 2–3 个不同的角色、角色要对、没有部门 / 不选履约执行人的不能放那一级、什么都不改要用清除', async () => {
    const role = (r: string) => ({ kind: 'role', role: r });
    const bad = async (docType: string, nodes: unknown[], code = 'GF_FLOW_INVALID') => {
      const r = await putFlow(docType, { nodes });
      expect(r.status, JSON.stringify(r.body)).toBe(code === 'BAD_REQUEST' ? 400 : 422);
      if (code !== 'BAD_REQUEST') expect(r.body.error.code).toBe(code);
      return r;
    };
    await bad('general', []);
    await bad(
      'general',
      Array.from({ length: 7 }, () => role('cfo')),
    );
    expect((await bad('general', [{ kind: 'all', roles: ['cfo'] }])).body.error.message).toContain('至少要 2 个角色');
    expect((await bad('general', [{ kind: 'all', roles: ['cfo', 'cfo'] }])).body.error.message).toContain('同一个角色只能放一次');
    await bad('general', [{ kind: 'all', roles: ['cfo', 'legal', 'hr', 'chairman'] }]);
    await bad('supplier_admission', [{ kind: 'dept_head' }]);
    await bad('expense', [{ kind: 'dept_head' }, { kind: 'performer' }]);
    await bad('general', [role('boss')], 'BAD_REQUEST');
    await bad('general', [{ kind: 'nobody' }], 'BAD_REQUEST');
    expect((await api(ctx.app, ctx.owner, 'PUT', '/api/gf/config/flows/nope', { ccRoles: [] })).status).toBe(400);
    expect((await putFlow('general', {})).body.error.code).toBe('GF_FLOW_EMPTY');
    expect((await clearFlow('general')).body.error.code).toBe('GF_FLOW_BUILTIN');
    const [cnt] = await ctx.sql`SELECT count(*)::int AS n FROM gf_flow_configs`;
    expect(cnt!.n).toBe(0);
  });

  it('设了流程：之后提交的按设的排（记第几版），已经在审的不变；知会按设的角色；清除后回到内置', async () => {
    const before = await newDoc(ctx, c('gf_clerk'), { departmentId: p.deptId, amountCents: yuan(5000) });
    expect(before.status, JSON.stringify(before.body)).toBe(200);
    expect(labels(await doc(before.body.id))).toEqual(['部门负责人', '财务、法务分别审核', '财总']);

    const saved = await putFlow('general', {
      nodes: [{ kind: 'dept_head' }, { kind: 'all', roles: ['finance_reviewer', 'cfo'], label: '财务＋CFO 会签' }, { kind: 'role', role: 'chairman', stage: 'final' }],
      ccRoles: ['business_gm'],
      note: '试点',
    });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    const g = saved.body.flows.find((f: { docType: string }) => f.docType === 'general');
    expect(g.active).toMatchObject({ version: 1, nodeLabels: ['部门负责人', '财务＋CFO 会签', '董事长'], ccRoles: ['business_gm'], note: '试点' });

    const after = await newDoc(ctx, c('gf_clerk'), { departmentId: p.deptId, amountCents: yuan(5000) });
    const a = await doc(after.body.id);
    expect(labels(a)).toEqual(['部门负责人', '财务＋CFO 会签', '董事长']);
    expect(a.notes[0]).toContain('第 1 版');
    const [f] = await ctx.sql`SELECT config_version FROM gf_flows WHERE doc_id = ${after.body.id}`;
    expect(f!.configVersion).toBe(1);
    // 在审的那张照旧
    expect(labels(await doc(before.body.id))).toEqual(['部门负责人', '财务、法务分别审核', '财总']);
    const [f0] = await ctx.sql`SELECT config_version FROM gf_flows WHERE doc_id = ${before.body.id}`;
    expect(f0!.configVersion).toBe(null);

    // 走完：会签两人、董事长终审；知会只发业态总经理
    expect((await act(ctx, c('gf_head'), after.body.id, 1)).status).toBe(200);
    expect((await act(ctx, c('gf_fin'), after.body.id, 2)).status).toBe(200);
    expect((await act(ctx, c('gf_cfo'), after.body.id, 2)).status).toBe(200);
    expect((await act(ctx, c('gf_chair'), after.body.id, 3)).status).toBe(200);
    const done = await doc(after.body.id);
    expect(done.status).toBe('to_execute');
    expect(done.cc.map((x: { role: string }) => x.role)).toEqual(['business_gm']);

    // 再存一版，只设知会（不知会）：审批链回到内置
    const v2 = await putFlow('general', { ccRoles: [] });
    expect(v2.body.flows.find((x: { docType: string }) => x.docType === 'general').active).toMatchObject({ version: 2, nodes: null, ccRoles: [] });
    const builtinChain = await newDoc(ctx, c('gf_clerk'), { departmentId: p.deptId, amountCents: yuan(5000) });
    expect(labels(await doc(builtinChain.body.id))).toEqual(['部门负责人', '财务、法务分别审核', '财总']);

    // 清除：回到内置（追加一版），历史都在
    const cleared = await clearFlow('general');
    expect(cleared.status).toBe(200);
    const view = cleared.body.flows.find((x: { docType: string }) => x.docType === 'general');
    expect(view.active).toBe(null);
    expect(view.lastChange).toMatchObject({ version: 3, cleared: true });
    const versions = (await api(ctx.app, ctx.owner, 'GET', '/api/gf/config/flows/general/versions')).body;
    expect(versions.map((v: { version: number; cleared: boolean }) => [v.version, v.cleared])).toEqual([
      [3, true],
      [2, false],
      [1, false],
    ]);
    const back = await newDoc(ctx, c('gf_clerk'), { departmentId: p.deptId, amountCents: yuan(5000) });
    expect(labels(await doc(back.body.id))).toEqual(['部门负责人', '财务、法务分别审核', '财总']);
    const ops = await ctx.sql<{ op: string }[]>`SELECT detail->>'op' AS op FROM audit_logs WHERE action = 'gf_config' AND target_type = 'gf_flow_config' ORDER BY id`;
    expect(ops.map((o) => o.op)).toEqual(['flow', 'flow', 'flow_clear']);
  });

  it('零星采购改了流程，超额的财总＋CFO 合并特批照样追加在最后', async () => {
    expect((await putFlow('petty_purchase', { nodes: [{ kind: 'dept_head' }, { kind: 'role', role: 'finance_chief', stage: 'final' }] })).status).toBe(200);
    const d = await dept('配置零星');
    const small = await petty(c('gf_clerk'), d, { amountCents: yuan(100) });
    expect(labels(await doc(small.body.docId))).toEqual(['部门负责人', '财总']);
    await ctx.sql`INSERT INTO gf_dept_quotas (department_id, effective_month, daily_cents, monthly_cents, doc_id) VALUES (${d}, ${`${new Date().toISOString().slice(0, 7)}-01`}, ${yuan(150)}, ${yuan(150)}, ${small.body.docId})`;
    const over = await petty(c('gf_clerk'), d, { amountCents: yuan(100) });
    expect(labels(await doc(over.body.docId))).toEqual(['部门负责人', '财总', '财总＋CFO 合并特批']);
    expect((await clearFlow('petty_purchase')).status).toBe(200);
  });
});

describe('试算', () => {
  it('列出每一级是谁、回避上移、知会；用的是哪一版', async () => {
    const r = await preview({ docType: 'general', amountCents: yuan(5000), departmentId: p.deptId, submittedBy: p.ids.gf_chief });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.source).toBe('builtin');
    expect(r.body.nodes.map((x: { label: string }) => x.label)).toEqual(['部门负责人', '财务、法务分别审核', 'CFO']);
    expect(r.body.nodes[0].seats[0].names).toEqual(['合成部门负责人']);
    expect(r.body.nodes[1].seats.map((s: { names: string[] }) => s.names)).toEqual([['合成财务审核'], ['合成法务']]);
    expect(r.body.notes.join('；')).toContain('财总回避');
    expect(r.body.cc.map((x: { role: string }) => x.role)).toEqual(['chairman', 'business_gm', 'finance_chief', 'cfo']);
    // 提交人不在知会名单里
    expect(r.body.cc.find((x: { role: string }) => x.role === 'finance_chief').names).toEqual([]);
    expect(r.body.warnings).toEqual([]);
    // 部门负责人本人提交：视同已确认
    const self = await preview({ docType: 'general', amountCents: yuan(100), departmentId: p.deptId, submittedBy: p.ids.gf_head });
    expect(self.body.nodes[0].seats[0].selfSkip).toBe(true);

    await putFlow('seal_use', { nodes: [{ kind: 'role', role: 'seal_keeper', stage: 'review' }], ccRoles: ['legal'] });
    const o = await preview({ docType: 'seal_use', departmentId: p.deptId });
    expect(o.body).toMatchObject({ source: 'override', version: 1 });
    expect(o.body.nodes[0].seats[0].names).toEqual(['合成章证管理员']);
    expect(o.body.cc).toEqual([{ role: 'legal', label: '法务', names: ['合成法务'] }]);
  });

  it('没人能审、部门没有负责人：只提示不报错', async () => {
    const noHead = await dept('配置无负责人', null);
    const r = await preview({ docType: 'general', amountCents: yuan(100), departmentId: noHead });
    expect(r.status).toBe(200);
    expect(r.body.warnings.join('；')).toContain('没有设负责人');
    // 章证管理员只有一人、他自己提交（审核级回避）：提交时会被拦
    const s = await preview({ docType: 'seal_use', departmentId: p.deptId, submittedBy: p.ids.gf_seal });
    expect(s.status).toBe(200);
    expect(s.body.warnings.join('；')).toContain('「章证管理员」现在没有可以审批的人');
    expect(s.body.nodes[0].seats[0].names).toEqual([]);
  });

  it('零星采购：带分级、额度与升级审核；内置流程要看单据内容的，没填排不出来只提示', async () => {
    const d = await dept('配置试算零星');
    const r = await preview({ docType: 'petty_purchase', amountCents: yuan(3000) + 1, departmentId: d, submittedBy: p.ids.gf_clerk, payload: { qty: 3 } });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.petty).toMatchObject({ tier: 'enhanced', escalationRole: 'finance_chief', quota: { dailyLimit: yuan(10_000), needSpecial: false } });
    expect(r.body.nodes.map((x: { label: string }) => x.label)).toEqual(['部门负责人', '财总']);
    const big = await preview({ docType: 'petty_purchase', amountCents: yuan(10_000) + 1, departmentId: d, submittedBy: p.ids.gf_clerk });
    expect(big.body.nodes.at(-1).label).toBe('财总＋CFO 合并特批');
    // 试算不占额度
    expect((await api(ctx.app, c('gf_ic'), 'GET', `/api/gf/petty/quota/${d}`)).body.dayFrozen).toBe(0);
    const hr = await preview({ docType: 'hr_batch', departmentId: p.deptId });
    expect(hr.status).toBe(200);
    expect(hr.body.nodes.length + hr.body.warnings.length).toBeGreaterThan(0);
  });
});
