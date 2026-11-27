// 网页导入技师（8.2.2，《技师排班系统需求沟通会》五.2；docs/V8222_TECHNICIANS.md 第 8 节）：后台「技师名册」上传 Excel / CSV，
// 自动认表头（姓名、工号、花名、电话、组别、身高、体重、星级，及旧系统模板的别名，见 @shared/technician-import），先预览逐行核对，
// 有一处问题一行都不写；确认后生效。再导一次同一份文件结果一样（已有的、没变的都是「不变」）。
//   · 工号本店没有的新建（性别没写的按页面上选的「没写性别的按」，没选的报出来要补）；
//   · 工号已有的只更新表里有值、和名册不一样的资料：花名、电话、组别、身高、体重、星级（格子空着是不改；姓名、性别、等级、入职日期不改，有出入的写在预览里）；
//   · 组别没有的建（停用的同名组重新启用），与命令行 import-technicians 同一个比法。
// 生效带回预览的摘要（planHash）：预览以后名册被别人改过、文件换过，算出来的不一样就拒绝，请重新预览。
// 锁：这家店的「技师导入」咨询锁（与命令行导入同一把）→ 技师（只插新行；改的那几位按 id 升序 FOR UPDATE）→ 技师组。
// 手机号在预览、审计里都打码（@shared/mask）。

import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { PRICE_TIER_LABELS } from '@shared/catalog';
import { csvToTable } from '@shared/csv-read';
import { maskPhone } from '@shared/mask';
import { parseGradeMap, parseTechnicianTableLoose, TECHNICIAN_IMPORT_HEADERS, type TechnicianImportRowLoose } from '@shared/technician-import';
import type { TechnicianImportPreview } from '@shared/technician-import-web';
import type { Tx } from '../db';
import { guard } from '../auth/guard';
import { writeAudit } from '../lib/audit';
import { ctxOf, type Deps, type OpContext } from '../lib/context';
import { conflict, unprocessable } from '../lib/errors';
import { parse } from '../lib/validate';
import { csvReply, toCsv } from '../lib/csv';
import { currentStoreId } from '../lib/store-context';
import { setTxTimeouts } from '../lib/tx';
import { readXlsx, XlsxReadError } from '../lib/xlsx-read';

const FileInput = z
  .object({
    fileName: z.string('请选择文件').trim().min(1, '请选择文件').max(200, '文件名太长'),
    csv: z.string().max(3_000_000, '文件太大').optional(),
    xlsxBase64: z.string().max(6_000_000, '文件太大').optional(),
    /** 表里没写性别的新技师按哪个；不选的要在表里补上 */
    defaultGender: z.enum(['male', 'female']).nullable().default(null),
    /** 旧系统的星级写在「技师等级」列时的对照，如「一星=标准,五星=专业」 */
    gradeMap: z.string().trim().max(300, '等级对照太长').default(''),
  })
  .refine((f) => (f.csv === undefined) !== (f.xlsxBase64 === undefined), '请选择一个 CSV 或 Excel 文件');
const ApplyInput = FileInput.and(z.object({ planHash: z.string('请先预览').regex(/^[0-9a-f]{64}$/, '请先预览') }));

/** 上传的文件 → 每行的单元格文字（Excel 取第一张工作表） */
function tableOf(f: { csv?: string; xlsxBase64?: string }): string[][] {
  if (f.csv !== undefined) {
    try {
      return csvToTable(f.csv.replace(/^﻿/, ''));
    } catch (error) {
      throw unprocessable('IMPORT_FILE_INVALID', error instanceof Error ? error.message : '文件读不出来');
    }
  }
  let book;
  try {
    book = readXlsx(Buffer.from(f.xlsxBase64!, 'base64'), { maxRow: 5000 });
  } catch (error) {
    if (error instanceof XlsxReadError) throw unprocessable('IMPORT_FILE_INVALID', error.message);
    throw error;
  }
  const sheet = book.sheets[0];
  if (!sheet) throw unprocessable('IMPORT_EMPTY', 'Excel 文件里没有工作表');
  const last = Math.max(0, ...sheet.rows.keys());
  const out: string[][] = [];
  for (let r = 1; r <= last; r += 1) {
    const cells = sheet.rows.get(r);
    const width = cells ? Math.max(0, ...cells.keys()) + 1 : 0;
    out.push(Array.from({ length: width }, (_, c) => cells?.get(c)?.value ?? ''));
  }
  return out;
}

interface Existing {
  id: number;
  techNo: string;
  name: string;
  gender: string;
  grade: string;
  nickname: string;
  phone: string;
  groupId: number | null;
  heightCm: number | null;
  weightKg: number | null;
  star: number | null;
  updatedAt: string;
}

const gk = (name: string) => name.trim().toLowerCase();

/** 按名册现在的样子算出每一行要做什么（预览与生效同一个函数）；有问题的写进 errors */
async function plan(tx: Tx, f: z.output<typeof FileInput>): Promise<{ preview: TechnicianImportPreview; rows: TechnicianImportRowLoose[]; existing: Map<string, Existing> }> {
  const gradeMap = f.gradeMap ? parseGradeMap(f.gradeMap) : {};
  if (typeof gradeMap === 'string') throw unprocessable('IMPORT_GRADE_MAP', gradeMap);
  const parsed = parseTechnicianTableLoose(tableOf(f), { gradeMap });
  const storeId = currentStoreId();
  const existing = new Map(
    (
      await tx<Existing[]>`
        SELECT id, tech_no, name, gender, grade, nickname, phone, group_id, height_cm, weight_kg, star, updated_at FROM technicians WHERE store_id = ${storeId}`
    ).map((t) => [t.techNo, t]),
  );
  const groupRows = await tx<{ id: number; name: string; active: boolean }[]>`SELECT id, name, active FROM technician_groups WHERE store_id = ${storeId}`;
  const groups = new Map(groupRows.map((g) => [gk(g.name), g]));
  const groupName = new Map(groupRows.map((g) => [Number(g.id), g.name]));
  const errors = [...parsed.errors];
  const out: TechnicianImportPreview['rows'] = [];
  const newGroups = new Map<string, string>();
  const reactivate = new Map<string, string>();
  for (const r of parsed.rows) {
    if (r.group) {
      const g = groups.get(gk(r.group));
      if (!g) newGroups.set(gk(r.group), r.group);
      else if (!g.active) reactivate.set(gk(r.group), g.name);
    }
    const had = existing.get(r.techNo);
    if (!had) {
      const gender = r.gender ?? f.defaultGender;
      if (!gender) {
        errors.push({ line: r.line, message: `工号 ${r.techNo} 是新技师，要写性别（或在上面选「没写性别的按」）` });
        continue;
      }
      out.push({ line: r.line, techNo: r.techNo, name: r.name, action: 'create', changes: [`${gender === 'male' ? '男' : '女'}，${PRICE_TIER_LABELS[r.grade]}`, ...profileText(r)], notes: [] });
      continue;
    }
    const changes: string[] = [];
    if (r.nickname && r.nickname !== had.nickname) changes.push(`花名 ${had.nickname || '空'} → ${r.nickname}`);
    if (r.phone !== null && r.phone !== had.phone) changes.push(`电话 ${had.phone ? maskPhone(had.phone) : '空'} → ${maskPhone(r.phone)}`);
    if (r.group) {
      const g = groups.get(gk(r.group));
      if (!g || Number(g.id) !== had.groupId) changes.push(`组别 ${had.groupId === null ? '空' : (groupName.get(had.groupId) ?? '')} → ${r.group}`);
    }
    if (r.heightCm !== null && r.heightCm !== had.heightCm) changes.push(`身高 ${had.heightCm ?? '空'} → ${r.heightCm} 厘米`);
    if (r.weightKg !== null && r.weightKg !== had.weightKg) changes.push(`体重 ${had.weightKg ?? '空'} → ${r.weightKg} 公斤`);
    if (r.star !== null && r.star !== had.star) changes.push(`星级 ${had.star ?? '空'} → ${r.star} 星`);
    const notes: string[] = [];
    if (r.name !== had.name) notes.push(`名册里叫「${had.name}」，姓名不改`);
    if (r.gender && r.gender !== had.gender) notes.push('性别与名册不同，不改');
    out.push({ line: r.line, techNo: r.techNo, name: had.name, action: changes.length ? 'update' : 'same', changes, notes });
  }
  errors.sort((a, b) => a.line - b.line);
  const preview: TechnicianImportPreview = {
    fileName: f.fileName,
    total: parsed.rows.length + parsed.errors.length,
    create: out.filter((r) => r.action === 'create').length,
    update: out.filter((r) => r.action === 'update').length,
    same: out.filter((r) => r.action === 'same').length,
    groupsCreated: [...newGroups.values()],
    groupsReactivated: [...reactivate.values()],
    errors,
    rows: out,
    planHash: '',
    applied: false,
  };
  // 摘要：要做的事 + 要改的那几位技师此刻的版本（预览以后被别人改过就对不上）
  const touched = out.filter((r) => r.action === 'update').map((r) => existing.get(r.techNo)!);
  preview.planHash = createHash('sha256')
    .update(JSON.stringify({ rows: parsed.rows, out, errors, groups: preview.groupsCreated, versions: touched.map((t) => [t.id, new Date(t.updatedAt).toISOString()]), store: storeId }))
    .digest('hex');
  return { preview, rows: parsed.rows, existing };
}

function profileText(r: TechnicianImportRowLoose): string[] {
  return [
    r.nickname ? `花名 ${r.nickname}` : '',
    r.phone ? `电话 ${maskPhone(r.phone)}` : '',
    r.group ? `组别 ${r.group}` : '',
    r.heightCm !== null ? `身高 ${r.heightCm} 厘米` : '',
    r.weightKg !== null ? `体重 ${r.weightKg} 公斤` : '',
    r.star !== null ? `${r.star} 星` : '',
  ].filter(Boolean);
}

const lockImport = (tx: Tx) => tx`SELECT pg_advisory_xact_lock(hashtext(${`technician_import:${currentStoreId()}`}))`;

export async function previewTechnicianImport(deps: Deps, raw: unknown): Promise<TechnicianImportPreview> {
  const f = parse(FileInput, raw);
  return deps.sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    return (await plan(tx, f)).preview;
  });
}

export async function applyTechnicianImport(deps: Deps, raw: unknown, ctx: OpContext): Promise<TechnicianImportPreview> {
  const f = parse(ApplyInput, raw);
  return deps.sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    await lockImport(tx);
    const { preview, rows, existing } = await plan(tx, f);
    if (preview.errors.length) throw unprocessable('IMPORT_INVALID', `有 ${preview.errors.length} 行要改，一行都没有导入；改好后重新预览`);
    if (preview.planHash !== f.planHash) throw conflict('IMPORT_STALE', '预览以后名册或文件变了，请重新预览再导入');
    const storeId = currentStoreId();
    const byNo = new Map(rows.map((r) => [r.techNo, r]));
    // 组别：停用的同名组重新启用、没有的建
    if (preview.groupsReactivated.length) {
      await tx`UPDATE technician_groups SET active = true WHERE store_id = ${storeId} AND NOT active AND lower(btrim(name)) IN ${tx(preview.groupsReactivated.map(gk))}`;
    }
    const [top] = await tx<{ start: number }[]>`SELECT coalesce(max(sort_order), 0)::int AS start FROM technician_groups WHERE store_id = ${storeId}`;
    for (const [i, name] of preview.groupsCreated.entries()) {
      await tx`INSERT INTO technician_groups (store_id, name, sort_order, created_by) VALUES (${storeId}, ${name}, ${Math.min(9999, (top?.start ?? 0) + i + 1)}, ${ctx.actor.id})`;
    }
    const groups = new Map((await tx<{ id: number; name: string }[]>`SELECT id, name FROM technician_groups WHERE store_id = ${storeId}`).map((g) => [gk(g.name), Number(g.id)]));
    const groupOf = (name: string | null) => (name ? (groups.get(gk(name)) ?? null) : null);
    for (const p of preview.rows.filter((x) => x.action === 'create')) {
      const r = byNo.get(p.techNo)!;
      await tx`
        INSERT INTO technicians (store_id, tech_no, name, gender, grade, skills, active, sort_order, note, created_by, nickname, kind, hired_on, group_id,
                                 phone, height_cm, weight_kg, star)
        VALUES (${storeId}, ${r.techNo}, ${r.name}, ${r.gender ?? f.defaultGender!}, ${r.grade}, '{}'::text[], true, 0, '', ${ctx.actor.id}, ${r.nickname}, '', ${r.hiredOn},
                ${groupOf(r.group)}, ${r.phone ?? ''}, ${r.heightCm}, ${r.weightKg}, ${r.star})`;
    }
    const updates = preview.rows.filter((x) => x.action === 'update').sort((a, b) => existing.get(a.techNo)!.id - existing.get(b.techNo)!.id);
    for (const p of updates) {
      const r = byNo.get(p.techNo)!;
      const had = existing.get(p.techNo)!;
      // 锁住以后再核对一次版本：plan() 读名册到这里之间别人改过这位技师（编辑不取导入的咨询锁），就整批拒绝、
      // 不拿读到的旧值盖掉别人的修改（8.2.5，Codex 审查）。锁的顺序照旧：组别在前、技师在后
      const [now] = await tx<{ updatedAt: Date }[]>`SELECT updated_at FROM technicians WHERE id = ${had.id} FOR UPDATE`;
      if (!now || new Date(now.updatedAt).getTime() !== new Date(had.updatedAt).getTime()) {
        throw conflict('IMPORT_STALE', `预览以后 ${p.techNo} 号的档案被改过，请重新预览再导入`);
      }
      await tx`
        UPDATE technicians SET nickname = ${r.nickname || had.nickname}, phone = ${r.phone ?? had.phone}, group_id = ${r.group ? groupOf(r.group) : had.groupId},
               height_cm = ${r.heightCm ?? had.heightCm}, weight_kg = ${r.weightKg ?? had.weightKg}, star = ${r.star ?? had.star}, updated_at = now()
        WHERE id = ${had.id}`;
    }
    await writeAudit(tx, {
      staffId: ctx.actor.id,
      action: 'technicians_imported_web',
      targetType: 'technician',
      detail: {
        fileName: f.fileName,
        summary: `网页导入技师名册（${f.fileName}）：新建 ${preview.create} 位、更新 ${preview.update} 位、不变 ${preview.same} 位，新建分组 ${preview.groupsCreated.length} 个`,
        created: preview.rows.filter((x) => x.action === 'create').map((x) => x.techNo),
        updated: updates.map((x) => ({ techNo: x.techNo, changes: x.changes })),
      },
      ip: ctx.ip,
    });
    return { ...preview, applied: true };
  });
}

/** 模板：第一行是填写须知（导入时跳过），第二行是表头 */
export function technicianImportTemplate(): string {
  return toCsv([
    ['填写须知：一行一位技师；工号、姓名必填，新技师还要写性别；电话 11 位；身高写厘米、体重写公斤（写「斤」的按一半算）；星级 1–10；技师等级写 标准 / 专业 / 优选（不写按标准）；这一行导入时跳过'],
    [...TECHNICIAN_IMPORT_HEADERS],
  ]);
}

export function registerTechnicianWebImportRoutes(app: FastifyInstance, deps: Deps) {
  const manage = { preHandler: guard('technician.manage'), bodyLimit: 8_000_000 };
  app.get('/api/admin/technicians/import-template.csv', { preHandler: guard('technician.manage') }, async (_req, reply) => csvReply(reply, '技师导入模板.csv', technicianImportTemplate()));
  app.post('/api/admin/technicians/import/preview', manage, async (req) => previewTechnicianImport(deps, req.body));
  app.post('/api/admin/technicians/import', manage, async (req) => applyTechnicianImport(deps, req.body, ctxOf(req)));
}
