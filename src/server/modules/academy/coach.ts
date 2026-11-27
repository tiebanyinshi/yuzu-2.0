// 学堂 · 实操签核、证书与「我的」（docs/ACADEMY.md 第 5 节，PENDING_DECISIONS XT08、XT09）：
//   · 带教（权限 academy.coach）只能签本部门的员工，学堂管理员能签全部；不能给自己签；签核只追加，签「再练」的可以再签；
//     签「通过」要每一项都达标，这一课时就算完成（学分、课程、地图、证书照 progress.ts）；
//   · 加锁：被签员工的学员咨询锁 → 签核一行 → 进度 → 学分（与学员自己的写入同一把锁）；
//   · 证书：「我的」里列出，过了有效期标「已过期」；管理员可以撤销并写原因。

import { z } from 'zod';
import type { AcademyCertificate, AcademyCoachItem, AcademyMastery, AcademyMeDetail, AcademySignoff } from '@shared/academy';
import { masteryStatus } from '@shared/academy-algo';
import { can } from '@shared/permissions';
import type { Db, Sql } from '../../db';
import { writeAudit } from '../../lib/audit';
import type { Actor, OpContext } from '../../lib/context';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors';
import { withTx } from '../../lib/tx';
import { parse } from '../../lib/validate';
import { myProfile } from './catalog';
import { dailyStreak } from './daily';
import { ACADEMY_MANAGE, type Learner } from './learner';
import { onDuty } from '../oa';
import { lockLearner, markComplete } from './progress';

export const ACADEMY_COACH = 'academy.coach' as const;

/** 实操检查项：课时正文每行一条（去掉行首的「- 」「1.」） */
export const practicalItems = (body: string) =>
  body
    .split('\n')
    .map((s) => s.replace(/^\s*(?:[-*]|\d{1,2}[.、．)])\s*/, '').trim())
    .filter(Boolean);

/** 我能签哪些人：管理员全部；带教本部门（自己的岗位所在部门） */
async function coachScope(db: Db, actor: Actor): Promise<{ all: boolean; department: string | null }> {
  if (can(actor, ACADEMY_MANAGE)) return { all: true, department: null };
  if (!can(actor, ACADEMY_COACH)) throw forbidden('没有带教签核的权限');
  const [r] = await db<{ department: string | null }[]>`SELECT pc.department FROM staff s LEFT JOIN position_catalog pc ON pc.key = s.position WHERE s.id = ${actor.id}`;
  return { all: false, department: r?.department ?? null };
}

export const lessonVersionOf = async (db: Db, lessonId: number) => (await db<{ version: number }[]>`SELECT version FROM academy_lessons WHERE id = ${lessonId}`)[0]?.version;

export async function signoffsOf(db: Db, staffId: number, lessonId: number): Promise<AcademySignoff[]> {
  const rows = await db<(AcademySignoff & { id: number })[]>`
    SELECT o.id, o.result, o.checks, o.items, o.comment, s.display_name AS signed_by_name, o.signed_at
    FROM academy_signoffs o JOIN staff s ON s.id = o.signed_by
    WHERE o.staff_id = ${staffId} AND o.lesson_id = ${lessonId} ORDER BY o.id DESC`;
  return rows.map((r) => ({ ...r, id: Number(r.id) }));
}

/** 待我签的：在我范围里的在职员工 × 他在学（学过这门课任何课时）的课里、还没完成的实操课时 */
export async function coachQueue(db: Db, actor: Actor): Promise<AcademyCoachItem[]> {
  const scope = await coachScope(db, actor);
  const rows = await db<(Omit<AcademyCoachItem, 'items' | 'last'> & { body: string; lastResult: 'pass' | 'retry' | null; lastAt: string | null; lastBy: string | null })[]>`
    SELECT s.id AS staff_id, s.display_name AS name, d.name AS department_name, l.id AS lesson_id, l.title AS lesson_title, c.id AS course_id, c.title AS course_title, l.body, l.version AS lesson_version,
      lo.result AS last_result, lo.signed_at AS last_at, lo.signed_by_name AS last_by
    FROM staff s LEFT JOIN staff_profiles p ON p.staff_id = s.id
    LEFT JOIN position_catalog pc ON pc.key = s.position LEFT JOIN org_departments d ON d.key = pc.department
    JOIN academy_lessons l ON l.kind = 'practical' AND l.active
    JOIN academy_courses c ON c.id = l.course_id AND c.status = 'published'
    LEFT JOIN academy_progress done ON done.staff_id = s.id AND done.lesson_id = l.id
    LEFT JOIN LATERAL (
      SELECT o.result, o.signed_at, b.display_name AS signed_by_name FROM academy_signoffs o JOIN staff b ON b.id = o.signed_by
      WHERE o.staff_id = s.id AND o.lesson_id = l.id ORDER BY o.id DESC LIMIT 1) lo ON true
    WHERE ${onDuty(db)} AND s.id <> ${actor.id} AND done.completed_at IS NULL
      AND EXISTS (SELECT 1 FROM academy_progress pr JOIN academy_lessons l2 ON l2.id = pr.lesson_id WHERE pr.staff_id = s.id AND l2.course_id = c.id)
      ${scope.all ? db`` : db`AND pc.department = ${scope.department}`}
    ORDER BY d.sort NULLS LAST, s.display_name, c.sort, l.seq, l.id
    LIMIT 200`;
  return rows.map((r) => ({
    staffId: Number(r.staffId),
    name: r.name,
    departmentName: r.departmentName,
    lessonId: Number(r.lessonId),
    lessonTitle: r.lessonTitle,
    courseId: Number(r.courseId),
    courseTitle: r.courseTitle,
    items: practicalItems(r.body),
    lessonVersion: r.lessonVersion,
    last: r.lastResult ? { result: r.lastResult, signedAt: r.lastAt!, signedByName: r.lastBy! } : null,
  }));
}

const SignoffInput = z.object({
  clientKey: z.uuid('操作编号不正确'),
  staffId: z.number().int().positive(),
  lessonId: z.number().int().positive(),
  lessonVersion: z.number().int().positive(),
  checks: z.array(z.boolean()).min(1).max(30),
  result: z.enum(['pass', 'retry']),
  comment: z.string().trim().max(300, '评语最多 300 个字').default(''),
});

export async function signOff(sql: Sql, ctx: OpContext, raw: unknown, today: string): Promise<{ signoff: AcademySignoff; completed: boolean; credits: number }> {
  const input = parse(SignoffInput, raw);
  if (input.staffId === ctx.actor.id) throw forbidden('不能给自己签实操');
  const scope = await coachScope(sql, ctx.actor);
  const [trainee] = await sql<{ department: string | null }[]>`
    SELECT pc.department FROM staff s LEFT JOIN staff_profiles p ON p.staff_id = s.id LEFT JOIN position_catalog pc ON pc.key = s.position
    WHERE s.id = ${input.staffId} AND ${onDuty(sql)}`;
  if (!trainee) throw notFound('没有这位在职员工');
  if (!scope.all && (!scope.department || trainee.department !== scope.department)) throw forbidden('只能给本部门的同事签实操');
  return withTx(sql, async (tx) => {
    await lockLearner(tx, input.staffId);
    // 先查这个操作编号签过没有：签上了但没收到结果、之后课时又改过或下架了的，原样重提照样返回第一次的结果（Codex 审查 4c50670）
    const [had] = await tx<{ id: number; staffId: number; lessonId: number }[]>`SELECT id, staff_id, lesson_id FROM academy_signoffs WHERE client_key = ${input.clientKey}`;
    if (had) {
      if (Number(had.staffId) !== input.staffId || Number(had.lessonId) !== input.lessonId) throw conflict('IDEMPOTENCY_CONFLICT', '这个操作编号已用于另一次签核，请刷新');
      const [s] = (await signoffsOf(tx, input.staffId, input.lessonId)).filter((x) => x.id === Number(had.id));
      return { signoff: s!, completed: s!.result === 'pass', credits: 0 };
    }
    const [lesson] = await tx<{ id: number; courseId: number; title: string; credits: number; body: string; kind: string; active: boolean; courseStatus: string; version: number }[]>`
      SELECT l.id, l.course_id, l.title, l.credits, l.body, l.kind, l.active, c.status AS course_status, l.version
      FROM academy_lessons l JOIN academy_courses c ON c.id = l.course_id WHERE l.id = ${input.lessonId}`;
    if (!lesson || lesson.kind !== 'practical') throw notFound('没有这个实操课时');
    if (!lesson.active || lesson.courseStatus !== 'published') throw conflict('ACADEMY_PREVIEW_ONLY', '草稿或下架的课不能签');
    const items = practicalItems(lesson.body);
    // 带教打勾时看的是哪一版检查项：管理员改过（哪怕条数没变）就拒绝，免得按旧要求签了新要求（Codex 审查 43c2d86）
    if (input.lessonVersion !== lesson.version) throw conflict('ACADEMY_CHANGED', '这项实操的检查项刚改过，请刷新后按新的检查项再签');
    if (input.checks.length !== items.length) throw badRequest(`这个实操有 ${items.length} 项，打勾的是 ${input.checks.length} 项（检查项刚改过，请刷新）`);
    if (input.result === 'pass' && input.checks.some((c) => !c)) throw badRequest('还有没达标的项，签「再练」或者全部达标再签「通过」');
    const [done] = await tx`SELECT 1 FROM academy_progress WHERE staff_id = ${input.staffId} AND lesson_id = ${input.lessonId} AND completed_at IS NOT NULL`;
    if (done) throw conflict('ACADEMY_ALREADY_DONE', '这项实操已经签过「通过」了');
    const [row] = await tx<{ id: number }[]>`
      INSERT INTO academy_signoffs (staff_id, lesson_id, result, checks, items, comment, signed_by, client_key)
      VALUES (${input.staffId}, ${input.lessonId}, ${input.result}, ${tx.json(input.checks)}, ${tx.json(items)}, ${input.comment}, ${ctx.actor.id}, ${input.clientKey})
      RETURNING id`;
    let credits = 0;
    if (input.result === 'pass') {
      credits = (await markComplete(tx, input.staffId, { id: Number(lesson.id), courseId: Number(lesson.courseId), title: lesson.title, credits: lesson.credits }, today)).credits;
    }
    await writeAudit(tx, {
      staffId: ctx.actor.id,
      action: 'academy_signoff',
      targetType: 'academy_signoff',
      targetId: Number(row!.id),
      detail: { summary: `实操「${lesson.title}」签了${input.result === 'pass' ? '通过' : '再练'}`, staffId: input.staffId },
      ip: ctx.ip,
    });
    const [s] = (await signoffsOf(tx, input.staffId, input.lessonId)).filter((x) => x.id === Number(row!.id));
    return { signoff: s!, completed: input.result === 'pass', credits };
  });
}

// ───────────────────────── 证书 ─────────────────────────

const certSelect = (db: Db, today: string) => db`
  SELECT k.id, k.cert_no, k.staff_id, s.display_name AS staff_name, k.path_id, k.title, k.issued_on, k.expires_on,
    (k.expires_on IS NOT NULL AND k.expires_on < ${today}) AS expired, k.revoked_at IS NOT NULL AS revoked, k.revoke_reason
  FROM academy_certificates k JOIN staff s ON s.id = k.staff_id`;
const toCert = (r: AcademyCertificate): AcademyCertificate => ({ ...r, id: Number(r.id), staffId: Number(r.staffId), pathId: Number(r.pathId) });

export async function adminCertificates(db: Db, today: string): Promise<AcademyCertificate[]> {
  return (await db<AcademyCertificate[]>`${certSelect(db, today)} ORDER BY k.id DESC LIMIT 500`).map(toCert);
}

const RevokeInput = z.object({ reason: z.string().trim().min(1, '写一下撤销的原因').max(200, '原因最多 200 个字') });

export async function revokeCertificate(sql: Sql, id: number, raw: unknown, ctx: OpContext, today: string): Promise<AcademyCertificate> {
  const { reason } = parse(RevokeInput, raw);
  return withTx(sql, async (tx) => {
    const [k] = await tx<{ revokedAt: string | null; certNo: string; revokeReason: string | null }[]>`SELECT revoked_at, cert_no, revoke_reason FROM academy_certificates WHERE id = ${id} FOR UPDATE`;
    if (!k) throw notFound('没有这张证书');
    if (k.revokedAt) {
      if (k.revokeReason === reason) return toCert((await tx<AcademyCertificate[]>`${certSelect(tx, today)} WHERE k.id = ${id}`)[0]!);
      throw conflict('ACADEMY_CHANGED', '这张证书已经撤销了');
    }
    await tx`UPDATE academy_certificates SET revoked_at = now(), revoked_by = ${ctx.actor.id}, revoke_reason = ${reason} WHERE id = ${id}`;
    await writeAudit(tx, {
      staffId: ctx.actor.id,
      action: 'academy_certificate_revoked',
      targetType: 'academy_certificate',
      targetId: id,
      detail: { summary: `撤销了证书 ${k.certNo}：${reason}` },
      ip: ctx.ip,
    });
    return toCert((await tx<AcademyCertificate[]>`${certSelect(tx, today)} WHERE k.id = ${id}`)[0]!);
  });
}

// ───────────────────────── 我的 ─────────────────────────

export async function myDetail(db: Db, l: Learner, actor: Actor, today: string): Promise<AcademyMeDetail> {
  const certificates = (await db<AcademyCertificate[]>`${certSelect(db, today)} WHERE k.staff_id = ${l.id} ORDER BY k.id DESC`).map(toCert);
  const mastery = await db<Omit<AcademyMastery, 'status'>[]>`
    SELECT skill, p_known, attempts, correct FROM academy_mastery WHERE staff_id = ${l.id} ORDER BY p_known, skill`;
  return {
    me: await myProfile(db, l, today),
    certificates,
    mastery: mastery.map((m) => ({ ...m, status: masteryStatus(m.pKnown) })),
    streak: await dailyStreak(db, l.id, today),
    canCoach: can(actor, ACADEMY_COACH) || l.canManage,
  };
}
