// OA-01 浏览器验收：后台「人员与行政 → 组织架构」（docs/OA.md 第 4 节）。
// 依赖演示数据（仅独立演示库），账号：店主 linlan，密码 yuzu2026。会新建一个员工账号（每次用新的名字）、
// 给它填档案、办理离职再复职；部门树只读不改，可重复执行。
import { expect, test, type Page } from '@playwright/test';

const PASSWORD = 'yuzu2026';

async function login(page: Page, username: string) {
  await page.goto('/login');
  await page.fill('#username', username);
  await page.fill('#password', PASSWORD);
  await page.getByRole('button', { name: '登录' }).click();
  await page.waitForURL((u) => !u.pathname.startsWith('/login'));
}

test.describe('OA-01 组织架构与员工档案', () => {
  test('部门树带主管与人数；员工档案能填、能搜；办理离职后账号停用，复职恢复', async ({ page }) => {
    await login(page, 'linlan');
    const stamp = Date.now().toString(36);
    const username = `e2eoa${stamp}`;
    const made = await page.request.post('/api/staff', { data: { username, displayName: `E2E 档案${stamp}`, position: 'eng.staff', password: 'E2e-oa-org-2026' } });
    expect(made.status(), await made.text()).toBe(201);

    await page.goto('/admin/org');
    await expect(page.getByRole('heading', { level: 1, name: '组织架构' })).toBeVisible();
    // 部门树：公司在最上，总经办与其余部门在下面
    const tree = page.getByTestId('org-tree');
    await expect(tree.getByTestId('org-dept-company')).toBeVisible();
    await expect(tree.getByTestId('org-dept-gmo')).toBeVisible();
    await expect(tree.getByTestId('org-dept-eng')).toBeVisible();
    // 部门编辑框：公司没有上级可选
    await page.getByTestId('org-dept-edit-company').click();
    await expect(page.getByTestId('org-dept-parent')).toBeDisabled();
    await page.keyboard.press('Escape');

    // 填档案
    await page.getByTestId('org-emp-search').fill(username);
    await page.getByTestId(`org-emp-edit-${username}`).click();
    const empNo = `E2E${stamp}`.slice(0, 20);
    await page.getByTestId('org-profile-empno').fill(empNo);
    await page.getByTestId('org-profile-hire').fill('2026-01-05');
    await page.getByTestId('org-profile-save').click();
    const table = page.getByTestId('org-employees');
    await expect(table).toContainText(empNo);
    await expect(table).toContainText('2026-01-05');
    // 按工号也搜得到
    await page.getByTestId('org-emp-search').fill(empNo.toLowerCase());
    await expect(table).toContainText(username);

    // 办理离职：从在职列表里消失，离职列表里有
    await page.getByTestId(`org-emp-leave-${username}`).click();
    await page.getByTestId('org-leave-date').fill('2026-11-20');
    await page.getByTestId('org-leave-confirm').click();
    await expect(page.getByTestId(`org-emp-leave-${username}`)).toHaveCount(0);
    await page.getByRole('radio', { name: '离职', exact: true }).click();
    await expect(table).toContainText('2026-11-20');
    // 离职员工登录不了
    const ctx = await page.context().browser()!.newContext({ baseURL: test.info().project.use.baseURL });
    const res = await ctx.request.post('/api/auth/login', { data: { username, password: 'E2e-oa-org-2026' } });
    expect(res.status()).not.toBe(200);
    await ctx.close();

    // 复职
    await page.getByTestId(`org-emp-rehire-${username}`).click();
    await page.getByTestId('org-rehire-confirm').click();
    await expect(page.getByTestId(`org-emp-rehire-${username}`)).toHaveCount(0);
    await page.getByRole('radio', { name: '在职', exact: true }).click();
    await expect(page.getByTestId(`org-emp-leave-${username}`)).toBeVisible();

    // 收尾：再办一次离职，演示库里不留多出来的在职账号（下一次用新名字）
    const id = ((await made.json()) as { id: number }).id;
    const off = await page.request.post(`/api/oa/employees/${id}/leave`, { data: { leaveDate: '2026-11-21', version: 3 } });
    expect(off.status(), await off.text()).toBe(200);
  });
});
