// 我的学习（docs/STAFF_MP.md 第 2.3 节，第二版）：等级与学分、证书（学完学习地图发的；过期、撤销写清楚）、各技能的掌握度、
// 每日一练连续几天；能签实操的给「带教签核」入口。都照学堂的「我的」（/api/academy/me），小程序不另算。

import type { CertRow, LevelView, MasteryRow } from '../../utils/academy';
import { certRow, levelView, loadAcademyMe, masteryRow } from '../../utils/academy';
import { isApiError, isOffline, messageOf } from '../../utils/api';
import { requireMe, toLogin } from '../../utils/guard';
import { largeTextOn } from '../../utils/prefs';

let gen = 0;

Page({
  data: {
    large: false,
    state: 'loading',
    error: '',
    level: null as LevelView | null,
    streak: '',
    certs: [] as CertRow[],
    mastery: [] as MasteryRow[],
    canCoach: false,
  },

  onLoad() {
    this.setData({ large: largeTextOn() });
  },

  async onShow() {
    if (!(await requireMe())) return;
    this.load();
  },

  onHide() {
    gen += 1;
  },

  onUnload() {
    gen += 1;
  },

  async load() {
    const my = ++gen;
    try {
      const d = await loadAcademyMe();
      if (my !== gen) return;
      this.setData({
        state: 'ready',
        error: '',
        level: levelView(d.me),
        streak: d.streak > 0 ? `每日一练连续 ${d.streak} 天` : '每日一练今天还没开始',
        certs: d.certificates.map(certRow),
        mastery: d.mastery.map(masteryRow),
        canCoach: d.canCoach,
      });
    } catch (e) {
      if (my !== gen) return;
      if (isApiError(e) && e.status === 401) return toLogin();
      if (this.data.state !== 'ready') this.setData({ state: isOffline(e) ? 'offline' : 'error', error: messageOf(e) });
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

  onRank() {
    wx.navigateTo({ url: '/pages/academy-rank/index' });
  },

  onCoach() {
    wx.navigateTo({ url: '/pages/academy-coach/index' });
  },
});
