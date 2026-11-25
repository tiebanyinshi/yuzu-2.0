// 员工办公 v1.1 第 4 批（docs/OA_MOBILE.md 第五节）：
// 「消息」Tab 的共用未读计数（聊天未读 + 系统通知未读，系统通知排除 im_message 避免重复计数）
// 与「聊天 / 系统通知」顶部分栏切换条。

import { useRef } from 'react';
import { Link } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Bell, MessagesSquare } from 'lucide-react';
import { IM_LIST_POLL_MS, type ImSync } from '@shared/oa-im';
import { ApiError, api } from '../../lib/api';
import { useLivePoll } from '../../lib/livePoll';
import { cn } from '../../lib/utils';

export const NOTIFICATION_UNREAD_KEY = ['oa', 'notification-unread-count'] as const;
export const IM_SYNC_KEY = ['oa', 'im', 'sync'] as const;

export interface NotificationUnreadCounts {
  unread: number;
  systemUnread: number;
}

const ZERO_NOTIFICATIONS: NotificationUnreadCounts = { unread: 0, systemUnread: 0 };

export const fetchNotificationUnread = (): Promise<NotificationUnreadCounts> => api.get<NotificationUnreadCounts>('/api/oa/notifications/unread-count?breakdown=1');

/** 通知未读数轮询（30 秒一次，后台、断网不取；变动时同步刷新通知列表） */
export function useNotificationUnreadPoll(enabled = true): NotificationUnreadCounts {
  const qc = useQueryClient();
  const { data = ZERO_NOTIFICATIONS } = useQuery({
    queryKey: NOTIFICATION_UNREAD_KEY,
    queryFn: fetchNotificationUnread,
    enabled: false,
  });
  useLivePoll(
    async (isLive) => {
      if (!enabled) return;
      try {
        const next = await fetchNotificationUnread();
        if (!isLive()) return;
        const before = qc.getQueryData<NotificationUnreadCounts>(NOTIFICATION_UNREAD_KEY);
        qc.setQueryData(NOTIFICATION_UNREAD_KEY, next);
        if (before !== undefined && before.unread !== next.unread) {
          void qc.invalidateQueries({ queryKey: ['oa', 'notifications'] });
        }
      } catch {
        // 取不到就等下一次
      }
    },
    [qc, enabled],
    { intervalMs: 30_000 },
  );
  return data;
}

/** 只读缓存里的通知未读数（不重复开轮询） */
export function useNotificationUnread(): NotificationUnreadCounts {
  const { data = ZERO_NOTIFICATIONS } = useQuery({
    queryKey: NOTIFICATION_UNREAD_KEY,
    queryFn: fetchNotificationUnread,
    enabled: false,
  });
  return data;
}

/** 即时通讯未读数轮询（供 WCP 外壳统一维护；非员工账号遇 403 自动停止轮询） */
export function useImSyncPoll(): number {
  const qc = useQueryClient();
  const denied = useRef(false);
  const { data } = useQuery({
    queryKey: IM_SYNC_KEY,
    queryFn: () => api.get<ImSync>('/api/oa/im/sync'),
    enabled: false,
  });
  useLivePoll(
    async (isLive) => {
      if (denied.current) return;
      try {
        const next = await api.get<ImSync>('/api/oa/im/sync');
        if (!isLive()) return;
        qc.setQueryData(IM_SYNC_KEY, next);
      } catch (e) {
        if (e instanceof ApiError && e.status === 403) denied.current = true;
      }
    },
    [qc],
    { intervalMs: IM_LIST_POLL_MS },
  );
  return data?.unread ?? 0;
}

/** 只读缓存里的聊天未读数（不重复开轮询） */
export function useImUnread(): number {
  const { data } = useQuery({
    queryKey: IM_SYNC_KEY,
    queryFn: () => api.get<ImSync>('/api/oa/im/sync'),
    enabled: false,
  });
  return data?.unread ?? 0;
}

export const badgeText = (n: number): string => (n > 99 ? '99+' : String(n));

/** 「消息」Tab 顶部的「聊天 / 系统通知」分栏切换条 */
export function MessagesTabBar({ active }: { active: 'im' | 'notifications' }) {
  const imUnread = useImUnread();
  const { systemUnread } = useNotificationUnread();
  const items = [
    { key: 'im' as const, to: '/oa/im', label: '聊天', icon: MessagesSquare, count: imUnread },
    { key: 'notifications' as const, to: '/oa/notifications', label: '系统通知', icon: Bell, count: systemUnread },
  ];
  return (
    <nav aria-label="消息分栏" className="grid grid-cols-2 gap-1 rounded-lg border border-line bg-paper-2 p-1" data-testid="messages-tabbar">
      {items.map((it) => {
        const current = active === it.key;
        return (
          <Link
            key={it.key}
            to={it.to}
            aria-current={current ? 'page' : undefined}
            data-testid={`messages-tab-${it.key}`}
            className={cn(
              'tap relative flex h-9 items-center justify-center gap-1.5 rounded-md px-3 text-[13.5px] font-semibold transition-colors',
              current ? 'bg-card text-pine shadow-card' : 'text-ink-2 hover:text-ink',
            )}
          >
            <it.icon className="size-4 shrink-0" />
            <span>{it.label}</span>
            {it.count > 0 && (
              <span className="num inline-flex min-w-5 items-center justify-center rounded-full bg-clay px-1.5 text-[12px] leading-5 font-bold text-paper" data-testid={`messages-tab-${it.key}-badge`}>
                {badgeText(it.count)}
              </span>
            )}
          </Link>
        );
      })}
    </nav>
  );
}
