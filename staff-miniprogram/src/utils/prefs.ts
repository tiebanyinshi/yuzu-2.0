// 本机的偏好（docs/STAFF_MP.md 第 2.5 节）：大字（默认跟着微信的字体大小设置）、振动（打卡、巡场成功时轻振，默认开）。
// 只存在这台手机上，不上传。

const KEY = 'wcp_prefs';

export interface Prefs {
  /** 大字：null = 跟着微信的字体大小 */
  largeText: boolean | null;
  vibrate: boolean;
}

const DEFAULTS: Prefs = { largeText: null, vibrate: true };

export function loadPrefs(): Prefs {
  try {
    const v = wx.getStorageSync(KEY) as Partial<Prefs> | '';
    if (!v) return { ...DEFAULTS };
    return { largeText: typeof v.largeText === 'boolean' ? v.largeText : null, vibrate: v.vibrate !== false };
  } catch {
    return { ...DEFAULTS };
  }
}

export function savePrefs(next: Prefs): void {
  try {
    wx.setStorageSync(KEY, next);
  } catch {
    // 存不了：这次照用
  }
}

/** 微信里设的字体大小大于标准的（fontSizeSetting > 17）算「大字」 */
export function systemLargeText(fontSizeSetting: number | undefined): boolean {
  return typeof fontSizeSetting === 'number' && fontSizeSetting > 17;
}

/** 页面根上要不要加大字的样式 */
export function largeTextOn(): boolean {
  const p = loadPrefs();
  if (p.largeText !== null) return p.largeText;
  try {
    return systemLargeText(wx.getSystemInfoSync().fontSizeSetting);
  } catch {
    return false;
  }
}

/** 成功时轻振一下（关了就不振）；只给有结果的事（打卡记上了、巡场点打上了），同时页面上有变化 */
export function buzz(): void {
  if (!loadPrefs().vibrate) return;
  try {
    wx.vibrateShort({ type: 'light' });
  } catch {
    // 不支持就不振
  }
}
