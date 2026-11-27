// 汤崎学堂 · 课程与课时（docs/ACADEMY.md 第 4、5 节）：
//   · 课程页：学习任务清单（待学习 / 学习中 / 已完成 / 待考试 / 待签核）、学完评分、问柚子；
//   · 课时页：图文课件（读到底点「学完了」）、文件（在员工培训里看，看过点「学完了」）、测验（抽题作答、交卷看对错与解析）、
//     实操（检查项与带教签过的记录）；学完给学分、学完地图发证书、升级都在页面上提示。

import { useMemo, useRef, useState } from 'react';
import { Link } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Bot, CheckCircle2, ChevronRight, ClipboardCheck, FileText, PenLine, Send, Star } from 'lucide-react';
import {
  ACADEMY_LESSON_KIND_LABELS,
  type AcademyCompletion,
  type AcademyCourseDetail,
  type AcademyLessonSummary,
  type AcademyLessonView,
  type AcademyQuizResult,
  type AcademyQuizView,
  type AcademyTutorAnswer,
  type AcademyTutorView,
} from '@shared/academy';
import { parseAcademyMarkup } from '@shared/academy-markup';
import { api, errorMessage } from '../../lib/api';
import { cn, formatDateTime, uuid } from '../../lib/utils';
import { EmptyState } from '../../components/EmptyState';
import { LoadFailed } from '../../components/LoadFailed';
import { useToast } from '../../components/Toast';
import { Badge, Button, Card, Notice, Skeleton, Textarea } from '../../components/ui';
import { AcademyFrame, AcademyOpsPanel, ProgressBar } from './parts';
import { ArticleView, ChoiceList } from './ArticleView';
import { academyKeys, COVER_CLASS, sendAcademyOp, useAcademyCourse, useAcademyLesson, useAcademyRefresh, useStudyTimer } from './data';

function lessonBadge(l: AcademyLessonSummary) {
  if (l.state === 'done') return <Badge tone="pine">已完成</Badge>;
  if (l.kind === 'quiz') return <Badge tone="yuzu">{l.state === 'started' ? '待及格' : '待考试'}</Badge>;
  if (l.kind === 'practical') return <Badge tone="lake">待签核</Badge>;
  return <Badge tone={l.state === 'started' ? 'yuzu' : 'neutral'}>{l.state === 'started' ? '学习中' : '待学习'}</Badge>;
}

const KIND_ICON = { article: FileText, file: FileText, quiz: PenLine, practical: ClipboardCheck } as const;

export function CoursePage({ id }: { id: number }) {
  const course = useAcademyCourse(id);
  if (course.isError && !course.data)
    return (
      <AcademyFrame title="课程" back={{ to: '/oa/academy', label: '学堂' }}>
        <LoadFailed title="这门课没有取回来" onRetry={() => void course.refetch()}>
          {errorMessage(course.error)}
        </LoadFailed>
      </AcademyFrame>
    );
  if (!course.data)
    return (
      <AcademyFrame title="课程" back={{ to: '/oa/academy', label: '学堂' }}>
        <Skeleton className="h-60" />
      </AcademyFrame>
    );
  const c = course.data;
  const done = c.lessonCount > 0 && c.doneCount === c.lessonCount;
  return (
    <AcademyFrame title={c.title} back={{ to: c.paths[0] ? `/oa/academy/paths/${c.paths[0].id}` : '/oa/academy', label: c.paths[0] ? '地图' : '学堂' }} testId="academy-course-page">
      <AcademyOpsPanel />
      {c.status !== 'published' && <Notice tone="info" title="这门课还没上架：只有学堂管理员能预览，不记学习进度" />}
      <Card className={cn('p-4', COVER_CLASS[c.cover].soft)}>
        <p className="text-[14px] leading-relaxed text-ink-2">{c.summary}</p>
        <div className="mt-3 flex items-center gap-2">
          <ProgressBar done={c.doneCount} total={c.lessonCount} className="flex-1" />
          <span className="text-[13px] font-semibold text-ink-2 tabular-nums" data-testid="academy-course-progress">
            {c.doneCount}/{c.lessonCount}
          </span>
        </div>
        <p className="mt-2 text-[12px] text-ink-3">
          约 {c.minutes} 分钟 · 共 {c.credits} 学分{c.rating ? ` · ${c.rating.count} 人评 ${c.rating.avg} 分` : ''}
        </p>
      </Card>
      <section className="space-y-2" data-testid="academy-lessons">
        <h2 className="text-[16px] font-bold text-ink">学习任务</h2>
        {c.lessons.map((l, i) => {
          const Icon = KIND_ICON[l.kind];
          return (
            <Link key={l.id} to={`/oa/academy/lessons/${l.id}`} className="mo-lift flex items-center gap-3 rounded-lg border border-line bg-card p-3" data-testid={`academy-lesson-${l.id}`}>
              <span className={cn('flex size-9 shrink-0 items-center justify-center rounded-full text-[13px] font-bold', l.state === 'done' ? 'bg-pine text-paper' : 'bg-paper-2 text-ink-3')}>
                {l.state === 'done' ? <CheckCircle2 className="size-5" aria-hidden /> : i + 1}
              </span>
              <div className="min-w-0 flex-1">
                <p className={cn('truncate text-[15px] font-bold', l.active ? 'text-ink' : 'text-ink-4 line-through')}>{l.title}</p>
                <p className="flex items-center gap-1 text-[12px] text-ink-3">
                  <Icon className="size-3.5" aria-hidden />
                  {ACADEMY_LESSON_KIND_LABELS[l.kind]} · {l.minutes} 分钟 · {l.credits} 学分
                </p>
              </div>
              {lessonBadge(l)}
            </Link>
          );
        })}
      </section>
      {done && <RateCourse course={c} />}
      <Tutor courseId={c.id} />
    </AcademyFrame>
  );
}

function RateCourse({ course }: { course: AcademyCourseDetail }) {
  const [rating, setRating] = useState(course.myFeedback?.rating ?? 0);
  const [comment, setComment] = useState(course.myFeedback?.comment ?? '');
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const qc = useQueryClient();
  return (
    <Card className="p-4" data-testid="academy-rate">
      <p className="text-[15px] font-bold text-ink">学完了，给这门课打个分</p>
      <div className="mt-2 flex gap-1" role="radiogroup" aria-label="评分">
        {[1, 2, 3, 4, 5].map((n) => (
          <button key={n} type="button" role="radio" aria-checked={rating === n} aria-label={`${n} 星`} onClick={() => setRating(n)} className="tap relative p-1">
            <Star className={cn('size-7', n <= rating ? 'fill-yuzu text-yuzu' : 'text-line-strong')} aria-hidden />
          </button>
        ))}
      </div>
      <Textarea className="mt-2" rows={2} maxLength={300} placeholder="哪里好、哪里还能改（选填）" value={comment} onChange={(e) => setComment(e.target.value)} />
      <Button
        className="mt-2"
        size="sm"
        variant="primary"
        disabled={!rating}
        loading={busy}
        onClick={async () => {
          setBusy(true);
          try {
            await api.post(`/api/academy/courses/${course.id}/feedback`, { rating, comment });
            toast({ tone: 'success', title: '谢谢你的评分' });
            await qc.invalidateQueries({ queryKey: academyKeys.course(course.id) });
          } catch (e) {
            toast({ tone: 'error', title: '评分没交上', body: errorMessage(e) });
          } finally {
            setBusy(false);
          }
        }}
      >
        {course.myFeedback ? '改评分' : '交评分'}
      </Button>
    </Card>
  );
}

/** 问柚子：只按这门课的课件回答（docs/ACADEMY.md 第 5 节，XT10） */
function Tutor({ courseId }: { courseId: number }) {
  const view = useQuery({ queryKey: academyKeys.tutor(courseId), queryFn: () => api.get<AcademyTutorView>(`/api/academy/courses/${courseId}/tutor`) });
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const qc = useQueryClient();
  const keyRef = useRef<{ key: string; text: string } | null>(null);
  const v = view.data;
  const ask = async () => {
    const question = text.trim();
    if (question.length < 2) return;
    // 同一个问题没收到结果原样重提用同一个编号（不再问一次模型）
    if (!keyRef.current || keyRef.current.text !== question) keyRef.current = { key: uuid(), text: question };
    setBusy(true);
    try {
      await sendAcademyOp<AcademyTutorAnswer>({
        key: keyRef.current.key,
        method: 'POST',
        url: `/api/academy/courses/${courseId}/tutor`,
        body: { clientKey: keyRef.current.key, question },
        summary: `问柚子「${question.slice(0, 20)}」`,
      });
      keyRef.current = null;
      setText('');
      await qc.invalidateQueries({ queryKey: academyKeys.tutor(courseId) });
    } catch (e) {
      toast({ tone: 'error', title: '柚子没答上', body: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card className="p-4" data-testid="academy-tutor">
      <p className="flex items-center gap-1.5 text-[15px] font-bold text-ink">
        <Bot className="size-5 text-lake" aria-hidden />
        问柚子
        {v && <span className="ml-auto text-[12px] font-normal text-ink-3">今天还能问 {Math.max(0, v.limit - v.usedToday)} 次</span>}
      </p>
      <p className="mt-1 text-[12px] text-ink-3">柚子只按这门课的课件回答，课件里没讲到的请问主管。</p>
      {v?.mode === 'off' ? (
        <p className="mt-2 text-[13px] text-ink-4">还没配置模型服务，暂时不能问。</p>
      ) : (
        <div className="mt-2 flex gap-2">
          <Textarea rows={2} maxLength={300} value={text} onChange={(e) => setText(e.target.value)} placeholder="比如：客人晕堂了第一步做什么？" data-testid="academy-tutor-input" />
          <Button variant="primary" icon={<Send className="size-4" />} loading={busy} disabled={text.trim().length < 2} onClick={() => void ask()} data-testid="academy-tutor-send">
            问
          </Button>
        </div>
      )}
      <div className="mt-3 space-y-3">
        {v?.items.map((a) => (
          <div key={a.id} className="space-y-1.5" data-testid="academy-tutor-item">
            <p className="ml-auto w-fit max-w-[85%] rounded-lg rounded-br-sm bg-pine px-3 py-2 text-[14px] text-paper">{a.question}</p>
            <div className="max-w-[92%] rounded-lg rounded-bl-sm bg-paper-2 px-3 py-2 text-[14px] leading-relaxed whitespace-pre-wrap text-ink">
              {a.status === 'done' ? a.answer : a.status === 'answering' ? '柚子想一想…' : (a.error ?? '这次没答上，换个说法再问')}
              {a.sources.length > 0 && <p className="mt-1 text-[12px] text-ink-3">出自：{a.sources.map((s) => s.title).join('、')}</p>}
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}

/** 学完以后的提示：给了几分、学完了哪门课 / 哪张地图（发了证书）、升级 */
function useCompletionToast() {
  const toast = useToast();
  return (c: AcademyCompletion) => {
    const parts = [c.credits ? `得 ${c.credits} 学分` : '这一节之前已经学过'];
    if (c.courseCompleted) parts.push('这门课学完了');
    for (const p of c.pathsCompleted) parts.push(`学完地图「${p.title}」${p.certNo ? `，证书 ${p.certNo}` : ''}`);
    if (c.levelUp) parts.push(`升到 LV${c.levelUp.level}「${c.levelUp.title}」`);
    toast({ tone: 'success', title: c.levelUp ? '升级了！' : '学完了', body: parts.join('；') });
  };
}

export function LessonPage({ id }: { id: number }) {
  const lesson = useAcademyLesson(id);
  const v = lesson.data;
  useStudyTimer(id, !!v && v.lesson.active && (v.lesson.kind === 'article' || v.lesson.kind === 'file'));
  if (lesson.isError && !v)
    return (
      <AcademyFrame title="课时" back={{ to: '/oa/academy', label: '学堂' }}>
        <LoadFailed title="这个课时没有取回来" onRetry={() => void lesson.refetch()}>
          {errorMessage(lesson.error)}
        </LoadFailed>
      </AcademyFrame>
    );
  if (!v)
    return (
      <AcademyFrame title="课时" back={{ to: '/oa/academy', label: '学堂' }}>
        <Skeleton className="h-80" />
      </AcademyFrame>
    );
  return (
    <AcademyFrame title={v.lesson.title} back={{ to: `/oa/academy/courses/${v.course.id}`, label: '课程' }} testId="academy-lesson-page">
      <AcademyOpsPanel />
      <p className="-mt-2 text-[12px] text-ink-3">
        {v.course.title} · {ACADEMY_LESSON_KIND_LABELS[v.lesson.kind]} · 约 {v.lesson.minutes} 分钟 · {v.lesson.credits} 学分
      </p>
      {v.lesson.kind === 'article' && <ArticleLesson view={v} />}
      {v.lesson.kind === 'file' && <FileLesson view={v} />}
      {v.lesson.kind === 'quiz' && <QuizLesson view={v} />}
      {v.lesson.kind === 'practical' && <PracticalLesson view={v} />}
      <div className="flex justify-between gap-2 pt-2">
        {v.prevId ? (
          <Link to={`/oa/academy/lessons/${v.prevId}`} className="text-[14px] font-semibold text-pine">
            上一节
          </Link>
        ) : (
          <span />
        )}
        {v.nextId && (
          <Link to={`/oa/academy/lessons/${v.nextId}`} className="inline-flex items-center text-[14px] font-semibold text-pine" data-testid="academy-next-lesson">
            下一节
            <ChevronRight className="size-4" aria-hidden />
          </Link>
        )}
      </div>
    </AcademyFrame>
  );
}

function DoneButton({ view, label = '学完了' }: { view: AcademyLessonView; label?: string }) {
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const celebrate = useCompletionToast();
  const refresh = useAcademyRefresh();
  if (view.lesson.state === 'done') return <Notice tone="success" title="这一节已经学完" />;
  return (
    <Button
      variant="primary"
      size="lg"
      className="w-full"
      loading={busy}
      data-testid="academy-lesson-done"
      onClick={async () => {
        setBusy(true);
        try {
          celebrate(await api.post<AcademyCompletion>(`/api/academy/lessons/${view.lesson.id}/complete`, {}));
          await refresh();
        } catch (e) {
          toast({ tone: 'error', title: '没记上', body: errorMessage(e) });
        } finally {
          setBusy(false);
        }
      }}
    >
      {label}
    </Button>
  );
}

function ArticleLesson({ view }: { view: AcademyLessonView }) {
  const blocks = useMemo(() => parseAcademyMarkup(view.lesson.body).blocks, [view.lesson.body]);
  return (
    <>
      <Card className="p-4 md:p-6">
        <ArticleView blocks={blocks} />
      </Card>
      <DoneButton view={view} />
    </>
  );
}

function FileLesson({ view }: { view: AcademyLessonView }) {
  if (!view.file) return <Notice tone="warning" title="这个课时的文件暂时打不开，请联系学堂管理员" />;
  return (
    <>
      <Link to={`/oa/training/${view.file.folderId}/${view.file.id}`} className="mo-lift flex items-center gap-3 rounded-lg border border-line bg-card p-4" data-testid="academy-lesson-file">
        <FileText className="size-8 shrink-0 text-lake" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[15px] font-bold text-ink">{view.file.title}</p>
          <p className="text-[12px] text-ink-3">在员工培训里打开（视频、PDF 页面里直接看）</p>
        </div>
        <ChevronRight className="size-4 shrink-0 text-ink-4" aria-hidden />
      </Link>
      <DoneButton view={view} label="看完了" />
    </>
  );
}

function QuizLesson({ view }: { view: AcademyLessonView }) {
  const [quiz, setQuiz] = useState<AcademyQuizView | null>(null);
  const [answers, setAnswers] = useState<number[][]>([]);
  const [result, setResult] = useState<AcademyQuizResult | null>(null);
  const [busy, setBusy] = useState(false);
  const startKey = useRef<string | null>(null);
  const toast = useToast();
  const celebrate = useCompletionToast();
  const refresh = useAcademyRefresh();
  const quizInfo = view.lesson.quiz;
  const start = async () => {
    startKey.current ??= uuid();
    setBusy(true);
    try {
      const q = await sendAcademyOp<AcademyQuizView>({
        key: startKey.current,
        method: 'POST',
        url: `/api/academy/lessons/${view.lesson.id}/quiz`,
        body: { clientKey: startKey.current },
        summary: `开始测验「${view.lesson.title}」`,
      });
      startKey.current = null;
      setQuiz(q);
      setAnswers(q.questions.map(() => []));
      setResult(null);
    } catch (e) {
      toast({ tone: 'error', title: '没开成卷', body: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };
  const submit = async () => {
    if (!quiz) return;
    setBusy(true);
    try {
      // 交卷按卷子编号原样重提：已交过的返回第一次的结果
      const r = await sendAcademyOp<AcademyQuizResult>({
        key: `quiz-${quiz.attemptId}`,
        method: 'POST',
        url: `/api/academy/attempts/${quiz.attemptId}/submit`,
        body: { answers },
        summary: `交卷「${view.lesson.title}」`,
      });
      setResult(r);
      if (r.completion) celebrate(r.completion);
      await refresh();
    } catch (e) {
      toast({ tone: 'error', title: '没交上', body: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };
  if (result)
    return (
      <div className="space-y-3" data-testid="academy-quiz-result">
        <Card className={cn('p-4 text-center', result.passed ? 'bg-pine-tint' : 'bg-clay-soft')}>
          <p className={cn('text-[40px] font-bold tabular-nums', result.passed ? 'text-pine' : 'text-clay')}>{result.score}</p>
          <p className="text-[14px] font-semibold text-ink">
            {result.passed ? '及格了' : `没到 ${result.passPct} 分，再来一次`} · 答对 {result.correct}/{result.total}
          </p>
        </Card>
        {result.items.map((it, i) => (
          <Card key={i} className="p-4">
            <p className="mb-2 text-[15px] font-semibold text-ink">
              {i + 1}. {it.stem}
            </p>
            <ChoiceList q={{ kind: it.kind, options: it.options, answer: it.answer }} chosen={it.chosen} onChange={() => undefined} reveal />
            {it.explanation && <p className="mt-2 text-[14px] text-ink-2">解析：{it.explanation}</p>}
          </Card>
        ))}
        <Button
          className="w-full"
          onClick={() => {
            setQuiz(null);
            setResult(null);
          }}
        >
          {result.passed ? '好的' : '重新考'}
        </Button>
      </div>
    );
  if (quiz)
    return (
      <div className="space-y-3" data-testid="academy-quiz">
        {quiz.questions.map((q, i) => (
          <Card key={q.id} className="p-4">
            <p className="mb-2 text-[15px] font-semibold text-ink">
              {i + 1}. {q.stem}
              {q.kind === 'multi' && <span className="ml-1 text-[12px] text-ink-3">（多选）</span>}
            </p>
            <ChoiceList q={q} chosen={answers[i] ?? []} onChange={(next) => setAnswers((a) => a.map((x, j) => (j === i ? next : x)))} testId={`academy-quiz-q${i}`} />
          </Card>
        ))}
        <Button variant="primary" size="lg" className="w-full" loading={busy} disabled={answers.some((a) => !a.length)} onClick={() => void submit()} data-testid="academy-quiz-submit">
          交卷
        </Button>
      </div>
    );
  return (
    <Card className="space-y-3 p-5 text-center" data-testid="academy-quiz-start">
      <PenLine className="mx-auto size-10 text-yuzu-deep" aria-hidden />
      <p className="text-[15px] text-ink-2">
        每次从题库里抽 {quizInfo?.count ?? 5} 题（会多出你还没掌握的知识点），{quizInfo?.pass ?? 80} 分及格，可以重考；学分只在第一次及格时给。
      </p>
      {view.quizBest && <Badge tone={view.quizBest.passed ? 'pine' : 'clay'}>{`最好成绩 ${view.quizBest.score} 分${view.quizBest.passed ? ' · 已及格' : ''}`}</Badge>}
      {view.quizAvailable === 0 ? (
        <p className="text-[13px] text-ink-4">这门课的题库还没有能考的题。</p>
      ) : (
        <Button variant="primary" size="lg" className="w-full" loading={busy} onClick={() => void start()} data-testid="academy-quiz-begin">
          {view.lesson.state === 'done' ? '再考一次' : '开始测验'}
        </Button>
      )}
    </Card>
  );
}

function PracticalLesson({ view }: { view: AcademyLessonView }) {
  const p = view.practical;
  if (!p) return null;
  return (
    <div className="space-y-3" data-testid="academy-practical">
      <Notice tone="info" title="实操要带教在岗看过、签「通过」才算完成">
        学的时候按下面的检查项练；练好了找本部门的带教（部门负责人）在岗看一遍。
      </Notice>
      <Card className="p-4">
        <p className="mb-2 text-[15px] font-bold text-ink">检查项</p>
        <ol className="list-decimal space-y-1 pl-5 text-[15px] leading-relaxed text-ink-2">
          {p.items.map((it, i) => (
            <li key={i}>{it}</li>
          ))}
        </ol>
      </Card>
      <Card className="p-4">
        <p className="mb-2 text-[15px] font-bold text-ink">带教签核记录</p>
        {p.signoffs.length ? (
          <ul className="space-y-2">
            {p.signoffs.map((s) => (
              <li key={s.id} className="rounded-md bg-paper-2 p-2.5 text-[14px]">
                <span className="flex flex-wrap items-center gap-2">
                  <Badge tone={s.result === 'pass' ? 'pine' : 'ember'}>{s.result === 'pass' ? '通过' : '再练'}</Badge>
                  <span className="text-ink-2">{s.signedByName}</span>
                  <span className="text-[12px] text-ink-3">{formatDateTime(s.signedAt)}</span>
                </span>
                {s.checks.some((c) => !c) && <span className="mt-1 block text-[13px] text-ember-deep">没达标：{p.items.filter((_, i) => !s.checks[i]).join('、')}</span>}
                {s.comment && <span className="mt-1 block text-[13px] text-ink-2">{s.comment}</span>}
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState title="还没有带教签过" art="calm" className="py-4" />
        )}
      </Card>
    </div>
  );
}
