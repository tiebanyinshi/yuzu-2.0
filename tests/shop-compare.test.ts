// 采购商城比价页（FR-01 批次 A）单测：纯整数含税总成本公式、0 分误差一致性、阻断原因与推荐解释。

import { describe, expect, it } from 'vitest';
import {
  applyCompareCartSelection,
  buildCompareOffers,
  catalogCardSummary,
  filterAndSortCompareOffers,
  findMaterialCartLine,
  formatTaxRate,
  grossCents,
  groupShopCart,
  lineGoodsCents,
  lineGrossCents,
  resolveCompareQtyMilli,
  SHOP_MAX_QTY_MILLI,
  type ShopCart,
  type ShopCatalog,
  type ShopOffer,
} from '../src/shared/shop';

const makeOffer = (over: Partial<ShopOffer> = {}): ShopOffer => {
  const priceCents = over.priceCents ?? 1000;
  const taxRateBp = over.taxRateBp ?? 1300;
  return {
    skuId: 101,
    skuCode: 'SKU-A',
    priceVersion: 1,
    supplier: { id: 1, name: '甲供应商', admission: 'approved' },
    priceCents,
    taxRateBp,
    grossCents: over.grossCents ?? grossCents(priceCents, taxRateBp),
    moqMilli: 10_000,
    leadDays: 3,
    freightCents: 0,
    validUntil: '2027-12-31',
    stores: [],
    status: 'approved',
    corePending: false,
    block: null,
    ...over,
  };
};

const makeCatalog = (offers: ShopOffer[]): ShopCatalog => ({
  storeId: 1,
  stores: [
    { id: 1, name: '总店', entityId: 1 },
    { id: 2, name: '分店', entityId: 1 },
  ],
  entities: [{ id: 1, name: '汤崎总公司' }],
  departments: [],
  categories: [{ name: '布草', count: 1 }],
  items: offers.length
    ? [
        {
          material: { id: 16, code: 'M016', name: '加大浴巾', category: '布草', specification: '80×160cm', unit: '条', note: '' },
          offers,
          fromGrossCents: offers.some((o) => o.block === null) ? Math.min(...offers.filter((o) => o.block === null).map((o) => o.grossCents)) : null,
          purchasable: offers.filter((o) => o.block === null).length,
        },
      ]
    : [],
  purposes: ['客用消耗'],
  me: { departmentId: 1, departmentName: '运营部', canPickDepartment: false, canPool: false, canManageSku: false, canApproveSku: false },
  today: '2026-11-25',
});

describe('含税总成本纯整数公式（FR-01 第 3 条）', () => {
  it('精确整除不产生多余进位，避开 IEEE-754 浮点误差', () => {
    // 经典浮点坑：JS 中 100 * 1.07 = 107.00000000000001，Math.ceil 会错算成 108；整数运算应精确等于 107
    expect(lineGoodsCents(100, 700, 1000)).toBe(107);
    expect(lineGrossCents(100, 700, 1000, 0)).toBe(107);
    // 3 × ¥10.00 × 1.13 = ¥33.90（3390 分）
    expect(lineGrossCents(1000, 1300, 3000, 0)).toBe(3390);
    // 100 × ¥8.50 × 1.13 = ¥960.50（96050 分）
    expect(lineGoodsCents(850, 1300, 100_000)).toBe(96_050);
  });

  it('有余数时向上取整到分，运费固定按每次采购一笔叠加', () => {
    // 100 分 × 0.333 × 1.13 = 37.629 分 → ceil = 38 分
    expect(lineGoodsCents(100, 1300, 333)).toBe(38);
    expect(lineGrossCents(100, 1300, 333, 500)).toBe(538);
    // 1990 分 × 1 × 1.13 = 2248.7 分 → ceil = 2249 分；运费 1500 分只加一次，不随数量倍增
    expect(lineGrossCents(1990, 1300, 1000, 1500)).toBe(3749);
    expect(lineGrossCents(1990, 1300, 2000, 1500)).toBe(4498 + 1500);
    // 极小尾数也要向上取整：1 分 × 0.001 × 1.00 = 0.001 分 → ceil = 1 分
    expect(lineGoodsCents(1, 0, 1)).toBe(1);
    // 0 数量或 0 单价：货款 0 分
    expect(lineGoodsCents(0, 1300, 5000)).toBe(0);
    expect(lineGoodsCents(1000, 1300, 0)).toBe(0);
  });

  it('含税单价 grossCents 与税率格式化', () => {
    expect(grossCents(1000, 1300)).toBe(1130);
    expect(grossCents(100, 700)).toBe(107);
    expect(grossCents(333, 1300)).toBe(376); // 333 * 1.13 = 376.29 → 376
    expect(grossCents(100, 50)).toBe(101); // 100.5 → 101（四舍五入）
    expect(formatTaxRate(1300)).toBe('13%');
    expect(formatTaxRate(0)).toBe('0%');
    expect(formatTaxRate(350)).toBe('3.5%');
    expect(formatTaxRate(125)).toBe('1.25%');
  });
});

describe('比价聚合 buildCompareOffers（0 分误差、排序、阻断与推荐）', () => {
  it('按可采购优先 + 含税总成本升序排序，与清单函数 0 分误差，并给出可验证的推荐解释', () => {
    // 场景：甲单价略贵但包邮（1000 分 × 10 × 1.13 + 0 = 11300 分，交期 5 天）；
    // 乙单价便宜但收运费（980 分 × 10 × 1.13 + 1500 = 11074 + 1500 = 12574 分，交期 3 天）
    const offerA = makeOffer({ skuId: 201, supplier: { id: 1, name: '甲包邮', admission: 'approved' }, priceCents: 1000, taxRateBp: 1300, freightCents: 0, leadDays: 5, moqMilli: 10_000 });
    const offerB = makeOffer({ skuId: 202, supplier: { id: 2, name: '乙低价有运费', admission: 'approved' }, priceCents: 980, taxRateBp: 1300, freightCents: 1500, leadDays: 3, moqMilli: 5000 });
    const res = buildCompareOffers(makeCatalog([offerB, offerA]), 16, 10_000, '2026-11-25T10:00:00Z');

    expect(res.material?.code).toBe('M016');
    expect(res.offers.map((o) => o.skuId)).toEqual([201, 202]);
    // 0 分误差核对：比价页 totalCents 与清单使用的 lineGrossCents 完全一致
    for (const o of res.offers) {
      expect(o.totalCents).toBe(lineGrossCents(o.priceCents, o.taxRateBp, 10_000, o.freightCents));
    }
    expect(res.offers[0]!.totalCents).toBe(11_300);
    expect(res.offers[1]!.totalCents).toBe(12_574);
    expect(res.offers[0]!.estimatedArrival).toBe('2026-11-30');
    expect(res.offers[1]!.estimatedArrival).toBe('2026-11-28');
    expect(res.recommendedSkuId).toBe(201);
    // 12574 - 11300 = 1274 分 = ¥12.74，交期 5 - 3 = 多 2 天
    expect(res.recommendReason).toBe('比次低省 ¥12.74，交期多 2 天');
  });

  it('修改数量后实时重算：大批量时低单价有运费反超包邮', () => {
    const offerA = makeOffer({ skuId: 201, priceCents: 1000, taxRateBp: 1300, freightCents: 0, leadDays: 5, moqMilli: 10_000 });
    const offerB = makeOffer({ skuId: 202, priceCents: 980, taxRateBp: 1300, freightCents: 1500, leadDays: 3, moqMilli: 5000 });
    const res = buildCompareOffers(makeCatalog([offerA, offerB]), 16, 100_000, '2026-11-25T10:00:00Z');
    // 甲：113000 分；乙：110740 + 1500 = 112240 分 → 乙省 760 分（¥7.60）且交期少 2 天
    expect(res.offers.map((o) => o.skuId)).toEqual([202, 201]);
    expect(res.recommendedSkuId).toBe(202);
    expect(res.recommendReason).toBe('比次低省 ¥7.60，交期少 2 天');
  });

  it('阻断行排在可采购行之后，服务端 block 优先于起订量不足，不隐藏任何行', () => {
    const ok = makeOffer({ skuId: 301, priceCents: 1200, moqMilli: 5000, block: null });
    const belowMoq = makeOffer({ skuId: 302, priceCents: 800, moqMilli: 50_000, block: null });
    const expired = makeOffer({ skuId: 303, priceCents: 700, moqMilli: 50_000, block: 'expired' });
    const wrongStore = makeOffer({ skuId: 304, priceCents: 600, moqMilli: 1000, block: 'store' });
    const noAdmit = makeOffer({ skuId: 305, supplier: { id: 5, name: '未准入', admission: 'pending' }, priceCents: 500, moqMilli: 1000, block: 'supplier' });
    const res = buildCompareOffers(makeCatalog([noAdmit, wrongStore, expired, belowMoq, ok]), 16, 10_000, '2026-11-25T10:00:00Z');

    expect(res.offers).toHaveLength(5);
    expect(res.offers[0]!.skuId).toBe(301);
    expect(res.offers[0]!.purchasable).toBe(true);
    expect(res.recommendedSkuId).toBe(301);
    expect(res.recommendReason).toBe('当前唯一可采购报价');
    // 阻断原因核对：expired 虽也低于起订量，但保留服务端 expired
    const byId = new Map(res.offers.map((o) => [o.skuId, o]));
    expect(byId.get(302)).toMatchObject({ purchasable: false, blockReason: 'below_moq' });
    expect(byId.get(303)).toMatchObject({ purchasable: false, blockReason: 'expired' });
    expect(byId.get(304)).toMatchObject({ purchasable: false, blockReason: 'store' });
    expect(byId.get(305)).toMatchObject({ purchasable: false, blockReason: 'supplier', admitted: false });
  });

  it('0 家报价或不存在的物料返回空态，不抛错', () => {
    const empty = buildCompareOffers(makeCatalog([]), 999, 1000, '2026-11-25T10:00:00Z');
    expect(empty.material).toBeNull();
    expect(empty.offers).toEqual([]);
    expect(empty.recommendedSkuId).toBeNull();
    expect(empty.recommendReason).toBeNull();
  });

  it('resolveCompareQtyMilli：优先 URL ?qty=，超提交上限 1,000,000 统一截断并标 clamped，其次可采购最小起订量', () => {
    const cat = makeCatalog([
      makeOffer({ skuId: 1, moqMilli: 5000, block: 'expired' }),
      makeOffer({ skuId: 2, moqMilli: 20_000, block: null }),
      makeOffer({ skuId: 3, moqMilli: 12_500, block: null }),
    ]);
    const item = cat.items[0];
    expect(resolveCompareQtyMilli(item, '7.5')).toEqual({ qtyMilli: 7500, clamped: false });
    expect(resolveCompareQtyMilli(item, '1000001')).toEqual({ qtyMilli: SHOP_MAX_QTY_MILLI, clamped: true });
    expect(resolveCompareQtyMilli(item, 'invalid')).toEqual({ qtyMilli: 12_500, clamped: false });
    expect(resolveCompareQtyMilli(item, null)).toEqual({ qtyMilli: 12_500, clamped: false });
    expect(resolveCompareQtyMilli(undefined, null)).toEqual({ qtyMilli: 1000, clamped: false });
  });
});

describe('比价页排序、筛选与原位替换清单（批次 B）', () => {
  it('按总成本/单价/交期排序并按包邮/可立即下单/已准入筛选', () => {
    const offers = buildCompareOffers(
      makeCatalog([
        makeOffer({ skuId: 1, priceCents: 1000, freightCents: 0, leadDays: 5, moqMilli: 10_000 }),
        makeOffer({ skuId: 2, priceCents: 950, freightCents: 1500, leadDays: 2, moqMilli: 10_000 }),
        makeOffer({ skuId: 3, supplier: { id: 3, name: '未准入', admission: 'pending' }, priceCents: 800, freightCents: 0, leadDays: 1, moqMilli: 10_000, block: 'supplier' }),
      ]),
      16,
      10_000,
      '2026-11-25T10:00:00Z',
    ).offers;
    const none = { freeShippingOnly: false, purchasableOnly: false, admittedOnly: false };
    expect(filterAndSortCompareOffers(offers, 'total', none).map((o) => o.skuId)).toEqual([1, 2, 3]);
    expect(filterAndSortCompareOffers(offers, 'unit', none).map((o) => o.skuId)).toEqual([2, 1, 3]);
    expect(filterAndSortCompareOffers(offers, 'lead', none).map((o) => o.skuId)).toEqual([2, 1, 3]);
    expect(filterAndSortCompareOffers(offers, 'total', { ...none, freeShippingOnly: true }).map((o) => o.skuId)).toEqual([1, 3]);
    expect(filterAndSortCompareOffers(offers, 'total', { ...none, freeShippingOnly: true, purchasableOnly: true }).map((o) => o.skuId)).toEqual([1]);
    expect(filterAndSortCompareOffers(offers, 'total', { ...none, admittedOnly: true }).map((o) => o.skuId)).toEqual([1, 2]);
  });

  it('选这家加清单、原位替换供应商（只留 1 行且运费只计一次）、跨门店不静默覆写', () => {
    const matSkus = [101, 102, 103];
    const empty: ShopCart = { storeId: null, lines: [] };
    // 1) 加入新物料
    const added = applyCompareCartSelection(empty, { skuId: 101, priceVersion: 1 }, matSkus, 10_000, 1);
    expect(added.kind).toBe('added');
    if (added.kind === 'cross_store') throw new Error('unexpected');
    expect(added.cart).toEqual({ storeId: 1, lines: [{ skuId: 101, priceVersion: 1, qtyMilli: 10_000 }] });

    // 2) 插入另一个物料 201 在前面，再替换 101 → 102：应原位替换，保留顺序且该物料仅 1 行
    const withOther: ShopCart = { storeId: 1, lines: [{ skuId: 201, priceVersion: 1, qtyMilli: 5000 }, ...added.cart.lines] };
    expect(findMaterialCartLine(withOther, 1, matSkus)?.skuId).toBe(101);
    const replaced = applyCompareCartSelection(withOther, { skuId: 102, priceVersion: 2 }, matSkus, 12_000, 1);
    expect(replaced.kind).toBe('replaced');
    if (replaced.kind === 'cross_store') throw new Error('unexpected');
    expect(replaced.replacedSkuId).toBe(101);
    expect(replaced.cart.lines).toEqual([
      { skuId: 201, priceVersion: 1, qtyMilli: 5000 },
      { skuId: 102, priceVersion: 2, qtyMilli: 12_000 },
    ]);

    // 3) 跨门店时不静默覆写；确认后才重置
    const cross = applyCompareCartSelection(replaced.cart, { skuId: 103, priceVersion: 1 }, matSkus, 10_000, 2);
    expect(cross).toEqual({ kind: 'cross_store' });
    const reset = applyCompareCartSelection(replaced.cart, { skuId: 103, priceVersion: 1 }, matSkus, 10_000, 2, true);
    expect(reset.kind).toBe('added');
    if (reset.kind === 'cross_store') throw new Error('unexpected');
    expect(reset.cart).toEqual({ storeId: 2, lines: [{ skuId: 103, priceVersion: 1, qtyMilli: 10_000 }] });
  });
});

describe('清单按供应商分组、起订量进度与商品卡摘要（批次 C）', () => {
  it('groupShopCart：组小计之和等于总计，起订量进度与缺口准确，问题集中汇总', () => {
    const oA1 = makeOffer({ skuId: 401, supplier: { id: 10, name: '供应商甲', admission: 'approved' }, priceCents: 1000, freightCents: 0, moqMilli: 100_000, priceVersion: 1 });
    const oA2 = makeOffer({ skuId: 402, supplier: { id: 10, name: '供应商甲', admission: 'approved' }, priceCents: 500, freightCents: 800, moqMilli: 100_000, priceVersion: 2 });
    const oB1 = makeOffer({ skuId: 403, supplier: { id: 20, name: '供应商乙', admission: 'approved' }, priceCents: 2000, freightCents: 1500, moqMilli: 10_000, priceVersion: 1 });
    const cat: ShopCatalog = {
      ...makeCatalog([]),
      items: [
        { material: { id: 1, code: 'M1', name: '浴巾', category: '布草', specification: '', unit: '条', note: '' }, offers: [oA1, oB1], fromGrossCents: 1130, purchasable: 2 },
        { material: { id: 2, code: 'M2', name: '毛巾', category: '布草', specification: '', unit: '条', note: '' }, offers: [oA2], fromGrossCents: 565, purchasable: 1 },
      ],
    };
    const cart: ShopCart = {
      storeId: 1,
      lines: [
        { skuId: 401, priceVersion: 1, qtyMilli: 120_000 }, // 120/100 达标
        { skuId: 402, priceVersion: 1, qtyMilli: 60_000 }, // 价格版本旧（V1 vs V2）且低于起订量
        { skuId: 403, priceVersion: 1, qtyMilli: 10_000 }, // 10/10 达标
      ],
    };
    const sum = groupShopCart(cat, cart);
    expect(sum.sameStore).toBe(true);
    expect(sum.groups).toHaveLength(2);
    // 组小计之和严格等于总计，每行总额严格等于 lineGrossCents
    expect(sum.groups.reduce((s, g) => s + g.subtotalCents, 0)).toBe(sum.totalCents);
    for (const g of sum.groups) {
      for (const r of g.rows) {
        expect(r.totalCents).toBe(lineGrossCents(r.offer!.priceCents, r.offer!.taxRateBp, r.line.qtyMilli, r.offer!.freightCents));
      }
    }
    const row401 = sum.groups[0]!.rows[0]!;
    expect(row401).toMatchObject({ moqReached: true, moqShortfallMilli: 0, moqPercent: 100, problem: null });
    const row402 = sum.groups[0]!.rows[1]!;
    expect(row402).toMatchObject({ moqReached: false, moqShortfallMilli: 40_000, moqPercent: 60, problemKind: 'price_changed' });
    expect(sum.priceChangedSkuIds).toEqual([402]);
    expect(sum.issues.some((i) => i.skuId === 402 && i.kind === 'price_changed')).toBe(true);
  });

  it('catalogCardSummary：最快交期与包邮只按可采购报价计算', () => {
    const cat = makeCatalog([
      makeOffer({ skuId: 1, leadDays: 1, freightCents: 0, block: 'expired' }),
      makeOffer({ skuId: 2, leadDays: 5, freightCents: 0, block: null }),
      makeOffer({ skuId: 3, leadDays: 3, freightCents: 1000, block: null }),
    ]);
    expect(catalogCardSummary(cat.items[0]!)).toEqual({ fastestLeadDays: 3, hasFreeShipping: true, minMoqMilli: 10_000 });
    const allBlocked = makeCatalog([makeOffer({ skuId: 1, leadDays: 2, freightCents: 0, block: 'store' })]);
    expect(catalogCardSummary(allBlocked.items[0]!)).toEqual({ fastestLeadDays: null, hasFreeShipping: false, minMoqMilli: null });
  });
});
