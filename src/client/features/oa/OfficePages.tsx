// OA 员工端（docs/OA.md 第 1、8 节；docs/OA_MOBILE.md 第 1–2 批）：「办公」首页与「我的排班」及手机排班管理入口。
//   · 工作台：顶上「今天」打卡卡片（接 nextPunch「该打什么卡」、支持跨天/夜班提示），下面功能宫格（手机一行四个小图标），顶栏搜索按名字筛。
//   · 我的排班：月历，点选某天在下方展开完整班次、时间与状态；有排班权限的员工直接进「排班管理」（/oa/schedule/manage）。

import { useEffect, useState } from 'react';
import { Link, useLocation, useSearchParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarCog, ChevronLeft, ChevronRight, FilePenLine, Fingerprint } from 'lucide-react';
import { describeDate, shiftDate } from '@shared/labels';
import { dateOfEpochMinute, MY_DAY_STATUS_LABELS, nextPunchHint, type MySchedule, type PunchToday, type ScheduleAccessSummary } from '@shared/oa';
import type { ApprovalSummary } from '@shared/oa-approval';
import { IM_LIST_POLL_MS, type ImSync } from '@shared/oa-im';
import { can } from '@shared/permissions';
import { clockText } from '@shared/technician-admin';
import { api } from '../../lib/api';
import { useLivePoll } from '../../lib/livePoll';
import { useSession } from '../../lib/session';
import { PageHeader } from '../../components/AppShell';
import { ErpPendingPanel } from '../../components/ErpPendingPanel';
import { LoadFailed } from '../../components/LoadFailed';
import { Badge, Button, Card, Skeleton } from '../../components/ui';
import { ApprovalPages } from './ApprovalPages';
import { DirectoryPage } from './DirectoryPage';
import { ImPages } from './ImPages';
import { NotificationsPage } from './Notifications';
import { FacePage } from './FacePage';
import { MobileScheduleManagePage } from './MobileScheduleManagePage';
import { MyAttendancePage } from './MyAttendancePage';
import { MyLeavePage } from './MyLeavePage';
import { MyPayslipPages } from './MyPayslipPages';
import { PunchPage, useMinuteClock } from './PunchPage';
import { MePage } from './MePage';
import { DayLegend, itemText, LEAVE_PART_LABELS, MonthGrid } from './MyScheduleCalendar';
import { ScheduleGrantsTab } from './ScheduleGrantsTab';
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
  ) : path === '/oa/schedule/grants' ? (
    <MobileScheduleGrantsPage />
  ) : path === '/oa/schedule/manage' ? (
    <MobileScheduleManagePage />
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
/** 排班管理宫格：仅考勤管理员、部门经理与获授排班权限的人可见 */
const SCHEDULE_MANAGE_TILE: WcpNavItem = { to: '/oa/schedule/manage', label: '排班管理', hint: '按人按天编排草稿并发布排班', icon: CalendarCog, testId: 'oa-tile-schedule-manage' };

function OfficeHomePage() {
  const approvals = useQuery({ queryKey: ['oa', 'approvals', 'summary'], queryFn: () => api.get<ApprovalSummary>('/api/oa/approvals/summary') });
  const todo = approvals.data?.todo ?? 0;
  const im = useQuery({ queryKey: ['oa', 'im', 'sync'], queryFn: () => api.get<ImSync>('/api/oa/im/sync') });
  useLivePoll(async () => void (await im.refetch()), [], { intervalMs: IM_LIST_POLL_MS });
  const unread = im.data?.unread ?? 0;
  const access = useQuery({ queryKey: ['oa', 'schedule-access'], queryFn: () => api.get<ScheduleAccessSummary>('/api/oa/attendance/schedule-access') });
  const nav = useWcpNav();
  const [params] = useSearchParams();
  const q = (params.get('q') ?? '').trim();
  const extra = access.data?.canView ? [SCHEDULE_MANAGE_TILE] : [];
  const all = [...nav.slice(0, 3), MAKEUP_TILE, ...nav.slice(3, 5), ...extra, ...nav.slice(5)];
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

/** 工作台顶上的「今天」打卡卡片：今天的班次、上下班卡、下一张该打的卡（含跨天/次日 00:00 夜班） */
function TodayCard() {
  const q = useQuery({ queryKey: ['oa', 'punch-today'], queryFn: () => api.get<PunchToday>('/api/oa/attendance/today') });
  const d = q.data;
  const now = useMinuteClock(d?.now);
  const rolledOver = !!d && now !== undefined && dateOfEpochMinute(now) !== d.today;
  const refetchToday = q.refetch;
  useEffect(() => {
    if (rolledOver) void refetchToday();
  }, [rolledOver, refetchToday]);
  const next = d ? nextPunchHint(now ?? d.now, d.today, d.slots, d.group) : null;
  const visibleSlots = d ? d.slots.filter((x) => x.date === d.today || (next?.shiftId === x.shiftId && next?.businessDate === x.date)) : [];
  const btnLabel = next?.inWindow ? next.label : '去打卡';
  return (
    <Card className="p-4" data-testid="oa-today-card">
      <div className="flex items-center gap-3">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-pine-tint text-pine">
          <Fingerprint className="size-5" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[15px] font-bold text-ink">今天{d ? ` · ${d.today.slice(5).replace('-', ' 月 ')} 日` : ''}</p>
          <p className="truncate text-[12.5px] text-ink-3" data-testid="oa-today-group">
            {q.isPending ? '正在取今天的排班…' : !d ? '今天的排班' : d.group ? d.group.name : '还没加入考勤组，打卡前请找人力行政部'}
          </p>
        </div>
        <Link to="/oa/punch" data-testid="oa-today-punch" className="tap relative inline-flex h-9 shrink-0 items-center rounded-full bg-pine px-4 text-[14px] font-semibold text-white">
          {btnLabel}
        </Link>
      </div>
      {q.isError && !d && <LoadFailed className="mt-3" title="今天的排班没有取回来" onRetry={() => q.refetch()} retrying={q.isFetching} />}
      {next && (
        <div className="mt-3 flex flex-wrap items-center gap-2 rounded-md border border-line bg-paper px-3 py-2 text-[13px]" data-testid="oa-today-next" data-action={next.action}>
          <Badge tone={next.inWindow ? 'pine' : next.action === 'wait' ? 'lake' : next.action === 'no_group' ? 'ember' : 'ink'}>{next.label}</Badge>
          <span className="min-w-0 flex-1 text-ink-2">{next.detail}</span>
          {next.outworkAllowed && (next.action === 'in' || next.action === 'out') && <span className="text-[12px] text-ink-3">围栏外可外勤</span>}
        </div>
      )}
      {d && (
        <div className="mt-2.5 space-y-1.5" data-testid="oa-today-slots">
          {visibleSlots.length === 0 ? (
            <p className="rounded-md bg-paper-2 px-3 py-2 text-[13px] text-ink-2">今天没有已发布的排班</p>
          ) : (
            visibleSlots.map((s) => (
              <div key={`${s.date}-${s.shiftId}`} className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md bg-paper-2 px-3 py-2 text-[13px]">
                <span className="font-bold text-ink">
                  {s.date !== d.today ? `${s.date < d.today ? '昨日' : '次日'} · ` : ''}
                  {s.name}
                </span>
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
  const [pickedDate, setPickedDate] = useState<string | null>(null);
  const q = useQuery({ queryKey: ['oa', 'my-schedule', month], queryFn: () => api.get<MySchedule>(`/api/oa/me/schedule${month ? `?month=${month}` : ''}`) });
  const access = useQuery({ queryKey: ['oa', 'schedule-access'], queryFn: () => api.get<ScheduleAccessSummary>('/api/oa/attendance/schedule-access') });
  const data = q.data;
  const current = month ?? data?.month ?? null;
  const activeDate = data && pickedDate && data.days.some((d) => d.date === pickedDate) ? pickedDate : (data?.days.find((d) => d.date === data.today)?.date ?? data?.days[0]?.date ?? null);
  const activeDay = data && activeDate ? (data.days.find((d) => d.date === activeDate) ?? null) : null;
  const nextDayItems =
    data && activeDay
      ? ((data.days.find((d) => d.date === shiftDate(activeDay.date, 1)) ?? (data.following.date === shiftDate(activeDay.date, 1) ? data.following : null))?.items.filter((i) => i.startMinute === 0) ??
        [])
      : [];

  return (
    <>
      <div className="max-md:hidden">
        <PageHeader dateMode="calendar" title="我的排班" subtitle="仅展示已发布的排班；没排班的日子是休息，跨天班算在上班那天" />
      </div>
      <div className="mx-auto w-full max-w-4xl space-y-3 p-3 md:p-7">
        {q.isPending ? (
          <Skeleton className="h-96" />
        ) : q.isError && !data ? (
          <LoadFailed title="排班没有取回来" onRetry={() => q.refetch()} retrying={q.isFetching} />
        ) : (
          <>
            <Card className="p-3 md:p-5" data-testid="my-schedule">
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-1">
                  <Button size="sm" variant="ghost" icon={<ChevronLeft className="size-4" />} onClick={() => current && setMonth(addMonths(current, -1))} aria-label="上个月" />
                  <p className="num px-1 text-[16px] font-bold text-ink" data-testid="my-schedule-month">
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
                {access.data?.canView && (
                  <Link
                    to="/oa/schedule/manage"
                    data-testid="my-schedule-manage"
                    className="tap relative inline-flex h-8 items-center gap-1.5 rounded-md border border-pine/40 bg-pine-tint px-3 text-[13px] font-semibold text-pine"
                  >
                    <CalendarCog className="size-4" />
                    排班管理
                  </Link>
                )}
              </div>
              <DayLegend />
              <MonthGrid data={data!} selectedDate={activeDate} onSelectDate={setPickedDate} />
            </Card>
            {activeDay && (
              <Card className="space-y-2 p-4" data-testid="my-schedule-detail">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="num text-[15px] font-bold text-ink">
                    {activeDay.date}（{describeDate(activeDay.date).weekday}）
                  </p>
                  <Badge tone={activeDay.status === 'work' ? 'lake' : activeDay.status === 'leave' ? 'ember' : activeDay.status === 'absent' ? 'clay' : 'ink'}>
                    {activeDay.status === 'leave' ? LEAVE_PART_LABELS[activeDay.leavePart ?? 'full'] : MY_DAY_STATUS_LABELS[activeDay.status]}
                  </Badge>
                  {activeDay.date === data!.today && (
                    <Link to="/oa/punch" className="ml-auto text-[13px] font-semibold text-pine underline">
                      去打卡
                    </Link>
                  )}
                </div>
                {activeDay.items.length === 0 ? (
                  <p className="text-[13px] text-ink-3">这一天没有排班。</p>
                ) : (
                  <div className="space-y-1.5">
                    {activeDay.items.map((i) => (
                      <div key={i.shiftId} className="flex flex-wrap items-center gap-2 rounded-md bg-paper-2 px-3 py-2 text-[13px]">
                        <span className="font-bold text-ink">{i.name}</span>
                        <span className="num text-ink-2">{itemText(i)}</span>
                        {i.consecutive && <Badge tone="ember">连班</Badge>}
                      </div>
                    ))}
                  </div>
                )}
                {nextDayItems.map((i) => {
                  const openHint = i.inAdvanceMinutes > 0 ? `前一日 ${clockText(1440 - i.inAdvanceMinutes)} 起可打上班卡` : '次日 00:00 起可打上班卡';
                  return (
                    <p key={`next-${i.shiftId}`} className="text-[13px] font-semibold text-ember">
                      今晚 24:00 上班：{i.name}（{itemText(i)}，{openHint}）
                    </p>
                  );
                })}
              </Card>
            )}
          </>
        )}
      </div>
    </>
  );
}

/** WCP 内排班授权页（/oa/schedule/grants）：经 org_departments.head_staff_id 指定且无后台权限的部门经理也能直接管理排班授权 */
function MobileScheduleGrantsPage() {
  const qc = useQueryClient();
  const session = useSession();
  const isHr = can(session.staff, 'hr.attendance');
  const mine = (op: { staffId?: number }) => isHr || op.staffId === session.staff.id;
  return (
    <>
      <div className="max-md:hidden">
        <PageHeader dateMode="calendar" title="排班授权" subtitle="把本范围的查看、编排或发布排班权限授给主管或指定员工（不可转授，调岗自动失效）" />
      </div>
      <div className="mx-auto w-full max-w-5xl space-y-3 p-3 md:p-7" data-testid="oa-schedule-grants-page">
        <ErpPendingPanel
          types={['oa_schedule_grant']}
          filter={mine}
          className="space-y-2"
          onFound={() => {
            void qc.invalidateQueries({ queryKey: ['oa', 'schedule-grants'] });
            void qc.invalidateQueries({ queryKey: ['oa', 'schedule'] });
          }}
        />
        <ScheduleGrantsTab />
      </div>
    </>
  );
}
