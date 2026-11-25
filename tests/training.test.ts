// 员工培训第一期（店主 2026-11-25，docs/TRAINING.md、PENDING_DECISIONS PC33）：文件夹、分块上传、版本、谁能看、读内容（Range）、谁看过。

import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TRAINING_CHUNK_BYTES, type TrainingFile, type TrainingFileDetail, type TrainingFolder, type TrainingFolderList } from '../src/shared/training';
import { buildXlsx } from '../src/server/lib/xlsx';
import { api, setup, type TestContext } from './helpers';

let ctx: TestContext;
beforeAll(async () => {
  ctx = await setup();
  // 店员定在前厅部员工（看得到「培训资料」与前厅部的文件夹）
  await ctx.sql`UPDATE staff SET position = 'front.staff', needs_position = false WHERE id = ${ctx.clerkId}`;
});
afterAll(async () => ctx.close());

const PDF = (n: number) => {
  const b = Buffer.alloc(n, 0x41);
  b.write('%PDF-1.4\n', 0, 'latin1');
  return b;
};

/** 整套上传：开始 → 分块 → 完成 */
async function upload(bytes: Buffer, fileName: string, mime: string, target: { folderId?: number; fileId?: number; title?: string }, cookie = ctx.owner) {
  const clientKey = randomUUID();
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const start = await api(ctx.app, cookie, 'POST', '/api/admin/training/uploads', { clientKey, fileName, mime, sizeBytes: bytes.length });
  if (start.status !== 200) return { start, done: start };
  const { uploadId, chunkCount } = start.body;
  for (let seq = 0; seq < chunkCount; seq++) {
    const part = bytes.subarray(seq * TRAINING_CHUNK_BYTES, (seq + 1) * TRAINING_CHUNK_BYTES);
    const r = await api(ctx.app, cookie, 'PUT', `/api/admin/training/uploads/${uploadId}/chunks/${seq}`, { data: part.toString('base64') });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
  }
  const done = await api(ctx.app, cookie, 'POST', `/api/admin/training/uploads/${uploadId}/complete`, {
    folderId: target.folderId ?? null,
    fileId: target.fileId ?? null,
    title: target.title ?? '',
  });
  return { start, done, uploadId, clientKey, sha256 };
}

const folders = async (cookie = ctx.owner) => (await api(ctx.app, cookie, 'GET', '/api/training/folders')).body as TrainingFolderList;
const folderOf = async (pred: (f: TrainingFolder) => boolean) => (await folders()).folders.find(pred)!;

describe('员工培训', () => {
  it('迁移建好「培训资料」与现有 15 个部门各一个文件夹；新建、改名、停用；「培训资料」不能停用；店员不能管理', async () => {
    const list = await folders();
    expect(list.canManage).toBe(true);
    expect(list.folders[0]).toMatchObject({ name: '培训资料', kind: 'public' });
    expect(list.folders.filter((f) => f.kind === 'department' && f.departmentKey)).toHaveLength(15);
    const made = await api(ctx.app, ctx.owner, 'POST', '/api/admin/training/folders', { name: '安保部' });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    expect(made.body).toMatchObject({ name: '安保部', kind: 'department', departmentKey: null });
    expect((await api(ctx.app, ctx.owner, 'POST', '/api/admin/training/folders', { name: '安保部' })).body.error.code).toBe('TRAINING_FOLDER_TAKEN');
    expect((await api(ctx.app, ctx.owner, 'POST', '/api/admin/training/folders', { name: '前厅二', departmentKey: 'front' })).body.error.code).toBe('TRAINING_FOLDER_TAKEN');
    const pub = list.folders[0]!;
    expect((await api(ctx.app, ctx.owner, 'PUT', `/api/admin/training/folders/${pub.id}`, { name: pub.name, sort: 0, active: false, version: pub.version })).body.error.code).toBe(
      'TRAINING_FOLDER_PUBLIC',
    );
    const renamed = await api(ctx.app, ctx.owner, 'PUT', `/api/admin/training/folders/${made.body.id}`, { name: '安保', sort: 200, active: true, version: made.body.version });
    expect(renamed.body).toMatchObject({ name: '安保', version: made.body.version + 1 });
    // 版本号对不上拒绝
    expect((await api(ctx.app, ctx.owner, 'PUT', `/api/admin/training/folders/${made.body.id}`, { name: 'x', sort: 1, active: true, version: made.body.version })).body.error.code).toBe(
      'TRAINING_FOLDER_CHANGED',
    );
    expect((await api(ctx.app, ctx.clerk, 'POST', '/api/admin/training/folders', { name: '随便' })).status).toBe(403);
  });

  it('分块上传：多块的 PDF 传完核对摘要登记成文件；同一编号重提返回原来那份；同样内容再传不用传块；扩展名与内容对不上拒绝', async () => {
    const pub = await folderOf((f) => f.kind === 'public');
    const bytes = PDF(TRAINING_CHUNK_BYTES + 1234);
    const r = await upload(bytes, '员工手册.pdf', 'application/pdf', { folderId: pub.id });
    expect(r.start.body.chunkCount).toBe(2);
    expect(r.done.status, JSON.stringify(r.done.body)).toBe(200);
    const again = await api(ctx.app, ctx.owner, 'POST', `/api/admin/training/uploads/${r.uploadId}/complete`, { folderId: pub.id, fileId: null });
    expect(again.body).toEqual(r.done.body);
    const files = (await api(ctx.app, ctx.owner, 'GET', `/api/training/folders/${pub.id}/files`)).body as TrainingFile[];
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({ title: '员工手册', viewKind: 'pdf', current: { versionNo: 1, fileName: '员工手册.pdf', sizeBytes: bytes.length } });
    // 同一编号重新开始：返回原来那一次，已传的块都在
    const restart = await api(ctx.app, ctx.owner, 'POST', '/api/admin/training/uploads', { clientKey: r.clientKey, fileName: '员工手册.pdf', mime: 'application/pdf', sizeBytes: bytes.length });
    expect(restart.body).toMatchObject({ uploadId: r.uploadId, status: 'done' });
    // 同样内容再传一份：内容只存一份
    const dup = await upload(bytes, '手册副本.pdf', 'application/pdf', { folderId: pub.id });
    expect(dup.done.status).toBe(200);
    const [blobs] = await ctx.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM training_blobs`;
    expect(blobs!.n).toBe(1);
    // 扩展名与类型对不上；内容不是 PDF
    expect((await upload(PDF(100), 'a.pptx', 'application/pdf', { folderId: pub.id })).start.status).toBe(400);
    const fake = await upload(Buffer.from('not a pdf at all'), 'b.pdf', 'application/pdf', { folderId: pub.id });
    expect(fake.done.body.error.code).toBe('TRAINING_UPLOAD_FORMAT');
    // 块没传完不能完成
    const clientKey = randomUUID();
    const big = PDF(TRAINING_CHUNK_BYTES + 10);
    const s = await api(ctx.app, ctx.owner, 'POST', '/api/admin/training/uploads', { clientKey, fileName: 'c.pdf', mime: 'application/pdf', sizeBytes: big.length });
    // 传了第 2 块：重新开始时告诉页面哪些块已经在了
    await api(ctx.app, ctx.owner, 'PUT', `/api/admin/training/uploads/${s.body.uploadId}/chunks/1`, { data: big.subarray(TRAINING_CHUNK_BYTES).toString('base64') });
    expect((await api(ctx.app, ctx.owner, 'GET', `/api/admin/training/uploads/${s.body.uploadId}`)).body.received).toEqual([1]);
    expect((await api(ctx.app, ctx.owner, 'POST', `/api/admin/training/uploads/${s.body.uploadId}/complete`, { folderId: pub.id })).body.error.code).toBe('TRAINING_UPLOAD_INCOMPLETE');
    // 块大小不对拒绝
    expect((await api(ctx.app, ctx.owner, 'PUT', `/api/admin/training/uploads/${s.body.uploadId}/chunks/0`, { data: Buffer.from('xx').toString('base64') })).status).toBe(400);
  });

  it('换新版本只追加；读内容支持 Range；店员看得到「培训资料」与前厅部，看不到男宾部；看过记一次，后台看得到谁看过', async () => {
    const pub = await folderOf((f) => f.kind === 'public');
    const front = await folderOf((f) => f.departmentKey === 'front');
    const male = await folderOf((f) => f.departmentKey === 'male');
    const [file] = (await api(ctx.app, ctx.owner, 'GET', `/api/training/folders/${pub.id}/files`)).body as TrainingFile[];
    const v2bytes = PDF(5000);
    const v2 = await upload(v2bytes, '员工手册-2026.pdf', 'application/pdf', { fileId: file!.id });
    expect(v2.done.status, JSON.stringify(v2.done.body)).toBe(200);
    const detail = (await api(ctx.app, ctx.owner, 'GET', `/api/admin/training/files/${file!.id}`)).body as TrainingFileDetail;
    expect(detail.versions.map((v) => v.versionNo)).toEqual([2, 1]);
    expect(detail.file.current.fileName).toBe('员工手册-2026.pdf');
    expect((await ctx.sql`UPDATE training_file_versions SET note = 'x' WHERE file_id = ${file!.id}`.catch((e: Error) => e)) instanceof Error).toBe(true);

    // 店员：能看的文件夹
    const mine = await folders(ctx.clerk);
    expect(mine.canManage).toBe(false);
    expect(mine.myDepartment).toBe('front');
    const names = mine.folders.map((f) => f.id);
    expect(names).toContain(pub.id);
    expect(names).toContain(front.id);
    expect(names).not.toContain(male.id);
    expect((await api(ctx.app, ctx.clerk, 'GET', `/api/training/folders/${male.id}/files`)).status).toBe(403);
    // 自己新建、不对应部门的文件夹所有人都看得到
    expect(mine.folders.some((f) => f.name === '安保')).toBe(true);

    // 读内容：整份、Range
    const full = await ctx.app.inject({ method: 'GET', url: `/api/training/files/${file!.id}/content`, headers: { cookie: ctx.clerk } });
    expect(full.statusCode).toBe(200);
    expect(full.headers['content-type']).toBe('application/pdf');
    expect(String(full.headers['content-disposition'])).toMatch(/^inline/);
    expect(full.rawPayload.equals(v2bytes)).toBe(true);
    const part = await ctx.app.inject({ method: 'GET', url: `/api/training/files/${file!.id}/content`, headers: { cookie: ctx.clerk, range: 'bytes=0-4' } });
    expect(part.statusCode).toBe(206);
    expect(part.rawPayload.toString('latin1')).toBe('%PDF-');
    expect(part.headers['content-range']).toBe(`bytes 0-4/${v2bytes.length}`);
    // 跨两块的 Range（第一版两块）：只有管理权限能读旧版本
    const v1 = detail.versions.find((v) => v.versionNo === 1)!;
    const cross = await ctx.app.inject({
      method: 'GET',
      url: `/api/training/files/${file!.id}/content?v=${v1.id}`,
      headers: { cookie: ctx.owner, range: `bytes=${TRAINING_CHUNK_BYTES - 2}-${TRAINING_CHUNK_BYTES + 1}` },
    });
    expect(cross.statusCode).toBe(206);
    expect(cross.rawPayload.length).toBe(4);
    const dl = await ctx.app.inject({ method: 'GET', url: `/api/training/files/${file!.id}/content?download=1`, headers: { cookie: ctx.clerk } });
    expect(String(dl.headers['content-disposition'])).toMatch(/^attachment/);

    // 看过
    expect((await api(ctx.app, ctx.clerk, 'POST', `/api/training/files/${file!.id}/viewed`)).status).toBe(200);
    expect((await api(ctx.app, ctx.clerk, 'POST', `/api/training/files/${file!.id}/viewed`)).status).toBe(200);
    const after = (await api(ctx.app, ctx.owner, 'GET', `/api/admin/training/files/${file!.id}`)).body as TrainingFileDetail;
    expect(after.viewers).toHaveLength(1);
    expect(after.viewers[0]).toMatchObject({ staffId: ctx.clerkId, viewCount: 2, versionNo: 2, department: '前厅部' });
    expect(after.file.viewerCount).toBe(1);
    const clerkFiles = (await api(ctx.app, ctx.clerk, 'GET', `/api/training/folders/${pub.id}/files`)).body as TrainingFile[];
    expect(clerkFiles[0]!.myLastViewedAt).not.toBeNull();
    expect(clerkFiles[0]!.viewerCount).toBeUndefined();
    expect((await api(ctx.app, ctx.clerk, 'GET', `/api/admin/training/files/${file!.id}`)).status).toBe(403);
  });

  it('下架的店员看不到、读不到；移到别的文件夹；停用的文件夹店员看不到；留审计', async () => {
    const pub = await folderOf((f) => f.kind === 'public');
    const front = await folderOf((f) => f.departmentKey === 'front');
    const [file] = (await api(ctx.app, ctx.owner, 'GET', `/api/training/folders/${pub.id}/files`)).body as TrainingFile[];
    const off = await api(ctx.app, ctx.owner, 'PUT', `/api/admin/training/files/${file!.id}`, {
      title: file!.title,
      description: '',
      folderId: pub.id,
      active: false,
      sort: 100,
      version: file!.version,
    });
    expect(off.status, JSON.stringify(off.body)).toBe(200);
    expect(((await api(ctx.app, ctx.clerk, 'GET', `/api/training/folders/${pub.id}/files`)).body as TrainingFile[]).some((f) => f.id === file!.id)).toBe(false);
    expect((await api(ctx.app, ctx.clerk, 'POST', `/api/training/files/${file!.id}/viewed`)).status).toBe(404);
    // 旧版本号再改：拒绝
    expect(
      (await api(ctx.app, ctx.owner, 'PUT', `/api/admin/training/files/${file!.id}`, { title: 'x', description: '', folderId: pub.id, active: true, sort: 1, version: file!.version })).body.error.code,
    ).toBe('TRAINING_FILE_CHANGED');
    const moved = await api(ctx.app, ctx.owner, 'PUT', `/api/admin/training/files/${file!.id}`, {
      title: '前厅手册',
      description: '前厅部用',
      folderId: front.id,
      active: true,
      sort: 1,
      version: off.body.file.version,
    });
    expect(moved.body.file).toMatchObject({ folderId: front.id, title: '前厅手册', active: true });
    // 停用前厅部文件夹：店员看不到
    await api(ctx.app, ctx.owner, 'PUT', `/api/admin/training/folders/${front.id}`, { name: front.name, sort: front.sort, active: false, version: front.version });
    expect((await folders(ctx.clerk)).folders.some((f) => f.id === front.id)).toBe(false);
    expect((await api(ctx.app, ctx.clerk, 'GET', `/api/training/folders/${front.id}/files`)).status).toBe(403);
    const audits = await ctx.sql<{ action: string }[]>`SELECT action FROM audit_logs WHERE action LIKE 'training_%'`;
    expect(new Set(audits.map((a) => a.action))).toEqual(new Set(['training_folder_saved', 'training_file_saved']));
  });

  it('Excel 在页面里看：读成表格（表名、表头、内容）；不是 Excel 的拒绝；店员看得到「培训资料」里的', async () => {
    const pub = await folderOf((f) => f.kind === 'public');
    const xlsx = buildXlsx({
      name: '应知应会',
      columns: [{ header: '区域' }, { header: '介绍' }],
      rows: [
        ['前厅', '接待、发牌'],
        ['男汤', '369 个衣柜'],
      ],
    });
    const r = await upload(xlsx, '应知应会.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', { folderId: pub.id });
    expect(r.done.status, JSON.stringify(r.done.body)).toBe(200);
    const sheet = await api(ctx.app, ctx.clerk, 'GET', `/api/training/files/${r.done.body.fileId}/sheet`);
    expect(sheet.status, JSON.stringify(sheet.body)).toBe(200);
    expect(sheet.body.sheets[0]).toMatchObject({ name: '应知应会', truncated: false });
    expect(sheet.body.sheets[0].rows).toEqual([
      ['区域', '介绍'],
      ['前厅', '接待、发牌'],
      ['男汤', '369 个衣柜'],
    ]);
    const pdf = await upload(PDF(300), '说明.pdf', 'application/pdf', { folderId: pub.id });
    expect((await api(ctx.app, ctx.clerk, 'GET', `/api/training/files/${pdf.done.body.fileId}/sheet`)).body.error.code).toBe('TRAINING_NOT_SHEET');
  });
});
