// OA-14 即时通讯（docs/OA.md 第 17 节）：会话、消息的类型与上限，服务端与页面共用。

import type { OaAttachment } from './oa';

export const IM_TEXT_MAX = 2000;
export const IM_GROUP_NAME_MAX = 30;
/** 群成员上限（含群主，文档：MVP 500 人） */
export const IM_GROUP_MAX = 500;
/** 群聊连自己至少几个人 */
export const IM_GROUP_MIN = 3;
/** 撤回：发出后几分钟内 */
export const IM_REVOKE_MINUTES = 2;
/** 一次取几条历史 */
export const IM_PAGE = 30;
/** 会话打开时多久取一次新消息、会话列表多久刷新一次（文档：短轮询间隔不超过 5 秒） */
export const IM_POLL_MS = 3000;
export const IM_LIST_POLL_MS = 3000;

export type ImConversationKind = 'direct' | 'group';
export type ImMessageKind = 'text' | 'image' | 'file' | 'system';
export type ImRole = 'owner' | 'admin' | 'member';

export interface ImMember {
  staffId: number;
  name: string;
  role: ImRole;
}

/** 会话列表的一行 */
export interface ImConversationItem {
  id: number;
  kind: ImConversationKind;
  /** 群名；单聊是对方的名字 */
  title: string;
  /** 单聊的对方 */
  peerId: number | null;
  memberCount: number;
  /** 最后一条消息的摘要（撤回的写「某某撤回了一条消息」） */
  preview: string;
  lastMessageAt: string;
  unread: number;
  /** 读到的位置之后有人 @ 我（或 @所有人） */
  mentioned: boolean;
}
export interface ImConversationList {
  items: ImConversationItem[];
  /** 全部会话的未读合计（办公首页角标） */
  unread: number;
}

export interface ImMessage {
  id: number;
  conversationId: number;
  senderId: number;
  senderName: string;
  kind: ImMessageKind;
  /** 撤回的为空 */
  body: string;
  attachment: OaAttachment | null;
  mentions: number[];
  mentionAll: boolean;
  createdAt: string;
  revoked: boolean;
}

export interface ImConversationDetail {
  id: number;
  kind: ImConversationKind;
  title: string;
  members: ImMember[];
  /** 我读到哪一条 */
  lastReadMessageId: number;
}

/** 一页消息：按编号从小到大；hasMore = 往上还有更早的 */
export interface ImMessagePage {
  messages: ImMessage[];
  hasMore: boolean;
  /** 服务端这一刻的时间：下一次取新消息时带上（since），撤回从这里续传 */
  syncedAt: string;
  /** OA-15：其他成员各读到哪一条（算已读回执） */
  reads: ImRead[];
}
/** 取新消息：after 之后的新消息，与 since（上次同步的时间）以后撤回的 */
export interface ImPollResult {
  messages: ImMessage[];
  /** 已经取到的（after 及以前）里 since 以后撤回的 */
  revoked: number[];
  syncedAt: string;
  reads: ImRead[];
}
/** 一位成员读到哪一条 */
export interface ImRead {
  staffId: number;
  lastRead: number;
}
/** OA-15 统一的同步接口：未读合计、我所在的会话里最新一条消息的编号与最近一次撤回的时间（任一变了再取会话列表） */
export interface ImSync {
  unread: number;
  lastMessageId: number;
  /** 撤回不产生新消息，单看编号发现不了（Codex 审查 38e6250） */
  revokedAt: string | null;
}
/** 自己发的一条消息的已读情况：已读的成员与未读的成员（按读到的位置算） */
export function readersOf<M extends { staffId: number }>(messageId: number, members: readonly M[], reads: readonly ImRead[]): { read: M[]; unread: M[] } {
  const pos = new Map(reads.map((r) => [r.staffId, r.lastRead]));
  const others = members.filter((m) => pos.has(m.staffId));
  return { read: others.filter((m) => pos.get(m.staffId)! >= messageId), unread: others.filter((m) => pos.get(m.staffId)! < messageId) };
}

export interface ImSent {
  message: ImMessage;
  replayed: boolean;
}

/** 消息摘要（会话列表） */
export function imPreview(m: { kind: ImMessageKind; body: string; revoked: boolean; senderName: string; fileName?: string | null }): string {
  if (m.revoked) return `${m.senderName}撤回了一条消息`;
  if (m.kind === 'image') return '[图片]';
  if (m.kind === 'file') return `[文件] ${m.fileName ?? ''}`.trim();
  return m.body;
}
