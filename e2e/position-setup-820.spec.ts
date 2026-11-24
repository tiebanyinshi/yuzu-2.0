// 回测整改 P06（docs/YUZU_REQ_V820.md 第 7 节，回测 5-1）：后台「岗位权限 → 设立岗位」——选岗位带出这个岗位的建议权限；
// 改了没保存换岗位先问「是否放弃当前修改」；按模块分组、本组全选、反选；与建议不同的项标出来，「恢复建议权限」一键回去；
// 保存后再进来照样回显；两个岗位的勾选互不串台。依赖演示数据（店主 linlan，密码 yuzu2026）。最后恢复建议权限并保存，可重复执行；只在门店电脑跑。
import { expect, test, type Page } from '@playwright/test';
import { passPortal } from './portal';

async function login(page: Page) {
  await page.goto('/login');
  await page.fill('#username', 'linlan');
  await page.fill('#password', 'yuzu2026');
  await page.getByRole('button', { name: '登录' }).click();
  await passPortal(page);
  await expect(page.getByRole('navigation', { name: /主导航|后台/ }).first()).toBeVisible({ timeout: 30_000 });
}

test.describe('回测整改 设立岗位：选岗位联动建议权限', () => {
  test.skip(({ viewport }) => (viewport?.width ?? 0) < 1280, '只在门店电脑尺寸跑');

  test('换岗位带出建议权限、先问放弃修改、标出与建议不同、恢复建议权限、保存后回显、不串台', async ({ page }) => {
    await login(page);
    await page.goto('/admin/permissions');
    const select = page.getByTestId('position-permissions-select');
    // 先把两个岗位都恢复成建议权限（上一次没跑完留下的也清掉）
    for (const pos of ['kangmei.staff', 'finance.lead']) {
      await select.selectOption(pos);
      const restore = page.getByTestId('position-permissions-restore');
      if (await restore.isEnabled()) {
        await restore.click();
        await page.getByTestId('position-permissions-save').click();
        await expect(page.getByText('的权限已保存').first()).toBeVisible();
      }
    }

    // 康美部员工：建议里有水吧点单、没有费用审批
    await select.selectOption('kangmei.staff');
    const water = page.getByTestId('pos-perm-kangmei.staff-dining.orderWater');
    await expect(water).toBeChecked();
    await expect(page.getByTestId('pos-perm-kangmei.staff-off')).toHaveText('0');
    await water.click();
    await expect(water).not.toBeChecked();
    await expect(page.getByTestId('pos-perm-kangmei.staff-off')).toHaveText('1');
    await expect(page.getByTestId('position-permissions-unsaved')).toContainText('1');

    // 换岗位：先问；继续改留在原岗位，勾选不变
    await select.selectOption('finance.lead');
    const ask = page.getByRole('dialog', { name: '是否放弃当前修改？' });
    await expect(ask).toBeVisible();
    await ask.getByRole('button', { name: '继续改' }).click();
    await expect(select).toHaveValue('kangmei.staff');
    await expect(water).not.toBeChecked();

    // 保存，换走再回来，照样回显
    await page.getByTestId('position-permissions-save').click();
    await expect(page.getByText('「康美部员工」的权限已保存')).toBeVisible();
    await select.selectOption('finance.lead');
    await expect(ask).toHaveCount(0);
    // 财务部负责人按自己的建议，不带康美部的勾选
    await expect(page.getByTestId('pos-perm-finance.lead-expense.approve')).toBeChecked();
    await expect(page.getByTestId('pos-perm-finance.lead-off')).toHaveText('0');
    await page.reload();
    await select.selectOption('kangmei.staff');
    await expect(page.getByTestId('pos-perm-kangmei.staff-dining.orderWater')).not.toBeChecked();
    await expect(page.getByTestId('pos-perm-kangmei.staff-dining.orderWater').locator('xpath=ancestor::label')).toHaveAttribute('data-off', 'true');

    // 反选再放弃：回到保存的
    await page.getByTestId('pos-perm-kangmei.staff-invert').click();
    await select.selectOption('finance.lead');
    await ask.getByTestId('position-permissions-discard').click();
    await expect(select).toHaveValue('finance.lead');
    await select.selectOption('kangmei.staff');
    await expect(page.getByTestId('pos-perm-kangmei.staff-off')).toHaveText('1');

    // 恢复建议权限并保存，回到原样
    await page.getByTestId('position-permissions-restore').click();
    await expect(page.getByTestId('pos-perm-kangmei.staff-off')).toHaveText('0');
    await page.getByTestId('position-permissions-save').click();
    await expect(page.getByText('「康美部员工」的权限已保存')).toBeVisible();
    await expect(page.getByTestId('position-permissions-restore')).toBeDisabled();
  });

  test('添加员工时逐项微调过，再换岗位先问是否放弃；放弃后按新岗位的建议权限', async ({ page }) => {
    await login(page);
    await page.goto('/admin/staff');
    await page.getByRole('button', { name: '添加员工', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '添加员工' });
    await dialog.getByTestId('staff-org-dept').selectOption('kangmei');
    await expect(dialog.getByTestId('staff-position-template')).toContainText('康美部员工');
    await dialog.getByTestId('staff-adjust-toggle').click();
    await dialog.getByRole('checkbox', { name: '查看历史营业日' }).click();
    await expect(dialog.getByTestId('staff-adjust-toggle')).toHaveText('收起');
    // 换成负责人：先问
    await dialog.getByRole('radio', { name: '负责人（高级管理员）' }).click();
    await expect(dialog.getByText('是否放弃当前修改？')).toBeVisible();
    await dialog.getByRole('button', { name: '继续改' }).click();
    await expect(dialog.getByTestId('staff-position-template')).toContainText('康美部员工');
    await dialog.getByRole('radio', { name: '负责人（高级管理员）' }).click();
    await dialog.getByTestId('staff-switch-discard').click();
    await expect(dialog.getByTestId('staff-position-template')).toContainText('康美部负责人');
    await expect(dialog.getByText('是否放弃当前修改？')).toHaveCount(0);
    await dialog.getByRole('button', { name: '取消' }).click();
  });
});
