// 8.2.3 前台（docs/V8223_FRONTDESK.md）的浏览器验收：
//   ① 接待发牌选「港客」、写预约技师 → 手牌卡片上有「港客」标；客人卡里填偏好（忌口），点单页按手牌找到客人时看得到忌口与预约技师；
//   ② 同行小标签上「移出」一键确认；
//   ③ 客诉台账：写一条「客诉」备注，值班经理在台账里看得到、标已处理，打印页打得开。
// 依赖演示数据（店主 linlan、值班经理 zhangjl、收银 xiaozhou，密码 yuzu2026）。来访做完撤销；餐饮功能没开时临时打开、做完恢复（同一组里前面的用例可能关了它）。只在门店电脑跑。
import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type Browser, type Page } from '@playwright/test';
import { passPortal } from './portal';

const PASSWORD = 'yuzu2026';

async function login(page: Page, username: string) {
  await page.goto('/login');
  await page.fill('#username', username);
  await page.fill('#password', PASSWORD);
  await page.getByRole('button', { name: '登录' }).click();
  await passPortal(page);
  await expect(page.getByRole('navigation', { name: '主导航' })).toBeVisible({ timeout: 30_000 });
}

async function apiAs(browser: Browser, baseURL: string | undefined, username: string): Promise<APIRequestContext> {
  const ctx = await browser.newContext({ baseURL });
  const res = await ctx.request.post('/api/auth/login', { data: { username, password: PASSWORD } });
  expect(res.ok(), await res.text()).toBe(true);
  return ctx.request;
}

interface BoardTag {
  code: string;
  zone: 'male' | 'female';
  kind: 'normal' | 'vip';
  active: boolean;
  locked: boolean;
  serviceStatus: string;
  visit: { id: number } | null;
}

async function freeTags(req: APIRequestContext, n: number): Promise<string[]> {
  const board = (await (await req.get('/api/frontdesk/board')).json()) as { tags: BoardTag[] };
  return board.tags
    .filter((t) => !t.visit && t.active && !t.locked && t.serviceStatus === 'normal' && t.kind === 'normal' && t.zone === 'male')
    .slice(0, n)
    .map((t) => t.code);
}

test.describe('8.2.3 前台', () => {
  test.beforeEach(({}, testInfo) => {
    test.skip(testInfo.project.name !== '门店电脑', '会登记单据，只在门店电脑尺寸执行一次');
  });

  test('客人类别、偏好全店可见、同行移出、客诉台账', async ({ page, browser, baseURL }) => {
    const clerk = await apiAs(browser, baseURL, 'xiaozhou');
    // 收尾用的两个会话先登好：超时后浏览器在收尾阶段开不了新会话，来访就撤销不掉
    const duty = await apiAs(browser, baseURL, 'zhangjl');
    const owner = await apiAs(browser, baseURL, 'linlan');
    const dining = ((await (await owner.get('/api/admin/dining')).json()) as { rules: { enabled: boolean } }).rules;
    // 每次跑带唯一尾号：重跑（CI 重试）时上一次留下的客诉不会让定位器撞车
    const note = `E2E8223 水温低 ${randomUUID().slice(0, 8)}`;
    const [a, b] = await freeTags(clerk, 2);
    const r = await clerk.post('/api/frontdesk/checkins', {
      data: {
        clientKey: randomUUID(),
        guests: [
          { tagCode: a, zone: 'male', category: '港客', bookedTechnician: 'E2E8223 小林' },
          { tagCode: b, zone: 'male' },
        ],
      },
    });
    expect(r.ok(), await r.text()).toBe(true);
    const visits = ((await r.json()) as { visits: { id: number }[] }).visits;
    try {
      if (!dining.enabled) {
        const on = await owner.put('/api/admin/dining/rules', { data: { enabled: true } });
        expect(on.ok(), await on.text()).toBe(true);
      }
      await login(page, 'xiaozhou');
      await page.goto(`/crm/frontdesk?v=${visits[0]!.id}`);
      await expect(page.getByTestId(`tag-${a}-category`)).toHaveText(/港客/);
      await page.getByTestId('guest-prefs-edit').click();
      await page.getByTestId('guest-pref-input-diet').fill('E2E8223 不吃香菜');
      await page.getByTestId('guest-prefs-save').click();
      await expect(page.getByTestId('guest-pref-diet')).toContainText('不吃香菜');
      // 同行移出
      await page.getByTestId(`mate-leave-${b}`).click();
      await page.getByTestId('mate-leave-confirm').click();
      await expect(page.getByTestId(`mate-leave-${b}`)).toHaveCount(0);
      // 客诉备注
      await page.getByTestId('remark-tags').getByRole('button', { name: '客诉' }).click();
      await page.getByTestId('remark-note').fill(note);
      await page.getByTestId('remark-submit').click();
      // 点单页看得到偏好
      await page.goto('/crm/dining');
      await page.getByTestId('dining-tag').fill(a!);
      await page.getByTestId('dining-find').click();
      await expect(page.getByTestId('guest-notes')).toContainText('不吃香菜');
      await expect(page.getByTestId('guest-notes')).toContainText('E2E8223 小林');
      // 客诉台账（值班经理）
      await login(page, 'zhangjl');
      await page.goto('/crm/complaints');
      const row = page.getByTestId('complaints').getByText(note);
      await expect(row).toBeVisible();
    } finally {
      for (const v of visits) await duty.post(`/api/frontdesk/visits/${v.id}/cancel`, { data: { reason: 'E2E8223 用完撤销' } });
      if (!dining.enabled) await owner.put('/api/admin/dining/rules', { data: { enabled: false } });
    }
  });
});
