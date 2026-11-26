// 休息大厅开单（福田店 FT-16，2026-11-26，docs/FUTIAN_1126.md）：一屏填完——手牌、项目（选技师等级 / 档次，写着各档价格）、技师性别、技师、床位
// （按后台设的分区列，FT-15）；多张床位一行一张，点一次「全部提交」逐行提交、各自成单（每行各有自己的操作编号与「结果待确认」）。
// 每一行就是一次房态中心登记（挂账 + 派钟 + 占床位）；技师下钟床位就空（FT-12）。轮钟的给队列里第一位空闲、能做这个项目、性别对的技师（前面几行选过的跳过）。

import { useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Plus, Trash2 } from 'lucide-react';
import { tierPrice, type PriceTier } from '@shared/catalog';
import type { BoardTechnician, ClockroomBoard } from '@shared/clockroom';
import { formatYuan } from '@shared/money';
import { ROOM_SERVICE_EXCLUDED_CATEGORIES } from '@shared/price-catalog';
import { isLobbyBusinessType, type RoomCard, type RoomCenterBoard } from '@shared/room-center';
import { canServe, gradeLabel, tierFor, type CallType } from '@shared/technicians';
import type { ServiceItem } from '@shared/types';
import { api } from '../../lib/api';
import { useCatalog } from '../../lib/queries';
import { useSession } from '../../lib/session';
import { cn, uuid } from '../../lib/utils';
import { LoadFailed } from '../../components/LoadFailed';
import { Money } from '../../components/Money';
import { Dialog } from '../../components/Overlay';
import { Button, Input, Notice, Select, Skeleton } from '../../components/ui';
import { PendingPanel, useFrontdeskOp } from '../frontdesk/pending';
import { clockroomKey, roomUrl } from './queries';
import { DUAL_LABELS, foundPosted } from './RegisterDialog';

type TechGender = 'any' | 'male' | 'female';
interface Row {
  id: string;
  bedId: number | null;
  tag: string;
  itemId: number | null;
  tier: PriceTier | null;
  gender: TechGender;
  /** 技师号；空 = 轮钟 */
  techNo: string;
}
const newRow = (bedId: number | null = null): Row => ({ id: uuid(), bedId, tag: '', itemId: null, tier: null, gender: 'any', techNo: '' });

type Outcome = { state: 'idle' } | { state: 'done' } | { state: 'error'; message: string };

export function HallOrderDialog({ board, onClose, onDone }: { board: RoomCenterBoard; onClose: () => void; onDone: (board: RoomCenterBoard | null) => void }) {
  const catalog = useCatalog();
  const clock = useQuery({ queryKey: clockroomKey, queryFn: () => api.get<ClockroomBoard>('/api/clockroom') });
  const beds = useMemo(() => board.rooms.filter((r) => r.kind === 'hall' && isLobbyBusinessType(r.businessType) && (r.status === 'free' || r.status === 'booked')), [board.rooms]);
  const [rows, setRows] = useState<Row[]>(() => [newRow(beds[0]?.spaceId ?? null)]);
  const [running, setRunning] = useState(false);
  const submits = useRef(new Map<string, () => Promise<boolean>>());
  const [outcomes, setOutcomes] = useState<Record<string, Outcome>>({});
  const items = useMemo(() => (catalog.data?.items ?? []).filter((i) => i.active && i.technicianRequired && !ROOM_SERVICE_EXCLUDED_CATEGORIES.includes(i.catalogCategory?.code ?? '')), [catalog.data]);
  const set = (id: string, patch: Partial<Row>) => setRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  const zones = [...board.hallZones.map((z) => ({ key: String(z.id), name: z.name })), { key: '', name: '没分区' }];
  const pending = rows.filter((r) => outcomes[r.id]?.state !== 'done');

  // 轮钟：每一行按前面几行已经选走的技师跳过
  const picked = (upto: number, cb: ClockroomBoard) => {
    const used = new Set<number>();
    rows.slice(0, upto).forEach((r, i) => {
      const t = techOf(r, i, cb, used);
      if (t) used.add(t.id);
    });
    return used;
  };
  const techOf = (r: Row, _i: number, cb: ClockroomBoard, used: Set<number>): BoardTechnician | null => {
    const item = items.find((x) => x.id === r.itemId);
    if (!item) return null;
    const ok = (t: BoardTechnician) =>
      (r.gender === 'any' || t.gender === r.gender) && !canServe(t, item, cb.techRules.tierByGrade) && !(cb.techRules.tierByGrade && r.tier && t.grade !== r.tier && item.prices.length > 1);
    if (r.techNo.trim()) return cb.technicians.find((t) => t.techNo === r.techNo.trim() && t.active && !t.suspendedAt && (t.state === 'on' || t.state === 'rest') && ok(t)) ?? null;
    return cb.technicians.filter((t) => t.state === 'on' && !t.busy && !t.suspendedAt && !used.has(t.id) && ok(t)).sort((a, b) => a.position! - b.position!)[0] ?? null;
  };

  const submitAll = async () => {
    setRunning(true);
    try {
      let failed = 0;
      for (const r of pending) {
        const fn = submits.current.get(r.id);
        if (!fn) continue;
        const ok = await fn();
        if (!ok) failed += 1;
      }
      if (failed === 0) onDone(null);
    } finally {
      setRunning(false);
    }
  };

  const cb = clock.data;
  return (
    <Dialog
      open
      onClose={running ? () => {} : onClose}
      width="max-w-5xl"
      title="休息大厅开单"
      description="一行一张床位：手牌、项目与档次（写着价格）、技师性别、技师（不填技师号按轮钟）、床位。点「全部提交」逐行提交，各自成单；没提交成的那一行写明原因，改好再提交。"
      footer={
        <>
          <span className="mr-auto self-center text-[13px] text-ink-3">
            共 {rows.length} 张床位{Object.values(outcomes).some((o) => o.state === 'done') ? `，已提交 ${rows.length - pending.length} 张` : ''}
          </span>
          <Button variant="ghost" onClick={onClose} disabled={running}>
            关闭
          </Button>
          <Button variant="primary" size="lg" disabled={running || pending.length === 0} loading={running} onClick={() => void submitAll()} data-testid="rc-hall-submit">
            全部提交（{pending.length}）
          </Button>
        </>
      }
    >
      {clock.isError && !cb ? (
        <LoadFailed title="技师没取回来" onRetry={() => void clock.refetch()} retrying={clock.isFetching} />
      ) : !cb || !catalog.data ? (
        <Skeleton className="h-60" />
      ) : beds.length === 0 ? (
        <Notice tone="info" title="现在没有空着的大厅床位" />
      ) : (
        <div className="space-y-2" data-testid="rc-hall">
          {rows.map((r, i) => (
            <HallRow
              key={r.id}
              row={r}
              index={i}
              beds={beds}
              zones={zones}
              items={items}
              clock={cb}
              tech={techOf(r, i, cb, picked(i, cb))}
              takenBeds={new Set(rows.filter((x) => x.id !== r.id).flatMap((x) => (x.bedId === null ? [] : [x.bedId])))}
              outcome={outcomes[r.id] ?? { state: 'idle' }}
              onChange={(patch) => set(r.id, patch)}
              onRemove={rows.length > 1 && outcomes[r.id]?.state !== 'done' ? () => setRows((rs) => rs.filter((x) => x.id !== r.id)) : undefined}
              register={(fn) => submits.current.set(r.id, fn)}
              onOutcome={(o) => setOutcomes((m) => ({ ...m, [r.id]: o }))}
            />
          ))}
          <Button
            variant="secondary"
            icon={<Plus className="size-4" />}
            disabled={running}
            onClick={() => {
              const used = new Set(rows.map((x) => x.bedId));
              const prev = rows[rows.length - 1];
              setRows((rs) => [...rs, { ...newRow(beds.find((b) => !used.has(b.spaceId))?.spaceId ?? null), itemId: prev?.itemId ?? null, tier: prev?.tier ?? null, gender: prev?.gender ?? 'any' }]);
            }}
            data-testid="rc-hall-add-row"
          >
            再加一张床位
          </Button>
        </div>
      )}
    </Dialog>
  );
}

function HallRow({
  row: r,
  index,
  beds,
  zones,
  items,
  clock,
  tech,
  takenBeds,
  outcome,
  onChange,
  onRemove,
  register,
  onOutcome,
}: {
  row: Row;
  index: number;
  beds: RoomCard[];
  zones: { key: string; name: string }[];
  items: ServiceItem[];
  clock: ClockroomBoard;
  tech: BoardTechnician | null;
  takenBeds: Set<number>;
  outcome: Outcome;
  onChange: (patch: Partial<Row>) => void;
  onRemove?: () => void;
  register: (fn: () => Promise<boolean>) => void;
  onOutcome: (o: Outcome) => void;
}) {
  const session = useSession();
  const op = useFrontdeskOp<RoomCenterBoard | true>({ type: 'bill_post', visitId: null, staffName: session.staff.displayName, pick: foundPosted });
  const item = items.find((x) => x.id === r.itemId) ?? null;
  const bed = beds.find((b) => b.spaceId === r.bedId) ?? null;
  const rules = clock.techRules;
  const chosenTier: PriceTier | null = item ? (tech ? tierFor(tech, item, r.tier ?? item.prices[0]!.tier, rules.tierByGrade) : (r.tier ?? item.prices[0]!.tier)) : null;
  const price = item && chosenTier ? tierPrice(item.prices, chosenTier) : null;
  const byGrade = rules.tierByGrade && !!item && item.prices.length > 1;
  const callType: CallType = r.techNo.trim() ? 'designated' : 'rotation';
  const problem = !bed
    ? '请选床位'
    : takenBeds.has(bed.spaceId!)
      ? '这张床位别的行选了'
      : !r.tag.trim()
        ? '请填手牌号'
        : !item
          ? '请选项目'
          : !tech
            ? r.techNo.trim()
              ? `${r.techNo} 号不能做（没上牌、性别或等级不对）`
              : '没有空闲、能做的技师'
            : price === null
              ? '这一档没有价格'
              : null;
  const done = outcome.state === 'done';
  register(async () => {
    if (done) return true;
    if (problem || !bed || !item || !tech || price === null) {
      onOutcome({ state: 'error', message: problem ?? '没填完' });
      return false;
    }
    const res = await op.submit((key) => ({
      url: roomUrl(bed.spaceId!, 'register'),
      body: {
        clientKey: key,
        tagCode: r.tag.trim().toUpperCase(),
        itemId: item.id,
        tier: byGrade ? undefined : chosenTier,
        quantity: 1,
        technicianId: tech.id,
        callType,
        sellerNo: session.staff.username,
        note: '',
        start: 'now',
        expectedTotal: price,
      },
      tagCodes: [r.tag.trim().toUpperCase()],
      summary: `大厅开单 ${bed.code}：手牌 ${r.tag.trim().toUpperCase()} · ${item.name}（${tech.techNo} 号 ${tech.name}）`,
      amount: price,
    }));
    if (res) {
      onOutcome({ state: 'done' });
      return true;
    }
    onOutcome({ state: 'error', message: op.state.phase === 'error' ? op.state.message : '没提交成，看上面的提示' });
    return false;
  });
  const lock = done || op.locked;
  return (
    <div className={cn('rounded-lg border px-3 py-2', done ? 'border-pine/50 bg-pine-tint' : outcome.state === 'error' ? 'border-clay/50' : 'border-line')} data-testid={`rc-hall-row-${index}`}>
      <PendingPanel op={op} onResolved={() => onOutcome({ state: 'done' })} />
      <div className="grid items-end gap-2 md:grid-cols-[130px_110px_minmax(0,1fr)_150px_96px_96px_auto]">
        <label className="flex flex-col gap-1 text-[12px] font-semibold text-ink-3">
          床位
          <Select value={r.bedId ?? ''} disabled={lock} onChange={(e) => onChange({ bedId: e.target.value ? Number(e.target.value) : null })} data-testid="rc-hall-bed">
            <option value="">选床位</option>
            {zones.map((z) => {
              const list = beds.filter((b) => String(b.hallZone?.id ?? '') === z.key);
              return list.length ? (
                <optgroup key={z.key || 'none'} label={z.name}>
                  {list.map((b) => (
                    <option key={b.spaceId} value={b.spaceId!}>
                      {b.code}
                    </option>
                  ))}
                </optgroup>
              ) : null;
            })}
          </Select>
        </label>
        <label className="flex flex-col gap-1 text-[12px] font-semibold text-ink-3">
          手牌
          <Input value={r.tag} maxLength={8} disabled={lock} onChange={(e) => onChange({ tag: e.target.value })} placeholder="手牌号" data-testid="rc-hall-tag" />
        </label>
        <label className="flex flex-col gap-1 text-[12px] font-semibold text-ink-3">
          项目
          <Select value={r.itemId ?? ''} disabled={lock} onChange={(e) => onChange({ itemId: e.target.value ? Number(e.target.value) : null, tier: null })} data-testid="rc-hall-item">
            <option value="">选项目</option>
            {items.map((i) => (
              <option key={i.id} value={i.id}>
                {i.catalogCode ? `${i.catalogCode} ` : ''}
                {i.name}
              </option>
            ))}
          </Select>
        </label>
        <label className="flex flex-col gap-1 text-[12px] font-semibold text-ink-3">
          技师等级 · 价格
          <Select value={r.tier ?? ''} disabled={lock || !item || item.prices.length < 2} onChange={(e) => onChange({ tier: (e.target.value || null) as PriceTier | null })} data-testid="rc-hall-tier">
            {item ? (
              item.prices.map((p) => (
                <option key={p.tier} value={p.tier}>
                  {item.catalogCategory ? DUAL_LABELS[p.tier] : gradeLabel(p.tier)} {formatYuan(p.price)}
                </option>
              ))
            ) : (
              <option value="">先选项目</option>
            )}
          </Select>
        </label>
        <label className="flex flex-col gap-1 text-[12px] font-semibold text-ink-3">
          技师性别
          <Select value={r.gender} disabled={lock} onChange={(e) => onChange({ gender: e.target.value as TechGender })} data-testid="rc-hall-gender">
            <option value="any">不限</option>
            <option value="male">男</option>
            <option value="female">女</option>
          </Select>
        </label>
        <label className="flex flex-col gap-1 text-[12px] font-semibold text-ink-3">
          技师号
          <Input value={r.techNo} maxLength={8} inputMode="numeric" disabled={lock} onChange={(e) => onChange({ techNo: e.target.value.trim() })} placeholder="轮钟" data-testid="rc-hall-techno" />
        </label>
        {onRemove ? <Button variant="ghost" icon={<Trash2 className="size-4" />} aria-label="删掉这一行" onClick={onRemove} disabled={lock} /> : <span />}
      </div>
      <p className="mt-1 flex flex-wrap items-center gap-x-3 text-[12.5px]" data-testid="rc-hall-row-state">
        {done ? (
          <span className="font-bold text-pine">已提交，{bed?.code ?? ''} 在用</span>
        ) : (
          <>
            <span className={problem ? 'text-clay' : 'text-ink-3'}>{problem ?? `${tech!.techNo} 号 ${tech!.name}（${callType === 'rotation' ? '轮钟' : '点钟'} · ${gradeLabel(tech!.grade)}）`}</span>
            {price !== null && !problem && <Money cents={price} className="font-bold text-ink" />}
            {outcome.state === 'error' && <span className="font-semibold text-clay">{outcome.message}</span>}
          </>
        )}
      </p>
    </div>
  );
}
