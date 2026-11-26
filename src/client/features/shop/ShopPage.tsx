// 采购商城（8.1.32，店主 2026-11-24：商城模块并进柚子，docs/MALL_V8132.md）。地址 /erp/shop/…：
//   · 首页（目录）/erp/shop：按门店（业态）看能采购的物料，分类、搜索；每样物料写最低含税价与几家可选
//   · 比价 /erp/shop/item/<物料>：这样物料所有供应商的报价，能买的可以填数量加进清单（不低于起订量）
//   · 清单 /erp/shop/cart → 提交 /erp/shop/checkout：业务信息一起填，生成一张采购需求单（来源「商城」）
//   · 自主申请 /erp/shop/custom：商城里没有的，写名称、规格、数量、理由
//   · 我的采购需求 /erp/shop/mine（与 /erp/shop/mine/<单>）；需求池 /erp/shop/pool（采购、库管）；SKU 维护 /erp/shop/skus（采购）
// 清单存在本机（每个账号一份）；提交时服务端按 SKU 重新核对价格版本、能不能买、起订量。
// 提交带操作编号：先在本机记下这一笔再发，结果不确定时可以原样重提、查回或确认作废（AGENTS.md「结果待确认」）。

import { useMemo, useState, type ReactNode } from 'react';
import { Link, Navigate, useNavigate, useParams, useSearchParams } from 'react-router';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, ClipboardList, PencilLine, Search, ShoppingCart, Store as StoreIcon, Warehouse } from 'lucide-react';
import { formatYuan } from '@shared/money';
import { formatQty, parseQty } from '@shared/quantity';
import { MALL_DISPLAY_LABELS, type MallDisplayStatus, type MallRequest, type MallRequestBrief } from '@shared/mall';
import { PAYMENT_INTENT_LABELS, PRIORITY_LABELS, REQUEST_PRIORITIES, type MallPaymentIntent, type RequestPriority } from '@shared/requests';
import { lineGrossCents, SHOP_BLOCK_LABELS, SHOP_CUSTOM_UNITS, type ShopCatalog, type ShopItem, type ShopOffer } from '@shared/shop';
import { api, errorMessage, UncertainError } from '../../lib/api';
import { sendErpOp, useErpRecorded } from '../../lib/erpPending';
import { ErpPendingPanel } from '../../components/ErpPendingPanel';
import { lazyPage } from '../../lib/lazyPage';
import { useSession } from '../../lib/session';
import { cn, formatDateTime, uuid } from '../../lib/utils';
import { LoadFailed } from '../../components/LoadFailed';
import { useToast } from '../../components/Toast';
import { Badge, Button, Card, Field, Input, Notice, Select, Skeleton, Textarea } from '../../components/ui';
import { ErpPage } from '../erp/ErpHome';
import { PriorityDot } from '../requests/parts';
import { SkuAdmin } from './SkuAdmin';

const ShopComparePage = lazyPage(() => import('./ShopComparePage').then((m) => m.ShopComparePage));

const BASE = '/erp/shop';
const SUBMIT_URL = '/api/erp/shop/requests';
const catalogKey = (storeId: number | null) => ['shop', 'catalog', storeId] as const;

// ───────────────────────── 本机的清单与待确认的提交 ─────────────────────────

interface CartLine {
  skuId: number;
  priceVersion: number;
  qtyMilli: number;
}
interface Cart {
  storeId: number | null;
  lines: CartLine[];
}
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
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const session = useSession();
  const path = (params['*'] ?? '').replace(/\/+$/, '');
  const rawUrlStore = searchParams.get('storeId');
  const urlStoreId = rawUrlStore && /^[1-9]\d*$/.test(rawUrlStore) ? Number(rawUrlStore) : null;
  const [storeId, setStoreId] = useState<number | null>(null);
  const activeStoreId = storeId ?? urlStoreId;
  const q = useQuery({ queryKey: catalogKey(activeStoreId), queryFn: () => api.get<ShopCatalog>(`/api/erp/shop/catalog${activeStoreId ? `?storeId=${activeStoreId}` : ''}`) });
  const { cart, setCart } = useCart();
  const count = cart.lines.length;
  const c = q.data;
  const tabs: { to: string; label: string; icon: ReactNode; show: boolean }[] = [
    { to: BASE, label: '商城', icon: <StoreIcon className="size-4" />, show: true },
    { to: `${BASE}/cart`, label: `采购清单${count ? `（${count}）` : ''}`, icon: <ShoppingCart className="size-4" />, show: true },
    { to: `${BASE}/custom`, label: '自主申请', icon: <PencilLine className="size-4" />, show: true },
    { to: `${BASE}/mine`, label: '我的采购需求', icon: <ClipboardList className="size-4" />, show: true },
    { to: `${BASE}/pool`, label: '需求池', icon: <Warehouse className="size-4" />, show: !!c?.me.canPool },
    { to: `${BASE}/skus`, label: 'SKU 维护', icon: <Warehouse className="size-4" />, show: !!c && (c.me.canManageSku || c.me.canApproveSku) },
  ];
  const active = (to: string) => (to === BASE ? path === '' || path.startsWith('item') || path.startsWith('compare') : `${BASE}/${path}`.startsWith(to));
  const nav = (
    <nav aria-label="采购商城" className="mb-4 flex flex-wrap gap-1.5" data-testid="shop-tabs">
      {tabs
        .filter((t) => t.show)
        .map((t) => (
          <Link
            key={t.to}
            to={t.to}
            className={cn(
              'tap relative inline-flex h-9 items-center gap-1.5 rounded-full px-3.5 text-[13px] font-semibold',
              active(t.to) ? 'bg-pine text-paper' : 'bg-card text-ink-2 ring-1 ring-line hover:text-ink',
            )}
          >
            {t.icon}
            {t.label}
          </Link>
        ))}
    </nav>
  );
  const compareSlug = path.startsWith('compare/') ? (path.slice(8).split('/')[0] ?? '') : '';
  const compareMaterialId = /^[1-9]\d*$/.test(compareSlug) ? Number(compareSlug) : 0;
  const updatedAt = q.dataUpdatedAt ? new Date(q.dataUpdatedAt).toISOString() : new Date().toISOString();
  let body: ReactNode;
  if (path.startsWith('compare/')) {
    body = <ShopComparePage materialId={compareMaterialId} catalog={q.data} loading={q.isPending} error={q.error} retrying={q.isFetching} onRetry={() => void q.refetch()} updatedAt={updatedAt} />;
  } else if (q.isPending) body = <Skeleton className="h-80" />;
  else if (q.error) body = <LoadFailed title="商城没有取回来" onRetry={() => void q.refetch()} retrying={q.isFetching} />;
  else if (path === '') body = <Home c={q.data} setStore={setStoreId} />;
  else if (path.startsWith('item/')) body = <ItemPage c={q.data} materialId={Number(path.slice(5))} cart={cart} setCart={setCart} />;
  else if (path === 'cart') body = <CartPage c={q.data} cart={cart} setCart={setCart} />;
  else if (path === 'checkout') body = <Checkout c={q.data} cart={cart} setCart={setCart} />;
  else if (path === 'custom') body = <CustomForm c={q.data} />;
  else if (path === 'mine' || path === 'pool') body = <RequestList scope={path} />;
  else if (path.startsWith('mine/') || path.startsWith('pool/')) body = <RequestDetail id={Number(path.split('/')[1])} cart={cart} setCart={setCart} c={q.data} />;
  else if (path === 'skus') body = <SkuAdmin catalog={q.data} />;
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
      {body}
    </ErpPage>
  );
}

// ───────────────────────── 目录 ─────────────────────────

function Home({ c, setStore }: { c: ShopCatalog; setStore: (id: number) => void }) {
  const [cat, setCat] = useState<string | null>(null);
  const [kw, setKw] = useState('');
  const items = useMemo(() => {
    const k = kw.trim().toLowerCase();
    return c.items.filter(
      (i) => (!cat || (i.material.category || '未分类') === cat) && (!k || `${i.material.name} ${i.material.code} ${i.material.specification} ${i.material.category}`.toLowerCase().includes(k)),
    );
  }, [c.items, cat, kw]);
  return (
    <div className="space-y-4" data-testid="shop-home">
      <div className="flex flex-wrap items-end gap-3">
        <Field label="门店（业态）" htmlFor="shop-store">
          <Select id="shop-store" value={c.storeId} onChange={(e) => setStore(Number(e.target.value))} fullWidth={false}>
            {c.stores.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </Select>
        </Field>
        <div className="relative min-w-[220px] flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-4" />
          <Input value={kw} onChange={(e) => setKw(e.target.value)} placeholder="搜索物料名称 / 规格 / 编码" className="pl-9" aria-label="搜索" data-testid="shop-search" />
        </div>
      </div>
      <div className="flex flex-wrap gap-1.5" data-testid="shop-categories">
        <CatChip on={cat === null} onClick={() => setCat(null)}>
          全部（{c.items.length}）
        </CatChip>
        {c.categories.map((x) => (
          <CatChip key={x.name} on={cat === x.name} onClick={() => setCat(x.name)}>
            {x.name}（{x.count}）
          </CatChip>
        ))}
      </div>
      {items.length === 0 ? (
        <Card className="p-6 text-center text-[13.5px] text-ink-3">
          没有找到。
          <Link to={`${BASE}/custom`} className="ml-1 font-bold text-pine hover:underline">
            发起自主申请 →
          </Link>
        </Card>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3" data-testid="shop-items">
          {items.map((i) => (
            <li key={i.material.id}>
              <div className="mo-lift flex h-full flex-col rounded-xl border border-line bg-card p-4 shadow-card hover:border-pine/50">
                <Link to={`${BASE}/item/${i.material.id}`} className="flex flex-1 flex-col" data-testid={`shop-item-${i.material.id}`}>
                  <span className="text-[12.5px] text-ink-3">{i.material.category || '未分类'}</span>
                  <span className="mt-0.5 text-[15px] font-bold text-ink">{i.material.name}</span>
                  <span className="text-[12.5px] text-ink-3">
                    {i.material.code}
                    {i.material.specification && ` · ${i.material.specification}`}
                  </span>
                </Link>
                <div className="mt-auto flex items-end justify-between gap-2 pt-3">
                  <span className="text-[16px] font-bold text-clay">
                    {i.fromGrossCents !== null ? `${formatYuan(i.fromGrossCents)} 起` : <span className="text-[13px] font-normal text-ink-4">暂无可采购价</span>}
                  </span>
                  <Link
                    to={`${BASE}/compare/${i.material.id}?from=catalog&storeId=${c.storeId}`}
                    className="tap relative inline-flex items-center text-[12.5px] font-semibold text-pine hover:underline"
                    data-testid={`shop-compare-link-${i.material.id}`}
                  >
                    {i.purchasable} 家可选 →
                  </Link>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
      <Card className="flex flex-wrap items-center justify-between gap-3 p-4">
        <span className="text-[13px] text-ink-2">没有找到你要的？写清名称、规格、数量和理由，采购同事寻源报价。</span>
        <Link to={`${BASE}/custom`}>
          <Button icon={<PencilLine className="size-4" />}>自主申请</Button>
        </Link>
      </Card>
    </div>
  );
}

function CatChip({ on, onClick, children }: { on: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn('tap relative h-8 rounded-full px-3 text-[12.5px] font-semibold', on ? 'bg-ink text-paper' : 'bg-card text-ink-2 ring-1 ring-line hover:text-ink')}
    >
      {children}
    </button>
  );
}

function OfferFacts({ o, unit }: { o: ShopOffer; unit: string }) {
  return (
    <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-[12.5px]">
      <dt className="text-ink-3">未税单价</dt>
      <dd className="text-right">
        {formatYuan(o.priceCents)}（税 {o.taxRateBp / 100}%）
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
      <Link to={BASE} className="inline-flex items-center gap-1 text-[13px] font-semibold text-ink-2 hover:text-ink">
        <ArrowLeft className="size-4" /> 返回商品列表
      </Link>
      <Card className="p-4">
        <p className="text-[12px] text-ink-3">
          {item.material.category} · {item.material.code}
        </p>
        <h2 className="text-[19px] font-bold text-ink">{item.material.name}</h2>
        <p className="text-[13px] text-ink-2">
          {item.material.specification} · 单位 {item.material.unit}
        </p>
        {item.material.note && <p className="mt-1 text-[12.5px] text-ink-3">{item.material.note}</p>}
      </Card>
      <p className="text-[13px] font-bold text-ink-2">
        供应商比选：{item.offers.length} 条报价，{item.purchasable} 条可选（门店：{c.stores.find((s) => s.id === c.storeId)?.name}）
      </p>
      <ul className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
        {item.offers.map((o) => (
          <li key={o.skuId}>
            <Card className={cn('flex h-full flex-col gap-3 p-4', o.block && 'opacity-60')} data-testid={`shop-offer-${o.skuId}`}>
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate text-[14.5px] font-bold text-ink">{o.supplier.name}</p>
                  <p className="text-[12px] text-ink-3">
                    {o.skuCode} · V{o.priceVersion}
                  </p>
                </div>
                <Badge tone={o.block ? (o.block === 'store' ? 'neutral' : 'ember') : 'pine'}>{o.block ? SHOP_BLOCK_LABELS[o.block] : '可采购'}</Badge>
              </div>
              <p className="text-[20px] font-bold text-clay">
                {formatYuan(o.grossCents)}
                <span className="text-[12px] font-normal text-ink-3"> / {item.material.unit}（含税）</span>
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

// ───────────────────────── 清单与提交 ─────────────────────────

interface CartRow {
  line: CartLine;
  item: ShopItem | null;
  offer: ShopOffer | null;
  problem: string | null;
  gross: number;
}
function cartRows(c: ShopCatalog, cart: Cart): CartRow[] {
  return cart.lines.map((line) => {
    const item = c.items.find((i) => i.offers.some((o) => o.skuId === line.skuId)) ?? null;
    const offer = item?.offers.find((o) => o.skuId === line.skuId) ?? null;
    const problem = !offer
      ? '这条报价已经没有了'
      : offer.block
        ? SHOP_BLOCK_LABELS[offer.block]
        : offer.priceVersion !== line.priceVersion
          ? '加清单以后改过价：请确认新价'
          : line.qtyMilli < offer.moqMilli
            ? `低于起订量 ${formatQty(offer.moqMilli)}`
            : null;
    return { line, item, offer, problem, gross: offer ? lineGrossCents(offer.priceCents, offer.taxRateBp, line.qtyMilli, offer.freightCents) : 0 };
  });
}

function CartPage({ c, cart, setCart }: { c: ShopCatalog; cart: Cart; setCart: (c: Cart) => void }) {
  const navigate = useNavigate();
  const sameStore = cart.storeId === null || cart.storeId === c.storeId;
  const rows = cartRows(c, cart);
  const [edit, setEdit] = useState<Record<number, string>>({});
  if (!cart.lines.length)
    return (
      <Card className="p-8 text-center text-[13.5px] text-ink-3" data-testid="shop-cart-empty">
        采购清单是空的。
        <Link to={BASE} className="ml-1 font-bold text-pine hover:underline">
          去选购 →
        </Link>
      </Card>
    );
  const total = rows.reduce((s, r) => s + r.gross, 0);
  const freight = rows.reduce((s, r) => s + (r.offer?.freightCents ?? 0), 0);
  const setQty = (skuId: number, text: string) => {
    setEdit({ ...edit, [skuId]: text });
    const milli = parseQty(text);
    if (milli !== null && milli > 0) setCart({ ...cart, lines: cart.lines.map((l) => (l.skuId === skuId ? { ...l, qtyMilli: milli } : l)) });
  };
  // 输入框里的数量不对（0、负数、写错）时不能去结算：显示的和清单里记着的会不一样（Codex 审查）
  const badEdit = (skuId: number) => {
    const t = edit[skuId];
    if (t === undefined) return false;
    const milli = parseQty(t);
    return milli === null || milli <= 0;
  };
  const anyBadEdit = cart.lines.some((l) => badEdit(l.skuId));
  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_290px]" data-testid="shop-cart">
      <Card className="divide-y divide-line">
        {!sameStore && (
          <Notice tone="warning" title="这份清单是按另一家门店加的" className="m-3">
            在首页把门店换回来再提交，或清空重选。
          </Notice>
        )}
        {rows.map((r) => (
          <div key={r.line.skuId} className="flex flex-wrap items-center gap-3 p-4" data-testid={`shop-cart-line-${r.line.skuId}`}>
            <div className="min-w-0 flex-1">
              <p className="truncate text-[14px] font-bold text-ink">{r.item?.material.name ?? `SKU ${r.line.skuId}`}</p>
              <p className="text-[12px] text-ink-3">{r.offer ? `${r.offer.supplier.name} · ${r.offer.skuCode} · V${r.offer.priceVersion} · ${formatYuan(r.offer.grossCents)}（含税）` : ''}</p>
              {r.problem && <p className="text-[12px] font-semibold text-clay">{r.problem}</p>}
              {badEdit(r.line.skuId) && <p className="text-[12px] font-semibold text-clay">数量要大于 0（最多三位小数），改对了才能去结算</p>}
            </div>
            <Input aria-label="数量" className="w-24" inputMode="decimal" value={edit[r.line.skuId] ?? formatQty(r.line.qtyMilli)} onChange={(e) => setQty(r.line.skuId, e.target.value)} />
            <span className="w-28 text-right text-[13.5px] font-bold">{formatYuan(r.gross)}</span>
            {r.offer && r.offer.priceVersion !== r.line.priceVersion && !r.offer.block && (
              <Button size="sm" onClick={() => setCart({ ...cart, lines: cart.lines.map((l) => (l.skuId === r.line.skuId ? { ...l, priceVersion: r.offer!.priceVersion } : l)) })}>
                确认新价
              </Button>
            )}
            <Button size="sm" variant="ghost" onClick={() => setCart({ ...cart, lines: cart.lines.filter((l) => l.skuId !== r.line.skuId) })}>
              移除
            </Button>
          </div>
        ))}
      </Card>
      <Card className="h-fit space-y-2 p-4 lg:sticky lg:top-4">
        <p className="flex justify-between text-[13px]">
          <span className="text-ink-3">商品种类</span>
          {rows.length} 行
        </p>
        <p className="flex justify-between text-[13px]">
          <span className="text-ink-3">预计运费</span>
          {formatYuan(freight)}
        </p>
        <p className="flex justify-between text-[15px] font-bold">
          <span>预计含税总额</span>
          <span data-testid="shop-cart-total">{formatYuan(total)}</span>
        </p>
        <p className="text-[12px] text-ink-3">预估金额不作为合同或付款依据；采购执行时可能按供应商拆成几张采购单。</p>
        <Button variant="primary" className="w-full" disabled={!sameStore || anyBadEdit || rows.some((r) => r.problem)} onClick={() => navigate(`${BASE}/checkout`)} data-testid="shop-to-checkout">
          填写采购需求 →
        </Button>
        <Link to={BASE} className="block text-center text-[12.5px] font-semibold text-pine hover:underline">
          继续添加商品
        </Link>
      </Card>
    </div>
  );
}

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
      <Field label="紧急程度" hint="用于采购排序，不等于紧急特批">
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
                'tap relative inline-flex h-9 items-center gap-1.5 rounded-full px-3 text-[13px] font-semibold ring-1',
                f.priority === p ? 'bg-ink text-paper ring-ink' : 'bg-card text-ink-2 ring-line',
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

function Checkout({ c, cart, setCart }: { c: ShopCatalog; cart: Cart; setCart: (c: Cart) => void }) {
  const session = useSession();
  const navigate = useNavigate();
  const [f, setF] = useState<HeaderForm>(() => emptyHeader(c));
  const rows = cartRows(c, cart);
  // 提交成功先跳到这张单，再清清单：清单一空本页会跳回清单页，用 submitted 拦住，不跟跳转抢
  const [submitted, setSubmitted] = useState(false);
  const { send, busy, blocked } = useSubmit((r) => {
    setSubmitted(true);
    navigate(`${BASE}/mine/${r.id}`);
    setCart({ storeId: null, lines: [] });
  });
  if (!cart.lines.length) return submitted ? null : <Navigate to={`${BASE}/cart`} replace />;
  const bad = rows.some((r) => r.problem) || cart.storeId !== c.storeId;
  const total = rows.reduce((s, r) => s + r.gross, 0);
  return (
    <div className="space-y-4" data-testid="shop-checkout">
      <Card className="p-4">
        <p className="mb-3 text-[14px] font-bold">① 采购业务信息</p>
        <HeaderFields c={c} f={f} set={setF} />
      </Card>
      <Card className="p-4">
        <p className="mb-2 text-[14px] font-bold">② 采购商品</p>
        <ul className="divide-y divide-line text-[13px]">
          {rows.map((r) => (
            <li key={r.line.skuId} className="flex flex-wrap justify-between gap-2 py-2">
              <span>
                {r.item?.material.name} · {r.offer?.supplier.name}（V{r.offer?.priceVersion}）
              </span>
              <span>
                {formatQty(r.line.qtyMilli)} {r.item?.material.unit} · {formatYuan(r.gross)}
              </span>
            </li>
          ))}
        </ul>
        <p className="mt-2 text-right text-[15px] font-bold">预计含税总额 {formatYuan(total)}</p>
        <ul className="mt-2 list-disc space-y-0.5 pl-5 text-[12.5px] text-ink-3">
          <li>提交后生成一张采购需求单，先由部门主管确认（全部需求单都审），再核库、采购审核。</li>
          <li>部门选的供应商是采购意向，最终由采购确认；同日同供应商累计、备用金额度、合同与预算由 ERP 核验。</li>
          <li>紧急程度只用于排序，不等于紧急特批。</li>
        </ul>
        {bad && (
          <Notice tone="error" title="清单里有不能提交的行" className="mt-3">
            回采购清单修改（已失效、门店不对、改过价或低于起订量）。
          </Notice>
        )}
      </Card>
      <div className="flex justify-end gap-2">
        <Link to={`${BASE}/cart`}>
          <Button variant="ghost">返回清单</Button>
        </Link>
        <Button
          variant="primary"
          loading={busy}
          disabled={bad || blocked || headerMissing(f)}
          onClick={() =>
            void send({ ...headerBody(c, f, session.staff.displayName), kind: 'catalog', lines: cart.lines }, `${rows[0]?.item?.material.name ?? ''}${rows.length > 1 ? ` 等 ${rows.length} 行` : ''}`)
          }
          data-testid="shop-submit"
        >
          提交采购需求
        </Button>
      </div>
    </div>
  );
}

function CustomForm({ c }: { c: ShopCatalog }) {
  const session = useSession();
  const navigate = useNavigate();
  const [f, setF] = useState<HeaderForm>(() => emptyHeader(c));
  const [line, setLine] = useState({ name: '', expectedCategory: '', qty: '1', unit: '个', details: '', brandModel: '', link: '', reasonText: '' });
  const { send, busy, blocked } = useSubmit((r) => navigate(`${BASE}/mine/${r.id}`));
  const qtyMilli = parseQty(line.qty);
  const linkBad = !!line.link && !/^https?:\/\/\S+$/i.test(line.link);
  const missing = !line.name.trim() || !line.details.trim() || !line.reasonText.trim() || !qtyMilli || linkBad || blocked || headerMissing(f);
  return (
    <div className="space-y-4" data-testid="shop-custom">
      <Card className="p-4">
        <p className="mb-3 text-[14px] font-bold">① 申请采购的商品</p>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="物品名称" htmlFor="sc-name">
            <Input id="sc-name" maxLength={100} value={line.name} onChange={(e) => setLine({ ...line, name: e.target.value })} />
          </Field>
          <Field label="预期分类" htmlFor="sc-cat">
            <Select id="sc-cat" value={line.expectedCategory} onChange={(e) => setLine({ ...line, expectedCategory: e.target.value })}>
              <option value="">不确定，由采购确认</option>
              {c.categories.map((x) => (
                <option key={x.name} value={x.name}>
                  {x.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="采购数量" htmlFor="sc-qty">
            <Input id="sc-qty" inputMode="decimal" value={line.qty} onChange={(e) => setLine({ ...line, qty: e.target.value })} invalid={!qtyMilli} />
          </Field>
          <Field label="单位" htmlFor="sc-unit">
            <Select id="sc-unit" value={line.unit} onChange={(e) => setLine({ ...line, unit: e.target.value })}>
              {SHOP_CUSTOM_UNITS.map((u) => (
                <option key={u}>{u}</option>
              ))}
            </Select>
          </Field>
          <Field label="规格与技术要求" htmlFor="sc-details" className="sm:col-span-2" hint="写清验收要求">
            <Textarea id="sc-details" rows={3} maxLength={1000} value={line.details} onChange={(e) => setLine({ ...line, details: e.target.value })} />
          </Field>
          <Field label="品牌 / 型号（如有）" htmlFor="sc-model">
            <Input id="sc-model" maxLength={150} value={line.brandModel} onChange={(e) => setLine({ ...line, brandModel: e.target.value })} />
          </Field>
          <Field label="参考链接（如有）" htmlFor="sc-link" hint={linkBad ? '要以 http:// 或 https:// 开头' : undefined}>
            <Input id="sc-link" maxLength={1000} value={line.link} invalid={linkBad} onChange={(e) => setLine({ ...line, link: e.target.value })} />
          </Field>
          <Field label="采购理由 / 使用场景" htmlFor="sc-reason" className="sm:col-span-2" hint="为什么要买、用在哪、为什么商城里的不行">
            <Textarea id="sc-reason" rows={3} maxLength={1000} value={line.reasonText} onChange={(e) => setLine({ ...line, reasonText: e.target.value })} />
          </Field>
        </div>
      </Card>
      <Card className="p-4">
        <p className="mb-3 text-[14px] font-bold">② 部门与交付</p>
        <HeaderFields c={c} f={f} set={setF} />
        <p className="mt-3 text-[12.5px] text-ink-3">采购受理后寻源、归类与报价；没有金额时，3 万累计、备用金额度等等报价后由 ERP 核验。</p>
      </Card>
      <div className="flex justify-end">
        <Button
          variant="primary"
          loading={busy}
          disabled={missing}
          onClick={() =>
            void send(
              {
                ...headerBody(c, f, session.staff.displayName),
                kind: 'custom',
                line: { ...line, name: line.name.trim(), qtyMilli, details: line.details.trim(), reasonText: line.reasonText.trim(), imageIds: [] },
              },
              `自主申请 · ${line.name.trim()}`,
            )
          }
          data-testid="shop-custom-submit"
        >
          提交自主申请
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
  const [priority, setPriority] = useState<RequestPriority | ''>('');
  // 一页 50 张，从新到旧；紧急程度在服务端先筛再分页（老的单翻页也找得到，Codex 审查）
  const q = useInfiniteQuery({
    queryKey: ['shop', 'requests', scope, priority],
    initialPageParam: null as number | null,
    queryFn: ({ pageParam }) =>
      api.get<{ requests: MallRequestBrief[]; nextBeforeId: number | null }>(
        `/api/erp/shop/requests?scope=${scope}${priority ? `&priority=${priority}` : ''}${pageParam ? `&beforeId=${pageParam}` : ''}`,
      ),
    getNextPageParam: (last) => last.nextBeforeId,
  });
  if (q.isPending) return <Skeleton className="h-64" />;
  if (q.error) return <LoadFailed title="需求没有取回来" onRetry={() => void q.refetch()} retrying={q.isFetching} />;
  const list = q.data.pages.flatMap((p) => p.requests);
  return (
    <div className="space-y-3" data-testid={`shop-${scope}`}>
      <div className="flex flex-wrap items-center gap-2">
        <Select aria-label="紧急程度" value={priority} onChange={(e) => setPriority(e.target.value as RequestPriority | '')} fullWidth={false}>
          <option value="">全部紧急程度</option>
          {REQUEST_PRIORITIES.map((p) => (
            <option key={p} value={p}>
              {PRIORITY_LABELS[p]}
            </option>
          ))}
        </Select>
        <span className="text-[12.5px] text-ink-3">{scope === 'pool' ? '商城来的全部需求单；审核、退回、转采购单在 ERP「采购需求单」里办' : '本部门、自己提的、自己当主管的'}</span>
      </div>
      {list.length === 0 ? (
        <Card className="p-8 text-center text-[13.5px] text-ink-3">还没有。</Card>
      ) : (
        <Card className="divide-y divide-line">
          {list.map((r) => (
            <Link key={r.id} to={`${BASE}/${scope}/${r.id}`} className="flex flex-wrap items-center gap-3 px-4 py-3 hover:bg-paper-2" data-testid={`shop-req-${r.id}`}>
              <PriorityDot priority={r.priority} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13.5px] font-semibold text-ink">{r.summary || '—'}</span>
                <span className="text-[12px] text-ink-3">
                  {r.docNo} · {r.department.name} · {formatDateTime(r.createdAt)}
                </span>
              </span>
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

const STEPS: { label: string; done: (s: MallDisplayStatus) => boolean }[] = [
  { label: '提交', done: () => true },
  { label: '主管确认', done: (s) => s !== 'dept_pending' },
  { label: '核库与采购审核', done: (s) => ['approved', 'sourcing', 'ordered', 'partial', 'received', 'closed', 'issued'].includes(s) },
  { label: '下单', done: (s) => ['ordered', 'partial', 'received', 'closed'].includes(s) },
  { label: '到货', done: (s) => ['received', 'issued'].includes(s) },
];

function RequestDetail({ id, cart, setCart, c }: { id: number; cart: Cart; setCart: (c: Cart) => void; c: ShopCatalog }) {
  const toast = useToast();
  const navigate = useNavigate();
  const q = useQuery({ queryKey: ['shop', 'request', id], queryFn: () => api.get<MallRequest>(`/api/erp/shop/requests/${id}`) });
  if (q.isPending) return <Skeleton className="h-64" />;
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
      <Card className="space-y-3 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[17px] font-bold">{r.docNo}</span>
          <Badge tone={DISPLAY_TONE[r.displayStatus] ?? 'neutral'}>{MALL_DISPLAY_LABELS[r.displayStatus]}</Badge>
          <PriorityDot priority={r.priority} />
          <span className="text-[12.5px] text-ink-3">{PRIORITY_LABELS[r.priority]}</span>
          <span className="ml-auto text-[12px] text-ink-3">进度更新于 {formatDateTime(r.progressUpdatedAt)}</span>
        </div>
        <ol className="flex flex-wrap gap-2 text-[12.5px]" aria-label="进度">
          {STEPS.map((s, i) => (
            <li key={s.label} className={cn('rounded-full px-2.5 py-1', !ended && s.done(r.displayStatus) ? 'bg-pine text-paper' : 'bg-paper-2 text-ink-3')}>
              {i + 1}. {s.label}
            </li>
          ))}
        </ol>
        {r.reason && ended && <Notice tone={r.displayStatus === 'returned' ? 'warning' : 'info'} title={`${MALL_DISPLAY_LABELS[r.displayStatus]}：${r.reason}`} data-testid="shop-request-reason" />}
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
            <p className="text-[12px] text-ink-3">
              {[
                l.supplier && `意向供应商：${l.supplier.name}`,
                l.skuCode && `${l.skuCode}（${l.priceVersion}）`,
                l.brandModel && `型号：${l.brandModel}`,
                l.details,
                l.reasonText && `理由：${l.reasonText}`,
              ]
                .filter(Boolean)
                .join(' · ')}
            </p>
            {l.link && (
              <a href={l.link} target="_blank" rel="noreferrer noopener" className="text-[12px] font-semibold text-lake hover:underline">
                打开参考链接 ↗
              </a>
            )}
            <p className="text-[12px] text-ink-2">
              进度：{MALL_LINE_LABELS[l.progress.state]}
              {l.progress.poNo && ` · 采购单 ${l.progress.poNo}（${l.progress.supplierName}）`}
              {l.progress.receivedMilli > 0 && ` · 已到 ${formatQty(l.progress.receivedMilli)}`}
            </p>
          </div>
        ))}
      </Card>
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
      {!ended && r.displayStatus !== 'received' && <p className="text-right text-[12px] text-ink-3">要撤回或补充请在 ERP「采购需求单」里打开这张单；退回的撤回后在这里按原单再提。</p>}
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
