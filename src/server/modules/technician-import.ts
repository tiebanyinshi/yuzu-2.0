// 技师名册导入（8.1.35 福田迁移第二批，docs/FUTIAN_MIGRATION.md 第 2.4 节）：命令行 `import-technicians <技师导入模板.xlsx|csv> [--store FT] [--apply]`。
// 在当前门店（--store 指定）里：技师号已有的跳过（不改已有技师，停用的也算），没有的新建；表里的组别没有的建技师分组；
// 默认只预览，--apply 才写；整批一个事务，先取这家店的「技师导入」咨询锁（几次导入排队），只插新行、不锁已有的技师。
// 表格里有问题的行（技师号、姓名、性别、等级、日期认不出来）整批不导，除非加 --skip-invalid（只导没问题的，问题行列出来）。

import type { TechnicianImportRow } from '@shared/technician-import';
import type { Sql } from '../db';
import { writeAudit } from '../lib/audit';
import { currentStoreId } from '../lib/store-context';
import { setTxTimeouts } from '../lib/tx';

export interface TechnicianImportReport {
  total: number;
  /** 会新建 / 已新建的 */
  created: number;
  /** 技师号本店已有，跳过的 */
  existing: string[];
  /** 按组别跳过的（如测试组） */
  skippedByGroup: number;
  /** 会新建 / 已新建的分组 */
  groupsCreated: string[];
  /** 表里用到、原来停用了的分组：导入时重新启用 */
  groupsReactivated: string[];
  byGrade: Record<string, number>;
}

export async function importTechnicians(sql: Sql, rows: TechnicianImportRow[], opts: { apply: boolean; staffId: number | null; skipGroups?: string[] }): Promise<TechnicianImportReport> {
  const storeId = currentStoreId();
  return sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    await tx`SELECT pg_advisory_xact_lock(hashtext(${`technician_import:${storeId}`}))`;
    const skip = new Set((opts.skipGroups ?? []).map((g) => g.trim()).filter(Boolean));
    const wanted = rows.filter((r) => !(r.group && skip.has(r.group)));
    const have = new Set((await tx<{ techNo: string }[]>`SELECT tech_no FROM technicians WHERE store_id = ${storeId}`).map((r) => r.techNo));
    const existingNos = wanted.filter((r) => have.has(r.techNo)).map((r) => r.techNo);
    const fresh = wanted.filter((r) => !have.has(r.techNo));
    // 与唯一索引 technician_groups_name_uq（store_id, lower(btrim(name))）同一个比法，停用的也算（Codex 审查：
    // 只看在用的会把停用的同名组当成没有、去新建，撞唯一索引整批回滚）。表里的组别对上停用的组：导入时重新启用它
    const gk = (name: string) => name.trim().toLowerCase();
    const existing = await tx<{ id: number; name: string; active: boolean }[]>`SELECT id, name, active FROM technician_groups WHERE store_id = ${storeId}`;
    const groups = new Map(existing.map((g) => [gk(g.name), Number(g.id)]));
    const inactive = new Map(existing.filter((g) => !g.active).map((g) => [gk(g.name), g.name]));
    const wantedGroups = [...new Map(fresh.filter((r) => r.group).map((r) => [gk(r.group!), r.group!])).entries()];
    const needGroups = wantedGroups.filter(([k]) => !groups.has(k)).map(([, name]) => name);
    const reactivate = wantedGroups.filter(([k]) => inactive.has(k)).map(([k]) => inactive.get(k)!);
    const byGrade: Record<string, number> = {};
    for (const r of fresh) byGrade[r.grade] = (byGrade[r.grade] ?? 0) + 1;
    const report: TechnicianImportReport = {
      total: rows.length,
      created: fresh.length,
      existing: existingNos,
      skippedByGroup: rows.length - wanted.length,
      groupsCreated: needGroups,
      groupsReactivated: reactivate,
      byGrade,
    };
    if (!opts.apply || fresh.length === 0) return report;
    const [top] = await tx<{ start: number }[]>`SELECT coalesce(max(sort_order), 0)::int AS start FROM technician_groups WHERE store_id = ${storeId}`;
    const start = top?.start ?? 0;
    if (reactivate.length) {
      await tx`UPDATE technician_groups SET active = true WHERE store_id = ${storeId} AND NOT active AND lower(btrim(name)) IN ${tx(reactivate.map(gk))}`;
    }
    for (const [i, name] of needGroups.entries()) {
      const [g] = await tx<{ id: number }[]>`
        INSERT INTO technician_groups (store_id, name, sort_order, created_by) VALUES (${storeId}, ${name}, ${Math.min(9999, start + i + 1)}, ${opts.staffId}) RETURNING id`;
      groups.set(gk(name), Number(g!.id));
    }
    for (const r of fresh) {
      await tx`
        INSERT INTO technicians (store_id, tech_no, name, gender, grade, skills, active, sort_order, note, created_by, nickname, kind, hired_on, group_id)
        VALUES (${storeId}, ${r.techNo}, ${r.name}, ${r.gender}, ${r.grade}, '{}'::text[], true, 0, '', ${opts.staffId}, ${r.nickname}, '', ${r.hiredOn},
                ${r.group ? (groups.get(gk(r.group)) ?? null) : null})`;
    }
    await writeAudit(tx, {
      staffId: opts.staffId,
      action: 'technicians_imported',
      targetType: 'technician',
      detail: {
        summary: `导入技师名册：新建 ${fresh.length} 位、分组 ${needGroups.length} 个（重新启用 ${reactivate.length} 个），技师号已有跳过 ${existingNos.length} 位`,
        created: fresh.length,
        groups: needGroups,
        reactivated: reactivate,
        existing: existingNos,
      },
    });
    return report;
  });
}
