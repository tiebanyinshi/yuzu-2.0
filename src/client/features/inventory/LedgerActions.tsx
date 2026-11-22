// 「库管入库」页右上角的「导入入库台账」「导出台账」「下载模板」（8.1.20，docs/ERP_V8120.md；叫法按店主 2026-11-22 的《ERP 需求汇总更新》）。
// 单独一个文件：库管入库页不必连带加载导入页。

import { Link } from 'react-router';
import { Download, FileDown, FileUp } from 'lucide-react';
import { useCan, useSession } from '../../lib/session';

export const LEDGER_TEMPLATE_URL = '/api/inventory/ledger/template';
/**
 * 「下载模板」直接下载门店的《库管出入库明细及库位表》（入库登记表格、仓库库位表两张合在一个文件里，店主 2026-11-22），
 * 文件名「出入库台账」；写在链接上，浏览器不会存成「download」
 */
export const LEDGER_TEMPLATE_FILE = '出入库台账.xlsx';
export const ledgerExportUrl = (month: string) => `/api/inventory/ledger/export?month=${month}`;
export const ledgerExportFile = (month: string) => `出入库台账-${month}.xlsx`;

/** 「库管入库」页右上角：导入入库台账、导出台账（这个月）、下载模板（出入库台账） */
export function LedgerActions() {
  const can = useCan();
  const session = useSession();
  if (!can('inventory.operate')) return null;
  return (
    <div className="flex flex-wrap items-center gap-2" data-testid="ledger-actions">
      <Link
        to="/inventory/direct/import"
        className="tap relative flex h-9 items-center gap-1.5 rounded-md bg-pine px-3 text-[13px] font-bold text-paper hover:bg-pine-hover"
        data-testid="ledger-import-link"
      >
        <FileUp className="size-4" />
        导入入库台账
      </Link>
      <a
        href={ledgerExportUrl(session.calendarToday.slice(0, 7))}
        download={ledgerExportFile(session.calendarToday.slice(0, 7))}
        className="tap relative flex h-9 items-center gap-1.5 rounded-md border border-line-strong bg-card px-3 text-[13px] font-bold text-ink-2 hover:border-ink-3 hover:text-ink"
        data-testid="ledger-export-link"
      >
        <FileDown className="size-4" />
        导出台账
      </a>
      <a
        href={LEDGER_TEMPLATE_URL}
        download={LEDGER_TEMPLATE_FILE}
        className="tap relative flex h-9 items-center gap-1.5 rounded-md border border-line-strong bg-card px-3 text-[13px] font-bold text-ink-2 hover:border-ink-3 hover:text-ink"
        data-testid="ledger-template-link"
      >
        <Download className="size-4" />
        下载模板
      </a>
    </div>
  );
}
