// 福田店整改（2026-11-26，docs/FUTIAN_1126.md）房态中心新加的三个动作：
//   FT-09 撤房——开房后限时内（后台设，默认 15 分钟）撤掉误开的房，不收费、房间回到空闲，留操作记录；
//   FT-06 换技师——上钟后限时内（默认 15 分钟）把钟换给另一位技师（就是钟房的转钟，业绩与时间以系统记录为准）；
//   FT-19 补单——事后补录漏开的单或手工单，关联这间房与实际时间，单据记「补单」，照常计入技师业绩。

import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { PRICE_TIER_LABELS, tierPrice, type PriceTier } from '@shared/catalog';
import type { ClockroomBoard } from '@shared/clockroom';
import { BACKFILL_WINDOW_HOURS } from '@shared/backfill';
import { formatYuan } from '@shared/money';
import { ROOM_SERVICE_EXCLUDED_CATEGORIES } from '@shared/price-catalog';
import { MAX_ROOM_NOTE, MAX_SELLER_NO, type RoomCard, type RoomCenterBoard, type RoomGuestLookup, type RoomSessionView } from '@shared/room-center';
import { minutesLeft } from '@shared/room-center-rules';
import { spaceLabel } from '@shared/spaces';
import { CALL_TYPE_LABELS, canServe, gradeLabel, tierFor, type CallType } from '@shared/technicians';
import { api } from '../../lib/api';
import { useCatalog } from '../../lib/queries';
import { serverNowMs } from '../../lib/serverClock';
import { useSession } from '../../lib/session';
import { cn } from '../../lib/utils';
import { LoadFailed } from '../../components/LoadFailed';
import { Money } from '../../components/Money';
import { Dialog } from '../../components/Overlay';
import { useToast } from '../../components/Toast';
import { Button, Field, Input, Notice, Segmented, Skeleton } from '../../components/ui';
import { TransferDialog } from '../clockroom/DispatchDialog';
import { PendingPanel, useFrontdeskOp } from '../frontdesk/pending';
import { ItemPicker } from './ItemPicker';
import { clockroomKey, roomUrl, useRoomAction } from './queries';
import { DUAL_LABELS, foundPosted } from './RegisterDialog';
import { RoomActionStatus } from './RoomActions';
import { TagField } from './TagField';

export type RoomLimits = RoomCenterBoard['limits'];

/** 撤房还剩几分钟（0 = 不能撤）：每位登记了的客人都在时限内、没有已经下钟的钟 */
export function revokeLeft(room: RoomCard, limits: RoomLimits, now: number): number {
  const regs = room.guests.filter((g) => g.registrationId !== null);
  if (room.kind !== 'service' || regs.length === 0 || limits.revokeMinutes <= 0) return 0;
  if (regs.some((g) => g.sessions.some((s) => s.status === 'done'))) return 0;
  return Math.min(...regs.map((g) => minutesLeft(g.since, limits.revokeMinutes, now)));
}

/** 换技师还剩几分钟（0 = 不能换）：待上钟的一直能换；在钟上的按上钟时刻算 */
export function swapLeft(s: RoomSessionView, limits: RoomLimits, now: number): number {
  if (limits.swapTechMinutes <= 0 || s.status === 'done') return 0;
  if (s.status === 'waiting') return limits.swapTechMinutes;
  return minutesLeft(s.startedAt, limits.swapTechMinutes, now);
}

/** FT-09 撤房：写原因；这次登记的明细全部作废（不收费），钟单取消，房间回到空闲 */
export function RevokeRoomDialog({ room, limits, onClose, onDone }: { room: RoomCard; limits: RoomLimits; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const act = useRoomAction(room, 'space_dispatch');
  const [reason, setReason] = useState('');
  const left = revokeLeft(room, limits, serverNowMs());
  const regs = room.guests.filter((g) => g.registrationId !== null);
  const amount = regs.reduce((n, g) => n + g.amount, 0);
  const problem = left <= 0 ? `开房已经超过 ${limits.revokeMinutes} 分钟（或已有钟下钟），不能撤房，请按正常流程退房` : reason.trim().length < 2 ? '请填写撤房原因（至少 2 个字）' : null;
  const submit = async () => {
    if (problem) return;
    const ok = await act.run('revoke', { expectedVersion: room.version, reason: reason.trim() }, `撤房 ${room.code}（手牌 ${regs.map((g) => g.tagCode).join('、')}，${reason.trim()}）`);
    if (!ok) return;
    toast({ tone: 'success', title: `${room.code} 已撤房`, body: `不收费：${formatYuan(amount)} 的明细已作废，房间回到空闲` });
    onDone();
  };
  return (
    <Dialog
      open
      onClose={act.busy ? () => {} : onClose}
      width="max-w-lg"
      title={`撤房 · ${spaceLabel(room.code, room.name)}`}
      description={`误开的房，开房后 ${limits.revokeMinutes} 分钟内可以撤：不收费，这次登记的明细全部作废、钟单取消（技师按规则回到原位），房间直接回到空闲（不转待清），操作留记录。`}
      footer={
        <>
          <span className="mr-auto self-center text-[13px] text-clay">{problem}</span>
          <Button variant="ghost" onClick={onClose} disabled={act.busy}>
            取消
          </Button>
          <Button variant="danger" disabled={!!problem || act.locked} loading={act.busy} onClick={() => void submit()} data-testid="rc-revoke-submit">
            确认撤房
          </Button>
        </>
      }
    >
      <div className="space-y-4" data-testid="rc-revoke">
        <RoomActionStatus action={act} room={room} onResolved={onDone} />
        <Notice tone={left > 0 ? 'info' : 'warning'} title={left > 0 ? `还剩 ${left} 分钟可以撤房` : '已经过了撤房时限'} data-testid="rc-revoke-left">
          {regs.map((g) => `手牌 ${g.tagCode} ${g.guest}`).join('；')} · 作废 <b className="num">{formatYuan(amount)}</b>
        </Notice>
        <Field label="撤房原因" htmlFor="rc-revoke-reason" hint="例如：开错房间、客人临时不做了">
          <Input id="rc-revoke-reason" value={reason} maxLength={100} onChange={(e) => setReason(e.target.value)} disabled={act.locked} data-autofocus data-testid="rc-revoke-reason" />
        </Field>
      </div>
    </Dialog>
  );
}

/** FT-06 换技师：用钟房的转钟对话框，走房间的接口（服务端核对限时） */
export function SwapTechDialog({ room, session: s, limits, onClose, onDone }: { room: RoomCard; session: RoomSessionView; limits: RoomLimits; onClose: () => void; onDone: () => void }) {
  const clock = useQuery({ queryKey: clockroomKey, queryFn: () => api.get<ClockroomBoard>('/api/clockroom') });
  const board = clock.data;
  const bs = board?.sessions.find((x) => x.id === s.id);
  const left = swapLeft(s, limits, serverNowMs());
  if (!board || !bs) {
    return (
      <Dialog open onClose={onClose} width="max-w-lg" title={`换技师 · ${s.techNo} 号 ${s.techName}`}>
        {clock.isError ? (
          <LoadFailed title="钟房没取回来" onRetry={() => void clock.refetch()} retrying={clock.isFetching} />
        ) : board ? (
          <Notice tone="warning" title="这张钟单已经不在钟房的看板上（可能刚下钟或被转走），请刷新" />
        ) : (
          <Skeleton className="h-40" />
        )}
      </Dialog>
    );
  }
  return (
    <TransferDialog
      session={bs}
      board={board}
      onClose={onClose}
      onDone={onDone}
      room={{
        spaceId: room.spaceId!,
        code: room.code,
        limitText:
          s.status === 'waiting' ? '还没上钟，可以换' : left > 0 ? `上钟后 ${limits.swapTechMinutes} 分钟内可以换，还剩 ${left} 分钟` : `已经上钟超过 ${limits.swapTechMinutes} 分钟，不能再换`,
      }}
    />
  );
}

const pad = (n: number) => String(n).padStart(2, '0');
/** datetime-local 输入框的值（本机时间） */
const localInput = (ms: number) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

/**
 * FT-19 补单：给还在店的客人补录漏开的单（或手工单）——手牌、项目、技师、实际开始时间、出单员；挂到手牌账单上，钟单直接记为已下钟，
 * 不动技师排位、不占房；单据记「补单」（有手工单号的写上）。要「按实际时间补录纸质单」权限（值班经理及以上），48 小时以内。
 */
export function BackfillRoomDialog({ room, onClose, onDone }: { room: RoomCard; onClose: () => void; onDone: (board: RoomCenterBoard | null) => void }) {
  const session = useSession();
  const catalog = useCatalog();
  const clock = useQuery({ queryKey: clockroomKey, queryFn: () => api.get<ClockroomBoard>('/api/clockroom') });
  const [tag, setTag] = useState('');
  const [guest, setGuest] = useState<RoomGuestLookup | null>(null);
  const [itemId, setItemId] = useState<number | null>(null);
  const [tier, setTier] = useState<PriceTier | null>(null);
  const [callType, setCallType] = useState<CallType>('rotation');
  const [techNo, setTechNo] = useState('');
  const [sellerNo, setSellerNo] = useState(session.staff.username);
  const [slipNo, setSlipNo] = useState('');
  const [startedAt, setStartedAt] = useState(() => localInput(serverNowMs() - 60 * 60_000));
  const [note, setNote] = useState('');
  const op = useFrontdeskOp<RoomCenterBoard | true>({ type: 'bill_post', visitId: guest?.visitId ?? null, staffName: session.staff.displayName, pick: foundPosted });
  const board = clock.data;
  const rules = board?.techRules;
  const items = useMemo(
    () =>
      (catalog.data?.items ?? []).filter(
        (i) => i.active && i.technicianRequired && (!i.gender || !guest || i.gender === guest.zone) && !ROOM_SERVICE_EXCLUDED_CATEGORIES.includes(i.catalogCategory?.code ?? ''),
      ),
    [catalog.data, guest],
  );
  const item = items.find((i) => i.id === itemId) ?? null;
  // 补单按当时做的技师补：在职的都能选（不看现在是不是上牌、在不在钟上）
  const tech = (board?.technicians ?? []).find((t) => t.active && t.techNo === techNo.trim()) ?? null;
  const byGrade = !!rules?.tierByGrade && !!item && item.prices.length > 1;
  const chosenTier: PriceTier | null = item ? (tech && rules ? tierFor(tech, item, tier ?? item.prices[0]!.tier, rules.tierByGrade) : (tier ?? item.prices[0]!.tier)) : null;
  const unit = item && chosenTier ? tierPrice(item.prices, chosenTier) : null;
  const at = new Date(startedAt);
  const now = serverNowMs();
  const cant = tech && item && rules ? canServe(tech, item, rules.tierByGrade) : null;
  const problem = !guest
    ? '请输入在店客人的手牌号'
    : !item
      ? '请选择项目'
      : !tech
        ? techNo.trim()
          ? `没有在职的 ${techNo.trim()} 号技师`
          : '请填写技师号'
        : cant
          ? `${tech.techNo} 号${cant}`
          : unit === null
            ? '这个项目没有这一档价格'
            : Number.isNaN(at.getTime())
              ? '请填写实际开始时间'
              : at.getTime() > now + 60_000
                ? '实际开始时间不能晚于现在'
                : now - at.getTime() > BACKFILL_WINDOW_HOURS * 3_600_000
                  ? `只能补 ${BACKFILL_WINDOW_HOURS} 小时以内的单`
                  : !sellerNo.trim()
                    ? '请填写出单员的工号'
                    : null;
  const submit = async () => {
    if (problem || !guest || !item || !tech || unit === null) return;
    const done = await op.submit((key) => ({
      url: roomUrl(room.spaceId!, 'backfill'),
      body: {
        clientKey: key,
        tagCode: guest.tagCode,
        itemId: item.id,
        tier: byGrade ? undefined : (chosenTier ?? undefined),
        quantity: 1,
        technicianId: tech.id,
        callType,
        sellerNo: sellerNo.trim(),
        slipNo: slipNo.trim(),
        startedAt: at.toISOString(),
        note: note.trim(),
        expectedTotal: unit,
      },
      tagCodes: [guest.tagCode],
      summary: `补单 ${spaceLabel(room.code, room.name)}：${item.name}（${tech.techNo} 号 ${tech.name} · ${CALL_TYPE_LABELS[callType]}）${slipNo.trim() ? ` 手工单 ${slipNo.trim()}` : ''}`,
      amount: unit,
    }));
    if (done) onDone(done === true ? null : done);
  };
  return (
    <Dialog
      open
      onClose={op.busy ? () => {} : onClose}
      width="max-w-3xl"
      title={`补单 · ${spaceLabel(room.code, room.name)}`}
      description={`事后补录漏开的单或手工单：挂到客人的手牌账单上，关联这间房与实际时间，单据记「补单」，照常计入技师业绩。钟单直接记为已做完，不动技师排位、不占房。只补 ${BACKFILL_WINDOW_HOURS} 小时以内、客人还在店的。`}
      footer={
        <>
          <span className="mr-auto self-center text-[13px] text-ink-3" data-testid="rc-backfill-total">
            {problem ? (
              <span className="text-clay">{problem}</span>
            ) : (
              <>
                补单金额 <Money cents={unit!} className="text-[18px] font-bold text-ink" />
              </>
            )}
          </span>
          <Button variant="ghost" onClick={onClose} disabled={op.busy}>
            取消
          </Button>
          <Button variant="primary" disabled={!!problem || op.locked} loading={op.busy} onClick={() => void submit()} data-testid="rc-backfill-submit">
            确认补单
          </Button>
        </>
      }
    >
      <PendingPanel op={op} onResolved={(r) => onDone(r === true ? null : r)} />
      {clock.isError && !board ? (
        <LoadFailed title="技师没取回来" onRetry={() => void clock.refetch()} retrying={clock.isFetching} />
      ) : !board || !catalog.data ? (
        <Skeleton className="h-72" />
      ) : (
        <div className="grid gap-5 md:grid-cols-[250px_minmax(0,1fr)]" data-testid="rc-backfill">
          <div className="space-y-4">
            <TagField value={tag} onChange={setTag} onGuest={setGuest} disabled={op.locked} />
            <Field label="实际开始时间" htmlFor="rc-backfill-at" hint="手工单上的时间；业绩按这个时间归到当天">
              <Input id="rc-backfill-at" type="datetime-local" value={startedAt} onChange={(e) => setStartedAt(e.target.value)} disabled={op.locked} data-testid="rc-backfill-at" />
            </Field>
            <Field label="手工单号" htmlFor="rc-backfill-slip" hint="选填；不填记成「补单」">
              <Input
                id="rc-backfill-slip"
                value={slipNo}
                maxLength={32}
                onChange={(e) => setSlipNo(e.target.value.replace(/[^0-9A-Za-z-]/g, ''))}
                disabled={op.locked}
                data-testid="rc-backfill-slip"
              />
            </Field>
            <Field label="出单员工号" htmlFor="rc-backfill-seller">
              <Input id="rc-backfill-seller" value={sellerNo} maxLength={MAX_SELLER_NO} onChange={(e) => setSellerNo(e.target.value)} disabled={op.locked} data-testid="rc-backfill-seller" />
            </Field>
            <Field label="备注" htmlFor="rc-backfill-note" hint="选填，例如漏开的原因">
              <Input id="rc-backfill-note" value={note} maxLength={MAX_ROOM_NOTE} onChange={(e) => setNote(e.target.value)} disabled={op.locked} data-testid="rc-backfill-note" />
            </Field>
          </div>
          <div className="min-w-0 space-y-4">
            <Field label="项目">
              <ItemPicker
                items={items}
                value={itemId}
                onChange={(i) => {
                  setItemId(i.id);
                  setTier(null);
                }}
                disabled={op.locked}
                testId="rc-backfill"
              />
            </Field>
            {item && item.prices.length > 1 && !byGrade && (
              <Field label="档次">
                <Segmented<PriceTier>
                  ariaLabel="档次"
                  value={tier ?? item.prices[0]!.tier}
                  onChange={setTier}
                  options={item.prices.map((p) => ({ value: p.tier, label: `${item.catalogCategory ? DUAL_LABELS[p.tier] : PRICE_TIER_LABELS[p.tier]} ${formatYuan(p.price)}` }))}
                />
              </Field>
            )}
            <Field
              label="技师"
              aside={
                <Segmented<CallType>
                  size="sm"
                  ariaLabel="上钟方式"
                  value={callType}
                  onChange={setCallType}
                  options={[
                    { value: 'rotation', label: CALL_TYPE_LABELS.rotation },
                    { value: 'designated', label: CALL_TYPE_LABELS.designated },
                    { value: 'call', label: CALL_TYPE_LABELS.call },
                  ]}
                />
              }
              hint={tech ? `${tech.techNo} 号 ${tech.name} · ${gradeLabel(tech.grade)}` : '填当时做的技师号'}
            >
              <Input
                className={cn('w-32', cant && 'border-clay')}
                fullWidth={false}
                inputMode="numeric"
                value={techNo}
                maxLength={8}
                onChange={(e) => setTechNo(e.target.value.trim())}
                placeholder="技师号"
                aria-label="技师号"
                disabled={op.locked}
                data-testid="rc-backfill-techno"
              />
            </Field>
          </div>
        </div>
      )}
      {op.state.phase === 'error' && <Notice tone="error" title={op.state.message} className="mt-4" data-testid="rc-backfill-error" />}
    </Dialog>
  );
}
