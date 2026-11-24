// 价目表第四批：对接收银项目（docs/PRICE_CATALOG.md 第 6 节，PC17、PC18；迁移 237）。
// 价目表的一项（priceNameKey：同一张表、同一个板块 / 餐段、同一个分类里的名称）对上一个收银项目（service_items）。
// 前台开单、房态点单、房态中心登记、点单页都照旧从收银项目取价（pricing.ts），所以对上以后只要把价格写到收银项目上，
// 三处取的就是同一份：切换生效、整体回滚、改生效中的价目、对接时，在同一个事务里同步（syncLinkedPrices）。
// 已开的单照旧留着开单时的名称与单价（bill_lines 的快照），同步不碰。
//
// 价格怎么写（PC17）：
//   · 单价：这个收银项目现有的每一档都写成这个价；
//   · 双价：专业价 → 「专业」档（还有「标准」档的也写专业价），资深价 → 「优选」档（PC7）；
//   · 待定价、停用、比例（服务费）的不写，列出来；
//   · 本店（编号 1）写全公司的价目；第二家店写本店价（service_item_store_prices；与全公司一样也写，全公司的价以后再改也不跟着变），全公司没有的档不加。
// 菜品（挂了出品档口的收银项目）改到的每一档记进菜品改价记录（来源「全品类价目表」，第二家店记「本店价」）。
//
// 加锁（docs/LOCKING.md「价目表录入」）：价目表那几行（切换、回滚、对接：门店级咨询锁 → 全部价目表行；改条目：那份价目表一行 → 那一项）
// → 对接的收银项目（id 升序 FOR NO KEY UPDATE：与后台价目、菜品维护、本店价锁这一行互相排队，但不挡开单写明细时对它的外键检查）
// → 价格行。后台价目、菜品改价、本店价先锁收银项目那一行再查对接，与这里排队。

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { defaultTier, sortTiers, tierPrice, type PriceTier, type TierPrice } from '@shared/catalog';
import { priceNameKey, type PriceCatalogEntry } from '@shared/price-catalog';
import type { Db, Tx } from '../../db';
import { guard } from '../../auth/guard';
import { writeAudit } from '../../lib/audit';
import { ctxOf, type Deps, type OpContext } from '../../lib/context';
import { conflict, notFound, unprocessable } from '../../lib/errors';
import { assertNotFenced, lockOpKey } from '../../lib/fences';
import { currentStoreId, DEFAULT_STORE_ID } from '../../lib/store-context';
import { parse } from '../../lib/validate';
import { dishIdsAmong, recordPriceChanges, recordStorePriceChange } from '../dish-prices';
import { erpOpAbandoned } from '../erp-ops';
import { materializeCatalog } from './materialize';
import { entriesOf } from './read';

/**
 * 这家门店价目表的整份操作（导入草稿、切换生效、回滚、放弃草稿）先取门店级的咨询锁：不会随草稿被删掉而失效，
 * 两次导入、导入与切换都在这里排队（只锁草稿行的话，后一次在前一次删掉旧草稿以后查不到新草稿，撞唯一索引）。
 */
export async function lockStoreCatalog(tx: Tx): Promise<void> {
  await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`price_catalog:${currentStoreId()}`}, 0))`;
}

/** 一次同步里一个对接的结果 */
export interface PriceSyncResult {
  entryKey: string;
  itemId: number;
  itemName: string;
  /** 价格有没有改（与收银项目原来的一样就是 false） */
  changed: boolean;
  /** 没同步的原因（待定价、停用、价目表里没有这一项……） */
  skipped?: string;
}

export interface PriceLink {
  entryKey: string;
  itemId: number;
  itemName: string;
  itemActive: boolean;
  /** 收银项目现在的各档价（第二家店是本店价） */
  prices: TierPrice[];
}

/** 按价目表的一项算这个收银项目各档该是多少（PC17）；不能同步的返回原因 */
export function targetTiers(e: PriceCatalogEntry | undefined, current: readonly TierPrice[], opts: { canAdd: boolean }): TierPrice[] | string {
  if (!e) return '生效中的价目表里没有这一项';
  if (!e.active) return '价目表里这一项已停用';
  if (e.priceMode === 'rate') return '比例（服务费）不写到收银项目上';
  if (e.priceMode === 'none' || e.priceCents === null) return '待定价';
  const has = new Set(current.map((t) => t.tier));
  const out = new Map<PriceTier, number>();
  if (e.priceMode === 'dual' && e.price2Cents !== null) {
    // 本店：双价一律是「专业 / 优选」两档（与价目表新建的一样，房态中心登记才出「专业价 / 资深价」二选一），原有的「标准」档去掉；
    // 第二家店只写本店价、不增删档，有「标准」档的也写专业价
    if (has.has('standard') && !opts.canAdd) out.set('standard', e.priceCents);
    if (has.has('professional') || opts.canAdd) out.set('professional', e.priceCents);
    if (has.has('premium') || opts.canAdd) out.set('premium', e.price2Cents);
  } else {
    for (const t of current) out.set(t.tier, e.priceCents);
    if (out.size === 0) out.set('standard', e.priceCents);
  }
  if (out.size === 0) return '收银项目没有专业 / 优选档';
  return sortTiers([...out].map(([tier, price]) => ({ tier, price })));
}

const same = (a: readonly TierPrice[], b: readonly TierPrice[]) =>
  a.length === b.length && sortTiers([...a]).every((t, i) => t.tier === sortTiers([...b])[i]!.tier && t.price === sortTiers([...b])[i]!.price);

/** 收银项目现在的各档价：全公司（base）与这家门店实际用的（第二家店有本店价的用本店价） */
async function itemPrices(db: Db | Tx, ids: number[]): Promise<Map<number, { name: string; active: boolean; base: TierPrice[]; store: TierPrice[] }>> {
  if (ids.length === 0) return new Map();
  const storeId = currentStoreId();
  const rows = await db<{ id: number; name: string; active: boolean; base: TierPrice[]; store: TierPrice[] }[]>`
    SELECT i.id, i.name, i.active,
      coalesce((SELECT json_agg(json_build_object('tier', p.tier, 'price', p.price)) FROM service_item_prices p WHERE p.item_id = i.id), '[]'::json) AS base,
      coalesce((SELECT json_agg(json_build_object('tier', p.tier, 'price', coalesce(sp.price, p.price)))
                FROM service_item_prices p
                LEFT JOIN service_item_store_prices sp ON sp.item_id = p.item_id AND sp.tier = p.tier AND sp.store_id = ${storeId}
                WHERE p.item_id = i.id), '[]'::json) AS store
    FROM service_items i WHERE i.id IN ${db(ids)}`;
  return new Map(rows.map((r) => [Number(r.id), { name: r.name, active: r.active, base: sortTiers(r.base), store: sortTiers(r.store) }]));
}

/**
 * 把生效中的价目表写到对接的收银项目上（调用方的事务里，价目表那几行已经锁住）。keys 不给 = 这家门店全部对接；
 * 没有生效的价目表时什么都不做。返回每个对接的结果；改了的记审计一条。
 */
export async function syncLinkedPrices(tx: Tx, ctx: OpContext, opts: { keys?: string[]; why: string }): Promise<PriceSyncResult[]> {
  const storeId = currentStoreId();
  const [active] = await tx<{ id: number }[]>`SELECT id FROM price_catalog_sets WHERE store_id = ${storeId} AND status = 'active'`;
  if (!active) return [];
  const entries = await entriesOf(tx, Number(active.id));
  // 重做第一批：先落库（没对接的新建收银项目并对上、补分类），再按对接写价
  const made = await materializeCatalog(tx, entries, { keys: opts.keys, staffId: ctx.actor.id });
  // 原有的同名收银项目补齐了设置（PC28）：记一条审计，写明哪几个、改了什么
  if (made.fitted.length) {
    await writeAudit(tx, {
      staffId: ctx.actor.id,
      action: 'price_catalog',
      targetType: 'price_catalog_set',
      targetId: String(active.id),
      detail: {
        action: 'fit_items',
        label: `${opts.why}：${made.fitted.length} 个原有的收银项目补齐了设置（需要技师、时长、出品档口）`,
        items: made.fitted,
      },
      ip: ctx.ip,
    });
  }
  const links = await tx<{ entryKey: string; itemId: number }[]>`
    SELECT entry_key, item_id FROM price_catalog_links WHERE store_id = ${storeId} ${opts.keys ? tx`AND entry_key IN ${tx(opts.keys.length ? opts.keys : [''])}` : tx``}
    ORDER BY item_id`;
  if (links.length === 0) return [];
  // 同名的在用项优先（与对比、查重同一个键）
  const byKey = new Map<string, PriceCatalogEntry>();
  for (const e of entries) {
    const k = priceNameKey(e);
    const had = byKey.get(k);
    if (!had || (!had.active && e.active)) byKey.set(k, e);
  }
  const ids = links.map((l) => Number(l.itemId));
  await tx`SELECT id FROM service_items WHERE id IN ${tx(ids)} ORDER BY id FOR NO KEY UPDATE`;
  const items = await itemPrices(tx, ids);
  const dishes = await dishIdsAmong(tx, ids);
  const out: PriceSyncResult[] = [];
  for (const l of links) {
    const itemId = Number(l.itemId);
    const item = items.get(itemId)!;
    const base = storeId === DEFAULT_STORE_ID;
    const current = base ? item.base : item.store;
    const target = targetTiers(byKey.get(l.entryKey), current, { canAdd: base });
    if (typeof target === 'string') {
      out.push({ entryKey: l.entryKey, itemId, itemName: item.name, changed: false, skipped: target });
      continue;
    }
    if (base && same(current, target)) {
      out.push({ entryKey: l.entryKey, itemId, itemName: item.name, changed: false });
      continue;
    }
    if (base) {
      await tx`DELETE FROM service_item_prices WHERE item_id = ${itemId} AND NOT (tier = ANY(${target.map((t) => t.tier)}::text[]))`;
      for (const t of target) {
        await tx`
          INSERT INTO service_item_prices (item_id, tier, price) VALUES (${itemId}, ${t.tier}, ${t.price})
          ON CONFLICT (item_id, tier) DO UPDATE SET price = EXCLUDED.price`;
      }
      await tx`UPDATE service_items SET price = ${tierPrice(target, defaultTier(target)!)!}, updated_at = clock_timestamp() WHERE id = ${itemId}`;
      if (dishes.has(itemId)) {
        await recordPriceChanges(tx, { itemId, itemName: item.name, before: current, after: target, reason: opts.why, source: 'price_catalog', staffId: ctx.actor.id });
      }
    } else {
      for (const t of target) {
        const basePrice = tierPrice(item.base, t.tier)!;
        const [cur] = await tx<{ price: number }[]>`
          SELECT price FROM service_item_store_prices WHERE store_id = ${storeId} AND item_id = ${itemId} AND tier = ${t.tier} FOR UPDATE`;
        const before = cur ? Number(cur.price) : null;
        // 一律写本店价（与全公司一样也写）：全公司的价以后再改，这家店照旧是价目表的价
        const after = t.price;
        if (before === after) continue;
        await tx`
            INSERT INTO service_item_store_prices (store_id, item_id, tier, price, updated_by) VALUES (${storeId}, ${itemId}, ${t.tier}, ${after}, ${ctx.actor.id})
            ON CONFLICT (store_id, item_id, tier) DO UPDATE SET price = EXCLUDED.price, updated_by = EXCLUDED.updated_by, updated_at = now()`;
        await recordStorePriceChange(tx, { storeId, itemId, itemName: item.name, tier: t.tier, oldPrice: before, newPrice: after, basePrice, reason: opts.why, staffId: ctx.actor.id });
      }
      // 只是把与全公司一样的价写成本店价（实际售价没变）不算改价
      if (same(current, target)) {
        out.push({ entryKey: l.entryKey, itemId, itemName: item.name, changed: false });
        continue;
      }
    }
    out.push({ entryKey: l.entryKey, itemId, itemName: item.name, changed: true });
  }
  const changed = out.filter((r) => r.changed);
  if (changed.length) {
    await writeAudit(tx, {
      staffId: ctx.actor.id,
      action: 'price_catalog',
      targetType: 'price_catalog_set',
      targetId: String(active.id),
      detail: { action: 'sync', label: `${opts.why}：同步 ${changed.length} 个收银项目的价格`, items: changed.map((r) => ({ itemId: r.itemId, name: r.itemName })) },
      ip: ctx.ip,
    });
  }
  return out;
}

export async function priceLinks(db: Db | Tx): Promise<PriceLink[]> {
  const rows = await db<{ entryKey: string; itemId: number }[]>`SELECT entry_key, item_id FROM price_catalog_links WHERE store_id = ${currentStoreId()} ORDER BY entry_key`;
  const items = await itemPrices(
    db,
    rows.map((r) => Number(r.itemId)),
  );
  return rows.map((r) => {
    const it = items.get(Number(r.itemId))!;
    return { entryKey: r.entryKey, itemId: Number(r.itemId), itemName: it.name, itemActive: it.active, prices: it.store };
  });
}

/** 取消对接：门店原有的收银项目不再归到价目表的分类（价目表新建的照旧留着，以后重新对上它） */
async function clearCatalogCategory(tx: Tx, itemId: number) {
  await tx`
    UPDATE service_items SET catalog_key = NULL, catalog_category_code = NULL, catalog_category_name = NULL, catalog_group = NULL, catalog_sort = NULL, catalog_code = NULL, updated_at = clock_timestamp()
    WHERE id = ${itemId} AND NOT catalog_managed`;
}

// ───────────────────────── 对接、取消对接、按名称自动对接 ─────────────────────────

const OpKey = z.uuid('缺少操作编号');
const LinkInput = z.object({ opKey: OpKey, entryKey: z.string().min(3).max(400), itemId: z.number().int().positive().nullable() });
const AutoInput = z.object({ opKey: OpKey });

export interface PriceLinkResult {
  /** 这次对上了几个（自动对接）/ 对接或取消的那一个 */
  linked: number;
  unlinked: number;
  synced: PriceSyncResult[];
}

/** 名称比对：不分大小写、不管空格 */
const nameKey = (s: string) => s.replace(/\s+/g, '').toLowerCase();

/** 操作编号 → 门店级咨询锁 → 这家门店全部价目表行（与切换、回滚排队；改条目先锁的也是价目表那一行） */
async function linkOp(deps: Deps, ctx: OpContext, opKey: string, action: 'link' | 'unlink' | 'auto', body: (tx: Tx, activeSetId: number) => Promise<PriceLinkResult>): Promise<PriceLinkResult> {
  return deps.sql.begin(async (tx) => {
    await lockOpKey(tx, opKey);
    const [done] = await tx<{ storeId: number; result: PriceLinkResult }[]>`SELECT store_id, result FROM price_catalog_link_ops WHERE op_key = ${opKey}`;
    if (done) {
      if (Number(done.storeId) !== currentStoreId()) throw conflict('PRICE_OP_REUSED', '这个操作编号已经用过了，请刷新页面后再操作');
      return done.result;
    }
    await assertNotFenced(tx, opKey, 'price_link', erpOpAbandoned);
    await lockStoreCatalog(tx);
    const sets = await tx<{ id: number; status: string }[]>`SELECT id, status FROM price_catalog_sets WHERE store_id = ${currentStoreId()} ORDER BY id FOR UPDATE`;
    const active = sets.find((s) => s.status === 'active');
    if (!active) throw unprocessable('PRICE_NO_ACTIVE', '还没有生效的价目表：先切换生效，再对接收银项目');
    const result = await body(tx, Number(active.id));
    await tx`INSERT INTO price_catalog_link_ops (op_key, action, result, staff_id) VALUES (${opKey}, ${action}, ${tx.json(result as never)}, ${ctx.actor.id})`;
    return result;
  });
}

export async function setPriceLink(deps: Deps, raw: unknown, ctx: OpContext): Promise<PriceLinkResult> {
  const f = parse(LinkInput, raw);
  return linkOp(deps, ctx, f.opKey, f.itemId === null ? 'unlink' : 'link', async (tx, activeSetId) => {
    const storeId = currentStoreId();
    const entry = (await entriesOf(tx, activeSetId)).find((e) => priceNameKey(e) === f.entryKey);
    const [had] = await tx<{ itemId: number }[]>`SELECT item_id FROM price_catalog_links WHERE store_id = ${storeId} AND entry_key = ${f.entryKey}`;
    if (f.itemId === null) {
      if (!had) return { linked: 0, unlinked: 0, synced: [] };
      await tx`DELETE FROM price_catalog_links WHERE store_id = ${storeId} AND entry_key = ${f.entryKey}`;
      await clearCatalogCategory(tx, Number(had.itemId));
      await writeAudit(tx, {
        staffId: ctx.actor.id,
        action: 'price_catalog',
        targetType: 'item',
        targetId: String(had.itemId),
        detail: { action: 'unlink', label: `取消对接「${entry?.name ?? f.entryKey}」`, entryKey: f.entryKey },
        ip: ctx.ip,
      });
      return { linked: 0, unlinked: 1, synced: [] };
    }
    if (!entry) throw notFound('生效中的价目表里没有这一项，刷新后再看');
    if (entry.priceMode === 'rate') throw unprocessable('PRICE_LINK_INVALID', '服务费是比例，不对接收银项目');
    const [item] = await tx<{ name: string }[]>`SELECT name FROM service_items WHERE id = ${f.itemId} FOR NO KEY UPDATE`;
    if (!item) throw notFound('没有这个收银项目');
    const [taken] = await tx<{ entryKey: string }[]>`SELECT entry_key FROM price_catalog_links WHERE store_id = ${storeId} AND item_id = ${f.itemId} AND entry_key <> ${f.entryKey}`;
    if (taken) throw conflict('PRICE_LINK_TAKEN', `「${item.name}」已经对接了价目表里的另一项，先取消那一项的对接`);
    if (had && Number(had.itemId) === f.itemId) return { linked: 0, unlinked: 0, synced: await syncLinkedPrices(tx, ctx, { keys: [f.entryKey], why: '对接收银项目' }) };
    if (had) await tx`DELETE FROM price_catalog_links WHERE store_id = ${storeId} AND entry_key = ${f.entryKey}`;
    if (had) await clearCatalogCategory(tx, Number(had.itemId));
    await tx`INSERT INTO price_catalog_links (entry_key, item_id, created_by) VALUES (${f.entryKey}, ${f.itemId}, ${ctx.actor.id})`;
    await writeAudit(tx, {
      staffId: ctx.actor.id,
      action: 'price_catalog',
      targetType: 'item',
      targetId: String(f.itemId),
      detail: { action: 'link', label: `「${entry.name}」对接收银项目「${item.name}」`, entryKey: f.entryKey, replaced: had ? Number(had.itemId) : null },
      ip: ctx.ip,
    });
    return { linked: 1, unlinked: had ? 1 : 0, synced: await syncLinkedPrices(tx, ctx, { keys: [f.entryKey], why: '对接收银项目' }) };
  });
}

/**
 * 按名称自动对接（PC18）：生效中的价目表里还没对接、不是服务费的在用项，名称（不分大小写、不管空格）恰好等于一个
 * 在用、还没对接的收银项目的，对上；同名的收银项目不止一个、或价目表里同名的不止一项的不对，留给人工选。
 */
export async function autoPriceLinks(deps: Deps, raw: unknown, ctx: OpContext): Promise<PriceLinkResult> {
  const f = parse(AutoInput, raw);
  return linkOp(deps, ctx, f.opKey, 'auto', async (tx, activeSetId) => {
    const storeId = currentStoreId();
    const linked = await tx<{ entryKey: string; itemId: number }[]>`SELECT entry_key, item_id FROM price_catalog_links WHERE store_id = ${storeId}`;
    const usedKeys = new Set(linked.map((l) => l.entryKey));
    const usedItems = new Set(linked.map((l) => Number(l.itemId)));
    const items = await tx<{ id: number; name: string }[]>`SELECT id, name FROM service_items WHERE active ORDER BY id FOR NO KEY UPDATE`;
    const itemsByName = new Map<string, number[]>();
    for (const it of items) itemsByName.set(nameKey(it.name), [...(itemsByName.get(nameKey(it.name)) ?? []), Number(it.id)]);
    const entries = (await entriesOf(tx, activeSetId)).filter((e) => e.active && e.priceMode !== 'rate');
    const entriesByName = new Map<string, number>();
    for (const e of entries) entriesByName.set(nameKey(e.name), (entriesByName.get(nameKey(e.name)) ?? 0) + 1);
    const keys: string[] = [];
    for (const e of entries) {
      const key = priceNameKey(e);
      const n = nameKey(e.name);
      const match = itemsByName.get(n);
      if (usedKeys.has(key) || entriesByName.get(n) !== 1 || !match || match.length !== 1 || usedItems.has(match[0]!)) continue;
      await tx`INSERT INTO price_catalog_links (entry_key, item_id, created_by) VALUES (${key}, ${match[0]!}, ${ctx.actor.id})`;
      usedItems.add(match[0]!);
      keys.push(key);
    }
    if (keys.length) {
      await writeAudit(tx, {
        staffId: ctx.actor.id,
        action: 'price_catalog',
        targetType: 'price_catalog_set',
        targetId: String(activeSetId),
        detail: { action: 'auto_link', label: `按名称自动对接 ${keys.length} 个收银项目` },
        ip: ctx.ip,
      });
    }
    return { linked: keys.length, unlinked: 0, synced: keys.length ? await syncLinkedPrices(tx, ctx, { keys, why: '按名称自动对接' }) : [] };
  });
}

export function registerPriceLinkRoutes(app: FastifyInstance, deps: Deps) {
  const manage = guard('catalog.manage');
  app.get('/api/admin/price-catalog/links', { preHandler: manage }, async () => priceLinks(deps.sql));
  app.post('/api/admin/price-catalog/links', { preHandler: manage }, async (req) => setPriceLink(deps, req.body, ctxOf(req)));
  app.post('/api/admin/price-catalog/links/auto', { preHandler: manage }, async (req) => autoPriceLinks(deps, req.body, ctxOf(req)));
}
