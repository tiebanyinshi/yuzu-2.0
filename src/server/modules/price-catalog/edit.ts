// 价目表录入 第三批：编辑与校验（docs/PRICE_CATALOG.md 第 5 节，PENDING_DECISIONS「价目表录入」PC9 起）。
//   · 单条新增、修改（含改价）、停用 / 启用：草稿与生效中的都能改（生效中的改了马上作数，第四批起开单取它；
//     历史单据按开单时的快照，不受影响）；停用的旧版不能改。每次都留痕（price_catalog_changes：经办人、时间、改前 / 改后、原因）。
//   · 校验与页面同一份（priceEntryProblems）：价格形态与价格一致、金额大于 0、空价不存 0、板块 / 餐段认得、时长与时段合法；
//     名称重复（同一张表、同一个板块 / 餐段、同一个分类里，在用的）在这里查库。
//   · 一键切换生效：草稿 → 生效，原来生效的转停用；条数与表格对不上的要写明原因才切换。
//   · 整体回滚：生效中的转停用，上一版（最近换下来的那份）恢复生效。放弃草稿：连同条目、留痕一起删（审计留一条）。
// 加锁（docs/LOCKING.md「价目表录入」）：改条目先锁这份价目表一行（FOR UPDATE，同一份价目表的修改串行，名称查重才不会两边都过）
//   → 这一项（FOR UPDATE，核对版本号，对不上拒绝）→ 写留痕 → 审计。切换、回滚、放弃锁这家门店全部价目表行（id 升序）。
//   导入只锁原来的草稿一行。不碰别的模块的锁；价目表的读都不加锁。
// 操作编号：单条新增、修改、停用 / 启用记在改动留痕上（迁移 235）；切换生效、放弃草稿、整体回滚记在 price_catalog_set_ops
// （迁移 233、236）。页面提交前存本机，结果不确定时查回、按原内容重新提交或确认作废（/api/erp/ops）。

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  PRICE_VARIANTS_MAX,
  PRICE_CHANGE_LABELS,
  PRICE_KIND_LABELS,
  PRICE_SHEET_KINDS,
  PRICE_SHEET_NAMES,
  PRICE_SHEETS,
  countMismatches,
  priceCounts,
  priceEntryProblems,
  priceNameKey,
  priceSignature,
  withDerivedPrice,
  type PriceCatalogEntry,
  type PriceCatalogOverview,
  type PriceChange,
  type PriceChangeAction,
  type PriceKind,
} from '@shared/price-catalog';
import type { Tx } from '../../db';
import { guard } from '../../auth/guard';
import { writeAudit } from '../../lib/audit';
import { ctxOf, type Deps, type OpContext } from '../../lib/context';
import { conflict, notFound, unprocessable } from '../../lib/errors';
import { assertNotFenced, lockOpKey } from '../../lib/fences';
import { erpOpAbandoned } from '../erp-ops';
import { currentStoreId } from '../../lib/store-context';
import { parse } from '../../lib/validate';
import { lockStoreCatalog, syncLinkedPrices } from './links';
import { ENTRY_COLUMNS, entriesOf, entryOf, priceCatalogOverview, rowOf } from './read';

const KINDS = [
  'ticket',
  'night_ticket',
  'meal_ticket',
  'service_fee',
  'play_pass',
  'entertainment',
  'room_type',
  'party_room',
  'dining_room',
  'dish',
  'massage',
] as const satisfies readonly PriceKind[];
const int = z.number().int('要是整数').nullable().default(null);
const text = (max: number) => z.string().trim().max(max, `最多 ${max} 个字`).default('');
const Variant = z.object({
  label: z.string().trim().min(1, '分档要有名称').max(20, '分档名称最多 20 个字'),
  priceCents: int,
  minutes: int,
  unit: text(8),
  roomNumbers: z.array(z.string().trim().min(1).max(12)).max(200).optional(),
  seats: z.number().int().min(1).max(999).optional(),
  note: z.string().trim().max(200).optional(),
});
const EntryFields = z.object({
  section: text(20),
  category: text(20),
  code: text(12),
  name: z.string().trim().min(1, '请填名称').max(48, '名称最多 48 个字'),
  priceMode: z.enum(['dual', 'single', 'none', 'rate']),
  priceCents: int,
  price2Cents: int,
  rateBp: int,
  unit: text(8),
  durationMinutes: int,
  extraPriceCents: int,
  extraMinutes: int,
  capCents: int,
  unitsCount: int,
  roomNumbers: z.array(z.string().trim().min(1).max(12)).max(200).default([]),
  windowStart: int,
  windowEnd: int,
  includesMeal: z.boolean().nullable().default(null),
  venues: z
    .array(z.enum(['room', 'lobby', 'bath']))
    .max(3)
    .default([])
    .transform((v) => [...new Set(v)]),
  gender: z.enum(['female', 'male', 'any']).nullable().default(null),
  audience: text(400),
  content: text(800),
  highlight: text(400),
  note: text(400),
  variants: z.array(Variant).max(PRICE_VARIANTS_MAX, `分档最多 ${PRICE_VARIANTS_MAX} 档`).default([]),
  orderable: z.boolean().default(true),
});
const Reason = z.string().trim().max(200, '原因最多 200 个字').default('');
/** 操作编号：结果不确定原样重提时返回这一项现在的样子、不再写一次（编号记在改动留痕上，迁移 235） */
const OpKey = z.uuid('缺少操作编号');
const CreateInput = EntryFields.extend({ sheet: z.enum(PRICE_SHEETS), kind: z.enum(KINDS), reason: Reason, opKey: OpKey });
const UpdateInput = EntryFields.extend({ version: z.number().int().positive(), reason: Reason, opKey: OpKey });
const ActiveInput = z.object({ version: z.number().int().positive(), active: z.boolean(), reason: Reason, opKey: OpKey });
const ActivateInput = z.object({
  draftId: z.number().int().positive(),
  /** 条数与表格对不上时，写明为什么仍要切换 */
  countReason: z.string().trim().max(200, '原因最多 200 个字').optional(),
  opKey: OpKey,
});
const RollbackInput = z.object({
  activeId: z.number().int().positive(),
  reason: z.string().trim().min(2, '请写明回滚原因').max(200, '原因最多 200 个字'),
  /** 操作编号：结果不确定原样重提时什么都不改（不把后来别人切换的结果切回去） */
  opKey: z.uuid('缺少操作编号'),
});
const DiscardInput = z.object({ draftId: z.number().int().positive(), opKey: OpKey });

type Fields = z.infer<typeof EntryFields>;
/** 只取条目的字段（输入里另带的原因、版本号、表、种类不混进来，比较「改没改」才准） */
const fieldsOf = (f: Fields): Omit<PriceCatalogEntry, 'sheet' | 'kind' | 'active' | 'sourceRow' | 'sortOrder' | 'id' | 'version'> => {
  const picked = Object.fromEntries(Object.keys(EntryFields.shape).map((k) => [k, f[k as keyof Fields]])) as Fields;
  return { ...picked, variants: f.variants.map((v) => ({ ...v, unit: v.unit ?? '' })) };
};

/** 比较用：键排序后再转字符串（jsonb 会重排键的顺序；值为 undefined 的键不算） */
const stable = (v: unknown): string =>
  Array.isArray(v)
    ? `[${v.map(stable).join(',')}]`
    : v && typeof v === 'object'
      ? `{${Object.entries(v)
          .filter(([, x]) => x !== undefined)
          .sort(([a], [b]) => (a < b ? -1 : 1))
          .map(([k, x]) => `${JSON.stringify(k)}:${stable(x)}`)
          .join(',')}}`
      : JSON.stringify(v);

function assertValid(e: PriceCatalogEntry) {
  const problems = priceEntryProblems(e);
  if (problems.length) throw unprocessable('PRICE_INVALID', problems.join('；'), { problems });
}

interface LockedSet {
  id: number;
  status: 'draft' | 'active' | 'retired';
  title: string;
}
/** 锁这份价目表一行（改条目的第一把锁）；停用的旧版不能改 */
async function lockSet(tx: Tx, setId: number): Promise<LockedSet> {
  const [s] = await tx<LockedSet[]>`SELECT id, status, title FROM price_catalog_sets WHERE id = ${setId} AND store_id = ${currentStoreId()} FOR UPDATE`;
  if (!s) throw notFound('没有这份价目表');
  if (s.status === 'retired') throw unprocessable('PRICE_SET_RETIRED', '这是换下来的旧版价目表，不能再改；要用它请「整体回滚」，或导入新的');
  return { ...s, id: Number(s.id) };
}

/** 名称重复：同一张表、同一个板块 / 餐段、同一个分类里在用的（不分大小写、不管空格）。调用前已锁住这份价目表 */
async function assertUniqueName(tx: Tx, setId: number, e: PriceCatalogEntry, selfId: number | null) {
  if (!e.active) return;
  const rows = await tx<{ id: number; sheet: PriceCatalogEntry['sheet']; section: string; category: string; name: string }[]>`
    SELECT id, sheet, section, category, name FROM price_catalog_entries
    WHERE set_id = ${setId} AND active AND sheet = ${e.sheet} AND section = ${e.section} AND category = ${e.category}`;
  const key = priceNameKey(e);
  if (rows.some((r) => Number(r.id) !== selfId && priceNameKey(r) === key)) {
    const where = [PRICE_SHEET_NAMES[e.sheet], e.section, e.category].filter(Boolean).join(' · ');
    throw conflict('PRICE_NAME_DUPLICATE', `名称重复：${where} 里已经有「${e.name}」`);
  }
}

async function readEntry(tx: Tx, id: number): Promise<PriceCatalogEntry> {
  const [r] = await tx<Record<string, unknown>[]>`SELECT ${tx.unsafe(ENTRY_COLUMNS)} FROM price_catalog_entries WHERE id = ${id}`;
  return entryOf(r!);
}

/**
 * 单条改动的操作编号：先取编号的咨询锁（与「确认作废」同一把）；这个编号已经记过（重提）就返回那一项现在的样子；
 * 作废过的拒绝。调用方在这之后再按「价目表 → 这一项」加锁
 */
async function replayed(tx: Tx, opKey: string): Promise<PriceCatalogEntry | null> {
  await lockOpKey(tx, opKey);
  const [done] = await tx<{ entryId: number }[]>`SELECT entry_id FROM price_catalog_changes WHERE op_key = ${opKey}`;
  if (done) return readEntry(tx, Number(done.entryId));
  await assertNotFenced(tx, opKey, 'price_entry', erpOpAbandoned);
  return null;
}

async function logChange(
  tx: Tx,
  ctx: OpContext,
  c: { set: LockedSet; action: PriceChangeAction; before: PriceCatalogEntry | null; after: PriceCatalogEntry; reason: string; opKey: string },
): Promise<void> {
  const priceChanged = c.before ? priceSignature(c.before) !== priceSignature(c.after) : true;
  const entryId = c.after.id!;
  await tx`
    INSERT INTO price_catalog_changes (set_id, entry_id, action, entry_name, before, after, price_changed, reason, staff_id, op_key)
    VALUES (${c.set.id}, ${entryId}, ${c.action}, ${c.after.name}, ${c.before ? tx.json(c.before as never) : null}, ${tx.json(c.after as never)}, ${priceChanged}, ${c.reason}, ${ctx.actor.id}, ${c.opKey})`;
  const where = c.set.status === 'active' ? '生效中的价目表' : '草稿';
  await writeAudit(tx, {
    staffId: ctx.actor.id,
    action: 'price_catalog',
    targetType: 'price_catalog_entry',
    targetId: String(entryId),
    detail: {
      action: `entry_${c.action}`,
      label: `${where}${PRICE_CHANGE_LABELS[c.action]}「${c.after.name}」${priceChanged && c.action === 'update' ? '（改价）' : ''}`,
      setId: c.set.id,
      priceChanged,
      reason: c.reason || null,
    },
    ip: ctx.ip,
  });
}

// ───────────────────────── 条目 ─────────────────────────

export async function createPriceEntry(deps: Deps, setId: number, raw: unknown, ctx: OpContext): Promise<PriceCatalogEntry> {
  const f = parse(CreateInput, raw);
  if (!PRICE_SHEET_KINDS[f.sheet].includes(f.kind)) throw unprocessable('PRICE_INVALID', `${PRICE_SHEET_NAMES[f.sheet]}里不能新增「${PRICE_KIND_LABELS[f.kind]}」`);
  return deps.sql.begin(async (tx) => {
    const again = await replayed(tx, f.opKey);
    if (again) return again;
    const set = await lockSet(tx, setId);
    const entry: PriceCatalogEntry = withDerivedPrice({ ...fieldsOf(f), sheet: f.sheet, kind: f.kind, active: true, sourceRow: null, sortOrder: 0 });
    assertValid(entry);
    await assertUniqueName(tx, set.id, entry, null);
    const [last] = await tx<{ next: number }[]>`
      SELECT coalesce(max(sort_order), 0) + 1 AS next FROM price_catalog_entries WHERE set_id = ${set.id} AND sheet = ${f.sheet}`;
    const row = { ...rowOf(set.id, { ...entry, sortOrder: Number(last!.next) }), variants: tx.json(entry.variants as never) };
    const [created] = await tx<{ id: number }[]>`INSERT INTO price_catalog_entries ${tx(row as never)} RETURNING id`;
    const after = await readEntry(tx, Number(created!.id));
    await logChange(tx, ctx, { set, action: 'create', before: null, after, reason: f.reason, opKey: f.opKey });
    return after;
  });
}

/**
 * 第四批：改的是生效中的价目表时，对接了的收银项目跟着改（PC9、PC17）。改了名称 / 板块 / 分类（查重键变了）的，对接跟着这一项走；
 * 新键已经有对接的不动（那一项照旧对接原来的收银项目）
 */
async function syncEntry(tx: Tx, ctx: OpContext, set: LockedSet, before: PriceCatalogEntry, after: PriceCatalogEntry) {
  if (set.status !== 'active') return;
  const from = priceNameKey(before);
  const to = priceNameKey(after);
  // 只有在用的那一项改名才带走对接：同名的停用历史项改名，不能把在用项的对接迁走
  if (from !== to && before.active) {
    await tx`
      UPDATE price_catalog_links SET entry_key = ${to}
      WHERE store_id = ${currentStoreId()} AND entry_key = ${from}
        AND NOT EXISTS (SELECT 1 FROM price_catalog_links WHERE store_id = ${currentStoreId()} AND entry_key = ${to})`;
  }
  await syncLinkedPrices(tx, ctx, { keys: [to], why: `改价「${after.name}」` });
}

/** 先找到这一项属于哪份价目表（不加锁），再按「价目表 → 这一项」的顺序锁 */
async function lockEntry(tx: Tx, entryId: number, version: number): Promise<{ set: LockedSet; before: PriceCatalogEntry }> {
  const [where] = await tx<{ setId: number }[]>`
    SELECT e.set_id FROM price_catalog_entries e JOIN price_catalog_sets s ON s.id = e.set_id WHERE e.id = ${entryId} AND s.store_id = ${currentStoreId()}`;
  if (!where) throw notFound('没有这一项（可能所在的草稿已被替换或放弃），刷新后再看');
  const set = await lockSet(tx, Number(where.setId));
  const [r] = await tx<Record<string, unknown>[]>`SELECT ${tx.unsafe(ENTRY_COLUMNS)} FROM price_catalog_entries WHERE id = ${entryId} FOR UPDATE`;
  if (!r) throw notFound('没有这一项，刷新后再看');
  const before = entryOf(r);
  if (before.version !== version) throw conflict('PRICE_VERSION', `「${before.name}」刚被别人改过，刷新后看一下现在的价格再改`);
  return { set, before };
}

export async function updatePriceEntry(deps: Deps, entryId: number, raw: unknown, ctx: OpContext): Promise<PriceCatalogEntry> {
  const f = parse(UpdateInput, raw);
  return deps.sql.begin(async (tx) => {
    const again = await replayed(tx, f.opKey);
    if (again) return again;
    const { set, before } = await lockEntry(tx, entryId, f.version);
    // 主价格由分档推出来的（轰趴房、餐饮包房、客房）按分档重算
    const next: PriceCatalogEntry = withDerivedPrice({ ...before, ...fieldsOf(f) });
    assertValid(next);
    const same = stable({ ...next, version: 0 }) === stable({ ...before, version: 0 });
    if (same) return before;
    await assertUniqueName(tx, set.id, next, entryId);
    const { set_id: _s, sheet: _sh, kind: _k, active: _a, source_row: _r, sort_order: _o, ...cols } = rowOf(set.id, next);
    await tx`
      UPDATE price_catalog_entries SET ${tx({ ...cols, variants: tx.json(next.variants as never) } as never)}, version = version + 1, updated_at = now()
      WHERE id = ${entryId}`;
    const after = await readEntry(tx, entryId);
    await logChange(tx, ctx, { set, action: 'update', before, after, reason: f.reason, opKey: f.opKey });
    await syncEntry(tx, ctx, set, before, after);
    return after;
  });
}

export async function setPriceEntryActive(deps: Deps, entryId: number, raw: unknown, ctx: OpContext): Promise<PriceCatalogEntry> {
  const f = parse(ActiveInput, raw);
  return deps.sql.begin(async (tx) => {
    const again = await replayed(tx, f.opKey);
    if (again) return again;
    const { set, before } = await lockEntry(tx, entryId, f.version);
    if (before.active === f.active) return before;
    if (f.active) await assertUniqueName(tx, set.id, { ...before, active: true }, entryId);
    await tx`UPDATE price_catalog_entries SET active = ${f.active}, version = version + 1, updated_at = now() WHERE id = ${entryId}`;
    const after = await readEntry(tx, entryId);
    await logChange(tx, ctx, { set, action: f.active ? 'reactivate' : 'deactivate', before, after, reason: f.reason, opKey: f.opKey });
    await syncEntry(tx, ctx, set, before, after);
    return after;
  });
}

export async function priceChanges(deps: Deps, setId: number, q: { entryId?: number; priceOnly?: boolean }): Promise<PriceChange[]> {
  const rows = await deps.sql<(Omit<PriceChange, 'before' | 'after'> & { before: PriceCatalogEntry | null; after: PriceCatalogEntry })[]>`
    SELECT c.id, c.set_id, c.entry_id, c.action, c.entry_name, c.before, c.after, c.price_changed, c.reason, s.display_name AS staff_name, c.created_at
    FROM price_catalog_changes c JOIN price_catalog_sets ps ON ps.id = c.set_id JOIN staff s ON s.id = c.staff_id
    WHERE c.set_id = ${setId} AND ps.store_id = ${currentStoreId()}
      ${q.entryId ? deps.sql`AND c.entry_id = ${q.entryId}` : deps.sql``}
      ${q.priceOnly ? deps.sql`AND c.price_changed` : deps.sql``}
    ORDER BY c.id DESC LIMIT 300`;
  // jsonb 里存的是页面用的字段名（camelCase），原样给出
  return rows.map((r) => ({ ...r, id: Number(r.id), setId: Number(r.setId), entryId: Number(r.entryId) }));
}

// ───────────────────────── 切换生效、回滚、放弃草稿 ─────────────────────────

/**
 * 切换生效、放弃草稿的操作编号（迁移 236，与整体回滚同一张表）：先取编号的咨询锁；记过的（重提）什么都不改、返回现在的样子；
 * 作废过的拒绝。之后再取门店级的锁
 */
async function setOpDone(tx: Tx, opKey: string): Promise<PriceCatalogOverview | null> {
  await lockOpKey(tx, opKey);
  const [done] = await tx<{ storeId: number }[]>`SELECT store_id FROM price_catalog_set_ops WHERE op_key = ${opKey}`;
  if (done) {
    if (Number(done.storeId) !== currentStoreId()) throw conflict('PRICE_OP_REUSED', '这个操作编号已经用过了，请刷新页面后再操作');
    return priceCatalogOverview(tx);
  }
  await assertNotFenced(tx, opKey, 'price_set', erpOpAbandoned);
  return null;
}

/** 门店级咨询锁 → 这家门店全部价目表行（id 升序）：切换、回滚、放弃互相排队 */
async function lockSets(tx: Tx) {
  await lockStoreCatalog(tx);
  return (await tx<LockedSet[]>`SELECT id, status, title FROM price_catalog_sets WHERE store_id = ${currentStoreId()} ORDER BY id FOR UPDATE`).map((s) => ({ ...s, id: Number(s.id) }));
}

export async function activatePriceCatalog(deps: Deps, raw: unknown, ctx: OpContext): Promise<PriceCatalogOverview> {
  const f = parse(ActivateInput, raw);
  return deps.sql.begin(async (tx) => {
    const replay = await setOpDone(tx, f.opKey);
    if (replay) return replay;
    const sets = await lockSets(tx);
    const draft = sets.find((s) => s.status === 'draft');
    if (!draft || draft.id !== f.draftId) throw conflict('PRICE_SET_CHANGED', '草稿已经变了（被重新导入、放弃或已切换），刷新后再看');
    const entries = await entriesOf(tx, draft.id);
    const { counts, total } = priceCounts(entries);
    if (total.actual === 0) throw unprocessable('PRICE_EMPTY', '草稿里没有在用的项目，不能切换生效');
    const mismatches = countMismatches(counts);
    if (mismatches.length && (f.countReason ?? '').length < 2) {
      throw unprocessable('PRICE_COUNT_MISMATCH', `条数与表格对不上，核对后写明原因再切换：${mismatches.join('；')}`, { mismatches });
    }
    const old = sets.find((s) => s.status === 'active');
    // 先把原来生效的换下来（一家门店只能有一份生效，唯一索引逐条检查），再让草稿生效
    if (old) await tx`UPDATE price_catalog_sets SET status = 'retired', retired_at = now() WHERE id = ${old.id}`;
    await tx`UPDATE price_catalog_sets SET status = 'active', activated_at = now(), activated_by = ${ctx.actor.id}, retired_at = NULL WHERE id = ${draft.id}`;
    await tx`
      INSERT INTO price_catalog_set_ops (op_key, action, from_set_id, to_set_id, staff_id)
      VALUES (${f.opKey}, 'activate', ${old?.id ?? null}, ${draft.id}, ${ctx.actor.id})`;
    // 第四批：对接了的收银项目跟着换成这一份的价（PC17）
    await syncLinkedPrices(tx, ctx, { why: `切换生效「${draft.title}」` });
    await writeAudit(tx, {
      staffId: ctx.actor.id,
      action: 'price_catalog',
      targetType: 'price_catalog_set',
      targetId: String(draft.id),
      detail: {
        action: 'activate',
        label: `切换生效「${draft.title}」（${total.actual} 项${old ? `，换下「${old.title}」` : ''}）`,
        retired: old?.id ?? null,
        mismatches,
        countReason: mismatches.length ? f.countReason : null,
      },
      ip: ctx.ip,
    });
    return priceCatalogOverview(tx);
  });
}

export async function rollbackPriceCatalog(deps: Deps, raw: unknown, ctx: OpContext): Promise<PriceCatalogOverview> {
  const f = parse(RollbackInput, raw);
  return deps.sql.begin(async (tx) => {
    // 同一个操作编号排队；已经回滚过的返回现在的样子、什么都不改
    await lockOpKey(tx, f.opKey);
    const [done] = await tx<{ storeId: number }[]>`SELECT store_id FROM price_catalog_set_ops WHERE op_key = ${f.opKey}`;
    if (done) {
      if (Number(done.storeId) !== currentStoreId()) throw conflict('PRICE_OP_REUSED', '这个操作编号已经用过了，请刷新页面后再操作');
      return priceCatalogOverview(tx);
    }
    await assertNotFenced(tx, f.opKey, 'price_rollback', erpOpAbandoned);
    await lockSets(tx);
    const current = await priceCatalogOverview(tx);
    if (!current.active || current.active.id !== f.activeId) throw conflict('PRICE_SET_CHANGED', '生效中的价目表已经变了，刷新后再看');
    const prev = current.previous;
    if (!prev) throw unprocessable('PRICE_NO_PREVIOUS', '没有上一版可以回滚');
    await tx`UPDATE price_catalog_sets SET status = 'retired', retired_at = now() WHERE id = ${current.active.id}`;
    await tx`UPDATE price_catalog_sets SET status = 'active', activated_at = now(), activated_by = ${ctx.actor.id}, retired_at = NULL WHERE id = ${prev.id}`;
    await tx`
      INSERT INTO price_catalog_set_ops (op_key, action, from_set_id, to_set_id, staff_id)
      VALUES (${f.opKey}, 'rollback', ${current.active.id}, ${prev.id}, ${ctx.actor.id})`;
    await syncLinkedPrices(tx, ctx, { why: `整体回滚到「${prev.title}」` });
    await writeAudit(tx, {
      staffId: ctx.actor.id,
      action: 'price_catalog',
      targetType: 'price_catalog_set',
      targetId: String(prev.id),
      detail: { action: 'rollback', label: `整体回滚到「${prev.title}」（换下「${current.active.title}」）`, retired: current.active.id, reason: f.reason },
      ip: ctx.ip,
    });
    return priceCatalogOverview(tx);
  });
}

export async function discardPriceDraft(deps: Deps, raw: unknown, ctx: OpContext): Promise<PriceCatalogOverview> {
  const f = parse(DiscardInput, raw);
  return deps.sql.begin(async (tx) => {
    const replay = await setOpDone(tx, f.opKey);
    if (replay) return replay;
    const sets = await lockSets(tx);
    const draft = sets.find((s) => s.status === 'draft');
    if (!draft || draft.id !== f.draftId) throw conflict('PRICE_SET_CHANGED', '草稿已经变了，刷新后再看');
    await tx`DELETE FROM price_catalog_sets WHERE id = ${draft.id}`;
    // 放弃的草稿已经删了：编号照样记下（数据集编号只留作对审计，不引用）
    await tx`INSERT INTO price_catalog_set_ops (op_key, action, from_set_id, to_set_id, staff_id) VALUES (${f.opKey}, 'discard', ${draft.id}, NULL, ${ctx.actor.id})`;
    await writeAudit(tx, {
      staffId: ctx.actor.id,
      action: 'price_catalog',
      targetType: 'price_catalog_set',
      targetId: String(draft.id),
      detail: { action: 'discard', label: `放弃草稿「${draft.title}」` },
      ip: ctx.ip,
    });
    return priceCatalogOverview(tx);
  });
}

export function registerPriceCatalogEditRoutes(app: FastifyInstance, deps: Deps) {
  const manage = guard('catalog.manage');
  const Id = z.object({ id: z.coerce.number().int().positive() });
  app.post('/api/admin/price-catalog/sets/:id/entries', { preHandler: manage }, async (req, reply) => {
    const e = await createPriceEntry(deps, parse(Id, req.params).id, req.body, ctxOf(req));
    reply.code(201);
    return e;
  });
  // 修改用 POST（页面走「结果待确认」的 sendErpOp，只发 POST）
  app.post('/api/admin/price-catalog/entries/:id', { preHandler: manage }, async (req) => updatePriceEntry(deps, parse(Id, req.params).id, req.body, ctxOf(req)));
  app.post('/api/admin/price-catalog/entries/:id/active', { preHandler: manage }, async (req) => setPriceEntryActive(deps, parse(Id, req.params).id, req.body, ctxOf(req)));
  app.get('/api/admin/price-catalog/sets/:id/changes', { preHandler: manage }, async (req) => {
    const q = parse(z.object({ entryId: z.coerce.number().int().positive().optional(), priceOnly: z.enum(['1', '0']).optional() }), req.query);
    return priceChanges(deps, parse(Id, req.params).id, { entryId: q.entryId, priceOnly: q.priceOnly === '1' });
  });
  app.post('/api/admin/price-catalog/activate', { preHandler: manage }, async (req) => activatePriceCatalog(deps, req.body, ctxOf(req)));
  app.post('/api/admin/price-catalog/rollback', { preHandler: manage }, async (req) => rollbackPriceCatalog(deps, req.body, ctxOf(req)));
  app.post('/api/admin/price-catalog/discard', { preHandler: manage }, async (req) => discardPriceDraft(deps, req.body, ctxOf(req)));
}
