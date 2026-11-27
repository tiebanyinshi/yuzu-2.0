// 前台领域给别的领域用的入口（工程治理 module-internal：别的领域只引用 <领域>/index.ts）。
// 8.2.2 起新写的跨领域引用从这里取；原来直接引用内部文件的照旧，改到时再挪过来。
// 不静态导出 bills.ts、checkout.ts（它们引钟房、桌台，钟房又引这里，静态导出会绕成环、模块初始化时报错）；要用的按需加载。

export { assertOpen, businessDate, hashRequest, lockVisits, runIdempotent, saveKey, setTxTimeouts } from './common';
export { sweepRiskAlerts } from './guest';
export { assertNotAwayLocked, sweepAwayLocks } from './away-lock';
export { insertAutoDiscount } from './line-discounts';
export { visitTicket } from './tickets';

/** 前台挂账（bills.ts）按需加载：钟房的派钟、加钟、换项目要用，静态引用会与钟房绕成环 */
export const loadBills = () => import('./bills');

/** 前台结账（checkout.ts）按需加载：桌台返台要用反结账，静态引用会与桌台、钟房绕成环 */
export const loadCheckout = () => import('./checkout');
