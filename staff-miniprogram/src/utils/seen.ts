// 首页待办「我的申请被驳回」用的「看过了」（docs/STAFF_MP.md 第 2.1 节，第二版，SP19）：审批中心里没有「发起人看没看过」，
// 打开过那张被驳回的单就记在这台手机上（按人分开存，只留最近 100 张），待办里就不再提它。换了手机、清了微信的存储会再提一次。

const KEY = 'wcp_seen_rejected:';
const KEEP = 100;

export function seenRejected(staffId: number): number[] {
  try {
    const v = wx.getStorageSync(KEY + staffId) as number[] | '';
    return Array.isArray(v) ? v.filter((x) => typeof x === 'number') : [];
  } catch {
    return [];
  }
}

export function markRejectedSeen(staffId: number, approvalId: number): void {
  const list = seenRejected(staffId);
  if (list.indexOf(approvalId) >= 0) return;
  try {
    wx.setStorageSync(KEY + staffId, [approvalId, ...list].slice(0, KEEP));
  } catch {
    // 存不了：待办里会再提一次，不碍事
  }
}
