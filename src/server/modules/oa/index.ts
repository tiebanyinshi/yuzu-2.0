// 员工办公（OA）领域对外的入口（8.2.3 起新加的引用从这里走；以前的引用照旧，check:gov 的 module-internal 只降不升）。

export { notify } from './notifications';
// 在职员工的判断（学堂与员工培训一样只给在职员工用，docs/ACADEMY.md 第 8 节）
export { onDuty, onDutyIds } from './im';
export { NOT_EMPLOYEE_ROLES } from './org';
