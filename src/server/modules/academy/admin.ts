// 学堂 · 管理端（docs/ACADEMY.md 第 8 节「WCP 设置 → 学堂」，权限 academy.manage）：课程与课时、学习地图、指派、学习数据。
//   · 新建带操作编号（client_key 唯一）：没收到结果原样重提返回原来那个；同一编号换了内容拒绝；
//   · 修改带版本（乐观并发）：别人先改过拒绝（ACADEMY_CHANGED）；没收到结果原样重提、现在的内容就是要改成的，按改好了算；
//   · 加锁顺序（LOCKING.md「学堂」）：课程一行 → 课时一行；地图一行 → 阶段；指派一行；
//   · 来自内置课件包的课、地图，改过就记 local_edited（再导新版不覆盖）。

import { z } from 'zod';
import {
  academyDueOn,
  ACADEMY_CATEGORIES,
  ACADEMY_COVERS,
  ACADEMY_DEFAULT_CREDITS,
  ACADEMY_LESSON_KINDS,
  ACADEMY_PATH_CREDITS,
  ACADEMY_QUIZ_DEFAULT,
  type AcademyAdminCourse,
  type AcademyAdminLesson,
  type AcademyAdminPath,
  type AcademyAssignmentStat,
  type AcademyLearnerRow,
  type AcademyPersonProgress,
} from '@shared/academy';
import { parseAcademyMarkup } from '@shared/academy-markup';
import type { Db, Sql, Tx } from '../../db';
import { writeAudit } from '../../lib/audit';
import type { OpContext } from '../../lib/context';
import { badRequest, conflict, notFound, unprocessable } from '../../lib/errors';
import { withTx } from '../../lib/tx';
import { parse } from '../../lib/validate';
import { notify, onDuty } from '../oa';
import { courseSelect, lessonSelect, pathSelect, toCourse, toLesson, toPath } from './catalog';

const uuid = z.uuid('操作编号不正确');
const text = (label: string, max: number) => z.string(`请填写${label}`).trim().max(max, `${label}最多 ${max} 个字`);
const title = (max: number) => text('名称', max).min(1, '请填写名称');
const deptKey = z.string().regex(/^[a-z]+$/, '部门不正确');

const CourseInput = z.object({
  clientKey: uuid.optional(),
  title: title(60),
  summary: text('简介', 300).default(''),
  category: z.enum(ACADEMY_CATEGORIES, '分类不正确'),
  departmentKey: deptKey.nullable().default(null),
  deptOnly: z.boolean().default(false),
  cover: z.enum(ACADEMY_COVERS).default('pine'),
  sort: z.number().int().min(0).max(10000).default(100),
});
const CourseUpdate = CourseInput.omit({ clientKey: true }).extend({ status: z.enum(['draft', 'published', 'archived']), version: z.number().int().positive() });

const LessonInput = z.object({
  clientKey: uuid.optional(),
  title: title(60),
  kind: z.enum(ACADEMY_LESSON_KINDS, '课时类型不正确'),
  body: z.string().max(60000, '课件太长（最多 6 万字），拆成几节课').default(''),
  fileId: z.number().int().positive().nullable().default(null),
  quizCount: z.number().int().min(1).max(50).nullable().default(null),
  quizPass: z.number().int().min(1).max(100).nullable().default(null),
  minutes: z.number().int().min(1).max(240).default(5),
  credits: z.number().int().min(0).max(20).nullable().default(null),
});
const LessonUpdate = LessonInput.omit({ clientKey: true }).extend({ active: z.boolean(), version: z.number().int().positive() });
const Reorder = z.object({ lessonIds: z.array(z.number().int().positive()).min(1).max(200) });

const PathInput = z.object({
  clientKey: uuid.optional(),
  title: title(40),
  summary: text('简介', 300).default(''),
  cover: z.enum(ACADEMY_COVERS).default('pine'),
  sort: z.number().int().min(0).max(10000).default(100),
  credits: z.number().int().min(0).max(50).default(ACADEMY_PATH_CREDITS),
  validMonths: z.number().int().min(1).max(60).nullable().default(null),
  courseIds: z.array(z.number().int().positive()).max(30, '一张地图最多 30 个阶段').default([]),
});
const PathUpdate = PathInput.omit({ clientKey: true }).extend({ status: z.enum(['draft', 'published', 'archived']), version: z.number().int().positive() });

const AssignmentInput = z.object({
  clientKey: uuid.optional(),
  pathId: z.number().int().positive().nullable().default(null),
  courseId: z.number().int().positive().nullable().default(null),
  audience: z.enum(['all', 'department', 'position', 'staff']),
  departmentKey: deptKey.nullable().default(null),
  positionKey: z
    .string()
    .regex(/^[a-z]+(\.(lead|staff))?$/, '岗位不正确')
    .nullable()
    .default(null),
  staffId: z.number().int().positive().nullable().default(null),
  required: z.boolean().default(true),
  dueDays: z.number().int().min(1).max(365).nullable().default(null),
});
const AssignmentUpdate = z.object({
  required: z.boolean(),
  dueDays: z.number().int().min(1).max(365).nullable(),
  active: z.boolean(),
  version: z.number().int().positive(),
});

const changed = (what: string) => conflict('ACADEMY_CHANGED', `${what}刚被别人改过，请刷新后再改`);
const sameKey = () => conflict('IDEMPOTENCY_CONFLICT', '这个操作编号已用于内容不同的另一次保存，请刷新后重新填写');

// ───────────────────────── 课程与课时 ─────────────────────────

async function assertDepartment(db: Db, key: string | null) {
  if (key === null) return;
  const [d] = await db`SELECT 1 FROM org_departments WHERE key = ${key}`;
  if (!d) throw badRequest('没有这个部门');
}

export async function adminCourses(db: Db) {
  const rows = await db`SELECT ${courseSelect(db, null)} ORDER BY c.status = 'archived', c.sort, c.id`;
  return rows.map((r) => toCourse(r as never));
}

export async function adminCourse(db: Db, id: number): Promise<AcademyAdminCourse> {
  const [row] = await db`SELECT ${courseSelect(db, null, db`, c.pack_version, c.local_edited`)} WHERE c.id = ${id}`;
  if (!row) throw notFound('没有这门课');
  const lessons = await db`SELECT ${lessonSelect(db, null, db`, l.body, l.version, l.pack_key`)} WHERE l.course_id = ${id} ORDER BY l.seq, l.id`;
  return {
    course: { ...toCourse(row as never), packVersion: row.packVersion ?? null, localEdited: row.localEdited },
    lessons: lessons.map((l) => ({ ...toLesson(l as never), body: l.body, version: l.version, packKey: l.packKey }) satisfies AcademyAdminLesson),
  };
}

export async function createCourse(sql: Sql, raw: unknown, ctx: OpContext) {
  const input = parse(CourseInput, raw);
  await assertDepartment(sql, input.departmentKey);
  if (input.deptOnly && !input.departmentKey) throw badRequest('「只本部门」要先选部门');
  const id = await withTx(sql, async (tx) => {
    if (input.clientKey) {
      const [had] = await tx<{ id: number; title: string; category: string }[]>`SELECT id, title, category FROM academy_courses WHERE client_key = ${input.clientKey}`;
      if (had) {
        if (had.title !== input.title || had.category !== input.category) throw sameKey();
        return Number(had.id);
      }
    }
    const [c] = await tx<{ id: number }[]>`
      INSERT INTO academy_courses (title, summary, category, department_key, dept_only, cover, sort, client_key, created_by)
      VALUES (${input.title}, ${input.summary}, ${input.category}, ${input.departmentKey}, ${input.deptOnly}, ${input.cover}, ${input.sort},
              ${input.clientKey ?? null}, ${ctx.actor.id})
      RETURNING id`;
    await audit(tx, ctx, 'academy_course_saved', 'academy_course', Number(c!.id), `新建了课程「${input.title}」`);
    return Number(c!.id);
  });
  return adminCourse(sql, id);
}

export async function updateCourse(sql: Sql, id: number, raw: unknown, ctx: OpContext) {
  const input = parse(CourseUpdate, raw);
  await assertDepartment(sql, input.departmentKey);
  if (input.deptOnly && !input.departmentKey) throw badRequest('「只本部门」要先选部门');
  await withTx(sql, async (tx) => {
    const [c] = await tx`
      SELECT title, summary, category, department_key, dept_only, cover, sort, status, version, pack_hash
      FROM academy_courses WHERE id = ${id} FOR UPDATE`;
    if (!c) throw notFound('没有这门课');
    const same =
      c.title === input.title &&
      c.summary === input.summary &&
      c.category === input.category &&
      c.departmentKey === input.departmentKey &&
      c.deptOnly === input.deptOnly &&
      c.cover === input.cover &&
      c.sort === input.sort &&
      c.status === input.status;
    if (c.version !== input.version) {
      if (same) return;
      throw changed('这门课');
    }
    if (input.status === 'published' && c.status !== 'published') {
      const [n] = await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM academy_lessons WHERE course_id = ${id} AND active`;
      if (!n!.n) throw conflict('ACADEMY_EMPTY', '这门课还没有上架的课时，先加课时再上架');
    }
    await tx`
      UPDATE academy_courses SET title = ${input.title}, summary = ${input.summary}, category = ${input.category}, department_key = ${input.departmentKey},
        dept_only = ${input.deptOnly}, cover = ${input.cover}, sort = ${input.sort}, status = ${input.status},
        published_at = CASE WHEN ${input.status} = 'published' AND status <> 'published' THEN now() ELSE published_at END,
        local_edited = local_edited OR pack_hash IS NOT NULL, version = version + 1, updated_at = now()
      WHERE id = ${id}`;
    const what = c.status !== input.status ? `把课程「${input.title}」改成${{ draft: '草稿', published: '上架', archived: '下架' }[input.status]}` : `修改了课程「${input.title}」`;
    await audit(tx, ctx, 'academy_course_saved', 'academy_course', id, what);
  });
  return adminCourse(sql, id);
}

/** 课时内容核对：图文课件解析没问题、实操检查项 1–30 条、文件在员工培训里且上架、测验的题数与及格线 */
async function checkLesson(db: Db, input: z.infer<typeof LessonInput>) {
  if (input.kind === 'article') {
    if (!input.body.trim()) throw badRequest('图文课件还没写内容');
    const { problems } = parseAcademyMarkup(input.body);
    if (problems.length) throw unprocessable('ACADEMY_MARKUP_INVALID', `课件第 ${problems[0]!.line} 行：${problems[0]!.message}`, { problems: problems.slice(0, 20) });
  }
  if (input.kind === 'practical') {
    const items = input.body
      .split('\n')
      .map((s) => s.replace(/^\s*[-*\d.、]+\s*/, '').trim())
      .filter(Boolean);
    if (!items.length || items.length > 30) throw badRequest('实操检查项要 1–30 条（每行一条）');
    if (items.some((i) => i.length > 80)) throw badRequest('一条检查项最多 80 个字');
  }
  if (input.kind === 'file') {
    if (!input.fileId) throw badRequest('选一份员工培训里的文件');
    const [f] = await db`SELECT active FROM training_files WHERE id = ${input.fileId}`;
    if (!f) throw badRequest('没有这份培训文件');
    if (!f.active) throw badRequest('这份培训文件已经下架');
  }
  return {
    fileId: input.kind === 'file' ? input.fileId : null,
    quizCount: input.kind === 'quiz' ? (input.quizCount ?? ACADEMY_QUIZ_DEFAULT.count) : null,
    quizPass: input.kind === 'quiz' ? (input.quizPass ?? ACADEMY_QUIZ_DEFAULT.pass) : null,
    credits: input.credits ?? ACADEMY_DEFAULT_CREDITS[input.kind],
    body: input.kind === 'article' || input.kind === 'practical' ? input.body : '',
  };
}

export async function createLesson(sql: Sql, courseId: number, raw: unknown, ctx: OpContext) {
  const input = parse(LessonInput, raw);
  const v = await checkLesson(sql, input);
  await withTx(sql, async (tx) => {
    const [c] = await tx`SELECT id FROM academy_courses WHERE id = ${courseId} FOR UPDATE`;
    if (!c) throw notFound('没有这门课');
    if (input.clientKey) {
      const [had] = await tx`SELECT course_id, title, kind FROM academy_lessons WHERE client_key = ${input.clientKey}`;
      if (had) {
        if (Number(had.courseId) !== courseId || had.title !== input.title || had.kind !== input.kind) throw sameKey();
        return;
      }
    }
    const [l] = await tx<{ id: number }[]>`
      INSERT INTO academy_lessons (course_id, seq, title, kind, body, file_id, quiz_count, quiz_pass, minutes, credits, client_key)
      VALUES (${courseId}, (SELECT COALESCE(max(seq), 0) + 1 FROM academy_lessons WHERE course_id = ${courseId}), ${input.title}, ${input.kind},
              ${v.body}, ${v.fileId}, ${v.quizCount}, ${v.quizPass}, ${input.minutes}, ${v.credits}, ${input.clientKey ?? null})
      RETURNING id`;
    await tx`UPDATE academy_courses SET local_edited = local_edited OR pack_hash IS NOT NULL, updated_at = now() WHERE id = ${courseId}`;
    await audit(tx, ctx, 'academy_course_saved', 'academy_lesson', Number(l!.id), `给课程加了课时「${input.title}」`);
  });
  return adminCourse(sql, courseId);
}

export async function updateLesson(sql: Sql, id: number, raw: unknown, ctx: OpContext) {
  const input = parse(LessonUpdate, raw);
  const [found] = await sql<{ courseId: number }[]>`SELECT course_id FROM academy_lessons WHERE id = ${id}`;
  if (!found) throw notFound('没有这个课时');
  const courseId = Number(found.courseId);
  const v = await checkLesson(sql, { ...input, clientKey: undefined });
  await withTx(sql, async (tx) => {
    await tx`SELECT id FROM academy_courses WHERE id = ${courseId} FOR UPDATE`;
    const [l] = await tx`SELECT title, kind, body, file_id, quiz_count, quiz_pass, minutes, credits, active, version FROM academy_lessons WHERE id = ${id} FOR UPDATE`;
    const same =
      l!.title === input.title &&
      l!.kind === input.kind &&
      l!.body === v.body &&
      (l!.fileId === null ? null : Number(l!.fileId)) === v.fileId &&
      l!.quizCount === v.quizCount &&
      l!.quizPass === v.quizPass &&
      l!.minutes === input.minutes &&
      l!.credits === v.credits &&
      l!.active === input.active;
    if (l!.version !== input.version) {
      if (same) return;
      throw changed('这个课时');
    }
    if (!input.active && l!.active) {
      const [n] = await tx<{ n: number; status: string }[]>`
        SELECT (SELECT count(*)::int FROM academy_lessons WHERE course_id = ${courseId} AND active AND id <> ${id}) AS n, status
        FROM academy_courses WHERE id = ${courseId}`;
      if (n!.status === 'published' && !n!.n) throw conflict('ACADEMY_EMPTY', '这是上架课程里最后一个上架的课时，先把课程下架再下架它');
    }
    await tx`
      UPDATE academy_lessons SET title = ${input.title}, kind = ${input.kind}, body = ${v.body}, file_id = ${v.fileId}, quiz_count = ${v.quizCount},
        quiz_pass = ${v.quizPass}, minutes = ${input.minutes}, credits = ${v.credits}, active = ${input.active}, version = version + 1, updated_at = now()
      WHERE id = ${id}`;
    await tx`UPDATE academy_courses SET local_edited = local_edited OR pack_hash IS NOT NULL, updated_at = now() WHERE id = ${courseId}`;
    await audit(tx, ctx, 'academy_course_saved', 'academy_lesson', id, `修改了课时「${input.title}」${l!.active !== input.active ? (input.active ? '（重新上架）' : '（下架）') : ''}`);
  });
  return adminCourse(sql, courseId);
}

export async function reorderLessons(sql: Sql, courseId: number, raw: unknown, ctx: OpContext) {
  const { lessonIds } = parse(Reorder, raw);
  await withTx(sql, async (tx) => {
    const [c] = await tx`SELECT id FROM academy_courses WHERE id = ${courseId} FOR UPDATE`;
    if (!c) throw notFound('没有这门课');
    const have = await tx<{ id: number }[]>`SELECT id FROM academy_lessons WHERE course_id = ${courseId} ORDER BY id FOR UPDATE`;
    const want = [...lessonIds].sort((a, b) => a - b);
    if (have.length !== want.length || have.some((h, i) => Number(h.id) !== want[i])) throw changed('这门课的课时');
    for (const [i, lessonId] of lessonIds.entries()) await tx`UPDATE academy_lessons SET seq = ${i + 1} WHERE id = ${lessonId} AND seq <> ${i + 1}`;
    await tx`UPDATE academy_courses SET local_edited = local_edited OR pack_hash IS NOT NULL, updated_at = now() WHERE id = ${courseId}`;
    await audit(tx, ctx, 'academy_course_saved', 'academy_course', courseId, '调整了课时顺序');
  });
  return adminCourse(sql, courseId);
}

// ───────────────────────── 学习地图 ─────────────────────────

export async function adminPaths(db: Db): Promise<AcademyAdminPath[]> {
  const rows = await db`SELECT ${pathSelect(db, null, db`, p.pack_version, p.local_edited`)} ORDER BY p.status = 'archived', p.sort, p.id`;
  const stages = await db<{ pathId: number; courseId: number }[]>`SELECT path_id, course_id FROM academy_path_courses ORDER BY path_id, seq`;
  return rows.map((r) => ({
    ...toPath(r as never),
    courseIds: stages.filter((s) => Number(s.pathId) === Number(r.id)).map((s) => Number(s.courseId)),
    packVersion: r.packVersion ?? null,
    localEdited: r.localEdited,
  }));
}

async function checkStages(db: Db, courseIds: number[]) {
  if (new Set(courseIds).size !== courseIds.length) throw badRequest('同一门课在地图里只能出现一次');
  if (!courseIds.length) return;
  const rows = await db<{ id: number }[]>`SELECT id FROM academy_courses WHERE id IN ${db(courseIds)}`;
  if (rows.length !== courseIds.length) throw badRequest('地图里有不存在的课');
}

async function writeStages(tx: Tx, pathId: number, courseIds: number[]) {
  await tx`DELETE FROM academy_path_courses WHERE path_id = ${pathId}`;
  for (const [i, courseId] of courseIds.entries()) await tx`INSERT INTO academy_path_courses (path_id, course_id, seq) VALUES (${pathId}, ${courseId}, ${i + 1})`;
}

export async function createPath(sql: Sql, raw: unknown, ctx: OpContext) {
  const input = parse(PathInput, raw);
  await checkStages(sql, input.courseIds);
  const id = await withTx(sql, async (tx) => {
    if (input.clientKey) {
      const [had] = await tx<{ id: number; title: string }[]>`SELECT id, title FROM academy_paths WHERE client_key = ${input.clientKey}`;
      if (had) {
        if (had.title !== input.title) throw sameKey();
        return Number(had.id);
      }
    }
    const [p] = await tx<{ id: number }[]>`
      INSERT INTO academy_paths (title, summary, cover, sort, credits, valid_months, client_key, created_by)
      VALUES (${input.title}, ${input.summary}, ${input.cover}, ${input.sort}, ${input.credits}, ${input.validMonths}, ${input.clientKey ?? null}, ${ctx.actor.id})
      RETURNING id`;
    await writeStages(tx, Number(p!.id), input.courseIds);
    await audit(tx, ctx, 'academy_path_saved', 'academy_path', Number(p!.id), `新建了学习地图「${input.title}」`);
    return Number(p!.id);
  });
  return (await adminPaths(sql)).find((p) => p.id === id)!;
}

export async function updatePath(sql: Sql, id: number, raw: unknown, ctx: OpContext) {
  const input = parse(PathUpdate, raw);
  await checkStages(sql, input.courseIds);
  await withTx(sql, async (tx) => {
    const [p] = await tx`SELECT title, summary, cover, sort, credits, valid_months, status, version FROM academy_paths WHERE id = ${id} FOR UPDATE`;
    if (!p) throw notFound('没有这张学习地图');
    const stages = (await tx<{ courseId: number }[]>`SELECT course_id FROM academy_path_courses WHERE path_id = ${id} ORDER BY seq`).map((s) => Number(s.courseId));
    const same =
      p.title === input.title &&
      p.summary === input.summary &&
      p.cover === input.cover &&
      p.sort === input.sort &&
      p.credits === input.credits &&
      p.validMonths === input.validMonths &&
      p.status === input.status &&
      stages.join(',') === input.courseIds.join(',');
    if (p.version !== input.version) {
      if (same) return;
      throw changed('这张学习地图');
    }
    if (input.status === 'published') {
      const [n] = input.courseIds.length ? await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM academy_courses WHERE id IN ${tx(input.courseIds)} AND status = 'published'` : [{ n: 0 }];
      if (!n!.n) throw conflict('ACADEMY_EMPTY', '地图里还没有上架的课，先上架课再上架地图');
    }
    await tx`
      UPDATE academy_paths SET title = ${input.title}, summary = ${input.summary}, cover = ${input.cover}, sort = ${input.sort}, credits = ${input.credits},
        valid_months = ${input.validMonths}, status = ${input.status},
        published_at = CASE WHEN ${input.status} = 'published' AND status <> 'published' THEN now() ELSE published_at END,
        local_edited = local_edited OR pack_hash IS NOT NULL, version = version + 1, updated_at = now()
      WHERE id = ${id}`;
    if (stages.join(',') !== input.courseIds.join(',')) await writeStages(tx, id, input.courseIds);
    await audit(tx, ctx, 'academy_path_saved', 'academy_path', id, `修改了学习地图「${input.title}」`);
  });
  return (await adminPaths(sql)).find((p) => p.id === id)!;
}

// ───────────────────────── 指派 ─────────────────────────

interface AssignmentRow {
  id: number;
  pathId: number | null;
  courseId: number | null;
  audience: 'all' | 'department' | 'position' | 'staff';
  departmentKey: string | null;
  positionKey: string | null;
  staffId: number | null;
  required: boolean;
  dueDays: number | null;
  startsOn: string;
  active: boolean;
  version: number;
}

/** 这条指派命中的在职员工 */
async function audienceOf(db: Db, a: Pick<AssignmentRow, 'audience' | 'departmentKey' | 'positionKey' | 'staffId'>) {
  return db<{ id: number; name: string; departmentName: string | null; hireDate: string | null }[]>`
    SELECT s.id, s.display_name AS name, d.name AS department_name, p.hire_date
    FROM staff s LEFT JOIN staff_profiles p ON p.staff_id = s.id
    LEFT JOIN position_catalog pc ON pc.key = s.position LEFT JOIN org_departments d ON d.key = pc.department
    WHERE ${onDuty(db)}
      ${a.audience === 'department' ? db`AND pc.department = ${a.departmentKey}` : db``}
      ${a.audience === 'position' ? db`AND s.position = ${a.positionKey}` : db``}
      ${a.audience === 'staff' ? db`AND s.id = ${a.staffId}` : db``}
    ORDER BY d.sort NULLS LAST, s.display_name`;
}

/** 一批人对一张地图 / 一门课的进度 */
async function targetProgress(db: Db, target: { pathId: number | null; courseId: number | null }, staffIds: number[]): Promise<Map<number, { done: number; total: number }>> {
  const out = new Map<number, { done: number; total: number }>();
  if (!staffIds.length) return out;
  const rows = target.courseId
    ? await db<{ staffId: number; done: number; total: number }[]>`
        SELECT s.id AS staff_id, count(pr.completed_at)::int AS done, count(l.id)::int AS total
        FROM unnest(${staffIds}::bigint[]) AS s(id)
        CROSS JOIN academy_lessons l
        LEFT JOIN academy_progress pr ON pr.lesson_id = l.id AND pr.staff_id = s.id
        WHERE l.course_id = ${target.courseId} AND l.active GROUP BY s.id`
    : await db<{ staffId: number; done: number; total: number }[]>`
        SELECT s.id AS staff_id, count(*)::int AS total,
          count(*) FILTER (WHERE (
            SELECT count(*) > 0 AND count(*) = count(pr.completed_at)
            FROM academy_lessons l LEFT JOIN academy_progress pr ON pr.lesson_id = l.id AND pr.staff_id = s.id
            WHERE l.course_id = pc.course_id AND l.active))::int AS done
        FROM unnest(${staffIds}::bigint[]) AS s(id)
        CROSS JOIN academy_path_courses pc JOIN academy_courses c ON c.id = pc.course_id
        WHERE pc.path_id = ${target.pathId} AND c.status = 'published' GROUP BY s.id`;
  for (const r of rows) out.set(Number(r.staffId), { done: r.done, total: r.total });
  return out;
}

async function loadAssignment(db: Db, id: number): Promise<AssignmentRow> {
  const [a] = await db<AssignmentRow[]>`
    SELECT id, path_id, course_id, audience, department_key, position_key, staff_id, required, due_days, starts_on, active, version
    FROM academy_assignments WHERE id = ${id}`;
  if (!a) throw notFound('没有这条指派');
  return a;
}

export async function assignmentPeople(db: Db, id: number, today: string): Promise<AcademyPersonProgress[]> {
  const a = await loadAssignment(db, id);
  const people = await audienceOf(db, a);
  const progress = await targetProgress(
    db,
    a,
    people.map((p) => Number(p.id)),
  );
  return people.map((p) => {
    const pr = progress.get(Number(p.id)) ?? { done: 0, total: 0 };
    const completed = pr.total > 0 && pr.done === pr.total;
    const dueOn = a.required ? academyDueOn(a.startsOn, p.hireDate, a.dueDays) : null;
    return { staffId: Number(p.id), name: p.name, departmentName: p.departmentName, dueOn, ...pr, completed, overdue: !!dueOn && !completed && dueOn < today };
  });
}

export async function adminAssignments(db: Db, today: string): Promise<AcademyAssignmentStat[]> {
  const rows = await db<(AssignmentRow & { targetTitle: string; departmentName: string | null; positionTitle: string | null; staffName: string | null })[]>`
    SELECT a.id, a.path_id, a.course_id, a.audience, a.department_key, a.position_key, a.staff_id, a.required, a.due_days, a.starts_on, a.active, a.version,
      COALESCE(p.title, c.title) AS target_title, d.name AS department_name, pc.title AS position_title, s.display_name AS staff_name
    FROM academy_assignments a
    LEFT JOIN academy_paths p ON p.id = a.path_id LEFT JOIN academy_courses c ON c.id = a.course_id
    LEFT JOIN org_departments d ON d.key = a.department_key LEFT JOIN position_catalog pc ON pc.key = a.position_key
    LEFT JOIN staff s ON s.id = a.staff_id
    ORDER BY a.active DESC, a.id DESC`;
  const out: AcademyAssignmentStat[] = [];
  for (const a of rows) {
    const people = a.active ? await assignmentPeople(db, Number(a.id), today) : [];
    out.push({
      id: Number(a.id),
      targetKind: a.pathId ? 'path' : 'course',
      targetId: Number(a.pathId ?? a.courseId),
      targetTitle: a.targetTitle,
      audience: a.audience,
      audienceLabel: a.audience === 'all' ? '全员' : (a.departmentName ?? a.positionTitle ?? a.staffName ?? '—'),
      required: a.required,
      dueDays: a.dueDays,
      startsOn: a.startsOn,
      active: a.active,
      version: a.version,
      people: people.length,
      completed: people.filter((p) => p.completed).length,
      overdue: people.filter((p) => p.overdue).length,
    });
  }
  return out;
}

/** 指派生效（新建、重新打开）时给命中的人发站内通知 */
async function notifyAssigned(tx: Tx, a: AssignmentRow, targetTitle: string) {
  const people = await audienceOf(tx, a);
  if (!people.length) return;
  await notify(
    tx,
    people.map((p) => Number(p.id)),
    {
      kind: 'system',
      title: `学堂：${a.required ? '新的必修' : '推荐你学'}「${targetTitle}」`,
      body: a.required && a.dueDays ? `请在 ${a.dueDays} 天内学完（新同事从入职日算）` : '在 WCP → 学堂里打开',
      link: a.pathId ? `/oa/academy/paths/${a.pathId}` : `/oa/academy/courses/${a.courseId}`,
      ref: { type: 'academy_assignment', id: a.id },
    },
  );
}

export async function createAssignment(sql: Sql, raw: unknown, ctx: OpContext, today: string) {
  const input = parse(AssignmentInput, raw);
  if ((input.pathId === null) === (input.courseId === null)) throw badRequest('指派一张学习地图或一门课（二选一）');
  if ((input.audience === 'department') !== (input.departmentKey !== null)) throw badRequest('按部门指派要选部门');
  if ((input.audience === 'position') !== (input.positionKey !== null)) throw badRequest('按岗位指派要选岗位');
  if ((input.audience === 'staff') !== (input.staffId !== null)) throw badRequest('指派给个人要选员工');
  await assertDepartment(sql, input.departmentKey);
  if (input.positionKey && !(await sql`SELECT 1 FROM position_catalog WHERE key = ${input.positionKey}`).length) throw badRequest('没有这个岗位');
  if (input.staffId && !(await sql`SELECT 1 FROM staff WHERE id = ${input.staffId}`).length) throw badRequest('没有这位员工');
  const id = await withTx(sql, async (tx) => {
    if (input.clientKey) {
      const [had] = await tx<AssignmentRow[]>`SELECT id, path_id, course_id, audience FROM academy_assignments WHERE client_key = ${input.clientKey}`;
      if (had) {
        if (had.pathId !== input.pathId || had.courseId !== input.courseId || had.audience !== input.audience) throw sameKey();
        return Number(had.id);
      }
    }
    const [target] = input.pathId
      ? await tx<{ title: string }[]>`SELECT title FROM academy_paths WHERE id = ${input.pathId}`
      : await tx<{ title: string }[]>`SELECT title FROM academy_courses WHERE id = ${input.courseId}`;
    if (!target) throw badRequest(input.pathId ? '没有这张学习地图' : '没有这门课');
    const [a] = await tx<AssignmentRow[]>`
      INSERT INTO academy_assignments (path_id, course_id, audience, department_key, position_key, staff_id, required, due_days, starts_on, client_key, created_by)
      VALUES (${input.pathId}, ${input.courseId}, ${input.audience}, ${input.departmentKey}, ${input.positionKey}, ${input.staffId}, ${input.required},
              ${input.dueDays}, ${today}, ${input.clientKey ?? null}, ${ctx.actor.id})
      RETURNING id, path_id, course_id, audience, department_key, position_key, staff_id, required, due_days, starts_on, active, version`;
    await notifyAssigned(tx, a!, target.title);
    await audit(tx, ctx, 'academy_assignment_saved', 'academy_assignment', Number(a!.id), `指派了「${target.title}」（${input.required ? '必修' : '推荐'}）`);
    return Number(a!.id);
  });
  return (await adminAssignments(sql, today)).find((a) => a.id === id)!;
}

export async function updateAssignment(sql: Sql, id: number, raw: unknown, ctx: OpContext, today: string) {
  const input = parse(AssignmentUpdate, raw);
  await withTx(sql, async (tx) => {
    const [a] = await tx<AssignmentRow[]>`
      SELECT id, path_id, course_id, audience, department_key, position_key, staff_id, required, due_days, starts_on, active, version
      FROM academy_assignments WHERE id = ${id} FOR UPDATE`;
    if (!a) throw notFound('没有这条指派');
    const same = a.required === input.required && a.dueDays === input.dueDays && a.active === input.active;
    if (a.version !== input.version) {
      if (same) return;
      throw changed('这条指派');
    }
    await tx`
      UPDATE academy_assignments SET required = ${input.required}, due_days = ${input.dueDays}, active = ${input.active},
        starts_on = CASE WHEN ${input.active} AND NOT active THEN ${today}::date ELSE starts_on END, version = version + 1, updated_at = now()
      WHERE id = ${id}`;
    const [t] = a.pathId
      ? await tx<{ title: string }[]>`SELECT title FROM academy_paths WHERE id = ${a.pathId}`
      : await tx<{ title: string }[]>`SELECT title FROM academy_courses WHERE id = ${a.courseId}`;
    if (input.active && !a.active) await notifyAssigned(tx, { ...a, required: input.required, dueDays: input.dueDays }, t!.title);
    await audit(tx, ctx, 'academy_assignment_saved', 'academy_assignment', id, `${input.active ? '修改了' : '停用了'}指派「${t!.title}」`);
  });
  return (await adminAssignments(sql, today)).find((a) => a.id === id)!;
}

// ───────────────────────── 学习数据 ─────────────────────────

export async function adminLearners(db: Db): Promise<AcademyLearnerRow[]> {
  const rows = await db<(AcademyLearnerRow & { credits: number })[]>`
    SELECT s.id AS staff_id, s.display_name AS name, d.name AS department_name,
      (SELECT COALESCE(sum(points), 0)::int FROM academy_credits WHERE staff_id = s.id) AS credits,
      (SELECT (COALESCE(sum(seconds), 0) / 60)::int FROM academy_study_days WHERE staff_id = s.id) AS minutes,
      (SELECT count(*)::int FROM academy_progress WHERE staff_id = s.id AND completed_at IS NOT NULL) AS completed_lessons,
      (SELECT max(day) FROM academy_study_days WHERE staff_id = s.id) AS last_study_on
    FROM staff s LEFT JOIN staff_profiles p ON p.staff_id = s.id
    LEFT JOIN position_catalog pc ON pc.key = s.position LEFT JOIN org_departments d ON d.key = pc.department
    WHERE ${onDuty(db)}
    ORDER BY d.sort NULLS LAST, s.display_name`;
  return rows.map((r) => ({ ...r, staffId: Number(r.staffId) }));
}

async function audit(tx: Tx, ctx: OpContext, action: 'academy_course_saved' | 'academy_path_saved' | 'academy_assignment_saved', targetType: string, targetId: number, summary: string) {
  await writeAudit(tx, { staffId: ctx.actor.id, action, targetType, targetId, detail: { summary }, ip: ctx.ip });
}
