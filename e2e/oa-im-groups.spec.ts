// OA-16 浏览器验收：通讯录搜同事、看资料卡、「发消息」打开单聊；群设置：发群公告（聊天页顶上显示）、设管理员、移出成员（点两下确认）、
// 解散（之后输入框换成「只能看历史消息」）；被设成管理员的那位不刷新也看到系统提示（docs/OA.md 第 19 节）。
// 依赖演示数据（仅独立演示库），账号：店主 linlan，密码 yuzu2026。每次新开三个店员账号。
import { randomUUID } from 'node:crypto';
import { expect, test, type Browser, type Page } from '@playwright/test';
import { passPortal } from './portal';

async function staffPage(browser: Browser, owner: Page, tag: string, stamp: string): Promise<{ page: Page; id: number; name: string }> {
  const username = `ig${tag}${stamp}`;
  const name = `群管${tag}${stamp}`;
  const hired = await owner.request.post('/api/staff', { data: { username, displayName: name, position: 'front.staff', password: 'yuzu2026' } });
  expect(hired.status(), await hired.text()).toBe(201);
  const ctx = await browser.newContext({ baseURL: test.info().project.use.baseURL });
  const page = await ctx.newPage();
  expect((await page.request.post('/api/auth/login', { data: { username, password: 'yuzu2026' } })).status()).toBe(200);
  expect((await page.request.post('/api/auth/change-password', { data: { currentPassword: 'yuzu2026', newPassword: `Ig-${tag}-${stamp}-2026` } })).status()).toBe(200);
  return { page, id: ((await hired.json()) as { id: number }).id, name };
}

test.describe('OA-16 通讯录与群管理', () => {
  test('通讯录发起单聊；群设置：公告、管理员、移出、解散', async ({ page, browser }) => {
    await page.goto('/login');
    await page.fill('#username', 'linlan');
    await page.fill('#password', 'yuzu2026');
    await page.getByRole('button', { name: '登录' }).click();
    await passPortal(page);
    await page.waitForURL((u) => !u.pathname.startsWith('/login'));
    const stamp = Date.now().toString(36).slice(-5);
    const a = await staffPage(browser, page, 'a', stamp);
    const b = await staffPage(browser, page, 'b', stamp);
    const c = await staffPage(browser, page, 'c', stamp);

    // 通讯录：搜 B，看资料卡，发消息
    await a.page.goto('/oa');
    await a.page.getByTestId('oa-tile-directory').click();
    await expect(a.page.getByTestId('dir')).toBeVisible();
    await a.page.getByTestId('dir-search').fill(b.name);
    await a.page.getByTestId(`dir-person-${b.id}`).click();
    await expect(a.page.getByTestId('dir-card')).toContainText('前厅部');
    await a.page.getByTestId('dir-chat').click();
    await expect(a.page.getByTestId('im-chat')).toBeVisible();

    // 建群（接口建，省时间），A 是群主
    const made = await a.page.request.post('/api/oa/im/groups', { data: { clientKey: randomUUID(), name: `群管${stamp}`, memberIds: [b.id, c.id] } });
    expect(made.status()).toBe(201);
    const gid = ((await made.json()) as { id: number }).id;
    await a.page.goto(`/oa/im/${gid}`);
    await b.page.goto(`/oa/im/${gid}`);
    await expect(b.page.getByTestId('im-chat')).toBeVisible();

    // 群公告
    await a.page.getByTestId('im-settings').click();
    await a.page.getByTestId('im-gs-notice').fill('周五下午大扫除');
    await a.page.getByTestId('im-gs-notice-save').click();
    await expect(a.page.getByTestId('im-notice')).toContainText('周五下午大扫除');
    // 设 B 为管理员；B 不刷新也看到系统提示
    await a.page.getByTestId(`im-gs-role-${b.id}`).click();
    await expect(a.page.getByTestId(`im-gs-member-${b.id}`)).toContainText('管理员');
    await expect(b.page.getByTestId('im-messages')).toContainText(`把${b.name}设为管理员`, { timeout: 10_000 });
    // 移出 C：点两下确认
    await a.page.getByTestId(`im-gs-kick-${c.id}`).click();
    await a.page.getByTestId(`im-gs-kick-${c.id}`).click();
    await expect(a.page.getByTestId(`im-gs-member-${c.id}`)).toHaveCount(0);
    // 解散
    await a.page.getByTestId('im-gs-dissolve').click();
    await a.page.getByTestId('im-gs-dissolve').click();
    await expect(a.page.getByTestId('im-gs-dissolve')).toHaveCount(0);
    await expect(a.page.getByRole('dialog')).toContainText('已经解散');
    await a.page.keyboard.press('Escape');
    await expect(a.page.getByTestId('im-dissolved')).toBeVisible();
    await expect(b.page.getByTestId('im-dissolved')).toBeVisible({ timeout: 10_000 });
    for (const x of [a, b, c]) await x.page.context().close();
  });
});
