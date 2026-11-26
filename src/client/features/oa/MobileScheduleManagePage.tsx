// 员工办公 v1.1 第 2 批：手机端 / 双端排班管理页（/oa/schedule/manage，docs/OA_MOBILE.md 第 5 节）。
//   · 与 PC 端共用同一套排班与发布接口（/api/oa/attendance/schedule、/api/oa/attendance/schedule/publish）。
//   · 面向考勤管理员、部门经理与获授排班权限的主管：支持「按人」与「按天」两种手机单列卡片视图，360×800 不横向滚动。
//   · 保存草稿与发布排班均走 sendErpOp 幂等与「结果待确认」面板。

import { useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, Send, ShieldCheck } from 'lucide-react';
import { describeDate, shiftDate } from '@shared/labels';
import type { OaShift, ScheduleAccessSummary, SchedulePublishResult, ScheduleWeek } from '@shared/oa';
import { positionLabel } from '@shared/positions';
import { shiftTimeText } from '@shared/technician-admin';
import { api, ApiError, errorMessage, UncertainError } from '../../lib/api';
import { ErpPendingStoreError, sendErpOp, useErpRecorded } from '../../lib/erpPending';
import { useSession } from '../../lib/session';
import { cn, uuid } from '../../lib/utils';
import { PageHeader } from '../../components/AppShell';
import { EmptyState } from '../../components/EmptyState';
import { ErpPendingPanel } from '../../components/ErpPendingPanel';
import { LoadFailed } from '../../components/LoadFailed';
import { useToast } from '../../components/Toast';
import { Badge, Button, Card, Notice, Select, Skeleton } from '../../components/ui';
import {
  EMPTY_CELL,
  mondayOf,
  sameScheduleCell,
  scheduleCellKey,
  ScheduleCellDialog,
  SchedulePublishDialog,
  scheduleWeekUrl,
  submitScheduleDraft,
  type ScheduleDraftCell,
  type ScheduleDraftEdit,
} from './ScheduleDialogs';

function MobileCellCard({
  heading,
  cell,
  shiftById,
  changed,
  unpublished,
  locked,
  testId,
  onClick,
}: {
  heading: ReactNode;
  cell: ScheduleDraftCell;
  shiftById: ReadonlyMap<number, OaShift>;
  changed: boolean;
  unpublished: boolean;
  locked: boolean;
  testId: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={locked}
      onClick={onClick}
      data-testid={testId}
      className={cn(
        'tap relative flex w-full items-center justify-between gap-2 rounded-lg border px-3 py-2.5 text-left transition-colors',
        changed ? 'border-yuzu bg-yuzu-soft/50' : 'border-line bg-paper',
        !locked && 'active:bg-paper-2',
        locked && 'opacity-70',
      )}
    >
      <div className="min-w-0">
        {heading}
        {cell.shiftIds.length === 0 ? (
          <p className="mt-0.5 text-[12.5px] text-ink-3">休息</p>
        ) : (
          <div className="mt-1 flex flex-wrap gap-1.5">
            {cell.shiftIds.map((id) => {
              const sh = shiftById.get(id);
              return (
                <Badge key={id} tone={sh?.active === false ? 'clay' : 'lake'}>
                  {sh?.name ?? '?'} {sh ? shiftTimeText(sh) : ''}
                </Badge>
              );
            })}
            {cell.consecutive && <Badge tone="ember">连班</Badge>}
          </div>
        )}
      </div>
      <div className="flex shrink-0 flex-col items-end gap-1">
        {changed ? <Badge tone="ember">未保存</Badge> : unpublished ? <Badge tone="ember">待发布</Badge> : null}
        {!locked && <span className="text-[12px] text-pine">编辑</span>}
      </div>
    </button>
  );
}

export function MobileScheduleManagePage() {
  const qc = useQueryClient();
  const toast = useToast();
  const session = useSession();
  const [groupId, setGroupId] = useState<number | null>(null);
  const [monday, setMonday] = useState<string | null>(null);
  const [mode, setMode] = useState<'person' | 'day'>('person');
  const [selectedStaffId, setSelectedStaffId] = useState<number | null>(null);
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  const [draft, setDraft] = useState<Map<string, ScheduleDraftEdit>>(new Map());
  const [editing, setEditing] = useState<{ staffId: number; date: string; cell: ScheduleDraftCell; expected: ScheduleDraftCell } | null>(null);
  const [saving, setSaving] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [publishOpen, setPublishOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const mine = (op: { staffId?: number }) => !op.staffId || op.staffId === session.staff.id;
  const pendingSave = useErpRecorded(['oa_schedule_save']).filter(mine);
  const pendingPublish = useErpRecorded(['oa_schedule_publish']).filter(mine);

  const q = useQuery({ queryKey: ['oa', 'schedule', groupId, monday], queryFn: () => api.get<ScheduleWeek>(scheduleWeekUrl(groupId, monday)) });
  const access = useQuery({ queryKey: ['oa', 'schedule-access'], queryFn: () => api.get<ScheduleAccessSummary>('/api/oa/attendance/schedule-access') });
  const w = q.data;

  const from = monday ?? (w ? mondayOf(w.today) : null);
  if (w && monday === null) setMonday(mondayOf(w.today));
  if (w?.group && groupId === null) setGroupId(w.group.id);

  const dates = useMemo(() => (from ? Array.from({ length: 7 }, (_, i) => shiftDate(from, i)) : []), [from]);
  const activeStaffId = selectedStaffId && w?.members.some((m) => m.staffId === selectedStaffId) ? selectedStaffId : (w?.members[0]?.staffId ?? null);
  const activeDay = selectedDay && dates.includes(selectedDay) ? selectedDay : w && dates.includes(w.today) ? w.today : (dates[0] ?? null);

  const original = useMemo(() => new Map((w?.cells ?? []).map((c) => [scheduleCellKey(c.staffId, c.date), c])), [w]);
  const cellOf = (staffId: number, date: string): ScheduleDraftCell => {
    const d = draft.get(scheduleCellKey(staffId, date))?.cell;
    if (d) return d;
    const o = original.get(scheduleCellKey(staffId, date));
    return o ? { shiftIds: o.shiftIds, consecutive: o.consecutive } : EMPTY_CELL;
  };
  const shiftById = new Map((w?.shifts ?? []).map((s) => [s.id, s]));
  const dirty = [...draft.entries()].filter(([, v]) => !sameScheduleCell(v.cell, v.expected));
  const busy = saving || publishing;

  const reset = () => {
    setDraft(new Map());
    setError(null);
  };
  const reload = () => {
    reset();
    void qc.invalidateQueries({ queryKey: ['oa', 'schedule'] });
  };
  const go = (next: string) => {
    if (busy) return;
    if (dirty.length && !window.confirm('这一周改了还没保存的格子会丢掉，确定翻周吗？')) return;
    reset();
    setMonday(next);
  };
  const pickGroup = (id: number) => {
    if (busy) return;
    if (dirty.length && !window.confirm('改了还没保存的格子会丢掉，确定换考勤组吗？')) return;
    reset();
    setGroupId(id);
  };

  const save = async () => {
    if (!w?.group || !from || !dirty.length) return;
    if (pendingSave.length) {
      setError('上一次保存结果待确认：请先在页面上方查回、重提或作废');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const { changed } = await submitScheduleDraft({
        dirty,
        storeId: session.store.id,
        groupId: w.group.id,
        groupName: w.group.name,
        from,
        staffId: session.staff.id,
        staffName: session.staff.displayName,
      });
      toast({ tone: 'success', title: `排班草稿已保存（${changed} 格）`, body: '点「发布排班」后生效并通知员工' });
      reload();
    } catch (e) {
      if (e instanceof UncertainError) {
        toast({ tone: 'info', title: '保存结果待确认', body: '已记在本机：请在页面上方查回、重提或作废。' });
        reload();
      } else if (e instanceof ApiError && e.code === 'SCHEDULE_CHANGED') {
        toast({ tone: 'info', title: errorMessage(e), body: '已载入最新的排班，请重新排' });
        reload();
      } else if (e instanceof ErpPendingStoreError) setError(e.message);
      else setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  const publish = async () => {
    if (!w?.group || !from) return;
    if (pendingPublish.length) {
      setError('上一次发布结果待确认：请先在页面上方查回、重提或作废');
      setPublishOpen(false);
      return;
    }
    setPublishing(true);
    setError(null);
    const to = shiftDate(from, 6);
    const key = uuid();
    try {
      const r = await sendErpOp<SchedulePublishResult>({
        key,
        type: 'oa_schedule_publish',
        url: '/api/oa/attendance/schedule/publish',
        body: { clientKey: key, storeId: session.store.id, groupId: w.group.id, from, to },
        summary: `发布排班 · ${w.group.name}（${from} 至 ${to}）`,
        staffName: session.staff.displayName,
        staffId: session.staff.id,
      });
      setPublishOpen(false);
      toast({
        tone: 'success',
        title: r.cellCount > 0 ? `排班已发布（${r.staffCount} 人 · ${r.cellCount} 格）` : '这段日期没有待发布的改动',
        body: r.cellCount > 0 ? '已向排班有变动的员工发送站内通知' : undefined,
      });
      reload();
    } catch (e) {
      setPublishOpen(false);
      if (e instanceof UncertainError) {
        toast({ tone: 'info', title: '发布结果待确认', body: '已记在本机：请在页面上方查回、重提或作废。' });
        reload();
      } else if (e instanceof ErpPendingStoreError) setError(e.message);
      else setError(errorMessage(e));
    } finally {
      setPublishing(false);
    }
  };

  const openEditor = (staffId: number, date: string, editable: boolean) => {
    if (!w || !editable || date < w.today || busy) return;
    const k = scheduleCellKey(staffId, date);
    const o = original.get(k);
    const base = o ? { shiftIds: o.shiftIds, consecutive: o.consecutive } : EMPTY_CELL;
    setEditing({ staffId, date, cell: cellOf(staffId, date), expected: draft.get(k)?.expected ?? base });
  };

  const activeMember = w?.members.find((m) => m.staffId === activeStaffId) ?? null;
  const editingCell = editing?.cell ?? EMPTY_CELL;
  const effectiveFrom = from && w ? (from < w.today ? w.today : from) : (from ?? '');

  return (
    <>
      <div className="max-md:hidden">
        <PageHeader dateMode="calendar" title="排班管理" subtitle="按人或按天编辑排班草稿，确认后发布并通知员工" />
      </div>
      <div className="mx-auto w-full max-w-3xl space-y-3 p-3 md:p-7" data-testid="mobile-schedule-manage">
        <ErpPendingPanel types={['oa_schedule_save', 'oa_schedule_publish']} filter={mine} className="space-y-2" onFound={() => reload()} />
        {q.isPending ? (
          <Skeleton className="h-72" />
        ) : q.isError && !w ? (
          <LoadFailed title="排班表没有取回来" onRetry={() => q.refetch()} retrying={q.isFetching} />
        ) : !w || !from ? null : !w.group ? (
          <EmptyState title="还没有可管理的考勤组" description="请先在考勤设置里把员工加入考勤组，或核对排班授权范围。" />
        ) : (
          <>
            <Card className="space-y-3 p-3.5">
              <div className="flex flex-wrap items-center gap-2">
                {w.groups.length > 0 && (
                  <Select
                    value={w.group.id}
                    onChange={(e) => pickGroup(Number(e.target.value))}
                    disabled={busy}
                    fullWidth={false}
                    className="min-w-0 flex-1"
                    aria-label="考勤组"
                    data-testid="mobile-sch-group"
                  >
                    {w.groups.map((g) => (
                      <option key={g.id} value={g.id}>
                        {g.name}
                      </option>
                    ))}
                  </Select>
                )}
                <div className="flex rounded-md border border-line bg-paper p-0.5 text-[12.5px]">
                  <button
                    type="button"
                    onClick={() => setMode('person')}
                    data-testid="mobile-sch-mode-person"
                    className={cn('tap relative rounded px-2.5 py-1 font-semibold', mode === 'person' ? 'bg-pine text-white' : 'text-ink-2')}
                  >
                    按人
                  </button>
                  <button
                    type="button"
                    onClick={() => setMode('day')}
                    data-testid="mobile-sch-mode-day"
                    className={cn('tap relative rounded px-2.5 py-1 font-semibold', mode === 'day' ? 'bg-pine text-white' : 'text-ink-2')}
                  >
                    按天
                  </button>
                </div>
                {access.data?.canGrant && (
                  <Link
                    to="/oa/schedule/grants"
                    data-testid="mobile-sch-grants-link"
                    className="tap relative inline-flex h-8 items-center gap-1 rounded-md border border-pine/40 bg-pine-tint px-2.5 text-[12.5px] font-semibold text-pine"
                  >
                    <ShieldCheck className="size-3.5" />
                    排班授权
                  </Link>
                )}
              </div>

              <div className="flex items-center justify-between gap-1">
                <Button size="sm" variant="ghost" icon={<ChevronLeft className="size-4" />} disabled={busy} onClick={() => go(shiftDate(from, -7))} aria-label="上一周" />
                <span className="num text-[13px] font-semibold text-ink" data-testid="mobile-sch-range">
                  {from} – {shiftDate(from, 6)}
                </span>
                <div className="flex items-center gap-0.5">
                  <Button size="sm" variant="ghost" disabled={busy} onClick={() => go(mondayOf(w.today))}>
                    本周
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    icon={<ChevronRight className="size-4" />}
                    disabled={busy}
                    onClick={() => go(shiftDate(from, 7))}
                    aria-label="下一周"
                    data-testid="mobile-sch-next"
                  />
                </div>
              </div>

              {!w.editable && <p className="rounded-md bg-paper-2 px-3 py-2 text-[12.5px] text-ink-3">当前为只读权限，不能修改或发布排班。</p>}

              {(w.editable || w.publishable) && (
                <div className="flex flex-wrap items-center gap-2 border-t border-line pt-2.5">
                  <span className="text-[12.5px] text-ink-3" data-testid="mobile-sch-status">
                    {dirty.length > 0 ? `未保存 ${dirty.length} 格` : w.unpublishedCount > 0 ? `待发布 ${w.unpublishedCount} 格` : '本周排班已发布'}
                  </span>
                  <div className="ml-auto flex flex-wrap gap-2">
                    {dirty.length > 0 && (
                      <Button size="sm" variant="ghost" disabled={busy} onClick={reset}>
                        放弃
                      </Button>
                    )}
                    {w.editable && (
                      <Button size="sm" variant="secondary" loading={saving} disabled={!dirty.length || publishing} onClick={() => void save()} data-testid="mobile-sch-save">
                        保存草稿{dirty.length ? `（${dirty.length}）` : ''}
                      </Button>
                    )}
                    {w.publishable && (
                      <Button
                        size="sm"
                        variant="primary"
                        icon={<Send className="size-3.5" />}
                        loading={publishing}
                        disabled={busy || dirty.length > 0 || w.unpublishedCount === 0}
                        onClick={() => setPublishOpen(true)}
                        data-testid="mobile-sch-publish"
                      >
                        发布排班{w.unpublishedCount > 0 ? `（${w.unpublishedCount}）` : ''}
                      </Button>
                    )}
                  </div>
                </div>
              )}
            </Card>

            {error && (
              <Notice tone="error" title="操作未完成">
                <span data-testid="mobile-sch-error">{error}</span>
              </Notice>
            )}

            {w.members.length === 0 ? (
              <EmptyState title="这个考勤组里还没有可管理的员工" />
            ) : mode === 'person' ? (
              <Card className="space-y-3 p-3.5">
                <Select value={activeStaffId ?? ''} onChange={(e) => setSelectedStaffId(Number(e.target.value))} aria-label="选择员工" data-testid="mobile-sch-staff-select">
                  {w.members.map((m) => (
                    <option key={m.staffId} value={m.staffId}>
                      {m.name}（{positionLabel(m.position)}）{!m.editable ? ' [只读]' : ''}
                    </option>
                  ))}
                </Select>
                {activeMember && (
                  <div className="space-y-2">
                    {dates.map((d) => {
                      const k = scheduleCellKey(activeMember.staffId, d);
                      const e = draft.get(k);
                      return (
                        <MobileCellCard
                          key={d}
                          heading={
                            <p className={cn('text-[13.5px] font-bold', d === w.today ? 'text-pine' : 'text-ink')}>
                              {describeDate(d).weekday} <span className="num font-normal text-ink-3">{d.slice(5)}</span>
                            </p>
                          }
                          cell={cellOf(activeMember.staffId, d)}
                          shiftById={shiftById}
                          changed={!!e && !sameScheduleCell(e.cell, e.expected)}
                          unpublished={!!original.get(k)?.unpublished}
                          locked={!activeMember.editable || d < w.today || busy}
                          testId={`mobile-cell-${activeMember.staffId}-${d}`}
                          onClick={() => openEditor(activeMember.staffId, d, activeMember.editable)}
                        />
                      );
                    })}
                  </div>
                )}
              </Card>
            ) : (
              <Card className="space-y-3 p-3.5">
                <div className="grid grid-cols-7 gap-1">
                  {dates.map((d) => {
                    const sel = d === activeDay;
                    return (
                      <button
                        key={d}
                        type="button"
                        onClick={() => setSelectedDay(d)}
                        data-testid={`mobile-sch-day-${d}`}
                        className={cn(
                          'tap relative flex flex-col items-center rounded-md border py-1.5 text-[12px]',
                          sel ? 'border-pine bg-pine text-white' : d === w.today ? 'border-pine/50 bg-pine-tint text-pine' : 'border-line bg-paper text-ink-2',
                        )}
                      >
                        <span>{describeDate(d).weekday.replace('周', '')}</span>
                        <span className="num font-bold">{Number(d.slice(8))}</span>
                      </button>
                    );
                  })}
                </div>
                {activeDay && (
                  <div className="space-y-2">
                    {w.members.map((m) => {
                      const k = scheduleCellKey(m.staffId, activeDay);
                      const e = draft.get(k);
                      return (
                        <MobileCellCard
                          key={m.staffId}
                          heading={
                            <p className="text-[13.5px] font-bold text-ink">
                              {m.name} <span className="text-[12px] font-normal text-ink-3">{positionLabel(m.position)}</span>
                            </p>
                          }
                          cell={cellOf(m.staffId, activeDay)}
                          shiftById={shiftById}
                          changed={!!e && !sameScheduleCell(e.cell, e.expected)}
                          unpublished={!!original.get(k)?.unpublished}
                          locked={!m.editable || activeDay < w.today || busy}
                          testId={`mobile-day-cell-${m.staffId}-${activeDay}`}
                          onClick={() => openEditor(m.staffId, activeDay, m.editable)}
                        />
                      );
                    })}
                  </div>
                )}
              </Card>
            )}

            {w.recentPublishes.length > 0 && (
              <p className="px-1 text-[12px] text-ink-3" data-testid="mobile-sch-last-publish">
                最近发布：{w.recentPublishes[0]!.publishedByName} 发布 {w.recentPublishes[0]!.fromDate} 至 {w.recentPublishes[0]!.toDate}（{w.recentPublishes[0]!.staffCount} 人 ·{' '}
                {w.recentPublishes[0]!.cellCount} 格）
              </p>
            )}
          </>
        )}
      </div>

      <ScheduleCellDialog
        target={editing}
        cell={editingCell}
        shifts={(w?.shifts ?? []).filter((s) => s.active || editingCell.shiftIds.includes(s.id))}
        name={w?.members.find((m) => m.staffId === editing?.staffId)?.name ?? ''}
        onClose={() => setEditing(null)}
        onDone={(cell) => {
          if (!editing) return;
          const k = scheduleCellKey(editing.staffId, editing.date);
          setDraft((d) => new Map(d).set(k, { cell, expected: d.get(k)?.expected ?? editing.expected }));
          setEditing(null);
        }}
      />
      <SchedulePublishDialog
        open={publishOpen}
        groupName={w?.group?.name ?? ''}
        from={effectiveFrom}
        to={from ? shiftDate(from, 6) : ''}
        unpublishedCount={w?.unpublishedCount ?? 0}
        loading={publishing}
        onClose={() => setPublishOpen(false)}
        onConfirm={() => void publish()}
      />
    </>
  );
}
