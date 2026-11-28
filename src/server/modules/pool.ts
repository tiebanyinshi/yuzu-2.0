// 8.2.27 男汤 / 女汤泡池（docs/V82227_POOL.md；走场「泡池面板：输单，先刷客人手牌、再刷技师手牌，服务计入技师业绩明细」）。
//   · 下单就是钟房的「派钟」（/api/clockroom/dispatch：挂账、建钟单、立即上钟，一个操作编号），这里只给泡池面板认人：
//     刷到的芯片号先认手牌（客人）、再认技师工牌；手输的按牌号（客人）或工号（技师）；
//   · 技师工牌：技师管理的岗位在泡池面板上给技师绑芯片号（technicians.card_uid，同一门店不重复，不能是手牌的芯片号）。

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { normalizeTagCode } from '@shared/frontdesk';
import { CARD_UID_PATTERN, normalizeCardUid } from '@shared/frontdesk-risk';
import type { PoolGuest, PoolTechnician } from '@shared/pool';
import type { Db } from '../db';
import { isUniqueViolation } from '../db';
import { guard, guardAny } from '../auth/guard';
import { writeAudit } from '../lib/audit';
import { ctxOf, type Deps, type OpContext } from '../lib/context';
import { badRequest, conflict, notFound } from '../lib/errors';
import { lockCardBindings } from '../lib/card-bindings';
import { currentStoreId } from '../lib/store-context';
import { idParam, parse } from '../lib/validate';

const Lookup = z.object({ code: z.string().trim().max(32).optional(), uid: z.string().trim().max(64).optional() }).refine((q) => !!q.code || !!q.uid, '请刷卡或输入号码');

/** 刷到 / 输入的客人：芯片号按手牌的芯片号查，手输的按牌号；只认在店的 */
export async function poolGuest(db: Db, q: { code?: string; uid?: string }): Promise<PoolGuest> {
  const uid = q.uid ? normalizeCardUid(q.uid) : null;
  const code = q.code ? normalizeTagCode(q.code) : null;
  const [r] = await db<{ visitId: number; tagCode: string; zone: string; ticketName: string | null }[]>`
    SELECT v.id AS visit_id, t.code AS tag_code, v.zone, tt.name AS ticket_name
    FROM hand_tags t JOIN visits v ON v.tag_id = t.id AND v.status = 'open'
    LEFT JOIN ticket_types tt ON tt.id = v.ticket_type_id
    WHERE t.store_id = ${currentStoreId()} AND ${uid ? db`t.card_uid = ${uid}` : db`t.code = ${code}`}
    ORDER BY v.id DESC LIMIT 1`;
  if (!r) throw notFound(uid ? '这张卡不是在店客人的手牌（技师工牌请在下一步刷）' : `手牌 ${code} 没有在店客人，请核对牌号`);
  return { visitId: Number(r.visitId), tagCode: r.tagCode, zone: r.zone, ticketName: r.ticketName };
}

/** 刷到 / 输入的技师：芯片号按工牌查，手输的按工号；停用的不认 */
export async function poolTechnician(db: Db, q: { code?: string; uid?: string }): Promise<PoolTechnician> {
  const uid = q.uid ? normalizeCardUid(q.uid) : null;
  const code = q.code?.trim() ?? '';
  const [r] = await db<PoolTechnician[]>`
    SELECT id, tech_no, name, nickname FROM technicians
    WHERE store_id = ${currentStoreId()} AND active AND ${uid ? db`card_uid = ${uid}` : db`lower(tech_no) = lower(${code})`}
    LIMIT 1`;
  if (!r) throw notFound(uid ? '这张卡还没绑技师（技师管理的岗位可以在泡池面板上「绑工牌」）' : `没有工号 ${code} 的在职技师`);
  return { ...r, id: Number(r.id) };
}

const CardInput = z.object({ uid: z.string().trim().max(64).nullable() });

/** 给技师绑 / 解绑工牌芯片号 */
export async function bindTechnicianCard(deps: Deps, id: number, raw: unknown, ctx: OpContext): Promise<PoolTechnician> {
  const { uid: rawUid } = parse(CardInput, raw);
  const uid = rawUid ? normalizeCardUid(rawUid) : null;
  if (uid !== null && !CARD_UID_PATTERN.test(uid)) throw badRequest('芯片号要是 4–32 位数字或字母');
  return deps.sql.begin(async (tx) => {
    // 芯片号绑定锁在前（手牌那边绑卡、导入也拿它），再锁技师这一行
    await lockCardBindings(tx);
    const [t] = await tx<{ id: number; techNo: string; name: string; cardUid: string | null }[]>`
      SELECT id, tech_no, name, card_uid FROM technicians WHERE id = ${id} AND store_id = ${currentStoreId()} FOR UPDATE`;
    if (!t) throw notFound('技师不存在');
    if (uid) {
      const [tag] = await tx<{ code: string }[]>`SELECT code FROM hand_tags WHERE store_id = ${currentStoreId()} AND card_uid = ${uid}`;
      if (tag) throw conflict('CARD_IS_TAG', `这张卡是手牌 ${tag.code} 的芯片，不能当技师工牌`);
    }
    try {
      await tx`UPDATE technicians SET card_uid = ${uid}, updated_at = now() WHERE id = ${id}`;
    } catch (e) {
      if (isUniqueViolation(e, 'technicians_card_uid_uq')) throw conflict('TECH_CARD_TAKEN', '这张卡已经绑给别的技师了，先在那位技师上解绑');
      throw e;
    }
    await writeAudit(tx, {
      staffId: ctx.actor.id,
      action: 'technician_card_bound',
      targetType: 'technician',
      targetId: id,
      detail: { techNo: t.techNo, name: t.name, before: t.cardUid, after: uid },
      ip: ctx.ip,
    });
    const [r] = await tx<PoolTechnician[]>`SELECT id, tech_no, name, nickname FROM technicians WHERE id = ${id}`;
    return { ...r!, id: Number(r!.id) };
  });
}

export function registerPoolRoutes(app: FastifyInstance, deps: Deps) {
  const read = guardAny('technician.dispatch', 'frontdesk.operate');
  app.get('/api/pool/guest', { preHandler: read }, async (req) => poolGuest(deps.sql, parse(Lookup, req.query ?? {})));
  app.get('/api/pool/technician', { preHandler: read }, async (req) => poolTechnician(deps.sql, parse(Lookup, req.query ?? {})));
  app.put('/api/technicians/:id/card', { preHandler: guard('technician.manage') }, async (req) => bindTechnicianCard(deps, parse(idParam, req.params).id, req.body, ctxOf(req)));
}
