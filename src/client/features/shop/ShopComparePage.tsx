// 采购商城 · 多供应商独立比价页（FR-01，批次 A：只读对比，批次 B 补选这家/替换、排序筛选、返回位置恢复与移动端卡片化）。
// 地址：/erp/shop/compare/:materialId?qty=<数量>&from=<catalog|list|request>&skuId=<当前供应商>&storeId=<门店>
// 内嵌在 ERP /erp/shop 路由下，复用现有会话、权限与侧栏；不新建独立服务或独立登录。

import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { ArrowLeft, ChevronRight, Minus, PencilLine, Plus, Sparkles } from 'lucide-react';
import { formatYuan } from '@shared/money';
import { formatQty } from '@shared/quantity';
import {
  buildCompareOffers,
  formatTaxRate,
  resolveCompareQtyMilli,
  SHOP_COMPARE_BLOCK_LABELS,
  SHOP_MAX_QTY_MILLI,
  type ShopCatalog,
  type ShopCompareOffer,
  type ShopCompareResult,
} from '@shared/shop';
import { cn, formatDateTime } from '../../lib/utils';
import { DataTable, type DataColumn } from '../../components/DataTable';
import { EmptyState } from '../../components/EmptyState';
import { LoadFailed } from '../../components/LoadFailed';
import { MilliQtyInput } from '../../components/QtyInput';
import { Badge, Button, Card, Notice, Skeleton } from '../../components/ui';

const BASE = '/erp/shop';

const ADMISSION_LABEL: Record<string, { text: string; tone: 'pine' | 'ember' | 'clay' | 'neutral' }> = {
  approved: { text: '已准入', tone: 'pine' },
  pending: { text: '待准入', tone: 'ember' },
  suspended: { text: '已暂停', tone: 'clay' },
};

export interface ShopComparePageProps {
  materialId: number;
  catalog: ShopCatalog | undefined;
  loading: boolean;
  error: unknown;
  retrying: boolean;
  onRetry: () => void;
  updatedAt: string;
}

const MAX_QTY_LABEL = formatQty(SHOP_MAX_QTY_MILLI);

export function ShopComparePage({ materialId, catalog, loading, error, retrying, onRetry, updatedAt }: ShopComparePageProps) {
  const [searchParams] = useSearchParams();
  const queryQty = searchParams.get('qty');
  const currentSkuId = Number(searchParams.get('skuId')) || null;

  const item = useMemo(() => catalog?.items.find((i) => i.material.id === materialId), [catalog, materialId]);
  const initialQty = useMemo(() => resolveCompareQtyMilli(item, queryQty), [item, queryQty]);

  const [customQtyMilli, setCustomQtyMilli] = useState<number | null>(null);
  const [qtyHint, setQtyHint] = useState<string | null>(() => (initialQty.clamped ? `数量最多 ${MAX_QTY_LABEL}，已按 ${MAX_QTY_LABEL} 算` : null));

  // 切换物料或地址栏 ?qty= 变化时重置手工输入，并对超上限的 URL 参数给出一致提示
  useEffect(() => {
    setCustomQtyMilli(null);
    setQtyHint(initialQty.clamped ? `数量最多 ${MAX_QTY_LABEL}，已按 ${MAX_QTY_LABEL} 算` : null);
  }, [materialId, queryQty, initialQty.clamped]);

  const activeQtyMilli = customQtyMilli ?? initialQty.qtyMilli;

  const result: ShopCompareResult | null = useMemo(() => {
    if (!catalog || !Number.isInteger(materialId) || materialId <= 0) return null;
    return buildCompareOffers(catalog, materialId, activeQtyMilli, updatedAt);
  }, [catalog, materialId, activeQtyMilli, updatedAt]);

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
                <Badge tone="pine" data-testid={`compare-recommended-${o.skuId}`}>
                  推荐
                </Badge>
              )}
              {isCur && <Badge tone="lake">当前选择</Badge>}
            </div>
            <p className="text-[12.5px] text-ink-3">
              {o.skuCode} · V{o.priceVersion}
            </p>
          </div>
        );
      },
    },
    {
      key: 'price',
      header: '未税单价',
      numeric: true,
      cell: (o) => <span className="text-[13px]">{formatYuan(o.priceCents)}</span>,
    },
    {
      key: 'tax',
      header: '税率',
      numeric: true,
      cell: (o) => <span className="text-[13px]">{formatTaxRate(o.taxRateBp)}</span>,
    },
    {
      key: 'gross',
      header: '含税单价',
      numeric: true,
      cell: (o) => <span className="text-[13px] font-semibold">{formatYuan(o.grossCents)}</span>,
    },
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
    {
      key: 'leadDays',
      header: '交期',
      numeric: true,
      cell: (o) => <span className="text-[13px]">{o.leadDays} 天</span>,
    },
    {
      key: 'arrival',
      header: '预计到货日',
      cell: (o) => <span className="text-[13px] whitespace-nowrap">{o.estimatedArrival}</span>,
    },
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
      key: 'status',
      header: '可采购状态',
      cellTestId: (o) => `compare-status-${o.skuId}`,
      cell: (o) =>
        o.purchasable ? (
          <Badge tone="pine">可采购</Badge>
        ) : (
          <div className="flex flex-col items-start gap-1">
            <Badge tone={o.blockReason === 'store' ? 'neutral' : 'ember'}>{SHOP_COMPARE_BLOCK_LABELS[o.blockReason!]}</Badge>
            {o.blockReason === 'below_moq' ? (
              <Button size="sm" variant="quiet" onClick={() => setQtyMilli(o.moqMilli)} data-testid={`compare-use-moq-${o.skuId}`}>
                改为 {formatQty(o.moqMilli)} {unit}
              </Button>
            ) : (
              <span className="text-[12.5px] text-ink-3">不可选 · 联系采购处理</span>
            )}
          </div>
        ),
    },
  ];

  // 面包屑与返回：无论加载中、空态还是接口失败都保持可用
  const breadcrumb = (
    <div className="flex flex-wrap items-center justify-between gap-2" data-testid="compare-breadcrumb">
      <nav aria-label="面包屑" className="flex flex-wrap items-center gap-1.5 text-[13px] text-ink-2">
        <Link to={BASE} className="inline-flex items-center gap-1 font-semibold text-ink-2 hover:text-ink" data-testid="compare-back">
          <ArrowLeft className="size-4" />
          商城
        </Link>
        {result?.material && (
          <>
            <ChevronRight className="size-3.5 text-ink-4" aria-hidden />
            <span>{category}</span>
            <ChevronRight className="size-3.5 text-ink-4" aria-hidden />
            <span className="font-semibold text-ink">{result.material.name}</span>
          </>
        )}
      </nav>
      <Link to={BASE} className="text-[13px] font-semibold text-pine hover:underline">
        返回商品列表
      </Link>
    </div>
  );

  if (error) {
    return (
      <div className="space-y-4" data-testid="shop-compare-page">
        {breadcrumb}
        <LoadFailed title="比价数据没有取回来" onRetry={onRetry} retrying={retrying} testId="compare-error" />
      </div>
    );
  }

  if (loading || !catalog) {
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

  if (!result || !result.material || result.offers.length === 0) {
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

  return (
    <div className="space-y-4" data-testid="shop-compare-page">
      {breadcrumb}

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

      {/* 报价对比表 */}
      <DataTable
        onPage
        caption={`${result.material.name} 多供应商报价对比表`}
        columns={columns}
        rows={result.offers}
        rowKey={(o) => o.skuId}
        rowTestId={(o) => `compare-row-${o.skuId}`}
        rowClassName={(o) => (o.purchasable ? (o.skuId === result.recommendedSkuId ? 'bg-pine/5' : undefined) : 'bg-paper-2/70 text-ink-2')}
        tableClassName="min-w-[1180px]"
        testId="compare-table"
      />

      <p className="text-[12.5px] text-ink-3">
        含税总成本 = 向上取整（未税单价 × 数量 ×（1 + 税率））+ 运费（每次采购一笔，不随数量叠加）；与采购清单行金额 0 分误差。提交后需求单行按含税参考单价留存供 ERP
        预估，部门选的供应商为采购意向，最终由采购确认。
      </p>
    </div>
  );
}
