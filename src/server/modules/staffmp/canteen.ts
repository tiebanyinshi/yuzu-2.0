// 吃饭与巡场（员工小程序线 E，docs/STAFF_MP.md 第 5.4 节，SP10）：员工小程序用系统账号登录，柚子饭堂与巡场用饭堂自己的员工名单。
// 这里按 staffmp_canteen_links 找到这位员工的饭堂身份，照调饭堂与巡场原来的函数（规则一样：一人一餐一次、码 30 秒一换、巡场一轮一次）。
//   · 对上：员工用旧饭堂账号密码证明是自己（走饭堂原来的登录核对与失败计数，核对完不留饭堂的会话）；没登记过的开一个普通员工的饭卡；
//     后台按手机号预先对好一批（admin.ts）。厨师、负责人、巡场部门这些身份只由后台安排，开通的新饭卡不带；
//   · 每个请求当场核对：员工食堂开着、门店系统配了饭卡码的密钥、对上的饭卡还启用着；巡场另看「安保巡场」开着、这个人在不在名单里。
// 加锁（docs/LOCKING.md 第 10 节）：对上、开通先拿这位员工的咨询锁（staffmp_staff:<编号>），一人一个、一卡一人由主键与唯一约束兜底。

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { businessDateOf } from '@shared/business-date';
import type { CanteenMe } from '@shared/canteen';
import { canScan } from '@shared/canteen';
import type { StaffMpCanteenStatus } from '@shared/staffmp';
import type { Db, Sql, Tx } from '../../db';
import { isUniqueViolation } from '../../db';
import type { Actor, Deps } from '../../lib/context';
import { writeAudit } from '../../lib/audit';
import { AppError, conflict, unauthorized } from '../../lib/errors';
import { withTx } from '../../lib/tx';
import { idParam, parse } from '../../lib/validate';
import type { CanteenSessionEmployee } from '../canteen';
import {
  canteenToday,
  createEmployee,
  destroyCanteenSession,
  employeeCodeKey,
  likeDish,
  listMenus,
  loadCanteenSettings,
  loginCanteen,
  mealsThisMonth,
  recordCheckin,
  searchPeople,
  voidCheckin,
} from '../canteen';
import { enabledErpModules } from '../erp';
import { patrolAccess, patrolDayPortal, recordPatrolCheckin } from '../patrol';

/** 员工食堂开着、门店系统配了饭卡码的密钥（没配就生成不了码钥匙） */
export async function canteenReady(db: Db, config: Deps['config']): Promise<boolean> {
  if (!config.canteen.codeSecret) return false;
  return (await enabledErpModules(db)).has('canteen');
}

/** 这位员工对上的饭堂身份（饭卡停用了、没对上的为空） */
export async function linkedEmployee(db: Db, staffId: number): Promise<CanteenSessionEmployee | null> {
  const [row] = await db<CanteenSessionEmployee[]>`
    SELECT e.id, e.emp_no, e.name, e.role, e.avatar, e.department_id, e.code_epoch
    FROM staffmp_canteen_links l JOIN canteen_employees e ON e.id = l.employee_id
    WHERE l.staff_id = ${staffId} AND e.active`;
  return row ? { ...row, id: Number(row.id), departmentId: row.departmentId == null ? null : Number(row.departmentId) } : null;
}

/** 「我是谁」里吃饭、巡场的入口（工作台按它显示；每个接口照旧当场核对） */
export async function canteenEntries(db: Db, config: Deps['config'], staffId: number): Promise<('canteen' | 'canteenScan' | 'patrol' | 'patrolLog')[]> {
  if (!(await canteenReady(db, config))) return [];
  const out: ('canteen' | 'canteenScan' | 'patrol' | 'patrolLog')[] = ['canteen'];
  const e = await linkedEmployee(db, staffId);
  if (!e) return out;
  if (canScan(e.role)) out.push('canteenScan');
  if ((await enabledErpModules(db)).has('patrol')) {
    const a = await patrolAccess(db, e.id);
    if (a.scan) out.push('patrol');
    if (a.view) out.push('patrolLog');
  }
  return out;
}

const LinkInput = z.object({ account: z.string().trim().min(1, '请输入饭堂的账号').max(40), password: z.string().min(1, '请输入饭堂的密码').max(200) });
const PatrolDayQuery = z.object({ date: z.string().optional() });
const MenusQuery = z.object({ from: z.string().optional(), to: z.string().optional() });
const PeopleQuery = z.object({ q: z.string().optional() });

/** 开通饭卡时用的工号：人事档案的工号（大写、合法、还没被饭堂名单用掉），不然用 S + 系统账号编号 */
async function empNoFor(db: Db, staffId: number): Promise<string> {
  const [p] = await db<{ empNo: string | null }[]>`SELECT emp_no FROM staff_profiles WHERE staff_id = ${staffId}`;
  const fromProfile = (p?.empNo ?? '').toUpperCase();
  if (/^[A-Z0-9][A-Z0-9-]{0,15}$/.test(fromProfile)) {
    const [taken] = await db`SELECT 1 FROM canteen_employees WHERE emp_no = ${fromProfile}`;
    if (!taken) return fromProfile;
  }
  return `S${staffId}`;
}

async function lockStaff(db: Db, staffId: number) {
  await db`SELECT pg_advisory_xact_lock(hashtextextended(${`staffmp_staff:${staffId}`}, 0))`;
}

/** 记下对上（一人一个、一卡一人：撞了约束说清楚） */
async function link(sql: Sql, staffId: number, employeeId: number, method: 'password' | 'created' | 'admin', by: number, ip: string, check?: (tx: Tx) => Promise<void>): Promise<void> {
  try {
    await withTx(sql, async (tx) => {
      await lockStaff(tx, staffId);
      // 后台对上：拿到锁以后再核对一次范围（只有 hr.org 的只能动自己门店范围里的员工）
      if (check) await check(tx);
      const [had] = await tx`SELECT 1 FROM staffmp_canteen_links WHERE staff_id = ${staffId}`;
      if (had) throw conflict('CANTEEN_ALREADY_LINKED', '你已经对上一张饭卡了');
      await tx`INSERT INTO staffmp_canteen_links (staff_id, employee_id, method, linked_by) VALUES (${staffId}, ${employeeId}, ${method}, ${by})`;
      await writeAudit(tx, { staffId: by, action: 'staffmp_canteen_linked', targetType: 'canteen_employee', targetId: employeeId, detail: { staffId, method }, ip });
    });
  } catch (error) {
    if (isUniqueViolation(error)) throw conflict('CANTEEN_TAKEN', '这张饭卡已经对给别的同事了：如果是你的，请找食堂负责人或人事');
    throw error;
  }
}

export function registerStaffMpCanteenRoutes(app: FastifyInstance, deps: Deps, now: () => number = Date.now) {
  const { sql, config } = deps;
  const signedIn = (req: FastifyRequest): Actor => {
    if (!req.hasSession) throw unauthorized('请先登录');
    return req.actor;
  };
  const open = async () => {
    if (!(await canteenReady(sql, config))) throw new AppError(503, 'CANTEEN_CLOSED', '饭堂还没开张：请管理员在「ERP 设置 → 模块开关」里打开「员工食堂」');
  };
  /** 对上的饭堂身份；没对上的回 CANTEEN_NOT_LINKED（小程序去对上） */
  const mine = async (req: FastifyRequest): Promise<CanteenSessionEmployee> => {
    const actor = signedIn(req);
    await open();
    const e = await linkedEmployee(sql, actor.id);
    if (!e) throw conflict('CANTEEN_NOT_LINKED', '还没对上饭卡：先说一下你以前有没有在柚子饭堂登记过');
    return e;
  };
  const manager = async (req: FastifyRequest) => {
    const e = await mine(req);
    if (!canScan(e.role)) throw new AppError(403, 'FORBIDDEN', '只有食堂负责人能扫码登记');
    return e;
  };
  const patrolOpen = async () => {
    if (!(await enabledErpModules(sql)).has('patrol')) throw new AppError(503, 'PATROL_CLOSED', '巡场还没开：请管理员在「ERP 设置 → 模块开关」里打开「安保巡场」');
  };

  app.get('/api/staffmp/canteen/status', async (req): Promise<StaffMpCanteenStatus> => {
    const actor = signedIn(req);
    if (!(await canteenReady(sql, config))) return { open: false, linked: false, employee: null };
    const e = await linkedEmployee(sql, actor.id);
    return { open: true, linked: !!e, employee: e ? { name: e.name, empNo: e.empNo, role: e.role } : null };
  });

  /** 以前登记过：输一次饭堂的账号与密码证明是自己（走饭堂原来的核对与失败计数），对上以后不留饭堂的会话 */
  app.post('/api/staffmp/canteen/link', async (req): Promise<StaffMpCanteenStatus> => {
    const actor = signedIn(req);
    await open();
    const { account, password } = parse(LinkInput, req.body);
    // 饭堂账号密码不对时饭堂原来的函数回 401：在员工小程序端口上 401 是「登录过期」，这里改成 422（文字照旧），免得小程序当成要重新登录
    const { token, employeeId } = await loginCanteen(sql, { account, password }, { ip: req.ip, userAgent: 'staffmp link' }).catch((error: unknown) => {
      if (error instanceof AppError && error.status === 401) throw new AppError(422, 'CANTEEN_LOGIN_FAILED', error.message);
      throw error;
    });
    await destroyCanteenSession(sql, token);
    await link(sql, actor.id, employeeId, 'password', actor.id, req.ip);
    const e = await linkedEmployee(sql, actor.id);
    return { open: true, linked: !!e, employee: e ? { name: e.name, empNo: e.empNo, role: e.role } : null };
  });

  /** 没登记过：用系统账号的姓名开一个普通员工的饭卡（厨师、负责人、巡场部门只由后台安排） */
  app.post('/api/staffmp/canteen/create', async (req): Promise<StaffMpCanteenStatus> => {
    const actor = signedIn(req);
    await open();
    if (await linkedEmployee(sql, actor.id)) throw conflict('CANTEEN_ALREADY_LINKED', '你已经对上一张饭卡了');
    const name = actor.displayName.slice(0, 16);
    const { employee } = await createEmployee(sql, { empNo: await empNoFor(sql, actor.id), name, role: 'staff', departmentId: null }, { actor, ip: req.ip });
    await link(sql, actor.id, employee.id, 'created', actor.id, req.ip);
    return { open: true, linked: true, employee: { name: employee.name, empNo: employee.empNo, role: employee.role } };
  });

  /** 饭卡码的钥匙与吃饭的基本信息（与柚子饭堂网页的「我是谁」同一套：码钥匙只在这台手机上用来生成饭卡码） */
  app.get('/api/staffmp/canteen/me', async (req): Promise<CanteenMe> => {
    const e = await mine(req);
    const settings = await loadCanteenSettings(sql);
    const at = new Date(now());
    const today = businessDateOf(at, config.timezone, 0);
    const [d] = await sql<{ department: string }[]>`SELECT coalesce(name, '') AS department FROM departments WHERE id = ${e.departmentId ?? 0}`;
    const apps = (await enabledErpModules(sql)).has('patrol') ? await patrolAccess(sql, e.id) : { scan: false, view: false };
    return {
      employee: { id: e.id, empNo: e.empNo, name: e.name, department: d?.department ?? '', role: e.role, avatar: e.avatar, username: null, source: 'admin' },
      codeKey: employeeCodeKey(config.canteen.codeSecret!, e.id, e.codeEpoch).toString('base64url'),
      codeEpoch: e.codeEpoch,
      serverTime: at.toISOString(),
      today,
      meals: settings.meals,
      mealsThisMonth: await mealsThisMonth(sql, e.id, today),
      apps: [...(apps.scan ? (['patrol'] as const) : []), ...(apps.view ? (['patrolLog'] as const) : [])],
    };
  });

  app.get('/api/staffmp/canteen/menus', async (req) => {
    const e = await mine(req);
    const q = parse(MenusQuery, req.query ?? {});
    return listMenus(sql, q.from, q.to, { drafts: false, viewerId: e.id });
  });

  app.put('/api/staffmp/canteen/likes', async (req) => likeDish(sql, await mine(req), req.body));

  // ── 食堂负责人 ──
  app.get('/api/staffmp/canteen/today', async (req) => {
    await manager(req);
    return canteenToday(sql, config, now());
  });
  app.get('/api/staffmp/canteen/people', async (req) => {
    await manager(req);
    return searchPeople(sql, config, parse(PeopleQuery, req.query ?? {}).q, now());
  });
  app.post('/api/staffmp/canteen/checkins', async (req) => recordCheckin({ sql, config }, await manager(req), req.body, now()));
  app.post('/api/staffmp/canteen/checkins/:id/void', async (req) => {
    const e = await manager(req);
    return voidCheckin(sql, parse(idParam, req.params).id, req.body, { employee: e }, config.timezone);
  });

  // ── 巡场（巡场部门的人、后台指定能看记录的人；名单当场核对，由巡场原来的函数管） ──
  app.get('/api/staffmp/canteen/patrol/day', async (req) => {
    const e = await mine(req);
    await patrolOpen();
    return patrolDayPortal(sql, config, e, parse(PatrolDayQuery, req.query ?? {}), now());
  });
  app.post('/api/staffmp/canteen/patrol/checkins', async (req) => {
    const e = await mine(req);
    await patrolOpen();
    return recordPatrolCheckin({ sql, config }, e, req.body, now());
  });
}

/** 后台解开（员工换岗、对错了）：删对上的那一行；饭堂名单与记录不动 */
export async function unlinkCanteen(sql: Sql, staffId: number, by: number, ip: string, check?: (tx: Tx) => Promise<void>): Promise<boolean> {
  return withTx(sql, async (tx) => {
    await lockStaff(tx, staffId);
    if (check) await check(tx);
    const [row] = await tx<{ employeeId: number }[]>`DELETE FROM staffmp_canteen_links WHERE staff_id = ${staffId} RETURNING employee_id`;
    if (!row) return false;
    await writeAudit(tx, { staffId: by, action: 'staffmp_canteen_unlinked', targetType: 'canteen_employee', targetId: row.employeeId, detail: { staffId }, ip });
    return true;
  });
}

/** 后台预先对好（按手机号核对过的一批）：已经对上的、饭卡已经对给别人的跳过 */
export async function linkCanteenByAdmin(
  sql: Sql,
  pairs: readonly { staffId: number; employeeId: number }[],
  by: number,
  ip: string,
  check: (tx: Tx, staffId: number) => Promise<void>,
): Promise<{ linked: number; skipped: number }> {
  let linked = 0;
  let skipped = 0;
  for (const p of pairs) {
    try {
      await link(sql, p.staffId, p.employeeId, 'admin', by, ip, (tx) => check(tx, p.staffId));
      linked += 1;
    } catch (error) {
      if (error instanceof AppError && error.status === 409) skipped += 1;
      else throw error;
    }
  }
  return { linked, skipped };
}
