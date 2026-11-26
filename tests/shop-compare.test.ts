// 采购商城比价页（FR-01 批次 A）单测：纯整数含税总成本公式、0 分误差一致性、阻断原因与推荐解释。

import { describe, expect, it } from 'vitest';
import { buildCompareOffers, defaultCompareQtyMilli, formatTaxRate, grossCents, lineGoodsCents, lineGrossCents, type ShopCatalog, type ShopOffer } from '../src/shared/shop';

const makeOffer = (over: Partial<ShopOffer> = {}): ShopOffer => ({
  skuId: 101,
  skuCode: 'SKU-A',
  priceVersion: 1,
  supplier: { id: 1, name: '甲供应商', admission: 'approved' },
  priceCents: 1000,
  taxRateBp: 1300,
  grossCents: grossCents(1000, 1300),
  moqMilli: 10_000,
  leadDays: 3,
  freightCents: 0,
  validUntil: '2027-12-31',
  stores: [],
  status: 'approved',
  corePending: false,
  block: null,
  ...over,
});

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

  it('defaultCompareQtyMilli：优先 URL ?qty=，其次可采购最小起订量', () => {
    const cat = makeCatalog([
      makeOffer({ skuId: 1, moqMilli: 5000, block: 'expired' }),
      makeOffer({ skuId: 2, moqMilli: 20_000, block: null }),
      makeOffer({ skuId: 3, moqMilli: 12_500, block: null }),
    ]);
    const item = cat.items[0];
    expect(defaultCompareQtyMilli(item, '7.5')).toBe(7500);
    expect(defaultCompareQtyMilli(item, 'invalid')).toBe(12_500);
    expect(defaultCompareQtyMilli(item, null)).toBe(12_500);
    expect(defaultCompareQtyMilli(undefined, null)).toBe(1000);
  });
});
