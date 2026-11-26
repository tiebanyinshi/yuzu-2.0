// 买单时查会员、把会员记到手牌上（8.1.44，《前台系统开发》，docs/V8144_FRONTDESK.md 第 5 条）。
//   · 查：按手机号 / 姓名 / 会员号找（与会员列表同一个查法），带上余额、充值次数与金额、此刻在哪张手牌上；只读；
//   · 记到手牌上：接待时按散客发的牌，买单时才知道是会员（或当场建了档）——把会员记到这张在店的手牌上，
//     结账核对随之带出他的储值、会员折扣、券；建档本身走会员的原接口（POST /api/members），这里不另写一份。
//   · 只能记到还没有会员的手牌上；一位会员同时只能在一张手牌上（数据库的部分唯一索引兜底）；停用、已合并、在黑名单里的不能记。
//   · 不改钱：只改来访上的会员，账单、收款照旧在结账时按服务端此刻的数据核对。
// 加锁顺序（docs/LOCKING.md 前台）：来访 → 会员（共享锁），与接待、结账同向。

import { z } from 'zod';
import type { CashierMemberHit } from '@shared/cashier-member';
import type { VisitDetail } from '@shared/frontdesk';
import type { Db } from '../../db';
import { isUniqueViolation } from '../../db';
import { writeAudit } from '../../lib/audit';
import type { Deps, OpContext } from '../../lib/context';
import { conflict, notFound, unprocessable } from '../../lib/errors';
import { setTxTimeouts } from '../../lib/tx';
import { parse } from '../../lib/validate';
import { searchMembers } from '../members';
import { assertOpen, businessDate, lockVisits } from './common';
import { blacklistHits } from './risk';
import { getVisit } from './visits';

export const MemberLookupQuery = z.object({ q: z.string().trim().min(1, '请输入手机号、姓名或会员号').max(64) });

/** 查会员（收银台用）：最多 6 位，带余额与充值汇总、此刻在不在店 */
export async function lookupCashierMembers(db: Db, q: string): Promise<CashierMemberHit[]> {
  const found = await searchMembers(db, q, 6);
  if (found.length === 0) return [];
  const ids = found.map((m) => m.id);
  const stats = await db<{ memberId: number; rechargeCount: number; rechargePaid: string; lastRechargeAt: string | null }[]>`
    SELECT member_id, count(*)::int AS recharge_count, coalesce(sum(paid_amount), 0) AS recharge_paid, max(created_at) AS last_recharge_at
    FROM recharges WHERE member_id IN ${db(ids)} GROUP BY member_id`;
  const open = await db<{ memberId: number; visitId: number; tagCode: string }[]>`
    SELECT v.member_id, v.id AS visit_id, t.code AS tag_code FROM visits v JOIN hand_tags t ON t.id = v.tag_id
    WHERE v.status = 'open' AND v.member_id IN ${db(ids)}`;
  const statOf = new Map(stats.map((s) => [Number(s.memberId), s]));
  const openOf = new Map(open.map((o) => [Number(o.memberId), o]));
  return found.map((m) => {
    const s = statOf.get(m.id);
    const o = openOf.get(m.id);
    return {
      id: m.id,
      memberNo: m.memberNo,
      name: m.name,
      phone: m.phone,
      status: m.status,
      merged: m.mergedIntoId !== null,
      principalBalance: Number(m.principalBalance),
      bonusBalance: Number(m.bonusBalance),
      rechargeCount: s?.rechargeCount ?? 0,
      rechargePaid: Number(s?.rechargePaid ?? 0),
      lastRechargeAt: s?.lastRechargeAt ?? null,
      openTagCode: o?.tagCode ?? null,
      openVisitId: o ? Number(o.visitId) : null,
    };
  });
}

export const BindMemberInput = z.object({ memberId: z.number('请选择会员').int().positive('请选择会员') });

/** 把会员记到一张在店、还没有会员的手牌上；同一位会员再记一次原样返回 */
export async function bindVisitMember(deps: Deps, visitId: number, raw: unknown, ctx: OpContext): Promise<VisitDetail> {
  const { memberId } = parse(BindMemberInput, raw);
  try {
    await deps.sql.begin(async (tx) => {
      await setTxTimeouts(tx);
      const visit = (await lockVisits(tx, [visitId])).get(visitId)!;
      assertOpen(visit);
      if (visit.memberId === memberId) return;
      const [m] = await tx<{ id: number; name: string; status: string; mergedIntoId: number | null }[]>`
        SELECT id, name, status, merged_into_id FROM members WHERE id = ${memberId} FOR SHARE`;
      if (!m) throw notFound('会员不存在，请重新查找');
      const [tag] = await tx<{ code: string }[]>`SELECT code FROM hand_tags WHERE id = ${visit.tagId}`;
      if (visit.memberId !== null) {
        const [cur] = await tx<{ name: string }[]>`SELECT name FROM members WHERE id = ${visit.memberId}`;
        throw conflict('VISIT_HAS_MEMBER', `手牌 ${tag!.code} 已经记着会员「${cur?.name ?? ''}」，不能再换成别人`);
      }
      if (m.mergedIntoId !== null) throw unprocessable('MEMBER_MERGED', `会员「${m.name}」已合并到别的会员，请按合并后的那位记`);
      if (m.status !== 'active') throw unprocessable('MEMBER_FROZEN', `会员「${m.name}」已停用，不能记到手牌上`);
      const [hit] = await blacklistHits(tx, [memberId]);
      if (hit) throw unprocessable('GUEST_BLACKLISTED', `会员「${m.name}」在黑名单里（${hit.reason}），不能记到手牌上；确有需要请值班经理及以上先在会员详情里解除`);
      const [other] = await tx<{ code: string }[]>`
        SELECT t.code FROM visits v JOIN hand_tags t ON t.id = v.tag_id WHERE v.member_id = ${memberId} AND v.status = 'open' AND v.id <> ${visitId}`;
      if (other) throw conflict('MEMBER_IN_STORE', `会员「${m.name}」已经记在手牌 ${other.code} 上；同一位会员同时只能在一张手牌上，请到那张手牌结账，或合并到同一张结账单`);
      await tx`UPDATE visits SET member_id = ${memberId} WHERE id = ${visitId}`;
      await writeAudit(tx, {
        staffId: ctx.actor.id,
        action: 'frontdesk_bind_member',
        targetType: 'visit',
        targetId: visitId,
        detail: { memberId, memberName: m.name, tagCode: tag!.code, visitNo: visit.visitNo },
        ip: ctx.ip,
        businessDate: await businessDate(tx, deps, ctx.at ?? new Date()),
      });
    });
  } catch (error) {
    if (isUniqueViolation(error, 'visits_member_open_uq')) throw conflict('MEMBER_IN_STORE', '这位会员刚刚被记到了另一张手牌上，请刷新后再看');
    throw error;
  }
  return getVisit(deps.sql, visitId, deps.config.timezone);
}
