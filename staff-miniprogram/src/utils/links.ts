// 通知里的「点开去哪一页」是 WCP 网页的地址（/oa/approvals/12、/oa/payslips/3……）：换成小程序里对应的页面；没有的返回 null（只看文字）。
// 学堂派必修课、学习地图的通知（academy/admin.ts 的 notifyAssigned）给的是 /oa/academy/courses/:id、/oa/academy/paths/:id。
// 回的地址可能是 Tab 页（学习）：用 nav.ts 的 openPage 打开（Tab 页要 switchTab）。

export function pageOfLink(link: string | null): string | null {
  if (!link) return null;
  const path = link.split('?')[0]!.replace(/\/+$/, '');
  let m = /^\/oa\/approvals\/(\d+)$/.exec(path);
  if (m) return `/pages/approval/index?id=${m[1]}`;
  if (/^\/oa\/approvals$/.test(path)) return '/pages/approvals/index';
  m = /^\/oa\/(?:my\/)?payslips\/(\d+)$/.exec(path);
  if (m) return `/pages/payslip/index?id=${m[1]}`;
  if (/^\/oa\/(?:my\/)?payslips$/.test(path)) return '/pages/payslips/index';
  m = /^\/oa\/announcements\/(\d+)$/.exec(path);
  if (m) return `/pages/announcement/index?id=${m[1]}`;
  if (/^\/oa\/announcements$/.test(path)) return '/pages/announcements/index';
  if (/^\/oa\/(?:me\/)?schedule$/.test(path)) return '/pages/schedule/index';
  if (/^\/oa\/(?:me\/)?attendance$/.test(path)) return '/pages/attendance/index';
  if (/^\/oa\/(?:punch|attendance\/punch)$/.test(path)) return '/pages/punch/index';
  if (/^\/oa\/(?:me\/)?leave$/.test(path)) return '/pages/leave/index';
  m = /^\/oa\/academy\/courses\/(\d+)$/.exec(path);
  if (m) return `/pages/academy-course/index?id=${m[1]}`;
  m = /^\/oa\/academy\/paths\/(\d+)$/.exec(path);
  if (m) return `/pages/academy-path/index?id=${m[1]}`;
  if (/^\/oa\/(?:training|academy)(?:\/|$)/.test(path)) return '/pages/learn/index';
  return null;
}
