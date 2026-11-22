// OA-09 浏览器验收：后台「考勤设置 → 假种与余额」给一位员工调整今年年假（加 2.5 天，带操作编号），员工「办公 → 假期余额」看得到；
// 「考勤月报」页签打得开（docs/OA.md 第 12 节）。依赖演示数据（仅独立演示库），账号：店主 linlan，密码 yuzu2026。每次新开一个店员账号。
import { expect, test } from '@playwright/test';

test.describe('OA-09 假期余额与考勤月报', () => {
  test('人事调整年假，员工在「假期余额」里看到；考勤月报打得开', async ({ page, browser }) => {
    await page.goto('/login');
    await page.fill('#username', 'linlan');
    await page.fill('#password', 'yuzu2026');
    await page.getByRole('button', { name: '登录' }).click();
    await page.waitForURL((u) => !u.pathname.startsWith('/login'));

    const stamp = Date.now().toString(36).slice(-5);
    const username = `lv${stamp}`;
    const hired = await page.request.post('/api/staff', { data: { username, displayName: `假期员${stamp}`, position: 'front.staff', password: 'yuzu2026' } });
    expect(hired.status(), await hired.text()).toBe(201);
    const empId = ((await hired.json()) as { id: number }).id;
    const types = (await (await page.request.get('/api/oa/leave/types')).json()) as { id: number; name: string }[];
    const annual = types.find((t) => t.name === '年假')!;

    // 后台：假种与余额 → 调整
    await page.goto('/admin/attendance/leave');
    await expect(page.getByTestId('leave-types')).toContainText('年假');
    await page.getByTestId(`leave-adjust-${empId}`).click();
    await page.getByTestId('leave-adjust-days').fill('2.5');
    await page.getByTestId('leave-adjust-reason').fill('浏览器验收');
    await page.getByTestId('leave-adjust-save').click();
    await expect(page.getByTestId(`leave-bal-${empId}-${annual.id}`)).toContainText('2.5 天');

    // 后台：考勤月报
    await page.getByTestId('att-tab-monthly').click();
    await expect(page.getByTestId('att-monthly')).toBeVisible();
    await expect(page.getByTestId('att-monthly-export')).toBeVisible();

    // 员工：办公 → 假期余额
    const ctx = await browser.newContext({ baseURL: test.info().project.use.baseURL });
    const emp = await ctx.newPage();
    expect((await emp.request.post('/api/auth/login', { data: { username, password: 'yuzu2026' } })).status()).toBe(200);
    expect((await emp.request.post('/api/auth/change-password', { data: { currentPassword: 'yuzu2026', newPassword: `Leave-${stamp}-2026` } })).status()).toBe(200);
    await emp.goto('/oa');
    await emp.getByTestId('oa-tile-leave').click();
    await expect(emp.getByTestId(`my-leave-${annual.id}`)).toContainText('2.5 天');
    await expect(emp.getByTestId('leave-entry-list')).toContainText('浏览器验收');
    await ctx.close();
  });
});
