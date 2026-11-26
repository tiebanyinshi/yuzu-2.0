// OA-03 站内通知（docs/OA.md 第 6 节）：每位员工的通知列表、未读数、标已读。
// 各模块在自己的事务里调 notify() 发；同一人同一件事（类型 + 关联单据）没读的不重复发，只更新内容与时间。
// 外发通道（企业微信、短信）预留：notify() 写完库以后交给登记过的通道；现在没有登记任何通道（文档第十三节第 4 条）。

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { NotificationKind, NotificationPage, OaNotification } from '@shared/oa';
import type { Db, Fragment } from '../../db';
import { guard } from '../../auth/guard';
import type { Deps } from '../../lib/context';
import { parse } from '../../lib/validate';

export interface NotifyInput {
  kind: NotificationKind;
  title: string;
  body?: string;
  /** 点开去哪一页（站内路径，以 / 开头） */
  link?: string | null;
  /** 关联的单据：同一人同一件事没读的只留一条 */
  ref?: { type: string; id: number } | null;
}

/** 外发通道：写完站内信以后交给它（企业微信、短信以后接）。返回不等外发结果，失败不影响站内信 */
export type NotifyChannel = (staffIds: readonly number[], input: NotifyInput) => void;
const channels: NotifyChannel[] = [];
export function registerNotifyChannel(channel: NotifyChannel): void {
  channels.push(channel);
}

/** 给这几位员工发一条站内通知（在调用方的事务里写；外发通道在写完以后交出去） */
export async function notify(db: Db, staffIds: readonly number[], input: NotifyInput): Promise<void> {
  const ids = [...new Set(staffIds)];
  if (!ids.length) return;
  const title = input.title.slice(0, 100);
  const body = (input.body ?? '').slice(0, 500);
  const link = input.link ?? null;
  const refType = input.ref?.type ?? null;
  const refId = input.ref?.id ?? null;
  for (const staffId of ids) {
    if (refType) {
      await db`
        INSERT INTO oa_notifications (staff_id, kind, title, body, link, ref_type, ref_id)
        VALUES (${staffId}, ${input.kind}, ${title}, ${body}, ${link}, ${refType}, ${refId})
        ON CONFLICT (staff_id, kind, ref_type, ref_id) WHERE read_at IS NULL AND ref_type IS NOT NULL
        DO UPDATE SET title = EXCLUDED.title, body = EXCLUDED.body, link = EXCLUDED.link, refreshed_at = now()`;
    } else {
      await db`INSERT INTO oa_notifications (staff_id, kind, title, body, link) VALUES (${staffId}, ${input.kind}, ${title}, ${body}, ${link})`;
    }
  }
  for (const send of channels) {
    try {
      send(ids, input);
    } catch {
      /* 外发失败不影响站内信 */
    }
  }
}

const PAGE = 30;
const ListQuery = z.object({
  status: z.enum(['unread', 'all']).default('all'),
  before: z.coerce.number().int().positive().optional(),
});
const ReadInput = z.union([z.object({ ids: z.array(z.number().int().positive()).min(1).max(200) }), z.object({ all: z.literal(true) })]);

/**
 * 某一类通知现在还给不给这个人看（各模块登记）：例如即时通讯的 @ 通知，人已经不能用即时通讯（改成专用账号、离职）或退了群就不再给出
 * （OA-14 安全审查 93437a4）。条件里用 oa_notifications 的列（ref_type、ref_id）
 */
type VisibleFilter = (db: Db, staffId: number) => Fragment;
const visibleFilters = new Map<NotificationKind, VisibleFilter>();
export function registerNotificationVisibility(kind: NotificationKind, filter: VisibleFilter): void {
  visibleFilters.set(kind, filter);
}
function visible(db: Db, staffId: number): Fragment {
  let out = db`true`;
  for (const [kind, f] of visibleFilters) out = db`${out} AND (oa_notifications.kind <> ${kind} OR ${f(db, staffId)})`;
  return out;
}

const UnreadQuery = z.object({ breakdown: z.enum(['1', 'true']).optional() });

async function unreadCount(db: Db, staffId: number): Promise<number> {
  const [row] = await db<{ n: number }[]>`
    SELECT count(*)::int AS n FROM oa_notifications WHERE staff_id = ${staffId} AND read_at IS NULL AND ${visible(db, staffId)}`;
  return row?.n ?? 0;
}

async function unreadBreakdown(db: Db, staffId: number): Promise<{ unread: number; systemUnread: number }> {
  const [row] = await db<{ unread: number; systemUnread: number }[]>`
    SELECT count(*)::int AS unread,
           count(*) FILTER (WHERE kind <> 'im_message')::int AS system_unread
    FROM oa_notifications
    WHERE staff_id = ${staffId} AND read_at IS NULL AND ${visible(db, staffId)}`;
  return { unread: row?.unread ?? 0, systemUnread: row?.systemUnread ?? 0 };
}

export function registerOaNotificationRoutes(app: FastifyInstance, { sql }: Deps) {
  // 登录就能用：只看、只改自己的通知；?breakdown=1 时顺带给除 IM 以外的系统通知未读数（避免与聊天未读重复计数）
  app.get('/api/oa/notifications/unread-count', { preHandler: guard() }, async (req) => {
    const q = parse(UnreadQuery, req.query ?? {});
    return q.breakdown ? unreadBreakdown(sql, req.actor.id) : { unread: await unreadCount(sql, req.actor.id) };
  });

  app.get('/api/oa/notifications', { preHandler: guard() }, async (req): Promise<NotificationPage> => {
    const q = parse(ListQuery, req.query ?? {});
    const rows = await sql<(Omit<OaNotification, 'createdAt' | 'readAt'> & { createdAt: string | Date; readAt: string | Date | null })[]>`
      SELECT id, kind, title, body, link, refreshed_at AS created_at, read_at
      FROM oa_notifications
      WHERE staff_id = ${req.actor.id} AND ${visible(sql, req.actor.id)}
        ${q.status === 'unread' ? sql`AND read_at IS NULL` : sql``}
        ${q.before ? sql`AND id < ${q.before}` : sql``}
      ORDER BY id DESC LIMIT ${PAGE + 1}`;
    const items = rows.slice(0, PAGE).map((r) => ({
      ...r,
      id: Number(r.id),
      kind: r.kind as NotificationKind,
      createdAt: new Date(r.createdAt).toISOString(),
      readAt: r.readAt ? new Date(r.readAt).toISOString() : null,
    }));
    return { items, nextBefore: rows.length > PAGE ? items[items.length - 1]!.id : null, unread: await unreadCount(sql, req.actor.id) };
  });

  // 标已读：重复标不报错（已读的不再改时间）
  app.post('/api/oa/notifications/read', { preHandler: guard() }, async (req) => {
    const input = parse(ReadInput, req.body);
    if ('all' in input) await sql`UPDATE oa_notifications SET read_at = now() WHERE staff_id = ${req.actor.id} AND read_at IS NULL`;
    else await sql`UPDATE oa_notifications SET read_at = now() WHERE staff_id = ${req.actor.id} AND read_at IS NULL AND id IN ${sql(input.ids)}`;
    return { unread: await unreadCount(sql, req.actor.id) };
  });
}
