// 安保巡场领域对外的入口（新加的跨领域引用从这里走，check:gov 的 module-internal 只降不升）。
// 员工小程序线（docs/STAFF_MP.md 第 5.4 节）：员工小程序端口用员工账号对上的饭堂身份调这些（规则照巡场原来的）。

export { patrolAccess, patrolDayPortal, recordPatrolCheckin } from './core';
