// 系统门户页（店主 2026-11-24《系统门户页改造需求说明》，docs/PORTAL.md）：登录后的第一个界面。
// 自上而下：顶栏（左 Logo 与名称；右 通知铃铛、环境标识、换店、版本号、头像）→ 欢迎语 → 四大板块入口。
// 店主 2026-11-24（docs/BOARDS.md）：四个板块改叫 CRM、ERP、WCP、Design；原来管理后台的分区拆进各板块，Design 是品牌与设计。
// 纯入口层：四个板块内部不改；同一套登录与权限，进去以后照旧按权限显示菜单。没有权限的板块显示但置灰、点不进去（不白屏）。

import type { ReactNode } from 'react';
import { Link, Navigate, useLocation } from 'react-router';
import { ArrowRight, Building2, CalendarClock, Lock, Palette, Waves, type LucideIcon } from 'lucide-react';
import { visibleBoardSections } from '@shared/admin';
import { versionText } from '@shared/instance';
import { DUTY_LABELS, ROLE_LABELS } from '@shared/labels';
import { LogoMark } from '../../components/Brand';
import { InstanceBadge } from '../../components/InstanceTag';
import { StoreSwitcher } from '../../components/StoreSwitcher';
import { UserMenu } from '../../components/UserMenu';
import { useStoreNavItems } from '../../components/storeNav';
import { homeIsEmenu } from '../../lib/landing';
import { useCan, useSession } from '../../lib/session';
import { cn } from '../../lib/utils';
import { NotificationBell } from '../oa/Notifications';
import { useErpAccess } from '../erp/access';

export type PortalBoard = 'crm' | 'erp' | 'wcp' | 'design';

interface Board {
  key: PortalBoard;
  name: string;
  hint: string;
  icon: LucideIcon;
  /** 进得去时跳到哪里；进不去为 null（卡片置灰） */
  to: string | null;
  /** 卡片的配色：CRM 墨绿、ERP 沿用 ERP 顶栏的深蓝、WCP 轻量、Design 中性灰绿（都是现有的主题色，不另加） */
  tone: { card: string; icon: string; name: string; hint: string; arrow: string };
}

const TONES: Record<PortalBoard, Board['tone']> = {
  crm: { card: 'bg-rail text-paper border-transparent hover:border-yuzu', icon: 'bg-white/10 text-yuzu', name: 'text-paper', hint: 'text-paper/70', arrow: 'text-yuzu' },
  erp: { card: 'bg-rail-erp text-paper border-transparent hover:border-yuzu', icon: 'bg-white/10 text-paper', name: 'text-paper', hint: 'text-paper/70', arrow: 'text-yuzu' },
  wcp: { card: 'bg-card border-line hover:border-lake', icon: 'bg-lake-soft text-lake', name: 'text-ink', hint: 'text-ink-3', arrow: 'text-lake' },
  design: { card: 'bg-paper-3 border-line hover:border-moss', icon: 'bg-moss-soft text-moss', name: 'text-ink', hint: 'text-ink-3', arrow: 'text-moss' },
};

/** 这位账号的四个板块：进得去的给地址，进不去的为 null（纯函数式的判断都在现有的权限上，不另加） */
export function usePortalBoards(): Board[] {
  const can = useCan();
  const session = useSession();
  const erp = useErpAccess();
  // Design：品牌与设计的分区（UI 工作台、对客导览……）有一个进得去就能进，落在 Design 首页
  const design = visibleBoardSections('design', can, session.erpModules);
  // CRM（门店主导航，CRM 设置除外）：落到第一个能用的工作页面（会员工作台优先）；只有对客导览的（门店大屏）进导览
  const nav = useStoreNavItems().filter((n) => n.to !== '/admin');
  const work = nav.filter((n) => !n.guestFacing);
  const storeTo = work.find((n) => n.to === '/crm')?.to ?? work[0]?.to ?? nav[0]?.to ?? null;
  return [
    { key: 'crm', name: 'CRM', hint: '客户与前台营业：房态、会员、技师、收银', icon: Waves, to: storeTo, tone: TONES.crm },
    { key: 'erp', name: 'ERP', hint: '财务与经营管理：库存、采购、货款、费用', icon: Building2, to: erp.canEnter ? '/erp' : null, tone: TONES.erp },
    // WCP（员工工作台，原「办公」）人人都有：自己的排班、考勤、审批、通知
    { key: 'wcp', name: 'WCP', hint: '员工工作台：排班、考勤、审批、工资条', icon: CalendarClock, to: '/oa', tone: TONES.wcp },
    { key: 'design', name: 'Design', hint: '品牌与设计：素材、版面、导览、官网', icon: Palette, to: design.length ? '/admin/design' : null, tone: TONES.design },
  ];
}

export function PortalPage() {
  const session = useSession();
  const can = useCan();
  const boards = usePortalBoards();
  const { search, hash } = useLocation();
  // 点餐平板账号（8.0.10）只开点餐页：不经过门户
  if (homeIsEmenu(can)) return <Navigate to="/emenu" replace />;
  // CRM 搬到 /crm 以前发出去的首页链接（/?m=会员、/?resume=……）：带着参数进 CRM 首页（店主 2026-11-24，docs/BOARDS.md 第 8 节）
  if (search || hash) return <Navigate to={`/crm${search}${hash}`} replace />;
  const roles = [ROLE_LABELS[session.staff.role], ...session.staff.duties.map((d) => DUTY_LABELS[d].title)].join(' · ');
  return (
    <div className="flex min-h-dvh flex-col bg-paper" data-testid="portal">
      <PortalTopBar />
      <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col px-4 py-8 sm:px-6 md:justify-center md:py-12">
        <section className="mb-7 md:mb-10" data-testid="portal-welcome">
          <p className="text-[13px] font-semibold tracking-wide text-yuzu-deep">{session.storeName}</p>
          <h1 className="mt-1 text-[24px] font-bold tracking-tight text-ink md:text-[30px]">
            {greeting()}，{session.staff.displayName}
          </h1>
          <p className="mt-1.5 text-[13.5px] text-ink-3">{roles} · 选一个板块开始工作</p>
        </section>
        <nav aria-label="系统板块" className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4 lg:gap-5" data-testid="portal-boards">
          {boards.map((b) => (
            <BoardCard key={b.key} board={b} />
          ))}
        </nav>
      </main>
    </div>
  );
}

function BoardCard({ board: b }: { board: Board }) {
  const Icon = b.icon;
  const body: ReactNode = (
    <>
      <span className={cn('flex size-12 items-center justify-center rounded-[14px] md:size-14', b.to ? b.tone.icon : 'bg-paper-2 text-ink-4')}>
        <Icon className="size-6 md:size-7" />
      </span>
      <span className="mt-auto block pt-6 md:pt-10">
        <span className={cn('flex items-center gap-2 text-[19px] font-bold tracking-tight md:text-[22px]', b.to ? b.tone.name : 'text-ink-3')}>
          {b.name}
          {b.to ? <ArrowRight className={cn('size-5 transition-transform group-hover:translate-x-1', b.tone.arrow)} /> : <Lock className="size-4 text-ink-4" />}
        </span>
        <span className={cn('mt-1 block min-h-[2.75em] text-[12.5px] leading-snug md:text-[13px]', b.to ? b.tone.hint : 'text-ink-4')}>{b.to ? b.hint : '没有这个板块的权限，需要时请找店长开通'}</span>
      </span>
    </>
  );
  const base = 'group flex min-h-[168px] flex-col rounded-[20px] border-2 p-4 md:min-h-[232px] md:p-6';
  if (!b.to) {
    return (
      <div aria-disabled="true" title="没有这个板块的权限" className={cn(base, 'cursor-not-allowed border-line bg-paper-2 opacity-80')} data-testid={`portal-board-${b.key}`} data-disabled="true">
        {body}
      </div>
    );
  }
  return (
    <Link
      to={b.to}
      className={cn(base, 'shadow-card transition duration-200 ease-out hover:-translate-y-1 hover:shadow-pop focus-visible:-translate-y-1', b.tone.card)}
      data-testid={`portal-board-${b.key}`}
    >
      {body}
    </Link>
  );
}

/** 门户页顶栏：左 Logo 与名称；右 通知铃铛、环境标识、换店（能进多家店时）、版本号、头像 */
function PortalTopBar() {
  const session = useSession();
  return (
    <header className="sticky top-0 z-20 border-b border-line bg-paper/90 backdrop-blur" data-testid="portal-topbar">
      <div className="mx-auto flex h-16 max-w-6xl items-center gap-2 px-4 sm:gap-3 sm:px-6">
        <Link to="/" className="flex min-w-0 flex-1 items-center gap-2.5" aria-label="柚子 yuzu 门户">
          <LogoMark className="size-9 shrink-0 rounded-[12px]" />
          <span className="min-w-0">
            <span className="block text-[16px] leading-tight font-bold text-ink">柚子 yuzu</span>
            <span className="block truncate text-[12px] leading-tight text-ink-3">{session.storeName}</span>
          </span>
        </Link>
        <NotificationBell placement="bar" />
        {/* 实例标识与「版本 + SHA」常显（AGENTS.md 环境隔离）：宽屏一行，窄屏版本号排在标识下面（Codex 审查 d4c9231） */}
        <span className="flex flex-col items-end gap-0.5 sm:flex-row sm:items-center sm:gap-2" data-testid="portal-instance">
          <InstanceBadge instance={session.instance} className="h-6 px-2.5 text-[12px]" />
          <span className="num text-[12px] leading-none text-ink-3 sm:order-last" data-testid="portal-version">
            {versionText(session.version, session.commit)}
          </span>
        </span>
        <StoreSwitcher placement="bar" />
        <UserMenu placement="bar" />
      </div>
    </header>
  );
}

function greeting(): string {
  const h = new Date().getHours();
  if (h < 5) return '夜深了';
  if (h < 11) return '早上好';
  if (h < 13) return '中午好';
  if (h < 18) return '下午好';
  return '晚上好';
}
