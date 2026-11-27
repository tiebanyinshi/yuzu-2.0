// 水吧取餐叫号屏（8.2.18，docs/V82218_WATER_BAR.md）：今天制作中、请取餐的号，5 秒刷新；可以放在水吧门口的大屏上。
// 做好了在「厨房出品」里点「出餐」就变成「请取餐」，客人取走点「上菜」就从屏上消失。
import { useState } from 'react';
import { pickupLabel, type PickupBoard } from '@shared/dining-meals';
import { api } from '../../lib/api';
import { useLivePoll } from '../../lib/livePoll';
import { Card } from '../../components/ui';

export function PickupBoardTab() {
  const [board, setBoard] = useState<PickupBoard | null>(null);
  useLivePoll(
    async (isLive) => {
      try {
        const b = await api.get<PickupBoard>('/api/dining/pickups');
        if (isLive()) setBoard(b);
      } catch {
        // 取不到等下一次
      }
    },
    [],
    { intervalMs: 5000 },
  );
  const col = (title: string, nums: number[], tone: string, testId: string) => (
    <Card className="p-5" data-testid={testId}>
      <h2 className={`text-[22px] font-bold ${tone}`}>
        {title}（{nums.length}）
      </h2>
      <div className="mt-3 flex flex-wrap gap-3">
        {nums.map((n) => (
          <span key={n} className="num rounded-xl border border-line px-4 py-2 text-[34px] leading-none font-bold">
            {pickupLabel(n)}
          </span>
        ))}
        {nums.length === 0 && <span className="text-[15px] text-ink-3">没有</span>}
      </div>
    </Card>
  );
  return (
    <div className="grid gap-4 md:grid-cols-2" data-testid="pickup-board">
      {col('请取餐', board?.ready ?? [], 'text-pine', 'pickup-ready')}
      {col('制作中', board?.making ?? [], 'text-yuzu-deep', 'pickup-making')}
    </div>
  );
}
