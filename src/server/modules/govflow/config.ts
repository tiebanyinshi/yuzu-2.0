// 业财法「流程与阈值」（8.2.15，《业财法审批与 WCP 需求变更》A2，WB4，设计见 docs/V8215_GF_CONFIG.md）。都要「配置业财法角色」权限（gf.roles，店主）。
//   GET  /api/gf/config                          阈值（含默认值）+ 每类事项现在用的流程
//   PUT  /api/gf/config/rules                    改阈值（写操作日志，带改前改后）
//   PUT  /api/gf/config/flows/:docType           存这类事项自己的流程（审批链 / 知会角色），追加一版
//   POST /api/gf/config/flows/:docType/clear     清除，恢复内置流程（也是追加一版）
//   GET  /api/gf/config/flows/:docType/versions  这类事项的历史版本
//   POST /api/gf/config/preview                  试算：按现在的设置与角色映射排一遍链，谁在每一级，没人能审的只提示不报错
// 锁：同一类事项的保存串行（advisory lock gf_flow_config:<类型>），版本号在锁里取最大 + 1。

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { GF_CC_ROLES, GF_DOC_TYPES, GF_DOC_TYPE_LABELS, GF_FLAGS, GF_ROLE_LABELS, GF_ROLES, nodeLabel, planFlow, seatsFor, seatsOf, type GfDocType, type GfNode, type GfRole } from '@shared/govflow';
import {
  GF_BUILTIN_FLOW_NOTES,
  GF_PREVIEW_PAYLOAD_HINTS,
  configAllowsDeptHead,
  configAllowsPerformer,
  flowConfigProblems,
  type GfConfigOverview,
  type GfFlowConfigView,
  type GfPreviewResult,
} from '@shared/govflow-config';
import { DEFAULT_GF_RULES } from '@shared/govflow-petty';
import type { Db } from '../../db';
import { guard } from '../../auth/guard';
import { writeAudit } from '../../lib/audit';
import type { Actor, Deps } from '../../lib/context';
import { todayIn } from '../../lib/dates';
import { unprocessable } from '../../lib/errors';
import { parse } from '../../lib/validate';
import { activeFlowConfig, approverProblems, ccRolesFor, deptHeadOf, loadMembers, seatLabel, type DocRow } from './engine';
import { assess } from './petty';
import { RulesInput, loadGfRules, loadGfRulesMeta } from './rules';
import { resolveTemplate } from './types';

const iso = (d: Date | string) => new Date(d).toISOString();
const DocTypeParam = z.object({ docType: z.enum(GF_DOC_TYPES, '没有这类事项') });

const Stage = z.enum(['review', 'final', 'special']);
const NodeInput = z.discriminatedUnion(
  'kind',
  [
    z.object({ kind: z.literal('dept_head'), stage: Stage.default('review') }),
    z.object({ kind: z.literal('performer'), stage: Stage.default('review') }),
    z.object({ kind: z.literal('role'), role: z.enum(GF_ROLES, '角色不对'), stage: Stage.default('final') }),
    z.object({
      kind: z.literal('all'),
      roles: z.array(z.enum(GF_ROLES, '角色不对')).min(1).max(6),
      label: z.string().trim().max(30, '这一级的名称最多 30 个字').optional(),
      stage: Stage.default('review'),
    }),
  ],
  { error: '每一级要选审批人类型' },
);
const FlowInput = z.object({
  /** 空 = 审批链用内置的 */
  nodes: z.array(NodeInput).max(20).nullable().default(null),
  /** 空 = 知会用内置的；[] = 不知会 */
  ccRoles: z.array(z.enum(GF_ROLES, '知会角色不对')).max(GF_ROLES.length).nullable().default(null),
  note: z.string().trim().max(200, '说明最多 200 个字').default(''),
});
const RulesSave = RulesInput.safeExtend({ reason: z.string().trim().max(200, '原因最多 200 个字').default('') });

const PreviewInput = z.object({
  docType: z.enum(GF_DOC_TYPES, '请选事项类型'),
  amountCents: z.number().int().min(0, '金额不能是负数').max(100_000_000_000).default(0),
  flags: z.array(z.enum(GF_FLAGS)).max(GF_FLAGS.length).default([]),
  departmentId: z.number().int().positive().nullable().default(null),
  entityId: z.number().int().positive().nullable().default(null),
  performerId: z.number().int().positive().nullable().default(null),
  subjectStaffId: z.number().int().positive().nullable().default(null),
  /** 谁提交（回避、负责人本人发起按这个人算）；不填按自己 */
  submittedBy: z.number().int().positive().nullable().default(null),
  /** 内置流程要看的单据字段（GF_PREVIEW_PAYLOAD_HINTS），尽量照填 */
  payload: z.record(z.string(), z.unknown()).default({}),
});

/** 存进库的节点：会签没写名称的不存空串（显示时按角色拼） */
const cleanNode = (n: z.infer<typeof NodeInput>): GfNode => (n.kind === 'all' ? { kind: 'all', roles: n.roles, ...(n.label ? { label: n.label } : {}), stage: n.stage } : n);

async function overview(db: Db): Promise<GfConfigOverview> {
  const rules = await loadGfRules(db);
  const meta = await loadGfRulesMeta(db);
  const rows = await db<{ docType: GfDocType; version: number; enabled: boolean; nodes: GfNode[] | null; ccRoles: GfRole[] | null; note: string; byName: string; createdAt: Date }[]>`
    SELECT DISTINCT ON (c.doc_type) c.doc_type, c.version, c.enabled, c.nodes, c.cc_roles, c.note, s.display_name AS by_name, c.created_at
    FROM gf_flow_configs c JOIN staff s ON s.id = c.created_by ORDER BY c.doc_type, c.version DESC`;
  const latest = new Map(rows.map((r) => [r.docType, r]));
  const flows = GF_DOC_TYPES.map((docType): GfFlowConfigView => {
    const r = latest.get(docType);
    return {
      docType,
      label: GF_DOC_TYPE_LABELS[docType],
      builtinNote: GF_BUILTIN_FLOW_NOTES[docType],
      active:
        r && r.enabled
          ? {
              version: r.version,
              nodes: r.nodes,
              nodeLabels: r.nodes ? r.nodes.map(nodeLabel) : null,
              ccRoles: r.ccRoles,
              note: r.note,
              byName: r.byName,
              at: iso(r.createdAt),
            }
          : null,
      lastChange: r ? { version: r.version, cleared: !r.enabled, byName: r.byName, at: iso(r.createdAt) } : null,
      allowsDeptHead: configAllowsDeptHead(docType),
      allowsPerformer: configAllowsPerformer(docType),
      payloadHint: GF_PREVIEW_PAYLOAD_HINTS[docType] ?? null,
    };
  });
  return { rules, defaults: DEFAULT_GF_RULES, rulesUpdatedBy: meta.by, rulesUpdatedAt: meta.at ? iso(meta.at) : null, flows };
}

/** 追加一版（保存或清除）；同一类事项串行 */
async function appendVersion(deps: Deps, actor: Actor, docType: GfDocType, row: { enabled: boolean; nodes: GfNode[] | null; ccRoles: GfRole[] | null; note: string }, ip?: string) {
  await deps.sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`gf_flow_config:${docType}`}, 0))`;
    const before = await activeFlowConfig(tx, docType);
    if (!row.enabled && !before) throw unprocessable('GF_FLOW_BUILTIN', '这类事项现在用的就是内置流程，不用清除');
    const [v] = await tx<{ next: number }[]>`SELECT coalesce(max(version), 0) + 1 AS next FROM gf_flow_configs WHERE doc_type = ${docType}`;
    const version = Number(v!.next);
    await tx`
      INSERT INTO gf_flow_configs (doc_type, version, enabled, nodes, cc_roles, note, created_by)
      VALUES (${docType}, ${version}, ${row.enabled}, ${row.nodes ? tx.json(row.nodes as never) : null}, ${row.ccRoles}, ${row.note}, ${actor.id})`;
    await writeAudit(tx, {
      staffId: actor.id,
      action: 'gf_config',
      targetType: 'gf_flow_config',
      targetId: docType,
      detail: {
        op: row.enabled ? 'flow' : 'flow_clear',
        docType,
        version,
        before: before ? { version: before.version, nodes: before.nodes, ccRoles: before.ccRoles } : null,
        after: row.enabled ? { nodes: row.nodes, ccRoles: row.ccRoles } : null,
        note: row.note,
      },
      ip,
    });
  });
}

/** 试算：和提交时一样排链（模板 → planFlow → 每一级有没有人能审），但不写库、问题只提示 */
async function preview(deps: Deps, actor: Actor, raw: unknown): Promise<GfPreviewResult> {
  const db = deps.sql;
  const input = parse(PreviewInput, raw);
  const submittedBy = input.submittedBy ?? actor.id;
  const payload: Record<string, unknown> = { ...input.payload };
  const warnings: string[] = [];
  let petty: GfPreviewResult['petty'] = null;
  if (input.docType === 'petty_purchase') {
    if (input.departmentId === null) warnings.push('零星采购要选费用承担部门才能算额度（没选的按不超额度排）');
    else {
      const rules = await loadGfRules(db);
      const qty = Number.isInteger(payload.qty) && Number(payload.qty) > 0 ? Number(payload.qty) : 1;
      const supplierName = typeof payload.supplierName === 'string' && payload.supplierName.trim().length >= 2 ? payload.supplierName.trim() : '（试算）';
      const a = await assess(
        db,
        { id: submittedBy },
        { departmentId: input.departmentId, supplierName, items: '试算', qty, amountCents: Math.max(1, input.amountCents), kind: 'goods', urgent: payload.urgent === true, quoteNote: '试算比价' },
        todayIn(deps.config.timezone),
        { skipOverdue: true },
      );
      payload.tier = a.preview.tier;
      payload.needSpecial = a.needSpecial;
      petty = { tier: a.preview.tier, quota: a.preview.quota, purchaseDept: a.preview.purchaseDept, escalationRole: rules.pettyEscalationRole };
      if (a.preview.blockedReason && a.preview.purchaseDept === 'formal') warnings.push(a.preview.blockedReason);
    }
  }
  const doc: DocRow = {
    id: 0,
    bizNo: '',
    docType: input.docType,
    title: '试算',
    entityId: input.entityId,
    departmentId: input.departmentId,
    amountCents: input.amountCents,
    flags: input.flags,
    performerId: input.performerId,
    subjectStaffId: input.subjectStaffId,
    createdBy: submittedBy,
    version: 0,
    withdrawnAt: null,
    execStartedAt: null,
    completedAt: null,
    archivedAt: null,
    dueOn: null,
    backfillOpen: false,
    payload,
  };
  const empty = { docType: input.docType, nodes: [], notes: [], cc: [], petty };
  let resolved: Awaited<ReturnType<typeof resolveTemplate>>;
  try {
    resolved = await resolveTemplate(db, doc);
  } catch {
    const hint = GF_PREVIEW_PAYLOAD_HINTS[input.docType];
    return { ...empty, source: 'builtin', version: null, warnings: [...warnings, `这类事项的内置流程要看单据内容，排不出来${hint ? `：请在单据字段里填 ${hint}` : ''}`] };
  }
  const template = resolved.nodes;
  const members = await loadMembers(db, input.entityId);
  const deptHeadId = await deptHeadOf(db, input.departmentId);
  if (template.some((n) => n.kind === 'dept_head') && deptHeadId === null) warnings.push('费用承担部门还没有设负责人（或没选部门、负责人已停用）：提交时会被拦');
  if (template.some((n) => n.kind === 'performer') && input.performerId === null) warnings.push('这条流程有「内部履约执行人」一级，单据上要先选人：提交时会被拦');
  const plan = planFlow(template, { members, deptHeadId, performerId: input.performerId, submittedBy, subjectStaffId: input.subjectStaffId, flags: input.flags });
  const ctx = { members, deptHeadId, performerId: input.performerId, submittedBy, subjectStaffId: input.subjectStaffId };
  for (const p of approverProblems(plan.nodes, ctx)) warnings.push(`提交时会被拦：${p.message}`);
  const ccRoles = (await ccRolesFor(db, doc)) ?? GF_CC_ROLES;
  const ids = [...new Set([...Object.values(members).flat(), ...(deptHeadId ? [deptHeadId] : []), ...(input.performerId ? [input.performerId] : [])])];
  const names = new Map(ids.length ? (await db<{ id: number; name: string }[]>`SELECT id, display_name AS name FROM staff WHERE id IN ${db(ids)}`).map((s) => [Number(s.id), s.name]) : []);
  const nameOf = (id: number) => names.get(id) ?? `#${id}`;
  return {
    docType: input.docType,
    source: resolved.config?.nodes ? 'override' : 'builtin',
    version: resolved.config?.nodes ? resolved.config.version : null,
    nodes: plan.nodes.map((node, i) => ({
      level: i + 1,
      label: nodeLabel(node),
      stage: node.stage ?? 'review',
      seats: seatsOf(node).map((seat) => {
        const pool = seat === 'dept_head' ? (deptHeadId ? [deptHeadId] : []) : seat === 'performer' ? (input.performerId ? [input.performerId] : []) : (members[seat] ?? []);
        const selfSkip = (seat === 'dept_head' && deptHeadId === submittedBy) || (seat === 'performer' && input.performerId === submittedBy);
        return { seat, label: seatLabel(seat), names: pool.filter((id) => seatsFor(node, id, ctx).includes(seat as never)).map(nameOf), selfSkip };
      }),
    })),
    notes: resolved.config?.nodes ? [`按「流程与阈值」里设置的流程（第 ${resolved.config.version} 版）`, ...plan.notes] : plan.notes,
    cc: ccRoles.map((role) => ({ role, label: GF_ROLE_LABELS[role], names: (members[role] ?? []).filter((id) => id !== submittedBy).map(nameOf) })),
    warnings,
    petty,
  };
}

export function registerGfConfigRoutes(app: FastifyInstance, deps: Deps) {
  const { sql } = deps;
  const manage = guard('gf.roles');

  app.get('/api/gf/config', { preHandler: manage }, async () => overview(sql));

  app.put('/api/gf/config/rules', { preHandler: manage }, async (req) => {
    const { reason, ...after } = parse(RulesSave, req.body);
    await sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtextextended('gf_rules', 0))`;
      const before = await loadGfRules(tx);
      if ((Object.keys(after) as (keyof typeof after)[]).every((k) => before[k] === after[k])) throw unprocessable('GF_RULES_SAME', '没有改动');
      await tx`
        INSERT INTO gf_settings (key, value, updated_by) VALUES ('rules', ${tx.json(after as never)}, ${req.actor.id})
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`;
      await writeAudit(tx, { staffId: req.actor.id, action: 'gf_config', targetType: 'gf_settings', targetId: 'rules', detail: { op: 'rules', before, after, reason }, ip: req.ip });
    });
    return overview(sql);
  });

  app.put('/api/gf/config/flows/:docType', { preHandler: manage }, async (req) => {
    const { docType } = parse(DocTypeParam, req.params);
    const input = parse(FlowInput, req.body);
    if (input.nodes === null && input.ccRoles === null) throw unprocessable('GF_FLOW_EMPTY', '审批链和知会都没改；要恢复内置流程请用「清除」');
    const nodes = input.nodes ? input.nodes.map(cleanNode) : null;
    const problems = nodes ? flowConfigProblems(docType, nodes) : [];
    if (problems.length) throw unprocessable('GF_FLOW_INVALID', problems.join('；'), { problems });
    const ccRoles = input.ccRoles ? [...new Set(input.ccRoles)] : null;
    await appendVersion(deps, req.actor, docType, { enabled: true, nodes, ccRoles, note: input.note }, req.ip);
    return overview(sql);
  });

  app.post('/api/gf/config/flows/:docType/clear', { preHandler: manage }, async (req) => {
    const { docType } = parse(DocTypeParam, req.params);
    const { note } = parse(z.object({ note: z.string().trim().max(200, '说明最多 200 个字').default('') }), req.body ?? {});
    await appendVersion(deps, req.actor, docType, { enabled: false, nodes: null, ccRoles: null, note }, req.ip);
    return overview(sql);
  });

  app.get('/api/gf/config/flows/:docType/versions', { preHandler: manage }, async (req) => {
    const { docType } = parse(DocTypeParam, req.params);
    const rows = await sql<{ version: number; enabled: boolean; nodes: GfNode[] | null; ccRoles: GfRole[] | null; note: string; byName: string; createdAt: Date }[]>`
      SELECT c.version, c.enabled, c.nodes, c.cc_roles, c.note, s.display_name AS by_name, c.created_at
      FROM gf_flow_configs c JOIN staff s ON s.id = c.created_by WHERE c.doc_type = ${docType} ORDER BY c.version DESC LIMIT 100`;
    return rows.map((r) => ({
      version: r.version,
      cleared: !r.enabled,
      nodeLabels: r.nodes ? r.nodes.map(nodeLabel) : null,
      ccRoles: r.ccRoles,
      note: r.note,
      byName: r.byName,
      at: iso(r.createdAt),
    }));
  });

  app.post('/api/gf/config/preview', { preHandler: manage }, async (req) => preview(deps, req.actor, req.body));
}
