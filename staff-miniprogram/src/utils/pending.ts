// 「结果待确认」（AGENTS.md 开发约定，docs/STAFF_MP.md 第 2.8 节）：写操作发出去以后没收到明确结果（超时、连不上、门店出错 5xx），
// 事务可能已经提交了。所以发之前先把原编号与原请求存在手机上并读回核对，**存不下就不发**；没收到结果的留着，
// 只能按原编号原样重提（门店系统按编号认出来，提交过的回原来那一次）。拿到明确结果（成功，或门店明确拒绝）才从手机上删掉。
//   · 手机上没有「放弃」按钮：查不到也不能断定没生效，所以留着的那一笔只能原样重提；
//     同一处（同一个人的打卡、同一个模板的申请、同一张单的处理）留着一笔时不发新的（blocked），免得换了编号重复办。
//   · 原样重提被门店明确拒绝时，不能断定前一次没生效（打卡在锁编号之前先核对考勤组与位置，前一次可能还在路上）：
//     打卡、发起申请、处理审批先在门店系统作废原编号（/api/staffmp/ops/:key/abandon，与网页的「确认作废」同一套）——
//     前一次已经办了的，再原样重提一次拿到原来那一次（算成功）；作废登记上了，前一次之后即使到达也整笔回滚，这才算被拒、删掉这一笔；
//     作废没有明确结果的，照旧留着。学堂的几样没有作废，按原来的：重提被拒就删（开卷、作答按编号认，学完了、交卷按课时、卷子认，
//     前一次办了的重提回原来那一次）。
//   · 没登录（401）不算拒绝：请求没进门店系统，留着，登录以后原样重提。
//   · 按人分开存：换了人登录看不到、也不会替前一位重提。
import { call, isApiError, isRejected } from './api';

/** 打卡、发起申请、处理审批；学堂的开卷（同一课时）、交卷（同一份卷子）、每日一练作答（同一道题）、学完了（同一课时） */
export type PendingKind = 'punch' | 'approval_submit' | 'approval_act' | 'academy_quiz' | 'academy_submit' | 'academy_daily' | 'academy_complete';

export interface PendingOp {
  /** 谁发的（按人分开存） */
  staffId: number;
  kind: PendingKind;
  /** 操作编号（clientKey） */
  key: string;
  path: string;
  body: Record<string, unknown>;
  /** 什么时候发的（毫秒） */
  at: number;
  /** 给人看的：这是哪一次操作 */
  label: string;
  /** 对象（审批单编号、模板编号），同一类里区分 */
  ref?: number;
}

/** 能在门店系统作废原编号的（第 2.8 节）：员工小程序端口 /ops/:key/abandon 认的业务类型 */
const FENCE_TYPES: Partial<Record<PendingKind, string>> = { punch: 'oa_punch', approval_submit: 'oa_approval_submit', approval_act: 'oa_approval_act' };

const keyOf = (staffId: number, kind: PendingKind, ref?: number) => `wcp_pending:${staffId}:${kind}${ref ? `:${ref}` : ''}`;

/** 存下并读回核对；存不下返回 false（调用方就不发请求） */
export function savePending(op: PendingOp): boolean {
  const k = keyOf(op.staffId, op.kind, op.ref);
  try {
    wx.setStorageSync(k, op);
    const back = wx.getStorageSync(k) as PendingOp | '';
    return !!back && back.key === op.key && JSON.stringify(back.body) === JSON.stringify(op.body);
  } catch {
    return false;
  }
}

export function loadPending(staffId: number, kind: PendingKind, ref?: number): PendingOp | null {
  try {
    const v = wx.getStorageSync(keyOf(staffId, kind, ref)) as PendingOp | '';
    return v && typeof v.key === 'string' ? v : null;
  } catch {
    return null;
  }
}

/** 这个人这一类留着的全部（学堂开新卷、进每日一练时把以前没确定的先原样重提掉） */
export function listPending(staffId: number, kind: PendingKind): PendingOp[] {
  try {
    const prefix = `wcp_pending:${staffId}:${kind}`;
    const keys = wx.getStorageInfoSync().keys.filter((k) => k === prefix || k.startsWith(`${prefix}:`));
    const out: PendingOp[] = [];
    for (const k of keys) {
      const v = wx.getStorageSync(k) as PendingOp | '';
      if (v && typeof v.key === 'string' && v.kind === kind) out.push(v);
    }
    return out;
  } catch {
    return [];
  }
}

export function clearPending(staffId: number, kind: PendingKind, ref?: number): void {
  try {
    wx.removeStorageSync(keyOf(staffId, kind, ref));
  } catch {
    // 删不了：下次拿到结果再删
  }
}

/** 存不下就不发的那句话 */
export const SAVE_FAILED = '手机上存不下这次操作的记录，为了不重复，没有发出去：清一下微信的存储空间再试';

/**
 * 原样重提时被这些挡下的：门店系统还没看这一笔（要先改密码、选岗位，换了门店，没这个权限、没这个接口），
 * 不能断定之前那次没生效（AGENTS.md「结果待确认」）——留着，等挡的原因解决了再原样重提
 */
const GATE_CODES = ['PASSWORD_CHANGE_REQUIRED', 'POSITION_REQUIRED', 'STORE_SWITCHED', 'FORBIDDEN', 'NOT_FOUND'];

export type SendOutcome<T> =
  | { status: 'ok'; data: T }
  | { status: 'rejected'; error: unknown }
  | { status: 'unknown'; error: unknown }
  | { status: 'signed_out'; error: unknown }
  | { status: 'blocked'; pending: PendingOp }
  | { status: 'not_sent' }
  /** 门店系统查到前一次已经办了（作废时回 found），但这次原样重提拿不回原来的结果（例如门店换了）：算办好了；refId 是那一笔（审批单编号、打卡编号） */
  | { status: 'confirmed'; refId: number | null };

/**
 * 发一次写操作（第一次或原样重提）：同一处还留着另一笔没确定的就不发（blocked）；先存再发，存不下就不发（not_sent）；
 * 成功、门店明确拒绝（4xx，不是忙、不是没登录）都删掉这一笔；超时、连不上、5xx 留着（unknown），没登录留着（signed_out）。
 * 原样重提被拒：打卡、申请、审批先作废原编号（settleRejectedResend），学堂的直接算被拒
 */
export async function sendPending<T>(op: PendingOp): Promise<SendOutcome<T>> {
  const before = loadPending(op.staffId, op.kind, op.ref);
  if (before && before.key !== op.key) return { status: 'blocked', pending: before };
  if (!savePending(op)) return { status: 'not_sent' };
  try {
    const data = await call<T>('POST', op.path, op.body);
    clearPending(op.staffId, op.kind, op.ref);
    return { status: 'ok', data };
  } catch (e) {
    if (isApiError(e) && e.status === 401) return { status: 'signed_out', error: e };
    if (isRejected(e)) {
      const resend = !!before && before.key === op.key;
      const type = FENCE_TYPES[op.kind];
      // 换了门店（STORE_SWITCHED）：能作废的照样先作废原编号再下结论（不然换了门店以后这一笔永远定不下来）；别的关卡留着
      if (resend && isApiError(e) && GATE_CODES.indexOf(e.code) >= 0 && !(type && e.code === 'STORE_SWITCHED')) return { status: 'unknown', error: e };
      if (resend && type) return settleRejectedResend<T>(op, type, e);
      clearPending(op.staffId, op.kind, op.ref);
      return { status: 'rejected', error: e };
    }
    return { status: 'unknown', error: e };
  }
}

/**
 * 原样重提被拒以后：先作废原编号再下结论（AGENTS.md「结果待确认」）。
 * 前一次已经办了（found）：再原样重提一次，门店按编号回原来那一次；作废登记上了（abandoned）：算被拒，删掉这一笔；
 * 作废本身没有明确结果、或两样都不是：留着（unknown），等下次原样重提
 */
async function settleRejectedResend<T>(op: PendingOp, type: string, rejection: unknown): Promise<SendOutcome<T>> {
  let fenced: { found?: boolean; abandoned?: boolean; refId?: number };
  try {
    fenced = await call<{ found?: boolean; abandoned?: boolean; refId?: number }>('POST', `/ops/${op.key}/abandon`, { type });
  } catch (e) {
    if (isApiError(e) && e.status === 401) return { status: 'signed_out', error: e };
    return { status: 'unknown', error: rejection };
  }
  if (fenced.found) {
    try {
      const data = await call<T>('POST', op.path, op.body);
      clearPending(op.staffId, op.kind, op.ref);
      return { status: 'ok', data };
    } catch (e) {
      if (isApiError(e) && e.status === 401) return { status: 'signed_out', error: e };
      // 门店系统已经说了前一次办了：这次拿不回原来的结果（例如换了门店，打卡先核对门店）也算办好了，不再留着
      if (isRejected(e)) {
        clearPending(op.staffId, op.kind, op.ref);
        return { status: 'confirmed', refId: typeof fenced.refId === 'number' ? fenced.refId : null };
      }
      return { status: 'unknown', error: e };
    }
  }
  if (fenced.abandoned) {
    clearPending(op.staffId, op.kind, op.ref);
    return { status: 'rejected', error: rejection };
  }
  return { status: 'unknown', error: rejection };
}
