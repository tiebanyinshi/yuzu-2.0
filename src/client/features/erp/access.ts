import { visibleBoardSections } from '@shared/admin';
import { ERP_MODULE_KEYS, ERP_MODULES } from '@shared/erp';
import { useCan, useSession } from '../../lib/session';
import { useStoreNavItems } from '../../components/storeNav';

/**
 * 当前账号在 ERP 里能用的模块（店主开着、依赖满足、有权限），能不能进 ERP、登录后落在哪一页，
 * 以及「返回门店」回到哪一页（门店那边没有能用的页面时 ERP 顶栏不显示「返回门店」）。
 */
export function useErpAccess() {
  const session = useSession();
  const can = useCan();
  // 对客导览不算门店的工作页面（所有岗位都能看，只用 ERP 的人不因此多出「返回门店」）
  const storeNav = useStoreNavItems().filter((n) => !n.guestFacing);
  const modules = ERP_MODULE_KEYS.filter((k) => session.erpModules.includes(k) && ERP_MODULES[k].perms.some((p) => can(p)));
  const canSettings = can('settings.manage');
  // 原来后台里归 ERP 的分区（门店与主体、对外接口、期初与旧账、操作审计，店主 2026-11-24，docs/BOARDS.md）：
  // 只有这些权限（比如只看审计）、没有能用的 ERP 模块的，也要进得了 ERP 找到它们（Codex 审查 292af3d）
  const adminSections = visibleBoardSections('erp', can, session.erpModules);
  return {
    modules,
    /** 能进 ERP：有能用的模块，或者是能改模块开关的店主，或者有归 ERP 的设置分区 */
    canEnter: modules.length > 0 || canSettings || adminSections.length > 0,
    adminSections,
    canSettings,
    /** 只用 ERP 的人登录后直接进第一个能用的模块 */
    landing: modules.length ? ERP_MODULES[modules[0]!].path : null,
    /**
     * 「返回门店」回到哪一页：门店首页（会员工作台）；没有会员权限的回到门店主导航里第一个能用的页面
     * （门店首页会把只用 ERP 的人送回 ERP，例如开了餐饮时管厨房的后勤要直接进餐饮）
     */
    storeHome: storeNav.find((n) => n.to === '/crm')?.to ?? storeNav[0]?.to ?? null,
  };
}
