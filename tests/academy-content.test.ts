// 汤崎学堂第三批：课件与 AI（docs/ACADEMY.md 第 5、6 节，PENDING_DECISIONS XT10–XT12）：导入内置课件包、表格导入题、AI 出题、问柚子。

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AcademyAiGenerateResult, AcademyPackImportResult, AcademyPackStatus, AcademyTutorAnswer, AcademyTutorView } from '../src/shared/academy';
import { mockAiProvider } from '../src/server/integrations/ai';
import { hashRequest } from '../src/server/lib/idempotency';
import { setAiProviderForTests } from '../src/server/modules/ai';
import { api, setup, type TestContext } from './helpers';

let ctx: TestContext;
beforeAll(async () => {
  ctx = await setup();
  await ctx.sql`UPDATE staff SET position = 'front.staff', needs_position = false WHERE id = ${ctx.clerkId}`;
});
afterAll(async () => {
  setAiProviderForTests(undefined);
  await ctx.close();
});

const status = async () => (await api<AcademyPackStatus>(ctx.app, ctx.owner, 'GET', '/api/admin/academy/packs')).body;
const importPacks = (body: Record<string, unknown>) => api<AcademyPackImportResult>(ctx.app, ctx.owner, 'POST', '/api/admin/academy/packs/import', { clientKey: randomUUID(), ...body });

describe('学堂 · 内置课件包', () => {
  it('导入前全是「还没导入」；导入成草稿：课、课时、题都建好，地图建好、指派停用；原样重提返回第一次的结果；再导一次都不变', async () => {
    const before = await status();
    expect(before.courses).toHaveLength(17);
    expect(before.courses.every((c) => c.state === 'new')).toBe(true);
    expect((await api(ctx.app, ctx.clerk, 'GET', '/api/admin/academy/packs')).status).toBe(403);
    const key = randomUUID();
    const r = await api<AcademyPackImportResult>(ctx.app, ctx.owner, 'POST', '/api/admin/academy/packs/import', { clientKey: key });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.courses.every((c) => c.result === 'created')).toBe(true);
    expect(r.body.paths.map((p) => p.result)).toEqual(Array(8).fill('created'));
    const replay = await api<AcademyPackImportResult>(ctx.app, ctx.owner, 'POST', '/api/admin/academy/packs/import', { clientKey: key });
    expect(replay.body).toEqual(r.body);
    expect((await api(ctx.app, ctx.owner, 'POST', '/api/admin/academy/packs/import', { clientKey: key, publish: true })).body.error.code).toBe('IDEMPOTENCY_CONFLICT');
    const [counts] = await ctx.sql`
      SELECT (SELECT count(*)::int FROM academy_courses WHERE status = 'draft' AND code IS NOT NULL) AS courses,
             (SELECT count(*)::int FROM academy_questions WHERE source = 'pack') AS questions,
             (SELECT count(*)::int FROM academy_assignments WHERE active) AS active_assignments,
             (SELECT count(*)::int FROM academy_assignments) AS assignments`;
    expect(counts).toMatchObject({ courses: 17, activeAssignments: 0 });
    expect(counts!.questions).toBeGreaterThan(200);
    expect(counts!.assignments).toBeGreaterThanOrEqual(8);
    // 草稿：员工看不到
    expect((await api(ctx.app, ctx.clerk, 'GET', '/api/academy/courses')).body).toEqual([]);
    const again = await importPacks({});
    expect(again.body.courses.every((c) => c.result === 'unchanged')).toBe(true);
    expect((await status()).courses.every((c) => c.state === 'same')).toBe(true);
  });

  it('本地改过的不覆盖；包里有新内容、本地没改过的更新课时与题，上架状态不变', async () => {
    const st = await status();
    const front = st.courses.find((c) => c.code === 'mk-front')!;
    const spa = st.courses.find((c) => c.code === 'spa-103')!;
    // 管理员改了「前厅」这门课
    const detail = (await api(ctx.app, ctx.owner, 'GET', `/api/admin/academy/courses/${front.courseId}`)).body;
    await api(ctx.app, ctx.owner, 'PUT', `/api/admin/academy/courses/${front.courseId}`, {
      ...detail.course,
      title: '前厅与收银应知应会（本店版）',
      status: 'published',
      version: detail.course.version,
    });
    // 假装包里的 spa-103 有了新内容（库里记的摘要对不上），并且有人把它上架了、改坏了一节课的正文
    await ctx.sql`UPDATE academy_courses SET pack_hash = ${'0'.repeat(64)}, status = 'published' WHERE id = ${spa.courseId}`;
    await ctx.sql`UPDATE academy_lessons SET body = '旧的正文' WHERE course_id = ${spa.courseId} AND pack_key = 'caution'`;
    const st2 = await status();
    expect(st2.courses.find((c) => c.code === 'mk-front')!.state).toBe('edited');
    expect(st2.courses.find((c) => c.code === 'spa-103')!.state).toBe('changed');
    const r = await importPacks({});
    expect(r.body.courses.find((c) => c.code === 'mk-front')!.result).toBe('skipped');
    expect(r.body.courses.find((c) => c.code === 'spa-103')!.result).toBe('updated');
    const [lesson] = await ctx.sql`SELECT body FROM academy_lessons WHERE course_id = ${spa.courseId} AND pack_key = 'caution'`;
    expect(lesson!.body).toContain('不宜泡汤');
    const [course] = await ctx.sql`SELECT status, title FROM academy_courses WHERE id = ${front.courseId}`;
    expect(course).toMatchObject({ status: 'published', title: '前厅与收银应知应会（本店版）' });
    expect((await ctx.sql`SELECT status FROM academy_courses WHERE id = ${spa.courseId}`)[0]!.status).toBe('published');
  });

  it('包里两张已上架的地图有新内容：都写完以后一起补记，先学完的人两张都记上、各发一张证书（Codex 审查 b72dc70）', async () => {
    const codes = ['spa-general', 'safety-annual'];
    const paths = await ctx.sql<{ id: number }[]>`SELECT id FROM academy_paths WHERE code IN ${ctx.sql(codes)}`;
    const ids = paths.map((p) => Number(p.id));
    await ctx.sql`UPDATE academy_courses SET status = 'published' WHERE id IN (SELECT course_id FROM academy_path_courses WHERE path_id IN ${ctx.sql(ids)})`;
    await ctx.sql`UPDATE academy_paths SET status = 'published', pack_hash = ${'0'.repeat(64)} WHERE id IN ${ctx.sql(ids)}`;
    // 两个人已经把这两张地图的课都学完了（地图后来才有新内容）
    for (const staffId of [ctx.clerkId, ctx.ownerId]) {
      await ctx.sql`
        INSERT INTO academy_progress (staff_id, lesson_id, completed_at)
        SELECT ${staffId}, l.id, now() FROM academy_lessons l
        WHERE l.active AND l.course_id IN (SELECT course_id FROM academy_path_courses WHERE path_id IN ${ctx.sql(ids)})
        ON CONFLICT (staff_id, lesson_id) DO UPDATE SET completed_at = now()`;
    }
    const r = await importPacks({});
    expect(r.body.paths.filter((p) => codes.includes(p.code)).map((p) => p.result)).toEqual(['updated', 'updated']);
    const done = await ctx.sql`SELECT staff_id, path_id FROM academy_path_completions WHERE path_id IN ${ctx.sql(ids)}`;
    expect(done).toHaveLength(4);
    const certs = await ctx.sql<{ certNo: string }[]>`SELECT cert_no FROM academy_certificates WHERE path_id IN ${ctx.sql(ids)}`;
    expect(certs).toHaveLength(4);
    expect(new Set(certs.map((c) => c.certNo)).size).toBe(4);
  });
});

describe('学堂 · 表格导入题', () => {
  it('门店的应知应会表：问答两列导成问答卡；有错标出行号整批不导；带操作编号原样重提返回同一批', async () => {
    const [c] = await ctx.sql<{ id: number }[]>`SELECT id FROM academy_courses WHERE code = 'mk-general'`;
    const bad = await api(ctx.app, ctx.owner, 'POST', `/api/admin/academy/courses/${c!.id}/questions/import`, {
      clientKey: randomUUID(),
      rows: [
        ['问题', '答案', '选项A'],
        ['单选少答案', '', '甲'],
      ],
    });
    expect(bad.status).toBe(422);
    expect(bad.body.error.code).toBe('ACADEMY_TABLE_INVALID');
    expect(bad.body.error.details.problems[0].row).toBe(2);
    const key = randomUUID();
    const body = {
      clientKey: key,
      rows: [
        ['问题', '答案'],
        ['门店几点开门？', '以门店公告为准'],
        ['手牌丢了先做什么？', '先安抚客人，再按规定挂失补牌'],
      ],
    };
    const ok = await api(ctx.app, ctx.owner, 'POST', `/api/admin/academy/courses/${c!.id}/questions/import`, body);
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect(ok.body.questions).toHaveLength(2);
    expect(ok.body.questions[0]).toMatchObject({ kind: 'recall', source: 'import', status: 'draft', skill: '门店应知应会·全员篇' });
    const replay = await api(ctx.app, ctx.owner, 'POST', `/api/admin/academy/courses/${c!.id}/questions/import`, body);
    expect(replay.body.questions.map((q: { id: number }) => q.id)).toEqual(ok.body.questions.map((q: { id: number }) => q.id));
  });

  it('页面选的 CSV 文件服务端读成行再导；表格只能给一种', async () => {
    const [c] = await ctx.sql<{ id: number }[]>`SELECT id FROM academy_courses WHERE code = 'mk-general'`;
    const csv = '题干,选项A,选项B,选项C,答案,解析\n客人晕堂第一步做什么？,扶到通风处平躺,让他继续泡,先去找经理,A,先让客人离开高温环境\n';
    const r = await api(ctx.app, ctx.owner, 'POST', `/api/admin/academy/courses/${c!.id}/questions/import`, { clientKey: randomUUID(), csv });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.questions).toHaveLength(1);
    expect(r.body.questions[0]).toMatchObject({ kind: 'single', answer: [0], source: 'import' });
    const both = await api(ctx.app, ctx.owner, 'POST', `/api/admin/academy/courses/${c!.id}/questions/import`, { clientKey: randomUUID(), csv, rows: [['问题', '答案']] });
    expect(both.status).toBe(400);
  });
});

describe('学堂 · AI 出题与问柚子', () => {
  it('原编号卡在「进行中」：中途断了（超过 15 分钟）的按没做成给原因；题没存上的记失败，再提给原因（Codex 审查 a69d88e）', async () => {
    setAiProviderForTests(mockAiProvider());
    const [lesson] = await ctx.sql<{ id: number; courseId: number }[]>`
      SELECT l.id, l.course_id FROM academy_lessons l JOIN academy_courses c ON c.id = l.course_id WHERE c.code = 'spa-103' AND l.pack_key = 'faint'`;
    const url = `/api/admin/academy/lessons/${lesson!.id}/generate`;
    const hash = hashRequest({ lessonId: lesson!.id, count: 2 });
    const stale = randomUUID();
    await ctx.sql`
      INSERT INTO academy_bulk_ops (client_key, kind, request_hash, created_by, created_at)
      VALUES (${stale}, 'ai_questions', ${hash}, ${ctx.ownerId}, now() - interval '20 minutes')`;
    const r1 = await api(ctx.app, ctx.owner, 'POST', url, { clientKey: stale, count: 2 });
    expect(r1.body.error).toMatchObject({ code: 'ACADEMY_AI_FAILED', message: '上一次中途断了，没有做完，换一次再试' });
    const fresh = randomUUID();
    await ctx.sql`INSERT INTO academy_bulk_ops (client_key, kind, request_hash, created_by) VALUES (${fresh}, 'ai_questions', ${hash}, ${ctx.ownerId})`;
    expect((await api(ctx.app, ctx.owner, 'POST', url, { clientKey: fresh, count: 2 })).body.error.code).toBe('ACADEMY_AI_RUNNING');
    // 别的事务拿着这门课一行超过等锁时间：出的题存不上
    let locked!: () => void;
    const ready = new Promise<void>((r) => (locked = r));
    const holding = ctx.sql.begin(async (tx) => {
      await tx`SELECT id FROM academy_courses WHERE id = ${lesson!.courseId} FOR UPDATE`;
      locked();
      await new Promise((r) => setTimeout(r, 6_500));
    });
    await ready;
    const key = randomUUID();
    const r2 = await api(ctx.app, ctx.owner, 'POST', url, { clientKey: key, count: 2 });
    expect(r2.status).not.toBe(200);
    await holding;
    const [op] = await ctx.sql<{ status: string; error: string }[]>`SELECT status, error FROM academy_bulk_ops WHERE client_key = ${key}`;
    expect(op).toMatchObject({ status: 'failed', error: expect.stringContaining('出的题没存上') });
    const again = await api(ctx.app, ctx.owner, 'POST', url, { clientKey: key, count: 2 });
    expect(again.body.error.code).toBe('ACADEMY_AI_FAILED');
    expect((await ctx.sql`SELECT 1 FROM academy_questions WHERE source = 'ai' AND course_id = ${lesson!.courseId}`).length).toBe(0);
  });

  it('没配模型服务时都拒绝；配了（模拟）以后 AI 按课中小测出草稿题，原样重提返回同一批', async () => {
    const [lesson] = await ctx.sql<{ id: number }[]>`
      SELECT l.id FROM academy_lessons l JOIN academy_courses c ON c.id = l.course_id WHERE c.code = 'spa-103' AND l.pack_key = 'faint'`;
    setAiProviderForTests(null);
    expect((await api(ctx.app, ctx.owner, 'POST', `/api/admin/academy/lessons/${lesson!.id}/generate`, { clientKey: randomUUID() })).body.error.code).toBe('AI_NOT_CONFIGURED');
    setAiProviderForTests(mockAiProvider());
    const key = randomUUID();
    const r = await api<AcademyAiGenerateResult>(ctx.app, ctx.owner, 'POST', `/api/admin/academy/lessons/${lesson!.id}/generate`, { clientKey: key, count: 2 });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.questions).toHaveLength(2);
    expect(r.body.questions.every((q) => q.source === 'ai' && q.status === 'draft')).toBe(true);
    const replay = await api<AcademyAiGenerateResult>(ctx.app, ctx.owner, 'POST', `/api/admin/academy/lessons/${lesson!.id}/generate`, { clientKey: key, count: 2 });
    expect(replay.body.questions.map((q) => q.id)).toEqual(r.body.questions.map((q) => q.id));
    // 出完了但没收到结果、之后模型服务停了：原样重提照样拿回那一批（先查操作编号再核对）
    setAiProviderForTests(null);
    const later = await api<AcademyAiGenerateResult>(ctx.app, ctx.owner, 'POST', `/api/admin/academy/lessons/${lesson!.id}/generate`, { clientKey: key, count: 2 });
    expect(later.status, JSON.stringify(later.body)).toBe(200);
    expect(later.body.questions.map((q) => q.id)).toEqual(r.body.questions.map((q) => q.id));
    setAiProviderForTests(mockAiProvider());
    const [call] = await ctx.sql`SELECT action, mode, ok FROM integration_calls WHERE action = 'academy_questions' ORDER BY id DESC LIMIT 1`;
    expect(call).toMatchObject({ mode: 'mock', ok: true });
  });

  it('问柚子：只按这门课的课件答、注明出自哪几个课时；课件里没有的说没讲到；原样重提不再问一次；每天有上限', async () => {
    const [spa] = await ctx.sql<{ id: number }[]>`SELECT id FROM academy_courses WHERE code = 'spa-103'`;
    const courseId = spa!.id;
    const key = randomUUID();
    const r = await api<AcademyTutorAnswer>(ctx.app, ctx.clerk, 'POST', `/api/academy/courses/${courseId}/tutor`, { clientKey: key, question: '客人晕堂了第一步怎么做？' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.status).toBe('done');
    expect(r.body.answer).toContain('模拟回答');
    expect(r.body.sources.map((s) => s.title)).toContain('晕堂');
    const replay = await api<AcademyTutorAnswer>(ctx.app, ctx.clerk, 'POST', `/api/academy/courses/${courseId}/tutor`, { clientKey: key, question: '客人晕堂了第一步怎么做？' });
    expect(replay.body.id).toBe(r.body.id);
    // 问上了但没收到结果、之后课程下架：原样重提照样拿回那次的回答
    const [was] = await ctx.sql<{ status: string }[]>`SELECT status FROM academy_courses WHERE id = ${courseId}`;
    await ctx.sql`UPDATE academy_courses SET status = 'archived' WHERE id = ${courseId}`;
    const archived = await api<AcademyTutorAnswer>(ctx.app, ctx.clerk, 'POST', `/api/academy/courses/${courseId}/tutor`, { clientKey: key, question: '客人晕堂了第一步怎么做？' });
    expect(archived.status, JSON.stringify(archived.body)).toBe(200);
    expect(archived.body.id).toBe(r.body.id);
    await ctx.sql`UPDATE academy_courses SET status = ${was!.status} WHERE id = ${courseId}`;
    const none = await api<AcademyTutorAnswer>(ctx.app, ctx.clerk, 'POST', `/api/academy/courses/${courseId}/tutor`, { clientKey: randomUUID(), question: '量子力学的基本原理' });
    expect(none.body).toMatchObject({ status: 'done', answer: '课件里没讲到这个问题，请问你的主管或带教师傅。', sources: [] });
    const view = (await api<AcademyTutorView>(ctx.app, ctx.clerk, 'GET', `/api/academy/courses/${courseId}/tutor`)).body;
    expect(view).toMatchObject({ usedToday: 2, limit: 30 });
    expect(view.items).toHaveLength(2);
    // 上限：今天已经问了 30 次
    await ctx.sql`
      INSERT INTO academy_tutor_questions (staff_id, course_id, client_key, question, status)
      SELECT ${ctx.clerkId}, ${courseId}, gen_random_uuid(), '占位', 'done' FROM generate_series(1, 28)`;
    expect((await api(ctx.app, ctx.clerk, 'POST', `/api/academy/courses/${courseId}/tutor`, { clientKey: randomUUID(), question: '再问一次' })).body.error.code).toBe('ACADEMY_TUTOR_LIMIT');
    const [call] = await ctx.sql`SELECT request_summary FROM integration_calls WHERE action = 'academy_tutor' ORDER BY id DESC LIMIT 1`;
    expect(JSON.stringify(call!.requestSummary)).not.toContain('测试店员');
  });
});
