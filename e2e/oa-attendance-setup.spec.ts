// OA-04 浏览器验收：后台「人事与办公 → 考勤设置」（docs/OA.md 第 7 节）。
// 依赖演示数据（仅独立演示库），账号：店主 linlan，密码 yuzu2026。每次用新的名字建班次、打卡点、考勤组，可重复执行；
// 收尾时把建的考勤组停用（成员回到「没进考勤组」），演示库里不留多出来的启用中的组。
import { expect, test, type Page } from '@playwright/test';

async function login(page: Page, username: string) {
  await page.goto('/login');
  await page.fill('#username', username);
  await page.fill('#password', 'yuzu2026');
  await page.getByRole('button', { name: '登录' }).click();
  await page.waitForURL((u) => !u.pathname.startsWith('/login'));
}

test.describe('OA-04 考勤设置', () => {
  test('建班次（窗口重叠的不让存）→ 建打卡点 → 建考勤组、加成员', async ({ page }) => {
    await login(page, 'linlan');
    const stamp = Date.now().toString(36).slice(-5);
    await page.goto('/admin/attendance');
    await expect(page.getByRole('heading', { level: 1, name: '考勤设置' })).toBeVisible();

    // 班次：2 小时的班，上班后 60 分钟与下班前 60 分钟两个窗口碰上了，不让存；改成 8 小时就行
    await page.getByTestId('att-shift-new').click();
    await page.getByTestId('att-shift-name').fill(`夜班${stamp}`);
    await page.getByTestId('att-shift-start').fill('00:00');
    await page.getByTestId('att-shift-end').fill('02:00');
    await expect(page.getByTestId('att-shift-problem')).toContainText('上班窗口要在下班窗口开始之前结束');
    await expect(page.getByTestId('att-shift-save')).toBeDisabled();
    await page.getByTestId('att-shift-end').fill('08:00');
    await page.getByTestId('att-shift-save').click();
    await expect(page.getByTestId('att-shift-list')).toContainText(`夜班${stamp}`);
    await expect(page.getByTestId('att-shift-list')).toContainText('00:00–08:00');

    // 打卡点
    await page.getByTestId('att-tab-locations').click();
    await expect(page).toHaveURL(/\/admin\/attendance\/locations$/);
    await page.getByTestId('att-location-new').click();
    await page.getByTestId('att-location-name').fill(`大门${stamp}`);
    await page.getByTestId('att-location-lat').fill('31.230416');
    await page.getByTestId('att-location-lng').fill('121.473701');
    await page.getByTestId('att-location-radius').fill('200');
    await page.getByTestId('att-location-save').click();
    await expect(page.getByTestId('att-location-list')).toContainText(`大门${stamp}`);
    await expect(page.getByTestId('att-location-list')).toContainText('200 米');

    // 考勤组：要 GPS 时没选打卡点不让存；选上打卡点、加一位成员
    await page.getByTestId('att-tab-groups').click();
    await page.getByTestId('att-group-new').click();
    await page.getByTestId('att-group-name').fill(`前厅${stamp}`);
    await expect(page.getByTestId('att-group-save')).toBeDisabled();
    await page.getByTestId(`att-group-loc-大门${stamp}`).click();
    const first = page.locator('[data-testid^="att-group-member-"]').first();
    await first.check();
    await page.getByTestId('att-group-save').click();
    const list = page.getByTestId('att-group-list');
    await expect(list).toContainText(`前厅${stamp}`);
    await expect(list).toContainText(`大门${stamp}`);

    // 收尾：停用这个组
    await page.getByTestId(`att-group-edit-前厅${stamp}`).click();
    await page.getByText('停用这个考勤组').click();
    await page.getByTestId('att-group-save').click();
    await expect(list.getByText('已停用').first()).toBeVisible();
  });

  test('新建没收到结果：页面上方按原内容重新提交，只建一个；确认前不能再建', async ({ page }) => {
    await login(page, 'linlan');
    const stamp = Date.now().toString(36).slice(-5);
    await page.goto('/admin/attendance');
    let aborted = false;
    await page.route('**/api/oa/attendance/shifts', async (route) => {
      if (!aborted && route.request().method() === 'POST') {
        aborted = true;
        await route.abort('connectionreset');
      } else await route.continue();
    });
    await page.getByTestId('att-shift-new').click();
    await page.getByTestId('att-shift-name').fill(`重提${stamp}`);
    await page.getByTestId('att-shift-start').fill('16:00');
    await page.getByTestId('att-shift-end').fill('00:00');
    await page.getByTestId('att-shift-save').click();
    await expect(page.getByTestId('erp-pending')).toBeVisible();
    // 确认前不能再建一个
    await page.getByTestId('att-shift-new').click();
    await page.getByTestId('att-shift-name').fill(`另一个${stamp}`);
    await page.getByTestId('att-shift-save').click();
    await expect(page.getByTestId('att-shift-problem')).toContainText('上一次新建结果待确认');
    await page.keyboard.press('Escape');
    // 按原内容重新提交：建好一个
    await page.getByTestId('erp-pending-resend').click();
    await expect(page.getByTestId('erp-pending-resend')).toHaveCount(0);
    await expect(page.getByTestId('att-shift-list')).toContainText(`重提${stamp}`);
    await expect(page.getByTestId('att-shift-list').getByText(`重提${stamp}`)).toHaveCount(1);
  });

  test('打卡点三种取点（考勤排班优化第 1 条）：定位当前位置；搜地址从结果里选（店主 2026-11-24 去掉了地图）；手输兜底——保存的是 WGS-84', async ({ browser }) => {
    // 授权定位、模拟一个位置（在门店里用手机打开的情形）
    const ctx = await browser.newContext({ baseURL: test.info().project.use.baseURL, geolocation: { latitude: 31.2297, longitude: 121.4712 }, permissions: ['geolocation'] });
    const page = await ctx.newPage();
    await login(page, 'linlan');
    const stamp = Date.now().toString(36).slice(-5);
    await page.goto('/admin/attendance/locations');

    // ① 定位当前位置：经纬度自动填上；对话框里没有地图
    await page.getByTestId('att-location-new').click();
    await page.getByTestId('att-location-name').fill(`定位${stamp}`);
    await page.getByTestId('att-location-locate').click();
    await expect(page.getByTestId('att-location-lat')).toHaveValue('31.229700');
    await expect(page.getByTestId('att-location-lng')).toHaveValue('121.471200');
    await expect(page.getByTestId('att-map')).toHaveCount(0);
    await page.getByTestId('att-location-save').click();
    await expect(page.getByTestId('att-location-list')).toContainText(`定位${stamp}`);
    await expect(page.getByTestId('att-location-list')).toContainText('31.229700, 121.471200');

    // ② 搜索地址选点（服务器开了搜索时；开发、测试用 GEO_PROVIDER=mock）→ 选一个，经纬度与名称填上 → 保存
    await page.getByTestId('att-location-new').click();
    const provider = ((await (await page.request.get('/api/oa/attendance/geo')).json()) as { provider: string }).provider;
    test.skip(provider !== 'mock', '只在模拟的地址搜索（GEO_PROVIDER=mock）上跑，不连真的地图服务');
    await page.getByTestId('att-location-keyword').fill('演示门店');
    await page.getByTestId('att-location-search-go').click();
    await page.getByTestId('att-location-place-0').click();
    expect(Number(await page.getByTestId('att-location-lat').inputValue())).not.toBe(0);
    await expect(page.getByTestId('att-location-name')).not.toHaveValue('');
    await page.getByTestId('att-location-name').fill(`搜点${stamp}`);
    await page.getByTestId('att-location-save').click();
    await expect(page.getByTestId('att-location-list')).toContainText(`搜点${stamp}`);
    await ctx.close();
  });
});
