// OA-18 员工端「办公 → 工资条」（docs/OA.md 第 21 节，OA22）：只列本人、已发放的工资条，按月倒序。
//   · 列表：月份、标题、实发、签收没有；点开看明细（与后台预览同一个部件 PayslipCard）。
//   · 明细：「确认签收」记签收时间（签过的不再显示按钮）；「有异议」打开办公审批「工资条异议」，工资条那一栏自动填好。
// 接口一律按「登录的人 = 工资条的人」取，打开、签收都留薪资审计。

import { useState } from 'react';
import { Link, useLocation } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, MessageSquareWarning } from 'lucide-react';
import { monthLabel, type MyPayslipDetail, type MyPayslipItem } from '@shared/oa-payroll';
import { api, errorMessage } from '../../lib/api';
import { formatDateTime } from '../../lib/utils';
import { PageHeader } from '../../components/AppShell';
import { EmptyState } from '../../components/EmptyState';
import { LoadFailed } from '../../components/LoadFailed';
import { useToast } from '../../components/Toast';
import { Badge, Button, Card, Skeleton } from '../../components/ui';
import { PayslipCard } from './PayslipCard';

const KEY = ['oa', 'my-payslips'] as const;

export function MyPayslipPages() {
  const { pathname } = useLocation();
  const m = /^\/oa\/payslips\/(\d+)/.exec(pathname);
  return m ? <MyPayslipDetailPage id={Number(m[1])} /> : <MyPayslipListPage />;
}

function MyPayslipListPage() {
  const q = useQuery({ queryKey: KEY, queryFn: () => api.get<MyPayslipItem[]>('/api/oa/my/payslips') });
  return (
    <>
      <div className="max-md:hidden">
        <PageHeader dateMode="calendar" title="工资条" subtitle="只有你自己看得到；看过没问题请确认签收" />
      </div>
      <div className="mx-auto w-full max-w-2xl space-y-3 p-3 md:p-7">
        <h1 className="text-[17px] font-bold text-ink md:hidden">工资条</h1>
        <Card className="p-2 md:p-3" data-testid="my-payslips">
          {q.isPending ? (
            <Skeleton className="h-40" />
          ) : q.isError && !q.data ? (
            <LoadFailed title="工资条没有取回来" onRetry={() => q.refetch()} retrying={q.isFetching} />
          ) : q.data!.length === 0 ? (
            <EmptyState title="还没有工资条" description="人事发放以后会在这里，同时收到通知" />
          ) : (
            <ul className="divide-y divide-line">
              {q.data!.map((p) => (
                <li key={p.id}>
                  <Link to={`/oa/payslips/${p.id}`} className="tap relative flex items-center gap-3 px-2 py-3" data-testid={`my-payslip-${p.id}`}>
                    <span className="min-w-0 flex-1">
                      <span className="block font-semibold text-ink">{monthLabel(p.month)}</span>
                      <span className="block truncate text-[13px] text-ink-3">{p.title}</span>
                    </span>
                    {p.signedAt ? <Badge tone="neutral">已签收</Badge> : <Badge tone="yuzu">待签收</Badge>}
                    <ChevronRight className="size-4 shrink-0 text-ink-3" />
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </>
  );
}

function MyPayslipDetailPage({ id }: { id: number }) {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: [...KEY, id], queryFn: () => api.get<MyPayslipDetail>(`/api/oa/my/payslips/${id}`), refetchOnWindowFocus: false });
  const [busy, setBusy] = useState(false);
  const d = q.data;
  const sign = async () => {
    setBusy(true);
    try {
      const r = await api.post<MyPayslipDetail>(`/api/oa/my/payslips/${id}/sign`);
      qc.setQueryData([...KEY, id], r);
      void qc.invalidateQueries({ queryKey: KEY, exact: true });
      toast({ tone: 'success', title: '已签收' });
    } catch (e) {
      // 签收按结果写：没收到结果的刷新看现状，再点一次结果一样
      toast({ tone: 'error', title: '没有办成', body: errorMessage(e) });
      void q.refetch();
    } finally {
      setBusy(false);
    }
  };
  const objection = d ? `/oa/approvals/new/payslip_objection?f.payslip=${encodeURIComponent(`${monthLabel(d.month)} · ${d.title}`)}` : '';
  return (
    <>
      <div className="max-md:hidden">
        <PageHeader
          dateMode="calendar"
          title="工资条"
          actions={
            <Link to="/oa/payslips" className="tap relative inline-flex h-9 items-center gap-1 text-[14px] font-semibold text-pine" data-testid="my-payslip-back">
              <ChevronLeft className="size-4" />
              全部
            </Link>
          }
        />
      </div>
      <div className="mx-auto w-full max-w-2xl space-y-3 p-3 md:space-y-4 md:p-7">
        <Link to="/oa/payslips" className="tap relative inline-flex items-center gap-1 text-[14px] font-semibold text-pine md:hidden" data-testid="my-payslip-back-mobile">
          <ChevronLeft className="size-4" />
          全部工资条
        </Link>
        {q.isPending ? (
          <Skeleton className="h-80" />
        ) : q.isError && !d ? (
          <LoadFailed title="工资条没有取回来" onRetry={() => q.refetch()} retrying={q.isFetching} />
        ) : (
          <>
            <PayslipCard month={d!.month} title={d!.title} name={d!.name} fields={d!.fields} values={d!.values} />
            <div className="flex flex-wrap items-center gap-3" data-testid="my-payslip-actions">
              {d!.signedAt ? (
                <span className="text-[14px] text-ink-2" data-testid="my-payslip-signed">
                  已于 {formatDateTime(d!.signedAt)} 签收
                </span>
              ) : (
                <Button variant="primary" size="lg" loading={busy} onClick={() => void sign()} data-testid="my-payslip-sign">
                  确认签收
                </Button>
              )}
              <Link to={objection} className="tap relative ml-auto inline-flex items-center gap-1 text-[14px] font-semibold text-clay" data-testid="my-payslip-objection">
                <MessageSquareWarning className="size-4" />
                有异议
              </Link>
            </div>
          </>
        )}
      </div>
    </>
  );
}
