// OA-18 浏览器验收：后台工资表「发放」（确认后发出）→ 员工端「办公 → 工资条」看到、打开、确认签收 → 后台签收状态与审计页。
// 依赖演示数据（仅独立演示库），账号：店主 linlan，密码 yuzu2026（总裁：建的是全店的表，表里有自己）。
// 先用接口建一张只留自己的工资表、填好金额，再走页面发放。
import { expect, test } from '@playwright/test';

test.describe('OA-18 发放与签收', () => {
  test('发放 → 员工看到并签收 → 后台看到签收与审计', async ({ page }) => {
    await page.goto('/login');
    await page.fill('#username', 'linlan');
    await page.fill('#password', 'yuzu2026');
    await page.getByRole('button', { name: '登录' }).click();
    await page.waitForURL((u) => !u.pathname.startsWith('/login'));
    const stamp = Date.now().toString(36).slice(-5);
    const me = ((await (await page.request.get('/api/auth/me')).json()) as { staff: { id: number } }).staff.id;
    const tpl = ((await (await page.request.get('/api/oa/payroll/templates')).json()) as { id: number; name: string }[]).find((t) => t.name === '标准工资条')!;
    const created = await page.request.post('/api/oa/payroll/batches', { data: { month: '2026-10', title: `发放验收${stamp}`, templateId: tpl.id } });
    expect(created.status(), await created.text()).toBe(201);
    const batchId = ((await created.json()) as { id: number }).id;
    const d = (await (await page.request.get(`/api/oa/payroll/batches/${batchId}`)).json()) as { slips: { staffId: number }[] };
    for (const s of d.slips) if (s.staffId !== me) await page.request.post(`/api/oa/payroll/batches/${batchId}/slips/${s.staffId}/remove`, { data: {} });
    if (!d.slips.some((s) => s.staffId === me)) await page.request.post(`/api/oa/payroll/batches/${batchId}/slips/${me}/add`, { data: {} });
    const put = await page.request.put(`/api/oa/payroll/batches/${batchId}/slips/${me}`, { data: { values: { f1: 800000, f10: 765432 } } });
    expect(put.status(), await put.text()).toBe(200);

    // 后台发放（点两下确认）
    await page.goto('/admin/payroll');
    await page.getByTestId(`payroll-batch-${batchId}`).click();
    await page.getByTestId('payroll-publish').click();
    await page.getByText('核对过金额了').click();
    await page.getByTestId('payroll-publish-confirm').click();
    await expect(page.getByTestId('payroll-batch')).toContainText('已发放');

    // 员工端：列表 → 明细 → 签收
    await page.goto('/oa/payslips');
    const item = page.locator('a[data-testid^="my-payslip-"]').filter({ hasText: `发放验收${stamp}` });
    await expect(item).toContainText('待签收');
    await item.click();
    await expect(page.getByTestId('payslip-net')).toHaveText('¥7,654.32');
    await expect(page.getByTestId('my-payslip-objection')).toHaveAttribute('href', /payslip_objection\?f\.payslip=/);
    await page.getByTestId('my-payslip-sign').click();
    await expect(page.getByTestId('my-payslip-signed')).toBeVisible();

    // 后台：签收状态、审计页
    await page.goto('/admin/payroll');
    await page.getByTestId(`payroll-batch-${batchId}`).click();
    await expect(page.getByTestId('payroll-batch')).toContainText('已签收 1 / 1 人');
    await page.goto('/admin/payroll/audit');
    await expect(page.getByTestId('payroll-audit')).toContainText('员工签收');
    await expect(page.getByTestId('payroll-audit')).toContainText(`发放验收${stamp}`);
  });
});
