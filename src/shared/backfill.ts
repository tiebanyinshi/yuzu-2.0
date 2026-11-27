// 按实际时间补录纸质单（R1.9，店主 2026-10-29 决定要做；细则待确认，见 docs/PENDING_DECISIONS.md）

/** 只能补录这么多小时以内的业务 */
export const BACKFILL_WINDOW_HOURS = 48;

/** 预编号纸质应急单的单号：字母、数字、短横线，最多 32 位 */
export const SLIP_NO_PATTERN = /^[0-9A-Za-z-]{1,32}$/;

/** 业务请求里带的补录信息：纸质单号与纸质单上的实际时间（ISO 字符串） */
export interface BackfillRequest {
  slipNo: string;
  at: string;
  /** 补单（8.2.3）：出单员；补录纸质单不带 */
  issuerId?: number;
}

export type BackfillKind = 'checkin' | 'charges' | 'checkout';
export const BACKFILL_KIND_LABELS: Record<BackfillKind, string> = { checkin: '接待', charges: '挂账', checkout: '结账' };

/** 单据上的补录标记：纸质单号、实际时间、补录人与录入时间 */
export interface BackfillMark {
  slipNo: string;
  actualAt: string;
  enteredByName: string;
  enteredAt: string;
  /** 补单（8.2.3）的出单员；补录纸质单为 null（升级前的接口没有这一项） */
  issuerName?: string | null;
}

/** 单据、历史里的一句补录说明：补录 · 纸质单 P0012（补录人 林岚） */
export const backfillText = (m: BackfillMark) => (m.issuerName ? `补单 · 出单员 ${m.issuerName}，${m.enteredByName}录入` : `补录 · 纸质单 ${m.slipNo}，${m.enteredByName}补录`);

/** 补单（8.2.3）没填单号时记的单号：BD-月日-时分（backfill_entries 的单号只许字母、数字、短横线） */
export function supplementSlipNo(at: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `BD-${p(at.getMonth() + 1)}${p(at.getDate())}-${p(at.getHours())}${p(at.getMinutes())}`;
}
