// 价目表重做第一批：落库到收银项目（docs/PRICE_CATALOG.md 第 7 节，PC19–PC21；迁移 240）。
// 生效中的价目表每一项都对上一个收银项目，前台开单、房态中心登记、点单页取的就是这一份：
//   · 已对接的（第四批手动 / 按名称对上的）照旧用原来那个，只补上分类编码、分类名称、上一级、排序；
//   · 没对接的新建一个（catalog_managed）并对接上，价格随后由 syncLinkedPrices 写；
//   · 价目表新建的那些，名称、时长、是否要技师、适用性别、停用跟着价目表走；待定价、不可下单、已停用的停用（不能下单）。
// 不落库的：服务费（比例，结账时算）、房型 / 轰趴房 / 餐饮包房（房间按房态中心开房，不是卖给客人的项目，试算照旧按价目表算）。
// 只有本店（编号 1）新建收银项目（收银项目全公司一份）；第二家店只同步本店价（第四批）。
// 菜品要挂出品档口才能进点单页与厨房屏：新建的菜品挂第一个在用的档口（PC20），没有档口时不建，列出来。

import { priceCategoriesOf, priceNameKey, type PriceCatalogEntry, type PriceCategory } from '@shared/price-catalog';
import type { Tx } from '../../db';
import { currentStoreId, DEFAULT_STORE_ID } from '../../lib/store-context';

/** 不落库的类型 */
const NOT_ITEMS = new Set<PriceCatalogEntry['kind']>(['service_fee', 'room_type', 'party_room', 'dining_room']);

/** 收银项目上的类别（部门营业额、券、会员折扣按它算；PC21） */
export function itemCategoryOf(e: Pick<PriceCatalogEntry, 'sheet' | 'kind' | 'section'>): string {
  switch (e.sheet) {
    case 'store':
      return e.kind === 'meal_ticket' ? '餐饮' : '入场';
    case 'entertainment':
      return '娱乐';
    case 'dish':
      return '餐饮';
    case 'massage':
      return e.section || '康美';
    default:
      return '其他';
  }
}

/** 能不能卖：在用、可以下单、有价（待定价的不行） */
const sellable = (e: PriceCatalogEntry) => e.active && e.orderable && e.priceMode !== 'none' && e.priceCents !== null;

export interface MaterializeResult {
  created: number;
  /** 没建的：菜品没有出品档口…… */
  skipped: { key: string; name: string; reason: string }[];
}

/**
 * 在调用方的事务里（价目表那几行已经锁住）把生效中的价目表落到收银项目。keys 给了只处理这几项。
 * 返回新建了几个、哪些没建。
 */
export async function materializeCatalog(tx: Tx, entries: PriceCatalogEntry[], opts: { keys?: string[]; staffId: number }): Promise<MaterializeResult> {
  const storeId = currentStoreId();
  const out: MaterializeResult = { created: 0, skipped: [] };
  const { byEntry } = priceCategoriesOf(entries);
  // 同名的在用项优先（与对比、对接同一个键）
  const byKey = new Map<string, { e: PriceCatalogEntry; c: PriceCategory }>();
  entries.forEach((e, i) => {
    if (NOT_ITEMS.has(e.kind)) return;
    const k = priceNameKey(e);
    const had = byKey.get(k);
    if (!had || (!had.e.active && e.active)) byKey.set(k, { e, c: byEntry[i]! });
  });
  const wanted = opts.keys ? new Set(opts.keys) : null;
  const links = new Map((await tx<{ entryKey: string; itemId: number }[]>`SELECT entry_key, item_id FROM price_catalog_links WHERE store_id = ${storeId}`).map((l) => [l.entryKey, Number(l.itemId)]));
  // 已对接的收银项目按 id 升序先锁上（与 syncLinkedPrices、后台价目、菜品维护同一个顺序），再逐个改分类
  if (links.size) await tx`SELECT id FROM service_items WHERE id IN ${tx([...links.values()])} ORDER BY id FOR NO KEY UPDATE`;
  // 已有同名收银项目的（名称不管空格、大小写，恰好一个在用、还没对接、价目表里也只有一项叫这个名字）对上它，不另建（与按名称自动对接同一条规则）
  const usedItems = new Set(links.values());
  const nameKey = (s: string) => s.replace(/\s+/g, '').toLowerCase();
  const itemsByName = new Map<string, number[]>();
  for (const it of await tx<{ id: number; name: string }[]>`SELECT id, name FROM service_items WHERE active AND NOT catalog_managed ORDER BY id`) {
    itemsByName.set(nameKey(it.name), [...(itemsByName.get(nameKey(it.name)) ?? []), Number(it.id)]);
  }
  const entriesByName = new Map<string, number>();
  for (const { e } of byKey.values()) if (e.active) entriesByName.set(nameKey(e.name), (entriesByName.get(nameKey(e.name)) ?? 0) + 1);
  let station: number | null | undefined;
  for (const [key, { e, c }] of byKey) {
    if (wanted && !wanted.has(key)) continue;
    const itemId = links.get(key);
    if (itemId !== undefined) {
      // 已对接：补分类；价目表新建的还跟着改名称、时长、停用
      await tx`
        UPDATE service_items SET catalog_key = ${key}, catalog_category_code = ${c.code}, catalog_category_name = ${c.name}, catalog_group = ${c.group}, catalog_sort = ${c.sort},
          updated_at = clock_timestamp()
        WHERE id = ${itemId}`;
      await tx`
        UPDATE service_items SET name = ${e.name}, duration_minutes = ${minutesOf(e)}, gender = ${genderOf(e)}, technician_required = ${e.sheet === 'massage'},
          active = ${sellable(e)}, updated_at = clock_timestamp()
        WHERE id = ${itemId} AND catalog_managed AND dish_deleted_at IS NULL`;
      continue;
    }
    // 第二家店不新建（收银项目全公司一份）；待定价的先不建（收银项目必须有价），补价后再建
    if (storeId !== DEFAULT_STORE_ID || !sellable(e)) continue;
    // 以前建过、后来取消了对接的：重新对上，不再建一个
    const [had] = await tx<{ id: number }[]>`SELECT id FROM service_items WHERE catalog_key = ${key} AND catalog_managed FOR NO KEY UPDATE`;
    let id = had ? Number(had.id) : null;
    const same = itemsByName.get(nameKey(e.name));
    if (id === null && same?.length === 1 && !usedItems.has(same[0]!) && entriesByName.get(nameKey(e.name)) === 1) {
      id = same[0]!;
      await tx`
        UPDATE service_items SET catalog_key = ${key}, catalog_category_code = ${c.code}, catalog_category_name = ${c.name}, catalog_group = ${c.group}, catalog_sort = ${c.sort},
          updated_at = clock_timestamp()
        WHERE id = ${id}`;
    }
    if (id === null) {
      if (e.sheet === 'dish') {
        if (station === undefined) {
          const [s] = await tx<{ id: number }[]>`SELECT id FROM kitchen_stations WHERE active ORDER BY sort_order, id LIMIT 1`;
          station = s ? Number(s.id) : null;
        }
        if (station === null) {
          out.skipped.push({ key, name: e.name, reason: '还没有在用的出品档口，菜品建不了（先在后台建一个档口）' });
          continue;
        }
      }
      const dish = e.sheet === 'dish';
      const [row] = await tx<{ id: number }[]>`
        INSERT INTO service_items ${tx({
          name: e.name,
          category: itemCategoryOf(e),
          price: e.priceCents!,
          active: true,
          sort_order: c.sort,
          duration_minutes: minutesOf(e),
          gender: genderOf(e),
          technician_required: e.sheet === 'massage',
          station_id: dish ? station! : null,
          dining_outlet: dish ? 'restaurant' : null,
          dining_group: dish ? '餐饮' : '',
          catalog_key: key,
          catalog_managed: true,
          catalog_category_code: c.code,
          catalog_category_name: c.name,
          catalog_group: c.group,
          catalog_sort: c.sort,
        } as never)}
        RETURNING id`;
      id = Number(row!.id);
      // 价格档：双价 → 专业 + 优选（PC7），单价 → 标准；随后 syncLinkedPrices 照价目表写一遍
      const tiers =
        e.priceMode === 'dual' && e.price2Cents !== null
          ? [
              ['professional', e.priceCents!],
              ['premium', e.price2Cents],
            ]
          : [['standard', e.priceCents!]];
      for (const [tier, price] of tiers) await tx`INSERT INTO service_item_prices (item_id, tier, price) VALUES (${id}, ${tier as string}, ${price as number})`;
      out.created += 1;
    }
    await tx`INSERT INTO price_catalog_links (store_id, entry_key, item_id, created_by) VALUES (${storeId}, ${key}, ${id}, ${opts.staffId})`;
    links.set(key, id);
    usedItems.add(id);
  }
  // 整份同步（切换生效、回滚）时：价目表新建的、这份价目表里已经没有的那些停用（已开的单照旧显示原名称、原价）
  if (!wanted) {
    const keep = [...byKey.keys()];
    await tx`
      UPDATE service_items SET active = false, updated_at = clock_timestamp()
      WHERE catalog_managed AND active AND NOT (catalog_key = ANY(${keep}::text[]))`;
  }
  return out;
}

/** 收银项目上的时长：服务时长（按摩）/ 基础价含的时长（门票、娱乐）；超过一天的不写 */
const minutesOf = (e: PriceCatalogEntry) => (e.durationMinutes !== null && e.durationMinutes <= 1440 ? e.durationMinutes : null);
/** 只限一种性别的写上（男 / 女都行的不写） */
const genderOf = (e: PriceCatalogEntry) => (e.gender === 'female' || e.gender === 'male' ? e.gender : null);
