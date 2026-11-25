// 员工培训（店主 2026-11-25，docs/TRAINING.md）的浏览器验收：
//   ① 后台「员工培训」：「培训资料」文件夹里上传一份 PDF、一份 Excel（分块上传，进度走到「已上传」）；
//   ② 「办公 → 员工培训」：看到「培训资料」，点进去两份都是「未看」；打开 PDF 页面里画出第 1 页，打开 Excel 页面里显示成表格；回来标「已看」；
//   ③ 后台点开这份 PDF：「看过」里有刚才这位。
// 依赖演示数据（店主 linlan，密码 yuzu2026）。每次传的文件标题带随机后缀，做完下架；只在门店电脑尺寸执行。
import { expect, test, type Page } from '@playwright/test';
import { buildXlsx } from '../src/server/lib/xlsx';

const PASSWORD = 'yuzu2026';

async function login(page: Page, username: string) {
  await page.goto('/login');
  await page.fill('#username', username);
  await page.fill('#password', PASSWORD);
  await page.getByRole('button', { name: '登录' }).click();
  await expect(page.getByRole('navigation', { name: '主导航' })).toBeVisible({ timeout: 30_000 });
}

/** 一页的最小 PDF（pdf.js 能画） */
function tinyPdf(text: string): Buffer {
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    '',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  const stream = `BT /F1 18 Tf 20 100 Td (${text}) Tj ET`;
  objs[3] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

test.describe('员工培训', () => {
  test.beforeEach(({}, testInfo) => {
    test.skip(testInfo.project.name !== '门店电脑', '会上传文件，只在门店电脑尺寸执行一次');
  });

  test('后台上传 PDF 与 Excel → 办公里看（PDF 画出来、Excel 成表格、标已看）→ 后台看到谁看过', async ({ page }) => {
    await login(page, 'linlan');
    const tag = String(Date.now()).slice(-6);
    const pdfName = `安全手册${tag}.pdf`;
    const xlsxName = `应知应会${tag}.xlsx`;

    // ① 上传
    await page.goto('/admin/training');
    const folders = page.getByTestId('training-admin-folders');
    await folders.getByText('培训资料', { exact: true }).click();
    await page.getByTestId('training-upload-input').setInputFiles([
      { name: pdfName, mimeType: 'application/pdf', buffer: tinyPdf('Safety first') },
      {
        name: xlsxName,
        mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        buffer: buildXlsx({ name: '前厅', columns: [{ header: '区域' }, { header: '要点' }], rows: [['接待台', '发牌与价目介绍']] }),
      },
    ]);
    const uploads = page.getByTestId('training-uploads');
    await expect(uploads.getByText('已上传')).toHaveCount(2, { timeout: 30_000 });
    const files = page.getByTestId('training-admin-files');
    await expect(files.getByText(`安全手册${tag}`, { exact: true })).toBeVisible();
    await expect(files.getByText(`应知应会${tag}`, { exact: true })).toBeVisible();

    // ② 办公里看
    await page.goto('/oa');
    await page.getByTestId('oa-tile-training').click();
    await page.getByTestId('training-folders').getByText('培训资料', { exact: true }).click();
    const pdfRow = page
      .getByTestId('training-files')
      .getByRole('link')
      .filter({ hasText: `安全手册${tag}` });
    await expect(pdfRow.getByText('未看')).toBeVisible();
    await pdfRow.click();
    await expect(page.getByTestId('training-pdf')).toHaveAttribute('data-pages', '1');
    await expect(page.getByTestId('training-pdf-page-1')).toHaveAttribute('data-drawn', 'true', { timeout: 15_000 });
    await page.getByText('返回文件夹').click();
    await expect(pdfRow.getByText('已看')).toBeVisible();
    await page
      .getByTestId('training-files')
      .getByRole('link')
      .filter({ hasText: `应知应会${tag}` })
      .click();
    const sheet = page.getByTestId('training-sheet');
    await expect(sheet.getByText('发牌与价目介绍')).toBeVisible();

    // ③ 后台看谁看过，做完下架
    await page.goto('/admin/training');
    await folders.getByText('培训资料', { exact: true }).click();
    for (const title of [`安全手册${tag}`, `应知应会${tag}`]) {
      await files.getByText(title, { exact: true }).click();
      const dialog = page.getByRole('dialog');
      if (title.startsWith('安全')) {
        await dialog
          .getByRole('radio', { name: /看过 1/ })
          .or(dialog.getByRole('button', { name: /看过 1/ }))
          .first()
          .click();
        await expect(dialog.getByTestId('training-viewers').getByText('林岚').or(dialog.getByTestId('training-viewers').locator('tbody tr')).first()).toBeVisible();
        await dialog
          .getByRole('radio', { name: '信息' })
          .or(dialog.getByRole('button', { name: '信息' }))
          .first()
          .click();
      }
      await dialog
        .getByRole('radio', { name: '下架' })
        .or(dialog.getByRole('button', { name: '下架' }))
        .first()
        .click();
      await dialog.getByTestId('training-file-save').click();
      await expect(page.getByText('已保存')).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(dialog).toHaveCount(0);
    }
  });
});
