// 柜况（8.1.49，docs/LOCKERS_V8149.md）：全店手牌柜此刻的状态，按「男宾 / 女宾 × 普通柜各区 / VIP 各级」分组计数；
// 数据就是发卡台的手牌板（每 10 秒刷新），这里只看不发牌。点一个柜子看详情；接了智能柜锁控制器的，
// 有「维护手牌池」权限的人可以远程开柜（写原因、记审计）。没接控制器时不显示开柜。
// 接了发卡器的（第 6 节，泰格柜锁、M1 手牌）：顶上「发卡器」读卡、清卡；点柜子「写卡」把发卡器上的卡写成这个柜。
// 写卡、清卡、开柜没收到回答（桥没回答，或浏览器没收到门店系统的回话）都按「结果待确认」：写卡、清卡记在本机，
// 发卡器下面列出来，读卡核对出结论才去掉（lockerCardPending.ts，Codex 审查 34a7c87）；开柜请到柜前确认。不说「没成功」。

import { useMemo, useState } from 'react';
import { Navigate } from 'react-router';
import { useMutation, useQuery } from '@tanstack/react-query';
import { CreditCard, DoorOpen, Eraser, Lock, PenLine, TriangleAlert } from 'lucide-react';
import { TAG_SERVICE_LABELS, ZONE_LABELS, type BoardTag } from '@shared/frontdesk';
import {
  groupLockers,
  lockerState,
  LOCKER_LOCK_KIND_LABELS,
  LOCKER_STATES,
  LOCKER_STATE_LABELS,
  settleLockerCardPending,
  type LockerCardPending,
  type LockerCardReadView,
  type LockerCardResult,
  type LockerControllerInfo,
  type LockerOpenResult,
  type LockerState,
} from '@shared/lockers';
import { api, errorMessage, UncertainError } from '../../lib/api';
import { useCan, useSession } from '../../lib/session';
import { cn, formatDateTime, uuid } from '../../lib/utils';
import { PageHeader } from '../../components/AppShell';
import { LoadFailed } from '../../components/LoadFailed';
import { Dialog } from '../../components/Overlay';
import { ReasonDialog } from '../../components/ReasonDialog';
import { useToast } from '../../components/Toast';
import { Badge, Button, Card, InfoItem, Notice, Segmented, Skeleton } from '../../components/ui';
import { lockerCardPending, useLockerCardPending } from './lockerCardPending';
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
type ControllerView = LockerControllerInfo & { reasons: string[]; cardReasons: string[] };
type WriteResult = LockerCardResult & { code: string; boundTag: { id: number; code: string } | null };

/** 存不了待核对记录：不发（AGENTS.md：保存不了就不发请求） */
const NOT_SAVED = { tone: 'error' as const, title: '本机记不下待核对记录，没有发', body: '浏览器存不了数据（隐私窗口或存满了）：换个普通窗口再试。' };

export function LockersPage() {
  const can = useCan();
  if (!can('frontdesk.read')) return <Navigate to="/crm" replace />;
  return <LockersView canOpen={can('frontdesk.tags')} />;
}

function LockersView({ canOpen }: { canOpen: boolean }) {
  const board = useBoard();
  const controller = useQuery({ queryKey: ['lockers', 'controller'], queryFn: () => api.get<ControllerView>('/api/lockers/controller'), staleTime: 60_000 });
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
              {controller.data?.canCard && <CardEncoder canWrite={canOpen} reasons={controller.data.cardReasons} />}
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

function LockerDialog({ tag, controller, canOpen, onClose }: { tag: BoardTag | null; controller: ControllerView | null; canOpen: boolean; onClose: () => void }) {
  const toast = useToast();
  const [asking, setAsking] = useState(false);
  const [writing, setWriting] = useState(false);
  const storeId = useSession().store.id;
  const write = useMutation({
    mutationFn: ({ reason }: { reason: string; pendingId: string; code: string }) => api.post<WriteResult>(`/api/lockers/${tag!.id}/card/write`, { reason }),
    onSuccess: (r, { pendingId }) => {
      setWriting(false);
      // 桥没回答、读回也对不上：记录留着，发卡器下面读卡核对
      if (!r.ok && r.uncertain)
        return toast({ tone: 'info', title: `写卡结果待确认：柜 ${r.code}`, body: `${r.message}。已记在发卡器下面：把这张卡放上去点「读卡」核对；没写成再写一次（写同一张卡没坏处）。` });
      lockerCardPending.remove(pendingId);
      if (!r.ok) return toast({ tone: 'error', title: `没写成柜 ${r.code} 的卡`, body: r.message });
      // 芯片号还没绑这张手牌的，提示去后台「手牌」绑（不自动改绑，GK6）
      const bind = !r.uid
        ? ''
        : !r.boundTag
          ? `芯片号 ${r.uid} 还没绑手牌：到后台「手牌」绑到 ${r.code}，发牌时刷卡才认得。`
          : r.boundTag.code !== r.code
            ? `芯片号 ${r.uid} 现在绑的是 ${r.boundTag.code}：到后台「手牌」改绑到 ${r.code}。`
            : '';
      toast({ tone: bind ? 'info' : 'success', title: `已写成柜 ${r.code} 的卡`, body: [r.message, bind].filter(Boolean).join(' ') });
    },
    onError: (e, { pendingId, code }) => {
      setWriting(false);
      // 没收到门店系统的回话（超时、断网、5xx，包括写审计出错）：卡可能已经写了，记录留着
      if (e instanceof UncertainError)
        return toast({ tone: 'info', title: `写卡结果待确认：柜 ${code}`, body: '没收到门店系统的回答，卡可能已经写了。已记在发卡器下面：把这张卡放上去点「读卡」核对，不要当成没写成。' });
      lockerCardPending.remove(pendingId);
      toast({ tone: 'error', title: '写卡没有成功', body: errorMessage(e) });
    },
  });
  const startWrite = (reason: string) => {
    if (!tag) return;
    const pendingId = uuid();
    if (!lockerCardPending.add({ id: pendingId, op: 'write', code: tag.code, storeId, at: new Date().toISOString() })) return toast(NOT_SAVED);
    write.mutate({ reason, pendingId, code: tag.code });
  };
  const open = useMutation({
    mutationFn: ({ reason }: { reason: string; code: string }) => api.post<LockerOpenResult>(`/api/lockers/${tag!.id}/open`, { reason }),
    onSuccess: (r) => {
      setAsking(false);
      toast(
        r.opened
          ? { tone: 'success', title: `柜 ${r.code} 已开`, body: r.message }
          : r.uncertain
            ? { tone: 'error', title: `柜 ${r.code} 开没开结果待确认`, body: `${r.message}（不要当成没开）` }
            : { tone: 'error', title: `柜 ${r.code} 没有开`, body: r.message },
      );
    },
    onError: (e, { code }) => {
      setAsking(false);
      // 没收到门店系统的回话：柜门可能已经开了
      if (e instanceof UncertainError) return toast({ tone: 'info', title: `柜 ${code} 开没开结果待确认`, body: '没收到门店系统的回答，柜门可能已经开了：请到柜前确认，不要当成没开。' });
      toast({ tone: 'error', title: '远程开柜没有成功', body: errorMessage(e) });
    },
  });
  if (!tag) return null;
  const s = lockerState(tag);
  const showOpen = canOpen && !!controller?.canOpen;
  const showWrite = canOpen && !!controller?.canCard;
  return (
    <>
      <Dialog
        open={!!tag && !asking && !writing}
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
            {showWrite && (
              <Button variant="secondary" onClick={() => setWriting(true)} data-testid="locker-card-write">
                <PenLine className="size-4" /> 写卡
              </Button>
            )}
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
        onConfirm={(reason) => open.mutate({ reason, code: tag.code })}
      />
      <ReasonDialog
        open={writing}
        title={`写卡：柜 ${tag.code}`}
        description={
          tag.visit
            ? '这个柜子有客人在用：写好的卡能开这个柜，请确认是给客人补卡。把要写的手牌放在发卡器上。'
            : '把要写的手牌放在发卡器上；写好以后这张卡能开这个柜（衣物柜、手机柜按柜锁桥的对照表）。'
        }
        confirmLabel="写卡"
        danger={!!tag.visit}
        busy={write.isPending}
        reasons={controller?.cardReasons}
        testId="locker-card-write-reason"
        onClose={() => setWriting(false)}
        onConfirm={startWrite}
      />
    </>
  );
}

/** 发卡器：读放在上面的手牌（芯片号、能开哪几把锁、绑的是哪张手牌）；有「维护手牌池」的可以清卡（退牌回收、作废） */
function CardEncoder({ canWrite, reasons }: { canWrite: boolean; reasons: string[] }) {
  const toast = useToast();
  const storeId = useSession().store.id;
  const pending = useLockerCardPending(storeId);
  const [clearing, setClearing] = useState(false);
  const read = useMutation({
    mutationFn: () => api.post<LockerCardReadView>('/api/lockers/card/read', {}),
    onSuccess: (c) => {
      // 读到的卡能给哪几条待核对的下结论：有结论的去掉
      for (const check of settleLockerCardPending(pending, c)) {
        lockerCardPending.remove(check.id);
        toast({ tone: check.outcome === 'done' ? 'success' : 'info', title: check.text });
      }
    },
    onError: (e) => toast({ tone: 'error', title: '读卡没有成功', body: errorMessage(e) }),
  });
  const card = read.data;
  const clear = useMutation({
    // 只清刚读到的那张卡：发卡器上换成了别的卡就不动
    mutationFn: ({ reason, uid }: { reason: string; uid: string | null; pendingId: string }) => api.post<LockerCardResult>('/api/lockers/card/clear', { reason, uid }),
    onSuccess: (r, { pendingId }) => {
      setClearing(false);
      if (!r.ok && r.uncertain) return toast({ tone: 'info', title: '清卡结果待确认', body: `${r.message}。已记在下面：把这张卡放上去点「读卡」核对；没清成再清一次。` });
      lockerCardPending.remove(pendingId);
      toast(r.ok ? { tone: 'success', title: '已清卡', body: r.message } : { tone: 'error', title: '没清成', body: r.message });
      if (r.ok) read.reset();
    },
    onError: (e, { pendingId }) => {
      setClearing(false);
      // 没收到门店系统的回话：卡可能已经清了，记录留着
      if (e instanceof UncertainError) {
        read.reset();
        return toast({ tone: 'info', title: '清卡结果待确认', body: '没收到门店系统的回答，卡可能已经清了。已记在下面：把这张卡放上去点「读卡」核对，不要当成没清成。' });
      }
      lockerCardPending.remove(pendingId);
      toast({ tone: 'error', title: '清卡没有成功', body: errorMessage(e) });
    },
  });
  const startClear = (reason: string) => {
    const uid = card?.uid ?? null;
    const pendingId = uuid();
    if (!lockerCardPending.add({ id: pendingId, op: 'clear', uid, storeId, at: new Date().toISOString() })) return toast(NOT_SAVED);
    clear.mutate({ reason, uid, pendingId });
  };
  return (
    <Card className="space-y-3 p-4" data-testid="locker-card-encoder">
      <div className="flex flex-wrap items-center gap-2">
        <CreditCard className="size-4 text-ink-3" />
        <h3 className="text-[14px] font-bold text-ink">发卡器</h3>
        <span className="text-[12px] text-ink-3">把手牌放在发卡器上再读；写卡在点开的柜子里</span>
        <span className="flex-1" />
        <Button size="sm" loading={read.isPending} onClick={() => read.mutate()} data-testid="locker-card-read">
          读卡
        </Button>
        {canWrite && card?.ok && (
          <Button size="sm" variant="secondary" onClick={() => setClearing(true)} data-testid="locker-card-clear">
            <Eraser className="size-4" /> 清卡
          </Button>
        )}
      </div>
      {pending.length > 0 && <PendingChecks pending={pending} />}
      {card &&
        (card.ok ? (
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4" data-testid="locker-card-result">
            <InfoItem label="芯片号">
              <span className="num">{card.uid ?? '—'}</span>
            </InfoItem>
            <InfoItem label="卡里写的柜">{card.code ?? '空白卡'}</InfoItem>
            <InfoItem label="能开">{card.locks.length ? card.locks.map((l) => `${LOCKER_LOCK_KIND_LABELS[l.kind]} ${l.no}`).join('、') : '—'}</InfoItem>
            <InfoItem label="芯片号绑的手牌">{card.tag?.code ?? '没绑'}</InfoItem>
            {card.mismatch && (
              <Notice tone="warning" className="col-span-full">
                卡里写的是柜 {card.code}，芯片号绑的却是 {card.tag?.code}：发牌时刷卡带出的牌号与能开的柜对不上，重写这张卡或到后台「手牌」改绑。
              </Notice>
            )}
          </div>
        ) : (
          <Notice tone="warning">{card.message}</Notice>
        ))}
      <ReasonDialog
        open={clearing}
        title="清卡"
        description={`把发卡器上的手牌${card?.uid ? `（芯片号 ${card.uid}）` : ''}清成空白：清了以后它开不了任何柜。`}
        confirmLabel="清卡"
        danger
        busy={clear.isPending}
        reasons={reasons}
        testId="locker-card-clear-reason"
        onClose={() => setClearing(false)}
        onConfirm={startClear}
      />
    </Card>
  );
}

/** 没核对的写卡、清卡：读卡核对出结论自动去掉；核对过了（比如那张卡已经找不到、重写过了）可以手动去掉 */
function PendingChecks({ pending }: { pending: LockerCardPending[] }) {
  return (
    <Notice tone="warning" title="结果待确认：把那张卡放在发卡器上点「读卡」核对" className="space-y-1" data-testid="locker-card-pending">
      <ul className="space-y-1.5">
        {pending.map((p) => (
          <li key={p.id} className="flex flex-wrap items-center gap-x-3 gap-y-1" data-testid="locker-card-pending-item">
            <span className="min-w-0 flex-1">
              {p.op === 'write'
                ? `写卡 · 柜 ${p.code} · ${formatDateTime(p.at)}：卡里是柜 ${p.code} 就是写成了，不是就再写一次`
                : `清卡${p.uid ? ` · 芯片号 ${p.uid}` : ''} · ${formatDateTime(p.at)}：读回是空白就是清成了`}
            </span>
            <Button size="sm" variant="ghost" onClick={() => lockerCardPending.remove(p.id)} data-testid="locker-card-pending-dismiss">
              已核对
            </Button>
          </li>
        ))}
      </ul>
    </Notice>
  );
}
