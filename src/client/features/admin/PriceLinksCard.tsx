// 价目表第四批：对接收银项目（docs/PRICE_CATALOG.md 第 6 节，PC17、PC18）。看生效中的价目表时显示在「全品类价目表」页里：
// 价目表的每一项对上一个收银项目以后，切换生效、回滚、改价都把价格写到那个收银项目上——前台开单、房态点单、房态中心登记、
// 点单页取的就是价目表的价；后台价目里不能再另改它的价（PRICE_LINKED）。
// 「按名称自动对接」只对名称恰好对上一个收银项目的；其余的逐项「对接」选收银项目，或「取消」。
// 写操作带操作编号；结果不确定的在页面上方查回、重提或确认作废（类型 price_link），确认之前这里的按钮都不能点。

import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link2, Wand2 } from 'lucide-react';
import { PRICE_TIER_LABELS, type TierPrice } from '@shared/catalog';
import { PRICE_SHEET_NAMES, matchesPriceSearch, priceNameKey, priceText, type PriceCatalogEntry } from '@shared/price-catalog';
import { formatYuan } from '@shared/money';
import { api, errorMessage, UncertainError } from '../../lib/api';
import { sendErpOp, useErpPending } from '../../lib/erpPending';
import { qk, useCatalog } from '../../lib/queries';
import { useSession } from '../../lib/session';
import { uuid } from '../../lib/utils';
import { DataTable, type DataColumn } from '../../components/DataTable';
import { PENDING_TYPES } from './priceOps';
import { LoadFailed } from '../../components/LoadFailed';
import { Dialog } from '../../components/Overlay';
import { Badge, Button, Card, Input, Notice, SectionTitle, Segmented, Skeleton } from '../../components/ui';

interface PriceLink {
  entryKey: string;
  itemId: number;
  itemName: string;
  itemActive: boolean;
  prices: TierPrice[];
}
interface SyncResult {
  itemName: string;
  changed: boolean;
  skipped?: string;
}
interface LinkResult {
  linked: number;
  unlinked: number;
  synced: SyncResult[];
}
/** entry 为 null：已有的对接没对上生效价目表里在用的项（那一项停用了、或新版里没有这个名字），只能取消 */
type Row = { key: string; entry: PriceCatalogEntry | null; link: PriceLink | undefined };
type LiveRow = Row & { entry: PriceCatalogEntry };
const nameOf = (r: Row) => r.entry?.name ?? r.key.split('|').at(-1) ?? r.key;
type Show = 'all' | 'linked' | 'unlinked';

const linksKey = ['price-catalog', 'links'] as const;
const tiersText = (prices: TierPrice[]) => (prices.length === 1 ? formatYuan(prices[0]!.price) : prices.map((p) => `${PRICE_TIER_LABELS[p.tier]} ${formatYuan(p.price)}`).join(' / '));
/** 收银项目的价与价目表一致吗（单价：每一档都是这个价；双价：专业 = 专业价、优选 = 资深价） */
function agrees(e: PriceCatalogEntry, prices: TierPrice[]): boolean | null {
  if (e.priceMode === 'none' || e.priceCents === null) return null;
  const at = (t: TierPrice['tier']) => prices.find((p) => p.tier === t)?.price;
  if (e.priceMode === 'dual') return at('professional') === e.priceCents && at('premium') === e.price2Cents;
  return prices.length > 0 && prices.every((p) => p.price === e.priceCents);
}

export function PriceLinksCard({ entries }: { entries: PriceCatalogEntry[] }) {
  const qc = useQueryClient();
  const session = useSession();
  const links = useQuery({ queryKey: linksKey, queryFn: () => api.get<PriceLink[]>('/api/admin/price-catalog/links') });
  const pending = useErpPending(PENDING_TYPES).length > 0;
  const [show, setShow] = useState<Show>('all');
  const [q, setQ] = useState('');
  const [picking, setPicking] = useState<LiveRow | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'success' | 'error' | 'warning'; text: string } | null>(null);

  const rows = useMemo<Row[]>(() => {
    const byKey = new Map((links.data ?? []).map((l) => [l.entryKey, l]));
    const live = entries.filter((e) => e.active && e.priceMode !== 'rate').map((e) => ({ key: priceNameKey(e), entry: e, link: byKey.get(priceNameKey(e)) }));
    const liveKeys = new Set(live.map((r) => r.key));
    // 对接还在、价目表里却没有在用的这一项：照样列出来（排在最前），能取消，不然收银项目一直被锁着改不了价
    const orphans = (links.data ?? []).filter((l) => !liveKeys.has(l.entryKey)).map((l) => ({ key: l.entryKey, entry: null, link: l }));
    return [...orphans, ...live];
  }, [entries, links.data]);
  const linkedCount = rows.filter((r) => r.entry && r.link).length;
  const liveCount = rows.filter((r) => r.entry).length;
  const orphanCount = rows.length - liveCount;
  const matches = (r: Row) => (r.entry ? matchesPriceSearch(r.entry, q) : nameOf(r).replace(/\s+/g, '').toLowerCase().includes(q.replace(/\s+/g, '').toLowerCase()));
  const shown = rows.filter((r) => (show === 'linked' ? r.link : show === 'unlinked' ? !r.link : true) && matches(r));

  const send = async (path: 'links' | 'links/auto', body: Record<string, unknown>, summary: string) => {
    setBusy(true);
    setMessage(null);
    try {
      // 每次新的操作编号：先存本机并读回核对，存不了不发；结果不确定的在页面上方查回、重提或作废
      const key = uuid();
      const r = await sendErpOp<LinkResult>({ key, type: 'price_link', url: `/api/admin/price-catalog/${path}`, body: { ...body, opKey: key }, summary, staffName: session.staff.displayName });
      const changed = r.synced.filter((s) => s.changed).length;
      const skipped = r.synced.filter((s) => s.skipped);
      setMessage({
        tone: skipped.length ? 'warning' : 'success',
        text: [
          path === 'links/auto' ? `按名称对上 ${r.linked} 项` : r.linked ? '已对接' : '已取消对接',
          changed ? `${changed} 个收银项目的价格已换成价目表的价` : '',
          skipped.length ? `没同步：${skipped.map((s) => `${s.itemName}（${s.skipped}）`).join('、')}` : '',
        ]
          .filter(Boolean)
          .join('；'),
      });
      setPicking(null);
    } catch (e) {
      setMessage({ tone: 'error', text: e instanceof UncertainError ? '结果待确认：已记在本机，请在页面上方查回、按原内容重新提交或作废，不要再点一次' : errorMessage(e) });
      setPicking(null);
    } finally {
      setBusy(false);
      await Promise.all([qc.invalidateQueries({ queryKey: linksKey }), qc.invalidateQueries({ queryKey: qk.catalog(true) }), qc.invalidateQueries({ queryKey: qk.catalog(false) })]);
    }
  };

  const columns: DataColumn<Row>[] = [
    {
      key: 'entry',
      header: '价目项目',
      dataLabel: '价目项目',
      cell: (r) => (
        <span>
          <span className="font-semibold">{nameOf(r)}</span>
          {r.entry ? (
            <span className="ml-2 text-[12px] text-ink-3">{[PRICE_SHEET_NAMES[r.entry.sheet], r.entry.section, r.entry.category].filter(Boolean).join(' · ')}</span>
          ) : (
            <span className="ml-2 text-[12px] text-clay">生效的价目表里没有在用的这一项</span>
          )}
        </span>
      ),
    },
    { key: 'price', header: '价目价', dataLabel: '价目价', cell: (r) => (r.entry ? priceText(r.entry, formatYuan) : '—') },
    {
      key: 'item',
      header: '收银项目',
      dataLabel: '收银项目',
      cell: (r) =>
        r.link ? (
          <span>
            {r.link.itemName}
            {!r.link.itemActive && <span className="ml-1 text-[12px] text-clay">（已停用）</span>}
          </span>
        ) : (
          <span className="text-ink-3">未对接</span>
        ),
    },
    {
      key: 'state',
      header: '收银价',
      dataLabel: '收银价',
      cell: (r) => {
        if (!r.link) return null;
        const ok = r.entry ? agrees(r.entry, r.link.prices) : undefined;
        return (
          <span className="flex flex-wrap items-center gap-2">
            {tiersText(r.link.prices)}
            {ok === undefined ? (
              <Badge tone="clay">不同步，请取消或改名对上</Badge>
            ) : ok === null ? (
              <Badge tone="ember">待定价，不同步</Badge>
            ) : ok ? (
              <Badge tone="pine">一致</Badge>
            ) : (
              <Badge tone="clay">不一致</Badge>
            )}
          </span>
        );
      },
    },
    {
      key: 'act',
      header: '',
      dataLabel: '操作',
      cell: (r) =>
        pending ? null : (
          <span className="flex gap-1">
            {r.entry && (
              <Button size="sm" variant="ghost" onClick={() => r.entry && setPicking({ ...r, entry: r.entry })} data-testid="price-link-pick">
                {r.link ? '改' : '对接'}
              </Button>
            )}
            {r.link && (
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => void send('links', { entryKey: r.key, itemId: null }, `取消对接「${nameOf(r)}」`)} data-testid="price-link-remove">
                取消
              </Button>
            )}
          </span>
        ),
    },
  ];

  return (
    <Card className="p-5" data-testid="price-links">
      <SectionTitle
        aside={
          !pending && (
            <Button
              size="sm"
              variant="secondary"
              icon={<Wand2 className="size-4" />}
              disabled={busy}
              onClick={() => void send('links/auto', {}, '按名称自动对接收银项目')}
              data-testid="price-links-auto"
            >
              按名称自动对接
            </Button>
          )
        }
      >
        <span className="flex items-center gap-2">
          <Link2 className="size-4" />
          对接收银项目
          <span className="text-[12.5px] font-normal text-ink-3" data-testid="price-links-count">
            已对接 {linkedCount} / {liveCount} 项{orphanCount > 0 ? `，另有 ${orphanCount} 个对接没对上在用项` : ''}
          </span>
        </span>
      </SectionTitle>
      <p className="mt-1 text-[12.5px] text-ink-3">对接以后，前台开单、房态点单、房态中心登记取的就是价目表的价；切换生效、回滚、改价都会同步过去，后台价目里不能再另改它的价。已开的单不变。</p>
      {message && <Notice tone={message.tone} title={message.text} className="mt-3" data-testid="price-links-message" />}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Segmented
          size="sm"
          value={show}
          onChange={setShow}
          ariaLabel="看哪些"
          options={[
            { value: 'all', label: '全部' },
            { value: 'linked', label: '已对接' },
            { value: 'unlinked', label: '未对接' },
          ]}
        />
        <Input className="max-w-xs" value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜价目项目" aria-label="搜对接的价目项目" />
      </div>
      {links.isPending ? (
        <Skeleton className="mt-3 h-40" />
      ) : links.isError && !links.data ? (
        <LoadFailed className="mt-3" title="对接关系取不回来" onRetry={() => void links.refetch()} retrying={links.isFetching} />
      ) : (
        <DataTable
          className="mt-3"
          variant="plain"
          columns={columns}
          rows={shown.slice(0, 200)}
          rowKey={(r) => r.key}
          rowTestId={() => 'price-link-row'}
          empty="没有符合条件的项"
          testId="price-links-table"
        />
      )}
      {picking && (
        <PickItemDialog
          row={picking}
          busy={busy}
          onClose={() => setPicking(null)}
          onPick={(itemId, name) => void send('links', { entryKey: picking.key, itemId }, `「${picking.entry.name}」对接收银项目「${name}」`)}
        />
      )}
    </Card>
  );
}

function PickItemDialog({ row, busy, onClose, onPick }: { row: LiveRow; busy: boolean; onClose: () => void; onPick: (itemId: number, name: string) => void }) {
  const catalog = useCatalog(true);
  // 收银项目可能刚在别的页签建好：打开时取一次最新的（列表平时缓存一分钟）
  const { refetch } = catalog;
  useEffect(() => void refetch(), [refetch]);
  const [q, setQ] = useState('');
  const t = q.replace(/\s+/g, '').toLowerCase();
  const items = (catalog.data?.items ?? []).filter((i) => i.active && (!t || i.name.replace(/\s+/g, '').toLowerCase().includes(t))).slice(0, 30);
  return (
    <Dialog open onClose={onClose} title={`对接「${row.entry.name}」`} description={`价目价 ${priceText(row.entry, formatYuan)}；选一个收银项目，选好后它的价格换成价目表的价`}>
      <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜收银项目" aria-label="搜收银项目" autoFocus />
      {catalog.isPending ? (
        <Skeleton className="mt-3 h-32" />
      ) : catalog.isError && !catalog.data ? (
        <LoadFailed className="mt-3" title="收银项目取不回来" onRetry={() => void catalog.refetch()} retrying={catalog.isFetching} />
      ) : items.length === 0 ? (
        <p className="mt-3 text-sm text-ink-3">没有这样的收银项目；先在「项目价目」里建好再来对接。</p>
      ) : (
        <ul className="mt-3 max-h-80 divide-y divide-line overflow-auto rounded-lg border border-line">
          {items.map((i) => (
            <li key={i.id}>
              <button
                type="button"
                disabled={busy || row.link?.itemId === i.id}
                className="flex w-full items-baseline justify-between gap-3 px-3 py-2 text-left hover:bg-surface-2 disabled:opacity-50"
                onClick={() => onPick(i.id, i.name)}
                data-testid="price-link-item"
              >
                <span>
                  {i.name}
                  <span className="ml-2 text-xs text-ink-3">{i.category}</span>
                </span>
                <span className="shrink-0 text-sm text-ink-2">{tiersText(i.prices)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Dialog>
  );
}
