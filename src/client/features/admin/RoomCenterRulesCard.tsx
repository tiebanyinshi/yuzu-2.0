// 后台「空间台账 → 房态中心房型」下面的「房态中心规则」（福田店整改 2026-11-26，docs/FUTIAN_1126.md 第 5 节）：
//   三个时限——换技师（FT-06）、撤房免费（FT-09）、下钟后免房费（FT-10），默认都是 15 分钟，0 为不开；
//   房间按时间计费（FT-17 ④）——按业态设：计费项目（价格 = 每小时多少）、起步、计费单位、封顶，默认不开。
//   虫洞（FT-18）——哪几种业态是虫洞位、清洁时段、费用项目；零售与杂项（FT-17 ②③）能挂的分类。

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2 } from 'lucide-react';
import { centsToInput, formatYuan, parseYuan } from '@shared/money';
import type { RoomCategoriesAdmin } from '@shared/room-center';
import { MAX_CLEAN_WINDOWS, MAX_RULE_MINUTES, ROOM_FEE_STEP_OPTIONS, type RoomCenterRules, type RoomFeeRule } from '@shared/room-center-rules';
import { api, errorMessage } from '../../lib/api';
import { useCatalog } from '../../lib/queries';
import { LoadFailed } from '../../components/LoadFailed';
import { useToast } from '../../components/Toast';
import { Button, Card, Field, Input, MoneyInput, Notice, SectionTitle, Select, Skeleton } from '../../components/ui';

const KEY = ['admin', 'room-center-rules'] as const;

type FeeDraft = Omit<RoomFeeRule, 'capCents' | 'minMinutes'> & { cap: string; minMinutes: string };
interface Draft {
  swapTechMinutes: string;
  revokeMinutes: string;
  freeAfterClockOffMinutes: string;
  roomFees: FeeDraft[];
  /** FT-18 虫洞：哪几种业态（顿号或逗号分开）、清洁时段、费用项目 */
  wormholeTypes: string;
  cleanWindows: { start: string; end: string }[];
  wormholeFeeItemId: number | null;
  /** FT-17 零售与杂项能挂的分类（顿号或逗号分开） */
  goods: string;
}
const splitList = (v: string) => [
  ...new Set(
    v
      .split(/[、,，\s]+/)
      .map((x) => x.trim())
      .filter(Boolean),
  ),
];

const toDraft = (r: RoomCenterRules): Draft => ({
  swapTechMinutes: String(r.swapTechMinutes),
  revokeMinutes: String(r.revokeMinutes),
  freeAfterClockOffMinutes: String(r.freeAfterClockOffMinutes),
  roomFees: r.roomFees.map((f) => ({ ...f, minMinutes: String(f.minMinutes), cap: f.capCents ? centsToInput(f.capCents) : '' })),
  wormholeTypes: r.wormhole.businessTypes.join('、'),
  cleanWindows: r.wormhole.cleanWindows,
  wormholeFeeItemId: r.wormhole.feeItemId,
  goods: r.goodsCategories.join('、'),
});

const LIMITS = [
  { key: 'swapTechMinutes', label: '换技师时限', hint: '上钟后多少分钟内可以在房态中心换技师（FT-06）' },
  { key: 'revokeMinutes', label: '撤房免费时限', hint: '开房后多少分钟内可以撤房，不收费（FT-09）' },
  { key: 'freeAfterClockOffMinutes', label: '下钟后免房费', hint: '技师下钟后多少分钟内不收房间费用（FT-10）' },
] as const;

export function RoomCenterRulesCard() {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: KEY, queryFn: () => api.get<RoomCenterRules>('/api/admin/room-center-rules') });
  const cats = useQuery({ queryKey: ['admin', 'room-categories'], queryFn: () => api.get<RoomCategoriesAdmin>('/api/admin/room-categories') });
  const catalog = useCatalog();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [seen, setSeen] = useState<RoomCenterRules | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (q.data && q.data !== seen) {
    setSeen(q.data);
    setDraft(toDraft(q.data));
  }
  if (q.isPending || !draft) return q.isError ? <LoadFailed title="房态中心规则没取回来" onRetry={() => void q.refetch()} retrying={q.isFetching} /> : <Skeleton className="h-48" />;
  // 能按时间计费的：技师服务的房间那几类房型里的业态
  const types = [...new Set((cats.data?.categories ?? []).filter((c) => c.active && c.source === 'service').flatMap((c) => c.businessTypes))];
  const freeTypes = types.filter((t) => !draft.roomFees.some((f) => f.businessType === t));
  const items = (catalog.data?.items ?? []).filter((i) => i.active);
  const setFee = (i: number, patch: Partial<FeeDraft>) => setDraft({ ...draft, roomFees: draft.roomFees.map((f, k) => (k === i ? { ...f, ...patch } : f)) });

  const save = async () => {
    const minutes = (v: string, label: string) => {
      const n = Number(v);
      if (!/^\d+$/.test(v.trim()) || n > MAX_RULE_MINUTES) throw new Error(`${label}填 0–${MAX_RULE_MINUTES} 的整数分钟`);
      return n;
    };
    setError(null);
    let body: RoomCenterRules;
    try {
      body = {
        swapTechMinutes: minutes(draft.swapTechMinutes, '换技师时限'),
        revokeMinutes: minutes(draft.revokeMinutes, '撤房免费时限'),
        freeAfterClockOffMinutes: minutes(draft.freeAfterClockOffMinutes, '下钟后免房费'),
        roomFees: draft.roomFees.map((f) => {
          const cap = f.cap.trim() ? parseYuan(f.cap) : 0;
          if (cap === null) throw new Error(`「${f.businessType}」的封顶金额格式不正确`);
          if (f.enabled && !f.feeItemId) throw new Error(`「${f.businessType}」开了计费，要选计费项目`);
          return { businessType: f.businessType, enabled: f.enabled, feeItemId: f.feeItemId, minMinutes: Number(f.minMinutes) || 0, stepMinutes: f.stepMinutes, capCents: cap };
        }),
        wormhole: {
          businessTypes: splitList(draft.wormholeTypes),
          cleanWindows: draft.cleanWindows.map((w) => {
            if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(w.start) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(w.end)) throw new Error('清洁时段写成 08:00–08:30 这样');
            return w;
          }),
          feeItemId: draft.wormholeFeeItemId,
        },
        goodsCategories: splitList(draft.goods),
      };
    } catch (e) {
      return setError((e as Error).message);
    }
    setBusy(true);
    try {
      const next = await api.put<RoomCenterRules>('/api/admin/room-center-rules', body);
      qc.setQueryData(KEY, next);
      void qc.invalidateQueries({ queryKey: ['room-center'] });
      toast({ tone: 'success', title: '房态中心规则已保存' });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="space-y-4 p-5" data-testid="room-center-rules">
      <div className="flex flex-wrap items-center gap-3">
        <SectionTitle className="flex-1">房态中心规则</SectionTitle>
        <Button variant="primary" className="h-11" loading={busy} onClick={() => void save()} data-testid="rc-rules-save">
          保存
        </Button>
      </div>
      <p className="text-[13px] text-ink-2">三个时限默认都是 15 分钟；填 0 是不开（不让换技师 / 不让撤房 / 下钟马上计房费）。</p>
      <div className="grid gap-4 sm:grid-cols-3">
        {LIMITS.map((l) => (
          <Field key={l.key} label={`${l.label}（分钟）`} htmlFor={`rc-rule-${l.key}`} hint={l.hint}>
            <Input
              id={`rc-rule-${l.key}`}
              inputMode="numeric"
              className="num"
              value={draft[l.key]}
              onChange={(e) => setDraft({ ...draft, [l.key]: e.target.value.replace(/[^\d]/g, '') })}
              data-testid={`rc-rule-${l.key}`}
            />
          </Field>
        ))}
      </div>

      <div className="space-y-2 border-t border-line pt-4" data-testid="rc-rule-fees">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="flex-1 text-[14px] font-bold text-ink">房间按时间计费（FT-17）</h3>
          <Select
            fullWidth={false}
            className="w-40"
            value=""
            aria-label="给哪种业态加计费规则"
            disabled={freeTypes.length === 0}
            onChange={(e) =>
              e.target.value && setDraft({ ...draft, roomFees: [...draft.roomFees, { businessType: e.target.value, enabled: true, feeItemId: null, minMinutes: '60', stepMinutes: 30, cap: '' }] })
            }
            data-testid="rc-rule-fee-add"
          >
            <option value="">{freeTypes.length ? '＋ 加一种业态' : '业态都设过了'}</option>
            {freeTypes.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </Select>
        </div>
        <p className="text-[12.5px] text-ink-3">
          计费从最后一位技师下钟、过了上面的免费时长开始，到退房为止；不足起步按起步，之后每个计费单位收一次（不足一个单位按一个单位）；价格是所选项目的每小时价。退房时记在先登记的那位客人的手牌上。没设的业态不收房费。
        </p>
        {draft.roomFees.length === 0 ? (
          <p className="rounded-lg border border-dashed border-line-strong px-3 py-3 text-center text-[13px] text-ink-3">还没有设房间计费（默认不收房费）</p>
        ) : (
          draft.roomFees.map((f, i) => {
            const item = items.find((it) => it.id === f.feeItemId);
            return (
              <div
                key={f.businessType}
                className="grid items-end gap-2 rounded-lg border border-line p-3 sm:grid-cols-[110px_minmax(0,1fr)_90px_100px_110px_auto]"
                data-testid={`rc-rule-fee-${f.businessType}`}
              >
                <label className="flex items-center gap-2 text-[14px] font-bold">
                  <input
                    type="checkbox"
                    className="size-4 accent-pine"
                    checked={f.enabled}
                    onChange={(e) => setFee(i, { enabled: e.target.checked })}
                    aria-label={`${f.businessType}按时间计费`}
                    data-testid="rc-rule-fee-enabled"
                  />
                  {f.businessType}
                </label>
                <Field label="计费项目（每小时价）">
                  <Select value={f.feeItemId ?? ''} onChange={(e) => setFee(i, { feeItemId: e.target.value ? Number(e.target.value) : null })} data-testid="rc-rule-fee-item">
                    <option value="">选一个项目</option>
                    {items.map((it) => (
                      <option key={it.id} value={it.id}>
                        {it.catalogCode ? `${it.catalogCode} ` : ''}
                        {it.name} · {formatYuan(it.price)}/小时
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="起步（分钟）">
                  <Input inputMode="numeric" className="num" value={f.minMinutes} onChange={(e) => setFee(i, { minMinutes: e.target.value.replace(/[^\d]/g, '') })} data-testid="rc-rule-fee-min" />
                </Field>
                <Field label="计费单位">
                  <Select value={f.stepMinutes} onChange={(e) => setFee(i, { stepMinutes: Number(e.target.value) })} data-testid="rc-rule-fee-step">
                    {ROOM_FEE_STEP_OPTIONS.map((m) => (
                      <option key={m} value={m}>
                        {m} 分钟
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="封顶（元）" hint={item ? undefined : '空 = 不封顶'}>
                  <MoneyInput value={f.cap} onChange={(e) => setFee(i, { cap: e.target.value })} placeholder="不封顶" data-testid="rc-rule-fee-cap" />
                </Field>
                <Button
                  variant="ghost"
                  icon={<Trash2 className="size-4" />}
                  aria-label={`删掉${f.businessType}的计费规则`}
                  onClick={() => setDraft({ ...draft, roomFees: draft.roomFees.filter((_, k) => k !== i) })}
                />
              </div>
            );
          })
        )}
        {types.length === 0 && (
          <Notice tone="info" icon={<Plus className="size-4" />} title="还没有「技师服务的房间」类的房型">
            先在上面建房型，再给业态设计费。
          </Notice>
        )}
      </div>
      <div className="space-y-2 border-t border-line pt-4" data-testid="rc-rule-wormhole">
        <h3 className="text-[14px] font-bold text-ink">虫洞（FT-18）</h3>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="虫洞位的业态" htmlFor="rc-rule-wormhole-types" hint="空间台账里的业态，多个用顿号分开">
            <Input id="rc-rule-wormhole-types" value={draft.wormholeTypes} onChange={(e) => setDraft({ ...draft, wormholeTypes: e.target.value })} data-testid="rc-rule-wormhole-types" />
          </Field>
          <Field label="费用项目" hint="下单时挂到手牌上；不选是不收费">
            <Select
              value={draft.wormholeFeeItemId ?? ''}
              onChange={(e) => setDraft({ ...draft, wormholeFeeItemId: e.target.value ? Number(e.target.value) : null })}
              data-testid="rc-rule-wormhole-fee"
            >
              <option value="">不收费</option>
              {items.map((it) => (
                <option key={it.id} value={it.id}>
                  {it.catalogCode ? `${it.catalogCode} ` : ''}
                  {it.name} · {formatYuan(it.price)}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <Field label="清洁时段" hint="每天这几段时间里没人的虫洞是待清（打扫），其余时间没人是空闲；跨零点的写成 23:00–01:00">
          <div className="flex flex-wrap items-center gap-2">
            {draft.cleanWindows.map((w, i) => (
              <span key={i} className="flex items-center gap-1" data-testid={`rc-rule-clean-${i}`}>
                <Input
                  type="time"
                  fullWidth={false}
                  className="w-28"
                  value={w.start}
                  onChange={(e) => setDraft({ ...draft, cleanWindows: draft.cleanWindows.map((x, k) => (k === i ? { ...x, start: e.target.value } : x)) })}
                  aria-label="开始"
                />
                –
                <Input
                  type="time"
                  fullWidth={false}
                  className="w-28"
                  value={w.end}
                  onChange={(e) => setDraft({ ...draft, cleanWindows: draft.cleanWindows.map((x, k) => (k === i ? { ...x, end: e.target.value } : x)) })}
                  aria-label="结束"
                />
                <Button size="sm" variant="ghost" onClick={() => setDraft({ ...draft, cleanWindows: draft.cleanWindows.filter((_, k) => k !== i) })} aria-label="删掉这一段">
                  删
                </Button>
              </span>
            ))}
            {draft.cleanWindows.length < MAX_CLEAN_WINDOWS && (
              <Button
                size="sm"
                variant="secondary"
                icon={<Plus className="size-3.5" />}
                onClick={() => setDraft({ ...draft, cleanWindows: [...draft.cleanWindows, { start: '08:00', end: '08:30' }] })}
                data-testid="rc-rule-clean-add"
              >
                加一段
              </Button>
            )}
          </div>
        </Field>
      </div>

      <div className="border-t border-line pt-4">
        <Field label="零售与杂项能挂的分类（FT-17）" htmlFor="rc-rule-goods" hint="价目里这几个分类的项目能在房间里挂（香烟、扑克、清洁费……），多个用顿号分开">
          <Input id="rc-rule-goods" value={draft.goods} onChange={(e) => setDraft({ ...draft, goods: e.target.value })} data-testid="rc-rule-goods" />
        </Field>
      </div>
      {error && <Notice tone="error" title={error} data-testid="rc-rules-error" />}
    </Card>
  );
}
