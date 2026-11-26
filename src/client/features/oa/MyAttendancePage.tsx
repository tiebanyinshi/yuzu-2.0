// OA-08 / 员工办公 v1.1 第 3 批（docs/OA.md 第 11 节；docs/OA_MOBILE.md 第五节）：
// 员工「我的考勤」：本月考勤汇总、全部 / 异常筛选、每条排班结算结果与异常一键「去补卡」（自动带入日期、班次、补哪张卡；
// 已有审批中补卡单的直达审批详情），适配 PC 与手机 360×800（零横向滚动）。

import { useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, FilePenLine, Palmtree } from 'lucide-react';
import { shiftDate } from '@shared/labels';
import { isAttendanceAbnormal, MAKEUP_BACK_DAYS, type AttendanceDailyRow, type AttendanceMonthStats, type MyAttendance, type MyAttendancePendingMakeup } from '@shared/oa';
import { clockText } from '@shared/technician-admin';
import { api } from '../../lib/api';
import { PageHeader } from '../../components/AppShell';
import { EmptyState } from '../../components/EmptyState';
import { LoadFailed } from '../../components/LoadFailed';
import { AttendanceStatus } from './AttendanceStatus';
import { Badge, Button, Card, Segmented, Skeleton } from '../../components/ui';

type Filter = 'all' | 'abnormal';

/** 本月汇总（月报的几项，员工看得懂的叫法） */
const SUMMARY: { key: string; label: string; get: (s: AttendanceMonthStats) => number }[] = [
  { key: 'scheduledDays', label: '应出勤', get: (s) => s.scheduledDays },
  { key: 'attendedDays', label: '实际出勤', get: (s) => s.attendedDays },
  { key: 'lateCount', label: '迟到', get: (s) => s.lateCount },
  { key: 'missingCount', label: '缺卡', get: (s) => s.missingCount },
  { key: 'absentCount', label: '旷工', get: (s) => s.absentCount },
  // OA-13：请假（天）、出差（天）、加班（小时，三类合计）
  { key: 'leaveDays', label: '请假（天）', get: (s) => s.leaveHalves / 2 },
  { key: 'tripDays', label: '出差（天）', get: (s) => s.tripDays },
  {
    key: 'overtimeHours',
    label: '加班（小时）',
    get: (s) => Math.round(((s.overtimeWorkdayMinutes + s.overtimeRestMinutes + s.overtimeHolidayMinutes) / 60) * 10) / 10,
  },
];

function addMonths(month: string, n: number): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(y, m - 1 + n, 1)).toISOString().slice(0, 7);
}

const makeupUrl = (row: AttendanceDailyRow, kind: 'in' | 'out') => `/oa/approvals/new/makeup?date=${encodeURIComponent(row.businessDate)}&shiftId=${row.shiftId}&kind=${kind}`;

function MakeupAction({ row, kind, pending, withinWindow }: { row: AttendanceDailyRow; kind: 'in' | 'out'; pending: MyAttendancePendingMakeup | undefined; withinWindow: boolean }) {
  const label = kind === 'in' ? '补上班卡' : '补下班卡';
  if (pending) {
    return (
      <Link
        to={`/oa/approvals/${pending.approvalId}`}
        data-testid={`my-att-makeup-pending-${row.businessDate}-${row.shiftId}-${kind}`}
        className="tap relative inline-flex h-8 items-center rounded-md border border-line bg-paper-2 px-2.5 text-[12.5px] font-semibold text-ink-2 hover:border-line-strong"
      >
        {label}审批中
      </Link>
    );
  }
  if (!withinWindow) return null;
  return (
    <Link
      to={makeupUrl(row, kind)}
      data-testid={`my-att-makeup-${row.businessDate}-${row.shiftId}-${kind}`}
      className="tap relative inline-flex h-8 items-center gap-1 rounded-md bg-pine px-2.5 text-[12.5px] font-semibold text-white hover:opacity-95"
    >
      <FilePenLine className="size-3.5" />
      {label}
    </Link>
  );
}

export function MyAttendancePage() {
  const [params, setParams] = useSearchParams();
  const [month, setMonth] = useState<string | null>(null);
  const filter: Filter = params.get('filter') === 'abnormal' ? 'abnormal' : 'all';
  const setFilter = (next: Filter) => {
    const p = new URLSearchParams(params);
    if (next === 'abnormal') p.set('filter', 'abnormal');
    else p.delete('filter');
    setParams(p, { replace: true });
  };
  const q = useQuery({ queryKey: ['oa', 'my-attendance', month], queryFn: () => api.get<MyAttendance>(`/api/oa/me/attendance${month ? `?month=${month}` : ''}`) });
  const d = q.data;
  const current = month ?? d?.month ?? null;
  const abnormalRows = d?.rows.filter((r) => isAttendanceAbnormal(r.status)) ?? [];
  const shown = filter === 'abnormal' ? abnormalRows : (d?.rows ?? []);
  const pendingMap = new Map<string, MyAttendancePendingMakeup>();
  for (const pm of d?.pendingMakeups ?? []) pendingMap.set(`${pm.date}|${pm.shiftId}|${pm.kind}`, pm);
  const makeupMinDate = d ? shiftDate(d.today, -MAKEUP_BACK_DAYS) : '';

  return (
    <>
      <div className="max-md:hidden">
        <PageHeader dateMode="calendar" title="我的考勤" subtitle="每条排班下班以后结算；有请假、出差或漏打卡的，走审批或一键补卡" />
      </div>
      <div className="mx-auto w-full max-w-3xl space-y-3 p-3 md:p-7">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h1 className="text-[17px] font-bold text-ink md:hidden">我的考勤</h1>
          <div className="flex items-center gap-2 md:ml-auto">
            <Link
              to="/oa/approvals/new/leave"
              data-testid="my-att-go-leave"
              className="tap relative inline-flex h-8 items-center gap-1 rounded-md border border-line bg-card px-2.5 text-[13px] font-semibold text-ink-2 hover:border-line-strong"
            >
              <Palmtree className="size-3.5 text-pine" />
              去请假
            </Link>
            <Link
              to="/oa/approvals/new/makeup"
              data-testid="my-att-go-makeup"
              className="tap relative inline-flex h-8 items-center gap-1 rounded-md border border-line bg-card px-2.5 text-[13px] font-semibold text-ink-2 hover:border-line-strong"
            >
              <FilePenLine className="size-3.5 text-pine" />
              去补卡
            </Link>
          </div>
        </div>
        {q.isPending ? (
          <Skeleton className="h-72" />
        ) : q.isError && !d ? (
          <LoadFailed title="考勤没有取回来" onRetry={() => q.refetch()} retrying={q.isFetching} />
        ) : (
          <Card className="p-3.5 md:p-5" data-testid="my-attendance">
            <div className="mb-3 flex items-center justify-between gap-2">
              <Button
                size="sm"
                variant="ghost"
                icon={<ChevronLeft className="size-4" />}
                onClick={() => current && setMonth(addMonths(current, -1))}
                aria-label="上个月"
                data-testid="my-att-prev-month"
              />
              <p className="min-w-0 text-center">
                <span className="num text-[16px] font-bold text-ink" data-testid="my-att-month">
                  {d!.month.replace('-', ' 年 ')} 月
                </span>
                <span className="ml-2 text-[13px] text-ink-3">
                  {d!.rows.length} 班{abnormalRows.length ? `，异常 ${abnormalRows.length}` : ''}
                </span>
              </p>
              <Button
                size="sm"
                variant="ghost"
                icon={<ChevronRight className="size-4" />}
                onClick={() => current && setMonth(addMonths(current, 1))}
                aria-label="下个月"
                data-testid="my-att-next-month"
              />
            </div>
            <dl className="mb-3 grid grid-cols-4 gap-2 rounded-md bg-paper-2 p-2.5 text-center sm:grid-cols-8 sm:p-3" data-testid="my-attendance-summary">
              {SUMMARY.map((c) => (
                <div key={c.key} className="min-w-0">
                  <dt className="text-[12px] leading-tight text-ink-3">{c.label}</dt>
                  <dd className="num text-[16px] font-bold text-ink" data-testid={`my-att-sum-${c.key}`}>
                    {c.get(d!.summary)}
                  </dd>
                </div>
              ))}
            </dl>
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <Segmented<Filter>
                size="sm"
                value={filter}
                onChange={setFilter}
                ariaLabel="考勤明细筛选"
                options={[
                  { value: 'all', label: <span data-testid="my-att-tab-all">全部 {d!.rows.length}</span> },
                  { value: 'abnormal', label: <span data-testid="my-att-tab-abnormal">异常{abnormalRows.length ? ` ${abnormalRows.length}` : ''}</span> },
                ]}
              />
              {abnormalRows.length > 0 && <span className="text-[12px] text-ink-3">漏打卡可在 {MAKEUP_BACK_DAYS} 天内一键补卡</span>}
            </div>
            {shown.length === 0 ? (
              <EmptyState title={filter === 'abnormal' ? '这个月没有考勤异常' : '这个月还没有结算的考勤'} />
            ) : (
              <ul className="divide-y divide-line" data-testid="my-att-list">
                {shown.map((r) => {
                  const withinWindow = r.businessDate >= makeupMinDate && r.businessDate <= d!.today;
                  const pmIn = pendingMap.get(`${r.businessDate}|${r.shiftId}|in`);
                  const pmOut = pendingMap.get(`${r.businessDate}|${r.shiftId}|out`);
                  const needsMakeup = r.missingIn || r.missingOut;
                  const expired = needsMakeup && !withinWindow && !pmIn && !pmOut;
                  return (
                    <li key={r.id} className="space-y-1.5 py-2.5" data-testid={`my-att-${r.businessDate}-${r.shiftId}`}>
                      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
                        <span className="num w-11 shrink-0 font-semibold text-ink">{r.businessDate.slice(5)}</span>
                        <span className="min-w-0 text-[14px] text-ink-2">
                          {r.shiftName}
                          <span className="num ml-1 text-[12px] text-ink-3">
                            {clockText(r.startMinute)}–{clockText(r.endMinute)}
                          </span>
                        </span>
                        <span className="num text-[13px] text-ink-3">
                          {r.inAt?.time ?? '—'} / {r.outAt?.time ?? '—'}
                        </span>
                        <span className="ml-auto flex flex-wrap items-center gap-1">
                          <AttendanceStatus row={r} />
                          {r.outwork && <Badge tone="lake">外勤</Badge>}
                        </span>
                      </div>
                      {(needsMakeup || r.coverApprovalId !== null) && (
                        <div className="flex flex-wrap items-center gap-2 pl-0 sm:pl-13">
                          {r.missingIn && <MakeupAction row={r} kind="in" pending={pmIn} withinWindow={withinWindow} />}
                          {r.missingOut && <MakeupAction row={r} kind="out" pending={pmOut} withinWindow={withinWindow} />}
                          {expired && <span className="text-[12px] text-ink-3">已超 {MAKEUP_BACK_DAYS} 天补卡期</span>}
                          {r.coverApprovalId !== null && (
                            <Link
                              to={`/oa/approvals/${r.coverApprovalId}`}
                              data-testid={`my-att-cover-${r.businessDate}-${r.shiftId}`}
                              className="tap relative text-[12.5px] font-semibold text-pine hover:underline"
                            >
                              查看关联审批单
                            </Link>
                          )}
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>
        )}
      </div>
    </>
  );
}
