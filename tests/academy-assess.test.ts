// 汤崎学堂第二批：测评（docs/ACADEMY.md 第 5、7 节，PENDING_DECISIONS XT03、XT07–XT09）：题库、测验、每日一练、掌握度、实操签核、证书。

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  AcademyAdminCourse,
  AcademyAdminPath,
  AcademyCoachItem,
  AcademyDaily,
  AcademyLessonView,
  AcademyMeDetail,
  AcademyQuestion,
  AcademyQuizResult,
  AcademyQuizView,
} from '../src/shared/academy';
import { createStaff } from '../src/server/modules/staff';
import { api, login, PASSWORD, setup, type TestContext } from './helpers';

let ctx: TestContext;
let lead: string;
let diner: string;
let course: AcademyAdminCourse;
let quizId: number;
let practicalId: number;
let path: AcademyAdminPath;

const Q = (skill: string, stem: string, right: string, wrong: string) => ({
  clientKey: randomUUID(),
  kind: 'single',
  skill,
  level: 1,
  stem,
  options: [right, wrong],
  answer: [0],
  explanation: `${stem}的解析`,
});

beforeAll(async () => {
  ctx = await setup();
  await ctx.sql`UPDATE staff SET position = 'front.staff', needs_position = false WHERE id = ${ctx.clerkId}`;
  const leadId = await createStaff(ctx.sql, { username: 'frontlead', displayName: '前厅主管', role: 'clerk', position: 'front.lead', password: PASSWORD, mustChangePassword: false });
  const dinerId = await createStaff(ctx.sql, { username: 'diner2', displayName: '餐饮小李', role: 'clerk', position: 'dining.staff', password: PASSWORD, mustChangePassword: false });
  await ctx.sql`UPDATE staff SET needs_position = false WHERE id IN (${leadId}, ${dinerId})`;
  lead = await login(ctx.app, 'frontlead');
  diner = await login(ctx.app, 'diner2');
  const made = await api<AcademyAdminCourse>(ctx.app, ctx.owner, 'POST', '/api/admin/academy/courses', { clientKey: randomUUID(), title: '前厅接待', category: 'must_know' });
  const id = made.body.course.id;
  await api(ctx.app, ctx.owner, 'POST', `/api/admin/academy/courses/${id}/lessons`, { clientKey: randomUUID(), title: '六步接待', kind: 'article', body: '问候、发牌。' });
  await api(ctx.app, ctx.owner, 'POST', `/api/admin/academy/courses/${id}/lessons`, { clientKey: randomUUID(), title: '接待实操', kind: 'practical', body: '- 主动问候\n- 核对人数\n- 指引更衣室' });
  const withQuiz = await api<AcademyAdminCourse>(ctx.app, ctx.owner, 'POST', `/api/admin/academy/courses/${id}/lessons`, {
    clientKey: randomUUID(),
    title: '课后测验',
    kind: 'quiz',
    quizCount: 3,
    quizPass: 60,
  });
  course = withQuiz.body;
  quizId = course.lessons.find((l) => l.kind === 'quiz')!.id;
  practicalId = course.lessons.find((l) => l.kind === 'practical')!.id;
  const pub = await api<AcademyAdminCourse>(ctx.app, ctx.owner, 'PUT', `/api/admin/academy/courses/${id}`, { ...course.course, status: 'published', version: course.course.version });
  course = pub.body;
  const p = await api<AcademyAdminPath>(ctx.app, ctx.owner, 'POST', '/api/admin/academy/paths', { clientKey: randomUUID(), title: '前厅新员工地图', validMonths: 12, courseIds: [id] });
  path = (await api<AcademyAdminPath>(ctx.app, ctx.owner, 'PUT', `/api/admin/academy/paths/${p.body.id}`, { ...p.body, status: 'published', version: p.body.version })).body;
});
afterAll(async () => ctx.close());

describe('学堂 · 题库', () => {
  it('手写题：不合规拒绝并说明哪里不对；带操作编号原样重提返回同一题；改题带版本；停用的不进测验', async () => {
    const bad = await api(ctx.app, ctx.owner, 'POST', `/api/admin/academy/courses/${course.course.id}/questions`, { ...Q('接待', '题', '甲', '乙'), answer: [0, 1] });
    expect(bad.status).toBe(422);
    expect(bad.body.error).toMatchObject({ code: 'ACADEMY_QUESTION_INVALID', message: '单选题要有且只有一个对的选项（- [x]）' });
    const key = randomUUID();
    const first = await api<AcademyQuestion>(ctx.app, ctx.owner, 'POST', `/api/admin/academy/courses/${course.course.id}/questions`, {
      ...Q('问候', '见到客人先做什么？', '微笑问候', '低头玩手机'),
      clientKey: key,
    });
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({ source: 'manual', status: 'active', options: ['微笑问候', '低头玩手机'], answer: [0] });
    const again = await api<AcademyQuestion>(ctx.app, ctx.owner, 'POST', `/api/admin/academy/courses/${course.course.id}/questions`, {
      ...Q('问候', '见到客人先做什么？', '微笑问候', '低头玩手机'),
      clientKey: key,
    });
    expect(again.body.id).toBe(first.body.id);
    const other = await api(ctx.app, ctx.owner, 'POST', `/api/admin/academy/courses/${course.course.id}/questions`, { ...Q('问候', '换了题干', '甲', '乙'), clientKey: key });
    expect(other.body.error.code).toBe('IDEMPOTENCY_CONFLICT');
    for (const q of [Q('问候', '客人进门几米内要问候？', '三米', '三十米'), Q('发牌', '发牌前先核对什么？', '人数', '天气'), Q('发牌', '手牌是什么？', '在店消费的凭证', '纪念品')]) {
      expect((await api(ctx.app, ctx.owner, 'POST', `/api/admin/academy/courses/${course.course.id}/questions`, q)).status).toBe(201);
    }
    const recall = await api<AcademyQuestion>(ctx.app, ctx.owner, 'POST', `/api/admin/academy/courses/${course.course.id}/questions`, {
      clientKey: randomUUID(),
      kind: 'recall',
      skill: '发牌',
      stem: '客人丢了手牌怎么办？',
      answerText: '先安抚，核对后挂失补牌。',
    });
    expect(recall.body).toMatchObject({ kind: 'recall', options: [], answer: [] });
    const retired = await api<AcademyQuestion>(ctx.app, ctx.owner, 'POST', `/api/admin/academy/courses/${course.course.id}/questions`, Q('其他', '要停用的题', '对', '错'));
    const off = await api<AcademyQuestion>(ctx.app, ctx.owner, 'PUT', `/api/admin/academy/questions/${retired.body.id}`, { ...retired.body, status: 'retired', version: retired.body.version });
    expect(off.body).toMatchObject({ status: 'retired', version: retired.body.version + 1 });
    expect((await api(ctx.app, ctx.owner, 'PUT', `/api/admin/academy/questions/${retired.body.id}`, { ...retired.body, stem: '别的', version: retired.body.version })).body.error.code).toBe(
      'ACADEMY_CHANGED',
    );
    const list = (await api<AcademyQuestion[]>(ctx.app, ctx.owner, 'GET', `/api/admin/academy/courses/${course.course.id}/questions`)).body;
    expect(list).toHaveLength(6);
    expect((await api(ctx.app, ctx.clerk, 'GET', `/api/admin/academy/courses/${course.course.id}/questions`)).status).toBe(403);
  });
});

describe('学堂 · 测验', () => {
  let failed: AcademyQuizResult;
  it('开卷：按题数抽启用的客观题（不带答案、不抽问答卡、不抽停用的）；同一编号原样返回同一份；交错了不及格、不算完成；同一份再交返回第一次的结果', async () => {
    const lessonView = (await api<AcademyLessonView>(ctx.app, ctx.clerk, 'GET', `/api/academy/lessons/${quizId}`)).body;
    expect(lessonView).toMatchObject({ quizBest: null, quizAvailable: 4, practical: null });
    const key = randomUUID();
    const quiz = await api<AcademyQuizView>(ctx.app, ctx.clerk, 'POST', `/api/academy/lessons/${quizId}/quiz`, { clientKey: key });
    expect(quiz.status, JSON.stringify(quiz.body)).toBe(200);
    expect(quiz.body).toMatchObject({ lessonId: quizId, passPct: 60, submitted: false });
    expect(quiz.body.questions).toHaveLength(3);
    expect(JSON.stringify(quiz.body)).not.toContain('answer');
    expect(quiz.body.questions.every((q) => q.kind === 'single' && q.stem !== '要停用的题')).toBe(true);
    expect((await api<AcademyQuizView>(ctx.app, ctx.clerk, 'POST', `/api/academy/lessons/${quizId}/quiz`, { clientKey: key })).body.attemptId).toBe(quiz.body.attemptId);
    // 全选第二个（错的）
    const wrong = quiz.body.questions.map(() => [1]);
    const r = await api<AcademyQuizResult>(ctx.app, ctx.clerk, 'POST', `/api/academy/attempts/${quiz.body.attemptId}/submit`, { answers: wrong });
    expect(r.body).toMatchObject({ score: 0, correct: 0, total: 3, passed: false, completion: null });
    expect(r.body.items[0]).toMatchObject({ answer: [0], chosen: [1], correct: false });
    failed = r.body;
    const again = await api<AcademyQuizResult>(ctx.app, ctx.clerk, 'POST', `/api/academy/attempts/${quiz.body.attemptId}/submit`, { answers: quiz.body.questions.map(() => [0]) });
    expect(again.body).toMatchObject({ score: 0, passed: false });
    await expect(ctx.sql`UPDATE academy_attempts SET score = 100 WHERE id = ${quiz.body.attemptId}`).rejects.toThrow();
    expect((await api(ctx.app, diner, 'GET', `/api/academy/attempts/${quiz.body.attemptId}`)).status).toBe(404);
  });

  it('答错的题记进掌握度（薄弱）与每日一练的卡；再考答对及格：课时完成、给测验学分；课时页显示最好成绩', async () => {
    const mastery = await ctx.sql<{ skill: string; pKnown: number }[]>`SELECT skill, p_known FROM academy_mastery WHERE staff_id = ${ctx.clerkId}`;
    expect(mastery.length).toBeGreaterThan(0);
    expect(mastery.every((m) => m.pKnown < 0.3)).toBe(true);
    const cards = await ctx.sql`SELECT question_id, lapses, reps FROM academy_cards WHERE staff_id = ${ctx.clerkId}`;
    expect(cards).toHaveLength(failed.total);
    const quiz = (await api<AcademyQuizView>(ctx.app, ctx.clerk, 'POST', `/api/academy/lessons/${quizId}/quiz`, { clientKey: randomUUID() })).body;
    const right = quiz.questions.map(() => [0]);
    const r = await api<AcademyQuizResult>(ctx.app, ctx.clerk, 'POST', `/api/academy/attempts/${quiz.attemptId}/submit`, { answers: right });
    expect(r.body).toMatchObject({ score: 100, passed: true, completion: { lessonId: quizId, credits: 2, courseCompleted: false } });
    expect((await api<AcademyLessonView>(ctx.app, ctx.clerk, 'GET', `/api/academy/lessons/${quizId}`)).body).toMatchObject({ quizBest: { score: 100, passed: true }, lesson: { state: 'done' } });
    // 再考及格不再给学分
    const third = (await api<AcademyQuizView>(ctx.app, ctx.clerk, 'POST', `/api/academy/lessons/${quizId}/quiz`, { clientKey: randomUUID() })).body;
    const r3 = await api<AcademyQuizResult>(ctx.app, ctx.clerk, 'POST', `/api/academy/attempts/${third.attemptId}/submit`, { answers: third.questions.map(() => [0]) });
    expect(r3.body.completion).toMatchObject({ credits: 0 });
    // 开卷以后测验下架：不再收卷（Codex 审查 43c2d86）
    const openKey = randomUUID();
    const open = (await api<AcademyQuizView>(ctx.app, ctx.clerk, 'POST', `/api/academy/lessons/${quizId}/quiz`, { clientKey: openKey })).body;
    await ctx.sql`UPDATE academy_lessons SET active = false WHERE id = ${quizId}`;
    // 开卷开上了但没收到结果、之后测验下架：原样重提照样拿回那份卷子；新开的拒绝（Codex 审查 b6beee8）
    const again = await api<AcademyQuizView>(ctx.app, ctx.clerk, 'POST', `/api/academy/lessons/${quizId}/quiz`, { clientKey: openKey });
    expect(again.status, JSON.stringify(again.body)).toBe(200);
    expect(again.body.attemptId).toBe(open.attemptId);
    expect((await api(ctx.app, ctx.clerk, 'POST', `/api/academy/lessons/${quizId}/quiz`, { clientKey: randomUUID() })).status).not.toBe(200);
    expect((await api(ctx.app, ctx.clerk, 'POST', `/api/academy/attempts/${open.attemptId}/submit`, { answers: open.questions.map(() => [0]) })).body.error.code).toBe('ACADEMY_PREVIEW_ONLY');
    await ctx.sql`UPDATE academy_lessons SET active = true WHERE id = ${quizId}`;
  });
});

describe('学堂 · 每日一练', () => {
  it('今天的题：考过的卡明天才到期，先出新题（含问答卡）；问答卡要自己评分；同一编号原样返回；练完今天能练的给 1 学分、连续 1 天', async () => {
    const daily = (await api<AcademyDaily>(ctx.app, ctx.clerk, 'GET', '/api/academy/daily')).body;
    expect(daily).toMatchObject({ target: 10, doneToday: 0, streak: 0, credited: false });
    expect(daily.items.length).toBeGreaterThan(0);
    expect(daily.items.every((i) => i.isNew)).toBe(true);
    expect(daily.items.some((i) => i.kind === 'recall')).toBe(true);
    // 客观题不带答案；问答卡带答案（页面先盖着，点「看答案」再自评）
    expect(daily.items.filter((i) => i.kind !== 'recall').every((i) => i.answerText === null)).toBe(true);
    expect(daily.items.find((i) => i.kind === 'recall')!.answerText).toBe('先安抚，核对后挂失补牌。');
    const recall = daily.items.find((i) => i.kind === 'recall')!;
    expect((await api(ctx.app, ctx.clerk, 'POST', '/api/academy/daily/answer', { clientKey: randomUUID(), questionId: recall.questionId, version: recall.version })).status).toBe(400);
    // 页面上的题是旧版本（管理员中间改过题）：拒绝，不按旧题记掌握度（Codex 审查 4c50670）
    expect(
      (await api(ctx.app, ctx.clerk, 'POST', '/api/academy/daily/answer', { clientKey: randomUUID(), questionId: recall.questionId, grade: 4, version: recall.version + 1 })).body.error.code,
    ).toBe('ACADEMY_CHANGED');
    let last: { credits: number; doneToday: number } = { credits: 0, doneToday: 0 };
    for (const item of daily.items) {
      const key = randomUUID();
      const body =
        item.kind === 'recall' ? { clientKey: key, questionId: item.questionId, version: item.version, grade: 4 } : { clientKey: key, questionId: item.questionId, version: item.version, choice: [0] };
      const r = await api(ctx.app, ctx.clerk, 'POST', '/api/academy/daily/answer', body);
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      if (item.kind === 'recall') expect(r.body).toMatchObject({ correct: null, grade: 4, answerText: '先安抚，核对后挂失补牌。' });
      else expect(r.body).toMatchObject({ correct: true, grade: 3 });
      const replay = await api(ctx.app, ctx.clerk, 'POST', '/api/academy/daily/answer', body);
      expect(replay.body).toMatchObject({ questionId: item.questionId, credits: 0 });
      last = r.body;
    }
    expect(last).toMatchObject({ credits: 1, doneToday: daily.items.length });
    const after = (await api<AcademyDaily>(ctx.app, ctx.clerk, 'GET', '/api/academy/daily')).body;
    expect(after).toMatchObject({ items: [], credited: true, streak: 1, doneToday: daily.items.length });
    // 练过的题今天不能再答
    expect(
      (await api(ctx.app, ctx.clerk, 'POST', '/api/academy/daily/answer', { clientKey: randomUUID(), questionId: daily.items[0]!.questionId, version: daily.items[0]!.version, choice: [0], grade: 3 }))
        .body.error.code,
    ).toBe('ACADEMY_DAILY_GONE');
    // 没学过这门课的人：没有新题
    expect((await api<AcademyDaily>(ctx.app, diner, 'GET', '/api/academy/daily')).body.items).toEqual([]);
  });
});

describe('学堂 · 实操签核与证书', () => {
  it('带教只签本部门、不能签自己；检查项数对不上、没全达标签「通过」都拒绝；签「再练」只记录；签「通过」完成课时、学完地图发证书', async () => {
    const queue = (await api<AcademyCoachItem[]>(ctx.app, lead, 'GET', '/api/academy/coach')).body;
    expect(queue).toEqual([expect.objectContaining({ name: '测试店员', lessonId: practicalId, items: ['主动问候', '核对人数', '指引更衣室'], last: null })]);
    expect((await api(ctx.app, diner, 'GET', '/api/academy/coach')).status).toBe(403);
    const lessonVersion = queue[0]!.lessonVersion;
    const base = { staffId: ctx.clerkId, lessonId: practicalId, lessonVersion };
    expect((await api(ctx.app, lead, 'POST', '/api/academy/signoffs', { ...base, clientKey: randomUUID(), checks: [true, true], result: 'pass' })).status).toBe(400);
    expect((await api(ctx.app, lead, 'POST', '/api/academy/signoffs', { ...base, clientKey: randomUUID(), checks: [true, false, true], result: 'pass' })).status).toBe(400);
    const diner2 = await ctx.sql<{ id: number }[]>`SELECT id FROM staff WHERE username = 'diner2'`;
    expect(
      (await api(ctx.app, lead, 'POST', '/api/academy/signoffs', { staffId: diner2[0]!.id, lessonId: practicalId, lessonVersion, clientKey: randomUUID(), checks: [true, true, true], result: 'pass' }))
        .status,
    ).toBe(403);
    const leadId = (await ctx.sql<{ id: number }[]>`SELECT id FROM staff WHERE username = 'frontlead'`)[0]!.id;
    expect(
      (await api(ctx.app, lead, 'POST', '/api/academy/signoffs', { staffId: leadId, lessonId: practicalId, lessonVersion, clientKey: randomUUID(), checks: [true, true, true], result: 'pass' }))
        .status,
    ).toBe(403);
    // 检查项被改过（条数没变）：拿旧版本签拒绝
    await ctx.sql`UPDATE academy_lessons SET version = version + 1 WHERE id = ${practicalId}`;
    expect((await api(ctx.app, lead, 'POST', '/api/academy/signoffs', { ...base, clientKey: randomUUID(), checks: [true, true, true], result: 'pass' })).body.error.code).toBe('ACADEMY_CHANGED');
    base.lessonVersion = (await api<AcademyCoachItem[]>(ctx.app, lead, 'GET', '/api/academy/coach')).body[0]!.lessonVersion;
    expect(base.lessonVersion).toBe(lessonVersion + 1);
    const retry = await api(ctx.app, lead, 'POST', '/api/academy/signoffs', { ...base, clientKey: randomUUID(), checks: [true, false, true], result: 'retry', comment: '指引要说清方向' });
    expect(retry.body).toMatchObject({ completed: false, credits: 0, signoff: { result: 'retry', checks: [true, false, true], signedByName: '前厅主管' } });
    // 第一节图文课还没学：签「通过」以后课程还差一节
    const key = randomUUID();
    const pass = await api(ctx.app, lead, 'POST', '/api/academy/signoffs', { ...base, clientKey: key, checks: [true, true, true], result: 'pass' });
    expect(pass.body).toMatchObject({ completed: true, credits: 3 });
    expect((await api(ctx.app, lead, 'POST', '/api/academy/signoffs', { ...base, clientKey: key, checks: [true, true, true], result: 'pass' })).body).toMatchObject({ completed: true, credits: 0 });
    // 签上了但没收到结果、之后检查项又改过：原样重提照样返回第一次的结果，不被版本核对挡住（Codex 审查 4c50670）
    await ctx.sql`UPDATE academy_lessons SET version = version + 1 WHERE id = ${practicalId}`;
    expect((await api(ctx.app, lead, 'POST', '/api/academy/signoffs', { ...base, clientKey: key, checks: [true, true, true], result: 'pass' })).body).toMatchObject({
      completed: true,
      credits: 0,
      signoff: { result: 'pass' },
    });
    base.lessonVersion += 1;
    expect((await api(ctx.app, lead, 'POST', '/api/academy/signoffs', { ...base, clientKey: randomUUID(), checks: [true, true, true], result: 'pass' })).body.error.code).toBe('ACADEMY_ALREADY_DONE');
    await expect(ctx.sql`DELETE FROM academy_signoffs WHERE staff_id = ${ctx.clerkId}`).rejects.toThrow();
    // 签上了没收到结果、带教重提之前被签的人离职了：原样重提照样返回第一次的结果，不当成「没有这位员工」（Codex 审查 bd376ff）
    await ctx.sql`UPDATE staff SET active = false WHERE id = ${ctx.clerkId}`;
    try {
      expect((await api(ctx.app, lead, 'POST', '/api/academy/signoffs', { ...base, clientKey: key, checks: [true, true, true], result: 'pass' })).body).toMatchObject({
        completed: true,
        credits: 0,
        signoff: { result: 'pass' },
      });
      expect((await api(ctx.app, lead, 'POST', '/api/academy/signoffs', { ...base, clientKey: randomUUID(), checks: [true, true, true], result: 'retry' })).status).toBe(404);
    } finally {
      await ctx.sql`UPDATE staff SET active = true WHERE id = ${ctx.clerkId}`;
    }
    const view = (await api<AcademyLessonView>(ctx.app, ctx.clerk, 'GET', `/api/academy/lessons/${practicalId}`)).body;
    expect(view.practical).toMatchObject({ items: ['主动问候', '核对人数', '指引更衣室'], lessonVersion: lessonVersion + 2 });
    expect(view.practical!.signoffs.map((s) => s.result)).toEqual(['pass', 'retry']);
    // 签核记着签的时候的检查项原文：之后课时调了顺序，「没达标」照原来那一项显示（Codex 审查 a71cdd5）
    const before = (await ctx.sql<{ body: string }[]>`SELECT body FROM academy_lessons WHERE id = ${practicalId}`)[0]!.body;
    await ctx.sql`UPDATE academy_lessons SET body = ${before.replace('主动问候', '@@').replace('核对人数', '主动问候').replace('@@', '核对人数')} WHERE id = ${practicalId}`;
    const later = (await api<AcademyLessonView>(ctx.app, ctx.clerk, 'GET', `/api/academy/lessons/${practicalId}`)).body.practical!;
    expect(later.items).toEqual(['核对人数', '主动问候', '指引更衣室']);
    expect(later.signoffs[1]).toMatchObject({ result: 'retry', checks: [true, false, true], items: ['主动问候', '核对人数', '指引更衣室'] });
    await ctx.sql`UPDATE academy_lessons SET body = ${before} WHERE id = ${practicalId}`;
    // 学完最后一节：课程完成、地图完成、发证书（12 个月有效）
    const article = course.lessons.find((l) => l.kind === 'article')!;
    const done = await api(ctx.app, ctx.clerk, 'POST', `/api/academy/lessons/${article.id}/complete`);
    expect(done.body).toMatchObject({ courseCompleted: true, pathsCompleted: [{ id: path.id, title: '前厅新员工地图', credits: 5 }] });
    expect(done.body.pathsCompleted[0].certNo).toMatch(/^XT\d{8}-0001$/);
    const me = (await api<AcademyMeDetail>(ctx.app, ctx.clerk, 'GET', '/api/academy/me')).body;
    expect(me.certificates).toEqual([expect.objectContaining({ title: '前厅新员工地图', expired: false, revoked: false })]);
    const cert = me.certificates[0]!;
    expect(Number(cert.expiresOn!.slice(0, 4)) - Number(cert.issuedOn.slice(0, 4))).toBe(1);
    expect(me.mastery.length).toBeGreaterThan(0);
    expect(me).toMatchObject({ streak: 1, canCoach: false, me: { credits: 1 + 2 + 3 + 5 + 1 } });
    expect((await api<AcademyMeDetail>(ctx.app, lead, 'GET', '/api/academy/me')).body.canCoach).toBe(true);
    // 撤销：要写原因；原样重提按撤销了算
    expect((await api(ctx.app, ctx.owner, 'POST', `/api/admin/academy/certificates/${cert.id}/revoke`, { reason: '' })).status).toBe(400);
    const revoked = await api(ctx.app, ctx.owner, 'POST', `/api/admin/academy/certificates/${cert.id}/revoke`, { reason: '补考作弊' });
    expect(revoked.body).toMatchObject({ revoked: true, revokeReason: '补考作弊' });
    expect((await api(ctx.app, ctx.owner, 'POST', `/api/admin/academy/certificates/${cert.id}/revoke`, { reason: '补考作弊' })).status).toBe(200);
    expect((await api(ctx.app, ctx.owner, 'GET', '/api/admin/academy/certificates')).body).toEqual([expect.objectContaining({ certNo: cert.certNo, revoked: true, staffName: '测试店员' })]);
  });
});

describe('学堂 · 上架地图给之前学完的人补发证书', () => {
  it('几个人先学完了课，地图后来才上架：上架时先取齐这批人的学员锁再逐个结算，每人一张证书、编号不重（Codex 审查 be8f2e7）', async () => {
    const made = await api<AcademyAdminCourse>(ctx.app, ctx.owner, 'POST', '/api/admin/academy/courses', { clientKey: randomUUID(), title: '安全巡场', category: 'safety' });
    const withLesson = await api<AcademyAdminCourse>(ctx.app, ctx.owner, 'POST', `/api/admin/academy/courses/${made.body.course.id}/lessons`, {
      clientKey: randomUUID(),
      title: '巡场路线',
      kind: 'article',
      body: '每小时巡一次。',
    });
    const c = withLesson.body;
    await api(ctx.app, ctx.owner, 'PUT', `/api/admin/academy/courses/${c.course.id}`, { ...c.course, status: 'published', version: c.course.version });
    const lessonId = c.lessons[0]!.id;
    for (const who of [ctx.clerk, lead, diner]) expect((await api(ctx.app, who, 'POST', `/api/academy/lessons/${lessonId}/complete`)).status).toBe(200);
    const p = await api<AcademyAdminPath>(ctx.app, ctx.owner, 'POST', '/api/admin/academy/paths', { clientKey: randomUUID(), title: '安全年度复训', validMonths: 12, courseIds: [c.course.id] });
    const pub = await api<AcademyAdminPath>(ctx.app, ctx.owner, 'PUT', `/api/admin/academy/paths/${p.body.id}`, { ...p.body, status: 'published', version: p.body.version });
    expect(pub.status).toBe(200);
    const certs = await ctx.sql<{ staffId: number; certNo: string }[]>`SELECT staff_id, cert_no FROM academy_certificates WHERE path_id = ${p.body.id} ORDER BY staff_id`;
    expect(certs).toHaveLength(3);
    expect(new Set(certs.map((x) => x.certNo)).size).toBe(3);
  });
});
