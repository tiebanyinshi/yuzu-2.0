// 后台「餐饮 → 桌台」：包房房型（8.2.4，docs/V8224_DINING.md 第 2 节）。小房、中房、大房……可加；每个房型按低消收
// （另有中消：开台时刻在中消时段里、或人数不超过中消人数的按中消）或只收房费。桌台挂房型后低消按房型的，桌台自己设了低消的优先。

import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { MAX_ROOM_TYPE_NAME, ROOM_CHARGE_MODE_LABELS, type DiningRoomType, type RoomChargeMode } from '@shared/dining-v8224';
import type { TablesAdmin } from '@shared/dining';
import { centsToInput, formatYuan, parseYuan } from '@shared/money';
import { api, errorMessage } from '../../lib/api';
import { cn } from '../../lib/utils';
import { Dialog } from '../../components/Overlay';
import { useToast } from '../../components/Toast';
import { Badge, Button, Card, Field, Input, MoneyInput, Notice, PendingBadge, SectionTitle, Segmented } from '../../components/ui';

/** 「14:00」↔ 一天里的第几分钟 */
const hhmm = (m: number | null) => (m === null ? '' : `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`);
const minuteOf = (text: string): number | null => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(text.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  return h < 24 && mi < 60 ? h * 60 + mi : null;
};

/** 房型一行的说明：「低消 ¥500 · 中消 ¥300（2 人以下）」「只收房费 ¥88」 */
export function roomTypeText(r: DiningRoomType): string {
  if (r.chargeMode === 'room_fee') return `只收房费 ${formatYuan(r.roomFee)}`;
  const when = [r.midStart !== null ? `${hhmm(r.midStart)}–${hhmm(r.midEnd)} 开台` : '', r.midMaxGuests !== null ? `${r.midMaxGuests} 人以下` : ''].filter(Boolean).join(' 或 ');
  return `低消 ${formatYuan(r.minSpend)}${r.midSpend ? ` · 中消 ${formatYuan(r.midSpend)}（${when}）` : ''}`;
}

export function RoomTypesCard({ data, queryKey, editable }: { data: TablesAdmin; queryKey: readonly unknown[]; editable: boolean }) {
  const [editing, setEditing] = useState<DiningRoomType | 'new' | null>(null);
  return (
    <Card className="p-5" data-testid="dining-room-types">
      <SectionTitle
        aside={
          editable && (
            <Button size="sm" variant="secondary" icon={<Plus className="size-4" />} onClick={() => setEditing('new')} data-testid="room-type-new">
              新建房型
            </Button>
          )
        }
      >
        <span className="flex items-center gap-2">
          包房房型
          <PendingBadge title="中消的用法（按开台时段或人数）是先定的做法，待店主确认" />
        </span>
      </SectionTitle>
      <p className="mt-1 text-[12.5px] text-ink-3">
        按房型收低消（小房、中房、大房各不同），中消是第二档低消：开台时刻在中消时段里、或人数不超过中消人数的按中消收。只收房费的房型不设低消，结账时记一行房费。桌台挂了房型就是包房：服务费跟门店默认、低消没够可以返台；桌台自己设了低消的照桌台的。
      </p>
      {data.roomTypes.length === 0 ? (
        <p className="mt-4 rounded-lg border border-dashed border-line-strong px-4 py-6 text-center text-[13px] text-ink-3">
          还没有房型。{editable ? '点「新建房型」，例如「小房」「中房」「大房」。' : ''}
        </p>
      ) : (
        <ul className="mt-3 divide-y divide-line/70 rounded-lg border border-line">
          {data.roomTypes.map((r) => (
            <li key={r.id} className={cn('flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2.5', !r.active && 'bg-paper-2/50 opacity-70')} data-testid={`room-type-${r.name}`}>
              <span className="min-w-[72px] text-[14.5px] font-bold">{r.name}</span>
              <span className="min-w-0 flex-1 text-[12.5px] text-ink-3">{roomTypeText(r)}</span>
              <span className="text-[12px] text-ink-4">{r.tableCount ?? 0} 张桌</span>
              {!r.active && <Badge tone="clay">已停用</Badge>}
              {editable && (
                <Button size="sm" variant="ghost" onClick={() => setEditing(r)}>
                  编辑
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      <RoomTypeDialog target={editing} queryKey={queryKey} onClose={() => setEditing(null)} />
    </Card>
  );
}

function RoomTypeDialog({ target, queryKey, onClose }: { target: DiningRoomType | 'new' | null; queryKey: readonly unknown[]; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [opened, setOpened] = useState<typeof target>(null);
  const [name, setName] = useState('');
  const [mode, setMode] = useState<RoomChargeMode>('min_spend');
  const [minSpend, setMinSpend] = useState('');
  const [midSpend, setMidSpend] = useState('');
  const [midStart, setMidStart] = useState('');
  const [midEnd, setMidEnd] = useState('');
  const [midGuests, setMidGuests] = useState('');
  const [roomFee, setRoomFee] = useState('');
  const [active, setActive] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (target !== opened) {
    setOpened(target);
    const r = target && target !== 'new' ? target : null;
    setName(r?.name ?? '');
    setMode(r?.chargeMode ?? 'min_spend');
    setMinSpend(r?.minSpend ? centsToInput(r.minSpend) : '');
    setMidSpend(r?.midSpend ? centsToInput(r.midSpend) : '');
    setMidStart(hhmm(r?.midStart ?? null));
    setMidEnd(hhmm(r?.midEnd ?? null));
    setMidGuests(r?.midMaxGuests ? String(r.midMaxGuests) : '');
    setRoomFee(r?.roomFee ? centsToInput(r.roomFee) : '');
    setActive(r?.active ?? true);
    setError(null);
  }
  const cents = (t: string) => (t.trim() ? parseYuan(t) : 0);
  const start = midStart.trim() ? minuteOf(midStart) : null;
  const end = midEnd.trim() ? minuteOf(midEnd) : null;
  const guests = midGuests.trim() ? Number(midGuests) : null;
  const problem = (() => {
    if (!name.trim()) return '请写房型名称';
    if (mode === 'room_fee') return (cents(roomFee) ?? 0) > 0 ? null : '只收房费的房型请写房费';
    if (cents(minSpend) === null || cents(midSpend) === null) return '金额不正确';
    if ((midStart.trim() && start === null) || (midEnd.trim() && end === null)) return '中消时段写成 14:00 这样';
    if ((start === null) !== (end === null)) return '中消时段要同时写开始和结束';
    if (guests !== null && (!Number.isInteger(guests) || guests < 1 || guests > 99)) return '中消人数写 1 到 99';
    if ((cents(midSpend) ?? 0) > 0 && start === null && guests === null) return '设了中消，请写什么时候用中消（时段或人数）';
    return null;
  })();

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const body = {
        name: name.trim(),
        chargeMode: mode,
        minSpend: mode === 'min_spend' ? cents(minSpend) : 0,
        midSpend: mode === 'min_spend' ? cents(midSpend) : 0,
        midStart: mode === 'min_spend' ? start : null,
        midEnd: mode === 'min_spend' ? end : null,
        midMaxGuests: mode === 'min_spend' ? guests : null,
        roomFee: mode === 'room_fee' ? cents(roomFee) : 0,
        sortOrder: target && target !== 'new' ? target.sortOrder : 0,
        active,
      };
      const next =
        target === 'new'
          ? await api.post<Pick<TablesAdmin, 'roomTypes'>>('/api/admin/dining/room-types', body)
          : await api.put<Pick<TablesAdmin, 'roomTypes'>>(`/api/admin/dining/room-types/${target!.id}`, body);
      qc.setQueryData<TablesAdmin>(queryKey, (cur) => (cur ? { ...cur, roomTypes: next.roomTypes } : cur));
      toast({ tone: 'success', title: target === 'new' ? `已新建房型「${body.name}」` : '房型已保存' });
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={!!target}
      onClose={busy ? () => {} : onClose}
      title={target === 'new' ? '新建房型' : '编辑房型'}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button variant="primary" loading={busy} disabled={!!problem} onClick={save} data-testid="room-type-save">
            保存
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="房型名称" htmlFor="room-type-name" hint={`最多 ${MAX_ROOM_TYPE_NAME} 字，例如小房、中房、大房`}>
          <Input id="room-type-name" value={name} maxLength={MAX_ROOM_TYPE_NAME} onChange={(e) => setName(e.target.value)} data-autofocus data-testid="room-type-name" />
        </Field>
        <Segmented
          ariaLabel="怎么收"
          value={mode}
          onChange={(v) => setMode(v as RoomChargeMode)}
          options={[
            { value: 'min_spend', label: ROOM_CHARGE_MODE_LABELS.min_spend },
            { value: 'room_fee', label: ROOM_CHARGE_MODE_LABELS.room_fee },
          ]}
        />
        {mode === 'min_spend' ? (
          <>
            <div className="flex flex-wrap gap-4">
              <Field label="低消（元）" htmlFor="room-type-min" hint="菜钱不到低消：结账补足、返台再点或转挂账">
                <MoneyInput id="room-type-min" value={minSpend} onChange={(e) => setMinSpend(e.target.value)} className="w-36" data-testid="room-type-min" />
              </Field>
              <Field label="中消（元）" htmlFor="room-type-mid" hint="第二档低消；空着为不设">
                <MoneyInput id="room-type-mid" value={midSpend} onChange={(e) => setMidSpend(e.target.value)} className="w-36" data-testid="room-type-mid" />
              </Field>
            </div>
            <div className="flex flex-wrap items-end gap-4">
              <Field label="中消时段" htmlFor="room-type-mid-start" hint="开台时刻在这一段里用中消，例如 14:00–17:00">
                <span className="flex items-center gap-2">
                  <Input id="room-type-mid-start" value={midStart} onChange={(e) => setMidStart(e.target.value)} placeholder="14:00" className="num w-24" />
                  <span className="text-ink-3">–</span>
                  <Input value={midEnd} onChange={(e) => setMidEnd(e.target.value)} placeholder="17:00" className="num w-24" aria-label="中消时段结束" />
                </span>
              </Field>
              <Field label="或人数不超过" htmlFor="room-type-mid-guests" hint="人数少的用中消；空着为不按人数">
                <Input id="room-type-mid-guests" type="number" inputMode="numeric" min={1} max={99} value={midGuests} onChange={(e) => setMidGuests(e.target.value)} className="num w-24" />
              </Field>
            </div>
          </>
        ) : (
          <Field label="房费（元）" htmlFor="room-type-fee" hint="不设低消，结账时记一行房费（不算服务费）">
            <MoneyInput id="room-type-fee" value={roomFee} onChange={(e) => setRoomFee(e.target.value)} className="w-36" data-testid="room-type-fee" />
          </Field>
        )}
        {target !== 'new' && (
          <Segmented
            ariaLabel="房型状态"
            value={active ? 'on' : 'off'}
            onChange={(v) => setActive(v === 'on')}
            options={[
              { value: 'on', label: '启用' },
              { value: 'off', label: '停用' },
            ]}
          />
        )}
        {problem && name.trim() && <Notice tone="warning" title={problem} />}
        {error && <Notice tone="error" title={error} />}
      </div>
    </Dialog>
  );
}
