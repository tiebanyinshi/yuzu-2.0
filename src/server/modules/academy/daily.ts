// 学堂 · 每日一练（docs/ACADEMY.md 第 5、7.2 节，PENDING_DECISIONS XT07）：
//   · 每天 10 题：先出到期该复习的卡（下次复习日已到），再补新题（每天最多 5 道；来自我已经开始学的课、被指派到的课里启用的题）；
//   · 客观题自动判对错（答错评 1、答对评 3）；问答卡看完答案自己评 1–4；
//   · 每答一题都记卡（FSRS）与掌握度（BKT）；当天答够 10 题（或今天已经没有可练的题）给 1 学分、记连续天数；
//   · 作答带操作编号：没收到结果原样重提返回第一次的结果。加锁：学员咨询锁 → 卡 → 掌握度 → 学分。

import { z } from 'zod';
import { ACADEMY_DAILY_CREDITS, ACADEMY_DAILY_NEW_MAX, ACADEMY_DAILY_TARGET, type AcademyDaily, type AcademyDailyAnswer, type AcademyDailyItem } from '@shared/academy';
import type { FsrsGrade } from '@shared/academy-algo';
import type { AcademyQuestionKind } from '@shared/academy-markup';
import { shiftDate } from '@shared/labels';
import type { Db, Sql } from '../../db';
import { badRequest, conflict } from '../../lib/errors';
import { withTx } from '../../lib/tx';
import { parse } from '../../lib/validate';
import { assignmentMatches, courseListed, type Learner } from './learner';
import { recordPractice, sameChoice } from './memory';
import { awardCredits, lockLearner } from './progress';

/** 营业日 → 学分流水的编号（yyyymmdd） */
const dayNo = (date: string) => Number(date.replaceAll('-', ''));

interface Candidate {
  questionId: number;
  kind: AcademyQuestionKind;
  stem: string;
  options: string[];
  answer: number[];
  answerText: string;
  explanation: string;
  skill: string;
  courseTitle: string;
  isNew: boolean;
  version: number;
}

const CANDIDATE_COLS = (db: Db) => db`q.id AS question_id, q.kind, q.stem, q.options, q.answer, q.answer_text, q.explanation, q.skill, c.title AS course_title, q.version`;

/** 我「在学」的课：学过任何一个课时的、被指派到的（直接或在指派的地图里） */
const studyingCourses = (db: Db, l: Learner) => db`
  SELECT l2.course_id FROM academy_progress pr JOIN academy_lessons l2 ON l2.id = pr.lesson_id WHERE pr.staff_id = ${l.id}
  UNION SELECT COALESCE(a.course_id, pc.course_id) FROM academy_assignments a LEFT JOIN academy_path_courses pc ON pc.path_id = a.path_id
  WHERE ${assignmentMatches(db, l)}`;

async function todayStats(db: Db, staffId: number, today: string) {
  const [r] = await db<{ done: number; fresh: number; credited: boolean }[]>`
    SELECT count(*)::int AS done, count(*) FILTER (WHERE was_new)::int AS fresh,
      EXISTS (SELECT 1 FROM academy_credits WHERE staff_id = ${staffId} AND reason = 'daily' AND ref_no = ${dayNo(today)}) AS credited
    FROM academy_reviews WHERE staff_id = ${staffId} AND reviewed_on = ${today} AND source = 'daily'`;
  return r!;
}

/** 今天还能练的题：到期的卡（今天在每日一练里练过的不再出）+ 新题（今天的新题名额以内） */
async function candidates(db: Db, l: Learner, today: string, limit: number, freshLeft: number): Promise<Candidate[]> {
  if (limit <= 0) return [];
  const due = await db<Omit<Candidate, 'isNew'>[]>`
    SELECT ${CANDIDATE_COLS(db)} FROM academy_cards k
    JOIN academy_questions q ON q.id = k.question_id JOIN academy_courses c ON c.id = q.course_id
    WHERE k.staff_id = ${l.id} AND k.due_on <= ${today} AND q.status = 'active' AND ${courseListed(db, l)}
      AND NOT EXISTS (SELECT 1 FROM academy_reviews r WHERE r.staff_id = ${l.id} AND r.question_id = q.id AND r.reviewed_on = ${today} AND r.source = 'daily')
    ORDER BY k.due_on, k.stability, q.id LIMIT ${limit}`;
  const room = Math.min(limit - due.length, freshLeft);
  const fresh =
    room > 0
      ? await db<Omit<Candidate, 'isNew'>[]>`
          SELECT ${CANDIDATE_COLS(db)} FROM academy_questions q JOIN academy_courses c ON c.id = q.course_id
          WHERE q.status = 'active' AND ${courseListed(db, l)} AND c.id IN (${studyingCourses(db, l)})
            AND NOT EXISTS (SELECT 1 FROM academy_cards k WHERE k.staff_id = ${l.id} AND k.question_id = q.id)
          ORDER BY c.sort, c.id, q.level, q.id LIMIT ${room}`
      : [];
  return [...due.map((d) => ({ ...d, isNew: false })), ...fresh.map((f) => ({ ...f, isNew: true }))].map((c) => ({ ...c, questionId: Number(c.questionId) }));
}

/** 连续几天完成了每日一练（今天没完成的从昨天往前数） */
async function streakOf(db: Db, staffId: number, today: string): Promise<number> {
  const days = new Set(
    (await db<{ refNo: number }[]>`SELECT ref_no FROM academy_credits WHERE staff_id = ${staffId} AND reason = 'daily' AND ref_no <= ${dayNo(today)} ORDER BY ref_no DESC LIMIT 400`).map((r) =>
      Number(r.refNo),
    ),
  );
  let day = days.has(dayNo(today)) ? today : shiftDate(today, -1);
  let n = 0;
  while (days.has(dayNo(day))) {
    n += 1;
    day = shiftDate(day, -1);
  }
  return n;
}

export async function dailySet(db: Db, l: Learner, today: string): Promise<AcademyDaily> {
  const stats = await todayStats(db, l.id, today);
  const items = await candidates(db, l, today, ACADEMY_DAILY_TARGET - stats.done, ACADEMY_DAILY_NEW_MAX - stats.fresh);
  return {
    today,
    target: ACADEMY_DAILY_TARGET,
    doneToday: stats.done,
    items: items.map(
      (c): AcademyDailyItem => ({
        questionId: c.questionId,
        kind: c.kind,
        stem: c.stem,
        options: c.options,
        skill: c.skill,
        courseTitle: c.courseTitle,
        isNew: c.isNew,
        answerText: c.kind === 'recall' ? c.answerText : null,
        version: Number(c.version),
      }),
    ),
    streak: await streakOf(db, l.id, today),
    credited: stats.credited,
  };
}

export const dailyStreak = streakOf;

const AnswerInput = z.object({
  clientKey: z.uuid('操作编号不正确'),
  questionId: z.number().int().positive(),
  choice: z.array(z.number().int().min(0).max(5)).max(6).optional(),
  grade: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]).optional(),
  /** 页面上显示的是这道题的哪一版（管理员改过选项、答案的拒绝，免得按旧题判新答案，Codex 审查 4c50670） */
  version: z.number().int().positive(),
});

/** 答一题 */
export async function answerDaily(sql: Sql, l: Learner, raw: unknown, today: string): Promise<AcademyDailyAnswer> {
  const input = parse(AnswerInput, raw);
  return withTx(sql, async (tx) => {
    await lockLearner(tx, l.id);
    const [had] = await tx<{ staffId: number; questionId: number; grade: FsrsGrade; correct: boolean | null; dueOn: string }[]>`
      SELECT staff_id, question_id, grade, correct, due_on FROM academy_reviews WHERE client_key = ${input.clientKey}`;
    const stats = await todayStats(tx, l.id, today);
    const pool = had ? [] : await candidates(tx, l, today, ACADEMY_DAILY_TARGET - stats.done, ACADEMY_DAILY_NEW_MAX - stats.fresh);
    if (had) {
      if (Number(had.staffId) !== l.id || Number(had.questionId) !== input.questionId) throw conflict('IDEMPOTENCY_CONFLICT', '这个操作编号已用于另一题，请刷新');
      const [q] = await tx<Candidate[]>`SELECT q.id AS question_id, q.answer, q.answer_text, q.explanation FROM academy_questions q WHERE q.id = ${input.questionId}`;
      return {
        questionId: input.questionId,
        correct: had.correct,
        grade: had.grade,
        answer: q!.answer,
        answerText: q!.answerText,
        explanation: q!.explanation,
        dueOn: had.dueOn,
        doneToday: stats.done,
        target: ACADEMY_DAILY_TARGET,
        credits: 0,
      };
    }
    const q = pool.find((c) => c.questionId === input.questionId);
    if (!q) throw conflict('ACADEMY_DAILY_GONE', '这道题今天已经练过或不在今天的题里，请刷新');
    if (Number(q.version) !== input.version) throw conflict('ACADEMY_CHANGED', '这道题刚被改过，请刷新再练');
    let grade: FsrsGrade;
    let correct: boolean | null;
    if (q.kind === 'recall') {
      if (!input.grade) throw badRequest('问答卡看完答案，评一下记得怎么样（1–4）');
      grade = input.grade;
      correct = null;
    } else {
      if (!input.choice?.length) throw badRequest('请选答案');
      correct = sameChoice(input.choice, q.answer);
      grade = correct ? 3 : 1;
    }
    const { dueOn } = await recordPractice(tx, l.id, { questionId: q.questionId, kind: q.kind, skill: q.skill, grade, correct, source: 'daily', clientKey: input.clientKey, today });
    const doneToday = stats.done + 1;
    // 答够了，或今天已经没有别的题可练：给今天的学分
    const finished = doneToday >= ACADEMY_DAILY_TARGET || pool.length <= 1;
    const credits = finished ? await awardCredits(tx, l.id, ACADEMY_DAILY_CREDITS, 'daily', dayNo(today), `每日一练 ${today}`) : 0;
    return { questionId: q.questionId, correct, grade, answer: q.answer, answerText: q.answerText, explanation: q.explanation, dueOn, doneToday, target: ACADEMY_DAILY_TARGET, credits };
  });
}
