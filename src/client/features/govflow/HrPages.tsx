// 业财法 P07（docs/APPROVAL_V4.md 第 11 节）：HR 付款批次与费用分摊。
//   /oa/gov?box=hr    HR 生成批次（凭证必备、异常批次关联原批次）；财务的分摊规则（版本）、执行与冲正
// 事项详情里（HrBatchPanel）：批次要点、人员明细（最小权限）、出纳复核三项一致后付款。

import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { GfDocDetail, GfMeta } from '@shared/govflow';
import {
  HR_BATCH_KINDS,
  HR_BATCH_KIND_LABELS,
  HR_EVIDENCE_LABELS,
  isAbnormalBatch,
  requiredEvidence,
  type AllocRuleView,
  type AllocRunView,
  type HrBatchKind,
  type HrBatchView,
} from '@shared/govflow-hr';
import { api, errorMessage } from '../../lib/api';
import { formatDateTime, uuid } from '../../lib/utils';
import { DataTable } from '../../components/DataTable';
import { Money } from '../../components/Money';
import { Dialog } from '../../components/Overlay';
import { useToast } from '../../components/Toast';
import { Badge, Button, Card, Field, Input, Select, Textarea } from '../../components/ui';
import { yuanToCents } from './money';

export function HrPanel({ meta }: { meta: GfMeta }) {
  const [open, setOpen] = useState(false);
  const finance = meta.canManageRoles || meta.myRoles.some((r) => r === 'finance_reviewer' || r === 'finance_chief' || r === 'cfo');
  return (
    <div className="space-y-3" data-testid="gf-hr">
      <Card className="space-y-2 p-4 text-[13px] text-ink-2">
        <p>工资 / 提成先由主责部门确认业绩与计算依据，再 HR 复核 → 财务复核 → 财总＋CFO 共同审批（不看金额，异常批次也一样）→ 出纳复核人数、总额、账户三者一致后付款。</p>
        <p>实物福利、福利商品、活动服务走采购合同＋供应商入库；员工个人报销走普通报销。薪资明细只给 HR、财务、出纳看，不做大范围知会。</p>
        {meta.myRoles.includes('hr') && (
          <Button size="sm" onClick={() => setOpen(true)} data-testid="gf-hr-new">
            生成付款批次
          </Button>
        )}
      </Card>
      {finance && <AllocSection meta={meta} />}
      {open && <BatchDialog meta={meta} onClose={() => setOpen(false)} />}
    </div>
  );
}

function BatchDialog({ meta, onClose }: { meta: GfMeta; onClose: () => void }) {
  const navigate = useNavigate();
  const toast = useToast();
  const [clientKey] = useState(uuid);
  const now = new Date();
  const [f, setF] = useState({
    kind: 'salary' as HrBatchKind,
    period: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`,
    departmentId: '' as number | '',
    originalBatchNo: '',
    reason: '',
  });
  const [evidence, setEvidence] = useState<Record<string, string>>({});
  const [lines, setLines] = useState<{ staffId: number | ''; amount: string; account: string; costDeptId: number | '' }[]>([{ staffId: '', amount: '', account: '', costDeptId: '' }]);
  const req = requiredEvidence(f.kind);
  const m = useMutation({
    mutationFn: () =>
      api.post<{ docId: number }>('/api/gf/hr-batches', {
        clientKey,
        kind: f.kind,
        period: f.period,
        departmentId: f.departmentId,
        originalBatchNo: f.originalBatchNo,
        reason: f.reason,
        evidence: req.filter((k) => evidence[k]?.trim()).map((k) => ({ kind: k, ref: evidence[k]!.trim() })),
        lines: lines.map((l) => ({ staffId: l.staffId, amountCents: yuanToCents(l.amount), account: l.account, costDeptId: l.costDeptId })),
      }),
    onSuccess: (r) => navigate(`/oa/gov/${r.docId}`),
    onError: (e) => toast({ tone: 'error', title: '没有生成', body: errorMessage(e) }),
  });
  const setLine = (i: number, patch: Partial<(typeof lines)[number]>) => setLines(lines.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  return (
    <Dialog
      open
      onClose={onClose}
      width="max-w-3xl"
      title="生成 HR 付款批次"
      description="批次号系统生成、唯一；凭证按类型必备，不能只有总额表"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button loading={m.isPending} disabled={!f.departmentId || req.some((k) => !evidence[k]?.trim())} onClick={() => m.mutate()}>
            提交审批
          </Button>
        </>
      }
    >
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="类型">
          <Select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value as HrBatchKind })}>
            {HR_BATCH_KINDS.map((k) => (
              <option key={k} value={k}>
                {HR_BATCH_KIND_LABELS[k]}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="期间">
          <Input value={f.period} onChange={(e) => setF({ ...f, period: e.target.value })} />
        </Field>
        <Field label="主责部门">
          <Select value={f.departmentId} onChange={(e) => setF({ ...f, departmentId: e.target.value ? Number(e.target.value) : '' })}>
            <option value="">请选择</option>
            {meta.departments.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </Select>
        </Field>
        {isAbnormalBatch(f.kind) && (
          <>
            <Field label="原批次编号">
              <Input value={f.originalBatchNo} onChange={(e) => setF({ ...f, originalBatchNo: e.target.value })} />
            </Field>
            <Field label="异常说明" className="sm:col-span-2">
              <Textarea rows={2} value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} />
            </Field>
          </>
        )}
        {req.map((k) => (
          <Field key={k} label={`凭证：${HR_EVIDENCE_LABELS[k]}`}>
            <Input value={evidence[k] ?? ''} onChange={(e) => setEvidence({ ...evidence, [k]: e.target.value })} placeholder="文件编号或位置" />
          </Field>
        ))}
      </div>
      <div className="mt-3 space-y-1.5">
        <p className="text-[13px] font-semibold text-ink">人员明细</p>
        {lines.map((l, i) => (
          <div key={i} className="grid gap-2 sm:grid-cols-[1fr_0.8fr_1.2fr_1fr_auto]">
            <Select value={l.staffId} onChange={(e) => setLine(i, { staffId: e.target.value ? Number(e.target.value) : '' })}>
              <option value="">员工</option>
              {meta.staff.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </Select>
            <Input inputMode="decimal" placeholder="金额（元）" value={l.amount} onChange={(e) => setLine(i, { amount: e.target.value })} />
            <Input className="num" placeholder="收款账号" value={l.account} onChange={(e) => setLine(i, { account: e.target.value.replace(/\D/g, '') })} />
            <Select value={l.costDeptId} onChange={(e) => setLine(i, { costDeptId: e.target.value ? Number(e.target.value) : '' })}>
              <option value="">成本中心</option>
              {meta.departments.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </Select>
            <Button size="sm" variant="ghost" disabled={lines.length === 1} onClick={() => setLines(lines.filter((_, j) => j !== i))}>
              去掉
            </Button>
          </div>
        ))}
        <Button size="sm" variant="secondary" onClick={() => setLines([...lines, { staffId: '', amount: '', account: '', costDeptId: '' }])}>
          再加一人
        </Button>
      </div>
    </Dialog>
  );
}

/** 事项详情里：HR 批次要点、明细（最小权限）、出纳复核与付款 */
export function HrBatchPanel({ doc, meta, onDone }: { doc: GfDocDetail; meta: GfMeta | undefined; onDone: () => void }) {
  const toast = useToast();
  const q = useQuery({ queryKey: ['gf', 'hr', doc.id, doc.version], queryFn: () => api.get<HrBatchView>(`/api/gf/hr-batches/${doc.id}`) });
  const [check, setCheck] = useState({ headcount: '', total: '', accounts: '' });
  const [bankRef, setBankRef] = useState('');
  const onError = (e: unknown) => toast({ tone: 'error', title: '没有办成', body: errorMessage(e) });
  const checkM = useMutation({
    mutationFn: () =>
      api.post(`/api/gf/hr-batches/${doc.id}/cashier-check`, {
        headcount: Number(check.headcount),
        totalCents: yuanToCents(check.total),
        // 每行：员工编号,账号,金额（元）
        accounts: check.accounts
          .split('\n')
          .map((l) => l.split(/[,，\s]+/).filter(Boolean))
          .filter((p) => p.length === 3)
          .map(([staffId, account, amount]) => ({ staffId: Number(staffId), account, amountCents: yuanToCents(amount!) })),
      }),
    onSuccess: () => {
      q.refetch();
      toast({ tone: 'success', title: '三项一致，可以付款' });
    },
    onError: (e) => {
      q.refetch();
      onError(e);
    },
  });
  const payM = useMutation({
    mutationFn: () => api.post(`/api/gf/hr-batches/${doc.id}/pay`, { bankRef }),
    onSuccess: () => {
      q.refetch();
      onDone();
    },
    onError,
  });
  if (!q.data) return null;
  const b = q.data;
  const cashier = !!meta?.myRoles.includes('cashier');
  return (
    <Card className="space-y-2 p-4" data-testid="gf-hr-panel">
      <p className="flex flex-wrap items-center gap-2 text-[14px]">
        <span className="num font-bold text-ink">{b.batchNo}</span>
        <Badge tone={isAbnormalBatch(b.kind) ? 'clay' : 'lake'}>{HR_BATCH_KIND_LABELS[b.kind]}</Badge>
        <span className="text-ink-2">
          {b.period} · {b.headcount} 人 · <Money cents={b.totalCents} className="text-[14px]" />
        </span>
        {b.originalBatchNo && <span className="text-ink-3">原批次 {b.originalBatchNo}</span>}
      </p>
      <p className="text-[13px] text-ink-3">凭证：{b.evidence.map((e) => `${HR_EVIDENCE_LABELS[e.kind]} ${e.ref}`).join('；')}</p>
      {b.lines ? (
        <DataTable
          variant="plain"
          rows={b.lines}
          rowKey={(_, i) => i}
          columns={[
            { key: 'name', header: '员工', cell: (l) => l.staffName },
            { key: 'amount', header: '金额', numeric: true, cell: (l) => <Money cents={l.amountCents} /> },
            { key: 'account', header: '账号', cell: (l) => <span className="num">{l.accountMasked}</span> },
            { key: 'cost', header: '成本中心', cell: (l) => l.costDeptName },
          ]}
        />
      ) : (
        <p className="text-[13px] text-ink-3">人员明细按最小权限，只给 HR、财务、出纳看</p>
      )}
      {b.mismatches.length > 0 && <p className="text-[13px] font-semibold text-clay">出纳复核不一致：{b.mismatches.join('；')}（已退回 HR 与财务核对）</p>}
      {b.paid && (
        <p className="text-[13px] text-ink-2">
          已付款 · 流水 {b.paid.bankRef} · {formatDateTime(b.paid.paidAt)}
        </p>
      )}
      {cashier && !b.paid && doc.status === 'to_execute' && (
        <div className="space-y-2 border-t border-line pt-2">
          <div className="grid gap-2 sm:grid-cols-2">
            <Input inputMode="numeric" placeholder="复核总人数" value={check.headcount} onChange={(e) => setCheck({ ...check, headcount: e.target.value })} />
            <Input inputMode="decimal" placeholder="复核总金额（元）" value={check.total} onChange={(e) => setCheck({ ...check, total: e.target.value })} />
          </div>
          <Textarea rows={3} placeholder="收款账户（每行：员工编号,账号,金额）" value={check.accounts} onChange={(e) => setCheck({ ...check, accounts: e.target.value })} />
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="secondary" loading={checkM.isPending} onClick={() => checkM.mutate()}>
              出纳复核
            </Button>
            <Input className="w-48" placeholder="银行流水号" value={bankRef} onChange={(e) => setBankRef(e.target.value)} />
            <Button size="sm" loading={payM.isPending} disabled={bankRef.length < 4} onClick={() => payM.mutate()}>
              按批次付款
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}

function AllocSection({ meta }: { meta: GfMeta }) {
  const qc = useQueryClient();
  const toast = useToast();
  const rules = useQuery({ queryKey: ['gf', 'alloc-rules'], queryFn: () => api.get<AllocRuleView[]>('/api/gf/alloc-rules') });
  const runs = useQuery({ queryKey: ['gf', 'alloc-runs'], queryFn: () => api.get<AllocRunView[]>('/api/gf/alloc-runs') });
  const [name, setName] = useState('');
  const [splits, setSplits] = useState('');
  const [run, setRun] = useState({ ruleId: '' as number | '', amount: '' });
  const refresh = () => qc.invalidateQueries({ queryKey: ['gf'] });
  const onError = (e: unknown) => toast({ tone: 'error', title: '没有办成', body: errorMessage(e) });
  // 「部门编号:百分比」逗号隔开，如 3:60,5:40
  const parsedSplits = () =>
    splits
      .split(/[,，]/)
      .map((s) => s.split(/[:：]/))
      .filter((p) => p.length === 2)
      .map(([d, pct]) => ({ departmentId: Number(d), bp: Math.round(Number(pct) * 100) }));
  const addRule = useMutation({ mutationFn: () => api.post('/api/gf/alloc-rules', { name, splits: parsedSplits() }), onSuccess: refresh, onError });
  const doRun = useMutation({ mutationFn: () => api.post('/api/gf/alloc-runs', { clientKey: uuid(), ruleId: run.ruleId, amountCents: yuanToCents(run.amount) }), onSuccess: refresh, onError });
  const reverse = useMutation({ mutationFn: (id: number) => api.post(`/api/gf/alloc-runs/${id}/reverse`, { clientKey: uuid(), reason: '财务冲正' }), onSuccess: refresh, onError });
  return (
    <Card className="space-y-3 p-4" data-testid="gf-alloc">
      <h2 className="text-[15px] font-bold text-ink">费用分摊（规则有版本、结果只追加、冲正不删原分摊）</h2>
      <div className="grid gap-2 sm:grid-cols-[1fr_2fr_auto]">
        <Input placeholder="规则名称" value={name} onChange={(e) => setName(e.target.value)} />
        <Input placeholder={`部门编号:百分比，如 ${meta.departments[0]?.id ?? 1}:60,${meta.departments[1]?.id ?? 2}:40`} value={splits} onChange={(e) => setSplits(e.target.value)} />
        <Button size="sm" disabled={!name || !splits} onClick={() => addRule.mutate()}>
          加规则
        </Button>
      </div>
      <div className="grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
        <Select value={run.ruleId} onChange={(e) => setRun({ ...run, ruleId: e.target.value ? Number(e.target.value) : '' })}>
          <option value="">选规则</option>
          {(rules.data ?? []).map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}（第 {r.version} 版：{r.splits.map((s) => `${s.departmentName} ${s.bp / 100}%`).join('、')}）
            </option>
          ))}
        </Select>
        <Input inputMode="decimal" placeholder="分摊金额（元）" value={run.amount} onChange={(e) => setRun({ ...run, amount: e.target.value })} />
        <Button size="sm" disabled={!run.ruleId || yuanToCents(run.amount) === null} onClick={() => doRun.mutate()}>
          执行分摊
        </Button>
      </div>
      <DataTable<AllocRunView>
        variant="plain"
        rows={runs.data}
        loading={runs.isPending}
        rowKey={(r) => r.id}
        empty="还没有分摊记录"
        columns={[
          { key: 'id', header: '编号', cell: (r) => `#${r.id}${r.kind === 'reverse' ? `（冲正 #${r.reversesRunId}）` : ''}` },
          { key: 'ver', header: '规则版本', cell: (r) => `规则 ${r.ruleId} · 第 ${r.ruleVersion} 版` },
          { key: 'amount', header: '金额', numeric: true, cell: (r) => <Money cents={r.amountCents} /> },
          { key: 'lines', header: '各部门', cell: (r) => r.lines.map((l) => `${l.departmentName} ¥${(l.cents / 100).toFixed(2)}`).join('、') },
          {
            key: 'act',
            header: '',
            cell: (r) =>
              r.kind === 'run' && !(runs.data ?? []).some((x) => x.reversesRunId === r.id) ? (
                <Button size="sm" variant="ghost" onClick={() => reverse.mutate(r.id)}>
                  冲正
                </Button>
              ) : null,
          },
        ]}
      />
    </Card>
  );
}
