// 学堂 · 记一次作答（docs/ACADEMY.md 第 5、7 节）：测验与每日一练共用。调用方已取学员咨询锁。
//   · FSRS：这道题的卡（没有就新建）→ 新的稳定度、难度、下次复习日；作答流水只追加；
//   · BKT：这道题的知识点的掌握度。客观题按答对没有；问答卡自己评「记得 / 很熟」算答对。

import { bktUpdate, fsrsReview, type FsrsGrade } from '@shared/academy-algo';
import type { AcademyQuestionKind } from '@shared/academy-markup';
import { shiftDate } from '@shared/labels';
import type { Tx } from '../../db';
import { daysBetween } from '../../lib/dates';

export interface PracticeInput {
  questionId: number;
  kind: AcademyQuestionKind;
  skill: string;
  grade: FsrsGrade;
  /** 客观题答对没有；问答卡为空 */
  correct: boolean | null;
  source: 'daily' | 'quiz';
  clientKey: string | null;
  today: string;
}

export async function recordPractice(tx: Tx, staffId: number, input: PracticeInput): Promise<{ dueOn: string; wasNew: boolean }> {
  const [card] = await tx<{ stability: number; difficulty: number; lastReviewOn: string | null }[]>`
    SELECT stability, difficulty, last_review_on FROM academy_cards WHERE staff_id = ${staffId} AND question_id = ${input.questionId} FOR UPDATE`;
  const elapsed = card?.lastReviewOn ? Math.max(0, daysBetween(card.lastReviewOn, input.today)) : 0;
  const next = fsrsReview(card ? { stability: card.stability, difficulty: card.difficulty } : null, input.grade, elapsed);
  const dueOn = shiftDate(input.today, next.intervalDays);
  if (card) {
    await tx`
      UPDATE academy_cards SET stability = ${next.stability}, difficulty = ${next.difficulty}, due_on = ${dueOn}, reps = reps + 1,
        lapses = lapses + ${input.grade === 1 ? 1 : 0}, last_review_on = ${input.today}
      WHERE staff_id = ${staffId} AND question_id = ${input.questionId}`;
  } else {
    await tx`
      INSERT INTO academy_cards (staff_id, question_id, stability, difficulty, due_on, reps, last_review_on)
      VALUES (${staffId}, ${input.questionId}, ${next.stability}, ${next.difficulty}, ${dueOn}, 1, ${input.today})`;
  }
  await tx`
    INSERT INTO academy_reviews (staff_id, question_id, client_key, source, grade, correct, was_new, elapsed_days, stability, difficulty, due_on, reviewed_on)
    VALUES (${staffId}, ${input.questionId}, ${input.clientKey}, ${input.source}, ${input.grade}, ${input.correct}, ${!card}, ${elapsed},
            ${next.stability}, ${next.difficulty}, ${dueOn}, ${input.today})`;
  const right = input.correct ?? input.grade >= 3;
  const [m] = await tx<{ pKnown: number }[]>`SELECT p_known FROM academy_mastery WHERE staff_id = ${staffId} AND skill = ${input.skill} FOR UPDATE`;
  const p = bktUpdate(m ? m.pKnown : null, right, input.kind);
  await tx`
    INSERT INTO academy_mastery (staff_id, skill, p_known, attempts, correct) VALUES (${staffId}, ${input.skill}, ${p}, 1, ${right ? 1 : 0})
    ON CONFLICT (staff_id, skill) DO UPDATE SET p_known = EXCLUDED.p_known, attempts = academy_mastery.attempts + 1,
      correct = academy_mastery.correct + EXCLUDED.correct, updated_at = now()`;
  return { dueOn, wasNew: !card };
}

/** 选项作答是否正确（顺序无关） */
export const sameChoice = (a: readonly number[], b: readonly number[]) => a.length === b.length && [...a].sort((x, y) => x - y).every((v, i) => v === [...b].sort((x, y) => x - y)[i]);
