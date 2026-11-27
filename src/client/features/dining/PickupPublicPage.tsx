// 客人扫小票二维码看水吧取餐进度（8.2.19，docs/V82219_WATER_BAR.md）：不用登录，只认二维码里的随机编号，只看这一单。
// 10 秒刷新（页面在后台不取）；做好了显示「请取餐」。
import { useState } from 'react';
import { useParams } from 'react-router';
import { PICKUP_STATE_LABELS, pickupLabel, type PickupProgress } from '@shared/dining-meals';
import { useLivePoll } from '../../lib/livePoll';
import { cn } from '../../lib/utils';

export function PickupPublicPage() {
  const { token = '' } = useParams();
  const [data, setData] = useState<PickupProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  useLivePoll(
    async (isLive) => {
      try {
        const r = await fetch(`/api/public/pickup/${encodeURIComponent(token)}`);
        const body = (await r.json()) as PickupProgress & { error?: { message: string } };
        if (!isLive()) return;
        if (!r.ok) setError(body.error?.message ?? '取餐码不存在');
        else {
          setData(body);
          setError(null);
        }
      } catch {
        if (isLive()) setError('网络不通，稍后会自动再试');
      }
    },
    [token],
    { intervalMs: 10_000 },
  );
  return (
    <main className="min-h-dvh bg-paper px-5 py-10 text-ink" data-testid="pickup-public">
      <div className="mx-auto max-w-sm text-center">
        <p className="text-[14px] text-ink-3">水吧取餐号</p>
        {data ? (
          <>
            <p className="num mt-2 text-[56px] leading-none font-bold" data-testid="pickup-public-no">
              {pickupLabel(data.pickupNo)}
            </p>
            <p
              className={cn(
                'mt-4 inline-block rounded-full px-5 py-2 text-[20px] font-bold',
                data.state === 'ready' ? 'bg-pine text-white' : data.state === 'making' ? 'bg-yuzu-soft text-yuzu-deep' : 'bg-paper-2 text-ink-3',
              )}
              data-testid="pickup-public-state"
            >
              {PICKUP_STATE_LABELS[data.state]}
            </p>
            {data.state === 'making' && <p className="mt-3 text-[15px] text-ink-2">前面还有 {data.ahead} 单</p>}
            <ul className="mt-6 space-y-1 text-left text-[15px]">
              {data.items.map((i, n) => (
                <li key={n} className="flex justify-between border-b border-line py-1.5">
                  <span>{i.name}</span>
                  <span className="text-ink-3">× {i.quantity}</span>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <p className="mt-6 text-[15px] text-ink-3">{error ?? '读取中…'}</p>
        )}
      </div>
    </main>
  );
}
