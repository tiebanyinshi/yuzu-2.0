// 「结果待确认」（AGENTS.md 开发约定，docs/STAFF_MP.md 第 2.8 节）：写操作发出去以后没收到明确结果（超时、连不上、门店出错 5xx），
// 事务可能已经提交了。所以发之前先把原编号与原请求存在手机上并读回核对，**存不下就不发**；没收到结果的留着，
// 只能按原编号原样重提（门店系统按编号认出来，提交过的回原来那一次）。拿到明确结果（成功，或门店明确拒绝）才从手机上删掉。
//   · 手机上没有「放弃」：员工小程序端口上没有「确认作废」，查不到也不能断定没生效，所以留着的那一笔只能原样重提；
//     同一处（同一个人的打卡、同一个模板的申请、同一张单的处理）留着一笔时不发新的（blocked），免得换了编号重复办。
//   · 重提被门店明确拒绝算数：审批的提交与处理在事务里先锁操作编号、再查这个编号办没办过，前一次提交了的重提一定回原来那一次；
//     打卡先查编号、没办过才核对位置，前一次还没落库时重提被拒，最坏多记一条打卡明细（考勤按第一次 / 最后一次算，不会算错）。
//   · 没登录（401）不算拒绝：请求没进门店系统，留着，登录以后原样重提。
//   · 按人分开存：换了人登录看不到、也不会替前一位重提。
import { call, isApiError, isRejected } from './api';

/** 打卡、发起申请、处理审批；学堂的开卷（同一课时）、交卷（同一份卷子）、每日一练作答（同一道题） */
export type PendingKind = 'punch' | 'approval_submit' | 'approval_act' | 'academy_quiz' | 'academy_submit' | 'academy_daily';

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
  | { status: 'not_sent' };

/**
 * 发一次写操作（第一次或原样重提）：同一处还留着另一笔没确定的就不发（blocked）；先存再发，存不下就不发（not_sent）；
 * 成功、门店明确拒绝（4xx，不是忙、不是没登录）都删掉这一笔；超时、连不上、5xx 留着（unknown），没登录留着（signed_out）
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
      if (resend && isApiError(e) && GATE_CODES.indexOf(e.code) >= 0) return { status: 'unknown', error: e };
      clearPending(op.staffId, op.kind, op.ref);
      return { status: 'rejected', error: e };
    }
    return { status: 'unknown', error: e };
  }
}
