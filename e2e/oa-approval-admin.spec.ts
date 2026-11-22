// OA-12 浏览器验收：后台「办公审批」三个页签——全部审批单（按关键字筛、点开详情）、看板、模板设置（改「通用」模板的说明保存）。
// 依赖演示数据（仅独立演示库），账号：店主 linlan，密码 yuzu2026（总裁，两项权限都有）。先用接口发一张「通用」单。
import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';

test.describe('OA-12 办公审批管理端', () => {
  test('全部审批单筛到刚发的单、看板打得开、模板设置能保存', async ({ page }) => {
    await page.goto('/login');
    await page.fill('#username', 'linlan');
    await page.fill('#password', 'yuzu2026');
    await page.getByRole('button', { name: '登录' }).click();
    await page.waitForURL((u) => !u.pathname.startsWith('/login'));
    const stamp = Date.now().toString(36).slice(-5);
    const templates = (await (await page.request.get('/api/oa/approval/templates')).json()) as { id: number; code: string }[];
    const general = templates.find((t) => t.code === 'general')!;
    const sent = await page.request.post('/api/oa/approvals', { data: { clientKey: randomUUID(), templateId: general.id, form: { title: `管理端验收${stamp}`, content: 'x' } } });
    expect(sent.status(), await sent.text()).toBe(201);
    const id = ((await sent.json()) as { approval: { id: number } }).approval.id;

    await page.goto('/admin/oa-approvals/all');
    await page.getByTestId('oaa-filter-q').fill(`管理端验收${stamp}`);
    await page.getByTestId(`oaa-row-${id}`).click();
    await expect(page.getByTestId('oa-approval-detail')).toContainText(`管理端验收${stamp}`);

    await page.goto('/admin/oa-approvals/board');
    await expect(page.getByTestId('oaa-board-general-submitted')).not.toHaveText('');

    await page.goto('/admin/oa-approvals/templates');
    await page.getByTestId('oaa-tpl-edit-general').click();
    await page.getByTestId('oaa-tpl-save').click();
    await expect(page.getByTestId('oaa-template-list')).toContainText('通用');
  });
});
