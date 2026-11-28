// 员工小程序接汤崎学堂（员工小程序线 F，docs/STAFF_MP.md 第 2.3、5.3 节）：员工小程序端口把学堂的员工端接口照白名单原样挂上，
// 学分、进度、测验、每日一练全走学堂自己的处理函数；课时回包附上用学堂自己的解析解析好的块；管理端、带教签核、问柚子不挂。

import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AcademyAdminCourse, AcademyAdminPath } from '../src/shared/academy';
import { createStaff } from '../src/server/modules/staff';
import { buildStaffMpApp } from '../src/server/modules/staffmp';
import { api, PASSWORD, setup, type TestContext } from './helpers';

let ctx: TestContext;
let staffApp: FastifyInstance;
let token: string;
let articleId: number;
let quizId: number;
let courseId: number;
let pathId: number;

async function s<T = any>(method: 'GET' | 'POST', url: string, tok?: string | null, payload?: unknown) {
  const res = await staffApp.inject({ method, url, headers: tok ? { authorization: `Bearer ${tok}` } : {}, ...(payload === undefined ? {} : { payload: payload as object }) });
  const body = res.headers['content-type']?.toString().includes('json') ? res.json() : res.body;
  return { status: res.statusCode, body: body as T };
}
const admin = <T = any>(method: 'POST' | 'PUT', url: string, payload?: unknown) => api<T>(ctx.app, ctx.owner, method, url, payload);

async function hire(username: string, displayName: string, mustChangePassword = false) {
  const id = await createStaff(ctx.sql, { username, displayName, role: 'clerk', position: 'front.staff', password: PASSWORD, mustChangePassword });
  await ctx.sql`UPDATE staff SET needs_position = false WHERE id = ${id}`;
  const r = await s('POST', '/api/staffmp/auth/login', null, { username, password: PASSWORD });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return { id, token: r.body.token as string };
}

const ARTICLE = ['## 本课目标', '学完能说出泡汤的三个禁忌。', '', ':::ban 不宜泡汤', '- 酒后', '- 空腹', ':::', '', ':::check', '酒后能泡汤吗？', '- [ ] 能', '- [x] 不能', ':::'].join('\n');
const Q = (stem: string, right: string, wrong: string) => ({
  clientKey: randomUUID(),
  kind: 'single',
  skill: '禁忌',
  level: 1,
  stem,
  options: [right, wrong],
  answer: [0],
  answerText: '',
  explanation: `${right}才对`,
});

beforeAll(async () => {
  ctx = await setup();
  staffApp = await buildStaffMpApp(ctx.sql, ctx.config, { code2session: async (c) => `openid-${c}`, openCacheMs: 0 });
  const made = await admin<AcademyAdminCourse>('POST', '/api/admin/academy/courses', { clientKey: randomUUID(), title: '泡汤安全', category: 'industry' });
  expect(made.status, JSON.stringify(made.body)).toBe(201);
  courseId = made.body.course.id;
  await admin('POST', `/api/admin/academy/courses/${courseId}/lessons`, { clientKey: randomUUID(), title: '三个禁忌', kind: 'article', body: ARTICLE });
  const withQuiz = await admin<AcademyAdminCourse>('POST', `/api/admin/academy/courses/${courseId}/lessons`, { clientKey: randomUUID(), title: '课后测验', kind: 'quiz', quizCount: 2, quizPass: 50 });
  for (const q of [Q('酒后能泡汤吗？', '不能', '能'), Q('空腹能泡汤吗？', '不宜', '最好'), Q('泡汤多久起来歇一歇？', '15 分钟左右', '两小时')]) {
    expect((await admin('POST', `/api/admin/academy/courses/${courseId}/questions`, q)).status).toBe(201);
  }
  const course = withQuiz.body;
  articleId = course.lessons.find((l) => l.kind === 'article')!.id;
  quizId = course.lessons.find((l) => l.kind === 'quiz')!.id;
  const pub = await admin<AcademyAdminCourse>('PUT', `/api/admin/academy/courses/${courseId}`, { ...course.course, status: 'published', version: course.course.version });
  expect(pub.status, JSON.stringify(pub.body)).toBe(200);
  const p = await admin<AcademyAdminPath>('POST', '/api/admin/academy/paths', { clientKey: randomUUID(), title: '前厅新员工地图', validMonths: 12, courseIds: [courseId] });
  const live = await admin<AcademyAdminPath>('PUT', `/api/admin/academy/paths/${p.body.id}`, { ...p.body, status: 'published', version: p.body.version });
  expect(live.status, JSON.stringify(live.body)).toBe(200);
  pathId = live.body.id;
  token = (await hire('learner1', '学员小周')).token;
});

afterAll(async () => {
  await staffApp?.close();
  await ctx?.close();
});

describe('员工小程序 · 汤崎学堂', () => {
  it('「我是谁」里有学堂；首页、课程、学习地图照学堂原来的接口', async () => {
    const me = await s('GET', '/api/staffmp/me', token);
    expect(me.body.entries).toContain('academy');
    const home = await s('GET', '/api/staffmp/academy/home', token);
    expect(home.status, JSON.stringify(home.body)).toBe(200);
    expect(home.body.me).toMatchObject({ name: '学员小周', credits: 0 });
    expect(home.body.paths.map((p: { id: number }) => p.id)).toContain(pathId);
    const course = await s('GET', `/api/staffmp/academy/courses/${courseId}`, token);
    expect(course.body.lessons.map((l: { kind: string }) => l.kind)).toEqual(['article', 'quiz']);
    expect((await s('GET', '/api/staffmp/academy/courses?category=industry', token)).body.map((c: { id: number }) => c.id)).toContain(courseId);
    expect((await s('GET', `/api/staffmp/academy/paths/${pathId}`, token)).body.stages.map((c: { id: number }) => c.id)).toEqual([courseId]);
  });

  it('课时回包附上学堂自己解析好的块（图文课件）；别的课时是空的', async () => {
    const r = await s('GET', `/api/staffmp/academy/lessons/${articleId}`, token);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.blocks.map((b: { type: string }) => b.type)).toEqual(['heading', 'paragraph', 'callout', 'check']);
    expect(r.body.blocks[2]).toMatchObject({ tone: 'ban', title: '不宜泡汤' });
    expect(r.body.blocks[3].question).toMatchObject({ stem: '酒后能泡汤吗？', options: ['能', '不能'], answer: [1] });
    expect((await s('GET', `/api/staffmp/academy/lessons/${quizId}`, token)).body.blocks).toEqual([]);
  });

  it('学完了给学分（同一课时只给一次）；测验开卷带操作编号、原样重提回同一份；交卷重提回第一次的结果', async () => {
    const done = await s('POST', `/api/staffmp/academy/lessons/${articleId}/complete`, token);
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(done.body.credits).toBe(1);
    expect((await s('POST', `/api/staffmp/academy/lessons/${articleId}/complete`, token)).body.credits).toBe(0);
    const key = randomUUID();
    const quiz = await s('POST', `/api/staffmp/academy/lessons/${quizId}/quiz`, token, { clientKey: key });
    expect(quiz.status, JSON.stringify(quiz.body)).toBe(200);
    expect(quiz.body.questions).toHaveLength(2);
    expect(JSON.stringify(quiz.body.questions)).not.toContain('answer');
    expect((await s('POST', `/api/staffmp/academy/lessons/${quizId}/quiz`, token, { clientKey: key })).body.attemptId).toBe(quiz.body.attemptId);
    const answers = quiz.body.questions.map(() => [0]);
    const result = await s('POST', `/api/staffmp/academy/attempts/${quiz.body.attemptId}/submit`, token, { answers });
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    expect(result.body).toMatchObject({ score: 100, passed: true });
    expect(result.body.completion).toMatchObject({ lessonId: quizId, courseCompleted: true });
    const again = await s('POST', `/api/staffmp/academy/attempts/${quiz.body.attemptId}/submit`, token, { answers: quiz.body.questions.map(() => [1]) });
    expect(again.body).toMatchObject({ score: 100, passed: true });
    expect((await s('GET', `/api/staffmp/academy/attempts/${quiz.body.attemptId}`, token)).body.score).toBe(100);
    const home = await s('GET', '/api/staffmp/academy/home', token);
    expect(home.body.me.credits).toBeGreaterThanOrEqual(3);
  });

  it('每日一练：作答带操作编号，原样重提回同一次', async () => {
    const daily = await s('GET', '/api/staffmp/academy/daily', token);
    expect(daily.status, JSON.stringify(daily.body)).toBe(200);
    const item = daily.body.items[0];
    expect(item).toBeTruthy();
    const body = { clientKey: randomUUID(), questionId: item.questionId, version: item.version, choice: [0] };
    const first = await s('POST', '/api/staffmp/academy/daily/answer', token, body);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    const again = await s('POST', '/api/staffmp/academy/daily/answer', token, body);
    expect(again.body).toMatchObject({ questionId: item.questionId, correct: first.body.correct, dueOn: first.body.dueOn });
  });

  it('白名单外的学堂接口（地图列表）、管理端、直接打里面的地址一律 404', async () => {
    for (const [method, url] of [
      ['GET', '/api/staffmp/academy/paths'],
      ['GET', '/api/staffmp/academy/admin/courses'],
      ['GET', '/api/admin/academy/courses'],
      ['GET', '/api/academy/home'],
      ['GET', '/api/academy/me'],
      ['POST', '/api/academy/signoffs'],
    ] as const) {
      const r = await s(method, url, token, method === 'POST' ? {} : undefined);
      expect([url, r.status]).toEqual([url, 404]);
    }
  });

  it('第二版：「我的」（证书、掌握度）、榜单、学完了才能评分（再评是改成新的）、问柚子（门店没配模型服务的说清楚）', async () => {
    const me = await s('GET', '/api/staffmp/academy/me', token);
    expect(me.status, JSON.stringify(me.body)).toBe(200);
    expect(me.body).toMatchObject({ me: { name: '学员小周' }, canCoach: false });
    expect(Array.isArray(me.body.certificates)).toBe(true);
    const rank = await s('GET', '/api/staffmp/academy/rank?board=credits&period=all&scope=company', token);
    expect(rank.status, JSON.stringify(rank.body)).toBe(200);
    expect(rank.body.me).toMatchObject({ name: '学员小周' });
    // 前面那一条把这门课学完了：能评；再评一次是改成新的
    const rated = await s('POST', `/api/staffmp/academy/courses/${courseId}/feedback`, token, { rating: 4, comment: '讲得清楚' });
    expect(rated.status, JSON.stringify(rated.body)).toBe(200);
    expect((await s('POST', `/api/staffmp/academy/courses/${courseId}/feedback`, token, { rating: 5, comment: '' })).body).toEqual({ rating: 5, comment: '' });
    expect((await s('GET', `/api/staffmp/academy/courses/${courseId}`, token)).body.myFeedback).toEqual({ rating: 5, comment: '' });
    // 没学完的人不能评
    const other = await hire('learner3', '还没学的');
    expect((await s('POST', `/api/staffmp/academy/courses/${courseId}/feedback`, other.token, { rating: 3 })).status).toBe(403);
    const tutor = await s('GET', `/api/staffmp/academy/courses/${courseId}/tutor`, token);
    expect(tutor.status, JSON.stringify(tutor.body)).toBe(200);
    expect(tutor.body).toMatchObject({ items: [], usedToday: 0 });
    const ask = await s('POST', `/api/staffmp/academy/courses/${courseId}/tutor`, token, { clientKey: randomUUID(), question: '酒后能泡汤吗？' });
    if (tutor.body.mode === 'off') expect([ask.status, ask.body.error?.code]).toEqual([409, expect.stringMatching(/^AI_/)]);
    else expect(ask.status, JSON.stringify(ask.body)).toBe(200);
  });

  it('第二版：带教签核——有带教权限的「我是谁」里有入口、看得到本部门在学的实操；签核带操作编号，原样重提回第一次的结果', async () => {
    const made = await admin<AcademyAdminCourse>('POST', '/api/admin/academy/courses', { clientKey: randomUUID(), title: '前厅接待实操', category: 'industry' });
    const pid = made.body.course.id;
    const withLesson = await admin<AcademyAdminCourse>('POST', `/api/admin/academy/courses/${pid}/lessons`, {
      clientKey: randomUUID(),
      title: '迎宾',
      kind: 'practical',
      body: '- 主动问候\n- 核对人数',
    });
    const practical = withLesson.body.lessons.find((l) => l.kind === 'practical')!.id;
    expect((await admin('PUT', `/api/admin/academy/courses/${pid}`, { ...withLesson.body.course, status: 'published', version: withLesson.body.course.version })).status).toBe(200);
    // 学员打开过这个实操（有进度、还没完成）
    expect((await s('POST', `/api/staffmp/academy/lessons/${practical}/ping`, token, { seconds: 0 })).status).toBe(200);
    const leadId = await createStaff(ctx.sql, { username: 'frontlead2', displayName: '前厅主管', role: 'clerk', position: 'front.lead', password: PASSWORD, mustChangePassword: false });
    await ctx.sql`UPDATE staff SET needs_position = false WHERE id = ${leadId}`;
    const login = await s('POST', '/api/staffmp/auth/login', null, { username: 'frontlead2', password: PASSWORD });
    const lead = login.body.token as string;
    expect(login.body.me.entries).toContain('academyCoach');
    expect((await s('GET', '/api/staffmp/me', token)).body.entries).not.toContain('academyCoach');
    expect((await s('GET', '/api/staffmp/academy/me', lead)).body.canCoach).toBe(true);
    const queue = await s('GET', '/api/staffmp/academy/coach', lead);
    expect(queue.status, JSON.stringify(queue.body)).toBe(200);
    const item = queue.body.find((x: { lessonId: number }) => x.lessonId === practical);
    expect(item).toMatchObject({ name: '学员小周', items: ['主动问候', '核对人数'], last: null });
    // 学员自己看不了待签的
    expect((await s('GET', '/api/staffmp/academy/coach', token)).status).toBe(403);
    const key = randomUUID();
    const body = { clientKey: key, staffId: item.staffId, lessonId: practical, lessonVersion: item.lessonVersion, checks: [true, true], result: 'pass', comment: '问候到位' };
    const signed = await s('POST', '/api/staffmp/academy/signoffs', lead, body);
    expect(signed.status, JSON.stringify(signed.body)).toBe(200);
    expect(signed.body).toMatchObject({ completed: true, signoff: { result: 'pass', signedByName: '前厅主管', comment: '问候到位' } });
    expect((await s('POST', '/api/staffmp/academy/signoffs', lead, body)).body).toMatchObject({ completed: true, credits: 0 });
    expect((await ctx.sql`SELECT 1 FROM academy_signoffs WHERE client_key = ${key}`).length).toBe(1);
    // 签过「通过」的不再列
    expect((await s('GET', '/api/staffmp/academy/coach', lead)).body.some((x: { lessonId: number }) => x.lessonId === practical)).toBe(false);
  });

  it('首次登录没改密码的：学堂的接口照学堂自己的关卡拦下', async () => {
    const fresh = await hire('learner2', '新学员', true);
    const r = await s('GET', '/api/staffmp/academy/home', fresh.token);
    expect([r.status, r.body.error?.code]).toEqual([403, 'PASSWORD_CHANGE_REQUIRED']);
  });
});
