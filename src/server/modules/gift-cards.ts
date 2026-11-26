// 8.1.40 礼品卡先出卡、后绑手机号（docs/V8140.md 第 5 节；《门店系统需求梳理与优化方案》「礼品卡批量生成」）。
//
// 不另建一套卡：礼品卡就是匿名卡会员（不要手机号，会员号就是卡号），一批一次生成（最多 200 张），一个事务、一个操作编号。
// 送出去以后在会员资料里「转实名」填手机号（转实名、改手机号的规矩照旧）；要预存金额的，按这张卡（会员号）照常充值，钱只在会员钱包里。
// 批次列表写每一批几张、已经绑了手机号的几张、预存了多少（本金余额合计）；导出这一批的卡号（印卡用）。
// 权限：管券的（coupon.manage）——与「发券」页同一项（合并前 Codex 审查 c79ca75：页面只给管券的进，接口也一样）。
// 锁：作废登记（op_fences，按编号）→ 批次的操作编号（唯一约束兜底）→ 新会员行 → 开卡送券（与单个建档一样）。不碰钱包。
// 页面上与生成无记名券同一套「结果待确认」（迁移 322）：发出前本机存好编号与原请求，没收到结果时查回、原样重提或确认作废。

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { businessDateOf } from '@shared/business-date';
import { MAX_GIFT_CARD_BATCH, type GiftCardBatch } from '@shared/gift-cards';
import { isUniqueViolation, type Db } from '../db';
import { guard } from '../auth/guard';
import { writeAudit } from '../lib/audit';
import { csvReply, toCsv } from '../lib/csv';
import { ctxOf, type Deps, type OpContext } from '../lib/context';
import { conflict, notFound } from '../lib/errors';
import { hashRequest } from '../lib/idempotency';
import { idParam, parse } from '../lib/validate';
import { nextDocNo } from '../lib/tx';
import { currentStoreId } from '../lib/store-context';
import { assertNotFenced } from '../lib/fences';
import { erpOpAbandoned } from './erp-ops';
import { issueOpenCardCoupons } from './coupons';
import { loadSettings } from './settings';

const BatchInput = z.object({
  clientKey: z.uuid('缺少有效的操作编号，请刷新页面后重试'),
  /** 卡上的名字：会员档案的姓名写「礼品卡」这类，转实名时改成客人的名字 */
  label: z.string('请填写礼品卡的名称').trim().min(1, '请填写礼品卡的名称').max(16, '名称最多 16 个字'),
  quantity: z.number('张数必须是整数').int('张数必须是整数').min(1, '至少 1 张').max(MAX_GIFT_CARD_BATCH, `一批最多 ${MAX_GIFT_CARD_BATCH} 张`),
  note: z.string().trim().max(200, '备注最多 200 字').default(''),
});

/** 生成一批礼品卡（匿名卡会员）；同一操作编号重提返回同一批，内容不同拒绝 */
export async function createGiftCardBatch(deps: Deps, raw: unknown, ctx: OpContext): Promise<{ batch: GiftCardBatch; replayed: boolean }> {
  const { clientKey, ...payload } = parse(BatchInput, raw);
  const requestHash = hashRequest(payload);
  const replay = async () => {
    const [b] = await deps.sql<{ id: number; requestHash: string }[]>`SELECT id, request_hash FROM gift_card_batches WHERE client_key = ${clientKey}`;
    if (!b) return null;
    if (b.requestHash !== requestHash) throw conflict('IDEMPOTENCY_CONFLICT', '这个操作编号已用于另一批礼品卡，请刷新页面后重新生成');
    return { batch: await getGiftCardBatch(deps.sql, Number(b.id)), replayed: true };
  };
  const prior = await replay();
  if (prior) return prior;
  try {
    const id = await deps.sql.begin(async (tx) => {
      // 页面确认作废过的编号（「结果待确认」里点了作废）：迟到的原请求不再生成（Codex 审查 8a7023d）
      await assertNotFenced(tx, clientKey, 'gift_card_batch', erpOpAbandoned);
      const at = ctx.at ?? new Date();
      const date = businessDateOf(at, deps.config.timezone, (await loadSettings(tx)).businessDayStartHour);
      const batchNo = await nextDocNo(tx, 'gift_card_batch', 'LP', date);
      const [b] = await tx<{ id: number }[]>`
        INSERT INTO gift_card_batches (batch_no, label, quantity, note, client_key, request_hash, created_by, created_at)
        VALUES (${batchNo}, ${payload.label}, ${payload.quantity}, ${payload.note}, ${clientKey}, ${requestHash}, ${ctx.actor.id}, ${at})
        RETURNING id`;
      // 匿名卡会员：姓名先写礼品卡的名称，没有手机号；会员号（YZ 开头）就是卡号
      const made = await tx<{ id: number }[]>`
        INSERT INTO members (member_no, name, phone, card_type, note, created_by, gift_batch_id)
        SELECT 'YZ' || lpad(nextval('member_no_seq')::text, 5, '0'), ${payload.label}, NULL, 'anonymous', ${`礼品卡 ${batchNo}`}, ${ctx.actor.id}, ${b!.id}
        FROM generate_series(1, ${payload.quantity})
        RETURNING id`;
      // 开卡送券：与单个建档同一套规则（合并前 Codex 审查 1c79c00：礼品卡也是新开的卡，不能漏掉开卡礼）
      for (const m of made) await issueOpenCardCoupons(tx, deps, Number(m.id), ctx);
      await writeAudit(tx, {
        staffId: ctx.actor.id,
        action: 'gift_card_batch',
        targetType: 'gift_card_batch',
        targetId: b!.id,
        detail: { batchNo, label: payload.label, quantity: payload.quantity, note: payload.note },
        ip: ctx.ip,
        businessDate: date,
      });
      return Number(b!.id);
    });
    return { batch: await getGiftCardBatch(deps.sql, id), replayed: false };
  } catch (e) {
    // 同一编号并发提交：后到的等先到的提交后按重提处理
    if (isUniqueViolation(e, 'gift_card_batches_client_key_key')) {
      const again = await replay();
      if (again) return again;
    }
    throw e;
  }
}

const BATCH_SELECT = (db: Db) => db`
  SELECT b.id, b.batch_no, b.label, b.quantity, b.note, b.created_at, s.display_name AS created_by_name,
         count(m.id) FILTER (WHERE m.phone IS NOT NULL)::int AS bound,
         coalesce(sum(m.principal_balance), 0)::bigint AS principal
  FROM gift_card_batches b JOIN staff s ON s.id = b.created_by LEFT JOIN members m ON m.gift_batch_id = b.id`;

const toBatch = (r: GiftCardBatch & { createdAt: Date | string }) => ({ ...r, id: Number(r.id), principal: Number(r.principal), createdAt: new Date(r.createdAt).toISOString() });

export async function listGiftCardBatches(db: Db): Promise<GiftCardBatch[]> {
  const rows = await db<GiftCardBatch[]>`${BATCH_SELECT(db)} WHERE b.store_id = ${currentStoreId()} GROUP BY b.id, s.display_name ORDER BY b.id DESC LIMIT 200`;
  return rows.map(toBatch);
}

export async function getGiftCardBatch(db: Db, id: number): Promise<GiftCardBatch> {
  // 只认当前门店的批次（与列表同一口径；合并前 Codex 审查 1a89c41：改编号看不到别的店的卡号、导不出）
  const [r] = await db<GiftCardBatch[]>`${BATCH_SELECT(db)} WHERE b.id = ${id} AND b.store_id = ${currentStoreId()} GROUP BY b.id, s.display_name`;
  if (!r) throw notFound('这批礼品卡不存在');
  return toBatch(r);
}

/** 这一批的卡：卡号（会员号）、绑没绑手机号、现在的名字与本金余额 */
export async function giftCardsOf(db: Db, id: number) {
  await getGiftCardBatch(db, id);
  const rows = await db<{ id: number; memberNo: string; name: string; bound: boolean; principalBalance: number }[]>`
    SELECT id, member_no, name, phone IS NOT NULL AS bound, principal_balance FROM members WHERE gift_batch_id = ${id} ORDER BY id`;
  return rows.map((r) => ({ ...r, id: Number(r.id), principalBalance: Number(r.principalBalance) }));
}

export function registerGiftCardRoutes(app: FastifyInstance, deps: Deps) {
  app.get('/api/gift-cards', { preHandler: guard('coupon.manage') }, async () => listGiftCardBatches(deps.sql));
  app.post('/api/gift-cards', { preHandler: guard('coupon.manage') }, async (req, reply) => {
    const r = await createGiftCardBatch(deps, req.body, ctxOf(req));
    reply.code(r.replayed ? 200 : 201);
    return r;
  });
  app.get('/api/gift-cards/:id/cards', { preHandler: guard('coupon.manage') }, async (req) => giftCardsOf(deps.sql, parse(idParam, req.params).id));
  // 导出卡号（印卡用）
  app.get('/api/gift-cards/:id/cards.csv', { preHandler: guard('coupon.manage') }, async (req, reply) => {
    const id = parse(idParam, req.params).id;
    const b = await getGiftCardBatch(deps.sql, id);
    const cards = await giftCardsOf(deps.sql, id);
    // 转义与防公式（名字以 = + @ 开头）交给 toCsv（合并前 Codex 审查 305508f）
    return csvReply(
      reply,
      `gift-cards-${b.batchNo}.csv`,
      toCsv([['卡号', '名称', '已绑手机号', '本金余额（元）'], ...cards.map((c) => [c.memberNo, c.name, c.bound ? '是' : '否', (c.principalBalance / 100).toFixed(2)])]),
    );
  });
}
