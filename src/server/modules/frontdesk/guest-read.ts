// 8.2.3 前台（docs/V8223_FRONTDESK.md）：客人类别、偏好与全店刷手牌看的那一条的读取。只读、不加锁；
// 写入在 guest.ts（它要读来访详情，来访详情又要读这里，所以读的这一半单放一个文件）。

import { z } from 'zod';
import {
  categoryMark,
  DEFAULT_GUEST_RULES,
  highRiskOf,
  MAX_CATEGORY_LENGTH,
  MAX_GUEST_CATEGORIES,
  MAX_PREF_FIELDS,
  MAX_PREF_LABEL,
  PREF_KEY_PATTERN,
  RISK_NOTIFY_LEVELS,
  type GuestNotes,
  type GuestProfile,
  type GuestRules,
} from '@shared/frontdesk-v8223';
import type { Db } from '../../db';
import { currentStoreId } from '../../lib/store-context';
import { settingRow } from '../../lib/store-settings';

export const GUEST_RULES_KEY = 'frontdesk_guest_rules';

const label = (max: number, what: string) => z.string(`请填写${what}`).trim().min(1, `请填写${what}`).max(max, `${what}最多 ${max} 个字`);
const unique = <T>(list: T[], key: (t: T) => string) => new Set(list.map(key)).size === list.length;

export const GuestRulesInput = z.object({
  categories: z
    .array(label(MAX_CATEGORY_LENGTH, '类别名称'))
    .min(1, '至少要有一个类别')
    .max(MAX_GUEST_CATEGORIES, `最多 ${MAX_GUEST_CATEGORIES} 个类别`)
    .refine((l) => unique(l, (x) => x), '类别名称不能重复'),
  prefFields: z
    .array(z.object({ key: z.string().regex(PREF_KEY_PATTERN, '字段编号只能是小写字母开头的字母、数字、下划线'), label: label(MAX_PREF_LABEL, '字段名称') }))
    .max(MAX_PREF_FIELDS, `最多 ${MAX_PREF_FIELDS} 个字段`)
    .refine((l) => unique(l, (x) => x.key) && unique(l, (x) => x.label), '字段的编号、名称都不能重复'),
  complaintTags: z
    .array(label(20, '标签'))
    .max(10, '最多 10 个标签')
    .refine((l) => unique(l, (x) => x), '标签不能重复'),
  crowd: z.object({
    streak: z.number().int().min(0, '不能小于 0').max(200, '最多 200 张'),
    areaMax: z.number().int().min(0, '不能小于 0').max(2000, '最多 2000 人'),
  }),
  risk: z.object({
    stayHours: z.number().int().min(0, '不能小于 0').max(240, '最多 240 小时'),
    amountCents: z.number().int().min(0, '不能小于 0').max(100_000_000, '最多 ¥1,000,000'),
    notify: z.enum(RISK_NOTIFY_LEVELS, '请选择推给谁'),
  }),
});

/** 当前门店的客人规则（没设过的用默认；只存了一部分的按默认补齐） */
export async function loadGuestRules(db: Db): Promise<GuestRules> {
  const row = await settingRow<Partial<GuestRules>>(db, GUEST_RULES_KEY);
  const v = row?.value ?? {};
  return {
    categories: v.categories?.length ? v.categories : DEFAULT_GUEST_RULES.categories,
    prefFields: v.prefFields ?? DEFAULT_GUEST_RULES.prefFields,
    complaintTags: v.complaintTags ?? DEFAULT_GUEST_RULES.complaintTags,
    crowd: { ...DEFAULT_GUEST_RULES.crowd, ...v.crowd },
    risk: { ...DEFAULT_GUEST_RULES.risk, ...v.risk },
  };
}

/** 来访上记的类别：空的（升级前的来访）按默认类别 */
export const categoryOf = (stored: string, rules: Pick<GuestRules, 'categories'>) => stored || rules.categories[0]!;

type PrefRow = { fieldKey: string; value: string; updatedByName: string | null; updatedAt: string | null };

/** 偏好按后台字段排好；停用的字段以前填过的排在后面（retired） */
function arrangePrefs(rows: PrefRow[], rules: GuestRules): GuestProfile['prefs'] {
  const byKey = new Map(rows.map((r) => [r.fieldKey, r]));
  const active = rules.prefFields.map((f) => {
    const r = byKey.get(f.key);
    return { key: f.key, label: f.label, value: r?.value ?? '', retired: false, updatedByName: r?.updatedByName ?? null, updatedAt: r?.updatedAt ?? null };
  });
  const known = new Set(rules.prefFields.map((f) => f.key));
  const retired = rows
    .filter((r) => !known.has(r.fieldKey) && r.value)
    .map((r) => ({ key: r.fieldKey, label: r.fieldKey, value: r.value, retired: true, updatedByName: r.updatedByName, updatedAt: r.updatedAt }));
  return [...active, ...retired];
}

async function prefRows(db: Db, owner: { memberId: number } | { visitId: number }): Promise<PrefRow[]> {
  const where = 'memberId' in owner ? db`p.member_id = ${owner.memberId}` : db`p.visit_id = ${owner.visitId}`;
  return db<PrefRow[]>`
    SELECT p.field_key, p.value, s.display_name AS updated_by_name, p.updated_at
    FROM guest_preferences p JOIN staff s ON s.id = p.updated_by WHERE ${where} ORDER BY p.field_key`;
}

/** 一位客人的类别与偏好（来访详情里带）：会员的偏好记在会员上，散客的记在这次来访上 */
export async function guestProfile(db: Db, visit: { id: number; memberId: number | null; guestCategory: string }, rules?: GuestRules): Promise<GuestProfile> {
  const r = rules ?? (await loadGuestRules(db));
  const owner = visit.memberId ? { memberId: visit.memberId } : { visitId: visit.id };
  return { category: categoryOf(visit.guestCategory, r), owner: visit.memberId ? 'member' : 'visit', prefs: arrangePrefs(await prefRows(db, owner), r) };
}

/** 改类别的记录（经办记录用） */
export async function categoryChanges(db: Db, visitId: number) {
  return db<{ createdAt: string; fromCategory: string; toCategory: string; operatorName: string }[]>`
    SELECT c.created_at, c.from_category, c.to_category, s.display_name AS operator_name
    FROM visit_category_changes c JOIN staff s ON s.id = c.operator_id WHERE c.visit_id = ${visitId} ORDER BY c.id`;
}

/**
 * 全店刷手牌的地方看的一条（点单、房态、钟房派钟）：本店在店的这几位客人的类别、填了的偏好、没撤下的备注（单人 + 所在同行组的）、高风险。
 * 只给在店的（离店、撤销的返回空）
 */
export async function guestNotesOf(db: Db, visitIds: number[]): Promise<GuestNotes[]> {
  const ids = [...new Set(visitIds)];
  if (!ids.length) return [];
  const rules = await loadGuestRules(db);
  const visits = await db<{ id: number; tagCode: string; memberId: number | null; groupId: number | null; guestCategory: string; checkedInAt: string; amountCents: number; now: string }[]>`
    SELECT v.id, t.code AS tag_code, v.member_id, v.group_id, v.guest_category, v.checked_in_at, b.amount_cents, now() AS now
    FROM visits v JOIN hand_tags t ON t.id = v.tag_id JOIN bills b ON b.id = v.bill_id
    WHERE v.id IN ${db(ids)} AND v.status = 'open' AND v.store_id = ${currentStoreId()} ORDER BY v.id`;
  if (!visits.length) return [];
  const memberIds = visits.flatMap((v) => (v.memberId ? [Number(v.memberId)] : []));
  const prefs = await db<{ memberId: number | null; visitId: number | null; fieldKey: string; value: string }[]>`
    SELECT member_id, visit_id, field_key, value FROM guest_preferences
    WHERE visit_id IN ${db(visits.map((v) => v.id))} OR member_id IN ${db(memberIds.length ? memberIds : [0])}`;
  const groupIds = visits.flatMap((v) => (v.groupId ? [Number(v.groupId)] : []));
  const remarks = await db<{ visitId: number; groupId: number | null; scope: 'single' | 'group'; tag: string; note: string }[]>`
    SELECT r.visit_id, r.group_id, r.scope, r.tag, r.note FROM visit_remarks r
    WHERE ((r.scope = 'single' AND r.visit_id IN ${db(visits.map((v) => v.id))}) OR r.group_id IN ${db(groupIds.length ? groupIds : [0])})
      AND NOT EXISTS (SELECT 1 FROM visit_remark_removals x WHERE x.remark_id = r.id)
    ORDER BY r.id`;
  const labelOf = new Map(rules.prefFields.map((f) => [f.key, f.label]));
  const order = new Map(rules.prefFields.map((f, i) => [f.key, i]));
  return visits.map((v) => {
    const mine = prefs
      .filter((p) => (v.memberId ? Number(p.memberId) === Number(v.memberId) : Number(p.visitId) === Number(v.id)) && p.value && labelOf.has(p.fieldKey))
      .sort((a, b) => order.get(a.fieldKey)! - order.get(b.fieldKey)!);
    const category = categoryOf(v.guestCategory, rules);
    const stay = Math.floor((new Date(v.now).getTime() - new Date(v.checkedInAt).getTime()) / 60_000);
    return {
      visitId: Number(v.id),
      tagCode: v.tagCode,
      category,
      categoryMark: categoryMark(category, rules),
      prefs: mine.map((p) => ({ label: labelOf.get(p.fieldKey)!, value: p.value })),
      remarks: remarks
        .filter((r) => (r.scope === 'single' ? Number(r.visitId) === Number(v.id) : v.groupId !== null && Number(r.groupId) === Number(v.groupId)))
        .map((r) => ({ tag: r.tag, note: r.note, scope: r.scope })),
      highRisk: highRiskOf(stay, Number(v.amountCents), rules),
    };
  });
}
