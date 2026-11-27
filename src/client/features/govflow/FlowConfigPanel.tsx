// 业财法「流程与阈值」（店主配置，8.2.10，《业财法审批与 WCP 需求变更》A2，WB4，docs/V8210_GF_CONFIG.md）：
//   · 阈值：零星采购基础审核线、部门备用金日 / 月额度默认值、采购部门日累计、验收期限、超出基础审核的升级审核角色；
//   · 每类事项的流程：内置的还是自己设的（第几版、谁、什么时候），设 / 改（按顺序的节点：部门负责人、履约执行人、某个角色或签、几个角色会签）、
//     知会角色、清除（回到内置）；每次保存追加一版，已经提交的单不受影响；
//   · 试算（FlowPreview）：按现在的设置与角色映射排一遍，谁在每一级、哪里没人能审。

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react';
import { GF_ROLE_LABELS, GF_ROLES, nodeLabel, type GfMeta, type GfNode, type GfRole, type GfStage } from '@shared/govflow';
import { GF_CONFIG_MAX_COSIGN, GF_CONFIG_MAX_NODES, flowConfigProblems, type GfConfigOverview, type GfFlowConfigView } from '@shared/govflow-config';
import { escalationText, pettyBasicText, rulesYuan, type GfRules } from '@shared/govflow-petty';
import { centsToInput } from '@shared/money';
import { api, errorMessage } from '../../lib/api';
import { formatDateTime } from '../../lib/utils';
import { LoadFailed } from '../../components/LoadFailed';
import { Dialog } from '../../components/Overlay';
import { useToast } from '../../components/Toast';
import { Badge, Button, Card, Field, IconButton, Input, Select, Skeleton } from '../../components/ui';
import { yuanToCents } from './money';
import { FlowPreview } from './FlowPreview';

const STAGE_LABELS: Record<GfStage, string> = { review: '审核', final: '终审', special: '特批' };
const ccText = (roles: GfRole[] | null) => (roles === null ? '内置' : roles.length ? roles.map((r) => GF_ROLE_LABELS[r]).join('、') : '不知会');

export function FlowConfigPanel({ meta }: { meta: GfMeta }) {
  const q = useQuery({ queryKey: ['gf', 'config'], queryFn: () => api.get<GfConfigOverview>('/api/gf/config') });
  const [editing, setEditing] = useState<GfFlowConfigView | null>(null);
  if (q.isError && !q.data) return <LoadFailed title="流程与阈值没有加载出来" onRetry={() => void q.refetch()} />;
  if (!q.data) return <Skeleton className="h-40" />;
  return (
    <div className="space-y-3" data-testid="gf-config">
      <RulesCard data={q.data} />
      <Card className="space-y-2 p-4" data-testid="gf-config-flows">
        <h2 className="text-[15px] font-bold text-ink">各类事项的审批流程</h2>
        <p className="text-[13px] text-ink-3">
          不设就用内置的（按金额、类型自动排）。设了以后之后提交的单按设的走，已经提交的单仍按提交时排好的链；回避、内控加签照旧自动加。零星采购超额的「财总＋CFO 合并特批」照样追加在最后。
        </p>
        <ul className="divide-y divide-line">
          {q.data.flows.map((f) => (
            <FlowRow key={f.docType} flow={f} onEdit={() => setEditing(f)} />
          ))}
        </ul>
      </Card>
      <FlowPreview meta={meta} flows={q.data.flows} />
      {editing && <FlowEditor flow={editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

function useSaved() {
  const qc = useQueryClient();
  return (data: GfConfigOverview) => {
    qc.setQueryData(['gf', 'config'], data);
    void qc.invalidateQueries({ queryKey: ['gf', 'settings'] });
  };
}

// ───────────────────────── 阈值 ─────────────────────────

type CentsKey = 'pettyBasicCents' | 'deptDailyCents' | 'deptMonthlyCents' | 'purchaseDeptDailyCents';
const CENTS_FIELDS: { key: CentsKey; label: string }[] = [
  { key: 'pettyBasicCents', label: '零星采购基础审核金额（元）' },
  { key: 'deptDailyCents', label: '部门备用金日额度（元，没核定过的部门）' },
  { key: 'deptMonthlyCents', label: '部门备用金月额度（元，没核定过的部门）' },
  { key: 'purchaseDeptDailyCents', label: '采购部门当日累计（元）' },
];

function RulesCard({ data }: { data: GfConfigOverview }) {
  const toast = useToast();
  const saved = useSaved();
  const r = data.rules;
  const [money, setMoney] = useState<Record<CentsKey, string>>(() => ({
    pettyBasicCents: centsToInput(r.pettyBasicCents),
    deptDailyCents: centsToInput(r.deptDailyCents),
    deptMonthlyCents: centsToInput(r.deptMonthlyCents),
    purchaseDeptDailyCents: centsToInput(r.purchaseDeptDailyCents),
  }));
  const [qty, setQty] = useState(String(r.pettyBasicQty));
  const [days, setDays] = useState(String(r.pettyAcceptDays));
  const [role, setRole] = useState<GfRole | ''>(r.pettyEscalationRole ?? '');
  const [reason, setReason] = useState('');
  const cents = Object.fromEntries(CENTS_FIELDS.map((f) => [f.key, yuanToCents(money[f.key])])) as Record<CentsKey, number | null>;
  const valid = CENTS_FIELDS.every((f) => cents[f.key] !== null) && /^\d+$/.test(qty) && /^\d+$/.test(days);
  const save = useMutation({
    mutationFn: () =>
      api.put<GfConfigOverview>('/api/gf/config/rules', {
        ...(cents as Record<CentsKey, number>),
        pettyBasicQty: Number(qty),
        pettyAcceptDays: Number(days),
        pettyEscalationRole: role || null,
        reason,
      } satisfies GfRules & { reason: string }),
    onSuccess: (d) => {
      saved(d);
      setReason('');
      toast({ tone: 'success', title: '阈值已保存', body: '之后提交、预检的按新的算' });
    },
    onError: (e) => toast({ tone: 'error', title: '没有保存', body: errorMessage(e) }),
  });
  const d = data.defaults;
  return (
    <Card className="space-y-3 p-4" data-testid="gf-config-rules">
      <div className="flex flex-wrap items-baseline gap-2">
        <h2 className="text-[15px] font-bold text-ink">阈值</h2>
        <span className="text-[12.5px] text-ink-3">
          现在：基础审核 {pettyBasicText(r)}，部门日 {rulesYuan(r.deptDailyCents)} / 月 {rulesYuan(r.deptMonthlyCents)}，采购部门日 {rulesYuan(r.purchaseDeptDailyCents)}，
          {escalationText(r.pettyEscalationRole)}
          {data.rulesUpdatedBy && data.rulesUpdatedAt ? ` · ${data.rulesUpdatedBy} ${formatDateTime(data.rulesUpdatedAt)} 改` : ' · 预置值'}
        </span>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        {CENTS_FIELDS.map((f) => (
          <Field key={f.key} label={f.label} hint={`预置 ${rulesYuan(d[f.key])}`} htmlFor={`gf-rule-${f.key}`}>
            <Input id={`gf-rule-${f.key}`} inputMode="decimal" value={money[f.key]} onChange={(e) => setMoney({ ...money, [f.key]: e.target.value })} data-testid={`gf-rule-${f.key}`} />
          </Field>
        ))}
        <Field label="零星采购基础审核件数" hint={`预置 ${d.pettyBasicQty} 件`} htmlFor="gf-rule-qty">
          <Input id="gf-rule-qty" inputMode="numeric" value={qty} onChange={(e) => setQty(e.target.value)} data-testid="gf-rule-pettyBasicQty" />
        </Field>
        <Field label="审批通过后几天内验收" hint={`预置 ${d.pettyAcceptDays} 天`} htmlFor="gf-rule-days">
          <Input id="gf-rule-days" inputMode="numeric" value={days} onChange={(e) => setDays(e.target.value)} />
        </Field>
        <Field label="超出基础审核时由谁审（升级审核）" hint="预置财总（财务负责人）；不升级就照旧财务审核人" htmlFor="gf-rule-escalation">
          <Select id="gf-rule-escalation" value={role} onChange={(e) => setRole(e.target.value as GfRole | '')} data-testid="gf-rule-escalation">
            <option value="">不升级（财务审核人）</option>
            {GF_ROLES.map((x) => (
              <option key={x} value={x}>
                {GF_ROLE_LABELS[x]}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="修改原因（选填）" htmlFor="gf-rule-reason">
          <Input id="gf-rule-reason" value={reason} maxLength={200} onChange={(e) => setReason(e.target.value)} />
        </Field>
      </div>
      <p className="text-[12.5px] text-ink-3">核定过额度的部门照核定的；日 / 月累计按部门、按提交时间、只算有效单（驳回、撤回的不算）。</p>
      <div className="flex justify-end">
        <Button disabled={!valid} loading={save.isPending} onClick={() => save.mutate()} data-testid="gf-rule-save">
          保存阈值
        </Button>
      </div>
    </Card>
  );
}

// ───────────────────────── 流程 ─────────────────────────

function FlowRow({ flow, onEdit }: { flow: GfFlowConfigView; onEdit: () => void }) {
  const toast = useToast();
  const saved = useSaved();
  const clear = useMutation({
    mutationFn: () => api.post<GfConfigOverview>(`/api/gf/config/flows/${flow.docType}/clear`, {}),
    onSuccess: (d) => {
      saved(d);
      toast({ tone: 'success', title: `「${flow.label}」已恢复内置流程` });
    },
    onError: (e) => toast({ tone: 'error', title: '没有清除', body: errorMessage(e) }),
  });
  const a = flow.active;
  return (
    <li className="flex flex-wrap items-center gap-2 py-2 text-[13.5px]" data-testid={`gf-flow-${flow.docType}`}>
      <span className="w-28 shrink-0 font-semibold text-ink">{flow.label}</span>
      {a ? <Badge tone="yuzu">自定义 第 {a.version} 版</Badge> : <Badge>内置</Badge>}
      <span className="min-w-0 flex-1 text-ink-2">
        {a?.nodeLabels ? a.nodeLabels.join(' → ') : flow.builtinNote}
        <span className="ml-1.5 text-[12.5px] text-ink-3">知会：{ccText(a?.ccRoles ?? null)}</span>
        {flow.lastChange && (
          <span className="ml-1.5 text-[12px] text-ink-3">
            · {flow.lastChange.cleared ? '清除' : '保存'}于 {formatDateTime(flow.lastChange.at)}（{flow.lastChange.byName}）
          </span>
        )}
      </span>
      <Button size="sm" variant="ghost" onClick={onEdit} data-testid={`gf-flow-edit-${flow.docType}`}>
        {a ? '修改' : '自定义'}
      </Button>
      {a && (
        <Button size="sm" variant="ghost" loading={clear.isPending} onClick={() => clear.mutate()} data-testid={`gf-flow-clear-${flow.docType}`}>
          恢复内置
        </Button>
      )}
    </li>
  );
}

type Kind = GfNode['kind'];
interface Row {
  kind: Kind;
  roles: (GfRole | '')[];
  stage: GfStage;
  label: string;
}
const KIND_LABELS: Record<Kind, string> = { dept_head: '部门负责人', performer: '内部履约执行人', role: '某个角色（或签：任一人同意）', all: '几个角色会签（各一人同意）' };

const toRow = (n: GfNode): Row =>
  n.kind === 'role'
    ? { kind: 'role', roles: [n.role], stage: n.stage ?? 'final', label: '' }
    : n.kind === 'all'
      ? { kind: 'all', roles: [...n.roles], stage: n.stage ?? 'review', label: n.label ?? '' }
      : { kind: n.kind, roles: [], stage: n.stage ?? 'review', label: '' };

function toNode(r: Row): GfNode {
  const roles = r.roles.filter((x): x is GfRole => !!x);
  if (r.kind === 'role') return { kind: 'role', role: roles[0] ?? 'finance_reviewer', stage: r.stage };
  if (r.kind === 'all') return { kind: 'all', roles, ...(r.label.trim() ? { label: r.label.trim() } : {}), stage: r.stage };
  return { kind: r.kind, stage: r.stage };
}

function FlowEditor({ flow, onClose }: { flow: GfFlowConfigView; onClose: () => void }) {
  const toast = useToast();
  const saved = useSaved();
  const a = flow.active;
  const [chain, setChain] = useState(!!a?.nodes || !a);
  const [rows, setRows] = useState<Row[]>(() => (a?.nodes ? a.nodes.map(toRow) : [{ kind: flow.allowsDeptHead ? 'dept_head' : 'role', roles: ['finance_reviewer'], stage: 'final', label: '' }]));
  const [cc, setCc] = useState(!!a?.ccRoles);
  const [ccRoles, setCcRoles] = useState<GfRole[]>(a?.ccRoles ?? []);
  const [note, setNote] = useState('');
  const nodes = rows.map(toNode);
  const problems = chain ? [...flowConfigProblems(flow.docType, nodes), ...(rows.some((r) => r.kind === 'role' && !r.roles[0]) ? ['或签那一级要选角色'] : [])] : [];
  const set = (i: number, patch: Partial<Row>) => setRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const move = (i: number, d: -1 | 1) => {
    const next = [...rows];
    [next[i], next[i + d]] = [next[i + d]!, next[i]!];
    setRows(next);
  };
  const save = useMutation({
    mutationFn: () => api.put<GfConfigOverview>(`/api/gf/config/flows/${flow.docType}`, { nodes: chain ? nodes : null, ccRoles: cc ? ccRoles : null, note }),
    onSuccess: (d) => {
      saved(d);
      toast({ tone: 'success', title: `「${flow.label}」的流程已保存`, body: '之后提交的单按新的走' });
      onClose();
    },
    onError: (e) => toast({ tone: 'error', title: '没有保存', body: errorMessage(e) }),
  });
  const kinds = (Object.keys(KIND_LABELS) as Kind[]).filter((k) => (k !== 'dept_head' || flow.allowsDeptHead) && (k !== 'performer' || flow.allowsPerformer));
  return (
    <Dialog open onClose={onClose} title={`「${flow.label}」的审批流程`} width="max-w-2xl">
      <div className="space-y-3" data-testid="gf-flow-editor">
        <p className="text-[12.5px] text-ink-3">内置：{flow.builtinNote}</p>
        <label className="flex items-center gap-2 text-[14px] font-semibold text-ink">
          <input type="checkbox" checked={chain} onChange={(e) => setChain(e.target.checked)} data-testid="gf-flow-chain-toggle" />
          自己设审批链（不勾就用内置的）
        </label>
        {chain && (
          <ol className="space-y-2">
            {rows.map((r, i) => (
              <li key={i} className="space-y-2 rounded-xl border border-line p-2.5" data-testid={`gf-flow-node-${i}`}>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[13px] font-semibold text-ink-2">第 {i + 1} 级</span>
                  <Select
                    className="min-w-0 flex-1"
                    value={r.kind}
                    onChange={(e) => set(i, { kind: e.target.value as Kind, roles: e.target.value === 'all' ? ['finance_chief', 'cfo'] : r.roles.slice(0, 1) })}
                    data-testid={`gf-flow-kind-${i}`}
                  >
                    {kinds.map((k) => (
                      <option key={k} value={k}>
                        {KIND_LABELS[k]}
                      </option>
                    ))}
                  </Select>
                  <Select className="w-24" value={r.stage} onChange={(e) => set(i, { stage: e.target.value as GfStage })} aria-label="这一级的性质">
                    {(Object.keys(STAGE_LABELS) as GfStage[]).map((s) => (
                      <option key={s} value={s}>
                        {STAGE_LABELS[s]}
                      </option>
                    ))}
                  </Select>
                  <IconButton label="上移" disabled={i === 0} onClick={() => move(i, -1)}>
                    <ArrowUp className="size-4" />
                  </IconButton>
                  <IconButton label="下移" disabled={i === rows.length - 1} onClick={() => move(i, 1)} data-testid={`gf-flow-down-${i}`}>
                    <ArrowDown className="size-4" />
                  </IconButton>
                  <IconButton label="删掉这一级" disabled={rows.length === 1} onClick={() => setRows(rows.filter((_, j) => j !== i))}>
                    <Trash2 className="size-4" />
                  </IconButton>
                </div>
                {(r.kind === 'role' || r.kind === 'all') && (
                  <div className="flex flex-wrap gap-2">
                    {Array.from({ length: r.kind === 'role' ? 1 : GF_CONFIG_MAX_COSIGN }, (_, k) => (
                      <Select
                        key={k}
                        className="min-w-0 flex-1"
                        value={r.roles[k] ?? ''}
                        onChange={(e) => {
                          const roles = [...r.roles];
                          roles[k] = e.target.value as GfRole | '';
                          set(i, { roles: roles.filter((x, idx) => x || idx < k) });
                        }}
                        data-testid={`gf-flow-role-${i}-${k}`}
                      >
                        <option value="">{k < (r.kind === 'role' ? 1 : 2) ? '选角色' : '（不加）'}</option>
                        {GF_ROLES.map((x) => (
                          <option key={x} value={x}>
                            {GF_ROLE_LABELS[x]}
                          </option>
                        ))}
                      </Select>
                    ))}
                    {r.kind === 'all' && <Input className="min-w-0 flex-1" placeholder="这一级的名称（选填）" maxLength={30} value={r.label} onChange={(e) => set(i, { label: e.target.value })} />}
                  </div>
                )}
              </li>
            ))}
          </ol>
        )}
        {chain && rows.length < GF_CONFIG_MAX_NODES && (
          <Button
            size="sm"
            variant="secondary"
            icon={<Plus className="size-4" />}
            onClick={() => setRows([...rows, { kind: 'role', roles: ['finance_chief'], stage: 'final', label: '' }])}
            data-testid="gf-flow-add"
          >
            加一级
          </Button>
        )}
        {chain && !problems.length && <p className="text-[12.5px] text-ink-3">排出来：{nodes.map(nodeLabel).join(' → ')}</p>}
        <label className="flex items-center gap-2 text-[14px] font-semibold text-ink">
          <input type="checkbox" checked={cc} onChange={(e) => setCc(e.target.checked)} data-testid="gf-flow-cc-toggle" />
          自己设通过后知会谁（不勾就用内置的；勾了一个都不选 = 不知会）
        </label>
        {cc && (
          <div className="flex flex-wrap gap-x-3 gap-y-1.5">
            {GF_ROLES.map((x) => (
              <label key={x} className="flex items-center gap-1.5 text-[13px] text-ink-2">
                <input
                  type="checkbox"
                  checked={ccRoles.includes(x)}
                  onChange={(e) => setCcRoles(e.target.checked ? [...ccRoles, x] : ccRoles.filter((y) => y !== x))}
                  data-testid={`gf-flow-cc-${x}`}
                />
                {GF_ROLE_LABELS[x]}
              </label>
            ))}
          </div>
        )}
        <Field label="说明（选填）" htmlFor="gf-flow-note">
          <Input id="gf-flow-note" value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} placeholder="例如：财务部调整分工" />
        </Field>
        {problems.length > 0 && (
          <ul className="list-disc space-y-0.5 pl-5 text-[13px] text-clay" data-testid="gf-flow-problems">
            {problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button disabled={problems.length > 0 || (!chain && !cc)} loading={save.isPending} onClick={() => save.mutate()} data-testid="gf-flow-save">
            保存（新的一版）
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
