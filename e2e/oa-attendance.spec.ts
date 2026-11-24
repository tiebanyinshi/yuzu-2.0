// OA-08 浏览器验收：后台「考勤设置 → 考勤结果」重新结算今天一条已经结束的排班（没打卡 → 旷工），员工「办公 → 我的考勤」看得到（docs/OA.md 第 11 节）。
// 依赖演示数据（仅独立演示库），账号：店主 linlan，密码 yuzu2026。每次新开一个店员账号、一个考勤组，建一个今天已经结束的短班次
// （半小时前开始、二十分钟前结束、打卡窗口都是 0）；收尾停用考勤组。门店所在地零点半以前跑不了（今天还没有「已经结束」的时段），跳过。
import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { passPortal } from './portal';

test.describe('OA-08 考勤结算', () => {
  test('今天已经结束的一班没打卡：重新结算后是旷工；员工在「我的考勤」里看到', async ({ page, browser }) => {
    await page.goto('/login');
    await page.fill('#username', 'linlan');
    await page.fill('#password', 'yuzu2026');
    await page.getByRole('button', { name: '登录' }).click();
    await passPortal(page);
    await page.waitForURL((u) => !u.pathname.startsWith('/login'));
    const today = (await (await page.request.get('/api/oa/attendance/today')).json()) as { now: number; today: string };
    const minute = ((today.now % 1440) + 1440) % 1440;
    test.skip(minute < 31, '门店所在地零点半以前：今天还没有已经结束的时段');

    const stamp = Date.now().toString(36).slice(-5);
    const me = (await (await page.request.get('/api/auth/me')).json()) as { store: { id: number } };
    const username = `ad${stamp}`;
    const name = `考勤员${stamp}`;
    const hired = await page.request.post('/api/staff', { data: { username, displayName: name, position: 'front.staff', password: 'yuzu2026' } });
    expect(hired.status(), await hired.text()).toBe(201);
    const empId = ((await hired.json()) as { id: number }).id;
    const make = async (path: string, data: object) => {
      const r = await page.request.post(`/api/oa/attendance/${path}`, { data: { clientKey: randomUUID(), storeId: me.store.id, ...data } });
      expect(r.status(), await r.text()).toBe(201);
      return (await r.json()) as { shifts: { id: number; name: string }[]; groups: { id: number; name: string; version: number }[] };
    };
    const zero = { inAdvanceMinutes: 0, lateGraceMinutes: 0, inAfterMinutes: 0, outBeforeMinutes: 0, outDelayMinutes: 0 };
    let s = await make('shifts', { name: `短${stamp}`, startMinute: minute - 30, endMinute: minute - 20, ...zero });
    const shiftId = s.shifts.find((x) => x.name === `短${stamp}`)!.id;
    s = await make('groups', { name: `结算${stamp}`, gpsRequired: false, memberIds: [empId] });
    const group = s.groups.find((g) => g.name === `结算${stamp}`)!;
    const sch = await page.request.post('/api/oa/attendance/schedule', {
      data: {
        clientKey: randomUUID(),
        storeId: me.store.id,
        groupId: group.id,
        cells: [{ staffId: empId, date: today.today, shiftIds: [shiftId], consecutive: false, expected: { shiftIds: [], consecutive: false } }],
      },
    });
    expect(sch.status(), await sch.text()).toBe(200);

    // 后台：考勤结果 → 选今天 → 重新结算
    await page.goto('/admin/attendance/results');
    await page.getByTestId('att-results-date').fill(today.today);
    await page.getByTestId('att-results-settle').click();
    await expect(page.getByTestId(`att-result-${empId}`)).toContainText('旷工');

    // 员工：办公 → 我的考勤
    const ctx = await browser.newContext({ baseURL: test.info().project.use.baseURL });
    const emp = await ctx.newPage();
    expect((await emp.request.post('/api/auth/login', { data: { username, password: 'yuzu2026' } })).status()).toBe(200);
    expect((await emp.request.post('/api/auth/change-password', { data: { currentPassword: 'yuzu2026', newPassword: `Att-${stamp}-2026` } })).status()).toBe(200);
    await emp.goto('/oa');
    await emp.getByTestId('oa-tile-attendance').click();
    await expect(emp.getByTestId(`my-att-${today.today}-${shiftId}`)).toContainText('旷工');
    await ctx.close();

    const off = await page.request.put(`/api/oa/attendance/groups/${group.id}`, { data: { name: `结算${stamp}`, gpsRequired: false, active: false, version: group.version } });
    expect(off.status(), await off.text()).toBe(200);
  });
});
