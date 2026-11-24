// 系统门户页（店主 2026-11-24，docs/PORTAL.md）：登录后先到门户页选板块。店主 2026-11-24 起门户就是首页 /，CRM 在 /crm（docs/BOARDS.md 第 8 节）。
// 以前的用例登录后直接在门店首页（会员工作台，或按岗位跳到 ERP、餐饮……）继续：登录以后从门户页进 CRM 首页 /crm，原来的落点不变。
// 门户页本身的用例在 e2e/portal.spec.ts。
import type { Page } from '@playwright/test';

/** 等登录完成；落在门户页的，进 CRM 首页继续（首页按岗位落到会员工作台、ERP、餐饮……） */
export async function passPortal(page: Page): Promise<void> {
  await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 30_000 });
  if (new URL(page.url()).pathname === '/') await page.goto('/crm');
}

/** 首次登录改好密码以后（回到门户页；点餐平板从门户页直接进点餐页）：按原来的首页继续 */
export async function afterPasswordChange(page: Page): Promise<void> {
  await page.waitForURL((u) => u.pathname === '/' || u.pathname === '/emenu', { timeout: 30_000 });
  if (new URL(page.url()).pathname === '/') await page.goto('/crm');
}
