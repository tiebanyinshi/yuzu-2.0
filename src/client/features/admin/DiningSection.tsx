// 后台「餐饮」（S5）：餐饮规则（只有店主能改）、出品档口、菜品挂在哪个档口、桌台（能管理价目的岗位）。
// 挂了档口的菜在餐饮功能开启后才进厨房；没挂档口的项目照常挂账、不进厨房。需要技师的项目不进厨房。
// 桌台（第二步）：不洗浴的客人在桌台上用餐、单独结账；停用不删除，正在用餐的桌不能停用。

import { MAX_SERVICE_FEE_BP, serviceFeeText } from '@shared/table-charges';
import { useState } from 'react';
import { Link } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { ADMIN_SECTIONS } from '@shared/admin';
import {
  allDiningSlots,
  DEFAULT_DINING_RULES,
  diningOutletsOf,
  MAX_STATION_NAME,
  MAX_VOID_FREE_CENTS,
  MAX_TABLE_AREA,
  MAX_TABLE_NAME,
  TABLE_ZONES,
  diningSlotOf,
  slotKey,
  slotLabel,
  type DiningAdmin,
  type DiningRules,
  type DiningTable,
  type KitchenStation,
  type TablesAdmin,
} from '@shared/dining';
import { MAX_DIRTY_ALERT_MINUTES } from '@shared/frontdesk-v8117';
import { centsToInput, formatYuan, parseYuan } from '@shared/money';
import { api, errorMessage } from '../../lib/api';
import { qk } from '../../lib/queries';
import { useCan } from '../../lib/session';
import { cn, formatDateTime } from '../../lib/utils';
import { Money } from '../../components/Money';
import { Dialog } from '../../components/Overlay';
import { useToast } from '../../components/Toast';
import { Badge, Button, Card, Field, Input, MoneyInput, Notice, PendingBadge, SectionTitle, Segmented, Select, Skeleton } from '../../components/ui';
import { AdminPage, PriceSheetLink } from './AdminShell';
import { SubPane } from '../../components/SubNav';
import { RoomOrderConfigCard } from './RoomOrderConfigCard';
import { groupsProblem, OutletGroupsEditor } from './DiningGroupsEditor';
import { GroupStationsCard } from './GroupStationsCard';
import { roomTypeText, RoomTypesCard } from './RoomTypesCard';
import { MAX_RETURN_WINDOW_MINUTES } from '@shared/dining-v8224';
import { MealPeriodsEditor, mealPeriodsProblem } from './MealPeriodsEditor';

const adminKey = ['admin', 'dining'] as const;
const useDiningAdmin = () => useQuery({ queryKey: adminKey, queryFn: () => api.get<DiningAdmin>('/api/admin/dining') });
const tablesAdminKey = ['admin', 'dining', 'tables'] as const;
const useTablesAdmin = () => useQuery({ queryKey: tablesAdminKey, queryFn: () => api.get<TablesAdmin>('/api/admin/dining/tables') });

/** 二级页签（8.0.17）：规则 → 清单 */
const DINING_TABS = [
  { key: 'rules', label: '餐饮规则' },
  { key: 'stations', label: '档口与出品' },
  { key: 'tables', label: '桌台' },
];

export function DiningSection() {
  return (
    <AdminPage section="dining" description="餐饮功能开关与出品规则、出品档口（热菜、凉菜、水吧……）、每道菜送到哪个档口的厨房屏、桌台。" tabs={DINING_TABS}>
      <SubPane tab="rules">
        <RulesCard />
      </SubPane>
      <SubPane tab="stations" className="space-y-5">
        <StationsCard />
        <GroupStationsSection />
        <ItemsCard />
        <RoomOrderConfigCard />
      </SubPane>
      <SubPane tab="tables" className="space-y-5">
        <RoomTypesSection />
        <TablesCard />
      </SubPane>
    </AdminPage>
  );
}

/** 8.2.4：菜单分组的默认档口与核对列表 */
function GroupStationsSection() {
  const can = useCan();
  const admin = useDiningAdmin();
  if (!admin.data) return <Skeleton className="h-32" />;
  return <GroupStationsCard outlets={diningOutletsOf(admin.data.rules)} stations={admin.data.stations} editable={can('catalog.manage')} />;
}

/** 8.2.4：包房房型 */
function RoomTypesSection() {
  const can = useCan();
  const tables = useTablesAdmin();
  if (!tables.data) return <Skeleton className="h-32" />;
  return <RoomTypesCard data={tables.data} queryKey={tablesAdminKey} editable={can('catalog.manage')} />;
}

function RulesCard() {
  const can = useCan();
  const qc = useQueryClient();
  const toast = useToast();
  const admin = useDiningAdmin();
  const [draft, setDraft] = useState<DiningRules | null>(null);
  /** 小额退菜上限的输入（元）；null 为照规则里的值显示 */
  const [freeText, setFreeText] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (admin.data && !draft) setDraft(admin.data.rules);
  if (!draft || !admin.data) return <Skeleton className="h-48" />;
  const editable = can('settings.manage');
  const dirty = JSON.stringify(draft) !== JSON.stringify(admin.data.rules);
  const set = (patch: Partial<DiningRules>) => setDraft({ ...draft, ...patch });
  const minutesOk = Number.isInteger(draft.warnMinutes) && draft.warnMinutes >= 1 && draft.warnMinutes <= 180;
  // 8.1.17（BW-2）：待清台多久算久了
  const dirtyOk = Number.isInteger(draft.dirtyAlertMinutes) && draft.dirtyAlertMinutes >= 1 && draft.dirtyAlertMinutes <= MAX_DIRTY_ALERT_MINUTES;
  const freeCents = freeText === null ? draft.voidFreeCents : freeText.trim() === '' ? null : parseYuan(freeText);
  const freeOk = freeCents !== null && freeCents >= 0 && freeCents <= MAX_VOID_FREE_CENTS;
  // 8.2.4：门店的服务费默认（%）、返台时限
  const feeOk = Number.isInteger(draft.serviceFeeBp) && draft.serviceFeeBp >= 0 && draft.serviceFeeBp <= MAX_SERVICE_FEE_BP;
  const returnOk = Number.isInteger(draft.returnWindowMinutes) && draft.returnWindowMinutes >= 1 && draft.returnWindowMinutes <= MAX_RETURN_WINDOW_MINUTES;
  const mapped = admin.data.items.filter((i) => i.stationId !== null && !i.technicianRequired).length;
  // 8.1.39（R4）：菜单的小分类
  const groupsBad = groupsProblem(draft.outletGroups);
  // 8.2.8：餐段与裸票餐费
  const mealsBad = mealPeriodsProblem(draft.mealPeriods);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const next = await api.put<DiningAdmin>('/api/admin/dining/rules', draft);
      qc.setQueryData(adminKey, next);
      setDraft(next.rules);
      setFreeText(null);
      await qc.invalidateQueries({ queryKey: qk.session });
      await qc.invalidateQueries({ queryKey: ['dining'] });
      toast({ tone: 'success', title: '餐饮规则已保存', body: next.rules.enabled ? '主导航有「餐饮」：点单、厨房出品与沽清。' : '餐饮功能已关闭，前台挂账与升级前一样。' });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const row = (label: string, hint: string, control: React.ReactNode, pending = false) => (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 py-3">
      <div className="min-w-[200px] flex-1">
        <p className="flex items-center gap-2 text-[14px] font-bold">
          {label}
          {pending && <PendingBadge title="按洗浴中心餐厅常见做法先定的默认，待店主确认" />}
        </p>
        <p className="text-[12.5px] text-ink-3">{hint}</p>
      </div>
      {control}
    </div>
  );

  return (
    <Card className="p-5" data-testid="dining-rules-card">
      <SectionTitle aside={!editable && <Badge>只有店主能改</Badge>}>餐饮规则</SectionTitle>
      <div className="mt-1 divide-y divide-line/70">
        {row(
          '餐饮功能',
          `开启后主导航有「餐饮」：服务员按手牌点单，挂了档口的菜下单后到厨房屏。关闭时前台挂账与升级前完全一样。现在有 ${mapped} 道菜挂在档口上。`,
          <Segmented
            ariaLabel="餐饮功能"
            value={draft.enabled ? 'on' : 'off'}
            onChange={(v) => editable && set({ enabled: v === 'on' })}
            options={[
              { value: 'off', label: '关闭', disabled: !editable },
              { value: 'on', label: '开启', disabled: !editable },
            ]}
          />,
        )}
        {row(
          '出餐后要服务员点「上菜」',
          '开启时厨房出餐后菜在「待上菜」，服务员送到客人手上再点「上菜」；关闭后出餐即算上菜。',
          <Segmented
            ariaLabel="出餐后要服务员点上菜"
            value={draft.trackServed ? 'on' : 'off'}
            onChange={(v) => editable && set({ trackServed: v === 'on' })}
            options={[
              { value: 'on', label: '要点上菜', disabled: !editable },
              { value: 'off', label: '出餐即上菜', disabled: !editable },
            ]}
          />,
          true,
        )}
        {row(
          '多久没出餐标红',
          '下单超过这么多分钟还没出餐，厨房屏上标红提醒。',
          <span className="flex shrink-0 items-center gap-2 whitespace-nowrap">
            <Input
              type="number"
              inputMode="numeric"
              min={1}
              max={180}
              value={Number.isNaN(draft.warnMinutes) ? '' : draft.warnMinutes}
              disabled={!editable}
              onChange={(e) => set({ warnMinutes: e.target.value === '' ? NaN : Number(e.target.value) })}
              className="num h-10 w-20"
              aria-label="多久没出餐标红（分钟）"
              data-testid="dining-warn-minutes"
            />
            <span className="text-[13px] text-ink-3">分钟</span>
          </span>,
          true,
        )}
        {row(
          '桌台点单',
          '下架时（默认）点单页只能挂手牌点单，不能开台、点到桌台；已经开着的桌在「桌台账单」里照常结账、退菜。桌台档案照旧（小程序扫码点餐的送餐位置）。',
          <Segmented
            ariaLabel="桌台点单"
            value={draft.tablesEnabled ? 'on' : 'off'}
            onChange={(v) => editable && set({ tablesEnabled: v === 'on' })}
            options={[
              { value: 'off', label: '下架', disabled: !editable },
              { value: 'on', label: '开放', disabled: !editable },
            ]}
          />,
        )}
        {row(
          '结账后先待清台',
          '开启时（默认）桌台结完账先是「待清台」，服务员收拾好点「清台」才回到可用，之前不能开台、不能换过去；关闭后结账就空出来（与原来一样）。',
          <Segmented
            ariaLabel="结账后先待清台"
            value={draft.clearAfterCheckout ? 'on' : 'off'}
            onChange={(v) => editable && set({ clearAfterCheckout: v === 'on' })}
            options={[
              { value: 'on', label: '先待清台', disabled: !editable },
              { value: 'off', label: '直接可用', disabled: !editable },
            ]}
          />,
        )}
        {row(
          '维修到点自动恢复',
          '开启时，维修中的桌过了预计恢复时间，系统每分钟替人点「恢复」（桌台记录的经办人写「系统」）；关闭时（默认）格子上标「已过预计恢复时间」、进待办数，等人去点「恢复」。',
          <Segmented
            ariaLabel="维修到点自动恢复"
            value={draft.autoRestore ? 'on' : 'off'}
            onChange={(v) => editable && set({ autoRestore: v === 'on' })}
            options={[
              { value: 'off', label: '等人恢复', disabled: !editable },
              { value: 'on', label: '自动恢复', disabled: !editable },
            ]}
          />,
          true,
        )}
        {row(
          '待清台多久算久了',
          '结账以后待清台超过这么多分钟还没清台，格子上标出来、进待办数。',
          <span className="flex shrink-0 items-center gap-2 whitespace-nowrap">
            <Input
              type="number"
              inputMode="numeric"
              min={1}
              max={MAX_DIRTY_ALERT_MINUTES}
              value={Number.isNaN(draft.dirtyAlertMinutes) ? '' : draft.dirtyAlertMinutes}
              disabled={!editable}
              onChange={(e) => set({ dirtyAlertMinutes: e.target.value === '' ? NaN : Number(e.target.value) })}
              className="num h-11 w-20"
              aria-label="待清台多久算久了（分钟）"
              data-testid="dining-dirty-alert-minutes"
            />
            <span className="text-[13px] text-ink-3">分钟</span>
          </span>,
          true,
        )}
        {row(
          '服务费（门店默认）',
          '桌台没单独设服务费的按这个比例收，按这一桌点了、没退、没赠送的菜算（不算房费、低消补足）。默认只用在挂了房型的包房；桌台自己设了比例（含 0）的照桌台的。',
          <span className="flex shrink-0 flex-wrap items-center gap-2 whitespace-nowrap">
            <Input
              type="number"
              inputMode="decimal"
              min={0}
              max={MAX_SERVICE_FEE_BP / 100}
              value={Number.isNaN(draft.serviceFeeBp) ? '' : draft.serviceFeeBp / 100}
              disabled={!editable}
              onChange={(e) => set({ serviceFeeBp: e.target.value === '' ? NaN : Math.round(Number(e.target.value) * 100) })}
              className="num h-10 w-20"
              aria-label="服务费门店默认（%）"
              data-testid="dining-service-fee"
            />
            <span className="text-[13px] text-ink-3">%</span>
            <Segmented
              ariaLabel="门店默认服务费用在哪些桌"
              value={draft.serviceFeeScope}
              onChange={(v) => editable && set({ serviceFeeScope: v as DiningRules['serviceFeeScope'] })}
              options={[
                { value: 'rooms', label: '只收包房', disabled: !editable },
                { value: 'all', label: '所有桌台', disabled: !editable },
              ]}
            />
          </span>,
          true,
        )}
        {row(
          '返台时限',
          '包房结账时补了低消、客人还没走（桌台待清台）的，结账后这么多分钟以内可以返台：反结账这张单、回到桌台继续点，补到低消再结。清了台就不能返台。',
          <span className="flex shrink-0 items-center gap-2 whitespace-nowrap">
            <Input
              type="number"
              inputMode="numeric"
              min={1}
              max={MAX_RETURN_WINDOW_MINUTES}
              value={Number.isNaN(draft.returnWindowMinutes) ? '' : draft.returnWindowMinutes}
              disabled={!editable}
              onChange={(e) => set({ returnWindowMinutes: e.target.value === '' ? NaN : Number(e.target.value) })}
              className="num h-10 w-20"
              aria-label="返台时限（分钟）"
              data-testid="dining-return-window"
            />
            <span className="text-[13px] text-ink-3">分钟</span>
          </span>,
          true,
        )}
        {row(
          '水吧首杯免费',
          '每位客人水吧每个小分类（手作饮料、糖水、调酒……）第一杯自动折掉、小票上标【赠】写原价与实收 0，第二杯起照价收（走场 2026-11-27）。',
          <Segmented
            ariaLabel="水吧首杯免费"
            value={draft.firstCupFree ? 'on' : 'off'}
            onChange={(v) => editable && set({ firstCupFree: v === 'on' })}
            options={[
              { value: 'on', label: '首杯免费', disabled: !editable },
              { value: 'off', label: '都照价', disabled: !editable },
            ]}
          />,
          true,
        )}
        <MealPeriodsEditor value={draft.mealPeriods} onChange={(mealPeriods) => set({ mealPeriods })} editable={editable} />
        <OutletGroupsEditor value={draft.outletGroups} onChange={(outletGroups) => set({ outletGroups })} editable={editable} items={admin.data.items} saved={admin.data.rules.outletGroups} />
        {row(
          '小额退菜上限',
          '单条不超过这个金额的菜，服务员写原因就能直接退；超过的本人点的、规定时间内或经理照旧直接退，其余请值班经理及以上当场授权。填 0 不分级。退菜在「餐饮 → 台账」里按「退菜」看。',
          <span className="w-32 shrink-0">
            <MoneyInput
              value={freeText ?? (draft.voidFreeCents / 100).toString()}
              disabled={!editable}
              invalid={!freeOk}
              onChange={(e) => {
                setFreeText(e.target.value);
                const cents = e.target.value.trim() === '' ? null : parseYuan(e.target.value);
                if (cents !== null && cents >= 0 && cents <= MAX_VOID_FREE_CENTS) set({ voidFreeCents: cents });
              }}
              aria-label="小额退菜上限（元）"
              data-testid="dining-void-free"
            />
          </span>,
          true,
        )}
      </div>
      {!minutesOk && <Notice tone="error" title="分钟数要在 1 到 180 之间" className="mt-3" />}
      {!dirtyOk && <Notice tone="error" title={`待清台的分钟数要在 1 到 ${MAX_DIRTY_ALERT_MINUTES} 之间`} className="mt-3" />}
      {!freeOk && <Notice tone="error" title={`小额退菜上限填 0 到 ${formatYuan(MAX_VOID_FREE_CENTS)} 之间的金额`} className="mt-3" />}
      {!feeOk && <Notice tone="error" title={`服务费填 0 到 ${MAX_SERVICE_FEE_BP / 100} 之间的比例`} className="mt-3" />}
      {!returnOk && <Notice tone="error" title={`返台时限填 1 到 ${MAX_RETURN_WINDOW_MINUTES} 分钟`} className="mt-3" />}
      {mealsBad && <Notice tone="error" title={mealsBad} className="mt-3" />}
      {groupsBad && <Notice tone="error" title={groupsBad} className="mt-3" />}
      {error && <Notice tone="error" title={error} className="mt-3" />}
      <div className="mt-3 flex flex-wrap items-center justify-end gap-3">
        <span className="mr-auto text-[12px] text-ink-4">
          {admin.data.rulesUpdatedAt ? `最近由${admin.data.rulesUpdatedBy ?? '系统'}于 ${formatDateTime(admin.data.rulesUpdatedAt)} 修改` : '一直按默认'}
        </span>
        {editable &&
          (draft.trackServed !== DEFAULT_DINING_RULES.trackServed ||
            draft.warnMinutes !== DEFAULT_DINING_RULES.warnMinutes ||
            draft.tablesEnabled !== DEFAULT_DINING_RULES.tablesEnabled ||
            draft.clearAfterCheckout !== DEFAULT_DINING_RULES.clearAfterCheckout ||
            draft.autoRestore !== DEFAULT_DINING_RULES.autoRestore ||
            draft.dirtyAlertMinutes !== DEFAULT_DINING_RULES.dirtyAlertMinutes ||
            draft.voidFreeCents !== DEFAULT_DINING_RULES.voidFreeCents) && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                // 小分类不跟着恢复（还有菜在用的改不回去），在上面单独改
                setDraft({ ...DEFAULT_DINING_RULES, enabled: draft.enabled, outletGroups: draft.outletGroups, groupStations: draft.groupStations });
                setFreeText(null);
              }}
            >
              其他规则恢复默认
            </Button>
          )}
        {editable && (
          <Button
            variant="primary"
            loading={busy}
            disabled={!dirty || !minutesOk || !freeOk || !dirtyOk || !feeOk || !returnOk || !!groupsBad || !!mealsBad}
            onClick={save}
            data-testid="dining-rules-save"
          >
            保存餐饮规则
          </Button>
        )}
      </div>
    </Card>
  );
}

function StationsCard() {
  const can = useCan();
  const admin = useDiningAdmin();
  const [editing, setEditing] = useState<KitchenStation | 'new' | null>(null);
  if (!admin.data) return <Skeleton className="h-40" />;
  const editable = can('catalog.manage');
  const stations = admin.data.stations;
  return (
    <Card className="p-5" data-testid="dining-stations">
      <SectionTitle
        aside={
          editable && (
            <Button size="sm" variant="secondary" icon={<Plus className="size-4" />} onClick={() => setEditing('new')} data-testid="dining-station-new">
              新建档口
            </Button>
          )
        }
      >
        出品档口
      </SectionTitle>
      <p className="mt-1 text-[12.5px] text-ink-3">厨房按档口分屏（热菜、凉菜、主食、水吧……），每块屏只看自己档口的菜。停用的档口上的菜不再进厨房（照常挂账）；档口不删除，历史出品单照常显示。</p>
      {stations.length === 0 ? (
        <p className="mt-4 rounded-lg border border-dashed border-line-strong px-4 py-8 text-center text-[13px] text-ink-3">还没有档口。{editable ? '点「新建档口」，例如「热菜」「水吧」。' : ''}</p>
      ) : (
        <ul className="mt-3 divide-y divide-line/70 rounded-lg border border-line">
          {stations.map((s) => (
            <li key={s.id} className={cn('flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2.5', !s.active && 'bg-paper-2/50 opacity-70')} data-testid={`dining-station-${s.name}`}>
              <span className="min-w-[96px] flex-1 text-[14.5px] font-bold">{s.name}</span>
              <span className="text-[12.5px] text-ink-3">{s.itemCount} 道菜</span>
              <span className="num text-[12px] text-ink-4">排序 {s.sortOrder}</span>
              {!s.active && <Badge tone="clay">已停用</Badge>}
              {editable && (
                <Button size="sm" variant="ghost" onClick={() => setEditing(s)}>
                  编辑
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      <StationDialog target={editing} onClose={() => setEditing(null)} />
    </Card>
  );
}

function StationDialog({ target, onClose }: { target: KitchenStation | 'new' | null; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [name, setName] = useState('');
  const [sortOrder, setSortOrder] = useState('0');
  const [active, setActive] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [opened, setOpened] = useState<typeof target>(null);
  if (target !== opened) {
    setOpened(target);
    setName(target && target !== 'new' ? target.name : '');
    setSortOrder(target && target !== 'new' ? String(target.sortOrder) : '0');
    setActive(target && target !== 'new' ? target.active : true);
    setError(null);
  }
  const order = Number(sortOrder);
  const ok = name.trim().length >= 1 && name.trim().length <= MAX_STATION_NAME && Number.isInteger(order) && order >= 0 && order <= 9999;

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const body = { name: name.trim(), sortOrder: order, active };
      const next = target === 'new' ? await api.post<DiningAdmin>('/api/admin/dining/stations', body) : await api.put<DiningAdmin>(`/api/admin/dining/stations/${target!.id}`, body);
      qc.setQueryData(adminKey, next);
      void qc.invalidateQueries({ queryKey: ['dining'] });
      toast({ tone: 'success', title: target === 'new' ? `已新建档口「${body.name}」` : '档口已保存' });
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={!!target}
      onClose={busy ? () => {} : onClose}
      title={target === 'new' ? '新建出品档口' : '编辑出品档口'}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button variant="primary" loading={busy} disabled={!ok} onClick={save} data-testid="dining-station-save">
            保存
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="档口名称" htmlFor="station-name" hint={`最多 ${MAX_STATION_NAME} 字，例如 热菜、凉菜、水吧`}>
          <Input id="station-name" value={name} maxLength={MAX_STATION_NAME} onChange={(e) => setName(e.target.value)} data-autofocus data-testid="dining-station-name" />
        </Field>
        <Field label="排序" htmlFor="station-order" hint="小的排前面（厨房屏、点单页的顺序）">
          <Input id="station-order" type="number" inputMode="numeric" min={0} max={9999} value={sortOrder} onChange={(e) => setSortOrder(e.target.value)} className="num w-28" />
        </Field>
        {target !== 'new' && (
          <Segmented
            ariaLabel="档口状态"
            value={active ? 'on' : 'off'}
            onChange={(v) => setActive(v === 'on')}
            options={[
              { value: 'on', label: '启用' },
              { value: 'off', label: '停用' },
            ]}
          />
        )}
        {error && <Notice tone="error" title={error} />}
      </div>
    </Dialog>
  );
}

/** 按分类分组（价目里没写分类的归「其他」） */
function byCategory<T extends { category: string }>(list: T[]): [string, T[]][] {
  const map = new Map<string, T[]>();
  for (const i of list) map.set(i.category || '其他', [...(map.get(i.category || '其他') ?? []), i]);
  return [...map];
}

/**
 * 菜品挂在哪个档口：只列挂了档口的菜；价目里的其他项目收在「从价目里添加菜品」里，可按名称、分类搜。
 * 需要技师的项目（按摩、搓澡……）不进厨房，两处都不列出（店主 2026-10-30：这里不该看到按摩）。
 */
function ItemsCard() {
  const can = useCan();
  const qc = useQueryClient();
  const toast = useToast();
  const admin = useDiningAdmin();
  const [draft, setDraft] = useState<Map<number, number | null>>(new Map());
  /** 点单分类（8.1.7）：改了的菜 → 分类的编码，null 为「按默认」 */
  const [slotDraft, setSlotDraft] = useState<Map<number, string | null>>(new Map());
  const [adding, setAdding] = useState(false);
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!admin.data) return <Skeleton className="h-56" />;
  type Item = DiningAdmin['items'][number];
  const editable = can('catalog.manage');
  const stations = admin.data.stations;
  const items = admin.data.items.filter((i) => !i.technicianRequired);
  // 8.1.39（R4）：点单分类按后台设的小分类
  const outlets = diningOutletsOf(admin.data.rules);
  const slotOptions = allDiningSlots(outlets);
  const value = (i: Item) => (draft.has(i.id) ? draft.get(i.id)! : i.stationId);
  const choose = (i: Item, stationId: number | null) => {
    const next = new Map(draft);
    if (stationId === i.stationId) next.delete(i.id);
    else next.set(i.id, stationId);
    setDraft(next);
  };
  const chooseAll = (list: Item[], stationId: number | null) => {
    const next = new Map(draft);
    for (const i of list) {
      if (stationId === i.stationId) next.delete(i.id);
      else next.set(i.id, stationId);
    }
    setDraft(next);
  };
  // 菜：已挂档口的，加上这次刚挂上、还没保存的；刚改成「不进厨房」的保存之前仍留在这里
  const dishes = items.filter((i) => i.stationId !== null || value(i) !== null);
  const rest = items.filter((i) => i.stationId === null && value(i) === null);
  const q = query.trim().toLowerCase();
  const found = q ? rest.filter((i) => i.name.toLowerCase().includes(q) || i.category.toLowerCase().includes(q)) : rest;
  // 点单分类（8.1.7，CF2、CF3）：设过的是 slotKey，没设的是 null（按默认归，默认算法与服务端同一个）
  const storedSlot = (i: Item) => (i.slotAssigned ? slotKey(i.slot) : null);
  const slotValue = (i: Item) => (slotDraft.has(i.id) ? slotDraft.get(i.id)! : storedSlot(i));
  const defaultSlot = (i: Item) => {
    const sid = value(i);
    return diningSlotOf({ outlet: null, group: '', category: i.category, stationName: stations.find((s) => s.id === sid)?.name ?? null }, outlets);
  };
  const chooseSlot = (i: Item, v: string | null, into = new Map(slotDraft)) => {
    if (v === storedSlot(i)) into.delete(i.id);
    else into.set(i.id, v);
    return into;
  };
  const stationChanged = (i: Item) => draft.has(i.id) && draft.get(i.id) !== i.stationId;
  const slotChanged = (i: Item) => slotDraft.has(i.id) && slotDraft.get(i.id) !== storedSlot(i);
  const changes = items.filter((i) => stationChanged(i) || slotChanged(i));
  const options = [{ value: '', label: '不进厨房' }, ...stations.map((s) => ({ value: String(s.id), label: s.active ? s.name : `${s.name}（已停用）` }))];

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const next = await api.put<DiningAdmin>('/api/admin/dining/items', {
        items: changes.map((i) => ({ id: i.id, ...(stationChanged(i) ? { stationId: draft.get(i.id)! } : {}), ...(slotChanged(i) ? { slot: slotDraft.get(i.id)! } : {}) })),
      });
      qc.setQueryData(adminKey, next);
      setDraft(new Map());
      setSlotDraft(new Map());
      void qc.invalidateQueries({ queryKey: ['dining'] });
      toast({ tone: 'success', title: '菜品的出品档口与点单分类已保存' });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  /** 按分类分组的项目，每项选档口；prefix 区分上面的菜品与「从价目里添加菜品」里的项目 */
  const groups = (list: Item[], prefix: 'dining-items' | 'dining-candidates') => (
    <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2">
      {byCategory(list).map(([cat, group]) => (
        <div key={cat} className="rounded-lg border border-line" data-testid={`${prefix}-${cat}`}>
          <div className="flex flex-wrap items-center gap-2 border-b border-line/70 bg-paper-2/60 px-3 py-2">
            <span className="min-w-0 flex-1 basis-full truncate text-[13.5px] font-bold sm:basis-auto">{cat}</span>
            {editable && stations.length > 0 && (
              <Select
                value=""
                onChange={(e) => {
                  const v = e.target.value;
                  if (v !== '') chooseAll(group, v === 'none' ? null : Number(v));
                }}
                fullWidth={false}
                className="text-[12.5px]"
                aria-label={`${cat} 整类设为`}
                data-testid={`${prefix}-all-${cat}`}
              >
                <option value="">整类设为…</option>
                {prefix === 'dining-items' && <option value="none">不进厨房</option>}
                {stations
                  .filter((s) => s.active)
                  .map((s) => (
                    <option key={s.id} value={String(s.id)}>
                      {s.name}
                    </option>
                  ))}
              </Select>
            )}
            {editable && prefix === 'dining-items' && (
              <Select
                value=""
                onChange={(e) => {
                  const v = e.target.value;
                  if (v === '') return;
                  let next = new Map(slotDraft);
                  for (const i of group) next = chooseSlot(i, v === 'default' ? null : v, next);
                  setSlotDraft(next);
                }}
                fullWidth={false}
                className="text-[12.5px]"
                aria-label={`${cat} 整类的点单分类设为`}
                data-testid={`${prefix}-slot-all-${cat}`}
              >
                <option value="">点单分类设为…</option>
                {slotOptions.map((sl) => (
                  <option key={slotKey(sl)} value={slotKey(sl)}>
                    {slotLabel(sl)}
                  </option>
                ))}
                <option value="default">按默认</option>
              </Select>
            )}
          </div>
          <ul className="divide-y divide-line/60">
            {group.map((i) => {
              const v = value(i);
              return (
                <li key={i.id} className="flex flex-wrap items-center gap-x-2 gap-y-1 px-3 py-1.5" data-testid={`dining-item-${i.name}`}>
                  <span className="min-w-0 flex-1 basis-28 truncate text-[13.5px] font-semibold">{i.name}</span>
                  {(stationChanged(i) || slotChanged(i)) && <Badge tone="lake">未保存</Badge>}
                  <Money cents={i.price} className="text-[12px] text-ink-3" />
                  {/* 手持点单机、手机上两个下拉占满一行；平板、电脑上排在菜名后面 */}
                  <div className="flex w-full gap-2 sm:w-auto">
                    <Select
                      value={v === null ? '' : String(v)}
                      disabled={!editable || stations.length === 0}
                      onChange={(e) => choose(i, e.target.value === '' ? null : Number(e.target.value))}
                      fullWidth={false}
                      className="min-w-0 flex-1 text-[13px] sm:w-32 sm:flex-none"
                      aria-label={`${i.name} 的出品档口`}
                      data-testid={`dining-item-station-${i.name}`}
                    >
                      {options.map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </Select>
                    {/* 点单分类（8.1.7）：进厨房的菜才有；没设的按默认归，写明默认归哪 */}
                    {prefix === 'dining-items' && v !== null && (
                      <Select
                        value={slotValue(i) ?? ''}
                        disabled={!editable}
                        onChange={(e) => setSlotDraft(chooseSlot(i, e.target.value === '' ? null : e.target.value))}
                        fullWidth={false}
                        className="min-w-0 flex-1 text-[13px] sm:w-36 sm:flex-none"
                        aria-label={`${i.name} 的点单分类`}
                        data-testid={`dining-item-slot-${i.name}`}
                      >
                        <option value="">默认（{slotLabel(defaultSlot(i))}）</option>
                        {slotOptions.map((sl) => (
                          <option key={slotKey(sl)} value={slotKey(sl)}>
                            {slotLabel(sl)}
                          </option>
                        ))}
                      </Select>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </div>
  );

  return (
    <Card className="p-5" data-testid="dining-items">
      <SectionTitle aside={!editable && <Badge>能管理价目的岗位可改</Badge>}>菜品送到哪个档口、在点单页的哪里</SectionTitle>
      <p className="mt-1 text-[12.5px] text-ink-3">
        挂了档口的项目就是菜：点单页能点，前台「加项目」点了也一样进厨房，账单上记在「餐饮」。价目里的其他项目（门票、洗浴用品、按摩等）不用挂，照常挂账、不进厨房，这里不列出。
        每道菜另选「点单分类」：点单页先选餐厅、水吧、果吧再点，沽清列表、台账、退菜记录也按它分；没选的按默认归（价目分类、出品档口的名字），不改价目表的分类。
        {stations.length === 0 && ' 请先在上面建档口。'}
      </p>
      <PriceSheetLink sheet="dish" className="mt-2" />
      {dishes.length === 0 ? (
        <p className="mt-4 rounded-lg border border-dashed border-line-strong px-4 py-6 text-center text-[13px] text-ink-3" data-testid="dining-items-empty">
          还没有菜品。
          {editable && '点下面「从价目里添加菜品」，把价目里的菜挂到档口；价目里还没有的菜，先在后台「价目与套餐」里新建（分类写「热菜」「饮品」等）。'}
        </p>
      ) : (
        groups(dishes, 'dining-items')
      )}
      {editable && (
        <div className="mt-4">
          <Button size="sm" variant="secondary" icon={<Plus className="size-4" />} onClick={() => setAdding((a) => !a)} aria-expanded={adding} data-testid="dining-items-add">
            从价目里添加菜品{rest.length > 0 && `（${rest.length} 项可选）`}
          </Button>
          {adding && (
            <div className="mt-3 rounded-lg border border-line p-3" data-testid="dining-items-candidates">
              <p className="text-[12.5px] text-ink-3">
                价目里还没挂档口的项目（需要技师的项目不进厨房，不列出）。给菜选一个档口，它就移到上面的菜品里，点「保存」后生效。价目里没有的菜，先在后台
                <Link to={ADMIN_SECTIONS.catalog.path} className="font-semibold text-pine hover:underline">
                  「价目与套餐」
                </Link>
                里新建。
              </p>
              {rest.length > 0 && (
                <Input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="按名称或分类搜，例如 鸡、饮品"
                  aria-label="按名称或分类搜价目里的项目"
                  className="mt-2"
                  data-testid="dining-items-search"
                />
              )}
              {stations.length === 0 ? (
                <p className="mt-3 text-[13px] text-ink-3">请先在上面建档口。</p>
              ) : found.length === 0 ? (
                <p className="mt-3 text-[13px] text-ink-3">{rest.length === 0 ? '价目里没有可以挂档口的项目了。' : '没有找到这个名称或分类的项目。'}</p>
              ) : (
                groups(found, 'dining-candidates')
              )}
            </div>
          )}
        </div>
      )}
      {error && <Notice tone="error" title={error} className="mt-3" />}
      {editable && (
        <div className="mt-3 flex flex-wrap items-center justify-end gap-3">
          {changes.length > 0 && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setDraft(new Map());
                setSlotDraft(new Map());
              }}
            >
              放弃修改
            </Button>
          )}
          <Button variant="primary" loading={busy} disabled={changes.length === 0} onClick={save} data-testid="dining-items-save">
            保存{changes.length ? `（${changes.length} 道）` : ''}
          </Button>
        </div>
      )}
    </Card>
  );
}

/** 桌台：不洗浴的客人在桌台上用餐（开台、点单、单独结账）。按区域分组显示在餐饮「桌台」页 */
function TablesCard() {
  const can = useCan();
  const tables = useTablesAdmin();
  const [editing, setEditing] = useState<DiningTable | 'new' | null>(null);
  if (!tables.data) return <Skeleton className="h-40" />;
  const editable = can('catalog.manage');
  const list = tables.data.tables;
  return (
    <Card className="p-5" data-testid="dining-tables">
      <SectionTitle
        aside={
          editable && (
            <Button size="sm" variant="secondary" icon={<Plus className="size-4" />} onClick={() => setEditing('new')} data-testid="dining-table-new">
              新建桌台
            </Button>
          )
        }
      >
        桌台
      </SectionTitle>
      <p className="mt-1 text-[12.5px] text-ink-3">
        不洗浴的客人（只来吃饭）在桌台上开台、点单，单独结账；洗浴客人的菜照常挂在手牌上。可按区域分组（大厅、包间……）。正在用餐的桌不能停用；桌台不删除，历史结账单照常显示桌号。
      </p>
      {list.length === 0 ? (
        <p className="mt-4 rounded-lg border border-dashed border-line-strong px-4 py-8 text-center text-[13px] text-ink-3">还没有桌台。{editable ? '点「新建桌台」，例如「A1」「包间 1」。' : ''}</p>
      ) : (
        <ul className="mt-3 divide-y divide-line/70 rounded-lg border border-line">
          {list.map((t) => (
            <li key={t.id} className={cn('flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2.5', !t.active && 'bg-paper-2/50 opacity-70')} data-testid={`dining-table-${t.name}`}>
              <span className="num min-w-[72px] text-[14.5px] font-bold">{t.name}</span>
              <span className="min-w-0 flex-1 truncate text-[12.5px] text-ink-3">
                {t.area || '不分区'} · {t.seats} 座{t.minSpend ? ` · 低消 ${formatYuan(t.minSpend)}` : ''}
                {t.serviceFeeBp ? ` · ${serviceFeeText(t.serviceFeeBp)}` : t.serviceFeeBp === 0 ? ' · 不收服务费' : ''}
                {(() => {
                  const rt = tables.data.roomTypes.find((r) => r.id === t.roomTypeId);
                  return rt ? ` · 包房 ${rt.name}（${roomTypeText(rt)}）` : '';
                })()}
              </span>
              <span className="text-[12px] text-ink-4">开台 {t.sessionCount} 次</span>
              <span className="num text-[12px] text-ink-4">排序 {t.sortOrder}</span>
              {!t.active && <Badge tone="clay">已停用</Badge>}
              {editable && (
                <Button size="sm" variant="ghost" onClick={() => setEditing(t)}>
                  编辑
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      <TableDialog target={editing} roomTypes={tables.data.roomTypes} onClose={() => setEditing(null)} />
    </Card>
  );
}

function TableDialog({ target, roomTypes, onClose }: { target: DiningTable | 'new' | null; roomTypes: TablesAdmin['roomTypes']; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [name, setName] = useState('');
  const [area, setArea] = useState('');
  const [seats, setSeats] = useState('4');
  const [sortOrder, setSortOrder] = useState('0');
  const [active, setActive] = useState(true);
  /** 8.1.39：低消（元）、服务费（%） */
  const [minSpend, setMinSpend] = useState('');
  const [feePct, setFeePct] = useState('');
  /** 8.2.4：包房的房型（空为不是包房） */
  const [roomTypeId, setRoomTypeId] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [opened, setOpened] = useState<typeof target>(null);
  if (target !== opened) {
    setOpened(target);
    const t = target && target !== 'new' ? target : null;
    setName(t?.name ?? '');
    // 新桌默认「散桌」（8.1.7，CF5）
    setArea(t ? t.area : TABLE_ZONES[0]);
    setSeats(String(t?.seats ?? 4));
    setSortOrder(String(t?.sortOrder ?? 0));
    setActive(t?.active ?? true);
    setMinSpend(t?.minSpend ? centsToInput(t.minSpend) : '');
    // 8.2.4：空着为跟门店默认，填 0 为这张桌不收
    setFeePct(t?.serviceFeeBp === null || t?.serviceFeeBp === undefined ? '' : String(t.serviceFeeBp / 100));
    setRoomTypeId(t?.roomTypeId ?? null);
    setError(null);
  }
  const minSpendCents = minSpend.trim() ? parseYuan(minSpend) : 0;
  const feeBp = feePct.trim() ? Math.round(Number(feePct) * 100) : null;
  const chargesOk = minSpendCents !== null && minSpendCents >= 0 && (feeBp === null || (Number.isFinite(feeBp) && feeBp >= 0 && feeBp <= MAX_SERVICE_FEE_BP));
  const seatNum = Number(seats);
  const order = Number(sortOrder);
  const ok =
    name.trim().length >= 1 &&
    name.trim().length <= MAX_TABLE_NAME &&
    area.trim().length <= MAX_TABLE_AREA &&
    Number.isInteger(seatNum) &&
    seatNum >= 1 &&
    seatNum <= 99 &&
    Number.isInteger(order) &&
    order >= 0 &&
    order <= 9999 &&
    chargesOk;

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const body = { name: name.trim(), area: area.trim(), seats: seatNum, sortOrder: order, active, minSpend: minSpendCents ?? 0, serviceFeeBp: feeBp, roomTypeId };
      const next = target === 'new' ? await api.post<TablesAdmin>('/api/admin/dining/tables', body) : await api.put<TablesAdmin>(`/api/admin/dining/tables/${target!.id}`, body);
      qc.setQueryData(tablesAdminKey, next);
      void qc.invalidateQueries({ queryKey: ['dining'] });
      toast({ tone: 'success', title: target === 'new' ? `已新建桌台「${body.name}」` : '桌台已保存' });
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={!!target}
      onClose={busy ? () => {} : onClose}
      title={target === 'new' ? '新建桌台' : '编辑桌台'}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button variant="primary" loading={busy} disabled={!ok} onClick={save} data-testid="dining-table-save">
            保存
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="桌号" htmlFor="table-name" hint={`最多 ${MAX_TABLE_NAME} 字，例如 A1、包间 1`}>
          <Input id="table-name" value={name} maxLength={MAX_TABLE_NAME} onChange={(e) => setName(e.target.value)} data-autofocus data-testid="dining-table-name" />
        </Field>
        <Field label="分区" htmlFor="table-area" hint="桌台页上面一排分区卡片，点一个只看这个区的桌（8.1.7）">
          <Select id="table-area" value={area} onChange={(e) => setArea(e.target.value)} data-testid="dining-table-area">
            {TABLE_ZONES.map((z) => (
              <option key={z} value={z}>
                {z}
              </option>
            ))}
            {/* 原来写了别的区域的桌：照旧能留着，改了以后就不再出现（CF5） */}
            {opened && opened !== 'new' && opened.area && !(TABLE_ZONES as readonly string[]).includes(opened.area) && <option value={opened.area}>{opened.area}（原区域）</option>}
            <option value="">不分区</option>
          </Select>
        </Field>
        <div className="flex flex-wrap gap-4">
          <Field label="座位" htmlFor="table-seats" hint="1–99，开台时人数默认按座位数">
            <Input id="table-seats" type="number" inputMode="numeric" min={1} max={99} value={seats} onChange={(e) => setSeats(e.target.value)} className="num w-28" data-testid="dining-table-seats" />
          </Field>
          <Field label="排序" htmlFor="table-order" hint="小的排前面">
            <Input id="table-order" type="number" inputMode="numeric" min={0} max={9999} value={sortOrder} onChange={(e) => setSortOrder(e.target.value)} className="num w-28" />
          </Field>
        </div>
        {/* 8.1.39（docs/V8139.md 第 3 节）：包房的低消与服务费；空着为不设 */}
        <div className="flex flex-wrap gap-4">
          <Field label="包房房型" htmlFor="table-room-type" hint="挂了房型就是包房：低消按房型，服务费跟门店默认">
            <Select id="table-room-type" value={roomTypeId ?? ''} onChange={(e) => setRoomTypeId(Number(e.target.value) || null)} className="w-44" data-testid="dining-table-room-type">
              <option value="">不是包房</option>
              {roomTypes
                .filter((r) => r.active || r.id === roomTypeId)
                .map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                    {r.active ? '' : '（停用）'}
                  </option>
                ))}
            </Select>
          </Field>
        </div>
        <div className="flex flex-wrap gap-4">
          <Field label="低消（元）" htmlFor="table-min-spend" hint="桌台自己设的优先于房型；菜钱不到低消不能直接结账：补足低消、返台再点或先转挂账；空着为不设">
            <MoneyInput id="table-min-spend" value={minSpend} onChange={(e) => setMinSpend(e.target.value)} className="w-36" data-testid="dining-table-min-spend" />
          </Field>
          <Field label="服务费（%）" htmlFor="table-fee" hint="结账时按没赠送、没退的菜算；空着为跟门店默认，填 0 为不收，最多 30">
            <Input id="table-fee" inputMode="decimal" value={feePct} onChange={(e) => setFeePct(e.target.value)} className="num w-28" data-testid="dining-table-fee" />
          </Field>
        </div>
        {target !== 'new' && (
          <Segmented
            ariaLabel="桌台状态"
            value={active ? 'on' : 'off'}
            onChange={(v) => setActive(v === 'on')}
            options={[
              { value: 'on', label: '启用' },
              { value: 'off', label: '停用' },
            ]}
          />
        )}
        {error && <Notice tone="error" title={error} />}
      </div>
    </Dialog>
  );
}
