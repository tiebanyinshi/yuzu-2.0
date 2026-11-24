// 需求单的小部件（8.0.1 采购组整改 02，CG02）：采购优先级红点（紧急）/ 黄点（较急，8.1.31）/ 绿点（普通）。

import { PRIORITY_LABELS, type RequestPriority } from '@shared/requests';
import { cn } from '../../lib/utils';

const PRIORITY_DOT: Record<RequestPriority, string> = { urgent: 'bg-clay', high: 'bg-yuzu', normal: 'bg-pine' };
const PRIORITY_TEXT: Record<RequestPriority, string> = { urgent: 'text-clay', high: 'text-yuzu-deep', normal: 'text-pine' };

export function PriorityDot({ priority, className }: { priority: RequestPriority; className?: string }) {
  return (
    <span
      role="img"
      aria-label={PRIORITY_LABELS[priority]}
      title={PRIORITY_LABELS[priority]}
      className={cn('inline-block size-2.5 shrink-0 rounded-full', PRIORITY_DOT[priority], className)}
      data-testid={`priority-${priority}`}
    />
  );
}

/** 红点 / 黄点 / 绿点 + 文字 */
export function PriorityTag({ priority }: { priority: RequestPriority }) {
  return (
    <span className={cn('inline-flex items-center gap-1.5 text-[12.5px] font-bold', PRIORITY_TEXT[priority])}>
      <PriorityDot priority={priority} />
      {PRIORITY_LABELS[priority]}
    </span>
  );
}
