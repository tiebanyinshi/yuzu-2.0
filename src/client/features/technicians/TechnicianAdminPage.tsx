// 技师管理（8.1.15，《浴族系统需求汇总》技师 3，docs/TECHNICIANS_V8115.md 第 4 节）：门店页面，五个页签——
// 技师名册、技师组别、技师班次（班次、排班表、临时调班）、休假名册（申请、审批），技师榜单（docs/TECH_RANKING.md）。
// 看：有「维护技师名册」或钟房权限的都能进；改名册、组别、班次、排班与审批休假要「维护技师名册」，申请与撤回休假钟房的岗位就能做。
// 技师的规则、提成、哪些项目需要技师仍在「后台 → 技师」（当班不会动的）。

import { Link, Navigate } from 'react-router';
import { Hourglass, Settings2 } from 'lucide-react';
import { ADMIN_SECTIONS } from '@shared/admin';
import { useCan, useSession } from '../../lib/session';
import { PageHeader } from '../../components/AppShell';
import { LoadFailed } from '../../components/LoadFailed';
import { SubPane, SubTabPage, type SubTab } from '../../components/SubNav';
import { Notice, Skeleton } from '../../components/ui';
import { GroupsTab } from './GroupsTab';
import { LeavesTab } from './LeavesTab';
import { useTechAdmin } from './queries';
import { RankingTab } from './RankingTab';
import { RosterTab } from './RosterTab';
import { ShiftsTab } from './ShiftsTab';

const TECH_ADMIN_PATH = '/technicians';

const headerLink = 'flex h-11 items-center gap-1.5 rounded-md border border-line-strong bg-card px-3.5 text-[13.5px] font-bold text-ink-2 hover:border-ink-3';

export function TechnicianAdminPage() {
  const session = useSession();
  const can = useCan();
  const allowed = can('technician.manage') || can('technician.dispatch');
  // 技师榜单（docs/TECH_RANKING.md，TR1）：只有「技师上钟轮播」的进来只看榜单
  const rankingOnly = !allowed && can('technician.board');
  const view = useTechAdmin(allowed && session.technicians);
  if (!allowed && !rankingOnly) return <Navigate to="/" replace />;
  if (!session.technicians) {
    return (
      <>
        <PageHeader title="技师管理" />
        <div className="p-8">
          <Notice tone="info" title="技师功能没有开启">
            店主在「后台 → 技师」开启技师功能后，这里维护技师名册、组别、班次与休假。
          </Notice>
        </div>
      </>
    );
  }
  if (rankingOnly) {
    return (
      <>
        <PageHeader title="技师榜单" subtitle="按工种看技师与实时状态" />
        <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-[1280px] px-5 py-5 md:px-7">
            <RankingTab />
          </div>
        </div>
      </>
    );
  }
  const v = view.data;
  const tabs: SubTab[] = [
    { key: 'roster', label: '技师名册', testId: 'tech-tab-roster' },
    { key: 'groups', label: '技师组别', testId: 'tech-tab-groups' },
    { key: 'shifts', label: '技师班次', testId: 'tech-tab-shifts' },
    { key: 'leaves', label: '休假名册', badge: v?.pendingLeaves, testId: 'tech-tab-leaves' },
    { key: 'ranking', label: '技师榜单', testId: 'tech-tab-ranking' },
  ];
  return (
    <>
      <PageHeader
        title="技师管理"
        subtitle={
          v
            ? `在职 ${v.technicians.filter((t) => t.active).length} 人 · 今天休假 ${v.technicians.filter((t) => t.active && t.leaveToday).length} 人${v.pendingLeaves ? ` · 待审批休假 ${v.pendingLeaves} 张` : ''}`
            : '载入中'
        }
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {can('technician.dispatch') && (
              <Link to="/clockroom" className={headerLink} data-testid="tech-admin-clockroom-link">
                <Hourglass className="size-4" />
                钟房
              </Link>
            )}
            {can('technician.manage') && (
              <Link to={ADMIN_SECTIONS.technicians.path} className={headerLink} data-testid="tech-admin-rules-link">
                <Settings2 className="size-4" />
                规则与提成
              </Link>
            )}
          </div>
        }
      />
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[1280px] px-5 py-5 md:px-7" data-testid="technician-admin">
          {view.isPending ? (
            <Skeleton className="h-64" />
          ) : !v ? (
            <LoadFailed title="技师管理没取回来" onRetry={() => void view.refetch()} retrying={view.isFetching} testId="tech-admin-failed" />
          ) : (
            <SubTabPage tabs={tabs} base={TECH_ADMIN_PATH} label="技师管理的页签">
              {!v.canManage && (
                <Notice tone="info" title="只能看，能替技师申请休假" className="mb-4" data-testid="tech-admin-readonly">
                  改名册、组别、班次、排班与审批休假要「维护技师名册」权限（默认店主、店总）。
                </Notice>
              )}
              <SubPane tab="roster">
                <RosterTab view={v} />
              </SubPane>
              <SubPane tab="groups" lazy>
                <GroupsTab view={v} />
              </SubPane>
              <SubPane tab="shifts" lazy>
                <ShiftsTab view={v} />
              </SubPane>
              <SubPane tab="leaves" lazy>
                <LeavesTab view={v} />
              </SubPane>
              <SubPane tab="ranking" lazy>
                <RankingTab />
              </SubPane>
            </SubTabPage>
          )}
        </div>
      </div>
    </>
  );
}
