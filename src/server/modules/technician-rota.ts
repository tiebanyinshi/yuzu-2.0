// 轮班周期（8.1.41，docs/V8141_ROTA.md）：门店自己定的轮班清单存在 settings 的 technician_rotas（按店，第二家店存 store_settings），
// 保存走 saveRuleSetting（设置锁、审计 settings_updated）。按轮班生成排班的格子由 @shared/technician-rota 算，
// 写进排班表在 technician-admin.ts（与排班同一条路：同样的核对、同样的改动记录与审计）。

import { z } from 'zod';
import { ISO_DATE } from '@shared/business-date';
import { MAX_ROTA_NAME, MAX_ROTA_SEGMENTS, MAX_ROTAS, MAX_SEGMENT_DAYS, ROTA_APPLY_MAX_TECHS, ROTA_MODES, rotaCellOn, type TechRota } from '@shared/technician-rota';
import { SCHEDULE_MAX_DAYS, type ScheduleCell } from '@shared/technician-admin';
import { shiftDate } from '@shared/labels';
import type { Db, Sql, Tx } from '../db';
import type { OpContext } from '../lib/context';
import { notFound, unprocessable } from '../lib/errors';
import { saveRuleSetting } from '../lib/rule-settings';
import { currentStoreId } from '../lib/store-context';
import { settingRow } from '../lib/store-settings';
import { parse } from '../lib/validate';

export const ROTAS_KEY = 'technician_rotas';

export async function loadRotas(db: Db): Promise<TechRota[]> {
  const row = await settingRow<TechRota[]>(db, ROTAS_KEY);
  return Array.isArray(row?.value) ? row.value : [];
}

const SegmentInput = z.object({
  days: z.number('请填写天数').int('天数要是整数').min(1, '每段至少 1 天').max(MAX_SEGMENT_DAYS, `每段最多 ${MAX_SEGMENT_DAYS} 天`),
  shiftId: z.number().int().positive().nullable(),
});

const RotaInput = z
  .object({
    /** 已有的带原编号；新建的不带 */
    id: z.number().int().positive().nullish(),
    name: z.string('请填写轮班的名字').trim().min(1, '请填写轮班的名字').max(MAX_ROTA_NAME, `轮班的名字最多 ${MAX_ROTA_NAME} 个字`),
    mode: z.enum(ROTA_MODES, '请选择转班口径'),
    anchor: z.string().regex(ISO_DATE, '起算日格式应为 YYYY-MM-DD').nullish(),
    segments: z.array(SegmentInput).min(1, '至少要有一段').max(MAX_ROTA_SEGMENTS, `最多 ${MAX_ROTA_SEGMENTS} 段`),
  })
  .refine((r) => r.mode !== 'cycle' || !!r.anchor, { message: '按周期轮转要填起算日', path: ['anchor'] });

const RotasInput = z.object({
  rotas: z
    .array(RotaInput)
    .max(MAX_ROTAS, `轮班最多 ${MAX_ROTAS} 个`)
    .refine((list) => new Set(list.map((r) => r.name)).size === list.length, '轮班的名字不能重复')
    .refine((list) => {
      const ids = list.flatMap((r) => (r.id ? [r.id] : []));
      return new Set(ids).size === ids.length;
    }, '轮班的编号重复了，请刷新后重试'),
});

/** 整份保存轮班清单：班次要在用、是这家店的；新建的编号接着已有的最大号往后排 */
export function saveRotas(sql: Sql, raw: unknown, ctx: OpContext): Promise<TechRota[]> {
  const { rotas } = parse(RotasInput, raw);
  return saveRuleSetting(
    sql,
    ROTAS_KEY,
    loadRotas,
    async (before, tx: Tx) => {
      const shiftIds = [...new Set(rotas.flatMap((r) => r.segments.flatMap((g) => (g.shiftId === null ? [] : [g.shiftId]))))];
      if (shiftIds.length) {
        const found = await tx<{ id: number }[]>`SELECT id FROM technician_shifts WHERE id IN ${tx(shiftIds)} AND active AND store_id = ${currentStoreId()}`;
        if (found.length !== shiftIds.length) throw unprocessable('ROTA_SHIFT_INVALID', '轮班里有班次不存在或已停用，请刷新后重新选');
      }
      let next = Math.max(0, ...before.map((r) => r.id), ...rotas.map((r) => r.id ?? 0));
      return rotas.map((r) => ({
        id: r.id ?? (next += 1),
        name: r.name,
        mode: r.mode,
        anchor: r.mode === 'cycle' ? r.anchor! : null,
        segments: r.segments.map((g) => ({ days: g.days, shiftId: g.shiftId })),
      }));
    },
    ctx,
  );
}

export const ApplyInput = z.object({
  technicianIds: z
    .array(z.number().int().positive())
    .min(1, '请选择技师')
    .max(ROTA_APPLY_MAX_TECHS, `一次最多 ${ROTA_APPLY_MAX_TECHS} 位技师`)
    .refine((ids) => new Set(ids).size === ids.length, '技师选重了'),
  /** 每位技师错开几段（技师编号 → 段数）；没给的不错开 */
  offsets: z.record(z.string(), z.number().int().min(-100).max(100)).default({}),
  from: z.string('请填写从哪天开始').regex(ISO_DATE, '开始日期格式应为 YYYY-MM-DD'),
  days: z.number('请填写排几天').int().min(1, '至少排 1 天').max(SCHEDULE_MAX_DAYS, `一次最多排 ${SCHEDULE_MAX_DAYS} 天`),
});
export type ApplyRequest = z.infer<typeof ApplyInput>;

/** 按轮班算出要写的格子（休息 = 排休） */
export async function rotaPlanCells(db: Db, rotaId: number, a: ApplyRequest): Promise<{ rota: TechRota; cells: ScheduleCell[] }> {
  const rota = (await loadRotas(db)).find((r) => r.id === rotaId);
  if (!rota) throw notFound('轮班不存在，请刷新');
  const cells: ScheduleCell[] = [];
  for (let i = 0; i < a.days; i += 1) {
    const date = shiftDate(a.from, i);
    for (const technicianId of a.technicianIds) {
      const c = rotaCellOn(rota, date, a.offsets[String(technicianId)] ?? 0);
      cells.push({ technicianId, date, shiftId: c.shiftId, rest: c.rest });
    }
  }
  return { rota, cells };
}
