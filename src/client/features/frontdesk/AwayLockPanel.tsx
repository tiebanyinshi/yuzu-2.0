// 收银台「锁牌外出」（8.2.6，docs/V8226_AWAY_LOCK.md）：在店客人外出时锁住他的手牌（最多 4 小时），锁之前先收预售。
//   · 预售记成一张手牌押金（原因「锁牌外出预收」），预填此刻应收（明细 − 单项打折 + 门票 − 已押着的押金），至少是门店的默认押金；
//   · 锁着期间这张牌上不能挂账；客人回来点「客人回来解锁」；结账时自动解锁、预售照押金抵扣；到时间自动解锁并提醒值班经理。
// 锁、解锁照前台的「结果待确认」：没收到回复时只能查回、按原内容重新提交或确认作废。
import { useState } from 'react';
import { LockKeyhole, LockKeyholeOpen } from 'lucide-react';
import { AWAY_LOCK_MAX_HOURS, AWAY_LOCK_MINUTE_OPTIONS, AWAY_LOCK_REASON, awayLockPrefill } from '@shared/away-lock';
import type { FrontdeskBoardRules, VisitDetail } from '@shared/frontdesk';
import { splitDeduction } from '@shared/deduction';
import { centsToInput, formatYuan, parseYuan } from '@shared/money';
import { TAG_DEPOSIT_METHOD_LABELS, TAG_DEPOSIT_METHODS, type TagDepositMethod } from '@shared/tag-deposit';
import { useCan, useSession } from '../../lib/session';
import { cn, formatTime } from '../../lib/utils';
import { useResetOnOpen } from '../../lib/useResetOnOpen';
import { Money } from '../../components/Money';
import { Dialog } from '../../components/Overlay';
import { Button, Field, Input, Notice } from '../../components/ui';
import { ShiftGate } from '../shift/ShiftGate';
import { PendingPanel, useFrontdeskOp } from './pending';

const minutesLabel = (m: number) => (m % 60 === 0 ? `${m / 60} 小时` : m > 60 ? `${Math.floor(m / 60)} 小时半` : `${m} 分钟`);

/** 账单里的一小块：锁着的写到几点、预收多少；收银台能锁、能解锁 */
export function AwayLockBlock({ visit, cashier, onOpen }: { visit: VisitDetail; cashier: boolean; onOpen: () => void }) {
  const can = useCan();
  const lock = visit.awayLock ?? null;
  if (visit.status !== 'open') return null;
  if (!lock && !cashier) return null;
  return (
    <section
      className={cn('mt-3 flex flex-wrap items-center gap-2 rounded-[14px] border px-4 py-2.5 shadow-card', lock ? 'border-clay/40 bg-clay-soft' : 'border-line bg-card')}
      aria-label="锁牌外出"
      data-testid="away-lock-block"
    >
      {lock ? <LockKeyhole className="size-4 text-clay" /> : <LockKeyholeOpen className="size-4 text-ink-3" />}
      <span className="text-[13px] font-bold text-ink-2">锁牌外出</span>
      <span className="text-[13px] text-ink-3" data-testid="away-lock-state">
        {lock ? (
          <>
            锁到 <b className="num text-clay">{formatTime(lock.lockUntil)}</b> · 预收 <Money cents={lock.deposit.amount} className="font-bold text-ink" />（
            {TAG_DEPOSIT_METHOD_LABELS[lock.deposit.method]}）· 锁着不能挂账
          </>
        ) : (
          `客人要出去：先收预售再锁牌，最多 ${AWAY_LOCK_MAX_HOURS} 小时`
        )}
      </span>
      {cashier && can('frontdesk.operate') && (
        <Button size="sm" variant={lock ? 'primary' : 'secondary'} className="ml-auto" onClick={onOpen} data-testid="away-lock-open">
          {lock ? '客人回来解锁' : '锁牌外出'}
        </Button>
      )}
    </section>
  );
}

export function AwayLockDialog({
  visit,
  rules,
  onClose,
  onDone,
}: {
  visit: VisitDetail;
  rules: FrontdeskBoardRules | undefined;
  onClose: () => void;
  onDone: (v: VisitDetail, message: string) => void;
}) {
  const session = useSession();
  const can = useCan();
  const lock = visit.awayLock ?? null;
  const held = (visit.deposits ?? []).filter((d) => d.status === 'held').reduce((s, d) => s + d.amount, 0);
  const prefill = awayLockPrefill({
    billCents: visit.bill.amountCents,
    discountCents: visit.bill.discountCents ?? 0,
    ticketCents: visit.ticket?.amount ?? 0,
    heldDepositCents: held,
    minimumCents: rules?.tagDepositDefaultCents ?? 10000,
  });
  const [minutes, setMinutes] = useState<number>(AWAY_LOCK_MAX_HOURS * 60);
  const [amountText, setAmountText] = useState('');
  const [method, setMethod] = useState<TagDepositMethod>('cash');
  const [ref, setRef] = useState('');
  const lockOp = useFrontdeskOp<VisitDetail>({ type: 'tag_away_lock', visitId: visit.id, staffName: session.staff.displayName, pick: (f) => ('visit' in f ? f.visit : null) });
  const unlockOp = useFrontdeskOp<VisitDetail>({ type: 'tag_away_unlock', visitId: visit.id, staffName: session.staff.displayName, pick: (f) => ('visit' in f ? f.visit : null) });
  useResetOnOpen(true, () => {
    setMinutes(AWAY_LOCK_MAX_HOURS * 60);
    setAmountText(centsToInput(prefill));
    setMethod('cash');
    setRef('');
  });

  const member = visit.member;
  const walletOk = !!member && member.status === 'active' && can('consume.create');
  const methods = TAG_DEPOSIT_METHODS.filter((m) => m !== 'wallet' || walletOk);
  const amount = parseYuan(amountText);
  const split = method === 'wallet' && member && amount && amount > 0 ? splitDeduction(amount, { principal: member.principalBalance, bonus: member.bonusBalance }, session.rules.deductionRule) : null;
  const problem = amount === null || amount <= 0 ? '锁牌之前要先收预售：请填预售金额' : split && !split.ok ? `储值余额不够，还差 ${formatYuan(split.shortfall)}` : null;
  const busy = lockOp.busy || unlockOp.busy;
  const locked = lockOp.locked || unlockOp.locked;

  const doLock = async () => {
    if (problem || amount === null || locked) return;
    const v = await lockOp.submit((key) => ({
      url: `/api/frontdesk/visits/${visit.id}/away-lock`,
      body: {
        clientKey: key,
        minutes,
        deposit: { amount, method, ref: ref.trim(), ...(method === 'wallet' && split?.ok ? { expectedSplit: { principal: split.principal, bonus: split.bonus } } : {}) },
      },
      tagCodes: [visit.tag.code],
      summary: `锁牌外出 ${minutesLabel(minutes)}，预收 ${formatYuan(amount)}（${TAG_DEPOSIT_METHOD_LABELS[method]}）`,
      amount,
    }));
    if (v) onDone(v, `手牌 ${visit.tag.code} 已锁（${minutesLabel(minutes)}），预收 ${formatYuan(amount)}`);
  };
  const doUnlock = async () => {
    if (locked) return;
    const v = await unlockOp.submit((key) => ({
      url: `/api/frontdesk/visits/${visit.id}/away-unlock`,
      body: { clientKey: key },
      tagCodes: [visit.tag.code],
      summary: '客人回来解锁',
      amount: null,
    }));
    if (v) onDone(v, `手牌 ${visit.tag.code} 已解锁，预收的钱结账时抵扣`);
  };

  return (
    <Dialog
      open
      onClose={busy ? () => {} : onClose}
      width="max-w-xl"
      title={
        <span className="flex items-center gap-2">
          <LockKeyhole className="size-5 text-clay" /> 锁牌外出 · {visit.tag.code}
        </span>
      }
      description={`客人外出时锁住手牌（最多 ${AWAY_LOCK_MAX_HOURS} 小时）：锁之前先收预售，锁着期间这张牌不能挂账；回来解锁，结账时自动解锁、预售抵扣。`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            关闭
          </Button>
          {lock ? (
            <Button variant="primary" icon={<LockKeyholeOpen className="size-4" />} disabled={locked} loading={unlockOp.busy} onClick={doUnlock} data-testid="away-unlock-submit">
              客人回来解锁
            </Button>
          ) : (
            <Button variant="primary" icon={<LockKeyhole className="size-4" />} disabled={!!problem || locked} loading={lockOp.busy} onClick={doLock} data-testid="away-lock-submit">
              收预售{amount ? ` ${formatYuan(amount)}` : ''}并锁牌
            </Button>
          )}
        </>
      }
    >
      <PendingPanel op={lockOp} onResolved={(v) => onDone(v, '锁牌外出已生效')} />
      <PendingPanel op={unlockOp} onResolved={(v) => onDone(v, '解锁已生效')} />
      {lockOp.state.phase === 'error' && <Notice tone="error" title={lockOp.state.message} className="mb-3" />}
      {unlockOp.state.phase === 'error' && <Notice tone="error" title={unlockOp.state.message} className="mb-3" />}
      {lock ? (
        <div className="space-y-2 text-[13.5px]" data-testid="away-lock-dialog">
          <p>
            {formatTime(lock.lockedAt)} 由 {lock.lockedByName} 锁牌，锁到 <b className="num text-clay">{formatTime(lock.lockUntil)}</b>（到时间自动解锁并提醒值班经理）。
          </p>
          <p className="text-ink-3">
            预收 {lock.deposit.depositNo} <Money cents={lock.deposit.amount} className="font-bold text-ink" />（{TAG_DEPOSIT_METHOD_LABELS[lock.deposit.method]}
            ）：解锁后照押金留着，结账时抵扣；要退在「押金」里一键退。
          </p>
        </div>
      ) : (
        <>
          <ShiftGate action="收预售" />
          <div className="space-y-4" data-testid="away-lock-dialog">
            <Field label="锁多久" hint={`最多 ${AWAY_LOCK_MAX_HOURS} 小时，到时间自动解锁并提醒值班经理`}>
              <div className="flex flex-wrap gap-1.5" role="group" aria-label="锁多久">
                {AWAY_LOCK_MINUTE_OPTIONS.map((m) => (
                  <button
                    key={m}
                    type="button"
                    aria-pressed={minutes === m}
                    disabled={locked}
                    onClick={() => setMinutes(m)}
                    className={cn(
                      'tap relative h-9 rounded-full border px-3.5 text-[13px] font-semibold',
                      minutes === m ? 'border-pine bg-pine-tint text-pine' : 'border-line bg-card text-ink-2 hover:border-line-strong',
                    )}
                    data-testid={`away-lock-minutes-${m}`}
                  >
                    {minutesLabel(m)}
                  </button>
                ))}
              </div>
            </Field>
            <Field
              label="先收预售"
              htmlFor="away-lock-amount"
              hint={`预填此刻应收（明细 + 门票 − 已押的押金），至少 ${formatYuan(rules?.tagDepositDefaultCents ?? 10000)}；记成押金「${AWAY_LOCK_REASON}」，结账时抵扣`}
            >
              <Input id="away-lock-amount" inputMode="decimal" value={amountText} onChange={(e) => setAmountText(e.target.value)} disabled={locked} data-testid="away-lock-amount" />
            </Field>
            <div className="flex flex-wrap gap-1.5" role="group" aria-label="收的方式">
              {methods.map((m) => (
                <button
                  key={m}
                  type="button"
                  aria-pressed={method === m}
                  disabled={locked}
                  onClick={() => setMethod(m)}
                  className={cn(
                    'tap relative h-9 rounded-full border px-3.5 text-[13px] font-semibold',
                    method === m ? 'border-pine bg-pine-tint text-pine' : 'border-line bg-card text-ink-2 hover:border-line-strong',
                  )}
                  data-testid={`away-lock-method-${m}`}
                >
                  {TAG_DEPOSIT_METHOD_LABELS[m]}
                </button>
              ))}
            </div>
            {method === 'wallet' && member && (
              <p className="text-[12.5px] text-ink-3">
                从会员 {member.name} 的储值扣{split?.ok ? `（本金 ${formatYuan(split.principal)}、赠金 ${formatYuan(split.bonus)}）` : ''}，结账时先退回原卡再扣
              </p>
            )}
            {method !== 'wallet' && method !== 'cash' && (
              <Field label="收款备注" htmlFor="away-lock-ref" hint="选填，如交易单号后几位">
                <Input id="away-lock-ref" value={ref} maxLength={64} onChange={(e) => setRef(e.target.value)} disabled={locked} />
              </Field>
            )}
            {problem && amountText !== '' && <p className="text-[12.5px] text-clay">{problem}</p>}
          </div>
        </>
      )}
    </Dialog>
  );
}
