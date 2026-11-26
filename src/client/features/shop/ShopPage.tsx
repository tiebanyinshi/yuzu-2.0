// 采购商城（8.1.32，店主 2026-11-24：商城模块并进柚子，docs/MALL_V8132.md）。地址 /erp/shop/…：
//   · 首页（目录）/erp/shop：按门店（业态）看能采购的物料，分类、搜索；每样物料写最低含税价与几家可选
//   · 比价 /erp/shop/item/<物料>：这样物料所有供应商的报价，能买的可以填数量加进清单（不低于起订量）
//   · 清单 /erp/shop/cart → 提交 /erp/shop/checkout：业务信息一起填，生成一张采购需求单（来源「商城」）
//   · 自主申请 /erp/shop/custom：商城里没有的，写名称、规格、数量、理由
//   · 我的采购需求 /erp/shop/mine（与 /erp/shop/mine/<单>）；需求池 /erp/shop/pool（采购、库管）；SKU 维护 /erp/shop/skus（采购）
// 清单存在本机（每个账号一份）；提交时服务端按 SKU 重新核对价格版本、能不能买、起订量。
// 提交带操作编号：先在本机记下这一笔再发，结果不确定时可以原样重提、查回或确认作废（AGENTS.md「结果待确认」）。

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, Navigate, useLocation, useNavigate, useParams, useSearchParams } from 'react-router';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft,
  Building2,
  ChevronDown,
  ChevronUp,
  ClipboardList,
  Download,
  Eye,
  GitBranch,
  LayoutDashboard,
  Package,
  PencilLine,
  Search,
  ShoppingCart,
  Store as StoreIcon,
  Warehouse,
  X,
} from 'lucide-react';
import { formatYuan } from '@shared/money';
import { formatQty, parseQty } from '@shared/quantity';
import { MALL_DISPLAY_LABELS, MALL_GROUP_LABELS, MALL_REQUEST_GROUPS, type MallDisplayStatus, type MallRequest, type MallRequestBrief, type MallRequestGroup } from '@shared/mall';
import { MALL_CUSTOM_KIND_LABELS, PAYMENT_INTENT_LABELS, PRIORITY_LABELS, REQUEST_PRIORITIES, type MallPaymentIntent, type RequestPriority } from '@shared/requests';
import {
  buildCompareOffers,
  catalogCardSummary,
  formatTaxRate,
  resolveCompareQtyMilli,
  SHOP_BLOCK_LABELS,
  SHOP_COMPARE_BLOCK_LABELS,
  type ShopCart,
  type ShopCartLine,
  type ShopCatalog,
  type ShopItem,
  type ShopOffer,
  type ShopOverview,
  type ShopRoutePreview,
} from '@shared/shop';
import { api, errorMessage, UncertainError } from '../../lib/api';
import { sendErpOp, useErpRecorded } from '../../lib/erpPending';
import { ErpPendingPanel } from '../../components/ErpPendingPanel';
import { lazyPage } from '../../lib/lazyPage';
import { useSession } from '../../lib/session';
import { cn, formatDateTime, uuid } from '../../lib/utils';
import { EmptyState } from '../../components/EmptyState';
import { LoadFailed } from '../../components/LoadFailed';
import { Dialog } from '../../components/Overlay';
import { useToast } from '../../components/Toast';
import { Badge, Button, Card, Field, Input, Notice, Select, Skeleton, Textarea } from '../../components/ui';
import { ErpPage } from '../erp/ErpHome';
import { PriorityDot } from '../requests/parts';
import { ShopCartView } from './ShopCartView';
import { ProductGallery, ProductImage } from './ProductImage';
import { CustomItemFields, customItemBody, customItemProblem, CustomSpecView, emptyCustomItem, lineDetailsText, ResubmitPanel, SourcingPanel, type CustomItemState } from './ShopPilot';
import { ImageThumbs } from '../../components/Images';
import { SkuAdmin } from './SkuAdmin';

const ShopComparePage = lazyPage(() => import('./ShopComparePage').then((m) => m.ShopComparePage));
const ShopSuppliersPage = lazyPage(() => import('./ShopMasterPages').then((m) => m.ShopSuppliersPage));
const ShopMaterialsPage = lazyPage(() => import('./ShopMasterPages').then((m) => m.ShopMaterialsPage));
const ShopOverviewPage = lazyPage(() => import('./ShopOverviewPage').then((m) => m.ShopOverviewPage));
const ShopCheckoutView = lazyPage(() => import('./ShopCheckoutView').then((m) => m.ShopCheckoutView));

const BASE = '/erp/shop';
const SUBMIT_URL = '/api/erp/shop/requests';
const CATALOG_RESTORE_KEY = 'yuzu.shop.catalogRestore';
const catalogKey = (storeId: number | null) => ['shop', 'catalog', storeId] as const;

// ───────────────────────── 本机的清单与待确认的提交 ─────────────────────────

type CartLine = ShopCartLine;
type Cart = ShopCart;
const memory: Record<string, string> = {};
const store = {
  get(key: string): string | null {
    try {
      return localStorage.getItem(key);
    } catch {
      return memory[key] ?? null;
    }
  },
  set(key: string, value: string | null): boolean {
    try {
      if (value === null) localStorage.removeItem(key);
      else localStorage.setItem(key, value);
      return true;
    } catch {
      if (value === null) delete memory[key];
      else memory[key] = value;
      return false;
    }
  },
};

function useCart() {
  const session = useSession();
  const key = `yuzu.shop.cart.${session.staff.id}`;
  const [cart, setCartState] = useState<Cart>(() => {
    try {
      return (JSON.parse(store.get(key) ?? '') as Cart) ?? { storeId: null, lines: [] };
    } catch {
      return { storeId: null, lines: [] };
    }
  });
  const setCart = (next: Cart) => {
    store.set(key, JSON.stringify(next));
    setCartState(next);
  };
  return { cart, setCart };
}

// ───────────────────────── 外壳 ─────────────────────────

export function ShopPage() {
  const params = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const session = useSession();
  const path = (params['*'] ?? '').replace(/\/+$/, '');
  const rawUrlStore = searchParams.get('storeId');
  const urlStoreId = rawUrlStore && /^[1-9]\d*$/.test(rawUrlStore) ? Number(rawUrlStore) : null;
  const [storeId, setStoreId] = useState<number | null>(null);
  // URL 显式指定了 storeId（比价页分享/浏览器后退）时以 URL 为准，避免被此前目录页切换的本地状态覆盖
  const activeStoreId = urlStoreId ?? storeId;
  const pickStore = (next: number) => {
    setStoreId(next);
    if (searchParams.has('storeId')) {
      const nextParams = new URLSearchParams(searchParams);
      nextParams.set('storeId', String(next));
      setSearchParams(nextParams, { replace: true });
    }
  };
  const q = useQuery({ queryKey: catalogKey(activeStoreId), queryFn: () => api.get<ShopCatalog>(`/api/erp/shop/catalog${activeStoreId ? `?storeId=${activeStoreId}` : ''}`) });
  const qc = useQueryClient();
  const { cart, setCart } = useCart();
  const count = cart.lines.length;
  const c = q.data;
  // 地址栏显式带了已核验的 storeId（例如从比价页进入清单）时同步进持久门店状态，后续跳结算/目录不回退
  useEffect(() => {
    if (urlStoreId !== null && c && c.storeId === urlStoreId) setStoreId(urlStoreId);
  }, [urlStoreId, c]);
  const canAdminView = !!c && (c.me.canManageSku || c.me.canApproveSku);
  const overviewQ = useQuery({
    queryKey: ['shop', 'overview'],
    queryFn: () => api.get<ShopOverview>('/api/erp/shop/overview'),
    enabled: canAdminView,
  });
  const todoCount = overviewQ.data?.counts.totalTodos ?? 0;
  const tabs: { to: string; label: string; icon: ReactNode; show: boolean; badge?: number; testId?: string }[] = [
    { to: BASE, label: '商城', icon: <StoreIcon className="size-4" />, show: true },
    { to: `${BASE}/cart`, label: `采购清单${count ? `（${count}）` : ''}`, icon: <ShoppingCart className="size-4" />, show: true },
    { to: `${BASE}/custom`, label: '自主申请', icon: <PencilLine className="size-4" />, show: true },
    { to: `${BASE}/mine`, label: '我的采购需求', icon: <ClipboardList className="size-4" />, show: true },
    { to: `${BASE}/pool`, label: '需求池', icon: <Warehouse className="size-4" />, show: !!c?.me.canPool },
    { to: `${BASE}/overview`, label: '后台总览', icon: <LayoutDashboard className="size-4" />, show: canAdminView, badge: todoCount, testId: 'shop-tab-overview' },
    { to: `${BASE}/skus`, label: 'SKU 维护', icon: <Warehouse className="size-4" />, show: canAdminView },
    { to: `${BASE}/suppliers`, label: '供应商档案', icon: <Building2 className="size-4" />, show: canAdminView },
    { to: `${BASE}/materials`, label: '物料主档', icon: <Package className="size-4" />, show: canAdminView },
  ];
  const active = (to: string) => (to === BASE ? path === '' || path.startsWith('item') || path.startsWith('compare') : `${BASE}/${path}`.startsWith(to));
  const nav = (
    <nav
      aria-label="采购商城"
      className="scroll-thin mb-4 flex gap-1 overflow-x-auto rounded-full bg-card/70 p-1 ring-1 ring-line/60 shadow-[0_8px_24px_-18px_rgb(28_35_31/0.35)] backdrop-blur-xl"
      data-testid="shop-tabs"
    >
      {tabs
        .filter((t) => t.show)
        .map((t) => (
          <Link
            key={t.to}
            to={t.to}
            data-testid={t.testId}
            className={cn(
              'tap relative inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full px-3.5 text-[13px] font-semibold whitespace-nowrap transition',
              active(t.to) ? 'bg-ink text-paper shadow-[0_6px_16px_-8px_rgb(28_35_31/0.6)]' : 'text-ink-2 hover:bg-paper-2/70 hover:text-ink',
            )}
          >
            {t.icon}
            {t.label}
            {t.badge !== undefined && t.badge > 0 && (
              <span
                className={cn('inline-flex min-w-5 items-center justify-center rounded-full px-1.5 text-[12.5px] leading-5 font-bold', active(t.to) ? 'bg-paper text-pine' : 'bg-clay text-paper')}
                data-testid="shop-todo-badge"
              >
                {t.badge}
              </span>
            )}
          </Link>
        ))}
    </nav>
  );
  const compareSlug = path.startsWith('compare/') ? (path.slice(8).split('/')[0] ?? '') : '';
  const compareMaterialId = /^[1-9]\d*$/.test(compareSlug) ? Number(compareSlug) : 0;
  const updatedAt = q.dataUpdatedAt ? new Date(q.dataUpdatedAt).toISOString() : new Date().toISOString();
  let body: ReactNode;
  if (path.startsWith('compare/')) {
    body = <ShopComparePage materialId={compareMaterialId} storeId={activeStoreId} cart={cart} setCart={setCart} onSyncStore={setStoreId} />;
  } else if (q.isPending) body = <Skeleton className="h-80" />;
  else if (q.error) body = <LoadFailed title="商城没有取回来" onRetry={() => void q.refetch()} retrying={q.isFetching} />;
  else if (path === '') body = <Home c={q.data} setStore={pickStore} updatedAt={updatedAt} />;
  else if (path.startsWith('item/')) body = <ItemPage c={q.data} materialId={Number(path.slice(5))} cart={cart} setCart={setCart} />;
  else if (path === 'cart') body = <ShopCartView c={q.data} cart={cart} setCart={setCart} />;
  else if (path === 'checkout') body = <Checkout c={q.data} cart={cart} setCart={setCart} />;
  else if (path === 'custom') body = <CustomForm c={q.data} />;
  else if (path === 'mine' || path === 'pool') body = <RequestList scope={path} />;
  else if (path.startsWith('mine/') || path.startsWith('pool/')) body = <RequestDetail id={Number(path.split('/')[1])} cart={cart} setCart={setCart} c={q.data} />;
  else if (path === 'overview') body = canAdminView ? <ShopOverviewPage catalog={q.data} /> : <Navigate to={BASE} replace />;
  else if (path === 'skus') body = <SkuAdmin catalog={q.data} />;
  else if (path === 'suppliers') body = canAdminView ? <ShopSuppliersPage catalog={q.data} /> : <Navigate to={BASE} replace />;
  else if (path === 'materials') body = canAdminView ? <ShopMaterialsPage catalog={q.data} /> : <Navigate to={BASE} replace />;
  else body = <Navigate to={BASE} replace />;
  return (
    <ErpPage title="采购商城" description="选品比价、加清单、提采购需求；商城里没有的走自主申请。提交后就是一张采购需求单，主管确认、核库、采购审核照常办。">
      {nav}
      {/* 结果待确认的提交：与 ERP 其他单据同一套（本机先存、读回核对再发；查回、原样重提、确认作废） */}
      <ErpPendingPanel
        types={['purchase_request']}
        // 本机的登记是整个浏览器共用的：只认这个账号自己提的（换人登录不会替别人查回、清别人的清单，Codex 审查）
        filter={(op) => op.url === SUBMIT_URL && op.staffId === session.staff.id}
        onFound={(op, ref) => {
          // 查回或原样重提确认已经登记：清单里这一笔买过的行拿掉（之后又加的留着），免得再提一次重复下单（Codex 审查）
          const body = op.body as { kind?: string; lines?: { skuId: number }[] };
          if (body.kind === 'catalog' && body.lines) {
            const done = new Set(body.lines.map((l) => l.skuId));
            setCart({ ...cart, lines: cart.lines.filter((l) => !done.has(l.skuId)) });
          }
          navigate(`${BASE}/mine/${ref.refId}`);
        }}
        className="mb-4"
      />
      <ErpPendingPanel types={['shop_master']} filter={(op) => op.staffId === session.staff.id} onFound={() => void qc.invalidateQueries({ queryKey: ['shop'] })} className="mb-4" />
      {body}
      {/* 浮在右下角的清单（玻璃质感）：逛的时候随时看得到加了几样；提醒在页面上方，不挡它 */}
      {count > 0 && (path === '' || path.startsWith('item/')) && (
        <Link
          to={`${BASE}/cart`}
          className="tap fixed right-5 bottom-5 z-30 inline-flex h-12 items-center gap-2 rounded-full bg-ink/85 pr-5 pl-4 text-[14px] font-semibold text-paper shadow-[0_18px_40px_-14px_rgb(28_35_31/0.7)] ring-1 ring-white/15 backdrop-blur-xl hover:bg-ink"
          data-testid="shop-fab-cart"
        >
          <ShoppingCart className="size-[18px]" />
          采购清单
          <span className="inline-flex min-w-6 items-center justify-center rounded-full bg-yuzu px-1.5 text-[12.5px] leading-6 font-bold text-on-bright">{count}</span>
        </Link>
      )}
    </ErpPage>
  );
}

// ───────────────────────── 目录 ─────────────────────────

interface CatalogSavedState {
  cat: string | null;
  kw: string;
  scrollTop: number;
  winY: number;
}

function readSavedCatalog(): CatalogSavedState | null {
  try {
    const raw = sessionStorage.getItem(CATALOG_RESTORE_KEY);
    if (!raw) return null;
    sessionStorage.removeItem(CATALOG_RESTORE_KEY);
    return JSON.parse(raw) as CatalogSavedState;
  } catch {
    return null;
  }
}

function Home({ c, setStore, updatedAt }: { c: ShopCatalog; setStore: (id: number) => void; updatedAt: string }) {
  const location = useLocation();
  const rootRef = useRef<HTMLDivElement>(null);
  const restored = useRef<CatalogSavedState | null>(null);
  if (restored.current === null && ((location.state as { restoreCatalog?: boolean } | null)?.restoreCatalog || typeof window !== 'undefined')) {
    const saved = readSavedCatalog();
    if (saved) restored.current = saved;
  }
  const [cat, setCat] = useState<string | null>(() => restored.current?.cat ?? null);
  const [kw, setKw] = useState(() => restored.current?.kw ?? '');
  const [previewItem, setPreviewItem] = useState<ShopItem | null>(null);

  // 返回商品列表时恢复进入比价页前的滚动位置（ERP 主内容区在 <main> 里滚动，同时兼容窗口滚动）
  useEffect(() => {
    const target = restored.current;
    if (!target) return;
    restored.current = null;
    requestAnimationFrame(() => {
      const scroller = rootRef.current?.closest('main');
      if (scroller && target.scrollTop > 0) scroller.scrollTop = target.scrollTop;
      if (target.winY > 0) window.scrollTo(0, target.winY);
    });
  }, []);

  const rememberPosition = () => {
    try {
      const scroller = rootRef.current?.closest('main');
      const payload: CatalogSavedState = { cat, kw, scrollTop: scroller?.scrollTop ?? 0, winY: window.scrollY };
      sessionStorage.setItem(CATALOG_RESTORE_KEY, JSON.stringify(payload));
    } catch {
      // 隐私模式无法写 sessionStorage 时静默降级
    }
  };

  const items = useMemo(() => {
    const k = kw.trim().toLowerCase();
    return c.items.filter(
      (i) => (!cat || (i.material.category || '未分类') === cat) && (!k || `${i.material.name} ${i.material.code} ${i.material.specification} ${i.material.category}`.toLowerCase().includes(k)),
    );
  }, [c.items, cat, kw]);

  const previewCompare = useMemo(() => {
    if (!previewItem) return null;
    const def = resolveCompareQtyMilli(previewItem, null);
    return buildCompareOffers(c, previewItem.material.id, def.qtyMilli, updatedAt);
  }, [c, previewItem, updatedAt]);

  // FR-10 员工侧一次性引导提示（本会话关闭后不再弹出）
  const [dismissed, setDismissed] = useState<Record<string, boolean>>(() => {
    try {
      return JSON.parse(sessionStorage.getItem('yuzu.shop.dismissedNudges') ?? '{}') as Record<string, boolean>;
    } catch {
      return {};
    }
  });
  const dismissNudge = (key: string) => {
    const next = { ...dismissed, [key]: true };
    setDismissed(next);
    try {
      sessionStorage.setItem('yuzu.shop.dismissedNudges', JSON.stringify(next));
    } catch {
      // 隐私模式无法写 sessionStorage 时仅内存中关闭
    }
  };
  const showMissingDeptNudge = !c.me.departmentId && !c.me.canPickDepartment && !dismissed.missing_dept;
  const noOffersKey = `no_offers_${c.storeId}`;
  const showNoOffersNudge = c.items.every((i) => i.purchasable === 0) && !dismissed[noOffersKey];

  return (
    <div ref={rootRef} className="space-y-4" data-testid="shop-home">
      {showMissingDeptNudge && (
        <div className="flex items-start justify-between gap-2 rounded-xl border border-yuzu-deep/30 bg-yuzu-soft/50 px-3.5 py-2.5 text-[13px] text-ink" data-testid="shop-nudge-missing-dept">
          <span>您的员工档案尚未补全所属部门，提交采购需求前请联系店主在员工档案中设置部门。</span>
          <button type="button" onClick={() => dismissNudge('missing_dept')} className="tap relative shrink-0 text-ink-3 hover:text-ink" aria-label="关闭提示">
            <X className="size-4" />
          </button>
        </div>
      )}
      {showNoOffersNudge && (
        <div className="flex items-start justify-between gap-2 rounded-xl border border-line bg-paper-2 px-3.5 py-2.5 text-[13px] text-ink-2" data-testid="shop-nudge-no-offers">
          <span>
            当前门店暂无可直接下单的在架报价，可切换门店或直接
            <Link to={`${BASE}/custom`} className="ml-1 font-semibold text-pine hover:underline">
              发起自主申请 →
            </Link>
          </span>
          <button type="button" onClick={() => dismissNudge(noOffersKey)} className="tap relative shrink-0 text-ink-3 hover:text-ink" aria-label="关闭提示">
            <X className="size-4" />
          </button>
        </div>
      )}
      {/* 首屏（8.1.48，店主：淘宝、得物那样逛高级电商的感觉）：深色渐变底 + 玻璃质感的搜索框与门店，数字说明这家店能买什么 */}
      <section className="relative isolate overflow-hidden rounded-[28px] bg-rail px-5 py-6 text-paper shadow-[0_30px_80px_-40px_rgb(22_38_31/0.8)] sm:px-8 sm:py-8" data-testid="shop-hero">
        <div aria-hidden className="pointer-events-none absolute -top-24 -right-16 -z-10 size-[340px] rounded-full bg-yuzu/35 blur-3xl" />
        <div aria-hidden className="pointer-events-none absolute -bottom-32 left-10 -z-10 size-[300px] rounded-full bg-lake/45 blur-3xl" />
        <div aria-hidden className="pointer-events-none absolute inset-0 -z-10 bg-[linear-gradient(120deg,rgb(255_255_255/0.06),transparent_40%)]" />
        <p className="text-[12px] font-semibold tracking-[0.18em] text-paper/60 uppercase">Yuzu Supply · 采购商城</p>
        <h2 className="mt-2 text-[26px] leading-tight font-bold tracking-tight sm:text-[32px]">挑好东西，比好价格。</h2>
        <p className="mt-1.5 text-[13.5px] text-paper/70" data-testid="shop-hero-stats">
          {c.items.length} 样在架 · {new Set(c.items.flatMap((i) => i.offers.map((o) => o.supplier.id))).size} 家供应商同台比价 · 提交即生成采购需求单
        </p>
        <div className="mt-5 flex flex-wrap items-end gap-2.5">
          <div className="relative min-w-[220px] flex-1">
            <Search className="pointer-events-none absolute top-1/2 left-4 z-10 size-4 -translate-y-1/2 text-paper/70" />
            <input
              value={kw}
              onChange={(e) => setKw(e.target.value)}
              placeholder="搜索物料名称 / 规格 / 编码"
              aria-label="搜索"
              data-testid="shop-search"
              className="h-12 w-full rounded-full bg-white/12 pr-4 pl-11 text-[14.5px] text-paper ring-1 ring-white/25 backdrop-blur-xl outline-none placeholder:text-paper/50 focus:bg-white/18 focus:ring-white/50"
            />
          </div>
          <label className="flex h-12 items-center gap-2 rounded-full bg-white/12 pr-2 pl-4 ring-1 ring-white/25 backdrop-blur-xl" htmlFor="shop-store">
            <span className="text-[12.5px] text-paper/65">门店（业态）</span>
            <select
              id="shop-store"
              value={c.storeId}
              onChange={(e) => setStore(Number(e.target.value))}
              className="h-9 rounded-full bg-transparent pr-2 text-[13.5px] font-semibold text-paper outline-none [&>option]:text-ink"
            >
              {c.stores.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>
        </div>
      </section>

      {/* 分类：玻璃质感的一条，往下翻时贴在上面 */}
      <div className="sticky top-0 z-10 -mx-1 rounded-2xl bg-paper/70 px-1 py-2 ring-1 ring-line/50 backdrop-blur-xl" data-testid="shop-categories">
        <div className="scroll-thin flex gap-1.5 overflow-x-auto px-1">
          <CatChip on={cat === null} onClick={() => setCat(null)}>
            全部（{c.items.length}）
          </CatChip>
          {c.categories.map((x) => (
            <CatChip key={x.name} on={cat === x.name} onClick={() => setCat(x.name)}>
              {x.name}（{x.count}）
            </CatChip>
          ))}
        </div>
      </div>
      {items.length === 0 ? (
        <Card className="p-6 text-center text-[13.5px] text-ink-3">
          没有找到。
          <Link to={`${BASE}/custom`} className="ml-1 font-bold text-pine hover:underline">
            发起自主申请 →
          </Link>
        </Card>
      ) : (
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-4 xl:grid-cols-4 2xl:grid-cols-5" data-testid="shop-items">
          {items.map((i) => {
            const meta = catalogCardSummary(i);
            return (
              <li key={i.material.id}>
                <div className="group flex h-full flex-col overflow-hidden rounded-[22px] bg-card shadow-[0_1px_2px_rgb(28_35_31/0.06),0_12px_32px_-18px_rgb(28_35_31/0.28)] ring-1 ring-line/60 transition duration-300 hover:-translate-y-1 hover:shadow-[0_2px_4px_rgb(28_35_31/0.06),0_28px_48px_-22px_rgb(28_35_31/0.38)]">
                  <Link to={`${BASE}/item/${i.material.id}`} onClick={rememberPosition} className="flex flex-1 flex-col" data-testid={`shop-item-${i.material.id}`}>
                    <div className="relative aspect-square overflow-hidden">
                      <ProductImage
                        imageIds={i.material.imageIds}
                        name={i.material.name}
                        category={i.material.category}
                        rounded="rounded-none"
                        className="size-full transition duration-500 ease-out group-hover:scale-[1.045]"
                      />
                      <span className="absolute top-2.5 left-2.5 rounded-full bg-white/70 px-2.5 py-1 text-[12px] font-semibold text-ink ring-1 ring-white/70 backdrop-blur-md">
                        {i.purchasable} 家比价
                      </span>
                      {meta.hasFreeShipping && <span className="absolute top-2.5 right-2.5 rounded-full bg-pine/85 px-2.5 py-1 text-[12px] font-semibold text-paper backdrop-blur-md">包邮</span>}
                    </div>
                    <div className="flex flex-1 flex-col px-3.5 pt-3">
                      <span className="line-clamp-2 min-h-[38px] text-[14px] leading-[19px] font-semibold text-ink">{i.material.name}</span>
                      <span className="mt-0.5 line-clamp-1 text-[12px] text-ink-3">
                        {i.material.specification || `采购单位：${i.material.unit}`} · {i.material.code}
                      </span>
                      <div className="mt-2 flex items-baseline gap-1">
                        {i.fromGrossCents !== null ? (
                          <>
                            <Price cents={i.fromGrossCents} />
                            <span className="text-[12px] text-ink-3">/ {i.material.unit} 起</span>
                          </>
                        ) : (
                          <span className="text-[13px] font-semibold text-ink-3">暂无可采购价</span>
                        )}
                      </div>
                      <div className="mt-1 flex min-h-[20px] flex-wrap items-center gap-1.5 text-[12px]" data-testid={`shop-card-meta-${i.material.id}`}>
                        {meta.fastestLeadDays !== null ? <span className="text-ink-2">最快 {meta.fastestLeadDays} 天到</span> : <span className="text-ink-3">当前门店暂无可下单报价</span>}
                      </div>
                    </div>
                  </Link>
                  <div className="mt-2.5 flex items-center justify-between gap-2 border-t border-line/60 px-3.5 py-2.5">
                    <button
                      type="button"
                      onClick={() => setPreviewItem(i)}
                      className="tap relative inline-flex items-center gap-1 text-[12px] text-ink-3 hover:text-ink"
                      aria-label={`快捷预览 ${i.material.name} 报价`}
                      data-testid={`shop-preview-btn-${i.material.id}`}
                    >
                      <Eye className="size-3.5" />
                      快捷预览
                    </button>
                    <Link
                      to={`${BASE}/compare/${i.material.id}?from=catalog&storeId=${c.storeId}`}
                      onClick={rememberPosition}
                      className="tap relative inline-flex items-center text-[12.5px] font-semibold text-pine hover:underline"
                      data-testid={`shop-compare-link-${i.material.id}`}
                    >
                      {i.purchasable} 家可选 →
                    </Link>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      <Card className="flex flex-wrap items-center justify-between gap-3 p-4">
        <span className="text-[13px] text-ink-2">没有找到你要的？写清名称、规格、数量和理由，采购同事寻源报价。</span>
        <Link to={`${BASE}/custom`}>
          <Button icon={<PencilLine className="size-4" />}>自主申请</Button>
        </Link>
      </Card>

      {/* 卡片快捷只读预览（UX-02：仅预览报价摘要，不提供选供应商操作，正式比价进入独立比价页） */}
      <Dialog
        open={previewItem !== null}
        onClose={() => setPreviewItem(null)}
        title={previewItem ? `${previewItem.material.name} · 报价快捷预览` : '报价快捷预览'}
        width="max-w-lg"
        footer={
          previewItem && (
            <>
              <Button variant="ghost" onClick={() => setPreviewItem(null)}>
                关闭
              </Button>
              <Link
                to={`${BASE}/compare/${previewItem.material.id}?from=catalog&storeId=${c.storeId}`}
                onClick={() => {
                  rememberPosition();
                  setPreviewItem(null);
                }}
              >
                <Button variant="primary" data-testid="shop-preview-to-compare">
                  进入独立比价页 →
                </Button>
              </Link>
            </>
          )
        }
      >
        {previewCompare && previewItem && (
          <div className="space-y-2.5 text-[13px]" data-testid="shop-quick-preview">
            <p className="text-[12.5px] text-ink-3">
              只读快捷预览（按 {formatQty(previewCompare.qtyMilli)} {previewItem.material.unit} 试算）；完整横向比价与选供应商请进入独立比价页。
            </p>
            <ul className="divide-y divide-line rounded-lg border border-line">
              {previewCompare.offers.slice(0, 5).map((o) => (
                <li key={o.skuId} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2.5">
                  <div className="min-w-0">
                    <p className="truncate font-semibold text-ink">{o.supplierName}</p>
                    <p className="text-[12.5px] text-ink-3">
                      含税 {formatYuan(o.grossCents)}/{previewItem.material.unit}（税 {formatTaxRate(o.taxRateBp)}）· {o.freightCents === 0 ? '包邮' : `运费 ${formatYuan(o.freightCents)}`} · 交期{' '}
                      {o.leadDays} 天
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="font-bold text-clay">{formatYuan(o.totalCents)}</p>
                    <Badge tone={o.purchasable ? 'pine' : 'ember'}>{o.purchasable ? '可采购' : SHOP_COMPARE_BLOCK_LABELS[o.blockReason!]}</Badge>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )}
      </Dialog>
    </div>
  );
}

function CatChip({ on, onClick, children }: { on: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'tap relative h-9 shrink-0 rounded-full px-4 text-[13px] font-semibold whitespace-nowrap transition',
        on ? 'bg-ink text-paper shadow-[0_6px_16px_-8px_rgb(28_35_31/0.6)]' : 'bg-card/80 text-ink-2 ring-1 ring-line/70 hover:bg-card hover:text-ink',
      )}
    >
      {children}
    </button>
  );
}

/** 价格：¥ 小一号、数字大（电商的写法）；读出来与 formatYuan 一样 */
function Price({ cents, size = 'md' }: { cents: number; size?: 'md' | 'lg' }) {
  const text = formatYuan(cents);
  const neg = text.startsWith('-');
  const body = text.replace(/^-?¥/, '');
  const [int, dec] = body.split('.');
  return (
    <span className={cn('font-bold tracking-tight text-clay tabular-nums', size === 'lg' ? 'text-[30px] leading-none' : 'text-[20px] leading-tight')}>
      <span className={size === 'lg' ? 'text-[17px]' : 'text-[13px]'}>{neg ? '-' : ''}¥</span>
      {int}
      {dec !== undefined && <span className={size === 'lg' ? 'text-[18px]' : 'text-[14px]'}>.{dec}</span>}
    </span>
  );
}

function OfferFacts({ o, unit }: { o: ShopOffer; unit: string }) {
  return (
    <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-[12.5px]">
      <dt className="text-ink-3">未税单价</dt>
      <dd className="text-right">
        {formatYuan(o.priceCents)}（税 {formatTaxRate(o.taxRateBp)}）
      </dd>
      <dt className="text-ink-3">起订量</dt>
      <dd className="text-right">
        {formatQty(o.moqMilli)} {unit}
      </dd>
      <dt className="text-ink-3">交期</dt>
      <dd className="text-right">约 {o.leadDays} 天</dd>
      <dt className="text-ink-3">运费</dt>
      <dd className="text-right">{o.freightCents ? `${formatYuan(o.freightCents)} / 每次采购` : '包邮'}</dd>
      <dt className="text-ink-3">价格有效至</dt>
      <dd className="text-right">{o.validUntil}</dd>
      <dt className="text-ink-3">适用门店</dt>
      <dd className="text-right">{o.stores.length ? o.stores.map((s) => s.name).join('、') : '全部'}</dd>
    </dl>
  );
}

function ItemPage({ c, materialId, cart, setCart }: { c: ShopCatalog; materialId: number; cart: Cart; setCart: (c: Cart) => void }) {
  const toast = useToast();
  const item = c.items.find((i) => i.material.id === materialId);
  const [qty, setQty] = useState<Record<number, string>>({});
  if (!item) return <Notice tone="info" title="这样物料现在没有报价" />;
  const add = (o: ShopOffer) => {
    const milli = parseQty(qty[o.skuId] ?? formatQty(o.moqMilli));
    if (milli === null || milli < o.moqMilli) {
      toast({ tone: 'error', title: `数量不能低于起订量 ${formatQty(o.moqMilli)} ${item.material.unit}` });
      return;
    }
    // 清单按门店算：换了门店的清单先清空
    const base = cart.storeId === c.storeId ? cart.lines : [];
    const has = base.find((l) => l.skuId === o.skuId);
    const lines = has
      ? base.map((l) => (l.skuId === o.skuId ? { ...l, qtyMilli: l.qtyMilli + milli, priceVersion: o.priceVersion } : l))
      : [...base, { skuId: o.skuId, priceVersion: o.priceVersion, qtyMilli: milli }];
    setCart({ storeId: c.storeId, lines });
    toast({ tone: 'success', title: `已加入采购清单（${formatQty(milli)} ${item.material.unit}）`, body: `清单里共 ${lines.length} 行` });
  };
  return (
    <div className="space-y-4" data-testid="shop-item-page">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Link to={BASE} className="inline-flex items-center gap-1 text-[13px] font-semibold text-ink-2 hover:text-ink">
          <ArrowLeft className="size-4" /> 返回商品列表
        </Link>
        <Link to={`${BASE}/compare/${item.material.id}?from=catalog&storeId=${c.storeId}`} className="text-[13px] font-semibold text-pine hover:underline">
          横向比价表 →
        </Link>
      </div>
      {/* 商品页（8.1.48）：左边大图、右边名字与最低价，下面是各家报价 */}
      <section
        className="grid gap-5 rounded-[28px] bg-card p-4 ring-1 ring-line/60 shadow-[0_20px_60px_-36px_rgb(28_35_31/0.4)] sm:p-6 md:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]"
        data-testid="shop-item-hero"
      >
        <ProductGallery imageIds={item.material.imageIds} name={item.material.name} category={item.material.category} />
        <div className="flex min-w-0 flex-col">
          <p className="text-[12.5px] font-semibold tracking-wide text-ink-3">
            {item.material.category || '未分类'} · {item.material.code}
          </p>
          <h2 className="mt-1 text-[24px] leading-tight font-bold tracking-tight text-ink sm:text-[28px]">{item.material.name}</h2>
          <p className="mt-1.5 text-[13.5px] text-ink-2">
            {item.material.specification} · 单位 {item.material.unit}
          </p>
          {item.material.note && <p className="mt-1 text-[12.5px] text-ink-3">{item.material.note}</p>}
          <div className="mt-5 rounded-2xl bg-gradient-to-br from-clay-soft/70 via-paper-2/60 to-yuzu-tint p-4 ring-1 ring-white/60">
            <p className="text-[12px] text-ink-3">可采购最低含税价</p>
            <div className="mt-1 flex items-baseline gap-1.5">
              {item.fromGrossCents !== null ? (
                <>
                  <Price cents={item.fromGrossCents} size="lg" />
                  <span className="text-[13px] text-ink-3">/ {item.material.unit} 起</span>
                </>
              ) : (
                <span className="text-[15px] font-semibold text-ink-3">暂无可采购价</span>
              )}
            </div>
            <p className="mt-2 text-[12.5px] text-ink-2">
              {item.offers.length} 条报价 · {item.purchasable} 家可选 · 门店 {c.stores.find((s) => s.id === c.storeId)?.name}
            </p>
          </div>
          <div className="mt-auto flex flex-wrap gap-2 pt-5">
            <Link to={`${BASE}/compare/${item.material.id}?from=catalog&storeId=${c.storeId}`}>
              <Button variant="primary">横向比价、选供应商</Button>
            </Link>
            <a href="#shop-offers">
              <Button variant="secondary">看各家报价</Button>
            </a>
          </div>
        </div>
      </section>
      <p id="shop-offers" className="scroll-mt-20 text-[13px] font-bold text-ink-2">
        供应商比选：{item.offers.length} 条报价，{item.purchasable} 条可选（门店：{c.stores.find((s) => s.id === c.storeId)?.name}）
      </p>
      <ul className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
        {item.offers.map((o) => (
          <li key={o.skuId}>
            <Card className={cn('flex h-full flex-col gap-3 rounded-[20px] p-4 ring-1 ring-line/60', o.block && 'opacity-70')} data-testid={`shop-offer-${o.skuId}`}>
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate text-[14.5px] font-bold text-ink">{o.supplier.name}</p>
                  <p className="text-[12.5px] text-ink-3">
                    {o.skuCode} · V{o.priceVersion}
                  </p>
                </div>
                <Badge tone={o.block ? (o.block === 'store' ? 'neutral' : 'ember') : 'pine'}>{o.block ? SHOP_BLOCK_LABELS[o.block] : '可采购'}</Badge>
              </div>
              <p>
                <Price cents={o.grossCents} />
                <span className="text-[12.5px] font-normal text-ink-3"> / {item.material.unit}（含税）</span>
              </p>
              <OfferFacts o={o} unit={item.material.unit} />
              <div className="mt-auto flex items-end gap-2">
                <Field label={`数量（${item.material.unit}）`} htmlFor={`shop-qty-${o.skuId}`}>
                  <Input
                    id={`shop-qty-${o.skuId}`}
                    inputMode="decimal"
                    disabled={!!o.block}
                    value={qty[o.skuId] ?? formatQty(o.moqMilli)}
                    onChange={(e) => setQty({ ...qty, [o.skuId]: e.target.value })}
                    className="w-28"
                  />
                </Field>
                <Button variant="primary" disabled={!!o.block} onClick={() => add(o)} data-testid={`shop-add-${o.skuId}`}>
                  加入清单
                </Button>
              </div>
            </Card>
          </li>
        ))}
      </ul>
      <p className="text-[12.5px] text-ink-3">部门选的供应商是采购意向，最终由采购确认；只能选已上架、价格没过期、适用这家门店、没有改价在审核的报价。</p>
    </div>
  );
}

// ───────────────────────── 提交 ─────────────────────────

interface HeaderForm {
  departmentId: string;
  entityId: string;
  contactName: string;
  budgetProject: string;
  needBy: string;
  deliveryAddress: string;
  paymentIntent: MallPaymentIntent;
  priority: RequestPriority;
  note: string;
  purpose: string;
}

const PRIORITY_HINT: Record<RequestPriority, string> = {
  urgent: '希望尽快采购（不跳过主管确认；正式的紧急采购仍按规定特批）',
  high: '有明确时间要求，请优先安排',
  normal: '按正常采购周期',
};

function HeaderFields({ c, f, set }: { c: ShopCatalog; f: HeaderForm; set: (f: HeaderForm) => void }) {
  const session = useSession();
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {c.me.canPickDepartment ? (
        <Field label="申请部门" htmlFor="shop-dept">
          <Select id="shop-dept" value={f.departmentId} onChange={(e) => set({ ...f, departmentId: e.target.value })}>
            <option value="">请选择</option>
            {c.departments.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </Select>
        </Field>
      ) : (
        <Field label="申请部门" hint={c.me.departmentId ? undefined : '请店主在员工档案里补上所属部门，补上之前提交不了'}>
          <Input value={c.me.departmentName ?? '（员工档案里还没填所属部门）'} disabled />
        </Field>
      )}
      <Field label="经办人" htmlFor="shop-contact" hint="部门共用账号时写实际经办的人">
        <Input id="shop-contact" value={f.contactName} maxLength={40} onChange={(e) => set({ ...f, contactName: e.target.value })} placeholder={session.staff.displayName} />
      </Field>
      <Field label="费用承担主体" htmlFor="shop-entity">
        <Select id="shop-entity" value={f.entityId} onChange={(e) => set({ ...f, entityId: e.target.value })}>
          <option value="">请选择</option>
          {c.entities.map((e) => (
            <option key={e.id} value={e.id}>
              {e.name}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="预算项目 / 费用归属" htmlFor="shop-budget">
        <Input id="shop-budget" value={f.budgetProject} maxLength={80} onChange={(e) => set({ ...f, budgetProject: e.target.value })} placeholder="例如：布草消耗预算" />
      </Field>
      <Field label="期望到货日期" htmlFor="shop-needby">
        <Input id="shop-needby" type="date" min={c.today} value={f.needBy} onChange={(e) => set({ ...f, needBy: e.target.value })} />
      </Field>
      <Field label="收货地点" htmlFor="shop-address">
        <Input id="shop-address" value={f.deliveryAddress} maxLength={120} onChange={(e) => set({ ...f, deliveryAddress: e.target.value })} placeholder="例如：本店布草仓" />
      </Field>
      <Field label="用途" htmlFor="shop-purpose">
        <Select id="shop-purpose" value={f.purpose} onChange={(e) => set({ ...f, purpose: e.target.value })}>
          {c.purposes.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="拟定支付方式" htmlFor="shop-pay">
        <Select id="shop-pay" value={f.paymentIntent} onChange={(e) => set({ ...f, paymentIntent: e.target.value as MallPaymentIntent })}>
          {(Object.keys(PAYMENT_INTENT_LABELS) as MallPaymentIntent[]).map((k) => (
            <option key={k} value={k}>
              {PAYMENT_INTENT_LABELS[k]}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="紧急程度" hint={PRIORITY_HINT[f.priority]} className="sm:col-span-2">
        <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="紧急程度">
          {REQUEST_PRIORITIES.map((p) => (
            <button
              key={p}
              type="button"
              role="radio"
              aria-checked={f.priority === p}
              title={PRIORITY_HINT[p]}
              onClick={() => set({ ...f, priority: p })}
              className={cn(
                'tap relative inline-flex h-10 items-center gap-2 rounded-lg border bg-card px-3.5 text-[13px] font-semibold transition-colors',
                f.priority === p ? 'border-ink text-ink ring-2 ring-ink/15' : 'border-line text-ink-2 hover:border-ink-3 hover:text-ink',
              )}
              data-testid={`shop-priority-${p}`}
            >
              <PriorityDot priority={p} />
              {PRIORITY_LABELS[p]}
            </button>
          ))}
        </div>
      </Field>
      <Field label="用途与补充说明" htmlFor="shop-note" className="sm:col-span-2">
        <Textarea id="shop-note" rows={2} maxLength={500} value={f.note} onChange={(e) => set({ ...f, note: e.target.value })} />
      </Field>
    </div>
  );
}

const emptyHeader = (c: ShopCatalog): HeaderForm => ({
  departmentId: c.me.departmentId ? String(c.me.departmentId) : '',
  entityId: String(c.stores.find((s) => s.id === c.storeId)?.entityId ?? ''),
  contactName: '',
  budgetProject: '',
  needBy: '',
  deliveryAddress: '',
  paymentIntent: 'company_direct',
  priority: 'normal',
  note: '',
  purpose: c.purposes.includes('其他') ? '其他' : (c.purposes[0] ?? ''),
});

function headerBody(c: ShopCatalog, f: HeaderForm, fallbackName: string) {
  return {
    storeId: c.storeId,
    departmentId: f.departmentId ? Number(f.departmentId) : null,
    entityId: Number(f.entityId),
    contactName: f.contactName.trim() || fallbackName,
    budgetProject: f.budgetProject.trim(),
    needBy: f.needBy,
    deliveryAddress: f.deliveryAddress.trim(),
    paymentIntent: f.paymentIntent,
    priority: f.priority,
    note: f.note.trim(),
    purpose: f.purpose,
  };
}
const headerMissing = (f: HeaderForm) => !f.departmentId || !f.entityId || !f.budgetProject.trim() || !f.needBy || !f.deliveryAddress.trim();

/** 提交：先在本机记下编号与内容再发；记不下就不发；明确被拒的清掉本机记录，结果不确定的留着（上面的提示条里处理） */
function useSubmit(onDone: (r: MallRequest) => void) {
  const session = useSession();
  const toast = useToast();
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  // 上一笔结果还没确认（超时、断网、服务器出错；含刷新页面以后）：不许用新编号再提一笔，先在页面顶部查回、原样重提或确认作废（Codex 审查）
  const recorded = useErpRecorded(['purchase_request']).filter((op) => op.url === SUBMIT_URL && op.staffId === session.staff.id);
  const blocked = recorded.length > 0;
  const send = async (body: Record<string, unknown>, summary: string) => {
    if (blocked) {
      toast({ tone: 'error', title: '上一次提交还没确认结果', body: '先在页面顶部查回、原样重提或确认作废，再提新的' });
      return;
    }
    setBusy(true);
    try {
      // 每次提交新的操作编号；本机记不下（读回核对不上）就不发，结果不明的留在页面顶部按原编号处理
      const clientKey = uuid();
      const r = await sendErpOp<{ request: MallRequest }>({
        key: clientKey,
        type: 'purchase_request',
        url: SUBMIT_URL,
        body: { ...body, clientKey },
        summary: `采购商城 · ${summary}`,
        staffName: session.staff.displayName,
        staffId: session.staff.id,
      });
      void qc.invalidateQueries({ queryKey: ['shop'] });
      toast({ tone: 'success', title: `已提交：${r.request.docNo}`, body: '采购需求单已生成，等部门主管确认' });
      onDone(r.request);
    } catch (e) {
      if (e instanceof UncertainError) toast({ tone: 'info', title: '结果待确认', body: '在页面顶部查回、原样重提或确认作废，不要重新填一张' });
      else toast({ tone: 'error', title: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };
  return { send, busy, blocked };
}

const ROUTE_STATUS_BADGE: Record<ShopRoutePreview['nodes'][number]['status'], { label: string; tone: 'pine' | 'ember' | 'clay' | 'neutral' }> = {
  active: { label: '需流转', tone: 'pine' },
  auto: { label: '自动确认', tone: 'pine' },
  skipped: { label: '跳过', tone: 'neutral' },
  blocked: { label: '需补全', tone: 'clay' },
};

/** FR-02 提交前审批路由预览（可折叠，服务端实时计算，接口异常时降级静态说明且永不阻塞提交） */
function RoutePreviewCard({
  storeId,
  departmentId,
  paymentIntent,
  priority,
  kind,
  lines,
}: {
  storeId: number;
  departmentId: string;
  paymentIntent: MallPaymentIntent;
  priority: RequestPriority;
  kind: 'catalog' | 'custom';
  lines: readonly ShopCartLine[];
}) {
  const [open, setOpen] = useState(true);
  const lineParam = useMemo(() => (kind === 'catalog' ? lines.map((l) => `${l.skuId}:${l.qtyMilli}`).join(',') : ''), [kind, lines]);
  const url = useMemo(() => {
    const qs = new URLSearchParams({
      storeId: String(storeId),
      paymentIntent,
      priority,
      kind,
    });
    if (departmentId && /^[1-9]\d*$/.test(departmentId)) qs.set('departmentId', departmentId);
    if (lineParam) qs.set('lines', lineParam);
    return `/api/erp/shop/route-preview?${qs.toString()}`;
  }, [storeId, departmentId, paymentIntent, priority, kind, lineParam]);

  const q = useQuery({
    queryKey: ['shop', 'route-preview', url],
    queryFn: () => api.get<ShopRoutePreview>(url),
    retry: false,
  });

  return (
    <Card className="p-4" data-testid="shop-route-preview">
      <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} className="flex w-full items-center justify-between gap-2 text-left" data-testid="shop-route-preview-toggle">
        <span className="inline-flex items-center gap-1.5 text-[14px] font-bold text-ink">
          <GitBranch className="size-4 text-pine" aria-hidden />
          审批路由预览（预计流转，以 ERP 实际核验为准）
        </span>
        <span className="inline-flex items-center gap-1 text-[12.5px] font-semibold text-ink-3">
          {open ? '收起' : '展开'}
          {open ? <ChevronUp className="size-4" /> : <ChevronDown className="size-4" />}
        </span>
      </button>

      {open && (
        <div className="mt-3 space-y-3">
          {q.isPending ? (
            <div className="space-y-2">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-8 w-3/4" />
            </div>
          ) : q.error || !q.data ? (
            <div className="space-y-2 rounded-lg border border-line bg-paper-2/50 p-3 text-[12.5px] text-ink-2" data-testid="shop-route-preview-fallback">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-semibold text-ink">路由预览暂未取回（不影响直接提交）</span>
                <Button size="sm" variant="ghost" onClick={() => void q.refetch()}>
                  重试
                </Button>
              </div>
              <p>预计流转：部门主管确认 → 核库 → 采购审核 → 下单 → 到货。</p>
              <p className="text-ink-3">同日同供应商累计、采购日累计 3 万元分流与备用金额度由 ERP 核验；紧急程度仅用于排序，不构成紧急特批。</p>
            </div>
          ) : (
            <>
              <ol className="grid gap-2 sm:grid-cols-5" aria-label="预计审批节点" data-testid="shop-route-preview-nodes">
                {q.data.nodes.map((node, idx) => {
                  const st = ROUTE_STATUS_BADGE[node.status];
                  return (
                    <li
                      key={node.key}
                      data-testid={`shop-route-node-${node.key}`}
                      className={cn(
                        'rounded-lg border px-2.5 py-2 text-[12.5px]',
                        node.status === 'skipped' ? 'border-line bg-paper-2/40 text-ink-3' : node.status === 'blocked' ? 'border-clay/50 bg-clay-soft/20' : 'border-pine/30 bg-card',
                      )}
                    >
                      <div className="flex items-center justify-between gap-1">
                        <span className="font-bold text-ink">
                          {idx + 1}. {node.label}
                        </span>
                        <Badge tone={st.tone}>{st.label}</Badge>
                      </div>
                      <p className="mt-1 truncate text-ink-2" title={node.role}>
                        {node.role}
                      </p>
                    </li>
                  );
                })}
              </ol>

              {q.data.hasUnpriced && (
                <div className="rounded-lg border border-line bg-paper-2/60 px-3 py-2 text-[12.5px] font-semibold text-ink" data-testid="shop-route-unpriced">
                  待寻源，金额待定
                </div>
              )}

              <ul className="space-y-1 text-[12.5px]" data-testid="shop-route-preview-hints">
                {q.data.hints.map((h) => (
                  <li key={`${h.code}-${h.text.slice(0, 12)}`} className={cn('flex items-start gap-1.5', h.tone === 'warning' ? 'font-semibold text-clay' : 'text-ink-2')}>
                    <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-current" aria-hidden />
                    <span>{h.text}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
    </Card>
  );
}

function Checkout({ c, cart, setCart }: { c: ShopCatalog; cart: Cart; setCart: (c: Cart) => void }) {
  const session = useSession();
  const navigate = useNavigate();
  // 提交成功先跳到这张单，再清清单：清单一空本页会跳回清单页，用 submitted 拦住，不跟跳转抢
  const [submitted, setSubmitted] = useState(false);
  const { send, busy, blocked } = useSubmit((r) => {
    setSubmitted(true);
    navigate(`${BASE}/mine/${r.id}`);
    setCart({ storeId: null, lines: [] });
  });
  return (
    <ShopCheckoutView
      c={c}
      cart={cart}
      staffId={session.staff.id}
      staffDisplayName={session.staff.displayName}
      busy={busy}
      blocked={blocked}
      submitted={submitted}
      onSubmit={(body, summaryText) => void send(body, summaryText)}
      renderRoutePreview={(f) => <RoutePreviewCard storeId={c.storeId} departmentId={f.departmentId} paymentIntent={f.paymentIntent} priority={f.priority} kind="catalog" lines={cart.lines} />}
    />
  );
}

function CustomForm({ c }: { c: ShopCatalog }) {
  const session = useSession();
  const navigate = useNavigate();
  const [f, setF] = useState<HeaderForm>(() => emptyHeader(c));
  // 8.1.49：先选非定制还是定制，两种要填的不一样（ShopPilot.tsx）
  const [item, setItem] = useState<CustomItemState>(emptyCustomItem);
  const [uploading, setUploading] = useState(false);
  const { send, busy, blocked } = useSubmit((r) => navigate(`${BASE}/mine/${r.id}`));
  const problem = customItemProblem(item);
  const missing = !!problem || blocked || uploading || headerMissing(f);
  return (
    <div className="space-y-4" data-testid="shop-custom">
      <Card className="p-4">
        <p className="mb-3 text-[14px] font-bold">① 要采购什么</p>
        <CustomItemFields s={item} set={setItem} categories={c.categories.map((x) => x.name)} onUploading={setUploading} />
      </Card>
      <Card className="p-4">
        <p className="mb-3 text-[14px] font-bold">② 部门与交付</p>
        <HeaderFields c={c} f={f} set={setF} />
      </Card>
      <RoutePreviewCard storeId={c.storeId} departmentId={f.departmentId} paymentIntent={f.paymentIntent} priority={f.priority} kind="custom" lines={[]} />
      <div className="flex items-center justify-end gap-3">
        {problem && <span className="text-[12.5px] text-ink-3">{problem}</span>}
        <Button
          variant="primary"
          loading={busy}
          disabled={missing}
          onClick={() =>
            void send({ ...headerBody(c, f, session.staff.displayName), kind: 'custom', line: customItemBody(item) }, `自主申请（${MALL_CUSTOM_KIND_LABELS[item.kind]}）· ${item.name.trim()}`)
          }
          data-testid="shop-custom-submit"
        >
          提交{MALL_CUSTOM_KIND_LABELS[item.kind]}申请
        </Button>
      </div>
    </div>
  );
}

// ───────────────────────── 我的需求与需求池 ─────────────────────────

const DISPLAY_TONE: Partial<Record<MallDisplayStatus, 'pine' | 'ember' | 'clay' | 'neutral' | 'lake'>> = {
  dept_pending: 'ember',
  stock_check: 'ember',
  stock_confirming: 'ember',
  reviewing: 'lake',
  returned: 'clay',
  rejected: 'clay',
  cancelled: 'neutral',
  received: 'pine',
  issued: 'pine',
};

function RequestList({ scope }: { scope: 'mine' | 'pool' }) {
  const session = useSession();
  // 需求池按接单人筛（8.1.49）：全部 / 待接单 / 我接的（在已取回的里筛）
  const [owner, setOwner] = useState<'' | 'none' | 'mine'>('');
  const [priority, setPriority] = useState<RequestPriority | ''>('');
  const [group, setGroup] = useState<MallRequestGroup | ''>('');
  const [kw, setKw] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');

  const filterParams = useMemo(() => {
    const qs = new URLSearchParams({ scope });
    if (priority) qs.set('priority', priority);
    if (group) qs.set('group', group);
    if (kw.trim()) qs.set('q', kw.trim());
    if (from) qs.set('from', from);
    if (to) qs.set('to', to);
    return qs.toString();
  }, [scope, priority, group, kw, from, to]);

  const dateBad = !!from && !!to && from > to;

  // 一页 50 张，从新到旧；状态分组、紧急程度、关键词与日期范围均在服务端先筛再分页（FR-08）
  const q = useInfiniteQuery({
    queryKey: ['shop', 'requests', filterParams],
    initialPageParam: null as number | null,
    enabled: !dateBad,
    queryFn: ({ pageParam }) => api.get<{ requests: MallRequestBrief[]; nextBeforeId: number | null }>(`/api/erp/shop/requests?${filterParams}${pageParam ? `&beforeId=${pageParam}` : ''}`),
    getNextPageParam: (last) => last.nextBeforeId,
  });

  const exportHref = `/api/erp/shop/requests/export?${filterParams}`;
  const list = (q.data?.pages.flatMap((p) => p.requests) ?? []).filter((r) => (owner === 'none' ? !r.sourcingOwner : owner === 'mine' ? r.sourcingOwner?.id === session.staff.id : true));
  const hasFilter = !!(priority || group || kw.trim() || from || to);

  return (
    <div className="space-y-3" data-testid={`shop-${scope}`}>
      {/* 状态分组筛选（FR-08：把现有 13 态归成 4 组，不自造状态） */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap gap-1.5" data-testid="shop-req-groups">
          <CatChip on={group === ''} onClick={() => setGroup('')}>
            全部状态
          </CatChip>
          {MALL_REQUEST_GROUPS.map((g) => (
            <button
              key={g}
              type="button"
              onClick={() => setGroup(g)}
              data-testid={`shop-req-group-${g}`}
              className={cn('tap relative h-8 rounded-full px-3 text-[12.5px] font-semibold', group === g ? 'bg-ink text-paper' : 'bg-card text-ink-2 ring-1 ring-line hover:text-ink')}
            >
              {MALL_GROUP_LABELS[g]}
            </button>
          ))}
        </div>
        <a
          href={dateBad ? undefined : exportHref}
          download
          aria-disabled={dateBad}
          onClick={(e) => {
            if (dateBad) e.preventDefault();
          }}
          className={cn(
            'tap relative inline-flex h-9 items-center gap-1.5 rounded-md border border-line-strong bg-card px-3 text-[13px] font-semibold text-ink hover:bg-paper',
            dateBad && 'pointer-events-none opacity-50',
          )}
          data-testid="shop-req-export"
        >
          <Download className="size-4" />
          导出表格
        </a>
      </div>

      {/* 关键词、日期范围与紧急程度 */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[200px] flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-4" />
          <Input value={kw} onChange={(e) => setKw(e.target.value)} placeholder="搜索单号 / 品名 / 预算项目" className="h-9 pl-9" aria-label="搜索需求单" data-testid="shop-req-search" />
        </div>
        <Select aria-label="紧急程度" value={priority} onChange={(e) => setPriority(e.target.value as RequestPriority | '')} fullWidth={false} className="h-9">
          <option value="">全部紧急程度</option>
          {REQUEST_PRIORITIES.map((p) => (
            <option key={p} value={p}>
              {PRIORITY_LABELS[p]}
            </option>
          ))}
        </Select>
        <div className="flex flex-wrap items-center gap-1.5 text-[12.5px] text-ink-3">
          <Input type="date" aria-label="开始日期" value={from} onChange={(e) => setFrom(e.target.value)} className="h-9 w-36" data-testid="shop-req-from" />
          <span>至</span>
          <Input type="date" aria-label="结束日期" value={to} onChange={(e) => setTo(e.target.value)} className="h-9 w-36" data-testid="shop-req-to" />
        </div>
        {hasFilter && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setPriority('');
              setGroup('');
              setKw('');
              setFrom('');
              setTo('');
            }}
            data-testid="shop-req-reset"
          >
            重置筛选
          </Button>
        )}
      </div>

      {scope === 'pool' && (
        <div className="flex flex-wrap gap-1.5" data-testid="shop-pool-owner">
          {(
            [
              ['', '全部'],
              ['none', '待接单'],
              ['mine', '我接的'],
            ] as const
          ).map(([k, label]) => (
            <CatChip key={k} on={owner === k} onClick={() => setOwner(k)}>
              {label}
            </CatChip>
          ))}
        </div>
      )}
      <p className="text-[12.5px] text-ink-3">
        {scope === 'pool' ? '商城来的全部需求单：点进去接单、记成交方案（微信上谈好的供应商、价格、交期）；审核、退回、转采购单在 ERP「采购需求单」里办' : '本部门、自己提的、自己当主管的'}
      </p>

      {dateBad ? (
        <Notice tone="warning" title="开始日期不能晚于结束日期" />
      ) : q.isPending ? (
        <div className="space-y-2.5" data-testid="shop-req-skeleton">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-16 w-full" />
          ))}
        </div>
      ) : q.error ? (
        <LoadFailed title="需求没有取回来" onRetry={() => void q.refetch()} retrying={q.isFetching} />
      ) : list.length === 0 ? (
        <Card className="p-4">
          <EmptyState
            art="search"
            title={q.hasNextPage ? '最近批次内暂未匹配到该筛选条件的单据' : hasFilter ? '当前筛选条件下没有采购需求' : '还没有采购需求单'}
            description={q.hasNextPage ? '还有更早的记录未扫完，可点击下方「加载更早的」继续查找。' : hasFilter ? '放宽状态、日期或关键词条件再看看。' : '去商城选购商品或发起自主申请。'}
            action={
              q.hasNextPage ? (
                <Button size="sm" variant="primary" loading={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>
                  继续查找更早记录
                </Button>
              ) : hasFilter ? (
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => {
                    setPriority('');
                    setGroup('');
                    setKw('');
                    setFrom('');
                    setTo('');
                  }}
                >
                  清空筛选
                </Button>
              ) : (
                <Link to={BASE}>
                  <Button size="sm" variant="primary">
                    去选购 →
                  </Button>
                </Link>
              )
            }
          />
        </Card>
      ) : (
        <Card className="divide-y divide-line">
          {list.map((r) => (
            <Link key={r.id} to={`${BASE}/${scope}/${r.id}`} className="flex flex-wrap items-center gap-3 px-4 py-3 hover:bg-paper-2" data-testid={`shop-req-${r.id}`}>
              <PriorityDot priority={r.priority} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13.5px] font-semibold text-ink">{r.summary || '—'}</span>
                <span className="text-[12.5px] text-ink-3">
                  {r.docNo} · {r.department.name} · {formatDateTime(r.createdAt)}
                </span>
              </span>
              {scope === 'pool' && (
                <span className={cn('text-[12px]', r.sourcingOwner ? 'text-ink-2' : 'font-semibold text-ember-deep')} data-testid={`shop-req-owner-${r.id}`}>
                  {r.sourcingOwner ? `${r.sourcingOwner.name} 跟进` : '待接单'}
                </span>
              )}
              <Badge tone={DISPLAY_TONE[r.displayStatus] ?? 'neutral'}>{r.displayLabel}</Badge>
            </Link>
          ))}
        </Card>
      )}
      {q.hasNextPage && (
        <div className="text-center">
          <Button size="sm" loading={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()} data-testid={`shop-${scope}-more`}>
            加载更早的
          </Button>
        </div>
      )}
    </div>
  );
}

function RequestDetail({ id, cart, setCart, c }: { id: number; cart: Cart; setCart: (c: Cart) => void; c: ShopCatalog }) {
  const toast = useToast();
  const navigate = useNavigate();
  const qc = useQueryClient();
  // 接单、记方案、确认方案、补资料以后：用服务端返回的整张单换掉缓存，列表一起刷新
  const replace = (next: MallRequest) => {
    qc.setQueryData(['shop', 'request', id], next);
    void qc.invalidateQueries({ queryKey: ['shop', 'requests'] });
  };
  const q = useQuery({ queryKey: ['shop', 'request', id], queryFn: () => api.get<MallRequest>(`/api/erp/shop/requests/${id}`) });
  if (q.isPending) {
    return (
      <div className="space-y-3">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-24 w-full" />
        ))}
      </div>
    );
  }
  if (q.error) return <LoadFailed title="需求单没有取回来" onRetry={() => void q.refetch()} retrying={q.isFetching} />;
  const r = q.data;
  const ended = ['returned', 'rejected', 'cancelled'].includes(r.displayStatus);
  // 按原单再提：选品的行按 SKU 编码找回现在的报价加进清单（找不到、不能买的跳过并提示）
  const reorder = () => {
    const lines: CartLine[] = [];
    let skipped = 0;
    for (const l of r.lines) {
      const offer = c.items.flatMap((i) => i.offers).find((o) => o.skuCode === l.skuCode && !o.block);
      if (offer) lines.push({ skuId: offer.skuId, priceVersion: offer.priceVersion, qtyMilli: Math.max(l.qtyMilli, offer.moqMilli) });
      else skipped += 1;
    }
    if (!lines.length) {
      toast({ tone: 'error', title: '这张单的商品现在都买不了（或是自主申请）：请重新选购或自主申请' });
      return;
    }
    setCart({ storeId: c.storeId, lines: cart.storeId === c.storeId ? [...cart.lines.filter((x) => !lines.some((y) => y.skuId === x.skuId)), ...lines] : lines });
    toast({ tone: 'success', title: `已按原单加进清单（${lines.length} 行）`, body: skipped ? `${skipped} 行现在买不了，没加` : undefined });
    navigate(`${BASE}/cart`);
  };
  return (
    <div className="space-y-4" data-testid="shop-request-detail">
      <Link to={`${BASE}/mine`} className="inline-flex items-center gap-1 text-[13px] font-semibold text-ink-2 hover:text-ink">
        <ArrowLeft className="size-4" /> 返回我的采购需求
      </Link>

      {/* FR-08：退回 / 不采购 / 撤回原因置顶展示 */}
      {r.reason && ended && !r.can.resubmit && (
        <Notice tone={r.displayStatus === 'returned' ? 'warning' : 'info'} title={`${MALL_DISPLAY_LABELS[r.displayStatus]}：${r.reason}`} data-testid="shop-request-reason" />
      )}
      {/* 退回的（8.1.49）：在原单上补资料、重新提交 */}
      {r.can.resubmit && <ResubmitPanel r={r} categories={c.categories.map((x) => x.name)} onDone={replace} />}

      <Card className="space-y-3 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[17px] font-bold">{r.docNo}</span>
          <Badge tone={DISPLAY_TONE[r.displayStatus] ?? 'neutral'}>{MALL_DISPLAY_LABELS[r.displayStatus]}</Badge>
          <PriorityDot priority={r.priority} />
          <span className="text-[12.5px] text-ink-2">{PRIORITY_LABELS[r.priority]}</span>
          <span className="ml-auto text-[12.5px] text-ink-3">进度更新于 {formatDateTime(r.progressUpdatedAt)}</span>
        </div>

        {/* FR-08：每节点真实时间与操作人（均来自服务端 timeline，不前端推算） */}
        <ol className="grid gap-2 sm:grid-cols-5" aria-label="进度" data-testid="shop-request-timeline">
          {r.timeline.map((step, i) => (
            <li
              key={step.key}
              data-testid={`shop-timeline-${step.key}`}
              className={cn('rounded-lg border px-2.5 py-2 text-[12.5px]', step.done ? 'border-pine/40 bg-pine-soft/40 text-ink' : 'border-line bg-paper-2/50 text-ink-3')}
            >
              <p className="font-bold">
                {i + 1}. {step.label}
              </p>
              <p className="mt-0.5 truncate text-ink-2">{step.actorName ?? (step.done ? '已完成' : '待处理')}</p>
              <p className="text-ink-3">{step.at ? formatDateTime(step.at) : '—'}</p>
            </li>
          ))}
        </ol>

        <dl className="grid gap-x-4 gap-y-1 text-[13px] sm:grid-cols-3">
          <Info k="部门" v={r.department.name} />
          <Info k="经办人" v={r.contactName || r.requester.name} />
          <Info k="门店" v={r.store?.name ?? '—'} />
          <Info k="费用主体" v={r.entity?.name ?? '—'} />
          <Info k="预算项目" v={r.budgetProject || '—'} />
          <Info k="期望到货" v={r.needBy ?? '—'} />
          <Info k="收货地点" v={r.deliveryAddress || '—'} />
          <Info k="拟定支付" v={r.paymentIntent ? PAYMENT_INTENT_LABELS[r.paymentIntent] : '—'} />
          <Info k="主管确认" v={r.deptConfirm.state === 'pending' ? `等 ${r.deptConfirm.headName ?? '主管'}` : r.deptConfirm.state === 'confirmed' ? '已确认' : '不用'} />
        </dl>
      </Card>
      <Card className="divide-y divide-line">
        {r.lines.map((l) => (
          <div key={l.id} className="space-y-1 p-4 text-[13px]">
            <p className="flex flex-wrap justify-between gap-2">
              <span className="font-bold text-ink">{l.name}</span>
              <span>
                {formatQty(l.qtyMilli)} {l.unit}
                {l.refPriceCents !== null && ` · 预估 ${formatYuan(l.refPriceCents)} / ${l.unit}`}
              </span>
            </p>
            <p className="text-[12.5px] text-ink-3">
              {[
                l.supplier && `意向供应商：${l.supplier.name}`,
                l.skuCode && `${l.skuCode}（${l.priceVersion}）`,
                l.brandModel && `型号：${l.brandModel}`,
                lineDetailsText(l),
                l.reasonText && `理由：${l.reasonText}`,
              ]
                .filter(Boolean)
                .join(' · ')}
            </p>
            <CustomSpecView l={l} />
            {l.imageIds.length > 0 && <ImageThumbs images={l.imageIds.map((i) => ({ id: i, url: `/api/erp/images/${i}` }))} className="mt-1.5" />}
            {l.link && (
              <a href={l.link} target="_blank" rel="noreferrer noopener" className="text-[12.5px] font-semibold text-lake hover:underline">
                打开参考链接 ↗
              </a>
            )}
            <p className="text-[12.5px] text-ink-2">
              进度：{MALL_LINE_LABELS[l.progress.state]}
              {l.progress.poNo && ` · 采购单 ${l.progress.poNo}（${l.progress.supplierName}）`}
              {l.progress.receivedMilli > 0 && ` · 合格入库 ${formatQty(l.progress.receivedMilli)}`}
              {l.progress.rejectedMilli > 0 && ` · 拒收 ${formatQty(l.progress.rejectedMilli)}`}
              {l.progress.redeliverMilli > 0 && `（其中待补 ${formatQty(l.progress.redeliverMilli)}）`}
              {l.progress.inventoryUnit && (l.progress.receivedMilli > 0 || l.progress.rejectedMilli > 0) && ` ${l.progress.inventoryUnit}`}
            </p>
          </div>
        ))}
      </Card>
      {/* 接单与成交方案（8.1.49） */}
      <SourcingPanel r={r} onChange={replace} />
      <div className="flex flex-wrap justify-end gap-2">
        {ended && r.lines.some((l) => l.skuCode) && (
          <Button variant="primary" onClick={reorder} data-testid="shop-reorder">
            按原单再提
          </Button>
        )}
        <Link to={`/erp/requests?request=${r.id}`}>
          <Button variant="ghost">在 ERP 里看这张需求单</Button>
        </Link>
      </div>
      {!ended && r.displayStatus !== 'received' && <p className="text-right text-[12.5px] text-ink-3">要撤回请在 ERP「采购需求单」里打开这张单；被退回的在这里「在原单补资料」。</p>}
    </div>
  );
}

const MALL_LINE_LABELS: Record<MallRequest['lines'][number]['progress']['state'], string> = {
  none: '未下单',
  sourcing: '询价中',
  ordered: '已下单',
  partial: '部分到货',
  received: '已到货',
  closed: '采购单已关闭',
  issued: '已从库存领用',
};

function Info({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex gap-2">
      <dt className="shrink-0 text-ink-3">{k}</dt>
      <dd className="min-w-0 truncate text-ink">{v}</dd>
    </div>
  );
}
