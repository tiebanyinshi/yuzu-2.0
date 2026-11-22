// OA-09 后台「考勤设置 → 考勤月报」（docs/OA.md 第 12 节）：按员工汇总一个月的结算结果。
// 人事看本店全员、可按部门筛；部门负责人只看本部门。导出 Excel（服务端生成，记审计）。加班与请假明细随 OA-13。

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Download } from 'lucide-react';
import { MONTH_STAT_COLUMNS, type AttendanceMonth, type AttendanceMonthRow } from '@shared/oa';
import { api } from '../../lib/api';
import { downloadUrl } from '../../lib/utils';
import { DataTable, type DataColumn } from '../../components/DataTable';
import { EmptyState } from '../../components/EmptyState';
import { LoadFailed } from '../../components/LoadFailed';
import { Button, Card, Input, Select, Skeleton } from '../../components/ui';

export function AttendanceMonthlyTab() {
  const [month, setMonth] = useState<string | null>(null);
  const [dept, setDept] = useState('');
  const query = `${month ? `month=${month}` : ''}${dept ? `&dept=${dept}` : ''}`;
  const q = useQuery({ queryKey: ['oa', 'attendance-monthly', month, dept], queryFn: () => api.get<AttendanceMonth>(`/api/oa/attendance/monthly?${query}`) });
  const d = q.data;
  const columns: DataColumn<AttendanceMonthRow>[] = [
    { key: 'name', header: '员工', className: 'whitespace-nowrap', cell: (r) => <span className="font-semibold text-ink">{r.staffName}</span> },
    { key: 'dept', header: '部门', className: 'whitespace-nowrap max-md:hidden', cell: (r) => r.department },
    ...MONTH_STAT_COLUMNS.map(
      (c): DataColumn<AttendanceMonthRow> => ({
        key: c.key,
        header: c.label,
        align: 'right',
        className: 'num whitespace-nowrap',
        cellTestId: (r) => `att-month-${r.staffId}-${c.key}`,
        cell: (r) => (r[c.key] ? r[c.key] : <span className="text-ink-4">0</span>),
      }),
    ),
  ];
  return (
    <Card className="p-5" data-testid="att-monthly">
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Input
          type="month"
          value={month ?? d?.month ?? ''}
          onChange={(e) => e.target.value && setMonth(e.target.value)}
          fullWidth={false}
          className="w-44"
          aria-label="月份"
          data-testid="att-monthly-month"
        />
        {d && d.departments.length > 1 && (
          <Select value={dept} onChange={(e) => setDept(e.target.value)} fullWidth={false} className="w-44" aria-label="部门" data-testid="att-monthly-dept">
            <option value="">全部部门</option>
            {d.departments.map((x) => (
              <option key={x.key} value={x.key}>
                {x.name}
              </option>
            ))}
          </Select>
        )}
        {d && (
          <Button
            variant="secondary"
            icon={<Download className="size-4" />}
            className="ml-auto"
            onClick={() => downloadUrl(`/api/oa/attendance/monthly.xlsx?month=${d.month}${dept ? `&dept=${dept}` : ''}`)}
            data-testid="att-monthly-export"
          >
            导出 Excel
          </Button>
        )}
      </div>
      <p className="mb-3 text-[12px] text-ink-3">按每天的考勤结果汇总（下班以后才结算，本月的到今天为止）；外勤定为「不算出勤」的那一班不算实际出勤。加班时长与请假明细随审批上线后加。</p>
      {q.isPending ? (
        <Skeleton className="h-48" />
      ) : q.isError && !d ? (
        <LoadFailed title="考勤月报没有取回来" onRetry={() => q.refetch()} retrying={q.isFetching} />
      ) : d!.rows.length === 0 ? (
        <EmptyState title="这个月还没有结算的考勤" />
      ) : (
        <DataTable<AttendanceMonthRow> testId="att-monthly-grid" rows={d!.rows} rowKey={(r) => r.staffId} columns={columns} />
      )}
    </Card>
  );
}
