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
): Promise<{ amount: number; lineId: number } | null> {
  if (q.amount <= 0) return null;
  const steps = Math.ceil(q.chargedMinutes / q.stepMinutes);
  const perStep = !q.capped && steps <= 99;
  const unitPrice = perStep ? Math.round(q.amount / steps) : q.amount;
  const quantity = perStep ? steps : 1;
  const name = `${a.businessType} ${a.code} 房费${perStep ? `（每 ${q.stepMinutes} 分钟）` : q.capped ? '（封顶）' : ''}`.slice(0, 48);
  const [line] = await tx<{ id: number }[]>`
    INSERT INTO bill_lines (bill_id, source, item_id, tier, name, unit_price, quantity, amount, post_key, business_date, posted_by, posted_at)
    VALUES (${a.billId}, 'room', ${q.itemId}, ${q.tier}, ${name}, ${unitPrice}, ${quantity}, ${unitPrice * quantity}, ${a.key}, ${a.today}, ${a.staffId}, ${a.at})
    RETURNING id`;
  await tx`UPDATE bills SET amount_cents = amount_cents + ${unitPrice * quantity}, line_count = line_count + 1 WHERE id = ${a.billId}`;
  await logRoomEvent(tx, {
    spaceId: a.spaceId,
    kind: 'room_fee',
    detail: { room: a.label, tag: q.tagCode, minutes: q.minutes, chargedMinutes: q.chargedMinutes, amount: unitPrice * quantity, startsAt: q.startsAt, freeMinutes: q.freeMinutes, capped: q.capped },
    staffId: a.staffId,
    at: a.at,
  });
  return { amount: unitPrice * quantity, lineId: Number(line!.id) };
}

/** 收银台结账时要收的一笔房费（福田店：房费只在收银台收，店主 2026-11-26） */
export interface CashierRoomFee {
  visitId: number;
  registrationId: number;
  spaceId: number;
  label: string;
  businessType: string;
  code: string;
  /** 计费截止：房态中心退了房的是退房那一刻，没退的是结账这一刻 */
  endsAt: string;
  quote: RoomFeeQuote;
}

/**
 * 这几位客人结账时要收的房费（只读，预览与结账同一个算法；结账时在事务里、钟已收尾以后算）：
 * 他们的登记单（普通、括单；开着的或在房态中心退了房的）里，这间房这一段是他先登记的那一张（同房加人的后来者不重复收）、
 * 这个业态设了计费、还没收过（收过的那一行被作废了的重新算）。从这一段最后一位技师下钟、过了免费时长开始，到退房（没退的到结账）为止；
 * 这一段里还有钟没下的（同房别的客人还在做）不收。金额为 0 的不列。
 */
export async function cashierRoomFees(db: Db, visitIds: number[], at: Date): Promise<CashierRoomFee[]> {
  if (visitIds.length === 0) return [];
  const rules = await loadRoomCenterRules(db);
  if (!rules.roomFees.some((f) => f.enabled && f.feeItemId)) return [];
  const regs = await db<{ id: number; spaceId: number; visitId: number; openedAt: string; closedAt: string | null; code: string; displayName: string; businessType: string; tagCode: string }[]>`
    SELECT r.id, r.space_id, r.visit_id, r.opened_at, r.closed_at, sp.code, sp.display_name, sp.business_type, h.code AS tag_code
    FROM room_registrations r JOIN spaces sp ON sp.id = r.space_id JOIN visits v ON v.id = r.visit_id JOIN hand_tags h ON h.id = v.tag_id
    WHERE r.visit_id IN ${db(visitIds)} AND r.kind IN ('normal', 'bracket') AND (r.status = 'open' OR r.close_kind = 'checkout')
      AND NOT EXISTS (SELECT 1 FROM room_fee_charges c JOIN bill_lines l ON l.id = c.bill_line_id WHERE c.registration_id = r.id AND l.status = 'active')
      AND NOT EXISTS (
        SELECT 1 FROM room_registrations o WHERE o.space_id = r.space_id AND o.id <> r.id AND o.kind IN ('normal', 'bracket')
          AND (o.close_kind IS NULL OR o.close_kind NOT IN ('revoked', 'visit_cancel', 'backfill'))
          AND o.opened_at < r.opened_at AND (o.closed_at IS NULL OR o.closed_at > r.opened_at))
    ORDER BY r.id`;
  const out: CashierRoomFee[] = [];
  for (const r of regs) {
    const rule = roomFeeRuleOf(rules, r.businessType);
    if (!rule) continue;
    const end = r.closedAt ? new Date(r.closedAt) : at;
    const sessions = await db<{ status: string; endedAt: string | null }[]>`
      SELECT status, ended_at FROM technician_sessions
      WHERE space_id = ${r.spaceId} AND NOT room_neutral AND created_at >= ${r.openedAt} AND created_at <= ${end} AND status IN ('waiting', 'serving', 'done')`;
    if (sessions.length === 0 || sessions.some((x) => x.status !== 'done')) continue;
    const lastOff = sessions.map((x) => x.endedAt!).reduce((a, b) => (new Date(b).getTime() > new Date(a).getTime() ? b : a));
    const item = (await loadPricedItems(db, [rule.feeItemId!])).get(rule.feeItemId!);
    const tier = item ? defaultTier(item.prices) : null;
    const price = item && tier ? tierPrice(item.prices, tier) : null;
    if (!item || !item.active || !tier || price === null) {
      throw conflict('ROOM_FEE_ITEM', `${r.code} 的房费项目已停用或没有价格，请店主到后台「房态中心规则」改计费后再结账`);
    }
    const startsAt = roomFeeStartsAt(lastOff, rules.freeAfterClockOffMinutes);
    const fee = roomTimeFee(startsAt, end, rule, price);
    if (fee.amount <= 0) continue;
    out.push({
      visitId: Number(r.visitId),
      registrationId: Number(r.id),
      spaceId: Number(r.spaceId),
      label: roomLabel({ code: r.code, displayName: r.displayName }),
      businessType: r.businessType,
      code: r.code,
      endsAt: end.toISOString(),
      quote: {
        itemId: Number(item.id),
        tier,
        itemName: item.name,
        hourPrice: price,
        stepMinutes: rule.stepMinutes,
        ...fee,
        startsAt: startsAt?.toISOString() ?? null,
        freeMinutes: rules.freeAfterClockOffMinutes,
        visitId: Number(r.visitId),
        tagCode: r.tagCode,
      },
    });
  }
  return out;
}

/** 收银台结账时记房费（事务里；来访、账单已锁）：挂一行明细、记一条房间事件、记哪张登记单收过 */
export async function chargeCashierRoomFeesTx(tx: Tx, fees: CashierRoomFee[], a: { billOf: (visitId: number) => number; key: string; at: Date; today: string; staffId: number }) {
  for (const f of fees) {
    const r = await chargeRoomFeeTx(tx, f.quote, {
      spaceId: f.spaceId,
      label: f.label,
      businessType: f.businessType,
      code: f.code,
      billId: a.billOf(f.visitId),
      key: a.key,
      at: a.at,
      today: a.today,
      staffId: a.staffId,
    });
    if (!r) continue;
    await tx`
      INSERT INTO room_fee_charges (registration_id, bill_line_id, amount, starts_at, ends_at, charged_minutes)
      VALUES (${f.registrationId}, ${r.lineId}, ${r.amount}, ${f.quote.startsAt}, ${f.endsAt}, ${f.quote.chargedMinutes})`;
  }
}
