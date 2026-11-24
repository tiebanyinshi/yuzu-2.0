// 价目表重做第四批：分类核对（需求说明第三节 7「点单页逐个分类点一遍，确认各分类下项目数与表格一致、无串类、无漏项」）。
// 生效中的价目表每个分类：表格里在用几项、能卖几项、点单页上看得到几个；能卖的与点单页上的对不上标红，
// 下面逐项写看不到的原因（PC28：没对上、停用、按摩没标需要技师、菜品没挂档口）。

import { useQuery } from '@tanstack/react-query';
import { PRICE_SHEET_NAMES, type PriceCategoryCheck } from '@shared/price-catalog';
import { api } from '../../lib/api';
import { DataTable, type DataColumn } from '../../components/DataTable';
import { LoadFailed } from '../../components/LoadFailed';
import { Card, SectionTitle, Skeleton } from '../../components/ui';

export function PriceCategoryChecks() {
  const q = useQuery({ queryKey: ['admin', 'price-catalog', 'category-checks'], queryFn: () => api.get<PriceCategoryCheck[]>('/api/admin/price-catalog/category-checks') });
  const rows = q.data ?? [];
  // 个数对不上，或者有对不上的项（少一项又多一项时个数会相等）都算
  const bad = rows.filter((r) => (r.items !== null && r.items !== r.sellable) || r.hidden.length > 0);
  const columns: DataColumn<PriceCategoryCheck>[] = [
    { key: 'sheet', header: '工作表', dataLabel: '工作表', cell: (r) => <span className="text-ink-3">{PRICE_SHEET_NAMES[r.sheet]}</span> },
    {
      key: 'name',
      header: '分类',
      dataLabel: '分类',
      cell: (r) => (
        <span>
          {r.group && r.sheet === 'dish' ? <span className="text-ink-3">{r.group} · </span> : null}
          <span className="font-semibold">{r.name}</span>
          <span className="ml-2 font-mono text-[12px] text-ink-4">{r.code}</span>
        </span>
      ),
    },
    { key: 'entries', header: '表格（在用）', numeric: true, dataLabel: '表格', cell: (r) => r.entries },
    { key: 'sellable', header: '能卖的', numeric: true, dataLabel: '能卖的', cell: (r) => r.sellable },
    {
      key: 'items',
      header: '点单页上',
      numeric: true,
      dataLabel: '点单页上',
      cell: (r) =>
        r.items === null ? (
          <span className="text-[12.5px] text-ink-3">不落库</span>
        ) : (
          <span className={r.items === r.sellable && r.hidden.length === 0 ? 'font-bold text-pine' : 'font-bold text-clay'}>{r.items}</span>
        ),
    },
  ];
  return (
    <Card className="p-5" data-testid="price-category-checks">
      <SectionTitle
        aside={
          q.data ? (
            <span className={`text-[12.5px] font-semibold ${bad.length ? 'text-clay' : 'text-pine'}`} data-testid="price-category-checks-summary">
              {bad.length ? `${bad.length} 个分类对不上` : `${rows.length} 个分类都对得上`}
            </span>
          ) : undefined
        }
      >
        分类核对
      </SectionTitle>
      <p className="mt-1 text-[12.5px] text-ink-3">
        每个分类：表格里在用几项、能卖的几项（服务费、房间不落库；待定价、不可下单的不能卖）、前台开单 / 房态中心登记 /
        点单页上看得到的几个。对不上的，下面写了哪几项、为什么；多数切换生效一次就会补上。
      </p>
      {q.isPending ? (
        <Skeleton className="mt-3 h-40" />
      ) : q.isError && !q.data ? (
        <LoadFailed title="分类核对取不回来" onRetry={() => void q.refetch()} retrying={q.isFetching} />
      ) : (
        <>
          <DataTable className="mt-3" variant="plain" columns={columns} rows={rows} rowKey={(r) => r.code} rowTestId={(r) => `price-category-${r.code}`} testId="price-category-table" />
          {bad.some((r) => r.hidden.length) && (
            <div className="mt-4 rounded-md border border-clay/40 bg-clay-soft/40 p-3" data-testid="price-category-hidden">
              <p className="text-[13px] font-bold text-clay">这些项与前台开单、房态中心登记、点单页对不上：</p>
              <ul className="mt-1.5 space-y-1 text-[13px] text-ink-2">
                {bad.flatMap((r) =>
                  r.hidden.map((h) => (
                    <li key={`${r.code}-${h.name}`}>
                      <span className="text-ink-3">{r.name} · </span>
                      <span className="font-semibold">{h.name}</span>：{h.reason}
                    </li>
                  )),
                )}
              </ul>
            </div>
          )}
        </>
      )}
    </Card>
  );
}
