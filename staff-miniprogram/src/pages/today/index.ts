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
import { MEAL_LABELS, isMealCode, loadMealKey, loadMenus, mealNow, mealWindowText, patrolCodeOf, patrolDay, refreshMealKey } from '../../utils/canteen';
import { dayLabel, greeting, initialOf, shortTime, storeClock } from '../../utils/format';
import { requireMe, toLogin } from '../../utils/guard';
import { loadPending } from '../../utils/pending';
import { hasPatrolLink, patrolView, savePatrolLink } from '../../utils/patrol';
import { largeTextOn } from '../../utils/prefs';
import type { MealNow, PatrolNow, TodayCard, TodoInput, TodoRow } from '../../utils/today';
import { routeScan, shiftLine, todayCard, todoRows } from '../../utils/today';

/** 上次取到的（按员工存在手机上；没信号时先画它） */
interface Snapshot {
  punch: PunchToday | null;
  /** 取到打卡数据时的本机时间（毫秒）：此刻卡按它往前走 */
  punchAt: number;
  patrol: PatrolNow | null;
  meal: MealNow | null;
  menuLine: string;
  todo: TodoInput;
  unread: number;
  notices: { id: number; title: string; time: string; pinned: boolean; unread: boolean }[];
  savedAt: number;
}

const SNAP_KEY = 'wcp_today:';
const EMPTY_TODO: TodoInput = { pendingPunchAt: null, approvalsTodo: 0, ccUnread: 0, missedPunch: false, unsignedPayslips: [] };

let me: StaffMpMe | null = null;
let snap: Snapshot | null = null;
let ticker: number | null = null;
let seq = 0;

const settle = <T>(p: Promise<T>): Promise<{ ok: true; v: T } | { ok: false; e: unknown }> =>
  p.then(
    (v) => ({ ok: true as const, v }),
    (e: unknown) => ({ ok: false as const, e }),
  );

function loadSnap(staffId: number): Snapshot | null {
  try {
    const v = wx.getStorageSync(SNAP_KEY + staffId) as Snapshot | '';
    return v && typeof v.savedAt === 'number' ? v : null;
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
  },

  async onShow() {
    this.setData({ large: largeTextOn() });
    me = await requireMe();
    if (!me) return;
    // 微信扫一扫扫了巡场码打开、要先登录的：登录以后接着去巡场页交
    if (hasPatrolLink() && me.entries.indexOf('patrol') >= 0) {
      wx.navigateTo({ url: '/pages/patrol/index' });
      return;
    }
    this.header(me);
    snap = snap ?? loadSnap(me.staff.id);
    if (snap) this.render(snap, true);
    this.refresh();
    if (ticker === null) ticker = setInterval(() => snap && this.render(snap, this.data.stale), 30000) as unknown as number;
  },

  onHide() {
    if (ticker !== null) clearInterval(ticker);
    ticker = null;
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
    const now = s.punch ? s.punch.now + Math.max(0, Math.floor((Date.now() - s.punchAt) / 60000)) : 0;
    this.setData({
      stale,
      card: todayCard({ punch: s.punch, now, patrol: s.patrol, meal: s.meal }),
      todos: todoRows(s.todo),
      shift: shiftLine(s.punch),
      menuLine: s.menuLine,
      unread: s.unread,
      notices: s.notices,
      hasNotices: s.notices.length > 0,
    });
  },

  /** 各块分头取：取不到的那一块用上次的 */
  async refresh() {
    if (!me) return;
    const m = me;
    const mine = ++seq;
    const has = (k: string) => m.entries.indexOf(k as never) >= 0;
    const today = storeClock().date;
    const skip = Promise.reject(new Error('skip'));
    skip.catch(() => undefined);
    const [punch, summary, unread, payslips, notices, patrol, menus, key] = await Promise.all([
      settle(has('punch') ? call<PunchToday>('GET', '/oa/attendance/today') : skip),
      settle(has('approvals') ? call<ApprovalSummary>('GET', '/oa/approvals/summary') : skip),
      settle(call<{ unread: number }>('GET', '/oa/notifications/unread-count')),
      settle(has('payslips') ? call<MyPayslipItem[]>('GET', '/oa/my/payslips') : skip),
      settle(has('announcements') ? call<OaAnnouncementList>('GET', '/oa/announcements') : skip),
      settle(has('patrol') ? patrolDay() : skip),
      settle(has('canteen') ? loadMenus(today, today) : skip),
      settle(has('canteen') ? refreshMealKey(m.staff.id) : skip),
    ]);
    if (mine !== seq) return;
    // 登录过期（静默重新登录也不行）：去登录页
    const expired = [punch, summary, unread].some((r) => !r.ok && isApiError(r.e) && r.e.status === 401);
    if (expired) return toLogin();
    const prev = snap;
    const anyOk = [punch, summary, unread, payslips, notices, patrol, menus].some((r) => r.ok);

    // 吃饭：此刻在开饭时间里（开饭时间用存着的码钥匙里的，没信号也有）
    const mealKey = key.ok ? key.v : loadMealKey(m.staff.id);
    let meal: MealNow | null = prev ? prev.meal : null;
    let menuLine = prev ? prev.menuLine : '';
    if (mealKey) {
      const c = storeClock(new Date(Date.now() + mealKey.offsetMs));
      const w = mealNow(mealKey.me.meals, `${String(c.hour).padStart(2, '0')}:${String(c.minute).padStart(2, '0')}`);
      const list = menus.ok ? menus.v.filter((x) => x.published && x.date === today) : [];
      const current = w ? list.find((x) => x.meal === w.meal) : undefined;
      meal = w ? { window: mealWindowText(w), dishes: current ? current.dishes.map((d) => d.name) : [] } : null;
      if (menus.ok) {
        const next = current ?? list[0];
        menuLine = next
          ? `${MEAL_LABELS[next.meal] ?? ''}：${next.dishes
              .map((d) => d.name)
              .slice(0, 4)
              .join(' · ')}`
          : '';
      }
    } else if (!has('canteen')) {
      meal = null;
      menuLine = '';
    }

    // 巡场：正在巡的这一轮还没巡的
    let patrolNow: PatrolNow | null = prev ? prev.patrol : null;
    if (patrol.ok) {
      const v = patrolView(patrol.v);
      const missing = patrol.v.currentRound !== null ? v.points.filter((p) => p.state === 'todo').map((p) => p.name) : [];
      patrolNow = missing.length ? { roundText: v.roundText.replace(/ · /, ' '), missing } : null;
    } else if (!has('patrol')) patrolNow = null;

    const pending = loadPending(m.staff.id, 'punch');
    const punchV = punch.ok ? punch.v : prev ? prev.punch : null;
    const todo: TodoInput = {
      pendingPunchAt: pending ? shortTime(new Date(pending.at).toISOString()) : null,
      approvalsTodo: summary.ok ? summary.v.todo : prev ? prev.todo.approvalsTodo : 0,
      ccUnread: summary.ok ? summary.v.ccUnread : prev ? prev.todo.ccUnread : 0,
      missedPunch: !!punchV && punchV.nextPunch.action === 'done' && /缺卡/.test(punchV.nextPunch.detail),
      unsignedPayslips: payslips.ok ? payslips.v.filter((p) => !p.signedAt).map((p) => ({ id: p.id, title: p.title })) : prev ? prev.todo.unsignedPayslips : EMPTY_TODO.unsignedPayslips,
    };
    const next: Snapshot = {
      punch: punchV,
      punchAt: punch.ok ? Date.now() : prev ? prev.punchAt : Date.now(),
      patrol: patrolNow,
      meal,
      menuLine,
      todo,
      unread: unread.ok ? unread.v.unread : prev ? prev.unread : 0,
      notices: notices.ok
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
    this.render(next, !anyOk);
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
          wx.navigateTo({ url: `/pages/canteen-scan/index?code=${encodeURIComponent(route.code)}` });
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
