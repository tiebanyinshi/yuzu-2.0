// 今天（首页，docs/STAFF_MP.md 第 2.2 节）：页头（问候、门店、日期；铃铛、我）→ 此刻卡（只写状态）→ 固定按钮（打卡 · 饭卡码 · 扫一扫）
// → 待办 → 今天（班次、菜）→ 公告。
//   · 先用手机上存的上次内容把页面画出来（标「之前的信息」），再去门店系统取；哪一块取不到只影响那一块；
//   · 此刻卡每 30 秒按本机时钟往前走一次（不重新取），换页回来再取。

import type { PunchToday } from '../../../../src/shared/oa';
import type { ApprovalSummary } from '../../../../src/shared/oa-approval';
import type { MyPayslipItem } from '../../../../src/shared/oa-payroll';
import type { OaAnnouncementList } from '../../../../src/shared/oa';
import type { StaffMpMe } from '../../../../src/shared/staffmp';
import { call, isApiError } from '../../utils/api';
import { canteenStatus, isMealCode, loadMealKey, loadMenus, patrolCodeOf, patrolDay, refreshMealKey } from '../../utils/canteen';
import { dayLabel, greeting, initialOf, shortTime, storeClock } from '../../utils/format';
import { requireMe, toLogin } from '../../utils/guard';
import { loadPending } from '../../utils/pending';
import { hasPatrolLink, patrolView, savePatrolLink } from '../../utils/patrol';
import { largeTextOn } from '../../utils/prefs';
import type { MealWindowLite, PatrolNow, TodayCard, TodoInput, TodoRow } from '../../utils/today';
import { mealOfNow, routeScan, shiftLine, todayCard, todoRows } from '../../utils/today';

/** 上次取到的（按员工存在手机上；没信号时先画它）。存的是原料，每次画都按本机时钟重算 */
interface Snapshot {
  /** 谁的：换了人登录不用上一位的 */
  staffId: number;
  punch: PunchToday | null;
  /** 取到打卡数据时的本机时间（毫秒）：此刻卡按它往前走 */
  punchAt: number;
  patrol: PatrolNow | null;
  /** 开饭时间（存着的码钥匙里的，没信号也有）、手机与门店的时间差 */
  meals: MealWindowLite[];
  offsetMs: number;
  /** 今天各餐已发布的菜（按餐） */
  dishes: Record<string, string[]>;
  dishesDate: string;
  /** 这一餐打过卡没有（门店系统的饭堂状态） */
  mealChecked: { meal: string; date: string; checkedIn: boolean } | null;
  todo: TodoInput;
  unread: number;
  notices: { id: number; title: string; time: string; pinned: boolean; unread: boolean }[];
  savedAt: number;
}

const SNAP_KEY = 'wcp_today:';
/** 页面开着时多久重新取一次（打卡窗口、开饭时间会变） */
const REFRESH_MS = 5 * 60 * 1000;

let me: StaffMpMe | null = null;
let snap: Snapshot | null = null;
let ticker: number | null = null;
let lastFetch = 0;
let seq = 0;
/** 首页每藏起来一次加一：onShow 等「我是谁」回来时核对还是不是同一次显示 */
let visible = 0;

const settle = <T>(p: Promise<T>): Promise<{ ok: true; v: T } | { ok: false; e: unknown }> =>
  p.then(
    (v) => ({ ok: true as const, v }),
    (e: unknown) => ({ ok: false as const, e }),
  );

function loadSnap(staffId: number): Snapshot | null {
  try {
    const v = wx.getStorageSync(SNAP_KEY + staffId) as Snapshot | '';
    return v && typeof v.savedAt === 'number' && v.staffId === staffId && Array.isArray(v.meals) ? v : null;
  } catch {
    return null;
  }
}

function saveSnap(staffId: number, s: Snapshot): void {
  try {
    wx.setStorageSync(SNAP_KEY + staffId, s);
  } catch {
    // 存不下：下次没信号时少一块，不影响这次
  }
}

const pad2 = (n: number) => String(n).padStart(2, '0');

Page({
  data: {
    large: false,
    ready: false,
    stale: false,
    hello: '',
    sub: '',
    initial: '',
    unread: 0,
    card: null as TodayCard | null,
    hasMeal: false,
    todos: [] as TodoRow[],
    shift: '',
    menuLine: '',
    notices: [] as Snapshot['notices'],
    hasNotices: false,
    /** 待办的来源没取到、手机上也没有上一份：不写「都处理完了」 */
    todoUnknown: false,
  },

  async onShow() {
    this.setData({ large: largeTextOn() });
    // 启动时等「我是谁」的这一会儿切去了别的 Tab：回来以后不再在藏起来的首页上起刷新与计时器
    const vis = visible;
    me = await requireMe();
    if (!me || vis !== visible) return;
    // 微信扫一扫扫了巡场码打开、要先登录的：登录以后接着去巡场页交
    if (hasPatrolLink() && me.entries.indexOf('patrol') >= 0) {
      wx.navigateTo({ url: '/pages/patrol/index' });
      return;
    }
    this.header(me);
    // 换了人登录：不用上一位的
    if (!snap || snap.staffId !== me.staff.id) snap = loadSnap(me.staff.id);
    // 先画上次的（不标「之前的信息」：取不到时才标，免得每次切回来闪一下）
    if (snap) this.render(snap, this.data.stale);
    this.refresh();
    if (ticker === null) {
      ticker = setInterval(() => {
        if (Date.now() - lastFetch > REFRESH_MS) this.refresh();
        else if (snap) this.render(snap, this.data.stale);
      }, 30000) as unknown as number;
    }
  },

  onHide() {
    this.stop();
  },

  /** 被 reLaunch 换掉（去登录页、改密码页）时不走 onHide：计时器也要停，不然死掉的这一页还每 5 分钟去取、新开的这一页又起不了计时器 */
  onUnload() {
    this.stop();
  },

  stop() {
    if (ticker !== null) clearInterval(ticker);
    ticker = null;
    // 离开时还在取的不再画（回来再取）
    seq += 1;
    visible += 1;
  },

  async onPullDownRefresh() {
    await this.refresh();
    wx.stopPullDownRefresh();
  },

  header(m: StaffMpMe) {
    this.setData({
      ready: true,
      hello: `${greeting()}，${m.staff.displayName}`,
      sub: `${m.store.name} · ${dayLabel(storeClock().date)}`,
      initial: initialOf(m.staff.displayName),
      hasMeal: m.entries.indexOf('canteen') >= 0,
    });
  },

  render(s: Snapshot, stale: boolean) {
    const today = storeClock().date;
    // 昨天存的打卡数据不拿来画此刻卡（不然会写「已迟到 23 小时」）
    const punch = s.punch && s.punch.today === today ? s.punch : null;
    const now = punch ? punch.now + Math.max(0, Math.floor((Date.now() - s.punchAt) / 60000)) : 0;
    const c = storeClock(new Date(Date.now() + s.offsetMs));
    const food = mealOfNow(s.meals, `${pad2(c.hour)}:${pad2(c.minute)}`, today, s.dishesDate === today ? s.dishes : {}, s.mealChecked);
    this.setData({
      stale,
      card: todayCard({ punch, now, patrol: punch ? s.patrol : null, meal: food.meal }),
      todos: todoRows({ ...s.todo, missedPunch: punch ? s.todo.missedPunch : false }),
      shift: shiftLine(punch),
      menuLine: food.menuLine,
      unread: s.unread,
      notices: s.notices,
      hasNotices: s.notices.length > 0,
    });
  },

  /** 各块分头取：取不到的那一块用上次的；这个人没有的入口那一块是空的 */
  async refresh() {
    if (!me) return;
    const m = me;
    const mine = ++seq;
    lastFetch = Date.now();
    const has = (k: string) => m.entries.indexOf(k as never) >= 0;
    const today = storeClock().date;
    const skip = Promise.reject(new Error('skip'));
    skip.catch(() => undefined);
    const [punch, summary, unread, payslips, notices, patrol, menus, key, status] = await Promise.all([
      settle(has('punch') ? call<PunchToday>('GET', '/oa/attendance/today') : skip),
      settle(has('approvals') ? call<ApprovalSummary>('GET', '/oa/approvals/summary') : skip),
      settle(call<{ unread: number }>('GET', '/oa/notifications/unread-count')),
      settle(has('payslips') ? call<MyPayslipItem[]>('GET', '/oa/my/payslips') : skip),
      settle(has('announcements') ? call<OaAnnouncementList>('GET', '/oa/announcements') : skip),
      settle(has('patrol') ? patrolDay() : skip),
      settle(has('canteen') ? loadMenus(today, today) : skip),
      settle(has('canteen') ? refreshMealKey(m.staff.id) : skip),
      settle(has('canteen') ? canteenStatus() : skip),
    ]);
    if (mine !== seq || !me || me.staff.id !== m.staff.id) return;
    // 登录过期（静默重新登录也不行）：去登录页
    const expired = [punch, summary, unread].some((r) => !r.ok && isApiError(r.e) && r.e.status === 401);
    if (expired) return toLogin();
    // 上一份只在是这个人的时候拿来补取不到的块
    const prev = snap && snap.staffId === m.staff.id ? snap : null;
    const anyOk = [punch, summary, unread, payslips, notices, patrol, menus].some((r) => r.ok);
    // 这个人有的那几块里有没取到的：标「之前的信息」（一块取到不能当成整页都是新的）；
    // 待办的来源没取到、手机上也没有上一份的：不写「都处理完了」
    // 饭卡还没对上、饭堂没开：菜单本来就取不到（回「还没对上饭卡」「饭堂还没开张」），不算没取到
    const menusExpected = has('canteen') && (!status.ok || (status.v.open && status.v.linked));
    const parts: [boolean, { ok: boolean }][] = [
      [has('punch'), punch],
      [has('approvals'), summary],
      [true, unread],
      [has('payslips'), payslips],
      [has('announcements'), notices],
      [has('patrol'), patrol],
      [menusExpected, menus],
      [has('canteen'), status],
    ];
    const someFailed = parts.some(([entry, r]) => entry && !r.ok);
    const todoUnknown = !prev && [[has('punch'), punch] as const, [has('approvals'), summary] as const, [has('payslips'), payslips] as const].some(([entry, r]) => entry && !r.ok);
    /** 这一块：有入口取到了用新的，取不到用上次的，没有入口就是空的 */
    const pick = <T>(entry: boolean, r: { ok: true; v: T } | { ok: false; e: unknown }, fromPrev: (p: Snapshot) => T, empty: T): T => (!entry ? empty : r.ok ? r.v : prev ? fromPrev(prev) : empty);

    const canteen = has('canteen');
    const mealKey = key.ok ? key.v : canteen ? loadMealKey(m.staff.id) : null;
    // 饭卡没对上、被解开：没有开饭时间与菜
    const linked = !status.ok || status.v.linked;
    const dishes: Record<string, string[]> = {};
    if (menus.ok) for (const x of menus.v) if (x.published && x.date === today) dishes[x.meal] = x.dishes.map((d) => d.name);

    let patrolNow: PatrolNow | null = null;
    if (has('patrol')) {
      if (patrol.ok) {
        const v = patrolView(patrol.v);
        const missing = patrol.v.currentRound !== null ? v.points.filter((p) => p.state === 'todo').map((p) => p.name) : [];
        patrolNow = missing.length ? { roundText: v.roundText.replace(/ · /, ' '), missing } : null;
      } else if (prev) patrolNow = prev.patrol;
    }

    const pending = loadPending(m.staff.id, 'punch');
    const punchV = pick<PunchToday | null>(has('punch'), punch, (p) => p.punch, null);
    const sum = pick<ApprovalSummary>(has('approvals'), summary, (p) => ({ todo: p.todo.approvalsTodo, ccUnread: p.todo.ccUnread }), { todo: 0, ccUnread: 0 });
    const todo: TodoInput = {
      pendingPunchAt: pending ? shortTime(new Date(pending.at).toISOString()) : null,
      approvalsTodo: sum.todo,
      ccUnread: sum.ccUnread,
      missedPunch: !!punchV && punchV.nextPunch.action === 'done' && /缺卡/.test(punchV.nextPunch.detail),
      unsignedPayslips: !has('payslips') ? [] : payslips.ok ? payslips.v.filter((p) => !p.signedAt).map((p) => ({ id: p.id, title: p.title })) : prev ? prev.todo.unsignedPayslips : [],
    };
    const next: Snapshot = {
      staffId: m.staff.id,
      punch: punchV,
      punchAt: punch.ok ? Date.now() : prev ? prev.punchAt : Date.now(),
      patrol: patrolNow,
      meals: canteen && linked && mealKey ? mealKey.me.meals : [],
      offsetMs: mealKey ? mealKey.offsetMs : 0,
      dishes: canteen && linked ? (menus.ok ? dishes : prev ? prev.dishes : {}) : {},
      dishesDate: menus.ok ? today : prev ? prev.dishesDate : '',
      mealChecked: canteen && status.ok ? status.v.currentMeal : prev ? prev.mealChecked : null,
      todo,
      unread: unread.ok ? unread.v.unread : prev ? prev.unread : 0,
      notices: !has('announcements')
        ? []
        : notices.ok
          ? notices.v.items
              .slice()
              .sort((a, b) => (a.pinned === b.pinned ? b.publishedAt.localeCompare(a.publishedAt) : a.pinned ? -1 : 1))
              .slice(0, 3)
              .map((n) => ({ id: n.id, title: n.title, time: shortTime(n.publishedAt), pinned: n.pinned, unread: !n.readAt }))
          : prev
            ? prev.notices
            : [],
      savedAt: Date.now(),
    };
    snap = next;
    if (anyOk) saveSnap(m.staff.id, next);
    this.setData({ todoUnknown });
    this.render(next, someFailed);
  },

  onGo(e: WechatMiniprogram.BaseEvent) {
    const page = String(e.currentTarget.dataset.page || '');
    if (page) wx.navigateTo({ url: page });
  },

  onBell() {
    wx.navigateTo({ url: '/pages/notifications/index' });
  },

  onMe() {
    wx.switchTab({ url: '/pages/me/index' });
  },

  onPunch() {
    wx.navigateTo({ url: '/pages/punch/index' });
  },

  onMeal() {
    wx.navigateTo({ url: '/pages/meal/index' });
  },

  /** 扫一扫（第 2.6 节）：只从相机；巡场码去巡场、饭卡码去负责人登记，认不出的说清楚 */
  onScan() {
    if (!me) return;
    const m = me;
    wx.scanCode({
      onlyFromCamera: true,
      scanType: ['qrCode'],
      success: (r) => {
        const route = routeScan(r.result || '', { patrol: m.entries.indexOf('patrol') >= 0, canteenScan: m.entries.indexOf('canteenScan') >= 0 }, { patrol: patrolCodeOf, isMeal: isMealCode });
        if (route.kind === 'patrol') {
          savePatrolLink(route.code, 'scan');
          wx.navigateTo({ url: '/pages/patrol/index' });
        } else if (route.kind === 'meal') {
          // 带上扫到的时刻：负责人扫码页要先取码钥匙，按扫的时刻算这一餐（快到收餐时扫的不会因为取钥匙慢了被当成不在开饭时间）
          wx.navigateTo({ url: `/pages/canteen-scan/index?code=${encodeURIComponent(route.code)}&at=${Date.now()}` });
        } else {
          wx.showToast({ title: route.message, icon: 'none' });
        }
      },
    });
  },

  onNotice(e: WechatMiniprogram.BaseEvent) {
    wx.navigateTo({ url: `/pages/announcement/index?id=${e.currentTarget.dataset.id}` });
  },

  onAllNotices() {
    wx.navigateTo({ url: '/pages/announcements/index' });
  },

  onShift() {
    wx.navigateTo({ url: '/pages/schedule/index' });
  },

  onMenu() {
    wx.navigateTo({ url: '/pages/menu/index' });
  },
});
