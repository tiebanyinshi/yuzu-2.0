// 收银台「锁牌外出」（8.2.6，docs/V8226_AWAY_LOCK.md；店主 2026-11-27：收银台要能锁牌，锁牌时间不超过四个小时，客人外出锁牌要先收预售的钱）。
//
//   · 锁：在店客人要出去一会儿——同一笔里先收预售（一张手牌押金，原因「锁牌外出预收」，现金类或这位会员自己的储值），
//     再锁牌（锁多久由收银员选，最多 4 小时），这次来访记成「外出」；锁着期间这张牌上不能再挂账（防止牌被别人拿去消费）；
//   · 解锁：客人回来在收银台点「客人回来」（同时取消外出）；结账时在结账的事务里自动解锁；
//     到时间还没回来的，每分钟的扫描自动解锁并推给值班经理一级（外出标记留着，等前台处理）；
//   · 预售就是押金：锁着期间不能单独退（要退先解锁），结账时照押金抵扣（结账核对列出、同方式先填好收款）；
//   · 锁、解锁都带操作编号（tag_away_lock / tag_away_unlock），结果待确认照前台的做法；都记审计。
// 原来的「锁牌」（把空闲的牌停用，hand_tags.locked）不变：这里锁的是在店客人的牌，牌照旧挂在这次来访上。
// 加锁顺序（docs/LOCKING.md 第 1 节）：经办人的班次（共享锁）→ 来访（FOR UPDATE）→ 锁牌记录 → 会员一行（储值收预售）。
// 结账在锁来访以后解锁（同一个事务）；到期扫描先锁来访再锁锁牌记录，与锁、解锁同一个方向。

import { z } from 'zod';
import { AWAY_LOCK_MAX_HOURS, AWAY_LOCK_REASON, type AwayLock, type AwayLockReleaseKind } from '@shared/away-lock';
import { formatYuan } from '@shared/money';
import { can } from '@shared/permissions';
import type { Db, Tx } from '../../db';
import { writeAudit } from '../../lib/audit';
import type { Deps, OpContext } from '../../lib/context';
import { conflict, forbidden, notFound } from '../../lib/errors';
import { currentStoreId, forEachStore } from '../../lib/store-context';
import { parse } from '../../lib/validate';
import { notify } from '../oa/index';
import { lockPaymentShift, openShiftOf } from '../shifts';
import { systemAutoStaffId } from '../system-staff';
import { assertOpen, businessDate, hashRequest, lockTagsByCode, lockVisits, runIdempotent, saveKey, setTxTimeouts } from './common';
import { CollectDepositInput, insertDeposit } from './tag-deposits';

const MAX_MINUTES = AWAY_LOCK_MAX_HOURS * 60;

export const AwayLockInput = z.object({
  clientKey: z.uuid('缺少有效的操作编号，请刷新页面后重试'),
  minutes: z.number('请选锁多久').int('锁牌时长按分钟填').min(15, '锁牌至少 15 分钟').max(MAX_MINUTES, `锁牌最多 ${AWAY_LOCK_MAX_HOURS} 小时`),
  /** 锁之前先收的预售（手牌押金）：金额、方式、收款备注；储值扣的要带员工确认时看到的扣款构成 */
  deposit: z.object({
    amount: z.unknown(),
    method: z.unknown(),
    ref: z.unknown().optional(),
    expectedSplit: z.unknown().optional(),
  }),
});
const UnlockInput = z.object({ clientKey: z.uuid('缺少有效的操作编号，请刷新页面后重试') });

/** 这次来访此刻锁着的那一把（没锁为 null） */
export async function awayLockOf(db: Db, visitId: number): Promise<AwayLock | null> {
  const [r] = await db<
    {
      id: number;
      lockedAt: Date;
      lockUntil: Date;
      reason: string;
      lockedByName: string;
      depositId: number;
      depositNo: string;
      method: AwayLock['deposit']['method'];
      amount: number;
    }[]
  >`
    SELECT l.id, l.locked_at, l.lock_until, l.reason, s.display_name AS locked_by_name,
           d.id AS deposit_id, d.deposit_no, d.method, d.amount
    FROM visit_tag_locks l JOIN staff s ON s.id = l.locked_by JOIN tag_deposits d ON d.id = l.tag_deposit_id
    WHERE l.visit_id = ${visitId} AND l.released_at IS NULL`;
  if (!r) return null;
  return {
    id: Number(r.id),
    lockedAt: new Date(r.lockedAt).toISOString(),
    lockUntil: new Date(r.lockUntil).toISOString(),
    reason: r.reason,
    lockedByName: r.lockedByName,
    deposit: { id: Number(r.depositId), depositNo: r.depositNo, method: r.method, amount: Number(r.amount) },
  };
}

/** 锁着的来访不能再挂账（postChargesTx 在锁住来访以后调用）；发牌后的异常处置（加收）不拦 */
export async function assertNotAwayLocked(tx: Tx, visitId: number, tagCode?: string) {
  const [l] = await tx<{ lockUntil: Date }[]>`SELECT lock_until FROM visit_tag_locks WHERE visit_id = ${visitId} AND released_at IS NULL`;
  if (!l) return;
  const until = new Date(l.lockUntil);
  throw conflict(
    'TAG_AWAY_LOCKED',
    `手牌${tagCode ? ` ${tagCode} ` : ''}的客人外出、牌锁着（到 ${String(until.getHours()).padStart(2, '0')}:${String(until.getMinutes()).padStart(2, '0')}），不能挂账；客人回来先在收银台解锁`,
  );
}

/** 锁牌外出：先收预售再锁，返回来访编号 */
export async function awayLockVisit(deps: Deps, visitId: number, raw: unknown, ctx: OpContext): Promise<number> {
  const input = parse(AwayLockInput, raw);
  // 预售照收押金的规矩核对（金额、方式、储值的扣款构成）；原因固定写「锁牌外出预收」
  const deposit = parse(CollectDepositInput, { ...input.deposit, clientKey: input.clientKey, reason: AWAY_LOCK_REASON });
  if (deposit.method === 'wallet' && !can(ctx.actor, 'consume.create')) throw forbidden('当前岗位不能用会员储值收预售');
  const requestHash = hashRequest({ op: 'tag_away_lock', visitId, minutes: input.minutes, amount: deposit.amount, method: deposit.method, ref: deposit.ref });
  const seenShift = await openShiftOf(deps.sql, ctx.actor.id);
  await runIdempotent(deps, { key: input.clientKey, opType: 'tag_away_lock', requestHash }, async (tx) => {
    const shiftId = await lockPaymentShift(tx, ctx.actor.id, seenShift);
    const at = ctx.at ?? new Date();
    // 加锁顺序（AGENTS.md）：手牌 → 来访。写锁牌记录会对手牌取外键锁，先锁手牌，免得与换牌（先锁牌再锁来访）互相等
    const [peek] = await tx<{ tagId: number; code: string }[]>`
      SELECT v.tag_id, t.code FROM visits v JOIN hand_tags t ON t.id = v.tag_id WHERE v.id = ${visitId}`;
    if (!peek) throw notFound('来访记录不存在');
    await lockTagsByCode(tx, [peek.code]);
    const visit = (await lockVisits(tx, [visitId])).get(visitId)!;
    assertOpen(visit);
    if (visit.tagId !== peek.tagId) throw conflict('VISIT_CHANGED', '这位客人刚刚换过牌，请刷新后再锁');
    const tag = { code: peek.code };
    const [held] = await tx<{ lockUntil: Date }[]>`SELECT lock_until FROM visit_tag_locks WHERE visit_id = ${visit.id} AND released_at IS NULL FOR UPDATE`;
    if (held) throw conflict('TAG_AWAY_LOCKED', `手牌 ${tag.code} 已经锁着了（外出中），客人回来先解锁`);
    // 先收预售：收不到（储值不够、方式不对……）整笔不锁
    const depositId = await insertDeposit(tx, deps, { visit, input: deposit, key: input.clientKey, shiftId, at, ctx });
    const until = new Date(at.getTime() + input.minutes * 60_000);
    const [lock] = await tx<{ id: number }[]>`
      INSERT INTO visit_tag_locks (visit_id, tag_id, locked_at, lock_until, reason, tag_deposit_id, client_key, locked_by)
      VALUES (${visit.id}, ${visit.tagId}, ${at}, ${until}, ${AWAY_LOCK_REASON}, ${depositId}, ${input.clientKey}, ${ctx.actor.id})
      RETURNING id`;
    // 记成外出（已经外出的照旧，从原来的时刻算）
    await tx`UPDATE visits SET away_since = ${at}, away_by = ${ctx.actor.id} WHERE id = ${visit.id} AND away_since IS NULL`;
    await saveKey(tx, input.clientKey, 'tag_away_lock', requestHash, visit.id, ctx.actor.id);
    await writeAudit(tx, {
      staffId: ctx.actor.id,
      action: 'tag_away_locked',
      targetType: 'visit',
      targetId: visit.id,
      detail: {
        lockId: Number(lock!.id),
        visitNo: visit.visitNo,
        tagCode: tag.code,
        minutes: input.minutes,
        lockUntil: until.toISOString(),
        deposit: { amount: deposit.amount, method: deposit.method },
      },
      ip: ctx.ip,
      businessDate: await businessDate(tx, deps, at),
    });
    return visit.id;
  });
  return visitId;
}

/** 客人回来解锁（同时取消外出），返回来访编号 */
export async function awayUnlockVisit(deps: Deps, visitId: number, raw: unknown, ctx: OpContext): Promise<number> {
  const { clientKey: key } = parse(UnlockInput, raw);
  const requestHash = hashRequest({ op: 'tag_away_unlock', visitId });
  await runIdempotent(deps, { key, opType: 'tag_away_unlock', requestHash }, async (tx) => {
    const at = ctx.at ?? new Date();
    const visit = (await lockVisits(tx, [visitId])).get(visitId)!;
    assertOpen(visit);
    const released = await releaseLocked(tx, visit.id, 'return', ctx.actor.id, at);
    if (!released) throw conflict('NOT_AWAY_LOCKED', '这张牌没有锁着（可能已经到时间自动解锁了），请刷新');
    await tx`UPDATE visits SET away_since = NULL, away_by = NULL WHERE id = ${visit.id}`;
    await saveKey(tx, key, 'tag_away_unlock', requestHash, visit.id, ctx.actor.id);
    await writeAudit(tx, {
      staffId: ctx.actor.id,
      action: 'tag_away_unlocked',
      targetType: 'visit',
      targetId: visit.id,
      detail: { lockId: released.id, visitNo: visit.visitNo, kind: 'return' },
      ip: ctx.ip,
      businessDate: await businessDate(tx, deps, at),
    });
    return visit.id;
  });
  return visitId;
}

/** 前台「返回」（异常处置）时一并解锁（调用方已锁来访）：不留下「已返回、牌却还锁着」的状态；返回解开的那把锁 */
export async function releaseAwayLockOnReturn(tx: Tx, visitId: number, staffId: number, at: Date): Promise<{ id: number } | null> {
  return releaseLocked(tx, visitId, 'return', staffId, at);
}

/** 解开这次来访锁着的那一把（调用方已锁来访）；没锁着返回 null */
async function releaseLocked(tx: Tx, visitId: number, kind: AwayLockReleaseKind, staffId: number | null, at: Date): Promise<{ id: number } | null> {
  const [l] = await tx<{ id: number }[]>`
    UPDATE visit_tag_locks SET released_at = ${at}, released_by = ${staffId}, release_kind = ${kind}
    WHERE visit_id = ${visitId} AND released_at IS NULL RETURNING id`;
  return l ? { id: Number(l.id) } : null;
}

/** 结账时解锁（结账的事务里、来访已锁）：结了账的客人不用再锁着 */
export async function releaseAwayLocksAtCheckout(tx: Tx, visitIds: number[], staffId: number, at: Date) {
  for (const id of visitIds) await releaseLocked(tx, id, 'checkout', staffId, at);
}

/** 锁着的预售不能单独退（要退先解锁）；退押金在锁住来访以后调用 */
export async function assertDepositNotLocking(tx: Tx, depositId: number, depositNo: string) {
  const [l] = await tx`SELECT 1 FROM visit_tag_locks WHERE tag_deposit_id = ${depositId} AND released_at IS NULL`;
  if (l) throw conflict('DEPOSIT_LOCKING', `押金 ${depositNo} 是锁牌外出的预售，牌还锁着不能单独退；客人回来先解锁，结账时会一起抵扣`);
}

/** 推给谁：值班经理、店总、店主（在职、挂在这家店的；店主不用挂店） */
async function dutyManagers(tx: Tx): Promise<number[]> {
  const rows = await tx<{ id: number }[]>`
    SELECT s.id FROM staff s
    WHERE s.active AND NOT s.system AND s.role IN ('owner', 'store_manager', 'duty_manager')
      AND (s.role = 'owner' OR EXISTS (SELECT 1 FROM staff_stores ss WHERE ss.staff_id = s.id AND ss.store_id = ${currentStoreId()})
           OR NOT EXISTS (SELECT 1 FROM staff_stores ss WHERE ss.staff_id = s.id))
    ORDER BY s.id`;
  return rows.map((r) => Number(r.id));
}

/** 每分钟：到时间还锁着的自动解锁（经办人「系统」），推给值班经理一级；返回解了几把 */
export async function sweepAwayLocks(deps: Deps, now = new Date()): Promise<number> {
  let n = 0;
  await forEachStore(deps.sql, async () => {
    const due = await deps.sql<{ visitId: number }[]>`
      SELECT visit_id FROM visit_tag_locks WHERE store_id = ${currentStoreId()} AND released_at IS NULL AND lock_until <= ${now} ORDER BY lock_until LIMIT 200`;
    for (const d of due) {
      const done = await deps.sql.begin(async (tx) => {
        await setTxTimeouts(tx);
        const visit = (await lockVisits(tx, [Number(d.visitId)])).get(Number(d.visitId));
        if (!visit) return false;
        // 锁住来访以后再核对：等锁期间客人回来解了、结了账的不动
        const [l] = await tx<{ id: number; lockUntil: Date; amount: number }[]>`
          SELECT l.id, l.lock_until, t.amount FROM visit_tag_locks l JOIN tag_deposits t ON t.id = l.tag_deposit_id
          WHERE l.visit_id = ${visit.id} AND l.released_at IS NULL FOR UPDATE OF l`;
        if (!l || new Date(l.lockUntil).getTime() > now.getTime()) return false;
        const staffId = await systemAutoStaffId(tx);
        await tx`UPDATE visit_tag_locks SET released_at = ${now}, released_by = ${staffId}, release_kind = 'expired' WHERE id = ${l.id}`;
        const [tag] = await tx<{ code: string }[]>`SELECT code FROM hand_tags WHERE id = ${visit.tagId}`;
        await writeAudit(tx, {
          staffId,
          action: 'tag_away_unlocked',
          targetType: 'visit',
          targetId: visit.id,
          detail: { lockId: Number(l.id), visitNo: visit.visitNo, tagCode: tag!.code, kind: 'expired', auto: true },
          businessDate: await businessDate(tx, deps, now),
        });
        await notify(tx, await dutyManagers(tx), {
          kind: 'system',
          title: `锁牌到时间：手牌 ${tag!.code}`,
          body: `手牌 ${tag!.code} 锁牌外出已到时间（预收 ${formatYuan(Number(l.amount))}），客人还没回来，牌已自动解锁；外出标记留着，请前台跟进`,
          link: `/crm/cashier?v=${visit.id}`,
          ref: { type: 'visit_tag_lock', id: Number(l.id) },
        });
        return true;
      });
      if (done) n += 1;
    }
  });
  return n;
}
