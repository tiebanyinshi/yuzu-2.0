// OA-12 后台「办公审批」（docs/OA.md 第 15 节）：
//   · 模板设置（oa.templates）：审批人 1–3 级、条件开关（只列适用于这个模板的）、抄送、说明、启用；带版本，别人先改过就重新载入。
//   · 全部审批单（oa.all）：按模板、状态、部门、日期、关键字筛，点开到「办公 → 审批」的详情（有这项权限的能看任何一张、能催办）；导出 Excel。
//   · 看板（oa.all）：某个月各模板的数量与平均审批时长，当前这一级等了超过 24 小时的单。

import { useState } from 'react';
import { Link } from 'react-router';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, Minus, Plus } from 'lucide-react';
import {
  APPROVAL_CONDITIONS,
  APPROVAL_OVERDUE_HOURS,
  APPROVAL_STATUS_LABELS,
  CONDITION_TEMPLATE,
  LEVEL_KIND_LABELS,
  type AdminApprovalItem,
  type AdminApprovalPage,
  type ApprovalBoard,
  type ApprovalCcSpec,
  type ApprovalCondition,
  type ApprovalLevelSpec,
  type ApprovalPerson,
  type ApprovalStatus,
  type ApprovalTemplate,
} from '@shared/oa-approval';
import { ORG_DEPARTMENTS } from '@shared/positions';
import { api, ApiError, errorMessage, UncertainError } from '../../lib/api';
import { useCan } from '../../lib/session';
import { useResetOnOpen } from '../../lib/useResetOnOpen';
import { downloadUrl, formatDateTime } from '../../lib/utils';
import { DataTable, type DataColumn } from '../../components/DataTable';
import { EmptyState } from '../../components/EmptyState';
import { LoadFailed } from '../../components/LoadFailed';
import { Dialog } from '../../components/Overlay';
import { useActiveSubTab } from '../../components/SubNav';
import { useToast } from '../../components/Toast';
import { Badge, Button, Card, ConfirmCheck, Field, Input, Select, Skeleton } from '../../components/ui';
import { AdminPage } from '../admin/AdminShell';

const TEMPLATES_KEY = ['oa', 'approval-templates-all'] as const;
const STATUS_TONE: Record<ApprovalStatus, 'yuzu' | 'pine' | 'clay' | 'neutral'> = { pending: 'yuzu', approved: 'pine', rejected: 'clay', withdrawn: 'neutral' };

export function ApprovalAdminSection() {
  const can = useCan();
  const tabs = [
    ...(can('oa.all') ? [{ key: 'all', label: <span data-testid="oaa-tab-all">全部审批单</span> }] : []),
    ...(can('oa.all') ? [{ key: 'board', label: <span data-testid="oaa-tab-board">看板</span> }] : []),
    ...(can('oa.templates') ? [{ key: 'templates', label: <span data-testid="oaa-tab-templates">模板设置</span> }] : []),
  ];
  return (
    <AdminPage
      section="oaApprovals"
      wide
      tabs={tabs}
      description="请假、加班、出差、报销、补卡与通用审批：查全部审批单、看本月数量与超时，设置各模板的审批人与抄送。员工在「办公 → 审批」里发起与审批。"
    >
      <Body fallback={tabs[0]?.key ?? 'all'} />
    </AdminPage>
  );
}

function Body({ fallback }: { fallback: string }) {
  const tab = useActiveSubTab() ?? fallback;
  if (tab === 'templates') return <TemplatesTab />;
  if (tab === 'board') return <BoardTab />;
  return <AllTab />;
}

// ───────────────────────── 模板设置 ─────────────────────────

const levelText = (l: ApprovalLevelSpec, people: ApprovalPerson[] | undefined) => (l.kind === 'staff' ? (people?.find((p) => p.id === l.staffId)?.name ?? `#${l.staffId}`) : LEVEL_KIND_LABELS[l.kind]);

function TemplatesTab() {
  const q = useQuery({ queryKey: TEMPLATES_KEY, queryFn: () => api.get<ApprovalTemplate[]>('/api/oa/approval/templates/all') });
  const people = useQuery({ queryKey: ['oa', 'approval-people'], queryFn: () => api.get<ApprovalPerson[]>('/api/oa/approval/people') });
  const [editing, setEditing] = useState<ApprovalTemplate | null>(null);
  if (q.isPending) return <Skeleton className="h-60" />;
  if (q.isError && !q.data) return <LoadFailed title="审批模板没有取回来" onRetry={() => q.refetch()} retrying={q.isFetching} />;
  const columns: DataColumn<ApprovalTemplate>[] = [
    { key: 'name', header: '模板', cell: (t) => <span className="font-bold">{t.name}</span> },
    { key: 'levels', header: '审批人', cell: (t) => t.levels.map((l) => levelText(l, people.data)).join(' → ') },
    {
      key: 'conds',
      header: '条件加签',
      className: 'max-md:hidden',
      cell: (t) =>
        (Object.keys(t.conditions) as ApprovalCondition[])
          .filter((k) => t.conditions[k])
          .map((k) => APPROVAL_CONDITIONS[k])
          .join('；') || '—',
    },
    { key: 'cc', header: '抄送', className: 'max-md:hidden', cell: (t) => (t.cc.length ? t.cc.map((c) => (c.kind === 'staff' ? levelText(c, people.data) : '本部门主管')).join('、') : '—') },
    { key: 'status', header: '状态', cell: (t) => (t.active ? <Badge tone="pine">启用</Badge> : <Badge tone="clay">已停用</Badge>) },
    {
      key: 'edit',
      header: '',
      align: 'right',
      cell: (t) => (
        <Button size="sm" variant="ghost" onClick={() => setEditing(t)} data-testid={`oaa-tpl-edit-${t.code}`}>
          编辑
        </Button>
      ),
    },
  ];
  return (
    <Card className="p-5" data-testid="oaa-templates">
      <p className="mb-3 text-[13px] text-ink-3">审批人在员工提交时定下来：改了只影响之后提交的单。表单字段不在这里改（要加模板或改字段请联系开发）。</p>
      <DataTable columns={columns} rows={q.data!} rowKey={(t) => t.id} empty="还没有模板" testId="oaa-template-list" />
      <TemplateDialog template={editing} people={people.data ?? []} onClose={() => setEditing(null)} />
    </Card>
  );
}

function PersonSelect({ value, people, onChange, testId }: { value: number; people: ApprovalPerson[]; onChange: (id: number) => void; testId?: string }) {
  return (
    <Select value={value || ''} onChange={(e) => onChange(Number(e.target.value))} fullWidth={false} className="min-w-40 flex-1" data-testid={testId}>
      <option value="">选一位员工</option>
      {people.map((p) => (
        <option key={p.id} value={p.id}>
          {p.name}
          {p.department ? `（${p.department}）` : ''}
        </option>
      ))}
    </Select>
  );
}

function TemplateDialog({ template, people, onClose }: { template: ApprovalTemplate | null; people: ApprovalPerson[]; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [description, setDescription] = useState('');
  const [levels, setLevels] = useState<ApprovalLevelSpec[]>([]);
  const [conditions, setConditions] = useState<Partial<Record<ApprovalCondition, boolean>>>({});
  const [cc, setCc] = useState<ApprovalCcSpec[]>([]);
  const [active, setActive] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useResetOnOpen(
    !!template,
    () => {
      setDescription(template?.description ?? '');
      setLevels(template?.levels ?? []);
      setConditions(template?.conditions ?? {});
      setCc(template?.cc ?? []);
      setActive(template?.active ?? true);
      setError(null);
    },
    [template],
  );
  const applicable = template ? (Object.keys(APPROVAL_CONDITIONS) as ApprovalCondition[]).filter((k) => CONDITION_TEMPLATE[k] === template.code) : [];
  const problem = levels.some((l) => l.kind === 'staff' && !l.staffId) || cc.some((c) => c.kind === 'staff' && !c.staffId) ? '指定人要选一位员工' : null;
  const save = async () => {
    if (!template || problem) return;
    setSaving(true);
    setError(null);
    try {
      await api.put(`/api/oa/approval/templates/${template.id}`, { description, levels, conditions, cc, active, version: template.version });
      toast({ tone: 'success', title: `模板「${template.name}」已保存` });
      onClose();
    } catch (e) {
      if (e instanceof UncertainError || (e instanceof ApiError && e.code === 'VERSION_CONFLICT')) {
        toast({ tone: 'info', title: errorMessage(e), body: '已重新载入，请核对后再改' });
        onClose();
      } else setError(errorMessage(e));
    } finally {
      setSaving(false);
      void qc.invalidateQueries({ queryKey: TEMPLATES_KEY });
    }
  };
  const levelKind = (l: ApprovalLevelSpec) => l.kind;
  return (
    <Dialog
      open={!!template}
      onClose={onClose}
      width="max-w-2xl"
      title={`审批模板 · ${template?.name ?? ''}`}
      description="本部门主管、上级部门主管按组织架构里的部门主管取；取到发起人自己的往上取"
      footer={
        <>
          {(error || problem) && <span className="mr-auto self-center text-[13px] text-clay">{error ?? problem}</span>}
          <Button variant="secondary" size="lg" onClick={onClose}>
            取消
          </Button>
          <Button variant="primary" size="lg" loading={saving} disabled={!!problem} onClick={() => void save()} data-testid="oaa-tpl-save">
            保存
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="说明">
          <Input value={description} maxLength={200} onChange={(e) => setDescription(e.target.value)} />
        </Field>
        <div>
          <p className="mb-2 text-[13px] font-bold text-ink-2">审批人（1–3 级，依次审批）</p>
          <div className="space-y-2">
            {levels.map((l, i) => (
              <div key={i} className="flex flex-wrap items-center gap-2" data-testid={`oaa-level-${i}`}>
                <span className="num w-12 text-[13px] text-ink-3">第 {i + 1} 级</span>
                <Select
                  value={levelKind(l)}
                  onChange={(e) =>
                    setLevels(levels.map((x, j) => (j === i ? (e.target.value === 'staff' ? { kind: 'staff', staffId: 0 } : { kind: e.target.value as 'dept_head' | 'parent_head' | 'hr_head' }) : x)))
                  }
                  fullWidth={false}
                  className="w-36"
                  data-testid={`oaa-level-${i}-kind`}
                >
                  <option value="dept_head">本部门主管</option>
                  <option value="parent_head">上级部门主管</option>
                  <option value="hr_head">人力行政部负责人</option>
                  <option value="staff">指定人</option>
                </Select>
                {l.kind === 'staff' && (
                  <PersonSelect value={l.staffId} people={people} onChange={(id) => setLevels(levels.map((x, j) => (j === i ? { kind: 'staff', staffId: id } : x)))} testId={`oaa-level-${i}-staff`} />
                )}
                {levels.length > 1 && <Button size="sm" variant="ghost" icon={<Minus className="size-4" />} aria-label="去掉这一级" onClick={() => setLevels(levels.filter((_, j) => j !== i))} />}
              </div>
            ))}
            {levels.length < 3 && (
              <Button size="sm" variant="secondary" icon={<Plus className="size-4" />} onClick={() => setLevels([...levels, { kind: 'parent_head' }])} data-testid="oaa-level-add">
                加一级
              </Button>
            )}
          </div>
        </div>
        {applicable.length > 0 && (
          <div className="space-y-1">
            <p className="text-[13px] font-bold text-ink-2">条件加签</p>
            {applicable.map((k) => (
              <ConfirmCheck key={k} checked={!!conditions[k]} onChange={(on) => setConditions({ ...conditions, [k]: on })}>
                {APPROVAL_CONDITIONS[k]}
              </ConfirmCheck>
            ))}
          </div>
        )}
        <div>
          <p className="mb-2 text-[13px] font-bold text-ink-2">抄送（提交时通知，能看全过程）</p>
          <div className="space-y-2">
            {cc.map((c, i) => (
              <div key={i} className="flex flex-wrap items-center gap-2">
                <Select
                  value={c.kind}
                  onChange={(e) => setCc(cc.map((x, j) => (j === i ? (e.target.value === 'staff' ? { kind: 'staff', staffId: 0 } : { kind: 'dept_head' }) : x)))}
                  fullWidth={false}
                  className="w-36"
                >
                  <option value="dept_head">本部门主管</option>
                  <option value="staff">指定人</option>
                </Select>
                {c.kind === 'staff' && <PersonSelect value={c.staffId} people={people} onChange={(id) => setCc(cc.map((x, j) => (j === i ? { kind: 'staff', staffId: id } : x)))} />}
                <Button size="sm" variant="ghost" icon={<Minus className="size-4" />} aria-label="去掉这个抄送" onClick={() => setCc(cc.filter((_, j) => j !== i))} />
              </div>
            ))}
            <Button size="sm" variant="secondary" icon={<Plus className="size-4" />} onClick={() => setCc([...cc, { kind: 'staff', staffId: 0 }])}>
              加抄送
            </Button>
          </div>
        </div>
        <ConfirmCheck checked={active} onChange={setActive}>
          启用（停用以后员工不能再发起，已提交的照常审批）
        </ConfirmCheck>
      </div>
    </Dialog>
  );
}

// ───────────────────────── 全部审批单 ─────────────────────────

function AllTab() {
  const templates = useQuery({ queryKey: TEMPLATES_KEY, queryFn: () => api.get<ApprovalTemplate[]>('/api/oa/approval/templates/all') });
  const [f, setF] = useState({ template: '', status: '', dept: '', from: '', to: '', q: '' });
  const query = Object.entries(f)
    .filter(([, v]) => v)
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join('&');
  const list = useInfiniteQuery({
    queryKey: ['oa', 'approvals-all', query],
    queryFn: ({ pageParam }) => api.get<AdminApprovalPage>(`/api/oa/approvals/all?${query}${pageParam ? `&before=${pageParam}` : ''}`),
    initialPageParam: 0,
    getNextPageParam: (last) => last.next ?? undefined,
  });
  const items = list.data?.pages.flatMap((p) => p.items) ?? [];
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const columns: DataColumn<AdminApprovalItem>[] = [
    { key: 'id', header: '编号', className: 'num', cell: (a) => a.id },
    {
      key: 'title',
      header: '标题',
      cell: (a) => (
        <Link to={`/oa/approvals/${a.id}`} className="font-semibold text-pine hover:underline" data-testid={`oaa-row-${a.id}`}>
          {a.title}
        </Link>
      ),
    },
    { key: 'who', header: '发起人', className: 'whitespace-nowrap', cell: (a) => `${a.applicantName}${a.department ? ` · ${a.department}` : ''}` },
    { key: 'status', header: '状态', cell: (a) => <Badge tone={STATUS_TONE[a.status]}>{APPROVAL_STATUS_LABELS[a.status]}</Badge> },
    { key: 'cur', header: '当前审批人', className: 'max-md:hidden', cell: (a) => a.currentApproverName ?? '—' },
    { key: 'at', header: '提交时间', className: 'num whitespace-nowrap max-md:hidden', cell: (a) => formatDateTime(a.submittedAt) },
  ];
  return (
    <Card className="p-5" data-testid="oaa-all">
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Select value={f.template} onChange={set('template')} fullWidth={false} className="w-32" aria-label="模板" data-testid="oaa-filter-template">
          <option value="">全部模板</option>
          {(templates.data ?? []).map((t) => (
            <option key={t.code} value={t.code}>
              {t.name}
            </option>
          ))}
        </Select>
        <Select value={f.status} onChange={set('status')} fullWidth={false} className="w-28" aria-label="状态">
          <option value="">全部状态</option>
          {(Object.keys(APPROVAL_STATUS_LABELS) as ApprovalStatus[]).map((k) => (
            <option key={k} value={k}>
              {APPROVAL_STATUS_LABELS[k]}
            </option>
          ))}
        </Select>
        <Select value={f.dept} onChange={set('dept')} fullWidth={false} className="w-36" aria-label="部门">
          <option value="">全部部门</option>
          {ORG_DEPARTMENTS.map((d) => (
            <option key={d.key} value={d.key}>
              {d.name}
            </option>
          ))}
        </Select>
        <Input type="date" value={f.from} onChange={set('from')} fullWidth={false} className="w-40" aria-label="提交日期从" />
        <Input type="date" value={f.to} onChange={set('to')} fullWidth={false} className="w-40" aria-label="提交日期到" />
        <Input value={f.q} onChange={set('q')} maxLength={40} placeholder="标题、发起人" fullWidth={false} className="w-40" data-testid="oaa-filter-q" />
        <Button variant="secondary" icon={<Download className="size-4" />} className="ml-auto" onClick={() => downloadUrl(`/api/oa/approvals/all.xlsx?${query}`)} data-testid="oaa-export">
          导出 Excel
        </Button>
      </div>
      {list.isPending ? (
        <Skeleton className="h-60" />
      ) : list.isError && !list.data ? (
        <LoadFailed title="审批单没有取回来" onRetry={() => list.refetch()} retrying={list.isFetching} />
      ) : items.length === 0 ? (
        <EmptyState title="没有符合条件的审批单" />
      ) : (
        <DataTable columns={columns} rows={items} rowKey={(a) => a.id} testId="oaa-all-grid" />
      )}
      {list.hasNextPage && (
        <div className="mt-3 flex justify-center">
          <Button variant="secondary" loading={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>
            再往前看
          </Button>
        </div>
      )}
    </Card>
  );
}

// ───────────────────────── 看板 ─────────────────────────

function BoardTab() {
  const [month, setMonth] = useState<string | null>(null);
  const q = useQuery({ queryKey: ['oa', 'approvals-board', month], queryFn: () => api.get<ApprovalBoard>(`/api/oa/approvals/board${month ? `?month=${month}` : ''}`) });
  const d = q.data;
  type Row = ApprovalBoard['templates'][number];
  const columns: DataColumn<Row>[] = [
    { key: 'name', header: '模板', cell: (r) => <span className="font-bold">{r.name}</span> },
    { key: 'submitted', header: '发起', align: 'right', className: 'num', cellTestId: (r) => `oaa-board-${r.code}-submitted`, cell: (r) => r.submitted },
    { key: 'approved', header: '通过', align: 'right', className: 'num', cell: (r) => r.approved },
    { key: 'rejected', header: '驳回', align: 'right', className: 'num', cell: (r) => r.rejected },
    { key: 'withdrawn', header: '撤销', align: 'right', className: 'num max-md:hidden', cell: (r) => r.withdrawn },
    { key: 'pending', header: '在途', align: 'right', className: 'num', cell: (r) => r.pending },
    { key: 'avg', header: '平均审批时长', align: 'right', className: 'num whitespace-nowrap', cell: (r) => (r.avgHours === null ? '—' : `${r.avgHours} 小时`) },
  ];
  return (
    <div className="space-y-4" data-testid="oaa-board">
      <Card className="p-5">
        <div className="mb-4 flex items-center gap-2">
          <Input type="month" value={month ?? d?.month ?? ''} onChange={(e) => e.target.value && setMonth(e.target.value)} fullWidth={false} className="w-44" aria-label="月份" />
          <p className="text-[12px] text-ink-3">发起按提交日期算；通过、驳回、撤销与平均时长按这个月结束的单算；在途是现在还在审批中的。</p>
        </div>
        {q.isPending ? (
          <Skeleton className="h-48" />
        ) : q.isError && !d ? (
          <LoadFailed title="看板没有取回来" onRetry={() => q.refetch()} retrying={q.isFetching} />
        ) : (
          <DataTable columns={columns} rows={d!.templates} rowKey={(r) => r.code} testId="oaa-board-grid" />
        )}
      </Card>
      {d && (
        <Card className="p-5">
          <p className="mb-3 text-[15px] font-bold text-ink">
            超时未处理<span className="ml-2 text-[13px] font-normal text-ink-3">当前这一级等了超过 {APPROVAL_OVERDUE_HOURS} 小时；点开可以催办</span>
          </p>
          {d.overdue.length === 0 ? (
            <EmptyState title="没有超时的" />
          ) : (
            <ul className="divide-y divide-line" data-testid="oaa-overdue">
              {d.overdue.map((o) => (
                <li key={o.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2.5 text-[14px]">
                  <Link to={`/oa/approvals/${o.id}`} className="font-semibold text-pine hover:underline">
                    {o.title}
                  </Link>
                  <span className="text-ink-3">
                    {o.applicantName} 发起 · 等 {o.approverName}
                  </span>
                  <Badge tone="clay">{o.waitedHours >= 48 ? `${Math.floor(o.waitedHours / 24)} 天` : `${o.waitedHours} 小时`}</Badge>
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}
    </div>
  );
}
