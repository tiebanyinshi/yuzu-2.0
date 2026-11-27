// 扫码巡场（巡场部门的人，员工小程序线 E，docs/STAFF_MP.md 第 5.4 节）：点「扫场所码」扫贴在场所的二维码，记一次巡场；
// 也可以直接用微信扫一扫扫场所码打开这一页（扫普通链接二维码，码在启动参数 q 里）。
//   · 规则照巡场原来的：同一个场所同一轮只记一次（回「已经巡过」）；扫到的时间按手机与门店的时间差修正；
//   · 扫到的先存在手机上（存不下就不发），没收到明确结果的留着，之后按原来的操作编号补交（门店系统只收 24 小时内扫到的）。

import type { PatrolCheckinResult } from '../../../../src/shared/patrol';
import { isOffline, messageOf } from '../../utils/api';
import type { MealKey, QueuedScan, ScanOutcome } from '../../utils/canteen';
import { enqueue, flushQueue, loadMealKey, loadQueue, patrolCodeOf, patrolDay, refreshMealKey, submitScan } from '../../utils/canteen';
import { requireMe } from '../../utils/guard';
import type { PatrolView } from '../../utils/patrol';
import { patrolResultText, patrolView, savePatrolLink, takePatrolLink } from '../../utils/patrol';
import { buzz, largeTextOn } from '../../utils/prefs';
import { uuid } from '../../utils/uuid';

let key: MealKey | null = null;
let flushTimer: number | null = null;
/** 页面显示的第几次：离开时加一，之前发出去的请求回来对不上就不再动页面 */
let gen = 0;

Page({
  data: {
    large: false,
    state: 'loading',
    error: '',
    view: null as PatrolView | null,
    result: null as { tone: string; title: string; sub: string } | null,
    waiting: 0,
    busy: false,
    canViewHistory: false,
  },

  onLoad(query: Record<string, string | undefined>) {
    const code = query.q ? patrolCodeOf(decodeURIComponent(query.q)) : null;
    if (code) savePatrolLink(code);
  },

  async onShow() {
    const my = ++gen;
    this.setData({ large: largeTextOn() });
    const me = await requireMe();
    if (!me || my !== gen) return;
    // 微信扫一扫带进来的码马上取走（不管后面成不成，都不会再把人带回这一页）
    const link = takePatrolLink();
    key = loadMealKey(me.staff.id);
    try {
      const fresh = await refreshMealKey(me.staff.id);
      if (my !== gen) return;
      key = fresh;
    } catch (e) {
      if (my !== gen) return;
      if (!key) {
        const lost = link ? '刚才扫的场所码没记上，连上以后请再扫一次。' : '';
        return this.setData({ state: isOffline(e) ? 'offline' : 'error', error: `${lost}${messageOf(e)}` });
      }
    }
    this.setData({ waiting: loadQueue('patrol', key.me.employee.id).length });
    if (link) this.record(link.code, link.via, new Date(link.at + key.offsetMs).toISOString());
    await this.load();
    if (my !== gen) return;
    this.flush();
    if (flushTimer === null) flushTimer = setInterval(() => this.flush(), 15000) as unknown as number;
  },

  onHide() {
    gen += 1;
    if (flushTimer !== null) clearInterval(flushTimer);
    flushTimer = null;
  },

  onUnload() {
    this.onHide();
  },

  async onPullDownRefresh() {
    await this.load();
    wx.stopPullDownRefresh();
  },

  async load() {
    try {
      const day = await patrolDay();
      this.setData({ state: 'ready', view: patrolView(day), canViewHistory: day.canViewHistory });
    } catch (e) {
      // 连不上也能扫（存在手机上），只是看不到这一轮的情况
      if (isOffline(e) && this.data.state !== 'ready') return this.setData({ state: 'ready', view: null });
      if (this.data.state !== 'ready') this.setData({ state: 'error', error: messageOf(e) });
    }
  },

  async flush() {
    if (!key) return;
    const waiting = await flushQueue<PatrolCheckinResult>('patrol', key.me.employee.id, (item, outcome) => this.show(item, outcome));
    this.setData({ waiting });
  },

  show(item: QueuedScan, outcome: ScanOutcome<PatrolCheckinResult>) {
    if (outcome.kind === 'done') {
      this.setData({ result: patrolResultText(outcome.result) });
      this.load();
    } else if (outcome.kind === 'rejected') {
      this.setData({ result: { tone: 'bad', title: `没记上：${item.label}`, sub: outcome.error.message } });
    } else if (outcome.expired) {
      this.setData({ result: { tone: 'wait', title: `登录过期了：${item.label}`, sub: '已经存在手机上，重新登录以后自动补交（不会重复）' } });
    } else {
      this.setData({ result: { tone: 'wait', title: `等网络：${item.label}`, sub: '已经存在手机上，连上以后自动补交（不会重复）' } });
    }
  },

  async record(code: string, via: 'scan' | 'link', scannedAt?: string) {
    if (!key) return;
    const employeeId = key.me.employee.id;
    const item: QueuedScan = {
      kind: 'patrol',
      body: { clientKey: uuid(), employeeId, code, via, scannedAt: scannedAt ?? new Date(Date.now() + key.offsetMs).toISOString() },
      label: `场所码 ${code.slice(0, 4)}…`,
      savedAt: Date.now(),
    };
    if (!enqueue(employeeId, item)) {
      this.setData({ result: { tone: 'bad', title: '手机上存不下，没有记', sub: '清一下微信的存储空间再扫' } });
      return;
    }
    this.setData({ busy: true });
    const outcome = await submitScan<PatrolCheckinResult>(employeeId, item);
    // 只有这一次记上了才震动
    if (outcome.kind === 'done' && outcome.result.status === 'ok') buzz();
    this.show(item, outcome);
    this.setData({ busy: false, waiting: loadQueue('patrol', employeeId).length });
  },

  onScan() {
    if (this.data.busy) return;
    wx.scanCode({
      onlyFromCamera: true,
      scanType: ['qrCode'],
      success: (r) => {
        const code = patrolCodeOf(r.result || '');
        if (!code) return this.setData({ result: { tone: 'bad', title: '这不是巡场的场所码', sub: '请扫贴在场所的巡场二维码' } });
        this.record(code, 'scan');
      },
    });
  },

  onLog() {
    wx.navigateTo({ url: '/pages/patrol-log/index' });
  },

  onRetry() {
    this.setData({ state: 'loading' });
    this.onShow();
  },
});
