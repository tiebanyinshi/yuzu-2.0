// 学堂 · 员工端的读（docs/ACADEMY.md 第 4、8 节）：课程、课时、学习地图、我的必修与首页。
// 进度一律按「上架的课时」算：一门课的上架课时都完成就算完成；一张地图的课都完成就算完成。

import {
  academyDueOn,
  academyLevelOf,
  ACADEMY_CATEGORIES,
  type AcademyAssigned,
  type AcademyCategory,
  type AcademyCourseDetail,
  type AcademyCourseSummary,
  type AcademyCover,
  type AcademyHome,
  type AcademyLessonKind,
  type AcademyLessonState,
  type AcademyLessonSummary,
  type AcademyLessonView,
  type AcademyMe,
  type AcademyPathDetail,
  type AcademyPathSummary,
  type AcademyStatus,
} from '@shared/academy';
import type { Db, Fragment } from '../../db';
import { forbidden, notFound } from '../../lib/errors';
import { DEFAULT_STORE_ID } from '../../lib/store-context';
import { assertCourseOpen, assignmentMatches, courseListed, type Learner } from './learner';

// ───────────────────────── 课程 ─────────────────────────

interface CourseRow {
  id: number;
  code: string | null;
  title: string;
  summary: string;
  category: AcademyCategory;
  departmentKey: string | null;
  deptOnly: boolean;
  cover: AcademyCover;
  status: AcademyStatus;
  sort: number;
  version: number;
  lessonCount: number;
  doneCount: number;
  minutes: number;
  credits: number;
  ratingAvg: number | null;
  ratingCount: number;
}

/** 课程列表的一行：上架课时数、我完成的数、时长、学分、评分（staffId 为空时不算「我完成的」） */
export const courseSelect = (db: Db, staffId: number | null, extra: Fragment = db``) => db`
  c.id, c.code, c.title, c.summary, c.category, c.department_key, c.dept_only, c.cover, c.status, c.sort, c.version,
  st.lesson_count, st.done_count, st.minutes, st.credits, fb.rating_avg, fb.rating_count ${extra}
  FROM academy_courses c
  LEFT JOIN LATERAL (
    SELECT count(*)::int AS lesson_count, count(pr.completed_at)::int AS done_count,
           COALESCE(sum(l.minutes), 0)::int AS minutes, COALESCE(sum(l.credits), 0)::int AS credits
    FROM academy_lessons l LEFT JOIN academy_progress pr ON pr.lesson_id = l.id AND pr.staff_id = ${staffId}
    WHERE l.course_id = c.id AND l.active) st ON true
  LEFT JOIN LATERAL (
    SELECT round(avg(f.rating)::numeric, 1)::float8 AS rating_avg, count(*)::int AS rating_count
    FROM academy_feedback f WHERE f.course_id = c.id) fb ON true`;

export const toCourse = (r: CourseRow): AcademyCourseSummary => ({
  id: Number(r.id),
  code: r.code,
  title: r.title,
  summary: r.summary,
  category: r.category,
  departmentKey: r.departmentKey,
  deptOnly: r.deptOnly,
  cover: r.cover,
  status: r.status,
  sort: r.sort,
  lessonCount: r.lessonCount,
  doneCount: r.doneCount,
  minutes: r.minutes,
  credits: r.credits,
  rating: r.ratingCount ? { avg: Number(r.ratingAvg), count: r.ratingCount } : null,
  version: r.version,
});

export async function listCourses(db: Db, l: Learner, filter: { category?: AcademyCategory; q?: string }): Promise<AcademyCourseSummary[]> {
  const q = filter.q?.trim();
  const rows = await db<CourseRow[]>`
    SELECT ${courseSelect(db, l.id)}
    WHERE ${courseListed(db, l)}
      ${filter.category ? db`AND c.category = ${filter.category}` : db``}
      ${q ? db`AND (strpos(c.title, ${q}) > 0 OR strpos(c.summary, ${q}) > 0)` : db``}
    ORDER BY c.sort, c.id`;
  return rows.map(toCourse);
}

interface LessonRow {
  id: number;
  courseId: number;
  seq: number;
  title: string;
  kind: AcademyLessonKind;
  minutes: number;
  credits: number;
  active: boolean;
  quizCount: number | null;
  quizPass: number | null;
  fileId: number | null;
  startedAt: string | null;
  completedAt: string | null;
}

export const lessonSelect = (db: Db, staffId: number | null, extra: Fragment = db``) => db`
  l.id, l.course_id, l.seq, l.title, l.kind, l.minutes, l.credits, l.active, l.quiz_count, l.quiz_pass, l.file_id,
  pr.started_at, pr.completed_at ${extra}
  FROM academy_lessons l LEFT JOIN academy_progress pr ON pr.lesson_id = l.id AND pr.staff_id = ${staffId}`;

export const toLesson = (r: LessonRow): AcademyLessonSummary => ({
  id: Number(r.id),
  courseId: Number(r.courseId),
  seq: r.seq,
  title: r.title,
  kind: r.kind,
  minutes: r.minutes,
  credits: r.credits,
  active: r.active,
  state: lessonState(r),
  quiz: r.quizCount && r.quizPass ? { count: r.quizCount, pass: r.quizPass } : null,
  fileId: r.fileId === null ? null : Number(r.fileId),
});

const lessonState = (r: { startedAt: string | null; completedAt: string | null }): AcademyLessonState => (r.completedAt ? 'done' : r.startedAt ? 'started' : 'todo');

export async function courseDetail(db: Db, l: Learner, id: number): Promise<AcademyCourseDetail> {
  await assertCourseOpen(db, l, id);
  const [row] = await db<CourseRow[]>`SELECT ${courseSelect(db, l.id)} WHERE c.id = ${id}`;
  const lessons = await db<LessonRow[]>`SELECT ${lessonSelect(db, l.id)} WHERE l.course_id = ${id} AND (l.active OR ${l.canManage}) ORDER BY l.seq, l.id`;
  const [fb] = await db<{ rating: number; comment: string }[]>`SELECT rating, comment FROM academy_feedback WHERE staff_id = ${l.id} AND course_id = ${id}`;
  const paths = await db<{ id: number; title: string }[]>`
    SELECT p.id, p.title FROM academy_path_courses pc JOIN academy_paths p ON p.id = pc.path_id
    WHERE pc.course_id = ${id} AND p.status = 'published' ORDER BY p.sort, p.id`;
  return { ...toCourse(row!), lessons: lessons.map(toLesson), myFeedback: fb ?? null, paths: paths.map((p) => ({ id: Number(p.id), title: p.title })) };
}

export async function lessonView(db: Db, l: Learner, lessonId: number): Promise<AcademyLessonView> {
  const [row] = await db<(LessonRow & { body: string; seconds: number | null })[]>`
    SELECT ${lessonSelect(db, l.id, db`, l.body, pr.seconds`)} WHERE l.id = ${lessonId}`;
  if (!row) throw notFound('没有这个课时');
  const course = await assertCourseOpen(db, l, Number(row.courseId));
  if (!row.active && !l.canManage) throw forbidden('这个课时已经下架');
  const [c] = await db<{ category: AcademyCategory }[]>`SELECT category FROM academy_courses WHERE id = ${course.id}`;
  const siblings = await db<{ id: number }[]>`SELECT id FROM academy_lessons WHERE course_id = ${course.id} AND (active OR id = ${lessonId}) ORDER BY seq, id`;
  const at = siblings.findIndex((s) => Number(s.id) === lessonId);
  // 文件后来下架了、文件夹停用或改成了只本部门看：不给（页面写「文件暂时打不开」），免得员工点进去被员工培训拦下
  const [file] = row.fileId
    ? await db<{ id: number; folderId: number; title: string }[]>`
        SELECT f.id, f.folder_id, f.title FROM training_files f JOIN training_folders d ON d.id = f.folder_id
        WHERE f.id = ${row.fileId} AND f.active AND d.active AND (d.kind = 'public' OR d.department_key IS NULL)`
    : [];
  return {
    lesson: { ...toLesson(row), body: row.body },
    course: { id: Number(course.id), title: course.title, category: c!.category },
    prevId: at > 0 ? Number(siblings[at - 1]!.id) : null,
    nextId: at >= 0 && at + 1 < siblings.length ? Number(siblings[at + 1]!.id) : null,
    seconds: row.seconds ?? 0,
    file: file ? { id: Number(file.id), folderId: Number(file.folderId), title: file.title } : null,
  };
}

// ───────────────────────── 学习地图 ─────────────────────────

interface PathRow {
  id: number;
  code: string | null;
  title: string;
  summary: string;
  cover: AcademyCover;
  status: AcademyStatus;
  sort: number;
  credits: number;
  validMonths: number | null;
  version: number;
  courseCount: number;
  doneCount: number;
}

/** 一门课（地图阶段 pc 的课）我完成了没有：上架课时 > 0 且都完成 */
export const courseDone = (db: Db, staffId: number | null) => db`(
  SELECT count(*) > 0 AND count(*) = count(pr.completed_at)
  FROM academy_lessons l LEFT JOIN academy_progress pr ON pr.lesson_id = l.id AND pr.staff_id = ${staffId}
  WHERE l.course_id = pc.course_id AND l.active)`;

/** 地图的一行：阶段数（员工看只算上架的课；管理端 staffId 为空，算全部）、我完成的阶段数 */
export const pathSelect = (db: Db, staffId: number | null, extra: Fragment = db``) => db`
  p.id, p.code, p.title, p.summary, p.cover, p.status, p.sort, p.credits, p.valid_months, p.version,
  (SELECT count(*)::int FROM academy_path_courses pc JOIN academy_courses sc ON sc.id = pc.course_id
   WHERE pc.path_id = p.id AND (sc.status = 'published' OR ${staffId === null})) AS course_count,
  (SELECT count(*)::int FROM academy_path_courses pc JOIN academy_courses sc ON sc.id = pc.course_id
   WHERE pc.path_id = p.id AND sc.status = 'published' AND ${courseDone(db, staffId)}) AS done_count ${extra}
  FROM academy_paths p`;

export const toPath = (r: PathRow): AcademyPathSummary => ({
  id: Number(r.id),
  code: r.code,
  title: r.title,
  summary: r.summary,
  cover: r.cover,
  status: r.status,
  sort: r.sort,
  credits: r.credits,
  validMonths: r.validMonths,
  courseCount: r.courseCount,
  doneCount: r.doneCount,
  version: r.version,
});

export async function listPaths(db: Db, l: Learner): Promise<AcademyPathSummary[]> {
  const rows = await db<PathRow[]>`SELECT ${pathSelect(db, l.id)} WHERE p.status = 'published' ORDER BY p.sort, p.id`;
  return rows.map(toPath);
}

export async function pathDetail(db: Db, l: Learner, id: number): Promise<AcademyPathDetail> {
  const [row] = await db<PathRow[]>`SELECT ${pathSelect(db, l.id)} WHERE p.id = ${id}`;
  if (!row) throw notFound('没有这张学习地图');
  if (row.status !== 'published' && !l.canManage) throw forbidden('这张学习地图还没上架');
  // 地图里的课一律列出来（被指派到地图就算被指派到它的课；「只本部门」的课在地图里照样能学）
  const stages = await db<CourseRow[]>`
    SELECT ${courseSelect(db, l.id)} JOIN academy_path_courses pc ON pc.course_id = c.id AND pc.path_id = ${id}
    WHERE c.status = 'published' OR ${l.canManage} ORDER BY pc.seq`;
  return { ...toPath(row), stages: stages.map(toCourse) };
}

// ───────────────────────── 我的必修与推荐 ─────────────────────────

interface AssignedRow {
  pathId: number | null;
  courseId: number | null;
  required: boolean;
  dueDays: number | null;
  startsOn: string;
  title: string;
  cover: AcademyCover;
}

/** 命中我的指派（目标上架的），同一张地图 / 同一门课只算一次：有一条是必修就是必修，截止取必修里最早的 */
export async function myAssigned(db: Db, l: Learner, today: string): Promise<{ required: AcademyAssigned[]; recommended: AcademyAssigned[] }> {
  const rows = await db<AssignedRow[]>`
    SELECT a.path_id, a.course_id, a.required, a.due_days, a.starts_on, COALESCE(p.title, c.title) AS title, COALESCE(p.cover, c.cover) AS cover
    FROM academy_assignments a
    LEFT JOIN academy_paths p ON p.id = a.path_id
    LEFT JOIN academy_courses c ON c.id = a.course_id
    WHERE ${assignmentMatches(db, l)} AND COALESCE(p.status, c.status) = 'published'
    ORDER BY a.id`;
  const byTarget = new Map<string, AcademyAssigned>();
  for (const r of rows) {
    const kind = r.pathId ? 'path' : 'course';
    const id = Number(r.pathId ?? r.courseId);
    const key = `${kind}:${id}`;
    const due = r.required ? academyDueOn(r.startsOn, l.hireDate, r.dueDays) : null;
    const prev = byTarget.get(key);
    if (!prev) {
      byTarget.set(key, { kind, id, title: r.title, cover: r.cover, required: r.required, dueOn: due, overdue: false, done: 0, total: 0, completed: false });
      continue;
    }
    prev.required ||= r.required;
    if (due && (!prev.dueOn || due < prev.dueOn)) prev.dueOn = due;
  }
  const items = [...byTarget.values()];
  const pathIds = items.filter((i) => i.kind === 'path').map((i) => i.id);
  const courseIds = items.filter((i) => i.kind === 'course').map((i) => i.id);
  const pathStats = pathIds.length ? await db<PathRow[]>`SELECT ${pathSelect(db, l.id)} WHERE p.id IN ${db(pathIds)}` : [];
  const courseStats = courseIds.length ? await db<CourseRow[]>`SELECT ${courseSelect(db, l.id)} WHERE c.id IN ${db(courseIds)}` : [];
  for (const i of items) {
    if (i.kind === 'path') {
      const s = pathStats.find((p) => Number(p.id) === i.id);
      i.done = s?.doneCount ?? 0;
      i.total = s?.courseCount ?? 0;
    } else {
      const s = courseStats.find((c) => Number(c.id) === i.id);
      i.done = s?.doneCount ?? 0;
      i.total = s?.lessonCount ?? 0;
    }
    i.completed = i.total > 0 && i.done === i.total;
    i.overdue = !!i.dueOn && !i.completed && i.dueOn < today;
  }
  // 逾期的在前，其次按截止日，没截止的最后
  const order = (a: AcademyAssigned, b: AcademyAssigned) =>
    Number(a.completed) - Number(b.completed) || Number(b.overdue) - Number(a.overdue) || (a.dueOn ?? '9999').localeCompare(b.dueOn ?? '9999') || a.id - b.id;
  return { required: items.filter((i) => i.required).sort(order), recommended: items.filter((i) => !i.required).sort(order) };
}

// ───────────────────────── 我与首页 ─────────────────────────

/** 门店名：员工最近用过的那家；没挂门店的按本店（与登录时的 storeIdsOf 一致） */
export const staffStoreName = (db: Db) => db`COALESCE((
  SELECT st.name FROM staff_stores ss JOIN stores st ON st.id = ss.store_id
  WHERE ss.staff_id = s.id ORDER BY ss.last_used_at DESC NULLS LAST, ss.store_id LIMIT 1), (SELECT name FROM stores WHERE id = ${DEFAULT_STORE_ID}))`;

export async function myProfile(db: Db, l: Learner, today: string): Promise<AcademyMe> {
  const monthStart = `${today.slice(0, 7)}-01`;
  const [r] = await db<
    {
      name: string;
      storeName: string | null;
      departmentName: string | null;
      positionTitle: string | null;
      credits: number;
      seconds: number;
      monthSeconds: number;
      completedLessons: number;
    }[]
  >`
    SELECT s.display_name AS name, ${staffStoreName(db)} AS store_name, d.name AS department_name, pc.title AS position_title,
      (SELECT COALESCE(sum(points), 0)::int FROM academy_credits WHERE staff_id = s.id) AS credits,
      (SELECT COALESCE(sum(seconds), 0)::int FROM academy_study_days WHERE staff_id = s.id) AS seconds,
      (SELECT COALESCE(sum(seconds), 0)::int FROM academy_study_days WHERE staff_id = s.id AND day >= ${monthStart}) AS month_seconds,
      (SELECT count(*)::int FROM academy_progress WHERE staff_id = s.id AND completed_at IS NOT NULL) AS completed_lessons
    FROM staff s LEFT JOIN position_catalog pc ON pc.key = s.position LEFT JOIN org_departments d ON d.key = pc.department
    WHERE s.id = ${l.id}`;
  const level = academyLevelOf(r!.credits);
  return {
    staffId: l.id,
    name: r!.name,
    storeName: r!.storeName,
    departmentName: r!.departmentName,
    positionTitle: r!.positionTitle,
    credits: r!.credits,
    level: level.current,
    nextLevel: level.next,
    seconds: r!.seconds,
    monthSeconds: r!.monthSeconds,
    completedLessons: r!.completedLessons,
  };
}

export async function home(db: Db, l: Learner, today: string): Promise<AcademyHome> {
  const me = await myProfile(db, l, today);
  const assigned = await myAssigned(db, l, today);
  const [resume] = await db<{ lessonId: number; lessonTitle: string; courseId: number; courseTitle: string }[]>`
    SELECT l.id AS lesson_id, l.title AS lesson_title, c.id AS course_id, c.title AS course_title
    FROM academy_progress pr JOIN academy_lessons l ON l.id = pr.lesson_id JOIN academy_courses c ON c.id = l.course_id
    WHERE pr.staff_id = ${l.id} AND pr.completed_at IS NULL AND l.active AND ${courseListed(db, l)}
    ORDER BY GREATEST(pr.started_at, COALESCE(pr.last_ping_at, pr.started_at)) DESC LIMIT 1`;
  const counts = await db<{ category: AcademyCategory; count: number }[]>`
    SELECT c.category, count(*)::int AS count FROM academy_courses c WHERE ${courseListed(db, l)} GROUP BY c.category`;
  return {
    me,
    ...assigned,
    resume: resume ? { lessonId: Number(resume.lessonId), lessonTitle: resume.lessonTitle, courseId: Number(resume.courseId), courseTitle: resume.courseTitle } : null,
    paths: await listPaths(db, l),
    categories: ACADEMY_CATEGORIES.map((category) => ({ category, count: counts.find((c) => c.category === category)?.count ?? 0 })),
    canManage: l.canManage,
  };
}
