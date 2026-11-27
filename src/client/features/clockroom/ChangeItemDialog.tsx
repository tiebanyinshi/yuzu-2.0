// 换项目 / 换工种（8.2.2，docs/V8222_TECHNICIANS.md 第 4 节）：上钟不满规定分钟数（钟房规则，默认 15）可以换项目。
// 原技师能做新项目的照旧由他做（钟单改项目、排位不动）；做不了的（换工种）要另选技师，原技师回到派这一钟之前的排位。
// 原来的明细作废、按新项目挂一条；带操作编号、走「结果待确认」（与转钟同一套）。

import { useMemo, useState } from 'react';
import { tierPrice } from '@shared/catalog';
import type { BoardSession, BoardTechnician, ClockroomBoard } from '@shared/clockroom';
import { CALL_TYPE_LABELS, CALL_TYPE_OPTIONS, canServe, gradeLabel, tierFor, type CallType } from '@shared/technicians';
import { useCatalog } from '../../lib/queries';
import { useSession } from '../../lib/session';
import { cn } from '../../lib/utils';
import { Money } from '../../components/Money';
import { Dialog } from '../../components/Overlay';
import { QtyInput } from '../../components/QtyInput';
import { Button, Field, Input, Notice, Segmented, Select } from '../../components/ui';
import { PendingPanel, useFrontdeskOp } from '../frontdesk/pending';

const doneOnFound = (found: { found: true } | { found: false }) => (found.found && 'visit' in found ? true : null);
/** 能派钟的技师：在职、没停牌、当天在岗或暂离 */
const dispatchable = (t: BoardTechnician) => t.active && !t.suspendedAt && (t.state === 'on' || t.state === 'rest');

export function ChangeItemDialog({ session: s, board, onClose, onDone }: { session: BoardSession; board: ClockroomBoard; onClose: () => void; onDone: () => void }) {
  const me = useSession();
  const catalog = useCatalog();
  const [itemId, setItemId] = useState<number | null>(null);
  const [quantity, setQuantity] = useState(s.clocks);
  const [qtyHint, setQtyHint] = useState<string | null>(null);
  const [technicianId, setTechnicianId] = useState<number | null>(null);
  const [callType, setCallType] = useState<CallType>(s.callType);
  const [reason, setReason] = useState('');
  const op = useFrontdeskOp<true>({ type: 'bill_post', visitId: s.visitId, staffName: me.staff.displayName, pick: doneOnFound });
  const items = useMemo(() => (catalog.data?.items ?? []).filter((i) => i.active && i.technicianRequired && i.id !== s.itemId), [catalog.data, s.itemId]);
  const item = items.find((i) => i.id === itemId) ?? null;
  const shape = item ? { category: item.category, prices: item.prices } : null;
  const own = board.technicians.find((t) => t.id === s.technicianId) ?? null;
  // 原技师做不了新项目：换工种，要另选技师
  const ownCant = own && shape ? canServe(own, shape, board.techRules.tierByGrade) : null;
  const others = board.technicians
    .filter((t) => t.id !== s.technicianId && dispatchable(t) && shape && !canServe(t, shape, board.techRules.tierByGrade))
    .sort((a, b) => (a.position ?? 999) - (b.position ?? 999) || a.techNo.localeCompare(b.techNo));
  const tech = technicianId ? (board.technicians.find((t) => t.id === technicianId) ?? null) : ownCant ? null : own;
  const tier = item && tech ? tierFor(tech, item, item.prices[0]!.tier, board.techRules.tierByGrade) : null;
  const unit = item && tier ? tierPrice(item.prices, tier) : null;
  const total = unit !== null ? unit * quantity : 0;
  const minutesIn = s.startedAt ? Math.floor((Date.now() - Date.parse(s.startedAt)) / 60_000) : 0;
  const limit = board.rules.changeItemMinutes;
  const late = s.status === 'serving' && minutesIn >= limit;
  const problem = late
    ? `已上钟 ${minutesIn} 分钟，满 ${limit} 分钟不能换项目：要换请先退钟再重新派`
    : !item
      ? '请选换成哪个项目'
      : !tech
        ? `${s.techNo} 号${ownCant}，请选换给哪位技师（换工种）`
        : unit === null
          ? '这个项目没有这一档价格'
          : reason.trim().length < 2
            ? '请写换项目的原因（至少 2 个字）'
            : null;
  const changingTech = !!tech && tech.id !== s.technicianId;
  const submit = async () => {
    if (problem || !item || !tech) return;
    const ok = await op.submit((key) => ({
      url: `/api/clockroom/sessions/${s.id}/change`,
      body: {
        clientKey: key,
        itemId: item.id,
        tier: board.techRules.tierByGrade && item.prices.length > 1 ? undefined : (tier ?? undefined),
        quantity,
        ...(changingTech ? { technicianId: tech.id, callType } : {}),
        reason: reason.trim(),
        expectedTotal: total,
      },
      tagCodes: [s.tagCode],
      summary: `${changingTech ? '换工种' : '换项目'} ${s.itemName} → ${item.name} × ${quantity}（${tech.techNo} 号 ${tech.name}）`,
      amount: total,
    }));
    if (ok) onDone();
  };
  return (
    <Dialog
      open
      onClose={op.busy ? () => {} : onClose}
      width="max-w-2xl"
      title={`换项目 · ${s.techNo} 号 ${s.techName}`}
      description={`${s.tagCode} ${s.guest} · ${s.itemName} × ${s.clocks}。${s.status === 'serving' ? `上钟 ${minutesIn} 分钟（满 ${limit} 分钟不能换）。` : '还没上钟，随时可以换。'}原来的挂账作废、按新项目重挂；原技师做不了新项目的换人做，原技师回到原来的排位。`}
      footer={
        <>
          <span className="mr-auto self-center text-[13px] text-ink-3">{problem ? <span className="text-clay">{problem}</span> : <Money cents={total} className="font-bold text-ink" />}</span>
          <Button variant="ghost" onClick={onClose} disabled={op.busy}>
            取消
          </Button>
          <Button variant="primary" disabled={!!problem || op.locked} loading={op.busy} onClick={() => void submit()} data-testid="change-submit">
            确认换项目
          </Button>
        </>
      }
    >
      <PendingPanel op={op} onResolved={() => onDone()} />
      <div className="space-y-3">
        <Field label="换成" htmlFor="change-item">
          <Select
            id="change-item"
            value={itemId ?? ''}
            onChange={(e) => {
              setItemId(e.target.value ? Number(e.target.value) : null);
              setTechnicianId(null);
            }}
            data-testid="change-item"
          >
            <option value="">选项目</option>
            {items.map((i) => (
              <option key={i.id} value={i.id}>
                {i.category ? `${i.category} · ` : ''}
                {i.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="钟数" hint={qtyHint ?? undefined}>
          <QtyInput value={quantity} min={1} max={9} onChange={setQuantity} onHint={setQtyHint} label="换项目的钟数" className="w-20" />
        </Field>
        {item && (ownCant || technicianId !== null) && (
          <>
            {ownCant && <Notice tone="info" title={`${s.techNo} 号${ownCant}：换工种，请选一位能做的技师；${s.techNo} 号回到原来的排位`} />}
            <Field label="上钟方式">
              <Segmented ariaLabel="上钟方式" value={callType} onChange={setCallType} options={CALL_TYPE_OPTIONS.map((c) => ({ value: c, label: CALL_TYPE_LABELS[c] }))} />
            </Field>
            <Field label="换给">
              {others.length === 0 ? (
                <p className="rounded-lg border border-dashed border-line-strong px-3 py-4 text-center text-[13px] text-ink-3">没有能做这个项目、已上牌的技师</p>
              ) : (
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-3" data-testid="change-techs">
                  {others.map((t) => (
                    <button
                      key={t.id}
                      type="button"
                      onClick={() => setTechnicianId(t.id)}
                      className={cn('flex flex-col rounded-lg border px-3 py-2 text-left', technicianId === t.id ? 'border-pine bg-pine-tint' : 'border-line bg-card hover:border-line-strong')}
                      data-testid={`change-tech-${t.techNo}`}
                    >
                      <span className="flex items-baseline gap-1.5">
                        <span className="num text-[16px] font-bold">{t.techNo}</span>
                        <span className="min-w-0 truncate font-bold">{t.name}</span>
                      </span>
                      <span className="text-[12px] text-ink-3">
                        {gradeLabel(t.grade)} · {t.busy ? '在钟上' : t.position ? `第 ${t.position} 位` : '暂离'}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </Field>
          </>
        )}
        {item && !ownCant && technicianId === null && others.length > 0 && (
          <button type="button" className="text-[13px] font-semibold text-pine underline-offset-2 hover:underline" onClick={() => setTechnicianId(others[0]!.id)}>
            要换别的技师做（换工种）
          </button>
        )}
        <Field label="原因" htmlFor="change-reason" hint="记进钟房日志与作废原因">
          <Input id="change-reason" value={reason} maxLength={100} placeholder="例如：客人要换成采耳" onChange={(e) => setReason(e.target.value)} data-testid="change-reason" />
        </Field>
      </div>
      {op.state.phase === 'error' && <Notice tone="error" title={op.state.message} className="mt-4" />}
    </Dialog>
  );
}
