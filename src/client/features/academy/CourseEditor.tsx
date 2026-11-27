// 汤崎学堂 · 后台编辑一门课（docs/ACADEMY.md 第 6、8 节）：课程信息与上架、课时（图文课件边写边看手机预览、文件、测验、实操）、
// 调顺序、题库（手写、AI 出题、从表格导入，AI 与导入的先是草稿）。写操作都带操作编号或版本，没收到结果的原样重提。

import { useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, Bot, ExternalLink, FileUp, Pencil, Plus } from 'lucide-react';
import {
  ACADEMY_CATEGORIES,
  ACADEMY_CATEGORY_LABELS,
  ACADEMY_COVERS,
  ACADEMY_LESSON_KIND_LABELS,
  ACADEMY_LESSON_KINDS,
  ACADEMY_QUESTION_SOURCE_LABELS,
  ACADEMY_QUESTION_STATUS_LABELS,
  ACADEMY_STATUS_LABELS,
  type AcademyAdminCourse,
  type AcademyAdminLesson,
  type AcademyAiGenerateResult,
  type AcademyCategory,
  type AcademyCover,
  type AcademyLessonKind,
  type AcademyQuestion,
  type AcademyStatus,
  type AcademyTableImportResult,
} from '@shared/academy';
import { academyQuestionProblems, ACADEMY_QUESTION_KIND_LABELS, ACADEMY_QUESTION_KINDS, parseAcademyMarkup, type AcademyQuestionKind } from '@shared/academy-markup';
import { ORG_DEPARTMENTS } from '@shared/positions';
import type { TrainingFile, TrainingFolderList } from '@shared/training';
import { api, ApiError, errorMessage } from '../../lib/api';
import { readTablePayload } from '../../lib/import-file';
import { cn, uuid } from '../../lib/utils';
import { DataTable, type DataColumn } from '../../components/DataTable';
import { LoadFailed } from '../../components/LoadFailed';
import { Dialog } from '../../components/Overlay';
import { useToast } from '../../components/Toast';
import { Badge, Button, Card, Field, Input, Notice, SectionTitle, Segmented, Select, Skeleton, Textarea } from '../../components/ui';
import { ArticleView } from './ArticleView';
import { academyKeys, COVER_CLASS, sendAcademyOp } from './data';
import { PendingLock, useOpPending } from './parts';

export const adminKeys = {
  courses: ['academy', 'admin', 'courses'] as const,
  course: (id: number) => ['academy', 'admin', 'course', id] as const,
  questions: (id: number) => ['academy', 'admin', 'questions', id] as const,
  paths: ['academy', 'admin', 'paths'] as const,
  assignments: ['academy', 'admin', 'assignments'] as const,
  packs: ['academy', 'admin', 'packs'] as const,
  learners: ['academy', 'admin', 'learners'] as const,
  certs: ['academy', 'admin', 'certs'] as const,
};

const STATUS_TONE: Record<AcademyStatus, 'neutral' | 'pine' | 'clay'> = { draft: 'neutral', published: 'pine', archived: 'clay' };
export const statusBadge = (s: AcademyStatus) => <Badge tone={STATUS_TONE[s]}>{ACADEMY_STATUS_LABELS[s]}</Badge>;

/** 服务端回的「第几行哪里不对」（课件文本、表格导入） */
function problemsOf(e: unknown): { line?: number; row?: number; message: string }[] {
  if (e instanceof ApiError && e.details && Array.isArray((e.details as { problems?: unknown }).problems)) return (e.details as { problems: { message: string }[] }).problems;
  return [];
}

export function CourseEditor({ id, onBack }: { id: number; onBack: () => void }) {
  const course = useQuery({ queryKey: adminKeys.course(id), queryFn: () => api.get<AcademyAdminCourse>(`/api/admin/academy/courses/${id}`) });
  const [lesson, setLesson] = useState<AcademyAdminLesson | 'new' | null>(null);
  const qc = useQueryClient();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const refresh = () =>
    Promise.all([qc.invalidateQueries({ queryKey: adminKeys.course(id) }), qc.invalidateQueries({ queryKey: adminKeys.courses }), qc.invalidateQueries({ queryKey: academyKeys.all })]);
  if (course.isError && !course.data) return <LoadFailed title="这门课没有取回来" onRetry={() => void course.refetch()} />;
  if (!course.data) return <Skeleton className="h-80" />;
  const { course: c, lessons } = course.data;
  const reorder = async (from: number, to: number) => {
    const ids = lessons.map((l) => l.id);
    [ids[from], ids[to]] = [ids[to]!, ids[from]!];
    setBusy(true);
    try {
      await api.post(`/api/admin/academy/courses/${id}/reorder`, { lessonIds: ids });
      await refresh();
    } catch (e) {
      toast({ tone: 'error', title: '没调成', body: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-5" data-testid="academy-course-editor">
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" onClick={onBack}>
          返回课程列表
        </Button>
        <h2 className="min-w-0 flex-1 truncate text-[18px] font-bold text-ink">{c.title}</h2>
        {statusBadge(c.status)}
        {c.packVersion && <Badge tone="lake">{c.localEdited ? '课件包 · 本地改过' : '课件包'}</Badge>}
        <a href={`/oa/academy/courses/${c.id}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-[13px] font-semibold text-pine">
          <ExternalLink className="size-3.5" aria-hidden />
          预览
        </a>
      </div>
      <CourseForm key={`${c.id}-${c.version}`} data={course.data} onSaved={refresh} />
      <Card className="p-4">
        <SectionTitle
          aside={
            <Button size="sm" icon={<Plus className="size-3.5" />} onClick={() => setLesson('new')} data-testid="academy-add-lesson">
              加课时
            </Button>
          }
        >
          课时（学习任务）
        </SectionTitle>
        <div className="mt-3 space-y-1.5">
          {lessons.map((l, i) => (
            <div key={l.id} className="flex items-center gap-2 rounded-md border border-line px-3 py-2" data-testid={`academy-admin-lesson-${l.id}`}>
              <span className="w-6 text-center text-[13px] font-bold text-ink-3">{i + 1}</span>
              <span className={cn('min-w-0 flex-1 truncate text-[14px] font-semibold', l.active ? 'text-ink' : 'text-ink-4 line-through')}>{l.title}</span>
              <Badge>{ACADEMY_LESSON_KIND_LABELS[l.kind]}</Badge>
              <span className="hidden text-[12px] text-ink-3 sm:inline">
                {l.minutes} 分钟 · {l.credits} 学分
              </span>
              <button type="button" className="tap relative p-1 text-ink-3 disabled:opacity-30" aria-label="上移" disabled={busy || i === 0} onClick={() => void reorder(i, i - 1)}>
                <ArrowUp className="size-4" />
              </button>
              <button type="button" className="tap relative p-1 text-ink-3 disabled:opacity-30" aria-label="下移" disabled={busy || i === lessons.length - 1} onClick={() => void reorder(i, i + 1)}>
                <ArrowDown className="size-4" />
              </button>
              <button type="button" className="tap relative p-1 text-pine" aria-label="编辑" onClick={() => setLesson(l)}>
                <Pencil className="size-4" />
              </button>
            </div>
          ))}
          {!lessons.length && <p className="text-[13px] text-ink-4">还没有课时。先加课时，再上架。</p>}
        </div>
      </Card>
      <QuestionBank courseId={c.id} lessons={lessons} />
      {lesson && <LessonDialog courseId={c.id} lesson={lesson === 'new' ? null : lesson} onClose={() => setLesson(null)} onSaved={refresh} />}
    </div>
  );
}

function CourseForm({ data, onSaved }: { data: AcademyAdminCourse; onSaved: () => Promise<unknown> }) {
  const c = data.course;
  const [f, setF] = useState({ title: c.title, summary: c.summary, category: c.category, departmentKey: c.departmentKey, deptOnly: c.deptOnly, cover: c.cover, sort: c.sort });
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const save = async (status: AcademyStatus) => {
    setBusy(true);
    try {
      await sendAcademyOp({
        key: uuid(),
        method: 'PUT',
        url: `/api/admin/academy/courses/${c.id}`,
        body: { ...f, status, version: c.version },
        summary: `保存课程「${f.title}」`,
      });
      toast({ tone: 'success', title: status === c.status ? '保存了' : `已${ACADEMY_STATUS_LABELS[status]}` });
      await onSaved();
    } catch (e) {
      toast({ tone: 'error', title: '没保存上', body: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card className="space-y-3 p-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="课程名称">
          <Input value={f.title} maxLength={60} onChange={(e) => setF({ ...f, title: e.target.value })} />
        </Field>
        <Field label="分类（知识中心的栏目）">
          <Select value={f.category} onChange={(e) => setF({ ...f, category: e.target.value as AcademyCategory })}>
            {ACADEMY_CATEGORIES.map((k) => (
              <option key={k} value={k}>
                {ACADEMY_CATEGORY_LABELS[k]}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="属于哪个部门" hint="不选是全员通用">
          <Select value={f.departmentKey ?? ''} onChange={(e) => setF({ ...f, departmentKey: e.target.value || null, deptOnly: e.target.value ? f.deptOnly : false })}>
            <option value="">全员通用</option>
            {ORG_DEPARTMENTS.map((d) => (
              <option key={d.key} value={d.key}>
                {d.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="封面色">
          <div className="flex gap-2">
            {ACADEMY_COVERS.map((k) => (
              <button
                key={k}
                type="button"
                aria-label={k}
                aria-pressed={f.cover === k}
                onClick={() => setF({ ...f, cover: k as AcademyCover })}
                className={cn('tap relative size-8 rounded-full border-2', COVER_CLASS[k].solid, f.cover === k ? 'border-ink' : 'border-transparent')}
              />
            ))}
          </div>
        </Field>
      </div>
      <Field label="简介">
        <Textarea rows={2} maxLength={300} value={f.summary} onChange={(e) => setF({ ...f, summary: e.target.value })} />
      </Field>
      <label className="flex items-center gap-2 text-[14px] text-ink-2">
        <input type="checkbox" className="size-4" disabled={!f.departmentKey} checked={f.deptOnly} onChange={(e) => setF({ ...f, deptOnly: e.target.checked })} />
        只给本部门看（加上被指派到的人）
      </label>
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" loading={busy} onClick={() => void save(c.status)} data-testid="academy-course-save">
          保存
        </Button>
        {c.status !== 'published' && (
          <Button loading={busy} onClick={() => void save('published')} data-testid="academy-course-publish">
            上架
          </Button>
        )}
        {c.status === 'published' && (
          <Button variant="danger" loading={busy} onClick={() => void save('archived')}>
            下架
          </Button>
        )}
        {c.status === 'archived' && (
          <Button loading={busy} onClick={() => void save('draft')}>
            改回草稿
          </Button>
        )}
      </div>
    </Card>
  );
}

/** 员工培训里全员看得到的文件（「培训资料」与不对应部门的文件夹），文件课时只能用这些 */
function useOpenFiles(enabled: boolean) {
  return useQuery({
    queryKey: ['academy', 'admin', 'open-files'],
    enabled,
    queryFn: async () => {
      const list = await api.get<TrainingFolderList>('/api/training/folders');
      const open = list.folders.filter((f) => f.active && (f.kind === 'public' || f.departmentKey === null));
      const files = await Promise.all(open.map(async (f) => ({ folder: f, files: (await api.get<TrainingFile[]>(`/api/training/folders/${f.id}/files`)).filter((x) => x.active) })));
      return files;
    },
  });
}

function LessonDialog({ courseId, lesson, onClose, onSaved }: { courseId: number; lesson: AcademyAdminLesson | null; onClose: () => void; onSaved: () => Promise<unknown> }) {
  const [f, setF] = useState({
    title: lesson?.title ?? '',
    kind: (lesson?.kind ?? 'article') as AcademyLessonKind,
    body: lesson?.body ?? '',
    fileId: lesson?.fileId ?? null,
    quizCount: lesson?.quiz?.count ?? 5,
    quizPass: lesson?.quiz?.pass ?? 80,
    minutes: lesson?.minutes ?? 5,
    credits: lesson?.credits ?? null,
    active: lesson?.active ?? true,
  });
  const [view, setView] = useState<'edit' | 'preview'>('edit');
  const [busy, setBusy] = useState(false);
  const [serverProblems, setServerProblems] = useState<{ line?: number; message: string }[]>([]);
  const key = useRef(uuid());
  const pending = useOpPending(key.current) && !lesson;
  const toast = useToast();
  const parsed = useMemo(() => (f.kind === 'article' ? parseAcademyMarkup(f.body) : null), [f.kind, f.body]);
  const files = useOpenFiles(f.kind === 'file');
  const problems = parsed?.problems ?? [];
  const save = async () => {
    setBusy(true);
    setServerProblems([]);
    const body = {
      title: f.title,
      kind: f.kind,
      body: f.kind === 'article' || f.kind === 'practical' ? f.body : '',
      fileId: f.kind === 'file' ? f.fileId : null,
      quizCount: f.kind === 'quiz' ? f.quizCount : null,
      quizPass: f.kind === 'quiz' ? f.quizPass : null,
      minutes: f.minutes,
      credits: f.credits,
    };
    try {
      if (lesson)
        await sendAcademyOp({
          key: uuid(),
          method: 'PUT',
          url: `/api/admin/academy/lessons/${lesson.id}`,
          body: { ...body, active: f.active, version: lesson.version },
          summary: `保存课时「${f.title}」`,
        });
      else await sendAcademyOp({ key: key.current, method: 'POST', url: `/api/admin/academy/courses/${courseId}/lessons`, body: { ...body, clientKey: key.current }, summary: `加课时「${f.title}」` });
      await onSaved();
      onClose();
    } catch (e) {
      setServerProblems(problemsOf(e));
      toast({ tone: 'error', title: '没保存上', body: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };
  const generate = async () => {
    if (!lesson) return;
    setBusy(true);
    const k = uuid();
    try {
      const r = await sendAcademyOp<AcademyAiGenerateResult>({
        key: k,
        method: 'POST',
        url: `/api/admin/academy/lessons/${lesson.id}/generate`,
        body: { clientKey: k, count: 5 },
        summary: `AI 按「${lesson.title}」出题`,
      });
      toast({ tone: 'success', title: `AI 出了 ${r.questions.length} 道草稿题`, body: r.dropped ? `另有 ${r.dropped} 道不合格，丢掉了。草稿题审过、改过再启用。` : '草稿题审过、改过再启用。' });
      await onSaved();
    } catch (e) {
      toast({ tone: 'error', title: 'AI 没出成题', body: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onClose={onClose}
      width="max-w-4xl"
      title={lesson ? `编辑课时「${lesson.title}」` : '加课时'}
      footer={
        <>
          {lesson?.kind === 'article' && (
            <Button icon={<Bot className="size-4" />} loading={busy} onClick={() => void generate()} data-testid="academy-ai-generate">
              AI 出题
            </Button>
          )}
          <Button variant="primary" loading={busy} disabled={!f.title.trim() || problems.length > 0} onClick={() => void save()} data-testid="academy-lesson-save">
            {pending ? '按原内容重新提交' : '保存'}
          </Button>
        </>
      }
    >
      <PendingLock pending={pending} className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
          <Field label="课时标题">
            <Input value={f.title} maxLength={60} onChange={(e) => setF({ ...f, title: e.target.value })} data-testid="academy-lesson-title" />
          </Field>
          <Field label="类型">
            <Segmented
              size="sm"
              value={f.kind}
              onChange={(kind) => setF({ ...f, kind })}
              options={ACADEMY_LESSON_KINDS.map((k) => ({ value: k, label: ACADEMY_LESSON_KIND_LABELS[k], disabled: !!lesson && lesson.kind !== k && k === 'file' }))}
            />
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Field label="预计分钟">
            <Input type="number" min={1} max={240} value={f.minutes} onChange={(e) => setF({ ...f, minutes: Number(e.target.value) || 1 })} />
          </Field>
          <Field label="学分" hint="不填按类型默认">
            <Input type="number" min={0} max={20} value={f.credits ?? ''} onChange={(e) => setF({ ...f, credits: e.target.value === '' ? null : Number(e.target.value) })} />
          </Field>
          {f.kind === 'quiz' && (
            <>
              <Field label="每次几题">
                <Input type="number" min={1} max={50} value={f.quizCount} onChange={(e) => setF({ ...f, quizCount: Number(e.target.value) || 1 })} />
              </Field>
              <Field label="及格线（分）">
                <Input type="number" min={1} max={100} value={f.quizPass} onChange={(e) => setF({ ...f, quizPass: Number(e.target.value) || 1 })} />
              </Field>
            </>
          )}
        </div>
        {lesson && (
          <label className="flex items-center gap-2 text-[14px] text-ink-2">
            <input type="checkbox" className="size-4" checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} />
            上架（下架的课时不算进课程完成）
          </label>
        )}
        {f.kind === 'article' && (
          <>
            <Segmented
              size="sm"
              value={view}
              onChange={setView}
              className="md:hidden"
              options={[
                { value: 'edit', label: '写课件' },
                { value: 'preview', label: '手机预览' },
              ]}
            />
            <div className="grid gap-3 md:grid-cols-2">
              <Textarea
                rows={18}
                className={cn('font-mono text-[13px] leading-relaxed', view === 'preview' && 'max-md:hidden')}
                value={f.body}
                onChange={(e) => setF({ ...f, body: e.target.value })}
                placeholder={'## 本课目标\n- 学完能……\n\n:::tip 要点\n- ……\n:::\n\n:::check\n题干\n- [x] 对的\n- [ ] 错的\n解析：……\n:::'}
                data-testid="academy-lesson-body"
              />
              <div className={cn('max-h-[60dvh] overflow-y-auto rounded-lg border border-line bg-paper p-3', view === 'edit' && 'max-md:hidden')} data-testid="academy-lesson-preview">
                {parsed && parsed.blocks.length ? <ArticleView blocks={parsed.blocks} /> : <p className="text-[13px] text-ink-4">左边写课件，这里看手机上的样子。格式见 docs/ACADEMY.md 第 6 节。</p>}
              </div>
            </div>
          </>
        )}
        {f.kind === 'practical' && (
          <Field label="检查项（每行一条，1–30 条）">
            <Textarea rows={8} value={f.body} onChange={(e) => setF({ ...f, body: e.target.value })} placeholder={'- 主动问候\n- 核对人数'} />
          </Field>
        )}
        {f.kind === 'file' && (
          <Field label="员工培训里的文件" hint="只列「培训资料」和不分部门的文件夹（课时里的文件要人人看得到）">
            {files.isError ? (
              <LoadFailed title="培训文件没有取回来" onRetry={() => void files.refetch()} />
            ) : (
              <Select value={f.fileId ?? ''} onChange={(e) => setF({ ...f, fileId: e.target.value ? Number(e.target.value) : null })}>
                <option value="">选一份文件</option>
                {files.data?.map((g) => (
                  <optgroup key={g.folder.id} label={g.folder.name}>
                    {g.files.map((x) => (
                      <option key={x.id} value={x.id}>
                        {x.title}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </Select>
            )}
          </Field>
        )}
        {[...problems, ...serverProblems].length > 0 && (
          <Notice tone="error" title="课件里有写错的地方" data-testid="academy-lesson-problems">
            <ul className="mt-1 space-y-0.5 text-[13px]">
              {[...problems, ...serverProblems].slice(0, 10).map((p, i) => (
                <li key={i}>
                  {p.line ? `第 ${p.line} 行：` : ''}
                  {p.message}
                </li>
              ))}
            </ul>
          </Notice>
        )}
      </PendingLock>
    </Dialog>
  );
}

const blankQuestion = (): Omit<AcademyQuestion, 'id' | 'courseId' | 'packKey' | 'source' | 'version'> => ({
  kind: 'single',
  skill: '',
  level: 1,
  stem: '',
  options: ['', ''],
  answer: [0],
  answerText: '',
  explanation: '',
  status: 'active',
});

function QuestionDialog({ courseId, question, onClose, onSaved }: { courseId: number; question: AcademyQuestion | null; onClose: () => void; onSaved: () => Promise<unknown> }) {
  const [q, setQ] = useState(question ? { ...question } : blankQuestion());
  const [busy, setBusy] = useState(false);
  const key = useRef(uuid());
  const pending = useOpPending(key.current) && !question;
  const toast = useToast();
  const draft = { ...q, options: q.kind === 'recall' ? [] : q.kind === 'judge' ? ['对', '错'] : q.options.map((o) => o.trim()), answer: q.kind === 'recall' ? [] : q.answer };
  const problems = academyQuestionProblems({ ...draft, stem: draft.stem.trim(), skill: draft.skill.trim() });
  const setKind = (kind: AcademyQuestionKind) =>
    setQ({ ...q, kind, options: kind === 'judge' ? ['对', '错'] : q.options.length >= 2 ? q.options : ['', ''], answer: kind === 'multi' ? q.answer : q.answer.slice(0, 1) });
  const save = async () => {
    setBusy(true);
    const body = {
      kind: draft.kind,
      skill: draft.skill,
      level: draft.level,
      stem: draft.stem,
      options: draft.options,
      answer: draft.answer,
      answerText: draft.answerText,
      explanation: draft.explanation,
      status: draft.status,
    };
    try {
      if (question)
        await sendAcademyOp({
          key: uuid(),
          method: 'PUT',
          url: `/api/admin/academy/questions/${question.id}`,
          body: { ...body, version: question.version },
          summary: `保存题「${draft.stem.slice(0, 16)}」`,
        });
      else
        await sendAcademyOp({
          key: key.current,
          method: 'POST',
          url: `/api/admin/academy/courses/${courseId}/questions`,
          body: { ...body, clientKey: key.current },
          summary: `加题「${draft.stem.slice(0, 16)}」`,
        });
      await onSaved();
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
      width="max-w-xl"
      title={question ? '编辑题' : '加题'}
      footer={
        <Button variant="primary" loading={busy} disabled={problems.length > 0} onClick={() => void save()} data-testid="academy-question-save">
          {pending ? '按原内容重新提交' : '保存'}
        </Button>
      }
    >
      <PendingLock pending={pending} className="space-y-3">
        <Segmented size="sm" value={q.kind} onChange={setKind} options={ACADEMY_QUESTION_KINDS.map((k) => ({ value: k, label: ACADEMY_QUESTION_KIND_LABELS[k] }))} />
        <div className="grid grid-cols-2 gap-3">
          <Field label="知识点">
            <Input value={q.skill} maxLength={30} onChange={(e) => setQ({ ...q, skill: e.target.value })} />
          </Field>
          <Field label="难度">
            <Select value={q.level} onChange={(e) => setQ({ ...q, level: Number(e.target.value) as 1 | 2 | 3 })}>
              <option value={1}>1 记住</option>
              <option value={2}>2 理解</option>
              <option value={3}>3 应用</option>
            </Select>
          </Field>
        </div>
        <Field label="题干">
          <Textarea rows={2} maxLength={300} value={q.stem} onChange={(e) => setQ({ ...q, stem: e.target.value })} />
        </Field>
        {q.kind === 'recall' ? (
          <Field label="答案（每日一练里看完自己评记没记住）">
            <Textarea rows={3} maxLength={500} value={q.answerText} onChange={(e) => setQ({ ...q, answerText: e.target.value })} />
          </Field>
        ) : (
          <Field label="选项（勾上对的）">
            <div className="space-y-1.5">
              {(q.kind === 'judge' ? ['对', '错'] : q.options).map((o, i) => (
                <div key={i} className="flex items-center gap-2">
                  <input
                    type={q.kind === 'multi' ? 'checkbox' : 'radio'}
                    name="academy-answer"
                    className="size-4"
                    checked={q.answer.includes(i)}
                    onChange={(e) => setQ({ ...q, answer: q.kind === 'multi' ? (e.target.checked ? [...q.answer, i].sort() : q.answer.filter((x) => x !== i)) : [i] })}
                    aria-label={`选项 ${String.fromCharCode(65 + i)} 是对的`}
                  />
                  {q.kind === 'judge' ? (
                    <span className="text-[14px]">{o}</span>
                  ) : (
                    <Input
                      value={o}
                      maxLength={120}
                      onChange={(e) => setQ({ ...q, options: q.options.map((x, j) => (j === i ? e.target.value : x)) })}
                      placeholder={`选项 ${String.fromCharCode(65 + i)}`}
                    />
                  )}
                </div>
              ))}
              {q.kind !== 'judge' && q.options.length < 6 && (
                <Button size="sm" icon={<Plus className="size-3.5" />} onClick={() => setQ({ ...q, options: [...q.options, ''] })}>
                  加选项
                </Button>
              )}
            </div>
          </Field>
        )}
        <Field label="解析">
          <Textarea rows={2} maxLength={500} value={q.explanation} onChange={(e) => setQ({ ...q, explanation: e.target.value })} />
        </Field>
        <Field label="状态" hint="AI 出的、表格导入的先是草稿，审过再启用；停用的不再进测验与每日一练">
          <Segmented
            size="sm"
            value={q.status}
            onChange={(status) => setQ({ ...q, status })}
            options={(['draft', 'active', 'retired'] as const).map((s) => ({ value: s, label: ACADEMY_QUESTION_STATUS_LABELS[s] }))}
          />
        </Field>
        {problems.length > 0 && <p className="text-[13px] text-clay">{problems[0]}</p>}
      </PendingLock>
    </Dialog>
  );
}

function QuestionBank({ courseId, lessons }: { courseId: number; lessons: AcademyAdminLesson[] }) {
  const questions = useQuery({ queryKey: adminKeys.questions(courseId), queryFn: () => api.get<AcademyQuestion[]>(`/api/admin/academy/courses/${courseId}/questions`) });
  const [open, setOpen] = useState<AcademyQuestion | 'new' | null>(null);
  const [importing, setImporting] = useState(false);
  const [importProblems, setImportProblems] = useState<{ row?: number; message: string }[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);
  const qc = useQueryClient();
  const toast = useToast();
  const refresh = () => qc.invalidateQueries({ queryKey: adminKeys.questions(courseId) });
  const quizzable = (questions.data ?? []).filter((q) => q.status === 'active' && q.kind !== 'recall').length;
  const needed = Math.max(0, ...lessons.filter((l) => l.kind === 'quiz' && l.active).map((l) => l.quiz?.count ?? 0));
  const importFile = async (file: File) => {
    setImporting(true);
    setImportProblems([]);
    const k = uuid();
    try {
      const payload = await readTablePayload(file);
      const r = await sendAcademyOp<AcademyTableImportResult>({
        key: k,
        method: 'POST',
        url: `/api/admin/academy/courses/${courseId}/questions/import`,
        body: { clientKey: k, ...payload, status: 'draft' },
        summary: `从表格「${file.name}」导题`,
      });
      toast({ tone: 'success', title: `导入了 ${r.questions.length} 道草稿题`, body: '审过、改过再启用' });
      await refresh();
    } catch (e) {
      setImportProblems(problemsOf(e));
      toast({ tone: 'error', title: '没导进去', body: errorMessage(e) });
    } finally {
      setImporting(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };
  const columns: DataColumn<AcademyQuestion>[] = [
    { key: 'stem', header: '题干', cell: (q) => <span className="line-clamp-2 text-[14px]">{q.stem}</span> },
    { key: 'kind', header: '题型', cell: (q) => ACADEMY_QUESTION_KIND_LABELS[q.kind] },
    { key: 'skill', header: '知识点', cell: (q) => q.skill },
    { key: 'level', header: '难度', numeric: true, cell: (q) => q.level },
    { key: 'source', header: '来源', cell: (q) => ACADEMY_QUESTION_SOURCE_LABELS[q.source] },
    { key: 'status', header: '状态', cell: (q) => <Badge tone={q.status === 'active' ? 'pine' : q.status === 'draft' ? 'yuzu' : 'neutral'}>{ACADEMY_QUESTION_STATUS_LABELS[q.status]}</Badge> },
  ];
  return (
    <Card className="p-4" data-testid="academy-question-bank">
      <SectionTitle
        aside={
          <div className="flex flex-wrap gap-2">
            <input ref={fileRef} type="file" accept=".xlsx,.csv" className="hidden" onChange={(e) => e.target.files?.[0] && void importFile(e.target.files[0])} data-testid="academy-question-file" />
            <Button size="sm" icon={<FileUp className="size-3.5" />} loading={importing} onClick={() => fileRef.current?.click()}>
              从表格导入
            </Button>
            <Button size="sm" icon={<Plus className="size-3.5" />} onClick={() => setOpen('new')} data-testid="academy-add-question">
              加题
            </Button>
          </div>
        }
      >
        题库
      </SectionTitle>
      <p className="mt-1 text-[12px] text-ink-3">
        能进测验的启用客观题 {quizzable} 道{needed > quizzable ? `，测验每次要抽 ${needed} 道，还差 ${needed - quizzable} 道` : ''}
        。表格的表头写「题干、选项A…、答案、解析、知识点、难度」；只有「问题、答案」两列的导成问答卡。
      </p>
      {importProblems.length > 0 && (
        <Notice tone="error" title="表格里有不对的行，整批没导" className="mt-2">
          <ul className="mt-1 space-y-0.5 text-[13px]">
            {importProblems.slice(0, 10).map((p, i) => (
              <li key={i}>
                {p.row ? `第 ${p.row} 行：` : ''}
                {p.message}
              </li>
            ))}
          </ul>
        </Notice>
      )}
      <DataTable
        className="mt-3"
        variant="plain"
        columns={columns}
        rows={questions.data}
        rowKey={(q) => q.id}
        onRowClick={(q) => setOpen(q)}
        failed={questions.isError && !questions.data}
        onRetry={() => void questions.refetch()}
        empty="题库还是空的"
        emptyDescription="加题、AI 出题或从表格导入"
      />
      {open && <QuestionDialog courseId={courseId} question={open === 'new' ? null : open} onClose={() => setOpen(null)} onSaved={refresh} />}
    </Card>
  );
}
