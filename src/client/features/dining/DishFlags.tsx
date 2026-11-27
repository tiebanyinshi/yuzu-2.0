// 8.2.30 出品单的标记与分次上菜（docs/V8230_CASHIER.md 第 4 节，CM-16、CM-19）：点单页「还没上的菜」与桌台明细共用。
//   · 标记：等叫（还没开始做的才能标；点「起菜」厨房才做）、加急、打包——只是标记，不动金额；
//   · 分次上菜：出餐以后一行几份可以先上 1 份，上齐了才算已上菜。
import type { PendingDish } from '@shared/dining';
import { api } from '../../lib/api';
import { Badge, Button } from '../../components/ui';

type Run = (key: string, fn: () => Promise<unknown>, ok: string) => unknown;

/** 菜名旁边的标记：等叫、加急、打包、已上几份 */
export function DishFlagBadges({ p }: { p: { hold?: boolean; urgent?: boolean; takeaway?: boolean; servedQty?: number; quantity: number; status: string } }) {
  return (
    <>
      {p.hold && <Badge tone="lake">等叫</Badge>}
      {p.urgent && <Badge tone="clay">加急</Badge>}
      {p.takeaway && <Badge tone="neutral">打包</Badge>}
      {p.status === 'done' && (p.servedQty ?? 0) > 0 && (
        <Badge tone="pine">
          已上 {p.servedQty}/{p.quantity}
        </Badge>
      )}
    </>
  );
}

const flags = (ids: number[], patch: { hold?: boolean; urgent?: boolean; takeaway?: boolean }) => api.post('/api/dining/items/flags', { ids, ...patch });

/** 一道菜的标记按钮（有点单权限的人）与分次上菜 */
export function DishFlagButtons({ p, run, busy, testPrefix }: { p: PendingDish; run: Run; busy: string | null; testPrefix: string }) {
  const b = (key: string, label: string, patch: { hold?: boolean; urgent?: boolean; takeaway?: boolean }, ok: string) => (
    <Button size="sm" variant="ghost" loading={busy === `${key}-${p.id}`} onClick={() => void run(`${key}-${p.id}`, () => flags([p.id], patch), ok)} data-testid={`${testPrefix}-${key}-${p.id}`}>
      {label}
    </Button>
  );
  return (
    <>
      {p.status === 'queued' && (p.hold ? b('fire', '起菜', { hold: false }, `${p.name} 已起菜`) : b('hold', '等叫', { hold: true }, `${p.name} 等叫`))}
      {p.status !== 'done' && b('urgent', p.urgent ? '取消加急' : '加急', { urgent: !p.urgent }, `${p.name} ${p.urgent ? '取消加急' : '加急'}`)}
      {b('takeaway', p.takeaway ? '不打包' : '打包', { takeaway: !p.takeaway }, `${p.name} ${p.takeaway ? '不打包' : '打包'}`)}
      {p.status === 'done' && p.quantity - (p.servedQty ?? 0) > 1 && (
        <Button
          size="sm"
          variant="secondary"
          loading={busy === `serve1-${p.id}`}
          onClick={() => void run(`serve1-${p.id}`, () => api.post(`/api/kitchen/items/${p.id}/serve`, { from: 'done', quantity: 1 }), `${p.name} 先上 1 份`)}
          data-testid={`${testPrefix}-serve1-${p.id}`}
        >
          先上 1 份
        </Button>
      )}
    </>
  );
}

/** 整单等叫 / 起菜（还没开始做的几道） */
export function HoldAllButton({ pending, run, busy, testPrefix }: { pending: PendingDish[]; run: Run; busy: string | null; testPrefix: string }) {
  const queued = pending.filter((p) => p.status === 'queued');
  if (queued.length < 2) return null;
  const allHeld = queued.every((p) => p.hold);
  return (
    <Button
      size="sm"
      variant="secondary"
      loading={busy === 'hold-all'}
      onClick={() =>
        void run(
          'hold-all',
          () =>
            flags(
              queued.map((p) => p.id),
              { hold: !allHeld },
            ),
          allHeld ? '整单起菜' : '整单等叫',
        )
      }
      data-testid={`${testPrefix}-hold-all`}
    >
      {allHeld ? '整单起菜' : '整单等叫'}
    </Button>
  );
}
