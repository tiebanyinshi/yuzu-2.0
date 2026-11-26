// OA-03 站内通知（docs/OA.md 第 6 节）：铃铛（未读数，30 秒取一次）与「通知」页。
// 门户页改造（店主 2026-11-24，docs/PORTAL.md）：铃铛在门户页顶栏右侧，点开是通知面板（最近的通知，点一条标已读并跳过去）。
// 通知由各模块在服务端发（排班变更、打卡异常、审批……）；这里只看、标已读、点开跳到对应页面。
// 铃铛与页面放在一个文件里：两处按需加载共用一份代码（首屏主包有体积上限）。

import { useState } from 'react';
import { MenuPanel, useDismissable, type MenuPlacement } from '../../components/UserMenu';
import { Link, useNavigate } from 'react-router';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bell, CheckCheck } from 'lucide-react';
import { NOTIFICATION_KIND_LABELS, type NotificationPage, type OaNotification } from '@shared/oa';
import { api, errorMessage } from '../../lib/api';
import { cn } from '../../lib/utils';
import { PageHeader } from '../../components/AppShell';
import { EmptyState } from '../../components/EmptyState';
import { LoadFailed } from '../../components/LoadFailed';
import { useToast } from '../../components/Toast';
import { Badge, Button, Card, Segmented, Skeleton } from '../../components/ui';
import { fetchNotificationUnread, MessagesTabBar, NOTIFICATION_UNREAD_KEY, useNotificationUnreadPoll } from './MessagesBar';

/** 铃铛：未读数（没有就不显示数字）。侧栏里（rail）点一下进「通知」页；门户页顶栏（bar）点开通知面板 */
export function NotificationBell({ placement = 'rail', poll = true }: { placement?: MenuPlacement; poll?: boolean }) {
  const [open, setOpen] = useState(false);
  const ref = useDismissable(open, setOpen);
  const { unread: shown } = useNotificationUnreadPoll(poll);
  const label = shown ? `通知，${shown} 条未读` : '通知';
  const count = shown > 0 && (
    <span className="absolute -top-1 -right-1 flex min-w-5 items-center justify-center rounded-full bg-clay px-1 text-[12px] leading-5 font-bold text-paper" data-testid="notification-unread">
      {shown > 99 ? '99+' : shown}
    </span>
  );
  if (placement === 'rail') {
    return (
      <Link
        to="/oa/notifications"
        aria-label={label}
        title="通知"
        data-testid="notification-bell"
        className="tap relative flex size-9 shrink-0 items-center justify-center rounded-[12px] text-paper/60 transition-colors hover:bg-white/6 hover:text-paper"
      >
        <Bell className="size-[18px]" />
        {count}
      </Link>
    );
  }
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        title="通知"
        data-testid="notification-bell"
        className="tap relative flex size-9 shrink-0 items-center justify-center rounded-full text-ink-2 transition-colors hover:bg-paper-2 hover:text-ink"
      >
        <Bell className="size-[18px]" />
        {count}
      </button>
      {/* 窄屏：面板贴着屏幕两边（铃铛右边还有标识、换店、头像，按铃铛右对齐会伸出屏幕左边，Codex 审查 023cc78） */}
      {open && (
        <MenuPanel placement="bar" width="w-[22rem]" className="max-sm:fixed max-sm:top-[4.5rem] max-sm:right-4 max-sm:left-4 max-sm:w-auto">
          <NotificationPanel onClose={() => setOpen(false)} />
        </MenuPanel>
      )}
    </div>
  );
}

async function syncNotificationUnread(qc: ReturnType<typeof useQueryClient>, body: { ids: number[] } | { all: true }) {
  const r = await api.post<{ unread: number }>('/api/oa/notifications/read', body);
  if ('all' in body || r.unread === 0) {
    qc.setQueryData(NOTIFICATION_UNREAD_KEY, { unread: 0, systemUnread: 0 });
  } else {
    try {
      qc.setQueryData(NOTIFICATION_UNREAD_KEY, await fetchNotificationUnread());
    } catch {
      // 拉细分失败时至少保留最新总未读数
      qc.setQueryData(NOTIFICATION_UNREAD_KEY, (old: { unread: number; systemUnread: number } | undefined) => ({
        unread: r.unread,
        systemUnread: Math.min(old?.systemUnread ?? r.unread, r.unread),
      }));
    }
  }
  await qc.invalidateQueries({ queryKey: ['oa', 'notifications'] });
}

/** 通知面板：最近的通知（未读的标出来），点一条标已读并跳到对应页面；全部标为已读；看全部进「通知」页 */
function NotificationPanel({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const q = useQuery({ queryKey: ['oa', 'notifications', 'panel'], queryFn: () => api.get<NotificationPage>('/api/oa/notifications?status=all') });
  const items = (q.data?.items ?? []).slice(0, 8);
  const unread = q.data?.unread ?? 0;
  const markRead = (body: { ids: number[] } | { all: true }) => syncNotificationUnread(qc, body);
  const openOne = async (n: OaNotification) => {
    try {
      if (!n.readAt) await markRead({ ids: [n.id] });
    } catch (e) {
      toast({ tone: 'error', title: errorMessage(e) });
    }
    if (n.link) {
      onClose();
      navigate(n.link);
    }
  };
  return (
    <div data-testid="notification-panel">
      <div className="flex items-center gap-2 px-3 pt-2 pb-2">
        <p className="flex-1 text-[14px] font-bold">通知{unread ? <span className="ml-1.5 text-[12.5px] font-semibold text-clay">{unread} 条未读</span> : null}</p>
        <button
          type="button"
          disabled={!unread}
          onClick={() => void markRead({ all: true }).catch((e: unknown) => toast({ tone: 'error', title: errorMessage(e) }))}
          className="tap relative flex h-8 items-center gap-1 rounded-md px-2 text-[12.5px] font-semibold text-pine hover:bg-paper-2 disabled:text-ink-4 disabled:hover:bg-transparent"
          data-testid="notification-panel-read-all"
        >
          <CheckCheck className="size-4" />
          全部已读
        </button>
      </div>
      <div className="h-px bg-line" />
      <div className="scroll-thin max-h-[min(24rem,60vh)] overflow-y-auto py-1">
        {q.isPending ? (
          <Skeleton className="m-2 h-24" />
        ) : q.isError && !q.data ? (
          <LoadFailed title="通知没有取回来" onRetry={() => void q.refetch()} retrying={q.isFetching} className="m-2" testId="notification-panel-failed" />
        ) : items.length === 0 ? (
          <p className="px-3 py-6 text-center text-[13px] text-ink-3" data-testid="notification-panel-empty">
            还没有通知
          </p>
        ) : (
          items.map((n) => (
            <button
              key={n.id}
              type="button"
              role="menuitem"
              onClick={() => void openOne(n)}
              className={cn('flex w-full items-start gap-2.5 rounded-md px-3 py-2 text-left transition-colors hover:bg-paper-2', !n.readAt && 'bg-yuzu-soft/40')}
              data-testid={`notification-panel-${n.id}`}
            >
              <span className={cn('mt-1.5 size-2 shrink-0 rounded-full', n.readAt ? 'bg-transparent' : 'bg-clay')} aria-hidden />
              <span className="min-w-0 flex-1">
                <span className={cn('block truncate text-[13.5px] text-ink', !n.readAt && 'font-semibold')}>{n.title}</span>
                <span className="mt-0.5 block text-[12px] text-ink-3">
                  {NOTIFICATION_KIND_LABELS[n.kind]} · {new Date(n.createdAt).toLocaleString('zh-CN', { hour12: false })}
                </span>
              </span>
            </button>
          ))
        )}
      </div>
      <div className="h-px bg-line" />
      <Link
        to="/oa/notifications"
        onClick={onClose}
        className="tap relative flex h-10 items-center justify-center rounded-md text-[13px] font-semibold text-ink-2 hover:bg-paper-2 hover:text-ink"
        data-testid="notification-panel-all"
      >
        查看全部通知
      </Link>
    </div>
  );
}

type Status = 'unread' | 'all';

/** 「通知」页：未读 / 全部，点一条标已读并跳过去，全部标为已读；与「聊天」共用消息分栏 */
export function NotificationsPage() {
  useNotificationUnreadPoll(false);
  const [status, setStatus] = useState<Status>('unread');
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const q = useInfiniteQuery({
    queryKey: ['oa', 'notifications', status],
    queryFn: ({ pageParam }) => api.get<NotificationPage>(`/api/oa/notifications?status=${status}${pageParam ? `&before=${pageParam}` : ''}`),
    initialPageParam: 0,
    getNextPageParam: (last) => last.nextBefore ?? undefined,
  });
  const items = q.data?.pages.flatMap((p) => p.items) ?? [];
  const unread = q.data?.pages[0]?.unread ?? 0;
  const markRead = (body: { ids: number[] } | { all: true }) => syncNotificationUnread(qc, body);
  const open = async (n: OaNotification) => {
    try {
      if (!n.readAt) await markRead({ ids: [n.id] });
    } catch (e) {
      toast({ tone: 'error', title: errorMessage(e) });
    }
    if (n.link) navigate(n.link);
  };
  const readAll = async () => {
    try {
      await markRead({ all: true });
    } catch (e) {
      toast({ tone: 'error', title: errorMessage(e) });
    }
  };
  return (
    <>
      <div className="max-md:hidden">
        <PageHeader dateMode="calendar" title="通知" subtitle="排班变更、打卡异常、审批待办与结果、工资条等提醒" />
      </div>
      <div className="mx-auto w-full max-w-3xl space-y-3 p-3 md:space-y-4 md:p-7">
        <h1 className="text-[17px] font-bold text-ink md:hidden">通知</h1>
        <MessagesTabBar active="notifications" />
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Segmented<Status>
            value={status}
            onChange={setStatus}
            ariaLabel="通知范围"
            options={[
              { value: 'unread', label: unread ? `未读 ${unread}` : '未读' },
              { value: 'all', label: '全部' },
            ]}
          />
          <Button variant="secondary" size="sm" icon={<CheckCheck className="size-4" />} disabled={!unread} onClick={() => void readAll()} data-testid="notifications-read-all">
            全部标为已读
          </Button>
        </div>
        {q.isPending ? (
          <Skeleton className="h-40" />
        ) : q.isError && !q.data ? (
          <LoadFailed title="通知没有取回来" onRetry={() => q.refetch()} retrying={q.isFetching} />
        ) : items.length === 0 ? (
          <EmptyState art="calm" testId="notifications-empty" title={status === 'unread' ? '没有未读的通知' : '还没有通知'} />
        ) : (
          <Card className="divide-y divide-line p-0" data-testid="notifications-list">
            {items.map((n) => (
              <button
                key={n.id}
                type="button"
                onClick={() => void open(n)}
                className={cn('tap relative flex w-full items-start gap-3 px-3.5 py-3 text-left transition-colors hover:bg-paper md:px-4', !n.readAt && 'bg-yuzu-soft/40')}
                data-testid={`notification-${n.id}`}
              >
                <span className={cn('mt-1.5 size-2 shrink-0 rounded-full', n.readAt ? 'bg-transparent' : 'bg-clay')} aria-hidden />
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-2">
                    <Badge tone="neutral">{NOTIFICATION_KIND_LABELS[n.kind]}</Badge>
                    <span className={cn('break-words text-[14px] text-ink', !n.readAt && 'font-semibold')}>{n.title}</span>
                  </span>
                  {n.body && <span className="mt-0.5 block break-words text-[13px] text-ink-2">{n.body}</span>}
                  <span className="mt-0.5 block text-[12px] text-ink-3">{new Date(n.createdAt).toLocaleString('zh-CN', { hour12: false })}</span>
                </span>
              </button>
            ))}
          </Card>
        )}
        {q.hasNextPage && (
          <Button variant="ghost" loading={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()} data-testid="notifications-more">
            更早的通知
          </Button>
        )}
      </div>
    </>
  );
}
