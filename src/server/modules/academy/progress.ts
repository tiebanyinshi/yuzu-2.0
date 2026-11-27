// 学堂 · 员工端的写（docs/ACADEMY.md 第 4、5 节，PENDING_DECISIONS XT04）：报学习时长、完成课时、学分、地图完成、课程评分。
// 加锁顺序（LOCKING.md「学堂」）：学员咨询锁（同一个人的学习写入串行）→ 进度一行 → 学分流水（唯一约束兜底，同一件事只给一次）。
// 草稿、下架的课只能预览（管理员），不记进度、不给学分。

import { academyLevelOf, type AcademyCompletion } from '@shared/academy';
import type { Db, Sql, Tx } from '../../db';
import { conflict, forbidden, notFound } from '../../lib/errors';
import { withTx } from '../../lib/tx';
import { courseDone } from './catalog';
import { assertCourseOpen, type Learner } from './learner';

/** 同一个学员的学习写入（完成课时、交卷、每日一练、报时长）串行：先取这把咨询锁 */
export async function lockLearner(tx: Tx, staffId: number) {
  await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`academy_learner:${staffId}`}, 0))`;
}

/** 两次上报之间最多认多少秒（页面每分钟报一次；多报的按真实间隔封顶） */
export const ACADEMY_PING_MAX_SECONDS = 120;

export interface LessonForProgress {
  id: number;
  courseId: number;
  title: string;
  kind: 'article' | 'file' | 'quiz' | 'practical';
  credits: number;
  active: boolean;
  courseStatus: string;
}

/** 读一个课时（核对能打开）；不加锁 */
export async function lessonForProgress(db: Db, l: Learner, lessonId: number): Promise<LessonForProgress> {
  const [row] = await db<LessonForProgress[]>`
    SELECT l.id, l.course_id, l.title, l.kind, l.credits, l.active, c.status AS course_status
    FROM academy_lessons l JOIN academy_courses c ON c.id = l.course_id WHERE l.id = ${lessonId}`;
  if (!row) throw notFound('没有这个课时');
  await assertCourseOpen(db, l, Number(row.courseId));
  return { ...row, id: Number(row.id), courseId: Number(row.courseId) };
}

/** 能不能记进度：上架的课里、上架的课时 */
const recordable = (lesson: LessonForProgress) => lesson.active && lesson.courseStatus === 'published';

/** 报一次学习时长（页面在前台、打开着课时，每分钟一次；第一次打开报 0 记「开始学」） */
export async function pingLesson(sql: Sql, l: Learner, lessonId: number, seconds: number, today: string): Promise<{ added: number }> {
  const lesson = await lessonForProgress(sql, l, lessonId);
  if (!recordable(lesson)) return { added: 0 };
  return withTx(sql, async (tx) => {
    await lockLearner(tx, l.id);
    // 同一个人同时开着几个课时（几台设备）：按这个人所有课时里最近一次上报算间隔，同一段时间不重复计（Codex 审查 dd885a6）
    const [any] = await tx<{ elapsed: number | null }[]>`
      SELECT floor(EXTRACT(EPOCH FROM now() - max(last_ping_at)))::int AS elapsed FROM academy_progress WHERE staff_id = ${l.id}`;
    const [row] = await tx<{ elapsed: number | null }[]>`
      SELECT floor(EXTRACT(EPOCH FROM now() - last_ping_at))::int AS elapsed
      FROM academy_progress WHERE staff_id = ${l.id} AND lesson_id = ${lessonId} FOR UPDATE`;
    let added = 0;
    if (!row) {
      await tx`INSERT INTO academy_progress (staff_id, lesson_id, last_ping_at) VALUES (${l.id}, ${lessonId}, now())`;
    } else {
      const lessonGap = row.elapsed ?? 0;
      const learnerGap = any!.elapsed ?? lessonGap;
      added = row.elapsed === null ? 0 : Math.max(0, Math.min(seconds, lessonGap + 5, learnerGap + 5, ACADEMY_PING_MAX_SECONDS));
      await tx`UPDATE academy_progress SET seconds = seconds + ${added}, last_ping_at = now() WHERE staff_id = ${l.id} AND lesson_id = ${lessonId}`;
    }
    if (added > 0) {
      await tx`
        INSERT INTO academy_study_days (staff_id, day, seconds) VALUES (${l.id}, ${today}, ${added})
        ON CONFLICT (staff_id, day) DO UPDATE SET seconds = academy_study_days.seconds + EXCLUDED.seconds`;
    }
    return { added };
  });
}

const creditsOf = async (tx: Tx, staffId: number) => (await tx<{ total: number }[]>`SELECT COALESCE(sum(points), 0)::int AS total FROM academy_credits WHERE staff_id = ${staffId}`)[0]!.total;

/** 记一笔学分（同一人同一件事只给一次）；返回实际给了几分 */
export async function awardCredits(tx: Tx, staffId: number, points: number, reason: 'lesson' | 'daily' | 'path', refNo: number, note: string): Promise<number> {
  if (points <= 0) return 0;
  const rows = await tx`
    INSERT INTO academy_credits (staff_id, points, reason, ref_no, note) VALUES (${staffId}, ${points}, ${reason}, ${refNo}, ${note.slice(0, 80)})
    ON CONFLICT (staff_id, reason, ref_no) DO NOTHING RETURNING id`;
  return rows.length ? points : 0;
}

async function courseCompleted(tx: Tx, staffId: number, courseId: number): Promise<boolean> {
  const [r] = await tx<{ done: boolean }[]>`
    SELECT count(*) > 0 AND count(*) = count(pr.completed_at) AS done
    FROM academy_lessons l LEFT JOIN academy_progress pr ON pr.lesson_id = l.id AND pr.staff_id = ${staffId}
    WHERE l.course_id = ${courseId} AND l.active`;
  return r!.done;
}

/** 一张地图上架的课都完成了（没有上架的课不算完成） */
async function pathCompleted(tx: Tx, staffId: number, pathId: number): Promise<boolean> {
  const [r] = await tx<{ done: boolean }[]>`
    SELECT count(*) > 0 AND bool_and(${courseDone(tx, staffId)}) AS done
    FROM academy_path_courses pc JOIN academy_courses c ON c.id = pc.course_id
    WHERE pc.path_id = ${pathId} AND c.status = 'published'`;
  return !!r!.done;
}

/**
 * 结算这位学员已经学完、还没记下的地图（调用方已取学员咨询锁）：记「学完了」（只追加，同一人同一张地图一行），给地图学分。
 * pathIds 只看这几张（为空看全部上架的）。地图后来才上架、加了已经学完的课时也能补上（Codex 审查 dd885a6）。
 */
export async function settlePaths(tx: Tx, staffId: number, pathIds: number[] | null, today: string): Promise<AcademyCompletion['pathsCompleted']> {
  if (pathIds && !pathIds.length) return [];
  const paths = await tx<{ id: number; title: string; credits: number }[]>`
    SELECT p.id, p.title, p.credits FROM academy_paths p
    WHERE p.status = 'published' ${pathIds ? tx`AND p.id IN ${tx(pathIds)}` : tx``}
      AND NOT EXISTS (SELECT 1 FROM academy_path_completions x WHERE x.staff_id = ${staffId} AND x.path_id = p.id)
    ORDER BY p.id`;
  const out: AcademyCompletion['pathsCompleted'] = [];
  for (const path of paths) {
    if (!(await pathCompleted(tx, staffId, Number(path.id)))) continue;
    await tx`INSERT INTO academy_path_completions (staff_id, path_id, completed_on) VALUES (${staffId}, ${path.id}, ${today})`;
    const got = await awardCredits(tx, staffId, path.credits, 'path', Number(path.id), path.title);
    out.push({ id: Number(path.id), title: path.title, credits: got });
  }
  return out;
}

/** 管理员上架地图、改了阶段：给已经学完的人补记（地图一行已锁；按员工编号顺序逐个取学员锁） */
export async function settlePathForAll(tx: Tx, pathId: number, today: string) {
  const staff = await tx<{ staffId: number }[]>`
    SELECT DISTINCT pr.staff_id FROM academy_progress pr JOIN academy_lessons l ON l.id = pr.lesson_id
    JOIN academy_path_courses pc ON pc.course_id = l.course_id
    WHERE pc.path_id = ${pathId} AND pr.completed_at IS NOT NULL ORDER BY pr.staff_id`;
  for (const { staffId } of staff) {
    await lockLearner(tx, Number(staffId));
    await settlePaths(tx, Number(staffId), [pathId], today);
  }
}

/**
 * 记一个课时完成（调用方已取学员咨询锁）：第一次完成给这一课时的学分；这门课学完了的，结算它所在的上架地图（地图学分）。
 * 已经完成过的不再给课时学分（重学、重考不刷分，XT04），但照样结算一次地图（之前漏记的补上）。
 */
export async function markComplete(tx: Tx, staffId: number, lesson: Pick<LessonForProgress, 'id' | 'courseId' | 'title' | 'credits'>, today: string): Promise<AcademyCompletion> {
  const [p] = await tx<{ completedAt: string | null }[]>`
    SELECT completed_at FROM academy_progress WHERE staff_id = ${staffId} AND lesson_id = ${lesson.id} FOR UPDATE`;
  const before = await creditsOf(tx, staffId);
  let credits = 0;
  if (!p?.completedAt) {
    if (p) await tx`UPDATE academy_progress SET completed_at = now() WHERE staff_id = ${staffId} AND lesson_id = ${lesson.id}`;
    else await tx`INSERT INTO academy_progress (staff_id, lesson_id, completed_at) VALUES (${staffId}, ${lesson.id}, now())`;
    credits = await awardCredits(tx, staffId, lesson.credits, 'lesson', lesson.id, lesson.title);
  }
  const done = await courseCompleted(tx, staffId, lesson.courseId);
  const pathsCompleted = done
    ? await settlePaths(
        tx,
        staffId,
        (await tx<{ pathId: number }[]>`SELECT path_id FROM academy_path_courses WHERE course_id = ${lesson.courseId}`).map((r) => Number(r.pathId)),
        today,
      )
    : [];
  credits += pathsCompleted.reduce((n, x) => n + x.credits, 0);
  const was = academyLevelOf(before).current;
  const now = academyLevelOf(before + credits).current;
  return { lessonId: lesson.id, credits, courseCompleted: done && !p?.completedAt, pathsCompleted, levelUp: now.level > was.level ? now : null };
}

/** 图文课件读完、文件看过：员工自己点「学完了」（测验要及格、实操要带教签，走各自的路） */
export async function completeLesson(sql: Sql, l: Learner, lessonId: number, today: string): Promise<AcademyCompletion> {
  const lesson = await lessonForProgress(sql, l, lessonId);
  if (lesson.kind === 'quiz') throw conflict('ACADEMY_LESSON_NEEDS_QUIZ', '测验要答完、及格才算完成');
  if (lesson.kind === 'practical') throw conflict('ACADEMY_LESSON_NEEDS_SIGNOFF', '实操要带教在岗看过、签「通过」才算完成');
  if (!recordable(lesson)) throw conflict('ACADEMY_PREVIEW_ONLY', '草稿或下架的课只能预览，不记学习进度');
  return withTx(sql, async (tx) => {
    await lockLearner(tx, l.id);
    return markComplete(tx, l.id, lesson, today);
  });
}

/** 课程评分（柯氏一级评估）：学完这门课才能评，可以改 */
export async function rateCourse(sql: Sql, l: Learner, courseId: number, input: { rating: number; comment: string }) {
  await assertCourseOpen(sql, l, courseId);
  return withTx(sql, async (tx) => {
    await lockLearner(tx, l.id);
    if (!(await courseCompleted(tx, l.id, courseId))) throw forbidden('学完这门课再评分');
    await tx`
      INSERT INTO academy_feedback (staff_id, course_id, rating, comment) VALUES (${l.id}, ${courseId}, ${input.rating}, ${input.comment})
      ON CONFLICT (staff_id, course_id) DO UPDATE SET rating = EXCLUDED.rating, comment = EXCLUDED.comment, updated_at = now()`;
    return { rating: input.rating, comment: input.comment };
  });
}
