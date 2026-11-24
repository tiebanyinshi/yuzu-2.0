// OA-07 浏览器验收：员工「办公 → 人脸录入」拍 3 张提交 → 后台「考勤设置 → 人脸审核」通过 → 员工在要人脸的考勤组打卡（先自拍）
// → 后台打卡记录看得到人脸结果（docs/OA.md 第 10 节）。
// 依赖演示数据（仅独立演示库），账号：店主 linlan，密码 yuzu2026。每次新开一个店员账号与一个要人脸、不要 GPS 的考勤组；收尾停用考勤组。
// 应用没带 INTEGRATIONS_MOCK=true 时人脸比对服务是「没配置」，打卡照常、记「人脸待人工核对」；带了是模拟，记「人脸通过」。
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

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const file = (name: string) => ({ name, mimeType: 'image/png', buffer: PNG });

test.describe('OA-07 人脸录入与审核', () => {
  test('录入 3 张 → 后台通过 → 要人脸的组先自拍再打卡 → 打卡记录有人脸结果', async ({ page, browser }) => {
    await login(page, 'linlan');
    const stamp = Date.now().toString(36).slice(-5);
    const me = (await (await page.request.get('/api/auth/me')).json()) as { store: { id: number } };
    const username = `fc${stamp}`;
    const name = `人脸员${stamp}`;
    const hired = await page.request.post('/api/staff', { data: { username, displayName: name, position: 'front.staff', password: 'yuzu2026' } });
    expect(hired.status(), await hired.text()).toBe(201);
    const empId = ((await hired.json()) as { id: number }).id;
    const g = await page.request.post('/api/oa/attendance/groups', {
      data: { clientKey: randomUUID(), storeId: me.store.id, name: `人脸${stamp}`, gpsRequired: false, faceRequired: true, memberIds: [empId] },
    });
    expect(g.status(), await g.text()).toBe(201);
    const group = ((await g.json()) as { groups: { id: number; name: string; version: number }[] }).groups.find((x) => x.name === `人脸${stamp}`)!;

    // 员工：人脸录入
    const ctx = await browser.newContext({ baseURL: test.info().project.use.baseURL });
    const emp = await ctx.newPage();
    expect((await emp.request.post('/api/auth/login', { data: { username, password: 'yuzu2026' } })).status()).toBe(200);
    expect((await emp.request.post('/api/auth/change-password', { data: { currentPassword: 'yuzu2026', newPassword: `Face-${stamp}-2026` } })).status()).toBe(200);
    await emp.goto('/oa');
    await emp.getByTestId('oa-tile-face').click();
    await expect(emp.getByTestId('face-status')).toContainText('还没录');
    for (const i of [0, 1, 2]) await emp.getByTestId(`face-input-${i}`).setInputFiles(file(`f${i}.png`));
    await emp.getByTestId('face-submit').click();
    await expect(emp.getByTestId('face-status')).toContainText('待审核');

    // 打卡页：还没通过，不能打
    await emp.goto('/oa/punch');
    await expect(emp.getByTestId('punch-face-missing')).toContainText('还在等审核');
    await expect(emp.getByTestId('punch-button')).toBeDisabled();

    // 后台：人脸审核 → 通过
    await page.goto('/admin/attendance/faces');
    await page.getByTestId(`face-approve-${empId}`).click();
    await expect(page.getByTestId(`face-row-${empId}`)).toHaveCount(0);

    // 员工：自拍一张再打卡
    await emp.reload();
    await expect(emp.getByTestId('punch-face')).toBeVisible();
    await expect(emp.getByTestId('punch-button')).toBeDisabled();
    await emp.getByTestId('punch-selfie-input').setInputFiles(file('selfie.png'));
    await emp.getByTestId('punch-button').click();
    await expect(emp.getByTestId('punch-last')).toContainText('刚才');
    await ctx.close();

    // 后台：打卡记录里有人脸结果（没配置比对服务时待人工核对，模拟时通过）
    await page.goto('/admin/attendance/punches');
    const grid = page.getByTestId('att-punches-grid');
    await expect(grid).toContainText(name);
    await expect(grid).toContainText(/人脸(通过|待人工核对)/);

    const off = await page.request.put(`/api/oa/attendance/groups/${group.id}`, { data: { name: `人脸${stamp}`, gpsRequired: false, faceRequired: true, active: false, version: group.version } });
    expect(off.status(), await off.text()).toBe(200);
  });
});
