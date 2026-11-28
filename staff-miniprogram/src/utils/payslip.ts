// 工资条明细的一行一行（与 WCP 网页 formatPayslipValue 同一口径）：金额「1,280.00」，数字照原样，空的「—」；「实发」单独放大写在上面。

import type { MyPayslipDetail, PayslipField, PayslipValue } from '../../../src/shared/oa-payroll';
import { monthLabel } from './month';
import { yuan } from './money';

export function payslipValueText(field: Pick<PayslipField, 'kind'>, value: PayslipValue | undefined): string {
  if (value === null || value === undefined || value === '') return '—';
  if (field.kind === 'money' && typeof value === 'number') return yuan(value);
  return String(value);
}

export interface PayslipView {
  title: string;
  net: string;
  rows: { key: string; label: string; value: string; money: boolean }[];
  signed: string;
  /** 有异议时带进「工资条异议」单的那一栏 */
  objection: string;
}

export function payslipView(d: MyPayslipDetail): PayslipView {
  const title = `${monthLabel(d.month)} · ${d.title}`;
  return {
    title,
    net: d.net === null ? '' : yuan(d.net),
    rows: d.fields.filter((f) => !f.net).map((f) => ({ key: f.key, label: f.label, value: payslipValueText(f, d.values[f.key]), money: f.kind === 'money' })),
    signed: d.signedAt ?? '',
    objection: title,
  };
}
