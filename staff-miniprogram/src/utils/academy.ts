// 汤崎学堂（员工小程序线 F，docs/STAFF_MP.md 第 2.3、5.3 节）：内容、规则、学分都归主线的学堂（docs/ACADEMY.md），
// 员工小程序端口把学堂的员工端接口原样挂上（/api/staffmp/academy/…）。这里只有调接口与把回包变成页面要画的样子：
//   · 课件的块由门店系统用学堂自己的解析解析好了带回来（StaffMpAcademyLesson.blocks），这里只把 **加粗** 切开、加上作答的样子；
//   · 文字（分类、课时种类、等级）与学堂的一样，tests/academy.test.ts 核对两边一字不差。

import type {
  AcademyAssigned,
  AcademyCategory,
  AcademyCompletion,
  AcademyCourseDetail,
  AcademyCourseSummary,
  AcademyDaily,
  AcademyDailyAnswer,
  AcademyHome,
  AcademyLessonKind,
  AcademyLessonSummary,
  AcademyMe,
  AcademyPathDetail,
  AcademyPathSummary,
  AcademyQuizResult,
  AcademyQuizView,
} from '../../../src/shared/academy';
import type { AcademyBlock, AcademyQuestionKind } from '../../../src/shared/academy-markup';
import type { StaffMpAcademyLesson } from '../../../src/shared/staffmp';
import { call } from './api';

// ── 接口（员工小程序端口上的 /api/staffmp/academy/…）──

export const loadAcademyHome = () => call<AcademyHome>('GET', '/academy/home');
export const loadDaily = () => call<AcademyDaily>('GET', '/academy/daily');
export const loadCourses = (category: AcademyCategory | '') => call<AcademyCourseSummary[]>('GET', `/academy/courses${category ? `?category=${category}` : ''}`);
export const searchCourses = (q: string) => call<AcademyCourseSummary[]>('GET', `/academy/courses?q=${encodeURIComponent(q)}`);
export const loadCourse = (id: number) => call<AcademyCourseDetail>('GET', `/academy/courses/${id}`);
export const loadPath = (id: number) => call<AcademyPathDetail>('GET', `/academy/paths/${id}`);
export const loadLesson = (id: number) => call<StaffMpAcademyLesson>('GET', `/academy/lessons/${id}`);
export const pingLesson = (id: number, seconds: number) => call<{ added: number }>('POST', `/academy/lessons/${id}/ping`, { seconds });
export const loadQuizResult = (attemptId: number) => call<AcademyQuizResult>('GET', `/academy/attempts/${attemptId}`);

/** 学习时长一次最多报几秒（学堂那边封顶 600 秒，这里每 30 秒报一次） */
export const PING_SECONDS = 30;

// ── 文字（与 src/shared/academy.ts 一样）──

export const CATEGORY_LABELS: Record<AcademyCategory, string> = {
  culture: '汤崎之道',
  must_know: '应知应会',
  industry: '行业通识',
  skill: '岗位技能',
  system: '系统小课堂',
  safety: '安全',
  management: '管理',
};

export const KIND_LABELS: Record<AcademyLessonKind, string> = { article: '图文课件', file: '视频 / 文件', quiz: '测验', practical: '实操签核' };

/** 汤主题的六级（学堂 XT05）：学分到了门槛就升级 */
export const LEVELS: readonly { level: number; title: string; min: number }[] = [
  { level: 1, title: '初试水温', min: 0 },
  { level: 2, title: '温汤渐暖', min: 60 },
  { level: 3, title: '汤中好手', min: 150 },
  { level: 4, title: '独当一面', min: 300 },
  { level: 5, title: '汤崎匠人', min: 500 },
  { level: 6, title: '一代宗师', min: 800 },
];

/** 问答卡自评的四档（FSRS 的 1–4） */
export const GRADES: readonly { grade: 1 | 2 | 3 | 4; label: string }[] = [
  { grade: 1, label: '忘了' },
  { grade: 2, label: '模糊' },
  { grade: 3, label: '记得' },
  { grade: 4, label: '很熟' },
];

const monthDay = (date: string) => `${Number(date.slice(5, 7))} 月 ${Number(date.slice(8, 10))} 日`;

// ── 首页 ──

export interface LevelView {
  title: string;
  credits: string;
  /** 离下一级还差多少（满级写「已满级」） */
  next: string;
  /** 这一级里走了百分之几（0–100） */
  pct: number;
  minutes: string;
}

export function levelView(me: AcademyMe): LevelView {
  const pct = me.nextLevel ? Math.max(0, Math.min(100, Math.round(((me.credits - me.level.min) / (me.nextLevel.min - me.level.min)) * 100))) : 100;
  return {
    title: `LV${me.level.level} · ${me.level.title}`,
    credits: `${me.credits} 学分`,
    next: me.nextLevel ? `再 ${me.nextLevel.min - me.credits} 分升「${me.nextLevel.title}」` : '已满级',
    pct,
    minutes: `本月学了 ${Math.round(me.monthSeconds / 60)} 分钟`,
  };
}

export interface AssignedRow {
  key: string;
  kind: 'path' | 'course';
  id: number;
  title: string;
  sub: string;
  required: boolean;
  overdue: boolean;
  completed: boolean;
}

/** 我的必修 / 推荐：完成到哪、什么时候截止（逾期的标出来），学完的排后面 */
export function assignedRows(list: readonly AcademyAssigned[]): AssignedRow[] {
  const rows = list.map((a) => {
    const progress = a.completed ? '已学完' : `完成 ${a.done}/${a.total}`;
    const due = a.dueOn && !a.completed ? ` · ${monthDay(a.dueOn)}${a.overdue ? '已过截止' : '截止'}` : '';
    return {
      key: `${a.kind}-${a.id}`,
      kind: a.kind,
      id: a.id,
      title: a.title,
      sub: `${a.kind === 'path' ? '学习地图' : '课程'} · ${progress}${due}`,
      required: a.required,
      overdue: a.overdue && !a.completed,
      completed: a.completed,
    };
  });
  return rows.filter((r) => !r.completed).concat(rows.filter((r) => r.completed));
}

export interface PathRow {
  id: number;
  title: string;
  sub: string;
  done: boolean;
}

export function pathRow(p: AcademyPathSummary): PathRow {
  const done = p.courseCount > 0 && p.doneCount >= p.courseCount;
  return { id: p.id, title: p.title, sub: `${p.courseCount} 个阶段 · ${done ? '已学完' : `完成 ${p.doneCount}/${p.courseCount}`} · ${p.credits} 学分`, done };
}

export interface CategoryRow {
  category: AcademyCategory;
  label: string;
  sub: string;
}

export function categoryRows(list: AcademyHome['categories']): CategoryRow[] {
  return list.filter((c) => c.count > 0).map((c) => ({ category: c.category, label: CATEGORY_LABELS[c.category] ?? c.category, sub: `${c.count} 门课` }));
}

export function dailyLine(d: Pick<AcademyDaily, 'doneToday' | 'target' | 'streak'>): string {
  const today = d.doneToday >= d.target ? '今天做完了' : `今天 ${d.doneToday}/${d.target}`;
  return d.streak > 0 ? `${today} · 连续 ${d.streak} 天` : today;
}

// ── 课程与课时 ──

export interface CourseRow {
  id: number;
  title: string;
  sub: string;
  progress: string;
  done: boolean;
}

export function courseRow(c: AcademyCourseSummary): CourseRow {
  const done = c.lessonCount > 0 && c.doneCount >= c.lessonCount;
  return {
    id: c.id,
    title: c.title,
    sub: `${CATEGORY_LABELS[c.category] ?? ''} · ${c.lessonCount} 节 · 约 ${c.minutes} 分钟 · ${c.credits} 学分`,
    progress: done ? '已学完' : c.doneCount > 0 ? `已学 ${c.doneCount}/${c.lessonCount}` : '',
    done,
  };
}

export interface LessonRow {
  id: number;
  title: string;
  sub: string;
  state: string;
  done: boolean;
}

const STATE_LABELS = { todo: '', started: '学过一点', done: '已完成' } as const;

export function lessonRow(l: AcademyLessonSummary): LessonRow {
  const what = l.kind === 'quiz' && l.quiz ? `测验 · 每次 ${l.quiz.count} 题、${l.quiz.pass} 分及格` : `${KIND_LABELS[l.kind]} · 约 ${l.minutes} 分钟`;
  return { id: l.id, title: `${l.seq}. ${l.title}`, sub: `${what} · ${l.credits} 学分`, state: STATE_LABELS[l.state], done: l.state === 'done' };
}

/** 学完一个课时（或测验及格）以后给人看的一句：几分、这门课 / 哪张地图学完了、升级了 */
export function completionText(c: AcademyCompletion | null): string {
  if (!c) return '';
  const parts = [c.credits > 0 ? `+${c.credits} 学分` : '这一节以前学完过，不再加学分'];
  if (c.courseCompleted) parts.push('这门课学完了');
  for (const p of c.pathsCompleted) parts.push(`学完了「${p.title}」${p.certNo ? `，证书 ${p.certNo}` : ''}`);
  if (c.levelUp) parts.push(`升到 LV${c.levelUp.level}「${c.levelUp.title}」`);
  return parts.join('；');
}

// ── 课件的块 ──

export interface Seg {
  text: string;
  bold: boolean;
}

/** 正文里的 **加粗** 切成一段段（与学堂网页的 splitBold 同一个写法） */
export function segs(text: string): Seg[] {
  const out: Seg[] = [];
  const re = /\*\*(.+?)\*\*/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push({ text: text.slice(last, m.index), bold: false });
    out.push({ text: m[1]!, bold: true });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last), bold: false });
  return out;
}

export interface QuestionView {
  kind: AcademyQuestionKind;
  stem: string;
  options: string[];
  answer: number[];
  answerText: string;
  explanation: string;
  multi: boolean;
}

export type BlockView =
  | { i: number; type: 'heading'; text: string }
  | { i: number; type: 'paragraph'; segs: Seg[] }
  | { i: number; type: 'list'; ordered: boolean; items: Seg[][] }
  | { i: number; type: 'quote'; segs: Seg[] }
  | { i: number; type: 'callout'; tone: 'tip' | 'warn' | 'ban'; title: string; lines: { segs: Seg[]; bullet: boolean }[] }
  | { i: number; type: 'steps'; title: string; steps: { no: number; title: string; detail: string }[] }
  | { i: number; type: 'cards'; title: string; cards: { front: string; back: string; flipped: boolean }[] }
  | { i: number; type: 'table'; title: string; head: string[]; rows: string[][] }
  | { i: number; type: 'scenario'; title: string; situation: string; options: { text: string; feedback: string; best: boolean }[]; picked: number }
  | { i: number; type: 'question'; check: boolean; q: QuestionView; st: QuestionState };

/** 课中小测的作答：选了哪几个、亮出答案没有（亮出以后对不对、每个选项的样子） */
export interface QuestionState {
  chosen: number[];
  revealed: boolean;
  correct: boolean | null;
  opts: OptionView[];
}

export function questionState(q: QuestionView, chosen: number[], revealed: boolean): QuestionState {
  return { chosen, revealed, correct: revealed && q.kind !== 'recall' ? sameChoice(chosen, q.answer) : null, opts: optionViews(q.options, chosen, revealed ? q.answer : null) };
}

const CALLOUT_TITLES = { tip: '要点', warn: '注意', ban: '禁忌' } as const;

function questionView(q: { kind: AcademyQuestionKind; stem: string; options: string[]; answer: number[]; answerText: string; explanation: string }): QuestionView {
  return { kind: q.kind, stem: q.stem, options: q.options, answer: q.answer, answerText: q.answerText, explanation: q.explanation, multi: q.kind === 'multi' };
}

/**
 * 课件的块 → 页面要画的样子。「:::question」是题库题（进测验、每日一练），学堂网页的课件页不画，这里也不画、不算课中小测；
 * 课中小测只有「:::check」
 */
export function blockViews(blocks: readonly AcademyBlock[]): BlockView[] {
  const out: BlockView[] = [];
  // i 是在画出来的这一串里的位置（页面按它改某一块：blocks[i]）
  for (const b of blocks) {
    const v = blockView(b, out.length);
    if (v) out.push(v);
  }
  return out;
}

function blockView(b: AcademyBlock, i: number): BlockView | null {
  switch (b.type) {
    case 'heading':
      return { i, type: 'heading', text: b.text };
    case 'paragraph':
      return { i, type: 'paragraph', segs: segs(b.text) };
    case 'list':
      return { i, type: 'list', ordered: b.ordered, items: b.items.map(segs) };
    case 'quote':
      return { i, type: 'quote', segs: segs(b.text) };
    case 'callout':
      return { i, type: 'callout', tone: b.tone, title: b.title || CALLOUT_TITLES[b.tone], lines: b.lines.map((l) => ({ segs: segs(l.text), bullet: l.bullet })) };
    case 'steps':
      return { i, type: 'steps', title: b.title, steps: b.steps.map((s, n) => ({ no: n + 1, title: s.title, detail: s.detail })) };
    case 'cards':
      return { i, type: 'cards', title: b.title, cards: b.cards.map((c) => ({ front: c.front, back: c.back, flipped: false })) };
    case 'table':
      return { i, type: 'table', title: b.title, head: b.head, rows: b.rows };
    case 'scenario':
      return { i, type: 'scenario', title: b.title, situation: b.situation, options: b.options, picked: -1 };
    case 'check': {
      const q = questionView(b.question);
      return { i, type: 'question', check: true, q, st: questionState(q, [], false) };
    }
    case 'question':
      return null;
  }
}

/** 课中小测还有几道没答（学堂第 4 节：图文课件读到最后、课中小测答过才算学完；没答完不给点「学完了」） */
export function unansweredCount(views: readonly BlockView[]): number {
  return views.filter((v) => v.type === 'question' && !v.st.revealed).length;
}

// ── 作答（课中小测、测验、每日一练共用）──

/** 点一个选项：单选、判断换成这一个；多选加上或去掉 */
export function toggleChoice(chosen: readonly number[], option: number, multi: boolean): number[] {
  if (!multi) return [option];
  return chosen.indexOf(option) >= 0 ? chosen.filter((c) => c !== option) : chosen.concat(option).sort((a, b) => a - b);
}

export function sameChoice(a: readonly number[], b: readonly number[]): boolean {
  if (a.length !== b.length) return false;
  const x = a.slice().sort((m, n) => m - n);
  const y = b.slice().sort((m, n) => m - n);
  return x.every((v, k) => v === y[k]);
}

export interface OptionView {
  text: string;
  /** 选中没有；交了以后：对的、选错的 */
  chosen: boolean;
  right: boolean;
  wrong: boolean;
}

/** 选项的样子：没交的只标选中；交了的标出对的与选错的 */
export function optionViews(options: readonly string[], chosen: readonly number[], answer: readonly number[] | null): OptionView[] {
  return options.map((text, k) => {
    const isChosen = chosen.indexOf(k) >= 0;
    const isAnswer = !!answer && answer.indexOf(k) >= 0;
    return { text, chosen: isChosen, right: !!answer && isAnswer, wrong: !!answer && isChosen && !isAnswer };
  });
}

/** 测验：每题都选了才能交 */
export function quizReady(questions: readonly AcademyQuizView['questions'][number][], answers: readonly (readonly number[])[]): boolean {
  return questions.length > 0 && questions.every((_, k) => (answers[k]?.length ?? 0) > 0);
}

export function quizResultLine(r: Pick<AcademyQuizResult, 'score' | 'passed' | 'passPct' | 'correct' | 'total'>): string {
  return `${r.score} 分 · 答对 ${r.correct}/${r.total} · ${r.passed ? '及格了' : `${r.passPct} 分及格，再来一次`}`;
}

export function dailyAnswerLine(a: Pick<AcademyDailyAnswer, 'correct' | 'dueOn'>, today: string): string {
  const head = a.correct === null ? '记下了' : a.correct ? '答对了' : '答错了';
  return `${head} · ${a.dueOn <= today ? '今天还会再出' : `${monthDay(a.dueOn)}再复习`}`;
}
