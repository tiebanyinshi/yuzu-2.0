import { guard } from './auth/guard';
import { jobStatuses } from './jobs';
import { baseServerOptions, installErrorHandler, installRequestId } from './lib/http-kit';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import cookie from '@fastify/cookie';
import { z } from 'zod';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance } from 'fastify';
import type { AppConfig } from './config';
import type { Sql } from './db';
import { registerGrantRoutes } from './auth/grants';
import { registerAuthRoutes } from './auth/routes';
import { SESSION_COOKIE, resolveSession } from './auth/session';
import { AppError } from './lib/errors';
import { createProtection } from './lib/protect';
import { decodedPath, isApiRequest, routePath } from './lib/paths';
import type { Deps } from './lib/context';
import { DEFAULT_STORE_ID, runInStore } from './lib/store-context';
import { registerAdminRoutes } from './modules/admin';
import { registerPositionCatalogRoutes } from './modules/position-catalog';
import { registerRoomOrderRoutes } from './modules/room-orders';
import { registerPriceCatalogRoutes } from './modules/price-catalog';
import { registerTechBoardRoutes } from './modules/tech-board';
import type { PingReply } from '@shared/resilience';
import { registerAuditRoutes } from './modules/audit';
import { registerClientErrorRoutes } from './modules/client-errors';
import { registerCatalogRoutes } from './modules/catalog';
import { registerFrontdeskRoutes } from './modules/frontdesk/routes';
import { registerDeptStockRoutes } from './modules/inventory/dept-stock';
import { registerDocRoutes } from './modules/inventory/docs';
import { registerReceiptImportRoutes } from './modules/inventory/direct-import';
import { registerLedgerImportRoutes } from './modules/inventory/ledger-import';
import { registerMasterRoutes } from './modules/inventory/master';
import { registerPayableRoutes } from './modules/inventory/payables';
import { registerCycleRoutes } from './modules/inventory/cycles';
import { registerImportRoutes } from './modules/inventory/imports';
import { registerExpenseRoutes } from './modules/expenses';
import { registerBudgetRoutes } from './modules/budgets';
import { registerInvoiceRoutes } from './modules/invoices';
import { registerErpOpsRoutes } from './modules/erp-ops';
import { registerPurchaseLedgerRoutes } from './modules/purchase-ledger';
import { registerLegacyRoutes } from './modules/legacy';
import { registerRequestRoutes } from './modules/requests';
import { authenticateMall, isMallPath, registerMallRoutes } from './modules/mall';
import { registerShopRoutes } from './modules/shop';
import { registerDesignRoutes } from './modules/design';
import { registerRequestStockRoutes } from './modules/request-stock';
import { registerRequestImportRoutes } from './modules/request-import';
import { registerRequestDraftRoutes } from './modules/request-drafts';
import { registerRequestSheetRoutes } from './modules/request-sheet';
import { registerPurchasingRoutes } from './modules/inventory/purchasing';
import { registerUrgentContractRoutes } from './modules/inventory/urgent-contract';
import { registerPurchaseRulesRoutes } from './modules/inventory/purchase-rules';
import { registerFileRoutes } from './modules/inventory/files';
import { registerAttachmentRoutes } from './modules/inventory/attachments';
import { registerAdmissionRoutes } from './modules/inventory/admission';
import { registerScoreRoutes } from './modules/inventory/scores';
import { registerSlowRoutes } from './modules/inventory/slow';
import { registerReconLinkRoutes } from './modules/inventory/recon-links';
import { registerSupplierPortalRoutes } from './modules/inventory/supplier-portal';
import { registerPayTerminalRoutes } from './modules/pay-terminal';
import { registerPlatformVerifyRoutes } from './modules/platform-verify';
import { registerOtaRoutes } from './modules/ota';
import { registerIntegrationsAdminRoutes } from './modules/integrations-admin';
import { registerReceivableRoutes } from './modules/receivables';
import { registerAssetRoutes } from './modules/assets';
import { registerExpiryRoutes } from './modules/inventory/expiry';
import { registerCompareRoutes } from './modules/inventory/compare';
import { registerGiftRoutes } from './modules/inventory/gifts';
import { registerTransferRoutes } from './modules/inventory/transfers';
import { registerPettyAccountRoutes } from './modules/petty-accounts';
import { registerPettyUseRoutes } from './modules/petty-uses';
import { registerReplenishRoutes } from './modules/inventory/replenish';
import { registerSourcingRoutes } from './modules/inventory/sourcing';
import { registerPurchaseFlowRoutes } from './modules/purchase-flow';
import { registerApprovalRoutes } from './modules/approvals/routes';
import { registerContractRoutes } from './modules/contracts/routes';
import { registerTemplateRoutes } from './modules/contracts/templates';
import { registerContractDocRoutes } from './modules/contracts/doc-templates';
import { registerPaymentRoutes } from './modules/payments/routes';
import { registerReportRoutes } from './modules/inventory/reports';
import { registerLedgerRoutes } from './modules/ledger';
import { registerOrderRoutes } from './modules/orders';
import { registerMemberRoutes } from './modules/members';
import { registerMemberTagRoutes } from './modules/member-tags';
import { registerCustomFieldRoutes } from './modules/custom-fields';
import { registerSalesInvoiceRoutes } from './modules/sales-invoices';
import { registerBankRoutes } from './modules/bank';
import { registerPaymentBatchRoutes } from './modules/payment-batches';
import { registerMemberRecordRoutes } from './modules/member-records';
import { registerCouponRoutes } from './modules/coupons';
import { registerCouponLedgerRoutes } from './modules/coupon-ledger';
import { registerGiftCardRoutes } from './modules/gift-cards';
import { registerSignGiftRoutes } from './modules/gifts';
import { registerCampaignRoutes } from './modules/coupon-campaigns';
import { registerGiftOutRoutes } from './modules/gift-outs';
import { registerStockUsageRoutes } from './modules/stock-usage';
import { registerLinenRoutes } from './modules/linen';
import { registerCostRoutes } from './modules/inventory/cost';
import { registerAutoReplenishRoutes } from './modules/inventory/auto-replenish';
import { registerCouponUsageRoutes } from './modules/coupon-usage';
import { registerMarketingCostRoutes } from './modules/marketing-cost';
import { registerMembershipRoutes } from './modules/membership';
import { registerBenefitRoutes } from './modules/benefits';
import { registerVipLockerRoutes } from './modules/vip-lockers';
import { registerLockerRoutes } from './modules/lockers';
import { registerBenefitTierRoutes } from './modules/benefit-tiers';
import { registerTrialRoutes } from './modules/member-trials';
import { registerDeviceRoutes } from './modules/devices';
import { registerOpeningRoutes } from './modules/opening';
import { registerMemberHistoryRoutes } from './modules/member-history';
import { registerPrintRoutes } from './modules/print';
import { registerShiftRoutes } from './modules/shifts';
import { registerDashboardRoutes } from './modules/dashboard';
import { registerDashboardReportRoutes } from './modules/reports';
import { registerSettingsRoutes } from './modules/settings';
import { registerStoreRoutes } from './modules/stores';
import { registerWecomRoutes } from './modules/wecom';
import { registerAiRoutes } from './modules/ai';
import { registerSettlementRoutes } from './modules/settlement';
import { registerStaffRoutes } from './modules/staff';
import { registerOaOrgRoutes } from './modules/oa/org';
import { registerTrainingRoutes } from './modules/training';
import { registerGovflowRoutes } from './modules/govflow/routes';
import { registerSupplyRoutes } from './modules/govflow/supply';
import { registerPettyRoutes } from './modules/govflow/petty';
import { registerContractRoutes as registerGfContractRoutes } from './modules/govflow/contracts';
import { registerPaymentRoutes as registerGfPaymentRoutes } from './modules/govflow/payments';
import { registerExpenseRoutes as registerGfExpenseRoutes } from './modules/govflow/expense';
import { registerHrRoutes as registerGfHrRoutes } from './modules/govflow/hr';
import { registerOaStaffImportRoutes } from './modules/oa/staff-import';
import { registerOaAttendanceSetupRoutes } from './modules/oa/attendance-setup';
import { registerOaAttendanceDailyRoutes } from './modules/oa/attendance-daily';
import { registerOaAttendanceMonthlyRoutes } from './modules/oa/attendance-monthly';
import { registerOaHolidayRoutes } from './modules/oa/holidays';
import { registerOaImRoutes } from './modules/oa/im';
import { registerOaImGroupRoutes } from './modules/oa/im-groups';
import { registerOaDirectoryRoutes } from './modules/oa/directory';
import { registerOaLeaveRoutes } from './modules/oa/leave';
import { registerOaApprovalRoutes } from './modules/oa/approvals';
import { registerOaApprovalAdminRoutes } from './modules/oa/approval-admin';
import { registerOaPayrollRoutes } from './modules/oa/payroll';
import { registerOaFaceRoutes } from './modules/oa/faces';
import { registerOaPunchRoutes } from './modules/oa/punches';
import { registerOaScheduleRoutes } from './modules/oa/schedules';
import { registerOaScheduleGrantRoutes } from './modules/oa/schedule-grants';
import { registerOaGeoRoutes } from './modules/oa/geo';
import { registerOaNotificationRoutes } from './modules/oa/notifications';
import { registerOaAnnouncementRoutes } from './modules/oa/announcements';
import { registerOaAttachmentRoutes } from './modules/oa/attachments';
import { registerTechnicianRoutes } from './modules/technicians';
import { registerTechnicianAdminRoutes } from './modules/technician-admin';
import { registerTechnicianRankingRoutes } from './modules/technician-ranking';
import { registerClockroomRoutes } from './modules/clockroom-routes';
import { registerDiningRoutes } from './modules/dining';
import { registerTableRoutes } from './modules/tables';
import { registerTableChargeRoutes } from './modules/table-charges';
import { registerTablesV8224Routes } from './modules/tables-v8224';
import { registerMealEntryRoutes } from './modules/dining-meals';
import { registerDining808Routes } from './modules/dining-808';
import { registerDiningReceiptRoutes } from './modules/dining-receipt';
import { registerEmenuRoutes } from './modules/emenu/routes';
import { registerStudioRoutes } from './modules/studio';
import { registerRoomRoutes } from './modules/rooms';
import { registerSpaceRoutes } from './modules/spaces';
import { registerFloorplanRoutes } from './modules/floorplans';
import { registerFloorMapRoutes } from './modules/floormap';
import { registerUsageRoutes } from './modules/usages';
import { registerBookingRoutes } from './modules/bookings';
import { registerCountCardRoutes } from './modules/count-cards';
import { registerMemberCardRoutes } from './modules/member-cards';
import { registerPlatformRoutes } from './modules/platform-redemptions';
import { registerGuideRoutes } from './modules/guide';
import { registerLocationRoutes } from './modules/locations';
import { registerCommissionRoutes } from './modules/commission';
import { registerTechnicianStatsRoutes } from './modules/technician-stats';
import { registerTechnicianWebImportRoutes } from './modules/technician-import-web';
import { registerWalletRoutes } from './modules/wallet';
import { registerMemberRefundRoutes } from './modules/member-refunds';
import { registerMemberAdminRoutes } from './modules/member-admin';
import { registerErpModuleGate, registerErpRoutes } from './modules/erp';
import { registerMpStaffRoutes } from './modules/mp/staff';
import { registerCanteenAdminRoutes } from './modules/canteen/admin-routes';
import { registerConciergeRoutes } from './modules/concierge/routes';
import { registerCustomerRoutes } from './modules/customer/routes';
import { registerPatrolAdminRoutes } from './modules/patrol/routes';
import { registerTablesV8115Routes } from './modules/tables-v8115';
import { registerDishRoutes } from './modules/dishes';
import { registerDishCostRoutes } from './modules/dish-cost';
import { registerDishImportRoutes } from './modules/dishes-import';
import { registerRoomCenterRoutes } from './modules/room-center';

function originHost(origin: string): string | null {
  try {
    return new URL(origin).host;
  } catch {
    return null; // 例如 "null"，按跨站处理
  }
}

/** 页面的内容安全策略（先 Report-Only）：页面、脚本、样式、图片都从本机来；本机 OCR 的识别库要 wasm 与 blob 工人 */
const PAGE_CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "media-src 'self' blob:",
  "worker-src 'self' blob:",
  "manifest-src 'self'",
  "frame-ancestors 'self'",
  "base-uri 'self'",
  "form-action 'self'",
  'report-uri /api/csp-report',
].join('; ');
const CspReports = z.union([z.object({ 'csp-report': z.record(z.string(), z.unknown()) }), z.array(z.object({ body: z.record(z.string(), z.unknown()) })).max(5)]);

export async function buildApp(sql: Sql, config: AppConfig): Promise<FastifyInstance> {
  const app = Fastify({
    // 日志脱敏、请求编号（8.1.48，lib/http-kit.ts）
    ...baseServerOptions(config.logLevel),
    bodyLimit: 64 * 1024,
    // 正式服在反向代理（Caddy）后面时设 TRUST_PROXY：来源 IP、https 按代理转来的算（8.0.0，docs/RELEASE_V800.md）
    trustProxy: config.trustProxy.length ? config.trustProxy : false,
  });
  const deps: Deps = { sql, config };

  await app.register(cookie);
  app.decorateRequest('actor', null as never);
  app.decorateRequest('hasSession', false);

  // 防护（8.1.3，docs/RESILIENCE_V813.md 第 3.5 节）：访问网段与过载保护在读会话之前（忙的时候不再多查一次库），
  // 频率限制在读完会话之后（登录了的按会话算）。拒绝都发生在处理之前，页面据此原样自动重发
  const protection = createProtection(config.protection);
  app.addHook('onRequest', protection.gate);
  app.addHook('onResponse', protection.done);
  app.addHook('onRequestAbort', protection.done);
  app.addHook('onClose', async () => protection.close());

  app.addHook('onRequest', async (req) => {
    // 按解码后的路径认接口：/%61pi/… 与 /api/… 进的是同一个接口，来源检查、读会话都要一样
    if (!isApiRequest(req)) return;
    // 页面问「连不连得上」：不读会话、不查库
    if (decodedPath(req.url) === '/api/ping') return;
    // 采购商城的服务端调用（8.1.31，docs/MALL_V8131.md 第 2 节）：只认服务密钥 + 员工编号，不读浏览器 Cookie、不做浏览器的来源检查
    if (isMallPath(decodedPath(req.url))) return authenticateMall(req, sql, config);
    // 修改类请求必须来自本站页面（防止跨站请求伪造）
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      const origin = req.headers.origin;
      if (origin && originHost(origin) !== req.headers.host) {
        throw new AppError(403, 'BAD_ORIGIN', '请求来源不正确');
      }
    }
    const token = req.cookies[SESSION_COOKIE];
    if (token) {
      const actor = await resolveSession(sql, token, config.sessionTtlHours);
      if (actor) {
        req.actor = actor;
        req.hasSession = true;
      }
    }
  });

  app.addHook('onRequest', protection.limit);

  // 当前门店（8.0.22，docs/MULTISTORE_V8022.md 第 3 节）：处理请求时在这家店的上下文里——事务开头记上门店、
  // 业务表 store_id 的默认值取它；放在请求体解析以后（preHandler），处理函数整个在里面
  app.addHook('preHandler', (req, _reply, done) => {
    runInStore(req.actor?.storeId ?? DEFAULT_STORE_ID, done, req.id);
  });

  // 浏览器按声明的类型解析响应，不猜测内容类型（测试服 E2E 报告）；不让别的网站把页面嵌进去（防点击劫持），
  // 跳到别的网站时不带地址里的内容（8.0.0：正式服放公网之前补上，docs/RELEASE_V800.md）
  app.addHook('onSend', async (_req, reply, payload) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('x-frame-options', 'SAMEORIGIN');
    reply.header('referrer-policy', 'same-origin');
    // 页面的内容安全策略（8.1.56，后端评估第 6 节）：先只报告不拦（Report-Only），浏览器把会被拦的写进日志；
    // 看一周日志里没有正常功能被拦，再改成 Content-Security-Policy 生效
    if (String(reply.getHeader('content-type') ?? '').startsWith('text/html') && !reply.hasHeader('content-security-policy')) {
      reply.header('content-security-policy-report-only', PAGE_CSP);
    }
    return payload;
  });
  // 浏览器报上来的「会被拦的」：只记日志（每条截短），不进库；不要登录
  app.addContentTypeParser(['application/csp-report', 'application/reports+json'], { parseAs: 'string', bodyLimit: 16_384 }, (_req, body, done) => {
    try {
      done(null, JSON.parse(String(body)));
    } catch {
      done(null, {});
    }
  });
  app.post('/api/csp-report', async (req, reply) => {
    // 老写法 { "csp-report": {…} }，新写法（Reporting API）[{ type, body: {…} }]；认不出的什么都不记
    const parsed = CspReports.safeParse(req.body);
    const reports = !parsed.success ? [] : Array.isArray(parsed.data) ? parsed.data.map((r) => r.body) : [parsed.data['csp-report']];
    for (const r of reports.filter(Boolean)) req.log.warn({ csp: JSON.stringify(r).slice(0, 600) }, '页面内容安全策略：这一项上线后会被拦');
    return reply.code(204).send();
  });

  installRequestId(app);
  // 统一的错误出口（lib/http-kit.ts；映射规则与小程序、员工端口同一份）
  installErrorHandler(app, {
    busy: (req) => {
      // 等锁或执行超时、死锁、串行化冲突（8.1.3）：事务已回滚，操作没有生效；页面带原操作编号自动重发
      const path = routePath(req);
      const what =
        path.startsWith('/api/inventory') || path.startsWith('/api/purchase') || path.startsWith('/api/payables')
          ? '相关物料或单据'
          : path.startsWith('/api/frontdesk') || path.startsWith('/api/emenu')
            ? '这张手牌或账单'
            : path.startsWith('/api/admin/spaces')
              ? '空间台账'
              : '该会员';
      return `${what}正在被其他终端操作，本次未生效，请稍后重试`;
    },
    internal: '服务器出了点问题，操作可能未完成，请通过单号或流水核对结果',
    details: true,
    dbGuards: true,
    logLabel: '未处理的错误',
  });

  // 运行状态（8.1.53 后端评估第 5 节，照 Trigger.dev 的任务面板、不引入 Prometheus）：店主看每分钟的任务哪项在出错、
  // 过载保护此刻的情况、内存。只读、只给店主（经营规则设置权限）；按进程记，重启清零
  app.get('/api/admin/runtime', { preHandler: guard('settings.manage') }, async () => {
    const mem = process.memoryUsage();
    return {
      version: config.version,
      commit: config.commit,
      startedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(),
      memoryMb: { rss: Math.round(mem.rss / 1048576), heapUsed: Math.round(mem.heapUsed / 1048576) },
      protection: protection.stats(),
      jobs: jobStatuses(),
    };
  });

  app.get('/api/health', async () => {
    await sql`SELECT 1`;
    return { ok: true, version: config.version, commit: config.commit, instance: config.instance, time: new Date().toISOString() };
  });

  // 页面问「连不连得上」（8.1.3 WL3）：不查数据库、不读会话、不受过载保护与频率限制；顺带告诉页面服务器上这一版页面的入口文件，
  // 和页面自己的不一样就是系统更新过了（提示条请员工方便时刷新）
  const clientEntry = readClientEntry(resolve(process.env.STATIC_DIR ?? 'dist/client'));
  app.get('/api/ping', async (_req, reply): Promise<PingReply> => {
    reply.header('cache-control', 'no-store');
    return { ok: true, version: config.version, commit: config.commit, instance: config.instance, client: clientEntry, time: new Date().toISOString() };
  });
  registerClientErrorRoutes(app);

  // ERP 关闭的模块：按接口前缀统一拦截（先于各接口注册，所有接口都经过它）
  registerErpModuleGate(app, deps);
  registerConciergeRoutes(app, deps);
  registerCustomerRoutes(app, deps);
  registerAuthRoutes(app, deps);
  registerGrantRoutes(app, deps);
  registerMemberRoutes(app, deps);
  registerMemberTagRoutes(app, deps);
  // 自定义字段（8.0.21，docs/FINANCE_V8021.md 第 1 节）
  registerCustomFieldRoutes(app, deps);
  registerMemberRecordRoutes(app, deps);
  registerCouponRoutes(app, deps);
  registerCouponLedgerRoutes(app, deps);
  registerGiftCardRoutes(app, deps);
  // 8.1.9 签赠（docs/GIFTS_V819.md）
  registerSignGiftRoutes(app, deps);
  registerCampaignRoutes(app, deps);
  registerGiftOutRoutes(app, deps);
  registerStockUsageRoutes(app, deps);
  registerCostRoutes(app, deps);
  registerAutoReplenishRoutes(app, deps);
  registerLinenRoutes(app, deps);
  registerCouponUsageRoutes(app, deps);
  registerMarketingCostRoutes(app, deps);
  registerMembershipRoutes(app, deps);
  registerBenefitRoutes(app, deps);
  registerVipLockerRoutes(app, deps);
  registerBenefitTierRoutes(app, deps);
  registerTrialRoutes(app, deps);
  registerDeviceRoutes(app, deps);
  registerWalletRoutes(app, deps);
  // 储值退回（v0.7.26）
  registerMemberRefundRoutes(app, deps);
  registerMemberAdminRoutes(app, deps);
  registerOpeningRoutes(app, deps);
  registerMemberHistoryRoutes(app, deps);
  registerShiftRoutes(app, deps);
  registerPrintRoutes(app, deps);
  registerDashboardRoutes(app, deps);
  registerDashboardReportRoutes(app, deps);
  registerLedgerRoutes(app, deps);
  registerOrderRoutes(app, deps);
  registerSettlementRoutes(app, deps);
  registerStaffRoutes(app, deps);
  // OA 办公（docs/OA.md）：OA-01 组织架构与员工档案
  registerOaOrgRoutes(app, deps);
  registerTrainingRoutes(app, deps);
  registerGovflowRoutes(app, deps);
  registerSupplyRoutes(app, deps);
  registerPettyRoutes(app, deps);
  registerGfContractRoutes(app, deps);
  registerGfPaymentRoutes(app, deps);
  registerGfExpenseRoutes(app, deps);
  registerGfHrRoutes(app, deps);
  registerOaStaffImportRoutes(app, deps);
  registerOaNotificationRoutes(app, deps);
  registerOaAnnouncementRoutes(app, deps);
  registerOaAttendanceSetupRoutes(app, deps);
  registerOaScheduleRoutes(app, deps);
  registerOaScheduleGrantRoutes(app, deps);
  registerOaGeoRoutes(app, deps);
  registerOaPunchRoutes(app, deps);
  registerOaFaceRoutes(app, deps);
  registerOaAttendanceDailyRoutes(app, deps);
  registerOaAttendanceMonthlyRoutes(app, deps);
  registerOaHolidayRoutes(app, deps);
  registerOaImRoutes(app, deps);
  registerOaImGroupRoutes(app, deps);
  registerOaDirectoryRoutes(app, deps);
  registerOaLeaveRoutes(app, deps);
  registerOaApprovalRoutes(app, deps);
  registerOaApprovalAdminRoutes(app, deps);
  registerOaPayrollRoutes(app, deps);
  registerOaAttachmentRoutes(app, deps);
  registerCatalogRoutes(app, deps);
  registerSettingsRoutes(app, deps);
  registerStoreRoutes(app, deps);
  registerWecomRoutes(app, deps);
  registerAiRoutes(app, deps);
  registerAuditRoutes(app, deps);
  registerAdminRoutes(app, deps);
  // 分部门岗位职权配置（回测整改 P05）
  registerPositionCatalogRoutes(app, deps);
  registerRoomOrderRoutes(app, deps);
  registerPriceCatalogRoutes(app, deps);
  registerTechBoardRoutes(app, deps);
  registerMasterRoutes(app, deps);
  registerDocRoutes(app, deps);
  // 8.1.9 库管入库的台账模板与一键导入（docs/ERP_V819.md 第 3.2 节）
  registerReceiptImportRoutes(app, deps);
  registerLedgerImportRoutes(app, deps);
  registerReportRoutes(app, deps);
  registerDeptStockRoutes(app, deps);
  registerPurchasingRoutes(app, deps);
  registerUrgentContractRoutes(app, deps);
  registerPurchaseRulesRoutes(app, deps);
  registerFileRoutes(app, deps);
  registerAttachmentRoutes(app, deps);
  registerAdmissionRoutes(app, deps);
  registerScoreRoutes(app, deps);
  registerSlowRoutes(app, deps);
  registerReconLinkRoutes(app, deps);
  registerSupplierPortalRoutes(app, deps);
  registerPayTerminalRoutes(app, deps);
  registerPlatformVerifyRoutes(app, deps);
  registerOtaRoutes(app, deps);
  registerIntegrationsAdminRoutes(app, deps);
  registerReceivableRoutes(app, deps);
  registerAssetRoutes(app, deps);
  registerExpiryRoutes(app, deps);
  registerCompareRoutes(app, deps);
  registerGiftRoutes(app, deps);
  registerTransferRoutes(app, deps);
  registerPettyAccountRoutes(app, deps);
  registerReplenishRoutes(app, deps);
  registerSourcingRoutes(app, deps);
  // 采购流程图（8.0.17，只读）
  registerPurchaseFlowRoutes(app, deps);
  // 审批中心（v0.7.30）
  registerApprovalRoutes(app, deps);
  // 合同与法务审查（v0.7.31）
  registerTemplateRoutes(app, deps);
  // 合同模板与导出（8.0.21）：要在 /api/erp/contracts/:id 之前注册
  registerContractDocRoutes(app, deps);
  registerContractRoutes(app, deps);
  registerPaymentRoutes(app, deps);
  registerPayableRoutes(app, deps);
  registerCycleRoutes(app, deps);
  registerImportRoutes(app, deps);
  registerExpenseRoutes(app, deps);
  // 备用金的申用（8.1.42 起并进备用金，docs/V8142_PETTY.md；原来 8.1.9 的零采备用金）
  registerPettyUseRoutes(app, deps);
  // 费用预算与进项发票台账（8.0.3）
  registerBudgetRoutes(app, deps);
  registerInvoiceRoutes(app, deps);
  // 开票申请（8.0.21）
  registerSalesInvoiceRoutes(app, deps);
  // 银行账户与网银流水（8.0.21）
  registerBankRoutes(app, deps);
  // 批量付款（8.0.21）
  registerPaymentBatchRoutes(app, deps);
  registerRequestRoutes(app, deps);
  // 采购商城对接（8.1.31）
  registerMallRoutes(app, deps);
  // 采购商城页面（8.1.32）
  registerShopRoutes(app, deps);
  // Design 素材库（8.1.33）
  registerDesignRoutes(app, deps);
  // 8.1.10 核库转领用：库管核库、部门答复替代
  registerRequestStockRoutes(app, deps);
  registerRequestImportRoutes(app, deps);
  registerRequestDraftRoutes(app, deps);
  registerRequestSheetRoutes(app, deps);
  registerErpOpsRoutes(app, deps);
  registerPurchaseLedgerRoutes(app, deps);
  registerLegacyRoutes(app, deps);
  registerFrontdeskRoutes(app, deps);
  // 柜况与智能柜锁（8.1.49，docs/LOCKERS_V8149.md）
  registerLockerRoutes(app, deps);
  registerTechnicianRoutes(app, deps);
  registerClockroomRoutes(app, deps);
  registerDiningRoutes(app, deps);
  registerTableRoutes(app, deps);
  registerTableChargeRoutes(app, deps);
  // 8.2.4 餐饮：包房房型、返台（docs/V8224_DINING.md）
  registerTablesV8224Routes(app, deps);
  // 8.2.8：餐厅入口刷手牌登记进餐（含餐抵扣、裸票时段价）
  registerMealEntryRoutes(app, deps);
  registerDining808Routes(app, deps);
  // 8.1.7 点菜单（小票可视化）
  registerDiningReceiptRoutes(app, deps);
  // 点餐系统 · 平板电子菜单（8.0.10）
  registerEmenuRoutes(app, deps);
  registerStudioRoutes(app, deps);
  registerRoomRoutes(app, deps);
  registerSpaceRoutes(app, deps);
  registerFloorplanRoutes(app, deps);
  registerFloorMapRoutes(app, deps);
  // 派对房等「开单即占用」的使用单（v0.7.19）
  registerUsageRoutes(app, deps);
  registerBookingRoutes(app, deps);
  registerCountCardRoutes(app, deps);
  registerMemberCardRoutes(app, deps);
  registerPlatformRoutes(app, deps);
  // 对客导览（v0.7.19）
  registerGuideRoutes(app, deps);
  registerLocationRoutes(app, deps);
  registerCommissionRoutes(app, deps);
  // 8.2.2 技师：扩钟与十天业绩统计、每月任务；网页导入技师
  registerTechnicianStatsRoutes(app, deps);
  registerTechnicianWebImportRoutes(app, deps);
  registerErpRoutes(app, deps);
  // 微信小程序（小程序线）：前台用会员码查会员、解绑会员的微信、后台「小程序」
  registerMpStaffRoutes(app, deps);
  // 员工食堂 · 柚子饭堂（docs/CANTEEN.md）：管理后台的 /api/erp/canteen；员工用的 /api/canteen/* 只在员工端口上
  registerCanteenAdminRoutes(app, deps);
  // 安保巡场（8.0.9，docs/PATROL_V809.md）：管理后台的 /api/erp/patrol；员工用的 /api/canteen/patrol/* 在员工端口上
  registerPatrolAdminRoutes(app, deps);
  // 8.1.15 块 B（docs/DINING_V8115.md）：桌台动作——清台、维修、恢复、并台、拆台、桌台历史
  registerTablesV8115Routes(app, deps);
  // 菜品管理（8.1.15，docs/DISHES_V8115.md）：菜品表、新增 / 编辑、上下架、改价与改价记录、Excel 导出与导入
  registerDishRoutes(app, deps);
  registerDishCostRoutes(app, deps);
  registerDishImportRoutes(app, deps);
  // 房态中心（8.1.15，docs/ROOM_CENTER_V8115.md）：按房型看全店房间的五种状态，服务房间的登记、换房、续钟、并房、退房
  registerRoomCenterRoutes(app, deps);
  // 技师管理（8.1.15，docs/TECHNICIANS_V8115.md）：组别、班次与排班、休假；名册与钟房的接口在各自原来的模块里
  registerTechnicianAdminRoutes(app, deps);
  // 技师榜单（docs/TECH_RANKING.md）：名册 + 钟房状态的只读榜单、技师照片
  registerTechnicianRankingRoutes(app, deps);

  // 前端静态资源（构建产物），全部从本机提供，外网中断不影响使用。
  const staticDir = resolve(process.env.STATIC_DIR ?? 'dist/client');
  const hasClient = existsSync(resolve(staticDir, 'index.html'));
  if (hasClient) {
    await app.register(fastifyStatic, {
      root: staticDir,
      // 构建时已压缩好（scripts/compress-assets.mjs）：浏览器支持时直接发 .br / .gz，首次打开下载量约为原来的四分之一
      preCompressed: true,
      setHeaders(reply, path) {
        reply.header('cache-control', path.includes('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache');
      },
    });
  }

  app.setNotFoundHandler((req, reply) => {
    if (isApiRequest(req) || !hasClient || req.method !== 'GET') {
      reply.status(404).send({ error: { code: 'NOT_FOUND', message: '接口不存在' } });
      return;
    }
    // 构建产物里的脚本、模型这类文件缺了就是缺了：回 404，不拿页面顶替。
    // （管家部本机 OCR 的识别库把收到的内容直接当模型用、还会存在浏览器里；回页面的话坏的那份会一直留着，8.0.12 整改）
    const path = req.url.split('?')[0]!;
    if (path.startsWith('/assets/') || path.startsWith('/concierge/ocr/')) {
      reply.status(404).header('cache-control', 'no-store').type('text/plain; charset=utf-8').send('Not Found');
      return;
    }
    reply.header('cache-control', 'no-cache').sendFile('index.html');
  });

  return app;
}

/** 构建好的 index.html 里页面入口的脚本（/assets/index-xxxx.js）；没有构建产物（开发、测试）时为空 */
export function readClientEntry(staticDir: string): string | null {
  try {
    const html = readFileSync(resolve(staticDir, 'index.html'), 'utf8');
    return /<script\b[^>]*\bsrc="(\/assets\/[^"]+\.js)"/.exec(html)?.[1] ?? null;
  } catch {
    return null;
  }
}
