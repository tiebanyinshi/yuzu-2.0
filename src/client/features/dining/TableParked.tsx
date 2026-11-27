// 8.1.39 包房转挂账（批房挂账，docs/V8139.md 第 4 节）：桌台页上方「挂账中」——转了挂账、还没结的单，点「结账」照常结。
// 8.2.4（docs/V8224_DINING.md 第 4 节）：低消没够的包房单可以「返台」回到原来的桌台继续点（要「返台」权限、写原因）。

import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { formatDateTime } from '../../lib/utils';
import { Money } from '../../components/Money';
import { Button } from '../../components/ui';

interface Parked {
  id: number;
  sessionNo: string;
  tableName: string;
  guestLabel: string;
  memberName: string | null;
  amount: number;
  parkedAt: string;
  parkedByName: string;
  reason: string;
}

export const parkedKey = ['dining', 'tables-parked'] as const;

export function ParkedPanel({
  canCheckout,
  onOpen,
  onCheckout,
  onReturn,
}: {
  canCheckout: boolean;
  onOpen: (id: number) => void;
  onCheckout: (id: number) => void;
  /** 8.2.4：返台（有「返台」权限才传） */
  onReturn?: (id: number) => void;
}) {
  const q = useQuery({ queryKey: parkedKey, queryFn: () => api.get<{ parked: Parked[] }>('/api/dining/tables/parked') });
  const list = q.data?.parked ?? [];
  if (list.length === 0) return null;
  return (
    <section className="rounded-lg border border-clay/40 bg-clay-soft/30 px-3 py-2.5" data-testid="tables-parked">
      <h3 className="text-[13.5px] font-bold">挂账中 · {list.length} 张</h3>
      <ul className="mt-1.5 divide-y divide-line/70">
        {list.map((p) => (
          <li key={p.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-1.5 text-[13px]" data-testid={`tables-parked-${p.sessionNo}`}>
            <button type="button" className="num font-bold text-pine hover:underline" onClick={() => onOpen(p.id)}>
              桌 {p.tableName}
            </button>
            <span className="text-ink-2">{p.memberName ?? (p.guestLabel || '散客')}</span>
            <span className="min-w-0 flex-1 truncate text-ink-3">
              {formatDateTime(p.parkedAt)} {p.parkedByName}：{p.reason}
            </span>
            <Money cents={p.amount} className="font-bold" />
            {onReturn && (
              <Button size="sm" variant="secondary" onClick={() => onReturn(p.id)} data-testid={`tables-parked-return-${p.sessionNo}`}>
                返台
              </Button>
            )}
            {canCheckout && (
              <Button size="sm" variant="primary" onClick={() => onCheckout(p.id)} data-testid={`tables-parked-checkout-${p.sessionNo}`}>
                结账
              </Button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
