// OA-17 浏览器验收：后台「工资条」——新建工资表（按在职名单每人一行）、点一行填金额保存、预览员工看到的样子、
// 下载表格再原样上传看到预览、模板页能新建模板。
// 依赖演示数据（仅独立演示库），账号：店主 linlan，密码 yuzu2026（总裁，有 payroll.manage）。
import { expect, test } from '@playwright/test';

test.describe('OA-17 工资条模板与制表', () => {
  test('新建工资表、在线填一行、预览、下载表格再上传预览；新建模板', async ({ page }) => {
    await page.goto('/login');
    await page.fill('#username', 'linlan');
    await page.fill('#password', 'yuzu2026');
    await page.getByRole('button', { name: '登录' }).click();
    await page.waitForURL((u) => !u.pathname.startsWith('/login'));
    const stamp = Date.now().toString(36).slice(-5);

    await page.goto('/admin/payroll');
    await page.getByTestId('payroll-new').click();
    await page.getByTestId('payroll-new-month').fill('2026-11');
    await page.getByTestId('payroll-new-title').fill(`验收${stamp}`);
    await page.getByTestId('payroll-new-submit').click();
    await expect(page.getByTestId('payroll-batch')).toContainText(`验收${stamp}`);

    // 第一行：填基本工资与实发，保存后表里看得到；预览里实发在顶上
    const first = page.locator('[data-testid^="payroll-slip-"]').first();
    await first.click();
    await page.getByTestId('payroll-field-f1').fill('5000');
    await page.getByTestId('payroll-field-f10').fill('4321.5');
    await page.getByTestId('payroll-slip-preview').click();
    await expect(page.getByTestId('payslip-net')).toHaveText('¥4,321.50');
    await page.getByTestId('payroll-slip-save').click();
    await expect(first).toContainText('4,321.50');

    // 下载表格（带已经填的金额），原样上传：看到逐行核对的预览
    const batchId = ((await (await page.request.get('/api/oa/payroll/batches')).json()) as { id: number; title: string }[]).find((b) => b.title === `验收${stamp}`)!.id;
    const sheet = await page.request.get(`/api/oa/payroll/batches/${batchId}/sheet.xlsx`);
    expect(sheet.status()).toBe(200);
    await page.getByTestId('payroll-import').click();
    await page.getByTestId('payroll-import-file').setInputFiles({ name: '工资表.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: await sheet.body() });
    await expect(page.getByTestId('payroll-import-preview')).toContainText('工资表.xlsx');

    // 模板页：新建一个两项的模板
    await page.goto('/admin/payroll/templates');
    await page.getByTestId('payroll-template-new').click();
    await page.getByTestId('payroll-template-name').fill(`模板${stamp}`);
    await page.getByLabel('第 1 个字段的名称').fill('基本工资');
    await page.getByTestId('payroll-template-add-field').click();
    await page.getByLabel('第 2 个字段的名称').fill('实发');
    await page.getByTestId('payroll-template-save').click();
    await expect(page.getByText(`模板${stamp}`)).toBeVisible();
  });
});
