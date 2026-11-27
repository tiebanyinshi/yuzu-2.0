// 8.2.3 前台（发卡台与全店，docs/V8223_FRONTDESK.md）：客人类别、客人偏好、全店刷手牌看的那一条、客诉台账、高风险提示、补单的出单员。
//
// 锁（docs/LOCKING.md 第 1 节「前台」）：
//   · 改类别：来访（FOR UPDATE，与换牌、结账对来访的锁串行；结了账的不能改）→ 改 visits.guest_category → 插入改类别记录；
//   · 改偏好：来访（FOR SHARE）→ 按格 upsert / 删除 guest_preferences（会员的记在会员上，一位会员同时只有一次在店来访，所以不另锁会员）；
//   · 客诉标已处理：备注一行（FOR SHARE）→ 插入处理记录，一条只能标一次靠 remark_id 唯一兜底；
//   · 高风险推送（每分钟的任务）：不锁业务行，只插入推送记录（visit_id + reason 唯一），插进去了才在同一个事务里写站内通知。
// 这几样都不动钱、不动账单，不带操作编号：改类别、改偏好是「改成这个值」，重提结果一样；标已处理重提被唯一约束挡下、返回「已经标过」。

import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import {
  COMPLAINT_STATUSES,
  highRiskOf,
  MAX_PREF_VALUE,
  riskAlertText,
  type ComplaintLedger,
  type ComplaintRow,
  type RiskAlertRow,
  type RiskReason,
  type SupplementIssuer,
} from '@shared/frontdesk-v8223';
import type { TagZone } from '@shared/frontdesk';
import { guard, guardAny } from '../../auth/guard';
import { isUniqueViolation, type Db } from '../../db';
import { writeAudit } from '../../lib/audit';
import { ctxOf, type Deps, type OpContext } from '../../lib/context';
import { checkDateRange } from '../../lib/dates';
import { conflict, unprocessable } from '../../lib/errors';
import { saveRuleSetting } from '../../lib/rule-settings';
import { currentStoreId, forEachStore, storeIn } from '../../lib/store-context';
import { dateSchema, idParam, parse } from '../../lib/validate';
import { notify } from '../oa/index';
import { assertOpen, businessDate, lockVisits, setTxTimeouts } from './common';
import { categoryOf, GUEST_RULES_KEY, GuestRulesInput, guestNotesOf, loadGuestRules } from './guest-read';
import { checkinCategory } from './guest-tx';
import { getVisit } from './visits';

// ───────────────────────── 改类别、改偏好 ─────────────────────────

const CategoryInput = z.object({ category: z.string('请选择客人类别').trim().min(1, '请选择客人类别').max(8) });

export async function setCategory(deps: Deps, visitId: number, raw: unknown, ctx: OpContext) {
  const input = parse(CategoryInput, raw);
  await deps.sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    const visit = (await lockVisits(tx, [visitId])).get(visitId)!;
    assertOpen(visit);
    const rules = await loadGuestRules(tx);
    const next = checkinCategory(input.category, rules);
    const [row] = await tx<{ guestCategory: string; tagCode: string }[]>`
      SELECT v.guest_category, t.code AS tag_code FROM visits v JOIN hand_tags t ON t.id = v.tag_id WHERE v.id = ${visit.id}`;
    if (row!.guestCategory === next) return;
    const at = ctx.at ?? new Date();
    await tx`UPDATE visits SET guest_category = ${next} WHERE id = ${visit.id}`;
    await tx`
      INSERT INTO visit_category_changes (visit_id, from_category, to_category, operator_id, created_at)
      VALUES (${visit.id}, ${row!.guestCategory}, ${next}, ${ctx.actor.id}, ${at})`;
    await writeAudit(tx, {
      staffId: ctx.actor.id,
      action: 'visit_category',
      targetType: 'visit',
      targetId: visit.id,
      detail: { visitNo: visit.visitNo, tagCode: row!.tagCode, from: categoryOf(row!.guestCategory, rules), to: categoryOf(next, rules) },
      ip: ctx.ip,
      businessDate: await businessDate(tx, deps, at),
    });
  });
  return getVisit(deps.sql, visitId, deps.config.timezone);
}

const PrefsInput = z.object({
  values: z.record(z.string(), z.string().trim().max(MAX_PREF_VALUE, `每一格最多 ${MAX_PREF_VALUE} 个字`)),
});

/** 改偏好（只改提交了的几格；填空 = 清掉）。会员的记在会员上（下次来自动带出），散客的记在这次来访上 */
export async function setPreferences(deps: Deps, visitId: number, raw: unknown, ctx: OpContext) {
  const input = parse(PrefsInput, raw);
  await deps.sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    const [visit] = await tx<{ id: number; visitNo: string; status: string; memberId: number | null; tagCode: string }[]>`
      SELECT v.id, v.visit_no, v.status, v.member_id, t.code AS tag_code FROM visits v JOIN hand_tags t ON t.id = v.tag_id
      WHERE v.id = ${visitId} AND v.store_id = ${currentStoreId()} FOR SHARE OF v`;
    if (!visit) throw unprocessable('VISIT_NOT_FOUND', '来访记录不存在，请刷新后重试');
    if (visit.status !== 'open') throw conflict('VISIT_CLOSED', `来访 ${visit.visitNo} 已${visit.status === 'settled' ? '结账离店' : '撤销'}，不能再改偏好`);
    const rules = await loadGuestRules(tx);
    const known = new Map(rules.prefFields.map((f) => [f.key, f.label]));
    const keys = Object.keys(input.values).sort();
    for (const k of keys) if (!known.has(k)) throw unprocessable('PREF_FIELD', '有偏好字段刚被停用了，请刷新后重新填');
    const memberId = visit.memberId === null ? null : Number(visit.memberId);
    const owner = memberId ? tx`member_id = ${memberId}` : tx`visit_id = ${visit.id}`;
    const changes: { field: string; from: string; to: string }[] = [];
    for (const k of keys) {
      const value = input.values[k]!;
      const [before] = await tx<{ value: string }[]>`SELECT value FROM guest_preferences WHERE ${owner} AND field_key = ${k} FOR UPDATE`;
      if ((before?.value ?? '') === value) continue;
      if (!value) await tx`DELETE FROM guest_preferences WHERE ${owner} AND field_key = ${k}`;
      else if (before) await tx`UPDATE guest_preferences SET value = ${value}, updated_by = ${ctx.actor.id}, updated_at = now() WHERE ${owner} AND field_key = ${k}`;
      else {
        try {
          await tx`
            INSERT INTO guest_preferences (member_id, visit_id, field_key, value, updated_by)
            VALUES (${memberId}, ${memberId ? null : visit.id}, ${k}, ${value}, ${ctx.actor.id})`;
        } catch (e) {
          if (isUniqueViolation(e)) throw conflict('IN_PROGRESS', '这位客人的偏好刚被别人改了，请刷新后再改');
          throw e;
        }
      }
      changes.push({ field: known.get(k)!, from: before?.value ?? '', to: value });
    }
    if (!changes.length) return;
    await writeAudit(tx, {
      staffId: ctx.actor.id,
      action: 'guest_preferences',
      targetType: memberId ? 'member' : 'visit',
      targetId: memberId ?? visit.id,
      detail: { visitNo: visit.visitNo, tagCode: visit.tagCode, owner: memberId ? 'member' : 'visit', changes },
      ip: ctx.ip,
      businessDate: await businessDate(tx, deps, ctx.at ?? new Date()),
    });
  });
  return getVisit(deps.sql, visitId, deps.config.timezone);
}

// ───────────────────────── 客诉台账 ─────────────────────────

const ComplaintQuery = z.object({
  from: dateSchema('开始日期'),
  to: dateSchema('结束日期'),
  status: z.enum(COMPLAINT_STATUSES).default('all'),
  tag: z.string().trim().max(20).optional(),
});

/** 客诉台账：带客诉类标签的前台备注（按来访的营业日筛；「合并看」时是几家店） */
export async function listComplaints(db: Db, raw: unknown): Promise<ComplaintLedger> {
  const q = parse(ComplaintQuery, raw);
  checkDateRange(q.from, q.to);
  const rules = await loadGuestRules(db);
  const tags = q.tag ? rules.complaintTags.filter((t) => t === q.tag) : rules.complaintTags;
  if (!tags.length) return { rows: [], truncated: false, tags: rules.complaintTags };
  const status = q.status === 'open' ? db`AND rs.id IS NULL AND x.id IS NULL` : q.status === 'resolved' ? db`AND rs.id IS NOT NULL` : db``;
  const rows = await db<(Omit<ComplaintRow, 'resolved' | 'removed'> & { removedAt: string | null; resolvedNote: string | null; resolvedByName: string | null; resolvedAt: string | null })[]>`
    SELECT r.id AS remark_id, st.name AS store_name, v.business_date::text AS business_date, r.tag, r.note, r.scope, t.code AS tag_code, v.visit_no, v.id AS visit_id,
           coalesce(m.name, nullif(v.guest_label, ''), '散客') AS guest, cs.display_name AS created_by_name, r.created_at,
           x.created_at AS removed_at, rs.note AS resolved_note, rss.display_name AS resolved_by_name, rs.created_at AS resolved_at
    FROM visit_remarks r JOIN visits v ON v.id = r.visit_id JOIN hand_tags t ON t.id = v.tag_id JOIN stores st ON st.id = v.store_id
    JOIN staff cs ON cs.id = r.created_by LEFT JOIN members m ON m.id = v.member_id
    LEFT JOIN visit_remark_removals x ON x.remark_id = r.id
    LEFT JOIN visit_remark_resolutions rs ON rs.remark_id = r.id LEFT JOIN staff rss ON rss.id = rs.created_by
    WHERE ${storeIn(db, 'v.store_id')} AND r.tag IN ${db(tags)} AND v.business_date BETWEEN ${q.from} AND ${q.to} ${status}
    ORDER BY v.business_date DESC, r.id DESC LIMIT 501`;
  return {
    rows: rows.slice(0, 500).map(({ removedAt, resolvedNote, resolvedByName, resolvedAt, ...r }) => ({
      ...r,
      remarkId: Number(r.remarkId),
      visitId: Number(r.visitId),
      removed: !!removedAt,
      resolved: resolvedAt ? { note: resolvedNote ?? '', byName: resolvedByName ?? '', at: resolvedAt } : null,
    })),
    truncated: rows.length > 500,
    tags: rules.complaintTags,
  };
}

const ResolveInput = z.object({ note: z.string('请填写处理结果').trim().min(1, '请填写处理结果').max(200, '处理结果最多 200 字') });

export async function resolveComplaint(deps: Deps, remarkId: number, raw: unknown, ctx: OpContext) {
  const input = parse(ResolveInput, raw);
  await deps.sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    const [r] = await tx<{ id: number; tag: string; note: string; visitId: number; visitNo: string }[]>`
      SELECT r.id, r.tag, r.note, r.visit_id, v.visit_no FROM visit_remarks r JOIN visits v ON v.id = r.visit_id
      WHERE r.id = ${remarkId} AND ${storeIn(tx, 'v.store_id')} FOR SHARE OF r`;
    if (!r) throw unprocessable('REMARK_NOT_FOUND', '这条备注不存在，请刷新后重试');
    const rules = await loadGuestRules(tx);
    if (!rules.complaintTags.includes(r.tag)) throw unprocessable('NOT_COMPLAINT', '这条备注不是客诉台账里的，请刷新');
    try {
      await tx`INSERT INTO visit_remark_resolutions (remark_id, note, created_by) VALUES (${r.id}, ${input.note}, ${ctx.actor.id})`;
    } catch (e) {
      if (isUniqueViolation(e)) throw conflict('COMPLAINT_RESOLVED', '这一条已经标过「已处理」了，请刷新');
      throw e;
    }
    await writeAudit(tx, {
      staffId: ctx.actor.id,
      action: 'complaint_resolved',
      targetType: 'visit',
      targetId: Number(r.visitId),
      detail: { visitNo: r.visitNo, remarkId: Number(r.id), tag: r.tag, remark: r.note, note: input.note },
      ip: ctx.ip,
      businessDate: await businessDate(tx, deps, new Date()),
    });
  });
  return { ok: true };
}

// ───────────────────────── 高风险提示 ─────────────────────────

/** 本店在店、现在超了阈值的客人（提醒列表），与推送过的 */
export async function listRiskAlerts(db: Db): Promise<RiskAlertRow[]> {
  const rules = await loadGuestRules(db);
  if (rules.risk.stayHours <= 0 && rules.risk.amountCents <= 0) return [];
  const rows = await db<{ visitId: number; tagCode: string; zone: TagZone; guest: string; checkedInAt: string; amountCents: number; now: string; notified: RiskReason[] }[]>`
    SELECT v.id AS visit_id, t.code AS tag_code, v.zone, coalesce(m.name, nullif(v.guest_label, ''), '散客') AS guest, v.checked_in_at, b.amount_cents, now() AS now,
           coalesce((SELECT array_agg(a.reason ORDER BY a.reason) FROM visit_risk_alerts a WHERE a.visit_id = v.id), '{}') AS notified
    FROM visits v JOIN hand_tags t ON t.id = v.tag_id JOIN bills b ON b.id = v.bill_id LEFT JOIN members m ON m.id = v.member_id
    WHERE v.status = 'open' AND v.store_id = ${currentStoreId()}
      AND ((${rules.risk.stayHours} > 0 AND v.checked_in_at <= now() - make_interval(hours => ${rules.risk.stayHours}))
        OR (${rules.risk.amountCents} > 0 AND b.amount_cents >= ${rules.risk.amountCents}))
    ORDER BY v.checked_in_at LIMIT 200`;
  return rows.flatMap((r) => {
    const risk = highRiskOf(Math.floor((new Date(r.now).getTime() - new Date(r.checkedInAt).getTime()) / 60_000), Number(r.amountCents), rules);
    return risk ? [{ visitId: Number(r.visitId), tagCode: r.tagCode, zone: r.zone, guest: r.guest, checkedInAt: r.checkedInAt, amountCents: Number(r.amountCents), risk, notified: r.notified }] : [];
  });
}

/** 推给谁：值班经理一级 = 值班经理、店总、店主；店总一级 = 店总、店主。只要在职、挂在这家店的（店主不用挂店） */
const RECIPIENT_ROLES = { duty_manager: ['owner', 'store_manager', 'duty_manager'], store_manager: ['owner', 'store_manager'] } as const;

/** 每分钟：各家店超了阈值、还没推过的客人推一次（规则是「只在页面上提示」的店不推）；返回推了几条 */
export async function sweepRiskAlerts(deps: Deps, now = new Date()): Promise<number> {
  let n = 0;
  await forEachStore(deps.sql, async () => {
    const rules = await loadGuestRules(deps.sql);
    if (rules.risk.notify === 'page') return;
    const level = rules.risk.notify;
    for (const row of await listRiskAlerts(deps.sql)) {
      for (const reason of row.risk.reasons) {
        if (row.notified.includes(reason)) continue;
        const sent = await deps.sql.begin(async (tx) => {
          await setTxTimeouts(tx);
          const staff = await tx<{ id: number }[]>`
            SELECT s.id FROM staff s
            WHERE s.active AND NOT s.system AND s.role IN ${tx(RECIPIENT_ROLES[level] as unknown as string[])}
              AND (s.role = 'owner' OR EXISTS (SELECT 1 FROM staff_stores ss WHERE ss.staff_id = s.id AND ss.store_id = ${currentStoreId()})
                   OR NOT EXISTS (SELECT 1 FROM staff_stores ss WHERE ss.staff_id = s.id))
            ORDER BY s.id`;
          const stay = Math.floor((now.getTime() - new Date(row.checkedInAt).getTime()) / 60_000);
          const [made] = await tx<{ id: number }[]>`
            INSERT INTO visit_risk_alerts (visit_id, reason, threshold, observed, notify_level, recipients, created_at)
            VALUES (${row.visitId}, ${reason}, ${reason === 'stay' ? rules.risk.stayHours : rules.risk.amountCents}, ${reason === 'stay' ? stay : row.amountCents},
                    ${level}, ${staff.length}, ${now})
            ON CONFLICT (visit_id, reason) DO NOTHING RETURNING id`;
          if (!made) return false;
          await notify(
            tx,
            staff.map((s) => Number(s.id)),
            {
              kind: 'system',
              title: `高风险提示：手牌 ${row.tagCode}`,
              body: riskAlertText(row.tagCode, reason, rules),
              link: `/crm/frontdesk?v=${row.visitId}`,
              ref: { type: 'visit_risk_alert', id: Number(made.id) },
            },
          );
          return true;
        });
        if (sent) n += 1;
      }
    }
  });
  return n;
}

// ───────────────────────── 补单的出单员 ─────────────────────────

/** 出单员候选：在职、挂在这家店的员工（店主不用挂店），不含系统账号与专用账号 */
export async function supplementIssuers(db: Db): Promise<SupplementIssuer[]> {
  const rows = await db<{ id: number; name: string }[]>`
    SELECT s.id, s.display_name AS name FROM staff s
    WHERE s.active AND NOT s.system AND s.role NOT IN ('tablet', 'other_store', 'designer')
      AND (s.role = 'owner' OR EXISTS (SELECT 1 FROM staff_stores ss WHERE ss.staff_id = s.id AND ss.store_id = ${currentStoreId()})
           OR NOT EXISTS (SELECT 1 FROM staff_stores ss WHERE ss.staff_id = s.id))
    ORDER BY s.display_name, s.id`;
  return rows.map((r) => ({ id: Number(r.id), name: r.name }));
}

// ───────────────────────── 路由 ─────────────────────────

/** 全店刷手牌的地方：发卡台、收银台、点单、钟房派钟、房态中心 */
const ANY_DESK = ['frontdesk.read', 'dining.order', 'technician.dispatch', 'room.housekeep', 'room.operate'] as const;

const NotesQuery = z.object({ visitIds: z.string().regex(/^\d+(,\d+){0,49}$/, '来访编号不正确') });

export function registerGuestRoutes(app: FastifyInstance, deps: Deps) {
  const { sql } = deps;
  app.get('/api/frontdesk/guest-rules', { preHandler: guardAny(...ANY_DESK) }, async () => loadGuestRules(sql));
  // 只改提交的部分，其余沿用当前规则（在规则锁里读当前值再合并）
  app.put('/api/frontdesk/guest-rules', { preHandler: guard('settings.manage') }, async (req) => {
    const patch = parse(GuestRulesInput.partial(), req.body);
    return saveRuleSetting(sql, GUEST_RULES_KEY, loadGuestRules, (before) => parse(GuestRulesInput, { ...before, ...patch }), ctxOf(req));
  });
  app.post('/api/frontdesk/visits/:id/category', { preHandler: guardAny('frontdesk.operate', 'frontdesk.checkout') }, async (req) =>
    setCategory(deps, parse(idParam, req.params).id, req.body, ctxOf(req)),
  );
  app.put('/api/frontdesk/visits/:id/preferences', { preHandler: guardAny('frontdesk.operate', 'frontdesk.checkout') }, async (req) =>
    setPreferences(deps, parse(idParam, req.params).id, req.body, ctxOf(req)),
  );
  app.get('/api/frontdesk/guest-notes', { preHandler: guardAny(...ANY_DESK) }, async (req) => {
    const q = parse(NotesQuery, req.query ?? {});
    return guestNotesOf(sql, q.visitIds.split(',').map(Number));
  });
  app.get('/api/frontdesk/complaints', { preHandler: guard('frontdesk.complaints') }, async (req) => listComplaints(sql, req.query ?? {}));
  app.post('/api/frontdesk/complaints/:id/resolve', { preHandler: guard('frontdesk.complaints') }, async (req) => resolveComplaint(deps, parse(idParam, req.params).id, req.body, ctxOf(req)));
  app.get('/api/frontdesk/risk-alerts', { preHandler: guardAny('frontdesk.read') }, async () => listRiskAlerts(sql));
  app.get('/api/frontdesk/supplement/issuers', { preHandler: guard('frontdesk.supplement') }, async () => supplementIssuers(sql));
}
