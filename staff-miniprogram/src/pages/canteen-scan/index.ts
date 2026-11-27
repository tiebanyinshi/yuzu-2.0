// 扫码登记（食堂负责人，员工小程序线 E，docs/STAFF_MP.md 第 5.4 节）：相机一直开着，员工亮饭卡码就记一笔；没带手机的按名字手动登记。
//   · 规则照柚子饭堂原来的：码不对、过期、不在开饭时间明确拒绝；这一餐打过的回「已打过」，不多记；
//   · 扫到的先存在手机上（存不下就不发），没收到明确结果的留着，之后按原来的操作编号补交（第 2.8 节）；
//   · 同一个码 3 秒内只认一次（相机会连着报好几次）。

import type { CanteenCheckinRow, CanteenPerson, CanteenToday, CheckinResult } from '../../../../src/shared/canteen';
import { isOffline, messageOf } from '../../utils/api';
import type { MealKey, QueuedScan, ScanOutcome } from '../../utils/canteen';
import { MEAL_LABELS, canteenToday, enqueue, flushQueue, isMealCode, loadMealKey, loadQueue, refreshMealKey, searchPeople, submitScan, voidCheckin } from '../../utils/canteen';
import { initialOf, shortTime } from '../../utils/format';
import { requireMe } from '../../utils/guard';
import { buzz, largeTextOn } from '../../utils/prefs';
import { uuid } from '../../utils/uuid';

interface ResultRow {
  key: string;
  tone: 'ok' | 'already' | 'bad' | 'wait';
  title: string;
  sub: string;
  checkinId: number;
}

let key: MealKey | null = null;
let lastCode = '';
let lastAt = 0;
let flushTimer: number | null = null;

function rowOf(item: QueuedScan, outcome: ScanOutcome<CheckinResult>): ResultRow {
  if (outcome.kind === 'done') {
    const c = outcome.result.checkin;
    const ok = outcome.result.status === 'ok';
    return {
      key: item.body.clientKey,
      tone: ok ? 'ok' : 'already',
      title: ok ? `✓ ${c.name}` : `${c.name} 这一餐已经打过`,
      sub: ok ? `${MEAL_LABELS[c.meal] ?? ''}第 ${outcome.result.mealCount} 位 · ${c.empNo}` : `之前在 ${shortTime(c.scannedAt)} 登记过，不再多记`,
      checkinId: ok ? c.id : 0,
    };
  }
  if (outcome.kind === 'rejected') return { key: item.body.clientKey, tone: 'bad', title: `没登记上：${item.label}`, sub: outcome.error.message, checkinId: 0 };
  return { key: item.body.clientKey, tone: 'wait', title: `等网络：${item.label}`, sub: '已经存在手机上，连上以后自动补交（不会重复）', checkinId: 0 };
}

Page({
  data: {
    large: false,
    state: 'loading',
    error: '',
    cameraError: false,
    meal: '',
    count: 0,
    results: [] as ResultRow[],
    waiting: 0,
    query: '',
    people: [] as (CanteenPerson & { initial: string })[],
    searching: false,
    recent: [] as { id: number; name: string; time: string; manual: boolean; voided: boolean }[],
  },

  async onShow() {
    this.setData({ large: largeTextOn() });
    const me = await requireMe();
    if (!me) return;
    key = loadMealKey(me.staff.id);
    try {
      key = await refreshMealKey(me.staff.id);
    } catch (e) {
      if (!key) return this.setData({ state: isOffline(e) ? 'offline' : 'error', error: messageOf(e) });
    }
    if (key.me.employee.role !== 'manager') return this.setData({ state: 'error', error: '只有食堂负责人能扫码登记：要当负责人请找管理员在后台安排。' });
    this.setData({ state: 'ready', waiting: loadQueue('checkin', key.me.employee.id).length });
    this.loadToday();
    this.flush();
    if (flushTimer === null) flushTimer = setInterval(() => this.flush(), 15000) as unknown as number;
  },

  onHide() {
    if (flushTimer !== null) clearInterval(flushTimer);
    flushTimer = null;
  },

  onUnload() {
    this.onHide();
  },

  async loadToday() {
    try {
      const t: CanteenToday = await canteenToday();
      this.setData({
        meal: t.current ? (MEAL_LABELS[t.current.meal] ?? '') : '',
        count: t.current ? (t.counts[t.current.meal] ?? 0) : 0,
        recent: t.recent.slice(0, 20).map((r: CanteenCheckinRow) => ({ id: r.id, name: r.name, time: shortTime(r.scannedAt), manual: r.method === 'manual', voided: !!r.voidedAt })),
      });
    } catch {
      // 今天的人数只是参考：读不到不挡扫码
    }
  },

  /** 补交手机上留着的 */
  async flush() {
    if (!key) return;
    const employeeId = key.me.employee.id;
    const waiting = await flushQueue<CheckinResult>('checkin', employeeId, (item, outcome) => this.show(item, outcome));
    this.setData({ waiting });
  },

  show(item: QueuedScan, outcome: ScanOutcome<CheckinResult>) {
    const row = rowOf(item, outcome);
    const results = [row, ...this.data.results.filter((r) => r.key !== row.key)].slice(0, 30);
    this.setData({ results });
    if (outcome.kind === 'done' && outcome.result.status === 'ok') {
      this.setData({ count: outcome.result.mealCount });
      this.loadToday();
    }
  },

  /** 登记一笔：先存手机上（存不下不发），再交 */
  async record(body: { code?: string; employeeId?: number }, label: string) {
    if (!key) return;
    const employeeId = key.me.employee.id;
    const item: QueuedScan = {
      kind: 'checkin',
      body: { clientKey: uuid(), scannedAt: new Date(Date.now() + key.offsetMs).toISOString(), ...body },
      label,
      savedAt: Date.now(),
    };
    if (!enqueue(employeeId, item)) {
      wx.showToast({ title: '手机上存不下，没有登记：清一下微信的存储空间再试', icon: 'none' });
      return;
    }
    const outcome = await submitScan<CheckinResult>(employeeId, item);
    buzz();
    this.show(item, outcome);
    this.setData({ waiting: loadQueue('checkin', employeeId).length });
  },

  onScanCode(e: WechatMiniprogram.CustomEvent<{ result: string }>) {
    const text = String(e.detail.result || '').trim();
    const now = Date.now();
    if (text === lastCode && now - lastAt < 3000) return;
    lastCode = text;
    lastAt = now;
    if (!isMealCode(text)) {
      wx.showToast({ title: '这不是饭卡码', icon: 'none' });
      return;
    }
    this.record({ code: text.toUpperCase() }, '扫到的饭卡码');
  },

  onCameraError() {
    this.setData({ cameraError: true });
  },

  onOpenSetting() {
    wx.openSetting({ success: (r) => r.authSetting['scope.camera'] && this.setData({ cameraError: false }) });
  },

  onQuery(e: WechatMiniprogram.Input) {
    this.setData({ query: e.detail.value });
  },

  async onSearch() {
    const q = this.data.query.trim();
    if (!q) return this.setData({ people: [] });
    this.setData({ searching: true });
    try {
      const people = await searchPeople(q);
      this.setData({ people: people.map((p) => ({ ...p, initial: initialOf(p.name) })) });
    } catch (err) {
      wx.showToast({ title: messageOf(err), icon: 'none' });
    } finally {
      this.setData({ searching: false });
    }
  },

  onManual(e: WechatMiniprogram.BaseEvent) {
    const idx = Number(e.currentTarget.dataset.index);
    const p = this.data.people[idx];
    if (!p || p.checkedIn) return;
    wx.showModal({
      title: `给 ${p.name} 手动登记？`,
      content: '没带手机、码打不开的才手动登记。',
      confirmText: '登记',
      success: async (r) => {
        if (!r.confirm) return;
        await this.record({ employeeId: p.id }, `${p.name}（手动）`);
        this.setData({ [`people[${idx}].checkedIn`]: true });
      },
    });
  },

  /** 撤销刚登记的（登记错了人）：要写原因 */
  onVoid(e: WechatMiniprogram.BaseEvent) {
    const id = Number(e.currentTarget.dataset.id);
    if (!id) return;
    wx.showModal({
      title: '撤销这一笔？',
      editable: true,
      placeholderText: '写一下原因（例如：登记错了人）',
      confirmText: '撤销',
      success: async (r) => {
        if (!r.confirm) return;
        const reason = String(r.content || '').trim();
        if (!reason) {
          wx.showToast({ title: '请写撤销原因', icon: 'none' });
          return;
        }
        try {
          await voidCheckin(id, reason);
          this.setData({ results: this.data.results.map((x) => (x.checkinId === id ? { ...x, tone: 'bad' as const, title: `已撤销：${x.title.replace('✓ ', '')}`, sub: reason, checkinId: 0 } : x)) });
          this.loadToday();
        } catch (err) {
          wx.showToast({ title: messageOf(err), icon: 'none' });
        }
      },
    });
  },

  onRetry() {
    this.onShow();
  },
});
