// 前台领域对外的入口（8.2.2 起：治理基线「别的领域只引用 <领域>/index.ts」）。新的跨领域引用从这里拿；已有的直接引用内部文件的照旧（存量只降不升）。
// 只导出公共的小工具，不导出 bills.ts（它引钟房，钟房又引这里，静态导出会绕成环）；要挂账的用 loadBills() 按需加载。

export { assertOpen, businessDate, hashRequest, lockVisits, runIdempotent, saveKey, setTxTimeouts } from './common';

/** 前台挂账（bills.ts）按需加载：钟房的派钟、加钟、换项目要用，静态引用会与钟房绕成环 */
export const loadBills = () => import('./bills');
