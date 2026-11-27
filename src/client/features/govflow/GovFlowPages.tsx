// 业财法审批（店主 2026-11-26，docs/APPROVAL_V4.md）：WCP →「业财法审批」。
//   /oa/gov            待我审批 / 我发起 / 知会我 / 全部（店主、内控、董事长）/ 微信特批 / 角色映射（店主）
//   /oa/gov/:id        事项详情：审批链每一级（会签、并行分审显示还等谁）、同意 / 退回 / 驳回、知会、特批、执行
// 手机、电脑同一页面、同一套接口。

import { useState, type ReactNode } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, ChevronLeft, CornerUpLeft, FilePlus2, Plus, ShieldAlert, X } from 'lucide-react';
import {
  GF_DOC_TYPE_LABELS,
  GF_FILE_PURPOSE_LABELS,
  GF_FLAG_LABELS,
  GF_FLAGS,
  GF_ROLE_LABELS,
  GF_STATUS_LABELS,
  type GfDocCard,
  type GfDocDetail,
  type GfFilePurpose,
  type GfFlag,
  type GfMeta,
  type GfSpecialView,
  type GfStatus,
} from '@shared/govflow';
import { api, errorMessage } from '../../lib/api';
import { cn, formatDateTime, uuid } from '../../lib/utils';
import { PageHeader } from '../../components/AppShell';
import { EmptyState } from '../../components/EmptyState';
import { LoadFailed } from '../../components/LoadFailed';
import { Money } from '../../components/Money';
import { Dialog } from '../../components/Overlay';
import { useToast } from '../../components/Toast';
import { Badge, Button, Card, Field, Input, Segmented, Select, Skeleton, Textarea } from '../../components/ui';
import { yuanToCents } from './money';
import { SkuBatchReviewPanel, SupplierDetailPage, SupplierList } from './SupplyPages';
import { PettyActions, PettyPanel } from './PettyPages';
import { ContractPanel, ContractsPanel } from './ContractPages';
import { PaymentPanel, PaymentsPanel } from './PaymentPages';
import { ExpensePanel } from './ExpensePages';
import { HrBatchPanel, HrPanel } from './HrPages';
import { RolesPanel } from './RolesPanel';
import { RangeExport } from '../../components/RangeExport';

type Box = 'todo' | 'mine' | 'cc' | 'all' | 'specials' | 'suppliers' | 'petty' | 'contracts' | 'payments' | 'expense' | 'hr' | 'roles';
const STATUS_TONE: Record<GfStatus, 'neutral' | 'pine' | 'moss' | 'yuzu' | 'ember' | 'clay' | 'lake' | 'ink'> = {
  draft: 'neutral',
  reviewing: 'lake',
  to_execute: 'yuzu',
  executing: 'yuzu',
  completed: 'moss',
  archived: 'ink',
  returned: 'ember',
  rejected: 'clay',
  withdrawn: 'neutral',
  special_backfill: 'clay',
  backfill_pending: 'ember',
};

const useMeta = () => useQuery({ queryKey: ['gf', 'meta'], queryFn: () => api.get<GfMeta>('/api/gf/meta') });

export function GovFlowPages() {
  const { pathname } = useLocation();
  const sup = pathname.match(/^\/oa\/gov\/suppliers\/(\d+)/);
  if (sup) return <SupplierDetailPage key={sup[1]} id={Number(sup[1])} />;
  const m = pathname.match(/^\/oa\/gov\/(\d+)/);
  return m ? <DocDetailPage key={m[1]} id={Number(m[1])} /> : <GovHome />;
}

function GovHome() {
  const [params, setParams] = useSearchParams();
  const meta = useMeta();
  const box = (params.get('box') as Box | null) ?? 'todo';
  const [creating, setCreating] = useState(false);
  const [registering, setRegistering] = useState(false);
  const seesAll = !!meta.data && (meta.data.canManageRoles || meta.data.myRoles.includes('internal_control') || meta.data.myRoles.includes('chairman'));
  const tabs: { value: Box; label: ReactNode }[] = [
    { value: 'todo', label: '待我审批' },
    { value: 'mine', label: '我发起的' },
    { value: 'cc', label: '知会我的' },
    ...(seesAll ? [{ value: 'all' as const, label: '全部' }] : []),
    { value: 'specials', label: '微信特批' },
    { value: 'suppliers', label: '供应商库' },
    { value: 'petty', label: '零星采购' },
    { value: 'contracts', label: '合同' },
    { value: 'payments', label: '付款' },
    { value: 'expense', label: '报销出差用印' },
    { value: 'hr', label: 'HR 付款与分摊' },
    ...(meta.data?.canManageRoles ? [{ value: 'roles' as const, label: '角色映射' }] : []),
  ];
  return (
    <>
      <div className="max-md:hidden">
        <PageHeader dateMode="calendar" title="业财法审批" subtitle="正常事项快、重大风险有人负责：审批链、会签、知会、回避与微信特批补登" />
      </div>
      <div className="mx-auto w-full max-w-4xl space-y-3 p-3 md:p-7" data-testid="gf-home">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="mr-auto text-[17px] font-bold text-ink md:hidden">业财法审批</h1>
          <div className="max-w-full overflow-x-auto">
            <Segmented<Box> size="sm" value={box} onChange={(v) => setParams({ box: v }, { replace: true })} ariaLabel="业财法分区" options={tabs} />
          </div>
          <div className="ml-auto flex gap-2">
            <Button size="sm" variant="secondary" icon={<ShieldAlert className="size-4" />} onClick={() => setRegistering(true)} data-testid="gf-special-new">
              登记微信特批
            </Button>
            <Button size="sm" icon={<FilePlus2 className="size-4" />} onClick={() => setCreating(true)} data-testid="gf-new">
              发起事项
            </Button>
          </div>
        </div>
        {box === 'roles' ? (
          <RolesPanel />
        ) : box === 'specials' ? (
          <SpecialsPanel />
        ) : box === 'suppliers' ? (
          <SupplierList />
        ) : box === 'hr' ? (
          meta.data ? (
            <HrPanel meta={meta.data} />
          ) : null
        ) : box === 'expense' ? (
          meta.data ? (
            <ExpensePanel meta={meta.data} />
          ) : null
        ) : box === 'payments' ? (
          meta.data ? (
            <PaymentsPanel meta={meta.data} />
          ) : null
        ) : box === 'contracts' ? (
          meta.data ? (
            <ContractsPanel meta={meta.data} />
          ) : null
        ) : box === 'petty' ? (
          meta.data ? (
            <PettyPanel meta={meta.data} />
          ) : null
        ) : (
          <>
            {box === 'all' && <RangeExport href="/api/gf/export.xlsx" fileName="业财法事项.xlsx" testId="gf-export" />}
            <DocList box={box} />
          </>
        )}
      </div>
      {creating && meta.data && <NewDocDialog meta={meta.data} onClose={() => setCreating(false)} />}
      {registering && meta.data && <SpecialDialog meta={meta.data} docId={null} onClose={() => setRegistering(false)} />}
    </>
  );
}

function DocList({ box }: { box: 'todo' | 'mine' | 'cc' | 'all' }) {
  const q = useQuery({ queryKey: ['gf', 'docs', box], queryFn: () => api.get<GfDocCard[]>(`/api/gf/docs?box=${box}`) });
  if (q.isPending) return <Skeleton className="h-48" />;
  if (q.isError && !q.data) return <LoadFailed title="事项没有取回来" onRetry={() => q.refetch()} retrying={q.isFetching} />;
  if (!q.data.length) return <EmptyState art="calm" testId="gf-empty" title={box === 'todo' ? '没有等你审批的事项' : '还没有事项'} />;
  return (
    <Card className="divide-y divide-line p-0" data-testid={`gf-list-${box}`}>
      {q.data.map((d) => (
        <Link key={d.id} to={`/oa/gov/${d.id}`} data-testid={`gf-item-${d.id}`} className="tap relative flex items-start gap-3 px-3.5 py-3 hover:bg-paper md:px-4">
          <span className="min-w-0 flex-1 space-y-1">
            <span className="flex flex-wrap items-center gap-1.5">
              <Badge tone={STATUS_TONE[d.status]}>{GF_STATUS_LABELS[d.status]}</Badge>
              {d.overdue && <Badge tone="clay">逾期</Badge>}
              <span className="min-w-0 text-[15px] font-semibold break-words text-ink">{d.title}</span>
            </span>
            <span className="block text-[13px] text-ink-3">
              {GF_DOC_TYPE_LABELS[d.docType]} · <span className="num">{d.bizNo}</span> · {d.departmentName ?? '—'} · {d.createdByName} · {formatDateTime(d.createdAt)}
            </span>
            {d.currentLabel && <span className="block text-[13px] text-pine">{d.currentLabel}</span>}
          </span>
          {d.amountCents !== null && <Money cents={d.amountCents} className="shrink-0 text-[15px] font-bold" />}
        </Link>
      ))}
    </Card>
  );
}

function NewDocDialog({ meta, onClose }: { meta: GfMeta; onClose: () => void }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const toast = useToast();
  const [clientKey] = useState(() => uuid());
  const [title, setTitle] = useState('');
  const [note, setNote] = useState('');
  const [deptId, setDeptId] = useState<number | ''>('');
  const [entityId, setEntityId] = useState<number | ''>('');
  const [amount, setAmount] = useState('');
  const [flags, setFlags] = useState<GfFlag[]>([]);
  const [contractLike, setContractLike] = useState(false);
  const [performerId, setPerformerId] = useState<number | ''>('');
  const cents = amount.trim() ? yuanToCents(amount) : null;
  const m = useMutation({
    mutationFn: () =>
      api.post<GfDocDetail>('/api/gf/docs', {
        clientKey,
        docType: 'general',
        title,
        note,
        departmentId: deptId || undefined,
        entityId: entityId || null,
        amountCents: cents,
        flags,
        performerId: performerId || null,
        payload: { contractLike },
      }),
    onSuccess: (d) => {
      qc.invalidateQueries({ queryKey: ['gf'] });
      toast({ tone: 'success', title: '已提交', body: d.bizNo });
      navigate(`/oa/gov/${d.id}`);
    },
    onError: (e) => toast({ tone: 'error', title: '没有提交', body: errorMessage(e) }),
  });
  const amountBad = amount.trim() !== '' && cents === null;
  return (
    <Dialog
      open
      onClose={onClose}
      title="发起业财法事项"
      description="审批金额按不含税口径；系统按金额与风险排审批链，合同类自动加内部履约执行人，招标 / 单一来源 / 新供应商等自动加内控"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button loading={m.isPending} disabled={!title.trim() || !deptId || amountBad} onClick={() => m.mutate()} data-testid="gf-new-submit">
            提交审批
          </Button>
        </>
      }
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="事项名称" className="sm:col-span-2">
          <Input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={100} data-testid="gf-new-title" />
        </Field>
        <Field label="费用承担部门">
          <Select value={deptId} onChange={(e) => setDeptId(e.target.value ? Number(e.target.value) : '')} data-testid="gf-new-dept">
            <option value="">请选择</option>
            {meta.departments.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
                {d.headName ? `（负责人 ${d.headName}）` : '（没设负责人）'}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="经营主体">
          <Select value={entityId} onChange={(e) => setEntityId(e.target.value ? Number(e.target.value) : '')}>
            <option value="">不限</option>
            {meta.entities.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="金额（元，不含税）" error={amountBad ? '请填数字，最多两位小数' : null}>
          <Input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="无金额的不填" data-testid="gf-new-amount" />
        </Field>
        <Field label="合同类">
          <label className="flex h-10 items-center gap-2 text-[14px] text-ink">
            <input type="checkbox" checked={contractLike} onChange={(e) => setContractLike(e.target.checked)} data-testid="gf-new-contract" />
            是合同类（要选内部履约执行人）
          </label>
        </Field>
        {contractLike && (
          <Field label="内部履约执行人" className="sm:col-span-2">
            <Select value={performerId} onChange={(e) => setPerformerId(e.target.value ? Number(e.target.value) : '')} data-testid="gf-new-performer">
              <option value="">请选择</option>
              {meta.staff.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </Select>
          </Field>
        )}
        <Field label="风险与情形" className="sm:col-span-2">
          <div className="flex flex-wrap gap-1.5">
            {GF_FLAGS.map((f) => {
              const on = flags.includes(f);
              return (
                <button
                  key={f}
                  type="button"
                  onClick={() => setFlags(on ? flags.filter((x) => x !== f) : [...flags, f])}
                  data-testid={`gf-flag-${f}`}
                  className={cn('tap relative h-8 rounded-full border px-3 text-[13px] font-semibold', on ? 'border-pine bg-pine text-paper' : 'border-line text-ink-2')}
                >
                  {GF_FLAG_LABELS[f]}
                </button>
              );
            })}
          </div>
        </Field>
        <Field label="说明" className="sm:col-span-2">
          <Textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} />
        </Field>
      </div>
    </Dialog>
  );
}

function DocDetailPage({ id }: { id: number }) {
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const [special, setSpecial] = useState(false);
  const meta = useMeta();
  const q = useQuery({ queryKey: ['gf', 'doc', id], queryFn: () => api.get<GfDocDetail>(`/api/gf/docs/${id}`) });
  const done = (d: GfDocDetail) => {
    qc.setQueryData(['gf', 'doc', id], d);
    qc.invalidateQueries({ queryKey: ['gf', 'docs'] });
  };
  const onError = (e: unknown) => toast({ tone: 'error', title: '没有办成', body: errorMessage(e) });
  const [comment, setComment] = useState('');
  const [decisions, setDecisions] = useState<{ skuId: number; decision: 'approve' | 'reject' }[] | null>(null);
  const act = useMutation({
    mutationFn: (action: 'approve' | 'return' | 'reject') =>
      api.post<GfDocDetail>(`/api/gf/docs/${id}/act`, { clientKey: uuid(), action, level: q.data!.currentLevel, comment, extra: decisions ? { decisions } : undefined }),
    onSuccess: (d) => {
      setComment('');
      done(d);
      toast({ tone: 'success', title: '已提交审批意见' });
    },
    onError,
  });
  const step = useMutation({
    mutationFn: (s: { url: string; body: Record<string, unknown> }) => api.post<GfDocDetail>(s.url, s.body),
    onSuccess: done,
    onError,
  });
  if (q.isPending) return <Skeleton className="m-3 h-64" />;
  if (q.isError && !q.data) return <LoadFailed title="事项没有取回来" onRetry={() => q.refetch()} retrying={q.isFetching} />;
  const d = q.data;
  return (
    <div className="mx-auto w-full max-w-3xl space-y-3 p-3 md:p-7" data-testid="gf-detail">
      <Link to="/oa/gov" className="flex items-center gap-1 text-[14px] font-semibold text-pine max-md:hidden">
        <ChevronLeft className="size-4" />
        业财法审批
      </Link>
      <Card className="space-y-2 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={STATUS_TONE[d.status]}>
            <span data-testid="gf-status">{GF_STATUS_LABELS[d.status]}</span>
          </Badge>
          {d.overdue && <Badge tone="clay">逾期</Badge>}
          <h1 className="min-w-0 text-[18px] font-bold break-words text-ink">{d.title}</h1>
          {d.amountCents !== null && <Money cents={d.amountCents} className="ml-auto text-[18px] font-bold" />}
        </div>
        <p className="text-[13px] text-ink-3">
          <span className="num">{d.bizNo}</span> · {d.departmentName ?? '—'}
          {d.entityName ? ` · ${d.entityName}` : ''} · 发起 {d.createdByName} {formatDateTime(d.createdAt)}
          {d.performerName ? ` · 履约执行人 ${d.performerName}` : ''}
        </p>
        {d.flags.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {d.flags.map((f) => (
              <Badge key={f} tone="ember">
                {GF_FLAG_LABELS[f]}
              </Badge>
            ))}
          </div>
        )}
        {d.note && <p className="text-[14px] whitespace-pre-wrap text-ink-2">{d.note}</p>}
      </Card>

      {d.docType === 'sku_batch' && <SkuBatchReviewPanel doc={d} onDecisions={setDecisions} />}
      {d.docType === 'petty_purchase' && <PettyActions doc={d} onDone={() => q.refetch()} />}
      {d.docType === 'hr_batch' && <HrBatchPanel doc={d} meta={meta.data} onDone={() => q.refetch()} />}
      {d.docType === 'payment' && <PaymentPanel doc={d} meta={meta.data} onDone={() => q.refetch()} />}
      {d.docType === 'contract' && <ContractPanel doc={d} meta={meta.data} onDone={(next) => (next ? navigate(`/oa/gov/${next}`) : q.refetch())} />}
      {typeof d.payload.supplierId === 'number' && (
        <Link to={`/oa/gov/suppliers/${d.payload.supplierId}`} className="block text-[14px] font-semibold text-pine">
          查看供应商档案
        </Link>
      )}
      <Card className="p-4" data-testid="gf-chain">
        <h2 className="mb-2 text-[15px] font-bold text-ink">审批链{d.round > 1 ? `（第 ${d.round} 轮）` : ''}</h2>
        {d.notes.length > 0 && (
          <ul className="mb-2 space-y-1 rounded-md bg-paper-2 px-3 py-2 text-[13px] text-ink-2" data-testid="gf-notes">
            {d.notes.map((n) => (
              <li key={n}>· {n}</li>
            ))}
          </ul>
        )}
        {d.nodes.length === 0 ? (
          <p className="text-[13px] text-ink-3">还没提交审批</p>
        ) : (
          <ol className="space-y-2">
            {d.nodes.map((n) => (
              <li key={n.level} className="flex gap-3" data-testid={`gf-node-${n.level}`}>
                <span
                  className={cn(
                    'num mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full text-[12px] font-bold',
                    n.state === 'done' || n.state === 'skipped'
                      ? 'bg-moss text-paper'
                      : n.state === 'current'
                        ? 'bg-pine text-paper'
                        : n.state === 'waiting'
                          ? 'bg-paper-2 text-ink-3'
                          : 'bg-clay text-paper',
                  )}
                >
                  {n.level}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-[14px] font-semibold text-ink">
                    {n.label}
                    {n.stage === 'final' && <span className="ml-1.5 text-[12px] font-normal text-ink-3">终审</span>}
                    {n.stage === 'special' && <span className="ml-1.5 text-[12px] font-normal text-ink-3">特批</span>}
                  </p>
                  {n.state === 'current' && (
                    <p className="text-[13px] text-pine">
                      等 {n.waiting.join('、')}
                      {n.eligibleNames.length ? `（${n.eligibleNames.join('、')}）` : '（没有可以审批的人，请店主配角色）'}
                    </p>
                  )}
                  {d.actions
                    .filter((a) => a.level === n.level)
                    .map((a) => (
                      <p key={a.id} className="text-[13px] text-ink-2">
                        {a.action === 'approve' ? '同意' : a.action === 'skip' ? '自动跳过' : a.action === 'return' ? '退回' : '驳回'} · {a.seat} {a.actorName}
                        {a.comment ? `：${a.comment}` : ''} <span className="text-ink-3">{formatDateTime(a.createdAt)}</span>
                      </p>
                    ))}
                </div>
              </li>
            ))}
          </ol>
        )}
        {d.mySeats.length > 0 && (
          <div className="mt-3 space-y-2 border-t border-line pt-3" data-testid="gf-act">
            <p className="text-[13px] text-ink-2">你以「{d.mySeats.join('、')}」审这一级</p>
            <Textarea rows={2} value={comment} onChange={(e) => setComment(e.target.value)} placeholder="意见（退回、驳回要写原因）" maxLength={500} data-testid="gf-comment" />
            <div className="flex flex-wrap gap-2">
              <Button icon={<Check className="size-4" />} loading={act.isPending && act.variables === 'approve'} onClick={() => act.mutate('approve')} data-testid="gf-approve">
                同意
              </Button>
              <Button variant="secondary" icon={<CornerUpLeft className="size-4" />} disabled={comment.trim().length < 2} onClick={() => act.mutate('return')} data-testid="gf-return">
                退回修改
              </Button>
              <Button variant="danger" icon={<X className="size-4" />} disabled={comment.trim().length < 2} onClick={() => act.mutate('reject')} data-testid="gf-reject">
                驳回（不通过）
              </Button>
            </div>
          </div>
        )}
        <div className="mt-3 flex flex-wrap gap-2">
          {d.canSubmit && (
            <Button size="sm" onClick={() => step.mutate({ url: `/api/gf/docs/${id}/submit`, body: { version: d.version } })} data-testid="gf-submit">
              {d.round > 0 ? '改好了，重新提交' : '提交审批'}
            </Button>
          )}
          {d.canExecute && d.status === 'to_execute' && (
            <Button size="sm" onClick={() => step.mutate({ url: `/api/gf/docs/${id}/execute`, body: { version: d.version, step: 'start' } })} data-testid="gf-exec-start">
              开始执行
            </Button>
          )}
          {d.canExecute && (d.status === 'to_execute' || d.status === 'executing') && (
            <Button size="sm" variant="secondary" onClick={() => step.mutate({ url: `/api/gf/docs/${id}/execute`, body: { version: d.version, step: 'complete' } })} data-testid="gf-exec-complete">
              执行完成
            </Button>
          )}
          {d.canExecute && d.status === 'completed' && (
            <Button size="sm" variant="secondary" onClick={() => step.mutate({ url: `/api/gf/docs/${id}/execute`, body: { version: d.version, step: 'archive' } })} data-testid="gf-exec-archive">
              归档
            </Button>
          )}
          {d.canWithdraw && (
            <Button size="sm" variant="ghost" onClick={() => step.mutate({ url: `/api/gf/docs/${id}/withdraw`, body: { version: d.version } })} data-testid="gf-withdraw">
              撤回
            </Button>
          )}
          <Button size="sm" variant="ghost" icon={<ShieldAlert className="size-4" />} onClick={() => setSpecial(true)} data-testid="gf-detail-special">
            登记微信特批
          </Button>
        </div>
      </Card>

      {d.cc.length > 0 && (
        <Card className="p-4" data-testid="gf-cc">
          <h2 className="mb-2 text-[15px] font-bold text-ink">知会（只是通知，不用同意）</h2>
          <ul className="space-y-1 text-[13px] text-ink-2">
            {d.cc.map((c) => (
              <li key={c.staffName + c.role}>
                {GF_ROLE_LABELS[c.role]} {c.staffName} · {c.urgent ? '即时提醒' : '进日报'}
                {c.notifiedAt ? ` · 已通知 ${formatDateTime(c.notifiedAt)}` : ' · 待发日报'}
              </li>
            ))}
          </ul>
        </Card>
      )}
      {d.specials.length > 0 && (
        <Card className="p-4">
          <h2 className="mb-2 text-[15px] font-bold text-ink">微信特批</h2>
          <SpecialRows rows={d.specials} />
        </Card>
      )}
      {special && meta.data && <SpecialDialog meta={meta.data} docId={id} onClose={() => setSpecial(false)} />}
    </div>
  );
}

// ───────────────────────── 微信特批 ─────────────────────────

function SpecialsPanel() {
  const q = useQuery({ queryKey: ['gf', 'specials'], queryFn: () => api.get<GfSpecialView[]>('/api/gf/specials') });
  if (q.isPending) return <Skeleton className="h-40" />;
  if (q.isError && !q.data) return <LoadFailed title="特批没有取回来" onRetry={() => q.refetch()} retrying={q.isFetching} />;
  if (!q.data.length) return <EmptyState art="calm" testId="gf-specials-empty" title="没有微信特批" />;
  return (
    <Card className="p-4">
      <SpecialRows rows={q.data} />
    </Card>
  );
}

function SpecialRows({ rows }: { rows: GfSpecialView[] }) {
  const [filling, setFilling] = useState<GfSpecialView | null>(null);
  return (
    <>
      <ul className="divide-y divide-line" data-testid="gf-specials">
        {rows.map((s) => (
          <li key={s.id} className="space-y-1 py-2.5">
            <p className="flex flex-wrap items-center gap-1.5">
              <span className="num text-[13px] font-bold text-ink">{s.specialNo}</span>
              <span className="text-[14px] font-semibold text-ink">{s.title}</span>
              <Money cents={s.amountCents} className="text-[14px]" />
              {s.backfilledAt ? <Badge tone="moss">已补登</Badge> : <Badge tone={s.overdue ? 'clay' : 'ember'}>{s.overdue ? '补登逾期' : `待补登（${s.dueOn} 前）`}</Badge>}
              {s.screenshotReusedIn.length > 0 && <Badge tone="yuzu">截图也用在 {s.screenshotReusedIn.join('、')}</Badge>}
            </p>
            <p className="text-[13px] text-ink-3">
              确认人 {s.confirmerNames.join('、')} · {formatDateTime(s.confirmedAt)} · 登记 {s.registeredByName}
              {s.docBizNo ? (
                <>
                  {' '}
                  · 关联{' '}
                  <Link className="text-pine" to={`/oa/gov/${s.docId}`}>
                    {s.docBizNo}
                  </Link>
                </>
              ) : null}
            </p>
            <p className="text-[13px] text-ink-2">原因：{s.reason}</p>
            {s.files.length > 0 && (
              <p className="flex flex-wrap gap-2 text-[13px]">
                {s.files.map((f) => (
                  <a key={f.id} href={`/api/gf/files/${f.id}`} className="text-pine underline">
                    {GF_FILE_PURPOSE_LABELS[f.purpose]}：{f.fileName}
                  </a>
                ))}
              </p>
            )}
            {!s.backfilledAt && (
              <Button size="sm" variant="secondary" onClick={() => setFilling(s)} data-testid={`gf-backfill-${s.id}`}>
                补登需求说明与 OK 截图
              </Button>
            )}
          </li>
        ))}
      </ul>
      {filling && <BackfillDialog special={filling} onClose={() => setFilling(null)} />}
    </>
  );
}

function SpecialDialog({ meta, docId, onClose }: { meta: GfMeta; docId: number | null; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [clientKey] = useState(() => uuid());
  const [title, setTitle] = useState('');
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [a, setA] = useState<number | ''>('');
  const [b, setB] = useState<number | ''>('');
  const [payeeAccount, setPayeeAccount] = useState('');
  const [at, setAt] = useState(() => new Date(Date.now() - new Date().getTimezoneOffset() * 60_000).toISOString().slice(0, 16));
  // 微信 OK 截图（8.2.11，WB6）：登记时必传
  const [shot, setShot] = useState<File | null>(null);
  const cents = yuanToCents(amount);
  const m = useMutation({
    mutationFn: async () =>
      api.post<GfSpecialView>(
        '/api/gf/specials',
        {
          clientKey,
          docId,
          title,
          amountCents: cents,
          reason,
          confirmerIds: [a, b],
          confirmedAt: new Date(at).toISOString(),
          payeeAccount: payeeAccount || null,
          okScreenshot: { fileName: shot!.name.slice(0, 120), mime: shot!.type, base64: await readBase64(shot!) },
        },
        { timeoutMs: 120_000 },
      ),
    onSuccess: (s) => {
      qc.invalidateQueries({ queryKey: ['gf'] });
      toast({ tone: 'success', title: '已登记微信特批', body: `${s.specialNo}，请在 ${s.dueOn} 前补登需求说明` });
      if (s.screenshotReusedIn.length) toast({ tone: 'info', title: '这张 OK 截图也用在了别的特批上', body: `${s.screenshotReusedIn.join('、')}；请核对是不是同一次确认` });
      onClose();
    },
    onError: (e) => toast({ tone: 'error', title: '没有登记', body: errorMessage(e) }),
  });
  const people = (v: number | '', set: (n: number | '') => void, label: string) => (
    <Field label={label}>
      <Select value={v} onChange={(e) => set(e.target.value ? Number(e.target.value) : '')}>
        <option value="">请选择</option>
        {meta.staff.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name}
          </option>
        ))}
      </Select>
    </Field>
  );
  return (
    <Dialog
      open
      onClose={onClose}
      title="登记微信特批"
      description="紧急事项两人微信确认后在这里登记，同时上传微信里的 OK 截图；1 个工作日内补登需求说明；关联原事项的不重复审批"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button
            loading={m.isPending}
            disabled={!title.trim() || cents === null || reason.trim().length < 2 || !a || !b || a === b || !shot}
            onClick={() => m.mutate()}
            data-testid="gf-special-submit"
          >
            登记
          </Button>
        </>
      }
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="特批事项" className="sm:col-span-2">
          <Input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={100} />
        </Field>
        <Field label="特批金额（元）">
          <Input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </Field>
        <Field label="微信确认时间">
          <Input type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} />
        </Field>
        {people(a, setA, '确认人一')}
        {people(b, setB, '确认人二')}
        <Field label="收款账号（紧急付款用，换账户要重新特批）">
          <Input className="num" value={payeeAccount} onChange={(e) => setPayeeAccount(e.target.value.replace(/\D/g, ''))} />
        </Field>
        <Field label="紧急原因" className="sm:col-span-2">
          <Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} />
        </Field>
        <Field label="微信 OK 截图（必传，图片 5 MB 以内）" className="sm:col-span-2">
          <label className="tap relative flex h-10 cursor-pointer items-center gap-2 rounded-md border border-dashed border-line px-3 text-[14px] text-ink-2">
            <Plus className="size-4" />
            {shot ? shot.name : '选截图'}
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp"
              className="sr-only"
              data-testid="gf-special-shot"
              onChange={(e) => {
                setShot(e.target.files?.[0] ?? null);
                e.target.value = '';
              }}
            />
          </label>
        </Field>
      </div>
    </Dialog>
  );
}

const readBase64 = (file: File) =>
  new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ''));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });

function BackfillDialog({ special, onClose }: { special: GfSpecialView; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [files, setFiles] = useState<{ purpose: GfFilePurpose; file: File }[]>([]);
  const [note, setNote] = useState('');
  const m = useMutation({
    mutationFn: async () =>
      api.post(
        `/api/gf/specials/${special.id}/backfill`,
        { note, files: await Promise.all(files.map(async (f) => ({ purpose: f.purpose, fileName: f.file.name.slice(0, 120), mime: f.file.type, base64: await readBase64(f.file) }))) },
        { timeoutMs: 120_000 },
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['gf'] });
      toast({ tone: 'success', title: '已补登' });
      onClose();
    },
    onError: (e) => toast({ tone: 'error', title: '没有补登', body: errorMessage(e) }),
  });
  const has = (p: GfFilePurpose) => files.some((f) => f.purpose === p);
  const needShot = !special.files.some((f) => f.purpose === 'ok_screenshot');
  const picker = (purpose: GfFilePurpose) => (
    <label className="tap relative flex h-10 cursor-pointer items-center gap-2 rounded-md border border-dashed border-line px-3 text-[14px] text-ink-2">
      <Plus className="size-4" />加{GF_FILE_PURPOSE_LABELS[purpose]}（图片或 PDF，5 MB 以内）
      <input
        type="file"
        accept="image/png,image/jpeg,image/webp,application/pdf"
        className="sr-only"
        data-testid={`gf-file-${purpose}`}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) setFiles((list) => [...list, { purpose, file: f }]);
          e.target.value = '';
        }}
      />
    </label>
  );
  return (
    <Dialog
      open
      onClose={onClose}
      title={`补登 ${special.specialNo}`}
      description={needShot ? '需求说明与 OK 截图各至少一份（这笔登记时没有截图）；补登不重复审批' : '需求说明至少一份（OK 截图登记时已传）；补登不重复审批'}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button loading={m.isPending} disabled={!has('need') || (needShot && !has('ok_screenshot'))} onClick={() => m.mutate()} data-testid="gf-backfill-submit">
            补登
          </Button>
        </>
      }
    >
      <div className="space-y-2">
        {picker('need')}
        {needShot && picker('ok_screenshot')}
        {files.length > 0 && (
          <ul className="space-y-1 text-[13px] text-ink-2">
            {files.map((f, i) => (
              <li key={`${f.file.name}-${i}`} className="flex items-center gap-2">
                {GF_FILE_PURPOSE_LABELS[f.purpose]}：{f.file.name}
                <button type="button" className="text-clay" onClick={() => setFiles(files.filter((_, j) => j !== i))}>
                  去掉
                </button>
              </li>
            ))}
          </ul>
        )}
        <Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="说明（选填）" maxLength={500} />
      </div>
    </Dialog>
  );
}
