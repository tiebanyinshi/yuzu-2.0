// WCP 的外壳（店主 2026-11-24：办公那边不要再有 CRM 的侧栏，docs/BOARDS.md 第 8 节）：顶栏写 WCP、门店、实例标识与版本，
// 右边「门户」；宽屏左边一列是 WCP 的入口（与首页方块同一份），窄屏这一列横排在顶栏下面、可以横着滑。

import { useEffect, type ReactNode } from 'react';
import { NavLink, useLocation } from 'react-router';
import { CalendarClock } from 'lucide-react';
import { versionText } from '@shared/instance';
import { usePageEnter } from '../../lib/motion';
import { useSession } from '../../lib/session';
import { cn } from '../../lib/utils';
import { InstanceBadge } from '../../components/InstanceTag';
import { PortalBackButton } from '../../components/PortalBack';
import { ThemeToggleButton } from '../../components/ThemeSwitch';
import { useWcpNav } from './wcpNav';

export function WcpShell({ children }: { children: ReactNode }) {
  const session = useSession();
  const items = useWcpNav();
  const { pathname } = useLocation();
  const content = usePageEnter<HTMLDivElement>(pathname);
  useEffect(() => {
    document.title = `WCP · ${session.storeName}`;
    return () => {
      document.title = session.storeName;
    };
  }, [session.storeName]);
  const home = { to: '/oa', label: '首页', icon: CalendarClock, testId: 'wcp-home' };
  const link = (it: { to: string; label: string; icon: typeof CalendarClock; testId: string }, compact: boolean) => {
    const Icon = it.icon;
    return (
      <NavLink
        key={it.to}
        to={it.to}
        end={it.to === '/oa'}
        data-testid={compact ? `wcp-tab-${it.testId}` : `wcp-nav-${it.testId}`}
        className={({ isActive }) =>
          cn(
            'tap relative flex shrink-0 items-center gap-2.5 font-semibold whitespace-nowrap transition-colors duration-100',
            compact ? 'h-9 rounded-full px-3 text-[13px]' : 'h-10 rounded-lg px-3 text-[14px]',
            isActive ? 'bg-pine text-paper' : 'text-ink-2 hover:bg-paper-2 hover:text-ink',
          )
        }
      >
        <Icon className="size-4 shrink-0" />
        {it.label}
      </NavLink>
    );
  };
  return (
    <div className="flex h-dvh min-h-0 flex-col bg-paper" data-testid="wcp-shell">
      <header data-surface="rail" className="flex h-14 shrink-0 items-center gap-3 bg-rail px-4 text-paper md:px-5">
        <span className="flex size-8 items-center justify-center rounded-[10px] bg-white/10 text-[12px] font-black tracking-tight">WCP</span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[15px] leading-tight font-bold">
            WCP<span className="hidden font-semibold text-paper/60 sm:inline"> · 员工工作台 · {session.storeName}</span>
          </p>
          {/* 实例标识与「版本 + SHA」常显（AGENTS.md 环境隔离） */}
          <p className="mt-0.5 flex min-w-0 items-center gap-1.5" data-testid="wcp-instance" title={versionText(session.version, session.commit)}>
            <InstanceBadge instance={session.instance} className="h-5 px-2 text-[12px]" />
            <span className="num truncate text-[12px] text-paper/60">{versionText(session.version, session.commit)}</span>
          </p>
        </div>
        <span className="hidden text-[12.5px] text-paper/75 md:inline">{session.staff.displayName}</span>
        <ThemeToggleButton className="size-9" />
        <PortalBackButton />
      </header>
      <nav aria-label="WCP 分区" className="flex shrink-0 gap-1.5 overflow-x-auto border-b border-line bg-card px-3 py-2 lg:hidden">
        {[home, ...items].map((it) => link(it, true))}
      </nav>
      <div className="flex min-h-0 flex-1">
        <nav aria-label="WCP 导航" className="scroll-thin hidden w-[200px] shrink-0 flex-col gap-0.5 overflow-y-auto border-r border-line bg-card px-3 py-4 lg:flex">
          {[home, ...items].map((it) => link(it, false))}
        </nav>
        <div ref={content} className="scroll-thin flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden overflow-y-auto" data-testid="app-content">
          {children}
        </div>
      </div>
    </div>
  );
}
