// 柜况与智能柜锁（8.1.49，docs/LOCKERS_V8149.md）。柜况页的数据就是发卡台的手牌板（/api/frontdesk/board），这里只管柜锁控制器：
//   GET  /api/lockers/controller        接的是哪种控制器、能做哪几样（查看在店手牌就能看）
//   POST /api/lockers/doors             问控制器这几个柜门开着没有（不能查柜门时为空）
//   POST /api/lockers/:id/open          远程开柜：要「维护手牌池」权限、写原因，记审计（开成没开成都记）；不能远程开柜回 503 LOCKER_NOT_CONFIGURED
// 发卡器（第 6 节，店主 2026-11-27：泰格柜锁、M1 手牌）：
//   POST /api/lockers/card/read         读发卡器上的卡，再按芯片号找绑的手牌（查看在店手牌；只读、不记审计）
//   POST /api/lockers/:id/card/write    把发卡器上的卡写成这张手牌的柜（维护手牌池、写原因、带先读卡看到的芯片号，记审计 locker_card_written）
//   POST /api/lockers/card/clear        清卡（维护手牌池、写原因、带先读卡看到的芯片号，记审计 locker_card_cleared）
//   没配发卡器回 503 LOCKER_CARD_NOT_CONFIGURED；读卡时桥没回应回 502 LOCKER_CONTROLLER_DOWN。
// 自选柜（第 7 节，店主 2026-11-27：手机柜是自选柜，一张手牌只能占一个）：
//   GET  /api/lockers/select               每个手机柜谁占着（芯片号 → 手牌 → 在店的来访单），标出一牌多柜、已退牌还占着、不认得的卡（查看在店手牌）
//   POST /api/lockers/select/:no/open      远程开一个手机柜（维护手牌池、写原因、记审计 locker_select_opened）
//   POST /api/lockers/select/:no/release   释放一个手机柜（维护手牌池、写原因、记审计 locker_select_released）
//   没配自选柜回 503 LOCKER_SELECT_NOT_CONFIGURED；列的时候桥没回应回 502 LOCKER_CONTROLLER_DOWN。
//   退牌后自动释放（第 7.4 节，GK3）：sweepReturnedPhoneLockers，每分钟的任务（jobs.ts）调。
// 开柜、写卡、清卡都在事务外调控制器（不拿着数据库连接等 5 秒），之后单独写审计；桥没回答、读回也没对上的记 uncertain（结果待确认），
// 页面让人读卡 / 到柜前确认，不当成没做（Codex 审查 f8b2853）。

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { CARD_UID_PATTERN, normalizeCardUid } from '@shared/frontdesk-risk';
import {
  analyzeSelectSlots,
  isOtherHolder,
  LOCKER_CARD_REASONS,
  LOCKER_OPEN_REASONS,
  LOCKER_RELEASE_RESERVE_PREFIX,
  LOCKER_SELECT_REASONS,
  LOCKER_UID_UNREADABLE,
  type LockerCardReadView,
  type LockerControllerInfo,
  type LockerSelectHolder,
  type LockerSelectView,
} from '@shared/lockers';
import { guard } from '../auth/guard';
import type { AppConfig, LockerConfig } from '../config';
import type { Sql } from '../db';
import { createLockerController, type LockerController } from '../devices/locker-controller';
import { writeAudit } from '../lib/audit';
import { ctxOf, type Deps } from '../lib/context';
import { AppError, notFound } from '../lib/errors';
import { currentStoreId, runInStore } from '../lib/store-context';
import { withTx } from '../lib/tx';
import { parse } from '../lib/validate';

const idParam = z.object({ id: z.coerce.number().int().positive() });
const DoorsInput = z.object({ codes: z.array(z.string().trim().min(1).max(16)).max(1000, '一次最多问 1000 个柜门') });
const OpenInput = z.object({ reason: z.string('请写开柜原因').trim().min(2, '请写开柜原因').max(100, '原因最多 100 个字') });
const CardInput = z.object({
  reason: z.string('请写原因').trim().min(2, '请写原因').max(100, '原因最多 100 个字'),
  /**
   * 只写、只清这一张卡（先读卡看到的芯片号）：发卡器上换成了别的卡就不动。必填：没收到回答时页面要按这张芯片号读卡核对，
   * 不认准是哪一张卡就核对不了（Codex 审查 307b2f4）
   */
  uid: z.string('请先读卡（要知道写、清的是哪一张卡）').transform(normalizeCardUid).pipe(z.string().regex(CARD_UID_PATTERN, '芯片号应为 4–32 位数字或字母')),
});

const noParam = z.object({ no: z.string().trim().min(1).max(16) });
const SelectOpenInput = z.object({ reason: z.string('请写原因').trim().min(2, '请写原因').max(100, '原因最多 100 个字') });
const SelectReleaseInput = SelectOpenInput.extend({
  /** 只放这张手牌占着的（点「释放」时页面看到的芯片号），换了人占着就不动；必填：认不出芯片号的不远程放（Codex 审查 38bdb98） */
  uid: z.string('请带上占着它的手牌的芯片号').transform(normalizeCardUid).pipe(z.string().regex(CARD_UID_PATTERN, '芯片号应为 4–32 位数字或字母')),
});

const controllers = new WeakMap<LockerConfig, LockerController>();
/** 同一份配置（同一个进程）共用一个控制器：柜况页的接口与每分钟的自动释放看的是同一个（模拟的也是同一份内存） */
export function lockerControllerFor(cfg: LockerConfig): LockerController {
  let c = controllers.get(cfg);
  if (!c) {
    c = createLockerController(cfg);
    controllers.set(cfg, c);
  }
  return c;
}

export function registerLockerRoutes(app: FastifyInstance, deps: Deps, controller: LockerController = lockerControllerFor(deps.config.lockers)): void {
  const { sql } = deps;
  /**
   * 柜锁桥接的是哪家店的柜子（LOCKER_STORE_ID）：别的店登录当成没接——看不到、开不了、发卡器与手机柜都用不了
   * （多门店时一个进程只有一套柜锁桥，Codex 审查 d0ecdcb）
   */
  const info = (): LockerControllerInfo => (currentStoreId() === deps.config.lockers.storeId ? controller.info : { driver: 'none', canOpen: false, canDoors: false, canCard: false, canSelect: false });

  const tagByUid = async (uid: string | null) => {
    if (!uid) return null;
    const [t] = await sql<{ id: number; code: string }[]>`
      SELECT id, code FROM hand_tags WHERE store_id = ${currentStoreId()} AND card_uid = ${uid} AND deleted_at IS NULL`;
    return t ? { id: Number(t.id), code: t.code } : null;
  };
  /** 这几个芯片号绑的是本店哪张手牌、手牌此刻在不在店（有没有没结的来访单） */
  const holdersOf = async (uids: string[]): Promise<Map<string, LockerSelectHolder>> => {
    const list = uids.filter((u) => u !== LOCKER_UID_UNREADABLE);
    if (!list.length) return new Map();
    const rows = await sql<{ id: number; code: string; cardUid: string; visitNo: string | null }[]>`
      SELECT t.id, t.code, t.card_uid, v.visit_no
      FROM hand_tags t LEFT JOIN visits v ON v.tag_id = t.id AND v.status = 'open'
      WHERE t.store_id = ${currentStoreId()} AND t.deleted_at IS NULL AND t.card_uid = ANY(${list}::text[])`;
    return new Map(rows.map((r) => [r.cardUid, { tagId: Number(r.id), code: r.code, visitNo: r.visitNo }]));
  };
  const requireSelect = () => {
    if (!info().canSelect) throw new AppError(503, 'LOCKER_SELECT_NOT_CONFIGURED', '还没有接自选柜（柜锁桥的 select 能力），看不了手机柜（见 docs/LOCKERS_V8149.md 第 7 节）');
  };
  const requireCard = () => {
    if (!info().canCard) throw new AppError(503, 'LOCKER_CARD_NOT_CONFIGURED', '还没有接发卡器（柜锁桥的 card 能力），不能读写手牌（见 docs/LOCKERS_V8149.md 第 6 节）');
  };

  app.get('/api/lockers/controller', { preHandler: guard('frontdesk.read') }, async () => ({
    ...info(),
    reasons: LOCKER_OPEN_REASONS,
    cardReasons: LOCKER_CARD_REASONS,
    selectReasons: LOCKER_SELECT_REASONS,
  }));

  app.post('/api/lockers/doors', { preHandler: guard('frontdesk.read') }, async (req) => {
    const { codes } = parse(DoorsInput, req.body);
    if (!info().canDoors || !codes.length) return [];
    try {
      return await controller.doors(codes);
    } catch (error) {
      req.log.warn({ err: error }, '柜锁控制器查柜门失败');
      throw new AppError(502, 'LOCKER_CONTROLLER_DOWN', '柜锁控制器没有回应，柜门状态暂时看不到');
    }
  });

  app.post('/api/lockers/:id/open', { preHandler: guard('frontdesk.tags') }, async (req) => {
    const { id } = parse(idParam, req.params);
    const { reason } = parse(OpenInput, req.body);
    if (!info().canOpen)
      throw new AppError(
        503,
        'LOCKER_NOT_CONFIGURED',
        info().driver === 'none' ? '这家店还没有接柜锁控制器，不能远程开柜（见 docs/LOCKERS_V8149.md）' : '接的柜锁不能远程开柜（单机锁只有发卡器），请用手牌或管理卡开',
      );
    const [tag] = await sql<{ code: string }[]>`
      SELECT code FROM hand_tags WHERE id = ${id} AND store_id = ${currentStoreId()} AND deleted_at IS NULL`;
    if (!tag) throw notFound('没有这个柜子');
    const result = await controller.open(tag.code);
    const ctx = ctxOf(req);
    await writeAudit(sql, {
      staffId: ctx.actor.id,
      action: 'locker_opened',
      targetType: 'hand_tag',
      targetId: id,
      detail: { code: tag.code, reason, driver: controller.info.driver, opened: result.opened, uncertain: result.uncertain, message: result.message },
      ip: ctx.ip,
    });
    return result;
  });

  app.post('/api/lockers/card/read', { preHandler: guard('frontdesk.read') }, async (req): Promise<LockerCardReadView> => {
    requireCard();
    let card;
    try {
      card = await controller.readCard();
    } catch (error) {
      req.log.warn({ err: error }, '柜锁桥读卡失败');
      throw new AppError(502, 'LOCKER_CONTROLLER_DOWN', '柜锁桥没有回应，读不了卡');
    }
    const tag = await tagByUid(card.uid);
    return { ...card, tag, mismatch: !!(card.code && tag && card.code !== tag.code) };
  });

  app.post('/api/lockers/:id/card/write', { preHandler: guard('frontdesk.tags') }, async (req) => {
    const { id } = parse(idParam, req.params);
    const { reason, uid } = parse(CardInput, req.body);
    requireCard();
    const [tag] = await sql<{ code: string }[]>`
      SELECT code FROM hand_tags WHERE id = ${id} AND store_id = ${currentStoreId()} AND deleted_at IS NULL`;
    if (!tag) throw notFound('没有这个柜子');
    const result = await controller.writeCard(tag.code, uid);
    const ctx = ctxOf(req);
    await writeAudit(sql, {
      staffId: ctx.actor.id,
      action: 'locker_card_written',
      targetType: 'hand_tag',
      targetId: id,
      // uid 记要写的那张卡；桥报上来的是另一张（发卡器上换了卡，没写）另记 bridgeUid
      detail: {
        code: tag.code,
        uid,
        bridgeUid: result.uid !== uid ? result.uid : undefined,
        reason,
        driver: controller.info.driver,
        ok: result.ok,
        uncertain: result.uncertain,
        message: result.message,
      },
      ip: ctx.ip,
    });
    // 这张卡的芯片号绑的是哪张手牌：没绑、绑在别的牌上的，页面提示去后台「手牌」绑（不自动改绑，GK6）
    return { ...result, code: tag.code, boundTag: await tagByUid(uid) };
  });

  app.post('/api/lockers/card/clear', { preHandler: guard('frontdesk.tags') }, async (req) => {
    const { reason, uid } = parse(CardInput, req.body);
    requireCard();
    const result = await controller.clearCard(uid);
    const tag = await tagByUid(uid);
    const ctx = ctxOf(req);
    await writeAudit(sql, {
      staffId: ctx.actor.id,
      action: 'locker_card_cleared',
      targetType: 'hand_tag',
      targetId: tag?.id,
      detail: {
        uid,
        bridgeUid: result.uid !== uid ? result.uid : undefined,
        code: tag?.code ?? null,
        reason,
        driver: controller.info.driver,
        ok: result.ok,
        uncertain: result.uncertain,
        message: result.message,
      },
      ip: ctx.ip,
    });
    return result;
  });

  app.get('/api/lockers/select', { preHandler: guard('frontdesk.read') }, async (req): Promise<{ slots: LockerSelectView[] }> => {
    requireSelect();
    let slots;
    try {
      slots = await controller.selectList();
    } catch (error) {
      req.log.warn({ err: error }, '柜锁桥列手机柜失败');
      throw new AppError(502, 'LOCKER_CONTROLLER_DOWN', '柜锁桥没有回应，手机柜暂时看不到');
    }
    const holders = await holdersOf([...new Set(slots.flatMap((x) => (x.uid ? [x.uid] : [])))]);
    return { slots: analyzeSelectSlots(slots, holders) };
  });

  app.post('/api/lockers/select/:no/open', { preHandler: guard('frontdesk.tags') }, async (req) => {
    const { no } = parse(noParam, req.params);
    const { reason } = parse(SelectOpenInput, req.body);
    requireSelect();
    const result = await controller.selectOpen(no);
    const ctx = ctxOf(req);
    await writeAudit(sql, {
      staffId: ctx.actor.id,
      action: 'locker_select_opened',
      targetType: 'locker_select',
      detail: { no, reason, driver: controller.info.driver, ok: result.ok, uncertain: result.uncertain, message: result.message },
      ip: ctx.ip,
    });
    return result;
  });

  app.post('/api/lockers/select/:no/release', { preHandler: guard('frontdesk.tags') }, async (req) => {
    const { no } = parse(noParam, req.params);
    const { reason, uid } = parse(SelectReleaseInput, req.body);
    requireSelect();
    const holder = (await holdersOf([uid])).get(uid) ?? null;
    // 占着它的手牌已经退了（不在店）：同自动释放，放之前先预留这张手牌，结果待确认的预留留着、每分钟的任务核对清楚才恢复——
    // 不然放的结果还没定，这张牌就可能发给新客人（第 7.4 节）。已经在预留着的（自动释放还没核对完）不另标
    const note = reserveNote(no);
    const reserve = holder && !holder.visitNo ? await reserveTag(sql, holder.tagId, uid, note) : 'skip';
    const result = await controller.selectRelease(no, uid);
    if (reserve === 'reserved' && !result.uncertain) await restoreTag(sql, holder!.tagId, note);
    const ctx = ctxOf(req);
    await writeAudit(sql, {
      staffId: ctx.actor.id,
      action: 'locker_select_released',
      targetType: holder ? 'hand_tag' : 'locker_select',
      targetId: holder?.tagId,
      detail: { no, uid, code: holder?.code ?? null, reason, driver: controller.info.driver, ok: result.ok, uncertain: result.uncertain, message: result.message },
      ip: ctx.ip,
    });
    return result;
  });
}

/** 自动释放期间给手牌标的「暂停使用」说明（预留）：发牌碰到暂停的手牌会拒绝；说明里带柜号，下一轮按它认出来接着核对 */
const RESERVE_NOTE_PREFIX = LOCKER_RELEASE_RESERVE_PREFIX;
const reserveNote = (no: string) => `${RESERVE_NOTE_PREFIX} ${no}（系统：放成了或确定没放成就恢复）`;
const reservedNo = (note: string | null) => note?.match(/^正在自动释放手机柜 (\S+?)（/)?.[1] ?? null;

/**
 * 预留（docs/LOCKERS_V8149.md 第 7.4 节）：短事务锁住这张手牌（发牌也先锁手牌），核对芯片号还绑在它上面、它现在不在店、是正常（能发）的，
 * 标「暂停使用」+ 说明；发牌碰到暂停的手牌会拒绝，改芯片号、删除也会拒绝（frontdesk/tags.ts）。
 * 返回 reserved 标上了；in_store 在店；skip 芯片号换了、删了、发不出去（停用、锁定、暂停、维修）
 */
async function reserveTag(sql: Sql, tagId: number, uid: string, note: string): Promise<'reserved' | 'in_store' | 'skip'> {
  return withTx(sql, async (tx) => {
    const [t] = await tx<{ active: boolean; locked: boolean; serviceStatus: string; deletedAt: Date | null; cardUid: string | null }[]>`
      SELECT active, locked, service_status, deleted_at, card_uid FROM hand_tags WHERE id = ${tagId} FOR UPDATE`;
    // 锁住以后再核对芯片号还绑在这张牌上（期间改绑过的不动，Codex 审查 a116c5f）
    if (!t || t.deletedAt || t.cardUid !== uid) return 'skip';
    const [open] = await tx`SELECT 1 FROM visits WHERE tag_id = ${tagId} AND status = 'open' LIMIT 1`;
    if (open) return 'in_store';
    if (!t.active || t.locked || t.serviceStatus !== 'normal') return 'skip';
    await tx`
      UPDATE hand_tags SET service_status = 'paused', service_note = ${note}, service_by = NULL, service_at = now(), updated_at = now()
      WHERE id = ${tagId}`;
    return 'reserved';
  });
}

/** 恢复自己标的那一条预留（期间有人改过就不动） */
async function restoreTag(sql: Sql, tagId: number, note: string): Promise<void> {
  await withTx(sql, async (tx) => {
    await tx`SELECT id FROM hand_tags WHERE id = ${tagId} FOR UPDATE`;
    await tx`
      UPDATE hand_tags SET service_status = 'normal', service_note = NULL, service_by = NULL, service_at = now(), updated_at = now()
      WHERE id = ${tagId} AND service_status = 'paused' AND service_note = ${note}`;
  });
}

/**
 * 退牌后自动释放手机柜（docs/LOCKERS_V8149.md 第 7.4 节，GK3；店主 2026-11-28「把开发全部做完」）：不释放的话，
 * 下一位拿到这张手牌的客人能开上一位的手机柜。每分钟列一次手机柜（jobs.ts 调），只看柜锁桥所在那家店（LOCKER_STORE_ID）的手牌：
 *   · 芯片号认得出、只绑了一张没删的手牌；
 *   · 这张手牌现在没有在店的来访单，而且来过（有结束了的来访单）——就是退了牌；
 *   · 锁报柜门还关着的不放（柜里可能还有东西：柜况页标「已退牌还占着」，请人看过再放）；报不了柜门的照放；
 *   · 每次退牌、每个柜只发起一次（审计里记着「柜 + 芯片号 + 那次退牌的时刻」）：确定没放成的留给柜况页的人。
 * 和发牌错开（Codex 审查 a92ac3e / d0ecdcb）：放之前开一个短事务锁住这张手牌（发牌也先锁手牌），核对确实不在店，标「暂停使用」
 * 当预留（发牌会拒绝暂停的手牌），提交以后才在事务外调柜锁桥。放成了、确定没放成（桥明确拒绝）才恢复；结果待确认、进程中途退出的
 * 预留**一直留着**，不按时间清：之后每一轮先按柜子现在的样子核对——空了或换成认得出的别的手牌就是放成了，恢复；还是这张手牌占着就再放一次。
 * 有人在后台把这张牌改回正常，就不再管它。不拿锁的钟和数据库的钟比先后。LOCKER_AUTO_RELEASE=off 关掉；没接自选柜（select）什么都不做。
 * 桥连不上照常抛出（每分钟任务记成出错，下一分钟再试）。返回这一轮确定放成了几个。
 */
export async function sweepReturnedPhoneLockers(deps: { sql: Sql; config: AppConfig }): Promise<number> {
  const cfg = deps.config.lockers;
  if (!cfg.autoRelease) return 0;
  const controller = lockerControllerFor(cfg);
  if (!controller.info.canSelect) return 0;
  return runInStore(cfg.storeId, async () => {
    const all = await controller.selectList();
    const audit = (tagId: number, detail: Record<string, unknown>) =>
      writeAudit(deps.sql, {
        staffId: null,
        action: 'locker_select_released',
        targetType: 'hand_tag',
        targetId: tagId,
        detail: { auto: true, driver: controller.info.driver, ...detail },
      });
    const restore = (tagId: number, note: string) => restoreTag(deps.sql, tagId, note);
    let released = 0;

    // ① 还留着的预留（上一次结果待确认，或进程中途退出）：先核对，还是这张手牌占着就再放一次
    const reserved = await deps.sql<{ id: number; code: string; cardUid: string | null; serviceNote: string }[]>`
      SELECT id, code, card_uid, service_note FROM hand_tags
      WHERE store_id = ${cfg.storeId} AND deleted_at IS NULL AND service_status = 'paused' AND service_note LIKE ${`${RESERVE_NOTE_PREFIX} %`}`;
    const reservedIds = new Set(reserved.map((t) => Number(t.id)));
    for (const t of reserved) {
      const no = reservedNo(t.serviceNote);
      const slot = no ? all.find((x) => x.no === no) : undefined;
      if (!no || !t.cardUid || !slot) continue; // 看不出来：留着（人可以在后台把手牌改回正常）
      const tagId = Number(t.id);
      if (slot.uid === null || isOtherHolder(slot.uid, t.cardUid)) {
        await restore(tagId, t.serviceNote);
        await audit(tagId, { no, uid: t.cardUid, code: t.code, reason: '退牌后自动释放（核对：柜子已经空出来了）', ok: true, uncertain: false, settled: true });
        released += 1;
        continue;
      }
      if (slot.uid !== t.cardUid) continue; // 芯片号认不出：留着
      const result = await controller.selectRelease(no, t.cardUid);
      await audit(tagId, { no, uid: t.cardUid, code: t.code, reason: '退牌后自动释放（再放一次）', ok: result.ok, uncertain: result.uncertain, message: result.message });
      if (!result.uncertain) await restore(tagId, t.serviceNote);
      if (result.ok) released += 1;
    }

    // ② 新退了牌、还占着手机柜的
    const slots = all.filter((x) => x.uid && x.uid !== LOCKER_UID_UNREADABLE && x.doorOpen !== false);
    if (!slots.length) return released;
    const uids = [...new Set(slots.map((x) => x.uid!))];
    const tags = await deps.sql<{ id: number; code: string; cardUid: string; inStore: boolean; returnedAt: Date | null }[]>`
      SELECT t.id, t.code, t.card_uid,
             EXISTS (SELECT 1 FROM visits v WHERE v.tag_id = t.id AND v.status = 'open') AS in_store,
             (SELECT max(v.closed_at) FROM visits v WHERE v.tag_id = t.id AND v.status <> 'open') AS returned_at
      FROM hand_tags t
      WHERE t.store_id = ${cfg.storeId} AND t.deleted_at IS NULL AND t.card_uid = ANY(${uids}::text[])`;
    const byUid = new Map<string, (typeof tags)[number] | null>();
    for (const t of tags) byUid.set(t.cardUid, byUid.has(t.cardUid) ? null : t);
    for (const slot of slots) {
      const tag = byUid.get(slot.uid!);
      if (!tag || tag.inStore || !tag.returnedAt || reservedIds.has(Number(tag.id))) continue;
      const tagId = Number(tag.id);
      const returnedAt = new Date(tag.returnedAt).toISOString();
      const [tried] = await deps.sql`
        SELECT 1 FROM audit_logs
        WHERE action = 'locker_select_released' AND detail->>'auto' = 'true'
          AND detail->>'no' = ${slot.no} AND detail->>'uid' = ${slot.uid} AND detail->>'returnedAt' = ${returnedAt}
        LIMIT 1`;
      if (tried) continue;
      // 预留：锁住这张手牌，核对芯片号、确实不在店、现在能发（正常）的才标「暂停使用」。停用、锁定、被人暂停、维修中的不自动放：
      // 放的时候有人把它改回正常就又能发了，没有预留挡着——留给柜况页的人（「已退牌还占着」）
      const note = reserveNote(slot.no);
      const reserve = await reserveTag(deps.sql, tagId, slot.uid!, note);
      if (reserve !== 'reserved') continue;
      const result = await controller.selectRelease(slot.no, slot.uid);
      await audit(tagId, { no: slot.no, uid: slot.uid, code: tag.code, reason: '退牌后自动释放', returnedAt, ok: result.ok, uncertain: result.uncertain, message: result.message });
      // 放成了、确定没放成才恢复；结果待确认的预留留着，下一轮核对
      if (!result.uncertain) await restore(tagId, note);
      if (result.ok) released += 1;
    }
    return released;
  });
}
