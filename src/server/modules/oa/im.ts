// OA-14 即时通讯：会话与消息（docs/OA.md 第 17 节；需求文档六（一）、九（二）第 6 条）。员工端「办公 → 消息」。
//   · 单聊：同两个人只有一个（direct_key）；群聊：群名 + 成员（连自己 3–500 人），建群的人是群主，带操作编号（oa_im_group：查回、确认作废走 /api/erp/ops）。
//   · 消息：文本（含表情）、图片、文件（OA-03 附件，只有会话成员看得到）；发送带操作编号（同一个人同一个编号只有一条，原样重提返回原来那一条）。
//   · 撤回：发的人、2 分钟内（服务端时间）；撤回以后原内容不再给出。@：群聊里 @成员 / @所有人，被 @ 的人收到站内通知。
//   · 历史分页（before）、取新消息与最近的撤回（after，页面每 3 秒取一次）、上报读到哪一条（只往前走）。
//   · 已读回执、统一实时通道、新消息进站内通知在 OA-15；通讯录、群管理在 OA-16。
// 加锁（docs/LOCKING.md「即时通讯」）：发消息 = 会话行（FOR UPDATE）→ 消息 → 附件行 → 通知；撤回 = 消息行（FOR UPDATE）；已读 = 自己的成员行。

import type { FastifyInstance, preHandlerAsyncHookHandler } from 'fastify';
import { z } from 'zod';
import {
  IM_GROUP_MAX,
  IM_GROUP_MIN,
  IM_GROUP_NAME_MAX,
  IM_PAGE,
  IM_REVOKE_MINUTES,
  IM_TEXT_MAX,
  imPreview,
  type ImConversationDetail,
  type ImConversationItem,
  type ImConversationList,
  type ImMessage,
  type ImMessageKind,
  type ImMessagePage,
  type ImPollResult,
  type ImRole,
  type ImSent,
} from '@shared/oa-im';
import { isUniqueViolation, type Db, type Fragment, type Tx } from '../../db';
import { guard } from '../../auth/guard';
import type { Actor, Deps } from '../../lib/context';
import { conflict, forbidden, notFound, unprocessable } from '../../lib/errors';
import { assertNotFenced, lockOpKey } from '../../lib/fences';
import { hashRequest } from '../../lib/idempotency';
import { idParam, parse } from '../../lib/validate';
import { attachmentsOf, bindAttachments, registerAttachmentRef } from './attachments';
import { erpOpAbandoned } from '../erp-ops';
import { notify } from './notifications';
import { NOT_EMPLOYEE_ROLES } from './org';

/**
 * 只有在职员工能用即时通讯：平板（电子菜单）、他店等专用账号、系统账号、已离职的一律拒绝（Codex 安全审查 3a3892f）。
 * 登录检查之后再按库里的账号与员工档案核对一次（专用账号的会话不能靠直接调接口进来）
 */
const loggedIn = guard();
function employeeOnly(db: Db): preHandlerAsyncHookHandler {
  return async function (req, reply) {
    await loggedIn.call(this, req, reply);
    if ((NOT_EMPLOYEE_ROLES as readonly string[]).includes(req.actor.role) || !(await onDutyIds(db, [req.actor.id])).length) {
      throw forbidden('这个账号不能用即时通讯');
    }
  };
}
const REF = 'oa_im_message';
/** 不带 since 取新消息时一并给出最近几分钟里撤回的（撤回只能在发出后 2 分钟内） */
const REVOKED_WINDOW_MINUTES = IM_REVOKE_MINUTES + 3;
/** 按 since 取撤回时往前多看一点：撤回的事务早于 since 开始、晚于它提交的也不漏（重复给出不要紧） */
const REVOKED_OVERLAP_SECONDS = 60;
/** 建群限额（Codex 安全审查 accf8fb）：每人 10 分钟内最多建几个、一天最多建几个 */
const GROUP_QUOTA = { burst: 10, burstMinutes: 10, daily: 30 };

/** 在职员工（与审批转交选人同一个名单）；s = staff，p = staff_profiles */
const onDuty = (db: Db) => db`s.active AND NOT s.system AND s.role <> ALL(${NOT_EMPLOYEE_ROLES}) AND COALESCE(p.status, 'active') = 'active'`;

/** 我在不在这个会话里（没退出） */
async function memberOf(db: Db, conversationId: number, staffId: number): Promise<{ kind: 'direct' | 'group'; name: string | null } | null> {
  const [c] = await db<{ kind: 'direct' | 'group'; name: string | null }[]>`
    SELECT c.kind, c.name FROM oa_im_conversations c JOIN oa_im_members m ON m.conversation_id = c.id
    WHERE c.id = ${conversationId} AND m.staff_id = ${staffId} AND m.left_at IS NULL`;
  return c ?? null;
}

// 聊天文件：只有这个会话现在的成员、而且现在还能用即时通讯（在职员工，不是专用账号）才看得到；撤回了的不再给
registerAttachmentRef(REF, async (db, actor, refId) => {
  if ((NOT_EMPLOYEE_ROLES as readonly string[]).includes(actor.role)) return false;
  const [ok] = await db`
    SELECT 1 FROM oa_im_messages msg
    JOIN oa_im_members m ON m.conversation_id = msg.conversation_id AND m.staff_id = ${actor.id} AND m.left_at IS NULL
    JOIN staff s ON s.id = m.staff_id LEFT JOIN staff_profiles p ON p.staff_id = s.id
    WHERE msg.id = ${refId} AND msg.revoked_at IS NULL AND ${onDuty(db)}`;
  return !!ok;
});

type MessageRow = {
  id: number;
  conversationId: number;
  senderId: number;
  senderName: string;
  kind: ImMessageKind;
  body: string;
  attachmentId: number | null;
  mentions: (number | string)[];
  mentionAll: boolean;
  createdAt: Date;
  revokedAt: Date | null;
};

async function loadMessages(db: Db, where: Fragment, order: Fragment, limit: number): Promise<ImMessage[]> {
  const rows = await db<MessageRow[]>`
    SELECT msg.id, msg.conversation_id, msg.sender_id, s.display_name AS sender_name, msg.kind, msg.body, msg.attachment_id,
           msg.mentions, msg.mention_all, msg.created_at, msg.revoked_at
    FROM oa_im_messages msg JOIN staff s ON s.id = msg.sender_id
    WHERE ${where} ORDER BY ${order} LIMIT ${limit}`;
  const withFile = rows.filter((r) => r.attachmentId !== null && !r.revokedAt).map((r) => Number(r.id));
  const files = withFile.length ? await attachmentsOf(db, { type: REF, id: withFile }) : [];
  return rows.map((r) => {
    const revoked = !!r.revokedAt;
    return {
      id: Number(r.id),
      conversationId: Number(r.conversationId),
      senderId: Number(r.senderId),
      senderName: r.senderName,
      kind: r.kind,
      body: revoked ? '' : r.body,
      attachment: revoked || r.attachmentId === null ? null : (files.find((f) => f.id === Number(r.attachmentId)) ?? null),
      mentions: r.mentions.map(Number),
      mentionAll: r.mentionAll,
      createdAt: new Date(r.createdAt).toISOString(),
      revoked,
    };
  });
}

type ListRow = {
  id: number;
  kind: 'direct' | 'group';
  name: string | null;
  lastMessageAt: Date;
  memberCount: number;
  peerId: number | null;
  peerName: string | null;
  lmKind: ImMessageKind | null;
  lmBody: string | null;
  lmRevoked: boolean | null;
  lmSender: string | null;
  lmFile: string | null;
  unread: number;
  mentioned: boolean;
};

async function listConversations(db: Db, me: number, q: string | undefined): Promise<ImConversationList> {
  const like = q ? `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;
  const rows = await db<ListRow[]>`
    SELECT c.id, c.kind, c.name, c.last_message_at,
           (SELECT count(*) FROM oa_im_members x WHERE x.conversation_id = c.id AND x.left_at IS NULL)::int AS member_count,
           peer.staff_id AS peer_id, ps.display_name AS peer_name,
           lm.kind AS lm_kind, lm.body AS lm_body, lm.revoked_at IS NOT NULL AS lm_revoked, ls.display_name AS lm_sender, la.file_name AS lm_file,
           (SELECT count(*) FROM oa_im_messages u
            WHERE u.conversation_id = c.id AND u.id > m.last_read_message_id AND u.sender_id <> ${me} AND u.kind <> 'system')::int AS unread,
           EXISTS (SELECT 1 FROM oa_im_messages u
                   WHERE u.conversation_id = c.id AND u.id > m.last_read_message_id AND u.sender_id <> ${me} AND u.revoked_at IS NULL
                     AND (u.mention_all OR ${me}::bigint = ANY(u.mentions))) AS mentioned
    FROM oa_im_members m
    JOIN oa_im_conversations c ON c.id = m.conversation_id
    LEFT JOIN LATERAL (SELECT staff_id FROM oa_im_members WHERE conversation_id = c.id AND staff_id <> ${me} ORDER BY staff_id LIMIT 1) peer ON c.kind = 'direct'
    LEFT JOIN staff ps ON ps.id = peer.staff_id
    LEFT JOIN oa_im_messages lm ON lm.id = c.last_message_id
    LEFT JOIN staff ls ON ls.id = lm.sender_id
    LEFT JOIN oa_attachments la ON la.id = lm.attachment_id
    WHERE m.staff_id = ${me} AND m.left_at IS NULL
      ${
        like
          ? db`AND (c.name ILIKE ${like} OR ps.display_name ILIKE ${like}
                    OR EXISTS (SELECT 1 FROM oa_im_members x JOIN staff xs ON xs.id = x.staff_id
                               WHERE x.conversation_id = c.id AND x.left_at IS NULL AND xs.display_name ILIKE ${like})
                    OR EXISTS (SELECT 1 FROM oa_im_messages t
                               WHERE t.conversation_id = c.id AND t.kind = 'text' AND t.revoked_at IS NULL AND t.body ILIKE ${like}))`
          : db``
      }
    ORDER BY c.last_message_at DESC, c.id DESC
    LIMIT 200`;
  const items = rows.map(
    (r): ImConversationItem => ({
      id: Number(r.id),
      kind: r.kind,
      title: r.kind === 'group' ? (r.name ?? '') : (r.peerName ?? ''),
      peerId: r.peerId === null ? null : Number(r.peerId),
      memberCount: r.memberCount,
      preview: r.lmKind ? imPreview({ kind: r.lmKind, body: r.lmBody ?? '', revoked: !!r.lmRevoked, senderName: r.lmSender ?? '', fileName: r.lmFile }) : '',
      lastMessageAt: new Date(r.lastMessageAt).toISOString(),
      unread: r.unread,
      mentioned: r.mentioned,
    }),
  );
  // 未读合计按全部会话算（列表只给最近 200 个，不能拿它加，Codex 审查 15f56d2）
  const [total] = await db<{ unread: number }[]>`
    SELECT count(*)::int AS unread FROM oa_im_members m
    JOIN oa_im_messages u ON u.conversation_id = m.conversation_id AND u.id > m.last_read_message_id AND u.sender_id <> ${me} AND u.kind <> 'system'
    WHERE m.staff_id = ${me} AND m.left_at IS NULL`;
  return { items, unread: total!.unread };
}

async function detailOf(db: Db, id: number, me: number): Promise<ImConversationDetail> {
  const c = await memberOf(db, id, me);
  if (!c) throw notFound('会话不存在');
  const members = await db<{ staffId: number; name: string; role: ImRole; lastRead: number }[]>`
    SELECT m.staff_id, s.display_name AS name, m.role, m.last_read_message_id AS last_read FROM oa_im_members m JOIN staff s ON s.id = m.staff_id
    WHERE m.conversation_id = ${id} AND m.left_at IS NULL
    ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, m.joined_at, m.staff_id`;
  const peer = members.find((m) => Number(m.staffId) !== me);
  return {
    id,
    kind: c.kind,
    title: c.kind === 'group' ? (c.name ?? '') : (peer?.name ?? ''),
    members: members.map((m) => ({ staffId: Number(m.staffId), name: m.name, role: m.role })),
    lastReadMessageId: Number(members.find((m) => Number(m.staffId) === me)?.lastRead ?? 0),
  };
}

/** 一位在职员工（单聊对象、群成员） */
async function onDutyIds(db: Db, ids: readonly number[]): Promise<number[]> {
  if (!ids.length) return [];
  const rows = await db<{ id: number }[]>`SELECT s.id FROM staff s LEFT JOIN staff_profiles p ON p.staff_id = s.id WHERE s.id IN ${db([...ids])} AND ${onDuty(db)}`;
  return rows.map((r) => Number(r.id));
}

const ListQuery = z.object({ q: z.string().trim().max(30).optional() });
const DirectInput = z.object({ staffId: z.number().int().positive() });
const GroupInput = z.object({
  clientKey: z.string().uuid(),
  name: z.string().trim().min(1, '请填写群名').max(IM_GROUP_NAME_MAX, `群名最多 ${IM_GROUP_NAME_MAX} 个字`),
  memberIds: z.array(z.number().int().positive()).max(IM_GROUP_MAX),
});
const SendInput = z.object({
  clientKey: z.string().uuid(),
  kind: z.enum(['text', 'image', 'file']),
  body: z.string().max(IM_TEXT_MAX, `一条消息最多 ${IM_TEXT_MAX} 个字`).default(''),
  attachmentId: z.number().int().positive().nullable().default(null),
  mentions: z.array(z.number().int().positive()).max(IM_GROUP_MAX).default([]),
  mentionAll: z.boolean().default(false),
});
const BeforeQuery = z.object({ before: z.coerce.number().int().positive().optional() });
const AfterQuery = z.object({ after: z.coerce.number().int().min(0), since: z.string().datetime({ offset: true }).optional() });
const ReadInput = z.object({ upTo: z.number().int().min(0) });

/** 发一条消息（调用方的事务里，已锁会话行、核对过是成员）；返回编号 */
async function insertMessage(
  tx: Tx,
  conversationId: number,
  senderId: number,
  m: { kind: ImMessageKind; body: string; attachmentId?: number | null; mentions?: number[]; mentionAll?: boolean; clientKey?: string | null; hash?: string | null },
): Promise<number> {
  const [row] = await tx<{ id: number }[]>`
    INSERT INTO oa_im_messages (conversation_id, sender_id, kind, body, attachment_id, mentions, mention_all, client_key, request_hash)
    VALUES (${conversationId}, ${senderId}, ${m.kind}, ${m.body}, ${m.attachmentId ?? null}, ${m.mentions ?? []}::bigint[], ${m.mentionAll ?? false},
            ${m.clientKey ?? null}, ${m.hash ?? null})
    RETURNING id`;
  const id = Number(row!.id);
  await tx`UPDATE oa_im_conversations SET last_message_id = ${id}, last_message_at = now() WHERE id = ${conversationId}`;
  // 自己发的算自己已读
  await tx`UPDATE oa_im_members SET last_read_message_id = GREATEST(last_read_message_id, ${id}) WHERE conversation_id = ${conversationId} AND staff_id = ${senderId}`;
  return id;
}

async function send(tx: Tx, actor: Actor, conversationId: number, input: z.infer<typeof SendInput>): Promise<{ id: number; replayed: boolean }> {
  const { clientKey, ...rest } = input;
  const hash = hashRequest({ conversationId, ...rest });
  // 会话行锁：同一会话的消息串行（最后一条、编号顺序不乱）
  const [c] = await tx<{ kind: 'direct' | 'group'; name: string | null }[]>`SELECT kind, name FROM oa_im_conversations WHERE id = ${conversationId} FOR UPDATE`;
  const [mine] = await tx`SELECT 1 FROM oa_im_members WHERE conversation_id = ${conversationId} AND staff_id = ${actor.id} AND left_at IS NULL`;
  if (!c || !mine) throw notFound('会话不存在或你已经不在这个群里');
  const [seen] = await tx<{ id: number; requestHash: string | null }[]>`
    SELECT id, request_hash FROM oa_im_messages WHERE sender_id = ${actor.id} AND client_key = ${clientKey}`;
  if (seen) {
    if (seen.requestHash !== hash) throw conflict('IDEMPOTENCY_CONFLICT', '该操作编号已用于另一条消息，请刷新后重新发送');
    return { id: Number(seen.id), replayed: true };
  }
  const body = input.kind === 'text' ? input.body.trim() : input.body.trim().slice(0, 200);
  if (input.kind === 'text' && !body) throw unprocessable('MESSAGE_EMPTY', '消息不能是空的');
  if (input.kind !== 'text') {
    if (!input.attachmentId) throw unprocessable('ATTACHMENT_INVALID', '请先选图片或文件');
    const [a] = await tx<{ mime: string }[]>`SELECT mime FROM oa_attachments WHERE id = ${input.attachmentId}`;
    if (input.kind === 'image' && !a?.mime.startsWith('image/')) throw unprocessable('ATTACHMENT_INVALID', '发图片要选一张图片');
  }
  // @：只在群聊里；只认现在的群成员（自己除外）
  let mentions: number[] = [];
  if (c.kind === 'group' && input.mentions.length) {
    const rows = await tx<{ staffId: number }[]>`
      SELECT staff_id FROM oa_im_members WHERE conversation_id = ${conversationId} AND left_at IS NULL AND staff_id IN ${tx([...new Set(input.mentions)])} AND staff_id <> ${actor.id}`;
    mentions = rows.map((r) => Number(r.staffId)).sort((a, b) => a - b);
  }
  const mentionAll = c.kind === 'group' && input.mentionAll;
  const id = await insertMessage(tx, conversationId, actor.id, {
    kind: input.kind,
    body,
    attachmentId: input.kind === 'text' ? null : input.attachmentId,
    mentions,
    mentionAll,
    clientKey,
    hash,
  });
  if (input.kind !== 'text') await bindAttachments(tx, [input.attachmentId!], actor, { type: REF, id });
  // 被 @ 的人：站内通知（强提醒）；同一个会话没读的只留一条
  const targets = mentionAll
    ? (await tx<{ staffId: number }[]>`SELECT staff_id FROM oa_im_members WHERE conversation_id = ${conversationId} AND left_at IS NULL AND staff_id <> ${actor.id}`).map((r) => Number(r.staffId))
    : mentions;
  if (targets.length) {
    await notify(tx, targets, {
      kind: 'im_message',
      title: `${actor.displayName}在「${c.name ?? ''}」里@了${mentionAll ? '所有人' : '你'}`,
      body: input.kind === 'text' ? body.slice(0, 60) : '',
      link: `/oa/im/${conversationId}`,
      // 关联到这一条消息：上报已读时只清读到的位置之前的 @ 通知（Codex 审查 accf8fb）
      ref: { type: 'oa_im_message', id },
    });
  }
  return { id, replayed: false };
}

export function registerOaImRoutes(app: FastifyInstance, { sql }: Deps) {
  const auth = employeeOnly(sql);
  const one = async (id: number) => (await loadMessages(sql, sql`msg.id = ${id}`, sql`msg.id`, 1))[0]!;

  app.get('/api/oa/im/conversations', { preHandler: auth }, async (req): Promise<ImConversationList> => {
    const q = parse(ListQuery, req.query ?? {});
    return listConversations(sql, req.actor.id, q.q || undefined);
  });

  // 发起单聊：同两个人只有一个，已经有了就打开原来那个（重复点不要紧）
  app.post('/api/oa/im/direct', { preHandler: auth }, async (req): Promise<{ id: number }> => {
    const { staffId } = parse(DirectInput, req.body);
    const me = req.actor.id;
    if (staffId === me) throw unprocessable('IM_SELF', '不能和自己单聊');
    if (!(await onDutyIds(sql, [staffId])).length) throw notFound('这位同事不存在或已经离职');
    const key = `${Math.min(me, staffId)}:${Math.max(me, staffId)}`;
    const id = await sql.begin(async (tx) => {
      const [made] = await tx<{ id: number }[]>`
        INSERT INTO oa_im_conversations (kind, direct_key, created_by) VALUES ('direct', ${key}, ${me}) ON CONFLICT (direct_key) DO NOTHING RETURNING id`;
      const convId = made ? Number(made.id) : Number((await tx<{ id: number }[]>`SELECT id FROM oa_im_conversations WHERE direct_key = ${key}`)[0]!.id);
      await tx`INSERT INTO oa_im_members (conversation_id, staff_id) VALUES (${convId}, ${me}), (${convId}, ${staffId}) ON CONFLICT DO NOTHING`;
      return convId;
    });
    return { id };
  });

  // 建群：带操作编号（oa_im_group，结果不确定时查回、原样重提或确认作废）；建群的人是群主
  app.post('/api/oa/im/groups', { preHandler: auth }, async (req, reply): Promise<{ id: number; replayed: boolean }> => {
    const input = parse(GroupInput, req.body);
    const me = req.actor.id;
    const { clientKey, ...rest } = input;
    const hash = hashRequest({ ...rest, memberIds: [...new Set(rest.memberIds)].sort((a, b) => a - b), staffId: me });
    const out = await sql.begin(async (tx): Promise<{ id: number; replayed: boolean }> => {
      await lockOpKey(tx, clientKey);
      const [seen] = await tx<{ opType: string; requestHash: string; refId: number; staffId: number }[]>`
        SELECT op_type, request_hash, ref_id, staff_id FROM idempotency_keys WHERE key = ${clientKey}`;
      if (seen) {
        if (seen.opType !== 'oa_im_group' || seen.requestHash !== hash || Number(seen.staffId) !== me) {
          throw conflict('IDEMPOTENCY_CONFLICT', '该操作编号已用于另一次操作，请刷新页面后重新建群');
        }
        return { id: Number(seen.refId), replayed: true };
      }
      await assertNotFenced(tx, clientKey, 'oa_im_group', erpOpAbandoned);
      // 限额：一个人不能在短时间里拉一大堆群把别人的会话列表刷掉（Codex 安全审查 accf8fb）；按人串行核对
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`oa_im_group_quota:${me}`}, 0))`;
      const [made] = await tx<{ burst: number; daily: number }[]>`
        SELECT count(*) FILTER (WHERE created_at > now() - make_interval(mins => ${GROUP_QUOTA.burstMinutes}))::int AS burst,
               count(*) FILTER (WHERE created_at > now() - interval '1 day')::int AS daily
        FROM oa_im_conversations WHERE created_by = ${me} AND kind = 'group' AND created_at > now() - interval '1 day'`;
      if (made!.burst >= GROUP_QUOTA.burst || made!.daily >= GROUP_QUOTA.daily) {
        throw unprocessable('GROUP_QUOTA', `建群太频繁：每人 ${GROUP_QUOTA.burstMinutes} 分钟内最多建 ${GROUP_QUOTA.burst} 个、一天最多 ${GROUP_QUOTA.daily} 个，请稍后再建`);
      }
      const wanted = [...new Set(input.memberIds.filter((x) => x !== me))];
      const others = await onDutyIds(tx, wanted);
      if (others.length !== wanted.length) throw unprocessable('MEMBER_INVALID', '有成员不存在或已经离职，请刷新后重选');
      if (others.length + 1 < IM_GROUP_MIN) throw unprocessable('GROUP_TOO_SMALL', `群聊连自己至少 ${IM_GROUP_MIN} 人；两个人请直接单聊`);
      if (others.length + 1 > IM_GROUP_MAX) throw unprocessable('GROUP_TOO_LARGE', `一个群最多 ${IM_GROUP_MAX} 人`);
      const [c] = await tx<{ id: number }[]>`INSERT INTO oa_im_conversations (kind, name, created_by) VALUES ('group', ${input.name}, ${me}) RETURNING id`;
      const convId = Number(c!.id);
      await tx`
        INSERT INTO oa_im_members (conversation_id, staff_id, role)
        SELECT ${convId}, x, CASE WHEN x = ${me} THEN 'owner' ELSE 'member' END FROM unnest(${[me, ...others]}::bigint[]) AS t(x)`;
      await insertMessage(tx, convId, me, { kind: 'system', body: `${req.actor.displayName}创建了群聊「${input.name}」` });
      await tx`INSERT INTO idempotency_keys (key, op_type, request_hash, ref_id, staff_id) VALUES (${clientKey}, 'oa_im_group', ${hash}, ${convId}, ${me})`;
      return { id: convId, replayed: false };
    });
    reply.code(out.replayed ? 200 : 201);
    return out;
  });

  app.get('/api/oa/im/conversations/:id', { preHandler: auth }, async (req): Promise<ImConversationDetail> => detailOf(sql, parse(idParam, req.params).id, req.actor.id));

  // 历史：before 之前的 30 条（不带 before 是最近的 30 条），按编号从小到大
  app.get('/api/oa/im/conversations/:id/messages', { preHandler: auth }, async (req): Promise<ImMessagePage> => {
    const { id } = parse(idParam, req.params);
    const q = parse(BeforeQuery, req.query ?? {});
    if (!(await memberOf(sql, id, req.actor.id))) throw notFound('会话不存在');
    const rows = await loadMessages(sql, sql`msg.conversation_id = ${id} ${q.before ? sql`AND msg.id < ${q.before}` : sql``}`, sql`msg.id DESC`, IM_PAGE + 1);
    const now = (await sql<{ now: Date }[]>`SELECT now()`)[0]!.now;
    return { messages: rows.slice(0, IM_PAGE).reverse(), hasMore: rows.length > IM_PAGE, syncedAt: new Date(now).toISOString() };
  });

  // 取新消息（页面每 3 秒一次）：after 之后的，与最近几分钟撤回的
  app.get('/api/oa/im/conversations/:id/poll', { preHandler: auth }, async (req): Promise<ImPollResult> => {
    const { id } = parse(idParam, req.params);
    const { after, since } = parse(AfterQuery, req.query ?? {});
    if (!(await memberOf(sql, id, req.actor.id))) throw notFound('会话不存在');
    const now = (await sql<{ now: Date }[]>`SELECT now()`)[0]!.now;
    const messages = await loadMessages(sql, sql`msg.conversation_id = ${id} AND msg.id > ${after}`, sql`msg.id`, 200);
    // 撤回按「上次同步到什么时候」续传：页面在后台、断网好几分钟回来也补得上（Codex 审查 accf8fb）
    const revoked = await sql<{ id: number }[]>`
      SELECT id FROM oa_im_messages WHERE conversation_id = ${id} AND revoked_at IS NOT NULL AND id <= ${after}
        AND revoked_at > ${since ? sql`${since}::timestamptz - make_interval(secs => ${REVOKED_OVERLAP_SECONDS})` : sql`now() - make_interval(mins => ${REVOKED_WINDOW_MINUTES})`}`;
    return { messages, revoked: revoked.map((r) => Number(r.id)), syncedAt: new Date(now).toISOString() };
  });

  app.post('/api/oa/im/conversations/:id/messages', { preHandler: auth }, async (req, reply): Promise<ImSent> => {
    const { id } = parse(idParam, req.params);
    const input = parse(SendInput, req.body);
    let out: { id: number; replayed: boolean };
    try {
      out = await sql.begin((tx) => send(tx, req.actor, id, input));
    } catch (error) {
      // 同一个编号同时发到了两个会话（另一个先插进去了）
      if (isUniqueViolation(error, 'oa_im_messages_sender_id_client_key_key')) throw conflict('IDEMPOTENCY_CONFLICT', '该操作编号已用于另一条消息，请刷新后重新发送');
      throw error;
    }
    reply.code(out.replayed ? 200 : 201);
    return { message: await one(out.id), replayed: out.replayed };
  });

  // 撤回：发的人、2 分钟内；已经撤回的照常成功（重复点不要紧）
  app.post('/api/oa/im/messages/:id/revoke', { preHandler: auth }, async (req): Promise<ImMessage> => {
    const { id } = parse(idParam, req.params);
    await sql.begin(async (tx) => {
      const [m] = await tx<{ senderId: number; kind: ImMessageKind; revoked: boolean; late: boolean; conversationId: number }[]>`
        SELECT sender_id, kind, revoked_at IS NOT NULL AS revoked, created_at < now() - make_interval(mins => ${IM_REVOKE_MINUTES}) AS late, conversation_id
        FROM oa_im_messages WHERE id = ${id} FOR UPDATE`;
      if (!m || !(await memberOf(tx, Number(m.conversationId), req.actor.id))) throw notFound('消息不存在');
      if (Number(m.senderId) !== req.actor.id || m.kind === 'system') throw forbidden('只能撤回自己发的消息');
      if (m.revoked) return;
      if (m.late) throw unprocessable('REVOKE_TOO_LATE', `发出超过 ${IM_REVOKE_MINUTES} 分钟的消息不能撤回`);
      await tx`UPDATE oa_im_messages SET revoked_at = now() WHERE id = ${id}`;
      // @ 通知里抄了正文的前几十个字：一并换成撤回提示（已读、未读的都改，Codex 审查 71a6762）
      await tx`
        UPDATE oa_notifications SET body = ${`${req.actor.displayName}撤回了这条消息`}
        WHERE kind = 'im_message' AND ref_type = 'oa_im_message' AND ref_id = ${id}`;
    });
    return one(id);
  });

  // 退出群聊（群主除外：群主要先转让，OA-16）；退出以后看不到这个群，别人看到「某某退出了群聊」。已经退出的照常成功
  app.post('/api/oa/im/conversations/:id/leave', { preHandler: auth }, async (req): Promise<{ ok: true }> => {
    const { id } = parse(idParam, req.params);
    await sql.begin(async (tx) => {
      const [c] = await tx<{ kind: 'direct' | 'group' }[]>`SELECT kind FROM oa_im_conversations WHERE id = ${id} FOR UPDATE`;
      const [m] = await tx<{ role: ImRole; leftAt: Date | null }[]>`SELECT role, left_at FROM oa_im_members WHERE conversation_id = ${id} AND staff_id = ${req.actor.id}`;
      if (!c || !m) throw notFound('会话不存在');
      if (m.leftAt) return;
      if (c.kind !== 'group') throw unprocessable('IM_LEAVE_DIRECT', '单聊不能退出');
      if (m.role === 'owner') throw unprocessable('IM_OWNER_LEAVE', '群主不能直接退出：请先把群主转给别人');
      await tx`UPDATE oa_im_members SET left_at = now() WHERE conversation_id = ${id} AND staff_id = ${req.actor.id}`;
      await insertMessage(tx, id, req.actor.id, { kind: 'system', body: `${req.actor.displayName}退出了群聊` });
    });
    return { ok: true };
  });

  // 上报读到哪一条（只往前走，不超过这个会话最新的一条）；看过的 @ 通知一并记已读
  app.post('/api/oa/im/conversations/:id/read', { preHandler: auth }, async (req): Promise<{ lastReadMessageId: number }> => {
    const { id } = parse(idParam, req.params);
    const { upTo } = parse(ReadInput, req.body);
    const [m] = await sql<{ lastRead: number }[]>`
      UPDATE oa_im_members SET last_read_message_id = GREATEST(last_read_message_id,
               LEAST(${upTo}, COALESCE((SELECT max(id) FROM oa_im_messages WHERE conversation_id = ${id}), 0)))
      WHERE conversation_id = ${id} AND staff_id = ${req.actor.id} AND left_at IS NULL
      RETURNING last_read_message_id AS last_read`;
    if (!m) throw notFound('会话不存在');
    // 只清读到的位置之前的 @ 通知：那之后刚到、还没看到的照旧提醒（Codex 审查 accf8fb）
    await sql`
      UPDATE oa_notifications n SET read_at = now()
      FROM oa_im_messages msg
      WHERE n.staff_id = ${req.actor.id} AND n.kind = 'im_message' AND n.ref_type = 'oa_im_message' AND n.read_at IS NULL
        AND msg.id = n.ref_id AND msg.conversation_id = ${id} AND msg.id <= ${Number(m.lastRead)}`;
    return { lastReadMessageId: Number(m.lastRead) };
  });
}
