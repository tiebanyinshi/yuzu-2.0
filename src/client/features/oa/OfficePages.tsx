// OA 员工端（docs/OA.md 第 1、8 节）：「办公」首页与「我的排班」。OA-14 起首页多「消息」（ImPages.tsx，角标是未读合计），OA-16 起多「通讯录」（DirectoryPage.tsx）。登录就能用，只看本人的。
// 入口在账号菜单「办公」（主导航那一列在小屏电脑上已经放不下新的一组；只用 ERP 的后勤也不因此多出门店主导航）。
//   · 工作台（员工办公 v1.1 第 1 批，docs/OA_MOBILE.md）：顶上「今天」打卡卡片，下面功能宫格（手机一行四个小图标），顶栏搜索按名字筛。
//   · 打卡：PunchPage.tsx（OA-06）。
//   · 我的排班：月历，每天的班次与休息；跨天班写「至次日 06:00」，第二天 00:00 上班的在前一天写「今晚 24:00 上班」。

import { useState } from 'react';
import { Link, useLocation, useSearchParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, FilePenLine, Fingerprint } from 'lucide-react';
import type { MySchedule, PunchToday } from '@shared/oa';
import type { ApprovalSummary } from '@shared/oa-approval';
import { IM_LIST_POLL_MS, type ImSync } from '@shared/oa-im';
import { api } from '../../lib/api';
import { useLivePoll } from '../../lib/livePoll';
import { PageHeader } from '../../components/AppShell';
import { LoadFailed } from '../../components/LoadFailed';
import { Button, Card, Skeleton } from '../../components/ui';
import { ApprovalPages } from './ApprovalPages';
import { DirectoryPage } from './DirectoryPage';
import { ImPages } from './ImPages';
import { NotificationsPage } from './Notifications';
import { FacePage } from './FacePage';
import { MyAttendancePage } from './MyAttendancePage';
import { MyLeavePage } from './MyLeavePage';
import { MyPayslipPages } from './MyPayslipPages';
import { PunchPage } from './PunchPage';
import { MePage } from './MePage';
import { DayLegend, itemText, MonthGrid } from './MyScheduleCalendar';
import { useWcpNav, type WcpNavItem } from './wcpNav';
import { TrainingPages } from '../training/TrainingPages';

/** /oa 下面的几页放在一个按需加载的文件里（首屏主包有体积上限，路由表里只占一行） */
export function OfficePage() {
  const { pathname } = useLocation();
  const path = pathname.replace(/\/$/, '');
  return path.startsWith('/oa/approvals') ? (
    <ApprovalPages />
  ) : path.startsWith('/oa/im') ? (
    <ImPages />
  ) : path === '/oa/directory' ? (
    <DirectoryPage />
  ) : path === '/oa/me' ? (
    <MePage />
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
  ) : path.startsWith('/oa/payslips') ? (
    <MyPayslipPages />
  ) : path.startsWith('/oa/training') ? (
    <TrainingPages />
  ) : (
    <OfficeHomePage />
  );
}

/** 工作台宫格里多出来的：补卡直接进补卡审批（店主 2026-11-25 v1.1 第二节「工作台」） */
const MAKEUP_TILE: WcpNavItem = { to: '/oa/approvals/new/makeup', label: '补卡', hint: '忘打卡、缺卡的补一张，走审批', icon: FilePenLine, testId: 'oa-tile-makeup' };

/**
 * 工作台（WCP 首页）：顶上「今天」打卡卡片（今天的班次与上下班卡打了没有），下面是功能宫格。
 * 手机上宫格一行四个小图标（参考钉钉），电脑上照旧是带说明的方块；顶栏搜索框按名字筛宫格（?q=）。
 */
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
  // WCP 设置（店主 2026-11-24，docs/BOARDS.md 第 2 节）：有人员与行政任一分区的才显示，进第一个能进的
  const nav = useWcpNav();
  const [params] = useSearchParams();
  const q = (params.get('q') ?? '').trim();
  const all = [...nav.slice(0, 3), MAKEUP_TILE, ...nav.slice(3)];
  const tiles = q ? all.filter((t) => t.label.includes(q) || t.hint.includes(q)) : all;
  const badge = (t: WcpNavItem) => (t.to === '/oa/im' && unread > 0 ? (unread > 99 ? '99+' : String(unread)) : t.to === '/oa/approvals' && todo > 0 ? String(todo) : null);
  return (
    <>
      <div className="max-md:hidden">
        <PageHeader dateMode="calendar" title="WCP" subtitle="员工工作台：排班、打卡、审批、工资条等员工自己的事" />
      </div>
      <div className="mx-auto w-full max-w-3xl space-y-3 p-3 md:p-7" data-testid="oa-home">
        {!q && <TodayCard />}
        {q && (
          <p className="px-1 text-[13px] text-ink-3" data-testid="oa-home-search-result">
            「{q}」{tiles.length ? `找到 ${tiles.length} 项` : '没有找到对应的功能'}
          </p>
        )}
        <div className="grid grid-cols-4 gap-1 rounded-lg border border-line bg-card p-2 shadow-card md:grid-cols-3 md:gap-3 md:border-0 md:bg-transparent md:p-0 md:shadow-none">
          {tiles.map((t) => {
            const b = badge(t);
            return (
              <Link
                key={t.to}
                to={t.to}
                data-testid={t.testId}
                className="tap relative flex flex-col items-center rounded-lg px-1 py-2.5 text-center transition-colors md:items-start md:border md:border-line md:bg-card md:p-4 md:text-left md:shadow-card md:hover:border-line-strong"
              >
                <t.icon className="size-6 text-pine" />
                {b && (
                  <span className="num absolute top-1 right-1 rounded-full bg-clay px-1.5 text-[12px] font-bold text-white md:top-3 md:right-3 md:px-2" data-testid={`${t.testId}-badge`}>
                    {b}
                  </span>
                )}
                <p className="mt-1.5 text-[12.5px] font-semibold text-ink md:mt-3 md:text-[15px] md:font-bold">{t.label}</p>
                <p className="mt-0.5 hidden text-[12.5px] text-ink-3 md:block">{t.hint}</p>
              </Link>
            );
          })}
        </div>
      </div>
    </>
  );
}

const punchText = (p: { localTime: string } | null) => (p ? `已打 ${p.localTime}` : '未打');

/** 工作台顶上的「今天」打卡卡片：今天的班次、上下班卡打了没有；该打哪张卡由打卡页按班次窗口判定（第 2 批接上「该打什么卡」） */
function TodayCard() {
  const q = useQuery({ queryKey: ['oa', 'punch-today'], queryFn: () => api.get<PunchToday>('/api/oa/attendance/today') });
  const d = q.data;
  const today = d ? d.slots.filter((x) => x.date === d.today) : [];
  return (
    <Card className="p-4" data-testid="oa-today-card">
      <div className="flex items-center gap-3">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-pine-tint text-pine">
          <Fingerprint className="size-5" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[15px] font-bold text-ink">今天{d ? ` · ${d.today.slice(5).replace('-', ' 月 ')} 日` : ''}</p>
          <p className="truncate text-[12.5px] text-ink-3" data-testid="oa-today-group">
            {q.isPending ? '正在取今天的排班…' : q.isError ? '今天的排班没有取回来' : d!.group ? d!.group.name : '还没加入考勤组，打卡前请找人力行政部'}
          </p>
        </div>
        <Link to="/oa/punch" data-testid="oa-today-punch" className="tap relative inline-flex h-9 shrink-0 items-center rounded-full bg-pine px-4 text-[14px] font-semibold text-white">
          去打卡
        </Link>
      </div>
      {d && (
        <div className="mt-3 space-y-1.5" data-testid="oa-today-slots">
          {today.length === 0 ? (
            <p className="rounded-md bg-paper-2 px-3 py-2 text-[13px] text-ink-2">今天没有排班</p>
          ) : (
            today.map((s) => (
              <div key={s.shiftId} className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md bg-paper-2 px-3 py-2 text-[13px]">
                <span className="font-bold text-ink">{s.name}</span>
                <span className="num text-ink-3">{itemText(s)}</span>
                <span className="ml-auto flex gap-3">
                  <span className={s.in ? 'text-pine' : 'text-ink-3'}>上班 {punchText(s.in)}</span>
                  <span className={s.out ? 'text-pine' : 'text-ink-3'}>下班 {punchText(s.out)}</span>
                </span>
              </div>
            ))
          )}
        </div>
      )}
    </Card>
  );
}

function addMonths(month: string, n: number): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return d.toISOString().slice(0, 7);
}

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
            <DayLegend />
            <MonthGrid data={data!} />
          </Card>
        )}
      </div>
    </>
  );
}
