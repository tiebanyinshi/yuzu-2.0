// OA-09 假期余额明细（后台「假种与余额」与员工「假期余额」共用）。

import { halvesText, LEAVE_ENTRY_LABELS, type LeaveEntry } from '@shared/oa';
import { Badge } from '../../components/ui';

/** 余额明细（后台与员工「假期余额」共用） */
export function EntryList({ entries }: { entries: LeaveEntry[] }) {
  if (!entries.length) return <p className="py-6 text-center text-[13px] text-ink-3">还没有明细</p>;
  return (
    <ul className="divide-y divide-line" data-testid="leave-entry-list">
      {entries.map((e) => (
        <li key={e.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2.5">
          <span className="num w-24 text-[13px] text-ink-3">{e.createdAt.slice(0, 10)}</span>
          <span className="font-semibold text-ink">{e.leaveTypeName}</span>
          <Badge tone={e.halves > 0 ? 'pine' : 'ember'}>{LEAVE_ENTRY_LABELS[e.kind]}</Badge>
          <span className="num font-semibold text-ink">
            {e.halves > 0 ? '+' : '−'}
            {halvesText(Math.abs(e.halves))}
          </span>
          <span className="min-w-0 flex-1 text-[13px] text-ink-2">
            {e.reason}
            {e.createdByName ? `（${e.createdByName}）` : ''}
          </span>
        </li>
      ))}
    </ul>
  );
}
