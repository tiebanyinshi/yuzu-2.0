// 价目表重做第四批：分类核对与导出（docs/PRICE_CATALOG.md 第 7.4 节）。
//   · 分类核对：生效中的价目表每个分类在用几项、能卖几项，点单页上对上这个分类、在用的收银项目几个——需求说明第三节 7
//     「点单页逐个分类点一遍，确认各分类下项目数与表格一致、无串类、无漏项」，页面上一张表直接看；
//   · 导出：一份价目表按六张表各出一张工作表（分类编码、名称、价格、时长……一行一项），门店拿去与原表逐项核对。只读，不加锁。

import { minutesText, PRICE_GENDER_LABELS, PRICE_SHEET_NAMES, PRICE_SHEETS, priceCategoriesOf, priceNameKey, windowText, type PriceCatalogEntry, type PriceCategoryCheck } from '@shared/price-catalog';
import type { Db } from '../../db';
import { currentStoreId } from '../../lib/store-context';
import { buildWorkbook, type WbSheet } from '../../lib/xlsx';
import { NOT_ITEMS, sellable } from './materialize';
import { entriesOf } from './read';

/**
 * 能卖的一项在点单页上看不看得到，看不到的原因（PC28）：没对上收银项目、收银项目停用了、
 * 按摩及助浴没标「需要技师」（房态中心登记不列）、菜品没挂在用的出品档口（点单页不列）
 */
function hiddenReason(e: PriceCatalogEntry, it: ItemRow | undefined, hasStation: boolean): string | null {
  if (!it && e.sheet === 'dish' && !hasStation) return '还没有在用的出品档口，菜品建不了（先在后台建一个档口，再切换生效一次）';
  if (!it) return '还没对上收银项目（切换生效一次就会建）';
  if (!it.active) return `对上的收银项目「${it.name}」停用了`;
  if (e.sheet === 'massage' && !it.technicianRequired) return `对上的收银项目「${it.name}」没标需要技师，房态中心登记不列（切换生效一次就会补上）`;
  // 与点单菜单（kitchenDishes）同一个条件：挂在在用的档口上、不要技师；没写点单分区的按类别归到默认分区，照样列
  if (e.sheet === 'dish' && !it.stationActive) return `对上的收银项目「${it.name}」没挂在用的出品档口，点单页不列（切换生效一次就会补上；没有档口的先建一个）`;
  if (e.sheet === 'dish' && it.technicianRequired) return `对上的收银项目「${it.name}」标了需要技师，点单页不列（在后台价目里去掉「需要技师」）`;
  return null;
}

interface ItemRow {
  entryKey: string;
  /** 收银项目上的价目表分类编码（对上时写的；停用的项也留着） */
  code: string | null;
  name: string;
  active: boolean;
  technicianRequired: boolean;
  stationActive: boolean;
}

export async function priceCategoryChecks(db: Db): Promise<PriceCategoryCheck[]> {
  const [active] = await db<{ id: number }[]>`SELECT id FROM price_catalog_sets WHERE store_id = ${currentStoreId()} AND status = 'active'`;
  if (!active) return [];
  const entries = (await entriesOf(db, Number(active.id))).filter((e) => e.active);
  const { categories, byEntry } = priceCategoriesOf(entries);
  const items = new Map(
    (
      await db<ItemRow[]>`
        SELECT l.entry_key, i.catalog_category_code AS code, i.name, i.active, i.technician_required, coalesce(k.active, false) AS station_active
        FROM price_catalog_links l JOIN service_items i ON i.id = l.item_id LEFT JOIN kitchen_stations k ON k.id = i.station_id
        WHERE l.store_id = ${currentStoreId()}`
    ).map((r) => [r.entryKey, r]),
  );
  const [st] = await db<{ n: number }[]>`SELECT count(*)::int AS n FROM kitchen_stations WHERE active`;
  const hasStation = st!.n > 0;
  return categories.map((c) => {
    const mine = entries.filter((_, i) => byEntry[i]!.code === c.code);
    const sheet = mine[0]!.sheet;
    const noItems = mine.every((e) => NOT_ITEMS.has(e.kind));
    const sold = noItems ? [] : mine.filter(sellable);
    const hidden = sold.flatMap((e) => {
      const reason = hiddenReason(e, items.get(priceNameKey(e)), hasStation);
      return reason ? [{ name: e.name, reason }] : [];
    });
    // 多出来的：对上这个分类、还在页面上的收银项目，价目表里却不能卖——待定价、不可下单，或者停用了 / 这一份里已经没有
    // （门店原有的项目不跟着价目表停用）。按对接的收银项目独立数，不受价目表里在不在用影响
    const soldKeys = new Set(sold.map(priceNameKey));
    const onPage = (it: ItemRow) => it.active && (sheet === 'massage' ? it.technicianRequired : sheet === 'dish' ? it.stationActive && !it.technicianRequired : true);
    const extra = noItems
      ? []
      : [...items.values()]
          .filter((it) => it.code === c.code && !soldKeys.has(it.entryKey) && onPage(it))
          .map((it) => {
            const e = mine.find((x) => priceNameKey(x) === it.entryKey);
            return {
              name: e?.name ?? it.name,
              reason: e
                ? `价目表里这一项不能卖（待定价或不可下单），对上的收银项目「${it.name}」却还在点单页上（到后台价目里停用它，或在价目表里补价）`
                : `价目表里这一项已经停用（或这一份里没有），对上的收银项目「${it.name}」却还在点单页上（到后台价目里停用它）`,
            };
          });
    return {
      code: c.code,
      name: c.name,
      group: c.group,
      sheet,
      entries: mine.length,
      sellable: sold.length,
      // 点单页（前台开单、房态中心登记、点单页）上看得到的：能卖的里头对上了、在用、上得了页面的
      items: noItems ? null : sold.length - hidden.length + extra.length,
      hidden: [...hidden, ...extra],
    };
  });
}

const yuan = (cents: number | null) => (cents === null ? '' : Number((cents / 100).toFixed(2)));
const MODE_TEXT: Record<PriceCatalogEntry['priceMode'], string> = { dual: '双价', single: '单价', none: '待定价', rate: '比例' };

/** 一份价目表导出成 xlsx：一张表一个工作表，一行一项 */
export async function exportPriceCatalog(db: Db, setId: number): Promise<Buffer> {
  const entries = await entriesOf(db, setId);
  const { byEntry } = priceCategoriesOf(entries);
  const head = [
    '分类编码',
    '上一级',
    '分类名称',
    '原始编号',
    '名称',
    '价格形态',
    '单价 / 专业价（元）',
    '资深价（元）',
    '比例',
    '单位',
    '时长',
    '加钟 / 超时价（元）',
    '封顶价（元）',
    '台位 / 间数',
    '房号',
    '时段',
    '适用性别',
    '分档',
    '备注',
    '可以下单',
    '状态',
  ];
  const sheets: WbSheet[] = PRICE_SHEETS.map((sheet) => ({
    name: PRICE_SHEET_NAMES[sheet],
    widths: [14, 12, 12, 8, 22, 8, 12, 10, 6, 6, 10, 12, 10, 8, 24, 14, 8, 30, 30, 8, 6],
    freezeRows: 1,
    rows: [
      { cells: head },
      ...entries.flatMap((e, i) =>
        e.sheet !== sheet
          ? []
          : [
              {
                cells: [
                  byEntry[i]!.code,
                  byEntry[i]!.group,
                  byEntry[i]!.name,
                  e.code,
                  e.name,
                  MODE_TEXT[e.priceMode],
                  yuan(e.priceCents),
                  yuan(e.price2Cents),
                  e.rateBp === null ? '' : `${e.rateBp / 100}%`,
                  e.unit,
                  minutesText(e.durationMinutes),
                  yuan(e.extraPriceCents),
                  yuan(e.capCents),
                  e.unitsCount ?? '',
                  e.roomNumbers.join(' '),
                  windowText(e.windowStart, e.windowEnd),
                  e.gender ? PRICE_GENDER_LABELS[e.gender] : '',
                  e.variants.map((v) => `${v.label} ${v.priceCents === null ? '—' : yuan(v.priceCents)}`).join('；'),
                  e.note,
                  e.orderable ? '是' : '否',
                  e.active ? '在用' : '停用',
                ],
              },
            ],
      ),
    ],
  }));
  sheets[0]!.active = true;
  return buildWorkbook(sheets);
}
