// OA-11 员工「办公 → 审批」（docs/OA.md 第 14 节；需求文档五（三））。
//   · 列表：待我审批、我发起的、抄送我的、我处理过的（状态筛选、往下翻）；「发起审批」到 ApprovalForm.tsx。
//   · 详情：表单内容、附件、审批链、时间线；审批人通过 / 驳回（必填原因）/ 转交，发起人撤销 / 催办 / 修改后重新提交，相关的人评论；抄送人打开记已读；等谁审批就能「找他聊」（OA-16）。
//   · 提交与处理带操作编号、先记在本机再发；没收到结果的在列表页上方查回、原样重提或作废（只看本人的）。

import { useEffect, useState } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { MessageCircle, Paperclip, Plus } from 'lucide-react';
import {
  APPROVAL_EVENT_LABELS,
  APPROVAL_STATUS_LABELS,
  derivedText,
  type ApprovalAction,
  type ApprovalBox,
  type ApprovalDetail,
  type ApprovalField,
  type ApprovalPage,
  type ApprovalPerson,
  type ApprovalSaved,
  type ApprovalStatus,
  type ApprovalSummary,
  type HalfDay,
} from '@shared/oa-approval';
import type { LeaveType } from '@shared/oa';
import { formatYuan } from '@shared/money';
import { api, errorMessage, UncertainError } from '../../lib/api';
import { ErpPendingStoreError, sendErpOp, useErpRecorded } from '../../lib/erpPending';
import { useSession } from '../../lib/session';
import { formatDateTime, uuid } from '../../lib/utils';
import { PageHeader } from '../../components/AppShell';
import { EmptyState } from '../../components/EmptyState';
import { ErpPendingPanel } from '../../components/ErpPendingPanel';
import { LoadFailed } from '../../components/LoadFailed';
import { Dialog } from '../../components/Overlay';
import { ReasonDialog } from '../../components/ReasonDialog';
import { useToast } from '../../components/Toast';
import { Badge, Button, Card, Field, Input, Segmented, Select, Skeleton } from '../../components/ui';
import { waited } from '../approvals/ApprovalProgress';
import { ApprovalTimeline, type TimelineLevel } from '../approvals/ApprovalTimeline';
import { NewApprovalPage, OptionsFailed } from './ApprovalForm';

const KEY = ['oa', 'approvals'] as const;
const STATUS_TONE: Record<ApprovalStatus, 'yuzu' | 'pine' | 'clay' | 'neutral'> = { pending: 'yuzu', approved: 'pine', rejected: 'clay', withdrawn: 'neutral' };

/** /oa/approvals 下面的几页 */
export function ApprovalPages() {
  const { pathname, search } = useLocation();
  const parts = pathname.replace(/\/$/, '').split('/').slice(3);
  const fromId = Number(new URLSearchParams(search).get('from')) || null;
  if (parts[0] === 'new') return <NewApprovalPage code={parts[1] ?? null} fromId={fromId} />;
  if (parts[0] && /^\d+$/.test(parts[0])) return <ApprovalDetailPage id={Number(parts[0])} />;
  return <ApprovalListPage />;
}

const mine = (staffId: number) => (op: { staffId?: number }) => op.staffId === staffId;

function ApprovalListPage() {
  const session = useSession();
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const box = (params.get('box') as ApprovalBox | null) ?? 'todo';
  const [status, setStatus] = useState('');
  const summary = useQuery({ queryKey: [...KEY, 'summary'], queryFn: () => api.get<ApprovalSummary>('/api/oa/approvals/summary') });
  const list = useInfiniteQuery({
    queryKey: [...KEY, 'list', box, status],
    queryFn: ({ pageParam }) => api.get<ApprovalPage>(`/api/oa/approvals?box=${box}${status ? `&status=${status}` : ''}${pageParam ? `&before=${pageParam}` : ''}`),
    initialPageParam: 0,
    getNextPageParam: (last) => last.next ?? undefined,
  });
  const items = list.data?.pages.flatMap((p) => p.items) ?? [];
  const s = summary.data;
  return (
    <>
      <div className="max-md:hidden">
        <PageHeader dateMode="calendar" title="审批" subtitle="请假、加班、出差、报销、补卡和其他事项" />
      </div>
      <div className="mx-auto w-full max-w-3xl space-y-3 p-3 md:p-7">
        <div className="flex items-center justify-between gap-2">
          <h1 className="text-[17px] font-bold text-ink md:hidden">审批</h1>
          <Link
            to="/oa/approvals/new"
            className="tap relative inline-flex h-9 shrink-0 items-center gap-1 rounded-md bg-pine px-3 text-[14px] font-semibold text-white md:ml-auto"
            data-testid="oa-approval-new"
          >
            <Plus className="size-4" />
            发起审批
          </Link>
        </div>
        <ErpPendingPanel types={['oa_approval_submit', 'oa_approval_act']} filter={mine(session.staff.id)} className="space-y-2" onFound={() => void qc.invalidateQueries({ queryKey: KEY })} />
        <div className="flex flex-wrap items-center gap-2">
          <div className="scroll-thin max-w-full overflow-x-auto">
            <Segmented<ApprovalBox>
              value={box}
              onChange={(b) => setParams({ box: b }, { replace: true })}
              ariaLabel="审批列表"
              options={[
                { value: 'todo', label: <span data-testid="oa-box-todo">待我审批{s?.todo ? ` ${s.todo}` : ''}</span> },
                { value: 'mine', label: <span data-testid="oa-box-mine">我发起的</span> },
                { value: 'cc', label: <span data-testid="oa-box-cc">抄送我的{s?.ccUnread ? ` ${s.ccUnread}` : ''}</span> },
                { value: 'done', label: <span data-testid="oa-box-done">我处理过的</span> },
              ]}
            />
          </div>
          <Select value={status} onChange={(e) => setStatus(e.target.value)} fullWidth={false} className="w-full sm:ml-auto sm:w-32" aria-label="状态">
            <option value="">全部状态</option>
            {(Object.keys(APPROVAL_STATUS_LABELS) as ApprovalStatus[]).map((k) => (
              <option key={k} value={k}>
                {APPROVAL_STATUS_LABELS[k]}
              </option>
            ))}
          </Select>
        </div>
        {list.isPending ? (
          <Skeleton className="h-60" />
        ) : list.isError && !list.data ? (
          <LoadFailed title="审批单没有取回来" onRetry={() => list.refetch()} retrying={list.isFetching} />
        ) : items.length === 0 ? (
          <EmptyState title={box === 'todo' ? '没有待你审批的' : '还没有'} />
        ) : (
          <ul className="space-y-2" data-testid="oa-approval-list">
            {items.map((a) => (
              <li key={a.id}>
                <Link to={`/oa/approvals/${a.id}`} className="tap relative block rounded-lg border border-line bg-card p-3.5 shadow-card hover:border-line-strong" data-testid={`oa-approval-${a.id}`}>
                  <div className="flex items-center gap-2">
                    {box === 'cc' && !a.ccReadAt && <span className="size-2 rounded-full bg-clay" aria-label="未读" />}
                    <span className="min-w-0 flex-1 truncate font-semibold text-ink">{a.title}</span>
                    <Badge tone={STATUS_TONE[a.status]}>{APPROVAL_STATUS_LABELS[a.status]}</Badge>
                  </div>
                  <p className="mt-1 text-[12.5px] text-ink-3">
                    {a.templateName} · {a.applicantName} · {formatDateTime(a.submittedAt)}
                    {a.currentApproverName ? ` · 等 ${a.currentApproverName} 审批` : ''}
                    {a.revision > 1 ? ` · 第 ${a.revision} 版` : ''}
                  </p>
                </Link>
              </li>
            ))}
          </ul>
        )}
        {list.hasNextPage && (
          <div className="flex justify-center">
            <Button variant="secondary" loading={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>
              再往前看
            </Button>
          </div>
        )}
      </div>
    </>
  );
}

/** 表单里一项的显示 */
function valueText(f: ApprovalField, v: unknown, leaveTypes: LeaveType[] | undefined): string {
  if (v === null || v === undefined || v === '' || (Array.isArray(v) && !v.length)) return '—';
  switch (f.type) {
    case 'money':
      return formatYuan(v as number);
    case 'halfday': {
      const h = v as HalfDay;
      return `${h.date} ${h.half === 'am' ? '上午' : '下午'}`;
    }
    case 'datetime':
      return String(v).replace('T', ' ');
    case 'leave_type':
      return leaveTypes?.find((t) => t.id === v)?.name ?? `#${String(v)}`;
    case 'ref':
      return `#${String(v)}`;
    case 'shift':
      return '见标题';
    default:
      return String(v);
  }
}

/**
 * 办公审批的节点 → 公共审批链时间线（features/approvals/ApprovalTimeline）的一级一块：同一级转交过的合成一块，
 * 写「谁 → 谁」；通过记「同意」、驳回记「退回」（docs/CONVENTIONS.md 第 3 节，Codex 审查 128b492）
 */
function timelineLevels(d: ApprovalDetail): TimelineLevel[] {
  const bySeq = new Map<number, ApprovalDetail['steps']>();
  for (const s of d.steps) bySeq.set(s.seq, [...(bySeq.get(s.seq) ?? []), s]);
  return [...bySeq.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([seq, rows]) => {
      const last = rows.at(-1)!;
      const state: TimelineLevel['state'] = rows.some((r) => r.status === 'rejected')
        ? 'returned'
        : rows.some((r) => r.status === 'approved')
          ? 'done'
          : rows.some((r) => r.status === 'pending')
            ? 'current'
            : 'pending';
      const acted = rows.filter((r) => r.status === 'approved' || r.status === 'rejected');
      return {
        level: seq,
        label: rows.map((r) => r.approverName).join(' → '),
        mode: `${last.label}${rows.length > 1 ? ' · 转交过' : ''}${last.status === 'cancelled' ? ' · 不用处理' : ''}`,
        state,
        actions: acted.map((r) => ({
          id: r.id,
          level: seq,
          action: r.status === 'approved' ? ('approve' as const) : ('return' as const),
          actorId: r.approverId,
          actorName: r.approverName,
          onBehalfOf: null,
          onBehalfOfName: null,
          comment: r.comment,
          batch: false,
          createdAt: r.actedAt ?? d.submittedAt,
        })),
      };
    });
}

/** 当前这一级从什么时候开始等：最近一次推进审批的事件（提交、通过、转交），评论与催办不算（Codex 审查 1715764） */
const stepStartedAt = (d: ApprovalDetail) => d.events.filter((e) => e.kind === 'submit' || e.kind === 'approve' || e.kind === 'transfer').at(-1)?.createdAt ?? d.submittedAt;

function ApprovalDetailPage({ id }: { id: number }) {
  const session = useSession();
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const q = useQuery({ queryKey: [...KEY, 'detail', id], queryFn: () => api.get<ApprovalDetail>(`/api/oa/approvals/${id}`) });
  const leaveTypes = useQuery({ queryKey: ['oa', 'leave-types'], queryFn: () => api.get<LeaveType[]>('/api/oa/leave/types'), enabled: q.data?.templateCode === 'leave' });
  const [busy, setBusy] = useState(false);
  const [comment, setComment] = useState('');
  const [rejecting, setRejecting] = useState(false);
  const [transferring, setTransferring] = useState(false);
  const d = q.data;
  const ccUnread = !!d?.cc.some((c) => c.staffId === session.staff.id && !c.readAt);
  // 抄送人打开就记已读
  useEffect(() => {
    if (ccUnread) void api.post(`/api/oa/approvals/${id}/read`, {}).then(() => qc.invalidateQueries({ queryKey: KEY }));
  }, [ccUnread, id, qc]);

  // 这张单上本人还有结果待确认的处理：先查回、原样重提或作废，确认前不发新的（Codex 审查 03e17aa）
  const unsettled = useErpRecorded(['oa_approval_act']).filter((op) => op.staffId === session.staff.id && op.url === `/api/oa/approvals/${id}/act`);
  const act = async (action: ApprovalAction, extra: { comment?: string; toStaffId?: number } = {}, ok = '已处理') => {
    if (!d) return false;
    if (unsettled.length > 0) {
      toast({ tone: 'error', title: '这张单上一次的操作结果待确认', body: '请先在上方查回、按原内容重新提交或作废，确认前不要再操作。' });
      return false;
    }
    const clientKey = uuid();
    const needsStep = action === 'approve' || action === 'reject' || action === 'transfer';
    setBusy(true);
    try {
      const r = await sendErpOp<ApprovalSaved>({
        key: clientKey,
        type: 'oa_approval_act',
        url: `/api/oa/approvals/${id}/act`,
        body: { clientKey, action, ...(needsStep ? { stepId: d.pendingStepId } : {}), ...extra },
        summary: `${APPROVAL_EVENT_LABELS[action]} · ${d.title}`,
        staffName: session.staff.displayName,
        staffId: session.staff.id,
      });
      qc.setQueryData([...KEY, 'detail', id], r.approval);
      toast({ tone: 'success', title: ok });
      return true;
    } catch (e) {
      if (e instanceof UncertainError) toast({ tone: 'info', title: '结果待确认', body: '已记在本机：请到「审批」页上方查回、按原内容重新提交或作废。' });
      else if (e instanceof ErpPendingStoreError) toast({ tone: 'error', title: e.message });
      else toast({ tone: 'error', title: errorMessage(e) });
      return false;
    } finally {
      setBusy(false);
      void qc.invalidateQueries({ queryKey: KEY });
    }
  };

  return (
    <>
      <div className="max-md:hidden">
        <PageHeader dateMode="calendar" title={d?.title ?? '审批单'} subtitle={d ? `${d.templateName} · ${d.applicantName} · ${formatDateTime(d.submittedAt)}` : undefined} />
      </div>
      <div className="mx-auto w-full max-w-3xl space-y-3 p-3 md:space-y-4 md:p-7">
        <div className="md:hidden">
          <h1 className="break-words text-[17px] font-bold text-ink">{d?.title ?? '审批单'}</h1>
          {d && (
            <p className="mt-0.5 text-[12.5px] text-ink-3">
              {d.templateName} · {d.applicantName} · {formatDateTime(d.submittedAt)}
            </p>
          )}
        </div>
        <ErpPendingPanel
          types={['oa_approval_act']}
          filter={(op) => op.staffId === session.staff.id && op.url === `/api/oa/approvals/${id}/act`}
          className="space-y-2"
          onFound={() => void qc.invalidateQueries({ queryKey: KEY })}
        />
        {q.isPending ? (
          <Skeleton className="h-72" />
        ) : q.isError && !d ? (
          <LoadFailed title="审批单没有取回来" onRetry={() => q.refetch()} retrying={q.isFetching} />
        ) : (
          <>
            <Card className="space-y-3 p-3.5 md:p-5" data-testid="oa-approval-detail">
              <div className="flex flex-wrap items-center gap-2">
                <span data-testid="oa-approval-status">
                  <Badge tone={STATUS_TONE[d!.status]}>{APPROVAL_STATUS_LABELS[d!.status]}</Badge>
                </span>
                {d!.revision > 1 && <span className="text-[13px] text-ink-3">第 {d!.revision} 版</span>}
                {d!.previousId && (
                  <Link to={`/oa/approvals/${d!.previousId}`} className="tap relative text-[13px] text-pine">
                    上一版
                  </Link>
                )}
                {d!.nextId && (
                  <Link to={`/oa/approvals/${d!.nextId}`} className="tap relative text-[13px] text-pine">
                    重新提交的那一版
                  </Link>
                )}
              </div>
              <dl className="grid gap-x-4 gap-y-2 text-[14px] sm:grid-cols-[8em_1fr]">
                {d!.fields
                  .filter((f) => f.type !== 'attachments')
                  .map((f) => (
                    <div key={f.key} className="contents">
                      <dt className="text-ink-3">{f.label}</dt>
                      <dd className="min-w-0 break-words whitespace-pre-wrap text-ink">{valueText(f, d!.form[f.key], leaveTypes.data)}</dd>
                    </div>
                  ))}
                {derivedText(d!.templateCode, d!.form) && (
                  <div className="contents">
                    <dt className="text-ink-3">时长</dt>
                    <dd className="font-semibold text-ink" data-testid="oa-approval-derived">
                      {derivedText(d!.templateCode, d!.form)}
                    </dd>
                  </div>
                )}
              </dl>
              {d!.attachments.length > 0 && (
                <div className="flex flex-wrap gap-2" data-testid="oa-approval-attachments">
                  {d!.attachments.map((a) => (
                    <a
                      key={a.id}
                      href={a.url}
                      target="_blank"
                      rel="noreferrer"
                      className="tap relative flex max-w-full items-center gap-1.5 rounded-md border border-line px-2.5 py-1.5 text-[13px] text-ink-2 hover:border-line-strong"
                    >
                      {a.thumbUrl ? <img src={a.thumbUrl} alt="" className="size-8 shrink-0 rounded object-cover" /> : <Paperclip className="size-4 shrink-0" />}
                      <span className="max-w-40 truncate">{a.fileName}</span>
                    </a>
                  ))}
                </div>
              )}
            </Card>

            <Card className="p-3.5 md:p-5">
              <p className="mb-2 text-[13px] font-bold text-ink-2">审批链</p>
              <div data-testid="oa-approval-steps">
                {d!.steps.length === 0 ? (
                  <p className="text-[13px] text-ink-3">没有要审批的人（发起人就是最上级），直接通过</p>
                ) : (
                  <ApprovalTimeline levels={timelineLevels(d!)} waitedText={waited(stepStartedAt(d!))} testIdPrefix="oa-approval-level" />
                )}
              </div>
              {d!.cc.length > 0 && <p className="mt-3 text-[12.5px] text-ink-3">抄送：{d!.cc.map((c) => `${c.name}${c.readAt ? '（已读）' : ''}`).join('、')}</p>}
            </Card>

            <Actions
              d={d!}
              busy={busy}
              act={act}
              onReject={() => setRejecting(true)}
              onTransfer={() => setTransferring(true)}
              onResubmit={() => navigate(`/oa/approvals/new/${d!.templateCode}?from=${d!.id}`)}
            />

            <Card className="p-3.5 md:p-5">
              <p className="mb-2 text-[13px] font-bold text-ink-2">时间线</p>
              <ul className="space-y-2" data-testid="oa-approval-events">
                {d!.events.map((e) => (
                  <li key={e.id} className="break-words text-[13.5px]">
                    <span className="num mr-2 text-[12px] text-ink-3">{formatDateTime(e.createdAt)}</span>
                    <span className="font-semibold text-ink">{e.actorName}</span> {APPROVAL_EVENT_LABELS[e.kind]}
                    {e.toName ? ` 给 ${e.toName}` : ''}
                    {e.comment && <span className="text-ink-2">：{e.comment}</span>}
                  </li>
                ))}
              </ul>
              <div className="mt-3 flex gap-2">
                <Input
                  value={comment}
                  maxLength={500}
                  onChange={(e) => setComment(e.target.value)}
                  placeholder="写评论（相关的人都看得到）"
                  className="min-w-0 flex-1"
                  data-testid="oa-approval-comment"
                />
                <Button
                  variant="secondary"
                  className="shrink-0"
                  disabled={busy || !comment.trim()}
                  onClick={() => void act('comment', { comment: comment.trim() }, '已评论').then((ok) => ok && setComment(''))}
                  data-testid="oa-approval-comment-send"
                >
                  发送
                </Button>
              </div>
            </Card>
          </>
        )}
      </div>
      <ReasonDialog
        open={rejecting}
        title="驳回"
        description="整单退回发起人，发起人可以修改后重新提交"
        confirmLabel="驳回"
        danger
        busy={busy}
        testId="oa-approval-reject"
        onClose={() => setRejecting(false)}
        onConfirm={(reason) => void act('reject', { comment: reason }, '已驳回').then((ok) => ok && setRejecting(false))}
      />
      <TransferDialog
        open={transferring}
        busy={busy}
        exclude={[session.staff.id, d?.applicantId ?? 0]}
        onClose={() => setTransferring(false)}
        onConfirm={(toStaffId, note) => void act('transfer', { toStaffId, comment: note }, '已转交').then((ok) => ok && setTransferring(false))}
      />
    </>
  );
}

function Actions({
  d,
  busy,
  act,
  onReject,
  onTransfer,
  onResubmit,
}: {
  d: ApprovalDetail;
  busy: boolean;
  act: (a: ApprovalAction, extra?: { comment?: string }, ok?: string) => Promise<boolean>;
  onReject: () => void;
  onTransfer: () => void;
  onResubmit: () => void;
}) {
  const [opinion, setOpinion] = useState('');
  const me = useSession().staff.id;
  const navigate = useNavigate();
  const toast = useToast();
  const [chatting, setChatting] = useState(0);
  const { can } = d;
  // OA-16：等谁审批就能直接找他聊（催办）；审批人是自己的不显示
  const waiting = [...new Map(d.steps.filter((x) => x.status === 'pending' && x.approverId !== me).map((x) => [x.approverId, x.approverName])).entries()];
  const chat = async (staffId: number) => {
    setChatting(staffId);
    try {
      void navigate(`/oa/im/${(await api.post<{ id: number }>('/api/oa/im/direct', { staffId })).id}`);
    } catch (e) {
      toast({ tone: 'error', title: '没有打开聊天', body: errorMessage(e) });
    } finally {
      setChatting(0);
    }
  };
  if (!can.approve && !can.withdraw && !can.urge && !can.resubmit && !waiting.length) return null;
  return (
    <Card className="space-y-3 p-3.5 md:p-5" data-testid="oa-approval-actions">
      {can.approve && (
        <>
          <Field label="审批意见（可不填）">
            <Input value={opinion} maxLength={500} onChange={(e) => setOpinion(e.target.value)} data-testid="oa-approval-opinion" />
          </Field>
          <div className="grid grid-cols-3 gap-2 sm:flex sm:flex-wrap">
            <Button variant="primary" size="lg" loading={busy} onClick={() => void act('approve', { comment: opinion.trim() }, '已通过')} data-testid="oa-approval-approve">
              通过
            </Button>
            <Button variant="danger" size="lg" disabled={busy} onClick={onReject} data-testid="oa-approval-reject">
              驳回
            </Button>
            <Button variant="secondary" size="lg" disabled={busy} onClick={onTransfer} data-testid="oa-approval-transfer">
              转交
            </Button>
          </div>
        </>
      )}
      {(can.urge || waiting.length > 0 || can.withdraw || can.resubmit) && (
        <div className="flex flex-wrap gap-2">
          {can.urge && (
            <Button variant="secondary" disabled={busy} onClick={() => void act('urge', {}, '已催办')} data-testid="oa-approval-urge">
              催办
            </Button>
          )}
          {waiting.map(([id, name]) => (
            <Button key={id} variant="ghost" icon={<MessageCircle className="size-4" />} loading={chatting === id} onClick={() => void chat(id)} data-testid={`oa-approval-chat-${id}`}>
              找{name}聊
            </Button>
          ))}
          {can.withdraw && (
            <Button variant="ghost" disabled={busy} onClick={() => void act('withdraw', {}, '已撤销')} data-testid="oa-approval-withdraw">
              撤销
            </Button>
          )}
          {can.resubmit && (
            <Button variant="primary" onClick={onResubmit} data-testid="oa-approval-resubmit">
              修改后重新提交
            </Button>
          )}
        </div>
      )}
    </Card>
  );
}

function TransferDialog({ open, busy, exclude, onClose, onConfirm }: { open: boolean; busy: boolean; exclude: number[]; onClose: () => void; onConfirm: (toStaffId: number, note: string) => void }) {
  const people = useQuery({ queryKey: ['oa', 'approval-people'], queryFn: () => api.get<ApprovalPerson[]>('/api/oa/approval/people'), enabled: open });
  const [to, setTo] = useState('');
  const [note, setNote] = useState('');
  useEffect(() => {
    if (open) {
      setTo('');
      setNote('');
    }
  }, [open]);
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="转交给别人审批"
      description="这一级交给另一位在职员工，转交会记在审批链上"
      footer={
        <>
          <Button variant="secondary" size="lg" onClick={onClose}>
            取消
          </Button>
          <Button variant="primary" size="lg" loading={busy} disabled={!to} onClick={() => onConfirm(Number(to), note.trim())} data-testid="oa-transfer-confirm">
            转交
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {people.isError && !people.data ? (
          <OptionsFailed label="在职员工" onRetry={() => people.refetch()} retrying={people.isFetching} />
        ) : (
          <Field label="交给谁" hint={people.isPending ? '正在取在职员工…' : undefined}>
            <Select value={to} onChange={(e) => setTo(e.target.value)} data-testid="oa-transfer-to">
              <option value="">请选择</option>
              {(people.data ?? [])
                .filter((p) => !exclude.includes(p.id))
                .map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                    {p.department ? `（${p.department}）` : ''}
                  </option>
                ))}
            </Select>
          </Field>
        )}
        <Field label="说明（可不填）">
          <Input value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} />
        </Field>
      </div>
    </Dialog>
  );
}
