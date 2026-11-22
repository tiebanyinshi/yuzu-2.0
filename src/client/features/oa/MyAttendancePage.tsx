// OA-08 员工「办公 → 我的考勤」（docs/OA.md 第 11 节）：本人一个月每条排班的结算结果（正常、迟到、早退、缺卡、旷工、外勤）。
// 下班窗口结束以后才结算，今天的班要等下班以后才有。有请假、出差或漏打卡的，走审批或补卡（OA-11、OA-13）。

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { attendanceIssues, ATTENDANCE_STATUS_LABELS, type MyAttendance } from '@shared/oa';
import { clockText } from '@shared/technician-admin';
import { api } from '../../lib/api';
import { PageHeader } from '../../components/AppShell';
import { EmptyState } from '../../components/EmptyState';
import { LoadFailed } from '../../components/LoadFailed';
import { Badge, Button, Card, Skeleton } from '../../components/ui';

function addMonths(month: string, n: number): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(y, m - 1 + n, 1)).toISOString().slice(0, 7);
}

export function MyAttendancePage() {
  const [month, setMonth] = useState<string | null>(null);
  const q = useQuery({ queryKey: ['oa', 'my-attendance', month], queryFn: () => api.get<MyAttendance>(`/api/oa/me/attendance${month ? `?month=${month}` : ''}`) });
  const d = q.data;
  const current = month ?? d?.month ?? null;
  const abnormal = d?.rows.filter((r) => r.status !== 'normal').length ?? 0;
  return (
    <>
      <PageHeader dateMode="calendar" title="我的考勤" subtitle="每条排班下班以后结算；有请假、出差或漏打卡的，走审批或补卡" />
      <div className="mx-auto w-full max-w-3xl p-4 md:p-7">
        {q.isPending ? (
          <Skeleton className="h-72" />
        ) : q.isError && !d ? (
          <LoadFailed title="考勤没有取回来" onRetry={() => q.refetch()} retrying={q.isFetching} />
        ) : (
          <Card className="p-4 md:p-5" data-testid="my-attendance">
            <div className="mb-3 flex items-center justify-between gap-2">
              <Button size="sm" variant="ghost" icon={<ChevronLeft className="size-4" />} onClick={() => current && setMonth(addMonths(current, -1))} aria-label="上个月" />
              <p className="text-center">
                <span className="num text-[16px] font-bold text-ink">{d!.month.replace('-', ' 年 ')} 月</span>
                <span className="ml-2 text-[13px] text-ink-3">
                  {d!.rows.length} 班{abnormal ? `，异常 ${abnormal}` : ''}
                </span>
              </p>
              <Button size="sm" variant="ghost" icon={<ChevronRight className="size-4" />} onClick={() => current && setMonth(addMonths(current, 1))} aria-label="下个月" />
            </div>
            {d!.rows.length === 0 ? (
              <EmptyState title="这个月还没有结算的考勤" />
            ) : (
              <ul className="divide-y divide-line">
                {d!.rows.map((r) => (
                  <li key={r.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2.5" data-testid={`my-att-${r.businessDate}-${r.shiftId}`}>
                    <span className="num w-12 font-semibold text-ink">{r.businessDate.slice(5)}</span>
                    <span className="text-ink-2">
                      {r.shiftName}
                      <span className="num ml-1 text-[12px] text-ink-3">
                        {clockText(r.startMinute)}–{clockText(r.endMinute)}
                      </span>
                    </span>
                    <span className="num text-[13px] text-ink-3">
                      {r.inAt?.time ?? '—'} / {r.outAt?.time ?? '—'}
                    </span>
                    <span className="ml-auto flex flex-wrap items-center gap-1">
                      <Badge tone={r.status === 'normal' ? 'pine' : r.status === 'absent' ? 'clay' : 'ember'}>{ATTENDANCE_STATUS_LABELS[r.status]}</Badge>
                      {attendanceIssues(r)
                        .filter((t) => t !== '旷工')
                        .map((t) => (
                          <span key={t} className="text-[13px] text-ember">
                            {t}
                          </span>
                        ))}
                      {r.outwork && <Badge tone="lake">外勤</Badge>}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        )}
      </div>
    </>
  );
}
