// 价目表录入（docs/PRICE_CATALOG.md）的浏览器验收：后台 → 价目 → 「全品类价目表」——
//   第二批：选一份合成的六张表（照《价目表 1119》的版式）→ 预览：条数对照、问题与提醒 → 导入成草稿 → 条数对照、列表、
//   按工作表 / 板块筛、搜名称与房号、只看待定价（写「待定价」不写 0 元）。
//   第三批：改价（改动记录写旧价 → 新价）、表单校验（待定价的菜不能下单）、补价、单条新增、停用、
//   切换生效（条数对不上要写原因）、再切换一份、整体回滚到上一版。
// 店主 linlan（密码 yuzu2026）。导入只替换草稿，不影响正在用的价格；可重复执行。只在门店电脑尺寸跑。
import { expect, test, type Locator, type Page } from '@playwright/test';
import { buildWorkbook, type WbSheet } from '../src/server/lib/xlsx';

type Row = (string | number | null)[];
const sheet = (name: string, rows: Row[], merges: string[] = []): WbSheet => ({ name, widths: [10], rows: rows.map((cells) => ({ cells })), merges });
const book = () =>
  buildWorkbook([
    sheet(
      '门店价格',
      [['汤崎（宝安池里）'], ['类型', '项目', '价格', '备注', '时间'], ['门票', '12H', 499, '不含餐'], [null, '24H', 899, '含3餐'], ['服务费', '服务费', 0.1, '全场消费加10%']],
      ['A3:A4'],
    ),
    sheet('娱乐价格', [['汤崎'], ['类型', '数量', '价格', '备注'], ['台球', 4, '39/2h', '加钟/19.9']]),
    sheet('房间价格', [
      ['房型', '总数', '收费参考', null, '备注'],
      ['spa房', '3间', '399/2H起开', '超时199/H\n999封顶过夜', 'S301-S303'],
    ]),
    sheet(
      '零点菜品价格',
      [
        ['2楼餐厅零点菜品'],
        ['序号', '菜品分类', '菜品名称', '售价', '单位'],
        [1, '中餐零点', '蚝皇扣鲍鱼', null, '位'],
        ['早餐自助零点菜品'],
        ['序号', '菜品分类', '菜品名称', '售价', '单位'],
        [1, '生滚粥', '生滚牛肉粥', 38, '份'],
      ],
      ['A1:E1', 'A4:E4'],
    ),
    sheet('按摩及助浴价格', [
      ['板块分类', '编号', '项目名称', '类型', '时长', '专业价', '资深价'],
      ['康疗', 1, '古法中式', '房间', '80min', 499, 599],
      ['助浴', 60, '茱莉蔻柑橘护理', '浴区', '45min', 400, '男/女'],
    ]),
    sheet('储值政策', [['储值政策'], ['同步大客部门  建议两店通用']]),
  ]);

test.describe('价目表录入 第二批：列表与搜索', () => {
  test.skip(({ viewport }) => (viewport?.width ?? 0) < 1280, '会导入草稿，只在门店电脑尺寸执行一次');

  test('导入成草稿 → 条数对照、列表、筛选与搜索', async ({ page }) => {
    await page.goto('/login');
    await page.fill('#username', 'linlan');
    await page.fill('#password', 'yuzu2026');
    await page.getByRole('button', { name: '登录' }).click();
    await expect(page.getByRole('navigation', { name: /主导航|后台/ }).first()).toBeVisible({ timeout: 30_000 });
    await page.goto('/admin/catalog/full');
    const root = page.getByTestId('price-catalog');
    await expect(root.getByTestId('price-catalog-import')).toBeVisible();
    await expect(root.getByTestId('price-catalog-template')).toHaveAttribute('download', '价目表导入模板.xlsx');

    await root.getByTestId('price-catalog-file').setInputFiles({
      name: '汤崎宝安全品类价目表1119.xlsx',
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      buffer: book(),
    });
    await root.getByTestId('price-catalog-preview').click();
    const result = root.getByTestId('price-catalog-preview-result');
    await expect(result).toContainText('没有问题：8 项（表格应有 224 项）');
    await expect(result.getByTestId('price-catalog-issues')).toContainText('「蚝皇扣鲍鱼」暂无售价');
    await expect(result.getByTestId('price-count-massage')).toContainText('康疗 1/4');
    await root.getByTestId('price-catalog-apply').click();
    await expect(root.getByTestId('price-catalog-done')).toContainText('已存成草稿');

    // 条数对照与列表
    await expect(root.getByTestId('price-catalog-meta')).toContainText('草稿不参与开单');
    await expect(root.getByTestId('price-count-total')).toContainText('8');
    await expect(root.getByTestId('price-catalog-shown')).toContainText('共 9 项');
    // 只看按摩、康疗板块
    await root.getByRole('radio', { name: '按摩及助浴' }).click();
    await root.getByTestId('price-catalog-section').selectOption('康疗');
    await expect(root.getByTestId('price-entry')).toHaveCount(1);
    await expect(root.getByTestId('price-entry').first()).toContainText('专业 ¥499.00 / 资深 ¥599.00');
    // 搜房号
    await root.getByRole('radio', { name: '全部', exact: true }).click();
    await root.getByTestId('price-catalog-search').fill('S302');
    await expect(root.getByTestId('price-entry')).toHaveCount(1);
    await expect(root.getByTestId('price-entry').first()).toContainText('spa房');
    // 只看待定价：写「待定价」、标「不可下单」，不写 0 元
    await root.getByTestId('price-catalog-search').fill('');
    await root.getByTestId('price-catalog-only').selectOption('none');
    const none = root.getByTestId('price-entry');
    await expect(none).toHaveCount(1);
    await expect(none.first()).toContainText('待定价');
    await expect(none.first()).toContainText('不可下单');
    await expect(none.first()).not.toContainText('¥0');
  });
});

async function login(page: Page) {
  await page.goto('/login');
  await page.fill('#username', 'linlan');
  await page.fill('#password', 'yuzu2026');
  await page.getByRole('button', { name: '登录' }).click();
  await expect(page.getByRole('navigation', { name: /主导航|后台/ }).first()).toBeVisible({ timeout: 30_000 });
}

/** 导入合成的那份成草稿（页面随即看草稿） */
async function importDraft(root: Locator) {
  await root.getByTestId('price-catalog-file').setInputFiles({ name: '演练价目表.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: book() });
  await root.getByTestId('price-catalog-preview').click();
  await expect(root.getByTestId('price-catalog-apply')).toBeEnabled();
  await root.getByTestId('price-catalog-apply').click();
  await expect(root.getByTestId('price-catalog-done')).toContainText('已存成草稿');
  // 导入以后页面直接看草稿
  await expect(root.getByTestId('price-catalog-activate')).toBeVisible();
}

test.describe('价目表录入 第三批：编辑与校验', () => {
  test.skip(({ viewport }) => (viewport?.width ?? 0) < 1280, '会改价目表，只在门店电脑尺寸执行一次');

  test('改价留痕、校验、补价、新增、停用、切换生效、整体回滚', async ({ page }) => {
    await login(page);
    await page.goto('/admin/catalog/full');
    const root = page.getByTestId('price-catalog');
    await importDraft(root);
    const row = (name: string) => root.getByTestId('price-entry').filter({ hasText: name });
    const dialog = page.getByRole('dialog');

    // 改价：专业价 499 → 529；改动记录写旧价 → 新价
    await row('古法中式').getByTestId('price-entry-edit').click();
    await dialog.getByTestId('price-entry-price').fill('529');
    await dialog.getByTestId('price-entry-reason').fill('11 月调价');
    await dialog.getByTestId('price-entry-save').click();
    await expect(root.getByTestId('price-catalog-entry-notice')).toContainText('已保存「古法中式」');
    await expect(row('古法中式')).toContainText('专业 ¥529.00 / 资深 ¥599.00');
    const change = root.getByTestId('price-change').first();
    await expect(change).toContainText('古法中式');
    await expect(change).toContainText('专业 ¥499.00 / 资深 ¥599.00');
    await expect(change).toContainText('专业 ¥529.00 / 资深 ¥599.00');
    await expect(change).toContainText('11 月调价');

    // 校验：待定价的菜勾「可以下单」不能保存；补上售价再启用
    await row('蚝皇扣鲍鱼').getByTestId('price-entry-edit').click();
    await dialog.getByTestId('price-entry-orderable').check();
    await expect(dialog.getByTestId('price-entry-problems')).toContainText('待定价的菜不能下单');
    await expect(dialog.getByTestId('price-entry-save')).toBeDisabled();
    await dialog.getByRole('radio', { name: '单价' }).click();
    await dialog.getByTestId('price-entry-price').fill('0');
    await expect(dialog.getByTestId('price-entry-problems')).toContainText('价格要大于 0');
    await dialog.getByTestId('price-entry-price').fill('88');
    await expect(dialog.getByTestId('price-entry-problems')).toHaveCount(0);
    await dialog.getByTestId('price-entry-save').click();
    await expect(row('蚝皇扣鲍鱼')).toContainText('¥88.00');
    await expect(row('蚝皇扣鲍鱼')).not.toContainText('不可下单');

    // 单条新增（按摩及助浴，康疗板块）
    await root.getByTestId('price-catalog-add').click();
    await dialog.getByTestId('price-entry-sheet').selectOption('massage');
    await dialog.getByTestId('price-entry-name').fill('肩颈放松');
    await dialog.getByTestId('price-entry-price').fill('199');
    await dialog.getByTestId('price-entry-save').click();
    await expect(root.getByTestId('price-catalog-entry-notice')).toContainText('已新增「肩颈放松」');
    await expect(row('肩颈放松')).toContainText('¥199.00');

    // 停用：写原因；停用不删除，标「已停用」
    await row('肩颈放松').getByTestId('price-entry-toggle').click();
    await page.getByTestId('price-entry-off-reason').fill('暂不做');
    await page.getByTestId('price-entry-off-confirm').click();
    await expect(row('肩颈放松')).toContainText('已停用');

    // 切换生效：合成的表只有几项，条数对不上，要写原因
    await root.getByTestId('price-catalog-activate').click();
    await expect(page.getByTestId('price-catalog-mismatches')).toContainText('按摩及助浴价格');
    await page.getByTestId('price-catalog-activate-reason').fill('演练用的合成表');
    await page.getByTestId('price-catalog-activate-confirm').click();
    await expect(root.getByTestId('price-catalog-meta')).toContainText('切换生效');
    await expect(root.getByTestId('price-catalog-activate')).toHaveCount(0);

    // 再导一份、切换：刚才那份成了上一版；整体回滚回到它（改过的价还在）
    await importDraft(root);
    await root.getByTestId('price-catalog-activate').click();
    await page.getByTestId('price-catalog-activate-reason').fill('演练第二份');
    await page.getByTestId('price-catalog-activate-confirm').click();
    await expect(root.getByTestId('price-catalog-rollback')).toBeVisible();
    await expect(row('古法中式')).toContainText('专业 ¥499.00 / 资深 ¥599.00');
    await root.getByTestId('price-catalog-rollback').click();
    await page.getByTestId('price-catalog-rollback-reason').fill('演练回滚');
    await page.getByTestId('price-catalog-rollback-confirm').click();
    await expect(row('古法中式')).toContainText('专业 ¥529.00 / 资深 ¥599.00');
    await expect(root.getByTestId('price-catalog-rollback')).toBeVisible();
  });
});
