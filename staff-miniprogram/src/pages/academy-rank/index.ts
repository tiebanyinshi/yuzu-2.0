// 学习榜（docs/STAFF_MP.md 第 2.3 节，第二版）：学分榜 / 学习时长榜，本月 / 全部，全公司 / 本店；照学堂的榜单（/api/academy/rank），
// 自己那一行标出来（不在前面的也在底下写自己第几）。

import type { AcademyRankBoard, AcademyRankPeriod, AcademyRankScope } from '../../../../src/shared/academy';
import type { RankRowView } from '../../utils/academy';
import { loadRank, rankRow } from '../../utils/academy';
import { isApiError, isOffline, messageOf } from '../../utils/api';
import { requireMe, toLogin } from '../../utils/guard';
import { largeTextOn } from '../../utils/prefs';

let gen = 0;
let myId = 0;

const BOARDS: { key: AcademyRankBoard; label: string }[] = [
  { key: 'credits', label: '学分榜' },
  { key: 'minutes', label: '学习时长' },
];
const PERIODS: { key: AcademyRankPeriod; label: string }[] = [
  { key: 'month', label: '本月' },
  { key: 'all', label: '全部' },
];
const SCOPES: { key: AcademyRankScope; label: string }[] = [
  { key: 'company', label: '全公司' },
  { key: 'store', label: '本店' },
];

Page({
  data: {
    large: false,
    state: 'loading',
    error: '',
    boards: BOARDS,
    periods: PERIODS,
    scopes: SCOPES,
    board: 'credits' as AcademyRankBoard,
    period: 'month' as AcademyRankPeriod,
    scope: 'company' as AcademyRankScope,
    rows: [] as RankRowView[],
    mine: null as RankRowView | null,
  },

  onLoad() {
    this.setData({ large: largeTextOn() });
  },

  async onShow() {
    const me = await requireMe();
    if (!me) return;
    myId = me.staff.id;
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
    const { board, period, scope } = this.data;
    try {
      const r = await loadRank({ board, period, scope });
      if (my !== gen) return;
      const rows = r.rows.map((x) => rankRow(x, board, myId));
      const mine = r.me && !rows.some((x) => x.me) ? rankRow(r.me, board, myId) : null;
      this.setData({ state: rows.length ? 'ready' : 'empty', error: '', rows, mine });
    } catch (e) {
      if (my !== gen) return;
      if (isApiError(e) && e.status === 401) return toLogin();
      this.setData({ state: isOffline(e) ? 'offline' : 'error', error: messageOf(e) });
    }
  },

  pick(field: 'board' | 'period' | 'scope', value: string) {
    if (this.data[field] === value) return;
    this.setData({ [field]: value, state: 'loading' });
    this.load();
  },

  onBoard(e: WechatMiniprogram.TouchEvent) {
    this.pick('board', String(e.currentTarget.dataset.key));
  },

  onPeriod(e: WechatMiniprogram.TouchEvent) {
    this.pick('period', String(e.currentTarget.dataset.key));
  },

  onScope(e: WechatMiniprogram.TouchEvent) {
    this.pick('scope', String(e.currentTarget.dataset.key));
  },

  async onPullDownRefresh() {
    await this.load();
    wx.stopPullDownRefresh();
  },

  onRetry() {
    this.setData({ state: 'loading' });
    this.load();
  },
});
