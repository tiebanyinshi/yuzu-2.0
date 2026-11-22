// OA-08 后台「考勤设置 → 考勤结果」（docs/OA.md 第 11 节）：某一天每条排班的结算结果。
// 上下班卡时间、迟到早退、缺卡、外勤与人脸待核对；可只看异常、按考勤组筛。
// 人事（hr.attendance）可以对外勤点「算出勤 / 不算出勤」（带页面上看到的原值）、对这一天「重新结算」（重算是幂等的，结果不确定时再点一次即可）。
// 部门负责人只看本部门、不能改。下班窗口还没结束的排班还没结算，不在这里。

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';
import type { AttendanceDailyRow, AttendanceDay } from '@shared/oa';
import { clockText } from '@shared/technician-admin';
import { api, errorMessage, UncertainError } from '../../lib/api';
import { useSession } from '../../lib/session';
import { DataTable } from '../../components/DataTable';
import { EmptyState } from '../../components/EmptyState';
import { LoadFailed } from '../../components/LoadFailed';
import { useToast } from '../../components/Toast';
import { AttendanceStatus } from './AttendanceStatus';
import { Badge, Button, Card, ConfirmCheck, Input, Select, Skeleton } from '../../components/ui';

const KEY = ['oa', 'attendance-daily'] as const;

/** 打卡时间：不是业务日期那天的写上日期（跨天班的下班卡、前一晚的上班卡） */
const stamp = (t: { date: string; time: string } | null, date: string) => (t ? `${t.date === date ? '' : `${t.date.slice(5)} `}${t.time}` : '—');

export function AttendanceResultsTab() {
  const qc = useQueryClient();
  const toast = useToast();
  const session = useSession();
  const [date, setDate] = useState<string | null>(null);
  const [groupId, setGroupId] = useState<number | null>(null);
  const [onlyAbnormal, setOnlyAbnormal] = useState(false);
  const [busy, setBusy] = useState(false);
  const q = useQuery({
    queryKey: [...KEY, date, groupId, onlyAbnormal],
    queryFn: () => api.get<AttendanceDay>(`/api/oa/attendance/daily?${date ? `date=${date}` : ''}${groupId ? `&groupId=${groupId}` : ''}${onlyAbnormal ? '&abnormal=1' : ''}`),
  });
  const d = q.data;
  const refresh = () => void qc.invalidateQueries({ queryKey: KEY });

  const settle = async () => {
    if (!d) return;
    setBusy(true);
    try {
      const r = await api.post<{ settled: number }>('/api/oa/attendance/daily/settle', { date: d.date, storeId: session.store.id });
      toast({ tone: 'success', title: `已重新结算 ${r.settled} 条` });
    } catch (e) {
      toast({ tone: e instanceof UncertainError ? 'info' : 'error', title: errorMessage(e), body: e instanceof UncertainError ? '重新结算可以放心再点一次' : undefined });
    } finally {
      setBusy(false);
      refresh();
    }
  };
  const setOutwork = async (row: AttendanceDailyRow, counted: boolean) => {
    setBusy(true);
    try {
      await api.post(`/api/oa/attendance/daily/${row.id}/outwork`, { counted, expected: row.outworkCounted });
      toast({ tone: 'success', title: `${row.staffName}的外勤${counted ? '算出勤' : '不算出勤'}` });
    } catch (e) {
      toast({ tone: e instanceof UncertainError ? 'info' : 'error', title: errorMessage(e), body: e instanceof UncertainError ? '已重新载入，请核对' : undefined });
    } finally {
      setBusy(false);
      refresh();
    }
  };

  return (
    <Card className="p-5" data-testid="att-results">
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Input
          type="date"
          value={date ?? d?.date ?? ''}
          onChange={(e) => e.target.value && setDate(e.target.value)}
          fullWidth={false}
          className="w-44"
          aria-label="业务日期"
          data-testid="att-results-date"
        />
        {d && d.groups.length > 0 && (
          <Select value={groupId ?? ''} onChange={(e) => setGroupId(e.target.value ? Number(e.target.value) : null)} fullWidth={false} className="w-44" aria-label="考勤组">
            <option value="">全部考勤组</option>
            {d.groups.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
          </Select>
        )}
        <ConfirmCheck checked={onlyAbnormal} onChange={setOnlyAbnormal}>
          只看异常
        </ConfirmCheck>
        {d?.editable && (
          <Button variant="secondary" icon={<RefreshCw className="size-4" />} loading={busy} onClick={() => void settle()} className="ml-auto" data-testid="att-results-settle">
            重新结算这一天
          </Button>
        )}
      </div>
      <p className="mb-3 text-[12px] text-ink-3">下班窗口结束以后才结算（跨天班第二天才有）；后台每 10 分钟自动结算一次，补了打卡的会自己更正。</p>
      {q.isPending ? (
        <Skeleton className="h-48" />
      ) : q.isError && !d ? (
        <LoadFailed title="考勤结果没有取回来" onRetry={() => q.refetch()} retrying={q.isFetching} />
      ) : d!.rows.length === 0 ? (
        <EmptyState title={onlyAbnormal ? '这一天没有异常' : '这一天还没有结算的考勤'} />
      ) : (
        <DataTable<AttendanceDailyRow>
          testId="att-results-grid"
          rows={d!.rows}
          rowKey={(r) => r.id}
          columns={[
            { key: 'staff', header: '员工', className: 'whitespace-nowrap', cell: (r) => <span className="font-semibold text-ink">{r.staffName}</span> },
            {
              key: 'shift',
              header: '班次',
              className: 'whitespace-nowrap',
              cell: (r) => (
                <span>
                  {r.shiftName}
                  <span className="num ml-1 text-[12px] text-ink-3">
                    {clockText(r.startMinute)}–{clockText(r.endMinute)}
                  </span>
                </span>
              ),
            },
            { key: 'in', header: '上班卡', className: 'num whitespace-nowrap', cell: (r) => stamp(r.inAt, r.businessDate) },
            { key: 'out', header: '下班卡', className: 'num whitespace-nowrap', cell: (r) => stamp(r.outAt, r.businessDate) },
            {
              key: 'status',
              header: '结果',
              cellTestId: (r) => `att-result-${r.staffId}`,
              cell: (r) => (
                <span className="flex flex-wrap items-center gap-1">
                  <AttendanceStatus row={r} />
                  {r.facePending && <Badge tone="yuzu">人脸待人工核对</Badge>}
                </span>
              ),
            },
            {
              key: 'outwork',
              header: '外勤',
              className: 'whitespace-nowrap',
              cell: (r) =>
                !r.outwork ? (
                  <span className="text-ink-4">—</span>
                ) : (
                  <span className="flex items-center gap-2">
                    <Badge tone={r.outworkCounted ? 'lake' : 'clay'}>{r.outworkCounted ? '算出勤' : '不算出勤'}</Badge>
                    {d!.editable && (
                      <Button size="sm" variant="ghost" disabled={busy} onClick={() => void setOutwork(r, !r.outworkCounted)} data-testid={`att-outwork-${r.staffId}`}>
                        改成{r.outworkCounted ? '不算' : '算'}
                      </Button>
                    )}
                  </span>
                ),
            },
          ]}
        />
      )}
    </Card>
  );
}
