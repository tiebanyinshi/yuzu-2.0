// 8.1.40 券的发放台账与核销查询（docs/V8140.md 第 3 节；《门店系统需求梳理与优化方案》「券务功能补齐」）：
// 发券规则、券模板、使用率统计、营销成本报表已经有了，缺的是一张一张券查得到的台账——
//   · 发放台账：每张券谁发的、几点、怎么发的（手动、批量、开卡、升级、生日、充值、权益、小程序领取、批量发券、签赠），充值发的带充值单号；
//   · 核销情况：用了没有、几点用的、哪张结账单、抵了多少；作废的写原因；
//   · 发放时长：从发出到用掉（或到现在）过了多久；
//   · 按发放的营业日、模板、怎么发的、状态、券号 / 会员筛，最多一次 2000 条；能导出 CSV（导出记审计）。
// 只读，不加锁；只看当前门店能看的（券是全公司的，按发券的门店不分：与券的统计同一口径）。

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { COUPON_ISSUE_KINDS, COUPON_ISSUE_KIND_LABELS, formatStoreCouponCode, normalizeStoreCouponCode, type CouponIssueKind } from '@shared/coupons';
import { COUPON_LEDGER_EXPORT_MAX, COUPON_LEDGER_MAX, couponLedgerCsvRows, type CouponLedger, type CouponLedgerRow } from '@shared/coupon-ledger';
import type { Db } from '../db';
import { guard } from '../auth/guard';
import { writeAudit } from '../lib/audit';
import { ctxOf, type Deps } from '../lib/context';
import { csvReply, toCsv } from '../lib/csv';
import { badRequest, unprocessable } from '../lib/errors';
import { parse } from '../lib/validate';

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const LedgerQuery = z.object({
  from: z.string().regex(ISO, '日期格式应为 YYYY-MM-DD'),
  to: z.string().regex(ISO, '日期格式应为 YYYY-MM-DD'),
  kind: z.enum(COUPON_ISSUE_KINDS).optional(),
  templateId: z.coerce.number().int().positive().optional(),
  status: z.enum(['available', 'used', 'voided']).optional(),
  /** 券号或会员（姓名、手机号、会员号）里含的字 */
  q: z.string().trim().max(32).optional(),
});

export async function couponLedger(db: Db, raw: unknown, limit = COUPON_LEDGER_MAX): Promise<CouponLedger> {
  const q = parse(LedgerQuery, raw);
  if (q.from > q.to) throw badRequest('开始日期不能晚于结束日期');
  const code = q.q ? normalizeStoreCouponCode(q.q) : '';
  const like = q.q ? `%${q.q}%` : '';
  // 按发券的营业日筛（与券的统计、页面默认的「今天」同一口径；合并前 Codex 审查 28fdb50：凌晨营业日还没切时刚发的券要在今天里）
  const where = () => db`
    WHERE ci.business_date BETWEEN ${q.from}::date AND ${q.to}::date
      ${q.kind ? db`AND ci.kind = ${q.kind}` : db``}
      ${q.templateId ? db`AND c.template_id = ${q.templateId}` : db``}
      ${q.status ? db`AND c.status = ${q.status}` : db``}
      ${q.q ? db`AND (c.code = ${code} OR m.name ILIKE ${like} OR m.phone LIKE ${like} OR m.member_no ILIKE ${like})` : db``}`;
  // 一共几张（页面写清楚、超过一次能导的不让导；合并前 Codex 审查 bcd2901）
  const [counted] = await db<{ n: number }[]>`
    SELECT count(*)::int AS n FROM coupons c JOIN coupon_issues ci ON ci.id = c.issue_id LEFT JOIN members m ON m.id = c.member_id ${where()}`;
  const rows = await db<(Omit<CouponLedgerRow, 'kindLabel' | 'code' | 'hoursToUse'> & { rawCode: string; usedAt: Date | null; issuedAt: Date; voidedAt: Date | null })[]>`
    SELECT c.id, c.code AS raw_code, t.name AS template_name, ci.issue_no, ci.kind, ci.reason, ci.issued_at AS issued_at,
           isu.display_name AS issued_by_name, m.name AS member_name, m.member_no, r.doc_no AS recharge_doc_no,
           c.valid_from, c.valid_to, c.status, ck.checkout_no, u.at AS used_at, u.amount AS used_amount,
           vo.at AS voided_at, vo.reason AS void_reason
    FROM coupons c JOIN coupon_issues ci ON ci.id = c.issue_id JOIN coupon_templates t ON t.id = c.template_id
    LEFT JOIN staff isu ON isu.id = ci.issued_by LEFT JOIN members m ON m.id = c.member_id
    LEFT JOIN recharges r ON r.id = ci.recharge_id LEFT JOIN checkouts ck ON ck.id = c.checkout_id
    LEFT JOIN LATERAL (SELECT e.at, e.amount FROM coupon_events e WHERE e.coupon_id = c.id AND e.kind = 'use' ORDER BY e.id DESC LIMIT 1) u ON c.status = 'used'
    LEFT JOIN LATERAL (SELECT e.at, e.reason FROM coupon_events e WHERE e.coupon_id = c.id AND e.kind = 'void' ORDER BY e.id DESC LIMIT 1) vo ON c.status = 'voided'
    ${where()}
    ORDER BY ci.issued_at DESC, c.id DESC LIMIT ${limit + 1}`;
  const now = Date.now();
  const list: CouponLedgerRow[] = rows.slice(0, limit).map(({ rawCode, usedAt, issuedAt, voidedAt, ...r }) => {
    const end = usedAt ? new Date(usedAt).getTime() : now;
    return {
      ...r,
      id: Number(r.id),
      code: formatStoreCouponCode(rawCode),
      kindLabel: COUPON_ISSUE_KIND_LABELS[r.kind as CouponIssueKind] ?? r.kind,
      issuedAt: new Date(issuedAt).toISOString(),
      usedAt: usedAt ? new Date(usedAt).toISOString() : null,
      usedAmount: r.usedAmount === null ? null : Number(r.usedAmount),
      voidedAt: voidedAt ? new Date(voidedAt).toISOString() : null,
      // 发放时长：发出到用掉（没用的到现在；作废的不算）
      hoursToUse: r.status === 'voided' ? null : Math.max(0, Math.round((end - new Date(issuedAt).getTime()) / 360_000) / 10),
    };
  });
  const used = list.filter((r) => r.status === 'used');
  return {
    rows: list,
    truncated: rows.length > limit,
    total: counted?.n ?? 0,
    summary: {
      issued: list.length,
      used: used.length,
      usedAmount: used.reduce((t, r) => t + (r.usedAmount ?? 0), 0),
      voided: list.filter((r) => r.status === 'voided').length,
      avgHoursToUse: used.length ? Math.round((used.reduce((t, r) => t + (r.hoursToUse ?? 0), 0) / used.length) * 10) / 10 : null,
    },
  };
}

export function registerCouponLedgerRoutes(app: FastifyInstance, deps: Deps) {
  app.get('/api/coupons/ledger', { preHandler: guard('coupon.manage') }, async (req) => couponLedger(deps.sql, req.query, COUPON_LEDGER_MAX));
  app.get('/api/coupons/ledger.csv', { preHandler: guard('coupon.manage') }, async (req, reply) => {
    const ledger = await couponLedger(deps.sql, req.query, COUPON_LEDGER_EXPORT_MAX);
    // 多于一次能导的：不悄悄截掉、给一份看着完整的台账，拒绝并写明怎么缩小（合并前 Codex 审查 bcd2901）
    if (ledger.truncated) {
      throw unprocessable('LEDGER_TOO_MANY', `这段时间的券超过 ${COUPON_LEDGER_EXPORT_MAX.toLocaleString()} 张，一次导不完：请缩短日期范围，或按券、发放方式、状态分开导出`);
    }
    const ctx = ctxOf(req);
    await writeAudit(deps.sql, {
      staffId: ctx.actor.id,
      action: 'coupon_ledger_export',
      targetType: 'coupon',
      detail: { query: req.query as Record<string, unknown>, rows: ledger.rows.length },
      ip: ctx.ip,
    });
    return csvReply(reply, 'coupon-ledger.csv', toCsv(couponLedgerCsvRows(ledger.rows)));
  });
}
