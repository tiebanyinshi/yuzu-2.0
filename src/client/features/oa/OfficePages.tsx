// OA 员工端（docs/OA.md 第 1、8 节）：「办公」首页与「我的排班」。OA-14 起首页多「消息」（ImPages.tsx，角标是未读合计）。登录就能用，只看本人的。
// 入口在账号菜单「办公」（主导航那一列在小屏电脑上已经放不下新的一组；只用 ERP 的后勤也不因此多出门店主导航）。
//   · 办公首页：常用的几样（打卡、我的排班、通知；审批等随后面的 PR 加进来），手机上一行两个。
//   · 打卡：PunchPage.tsx（OA-06）。
//   · 我的排班：月历，每天的班次与休息；跨天班写「至次日 06:00」，第二天 00:00 上班的在前一天写「今晚 24:00 上班」。

import { useState } from 'react';
import { Link, useLocation } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { Bell, CalendarCheck, CalendarDays, ChevronLeft, ChevronRight, Fingerprint, MessagesSquare, Palmtree, ScanFace, Stamp } from 'lucide-react';
import { shiftDate } from '@shared/labels';
import type { MySchedule, MyScheduleItem } from '@shared/oa';
import type { ApprovalSummary } from '@shared/oa-approval';
import { IM_LIST_POLL_MS, type ImSync } from '@shared/oa-im';
import { clockText } from '@shared/technician-admin';
import { api } from '../../lib/api';
import { useLivePoll } from '../../lib/livePoll';
import { cn } from '../../lib/utils';
import { PageHeader } from '../../components/AppShell';
import { LoadFailed } from '../../components/LoadFailed';
import { Button, Card, Skeleton } from '../../components/ui';
import { ApprovalPages } from './ApprovalPages';
import { ImPages } from './ImPages';
import { NotificationsPage } from './Notifications';
import { FacePage } from './FacePage';
import { MyAttendancePage } from './MyAttendancePage';
import { MyLeavePage } from './MyLeavePage';
import { PunchPage } from './PunchPage';

const TILES = [
  { to: '/oa/im', label: '消息', hint: '同事单聊、群聊，发图片与文件', icon: MessagesSquare, testId: 'oa-tile-im' },
  { to: '/oa/approvals', label: '审批', hint: '请假、加班、出差、报销、补卡', icon: Stamp, testId: 'oa-tile-approvals' },
  { to: '/oa/punch', label: '打卡', hint: '按排班打上下班卡、外勤打卡', icon: Fingerprint, testId: 'oa-tile-punch' },
  { to: '/oa/schedule', label: '我的排班', hint: '这个月每天上什么班', icon: CalendarDays, testId: 'oa-tile-schedule' },
  { to: '/oa/attendance', label: '我的考勤', hint: '每天的考勤结果、迟到缺卡', icon: CalendarCheck, testId: 'oa-tile-attendance' },
  { to: '/oa/leave', label: '假期余额', hint: '年假等还剩几天、发放与扣减明细', icon: Palmtree, testId: 'oa-tile-leave' },
  { to: '/oa/face', label: '人脸录入', hint: '打卡要人脸的先录入、等审核', icon: ScanFace, testId: 'oa-tile-face' },
  { to: '/oa/notifications', label: '通知', hint: '排班变更、审批、工资条等提醒', icon: Bell, testId: 'oa-tile-notifications' },
];

/** /oa 下面的几页放在一个按需加载的文件里（首屏主包有体积上限，路由表里只占一行） */
export function OfficePage() {
  const { pathname } = useLocation();
  const path = pathname.replace(/\/$/, '');
  return path.startsWith('/oa/approvals') ? (
    <ApprovalPages />
  ) : path.startsWith('/oa/im') ? (
    <ImPages />
  ) : path === '/oa/schedule' ? (
    <MySchedulePage />
  ) : path === '/oa/notifications' ? (
    <NotificationsPage />
  ) : path === '/oa/punch' ? (
    <PunchPage />
  ) : path === '/oa/face' ? (
    <FacePage />
  ) : path === '/oa/attendance' ? (
    <MyAttendancePage />
  ) : path === '/oa/leave' ? (
    <MyLeavePage />
  ) : (
    <OfficeHomePage />
  );
}

function OfficeHomePage() {
  // 审批的角标：待我审批的张数
  const approvals = useQuery({ queryKey: ['oa', 'approvals', 'summary'], queryFn: () => api.get<ApprovalSummary>('/api/oa/approvals/summary') });
  const todo = approvals.data?.todo ?? 0;
  // 消息的角标：所有会话的未读合计
  // OA-15：首页只问统一的同步接口（未读合计），不取整份会话列表
  const im = useQuery({ queryKey: ['oa', 'im', 'sync'], queryFn: () => api.get<ImSync>('/api/oa/im/sync') });
  // 停在首页时也按会话列表的节奏刷新（Codex 审查 ce07d7e）
  useLivePoll(async () => void (await im.refetch()), [], { intervalMs: IM_LIST_POLL_MS });
  const unread = im.data?.unread ?? 0;
  return (
    <>
      <PageHeader dateMode="calendar" title="办公" subtitle="排班、打卡、审批、工资条等员工自己的事" />
      <div className="mx-auto grid w-full max-w-3xl grid-cols-2 gap-3 p-4 md:grid-cols-3 md:p-7" data-testid="oa-home">
        {TILES.map((t) => (
          <Link key={t.to} to={t.to} data-testid={t.testId} className="tap relative rounded-lg border border-line bg-card p-4 shadow-card transition-colors hover:border-line-strong">
            <t.icon className="size-6 text-pine" />
            {t.to === '/oa/im' && unread > 0 && (
              <span className="num absolute top-3 right-3 rounded-full bg-clay px-2 text-[12px] font-bold text-white" data-testid="oa-tile-im-badge">
                {unread > 99 ? '99+' : unread}
              </span>
            )}
            {t.to === '/oa/approvals' && todo > 0 && (
              <span className="num absolute top-3 right-3 rounded-full bg-clay px-2 text-[12px] font-bold text-white" data-testid="oa-tile-approvals-badge">
                {todo}
              </span>
            )}
            <p className="mt-3 text-[15px] font-bold text-ink">{t.label}</p>
            <p className="mt-0.5 text-[12.5px] text-ink-3">{t.hint}</p>
          </Link>
        ))}
      </div>
    </>
  );
}

const WEEK = ['一', '二', '三', '四', '五', '六', '日'];

function addMonths(month: string, n: number): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return d.toISOString().slice(0, 7);
}

const itemText = (i: MyScheduleItem) => `${clockText(i.startMinute)}–${i.endMinute <= i.startMinute ? '次日 ' : ''}${clockText(i.endMinute)}`;

function MySchedulePage() {
  const [month, setMonth] = useState<string | null>(null);
  const q = useQuery({ queryKey: ['oa', 'my-schedule', month], queryFn: () => api.get<MySchedule>(`/api/oa/me/schedule${month ? `?month=${month}` : ''}`) });
  const data = q.data;
  const current = month ?? data?.month ?? null;
  return (
    <>
      <PageHeader dateMode="calendar" title="我的排班" subtitle="没排班的日子是休息；跨天班的打卡都算在上班那一天" />
      <div className="mx-auto w-full max-w-4xl p-4 md:p-7">
        {q.isPending ? (
          <Skeleton className="h-96" />
        ) : q.isError && !data ? (
          <LoadFailed title="排班没有取回来" onRetry={() => q.refetch()} retrying={q.isFetching} />
        ) : (
          <Card className="p-3 md:p-5" data-testid="my-schedule">
            <div className="mb-3 flex items-center justify-between gap-2">
              <Button size="sm" variant="ghost" icon={<ChevronLeft className="size-4" />} onClick={() => current && setMonth(addMonths(current, -1))} aria-label="上个月" />
              <p className="num text-[16px] font-bold text-ink" data-testid="my-schedule-month">
                {data!.month.replace('-', ' 年 ')} 月
              </p>
              <Button
                size="sm"
                variant="ghost"
                icon={<ChevronRight className="size-4" />}
                onClick={() => current && setMonth(addMonths(current, 1))}
                aria-label="下个月"
                data-testid="my-schedule-next"
              />
            </div>
            <MonthGrid data={data!} />
          </Card>
        )}
      </div>
    </>
  );
}

function MonthGrid({ data }: { data: MySchedule }) {
  const first = data.days[0]!.date;
  const [y, m, d] = first.split('-').map(Number) as [number, number, number];
  const lead = (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
  // 下个月 1 号的也算上：00:00 上班的在这个月最后一天写「今晚 24:00 上班」
  const byDate = new Map([...data.days, data.following].map((x) => [x.date, x.items]));
  return (
    <div className="grid grid-cols-7 gap-1 text-[12px]">
      {WEEK.map((w) => (
        <div key={w} className="py-1 text-center font-semibold text-ink-3">
          {w}
        </div>
      ))}
      {Array.from({ length: lead }, (_, i) => (
        <div key={`pad-${i}`} />
      ))}
      {data.days.map((day) => {
        // 第二天 00:00 上班的班次：今晚就要去，前一天写上
        const tonight = (byDate.get(shiftDate(day.date, 1)) ?? []).filter((i) => i.startMinute === 0);
        return (
          <div
            key={day.date}
            data-testid={`my-day-${day.date}`}
            className={cn(
              'min-h-14 min-w-0 rounded-md border px-1 py-1 sm:min-h-20 sm:px-1.5',
              day.date === data.today ? 'border-pine bg-pine-tint' : 'border-line',
              day.date < data.today && 'opacity-60',
            )}
          >
            <p className="num font-semibold text-ink-2">{Number(day.date.slice(8))}</p>
            {day.items.length === 0 && tonight.length === 0 && (
              <p className="text-ink-4">
                休<span className="max-sm:hidden">息</span>
              </p>
            )}
            {day.items.map((i) => (
              <p key={i.shiftId} className="mt-0.5 leading-tight">
                <span className="block truncate font-bold text-ink">{i.name}</span>
                <span className="num block text-[12px] text-ink-3">{itemText(i)}</span>
              </p>
            ))}
            {tonight.map((i) => (
              <p key={`t-${i.shiftId}`} className="mt-0.5 text-[12px] leading-tight font-semibold text-ember">
                今晚 24:00 上班（{i.name}）
              </p>
            ))}
          </div>
        );
      })}
    </div>
  );
}
