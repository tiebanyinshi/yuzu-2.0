// 手牌押金（8.2.1，docs/V8221_CASHIER.md 第 5 节；会议纪要「收银系统功能评审」二.2）：客人外出留牌、去别的区域时收押金，
// 现金、微信、支付宝、银行卡，或从这位客人的会员储值扣；中途回来一键退（储值扣的退回原卡）；结账时一起退掉（结账里按同样方式先填好收款，就是抵扣）。
// 押金是负债，不算营业额；收、退都记到经办人当班的班次（现金计入交班应有现金）。
import { useState } from 'react';
import { HandCoins, Undo2 } from 'lucide-react';
import type { FrontdeskBoardRules, VisitDetail } from '@shared/frontdesk';
import { splitDeduction } from '@shared/deduction';
import { centsToInput, formatYuan, parseYuan } from '@shared/money';
import { TAG_DEPOSIT_METHOD_LABELS, TAG_DEPOSIT_METHODS, TAG_DEPOSIT_REASONS, TAG_DEPOSIT_REFUND_LABELS, type TagDeposit, type TagDepositMethod } from '@shared/tag-deposit';
import { useCan, useSession } from '../../lib/session';
import { cn, formatTime } from '../../lib/utils';
import { useResetOnOpen } from '../../lib/useResetOnOpen';
import { Money } from '../../components/Money';
import { Dialog } from '../../components/Overlay';
import { Button, Field, Input, Notice } from '../../components/ui';
import { ShiftGate } from '../shift/ShiftGate';
import { PendingPanel, useFrontdeskOp } from './pending';

/** 账单里的一小块：押着几笔、多少；点开管理 */
export function DepositBlock({ visit, onOpen }: { visit: VisitDetail; onOpen: () => void }) {
  const can = useCan();
  const held = (visit.deposits ?? []).filter((d) => d.status === 'held');
  const total = held.reduce((s, d) => s + d.amount, 0);
  if (visit.status !== 'open' && held.length === 0) return null;
  return (
    <section className="mt-3 flex flex-wrap items-center gap-2 rounded-[14px] border border-line bg-card px-4 py-2.5 shadow-card" aria-label="手牌押金" data-testid="deposit-block">
      <HandCoins className="size-4 text-yuzu-deep" />
      <span className="text-[13px] font-bold text-ink-2">押金</span>
      <span className="text-[13px] text-ink-3" data-testid="deposit-held">
        {held.length ? (
          <>
            押着 {held.length} 笔 <Money cents={total} className="font-bold text-ink" />（{held.map((d) => TAG_DEPOSIT_METHOD_LABELS[d.method]).join('、')}），结账时一起退
          </>
        ) : (
          '没有押金'
        )}
      </span>
      {visit.status === 'open' && can('frontdesk.operate') && (
        <Button size="sm" variant="secondary" className="ml-auto" onClick={onOpen} data-testid="deposit-open">
          {held.length ? '收 / 退押金' : '收押金'}
        </Button>
      )}
    </section>
  );
}

export function DepositDialog({
  open,
  visit,
  rules,
  onClose,
  onDone,
}: {
  open: boolean;
  visit: VisitDetail;
  rules: FrontdeskBoardRules | undefined;
  onClose: () => void;
  onDone: (v: VisitDetail, message: string) => void;
}) {
  const session = useSession();
  const can = useCan();
  const [amountText, setAmountText] = useState('');
  const [method, setMethod] = useState<TagDepositMethod>('cash');
  const [reason, setReason] = useState('');
  const [ref, setRef] = useState('');
  const collectOp = useFrontdeskOp<VisitDetail>({ type: 'tag_deposit', visitId: visit.id, staffName: session.staff.displayName, pick: (found) => ('visit' in found ? found.visit : null) });
  const refundOp = useFrontdeskOp<VisitDetail>({ type: 'tag_deposit_refund', visitId: visit.id, staffName: session.staff.displayName, pick: (found) => ('visit' in found ? found.visit : null) });
  useResetOnOpen(open, () => {
    setAmountText(rules?.tagDepositDefaultCents ? centsToInput(rules.tagDepositDefaultCents) : '');
    setMethod('cash');
    setReason(TAG_DEPOSIT_REASONS[0]);
    setRef('');
    collectOp.clearError();
    refundOp.clearError();
  });

  const member = visit.member;
  const walletOk = !!member && member.status === 'active' && can('consume.create');
  const methods = TAG_DEPOSIT_METHODS.filter((m) => m !== 'wallet' || walletOk);
  const amount = parseYuan(amountText);
  const split = method === 'wallet' && member && amount && amount > 0 ? splitDeduction(amount, { principal: member.principalBalance, bonus: member.bonusBalance }, session.rules.deductionRule) : null;
  const problem = amount === null || amount <= 0 ? '请填写押金金额' : reason.trim().length < 2 ? '请写为什么收押金' : split && !split.ok ? `储值余额不够，还差 ${formatYuan(split.shortfall)}` : null;
  const busy = collectOp.busy || refundOp.busy;
  const locked = collectOp.locked || refundOp.locked;
  const deposits = visit.deposits ?? [];
  const held = deposits.filter((d) => d.status === 'held');

  const collect = async () => {
    if (problem || amount === null || locked) return;
    const v = await collectOp.submit((key) => ({
      url: `/api/frontdesk/visits/${visit.id}/deposits`,
      body: {
        clientKey: key,
        amount,
        method,
        reason: reason.trim(),
        ref: ref.trim(),
        ...(method === 'wallet' && split?.ok ? { expectedSplit: { principal: split.principal, bonus: split.bonus } } : {}),
      },
      tagCodes: [visit.tag.code],
      summary: `收押金 ${formatYuan(amount)}（${TAG_DEPOSIT_METHOD_LABELS[method]}，${reason.trim()}）`,
      amount,
    }));
    if (v) onDone(v, `已收押金 ${formatYuan(amount)}（${TAG_DEPOSIT_METHOD_LABELS[method]}）`);
  };
  const refund = async (d: TagDeposit) => {
    if (locked) return;
    const v = await refundOp.submit((key) => ({
      url: `/api/frontdesk/deposits/${d.id}/refund`,
      body: { clientKey: key },
      tagCodes: [visit.tag.code],
      summary: `退押金 ${d.depositNo} ${formatYuan(d.amount)}（${TAG_DEPOSIT_METHOD_LABELS[d.method]}）`,
      amount: d.amount,
    }));
    if (v) onDone(v, d.method === 'wallet' ? `押金 ${formatYuan(d.amount)} 已退回会员储值` : `押金 ${formatYuan(d.amount)} 已退（${TAG_DEPOSIT_METHOD_LABELS[d.method]}）`);
  };

  return (
    <Dialog
      open={open}
      onClose={busy ? () => {} : onClose}
      width="max-w-xl"
      title={
        <span className="flex items-center gap-2">
          <HandCoins className="size-5 text-yuzu-deep" /> 手牌押金 · {visit.tag.code}
        </span>
      }
      description="外出留牌、去别的区域时收；回来一键退，结账时一起退（储值扣的退回原卡）。押金不算营业额，收、退都记到你当班的交班表。"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            关闭
          </Button>
          <Button variant="primary" disabled={!!problem || locked} loading={collectOp.busy} onClick={collect} data-testid="deposit-submit">
            收押金{amount ? ` ${formatYuan(amount)}` : ''}
          </Button>
        </>
      }
    >
      <PendingPanel op={collectOp} onResolved={(v) => onDone(v, '收押金已生效')} />
      <PendingPanel op={refundOp} onResolved={(v) => onDone(v, '退押金已生效')} />
      <ShiftGate action="收、退押金" />
      <div className="space-y-4" data-testid="deposit-dialog">
        {deposits.length > 0 && (
          <ul className="divide-y divide-line rounded-lg border border-line" data-testid="deposit-list">
            {deposits.map((d) => (
              <li key={d.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-[13px]">
                <span className="num font-semibold text-ink-3">{d.depositNo}</span>
                <Money cents={d.amount} className={cn('font-bold', d.status === 'refunded' && 'text-ink-3 line-through')} />
                <span>{TAG_DEPOSIT_METHOD_LABELS[d.method]}</span>
                <span className="text-ink-3">
                  {d.reason} · {d.staffName} {formatTime(d.createdAt)}
                </span>
                {d.status === 'held' ? (
                  <Button
                    size="sm"
                    variant="secondary"
                    className="ml-auto"
                    icon={<Undo2 className="size-4" />}
                    disabled={locked}
                    loading={refundOp.busy}
                    onClick={() => refund(d)}
                    data-testid={`deposit-refund-${d.id}`}
                  >
                    {d.method === 'wallet' ? '退回储值' : '一键退'}
                  </Button>
                ) : (
                  <span className="ml-auto text-[12px] text-ink-3">
                    {TAG_DEPOSIT_REFUND_LABELS[d.refundKind ?? 'manual']} · {d.refundedByName} {d.refundedAt ? formatTime(d.refundedAt) : ''}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
        {held.length > 0 && <p className="text-[12.5px] text-ink-3">押着的押金结账时会一起退掉：现金类的在结账里按同样方式先填好收款（抵扣），储值扣的先退回原卡再扣。</p>}
        <Field label="收押金">
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
              >
                {TAG_DEPOSIT_METHOD_LABELS[m]}
              </button>
            ))}
          </div>
        </Field>
        {method === 'wallet' && member && (
          <p className="text-[12.5px] text-ink-3">
            从会员 {member.name} 的储值扣（本金 <Money cents={member.principalBalance} /> · 赠金 <Money cents={member.bonusBalance} />）
            {split?.ok ? `，扣本金 ${formatYuan(split.principal)}、赠金 ${formatYuan(split.bonus)}，退的时候原样退回` : ''}
          </p>
        )}
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="金额（元）">
            <Input data-autofocus inputMode="decimal" value={amountText} disabled={locked} onChange={(e) => setAmountText(e.target.value)} className="num" aria-label="押金金额" />
          </Field>
          <Field label="收款备注（选填）">
            <Input value={ref} disabled={locked} onChange={(e) => setRef(e.target.value)} maxLength={64} placeholder="例如 微信单号后几位" />
          </Field>
        </div>
        <Field label="原因">
          <div className="mb-2 flex flex-wrap gap-1.5">
            {TAG_DEPOSIT_REASONS.map((r) => (
              <button
                key={r}
                type="button"
                aria-pressed={reason === r}
                disabled={locked}
                onClick={() => setReason(r)}
                className={cn(
                  'tap relative h-8 rounded-full border px-3 text-[12.5px] font-semibold',
                  reason === r ? 'border-pine bg-pine-tint text-pine' : 'border-line bg-card text-ink-2 hover:border-line-strong',
                )}
              >
                {r}
              </button>
            ))}
          </div>
          <Input value={reason} disabled={locked} onChange={(e) => setReason(e.target.value)} maxLength={64} placeholder="或填写其他原因" aria-label="收押金的原因" />
        </Field>
        {collectOp.state.phase === 'error' && <Notice tone="error" title={collectOp.state.message} />}
        {refundOp.state.phase === 'error' && <Notice tone="error" title={refundOp.state.message} />}
      </div>
    </Dialog>
  );
}
