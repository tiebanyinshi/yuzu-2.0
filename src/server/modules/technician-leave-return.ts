// 长假一次设好、到期自动上牌（8.2.2，《技师排班系统需求沟通会》四；docs/V8222_TECHNICIANS.md 第 5 节）。
//
// 钟房的「休假」入口原来只管今天（休假一天一天点，休完还要手动取消）。现在可以直接设天数：从今天起连休 N 天（最多 LEAVE_MAX_DAYS），
// 记成一张休假单——有「维护技师名册」的直接批准（今天起就是休假，排位里没有他），没有的记成待审批、等技师管理批（今天照旧）。
// 休假单默认「休完自动上牌」：每分钟的任务看已批准、休完了（最后一天早于今天）、还没处理的单，在休完后的第一个营业日给他上牌、排到队尾。
// 那天已经有人动过他的状态（手动上牌、下牌、又设了休假）、今天排休、停牌、停用的不动，只记下处理过；休完超过 7 天才看到的（应用停了很久）也不补上牌。
// 锁：与技师管理批准休假相同——技师队列 → 技师一行 → 休假单一行 → 技师状态；设天数的另带操作编号（technician_state）。

import { z } from 'zod';
import { can } from '@shared/permissions';
import { LEAVE_MAX_DAYS, LEAVE_TYPE_LABELS, LEAVE_TYPES, leaveRangeText } from '@shared/technician-admin';
import type { Sql, Tx } from '../db';
import { writeAudit } from '../lib/audit';
import type { Deps, OpContext } from '../lib/context';
import { conflict, notFound, unprocessable } from '../lib/errors';
import { parse } from '../lib/validate';
import { currentStoreId, forEachStore } from '../lib/store-context';
import { businessDate, hashRequest, runIdempotent, saveKey, setTxTimeouts } from './frontdesk/common';
import { clockroomBoard, loadClockroomRules, lockQueue, logEvent, statusMap, syncLeaveToday, writeStatus } from './clockroom';
import { scheduleOn } from './technician-day';
import { locateSignIn } from './locations';
import { systemStaffId } from './system-staff';

const plusDays = (date: string, n: number) => new Date(Date.parse(`${date}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

export const LeaveDaysInput = z.object({
  clientKey: z.uuid('缺少有效的操作编号，请刷新页面后重试'),
  days: z.number('请写休几天').int('天数写整数').min(1, '至少休 1 天').max(LEAVE_MAX_DAYS, `一次最多 ${LEAVE_MAX_DAYS} 天，更长的到「技师管理 → 休假」分开申请`),
  leaveType: z.enum(LEAVE_TYPES, '请选择休假类型').default('rest'),
  reason: z.string().trim().min(2, '请写休假原因（至少 2 个字）').max(100, '原因最多 100 字'),
  /** 休完自动上牌（默认是） */
  autoReturn: z.boolean().default(true),
});

/** 钟房设长假：从今天起连休 days 天 */
export async function setLeaveDays(deps: Deps, technicianId: number, raw: unknown, ctx: OpContext) {
  const a = parse(LeaveDaysInput, raw);
  const approve = can(ctx.actor, 'technician.manage');
  const requestHash = hashRequest({ technicianId, leaveDays: a.days, leaveType: a.leaveType, reason: a.reason, autoReturn: a.autoReturn });
  await runIdempotent(deps, { key: a.clientKey, opType: 'technician_state', requestHash }, async (tx) => {
    await setTxTimeouts(tx);
    const at = ctx.at ?? new Date();
    await lockQueue(tx);
    const [t] = await tx<{ id: number; techNo: string; name: string; active: boolean }[]>`
      SELECT id, tech_no, name, active FROM technicians WHERE id = ${technicianId} AND store_id = ${currentStoreId()} FOR UPDATE`;
    if (!t) throw notFound('技师不存在');
    if (!t.active) throw unprocessable('TECHNICIAN_INACTIVE', `${t.techNo} 号 ${t.name}已停用`);
    const label = `${t.techNo} 号 ${t.name}`;
    const today = await businessDate(tx, deps, at);
    const range = { fromDate: today, toDate: plusDays(today, a.days - 1) };
    const [overlap] = await tx<{ fromDate: string; toDate: string }[]>`
      SELECT from_date::text AS from_date, to_date::text AS to_date FROM technician_leaves
      WHERE technician_id = ${t.id} AND status IN ('pending', 'approved') AND from_date <= ${range.toDate} AND to_date >= ${range.fromDate} ORDER BY id LIMIT 1`;
    if (overlap) throw conflict('LEAVE_OVERLAP', `${label}在 ${leaveRangeText(overlap)} 已经有休假单了，日期重叠；要改请到「技师管理 → 休假」`);
    const [row] = await tx<{ id: number }[]>`
      INSERT INTO technician_leaves (technician_id, from_date, to_date, leave_type, reason, client_key, applied_by, applied_at, status, decided_by, decided_at, auto_return)
      VALUES (${t.id}, ${range.fromDate}, ${range.toDate}, ${a.leaveType}, ${a.reason}, ${a.clientKey}, ${ctx.actor.id}, ${at},
              ${approve ? 'approved' : 'pending'}, ${approve ? ctx.actor.id : null}, ${approve ? at : null}, ${a.autoReturn})
      RETURNING id`;
    const leaveId = Number(row!.id);
    // 直接批准的：今天起就是休假（在钟上、有派了没上的钟的拒绝，先下钟或转钟）
    if (approve) await syncLeaveToday(tx, deps, { id: t.id, label }, 'on', leaveId, ctx, at);
    await writeAudit(tx, {
      staffId: ctx.actor.id,
      action: 'technician_leave',
      targetType: 'technician_leave',
      targetId: leaveId,
      detail: {
        action: approve ? 'apply_approve' : 'apply',
        days: a.days,
        autoReturn: a.autoReturn,
        summary: `钟房设休假：${label}${LEAVE_TYPE_LABELS[a.leaveType]} ${leaveRangeText(range)}（${a.days} 天${a.autoReturn ? '，休完自动上牌' : ''}）${approve ? '，已批准' : '，待审批'}：${a.reason}`,
      },
      ip: ctx.ip,
      businessDate: today,
    });
    await saveKey(tx, a.clientKey, 'technician_state', requestHash, t.id, ctx.actor.id);
    return t.id;
  });
  return clockroomBoard(deps.sql, deps);
}

/** 休完超过几天才看到的不再补上牌（应用停了很久、迁移前的旧单） */
const RETURN_GRACE_DAYS = 7;

/** 每分钟的任务：休完了的休假单，给技师自动上牌（排到队尾）。返回这一次上牌的人数 */
export async function sweepLeaveReturns(deps: Pick<Deps, 'sql' | 'config'>, now = new Date()): Promise<number> {
  let n = 0;
  await forEachStore(deps.sql, async () => {
    if (!(await loadClockroomRules(deps.sql)).leaveAutoReturn) return;
    const today = await businessDate(deps.sql, deps as Deps, now);
    const due = await deps.sql<{ id: number; technicianId: number }[]>`
      SELECT id, technician_id FROM technician_leaves
      WHERE store_id = ${currentStoreId()} AND status = 'approved' AND auto_return AND returned_at IS NULL AND to_date < ${today}
      ORDER BY to_date, id LIMIT 200`;
    for (const d of due) if (await returnOne(deps.sql, deps as Deps, Number(d.id), Number(d.technicianId), today, now)) n += 1;
  });
  return n;
}

async function returnOne(sql: Sql, deps: Deps, leaveId: number, technicianId: number, today: string, at: Date): Promise<boolean> {
  return sql.begin(async (tx: Tx) => {
    await setTxTimeouts(tx);
    await lockQueue(tx);
    const [t] = await tx<{ id: number; techNo: string; name: string; active: boolean; suspendedAt: string | null }[]>`
      SELECT id, tech_no, name, active, suspended_at FROM technicians WHERE id = ${technicianId} FOR UPDATE`;
    const [l] = await tx<{ status: string; returnedAt: string | null; fromDate: string; toDate: string; autoReturn: boolean }[]>`
      SELECT status, returned_at, from_date::text AS from_date, to_date::text AS to_date, auto_return FROM technician_leaves WHERE id = ${leaveId} FOR UPDATE`;
    if (!t || !l || l.status !== 'approved' || l.returnedAt || !l.autoReturn || l.toDate >= today) return false;
    const staffId = await systemStaffId(tx);
    const mark = () => tx`UPDATE technician_leaves SET returned_at = ${at} WHERE id = ${leaveId}`;
    const [rec] = await tx<{ businessDate: string }[]>`SELECT business_date::text AS business_date FROM technician_status WHERE technician_id = ${t.id}`;
    const st = (await statusMap(tx, today)).get(t.id);
    const restToday = (await scheduleOn(tx, today)).get(t.id)?.rest ?? false;
    const stale = l.toDate < plusDays(today, -RETURN_GRACE_DAYS);
    // 今天已经有人动过（手动上牌、下牌、又设了休假）、又在休假里、排休、停牌、停用、休完太久的：只记处理过，不上牌
    if (!t.active || t.suspendedAt || rec?.businessDate === today || st?.approvedLeave || restToday || stale) {
      await mark();
      return false;
    }
    await writeStatus(tx, t.id, today, { state: 'on', queueKey: at, rejectStreak: 0 }, staffId, at);
    await logEvent(tx, { technicianId: t.id, kind: 'sign_in', detail: { from: 'leave', auto: 'leave_return', leave: leaveRangeText(l) }, staffId, businessDate: today, at });
    await mark();
    await locateSignIn(tx, [t.id], { at, staffId });
    return true;
  });
}
