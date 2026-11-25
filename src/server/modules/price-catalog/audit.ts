// 价目核对与清理（8.1.34，店主 2026-11-24「价目、消费项目太乱，以价目表为准重构；看看正式服的价目数据有没有奇怪的地方，删掉」）。
// 命令行 `price-audit`（docs/PRICE_V8134.md）：默认只读，列出收银项目（service_items）里与「全品类价目表」对不上、看着奇怪的地方；
// 加 --apply 只做一类事——把下面两种明显多余的收银项目停用（不删：已开的单、改价记录、券、次卡都按编号指着它们）：
//   · 价目表以前建的门票、夜间票（8.1.34 起门票按「门票」票种结账，不再有能挂单的门票项目）；
//   · 没对接、但和一个已对接的在售项目同名的（同一个东西两个收银项目，前台会挑错）；
// 「开单即占用」规则里当房费、开台费用的项目不停用。其余（价目表里没有的在售项目等）只列出来，由店主、店总在后台决定。
// 加锁：只在 --apply 时写；取全品类价目表的门店锁（与切换生效、对接排队），再按 id 升序锁要停用的收银项目（FOR NO KEY UPDATE，与 syncLinkedPrices 同一个顺序）。

import { priceNameKey } from '@shared/price-catalog';
import type { Sql, Tx } from '../../db';
import { writeAudit } from '../../lib/audit';
import { DEFAULT_STORE_ID, runInStore } from '../../lib/store-context';
import { setTxTimeouts } from '../../lib/tx';
import { lockStoreCatalog } from './links';
import { entriesOf } from './read';

export interface PriceAuditItem {
  id: number;
  name: string;
  category: string;
  /** 最近一次开单（营业以来没开过为空） */
  lastSoldAt: string | null;
}

export interface PriceAuditReport {
  /** 生效中的价目表（本店）；没有时其余几项只能参考 */
  activeSet: { id: number; title: string } | null;
  totals: { activeItems: number; linked: number; unlinked: number };
  /** 以下两类 --apply 会停用（「没有价格」不算：数据库要求项目本身的价格大于 0，开单按它当标准档，pricing.ts；Codex 审查） */
  ticketItems: PriceAuditItem[];
  duplicates: (PriceAuditItem & { sameAsId: number })[];
  /** 只列出：在售、没对接价目表的（价目表管不到的房费、开台费之类可以留着） */
  unlinked: PriceAuditItem[];
  /** 只列出：对接了的双价项目还留着「标准」档（下次切换生效会去掉） */
  standardOnDual: PriceAuditItem[];
  /** 只列出：价目表里在用、收银项目却停用了的 */
  linkedButInactive: PriceAuditItem[];
  /** 只列出：价目表的门票价与「门票」票种对不上（票价要在 价目与套餐 → 门票 里照价目表改） */
  ticketTypeMismatch: string[];
  /** 「开单即占用」规则在用的项目，不停用 */
  protectedIds: number[];
  /** --apply 时实际停用了几个 */
  deactivated: number;
}

const nameKey = (s: string) => s.replace(/\s+/g, '').toLowerCase();

async function usageItemIds(db: Sql | Tx): Promise<Set<number>> {
  const rows = await db<{ value: unknown }[]>`
    SELECT value FROM settings WHERE key = 'usage_rules' UNION ALL SELECT value FROM store_settings WHERE key = 'usage_rules'`;
  const ids = new Set<number>();
  const walk = (v: unknown) => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) {
        if ((k === 'feeItemId' || k === 'openFeeItemId') && typeof x === 'number') ids.add(x);
        else walk(x);
      }
    }
  };
  for (const r of rows) walk(r.value);
  return ids;
}

/** 本店（编号 1）的收银项目与价目表核对；apply 为真时停用两类明显多余的 */
export async function priceAudit(sql: Sql, opts: { apply: boolean; staffId: number | null }): Promise<PriceAuditReport> {
  return runInStore(DEFAULT_STORE_ID, () =>
    sql.begin(async (tx) => {
      await setTxTimeouts(tx);
      if (opts.apply) await lockStoreCatalog(tx);
      const [set] = await tx<{ id: number; title: string }[]>`SELECT id, title FROM price_catalog_sets WHERE store_id = ${DEFAULT_STORE_ID} AND status = 'active'`;
      const items = await tx<
        {
          id: number;
          name: string;
          category: string;
          active: boolean;
          catalogManaged: boolean;
          catalogKey: string | null;
          linkKey: string | null;
          tiers: string[] | null;
          lastSoldAt: string | null;
          isDish: boolean;
        }[]
      >`
        SELECT i.id, i.name, i.category, i.active, i.catalog_managed, i.catalog_key, l.entry_key AS link_key,
               (SELECT array_agg(p.tier ORDER BY p.tier) FROM service_item_prices p WHERE p.item_id = i.id AND p.price > 0) AS tiers,
               (SELECT max(b.posted_at) FROM bill_lines b WHERE b.item_id = i.id) AS last_sold_at,
               (i.station_id IS NOT NULL) AS is_dish
        FROM service_items i
        LEFT JOIN price_catalog_links l ON l.item_id = i.id AND l.store_id = ${DEFAULT_STORE_ID}
        ORDER BY i.id`;
      const entries = set ? await entriesOf(tx, Number(set.id)) : [];
      const entryByKey = new Map(entries.map((e) => [priceNameKey(e), e]));
      const view = (i: (typeof items)[number]): PriceAuditItem => ({ id: Number(i.id), name: i.name, category: i.category, lastSoldAt: i.lastSoldAt });
      const protectedIds = await usageItemIds(tx);
      const live = items.filter((i) => i.active);
      const linked = live.filter((i) => i.linkKey !== null);
      const linkedByName = new Map(linked.map((i) => [nameKey(i.name), i]));

      // 价目表建的门票项目：按它的价目表条目认（门票、夜间票）；条目已不在生效的那份里的，按价目表建门票时用的类别「入场」认
      const isTicketKind = (k: string | undefined) => k === 'ticket' || k === 'night_ticket';
      const ticketItems = live.filter((i) => i.catalogManaged && (isTicketKind(entryByKey.get(i.catalogKey ?? '')?.kind) || (!entryByKey.has(i.catalogKey ?? '') && i.category === '入场')));
      const duplicates = live
        .filter((i) => i.linkKey === null && !ticketItems.includes(i))
        .flatMap((i) => {
          const twin = linkedByName.get(nameKey(i.name));
          return twin && twin.id !== i.id ? [{ ...view(i), sameAsId: Number(twin.id) }] : [];
        });
      const flagged = new Set([...ticketItems.map((i) => Number(i.id)), ...duplicates.map((d) => d.id)]);
      const unlinked = live.filter((i) => i.linkKey === null && !flagged.has(Number(i.id)));
      const standardOnDual = linked.filter((i) => {
        const e = entryByKey.get(i.linkKey!);
        return e?.priceMode === 'dual' && (i.tiers ?? []).includes('standard');
      });
      const linkedButInactive = items.filter((i) => !i.active && i.linkKey !== null && entryByKey.get(i.linkKey)?.active && !i.isDish);

      // 门票：价目表「门店价格」里不含餐的 12H / 24H 与默认票种的两档价比一比（含餐、夜间票票种对应由店主在门票页里定）
      const ticketTypeMismatch: string[] = [];
      const tickets = entries.filter((e) => e.kind === 'ticket' && e.active && !e.includesMeal && e.priceCents !== null);
      const t12 = tickets.find((e) => e.durationMinutes === 720)?.priceCents ?? null;
      const t24 = tickets.find((e) => e.durationMinutes === 1440)?.priceCents ?? null;
      const [def] = await tx<{ name: string; price12h: number; price24h: number }[]>`
        SELECT name, price_12h, price_24h FROM ticket_types WHERE is_default AND active LIMIT 1`;
      if (def && t12 !== null && Number(def.price12h) !== t12) ticketTypeMismatch.push(`默认票种「${def.name}」12 小时 ${Number(def.price12h) / 100} 元，价目表不含餐 12H ${t12 / 100} 元`);
      if (def && t24 !== null && Number(def.price24h) !== t24) ticketTypeMismatch.push(`默认票种「${def.name}」24 小时 ${Number(def.price24h) / 100} 元，价目表不含餐 24H ${t24 / 100} 元`);

      let deactivated = 0;
      const toOff = [...flagged].filter((id) => !protectedIds.has(id)).sort((a, b) => a - b);
      if (opts.apply && toOff.length) {
        await tx`SELECT id FROM service_items WHERE id IN ${tx(toOff)} ORDER BY id FOR NO KEY UPDATE`;
        const done = await tx<{ id: number; name: string }[]>`
          UPDATE service_items SET active = false, updated_at = clock_timestamp() WHERE id IN ${tx(toOff)} AND active RETURNING id, name`;
        deactivated = done.length;
        if (deactivated) {
          await writeAudit(tx, {
            staffId: opts.staffId,
            action: 'price_catalog',
            targetType: 'price_catalog_set',
            targetId: set ? String(set.id) : undefined,
            detail: {
              action: 'audit_cleanup',
              label: `价目核对清理：停用 ${deactivated} 个多余的收银项目（门票项目、与已对接项目同名的、没有价格的）`,
              items: done.map((d) => ({ itemId: Number(d.id), name: d.name })),
            },
          });
        }
      }
      return {
        activeSet: set ? { id: Number(set.id), title: set.title } : null,
        totals: { activeItems: live.length, linked: linked.length, unlinked: live.length - linked.length },
        ticketItems: ticketItems.map(view),
        duplicates,
        unlinked: unlinked.map(view),
        standardOnDual: standardOnDual.map(view),
        linkedButInactive: linkedButInactive.map(view),
        ticketTypeMismatch,
        protectedIds: [...protectedIds].sort((a, b) => a - b),
        deactivated,
      };
    }),
  );
}
