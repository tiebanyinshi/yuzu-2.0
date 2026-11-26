// 房态中心选项目（登记、加钟共用）：按名称或价目表编号搜，不搜的时候按分类切换（「全部」+ 各分类），点一个选中。
// 加钟就是再选一个项目（店主 2026-11-23，PC27）：时长、价格照价目表，不选钟数。
// 福田店 FT-02（2026-11-26）：输编号即选——输入的正好是某个在用项目的编号就直接选中（回车也选中唯一的一个搜索结果）；
// 默认只显示搜索框与分类页签，点了「全部」或某一类才平铺项目（原来一打开就平铺全部，找起来慢）。

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
  // 已经选了项目（编辑、加钟带出）的照原样平铺全部，好看到选中的是哪个；没选的先不平铺（FT-02 ③）
  const [category, setCategory] = useState<string | null>(value !== null ? ALL_CATEGORIES : null);
  const [search, setSearch] = useState('');
  const tabs = useMemo(() => itemCategoryTabs(allItems), [allItems]);
  const q = search.trim();
  const items = q ? allItems.filter((i) => matchesItemSearch(i, q)) : category === null ? [] : category === ALL_CATEGORIES ? allItems : allItems.filter((i) => itemCategoryKey(i) === category);
  const byCode = (text: string) => {
    const k = text.trim().toUpperCase();
    const hits = k ? allItems.filter((i) => i.catalogCode && i.catalogCode.toUpperCase() === k) : [];
    return hits.length === 1 ? hits[0]! : null;
  };
  if (allItems.length === 0) return <p className="text-[13px] text-ink-3">没有需要技师的项目（在「后台 → 技师」里勾选）</p>;
  const picked = value !== null ? allItems.find((i) => i.id === value) : undefined;
  return (
    <>
      <Input
        className="mb-2"
        value={search}
        onChange={(e) => {
          setSearch(e.target.value);
          // 输编号即选（FT-02 ②）：正好是某个项目的编号，直接选中
          const hit = byCode(e.target.value);
          if (hit && hit.id !== value) onChange(hit);
        }}
        onKeyDown={(e) => {
          if (e.key !== 'Enter' || e.nativeEvent.isComposing) return;
          e.preventDefault();
          const hit = byCode(search) ?? (items.length === 1 ? items[0]! : null);
          if (hit) onChange(hit);
        }}
        placeholder="输编号直接选中，或搜项目名称"
        aria-label="搜项目"
        disabled={disabled}
        data-testid={`${testId}-search`}
      />
      {!q && <CategoryTabs tabs={tabs} value={category ?? ''} onChange={setCategory} total={allItems.length} testId={`${testId}-categories`} />}
      {!q && category === null && (
        <p className="text-[12.5px] text-ink-3" data-testid={`${testId}-hint`}>
          {picked ? (
            <>
              已选 <b className="text-ink">{picked.name}</b>。
            </>
          ) : null}
          输入项目编号直接选中；或点「全部」、某一类看项目。
        </p>
      )}
      {q && items.length === 0 && <p className="text-[13px] text-ink-3">没有搜到「{q}」</p>}
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
            {i.catalogCode && <span className="num mr-1 text-[12px] font-bold opacity-70">{i.catalogCode}</span>}
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
