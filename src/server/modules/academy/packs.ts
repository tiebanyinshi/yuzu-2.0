// 学堂 · 内置课件包（docs/ACADEMY.md 第 6 节，PENDING_DECISIONS XT11）：仓库里带的通用课件（src/server/academy-packs/*.md + paths.json）。
//   · 不算演示数据：正式服也能导，但只有管理员在「学堂 → 内置课程包」点导入才进库；默认导成草稿、指派先停用，审过再上架；
//   · 按课程编号（code）、课时编号（pack_key）、题号（pack_key）对上已导入的：内容没变的不动；本地改过的（local_edited）不覆盖；
//     包里有新内容、本地没改过的更新课时与题（包里去掉的课时下架、题停用），课程的上架状态不变；
//   · 导入带操作编号（academy_bulk_ops），原样重提返回第一次的结果；同一时刻只做一次导入（咨询锁）。

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { z } from 'zod';
import { ACADEMY_COVERS, type AcademyPackImportResult, type AcademyPackPath, type AcademyPackState, type AcademyPackStatus, type AcademyStatus } from '@shared/academy';
import type { Db, Sql, Tx } from '../../db';
import { writeAudit } from '../../lib/audit';
import type { OpContext } from '../../lib/context';
import { conflict } from '../../lib/errors';
import { hashRequest } from '../../lib/idempotency';
import { withTx } from '../../lib/tx';
import { parse } from '../../lib/validate';
import { parseCourseFile, type PackCourse } from './pack-format';
import { settlePathForAll } from './progress';

/** 源码里在 src/server/academy-packs/，打包以后在 dist/server/academy-packs/（scripts/build-server.mjs 拷过去） */
function packsDir(): URL {
  for (const u of [new URL('./academy-packs/', import.meta.url), new URL('../../academy-packs/', import.meta.url)]) if (existsSync(u)) return u;
  throw new Error('找不到学堂内置课件包目录 academy-packs');
}

const AssignSpec = z.object({
  audience: z.enum(['all', 'department', 'position']),
  department: z
    .string()
    .regex(/^[a-z]+$/)
    .optional(),
  position: z
    .string()
    .regex(/^[a-z]+(\.(lead|staff))?$/)
    .optional(),
  required: z.boolean(),
  dueDays: z.number().int().min(1).max(365).optional(),
});
const PathSpec = z.object({
  code: z.string().regex(/^[a-z0-9][a-z0-9-]{1,39}$/),
  title: z.string().min(1).max(40),
  summary: z.string().max(300),
  cover: z.enum(ACADEMY_COVERS),
  sort: z.number().int(),
  credits: z.number().int().min(0).max(50),
  validMonths: z.number().int().min(1).max(60).nullable(),
  courses: z.array(z.string()).min(1).max(30),
  assign: z.array(AssignSpec).max(20),
});
const PathsFile = z.object({ version: z.number().int().positive(), paths: z.array(PathSpec) });
type PathSpecT = z.infer<typeof PathSpec>;

export interface AcademyPacks {
  version: number;
  courses: PackCourse[];
  paths: (PathSpecT & { hash: string })[];
}

let cached: AcademyPacks | null = null;

/** 读并核对全部课件包（第一次读完缓存；有一份不合格就报错，列出文件与行号） */
export function loadPacks(): AcademyPacks {
  if (cached) return cached;
  const dir = packsDir();
  const problems: string[] = [];
  const courses: PackCourse[] = [];
  for (const f of readdirSync(dir)
    .filter((x) => x.endsWith('.md'))
    .sort()) {
    const { course, problems: p } = parseCourseFile(readFileSync(new URL(f, dir), 'utf8'));
    if (!course) problems.push(...p.map((x) => `${f} 第 ${x.line} 行：${x.message}`));
    else courses.push(course);
  }
  const manifest = PathsFile.parse(JSON.parse(readFileSync(new URL('paths.json', dir), 'utf8')));
  const codes = new Set(courses.map((c) => c.code));
  if (codes.size !== courses.length) problems.push('课程编号有重复');
  for (const p of manifest.paths) for (const c of p.courses) if (!codes.has(c)) problems.push(`paths.json：地图 ${p.code} 里的课 ${c} 没有课件文件`);
  if (problems.length) throw new Error(`学堂内置课件包不合格：\n${problems.join('\n')}`);
  cached = {
    version: manifest.version,
    courses: courses.sort((a, b) => a.sort - b.sort || a.code.localeCompare(b.code)),
    paths: manifest.paths.map((p) => ({ ...p, hash: createHash('sha256').update(JSON.stringify(p)).digest('hex') })),
  };
  return cached;
}

const stateOf = (row: { packHash: string | null; localEdited: boolean } | undefined, hash: string): AcademyPackState =>
  !row ? 'new' : row.localEdited ? 'edited' : row.packHash === hash ? 'same' : 'changed';

const assignLabel = (a: z.infer<typeof AssignSpec>) =>
  `${a.audience === 'all' ? '全员' : a.audience === 'department' ? `部门 ${a.department}` : `岗位 ${a.position}`} · ${a.required ? `必修${a.dueDays ? ` ${a.dueDays} 天` : ''}` : '推荐'}`;

export async function packStatus(db: Db): Promise<AcademyPackStatus> {
  const packs = loadPacks();
  const courses = await db<{ id: number; code: string; packHash: string | null; localEdited: boolean; status: AcademyStatus }[]>`
    SELECT id, code, pack_hash, local_edited, status FROM academy_courses WHERE code IS NOT NULL`;
  const paths = await db<{ id: number; code: string; packHash: string | null; localEdited: boolean; status: AcademyStatus }[]>`
    SELECT id, code, pack_hash, local_edited, status FROM academy_paths WHERE code IS NOT NULL`;
  return {
    version: packs.version,
    courses: packs.courses.map((c) => {
      const row = courses.find((r) => r.code === c.code);
      return {
        code: c.code,
        title: c.title,
        category: c.category,
        summary: c.summary,
        lessons: c.lessons.length,
        questions: c.questions.length,
        minutes: c.lessons.reduce((n, l) => n + l.minutes, 0),
        state: stateOf(row, c.hash),
        courseId: row ? Number(row.id) : null,
        status: row?.status ?? null,
      };
    }),
    paths: packs.paths.map((p): AcademyPackPath => {
      const row = paths.find((r) => r.code === p.code);
      return {
        code: p.code,
        title: p.title,
        summary: p.summary,
        courseCodes: p.courses,
        assignments: p.assign.map(assignLabel),
        state: stateOf(row, p.hash),
        pathId: row ? Number(row.id) : null,
        status: row?.status ?? null,
      };
    }),
  };
}

const ImportInput = z.object({
  clientKey: z.uuid('缺少操作编号或格式不正确'),
  /** 只导这几门课（为空导全部）；地图只导它的课都在库里的 */
  codes: z
    .array(z.string().regex(/^[a-z0-9][a-z0-9-]{1,39}$/))
    .max(100)
    .nullable()
    .default(null),
  /** 导入后直接上架、指派直接生效（默认先当草稿，审过再上架） */
  publish: z.boolean().default(false),
});

async function departmentOrNull(tx: Tx, key: string | null): Promise<string | null> {
  if (!key) return null;
  const [d] = await tx`SELECT 1 FROM org_departments WHERE key = ${key}`;
  return d ? key : null;
}

async function writeLessonsAndQuestions(tx: Tx, courseId: number, c: PackCourse, existing: boolean) {
  for (const [i, l] of c.lessons.entries()) {
    const [had] = existing ? await tx<{ id: number }[]>`SELECT id FROM academy_lessons WHERE course_id = ${courseId} AND pack_key = ${l.key} FOR NO KEY UPDATE` : [];
    if (had) {
      await tx`
        UPDATE academy_lessons SET seq = ${i + 1}, title = ${l.title}, kind = ${l.kind}, body = ${l.body}, file_id = NULL, quiz_count = ${l.quizCount},
          quiz_pass = ${l.quizPass}, minutes = ${l.minutes}, credits = ${l.credits}, active = true, version = version + 1, updated_at = now()
        WHERE id = ${had.id}`;
    } else {
      await tx`
        INSERT INTO academy_lessons (course_id, pack_key, seq, title, kind, body, quiz_count, quiz_pass, minutes, credits)
        VALUES (${courseId}, ${l.key}, ${i + 1}, ${l.title}, ${l.kind}, ${l.body}, ${l.quizCount}, ${l.quizPass}, ${l.minutes}, ${l.credits})`;
    }
  }
  if (existing) {
    await tx`
      UPDATE academy_lessons SET active = false, version = version + 1, updated_at = now()
      WHERE course_id = ${courseId} AND pack_key IS NOT NULL AND pack_key <> ALL(${c.lessons.map((l) => l.key)}) AND active`;
  }
  for (const q of c.questions) {
    const [had] = existing ? await tx<{ id: number }[]>`SELECT id FROM academy_questions WHERE pack_key = ${q.key} FOR NO KEY UPDATE` : [];
    if (had) {
      await tx`
        UPDATE academy_questions SET course_id = ${courseId}, skill = ${q.skill}, kind = ${q.kind}, level = ${q.level}, stem = ${q.stem},
          options = ${tx.json(q.options)}, answer = ${tx.json(q.answer)}, answer_text = ${q.answerText}, explanation = ${q.explanation},
          status = 'active', version = version + 1, updated_at = now()
        WHERE id = ${had.id}`;
    } else {
      await tx`
        INSERT INTO academy_questions (course_id, pack_key, skill, kind, level, stem, options, answer, answer_text, explanation, source, status)
        VALUES (${courseId}, ${q.key}, ${q.skill}, ${q.kind}, ${q.level}, ${q.stem}, ${tx.json(q.options)}, ${tx.json(q.answer)}, ${q.answerText},
                ${q.explanation}, 'pack', 'active')`;
    }
  }
  if (existing) {
    await tx`
      UPDATE academy_questions SET status = 'retired', version = version + 1, updated_at = now()
      WHERE course_id = ${courseId} AND source = 'pack' AND pack_key <> ALL(${c.questions.map((q) => q.key)}) AND status <> 'retired'`;
  }
}

/** 导入内置课件包（带操作编号：原样重提返回第一次的结果） */
export async function importPacks(sql: Sql, raw: unknown, ctx: OpContext, today: string): Promise<AcademyPackImportResult> {
  const input = parse(ImportInput, raw);
  const packs = loadPacks();
  const hash = hashRequest({ codes: input.codes, publish: input.publish, version: packs.version });
  return withTx(sql, async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtextextended('academy_pack_import', 0))`;
    const [had] = await tx<{ requestHash: string; result: AcademyPackImportResult | null; kind: string }[]>`
      SELECT request_hash, result, kind FROM academy_bulk_ops WHERE client_key = ${input.clientKey}`;
    if (had) {
      if (had.kind !== 'pack_import' || had.requestHash !== hash) throw conflict('IDEMPOTENCY_CONFLICT', '这个操作编号已用于另一次导入，请刷新后重新导入');
      return had.result!;
    }
    const pick = input.codes ? new Set(input.codes) : null;
    const status: AcademyStatus = input.publish ? 'published' : 'draft';
    const result: AcademyPackImportResult = { courses: [], paths: [] };
    /** 这次更新了内容的课（课时可能少了，原来差一节的人就算学完了） */
    const updatedCourses: number[] = [];
    for (const c of packs.courses) {
      if (pick && !pick.has(c.code)) continue;
      const [row] = await tx<{ id: number; packHash: string | null; localEdited: boolean }[]>`
        SELECT id, pack_hash, local_edited FROM academy_courses WHERE code = ${c.code} FOR NO KEY UPDATE`;
      const state = stateOf(row, c.hash);
      if (state === 'same' || state === 'edited') {
        result.courses.push({ code: c.code, title: c.title, result: state === 'same' ? 'unchanged' : 'skipped' });
        continue;
      }
      const dept = await departmentOrNull(tx, c.departmentKey);
      let courseId: number;
      if (row) {
        courseId = Number(row.id);
        await tx`
          UPDATE academy_courses SET title = ${c.title}, summary = ${c.summary}, category = ${c.category}, department_key = ${dept},
            dept_only = dept_only AND ${dept !== null}, cover = ${c.cover}, sort = ${c.sort}, pack_version = ${packs.version}, pack_hash = ${c.hash},
            version = version + 1, updated_at = now()
          WHERE id = ${courseId}`;
      } else {
        const [made] = await tx<{ id: number }[]>`
          INSERT INTO academy_courses (code, title, summary, category, department_key, cover, sort, status, pack_version, pack_hash, created_by, published_at)
          VALUES (${c.code}, ${c.title}, ${c.summary}, ${c.category}, ${dept}, ${c.cover}, ${c.sort}, ${status}, ${packs.version}, ${c.hash}, ${ctx.actor.id},
                  ${input.publish ? new Date().toISOString() : null})
          RETURNING id`;
        courseId = Number(made!.id);
      }
      await writeLessonsAndQuestions(tx, courseId, c, !!row);
      if (row) updatedCourses.push(courseId);
      result.courses.push({ code: c.code, title: c.title, result: row ? 'updated' : 'created' });
    }
    const inDb = new Map((await tx<{ id: number; code: string }[]>`SELECT id, code FROM academy_courses WHERE code IS NOT NULL`).map((r) => [r.code, Number(r.id)] as const));
    // 上架的地图写完以后一起补记：先把要动的地图都锁好、写好，最后一次取齐学员锁再结算，
    // 不在拿着学员锁时再去锁下一张地图（管理员改地图是先锁地图再取学员锁，Codex 审查 b72dc70）
    const toSettle: number[] = [];
    for (const p of packs.paths) {
      if (pick && !p.courses.every((c) => pick.has(c) || inDb.has(c))) continue;
      if (!p.courses.every((c) => inDb.has(c))) continue;
      const [row] = await tx<{ id: number; packHash: string | null; localEdited: boolean }[]>`
        SELECT id, pack_hash, local_edited FROM academy_paths WHERE code = ${p.code} FOR NO KEY UPDATE`;
      const state = stateOf(row, p.hash);
      if (state === 'same' || state === 'edited') {
        result.paths.push({ code: p.code, title: p.title, result: state === 'same' ? 'unchanged' : 'skipped' });
        continue;
      }
      let pathId: number;
      if (row) {
        pathId = Number(row.id);
        await tx`
          UPDATE academy_paths SET title = ${p.title}, summary = ${p.summary}, cover = ${p.cover}, sort = ${p.sort}, credits = ${p.credits},
            valid_months = ${p.validMonths}, pack_version = ${packs.version}, pack_hash = ${p.hash}, version = version + 1, updated_at = now()
          WHERE id = ${pathId}`;
      } else {
        const [made] = await tx<{ id: number }[]>`
          INSERT INTO academy_paths (code, title, summary, cover, sort, credits, valid_months, status, pack_version, pack_hash, created_by, published_at)
          VALUES (${p.code}, ${p.title}, ${p.summary}, ${p.cover}, ${p.sort}, ${p.credits}, ${p.validMonths}, ${status}, ${packs.version}, ${p.hash},
                  ${ctx.actor.id}, ${input.publish ? new Date().toISOString() : null})
          RETURNING id`;
        pathId = Number(made!.id);
        // 指派只在第一次导入时建（之后由管理员维护）；导成草稿时先停用
        for (const a of p.assign) {
          const dept = a.audience === 'department' ? await departmentOrNull(tx, a.department ?? null) : null;
          const [pos] = a.audience === 'position' ? await tx`SELECT 1 FROM position_catalog WHERE key = ${a.position ?? ''}` : [true];
          if ((a.audience === 'department' && !dept) || !pos) continue;
          await tx`
            INSERT INTO academy_assignments (path_id, audience, department_key, position_key, required, due_days, starts_on, active, created_by)
            VALUES (${pathId}, ${a.audience}, ${dept}, ${a.audience === 'position' ? a.position! : null}, ${a.required}, ${a.required ? (a.dueDays ?? null) : null},
                    ${today}, ${input.publish}, ${ctx.actor.id})`;
        }
      }
      await tx`DELETE FROM academy_path_courses WHERE path_id = ${pathId}`;
      for (const [i, code] of p.courses.entries()) await tx`INSERT INTO academy_path_courses (path_id, course_id, seq) VALUES (${pathId}, ${inDb.get(code)!}, ${i + 1})`;
      const [now] = await tx<{ status: AcademyStatus }[]>`SELECT status FROM academy_paths WHERE id = ${pathId}`;
      if (now!.status === 'published') toSettle.push(pathId);
      result.paths.push({ code: p.code, title: p.title, result: row ? 'updated' : 'created' });
    }
    // 地图本身没变、但里面的课更新过（比如去掉了一节课）的上架地图也一起补记，按编号顺序锁好（Codex 审查 7a6eee0）
    if (updatedCourses.length) {
      const more = await tx<{ id: number }[]>`
        SELECT id FROM academy_paths WHERE status = 'published' AND id NOT IN ${tx(toSettle.length ? toSettle : [0])}
          AND id IN (SELECT path_id FROM academy_path_courses WHERE course_id IN ${tx(updatedCourses)})
        ORDER BY id FOR NO KEY UPDATE`;
      toSettle.push(...more.map((r) => Number(r.id)));
    }
    await settlePathForAll(tx, toSettle, today);
    await tx`
      INSERT INTO academy_bulk_ops (client_key, kind, request_hash, status, result, created_by, finished_at)
      VALUES (${input.clientKey}, 'pack_import', ${hash}, 'done', ${tx.json(result as never)}, ${ctx.actor.id}, now())`;
    const made = result.courses.filter((c) => c.result === 'created').length;
    const updated = result.courses.filter((c) => c.result === 'updated').length;
    await writeAudit(tx, {
      staffId: ctx.actor.id,
      action: 'academy_pack_imported',
      targetType: 'academy_pack',
      targetId: packs.version,
      detail: { summary: `导入内置课程包：新建 ${made} 门课、更新 ${updated} 门${input.publish ? '（直接上架）' : '（草稿）'}` },
      ip: ctx.ip,
    });
    return result;
  });
}
