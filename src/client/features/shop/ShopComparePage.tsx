// 采购商城 · 多供应商独立比价页（FR-01，批次 A 只读对比 + 批次 B 服务端报价接口、选这家/替换确认、排序筛选、返回位置恢复与移动端卡片化）。
// 地址：/erp/shop/compare/:materialId?qty=<数量>&from=<catalog|list|request>&skuId=<当前供应商>&storeId=<门店>
// 内嵌在 ERP /erp/shop 路由下，复用现有会话、权限与侧栏；不新建独立服务或独立登录。

import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { ArrowLeft, Check, ChevronRight, Minus, PencilLine, Plus, ShoppingCart, Sparkles } from 'lucide-react';
import { formatYuan } from '@shared/money';
import { formatQty, parseQty } from '@shared/quantity';
import {
  applyCompareCartSelection,
  filterAndSortCompareOffers,
  findMaterialCartLine,
  formatTaxRate,
  lineGrossCents,
  SHOP_COMPARE_BLOCK_LABELS,
  SHOP_MAX_QTY_MILLI,
  type ShopCart,
  type ShopCompareFilters,
  type ShopCompareOffer,
  type ShopCompareResult,
  type ShopCompareSort,
} from '@shared/shop';
import { api } from '../../lib/api';
import { cn, formatDateTime } from '../../lib/utils';
import { DataTable, type DataColumn } from '../../components/DataTable';
import { EmptyState } from '../../components/EmptyState';
import { LoadFailed } from '../../components/LoadFailed';
import { Dialog } from '../../components/Overlay';
import { MilliQtyInput } from '../../components/QtyInput';
import { useToast } from '../../components/Toast';
import { Badge, Button, Card, Notice, Segmented, Skeleton } from '../../components/ui';

const BASE = '/erp/shop';
const MAX_QTY_LABEL = formatQty(SHOP_MAX_QTY_MILLI);

const ADMISSION_LABEL: Record<string, { text: string; tone: 'pine' | 'ember' | 'clay' | 'neutral' }> = {
  approved: { text: '已准入', tone: 'pine' },
  pending: { text: '待准入', tone: 'ember' },
  suspended: { text: '已暂停', tone: 'clay' },
};

const SORT_OPTIONS: { value: ShopCompareSort; label: string }[] = [
  { value: 'total', label: '含税总成本升序' },
  { value: 'unit', label: '单价最低' },
  { value: 'lead', label: '交期最短' },
];

export interface ShopComparePageProps {
  materialId: number;
  storeId: number | null;
  cart: ShopCart;
  setCart: (next: ShopCart) => void;
  onSyncStore: (storeId: number) => void;
}

function parseInitialQueryQty(raw: string | null): { qtyMilli: number | null; clamped: boolean } {
  if (!raw) return { qtyMilli: null, clamped: false };
  const parsed = parseQty(raw);
  if (parsed === null || parsed <= 0) return { qtyMilli: null, clamped: false };
  if (parsed > SHOP_MAX_QTY_MILLI) return { qtyMilli: SHOP_MAX_QTY_MILLI, clamped: true };
  return { qtyMilli: parsed, clamped: false };
}

export function ShopComparePage({ materialId, storeId, cart, setCart, onSyncStore }: ShopComparePageProps) {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const toast = useToast();

  const from = searchParams.get('from');
  const queryQty = searchParams.get('qty');
  const urlSkuId = Number(searchParams.get('skuId')) || null;

  const initialQuery = useMemo(() => parseInitialQueryQty(queryQty), [queryQty]);
  const [customQtyMilli, setCustomQtyMilli] = useState<number | null>(initialQuery.qtyMilli);
  const [qtyHint, setQtyHint] = useState<string | null>(() => (initialQuery.clamped ? `数量最多 ${MAX_QTY_LABEL}，已按 ${MAX_QTY_LABEL} 算` : null));

  const [sort, setSort] = useState<ShopCompareSort>('total');
  const [filters, setFilters] = useState<ShopCompareFilters>({ freeShippingOnly: false, purchasableOnly: false, admittedOnly: false });
  const [mobilePickedSkuId, setMobilePickedSkuId] = useState<number | null>(urlSkuId);
  const [replaceTarget, setReplaceTarget] = useState<ShopCompareOffer | null>(null);
  const [crossStoreTarget, setCrossStoreTarget] = useState<ShopCompareOffer | null>(null);
  const [lastPickedText, setLastPickedText] = useState<string | null>(null);

  // 切换物料或地址栏 ?qty= 变化时同步初始数量与超限提示
  useEffect(() => {
    setCustomQtyMilli(initialQuery.qtyMilli);
    setQtyHint(initialQuery.clamped ? `数量最多 ${MAX_QTY_LABEL}，已按 ${MAX_QTY_LABEL} 算` : null);
    setMobilePickedSkuId(urlSkuId);
    setLastPickedText(null);
  }, [materialId, initialQuery.qtyMilli, initialQuery.clamped, urlSkuId]);

  const validMaterialId = Number.isInteger(materialId) && materialId > 0;
  const queryUrl = useMemo(() => {
    const qs = new URLSearchParams({ materialId: String(materialId) });
    if (customQtyMilli !== null) qs.set('qtyMilli', String(customQtyMilli));
    if (storeId !== null) qs.set('storeId', String(storeId));
    return `/api/erp/shop/offers?${qs.toString()}`;
  }, [materialId, customQtyMilli, storeId]);

  const q = useQuery({
    queryKey: ['shop', 'offers', materialId, storeId, customQtyMilli],
    queryFn: () => api.get<ShopCompareResult>(queryUrl),
    enabled: validMaterialId,
    placeholderData: keepPreviousData,
  });

  const result = q.data;
  const resolvedStoreId = result?.storeId ?? null;
  // 服务端核验通过的比价门店同步回商城持久门店状态，离开比价页进入清单/结算/目录时不会回退到旧门店
  useEffect(() => {
    if (resolvedStoreId !== null) onSyncStore(resolvedStoreId);
  }, [resolvedStoreId, onSyncStore]);
  const activeQtyMilli = customQtyMilli ?? result?.qtyMilli ?? 1000;
  const materialSkuIds = useMemo(() => (result?.offers ?? []).map((o) => o.skuId), [result?.offers]);
  const currentCartLine = useMemo(() => (result ? findMaterialCartLine(cart, result.storeId, materialSkuIds) : null), [cart, result, materialSkuIds]);
  const currentSkuId = currentCartLine?.skuId ?? urlSkuId;
  const currentOffer = useMemo(() => result?.offers.find((o) => o.skuId === currentSkuId) ?? null, [result?.offers, currentSkuId]);

  const visibleOffers = useMemo(() => (result ? filterAndSortCompareOffers(result.offers, sort, filters) : []), [result, sort, filters]);
  const hasFilters = filters.freeShippingOnly || filters.purchasableOnly || filters.admittedOnly;

  const mobileSelectedOffer = useMemo(() => visibleOffers.find((o) => o.skuId === mobilePickedSkuId && o.purchasable) ?? null, [visibleOffers, mobilePickedSkuId]);

  const setQtyMilli = (nextMilli: number) => {
    const rounded = Math.round(nextMilli);
    if (rounded > SHOP_MAX_QTY_MILLI) {
      setCustomQtyMilli(SHOP_MAX_QTY_MILLI);
      setQtyHint(`数量最多 ${MAX_QTY_LABEL}，已按 ${MAX_QTY_LABEL} 算`);
      return;
    }
    setCustomQtyMilli(Math.max(1, rounded));
    setQtyHint(null);
  };

  const stepQty = (deltaUnits: number) => {
    const next = activeQtyMilli + deltaUnits * 1000;
    if (next > SHOP_MAX_QTY_MILLI) {
      setCustomQtyMilli(SHOP_MAX_QTY_MILLI);
      setQtyHint(`数量最多 ${MAX_QTY_LABEL}，已按 ${MAX_QTY_LABEL} 算`);
      return;
    }
    if (next <= 0) {
      setCustomQtyMilli(Math.min(activeQtyMilli, 1000));
      setQtyHint(null);
      return;
    }
    setCustomQtyMilli(next);
    setQtyHint(null);
  };

  const goBack = () => {
    if (from === 'list') {
      navigate(resolvedStoreId !== null ? `${BASE}/cart?storeId=${resolvedStoreId}` : `${BASE}/cart`);
      return;
    }
    navigate(BASE, { state: { restoreCatalog: true } });
  };

  const commitPick = (offer: ShopCompareOffer, allowResetOtherStore: boolean) => {
    if (!result || !result.material) return;
    const applied = applyCompareCartSelection(cart, offer, materialSkuIds, activeQtyMilli, result.storeId, allowResetOtherStore);
    if (applied.kind === 'cross_store') {
      setCrossStoreTarget(offer);
      return;
    }
    onSyncStore(result.storeId);
    setCart(applied.cart);
    setMobilePickedSkuId(offer.skuId);
    const unitLabel = result.material.unit;
    const summary = `${offer.supplierName} · ${formatQty(activeQtyMilli)} ${unitLabel}（${formatYuan(offer.totalCents)}）`;
    setLastPickedText(summary);
    if (applied.kind === 'replaced') {
      toast({ tone: 'success', title: `已替换为 ${offer.supplierName}`, body: `清单保留 1 行，含税总成本 ${formatYuan(offer.totalCents)}` });
    } else if (applied.kind === 'updated') {
      toast({ tone: 'success', title: `已更新采购数量（${formatQty(activeQtyMilli)} ${unitLabel}）`, body: `含税总成本 ${formatYuan(offer.totalCents)}` });
    } else {
      toast({ tone: 'success', title: `已加入采购清单（${formatQty(activeQtyMilli)} ${unitLabel}）`, body: `清单共 ${applied.cart.lines.length} 行，可点顶部「查看清单」去结算` });
    }
  };

  const handleChoose = (offer: ShopCompareOffer) => {
    if (!result || !offer.purchasable) return;
    const otherStore = cart.lines.length > 0 && cart.storeId !== null && cart.storeId !== result.storeId;
    if (otherStore) {
      setCrossStoreTarget(offer);
      return;
    }
    if (currentCartLine && currentCartLine.skuId !== offer.skuId) {
      setReplaceTarget(offer);
      return;
    }
    commitPick(offer, false);
  };

  const unit = result?.material?.unit ?? '';
  const category = result?.material?.category || '未分类';
  const recommendedOffer = result?.offers.find((o) => o.skuId === result.recommendedSkuId) ?? null;

  const columns: DataColumn<ShopCompareOffer>[] = [
    {
      key: 'supplier',
      header: '供应商',
      className: 'min-w-[180px]',
      cell: (o) => {
        const adm = ADMISSION_LABEL[o.admission] ?? { text: o.admission || '未准入', tone: 'neutral' as const };
        const isRec = o.skuId === result?.recommendedSkuId;
        const isCur = currentSkuId !== null && o.skuId === currentSkuId;
        return (
          <div className="space-y-1">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className={cn('text-[13.5px] font-bold', o.purchasable ? 'text-ink' : 'text-ink-2')}>{o.supplierName}</span>
              <Badge tone={adm.tone}>{adm.text}</Badge>
              {isRec && (
                <span data-testid={`compare-recommended-${o.skuId}`}>
                  <Badge tone="pine">推荐</Badge>
                </span>
              )}
              {isCur && (
                <span data-testid={`compare-current-${o.skuId}`}>
                  <Badge tone="lake">当前选择</Badge>
                </span>
              )}
            </div>
            <p className="text-[12.5px] text-ink-3">
              {o.skuCode} · V{o.priceVersion}
            </p>
          </div>
        );
      },
    },
    { key: 'price', header: '未税单价', numeric: true, cell: (o) => <span className="text-[13px]">{formatYuan(o.priceCents)}</span> },
    { key: 'tax', header: '税率', numeric: true, cell: (o) => <span className="text-[13px]">{formatTaxRate(o.taxRateBp)}</span> },
    { key: 'gross', header: '含税单价', numeric: true, cell: (o) => <span className="text-[13px] font-semibold">{formatYuan(o.grossCents)}</span> },
    {
      key: 'freight',
      header: '运费（每次）',
      numeric: true,
      cell: (o) => (o.freightCents === 0 ? <Badge tone="pine">包邮</Badge> : <span className="text-[13px]">{formatYuan(o.freightCents)}</span>),
    },
    {
      key: 'moq',
      header: '起订量',
      numeric: true,
      cell: (o) => (
        <span className={cn('text-[13px]', o.blockReason === 'below_moq' && 'font-semibold text-clay')}>
          {formatQty(o.moqMilli)} {unit}
        </span>
      ),
    },
    { key: 'leadDays', header: '交期', numeric: true, cell: (o) => <span className="text-[13px]">{o.leadDays} 天</span> },
    { key: 'arrival', header: '预计到货日', cell: (o) => <span className="text-[13px] whitespace-nowrap">{o.estimatedArrival}</span> },
    {
      key: 'validUntil',
      header: '价格有效至',
      cell: (o) => <span className={cn('text-[13px] whitespace-nowrap', o.blockReason === 'expired' && 'font-semibold text-clay')}>{o.validUntil}</span>,
    },
    {
      key: 'stores',
      header: '适用门店',
      className: 'min-w-[84px] max-w-[160px]',
      cell: (o) => <span className="text-[12.5px] text-ink-2">{o.stores.length ? o.stores.map((s) => s.name).join('、') : <span className="whitespace-nowrap">全部门店</span>}</span>,
    },
    {
      key: 'total',
      header: '含税总成本',
      numeric: true,
      cellTestId: (o) => `compare-total-${o.skuId}`,
      cell: (o) => (
        <div className="space-y-0.5 text-right">
          <p className={cn('text-[14.5px] font-bold', o.purchasable ? 'text-clay' : 'text-ink-2')}>{formatYuan(o.totalCents)}</p>
          <p className="text-[12.5px] text-ink-3">{o.freightCents === 0 ? '包邮' : `含运费 ${formatYuan(o.freightCents)}`}</p>
        </div>
      ),
    },
    {
      key: 'action',
      header: '操作',
      cellTestId: (o) => `compare-status-${o.skuId}`,
      cell: (o) => {
        if (o.purchasable) {
          const isCur = currentCartLine?.skuId === o.skuId;
          const isReplacing = !!currentCartLine && !isCur;
          return (
            <Button size="sm" variant={isCur ? 'secondary' : 'primary'} onClick={() => handleChoose(o)} data-testid={`compare-pick-${o.skuId}`}>
              {isCur ? '更新数量' : isReplacing ? '换这家' : '选这家'}
            </Button>
          );
        }
        return (
          <div className="flex flex-col items-start gap-1">
            <Badge tone={o.blockReason === 'store' ? 'neutral' : 'ember'}>{SHOP_COMPARE_BLOCK_LABELS[o.blockReason!]}</Badge>
            {o.blockReason === 'below_moq' ? (
              <Button size="sm" variant="quiet" onClick={() => setQtyMilli(o.moqMilli)} data-testid={`compare-use-moq-${o.skuId}`}>
                改为 {formatQty(o.moqMilli)} {unit}
              </Button>
            ) : (
              <span className="text-[12.5px] text-ink-3">不可选 · 联系采购</span>
            )}
          </div>
        );
      },
    },
  ];

  // 面包屑与返回：无论加载中、空态还是接口失败都保持可用
  const breadcrumb = (
    <div className="flex flex-wrap items-center justify-between gap-2" data-testid="compare-breadcrumb">
      <nav aria-label="面包屑" className="flex flex-wrap items-center gap-1.5 text-[13px] text-ink-2">
        <button type="button" onClick={goBack} className="tap relative inline-flex items-center gap-1 font-semibold text-ink-2 hover:text-ink" data-testid="compare-back">
          <ArrowLeft className="size-4" />
          {from === 'list' ? '采购清单' : '商城'}
        </button>
        {result?.material && (
          <>
            <ChevronRight className="size-3.5 text-ink-4" aria-hidden />
            <span>{category}</span>
            <ChevronRight className="size-3.5 text-ink-4" aria-hidden />
            <span className="font-semibold text-ink">{result.material.name}</span>
          </>
        )}
      </nav>
      <button type="button" onClick={goBack} className="tap relative text-[13px] font-semibold text-pine hover:underline">
        {from === 'list' ? '返回采购清单' : '返回商品列表'}
      </button>
    </div>
  );

  if (validMaterialId && q.error) {
    return (
      <div className="space-y-4" data-testid="shop-compare-page">
        {breadcrumb}
        <LoadFailed title="比价数据没有取回来" onRetry={() => void q.refetch()} retrying={q.isFetching} testId="compare-error" />
      </div>
    );
  }

  if (validMaterialId && q.isPending && !result) {
    return (
      <div className="space-y-4" data-testid="shop-compare-page">
        {breadcrumb}
        <Card className="space-y-2 p-4" data-testid="compare-skeleton-header">
          <Skeleton className="h-4 w-36" />
          <Skeleton className="h-6 w-64" />
          <Skeleton className="h-4 w-80" />
        </Card>
        <div className="space-y-2" aria-busy="true" data-testid="compare-skeleton-table">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      </div>
    );
  }

  if (!validMaterialId || !result || !result.material || result.offers.length === 0) {
    return (
      <div className="space-y-4" data-testid="shop-compare-page">
        {breadcrumb}
        <Card className="p-4">
          <EmptyState
            art="search"
            title="该物料暂无可用报价"
            description="当前门店下未查到该物料的供应商报价，可提交自主申请由采购寻源报价。"
            testId="compare-empty"
            action={
              <Link to={`${BASE}/custom`}>
                <Button variant="primary" icon={<PencilLine className="size-4" />}>
                  提交自主申请
                </Button>
              </Link>
            }
          />
        </Card>
      </div>
    );
  }

  const purchasableCount = result.offers.filter((o) => o.purchasable).length;
  const oldTotalForReplace = currentOffer ? lineGrossCents(currentOffer.priceCents, currentOffer.taxRateBp, activeQtyMilli, currentOffer.freightCents) : null;

  return (
    <div className="space-y-4 pb-24 md:pb-0" data-testid="shop-compare-page">
      {breadcrumb}

      {lastPickedText && (
        <Notice tone="success" title={`已写入采购清单：${lastPickedText}`} data-testid="compare-added-notice">
          <Link to={`${BASE}/cart?storeId=${result.storeId}`} className="inline-flex items-center gap-1 font-semibold text-pine hover:underline" data-testid="compare-view-cart">
            <ShoppingCart className="size-3.5" />
            查看清单 →
          </Link>
        </Notice>
      )}

      {/* 物料信息头 */}
      <Card className="p-4" data-testid="compare-material-header">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 space-y-1">
            <div className="flex flex-wrap items-center gap-2 text-[12.5px] text-ink-3">
              <Badge tone="neutral">{category}</Badge>
              <span>编码 {result.material.code}</span>
              <span>· 采购单位 {unit}</span>
              <span>· 当前门店 {result.storeName}</span>
            </div>
            <h2 className="text-[19px] font-bold text-ink">{result.material.name}</h2>
            {result.material.specification && <p className="text-[13px] text-ink-2">规格：{result.material.specification}</p>}
            {result.material.note && <p className="text-[12.5px] text-ink-3">{result.material.note}</p>}
          </div>
          <p className="shrink-0 text-[12.5px] text-ink-3" data-testid="compare-updated-at">
            报价数据更新于 {formatDateTime(result.updatedAt)}
          </p>
        </div>
      </Card>

      {/* 数量与成本联动区 */}
      <Card className="p-4" data-testid="compare-qty-bar">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="space-y-1">
            <label htmlFor="compare-qty-input" className="block text-[13.5px] font-bold text-ink">
              按本次采购数量横向比价
            </label>
            <p className="text-[12.5px] text-ink-3">
              修改数量后即时重算各家含税总成本与起订量达成情况（共 {result.offers.length} 条报价，当前数量下 {purchasableCount} 家可采购）。
            </p>
          </div>
          <div className="flex flex-col items-end gap-1">
            <div className="flex items-center gap-1.5">
              <Button size="sm" variant="secondary" aria-label="减少数量" disabled={activeQtyMilli <= 1000} onClick={() => stepQty(-1)} data-testid="compare-qty-minus">
                <Minus className="size-4" />
              </Button>
              <MilliQtyInput
                id="compare-qty-input"
                valueMilli={activeQtyMilli}
                minMilli={1}
                maxMilli={SHOP_MAX_QTY_MILLI}
                decimals={3}
                onChange={setCustomQtyMilli}
                onHint={setQtyHint}
                label={`采购数量（${unit}）`}
                className="h-9 w-28 text-[14px]"
                testId="compare-qty-input"
              />
              <Button size="sm" variant="secondary" aria-label="增加数量" onClick={() => stepQty(1)} data-testid="compare-qty-plus">
                <Plus className="size-4" />
              </Button>
              <span className="text-[13px] font-semibold text-ink-2">{unit}</span>
            </div>
            {qtyHint && (
              <p className="text-[12.5px] font-medium text-clay" role="alert" data-testid="compare-qty-error">
                {qtyHint}
              </p>
            )}
          </div>
        </div>
      </Card>

      {/* 推荐说明（仅解释，不自动选中、不隐藏其他行） */}
      {recommendedOffer && result.recommendReason && (
        <Notice tone="info" title={`推荐参考：${recommendedOffer.supplierName}（含税总成本 ${formatYuan(recommendedOffer.totalCents)}）`} data-testid="compare-recommendation">
          <span className="inline-flex items-center gap-1 text-[13px]">
            <Sparkles className="size-3.5 shrink-0 text-pine" aria-hidden />
            {result.recommendReason}；仅作成本对比参考，不自动选中、不隐藏其他供应商报价。
          </span>
        </Notice>
      )}

      {/* 排序与筛选栏 */}
      <div className="flex flex-wrap items-center justify-between gap-2" data-testid="compare-toolbar">
        <Segmented<ShopCompareSort> size="sm" value={sort} onChange={setSort} ariaLabel="排序方式" options={SORT_OPTIONS} />
        <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="筛选条件">
          <FilterChip active={filters.freeShippingOnly} onClick={() => setFilters((f) => ({ ...f, freeShippingOnly: !f.freeShippingOnly }))} testId="compare-filter-free">
            只看包邮
          </FilterChip>
          <FilterChip active={filters.purchasableOnly} onClick={() => setFilters((f) => ({ ...f, purchasableOnly: !f.purchasableOnly }))} testId="compare-filter-purchasable">
            只看可立即下单
          </FilterChip>
          <FilterChip active={filters.admittedOnly} onClick={() => setFilters((f) => ({ ...f, admittedOnly: !f.admittedOnly }))} testId="compare-filter-admitted">
            只看已准入
          </FilterChip>
        </div>
      </div>

      {/* 筛选后为 0 条 */}
      {visibleOffers.length === 0 ? (
        <Card className="p-4">
          <EmptyState
            art="search"
            title="当前筛选条件下没有报价"
            description="请放宽筛选条件，或修改采购数量查看其他供应商报价。"
            testId="compare-filter-empty"
            action={
              hasFilters ? (
                <Button variant="primary" onClick={() => setFilters({ freeShippingOnly: false, purchasableOnly: false, admittedOnly: false })} data-testid="compare-reset-filters">
                  放宽筛选条件
                </Button>
              ) : undefined
            }
          />
        </Card>
      ) : (
        <>
          {/* 桌面端：完整横向对比表 */}
          <div className="hidden md:block">
            <DataTable
              onPage
              caption={`${result.material.name} 多供应商报价对比表`}
              columns={columns}
              rows={visibleOffers}
              rowKey={(o) => o.skuId}
              rowTestId={(o) => `compare-row-${o.skuId}`}
              rowClassName={(o) => (o.purchasable ? (o.skuId === result.recommendedSkuId ? 'bg-pine/5' : undefined) : 'bg-paper-2/70 text-ink-2')}
              tableClassName="min-w-[1180px]"
              testId="compare-table"
            />
          </div>

          {/* 移动端（375px 无横向滚动）：卡片布局 + 选中高亮 */}
          <ul className="space-y-3 md:hidden" data-testid="compare-mobile-list">
            {visibleOffers.map((o) => {
              const adm = ADMISSION_LABEL[o.admission] ?? { text: o.admission || '未准入', tone: 'neutral' as const };
              const isRec = o.skuId === result.recommendedSkuId;
              const isCur = currentSkuId !== null && o.skuId === currentSkuId;
              const isPicked = o.purchasable && mobilePickedSkuId === o.skuId;
              return (
                <li key={o.skuId}>
                  <Card
                    className={cn('space-y-3 p-4 transition-colors', !o.purchasable && 'bg-paper-2/70 text-ink-2', isPicked && 'border-pine ring-2 ring-pine/20')}
                    data-testid={`compare-card-${o.skuId}`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0 space-y-1">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="text-[14.5px] font-bold text-ink">{o.supplierName}</span>
                          <Badge tone={adm.tone}>{adm.text}</Badge>
                          {isRec && <Badge tone="pine">推荐</Badge>}
                          {isCur && <Badge tone="lake">当前选择</Badge>}
                        </div>
                        <p className="text-[12.5px] text-ink-3">
                          {o.skuCode} · V{o.priceVersion}
                        </p>
                      </div>
                      <div className="shrink-0 text-right">
                        <p className={cn('text-[16px] font-bold', o.purchasable ? 'text-clay' : 'text-ink-2')}>{formatYuan(o.totalCents)}</p>
                        <p className="text-[12.5px] text-ink-3">{o.freightCents === 0 ? '包邮' : `含运费 ${formatYuan(o.freightCents)}`}</p>
                      </div>
                    </div>
                    <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-[12.5px]">
                      <dt className="text-ink-3">未税 / 含税单价</dt>
                      <dd className="text-right text-ink">
                        {formatYuan(o.priceCents)}（税 {formatTaxRate(o.taxRateBp)}）/ {formatYuan(o.grossCents)}
                      </dd>
                      <dt className="text-ink-3">起订量</dt>
                      <dd className={cn('text-right', o.blockReason === 'below_moq' ? 'font-semibold text-clay' : 'text-ink')}>
                        {formatQty(o.moqMilli)} {unit}
                      </dd>
                      <dt className="text-ink-3">交期 / 预计到货</dt>
                      <dd className="text-right text-ink">
                        {o.leadDays} 天 · {o.estimatedArrival}
                      </dd>
                      <dt className="text-ink-3">价格有效至</dt>
                      <dd className="text-right text-ink">{o.validUntil}</dd>
                      <dt className="text-ink-3">适用门店</dt>
                      <dd className="text-right text-ink">{o.stores.length ? o.stores.map((s) => s.name).join('、') : '全部门店'}</dd>
                    </dl>
                    {o.purchasable ? (
                      <Button
                        variant={isPicked ? 'primary' : 'secondary'}
                        className="w-full"
                        onClick={() => setMobilePickedSkuId(o.skuId)}
                        icon={isPicked ? <Check className="size-4" /> : undefined}
                        data-testid={`compare-card-select-${o.skuId}`}
                      >
                        {isPicked ? '已选中该供应商' : '选中此报价'}
                      </Button>
                    ) : (
                      <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
                        <Badge tone={o.blockReason === 'store' ? 'neutral' : 'ember'}>{SHOP_COMPARE_BLOCK_LABELS[o.blockReason!]}</Badge>
                        {o.blockReason === 'below_moq' ? (
                          <Button size="sm" variant="quiet" onClick={() => setQtyMilli(o.moqMilli)}>
                            改为 {formatQty(o.moqMilli)} {unit}
                          </Button>
                        ) : (
                          <span className="text-[12.5px] text-ink-3">不可选 · 联系采购</span>
                        )}
                      </div>
                    )}
                  </Card>
                </li>
              );
            })}
          </ul>
        </>
      )}

      <p className="text-[12.5px] text-ink-3">
        含税总成本 = 向上取整（未税单价 × 数量 ×（1 + 税率））+ 运费（每次采购一笔，不随数量叠加）；与采购清单行金额 0 分误差。提交后需求单行按含税参考单价留存供 ERP
        预估，部门选的供应商为采购意向，最终由采购确认。
      </p>

      {/* 移动端底部固定操作栏 */}
      <div className="fixed inset-x-0 bottom-0 z-30 border-t border-line bg-card/95 px-4 py-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] backdrop-blur md:hidden" data-testid="compare-mobile-bar">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            {mobileSelectedOffer ? (
              <>
                <p className="truncate text-[13px] font-bold text-ink">{mobileSelectedOffer.supplierName}</p>
                <p className="text-[13.5px] font-bold text-clay">{formatYuan(mobileSelectedOffer.totalCents)}</p>
              </>
            ) : (
              <p className="text-[13px] text-ink-3">请选择一家供应商</p>
            )}
          </div>
          <Button
            variant="primary"
            className="min-h-11 px-5"
            disabled={!mobileSelectedOffer}
            onClick={() => mobileSelectedOffer && handleChoose(mobileSelectedOffer)}
            data-testid="compare-mobile-submit"
          >
            {currentCartLine && mobileSelectedOffer && currentCartLine.skuId !== mobileSelectedOffer.skuId ? '换这家' : '选这家'}
          </Button>
        </div>
      </div>

      {/* 替换供应商二次确认弹窗 */}
      <Dialog
        open={replaceTarget !== null}
        onClose={() => setReplaceTarget(null)}
        title="替换采购清单中的供应商"
        width="max-w-md"
        footer={
          <>
            <Button variant="ghost" onClick={() => setReplaceTarget(null)}>
              取消
            </Button>
            <Button
              variant="primary"
              onClick={() => {
                if (replaceTarget) {
                  const target = replaceTarget;
                  setReplaceTarget(null);
                  commitPick(target, false);
                }
              }}
              data-testid="compare-replace-confirm"
            >
              确认替换
            </Button>
          </>
        }
      >
        {replaceTarget && (
          <div className="space-y-3 text-[13px]" data-testid="compare-replace-dialog">
            <p className="text-ink-2">清单中已有「{result.material.name}」的报价，确认后将在原位置替换为新供应商（清单保持 1 行，运费只计一次）。</p>
            <Card className="space-y-2 p-3 text-[13px]">
              <div className="flex justify-between gap-2">
                <span className="text-ink-3">供应商</span>
                <span className="font-semibold text-ink">
                  {currentOffer?.supplierName ?? '原供应商'} → {replaceTarget.supplierName}
                </span>
              </div>
              {currentOffer && (
                <>
                  <div className="flex justify-between gap-2">
                    <span className="text-ink-3">含税单价</span>
                    <span className="text-ink">
                      {formatYuan(currentOffer.grossCents)} → {formatYuan(replaceTarget.grossCents)}
                      <DeltaBadge diff={replaceTarget.grossCents - currentOffer.grossCents} />
                    </span>
                  </div>
                  <div className="flex justify-between gap-2">
                    <span className="text-ink-3">运费（每次）</span>
                    <span className="text-ink">
                      {currentOffer.freightCents === 0 ? '包邮' : formatYuan(currentOffer.freightCents)} → {replaceTarget.freightCents === 0 ? '包邮' : formatYuan(replaceTarget.freightCents)}
                    </span>
                  </div>
                  {oldTotalForReplace !== null && (
                    <div className="flex justify-between gap-2 border-t border-line pt-2 font-bold">
                      <span className="text-ink">
                        按 {formatQty(activeQtyMilli)} {unit} 含税总成本
                      </span>
                      <span className="text-clay">
                        {formatYuan(oldTotalForReplace)} → {formatYuan(replaceTarget.totalCents)}
                        <DeltaBadge diff={replaceTarget.totalCents - oldTotalForReplace} />
                      </span>
                    </div>
                  )}
                </>
              )}
            </Card>
          </div>
        )}
      </Dialog>

      {/* 跨门店清单冲突提示弹窗 */}
      <Dialog
        open={crossStoreTarget !== null}
        onClose={() => setCrossStoreTarget(null)}
        title="采购清单属于另一家门店"
        width="max-w-md"
        footer={
          <>
            <Button variant="ghost" onClick={() => setCrossStoreTarget(null)}>
              取消
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                if (crossStoreTarget) {
                  const target = crossStoreTarget;
                  setCrossStoreTarget(null);
                  commitPick(target, true);
                }
              }}
              data-testid="compare-cross-store-confirm"
            >
              清空原清单并加入
            </Button>
          </>
        }
      >
        <p className="text-[13px] text-ink-2">
          当前采购清单里还有 {cart.lines.length} 行另一家门店的商品，不能混在同一张需求单里提交。继续将清空原清单，并以「{result.storeName}」加入所选报价。
        </p>
      </Dialog>
    </div>
  );
}

function FilterChip({ active, onClick, children, testId }: { active: boolean; onClick: () => void; children: string; testId: string }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        'tap relative inline-flex h-8 items-center rounded-full px-3 text-[12.5px] font-semibold ring-1 transition-colors',
        active ? 'bg-pine text-paper ring-pine' : 'bg-card text-ink-2 ring-line hover:text-ink',
      )}
      data-testid={testId}
    >
      {children}
    </button>
  );
}

function DeltaBadge({ diff }: { diff: number }) {
  if (diff === 0) return <span className="ml-1 text-[12.5px] text-ink-3">（不变）</span>;
  const sign = diff > 0 ? '+' : '-';
  return (
    <span className={cn('ml-1 text-[12.5px] font-semibold', diff > 0 ? 'text-clay' : 'text-pine')}>
      （{sign}
      {formatYuan(Math.abs(diff))}）
    </span>
  );
}
