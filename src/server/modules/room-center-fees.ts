// 福田店整改（2026-11-26，docs/FUTIAN_1126.md）：房态中心规则的读取，与房费（FT-10 下钟后免费时长、FT-17 ④ 房间按时间计费）。
// 退房（room-center-ops.ts）与看板、撤房等（room-center-futian.ts）共用；这个文件不引房态中心的写操作，免得互相引用。

import { defaultTier, tierPrice } from '@shared/catalog';
import { DEFAULT_ROOM_CENTER_RULES, normalizeRoomCenterRules, ROOM_CENTER_RULES_KEY, roomFeeRuleOf, roomFeeStartsAt, roomTimeFee, type RoomCenterRules } from '@shared/room-center-rules';
import type { Db, Tx } from '../db';
import { conflict } from '../lib/errors';
import { settingRow } from '../lib/store-settings';
import { logRoomEvent, roomLabel, type RoomFacts } from './room-center-core';
import { loadPricedItems } from './pricing';

export async function loadRoomCenterRules(db: Db): Promise<RoomCenterRules> {
  const row = await settingRow<unknown>(db, ROOM_CENTER_RULES_KEY);
  return normalizeRoomCenterRules(row?.value ?? DEFAULT_ROOM_CENTER_RULES);
}

/** 这间房最后一位技师下钟的时刻（登记了的客人这次登记里的钟）；还有钟没下、或一个钟都没做完的为 null */
function lastClockOffOf(room: RoomFacts): string | null {
  const sessions = room.guests.filter((g) => g.registration).flatMap((g) => g.sessions);
  if (sessions.length === 0 || sessions.some((s) => s.status !== 'done')) return null;
  return sessions.map((s) => s.endedAt).reduce<string | null>((a, b) => (b && (!a || new Date(b).getTime() > new Date(a).getTime()) ? b : a), null);
}

export interface RoomFeeQuote {
  itemId: number;
  tier: string;
  itemName: string;
  hourPrice: number;
  stepMinutes: number;
  minutes: number;
  chargedMinutes: number;
  amount: number;
  capped: boolean;
  startsAt: string | null;
  freeMinutes: number;
  /** 记在哪位客人（先登记的那位）的手牌上 */
  visitId: number;
  tagCode: string;
}

/** 这间房按现在（at）退房要收多少房费；这个业态没设计费、没有登记的客人为 null */
export async function quoteRoomFee(db: Db, room: RoomFacts, at: Date, rules?: RoomCenterRules): Promise<RoomFeeQuote | null> {
  const r = rules ?? (await loadRoomCenterRules(db));
  const rule = roomFeeRuleOf(r, room.space.businessType);
  const first = room.guests.find((g) => g.registration);
  if (!rule || !first) return null;
  const items = await loadPricedItems(db, [rule.feeItemId!]);
  const item = items.get(rule.feeItemId!);
  const tier = item ? defaultTier(item.prices) : null;
  const price = item && tier ? tierPrice(item.prices, tier) : null;
  if (!item || !item.active || !tier || price === null) throw conflict('ROOM_FEE_ITEM', `${roomLabel(room.space)} 的房费项目已停用或没有价格，请店主到后台「房态中心规则」改计费后再退房`);
  const startsAt = roomFeeStartsAt(lastClockOffOf(room), r.freeAfterClockOffMinutes);
  const fee = roomTimeFee(startsAt, at, rule, price);
  return {
    itemId: Number(item.id),
    tier,
    itemName: item.name,
    hourPrice: price,
    stepMinutes: rule.stepMinutes,
    ...fee,
    startsAt: startsAt?.toISOString() ?? null,
    freeMinutes: r.freeAfterClockOffMinutes,
    visitId: Number(first.visit.id),
    tagCode: first.visit.tagCode,
  };
}

/**
 * 退房时记房费（事务里；来访、账单已锁）：按单位记一条明细（数量 = 几个单位；超长或封顶的合成一行），账单合计跟着加，记一条房间事件。
 * 金额为 0（还在免费时长里）不记。返回记了多少
 */
export async function chargeRoomFeeTx(
  tx: Tx,
  q: RoomFeeQuote,
  a: { spaceId: number; label: string; businessType: string; code: string; billId: number; key: string; at: Date; today: string; staffId: number },
): Promise<number> {
  if (q.amount <= 0) return 0;
  const steps = Math.ceil(q.chargedMinutes / q.stepMinutes);
  const perStep = !q.capped && steps <= 99;
  const unitPrice = perStep ? Math.round(q.amount / steps) : q.amount;
  const quantity = perStep ? steps : 1;
  const name = `${a.businessType} ${a.code} 房费${perStep ? `（每 ${q.stepMinutes} 分钟）` : q.capped ? '（封顶）' : ''}`.slice(0, 48);
  await tx`
    INSERT INTO bill_lines (bill_id, source, item_id, tier, name, unit_price, quantity, amount, post_key, business_date, posted_by, posted_at)
    VALUES (${a.billId}, 'room', ${q.itemId}, ${q.tier}, ${name}, ${unitPrice}, ${quantity}, ${unitPrice * quantity}, ${a.key}, ${a.today}, ${a.staffId}, ${a.at})`;
  await tx`UPDATE bills SET amount_cents = amount_cents + ${unitPrice * quantity}, line_count = line_count + 1 WHERE id = ${a.billId}`;
  await logRoomEvent(tx, {
    spaceId: a.spaceId,
    kind: 'room_fee',
    detail: { room: a.label, tag: q.tagCode, minutes: q.minutes, chargedMinutes: q.chargedMinutes, amount: unitPrice * quantity, startsAt: q.startsAt, freeMinutes: q.freeMinutes, capped: q.capped },
    staffId: a.staffId,
    at: a.at,
  });
  return unitPrice * quantity;
}
