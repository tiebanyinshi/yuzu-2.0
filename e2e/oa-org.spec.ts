// OA-01 浏览器验收：后台「人员与行政 → 组织架构」（docs/OA.md 第 4 节）。
// 依赖演示数据（仅独立演示库），账号：店主 linlan，密码 yuzu2026。会新建一个员工账号（每次用新的名字）、
// 给它填档案、办理离职再复职；部门树只读不改，可重复执行。
import { expect, test, type Page } from '@playwright/test';
import { passPortal } from './portal';

const PASSWORD = 'yuzu2026';

async function login(page: Page, username: string) {
  await page.goto('/login');
  await page.fill('#username', username);
  await page.fill('#password', PASSWORD);
  await page.getByRole('button', { name: '登录' }).click();
  await passPortal(page);
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

  test('OA-02 批量开通：选表格 → 预览标出问题 → 改好再开通 → 临时密码只显示这一次、能登录', async ({ page }) => {
    await login(page, 'linlan');
    const stamp = Date.now().toString(36);
    const tail = String(Date.now()).slice(-8);
    const head = '姓名,手机号,工号,部门,岗位,入职日期,登录名';
    await page.goto('/admin/org');
    await page.getByTestId('org-import').click();
    await expect(page.getByTestId('staff-import-template')).toHaveAttribute('href', '/api/oa/employees/import/template');
    // 第一份：一行部门写错
    await page.getByTestId('staff-import-file').setInputFiles({ name: 'bad.csv', mimeType: 'text/csv', buffer: Buffer.from(`${head}\nE2E甲,139${tail},,不存在部,,,\n`) });
    await expect(page.getByTestId('staff-import-issue-2')).toContainText('不存在部');
    await expect(page.getByTestId('staff-import-apply')).toBeDisabled();
    // 第二份：改好了
    const user = `e2eimp${stamp}`;
    await page.getByTestId('staff-import-file').setInputFiles({ name: 'good.csv', mimeType: 'text/csv', buffer: Buffer.from(`${head}\nE2E甲,139${tail},,前厅部,员工,2026-11-01,${user}\n`) });
    await expect(page.getByTestId('staff-import-preview')).toContainText('可以开');
    await page.getByTestId('staff-import-apply').click();
    const pw = page.getByTestId(`staff-import-password-${user}`);
    await expect(pw).toHaveText(/^yuzu-\d{4}-[a-z]{2}$/);
    const password = (await pw.textContent())!;
    // 临时密码只显示这一次：结果框没有关闭按钮，按 Esc 也不关，只能点「完成」
    await expect(page.getByRole('dialog').getByRole('button', { name: '关闭' })).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(pw).toBeVisible();
    await page.getByTestId('staff-import-done').click();
    await page.getByTestId('org-emp-search').fill(user);
    await expect(page.getByTestId('org-employees')).toContainText('2026-11-01');
    // 临时密码能登录
    const ctx = await page.context().browser()!.newContext({ baseURL: test.info().project.use.baseURL });
    const res = await ctx.request.post('/api/auth/login', { data: { username: user, password } });
    expect(res.status()).toBe(200);
    await ctx.close();
  });

  test('OA-02 批量开通没收到结果：页面上方按原内容重新提交，这一次才开通的照样显示临时密码', async ({ page }) => {
    await login(page, 'linlan');
    const stamp = Date.now().toString(36);
    const tail = String(Date.now()).slice(-8);
    const user = `e2eresend${stamp}`;
    await page.goto('/admin/org');
    await page.getByTestId('org-import').click();
    await page
      .getByTestId('staff-import-file')
      .setInputFiles({ name: 'resend.csv', mimeType: 'text/csv', buffer: Buffer.from(`姓名,手机号,工号,部门,岗位,入职日期,登录名\nE2E重提,137${tail},,前厅部,,,${user}\n`) });
    await expect(page.getByTestId('staff-import-preview')).toContainText('可以开');
    // 第一次请求断在路上（没到服务器）：记成结果待确认
    let aborted = false;
    await page.route('**/api/oa/employees/import', async (route) => {
      if (!aborted && route.request().method() === 'POST') {
        aborted = true;
        await route.abort('connectionreset');
      } else await route.continue();
    });
    await page.getByTestId('staff-import-apply').click();
    await expect(page.getByTestId('erp-pending')).toBeVisible();
    // 按原内容重新提交：这一次才真的开通，临时密码照样显示
    await page.getByTestId('erp-pending-resend').click();
    await expect(page.getByTestId(`staff-import-password-${user}`)).toHaveText(/^yuzu-\d{4}-[a-z]{2}$/);
    await page.getByTestId('staff-import-done').click();
    await expect(page.getByTestId('erp-pending-resend')).toHaveCount(0);
  });
});
