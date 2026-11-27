// 学堂 · 题库与测验（docs/ACADEMY.md 第 5 节，PENDING_DECISIONS XT03）：
//   · 题库（管理端）：题挂在课上；新建带操作编号、修改带版本；AI 出的、表格导入的先是草稿，人审过才启用；
//   · 测验：开卷时按掌握度从这门课启用的客观题里抽（薄弱的知识点先抽，知识点轮流抽），题目当场存快照；
//     交卷带同一份卷子的编号，已交过的原样返回第一次的结果；及格了这一课时完成（学分只给一次）；
//     每道题都记进每日一练的卡（FSRS）与知识点掌握度（BKT）。
//   · 加锁：学员咨询锁 → 卷子一行 → 卡 / 掌握度 → 进度 → 学分（与 progress.ts 同一把学员锁）。

import { z } from 'zod';
import { ACADEMY_QUESTION_STATUS_LABELS, type AcademyQuestion, type AcademyQuizQuestion, type AcademyQuizResult, type AcademyQuizView } from '@shared/academy';
import { BKT, type FsrsGrade } from '@shared/academy-algo';
import { academyQuestionProblems, ACADEMY_QUESTION_KINDS, type AcademyQuestionKind } from '@shared/academy-markup';
import type { Db, Sql, Tx } from '../../db';
import { writeAudit } from '../../lib/audit';
import type { OpContext } from '../../lib/context';
import { badRequest, conflict, forbidden, notFound, unprocessable } from '../../lib/errors';
import { withTx } from '../../lib/tx';
import { parse } from '../../lib/validate';
import type { Learner } from './learner';
import { recordPractice, sameChoice } from './memory';
import { lessonForProgress, lockLearner, markComplete } from './progress';

// ───────────────────────── 题库（管理端） ─────────────────────────

const QuestionInput = z.object({
  clientKey: z.uuid('操作编号不正确').optional(),
  kind: z.enum(ACADEMY_QUESTION_KINDS as [AcademyQuestionKind, ...AcademyQuestionKind[]], '题型不正确'),
  skill: z.string().trim().min(1, '请填写知识点').max(30, '知识点最多 30 个字'),
  level: z.union([z.literal(1), z.literal(2), z.literal(3)]).default(1),
  stem: z.string().trim().min(1, '请填写题干').max(300, '题干最多 300 个字'),
  options: z.array(z.string().trim().max(120)).max(6).default([]),
  answer: z.array(z.number().int().min(0).max(5)).max(6).default([]),
  answerText: z.string().trim().max(500).default(''),
  explanation: z.string().trim().max(500).default(''),
  status: z.enum(['draft', 'active', 'retired']).default('active'),
});
const QuestionUpdate = QuestionInput.omit({ clientKey: true }).extend({ version: z.number().int().positive() });

interface QuestionRow {
  id: number;
  courseId: number;
  packKey: string | null;
  skill: string;
  kind: AcademyQuestionKind;
  level: 1 | 2 | 3;
  stem: string;
  options: string[];
  answer: number[];
  answerText: string;
  explanation: string;
  source: AcademyQuestion['source'];
  status: AcademyQuestion['status'];
  version: number;
}
const QUESTION_COLS = (db: Db) => db`id, course_id, pack_key, skill, kind, level, stem, options, answer, answer_text, explanation, source, status, version`;
const toQuestion = (r: QuestionRow): AcademyQuestion => ({ ...r, id: Number(r.id), courseId: Number(r.courseId) });

function checkQuestion(input: z.infer<typeof QuestionInput>) {
  const q = { ...input, options: input.kind === 'recall' ? [] : input.options, answer: input.kind === 'recall' ? [] : input.answer };
  const problems = academyQuestionProblems(q);
  if (problems.length) throw unprocessable('ACADEMY_QUESTION_INVALID', problems[0]!, { problems });
  return q;
}

export async function adminQuestions(db: Db, courseId: number): Promise<AcademyQuestion[]> {
  const rows = await db<QuestionRow[]>`SELECT ${QUESTION_COLS(db)} FROM academy_questions WHERE course_id = ${courseId} ORDER BY status = 'retired', id`;
  return rows.map(toQuestion);
}

export async function createQuestion(sql: Sql, courseId: number, raw: unknown, ctx: OpContext): Promise<AcademyQuestion> {
  const input = parse(QuestionInput, raw);
  const q = checkQuestion(input);
  return withTx(sql, async (tx) => {
    const [c] = await tx`SELECT id FROM academy_courses WHERE id = ${courseId} FOR UPDATE`;
    if (!c) throw notFound('没有这门课');
    if (input.clientKey) {
      const [had] = await tx<QuestionRow[]>`SELECT ${QUESTION_COLS(tx)} FROM academy_questions WHERE client_key = ${input.clientKey}`;
      if (had) {
        if (Number(had.courseId) !== courseId || had.stem !== q.stem) throw conflict('IDEMPOTENCY_CONFLICT', '这个操作编号已用于另一道题，请刷新后重新填写');
        return toQuestion(had);
      }
    }
    const [row] = await tx<QuestionRow[]>`
      INSERT INTO academy_questions (course_id, skill, kind, level, stem, options, answer, answer_text, explanation, source, status, client_key, created_by)
      VALUES (${courseId}, ${q.skill}, ${q.kind}, ${q.level}, ${q.stem}, ${tx.json(q.options)}, ${tx.json(q.answer)}, ${q.answerText}, ${q.explanation},
              'manual', ${q.status}, ${input.clientKey ?? null}, ${ctx.actor.id})
      RETURNING ${QUESTION_COLS(tx)}`;
    await writeAudit(tx, {
      staffId: ctx.actor.id,
      action: 'academy_question_saved',
      targetType: 'academy_question',
      targetId: Number(row!.id),
      detail: { summary: `加了一道题「${q.stem.slice(0, 30)}」` },
      ip: ctx.ip,
    });
    return toQuestion(row!);
  });
}

export async function updateQuestion(sql: Sql, id: number, raw: unknown, ctx: OpContext): Promise<AcademyQuestion> {
  const input = parse(QuestionUpdate, raw);
  const q = checkQuestion(input);
  return withTx(sql, async (tx) => {
    const [had] = await tx<QuestionRow[]>`SELECT ${QUESTION_COLS(tx)} FROM academy_questions WHERE id = ${id} FOR UPDATE`;
    if (!had) throw notFound('没有这道题');
    const same =
      had.kind === q.kind &&
      had.skill === q.skill &&
      had.level === q.level &&
      had.stem === q.stem &&
      JSON.stringify(had.options) === JSON.stringify(q.options) &&
      JSON.stringify(had.answer) === JSON.stringify(q.answer) &&
      had.answerText === q.answerText &&
      had.explanation === q.explanation &&
      had.status === q.status;
    if (had.version !== input.version) {
      if (same) return toQuestion(had);
      throw conflict('ACADEMY_CHANGED', '这道题刚被别人改过，请刷新后再改');
    }
    const [row] = await tx<QuestionRow[]>`
      UPDATE academy_questions SET skill = ${q.skill}, kind = ${q.kind}, level = ${q.level}, stem = ${q.stem}, options = ${tx.json(q.options)},
        answer = ${tx.json(q.answer)}, answer_text = ${q.answerText}, explanation = ${q.explanation}, status = ${q.status}, version = version + 1, updated_at = now()
      WHERE id = ${id} RETURNING ${QUESTION_COLS(tx)}`;
    await tx`UPDATE academy_courses SET local_edited = local_edited OR pack_hash IS NOT NULL WHERE id = ${had.courseId}`;
    const what = had.status !== q.status ? `把题「${q.stem.slice(0, 30)}」改成${ACADEMY_QUESTION_STATUS_LABELS[q.status]}` : `修改了题「${q.stem.slice(0, 30)}」`;
    await writeAudit(tx, { staffId: ctx.actor.id, action: 'academy_question_saved', targetType: 'academy_question', targetId: id, detail: { summary: what }, ip: ctx.ip });
    return toQuestion(row!);
  });
}

// ───────────────────────── 测验 ─────────────────────────

interface Snapshot {
  id: number;
  kind: AcademyQuestionKind;
  skill: string;
  stem: string;
  options: string[];
  answer: number[];
  explanation: string;
}

/** 按掌握度抽题：知识点按掌握度从低到高排，每个知识点里的题打乱，知识点轮流抽，直到够数；最后整份打乱 */
export function pickQuestions<T extends { skill: string }>(pool: T[], mastery: Map<string, number>, count: number, random = Math.random): T[] {
  const bySkill = new Map<string, T[]>();
  for (const q of pool) bySkill.set(q.skill, [...(bySkill.get(q.skill) ?? []), q]);
  const shuffle = <X>(xs: X[]) => {
    const a = [...xs];
    for (let i = a.length - 1; i > 0; i -= 1) {
      const j = Math.floor(random() * (i + 1));
      [a[i], a[j]] = [a[j]!, a[i]!];
    }
    return a;
  };
  const skills = [...bySkill.keys()].sort((a, b) => (mastery.get(a) ?? BKT.initial) - (mastery.get(b) ?? BKT.initial) || a.localeCompare(b));
  const queues = skills.map((s) => shuffle(bySkill.get(s)!));
  const out: T[] = [];
  while (out.length < count && queues.some((q) => q.length)) for (const q of queues) if (q.length && out.length < count) out.push(q.shift()!);
  return shuffle(out);
}

async function quizLesson(db: Db, l: Learner, lessonId: number) {
  const lesson = await lessonForProgress(db, l, lessonId);
  if (lesson.kind !== 'quiz') throw badRequest('这个课时不是测验');
  if (!lesson.active || lesson.courseStatus !== 'published') throw conflict('ACADEMY_PREVIEW_ONLY', '草稿或下架的课只能预览，不能考');
  const [q] = await db<{ quizCount: number; quizPass: number }[]>`SELECT quiz_count, quiz_pass FROM academy_lessons WHERE id = ${lessonId}`;
  return { ...lesson, quizCount: q!.quizCount, quizPass: q!.quizPass };
}

const toView = (a: { id: number; lessonId: number; passPct: number; questions: Snapshot[]; submittedAt: string | null }): AcademyQuizView => ({
  attemptId: Number(a.id),
  lessonId: Number(a.lessonId),
  passPct: a.passPct,
  questions: a.questions.map((q): AcademyQuizQuestion => ({ id: q.id, kind: q.kind, stem: q.stem, options: q.options })),
  submitted: a.submittedAt !== null,
});

/** 开一份测验（带操作编号：没收到结果原样重提返回同一份卷子） */
export async function startQuiz(sql: Sql, l: Learner, lessonId: number, clientKey: string): Promise<AcademyQuizView> {
  const lesson = await quizLesson(sql, l, lessonId);
  return withTx(sql, async (tx) => {
    await lockLearner(tx, l.id);
    const [had] = await tx<{ id: number; staffId: number; lessonId: number; passPct: number; questions: Snapshot[]; submittedAt: string | null }[]>`
      SELECT id, staff_id, lesson_id, pass_pct, questions, submitted_at FROM academy_attempts WHERE client_key = ${clientKey}`;
    if (had) {
      if (Number(had.staffId) !== l.id || Number(had.lessonId) !== lessonId) throw conflict('IDEMPOTENCY_CONFLICT', '这个操作编号已用于另一份卷子，请重新开始');
      return toView(had);
    }
    const pool = await tx<Snapshot[]>`
      SELECT id, kind, skill, stem, options, answer, explanation FROM academy_questions
      WHERE course_id = ${lesson.courseId} AND status = 'active' AND kind <> 'recall' ORDER BY id`;
    if (!pool.length) throw conflict('ACADEMY_NO_QUESTIONS', '这门课的题库还没有能考的题，请联系学堂管理员');
    const mastery = new Map((await tx<{ skill: string; pKnown: number }[]>`SELECT skill, p_known FROM academy_mastery WHERE staff_id = ${l.id}`).map((m) => [m.skill, m.pKnown] as const));
    const picked = pickQuestions(
      pool.map((q) => ({ ...q, id: Number(q.id) })),
      mastery,
      lesson.quizCount,
    );
    const [a] = await tx<{ id: number }[]>`
      INSERT INTO academy_attempts (staff_id, lesson_id, client_key, questions, pass_pct, total)
      VALUES (${l.id}, ${lessonId}, ${clientKey}, ${tx.json(picked as never)}, ${lesson.quizPass}, ${picked.length})
      RETURNING id`;
    return toView({ id: Number(a!.id), lessonId, passPct: lesson.quizPass, questions: picked, submittedAt: null });
  });
}

interface AttemptRow {
  id: number;
  staffId: number;
  lessonId: number;
  passPct: number;
  total: number;
  questions: Snapshot[];
  answers: number[][] | null;
  correct: number | null;
  score: number | null;
  passed: boolean | null;
}

function resultOf(a: AttemptRow, completion: AcademyQuizResult['completion']): AcademyQuizResult {
  const answers = a.answers ?? [];
  return {
    attemptId: Number(a.id),
    lessonId: Number(a.lessonId),
    score: a.score ?? 0,
    correct: a.correct ?? 0,
    total: a.total,
    passed: !!a.passed,
    passPct: a.passPct,
    items: a.questions.map((q, i) => ({
      questionId: q.id,
      kind: q.kind,
      stem: q.stem,
      options: q.options,
      answer: q.answer,
      chosen: answers[i] ?? [],
      correct: sameChoice(answers[i] ?? [], q.answer),
      explanation: q.explanation,
    })),
    completion,
  };
}

const SubmitInput = z.object({ answers: z.array(z.array(z.number().int().min(0).max(5)).max(6)).max(50) });

/** 交卷：已交过的原样返回第一次的结果；及格了这一课时完成 */
export async function submitQuiz(sql: Sql, l: Learner, attemptId: number, raw: unknown, today: string): Promise<AcademyQuizResult> {
  const { answers } = parse(SubmitInput, raw);
  return withTx(sql, async (tx) => {
    await lockLearner(tx, l.id);
    const [a] = await tx<AttemptRow[]>`
      SELECT id, staff_id, lesson_id, pass_pct, total, questions, answers, correct, score, passed FROM academy_attempts WHERE id = ${attemptId} FOR UPDATE`;
    if (!a || Number(a.staffId) !== l.id) throw notFound('没有这份卷子');
    if (a.answers) return resultOf(a, null);
    if (answers.length !== a.questions.length) throw badRequest(`这份卷子有 ${a.questions.length} 道题，交上来的是 ${answers.length} 道`);
    const correct = a.questions.filter((q, i) => sameChoice(answers[i]!, q.answer)).length;
    const score = Math.round((correct / a.questions.length) * 100);
    const passed = score >= a.passPct;
    const [done] = await tx<AttemptRow[]>`
      UPDATE academy_attempts SET answers = ${tx.json(answers)}, correct = ${correct}, score = ${score}, passed = ${passed}, submitted_at = now()
      WHERE id = ${attemptId} RETURNING id, staff_id, lesson_id, pass_pct, total, questions, answers, correct, score, passed`;
    for (const [i, q] of a.questions.entries()) {
      const right = sameChoice(answers[i]!, q.answer);
      await recordPractice(tx, l.id, { questionId: q.id, kind: q.kind, skill: q.skill, grade: (right ? 3 : 1) as FsrsGrade, correct: right, source: 'quiz', clientKey: null, today });
    }
    let completion: AcademyQuizResult['completion'] = null;
    if (passed) {
      const [lesson] = await tx<{ id: number; courseId: number; title: string; credits: number }[]>`SELECT id, course_id, title, credits FROM academy_lessons WHERE id = ${a.lessonId}`;
      completion = await markComplete(tx, l.id, { id: Number(lesson!.id), courseId: Number(lesson!.courseId), title: lesson!.title, credits: lesson!.credits }, today);
    }
    return resultOf(done!, completion);
  });
}

/** 看一份交过的卷子（自己的；管理权限看谁的都行） */
export async function quizResult(db: Db, l: Learner, attemptId: number): Promise<AcademyQuizResult> {
  const [a] = await db<AttemptRow[]>`
    SELECT id, staff_id, lesson_id, pass_pct, total, questions, answers, correct, score, passed FROM academy_attempts WHERE id = ${attemptId}`;
  if (!a || (Number(a.staffId) !== l.id && !l.canManage)) throw notFound('没有这份卷子');
  if (!a.answers) throw forbidden('这份卷子还没交');
  return resultOf(a, null);
}

/** 测验课时：我最好的一次、这门课能抽的题数（课时页用） */
export async function quizSummary(db: Db | Tx, staffId: number, lessonId: number, courseId: number) {
  const [best] = await db<{ score: number; passed: boolean }[]>`
    SELECT score, passed FROM academy_attempts WHERE staff_id = ${staffId} AND lesson_id = ${lessonId} AND submitted_at IS NOT NULL
    ORDER BY score DESC, id LIMIT 1`;
  const [n] = await db<{ n: number }[]>`SELECT count(*)::int AS n FROM academy_questions WHERE course_id = ${courseId} AND status = 'active' AND kind <> 'recall'`;
  return { quizBest: best ?? null, quizAvailable: n!.n };
}
