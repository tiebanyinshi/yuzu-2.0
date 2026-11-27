// 自购（8.2.13，《采购模块需求补充》R3 / 5.3–5.4）：采购单选「自购」时不选供应商，填这里——自购原因、购买渠道、经办人、付款方式、
// 购买日期、票据凭证（发票或收据照片，至少一张）。切换采购方式不清空别的内容。
// 审批说明里的店主复核金额按「采购规则」里现在的值写（PS5，默认 ¥2,000）

import { useQuery } from '@tanstack/react-query';
import { formatYuan } from '@shared/money';
import { SELF_PAY_METHOD_LABELS, SELF_PAY_METHODS, SELF_REASON_LABELS, SELF_REASONS, type PurchaseOrder, type SelfPayMethod, type SelfReason } from '@shared/purchasing';
import type { ImageRef } from '@shared/requests';
import { api } from '../../lib/api';
import { ImagePicker } from '../../components/Images';
import { Field, Input, Select } from '../../components/ui';
import { usePurchaseRules } from './queries';

export interface SelfState {
  reason: SelfReason | '';
  reasonNote: string;
  channel: string;
  handlerId: number | null;
  payMethod: SelfPayMethod | '';
  boughtOn: string;
  receipts: ImageRef[];
}

export const selfStateFrom = (po: PurchaseOrder | undefined, myId: number, today: string): SelfState => ({
  reason: po?.self?.reason ?? '',
  reasonNote: po?.self?.reasonNote ?? '',
  channel: po?.self?.channel ?? '',
  handlerId: po?.self?.handler.id ?? myId,
  payMethod: po?.self?.payMethod ?? '',
  boughtOn: po?.self?.boughtOn ?? today,
  receipts: po?.self?.receiptImages ?? [],
});

/** 还差什么（空 = 填齐了）：未填完点名具体字段 */
export function selfProblem(s: SelfState): string | null {
  if (!s.reason) return '自购请选择自购原因';
  if (s.reason === 'other' && !s.reasonNote.trim()) return '自购原因选「其他」时请写说明';
  if (!s.channel.trim()) return '自购请填写购买渠道 / 商家名称';
  if (!s.handlerId) return '自购请选择经办人';
  if (!s.payMethod) return '自购请选择付款方式';
  if (!s.receipts.length) return '自购请上传发票或收据照片（至少一张）';
  return null;
}

export const selfBody = (s: SelfState) => ({
  reason: s.reason,
  reasonNote: s.reasonNote.trim(),
  channel: s.channel.trim(),
  handlerId: s.handlerId,
  payMethod: s.payMethod,
  boughtOn: s.boughtOn || null,
  receiptImageIds: s.receipts.map((i) => i.id),
});

export function SelfPurchaseFields({ s, set, disabled, onUploading }: { s: SelfState; set: (fn: (prev: SelfState) => SelfState) => void; disabled: boolean; onUploading: (busy: boolean) => void }) {
  const handlers = useQuery({ queryKey: ['inv', 'self-handlers'], queryFn: () => api.get<{ id: number; name: string }[]>('/api/purchase-orders/self-handlers'), staleTime: 60_000 });
  const put = (patch: Partial<SelfState>) => set((prev) => ({ ...prev, ...patch }));
  const ownerReview = usePurchaseRules().data?.selfOwnerReviewCents;
  return (
    <section className="grid gap-4 rounded-lg border border-yuzu/40 bg-yuzu-soft/30 p-5 sm:grid-cols-2 lg:grid-cols-4" data-testid="po-self">
      <div className="sm:col-span-2 lg:col-span-4">
        <p className="text-[13px] font-bold text-ink">自购信息（不选供应商；票据进报销与发票台账查重，付款走报销或备用金）</p>
        <p className="mt-0.5 text-[12.5px] text-ink-3" data-testid="po-self-approval">
          提交后由负责人审批（提交人不能审自己的）{ownerReview === undefined ? '' : ownerReview > 0 ? `；合计超过 ${formatYuan(ownerReview)} 再加一级店主复核` : '；再加一级店主复核'}
        </p>
      </div>
      <Field label="自购原因" htmlFor="po-self-reason">
        <Select id="po-self-reason" value={s.reason} disabled={disabled} onChange={(e) => put({ reason: e.target.value as SelfReason })}>
          <option value="">选择原因</option>
          {SELF_REASONS.map((r) => (
            <option key={r} value={r}>
              {SELF_REASON_LABELS[r]}
            </option>
          ))}
        </Select>
      </Field>
      <Field label={s.reason === 'other' ? '原因说明（必填）' : '原因说明（选填）'} htmlFor="po-self-note">
        <Input id="po-self-note" maxLength={200} value={s.reasonNote} disabled={disabled} onChange={(e) => put({ reasonNote: e.target.value })} />
      </Field>
      <Field label="购买渠道 / 商家名称" htmlFor="po-self-channel">
        <Input id="po-self-channel" maxLength={100} value={s.channel} disabled={disabled} placeholder="例如：楼下五金店、某电商店铺" onChange={(e) => put({ channel: e.target.value })} />
      </Field>
      <Field label="经办人" htmlFor="po-self-handler">
        <Select id="po-self-handler" value={s.handlerId ?? ''} disabled={disabled} onChange={(e) => put({ handlerId: Number(e.target.value) || null })}>
          <option value="">选择经办人</option>
          {handlers.data?.map((h) => (
            <option key={h.id} value={h.id}>
              {h.name}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="付款方式" htmlFor="po-self-pay">
        <Select id="po-self-pay" value={s.payMethod} disabled={disabled} onChange={(e) => put({ payMethod: e.target.value as SelfPayMethod })}>
          <option value="">选择付款方式</option>
          {SELF_PAY_METHODS.map((m) => (
            <option key={m} value={m}>
              {SELF_PAY_METHOD_LABELS[m]}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="购买日期（选填）" htmlFor="po-self-date">
        <Input id="po-self-date" type="date" value={s.boughtOn} disabled={disabled} onChange={(e) => put({ boughtOn: e.target.value })} className="h-10" />
      </Field>
      <div className="sm:col-span-2">
        <p className="mb-1.5 text-[13px] font-semibold text-ink-2">票据凭证（发票或收据照片，至少一张，最多 9 张）</p>
        <ImagePicker value={s.receipts} onChange={(receipts) => put({ receipts })} max={9} disabled={disabled} onBusyChange={onUploading} testId="po-self-receipts" />
      </div>
    </section>
  );
}
