// 技师统计与每月业绩任务（8.2.2，docs/V8222_TECHNICIANS.md 第 7 节）。
//   · GET /api/reports/technicians/calls?from&to：每天的扩钟数（按技师、按天），按挂账口径（没作废的扩钟明细，不含加钟）；
//   · GET /api/reports/technicians/periods?month：每 10 天一段的总业绩，所有工种、按工种小计（结账口径，与「技师业绩」同一份明细）；
//   · GET /api/reports/technicians/targets?month：每月任务与完成度；PUT /api/admin/technician-targets 整月替换目标（要「维护技师名册」）。
// 看的三项要「看技师业绩」（8.2.2 起财务职责也有）。只读的在只读快照里查；改目标拿这家店的「技师任务」咨询锁，整月删了重写，审计记改前改后。

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ISO_DATE } from '@shared/business-date';
import { MAX_CALL_STAT_DAYS, MONTH_PATTERN, monthSegments, type CallStats, type PeriodKind, type PeriodStats, type PeriodTechRow, type TargetView, type TechTarget } from '@shared/technician-stats';
import { readSnapshot, type Db } from '../db';
import { guard } from '../auth/guard';
import { writeAudit } from '../lib/audit';
import type { Deps } from '../lib/context';
import { badRequest } from '../lib/errors';
import { cents, parse } from '../lib/validate';
import { currentStoreId, storeIn } from '../lib/store-context';
import { businessDate } from './frontdesk';
import { settledTechnicianLines } from './commission';
import { loadTechnicians } from './technicians';
import { withReportScope } from './stores';

const dayMs = 86_400_000;
const plusDays = (date: string, n: number) => new Date(Date.parse(`${date}T00:00:00Z`) + n * dayMs).toISOString().slice(0, 10);
const daysOf = (from: string, to: string) => Array.from({ length: Math.round((Date.parse(to) - Date.parse(from)) / dayMs) + 1 }, (_, i) => plusDays(from, i));

/** 每天的扩钟数：没作废的扩钟明细（不含加钟），按挂账的营业日 */
export async function callStats(db: Db, from: string, to: string): Promise<CallStats> {
  const rows = await db<{ date: string; technicianId: number; clocks: number }[]>`
    SELECT l.business_date::text AS date, l.technician_id, sum(l.quantity)::int AS clocks
    FROM bill_lines l JOIN technicians t ON t.id = l.technician_id
    WHERE l.call_type = 'call' AND NOT l.clock_extension AND l.status = 'active' AND l.business_date BETWEEN ${from} AND ${to} AND ${storeIn(db, 't.store_id')}
    GROUP BY 1, 2`;
  const techs = await loadTechnicians(db);
  const dates = daysOf(from, to);
  const byTech = new Map<number, CallStats['rows'][number]>();
  const totals: Record<string, number> = Object.fromEntries(dates.map((d) => [d, 0]));
  for (const r of rows) {
    const t = techs.get(Number(r.technicianId));
    const row = byTech.get(Number(r.technicianId)) ?? { technicianId: Number(r.technicianId), techNo: t?.techNo ?? '', name: t?.name ?? '', days: {}, total: 0 };
    row.days[r.date] = (row.days[r.date] ?? 0) + r.clocks;
    row.total += r.clocks;
    totals[r.date] = (totals[r.date] ?? 0) + r.clocks;
    byTech.set(row.technicianId, row);
  }
  const order = [...techs.keys()];
  const list = [...byTech.values()].sort((a, b) => b.total - a.total || order.indexOf(a.technicianId) - order.indexOf(b.technicianId));
  return { from, to, dates, rows: list, totals, total: list.reduce((n, r) => n + r.total, 0) };
}

/** 每 10 天一段的业绩：所有工种，按工种小计（工种 = 技师档案的「类型」，没设的单列一组） */
export async function periodStats(db: Db, month: string): Promise<PeriodStats> {
  const techs = await loadTechnicians(db);
  const segments = [];
  for (const seg of monthSegments(month)) {
    const lines = await settledTechnicianLines(db, seg.from, seg.to);
    const byTech = new Map<number, PeriodTechRow>();
    for (const l of lines) {
      const t = techs.get(l.technicianId);
      const row = byTech.get(l.technicianId) ?? { technicianId: l.technicianId, techNo: t?.techNo ?? '', name: t?.name ?? '', kind: t?.kind.trim() ?? '', clocks: 0, call: 0, extension: 0, amount: 0 };
      const q = l.sign * l.quantity;
      row.clocks += q;
      if (l.extension) row.extension += q;
      else if (l.callType === 'call') row.call += q;
      row.amount += l.sign * l.amount;
      byTech.set(l.technicianId, row);
    }
    const kinds = new Map<string, PeriodKind>();
    for (const r of byTech.values()) {
      const k = kinds.get(r.kind) ?? { kind: r.kind, clocks: 0, amount: 0, rows: [] };
      k.clocks += r.clocks;
      k.amount += r.amount;
      k.rows.push(r);
      kinds.set(r.kind, k);
    }
    const list = [...kinds.values()].sort((a, b) => (a.kind === '' ? 1 : b.kind === '' ? -1 : b.amount - a.amount));
    for (const k of list) k.rows.sort((a, b) => b.amount - a.amount || b.clocks - a.clocks);
    segments.push({ ...seg, kinds: list, total: { clocks: list.reduce((n, k) => n + k.clocks, 0), amount: list.reduce((n, k) => n + k.amount, 0) } });
  }
  return { month, segments, total: { clocks: segments.reduce((n, s) => n + s.total.clocks, 0), amount: segments.reduce((n, s) => n + s.total.amount, 0) } };
}

/** 每月任务与完成度：按技师设的看他本人，按组设的看组里现在的成员（结账口径，本月算到今天） */
export async function targetView(db: Db, month: string, today: string): Promise<TargetView> {
  const first = `${month}-01`;
  const last = monthSegments(month)[2]!.to;
  const through = today < last ? (today < first ? first : today) : last;
  const rows = await db<{ technicianId: number | null; groupId: number | null; amountCents: number; clocks: number | null; updatedAt: string; updatedBy: string }[]>`
    SELECT g.technician_id, g.group_id, g.amount_cents, g.clocks, g.updated_at, s.display_name AS updated_by
    FROM technician_targets g JOIN staff s ON s.id = g.updated_by
    WHERE g.store_id = ${currentStoreId()} AND g.month = ${first} ORDER BY g.group_id NULLS LAST, g.technician_id, g.id`;
  const techs = await loadTechnicians(db);
  const groups = new Map((await db<{ id: number; name: string }[]>`SELECT id, name FROM technician_groups WHERE store_id = ${currentStoreId()}`).map((g) => [Number(g.id), g.name]));
  const actual = new Map<number, { amount: number; clocks: number }>();
  if (through >= first) {
    for (const l of await settledTechnicianLines(db, first, through)) {
      const a = actual.get(l.technicianId) ?? { amount: 0, clocks: 0 };
      a.amount += l.sign * l.amount;
      a.clocks += l.sign * l.quantity;
      actual.set(l.technicianId, a);
    }
  }
  const targets: TechTarget[] = rows.map((r) => {
    const members = r.groupId !== null ? [...techs.values()].filter((t) => t.groupId === Number(r.groupId)).map((t) => t.id) : [Number(r.technicianId)];
    const sum = members.reduce((s, id) => ({ amount: s.amount + (actual.get(id)?.amount ?? 0), clocks: s.clocks + (actual.get(id)?.clocks ?? 0) }), { amount: 0, clocks: 0 });
    const t = r.technicianId !== null ? techs.get(Number(r.technicianId)) : undefined;
    const amount = Number(r.amountCents);
    return {
      technicianId: r.technicianId === null ? null : Number(r.technicianId),
      groupId: r.groupId === null ? null : Number(r.groupId),
      label: t ? `${t.techNo} 号 ${t.name}` : `${groups.get(Number(r.groupId)) ?? '已删的组'}（组）`,
      amount,
      clocks: r.clocks,
      actualAmount: sum.amount,
      actualClocks: sum.clocks,
      rate: amount > 0 ? Math.round((sum.amount / amount) * 100) : null,
    };
  });
  const latest = rows.reduce<(typeof rows)[number] | null>((x, r) => (!x || new Date(r.updatedAt) > new Date(x.updatedAt) ? r : x), null);
  return { month, through, targets, updatedAt: latest ? new Date(latest.updatedAt).toISOString() : null, updatedBy: latest?.updatedBy ?? null };
}

const TargetsInput = z.object({
  month: z.string().regex(MONTH_PATTERN, '月份格式应为 YYYY-MM'),
  targets: z
    .array(
      z
        .object({
          technicianId: z.number().int().positive().nullable().default(null),
          groupId: z.number().int().positive().nullable().default(null),
          amount: cents('目标金额').max(100_000_000_000, '目标金额过大'),
          clocks: z.number().int().min(0, '目标钟数不能为负').max(100_000, '目标钟数过大').nullable().default(null),
        })
        .refine((t) => (t.technicianId === null) !== (t.groupId === null), '每一行要么选技师、要么选组'),
    )
    .max(500, '一个月最多 500 条目标'),
});

const MonthQuery = z.object({ month: z.string().regex(MONTH_PATTERN, '月份格式应为 YYYY-MM') });

export function registerTechnicianStatsRoutes(app: FastifyInstance, deps: Deps) {
  const { sql } = deps;
  const read = { preHandler: guard('report.technicians') };

  app.get('/api/reports/technicians/calls', read, async (req) => {
    const q = parse(z.object({ from: z.string().regex(ISO_DATE, '日期格式应为 YYYY-MM-DD'), to: z.string().regex(ISO_DATE, '日期格式应为 YYYY-MM-DD') }), req.query);
    if (q.to < q.from) throw badRequest('结束日期不能早于开始日期');
    if (daysOf(q.from, q.to).length > MAX_CALL_STAT_DAYS) throw badRequest(`一次最多看 ${MAX_CALL_STAT_DAYS} 天`);
    return withReportScope(sql, req, () => readSnapshot(sql, (tx) => callStats(tx, q.from, q.to)));
  });

  app.get('/api/reports/technicians/periods', read, async (req) => {
    const { month } = parse(MonthQuery, req.query);
    return withReportScope(sql, req, () => readSnapshot(sql, (tx) => periodStats(tx, month)));
  });

  app.get('/api/reports/technicians/targets', read, async (req) => {
    const { month } = parse(MonthQuery, req.query);
    const today = await businessDate(sql, deps, new Date());
    return readSnapshot(sql, (tx) => targetView(tx, month, today));
  });

  app.put('/api/admin/technician-targets', { preHandler: guard('technician.manage') }, async (req) => {
    const input = parse(TargetsInput, req.body);
    const first = `${input.month}-01`;
    const keyOf = (t: { technicianId: number | null; groupId: number | null }) => (t.technicianId !== null ? `t${t.technicianId}` : `g${t.groupId}`);
    if (new Set(input.targets.map(keyOf)).size !== input.targets.length) throw badRequest('同一位技师或同一个组写了两行，请合并');
    await sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext(${`technician_targets:${currentStoreId()}`}))`;
      const techIds = input.targets.flatMap((t) => (t.technicianId === null ? [] : [t.technicianId]));
      const groupIds = input.targets.flatMap((t) => (t.groupId === null ? [] : [t.groupId]));
      if (techIds.length) {
        const found = await tx<{ id: number }[]>`SELECT id FROM technicians WHERE id IN ${tx(techIds)} AND store_id = ${currentStoreId()}`;
        if (found.length !== new Set(techIds).size) throw badRequest('有技师不在本店，请刷新后重试');
      }
      if (groupIds.length) {
        const found = await tx<{ id: number }[]>`SELECT id FROM technician_groups WHERE id IN ${tx(groupIds)} AND store_id = ${currentStoreId()}`;
        if (found.length !== new Set(groupIds).size) throw badRequest('有技师组不在本店，请刷新后重试');
      }
      const before = await tx<{ technicianId: number | null; groupId: number | null; amountCents: number; clocks: number | null }[]>`
        SELECT technician_id, group_id, amount_cents, clocks FROM technician_targets WHERE store_id = ${currentStoreId()} AND month = ${first} ORDER BY id`;
      await tx`DELETE FROM technician_targets WHERE store_id = ${currentStoreId()} AND month = ${first}`;
      const at = new Date();
      for (const t of input.targets) {
        await tx`
          INSERT INTO technician_targets (month, technician_id, group_id, amount_cents, clocks, updated_by, updated_at)
          VALUES (${first}, ${t.technicianId}, ${t.groupId}, ${t.amount}, ${t.clocks}, ${req.actor.id}, ${at})`;
      }
      await writeAudit(tx, {
        staffId: req.actor.id,
        action: 'technician_targets_saved',
        targetType: 'technician_targets',
        targetId: input.month,
        detail: { month: input.month, before, after: input.targets, summary: `设 ${input.month} 的技师业绩任务：${input.targets.length} 条` },
        ip: req.ip,
      });
    });
    return targetView(sql, input.month, await businessDate(sql, deps, new Date()));
  });
}
