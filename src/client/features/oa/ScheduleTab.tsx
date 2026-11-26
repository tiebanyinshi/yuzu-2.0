// OA-05 + 员工办公 v1.1 第 2 批 后台「考勤设置 → 排班」（docs/OA.md 第 8 节；docs/OA_MOBILE.md 第 5 节，EO5）。
//   · 点一格选一个或几个班次（连班要勾「连班」），空着 = 休息；保存先存草稿（不发通知、不影响打卡与结算），点「发布排班」后才生效并通知员工。
//   · 考勤管理员、部门经理（本部门及下级）及获授权限的人员按服务端统一的授权范围查看、编排或发布。
//   · 保存与发布均走 sendErpOp 幂等与「结果待确认」面板。

import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarRange, ChevronLeft, ChevronRight, Copy, Send } from 'lucide-react';
import { describeDate, shiftDate } from '@shared/labels';
import type { SchedulePublishResult, ScheduleWeek } from '@shared/oa';
import { positionLabel } from '@shared/positions';
import { ApiError, api, errorMessage, UncertainError } from '../../lib/api';
import { ErpPendingStoreError, sendErpOp, useErpRecorded } from '../../lib/erpPending';
import { useCan, useSession } from '../../lib/session';
import { cn, uuid } from '../../lib/utils';
import { DataTable, type DataColumn } from '../../components/DataTable';
import { EmptyState } from '../../components/EmptyState';
import { LoadFailed } from '../../components/LoadFailed';
import { useToast } from '../../components/Toast';
import { Badge, Button, Card, Notice, Select, Skeleton } from '../../components/ui';
import { ScheduleBatchDialog } from './ScheduleBatchDialog';
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

type Member = ScheduleWeek['members'][number];

export function ScheduleTab() {
  const qc = useQueryClient();
  const toast = useToast();
  const can = useCan();
  const [groupId, setGroupId] = useState<number | null>(null);
  const [monday, setMonday] = useState<string | null>(null);
  const session = useSession();
  const mine = (op: { staffId?: number }) => can('hr.attendance') || !op.staffId || op.staffId === session.staff.id;
  // 记在本机的保存或发布（还在路上、结果待确认）：确认前不让重复提交
  const pendingSave = useErpRecorded(['oa_schedule_save']).filter(mine);
  const pendingPublish = useErpRecorded(['oa_schedule_publish']).filter(mine);
  const [draft, setDraft] = useState<Map<string, ScheduleDraftEdit>>(new Map());
  const [editing, setEditing] = useState<{ staffId: number; date: string; cell: ScheduleDraftCell; expected: ScheduleDraftCell } | null>(null);
  const [saving, setSaving] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [publishOpen, setPublishOpen] = useState(false);
  const [copying, setCopying] = useState(false);
  const [batching, setBatching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const key = ['oa', 'schedule', groupId, monday] as const;
  const q = useQuery({ queryKey: key, queryFn: () => api.get<ScheduleWeek>(scheduleWeekUrl(groupId, monday)) });
  const w = q.data;
  const from = monday ?? (w ? mondayOf(w.today) : null);
  if (w && monday === null) setMonday(mondayOf(w.today));
  if (w?.group && groupId === null) setGroupId(w.group.id);

  const original = useMemo(() => new Map((w?.cells ?? []).map((c) => [scheduleCellKey(c.staffId, c.date), c])), [w]);
  const cellOf = (staffId: number, date: string): ScheduleDraftCell => {
    const d = draft.get(scheduleCellKey(staffId, date))?.cell;
    if (d) return d;
    const o = original.get(scheduleCellKey(staffId, date));
    return o ? { shiftIds: o.shiftIds, consecutive: o.consecutive } : EMPTY_CELL;
  };
  const edited = (map: Map<string, ScheduleDraftEdit>, k: string, cell: ScheduleDraftCell) => {
    const o = original.get(k);
    const base = o ? { shiftIds: o.shiftIds, consecutive: o.consecutive } : EMPTY_CELL;
    map.set(k, { cell, expected: map.get(k)?.expected ?? base });
  };
  const dates = from ? Array.from({ length: 7 }, (_, i) => shiftDate(from, i)) : [];
  const shiftById = new Map((w?.shifts ?? []).map((s) => [s.id, s]));
  const dirty = [...draft.entries()].filter(([, v]) => !sameScheduleCell(v.cell, v.expected));
  const editableMembers = useMemo(() => (w?.members ?? []).filter((m) => m.editable), [w]);

  const reset = () => {
    setDraft(new Map());
    setError(null);
  };
  const reload = () => {
    reset();
    void qc.invalidateQueries({ queryKey: ['oa', 'schedule'] });
  };
  const busy = saving || copying || publishing;
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

  const copyLastWeek = async () => {
    if (!w?.group || !from) return;
    setCopying(true);
    setError(null);
    try {
      const prev = await api.get<ScheduleWeek>(scheduleWeekUrl(w.group.id, shiftDate(from, -7)));
      const active = new Set(w.shifts.filter((s) => s.active).map((s) => s.id));
      const prevCells = new Map(prev.cells.map((c) => [scheduleCellKey(c.staffId, c.date), c]));
      const next = new Map(draft);
      let n = 0;
      for (const m of editableMembers) {
        for (const d of dates) {
          if (d < w.today) continue;
          const p = prevCells.get(scheduleCellKey(m.staffId, shiftDate(d, -7)));
          const cell: ScheduleDraftCell = p ? { shiftIds: p.shiftIds.filter((id) => active.has(id)), consecutive: p.consecutive } : EMPTY_CELL;
          if (!sameScheduleCell(cell, cellOf(m.staffId, d))) n += 1;
          edited(next, scheduleCellKey(m.staffId, d), cell.shiftIds.length ? cell : EMPTY_CELL);
        }
      }
      setDraft(next);
      toast({ tone: 'info', title: n ? `已照上周填了 ${n} 格，核对后点「保存草稿」` : '这一周与上周一样，没有要改的' });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setCopying(false);
    }
  };

  const save = async () => {
    if (!w?.group || !from || !dirty.length) return;
    if (pendingSave.length) {
      setError('上一次保存结果待确认：请先在页面上方查回、按原内容重新提交或作废，再保存');
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
      toast({ tone: 'success', title: `排班草稿已保存（${changed} 格）`, body: '点「发布排班」后才生效并通知员工' });
      reload();
    } catch (e) {
      if (e instanceof UncertainError) {
        toast({ tone: 'info', title: '保存结果待确认', body: '已记在本机：请在页面上方查回、按原内容重新提交或作废；确认前不要重新排这几格。' });
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
      setError('上一次发布结果待确认：请先在页面上方查回、按原内容重新提交或作废');
      setPublishOpen(false);
      return;
    }
    setPublishing(true);
    setError(null);
    const to = shiftDate(from, 6);
    const clientKey = uuid();
    try {
      const r = await sendErpOp<SchedulePublishResult>({
        key: clientKey,
        type: 'oa_schedule_publish',
        url: '/api/oa/attendance/schedule/publish',
        body: { clientKey, storeId: session.store.id, groupId: w.group.id, from, to },
        summary: `发布排班 · ${w.group.name}（${from} 至 ${to}）`,
        staffName: session.staff.displayName,
        staffId: session.staff.id,
      });
      setPublishOpen(false);
      toast({
        tone: 'success',
        title: r.cellCount > 0 ? `排班已发布（${r.staffCount} 人 · ${r.cellCount} 格）` : '这一周没有待发布的排班改动',
        body: r.cellCount > 0 ? '已向排班有变动的员工推送站内通知' : undefined,
      });
      reload();
    } catch (e) {
      setPublishOpen(false);
      if (e instanceof UncertainError) {
        toast({ tone: 'info', title: '发布结果待确认', body: '已记在本机：请在页面上方查回、按原内容重新提交或作废。' });
        reload();
      } else if (e instanceof ErpPendingStoreError) setError(e.message);
      else setError(errorMessage(e));
    } finally {
      setPublishing(false);
    }
  };

  if (q.isPending) return <Skeleton className="h-72" />;
  if (q.isError && !w) return <LoadFailed title="排班没有取回来" onRetry={() => q.refetch()} retrying={q.isFetching} />;
  if (!w || !from) return null;
  const editingCell = editing?.cell ?? EMPTY_CELL;
  const effectiveFrom = from < w.today ? w.today : from;

  return (
    <Card className="p-5" data-testid="att-schedule">
      {w.group && w.editable && (
        <ScheduleBatchDialog
          open={batching}
          group={w.group}
          members={editableMembers}
          shifts={w.shifts}
          today={w.today}
          blocked={pendingSave.length > 0}
          onClose={() => setBatching(false)}
          onDone={() => {
            setBatching(false);
            reload();
          }}
        />
      )}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        {w.groups.length > 0 && (
          <Select value={w.group?.id ?? ''} onChange={(e) => pickGroup(Number(e.target.value))} disabled={busy} fullWidth={false} className="w-44" aria-label="考勤组" data-testid="att-schedule-group">
            {w.groups.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
          </Select>
        )}
        <div className="flex items-center gap-1">
          <Button size="sm" variant="ghost" icon={<ChevronLeft className="size-4" />} disabled={busy} onClick={() => go(shiftDate(from, -7))} aria-label="上一周" />
          <span className="num min-w-36 text-center text-[13px] font-semibold text-ink-2" data-testid="att-schedule-range">
            {from} – {shiftDate(from, 6)}
          </span>
          <Button size="sm" variant="ghost" icon={<ChevronRight className="size-4" />} disabled={busy} onClick={() => go(shiftDate(from, 7))} aria-label="下一周" data-testid="att-schedule-next" />
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => go(mondayOf(w.today))}>
            本周
          </Button>
        </div>
        {(w.editable || w.publishable) && w.group && (
          <div className="ml-auto flex flex-wrap items-center gap-2">
            {w.editable && (
              <>
                <Button
                  variant="secondary"
                  icon={<CalendarRange className="size-4" />}
                  disabled={busy || editableMembers.length === 0}
                  onClick={() => {
                    if (dirty.length && !window.confirm('这一周改了还没保存的格子会丢掉，确定先批量排班吗？')) return;
                    reset();
                    setBatching(true);
                  }}
                  data-testid="att-schedule-batch"
                >
                  批量排班
                </Button>
                <Button variant="secondary" icon={<Copy className="size-4" />} loading={copying} disabled={saving || publishing} onClick={copyLastWeek} data-testid="att-schedule-copy">
                  复制上周
                </Button>
                {dirty.length > 0 && (
                  <Button variant="ghost" disabled={busy} onClick={reset}>
                    放弃改动
                  </Button>
                )}
                <Button variant="secondary" loading={saving} disabled={!dirty.length || copying || publishing} onClick={save} data-testid="att-schedule-save">
                  保存草稿{dirty.length ? `（${dirty.length} 格）` : ''}
                </Button>
              </>
            )}
            {w.publishable && (
              <Button
                variant="primary"
                icon={<Send className="size-4" />}
                loading={publishing}
                disabled={busy || dirty.length > 0 || w.unpublishedCount === 0}
                onClick={() => setPublishOpen(true)}
                data-testid="att-schedule-publish"
              >
                {w.unpublishedCount > 0 ? `发布排班（${w.unpublishedCount} 格）` : '本周已发布'}
              </Button>
            )}
          </div>
        )}
      </div>
      {error && (
        <Notice tone="error" title="操作未完成" className="mb-3">
          <span data-testid="att-schedule-error">{error}</span>
        </Notice>
      )}
      {!w.editable && <p className="mb-3 text-[13px] text-ink-3">只能查看当前授权范围内的员工排班；要编排或发布请找部门经理或人力行政部授权。</p>}
      {w.unpublishedCount > 0 && (
        <p className="mb-3 text-[13px] text-ember" data-testid="att-schedule-unpublished-tip">
          本周有 {w.unpublishedCount} 格草稿尚未发布：发布前员工仍按原有已发布排班打卡与结算。
        </p>
      )}
      {!w.group ? (
        <EmptyState title="还没有能排班的考勤组" description={w.editable ? '先在「考勤组」页签建组、把员工加进来。' : '本部门的员工还没进考勤组。'} />
      ) : w.members.length === 0 ? (
        <EmptyState title="这个考勤组里还没有员工" />
      ) : (
        <DataTable
          columns={[
            {
              key: 'member',
              header: '员工',
              className: 'sticky left-0 z-10 w-32 bg-card',
              cell: (m) => (
                <>
                  <span className="block font-semibold text-ink">{m.name}</span>
                  <span className="block text-[12px] text-ink-3">{positionLabel(m.position)}</span>
                </>
              ),
            },
            ...dates.map(
              (d): DataColumn<Member> => ({
                key: d,
                header: (
                  <span className={cn(d === w.today && 'text-pine')}>
                    {describeDate(d).weekday}
                    <span className="num ml-1 font-normal">{d.slice(5)}</span>
                  </span>
                ),
                className: 'min-w-24 p-1 align-top',
                cell: (m) => {
                  const k = scheduleCellKey(m.staffId, d);
                  const c = cellOf(m.staffId, d);
                  const orig = original.get(k);
                  const e = draft.get(k);
                  const changed = !!e && !sameScheduleCell(e.cell, e.expected);
                  const locked = !m.editable || d < w.today || busy;
                  return (
                    <button
                      type="button"
                      disabled={locked}
                      onClick={() => {
                        const base = orig ? { shiftIds: orig.shiftIds, consecutive: orig.consecutive } : EMPTY_CELL;
                        setEditing({ staffId: m.staffId, date: d, cell: c, expected: draft.get(k)?.expected ?? base });
                      }}
                      data-testid={`att-cell-${m.staffId}-${d}`}
                      className={cn(
                        'relative flex min-h-12 w-full flex-col items-start gap-1 rounded-md border px-2 py-1.5 text-left transition-colors',
                        changed ? 'border-yuzu bg-yuzu-soft/50' : orig?.unpublished ? 'border-ember/40 bg-paper-2' : 'border-transparent',
                        !locked && 'hover:border-line-strong hover:bg-paper',
                        locked && 'cursor-default',
                      )}
                    >
                      {c.shiftIds.length === 0 ? (
                        <span className="text-ink-4">休息</span>
                      ) : (
                        c.shiftIds.map((id) => (
                          <Badge key={id} tone={shiftById.get(id)?.active === false ? 'clay' : 'lake'}>
                            {shiftById.get(id)?.name ?? '?'}
                          </Badge>
                        ))
                      )}
                      {c.consecutive && c.shiftIds.length > 0 && <span className="text-[12px] text-ember">连班</span>}
                      {!changed && orig?.unpublished && <span className="text-[12px] font-semibold text-ember">待发布</span>}
                    </button>
                  );
                },
              }),
            ),
          ]}
          rows={w.members}
          rowKey={(m) => m.staffId}
          testId="att-schedule-grid"
        />
      )}
      {w.recentPublishes.length > 0 && (
        <div className="mt-4 border-t border-line pt-3 text-[12.5px] text-ink-3" data-testid="att-publish-history">
          <p className="mb-1 font-semibold text-ink-2">最近发布记录</p>
          <div className="space-y-1">
            {w.recentPublishes.map((p) => (
              <p key={p.id} className="num">
                {p.publishedByName} · {p.fromDate} 至 {p.toDate}（{p.staffCount} 人、{p.cellCount} 格）
              </p>
            ))}
          </div>
        </div>
      )}
      <ScheduleCellDialog
        target={editing}
        cell={editingCell}
        shifts={w.shifts.filter((s) => s.active || editingCell.shiftIds.includes(s.id))}
        name={w.members.find((m) => m.staffId === editing?.staffId)?.name ?? ''}
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
        groupName={w.group?.name ?? ''}
        from={effectiveFrom}
        to={shiftDate(from, 6)}
        unpublishedCount={w.unpublishedCount}
        loading={publishing}
        onClose={() => setPublishOpen(false)}
        onConfirm={() => void publish()}
      />
    </Card>
  );
}
