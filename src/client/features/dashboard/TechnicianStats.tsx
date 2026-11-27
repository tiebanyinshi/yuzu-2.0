// 技师统计（8.2.2，docs/V8222_TECHNICIANS.md 第 7 节）：选一个月，看每天的扩钟数（按技师、按天）、每 10 天一段的总业绩（按工种小计）、
// 每月业绩任务的完成度；有「维护技师名册」的可以在这里设当月的任务（按技师或按组）。

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2 } from 'lucide-react';
import { formatYuan, parseYuan } from '@shared/money';
import type { CallStats, PeriodStats, TargetView } from '@shared/technician-stats';
import type { TechnicianAdminView } from '@shared/technician-admin';
import { api, errorMessage } from '../../lib/api';
import { useCan, useSession } from '../../lib/session';
import { useReportScope } from '../../lib/reportScope';
import { Money } from '../../components/Money';
import { DataTable } from '../../components/DataTable';
import { useToast } from '../../components/Toast';
import { Button, Card, Field, Input, Notice, SectionTitle, Select, Skeleton } from '../../components/ui';

const monthEnd = (month: string) => {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return `${month}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`;
};

export function TechnicianStats() {
  const session = useSession();
  const scope = useReportScope();
  const can = useCan();
  const [month, setMonth] = useState(session.today.slice(0, 7));
  const to = monthEnd(month) < session.today ? monthEnd(month) : session.today;
  const from = `${month}-01`;
  const calls = useQuery({
    queryKey: ['reports', 'technicians', 'calls', from, to, scope.merged],
    queryFn: () => api.get<CallStats>(`/api/reports/technicians/calls?from=${from}&to=${to}${scope.q}`),
    enabled: from <= to,
  });
  const periods = useQuery({
    queryKey: ['reports', 'technicians', 'periods', month, scope.merged],
    queryFn: () => api.get<PeriodStats>(`/api/reports/technicians/periods?month=${month}${scope.q}`),
  });
  const targets = useQuery({ queryKey: ['reports', 'technicians', 'targets', month], queryFn: () => api.get<TargetView>(`/api/reports/technicians/targets?month=${month}`) });
  return (
    <div className="space-y-4" data-testid="technician-stats">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-[15px] font-bold">扩钟、十天业绩与每月任务</h2>
        <Input type="month" value={month} max={session.today.slice(0, 7)} onChange={(e) => e.target.value && setMonth(e.target.value)} fullWidth={false} className="h-9 w-40" aria-label="哪个月" />
      </div>
      <Card className="overflow-hidden">
        <div className="p-4 pb-2">
          <SectionTitle>每天的扩钟数</SectionTitle>
          <p className="text-[12px] text-ink-3">按挂账算（没作废的扩钟，不含加钟），客人还没结账的也算</p>
        </div>
        {from > to ? (
          <p className="px-4 pb-4 text-[13px] text-ink-3">这个月还没开始</p>
        ) : !calls.data ? (
          calls.error ? (
            <Notice tone="error" title={calls.error.message} className="m-4" />
          ) : (
            <Skeleton className="m-4 h-24" />
          )
        ) : calls.data.rows.length === 0 ? (
          <p className="px-4 pb-4 text-[13px] text-ink-3">这个月还没有扩钟</p>
        ) : (
          <DataTable
            variant="plain"
            testId="technician-calls"
            rows={[...calls.data.rows, { technicianId: 0, techNo: '', name: '全店', days: calls.data.totals, total: calls.data.total }]}
            rowKey={(r) => r.technicianId}
            columns={[
              {
                key: 'tech',
                header: '技师',
                className: 'whitespace-nowrap',
                cell: (r) =>
                  r.technicianId === 0 ? (
                    <span className="font-bold">全店</span>
                  ) : (
                    <>
                      <span className="num font-bold">{r.techNo}</span> {r.name}
                    </>
                  ),
              },
              { key: 'total', header: '合计', numeric: true, cell: (r) => <span className="font-bold">{r.total}</span> },
              ...calls.data.dates.map((d) => ({ key: d, header: String(Number(d.slice(8))), numeric: true, cell: (r: CallStats['rows'][number]) => r.days[d] || '' })),
            ]}
          />
        )}
      </Card>

      <Card className="p-4">
        <SectionTitle>每 10 天的业绩（按工种小计）</SectionTitle>
        <p className="text-[12px] text-ink-3">按结账算，与上面的技师业绩同一个口径；工种是技师档案里的「类型」</p>
        {!periods.data ? (
          <Skeleton className="mt-3 h-24" />
        ) : (
          <div className="mt-3 grid grid-cols-1 gap-3 lg:grid-cols-3" data-testid="technician-periods">
            {periods.data.segments.map((seg) => (
              <div key={seg.from} className="rounded-lg border border-line p-3">
                <p className="flex items-baseline justify-between font-bold">
                  {seg.label}
                  <span>
                    {seg.total.clocks} 钟 · <Money cents={seg.total.amount} />
                  </span>
                </p>
                {seg.kinds.length === 0 ? (
                  <p className="mt-2 text-[12.5px] text-ink-3">没有结账的技师钟</p>
                ) : (
                  <ul className="mt-2 space-y-2 text-[12.5px]">
                    {seg.kinds.map((k) => (
                      <li key={k.kind}>
                        <p className="flex justify-between font-semibold">
                          {k.kind || '未分工种'}
                          <span>
                            {k.clocks} 钟 · <Money cents={k.amount} />
                          </span>
                        </p>
                        <p className="text-ink-3">{k.rows.map((r) => `${r.techNo} 号 ${r.name} ${formatYuan(r.amount)}`).join('，')}</p>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            ))}
          </div>
        )}
      </Card>

      <TargetsCard month={month} view={targets.data ?? null} editable={can('technician.manage')} />
    </div>
  );
}

type Draft = { key: number; who: string; amount: string; clocks: string };
let nextKey = 1;

function TargetsCard({ month, view, editable }: { month: string; view: TargetView | null; editable: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [editing, setEditing] = useState<Draft[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const roster = useQuery({ queryKey: ['technician-admin', 'view'], queryFn: () => api.get<TechnicianAdminView>('/api/technician-admin'), enabled: editing !== null });
  const start = () => {
    setError(null);
    setEditing(
      (view?.targets ?? []).map((t) => ({
        key: nextKey++,
        who: t.technicianId !== null ? `t${t.technicianId}` : `g${t.groupId}`,
        amount: String(t.amount / 100),
        clocks: t.clocks === null ? '' : String(t.clocks),
      })),
    );
  };
  const built = (() => {
    if (!editing) return null;
    const out = [];
    for (const d of editing) {
      if (!d.who) return '每一行要选技师或组';
      const cents = parseYuan(d.amount);
      if (cents === null) return '目标金额要写数字（元）';
      if (d.clocks.trim() && !/^\d+$/.test(d.clocks.trim())) return '目标钟数写整数';
      out.push({
        technicianId: d.who.startsWith('t') ? Number(d.who.slice(1)) : null,
        groupId: d.who.startsWith('g') ? Number(d.who.slice(1)) : null,
        amount: cents,
        clocks: d.clocks.trim() ? Number(d.clocks) : null,
      });
    }
    return out;
  })();
  const save = async () => {
    if (!Array.isArray(built)) return;
    setBusy(true);
    setError(null);
    try {
      const next = await api.put<TargetView>('/api/admin/technician-targets', { month, targets: built });
      qc.setQueryData(['reports', 'technicians', 'targets', month], next);
      setEditing(null);
      toast({ tone: 'success', title: `已设 ${month} 的业绩任务` });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card className="p-4" data-testid="technician-targets">
      <SectionTitle
        aside={
          editable &&
          !editing && (
            <Button size="sm" variant="secondary" onClick={start} data-testid="technician-targets-edit">
              设任务
            </Button>
          )
        }
      >
        每月业绩任务
      </SectionTitle>
      {view && <p className="text-[12px] text-ink-3">完成度按结账算到 {view.through}；按组设的算组里现在的成员</p>}
      {editing ? (
        <div className="mt-3 space-y-2">
          {editing.map((d, i) => (
            <div key={d.key} className="flex flex-wrap items-end gap-2">
              <Field label={i === 0 ? '技师或组' : ''}>
                <Select value={d.who} onChange={(e) => setEditing(editing.map((x) => (x.key === d.key ? { ...x, who: e.target.value } : x)))} fullWidth={false} className="w-48">
                  <option value="">选…</option>
                  {(roster.data?.groups ?? [])
                    .filter((g) => g.active)
                    .map((g) => (
                      <option key={`g${g.id}`} value={`g${g.id}`}>
                        {g.name}（组）
                      </option>
                    ))}
                  {(roster.data?.technicians ?? [])
                    .filter((t) => t.active)
                    .map((t) => (
                      <option key={`t${t.id}`} value={`t${t.id}`}>
                        {t.techNo} 号 {t.name}
                      </option>
                    ))}
                </Select>
              </Field>
              <Field label={i === 0 ? '目标金额（元）' : ''}>
                <Input
                  value={d.amount}
                  inputMode="decimal"
                  onChange={(e) => setEditing(editing.map((x) => (x.key === d.key ? { ...x, amount: e.target.value } : x)))}
                  fullWidth={false}
                  className="num w-32"
                />
              </Field>
              <Field label={i === 0 ? '目标钟数（选填）' : ''}>
                <Input
                  value={d.clocks}
                  inputMode="numeric"
                  onChange={(e) => setEditing(editing.map((x) => (x.key === d.key ? { ...x, clocks: e.target.value } : x)))}
                  fullWidth={false}
                  className="num w-24"
                />
              </Field>
              <Button size="sm" variant="ghost" icon={<Trash2 className="size-4" />} onClick={() => setEditing(editing.filter((x) => x.key !== d.key))}>
                删掉
              </Button>
            </div>
          ))}
          <div className="flex flex-wrap gap-2 pt-1">
            <Button size="sm" variant="secondary" icon={<Plus className="size-4" />} onClick={() => setEditing([...editing, { key: nextKey++, who: '', amount: '', clocks: '' }])}>
              加一行
            </Button>
            <span className="mr-auto" />
            {typeof built === 'string' && <span className="self-center text-[13px] text-clay">{built}</span>}
            <Button size="sm" variant="ghost" onClick={() => setEditing(null)} disabled={busy}>
              取消
            </Button>
            <Button size="sm" variant="primary" loading={busy} disabled={typeof built === 'string'} onClick={() => void save()} data-testid="technician-targets-save">
              保存
            </Button>
          </div>
          {error && <Notice tone="error" title={error} />}
        </div>
      ) : !view ? (
        <Skeleton className="mt-3 h-16" />
      ) : view.targets.length === 0 ? (
        <p className="mt-3 text-[13px] text-ink-3">这个月还没设任务</p>
      ) : (
        <ul className="mt-3 space-y-2 text-[13px]">
          {view.targets.map((t) => (
            <li key={`${t.technicianId}-${t.groupId}`}>
              <p className="flex flex-wrap justify-between gap-2">
                <span className="font-semibold">{t.label}</span>
                <span>
                  <Money cents={t.actualAmount} /> / <Money cents={t.amount} />
                  {t.clocks !== null && ` · ${t.actualClocks} / ${t.clocks} 钟`}
                  <span className="num ml-2 font-bold">{t.rate === null ? '—' : `${t.rate}%`}</span>
                </span>
              </p>
              <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-paper-2">
                <div className="h-full rounded-full bg-pine" style={{ width: `${Math.min(100, t.rate ?? 0)}%` }} />
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
