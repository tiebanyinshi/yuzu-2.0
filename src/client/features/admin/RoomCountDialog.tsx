// 房态中心房型的「数量」（店主 2026-11-24：比如休息大厅设成 101 个床位）：选这个房型里的一种业态，填要几间（几个床位），
// 缺的按「编码前缀 + 补零序号」一次建进空间台账（显示名 = 名称前缀 + 序号），房态中心马上多出这些卡片。
// 先预览（现有几间、要新建几间、编码从哪到哪、有没有编码已被占）再保存；保存带着预览时看到的「现有几间」，期间有变化服务端拒绝。
// 比现有的少不在这里减：停用到空间台账里一间间停（停用前会检查有没有客人、有没有挂客房）。

import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { RoomCategory } from '@shared/room-center';
import { MAX_CAPACITY, SPACE_BATCH_MAX, type SpaceBatchPlan } from '@shared/spaces';
import { api, errorMessage, UncertainError } from '../../lib/api';
import { Dialog } from '../../components/Overlay';
import { LoadFailed } from '../../components/LoadFailed';
import { useToast } from '../../components/Toast';
import { Button, Field, Input, Notice, Select, Skeleton } from '../../components/ui';
import { useSpaceLedger, useInvalidateSpaces } from '../spaces/queries';

/** 业态默认的编码前缀与名称前缀：大厅类按床位算 */
function defaults(businessType: string) {
  const lobby = /大厅|大堂|休息区|休息厅/.test(businessType);
  return { prefix: lobby ? 'BED' : 'R', namePrefix: lobby ? '床位 ' : `${businessType} ` };
}

const intOrNull = (v: string) => (v.trim() === '' ? null : Number.isInteger(Number(v)) ? Number(v) : NaN);

export function RoomCountDialog({ category, counts, onClose }: { category: RoomCategory; counts: Map<string, number>; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const invalidate = useInvalidateSpaces();
  const ledger = useSpaceLedger();
  const [businessType, setBusinessType] = useState(category.businessTypes[0] ?? '');
  const current = counts.get(businessType) ?? 0;
  const [target, setTarget] = useState(String(Math.max(current, 1)));
  const [floorId, setFloorId] = useState<number | null>(null);
  const [zoneId, setZoneId] = useState<number | null>(null);
  const [prefix, setPrefix] = useState(defaults(businessType).prefix);
  const [namePrefix, setNamePrefix] = useState(defaults(businessType).namePrefix);
  const [start, setStart] = useState('');
  const [capacity, setCapacity] = useState('1');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 换业态：现有数量、前缀跟着换
  useEffect(() => {
    const d = defaults(businessType);
    setPrefix(d.prefix);
    setNamePrefix(d.namePrefix);
    setTarget(String(Math.max(counts.get(businessType) ?? 0, 1)));
    setStart('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [businessType]);
  // 楼层默认：这种业态已有空间所在的那一层，没有就第一层
  const floors = (ledger.data?.floors ?? []).filter((f) => f.active);
  useEffect(() => {
    if (!ledger.data || floorId !== null) return;
    const sample = ledger.data.spaces.find((s) => s.active && s.businessType === businessType);
    setFloorId(sample?.floorId ?? floors[0]?.id ?? null);
    setZoneId(sample?.zoneId ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ledger.data, businessType]);
  const zones = (ledger.data?.zones ?? []).filter((z) => z.active && z.floorId === floorId);

  const n = intOrNull(target);
  const st = intOrNull(start);
  const cap = intOrNull(capacity);
  const valid = businessType && n !== null && !Number.isNaN(n) && n >= 1 && n <= MAX_CAPACITY && floorId !== null && /^[A-Za-z]{1,4}$/.test(prefix.trim()) && !Number.isNaN(st) && !Number.isNaN(cap);
  const body = {
    businessType,
    target: n,
    floorId,
    zoneId,
    prefix: prefix.trim().toUpperCase(),
    start: st,
    width: 3,
    namePrefix,
    capacity: cap,
  };
  const bodyKey = JSON.stringify(body);
  const [debounced, setDebounced] = useState(bodyKey);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(bodyKey), 300);
    return () => clearTimeout(t);
  }, [bodyKey]);
  const preview = useQuery({
    queryKey: ['admin', 'spaces', 'batch-preview', debounced],
    queryFn: () => api.post<SpaceBatchPlan>('/api/admin/spaces/batch', { ...(JSON.parse(debounced) as object), preview: true }),
    enabled: !!valid && debounced === bodyKey,
    retry: false,
  });
  const p = valid && debounced === bodyKey ? preview.data : undefined;

  const save = async () => {
    if (!p || !p.create || p.taken.length) return;
    setSaving(true);
    setError(null);
    try {
      const r = await api.post<SpaceBatchPlan>('/api/admin/spaces/batch', { ...body, start: p.start, current: p.current });
      toast({ tone: 'success', title: r.created ? `已新建 ${r.created} 间「${businessType}」，现在共 ${r.target} 间` : `「${businessType}」已经是 ${r.target} 间` });
      await invalidate();
      await qc.invalidateQueries({ queryKey: ['admin', 'room-categories'] });
      await qc.invalidateQueries({ queryKey: ['room-center'] });
      onClose();
    } catch (e) {
      // 结果不确定：重新预览就知道建上没有（保存是按目标数算的，已经建好的再点一次不会重复建）
      setError(e instanceof UncertainError ? '没收到结果：请稍等再看预览里的「现有」间数，已经建好就不用再保存；没建好再点一次保存（不会重复建）' : errorMessage(e));
      void preview.refetch();
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open
      onClose={saving ? () => {} : onClose}
      title={`设置数量 · ${category.name}`}
      description="填这种业态要几间（大厅填几个床位），缺的一次建进空间台账，房态中心马上就有。比现在少的请到空间台账里停用。"
      width="max-w-xl"
      footer={
        <>
          {error && (
            <span className="mr-auto self-center text-[13px] text-clay" data-testid="room-count-error">
              {error}
            </span>
          )}
          <Button variant="secondary" size="lg" onClick={onClose} disabled={saving}>
            取消
          </Button>
          <Button variant="primary" size="lg" loading={saving} disabled={!p || !p.create || p.taken.length > 0} onClick={() => void save()} data-testid="room-count-save">
            {p && p.create ? `新建 ${p.create} 间` : '保存'}
          </Button>
        </>
      }
    >
      {ledger.isPending ? (
        <Skeleton className="h-48" />
      ) : ledger.isError && !ledger.data ? (
        <LoadFailed title="空间台账没取回来" onRetry={() => void ledger.refetch()} retrying={ledger.isFetching} />
      ) : category.businessTypes.length === 0 ? (
        <Notice tone="warning" title="这个房型还没有业态">
          先点「修改」给它加一种业态（比如「休息大厅」），再设数量。
        </Notice>
      ) : (
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="业态">
              <Select value={businessType} onChange={(e) => setBusinessType(e.target.value)} data-testid="room-count-type">
                {category.businessTypes.map((t) => (
                  <option key={t} value={t}>
                    {t}（现有 {counts.get(t) ?? 0} 间）
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={`设成几间（现有 ${current} 间）`}>
              <Input type="number" inputMode="numeric" min={1} max={MAX_CAPACITY} value={target} onChange={(e) => setTarget(e.target.value)} data-testid="room-count-target" />
            </Field>
            <Field label="放在哪一层">
              <Select
                value={floorId ?? ''}
                onChange={(e) => {
                  setFloorId(e.target.value ? Number(e.target.value) : null);
                  setZoneId(null);
                }}
                data-testid="room-count-floor"
              >
                {floors.length === 0 && <option value="">先在空间台账里建楼层</option>}
                {floors.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.code} {f.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="区域（可不选）">
              <Select value={zoneId ?? ''} onChange={(e) => setZoneId(e.target.value ? Number(e.target.value) : null)} data-testid="room-count-zone">
                <option value="">不选</option>
                {zones.map((z) => (
                  <option key={z.id} value={z.id}>
                    {z.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="编码前缀（1–4 个字母）" hint="编码 = 前缀 + 三位序号，例如 BED001">
              <Input value={prefix} maxLength={4} onChange={(e) => setPrefix(e.target.value.toUpperCase())} data-testid="room-count-prefix" />
            </Field>
            <Field label="起始序号" hint="不填：接着这个前缀已有的最大序号">
              <Input type="number" inputMode="numeric" min={0} value={start} onChange={(e) => setStart(e.target.value)} placeholder="自动" data-testid="room-count-start" />
            </Field>
            <Field label="名称前缀" hint="卡片上显示：名称前缀 + 序号，例如「床位 001」">
              <Input value={namePrefix} maxLength={20} onChange={(e) => setNamePrefix(e.target.value)} data-testid="room-count-name" />
            </Field>
            <Field label="每间容量（人，可不填）">
              <Input type="number" inputMode="numeric" min={1} max={MAX_CAPACITY} value={capacity} onChange={(e) => setCapacity(e.target.value)} data-testid="room-count-capacity" />
            </Field>
          </div>
          <div className="rounded-lg border border-line bg-paper-2 px-4 py-3 text-[13.5px] text-ink-2" data-testid="room-count-preview">
            {!valid ? (
              <span>填好数量、楼层、编码前缀后自动预览</span>
            ) : preview.isError ? (
              <span className="text-clay">{errorMessage(preview.error)}</span>
            ) : !p ? (
              <span>正在预览…</span>
            ) : p.create === 0 ? (
              <span>
                「{p.businessType}」已经是 <b className="num">{p.current}</b> 间，不用新建
              </span>
            ) : (
              <div className="space-y-1">
                <p>
                  现有 <b className="num">{p.current}</b> 间 → 设成 <b className="num">{p.target}</b> 间：新建 <b className="num text-pine">{p.create}</b> 间
                  {p.create > SPACE_BATCH_MAX && `（一次最多 ${SPACE_BATCH_MAX}）`}
                </p>
                <p className="num text-ink-3">
                  编码 {p.codesFirst.join('、')}
                  {p.codesLast.length > 0 && ` … ${p.codesLast.join('、')}`}
                </p>
                {p.taken.length > 0 && (
                  <p className="text-clay" data-testid="room-count-taken">
                    编码 {p.taken.slice(0, 5).join('、')}
                    {p.taken.length > 5 && ` 等 ${p.taken.length} 个`} 已在台账里：换前缀或起始序号
                  </p>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </Dialog>
  );
}
