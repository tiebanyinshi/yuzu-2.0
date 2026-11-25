// 8.1.39（餐饮 B，docs/V8139_DINING_B.md）：菜单的小分类可以在后台改（R4）、菜品的售卖时段与档口时段（R3、分时段出品档口）、
// 前台结账核对时只看餐饮（R10）。
//
//   · 小分类：存在餐饮规则（settings 'dining_rules'.outletGroups）里，默认是原来写死的名单；保存时删掉、改名的小分类还有菜在用
//     （设过的，或者按默认归进去的）整笔拒绝（409 DINING_GROUP_IN_USE），写明几道菜；
//   · 售卖时段、档口时段：菜品编辑里改（dishes.ts 调这里的读写），下单时在 dining.ts 的 takeDishLimits / kitchenStationsOf 里核对与选档口；
//   · 只看餐饮：只读，不加锁。
// 这个文件不引用 dining.ts（dining.ts 引用这里的输入格式，免得两个文件互相引用时先后不定）。

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { DINING_OUTLET_LABELS, diningOutletsOf, diningSlotOf, GROUPED_OUTLETS, MAX_DINING_GROUP_NAME, MAX_DINING_GROUPS, type DiningOutletDef, type DiningRules } from '@shared/dining';
import { MAX_SALE_WINDOWS, MAX_STATION_WINDOWS, windowsProblem, windowsText, type DiningSubtotals, type DishStationWindow, type DishWindow } from '@shared/dining-v8139';
import type { Db, Tx } from '../db';
import { guardAny, sessionReady } from '../auth/guard';
import type { Deps } from '../lib/context';
import { badRequest, conflict, notFound, unprocessable } from '../lib/errors';
import { parse } from '../lib/validate';
import { settingRow } from '../lib/store-settings';
import { currentStoreId } from '../lib/store-context';

// ───────────────────────── 小分类（R4） ─────────────────────────

const groupName = z
  .string('小分类要写名字')
  .trim()
  .min(1, '小分类不能是空的')
  .max(MAX_DINING_GROUP_NAME, `小分类最多 ${MAX_DINING_GROUP_NAME} 个字`)
  .refine((g) => !/[:：\s]/.test(g), '小分类里不要带冒号或空格');
const groupList = (label: string) =>
  z
    .array(groupName)
    .min(1, `${label}至少要有一个小分类`)
    .max(MAX_DINING_GROUPS, `${label}最多 ${MAX_DINING_GROUPS} 个小分类`)
    .refine((list) => new Set(list).size === list.length, `${label}的小分类重复了`);
/** 餐饮规则里的小分类（dining.ts 的 RulesInput 用） */
export const OutletGroupsInput = z.object({ restaurant: groupList('餐厅'), water: groupList('水吧') });

/** 现在的三处与小分类（按当前门店的餐饮规则） */
export async function loadDiningOutlets(db: Db): Promise<readonly DiningOutletDef[]> {
  const row = await settingRow<Partial<DiningRules>>(db, 'dining_rules');
  return diningOutletsOf(row?.value);
}

/**
 * 保存餐饮规则前（规则锁已取）：名单里去掉的小分类（删掉或改了名）还有菜在用——后台设到这一类的，或者没设、按默认归进来的——整笔拒绝。
 * 只算菜品（挂了档口、不要技师、没删除的，下架的也算：再上架还在这一类）
 */
export async function assertGroupsUnused(tx: Tx, before: Pick<DiningRules, 'outletGroups'>, after: Pick<DiningRules, 'outletGroups'>) {
  const was = diningOutletsOf(before);
  const now = diningOutletsOf(after);
  const removed = GROUPED_OUTLETS.flatMap((o) =>
    was
      .find((x) => x.key === o)!
      .groups.filter((g) => !now.find((x) => x.key === o)!.groups.includes(g))
      .map((group) => ({ outlet: o, group })),
  );
  if (removed.length === 0) return;
  const rows = await tx<{ category: string; diningOutlet: string | null; diningGroup: string; stationName: string }[]>`
    SELECT i.category, i.dining_outlet, i.dining_group, s.name AS station_name
    FROM service_items i JOIN kitchen_stations s ON s.id = i.station_id WHERE NOT i.technician_required AND i.dish_deleted_at IS NULL`;
  const used = removed
    .map((r) => ({
      ...r,
      count: rows.filter((d) => {
        const at = diningSlotOf({ outlet: d.diningOutlet, group: d.diningGroup, category: d.category, stationName: d.stationName }, was);
        return at.outlet === r.outlet && at.group === r.group;
      }).length,
    }))
    .filter((r) => r.count > 0);
  if (used.length === 0) return;
  throw conflict(
    'DINING_GROUP_IN_USE',
    `${used.map((u) => `「${DINING_OUTLET_LABELS[u.outlet]} · ${u.group}」还有 ${u.count} 道菜`).join('，')}在用（含没设分类、按默认归进来的），不能删除或改名；先在菜品表里把这些菜挪到别的小类再改`,
    { groups: used },
  );
}

// ───────────────────────── 售卖时段、档口时段（R3） ─────────────────────────

const minuteField = z.number('时间不对').int('时间不对').min(0, '时间不对').max(1439, '时间不对');
const WindowInput = z.object({ start: minuteField, end: minuteField });
/** 菜品编辑交的售卖时段（不带的不改；空数组为全天都卖） */
export const SaleWindowsInput = z.array(WindowInput).max(MAX_SALE_WINDOWS, `售卖时段最多 ${MAX_SALE_WINDOWS} 段`).optional();
/** 菜品编辑交的档口时段（不带的不改；空数组为不按时段换档口） */
export const StationWindowsInput = z
  .array(WindowInput.extend({ stationId: z.number('请选这一段的档口').int().positive('请选这一段的档口') }))
  .max(MAX_STATION_WINDOWS, `档口时段最多 ${MAX_STATION_WINDOWS} 段`)
  .optional();

/** 这几道菜的档口时段（按开始的先后）；activeOnly：只要档口在用的（下单时用，停用的档口那一段不算） */
export async function stationWindowsOf(db: Db, itemIds: number[], opts: { activeOnly?: boolean } = {}): Promise<Map<number, DishStationWindow[]>> {
  if (itemIds.length === 0) return new Map();
  const rows = await db<{ itemId: number; start: number; end: number; stationId: number; stationName: string }[]>`
    SELECT w.item_id, w.start_minute AS start, w.end_minute AS end, w.station_id, s.name AS station_name
    FROM dish_station_windows w JOIN kitchen_stations s ON s.id = w.station_id
    WHERE w.item_id IN ${db([...new Set(itemIds)])} ${opts.activeOnly ? db`AND s.active` : db``}
    ORDER BY w.item_id, w.start_minute`;
  const map = new Map<number, DishStationWindow[]>();
  for (const r of rows) map.set(r.itemId, [...(map.get(r.itemId) ?? []), { start: r.start, end: r.end, stationId: r.stationId, stationName: r.stationName }]);
  return map;
}

/** 这几道菜的售卖时段（没设的不在里面） */
export async function saleWindowsOf(db: Db, itemIds: number[]): Promise<Map<number, DishWindow[]>> {
  if (itemIds.length === 0) return new Map();
  const rows = await db<{ id: number; saleWindows: DishWindow[] | null }[]>`
    SELECT id, sale_windows FROM service_items WHERE id IN ${db([...new Set(itemIds)])} AND sale_windows IS NOT NULL`;
  return new Map(rows.filter((r) => r.saleWindows && r.saleWindows.length).map((r) => [r.id, r.saleWindows!]));
}

const sortWindows = <T extends DishWindow>(ws: readonly T[]) => [...ws].sort((a, b) => a.start - b.start);
const stationWindowsText = (ws: readonly DishStationWindow[], nameOf: (id: number) => string) => (ws.length ? ws.map((w) => `${windowsText([w])} ${nameOf(w.stationId)}`).join('、') : '（没有）');

/**
 * 菜品保存时（事务里，这道菜已锁）写售卖时段与档口时段：不带的不改；核对段数、时间、档口时段不重叠、档口存在且在用
 * （原来就用着的停用档口照留）。返回改了什么（审计用；没改为空）
 */
export async function writeDishWindows(
  tx: Tx,
  id: number,
  f: { saleWindows?: DishWindow[] | undefined; stationWindows?: { start: number; end: number; stationId: number }[] | undefined },
  opts: { fresh?: boolean } = {},
): Promise<{ label: string; before: string; after: string }[]> {
  const changes: { label: string; before: string; after: string }[] = [];
  if (f.saleWindows !== undefined) {
    const next = sortWindows(f.saleWindows.map((w) => ({ start: w.start, end: w.end })));
    const problem = windowsProblem(next, '售卖时段', MAX_SALE_WINDOWS);
    if (problem) throw unprocessable('DISH_WINDOW_INVALID', problem);
    const cur = opts.fresh ? [] : ((await saleWindowsOf(tx, [id])).get(id) ?? []);
    if (windowsText(cur) !== windowsText(next)) {
      await tx`UPDATE service_items SET sale_windows = ${next.length ? tx.json(next as never) : null} WHERE id = ${id}`;
      changes.push({ label: '售卖时段', before: windowsText(cur), after: windowsText(next) });
    }
  }
  if (f.stationWindows !== undefined) {
    const next = sortWindows(f.stationWindows.map((w) => ({ start: w.start, end: w.end, stationId: w.stationId })));
    const problem = windowsProblem(next, '档口时段', MAX_STATION_WINDOWS);
    if (problem) throw unprocessable('DISH_WINDOW_INVALID', problem);
    const cur = opts.fresh ? [] : ((await stationWindowsOf(tx, [id])).get(id) ?? []);
    const ids = [...new Set(next.map((w) => w.stationId))];
    const stations = ids.length ? await tx<{ id: number; name: string; active: boolean }[]>`SELECT id, name, active FROM kitchen_stations WHERE id IN ${tx(ids)}` : [];
    if (stations.length !== ids.length) throw notFound('档口时段里有档口不存在，请刷新后重试');
    const off = stations.find((s) => !s.active && !cur.some((w) => w.stationId === s.id));
    if (off) throw unprocessable('STATION_INACTIVE', `档口「${off.name}」已停用，请换一个`);
    const nameOf = (sid: number) => stations.find((s) => s.id === sid)?.name ?? cur.find((w) => w.stationId === sid)?.stationName ?? '';
    const before = stationWindowsText(cur, nameOf);
    const after = stationWindowsText(next, nameOf);
    if (before !== after) {
      await tx`DELETE FROM dish_station_windows WHERE item_id = ${id}`;
      for (const w of next) {
        await tx`INSERT INTO dish_station_windows (item_id, start_minute, end_minute, station_id) VALUES (${id}, ${w.start}, ${w.end}, ${w.stationId})`;
      }
      changes.push({ label: '档口时段', before, after });
    }
  }
  return changes;
}

// ───────────────────────── 同组账单只看餐饮（R10） ─────────────────────────

/** 这几张手牌（在店的来访）各自的餐饮明细与小计（source 'dining'，有效的），只读 */
export async function diningSubtotals(db: Db, visitIds: number[]): Promise<DiningSubtotals> {
  const ids = [...new Set(visitIds)];
  const visits = await db<{ visitId: number; tagCode: string; billId: number }[]>`
    SELECT v.id AS visit_id, h.code AS tag_code, v.bill_id FROM visits v JOIN hand_tags h ON h.id = v.tag_id
    WHERE v.id IN ${db(ids)} AND v.store_id = ${currentStoreId()} ORDER BY h.code`;
  if (visits.length !== ids.length) throw notFound('有手牌的来访记录不存在，请刷新后重试');
  const lines = await db<{ id: number; billId: number; name: string; quantity: number; unitPrice: number; amount: number }[]>`
    SELECT id, bill_id, name, quantity, unit_price, amount FROM bill_lines
    WHERE bill_id IN ${db(visits.map((v) => v.billId))} AND status = 'active' AND source = 'dining' ORDER BY id`;
  const out = visits.map((v) => {
    const own = lines.filter((l) => l.billId === v.billId).map(({ billId: _b, ...l }) => l);
    return { visitId: v.visitId, tagCode: v.tagCode, amount: own.reduce((s, l) => s + l.amount, 0), quantity: own.reduce((s, l) => s + l.quantity, 0), lines: own };
  });
  return { visits: out, total: out.reduce((s, v) => s + v.amount, 0) };
}

export function registerDiningV8139Routes(app: FastifyInstance, deps: Deps) {
  const { sql } = deps;
  // 三处与小分类（不敏感，登录了就能读）：点单页、菜品表、厨房屏、台账都按它列小分类
  app.get('/api/dining/outlets', { preHandler: sessionReady }, async () => ({ outlets: await loadDiningOutlets(sql) }));

  // 前台结账核对时「只看餐饮」：几张手牌各自的餐饮小计（只读）
  app.get('/api/frontdesk/dining-subtotals', { preHandler: guardAny('frontdesk.checkout', 'frontdesk.read') }, async (req) => {
    const { visitIds } = parse(z.object({ visitIds: z.string().max(400) }), req.query ?? {});
    const ids = visitIds
      .split(',')
      .filter(Boolean)
      .map((x) => Number(x));
    if (ids.length === 0 || ids.length > 30 || ids.some((x) => !Number.isInteger(x) || x <= 0)) throw badRequest('手牌不对，请刷新后重试');
    return diningSubtotals(sql, ids);
  });
}
