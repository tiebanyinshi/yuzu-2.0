// 8.2.3 前台（发卡台与全店，docs/V8223_FRONTDESK.md）：页面上的几块
//   · GuestProfileCard：客人卡上的类别与偏好（发卡台、收银台都在备注板块上面）；
//   · GuestNoteStrip：全店刷手牌的地方看的那一条（点单、房态中心、钟房派钟）；
//   · GroupMates：客人卡上的同行手牌小标签，上面直接能移出同行组（一键确认）；
//   · RiskAlertsDialog：高风险提醒列表（发卡台顶上）。
import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link2, ShieldAlert, Sparkles, UserMinus } from 'lucide-react';
import { ZONE_LABELS, VISIT_STATUS_LABELS, type VisitDetail } from '@shared/frontdesk';
import { MAX_PREF_VALUE, RISK_REASON_LABELS, type GuestNotes, type RiskAlertRow } from '@shared/frontdesk-v8223';
import { api, errorMessage } from '../../lib/api';
import { useCan } from '../../lib/session';
import { cn, formatDateTime } from '../../lib/utils';
import { Money } from '../../components/Money';
import { Dialog } from '../../components/Overlay';
import { useToast } from '../../components/Toast';
import { Button, Input, Notice, Select, Skeleton } from '../../components/ui';
import { StatusChip } from './parts';
import { stayText, useGuestRules } from './queries';

/** 客人卡上的类别与偏好：发牌后也能改类别；偏好会员的跟着会员走（下次来自动带出），散客的只这一次 */
export function GuestProfileCard({ visit, onChanged }: { visit: VisitDetail; onChanged: (v: VisitDetail) => void }) {
  const can = useCan();
  const toast = useToast();
  const rules = useGuestRules();
  const open = visit.status === 'open';
  const writable = open && (can('frontdesk.operate') || can('frontdesk.checkout'));
  const [editing, setEditing] = useState(false);
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const prefs = visit.guest.prefs;
  useEffect(() => {
    setEditing(false);
    setError(null);
  }, [visit.id]);

  const changeCategory = async (category: string) => {
    try {
      onChanged(await api.post<VisitDetail>(`/api/frontdesk/visits/${visit.id}/category`, { category }));
      toast({ tone: 'success', title: `${visit.tag.code} 改为「${category}」` });
    } catch (e) {
      toast({ tone: 'error', title: '改类别未成功', body: errorMessage(e) });
    }
  };
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const changed = Object.fromEntries(Object.entries(values).filter(([k, v]) => (prefs.find((p) => p.key === k)?.value ?? '') !== v.trim()));
      if (Object.keys(changed).length) onChanged(await api.put<VisitDetail>(`/api/frontdesk/visits/${visit.id}/preferences`, { values: changed }));
      setEditing(false);
      toast({ tone: 'success', title: '客人偏好已保存' });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const filled = prefs.filter((p) => p.value);
  return (
    <section className="mt-3 rounded-[14px] border border-line bg-card px-4 py-3 shadow-card" aria-label="客人类别与偏好" data-testid="guest-profile">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-[13px] font-bold text-ink-2">客人类别</h3>
        {writable ? (
          <Select value={visit.guest.category} onChange={(e) => void changeCategory(e.target.value)} fullWidth={false} className="h-9 w-32" aria-label="客人类别" data-testid="guest-category">
            {[...new Set([...rules.categories, visit.guest.category])].map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </Select>
        ) : (
          <span className="text-[13px] font-semibold" data-testid="guest-category-text">
            {visit.guest.category}
          </span>
        )}
        <span className="ml-auto text-[12px] text-ink-3">{visit.guest.owner === 'member' ? '偏好跟着会员走，下次来自动带出' : '散客的偏好只记这一次'}</span>
      </div>
      {!editing ? (
        <div className="mt-2" data-testid="guest-prefs">
          {filled.length === 0 ? (
            <p className="text-[12.5px] text-ink-3">还没有偏好（{rules.prefFields.map((f) => f.label).join('、') || '后台没有设字段'}）</p>
          ) : (
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-[13px]">
              {filled.map((p) => (
                <div key={p.key} className="contents" data-testid={`guest-pref-${p.key}`}>
                  <dt className={cn('font-semibold text-ink-3', p.retired && 'line-through')}>{p.label}</dt>
                  <dd className="break-words text-ink">{p.value}</dd>
                </div>
              ))}
            </dl>
          )}
          {writable && rules.prefFields.length > 0 && (
            <Button
              size="sm"
              variant="ghost"
              className="mt-1 -ml-2"
              onClick={() => {
                setValues(Object.fromEntries(rules.prefFields.map((f) => [f.key, prefs.find((p) => p.key === f.key)?.value ?? ''])));
                setEditing(true);
              }}
              data-testid="guest-prefs-edit"
            >
              {filled.length ? '改偏好' : '填偏好'}
            </Button>
          )}
        </div>
      ) : (
        <div className="mt-2 space-y-2" data-testid="guest-prefs-form">
          {rules.prefFields.map((f) => (
            <label key={f.key} className="flex items-center gap-2 text-[13px] font-semibold text-ink-2">
              <span className="w-16 shrink-0">{f.label}</span>
              <Input
                value={values[f.key] ?? ''}
                maxLength={MAX_PREF_VALUE}
                onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}
                className="h-9"
                data-testid={`guest-pref-input-${f.key}`}
              />
            </label>
          ))}
          {error && <Notice tone="error" title={error} />}
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => setEditing(false)} disabled={busy}>
              取消
            </Button>
            <Button size="sm" variant="secondary" loading={busy} onClick={() => void save()} data-testid="guest-prefs-save">
              保存
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}

/** 全店刷手牌的地方看的那一条：类别、高风险、偏好、没撤下的备注；都没有时不占地方 */
export function GuestNoteStrip({ visitId, className }: { visitId: number | null | undefined; className?: string }) {
  const q = useQuery({
    queryKey: ['frontdesk', 'guest-notes', visitId],
    queryFn: () => api.get<GuestNotes[]>(`/api/frontdesk/guest-notes?visitIds=${visitId}`),
    enabled: !!visitId,
    staleTime: 15_000,
  });
  const n = q.data?.[0];
  if (!n || (!n.categoryMark && !n.highRisk && n.prefs.length === 0 && n.remarks.length === 0)) return null;
  return (
    <div className={cn('flex flex-wrap items-center gap-1.5 rounded-lg border border-line bg-paper-2/60 px-2.5 py-1.5 text-[13px]', className)} data-testid="guest-notes" aria-label="客人偏好与备注">
      {n.categoryMark && (
        <StatusChip tone="lake" icon={<Sparkles className="size-4 shrink-0" />}>
          {n.categoryMark}
        </StatusChip>
      )}
      {n.highRisk && (
        <StatusChip tone="clay" icon={<ShieldAlert className="size-4 shrink-0" />} testId="guest-notes-risk">
          {n.highRisk.text}
        </StatusChip>
      )}
      {n.prefs.map((p) => (
        <span key={p.label} className="rounded-md bg-card px-2 py-0.5" data-testid="guest-notes-pref">
          <b className="text-ink-3">{p.label}</b> {p.value}
        </span>
      ))}
      {n.remarks.map((r, i) => (
        <span key={i} className="rounded-md bg-card px-2 py-0.5">
          {r.tag && <b className="mr-1 text-clay">{r.tag}</b>}
          {r.note}
        </span>
      ))}
    </div>
  );
}

/**
 * 客人卡上的同行手牌（8.2.3 第 8 条）：点牌号打开那位；在店的同行小标签上有「移出」，确认一下就把那张牌移出同行组
 * （不用先打开那张牌）。移出的是同行关系，不动账单
 */
export function GroupMates({ visit, onSelectVisit, onChanged }: { visit: VisitDetail; onSelectVisit: (id: number) => void; onChanged: (v: VisitDetail) => void }) {
  const can = useCan();
  const toast = useToast();
  const [leaving, setLeaving] = useState<{ visitId: number; tagCode: string } | null>(null);
  const [busy, setBusy] = useState(false);
  if (!visit.group) return null;
  const canLeave = visit.status === 'open' && (can('frontdesk.operate') || can('frontdesk.checkout'));
  const confirm = async () => {
    if (!leaving) return;
    setBusy(true);
    try {
      const after = await api.post<VisitDetail>(`/api/frontdesk/visits/${leaving.visitId}/group`, { action: 'leave' });
      // 移出的是自己时就是这张牌的新详情；移出别人时重新取一次这张牌（同行组变了）
      onChanged(leaving.visitId === visit.id ? after : await api.get<VisitDetail>(`/api/frontdesk/visits/${visit.id}`));
      toast({ tone: 'success', title: `${leaving.tagCode} 已移出同行组` });
      setLeaving(null);
    } catch (e) {
      toast({ tone: 'error', title: '移出同行未成功', body: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <div className="scroll-thin mt-1.5 flex gap-1.5 overflow-x-auto pb-0.5" data-testid="group-mates">
        {visit.group.mates.map((m) => (
          <span
            key={m.visitId}
            className={cn(
              'flex shrink-0 items-center rounded-full border text-[12.5px] font-bold',
              m.visitId === visit.id ? 'border-pine bg-pine-tint text-pine' : 'border-line bg-card text-ink-2',
              m.status !== 'open' && 'opacity-50',
            )}
          >
            <button
              type="button"
              onClick={() => onSelectVisit(m.visitId)}
              disabled={m.visitId === visit.id}
              className="flex items-center gap-1.5 py-1 pr-1.5 pl-2.5"
              title={m.status !== 'open' ? VISIT_STATUS_LABELS[m.status] : undefined}
            >
              <span className="num">{m.tagCode}</span>
              <span className="text-[12px] opacity-70">{ZONE_LABELS[m.zone].short}</span>
              {m.status === 'open' ? <Money cents={m.amountCents} className="font-semibold text-ink-3" /> : <span className="text-[12px]">{VISIT_STATUS_LABELS[m.status]}</span>}
            </button>
            {canLeave && m.status === 'open' && (
              <button
                type="button"
                onClick={() => setLeaving({ visitId: m.visitId, tagCode: m.tagCode })}
                className="tap relative mr-1 flex h-6 items-center gap-0.5 rounded-full px-1.5 text-[12px] font-semibold text-ink-3 hover:bg-clay-soft hover:text-clay"
                aria-label={`把 ${m.tagCode} 移出同行组`}
                data-testid={`mate-leave-${m.tagCode}`}
              >
                <UserMinus className="size-3.5" /> 移出
              </button>
            )}
          </span>
        ))}
      </div>
      <Dialog
        open={!!leaving}
        onClose={busy ? () => {} : () => setLeaving(null)}
        title={leaving ? `把 ${leaving.tagCode} 移出同行组 ${visit.group.groupNo}？` : ''}
        description="移出以后这张牌单独结账；已挂的明细留在这张牌上，不会转走"
        footer={
          <>
            <Button variant="ghost" onClick={() => setLeaving(null)} disabled={busy}>
              取消
            </Button>
            <Button variant="danger" icon={<Link2 className="size-4" />} loading={busy} onClick={() => void confirm()} data-testid="mate-leave-confirm">
              移出同行
            </Button>
          </>
        }
      >
        <p className="text-[13px] text-ink-2">要再一起结账，在「更多 → 与在店客人同行」里重新绑上。</p>
      </Dialog>
    </>
  );
}

/** 高风险提醒列表（发卡台顶上）：在店超过设定小时数、挂账超过设定金额的客人 */
export function useRiskAlerts(enabled: boolean) {
  return useQuery({ queryKey: ['frontdesk', 'risk-alerts'], queryFn: () => api.get<RiskAlertRow[]>('/api/frontdesk/risk-alerts'), enabled });
}

export function RiskAlertsDialog({ open, onClose, onOpenVisit }: { open: boolean; onClose: () => void; onOpenVisit: (id: number) => void }) {
  const q = useRiskAlerts(open);
  const rules = useGuestRules();
  const now = Date.now();
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="高风险提醒"
      description={`在店超过 ${rules.risk.stayHours || '—'} 小时、或挂账超过 ${rules.risk.amountCents ? `¥${(rules.risk.amountCents / 100).toLocaleString('en-US')}` : '—'} 的客人（阈值与推送在后台「手牌与前台 → 客人与提醒」）`}
      width="max-w-2xl"
    >
      {q.isPending ? (
        <Skeleton className="h-24" />
      ) : q.isError && !q.data ? (
        <Notice tone="error" title={errorMessage(q.error)} />
      ) : q.data.length === 0 ? (
        <p className="py-6 text-center text-[13px] text-ink-3" data-testid="risk-alerts-empty">
          现在没有超过阈值的客人
        </p>
      ) : (
        <ul className="divide-y divide-line" data-testid="risk-alerts">
          {q.data.map((r) => (
            <li key={r.visitId}>
              <button
                type="button"
                onClick={() => {
                  onOpenVisit(r.visitId);
                  onClose();
                }}
                className="flex min-h-12 w-full flex-wrap items-center gap-x-3 gap-y-1 py-2 text-left hover:text-pine"
              >
                <span className="num text-[16px] font-bold">{r.tagCode}</span>
                <span className="text-[13px] text-ink-2">
                  {ZONE_LABELS[r.zone].short} · {r.guest}
                </span>
                <StatusChip tone="clay" icon={<ShieldAlert className="size-4 shrink-0" />}>
                  {r.risk.reasons.map((x) => RISK_REASON_LABELS[x]).join('、')}
                </StatusChip>
                <span className="ml-auto text-[12.5px] text-ink-3">
                  入场 {formatDateTime(r.checkedInAt)} · 在店 {stayText(r.checkedInAt, now)} · 挂账 <Money cents={r.amountCents} className="font-semibold text-ink" />
                  {r.notified.length > 0 && ' · 已推送'}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Dialog>
  );
}
