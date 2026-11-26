// 门店主导航按业务域分组（8.1.15，《浴族系统需求汇总》系统整体，docs/YUZU_REQ_V8115.md 3.G）：
// 七组的顺序与名字、每个页面在哪一组、按权限与功能开关筛、地址属于哪一组；ERP「返回门店」回到哪一页照旧。
import { describe, expect, it } from 'vitest';
import type { Permission } from '../src/shared/permissions';
import { storeDomainOf, storePageOf, visibleStoreNav } from '../src/client/components/storeNav';

type Session = Parameters<typeof visibleStoreNav>[1];

function session(over: Partial<{ technicians: boolean; dining: boolean; rooms: boolean; permissions: Permission[] }> = {}): Session {
  return { technicians: true, dining: true, rooms: true, permissions: [], ...over } as unknown as Session;
}

const OWNER: Permission[] = [
  'frontdesk.read',
  'frontdesk.operate',
  'frontdesk.checkout',
  'booking.manage',
  'dining.order',
  'room.operate',
  'technician.dispatch',
  'member.read',
  'customer.read',
  'concierge.read',
  'ledger.readToday',
  'device.view',
  'guide.view',
  'settings.manage',
];
const canOf = (perms: Permission[]) => (p: Permission) => perms.includes(p);

describe('主导航的业务域', () => {
  it('七组按需求的顺序：前台、餐饮、房态、技师、会员、财务、设置；每页在对的组里', () => {
    const nav = visibleStoreNav(canOf(OWNER), session({ permissions: OWNER }));
    expect(nav.map((d) => d.label)).toEqual(['前台', '餐饮', '房态', '技师', '会员', '财务', '设置']);
    const where = Object.fromEntries(nav.flatMap((d) => d.items.map((i) => [i.label, d.label])));
    expect(where).toMatchObject({
      发卡台: '前台',
      收银台: '前台',
      // 柜况（8.1.49）：能看在店手牌的都有
      柜况: '前台',
      预约: '前台',
      餐饮: '餐饮',
      房态中心: '房态',
      钟房: '技师',
      会员: '会员',
      客户部: '会员',
      管家: '会员',
      流水: '财务',
      日结: '财务',
      交班: '财务',
      设备: '设置',
      导览: '设置',
      'CRM 设置': '设置',
    });
  });

  it('功能没开、没有权限的入口不显示，空了的组整组不显示', () => {
    const off = visibleStoreNav(canOf(OWNER), session({ technicians: false, dining: false, rooms: false, permissions: OWNER }));
    // 房态中心（8.1.16）不看客房功能开没开：技师服务的房间、派对房、大厅都在里面
    expect(off.map((d) => d.label)).toEqual(['前台', '房态', '会员', '财务', '设置']);
    expect(off.find((d) => d.label === '房态')!.items.map((i) => i.label)).toEqual(['房态中心']);
    // 只管打扫的后勤：房态这一组只有房态中心（原来的「客房」页并进来了）
    const housekeep: Permission[] = ['room.housekeep'];
    expect(visibleStoreNav(canOf(housekeep), session({ permissions: housekeep })).flatMap((d) => d.items.map((i) => i.label))).toEqual(['房态中心']);
    // 后勤（库存、采购、财务也是后勤，都有「客房打扫、维修」）：客房功能没开时没有房态中心，只用 ERP 的人不多出门店入口（CI e2e/inventory.spec.ts）
    expect(visibleStoreNav(canOf(housekeep), session({ rooms: false, permissions: housekeep }))).toEqual([]);
    const kitchen: Permission[] = ['room.housekeep', 'dining.kitchen'];
    expect(visibleStoreNav(canOf(kitchen), session({ rooms: false, dining: false, permissions: kitchen }))).toEqual([]);
    // 钟房、收银的岗位客房功能没开也有
    for (const perm of ['technician.dispatch', 'frontdesk.checkout', 'room.operate'] as Permission[]) {
      const perms: Permission[] = ['room.housekeep', perm];
      expect(visibleStoreNav(canOf(perms), session({ rooms: false, permissions: perms })).flatMap((d) => d.items.map((i) => i.label))).toContain('房态中心');
    }
    expect(storeDomainOf('/crm/room-center')).toBe('rooms');
    expect(storePageOf('/crm/room-center')?.label).toBe('房态中心');
    // 只有管家职责的后勤：会员这一组只剩「管家」，加上所有岗位都能看的导览
    const concierge: Permission[] = ['concierge.read', 'guide.view'];
    const nav = visibleStoreNav(canOf(concierge), session({ permissions: concierge }));
    expect(nav.map((d) => [d.label, d.items.map((i) => i.label)])).toEqual([
      ['会员', ['管家']],
      ['设置', ['导览']],
    ]);
    // 他店查询：没有会员查看权限、有「查会员档阶」的看到「会员查询」，看得到会员的不另显示
    const lookup: Permission[] = ['member.lookup'];
    expect(visibleStoreNav(canOf(lookup), session({ permissions: lookup })).flatMap((d) => d.items.map((i) => i.label))).toEqual(['会员查询']);
    const both: Permission[] = ['member.lookup', 'member.read'];
    expect(visibleStoreNav(canOf(both), session({ permissions: both })).flatMap((d) => d.items.map((i) => i.label))).toEqual(['会员']);
  });

  it('地址属于哪一组：子页面也算；会员工作台只认「/crm」（店主 2026-11-24 起 CRM 在 /crm 下面）；改密码这类不属于任何一组', () => {
    expect(storeDomainOf('/crm/frontdesk')).toBe('frontdesk');
    expect(storeDomainOf('/crm/cashier')).toBe('frontdesk');
    expect(storeDomainOf('/crm/dining/ledger')).toBe('dining');
    expect(storeDomainOf('/crm/settlement/2026-11-19')).toBe('finance');
    expect(storeDomainOf('/crm/concierge/members')).toBe('members');
    expect(storeDomainOf('/crm')).toBe('members');
    expect(storeDomainOf('/crm/password')).toBeNull();
    expect(storeDomainOf('/network')).toBeNull();
    // 没有权限时退回首页用的判断照旧：会员工作台不算
    expect(storePageOf('/crm')).toBeNull();
    expect(storePageOf('/crm/shift')?.label).toBe('交班');
    expect(storePageOf('/admin/studio')?.label).toBe('CRM 设置');
  });

  it('两个台的入口按各自的权限（YB2）；只有菜品权限、进不了餐饮的看到「菜品」（CP7），都在对的组里', () => {
    const cashierOnly: Permission[] = ['frontdesk.read', 'frontdesk.checkout'];
    // 只有结账的：看得到收银台，没有发卡台（结账权限另外还带出餐饮、客房的看账单）
    const cashierItems = visibleStoreNav(canOf(cashierOnly), session({ permissions: cashierOnly })).flatMap((d) => d.items.map((i) => i.label));
    expect(cashierItems).toContain('收银台');
    expect(cashierItems).not.toContain('发卡台');
    // 只有查看的：两个台都看得到（进去只能看），还有只看的柜况（8.1.49）
    const readOnly: Permission[] = ['frontdesk.read'];
    expect(visibleStoreNav(canOf(readOnly), session({ permissions: readOnly })).flatMap((d) => d.items.map((i) => i.label))).toEqual(['发卡台', '收银台', '柜况']);
    const dishesOnly: Permission[] = ['dish.water'];
    const nav = visibleStoreNav(canOf(dishesOnly), session({ permissions: dishesOnly }));
    expect(nav.map((d) => [d.label, d.items.map((i) => i.label)])).toEqual([['餐饮', ['菜品']]]);
    expect(storeDomainOf('/crm/dishes')).toBe('dining');
  });
});

describe('8.1.37：只有「餐饮台账」也进得了餐饮（Codex 审查 f260ca3）', () => {
  it('只给 dining.ledger：主导航有「餐饮」；什么都没有的没有', () => {
    const only = ['dining.ledger'] as Permission[];
    const nav = visibleStoreNav(canOf(only), session({ permissions: only }));
    expect(nav.flatMap((d) => d.items.map((i) => i.to))).toContain('/crm/dining');
    const none = [] as Permission[];
    expect(visibleStoreNav(canOf(none), session({ permissions: none })).flatMap((d) => d.items.map((i) => i.to))).not.toContain('/crm/dining');
  });
});
