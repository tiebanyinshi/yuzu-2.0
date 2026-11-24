import { useEffect, useState, type ComponentType, type ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router';
import { describeBusinessHours, isOpenAt, minuteOfDay } from '@shared/business-date';
import { describeDate } from '@shared/labels';
import { usePageEnter } from '../lib/motion';
import { useCan, useSession } from '../lib/session';
import { InstanceTag } from './InstanceTag';
import { StoreSwitcher } from './StoreSwitcher';
import { UserMenu } from './UserMenu';
import { storePageOf } from './storeNav';
import { StoreRail } from './StoreRail';
import { PendingOpsBanner } from './PendingOpsBanner';
import { FrontdeskPendingBanner } from '../features/frontdesk/PendingBanner';
import { TerminalBridgeRunner } from '../features/devices/terminal';
import { Badge } from './ui';

/**
 * 通知铃铛（OA-03）按需加载：首屏主包有体积上限（check:bundle），铃铛晚一点出现不碍事。
 * 不用 React.lazy：代码没下载下来时 lazy 会当渲染出错往上抛，连导航和前台一起卸掉；
 * 这里下载失败只是先不显示铃铛，30 秒后再试，不影响别的。
 */
function NotificationBellSlot() {
  const [Bell, setBell] = useState<ComponentType | null>(null);
  // AppShell 登录期间一直在，不必管卸载
  useEffect(() => {
    const load = () =>
      void import('../features/oa/Notifications').then(
        (m) => setBell(() => m.NotificationBell),
        () => setTimeout(load, 30_000),
      );
    load();
  }, []);
  return Bell ? <Bell /> : null;
}

export function AppShell({ children }: { children: ReactNode }) {
  const can = useCan();
  const session = useSession();
  // ERP（库存、采购、货款、待办）在单独的工作区，主导航里没有（v0.7.3）；待办的数字在 ERP 导航上。
  // 主导航按业务域分组（8.1.15），在 StoreRail 里
  const { pathname } = useLocation();
  // 动效（8.0.16）：换页面时内容区淡入
  const content = usePageEnter<HTMLDivElement>(pathname);
  // 没有权限的门店页面（流水、日结、交班、前台……）回到首页：只用 ERP 的人回到 ERP，客户经理回到会员工作台。
  // 功能没开启（钟房、餐饮）不算没有权限，页面自己提示
  const page = storePageOf(pathname);
  if (page && !(Array.isArray(page.perm) ? page.perm : [page.perm]).some((p) => can(p))) return <Navigate to="/" replace />;
  return (
    // 回测整改 P02（回测 2-1）：整屏不滚，左侧主导航固定、撑满一屏（菜单长了在导航里面滚）；右边内容区自己滚，
    // 页头（PageHeader）贴在内容区顶上。页面自己有滚动区的照旧在里面滚，不会出现两条滚动条
    <div className="flex h-dvh min-h-0 overflow-hidden bg-paper">
      {/* 设备（v0.7.21）：选了「这台终端」的设备常连本机的设备服务、替它上报（不在设备页也照常） */}
      <TerminalBridgeRunner />
      <StoreRail
        beside={<NotificationBellSlot />}
        footer={
          <>
            {/* 能进不止一家店的人：当前门店、点一下换店（8.0.22）；只有一家店时不显示 */}
            <StoreSwitcher />
            <InstanceTag instance={session.instance} version={session.version} commit={session.commit} />
            <UserMenu />
          </>
        }
      />
      <div ref={content} className="scroll-thin flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden overflow-y-auto" data-testid="app-content">
        <PendingOpsBanner />
        {can('frontdesk.operate') && <FrontdeskPendingBanner />}
        {children}
      </div>
    </div>
  );
}

/** 页面顶栏：标题 + 营业日（库存页为自然日）+ 演示数据标记 */
export function PageHeader({ title, subtitle, actions, dateMode = 'business' }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode; dateMode?: 'business' | 'calendar' }) {
  const session = useSession();
  const d = describeDate(dateMode === 'business' ? session.today : session.calendarToday);
  const hours = session.rules.businessHours;
  const now = useMinuteClock(!!hours);
  const closed = !!hours && !isOpenAt(minuteOfDay(new Date(now), session.timezone), hours);
  return (
    <header className="sticky top-0 z-20 flex min-h-[64px] shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b border-line bg-paper/90 px-5 py-3 backdrop-blur md:px-7">
      {/* 标题至少留 10rem：窄屏（商米 V3）上右边的按钮放不下时换到下一行，不把标题挤成一个字（8.1.9） */}
      <div className="min-w-0 flex-1 basis-40">
        <h1 className="truncate text-[19px] font-bold tracking-tight text-ink">{title}</h1>
        {subtitle && <p className="truncate text-[12.5px] text-ink-3">{subtitle}</p>}
      </div>
      {actions}
      {session.hasSyntheticData && session.env !== 'production' && (
        <Badge tone="ember" className="hidden sm:inline-flex">
          合成演示数据
        </Badge>
      )}
      <div
        className="flex items-center gap-2 rounded-full border border-line bg-card py-1 pr-3.5 pl-1 shadow-card"
        title={`营业时间 ${describeBusinessHours(hours)}；营业日每天 ${String(session.rules.businessDayStartHour).padStart(2, '0')}:00 切换`}
      >
        <span className="rounded-full bg-pine px-2.5 py-1 text-[12px] font-bold text-paper">{dateMode === 'business' ? '营业日' : '今天'}</span>
        <span className="num text-[13.5px] font-bold text-ink">{d.md}</span>
        <span className="text-[12.5px] text-ink-3">{d.weekday}</span>
        {closed && (
          <span className="rounded-full bg-clay-soft px-2 py-0.5 text-[12px] font-bold text-clay" data-testid="outside-hours">
            非营业时间
          </span>
        )}
      </div>
    </header>
  );
}

/** 每分钟更新一次的当前时间（只在需要时启用） */
function useMinuteClock(enabled: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, [enabled]);
  return now;
}
