// 员工办公 v1.1 第 1 批（店主 2026-11-25《员工办公系统建设需求文档 v1.1》，docs/OA_MOBILE.md）浏览器核对：
//   · 手机（360 × 800，微信内置浏览器）：扫码打开 /oa → 员工登录（不写「登录已过期」）→ 回到工作台；底部 4 个 Tab、顶部公司名 + 搜索、
//     「今天」打卡卡片、宫格、搜索筛宫格、「我的」页、子页面「返回」、不横向滚动；
//   · 电脑：WCP 顶栏的通知铃铛与头像菜单、左边一列有「我的」；「WCP 设置 → 组织架构 → 手机端入口」出二维码，只认 https。
// 依赖演示数据（仅独立演示库）：店主 linlan、店员 xiaozhou。手机尺寸自己开上下文，只在门店电脑那一组跑一次。
import { expect, test } from '@playwright/test';

const PASSWORD = 'yuzu2026';
const WECHAT_UA =
  'Mozilla/5.0 (Linux; Android 14; 23013RK75C) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/122.0 Mobile Safari/537.36 MicroMessenger/8.0.50.2600 NetType/WIFI Language/zh_CN';

test.describe('员工办公 v1.1 第 1 批：手机框架与登录', () => {
  test.beforeEach(({}, info) => {
    test.skip(info.project.name !== '门店电脑', '手机尺寸自己开上下文，只在门店电脑那一组跑一次');
  });

  test('手机：扫码打开 /oa → 员工登录 → 工作台；底部 4 个 Tab、搜索、我的、返回', async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 360, height: 800 }, isMobile: true, hasTouch: true, userAgent: WECHAT_UA, locale: 'zh-CN', timezoneId: 'Asia/Shanghai' });
    const page = await context.newPage();
    await page.goto('/oa');
    await page.waitForURL((u) => u.pathname === '/login');
    await expect(page.getByTestId('login-title')).toHaveText('员工登录');
    // 没登录就打开的不是「登录已过期」
    await expect(page.getByText('登录已过期')).toHaveCount(0);
    await page.fill('#username', 'xiaozhou');
    await page.fill('#password', PASSWORD);
    await page.getByRole('button', { name: '登录' }).click();
    await page.waitForURL((u) => u.pathname === '/oa', { timeout: 30_000 });

    // 手机布局：顶部公司名、实例标识与版本常显；电脑的顶栏与左边一列不出
    await expect(page.getByTestId('wcp-mobile-company')).toBeVisible();
    await expect(page.getByTestId('wcp-mobile-instance')).toContainText('v');
    await expect(page.getByTestId('wcp-instance')).toBeHidden();
    await expect(page.getByTestId('wcp-tabbar')).toBeVisible();
    await expect(page.getByTestId('wcp-tab-work')).toHaveAttribute('aria-current', 'page');
    await expect(page.getByTestId('oa-today-card')).toBeVisible();
    await expect(page.getByTestId('oa-tile-makeup')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

    // 搜索：按名字筛宫格
    await page.getByTestId('wcp-mobile-search').fill('工资');
    await expect(page).toHaveURL(/\/oa\?q=/);
    await expect(page.getByTestId('oa-tile-payslips')).toBeVisible();
    await expect(page.getByTestId('oa-tile-punch')).toHaveCount(0);
    // 点底部「工作台」清掉搜索：宫格恢复，框里也清空（Codex 审查 6c8e9e7）
    await page.getByTestId('wcp-tab-work').click();
    await expect(page.getByTestId('oa-tile-punch')).toBeVisible();
    await expect(page.getByTestId('wcp-mobile-search')).toHaveValue('');

    // 子页面：工作台亮着，顶栏左边「返回」回工作台
    await page.getByTestId('oa-tile-payslips').click();
    await expect(page).toHaveURL(/\/oa\/payslips/);
    await expect(page.getByTestId('wcp-tab-work')).toHaveAttribute('aria-current', 'page');
    await page.getByTestId('wcp-mobile-back').click();
    await expect.poll(() => new URL(page.url()).pathname).toBe('/oa');

    // 消息、知识库
    await page.getByTestId('wcp-tab-messages').click();
    await expect.poll(() => new URL(page.url()).pathname).toBe('/oa/im');
    await expect(page.getByTestId('wcp-tab-messages')).toHaveAttribute('aria-current', 'page');
    await page.getByTestId('wcp-tab-knowledge').click();
    await expect.poll(() => new URL(page.url()).pathname).toBe('/oa/training');

    // 我的：头像与账号、假期余额、本月排班、人脸录入、设置
    await page.getByTestId('wcp-tab-me').click();
    await expect.poll(() => new URL(page.url()).pathname).toBe('/oa/me');
    await expect(page.getByTestId('oa-me-profile')).toContainText('xiaozhou');
    await expect(page.getByTestId('oa-me-leave')).toBeVisible();
    await expect(page.getByTestId('my-schedule-legend')).toBeVisible();
    await expect(page.getByTestId('oa-me-face-status')).not.toBeEmpty();
    await expect(page.getByTestId('oa-me-password')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    // 取不回来时用公共的「重试」，连上以后照常显示（Codex 审查 6c8e9e7）
    await page.route('**/api/oa/me/leave', (route) => route.fulfill({ status: 503, json: { error: { code: 'BUSY', message: '系统忙' } } }));
    await page.reload();
    await expect(page.getByTestId('oa-me-leave').getByRole('button', { name: /重试/ })).toBeVisible({ timeout: 20_000 });
    await page.unroute('**/api/oa/me/leave');
    await page.getByTestId('oa-me-leave').getByRole('button', { name: /重试/ }).click();
    await expect(page.getByTestId('oa-me-leave').getByRole('button', { name: /重试/ })).toHaveCount(0);
    await page.getByTestId('oa-me-logout').click();
    await page.waitForURL((u) => u.pathname === '/login');
    await context.close();
  });

  test('电脑：WCP 顶栏有通知铃铛与头像菜单；组织架构里出手机端入口二维码，只认 https', async ({ page }) => {
    await page.goto('/login');
    await page.fill('#username', 'linlan');
    await page.fill('#password', PASSWORD);
    await page.getByRole('button', { name: '登录' }).click();
    await page.waitForURL((u) => u.pathname === '/', { timeout: 30_000 });
    await page.goto('/oa');
    await expect(page.getByTestId('wcp-instance')).toBeVisible();
    await expect(page.getByTestId('wcp-tabbar')).toBeHidden();
    const header = page.getByTestId('wcp-shell').locator('header').first();
    await expect(header.getByTestId('notification-bell')).toBeVisible();
    await header.getByTestId('user-menu').click();
    await expect(page.getByTestId('user-menu-logout')).toBeVisible();
    await page.keyboard.press('Escape');
    await page.getByTestId('wcp-nav-wcp-me').click();
    await expect(page.getByTestId('oa-me-profile')).toContainText('linlan');

    await page.goto('/admin/org');
    await page.getByTestId('org-mobile-entry').click();
    await expect(page.getByTestId('oa-mobile-url')).toHaveText(/^https:\/\/.+\/oa$/);
    await page.getByTestId('oa-mobile-origin').fill('http://192.168.1.10:8080');
    await expect(page.getByTestId('oa-mobile-url')).toHaveCount(0);
    await expect(page.getByTestId('oa-mobile-entry')).toContainText('要填 https 开头的地址');
    await page.getByTestId('oa-mobile-origin').fill('https://staff.example.com/whatever');
    await expect(page.getByTestId('oa-mobile-url')).toHaveText('https://staff.example.com/oa');
  });

  test('第 2 批手机（360×800）：打卡卡片「该打什么卡」、月历点选详情、获授排班权限后手机编排并发布', async ({ page, browser }) => {
    const { randomUUID } = await import('node:crypto');
    // 店主先建一位有岗位的演示员工、此刻在上班窗口内的班次与考勤组，发布排班并授其排班+发布权
    await page.goto('/login');
    await page.fill('#username', 'linlan');
    await page.fill('#password', PASSWORD);
    await page.getByRole('button', { name: '登录' }).click();
    await page.waitForURL((u) => u.pathname === '/', { timeout: 30_000 });
    const stamp = Date.now().toString(36).slice(-5);
    const username = `oam2${stamp}`;
    const displayName = `手排员${stamp}`;
    const hired = await page.request.post('/api/staff', { data: { username, displayName, position: 'front.staff', password: PASSWORD } });
    expect(hired.status(), await hired.text()).toBe(201);
    const emp = (await hired.json()) as { id: number };
    const me = (await (await page.request.get('/api/auth/me')).json()) as { store: { id: number } };
    const tdy = (await (await page.request.get('/api/oa/attendance/today')).json()) as { now: number; today: string };
    const startMinute = ((tdy.now % 1440) + 1440) % 1440;
    const make = async (path: string, data: object) => {
      const r = await page.request.post(`/api/oa/attendance/${path}`, { data: { clientKey: randomUUID(), storeId: me.store.id, ...data } });
      expect(r.status(), await r.text()).toBe(201);
      return (await r.json()) as { shifts: { id: number; name: string }[]; groups: { id: number; name: string; version: number }[] };
    };
    await make('shifts', { name: `手${stamp}`, startMinute, endMinute: (startMinute + 480) % 1440 });
    const setup = await make('groups', { name: `手排${stamp}`, gpsRequired: false, memberIds: [emp.id] });
    const group = setup.groups.find((g) => g.name === `手排${stamp}`)!;
    const shiftId = setup.shifts.find((s) => s.name === `手${stamp}`)!.id;

    // 排今天的班并发布
    const sv = await page.request.post('/api/oa/attendance/schedule', {
      data: {
        clientKey: randomUUID(),
        storeId: me.store.id,
        groupId: group.id,
        cells: [{ staffId: emp.id, date: tdy.today, shiftIds: [shiftId], consecutive: false, expected: { shiftIds: [], consecutive: false } }],
      },
    });
    expect(sv.status(), await sv.text()).toBe(200);
    const pb = await page.request.post('/api/oa/attendance/schedule/publish', {
      data: { clientKey: randomUUID(), storeId: me.store.id, groupId: group.id, from: tdy.today, to: tdy.today },
    });
    expect(pb.status(), await pb.text()).toBe(200);

    // 授该员工该考勤组的编排+发布权
    const gr = await page.request.post('/api/oa/attendance/schedule-grants', {
      data: {
        clientKey: randomUUID(),
        storeId: me.store.id,
        granteeStaffId: emp.id,
        permissions: ['view', 'edit', 'publish'],
        scopeType: 'group',
        scopeGroupId: group.id,
        note: `手机排班${stamp}`,
      },
    });
    expect(gr.status(), await gr.text()).toBe(201);
    const grantId = ((await gr.json()) as { grant: { id: number } }).grant.id;

    // 手机 360×800 登录该员工（首次登录需先改临时密码）
    const context = await browser.newContext({ viewport: { width: 360, height: 800 }, isMobile: true, hasTouch: true, userAgent: WECHAT_UA, locale: 'zh-CN', timezoneId: 'Asia/Shanghai' });
    const mp = await context.newPage();
    const signIn = await mp.request.post('/api/auth/login', { data: { username, password: PASSWORD } });
    expect(signIn.status(), await signIn.text()).toBe(200);
    const changed = await mp.request.post('/api/auth/change-password', { data: { currentPassword: PASSWORD, newPassword: `Mobile-${stamp}-2026` } });
    expect(changed.status(), await changed.text()).toBe(200);
    await mp.goto('/oa');
    await mp.waitForURL((u) => u.pathname === '/oa', { timeout: 30_000 });

    // 打卡卡片显示「打上班卡」，宫格出现「排班管理」，零横向滚动
    await expect(mp.getByTestId('oa-today-next')).toHaveAttribute('data-action', 'in');
    await expect(mp.getByTestId('oa-today-next')).toContainText('打上班卡');
    await expect(mp.getByTestId('oa-today-punch')).toContainText('打上班卡');
    await expect(mp.getByTestId('oa-tile-schedule-manage')).toBeVisible();
    expect(await mp.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

    // 我的排班：点今天看详情，并从「排班管理」入口进手机排班页
    await mp.getByTestId('oa-tile-schedule').click();
    await expect(mp.getByTestId('my-schedule-detail')).toContainText(`手${stamp}`);
    await mp.getByTestId('my-schedule-manage').click();
    await expect(mp).toHaveURL(/\/oa\/schedule\/manage$/);
    await expect(mp.getByTestId('mobile-schedule-manage')).toBeVisible();
    expect(await mp.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

    // 手机排班管理：切到「按天」再切回「按人」，翻到下周一编辑草稿并发布
    await mp.getByTestId('mobile-sch-mode-day').click();
    expect(await mp.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await mp.getByTestId('mobile-sch-mode-person').click();
    await mp.getByTestId('mobile-sch-next').click();
    const nextMonday = (await mp.getByTestId('mobile-sch-range').innerText()).trim().split(' ')[0]!;
    await mp.getByTestId(`mobile-cell-${emp.id}-${nextMonday}`).click();
    await mp.getByTestId(`att-cell-shift-手${stamp}`).click();
    await mp.getByTestId('att-cell-done').click();
    await mp.getByTestId('mobile-sch-save').click();
    await expect(mp.getByTestId('mobile-sch-status')).toContainText('待发布');
    await mp.getByTestId('mobile-sch-publish').click();
    await mp.getByTestId('att-publish-confirm').click();
    await expect(mp.getByTestId('mobile-sch-status')).toContainText('已发布');
    await expect(mp.getByTestId('mobile-sch-last-publish')).toContainText(nextMonday);
    expect(await mp.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await context.close();

    // 收尾：撤销授权、停用组与临时员工
    expect((await page.request.delete(`/api/oa/attendance/schedule-grants/${grantId}`, { data: { reason: '演练收尾' } })).status()).toBe(200);
    expect((await page.request.put(`/api/oa/attendance/groups/${group.id}`, { data: { name: `手排${stamp}`, gpsRequired: false, active: false, version: group.version } })).status()).toBe(200);
    expect((await page.request.put(`/api/staff/${emp.id}`, { data: { displayName, position: 'front.staff', active: false } })).status()).toBe(200);
  });
});
