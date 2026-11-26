// 采购商城 · 采购清单（FR-06 批次 C）：按供应商分组展示与组内小计、起订量达成进度、行内改数量（复用 MilliQtyInput）、
// 批量清空确认、顶部问题汇总与逐条定位；复用 groupShopCart / lineGrossCents 保证与比价页 0 分误差。

import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { AlertTriangle, CheckCircle2, Minus, Plus, Store as StoreIcon, Trash2 } from 'lucide-react';
import { formatYuan } from '@shared/money';
import { formatQty } from '@shared/quantity';
import { formatTaxRate, groupShopCart, SHOP_MAX_QTY_MILLI, type ShopCart, type ShopCatalog } from '@shared/shop';
import { cn } from '../../lib/utils';
import { EmptyState } from '../../components/EmptyState';
import { Dialog } from '../../components/Overlay';
import { MilliQtyInput } from '../../components/QtyInput';
import { Badge, Button, Card, Notice } from '../../components/ui';
import { ProductImage } from './ProductImage';

const BASE = '/erp/shop';

export function ShopCartView({ c, cart, setCart }: { c: ShopCatalog; cart: ShopCart; setCart: (next: ShopCart) => void }) {
  const navigate = useNavigate();
  const [clearOpen, setClearOpen] = useState(false);
  const [focusedSkuId, setFocusedSkuId] = useState<number | null>(null);
  const [hints, setHints] = useState<Record<number, string | null>>({});

  if (!cart.lines.length) {
    return (
      <Card className="p-4">
        <EmptyState
          art="pool"
          title="采购清单是空的"
          description="从商品目录比价选购商品加入清单，再统一提交采购需求单。"
          testId="shop-cart-empty"
          action={
            <Link to={BASE}>
              <Button variant="primary">去选购 →</Button>
            </Link>
          }
        />
      </Card>
    );
  }

  const summary = groupShopCart(c, cart);
  const updateQty = (skuId: number, nextMilli: number) => {
    const safe = Math.max(1, Math.min(SHOP_MAX_QTY_MILLI, Math.round(nextMilli)));
    setCart({ ...cart, lines: cart.lines.map((l) => (l.skuId === skuId ? { ...l, qtyMilli: safe } : l)) });
  };
  const stepQty = (skuId: number, currentMilli: number, deltaUnits: number) => {
    const next = currentMilli + deltaUnits * 1000;
    if (next > SHOP_MAX_QTY_MILLI) {
      updateQty(skuId, SHOP_MAX_QTY_MILLI);
      setHints((h) => ({ ...h, [skuId]: `数量最多 ${formatQty(SHOP_MAX_QTY_MILLI)}，已按上限算` }));
      return;
    }
    if (next <= 0) {
      updateQty(skuId, Math.min(currentMilli, 1000));
      return;
    }
    updateQty(skuId, next);
    setHints((h) => ({ ...h, [skuId]: null }));
  };
  const confirmPrice = (skuIds: readonly number[]) => {
    const set = new Set(skuIds);
    const offerMap = new Map(c.items.flatMap((i) => i.offers).map((o) => [o.skuId, o]));
    setCart({
      ...cart,
      lines: cart.lines.map((l) => {
        if (!set.has(l.skuId)) return l;
        const o = offerMap.get(l.skuId);
        return o && !o.block ? { ...l, priceVersion: o.priceVersion } : l;
      }),
    });
  };
  const locateLine = (skuId: number | null) => {
    if (skuId === null) return;
    setFocusedSkuId(skuId);
    const el = document.querySelector(`[data-testid="shop-cart-line-${skuId}"]`);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };

  const hasIssues = summary.issues.length > 0;
  const disabledReason = !summary.sameStore
    ? '当前清单属于另一家门店，请先切回原门店或清空重选'
    : summary.issues.length > 0
      ? `清单有 ${summary.issues.length} 项待处理问题，处理完成后才能提交`
      : null;

  return (
    <div className="space-y-4" data-testid="shop-cart">
      {/* 顶部集中问题汇总条（逐条可点击定位） */}
      {hasIssues && (
        <Notice tone="warning" title={`清单有 ${summary.issues.length} 项问题需要先处理`} data-testid="shop-cart-issues">
          <ul className="mt-1.5 space-y-1 text-[13px]">
            {summary.issues.map((issue) => (
              <li key={issue.key} className="flex flex-wrap items-center justify-between gap-2">
                <span className="inline-flex items-center gap-1.5">
                  <AlertTriangle className="size-3.5 shrink-0 text-clay" aria-hidden />
                  <strong className="font-semibold text-ink">{issue.label}：</strong>
                  <span>{issue.detail}</span>
                </span>
                {issue.skuId !== null && (
                  <button
                    type="button"
                    onClick={() => locateLine(issue.skuId)}
                    className="tap relative text-[12.5px] font-semibold text-pine hover:underline"
                    data-testid={`shop-cart-locate-${issue.skuId}`}
                  >
                    定位此行 →
                  </button>
                )}
              </li>
            ))}
          </ul>
          {summary.priceChangedSkuIds.length > 1 && (
            <div className="mt-2">
              <Button size="sm" variant="primary" onClick={() => confirmPrice(summary.priceChangedSkuIds)} data-testid="shop-cart-confirm-all-prices">
                全部确认新价（{summary.priceChangedSkuIds.length} 行）
              </Button>
            </div>
          )}
        </Notice>
      )}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_310px]">
        {/* 按供应商分组的清单卡片 */}
        <div className="space-y-3">
          {summary.groups.map((g) => (
            <Card key={g.key} className="overflow-hidden" data-testid={`shop-cart-group-${g.supplierId ?? 'unknown'}`}>
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line bg-paper-2/60 px-4 py-2.5">
                <div className="flex flex-wrap items-center gap-2">
                  <StoreIcon className="size-4 text-pine" aria-hidden />
                  <span className="text-[14px] font-bold text-ink">{g.supplierName}</span>
                  <Badge tone="neutral">{g.rows.length} 行</Badge>
                  <span className="text-[12.5px] text-ink-3">{g.freightCents === 0 ? '包邮' : `运费 ${formatYuan(g.freightCents)}（每次采购一笔）`}</span>
                </div>
                <span className="text-[13.5px] font-bold text-ink" data-testid={`shop-cart-group-subtotal-${g.supplierId ?? 'unknown'}`}>
                  组小计 {formatYuan(g.subtotalCents)}
                </span>
              </div>

              <div className="divide-y divide-line">
                {g.rows.map((r) => (
                  <div key={r.line.skuId} className={cn('space-y-2.5 p-4 transition-colors', focusedSkuId === r.line.skuId && 'bg-yuzu-tint/40')} data-testid={`shop-cart-line-${r.line.skuId}`}>
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      {r.item && <ProductImage imageIds={r.item.material.imageIds} name={r.item.material.name} category={r.item.material.category} className="size-16 shrink-0" rounded="rounded-xl" />}
                      <div className="min-w-0 flex-1 space-y-1">
                        <p className="truncate text-[14.5px] font-bold text-ink">{r.item?.material.name ?? `SKU ${r.line.skuId}`}</p>
                        {r.offer && (
                          <p className="text-[12.5px] text-ink-3">
                            {r.offer.skuCode} · V{r.offer.priceVersion} · 含税 {formatYuan(r.offer.grossCents)} / {r.unit}（税 {formatTaxRate(r.offer.taxRateBp)}）·{' '}
                            {r.freightCents === 0 ? '包邮' : `运费 ${formatYuan(r.freightCents)}`}
                          </p>
                        )}
                        {/* 起订量达成进度 */}
                        {r.offer && (
                          <div className="flex flex-wrap items-center gap-2 pt-0.5" data-testid={`shop-cart-moq-${r.line.skuId}`}>
                            <div className="h-1.5 w-24 overflow-hidden rounded-full bg-paper-2" aria-hidden>
                              <div className={cn('h-full rounded-full transition-all', r.moqReached ? 'bg-pine' : 'bg-clay')} style={{ width: `${r.moqPercent}%` }} />
                            </div>
                            {r.moqReached ? (
                              <span className="inline-flex items-center gap-1 text-[12.5px] font-semibold text-pine">
                                <CheckCircle2 className="size-3.5" aria-hidden />
                                {formatQty(r.line.qtyMilli)} / {formatQty(r.offer.moqMilli)} {r.unit} 已达起订量
                              </span>
                            ) : (
                              <span className="inline-flex flex-wrap items-center gap-1.5 text-[12.5px] font-semibold text-clay">
                                {formatQty(r.line.qtyMilli)} / {formatQty(r.offer.moqMilli)} {r.unit} · 还差 {formatQty(r.moqShortfallMilli)} {r.unit}
                                <Button size="sm" variant="quiet" onClick={() => updateQty(r.line.skuId, r.offer!.moqMilli)} data-testid={`shop-cart-fill-moq-${r.line.skuId}`}>
                                  补足起订量
                                </Button>
                              </span>
                            )}
                          </div>
                        )}
                        {r.problem && <p className="text-[12.5px] font-semibold text-clay">{r.problem}</p>}
                        {hints[r.line.skuId] && (
                          <p className="text-[12.5px] font-medium text-clay" role="alert">
                            {hints[r.line.skuId]}
                          </p>
                        )}
                      </div>

                      <div className="flex flex-wrap items-center gap-2">
                        <div className="flex items-center gap-1">
                          <Button
                            size="sm"
                            variant="secondary"
                            aria-label="减少数量"
                            disabled={r.line.qtyMilli <= 1000}
                            onClick={() => stepQty(r.line.skuId, r.line.qtyMilli, -1)}
                            data-testid={`shop-cart-minus-${r.line.skuId}`}
                          >
                            <Minus className="size-3.5" />
                          </Button>
                          <MilliQtyInput
                            valueMilli={r.line.qtyMilli}
                            minMilli={1}
                            maxMilli={SHOP_MAX_QTY_MILLI}
                            decimals={3}
                            onChange={(nextMilli) => updateQty(r.line.skuId, nextMilli)}
                            onHint={(msg) => setHints((h) => ({ ...h, [r.line.skuId]: msg }))}
                            label={`${r.item?.material.name ?? '商品'} 数量`}
                            className="h-8 w-24 text-[13.5px]"
                            testId={`shop-cart-qty-${r.line.skuId}`}
                          />
                          <Button size="sm" variant="secondary" aria-label="增加数量" onClick={() => stepQty(r.line.skuId, r.line.qtyMilli, 1)} data-testid={`shop-cart-plus-${r.line.skuId}`}>
                            <Plus className="size-3.5" />
                          </Button>
                          {r.unit && <span className="text-[12.5px] text-ink-3">{r.unit}</span>}
                        </div>
                        <span className="w-28 text-right text-[14.5px] font-bold text-ink">{formatYuan(r.totalCents)}</span>
                      </div>
                    </div>

                    <div className="flex flex-wrap items-center justify-end gap-2">
                      {r.offer && r.offer.priceVersion !== r.line.priceVersion && !r.offer.block && (
                        <Button size="sm" variant="primary" onClick={() => confirmPrice([r.line.skuId])} data-testid={`shop-cart-confirm-price-${r.line.skuId}`}>
                          确认新价
                        </Button>
                      )}
                      {r.item && (
                        <Link
                          to={`${BASE}/compare/${r.item.material.id}?from=list&skuId=${r.line.skuId}&qty=${encodeURIComponent(formatQty(r.line.qtyMilli))}&storeId=${c.storeId}`}
                          className="tap relative inline-flex h-8 items-center rounded-sm px-2.5 text-[12.5px] font-semibold text-pine hover:bg-paper-2"
                          data-testid={`shop-cart-switch-${r.line.skuId}`}
                        >
                          换供应商
                        </Link>
                      )}
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setCart({ ...cart, lines: cart.lines.filter((l) => l.skuId !== r.line.skuId) })}
                        data-testid={`shop-cart-remove-${r.line.skuId}`}
                      >
                        移除
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            </Card>
          ))}
        </div>

        {/* 右侧汇总与操作栏 */}
        <Card className="h-fit space-y-2.5 p-4 lg:sticky lg:top-4">
          <div className="flex items-center justify-between">
            <h3 className="text-[14.5px] font-bold text-ink">清单汇总</h3>
            <Button size="sm" variant="ghost" icon={<Trash2 className="size-3.5" />} onClick={() => setClearOpen(true)} data-testid="shop-cart-clear">
              清空清单
            </Button>
          </div>
          <p className="flex justify-between text-[13px]">
            <span className="text-ink-3">供应商 / 商品</span>
            <span>
              {summary.groups.length} 家 · {summary.lineCount} 行
            </span>
          </p>
          <p className="flex justify-between text-[13px]">
            <span className="text-ink-3">货款含税小计</span>
            <span>{formatYuan(summary.goodsCents)}</span>
          </p>
          <p className="flex justify-between text-[13px]">
            <span className="text-ink-3">预计运费合计</span>
            <span>{summary.freightCents === 0 ? '包邮' : formatYuan(summary.freightCents)}</span>
          </p>
          <p className="flex justify-between border-t border-line pt-2 text-[16px] font-bold">
            <span>预计含税总额</span>
            <span className="text-clay" data-testid="shop-cart-total">
              {formatYuan(summary.totalCents)}
            </span>
          </p>
          <p className="text-[12.5px] text-ink-3">预估金额不作为合同或付款依据；采购执行时可能按供应商拆成几张采购单。</p>
          {disabledReason && (
            <p className="text-[12.5px] font-semibold text-clay" data-testid="shop-cart-block-reason">
              {disabledReason}
            </p>
          )}
          <Button variant="primary" className="w-full" disabled={hasIssues} onClick={() => navigate(`${BASE}/checkout`)} data-testid="shop-to-checkout">
            填写采购需求 →
          </Button>
          <Link to={BASE} className="block text-center text-[13px] font-semibold text-pine hover:underline">
            继续添加商品
          </Link>
        </Card>
      </div>

      {/* 批量清空确认弹窗 */}
      <Dialog
        open={clearOpen}
        onClose={() => setClearOpen(false)}
        title="清空采购清单"
        width="max-w-sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setClearOpen(false)}>
              取消
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                setCart({ storeId: null, lines: [] });
                setClearOpen(false);
              }}
              data-testid="shop-cart-clear-confirm"
            >
              确认清空
            </Button>
          </>
        }
      >
        <p className="text-[13px] text-ink-2">确认移除清单里的全部 {cart.lines.length} 行商品？此操作不可撤销。</p>
      </Dialog>
    </div>
  );
}
