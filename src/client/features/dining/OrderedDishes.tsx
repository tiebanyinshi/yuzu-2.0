// 福田店整改 CY-02（2026-11-26）：点单页右侧「已点菜品」——这位客人（这桌）下过单的每道菜都列出来（名称、数量、状态），
// 不只是进厨房、还没上的那些（原来的「还没上的菜」只列出品单上还没上的，不进厨房的水吧、果吧饮品与已上的菜看不到，
// 门店以为下单没记上）。数据就是点菜单（`/api/dining/receipt`），下单成功后与点菜单一起刷新（点单页的 refresh 让 ['dining'] 失效）。

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Users } from 'lucide-react';
import { RECEIPT_STATE_LABELS, type DiningGroupSummary, type DiningReceiptLine } from '@shared/dining';
import { api, errorMessage } from '../../lib/api';
import { cn } from '../../lib/utils';
import { LoadFailed } from '../../components/LoadFailed';
import { Money } from '../../components/Money';
import { Dialog } from '../../components/Overlay';
import { Badge, Button, Card, SectionTitle, Skeleton } from '../../components/ui';
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
  const [group, setGroup] = useState(false);
  if (!target) return null;
  const visitId = 'visit' in target ? target.visit : null;
  const lines = (q.data?.orders ?? []).flatMap((o) => o.lines.map((l) => ({ ...l, seq: o.seq })));
  const active = lines.filter((l) => l.state !== 'voided');
  return (
    <Card className="p-4" data-testid="dining-ordered">
      <SectionTitle
        aside={
          <span className="flex items-center gap-2">
            {q.data && (
              <span className="text-[12.5px] font-semibold text-ink-3">
                共 <span className="num">{q.data.totals.quantity}</span> 份 · <Money cents={q.data.totals.amount} className="font-bold text-ink" />
              </span>
            )}
            {/* CY-01：同组客人的点单一起看（单价、份数、合计） */}
            {visitId !== null && (
              <Button size="sm" variant="secondary" icon={<Users className="size-3.5" />} onClick={() => setGroup(true)} data-testid="dining-group-open">
                同组汇总
              </Button>
            )}
          </span>
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
      {group && visitId !== null && <GroupSummaryDialog visitId={visitId} onClose={() => setGroup(false)} />}
    </Card>
  );
}

/**
 * 同组汇总（福田店 CY-01，2026-11-26）：同组客人分别点的单一屏看全——每位客人点过的菜（退掉的不算）的单价、份数、金额，与全组合计。
 * 没有同组的只列这一位
 */
function GroupSummaryDialog({ visitId, onClose }: { visitId: number; onClose: () => void }) {
  const q = useQuery({ queryKey: ['dining', 'group', visitId], queryFn: () => api.get<DiningGroupSummary>(`/api/dining/group?visit=${visitId}`) });
  const d = q.data;
  return (
    <Dialog open onClose={onClose} title="同组汇总" description="同组客人点过的菜（退掉的不算）：单价、份数与合计" width="max-w-[520px]">
      {q.isPending ? (
        <Skeleton className="h-40" />
      ) : q.isError && !d ? (
        <LoadFailed title="同组汇总加载失败" onRetry={() => void q.refetch()} retrying={q.isFetching} testId="dining-group-error">
          {errorMessage(q.error)}
        </LoadFailed>
      ) : d ? (
        <div className="space-y-4" data-testid="dining-group">
          {d.groupId === null && <p className="text-[12.5px] text-ink-3">这位客人没有同组的客人，只列他自己的。</p>}
          {d.members.map((m) => (
            <section key={m.visitId} className="rounded-lg border border-line px-3 py-2" data-testid={`dining-group-${m.tagCode}`}>
              <p className="flex flex-wrap items-baseline gap-2">
                <span className="num text-[15px] font-bold text-ink">手牌 {m.tagCode}</span>
                <span className="text-[13px] text-ink-2">{m.guest}</span>
                {m.closed && <Badge tone="neutral">已离店</Badge>}
                <span className="ml-auto text-[12.5px] text-ink-3">
                  <span className="num">{m.quantity}</span> 份 · <Money cents={m.amount} className="font-bold text-ink" />
                </span>
              </p>
              {m.lines.length === 0 ? (
                <p className="mt-1 text-[12.5px] text-ink-3">没有点过</p>
              ) : (
                <ul className="mt-1 text-[13px]">
                  {m.lines.map((l) => (
                    <li key={l.billLineId} className="flex items-baseline gap-2 border-t border-line/60 py-1" data-testid={`dining-group-line-${l.name}`}>
                      <span className="min-w-0 flex-1 truncate">{l.name}</span>
                      <Money cents={l.unitPrice} className="num w-20 text-right text-ink-3" />
                      <span className="num w-10 text-right text-ink-2">×{l.quantity}</span>
                      <Money cents={l.amount} className="num w-20 text-right font-semibold" />
                    </li>
                  ))}
                </ul>
              )}
            </section>
          ))}
          <p className="flex items-baseline justify-end gap-2 border-t border-line pt-2 text-[13px] text-ink-3" data-testid="dining-group-total">
            全组共 <span className="num font-semibold text-ink-2">{d.quantity}</span> 份，合计 <Money cents={d.amount} className="text-[20px] font-bold text-ink" />
          </p>
        </div>
      ) : null}
    </Dialog>
  );
}
