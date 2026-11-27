// 8.1.9 ERP 供应链（docs/ERP_V819.md）的浏览器验收：
//   ① 备用金申用（8.1.42 起零采备用金并进备用金，docs/V8142_PETTY.md）：店主给部门打备用金 → 采购经办在这个部门的备用金上申用、
//      提交报销（未补单）→ 店主在「费用报销」按这笔申用登记报销（钱从备用金来）→ 临时负责人审批（8.2.12 B1）→ 报销单确认后这笔是「已报销」；
//   ② 库管入库：物资经办在库存页点「库管入库」，不选采购单，直接选物料、填单价，确认入库，单据上标「库管入库」；
//   （8.1.9 的③「导入入库台账」8.1.20 起换成出入库台账，用例在 e2e/erp-8120.spec.ts。）
// 依赖演示数据（seed-demo 与 seed-inventory-demo：店主 linlan、采购 zhouyi、物资 lixiao，密码 yuzu2026）。会登记单据，只在门店电脑尺寸执行；
// 每次用新的说明与金额，不改演示数据里已有的档案。
import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { deputyApproveClaim, makeDeputy } from './deputy';
import { passPortal } from './portal';

const PASSWORD = 'yuzu2026';

async function login(page: Page, username: string) {
  await page.goto('/login');
  await page.fill('#username', username);
  await page.fill('#password', PASSWORD);
  await page.getByRole('button', { name: '登录' }).click();
  await passPortal(page);
  await expect(page.getByRole('navigation', { name: /主导航|ERP 导航/ })).toBeVisible({ timeout: 30_000 });
}

test.describe('8.1.9 ERP 供应链', () => {
  test.skip(({ viewport }) => (viewport?.width ?? 0) < 1280, '会登记单据的流程只在门店电脑尺寸执行一次');

  test('备用金申用（8.1.42 起零采备用金并进备用金）：申用 → 提交报销 → 财务按申用登记报销（钱从备用金来）→ 负责人审批 → 不再占用', async ({ browser, playwright, baseURL }) => {
    test.setTimeout(150_000);
    const tag = String(Date.now()).slice(-6);
    // 店主：给第一个部门打一笔备用金（之前没跑完的申用也放得下）
    const bossCtx = await browser.newContext();
    const boss = await bossCtx.newPage();
    await login(boss, 'linlan');
    const me = (await (await boss.request.get('/api/auth/me')).json()) as { staff: { id: number }; calendarToday: string };
    const depts = (await (await boss.request.get('/api/inventory/departments')).json()) as { id: number; name: string; active: boolean }[];
    const dept = depts.find((d) => d.active)!;
    const adv = await boss.request.post('/api/erp/petty/advances', {
      data: { clientKey: randomUUID(), departmentId: dept.id, handlerId: me.staff.id, advanceDate: me.calendarToday, amountCents: 500_000, method: 'cash', evidence: `E2E 备用金 ${tag}` },
    });
    expect(adv.ok()).toBe(true);
    // ERP 设置里不再有零采备用金的总额
    await boss.goto('/erp/settings/expenses');
    await expect(boss.getByTestId('erp-settings-petty')).toBeVisible();
    await expect(boss.getByText('零采备用金')).toHaveCount(0);

    // 采购经办：在这个部门的备用金上申用（旧地址 /erp/pool 转到申用页）
    const buyerCtx = await browser.newContext();
    const buyer = await buyerCtx.newPage();
    await login(buyer, 'zhouyi');
    await buyer.goto('/erp/pool');
    await expect(buyer).toHaveURL(/\/erp\/petty\/uses/);
    await buyer.goto(`/erp/petty/uses?department=${dept.id}`);
    await expect(buyer.getByTestId('pu-summary')).toBeVisible();
    await expect(buyer.getByTestId('pu-balance')).toContainText(dept.name);
    await buyer.getByTestId('pu-new').click();
    const dialog = buyer.getByTestId('pu-use-dialog');
    await dialog.getByLabel('用途说明').fill(`E2E 前台补货 ${tag}`);
    await dialog.getByLabel('采购内容').fill(`网购：一次性拖鞋 2 箱（${tag}）`);
    await buyer.getByTestId('pu-amount').fill('123.45');
    await buyer.getByTestId('pu-use-save').click();
    await expect(buyer.getByText('已申用')).toBeVisible();
    const row = buyer
      .getByTestId('pu-table')
      .locator('tr[data-testid^="pu-use-"]')
      .filter({ hasText: `E2E 前台补货 ${tag}` });
    await expect(row).toContainText('待报销');
    await expect(row).toContainText('¥123.45');
    const useId = Number((await row.getAttribute('data-testid'))!.replace('pu-use-', ''));
    expect(useId).toBeGreaterThan(0);

    // 提交报销：未补单
    // 宽屏是表格（窄屏的卡片也在页面里、藏着）：按表格找
    const table = buyer.getByTestId('pu-table');
    await table.getByTestId(`pu-submit-${useId}`).click();
    await buyer.getByTestId('pu-backfill-pending').check();
    await buyer.getByTestId('pu-submit-save').click();
    await expect(row).toContainText('已提交报销');
    await expect(row).toContainText('等财务登记报销单');

    // 店主（有登记报销的权限）：钱从「备用金」来（只有备用金、公司直付两项），选部门与打款，勾这笔申用
    await boss.goto('/erp/expenses/new');
    await expect(boss.getByTestId('claim-form')).toBeVisible();
    await expect(boss.getByRole('radio', { name: '零采备用金' })).toHaveCount(0);
    await boss.getByTestId('ex-dept').selectOption(String(dept.id));
    await boss.getByRole('radio', { name: '备用金' }).click();
    await boss.getByTestId('ex-advance').selectOption({ index: 1 });
    await boss.getByTestId(`ex-petty-use-${useId}`).check();
    await expect(boss.getByTestId('ex-petty-uses')).toContainText('申用共 ¥123.45');
    await boss.getByTestId('ex-purpose').selectOption({ index: 1 });
    await boss.getByTestId('ex-invoice').selectOption({ label: '无票' });
    await boss.getByTestId('ex-channel').selectOption('self');
    await boss.getByTestId('ex-channel-note').fill('网购平台');
    await boss.getByTestId('line-name-0').fill('一次性拖鞋');
    await boss.getByTestId('line-cat-0').selectOption('low_value');
    await boss.getByTestId('line-unit-0').fill('箱');
    await boss.getByTestId('line-amount-0').fill('120');
    await boss.getByTestId('claim-submit').click();
    await expect(boss).toHaveURL(/\/erp\/expenses\?claim=\d+/);
    const claimSheet = boss.getByTestId('claim-sheet');
    // 8.2.12（B1）起报销不自动通过：登记后等别人审批，临时负责人审完才确认
    await expect(claimSheet).toContainText('待确认');
    const claimId = Number(new URL(boss.url()).searchParams.get('claim'));
    expect((await deputyApproveClaim(await makeDeputy(boss, playwright, baseURL), claimId)).status).toBe('confirmed');
    await boss.reload();
    await expect(boss.getByTestId('claim-sheet')).toContainText('已确认');
    await expect(boss.getByTestId('claim-petty-uses')).toContainText('¥123.45');

    // 采购经办：这笔已报销，挂着那张报销单
    await buyer.reload();
    const after = buyer.getByTestId('pu-table').getByTestId(`pu-use-${useId}`);
    await expect(after).toContainText('已报销');
    await expect(after).toContainText('已确认');
    await bossCtx.close();
    await buyerCtx.close();
  });

  test('库管入库：不选采购单，直接选物料、填单价，确认入库', async ({ page }) => {
    await login(page, 'lixiao');
    await page.goto('/inventory');
    await page.getByTestId('inv-direct-new').click();
    await expect(page).toHaveURL(/\/inventory\/direct\/new/);
    await expect(page.getByRole('heading', { name: /库管入库/ })).toBeVisible();
    await expect(page.getByLabel('采购单')).toHaveCount(0);
    await page.locator('#supplier').selectOption({ index: 1 });
    await page.getByLabel('添加物料').fill('抽纸');
    await page.keyboard.press('Enter');
    await page.keyboard.type('3');
    await page.getByLabel(/^单价（元\//).fill('12.5');
    await page.getByRole('button', { name: /确认收货/ }).click();
    await expect(page.getByRole('heading', { name: '库管入库已生效' })).toBeVisible();
    await page.getByRole('button', { name: '查看单据' }).click();
    await expect(page).toHaveURL(/\/inventory\/docs\?doc=\d+/);
    const docId = Number(new URL(page.url()).searchParams.get('doc'));
    const doc = (await (await page.request.get(`/api/inventory/docs/${docId}`)).json()) as { status: string; direct: boolean; noPo: boolean };
    expect(doc).toMatchObject({ status: 'confirmed', direct: true, noPo: true });
    await expect(page.getByText('库管入库').first()).toBeVisible();
  });
});
