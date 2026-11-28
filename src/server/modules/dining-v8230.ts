// 8.2.30 收银合并的餐饮补全（docs/V8230_CASHIER.md 第 4 节）：
//   · 出品单的标记（CM-16）：一道或整单标等叫（先不做，点「起菜」再做）、加急、打包；只是标记，不动金额；
//   · 沽清一键恢复（CM-17）：开市时把今天的沽清、限量全部取消（柚子的沽清本来按营业日记，第二天自动不算）。
// 分次上菜（CM-19）在 dining.ts 的 kitchenAction，待催（CM-18）在 tables.ts 的桌台看板。

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { CupLabels } from '@shared/dining';
import { guard, guardAny } from '../auth/guard';
import type { Db } from '../db';
import { writeAudit } from '../lib/audit';
import { ctxOf, type Deps, type OpContext } from '../lib/context';
import { conflict, notFound } from '../lib/errors';
import { currentStoreId } from '../lib/store-context';
import { parse } from '../lib/validate';
import { businessDate, setTxTimeouts } from './frontdesk/index';
import { kitchenBoard } from './dining';

const FlagsInput = z
  .object({
    ids: z.array(z.number().int().positive()).min(1, '请选菜').max(100, '一次最多 100 道'),
    hold: z.boolean().optional(),
    urgent: z.boolean().optional(),
    takeaway: z.boolean().optional(),
  })
  .refine((x) => x.hold !== undefined || x.urgent !== undefined || x.takeaway !== undefined, '请选要标什么');

const FLAG_LABELS = { hold: '等叫', urgent: '加急', takeaway: '打包' } as const;

/**
 * 标记出品单：按 id 升序锁住这几道。等叫只能标在还没开始做的（待做）；「起菜」= 取消等叫；加急、打包在没上菜之前都能改。
 * 已退、已上菜的跳过不了：整批拒绝，页面刷新后重选
 */
export async function setKitchenFlags(deps: Deps, raw: unknown, ctx: OpContext): Promise<{ updated: number }> {
  const input = parse(FlagsInput, raw);
  const ids = [...new Set(input.ids)].sort((a, b) => a - b);
  return deps.sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    const at = ctx.at ?? new Date();
    const rows = await tx<{ id: number; status: string; name: string }[]>`
      SELECT k.id, k.status, l.name FROM kitchen_items k JOIN bill_lines l ON l.id = k.bill_line_id
      WHERE k.id IN ${tx(ids)} AND k.store_id = ${currentStoreId()} ORDER BY k.id FOR UPDATE OF k`;
    if (rows.length !== ids.length) throw conflict('DISH_CHANGED', '有菜已经不在了，请刷新');
    const done = rows.find((r) => r.status === 'served' || r.status === 'cancelled');
    if (done) throw conflict('DISH_CHANGED', `「${done.name}」已经${done.status === 'served' ? '上菜' : '退了'}，请刷新后重选`);
    if (input.hold === true) {
      const started = rows.find((r) => r.status !== 'queued');
      if (started) throw conflict('DISH_STARTED', `「${started.name}」厨房已经开始做了，不能再等叫`);
      // 套餐在别的档口的子项（Codex 审查 06b2eee）：有一样开始做了也不能等叫。出品单已锁，子项单开始做要先对出品单加共享锁，这里读到的不会过时
      const [part] = await tx<{ name: string }[]>`
        SELECT name FROM kitchen_item_parts WHERE kitchen_item_id IN ${tx(ids)} AND split AND status IN ('cooking', 'done') ORDER BY id LIMIT 1`;
      if (part) throw conflict('DISH_STARTED', `套餐里的「${part.name}」别的档口已经开始做了，不能再等叫`);
    }
    await tx`
      UPDATE kitchen_items SET
        hold = ${input.hold ?? tx`hold`},
        urgent = ${input.urgent ?? tx`urgent`},
        takeaway = ${input.takeaway ?? tx`takeaway`}
      WHERE id IN ${tx(ids)}`;
    const what = (Object.keys(FLAG_LABELS) as (keyof typeof FLAG_LABELS)[])
      .filter((k) => input[k] !== undefined)
      .map((k) => (k === 'hold' && input.hold === false ? '起菜' : `${input[k] ? '' : '取消'}${FLAG_LABELS[k]}`));
    await writeAudit(tx, {
      staffId: ctx.actor.id,
      action: 'dining_kitchen_flags',
      targetType: 'kitchen_item',
      targetId: ids[0]!,
      detail: { ids, summary: `${what.join('、')}：${rows.map((r) => r.name).join('、')}`.slice(0, 200) },
      ip: ctx.ip,
      businessDate: await businessDate(tx, deps, at),
    });
    return { updated: ids.length };
  });
}

/** 沽清一键恢复（CM-17）：取消今天全部的沽清与限量（记审计，列出取消了哪几道） */
export async function restoreAllLimits(deps: Deps, ctx: OpContext): Promise<{ restored: number }> {
  return deps.sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    const at = ctx.at ?? new Date();
    const today = await businessDate(tx, deps, at);
    // 与下单扣沽清同一个顺序：按菜品 id 升序先锁住，再删
    await tx`SELECT item_id FROM dish_limits WHERE business_date = ${today} ORDER BY item_id FOR UPDATE`;
    const gone = await tx<{ itemId: number; name: string; remaining: number }[]>`
      DELETE FROM dish_limits d USING service_items i
      WHERE i.id = d.item_id AND d.business_date = ${today}
      RETURNING d.item_id, i.name, d.remaining`;
    if (gone.length) {
      await writeAudit(tx, {
        staffId: ctx.actor.id,
        action: 'dish_limit_set',
        targetType: 'item',
        targetId: Number(gone[0]!.itemId),
        detail: { summary: `沽清全部恢复（${gone.length} 道）：${gone.map((g) => g.name).join('、')}`.slice(0, 200), remaining: null },
        ip: ctx.ip,
        businessDate: today,
      });
    }
    return { restored: gone.length };
  });
}

/**
 * 杯贴（CM-21）：一单的饮品一杯一张——品名、做法与备注、第几杯、取餐号（8.2.19 水吧的取餐号，有的话）、手牌或桌号、下单时刻。
 * 只读；页面用浏览器打印（贴纸打印机当普通打印机用），退了的不打
 */
export async function cupLabels(db: Db, orderNo: string): Promise<CupLabels> {
  const rows = await db<{ name: string; note: string; quantity: number; tagCode: string | null; tableName: string | null; createdAt: Date; outlet: string | null }[]>`
    SELECT bl.name, k.note, k.quantity, h.code AS tag_code, dt.name AS table_name, k.created_at,
           (SELECT si.dining_outlet FROM service_items si WHERE si.id = k.item_id) AS outlet
    FROM kitchen_items k JOIN bill_lines bl ON bl.id = k.bill_line_id
    LEFT JOIN visits v ON v.id = k.visit_id LEFT JOIN hand_tags h ON h.id = v.tag_id
    LEFT JOIN table_sessions ts ON ts.id = k.table_session_id LEFT JOIN dining_tables dt ON dt.id = ts.table_id
    WHERE k.order_no = ${orderNo} AND k.store_id = ${currentStoreId()} AND k.status <> 'cancelled'
    ORDER BY k.id`;
  if (!rows.length) throw notFound('这一单没有能打杯贴的饮品');
  // 一单里有水吧的饮品就只打水吧的（同一单可能还点了菜）；都没设点单分类的照全部打
  const drinks = rows.some((r) => r.outlet === 'water') ? rows.filter((r) => r.outlet === 'water') : rows;
  const [p] = await db<{ pickupNo: number }[]>`SELECT pickup_no FROM pickup_tickets WHERE order_no = ${orderNo}`;
  const total = drinks.reduce((n, r) => n + r.quantity, 0);
  const labels: CupLabels['labels'] = [];
  for (const r of drinks) for (let i = 0; i < r.quantity; i += 1) labels.push({ name: r.name, note: r.note, seq: labels.length + 1 });
  const first = drinks[0]!;
  return {
    orderNo,
    pickupNo: p ? Number(p.pickupNo) : null,
    where: first.tableName ? `桌 ${first.tableName}` : first.tagCode ? `手牌 ${first.tagCode}` : '',
    createdAt: new Date(first.createdAt).toISOString(),
    total,
    labels,
  };
}

export function registerDiningV8230Routes(app: FastifyInstance, deps: Deps) {
  app.get('/api/dining/cup-labels/:orderNo', { preHandler: guardAny('dining.kitchen', 'dining.order') }, async (req) =>
    cupLabels(deps.sql, parse(z.object({ orderNo: z.string().trim().min(1).max(40) }), req.params).orderNo),
  );
  app.post('/api/dining/items/flags', { preHandler: guard('dining.order') }, async (req) => setKitchenFlags(deps, req.body, ctxOf(req)));
  app.post('/api/kitchen/limits/restore-all', { preHandler: guard('dining.kitchen') }, async (req) => {
    const r = await restoreAllLimits(deps, ctxOf(req));
    return { ...r, board: await kitchenBoard(deps.sql, deps) };
  });
}
