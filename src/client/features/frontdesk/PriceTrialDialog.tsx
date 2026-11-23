// 价目试算（价目表第四批，需求说明第三节 5「前台试算」；docs/PRICE_CATALOG.md 第 6 节）：收银台右上角「价目试算」。
// 只读生效中的价目表：选几项（房型 + 用时、按摩项目 + 专业 / 资深、门票……），逐行写怎么算的，小计、服务费（价目表里的比例）、合计。
// 不开单、不写库；算法与用例同一份（@shared/price-quote）。

import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { X } from 'lucide-react';
import { entryFacts, matchesPriceSearch, priceText, PRICE_SHEET_NAMES, type PriceCatalogEntry } from '@shared/price-catalog';
import { priceQuote, type QuotePick, type QuoteTier } from '@shared/price-quote';
import { formatYuan } from '@shared/money';
import { api } from '../../lib/api';
import { Dialog } from '../../components/Overlay';
import { LoadFailed } from '../../components/LoadFailed';
import { QtyInput } from '../../components/QtyInput';
import { Button, Input, Notice, Segmented, Select, Skeleton } from '../../components/ui';

interface ActiveCatalog {
  set: { id: number; title: string; activatedAt: string | null } | null;
  entries: PriceCatalogEntry[];
}
type Pick = Omit<QuotePick, 'entry'> & { key: number; entry: PriceCatalogEntry };

/** 计时的项目（娱乐、起开价 + 超时的房间）：可以填用了多久 */
const timed = (e: PriceCatalogEntry) => e.extraPriceCents !== null && !!e.extraMinutes;

export function PriceTrialDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const q = useQuery({ queryKey: ['price-catalog', 'active'], queryFn: () => api.get<ActiveCatalog>('/api/price-catalog/active'), enabled: open });
  const [search, setSearch] = useState('');
  const [picks, setPicks] = useState<Pick[]>([]);
  const entries = useMemo(() => (q.data?.entries ?? []).filter((e) => e.kind !== 'service_fee'), [q.data]);
  const fee = q.data?.entries.find((e) => e.kind === 'service_fee') ?? null;
  const found = useMemo(() => (search.trim() ? entries.filter((e) => matchesPriceSearch(e, search)).slice(0, 8) : []), [entries, search]);
  const quote = priceQuote(picks, fee);
  const set = (key: number, patch: Partial<Pick>) => setPicks((ps) => ps.map((p) => (p.key === key ? { ...p, ...patch } : p)));
  const add = (e: PriceCatalogEntry) => {
    setPicks((ps) => [...ps, { key: Date.now() + ps.length, entry: e, quantity: 1, minutes: timed(e) ? (e.durationMinutes ?? undefined) : undefined }]);
    setSearch('');
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      width="max-w-2xl"
      title="价目试算"
      description={q.data?.set ? `按生效中的价目表「${q.data.set.title}」算，不开单` : '按生效中的价目表算，不开单'}
      footer={
        <Button variant="ghost" onClick={onClose}>
          关闭
        </Button>
      }
    >
      {q.isPending ? (
        <Skeleton className="h-40" />
      ) : q.isError && !q.data ? (
        <LoadFailed title="价目表加载失败" onRetry={() => q.refetch()} retrying={q.isFetching} />
      ) : !q.data.set ? (
        <Notice tone="warning">还没有生效的价目表：先在后台「全品类价目表」导入并切换生效。</Notice>
      ) : (
        <div className="space-y-4" data-testid="price-trial">
          <div className="relative">
            <Input value={search} onChange={(ev) => setSearch(ev.target.value)} placeholder="搜项目名称、编号、房号，例如 spa房、康疗、门票" aria-label="搜价目" data-testid="price-trial-search" />
            {found.length > 0 && (
              <ul className="absolute inset-x-0 top-full z-10 mt-1 max-h-72 overflow-auto rounded-lg border border-line bg-surface shadow-lg">
                {found.map((e) => (
                  <li key={e.id}>
                    <button type="button" className="flex w-full items-baseline justify-between gap-3 px-3 py-2 text-left hover:bg-surface-2" onClick={() => add(e)} data-testid="price-trial-option">
                      <span>
                        {e.name}
                        <span className="ml-2 text-xs text-ink-3">
                          {PRICE_SHEET_NAMES[e.sheet]}
                          {e.section ? ` · ${e.section}` : ''}
                        </span>
                      </span>
                      <span className="shrink-0 text-sm text-ink-2">{priceText(e, formatYuan)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          {picks.length === 0 ? (
            <p className="text-sm text-ink-3">搜出项目点一下加进来；房间、娱乐可以填用了多久，按摩项目选专业价或资深价。</p>
          ) : (
            <ul className="divide-y divide-line rounded-lg border border-line">
              {picks.map((p) => {
                const e = p.entry;
                return (
                  <li key={p.key} className="space-y-2 px-3 py-2.5" data-testid="price-trial-line">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <div className="font-medium">{e.name}</div>
                        <div className="text-xs text-ink-3">{entryFacts(e, formatYuan).join(' · ')}</div>
                      </div>
                      <button type="button" aria-label={`移除 ${e.name}`} className="rounded-md p-1 text-ink-3 hover:text-ink" onClick={() => setPicks((ps) => ps.filter((x) => x.key !== p.key))}>
                        <X className="size-4" />
                      </button>
                    </div>
                    <div className="flex flex-wrap items-center gap-3">
                      {e.priceMode === 'dual' && (
                        <Segmented<QuoteTier>
                          size="sm"
                          ariaLabel={`${e.name} 价格档`}
                          value={p.tier ?? 'pro'}
                          onChange={(tier) => set(p.key, { tier })}
                          options={[
                            { value: 'pro', label: `专业 ${formatYuan(e.priceCents ?? 0)}` },
                            { value: 'senior', label: `资深 ${formatYuan(e.price2Cents ?? 0)}` },
                          ]}
                        />
                      )}
                      {e.variants.length > 0 && (
                        <Select
                          fullWidth={false}
                          aria-label={`${e.name} 分档`}
                          value={p.variant ?? ''}
                          onChange={(ev) => {
                            const variant = ev.target.value === '' ? undefined : Number(ev.target.value);
                            set(p.key, { variant, minutes: timed(e) ? ((variant === undefined ? e.durationMinutes : e.variants[variant]?.minutes) ?? undefined) : undefined });
                          }}
                        >
                          <option value="">{e.kind === 'room_type' && e.durationMinutes ? `起开价 ${priceText(e, formatYuan)}` : `主价格 ${priceText(e, formatYuan)}`}</option>
                          {e.variants.map((v, i) => (
                            <option key={i} value={i}>
                              {v.label} {v.priceCents === null ? '待定价' : formatYuan(v.priceCents)}
                            </option>
                          ))}
                        </Select>
                      )}
                      {timed(e) && p.minutes !== undefined && (
                        <label className="flex items-center gap-2 text-sm text-ink-2">
                          用时（分钟）
                          <QtyInput value={p.minutes} max={2880} label={`${e.name} 用时分钟`} onChange={(minutes) => set(p.key, { minutes })} />
                        </label>
                      )}
                      <label className="flex items-center gap-2 text-sm text-ink-2">
                        数量
                        <QtyInput value={p.quantity} max={999} label={`${e.name} 的数量`} onChange={(quantity) => set(p.key, { quantity })} />
                      </label>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
          {quote.problems.length > 0 && (
            <Notice tone="warning" title="这几项算不了">
              <ul className="list-disc pl-5">
                {quote.problems.map((t) => (
                  <li key={t}>{t}</li>
                ))}
              </ul>
            </Notice>
          )}
          {quote.lines.length > 0 && (
            <div className="text-sm" data-testid="price-trial-result">
              {quote.lines.map((l, i) => (
                <div key={i} className="flex items-baseline gap-3 border-b border-line py-1.5">
                  <span className="min-w-0 flex-1">
                    {l.name}
                    <span className="ml-2 text-xs text-ink-3">{l.detail.join(' · ')}</span>
                  </span>
                  <span className="tabular-nums text-ink-2">
                    {formatYuan(l.unitCents)} × {l.quantity}
                  </span>
                  <span className="w-28 text-right tabular-nums">{formatYuan(l.amountCents)}</span>
                </div>
              ))}
              <div className="flex justify-between pt-2">
                <span>小计</span>
                <span className="tabular-nums" data-testid="price-trial-subtotal">
                  {formatYuan(quote.subtotalCents)}
                </span>
              </div>
              <div className="flex justify-between">
                <span>{quote.feeRateBp === null ? '服务费（价目表里没有）' : `服务费 ${quote.feeRateBp / 100}%`}</span>
                <span className="tabular-nums" data-testid="price-trial-fee">
                  {formatYuan(quote.feeCents)}
                </span>
              </div>
              <div className="flex justify-between font-semibold">
                <span>合计</span>
                <span className="tabular-nums" data-testid="price-trial-total">
                  {formatYuan(quote.totalCents)}
                </span>
              </div>
            </div>
          )}
        </div>
      )}
    </Dialog>
  );
}
