// 点单页的分类切换（价目表重做第一批，PC19）：「全部」+ 各分类（价目表的名称与顺序），横向滚动；前台开单、房态中心登记、房态点单共用。
// 点选某一类只显示这一类，默认「全部」。

import type { ItemCategoryTab } from '@shared/catalog';
import { cn } from '../lib/utils';

export const ALL_CATEGORIES = '*';

export function CategoryTabs({ tabs, value, onChange, total, testId = 'category-tabs' }: { tabs: ItemCategoryTab[]; value: string; onChange: (key: string) => void; total?: number; testId?: string }) {
  const all = [{ key: ALL_CATEGORIES, label: '全部', group: '', count: total ?? tabs.reduce((n, t) => n + t.count, 0) }, ...tabs];
  return (
    <div className="scroll-thin -mx-1 mb-3 flex gap-1.5 overflow-x-auto px-1 pb-1" role="group" aria-label="分类" data-testid={testId}>
      {all.map((c) => (
        <button
          key={c.key}
          type="button"
          aria-pressed={value === c.key}
          onClick={() => onChange(c.key)}
          data-testid="category-tab"
          className={cn('tap relative h-8 shrink-0 rounded-full px-3.5 text-[13px] font-semibold transition-colors', value === c.key ? 'bg-pine text-paper' : 'bg-paper-2 text-ink-2 hover:bg-paper-3')}
        >
          {c.label}
          <span aria-hidden className={cn('ml-1 text-[12px] font-normal', value === c.key ? 'text-paper/80' : 'text-ink-3')}>
            {c.count}
          </span>
        </button>
      ))}
    </div>
  );
}
