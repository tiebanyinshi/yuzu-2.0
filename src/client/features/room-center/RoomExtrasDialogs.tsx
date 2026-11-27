// 福田店整改批次 4（2026-11-26，docs/FUTIAN_1126.md）房态中心的几个新动作：
//   FT-14 加项目——房里已登记的客人同时再做一个项目（另一位技师、另一张钟单，各自计费与业绩）；
//   FT-17 零售与杂项——香烟、扑克等零售商品与清洁费等杂项挂到房里客人的手牌上（手动金额要权限）；
//   FT-18 虫洞——下单三步（手牌、性别、虫洞号；费用按后台设的），有人的点「离开」。
// 挂账的都走「结果待确认」（与登记同一套）；离开是房间调度那一类的操作编号。

import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { PRICE_TIER_LABELS, tierPrice, type PriceTier } from '@shared/catalog';
import type { ClockroomBoard } from '@shared/clockroom';
import { formatYuan, parseYuan } from '@shared/money';
import { ROOM_SERVICE_EXCLUDED_CATEGORIES } from '@shared/price-catalog';
import type { RoomCard, RoomCenterBoard, RoomGuestLookup, RoomGuestView } from '@shared/room-center';
import { spaceLabel } from '@shared/spaces';
import { CALL_TYPE_LABELS, canServe, gradeLabel, tierFor, type CallType } from '@shared/technicians';
import { api } from '../../lib/api';
import { useCatalog } from '../../lib/queries';
import { useCan, useSession } from '../../lib/session';
import { LoadFailed } from '../../components/LoadFailed';
import { Money } from '../../components/Money';
import { Dialog } from '../../components/Overlay';
import { QtyInput } from '../../components/QtyInput';
import { useToast } from '../../components/Toast';
import { Button, Field, Input, MoneyInput, Notice, Segmented, Skeleton } from '../../components/ui';
import { PendingPanel, useFrontdeskOp } from '../frontdesk/pending';
import { ItemPicker } from './ItemPicker';
import { clockroomKey, roomUrl, useRoomAction } from './queries';
import { DUAL_LABELS, foundPosted } from './RegisterDialog';
import { RoomActionStatus } from './RoomActions';
import { TagField } from './TagField';

const label = (room: RoomCard) => spaceLabel(room.code, room.name);

/** 房里的客人（选挂给谁）：一位就直接是他 */
/** 康美部看到的客人只有手牌号（名字就是「手牌 X」），不重复写 */
const guestLabel = (g: RoomGuestView, sep: string) => (g.guest === `手牌 ${g.tagCode}` ? `手牌 ${g.tagCode}` : `${g.tagCode}${sep}${g.guest}`);

function GuestPick({ guests, value, onChange, disabled }: { guests: RoomGuestView[]; value: number | null; onChange: (v: number) => void; disabled?: boolean }) {
  if (guests.length <= 1) return <p className="text-[14px] font-semibold text-ink">{guests[0] ? `手牌 ${guestLabel(guests[0], ' · ').replace(/^手牌 /, '')}` : '这间房没有客人'}</p>;
  return (
    <Segmented<string>
      ariaLabel="挂给哪位客人"
      value={value === null ? '' : String(value)}
      onChange={(v) => onChange(Number(v))}
      options={guests.map((g) => ({ value: String(g.visitId), label: guestLabel(g, ' '), disabled }))}
    />
  );
}

/** FT-14 加项目：同一位客人在这间房里同时再做一个项目（另一位技师），挂账 + 派钟一步做完 */
export function AddItemDialog({ room, onClose, onDone }: { room: RoomCard; onClose: () => void; onDone: (board: RoomCenterBoard | null) => void }) {
  const session = useSession();
  const catalog = useCatalog();
  const clock = useQuery({ queryKey: clockroomKey, queryFn: () => api.get<ClockroomBoard>('/api/clockroom') });
  const guests = room.guests.filter((g) => g.registrationId !== null);
  const [visitId, setVisitId] = useState<number | null>(guests[0]?.visitId ?? null);
  const [itemId, setItemId] = useState<number | null>(null);
  const [tier, setTier] = useState<PriceTier | null>(null);
  const [callType, setCallType] = useState<CallType>('designated');
  const [techNo, setTechNo] = useState('');
  const op = useFrontdeskOp<RoomCenterBoard | true>({ type: 'bill_post', visitId, staffName: session.staff.displayName, pick: foundPosted });
  const guest = guests.find((g) => g.visitId === visitId) ?? null;
  const board = clock.data;
  const items = useMemo(() => (catalog.data?.items ?? []).filter((i) => i.active && i.technicianRequired && !ROOM_SERVICE_EXCLUDED_CATEGORIES.includes(i.catalogCategory?.code ?? '')), [catalog.data]);
  const item = items.find((i) => i.id === itemId) ?? null;
  const tech = (board?.technicians ?? []).find((t) => t.techNo === techNo.trim() && t.active && !t.suspendedAt && (t.state === 'on' || t.state === 'rest')) ?? null;
  const byGrade = !!board?.techRules.tierByGrade && !!item && item.prices.length > 1;
  const chosenTier: PriceTier | null = item ? (tech && board ? tierFor(tech, item, tier ?? item.prices[0]!.tier, board.techRules.tierByGrade) : (tier ?? item.prices[0]!.tier)) : null;
  const unit = item && chosenTier ? tierPrice(item.prices, chosenTier) : null;
  const cant = tech && item && board ? canServe(tech, item, board.techRules.tierByGrade) : null;
  const busyElsewhere = guest?.sessions.some((s) => s.status !== 'done' && s.techNo === tech?.techNo);
  const problem = !guest
    ? '这间房没有登记的客人'
    : !item
      ? '请选择项目'
      : !tech
        ? techNo.trim()
          ? `没有上牌的 ${techNo.trim()} 号技师`
          : '请填写技师号'
        : busyElsewhere
          ? `${tech.techNo} 号已经在给这位客人做了，换一位技师（同一位技师接着做请用「加钟」）`
          : cant
            ? `${tech.techNo} 号${cant}`
            : unit === null
              ? '这个项目没有这一档价格'
              : null;
  const submit = async () => {
    if (problem || !guest || !item || !tech || unit === null) return;
    const r = await op.submit((key) => ({
      url: roomUrl(room.spaceId!, 'add-item'),
      body: { clientKey: key, visitId: guest.visitId, itemId: item.id, tier: byGrade ? undefined : (chosenTier ?? undefined), technicianId: tech.id, callType, expectedTotal: unit },
      tagCodes: [guest.tagCode],
      summary: `加项目 ${label(room)}：${item.name}（${tech.techNo} 号 ${tech.name} · ${CALL_TYPE_LABELS[callType]}）`,
      amount: unit,
    }));
    if (r) onDone(r === true ? null : r);
  };
  return (
    <Dialog
      open
      onClose={op.busy ? () => {} : onClose}
      width="max-w-2xl"
      title={`加项目 · ${label(room)}`}
      description="这位客人在这间房里同时再做一个项目：另一位技师、另一张钟单，与原来的钟一起进行，各自计费、各自算业绩。同一位技师接着做请用钟单上的「加钟」。"
      footer={
        <>
          <span className="mr-auto self-center text-[13px] text-ink-3" data-testid="rc-additem-total">
            {problem ? <span className="text-clay">{problem}</span> : <Money cents={unit!} className="text-[18px] font-bold text-ink" />}
          </span>
          <Button variant="ghost" onClick={onClose} disabled={op.busy}>
            取消
          </Button>
          <Button variant="primary" disabled={!!problem || op.locked} loading={op.busy} onClick={() => void submit()} data-testid="rc-additem-submit">
            加项目并上钟
          </Button>
        </>
      }
    >
      <PendingPanel op={op} onResolved={(r) => onDone(r === true ? null : r)} />
      {clock.isError && !board ? (
        <LoadFailed title="技师没取回来" onRetry={() => void clock.refetch()} retrying={clock.isFetching} />
      ) : !board || !catalog.data ? (
        <Skeleton className="h-60" />
      ) : (
        <div className="space-y-4" data-testid="rc-additem">
          <Field label="客人">
            <GuestPick guests={guests} value={visitId} onChange={setVisitId} disabled={op.locked} />
          </Field>
          <Field label="项目">
            <ItemPicker
              items={items}
              value={itemId}
              onChange={(i) => {
                setItemId(i.id);
                setTier(null);
              }}
              disabled={op.locked}
              testId="rc-additem"
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
            hint={tech ? `${tech.techNo} 号 ${tech.name} · ${gradeLabel(tech.grade)}${tech.busy ? '（在别的钟上，要等钟）' : ''}` : '填技师号'}
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
          >
            <Input
              className="w-32"
              fullWidth={false}
              inputMode="numeric"
              value={techNo}
              maxLength={8}
              onChange={(e) => setTechNo(e.target.value.trim())}
              placeholder="技师号"
              aria-label="技师号"
              disabled={op.locked}
              data-testid="rc-additem-techno"
            />
          </Field>
        </div>
      )}
      {op.state.phase === 'error' && <Notice tone="error" title={op.state.message} className="mt-4" />}
    </Dialog>
  );
}

/** FT-17 零售与杂项：后台设的几个分类里的项目（输编号即选），数量；手动金额的杂项要「手动输入金额」权限 */
export function GoodsDialog({ room, categories, onClose, onDone }: { room: RoomCard; categories: string[]; onClose: () => void; onDone: (board: RoomCenterBoard | null) => void }) {
  const session = useSession();
  const can = useCan();
  const catalog = useCatalog();
  const [visitId, setVisitId] = useState<number | null>(room.guests[0]?.visitId ?? null);
  const [cart, setCart] = useState<{ itemId: number; quantity: number }[]>([]);
  const [customName, setCustomName] = useState('');
  const [customAmount, setCustomAmount] = useState('');
  const op = useFrontdeskOp<RoomCenterBoard | true>({ type: 'bill_post', visitId, staffName: session.staff.displayName, pick: foundPosted });
  const items = useMemo(() => (catalog.data?.items ?? []).filter((i) => i.active && !i.technicianRequired && categories.includes(i.category)), [catalog.data, categories]);
  const guest = room.guests.find((g) => g.visitId === visitId) ?? null;
  const custom = customName.trim() && customAmount.trim() ? { name: customName.trim(), amount: parseYuan(customAmount) } : null;
  const total = cart.reduce((n, l) => n + (items.find((i) => i.id === l.itemId)?.price ?? 0) * l.quantity, 0) + (custom?.amount ?? 0);
  const canCustom = can('consume.customAmount');
  const problem = !guest ? '这间房没有客人' : custom && !custom.amount ? '杂项金额格式不对' : cart.length === 0 && !custom ? '请选商品或填杂项' : null;
  const add = (itemId: number) =>
    setCart((c) => (c.some((l) => l.itemId === itemId) ? c.map((l) => (l.itemId === itemId ? { ...l, quantity: Math.min(99, l.quantity + 1) } : l)) : [...c, { itemId, quantity: 1 }]));
  const submit = async () => {
    if (problem || !guest) return;
    const names = [...cart.map((l) => `${items.find((i) => i.id === l.itemId)?.name ?? ''} × ${l.quantity}`), ...(custom ? [`${custom.name} ${formatYuan(custom.amount!)}`] : [])];
    const r = await op.submit((key) => ({
      url: roomUrl(room.spaceId!, 'goods'),
      body: { clientKey: key, visitId: guest.visitId, lines: cart, customLines: custom ? [{ name: custom.name, amount: custom.amount }] : [], expectedTotal: total },
      tagCodes: [guest.tagCode],
      summary: `零售 / 杂项 ${label(room)}：${names.join('、')}`,
      amount: total,
    }));
    if (r) onDone(r === true ? null : r);
  };
  return (
    <Dialog
      open
      onClose={op.busy ? () => {} : onClose}
      width="max-w-2xl"
      title={`零售 / 杂项 · ${label(room)}`}
      description={`挂到客人的手牌账单上，离店时在收银台一起结。能挂的是后台设的分类：${categories.join('、') || '（还没设）'}。`}
      footer={
        <>
          <span className="mr-auto self-center text-[13px] text-ink-3" data-testid="rc-goods-total">
            {problem ? <span className="text-clay">{problem}</span> : <Money cents={total} className="text-[18px] font-bold text-ink" />}
          </span>
          <Button variant="ghost" onClick={onClose} disabled={op.busy}>
            取消
          </Button>
          <Button variant="primary" disabled={!!problem || op.locked} loading={op.busy} onClick={() => void submit()} data-testid="rc-goods-submit">
            挂到手牌上
          </Button>
        </>
      }
    >
      <PendingPanel op={op} onResolved={(r) => onDone(r === true ? null : r)} />
      {!catalog.data ? (
        <Skeleton className="h-48" />
      ) : (
        <div className="space-y-4" data-testid="rc-goods">
          <Field label="客人">
            <GuestPick guests={room.guests} value={visitId} onChange={setVisitId} disabled={op.locked} />
          </Field>
          <Field label="商品 / 杂项">
            {items.length ? (
              <ItemPicker items={items} value={null} onChange={(i) => add(i.id)} disabled={op.locked} testId="rc-goods" />
            ) : (
              <p className="text-[13px] text-ink-3">没有能挂的项目：店主在后台价目里建好（分类写「{categories[0] ?? '零售'}」），或在「房态中心规则」里改能挂的分类</p>
            )}
          </Field>
          {cart.length > 0 && (
            <ul className="divide-y divide-line/70 rounded-lg border border-line" data-testid="rc-goods-cart">
              {cart.map((l) => {
                const i = items.find((x) => x.id === l.itemId)!;
                return (
                  <li key={l.itemId} className="flex items-center gap-2 px-3 py-2 text-[13.5px]" data-testid={`rc-goods-line-${i.name}`}>
                    <span className="min-w-0 flex-1 truncate font-semibold">{i.name}</span>
                    <QtyInput value={l.quantity} onChange={(q) => setCart((c) => c.map((x) => (x.itemId === l.itemId ? { ...x, quantity: q } : x)))} label={`${i.name}数量`} />
                    <Money cents={i.price * l.quantity} className="w-20 text-right font-bold" />
                    <Button size="sm" variant="ghost" onClick={() => setCart((c) => c.filter((x) => x.itemId !== l.itemId))}>
                      删
                    </Button>
                  </li>
                );
              })}
            </ul>
          )}
          {canCustom && (
            <Field label="手动金额的杂项（选填）" hint="例如按实际收的清洁费、损坏赔偿">
              <div className="flex gap-2">
                <Input value={customName} maxLength={32} onChange={(e) => setCustomName(e.target.value)} placeholder="名称" aria-label="杂项名称" data-testid="rc-goods-custom-name" />
                <MoneyInput value={customAmount} onChange={(e) => setCustomAmount(e.target.value)} placeholder="金额" aria-label="杂项金额" data-testid="rc-goods-custom-amount" />
              </div>
            </Field>
          )}
        </div>
      )}
      {op.state.phase === 'error' && <Notice tone="error" title={op.state.message} className="mt-4" />}
    </Dialog>
  );
}

/** FT-18 虫洞：没人的——下单三步（手牌、性别、这个虫洞，费用按后台设的）；有人的——离开 */
export function WormholeDialog({ room, fee, onClose, onDone }: { room: RoomCard; fee: RoomCenterBoard['wormholeFee']; onClose: () => void; onDone: (board: RoomCenterBoard | null) => void }) {
  const session = useSession();
  const toast = useToast();
  const [tag, setTag] = useState('');
  const [guest, setGuest] = useState<RoomGuestLookup | null>(null);
  const [gender, setGender] = useState<'male' | 'female' | null>(null);
  const op = useFrontdeskOp<RoomCenterBoard | true>({ type: 'bill_post', visitId: guest?.visitId ?? null, staffName: session.staff.displayName, pick: foundPosted });
  const leave = useRoomAction(room, 'space_dispatch');
  const stay = room.wormhole?.stay ?? null;
  const g = gender ?? (guest ? (guest.zone === 'female' ? 'female' : 'male') : null);
  const price = fee?.price ?? 0;
  if (stay) {
    const out = async () => {
      if (await leave.run('wormhole-leave', { expectedVersion: room.version }, `虫洞 ${room.code} 离开（手牌 ${stay.tagCode}）`)) {
        toast({ tone: 'success', title: `${room.code} 已空出来` });
        onClose();
      }
    };
    return (
      <Dialog
        open
        onClose={leave.busy ? () => {} : onClose}
        width="max-w-md"
        title={`虫洞 · ${label(room)}`}
        footer={
          <>
            <Button variant="ghost" onClick={onClose} disabled={leave.busy}>
              取消
            </Button>
            <Button variant="primary" disabled={leave.locked} loading={leave.busy} onClick={() => void out()} data-testid="rc-wormhole-leave">
              客人离开
            </Button>
          </>
        }
      >
        <RoomActionStatus action={leave} room={room} onResolved={onClose} />
        <p className="text-[15px] font-bold" data-testid="rc-wormhole-stay">
          手牌 {stay.tagCode} · {stay.gender === 'female' ? '女' : '男'}
        </p>
        <p className="text-[13px] text-ink-3">费用照收（已挂在手牌上）；离开以后这个虫洞马上空出来，清洁时段里是待清。</p>
      </Dialog>
    );
  }
  const problem = !guest ? '请输入在店客人的手牌号' : guest.registeredIn ? null : !g ? '请选性别' : null;
  const submit = async () => {
    if (problem || !guest || !g) return;
    const r = await op.submit((key) => ({
      url: roomUrl(room.spaceId!, 'wormhole'),
      body: { clientKey: key, tagCode: guest.tagCode, gender: g, expectedFee: price },
      tagCodes: [guest.tagCode],
      summary: `虫洞 ${room.code}：手牌 ${guest.tagCode}（${g === 'female' ? '女' : '男'}）${price ? ` ${formatYuan(price)}` : ' 不收费'}`,
      amount: price,
    }));
    if (r) onDone(r === true ? null : r);
  };
  return (
    <Dialog
      open
      onClose={op.busy ? () => {} : onClose}
      width="max-w-md"
      title={`虫洞下单 · ${label(room)}`}
      description="三步：手牌、性别、这个虫洞；费用按后台设的挂到手牌上。"
      footer={
        <>
          <span className="mr-auto self-center text-[13px] text-ink-3" data-testid="rc-wormhole-fee">
            {problem ? <span className="text-clay">{problem}</span> : price ? <Money cents={price} className="text-[18px] font-bold text-ink" /> : '不收费'}
          </span>
          <Button variant="ghost" onClick={onClose} disabled={op.busy}>
            取消
          </Button>
          <Button variant="primary" disabled={!!problem || op.locked} loading={op.busy} onClick={() => void submit()} data-testid="rc-wormhole-submit">
            确认下单
          </Button>
        </>
      }
    >
      <PendingPanel op={op} onResolved={(r) => onDone(r === true ? null : r)} />
      <div className="space-y-4" data-testid="rc-wormhole">
        <TagField value={tag} onChange={setTag} onGuest={setGuest} disabled={op.locked} />
        <Field label="性别">
          <Segmented<'male' | 'female'>
            ariaLabel="性别"
            value={g ?? 'male'}
            onChange={setGender}
            options={[
              { value: 'male', label: '男' },
              { value: 'female', label: '女' },
            ]}
          />
        </Field>
        <Field label="虫洞号">
          <p className="num text-[16px] font-bold" data-testid="rc-wormhole-code">
            {room.code}
          </p>
        </Field>
        <Field label="费用">
          <p className="text-[14px] font-semibold">{fee ? `${fee.name} ${formatYuan(fee.price)}` : '后台没设虫洞的费用项目：不收费'}</p>
        </Field>
      </div>
      {op.state.phase === 'error' && <Notice tone="error" title={op.state.message} className="mt-4" />}
    </Dialog>
  );
}
