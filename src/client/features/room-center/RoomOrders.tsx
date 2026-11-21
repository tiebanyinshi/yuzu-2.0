// 8.2.0 P08（回测 3-1，docs/YUZU_REQ_V820.md 第 9 节）：房态中心「在用」的房间上点水吧、果吧，看这间房的点单记录、撤单。
//   · 点单面板：水吧 / 果吧两个页签（只出有下单权限的那几个），按分类看、搜索、加减份数、每样写备注、整单备注；
//     能点哪几个分类按门店的配置（后台 → 餐饮 → 房态点单）；要选规格、必选做法、换套餐内容的菜在这里不能点（到点单页点）；
//   · 下单照前台的「结果待确认」（useFrontdeskOp，挂账 bill_post）：提交前本机先存原编号与原请求，断网、超时后查回、原样重提或确认作废，不会重复挂账；
//   · 点单记录：这间房最近 100 单，逐行写有没有退、谁退的；客人还在店的、有这个出品口退菜权限的可以逐行撤单（要原因，与前台作废明细同一个接口）。

import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Minus, Plus, Search, Trash2, Undo2 } from 'lucide-react';
import type { MenuDish } from '@shared/dining';
import { MAX_DISH_NOTE } from '@shared/dining';
import { MAX_ORDER_NOTE } from '@shared/dining-v8115';
import { OUTLET_VOID_PERMISSIONS } from '@shared/frontdesk-v8117';
import type { RoomCard } from '@shared/room-center';
import {
  ROOM_ORDER_OUTLET_LABELS,
  ROOM_ORDER_OUTLETS,
  roomOrderCategoryOf,
  type RoomOrderConfig,
  type RoomOrderHistory,
  type RoomOrderOutlet,
  type RoomOrderResult,
  type RoomOrderView,
} from '@shared/room-orders';
import { api, errorMessage } from '../../lib/api';
import { useCan, useSession } from '../../lib/session';
import { formatYuan } from '@shared/money';
import { cn, formatDateTime } from '../../lib/utils';
import { useToast } from '../../components/Toast';
import { Dialog } from '../../components/Overlay';
import { Badge, Button, Input, Notice, Segmented, Skeleton } from '../../components/ui';
import { LoadFailed } from '../../components/LoadFailed';
import { Money } from '../../components/Money';
import { QtyInput } from '../../components/QtyInput';
import { swappableOf } from '../dining/DishOptionsDialog';
import { useDiningMenu } from '../dining/queries';
import { PendingPanel, useFrontdeskOp } from '../frontdesk/pending';
import { roomCenterKey } from './queries';

const ORDER_PERMS = { water: 'dining.orderWater', fruit: 'dining.orderFruit' } as const satisfies Record<RoomOrderOutlet, string>;

/** 当前账号能在哪几个出品口下单（没有的不出页签；一个都没有就不出「点单」入口） */
export function useRoomOrderOutlets(): RoomOrderOutlet[] {
  const can = useCan();
  return ROOM_ORDER_OUTLETS.filter((o) => can(ORDER_PERMS[o]));
}

/** 卡片的 key（s12 / r3）与房里现在那位客人的来访（点单挂在他账上，待确认记录按它找） */
export const roomOrderTarget = (room: RoomCard) => ({
  key: room.key,
  visitId: room.guests[0]?.visitId ?? room.usage?.visitId ?? room.hotel?.stay?.visitId ?? null,
  tagCode: room.guests[0]?.tagCode ?? room.usage?.tagCode ?? room.hotel?.stay?.tagCode ?? '',
});

const configKey = ['room-center', 'order-config'] as const;
const ordersKey = (key: string) => ['room-center', 'orders', key] as const;

/** 要选规格、必选做法、换套餐内容的菜：面板上不能点（到点单页点） */
const needsChoice = (d: MenuDish) => !!(d.prices && d.prices.length > 1) || !!d.methodGroups?.some((g) => g.required) || swappableOf(d).length > 0;

interface Line {
  quantity: number;
  note: string;
}

export function RoomOrderPanel({ room, onClose, onHistory }: { room: RoomCard; onClose: () => void; onHistory: () => void }) {
  const session = useSession();
  const toast = useToast();
  const qc = useQueryClient();
  const outlets = useRoomOrderOutlets();
  const [outlet, setOutlet] = useState<RoomOrderOutlet>(outlets[0] ?? 'water');
  const [category, setCategory] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [cart, setCart] = useState<Record<number, Line>>({});
  const [orderNote, setOrderNote] = useState('');
  const [hint, setHint] = useState<string | null>(null);
  const menu = useDiningMenu();
  const config = useQuery({ queryKey: configKey, queryFn: () => api.get<RoomOrderConfig>('/api/room-center/order-config') });
  const target = roomOrderTarget(room);
  const op = useFrontdeskOp<RoomOrderResult | true>({ type: 'bill_post', visitId: target.visitId, staffName: session.staff.displayName, pick: () => true });

  const allowed = config.data?.outlets[outlet].categories ?? null;
  const dishes = useMemo(() => (menu.data?.dishes ?? []).filter((d) => d.outlet === outlet && (allowed === null || allowed.includes(roomOrderCategoryOf(d)))), [menu.data, outlet, allowed]);
  const categories = useMemo(() => [...new Set(dishes.map(roomOrderCategoryOf))], [dishes]);
  const shown = dishes.filter((d) => (category === null || roomOrderCategoryOf(d) === category) && (!q.trim() || d.name.includes(q.trim())));
  const picked = Object.entries(cart).flatMap(([id, l]) => {
    const d = menu.data?.dishes.find((x) => x.id === Number(id));
    return d ? [{ dish: d, ...l }] : [];
  });
  const total = picked.reduce((s, l) => s + l.dish.price * l.quantity, 0);

  const switchOutlet = (o: RoomOrderOutlet) => {
    setOutlet(o);
    setCategory(null);
    setCart({});
  };
  const setQty = (id: number, quantity: number) =>
    setCart((c) => {
      const next = { ...c };
      if (quantity <= 0) delete next[id];
      else next[id] = { note: c[id]?.note ?? '', quantity };
      return next;
    });
  const done = () => {
    setCart({});
    setOrderNote('');
    void qc.invalidateQueries({ queryKey: roomCenterKey });
    void qc.invalidateQueries({ queryKey: ordersKey(room.key) });
  };
  const submit = async () => {
    const lines = picked.map((l) => ({ itemId: l.dish.id, quantity: l.quantity, ...(l.note.trim() ? { note: l.note.trim() } : {}) }));
    const r = await op.submit((key) => ({
      url: `/api/room-center/rooms/${room.key}/orders`,
      body: { clientKey: key, outlet, lines, expectedTotal: total, ...(orderNote.trim() ? { orderNote: orderNote.trim() } : {}) },
      tagCodes: [`${target.tagCode} · 房 ${room.code}`],
      summary: `${ROOM_ORDER_OUTLET_LABELS[outlet]} ${picked.map((l) => `${l.dish.name}×${l.quantity}`).join('、')}`,
      amount: total,
    }));
    if (r) {
      done();
      toast({
        tone: 'success',
        title: `已下单：${room.code} · ${ROOM_ORDER_OUTLET_LABELS[outlet]}`,
        body: `出品单已送到${ROOM_ORDER_OUTLET_LABELS[outlet]}，${formatYuan(total)} 挂在 ${target.tagCode} 的账上`,
      });
      onClose();
    }
  };

  const loading = menu.isPending || config.isPending;
  const failed = (menu.isError && !menu.data) || (config.isError && !config.data);
  return (
    <Dialog
      open
      onClose={onClose}
      width="max-w-3xl"
      title={`${room.code} 点单`}
      description={`挂在 ${target.tagCode || '房里的客人'} 的账上；出品单送到「房 ${room.code}」`}
      footer={
        <>
          <Button variant="ghost" onClick={onHistory} data-testid="room-order-history-open">
            点单记录
          </Button>
          <span className="mr-auto" />
          <Button variant="secondary" onClick={onClose}>
            取消
          </Button>
          <Button variant="primary" loading={op.busy} disabled={op.locked || picked.length === 0} onClick={submit} data-testid="room-order-submit">
            下单{picked.length ? ` · ${formatYuan(total)}` : ''}
          </Button>
        </>
      }
    >
      <div className="space-y-3" data-testid="room-order-panel">
        <PendingPanel op={op} onResolved={done} />
        {op.state.phase === 'error' && <Notice tone="error" title={op.state.message} />}
        {outlets.length > 1 && (
          <Segmented
            value={outlet}
            onChange={switchOutlet}
            className="w-full"
            options={outlets.map((o) => ({ value: o, label: ROOM_ORDER_OUTLET_LABELS[o] }))}
            ariaLabel="出品口"
            data-testid="room-order-outlet"
          />
        )}
        {loading ? (
          <Skeleton className="h-64" />
        ) : failed ? (
          <LoadFailed title="菜单取不回来" onRetry={() => void Promise.all([menu.refetch(), config.refetch()])} />
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <span className="relative min-w-0 flex-1 basis-48">
                <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-4" aria-hidden />
                <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜菜名" className="pl-9" aria-label="搜菜名" data-testid="room-order-search" />
              </span>
            </div>
            <div className="flex flex-wrap gap-1.5" role="group" aria-label="分类">
              {[null, ...categories].map((c) => (
                <button
                  key={c ?? '全部'}
                  type="button"
                  onClick={() => setCategory(c)}
                  aria-pressed={category === c}
                  className={cn('tap rounded-full border px-3 py-1 text-[13px] font-semibold', category === c ? 'border-pine bg-pine-tint text-pine' : 'border-line bg-card text-ink-2')}
                  data-testid={`room-order-cat-${c ?? 'all'}`}
                >
                  {c ?? '全部'}
                </button>
              ))}
            </div>
            {dishes.length === 0 ? (
              <Notice tone="info" title={`${ROOM_ORDER_OUTLET_LABELS[outlet]}现在没有能在房间里点的`}>
                {allowed !== null ? '门店只开放了部分分类（后台 → 餐饮 → 房态点单）。' : '菜单里还没有这个出品口的菜。'}
              </Notice>
            ) : (
              <ul className="scroll-thin max-h-[46vh] divide-y divide-line overflow-y-auto rounded-lg border border-line" data-testid="room-order-dishes">
                {shown.map((d) => {
                  const line = cart[d.id];
                  const blocked = d.remaining === 0 ? '已沽清' : needsChoice(d) ? '要选规格或做法，请到点单页点' : null;
                  return (
                    <li key={d.id} className="px-3 py-2" data-testid={`room-order-dish-${d.name}`}>
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="min-w-0 flex-1">
                          <span className="font-semibold">{d.name}</span>
                          <span className="ml-2 text-[12px] text-ink-3">{roomOrderCategoryOf(d)}</span>
                          {d.remaining !== null && d.remaining > 0 && <span className="ml-2 text-[12px] text-ember-deep">余 {d.remaining}</span>}
                          {blocked && <span className="ml-2 text-[12px] text-clay">{blocked}</span>}
                        </span>
                        <Money cents={d.price} className="text-[14px] font-bold" />
                        {line ? (
                          <span className="flex items-center gap-1.5">
                            <button
                              type="button"
                              className="tap relative flex size-8 items-center justify-center rounded-full bg-paper-2 hover:bg-paper-3"
                              onClick={() => setQty(d.id, line.quantity - 1)}
                              aria-label={line.quantity === 1 ? `不要${d.name}了` : `${d.name}少一份`}
                              disabled={op.locked}
                              data-testid={`room-order-minus-${d.name}`}
                            >
                              {line.quantity === 1 ? <Trash2 className="size-3.5" /> : <Minus className="size-3.5" />}
                            </button>
                            <QtyInput
                              value={line.quantity}
                              max={d.remaining === null ? 99 : Math.min(99, d.remaining)}
                              onChange={(n) => setQty(d.id, n)}
                              onHint={setHint}
                              label={`${d.name} 的份数`}
                              disabled={op.locked}
                              className="h-8 w-9 text-[15px]"
                              testId={`room-order-qty-${d.name}`}
                            />
                            <button
                              type="button"
                              className="tap relative flex size-8 items-center justify-center rounded-full bg-paper-2 hover:bg-paper-3"
                              onClick={() => setQty(d.id, Math.min(d.remaining === null ? 99 : Math.min(99, d.remaining), line.quantity + 1))}
                              aria-label={`${d.name}多一份`}
                              disabled={op.locked}
                              data-testid={`room-order-plus-${d.name}`}
                            >
                              <Plus className="size-3.5" />
                            </button>
                          </span>
                        ) : (
                          <Button size="sm" variant="secondary" disabled={!!blocked || op.locked} onClick={() => setQty(d.id, 1)} data-testid={`room-order-add-${d.name}`}>
                            加一份
                          </Button>
                        )}
                      </div>
                      {line && (
                        <Input
                          value={line.note}
                          maxLength={MAX_DISH_NOTE}
                          onChange={(e) => setCart((c) => ({ ...c, [d.id]: { ...line, note: e.target.value } }))}
                          placeholder="备注（少冰、去籽……印在出品单上）"
                          className="mt-1.5 h-9 text-[13px]"
                          aria-label={`${d.name} 备注`}
                          data-testid={`room-order-note-${d.name}`}
                        />
                      )}
                    </li>
                  );
                })}
                {shown.length === 0 && <li className="px-3 py-6 text-center text-[13px] text-ink-3">没有对上的菜</li>}
              </ul>
            )}
            {hint && <p className="text-[12.5px] text-ember-deep">{hint}</p>}
            <Input
              value={orderNote}
              maxLength={MAX_ORDER_NOTE}
              onChange={(e) => setOrderNote(e.target.value)}
              placeholder="整单备注（选填，印在这一单每样的出品单上）"
              aria-label="整单备注"
              data-testid="room-order-note"
            />
            {picked.length > 0 && (
              <p className="text-[13px] text-ink-2" data-testid="room-order-summary">
                {ROOM_ORDER_OUTLET_LABELS[outlet]} {picked.length} 样、{picked.reduce((s, l) => s + l.quantity, 0)} 份，合计 <b className="num">{formatYuan(total)}</b>
              </p>
            )}
          </>
        )}
      </div>
    </Dialog>
  );
}

// ───────────────────────── 点单记录 ─────────────────────────

export function RoomOrdersDialog({ room, onClose, onOrder }: { room: RoomCard; onClose: () => void; onOrder?: () => void }) {
  const q = useQuery({ queryKey: ordersKey(room.key), queryFn: () => api.get<RoomOrderHistory>(`/api/room-center/rooms/${room.key}/orders`) });
  return (
    <Dialog
      open
      onClose={onClose}
      width="max-w-2xl"
      title={`${room.code} 点单记录`}
      description={q.data ? `房里现在的客人点了 ${q.data.current.count} 单、${formatYuan(q.data.current.amount)}（退掉的不算）` : undefined}
      footer={
        <>
          {onOrder && (
            <Button variant="primary" onClick={onOrder} className="mr-auto" data-testid="room-orders-new">
              再点一单
            </Button>
          )}
          <Button variant="secondary" onClick={onClose}>
            关闭
          </Button>
        </>
      }
    >
      {q.isPending ? (
        <Skeleton className="h-48" />
      ) : q.isError && !q.data ? (
        <LoadFailed title="点单记录取不回来" onRetry={() => void q.refetch()} />
      ) : q.data.orders.length === 0 ? (
        <p className="py-6 text-center text-[13px] text-ink-3">这间房还没从房态点过单</p>
      ) : (
        <ul className="space-y-2.5" data-testid="room-orders">
          {q.data.orders.map((o) => (
            <OrderItem key={o.id} order={o} roomKey={room.key} />
          ))}
          {q.data.truncated && <li className="text-center text-[12px] text-ink-3">只列最近 {q.data.limit} 单</li>}
        </ul>
      )}
    </Dialog>
  );
}

function OrderItem({ order: o, roomKey }: { order: RoomOrderView; roomKey: string }) {
  const can = useCan();
  const canVoid = can('frontdesk.operate') || can(OUTLET_VOID_PERMISSIONS[o.outlet]);
  const [voiding, setVoiding] = useState<number | null>(null);
  const allVoided = o.lines.every((l) => l.status === 'voided');
  return (
    <li className={cn('rounded-lg border border-line px-3 py-2.5', allVoided && 'opacity-70')} data-testid="room-order-row">
      <p className="flex flex-wrap items-center gap-2 text-[13px]">
        <Badge tone={o.outlet === 'water' ? 'lake' : 'moss'}>{ROOM_ORDER_OUTLET_LABELS[o.outlet]}</Badge>
        <span className="num font-semibold">{formatDateTime(o.createdAt)}</span>
        <span className="text-ink-3">
          {o.staffName}（{o.staffUsername}）
        </span>
        {o.orderNo && <span className="num text-ink-3">出品单 {o.orderNo}</span>}
        <span className="ml-auto">
          {o.total !== o.postedTotal && <s className="num mr-1.5 text-[12px] text-ink-4">{formatYuan(o.postedTotal)}</s>}
          <Money cents={o.total} className="font-bold" />
        </span>
      </p>
      {o.note && <p className="mt-0.5 text-[12.5px] text-ink-2">整单备注：{o.note}</p>}
      <ul className="mt-1.5 space-y-1">
        {o.lines.map((l) => (
          <li key={l.lineId} className="text-[13px]" data-testid="room-order-line" data-status={l.status}>
            <div className="flex flex-wrap items-center gap-2">
              <span className={cn('min-w-0 flex-1', l.status === 'voided' && 'text-ink-4 line-through')}>
                {l.name} × {l.quantity}
                {l.note && <span className="ml-1.5 text-[12px] text-ink-3">（{l.note}）</span>}
              </span>
              <Money cents={l.amount} className={cn('text-[13px]', l.status === 'voided' && 'text-ink-4')} />
              {l.status === 'posted' && o.visitOpen && canVoid && voiding !== l.lineId && (
                <Button size="sm" variant="ghost" icon={<Undo2 className="size-3.5" />} onClick={() => setVoiding(l.lineId)} data-testid={`room-order-void-${l.name}`}>
                  撤单
                </Button>
              )}
            </div>
            {l.status === 'voided' && (
              <p className="text-[12px] text-clay">
                已退：{l.voidReason}（{l.voidedByName ?? '—'}
                {l.voidedAt ? ` · ${formatDateTime(l.voidedAt)}` : ''}）
              </p>
            )}
            {voiding === l.lineId && <VoidLine lineId={l.lineId} roomKey={roomKey} onDone={() => setVoiding(null)} />}
          </li>
        ))}
      </ul>
      {!o.visitOpen && o.lines.some((l) => l.status === 'posted') && <p className="mt-1 text-[12px] text-ink-3">客人已结账，要退请到前台反结账</p>}
    </li>
  );
}

function VoidLine({ lineId, roomKey, onDone }: { lineId: number; roomKey: string; onDone: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.post(`/api/frontdesk/lines/${lineId}/void`, { reason: reason.trim() });
      await qc.invalidateQueries({ queryKey: ordersKey(roomKey) });
      void qc.invalidateQueries({ queryKey: roomCenterKey });
      toast({ tone: 'success', title: '已撤单', body: '出品单改为已退，金额从客人账上减掉' });
      onDone();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="mt-1 flex flex-wrap items-center gap-2 rounded-md bg-paper-2 px-2 py-1.5">
      <Input
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        maxLength={200}
        placeholder="撤单原因（至少 2 个字）"
        className="h-9 min-w-0 flex-1 basis-40 text-[13px]"
        aria-label="撤单原因"
        data-testid="room-order-void-reason"
        data-autofocus
      />
      <Button size="sm" variant="ghost" onClick={onDone}>
        不撤了
      </Button>
      <Button size="sm" variant="danger" loading={busy} disabled={reason.trim().length < 2} onClick={run} data-testid="room-order-void-confirm">
        确认撤单
      </Button>
      {error && <p className="w-full text-[12.5px] text-clay">{error}</p>}
    </div>
  );
}
