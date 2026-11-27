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
    // 「知识库」改叫「学堂」（XT01，docs/ACADEMY.md）：学堂首页里有知识库入口
    await page.getByTestId('wcp-tab-knowledge').click();
    await expect.poll(() => new URL(page.url()).pathname).toBe('/oa/academy');
    await expect(page.getByTestId('wcp-tab-knowledge')).toHaveText(/学堂/);
    await page.getByTestId('academy-entry-knowledge').click();
    await expect.poll(() => new URL(page.url()).pathname).toBe('/oa/training');
    await expect(page.getByTestId('wcp-tab-knowledge')).toHaveAttribute('aria-current', 'page');

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
    expect(
      (
        await page.request.post(`/api/oa/attendance/schedule-grants/${grantId}/revoke`, {
          data: { clientKey: randomUUID(), storeId: me.store.id, reason: '演练收尾' },
        })
      ).status(),
    ).toBe(200);
    expect((await page.request.put(`/api/oa/attendance/groups/${group.id}`, { data: { name: `手排${stamp}`, gpsRequired: false, active: false, version: group.version } })).status()).toBe(200);
    expect((await page.request.put(`/api/staff/${emp.id}`, { data: { displayName, position: 'front.staff', active: false } })).status()).toBe(200);
  });

  test('第 3 批手机（360×800）：我的考勤异常筛选、一键预填补卡与请假发起审批', async ({ page, browser }) => {
    const { randomUUID } = await import('node:crypto');
    const shiftDay = (iso: string, delta: number) => {
      const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
      return new Date(Date.UTC(y, m - 1, d + delta)).toISOString().slice(0, 10);
    };
    await page.goto('/login');
    await page.fill('#username', 'linlan');
    await page.fill('#password', PASSWORD);
    await page.getByRole('button', { name: '登录' }).click();
    await page.waitForURL((u) => u.pathname === '/', { timeout: 30_000 });

    const stamp = Date.now().toString(36).slice(-5);
    const username = `oam3${stamp}`;
    const displayName = `补卡员${stamp}`;
    const hired = await page.request.post('/api/staff', { data: { username, displayName, position: 'front.staff', password: PASSWORD } });
    expect(hired.status(), await hired.text()).toBe(201);
    const emp = (await hired.json()) as { id: number };
    const me = (await (await page.request.get('/api/auth/me')).json()) as { store: { id: number } };
    const tdy = (await (await page.request.get('/api/oa/attendance/today')).json()) as { now: number; today: string };
    const minute = ((tdy.now % 1440) + 1440) % 1440;
    test.skip(minute < 31, '门店所在地零点半以前：今天还没有已经结束的时段');
    const targetDay = tdy.today;
    const tomorrow = shiftDay(tdy.today, 1);

    const make = async (path: string, data: object) => {
      const r = await page.request.post(`/api/oa/attendance/${path}`, { data: { clientKey: randomUUID(), storeId: me.store.id, ...data } });
      expect(r.status(), await r.text()).toBe(201);
      return (await r.json()) as { shifts: { id: number; name: string }[]; groups: { id: number; name: string; version: number }[] };
    };
    // 今天已经结束的短班次（半小时前开始、二十分钟前结束，打卡窗口为 0），结算必成旷工（missingIn + missingOut）
    const zero = { inAdvanceMinutes: 0, lateGraceMinutes: 0, inAfterMinutes: 0, outBeforeMinutes: 0, outDelayMinutes: 0 };
    await make('shifts', { name: `补${stamp}`, startMinute: minute - 30, endMinute: minute - 20, ...zero });
    const setup = await make('groups', { name: `补组${stamp}`, gpsRequired: false, memberIds: [emp.id] });
    const group = setup.groups.find((g) => g.name === `补组${stamp}`)!;
    const shiftId = setup.shifts.find((s) => s.name === `补${stamp}`)!.id;

    // 排今日与明日并发布，随后结算今日产生异常
    const sv = await page.request.post('/api/oa/attendance/schedule', {
      data: {
        clientKey: randomUUID(),
        storeId: me.store.id,
        groupId: group.id,
        cells: [
          { staffId: emp.id, date: targetDay, shiftIds: [shiftId], consecutive: false, expected: { shiftIds: [], consecutive: false } },
          { staffId: emp.id, date: tomorrow, shiftIds: [shiftId], consecutive: false, expected: { shiftIds: [], consecutive: false } },
        ],
      },
    });
    expect(sv.status(), await sv.text()).toBe(200);
    const pb = await page.request.post('/api/oa/attendance/schedule/publish', {
      data: { clientKey: randomUUID(), storeId: me.store.id, groupId: group.id, from: targetDay, to: tomorrow },
    });
    expect(pb.status(), await pb.text()).toBe(200);
    const settled = await page.request.post('/api/oa/attendance/daily/settle', { data: { date: targetDay, storeId: me.store.id } });
    expect(settled.status(), await settled.text()).toBe(200);

    // 手机 360×800 登录员工
    const empCtx = await browser.newContext({ viewport: { width: 360, height: 800 }, isMobile: true, hasTouch: true, userAgent: WECHAT_UA, locale: 'zh-CN', timezoneId: 'Asia/Shanghai' });
    const mp = await empCtx.newPage();
    expect((await mp.request.post('/api/auth/login', { data: { username, password: PASSWORD } })).status()).toBe(200);
    expect((await mp.request.post('/api/auth/change-password', { data: { currentPassword: PASSWORD, newPassword: `Mobile3-${stamp}-2026` } })).status()).toBe(200);
    await mp.goto('/oa/attendance');
    await expect(mp.getByTestId('my-attendance-summary')).toBeVisible({ timeout: 20_000 });
    expect(await mp.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

    // 切到「异常」标签，点「补上班卡」自动带入日期、班次与补哪张卡
    await mp.getByTestId('my-att-tab-abnormal').click();
    await expect(mp.getByTestId(`my-att-${targetDay}-${shiftId}`)).toContainText('旷工');
    await mp.getByTestId(`my-att-makeup-${targetDay}-${shiftId}-in`).click();
    await expect(mp).toHaveURL(new RegExp(`/oa/approvals/new/makeup\\?date=${targetDay}&shiftId=${shiftId}&kind=in`));
    await expect(mp.getByTestId('oa-makeup-prefill-notice')).toBeVisible();
    await expect(mp.getByTestId('oa-field-date')).toHaveValue(targetDay);
    await expect(mp.getByTestId('oa-field-shiftId')).toHaveValue(String(shiftId));
    await expect(mp.getByTestId('oa-field-kind')).toHaveValue('上班卡');
    expect(await mp.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await mp.getByTestId('oa-field-reason').fill('手机端忘打上班卡');
    await mp.getByTestId('oa-approval-submit').click();
    await expect(mp.getByTestId('oa-approval-status')).toHaveText('审批中');
    const makeupId = Number(new URL(mp.url()).pathname.split('/').pop());
    expect(await mp.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

    // 回「我的考勤」看到「补上班卡审批中」
    await mp.goto('/oa/attendance');
    await expect(mp.getByTestId(`my-att-makeup-pending-${targetDay}-${shiftId}-in`)).toBeVisible();

    // 手机 360×800 发起请假审批（选事假，不依赖年假余额）
    const leaveTypes = (await (await mp.request.get('/api/oa/leave/types')).json()) as { id: number; name: string; active: boolean; hasBalance: boolean; proofRequired: boolean }[];
    const pickLeave = leaveTypes.find((t) => t.active && !t.hasBalance && !t.proofRequired) ?? leaveTypes.find((t) => t.active)!;
    await mp.goto('/oa/approvals/new/leave');
    await expect(mp.getByTestId('oa-approval-form')).toBeVisible();
    await mp.getByTestId('oa-field-leaveTypeId').selectOption(String(pickLeave.id));
    await mp.getByTestId('oa-field-start-date').fill(tomorrow);
    await mp.getByTestId('oa-field-start-half').selectOption('am');
    await mp.getByTestId('oa-field-end-date').fill(tomorrow);
    await mp.getByTestId('oa-field-end-half').selectOption('am');
    await mp.getByTestId('oa-field-reason').fill('家中有事请半天');
    expect(await mp.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await mp.getByTestId('oa-approval-submit').click();
    await expect(mp.getByTestId('oa-approval-status')).toHaveText('审批中');
    const leaveId = Number(new URL(mp.url()).pathname.split('/').pop());

    // 审批人（linlan）手机 360×800 打开审批列表并逐个通过，零横向滚动
    const mgrCtx = await browser.newContext({ viewport: { width: 360, height: 800 }, isMobile: true, hasTouch: true, userAgent: WECHAT_UA, locale: 'zh-CN', timezoneId: 'Asia/Shanghai' });
    const mgr = await mgrCtx.newPage();
    expect((await mgr.request.post('/api/auth/login', { data: { username: 'linlan', password: PASSWORD } })).status()).toBe(200);
    await mgr.goto('/oa/approvals?box=todo');
    await expect(mgr.getByTestId(`oa-approval-${makeupId}`)).toBeVisible({ timeout: 20_000 });
    expect(await mgr.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await mgr.getByTestId(`oa-approval-${makeupId}`).click();
    expect(await mgr.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await mgr.getByTestId('oa-approval-approve').click();
    await expect(mgr.getByTestId('oa-approval-status')).toHaveText('已通过');

    await mgr.goto(`/oa/approvals/${leaveId}`);
    await mgr.getByTestId('oa-approval-approve').click();
    await expect(mgr.getByTestId('oa-approval-status')).toHaveText('已通过');
    await mgrCtx.close();

    // 员工刷新「我的考勤」：补上班卡已生效（仅剩补下班卡）
    await mp.goto('/oa/attendance');
    await expect(mp.getByTestId(`my-att-makeup-${targetDay}-${shiftId}-in`)).toHaveCount(0);
    await expect(mp.getByTestId(`my-att-makeup-pending-${targetDay}-${shiftId}-in`)).toHaveCount(0);
    await expect(mp.getByTestId(`my-att-makeup-${targetDay}-${shiftId}-out`)).toBeVisible();
    await empCtx.close();

    // 收尾：停用临时考勤组与员工
    expect((await page.request.put(`/api/oa/attendance/groups/${group.id}`, { data: { name: `补组${stamp}`, gpsRequired: false, active: false, version: group.version } })).status()).toBe(200);
    expect((await page.request.put(`/api/staff/${emp.id}`, { data: { displayName, position: 'front.staff', active: false } })).status()).toBe(200);
  });

  test('第 4 批手机（360×800）：用章发起 / 催办 / 转交审批，以及「消息」分栏与聊天+系统通知合并红点', async ({ page, browser }) => {
    await page.goto('/login');
    await page.fill('#username', 'linlan');
    await page.fill('#password', PASSWORD);
    await page.getByRole('button', { name: '登录' }).click();
    await page.waitForURL((u) => u.pathname === '/', { timeout: 30_000 });

    const stamp = Date.now().toString(36).slice(-5);
    const hire = async (username: string, displayName: string, position: string) => {
      const r = await page.request.post('/api/staff', { data: { username, displayName, position, password: PASSWORD } });
      expect(r.status(), await r.text()).toBe(201);
      return ((await r.json()) as { id: number }).id;
    };
    const staffUser = `oam4a${stamp}`;
    const transUser = `oam4b${stamp}`;
    const staffId = await hire(staffUser, `用章员${stamp}`, 'front.staff');
    const transId = await hire(transUser, `接手人${stamp}`, 'hr.lead');
    const tdy = (await (await page.request.get('/api/oa/attendance/today')).json()) as { today: string };

    // 1) 员工手机 360×800 发起「用章」审批并催办
    const empCtx = await browser.newContext({ viewport: { width: 360, height: 800 }, isMobile: true, hasTouch: true, userAgent: WECHAT_UA, locale: 'zh-CN', timezoneId: 'Asia/Shanghai' });
    const empPage = await empCtx.newPage();
    expect((await empPage.request.post('/api/auth/login', { data: { username: staffUser, password: PASSWORD } })).status()).toBe(200);
    expect((await empPage.request.post('/api/auth/change-password', { data: { currentPassword: PASSWORD, newPassword: `Mobile4-${stamp}-2026` } })).status()).toBe(200);
    await empPage.goto('/oa/approvals/new');
    await expect(empPage.getByTestId('oa-approval-tpl-seal')).toBeVisible({ timeout: 20_000 });
    expect(await empPage.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await empPage.getByTestId('oa-approval-tpl-seal').click();
    await expect(empPage.getByTestId('oa-approval-form')).toBeVisible();
    await empPage.getByTestId('oa-field-sealType').selectOption('合同专用章');
    await empPage.getByTestId('oa-field-docName').fill(`测试协议${stamp}`);
    await empPage.getByTestId('oa-field-copies').fill('2');
    await empPage.getByTestId('oa-field-useDate').fill(tdy.today);
    await empPage.getByTestId('oa-field-reason').fill('签署测试合同');
    expect(await empPage.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await empPage.getByTestId('oa-approval-submit').click();
    await expect(empPage.getByTestId('oa-approval-status')).toHaveText('审批中');
    const approvalId = Number(new URL(empPage.url()).pathname.split('/').pop());
    await empPage.getByTestId('oa-approval-urge').click();
    await expect(empPage.getByTestId('oa-approval-events')).toContainText('催办');

    // 2) 店主（linlan）手机 360×800 在待办里点进用章单并转交给接手人
    const mgrCtx = await browser.newContext({ viewport: { width: 360, height: 800 }, isMobile: true, hasTouch: true, userAgent: WECHAT_UA, locale: 'zh-CN', timezoneId: 'Asia/Shanghai' });
    const mgrPage = await mgrCtx.newPage();
    expect((await mgrPage.request.post('/api/auth/login', { data: { username: 'linlan', password: PASSWORD } })).status()).toBe(200);
    await mgrPage.goto(`/oa/approvals/${approvalId}`);
    await expect(mgrPage.getByTestId('oa-approval-transfer')).toBeVisible({ timeout: 20_000 });
    await mgrPage.getByTestId('oa-approval-transfer').click();
    await mgrPage.getByTestId('oa-transfer-to').selectOption(String(transId));
    await mgrPage.getByTestId('oa-transfer-confirm').click();
    await expect(mgrPage.getByTestId('oa-approval-events')).toContainText(`转交 给 接手人${stamp}`);
    await mgrCtx.close();

    // 3) 接手人同时收到 1 条审批待办系统通知 + 员工发来的 1 条单聊消息：核对「消息」Tab 合并红点 = 2（不重复计 IM 通知）与分栏切换
    const direct = await empPage.request.post('/api/oa/im/direct', { data: { staffId: transId } });
    expect(direct.status(), await direct.text()).toBe(200);
    const convId = ((await direct.json()) as { id: number }).id;
    const msg = await empPage.request.post(`/api/oa/im/conversations/${convId}/messages`, {
      data: { clientKey: crypto.randomUUID(), kind: 'text', body: `请帮忙批一下用章单${stamp}` },
    });
    expect(msg.status(), await msg.text()).toBe(201);

    const trCtx = await browser.newContext({ viewport: { width: 360, height: 800 }, isMobile: true, hasTouch: true, userAgent: WECHAT_UA, locale: 'zh-CN', timezoneId: 'Asia/Shanghai' });
    const trPage = await trCtx.newPage();
    expect((await trPage.request.post('/api/auth/login', { data: { username: transUser, password: PASSWORD } })).status()).toBe(200);
    expect((await trPage.request.post('/api/auth/change-password', { data: { currentPassword: PASSWORD, newPassword: `Mobile4b-${stamp}-2026` } })).status()).toBe(200);
    await trPage.goto('/oa/im');
    await expect(trPage.getByTestId('messages-tabbar')).toBeVisible({ timeout: 20_000 });
    await expect(trPage.getByTestId('wcp-tab-messages-badge')).toHaveText('2');
    await expect(trPage.getByTestId('messages-tab-im-badge')).toHaveText('1');
    await expect(trPage.getByTestId('messages-tab-notifications-badge')).toHaveText('1');
    expect(await trPage.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

    // 点进聊天读完消息 -> 聊天未读清零，合并红点降为 1；切到「系统通知」分栏零横向滚动
    await trPage.getByTestId(`im-conv-${convId}`).click();
    await expect(trPage.getByTestId('im-messages')).toContainText(`请帮忙批一下用章单${stamp}`);
    expect(await trPage.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await expect(trPage.getByTestId('wcp-tab-messages-badge')).toHaveText('1');
    await trPage.getByTestId('im-back').click();
    await trPage.getByTestId('messages-tab-notifications').click();
    await expect(trPage).toHaveURL(/\/oa\/notifications$/);
    await expect(trPage.getByTestId('notifications-list')).toContainText(`测试协议${stamp}`);
    expect(await trPage.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

    // 接手人通过用章单
    await trPage.goto(`/oa/approvals/${approvalId}`);
    await trPage.getByTestId('oa-approval-approve').click();
    await expect(trPage.getByTestId('oa-approval-status')).toHaveText('已通过');
    await trCtx.close();
    await empCtx.close();

    // 收尾：停用两个临时账号
    expect((await page.request.put(`/api/staff/${staffId}`, { data: { displayName: `用章员${stamp}`, position: 'front.staff', active: false } })).status()).toBe(200);
    expect((await page.request.put(`/api/staff/${transId}`, { data: { displayName: `接手人${stamp}`, position: 'hr.lead', active: false } })).status()).toBe(200);
  });

  test('第 5 批：PC 端知识库检索与发布公告，手机 360×800 知识库检索预览、公告自动已读与撤回隐藏', async ({ page, browser }) => {
    const stamp = Date.now().toString().slice(-6);
    const pdfTitle = `手机安全须知${stamp}`;
    const annTitle = `全店演练公告${stamp}`;

    // 1. PC 管理员登录：上传一份测试 PDF 到全员「培训资料」，验证 PC 跨文件夹检索
    await page.goto('/login');
    expect((await page.request.post('/api/auth/login', { data: { username: 'linlan', password: PASSWORD } })).status()).toBe(200);
    await page.goto('/admin/training');
    await expect(page.getByTestId('training-admin-folders')).toBeVisible({ timeout: 20_000 });
    const miniPdf = Buffer.from(
      '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Count 1/Kids[3 0 R]>>endobj\n3 0 obj<</Type/Page/MediaBox[0 0 200 200]/Parent 2 0 R>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n',
    );
    await page.getByTestId('training-upload-input').setInputFiles({ name: `${pdfTitle}.pdf`, mimeType: 'application/pdf', buffer: miniPdf });
    await expect(page.getByTestId('training-admin-files')).toContainText(pdfTitle, { timeout: 20_000 });

    await page.getByTestId('training-admin-search-input').fill(pdfTitle);
    await page.getByTestId('training-admin-search-submit').click();
    await expect(page.getByTestId('training-admin-search-results')).toContainText(pdfTitle, { timeout: 10_000 });

    // 2. PC 管理员到「公司公告」发布置顶全员公告
    await page.goto('/admin/announcements');
    await page.getByTestId('admin-ann-new').click();
    await page.getByTestId('admin-ann-title').fill(annTitle);
    await page.getByTestId('admin-ann-body').fill(`请在周五 15:00 参加演练（批次 ${stamp}）。`);
    await page.getByTestId('admin-ann-pinned').check();
    await page.getByTestId('admin-ann-submit').click();
    await expect(page.getByTestId('admin-ann-list')).toContainText(annTitle, { timeout: 15_000 });
    const adminList = (await (await page.request.get('/api/admin/oa/announcements')).json()) as { id: number; title: string }[];
    const annId = adminList.find((x) => x.title === annTitle)!.id;

    // 3. 手机端（360×800 微信 UA）员工登录
    const mobileCtx = await browser.newContext({
      viewport: { width: 360, height: 800 },
      isMobile: true,
      hasTouch: true,
      userAgent: WECHAT_UA,
      locale: 'zh-CN',
      timezoneId: 'Asia/Shanghai',
    });
    const mp = await mobileCtx.newPage();
    await mp.goto('/login');
    expect((await mp.request.post('/api/auth/login', { data: { username: 'xiaozhou', password: PASSWORD } })).status()).toBe(200);
    await mp.goto('/oa');
    await expect(mp.getByTestId('oa-tile-announcements-badge')).toBeVisible({ timeout: 15_000 });

    // 学堂 Tab（原来的知识库，XT01）：顶栏搜索框同时搜课程与培训资料，检索刚上传的文档并打开预览，零横向滚动
    await mp.getByTestId('wcp-tab-knowledge').click();
    await expect(mp).toHaveURL(/\/oa\/academy$/);
    // 学堂页面是按需加载的：地址先变、页面后到，等学堂首页出来再搜（不然搜的还是工作台）
    await expect(mp.getByTestId('academy-home')).toBeVisible({ timeout: 15_000 });
    await mp.getByTestId('wcp-mobile-search').fill(pdfTitle);
    await mp.getByTestId('wcp-mobile-search').press('Enter');
    await expect(mp.getByTestId('academy-search-docs')).toContainText(pdfTitle, { timeout: 15_000 });
    expect(await mp.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await mp
      .getByTestId('academy-search-docs')
      .getByRole('link', { name: new RegExp(pdfTitle) })
      .first()
      .click();
    await expect(mp).toHaveURL(/\/oa\/training\/\d+\/\d+$/);
    expect(await mp.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

    // 公告列表 -> 点进详情自动标已读，零横向滚动
    await mp.goto('/oa/announcements');
    await expect(mp.getByTestId(`ann-item-${annId}`)).toContainText(annTitle, { timeout: 15_000 });
    expect(await mp.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await mp.getByTestId(`ann-item-${annId}`).click();
    await expect(mp.getByTestId('ann-detail-title')).toHaveText(annTitle);
    await expect(mp.getByTestId('ann-read-badge')).toBeVisible({ timeout: 15_000 });
    expect(await mp.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

    // 4. PC 管理员查看已读名单包含小周，再撤回公告
    await page.reload();
    await page.getByTestId(`admin-ann-readers-${annId}`).click();
    await expect(page.getByTestId('admin-ann-readers-list')).toContainText('周小舟', { timeout: 10_000 });
    await page.keyboard.press('Escape');
    await page.getByTestId(`admin-ann-recall-${annId}`).click();
    await page.getByTestId('admin-ann-recall-reason-reason').fill('测试演练已结束');
    await page.getByTestId('admin-ann-recall-reason-confirm').click();
    await expect(page.getByTestId(`admin-ann-${annId}`)).toContainText('已撤回', { timeout: 15_000 });

    // 5. 手机端刷新公告列表，已撤回公告不再出现
    await mp.goto('/oa/announcements');
    await expect(mp.getByTestId(`ann-item-${annId}`)).toHaveCount(0);
    await mobileCtx.close();
  });

  test('第 6 批：PC 端人脸比对接入状态提示与手机 360×800 全量 /oa 页面零横向滚动回归', async ({ page, browser }) => {
    // 1. PC 管理员登录，核对「考勤设置 → 人脸审核」接入状态横幅可见
    await page.goto('/login');
    expect((await page.request.post('/api/auth/login', { data: { username: 'linlan', password: PASSWORD } })).status()).toBe(200);
    await page.goto('/admin/attendance/faces');
    await expect(page.getByTestId('att-faces')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('face-service-status')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('face-service-status')).toContainText('人脸待人工核对');

    // 2. 手机 360×800 微信 UA 员工遍历全部 /oa 页面，确认均正常渲染且零横向溢出
    const mobileCtx = await browser.newContext({
      viewport: { width: 360, height: 800 },
      isMobile: true,
      hasTouch: true,
      userAgent: WECHAT_UA,
      locale: 'zh-CN',
      timezoneId: 'Asia/Shanghai',
    });
    const mp = await mobileCtx.newPage();
    await mp.goto('/login');
    expect((await mp.request.post('/api/auth/login', { data: { username: 'xiaozhou', password: PASSWORD } })).status()).toBe(200);

    const routes: { path: string; readyTestId: string }[] = [
      { path: '/oa', readyTestId: 'oa-home' },
      { path: '/oa/punch', readyTestId: 'wcp-mobile-top' },
      { path: '/oa/schedule', readyTestId: 'my-schedule' },
      { path: '/oa/attendance', readyTestId: 'my-attendance' },
      { path: '/oa/leave', readyTestId: 'my-leave-apply' },
      { path: '/oa/approvals', readyTestId: 'oa-box-todo' },
      { path: '/oa/approvals/new', readyTestId: 'oa-approval-templates' },
      { path: '/oa/im', readyTestId: 'messages-tabbar' },
      { path: '/oa/notifications', readyTestId: 'messages-tabbar' },
      { path: '/oa/training', readyTestId: 'training-search-input' },
      { path: '/oa/academy', readyTestId: 'academy-home' },
      { path: '/oa/academy/paths', readyTestId: 'academy-paths' },
      { path: '/oa/academy/daily', readyTestId: 'academy-daily' },
      { path: '/oa/academy/me', readyTestId: 'academy-me' },
      { path: '/oa/academy/rank', readyTestId: 'academy-rank-page' },
      { path: '/oa/announcements', readyTestId: 'ann-tab-all' },
      { path: '/oa/directory', readyTestId: 'dir' },
      { path: '/oa/payslips', readyTestId: 'my-payslips' },
      { path: '/oa/face', readyTestId: 'face-status' },
      { path: '/oa/me', readyTestId: 'oa-me' },
    ];
    for (const r of routes) {
      await mp.goto(r.path);
      await expect(mp.getByTestId(r.readyTestId), `路由 ${r.path} 加载失败`).toBeVisible({ timeout: 20_000 });
      const noOverflow = await mp.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
      expect(noOverflow, `路由 ${r.path} 在 360×800 下出现横向滚动`).toBe(true);
    }
    await mobileCtx.close();
  });
});
