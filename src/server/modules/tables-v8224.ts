// 8.2.4 餐饮（会议纪要「餐饮系统需求对接会」，docs/V8224_DINING.md 第 2、4 节）：包房房型与返台。
//
//   · 房型：小房、中房、大房……（可加），每个房型按低消收（另有中消档：开台时刻在中消时段里、或人数不超过中消人数的按中消）
//     或只收房费；桌台挂房型后低消按房型的，桌台自己设了低消的优先（结账的算法在 table-charges.ts 的 tableChargesOf）；
//   · 返台：只有包房（这一次开台有低消）、而且低消没够才能返台——
//       - 转挂账的单：回到原来的桌台继续点（桌台要空着、可用）；
//       - 已结账的单：客人还没走（桌台还在待清台、结账后不超过「返台时限」）、结账时记了「低消补足」的，同一个事务里反结账那张结账单
//         （钱照反结账退：储值撤销、券退回……，frontdesk/checkout.ts 的 voidCheckout），自动记的服务费、低消补足、房费作废（下次结账按此刻重算），
//         桌台回到用餐中；要「返台」与「反结账」两项权限；
//     要写原因、记审计；操作编号（clientKey）写在返台记录上，同一编号重提返回第一次的结果。
// 锁：转挂账回来——操作编号的咨询锁 → 桌台 → 开台（与转挂账、换台同一顺序）；已结账回来——操作编号的咨询锁 → voidCheckout 的顺序
// （班次 → 结账单 → 桌台 → 开台 → 账单 → 会员 → 券……），返台的核对与写入在它的事务里、账单锁之后做。
// 这个文件不引用 tables.ts（tables.ts 引用这里的房型读取）。

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { formatYuan } from '@shared/money';
import { can } from '@shared/permissions';
import { MAX_ROOM_TYPE_NAME, MAX_ROOM_TYPES, ROOM_CHARGE_MODES, type DiningRoomType, type ReturnableSession } from '@shared/dining-v8224';
import type { Db, Tx } from '../db';
import { guard } from '../auth/guard';
import { writeAudit } from '../lib/audit';
import { ctxOf, type Deps, type OpContext } from '../lib/context';
import { AppError, conflict, forbidden, notFound, unprocessable } from '../lib/errors';
import { idParam, parse } from '../lib/validate';
import { currentStoreId } from '../lib/store-context';
import { businessDate, setTxTimeouts, voidCheckout } from './frontdesk';
import { tableChargesOf } from './table-charges';
import { loadDiningRules } from './dining';

// ───────────────────────── 房型 ─────────────────────────

export async function roomTypesOf(db: Db): Promise<DiningRoomType[]> {
  const rows = await db<(Omit<DiningRoomType, 'minSpend' | 'midSpend' | 'roomFee'> & { minSpend: string; midSpend: string; roomFee: string })[]>`
    SELECT r.id, r.name, r.charge_mode, r.min_spend, r.mid_spend, r.mid_start_minute AS mid_start, r.mid_end_minute AS mid_end, r.mid_max_guests,
           r.room_fee, r.sort_order, r.active, (SELECT count(*) FROM dining_tables t WHERE t.room_type_id = r.id)::int AS table_count
    FROM dining_room_types r WHERE r.store_id = ${currentStoreId()} ORDER BY r.sort_order, r.id`;
  return rows.map((r) => ({ ...r, minSpend: Number(r.minSpend), midSpend: Number(r.midSpend), roomFee: Number(r.roomFee) }));
}

/** 桌台挂的房型：这家店的、在用的（这张桌原来就挂着的停用房型照留） */
export async function assertRoomTypeUsable(tx: Tx, roomTypeId: number, tableId: number | null) {
  const [r] = await tx<{ name: string; active: boolean }[]>`SELECT name, active FROM dining_room_types WHERE id = ${roomTypeId} AND store_id = ${currentStoreId()}`;
  if (!r) throw notFound('房型不存在，请刷新后重选');
  if (r.active) return;
  const [kept] = tableId === null ? [] : await tx`SELECT 1 FROM dining_tables WHERE id = ${tableId} AND room_type_id = ${roomTypeId}`;
  if (!kept) throw unprocessable('ROOM_TYPE_INACTIVE', `房型「${r.name}」已停用，请换一个`);
}

const money = (label: string) => z.number(`${label}不正确`).int(`${label}不正确`).min(0, `${label}不能是负数`).max(100_000_000, `${label}最多 ¥1,000,000`);
const minute = z.number('时间不对').int('时间不对').min(0, '时间不对').max(1439, '时间不对');
const RoomTypeInput = z
  .object({
    name: z.string('请写房型名称').trim().min(1, '请写房型名称').max(MAX_ROOM_TYPE_NAME, `房型名称最多 ${MAX_ROOM_TYPE_NAME} 个字`),
    chargeMode: z.enum(ROOM_CHARGE_MODES, '请选按低消还是只收房费'),
    minSpend: money('低消').default(0),
    midSpend: money('中消').default(0),
    midStart: minute.nullable().default(null),
    midEnd: minute.nullable().default(null),
    midMaxGuests: z.number('人数不正确').int('人数不正确').min(1, '人数至少 1').max(99, '人数最多 99').nullable().default(null),
    roomFee: money('房费').default(0),
    sortOrder: z.number().int().min(0).max(9999).default(0),
    active: z.boolean().default(true),
  })
  .refine((r) => (r.midStart === null) === (r.midEnd === null), '中消时段要同时写开始和结束')
  .refine((r) => r.midStart === null || r.midStart !== r.midEnd, '中消时段的开始和结束不能一样')
  .refine((r) => r.chargeMode === 'room_fee' || r.midSpend === 0 || r.midStart !== null || r.midMaxGuests !== null, '设了中消，请写什么时候用中消（时段或人数）')
  .refine((r) => r.chargeMode === 'min_spend' || r.roomFee > 0, '只收房费的房型请写房费');

async function saveRoomType(deps: Deps, id: number | null, raw: unknown, ctx: OpContext) {
  const input = parse(RoomTypeInput, raw);
  // 只收房费的不设低消、中消
  const r = input.chargeMode === 'room_fee' ? { ...input, minSpend: 0, midSpend: 0, midStart: null, midEnd: null, midMaxGuests: null } : { ...input, roomFee: 0 };
  await deps.sql.begin(async (tx) => {
    // 同一家店的房型保存串行（名称不重、个数上限）
    await tx`SELECT pg_advisory_xact_lock(hashtext('dining_room_types'), ${currentStoreId()}::int)`;
    const [dup] = await tx<{ id: number }[]>`
      SELECT id FROM dining_room_types WHERE store_id = ${currentStoreId()} AND lower(btrim(name)) = lower(${r.name}) AND id IS DISTINCT FROM ${id}`;
    if (dup) throw conflict('ROOM_TYPE_NAME_TAKEN', `已有房型「${r.name}」`);
    const summary = `${r.name}：${r.chargeMode === 'room_fee' ? `只收房费 ${formatYuan(r.roomFee)}` : `低消 ${formatYuan(r.minSpend)}${r.midSpend ? `，中消 ${formatYuan(r.midSpend)}` : ''}`}${r.active ? '' : '（停用）'}`;
    if (id === null) {
      const [n] = await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM dining_room_types WHERE store_id = ${currentStoreId()}`;
      if (n!.n >= MAX_ROOM_TYPES) throw unprocessable('ROOM_TYPE_LIMIT', `一家店最多 ${MAX_ROOM_TYPES} 个房型，不用的请停用后改成别的`);
      const [row] = await tx<{ id: number }[]>`
        INSERT INTO dining_room_types (name, charge_mode, min_spend, mid_spend, mid_start_minute, mid_end_minute, mid_max_guests, room_fee, sort_order, active, created_by)
        VALUES (${r.name}, ${r.chargeMode}, ${r.minSpend}, ${r.midSpend}, ${r.midStart}, ${r.midEnd}, ${r.midMaxGuests}, ${r.roomFee}, ${r.sortOrder}, ${r.active}, ${ctx.actor.id})
        RETURNING id`;
      await writeAudit(tx, { staffId: ctx.actor.id, action: 'dining_room_type_saved', targetType: 'dining_room_type', targetId: row!.id, detail: { summary: `新建房型 ${summary}` }, ip: ctx.ip });
      return;
    }
    const [cur] = await tx<{ id: number }[]>`SELECT id FROM dining_room_types WHERE id = ${id} AND store_id = ${currentStoreId()} FOR UPDATE`;
    if (!cur) throw notFound('房型不存在');
    await tx`
      UPDATE dining_room_types SET name = ${r.name}, charge_mode = ${r.chargeMode}, min_spend = ${r.minSpend}, mid_spend = ${r.midSpend},
             mid_start_minute = ${r.midStart}, mid_end_minute = ${r.midEnd}, mid_max_guests = ${r.midMaxGuests}, room_fee = ${r.roomFee},
             sort_order = ${r.sortOrder}, active = ${r.active}, updated_at = now()
      WHERE id = ${id}`;
    await writeAudit(tx, { staffId: ctx.actor.id, action: 'dining_room_type_saved', targetType: 'dining_room_type', targetId: id, detail: { summary: `修改房型 ${summary}` }, ip: ctx.ip });
  });
}

// ───────────────────────── 返台 ─────────────────────────

const ReturnInput = z.object({
  clientKey: z.uuid('缺少有效的操作编号，请刷新页面后重试'),
  reason: z.string('请写返台的原因').trim().min(2, '请写返台的原因（至少 2 个字）').max(200, '原因最多 200 字'),
  /** 已结账的单返台要反结账：退现金记到哪个钱箱的班次（与反结账一样；不带记到自己的班次） */
  refundShiftId: z.number().int().positive().optional(),
});

/** 这个操作编号已经返过台了：同一桌照原样返回；别的桌拒绝 */
async function replayOf(db: Db, key: string, sessionId: number): Promise<boolean> {
  const [r] = await db<{ sessionId: number }[]>`SELECT session_id FROM table_session_returns WHERE client_key = ${key}`;
  if (!r) return false;
  if (Number(r.sessionId) !== sessionId) throw conflict('IDEMPOTENCY_CONFLICT', '该操作编号已用于另一桌的返台，请刷新页面后重新发起');
  return true;
}

/** 低消没够才能返台：这一次开台此刻的低消与菜钱（低消为 0 的不是包房、不能返台；够了的不用返台） */
async function assertShort(db: Db, sessionId: number, timeZone: string) {
  const c = (await tableChargesOf(db, [sessionId], timeZone)).get(sessionId)!;
  if (c.minSpend <= 0) throw conflict('RETURN_NOT_ROOM', `「${c.tableName}」不是有低消的包房，不能返台（返台只用来补低消）`);
  if (c.shortfall <= 0) throw conflict('RETURN_NOT_NEEDED', `「${c.tableName}」低消 ${formatYuan(c.minSpend)}，已经点了 ${formatYuan(c.subtotal)}，低消够了，不用返台`);
  return c;
}

/**
 * 返台：返回开台编号。转挂账的单回到桌台；已结账的单反结账后回到桌台（见文件开头）。
 * 同一操作编号重提返回第一次的结果（不再按此刻核对）
 */
export async function returnTableSession(deps: Deps, sessionId: number, raw: unknown, ctx: OpContext): Promise<number> {
  const input = parse(ReturnInput, raw);
  if (await replayOf(deps.sql, input.clientKey, sessionId)) return sessionId;
  const [peek] = await deps.sql<{ status: string; parkedAt: Date | null; tableId: number }[]>`
    SELECT status, parked_at, table_id FROM table_sessions WHERE id = ${sessionId} AND store_id = ${currentStoreId()}`;
  if (!peek) throw notFound('这次开台不存在');
  if (peek.status === 'open' && peek.parkedAt) {
    await returnParked(deps, sessionId, input, ctx);
    return sessionId;
  }
  if (peek.status !== 'settled') {
    throw conflict('RETURN_NOT_ALLOWED', peek.status === 'open' ? '这桌还在用餐，直接点菜就行，不用返台' : '这次开台已撤台，不能返台');
  }
  if (!can(ctx.actor, 'frontdesk.checkoutVoid')) throw forbidden('已结账的单返台要先反结账，当前岗位不能反结账；请值班经理以上操作');
  const [co] = await deps.sql<{ checkoutId: number; sessions: number; visits: number }[]>`
    SELECT c.id AS checkout_id,
           (SELECT count(*) FROM checkout_bills x WHERE x.checkout_id = c.id AND x.table_session_id IS NOT NULL)::int AS sessions,
           (SELECT count(*) FROM checkout_bills x WHERE x.checkout_id = c.id AND x.visit_id IS NOT NULL)::int AS visits
    FROM checkout_bills cb JOIN checkouts c ON c.id = cb.checkout_id
    WHERE cb.table_session_id = ${sessionId} AND c.status = 'completed' ORDER BY c.id DESC LIMIT 1`;
  if (!co) throw conflict('RETURN_NOT_ALLOWED', '找不到这桌的结账单，请刷新');
  if (co.sessions !== 1 || co.visits !== 0) throw conflict('RETURN_MERGED', '这张结账单一起结了几桌，不能单独返台；要改请反结账');
  try {
    await voidCheckout(deps, co.checkoutId, { reason: `返台补低消：${input.reason}`, refundShiftId: input.refundShiftId }, ctx, {
      afterRestore: (tx, c) => finishSettledReturn(tx, deps, { sessionId, key: input.clientKey, reason: input.reason, checkout: c, ctx }),
    });
  } catch (e) {
    // 同一编号的两次提交同时到：后到的那次等结账单锁，看到已经反结账了；第一次已经记下返台的就照第一次返回
    if (e instanceof AppError && e.code === 'ALREADY_VOIDED' && (await replayOf(deps.sql, input.clientKey, sessionId))) return sessionId;
    throw e;
  }
  return sessionId;
}

async function returnParked(deps: Deps, sessionId: number, input: z.output<typeof ReturnInput>, ctx: OpContext) {
  await deps.sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    const at = ctx.at ?? new Date();
    // 操作编号的咨询锁 → 桌台 → 开台
    await tx`SELECT pg_advisory_xact_lock(hashtext(${input.clientKey}))`;
    if (await replayOf(tx, input.clientKey, sessionId)) return;
    const [peek] = await tx<{ tableId: number }[]>`SELECT table_id FROM table_sessions WHERE id = ${sessionId}`;
    const [t] = await tx<{ id: number; name: string; active: boolean; state: string; maintenanceReason: string | null }[]>`
      SELECT id, name, active, state, maintenance_reason FROM dining_tables WHERE id = ${peek!.tableId} FOR UPDATE`;
    const [s] = await tx<{ sessionNo: string; status: string; tableId: number; parkedAt: Date | null; shared: boolean }[]>`
      SELECT session_no, status, table_id, parked_at, shared FROM table_sessions WHERE id = ${sessionId} FOR UPDATE`;
    if (s!.status !== 'open' || !s!.parkedAt) throw conflict('RETURN_NOT_ALLOWED', '这桌已经不是转挂账的单了，请刷新');
    if (s!.tableId !== t!.id) throw conflict('TABLE_MOVED', '这桌刚刚换了台，请刷新后再返台');
    if (!t!.active) throw conflict('TABLE_INACTIVE', `桌台「${t!.name}」已停用，不能返台`);
    if (t!.state === 'maintenance') throw conflict('TABLE_MAINTENANCE', `桌台「${t!.name}」在维修（${t!.maintenanceReason ?? ''}），不能返台`);
    if (t!.state === 'dirty') throw conflict('TABLE_DIRTY', `桌台「${t!.name}」待清台，请先清台再返台`);
    const [busy] = await tx<{ sessionNo: string }[]>`
      SELECT session_no FROM table_sessions WHERE table_id = ${t!.id} AND status = 'open' AND parked_at IS NULL AND NOT shared AND id <> ${sessionId}`;
    if (busy && !s!.shared) throw conflict('TABLE_TAKEN', `桌台「${t!.name}」已经开给别的客人了（${busy.sessionNo}），不能返台`);
    const c = await assertShort(tx, sessionId, deps.config.timezone);
    await tx`UPDATE table_sessions SET parked_at = NULL, parked_by = NULL, park_reason = NULL WHERE id = ${sessionId}`;
    await tx`
      INSERT INTO table_session_returns (session_id, table_id, kind, checkout_id, min_spend, subtotal, reason, client_key, created_by, created_at)
      VALUES (${sessionId}, ${t!.id}, 'parked', NULL, ${c.minSpend}, ${c.subtotal}, ${input.reason}, ${input.clientKey}, ${ctx.actor.id}, ${at})`;
    await writeAudit(tx, {
      staffId: ctx.actor.id,
      action: 'table_return',
      targetType: 'table_session',
      targetId: sessionId,
      detail: { sessionNo: s!.sessionNo, table: t!.name, from: 'parked', minSpend: c.minSpend, subtotal: c.subtotal, shortfall: c.shortfall, reason: input.reason },
      ip: ctx.ip,
      businessDate: await businessDate(tx, deps, at),
    });
  });
}

/**
 * 已结账的单返台：在 voidCheckout 的事务里（结账单、桌台、开台、账单都已锁，开台、账单已恢复成没结）核对能不能返台，
 * 作废结账时自动记的几行、桌台回到用餐中、记下返台。哪一样不行就整笔回滚（反结账也不做）
 */
async function finishSettledReturn(tx: Tx, deps: Deps, a: { sessionId: number; key: string; reason: string; checkout: { id: number; checkoutNo: string; createdAt: Date; at: Date }; ctx: OpContext }) {
  await tx`SELECT pg_advisory_xact_lock(hashtext(${a.key}))`;
  if (await replayOf(tx, a.key, a.sessionId)) throw conflict('ALREADY_VOIDED', '这桌已经返过台了');
  const [s] = await tx<{ sessionNo: string; billId: number; tableId: number; tableName: string; state: string }[]>`
    SELECT s.session_no, s.bill_id, s.table_id, t.name AS table_name, t.state FROM table_sessions s JOIN dining_tables t ON t.id = s.table_id WHERE s.id = ${a.sessionId}`;
  const rules = await loadDiningRules(tx);
  // 客人一走就清台：清过台的（或结账后超过返台时限的）不能返台
  if (rules.clearAfterCheckout && s!.state !== 'dirty') throw conflict('RETURN_TABLE_CLEARED', `桌台「${s!.tableName}」已经清台（客人走了），不能返台`);
  if (s!.state === 'maintenance') throw conflict('TABLE_MAINTENANCE', `桌台「${s!.tableName}」在维修，不能返台`);
  const minutes = (a.checkout.at.getTime() - new Date(a.checkout.createdAt).getTime()) / 60_000;
  if (minutes > rules.returnWindowMinutes) {
    throw conflict('RETURN_WINDOW', `结账已经 ${Math.floor(minutes)} 分钟了，超过返台时限（${rules.returnWindowMinutes} 分钟）；要改请反结账`, { windowMinutes: rules.returnWindowMinutes });
  }
  // 低消没够才返台：结账时记了「低消补足」的
  const [topUp] = await tx<{ amount: number }[]>`
    SELECT amount FROM bill_lines WHERE bill_id = ${s!.billId} AND status = 'active' AND charge_kind = 'min_spend' LIMIT 1`;
  if (!topUp) throw conflict('RETURN_NOT_NEEDED', `结账单 ${a.checkout.checkoutNo} 没有补低消（低消够了），不用返台；要改请反结账`);
  const c = await assertShort(tx, a.sessionId, deps.config.timezone);
  // 结账时自动记的服务费、低消补足、房费作废：再结账时按此刻重算（账单已锁）
  const voided = await tx<{ amount: number }[]>`
    UPDATE bill_lines SET status = 'voided', void_reason = ${`返台补低消，结账时重算（${a.checkout.checkoutNo}）`}, voided_by = ${a.ctx.actor.id}, voided_at = ${a.checkout.at}
    WHERE bill_id = ${s!.billId} AND status = 'active' AND charge_kind IS NOT NULL RETURNING amount`;
  const gone = voided.reduce((t, v) => t + Number(v.amount), 0);
  if (voided.length) await tx`UPDATE bills SET amount_cents = amount_cents - ${gone}, line_count = line_count - ${voided.length} WHERE id = ${s!.billId}`;
  // 桌台回到用餐中（待清台的取消）
  await tx`UPDATE dining_tables SET state = 'available', state_since = ${a.checkout.at}, updated_at = now() WHERE id = ${s!.tableId} AND state = 'dirty'`;
  await tx`
    INSERT INTO table_session_returns (session_id, table_id, kind, checkout_id, min_spend, subtotal, reason, client_key, created_by, created_at)
    VALUES (${a.sessionId}, ${s!.tableId}, 'settled', ${a.checkout.id}, ${c.minSpend}, ${c.subtotal}, ${a.reason}, ${a.key}, ${a.ctx.actor.id}, ${a.checkout.at})`;
  await writeAudit(tx, {
    staffId: a.ctx.actor.id,
    action: 'table_return',
    targetType: 'table_session',
    targetId: a.sessionId,
    detail: {
      sessionNo: s!.sessionNo,
      table: s!.tableName,
      from: 'settled',
      checkoutNo: a.checkout.checkoutNo,
      minSpend: c.minSpend,
      subtotal: c.subtotal,
      shortfall: c.shortfall,
      voidedCharges: gone,
      reason: a.reason,
    },
    ip: a.ctx.ip,
    businessDate: await businessDate(tx, deps, a.checkout.at),
  });
}

/**
 * 桌台上一次结了账、补了低消、还能返台的那次开台（桌台页待清台的桌上「返台」用；只读）。没有的为空——真正能不能返台在返台的事务里再核对
 */
export async function returnableOf(db: Db, tableId: number): Promise<ReturnableSession | null> {
  const [r] = await db<{ sessionId: number; sessionNo: string; checkoutNo: string; checkedOutAt: Date; topUp: number }[]>`
    SELECT s.id AS session_id, s.session_no, c.checkout_no, c.created_at AS checked_out_at, l.amount AS top_up
    FROM table_sessions s JOIN checkout_bills cb ON cb.table_session_id = s.id JOIN checkouts c ON c.id = cb.checkout_id AND c.status = 'completed'
    JOIN bill_lines l ON l.bill_id = s.bill_id AND l.status = 'active' AND l.charge_kind = 'min_spend'
    WHERE s.table_id = ${tableId} AND s.status = 'settled' AND s.store_id = ${currentStoreId()}
    ORDER BY c.id DESC LIMIT 1`;
  if (!r) return null;
  return { sessionId: Number(r.sessionId), sessionNo: r.sessionNo, checkoutNo: r.checkoutNo, checkedOutAt: new Date(r.checkedOutAt).toISOString(), topUp: Number(r.topUp) };
}

export function registerTablesV8224Routes(app: FastifyInstance, deps: Deps) {
  app.get('/api/dining/tables/:id/returnable', { preHandler: guard('dining.returnTable') }, async (req) => ({ session: await returnableOf(deps.sql, parse(idParam, req.params).id) }));
  app.post('/api/admin/dining/room-types', { preHandler: guard('catalog.manage') }, async (req) => {
    await saveRoomType(deps, null, req.body, ctxOf(req));
    return { roomTypes: await roomTypesOf(deps.sql) };
  });
  app.put('/api/admin/dining/room-types/:id', { preHandler: guard('catalog.manage') }, async (req) => {
    await saveRoomType(deps, parse(idParam, req.params).id, req.body, ctxOf(req));
    return { roomTypes: await roomTypesOf(deps.sql) };
  });
  app.post('/api/dining/tables/sessions/:id/return', { preHandler: guard('dining.returnTable') }, async (req) => {
    const id = await returnTableSession(deps, parse(idParam, req.params).id, req.body, ctxOf(req));
    const { getTableSession } = await import('./tables');
    return getTableSession(deps.sql, id);
  });
}
