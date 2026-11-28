// 收银台规则（8.2.1，docs/V8221_CASHIER.md）：单项打折每一档的下限、手牌押金先填好的金额。存在前台规则里（frontdesk_rules），
// 只改这几项（服务端在规则锁里合并）。下限的具体数值待店主定（docs/PENDING_DECISIONS.md 8.2.1-1），默认九折 / 七折 / 五折 / 能免单。
import { useEffect, useState } from 'react';
import type { FrontdeskRules } from '@shared/frontdesk';
import { DEFAULT_LINE_DISCOUNT_FLOORS, floorLabel, LINE_DISCOUNT_TIER_LABELS, LINE_DISCOUNT_TIERS, type LineDiscountFloors } from '@shared/line-discount';
import { centsToInput, parseYuan } from '@shared/money';
import { MAX_TAG_DEPOSIT } from '@shared/tag-deposit';
import { parseRate, rateText } from '@shared/cashier-v8230';
import { api, errorMessage } from '../../lib/api';
import { Button, Card, Field, Input, MoneyInput, Notice, PendingBadge, SectionTitle } from '../../components/ui';

export function CashierRulesCard({ rules, onSaved }: { rules: FrontdeskRules | undefined; onSaved: () => void }) {
  const [floors, setFloors] = useState<Record<keyof LineDiscountFloors, string>>({ cashier: '', duty: '', lead: '', owner: '' });
  const [deposit, setDeposit] = useState('');
  // 8.2.30：港元汇率（空 = 不收港元）、大额找零门槛、交班盲点
  const [rate, setRate] = useState('');
  const [bigChange, setBigChange] = useState('');
  const [blind, setBlind] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!rules) return;
    const f = rules.lineDiscountFloors ?? DEFAULT_LINE_DISCOUNT_FLOORS;
    setFloors({ cashier: String(f.cashier), duty: String(f.duty), lead: String(f.lead), owner: String(f.owner) });
    setDeposit(centsToInput(rules.tagDepositDefaultCents ?? 0));
    setRate(rules.hkdRatePpm ? rateText(rules.hkdRatePpm) : '');
    setBigChange(centsToInput(rules.bigChangeCents ?? 50000));
    setBlind(rules.shiftBlind ?? false);
  }, [rules]);

  const parsed = Object.fromEntries(LINE_DISCOUNT_TIERS.map((t) => [t, Number(floors[t])])) as LineDiscountFloors;
  const depositCents = deposit.trim() === '' ? 0 : parseYuan(deposit);
  const ratePpm = rate.trim() === '' ? null : parseRate(rate);
  const bigChangeCents = parseYuan(bigChange);
  const problem = LINE_DISCOUNT_TIERS.some((t) => floors[t].trim() === '' || !Number.isInteger(parsed[t]) || parsed[t] < 0 || parsed[t] > 100)
    ? '下限填 0–100 的整数（90 = 最低九折，0 = 能免单，100 = 不能打折）'
    : !(parsed.cashier >= parsed.duty && parsed.duty >= parsed.lead && parsed.lead >= parsed.owner)
      ? '高一档的下限不能比低一档还高（前台收银 ≥ 值班经理 ≥ 部门负责人 ≥ 店主）'
      : depositCents === null || depositCents < 0 || depositCents > MAX_TAG_DEPOSIT
        ? '押金金额不正确'
        : rate.trim() !== '' && ratePpm === null
          ? '港元汇率填 0.5–1.5 之间的数，例如 0.92；不收港元就空着'
          : bigChangeCents === null || bigChangeCents <= 0
            ? '大额找零的门槛要大于 0'
            : null;

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.put('/api/frontdesk/rules', { lineDiscountFloors: parsed, tagDepositDefaultCents: depositCents, hkdRatePpm: ratePpm, bigChangeCents, shiftBlind: blind });
      onSaved();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="p-5" data-testid="cashier-rules">
      <SectionTitle>
        <span className="flex items-center gap-1.5">
          收银台：单项打折与押金 <PendingBadge title="8.2.1：各档下限默认 90 / 70 / 50 / 0，待店主确认（docs/PENDING_DECISIONS.md 8.2.1-1）" />
        </span>
      </SectionTitle>
      <p className="mt-1 text-[12.5px] text-ink-3">下限是最低能打到收原价的百分之几：90 就是最低九折，0 是能免单。超过自己那一档的，请岗位下限够的人当场授权。打过折的一行不再用券、次卡、会员折扣。</p>
      <div className="mt-3 grid gap-4 sm:grid-cols-2">
        {LINE_DISCOUNT_TIERS.map((t) => (
          <Field key={t} label={`${LINE_DISCOUNT_TIER_LABELS[t]}的下限`} hint={Number.isInteger(parsed[t]) && floors[t].trim() !== '' ? floorLabel(parsed[t]) : undefined}>
            <Input
              value={floors[t]}
              onChange={(e) => setFloors((f) => ({ ...f, [t]: e.target.value }))}
              inputMode="numeric"
              className="num"
              aria-label={`${LINE_DISCOUNT_TIER_LABELS[t]}的下限`}
              data-testid={`floor-${t}`}
            />
          </Field>
        ))}
        <Field label="手牌押金先填好的金额（元）" hint="收押金时先填好，可以改；填 0 不预填">
          <MoneyInput value={deposit} onChange={(e) => setDeposit(e.target.value)} aria-label="手牌押金默认金额" data-testid="rules-tag-deposit" />
        </Field>
        <Field label="港元汇率（1 港元折多少人民币）" hint="例如 0.92；空着 = 不收港元。结账时记下当时的汇率，以后改不影响已结的单">
          <Input value={rate} onChange={(e) => setRate(e.target.value)} inputMode="decimal" className="num" aria-label="港元汇率" data-testid="rules-hkd-rate" />
        </Field>
        <Field label="大额找零要多确认一次（元）" hint="现金找零超过这个数，或超过这笔的 2 倍，结账时要再按一次「确认结清」">
          <MoneyInput value={bigChange} onChange={(e) => setBigChange(e.target.value)} aria-label="大额找零门槛" data-testid="rules-big-change" />
        </Field>
        <label className="flex items-start gap-2 text-[13px] text-ink-2 sm:col-span-2">
          <input type="checkbox" checked={blind} onChange={(e) => setBlind(e.target.checked)} className="mt-0.5" data-testid="rules-shift-blind" />
          <span>
            <span className="font-semibold">交班盲点</span>：交班时先点钱、填实点，提交以后才显示应有现金和长短款
          </span>
        </label>
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <Button variant="primary" disabled={!rules || !!problem} loading={busy} onClick={save} data-testid="cashier-rules-save">
          保存收银台规则
        </Button>
        {problem && <span className="text-[13px] text-clay">{problem}</span>}
      </div>
      {error && <Notice tone="error" title={error} className="mt-3" />}
    </Card>
  );
}
