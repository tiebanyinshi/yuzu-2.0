// 客诉台账（8.2.3，docs/V8223_FRONTDESK.md 第 3 条）：前台备注里带「客诉」「特殊关照」等标签的（标签清单在后台「手牌与前台 → 客人与提醒」），
// 按营业日、状态、标签筛；门店按顶上的门店切换（「合并看」时是几家店）。没处理的可以标「已处理」（写处理结果，只能标一次）；
// 一键打印是 A4 的打印页（/print/complaints/…）。
import { useState } from 'react';
import { Navigate } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCheck } from 'lucide-react';
import { COMPLAINT_STATUS_LABELS, COMPLAINT_STATUSES, complaintsPath, type ComplaintLedger, type ComplaintRow, type ComplaintStatus } from '@shared/frontdesk-v8223';
import { api, errorMessage } from '../../lib/api';
import { useBusinessToday } from '../../lib/revenue';
import { useCan } from '../../lib/session';
import { cn, formatDateTime } from '../../lib/utils';
import { PageHeader } from '../../components/AppShell';
import { DataTable, type DataColumn } from '../../components/DataTable';
import { ReasonDialog } from '../../components/ReasonDialog';
import { useToast } from '../../components/Toast';
import { Badge, Button, Field, Input, Notice, Segmented, Select } from '../../components/ui';
import { PrintButton } from '../print/PrintButton';

/** 某天往前 n 天（YYYY-MM-DD） */
const daysBefore = (date: string, n: number) => new Date(Date.parse(`${date}T00:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10);

export function ComplaintsPage() {
  const can = useCan();
  const qc = useQueryClient();
  const toast = useToast();
  const today = useBusinessToday();
  const [from, setFrom] = useState(() => daysBefore(today, 6));
  const [to, setTo] = useState(today);
  const [status, setStatus] = useState<ComplaintStatus>('open');
  const [tag, setTag] = useState('');
  const [resolving, setResolving] = useState<ComplaintRow | null>(null);
  const [busy, setBusy] = useState(false);
  const q = useQuery({
    queryKey: ['frontdesk', 'complaints', from, to, status, tag],
    queryFn: () => api.get<ComplaintLedger>(`${complaintsPath(from, to, status)}${tag ? `&tag=${encodeURIComponent(tag)}` : ''}`),
    enabled: can('frontdesk.complaints') && from <= to,
  });
  if (!can('frontdesk.complaints')) return <Navigate to="/crm" replace />;

  const columns: DataColumn<ComplaintRow>[] = [
    { key: 'date', header: '营业日', cell: (r) => <span className="num">{r.businessDate}</span>, className: 'whitespace-nowrap' },
    { key: 'store', header: '门店', cell: (r) => r.storeName, className: 'whitespace-nowrap' },
    { key: 'tag', header: '标签', cell: (r) => <Badge tone="clay">{r.tag}</Badge> },
    {
      key: 'guest',
      header: '客人',
      cell: (r) => (
        <span className="whitespace-nowrap">
          <b className="num">{r.tagCode}</b> {r.guest}
        </span>
      ),
    },
    { key: 'note', header: '内容', cell: (r) => <span className={cn('block max-w-[28rem] break-words whitespace-normal', r.removed && 'text-ink-3 line-through')}>{r.note}</span> },
    {
      key: 'by',
      header: '记录',
      cell: (r) => (
        <span className="text-[12.5px] whitespace-nowrap text-ink-3">
          {r.createdByName} · {formatDateTime(r.createdAt)}
        </span>
      ),
    },
    {
      key: 'status',
      header: '状态',
      cell: (r) =>
        r.resolved ? (
          <span className="block max-w-[16rem] text-[12.5px] whitespace-normal">
            <Badge tone="pine">已处理</Badge> {r.resolved.byName} {formatDateTime(r.resolved.at)}：{r.resolved.note}
          </span>
        ) : r.removed ? (
          <Badge tone="neutral">已撤下</Badge>
        ) : (
          <Button size="sm" variant="secondary" icon={<CheckCheck className="size-4" />} onClick={() => setResolving(r)} data-testid={`complaint-resolve-${r.remarkId}`}>
            标已处理
          </Button>
        ),
    },
  ];

  return (
    <>
      <PageHeader
        title="客诉台账"
        subtitle="前台备注里带客诉类标签的，按营业日汇总；门店按顶上的门店切换"
        actions={
          <PrintButton path={`/print/complaints/${from}/${to}/${status}`} paper="a4" size="sm" testId="complaints-print">
            打印台账
          </PrintButton>
        }
      />
      <div className="space-y-4 px-5 py-4 md:px-6">
        <div className="flex flex-wrap items-end gap-3">
          <Field label="从" htmlFor="complaints-from">
            <Input id="complaints-from" type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} fullWidth={false} className="h-10 w-40" />
          </Field>
          <Field label="到" htmlFor="complaints-to">
            <Input id="complaints-to" type="date" value={to} min={from} max={today} onChange={(e) => setTo(e.target.value)} fullWidth={false} className="h-10 w-40" />
          </Field>
          <Field label="标签" htmlFor="complaints-tag">
            <Select id="complaints-tag" value={tag} onChange={(e) => setTag(e.target.value)} fullWidth={false} className="h-10 w-32">
              <option value="">全部</option>
              {(q.data?.tags ?? []).map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </Select>
          </Field>
          <Segmented value={status} onChange={setStatus} ariaLabel="状态" options={COMPLAINT_STATUSES.map((s) => ({ value: s, label: COMPLAINT_STATUS_LABELS[s] }))} />
        </div>
        {q.data?.truncated && <Notice tone="warning" title="超过 500 条，只列了最近的 500 条，请缩短日期范围" />}
        <DataTable
          columns={columns}
          rows={q.data?.rows}
          rowKey={(r) => r.remarkId}
          rowTestId={(r) => `complaint-${r.remarkId}`}
          loading={q.isPending}
          failed={q.isError && !q.data}
          onRetry={() => void q.refetch()}
          empty="这段时间没有客诉类备注"
          onPage
          testId="complaints"
        />
      </div>
      <ReasonDialog
        open={!!resolving}
        title={resolving ? `标已处理：${resolving.tagCode} · ${resolving.note.slice(0, 20)}` : ''}
        description="写下怎么处理的；标了以后不能改，只能看"
        label="处理结果"
        confirmLabel="标已处理"
        busy={busy}
        testId="complaint-resolve"
        onClose={() => setResolving(null)}
        onConfirm={async (note) => {
          if (!resolving) return;
          setBusy(true);
          try {
            await api.post(`/api/frontdesk/complaints/${resolving.remarkId}/resolve`, { note });
            setResolving(null);
            toast({ tone: 'success', title: '已标「已处理」' });
            await qc.invalidateQueries({ queryKey: ['frontdesk', 'complaints'] });
          } catch (e) {
            toast({ tone: 'error', title: '没标上', body: errorMessage(e) });
          } finally {
            setBusy(false);
          }
        }}
      />
    </>
  );
}
