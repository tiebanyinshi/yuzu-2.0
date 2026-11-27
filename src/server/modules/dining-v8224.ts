// 8.2.4 餐饮（会议纪要「餐饮系统需求对接会」，docs/V8224_DINING.md 第 1 节）：菜单分组的默认档口。
//
//   · 后台给点单分类（例如「餐厅 · 点心」）设一个默认档口（茶点），存在餐饮规则 dining_rules.groupStations 里；
//   · 菜品没「单独设档口」（service_items.station_pinned = false）的，下单时按分组的默认档口出；单独设了的照自己的档口；
//     设了档口时段的（8.1.39）时段里照时段的档口——先后：档口时段 → 分组默认 → 菜自己的档口；
//   · 分组的默认档口停用了的不算（照菜自己的档口）；
//   · 后台的核对列表列出菜自己的档口与分组默认不一致的菜，可以一道道改成「跟分组」或「单独设」。
// 锁：保存分组默认档口走规则的咨询锁（saveRuleSetting）；改「单独设」按项目 id 升序锁菜品行。都不碰钱。
// 这个文件不引用 dining.ts（dining.ts 引用这里），读餐饮规则直接读设置行。

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { DEFAULT_DINING_RULES, diningOutletsOf, diningSlotOf, parseSlotKey, slotKey, slotLabel, type DiningRules, type DiningSlot } from '@shared/dining';
import type { GroupStationMismatch, GroupStationsAdmin } from '@shared/dining-v8224';
import type { Db } from '../db';
import { guard, guardAny } from '../auth/guard';
import { writeAudit } from '../lib/audit';
import { ctxOf } from '../lib/context';
import { badRequest, notFound, unprocessable } from '../lib/errors';
import { parse } from '../lib/validate';
import { saveRuleSetting } from '../lib/rule-settings';
import { settingRow } from '../lib/store-settings';
import type { Deps } from '../lib/context';

async function rulesOf(db: Db): Promise<DiningRules> {
  const row = await settingRow<Partial<DiningRules>>(db, 'dining_rules');
  return { ...DEFAULT_DINING_RULES, ...row?.value };
}

interface DishRow {
  id: number;
  name: string;
  category: string;
  diningOutlet: string | null;
  diningGroup: string;
  stationId: number;
  stationName: string;
  stationPinned: boolean;
}

/**
 * 这几道菜里跟分组走的：项目 → 分组默认档口（只含与菜自己的档口不一样、档口在用的）。
 * 没设任何分组默认档口时不查库
 */
export async function groupStationOverrides(db: Db, itemIds: number[]): Promise<Map<number, { id: number; name: string }>> {
  const unique = [...new Set(itemIds)];
  if (unique.length === 0) return new Map();
  const rules = await rulesOf(db);
  const wanted = [...new Set(Object.values(rules.groupStations ?? {}))];
  if (wanted.length === 0) return new Map();
  const stations = await db<{ id: number; name: string }[]>`SELECT id, name FROM kitchen_stations WHERE id IN ${db(wanted)} AND active`;
  if (stations.length === 0) return new Map();
  const rows = await db<DishRow[]>`
    SELECT i.id, i.name, i.category, i.dining_outlet, i.dining_group, i.station_id, s.name AS station_name, i.station_pinned
    FROM service_items i JOIN kitchen_stations s ON s.id = i.station_id
    WHERE i.id IN ${db(unique)} AND NOT i.station_pinned AND NOT i.technician_required`;
  const outlets = diningOutletsOf(rules);
  const out = new Map<number, { id: number; name: string }>();
  for (const r of rows) {
    const slot = diningSlotOf({ outlet: r.diningOutlet, group: r.diningGroup, category: r.category, stationName: r.stationName }, outlets);
    const target = stations.find((s) => s.id === rules.groupStations[slotKey(slot)]);
    if (target && target.id !== r.stationId) out.set(r.id, target);
  }
  return out;
}

/**
 * 菜品编辑选了档口以后「单独设」记成什么（8.2.4）：这道菜的点单分类设了默认档口、而选的不是它，就是单独设（以后不跟分组走）；
 * 选的就是分组的默认档口或分组没设默认的，跟分组
 */
export async function pinnedForStation(db: Db, slot: DiningSlot, stationId: number): Promise<boolean> {
  const rules = await rulesOf(db);
  const target = rules.groupStations?.[slotKey(slot)];
  return target !== undefined && target !== stationId;
}

/** 后台：分组默认档口与核对列表（菜自己的档口与分组默认不一致的菜，含停用的档口设成默认的） */
export async function groupStationsAdmin(db: Db): Promise<GroupStationsAdmin> {
  const rules = await rulesOf(db);
  const groupStations = rules.groupStations ?? {};
  const wanted = [...new Set(Object.values(groupStations))];
  if (wanted.length === 0) return { groupStations, mismatches: [] };
  const stations = await db<{ id: number; name: string }[]>`SELECT id, name FROM kitchen_stations WHERE id IN ${db(wanted)}`;
  const rows = await db<(DishRow & { hasWindows: boolean })[]>`
    SELECT i.id, i.name, i.category, i.dining_outlet, i.dining_group, i.station_id, s.name AS station_name, i.station_pinned,
           EXISTS (SELECT 1 FROM dish_station_windows w WHERE w.item_id = i.id) AS has_windows
    FROM service_items i JOIN kitchen_stations s ON s.id = i.station_id
    WHERE NOT i.technician_required AND i.dish_deleted_at IS NULL ORDER BY i.dish_sort NULLS LAST, i.sort_order, i.id`;
  const outlets = diningOutletsOf(rules);
  const mismatches: GroupStationMismatch[] = [];
  for (const r of rows) {
    const slot = diningSlotOf({ outlet: r.diningOutlet, group: r.diningGroup, category: r.category, stationName: r.stationName }, outlets);
    const key = slotKey(slot);
    const target = stations.find((s) => s.id === groupStations[key]);
    if (!target || target.id === r.stationId) continue;
    mismatches.push({
      itemId: r.id,
      name: r.name,
      slot: key,
      slotLabel: slotLabel(slot),
      ownStationId: r.stationId,
      ownStationName: r.stationName,
      groupStationId: target.id,
      groupStationName: target.name,
      pinned: r.stationPinned,
      hasStationWindows: r.hasWindows,
    });
  }
  return { groupStations, mismatches };
}

const GroupStationsInput = z.object({
  /** 点单分类 → 档口；档口为空的是不设（清掉） */
  groupStations: z.record(z.string().max(40), z.number().int().positive().nullable()),
});

const PinInput = z.object({
  items: z
    .array(z.object({ id: z.number().int().positive(), pinned: z.boolean() }))
    .min(1, '没有要调整的菜品')
    .max(500),
});

export function registerDiningV8224Routes(app: FastifyInstance, deps: Deps) {
  const { sql } = deps;
  app.get('/api/admin/dining/group-stations', { preHandler: guardAny('settings.manage', 'catalog.manage') }, async () => groupStationsAdmin(sql));

  // 分组默认档口：能管理价目的岗位（与菜品挂档口一样）；存在餐饮规则里，走规则的咨询锁
  app.put('/api/admin/dining/group-stations', { preHandler: guard('catalog.manage') }, async (req) => {
    const input = parse(GroupStationsInput, req.body);
    await saveRuleSetting(
      sql,
      'dining_rules',
      rulesOf,
      async (before, tx) => {
        const outlets = diningOutletsOf(before);
        const next: Record<string, number> = {};
        for (const [key, stationId] of Object.entries(input.groupStations)) {
          if (stationId === null) continue;
          const slot = parseSlotKey(key, outlets);
          if (!slot) throw badRequest(`点单分类「${key}」不在现在的小分类名单里，请刷新后重试`);
          next[slotKey(slot)] = stationId;
        }
        const ids = [...new Set(Object.values(next))];
        const stations = ids.length ? await tx<{ id: number; name: string; active: boolean }[]>`SELECT id, name, active FROM kitchen_stations WHERE id IN ${tx(ids)}` : [];
        if (stations.length !== ids.length) throw notFound('有档口不存在，请刷新后重试');
        // 停用的档口不能新设成默认（原来就设着的照留，下单时不算）
        const off = stations.find((s) => !s.active && !Object.entries(next).every(([k, v]) => v !== s.id || before.groupStations?.[k] === s.id));
        if (off) throw unprocessable('STATION_INACTIVE', `档口「${off.name}」已停用，请换一个`);
        return { ...before, groupStations: next };
      },
      ctxOf(req),
    );
    return groupStationsAdmin(sql);
  });

  // 菜品「单独设档口」：true 照菜自己的档口出，false 跟分组的默认档口（按项目 id 升序锁菜品行）
  app.put('/api/admin/dining/items/pinned', { preHandler: guard('catalog.manage') }, async (req) => {
    const { items } = parse(PinInput, req.body);
    const ids = [...new Set(items.map((i) => i.id))].sort((a, b) => a - b);
    if (ids.length !== items.length) throw unprocessable('DUPLICATE_ITEM', '同一道菜提交了两次');
    await sql.begin(async (tx) => {
      const rows = await tx<{ id: number; name: string; stationPinned: boolean; stationId: number | null }[]>`
        SELECT id, name, station_pinned, station_id FROM service_items WHERE id IN ${tx(ids)} ORDER BY id FOR UPDATE`;
      if (rows.length !== ids.length) throw notFound('有菜品不存在，请刷新后重试');
      const notDish = rows.find((r) => r.stationId === null);
      if (notDish) throw unprocessable('DISH_NOT_KITCHEN', `「${notDish.name}」没挂档口，不是进厨房的菜`);
      const changed = rows.filter((r) => r.stationPinned !== items.find((i) => i.id === r.id)!.pinned);
      for (const r of changed) await tx`UPDATE service_items SET station_pinned = ${!r.stationPinned}, updated_at = now() WHERE id = ${r.id}`;
      if (changed.length) {
        await writeAudit(tx, {
          staffId: req.actor.id,
          action: 'items_station_pinned',
          targetType: 'item',
          detail: {
            summary: changed
              .map((r) => `${r.name} → ${r.stationPinned ? '跟分组默认档口' : '单独设档口'}`)
              .join('；')
              .slice(0, 500),
          },
          ip: req.ip,
        });
      }
    });
    return groupStationsAdmin(sql);
  });
}
