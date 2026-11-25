// 8.1.40 券的发放台账与核销查询（docs/V8140.md 第 3 节）：前后端共用的类型与导出。

/** 页面一次最多看几张券（导出最多一万张） */
export const COUPON_LEDGER_MAX = 2000;

export interface CouponLedgerRow {
  id: number;
  /** 券号（带分隔：ABCD-EFGH-JKLM） */
  code: string;
  templateName: string;
  issueNo: string;
  kind: string;
  kindLabel: string;
  /** 发券的事由（手动、签赠写的） */
  reason: string;
  issuedAt: string;
  issuedByName: string | null;
  memberName: string | null;
  memberNo: string | null;
  /** 充值发的券：哪张充值单 */
  rechargeDocNo: string | null;
  validFrom: string;
  validTo: string;
  status: 'available' | 'used' | 'voided';
  checkoutNo: string | null;
  usedAt: string | null;
  usedAmount: number | null;
  voidedAt: string | null;
  voidReason: string | null;
  /** 发放时长：发出到用掉过了几小时（没用的到现在；作废的为空），一位小数 */
  hoursToUse: number | null;
}

export interface CouponLedger {
  rows: CouponLedgerRow[];
  /** 超过一次能看的张数：只列了最近的那些 */
  truncated: boolean;
  summary: { issued: number; used: number; usedAmount: number; voided: number; avgHoursToUse: number | null };
}

export const COUPON_LEDGER_STATUS_LABELS: Record<CouponLedgerRow['status'], string> = { available: '未用', used: '已用', voided: '已作废' };

const cell = (v: string | number | null) => {
  const s = v === null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** 导出 CSV：一张券一行 */
export function couponLedgerCsv(rows: readonly CouponLedgerRow[]): string {
  const head = [
    '券号',
    '券',
    '怎么发的',
    '发券单号',
    '发放时间',
    '发放人',
    '会员',
    '会员号',
    '充值单号',
    '有效期起',
    '有效期止',
    '状态',
    '使用时间',
    '结账单',
    '抵扣（元）',
    '发出到用掉（小时）',
    '作废原因',
    '事由',
  ];
  const body = rows.map((r) =>
    [
      r.code,
      r.templateName,
      r.kindLabel,
      r.issueNo,
      r.issuedAt,
      r.issuedByName,
      r.memberName,
      r.memberNo,
      r.rechargeDocNo,
      r.validFrom,
      r.validTo,
      COUPON_LEDGER_STATUS_LABELS[r.status],
      r.usedAt,
      r.checkoutNo,
      r.usedAmount === null ? null : (r.usedAmount / 100).toFixed(2),
      r.hoursToUse,
      r.voidReason,
      r.reason,
    ]
      .map(cell)
      .join(','),
  );
  return [head.join(','), ...body].join('\n');
}
