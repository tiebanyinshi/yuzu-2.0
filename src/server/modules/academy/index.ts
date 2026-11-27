// 汤崎学堂（店主 2026-11-27，docs/ACADEMY.md）对外的入口：路由登记。
//   员工端 /api/academy/*：只给在职员工（learnerGuard）；管理端 /api/admin/academy/*：学堂管理权限 academy.manage。

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ACADEMY_CATEGORIES } from '@shared/academy';
import { guard } from '../../auth/guard';
import { ctxOf, type Deps } from '../../lib/context';
import { todayIn } from '../../lib/dates';
import { DEFAULT_STORE_ID } from '../../lib/store-context';
import { idParam, parse } from '../../lib/validate';
import {
  adminAssignments,
  adminCourse,
  adminCourses,
  adminLearners,
  adminPaths,
  assignmentPeople,
  createAssignment,
  createCourse,
  createLesson,
  createPath,
  reorderLessons,
  updateAssignment,
  updateCourse,
  updateLesson,
  updatePath,
} from './admin';
import { askTutor, generateQuestions, importQuestionTable, tutorHistory } from './ai';
import { adminQuestions, createQuestion, quizResult, quizSummary, startQuiz, submitQuiz, updateQuestion } from './assess';
import { courseDetail, home, lessonView, listCourses, listPaths, pathDetail } from './catalog';
import { adminCertificates, coachQueue, lessonVersionOf, myDetail, practicalItems, revokeCertificate, signOff, signoffsOf } from './coach';
import { answerDaily, dailySet } from './daily';
import { ACADEMY_MANAGE, learnerGuard, learnerOf } from './learner';
import { completeLesson, pingLesson, rateCourse } from './progress';
import { importPacks, packStatus } from './packs';
import { rank } from './rank';

const CourseQuery = z.object({ category: z.enum(ACADEMY_CATEGORIES).optional(), q: z.string().trim().max(30).optional() });
const PingInput = z.object({ seconds: z.number().int().min(0).max(600) });
const FeedbackInput = z.object({ rating: z.number().int().min(1, '评 1–5 星').max(5, '评 1–5 星'), comment: z.string().trim().max(300, '最多 300 个字').default('') });
const QuizStart = z.object({ clientKey: z.uuid('操作编号不正确') });
const RankQuery = z.object({
  board: z.enum(['credits', 'minutes']).default('credits'),
  period: z.enum(['month', 'all']).default('month'),
  scope: z.enum(['company', 'store']).default('company'),
});

export function registerAcademyRoutes(app: FastifyInstance, deps: Deps) {
  const { sql, config } = deps;
  const learner = learnerGuard(sql);
  const manage = guard(ACADEMY_MANAGE);
  const today = () => todayIn(config.timezone);

  // ── 员工端 ──
  app.get('/api/academy/home', { preHandler: learner }, async (req) => home(sql, await learnerOf(sql, req.actor), today()));
  app.get('/api/academy/courses', { preHandler: learner }, async (req) => listCourses(sql, await learnerOf(sql, req.actor), parse(CourseQuery, req.query ?? {})));
  app.get('/api/academy/courses/:id', { preHandler: learner }, async (req) => courseDetail(sql, await learnerOf(sql, req.actor), parse(idParam, req.params).id));
  app.post('/api/academy/courses/:id/feedback', { preHandler: learner }, async (req) =>
    rateCourse(sql, await learnerOf(sql, req.actor), parse(idParam, req.params).id, parse(FeedbackInput, req.body ?? {})),
  );
  app.get('/api/academy/lessons/:id', { preHandler: learner }, async (req) => {
    const l = await learnerOf(sql, req.actor);
    const id = parse(idParam, req.params).id;
    const view = await lessonView(sql, l, id);
    if (view.lesson.kind === 'quiz') Object.assign(view, await quizSummary(sql, l.id, id, view.course.id));
    if (view.lesson.kind === 'practical') view.practical = { items: practicalItems(view.lesson.body), lessonVersion: (await lessonVersionOf(sql, id))!, signoffs: await signoffsOf(sql, l.id, id) };
    return view;
  });
  app.post('/api/academy/lessons/:id/ping', { preHandler: learner }, async (req) =>
    pingLesson(sql, await learnerOf(sql, req.actor), parse(idParam, req.params).id, parse(PingInput, req.body ?? {}).seconds, today()),
  );
  app.post('/api/academy/lessons/:id/complete', { preHandler: learner }, async (req) => completeLesson(sql, await learnerOf(sql, req.actor), parse(idParam, req.params).id, today()));
  app.post('/api/academy/lessons/:id/quiz', { preHandler: learner }, async (req) =>
    startQuiz(sql, await learnerOf(sql, req.actor), parse(idParam, req.params).id, parse(QuizStart, req.body ?? {}).clientKey),
  );
  app.post('/api/academy/attempts/:id/submit', { preHandler: learner }, async (req) => submitQuiz(sql, await learnerOf(sql, req.actor), parse(idParam, req.params).id, req.body, today()));
  app.get('/api/academy/attempts/:id', { preHandler: learner }, async (req) => quizResult(sql, await learnerOf(sql, req.actor), parse(idParam, req.params).id));
  app.get('/api/academy/daily', { preHandler: learner }, async (req) => dailySet(sql, await learnerOf(sql, req.actor), today()));
  app.post('/api/academy/daily/answer', { preHandler: learner }, async (req) => answerDaily(sql, await learnerOf(sql, req.actor), req.body, today()));
  app.get('/api/academy/me', { preHandler: learner }, async (req) => myDetail(sql, await learnerOf(sql, req.actor), req.actor, today()));
  app.get('/api/academy/coach', { preHandler: learner }, async (req) => coachQueue(sql, req.actor));
  app.post('/api/academy/signoffs', { preHandler: learner }, async (req) => signOff(sql, ctxOf(req), req.body, today()));
  app.get('/api/academy/courses/:id/tutor', { preHandler: learner }, async (req) => tutorHistory(deps, await learnerOf(sql, req.actor), parse(idParam, req.params).id, today()));
  app.post('/api/academy/courses/:id/tutor', { preHandler: learner }, async (req) => askTutor(deps, await learnerOf(sql, req.actor), parse(idParam, req.params).id, req.body, today()));
  app.get('/api/academy/paths', { preHandler: learner }, async (req) => listPaths(sql, await learnerOf(sql, req.actor)));
  app.get('/api/academy/paths/:id', { preHandler: learner }, async (req) => pathDetail(sql, await learnerOf(sql, req.actor), parse(idParam, req.params).id));
  app.get('/api/academy/rank', { preHandler: learner }, async (req) => {
    const q = parse(RankQuery, req.query ?? {});
    return rank(sql, { staffId: req.actor.id, ...q, storeId: req.actor.storeId ?? DEFAULT_STORE_ID, today: today(), timeZone: config.timezone });
  });

  // ── 管理端 ──
  app.get('/api/admin/academy/courses', { preHandler: manage }, async () => adminCourses(sql));
  app.post('/api/admin/academy/courses', { preHandler: manage }, async (req, reply) => reply.code(201).send(await createCourse(sql, req.body, ctxOf(req))));
  app.get('/api/admin/academy/courses/:id', { preHandler: manage }, async (req) => adminCourse(sql, parse(idParam, req.params).id));
  app.put('/api/admin/academy/courses/:id', { preHandler: manage }, async (req) => updateCourse(sql, parse(idParam, req.params).id, req.body, ctxOf(req)));
  app.post('/api/admin/academy/courses/:id/lessons', { preHandler: manage }, async (req, reply) => reply.code(201).send(await createLesson(sql, parse(idParam, req.params).id, req.body, ctxOf(req))));
  app.post('/api/admin/academy/courses/:id/reorder', { preHandler: manage }, async (req) => reorderLessons(sql, parse(idParam, req.params).id, req.body, ctxOf(req)));
  app.put('/api/admin/academy/lessons/:id', { preHandler: manage }, async (req) => updateLesson(sql, parse(idParam, req.params).id, req.body, ctxOf(req)));
  app.get('/api/admin/academy/paths', { preHandler: manage }, async () => adminPaths(sql));
  app.post('/api/admin/academy/paths', { preHandler: manage }, async (req, reply) => reply.code(201).send(await createPath(sql, req.body, ctxOf(req))));
  app.put('/api/admin/academy/paths/:id', { preHandler: manage }, async (req) => updatePath(sql, parse(idParam, req.params).id, req.body, ctxOf(req), today()));
  app.get('/api/admin/academy/assignments', { preHandler: manage }, async () => adminAssignments(sql, today()));
  app.post('/api/admin/academy/assignments', { preHandler: manage }, async (req, reply) => reply.code(201).send(await createAssignment(sql, req.body, ctxOf(req), today())));
  app.put('/api/admin/academy/assignments/:id', { preHandler: manage }, async (req) => updateAssignment(sql, parse(idParam, req.params).id, req.body, ctxOf(req), today()));
  app.get('/api/admin/academy/assignments/:id/people', { preHandler: manage }, async (req) => assignmentPeople(sql, parse(idParam, req.params).id, today()));
  app.get('/api/admin/academy/learners', { preHandler: manage }, async () => adminLearners(sql));
  app.get('/api/admin/academy/courses/:id/questions', { preHandler: manage }, async (req) => adminQuestions(sql, parse(idParam, req.params).id));
  app.post('/api/admin/academy/courses/:id/questions', { preHandler: manage }, async (req, reply) =>
    reply.code(201).send(await createQuestion(sql, parse(idParam, req.params).id, req.body, ctxOf(req))),
  );
  app.put('/api/admin/academy/questions/:id', { preHandler: manage }, async (req) => updateQuestion(sql, parse(idParam, req.params).id, req.body, ctxOf(req)));
  // 表格导入：页面传 CSV 原文（≤ 200 万字）或 Excel 的 base64（≤ 600 万字），默认 64 KB 的请求上限装不下 500 行（Codex 审查 6ee05cd）
  app.post('/api/admin/academy/courses/:id/questions/import', { preHandler: manage, bodyLimit: 8_000_000 }, async (req, reply) =>
    reply.code(201).send(await importQuestionTable(sql, parse(idParam, req.params).id, req.body, ctxOf(req))),
  );
  app.post('/api/admin/academy/lessons/:id/generate', { preHandler: manage }, async (req) => generateQuestions(deps, parse(idParam, req.params).id, req.body, ctxOf(req)));
  app.get('/api/admin/academy/packs', { preHandler: manage }, async () => packStatus(sql));
  app.post('/api/admin/academy/packs/import', { preHandler: manage }, async (req) => importPacks(sql, req.body, ctxOf(req), today()));
  app.get('/api/admin/academy/certificates', { preHandler: manage }, async () => adminCertificates(sql, today()));
  app.post('/api/admin/academy/certificates/:id/revoke', { preHandler: manage }, async (req) => revokeCertificate(sql, parse(idParam, req.params).id, req.body, ctxOf(req), today()));
}
