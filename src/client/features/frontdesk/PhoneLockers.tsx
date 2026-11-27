// 手机柜（自选柜，docs/LOCKERS_V8149.md 第 7 节；店主 2026-11-27：衣物柜是固定柜，手机柜是自选柜）：
// 客人自己挑空柜、刷手牌锁上，一张手牌只能占一个、别的柜都开不了——这条由锁的网络拦；这里看谁占着哪个（每 10 秒刷新），
// 标出一牌多柜、已退牌还占着、不认得的卡；有「维护手牌池」的能远程开一个、释放一个（写原因、记审计）。
// 没收到回答的：开柜请到柜前确认；释放记在本机（lockerPending.ts），列表刷新核对出结论才去掉，不说「没成功」。

import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { DoorOpen, Smartphone, Unlock } from 'lucide-react';
import {
  LOCKER_SELECT_ISSUE_LABELS,
  LOCKER_UID_UNREADABLE,
  settleLockerSelectPending,
  type LockerPending,
  type LockerSelectPending,
  type LockerSelectResult,
  type LockerSelectView,
} from '@shared/lockers';
import { api, errorMessage, UncertainError } from '../../lib/api';
import { useLivePoll } from '../../lib/livePoll';
import { useSession } from '../../lib/session';
import { cn, formatDateTime, uuid } from '../../lib/utils';
import { Dialog } from '../../components/Overlay';
import { ReasonDialog } from '../../components/ReasonDialog';
import { useToast } from '../../components/Toast';
import { Badge, Button, Card, InfoItem, Notice } from '../../components/ui';
import { lockerPending, useLockerPending } from './lockerPending';

interface SelectList {
  slots: LockerSelectView[];
}

const isSelectPending = (p: LockerPending): p is LockerSelectPending => p.op === 'release';

const slotStyle = (s: LockerSelectView) =>
  !s.uid ? 'border-dashed border-line-strong bg-paper/60 text-ink-2' : s.issue ? 'border-clay/40 bg-clay-soft text-clay' : 'border-pine/40 bg-pine-soft text-pine';

export function PhoneLockers({ canManage, reasons }: { canManage: boolean; reasons: string[] }) {
  const toast = useToast();
  const storeId = useSession().store.id;
  const pending = useLockerPending(storeId).filter(isSelectPending);
  const [list, setList] = useState<SelectList | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [pickedNo, setPickedNo] = useState<string | null>(null);

  const load = async (isLive: () => boolean = () => true) => {
    try {
      // 本机发出这次查询的时间：只拿在释放之后才发出的查询核对（都用本机的钟，不和服务器的钟比）
      const askedAt = new Date().toISOString();
      const r = await api.get<SelectList>('/api/lockers/select');
      if (!isLive()) return;
      setList(r);
      setFailed(null);
      // 列表能给哪几条「释放待确认」下结论：有结论的去掉
      for (const check of settleLockerSelectPending(lockerPendingNow(storeId), r.slots, askedAt)) {
        lockerPending.remove(check.id);
        toast({ tone: 'success', title: check.text });
      }
    } catch (e) {
      if (isLive()) setFailed(errorMessage(e));
    }
  };
  useLivePoll(load, [storeId], { intervalMs: 10_000 });

  const slots = list?.slots ?? [];
  const picked = slots.find((s) => s.no === pickedNo) ?? null;
  const used = slots.filter((s) => s.uid).length;
  const issues = slots.filter((s) => s.issue);

  return (
    <Card className="space-y-3 p-4" data-testid="phone-lockers">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <Smartphone className="size-4 self-center text-ink-3" />
        <h3 className="text-[14px] font-bold text-ink">手机柜（自选柜）</h3>
        {list && (
          <span className="text-[12px] text-ink-3" data-testid="phone-lockers-summary">
            {slots.length} 个 · 占用 <span className="num">{used}</span> · 空闲 <span className="num">{slots.length - used}</span>
            {issues.length > 0 && (
              <>
                {' '}
                · 要处理 <span className="num font-bold text-clay">{issues.length}</span>
              </>
            )}
          </span>
        )}
        <span className="text-[12px] text-ink-3">客人自己挑空柜刷手牌锁上，一张手牌只能占一个；每 10 秒刷新</span>
      </div>
      {failed && (
        <Notice
          tone="warning"
          action={
            <Button size="sm" variant="secondary" onClick={() => void load()}>
              再试一次
            </Button>
          }
          data-testid="phone-lockers-error"
        >
          {failed}
        </Notice>
      )}
      {pending.length > 0 && (
        <Notice tone="warning" title="释放结果待确认：列表刷新后自动核对" data-testid="phone-lockers-pending">
          <ul className="space-y-1.5">
            {pending.map((p) => (
              <li key={p.id} className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className="min-w-0 flex-1">
                  释放手机柜 {p.no}
                  {p.uid ? `（芯片号 ${p.uid}）` : ''} · {formatDateTime(p.at)}：柜子空了就是释放了；还占着的可以再释放一次
                </span>
                <Button size="sm" variant="ghost" onClick={() => lockerPending.remove(p.id)}>
                  已核对
                </Button>
              </li>
            ))}
          </ul>
        </Notice>
      )}
      {issues.length > 0 && (
        <Notice tone="error" title="要处理的手机柜" data-testid="phone-lockers-issues">
          <ul className="space-y-1">
            {issues.map((s) => (
              <li key={s.no}>
                <button type="button" className="tap text-left underline-offset-2 hover:underline" onClick={() => setPickedNo(s.no)}>
                  手机柜 {s.no}：{LOCKER_SELECT_ISSUE_LABELS[s.issue!]}
                  {s.holder ? `（手牌 ${s.holder.code}）` : s.uid ? `（芯片号 ${s.uid}）` : ''}
                </button>
              </li>
            ))}
          </ul>
        </Notice>
      )}
      {list && (
        <div className="flex flex-wrap gap-1.5">
          {slots.map((s) => (
            <button
              key={s.no}
              type="button"
              data-testid={`phone-locker-${s.no}`}
              data-state={!s.uid ? 'free' : (s.issue ?? 'in_use')}
              aria-label={`手机柜 ${s.no}，${!s.uid ? '空闲' : s.issue ? LOCKER_SELECT_ISSUE_LABELS[s.issue] : '占用'}`}
              onClick={() => setPickedNo(s.no)}
              className={cn('tap num flex h-[42px] min-w-[74px] flex-col items-center justify-center rounded-[10px] border px-2 leading-tight font-bold active:scale-[0.98]', slotStyle(s))}
            >
              <span className="text-[14px]">{s.no}</span>
              {s.uid && <span className="text-[12px] font-normal">{s.holder?.code ?? '?'}</span>}
            </button>
          ))}
        </div>
      )}
      <SlotDialog slot={picked} canManage={canManage} reasons={reasons} onClose={() => setPickedNo(null)} onDone={() => void load()} storeId={storeId} toast={toast} />
    </Card>
  );
}

/** 同一轮里刚记下、刚删掉的也要看到：直接读本机记录（useLockerPending 的值是上一次渲染的） */
function lockerPendingNow(storeId: number): LockerSelectPending[] {
  return lockerPending.list().filter((p): p is LockerSelectPending => p.storeId === storeId && isSelectPending(p));
}

function SlotDialog({
  slot,
  canManage,
  reasons,
  onClose,
  onDone,
  storeId,
  toast,
}: {
  slot: LockerSelectView | null;
  canManage: boolean;
  reasons: string[];
  onClose: () => void;
  onDone: () => void;
  storeId: number;
  toast: ReturnType<typeof useToast>;
}) {
  const [asking, setAsking] = useState<'open' | 'release' | null>(null);
  const open = useMutation({
    mutationFn: ({ no, reason }: { no: string; reason: string }) => api.post<LockerSelectResult>(`/api/lockers/select/${encodeURIComponent(no)}/open`, { reason }),
    onSuccess: (r) => {
      setAsking(null);
      toast(
        r.ok
          ? { tone: 'success', title: `手机柜 ${r.no} 已开`, body: r.message }
          : r.uncertain
            ? { tone: 'info', title: `手机柜 ${r.no} 开没开结果待确认`, body: `${r.message}（不要当成没开）` }
            : { tone: 'error', title: `手机柜 ${r.no} 没有开`, body: r.message },
      );
      onDone();
    },
    onError: (e, { no }) => {
      setAsking(null);
      if (e instanceof UncertainError) return toast({ tone: 'info', title: `手机柜 ${no} 开没开结果待确认`, body: '没收到门店系统的回答，柜门可能已经开了：请到柜前确认，不要当成没开。' });
      toast({ tone: 'error', title: '远程开手机柜没有成功', body: errorMessage(e) });
    },
  });
  const release = useMutation({
    mutationFn: ({ no, reason, uid }: { no: string; reason: string; uid: string | null; pendingId: string }) =>
      api.post<LockerSelectResult>(`/api/lockers/select/${encodeURIComponent(no)}/release`, { reason, uid }),
    onSuccess: (r, { pendingId }) => {
      setAsking(null);
      onDone();
      if (!r.ok && r.uncertain) return toast({ tone: 'info', title: `释放手机柜 ${r.no} 结果待确认`, body: `${r.message}。已记在手机柜上面，列表刷新后自动核对。` });
      lockerPending.remove(pendingId);
      toast(r.ok ? { tone: 'success', title: `手机柜 ${r.no} 已释放`, body: r.message } : { tone: 'error', title: `手机柜 ${r.no} 没有释放`, body: r.message });
      if (r.ok) onClose();
    },
    onError: (e, { no, pendingId }) => {
      setAsking(null);
      // 没收到门店系统的回话：可能已经释放了，记录留着，列表刷新后核对
      if (e instanceof UncertainError) {
        onDone();
        return toast({ tone: 'info', title: `释放手机柜 ${no} 结果待确认`, body: '没收到门店系统的回答，可能已经释放了。已记在手机柜上面，列表刷新后自动核对，不要当成没释放。' });
      }
      lockerPending.remove(pendingId);
      toast({ tone: 'error', title: '释放手机柜没有成功', body: errorMessage(e) });
    },
  });
  if (!slot) return null;
  const startRelease = (reason: string) => {
    // 只放现在看到的那张手牌占着的：换了人占着就不动；芯片号无法识别的不带
    const uid = slot.uid && slot.uid !== LOCKER_UID_UNREADABLE ? slot.uid : null;
    const pendingId = uuid();
    if (!lockerPending.add({ id: pendingId, op: 'release', no: slot.no, uid, storeId, at: new Date().toISOString() }))
      return toast({ tone: 'error', title: '本机记不下待核对记录，没有发', body: '浏览器存不了数据（隐私窗口或存满了）：换个普通窗口再试。' });
    release.mutate({ no: slot.no, reason, uid, pendingId });
  };
  return (
    <>
      <Dialog
        open={!asking}
        onClose={onClose}
        title={
          <span className="flex items-center gap-2">
            手机柜 <span className="num">{slot.no}</span>
            <Badge tone={!slot.uid ? 'neutral' : slot.issue ? 'clay' : 'pine'}>{!slot.uid ? '空闲' : slot.issue ? LOCKER_SELECT_ISSUE_LABELS[slot.issue] : '占用'}</Badge>
          </span>
        }
        description="自选柜：客人自己挑、刷手牌锁上，一张手牌只能占一个"
        footer={
          <div className="flex justify-end gap-2">
            {canManage && (
              <Button variant="secondary" onClick={() => setAsking('open')} data-testid="phone-locker-open">
                <DoorOpen className="size-4" /> 远程开柜
              </Button>
            )}
            {canManage && slot.uid && (
              <Button variant="secondary" onClick={() => setAsking('release')} data-testid="phone-locker-release">
                <Unlock className="size-4" /> 释放
              </Button>
            )}
            <Button onClick={onClose}>关闭</Button>
          </div>
        }
      >
        <div className="grid grid-cols-2 gap-3" data-testid="phone-locker-dialog">
          <InfoItem label="占着的手牌">{slot.holder ? `${slot.holder.code}（衣物柜同号）` : slot.uid ? '没绑本店手牌' : '无'}</InfoItem>
          <InfoItem label="芯片号">
            <span className="num">{slot.uid ?? '—'}</span>
          </InfoItem>
          <InfoItem label="来访单">{slot.holder?.visitNo ?? (slot.holder ? '已退牌' : '—')}</InfoItem>
          <InfoItem label="占用起">{slot.since ? formatDateTime(slot.since) : '—'}</InfoItem>
          <InfoItem label="柜门">{slot.doorOpen === null ? '不知道' : slot.doorOpen ? '开着' : '关着'}</InfoItem>
          {slot.issue === 'returned' && (
            <Notice tone="warning" className="col-span-full">
              这张手牌已经退了还占着：释放以后柜子空出来，下一位拿到这张牌的客人也开不了。
            </Notice>
          )}
          {slot.issue === 'multi' && (
            <Notice tone="error" className="col-span-full">
              这张手牌占了不止一个手机柜（一张手牌只能占一个）：问清客人用的是哪个，其余的释放。
            </Notice>
          )}
        </div>
      </Dialog>
      <ReasonDialog
        open={asking === 'open'}
        title={`远程开手机柜 ${slot.no}`}
        description={slot.uid ? '这个柜子有人占着，请确认是本人要开（开了不释放）。' : undefined}
        confirmLabel="开柜"
        danger={!!slot.uid}
        busy={open.isPending}
        reasons={reasons}
        testId="phone-locker-open-reason"
        onClose={() => setAsking(null)}
        onConfirm={(reason) => open.mutate({ no: slot.no, reason })}
      />
      <ReasonDialog
        open={asking === 'release'}
        title={`释放手机柜 ${slot.no}`}
        description={`释放以后${slot.holder ? `手牌 ${slot.holder.code}` : '这张卡'}开不了这个柜，柜子空出来给别的客人用。请先确认柜里没有东西。`}
        confirmLabel="释放"
        danger
        busy={release.isPending}
        reasons={reasons}
        testId="phone-locker-release-reason"
        onClose={() => setAsking(null)}
        onConfirm={startRelease}
      />
    </>
  );
}
