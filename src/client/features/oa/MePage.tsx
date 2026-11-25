// 「我的」（店主 2026-11-25《员工办公系统建设需求文档 v1.1》第二节，docs/OA_MOBILE.md）：手机底部第四个 Tab，电脑上在 WCP 左边一列。
// 头像、岗位与部门、假期余额、本月排班月历、人脸录入、设置（修改密码、外观、门户、退出登录）。
// 不加新接口：用现有的假期余额、我的排班、人脸录入状态三个接口（同一份数据，手机电脑一样）。

import type { ReactNode } from 'react';
import { Link, useNavigate } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronRight, KeyRound, LayoutGrid, LogOut, Palmtree, ScanFace } from 'lucide-react';
import { ROLE_LABELS } from '@shared/labels';
import type { FaceStatus, MyFace, MyLeave, MySchedule } from '@shared/oa';
import { ORG_DEPARTMENTS, positionLabel, positionOf } from '@shared/positions';
import { api } from '../../lib/api';
import { useSession } from '../../lib/session';
import { PageHeader } from '../../components/AppShell';
import { ThemeMenuRow } from '../../components/ThemeSwitch';
import { Card, Skeleton } from '../../components/ui';
import { DayLegend, MonthGrid } from './MyScheduleCalendar';

const FACE_TEXT: Record<FaceStatus, string> = { none: '还没录入', pending: '待审核', approved: '已通过', rejected: '被退回，请重新录入' };
const halvesText = (h: number) => `${h / 2} 天`;

export function MePage() {
  const session = useSession();
  const staff = session.staff;
  const dept = staff.position ? ORG_DEPARTMENTS.find((d) => d.key === positionOf(staff.position!).department)?.name : null;
  return (
    <>
      <div className="max-md:hidden">
        <PageHeader dateMode="calendar" title="我的" subtitle="假期余额、本月排班、人脸录入与账号设置" />
      </div>
      <div className="mx-auto w-full max-w-3xl space-y-3 p-3 md:p-7" data-testid="oa-me">
        <Card className="flex items-center gap-4 p-4" data-testid="oa-me-profile">
          <span className="flex size-14 shrink-0 items-center justify-center rounded-full bg-yuzu text-[22px] font-bold text-on-bright">{staff.displayName.slice(0, 1)}</span>
          <div className="min-w-0">
            <p className="truncate text-[18px] font-bold text-ink">{staff.displayName}</p>
            <p className="truncate text-[13px] text-ink-2">{[dept, positionLabel(staff.position) || ROLE_LABELS[staff.role]].filter(Boolean).join(' · ')}</p>
            <p className="num truncate text-[12px] text-ink-3">账号 {staff.username}</p>
          </div>
        </Card>
        <LeaveCard />
        <ScheduleCard />
        <FaceRow />
        <SettingsCard />
      </div>
    </>
  );
}

function SectionTitle({ title, to, testId }: { title: string; to: string; testId: string }) {
  return (
    <div className="mb-2 flex items-center">
      <h2 className="mr-auto text-[15px] font-bold text-ink">{title}</h2>
      <Link to={to} data-testid={testId} className="flex items-center text-[13px] font-semibold text-pine">
        详情
        <ChevronRight className="size-4" />
      </Link>
    </div>
  );
}

function LeaveCard() {
  const q = useQuery({ queryKey: ['oa', 'my-leave'], queryFn: () => api.get<MyLeave>('/api/oa/me/leave') });
  const withBalance = new Set(q.data?.types.filter((t) => t.hasBalance).map((t) => t.id));
  const rows = q.data?.balances.filter((b) => withBalance.has(b.leaveTypeId)) ?? [];
  return (
    <Card className="p-4" data-testid="oa-me-leave">
      <SectionTitle title="假期余额" to="/oa/leave" testId="oa-me-leave-more" />
      {q.isPending ? (
        <Skeleton className="h-12" />
      ) : q.isError ? (
        <p className="text-[13px] text-clay">假期余额没有取回来</p>
      ) : rows.length === 0 ? (
        <p className="text-[13px] text-ink-3">今年还没有发放的假期</p>
      ) : (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {rows.map((b) => (
            <div key={b.leaveTypeId} className="rounded-md bg-paper-2 px-3 py-2">
              <p className="flex items-center gap-1.5 text-[12.5px] text-ink-3">
                <Palmtree className="size-3.5" />
                {b.name}
              </p>
              <p className="num text-[18px] font-bold text-ink">{halvesText(b.grantedHalves - b.usedHalves)}</p>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

function ScheduleCard() {
  // 与「我的排班」页同一个查询（这个月）
  const q = useQuery({ queryKey: ['oa', 'my-schedule', null], queryFn: () => api.get<MySchedule>('/api/oa/me/schedule') });
  return (
    <Card className="p-3 md:p-4" data-testid="oa-me-schedule">
      <SectionTitle title={q.data ? `我的排班 · ${Number(q.data.month.slice(5))} 月` : '我的排班'} to="/oa/schedule" testId="oa-me-schedule-more" />
      {q.isPending ? (
        <Skeleton className="h-64" />
      ) : q.isError ? (
        <p className="text-[13px] text-clay">排班没有取回来</p>
      ) : (
        <>
          <DayLegend />
          <MonthGrid data={q.data} />
        </>
      )}
    </Card>
  );
}

function FaceRow() {
  const q = useQuery({ queryKey: ['oa', 'my-face'], queryFn: () => api.get<MyFace>('/api/oa/face/me') });
  return (
    <Card className="p-1">
      <Row to="/oa/face" icon={<ScanFace className="size-5" />} testId="oa-me-face">
        人脸录入
        <span className="ml-auto text-[13px] text-ink-3" data-testid="oa-me-face-status">
          {q.data ? FACE_TEXT[q.data.status] : q.isError ? '没有取回来' : ''}
        </span>
      </Row>
    </Card>
  );
}

function SettingsCard() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const logout = async () => {
    await api.post('/api/auth/logout').catch(() => {});
    qc.clear();
    navigate('/login', { replace: true });
  };
  return (
    <Card className="p-1" data-testid="oa-me-settings">
      <p className="px-3 pt-2 text-[13px] font-bold text-ink-3">设置</p>
      <Row to="/crm/password" icon={<KeyRound className="size-5" />} testId="oa-me-password">
        修改密码
      </Row>
      <ThemeMenuRow />
      <Row to="/" icon={<LayoutGrid className="size-5" />} testId="oa-me-portal">
        返回门户（CRM、ERP、WCP、Design）
      </Row>
      <button
        type="button"
        onClick={logout}
        data-testid="oa-me-logout"
        className="tap relative flex h-12 w-full items-center gap-3 rounded-md px-3 text-left text-[15px] font-semibold text-clay hover:bg-paper-2"
      >
        <LogOut className="size-5" />
        退出登录
      </button>
    </Card>
  );
}

function Row({ to, icon, children, testId }: { to: string; icon: ReactNode; children: ReactNode; testId: string }) {
  return (
    <Link to={to} data-testid={testId} className="tap relative flex h-12 items-center gap-3 rounded-md px-3 text-[15px] font-semibold text-ink hover:bg-paper-2">
      <span className="text-pine">{icon}</span>
      {children}
      <ChevronRight className="size-4 shrink-0 text-ink-4" />
    </Link>
  );
}
