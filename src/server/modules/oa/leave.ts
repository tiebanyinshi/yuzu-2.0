// OA-09 假种与假期余额（docs/OA.md 第 12 节；需求文档四（五））。请假扣减与撤销退回在 OA-13，照这里的加锁顺序调 changeBalance。
//   · 假种全公司一份（人事在后台「考勤设置 → 假种与余额」管）：带薪、要证明附件、管余额、年假按工龄分档。
//   · 余额：员工 + 假种 + 年度一行（单位半天），每次变动一条明细（只追加）。
//   · 年假自动发放：后台任务每小时看一次，给在职、填了入职日期的员工发今年的额度（按到今天满几年套档；一档都不满的先不发，
//     满了再发）；每人每假种每年只发一次（唯一索引兜底）。人事也可以点「按规则发放今年年假」立刻跑。
//   · 人事调整：带操作编号（oa_leave_adjust），加或减、写原因；余额不够减拒绝；给员工发站内通知。
// 加锁（docs/LOCKING.md「假期余额」）：操作编号（调整、新建假种才有）→ 余额行（INSERT … ON CONFLICT DO NOTHING 再 FOR UPDATE）→ 插明细、改合计。

import { every } from '../../lib/throttle';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  annualDays,
  halvesText,
  LEAVE_ADJUST_MAX_DAYS,
  LEAVE_NAME_MAX,
  LEAVE_REASON_MAX,
  yearsOfService,
  type LeaveAdjustSaved,
  type LeaveBalance,
  type LeaveEntry,
  type LeaveEntryKind,
  type LeaveTier,
  type LeaveType,
  type LeaveYear,
  type MyLeave,
} from '@shared/oa';
import { isUniqueViolation, type Db, type Fragment, type Sql, type Tx } from '../../db';
import { guard } from '../../auth/guard';
import { writeAudit } from '../../lib/audit';
import type { Deps } from '../../lib/context';
import { conflict, notFound, unprocessable } from '../../lib/errors';
import { assertNotFenced, lockOpKey } from '../../lib/fences';
import { hashRequest } from '../../lib/idempotency';
import { currentStoreId } from '../../lib/store-context';
import { idParam, parse } from '../../lib/validate';
import { erpOpAbandoned } from '../erp-ops';
import { storeEmployee } from './attendance-setup';
import { notify } from './notifications';
import { NOT_EMPLOYEE_ROLES } from './org';
import { localMinute } from './punches';

const manage = guard('hr.attendance');
/** 年假自动发放多久跑一次 */
const GRANT_EVERY_MS = 60 * 60_000;

const TYPE_COLS = (db: Db) => db`id, name, paid, proof_required, has_balance, annual_tiers, active, sort, version`;
type TypeRow = Omit<LeaveType, 'annualTiers'> & { annualTiers: LeaveTier[] | null };
const toType = (r: TypeRow): LeaveType => ({ ...r, id: Number(r.id), annualTiers: r.annualTiers ?? null });

export async function loadLeaveTypes(db: Db): Promise<LeaveType[]> {
  return (await db<TypeRow[]>`SELECT ${TYPE_COLS(db)} FROM oa_leave_types ORDER BY active DESC, sort, id`).map(toType);
}

type LockedType = { name: string; hasBalance: boolean; active: boolean; proofRequired: boolean; annualTiers: LeaveTier[] | null };
/**
 * 动余额之前先对假种加共享锁，事务提交前别人改不了这个假种的设置（修改假种对那一行 FOR UPDATE）：
 * 不然调整读到「管余额」以后、人事同时关掉「管余额」（那时余额还是 0 所以放行），调整照样加上，留下看不见的余额（Codex 审查 3c1cf1b）。
 * 顺序：假种行（FOR SHARE）→ 余额行（lockBalance）。OA-13 请假扣减照这个顺序
 */
export async function lockLeaveType(tx: Tx, leaveTypeId: number): Promise<LockedType | null> {
  const [t] = await tx<LockedType[]>`SELECT name, has_balance, active, proof_required, annual_tiers FROM oa_leave_types WHERE id = ${leaveTypeId} FOR SHARE`;
  return t ?? null;
}

/** 余额行：没有就建一行再锁住（调用方先 lockLeaveType；OA-13 请假扣减也从这里进） */
export async function lockBalance(tx: Tx, staffId: number, leaveTypeId: number, year: number): Promise<{ grantedHalves: number; usedHalves: number }> {
  await tx`INSERT INTO oa_leave_balances (staff_id, leave_type_id, year) VALUES (${staffId}, ${leaveTypeId}, ${year}) ON CONFLICT DO NOTHING`;
  const [b] = await tx<{ grantedHalves: number; usedHalves: number }[]>`
    SELECT granted_halves, used_halves FROM oa_leave_balances WHERE staff_id = ${staffId} AND leave_type_id = ${leaveTypeId} AND year = ${year} FOR UPDATE`;
  return b!;
}

/**
 * 记一笔余额变动（调用方已经 lockBalance）：插明细、改合计。grant / adjust 改发放，use / restore 改已用。
 * 余额（发放 − 已用）不能变成负数：调用方先核对，数据库约束兜底。返回明细编号
 */
export async function changeBalance(
  tx: Tx,
  e: { staffId: number; leaveTypeId: number; year: number; kind: LeaveEntryKind; halves: number; reason?: string; refType?: string; refId?: number; actorId: number | null },
): Promise<number> {
  const [row] = await tx<{ id: number }[]>`
    INSERT INTO oa_leave_entries (staff_id, leave_type_id, year, kind, halves, reason, ref_type, ref_id, created_by)
    VALUES (${e.staffId}, ${e.leaveTypeId}, ${e.year}, ${e.kind}, ${e.halves}, ${e.reason ?? ''}, ${e.refType ?? null}, ${e.refId ?? null}, ${e.actorId})
    RETURNING id`;
  const granted = e.kind === 'grant' || e.kind === 'adjust' ? e.halves : 0;
  // use 记负数（扣减），restore 记正数（退回）：已用 = −明细
  const used = e.kind === 'use' || e.kind === 'restore' ? -e.halves : 0;
  await tx`
    UPDATE oa_leave_balances SET granted_halves = granted_halves + ${granted}, used_halves = used_halves + ${used}, updated_at = now()
    WHERE staff_id = ${e.staffId} AND leave_type_id = ${e.leaveTypeId} AND year = ${e.year}`;
  return Number(row!.id);
}

/** 某些员工某一年各「管余额」假种的余额（没有余额行的记 0） */
async function balancesOf(db: Db, staffIds: number[], year: number): Promise<Map<number, LeaveBalance[]>> {
  const out = new Map<number, LeaveBalance[]>();
  if (!staffIds.length) return out;
  const rows = await db<(LeaveBalance & { staffId: number })[]>`
    SELECT s.id AS staff_id, t.id AS leave_type_id, t.name, COALESCE(b.granted_halves, 0) AS granted_halves, COALESCE(b.used_halves, 0) AS used_halves
    FROM unnest(${staffIds}::bigint[]) AS s(id)
    CROSS JOIN oa_leave_types t
    LEFT JOIN oa_leave_balances b ON b.staff_id = s.id AND b.leave_type_id = t.id AND b.year = ${year}
    WHERE t.has_balance AND (t.active OR b.staff_id IS NOT NULL)
    ORDER BY s.id, t.sort, t.id`;
  for (const r of rows) {
    const list = out.get(Number(r.staffId)) ?? [];
    list.push({ leaveTypeId: Number(r.leaveTypeId), name: r.name, grantedHalves: r.grantedHalves, usedHalves: r.usedHalves });
    out.set(Number(r.staffId), list);
  }
  return out;
}

async function entriesOf(db: Db, where: Fragment): Promise<LeaveEntry[]> {
  const rows = await db<LeaveEntry[]>`
    SELECT e.id, e.leave_type_id, t.name AS leave_type_name, e.kind, e.halves, e.reason, c.display_name AS created_by_name, e.created_at
    FROM oa_leave_entries e JOIN oa_leave_types t ON t.id = e.leave_type_id LEFT JOIN staff c ON c.id = e.created_by
    WHERE ${where}
    ORDER BY e.id DESC
    LIMIT 200`;
  return rows.map((r) => ({ ...r, id: Number(r.id), leaveTypeId: Number(r.leaveTypeId), createdAt: new Date(r.createdAt).toISOString() }));
}

/**
 * 年假自动发放：today 这一年，在职、填了入职日期、到 today 满了一档的员工，每个有工龄分档的假种发一次。
 * staffFilter 限定员工（人事点按钮时是本店员工）。一位员工一个事务；返回发了几条
 */
export async function grantAnnualLeave(db: Sql, today: string, actorId: number | null, staffFilter?: Fragment): Promise<number> {
  const year = Number(today.slice(0, 4));
  const candidates = await db<{ staffId: number; hireDate: string; leaveTypeId: number; name: string; annualTiers: LeaveTier[] }[]>`
    SELECT s.id AS staff_id, p.hire_date::text AS hire_date, t.id AS leave_type_id, t.name, t.annual_tiers
    FROM staff s
    JOIN staff_profiles p ON p.staff_id = s.id AND p.status = 'active' AND p.hire_date IS NOT NULL AND p.hire_date <= ${today}
    CROSS JOIN oa_leave_types t
    WHERE s.active AND NOT s.system AND s.role <> ALL(${NOT_EMPLOYEE_ROLES}) AND ${staffFilter ?? db`true`}
      AND t.active AND t.has_balance AND t.annual_tiers IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM oa_leave_entries e WHERE e.staff_id = s.id AND e.leave_type_id = t.id AND e.year = ${year} AND e.kind = 'grant')
    ORDER BY s.id, t.id`;
  let n = 0;
  for (const c of candidates) {
    const days = annualDays(c.annualTiers, yearsOfService(c.hireDate, today));
    if (days <= 0) continue;
    const staffId = Number(c.staffId);
    const leaveTypeId = Number(c.leaveTypeId);
    try {
      const done = await db.begin(async (tx) => {
        // 锁住假种再核对一次：读候选以后人事可能刚停用、关了管余额或改了分档
        const t = await lockLeaveType(tx, leaveTypeId);
        if (!t || !t.active || !t.hasBalance || !t.annualTiers) return false;
        const now = annualDays(t.annualTiers, yearsOfService(c.hireDate, today));
        if (now <= 0) return false;
        await lockBalance(tx, staffId, leaveTypeId, year);
        const [seen] = await tx`SELECT 1 FROM oa_leave_entries WHERE staff_id = ${staffId} AND leave_type_id = ${leaveTypeId} AND year = ${year} AND kind = 'grant'`;
        if (seen) return false; // 别的进程刚发过
        const reason = `入职 ${c.hireDate}，满 ${yearsOfService(c.hireDate, today)} 年`;
        const entryId = await changeBalance(tx, { staffId, leaveTypeId, year, kind: 'grant', halves: now * 2, reason, actorId });
        await notify(tx, [staffId], {
          kind: 'system',
          title: `${year} 年${t.name}已发放：${now} 天`,
          body: reason,
          link: '/oa/leave',
          ref: { type: 'oa_leave_entry', id: entryId },
        });
        return true;
      });
      if (done) n += 1;
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
    }
  }
  return n;
}

const grantDue = every(GRANT_EVERY_MS);
/** 后台任务（每分钟调一次，一小时真跑一次） */
export async function runAnnualLeaveGrant(deps: Pick<Deps, 'sql' | 'config'>, at = new Date()): Promise<number> {
  if (!grantDue(at.getTime())) return 0;
  return grantAnnualLeave(deps.sql, localMinute(at, deps.config.timezone).date, null);
}

const tiersSchema = z
  .array(
    z.object({
      years: z.number('请填写满几年').int('年数要是整数').min(0, '年数不能是负数').max(60, '年数不正确'),
      days: z.number('请填写给几天').int('天数要是整数').min(0, '天数不能是负数').max(60, '最多 60 天'),
    }),
  )
  .min(1, '至少填一档')
  .max(10, '最多 10 档')
  .refine((t) => new Set(t.map((x) => x.years)).size === t.length, '每档的年数不能重复');
const TypeInput = z
  .object({
    name: z.string().trim().min(1, '请填写假种名称').max(LEAVE_NAME_MAX, `假种名称最多 ${LEAVE_NAME_MAX} 个字`),
    paid: z.boolean(),
    proofRequired: z.boolean(),
    hasBalance: z.boolean(),
    annualTiers: tiersSchema.nullable(),
    active: z.boolean().default(true),
    sort: z.number().int().min(0).max(999).default(0),
    version: z.number().int().positive().optional(),
    clientKey: z.uuid('缺少有效的操作编号，请刷新页面后重试').optional(),
  })
  .refine((t) => t.hasBalance || !t.annualTiers, '按工龄发放的假种要管余额');
const yearSchema = z.coerce.number().int().min(2000, '年度不正确').max(2100, '年度不正确');
const YearQuery = z.object({ year: yearSchema.optional() });
const EntriesQuery = z.object({ staffId: z.coerce.number().int().positive(), year: yearSchema });
const AdjustInput = z.object({
  clientKey: z.uuid('缺少有效的操作编号，请刷新页面后重试'),
  storeId: z.number().int().positive(),
  staffId: z.number().int().positive(),
  leaveTypeId: z.number().int().positive(),
  year: yearSchema,
  halves: z
    .number('请填写调整几天')
    .int('最小按半天调整')
    .refine((h) => h !== 0, '调整的天数不能是 0')
    .refine((h) => Math.abs(h) <= LEAVE_ADJUST_MAX_DAYS * 2, `一次最多调整 ${LEAVE_ADJUST_MAX_DAYS} 天`),
  reason: z.string().trim().min(1, '请填写调整原因').max(LEAVE_REASON_MAX, `原因最多 ${LEAVE_REASON_MAX} 个字`),
});

export function registerOaLeaveRoutes(app: FastifyInstance, deps: Deps) {
  const { sql } = deps;
  const tz = deps.config.timezone;
  const thisYear = () => Number(localMinute(new Date(), tz).date.slice(0, 4));

  // 假种：登录就能看（OA-11 请假单要用）
  app.get('/api/oa/leave/types', { preHandler: guard() }, async (): Promise<LeaveType[]> => loadLeaveTypes(sql));

  // 新建 / 修改假种：新建带操作编号（oa_leave_type），修改带版本
  const saveType = async (id: number | null, raw: unknown, actorId: number, ip: string): Promise<{ types: LeaveType[]; id: number; replayed: boolean }> => {
    const t = parse(TypeInput, raw);
    try {
      return await sql.begin(async (tx) => {
        let hash = '';
        if (id === null) {
          if (!t.clientKey) throw unprocessable('VALIDATION_FAILED', '缺少有效的操作编号，请刷新页面后重试');
          hash = hashRequest({ ...t, clientKey: undefined, version: undefined });
          await lockOpKey(tx, t.clientKey);
          const [seen] = await tx<{ opType: string; requestHash: string; refId: number }[]>`SELECT op_type, request_hash, ref_id FROM idempotency_keys WHERE key = ${t.clientKey}`;
          if (seen) {
            if (seen.opType !== 'oa_leave_type' || seen.requestHash !== hash) throw conflict('IDEMPOTENCY_CONFLICT', '该操作编号已用于另一次操作，请刷新页面后重新填写');
            return { types: await loadLeaveTypes(tx), id: Number(seen.refId), replayed: true };
          }
          await assertNotFenced(tx, t.clientKey, 'oa_leave_type', erpOpAbandoned);
        }
        const tiers = t.annualTiers ? tx.json([...t.annualTiers].sort((a, b) => a.years - b.years) as never) : null;
        let typeId = id;
        if (id === null) {
          const [row] = await tx<{ id: number }[]>`
            INSERT INTO oa_leave_types (name, paid, proof_required, has_balance, annual_tiers, active, sort)
            VALUES (${t.name}, ${t.paid}, ${t.proofRequired}, ${t.hasBalance}, ${tiers}, ${t.active}, ${t.sort}) RETURNING id`;
          typeId = Number(row!.id);
          await tx`INSERT INTO idempotency_keys (key, op_type, request_hash, ref_id, staff_id) VALUES (${t.clientKey!}, 'oa_leave_type', ${hash}, ${typeId}, ${actorId})`;
        } else {
          const [cur] = await tx<{ version: number; hasBalance: boolean }[]>`SELECT version, has_balance FROM oa_leave_types WHERE id = ${id} FOR UPDATE`;
          if (!cur) throw notFound('假种不存在');
          if (t.version !== cur.version) throw conflict('VERSION_CONFLICT', '这个假种刚被别人改过，请刷新后再改');
          if (cur.hasBalance && !t.hasBalance) {
            const [used] = await tx`SELECT 1 FROM oa_leave_balances WHERE leave_type_id = ${id} AND (granted_halves <> 0 OR used_halves <> 0) LIMIT 1`;
            if (used) throw unprocessable('LEAVE_HAS_BALANCE', '已经有人有这个假种的余额，不能改成不管余额；不用了请停用');
          }
          await tx`
            UPDATE oa_leave_types SET name = ${t.name}, paid = ${t.paid}, proof_required = ${t.proofRequired}, has_balance = ${t.hasBalance},
              annual_tiers = ${tiers}, active = ${t.active}, sort = ${t.sort}, version = version + 1, updated_at = now()
            WHERE id = ${id}`;
        }
        await writeAudit(tx, {
          staffId: actorId,
          action: 'oa_leave_type_saved',
          targetType: 'oa_leave_type',
          targetId: typeId!,
          detail: { ...t, clientKey: undefined, summary: `${id === null ? '新建' : '修改'}假种「${t.name}」` },
          ip,
        });
        return { types: await loadLeaveTypes(tx), id: typeId!, replayed: false };
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw conflict('NAME_TAKEN', `已经有叫「${t.name}」的假种了`);
      throw error;
    }
  };
  app.post('/api/oa/leave/types', { preHandler: manage }, async (req, reply) => {
    const r = await saveType(null, req.body, req.actor.id, req.ip);
    reply.code(r.replayed ? 200 : 201);
    return r;
  });
  app.put('/api/oa/leave/types/:id', { preHandler: manage }, async (req) => saveType(parse(idParam, req.params).id, req.body, req.actor.id, req.ip));

  // 后台：本店员工某一年的余额
  app.get('/api/oa/leave/balances', { preHandler: manage }, async (req): Promise<LeaveYear> => {
    const year = parse(YearQuery, req.query ?? {}).year ?? thisYear();
    const staff = await sql<{ staffId: number; staffName: string; employeeNo: string | null; hireDate: string | null }[]>`
      SELECT s.id AS staff_id, s.display_name AS staff_name, p.emp_no AS employee_no, p.hire_date::text AS hire_date
      FROM staff s LEFT JOIN staff_profiles p ON p.staff_id = s.id
      WHERE ${storeEmployee(sql)} ORDER BY s.id`;
    const ids = staff.map((s) => Number(s.staffId));
    const balances = await balancesOf(sql, ids, year);
    return {
      year,
      types: await loadLeaveTypes(sql),
      staff: staff.map((s) => ({ ...s, staffId: Number(s.staffId), balances: balances.get(Number(s.staffId)) ?? [] })),
    };
  });

  app.get('/api/oa/leave/entries', { preHandler: manage }, async (req): Promise<LeaveEntry[]> => {
    const q = parse(EntriesQuery, req.query ?? {});
    const [ok] = await sql`SELECT 1 FROM staff s WHERE s.id = ${q.staffId} AND ${storeEmployee(sql)}`;
    if (!ok) throw notFound('员工不存在或不在本店');
    return entriesOf(sql, sql`e.staff_id = ${q.staffId} AND e.year = ${q.year}`);
  });

  // 人事调整：带操作编号，结果不确定时在页面上方查回、原样重提或确认作废
  app.post('/api/oa/leave/adjust', { preHandler: manage }, async (req): Promise<LeaveAdjustSaved> => {
    const input = parse(AdjustInput, req.body);
    if (input.storeId !== currentStoreId()) throw conflict('STORE_SWITCHED', '这次调整是在别的门店的页面上做的：请换回那家门店再查回或重新提交');
    const hash = hashRequest({ staffId: input.staffId, leaveTypeId: input.leaveTypeId, year: input.year, halves: input.halves, reason: input.reason });
    const { replayed, entryId } = await sql.begin(async (tx): Promise<{ replayed: boolean; entryId: number }> => {
      await lockOpKey(tx, input.clientKey);
      const [seen] = await tx<{ opType: string; requestHash: string; refId: number }[]>`SELECT op_type, request_hash, ref_id FROM idempotency_keys WHERE key = ${input.clientKey}`;
      if (seen) {
        if (seen.opType !== 'oa_leave_adjust' || seen.requestHash !== hash) throw conflict('IDEMPOTENCY_CONFLICT', '该操作编号已用于另一次操作，请刷新页面后重新调整');
        return { replayed: true, entryId: Number(seen.refId) };
      }
      await assertNotFenced(tx, input.clientKey, 'oa_leave_adjust', erpOpAbandoned);
      const [s] = await tx<{ name: string }[]>`SELECT s.display_name AS name FROM staff s WHERE s.id = ${input.staffId} AND ${storeEmployee(tx)}`;
      if (!s) throw notFound('员工不存在、已离职或不在本店');
      const t = await lockLeaveType(tx, input.leaveTypeId);
      if (!t) throw notFound('假种不存在');
      if (!t.hasBalance) throw unprocessable('LEAVE_NO_BALANCE', `「${t.name}」不管余额，不用调整`);
      const b = await lockBalance(tx, input.staffId, input.leaveTypeId, input.year);
      const left = b.grantedHalves - b.usedHalves;
      if (left + input.halves < 0) throw unprocessable('LEAVE_BALANCE_SHORT', `${s.name}的${t.name}只剩 ${halvesText(left)}，不够减 ${halvesText(-input.halves)}`);
      const entryId = await changeBalance(tx, {
        staffId: input.staffId,
        leaveTypeId: input.leaveTypeId,
        year: input.year,
        kind: 'adjust',
        halves: input.halves,
        reason: input.reason,
        actorId: req.actor.id,
      });
      await tx`INSERT INTO idempotency_keys (key, op_type, request_hash, ref_id, staff_id) VALUES (${input.clientKey}, 'oa_leave_adjust', ${hash}, ${entryId}, ${req.actor.id})`;
      const change = `${input.halves > 0 ? '加' : '减'} ${halvesText(Math.abs(input.halves))}`;
      await notify(tx, [input.staffId], {
        kind: 'system',
        title: `${input.year} 年${t.name}余额调整：${change}`,
        body: `原因：${input.reason}`,
        link: '/oa/leave',
        ref: { type: 'oa_leave_entry', id: entryId },
      });
      await writeAudit(tx, {
        staffId: req.actor.id,
        action: 'oa_leave_adjusted',
        targetType: 'staff',
        targetId: input.staffId,
        detail: { leaveTypeId: input.leaveTypeId, year: input.year, halves: input.halves, reason: input.reason, entryId, summary: `${input.year} 年${t.name}${change}（${input.reason}）` },
        ip: req.ip,
      });
      return { replayed: false, entryId };
    });
    const balance = (await balancesOf(sql, [input.staffId], input.year)).get(input.staffId)?.find((b) => b.leaveTypeId === input.leaveTypeId);
    return { balance: balance ?? { leaveTypeId: input.leaveTypeId, name: '', grantedHalves: 0, usedHalves: 0 }, entryId, replayed };
  });

  // 按规则发放今年年假（本店员工）：后台任务每小时也会跑；已经发过的不重复
  app.post('/api/oa/leave/grant', { preHandler: manage }, async (req): Promise<{ granted: number }> => {
    const granted = await grantAnnualLeave(sql, localMinute(new Date(), tz).date, req.actor.id, sql`${storeEmployee(sql)}`);
    if (granted > 0) {
      await writeAudit(sql, { staffId: req.actor.id, action: 'oa_leave_granted', targetType: 'oa_leave', detail: { granted, summary: `按规则发放今年年假 ${granted} 人次` }, ip: req.ip });
    }
    return { granted };
  });

  // 员工「假期余额」：本人某一年
  app.get('/api/oa/me/leave', { preHandler: guard() }, async (req): Promise<MyLeave> => {
    const year = parse(YearQuery, req.query ?? {}).year ?? thisYear();
    const types = (await loadLeaveTypes(sql)).filter((t) => t.active);
    const balances = (await balancesOf(sql, [req.actor.id], year)).get(req.actor.id) ?? [];
    const entries = await entriesOf(sql, sql`e.staff_id = ${req.actor.id} AND e.year = ${year}`);
    return { year, types, balances, entries };
  });
}
