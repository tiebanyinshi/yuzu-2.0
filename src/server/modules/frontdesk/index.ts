// 前台领域对外的入口（8.2.3 起新加的对外函数从这里导出；以前的引用照旧，check:gov 的 module-internal 只降不升）。

export { sweepRiskAlerts } from './guest';
