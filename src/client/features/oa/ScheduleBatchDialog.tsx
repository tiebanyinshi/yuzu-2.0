// 批量排班（店主 2026-11-24《考勤排班功能优化需求说明》第 2、3 条）：在「考勤设置 → 排班」里点「批量排班」。
//   · 员工：这个考勤组里的人，可全选、按岗位筛（门店就是当前门店：考勤组按门店建）；勾一个人就是单员工批量。
//   · 日子：按月的日历逐天勾，「选本月剩下的日子」一键全选，也可以填起止日期选一段；今天以前的不能选。
//   · 班次：一个；已有别的排班的日子勾了「覆盖」才换，没勾跳过。
//   · 保存前预览（只读）：几人 × 几天、新排几格、覆盖几格、已经是这个班的几格、跳过的格子与原因（请假、已经过了……）；
//     覆盖已有排班的再要勾「确认覆盖」。保存带操作编号、先记在本机（与单格保存同一个类型），结果不确定的在页面上方查回。
// 批量排完照样能在表格里单格调整。

import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { describeDate, shiftDate } from '@shared/labels';
import { SCHEDULE_AHEAD_DAYS, SCHEDULE_BATCH_MAX_DAYS, SCHEDULE_SKIP_LABELS, SCHEDULE_SKIP_REASONS, type OaShift, type ScheduleBatchResult, type ScheduleWeek } from '@shared/oa';
import { positionLabel } from '@shared/positions';
import { shiftTimeText } from '@shared/technician-admin';
import { api, errorMessage, UncertainError } from '../../lib/api';
import { ErpPendingStoreError, sendErpOp } from '../../lib/erpPending';
import { useSession } from '../../lib/session';
import { useResetOnOpen } from '../../lib/useResetOnOpen';
import { cn, uuid } from '../../lib/utils';
import { Dialog } from '../../components/Overlay';
import { useToast } from '../../components/Toast';
import { Button, ConfirmCheck, Field, Input, Notice, Select } from '../../components/ui';

type Member = ScheduleWeek['members'][number];
const WEEK = ['一', '二', '三', '四', '五', '六', '日'];
const monthOf = (d: string) => d.slice(0, 7);
const addMonths = (month: string, n: number) => {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const t = new Date(Date.UTC(y, m - 1 + n, 1));
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}`;
};
const daysOfMonth = (month: string) => {
  const out: string[] = [];
  for (let d = `${month}-01`; monthOf(d) === month; d = shiftDate(d, 1)) out.push(d);
  return out;
};

export function ScheduleBatchDialog({
  open,
  group,
  members,
  shifts,
  today,
  blocked,
  onClose,
  onDone,
}: {
  open: boolean;
  group: { id: number; name: string };
  members: Member[];
  shifts: OaShift[];
  today: string;
  /** 上一次保存结果待确认：确认前不让再保存 */
  blocked: boolean;
  onClose: () => void;
  onDone: () => void;
}) {
  const session = useSession();
  const toast = useToast();
  const active = shifts.filter((s) => s.active);
  const [staffIds, setStaffIds] = useState<number[]>([]);
  const [position, setPosition] = useState('');
  const [month, setMonth] = useState(monthOf(today));
  const [dates, setDates] = useState<string[]>([]);
  const [rangeFrom, setRangeFrom] = useState('');
  const [rangeTo, setRangeTo] = useState('');
  const [shiftId, setShiftId] = useState<number | null>(null);
  const [overwrite, setOverwrite] = useState(false);
  const [confirmOverwrite, setConfirmOverwrite] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useResetOnOpen(open, () => {
    setStaffIds([]);
    setPosition('');
    setMonth(monthOf(today));
    setDates([]);
    setRangeFrom('');
    setRangeTo('');
    setShiftId(active[0]?.id ?? null);
    setOverwrite(false);
    setConfirmOverwrite(false);
    setError(null);
  }, [open]);
  const last = shiftDate(today, SCHEDULE_AHEAD_DAYS);
  const selectable = (d: string) => d >= today && d <= last;
  const positions = useMemo(() => [...new Set(members.map((m) => m.position))], [members]);
  const shown = members.filter((m) => !position || m.position === position);
  const toggle = <T,>(list: T[], v: T) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  const setDays = (list: string[]) => setDates([...new Set(list)].filter(selectable).sort().slice(0, SCHEDULE_BATCH_MAX_DAYS));
  const monthDays = daysOfMonth(month);
  const lead = (new Date(`${month}-01T00:00:00Z`).getUTCDay() + 6) % 7;
  const pickRange = () => {
    if (!rangeFrom || !rangeTo || rangeTo < rangeFrom) return setError('起止日期不对：结束不能早于开始');
    const list: string[] = [];
    for (let d = rangeFrom; d <= rangeTo && list.length <= SCHEDULE_BATCH_MAX_DAYS; d = shiftDate(d, 1)) list.push(d);
    setError(null);
    setDays([...dates, ...list]);
  };
  const ready = staffIds.length > 0 && dates.length > 0 && shiftId !== null;
  const body = { storeId: session.store.id, groupId: group.id, staffIds: [...staffIds].sort((a, b) => a - b), dates, shiftId, overwrite };
  // 预览：选好了就自动算（只读）
  const [debounced, setDebounced] = useState(body);
  const bodyKey = JSON.stringify(body);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(JSON.parse(bodyKey) as typeof body), 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bodyKey]);
  const preview = useQuery({
    queryKey: ['oa', 'schedule-batch', debounced],
    queryFn: () => api.post<ScheduleBatchResult>('/api/oa/attendance/schedule/batch', { ...debounced, preview: true }),
    enabled: open && ready && JSON.stringify(debounced) === bodyKey,
    retry: false,
  });
  const p = ready && JSON.stringify(debounced) === bodyKey ? preview.data : undefined;
  const needConfirm = !!p && p.overwrite > 0;
  const skippedBy = p ? SCHEDULE_SKIP_REASONS.map((r) => [r, p.skipped.filter((s) => s.reason === r).length] as const).filter(([, n]) => n > 0) : [];
  const shift = active.find((s) => s.id === shiftId);

  const save = async () => {
    if (!p || !shift || !p.write) return;
    if (blocked) return setError('上一次保存结果待确认：请先在页面上方查回、按原内容重新提交或作废，再保存');
    if (needConfirm && !confirmOverwrite) return setError(`有 ${p.overwrite} 格原来排了别的班，要换成「${shift.name}」请先勾「确认覆盖」`);
    setSaving(true);
    setError(null);
    const key = uuid();
    try {
      const r = await sendErpOp<ScheduleBatchResult>({
        key,
        type: 'oa_schedule_save',
        url: '/api/oa/attendance/schedule/batch',
        body: { ...body, clientKey: key },
        summary: `${group.name} 批量排班 · ${staffIds.length} 人 × ${dates.length} 天「${shift.name}」`,
        staffName: session.staff.displayName,
      });
      toast({ tone: 'success', title: `批量排班已保存：改了 ${r.changed ?? 0} 格`, body: r.skipped.length ? `跳过 ${r.skipped.length} 格（请假、已过等），见预览里的明细` : undefined });
      onDone();
    } catch (e) {
      if (e instanceof UncertainError) {
        toast({ tone: 'info', title: '批量排班结果待确认', body: '已记在本机：请在页面上方查回、按原内容重新提交或作废；确认前不要重新排。' });
        onDone();
      } else if (e instanceof ErpPendingStoreError) setError(e.message);
      else setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={saving ? () => {} : onClose}
      title={`批量排班 · ${group.name}`}
      description="勾员工、勾日子、选一个班次，一次排完；请假的日子自动跳过。排完照样能在表格里单格调整。"
      width="max-w-4xl"
      footer={
        <>
          {error && (
            <span className="mr-auto self-center text-[13px] text-clay" data-testid="att-batch-error">
              {error}
            </span>
          )}
          <Button variant="secondary" size="lg" onClick={onClose} disabled={saving}>
            取消
          </Button>
          <Button variant="primary" size="lg" loading={saving} disabled={!p || !p.write || (needConfirm && !confirmOverwrite)} onClick={() => void save()} data-testid="att-batch-save">
            {p ? `保存（排 ${p.write} 格）` : '保存'}
          </Button>
        </>
      }
    >
      <div className="grid gap-5 md:grid-cols-[260px_minmax(0,1fr)]" data-testid="att-batch">
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <p className="text-[13px] font-semibold text-ink-2">员工（已选 {staffIds.length}）</p>
            <Button
              size="sm"
              variant="ghost"
              onClick={() =>
                setStaffIds(
                  shown.every((m) => staffIds.includes(m.staffId)) ? staffIds.filter((id) => !shown.some((m) => m.staffId === id)) : [...new Set([...staffIds, ...shown.map((m) => m.staffId)])],
                )
              }
              data-testid="att-batch-all-staff"
            >
              {shown.length > 0 && shown.every((m) => staffIds.includes(m.staffId)) ? '全不选' : '全选'}
            </Button>
          </div>
          <p className="text-[12px] text-ink-3">门店：{session.store.name}（考勤组按门店建）</p>
          {positions.length > 1 && (
            <Select value={position} onChange={(e) => setPosition(e.target.value)} aria-label="按岗位筛" data-testid="att-batch-position">
              <option value="">全部岗位</option>
              {positions.map((x) => (
                <option key={x ?? ''} value={x ?? ''}>
                  {positionLabel(x)}
                </option>
              ))}
            </Select>
          )}
          <div className="max-h-72 space-y-0.5 overflow-y-auto rounded-lg border border-line p-1.5">
            {shown.map((m) => (
              <label key={m.staffId} className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-[13px] hover:bg-paper-2">
                <input type="checkbox" checked={staffIds.includes(m.staffId)} onChange={() => setStaffIds(toggle(staffIds, m.staffId))} data-testid={`att-batch-staff-${m.staffId}`} />
                <span className="font-semibold text-ink">{m.name}</span>
                <span className="text-[12px] text-ink-3">{positionLabel(m.position)}</span>
              </label>
            ))}
          </div>
        </div>
        <div className="min-w-0 space-y-3">
          <div className="flex flex-wrap items-end gap-2">
            <Field label="班次" className="w-56">
              <Select value={shiftId ?? ''} onChange={(e) => setShiftId(Number(e.target.value) || null)} data-testid="att-batch-shift">
                {active.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}（{shiftTimeText(s)}）
                  </option>
                ))}
              </Select>
            </Field>
            <div className="flex items-center gap-1 pb-0.5">
              <Button size="sm" variant="ghost" icon={<ChevronLeft className="size-4" />} onClick={() => setMonth(addMonths(month, -1))} aria-label="上个月" />
              <span className="num min-w-24 text-center text-[14px] font-bold text-ink" data-testid="att-batch-month">
                {month.replace('-', ' 年 ')} 月
              </span>
              <Button size="sm" variant="ghost" icon={<ChevronRight className="size-4" />} onClick={() => setMonth(addMonths(month, 1))} aria-label="下个月" />
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="secondary" onClick={() => setDays([...dates, ...monthDays])} data-testid="att-batch-month-all">
              选本月（今天及以后）
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setDates(dates.filter((d) => monthOf(d) !== month))}>
              清掉本月
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setDates([])} disabled={!dates.length}>
              全部清空
            </Button>
            <span className="text-[12.5px] text-ink-3" data-testid="att-batch-day-count">
              已选 {dates.length} 天
            </span>
          </div>
          <div className="grid grid-cols-7 gap-1 text-[12px]" data-testid="att-batch-calendar">
            {WEEK.map((x) => (
              <div key={x} className="py-0.5 text-center font-semibold text-ink-3">
                {x}
              </div>
            ))}
            {Array.from({ length: lead }, (_, i) => (
              <div key={`pad-${i}`} />
            ))}
            {monthDays.map((d) => {
              const on = dates.includes(d);
              const ok = selectable(d);
              return (
                <button
                  key={d}
                  type="button"
                  disabled={!ok}
                  aria-pressed={on}
                  onClick={() => setDays(on ? dates.filter((x) => x !== d) : [...dates, d])}
                  className={cn(
                    'num h-10 rounded-md border text-[13px] font-semibold',
                    on ? 'border-pine bg-pine text-paper' : 'border-line bg-card text-ink-2 hover:border-line-strong',
                    !ok && 'cursor-not-allowed opacity-40',
                    d === today && !on && 'border-pine text-pine',
                  )}
                  title={describeDate(d).weekday}
                  data-testid={`att-batch-day-${d}`}
                >
                  {Number(d.slice(8))}
                </button>
              );
            })}
          </div>
          <div className="flex flex-wrap items-end gap-2">
            <Field label="从" className="w-40">
              <Input type="date" value={rangeFrom} min={today} max={last} onChange={(e) => setRangeFrom(e.target.value)} data-testid="att-batch-from" />
            </Field>
            <Field label="到" className="w-40">
              <Input type="date" value={rangeTo} min={today} max={last} onChange={(e) => setRangeTo(e.target.value)} data-testid="att-batch-to" />
            </Field>
            <Button variant="secondary" onClick={pickRange} data-testid="att-batch-range">
              选这一段
            </Button>
          </div>
          <ConfirmCheck
            checked={overwrite}
            onChange={(v) => {
              setOverwrite(v);
              setConfirmOverwrite(false);
            }}
          >
            已有别的排班的日子也换成这个班次（不勾就跳过那几天）
          </ConfirmCheck>
          {!ready ? (
            <p className="text-[13px] text-ink-3">勾好员工、日子、班次后这里会算出影响多少格。</p>
          ) : preview.isError ? (
            <Notice tone="error" title={errorMessage(preview.error)} />
          ) : !p ? (
            <p className="text-[13px] text-ink-3">正在算……</p>
          ) : (
            <div className="space-y-2 rounded-lg border border-line bg-paper p-3 text-[13px]" data-testid="att-batch-summary">
              <p className="text-ink-2">
                <b className="num">{p.staff}</b> 人 × <b className="num">{p.days}</b> 天 = <b className="num">{p.total}</b> 格：排「{shift?.name}」<b className="num text-pine"> {p.write}</b> 格
                {p.overwrite > 0 && (
                  <>
                    （其中覆盖原有排班 <b className="num text-clay">{p.overwrite}</b> 格）
                  </>
                )}
                {p.same > 0 && <>，已经是这个班 {p.same} 格</>}
                {p.skipped.length > 0 && (
                  <>
                    ，跳过 <b className="num">{p.skipped.length}</b> 格（{skippedBy.map(([r, n]) => `${SCHEDULE_SKIP_LABELS[r]} ${n}`).join('、')}）
                  </>
                )}
              </p>
              {p.skipped.length > 0 && (
                <ul className="max-h-32 space-y-0.5 overflow-y-auto text-[12.5px] text-ink-3" data-testid="att-batch-skipped">
                  {p.skipped.slice(0, 60).map((s) => (
                    <li key={`${s.staffId}|${s.date}`}>
                      {s.name} · <span className="num">{s.date}</span> · {SCHEDULE_SKIP_LABELS[s.reason]}
                    </li>
                  ))}
                  {p.skipped.length > 60 && <li>…还有 {p.skipped.length - 60} 格</li>}
                </ul>
              )}
              {needConfirm && (
                <ConfirmCheck checked={confirmOverwrite} onChange={setConfirmOverwrite} tone="clay">
                  确认覆盖：这 {p.overwrite} 格原来的排班换成「{shift?.name}」
                </ConfirmCheck>
              )}
            </div>
          )}
        </div>
      </div>
    </Dialog>
  );
}
