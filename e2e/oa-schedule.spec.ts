// OA-05 浏览器验收：后台「考勤设置 → 排班」与员工「办公 → 我的排班」（docs/OA.md 第 8 节）。
// 依赖演示数据（仅独立演示库），账号：店主 linlan、店员 xiaozhou，密码 yuzu2026。
// 每次用新的名字建班次与考勤组（组里只有 xiaozhou），排在下周（不碰今天以前的日子）；收尾时把排的清掉、组停用。
import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';

async function login(page: Page, username: string) {
  await page.goto('/login');
  await page.fill('#username', username);
  await page.fill('#password', 'yuzu2026');
  await page.getByRole('button', { name: '登录' }).click();
  await page.waitForURL((u) => !u.pathname.startsWith('/login'));
}

type Setup = { shifts: { id: number; name: string }[]; groups: { id: number; name: string; version: number }[]; employees: { staffId: number; name: string }[] };

test.describe('OA-05 排班', () => {
  test('排下周一的班 → 复制到再下一周 → 员工在「我的排班」里看到', async ({ page, browser }) => {
    await login(page, 'linlan');
    const stamp = Date.now().toString(36).slice(-5);
    const me = (await (await page.request.get('/api/auth/me')).json()) as { store: { id: number } };
    const make = async (path: string, data: object) => {
      const r = await page.request.post(`/api/oa/attendance/${path}`, { data: { clientKey: randomUUID(), storeId: me.store.id, ...data } });
      expect(r.status(), await r.text()).toBe(201);
      return (await r.json()) as Setup;
    };
    let setup = (await (await page.request.get('/api/oa/attendance/setup')).json()) as Setup;
    const zhou = setup.employees.find((e) => e.name === '周小舟')!;
    expect(zhou, '演示数据里有店员周小舟').toBeTruthy();
    await make('shifts', { name: `早${stamp}`, startMinute: 540, endMinute: 1080 });
    setup = await make('groups', { name: `排班${stamp}`, gpsRequired: false, memberIds: [zhou.staffId] });
    const group = setup.groups.find((g) => g.name === `排班${stamp}`)!;

    await page.goto('/admin/attendance/schedule');
    await page.getByTestId('att-schedule-group').selectOption(String(group.id));
    await page.getByTestId('att-schedule-next').click();
    const range = (await page.getByTestId('att-schedule-range').innerText()).trim();
    const monday = range.split(' ')[0]!;
    await page.getByTestId(`att-cell-${zhou.staffId}-${monday}`).click();
    await page.getByTestId(`att-cell-shift-早${stamp}`).click();
    await page.getByTestId('att-cell-done').click();
    await page.getByTestId('att-schedule-save').click();
    await expect(page.getByTestId(`att-cell-${zhou.staffId}-${monday}`)).toContainText(`早${stamp}`);
    await expect(page.getByTestId('att-schedule-save')).toBeDisabled();

    // 再下一周：复制上周
    await page.getByTestId('att-schedule-next').click();
    const nextMonday = (await page.getByTestId('att-schedule-range').innerText()).trim().split(' ')[0]!;
    await page.getByTestId('att-schedule-copy').click();
    await expect(page.getByTestId(`att-cell-${zhou.staffId}-${nextMonday}`)).toContainText(`早${stamp}`);
    await page.getByTestId('att-schedule-save').click();
    await expect(page.getByTestId('att-schedule-save')).toBeDisabled();

    // 员工：办公 → 我的排班，翻到那个月看得到
    const ctx = await browser.newContext({ baseURL: test.info().project.use.baseURL });
    const emp = await ctx.newPage();
    await login(emp, 'xiaozhou');
    await emp.getByTestId('user-menu').click();
    await emp.getByTestId('user-menu-oa').click();
    await expect(emp).toHaveURL(/\/oa$/);
    await emp.getByTestId('oa-tile-schedule').click();
    await expect(emp.getByTestId('my-schedule')).toBeVisible();
    for (let i = 0; i < 2 && !(await emp.getByTestId(`my-day-${monday}`).count()); i += 1) await emp.getByTestId('my-schedule-next').click();
    await expect(emp.getByTestId(`my-day-${monday}`)).toContainText(`早${stamp}`);
    await ctx.close();

    // 收尾：清掉这两格、停用组
    const empty = { shiftIds: [], consecutive: false };
    const sid = setup.shifts.find((s) => s.name === `早${stamp}`)!.id;
    const clear = await page.request.post('/api/oa/attendance/schedule', {
      data: {
        clientKey: randomUUID(),
        storeId: me.store.id,
        groupId: group.id,
        cells: [monday, nextMonday].map((date) => ({ staffId: zhou.staffId, date, ...empty, expected: { shiftIds: [sid], consecutive: false } })),
      },
    });
    expect(clear.status(), await clear.text()).toBe(200);
    const off = await page.request.put(`/api/oa/attendance/groups/${group.id}`, { data: { name: `排班${stamp}`, gpsRequired: false, active: false, version: group.version } });
    expect(off.status(), await off.text()).toBe(200);
  });
});
