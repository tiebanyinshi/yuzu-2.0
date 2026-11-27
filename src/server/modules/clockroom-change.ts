// 换项目 / 换工种、超时退技师（8.2.2，《技师排班系统需求沟通会》，docs/V8222_TECHNICIANS.md 第 3、4 节）。
//
// 换项目：上钟不满规定分钟数（钟房规则「上钟后多少分钟内可以换项目」，默认 15；还没上钟的随时可以换），客人要换一个项目：
//   · 同一位技师能做新项目——原来的明细作废（原因「换项目：…」），按新项目挂一条（价格、技师能不能做都走前台挂账的核对），
//     钟单改成新项目、钟数与计划时长按新项目算，不另建钟单、不动排位、上钟时刻照旧；
//   · 原技师做不了新项目（换工种：中医换采耳之类），或者店员另选了技师——原钟单收尾（没上钟的记取消、上了钟的记被退，原因「换工种：…」），
//     原技师回到派这一钟之前的排位（queue_key_before），不算被退钟的次数；新技师按派钟的规矩上（轮钟要轮到他、跳过要写原因），原来在钟上的马上上钟。
//   两种都在 technician_session_changes 留一条记录，看板上钟单标「换过项目」。
// 锁（与退钟、转钟同一个顺序，docs/LOCKING.md 第 1 节钟房）：来访 → 账单 → 原明细（id 升序）→ 技师队列 → 原钟单 → 技师状态 →（新挂的明细、钟单）。
// 带操作编号（记成挂账 bill_post，查回、确认作废与派钟相同），超时后原样重提返回原结果。
//
// 超时退技师：退钟、取消派钟原来只有「作废与撤销」的岗位，或者本人在本人挂的 15 分钟内能做；超时的提示「请由店主处理」。
// 8.2.2 加一项权限「超时退技师」（默认值班经理及以上，后台岗位权限可改），有的直接退；没有的提示改走退项（写清楚去哪做）。

import { z } from 'zod';
import { can } from '@shared/permissions';
import { CALL_TYPES, type CallType } from '@shared/technicians';
import type { FrontdeskRules } from '@shared/frontdesk';
import type { Tx } from '../db';
import type { Actor, Deps, OpContext } from '../lib/context';
import { AppError, conflict, notFound, unprocessable } from '../lib/errors';
import { parse, positiveCents } from '../lib/validate';
import { currentStoreId } from '../lib/store-context';
import { assertOpen, businessDate, hashRequest, loadBills, lockVisits, runIdempotent } from './frontdesk';
import { clockroomBoard, loadClockroomRules, lockQueue, logEvent, offStatus, statusMap, writeStatus, type SessionLine } from './clockroom';
import { locateSessionEnd } from './locations';
import { writeAudit } from '../lib/audit';

// ───────────────────────── 超时退技师 ─────────────────────────

/** 退项去哪做（没有「超时退技师」的人超时后看到的提示） */
export const VOID_LATE_HINT = '请当班管理层（值班经理及以上）在钟房退钟；或者走退项：在收银台打开这张手牌的账单，把这一项作废并写原因（要值班经理及以上确认），已经结账的开退款单';

/**
 * 退钟 / 取消派钟能不能做：有「超时退技师」或「作废与撤销」的随时可以；其他人只能退自己挂的、规定分钟内的（与前台更正同一个时限）
 */
export function assertCanVoidSession(actor: Actor, lines: { postedBy: number; postedAt: string }[], rules: FrontdeskRules, now: Date) {
  if (can(actor, 'technician.voidLate') || can(actor, 'frontdesk.correct')) return;
  for (const l of lines) {
    const minutes = (now.getTime() - new Date(l.postedAt).getTime()) / 60_000;
    if (Number(l.postedBy) === actor.id && minutes <= rules.selfVoidMinutes) continue;
    const why = Number(l.postedBy) === actor.id ? `这张钟单挂账已超过 ${rules.selfVoidMinutes} 分钟` : '这张钟单不是你挂的账';
    throw new AppError(403, 'VOID_LATE', `${why}，不能直接退：${VOID_LATE_HINT}`);
  }
}

// ───────────────────────── 换项目：挂账时改钟单（attachSessions 调用） ─────────────────────────

/**
 * 同一位技师换项目：在挂新明细的事务里（来访、账单、技师队列都已锁好），把钟单改成新项目。
 * 只认一条新明细、同一位技师、同一位客人；钟单要还没结束
 */
export async function applyItemChange(
  tx: Tx,
  a: { sessionId: number; visitId: number; lines: SessionLine[]; perClock: (itemId: number) => number; actor: Actor; today: string; at: Date },
): Promise<number[]> {
  const [s] = await tx<{ id: number; sessionNo: string; technicianId: number; visitId: number; status: string }[]>`
    SELECT id, session_no, technician_id, visit_id, status FROM technician_sessions WHERE id = ${a.sessionId} AND store_id = ${currentStoreId()} FOR UPDATE`;
  if (!s) throw notFound('钟单不存在');
  const l = a.lines[0];
  if (a.lines.length !== 1 || !l || Number(s.visitId) !== a.visitId || Number(s.technicianId) !== l.technicianId) {
    throw conflict('SESSION_MISMATCH', '换项目的技师或客人与钟单不一致，请刷新后重试');
  }
  if (s.status !== 'waiting' && s.status !== 'serving') throw conflict('SESSION_CLOSED', `钟单 ${s.sessionNo} 已结束，不能再换项目`);
  await tx`
    UPDATE technician_sessions SET item_id = ${l.itemId}, clocks = ${l.quantity}, minutes = ${Math.max(1, a.perClock(l.itemId) * l.quantity)}
    WHERE id = ${s.id}`;
  return [s.id];
}

// ───────────────────────── 换项目 / 换工种 ─────────────────────────

export const ChangeItemInput = z.object({
  clientKey: z.uuid('缺少有效的操作编号，请刷新页面后重试'),
  itemId: z.number('请选换成哪个项目').int().positive('请选换成哪个项目'),
  tier: z.enum(['standard', 'professional', 'premium']).optional(),
  quantity: z.number().int().min(1, '钟数至少为 1').max(9, '一次最多 9 个钟'),
  /** 换给的技师：不带是原技师（同一位技师换项目）；带了别人就是换工种 */
  technicianId: z.number().int().positive().optional(),
  callType: z.enum(CALL_TYPES, '上钟方式应为轮钟、点钟或扩钟').optional(),
  reason: z.string().trim().min(2, '请写换项目的原因（至少 2 个字）').max(100, '原因最多 100 字'),
  skipReason: z.string().trim().max(100, '原因最多 100 字').optional(),
  expectedTotal: positiveCents('本次合计'),
});

export async function changeSessionItem(deps: Deps, sessionId: number, raw: unknown, ctx: OpContext) {
  const input = parse(ChangeItemInput, raw);
  const { clientKey: key, ...payload } = input;
  const requestHash = hashRequest({ op: 'session_change', sessionId, ...payload });
  const [peek] = await deps.sql<{ visitId: number }[]>`SELECT visit_id FROM technician_sessions WHERE id = ${sessionId} AND store_id = ${currentStoreId()}`;
  if (!peek) throw notFound('钟单不存在');
  const { PostInput, postChargesTx } = await loadBills();
  await runIdempotent(deps, { key, opType: 'bill_post', requestHash }, async (tx) => {
    const at = ctx.at ?? new Date();
    const visit = (await lockVisits(tx, [Number(peek.visitId)])).get(Number(peek.visitId))!;
    assertOpen(visit);
    const [bill] = await tx<{ status: string }[]>`SELECT status FROM bills WHERE id = ${visit.billId} FOR UPDATE`;
    if (bill!.status !== 'open') throw conflict('BILL_CLOSED', '账单已结束，不能再换项目');
    const lines = await tx<{ id: number; name: string; quantity: number; amount: number }[]>`
      SELECT id, name, quantity, amount FROM bill_lines WHERE session_id = ${sessionId} AND status = 'active' ORDER BY id FOR UPDATE`;
    await lockQueue(tx);
    const [old] = await tx<
      {
        id: number;
        sessionNo: string;
        technicianId: number;
        itemId: number;
        callType: CallType;
        status: string;
        startedAt: string | null;
        queueKeyBefore: string | null;
        spaceId: number | null;
        bookingId: number | null;
      }[]
    >`
      SELECT id, session_no, technician_id, item_id, call_type, status, started_at, queue_key_before, space_id, booking_id
      FROM technician_sessions WHERE id = ${sessionId} FOR UPDATE`;
    if (old!.status !== 'waiting' && old!.status !== 'serving') throw conflict('SESSION_CLOSED', `钟单 ${old!.sessionNo} 已结束，不能再换项目`);
    if (lines.length === 0) throw conflict('SESSION_NO_LINES', `钟单 ${old!.sessionNo} 没有有效的挂账，不能换项目（请刷新）`);
    const rules = await loadClockroomRules(tx);
    if (old!.status === 'serving' && old!.startedAt) {
      const minutes = Math.floor((at.getTime() - new Date(old!.startedAt).getTime()) / 60_000);
      if (minutes >= rules.changeItemMinutes) {
        throw unprocessable('CHANGE_TOO_LATE', `钟单 ${old!.sessionNo} 已上钟 ${minutes} 分钟，上钟满 ${rules.changeItemMinutes} 分钟不能换项目：要换请先退钟（超时退钟要当班管理层），再重新派`);
      }
    }
    const oldTech = Number(old!.technicianId);
    const newTech = input.technicianId ?? oldTech;
    const sameTech = newTech === oldTech;
    if (sameTech && input.itemId === Number(old!.itemId)) throw unprocessable('CHANGE_SAME', '换成的还是原来的项目，请选另一个项目');
    const [items] = await tx<{ fromName: string; toName: string }[]>`
      SELECT (SELECT name FROM service_items WHERE id = ${old!.itemId}) AS from_name, (SELECT name FROM service_items WHERE id = ${input.itemId}) AS to_name`;
    if (!items?.toName) throw notFound('换成的项目不存在，请刷新');
    const today = await businessDate(tx, deps, at);

    // 原来的明细作废（金额从账单里减掉）
    for (const l of lines) {
      await tx`UPDATE bill_lines SET status = 'voided', void_reason = ${`换项目：${input.reason}`}, voided_by = ${ctx.actor.id}, voided_at = ${at} WHERE id = ${l.id}`;
    }
    const total = lines.reduce((n, l) => n + l.amount, 0);
    await tx`UPDATE bills SET amount_cents = amount_cents - ${total}, line_count = line_count - ${lines.length} WHERE id = ${visit.billId}`;

    const [techs] = await tx<{ fromLabel: string; toLabel: string }[]>`
      SELECT (SELECT tech_no || ' 号 ' || name FROM technicians WHERE id = ${oldTech}) AS from_label,
             (SELECT tech_no || ' 号 ' || name FROM technicians WHERE id = ${newTech}) AS to_label`;
    if (!techs?.toLabel) throw notFound('换给的技师不存在，请刷新');
    if (!sameTech) {
      // 换工种：原钟单收尾，原技师回到派这一钟之前的排位（不算被退钟）
      const serving = old!.status === 'serving';
      await tx`
        UPDATE technician_sessions SET status = ${serving ? 'rejected' : 'cancelled'}, ended_at = ${at}, ended_by = ${ctx.actor.id}, void_reason = ${`换工种：${input.reason}`}
        WHERE id = ${old!.id}`;
      const st = (await statusMap(tx, today)).get(oldTech) ?? offStatus;
      if (st.state !== 'off' && old!.queueKeyBefore) await writeStatus(tx, oldTech, today, { ...st, queueKey: new Date(old!.queueKeyBefore) }, ctx.actor.id, at);
      await logEvent(tx, {
        technicianId: oldTech,
        sessionId: old!.id,
        kind: 'change',
        detail: { item: items.toName, to: techs.toLabel, reason: input.reason },
        staffId: ctx.actor.id,
        businessDate: today,
        at,
      });
      if (serving) await locateSessionEnd(tx, [{ id: old!.id, technicianId: oldTech, spaceId: old!.spaceId }], { at, staffId: ctx.actor.id });
    }

    const post = parse(PostInput, {
      clientKey: key,
      lines: [{ itemId: input.itemId, quantity: input.quantity, tier: input.tier, technicianId: newTech, callType: input.callType ?? old!.callType }],
      expectedTotal: input.expectedTotal,
    });
    const posted = await postChargesTx(tx, deps, visit.id, post, { key, requestHash, backfill: null }, ctx, {
      session: sameTech
        ? { changeId: old!.id }
        : {
            dispatch: {
              startNow: old!.status === 'serving',
              skipReason: input.skipReason,
              spaceId: old!.spaceId ?? undefined,
              bookingId: old!.bookingId ?? undefined,
              excludeId: oldTech,
            },
          },
    });
    const [line] = await tx<{ sessionId: number }[]>`SELECT session_id FROM bill_lines WHERE id = ${posted.lines[0]!.lineId}`;
    const newSessionId = sameTech ? null : Number(line!.sessionId);
    await tx`
      INSERT INTO technician_session_changes (session_id, new_session_id, kind, from_item_id, to_item_id, reason, created_by, created_at)
      VALUES (${old!.id}, ${newSessionId}, ${sameTech ? 'item' : 'technician'}, ${old!.itemId}, ${input.itemId}, ${input.reason}, ${ctx.actor.id}, ${at})`;
    if (sameTech) {
      await logEvent(tx, {
        technicianId: oldTech,
        sessionId: old!.id,
        kind: 'change',
        detail: { from: items.fromName, item: items.toName, reason: input.reason },
        staffId: ctx.actor.id,
        businessDate: today,
        at,
      });
    }
    await writeAudit(tx, {
      staffId: ctx.actor.id,
      action: 'clock_change',
      targetType: 'visit',
      targetId: visit.id,
      detail: {
        visitNo: visit.visitNo,
        sessionNo: old!.sessionNo,
        kind: sameTech ? 'item' : 'technician',
        from: `${items.fromName}（${techs.fromLabel}）`,
        to: `${items.toName} × ${input.quantity}（${techs.toLabel}）`,
        voided: total,
        posted: posted.total,
        reason: input.reason,
      },
      ip: ctx.ip,
      businessDate: today,
    });
    return visit.id;
  });
  return clockroomBoard(deps.sql, deps);
}
