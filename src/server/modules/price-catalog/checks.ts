// 价目表重做第四批：分类核对与导出（docs/PRICE_CATALOG.md 第 7.4 节）。
//   · 分类核对：生效中的价目表每个分类在用几项、能卖几项，点单页上对上这个分类、在用的收银项目几个——需求说明第三节 7
//     「点单页逐个分类点一遍，确认各分类下项目数与表格一致、无串类、无漏项」，页面上一张表直接看；
//   · 导出：一份价目表按六张表各出一张工作表（分类编码、名称、价格、时长……一行一项），门店拿去与原表逐项核对。只读，不加锁。

import { minutesText, PRICE_GENDER_LABELS, PRICE_SHEET_NAMES, PRICE_SHEETS, priceCategoriesOf, windowText, type PriceCatalogEntry, type PriceCategoryCheck } from '@shared/price-catalog';
import type { Db } from '../../db';
import { currentStoreId } from '../../lib/store-context';
import { buildWorkbook, type WbSheet } from '../../lib/xlsx';
import { NOT_ITEMS, sellable } from './materialize';
import { entriesOf } from './read';

export async function priceCategoryChecks(db: Db): Promise<PriceCategoryCheck[]> {
  const [active] = await db<{ id: number }[]>`SELECT id FROM price_catalog_sets WHERE store_id = ${currentStoreId()} AND status = 'active'`;
  if (!active) return [];
  const entries = (await entriesOf(db, Number(active.id))).filter((e) => e.active);
  const { categories, byEntry } = priceCategoriesOf(entries);
  const items = new Map(
    (
      await db<{ code: string; n: number }[]>`
        SELECT i.catalog_category_code AS code, count(*)::int AS n
        FROM service_items i JOIN price_catalog_links l ON l.item_id = i.id AND l.store_id = ${currentStoreId()}
        WHERE i.active AND i.catalog_category_code IS NOT NULL GROUP BY 1`
    ).map((r) => [r.code, Number(r.n)]),
  );
  return categories.map((c) => {
    const mine = entries.filter((_, i) => byEntry[i]!.code === c.code);
    const sheet = mine[0]!.sheet;
    const noItems = mine.every((e) => NOT_ITEMS.has(e.kind));
    return {
      code: c.code,
      name: c.name,
      group: c.group,
      sheet,
      entries: mine.length,
      sellable: noItems ? 0 : mine.filter(sellable).length,
      items: noItems ? null : (items.get(c.code) ?? 0),
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
