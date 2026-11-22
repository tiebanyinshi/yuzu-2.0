// OA-06 后台「考勤设置 → 打卡记录」（docs/OA.md 第 9 节）：某个业务日期的打卡明细（跨天班的下班卡记在上班那天），可按考勤组筛。
// 每行：员工、打卡时间、算哪一班的上 / 下班卡（有效卡标出来：上班第一次、下班最后一次）、迟到 / 早退、打卡点与距离或外勤事由与照片、告警。
// 部门负责人（hr.attendanceDept）只看本部门。每日结算与异常在 OA-08。

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { FACE_RESULT_LABELS, PUNCH_KIND_LABELS, type PunchDay, type PunchRecord } from '@shared/oa';
import { api } from '../../lib/api';
import { DataTable } from '../../components/DataTable';
import { EmptyState } from '../../components/EmptyState';
import { LoadFailed } from '../../components/LoadFailed';
import { Badge, Card, Input, Select, Skeleton } from '../../components/ui';

export function PunchRecordsTab() {
  const [date, setDate] = useState<string | null>(null);
  const [groupId, setGroupId] = useState<number | null>(null);
  const q = useQuery({
    queryKey: ['oa', 'punch-records', date, groupId],
    queryFn: () => api.get<PunchDay>(`/api/oa/attendance/punches?${date ? `date=${date}` : ''}${groupId ? `&groupId=${groupId}` : ''}`),
  });
  const d = q.data;
  return (
    <Card className="p-5" data-testid="att-punches">
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Input
          type="date"
          value={date ?? d?.date ?? ''}
          onChange={(e) => e.target.value && setDate(e.target.value)}
          fullWidth={false}
          className="w-44"
          aria-label="业务日期"
          data-testid="att-punches-date"
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
        <p className="text-[12px] text-ink-3">按业务日期：跨天班的下班卡算在上班那天。</p>
      </div>
      {q.isPending ? (
        <Skeleton className="h-48" />
      ) : q.isError && !d ? (
        <LoadFailed title="打卡记录没有取回来" onRetry={() => q.refetch()} retrying={q.isFetching} />
      ) : d!.records.length === 0 ? (
        <EmptyState title="这一天没有打卡记录" />
      ) : (
        <DataTable<PunchRecord>
          testId="att-punches-grid"
          rows={d!.records}
          rowKey={(r) => r.id}
          columns={[
            { key: 'staff', header: '员工', className: 'whitespace-nowrap', cell: (r) => <span className="font-semibold text-ink">{r.staffName}</span> },
            {
              key: 'time',
              header: '打卡时间',
              className: 'whitespace-nowrap',
              cell: (r) => (
                <span className="num">
                  {r.localDate === d!.date ? '' : `${r.localDate.slice(5)} `}
                  {r.localTime}
                </span>
              ),
            },
            {
              key: 'kind',
              header: '算作',
              className: 'whitespace-nowrap',
              cell: (r) => (
                <span className="flex flex-wrap items-center gap-1">
                  <Badge tone={r.kind === 'in' || r.kind === 'out' ? (r.effective ? 'lake' : 'neutral') : 'neutral'}>{PUNCH_KIND_LABELS[r.kind]}</Badge>
                  {(r.kind === 'in' || r.kind === 'out') && !r.effective && <span className="text-[12px] text-ink-4">（非有效卡）</span>}
                  {r.shiftName && <span className="text-ink-2">{r.shiftName}</span>}
                </span>
              ),
              cellTestId: (r) => `att-punch-kind-${r.id}`,
            },
            {
              key: 'late',
              header: '迟到 / 早退',
              className: 'whitespace-nowrap',
              cell: (r) =>
                r.lateMinutes ? (
                  <span className="text-ember">迟到 {r.lateMinutes} 分</span>
                ) : r.earlyMinutes ? (
                  <span className="text-ember">早退 {r.earlyMinutes} 分</span>
                ) : (
                  <span className="text-ink-4">—</span>
                ),
            },
            {
              key: 'where',
              header: '位置',
              cell: (r) =>
                r.outwork ? (
                  <span>
                    <Badge tone="yuzu">外勤</Badge> <span className="text-ink-2">{r.outworkReason}</span>
                    {r.photo && (
                      <a href={r.photo.url} target="_blank" rel="noreferrer" className="ml-2 text-lake underline">
                        照片
                      </a>
                    )}
                  </span>
                ) : r.locationName && r.distanceM !== null ? (
                  <span className={r.locationOk ? 'text-ink-2' : 'text-clay'}>
                    「{r.locationName}」{r.distanceM} 米{r.accuracyM !== null ? `（精度 ${r.accuracyM} 米）` : ''}
                  </span>
                ) : (
                  <span className="text-ink-4">没带定位</span>
                ),
            },
            {
              key: 'flags',
              header: '人脸 / 告警',
              className: 'whitespace-nowrap',
              cell: (r) =>
                r.sharedLocation || r.faceResult ? (
                  <span className="flex flex-wrap items-center gap-1">
                    {r.faceResult && <Badge tone={r.faceResult === 'pass' ? 'pine' : 'yuzu'}>{FACE_RESULT_LABELS[r.faceResult]}</Badge>}
                    {r.facePhoto && (
                      <a href={r.facePhoto.url} target="_blank" rel="noreferrer" className="text-[12px] text-lake underline">
                        自拍
                      </a>
                    )}
                    {r.sharedLocation && <Badge tone="clay">同坐标多人</Badge>}
                  </span>
                ) : (
                  <span className="text-ink-4">—</span>
                ),
            },
            {
              key: 'device',
              header: '设备 / IP',
              className: 'max-w-56',
              cell: (r) => (
                <span className="block truncate text-[12px] text-ink-3" title={r.deviceInfo}>
                  {r.ip}
                  {r.deviceInfo ? ` · ${r.deviceInfo}` : ''}
                </span>
              ),
            },
          ]}
        />
      )}
    </Card>
  );
}
