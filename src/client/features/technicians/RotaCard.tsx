// 技师管理 · 技师班次 · 轮班周期（8.1.41，docs/V8141_ROTA.md；店主 2026-11-25「自定义轮班」）：
//   门店自己定轮班——几段、每段几天上哪个班（或休息），选一种转班口径：
//   · 按周期轮转：从起算日起各段首尾相接一直重复（7 天一轮这类）；
//   · 每月 1 日固定转班：每月 1 日从第一段重新开始，排完了按最后一段排到月底（中医 10 天一转）。
//   两种口径在大小月下会冲突，一份轮班只选一种。
//   「生成排班」：选技师、每位从第几段开始（错开）、从哪天起排几天，先看预览再提交；写进排班表与手排的同一条路
//   （没变的跳过；今天已经排了的不能改，要改走临时调班；每格留痕）。
// 窄屏（商米 V3）上预览表在框里左右滑，页面本身不横向滚动。

import { useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { CalendarRange, Plus, Trash2 } from 'lucide-react';
import { describeDate, shiftDate } from '@shared/labels';
import { SCHEDULE_MAX_DAYS, type RosterTechnician, type ScheduleView, type TechnicianAdminView, type TechShift } from '@shared/technician-admin';
import {
  MAX_ROTA_NAME,
  MAX_ROTA_SEGMENTS,
  MAX_ROTAS,
  MAX_SEGMENT_DAYS,
  ROTA_APPLY_MAX_TECHS,
  ROTA_MODE_HINTS,
  ROTA_MODE_LABELS,
  rotaCellOn,
  rotaSummary,
  rotaTotalDays,
  type RotaMode,
  type RotaSegment,
  type TechRota,
} from '@shared/technician-rota';
import { api, errorMessage } from '../../lib/api';
import { cn } from '../../lib/utils';
import { DataTable } from '../../components/DataTable';
import { LoadFailed } from '../../components/LoadFailed';
import { Dialog } from '../../components/Overlay';
import { QtyInput } from '../../components/QtyInput';
import { useToast } from '../../components/Toast';
import { Badge, Button, Card, Field, Input, Notice, SectionTitle, Segmented, Select, Skeleton } from '../../components/ui';
import { rotasKey, useRotas, useTechAdminRefresh } from './queries';

const shiftNameOf = (shifts: TechShift[]) => (id: number) => shifts.find((s) => s.id === id)?.name ?? '已删除的班次';
const qtyBox = 'h-11 w-20 rounded-md border border-line-strong';

/** 每月 1 日固定转班：各段加起来的天数与大小月怎么对上 */
function monthlyNote(total: number): string {
  if (total < 28) return `各段加起来 ${total} 天，不够一个月：排完以后到月底都按最后一段排。`;
  if (total <= 31) return `各段加起来 ${total} 天：比当月短的月份最后一段截掉几天，比当月长的最后一段多排几天。`;
  return `各段加起来 ${total} 天，超过一个月：每月排到月底为止，后面的几段这个月排不到。`;
}

export function RotaCard({ view }: { view: TechnicianAdminView }) {
  const rotas = useRotas();
  const [editing, setEditing] = useState<TechRota | 'new' | null>(null);
  const [applying, setApplying] = useState<TechRota | null>(null);
  const list = rotas.data?.rotas ?? [];
  const name = shiftNameOf(view.shifts);
  return (
    <Card className="p-5" data-testid="tech-rotas">
      <SectionTitle
        aside={
          view.canManage &&
          rotas.data &&
          list.length < MAX_ROTAS && (
            <Button size="lg" variant="secondary" icon={<Plus className="size-4" />} onClick={() => setEditing('new')} data-testid="tech-rota-new">
              新建轮班
            </Button>
          )
        }
      >
        轮班周期
      </SectionTitle>
      <p className="mt-1 text-[12.5px] text-ink-3">
        门店自己定轮班：几段、每段几天上哪个班，再选转班口径——「按周期轮转」从起算日起一直重复，「每月 1 日固定转班」每月 1 日从第一段重来。按轮班「生成排班」以后，排班表照常可以逐格改。
      </p>
      {rotas.isPending ? (
        <Skeleton className="mt-3 h-20" />
      ) : rotas.isError && !rotas.data ? (
        <LoadFailed title="轮班没取回来" onRetry={() => void rotas.refetch()} retrying={rotas.isFetching} className="mt-3" />
      ) : list.length === 0 ? (
        <p className="mt-3 rounded-lg border border-dashed border-line-strong px-4 py-6 text-center text-[13px] text-ink-3">
          还没有轮班。例如中医「10 天早班 → 10 天晚班 → 10 天休息」，选「每月 1 日固定转班」。
        </p>
      ) : (
        <ul className="mt-3 divide-y divide-line/70 rounded-lg border border-line" data-testid="tech-rota-list">
          {list.map((r) => (
            <li key={r.id} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-2.5" data-testid={`tech-rota-${r.name}`}>
              <span className="text-[14px] font-bold">{r.name}</span>
              <Badge tone={r.mode === 'monthly' ? 'lake' : 'neutral'}>{ROTA_MODE_LABELS[r.mode]}</Badge>
              <span className="min-w-0 flex-1 text-[13px] text-ink-2">
                {rotaSummary(r, name)}
                <span className="ml-1.5 text-ink-3">
                  （一轮 {rotaTotalDays(r)} 天{r.mode === 'cycle' && r.anchor ? `，${r.anchor} 起算` : ''}）
                </span>
              </span>
              {view.canManage && (
                <span className="flex gap-1.5">
                  <Button size="sm" variant="ghost" onClick={() => setEditing(r)}>
                    编辑
                  </Button>
                  <Button size="sm" variant="secondary" icon={<CalendarRange className="size-3.5" />} onClick={() => setApplying(r)} data-testid={`tech-rota-apply-${r.name}`}>
                    生成排班
                  </Button>
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      {editing && <RotaDialog key={editing === 'new' ? 'new' : editing.id} target={editing} list={list} view={view} onClose={() => setEditing(null)} />}
      {applying && <ApplyDialog key={applying.id} rota={applying} view={view} onClose={() => setApplying(null)} />}
    </Card>
  );
}

/** 新建、编辑一份轮班（整份清单一起保存）；编辑时可以删除 */
function RotaDialog({ target, list, view, onClose }: { target: TechRota | 'new'; list: TechRota[]; view: TechnicianAdminView; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const existing = target === 'new' ? null : target;
  const usable = view.shifts.filter((s) => s.active);
  const [name, setName] = useState(existing?.name ?? '');
  const [mode, setMode] = useState<RotaMode>(existing?.mode ?? 'cycle');
  const [anchor, setAnchor] = useState(existing?.anchor ?? view.businessDate);
  const [segments, setSegments] = useState<RotaSegment[]>(existing?.segments ?? [{ days: 7, shiftId: usable[0]?.id ?? null }]);
  const [hint, setHint] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const total = segments.reduce((s, g) => s + g.days, 0);
  const trimmed = name.trim();
  const problem = !trimmed
    ? '请填写轮班的名字'
    : list.some((r) => r.name === trimmed && r.id !== existing?.id)
      ? '已经有同名的轮班'
      : mode === 'cycle' && !anchor
        ? '请填写起算日'
        : segments.some((g) => g.shiftId !== null && !usable.some((s) => s.id === g.shiftId))
          ? '有一段的班次已停用，请重新选'
          : null;
  const setSeg = (i: number, patch: Partial<RotaSegment>) => setSegments(segments.map((g, j) => (j === i ? { ...g, ...patch } : g)));

  const submit = async (next: (Omit<TechRota, 'id'> & { id?: number })[], done: string) => {
    setSaving(true);
    setError(null);
    try {
      const saved = await api.put<{ rotas: TechRota[] }>('/api/technician-admin/rotas', { rotas: next });
      qc.setQueryData(rotasKey, saved);
      toast({ tone: 'success', title: done });
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };
  const save = () => {
    // 新建的不带编号，服务端接着最大号往后排
    const rota = { name: trimmed, mode, anchor: mode === 'cycle' ? anchor : null, segments };
    void submit(existing ? list.map((r) => (r.id === existing.id ? { id: r.id, ...rota } : r)) : [...list, rota], `轮班「${trimmed}」已保存`);
  };
  const remove = () =>
    void submit(
      list.filter((r) => r.id !== existing!.id),
      `轮班「${existing!.name}」已删除`,
    );

  return (
    <Dialog
      open
      onClose={onClose}
      width="max-w-2xl"
      title={existing ? `编辑轮班 · ${existing.name}` : '新建轮班'}
      description="删除或修改轮班不动已经排好的格子；要按新的轮班重排，再点「生成排班」。"
      footer={
        <>
          {existing &&
            (confirmDelete ? (
              <Button variant="danger" size="lg" loading={saving} onClick={remove} className="mr-auto" data-testid="tech-rota-delete-confirm">
                确认删除
              </Button>
            ) : (
              <Button variant="ghost" size="lg" icon={<Trash2 className="size-4" />} onClick={() => setConfirmDelete(true)} className="mr-auto">
                删除
              </Button>
            ))}
          {problem && <span className="mr-auto self-center text-[13px] text-clay">{problem}</span>}
          <Button variant="secondary" size="lg" onClick={onClose}>
            取消
          </Button>
          <Button variant="primary" size="lg" loading={saving} disabled={!!problem} onClick={save} data-testid="tech-rota-save">
            保存
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-1 gap-4">
        <Field label="名字" htmlFor="tr-name">
          <Input id="tr-name" value={name} maxLength={MAX_ROTA_NAME} onChange={(e) => setName(e.target.value)} placeholder="例如：中医十天转" data-autofocus data-testid="tech-rota-name" />
        </Field>
        <Field label="转班口径" hint={ROTA_MODE_HINTS[mode]}>
          <Segmented
            ariaLabel="转班口径"
            value={mode}
            onChange={setMode}
            className="w-full"
            options={[
              { value: 'cycle', label: ROTA_MODE_LABELS.cycle },
              { value: 'monthly', label: ROTA_MODE_LABELS.monthly },
            ]}
          />
        </Field>
        {mode === 'cycle' ? (
          <Field label="起算日" htmlFor="tr-anchor" hint="第一段的第一天；以前、以后的日子都按这个节奏推。">
            <Input id="tr-anchor" type="date" value={anchor} onChange={(e) => setAnchor(e.target.value)} className="num" fullWidth={false} data-testid="tech-rota-anchor" />
          </Field>
        ) : (
          <Notice tone="info" title={monthlyNote(total)} />
        )}
        <Field label={`各段（一轮 ${total} 天）`} hint={hint ?? '按顺序排；选「休息」的那几天排休。'}>
          <ol className="space-y-2" data-testid="tech-rota-segments">
            {segments.map((g, i) => (
              <li key={i} className="flex flex-wrap items-center gap-2">
                <span className="w-12 text-[13px] font-semibold text-ink-3">第 {i + 1} 段</span>
                <QtyInput
                  value={g.days}
                  max={MAX_SEGMENT_DAYS}
                  onChange={(days) => setSeg(i, { days })}
                  onHint={setHint}
                  label={`第 ${i + 1} 段的天数`}
                  className={qtyBox}
                  testId={`tech-rota-days-${i}`}
                />
                <span className="text-[13px] text-ink-2">天</span>
                <Select
                  className="h-11 min-w-0 flex-1"
                  fullWidth={false}
                  value={g.shiftId ?? ''}
                  onChange={(e) => setSeg(i, { shiftId: e.target.value ? Number(e.target.value) : null })}
                  aria-label={`第 ${i + 1} 段上哪个班`}
                  data-testid={`tech-rota-shift-${i}`}
                >
                  {view.shifts
                    .filter((s) => s.active || s.id === g.shiftId)
                    .map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                        {s.active ? '' : '（已停用）'}
                      </option>
                    ))}
                  <option value="">休息</option>
                </Select>
                <Button size="sm" variant="ghost" disabled={segments.length === 1} onClick={() => setSegments(segments.filter((_, j) => j !== i))} aria-label={`删掉第 ${i + 1} 段`}>
                  删掉
                </Button>
              </li>
            ))}
          </ol>
          {segments.length < MAX_ROTA_SEGMENTS && (
            <Button
              size="sm"
              variant="ghost"
              icon={<Plus className="size-3.5" />}
              onClick={() => setSegments([...segments, { days: segments.at(-1)?.days ?? 1, shiftId: null }])}
              className="self-start"
              data-testid="tech-rota-add-segment"
            >
              加一段
            </Button>
          )}
        </Field>
        {error && <Notice tone="error" title={error} />}
      </div>
    </Dialog>
  );
}

/** 按一份轮班生成排班：选技师、每位从第几段开始、从哪天起排几天；先看预览再提交 */
function ApplyDialog({ rota, view, onClose }: { rota: TechRota; view: TechnicianAdminView; onClose: () => void }) {
  const toast = useToast();
  const refresh = useTechAdminRefresh();
  const technicians = view.technicians.filter((t) => t.active);
  const name = shiftNameOf(view.shifts);
  const [picked, setPicked] = useState<number[]>([]);
  const [offsets, setOffsets] = useState<Record<number, number>>({});
  const [from, setFrom] = useState(shiftDate(view.businessDate, 1));
  const [days, setDays] = useState(rota.mode === 'monthly' ? 31 : 14);
  const [hint, setHint] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dates = useMemo(() => (from ? Array.from({ length: days }, (_, i) => shiftDate(from, i)) : []), [from, days]);
  const chosen = technicians.filter((t) => picked.includes(t.id));
  const toggle = (id: number) => {
    if (picked.includes(id)) return setPicked(picked.filter((x) => x !== id));
    // 新选上的默认接着错开一段：三位中医依次从第一、二、三段开始
    setOffsets({ ...offsets, [id]: offsets[id] ?? picked.length % rota.segments.length });
    setPicked([...picked, id]);
  };
  const problem =
    picked.length === 0
      ? '请选择技师'
      : picked.length > ROTA_APPLY_MAX_TECHS
        ? `一次最多 ${ROTA_APPLY_MAX_TECHS} 位技师`
        : !from
          ? '请填写从哪天开始'
          : from < view.businessDate
            ? '不能从过去的日子开始'
            : null;
  const label = (seg: number) => `第 ${seg + 1} 段 · ${rota.segments[seg]!.days} 天 ${rota.segments[seg]!.shiftId === null ? '休息' : name(rota.segments[seg]!.shiftId!)}`;

  const submit = async () => {
    setSaving(true);
    setError(null);
    try {
      const body = { technicianIds: picked, offsets: Object.fromEntries(picked.map((id) => [String(id), offsets[id] ?? 0])), from, days };
      const r = await api.post<ScheduleView & { changed: number }>(`/api/technician-admin/rotas/${rota.id}/apply?from=${from}&days=${days}`, body);
      refresh();
      toast({ tone: 'success', title: r.changed ? `按「${rota.name}」排了 ${r.changed} 格` : '排班表本来就是这样排的，没有改动' });
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      width="max-w-3xl"
      title={`生成排班 · ${rota.name}`}
      description={`${ROTA_MODE_LABELS[rota.mode]}：${rotaSummary(rota, name)}。已经排了的格子按轮班改写（一样的不记）；今天已经排了的不能在这里改，要改走「临时调班」。`}
      footer={
        <>
          {problem && <span className="mr-auto self-center text-[13px] text-clay">{problem}</span>}
          <Button variant="secondary" size="lg" onClick={onClose}>
            取消
          </Button>
          <Button variant="primary" size="lg" loading={saving} disabled={!!problem} onClick={submit} data-testid="tech-rota-apply-submit">
            生成 {picked.length ? `${picked.length * days} 格` : ''}
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-1 gap-4">
        <Field label={`技师（已选 ${picked.length} 位）`} hint="只列在职的技师；新选的依次错开一段，下面可以改从第几段开始。">
          <div className="flex flex-wrap gap-1.5">
            {technicians.map((t) => {
              const on = picked.includes(t.id);
              return (
                <button
                  key={t.id}
                  type="button"
                  aria-pressed={on}
                  onClick={() => toggle(t.id)}
                  className={cn('tap relative h-9 rounded-full border px-3 text-[13px] font-semibold', on ? 'border-pine bg-pine-tint text-pine' : 'border-line-strong text-ink-2 hover:border-ink-4')}
                  data-testid={`tech-rota-pick-${t.techNo}`}
                >
                  <span className="num">{t.techNo}</span> {t.nickname || t.name}
                </button>
              );
            })}
          </div>
        </Field>
        {chosen.length > 0 && rota.segments.length > 1 && (
          <Field label="每位从第几段开始">
            <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {chosen.map((t) => (
                <li key={t.id} className="flex items-center gap-2">
                  <span className="w-24 shrink-0 truncate text-[13px] font-semibold">
                    <span className="num">{t.techNo}</span> {t.nickname || t.name}
                  </span>
                  <Select
                    className="h-11 min-w-0 flex-1"
                    fullWidth={false}
                    value={offsets[t.id] ?? 0}
                    onChange={(e) => setOffsets({ ...offsets, [t.id]: Number(e.target.value) })}
                    aria-label={`${t.techNo} 号从第几段开始`}
                    data-testid={`tech-rota-offset-${t.techNo}`}
                  >
                    {rota.segments.map((_, i) => (
                      <option key={i} value={i}>
                        {label(i)}
                      </option>
                    ))}
                  </Select>
                </li>
              ))}
            </ul>
          </Field>
        )}
        <div className="flex flex-wrap items-end gap-4">
          <Field label="从哪天开始" htmlFor="tra-from">
            <Input id="tra-from" type="date" value={from} min={view.businessDate} onChange={(e) => setFrom(e.target.value)} className="num" fullWidth={false} data-testid="tech-rota-from" />
          </Field>
          <Field label="排几天" hint={hint ?? `1–${SCHEDULE_MAX_DAYS} 天`}>
            <QtyInput value={days} max={SCHEDULE_MAX_DAYS} onChange={setDays} onHint={setHint} label="排几天" className={qtyBox} testId="tech-rota-days" />
          </Field>
        </div>
        {chosen.length > 0 && dates.length > 0 && (
          <div>
            <h3 className="text-[13px] font-bold text-ink-2">预览</h3>
            <DataTable
              className="mt-1.5"
              testId="tech-rota-preview"
              rows={chosen}
              rowKey={(t) => t.id}
              columns={[
                {
                  key: 'tech',
                  header: '技师',
                  className: 'sticky left-0 z-10 bg-card whitespace-nowrap',
                  cell: (t) => (
                    <span className="font-semibold">
                      <span className="num">{t.techNo}</span> {t.nickname || t.name}
                    </span>
                  ),
                },
                ...dates.map((d) => ({
                  key: d,
                  align: 'center' as const,
                  headerClassName: d.endsWith('-01') ? 'text-lake' : undefined,
                  header: (
                    <>
                      <span className="num block">{describeDate(d).md}</span>
                      <span className="block font-normal">{d.endsWith('-01') ? '1 日' : describeDate(d).weekday}</span>
                    </>
                  ),
                  cell: (t: RosterTechnician) => {
                    const c = rotaCellOn(rota, d, offsets[t.id] ?? 0);
                    return (
                      <span className={cn('inline-block min-w-10 rounded px-1 py-0.5 whitespace-nowrap', c.rest ? 'bg-paper-2 text-ink-2' : 'bg-pine-tint font-semibold text-pine')}>
                        {c.rest ? '休' : name(c.shiftId!)}
                      </span>
                    );
                  },
                })),
              ]}
            />
          </div>
        )}
        {error && <Notice tone="error" title={error} />}
      </div>
    </Dialog>
  );
}
