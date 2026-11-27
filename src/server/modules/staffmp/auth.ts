// 员工小程序的账号与会话（docs/STAFF_MP.md 第 5.2、6 节，SP05、SP06）。
//   · 会话就是 yuzu 的员工会话（sessions，与网页同样滑动过期），staffmp_sessions 另记一笔「是员工小程序发的」；
//     员工小程序端口只认这里有的令牌，还要是在职员工（与 WCP 网页、员工培训同一条：不是平板 / 他店 / 设计师等专用账号、没离职）。
//   · 微信绑定：一个 openid 只绑一个账号、一个账号只绑一个 openid；新绑的把旧的解开（rebind）。解开只做标记、不删。
// 加锁（docs/LOCKING.md「员工小程序」）：绑定与解绑先拿这个 openid 的咨询锁、再拿这位员工的咨询锁（固定顺序），再读写绑定行。

import { isPositionKey, ORG_DEPARTMENTS, positionOf } from '@shared/positions';
import { businessDateOf } from '@shared/business-date';
import type { StaffMpEntryKey, StaffMpMe } from '@shared/staffmp';
import type { Db, Sql, Tx } from '../../db';
import { withTx } from '../../lib/tx';
import type { Actor, Deps } from '../../lib/context';
import { writeAudit } from '../../lib/audit';
import { createSession, hashSessionToken, resolveSession, resolveStaffActor, storeIdsOf } from '../../auth/session';
import { NOT_EMPLOYEE_ROLES, notify, onDuty } from '../oa';
import { canteenEntries } from './canteen';

/** 人人都有的入口（第 2.4 节）；吃饭、巡场按员工食堂与巡场的开关、对上的饭卡加（canteen.ts） */
const BASE_ENTRIES: readonly StaffMpEntryKey[] = ['punch', 'schedule', 'attendance', 'leave', 'approvals', 'payslips', 'directory', 'announcements', 'knowledge'];

/** 这个账号能不能用员工小程序；不能的给一句面向员工的原因 */
export async function eligibilityOf(db: Db, staffId: number): Promise<{ ok: true } | { ok: false; code: string; message: string }> {
  const [row] = await db<{ active: boolean; role: string; onDuty: boolean; storeIds: number[] }[]>`
    SELECT st.active, st.role, (${onDuty(db)}) AS on_duty, ${storeIdsOf(db)} AS store_ids
    FROM staff st
    -- 「在职」（onDuty）的写法用 s 表示员工、能进的门店（storeIdsOf）用 st：同一行起两个名字
    JOIN staff s ON s.id = st.id
    LEFT JOIN staff_profiles p ON p.staff_id = st.id
    WHERE st.id = ${staffId}`;
  if (!row || !row.active) return { ok: false, code: 'STAFF_INACTIVE', message: '这个账号已停用，请联系管理员' };
  if ((NOT_EMPLOYEE_ROLES as readonly string[]).includes(row.role)) return { ok: false, code: 'NOT_EMPLOYEE', message: '这是专用账号（平板、他店、设计师等），不能用员工小程序' };
  if (!row.onDuty) return { ok: false, code: 'NOT_EMPLOYEE', message: '人事档案里你已经离职，不能再用员工小程序' };
  if (!(row.storeIds ?? []).length) return { ok: false, code: 'NO_STORE', message: '这个账号挂的门店都停用了，请让管理员在「员工账号」里给它挂一家在营业的门店' };
  return { ok: true };
}

/**
 * 发一个员工小程序的会话：sessions 一行 + staffmp_sessions 一行（一个事务里）。
 * 挂着绑定的（微信一键进、登录时顺带绑上的）先拿这位员工的锁、再核对绑定还在（Codex 审查 467189d：读到绑定以后、发会话之前
 * 后台刚好解开或换绑了，不能再发一个挂在已经解开的绑定上的会话）；绑定已经解开的返回 null
 */
export async function issueSession(sql: Sql, staffId: number, bindingId: number | null, ttlHours: number, meta: { ip?: string; userAgent?: string }): Promise<string | null> {
  return withTx(sql, async (tx) => {
    if (bindingId !== null) {
      await lockBinding(tx, null, staffId);
      const [live] = await tx`SELECT 1 FROM staffmp_bindings WHERE id = ${bindingId} AND staff_id = ${staffId} AND revoked_at IS NULL`;
      if (!live) return null;
    }
    const token = await createSession(tx, staffId, ttlHours, { ip: meta.ip, userAgent: `staffmp ${meta.userAgent ?? ''}`.trim() });
    await tx`INSERT INTO staffmp_sessions (token_hash, staff_id, binding_id) VALUES (${hashSessionToken(token)}, ${staffId}, ${bindingId})`;
    return token;
  });
}

/**
 * 员工小程序端口认的会话：只认员工小程序发的令牌，账号要还在职（每个请求都查，离职、改成专用账号以后马上进不来），
 * 挂着绑定的、绑定已经解开的不认（解开时会话本来就删了；这一条兜住解开与发会话撞在一起的情况）。
 * 解析出来的 Actor 与网页的会话一模一样（权限、门店都按 resolveSession 现算）
 */
export async function resolveStaffMpSession(db: Db, token: string, ttlHours: number): Promise<Actor | null> {
  const [mine] = await db<{ ok: boolean }[]>`
    SELECT (${onDuty(db)}) AS ok
    FROM staffmp_sessions m JOIN staff s ON s.id = m.staff_id LEFT JOIN staff_profiles p ON p.staff_id = s.id
    LEFT JOIN staffmp_bindings b ON b.id = m.binding_id
    WHERE m.token_hash = ${hashSessionToken(token)} AND (m.binding_id IS NULL OR b.revoked_at IS NULL)`;
  if (!mine?.ok) return null;
  return resolveSession(db, token, ttlHours);
}

/**
 * 短时地址（media.ts）用的：按会话摘要找员工小程序的会话（没过期、人在职），拼出与令牌一样的 Actor（门店取这个会话选的）。
 * 不顺延会话（短时地址只是打开一个文件）
 */
export async function resolveStaffMpSessionByHash(db: Db, tokenHash: string): Promise<Actor | null> {
  const [row] = await db<{ staffId: number; storeId: number | null; ok: boolean }[]>`
    SELECT m.staff_id, x.store_id, (${onDuty(db)}) AS ok
    FROM staffmp_sessions m
    JOIN sessions x ON x.token_hash = m.token_hash AND x.expires_at > now()
    JOIN staff s ON s.id = m.staff_id LEFT JOIN staff_profiles p ON p.staff_id = s.id
    LEFT JOIN staffmp_bindings b ON b.id = m.binding_id
    WHERE m.token_hash = ${tokenHash} AND (m.binding_id IS NULL OR b.revoked_at IS NULL)`;
  if (!row?.ok) return null;
  const found = await resolveStaffActor(db, Number(row.staffId), row.storeId == null ? null : Number(row.storeId));
  return found?.actor ?? null;
}

/** 这位员工在员工小程序上的会话全部退出（解绑、后台解开时）；exceptToken 给了就留下这一个 */
export async function dropStaffMpSessions(db: Db, staffId: number, exceptToken?: string): Promise<void> {
  const keep = exceptToken ? hashSessionToken(exceptToken) : '';
  await db`DELETE FROM sessions WHERE token_hash IN (SELECT token_hash FROM staffmp_sessions WHERE staff_id = ${staffId} AND token_hash <> ${keep})`;
}

async function lockBinding(tx: Tx, openid: string | null, staffId: number) {
  if (openid !== null) await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`staffmp_openid:${openid}`}, 0))`;
  await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`staffmp_staff:${staffId}`}, 0))`;
}

/**
 * 把这个微信绑到这位员工（第 6 节，SP05）：
 *   · 这位员工原来绑着别的微信（自己换了手机）：旧的自动解开；
 *   · 这个微信现在绑着别人（例如在同事的手机上登录）：只有 replace 为真（员工在小程序上确认了「改绑」）才顶掉，
 *     被顶掉的人收到一条通知；没说要换绑的不动别人的绑定，返回 { taken: 那个人的名字 }。
 * 已经是这一对的不动，返回原来的绑定编号
 */
export async function bindWechat(sql: Sql, staffId: number, openid: string, opts: { ip: string; replace: boolean }): Promise<{ bindingId: number } | { taken: string }> {
  return withTx(sql, async (tx) => {
    await lockBinding(tx, openid, staffId);
    const live = await tx<{ id: number; staffId: number; openid: string; name: string }[]>`
      SELECT b.id, b.staff_id, b.openid, s.display_name AS name
      FROM staffmp_bindings b JOIN staff s ON s.id = b.staff_id
      WHERE b.revoked_at IS NULL AND (b.openid = ${openid} OR b.staff_id = ${staffId}) ORDER BY b.id FOR UPDATE OF b`;
    const same = live.find((b) => Number(b.staffId) === staffId && b.openid === openid);
    if (same) return { bindingId: Number(same.id) };
    const other = live.find((b) => b.openid === openid && Number(b.staffId) !== staffId);
    if (other && !opts.replace) return { taken: other.name };
    for (const b of live) {
      await tx`UPDATE staffmp_bindings SET revoked_at = now(), revoke_reason = 'rebind' WHERE id = ${b.id}`;
      // 换绑的那一个账号在小程序上的会话一起退出（这个微信改绑别人以后，原来那位的会话不能留在这台手机上）
      await dropStaffMpSessions(tx, Number(b.staffId));
      await writeAudit(tx, { staffId: Number(b.staffId), action: 'staffmp_wechat_unbound', targetType: 'staffmp_binding', targetId: b.id, detail: { reason: 'rebind', by: staffId }, ip: opts.ip });
      if (Number(b.staffId) !== staffId) {
        await notify(tx, [Number(b.staffId)], {
          kind: 'system',
          title: '你在员工小程序上的微信绑定已解开',
          body: '有人在你绑定的微信上登录了别的账号，并确认改绑。如果不是你本人知道的，请告诉人事，并改一下密码。',
        });
      }
    }
    const [row] = await tx<{ id: number }[]>`INSERT INTO staffmp_bindings (staff_id, openid) VALUES (${staffId}, ${openid}) RETURNING id`;
    const id = Number(row!.id);
    await writeAudit(tx, { staffId, action: 'staffmp_wechat_bound', targetType: 'staffmp_binding', targetId: id, detail: { replaced: other ? Number(other.staffId) : null }, ip: opts.ip });
    return { bindingId: id };
  });
}

/** 解开这位员工现在的绑定（员工自己、后台）；没有绑着的返回 false。小程序上的会话一起退出（exceptToken 留下员工自己这一个） */
export async function unbindWechat(
  sql: Sql,
  staffId: number,
  by: { reason: 'self' | 'admin'; adminId?: number; ip: string; bindingId?: number; exceptToken?: string; check?: (tx: Tx) => Promise<void> },
): Promise<boolean> {
  return withTx(sql, async (tx) => {
    await lockBinding(tx, null, staffId);
    // 后台解开：拿到锁以后再核对一次范围（等锁期间调了店的按调店后算）
    if (by.check) await by.check(tx);
    const [live] = await tx<{ id: number }[]>`
      SELECT id FROM staffmp_bindings WHERE staff_id = ${staffId} AND revoked_at IS NULL ${by.bindingId ? tx`AND id = ${by.bindingId}` : tx``} FOR UPDATE`;
    if (!live) return false;
    await tx`UPDATE staffmp_bindings SET revoked_at = now(), revoke_reason = ${by.reason}, revoked_by = ${by.adminId ?? null} WHERE id = ${live.id}`;
    await dropStaffMpSessions(tx, staffId, by.exceptToken);
    await writeAudit(tx, { staffId: by.adminId ?? staffId, action: 'staffmp_wechat_unbound', targetType: 'staffmp_binding', targetId: live.id, detail: { reason: by.reason, staffId }, ip: by.ip });
    return true;
  });
}

/** 「我是谁」（第 8.1 节）：姓名、岗位、部门、门店、要不要先改密码、能用哪些入口 */
export async function buildMe({ sql, config }: Deps, actor: Actor): Promise<StaffMpMe> {
  const storeId = actor.storeId ?? 1;
  const [row] = await sql<{ empNo: string | null; storeName: string | null; bound: boolean }[]>`
    SELECT (SELECT emp_no FROM staff_profiles WHERE staff_id = ${actor.id}) AS emp_no,
           (SELECT name FROM stores WHERE id = ${storeId}) AS store_name,
           EXISTS (SELECT 1 FROM staffmp_bindings WHERE staff_id = ${actor.id} AND revoked_at IS NULL) AS bound`;
  const def = isPositionKey(actor.position) ? positionOf(actor.position) : null;
  const department = def ? (ORG_DEPARTMENTS.find((d) => d.key === def.department)?.name ?? null) : null;
  return {
    staff: { id: actor.id, username: actor.username, displayName: actor.displayName, positionTitle: def?.title ?? null, department, empNo: row?.empNo ?? null },
    store: { id: storeId, name: row?.storeName ?? '' },
    mustChangePassword: actor.mustChangePassword,
    needsPosition: actor.needsPosition === true,
    wechatBound: row?.bound ?? false,
    entries: [...BASE_ENTRIES, ...(await canteenEntries(sql, config, actor.id))],
    today: businessDateOf(new Date(), config.timezone, 0),
    build: { version: config.version, commit: config.commit, instance: config.instance },
  };
}
