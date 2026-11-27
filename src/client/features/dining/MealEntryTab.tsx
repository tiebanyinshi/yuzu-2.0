// 餐厅入口（8.2.8，docs/V8228_DINING_MEALS.md）：所有进餐厅的人刷手牌登记进餐——按此刻的餐段在手牌上记一行餐费，
// 含餐的这一行自动折成 0（「含餐」），裸票照时段价收；同一位客人同一餐只登记一次。登记以后在点单页点餐厅的菜也不另收（餐台自助）。
// 照前台的「结果待确认」：没收到回复时只能查回、按原内容重新提交或确认作废。
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { UtensilsCrossed } from 'lucide-react';
import { AUTO_DISCOUNT_LABELS, MEAL_PERIOD_LABELS, mealPeriodAt, mealPeriodRange, type MealEntryPreview, type MealEntryRow, type MealPeriod } from '@shared/dining-meals';
import { formatYuan } from '@shared/money';
import { api, errorMessage } from '../../lib/api';
import { useLivePoll } from '../../lib/livePoll';
import { useSession } from '../../lib/session';
import { cn, formatTime } from '../../lib/utils';
import { Money } from '../../components/Money';
import { Button, Card, Notice } from '../../components/ui';
import { PendingPanel, useFrontdeskOp } from '../frontdesk/pending';
import type { TagByCard } from '@shared/frontdesk-risk';
import { TagCardInput } from '../frontdesk/TagCardInput';

export function MealEntryTab() {
  const session = useSession();
  const qc = useQueryClient();
  const [code, setCode] = useState('');
  const [preview, setPreview] = useState<MealEntryPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const list = useQuery({
    queryKey: ['dining', 'meal-entries'],
    queryFn: () => api.get<{ date: string; periods: MealPeriod[]; entries: MealEntryRow[] }>('/api/dining/meal-entries'),
  });
  // 别的入口也在登记：30 秒刷一次当天的列表（后台、断网时不取）
  useLivePoll(
    async () => {
      await qc.invalidateQueries({ queryKey: ['dining', 'meal-entries'] });
    },
    [qc],
    { intervalMs: 30_000 },
  );
  const op = useFrontdeskOp<unknown>({
    type: 'meal_entry',
    visitId: preview?.visitId ?? null,
    staffName: session.staff.displayName,
    pick: (f) => (f.found && f.type === 'meal_entered' ? f.visitId : null),
  });

  const look = async (tag: string) => {
    const t = tag.trim();
    if (!t) return;
    setError(null);
    setDone(null);
    try {
      setPreview(await api.get<MealEntryPreview>(`/api/dining/meal-entries/preview?tag=${encodeURIComponent(t)}`));
    } catch (e) {
      setPreview(null);
      setError(errorMessage(e));
    }
  };
  const register = async () => {
    if (!preview || op.locked) return;
    const r = (await op.submit((key) => ({
      url: '/api/dining/meal-entries',
      // 预览时屏幕上的收费一起带上：提交时对不上（刚改了价、含餐数）服务端要求重新刷牌核对
      body: { clientKey: key, tagCode: preview.tagCode, visitId: preview.visitId, expected: { period: preview.period!.key, kind: preview.kind, price: preview.period!.price } },
      tagCodes: [preview.tagCode],
      summary: `登记进餐 ${preview.period?.label ?? ''}`,
      amount: null,
    }))) as MealEntryPreview | null;
    if (!r) return;
    setDone(
      `${r.tagCode} 已登记${r.period?.label ?? ''}：${preview.kind === 'included' ? `含餐抵扣（还剩 ${Math.max(0, r.allowance - r.used)} 餐）` : `收 ${formatYuan(r.period?.price ?? 0)}，记在手牌上`}`,
    );
    setPreview(null);
    setCode('');
    void qc.invalidateQueries({ queryKey: ['dining'] });
  };

  const now = list.data ? mealPeriodAt(list.data.periods, new Date().getHours() * 60 + new Date().getMinutes()) : null;
  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,26rem)_1fr]" data-testid="meal-entry">
      <Card className="p-5">
        <h2 className="flex items-center gap-2 text-[17px] font-bold">
          <UtensilsCrossed className="size-5 text-yuzu-deep" /> 刷手牌进餐
        </h2>
        <p className="mt-1 text-[13px] text-ink-3" data-testid="meal-entry-period">
          {now ? `现在是${MEAL_PERIOD_LABELS[now.key]}（${mealPeriodRange(now)}），裸票 ${formatYuan(now.price)} / 位，含餐的抵扣` : '现在不是供餐时间（餐段在后台「餐饮规则」里设）'}
        </p>
        <div className="mt-4">
          <TagCardInput
            value={code}
            onChange={(v) => {
              setCode(v);
              setPreview(null);
              setError(null);
            }}
            onCard={(found) => {
              setCode(found.tag.code);
              void look(found.tag.code);
            }}
            onEnter={(e) => {
              e.preventDefault();
              void look(code);
            }}
            autoFocus
            placeholder="刷手牌或输入牌号，回车"
            ariaLabel="手牌号"
            inputClassName="num text-[20px] font-bold"
            testId="meal-entry-tag"
            // 刷卡按餐厅的权限查（平板没有前台读的权限）
            lookup={(uid) => api.get<TagByCard>(`/api/dining/tags/by-card?uid=${encodeURIComponent(uid)}`)}
          />
        </div>
        <PendingPanel op={op} onResolved={() => void qc.invalidateQueries({ queryKey: ['dining'] })} />
        {op.state.phase === 'error' && <Notice tone="error" title={op.state.message} className="mt-3" />}
        {error && <Notice tone="error" title={error} className="mt-3" />}
        {done && <Notice tone="success" title={done} className="mt-3" />}
        {preview && (
          <div className="mt-4 space-y-2 rounded-[14px] border border-line bg-paper-2/50 p-4 text-[14px]" data-testid="meal-entry-preview">
            <p>
              <b className="num text-[18px]">{preview.tagCode}</b> · {preview.guest} · {preview.ticketName ?? '没有票种'}
            </p>
            {!preview.period ? (
              <Notice tone="warning" title="现在不是供餐时间，不能登记" />
            ) : preview.entered ? (
              <Notice tone="warning" title={`今天的${preview.period.label}已经登记过了`} />
            ) : (
              <p data-testid="meal-entry-charge">
                {preview.period.label}（{preview.period.range}）：
                {preview.kind === 'included' ? (
                  <b className="text-pine">
                    含餐抵扣，本餐 ¥0（含 {preview.allowance} 餐，已用 {preview.used}）
                  </b>
                ) : (
                  <b className="text-clay">
                    收 <Money cents={preview.period.price} />（{preview.allowance > 0 ? '含的餐已用完' : '不含餐'}）
                  </b>
                )}
              </p>
            )}
            <Button variant="primary" className="w-full" disabled={!preview.period || preview.entered || op.locked} loading={op.busy} onClick={register} data-testid="meal-entry-submit">
              登记进餐
            </Button>
          </div>
        )}
      </Card>
      <Card className="p-5">
        <h3 className="text-[15px] font-bold">今天登记的（{list.data?.entries.length ?? 0}）</h3>
        <ul className="mt-2 divide-y divide-line text-[13.5px]" data-testid="meal-entry-list">
          {(list.data?.entries ?? []).map((e) => (
            <li key={e.id} className={cn('flex flex-wrap items-center gap-x-3 gap-y-1 py-2', e.voided && 'text-ink-3 line-through')}>
              <span className="num font-bold">{e.tagCode}</span>
              <span>{e.guest}</span>
              <span>{MEAL_PERIOD_LABELS[e.period]}</span>
              <span className={e.kind === 'included' ? 'text-pine' : 'text-ink-2'}>{e.kind === 'included' ? AUTO_DISCOUNT_LABELS.included_meal : <Money cents={e.price} />}</span>
              <span className="ml-auto text-[12px] text-ink-3">
                {e.staffName} {formatTime(e.at)}
              </span>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
