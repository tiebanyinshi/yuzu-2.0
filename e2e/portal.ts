// 系统门户页（店主 2026-11-24，docs/PORTAL.md）：登录后先到门户页 /portal 选板块。
// 以前的用例登录后直接在门店首页（会员工作台，或按岗位跳到 ERP、餐饮……）继续：登录以后从门户页回到首页，原来的落点不变。
// 门户页本身的用例在 e2e/portal.spec.ts。
import type { Page } from '@playwright/test';

/** 等登录完成；落在门户页的，按原来的首页继续（首页按岗位落到会员工作台、ERP、餐饮……） */
export async function passPortal(page: Page): Promise<void> {
  await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 30_000 });
  if (new URL(page.url()).pathname === '/portal') await page.goto('/');
}
