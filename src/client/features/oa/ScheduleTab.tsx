// OA-05 后台「考勤设置 → 排班」（docs/OA.md 第 8 节）：考勤组 × 日期，一周一屏。
//   · 点一格选一个或几个班次（连班要勾「连班」），空着 = 休息；改的格子先记在页面上，「保存」一次提交。
//   · 「复制上周」：把上一周同一天的排班填进这一周（今天以前的日子不动），核对后再保存。
//   · 每一格带着第一次改它时看到的原排班提交（之后页面重新取数也不换）：别人先改过的格子整批拒绝，重新载入后再排。
//   · 保存带操作编号、先记在本机再发（sendErpOp）：结果不确定的在页面上方查回、原样重提或确认作废，确认前不让再保存。
//     格子多的按员工分批（一批最多 SCHEDULE_SAVE_MAX_CELLS 格，一个人一周的格子总在同一批里，跨天重叠按人查不受分批影响）。
//   · 部门负责人（hr.attendanceDept）只看本部门员工，不能改。
// 窄屏上表格在卡片里左右滑，员工那一列固定在左边，页面本身不横向滚动。

import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, Copy } from 'lucide-react';
import { describeDate, shiftDate } from '@shared/labels';
import { SCHEDULE_MAX_SHIFTS_PER_DAY, SCHEDULE_SAVE_MAX_CELLS, type OaShift, type ScheduleSaved, type ScheduleWeek } from '@shared/oa';
import { positionLabel } from '@shared/positions';
import { shiftTimeText } from '@shared/technician-admin';
import { ApiError, api, errorMessage, UncertainError } from '../../lib/api';
import { ErpPendingStoreError, sendErpOp, useErpRecorded } from '../../lib/erpPending';
import { useSession } from '../../lib/session';
import { useResetOnOpen } from '../../lib/useResetOnOpen';
import { cn, uuid } from '../../lib/utils';
import { DataTable, type DataColumn } from '../../components/DataTable';
import { EmptyState } from '../../components/EmptyState';
import { LoadFailed } from '../../components/LoadFailed';
import { Dialog } from '../../components/Overlay';
import { useToast } from '../../components/Toast';
import { Badge, Button, Card, ConfirmCheck, Notice, Select, Skeleton } from '../../components/ui';

type Cell = { shiftIds: number[]; consecutive: boolean };
/** 改过的一格：要排成的样子 + 第一次改它时看到的原排班（提交时核对用，页面重新取数也不换） */
type Edit = { cell: Cell; expected: Cell };
type Member = ScheduleWeek['members'][number];
const EMPTY: Cell = { shiftIds: [], consecutive: false };
const keyOf = (staffId: number, date: string) => `${staffId}|${date}`;
const same = (a: Cell, b: Cell) => a.consecutive === b.consecutive && a.shiftIds.length === b.shiftIds.length && [...a.shiftIds].sort().join() === [...b.shiftIds].sort().join();

/** 这一天所在那一周的周一 */
function mondayOf(date: string): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const weekday = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return shiftDate(date, -((weekday + 6) % 7));
}

const weekUrl = (groupId: number | null, from: string | null) => `/api/oa/attendance/schedule?days=7${groupId ? `&groupId=${groupId}` : ''}${from ? `&from=${from}` : ''}`;

export function ScheduleTab() {
  const qc = useQueryClient();
  const toast = useToast();
  const [groupId, setGroupId] = useState<number | null>(null);
  const [monday, setMonday] = useState<string | null>(null);
  const session = useSession();
  // 记在本机的保存（还在路上、结果待确认）：确认前不让再保存（查不到不能断定没保存上）
  const pending = useErpRecorded(['oa_schedule_save']);
  const [draft, setDraft] = useState<Map<string, Edit>>(new Map());
  const [editing, setEditing] = useState<{ staffId: number; date: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [copying, setCopying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const key = ['oa', 'schedule', groupId, monday] as const;
  const q = useQuery({ queryKey: key, queryFn: () => api.get<ScheduleWeek>(weekUrl(groupId, monday)) });
  const w = q.data;
  // 第一次取回来以后定下周一与考勤组（后端默认今天、第一个组）
  const from = monday ?? (w ? mondayOf(w.today) : null);
  if (w && monday === null) setMonday(mondayOf(w.today));
  if (w?.group && groupId === null) setGroupId(w.group.id);

  const original = useMemo(() => new Map((w?.cells ?? []).map((c) => [keyOf(c.staffId, c.date), { shiftIds: c.shiftIds, consecutive: c.consecutive }])), [w]);
  const cellOf = (staffId: number, date: string) => draft.get(keyOf(staffId, date))?.cell ?? original.get(keyOf(staffId, date)) ?? EMPTY;
  /** 改一格：第一次改时记下当时看到的原排班 */
  const edited = (map: Map<string, Edit>, k: string, cell: Cell) => map.set(k, { cell, expected: map.get(k)?.expected ?? original.get(k) ?? EMPTY });
  const dates = from ? Array.from({ length: 7 }, (_, i) => shiftDate(from, i)) : [];
  const shiftById = new Map((w?.shifts ?? []).map((s) => [s.id, s]));
  const dirty = [...draft.entries()].filter(([, v]) => !same(v.cell, v.expected));

  const reset = () => {
    setDraft(new Map());
    setError(null);
  };
  const reload = () => {
    reset();
    void qc.invalidateQueries({ queryKey: ['oa', 'schedule'] });
  };
  const go = (next: string) => {
    if (dirty.length && !window.confirm('这一周改了还没保存的格子会丢掉，确定翻周吗？')) return;
    reset();
    setMonday(next);
  };
  const pickGroup = (id: number) => {
    if (dirty.length && !window.confirm('改了还没保存的格子会丢掉，确定换考勤组吗？')) return;
    reset();
    setGroupId(id);
  };

  const copyLastWeek = async () => {
    if (!w?.group || !from) return;
    setCopying(true);
    setError(null);
    try {
      const prev = await api.get<ScheduleWeek>(weekUrl(w.group.id, shiftDate(from, -7)));
      const active = new Set(w.shifts.filter((s) => s.active).map((s) => s.id));
      const prevCells = new Map(prev.cells.map((c) => [keyOf(c.staffId, c.date), c]));
      const next = new Map(draft);
      let n = 0;
      for (const m of w.members) {
        for (const d of dates) {
          if (d < w.today) continue;
          const p = prevCells.get(keyOf(m.staffId, shiftDate(d, -7)));
          const cell: Cell = p ? { shiftIds: p.shiftIds.filter((id) => active.has(id)), consecutive: p.consecutive } : EMPTY;
          if (!same(cell, cellOf(m.staffId, d))) n += 1;
          edited(next, keyOf(m.staffId, d), cell.shiftIds.length ? cell : EMPTY);
        }
      }
      setDraft(next);
      toast({ tone: 'info', title: n ? `已照上周填了 ${n} 格，核对后点「保存」` : '这一周与上周一样，没有要改的' });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setCopying(false);
    }
  };

  const save = async () => {
    if (!w?.group || !dirty.length) return;
    if (pending.length) {
      setError('上一次保存结果待确认：请先在页面上方查回、按原内容重新提交或作废，再保存');
      return;
    }
    setSaving(true);
    setError(null);
    // 按员工分批：一个人的格子总在同一批里
    type SaveCell = Cell & { staffId: number; date: string; expected: Cell };
    const byStaff = new Map<number, SaveCell[]>();
    for (const [k, v] of dirty) {
      const [staffId, date] = k.split('|') as [string, string];
      const id = Number(staffId);
      byStaff.set(id, [...(byStaff.get(id) ?? []), { staffId: id, date, shiftIds: v.cell.shiftIds, consecutive: v.cell.consecutive, expected: v.expected }]);
    }
    const batches: SaveCell[][] = [];
    for (const cells of byStaff.values()) {
      const last = batches[batches.length - 1];
      if (last && last.length + cells.length <= SCHEDULE_SAVE_MAX_CELLS) last.push(...cells);
      else batches.push([...cells]);
    }
    let changed = 0;
    let done = 0;
    try {
      for (const cells of batches) {
        const key = uuid();
        const r = await sendErpOp<ScheduleSaved>({
          key,
          type: 'oa_schedule_save',
          url: '/api/oa/attendance/schedule',
          body: { clientKey: key, storeId: session.store.id, groupId: w.group.id, cells },
          summary: `${w.group.name} · ${cells.length} 格（${from} 那一周）`,
          staffName: session.staff.displayName,
        });
        changed += r.changed;
        done += 1;
      }
      toast({ tone: 'success', title: `排班已保存（${changed} 格）` });
      reload();
    } catch (e) {
      const part = done ? `前 ${done} 批已保存；` : '';
      if (e instanceof UncertainError) {
        toast({ tone: 'info', title: `${part}保存结果待确认`, body: '已记在本机：请在页面上方查回、按原内容重新提交或作废；确认前不要重新排这几格。' });
        reload();
      } else if (e instanceof ApiError && e.code === 'SCHEDULE_CHANGED') {
        toast({ tone: 'info', title: `${part}${errorMessage(e)}`, body: '已载入最新的排班，请重新排' });
        reload();
      } else if (done) {
        setError(`${part}其余没有保存：${errorMessage(e)}`);
        reload();
      } else if (e instanceof ErpPendingStoreError) setError(e.message);
      else setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  if (q.isPending) return <Skeleton className="h-72" />;
  if (q.isError && !w) return <LoadFailed title="排班没有取回来" onRetry={() => q.refetch()} retrying={q.isFetching} />;
  if (!w || !from) return null;
  const editingCell = editing ? cellOf(editing.staffId, editing.date) : EMPTY;

  return (
    <Card className="p-5" data-testid="att-schedule">
      <div className="mb-4 flex flex-wrap items-center gap-2">
        {w.groups.length > 0 && (
          <Select value={w.group?.id ?? ''} onChange={(e) => pickGroup(Number(e.target.value))} fullWidth={false} className="w-44" aria-label="考勤组" data-testid="att-schedule-group">
            {w.groups.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
          </Select>
        )}
        <div className="flex items-center gap-1">
          <Button size="sm" variant="ghost" icon={<ChevronLeft className="size-4" />} onClick={() => go(shiftDate(from, -7))} aria-label="上一周" />
          <span className="num min-w-36 text-center text-[13px] font-semibold text-ink-2" data-testid="att-schedule-range">
            {from} – {shiftDate(from, 6)}
          </span>
          <Button size="sm" variant="ghost" icon={<ChevronRight className="size-4" />} onClick={() => go(shiftDate(from, 7))} aria-label="下一周" data-testid="att-schedule-next" />
          <Button size="sm" variant="ghost" onClick={() => go(mondayOf(w.today))}>
            本周
          </Button>
        </div>
        {w.editable && w.group && (
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <Button variant="secondary" icon={<Copy className="size-4" />} loading={copying} onClick={copyLastWeek} data-testid="att-schedule-copy">
              复制上周
            </Button>
            {dirty.length > 0 && (
              <Button variant="ghost" onClick={reset}>
                放弃改动
              </Button>
            )}
            <Button variant="primary" loading={saving} disabled={!dirty.length} onClick={save} data-testid="att-schedule-save">
              保存{dirty.length ? `（${dirty.length} 格）` : ''}
            </Button>
          </div>
        )}
      </div>
      {error && (
        <Notice tone="error" title="没有保存" className="mb-3">
          <span data-testid="att-schedule-error">{error}</span>
        </Notice>
      )}
      {!w.editable && <p className="mb-3 text-[13px] text-ink-3">只能看本部门员工的排班；要改请找人力行政部。</p>}
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
                  const c = cellOf(m.staffId, d);
                  const e = draft.get(keyOf(m.staffId, d));
                  const changed = !!e && !same(e.cell, e.expected);
                  const locked = !w.editable || d < w.today;
                  return (
                    <button
                      type="button"
                      disabled={locked}
                      onClick={() => setEditing({ staffId: m.staffId, date: d })}
                      data-testid={`att-cell-${m.staffId}-${d}`}
                      className={cn(
                        'relative flex min-h-12 w-full flex-col items-start gap-1 rounded-md border px-2 py-1.5 text-left transition-colors',
                        changed ? 'border-yuzu bg-yuzu-soft/50' : 'border-transparent',
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
      <CellDialog
        target={editing}
        cell={editingCell}
        shifts={w.shifts.filter((s) => s.active || editingCell.shiftIds.includes(s.id))}
        name={w.members.find((m) => m.staffId === editing?.staffId)?.name ?? ''}
        onClose={() => setEditing(null)}
        onDone={(cell) => {
          if (!editing) return;
          setDraft((d) => edited(new Map(d), keyOf(editing.staffId, editing.date), cell));
          setEditing(null);
        }}
      />
    </Card>
  );
}

function CellDialog({
  target,
  cell,
  shifts,
  name,
  onClose,
  onDone,
}: {
  target: { staffId: number; date: string } | null;
  cell: Cell;
  shifts: OaShift[];
  name: string;
  onClose: () => void;
  onDone: (cell: Cell) => void;
}) {
  const [picked, setPicked] = useState<number[]>([]);
  const [consecutive, setConsecutive] = useState(false);
  useResetOnOpen(
    !!target,
    () => {
      setPicked(cell.shiftIds);
      setConsecutive(cell.consecutive);
    },
    [target],
  );
  const toggle = (id: number) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : p.length >= SCHEDULE_MAX_SHIFTS_PER_DAY ? p : [...p, id]));
  return (
    <Dialog
      open={!!target}
      onClose={onClose}
      title={target ? `${name} · ${target.date}（${describeDate(target.date).weekday}）` : ''}
      description="选一个或几个班次；都不选就是休息。一天几个班、或前一天的跨天班接着第二天的班，打卡时间段挨在一起的要勾「连班」。"
      footer={
        <>
          <Button variant="secondary" size="lg" onClick={onClose}>
            取消
          </Button>
          <Button variant="primary" size="lg" onClick={() => onDone({ shiftIds: picked, consecutive: picked.length ? consecutive : false })} data-testid="att-cell-done">
            好
          </Button>
        </>
      }
    >
      {shifts.length === 0 ? (
        <p className="text-[13px] text-ink-3">还没有启用中的班次，先到「班次」页签建。</p>
      ) : (
        <div className="space-y-2">
          {shifts.map((s) => (
            <ConfirmCheck key={s.id} checked={picked.includes(s.id)} onChange={() => toggle(s.id)}>
              <span data-testid={`att-cell-shift-${s.name}`}>
                {s.name}
                <span className="num ml-2 text-[13px] font-normal text-ink-3">{shiftTimeText(s)}</span>
                {!s.active && <span className="ml-2 text-[12px] text-clay">（已停用）</span>}
              </span>
            </ConfirmCheck>
          ))}
          {picked.length > 0 && (
            <ConfirmCheck checked={consecutive} onChange={setConsecutive} tone="clay">
              连班：与前后相邻的班次首尾相接，打卡按时间先后分别算
            </ConfirmCheck>
          )}
        </div>
      )}
    </Dialog>
  );
}
