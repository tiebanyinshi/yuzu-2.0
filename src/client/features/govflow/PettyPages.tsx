// 业财法 P03（docs/APPROVAL_V4.md 第 7 节）：零星采购与备用金额度。
//   /oa/gov?box=petty      发起零星采购（先预检：分级、同日同供应商合并、额度、采购部门日累计）、本部门额度、
//                          内控公示（各部门已用 / 冻结 / 剩余 / 逾期 / 疑似拆单）、月度额度核定（内控）
// 验收（部门里另一名员工）、补发票在事项详情里（PettyActions）。

import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { GfDocDetail, GfMeta } from '@shared/govflow';
import { PETTY_KINDS, PETTY_KIND_LABELS, type PettyKind, type PettyPreview, type PettyQuotaView } from '@shared/govflow-petty';
import { api, errorMessage } from '../../lib/api';
import { cn, uuid } from '../../lib/utils';
import { Money } from '../../components/Money';
import { Dialog } from '../../components/Overlay';
import { useToast } from '../../components/Toast';
import { DataTable } from '../../components/DataTable';
import { Badge, Button, Card, Field, Input, Select, Textarea } from '../../components/ui';
import { yuanToCents } from './money';

export function PettyPanel({ meta }: { meta: GfMeta }) {
  const [creating, setCreating] = useState(false);
  const [adjust, setAdjust] = useState(false);
  const oversight = meta.canManageRoles || meta.myRoles.some((r) => ['internal_control', 'finance_chief', 'cfo', 'chairman', 'finance_reviewer'].includes(r));
  const board = useQuery({ queryKey: ['gf', 'petty-board'], queryFn: () => api.get<PettyQuotaView[]>('/api/gf/petty/board'), enabled: oversight });
  return (
    <div className="space-y-3" data-testid="gf-petty">
      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={() => setCreating(true)} data-testid="gf-petty-new">
          发起零星采购
        </Button>
        {meta.myRoles.includes('internal_control') && (
          <Button size="sm" variant="secondary" onClick={() => setAdjust(true)}>
            月度额度核定建议
          </Button>
        )}
      </div>
      <Card className="p-4 text-[13px] text-ink-2">
        单笔 3,000 元且 50 件以内基础审核（同日同供应商合并算），超出要写比价说明；部门备用金日 1 万、月 5 万，超额由财总＋CFO 合并特批； 合同、工程、服务外包、预付款、固定资产不走零星采购。
      </Card>
      {oversight && (
        <DataTable<PettyQuotaView>
          testId="gf-petty-board"
          rows={board.data}
          loading={board.isPending}
          failed={board.isError && !board.data}
          onRetry={() => board.refetch()}
          rowKey={(q) => q.departmentId}
          columns={[
            {
              key: 'dept',
              header: '部门',
              cell: (q) => (
                <span className="font-semibold text-ink">
                  {q.departmentName} {q.warn && <Badge tone={q.warn === 90 ? 'clay' : 'ember'}>{q.warn}%</Badge>}
                </span>
              ),
            },
            { key: 'used', header: '今天已用', numeric: true, cell: (q) => <Money cents={q.dayUsed} /> },
            { key: 'frozen', header: '冻结', numeric: true, cell: (q) => <Money cents={q.dayFrozen} /> },
            { key: 'dayLeft', header: '今天剩余', numeric: true, cell: (q) => <Money cents={q.dayRemaining} className={cn(q.dayRemaining < 0 && 'text-clay')} /> },
            { key: 'monthLeft', header: '本月剩余', numeric: true, cell: (q) => <Money cents={q.monthRemaining} /> },
            { key: 'overdue', header: '逾期', numeric: true, cell: (q) => q.overdue || '—' },
            { key: 'split', header: '疑似拆单', numeric: true, cell: (q) => q.splitSuspects || '—' },
            {
              key: 'next',
              header: '下月核定',
              cell: (q) => (q.nextMonth ? `日 ¥${q.nextMonth.dailyLimit / 100} / 月 ¥${q.nextMonth.monthlyLimit / 100}` : '—'),
            },
          ]}
        />
      )}
      {creating && <PettyDialog meta={meta} onClose={() => setCreating(false)} />}
      {adjust && <AdjustDialog meta={meta} onClose={() => setAdjust(false)} />}
    </div>
  );
}

function PettyDialog({ meta, onClose }: { meta: GfMeta; onClose: () => void }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const toast = useToast();
  const [clientKey] = useState(uuid);
  const [f, setF] = useState({ departmentId: '' as number | '', supplierName: '', items: '', qty: '1', amount: '', kind: 'goods' as PettyKind, urgent: false, quoteNote: '' });
  const cents = yuanToCents(f.amount);
  const body = { departmentId: f.departmentId, supplierName: f.supplierName, items: f.items, qty: Number(f.qty), amountCents: cents, kind: f.kind, urgent: f.urgent, quoteNote: f.quoteNote };
  const ready = !!f.departmentId && f.supplierName.trim().length >= 2 && !!f.items.trim() && cents !== null && Number(f.qty) >= 1;
  const [preview, setPreview] = useState<PettyPreview | null>(null);
  useEffect(() => {
    if (!ready) return setPreview(null);
    const t = setTimeout(() => {
      api
        .post<PettyPreview>('/api/gf/petty/preview', body)
        .then(setPreview)
        .catch(() => setPreview(null));
    }, 400);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(body), ready]);
  const m = useMutation({
    mutationFn: () => api.post<{ docId: number }>('/api/gf/petty', { clientKey, ...body }),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ['gf'] });
      navigate(`/oa/gov/${r.docId}`);
    },
    onError: (e) => toast({ tone: 'error', title: '没有提交', body: errorMessage(e) }),
  });
  return (
    <Dialog
      open
      onClose={onClose}
      width="max-w-2xl"
      title="零星采购"
      description="提交时在系统里锁定额度重算；下面的预检只是参考，不占额度"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button loading={m.isPending} disabled={!ready || !!preview?.blockedReason} onClick={() => m.mutate()} data-testid="gf-petty-submit">
            提交
          </Button>
        </>
      }
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="费用承担部门">
          <Select value={f.departmentId} onChange={(e) => setF({ ...f, departmentId: e.target.value ? Number(e.target.value) : '' })}>
            <option value="">请选择</option>
            {meta.departments.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="类型">
          <Select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value as PettyKind })}>
            {PETTY_KINDS.map((k) => (
              <option key={k} value={k}>
                {PETTY_KIND_LABELS[k]}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="供应商">
          <Input value={f.supplierName} onChange={(e) => setF({ ...f, supplierName: e.target.value })} />
        </Field>
        <Field label="买什么">
          <Input value={f.items} onChange={(e) => setF({ ...f, items: e.target.value })} />
        </Field>
        <Field label="件数">
          <Input inputMode="numeric" value={f.qty} onChange={(e) => setF({ ...f, qty: e.target.value.replace(/\D/g, '') })} />
        </Field>
        <Field label="金额（元）">
          <Input inputMode="decimal" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} />
        </Field>
        <label className="flex items-center gap-2 text-[14px] text-ink sm:col-span-2">
          <input type="checkbox" checked={f.urgent} onChange={(e) => setF({ ...f, urgent: e.target.checked })} />
          紧急（采购部门当日累计超 1 万时，紧急的走财总＋CFO 特批，非紧急转正式采购）
        </label>
        <Field label="比价说明（超出 3,000 元或 50 件时必填）" className="sm:col-span-2">
          <Textarea rows={2} value={f.quoteNote} onChange={(e) => setF({ ...f, quoteNote: e.target.value })} />
        </Field>
      </div>
      {preview && (
        <div className={cn('mt-3 space-y-1 rounded-md px-3 py-2 text-[13px]', preview.blockedReason ? 'bg-clay-soft text-clay' : 'bg-paper-2 text-ink-2')} data-testid="gf-petty-preview">
          <p>
            {preview.tier === 'basic' ? '基础审核' : '超出基础审核（要比价说明）'} · 同日同供应商合计 ¥{(preview.combinedCents / 100).toFixed(2)}、{preview.combinedQty} 件
            {preview.splitSuspect && ' · 疑似拆单'}
          </p>
          <p>
            部门今天已占 ¥{(preview.quota.dayTaken / 100).toFixed(2)} / ¥{(preview.quota.dailyLimit / 100).toFixed(2)}，本月 ¥{(preview.quota.monthTaken / 100).toFixed(2)} / ¥
            {(preview.quota.monthlyLimit / 100).toFixed(2)}
            {preview.quota.warn && `（达到 ${preview.quota.warn}%）`}
            {preview.quota.needSpecial && ' · 超额，要财总＋CFO 合并特批'}
          </p>
          {preview.blockedReason && <p className="font-semibold">{preview.blockedReason}</p>}
        </div>
      )}
    </Dialog>
  );
}

function AdjustDialog({ meta, onClose }: { meta: GfMeta; onClose: () => void }) {
  const navigate = useNavigate();
  const toast = useToast();
  const [clientKey] = useState(uuid);
  const now = new Date();
  const next = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  const [f, setF] = useState({ departmentId: '' as number | '', month: `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, '0')}`, daily: '10000', monthly: '50000', reason: '' });
  const m = useMutation({
    mutationFn: () =>
      api.post<{ docId: number }>('/api/gf/quota-adjust', {
        clientKey,
        departmentId: f.departmentId,
        month: f.month,
        dailyCents: yuanToCents(f.daily),
        monthlyCents: yuanToCents(f.monthly),
        reason: f.reason,
      }),
    onSuccess: (r) => navigate(`/oa/gov/${r.docId}`),
    onError: (e) => toast({ tone: 'error', title: '没有提交', body: errorMessage(e) }),
  });
  return (
    <Dialog
      open
      onClose={onClose}
      title="月度额度核定建议"
      description="财总＋CFO 共同审批后从次月起生效，不自动升降"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button loading={m.isPending} disabled={!f.departmentId || f.reason.trim().length < 2} onClick={() => m.mutate()}>
            提交
          </Button>
        </>
      }
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="部门">
          <Select value={f.departmentId} onChange={(e) => setF({ ...f, departmentId: e.target.value ? Number(e.target.value) : '' })}>
            <option value="">请选择</option>
            {meta.departments.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="生效月份">
          <Input value={f.month} onChange={(e) => setF({ ...f, month: e.target.value })} />
        </Field>
        <Field label="日额度（元）">
          <Input inputMode="decimal" value={f.daily} onChange={(e) => setF({ ...f, daily: e.target.value })} />
        </Field>
        <Field label="月额度（元）">
          <Input inputMode="decimal" value={f.monthly} onChange={(e) => setF({ ...f, monthly: e.target.value })} />
        </Field>
        <Field label="依据" className="sm:col-span-2">
          <Textarea rows={2} value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} />
        </Field>
      </div>
    </Dialog>
  );
}

/** 事项详情里：零星采购的验收（部门里另一名员工、办部门小仓入库）与补发票 */
export function PettyActions({ doc, onDone }: { doc: GfDocDetail; onDone: () => void }) {
  const toast = useToast();
  const [actual, setActual] = useState(doc.amountCents ? (doc.amountCents / 100).toFixed(2) : '');
  const [invoice, setInvoice] = useState('');
  const [clientKey] = useState(uuid);
  const acceptance = doc.payload.acceptance as { actualCents: number; invoiceNo: string } | undefined;
  const accept = useMutation({
    mutationFn: () => api.post(`/api/gf/petty/${doc.id}/accept`, { clientKey, actualCents: yuanToCents(actual), invoiceNo: invoice, stockIn: true }),
    onSuccess: onDone,
    onError: (e) => toast({ tone: 'error', title: '没有验收', body: errorMessage(e) }),
  });
  const fill = useMutation({
    mutationFn: () => api.post(`/api/gf/petty/${doc.id}/invoice`, { invoiceNo: invoice }),
    onSuccess: onDone,
    onError: (e) => toast({ tone: 'error', title: '没有补上', body: errorMessage(e) }),
  });
  if (acceptance) {
    return (
      <Card className="space-y-2 p-4 text-[14px]">
        <p className="text-ink-2">
          已验收：实际 <Money cents={acceptance.actualCents} className="text-[14px]" />，{acceptance.invoiceNo ? `发票 ${acceptance.invoiceNo}` : '发票待后补'}，已办部门小仓入库
        </p>
        {!acceptance.invoiceNo && (
          <div className="flex gap-2">
            <Input placeholder="发票号" value={invoice} onChange={(e) => setInvoice(e.target.value)} />
            <Button size="sm" disabled={invoice.trim().length < 4} loading={fill.isPending} onClick={() => fill.mutate()}>
              补发票
            </Button>
          </div>
        )}
      </Card>
    );
  }
  if (doc.status !== 'to_execute' && doc.status !== 'executing') return null;
  return (
    <Card className="space-y-2 p-4" data-testid="gf-petty-accept">
      <h2 className="text-[15px] font-bold text-ink">验收（实际使用人或部门里另一名员工）</h2>
      <div className="grid gap-2 sm:grid-cols-3">
        <Input inputMode="decimal" value={actual} onChange={(e) => setActual(e.target.value)} placeholder="实际金额（元）" />
        <Input value={invoice} onChange={(e) => setInvoice(e.target.value)} placeholder="发票号（没有的后补）" />
        <Button loading={accept.isPending} disabled={yuanToCents(actual) === null} onClick={() => accept.mutate()}>
          验收并入部门小仓
        </Button>
      </div>
    </Card>
  );
}
