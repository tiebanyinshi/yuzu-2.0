// 买角代号（8.1.44《前台系统开发》第 9 条，docs/V8144_CASHIER.md）：收银台敲数字代号挂项目，代号 → 价目项目与价格档。
// 编码规则、对应项目与计价口径待业务侧提供清单（docs/PENDING_DECISIONS.md FD44-1），默认一条都没有；存在前台规则里（frontdesk_rules.buyCodes）。
import { useEffect, useMemo, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { lineName, PRICE_TIER_LABELS, sortTiers, type PriceTier } from '@shared/catalog';
import { BUY_CODE_PATTERN, MAX_BUY_CODES, type BuyCode, type FrontdeskRules } from '@shared/frontdesk';
import { api, errorMessage } from '../../lib/api';
import { useCatalog } from '../../lib/queries';
import { Button, Card, Input, Notice, PendingBadge, SectionTitle, Select } from '../../components/ui';

type Row = { code: string; itemId: number | null; tier: PriceTier };

export function BuyCodesCard({ rules, onSaved }: { rules: FrontdeskRules | undefined; onSaved: () => void }) {
  const catalog = useCatalog();
  const items = useMemo(() => (catalog.data?.items ?? []).filter((i) => i.active), [catalog.data]);
  const [rows, setRows] = useState<Row[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (rules) setRows((rules.buyCodes ?? []).map((c) => ({ ...c })));
  }, [rules]);

  const codes = rows.map((r) => r.code.trim());
  const problem = rows.some((r) => !BUY_CODE_PATTERN.test(r.code.trim()))
    ? '代号是 1–4 位数字'
    : new Set(codes).size !== codes.length
      ? '代号有重复'
      : rows.some((r) => r.itemId === null)
        ? '每个代号都要选项目'
        : null;
  const update = (i: number, patch: Partial<Row>) => setRows((list) => list.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const buyCodes: BuyCode[] = rows.map((r) => ({ code: r.code.trim(), itemId: r.itemId!, tier: r.tier }));
      await api.put('/api/frontdesk/rules', { buyCodes });
      onSaved();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="p-5" data-testid="buy-codes-card">
      <SectionTitle>
        <span className="flex items-center gap-1.5">
          买角代号 <PendingBadge title="《前台系统开发》待确认：买角数字代号的编码规则、对应项目与计价口径由业务侧提供清单；先按「代号 → 项目与价格档、按项目当前价计价」做" />
        </span>
      </SectionTitle>
      <p className="mt-1 text-[12.5px] text-ink-3">收银台点「买角」（F6）后敲代号回车，就把对应的项目加一份进本次挂账；价格照项目的当前价。代号 1–4 位数字，不重复。</p>
      {rows.length === 0 ? (
        <p className="mt-3 rounded-lg border border-dashed border-line-strong px-4 py-5 text-center text-[13px] text-ink-3">还没有代号（清单待业务提供）</p>
      ) : (
        <ul className="mt-3 space-y-2">
          {rows.map((r, i) => {
            const item = items.find((x) => x.id === r.itemId);
            return (
              <li key={i} className="flex flex-wrap items-center gap-2" data-testid={`buy-code-row-${i}`}>
                <Input
                  fullWidth={false}
                  value={r.code}
                  onChange={(e) => update(i, { code: e.target.value.replace(/[^0-9]/g, '').slice(0, 4) })}
                  inputMode="numeric"
                  className="num h-10 w-24"
                  aria-label={`第 ${i + 1} 个代号`}
                />
                <Select
                  fullWidth={false}
                  value={r.itemId === null ? '' : String(r.itemId)}
                  onChange={(e) => {
                    const next = items.find((x) => x.id === Number(e.target.value));
                    update(i, { itemId: next ? next.id : null, tier: next ? (sortTiers(next.prices)[0]?.tier ?? 'standard') : 'standard' });
                  }}
                  className="h-10 min-w-0 flex-1 basis-48"
                  aria-label={`第 ${i + 1} 个代号的项目`}
                >
                  <option value="">选项目</option>
                  {items.map((x) => (
                    <option key={x.id} value={x.id}>
                      {x.name}
                    </option>
                  ))}
                </Select>
                {item && item.prices.length > 1 && (
                  <Select fullWidth={false} value={r.tier} onChange={(e) => update(i, { tier: e.target.value as PriceTier })} className="h-10 w-28" aria-label={`第 ${i + 1} 个代号的价格档`}>
                    {sortTiers(item.prices).map((p) => (
                      <option key={p.tier} value={p.tier}>
                        {PRICE_TIER_LABELS[p.tier]}
                      </option>
                    ))}
                  </Select>
                )}
                {item && <span className="text-[12.5px] text-ink-3">{lineName(item.name, item.prices, r.tier)}</span>}
                <button
                  type="button"
                  aria-label={`删掉代号 ${r.code}`}
                  onClick={() => setRows((list) => list.filter((_, j) => j !== i))}
                  className="tap relative flex h-10 items-center gap-1 rounded-md px-2 text-[12.5px] font-semibold text-ink-3 hover:bg-clay-soft hover:text-clay"
                >
                  <Trash2 className="size-4" /> 删掉
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <Button
          size="sm"
          variant="ghost"
          icon={<Plus className="size-4" />}
          disabled={rows.length >= MAX_BUY_CODES}
          onClick={() => setRows((list) => [...list, { code: '', itemId: null, tier: 'standard' }])}
          data-testid="buy-code-add"
        >
          加一个代号
        </Button>
        <Button variant="primary" disabled={!rules || !!problem} loading={busy} onClick={save} data-testid="buy-codes-save">
          保存买角代号
        </Button>
        {problem && <span className="text-[13px] text-clay">{problem}</span>}
      </div>
      {error && <Notice tone="error" title={error} className="mt-3" />}
    </Card>
  );
}
