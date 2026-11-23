// 房态中心选项目（登记、加钟共用）：按名称或价目表编号搜，不搜的时候按分类切换（「全部」+ 各分类），点一个选中。
// 加钟就是再选一个项目（店主 2026-11-23，PC27）：时长、价格照价目表，不选钟数。

import { useMemo, useState } from 'react';
import { itemCategoryKey, itemCategoryTabs, matchesItemSearch } from '@shared/catalog';
import type { ServiceItem as CatalogItem } from '@shared/types';
import { cn } from '../../lib/utils';
import { ALL_CATEGORIES, CategoryTabs } from '../../components/CategoryTabs';
import { Input } from '../../components/ui';

export function ItemPicker({
  items: allItems,
  value,
  onChange,
  disabled,
  testId,
}: {
  items: CatalogItem[];
  value: number | null;
  onChange: (item: CatalogItem) => void;
  disabled?: boolean;
  /** 测试编号前缀：rc-register、rc-extend */
  testId: string;
}) {
  const [category, setCategory] = useState<string>(ALL_CATEGORIES);
  const [search, setSearch] = useState('');
  const tabs = useMemo(() => itemCategoryTabs(allItems), [allItems]);
  const items = search.trim() ? allItems.filter((i) => matchesItemSearch(i, search)) : category === ALL_CATEGORIES ? allItems : allItems.filter((i) => itemCategoryKey(i) === category);
  if (allItems.length === 0) return <p className="text-[13px] text-ink-3">没有需要技师的项目（在「后台 → 技师」里勾选）</p>;
  return (
    <>
      <Input className="mb-2" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="搜项目名称或编号" aria-label="搜项目" disabled={disabled} data-testid={`${testId}-search`} />
      {!search.trim() && <CategoryTabs tabs={tabs} value={category} onChange={setCategory} total={allItems.length} testId={`${testId}-categories`} />}
      {search.trim() && items.length === 0 && <p className="text-[13px] text-ink-3">没有搜到「{search.trim()}」</p>}
      <div className="flex flex-wrap gap-1.5" data-testid={`${testId}-items`}>
        {items.map((i) => (
          <button
            key={i.id}
            type="button"
            disabled={disabled}
            onClick={() => onChange(i)}
            aria-pressed={value === i.id}
            className={cn('h-11 rounded-full border px-3.5 text-[13.5px] font-semibold', value === i.id ? 'border-pine bg-pine-tint text-pine' : 'border-line-strong text-ink-2 hover:border-ink-4')}
            data-testid={`${testId}-item-${i.name}`}
          >
            {i.name}
          </button>
        ))}
      </div>
    </>
  );
}

/** 项目的时长：价目表带出的写分钟数；没写时长的按钟房的默认时长计 */
export function durationText(item: CatalogItem | null): string {
  if (!item) return '选了项目自动带出';
  return item.durationMinutes !== null ? `${item.durationMinutes} 分钟` : '按项目计时';
}
