// 员工办公 v1.1 第 5 批（docs/OA_MOBILE.md 第五节）：员工端「公告」列表与详情。
//   /oa/announcements        本店对本人可见的已发布公告（置顶优先，支持全部 / 未读筛选）
//   /oa/announcements/:id    公告详情（正文、附件；打开后自动记已读并刷新通知红点）

import { useEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronLeft, Megaphone, Paperclip, Pin } from 'lucide-react';
import type { OaAnnouncement, OaAnnouncementList } from '@shared/oa';
import { ORG_DEPARTMENTS, type OrgDepartment } from '@shared/positions';
import { api } from '../../lib/api';
import { cn, formatDateTime } from '../../lib/utils';
import { PageHeader } from '../../components/AppShell';
import { EmptyState } from '../../components/EmptyState';
import { LoadFailed } from '../../components/LoadFailed';
import { Badge, Card, Segmented, Skeleton } from '../../components/ui';
import { fetchNotificationUnread, NOTIFICATION_UNREAD_KEY } from './MessagesBar';

const DEPT_NAME = new Map<OrgDepartment, string>(ORG_DEPARTMENTS.map((d) => [d.key, d.name]));
const scopeLabel = (a: OaAnnouncement) => (a.scope === 'all' ? '全员' : a.targetDepts.map((k) => DEPT_NAME.get(k) ?? k).join('、'));

export function AnnouncementsPage() {
  const { pathname } = useLocation();
  const m = pathname.match(/^\/oa\/announcements\/(\d+)/);
  return m ? <AnnouncementDetailPage key={m[1]} id={Number(m[1])} /> : <AnnouncementListPage />;
}

type Filter = 'all' | 'unread';

function AnnouncementListPage() {
  const [filter, setFilter] = useState<Filter>('all');
  const q = useQuery({ queryKey: ['oa', 'announcements'], queryFn: () => api.get<OaAnnouncementList>('/api/oa/announcements') });
  const d = q.data;
  const shown = filter === 'unread' ? (d?.items.filter((x) => !x.readAt) ?? []) : (d?.items ?? []);

  return (
    <>
      <div className="max-md:hidden">
        <PageHeader dateMode="calendar" title="公司公告" subtitle="置顶公告排在最前；点开查看正文与附件后自动记已读" />
      </div>
      <div className="mx-auto w-full max-w-3xl space-y-3 p-3 md:p-7">
        <div className="flex items-center justify-between gap-2">
          <h1 className="text-[17px] font-bold text-ink md:hidden">公司公告</h1>
          <Segmented<Filter>
            size="sm"
            value={filter}
            onChange={setFilter}
            ariaLabel="公告筛选"
            options={[
              { value: 'all', label: <span data-testid="ann-tab-all">全部 {d ? d.items.length : ''}</span> },
              { value: 'unread', label: <span data-testid="ann-tab-unread">未读{d?.unreadCount ? ` ${d.unreadCount}` : ''}</span> },
            ]}
          />
        </div>
        {q.isPending ? (
          <Skeleton className="h-48" />
        ) : q.isError && !d ? (
          <LoadFailed title="公告没有取回来" onRetry={() => q.refetch()} retrying={q.isFetching} />
        ) : shown.length === 0 ? (
          <EmptyState art="calm" testId="ann-empty" title={filter === 'unread' ? '没有未读公告' : '还没有公司公告'} />
        ) : (
          <Card className="divide-y divide-line p-0" data-testid="ann-list">
            {shown.map((a) => (
              <Link
                key={a.id}
                to={`/oa/announcements/${a.id}`}
                data-testid={`ann-item-${a.id}`}
                className={cn('tap relative flex items-start gap-3 px-3.5 py-3 transition-colors hover:bg-paper md:px-4', !a.readAt && 'bg-yuzu-soft/40')}
              >
                <span className={cn('mt-2 size-2 shrink-0 rounded-full', a.readAt ? 'bg-transparent' : 'bg-clay')} aria-hidden />
                <span className="min-w-0 flex-1 space-y-1">
                  <span className="flex flex-wrap items-center gap-1.5">
                    {a.pinned && (
                      <Badge tone="clay">
                        <Pin className="mr-0.5 inline size-3" />
                        置顶
                      </Badge>
                    )}
                    <Badge tone={a.scope === 'all' ? 'pine' : 'lake'}>{scopeLabel(a)}</Badge>
                    <span className={cn('min-w-0 break-words text-[15px] text-ink', !a.readAt ? 'font-bold' : 'font-semibold')}>{a.title}</span>
                  </span>
                  <span className="line-clamp-2 block break-words text-[13px] text-ink-2">{a.body}</span>
                  <span className="flex flex-wrap items-center gap-2 text-[12px] text-ink-3">
                    <span>{a.publishedByName}</span>
                    <span className="num">{formatDateTime(a.publishedAt)}</span>
                    {a.attachments.length > 0 && (
                      <span className="inline-flex items-center gap-0.5">
                        <Paperclip className="size-3.5" />
                        {a.attachments.length} 个附件
                      </span>
                    )}
                    {a.readAt && <span className="ml-auto text-pine">已读</span>}
                  </span>
                </span>
              </Link>
            ))}
          </Card>
        )}
      </div>
    </>
  );
}

function AnnouncementDetailPage({ id }: { id: number }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['oa', 'announcement', id], queryFn: () => api.get<OaAnnouncement>(`/api/oa/announcements/${id}`) });
  const a = q.data;
  const marked = useRef(false);
  useEffect(() => {
    if (!a || a.readAt || marked.current) return;
    marked.current = true;
    void api
      .post<{ readAt: string }>(`/api/oa/announcements/${id}/read`, {})
      .then((res) => {
        qc.setQueryData<OaAnnouncement>(['oa', 'announcement', id], (old) => (old ? { ...old, readAt: res.readAt } : old));
        void qc.invalidateQueries({ queryKey: ['oa', 'announcements'] });
        void qc.invalidateQueries({ queryKey: ['oa', 'notifications'] });
        void fetchNotificationUnread()
          .then((counts) => qc.setQueryData(NOTIFICATION_UNREAD_KEY, counts))
          .catch(() => undefined);
      })
      .catch(() => {
        marked.current = false;
      });
  }, [a, id, qc]);

  return (
    <>
      <div className="max-md:hidden">
        <PageHeader dateMode="calendar" title={a?.title ?? '公司公告'} subtitle={a ? `${a.publishedByName} · ${formatDateTime(a.publishedAt)}` : undefined} />
      </div>
      <div className="mx-auto w-full max-w-3xl space-y-3 p-3 md:p-7">
        <Link to="/oa/announcements" className="tap relative inline-flex items-center gap-1 text-[14px] font-semibold text-pine" data-testid="ann-back">
          <ChevronLeft className="size-4" />
          公告列表
        </Link>
        {q.isPending ? (
          <Skeleton className="h-60" />
        ) : q.isError && !a ? (
          <LoadFailed title="公告没有取回来" onRetry={() => q.refetch()} retrying={q.isFetching} />
        ) : (
          <Card className="space-y-4 p-4 md:p-6" data-testid="ann-detail">
            <div className="space-y-2 border-b border-line pb-3">
              <div className="flex flex-wrap items-center gap-1.5">
                {a!.pinned && (
                  <Badge tone="clay">
                    <Pin className="mr-0.5 inline size-3" />
                    置顶
                  </Badge>
                )}
                <Badge tone={a!.scope === 'all' ? 'pine' : 'lake'}>{scopeLabel(a!)}</Badge>
                {a!.readAt && (
                  <span data-testid="ann-read-badge">
                    <Badge tone="pine">已读</Badge>
                  </span>
                )}
              </div>
              <h1 className="break-words text-[18px] leading-snug font-bold text-ink" data-testid="ann-detail-title">
                {a!.title}
              </h1>
              <p className="flex flex-wrap items-center gap-2 text-[12.5px] text-ink-3">
                <Megaphone className="size-3.5" />
                <span>{a!.publishedByName}</span>
                <span className="num">发布于 {formatDateTime(a!.publishedAt)}</span>
              </p>
            </div>
            <div className="break-words whitespace-pre-wrap text-[14px] leading-relaxed text-ink" data-testid="ann-detail-body">
              {a!.body}
            </div>
            {a!.attachments.length > 0 && (
              <div className="space-y-2 border-t border-line pt-3" data-testid="ann-detail-attachments">
                <p className="text-[13px] font-semibold text-ink-2">附件（{a!.attachments.length}）</p>
                <div className="flex flex-wrap gap-2">
                  {a!.attachments.map((att) => (
                    <a
                      key={att.id}
                      href={att.url}
                      target="_blank"
                      rel="noreferrer"
                      className="tap relative flex max-w-full items-center gap-1.5 rounded-md border border-line px-2.5 py-1.5 text-[13px] text-ink-2 hover:border-line-strong"
                    >
                      {att.thumbUrl ? <img src={att.thumbUrl} alt="" className="size-8 shrink-0 rounded object-cover" /> : <Paperclip className="size-4 shrink-0" />}
                      <span className="max-w-44 truncate">{att.fileName}</span>
                    </a>
                  ))}
                </div>
              </div>
            )}
          </Card>
        )}
      </div>
    </>
  );
}
