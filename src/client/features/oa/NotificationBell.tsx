// OA-03 站内通知（docs/OA.md 第 6 节）：左侧导航下方的铃铛，显示未读数（30 秒取一次）；点开是「通知」页（NotificationsPage.tsx）。

import { Link } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Bell } from 'lucide-react';
import { api } from '../../lib/api';
import { useLivePoll } from '../../lib/livePoll';

export const UNREAD_KEY = ['oa', 'notification-unread-count'] as const;
const fetchUnread = async () => (await api.get<{ unread: number }>('/api/oa/notifications/unread-count')).unread;

/** 左侧导航下方的铃铛：未读数（没有就不显示数字） */
export function NotificationBell() {
  const qc = useQueryClient();
  // 取数交给 useLivePoll（后台、断网不取）；显示读缓存，「通知」页标已读时直接改缓存，铃铛跟着变
  const { data: shown = 0 } = useQuery({ queryKey: UNREAD_KEY, queryFn: fetchUnread, enabled: false });
  useLivePoll(
    async (isLive) => {
      try {
        const n = await fetchUnread();
        if (isLive()) qc.setQueryData(UNREAD_KEY, n);
      } catch {
        // 取不到就等下一次
      }
    },
    [qc],
    { intervalMs: 30_000 },
  );
  return (
    <Link
      to="/notifications"
      aria-label={shown ? `通知，${shown} 条未读` : '通知'}
      title="通知"
      data-testid="notification-bell"
      className="tap relative mb-2 flex size-11 items-center justify-center rounded-full text-paper/70 transition-colors hover:bg-white/6 hover:text-paper short:size-9"
    >
      <Bell className="size-[19px]" />
      {shown > 0 && (
        <span className="absolute -top-0.5 -right-0.5 flex min-w-5 items-center justify-center rounded-full bg-clay px-1 text-[12px] leading-5 font-bold text-paper" data-testid="notification-unread">
          {shown > 99 ? '99+' : shown}
        </span>
      )}
    </Link>
  );
}
