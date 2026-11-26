// 业财法 P05（docs/APPROVAL_V4.md 第 9 节）：付款与紧急特批。
//   /oa/gov?box=payments   发起付款（含税）：按合同 / 无合同 / 紧急特批（先在「微信特批」登记 CFO＋经营主体负责人两人确认）
// 事项详情里（PaymentPanel）：已付与特批剩余、出纳付款（重新输入账号核验、银行流水号）、账户变更后财务重新确认、后补发票。

import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useMutation, useQuery } from '@tanstack/react-query';
import type { GfDocCard, GfDocDetail, GfMeta, GfSpecialView } from '@shared/govflow';
import { INVOICE_STATES, INVOICE_STATE_LABELS, PAYMENT_CATEGORIES, PAYMENT_CATEGORY_LABELS, type InvoiceState, type PaymentCategory, type PaymentView } from '@shared/govflow-payment';
import { api, errorMessage } from '../../lib/api';
import { formatDateTime, uuid } from '../../lib/utils';
import { Money } from '../../components/Money';
import { Dialog } from '../../components/Overlay';
import { useToast } from '../../components/Toast';
import { Badge, Button, Card, Field, Input, Select } from '../../components/ui';
import { yuanToCents } from './money';

const PATH_LABELS: Record<PaymentView['path'], string> = {
  normal: '正常付款（部门负责人 → 财务 → 出纳）',
  no_contract: '无合同付款',
  no_contract_high: '高额 / 异常无合同付款（CFO → CEO → 董事长）',
  emergency: '紧急特批付款（出纳独立核验）',
};

export function PaymentsPanel({ meta }: { meta: GfMeta }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="space-y-3" data-testid="gf-payments">
      <Card className="space-y-2 p-4 text-[13px] text-ink-2">
        <p>有效合同 + 验收对账依据 + 剩余应付内 + 已取票或登记后补 + 账户无在审变更：只走 部门负责人 → 财务 → 出纳。</p>
        <p>采购、服务、工程到 1 万必须签合同；无合同 5 万以上或异常的走 CFO → CEO → 董事长。未入库供应商或合同未完成的紧急付款，先登记 CFO＋经营主体负责人的微信特批。</p>
        <Button size="sm" onClick={() => setOpen(true)} data-testid="gf-payment-new">
          发起付款
        </Button>
      </Card>
      {open && <PaymentDialog meta={meta} onClose={() => setOpen(false)} />}
    </div>
  );
}

function PaymentDialog({ meta, onClose }: { meta: GfMeta; onClose: () => void }) {
  const navigate = useNavigate();
  const toast = useToast();
  const [clientKey] = useState(uuid);
  const mine = useQuery({ queryKey: ['gf', 'docs', 'mine'], queryFn: () => api.get<GfDocCard[]>('/api/gf/docs?box=mine') });
  const specials = useQuery({ queryKey: ['gf', 'specials'], queryFn: () => api.get<GfSpecialView[]>('/api/gf/specials') });
  const contracts = (mine.data ?? []).filter((d) => d.docType === 'contract' && (d.status === 'to_execute' || d.status === 'executing' || d.status === 'backfill_pending' || d.status === 'completed'));
  const [f, setF] = useState({
    title: '',
    departmentId: '' as number | '',
    category: 'service' as PaymentCategory,
    contractDocId: '' as number | '',
    paymentNode: '',
    payeeName: '',
    payeeAccount: '',
    amount: '',
    acceptanceBasis: '',
    prepay: false,
    invoice: 'received' as InvoiceState,
    invoiceNo: '',
    abnormal: false,
    specialId: '' as number | '',
  });
  const m = useMutation({
    mutationFn: () =>
      api.post<{ docId: number }>('/api/gf/payments', {
        clientKey,
        title: f.title,
        departmentId: f.departmentId,
        category: f.category,
        contractDocId: f.contractDocId || null,
        paymentNode: f.paymentNode,
        payeeName: f.payeeName,
        payeeAccount: f.payeeAccount || null,
        amountCents: yuanToCents(f.amount),
        acceptanceBasis: f.acceptanceBasis,
        prepay: f.prepay,
        invoice: f.invoice,
        invoiceNo: f.invoiceNo,
        abnormal: f.abnormal,
        specialId: f.specialId || null,
      }),
    onSuccess: (r) => navigate(`/oa/gov/${r.docId}`),
    onError: (e) => toast({ tone: 'error', title: '没有提交', body: errorMessage(e) }),
  });
  const set = (patch: Partial<typeof f>) => setF({ ...f, ...patch });
  return (
    <Dialog
      open
      onClose={onClose}
      width="max-w-2xl"
      title="发起付款"
      description="付款按含税金额；同一合同已付 + 在途不超过合同含税金额，同一收款方同一发票号只付一次"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button loading={m.isPending} disabled={!f.title || !f.departmentId || yuanToCents(f.amount) === null} onClick={() => m.mutate()} data-testid="gf-payment-submit">
            提交
          </Button>
        </>
      }
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="付款事项">
          <Input value={f.title} onChange={(e) => set({ title: e.target.value })} />
        </Field>
        <Field label="主责部门">
          <Select value={f.departmentId} onChange={(e) => set({ departmentId: e.target.value ? Number(e.target.value) : '' })}>
            <option value="">请选择</option>
            {meta.departments.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="类别">
          <Select value={f.category} onChange={(e) => set({ category: e.target.value as PaymentCategory })}>
            {PAYMENT_CATEGORIES.map((x) => (
              <option key={x} value={x}>
                {PAYMENT_CATEGORY_LABELS[x]}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="关联合同">
          <Select value={f.contractDocId} onChange={(e) => set({ contractDocId: e.target.value ? Number(e.target.value) : '' })}>
            <option value="">无合同</option>
            {contracts.map((d) => (
              <option key={d.id} value={d.id}>
                {d.bizNo} {d.title}
              </option>
            ))}
          </Select>
        </Field>
        {f.contractDocId ? (
          <Field label="付款节点">
            <Input value={f.paymentNode} onChange={(e) => set({ paymentNode: e.target.value })} placeholder="如 首付款 30%" />
          </Field>
        ) : (
          <>
            <Field label="收款方">
              <Input value={f.payeeName} onChange={(e) => set({ payeeName: e.target.value })} />
            </Field>
            <Field label="收款账号">
              <Input className="num" value={f.payeeAccount} onChange={(e) => set({ payeeAccount: e.target.value.replace(/\D/g, '') })} />
            </Field>
          </>
        )}
        <Field label="金额（元，含税）">
          <Input inputMode="decimal" value={f.amount} onChange={(e) => set({ amount: e.target.value })} />
        </Field>
        <Field label="验收 / 对账依据">
          <Input value={f.acceptanceBasis} onChange={(e) => set({ acceptanceBasis: e.target.value })} placeholder="验收单号、对账单号" />
        </Field>
        <Field label="发票">
          <Select value={f.invoice} onChange={(e) => set({ invoice: e.target.value as InvoiceState })}>
            {INVOICE_STATES.map((x) => (
              <option key={x} value={x}>
                {INVOICE_STATE_LABELS[x]}
              </option>
            ))}
          </Select>
        </Field>
        {f.invoice === 'received' && (
          <Field label="发票号">
            <Input value={f.invoiceNo} onChange={(e) => set({ invoiceNo: e.target.value })} />
          </Field>
        )}
        <Field label="紧急特批（未入库供应商或合同未完成时）">
          <Select value={f.specialId} onChange={(e) => set({ specialId: e.target.value ? Number(e.target.value) : '' })}>
            <option value="">不用</option>
            {(specials.data ?? []).map((s) => (
              <option key={s.id} value={s.id}>
                {s.specialNo} {s.title} ¥{(s.amountCents / 100).toFixed(2)}
              </option>
            ))}
          </Select>
        </Field>
        <label className="flex items-center gap-2 text-[14px] text-ink">
          <input type="checkbox" checked={f.prepay} onChange={(e) => set({ prepay: e.target.checked })} />
          预付款
        </label>
        <label className="flex items-center gap-2 text-[14px] text-ink">
          <input type="checkbox" checked={f.abnormal} onChange={(e) => set({ abnormal: e.target.checked })} />
          异常（加 CFO / 走高额链）
        </label>
      </div>
    </Dialog>
  );
}

export function PaymentPanel({ doc, meta, onDone }: { doc: GfDocDetail; meta: GfMeta | undefined; onDone: () => void }) {
  const toast = useToast();
  const q = useQuery({ queryKey: ['gf', 'payment', doc.id, doc.version], queryFn: () => api.get<PaymentView>(`/api/gf/payments/${doc.id}`) });
  const [clientKey, setClientKey] = useState(uuid);
  const [amount, setAmount] = useState('');
  const [bankRef, setBankRef] = useState('');
  const [account, setAccount] = useState('');
  const [invoiceNo, setInvoiceNo] = useState('');
  const done = () => {
    setClientKey(uuid());
    setAmount('');
    setBankRef('');
    setAccount('');
    q.refetch();
    onDone();
  };
  const onError = (e: unknown) => toast({ tone: 'error', title: '没有办成', body: errorMessage(e) });
  const payM = useMutation({
    mutationFn: () => api.post(`/api/gf/payments/${doc.id}/pay`, { clientKey, amountCents: yuanToCents(amount), bankRef, accountConfirm: account }),
    onSuccess: done,
    onError,
  });
  const reM = useMutation({ mutationFn: () => api.post(`/api/gf/payments/${doc.id}/reconfirm`, {}), onSuccess: done, onError });
  const invM = useMutation({ mutationFn: () => api.post(`/api/gf/payments/${doc.id}/invoice`, { invoiceNo }), onSuccess: done, onError });
  if (!q.data) return null;
  const v = q.data;
  const cashier = !!meta?.myRoles.includes('cashier');
  const finance = !!meta?.myRoles.some((r) => r === 'finance_reviewer' || r === 'finance_chief');
  const left = v.amountCents - v.paidCents;
  return (
    <Card className="space-y-2 p-4" data-testid="gf-payment-panel">
      <p className="flex flex-wrap items-center gap-2 text-[14px]">
        <Badge tone="lake">{PATH_LABELS[v.path]}</Badge>
        {v.contractNo && <span className="num text-ink-2">合同 {v.contractNo}</span>}
        {v.specialNo && <Badge tone="clay">特批 {v.specialNo}</Badge>}
        {v.needsReconfirm && <Badge tone="clay">收款账户变更，待财务重新确认</Badge>}
      </p>
      <p className="text-[13px] text-ink-2">
        收款方 {v.payeeName} · 账号 <span className="num">{v.payeeAccountMasked}</span> · 申请 <Money cents={v.amountCents} className="text-[13px]" /> · 已付{' '}
        <Money cents={v.paidCents} className="text-[13px]" />
        {v.specialRemainingCents !== null && (
          <>
            {' '}
            · 特批剩余 <Money cents={v.specialRemainingCents} className="text-[13px]" />
          </>
        )}
        {' · '}
        {INVOICE_STATE_LABELS[v.invoice]}
        {v.invoiceNo && ` ${v.invoiceNo}`}
      </p>
      {v.payouts.map((o) => (
        <p key={o.id} className="text-[13px] text-ink-3">
          付 <Money cents={o.amountCents} className="text-[13px]" /> · 流水 {o.bankRef} · {o.paidByName} {formatDateTime(o.paidAt)}
        </p>
      ))}
      {cashier && left > 0 && !v.needsReconfirm && (doc.status === 'to_execute' || doc.status === 'executing' || doc.status === 'special_backfill') && (
        <div className="grid gap-2 sm:grid-cols-4" data-testid="gf-pay-form">
          <Input inputMode="decimal" placeholder={`金额（最多 ¥${(left / 100).toFixed(2)}）`} value={amount} onChange={(e) => setAmount(e.target.value)} />
          <Input placeholder="银行流水号" value={bankRef} onChange={(e) => setBankRef(e.target.value)} />
          <Input className="num" placeholder="重新输入收款账号核验" value={account} onChange={(e) => setAccount(e.target.value.replace(/\D/g, ''))} />
          <Button loading={payM.isPending} disabled={yuanToCents(amount) === null || bankRef.length < 4 || account.length < 6} onClick={() => payM.mutate()}>
            出纳付款
          </Button>
        </div>
      )}
      {finance && v.needsReconfirm && (
        <Button size="sm" loading={reM.isPending} onClick={() => reM.mutate()}>
          按新账户重新确认
        </Button>
      )}
      {v.invoice !== 'received' && (
        <div className="flex gap-2">
          <Input placeholder="补发票号" value={invoiceNo} onChange={(e) => setInvoiceNo(e.target.value)} />
          <Button size="sm" disabled={invoiceNo.length < 4} loading={invM.isPending} onClick={() => invM.mutate()}>
            补发票
          </Button>
        </div>
      )}
    </Card>
  );
}
