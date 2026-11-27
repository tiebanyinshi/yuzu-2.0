// 按日期段导出 Excel 的一小条（8.2.11：业财法事项、审批中心导出）：选开始、结束日期，点「导出」下载。
// 直接用链接下载（浏览器带登录状态），服务端核对权限、写导出记录；超过上限时服务端拒绝并说明。

import { useState } from 'react';
import { Download } from 'lucide-react';
import { Input } from './ui';

const monthStart = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
};
const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

export function RangeExport({ href, fileName, testId }: { href: string; fileName: string; testId: string }) {
  const [from, setFrom] = useState(monthStart);
  const [to, setTo] = useState(today);
  const bad = !from || !to || from > to;
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-[13px] text-ink-2" data-testid={testId}>
      <span>导出</span>
      <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="h-8 w-[140px]" aria-label="开始日期" />
      <span>至</span>
      <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="h-8 w-[140px]" aria-label="结束日期" />
      <a
        href={bad ? undefined : `${href}?from=${from}&to=${to}`}
        download={fileName}
        aria-disabled={bad}
        className={`inline-flex h-8 items-center gap-1 rounded-md border border-line-strong px-2.5 font-semibold ${bad ? 'pointer-events-none text-ink-3' : 'text-pine hover:bg-pine-tint/60'}`}
        data-testid={`${testId}-go`}
      >
        <Download className="size-4" />
        Excel
      </a>
    </div>
  );
}
