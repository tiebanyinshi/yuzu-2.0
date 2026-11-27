// 汤崎学堂（店主 2026-11-27，docs/ACADEMY.md）的浏览器验收：
//   ① 「WCP 设置 → 学堂 → 内置课程包」：勾「直接上架」导入，17 门课都在库里；
//   ② 员工 xiaozhou（周小舟）进「WCP → 学堂」：我的必修里有「新员工入职地图」，点进去是一站一站的地图；
//      第 1 站第 1 节图文课件点「学完了」记上，课程进度不再是 0；课后测验抽 5 题，全选 A 交卷出成绩；
//   ③ 每日一练答一题，今天做了的数加 1；「证书与成长」里学分不是 0；榜单（本月学分）里有周小舟。
// 依赖新建的演示库（店主 linlan、员工 xiaozhou，密码 yuzu2026）；会写学习记录，只在门店电脑尺寸执行。
import { expect, test, type Page } from '@playwright/test';
import { passPortal } from './portal';

const PASSWORD = 'yuzu2026';

async function login(page: Page, username: string) {
  await page.goto('/login');
  await page.fill('#username', username);
  await page.fill('#password', PASSWORD);
  await page.getByRole('button', { name: '登录' }).click();
  await passPortal(page);
  await page.waitForURL((u) => !u.pathname.startsWith('/login'));
}

test.describe('汤崎学堂', () => {
  test.beforeEach(({}, testInfo) => {
    test.skip(testInfo.project.name !== '门店电脑', '会导入课程、写学习记录，只在门店电脑尺寸执行一次');
  });

  test('导入内置课程包并上架 → 员工学一节、考一次、练一题 → 学分与榜单', async ({ page, browser }) => {
    // ① 管理端导入
    await login(page, 'linlan');
    await page.goto('/admin/academy/packs');
    await expect(page.getByTestId('academy-packs')).toBeVisible();
    await page.getByTestId('academy-pack-publish').check();
    await page.getByTestId('academy-pack-import').click();
    await expect(page.getByTestId('academy-pack-result')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText('课程（17 门）')).toBeVisible();

    // ② 员工端：学一节、考一次
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: 'zh-CN', timezoneId: 'Asia/Shanghai' });
    const mp = await ctx.newPage();
    await login(mp, 'xiaozhou');
    await mp.goto('/oa');
    await mp.getByTestId('oa-tile-academy').click();
    await expect(mp.getByTestId('academy-me-card')).toBeVisible({ timeout: 15_000 });
    const required = mp.getByTestId('academy-required');
    await expect(required).toContainText('新员工入职地图');
    await required.getByRole('link', { name: /新员工入职地图/ }).click();
    await expect(mp.getByTestId('academy-path-road')).toBeVisible();
    await mp.getByTestId('academy-path-road').getByRole('link').first().click();
    await expect(mp.getByTestId('academy-course-page')).toBeVisible();
    await mp.getByTestId('academy-lessons').getByRole('link').first().click();
    await expect(mp.getByTestId('academy-article')).toBeVisible();
    // 新建的演示库里这一节还没学；同一个库上重跑时已经学过，就不再点
    if (await mp.getByTestId('academy-lesson-done').isVisible()) await mp.getByTestId('academy-lesson-done').click();
    await expect(mp.getByText('这一节已经学完')).toBeVisible({ timeout: 15_000 });
    expect(await mp.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await mp.getByRole('link', { name: '课程', exact: true }).click();
    await expect(mp.getByTestId('academy-course-progress')).not.toHaveText(/^0\//);
    await mp
      .getByTestId('academy-lessons')
      .getByRole('link', { name: /课后测验/ })
      .click();
    await mp.getByTestId('academy-quiz-begin').click();
    await expect(mp.getByTestId('academy-quiz')).toBeVisible();
    // 单选、判断是 radio，多选是 checkbox：每题点第一个选项
    for (let i = 0; i < 5; i++) await mp.getByTestId(`academy-quiz-q${i}`).locator('[role=radio],[role=checkbox]').first().click();
    await mp.getByTestId('academy-quiz-submit').click();
    await expect(mp.getByTestId('academy-quiz-result')).toContainText('答对', { timeout: 15_000 });

    // ③ 每日一练、学分与榜单
    await mp.goto('/oa/academy/daily');
    await expect(mp.getByTestId('academy-daily-card')).toBeVisible({ timeout: 15_000 });
    const before = Number((await mp.getByTestId('academy-daily-count').innerText()).split('/')[0]);
    if (await mp.getByTestId('academy-daily-reveal').isVisible()) {
      await mp.getByTestId('academy-daily-reveal').click();
      await mp.getByTestId('academy-daily-grade-3').click();
    } else {
      await mp.getByTestId('academy-daily-choices').locator('[role=radio],[role=checkbox]').first().click();
      await mp.getByTestId('academy-daily-submit').click();
    }
    await expect(mp.getByTestId('academy-daily-count')).toHaveText(new RegExp(`^${before + 1}/`), { timeout: 15_000 });
    expect(await mp.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

    await mp.goto('/oa/academy/me');
    await expect(mp.getByTestId('academy-me')).toBeVisible();
    await expect(mp.getByTestId('academy-me').getByText(/^[1-9]\d* 学分/)).toBeVisible({ timeout: 15_000 });
    await mp.goto('/oa/academy/rank');
    await expect(mp.getByTestId('academy-rank-credits')).toContainText('周小舟', { timeout: 15_000 });
    await ctx.close();
  });
});
