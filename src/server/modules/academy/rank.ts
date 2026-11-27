// 学堂 · 榜单（docs/ACADEMY.md 第 5 节，PENDING_DECISIONS XT06）：学分榜、时长榜；本月 / 累计；全公司 / 本店。
// 只排在职员工；显示姓名、门店、部门；不在前 N 名的另给「我」的名次。

import type { AcademyRank, AcademyRankBoard, AcademyRankPeriod, AcademyRankRow, AcademyRankScope } from '@shared/academy';
import type { Db } from '../../db';
import { DEFAULT_STORE_ID } from '../../lib/store-context';
import { onDuty } from '../oa';
import { staffStoreName } from './catalog';

export const ACADEMY_RANK_LIMIT = 50;

/** 员工（别名 s）在这家店：挂了这家店；没挂任何门店的按本店（与登录时的 storeIdsOf 一致，Codex 审查 dd885a6） */
const inStore = (db: Db, storeId: number) => db`(
  EXISTS (SELECT 1 FROM staff_stores ss WHERE ss.staff_id = s.id AND ss.store_id = ${storeId})
  OR (${storeId === DEFAULT_STORE_ID} AND NOT EXISTS (SELECT 1 FROM staff_stores ss WHERE ss.staff_id = s.id)))`;

export async function rank(
  db: Db,
  input: { staffId: number; board: AcademyRankBoard; period: AcademyRankPeriod; scope: AcademyRankScope; storeId: number; today: string; timeZone: string; limit?: number },
): Promise<AcademyRank> {
  const monthStart = `${input.today.slice(0, 7)}-01`;
  const month = input.period === 'month';
  const totals =
    input.board === 'credits'
      ? db`SELECT staff_id, sum(points)::int AS value FROM academy_credits
           ${month ? db`WHERE (created_at AT TIME ZONE ${input.timeZone})::date >= ${monthStart}` : db``} GROUP BY staff_id`
      : db`SELECT staff_id, (sum(seconds) / 60)::int AS value FROM academy_study_days
           ${month ? db`WHERE day >= ${monthStart}` : db``} GROUP BY staff_id`;
  const rows = await db<(Omit<AcademyRankRow, 'rank'> & { rank: number })[]>`
    WITH t AS (${totals}),
    ranked AS (
      SELECT s.id AS staff_id, s.display_name AS name, ${staffStoreName(db)} AS store_name, d.name AS department_name, t.value,
             rank() OVER (ORDER BY t.value DESC)::int AS rank, s.id AS sort_id
      FROM t JOIN staff s ON s.id = t.staff_id
      LEFT JOIN staff_profiles p ON p.staff_id = s.id
      LEFT JOIN position_catalog pc ON pc.key = s.position LEFT JOIN org_departments d ON d.key = pc.department
      WHERE t.value > 0 AND ${onDuty(db)}
        ${input.scope === 'store' ? db`AND ${inStore(db, input.storeId)}` : db``})
    SELECT staff_id, name, store_name, department_name, value, rank FROM ranked
    WHERE rank <= ${input.limit ?? ACADEMY_RANK_LIMIT} OR staff_id = ${input.staffId}
    ORDER BY rank, sort_id`;
  const toRow = (r: (typeof rows)[number]): AcademyRankRow => ({
    rank: r.rank,
    staffId: Number(r.staffId),
    name: r.name,
    storeName: r.storeName,
    departmentName: r.departmentName,
    value: r.value,
  });
  const all = rows.map(toRow);
  const limit = input.limit ?? ACADEMY_RANK_LIMIT;
  return {
    board: input.board,
    period: input.period,
    scope: input.scope,
    rows: all.filter((r) => r.rank <= limit),
    me: all.find((r) => r.staffId === input.staffId) ?? null,
  };
}
