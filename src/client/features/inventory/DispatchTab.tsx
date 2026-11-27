// 物料发配记录（8.2.6，docs/MALL_V826.md）：部门申请的物料分几次给，库管在这里看哪些部门还在等料、到货以后「补发物料」。
// 页签：未完成（含部分发配）/ 未发配申请 / 已完成 / 已终止 / 全部；时间按最近一次发配筛，没发过的按申请提交时间。筛选记在本机，刷新后还在。

import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { PackageOpen, Search } from 'lucide-react';
import {
  DISPATCH_KIND_LABELS,
  DISPATCH_RANGE_LABELS,
  DISPATCH_RANGES,
  DISPATCH_STATUS_LABELS,
  DISPATCH_TAB_LABELS,
  DISPATCH_TABS,
  type DispatchBoard,
  type DispatchDetail,
  type DispatchRange,
  type DispatchRow,
  type DispatchStatus,
  type DispatchTab as Tab,
} from '@shared/dispatch';
import { formatQty, parseQty } from '@shared/quantity';
import { api, errorMessage, UncertainError } from '../../lib/api';
import { sendErpOp } from '../../lib/erpPending';
import { ErpPendingPanel } from '../../components/ErpPendingPanel';
import { useCan, useSession } from '../../lib/session';
import { formatDateTime, uuid } from '../../lib/utils';
import { EmptyState } from '../../components/EmptyState';
import { LoadFailed } from '../../components/LoadFailed';
import { Dialog } from '../../components/Overlay';
import { useToast } from '../../components/Toast';
import { Badge, Button, Card, Field, Input, Notice, Segmented, Skeleton } from '../../components/ui';

const STORE_KEY = 'yuzu.dispatch.filters';
interface Filters {
  tab: Tab;
  range: DispatchRange;
  from: string;
  to: string;
  q: string;
}
const DEFAULTS: Filters = { tab: 'open', range: 'all', from: '', to: '', q: '' };

function loadFilters(): Filters {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    return raw ? { ...DEFAULTS, ...(JSON.parse(raw) as Partial<Filters>) } : DEFAULTS;
  } catch {
    return DEFAULTS;
  }
}

const STATUS_TONE: Record<DispatchStatus, 'pine' | 'ember' | 'clay' | 'lake' | 'neutral' | 'yuzu'> = {
  pending: 'clay',
  partial: 'ember',
  awaiting: 'lake',
  ready: 'yuzu',
  done: 'pine',
  ended: 'neutral',
};

const qty = (milli: number, unit: string | null) => `${formatQty(milli)}${unit ? ` ${unit}` : ''}`;

export function DispatchTab() {
  const can = useCan();
  const canIssue = can('inventory.operate') || can('request.stock');
  const [f, setF] = useState<Filters>(loadFilters);
  const [openLine, setOpenLine] = useState<number | null>(null);
  const [issuing, setIssuing] = useState<DispatchRow | null>(null);
  useEffect(() => {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(f));
    } catch {
      // 本机存不了就算了，筛选照样能用
    }
  }, [f]);
  const qs = new URLSearchParams(
    Object.entries({ tab: f.tab, range: f.range, q: f.q.trim(), ...(f.range === 'custom' ? { from: f.from, to: f.to } : {}) }).filter(([, v]) => v) as [string, string][],
  ).toString();
  const board = useQuery({ queryKey: ['inventory', 'dispatch', qs], queryFn: () => api.get<DispatchBoard>(`/api/inventory/dispatch?${qs}`) });
  const set = (patch: Partial<Filters>) => setF((cur) => ({ ...cur, ...patch }));

  return (
    <div className="space-y-4" data-testid="dispatch-tab">
      <ErpPendingPanel types={['request_dispatch']} className="space-y-2" />
      <Card className="space-y-3 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <Segmented<Tab>
            ariaLabel="发配状态"
            value={f.tab}
            onChange={(tab) => set({ tab })}
            options={DISPATCH_TABS.map((t) => ({ value: t, label: `${DISPATCH_TAB_LABELS[t]}${board.data ? ` ${board.data.counts[t]}` : ''}` }))}
          />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Segmented<DispatchRange>
            ariaLabel="时间"
            size="sm"
            value={f.range}
            onChange={(range) => set({ range })}
            options={DISPATCH_RANGES.map((r) => ({ value: r, label: DISPATCH_RANGE_LABELS[r] }))}
          />
          {f.range === 'custom' && (
            <span className="flex items-center gap-1.5">
              <Input type="date" aria-label="起" value={f.from} onChange={(e) => set({ from: e.target.value })} className="h-9 w-auto" />
              <span className="text-ink-3">至</span>
              <Input type="date" aria-label="止" value={f.to} onChange={(e) => set({ to: e.target.value })} className="h-9 w-auto" />
            </span>
          )}
          <div className="relative min-w-52 flex-1">
            <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-3" />
            <Input value={f.q} onChange={(e) => set({ q: e.target.value })} placeholder="申请单号、部门、物品、申请人" className="h-9 pl-9" data-testid="dispatch-search" />
          </div>
        </div>
        <p className="text-[12.5px] text-ink-3">
          时间按最近一次发配筛，还没发过的按申请提交时间。部分发配的留在「未完成」，发齐了自动转「已完成」并通知申请人；库存可发量是总仓结存按先申请先给分到这一行的。
          {board.data?.since && ` 从 ${formatDateTime(board.data.since)} 起提交的需求单记在这里。`}
        </p>
      </Card>

      {board.error ? (
        <LoadFailed title="发配记录没有取回来" onRetry={() => void board.refetch()} retrying={board.isFetching} />
      ) : board.isPending ? (
        <Skeleton className="h-48 w-full" />
      ) : board.data.rows.length === 0 ? (
        <Card className="p-6">
          <EmptyState art="search" title={f.tab === 'open' ? '没有在等料的申请' : '没有匹配的记录'} />
        </Card>
      ) : (
        <div className="space-y-2.5" data-testid="dispatch-rows">
          {board.data.truncated && <Notice tone="info">记录很多，只列了前 1000 条；用搜索或时间收窄一点。</Notice>}
          {board.data.rows.map((r) => (
            <RowCard key={r.lineId} r={r} expanded={openLine === r.lineId} onToggle={() => setOpenLine(openLine === r.lineId ? null : r.lineId)} canIssue={canIssue} onIssue={() => setIssuing(r)} />
          ))}
        </div>
      )}
      {issuing && <IssueDialog row={issuing} onClose={() => setIssuing(null)} />}
    </div>
  );
}

function RowCard({ r, expanded, onToggle, canIssue, onIssue }: { r: DispatchRow; expanded: boolean; onToggle: () => void; canIssue: boolean; onIssue: () => void }) {
  return (
    <Card className="space-y-2 p-4" data-testid={`dispatch-row-${r.lineId}`} data-status={r.status}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-[15px] font-bold text-ink">
            {r.name}
            {r.materialName && r.materialName !== r.name && <span className="text-[13px] font-normal text-ink-3"> · {r.materialName}</span>}
          </p>
          <p className="text-[12.5px] text-ink-3">
            <Link to={`/erp/requests?request=${r.requestId}`} className="num font-semibold text-pine hover:underline">
              {r.docNo}
            </Link>{' '}
            · {r.departmentName} · {r.requesterName} · 提交 {formatDateTime(r.submittedAt)}
          </p>
        </div>
        <Badge tone={STATUS_TONE[r.status]} data-testid={`dispatch-status-${r.lineId}`}>
          {DISPATCH_STATUS_LABELS[r.status]}
        </Badge>
      </div>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-[13px] sm:grid-cols-4">
        <div>
          <dt className="text-ink-3">申请量</dt>
          <dd className="num font-semibold">{qty(r.appliedMilli, r.unit)}</dd>
        </div>
        <div>
          <dt className="text-ink-3">已发配</dt>
          <dd className="num font-semibold" data-testid={`dispatch-issued-${r.lineId}`}>
            {qty(r.issuedMilli, r.unit)}
          </dd>
        </div>
        <div>
          <dt className="text-ink-3">待发配</dt>
          <dd className="num font-semibold text-ember" data-testid={`dispatch-pending-${r.lineId}`}>
            {qty(r.pendingMilli, r.unit)}
          </dd>
        </div>
        <div>
          <dt className="text-ink-3">库存可发 / 在途</dt>
          <dd className="num">
            {qty(r.availableMilli, r.inventoryUnit)} / {qty(r.inTransitMilli, r.inventoryUnit)}
            {r.expectedDate && <span className="text-ink-3">（预计 {r.expectedDate}）</span>}
          </dd>
        </div>
      </dl>
      {r.lastIssue && (
        <p className="text-[12.5px] text-ink-2">
          最近一次：{r.lastIssue.docNo} 发 {qty(r.lastIssue.qtyMilli, r.unit)} · {DISPATCH_KIND_LABELS[r.lastIssue.kind]} · {r.lastIssue.byName} · {formatDateTime(r.lastIssue.at)}
          {r.issueCount > 1 && `（共 ${r.issueCount} 次）`}
        </p>
      )}
      <div className="flex flex-wrap justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={onToggle} data-testid={`dispatch-history-${r.lineId}`}>
          {expanded ? '收起发配记录' : '查看发配记录'}
        </Button>
        {canIssue && r.status === 'ready' && (
          <Button size="sm" variant="primary" icon={<PackageOpen className="size-4" />} onClick={onIssue} data-testid={`dispatch-issue-${r.lineId}`}>
            补发物料
          </Button>
        )}
      </div>
      {expanded && <IssueHistory lineId={r.lineId} unit={r.unit} />}
    </Card>
  );
}

function IssueHistory({ lineId, unit }: { lineId: number; unit: string }) {
  const q = useQuery({ queryKey: ['inventory', 'dispatch', 'line', lineId], queryFn: () => api.get<DispatchDetail>(`/api/inventory/dispatch/lines/${lineId}`) });
  if (q.error) return <LoadFailed title="发配明细没有取回来" onRetry={() => void q.refetch()} retrying={q.isFetching} />;
  if (!q.data) return <Skeleton className="h-16 w-full" />;
  if (!q.data.issues.length) return <p className="text-[12.5px] text-ink-3">还没有发配过。</p>;
  return (
    <ol className="divide-y divide-line rounded-xl ring-1 ring-line" data-testid={`dispatch-issues-${lineId}`}>
      {q.data.issues.map((i, n) => (
        <li key={i.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-[13px]">
          <span>
            第 {n + 1} 次 · <span className="num font-semibold">{qty(i.qtyMilli, unit)}</span> · {DISPATCH_KIND_LABELS[i.kind]}
            {i.note && <span className="text-ink-3"> · {i.note}</span>}
          </span>
          <span className="text-ink-3">
            领料单 {i.docNo} · {i.byName} · {formatDateTime(i.at)}
            {i.voided && <Badge tone="neutral">已作废，不算</Badge>}
          </span>
        </li>
      ))}
    </ol>
  );
}

function IssueDialog({ row, onClose }: { row: DispatchRow; onClose: () => void }) {
  const session = useSession();
  const toast = useToast();
  const qc = useQueryClient();
  // 默认填这次能发的：待发配量与库存可发量里小的那个（单位换不了的按待发配量，出库数另填）
  const suggest = row.unitMode === 'inventory' ? Math.min(row.pendingMilli, row.availableMilli) : row.pendingMilli;
  const [amount, setAmount] = useState(formatQty(suggest).replace(/,/g, ''));
  const [stockAmount, setStockAmount] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const q = parseQty(amount);
  const sq = parseQty(stockAmount);
  const submit = async () => {
    if (!q) return;
    setBusy(true);
    setError(null);
    try {
      const key = uuid();
      await sendErpOp<DispatchDetail>({
        key,
        type: 'request_dispatch',
        method: 'POST',
        url: `/api/inventory/dispatch/lines/${row.lineId}/issue`,
        body: { clientKey: key, qtyMilli: q, ...(row.unitMode === null && sq ? { stockQtyMilli: sq } : {}), note: note.trim() },
        summary: `补发 ${row.docNo} ${row.name} ${formatQty(q)} ${row.unit} 给${row.departmentName}`,
        staffName: session.staff.displayName,
        staffId: session.staff.id,
      });
      toast({ tone: 'success', title: `已补发 ${formatQty(q)} ${row.unit}`, body: `${row.departmentName} · ${row.name}` });
      void qc.invalidateQueries({ queryKey: ['inventory'] });
      onClose();
    } catch (e) {
      if (e instanceof UncertainError) {
        toast({ tone: 'info', title: '结果待确认', body: '网络中断，记录留在本机；请在页面顶部查回结果、按原内容重新提交或确认作废。' });
        onClose();
      } else setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title={`补发物料：${row.name}`}
      width="max-w-md"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button variant="primary" loading={busy} disabled={!q || (row.unitMode === null && !sq)} onClick={() => void submit()} data-testid="dispatch-issue-submit">
            开领料单并发配
          </Button>
        </>
      }
    >
      <div className="space-y-3 text-[13.5px]">
        <p className="text-ink-2">
          {row.docNo} · {row.departmentName} · 申请 {qty(row.appliedMilli, row.unit)}，已发 {qty(row.issuedMilli, row.unit)}，还差 <b>{qty(row.pendingMilli, row.unit)}</b>；总仓可发{' '}
          {qty(row.availableMilli, row.inventoryUnit)}。
        </p>
        <Field label={`这次发多少（${row.unit}）`} htmlFor="dispatch-qty">
          <Input id="dispatch-qty" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} invalid={!q} data-testid="dispatch-qty" />
        </Field>
        {row.unitMode === null && (
          <Field label={`实际出库多少（${row.inventoryUnit ?? '库存单位'}）`} htmlFor="dispatch-stock-qty" hint={`申请的单位「${row.unit}」换不成库存单位，请另填出库数`}>
            <Input id="dispatch-stock-qty" inputMode="decimal" value={stockAmount} onChange={(e) => setStockAmount(e.target.value)} />
          </Field>
        )}
        <Field label="备注（选填）" htmlFor="dispatch-note">
          <Input id="dispatch-note" maxLength={100} value={note} onChange={(e) => setNote(e.target.value)} placeholder="例如：第二批到货" />
        </Field>
        <p className="text-[12.5px] text-ink-3">与部门领料同一条路：开一张部门领料单、马上生效，记一条发配记录。</p>
        {error && <Notice tone="error">{error}</Notice>}
      </div>
    </Dialog>
  );
}
