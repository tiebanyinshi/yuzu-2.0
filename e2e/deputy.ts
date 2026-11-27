// 报销不能由登记的人自己确认（8.2.12，《业财法审批与 WCP 需求变更》B1）：演示库里能审报销的只有店主，
// 店主自己登记的报销由一位临时的「负责人」（店主现建，职责「审批」）审。每次建一个新账号，不受之前跑过的影响
import { randomUUID } from 'node:crypto';
import { expect, type APIRequestContext, type Page, type PlaywrightWorkerArgs } from '@playwright/test';

export interface Deputy {
  id: number;
  request: APIRequestContext;
}

/** 店主（page 登录的）建一位临时负责人，返回他的接口会话 */
export async function makeDeputy(page: Page, playwright: PlaywrightWorkerArgs['playwright'], baseURL: string | undefined): Promise<Deputy> {
  const username = `e2eappr${Date.now().toString(36)}`;
  const password = `E2e-${randomUUID().slice(0, 8)}`;
  const made = await page.request.post('/api/staff', { data: { username, displayName: 'E2E 临时负责人', role: 'backoffice', duties: ['approve'], password } });
  expect(made.ok(), await made.text()).toBe(true);
  const id = ((await made.json()) as { id: number }).id;
  const request = await playwright.request.newContext({ baseURL });
  expect((await request.post('/api/auth/login', { data: { username, password } })).ok()).toBe(true);
  const changed = await request.post('/api/auth/change-password', { data: { currentPassword: password, newPassword: `${password}9` } });
  expect(changed.ok(), await changed.text()).toBe(true);
  return { id, request };
}

/** 临时负责人审批一张报销（审到这一级为止） */
export async function deputyApproveClaim(deputy: Deputy, claimId: number): Promise<{ status: string }> {
  const r = await deputy.request.post(`/api/erp/expenses/${claimId}/approve`, { data: {} });
  expect(r.ok(), await r.text()).toBe(true);
  return (await r.json()) as { status: string };
}
