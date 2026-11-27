// 后台「餐饮规则」里的餐段与裸票餐费（8.2.8，docs/V8228_DINING_MEALS.md）：早餐、午餐、晚餐、夜宵的起止时间与价钱。
// 餐厅入口刷手牌按此刻的餐段记一行餐费（含餐的抵扣成 0）；价钱填 0 = 这一段不供餐。结束早于开始的跨过午夜（夜宵）。
import { MEAL_PERIOD_LABELS, mealPeriodRange, type MealPeriod } from '@shared/dining-meals';
import { centsToInput, parseYuan } from '@shared/money';
import { Input, PendingBadge } from '../../components/ui';

const toTime = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const fromTime = (v: string) => {
  const [h, m] = v.split(':').map(Number);
  return Number.isInteger(h) && Number.isInteger(m) ? h! * 60 + m! : NaN;
};

/** 有问题的写原因（保存前拦下）；没问题为 null */
export function mealPeriodsProblem(periods: readonly MealPeriod[]): string | null {
  for (const p of periods) {
    if (Number.isNaN(p.start) || Number.isNaN(p.end)) return `${MEAL_PERIOD_LABELS[p.key]}的时间没填好`;
    if (p.start === p.end) return `${MEAL_PERIOD_LABELS[p.key]}的开始和结束不能是同一时间`;
    if (!Number.isInteger(p.price) || p.price < 0) return `${MEAL_PERIOD_LABELS[p.key]}的餐费填 0 或以上的金额`;
  }
  return null;
}

export function MealPeriodsEditor({ value, onChange, editable }: { value: MealPeriod[]; onChange: (v: MealPeriod[]) => void; editable: boolean }) {
  const patch = (i: number, p: Partial<MealPeriod>) => onChange(value.map((x, j) => (j === i ? { ...x, ...p } : x)));
  return (
    <div className="py-3" data-testid="meal-periods">
      <p className="flex items-center gap-2 text-[14px] font-bold">
        餐段与裸票餐费
        <PendingBadge title="店主 2026-11-27 走场：早餐 / 夜宵 99、午餐 199、晚餐 299；时间先按常见做法定，待店主确认" />
      </p>
      <p className="mt-0.5 text-[12.5px] text-ink-3">餐厅入口刷手牌按此刻的餐段记一行餐费：票种含餐的抵扣成 0，裸票照这里的价钱收。餐费填 0 = 这一段不供餐；结束早于开始的跨过午夜。</p>
      <div className="mt-2 grid gap-2 sm:grid-cols-2">
        {value.map((p, i) => (
          <div key={p.key} className="flex flex-wrap items-center gap-2 rounded-lg border border-line px-3 py-2">
            <span className="w-10 text-[14px] font-bold">{MEAL_PERIOD_LABELS[p.key]}</span>
            <Input
              type="time"
              value={Number.isNaN(p.start) ? '' : toTime(p.start)}
              disabled={!editable}
              onChange={(e) => patch(i, { start: fromTime(e.target.value) })}
              className="num h-9 w-28"
              aria-label={`${MEAL_PERIOD_LABELS[p.key]}开始`}
              data-testid={`meal-period-${p.key}-start`}
            />
            <span className="text-ink-3">–</span>
            <Input
              type="time"
              value={Number.isNaN(p.end) ? '' : toTime(p.end)}
              disabled={!editable}
              onChange={(e) => patch(i, { end: fromTime(e.target.value) })}
              className="num h-9 w-28"
              aria-label={`${MEAL_PERIOD_LABELS[p.key]}结束`}
              data-testid={`meal-period-${p.key}-end`}
            />
            <span className="flex items-center gap-1">
              <span className="text-ink-3">¥</span>
              <Input
                inputMode="decimal"
                value={centsToInput(p.price)}
                disabled={!editable}
                onChange={(e) => patch(i, { price: parseYuan(e.target.value) ?? NaN })}
                className="num h-9 w-20"
                aria-label={`${MEAL_PERIOD_LABELS[p.key]}裸票餐费`}
                data-testid={`meal-period-${p.key}-price`}
              />
            </span>
            {!Number.isNaN(p.start) && !Number.isNaN(p.end) && p.end < p.start && <span className="text-[12px] text-ink-3">{mealPeriodRange(p)}</span>}
          </div>
        ))}
      </div>
    </div>
  );
}
