// 库存领域对外（8.2.6 起，后端评估第 2 节「别的领域只引用 index.ts」）：别的领域要用的库存函数从这里导出
export { logApproval } from './common';
export { createRequestIssue } from './docs';
export { loadPurchaseRules } from './purchase-rules';
