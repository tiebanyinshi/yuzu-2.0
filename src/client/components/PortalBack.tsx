// 「返回门户」（店主 2026-11-24《系统门户页改造需求说明》，docs/PORTAL.md）：随时回到四大板块的门户页切换系统。
// 门店侧栏最下面一格（原来换店、实例标识、版本号、头像、通知铃铛的位置，这几项已移到门户页顶栏），ERP、后台的顶栏各一个。

import { NavLink } from 'react-router';
import { LayoutGrid } from 'lucide-react';
import { useSession } from '../lib/session';
import { cn } from '../lib/utils';
import { InstanceTone } from './InstanceTag';

/** 门店侧栏最下面：图标 +「门户」，下面一条按环境上色的短标识 */
export function PortalBackRail() {
  const session = useSession();
  return (
    <div className="flex w-[64px] flex-col items-center gap-1">
      <NavLink
        to="/"
        aria-label="返回门户"
        title="返回门户：切换 CRM、ERP、WCP、Design"
        data-testid="portal-back"
        className="tap relative flex w-full flex-col items-center gap-0.5 rounded-[12px] bg-white/10 px-1 py-1.5 text-[12px] leading-tight font-bold text-paper transition hover:bg-white/18"
      >
        <LayoutGrid className="size-[18px]" />
        门户
      </NavLink>
      <InstanceTone instance={session.instance} version={session.version} commit={session.commit} />
    </div>
  );
}

/** ERP、后台的顶栏：圆角小按钮 */
export function PortalBackButton({ className }: { className?: string }) {
  return (
    <NavLink
      to="/"
      title="返回门户：切换 CRM、ERP、WCP、Design"
      data-testid="portal-back"
      className={cn('tap relative flex h-9 items-center gap-1.5 rounded-full bg-white/10 px-3.5 text-[13px] font-semibold text-paper hover:bg-white/18', className)}
    >
      <LayoutGrid className="size-4" />
      <span className="hidden sm:inline">门户</span>
    </NavLink>
  );
}
