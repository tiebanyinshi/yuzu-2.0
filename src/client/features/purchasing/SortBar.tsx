// 排序条（8.2.6，《采购模块需求补充》R2）：采购单列表、流程进度共用。点一列：降序 → 升序 → 恢复默认；排序在服务端做，存在网址里（刷新、翻页不丢）

import { ArrowDown, ArrowUp, ArrowUpDown } from 'lucide-react';
import { nextSort, type SortDir } from '@shared/purchase-sort';
import { cn } from '../../lib/utils';

export function SortBar<K extends string>({
  keys,
  labels,
  value,
  onChange,
  defaultLabel,
}: {
  keys: readonly K[];
  labels: Record<K, string>;
  value: { key: K | null; dir: SortDir };
  onChange: (next: { key: K | null; dir: SortDir }) => void;
  /** 没选排序时按什么排（写在最前面） */
  defaultLabel: string;
}) {
  return (
    <div className="scroll-thin flex items-center gap-1.5 overflow-x-auto" role="group" aria-label="排序" data-testid="sort-bar">
      <span className="shrink-0 text-[12.5px] text-ink-3">排序：{value.key ? '' : defaultLabel}</span>
      {keys.map((k) => {
        const on = value.key === k;
        const Icon = !on ? ArrowUpDown : value.dir === 'desc' ? ArrowDown : ArrowUp;
        return (
          <button
            key={k}
            type="button"
            aria-pressed={on}
            onClick={() => onChange(nextSort(value, k))}
            className={cn(
              'tap relative flex h-8 shrink-0 items-center gap-1 rounded-full border px-2.5 text-[12.5px] font-semibold transition-colors',
              on ? 'border-ink bg-ink text-paper' : 'border-line-strong bg-card text-ink-2 hover:border-ink-3',
            )}
            data-testid={`sort-${k}`}
            title={on ? (value.dir === 'desc' ? '降序（再点升序）' : '升序（再点恢复默认）') : '点一下按这一列降序'}
          >
            {labels[k]}
            <Icon className="size-3.5" />
          </button>
        );
      })}
    </div>
  );
}

/** 从网址读排序（?sort=&dir=）；不认识的当没选 */
export function sortFromParams<K extends string>(params: URLSearchParams, keys: readonly K[]): { key: K | null; dir: SortDir } {
  const raw = params.get('sort');
  const key = raw && (keys as readonly string[]).includes(raw) ? (raw as K) : null;
  return { key, dir: params.get('dir') === 'asc' ? 'asc' : 'desc' };
}
