// 8.2.30 收银申请（docs/V8230_CASHIER.md 第 2 节，CM-5、CM-6）：
//   · VoidRequestForm：没有「反结账」权限的收银员在结账记录里提交反结账申请；
//   · CashierRequestsPage（/crm/cashier-requests）：有权限的人在「待我审批」里批准、驳回；本人在「我提交的」里看结果、撤回；
//   · HandoverList：交班页「交给下一班」（CM-9），只读、不拦交班。
// 退款申请在退款区里填（RefundPanel asRequest）。
import { useState } from 'react';
import { useSearchParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Undo2, X } from 'lucide-react';
import { CASHIER_REQUEST_KIND_LABELS, CASHIER_REQUEST_STATUS_LABELS, type CashierRequestStatus, type CashierRequestView, type ShiftHandover } from '@shared/cashier-v8230';
import { PAYMENT_METHOD_LABELS, type PaymentMethod } from '@shared/labels';
import { formatYuan } from '@shared/money';
import { api, errorMessage } from '../../lib/api';
import { useLivePoll } from '../../lib/livePoll';
import { useCan, useSession } from '../../lib/session';
import { cn, formatDateTime, uuid } from '../../lib/utils';
import { PageHeader } from '../../components/AppShell';
import { EmptyState } from '../../components/EmptyState';
import { Money } from '../../components/Money';
import { ReasonDialog } from '../../components/ReasonDialog';
import { useToast } from '../../components/Toast';
import { Badge, Button, Card, Input, Notice, SectionTitle, Segmented, Skeleton } from '../../components/ui';
import { useFrontdeskOp, PendingPanel } from './pending';

const STATUS_TONE: Record<CashierRequestStatus, 'yuzu' | 'pine' | 'clay' | 'neutral'> = {
  pending: 'yuzu',
  approved: 'pine',
  rejected: 'clay',
  expired: 'neutral',
  cancelled: 'neutral',
};

/** 反结账申请：写原因提交，批准的人执行反结账（选钱箱、要开班的都在批准的人那边） */
export function VoidRequestForm({ checkoutId, checkoutNo, onClose }: { checkoutId: number; checkoutNo: string; onClose: () => void }) {
  const session = useSession();
  const toast = useToast();
  const qc = useQueryClient();
  const [reason, setReason] = useState('');
  const op = useFrontdeskOp<CashierRequestView>({
    type: 'cashier_request',
    visitId: null,
    checkoutId,
    staffName: session.staff.displayName,
    pick: (found) => (found.type === 'cashier_request' ? found.request : null),
  });
  const done = (r: CashierRequestView) => {
    toast({ tone: 'success', title: `已提交反结账申请 ${r.requestNo}`, body: '等值班经理批准；结果会发到你的通知里' });
    void qc.invalidateQueries({ queryKey: ['cashier-requests'] });
    onClose();
  };
  const submit = async () => {
    const r = await op.submit((key) => ({
      url: '/api/cashier-requests',
      body: { clientKey: key, kind: 'void', checkoutId, reason: reason.trim() },
      tagCodes: [],
      summary: `反结账申请 · 结账单 ${checkoutNo}`,
      amount: null,
    }));
    if (r) done(r);
  };
  if (op.pending) {
    return (
      <div className="rounded-lg border border-yuzu-deep/30 bg-yuzu-tint/50 p-3" data-testid="void-request-pending">
        <PendingPanel op={op} onResolved={done} />
      </div>
    );
  }
  return (
    <div className="space-y-2 rounded-lg border border-clay/30 bg-clay-soft/40 p-3" data-testid="void-request">
      <p className="text-[13px] text-ink-2">你没有反结账的权限：写清原因提交申请，值班经理批准时按那时的数据核对、执行反结账；24 小时没人批会失效。</p>
      <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="反结账原因（至少 2 个字），例如：收款方式记错" maxLength={200} disabled={op.locked} aria-label="反结账原因" />
      <div className="flex gap-2">
        <Button variant="danger" disabled={reason.trim().length < 2 || op.locked} loading={op.busy} onClick={() => void submit()} data-testid="void-request-submit">
          提交反结账申请
        </Button>
        <Button variant="ghost" onClick={onClose} disabled={op.busy}>
          取消
        </Button>
      </div>
      {op.state.phase === 'error' && <Notice tone="error" title={op.state.message} />}
      {op.state.phase === 'uncertain' && <Notice tone="warning" title={op.state.message} />}
    </div>
  );
}

function RequestCard({ r, mode, onChanged }: { r: CashierRequestView; mode: 'todo' | 'mine'; onChanged: () => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState<'approve' | 'cancel' | null>(null);
  const [rejecting, setRejecting] = useState(false);
  const [rejectBusy, setRejectBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 退款申请批准时开退款单的操作编号：同一张卡上重试用同一个（服务端同一编号返回同一张退款单）
  const [approveKey] = useState(uuid);
  const cash = r.payments.find((p) => p.method === 'cash')?.amount ?? 0;
  const approve = async () => {
    setBusy('approve');
    setError(null);
    try {
      const x = await api.post<CashierRequestView>(`/api/cashier-requests/${r.id}/approve`, r.kind === 'refund' ? { clientKey: approveKey } : {});
      toast({
        tone: 'success',
        title: `已批准 ${x.requestNo}`,
        body: r.kind === 'refund' ? `已开退款单 ${x.refundNo ?? ''}${cash ? `；现金 ${formatYuan(cash)} 从你当班的钱箱退` : ''}` : '已反结账，客人回到在店',
      });
      onChanged();
    } catch (e) {
      setError(errorMessage(e));
      onChanged();
    } finally {
      setBusy(null);
    }
  };
  const cancel = async () => {
    setBusy('cancel');
    setError(null);
    try {
      await api.post(`/api/cashier-requests/${r.id}/cancel`, {});
      onChanged();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };
  const reject = async (note: string) => {
    setRejectBusy(true);
    try {
      await api.post(`/api/cashier-requests/${r.id}/reject`, { note });
      setRejecting(false);
      onChanged();
    } catch (e) {
      setError(errorMessage(e));
      setRejecting(false);
    } finally {
      setRejectBusy(false);
    }
  };
  return (
    <li className="rounded-lg border border-line bg-card p-4" data-testid={`cashier-request-${r.requestNo}`}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="num font-bold">{r.requestNo}</span>
        <Badge tone={r.kind === 'void' ? 'clay' : 'ember'}>{CASHIER_REQUEST_KIND_LABELS[r.kind]}</Badge>
        <span className="text-[13px] text-ink-2">结账单 {r.checkoutNo}</span>
        <Money cents={r.amount} size="key" />
        <span className="flex-1" />
        <Badge tone={STATUS_TONE[r.status]}>{CASHIER_REQUEST_STATUS_LABELS[r.status]}</Badge>
      </div>
      <p className="mt-1.5 text-[13px] text-ink-2">原因：{r.reason}</p>
      {r.items.length > 0 && (
        <p className="mt-1 text-[12.5px] text-ink-3">
          退：{r.items.map((i) => `${i.name}${i.quantity ? ` × ${i.quantity}` : '（只退钱）'} ${formatYuan(i.amount)}`).join('、')}；方式：
          {r.payments.map((p) => `${PAYMENT_METHOD_LABELS[p.method as PaymentMethod] ?? p.method} ${formatYuan(p.amount)}`).join('、')}
        </p>
      )}
      <p className="mt-1 text-[12px] text-ink-3">
        {r.requestedByName} {formatDateTime(r.requestedAt)} 提交
        {r.status === 'pending' ? ` · ${formatDateTime(r.expiresAt)} 前没人批会失效` : ''}
        {r.decidedAt ? ` · ${r.decidedByName ?? ''} ${formatDateTime(r.decidedAt)} 处理` : ''}
        {r.refundNo ? ` · 退款单 ${r.refundNo}` : ''}
      </p>
      {r.decisionNote && r.status !== 'approved' && <p className={cn('mt-1 text-[12.5px] font-semibold', r.status === 'rejected' ? 'text-clay' : 'text-ink-2')}>{r.decisionNote}</p>}
      {r.status === 'pending' && mode === 'todo' && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button variant="primary" icon={<Check className="size-4" />} loading={busy === 'approve'} disabled={busy !== null} onClick={() => void approve()} data-testid="request-approve">
            批准并{r.kind === 'refund' ? '开退款单' : '反结账'}
          </Button>
          <Button variant="ghost" icon={<X className="size-4" />} disabled={busy !== null} onClick={() => setRejecting(true)} data-testid="request-reject">
            驳回
          </Button>
          <span className="text-[12px] text-ink-3">批准时按此刻的数据再核对一次{cash || r.kind === 'void' ? '；退的现金记到你当班的钱箱，要先开班' : ''}。</span>
        </div>
      )}
      {r.status === 'pending' && mode === 'mine' && (
        <Button className="mt-3" size="sm" variant="ghost" loading={busy === 'cancel'} onClick={() => void cancel()} data-testid="request-cancel">
          撤回申请
        </Button>
      )}
      {error && <Notice tone="error" title={error} className="mt-3" />}
      <ReasonDialog
        open={rejecting}
        title={`驳回 ${r.requestNo}`}
        description="驳回原因会通知申请人。"
        confirmLabel="驳回"
        danger
        busy={rejectBusy}
        onClose={() => setRejecting(false)}
        onConfirm={(note) => void reject(note)}
      />
    </li>
  );
}

export function CashierRequestsPage() {
  const can = useCan();
  const qc = useQueryClient();
  const [params] = useSearchParams();
  const approver = can('frontdesk.refund') || can('frontdesk.checkoutVoid');
  const [tab, setTab] = useState<'todo' | 'mine'>(approver ? 'todo' : 'mine');
  const q = useQuery({
    queryKey: ['cashier-requests'],
    queryFn: () => api.get<{ todo: CashierRequestView[]; mine: CashierRequestView[] }>('/api/cashier-requests'),
  });
  // 别人也在提交、处理：15 秒刷一次（后台、断网时不取）
  useLivePoll(
    async () => {
      await qc.invalidateQueries({ queryKey: ['cashier-requests'] });
    },
    [qc],
    { intervalMs: 15_000 },
  );
  const focus = Number(params.get('r')) || null;
  const list = (q.data?.[tab] ?? []).slice().sort((a, b) => (a.id === focus ? -1 : b.id === focus ? 1 : 0));
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['cashier-requests'] });
    void qc.invalidateQueries({ queryKey: ['frontdesk'] });
  };
  return (
    <div className="space-y-4" data-testid="cashier-requests-page">
      <PageHeader title="收银申请" subtitle="没有权限的收银员申请退款、反结账，值班经理在这里批准或驳回；结果通知申请人，24 小时没人批自动失效。" />
      <Segmented
        value={tab}
        onChange={(v) => setTab(v as 'todo' | 'mine')}
        options={[...(approver ? [{ value: 'todo', label: `待我审批${q.data?.todo.length ? `（${q.data.todo.length}）` : ''}` }] : []), { value: 'mine', label: '我提交的' }]}
      />
      {q.isPending ? (
        <Skeleton className="h-40" />
      ) : q.error ? (
        <Notice tone="error" title={errorMessage(q.error)} />
      ) : list.length === 0 ? (
        <EmptyState art="calm" title={tab === 'todo' ? '没有等你审批的申请' : '你还没有提交过申请'} />
      ) : (
        <ul className="space-y-3">
          {list.map((r) => (
            <RequestCard key={r.id} r={r} mode={tab} onChanged={refresh} />
          ))}
        </ul>
      )}
    </div>
  );
}

/** 交班页「交给下一班」（CM-9）：本人没处理完的申请、等本人审批的申请、没读的通知、在店没结的手牌；只读、不拦交班 */
export function HandoverList() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['cashier-requests', 'handover'], queryFn: () => api.get<ShiftHandover>('/api/cashier-requests/handover'), retry: false });
  useLivePoll(
    async () => {
      await qc.invalidateQueries({ queryKey: ['cashier-requests', 'handover'] });
    },
    [qc],
    { intervalMs: 30_000 },
  );
  const h = q.data;
  if (!h) return null;
  const items = [
    ...h.myPendingRequests.map((r) => `你提交的${CASHIER_REQUEST_KIND_LABELS[r.kind]}申请 ${r.requestNo}（${r.checkoutNo}，${formatYuan(r.amount)}）还没人批`),
    ...(h.toApprove ? [`${h.toApprove} 张收银申请等你审批`] : []),
    ...(h.unreadNotices ? [`${h.unreadNotices} 条通知没读`] : []),
    ...(h.openVisits ? [`在店没结的手牌 ${h.openVisits} 张`] : []),
  ];
  return (
    <Card className="mt-4 p-4" data-testid="shift-handover">
      <SectionTitle>
        <span className="flex items-center gap-2">
          <Undo2 className="size-4 text-pine" /> 交给下一班
        </span>
      </SectionTitle>
      {items.length === 0 ? (
        <p className="mt-1 text-[13px] text-ink-3">没有要交接的事。</p>
      ) : (
        <ul className="mt-1.5 list-disc space-y-0.5 pl-5 text-[13px] text-ink-2">
          {items.map((t) => (
            <li key={t}>{t}</li>
          ))}
        </ul>
      )}
      <p className="mt-1.5 text-[12px] text-ink-3">只是提醒，不拦交班；在交班备注里写清交给谁。</p>
    </Card>
  );
}
