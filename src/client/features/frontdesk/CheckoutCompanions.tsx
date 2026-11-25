// 结账对话框里的两块（8.1.44，《前台系统开发》，docs/V8144_FRONTDESK.md 第 3、5 条），单放一个文件，结账对话框只加两行：
//   · 同行：分批到的客人，买单时勾到一起结的手牌可以顺手「记为同行」（组成同行组，之后也看得到是一起的）；
//     同组里不一起结的（没勾上的）照旧留在组里稍后单独结，客人不愿意算一组的可以「拆出同行组」。都用原来的同行接口。
//   · 查会员、现场建档：按手机号查这位客人是不是会员、充没充过值、有多少余额（别漏用余额）；查到的、当场新建的会员记到
//     这次结账里还没有会员的那张手牌上，结账核对随之带出储值、会员折扣与券；会员已经在别的手牌上的，合并到这次结账。

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link2, Search, Unlink, UserPlus, UserRoundCheck } from 'lucide-react';
import { memberBalanceHint, type CashierMemberHit } from '@shared/cashier-member';
import type { CheckoutPreview } from '@shared/checkout';
import type { BoardTag, VisitDetail } from '@shared/frontdesk';
import { maskPhone } from '@shared/labels';
import { api, errorMessage } from '../../lib/api';
import { useCan } from '../../lib/session';
import { Money } from '../../components/Money';
import { useToast } from '../../components/Toast';
import { Badge, Button, Input, Select } from '../../components/ui';
import { MemberFormDialog } from '../workbench/MemberFormDialog';

/** 同行：勾进来但不在同行组里的手牌「记为同行」；同组没勾的「拆出同行组」 */
export function CompanionTools({ visit, tags, selected, locked, onChanged }: { visit: VisitDetail; tags: BoardTag[]; selected: number[]; locked: boolean; onChanged: () => void }) {
  const can = useCan();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const mates = visit.group?.mates.filter((m) => m.status === 'open') ?? [];
  const inGroup = new Set(mates.map((m) => m.visitId));
  inGroup.add(visit.id);
  const codeOf = (id: number) => tags.find((t) => t.visit?.id === id)?.code ?? mates.find((m) => m.visitId === id)?.tagCode ?? String(id);
  const outsiders = selected.filter((id) => !inGroup.has(id));
  const leftOut = mates.filter((m) => m.visitId !== visit.id && !selected.includes(m.visitId));
  if (!can('frontdesk.checkout') && !can('frontdesk.operate')) return null;
  if (outsiders.length === 0 && leftOut.length === 0) return null;

  const run = async (fn: () => Promise<void>, ok: string, fail: string) => {
    setBusy(true);
    try {
      await fn();
      toast({ tone: 'success', title: ok });
      onChanged();
    } catch (e) {
      toast({ tone: 'error', title: fail, body: errorMessage(e) });
      onChanged();
    } finally {
      setBusy(false);
    }
  };
  const join = () =>
    run(
      async () => {
        for (const id of outsiders) await api.post(`/api/frontdesk/visits/${id}/group`, { action: 'join', targetVisitId: visit.id });
      },
      `${outsiders.map(codeOf).join('、')} 已和 ${visit.tag.code} 记为同行`,
      '记为同行没有成功',
    );
  const leave = (id: number) => run(() => api.post(`/api/frontdesk/visits/${id}/group`, { action: 'leave' }).then(() => undefined), `${codeOf(id)} 已拆出同行组`, '拆出同行组没有成功');

  return (
    <div className="mt-2 space-y-1.5 rounded-lg bg-paper-2/60 px-3 py-2 text-[12.5px] text-ink-2" data-testid="checkout-companions">
      {outsiders.length > 0 && (
        <p className="flex flex-wrap items-center gap-2">
          <span>
            {outsiders.map(codeOf).join('、')} 和 {visit.tag.code} 不在一个同行组里（这次照样一起结）。
          </span>
          <Button size="sm" variant="secondary" icon={<Link2 className="size-3.5" />} disabled={locked || busy} onClick={join} data-testid="checkout-companions-join">
            记为同行
          </Button>
        </p>
      )}
      {leftOut.length > 0 && (
        <div className="space-y-1">
          <p>没勾的同行留在组里，稍后单独结账；客人不想算一组的，拆出同行组：</p>
          <div className="flex flex-wrap gap-1.5">
            {leftOut.map((m) => (
              <Button
                key={m.visitId}
                size="sm"
                variant="ghost"
                icon={<Unlink className="size-3.5" />}
                disabled={locked || busy}
                onClick={() => leave(m.visitId)}
                data-testid={`checkout-companions-leave-${m.tagCode}`}
              >
                {m.tagCode} 拆出同行组
              </Button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/** 查会员、现场建档，记到这次结账里还没有会员的手牌上 */
export function CheckoutMemberLookup({
  preview,
  locked,
  onChanged,
  onAddVisit,
}: {
  preview: CheckoutPreview;
  locked: boolean;
  /** 记好会员以后：重新核对结账、刷新手牌 */
  onChanged: () => void;
  /** 查到的会员在别的手牌上：把那张手牌加进这次结账 */
  onAddVisit: (visitId: number) => void;
}) {
  const can = useCan();
  const toast = useToast();
  const [q, setQ] = useState('');
  const [term, setTerm] = useState('');
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const free = preview.visits.filter((v) => v.memberId === null);
  const [target, setTarget] = useState<number | null>(null);
  const targetId = free.find((v) => v.visitId === target)?.visitId ?? free[0]?.visitId ?? null;
  const found = useQuery({
    queryKey: ['frontdesk', 'member-lookup', term],
    queryFn: () => api.get<CashierMemberHit[]>(`/api/frontdesk/member-lookup?q=${encodeURIComponent(term)}`),
    enabled: term.length > 0 && can('member.read'),
    staleTime: 0,
  });
  if (!can('member.read')) return null;
  const inCheckout = new Set(preview.visits.map((v) => v.visitId));
  const tagOf = (id: number | null) => preview.visits.find((v) => v.visitId === id)?.tagCode ?? '';

  const bind = async (memberId: number, name: string) => {
    if (targetId === null) return;
    setBusy(true);
    try {
      await api.post(`/api/frontdesk/visits/${targetId}/member`, { memberId });
      toast({ tone: 'success', title: `会员「${name}」已记到手牌 ${tagOf(targetId)} 上`, body: '结账核对已按会员重新算（储值、会员折扣、券）' });
      setTerm('');
      setQ('');
      onChanged();
    } catch (e) {
      toast({ tone: 'error', title: '记会员没有成功', body: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };

  const hits = found.data ?? [];
  return (
    <div className="rounded-lg border border-line bg-paper/50 p-3" data-testid="checkout-member-lookup">
      <form
        className="flex flex-wrap items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          setTerm(q.trim());
        }}
      >
        <span className="mr-1 text-[13px] font-bold text-ink-2">查会员</span>
        <Input
          fullWidth={false}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="客人手机号 / 姓名 / 会员号"
          inputMode="search"
          maxLength={64}
          className="h-10 min-w-0 flex-1 basis-48"
          aria-label="买单时查会员"
          data-testid="checkout-member-q"
        />
        <Button size="sm" variant="secondary" type="submit" icon={<Search className="size-3.5" />} disabled={!q.trim()} data-testid="checkout-member-search">
          查
        </Button>
        {can('member.write') && free.length > 0 && (
          <Button size="sm" variant="ghost" icon={<UserPlus className="size-3.5" />} disabled={locked || busy} onClick={() => setCreating(true)} data-testid="checkout-member-create">
            现场建档
          </Button>
        )}
      </form>
      {free.length > 1 && (
        <label className="mt-2 flex flex-wrap items-center gap-2 text-[12.5px] text-ink-3">
          记到手牌
          <Select fullWidth={false} value={targetId ?? ''} onChange={(e) => setTarget(Number(e.target.value))} className="h-9 w-28" aria-label="会员记到哪张手牌">
            {free.map((v) => (
              <option key={v.visitId} value={v.visitId}>
                {v.tagCode}
              </option>
            ))}
          </Select>
        </label>
      )}
      {term && found.isError && <p className="mt-2 text-[12.5px] font-semibold text-clay">{errorMessage(found.error)}</p>}
      {term && found.isSuccess && hits.length === 0 && (
        <p className="mt-2 text-[12.5px] text-ink-3" data-testid="checkout-member-none">
          没有查到会员{can('member.write') && free.length > 0 ? '，可以「现场建档」' : ''}
        </p>
      )}
      {hits.length > 0 && (
        <ul className="mt-2 space-y-1.5">
          {hits.map((m) => {
            const hint = memberBalanceHint(m);
            const here = m.openVisitId !== null && inCheckout.has(m.openVisitId);
            return (
              <li key={m.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md bg-card px-3 py-2 text-[12.5px]" data-testid={`checkout-member-hit-${m.memberNo}`}>
                <span className="font-bold text-ink">{m.name}</span>
                <span className="num text-ink-3">
                  {m.memberNo} · {maskPhone(m.phone)}
                </span>
                <span className="text-ink-2">
                  余额 <Money cents={m.principalBalance + m.bonusBalance} size="key" />
                </span>
                <Badge tone={hint.tone}>{hint.text}</Badge>
                <span className="flex-1" />
                {m.merged || m.status !== 'active' ? (
                  <span className="text-clay">{m.merged ? '已合并' : '已停用'}</span>
                ) : here ? (
                  <Badge tone="pine" icon={<UserRoundCheck className="size-3" />}>
                    已在这次结账里（{m.openTagCode}）
                  </Badge>
                ) : m.openVisitId !== null ? (
                  <Button size="sm" variant="secondary" disabled={locked} onClick={() => onAddVisit(m.openVisitId!)} data-testid="checkout-member-merge">
                    在手牌 {m.openTagCode} 上 · 合并到这次结账
                  </Button>
                ) : targetId !== null ? (
                  <Button size="sm" variant="primary" disabled={locked || busy} onClick={() => bind(m.id, m.name)} data-testid="checkout-member-bind">
                    记到手牌 {tagOf(targetId)}
                  </Button>
                ) : (
                  <span className="text-ink-3">这次结账的手牌都已记着会员</span>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {creating && (
        <MemberFormDialog
          open
          prefill={q.trim()}
          onClose={() => setCreating(false)}
          onSaved={(m) => {
            setCreating(false);
            void bind(m.id, m.name);
          }}
          onOpenExisting={() => {
            // 手机号已经建过档：不新建，直接查这位
            setCreating(false);
            setTerm(q.trim());
          }}
        />
      )}
    </div>
  );
}
