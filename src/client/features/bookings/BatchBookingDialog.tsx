// 一报多（8.2.2，《技师排班系统需求沟通会》二.2；docs/V8222_TECHNICIANS.md 第 2 节）：一次填几位客人的技师预约，一键提交。
// 默认 3 行，可以再加，最多 MAX_BATCH_BOOKINGS 行；每行客人姓氏、手牌号（可空）、电话、项目、技师、时间。
// 一个操作编号、一个事务：全部建好或一张都不建，哪一行不行标出来；结果不明时与单张新建同一套「结果待确认」。
// 指定了技师的不查他同一时段别的预约（一位技师同时约几位客人不设上限）。

import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Plus, X } from 'lucide-react';
import { DEFAULT_BATCH_BOOKING_ROWS, MAX_BATCH_BOOKINGS, type BookingBoard, type BookingDetail } from '@shared/bookings';
import { normalizeTagCode, TAG_CODE_PATTERN } from '@shared/frontdesk';
import { describeDate, shiftDate } from '@shared/labels';
import { useSession } from '../../lib/session';
import { Dialog } from '../../components/Overlay';
import { useToast } from '../../components/Toast';
import { Button, Field, IconButton, Input, Notice, Select } from '../../components/ui';
import { PendingPanel, useFrontdeskOp } from '../frontdesk/pending';

interface Row {
  rid: number;
  guestName: string;
  tagCode: string;
  guestPhone: string;
  itemId: number | null;
  technicianId: number | null;
  time: string;
}

let nextRid = 1;
const blank = (itemId: number | null, time = ''): Row => ({ rid: nextRid++, guestName: '', tagCode: '', guestPhone: '', itemId, technicianId: null, time });

/** 营业日 + 几点几分 → 时刻（营业时段跨零点的，早于开门时间的算第二天凌晨） */
function startsAtOf(day: string, time: string, openTime: string, closeTime: string): string {
  const overnight = closeTime <= openTime;
  const date = overnight && time < openTime ? shiftDate(day, 1) : day;
  return new Date(`${date}T${time}:00`).toISOString();
}

export function BatchBookingDialog({ board, date, lastDay, onClose }: { board: BookingBoard; date: string; lastDay: string; onClose: (createdOn: string | null) => void }) {
  const session = useSession();
  const qc = useQueryClient();
  const toast = useToast();
  const today = session.today;
  const [day, setDay] = useState(date < today ? today : date);
  const [source, setSource] = useState<'front' | 'phone'>('front');
  const first = board.items[0]?.id ?? null;
  const [rows, setRows] = useState<Row[]>(() => Array.from({ length: DEFAULT_BATCH_BOOKING_ROWS }, () => blank(first)));
  const op = useFrontdeskOp<{ bookings: BookingDetail[] }>({
    type: 'booking_create',
    visitId: null,
    staffName: session.staff.displayName,
    pick: (f) => (f.type === 'booking_create' ? { bookings: [f.booking] } : null),
  });
  const days: string[] = [];
  for (let d = today; d <= lastDay && days.length < 15; d = shiftDate(d, 1)) days.push(d);
  const patch = (rid: number, p: Partial<Row>) => setRows((list) => list.map((r) => (r.rid === rid ? { ...r, ...p } : r)));
  const filled = rows.filter((r) => r.guestName.trim() || r.guestPhone.trim() || r.tagCode.trim());
  const problemOf = (r: Row): string | null => {
    if (!r.guestName.trim()) return '写客人姓氏';
    if (r.tagCode.trim() && !TAG_CODE_PATTERN.test(normalizeTagCode(r.tagCode))) return '手牌号格式不对';
    if (r.guestPhone.trim() && !/^1\d{10}$/.test(r.guestPhone.replace(/[\s-]/g, ''))) return '电话要 11 位';
    if (!r.itemId) return '选项目';
    if (!/^\d{2}:\d{2}$/.test(r.time)) return '选时间';
    return null;
  };
  const problems = filled.map(problemOf);
  const problem = filled.length === 0 ? '至少填一位客人' : (problems.find(Boolean) ?? null);
  const submit = async () => {
    if (problem) return;
    const body = {
      source,
      rows: filled.map((r) => ({
        guestName: r.guestName.trim(),
        tagCode: r.tagCode.trim(),
        guestPhone: r.guestPhone.trim(),
        itemId: r.itemId,
        technicianId: r.technicianId,
        startsAt: startsAtOf(day, r.time, board.rules.openTime, board.rules.closeTime),
      })),
    };
    const res = await op.submit((key) => ({
      url: '/api/bookings/batch',
      body: { clientKey: key, ...body },
      tagCodes: ['预约'],
      summary: `一报多：${describeDate(day).md} ${filled.length} 位客人的技师预约`,
      amount: null,
    }));
    if (res) {
      void qc.invalidateQueries({ queryKey: ['bookings'] });
      toast({ tone: 'success', title: `已预约 ${res.bookings.length} 位`, body: res.bookings.map((b) => b.bookingNo).join('、') });
      onClose(day);
    }
  };
  return (
    <Dialog
      open
      onClose={op.busy ? () => {} : () => onClose(null)}
      width="max-w-5xl"
      title="一报多 · 技师预约"
      description="一次填几位客人，一键提交：全部约上或一张都不约。同一位技师同一时段可以约几位客人；手牌号没有可以不填。"
      footer={
        <>
          <span className="mr-auto self-center text-[13px] text-ink-3">{problem ? <span className="text-clay">{problem}</span> : `${filled.length} 位客人`}</span>
          <Button variant="ghost" onClick={() => onClose(null)} disabled={op.busy}>
            取消
          </Button>
          <Button variant="primary" disabled={!!problem || op.locked} loading={op.busy} onClick={() => void submit()} data-testid="batch-booking-submit">
            一起提交
          </Button>
        </>
      }
    >
      <PendingPanel
        op={op}
        onResolved={() => {
          void qc.invalidateQueries({ queryKey: ['bookings'] });
          onClose(day);
        }}
      />
      <div className="mb-3 flex flex-wrap gap-3">
        <Field label="哪一天" htmlFor="batch-day">
          <Select id="batch-day" value={day} onChange={(e) => setDay(e.target.value)} fullWidth={false}>
            {days.map((d) => (
              <option key={d} value={d}>
                {describeDate(d).md}
                {d === today ? '（今天）' : ''}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="来源" htmlFor="batch-source">
          <Select id="batch-source" value={source} onChange={(e) => setSource(e.target.value as 'front' | 'phone')} fullWidth={false}>
            <option value="front">前台</option>
            <option value="phone">电话</option>
          </Select>
        </Field>
      </div>
      <div className="space-y-2" data-testid="batch-booking-rows">
        {rows.map((r, i) => {
          const why = filled.includes(r) ? problemOf(r) : null;
          return (
            <div key={r.rid} className={`grid grid-cols-2 gap-2 rounded-lg border p-2 md:grid-cols-[2rem_1fr_1fr_1.3fr_1.6fr_1.4fr_7rem_2rem] ${why ? 'border-clay' : 'border-line'}`}>
              <span className="num self-center text-[13px] font-bold text-ink-3">{i + 1}</span>
              <Input aria-label={`第 ${i + 1} 行客人姓氏`} placeholder="姓氏" value={r.guestName} maxLength={32} onChange={(e) => patch(r.rid, { guestName: e.target.value })} />
              <Input aria-label={`第 ${i + 1} 行手牌号`} placeholder="手牌（可空）" value={r.tagCode} maxLength={8} onChange={(e) => patch(r.rid, { tagCode: e.target.value })} />
              <Input aria-label={`第 ${i + 1} 行电话`} placeholder="电话" inputMode="tel" value={r.guestPhone} maxLength={13} onChange={(e) => patch(r.rid, { guestPhone: e.target.value })} />
              <Select aria-label={`第 ${i + 1} 行项目`} value={r.itemId ?? ''} onChange={(e) => patch(r.rid, { itemId: e.target.value ? Number(e.target.value) : null })}>
                {board.items.map((it) => (
                  <option key={it.id} value={it.id}>
                    {it.name}（{it.minutes} 分钟）
                  </option>
                ))}
              </Select>
              <Select aria-label={`第 ${i + 1} 行技师`} value={r.technicianId ?? ''} onChange={(e) => patch(r.rid, { technicianId: e.target.value ? Number(e.target.value) : null })}>
                <option value="">不指定</option>
                {board.technicians.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.techNo} 号 {t.name}
                  </option>
                ))}
              </Select>
              <Input aria-label={`第 ${i + 1} 行时间`} type="time" step={60 * board.rules.slotMinutes} value={r.time} onChange={(e) => patch(r.rid, { time: e.target.value })} />
              <IconButton label={`删掉第 ${i + 1} 行`} disabled={rows.length <= 1} onClick={() => setRows((list) => list.filter((x) => x.rid !== r.rid))}>
                <X className="size-4" />
              </IconButton>
              {why && (
                <p className="col-span-full text-[12px] text-clay">
                  第 {i + 1} 行：{why}
                </p>
              )}
            </div>
          );
        })}
      </div>
      <Button
        className="mt-3"
        variant="secondary"
        icon={<Plus className="size-4" />}
        disabled={rows.length >= MAX_BATCH_BOOKINGS}
        onClick={() => setRows((list) => [...list, blank(list.at(-1)?.itemId ?? first, list.at(-1)?.time ?? '')])}
        data-testid="batch-booking-add"
      >
        再加一行{rows.length >= MAX_BATCH_BOOKINGS ? `（最多 ${MAX_BATCH_BOOKINGS} 行）` : ''}
      </Button>
      {op.state.phase === 'error' && <Notice tone="error" title={op.state.message} className="mt-4" />}
    </Dialog>
  );
}
