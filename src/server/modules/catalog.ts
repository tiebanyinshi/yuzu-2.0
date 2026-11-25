// 充值套餐与消费项目。停用而不删除，保证历史单据可追溯。
//
// 消费项目（Batch 2.3，店主 2026-10-27 #8）：同一项目可设「标准 / 专业 / 优选」多档价格（service_item_prices），
// 另有时长、仅限某一性别、力道、精油、热疗、「超人气」等属性，属性不影响计价。
// service_items.price 始终等于默认档（标准 → 专业 → 优选中第一个提供的）的价格，保存项目时一并维护。

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { defaultTier, isCareItem, PRICE_TIERS, sortTiers, STRENGTHS, tierPrice, type PriceTier, type TierPrice } from '@shared/catalog';
import type { Catalog, RechargePlan, ServiceItem } from '@shared/types';
import type { Db, Tx } from '../db';
import { guard } from '../auth/guard';
import { writeAudit } from '../lib/audit';
import type { Deps } from '../lib/context';
import { badRequest, conflict, notFound } from '../lib/errors';
import { cents, idParam, parse, positiveCents } from '../lib/validate';
import { pricesColumn } from './pricing';
import { currentStoreId, DEFAULT_STORE_ID } from '../lib/store-context';
import { dishPriceState, recordPriceChanges, recordStorePriceChange } from './dish-prices';
import { assertNotPriceLinked } from './price-catalog/linked';
import { MAX_STORE_PRICE_REASON } from '@shared/frontdesk-v8117';
import { formatYuan } from '@shared/money';

const PlanInput = z.object({
  name: z.string().trim().min(1, '请填写套餐名称').max(32, '名称最多 32 个字'),
  payAmount: positiveCents('实收金额'),
  bonusAmount: cents('赠金'),
  /** 赠金有效期（天，店主 #2）；null 为长期有效；编辑时不带则保持原值 */
  bonusValidDays: z.number().int('赠金有效期按整天填写').min(1, '赠金有效期至少 1 天').max(3650, '赠金有效期最多 3650 天').nullable().optional(),
  note: z.string().trim().max(100).default(''),
  active: z.boolean().default(true),
  sortOrder: z.number().int().default(0),
});

const tierPriceInput = positiveCents('价格').nullable().optional();
const genderInput = z.enum(['male', 'female'], '性别限定应为男宾或女宾').nullable();
const durationInput = z.number().int().min(1, '时长至少 1 分钟').max(1440, '时长最多 1440 分钟').nullable();

const ItemInput = z
  .object({
    name: z.string().trim().min(1, '请填写项目名称').max(32, '名称最多 32 个字'),
    category: z.string().trim().max(16, '分类最多 16 个字').default(''),
    /** 只有一个价格的写法：记为「标准」档 */
    price: positiveCents('价格').optional(),
    /** 各档价格；某一档不提供时为 null 或不填 */
    prices: z.object({ standard: tierPriceInput, professional: tierPriceInput, premium: tierPriceInput }).optional(),
    durationMinutes: durationInput.default(null),
    gender: genderInput.default(null),
    strength: z.enum(STRENGTHS, '力道应为轻柔、适中或强劲').nullable().default(null),
    essentialOil: z.boolean().default(false),
    heatTherapy: z.boolean().default(false),
    popular: z.boolean().default(false),
    /** 需要技师（v0.7.0）；不带时新建为否、编辑时保持原值（旧页面不带这一项） */
    technicianRequired: z.boolean().optional(),
    note: z.string().trim().max(100, '说明最多 100 字').default(''),
    active: z.boolean().default(true),
    sortOrder: z.number().int().default(0),
  })
  .transform(({ price, prices, ...rest }) => ({
    ...rest,
    tiers: prices ? PRICE_TIERS.flatMap((tier) => (prices[tier] ? [{ tier, price: prices[tier]! }] : [])) : price !== undefined ? [{ tier: 'standard' as const, price }] : [],
  }))
  .refine((v) => v.tiers.length > 0, '请至少填写一档价格');
type ItemData = z.output<typeof ItemInput>;

const ITEM_COLUMNS = (db: Db, base = false) => db`
  i.id, i.name, i.category, i.price, i.duration_minutes, i.gender, i.strength, i.essential_oil, i.heat_therapy, i.popular,
  i.technician_required, i.note, i.active, i.sort_order, i.catalog_code, i.catalog_managed,
  EXISTS (SELECT 1 FROM price_catalog_links l WHERE l.item_id = i.id AND l.store_id = ${DEFAULT_STORE_ID}) AS catalog_linked, ${pricesColumn(db, { base })} AS prices,
  CASE WHEN i.catalog_category_code IS NULL THEN NULL
       ELSE json_build_object('code', i.catalog_category_code, 'name', i.catalog_category_name, 'group', coalesce(i.catalog_group, ''), 'sort', coalesce(i.catalog_sort, 0)) END AS catalog_category`;

/** base：全公司的价目（后台维护价目表用）；不给时第二家店按本店价（前台挂账、点单用，8.0.22） */
export async function loadItems(db: Db, includeInactive = false, base = false): Promise<ServiceItem[]> {
  const rows = await db<ServiceItem[]>`
    SELECT ${ITEM_COLUMNS(db, base)} FROM service_items i
    ${includeInactive ? db`` : db`WHERE i.active`} ORDER BY i.active DESC, i.sort_order, i.id`;
  return rows.map((r) => ({ ...r, prices: sortTiers(r.prices) }));
}

export async function loadCatalog(db: Db, includeInactive = false, base = includeInactive): Promise<Catalog> {
  const plans = await db<RechargePlan[]>`
    SELECT id, name, pay_amount, bonus_amount, bonus_valid_days, note, active, sort_order FROM recharge_plans
    ${includeInactive ? db`` : db`WHERE active`} ORDER BY active DESC, sort_order, pay_amount, id`;
  return { plans, items: await loadItems(db, includeInactive, base) };
}

/** 写入项目与各档价格（调用方开事务）；默认档价格同步写入 service_items.price */
async function writeItem(tx: Tx, id: number | null, i: Omit<ItemData, 'tiers'> & { tiers: TierPrice[] }): Promise<number> {
  const price = tierPrice(i.tiers, defaultTier(i.tiers)!)!;
  let itemId = id;
  if (itemId === null) {
    const [row] = await tx<{ id: number }[]>`
      INSERT INTO service_items (name, category, price, duration_minutes, gender, strength, essential_oil, heat_therapy, popular,
                                 technician_required, note, active, sort_order)
      VALUES (${i.name}, ${i.category}, ${price}, ${i.durationMinutes}, ${i.gender}, ${i.strength}, ${i.essentialOil},
              ${i.heatTherapy}, ${i.popular}, ${i.technicianRequired ?? isCareItem(i.category, i.name)}, ${i.note}, ${i.active}, ${i.sortOrder})
      RETURNING id`;
    itemId = row!.id;
  } else {
    const rows = await tx`
      UPDATE service_items SET name = ${i.name}, category = ${i.category}, price = ${price}, duration_minutes = ${i.durationMinutes},
             gender = ${i.gender}, strength = ${i.strength}, essential_oil = ${i.essentialOil}, heat_therapy = ${i.heatTherapy},
             popular = ${i.popular}, ${i.technicianRequired === undefined ? tx`` : tx`technician_required = ${i.technicianRequired},`}
             note = ${i.note}, active = ${i.active}, sort_order = ${i.sortOrder}, updated_at = now()
      WHERE id = ${itemId} RETURNING id`;
    if (rows.length === 0) throw notFound('项目不存在');
    await tx`DELETE FROM service_item_prices WHERE item_id = ${itemId}`;
  }
  await tx`
    INSERT INTO service_item_prices (item_id, tier, price)
    SELECT ${itemId}, unnest(${i.tiers.map((t) => t.tier)}::text[]), unnest(${i.tiers.map((t) => t.price)}::bigint[])`;
  return itemId;
}

const samePrices = (a: TierPrice[], b: TierPrice[]) => a.length === b.length && sortTiers(a).every((p, k) => p.tier === sortTiers(b)[k]!.tier && p.price === sortTiers(b)[k]!.price);

export function registerCatalogRoutes(app: FastifyInstance, { sql }: Deps) {
  app.get('/api/catalog', { preHandler: guard('member.read') }, async (req) => {
    const all = (req.query as { all?: string }).all === '1';
    return loadCatalog(sql, all);
  });

  app.post('/api/plans', { preHandler: guard('catalog.manage') }, async (req) => {
    const p = parse(PlanInput, req.body);
    const [row] = await sql<{ id: number }[]>`
      INSERT INTO recharge_plans (name, pay_amount, bonus_amount, bonus_valid_days, note, active, sort_order)
      VALUES (${p.name}, ${p.payAmount}, ${p.bonusAmount}, ${p.bonusValidDays ?? null}, ${p.note}, ${p.active}, ${p.sortOrder}) RETURNING id`;
    await writeAudit(sql, { staffId: req.actor.id, action: 'plan_saved', targetType: 'plan', targetId: row!.id, detail: p, ip: req.ip });
    return loadCatalog(sql, true);
  });

  app.put('/api/plans/:id', { preHandler: guard('catalog.manage') }, async (req) => {
    const { id } = parse(idParam, req.params);
    const p = parse(PlanInput, req.body);
    const rows = await sql`
      UPDATE recharge_plans SET name = ${p.name}, pay_amount = ${p.payAmount}, bonus_amount = ${p.bonusAmount},
             ${p.bonusValidDays === undefined ? sql`` : sql`bonus_valid_days = ${p.bonusValidDays},`}
             note = ${p.note}, active = ${p.active}, sort_order = ${p.sortOrder}, updated_at = now()
      WHERE id = ${id} RETURNING id`;
    if (rows.length === 0) throw notFound('套餐不存在');
    await writeAudit(sql, { staffId: req.actor.id, action: 'plan_saved', targetType: 'plan', targetId: id, detail: p, ip: req.ip });
    return loadCatalog(sql, true);
  });

  app.post('/api/items', { preHandler: guard('catalog.manage') }, async (req) => {
    const i = parse(ItemInput, req.body);
    await sql.begin(async (tx) => {
      const id = await writeItem(tx, null, i);
      await writeAudit(tx, { staffId: req.actor.id, action: 'item_saved', targetType: 'item', targetId: id, detail: i, ip: req.ip });
    });
    return loadCatalog(sql, true);
  });

  app.put('/api/items/:id', { preHandler: guard('catalog.manage') }, async (req) => {
    const { id } = parse(idParam, req.params);
    const i = parse(ItemInput, req.body);
    await sql.begin(async (tx) => {
      await tx`SELECT id FROM service_items WHERE id = ${id} FOR UPDATE`;
      // 价目表第四批：对接了「全品类价目表」的项目改价拒绝（别的字段照常能改）
      const [cur] = await tx<{ prices: TierPrice[]; name: string; category: string; durationMinutes: number | null; gender: string | null }[]>`
        SELECT ${pricesColumn(tx, { base: true })} AS prices, i.name, i.category, i.duration_minutes, i.gender FROM service_items i WHERE i.id = ${id}`;
      if (cur && !samePrices(cur.prices, i.tiers)) await assertNotPriceLinked(tx, [id]);
      // 8.1.34：对接了的项目，名称、分类、时长、性别限定也以价目表为准（力道、精油、说明、排序、停用照常能改）
      if (cur && (cur.name !== i.name || cur.category !== i.category || cur.durationMinutes !== i.durationMinutes || cur.gender !== i.gender)) {
        await assertNotPriceLinked(tx, [id], { what: '名称、分类、时长与性别限定', managedOnly: true });
      }
      // 菜品的改价进改价记录（8.1.15 菜品管理）：这道是菜品、价格有变化的，每一档记一条
      const before = await dishPriceState(tx, id);
      await writeItem(tx, id, i);
      if (before) await recordPriceChanges(tx, { itemId: id, itemName: before.name, before: before.prices, after: i.tiers, reason: '在后台价目里修改', source: 'catalog', staffId: req.actor.id });
      await writeAudit(tx, { staffId: req.actor.id, action: 'item_saved', targetType: 'item', targetId: id, detail: i, ip: req.ip });
    });
    return loadCatalog(sql, true);
  });

  // 本店价（8.0.22，价目按店覆盖）：第二家店里打开时，每个项目每一档的全公司价与本店价；本店不用
  app.get('/api/admin/catalog/store-prices', { preHandler: guard('catalog.manage') }, async () => {
    const storeId = currentStoreId();
    if (storeId === DEFAULT_STORE_ID) throw badRequest('本店用全公司的价目表；本店价在第二家店里设');
    return sql<{ itemId: number; name: string; category: string; active: boolean; tier: PriceTier; price: number; storePrice: number | null }[]>`
      SELECT i.id AS item_id, i.name, i.category, i.active, p.tier, p.price, sp.price AS store_price
      FROM service_items i JOIN service_item_prices p ON p.item_id = i.id
      LEFT JOIN service_item_store_prices sp ON sp.item_id = i.id AND sp.tier = p.tier AND sp.store_id = ${storeId}
      ORDER BY i.active DESC, i.sort_order, i.id, p.tier`.then((rows) =>
      rows.map((r) => ({ ...r, itemId: Number(r.itemId), price: Number(r.price), storePrice: r.storePrice === null ? null : Number(r.storePrice) })),
    );
  });

  // 改本店价（8.1.17 BW-11，docs/FRONTDESK_V8117.md 第 6 节）：权限照旧，另要写原因（与菜品改价一样）；菜品的改价写进改价记录（门店、改前改后、谁、原因）。
  // 锁：这个价目项目一行（FOR NO KEY UPDATE，与菜品维护、后台价目同一批行）→ 本店价一行 → 改价记录，在锁里读改前的本店价与全公司价。
  // 改成的价与现在一样的什么都不做（照样回 ok：上一次的回复丢了再点一次不会多记一条）；带了打开时看到的价（expected）而别人刚改过的拒绝
  app.put('/api/admin/catalog/store-prices', { preHandler: guard('catalog.manage') }, async (req) => {
    const storeId = currentStoreId();
    if (storeId === DEFAULT_STORE_ID) throw badRequest('本店用全公司的价目表；本店价在第二家店里设');
    const input = parse(
      z.object({
        itemId: z.number().int().positive(),
        tier: z.enum(['standard', 'professional', 'premium']),
        // null：取消本店价，按全公司的
        price: z.number().int().positive().max(100_000_000).nullable(),
        // 打开时看到的本店价（null = 同全公司）；不带不核对
        expected: z.number().int().positive().nullable().optional(),
        reason: z.string('请填写改价的原因').trim().min(2, '请填写改价的原因（至少 2 个字）').max(MAX_STORE_PRICE_REASON, `原因最多 ${MAX_STORE_PRICE_REASON} 字`),
      }),
      req.body,
    );
    return sql.begin(async (tx) => {
      const [item] = await tx<{ name: string }[]>`SELECT name FROM service_items WHERE id = ${input.itemId} FOR NO KEY UPDATE`;
      const [p] = await tx<{ price: number }[]>`SELECT price FROM service_item_prices WHERE item_id = ${input.itemId} AND tier = ${input.tier}`;
      if (!item || !p) throw notFound('这个项目没有这一档价格');
      const [cur] = await tx<{ price: number }[]>`
        SELECT price FROM service_item_store_prices WHERE store_id = ${storeId} AND item_id = ${input.itemId} AND tier = ${input.tier} FOR UPDATE`;
      const before = cur ? Number(cur.price) : null;
      if (before === input.price) return { ok: true, changed: false };
      await assertNotPriceLinked(tx, [input.itemId], { storeId });
      if (input.expected !== undefined && input.expected !== before) {
        throw conflict('STORE_PRICE_STALE', `「${item.name}」的本店价刚刚被改过（现在是${before === null ? '同全公司' : ` ${formatYuan(before)}`}），请刷新后再改`);
      }
      if (input.price === null) await tx`DELETE FROM service_item_store_prices WHERE store_id = ${storeId} AND item_id = ${input.itemId} AND tier = ${input.tier}`;
      else
        await tx`
          INSERT INTO service_item_store_prices (store_id, item_id, tier, price, updated_by) VALUES (${storeId}, ${input.itemId}, ${input.tier}, ${input.price}, ${req.actor.id})
          ON CONFLICT (store_id, item_id, tier) DO UPDATE SET price = EXCLUDED.price, updated_by = EXCLUDED.updated_by, updated_at = now()`;
      const recorded = await recordStorePriceChange(tx, {
        storeId,
        itemId: input.itemId,
        itemName: item.name,
        tier: input.tier,
        oldPrice: before,
        newPrice: input.price,
        basePrice: Number(p.price),
        reason: input.reason,
        staffId: req.actor.id,
      });
      await writeAudit(tx, {
        staffId: req.actor.id,
        action: 'store_price_changed',
        targetType: 'item',
        targetId: input.itemId,
        detail: { name: item.name, tier: input.tier, before, after: input.price, basePrice: Number(p.price), reason: input.reason, dish: recorded },
        ip: req.ip,
      });
      return { ok: true, changed: true };
    });
  });
}
