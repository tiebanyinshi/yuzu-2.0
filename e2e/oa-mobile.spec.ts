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
    await page.getByTestId('wcp-mobile-search').fill('');
    await expect(page.getByTestId('oa-tile-punch')).toBeVisible();

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
});
