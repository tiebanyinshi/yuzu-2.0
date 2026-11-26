// 后台「空间台账 → 房态中心房型」下面的「休息大厅分区与床位」（福田店 FT-15，2026-11-26，docs/FUTIAN_1126.md）：
// 自定义分区名称（A 区、B 区，或第一排、第二排……），把休息大厅一类的床位归到分区里；开单选床位时按分区列。
// 床位本身是空间台账里的空间：要加床位用上面房型卡片的「设数量」（休息大厅），停用床位在空间台账里停用。

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import type { HallZonesAdmin } from '@shared/room-center';
import { api, errorMessage } from '../../lib/api';
import { LoadFailed } from '../../components/LoadFailed';
import { useToast } from '../../components/Toast';
import { Button, Card, Input, Notice, SectionTitle, Select, Skeleton } from '../../components/ui';

const KEY = ['admin', 'hall-zones'] as const;

export function HallZonesCard() {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: KEY, queryFn: () => api.get<HallZonesAdmin>('/api/admin/hall-zones') });
  const [name, setName] = useState('');
  const [edits, setEdits] = useState<Record<number, number | null>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (fn: () => Promise<HallZonesAdmin>, ok: string) => {
    setBusy(true);
    setError(null);
    try {
      qc.setQueryData(KEY, await fn());
      void qc.invalidateQueries({ queryKey: ['room-center'] });
      toast({ tone: 'success', title: ok });
      return true;
    } catch (e) {
      setError(errorMessage(e));
      return false;
    } finally {
      setBusy(false);
    }
  };
  if (q.isPending) return <Skeleton className="h-40" />;
  if (q.isError && !q.data) return <LoadFailed title="大厅分区没取回来" onRetry={() => void q.refetch()} retrying={q.isFetching} />;
  const d = q.data!;
  const zones = d.zones.filter((z) => z.active);
  const changed = Object.entries(edits).filter(([id, z]) => d.beds.find((b) => b.spaceId === Number(id))?.zoneId !== z);
  return (
    <Card className="space-y-4 p-5" data-testid="hall-zones">
      <SectionTitle>休息大厅分区与床位</SectionTitle>
      <p className="text-[13px] text-ink-2">分区名称自己定（A 区、第一排……），把床位归进去；大厅开单选床位时按分区列。要加床位用上面房型的「设数量」（休息大厅）。</p>
      <div className="flex flex-wrap items-center gap-2">
        {zones.map((z) => (
          <span key={z.id} className="inline-flex items-center gap-1.5 rounded-full bg-paper-2 py-1 pr-1 pl-3 text-[13px] font-semibold" data-testid={`hall-zone-${z.name}`}>
            {z.name} <span className="text-[12px] font-normal text-ink-3">{z.beds} 张</span>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => void run(() => api.put<HallZonesAdmin>(`/api/admin/hall-zones/${z.id}`, { name: z.name, sortOrder: z.sortOrder, active: false }), `已删掉「${z.name}」`)}
              aria-label={`删掉分区${z.name}`}
            >
              删
            </Button>
          </span>
        ))}
        <span className="flex items-center gap-1.5">
          <Input
            fullWidth={false}
            className="w-32"
            value={name}
            maxLength={12}
            onChange={(e) => setName(e.target.value)}
            placeholder="新分区名称"
            aria-label="新分区名称"
            data-testid="hall-zone-name"
          />
          <Button
            variant="secondary"
            icon={<Plus className="size-4" />}
            disabled={busy || !name.trim()}
            onClick={async () => {
              if (await run(() => api.post<HallZonesAdmin>('/api/admin/hall-zones', { name: name.trim(), sortOrder: zones.length + 1 }), `已加分区「${name.trim()}」`)) setName('');
            }}
            data-testid="hall-zone-add"
          >
            加分区
          </Button>
        </span>
      </div>
      {d.beds.length === 0 ? (
        <p className="text-[13px] text-ink-3">空间台账里还没有休息大厅的床位</p>
      ) : (
        <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3" data-testid="hall-beds">
          {d.beds.map((b) => (
            <li key={b.spaceId} className="flex items-center gap-2 rounded-lg border border-line px-3 py-1.5 text-[13px]">
              <span className="num w-14 font-bold">{b.code}</span>
              <span className="min-w-0 flex-1 truncate text-ink-3">{b.name}</span>
              <Select
                fullWidth={false}
                className="w-28"
                value={(b.spaceId in edits ? edits[b.spaceId] : b.zoneId) ?? ''}
                onChange={(e) => setEdits((m) => ({ ...m, [b.spaceId]: e.target.value ? Number(e.target.value) : null }))}
                aria-label={`${b.code} 的分区`}
                data-testid={`hall-bed-${b.code}`}
              >
                <option value="">不分区</option>
                {zones.map((z) => (
                  <option key={z.id} value={z.id}>
                    {z.name}
                  </option>
                ))}
              </Select>
            </li>
          ))}
        </ul>
      )}
      {error && <Notice tone="error" title={error} />}
      <Button
        variant="primary"
        disabled={busy || changed.length === 0}
        onClick={async () => {
          if (
            await run(() => api.put<HallZonesAdmin>('/api/admin/hall-zones/beds', { beds: changed.map(([id, zoneId]) => ({ spaceId: Number(id), zoneId })) }), `已保存 ${changed.length} 张床位的分区`)
          )
            setEdits({});
        }}
        data-testid="hall-beds-save"
      >
        保存床位分区{changed.length ? `（${changed.length}）` : ''}
      </Button>
    </Card>
  );
}
