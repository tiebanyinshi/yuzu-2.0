// 员工食堂 · 柚子饭堂领域对外的入口（新加的跨领域引用从这里走，check:gov 的 module-internal 只降不升）。
// 员工小程序线（docs/STAFF_MP.md 第 5.4 节）：员工小程序端口用员工账号对上的饭堂身份调这些（规则照饭堂原来的）。

export type { CanteenSessionEmployee } from './portal-auth';
export { destroyCanteenSession, loginCanteen } from './portal-auth';
export { createEmployee } from './employees';
export { employeeCodeKey } from './code';
export { canteenToday, mealsThisMonth, recordCheckin, searchPeople, voidCheckin } from './checkins';
export { likeDish, listMenus } from './menus';
export { loadCanteenSettings } from './settings';
