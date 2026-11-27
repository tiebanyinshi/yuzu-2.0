// 汤崎学堂 · 后台（「WCP 设置 → 人员与行政 → 学堂」，/admin/academy，权限 academy.manage；docs/ACADEMY.md 第 8 节）：
//   课程（点开编辑课时与题库）、学习地图、指派（看每个人的进度）、内置课程包（导入 17 门课件）、学习数据（员工概况、证书）。

import { useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, Download, Plus, X } from 'lucide-react';
import {
  ACADEMY_CATEGORIES,
  ACADEMY_CATEGORY_LABELS,
  ACADEMY_COVERS,
  ACADEMY_PACK_STATE_LABELS,
  type AcademyAdminCourse,
  type AcademyAdminPath,
  type AcademyAssignmentStat,
  type AcademyCategory,
  type AcademyCertificate,
  type AcademyCourseSummary,
  type AcademyCover,
  type AcademyLearnerRow,
  type AcademyPackCourse,
  type AcademyPackImportResult,
  type AcademyPackStatus,
  type AcademyPersonProgress,
  type AcademyStatus,
} from '@shared/academy';
import { ORG_DEPARTMENTS, POSITIONS } from '@shared/positions';
import { api, errorMessage } from '../../lib/api';
import { cn, uuid } from '../../lib/utils';
import { DataTable, type DataColumn } from '../../components/DataTable';
import { Dialog } from '../../components/Overlay';
import { SubPane, type SubTab } from '../../components/SubNav';
import { useToast } from '../../components/Toast';
import { Badge, Button, Card, Field, Input, Notice, SectionTitle, Select, Textarea } from '../../components/ui';
import { AdminPage } from '../admin/AdminShell';
import { adminKeys, CourseEditor, statusBadge } from './CourseEditor';
import { academyKeys, COVER_CLASS, sendAcademyOp } from './data';
import { AcademyOpsPanel, PendingLock, useOpPending } from './parts';

const TABS: readonly SubTab[] = [
  { key: 'courses', label: '课程' },
  { key: 'paths', label: '学习地图' },
  { key: 'assignments', label: '指派' },
  { key: 'packs', label: '内置课程包' },
  { key: 'data', label: '学习数据' },
];

export function AcademyAdmin() {
  return (
    <AdminPage section="academy" wide tabs={TABS} description="课程按「学习地图 → 课程 → 课时 → 题库」组织；指派给部门 / 岗位 / 个人就成了员工的必修，新员工自动带上。员工在「WCP → 学堂」学。">
      <AcademyOpsPanel />
      <SubPane tab="courses">
        <CoursesTab />
      </SubPane>
      <SubPane tab="paths" lazy>
        <PathsTab />
      </SubPane>
      <SubPane tab="assignments" lazy>
        <AssignmentsTab />
      </SubPane>
      <SubPane tab="packs" lazy>
        <PacksTab />
      </SubPane>
      <SubPane tab="data" lazy>
        <DataTab />
      </SubPane>
    </AdminPage>
  );
}

const useAdminCourses = () => useQuery({ queryKey: adminKeys.courses, queryFn: () => api.get<AcademyCourseSummary[]>('/api/admin/academy/courses') });

function CoursesTab() {
  const [params, setParams] = useSearchParams();
  const editing = Number(params.get('course')) || null;
  const courses = useAdminCourses();
  const [creating, setCreating] = useState(false);
  const open = (id: number | null) => setParams(id ? { course: String(id) } : {}, { replace: false });
  if (editing) return <CourseEditor id={editing} onBack={() => open(null)} />;
  const columns: DataColumn<AcademyCourseSummary>[] = [
    {
      key: 'title',
      header: '课程',
      cell: (c) => (
        <span className="flex items-center gap-2">
          <span className={cn('size-3 shrink-0 rounded-full', COVER_CLASS[c.cover].solid)} aria-hidden />
          <span className="font-semibold">{c.title}</span>
          {c.code && <span className="text-[12px] text-ink-4">{c.code}</span>}
        </span>
      ),
    },
    { key: 'category', header: '分类', cell: (c) => ACADEMY_CATEGORY_LABELS[c.category] },
    { key: 'status', header: '状态', cell: (c) => statusBadge(c.status) },
    { key: 'lessons', header: '课时', numeric: true, cell: (c) => c.lessonCount },
    { key: 'minutes', header: '分钟', numeric: true, cell: (c) => c.minutes },
    { key: 'rating', header: '评分', numeric: true, cell: (c) => (c.rating ? `${c.rating.avg}（${c.rating.count}）` : '—') },
  ];
  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setCreating(true)} data-testid="academy-new-course">
          新建课程
        </Button>
      </div>
      <DataTable
        onPage
        columns={columns}
        rows={courses.data}
        rowKey={(c) => c.id}
        onRowClick={(c) => open(c.id)}
        rowTestId={(c) => `academy-admin-course-${c.id}`}
        failed={courses.isError && !courses.data}
        onRetry={() => void courses.refetch()}
        empty="还没有课程"
        emptyDescription="新建一门，或到「内置课程包」导入 17 门现成的课"
      />
      {creating && <NewCourseDialog onClose={() => setCreating(false)} onMade={(id) => open(id)} />}
    </div>
  );
}

function NewCourseDialog({ onClose, onMade }: { onClose: () => void; onMade: (id: number) => void }) {
  const [title, setTitle] = useState('');
  const [category, setCategory] = useState<AcademyCategory>('must_know');
  const [summary, setSummary] = useState('');
  const [busy, setBusy] = useState(false);
  const key = useRef(uuid());
  const pending = useOpPending(key.current);
  const toast = useToast();
  const qc = useQueryClient();
  return (
    <Dialog
      open
      onClose={onClose}
      title="新建课程"
      footer={
        <Button
          variant="primary"
          loading={busy}
          disabled={!title.trim()}
          data-testid="academy-new-course-save"
          onClick={async () => {
            setBusy(true);
            try {
              const r = await sendAcademyOp<AcademyAdminCourse>({
                key: key.current,
                method: 'POST',
                url: '/api/admin/academy/courses',
                body: { clientKey: key.current, title: title.trim(), category, summary },
                summary: `新建课程「${title.trim()}」`,
              });
              await qc.invalidateQueries({ queryKey: adminKeys.courses });
              onClose();
              onMade(r.course.id);
            } catch (e) {
              toast({ tone: 'error', title: '没建成', body: errorMessage(e) });
            } finally {
              setBusy(false);
            }
          }}
        >
          {pending ? '按原内容重新提交' : '新建'}
        </Button>
      }
    >
      <PendingLock pending={pending} className="space-y-3">
        <Field label="课程名称">
          <Input value={title} maxLength={60} onChange={(e) => setTitle(e.target.value)} data-testid="academy-new-course-title" />
        </Field>
        <Field label="分类">
          <Select value={category} onChange={(e) => setCategory(e.target.value as AcademyCategory)}>
            {ACADEMY_CATEGORIES.map((k) => (
              <option key={k} value={k}>
                {ACADEMY_CATEGORY_LABELS[k]}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="简介">
          <Textarea rows={2} maxLength={300} value={summary} onChange={(e) => setSummary(e.target.value)} />
        </Field>
      </PendingLock>
    </Dialog>
  );
}

// ───────────────────────── 学习地图 ─────────────────────────

function PathDialog({ path, onClose }: { path: AcademyAdminPath | null; onClose: () => void }) {
  const courses = useAdminCourses();
  const [f, setF] = useState({
    title: path?.title ?? '',
    summary: path?.summary ?? '',
    cover: (path?.cover ?? 'pine') as AcademyCover,
    sort: path?.sort ?? 100,
    credits: path?.credits ?? 5,
    validMonths: path?.validMonths ?? null,
    courseIds: path?.courseIds ?? [],
    status: (path?.status ?? 'draft') as AcademyStatus,
  });
  const [busy, setBusy] = useState(false);
  const key = useRef(uuid());
  const pending = useOpPending(key.current) && !path;
  const toast = useToast();
  const qc = useQueryClient();
  const byId = new Map((courses.data ?? []).map((c) => [c.id, c]));
  const move = (i: number, j: number) => {
    const ids = [...f.courseIds];
    [ids[i], ids[j]] = [ids[j]!, ids[i]!];
    setF({ ...f, courseIds: ids });
  };
  const save = async () => {
    setBusy(true);
    const body = { title: f.title, summary: f.summary, cover: f.cover, sort: f.sort, credits: f.credits, validMonths: f.validMonths, courseIds: f.courseIds };
    try {
      if (path)
        await sendAcademyOp({
          key: uuid(),
          method: 'PUT',
          url: `/api/admin/academy/paths/${path.id}`,
          body: { ...body, status: f.status, version: path.version },
          summary: `保存学习地图「${f.title}」`,
        });
      else await sendAcademyOp({ key: key.current, method: 'POST', url: '/api/admin/academy/paths', body: { ...body, clientKey: key.current }, summary: `新建学习地图「${f.title}」` });
      await Promise.all([qc.invalidateQueries({ queryKey: adminKeys.paths }), qc.invalidateQueries({ queryKey: academyKeys.all })]);
      onClose();
    } catch (e) {
      toast({ tone: 'error', title: '没保存上', body: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onClose={onClose}
      width="max-w-2xl"
      title={path ? `学习地图「${path.title}」` : '新建学习地图'}
      footer={
        <Button variant="primary" loading={busy} disabled={!f.title.trim()} onClick={() => void save()} data-testid="academy-path-save">
          {pending ? '按原内容重新提交' : '保存'}
        </Button>
      }
    >
      <PendingLock pending={pending} className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="地图名称">
            <Input value={f.title} maxLength={40} onChange={(e) => setF({ ...f, title: e.target.value })} data-testid="academy-path-title" />
          </Field>
          {path && (
            <Field label="状态">
              <Select value={f.status} onChange={(e) => setF({ ...f, status: e.target.value as AcademyStatus })}>
                <option value="draft">草稿</option>
                <option value="published">上架</option>
                <option value="archived">下架</option>
              </Select>
            </Field>
          )}
          <Field label="学完另给学分">
            <Input type="number" min={0} max={50} value={f.credits} onChange={(e) => setF({ ...f, credits: Number(e.target.value) || 0 })} />
          </Field>
          <Field label="证书有效几个月" hint="不填长期有效；安全类一般 12">
            <Input type="number" min={1} max={60} value={f.validMonths ?? ''} onChange={(e) => setF({ ...f, validMonths: e.target.value ? Number(e.target.value) : null })} />
          </Field>
        </div>
        <Field label="简介">
          <Textarea rows={2} maxLength={300} value={f.summary} onChange={(e) => setF({ ...f, summary: e.target.value })} />
        </Field>
        <Field label="封面色">
          <div className="flex gap-2">
            {ACADEMY_COVERS.map((k) => (
              <button
                key={k}
                type="button"
                aria-label={k}
                aria-pressed={f.cover === k}
                onClick={() => setF({ ...f, cover: k })}
                className={cn('tap relative size-8 rounded-full border-2', COVER_CLASS[k].solid, f.cover === k ? 'border-ink' : 'border-transparent')}
              />
            ))}
          </div>
        </Field>
        <Field label="阶段（一门课一站，按顺序）">
          <div className="space-y-1.5">
            {f.courseIds.map((id, i) => (
              <div key={id} className="flex items-center gap-2 rounded-md border border-line px-3 py-1.5">
                <span className="w-6 text-[13px] font-bold text-ink-3">{i + 1}</span>
                <span className="min-w-0 flex-1 truncate text-[14px]">{byId.get(id)?.title ?? `课程 ${id}`}</span>
                {byId.get(id) && statusBadge(byId.get(id)!.status)}
                <button type="button" className="tap relative p-1 text-ink-3 disabled:opacity-30" aria-label="上移" disabled={i === 0} onClick={() => move(i, i - 1)}>
                  <ArrowUp className="size-4" />
                </button>
                <button type="button" className="tap relative p-1 text-ink-3 disabled:opacity-30" aria-label="下移" disabled={i === f.courseIds.length - 1} onClick={() => move(i, i + 1)}>
                  <ArrowDown className="size-4" />
                </button>
                <button type="button" className="tap relative p-1 text-clay" aria-label="去掉这一站" onClick={() => setF({ ...f, courseIds: f.courseIds.filter((x) => x !== id) })}>
                  <X className="size-4" />
                </button>
              </div>
            ))}
            <Select value="" onChange={(e) => e.target.value && setF({ ...f, courseIds: [...f.courseIds, Number(e.target.value)] })} data-testid="academy-path-add-course">
              <option value="">加一站：选一门课</option>
              {(courses.data ?? [])
                .filter((c) => !f.courseIds.includes(c.id))
                .map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.title}（{ACADEMY_CATEGORY_LABELS[c.category]}）
                  </option>
                ))}
            </Select>
          </div>
        </Field>
      </PendingLock>
    </Dialog>
  );
}

function PathsTab() {
  const paths = useQuery({ queryKey: adminKeys.paths, queryFn: () => api.get<AcademyAdminPath[]>('/api/admin/academy/paths') });
  const [open, setOpen] = useState<AcademyAdminPath | 'new' | null>(null);
  const columns: DataColumn<AcademyAdminPath>[] = [
    { key: 'title', header: '地图', cell: (p) => <span className="font-semibold">{p.title}</span> },
    { key: 'status', header: '状态', cell: (p) => statusBadge(p.status) },
    { key: 'stages', header: '阶段', numeric: true, cell: (p) => p.courseCount },
    { key: 'credits', header: '学完学分', numeric: true, cell: (p) => p.credits },
    { key: 'valid', header: '证书有效期', cell: (p) => (p.validMonths ? `${p.validMonths} 个月` : '长期') },
  ];
  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setOpen('new')} data-testid="academy-new-path">
          新建学习地图
        </Button>
      </div>
      <DataTable
        onPage
        columns={columns}
        rows={paths.data}
        rowKey={(p) => p.id}
        onRowClick={(p) => setOpen(p)}
        failed={paths.isError && !paths.data}
        onRetry={() => void paths.refetch()}
        empty="还没有学习地图"
      />
      {open && <PathDialog key={open === 'new' ? 'new' : `${open.id}-${open.version}`} path={open === 'new' ? null : open} onClose={() => setOpen(null)} />}
    </div>
  );
}

// ───────────────────────── 指派 ─────────────────────────

function NewAssignmentDialog({ onClose }: { onClose: () => void }) {
  const paths = useQuery({ queryKey: adminKeys.paths, queryFn: () => api.get<AcademyAdminPath[]>('/api/admin/academy/paths') });
  const courses = useAdminCourses();
  const learners = useQuery({ queryKey: adminKeys.learners, queryFn: () => api.get<AcademyLearnerRow[]>('/api/admin/academy/learners') });
  const [target, setTarget] = useState('');
  const [audience, setAudience] = useState<'all' | 'department' | 'position' | 'staff'>('department');
  const [who, setWho] = useState('');
  const [required, setRequired] = useState(true);
  const [dueDays, setDueDays] = useState<number | null>(30);
  const [busy, setBusy] = useState(false);
  const key = useRef(uuid());
  const pending = useOpPending(key.current);
  const toast = useToast();
  const qc = useQueryClient();
  const [kind, id] = target.split(':');
  const ready = !!target && (audience === 'all' || !!who);
  const save = async () => {
    setBusy(true);
    try {
      await sendAcademyOp({
        key: key.current,
        method: 'POST',
        url: '/api/admin/academy/assignments',
        body: {
          clientKey: key.current,
          pathId: kind === 'path' ? Number(id) : null,
          courseId: kind === 'course' ? Number(id) : null,
          audience,
          departmentKey: audience === 'department' ? who : null,
          positionKey: audience === 'position' ? who : null,
          staffId: audience === 'staff' ? Number(who) : null,
          required,
          dueDays: required ? dueDays : null,
        },
        summary: '新建指派',
      });
      await qc.invalidateQueries({ queryKey: adminKeys.assignments });
      onClose();
    } catch (e) {
      toast({ tone: 'error', title: '没指派上', body: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title="新建指派"
      footer={
        <Button variant="primary" loading={busy} disabled={!ready} onClick={() => void save()} data-testid="academy-assignment-save">
          {pending ? '按原内容重新提交' : '指派'}
        </Button>
      }
    >
      <PendingLock pending={pending} className="space-y-3">
        <Field label="学什么" hint="草稿、下架的地图与课员工看不到，先上架">
          <Select value={target} onChange={(e) => setTarget(e.target.value)} data-testid="academy-assignment-target">
            <option value="">选一张学习地图或一门课</option>
            <optgroup label="学习地图">
              {paths.data?.map((p) => (
                <option key={p.id} value={`path:${p.id}`}>
                  {p.title}
                </option>
              ))}
            </optgroup>
            <optgroup label="课程">
              {courses.data?.map((c) => (
                <option key={c.id} value={`course:${c.id}`}>
                  {c.title}
                </option>
              ))}
            </optgroup>
          </Select>
        </Field>
        <Field label="给谁">
          <div className="grid grid-cols-[auto_1fr] gap-2">
            <Select
              fullWidth={false}
              value={audience}
              onChange={(e) => {
                setAudience(e.target.value as typeof audience);
                setWho('');
              }}
            >
              <option value="all">全员</option>
              <option value="department">部门</option>
              <option value="position">岗位</option>
              <option value="staff">个人</option>
            </Select>
            {audience === 'department' && (
              <Select value={who} onChange={(e) => setWho(e.target.value)} data-testid="academy-assignment-who">
                <option value="">选部门</option>
                {ORG_DEPARTMENTS.map((d) => (
                  <option key={d.key} value={d.key}>
                    {d.name}
                  </option>
                ))}
              </Select>
            )}
            {audience === 'position' && (
              <Select value={who} onChange={(e) => setWho(e.target.value)}>
                <option value="">选岗位</option>
                {POSITIONS.filter((p) => p.key !== 'president').map((p) => (
                  <option key={p.key} value={p.key}>
                    {p.title}
                  </option>
                ))}
              </Select>
            )}
            {audience === 'staff' && (
              <Select value={who} onChange={(e) => setWho(e.target.value)}>
                <option value="">选员工</option>
                {learners.data?.map((l) => (
                  <option key={l.staffId} value={l.staffId}>
                    {l.name}
                    {l.departmentName ? `（${l.departmentName}）` : ''}
                  </option>
                ))}
              </Select>
            )}
          </div>
        </Field>
        <label className="flex items-center gap-2 text-[14px] text-ink-2">
          <input type="checkbox" className="size-4" checked={required} onChange={(e) => setRequired(e.target.checked)} />
          必修（不勾是推荐）
        </label>
        {required && (
          <Field label="几天内学完" hint="从今天或新员工入职日算，晚的那个；不填不设截止">
            <Input type="number" min={1} max={365} value={dueDays ?? ''} onChange={(e) => setDueDays(e.target.value ? Number(e.target.value) : null)} />
          </Field>
        )}
      </PendingLock>
    </Dialog>
  );
}

function PeopleDialog({ a, onClose }: { a: AcademyAssignmentStat; onClose: () => void }) {
  const people = useQuery({ queryKey: ['academy', 'admin', 'people', a.id], queryFn: () => api.get<AcademyPersonProgress[]>(`/api/admin/academy/assignments/${a.id}/people`) });
  const columns: DataColumn<AcademyPersonProgress>[] = [
    { key: 'name', header: '员工', cell: (p) => p.name },
    { key: 'dept', header: '部门', cell: (p) => p.departmentName ?? '—' },
    { key: 'progress', header: '进度', numeric: true, cell: (p) => `${p.done}/${p.total}` },
    { key: 'due', header: '截止', cell: (p) => p.dueOn ?? '—' },
    { key: 'state', header: '情况', cell: (p) => (p.completed ? <Badge tone="pine">已完成</Badge> : p.overdue ? <Badge tone="clay">已逾期</Badge> : <Badge>学习中</Badge>) },
  ];
  return (
    <Dialog open onClose={onClose} width="max-w-2xl" title={`「${a.targetTitle}」· ${a.audienceLabel}`}>
      <DataTable columns={columns} rows={people.data} rowKey={(p) => p.staffId} failed={people.isError && !people.data} onRetry={() => void people.refetch()} empty="没有命中的在职员工" />
    </Dialog>
  );
}

function AssignmentsTab() {
  const list = useQuery({ queryKey: adminKeys.assignments, queryFn: () => api.get<AcademyAssignmentStat[]>('/api/admin/academy/assignments') });
  const [creating, setCreating] = useState(false);
  const [people, setPeople] = useState<AcademyAssignmentStat | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const toast = useToast();
  const qc = useQueryClient();
  const toggle = async (a: AcademyAssignmentStat) => {
    setBusy(a.id);
    try {
      await sendAcademyOp({
        key: uuid(),
        method: 'PUT',
        url: `/api/admin/academy/assignments/${a.id}`,
        body: { required: a.required, dueDays: a.dueDays, active: !a.active, version: a.version },
        summary: `${a.active ? '停用' : '启用'}指派「${a.targetTitle}」`,
      });
      await qc.invalidateQueries({ queryKey: adminKeys.assignments });
    } catch (e) {
      toast({ tone: 'error', title: '没改成', body: errorMessage(e) });
    } finally {
      setBusy(null);
    }
  };
  const columns: DataColumn<AcademyAssignmentStat>[] = [
    { key: 'target', header: '学什么', cell: (a) => <span className="font-semibold">{a.targetTitle}</span> },
    { key: 'kind', header: '', cell: (a) => <Badge tone="lake">{a.targetKind === 'path' ? '地图' : '课程'}</Badge> },
    { key: 'who', header: '给谁', cell: (a) => a.audienceLabel },
    { key: 'req', header: '要求', cell: (a) => (a.required ? `必修${a.dueDays ? ` · ${a.dueDays} 天` : ''}` : '推荐') },
    { key: 'people', header: '人数', numeric: true, cell: (a) => a.people },
    { key: 'done', header: '已完成', numeric: true, cell: (a) => a.completed },
    { key: 'overdue', header: '逾期', numeric: true, cell: (a) => (a.overdue ? <span className="font-bold text-clay">{a.overdue}</span> : 0) },
    {
      key: 'actions',
      header: '',
      cell: (a) => (
        <span className="flex gap-1.5">
          <Button size="sm" onClick={() => setPeople(a)} disabled={!a.active}>
            看人
          </Button>
          <Button size="sm" variant={a.active ? 'danger' : 'secondary'} loading={busy === a.id} onClick={() => void toggle(a)}>
            {a.active ? '停用' : '启用'}
          </Button>
        </span>
      ),
    },
  ];
  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setCreating(true)} data-testid="academy-new-assignment">
          新建指派
        </Button>
      </div>
      <DataTable
        onPage
        columns={columns}
        rows={list.data}
        rowKey={(a) => a.id}
        rowClassName={(a) => (a.active ? undefined : 'opacity-60')}
        failed={list.isError && !list.data}
        onRetry={() => void list.refetch()}
        empty="还没有指派"
        emptyDescription="给部门、岗位或个人指派学习地图或课程，就成了他们的必修"
        tableClassName="min-w-[760px]"
      />
      {creating && <NewAssignmentDialog onClose={() => setCreating(false)} />}
      {people && <PeopleDialog a={people} onClose={() => setPeople(null)} />}
    </div>
  );
}

// ───────────────────────── 内置课程包 ─────────────────────────

const STATE_TONE = { new: 'lake', same: 'pine', changed: 'yuzu', edited: 'neutral' } as const;

function PacksTab() {
  const packs = useQuery({ queryKey: adminKeys.packs, queryFn: () => api.get<AcademyPackStatus>('/api/admin/academy/packs') });
  const [publish, setPublish] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<AcademyPackImportResult | null>(null);
  const toast = useToast();
  const qc = useQueryClient();
  const run = async () => {
    setBusy(true);
    const key = uuid();
    try {
      const r = await sendAcademyOp<AcademyPackImportResult>({ key, method: 'POST', url: '/api/admin/academy/packs/import', body: { clientKey: key, publish }, summary: '导入内置课程包' });
      setResult(r);
      toast({ tone: 'success', title: '导入完了', body: `新建 ${r.courses.filter((c) => c.result === 'created').length} 门、更新 ${r.courses.filter((c) => c.result === 'updated').length} 门` });
      await qc.invalidateQueries({ queryKey: ['academy'] });
    } catch (e) {
      toast({ tone: 'error', title: '没导进去', body: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };
  const columns: DataColumn<AcademyPackCourse>[] = [
    { key: 'title', header: '课程', cell: (c) => <span className="font-semibold">{c.title}</span> },
    { key: 'category', header: '分类', cell: (c) => ACADEMY_CATEGORY_LABELS[c.category] },
    { key: 'lessons', header: '课时', numeric: true, cell: (c) => c.lessons },
    { key: 'questions', header: '题', numeric: true, cell: (c) => c.questions },
    { key: 'minutes', header: '分钟', numeric: true, cell: (c) => c.minutes },
    { key: 'state', header: '在库里', cell: (c) => <Badge tone={STATE_TONE[c.state]}>{ACADEMY_PACK_STATE_LABELS[c.state]}</Badge> },
    { key: 'status', header: '状态', cell: (c) => (c.status ? statusBadge(c.status) : '—') },
  ];
  return (
    <div className="space-y-4" data-testid="academy-packs">
      <Notice tone="info" title="仓库里带的通用课件：应知应会（全员、前厅、浴区、保健、餐饮、安全）、水疗行业通识 7 门、汤崎之道、系统小课堂、带教">
        导入后默认是草稿、指派先停用：请逐门看过（尤其是「汤崎之道」的服务理念要按品牌书改写），按 docs/ACADEMY_PACKS.md 的核对单改过，再上架课程与地图、打开指派。本地改过的课再导入不会被覆盖。
      </Notice>
      <Card className="flex flex-wrap items-center gap-3 p-4">
        <label className="flex items-center gap-2 text-[14px] text-ink-2">
          <input type="checkbox" className="size-4" checked={publish} onChange={(e) => setPublish(e.target.checked)} data-testid="academy-pack-publish" />
          导入后直接上架、指派直接生效（不建议：先审一遍）
        </label>
        <Button variant="primary" icon={<Download className="size-4" />} loading={busy} className="ml-auto" onClick={() => void run()} data-testid="academy-pack-import">
          导入
        </Button>
      </Card>
      {result && (
        <Card className="p-4 text-[13px] text-ink-2" data-testid="academy-pack-result">
          {(['created', 'updated', 'unchanged', 'skipped'] as const).map((k) => {
            const names = result.courses.filter((c) => c.result === k).map((c) => c.title);
            return names.length ? (
              <p key={k}>
                {{ created: '新建', updated: '更新', unchanged: '没变', skipped: '本地改过、没覆盖' }[k]}：{names.join('、')}
              </p>
            ) : null;
          })}
        </Card>
      )}
      <SectionTitle>课程（{packs.data?.courses.length ?? '…'} 门）</SectionTitle>
      <DataTable
        onPage
        columns={columns}
        rows={packs.data?.courses}
        rowKey={(c) => c.code}
        failed={packs.isError && !packs.data}
        onRetry={() => void packs.refetch()}
        empty="没有内置课件"
        tableClassName="min-w-[640px]"
      />
      <SectionTitle>学习地图</SectionTitle>
      <div className="grid gap-2 md:grid-cols-2">
        {packs.data?.paths.map((p) => (
          <Card key={p.code} className="p-3.5">
            <div className="flex items-center gap-2">
              <p className="min-w-0 flex-1 truncate text-[15px] font-bold text-ink">{p.title}</p>
              <Badge tone={STATE_TONE[p.state]}>{ACADEMY_PACK_STATE_LABELS[p.state]}</Badge>
            </div>
            <p className="mt-1 text-[12px] text-ink-3">{p.summary}</p>
            <p className="mt-1 text-[12px] text-ink-3">指派：{p.assignments.join('；')}</p>
          </Card>
        ))}
      </div>
    </div>
  );
}

// ───────────────────────── 学习数据 ─────────────────────────

function DataTab() {
  const learners = useQuery({ queryKey: adminKeys.learners, queryFn: () => api.get<AcademyLearnerRow[]>('/api/admin/academy/learners') });
  const certs = useQuery({ queryKey: adminKeys.certs, queryFn: () => api.get<AcademyCertificate[]>('/api/admin/academy/certificates') });
  const [revoking, setRevoking] = useState<AcademyCertificate | null>(null);
  const learnerColumns: DataColumn<AcademyLearnerRow>[] = [
    { key: 'name', header: '员工', cell: (l) => l.name },
    { key: 'dept', header: '部门', cell: (l) => l.departmentName ?? '—' },
    { key: 'credits', header: '学分', numeric: true, cell: (l) => l.credits },
    { key: 'minutes', header: '学习分钟', numeric: true, cell: (l) => l.minutes },
    { key: 'lessons', header: '学完课时', numeric: true, cell: (l) => l.completedLessons },
    { key: 'last', header: '最近学习', cell: (l) => l.lastStudyOn ?? '—' },
  ];
  const certColumns: DataColumn<AcademyCertificate>[] = [
    { key: 'no', header: '编号', cell: (c) => <span className="font-mono text-[13px]">{c.certNo}</span> },
    { key: 'who', header: '员工', cell: (c) => c.staffName },
    { key: 'title', header: '证书', cell: (c) => c.title },
    { key: 'issued', header: '颁发', cell: (c) => c.issuedOn },
    { key: 'expires', header: '到期', cell: (c) => c.expiresOn ?? '长期' },
    {
      key: 'state',
      header: '状态',
      cell: (c) => (c.revoked ? <Badge tone="clay">已撤销</Badge> : c.expired ? <Badge tone="ember">已过期</Badge> : <Badge tone="pine">有效</Badge>),
    },
    {
      key: 'actions',
      header: '',
      cell: (c) =>
        c.revoked ? null : (
          <Button size="sm" variant="danger" onClick={() => setRevoking(c)}>
            撤销
          </Button>
        ),
    },
  ];
  return (
    <div className="space-y-4">
      <SectionTitle>员工学习概况</SectionTitle>
      <DataTable
        onPage
        columns={learnerColumns}
        rows={learners.data}
        rowKey={(l) => l.staffId}
        failed={learners.isError && !learners.data}
        onRetry={() => void learners.refetch()}
        empty="还没有在职员工"
      />
      <SectionTitle>证书</SectionTitle>
      <DataTable
        onPage
        columns={certColumns}
        rows={certs.data}
        rowKey={(c) => c.id}
        failed={certs.isError && !certs.data}
        onRetry={() => void certs.refetch()}
        empty="还没有人拿到证书"
        tableClassName="min-w-[640px]"
      />
      {revoking && <RevokeDialog cert={revoking} onClose={() => setRevoking(null)} />}
    </div>
  );
}

function RevokeDialog({ cert, onClose }: { cert: AcademyCertificate; onClose: () => void }) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const qc = useQueryClient();
  return (
    <Dialog
      open
      onClose={onClose}
      title={`撤销证书 ${cert.certNo}`}
      footer={
        <Button
          variant="danger"
          loading={busy}
          disabled={!reason.trim()}
          onClick={async () => {
            setBusy(true);
            try {
              await sendAcademyOp({ key: uuid(), method: 'POST', url: `/api/admin/academy/certificates/${cert.id}/revoke`, body: { reason: reason.trim() }, summary: `撤销证书 ${cert.certNo}` });
              await qc.invalidateQueries({ queryKey: adminKeys.certs });
              onClose();
            } catch (e) {
              toast({ tone: 'error', title: '没撤销成', body: errorMessage(e) });
            } finally {
              setBusy(false);
            }
          }}
        >
          撤销
        </Button>
      }
    >
      <Field label={`撤销 ${cert.staffName} 的「${cert.title}」证书的原因`}>
        <Textarea rows={2} maxLength={200} value={reason} onChange={(e) => setReason(e.target.value)} />
      </Field>
    </Dialog>
  );
}
