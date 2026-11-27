// 自己画的导航栏（docs/STAFF_MP.md 第 4 节）：只保留右上角的微信胶囊，高度按胶囊的位置算，胶囊那一行左边的内容不越过胶囊左沿；
// 按钮一律放在胶囊下面一行。页面栈只有一页（从扫码、通知直接打开）时左上角是「首页」，不是返回。

export interface NavMetrics {
  /** 状态栏高（px） */
  statusBar: number;
  /** 导航栏这一行的高（px）：(胶囊上沿 − 状态栏高) × 2 + 胶囊高 */
  bar: number;
  /** 胶囊左沿到屏幕右边的距离（px）：这一行的内容不能伸进去 */
  capsuleRight: number;
  /** 胶囊的高（px），返回按钮与它一样高 */
  capsuleHeight: number;
}

const FALLBACK: NavMetrics = { statusBar: 20, bar: 44, capsuleRight: 97, capsuleHeight: 32 };

/** 从状态栏与胶囊的位置算导航栏（纯函数，单元测试核对） */
export function navMetricsOf(statusBar: number, windowWidth: number, capsule: { top: number; height: number; left: number } | null): NavMetrics {
  if (!capsule || capsule.height <= 0 || capsule.top < statusBar) return { ...FALLBACK, statusBar };
  return {
    statusBar,
    bar: (capsule.top - statusBar) * 2 + capsule.height,
    capsuleRight: Math.max(0, windowWidth - capsule.left),
    capsuleHeight: capsule.height,
  };
}

let cached: NavMetrics | null = null;
export function navMetrics(): NavMetrics {
  if (cached) return cached;
  try {
    const win = wx.getWindowInfo();
    let capsule: { top: number; height: number; left: number } | null = null;
    try {
      capsule = wx.getMenuButtonBoundingClientRect();
    } catch {
      capsule = null;
    }
    cached = navMetricsOf(win.statusBarHeight || 20, win.windowWidth || 375, capsule);
  } catch {
    cached = FALLBACK;
  }
  return cached;
}

/** 页面栈只有这一页（从扫码、通知、分享直接打开）：左上角给「首页」 */
export function isFirstPage(): boolean {
  try {
    return getCurrentPages().length <= 1;
  } catch {
    return false;
  }
}

/** 四个 Tab 页 */
export const TAB_PAGES = ['/pages/today/index', '/pages/learn/index', '/pages/workbench/index', '/pages/me/index'];

/** 回首页 */
export function goHome(): void {
  wx.switchTab({ url: TAB_PAGES[0]! });
}
