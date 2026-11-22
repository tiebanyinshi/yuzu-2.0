// OA-09 员工「办公 → 假期余额」（docs/OA.md 第 12 节）：本人今年各「管余额」假种的剩余、已用与明细；其他假种只列规则。
// 请假在审批里提（OA-11），审批通过后扣余额（OA-13）。

import { useQuery } from '@tanstack/react-query';
import { halvesText, type MyLeave } from '@shared/oa';
import { api } from '../../lib/api';
import { PageHeader } from '../../components/AppShell';
import { LoadFailed } from '../../components/LoadFailed';
import { Card, Skeleton } from '../../components/ui';
import { EntryList } from './LeaveEntryList';

export function MyLeavePage() {
  const q = useQuery({ queryKey: ['oa', 'my-leave'], queryFn: () => api.get<MyLeave>('/api/oa/me/leave') });
  const d = q.data;
  return (
    <>
      <PageHeader dateMode="calendar" title="假期余额" subtitle="年假按入职日期每年自动发放；请假审批通过后扣减" />
      <div className="mx-auto w-full max-w-3xl space-y-4 p-4 md:p-7">
        {q.isPending ? (
          <Skeleton className="h-60" />
        ) : q.isError && !d ? (
          <LoadFailed title="假期余额没有取回来" onRetry={() => q.refetch()} retrying={q.isFetching} />
        ) : (
          <>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-3" data-testid="my-leave">
              {d!.balances.map((b) => (
                <Card key={b.leaveTypeId} className="p-4" data-testid={`my-leave-${b.leaveTypeId}`}>
                  <p className="text-[13px] text-ink-3">
                    {d!.year} 年{b.name}
                  </p>
                  <p className="num mt-1 text-[22px] font-bold text-ink">{halvesText(b.grantedHalves - b.usedHalves)}</p>
                  <p className="num text-[12px] text-ink-3">
                    发放 {b.grantedHalves / 2} · 已用 {b.usedHalves / 2}
                  </p>
                </Card>
              ))}
            </div>
            <Card className="p-4 md:p-5">
              <p className="mb-2 text-[13px] font-bold text-ink-2">假种</p>
              <ul className="space-y-1 text-[13px] text-ink-2">
                {d!.types.map((t) => (
                  <li key={t.id}>
                    <span className="font-semibold text-ink">{t.name}</span>：{t.paid ? '带薪' : '不带薪'}
                    {t.proofRequired ? '，要证明附件' : ''}
                    {t.hasBalance ? '，按余额' : ''}
                  </li>
                ))}
              </ul>
            </Card>
            <Card className="p-4 md:p-5">
              <p className="mb-1 text-[13px] font-bold text-ink-2">{d!.year} 年明细</p>
              <EntryList entries={d!.entries} />
            </Card>
          </>
        )}
      </div>
    </>
  );
}
