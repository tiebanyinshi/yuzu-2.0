// OA-06 浏览器验收：员工「办公 → 打卡」（定位在范围内打上班卡；范围外改成外勤打卡：事由 + 照片）与后台「考勤设置 → 打卡记录」（docs/OA.md 第 9 节）。
// 依赖演示数据（仅独立演示库），账号：店主 linlan，密码 yuzu2026。
// 每次新开一个店员账号（打过卡的排班不能删、一天最多排 4 个班，用同一个人跑几次就排不下了），建一个从「现在」开始的班次、
// 一个要 GPS 的考勤组（组里只有这个店员）和打卡点，把今天排上这一班；收尾时停用考勤组与打卡点。打卡明细只追加，留在演示库里。
import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { passPortal } from './portal';

async function login(page: Page, username: string) {
  await page.goto('/login');
  await page.fill('#username', username);
  await page.fill('#password', 'yuzu2026');
  await page.getByRole('button', { name: '登录' }).click();
  await passPortal(page);
  await page.waitForURL((u) => !u.pathname.startsWith('/login'));
}

type Setup = {
  shifts: { id: number; name: string }[];
  locations: { id: number; name: string; version: number }[];
  groups: { id: number; name: string; version: number }[];
  employees: { staffId: number; name: string }[];
};
const HERE = { latitude: 31.230416, longitude: 121.473701 };
const FAR = { latitude: 31.26, longitude: 121.52 };
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

test.describe('OA-06 打卡', () => {
  test('范围内打上班卡；范围外改成外勤打卡（事由 + 照片）；后台打卡记录看得到', async ({ page, browser }) => {
    await login(page, 'linlan');
    const stamp = Date.now().toString(36).slice(-5);
    const me = (await (await page.request.get('/api/auth/me')).json()) as { store: { id: number } };
    const make = async (path: string, data: object) => {
      const r = await page.request.post(`/api/oa/attendance/${path}`, { data: { clientKey: randomUUID(), storeId: me.store.id, ...data } });
      expect(r.status(), await r.text()).toBe(201);
      return (await r.json()) as Setup;
    };
    // 新开一个店员
    const username = `pc${stamp}`;
    const hired = await page.request.post('/api/staff', { data: { username, displayName: `打卡员${stamp}`, position: 'front.staff', password: 'yuzu2026' } });
    expect(hired.status(), await hired.text()).toBe(201);
    const empId = ((await hired.json()) as { id: number }).id;
    let setup: Setup;
    // 现在（门店所在地）是第几分钟：班次从现在开始，上班窗口提前 120 分钟，现在正好在窗口里
    const today = (await (await page.request.get('/api/oa/attendance/today')).json()) as { now: number; today: string };
    const start = ((today.now % 1440) + 1440) % 1440;
    await make('shifts', { name: `打${stamp}`, startMinute: start, endMinute: (start + 480) % 1440 });
    setup = await make('locations', { name: `点${stamp}`, lat: HERE.latitude, lng: HERE.longitude, radiusM: 200 });
    const loc = setup.locations.find((l) => l.name === `点${stamp}`)!;
    setup = await make('groups', { name: `打卡${stamp}`, gpsRequired: true, locationIds: [loc.id], memberIds: [empId] });
    const group = setup.groups.find((g) => g.name === `打卡${stamp}`)!;
    const shiftId = setup.shifts.find((s) => s.name === `打${stamp}`)!.id;
    const sch = await page.request.post('/api/oa/attendance/schedule', {
      data: {
        clientKey: randomUUID(),
        storeId: me.store.id,
        groupId: group.id,
        cells: [{ staffId: empId, date: today.today, shiftIds: [shiftId], consecutive: false, expected: { shiftIds: [], consecutive: false } }],
      },
    });
    expect(sch.status(), await sch.text()).toBe(200);

    // 员工：办公 → 打卡，定位在范围内
    const ctx = await browser.newContext({ baseURL: test.info().project.use.baseURL, geolocation: HERE, permissions: ['geolocation'] });
    const emp = await ctx.newPage();
    // 第一次登录要改密码
    const signIn = await emp.request.post('/api/auth/login', { data: { username, password: 'yuzu2026' } });
    expect(signIn.status(), await signIn.text()).toBe(200);
    const changed = await emp.request.post('/api/auth/change-password', { data: { currentPassword: 'yuzu2026', newPassword: `Punch-${stamp}-2026` } });
    expect(changed.status(), await changed.text()).toBe(200);
    await emp.goto('/oa');
    await emp.getByTestId('oa-tile-punch').click();
    await expect(emp).toHaveURL(/\/oa\/punch$/);
    await expect(emp.getByTestId('punch-location')).toContainText('在范围内');
    await expect(emp.getByTestId(`punch-slot-${today.today}-${shiftId}`)).toContainText('现在可以打');
    await emp.getByTestId('punch-button').click();
    await expect(emp.getByTestId('punch-last')).toContainText(`上班卡`);
    await expect(emp.getByTestId('punch-last')).toContainText(`打${stamp}`);
    await expect(emp.getByTestId(`punch-slot-${today.today}-${shiftId}`)).toContainText('已打');

    // 走远了：范围外，改成外勤打卡
    await ctx.setGeolocation(FAR);
    await emp.getByTestId('punch-relocate').click();
    await expect(emp.getByTestId('punch-location')).toContainText('不在范围内');
    await emp.getByTestId('punch-button').click();
    await expect(emp.getByTestId('punch-error')).toContainText('不在打卡范围内');
    await expect(emp.getByTestId('punch-outwork')).toBeVisible();
    await emp.getByTestId('outwork-reason').fill('去供应商那里验货');
    await emp.getByTestId('outwork-photo').setInputFiles({ name: 'p.png', mimeType: 'image/png', buffer: PNG });
    await emp.getByTestId('outwork-submit').click();
    await expect(emp.getByTestId('punch-last')).toContainText('外勤');
    await expect(emp.getByTestId('punch-records')).toContainText('上班卡');
    await ctx.close();

    // 后台：考勤设置 → 打卡记录
    await page.goto('/admin/attendance/punches');
    await expect(page.getByTestId('att-punches-grid')).toContainText(`打卡员${stamp}`);
    await expect(page.getByTestId('att-punches-grid')).toContainText('去供应商那里验货');

    // 收尾：停用考勤组与打卡点（打卡明细只追加，留着）
    const off = await page.request.put(`/api/oa/attendance/groups/${group.id}`, { data: { name: `打卡${stamp}`, gpsRequired: true, active: false, version: group.version } });
    expect(off.status(), await off.text()).toBe(200);
    const offLoc = await page.request.put(`/api/oa/attendance/locations/${loc.id}`, {
      data: { name: `点${stamp}`, lat: HERE.latitude, lng: HERE.longitude, radiusM: 200, active: false, version: loc.version },
    });
    expect(offLoc.status(), await offLoc.text()).toBe(200);
  });
});
