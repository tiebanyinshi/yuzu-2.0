// 搜培训资料（docs/STAFF_MP.md 第 2.3 节）：搜资料的标题与说明（员工培训的检索接口），最近搜过的留 5 条（只在这台手机上）。
// 汤崎学堂接上以后，同一个输入框也搜课程。

import { isApiError, messageOf } from '../../utils/api';
import { requireMe, toLogin } from '../../utils/guard';
import { largeTextOn } from '../../utils/prefs';
import type { FileRow } from '../../utils/training';
import { fileRow, recentSearches, rememberSearch, searchFiles } from '../../utils/training';

let timer: number | null = null;
let seq = 0;

Page({
  data: {
    large: false,
    q: '',
    recent: [] as string[],
    state: 'idle',
    error: '',
    results: [] as FileRow[],
  },

  async onLoad() {
    this.setData({ large: largeTextOn(), recent: recentSearches() });
    await requireMe();
  },

  onInput(e: WechatMiniprogram.Input) {
    const q = e.detail.value;
    this.setData({ q });
    if (timer !== null) clearTimeout(timer);
    // 停下来 300 毫秒再搜（打字时不每个字都问一次）
    timer = setTimeout(() => this.search(q), 300) as unknown as number;
  },

  onConfirm() {
    this.search(this.data.q, true);
  },

  onRecent(e: WechatMiniprogram.TouchEvent) {
    const q = String(e.currentTarget.dataset.q || '');
    this.setData({ q });
    this.search(q, true);
  },

  onClear() {
    // 等着的那一次不搜了，正在搜的回来也不认
    if (timer !== null) clearTimeout(timer);
    timer = null;
    seq += 1;
    this.setData({ q: '', results: [], state: 'idle' });
  },

  async search(raw: string, remember = false) {
    const q = raw.trim();
    const mine = ++seq;
    if (!q) return this.setData({ results: [], state: 'idle' });
    this.setData({ state: 'loading', error: '' });
    try {
      const items = await searchFiles(q);
      // 打字快时只认最后一次的结果
      if (mine !== seq) return;
      this.setData({ results: items.map((i) => fileRow(i.file, i.folderName)), state: items.length ? 'ready' : 'empty' });
      if (remember || items.length) {
        rememberSearch(q);
        this.setData({ recent: recentSearches() });
      }
    } catch (e) {
      if (mine !== seq) return;
      if (isApiError(e) && e.status === 401) return toLogin();
      this.setData({ state: isApiError(e) && e.code === 'NETWORK' ? 'offline' : 'error', error: messageOf(e) });
    }
  },

  onRetry() {
    this.search(this.data.q, true);
  },

  onFile(e: WechatMiniprogram.TouchEvent) {
    const { id, folder } = e.currentTarget.dataset as { id: number; folder: number };
    wx.navigateTo({ url: `/pages/learn-file/index?folder=${folder}&id=${id}` });
  },
});
