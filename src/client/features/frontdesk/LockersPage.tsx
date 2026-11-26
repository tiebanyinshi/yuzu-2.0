// 柜况（8.1.49，docs/LOCKERS_V8149.md）：全店手牌柜此刻的状态，按「男宾 / 女宾 × 普通柜各区 / VIP 各级」分组计数；
// 数据就是发卡台的手牌板（每 10 秒刷新），这里只看不发牌。点一个柜子看详情；接了智能柜锁控制器的，
// 有「维护手牌池」权限的人可以远程开柜（写原因、记审计）。没接控制器时不显示开柜。

import { useMemo, useState } from 'react';
import { Navigate } from 'react-router';
import { useMutation, useQuery } from '@tanstack/react-query';
import { DoorOpen, Lock, TriangleAlert } from 'lucide-react';
import { TAG_SERVICE_LABELS, ZONE_LABELS, type BoardTag } from '@shared/frontdesk';
import { groupLockers, lockerState, LOCKER_STATES, LOCKER_STATE_LABELS, type LockerControllerInfo, type LockerOpenResult, type LockerState } from '@shared/lockers';
import { api, errorMessage } from '../../lib/api';
import { useCan } from '../../lib/session';
import { cn, formatDateTime } from '../../lib/utils';
import { PageHeader } from '../../components/AppShell';
import { LoadFailed } from '../../components/LoadFailed';
import { Dialog } from '../../components/Overlay';
import { ReasonDialog } from '../../components/ReasonDialog';
import { useToast } from '../../components/Toast';
import { Badge, Button, Card, InfoItem, Notice, Segmented, Skeleton } from '../../components/ui';
import { useBoard } from './queries';

const STATE_STYLE: Record<LockerState, string> = {
  free: 'border-dashed border-line-strong bg-paper/60 text-ink-2',
  in_use: 'border-pine/40 bg-pine-soft text-pine',
  locked: 'border-clay/30 bg-[repeating-linear-gradient(135deg,var(--color-paper-2)_0_6px,var(--color-paper-3)_6px_7px)] text-clay',
  paused: 'border-yuzu-deep/50 bg-yuzu-soft text-yuzu-deep',
  repair: 'border-ink-2 bg-ink-2 text-paper',
  inactive: 'border-line bg-paper-2 text-ink-3 line-through',
};
const STATE_TONE: Record<LockerState, 'neutral' | 'pine' | 'clay' | 'yuzu' | 'ink'> = {
  free: 'neutral',
  in_use: 'pine',
  locked: 'clay',
  paused: 'yuzu',
  repair: 'ink',
  inactive: 'neutral',
};

type Filter = 'all' | LockerState;

export function LockersPage() {
  const can = useCan();
  if (!can('frontdesk.read')) return <Navigate to="/crm" replace />;
  return <LockersView canOpen={can('frontdesk.tags')} />;
}

function LockersView({ canOpen }: { canOpen: boolean }) {
  const board = useBoard();
  const controller = useQuery({ queryKey: ['lockers', 'controller'], queryFn: () => api.get<LockerControllerInfo & { reasons: string[] }>('/api/lockers/controller'), staleTime: 60_000 });
  const [filter, setFilter] = useState<Filter>('all');
  const [picked, setPicked] = useState<BoardTag | null>(null);
  const { groups, total } = useMemo(() => groupLockers(board.data?.tags ?? []), [board.data]);
  const count = (board.data?.tags ?? []).length;

  return (
    <>
      <PageHeader title="柜况" subtitle="全店手牌柜此刻的状态；每 10 秒刷新。发牌、换牌、锁牌在发卡台" />
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[1280px] space-y-4 px-5 py-5 md:px-7" data-testid="lockers-page">
          {board.isError && !board.data ? (
            <LoadFailed title="柜况取不回来，请检查网络" onRetry={() => void board.refetch()} retrying={board.isFetching} testId="lockers-error" />
          ) : !board.data ? (
            <Skeleton className="h-40" />
          ) : (
            <>
              <Card className="flex flex-wrap items-center gap-x-5 gap-y-2 p-4" data-testid="lockers-summary">
                <span className="text-[14px] font-bold text-ink">
                  共 <span className="num">{count}</span> 个柜
                </span>
                {LOCKER_STATES.map((s) => (
                  <span key={s} className="inline-flex items-center gap-1.5 text-[13px] text-ink-2" data-testid={`lockers-total-${s}`}>
                    <span className={cn('inline-block size-3 rounded-sm border', STATE_STYLE[s])} />
                    {LOCKER_STATE_LABELS[s]} <span className="num font-bold text-ink">{total[s]}</span>
                  </span>
                ))}
              </Card>
              <Segmented<Filter>
                value={filter}
                onChange={setFilter}
                options={[{ value: 'all', label: '全部' }, ...LOCKER_STATES.map((s) => ({ value: s, label: `${LOCKER_STATE_LABELS[s]} ${total[s]}` }))]}
              />
              {controller.data && controller.data.driver === 'none' && canOpen && (
                <Notice tone="info">还没有接智能柜锁控制器：这里只看状态，不能远程开柜。控制器到货后照 docs/LOCKERS_V8149.md 配置。</Notice>
              )}
              {groups.map((g) => {
                const tags = filter === 'all' ? g.tags : g.tags.filter((t) => lockerState(t) === filter);
                if (!tags.length) return null;
                return (
                  <Card key={g.key} className="p-4" data-testid={`lockers-group-${g.key}`}>
                    <div className="mb-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
                      <h3 className="text-[14px] font-bold text-ink">{g.title}</h3>
                      <span className="text-[12px] text-ink-3">
                        {g.tags.length} 个 · 在用 <span className="num">{g.counts.in_use}</span> · 空闲 <span className="num">{g.counts.free}</span>
                        {g.counts.locked + g.counts.repair + g.counts.paused + g.counts.inactive > 0 && (
                          <>
                            {' '}
                            · 不可用 <span className="num">{g.counts.locked + g.counts.repair + g.counts.paused + g.counts.inactive}</span>
                          </>
                        )}
                      </span>
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {tags.map((t) => {
                        const s = lockerState(t);
                        return (
                          <button
                            key={t.id}
                            type="button"
                            data-testid={`locker-${t.code}`}
                            data-state={s}
                            aria-label={`柜 ${t.code}，${LOCKER_STATE_LABELS[s]}`}
                            onClick={() => setPicked(t)}
                            className={cn('tap num flex h-[34px] min-w-[74px] items-center justify-center gap-1 rounded-[10px] border px-2 text-[14px] font-bold active:scale-[0.98]', STATE_STYLE[s])}
                          >
                            {s === 'locked' && <Lock className="size-3" />}
                            {(s === 'repair' || s === 'paused') && <TriangleAlert className="size-3" />}
                            {t.code}
                          </button>
                        );
                      })}
                    </div>
                  </Card>
                );
              })}
            </>
          )}
        </div>
      </div>
      <LockerDialog tag={picked} controller={controller.data ?? null} canOpen={canOpen} onClose={() => setPicked(null)} />
    </>
  );
}

function LockerDialog({ tag, controller, canOpen, onClose }: { tag: BoardTag | null; controller: (LockerControllerInfo & { reasons: string[] }) | null; canOpen: boolean; onClose: () => void }) {
  const toast = useToast();
  const [asking, setAsking] = useState(false);
  const open = useMutation({
    mutationFn: (reason: string) => api.post<LockerOpenResult>(`/api/lockers/${tag!.id}/open`, { reason }),
    onSuccess: (r) => {
      setAsking(false);
      toast(r.opened ? { tone: 'success', title: `柜 ${r.code} 已开`, body: r.message } : { tone: 'error', title: `柜 ${r.code} 没有开`, body: r.message });
    },
    onError: (e) => toast({ tone: 'error', title: '远程开柜没有成功', body: errorMessage(e) }),
  });
  if (!tag) return null;
  const s = lockerState(tag);
  const showOpen = canOpen && !!controller?.canOpen;
  return (
    <>
      <Dialog
        open={!!tag && !asking}
        onClose={onClose}
        title={
          <span className="flex items-center gap-2">
            柜 <span className="num">{tag.code}</span>
            <Badge tone={STATE_TONE[s]}>{LOCKER_STATE_LABELS[s]}</Badge>
          </span>
        }
        description={`${ZONE_LABELS[tag.zone].title} · ${tag.kind === 'vip' ? `VIP 第 ${tag.vipLevel} 级` : '普通柜'}`}
        footer={
          <div className="flex justify-end gap-2">
            {showOpen && (
              <Button variant="secondary" onClick={() => setAsking(true)} data-testid="locker-open">
                <DoorOpen className="size-4" /> 远程开柜
              </Button>
            )}
            <Button onClick={onClose}>关闭</Button>
          </div>
        }
      >
        <div className="grid grid-cols-2 gap-3" data-testid="locker-dialog">
          {tag.visit ? (
            <>
              <InfoItem label="在用">{tag.visit.memberName ?? tag.visit.guestLabel}</InfoItem>
              <InfoItem label="来访单">{tag.visit.visitNo}</InfoItem>
              <InfoItem label="入场">{formatDateTime(tag.visit.checkedInAt)}</InfoItem>
              {tag.visit.groupNo && <InfoItem label="同行组">{tag.visit.groupNo}</InfoItem>}
            </>
          ) : (
            <InfoItem label="在用">无</InfoItem>
          )}
          {tag.locked && <InfoItem label="锁定原因">{tag.lockReason}</InfoItem>}
          {tag.serviceStatus !== 'normal' && <InfoItem label={TAG_SERVICE_LABELS[tag.serviceStatus]}>{tag.serviceNote || '—'}</InfoItem>}
        </div>
      </Dialog>
      <ReasonDialog
        open={asking}
        title={`远程开柜 ${tag.code}`}
        description={tag.visit ? '这个柜子有客人在用，请确认是客人本人要开。' : undefined}
        confirmLabel="开柜"
        danger={!!tag.visit}
        busy={open.isPending}
        reasons={controller?.reasons}
        testId="locker-open-reason"
        onClose={() => setAsking(false)}
        onConfirm={(reason) => open.mutate(reason)}
      />
    </>
  );
}
