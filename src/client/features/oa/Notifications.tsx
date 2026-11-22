// OA-03 站内通知（docs/OA.md 第 6 节）：左侧导航下方的铃铛（未读数，30 秒取一次）与「通知」页。
// 通知由各模块在服务端发（排班变更、打卡异常、审批……）；这里只看、标已读、点开跳到对应页面。
// 铃铛与页面放在一个文件里：两处按需加载共用一份代码（首屏主包有体积上限）。

import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bell, CheckCheck } from 'lucide-react';
import { NOTIFICATION_KIND_LABELS, type NotificationPage, type OaNotification } from '@shared/oa';
import { api, errorMessage } from '../../lib/api';
import { useLivePoll } from '../../lib/livePoll';
import { cn } from '../../lib/utils';
import { PageHeader } from '../../components/AppShell';
import { EmptyState } from '../../components/EmptyState';
import { LoadFailed } from '../../components/LoadFailed';
import { useToast } from '../../components/Toast';
import { Badge, Button, Card, Segmented, Skeleton } from '../../components/ui';

const UNREAD_KEY = ['oa', 'notification-unread-count'] as const;
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
        if (!isLive()) return;
        // 未读数变了（来了新通知，或在别处读过）：「通知」页开着的话列表跟着刷新
        const before = qc.getQueryData<number>(UNREAD_KEY);
        qc.setQueryData(UNREAD_KEY, n);
        if (before !== undefined && before !== n) void qc.invalidateQueries({ queryKey: ['oa', 'notifications'] });
      } catch {
        // 取不到就等下一次
      }
    },
    [qc],
    { intervalMs: 30_000 },
  );
  return (
    <Link
      to="/oa/notifications"
      aria-label={shown ? `通知，${shown} 条未读` : '通知'}
      title="通知"
      data-testid="notification-bell"
      className="tap relative flex size-9 shrink-0 items-center justify-center rounded-[12px] text-paper/60 transition-colors hover:bg-white/6 hover:text-paper"
    >
      <Bell className="size-[18px]" />
      {shown > 0 && (
        <span className="absolute -top-1 -right-1 flex min-w-5 items-center justify-center rounded-full bg-clay px-1 text-[12px] leading-5 font-bold text-paper" data-testid="notification-unread">
          {shown > 99 ? '99+' : shown}
        </span>
      )}
    </Link>
  );
}

type Status = 'unread' | 'all';

/** 「通知」页：未读 / 全部，点一条标已读并跳过去，全部标为已读 */
export function NotificationsPage() {
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
  const markRead = async (body: { ids: number[] } | { all: true }) => {
    const r = await api.post<{ unread: number }>('/api/oa/notifications/read', body);
    qc.setQueryData(UNREAD_KEY, r.unread);
    await qc.invalidateQueries({ queryKey: ['oa', 'notifications'] });
  };
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
      <PageHeader
        dateMode="calendar"
        title="通知"
        subtitle="排班变更、打卡异常、审批待办与结果、工资条等提醒"
        actions={
          <Button variant="secondary" icon={<CheckCheck className="size-4" />} disabled={!unread} onClick={() => void readAll()} data-testid="notifications-read-all">
            全部标为已读
          </Button>
        }
      />
      <div className="mx-auto w-full max-w-3xl space-y-4 p-4 md:p-7">
        <Segmented<Status>
          value={status}
          onChange={setStatus}
          ariaLabel="通知范围"
          options={[
            { value: 'unread', label: unread ? `未读 ${unread}` : '未读' },
            { value: 'all', label: '全部' },
          ]}
        />
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
                className={cn('flex w-full items-start gap-3 px-4 py-3 text-left transition-colors hover:bg-paper', !n.readAt && 'bg-yuzu-soft/40')}
                data-testid={`notification-${n.id}`}
              >
                <span className={cn('mt-1.5 size-2 shrink-0 rounded-full', n.readAt ? 'bg-transparent' : 'bg-clay')} aria-hidden />
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-2">
                    <Badge tone="neutral">{NOTIFICATION_KIND_LABELS[n.kind]}</Badge>
                    <span className={cn('text-[14px] text-ink', !n.readAt && 'font-semibold')}>{n.title}</span>
                  </span>
                  {n.body && <span className="mt-0.5 block text-[13px] text-ink-2">{n.body}</span>}
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
