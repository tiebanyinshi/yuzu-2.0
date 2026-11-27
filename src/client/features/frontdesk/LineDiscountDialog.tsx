// 单项打折（8.2.1，docs/V8221_CASHIER.md 第 1 节）：收银台账单一行旁边的「折」。按折扣（几折）或直接填折后价；
// 超过自己那一档的下限（后台「手牌与前台」设）请岗位够的人当场授权；打过的可以改折扣或恢复原价。都带操作编号，结果待确认照前台的做法。
import { useState } from 'react';
import { BadgePercent, ShieldCheck } from 'lucide-react';
import type { BillLine, FrontdeskBoardRules, VisitDetail } from '@shared/frontdesk';
import { DEFAULT_LINE_DISCOUNT_FLOORS, discountedAmount, floorLabel, lineDiscountTierOf, LINE_DISCOUNT_TIER_LABELS, rateLabel, withinFloor, type LineDiscountScope } from '@shared/line-discount';
import type { LineDiscountGrant } from '@shared/grants';
import { centsToInput, formatYuan, parseYuan } from '@shared/money';
import { useSession } from '../../lib/session';
import { cn, formatTime } from '../../lib/utils';
import { useResetOnOpen } from '../../lib/useResetOnOpen';
import { AuthorizeDialog } from '../../components/AuthorizeDialog';
import { Money } from '../../components/Money';
import { Dialog } from '../../components/Overlay';
import { Button, Field, Input, Notice, Segmented } from '../../components/ui';
import { PendingPanel, useFrontdeskOp } from './pending';

const QUICK_RATES = [95, 90, 88, 85, 80, 70, 50, 0];
type Mode = 'rate' | 'price';

export function LineDiscountDialog({
  open,
  visit,
  line,
  rules,
  onClose,
  onDone,
}: {
  open: boolean;
  visit: VisitDetail;
  line: BillLine;
  rules: FrontdeskBoardRules | undefined;
  onClose: () => void;
  onDone: (v: VisitDetail, message: string) => void;
}) {
  const session = useSession();
  const [mode, setMode] = useState<Mode>('rate');
  const [rateText, setRateText] = useState('');
  const [priceText, setPriceText] = useState('');
  const [reason, setReason] = useState('');
  const [grant, setGrant] = useState<LineDiscountGrant | null>(null);
  const [authOpen, setAuthOpen] = useState(false);
  const op = useFrontdeskOp<VisitDetail>({ type: 'line_discount', visitId: visit.id, staffName: session.staff.displayName, pick: (found) => ('visit' in found ? found.visit : null) });
  useResetOnOpen(open, () => {
    setMode('rate');
    setRateText('');
    setPriceText(line.discount ? centsToInput(line.discount.finalAmount) : '');
    setReason('');
    setGrant(null);
    op.clearError();
  });

  const floors = rules?.lineDiscountFloors ?? DEFAULT_LINE_DISCOUNT_FLOORS;
  const tier = lineDiscountTierOf(session.staff);
  const floor = floors[tier];
  const list = line.amount;
  // 折扣按「几折」输：8 = 八折，8.5 = 八五折，0 = 免单
  const zhe = Number(rateText);
  const rate = rateText.trim() !== '' && Number.isFinite(zhe) && zhe >= 0 && zhe < 10 && Number.isInteger(zhe * 10) ? Math.round(zhe * 10) : null;
  const price = parseYuan(priceText);
  const finalAmount = mode === 'rate' ? (rate === null ? null : discountedAmount(list, rate)) : price;
  const problem = finalAmount === null ? null : finalAmount >= list ? `折后价要比原价 ${formatYuan(list)} 低` : line.discount && line.discount.finalAmount === finalAmount ? '已经是这个价了' : null;
  const needsGrant = finalAmount !== null && !problem && !withinFloor(list, finalAmount, floor);
  const grantOk = !needsGrant || (!!grant && grant.scope.lineId === line.id && grant.scope.finalAmount === finalAmount && new Date(grant.expiresAt).getTime() > Date.now());
  const ready = finalAmount !== null && !problem && grantOk && !op.locked;
  const edit = (fn: () => void) => {
    if (op.locked) return;
    op.clearError();
    fn();
  };

  const submit = async () => {
    if (!ready || finalAmount === null) return;
    const v = await op.submit((key) => ({
      url: `/api/frontdesk/lines/${line.id}/discount`,
      body: {
        clientKey: key,
        ...(mode === 'rate' ? { rate: rate! } : { finalAmount }),
        reason: reason.trim(),
        ...(needsGrant && grant ? { grantId: grant.grantId } : {}),
      },
      tagCodes: [visit.tag.code],
      summary: `「${line.name}」${mode === 'rate' ? rateLabel(rate!) : '改价'}到 ${formatYuan(finalAmount)}`,
      amount: list - finalAmount,
    }));
    if (v) onDone(v, `「${line.name}」已打折，收 ${formatYuan(finalAmount)}`);
  };
  const revoke = async () => {
    const v = await op.submit((key) => ({
      url: `/api/frontdesk/lines/${line.id}/discount/revoke`,
      body: { clientKey: key, reason: reason.trim().length >= 2 ? reason.trim() : '恢复原价' },
      tagCodes: [visit.tag.code],
      summary: `「${line.name}」恢复原价 ${formatYuan(list)}`,
      amount: null,
    }));
    if (v) onDone(v, `「${line.name}」已恢复原价`);
  };
  const scope: LineDiscountScope | null = finalAmount !== null ? { lineId: line.id, name: line.name, listAmount: list, finalAmount, reason: reason.trim() } : null;

  return (
    <Dialog
      open={open}
      onClose={op.busy ? () => {} : onClose}
      title={
        <span className="flex items-center gap-2">
          <BadgePercent className="size-5 text-ember" /> 单项打折 · {line.name}
        </span>
      }
      description={`你是${LINE_DISCOUNT_TIER_LABELS[tier]}，${floorLabel(floor)}；超过的请岗位够的人当场授权。打过折的这一行不再用券、次卡、会员折扣。`}
      footer={
        <>
          {line.discount && (
            <Button variant="ghost" className="mr-auto" disabled={op.locked} onClick={revoke} data-testid="line-discount-revoke">
              恢复原价
            </Button>
          )}
          <Button variant="ghost" onClick={onClose} disabled={op.busy}>
            取消
          </Button>
          <Button variant="primary" disabled={!ready} loading={op.busy} onClick={submit} data-testid="line-discount-submit">
            确认打折{finalAmount !== null && !problem ? ` · 收 ${formatYuan(finalAmount)}` : ''}
          </Button>
        </>
      }
    >
      <PendingPanel op={op} onResolved={(v) => onDone(v, '单项打折已生效')} />
      <div className="space-y-4" data-testid="line-discount">
        <div className="flex items-center justify-between rounded-lg bg-paper-2 px-3 py-2 text-[13.5px]">
          <span className="font-semibold">
            {line.name} × {line.quantity}
          </span>
          <span>
            原价 <Money cents={list} className="font-bold" />
          </span>
        </div>
        {line.discount && (
          <p className="text-[12.5px] text-ink-3">
            现在：{line.discount.rate !== null ? rateLabel(line.discount.rate) : '改价'}，收 {formatYuan(line.discount.finalAmount)}（{line.discount.byName} {formatTime(line.discount.at)} 打
            {line.discount.approvedByName ? `，${line.discount.approvedByName}授权` : ''}）。再打一次会替换掉它。
          </p>
        )}
        <Segmented
          value={mode}
          onChange={(m) => edit(() => setMode(m))}
          ariaLabel="打折方式"
          options={[
            { value: 'rate', label: '按折扣' },
            { value: 'price', label: '填折后价' },
          ]}
        />
        {mode === 'rate' ? (
          <Field label="打几折（8 = 八折，8.5 = 八五折，0 = 免单）">
            <div className="mb-2 flex flex-wrap gap-1.5">
              {QUICK_RATES.map((r) => (
                <button
                  key={r}
                  type="button"
                  aria-pressed={rate === r}
                  onClick={() => edit(() => setRateText(String(r / 10)))}
                  className={cn(
                    'tap relative h-9 rounded-full border px-3.5 text-[13px] font-semibold',
                    rate === r ? 'border-ember bg-ember-soft text-ember' : 'border-line bg-card text-ink-2 hover:border-line-strong',
                    withinFloor(list, discountedAmount(list, r), floor) ? '' : 'border-dashed',
                  )}
                >
                  {rateLabel(r)}
                </button>
              ))}
            </div>
            <Input
              data-autofocus
              inputMode="decimal"
              value={rateText}
              disabled={op.locked}
              onChange={(e) => edit(() => setRateText(e.target.value))}
              placeholder="例如 8"
              aria-label="打几折"
              className="num"
            />
          </Field>
        ) : (
          <Field label="这一行收多少（元）">
            <Input
              data-autofocus
              inputMode="decimal"
              value={priceText}
              disabled={op.locked}
              onChange={(e) => edit(() => setPriceText(e.target.value))}
              placeholder="例如 450"
              aria-label="折后价"
              className="num"
            />
          </Field>
        )}
        <Field label="原因（选填）">
          <Input value={reason} disabled={op.locked} onChange={(e) => edit(() => setReason(e.target.value))} maxLength={64} placeholder="例如 老客、客诉补偿" />
        </Field>
        {finalAmount !== null && !problem && (
          <p className="text-[13.5px]" data-testid="line-discount-result">
            收 <Money cents={finalAmount} className="font-bold text-pine" />
            ，优惠 <Money cents={list - finalAmount} className="font-bold text-ember" />
            {mode === 'rate' && rate !== null && <span className="text-ink-3">（{rateLabel(rate)}）</span>}
          </p>
        )}
        {problem && <Notice tone="error" title={problem} />}
        {needsGrant && (
          <Notice
            tone={grantOk ? 'success' : 'warning'}
            icon={<ShieldCheck className="size-4" />}
            title={grantOk && grant ? `已由${grant.approverName}当场授权，${formatTime(grant.expiresAt)} 前有效` : `超过你的下限（${floorLabel(floor)}）`}
          >
            {!grantOk && (
              <Button size="sm" variant="secondary" icon={<ShieldCheck className="size-4" />} disabled={op.locked} onClick={() => setAuthOpen(true)} data-testid="line-discount-authorize">
                请经理授权
              </Button>
            )}
          </Notice>
        )}
        {op.state.phase === 'error' && <Notice tone="error" title={op.state.message} />}
      </div>
      {scope && (
        <AuthorizeDialog
          open={authOpen}
          request={{ purpose: 'line_discount', scope }}
          lines={[`手牌 ${visit.tag.code} · ${line.name} × ${line.quantity}`, `原价 ${formatYuan(list)} → 收 ${formatYuan(scope.finalAmount)}（优惠 ${formatYuan(list - scope.finalAmount)}）`]}
          onClose={() => setAuthOpen(false)}
          onGranted={(g) => {
            setGrant(g);
            setAuthOpen(false);
            op.clearError();
          }}
        />
      )}
    </Dialog>
  );
}
