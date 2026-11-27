// 公司承担（8.2.4，docs/V8224_DINING.md 第 5 节）：结账时把这一笔挂到公司的内部账户（不进协议单位应收）。
// 选原因（客人身体不适、招待、其他），选「其他」写说明；值班经理及以上在弹窗里输入自己的账号密码授权（不能由收银的本人授权），
// 授权绑定这次结账的手牌或桌台、金额、原因与说明——改了哪一样都要重新授权。

import { ShieldCheck } from 'lucide-react';
import { COMPANY_REASON_LABELS, COMPANY_REASONS, MAX_COMPANY_NOTE, type CompanyReason } from '@shared/dining-v8224';
import type { CompanyChargeGrant, CompanyChargeGrantRequest, DiscountGrant, DiscountGrantRequest } from '@shared/grants';
import { Badge, Button, Input, Select } from '../../components/ui';

/** 这一笔的授权还对不对得上：授权的对象与金额（同优惠的核对）、原因与说明都要一样 */
export function companyGrantFits(
  row: { grant: DiscountGrant | CompanyChargeGrant | null; companyReason: CompanyReason; reason: string },
  cents: number,
  grantFits: (grant: DiscountGrant | null, cents: number) => boolean,
): boolean {
  const g = row.grant;
  if (!g || g.purpose !== 'company_charge') return false;
  // 对象（手牌或桌台）与金额的核对与优惠同一个函数：两种授权的这几项一样
  if (!grantFits({ ...g, purpose: 'checkout_discount', scope: { ...g.scope, reason: '' } } as DiscountGrant, cents)) return false;
  return g.scope.reason === row.companyReason && g.scope.note === row.reason.trim();
}

/** 公司承担的授权申请：对象沿用这次结账给优惠用的那一份（这几张手牌或这几桌） */
export function companyRequest(base: DiscountGrantRequest, amount: number, reason: CompanyReason, note: string): CompanyChargeGrantRequest {
  return {
    purpose: 'company_charge',
    scope: { visitIds: base.scope.visitIds, tableSessionIds: base.scope.tableSessionIds ?? [], amount, reason, note },
  };
}

export function CompanyPayRow({
  reason,
  note,
  granted,
  approverName,
  locked,
  canAuthorize,
  onChange,
  onAuthorize,
}: {
  reason: CompanyReason;
  note: string;
  granted: boolean;
  approverName: string | null;
  locked: boolean;
  canAuthorize: boolean;
  onChange: (patch: { companyReason?: CompanyReason; reason?: string }) => void;
  onAuthorize: () => void;
}) {
  return (
    <div className="mt-2 flex flex-wrap items-center gap-2" data-testid="company-row">
      <Select
        fullWidth={false}
        value={reason}
        onChange={(e) => onChange({ companyReason: e.target.value as CompanyReason })}
        disabled={locked}
        className="h-9 min-w-[140px] text-[13px]"
        aria-label="公司承担的原因"
        data-testid="company-reason"
      >
        {COMPANY_REASONS.map((r) => (
          <option key={r} value={r}>
            {COMPANY_REASON_LABELS[r]}
          </option>
        ))}
      </Select>
      <Input
        fullWidth={false}
        value={note}
        onChange={(e) => onChange({ reason: e.target.value })}
        placeholder={reason === 'other' ? '说明（必填），例如：试菜' : '说明（选填），例如：吃坏肚子'}
        maxLength={MAX_COMPANY_NOTE}
        disabled={locked}
        className="h-9 min-w-0 flex-1 basis-48 text-[13px]"
        aria-label="公司承担的说明"
      />
      {granted ? (
        <Badge tone="pine" className="h-8 px-3 text-[12.5px]">
          <ShieldCheck className="size-3.5" /> {approverName}已授权
        </Badge>
      ) : (
        <Button size="sm" variant="primary" icon={<ShieldCheck className="size-3.5" />} disabled={locked || !canAuthorize} onClick={onAuthorize} data-testid="company-authorize">
          请值班经理授权
        </Button>
      )}
    </div>
  );
}
