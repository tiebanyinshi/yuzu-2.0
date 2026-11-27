// 8.2.20 休闲娱乐（docs/V82220_LEISURE.md；走场「网吧、桌球等独立收费；价目表一键导入；网吧刷手牌开机计时」）。
//   · 计时就是「开单即占用」（usages.ts）：刷手牌开单 = 开始计时，结束 = 按时长挂到手牌账单（各业态自己的收银项目，部门是「娱乐」，单独收）；
//   · 这里只做「按价目表一键建」：生效中的价目表「娱乐价格」里按时长收费的几行（39/2h，加钟/19.9，台数 20）
//     → 业态加进开单即占用与休闲娱乐页、计费设成「基础价含时长 + 加钟」、按台数在台账里建台位（NB01…）。已有的不重复建。
// 加锁：规则设置的锁（saveRuleSetting）→ 空间台账的锁（lockLedger）→ 楼层一行（共享锁）。

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { leisureCode, leisurePrefix, type LeisurePlan, type LeisurePlanRow, type LeisureSetupResult } from '@shared/leisure';
import { priceNameKey } from '@shared/price-catalog';
import { isTechnicianBusinessType, ROOM_BUSINESS_TYPE, SPACE_CODE_RE } from '@shared/spaces';
import { MAX_USAGE_MIN_MINUTES, USAGE_STEP_OPTIONS, type UsageRules } from '@shared/usages';
import type { Db, Tx } from '../db';
import { guard } from '../auth/guard';
import { writeAudit } from '../lib/audit';
import { ctxOf, type Deps, type OpContext } from '../lib/context';
import { badRequest, conflict, notFound } from '../lib/errors';
import { saveRuleSetting } from '../lib/rule-settings';
import { currentStoreId } from '../lib/store-context';
import { parse } from '../lib/validate';
import { activePriceCatalog } from './price-catalog/index';
import { lockLedger } from './spaces';
import { loadUsageRules } from './usages';

const MAX_NAME = 8;

/** 生效中的价目表里按时长收费的娱乐 → 建台位与计费的计划 */
export async function leisurePlan(db: Db | Tx): Promise<LeisurePlan> {
  const catalog = await activePriceCatalog(db);
  const floors = await db<{ id: number; code: string; name: string }[]>`
    SELECT id, code, name FROM floors WHERE active AND store_id = ${currentStoreId()} ORDER BY sort_order, code`;
  const entries = catalog.entries.filter((e) => e.sheet === 'entertainment' && e.kind === 'entertainment' && e.durationMinutes !== null && e.priceCents !== null);
  const links = entries.length
    ? await db<{ entryKey: string; itemId: number; name: string; active: boolean }[]>`
        SELECT l.entry_key, l.item_id, i.name, i.active FROM price_catalog_links l JOIN service_items i ON i.id = l.item_id
        WHERE l.store_id = ${currentStoreId()} AND l.entry_key IN ${db(entries.map((e) => priceNameKey(e)))}`
    : [];
  const linkOf = new Map(links.map((l) => [l.entryKey, l]));
  const counts = await db<{ businessType: string; n: number }[]>`
    SELECT business_type, count(*)::int AS n FROM spaces WHERE active AND store_id = ${currentStoreId()} GROUP BY business_type`;
  const countOf = new Map(counts.map((c) => [c.businessType, Number(c.n)]));
  const rows = entries.map((e, i): LeisurePlanRow => {
    const name = e.name.replace(/\s+/g, '').slice(0, MAX_NAME);
    const link = linkOf.get(priceNameKey(e));
    const minMinutes = e.durationMinutes!;
    const stepMinutes = e.extraMinutes ?? 60;
    const extraGuessed = e.extraPriceCents === null;
    const extraPrice = e.extraPriceCents ?? Math.max(1, Math.round((e.priceCents! * stepMinutes) / Math.max(1, minMinutes)));
    let problem: string | null = null;
    if (!link) problem = '价目表这一行还没对接收银项目（先到「全品类价目表」切换生效一次）';
    else if (!link.active) problem = `收银项目「${link.name}」已停用`;
    else if (minMinutes > MAX_USAGE_MIN_MINUTES) problem = `基础价含的时长超过 ${MAX_USAGE_MIN_MINUTES / 60} 小时，请在后台按小时价手动设`;
    else if (!(USAGE_STEP_OPTIONS as readonly number[]).includes(stepMinutes)) problem = `加钟每 ${stepMinutes} 分钟不在可选的计费单位里`;
    else if (name === ROOM_BUSINESS_TYPE || isTechnicianBusinessType(name)) problem = `「${name}」不能当开单即占用的业态`;
    return {
      name,
      itemId: link ? Number(link.itemId) : null,
      itemName: link?.name ?? null,
      basePrice: e.priceCents!,
      minMinutes,
      extraPrice,
      stepMinutes,
      extraGuessed,
      units: e.unitsCount ?? 0,
      existing: countOf.get(name) ?? 0,
      prefix: leisurePrefix(name, i),
      problem,
    };
  });
  return { catalogTitle: catalog.set?.title ?? null, floors: floors.map((f) => ({ ...f, id: Number(f.id) })), rows };
}

const SetupInput = z.object({
  floorId: z.number('请选择台位建在哪一层').int().positive('请选择台位建在哪一层'),
  types: z
    .array(
      z.object({
        name: z.string().trim().min(1).max(MAX_NAME),
        prefix: z
          .string('请填写编码前缀')
          .trim()
          .toUpperCase()
          .regex(/^[A-Z][0-9A-Z]{0,5}$/, '编码前缀是大写字母开头、最多 6 位的字母或数字'),
      }),
      '请选择要建的娱乐',
    )
    .min(1, '请至少选一种娱乐')
    .max(20),
});

/** 按价目表一键建：业态、计费、台位（已有的不重复建） */
export async function setupLeisure(deps: Deps, raw: unknown, ctx: OpContext): Promise<LeisureSetupResult> {
  const input = parse(SetupInput, raw);
  if (new Set(input.types.map((t) => t.prefix)).size !== input.types.length) throw badRequest('几种娱乐的编码前缀不能一样');
  const result: LeisureSetupResult = { types: [], created: [], skipped: [] };
  await saveRuleSetting<UsageRules>(
    deps.sql,
    'usage_rules',
    loadUsageRules,
    async (cur, tx) => {
      await lockLedger(tx);
      const [floor] = await tx<{ code: string; active: boolean }[]>`SELECT code, active FROM floors WHERE id = ${input.floorId} AND store_id = ${currentStoreId()} FOR SHARE`;
      if (!floor) throw notFound('楼层不存在，请刷新后重试');
      if (!floor.active) throw conflict('FLOOR_INACTIVE', `楼层 ${floor.code} 已停用`);
      const plan = await leisurePlan(tx);
      const next: UsageRules = { businessTypes: [...cur.businessTypes], pricing: { ...cur.pricing }, leisureTypes: [...(cur.leisureTypes ?? [])] };
      for (const t of input.types) {
        const row = plan.rows.find((r) => r.name === t.name);
        if (!row) throw conflict('LEISURE_NOT_IN_CATALOG', `生效中的价目表里没有按时长收费的「${t.name}」，请刷新`);
        if (row.problem || row.itemId === null) throw conflict('LEISURE_NOT_READY', `「${t.name}」：${row.problem ?? '没对接收银项目'}`);
        if (!next.businessTypes.includes(row.name)) {
          if (next.businessTypes.length >= 20) throw conflict('USAGE_TYPES_FULL', '开单即占用的业态最多 20 个，请先到后台去掉不用的');
          next.businessTypes.push(row.name);
        }
        if (!next.leisureTypes!.includes(row.name)) next.leisureTypes!.push(row.name);
        next.pricing[row.name] = { feeItemId: row.itemId, minMinutes: row.minMinutes, stepMinutes: row.stepMinutes, openFeeItemId: null, extraPrice: row.extraPrice };
        result.types.push(row.name);
        for (let n = 1; n <= row.units; n++) {
          const code = leisureCode(t.prefix, n);
          if (!SPACE_CODE_RE.test(code)) {
            result.skipped.push({ code, reason: '编码超过 8 位' });
            continue;
          }
          const [dup] = await tx<{ businessType: string }[]>`SELECT business_type FROM spaces WHERE code = ${code} AND store_id = ${currentStoreId()}`;
          if (dup) {
            if (dup.businessType !== row.name) result.skipped.push({ code, reason: `编码已是「${dup.businessType}」的` });
            continue;
          }
          await tx`
            INSERT INTO spaces (code, floor_id, business_type, capacity, display_name, sellable, verify_status, verified_by, verified_at, note, created_by)
            VALUES (${code}, ${input.floorId}, ${row.name}, 1, ${`${row.name} ${n} 号`}, true, 'confirmed', ${ctx.actor.id}, now(), '按价目表一键建（8.2.20）', ${ctx.actor.id})`;
          result.created.push(code);
        }
      }
      await writeAudit(tx, {
        staffId: ctx.actor.id,
        action: 'leisure_setup',
        targetType: 'settings',
        detail: { floor: floor.code, types: result.types, created: result.created, skipped: result.skipped },
        ip: ctx.ip,
      });
      return next;
    },
    ctx,
  );
  return result;
}

export function registerLeisureRoutes(app: FastifyInstance, deps: Deps) {
  app.get('/api/admin/leisure/plan', { preHandler: guard('settings.manage') }, async () => leisurePlan(deps.sql));
  app.post('/api/admin/leisure/setup', { preHandler: guard('settings.manage') }, async (req) => setupLeisure(deps, req.body, ctxOf(req)));
}
