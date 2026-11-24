// OA-14 浏览器验收：两位新员工在「办公 → 消息」里单聊：A 发起、发一句；B 首页「消息」有未读角标，点开看到，回一句；
// A 不刷新页面几秒内看到回复（短轮询）与「已读」（OA-15）；A 撤回刚发的一句，两边都显示撤回（docs/OA.md 第 17 节）。
// 依赖演示数据（仅独立演示库），账号：店主 linlan，密码 yuzu2026。每次新开两个店员账号。
import { expect, test, type Browser, type Page } from '@playwright/test';
import { passPortal } from './portal';

async function staffPage(browser: Browser, owner: Page, tag: string, stamp: string): Promise<{ page: Page; id: number; name: string }> {
  const username = `im${tag}${stamp}`;
  const name = `聊天${tag}${stamp}`;
  const hired = await owner.request.post('/api/staff', { data: { username, displayName: name, position: 'front.staff', password: 'yuzu2026' } });
  expect(hired.status(), await hired.text()).toBe(201);
  const ctx = await browser.newContext({ baseURL: test.info().project.use.baseURL });
  const page = await ctx.newPage();
  expect((await page.request.post('/api/auth/login', { data: { username, password: 'yuzu2026' } })).status()).toBe(200);
  expect((await page.request.post('/api/auth/change-password', { data: { currentPassword: 'yuzu2026', newPassword: `Im-${tag}-${stamp}-2026` } })).status()).toBe(200);
  return { page, id: ((await hired.json()) as { id: number }).id, name };
}

test.describe('OA-14 即时通讯', () => {
  test('单聊：发起、发消息、对方看到未读并回复、轮询收到、撤回', async ({ page, browser }) => {
    await page.goto('/login');
    await page.fill('#username', 'linlan');
    await page.fill('#password', 'yuzu2026');
    await page.getByRole('button', { name: '登录' }).click();
    await passPortal(page);
    await page.waitForURL((u) => !u.pathname.startsWith('/login'));
    const stamp = Date.now().toString(36).slice(-5);
    const a = await staffPage(browser, page, 'a', stamp);
    const b = await staffPage(browser, page, 'b', stamp);

    // A：发起单聊、发一句
    await a.page.goto('/oa/im');
    await a.page.getByTestId('im-new-direct').click();
    await a.page.getByTestId('im-people-search').fill(b.name);
    await a.page.getByTestId(`im-person-${b.id}`).click();
    await expect(a.page.getByTestId('im-chat')).toBeVisible();
    await a.page.getByTestId('im-input').fill('你好，下午换班吗 😀');
    await a.page.getByTestId('im-send').click();
    await expect(a.page.getByTestId('im-messages')).toContainText('你好，下午换班吗 😀');
    await expect(a.page.getByTestId('im-pending')).toHaveCount(0);
    // OA-15 已读回执：对方还没看是「未读」
    await expect(a.page.locator('[data-testid^="im-receipt-"]').first()).toHaveText('未读');

    // B：首页「消息」有未读，点开看到，回一句
    await b.page.goto('/oa');
    await expect(b.page.getByTestId('oa-tile-im-badge')).toHaveText('1');
    await b.page.getByTestId('oa-tile-im').click();
    await b.page.getByText(a.name).click();
    await expect(b.page.getByTestId('im-messages')).toContainText('你好，下午换班吗 😀');
    // A 不刷新，几秒内变成「已读」
    await expect(a.page.locator('[data-testid^="im-receipt-"]').first()).toHaveText('已读', { timeout: 10_000 });
    await b.page.getByTestId('im-input').fill('可以');
    await b.page.getByTestId('im-input').press('Enter');

    // A：不刷新，几秒内收到
    await expect(a.page.getByTestId('im-messages')).toContainText('可以', { timeout: 10_000 });

    // A：撤回自己那一句，B 那边也显示撤回
    await a.page.locator('[data-testid^="im-revoke-"]').first().click();
    await expect(a.page.getByTestId('im-messages')).toContainText('你撤回了一条消息');
    await expect(b.page.getByTestId('im-messages')).toContainText(`${a.name}撤回了一条消息`, { timeout: 10_000 });
    await a.page.context().close();
    await b.page.context().close();
  });
});
