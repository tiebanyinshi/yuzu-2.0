// 业财法的阈值（8.2.10，WB4）：零星采购基础审核线、部门备用金日 / 月额度默认值、采购部门日累计、验收期限、升级审核角色。
// 存在 gf_settings 的 rules 一行（只存改过的键也行），没存过的按 DEFAULT_GF_RULES（与 8.2.9 以前的常量一样，升级后行为不变）。

import { z } from 'zod';
import { GF_ROLES } from '@shared/govflow';
import { DEFAULT_GF_RULES, type GfRules } from '@shared/govflow-petty';
import type { Db } from '../../db';

const YUAN_MAX = 100_000_000; // 100 万元

export const RulesInput = z
  .object({
    pettyBasicCents: z.number().int().min(100, '基础审核金额至少 1 元').max(YUAN_MAX, '基础审核金额最多 100 万元'),
    pettyBasicQty: z.number().int().min(1, '基础审核件数至少 1 件').max(100_000, '基础审核件数太大'),
    deptDailyCents: z.number().int().min(100, '日额度至少 1 元').max(YUAN_MAX, '日额度最多 100 万元'),
    deptMonthlyCents: z
      .number()
      .int()
      .min(100, '月额度至少 1 元')
      .max(10 * YUAN_MAX, '月额度最多 1,000 万元'),
    purchaseDeptDailyCents: z.number().int().min(100, '采购部门日累计至少 1 元').max(YUAN_MAX, '采购部门日累计最多 100 万元'),
    pettyAcceptDays: z.number().int().min(1, '验收期限至少 1 天').max(90, '验收期限最多 90 天'),
    pettyEscalationRole: z.enum(GF_ROLES, '升级审核角色不对').nullable(),
  })
  .refine((r) => r.deptMonthlyCents >= r.deptDailyCents, { message: '月额度不能小于日额度', path: ['deptMonthlyCents'] });

/** 读阈值：存过的键覆盖默认值；存的东西不合格（手改过库）的整份按默认，免得审批卡住 */
export async function loadGfRules(db: Db): Promise<GfRules> {
  const [r] = await db<{ value: Partial<GfRules> }[]>`SELECT value FROM gf_settings WHERE key = 'rules'`;
  const merged = { ...DEFAULT_GF_RULES, ...r?.value };
  const ok = RulesInput.safeParse(merged);
  return ok.success ? ok.data : { ...DEFAULT_GF_RULES };
}

/** 读阈值，带最后一次谁、什么时候改的 */
export async function loadGfRulesMeta(db: Db): Promise<{ by: string | null; at: Date | null }> {
  const [r] = await db<{ by: string; at: Date }[]>`SELECT s.display_name AS by, g.updated_at AS at FROM gf_settings g JOIN staff s ON s.id = g.updated_by WHERE g.key = 'rules'`;
  return { by: r?.by ?? null, at: r?.at ?? null };
}
