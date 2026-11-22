// OA-13 浏览器验收：后台「考勤设置 → 节假日」录一天、保存、重新载入还在；「考勤月报」有请假明细一列；
// 员工「办公 → 我的考勤」的汇总有请假、出差、加班（docs/OA.md 第 16 节）。审批通过对考勤的联动由 tests/oa-attendance-link.test.ts 覆盖。
// 依赖演示数据（仅独立演示库），账号：店主 linlan，密码 yuzu2026。每次新开一个店员账号；节假日用明年那一页，每次先清空再录。
import { expect, test } from '@playwright/test';

test.describe('OA-13 考勤与审批联动', () => {
  test('节假日表录入保存；月报有请假明细；我的考勤汇总有请假、出差、加班', async ({ page, browser }) => {
    await page.goto('/login');
    await page.fill('#username', 'linlan');
    await page.fill('#password', 'yuzu2026');
    await page.getByRole('button', { name: '登录' }).click();
    await page.waitForURL((u) => !u.pathname.startsWith('/login'));

    // 后台：节假日（明年）
    await page.goto('/admin/attendance/holidays');
    const year = page.getByTestId('att-holidays-year');
    await expect(year).toBeEnabled();
    const next = String(Number(await year.inputValue()) + 1);
    await year.selectOption(next);
    await expect(page.getByTestId('att-holidays-add')).toBeEnabled();
    // 上次跑剩下的先删掉
    const list = page.getByTestId('att-holidays-list');
    if (await list.isVisible()) {
      for (let n = await list.locator('li').count(); n > 0; n -= 1) await list.locator('li').first().getByRole('button', { name: '删掉这一天' }).click();
      await page.getByTestId('att-holidays-save').click();
      await expect(page.getByTestId('att-holidays-save')).toBeDisabled();
    }
    await page.getByTestId('att-holidays-add').click();
    const row = page.getByTestId('att-holiday-0');
    await row.getByLabel('日期').fill(`${next}-10-01`);
    await row.getByLabel('名称').fill('国庆节');
    await page.getByTestId('att-holidays-save').click();
    await expect(page.getByTestId('att-holidays-save')).toBeDisabled();
    await page.reload();
    await page.getByTestId('att-holidays-year').selectOption(next);
    await expect(page.getByTestId('att-holiday-0').getByLabel('名称')).toHaveValue('国庆节');

    // 后台：考勤月报有请假明细一列
    await page.getByTestId('att-tab-monthly').click();
    await expect(page.getByTestId('att-monthly')).toContainText('请假明细');

    // 员工：我的考勤汇总
    const stamp = Date.now().toString(36).slice(-5);
    const username = `lk${stamp}`;
    const hired = await page.request.post('/api/staff', { data: { username, displayName: `联动员${stamp}`, position: 'front.staff', password: 'yuzu2026' } });
    expect(hired.status(), await hired.text()).toBe(201);
    const ctx = await browser.newContext({ baseURL: test.info().project.use.baseURL });
    const emp = await ctx.newPage();
    expect((await emp.request.post('/api/auth/login', { data: { username, password: 'yuzu2026' } })).status()).toBe(200);
    expect((await emp.request.post('/api/auth/change-password', { data: { currentPassword: 'yuzu2026', newPassword: `Link-${stamp}-2026` } })).status()).toBe(200);
    await emp.goto('/oa/attendance');
    const summary = emp.getByTestId('my-attendance-summary');
    await expect(summary).toContainText('请假（天）');
    await expect(summary).toContainText('出差（天）');
    await expect(summary).toContainText('加班（小时）');
    await ctx.close();
  });
});
