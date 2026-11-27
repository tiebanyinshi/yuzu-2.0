// 后台「餐饮 → 档口与出品」：菜单分组的默认档口与核对列表（8.2.4，docs/V8224_DINING.md 第 1 节）。
// 给一个点单分类（例如「餐厅 · 点心」）设默认档口（茶点），没「单独设档口」的菜按分组走；核对列表列出菜自己的档口与分组默认不一致的菜：
// 「跟分组」的按分组的档口出，「单独设」的照菜自己的档口出（例如虾饼确实在中厨做），可以一道道切换。

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { allDiningSlots, slotKey, slotLabel, type DiningOutletDef, type KitchenStation } from '@shared/dining';
import type { GroupStationsAdmin } from '@shared/dining-v8224';
import { api, errorMessage } from '../../lib/api';
import { Badge, Button, Card, Notice, SectionTitle, Select, Skeleton } from '../../components/ui';
import { useToast } from '../../components/Toast';

const key = ['admin', 'dining', 'group-stations'] as const;

export function GroupStationsCard({ outlets, stations, editable }: { outlets: readonly DiningOutletDef[]; stations: KitchenStation[]; editable: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const data = useQuery({ queryKey: key, queryFn: () => api.get<GroupStationsAdmin>('/api/admin/dining/group-stations') });
  const [draft, setDraft] = useState<Record<string, number> | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!data.data) return <Skeleton className="h-32" />;
  const current = draft ?? data.data.groupStations;
  const dirty = draft !== null && JSON.stringify(draft) !== JSON.stringify(data.data.groupStations);
  const slots = allDiningSlots(outlets);
  const usable = stations.filter((s) => s.active);

  const run = async (fn: () => Promise<GroupStationsAdmin>, done: string) => {
    setBusy(true);
    setError(null);
    try {
      const next = await fn();
      qc.setQueryData(key, next);
      setDraft(null);
      void qc.invalidateQueries({ queryKey: ['dining'] });
      toast({ tone: 'success', title: done });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const save = () => run(() => api.put<GroupStationsAdmin>('/api/admin/dining/group-stations', { groupStations: current }), '分组默认档口已保存');
  const pin = (itemId: number, pinned: boolean) =>
    run(() => api.put<GroupStationsAdmin>('/api/admin/dining/items/pinned', { items: [{ id: itemId, pinned }] }), pinned ? '这道菜照自己的档口出' : '这道菜跟分组的档口出');

  return (
    <Card className="p-5" data-testid="dining-group-stations">
      <SectionTitle>分组默认档口</SectionTitle>
      <p className="mt-1 text-[12.5px] text-ink-3">
        点单分类设了默认档口的，这一类里没单独设档口的菜都到这个档口出（例如「点心」都到茶点）。菜品编辑里选的档口和分组默认不一样，就记成「单独设」，照菜自己的档口出。设了档口时段的菜，时段里照时段的档口。
      </p>
      <ul className="mt-3 grid gap-2 sm:grid-cols-2">
        {slots.map((s) => {
          const k = slotKey(s);
          return (
            <li key={k} className="flex items-center gap-2 rounded-lg border border-line px-3 py-2">
              <span className="min-w-0 flex-1 truncate text-[13.5px] font-semibold">{slotLabel(s)}</span>
              <Select
                fullWidth={false}
                value={current[k] ?? ''}
                disabled={!editable || busy}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  const next = { ...current };
                  if (v) next[k] = v;
                  else delete next[k];
                  setDraft(next);
                }}
                className="h-9 w-32 text-[13px]"
                aria-label={`${slotLabel(s)}的默认档口`}
                data-testid={`group-station-${k}`}
              >
                <option value="">不设</option>
                {stations
                  .filter((st) => st.active || st.id === current[k])
                  .map((st) => (
                    <option key={st.id} value={st.id}>
                      {st.name}
                      {st.active ? '' : '（停用）'}
                    </option>
                  ))}
              </Select>
            </li>
          );
        })}
      </ul>
      {usable.length === 0 && <p className="mt-2 text-[12.5px] text-ink-3">先新建档口，再设分组的默认档口。</p>}
      {editable && (
        <div className="mt-3 flex justify-end">
          <Button variant="primary" loading={busy} disabled={!dirty} onClick={save} data-testid="group-stations-save">
            保存分组默认档口
          </Button>
        </div>
      )}
      {error && <Notice tone="error" title={error} className="mt-3" />}

      <h4 className="mt-5 text-[13.5px] font-bold text-ink-2">核对：菜自己的档口与分组默认不一致的菜（{data.data.mismatches.length}）</h4>
      {data.data.mismatches.length === 0 ? (
        <p className="mt-2 text-[12.5px] text-ink-3">没有不一致的菜。</p>
      ) : (
        <ul className="mt-2 divide-y divide-line/70 rounded-lg border border-line" data-testid="group-station-mismatches">
          {data.data.mismatches.map((m) => (
            <li key={m.itemId} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
              <span className="min-w-[96px] text-[13.5px] font-bold">{m.name}</span>
              <span className="min-w-0 flex-1 text-[12.5px] text-ink-3">
                {m.slotLabel} · 菜自己设的 {m.ownStationName}，分组默认 {m.groupStationName}
                {m.hasStationWindows ? ' · 设了档口时段' : ''}
              </span>
              <Badge tone={m.pinned ? 'clay' : 'pine'}>{m.pinned ? `单独设：在${m.ownStationName}出` : `跟分组：在${m.groupStationName}出`}</Badge>
              {editable && (
                <Button size="sm" variant="ghost" disabled={busy} onClick={() => pin(m.itemId, !m.pinned)} data-testid={`group-station-pin-${m.itemId}`}>
                  {m.pinned ? '改成跟分组' : '改成单独设'}
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
