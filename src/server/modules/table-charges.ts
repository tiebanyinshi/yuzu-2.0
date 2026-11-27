// 8.1.39 桌台的低消、服务费与转挂账（docs/V8139.md 第 3、4 节；《餐饮新店新系统功能需求文档》R6、R9、R14）。
//
//   · 服务费：桌台设了比例的（包房常见），结账时按这一桌「点了、没退、没赠送」的菜算（赠送是退菜时选「赠送」：菜照出、不收钱，
//     这一行不在账上，服务费自然不算它，R14），四舍五入到分，记一行「服务费 15%」；
//   · 低消：桌台设了低消的，菜钱（不算服务费）不到低消时结账拒绝（MIN_SPEND_SHORT），写明差多少；收银勾「补足低消」才结，
//     记一行「低消补足」；或者先把这桌转挂账（R9），桌台空出来，挂账的单之后再结；
//   · 这两行是结账时按规则记的（bill_lines.charge_kind），反结账后重新结账：原来记的作废、按此刻重算，不会重复收；
//   · 转挂账：账单不结，桌台空出来给下一桌；挂账的单不能再点菜、换台、并台，结账照常（选它结）。要写原因、记审计。
// 锁：结账在 tables.ts 里已按「班次 → 桌台 → 开台 → 账单」锁好，这里在账单锁之后读、写明细；转挂账：桌台 → 开台（与换台同一顺序）。

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { formatYuan } from '@shared/money';
import { serviceFeeText, type TableCharge } from '@shared/table-charges';
import { DEFAULT_DINING_RULES, type DiningRules } from '@shared/dining';
import { tableRuleOf, type DiningRoomType, type ServiceFeeDefault } from '@shared/dining-v8224';
import { minuteOfDay } from '@shared/business-date';
import { settingRow } from '../lib/store-settings';
import type { Db, Tx } from '../db';
import { guard, guardAny } from '../auth/guard';
import { writeAudit } from '../lib/audit';
import { ctxOf, type Deps, type OpContext } from '../lib/context';
import { conflict, notFound } from '../lib/errors';
import { idParam, parse } from '../lib/validate';
import { currentStoreId } from '../lib/store-context';
import { businessDate, setTxTimeouts } from './frontdesk/common';

/**
 * 这几次开台此刻的菜钱、低消与服务费（只读；结账核对与结账用同一个算法）。
 * 8.2.4：低消、服务费按「桌台自己设的 → 房型（低消、中消、只收房费）→ 门店默认」取（tableRuleOf）；中消看开台时刻与此刻的人数
 */
export async function tableChargesOf(db: Db, sessionIds: number[], timeZone: string): Promise<Map<number, TableCharge>> {
  if (sessionIds.length === 0) return new Map();
  const rows = await db<
    {
      sessionId: number;
      tableName: string;
      minSpend: number;
      serviceFeeBp: number | null;
      subtotal: number;
      old: number;
      guests: number;
      openedAt: Date;
      roomType: (Omit<DiningRoomType, 'id' | 'sortOrder' | 'active'> & { midStart: number | null; midEnd: number | null }) | null;
    }[]
  >`
    SELECT s.id AS session_id, t.name AS table_name, t.min_spend, t.service_fee_bp, s.guests, s.opened_at,
           CASE WHEN rt.id IS NULL THEN NULL ELSE json_build_object('name', rt.name, 'chargeMode', rt.charge_mode, 'minSpend', rt.min_spend, 'midSpend', rt.mid_spend,
             'midStart', rt.mid_start_minute, 'midEnd', rt.mid_end_minute, 'midMaxGuests', rt.mid_max_guests, 'roomFee', rt.room_fee) END AS room_type,
           coalesce((SELECT sum(l.amount) FROM bill_lines l WHERE l.bill_id = s.bill_id AND l.status = 'active' AND l.charge_kind IS NULL), 0)::bigint AS subtotal,
           coalesce((SELECT sum(l.amount) FROM bill_lines l WHERE l.bill_id = s.bill_id AND l.status = 'active' AND l.charge_kind IS NOT NULL), 0)::bigint AS old
    FROM table_sessions s JOIN dining_tables t ON t.id = s.table_id LEFT JOIN dining_room_types rt ON rt.id = t.room_type_id
    WHERE s.id IN ${db(sessionIds)}`;
  const store = await serviceFeeDefaultOf(db);
  return new Map(
    rows.map((r) => {
      const subtotal = Number(r.subtotal);
      const rt = r.roomType ? { ...r.roomType, minSpend: Number(r.roomType.minSpend), midSpend: Number(r.roomType.midSpend), roomFee: Number(r.roomType.roomFee) } : null;
      const rule = tableRuleOf({ minSpend: Number(r.minSpend), serviceFeeBp: r.serviceFeeBp, roomType: rt }, store, { openedMinute: minuteOfDay(new Date(r.openedAt), timeZone), guests: r.guests });
      const serviceFee = Math.round((subtotal * rule.serviceFeeBp) / 10_000);
      return [
        Number(r.sessionId),
        {
          tableName: r.tableName,
          subtotal,
          minSpend: rule.minSpend,
          serviceFeeBp: rule.serviceFeeBp,
          serviceFee,
          shortfall: Math.max(0, rule.minSpend - subtotal),
          previousCharges: Number(r.old),
          roomFee: rule.roomFee,
          roomTypeName: rule.roomTypeName,
          minSpendFrom: rule.minSpendFrom,
          serviceFeeFrom: rule.serviceFeeFrom,
        },
      ];
    }),
  );
}

/** 门店的服务费默认（餐饮规则；8.2.4）。读设置行，不引用 dining.ts */
async function serviceFeeDefaultOf(db: Db): Promise<ServiceFeeDefault> {
  const row = await settingRow<Partial<DiningRules>>(db, 'dining_rules');
  return { serviceFeeBp: row?.value?.serviceFeeBp ?? DEFAULT_DINING_RULES.serviceFeeBp, serviceFeeScope: row?.value?.serviceFeeScope ?? DEFAULT_DINING_RULES.serviceFeeScope };
}

/**
 * 结账时记服务费、低消补足（调用方的事务里，账单已锁）：原来自动记的先作废，再按此刻重算。
 * 低消不够又没勾「补足低消」的拒绝（MIN_SPEND_SHORT）。返回记了多少（加进账单合计）
 */
export async function applyTableCharges(
  tx: Tx,
  a: { sessions: { id: number; billId: number }[]; topUp: boolean; key: string; date: string; at: Date; staffId: number; timeZone: string },
): Promise<{ serviceFee: number; topUp: number; roomFee: number }> {
  const plan = await tableChargesOf(
    tx,
    a.sessions.map((s) => s.id),
    a.timeZone,
  );
  const short = a.sessions.map((s) => plan.get(s.id)!).filter((c) => c.shortfall > 0);
  if (short.length && !a.topUp) {
    throw conflict(
      'MIN_SPEND_SHORT',
      `${short.map((c) => `「${c.tableName}」低消 ${formatYuan(c.minSpend)}，现在 ${formatYuan(c.subtotal)}，差 ${formatYuan(c.shortfall)}`).join('；')}。` +
        '请餐饮确认补足低消（结账时勾「补足低消」）、请客人返台再点，或者先把这桌转挂账',
      { tables: short.map((c) => ({ tableName: c.tableName, minSpend: c.minSpend, subtotal: c.subtotal, shortfall: c.shortfall })) },
    );
  }
  let serviceFee = 0;
  let topUp = 0;
  let roomFee = 0;
  for (const s of a.sessions) {
    const c = plan.get(s.id)!;
    // 反结账以后重新结：原来自动记的作废（不会重复收）
    const voided = await tx<{ amount: number }[]>`
      UPDATE bill_lines SET status = 'voided', void_reason = '重新结账，按此刻重算', voided_by = ${a.staffId}, voided_at = ${a.at}
      WHERE bill_id = ${s.billId} AND status = 'active' AND charge_kind IS NOT NULL RETURNING amount`;
    const gone = voided.reduce((t, v) => t + Number(v.amount), 0);
    const add: { kind: 'service_fee' | 'min_spend' | 'room_fee'; name: string; amount: number }[] = [];
    if (c.serviceFee > 0) add.push({ kind: 'service_fee', name: serviceFeeText(c.serviceFeeBp), amount: c.serviceFee });
    if (c.shortfall > 0) add.push({ kind: 'min_spend', name: '低消补足', amount: c.shortfall });
    // 8.2.4：只收房费的房型记一行房费（不算服务费、不算进低消）
    if (c.roomFee > 0) add.push({ kind: 'room_fee', name: c.roomTypeName ? `房费（${c.roomTypeName}）` : '房费', amount: c.roomFee });
    for (const l of add) {
      await tx`
        INSERT INTO bill_lines (bill_id, source, item_id, tier, name, unit_price, quantity, amount, post_key, business_date, posted_by, posted_at, charge_kind)
        VALUES (${s.billId}, 'dining', NULL, NULL, ${l.name}, ${l.amount}, 1, ${l.amount}, ${a.key}, ${a.date}, ${a.staffId}, ${a.at}, ${l.kind})`;
    }
    const added = add.reduce((t, l) => t + l.amount, 0);
    if (gone || added) {
      await tx`UPDATE bills SET amount_cents = amount_cents - ${gone} + ${added}, line_count = line_count - ${voided.length} + ${add.length} WHERE id = ${s.billId}`;
    }
    serviceFee += c.serviceFee;
    topUp += c.shortfall;
    roomFee += c.roomFee;
  }
  return { serviceFee, topUp, roomFee };
}

// ───────────────────────── 转挂账（批房挂账，R9） ─────────────────────────

const ParkInput = z.object({ reason: z.string('请写转挂账的原因').trim().min(2, '请写转挂账的原因（至少 2 个字）').max(200, '原因最多 200 字') });

/** 转挂账：账单不结，桌台空出来（结账以后待清台的规则照旧：转挂账的桌也先待清台） */
export async function parkTableSession(deps: Deps, id: number, raw: unknown, ctx: OpContext) {
  const { reason } = parse(ParkInput, raw);
  await deps.sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    const at = ctx.at ?? new Date();
    const [peek] = await tx<{ tableId: number }[]>`SELECT table_id FROM table_sessions WHERE id = ${id} AND store_id = ${currentStoreId()}`;
    if (!peek) throw notFound('这次开台不存在');
    // 桌台 → 开台
    await tx`SELECT id FROM dining_tables WHERE id = ${peek.tableId} FOR UPDATE`;
    const [s] = await tx<{ sessionNo: string; status: string; tableId: number; parkedAt: Date | null; mergedInto: number | null; tableName: string }[]>`
      SELECT s.session_no, s.status, s.table_id, s.parked_at, s.merged_into, t.name AS table_name
      FROM table_sessions s JOIN dining_tables t ON t.id = s.table_id WHERE s.id = ${id} FOR UPDATE OF s`;
    if (s!.status !== 'open') throw conflict('TABLE_CLOSED', '这桌已经结账或撤台了，请刷新');
    if (s!.parkedAt) throw conflict('TABLE_PARKED', '这桌已经转挂账了');
    if (s!.tableId !== peek.tableId) throw conflict('TABLE_MOVED', '这桌刚刚换了台，请刷新后再转');
    const [sub] = await tx<{ id: number }[]>`SELECT id FROM table_sessions WHERE merged_into = ${id} AND status = 'open' LIMIT 1`;
    if (s!.mergedInto || sub) throw conflict('TABLE_MERGED', '并着台的先拆台，再转挂账');
    await tx`UPDATE table_sessions SET parked_at = ${at}, parked_by = ${ctx.actor.id}, park_reason = ${reason} WHERE id = ${id}`;
    await writeAudit(tx, {
      staffId: ctx.actor.id,
      action: 'table_park',
      targetType: 'table_session',
      targetId: id,
      detail: { sessionNo: s!.sessionNo, table: s!.tableName, reason },
      ip: ctx.ip,
      businessDate: await businessDate(tx, deps, at),
    });
  });
  return parkedTableSessions(deps.sql);
}

/** 挂账中的单（还没结的）：哪张桌转过来的、几点、谁、原因、多少钱 */
export async function parkedTableSessions(db: Db) {
  const rows = await db<{ id: number; sessionNo: string; tableName: string; guestLabel: string; memberName: string | null; amount: number; parkedAt: Date; parkedByName: string; reason: string }[]>`
    SELECT s.id, s.session_no, t.name AS table_name, s.guest_label, m.name AS member_name, b.amount_cents AS amount,
           s.parked_at, st.display_name AS parked_by_name, s.park_reason AS reason
    FROM table_sessions s JOIN dining_tables t ON t.id = s.table_id JOIN bills b ON b.id = s.bill_id
    JOIN staff st ON st.id = s.parked_by LEFT JOIN members m ON m.id = s.member_id
    WHERE s.status = 'open' AND s.parked_at IS NOT NULL AND s.store_id = ${currentStoreId()} ORDER BY s.parked_at, s.id`;
  return { parked: rows.map((r) => ({ ...r, amount: Number(r.amount), parkedAt: new Date(r.parkedAt).toISOString() })) };
}

export function registerTableChargeRoutes(app: FastifyInstance, deps: Deps) {
  app.get('/api/dining/tables/parked', { preHandler: guardAny('dining.order', 'frontdesk.checkout') }, async () => parkedTableSessions(deps.sql));
  app.post('/api/dining/tables/sessions/:id/park', { preHandler: guard('dining.order') }, async (req) => parkTableSession(deps, parse(idParam, req.params).id, req.body, ctxOf(req)));
}
