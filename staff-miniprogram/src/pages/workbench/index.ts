// 工作台（docs/STAFF_MP.md 第 2.4 节）：按要办的事分组的全部入口，顶上一个搜索框搜功能名（打「工资」出工资条、打「假」出请假与假期余额）。
// 每组只列这个人能用的入口（服务端在「我是谁」里给），整组都没有就不显示。

import type { StaffMpEntryKey } from '../../../../src/shared/staffmp';
import type { GroupView } from '../../utils/entries';
import { entryGroups } from '../../utils/entries';
import { requireMe } from '../../utils/guard';
import { openPage } from '../../utils/nav';
import { largeTextOn } from '../../utils/prefs';

let allowed: StaffMpEntryKey[] = [];

Page({
  data: {
    large: false,
    keyword: '',
    groups: [] as GroupView[],
  },

  async onShow() {
    this.setData({ large: largeTextOn() });
    const me = await requireMe();
    if (!me) return;
    allowed = me.entries;
    this.setData({ groups: entryGroups(allowed, this.data.keyword) });
  },

  onKeyword(e: WechatMiniprogram.Input) {
    const keyword = e.detail.value;
    this.setData({ keyword, groups: entryGroups(allowed, keyword) });
  },

  onClear() {
    this.setData({ keyword: '', groups: entryGroups(allowed, '') });
  },

  onEntry(e: WechatMiniprogram.TouchEvent) {
    const page = String(e.currentTarget.dataset.page || '');
    if (!page) return;
    openPage(page);
  },
});
