// 老账号第一次登录选新岗位（主线 8.1.18，GW7；docs/STAFF_MP.md 第 5.3 节）：一线员工没有电脑，在小程序里就能选。
// 能选哪些由门店系统按原来的岗位与职责给出（/api/auth/position-options 原样挂在 /api/staffmp/account/ 下）；选完不再提示。

import { call, isApiError, messageOf } from '../../utils/api';
import { enterApp } from '../../utils/guard';
import { largeTextOn } from '../../utils/prefs';
import { currentMe, refreshMe, updateMe } from '../../utils/session';

interface PositionOption {
  key: string;
  department: string;
  title: string;
  level: string;
  levelLabel: string;
}

Page({
  data: {
    large: false,
    state: 'loading',
    error: '',
    options: [] as PositionOption[],
    selected: '',
    busy: false,
  },

  onLoad() {
    this.setData({ large: largeTextOn() });
    this.load();
  },

  async load() {
    this.setData({ state: 'loading', error: '' });
    try {
      const r = await call<{ needsPosition: boolean; options: PositionOption[] }>('GET', '/account/position-options');
      if (!r.needsPosition) return enterApp();
      this.setData({ options: r.options, state: r.options.length ? 'ready' : 'empty' });
    } catch (e) {
      this.setData({ state: 'error', error: messageOf(e) });
    }
  },

  onRetry() {
    this.load();
  },

  onPick(e: WechatMiniprogram.TouchEvent) {
    this.setData({ selected: String(e.currentTarget.dataset.key || ''), error: '' });
  },

  async onSave() {
    if (!this.data.selected || this.data.busy) return;
    this.setData({ busy: true, error: '' });
    let saved = false;
    try {
      await call('POST', '/account/position', { position: this.data.selected });
      saved = true;
      await refreshMe();
      enterApp();
    } catch (e) {
      // 门店系统已经记下了（这次成功、或之前那次其实成功了）：岗位只能选一次，不再让人重选；「我是谁」没刷到就先按已选好进
      if (saved || (isApiError(e) && e.code === 'POSITION_ALREADY_SET')) {
        const me = currentMe();
        if (me) updateMe({ ...me, needsPosition: false });
        refreshMe().catch(() => undefined);
        return enterApp();
      }
      this.setData({ error: messageOf(e) });
    } finally {
      this.setData({ busy: false });
    }
  },
});
