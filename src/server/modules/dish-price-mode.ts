// 8.1.39 菜品的计价方式（docs/V8139.md 第 2 节；《餐饮新店新系统功能需求文档》R5、R15、R16）：
//   · 按价目（fixed，默认）：照旧按档计价，页面带来的改价拒绝；
//   · 时价 / 杂项（open）：点的时候填这一行每份多少钱（开瓶费、赔偿费、加工费、清洁费、时价菜），数量照常——
//     「开瓶费 400 元」填一次 ¥400，不用按 ¥1 点 400 份，退的时候也是整行退，不会拆成 400 条；
//   · 称重（weight）：点的时候填几斤（两位小数），每斤单价默认是价目的价，可以改；这一行按「每斤单价 × 斤数」四舍五入到分记一份。
// 改价、称重的数都记进出品单的备注与挂账的审计。价格以服务端为准：算出来的合计与页面带来的不一致照旧拒绝（PRICE_CHANGED）。
// 小程序扫码点餐、平板电子菜单不填这些：要现场定价、称重的菜在那里点会被拒绝，请服务员点（DISH_NEEDS_PRICE）。

import { z } from 'zod';
import { PRICE_MODE_LABELS, PRICE_MODES, MAX_OPEN_PRICE, MAX_WEIGHT_CENTI_JIN, weightText, type PriceMode } from '@shared/dish-price-mode';
import { formatYuan } from '@shared/money';
import { writeAudit } from '../lib/audit';
import type { Deps, OpContext } from '../lib/context';
import { badRequest, notFound, unprocessable } from '../lib/errors';
import { parse as parseInput } from '../lib/validate';
import type { PricedLine } from './pricing';

/** 请求里一行带的现场价格（不带时与升级前的请求完全相同，幂等摘要不变） */
export const PriceModeFields = {
  /** 时价 / 杂项：每份多少钱；称重：每斤单价（不带按价目的价） */
  customPrice: z
    .number('价格不正确')
    .int('价格要以分为单位的整数')
    .min(1, '价格要大于 0')
    .max(MAX_OPEN_PRICE, `价格最多 ${formatYuan(MAX_OPEN_PRICE)}`)
    .nullish()
    .transform((v) => v ?? undefined)
    .optional(),
  /** 称重：几斤，按 0.01 斤的整数（1.35 斤 = 135） */
  weight: z
    .number('斤数不正确')
    .int('斤数按 0.01 斤的整数')
    .min(1, '斤数要大于 0')
    .max(MAX_WEIGHT_CENTI_JIN, `一份最多 ${MAX_WEIGHT_CENTI_JIN / 100} 斤`)
    .nullish()
    .transform((v) => v ?? undefined)
    .optional(),
};

export interface PriceModeInput {
  customPrice?: number;
  weight?: number;
}

/** 按菜品的计价方式改这一行的单价、名称；返回写进出品单备注的那一句（没有的为空） */
export function applyPriceMode(mode: PriceMode, line: PricedLine, input: PriceModeInput, opts: { channel: boolean }): { line: PricedLine; note: string; detail: Record<string, unknown> | null } {
  const name = line.name;
  if (mode === 'fixed') {
    if (input.customPrice !== undefined || input.weight !== undefined) throw badRequest(`「${name}」按价目计价，不能改价、称重，请刷新后重新点`);
    return { line, note: '', detail: null };
  }
  if (opts.channel) {
    throw unprocessable('DISH_NEEDS_PRICE', `「${name}」是${PRICE_MODE_LABELS[mode]}的，要现场定价，请服务员点`);
  }
  if (mode === 'open') {
    if (input.weight !== undefined) throw badRequest(`「${name}」不是称重的菜，不用填斤数`);
    if (input.customPrice === undefined) throw unprocessable('DISH_NEEDS_PRICE', `「${name}」是时价 / 杂项，请填这一项多少钱`);
    const unitPrice = input.customPrice;
    return {
      line: { ...line, unitPrice, amount: unitPrice * line.quantity },
      note: `定价 ${formatYuan(unitPrice)}`,
      detail: { priceMode: mode, customPrice: unitPrice, listPrice: line.unitPrice },
    };
  }
  // 称重：一行一份
  if (input.weight === undefined) throw unprocessable('DISH_NEEDS_WEIGHT', `「${name}」要称重，请填几斤`);
  if (line.quantity !== 1) throw badRequest(`「${name}」是称重的菜，一行记一份，几份请分开称`);
  const perJin = input.customPrice ?? line.unitPrice;
  const unitPrice = Math.round((perJin * input.weight) / 100);
  if (unitPrice < 1) throw badRequest(`「${name}」称重算出来不到 1 分钱，请核对斤数与单价`);
  const w = weightText(input.weight);
  return {
    line: { ...line, name: lineWithWeight(name, w), unitPrice, amount: unitPrice },
    note: `${w}×${formatYuan(perJin)}/斤`,
    detail: { priceMode: mode, weight: input.weight, perJin, listPrice: line.unitPrice },
  };
}

/** 明细名称最多 32 字：「多宝鱼 1.35斤」，太长的截菜名 */
function lineWithWeight(name: string, w: string): string {
  const tail = ` ${w}`;
  return name.length + tail.length <= 32 ? `${name}${tail}` : `${name.slice(0, 32 - tail.length)}${tail}`;
}

// ───────────────────────── 后台：改一道菜的计价方式 ─────────────────────────

const ModeInput = z.object({ priceMode: z.enum(PRICE_MODES, '计价方式不正确') });

/**
 * 改一道菜的计价方式（菜品管理「改价」那一项权限）。只改以后点的；已经点了的明细照点的时候记的。
 * 锁：这道菜那一行（与改价同一行，docs/LOCKING.md「菜品管理」）
 */
export async function setDishPriceMode(deps: Deps, id: number, raw: unknown, ctx: OpContext): Promise<{ id: number; priceMode: PriceMode }> {
  const { priceMode } = parseInput(ModeInput, raw);
  await deps.sql.begin(async (tx) => {
    const [cur] = await tx<{ name: string; priceMode: PriceMode }[]>`
      SELECT name, price_mode FROM service_items WHERE id = ${id} AND station_id IS NOT NULL AND NOT technician_required FOR UPDATE`;
    if (!cur) throw notFound('菜品不存在');
    if (cur.priceMode === priceMode) return;
    await tx`UPDATE service_items SET price_mode = ${priceMode}, updated_at = clock_timestamp() WHERE id = ${id}`;
    await writeAudit(tx, {
      staffId: ctx.actor.id,
      action: 'dish_price_mode',
      targetType: 'item',
      targetId: id,
      detail: { name: cur.name, from: cur.priceMode, to: priceMode, summary: `「${cur.name}」计价方式：${PRICE_MODE_LABELS[cur.priceMode]} → ${PRICE_MODE_LABELS[priceMode]}` },
      ip: ctx.ip,
    });
  });
  return { id, priceMode };
}
