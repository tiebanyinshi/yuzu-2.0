// OA-13 节假日表（docs/OA.md 第 16 节；需求文档待确认第 7 条，OA15）：后台「考勤设置 → 节假日」按年维护
// 节假日 / 调休上班。整年一起保存，带版本（别人先改过拒绝），记审计；全公司一份。用在加班单的核对（attendance-link.ts）。
// 加锁：这一年的版本行（oa_holiday_years，FOR UPDATE；还没有的插入，同时插入撞唯一键按「别人先改过」处理）→ 删了重写这一年的日子。

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { HOLIDAY_KIND_LABELS, HOLIDAY_NAME_MAX, type HolidayDay, type HolidayYear } from '@shared/oa';
import { isUniqueViolation, type Db } from '../../db';
import { guard } from '../../auth/guard';
import { writeAudit } from '../../lib/audit';
import type { Deps } from '../../lib/context';
import { conflict, unprocessable } from '../../lib/errors';
import { dateSchema, parse } from '../../lib/validate';
import { localMinute } from './punches';

const manage = guard('hr.attendance');
const yearSchema = z.coerce.number().int().min(2000).max(2100);
const SaveInput = z.object({
  version: z.number().int().min(0),
  days: z
    .array(
      z.object({
        day: dateSchema('日期'),
        kind: z.enum(['holiday', 'workday']),
        name: z.string().trim().min(1, '请填写名称').max(HOLIDAY_NAME_MAX, `名称最多 ${HOLIDAY_NAME_MAX} 个字`),
      }),
    )
    .max(366),
});

async function loadYear(db: Db, year: number): Promise<HolidayYear> {
  const [y] = await db<{ version: number; updatedByName: string | null; updatedAt: Date }[]>`
    SELECT y.version, s.display_name AS updated_by_name, y.updated_at FROM oa_holiday_years y LEFT JOIN staff s ON s.id = y.updated_by WHERE y.year = ${year}`;
  const days = await db<HolidayDay[]>`SELECT day::text AS day, kind, name FROM oa_holidays WHERE day BETWEEN ${`${year}-01-01`} AND ${`${year}-12-31`} ORDER BY day`;
  return { year, version: y?.version ?? 0, days, updatedByName: y?.updatedByName ?? null, updatedAt: y ? new Date(y.updatedAt).toISOString() : null };
}

export function registerOaHolidayRoutes(app: FastifyInstance, deps: Deps) {
  const { sql } = deps;

  app.get('/api/oa/attendance/holidays', { preHandler: manage }, async (req): Promise<HolidayYear> => {
    const q = parse(z.object({ year: yearSchema.optional() }), req.query ?? {});
    return loadYear(sql, q.year ?? Number(localMinute(new Date(), deps.config.timezone).date.slice(0, 4)));
  });

  // 整年保存（带页面上看到的版本；还没保存过的是 0）
  app.put('/api/oa/attendance/holidays/:year', { preHandler: manage }, async (req): Promise<HolidayYear> => {
    const { year } = parse(z.object({ year: yearSchema }), req.params);
    const input = parse(SaveInput, req.body);
    const seen = new Set<string>();
    for (const d of input.days) {
      if (!d.day.startsWith(`${year}-`)) throw unprocessable('HOLIDAY_YEAR', `${d.day} 不在 ${year} 年里`);
      if (seen.has(d.day)) throw unprocessable('HOLIDAY_DUPLICATE', `${d.day} 填了两次`);
      seen.add(d.day);
    }
    try {
      await sql.begin(async (tx) => {
        const [row] = await tx<{ version: number }[]>`SELECT version FROM oa_holiday_years WHERE year = ${year} FOR UPDATE`;
        if ((row?.version ?? 0) !== input.version) throw conflict('VERSION_CONFLICT', `${year} 年的节假日刚被别人改过，请刷新后再改`);
        if (row) await tx`UPDATE oa_holiday_years SET version = version + 1, updated_by = ${req.actor.id}, updated_at = now() WHERE year = ${year}`;
        else await tx`INSERT INTO oa_holiday_years (year, updated_by) VALUES (${year}, ${req.actor.id})`;
        const before = await tx<HolidayDay[]>`SELECT day::text AS day, kind, name FROM oa_holidays WHERE day BETWEEN ${`${year}-01-01`} AND ${`${year}-12-31`} ORDER BY day`;
        await tx`DELETE FROM oa_holidays WHERE day BETWEEN ${`${year}-01-01`} AND ${`${year}-12-31`}`;
        const days = [...input.days].sort((a, b) => a.day.localeCompare(b.day));
        if (days.length) {
          await tx`
            INSERT INTO oa_holidays (day, kind, name)
            SELECT * FROM unnest(${days.map((d) => d.day)}::date[], ${days.map((d) => d.kind)}::text[], ${days.map((d) => d.name)}::text[])`;
        }
        const count = (k: 'holiday' | 'workday') => days.filter((d) => d.kind === k).length;
        await writeAudit(tx, {
          staffId: req.actor.id,
          action: 'oa_holidays_saved',
          targetType: 'oa_holiday_year',
          targetId: year,
          detail: { before, after: days, summary: `保存 ${year} 年节假日表：${HOLIDAY_KIND_LABELS.holiday} ${count('holiday')} 天、${HOLIDAY_KIND_LABELS.workday} ${count('workday')} 天` },
          ip: req.ip,
        });
      });
    } catch (error) {
      if (isUniqueViolation(error, 'oa_holiday_years_pkey')) throw conflict('VERSION_CONFLICT', `${year} 年的节假日刚被别人改过，请刷新后再改`);
      throw error;
    }
    return loadYear(sql, year);
  });
}
