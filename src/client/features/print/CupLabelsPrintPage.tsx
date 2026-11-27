// 杯贴（8.2.30，docs/V8230_CASHIER.md 第 4 节，CM-21）：一单的饮品一杯一张——取餐号、品名、做法与备注、第几杯、手牌或桌号、下单时刻。
// 浏览器打印：贴纸打印机当普通打印机用（纸张按 80mm 小票的宽度排，每张之间分页）；厨房屏水吧的出品单上点「杯贴」。
import { useQuery } from '@tanstack/react-query';
import { useParams } from 'react-router';
import type { CupLabels } from '@shared/dining';
import { api, errorMessage } from '../../lib/api';
import { useSession } from '../../lib/session';
import { PrintFrame, stamp } from './PrintFrame';

export function CupLabelsPrintPage() {
  const orderNo = useParams().orderNo ?? '';
  const session = useSession();
  const q = useQuery({
    queryKey: ['print', 'cup-labels', orderNo],
    queryFn: () => api.get<CupLabels>(`/api/dining/cup-labels/${encodeURIComponent(orderNo)}`),
    enabled: orderNo.length > 0,
    refetchOnWindowFocus: false,
  });
  const d = q.data;
  return (
    <PrintFrame title={`杯贴 ${orderNo}`} ready={!!d} error={q.error ? errorMessage(q.error) : null}>
      {d && (
        <div data-testid="print-cup-labels">
          {d.labels.map((l) => (
            <div key={l.seq} className="break-after-page border-b border-dashed border-black py-2" data-testid="print-cup-label">
              <p className="flex items-baseline justify-between">
                <span className="text-[22px] font-bold">{d.pickupNo !== null ? `取餐号 A${String(d.pickupNo).padStart(3, '0')}` : d.where}</span>
                <span className="num text-[13px]">
                  {l.seq}/{d.total}
                </span>
              </p>
              <p className="mt-1 text-[17px] leading-snug font-bold">{l.name}</p>
              {l.note && <p className="mt-0.5 text-[14px] font-bold break-all">{l.note}</p>}
              <p className="mt-1 text-[11px]">
                {d.pickupNo !== null && d.where ? `${d.where} · ` : ''}
                {stamp(d.createdAt, session.timezone)} · {d.orderNo}
              </p>
            </div>
          ))}
        </div>
      )}
    </PrintFrame>
  );
}
