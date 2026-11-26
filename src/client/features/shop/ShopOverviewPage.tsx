// 采购商城 · 供应链后台总览（批次 E：FR-05 4 统计卡 + 数据关系图 + UX-10 近 7 日增量与点击直达）。

import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { ArrowRight, Bell, Building2, CheckCircle2, ClipboardCheck, Package, ShoppingCart, Sparkles, Tag, Truck } from 'lucide-react';
import type { ShopCatalog, ShopOverview } from '@shared/shop';
import { api } from '../../lib/api';
import { cn } from '../../lib/utils';
import { LoadFailed } from '../../components/LoadFailed';
import { Badge, Button, Card, Notice, Skeleton } from '../../components/ui';

const BASE = '/erp/shop';

const FLOW_STEPS: {
  key: string;
  title: string;
  sub: string;
  to: string;
  icon: ReactNode;
}[] = [
  { key: 'materials', title: '集团物料', sub: '统一编码与单位', to: `${BASE}/materials`, icon: <Package className="size-4" /> },
  { key: 'skus', title: '多供应商 SKU 报价', sub: '含税价 / 运费 / 有效期', to: `${BASE}/skus`, icon: <Tag className="size-4" /> },
  { key: 'cart', title: '采购清单', sub: '比价选供应商并加清单', to: `${BASE}/cart`, icon: <ShoppingCart className="size-4" /> },
  { key: 'requests', title: '采购需求单', sub: '部门发起与需求池汇总', to: `${BASE}/pool`, icon: <ClipboardCheck className="size-4" /> },
  { key: 'erp', title: 'ERP 审批', sub: '主管确认 · 核库 · 采购审', to: '/erp/requests', icon: <CheckCircle2 className="size-4" /> },
  { key: 'po', title: '下单 / 到货', sub: '转采购单并验收回传', to: '/inventory/purchasing', icon: <Truck className="size-4" /> },
];

export function ShopOverviewPage({ catalog }: { catalog: ShopCatalog }) {
  const q = useQuery({
    queryKey: ['shop', 'overview'],
    queryFn: () => api.get<ShopOverview>('/api/erp/shop/overview'),
  });

  if (q.isPending) {
    return (
      <div className="space-y-4" data-testid="shop-overview-loading">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-28 w-full" />
          ))}
        </div>
        <Skeleton className="h-44 w-full" />
      </div>
    );
  }

  if (q.error) {
    return <LoadFailed title="后台总览没有取回来" onRetry={() => void q.refetch()} retrying={q.isFetching} />;
  }

  const d = q.data;
  const isEmptySetup = d.counts.materials === 0 || d.counts.suppliers === 0 || d.counts.activeSkus === 0;

  const cards: {
    key: string;
    label: string;
    value: number;
    sub: string;
    delta: string;
    to: string;
    icon: ReactNode;
    accent?: boolean;
  }[] = [
    {
      key: 'materials',
      label: '集团物料主档',
      value: d.counts.materials,
      sub: `在用 ${d.counts.activeMaterials} 项`,
      delta: `近 7 日 +${d.recent.materialsWeek}`,
      to: `${BASE}/materials`,
      icon: <Package className="size-4 text-pine" />,
    },
    {
      key: 'suppliers',
      label: '供应商档案',
      value: d.counts.suppliers,
      sub: `已准入 ${d.counts.admittedSuppliers} 家`,
      delta: `近 7 日 +${d.recent.suppliersWeek}`,
      to: `${BASE}/suppliers`,
      icon: <Building2 className="size-4 text-pine" />,
    },
    {
      key: 'skus',
      label: '在架 SKU 报价',
      value: d.counts.activeSkus,
      sub: `全部 ${d.counts.totalSkus} 条报价`,
      delta: `近 7 日 +${d.recent.skusWeek}`,
      to: `${BASE}/skus`,
      icon: <Tag className="size-4 text-pine" />,
    },
    {
      key: 'todos',
      label: '供应链待办',
      value: d.counts.totalTodos,
      sub: `SKU ${d.todos.pendingSkus} · 改价 ${d.todos.pendingSkuChanges} · 准入 ${d.todos.pendingSuppliers}`,
      delta: `近 7 日新需求 ${d.recent.requestsWeek} 单`,
      to: d.todos.pendingSkus + d.todos.pendingSkuChanges > 0 ? `${BASE}/skus` : `${BASE}/suppliers`,
      icon: <Bell className={cn('size-4', d.counts.totalTodos > 0 ? 'text-clay' : 'text-pine')} />,
      accent: d.counts.totalTodos > 0,
    },
  ];

  return (
    <div className="space-y-4" data-testid="shop-overview-page">
      {isEmptySetup && (
        <Notice tone="info" title="供应链基础资料尚未建齐，按下面三步即可启用采购商城" data-testid="shop-overview-empty-guide">
          <div className="mt-2 flex flex-wrap items-center gap-2 text-[13px]">
            <span>
              1. 确认物料主档（当前 {d.counts.materials}） → 2. 完成供应商准入（当前已准入 {d.counts.admittedSuppliers}） → 3. 维护并审核上架 SKU（当前在架 {d.counts.activeSkus}）
            </span>
            <Link to={`${BASE}/skus`}>
              <Button size="sm" variant="primary">
                去维护 SKU →
              </Button>
            </Link>
          </div>
        </Notice>
      )}

      {/* 4 张可点击统计卡（UX-10：含近 7 日变化，整卡直达列表） */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" data-testid="shop-overview-cards">
        {cards.map((card) => (
          <Link
            key={card.key}
            to={card.to}
            data-testid={`shop-overview-card-${card.key}`}
            className="mo-lift group flex flex-col justify-between rounded-xl border border-line bg-card p-4 shadow-card hover:border-pine/50"
          >
            <div className="flex items-center justify-between gap-2">
              <span className="text-[13px] font-semibold text-ink-2">{card.label}</span>
              {card.icon}
            </div>
            <p className={cn('mt-2 text-[28px] leading-none font-bold', card.accent ? 'text-clay' : 'text-ink')}>{card.value}</p>
            <div className="mt-3 space-y-0.5 text-[12.5px]">
              <p className="text-ink-2">{card.sub}</p>
              <p className="flex items-center justify-between text-ink-3">
                <span>{card.delta}</span>
                <span className="font-semibold text-pine group-hover:underline">进入 →</span>
              </p>
            </div>
          </Link>
        ))}
      </div>

      {/* 待办明细直达 */}
      <Card className="space-y-3 p-4" data-testid="shop-overview-todos">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-1.5">
            <Sparkles className="size-4 text-pine" aria-hidden />
            <h3 className="text-[14.5px] font-bold text-ink">待办审核明细</h3>
          </div>
          <Badge tone={d.counts.totalTodos > 0 ? 'ember' : 'pine'}>{d.counts.totalTodos > 0 ? `共 ${d.counts.totalTodos} 项待处理` : '当前已清空'}</Badge>
        </div>
        <div className="grid gap-2.5 sm:grid-cols-3">
          <Link to={`${BASE}/skus`} className="flex items-center justify-between rounded-lg border border-line bg-paper-2/40 px-3.5 py-2.5 hover:border-pine/50">
            <div>
              <p className="text-[13px] font-semibold text-ink">待审核上架 SKU</p>
              <p className="text-[12.5px] text-ink-3">采购提报的新报价</p>
            </div>
            <span className={cn('text-[18px] font-bold', d.todos.pendingSkus > 0 ? 'text-clay' : 'text-ink-3')}>{d.todos.pendingSkus}</span>
          </Link>
          <Link to={`${BASE}/skus`} className="flex items-center justify-between rounded-lg border border-line bg-paper-2/40 px-3.5 py-2.5 hover:border-pine/50">
            <div>
              <p className="text-[13px] font-semibold text-ink">改价 / 核心改动待审</p>
              <p className="text-[12.5px] text-ink-3">审核期间 SKU 暂停下单</p>
            </div>
            <span className={cn('text-[18px] font-bold', d.todos.pendingSkuChanges > 0 ? 'text-clay' : 'text-ink-3')}>{d.todos.pendingSkuChanges}</span>
          </Link>
          <Link to={`${BASE}/suppliers`} className="flex items-center justify-between rounded-lg border border-line bg-paper-2/40 px-3.5 py-2.5 hover:border-pine/50">
            <div>
              <p className="text-[13px] font-semibold text-ink">供应商准入待审</p>
              <p className="text-[12.5px] text-ink-3">未准入供应商 SKU 自动拦截</p>
            </div>
            <span className={cn('text-[18px] font-bold', d.todos.pendingSuppliers > 0 ? 'text-clay' : 'text-ink-3')}>{d.todos.pendingSuppliers}</span>
          </Link>
        </div>
      </Card>

      {/* 数据流与业务关系图（每步可点击跳转） */}
      <Card className="space-y-3 p-4" data-testid="shop-overview-flow">
        <div>
          <h3 className="text-[14.5px] font-bold text-ink">采购商城与 ERP 数据流转关系</h3>
          <p className="text-[12.5px] text-ink-3">复用 ERP 同一套物料、供应商与需求单流转引擎；点击任意环节可直达对应页面。</p>
        </div>
        <ol className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-6">
          {FLOW_STEPS.map((step, idx) => {
            const target = step.key === 'requests' && !catalog.me.canPool ? `${BASE}/mine` : step.to;
            return (
              <li key={step.key} className="relative flex items-stretch">
                <Link
                  to={target}
                  data-testid={`shop-flow-step-${step.key}`}
                  className="flex flex-1 flex-col justify-between rounded-lg border border-line bg-paper-2/40 p-3 hover:border-pine/60 hover:bg-card"
                >
                  <div className="flex items-center justify-between gap-1 text-pine">
                    <span className="inline-flex items-center gap-1 text-[12.5px] font-bold">
                      <span>{idx + 1}.</span>
                      {step.icon}
                    </span>
                    {idx < FLOW_STEPS.length - 1 && <ArrowRight className="hidden size-3.5 text-ink-4 lg:inline" aria-hidden />}
                  </div>
                  <p className="mt-2 text-[13.5px] font-bold text-ink">{step.title}</p>
                  <p className="mt-0.5 text-[12.5px] text-ink-3">{step.sub}</p>
                </Link>
              </li>
            );
          })}
        </ol>
      </Card>
    </div>
  );
}
