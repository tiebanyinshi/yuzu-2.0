// 打卡（docs/STAFF_MP.md 第 2.2、2.8 节，SP13、SP15、SP16）：
//   · 大字的此刻（门店的钟），下面写门店系统回的「下一张卡」；主按钮只有上班打卡、已到下班时间的下班打卡；
//     没到下班时间只有文字按钮「提前下班」，先确认「会记早退」；
//   · 要定位的考勤组才取位置（WGS-84，与打卡点同一个坐标系）；没给定位权限的说清楚、给「去打开定位」；
//   · 发之前看一眼有没有网：没网直接说到有信号的地方再点，不排队（打卡时间按门店系统收到的时刻记，SP16）；
//   · 不在打卡范围内、考勤组允许外勤的：写事由、现场拍一张照片，改成外勤打卡；
//   · 发出去没收到结果（超时、连不上、门店出错）：进「结果待确认」，只能按原编号原样重提（不会重复），没确定以前不打新的；
//   · 打上了：结果留在这一页，直到离开；轻振一下。

import type { StaffMpMe } from '../../../../src/shared/staffmp';
import type { OaPunch, PunchResult, PunchToday } from '../../../../src/shared/oa';
import { call, isApiError, isOffline, messageOf } from '../../utils/api';
import { requireMe, toLogin } from '../../utils/guard';
import type { PendingOp } from '../../utils/pending';
import { loadPending, SAVE_FAILED, sendPending } from '../../utils/pending';
import { choosePhotos, uploadPhoto } from '../../utils/photo';
import { buzz, largeTextOn } from '../../utils/prefs';
import type { PunchView } from '../../utils/punch';
import { punchIsLate, punchResultText, punchView } from '../../utils/punch';
import { shortTime } from '../../utils/format';
import { uuid } from '../../utils/uuid';

const OUTWORK_REASON_MAX = 200;

let me: StaffMpMe | null = null;
let today: PunchToday | null = null;
let base = { now: 0, at: 0 };
let timer: number | null = null;
/** 页面显示的第几次：离开时加一，之前的请求回来对不上就不起计时器 */
let gen = 0;

interface PunchRow {
  id: number;
  time: string;
  text: string;
  sub: string;
  late: boolean;
}

function rowsOf(punches: OaPunch[]): PunchRow[] {
  return punches
    .slice()
    .sort((a, b) => a.punchedAt.localeCompare(b.punchedAt))
    .map((p) => ({
      id: p.id,
      time: p.localTime,
      text: punchResultText(p).slice(p.localTime.length + 1),
      sub: [p.shiftName, p.outwork ? `外勤：${p.outworkReason ?? ''}` : p.locationName ? `${p.locationName}${p.distanceM !== null ? ` · ${p.distanceM} 米` : ''}` : '', p.makeup ? '补卡' : '']
        .filter(Boolean)
        .join(' · '),
      late: punchIsLate(p),
    }));
}

function deviceText(): string {
  try {
    const d = wx.getDeviceInfo();
    return `staffmp ${d.brand} ${d.model} ${d.system}`.slice(0, 200);
  } catch {
    return 'staffmp';
  }
}

function getLocation(): Promise<{ lat: number; lng: number; accuracy: number }> {
  return new Promise((resolve, reject) => {
    wx.getLocation({
      type: 'wgs84',
      isHighAccuracy: true,
      highAccuracyExpireTime: 4000,
      success: (r) => resolve({ lat: r.latitude, lng: r.longitude, accuracy: r.accuracy }),
      fail: (e) => reject(e),
    });
  });
}

function networkNone(): Promise<boolean> {
  return new Promise((resolve) => {
    wx.getNetworkType({ success: (r) => resolve(r.networkType === 'none'), fail: () => resolve(false) });
  });
}

Page({
  data: {
    large: false,
    state: 'loading',
    error: '',
    view: null as PunchView | null,
    busy: false,
    actionError: '',
    locationDenied: false,
    result: '',
    resultLate: false,
    pending: null as { label: string; at: string } | null,
    outwork: false,
    outworkReason: '',
    outworkPhoto: '',
    rows: [] as PunchRow[],
  },

  onLoad() {
    // 新开的一页：不用上一次（可能是上一位员工）的打卡数据
    me = null;
    today = null;
  },

  async onShow() {
    const my = ++gen;
    this.setData({ large: largeTextOn() });
    me = await requireMe();
    if (!me || my !== gen) return;
    this.showPending();
    await this.load();
    if (my === gen) this.startClock();
  },

  onHide() {
    gen += 1;
    this.stopClock();
  },

  onUnload() {
    gen += 1;
    this.stopClock();
  },

  startClock() {
    this.stopClock();
    timer = setInterval(() => this.tick(), 10000) as unknown as number;
  },

  stopClock() {
    if (timer !== null) clearInterval(timer);
    timer = null;
  },

  /** 门店的钟按本机时钟往前走（每 10 秒刷新一次大字与按钮） */
  tick() {
    if (!today) return;
    const now = base.now + Math.floor((Date.now() - base.at) / 60000);
    this.setData({ view: punchView(today, now) });
  },

  async load() {
    try {
      today = await call<PunchToday>('GET', '/oa/attendance/today');
      base = { now: today.now, at: Date.now() };
      this.setData({ state: 'ready', view: punchView(today), rows: rowsOf(today.punches), error: '' });
    } catch (e) {
      if (isApiError(e) && e.status === 401) return toLogin();
      if (!today) this.setData({ state: isOffline(e) ? 'offline' : 'error', error: messageOf(e) });
      else this.setData({ state: 'ready' });
    }
  },

  async onPullDownRefresh() {
    await this.load();
    wx.stopPullDownRefresh();
  },

  onRetry() {
    this.setData({ state: 'loading' });
    this.load();
  },

  showPending() {
    const p = me ? loadPending(me.staff.id, 'punch') : null;
    this.setData({ pending: p ? { label: p.label, at: shortTime(new Date(p.at).toISOString()) } : null });
  },

  onPunch() {
    this.punch();
  },

  onEarly() {
    const v = this.data.view;
    if (!v) return;
    wx.showModal({
      title: '提前下班？',
      content: `现在还没到下班时间，打下班卡会记早退 ${v.earlyMinutes} 分钟。`,
      confirmText: '提前下班',
      cancelText: '先不打',
      success: (r) => {
        if (r.confirm) this.punch();
      },
    });
  },

  onOpenSetting() {
    wx.openSetting({
      success: () => this.setData({ locationDenied: false, actionError: '' }),
    });
  },

  /** 打一张卡（outwork 给了就是外勤打卡） */
  async punch(outwork?: { reason: string; photoId: number }) {
    if (this.data.busy || !me || !today) return;
    if (loadPending(me.staff.id, 'punch')) {
      this.showPending();
      this.setData({ actionError: '上一次打卡还没确定：先点「再提交一次」，拿到结果再说' });
      return;
    }
    this.setData({ busy: true, actionError: '', result: '' });
    try {
      if (await networkNone()) {
        this.setData({ actionError: '现在连不上门店系统，打不了卡：到有信号的地方再点' });
        return;
      }
      let where: { lat: number; lng: number; accuracy: number } | null = null;
      if (today.group?.gpsRequired || outwork) {
        try {
          where = await getLocation();
        } catch (e) {
          const msg = String((e as { errMsg?: string }).errMsg ?? '');
          if (/system permission|privacy/i.test(msg)) {
            // 手机没给微信定位权限（或没同意隐私指引）：小程序的设置页打不开这个，说清楚去哪开
            this.setData({ actionError: '微信没有手机的定位权限：到手机的「设置 → 微信 → 位置」里打开，再回来打卡' });
          } else if (/auth|deny|denied/i.test(msg)) {
            this.setData({ locationDenied: true, actionError: '打卡要核对位置：请允许微信使用你的位置（只在打卡时取一次）' });
          } else {
            this.setData({ actionError: '没取到位置：到窗边或室外，打开手机的定位再试' });
          }
          return;
        }
      }
      const body: Record<string, unknown> = { clientKey: uuid(), storeId: me.store.id, device: deviceText() };
      if (where) Object.assign(body, { lat: where.lat, lng: where.lng, accuracy: where.accuracy });
      if (outwork) body.outwork = outwork;
      const op: PendingOp = { staffId: me.staff.id, kind: 'punch', key: String(body.clientKey), path: '/oa/attendance/punch', body, at: Date.now(), label: outwork ? '外勤打卡' : '打卡' };
      await this.send(op);
    } finally {
      this.setData({ busy: false });
    }
  },

  async send(op: PendingOp) {
    const r = await sendPending<PunchResult>(op);
    if (r.status === 'not_sent') return this.setData({ actionError: SAVE_FAILED });
    if (r.status === 'signed_out') return toLogin();
    if (r.status === 'blocked') {
      this.showPending();
      return this.setData({ actionError: '上一次打卡还没确定：先点「再提交一次」，拿到结果再说' });
    }
    if (r.status === 'ok') {
      buzz();
      this.setData({ result: punchResultText(r.data.punch), resultLate: punchIsLate(r.data.punch), pending: null, outwork: false, outworkReason: '', outworkPhoto: '' });
      await this.load();
      return;
    }
    if (r.status === 'rejected') {
      const e = r.error;
      if (isApiError(e) && e.code === 'LOCATION_OUT' && this.data.view?.outworkAllowed) {
        this.setData({ outwork: true, actionError: e.message });
      } else {
        this.setData({ actionError: messageOf(e) });
      }
      this.showPending();
      return;
    }
    // 结果不确定：留着这一笔，只能原样重提
    this.showPending();
    this.setData({ actionError: '' });
  },

  async onResend() {
    const p = me ? loadPending(me.staff.id, 'punch') : null;
    if (!p || this.data.busy) return;
    this.setData({ busy: true, actionError: '' });
    try {
      await this.send(p);
    } finally {
      this.setData({ busy: false });
    }
  },

  onOutworkReason(e: WechatMiniprogram.Input) {
    this.setData({ outworkReason: e.detail.value });
  },

  async onOutworkPhoto() {
    try {
      const [path] = await choosePhotos(1, true);
      if (path) this.setData({ outworkPhoto: path, actionError: '' });
    } catch (e) {
      this.setData({ actionError: messageOf(e) });
    }
  },

  onCancelOutwork() {
    this.setData({ outwork: false, outworkReason: '', outworkPhoto: '', actionError: '' });
  },

  async onOutwork() {
    const reason = this.data.outworkReason.trim();
    if (!reason) return this.setData({ actionError: '请写外勤事由（在外面办什么事）' });
    if ([...reason].length > OUTWORK_REASON_MAX) return this.setData({ actionError: `外勤事由最多 ${OUTWORK_REASON_MAX} 个字` });
    if (!this.data.outworkPhoto) return this.setData({ actionError: '外勤要现场拍一张照片' });
    if (this.data.busy) return;
    this.setData({ busy: true, actionError: '' });
    let photoId = 0;
    try {
      photoId = (await uploadPhoto(this.data.outworkPhoto, 'outwork')).id;
    } catch (e) {
      this.setData({ busy: false, actionError: messageOf(e) });
      return;
    }
    this.setData({ busy: false });
    await this.punch({ reason, photoId });
  },
});
