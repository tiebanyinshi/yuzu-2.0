// 手牌池：按清单导入、批量建牌、锁定 / 解锁、改分区与柜型、停用。在店手牌不能改分区、柜型、停用或锁定（先换牌）。
// 8.1.15：手牌绑芯片号（card_uid），发牌时刷卡带出牌号（docs/FRONTDESK_RISK_V8115.md 第 2 节）。
// 手牌管理（店主 2026-11-24，docs/FRONTDESK_TAGS_V8127.md）：按规则批量生成（数量、起始号码、排除尾数 / 含某数字的号）、
// 改牌号、删除（发过的标「已删除」）、柜子标「暂停使用 / 维修中」（前台发不出）。在店的手牌这些都不能做。

import { z } from 'zod';
import {
  MAX_VIP_LEVEL,
  normalizeTagCode,
  planTagCodes,
  tagArea,
  TAG_CODE_PATTERN,
  TAG_GENERATE_MAX,
  TAG_KINDS,
  TAG_SERVICE_LABELS,
  TAG_SERVICE_STATUSES,
  ZONES,
  type HandTag,
} from '@shared/frontdesk';
import { HAND_TAG_IMPORT_MAX_ROWS, type HandTagImportReport } from '@shared/hand-tag-import';
import { CARD_UID_PATTERN, normalizeCardUid, type TagByCard } from '@shared/frontdesk-risk';
import { isUniqueViolation, type Db, type Sql } from '../../db';
import { writeAudit } from '../../lib/audit';
import type { OpContext } from '../../lib/context';
import { badRequest, conflict, notFound } from '../../lib/errors';
import { parse } from '../../lib/validate';
import type { Deps } from '../../lib/context';
import { setTxTimeouts } from './common';
import { lockCardBindings } from '../../lib/card-bindings';
import { assertNotFenced } from '../../lib/fences';
import { hashRequest } from '../../lib/idempotency';
import { erpOpAbandoned } from '../erp-ops';
import { currentStoreId } from '../../lib/store-context';

export async function listTags(
  db: Db,
): Promise<(HandTag & { inUse: boolean; lockedByName: string | null; lockedAt: string | null; cardUid: string | null; serviceByName: string | null; serviceAt: string | null })[]> {
  return db`
    SELECT t.id, t.code, t.zone, t.kind, t.vip_level, t.locked, t.lock_reason, t.active, t.is_synthetic, t.locked_at, t.card_uid,
           t.service_status, t.service_note, t.service_at,
           s.display_name AS locked_by_name, ss.display_name AS service_by_name,
           EXISTS (SELECT 1 FROM visits v WHERE v.tag_id = t.id AND v.status = 'open') AS in_use
    FROM hand_tags t LEFT JOIN staff s ON s.id = t.locked_by LEFT JOIN staff ss ON ss.id = t.service_by
    WHERE t.store_id = ${currentStoreId()} AND t.deleted_at IS NULL
    ORDER BY CASE t.zone WHEN 'male' THEN 0 WHEN 'female' THEN 1 ELSE 2 END, t.kind = 'vip', t.vip_level,
             regexp_replace(t.code, '[0-9]', '', 'g'), length(t.code), t.code`;
}

const vipLevel = z.number().int().min(1, 'VIP 等级从 1 开始').max(MAX_VIP_LEVEL, `VIP 等级最多 ${MAX_VIP_LEVEL} 级`).nullable().default(null);
const kindLevelOk = (v: { kind: string; vipLevel: number | null }) => (v.kind === 'vip') === (v.vipLevel !== null);
const KIND_LEVEL_MESSAGE = 'VIP 柜需要选择等级，普通柜不设等级';

export const BatchInput = z
  .object({
    prefix: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z]{0,2}$/, '前缀只能是 0–2 个英文字母'),
    from: z.number().int().min(0).max(99999),
    to: z.number().int().min(0).max(99999),
    /** 数字位数，不足补 0，例如 3 → 001 */
    width: z.number().int().min(1).max(5),
    zone: z.enum(ZONES, '请选择男宾或女宾'),
    kind: z.enum(TAG_KINDS, '请选择柜型').default('normal'),
    vipLevel,
  })
  .refine(kindLevelOk, KIND_LEVEL_MESSAGE)
  .refine((v) => v.to >= v.from, '结束号不能小于起始号')
  .refine((v) => v.to - v.from < 500, '一次最多建 500 张手牌')
  .refine((v) => String(v.to).length <= v.width, '结束号的位数超过了设定位数');

export async function batchCreate(deps: Deps, raw: unknown, ctx: OpContext) {
  const input = parse(BatchInput, raw);
  const codes: string[] = [];
  for (let n = input.from; n <= input.to; n++) codes.push(`${input.prefix}${String(n).padStart(input.width, '0')}`);
  if (!codes.every((c) => TAG_CODE_PATTERN.test(c))) throw badRequest('生成的牌号格式不正确');
  return deps.sql.begin(async (tx) => {
    const rows = await tx<{ code: string }[]>`
      INSERT INTO hand_tags (code, zone, kind, vip_level) SELECT unnest(${codes}::text[]), ${input.zone}, ${input.kind}, ${input.vipLevel}
      ON CONFLICT (store_id, code) DO NOTHING RETURNING code`;
    await writeAudit(tx, {
      staffId: ctx.actor.id,
      action: 'hand_tags_created',
      targetType: 'hand_tag',
      detail: { ...input, created: rows.length, skipped: codes.length - rows.length },
      ip: ctx.ip,
    });
    return { created: rows.length, skipped: codes.filter((c) => !rows.some((r) => r.code === c)) };
  });
}

/**
 * 先锁定手牌行，再用单独的查询判断是否在店。
 * 不能把占用判断写进同一条 FOR UPDATE 语句：等锁期间发牌事务提交的来访，对那条语句的快照不可见，
 * 会把刚发出的手牌误判为空闲，于是锁定 / 停用 / 改分区与发牌同时成功。
 */
async function lockTag(tx: Db, id: number) {
  const [tag] = await tx<{ id: number; code: string; zone: string; kind: string; vipLevel: number | null; locked: boolean; active: boolean; serviceStatus: string; serviceNote: string | null }[]>`
    SELECT id, code, zone, kind, vip_level, locked, active, service_status, service_note FROM hand_tags
    WHERE id = ${id} AND store_id = ${currentStoreId()} AND deleted_at IS NULL FOR UPDATE`;
  if (!tag) throw notFound('手牌不存在（可能刚被删除），请刷新');
  const [use] = await tx<{ inUse: boolean }[]>`
    SELECT EXISTS (SELECT 1 FROM visits WHERE tag_id = ${id} AND status = 'open') AS in_use`;
  return { ...tag, inUse: use!.inUse };
}

export const LockInput = z.object({ reason: z.string().trim().min(2, '请填写锁定原因（至少 2 个字）').max(100, '原因最多 100 字') });

export async function lockHandTag(deps: Deps, id: number, raw: unknown, ctx: OpContext) {
  const input = parse(LockInput, raw);
  await deps.sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    const tag = await lockTag(tx, id);
    if (tag.inUse) throw conflict('TAG_IN_USE', `手牌 ${tag.code} 上有在店客人，请先给客人换牌并勾选「锁定原手牌」`);
    if (tag.locked) throw conflict('TAG_ALREADY_LOCKED', `手牌 ${tag.code} 已经是锁定状态`);
    await tx`
      UPDATE hand_tags SET locked = true, lock_reason = ${input.reason}, locked_by = ${ctx.actor.id}, locked_at = now(), updated_at = now()
      WHERE id = ${id}`;
    await writeAudit(tx, { staffId: ctx.actor.id, action: 'hand_tag_locked', targetType: 'hand_tag', targetId: id, detail: { code: tag.code, reason: input.reason }, ip: ctx.ip });
  });
}

export async function unlockHandTag(deps: Deps, id: number, ctx: OpContext) {
  await deps.sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    const tag = await lockTag(tx, id);
    if (!tag.locked) return;
    await tx`UPDATE hand_tags SET locked = false, lock_reason = NULL, locked_by = NULL, locked_at = NULL, updated_at = now() WHERE id = ${id}`;
    await writeAudit(tx, { staffId: ctx.actor.id, action: 'hand_tag_unlocked', targetType: 'hand_tag', targetId: id, detail: { code: tag.code }, ip: ctx.ip });
  });
}

export const UpdateInput = z
  .object({
    /** 改牌号（不带就不改）：在店的、和别的牌重号的不行 */
    code: z.string().transform(normalizeTagCode).pipe(z.string().regex(TAG_CODE_PATTERN, '牌号是 0–2 个字母加 1–5 位数字，例如 A023')).optional(),
    zone: z.enum(ZONES, '请选择男宾或女宾'),
    active: z.boolean(),
    // 旧版本页面不带柜型时保持原样
    kind: z.enum(TAG_KINDS, '请选择柜型').optional(),
    vipLevel: vipLevel.optional(),
  })
  .refine((v) => v.kind === undefined || kindLevelOk({ kind: v.kind, vipLevel: v.vipLevel ?? null }), KIND_LEVEL_MESSAGE);

export async function updateHandTag(deps: Deps, id: number, raw: unknown, ctx: OpContext) {
  const input = parse(UpdateInput, raw);
  await deps.sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    const tag = await lockTag(tx, id);
    const kind = input.kind ?? tag.kind;
    const level = input.kind === undefined ? tag.vipLevel : (input.vipLevel ?? null);
    const code = input.code ?? tag.code;
    if (tag.inUse && (code !== tag.code || tag.zone !== input.zone || !input.active || tag.kind !== kind || tag.vipLevel !== level)) {
      throw conflict('TAG_IN_USE', `手牌 ${tag.code} 上有在店客人，不能改牌号、分区、柜型或停用`);
    }
    if (code !== tag.code) {
      // 发过的牌不能改号：结账单、换牌记录都按手牌现在的牌号显示，改了会把历史单据上的牌号一起改掉（Codex 审查 PR #189）
      const [hist] = await tx<{ used: boolean }[]>`
        SELECT EXISTS (SELECT 1 FROM visits WHERE tag_id = ${id})
            OR EXISTS (SELECT 1 FROM visit_tag_changes WHERE from_tag_id = ${id} OR to_tag_id = ${id}) AS used`;
      if (hist?.used) throw conflict('TAG_HAS_HISTORY', `手牌 ${tag.code} 发过，历史单据按牌号显示，不能改号；要换号请删除这张，再按新号添加`);
      const [taken] = await tx<{ deleted: boolean }[]>`SELECT deleted_at IS NOT NULL AS deleted FROM hand_tags WHERE store_id = ${currentStoreId()} AND code = ${code}`;
      if (taken) throw conflict('TAG_CODE_TAKEN', `牌号 ${code} 已经有了${taken.deleted ? '（是删除了的牌，在「建牌与导入」里按清单导入这个牌号可以恢复）' : ''}，换一个`);
    }
    try {
      await tx`
        UPDATE hand_tags SET code = ${code}, zone = ${input.zone}, active = ${input.active}, kind = ${kind}, vip_level = ${level}, updated_at = now()
        WHERE id = ${id}`;
    } catch (e) {
      if (isUniqueViolation(e)) throw conflict('TAG_CODE_TAKEN', `牌号 ${code} 刚被别人建了，换一个`);
      throw e;
    }
    await writeAudit(tx, {
      staffId: ctx.actor.id,
      action: 'hand_tag_updated',
      targetType: 'hand_tag',
      targetId: id,
      detail: {
        code: tag.code,
        summary: code !== tag.code ? `手牌 ${tag.code} 改成 ${code}` : `修改了手牌 ${tag.code}`,
        before: { code: tag.code, zone: tag.zone, active: tag.active, kind: tag.kind, vipLevel: tag.vipLevel },
        after: { code, zone: input.zone, active: input.active, kind, vipLevel: level },
      },
      ip: ctx.ip,
    });
  });
}

// ───────────────────────── 手牌管理（店主 2026-11-24） ─────────────────────────

export const GenerateInput = z
  .object({
    prefix: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z]{0,2}$/, '前缀只能是 0–2 个英文字母'),
    start: z.number('请填起始号码').int('起始号码要是整数').min(0, '起始号码不能小于 0').max(99999, '起始号码最多 5 位'),
    count: z.number('请填数量').int('数量要是整数').min(1, '数量至少 1').max(TAG_GENERATE_MAX, `一次最多生成 ${TAG_GENERATE_MAX} 张`),
    width: z.number().int().min(1).max(5),
    zone: z.enum(ZONES, '请选择男宾或女宾'),
    kind: z.enum(TAG_KINDS, '请选择柜型').default('normal'),
    vipLevel,
    skipEndDigits: z.array(z.number().int().min(0).max(9)).max(10).default([]),
    skipAnyDigits: z.array(z.number().int().min(0).max(9)).max(10).default([]),
    /** 只预览，不建 */
    preview: z.boolean().default(false),
    /** 添加时要：操作编号（结果待确认时查回、原样重提返回第一次的结果，或确认作废；Codex 审查 PR #189） */
    clientKey: z.uuid('操作编号格式不正确').optional(),
    /** 添加时要：提交时所在的门店（本机记下的原请求换了门店再重提时拒绝，免得建到别的店；Codex 审查 PR #191） */
    storeId: z.number().int().positive().optional(),
  })
  .refine(kindLevelOk, KIND_LEVEL_MESSAGE)
  .refine((v) => String(v.start).length <= v.width, '起始号码的位数超过了设定位数')
  .refine((v) => new Set([...v.skipEndDigits, ...v.skipAnyDigits]).size < 10, '排除的数字不能把 0–9 都排除了');

/**
 * 按规则批量生成：从起始号码往后数，排除尾数 / 含某数字的号，已有的牌号（含删除了的）跳过，凑够数量。
 * 在台账锁里算：两个人同时生成不会撞号（撞了也由唯一约束兜底，整笔拒绝、请重新预览）。
 */
export async function generateTags(deps: Deps, raw: unknown, ctx: OpContext) {
  const input = parse(GenerateInput, raw);
  const plan = async (db: Db) => {
    const existing = new Set((await db<{ code: string }[]>`SELECT code FROM hand_tags WHERE store_id = ${currentStoreId()}`).map((r) => r.code));
    const p = planTagCodes(input, existing);
    if (!p.codes.length) throw conflict('TAG_GENERATE_EMPTY', '按这个规则一张也生成不出来（号码用完了或都已存在），换起始号码、位数或前缀');
    return p;
  };
  if (input.preview) return { ...(await plan(deps.sql)), created: 0, replayed: false };
  if (!input.clientKey) throw badRequest('缺少有效的操作编号，请刷新页面后重试');
  if (input.storeId === undefined) throw badRequest('缺少提交时的门店，请刷新页面后重试');
  if (input.storeId !== currentStoreId()) throw conflict('STORE_MISMATCH', '这笔批量添加是在另一家门店提交的：请切回原来的门店再查回或重提');
  const key = input.clientKey;
  const requestHash = hashRequest({ op: 'hand_tag_generate', ...input, clientKey: undefined, preview: undefined });
  return deps.sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    // 同一个编号排队、确认作废过的不再写入；原样重提返回第一次建的那些牌号，换了内容拒绝
    await assertNotFenced(tx, key, 'hand_tag_generate', erpOpAbandoned);
    const [seen] = await tx<{ id: number; requestHash: string; codes: string[] }[]>`SELECT id, request_hash, codes FROM hand_tag_generate_ops WHERE op_key = ${key}`;
    if (seen) {
      if (seen.requestHash !== requestHash) throw conflict('IDEMPOTENCY_CONFLICT', '该操作编号已用于另一次批量添加，请刷新页面后重新预览');
      return { codes: seen.codes, skippedByRule: 0, skippedExisting: [], exhausted: false, created: seen.codes.length, replayed: true, opId: Number(seen.id) };
    }
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`hand_tags_generate:${currentStoreId()}`}, 0))`;
    const p = await plan(tx);
    try {
      await tx`
        INSERT INTO hand_tags (code, zone, kind, vip_level) SELECT unnest(${p.codes}::text[]), ${input.zone}, ${input.kind}, ${input.vipLevel}`;
    } catch (e) {
      if (isUniqueViolation(e)) throw conflict('TAG_CODE_TAKEN', '有牌号刚被别人建了，请重新预览后再生成');
      throw e;
    }
    const [op] = await tx<{ id: number }[]>`
      INSERT INTO hand_tag_generate_ops (op_key, store_id, request_hash, codes, created_by)
      VALUES (${key}, ${currentStoreId()}, ${requestHash}, ${p.codes}::text[], ${ctx.actor.id})
      RETURNING id`;
    await writeAudit(tx, {
      staffId: ctx.actor.id,
      action: 'hand_tags_created',
      targetType: 'hand_tag',
      detail: {
        rule: { prefix: input.prefix, start: input.start, count: input.count, width: input.width, skipEndDigits: input.skipEndDigits, skipAnyDigits: input.skipAnyDigits },
        zone: input.zone,
        kind: input.kind,
        vipLevel: input.vipLevel,
        created: p.codes.length,
        first: p.codes[0],
        last: p.codes.at(-1),
      },
      ip: ctx.ip,
    });
    return { ...p, created: p.codes.length, replayed: false, opId: Number(op!.id) };
  });
}

/**
 * 删除一张手牌：在店的不能删；从来没发过的直接删掉；发过的（来访、换牌记录引用着它）标「已删除」并停用，
 * 手牌池与前台都不再列出，历史单据照旧显示牌号。
 */
export async function deleteHandTag(deps: Deps, id: number, ctx: OpContext) {
  return deps.sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    const tag = await lockTag(tx, id);
    if (tag.inUse) throw conflict('TAG_IN_USE', `手牌 ${tag.code} 上有在店客人，不能删除；请先在前台给客人换牌`);
    // 手牌表本来就禁止物理删除（004 迁移的触发器：历史来访、换牌记录还引用它）：删除 = 停用并标「已删除」，
    // 后台列表、前台都不再出现，牌号不再被生成；按清单导入同一个牌号可以恢复
    await tx`UPDATE hand_tags SET active = false, deleted_at = now(), deleted_by = ${ctx.actor.id}, card_uid = NULL, updated_at = now() WHERE id = ${id}`;
    const [hist] = await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM visits WHERE tag_id = ${id}`;
    const used = { used: (hist?.n ?? 0) > 0 };
    await writeAudit(tx, {
      staffId: ctx.actor.id,
      action: 'hand_tag_updated',
      targetType: 'hand_tag',
      targetId: id,
      detail: { summary: `删除了手牌 ${tag.code}${used.used ? '（发过的，历史照旧可查）' : ''}`, code: tag.code, deleted: true, kept: used.used },
      ip: ctx.ip,
    });
    return { code: tag.code, kept: used.used };
  });
}

export const ServiceInput = z
  .object({
    status: z.enum(TAG_SERVICE_STATUSES, '状态不对'),
    note: z.string().trim().max(100, '说明最多 100 字').default(''),
  })
  .transform((v) => ({ status: v.status, note: v.status === 'normal' ? null : v.note || null }));

/** 手牌柜标「暂停使用 / 维修中」或恢复正常：在店的不能标（先换牌）；恢复正常随时可以 */
export async function setTagService(deps: Deps, id: number, raw: unknown, ctx: OpContext) {
  const input = parse(ServiceInput, raw);
  await deps.sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    const tag = await lockTag(tx, id);
    if (tag.serviceStatus === input.status && tag.serviceNote === input.note) return;
    if (input.status !== 'normal' && tag.inUse) throw conflict('TAG_IN_USE', `手牌 ${tag.code} 上有在店客人，不能标「${TAG_SERVICE_LABELS[input.status]}」；请先在前台给客人换牌`);
    await tx`
      UPDATE hand_tags SET service_status = ${input.status}, service_note = ${input.note},
             service_by = ${input.status === 'normal' ? null : ctx.actor.id}, service_at = ${input.status === 'normal' ? null : new Date()}, updated_at = now()
      WHERE id = ${id}`;
    await writeAudit(tx, {
      staffId: ctx.actor.id,
      action: 'hand_tag_updated',
      targetType: 'hand_tag',
      targetId: id,
      detail: {
        summary: `手牌 ${tag.code}：${TAG_SERVICE_LABELS[tag.serviceStatus as keyof typeof TAG_SERVICE_LABELS] ?? tag.serviceStatus} → ${TAG_SERVICE_LABELS[input.status]}${input.note ? `（${input.note}）` : ''}`,
        code: tag.code,
        before: { serviceStatus: tag.serviceStatus, serviceNote: tag.serviceNote },
        after: { serviceStatus: input.status, serviceNote: input.note },
      },
      ip: ctx.ip,
    });
  });
}

// ───────────────────────── 按清单导入 ─────────────────────────

export const ImportInput = z.object({
  rows: z
    .array(
      z
        .object({
          code: z.string().transform(normalizeTagCode).pipe(z.string().regex(TAG_CODE_PATTERN, '牌号格式不正确')),
          zone: z.enum(ZONES, '性别应为 male / female'),
          kind: z.enum(TAG_KINDS, '柜型应为 normal / vip'),
          vipLevel,
          /** 8.1.35：芯片号；不带 = 不动已有的，null = 清单里这一格是空的（也不动，不解绑） */
          cardUid: z.string().transform(normalizeCardUid).pipe(z.string().regex(CARD_UID_PATTERN, '芯片号应为 4–32 位数字或字母')).nullable().optional(),
        })
        .refine(kindLevelOk, KIND_LEVEL_MESSAGE),
    )
    .min(1, '清单里没有柜号')
    .max(HAND_TAG_IMPORT_MAX_ROWS, `一次最多导入 ${HAND_TAG_IMPORT_MAX_ROWS} 个柜号`),
  /** 同时停用不在清单里的手牌（在店的不动） */
  deactivateMissing: z.boolean().default(false),
  /** 只预览，不写入 */
  dryRun: z.boolean().default(true),
});
export type ImportInputData = z.input<typeof ImportInput>;

/**
 * 按清单导入：清单是柜池的准确描述。
 *   · 新牌号 → 建立；已有牌号 → 分区、柜型、等级以清单为准，停用的恢复启用；锁定状态不变；
 *   · 在店的手牌不改动（先换牌），列入 blocked；
 *   · 勾选 deactivateMissing 时，停用清单外的空闲手牌；
 *   · 先锁定全部手牌（id 升序）再判断在店，与发牌、换牌串行。
 */
export async function importHandTags(
  sql: Sql,
  raw: ImportInputData,
  audit: { staffId: number | null; ip?: string; via: 'web' | 'cli' | 'demo' },
  options: { synthetic?: boolean } = {},
): Promise<HandTagImportReport> {
  const input = parse(ImportInput, raw);
  const dupes = input.rows.map((r) => r.code).filter((c, i, all) => all.indexOf(c) !== i);
  if (dupes.length) throw badRequest(`清单里牌号重复：${[...new Set(dupes)].slice(0, 5).join('、')}`);
  return sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    // 8.2.21：芯片号绑定锁在前（与手牌绑卡、技师绑工牌同一把），再锁手牌
    if (!input.dryRun) await lockCardBindings(tx);
    const existing = await tx<{ id: number; code: string; zone: string; kind: string; vipLevel: number | null; active: boolean; cardUid: string | null }[]>`
      SELECT id, code, zone, kind, vip_level, active, card_uid FROM hand_tags WHERE store_id = ${currentStoreId()} ORDER BY id ${input.dryRun ? tx`` : tx`FOR UPDATE`}`;
    // 芯片号（8.1.35）：清单里的芯片号已经绑在本店另一张手牌上的，这一行的芯片号不导（报出来，牌照常导）
    const uidOwner = new Map(existing.filter((t) => t.cardUid).map((t) => [t.cardUid!, t.code]));
    // 8.2.21（Codex 审查）：技师工牌的芯片号不导到手牌上（牌照常导）
    const techCards = await tx<{ cardUid: string; techNo: string }[]>`
      SELECT card_uid, tech_no FROM technicians WHERE store_id = ${currentStoreId()} AND card_uid IS NOT NULL`;
    for (const t of techCards) uidOwner.set(t.cardUid, `技师 ${t.techNo} 号的工牌`);
    const uidOf = (r: (typeof input.rows)[number]) => {
      if (!r.cardUid) return undefined;
      const owner = uidOwner.get(r.cardUid);
      return owner && owner !== r.code ? undefined : r.cardUid;
    };
    const inUse = new Set((await tx<{ tagId: number }[]>`SELECT tag_id FROM visits WHERE status = 'open'`).map((r) => r.tagId));
    const byCode = new Map(existing.map((t) => [t.code, t]));
    const listed = new Set(input.rows.map((r) => r.code));

    const create: typeof input.rows = [];
    const update: { id: number; code: string; zone: string; kind: string; vipLevel: number | null; cardUid: string | null }[] = [];
    const blocked: HandTagImportReport['blocked'] = [];
    let unchanged = 0;
    for (const r of input.rows) {
      if (r.cardUid && uidOf(r) === undefined) blocked.push({ code: r.code, reason: `芯片号 ${r.cardUid} 已绑在 ${uidOwner.get(r.cardUid)} 上，这一张的芯片号没导（牌照常导）` });
    }
    for (const r of input.rows) {
      const t = byCode.get(r.code);
      if (!t) {
        create.push(r);
        continue;
      }
      const uid = uidOf(r) ?? t.cardUid;
      const same = t.zone === r.zone && t.kind === r.kind && t.vipLevel === r.vipLevel && uid === t.cardUid;
      if (same && t.active) {
        unchanged += 1;
      } else if (!same && inUse.has(t.id)) {
        blocked.push({ code: r.code, reason: '在店，分区或柜型未修改（客人换牌后再导入）' });
      } else {
        update.push({ id: t.id, code: r.code, zone: r.zone, kind: r.kind, vipLevel: r.vipLevel, cardUid: uid });
      }
    }
    const deactivate: { id: number; code: string }[] = [];
    if (input.deactivateMissing) {
      for (const t of existing) {
        if (listed.has(t.code) || !t.active) continue;
        if (inUse.has(t.id)) blocked.push({ code: t.code, reason: '不在清单里，但有在店客人，未停用' });
        else deactivate.push({ id: t.id, code: t.code });
      }
    }

    const groupKey = (r: (typeof input.rows)[number]) => `${r.zone}|${r.kind}|${r.vipLevel ?? ''}|${r.kind === 'vip' ? '' : tagArea(r.code)}`;
    const groups = new Map<string, HandTagImportReport['groups'][number]>();
    for (const r of input.rows) {
      const k = groupKey(r);
      const g = groups.get(k) ?? { zone: r.zone, kind: r.kind, vipLevel: r.vipLevel, area: r.kind === 'vip' ? '' : tagArea(r.code), count: 0 };
      g.count += 1;
      groups.set(k, g);
    }

    if (!input.dryRun) {
      if (create.length) {
        const rows = await tx<{ code: string }[]>`
          INSERT INTO hand_tags (code, zone, kind, vip_level, is_synthetic, card_uid)
          SELECT u.code, u.zone, u.kind, u.vip_level, ${options.synthetic ?? false}, u.card_uid
          FROM unnest(${create.map((r) => r.code)}::text[], ${create.map((r) => r.zone)}::text[], ${create.map((r) => r.kind)}::text[],
                      ${create.map((r) => r.vipLevel) as never}::smallint[], ${create.map((r) => uidOf(r) ?? null) as never}::text[]) AS u(code, zone, kind, vip_level, card_uid)
          ON CONFLICT (store_id, code) DO NOTHING RETURNING code`;
        if (rows.length !== create.length) throw conflict('TAGS_CHANGED', '手牌池刚刚有其他人新建了手牌，请重新预览后再导入');
      }
      if (update.length) {
        await tx`
          UPDATE hand_tags t SET zone = u.zone, kind = u.kind, vip_level = u.vip_level, card_uid = u.card_uid, active = true, deleted_at = NULL, deleted_by = NULL, updated_at = now()
          FROM unnest(${update.map((u) => u.id)}::bigint[], ${update.map((u) => u.zone)}::text[], ${update.map((u) => u.kind)}::text[],
                      ${update.map((u) => u.vipLevel) as never}::smallint[], ${update.map((u) => u.cardUid) as never}::text[]) AS u(id, zone, kind, vip_level, card_uid)
          WHERE t.id = u.id`;
      }
      if (deactivate.length) {
        await tx`UPDATE hand_tags SET active = false, updated_at = now() WHERE id IN ${tx(deactivate.map((d) => d.id))}`;
      }
    }

    const report: HandTagImportReport = {
      dryRun: input.dryRun,
      total: input.rows.length,
      created: create.length,
      updated: update.length,
      unchanged,
      deactivated: deactivate.length,
      blocked,
      samples: {
        created: create.slice(0, 20).map((r) => r.code),
        updated: update.slice(0, 20).map((r) => r.code),
        deactivated: deactivate.slice(0, 20).map((r) => r.code),
      },
      groups: [...groups.values()],
    };
    if (!input.dryRun) {
      await writeAudit(tx, {
        staffId: audit.staffId,
        action: 'hand_tags_imported',
        targetType: 'hand_tag',
        detail: {
          via: audit.via,
          total: report.total,
          created: report.created,
          updated: report.updated,
          unchanged: report.unchanged,
          deactivated: report.deactivated,
          blocked: report.blocked.length,
          deactivateMissing: input.deactivateMissing,
        },
        ip: audit.ip,
      });
    }
    return report;
  });
}

// ───────────────────────── 芯片号（8.1.15） ─────────────────────────

const cardUid = z.string('请刷卡或填写芯片号').transform(normalizeCardUid).pipe(z.string().regex(CARD_UID_PATTERN, '芯片号应为 4–32 位数字或字母（刷卡带出来的原样填）'));

/** 芯片号 → 牌号与现在的状态（只读）。这张卡没绑手牌时 found 为 false，由页面写明原因 */
export async function tagByCard(db: Db, raw: unknown): Promise<TagByCard> {
  const uid = parse(cardUid, raw);
  const [t] = await db<
    {
      id: number;
      code: string;
      zone: HandTag['zone'];
      kind: HandTag['kind'];
      vipLevel: number | null;
      locked: boolean;
      lockReason: string | null;
      active: boolean;
      visitId: number | null;
      visitNo: string | null;
    }[]
  >`
    SELECT t.id, t.code, t.zone, t.kind, t.vip_level, t.locked, t.lock_reason, t.active, v.id AS visit_id, v.visit_no
    FROM hand_tags t LEFT JOIN visits v ON v.tag_id = t.id AND v.status = 'open'
    WHERE t.store_id = ${currentStoreId()} AND t.card_uid = ${uid}`;
  if (!t) return { found: false, cardUid: uid };
  const { visitId, visitNo, ...tag } = t;
  return {
    found: true,
    cardUid: uid,
    tag,
    state: visitId ? 'in_use' : tag.locked ? 'locked' : !tag.active ? 'inactive' : 'free',
    visit: visitId ? { id: visitId, visitNo: visitNo! } : null,
  };
}

export const CardInput = z.object({ cardUid: cardUid.nullable() });

/**
 * 给一张手牌绑芯片号，或解绑（cardUid 为 null）。在店的手牌也能绑、能解：芯片号只是「刷卡带出牌号」用的，不动来访与账单。
 * 只锁这一张手牌；同一门店里一个芯片号只绑一张牌，已经绑在别的牌上的拒绝并写明是哪张（唯一索引兜底）。
 */
export async function setTagCard(deps: Deps, id: number, raw: unknown, ctx: OpContext): Promise<{ id: number; code: string; cardUid: string | null }> {
  const input = parse(CardInput, raw);
  const boundError = (code: string) => conflict('CARD_BOUND', `这张卡已经绑在手牌 ${code} 上，请先在那张牌上解绑`, { code });
  try {
    return await deps.sql.begin(async (tx) => {
      await setTxTimeouts(tx);
      // 8.2.21：芯片号绑定锁在前（技师绑工牌也拿它），再锁这张手牌
      await lockCardBindings(tx);
      const [tag] = await tx<{ id: number; code: string; cardUid: string | null }[]>`
        SELECT id, code, card_uid FROM hand_tags WHERE id = ${id} AND store_id = ${currentStoreId()} AND deleted_at IS NULL FOR UPDATE`;
      if (!tag) throw notFound('手牌不存在（可能刚被删除）');
      if (tag.cardUid === input.cardUid) return tag;
      if (input.cardUid !== null) {
        const [other] = await tx<{ code: string }[]>`
          SELECT code FROM hand_tags WHERE store_id = ${currentStoreId()} AND card_uid = ${input.cardUid} AND id <> ${id}`;
        if (other) throw boundError(other.code);
        // 8.2.21（Codex 审查）：技师的工牌不能再当客人的手牌
        const [tech] = await tx<{ techNo: string; name: string }[]>`
          SELECT tech_no, name FROM technicians WHERE store_id = ${currentStoreId()} AND card_uid = ${input.cardUid}`;
        if (tech) throw conflict('CARD_IS_TECH', `这张卡是技师 ${tech.techNo} 号 ${tech.name} 的工牌，不能当手牌`);
      }
      await tx`UPDATE hand_tags SET card_uid = ${input.cardUid}, updated_at = now() WHERE id = ${id}`;
      await writeAudit(tx, {
        staffId: ctx.actor.id,
        action: 'hand_tag_card',
        targetType: 'hand_tag',
        targetId: id,
        detail: { code: tag.code, before: tag.cardUid, after: input.cardUid },
        ip: ctx.ip,
      });
      return { id: tag.id, code: tag.code, cardUid: input.cardUid };
    });
  } catch (error) {
    if (isUniqueViolation(error, 'hand_tags_card_uid_uq')) {
      const [other] = await deps.sql<{ code: string }[]>`SELECT code FROM hand_tags WHERE store_id = ${currentStoreId()} AND card_uid = ${input.cardUid}`;
      throw boundError(other?.code ?? '');
    }
    throw error;
  }
}
