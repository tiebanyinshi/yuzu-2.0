// 买角（8.1.44《前台系统开发》第 9 条，docs/V8144_CASHIER.md）：收银台敲专门的数字代号挂项目。代号 → 价目项目与价格档的清单
// 在后台「手牌与前台 → 前台规则 → 买角代号」维护（编码规则与清单待业务提供，默认一条都没有）。敲到的项目照常进「本次挂账」，提交走原来的挂账。
import { useState } from 'react';
import { Hash } from 'lucide-react';
import { lineName, type PriceTier } from '@shared/catalog';
import type { BuyCode } from '@shared/frontdesk';
import type { ServiceItem } from '@shared/types';
import { Notice } from '../../components/ui';

export function BuyCodeEntry({
  codes,
  items,
  disabled,
  unavailableFor,
  onPick,
}: {
  codes: readonly BuyCode[];
  items: readonly ServiceItem[];
  disabled: boolean;
  /** 这位客人现在不能点这一项的原因（限性别、沽清、停售……）；能点为 null */
  unavailableFor: (item: ServiceItem) => string | null;
  onPick: (item: ServiceItem, tier: PriceTier) => void;
}) {
  const [code, setCode] = useState('');
  const [hint, setHint] = useState<{ ok: boolean; text: string } | null>(null);
  if (codes.length === 0) {
    return (
      <Notice tone="warning" title="还没有配置买角的数字代号" className="mb-3" data-testid="buy-codes-empty">
        代号清单待业务提供，请店主在后台「手牌与前台 → 前台规则 → 买角代号」配置。现在可以照常在下面点项目。
      </Notice>
    );
  }
  const submit = () => {
    const c = code.trim();
    if (!c) return;
    const hit = codes.find((x) => x.code === c);
    const item = hit && items.find((i) => i.id === hit.itemId);
    if (!hit || !item) {
      setHint({ ok: false, text: hit ? `代号 ${c} 对的项目已停用，请店主改代号清单` : `没有代号 ${c}` });
      return;
    }
    const why = unavailableFor(item);
    if (why) {
      setHint({ ok: false, text: `${item.name}：${why}` });
      return;
    }
    onPick(item, hit.tier);
    setHint({ ok: true, text: `${c} → ${lineName(item.name, item.prices, hit.tier)} 加一份` });
    setCode('');
  };
  return (
    <div className="mb-3 rounded-lg border border-line bg-paper/70 p-3" data-testid="buy-code-entry">
      <div className="relative">
        <Hash className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-3" />
        <input
          value={code}
          inputMode="numeric"
          autoComplete="off"
          disabled={disabled}
          data-autofocus
          onChange={(e) => {
            setCode(e.target.value.replace(/[^0-9]/g, '').slice(0, 4));
            setHint(null);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              submit();
            }
          }}
          placeholder="敲数字代号，回车加一份"
          aria-label="买角数字代号"
          data-testid="buy-code-input"
          className="num h-11 w-full rounded-[12px] border border-line-strong bg-card pr-3 pl-9 text-[18px] font-bold outline-none placeholder:text-[14px] placeholder:font-medium focus:border-pine"
        />
      </div>
      {hint && (
        <p className={hint.ok ? 'mt-1.5 text-[12.5px] font-semibold text-pine' : 'mt-1.5 text-[12.5px] font-semibold text-clay'} role="status" data-testid="buy-code-hint">
          {hint.text}
        </p>
      )}
      <details className="mt-1.5 text-[12px] text-ink-3">
        <summary className="cursor-pointer font-semibold">代号清单（{codes.length} 条）</summary>
        <ul className="mt-1 grid grid-cols-2 gap-x-3 gap-y-0.5 sm:grid-cols-3">
          {codes.map((c) => {
            const item = items.find((i) => i.id === c.itemId);
            return (
              <li key={c.code} className="truncate">
                <b className="num text-ink-2">{c.code}</b> {item ? lineName(item.name, item.prices, c.tier) : '（项目已停用）'}
              </li>
            );
          })}
        </ul>
      </details>
    </div>
  );
}
