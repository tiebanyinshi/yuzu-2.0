// 前台备注的读取（8.1.44，docs/V8144_CASHIER.md 第 1、2 条）：一位客人的单人备注与他所在同行组的同组备注。
// 只读、不加锁；写入在 remarks.ts（它要读来访详情，来访详情又要读这里，所以读的这一半单放一个文件）。

import type { VisitRemark } from '@shared/frontdesk-remarks';
import type { Db } from '../../db';

type RemarkRow = Omit<VisitRemark, 'removed'> & { removedByName: string | null; removedAt: string | null; removedReason: string | null };

/** 一位客人看得到的备注：自己的单人备注 + 现在所在同行组的同组备注（含撤下的），按时间先后 */
export async function visitRemarks(db: Db, visitId: number, groupId: number | null): Promise<VisitRemark[]> {
  const rows = await db<RemarkRow[]>`
    SELECT r.id, r.scope, r.visit_id, t.code AS tag_code, g.group_no, r.tag, r.note, r.created_by AS created_by_id,
           s.display_name AS created_by_name, r.created_at,
           xs.display_name AS removed_by_name, x.created_at AS removed_at, x.reason AS removed_reason
    FROM visit_remarks r
    JOIN visits v ON v.id = r.visit_id JOIN hand_tags t ON t.id = v.tag_id JOIN staff s ON s.id = r.created_by
    LEFT JOIN visit_groups g ON g.id = r.group_id
    LEFT JOIN visit_remark_removals x ON x.remark_id = r.id LEFT JOIN staff xs ON xs.id = x.created_by
    WHERE (r.scope = 'single' AND r.visit_id = ${visitId}) OR (${groupId}::bigint IS NOT NULL AND r.group_id = ${groupId})
    ORDER BY r.id`;
  return rows.map(({ removedByName, removedAt, removedReason, ...r }) => ({
    ...r,
    id: Number(r.id),
    visitId: Number(r.visitId),
    createdById: Number(r.createdById),
    removed: removedAt ? { byName: removedByName ?? '', at: removedAt, reason: removedReason ?? '' } : null,
  }));
}

/**
 * 手牌板上每位在店客人的备注标签（v 是来访）：自己的单人备注与所在组的同组备注里、没撤下的、带了标签的，去重排好。
 * 收银台待结账清单据此标出「客诉」等
 */
export const remarkTagsSql = (db: Db) => db`
  (SELECT coalesce(array_agg(DISTINCT r.tag ORDER BY r.tag), '{}') FROM visit_remarks r
   WHERE ((r.scope = 'single' AND r.visit_id = v.id) OR r.group_id = v.group_id) AND r.tag <> ''
     AND NOT EXISTS (SELECT 1 FROM visit_remark_removals x WHERE x.remark_id = r.id))`;
