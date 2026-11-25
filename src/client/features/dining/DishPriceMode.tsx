// 8.1.39 菜品的计价方式（docs/V8139.md 第 2 节）：按价目 / 时价、杂项（点的时候填价）/ 称重（点的时候填斤数）。
// 在「改价」弹窗里，与改价同一项权限；选了就保存（只改以后点的，已经点了的照点的时候记的）。

import { useState } from 'react';
import { MAX_OPEN_PRICE, MAX_WEIGHT_CENTI_JIN, parseWeight, PRICE_MODE_HINTS, PRICE_MODE_LABELS, PRICE_MODES, weighedAmount, type PriceMode } from '@shared/dish-price-mode';
import type { MenuDish } from '@shared/dining';
import type { DishRow } from '@shared/dishes';
import { centsToInput, formatYuan, parseYuan } from '@shared/money';
import { api, errorMessage } from '../../lib/api';
import { useResetOnOpen } from '../../lib/useResetOnOpen';
import { Dialog } from '../../components/Overlay';
import { Button, Field, Input, MoneyInput, Notice, Segmented } from '../../components/ui';

export function DishPriceModeSection({ dish, onSaved }: { dish: DishRow; onSaved: (dish: DishRow) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const change = async (priceMode: PriceMode) => {
    if (priceMode === dish.priceMode || busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.post<{ id: number; priceMode: PriceMode }>(`/api/dining/dishes/${dish.id}/price-mode`, { priceMode });
      onSaved({ ...dish, priceMode: r.priceMode });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="space-y-2 border-t border-line pt-3" data-testid="dish-price-mode">
      <h3 className="text-[14px] font-bold">计价方式</h3>
      <Segmented
        ariaLabel="计价方式"
        value={dish.priceMode}
        onChange={(v) => void change(v)}
        options={PRICE_MODES.map((m) => ({ value: m, label: PRICE_MODE_LABELS[m], disabled: busy }))}
        className="flex-wrap"
      />
      <p className="text-[12.5px] leading-relaxed text-ink-3">{PRICE_MODE_HINTS[dish.priceMode]}。小程序扫码点餐、平板电子菜单点不了时价、称重的菜，要服务员点。</p>
      {error && <Notice tone="error" title={error} />}
    </section>
  );
}

/** 点单页点时价 / 杂项、称重的菜（8.1.39）：填这一项多少钱，或者几斤（每斤单价默认是价目的价，可以改） */
export function PriceEntryDialog({ dish, onClose, onAdd }: { dish: MenuDish | null; onClose: () => void; onAdd: (entry: { customPrice?: number; weight?: number }) => void }) {
  const [price, setPrice] = useState('');
  const [weight, setWeight] = useState('');
  useResetOnOpen(dish !== null, () => {
    setPrice(dish && dish.priceMode === 'weight' ? centsToInput(dish.price) : '');
    setWeight('');
  });
  if (!dish) return null;
  const isWeight = dish.priceMode === 'weight';
  const cents = price.trim() ? parseYuan(price) : null;
  const w = isWeight ? parseWeight(weight) : null;
  const problem =
    !cents || cents <= 0 || cents > MAX_OPEN_PRICE
      ? isWeight
        ? '请填每斤单价'
        : '请填这一项多少钱'
      : isWeight && w === null
        ? `请填几斤（最多两位小数、不超过 ${MAX_WEIGHT_CENTI_JIN / 100} 斤）`
        : null;
  const amount = !problem && cents ? (isWeight ? weighedAmount(cents, w!) : cents) : null;
  const confirm = () => {
    if (problem || !cents) return;
    onAdd(isWeight ? { weight: w!, ...(cents !== dish.price ? { customPrice: cents } : {}) } : { customPrice: cents });
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title={`${isWeight ? '称重' : '定价'} · ${dish.name}`}
      description={isWeight ? '填几斤；每斤单价默认是价目的价，时价的可以改。按单价 × 斤数记一份。' : '开瓶费、赔偿费、加工费、清洁费、时价菜：填这一项每份多少钱。'}
      width="max-w-md"
      footer={
        <>
          <Button variant="ghost" className="min-h-11" onClick={onClose}>
            取消
          </Button>
          <Button variant="primary" className="min-h-11" disabled={!!problem} onClick={confirm} data-testid="price-entry-add">
            {amount !== null ? `加进已点 · ${formatYuan(amount)}` : '加进已点'}
          </Button>
        </>
      }
    >
      <div className="grid gap-3" data-testid="price-entry">
        {isWeight && (
          <Field label="几斤" htmlFor="price-entry-weight">
            <Input id="price-entry-weight" inputMode="decimal" value={weight} onChange={(e) => setWeight(e.target.value)} placeholder="例如 1.35" data-autofocus data-testid="price-entry-weight" />
          </Field>
        )}
        <Field label={isWeight ? '每斤单价' : '每份多少钱'} htmlFor="price-entry-price">
          <MoneyInput id="price-entry-price" value={price} onChange={(e) => setPrice(e.target.value)} data-autofocus={!isWeight || undefined} data-testid="price-entry-price" />
        </Field>
        {problem && (price || weight) ? <p className="text-[13px] font-semibold text-clay">{problem}</p> : null}
      </div>
    </Dialog>
  );
}
