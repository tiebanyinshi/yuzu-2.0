// WCP 的外壳（店主 2026-11-24：办公那边不要再有 CRM 的侧栏，docs/BOARDS.md 第 8 节）。
// 宽屏（电脑）：顶栏写 WCP、门店、实例标识与版本，右边通知铃铛、头像菜单（改密码、退出）、「门户」；左边一列是 WCP 的入口（与首页方块同一份）。
// 宽屏以下、平板（768–1024）：入口横排在顶栏下面。
// 窄屏（手机，768 以下，店主 2026-11-25《员工办公系统建设需求文档 v1.1》第二节，docs/OA_MOBILE.md）：顶部公司名 + 搜索框，
// 底部 4 个 Tab（工作台 / 消息 / 知识库 / 我的），不是 Tab 首页的页面顶栏左边出「返回」。两种布局是同一个页面、同一套接口。

import { useEffect, useState, type ReactNode } from 'react';
import { Link, NavLink, useLocation, useNavigate, useSearchParams } from 'react-router';
import { CalendarClock, ChevronLeft, Search, UserRound } from 'lucide-react';
import { versionText } from '@shared/instance';
import { usePageEnter } from '../../lib/motion';
import { useSession } from '../../lib/session';
import { cn } from '../../lib/utils';
import { InstanceBadge } from '../../components/InstanceTag';
import { PortalBackButton } from '../../components/PortalBack';
import { ThemeToggleButton } from '../../components/ThemeSwitch';
import { UserMenu } from '../../components/UserMenu';
import { NotificationBell } from './Notifications';
import { isWcpTabRoot, useWcpNav, WCP_TABS, wcpTabOf } from './wcpNav';

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
  const side = [{ to: '/oa', label: '首页', icon: CalendarClock, testId: 'wcp-home' }, { to: '/oa/me', label: '我的', icon: UserRound, testId: 'wcp-me' }, ...items];
  const link = (it: (typeof side)[number], compact: boolean) => (
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
      <it.icon className="size-4 shrink-0" />
      {it.label}
    </NavLink>
  );
  return (
    <div className="flex h-dvh min-h-0 flex-col bg-paper" data-testid="wcp-shell">
      <header data-surface="rail" className="hidden h-14 shrink-0 items-center gap-3 bg-rail px-5 text-paper md:flex">
        <span className="flex size-8 items-center justify-center rounded-[10px] bg-white/10 text-[12px] font-black tracking-tight">WCP</span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[15px] leading-tight font-bold">
            WCP<span className="font-semibold text-paper/60"> · 员工工作台 · {session.storeName}</span>
          </p>
          {/* 实例标识与「版本 + SHA」常显（AGENTS.md 环境隔离） */}
          <p className="mt-0.5 flex min-w-0 items-center gap-1.5" data-testid="wcp-instance" title={versionText(session.version, session.commit)}>
            <InstanceBadge instance={session.instance} className="h-5 px-2 text-[12px]" />
            <span className="num truncate text-[12px] text-paper/60">{versionText(session.version, session.commit)}</span>
          </p>
        </div>
        <NotificationBell placement="rail" />
        <ThemeToggleButton className="size-9" />
        <UserMenu placement="bar" />
        <PortalBackButton />
      </header>
      <MobileTopBar />
      {/* 平板（768–1024）：入口横排在顶栏下面、可以横着滑 */}
      <nav aria-label="WCP 分区" className="hidden shrink-0 gap-1.5 overflow-x-auto border-b border-line bg-card px-3 py-2 md:flex lg:hidden">
        {side.map((it) => link(it, true))}
      </nav>
      <div className="flex min-h-0 flex-1">
        <nav aria-label="WCP 导航" className="scroll-thin hidden w-[200px] shrink-0 flex-col gap-0.5 overflow-y-auto border-r border-line bg-card px-3 py-4 lg:flex">
          {side.map((it) => link(it, false))}
        </nav>
        <div ref={content} className="scroll-thin flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden overflow-y-auto" data-testid="app-content">
          {children}
        </div>
      </div>
      <MobileTabBar />
    </div>
  );
}

/** 手机顶栏：公司名（门店名）+ 实例标识与版本；Tab 首页下面一行搜索框，别的页面左边出「返回」 */
function MobileTopBar() {
  const session = useSession();
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const tab = wcpTabOf(pathname);
  const root = isWcpTabRoot(pathname);
  const onWork = (pathname.replace(/\/+$/, '') || '/oa') === '/oa';
  const q = onWork ? (params.get('q') ?? '') : '';
  // 搜索：先在工作台的功能入口里找（知识库的检索第 5 批再接上）
  const search = (text: string) => navigate(text ? `/oa?q=${encodeURIComponent(text)}` : '/oa', { replace: onWork });
  // 工作台的搜索框跟着地址里的 q 走（点底部「工作台」清掉 q 时框里也清空，Codex 审查 6c8e9e7）；别的 Tab 上没提交的字留着
  const [workText, setWorkText] = useState(q);
  const [otherText, setOtherText] = useState('');
  useEffect(() => {
    if (onWork) setWorkText((t) => (t.trim() === q ? t : q));
  }, [onWork, q]);
  return (
    <header data-surface="rail" className="shrink-0 bg-rail px-3 pt-[max(env(safe-area-inset-top),0.5rem)] pb-2 text-paper md:hidden" data-testid="wcp-mobile-top">
      <div className="flex h-10 items-center gap-2">
        {!root && (
          <Link to={tab.to} aria-label={`返回${tab.label}`} data-testid="wcp-mobile-back" className="tap relative -ml-1 flex size-9 items-center justify-center rounded-full hover:bg-white/10">
            <ChevronLeft className="size-5" />
          </Link>
        )}
        <div className="min-w-0 flex-1">
          <p className="truncate text-[16px] leading-tight font-bold" data-testid="wcp-mobile-company">
            {session.storeName}
          </p>
          <p className="flex min-w-0 items-center gap-1.5" data-testid="wcp-mobile-instance" title={versionText(session.version, session.commit)}>
            <InstanceBadge instance={session.instance} className="h-4 px-1.5 text-[12px]" />
            <span className="num truncate text-[12px] text-paper/60">{versionText(session.version, session.commit)}</span>
          </p>
        </div>
        <NotificationBell placement="rail" />
      </div>
      {root && (
        <form
          role="search"
          className="relative mt-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            search(String(new FormData(e.currentTarget).get('q') ?? '').trim());
          }}
        >
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-paper/50" />
          <input
            name="q"
            type="search"
            value={onWork ? workText : otherText}
            onChange={(e) => {
              if (!onWork) return setOtherText(e.target.value);
              setWorkText(e.target.value);
              search(e.target.value.trim());
            }}
            placeholder="搜索功能，如 打卡、工资条"
            aria-label="搜索"
            data-testid="wcp-mobile-search"
            className="h-9 w-full rounded-full bg-white/12 pr-3 pl-9 text-[14px] text-paper placeholder:text-paper/50 focus:bg-white/18 focus:outline-none"
          />
        </form>
      )}
    </header>
  );
}

/** 手机底部 4 个 Tab */
function MobileTabBar() {
  const { pathname } = useLocation();
  const current = wcpTabOf(pathname);
  return (
    <nav aria-label="手机底部标签" className="flex shrink-0 border-t border-line bg-card pb-[env(safe-area-inset-bottom)] md:hidden" data-testid="wcp-tabbar">
      {WCP_TABS.map((t) => {
        const active = t.key === current.key;
        return (
          <Link
            key={t.key}
            to={t.to}
            aria-current={active ? 'page' : undefined}
            data-testid={`wcp-tab-${t.key}`}
            className={cn('tap relative flex h-14 flex-1 flex-col items-center justify-center gap-0.5 text-[12px] font-semibold', active ? 'text-pine' : 'text-ink-3')}
          >
            <t.icon className={cn('size-[22px]', active && 'stroke-[2.4]')} />
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}
