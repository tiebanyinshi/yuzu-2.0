// 学堂 · 谁在学、看得到什么（docs/ACADEMY.md 第 4、8 节，PENDING_DECISIONS XT02）：
//   · 只有在职员工能进（与员工培训一样：平板、他店、设计师等专用账号、系统账号、已离职的一律 403）；
//   · 上架的课全员看得到；「只本部门」的课只有那个部门与被指派到的人看得到；管理权限按编号能打开草稿、下架的（预览用），列表里照样只列上架的；
//   · 指派：全员 / 部门 / 岗位 / 个人四种对象，员工命中的指派合起来就是「我的必修 / 推荐」，入职、调岗以后自动带上。

import type { preHandlerAsyncHookHandler } from 'fastify';
import { can } from '@shared/permissions';
import type { Db, Sql } from '../../db';
import { guard } from '../../auth/guard';
import type { Actor } from '../../lib/context';
import { forbidden, notFound } from '../../lib/errors';
import { NOT_EMPLOYEE_ROLES, onDutyIds } from '../oa';

export const ACADEMY_MANAGE = 'academy.manage' as const;

/** 员工端接口的守卫：登录了、而且是在职员工 */
export function learnerGuard(sql: Sql): preHandlerAsyncHookHandler {
  const signedIn = guard();
  return async function (req, reply) {
    await signedIn.call(this, req, reply);
    if (NOT_EMPLOYEE_ROLES.includes(req.actor.role) || !(await onDutyIds(sql, [req.actor.id])).length) throw forbidden('这个账号不能进学堂');
  };
}

export interface Learner {
  id: number;
  /** 岗位所在的部门（org_departments.key）、岗位（position_catalog.key） */
  department: string | null;
  position: string | null;
  hireDate: string | null;
  canManage: boolean;
}

export async function learnerOf(db: Db, actor: Actor): Promise<Learner> {
  const [r] = await db<{ department: string | null; position: string | null; hireDate: string | null }[]>`
    SELECT pc.department, s.position, p.hire_date
    FROM staff s LEFT JOIN position_catalog pc ON pc.key = s.position LEFT JOIN staff_profiles p ON p.staff_id = s.id
    WHERE s.id = ${actor.id}`;
  return { id: actor.id, department: r?.department ?? null, position: r?.position ?? null, hireDate: r?.hireDate ?? null, canManage: can(actor, ACADEMY_MANAGE) };
}

/** 这条指派（别名 a）命中这位员工（只看生效中的） */
export const assignmentMatches = (db: Db, l: Pick<Learner, 'id' | 'department' | 'position'>) => db`
  a.active AND (
    a.audience = 'all'
    OR (a.audience = 'department' AND a.department_key = ${l.department})
    OR (a.audience = 'position' AND a.position_key = ${l.position})
    OR (a.audience = 'staff' AND a.staff_id = ${l.id}))`;

/** 被指派到的课（直接指派的课 + 指派的地图里的课） */
const assignedCourseIds = (db: Db, l: Learner) => db`
  SELECT COALESCE(a.course_id, pc.course_id) FROM academy_assignments a
  LEFT JOIN academy_path_courses pc ON pc.path_id = a.path_id
  WHERE ${assignmentMatches(db, l)}`;

/** 课程（别名 c）在列表里给这位员工看：上架，且不是「只本部门」或就是本部门、被指派到 */
export const courseListed = (db: Db, l: Learner) => db`
  c.status = 'published' AND (NOT c.dept_only OR c.department_key = ${l.department} OR c.id IN (${assignedCourseIds(db, l)}))`;

interface CourseAccessRow {
  id: number;
  title: string;
  status: string;
  deptOnly: boolean;
  departmentKey: string | null;
}

/** 按编号打开一门课：员工看列表里看得到的；管理权限能打开草稿、下架的（预览） */
export async function assertCourseOpen(db: Db, l: Learner, courseId: number): Promise<CourseAccessRow> {
  const [c] = await db<CourseAccessRow[]>`SELECT id, title, status, dept_only, department_key FROM academy_courses WHERE id = ${courseId}`;
  if (!c) throw notFound('没有这门课');
  if (l.canManage) return c;
  const [ok] = await db`SELECT 1 FROM academy_courses c WHERE c.id = ${courseId} AND ${courseListed(db, l)}`;
  if (!ok) throw forbidden(c.status === 'published' ? '这门课只给本部门的同事看' : '这门课还没上架');
  return c;
}
