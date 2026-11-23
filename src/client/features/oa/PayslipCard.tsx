// OA-17 工资条的样子（docs/OA.md 第 20 节）：后台工资表里「预览」用它，OA-18 员工端看本人的工资条也用它。
// 「实发」那一项放在顶上大字，其余按模板的顺序一项一行；没填的显示「—」。

import { formatPayslipValue, monthLabel, netField, type PayslipField, type PayslipValues } from '@shared/oa-payroll';

export function PayslipCard({ month, title, name, fields, values }: { month: string; title: string; name: string; fields: PayslipField[]; values: PayslipValues }) {
  const net = netField(fields);
  return (
    <div className="rounded-xl border border-line bg-card" data-testid="payslip-card">
      <div className="border-b border-line px-4 py-3">
        <p className="text-[13px] text-ink-3">
          {monthLabel(month)} · {title}
        </p>
        <p className="font-semibold text-ink">{name}</p>
        {net && (
          <p className="mt-2">
            <span className="text-[13px] text-ink-3">{net.label}</span>
            <span className="num ml-2 text-[26px] font-bold text-pine" data-testid="payslip-net">
              ¥{formatPayslipValue(net, values[net.key])}
            </span>
          </p>
        )}
      </div>
      <dl className="divide-y divide-line px-4">
        {fields
          .filter((f) => f.key !== net?.key)
          .map((f) => (
            <div key={f.key} className="flex items-center justify-between gap-3 py-2">
              <dt className="text-ink-2">{f.label}</dt>
              <dd className={f.kind === 'text' ? 'text-right text-ink' : 'num text-ink'}>{formatPayslipValue(f, values[f.key])}</dd>
            </div>
          ))}
      </dl>
    </div>
  );
}
