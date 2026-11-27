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
import { canScan, mealAt } from '@shared/canteen';
import type { StaffMpCanteenStatus } from '@shared/staffmp';
import type { Db, Sql, Tx } from '../../db';
import { isUniqueViolation } from '../../db';
import type { Actor, Deps } from '../../lib/context';
import { guard } from '../../auth/guard';
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

/**
 * 开通饭卡时用的工号：人事档案的工号（大写、合法、还没被饭堂名单用掉），不然用 S + 系统账号编号。
 * 那个工号上已经有一张「这个人上次在小程序开通、还没对上」的饭卡（建好了、记对上时出错；或者两次请求同时到）时照旧用它：
 * 饭堂的 createEmployee 对同工号同姓名同部门同角色回原来那张（created: false），这样重试与并发都落在同一张饭卡上，不会多开一张。
 */
async function empNoFor(db: Db, staffId: number, name: string): Promise<string> {
  const [p] = await db<{ empNo: string | null }[]>`SELECT emp_no FROM staff_profiles WHERE staff_id = ${staffId}`;
  const fromProfile = (p?.empNo ?? '').toUpperCase();
  if (/^[A-Z0-9][A-Z0-9-]{0,15}$/.test(fromProfile)) {
    const [taken] = await db<{ mine: boolean }[]>`
      SELECT (e.created_by = ${staffId} AND e.name = ${name} AND e.role = 'staff' AND e.department_id IS NULL AND e.active
              AND NOT EXISTS (SELECT 1 FROM staffmp_canteen_links l WHERE l.employee_id = e.id)) AS mine
      FROM canteen_employees e WHERE e.emp_no = ${fromProfile}`;
    if (!taken || taken.mine) return fromProfile;
  }
  return `S${staffId}`;
}

async function lockStaff(db: Db, staffId: number) {
  await db`SELECT pg_advisory_xact_lock(hashtextextended(${`staffmp_staff:${staffId}`}, 0))`;
}

/** 记下对上（一人一个、一卡一人：撞了约束说清楚）；这个人已经对上的就是这一张时不重记，返回 false */
async function link(sql: Sql, staffId: number, employeeId: number, method: 'password' | 'created' | 'admin', by: number, ip: string, check?: (tx: Tx) => Promise<void>): Promise<boolean> {
  try {
    return await withTx(sql, async (tx) => {
      await lockStaff(tx, staffId);
      // 后台对上：拿到锁以后再核对一次范围（只有 hr.org 的只能动自己门店范围里的员工）
      if (check) await check(tx);
      const [had] = await tx<{ employeeId: number }[]>`SELECT employee_id FROM staffmp_canteen_links WHERE staff_id = ${staffId}`;
      // 同一个人对同一张饭卡再记一次（开通的重试、两次请求同时到）：已经是这样了，不报错、不重复记审计
      if (had && Number(had.employeeId) === employeeId) return false;
      if (had) throw conflict('CANTEEN_ALREADY_LINKED', '你已经对上一张饭卡了');
      await tx`INSERT INTO staffmp_canteen_links (staff_id, employee_id, method, linked_by) VALUES (${staffId}, ${employeeId}, ${method}, ${by})`;
      await writeAudit(tx, { staffId: by, action: 'staffmp_canteen_linked', targetType: 'canteen_employee', targetId: employeeId, detail: { staffId, method }, ip });
      return true;
    });
  } catch (error) {
    if (isUniqueViolation(error)) throw conflict('CANTEEN_TAKEN', '这张饭卡已经对给别的同事了：如果是你的，请找食堂负责人或人事');
    throw error;
  }
}

export function registerStaffMpCanteenRoutes(app: FastifyInstance, deps: Deps, now: () => number = Date.now) {
  const { sql, config } = deps;
  // 与 WCP 员工端的接口同一个关卡（auth/guard）：没登录 401；首次登录没改密码、老账号没选新岗位的，吃饭与巡场的接口一律不放行
  // （小程序会带去改密码、选岗位，但不能只靠小程序：直接调接口也拿不到码钥匙、交不了巡场）
  const ready = { preHandler: guard() };
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

  /** 对上了的饭卡与这一餐打过卡没有 */
  const statusOf = async (staffId: number): Promise<StaffMpCanteenStatus> => {
    const e = await linkedEmployee(sql, staffId);
    if (!e) return { open: true, linked: false, employee: null, currentMeal: null };
    const current = mealAt((await loadCanteenSettings(sql)).meals, new Date(now()), config.timezone);
    let currentMeal: StaffMpCanteenStatus['currentMeal'] = null;
    if (current) {
      const [hit] = await sql`SELECT 1 FROM canteen_checkins WHERE employee_id = ${e.id} AND meal_date = ${current.date} AND meal = ${current.meal} AND voided_at IS NULL`;
      currentMeal = { meal: current.meal, date: current.date, checkedIn: !!hit };
    }
    return { open: true, linked: true, employee: { name: e.name, empNo: e.empNo, role: e.role }, currentMeal };
  };

  app.get('/api/staffmp/canteen/status', ready, async (req): Promise<StaffMpCanteenStatus> => {
    const actor = signedIn(req);
    if (!(await canteenReady(sql, config))) return { open: false, linked: false, employee: null, currentMeal: null };
    return statusOf(actor.id);
  });

  /** 以前登记过：输一次饭堂的账号与密码证明是自己（走饭堂原来的核对与失败计数），对上以后不留饭堂的会话 */
  app.post('/api/staffmp/canteen/link', ready, async (req): Promise<StaffMpCanteenStatus> => {
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
    return statusOf(actor.id);
  });

  /** 没登记过：用系统账号的姓名开一个普通员工的饭卡（厨师、负责人、巡场部门只由后台安排） */
  app.post('/api/staffmp/canteen/create', ready, async (req): Promise<StaffMpCanteenStatus> => {
    const actor = signedIn(req);
    await open();
    if (await linkedEmployee(sql, actor.id)) throw conflict('CANTEEN_ALREADY_LINKED', '你已经对上一张饭卡了');
    const name = actor.displayName.slice(0, 16);
    // 饭堂的 createEmployee 自己开事务（主线的函数，员工小程序线不改它），所以建饭卡与记对上分两步：
    // 第二步出错或两次请求同时到时，靠 empNoFor 选回同一个工号、createEmployee 回原来那张、link 对同一张不报错，落在同一张饭卡上
    const { employee } = await createEmployee(sql, { empNo: await empNoFor(sql, actor.id, name), name, role: 'staff', departmentId: null }, { actor, ip: req.ip });
    await link(sql, actor.id, employee.id, 'created', actor.id, req.ip);
    return statusOf(actor.id);
  });

  /** 饭卡码的钥匙与吃饭的基本信息（与柚子饭堂网页的「我是谁」同一套：码钥匙只在这台手机上用来生成饭卡码） */
  app.get('/api/staffmp/canteen/me', ready, async (req): Promise<CanteenMe> => {
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

  app.get('/api/staffmp/canteen/menus', ready, async (req) => {
    const e = await mine(req);
    const q = parse(MenusQuery, req.query ?? {});
    return listMenus(sql, q.from, q.to, { drafts: false, viewerId: e.id });
  });

  app.put('/api/staffmp/canteen/likes', ready, async (req) => likeDish(sql, await mine(req), req.body));

  // ── 食堂负责人 ──
  app.get('/api/staffmp/canteen/today', ready, async (req) => {
    await manager(req);
    return canteenToday(sql, config, now());
  });
  app.get('/api/staffmp/canteen/people', ready, async (req) => {
    await manager(req);
    return searchPeople(sql, config, parse(PeopleQuery, req.query ?? {}).q, now());
  });
  app.post('/api/staffmp/canteen/checkins', ready, async (req) => recordCheckin({ sql, config }, await manager(req), req.body, now()));
  app.post('/api/staffmp/canteen/checkins/:id/void', ready, async (req) => {
    const e = await manager(req);
    return voidCheckin(sql, parse(idParam, req.params).id, req.body, { employee: e }, config.timezone);
  });

  // ── 巡场（巡场部门的人、后台指定能看记录的人；名单当场核对，由巡场原来的函数管） ──
  app.get('/api/staffmp/canteen/patrol/day', ready, async (req) => {
    const e = await mine(req);
    await patrolOpen();
    return patrolDayPortal(sql, config, e, parse(PatrolDayQuery, req.query ?? {}), now());
  });
  app.post('/api/staffmp/canteen/patrol/checkins', ready, async (req) => {
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
    // 解开（多半是对错了人）：这张饭卡的码钥匙作废（code_epoch 加一，与饭堂停用、改密码同一个做法），
    // 对错的那台手机上存着的码钥匙离线也亮不出能用的码；饭卡本人的手机、网页联网时自动换新钥匙
    await tx`UPDATE canteen_employees SET code_epoch = code_epoch + 1, updated_at = now() WHERE id = ${row.employeeId}`;
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
      // 已经对上的就是这一张：算跳过（和原来一样），不算新对上
      if (await link(sql, p.staffId, p.employeeId, 'admin', by, ip, (tx) => check(tx, p.staffId))) linked += 1;
      else skipped += 1;
    } catch (error) {
      if (error instanceof AppError && error.status === 409) skipped += 1;
      else throw error;
    }
  }
  return { linked, skipped };
}
