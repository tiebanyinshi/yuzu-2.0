// 福田店整改 CY-02（2026-11-26）：点单页右侧「已点菜品」——这位客人（这桌）下过单的每道菜都列出来（名称、数量、状态），
// 不只是进厨房、还没上的那些（原来的「还没上的菜」只列出品单上还没上的，不进厨房的水吧、果吧饮品与已上的菜看不到，
// 门店以为下单没记上）。数据就是点菜单（`/api/dining/receipt`），下单成功后与点菜单一起刷新（点单页的 refresh 让 ['dining'] 失效）。

import { RECEIPT_STATE_LABELS, type DiningReceiptLine } from '@shared/dining';
import { errorMessage } from '../../lib/api';
import { cn } from '../../lib/utils';
import { LoadFailed } from '../../components/LoadFailed';
import { Money } from '../../components/Money';
import { Card, SectionTitle, Skeleton } from '../../components/ui';
import { useDiningReceipt, type ReceiptTarget } from './ReceiptDialog';

const STATE_TONE: Record<DiningReceiptLine['state'], string> = {
  served: 'text-pine',
  waiting: 'text-clay',
  cooking: 'text-yuzu-deep',
  done: 'text-lake',
  voided: 'text-ink-4 line-through',
};

export function OrderedDishes({ target }: { target: ReceiptTarget | null }) {
  const q = useDiningReceipt(target);
  if (!target) return null;
  const lines = (q.data?.orders ?? []).flatMap((o) => o.lines.map((l) => ({ ...l, seq: o.seq })));
  const active = lines.filter((l) => l.state !== 'voided');
  return (
    <Card className="p-4" data-testid="dining-ordered">
      <SectionTitle
        aside={
          q.data && (
            <span className="text-[12.5px] font-semibold text-ink-3">
              共 <span className="num">{q.data.totals.quantity}</span> 份 · <Money cents={q.data.totals.amount} className="font-bold text-ink" />
            </span>
          )
        }
      >
        已点菜品 {active.length ? active.length : ''}
      </SectionTitle>
      {q.isPending ? (
        <Skeleton className="mt-2 h-16" />
      ) : q.isError && !q.data ? (
        <LoadFailed title="已点菜品加载失败" onRetry={() => void q.refetch()} retrying={q.isFetching} testId="dining-ordered-error">
          {errorMessage(q.error)}
        </LoadFailed>
      ) : lines.length === 0 ? (
        <p className="mt-2 text-[12.5px] text-ink-3">还没有下过单</p>
      ) : (
        <ul className="mt-2 divide-y divide-line/70">
          {lines.map((l) => (
            <li key={l.billLineId} className="flex items-baseline gap-2 py-1.5 text-[13px]" data-testid={`dining-ordered-${l.name}`}>
              <span className={cn('min-w-0 flex-1 truncate font-semibold', l.state === 'voided' && 'text-ink-4 line-through')}>{l.name}</span>
              <span className="num text-ink-2">×{l.quantity}</span>
              <span className={cn('w-14 text-right text-[12px] font-bold', STATE_TONE[l.state])} data-testid="dining-ordered-state">
                {RECEIPT_STATE_LABELS[l.state]}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
