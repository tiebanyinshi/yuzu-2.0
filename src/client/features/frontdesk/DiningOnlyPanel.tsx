// 结账核对里的「只看餐饮」（8.1.39 餐饮 B，R10 同组账单只看餐饮）：几张手牌（同组）一起结时，
// 列出每张手牌的餐饮明细（单价 × 份数）与餐饮小计、几张合起来的餐饮合计，前台好给客人报餐饮的钱。
// 只读：不改应收，结账照旧按上面的应收合计。

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { UtensilsCrossed } from 'lucide-react';
import type { DiningSubtotals } from '@shared/dining-v8139';
import { formatYuan } from '@shared/money';
import { api } from '../../lib/api';
import { Money } from '../../components/Money';

export function DiningOnlyPanel({ visitIds, pricedAt }: { visitIds: number[]; pricedAt: string }) {
  const [open, setOpen] = useState(false);
  const ids = [...visitIds].sort((a, b) => a - b).join(',');
  const q = useQuery({
    // 跟着核对一起刷新（核对重取时 pricedAt 会变）
    queryKey: ['frontdesk', 'dining-subtotals', ids, pricedAt],
    queryFn: () => api.get<DiningSubtotals>(`/api/frontdesk/dining-subtotals?visitIds=${ids}`),
    enabled: visitIds.length > 0,
  });
  const d = q.data;
  if (!d || (d.total === 0 && d.visits.every((v) => v.lines.length === 0))) return null;
  const many = d.visits.length > 1;
  return (
    <div className="rounded-lg border border-line bg-card" data-testid="checkout-dining-only">
      <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} className="flex min-h-11 w-full items-center gap-2 px-4 py-2 text-left" data-testid="checkout-dining-toggle">
        <UtensilsCrossed className="size-4 text-pine" />
        <span className="text-[13.5px] font-semibold">{open ? '收起餐饮明细' : '只看餐饮'}</span>
        <span className="text-[12px] text-ink-3">{many ? `${d.visits.length} 张手牌的餐饮合计` : '餐饮小计'}</span>
        <span className="flex-1" />
        <span data-testid="checkout-dining-total">
          <Money cents={d.total} className="text-[16px] font-bold text-pine" />
        </span>
      </button>
      {open && (
        <ul className="divide-y divide-line/70 border-t border-line" data-testid="checkout-dining-list">
          {d.visits.map((v) => (
            <li key={v.visitId} className="px-4 py-2.5" data-testid={`checkout-dining-${v.tagCode}`}>
              <p className="flex items-baseline gap-2">
                <span className="num text-[15px] font-bold">{v.tagCode}</span>
                <span className="text-[12px] text-ink-3">餐饮 {v.quantity} 份</span>
                <span className="flex-1" />
                <Money cents={v.amount} className="text-[14px] font-bold" />
              </p>
              {v.lines.length === 0 ? (
                <p className="mt-0.5 text-[12.5px] text-ink-3">没有点餐饮</p>
              ) : (
                v.lines.map((l) => (
                  <p key={l.id} className="mt-0.5 flex items-baseline gap-2 pl-1 text-[12.5px] text-ink-2">
                    <span className="min-w-0 flex-1 truncate">{l.name}</span>
                    <span className="num text-ink-3">
                      {formatYuan(l.unitPrice)} × {l.quantity}
                    </span>
                    <span className="num w-20 text-right">{formatYuan(l.amount)}</span>
                  </p>
                ))
              )}
            </li>
          ))}
          <li className="px-4 py-2 text-[12px] text-ink-3">只给客人报餐饮的钱用；结账照旧按上面的应收合计收。</li>
        </ul>
      )}
    </div>
  );
}
