// 饭卡码（员工小程序线 E，docs/STAFF_MP.md 第 2.4、5.4 节，SP10）：
//   · 第一次用先对上饭卡：以前在柚子饭堂登记过的输一次饭堂的账号密码证明；没登记过的开通一个普通员工的饭卡；
//   · 对上以后：码在手机上离线生成，30 秒一换（码钥匙存在手机上，没信号、登录过期都照样能亮）；亮码时调亮屏幕、屏幕常亮，离开就恢复；
//   · 门店系统连不上时用上次存的码钥匙，页面上标「之前的信息」。

import { isApiError, isOffline, messageOf } from '../../utils/api';
import type { MealKey } from '../../utils/canteen';
import { canteenStatus, createCanteen, linkCanteen, loadMealKey, mealNow, mealWindowText, refreshMealKey } from '../../utils/canteen';
import { initialOf, storeClock } from '../../utils/format';
import { requireMe, toLogin } from '../../utils/guard';
import { secondsLeft, signMealCode } from '../../utils/meal-code';
import { largeTextOn } from '../../utils/prefs';
import { drawQr, encodeText } from '../../utils/qr';

const QR_PX = 248;
let timer: number | null = null;
let key: MealKey | null = null;
let lastStep = -1;
let brightness: number | null = null;

Page({
  data: {
    large: false,
    state: 'loading',
    error: '',
    stale: false,
    linkForm: false,
    account: '',
    password: '',
    busy: false,
    name: '',
    empNo: '',
    initial: '',
    meal: '',
    mealsThisMonth: 0,
    left: 30,
    qrPx: QR_PX,
  },

  async onShow() {
    this.setData({ large: largeTextOn() });
    const me = await requireMe();
    if (!me) return;
    key = loadMealKey(me.staff.id);
    if (key) this.showKey(key, true);
    this.brighten();
    this.refresh(me.staff.id);
  },

  onHide() {
    this.stop();
  },

  onUnload() {
    this.stop();
  },

  stop() {
    if (timer !== null) clearInterval(timer);
    timer = null;
    lastStep = -1;
    try {
      wx.setKeepScreenOn({ keepScreenOn: false });
      if (brightness !== null) wx.setScreenBrightness({ value: brightness });
    } catch {
      // 不支持就算了
    }
    brightness = null;
  },

  /** 亮码时调亮屏幕、屏幕常亮（扫码枪、负责人的手机好认）；离开页面恢复原来的亮度 */
  brighten() {
    try {
      wx.getScreenBrightness({
        success: (r) => {
          if (brightness === null) brightness = r.value;
          wx.setScreenBrightness({ value: 1 });
        },
      });
      wx.setKeepScreenOn({ keepScreenOn: true });
    } catch {
      // 不支持就算了
    }
  },

  async refresh(staffId: number) {
    try {
      const status = await canteenStatus();
      if (!status.open) return this.setData({ state: 'closed' });
      if (!status.linked) return this.setData({ state: 'link' });
      key = await refreshMealKey(staffId);
      this.showKey(key, false);
    } catch (e) {
      if (isApiError(e) && e.status === 401 && !key) return toLogin();
      // 连不上：有存着的码钥匙就照样亮（标「之前的信息」）
      if (key) return this.setData({ stale: true });
      this.setData({ state: isOffline(e) ? 'offline' : 'error', error: messageOf(e) });
    }
  },

  showKey(k: MealKey, stale: boolean) {
    const e = k.me.employee;
    const clock = storeClock(new Date(Date.now() + k.offsetMs));
    const hhmm = `${String(clock.hour).padStart(2, '0')}:${String(clock.minute).padStart(2, '0')}`;
    const w = mealNow(k.me.meals, hhmm);
    this.setData({
      state: 'ready',
      stale,
      name: e.name,
      empNo: e.empNo,
      initial: initialOf(e.name),
      meal: w ? `${mealWindowText(w)} · 开饭中` : '现在不是开饭时间，码照样能亮',
      mealsThisMonth: k.me.mealsThisMonth,
    });
    if (timer === null) timer = setInterval(() => this.tick(), 1000) as unknown as number;
    this.tick();
  },

  /** 每秒：更新倒计时；换了时间段就重画码 */
  tick() {
    if (!key) return;
    const now = Date.now() + key.offsetMs;
    const { text, step } = signMealCode(key.me.codeKey, key.me.employee.id, now);
    this.setData({ left: secondsLeft(now) });
    if (step === lastStep) return;
    lastStep = step;
    this.createSelectorQuery()
      .select('#qr')
      .fields({ node: true, size: true })
      .exec((res: { node?: WechatMiniprogram.Canvas }[]) => {
        const canvas = res && res[0] && res[0].node;
        if (!canvas) return;
        const ctx = canvas.getContext('2d') as WechatMiniprogram.CanvasRenderingContext.CanvasRenderingContext2D;
        let dpr = 2;
        try {
          dpr = wx.getWindowInfo().pixelRatio || 2;
        } catch {
          dpr = 2;
        }
        canvas.width = QR_PX * dpr;
        canvas.height = QR_PX * dpr;
        ctx.scale(dpr, dpr);
        // 二维码一律墨色、白底（扫码要的对比）
        drawQr(ctx, encodeText(text), QR_PX, '#1C1A17', '#FFFFFF');
      });
  },

  onLinkForm() {
    this.setData({ linkForm: true, error: '' });
  },

  onAccount(e: WechatMiniprogram.Input) {
    this.setData({ account: e.detail.value, error: '' });
  },

  onPassword(e: WechatMiniprogram.Input) {
    this.setData({ password: e.detail.value, error: '' });
  },

  async onLink() {
    if (this.data.busy) return;
    if (!this.data.account.trim() || !this.data.password) return this.setData({ error: '请输入饭堂的账号（工号、用户名或手机号）和密码' });
    this.setData({ busy: true, error: '' });
    try {
      await linkCanteen(this.data.account.trim(), this.data.password);
      const me = await requireMe();
      if (me) this.refresh(me.staff.id);
    } catch (e) {
      this.setData({ error: messageOf(e) });
    } finally {
      this.setData({ busy: false, password: '' });
    }
  },

  onCreate() {
    wx.showModal({
      title: '开通饭卡？',
      content: '用你的名字开一张新饭卡。以前在柚子饭堂登记过的，请选「登记过」，不要再开一张。',
      confirmText: '开通',
      cancelText: '先不开',
      success: async (r) => {
        if (!r.confirm) return;
        this.setData({ busy: true, error: '' });
        try {
          await createCanteen();
          const me = await requireMe();
          if (me) this.refresh(me.staff.id);
        } catch (e) {
          this.setData({ error: messageOf(e) });
        } finally {
          this.setData({ busy: false });
        }
      },
    });
  },

  onRetry() {
    requireMe().then((me) => me && this.refresh(me.staff.id));
  },

  onMenu() {
    wx.navigateTo({ url: '/pages/menu/index' });
  },
});
