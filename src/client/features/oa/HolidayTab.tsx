// OA-13 后台「考勤设置 → 节假日」（docs/OA.md 第 16 节，OA15）：按年维护节假日与调休上班，整年一起保存（带版本）。
// 用在加班单的核对：表里是节假日的那天加班类型要选「节假日」，不是的不能选。不改排班、不改请假时长。
// 保存是整年覆盖：结果不确定（超时、断网）时重新载入核对，已经存上了就是新的版本，没存上就再点一次保存。

import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2 } from 'lucide-react';
import { HOLIDAY_KIND_LABELS, HOLIDAY_NAME_MAX, type HolidayDay, type HolidayKind, type HolidayYear } from '@shared/oa';
import { api, ApiError, errorMessage, UncertainError } from '../../lib/api';
import { EmptyState } from '../../components/EmptyState';
import { LoadFailed } from '../../components/LoadFailed';
import { useToast } from '../../components/Toast';
import { Button, Card, Input, Select, Skeleton } from '../../components/ui';

export function HolidayTab() {
  const qc = useQueryClient();
  const toast = useToast();
  const [year, setYear] = useState<number | null>(null);
  const q = useQuery({ queryKey: ['oa', 'holidays', year], queryFn: () => api.get<HolidayYear>(`/api/oa/attendance/holidays${year ? `?year=${year}` : ''}`) });
  const d = q.data;
  const [days, setDays] = useState<HolidayDay[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // 换了年份或重新载入：按服务端的重新填
  useEffect(() => {
    setDays(d ? d.days : null);
    setError('');
  }, [d]);
  const current = year ?? d?.year ?? null;
  const dirty = !!d && !!days && JSON.stringify(days) !== JSON.stringify(d.days);
  const edit = (i: number, patch: Partial<HolidayDay>) => setDays((xs) => xs!.map((x, j) => (j === i ? { ...x, ...patch } : x)));

  const save = async () => {
    if (!d || !days) return;
    setBusy(true);
    setError('');
    try {
      await api.put(`/api/oa/attendance/holidays/${d.year}`, { version: d.version, days });
      toast({ tone: 'success', title: `${d.year} 年节假日表已保存` });
      await qc.invalidateQueries({ queryKey: ['oa', 'holidays'] });
    } catch (e) {
      if (e instanceof UncertainError || (e instanceof ApiError && e.code === 'VERSION_CONFLICT')) {
        toast({ tone: 'info', title: errorMessage(e), body: '已重新载入，请核对是否已经存上；没有的再改一次' });
        await qc.invalidateQueries({ queryKey: ['oa', 'holidays'] });
      } else setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="p-5" data-testid="att-holidays">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Select value={current ?? ''} onChange={(e) => setYear(Number(e.target.value))} fullWidth={false} className="w-32" aria-label="年份" data-testid="att-holidays-year" disabled={!current}>
          {current &&
            [current - 1, current, current + 1].map((y) => (
              <option key={y} value={y}>
                {y} 年
              </option>
            ))}
        </Select>
        {d?.updatedAt && (
          <span className="text-[12px] text-ink-3">
            {d.updatedByName ?? ''} 最后保存于 {d.updatedAt.slice(0, 10)}
          </span>
        )}
        <span className="ml-auto flex gap-2">
          <Button
            variant="secondary"
            icon={<Plus className="size-4" />}
            disabled={!days}
            onClick={() => setDays((xs) => [...(xs ?? []), { day: `${current}-01-01`, kind: 'holiday', name: '' }])}
            data-testid="att-holidays-add"
          >
            加一天
          </Button>
          <Button onClick={() => void save()} disabled={!dirty || busy} loading={busy} data-testid="att-holidays-save">
            保存
          </Button>
        </span>
      </div>
      <p className="mb-3 text-[12px] text-ink-3">「节假日」那天的加班单要选「节假日」，不在表里的不能选「节假日」；「调休上班」只作记录。排班照旧在「排班」里排，请假时长照旧按排班算。</p>
      {error && (
        <p className="mb-3 text-[13px] text-clay" role="alert">
          {error}
        </p>
      )}
      {q.isPending ? (
        <Skeleton className="h-40" />
      ) : q.isError && !d ? (
        <LoadFailed title="节假日表没有取回来" onRetry={() => q.refetch()} retrying={q.isFetching} />
      ) : !days || days.length === 0 ? (
        <EmptyState title={`${current} 年还没有录节假日`} description="点「加一天」逐天录入，例如国庆节 10 月 1 日至 7 日、调休上班的周末。" />
      ) : (
        <ul className="divide-y divide-line" data-testid="att-holidays-list">
          {days.map((x, i) => (
            <li key={i} className="flex flex-wrap items-center gap-2 py-2" data-testid={`att-holiday-${i}`}>
              <Input type="date" value={x.day} onChange={(e) => edit(i, { day: e.target.value })} fullWidth={false} className="w-44" aria-label="日期" />
              <Select value={x.kind} onChange={(e) => edit(i, { kind: e.target.value as HolidayKind })} fullWidth={false} className="w-32" aria-label="类型">
                {(Object.keys(HOLIDAY_KIND_LABELS) as HolidayKind[]).map((k) => (
                  <option key={k} value={k}>
                    {HOLIDAY_KIND_LABELS[k]}
                  </option>
                ))}
              </Select>
              <Input value={x.name} onChange={(e) => edit(i, { name: e.target.value })} maxLength={HOLIDAY_NAME_MAX} placeholder="例如 国庆节" fullWidth={false} className="w-44" aria-label="名称" />
              <Button size="sm" variant="ghost" icon={<Trash2 className="size-4" />} aria-label="删掉这一天" onClick={() => setDays((xs) => xs!.filter((_, j) => j !== i))} />
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
