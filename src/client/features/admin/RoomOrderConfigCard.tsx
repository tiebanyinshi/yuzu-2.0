// 后台 → 餐饮 →「房态点单」（回测整改 P08，docs/YUZU_REQ_V820.md 第 9 节，RT17）：按出品口配置房态中心里能点哪几个分类
// （康美部在房间里点水吧、果吧就是这几类）。水吧按点单小分类，果吧按价目分类；不限定是全部能点。改要「修改经营规则」，改动记审计。

import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ROOM_ORDER_OUTLET_LABELS, ROOM_ORDER_OUTLETS, type RoomOrderConfig, type RoomOrderConfigAdmin, type RoomOrderOutlet } from '@shared/room-orders';
import { api, errorMessage } from '../../lib/api';
import { useCan } from '../../lib/session';
import { cn, formatDateTime } from '../../lib/utils';
import { useToast } from '../../components/Toast';
import { LoadFailed } from '../../components/LoadFailed';
import { Badge, Button, Card, Notice, SectionTitle, Segmented, Skeleton } from '../../components/ui';

type Draft = RoomOrderConfig['outlets'];
const key = ['admin', 'room-order-config'] as const;

export function RoomOrderConfigCard() {
  const can = useCan();
  const editable = can('settings.manage');
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: key, queryFn: () => api.get<RoomOrderConfigAdmin>('/api/admin/room-order-config') });
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (q.data) setDraft(q.data.outlets);
  }, [q.data]);

  const save = async () => {
    if (!draft) return;
    setSaving(true);
    setError(null);
    try {
      qc.setQueryData(key, await api.put<RoomOrderConfigAdmin>('/api/admin/room-order-config', { outlets: draft }));
      void qc.invalidateQueries({ queryKey: ['room-center', 'order-config'] });
      toast({ tone: 'success', title: '房态点单的分类已保存', body: '房间里的点单面板马上按新的分类显示' });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };
  const set = (o: RoomOrderOutlet, categories: string[] | null) => setDraft((d) => (d ? { ...d, [o]: { categories } } : d));
  const dirty = !!draft && !!q.data && JSON.stringify(draft) !== JSON.stringify(q.data.outlets);

  return (
    <Card className="p-5" data-testid="room-order-config">
      <SectionTitle aside={!editable && <Badge>只有店主能改</Badge>}>房态点单能点的分类</SectionTitle>
      <p className="mt-1 text-[13px] text-ink-3">房态中心「在用」的房间上点水吧、果吧（康美部）时只出这几类。水吧按点单小分类，果吧按价目分类；不限定就是全部。</p>
      {q.isPending ? (
        <Skeleton className="mt-3 h-32" />
      ) : q.isError && !q.data ? (
        <LoadFailed title="房态点单的配置取不回来" onRetry={() => void q.refetch()} />
      ) : draft ? (
        <div className="mt-3 space-y-4">
          {ROOM_ORDER_OUTLETS.map((o) => {
            const cur = draft[o].categories;
            const available = [...new Set([...q.data.available[o], ...(cur ?? [])])];
            return (
              <div key={o} data-testid={`room-order-config-${o}`}>
                <div className="flex flex-wrap items-center gap-2">
                  <p className="text-[14px] font-bold">{ROOM_ORDER_OUTLET_LABELS[o]}</p>
                  <Segmented
                    size="sm"
                    value={cur === null ? 'all' : 'some'}
                    onChange={(v) => editable && set(o, v === 'all' ? null : [...available])}
                    options={[
                      { value: 'all', label: '全部能点' },
                      { value: 'some', label: '只点这几类' },
                    ]}
                    ariaLabel={`${ROOM_ORDER_OUTLET_LABELS[o]}能点的分类`}
                  />
                </div>
                {cur !== null && (
                  <div className="mt-2 flex flex-wrap gap-2">
                    {available.length === 0 && <span className="text-[13px] text-ink-3">菜单里还没有{ROOM_ORDER_OUTLET_LABELS[o]}的菜</span>}
                    {available.map((c) => {
                      const on = cur.includes(c);
                      return (
                        <label
                          key={c}
                          className={cn('flex cursor-pointer items-center gap-2 rounded-md border px-3 py-1.5 text-[13px]', on ? 'border-pine bg-pine-tint' : 'border-line-strong bg-card')}
                        >
                          <input
                            type="checkbox"
                            className="size-4 accent-[var(--color-pine)]"
                            checked={on}
                            disabled={!editable}
                            onChange={() => set(o, on ? cur.filter((x) => x !== c) : [...cur, c])}
                            data-testid={`room-order-config-${o}-${c}`}
                          />
                          {c}
                          {!q.data.available[o].includes(c) && <span className="text-[12px] text-ink-4">（菜单里已经没有）</span>}
                        </label>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
          {error && <Notice tone="error" title={error} />}
          <div className="flex flex-wrap items-center gap-3">
            {editable && (
              <Button variant="primary" loading={saving} disabled={!dirty} onClick={save} data-testid="room-order-config-save">
                保存
              </Button>
            )}
            {q.data.updatedBy && (
              <span className="text-[12.5px] text-ink-3">
                {q.data.updatedBy} 于 {formatDateTime(q.data.updatedAt!)} 改过
              </span>
            )}
          </div>
        </div>
      ) : null}
    </Card>
  );
}
