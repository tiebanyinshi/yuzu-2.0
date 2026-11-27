// 汤崎学堂第一批（店主 2026-11-27，docs/ACADEMY.md、PENDING_DECISIONS XT01–XT12）：课程与课时、上架、可见范围、学习时长、完成与学分、
// 学习地图完成、指派（必修 / 推荐、截止与逾期）、课程评分、榜单、管理端的操作编号与版本。

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { academyDueOn, type AcademyAdminCourse, type AcademyAdminPath, type AcademyAssignmentStat, type AcademyHome, type AcademyLessonView, type AcademyRank } from '../src/shared/academy';
import { createStaff } from '../src/server/modules/staff';
import { api, login, PASSWORD, setup, type TestContext } from './helpers';

let ctx: TestContext;
let diner: string;
let dinerId: number;
let pad: string;

beforeAll(async () => {
  ctx = await setup();
  // 店员定在前厅部员工；另建一位餐饮部员工、一台平板
  await ctx.sql`UPDATE staff SET position = 'front.staff', needs_position = false WHERE id = ${ctx.clerkId}`;
  dinerId = await createStaff(ctx.sql, { username: 'diner', displayName: '餐饮小王', role: 'clerk', position: 'dining.staff', password: PASSWORD, mustChangePassword: false });
  await ctx.sql`UPDATE staff SET needs_position = false WHERE id = ${dinerId}`;
  diner = await login(ctx.app, 'diner');
  await createStaff(ctx.sql, { username: 'pad-academy', displayName: '平板', role: 'tablet', password: PASSWORD, mustChangePassword: false });
  pad = await login(ctx.app, 'pad-academy');
});
afterAll(async () => ctx.close());

const ARTICLE = ['## 本课目标', '学完能说出泡汤的三个禁忌。', '', ':::ban 不宜泡汤', '- 酒后', '- 空腹', ':::', '', ':::check', '酒后能泡汤吗？', '- [ ] 能', '- [x] 不能', ':::'].join('\n');

async function newCourse(input: Record<string, unknown> = {}) {
  const r = await api<AcademyAdminCourse>(ctx.app, ctx.owner, 'POST', '/api/admin/academy/courses', { clientKey: randomUUID(), title: '泡汤安全', category: 'industry', ...input });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body;
}
async function addLesson(courseId: number, input: Record<string, unknown>) {
  const r = await api<AcademyAdminCourse>(ctx.app, ctx.owner, 'POST', `/api/admin/academy/courses/${courseId}/lessons`, { clientKey: randomUUID(), ...input });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body;
}
async function publish(c: AcademyAdminCourse) {
  const { course } = c;
  const r = await api<AcademyAdminCourse>(ctx.app, ctx.owner, 'PUT', `/api/admin/academy/courses/${course.id}`, {
    title: course.title,
    summary: course.summary,
    category: course.category,
    departmentKey: course.departmentKey,
    deptOnly: course.deptOnly,
    cover: course.cover,
    sort: course.sort,
    status: 'published',
    version: course.version,
  });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body;
}
const homeOf = async (cookie: string) => (await api<AcademyHome>(ctx.app, cookie, 'GET', '/api/academy/home')).body;
const complete = (cookie: string, lessonId: number) => api(ctx.app, cookie, 'POST', `/api/academy/lessons/${lessonId}/complete`);

describe('学堂 · 课程与课时', () => {
  it('建课、加课时（图文课件解析不过拒绝并带行号）、没有课时不能上架、上架后员工看得到；店员不能管理；平板进不了学堂', async () => {
    const made = await newCourse();
    expect(made.course).toMatchObject({ status: 'draft', category: 'industry', lessonCount: 0 });
    const bad = await api(ctx.app, ctx.owner, 'POST', `/api/admin/academy/courses/${made.course.id}/lessons`, {
      clientKey: randomUUID(),
      title: '坏的',
      kind: 'article',
      body: ':::check\n题\n- [ ] 甲\n:::',
    });
    expect(bad.status).toBe(422);
    expect(bad.body.error.code).toBe('ACADEMY_MARKUP_INVALID');
    expect(bad.body.error.details.problems[0].line).toBe(1);
    const empty = await api(ctx.app, ctx.owner, 'PUT', `/api/admin/academy/courses/${made.course.id}`, { ...made.course, status: 'published', version: made.course.version });
    expect(empty.body.error.code).toBe('ACADEMY_EMPTY');
    const withLesson = await addLesson(made.course.id, { title: '泡汤三忌', kind: 'article', body: ARTICLE, minutes: 6 });
    expect(withLesson.lessons).toHaveLength(1);
    expect(withLesson.lessons[0]).toMatchObject({ kind: 'article', credits: 1, seq: 1, minutes: 6 });
    // 草稿：员工列表里没有，按编号打不开；管理员能预览
    expect((await api(ctx.app, ctx.clerk, 'GET', '/api/academy/courses')).body).toEqual([]);
    expect((await api(ctx.app, ctx.clerk, 'GET', `/api/academy/courses/${made.course.id}`)).status).toBe(403);
    expect((await api(ctx.app, ctx.owner, 'GET', `/api/academy/courses/${made.course.id}`)).status).toBe(200);
    const pub = await publish(withLesson);
    expect(pub.course.status).toBe('published');
    const list = (await api(ctx.app, ctx.clerk, 'GET', '/api/academy/courses?category=industry')).body;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ title: '泡汤安全', lessonCount: 1, doneCount: 0, minutes: 6, credits: 1 });
    expect((await api(ctx.app, ctx.clerk, 'GET', '/api/academy/courses?q=泡汤')).body).toHaveLength(1);
    expect((await api(ctx.app, ctx.clerk, 'GET', '/api/academy/courses?q=插花')).body).toHaveLength(0);
    expect((await api(ctx.app, ctx.clerk, 'POST', '/api/admin/academy/courses', { title: 'x', category: 'industry' })).status).toBe(403);
    expect((await api(ctx.app, pad, 'GET', '/api/academy/home')).status).toBe(403);
  });

  it('新建带操作编号原样重提返回原来那门；同一编号换了内容拒绝；修改带版本，别人先改过拒绝，原样重提按改好了算', async () => {
    const key = randomUUID();
    const a = await newCourse({ clientKey: key, title: '带编号的课' });
    const b = await newCourse({ clientKey: key, title: '带编号的课' });
    expect(b.course.id).toBe(a.course.id);
    expect((await api(ctx.app, ctx.owner, 'POST', '/api/admin/academy/courses', { clientKey: key, title: '别的课', category: 'industry' })).body.error.code).toBe('IDEMPOTENCY_CONFLICT');
    const body = { ...a.course, title: '改过的名字', status: 'draft', version: a.course.version };
    const first = await api<AcademyAdminCourse>(ctx.app, ctx.owner, 'PUT', `/api/admin/academy/courses/${a.course.id}`, body);
    expect(first.body.course).toMatchObject({ title: '改过的名字', version: a.course.version + 1 });
    const again = await api<AcademyAdminCourse>(ctx.app, ctx.owner, 'PUT', `/api/admin/academy/courses/${a.course.id}`, body);
    expect(again.status).toBe(200);
    const stale = await api(ctx.app, ctx.owner, 'PUT', `/api/admin/academy/courses/${a.course.id}`, { ...body, title: '又一个名字' });
    expect(stale.body.error.code).toBe('ACADEMY_CHANGED');
  });

  it('「只本部门」的课：别的部门看不到，本部门看得到；指派到的人也看得到', async () => {
    const c = await newCourse({ title: '餐饮出品规范', category: 'must_know', departmentKey: 'dining', deptOnly: true });
    await publish(await addLesson(c.course.id, { title: '出品口', kind: 'article', body: '出品口按档口分。' }));
    const titles = async (cookie: string) => ((await api(ctx.app, cookie, 'GET', '/api/academy/courses')).body as { title: string }[]).map((x) => x.title);
    expect(await titles(diner)).toContain('餐饮出品规范');
    expect(await titles(ctx.clerk)).not.toContain('餐饮出品规范');
    expect((await api(ctx.app, ctx.clerk, 'GET', `/api/academy/courses/${c.course.id}`)).status).toBe(403);
    const assign = await api(ctx.app, ctx.owner, 'POST', '/api/admin/academy/assignments', {
      clientKey: randomUUID(),
      courseId: c.course.id,
      audience: 'staff',
      staffId: ctx.clerkId,
      required: false,
    });
    expect(assign.status, JSON.stringify(assign.body)).toBe(201);
    expect(await titles(ctx.clerk)).toContain('餐饮出品规范');
  });
});

describe('学堂 · 学习、学分与地图', () => {
  it('报时长：第一次只记开始，之后按真实间隔封顶；完成给学分只一次；测验、实操不能自己点完成；草稿只能预览不记进度', async () => {
    const c = await newCourse({ title: '时长与学分', category: 'must_know' });
    const added = await addLesson(c.course.id, { title: '第一节', kind: 'article', body: '正文。' });
    const withQuiz = await addLesson(c.course.id, { title: '测验', kind: 'quiz' });
    const quizLesson = withQuiz.lessons.find((l) => l.kind === 'quiz')!;
    expect(quizLesson).toMatchObject({ quiz: { count: 5, pass: 80 }, credits: 2 });
    const lessonId = added.lessons[0]!.id;
    // 草稿：管理员打开能看，报时长不记、点完成拒绝
    expect((await api(ctx.app, ctx.owner, 'POST', `/api/academy/lessons/${lessonId}/ping`, { seconds: 0 })).body).toEqual({ added: 0 });
    expect((await complete(ctx.owner, lessonId)).body.error.code).toBe('ACADEMY_PREVIEW_ONLY');
    await publish(withQuiz);
    const view = await api<AcademyLessonView>(ctx.app, ctx.clerk, 'GET', `/api/academy/lessons/${lessonId}`);
    expect(view.body).toMatchObject({ lesson: { state: 'todo', body: '正文。' }, prevId: null, nextId: quizLesson.id, seconds: 0, file: null });
    expect((await api(ctx.app, ctx.clerk, 'POST', `/api/academy/lessons/${lessonId}/ping`, { seconds: 50 })).body).toEqual({ added: 0 });
    // 假装上一次上报在 30 秒前：报 90 秒只认 35 秒（间隔 + 5 秒余量）
    await ctx.sql`UPDATE academy_progress SET last_ping_at = now() - interval '30 seconds' WHERE staff_id = ${ctx.clerkId} AND lesson_id = ${lessonId}`;
    expect((await api(ctx.app, ctx.clerk, 'POST', `/api/academy/lessons/${lessonId}/ping`, { seconds: 90 })).body).toEqual({ added: 35 });
    // 隔了很久：一次最多认 120 秒
    await ctx.sql`UPDATE academy_progress SET last_ping_at = now() - interval '1 hour' WHERE staff_id = ${ctx.clerkId} AND lesson_id = ${lessonId}`;
    expect((await api(ctx.app, ctx.clerk, 'POST', `/api/academy/lessons/${lessonId}/ping`, { seconds: 600 })).body).toEqual({ added: 120 });
    const done = await complete(ctx.clerk, lessonId);
    expect(done.body).toMatchObject({ lessonId, credits: 1, courseCompleted: false, pathsCompleted: [] });
    expect((await complete(ctx.clerk, lessonId)).body).toMatchObject({ credits: 0 });
    expect((await complete(ctx.clerk, quizLesson.id)).body.error.code).toBe('ACADEMY_LESSON_NEEDS_QUIZ');
    const home = await homeOf(ctx.clerk);
    expect(home.me).toMatchObject({ credits: 1, seconds: 155, monthSeconds: 155, completedLessons: 1, level: { level: 1, title: '初试水温' } });
    const [credit] = await ctx.sql`SELECT points, reason, ref_no FROM academy_credits WHERE staff_id = ${ctx.clerkId}`;
    expect(credit).toMatchObject({ points: 1, reason: 'lesson', refNo: lessonId });
    // 学分流水只追加
    await expect(ctx.sql`UPDATE academy_credits SET points = 9 WHERE staff_id = ${ctx.clerkId}`).rejects.toThrow();
  });

  it('学完一张地图的课：给地图学分、算升级；地图进度按上架的课算；学完才能评分', async () => {
    const a = await newCourse({ title: '地图第一站', category: 'culture' });
    const a1 = await publish(await addLesson(a.course.id, { title: 'A1', kind: 'article', body: '甲。', credits: 20 }));
    const b = await newCourse({ title: '地图第二站', category: 'culture' });
    const b1 = await publish(await addLesson(b.course.id, { title: 'B1', kind: 'article', body: '乙。', credits: 20 }));
    const draft = await newCourse({ title: '还没上架的一站', category: 'culture' });
    const made = await api<AcademyAdminPath>(ctx.app, ctx.owner, 'POST', '/api/admin/academy/paths', {
      clientKey: randomUUID(),
      title: '新员工入职地图',
      credits: 25,
      courseIds: [a.course.id, b.course.id, draft.course.id],
    });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    expect(made.body).toMatchObject({ status: 'draft', courseCount: 3, courseIds: [a.course.id, b.course.id, draft.course.id] });
    const pub = await api<AcademyAdminPath>(ctx.app, ctx.owner, 'PUT', `/api/admin/academy/paths/${made.body.id}`, { ...made.body, status: 'published', version: made.body.version });
    expect(pub.status, JSON.stringify(pub.body)).toBe(200);
    const detail = (await api(ctx.app, diner, 'GET', `/api/academy/paths/${made.body.id}`)).body;
    expect(detail).toMatchObject({ courseCount: 2, doneCount: 0 });
    expect(detail.stages.map((s: { title: string }) => s.title)).toEqual(['地图第一站', '地图第二站']);
    expect((await api(ctx.app, diner, 'POST', `/api/academy/courses/${a.course.id}/feedback`, { rating: 5 })).status).toBe(403);
    expect((await complete(diner, a1.lessons[0]!.id)).body).toMatchObject({ credits: 20, courseCompleted: true, pathsCompleted: [], levelUp: null });
    const second = (await complete(diner, b1.lessons[0]!.id)).body;
    expect(second).toMatchObject({ credits: 45, courseCompleted: true, pathsCompleted: [{ id: made.body.id, title: '新员工入职地图', credits: 25 }], levelUp: { level: 2, title: '温汤渐暖' } });
    const fb = await api(ctx.app, diner, 'POST', `/api/academy/courses/${a.course.id}/feedback`, { rating: 4, comment: '很实用' });
    expect(fb.body).toEqual({ rating: 4, comment: '很实用' });
    const course = (await api(ctx.app, diner, 'GET', `/api/academy/courses/${a.course.id}`)).body;
    expect(course).toMatchObject({ doneCount: 1, rating: { avg: 4, count: 1 }, myFeedback: { rating: 4, comment: '很实用' }, paths: [{ title: '新员工入职地图' }] });
    expect((await api(ctx.app, diner, 'GET', `/api/academy/paths/${made.body.id}`)).body).toMatchObject({ doneCount: 2, courseCount: 2 });
  });

  it('指派：按部门必修带截止，命中的人收到通知、首页「我的必修」有进度；入职晚的从入职日算；过了截止算逾期；停用的指派不算', async () => {
    const c = await newCourse({ title: '前厅接待', category: 'must_know', departmentKey: 'front' });
    const pub = await publish(await addLesson(c.course.id, { title: '六步接待', kind: 'article', body: '问候、发牌。' }));
    const key = randomUUID();
    const made = await api<AcademyAssignmentStat>(ctx.app, ctx.owner, 'POST', '/api/admin/academy/assignments', {
      clientKey: key,
      courseId: c.course.id,
      audience: 'department',
      departmentKey: 'front',
      required: true,
      dueDays: 7,
    });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    expect(made.body).toMatchObject({ targetTitle: '前厅接待', audienceLabel: '前厅部', required: true, people: 1, completed: 0, overdue: 0 });
    const same = { clientKey: key, courseId: c.course.id, audience: 'department', departmentKey: 'front', required: true, dueDays: 7 };
    expect((await api(ctx.app, ctx.owner, 'POST', '/api/admin/academy/assignments', same)).body.id).toBe(made.body.id);
    // 同一编号、内容不同（哪怕只差期限）：拒绝，不会把原来那条当成这次的（Codex 审查 dd885a6）
    expect((await api(ctx.app, ctx.owner, 'POST', '/api/admin/academy/assignments', { ...same, dueDays: 30 })).body.error.code).toBe('IDEMPOTENCY_CONFLICT');
    const [note] = await ctx.sql`SELECT title, link FROM oa_notifications WHERE staff_id = ${ctx.clerkId} AND ref_type = 'academy_assignment' AND ref_id = ${made.body.id}`;
    expect(note).toMatchObject({ title: '学堂：新的必修「前厅接待」', link: `/oa/academy/courses/${c.course.id}` });
    let home = await homeOf(ctx.clerk);
    const item = home.required.find((r) => r.title === '前厅接待')!;
    expect(item).toMatchObject({ kind: 'course', done: 0, total: 1, overdue: false, completed: false });
    expect(item.dueOn).toBe(academyDueOn(made.body.startsOn, null, 7));
    // 入职日比指派晚：从入职日算
    await ctx.sql`INSERT INTO staff_profiles (staff_id, hire_date) VALUES (${ctx.clerkId}, '2099-01-01') ON CONFLICT (staff_id) DO UPDATE SET hire_date = EXCLUDED.hire_date`;
    home = await homeOf(ctx.clerk);
    expect(home.required.find((r) => r.title === '前厅接待')!.dueOn).toBe('2099-01-08');
    // 指派生效日拨到很早以前、入职日也早：已经逾期
    await ctx.sql`UPDATE staff_profiles SET hire_date = '2020-01-01' WHERE staff_id = ${ctx.clerkId}`;
    await ctx.sql`UPDATE academy_assignments SET starts_on = '2020-01-01' WHERE id = ${made.body.id}`;
    home = await homeOf(ctx.clerk);
    expect(home.required[0]).toMatchObject({ title: '前厅接待', overdue: true, dueOn: '2020-01-08' });
    const people = (await api(ctx.app, ctx.owner, 'GET', `/api/admin/academy/assignments/${made.body.id}/people`)).body;
    expect(people).toEqual([expect.objectContaining({ staffId: ctx.clerkId, overdue: true, completed: false, done: 0, total: 1 })]);
    await complete(ctx.clerk, pub.lessons[0]!.id);
    home = await homeOf(ctx.clerk);
    expect(home.required.find((r) => r.title === '前厅接待')).toMatchObject({ completed: true, overdue: false, done: 1 });
    // 餐饮部的人不命中
    expect((await homeOf(diner)).required.some((r) => r.title === '前厅接待')).toBe(false);
    // 停用
    const stat = (await api<AcademyAssignmentStat[]>(ctx.app, ctx.owner, 'GET', '/api/admin/academy/assignments')).body.find((a) => a.id === made.body.id)!;
    const off = await api(ctx.app, ctx.owner, 'PUT', `/api/admin/academy/assignments/${made.body.id}`, { required: true, dueDays: 7, active: false, version: stat.version });
    expect(off.body).toMatchObject({ active: false, people: 0 });
    expect((await homeOf(ctx.clerk)).required.some((r) => r.title === '前厅接待')).toBe(false);
  });

  it('榜单：学分榜与时长榜，只排在职员工；不在前几名的另给我的名次；后台看全员学习概况', async () => {
    const credits = (await api<AcademyRank>(ctx.app, ctx.clerk, 'GET', '/api/academy/rank?board=credits&period=all&scope=company')).body;
    expect(credits.rows[0]).toMatchObject({ name: '餐饮小王', departmentName: '餐饮部', value: 65, rank: 1 });
    expect(credits.me).toMatchObject({ name: '测试店员', departmentName: '前厅部' });
    const minutes = (await api<AcademyRank>(ctx.app, ctx.clerk, 'GET', '/api/academy/rank?board=minutes&period=month')).body;
    expect(minutes.rows).toEqual([expect.objectContaining({ name: '测试店员', value: 2, rank: 1 })]);
    await ctx.sql`UPDATE staff SET active = false WHERE id = ${dinerId}`;
    const after = (await api<AcademyRank>(ctx.app, ctx.clerk, 'GET', '/api/academy/rank?board=credits&period=all')).body;
    expect(after.rows.some((r) => r.name === '餐饮小王')).toBe(false);
    await ctx.sql`UPDATE staff SET active = true WHERE id = ${dinerId}`;
    const learners = (await api(ctx.app, ctx.owner, 'GET', '/api/admin/academy/learners')).body as { name: string; credits: number; minutes: number }[];
    expect(learners.find((l) => l.name === '测试店员')).toMatchObject({ minutes: 2 });
    expect(learners.find((l) => l.name === '餐饮小王')).toMatchObject({ credits: 65 });
  });
});

describe('学堂 · Codex 审查 dd885a6', () => {
  it('新建不带操作编号拒绝', async () => {
    const r = await api(ctx.app, ctx.owner, 'POST', '/api/admin/academy/courses', { title: '没编号', category: 'industry' });
    expect(r.status).toBe(400);
  });

  it('学完了课以后地图才上架：上架时补记学完、给地图学分；再点「学完了」不重复给', async () => {
    const c = await newCourse({ title: '先学后有地图', category: 'skill' });
    const pub = await publish(await addLesson(c.course.id, { title: '一节', kind: 'article', body: '正文。' }));
    const lessonId = pub.lessons[0]!.id;
    expect((await complete(diner, lessonId)).body).toMatchObject({ credits: 1, courseCompleted: true, pathsCompleted: [] });
    const before = (await homeOf(diner)).me.credits;
    const p = await api<AcademyAdminPath>(ctx.app, ctx.owner, 'POST', '/api/admin/academy/paths', { clientKey: randomUUID(), title: '后来的地图', credits: 7, courseIds: [c.course.id] });
    const up = await api<AcademyAdminPath>(ctx.app, ctx.owner, 'PUT', `/api/admin/academy/paths/${p.body.id}`, { ...p.body, status: 'published', version: p.body.version });
    expect(up.status, JSON.stringify(up.body)).toBe(200);
    expect((await homeOf(diner)).me.credits).toBe(before + 7);
    const [row] = await ctx.sql`SELECT completed_on FROM academy_path_completions WHERE staff_id = ${dinerId} AND path_id = ${p.body.id}`;
    expect(row).toBeTruthy();
    expect((await complete(diner, lessonId)).body).toMatchObject({ credits: 0, pathsCompleted: [] });
    expect((await homeOf(diner)).me.credits).toBe(before + 7);
  });

  it('文件课时只能用全员看得到的培训文件夹里的文件；文件夹后来停用了课时页不给文件', async () => {
    const folders = await ctx.sql<{ id: number; kind: string; departmentKey: string | null }[]>`SELECT id, kind, department_key FROM training_folders`;
    const pub = folders.find((f) => f.kind === 'public')!;
    const dept = folders.find((f) => f.departmentKey === 'front')!;
    const sha = 'a'.repeat(64);
    await ctx.sql`INSERT INTO training_blobs (sha256, size_bytes, chunk_count) VALUES (${sha}, 10, 1)`;
    const fileIn = async (folderId: number, title: string) => {
      const [f] = await ctx.sql<{ id: number }[]>`INSERT INTO training_files (folder_id, title, created_by) VALUES (${folderId}, ${title}, ${ctx.ownerId}) RETURNING id`;
      const [v] = await ctx.sql<{ id: number }[]>`
        INSERT INTO training_file_versions (file_id, version_no, file_name, mime, sha256, size_bytes, uploaded_by)
        VALUES (${f!.id}, 1, 'a.pdf', 'application/pdf', ${sha}, 10, ${ctx.ownerId}) RETURNING id`;
      await ctx.sql`UPDATE training_files SET current_version_id = ${v!.id} WHERE id = ${f!.id}`;
      return Number(f!.id);
    };
    const c = await newCourse({ title: '带文件的课', category: 'skill' });
    const deptFile = await fileIn(dept.id, '前厅内部文件');
    const bad = await api(ctx.app, ctx.owner, 'POST', `/api/admin/academy/courses/${c.course.id}/lessons`, { clientKey: randomUUID(), title: '看文件', kind: 'file', fileId: deptFile });
    expect(bad.status).toBe(400);
    expect(bad.body.error.message).toContain('全员看得到');
    const okFile = await fileIn(pub.id, '员工手册');
    const withFile = await publish(await addLesson(c.course.id, { title: '看员工手册', kind: 'file', fileId: okFile }));
    const lessonId = withFile.lessons[0]!.id;
    expect((await api<AcademyLessonView>(ctx.app, diner, 'GET', `/api/academy/lessons/${lessonId}`)).body.file).toEqual({ id: okFile, folderId: Number(pub.id), title: '员工手册' });
    await ctx.sql`UPDATE training_files SET active = false WHERE id = ${okFile}`;
    expect((await api<AcademyLessonView>(ctx.app, diner, 'GET', `/api/academy/lessons/${lessonId}`)).body.file).toBeNull();
  });

  it('同一个人同时开着两个课时：同一段时间只计一次', async () => {
    const c = await newCourse({ title: '两个课时同时开', category: 'skill' });
    const pub = await publish(await addLesson(await addLesson(c.course.id, { title: '甲', kind: 'article', body: '甲。' }).then((x) => x.course.id), { title: '乙', kind: 'article', body: '乙。' }));
    const [a, b] = pub.lessons;
    for (const l of [a!, b!]) await api(ctx.app, diner, 'POST', `/api/academy/lessons/${l.id}/ping`, { seconds: 0 });
    await ctx.sql`UPDATE academy_progress SET last_ping_at = now() - interval '60 seconds' WHERE staff_id = ${dinerId} AND lesson_id IN (${a!.id}, ${b!.id})`;
    expect((await api(ctx.app, diner, 'POST', `/api/academy/lessons/${a!.id}/ping`, { seconds: 60 })).body).toEqual({ added: 60 });
    const second = (await api(ctx.app, diner, 'POST', `/api/academy/lessons/${b!.id}/ping`, { seconds: 60 })).body as { added: number };
    expect(second.added).toBeLessThanOrEqual(6);
  });

  it('本店榜：没挂任何门店的员工按本店算', async () => {
    await ctx.sql`DELETE FROM staff_stores WHERE staff_id = ${dinerId}`;
    const store = (await api<AcademyRank>(ctx.app, ctx.clerk, 'GET', '/api/academy/rank?board=credits&period=all&scope=store')).body;
    expect(store.rows.some((r) => r.name === '餐饮小王')).toBe(true);
    expect(store.rows.find((r) => r.name === '餐饮小王')!.storeName).toBeTruthy();
  });
});
