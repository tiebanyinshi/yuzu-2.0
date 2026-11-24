// OA-11 浏览器验收：员工「办公 → 审批 → 发起审批 → 通用」填表提交，详情里看到审批链；审批人在「待我审批」里打开、写意见通过；
// 员工再看是「已通过」，并写一条评论（docs/OA.md 第 14 节）。
// 依赖演示数据（仅独立演示库），账号：店主 linlan，密码 yuzu2026。演示库里前厅部、总经办都没有负责人，前厅部员工的「本部门主管」
// 一路往上取到总裁——没选岗位的老店主账号 linlan 兜底（OA12）。每次新开一个店员账号。
import { expect, test } from '@playwright/test';
import { passPortal } from './portal';

test.describe('OA-11 办公审批', () => {
  test('员工发起「通用」审批，审批人在待我审批里通过，员工看到已通过并评论', async ({ page, browser }) => {
    await page.goto('/login');
    await page.fill('#username', 'linlan');
    await page.fill('#password', 'yuzu2026');
    await page.getByRole('button', { name: '登录' }).click();
    await passPortal(page);
    await page.waitForURL((u) => !u.pathname.startsWith('/login'));

    const stamp = Date.now().toString(36).slice(-5);
    const username = `ap${stamp}`;
    const hired = await page.request.post('/api/staff', { data: { username, displayName: `审批员${stamp}`, position: 'front.staff', password: 'yuzu2026' } });
    expect(hired.status(), await hired.text()).toBe(201);

    // 员工：办公 → 审批 → 发起审批 → 通用
    const ctx = await browser.newContext({ baseURL: test.info().project.use.baseURL });
    const emp = await ctx.newPage();
    expect((await emp.request.post('/api/auth/login', { data: { username, password: 'yuzu2026' } })).status()).toBe(200);
    expect((await emp.request.post('/api/auth/change-password', { data: { currentPassword: 'yuzu2026', newPassword: `Appr-${stamp}-2026` } })).status()).toBe(200);
    await emp.goto('/oa');
    await emp.getByTestId('oa-tile-approvals').click();
    await emp.getByTestId('oa-approval-new').click();
    await emp.getByTestId('oa-approval-tpl-general').click();
    const title = `用章申请${stamp}`;
    await emp.getByTestId('oa-field-title').fill(title);
    await emp.getByTestId('oa-field-content').fill('盖合同专用章一份');
    await emp.getByTestId('oa-approval-submit').click();
    await expect(emp.getByTestId('oa-approval-status')).toHaveText('审批中');
    await expect(emp.getByTestId('oa-approval-steps')).toContainText('审批中');
    const id = Number(new URL(emp.url()).pathname.split('/').pop());
    expect(id).toBeGreaterThan(0);

    // 审批人：待我审批 → 打开 → 写意见通过
    await page.goto('/oa/approvals?box=todo');
    await page.getByTestId(`oa-approval-${id}`).click();
    await page.getByTestId('oa-approval-opinion').fill('同意');
    await page.getByTestId('oa-approval-approve').click();
    await expect(page.getByTestId('oa-approval-status')).toHaveText('已通过');

    // 员工：看到已通过，写评论
    await emp.reload();
    await expect(emp.getByTestId('oa-approval-status')).toHaveText('已通过');
    await expect(emp.getByTestId('oa-approval-events')).toContainText('通过：同意');
    await emp.getByTestId('oa-approval-comment').fill('谢谢');
    await emp.getByTestId('oa-approval-comment-send').click();
    await expect(emp.getByTestId('oa-approval-events')).toContainText('评论：谢谢');
    await ctx.close();
  });
});
