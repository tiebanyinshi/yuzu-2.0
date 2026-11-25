// 员工培训第一期（店主 2026-11-25，docs/TRAINING.md、PENDING_DECISIONS PC37）：文件夹、分块上传、版本、谁能看、读内容（Range）、谁看过。

import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TRAINING_CHUNK_BYTES, type TrainingFile, type TrainingFileDetail, type TrainingFolder, type TrainingFolderList } from '../src/shared/training';
import { buildWorkbook, buildXlsx, zip } from '../src/server/lib/xlsx';
import { setTrainingQuotaForTest, sweepTrainingUploads } from '../src/server/modules/training';
import { unzip } from '../src/server/lib/xlsx-read';
import { createStaff } from '../src/server/modules/staff';
import { api, login, PASSWORD, setup, type TestContext } from './helpers';

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
/** 改一份 Excel 第一张表的 XML 再打包（造合并单元格、成片的空行） */
const patchSheet = (xlsx: Buffer, edit: (xml: string) => string) =>
  zip([...unzip(xlsx)].map(([name, data]) => ({ name, data: name === 'xl/worksheets/sheet1.xml' ? Buffer.from(edit(data.toString('utf8'))) : data })));
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

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
    // 原样重提：改名那次其实改好了，按改好了算；新建带操作编号，原样重提返回原来那个，不报重名（Codex 审查 a3f5310）
    const again = await api(ctx.app, ctx.owner, 'PUT', `/api/admin/training/folders/${made.body.id}`, { name: '安保', sort: 200, active: true, version: made.body.version });
    expect(again.body).toMatchObject({ id: made.body.id, name: '安保' });
    const key = randomUUID();
    const first = await api(ctx.app, ctx.owner, 'POST', '/api/admin/training/folders', { clientKey: key, name: '工程小组' });
    expect(first.status).toBe(201);
    const second = await api(ctx.app, ctx.owner, 'POST', '/api/admin/training/folders', { clientKey: key, name: '工程小组' });
    expect(second.body).toMatchObject({ id: first.body.id });
    expect((await api(ctx.app, ctx.owner, 'POST', '/api/admin/training/folders', { clientKey: key, name: '别的' })).body.error.code).toBe('IDEMPOTENCY_CONFLICT');
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

  it('完成先认领（Codex 安全审查 f2dbf5a）：别人认领着回「正在登记」；认领过期（10 分钟）可以接手登记', async () => {
    const pub = await folderOf((f) => f.kind === 'public');
    const bytes = PDF(500);
    const clientKey = randomUUID();
    const s = await api(ctx.app, ctx.owner, 'POST', '/api/admin/training/uploads', { clientKey, fileName: '认领.pdf', mime: 'application/pdf', sizeBytes: bytes.length });
    await api(ctx.app, ctx.owner, 'PUT', `/api/admin/training/uploads/${s.body.uploadId}/chunks/0`, { data: bytes.toString('base64') });
    await ctx.sql`UPDATE training_uploads SET claim_token = ${randomUUID()}, claimed_at = now() WHERE id = ${s.body.uploadId}`;
    const busy = await api(ctx.app, ctx.owner, 'POST', `/api/admin/training/uploads/${s.body.uploadId}/complete`, { folderId: pub.id });
    expect(busy.status).toBe(409);
    expect(busy.body.error.code).toBe('TRAINING_UPLOAD_COMPLETING');
    await ctx.sql`UPDATE training_uploads SET claimed_at = now() - interval '11 minutes' WHERE id = ${s.body.uploadId}`;
    const ok = await api(ctx.app, ctx.owner, 'POST', `/api/admin/training/uploads/${s.body.uploadId}/complete`, { folderId: pub.id });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    // 登记失败（格式不对）放掉认领，不会卡住
    const bad = Buffer.from('not a pdf at all');
    const k2 = randomUUID();
    const s2 = await api(ctx.app, ctx.owner, 'POST', '/api/admin/training/uploads', { clientKey: k2, fileName: '坏.pdf', mime: 'application/pdf', sizeBytes: bad.length });
    await api(ctx.app, ctx.owner, 'PUT', `/api/admin/training/uploads/${s2.body.uploadId}/chunks/0`, { data: bad.toString('base64') });
    expect((await api(ctx.app, ctx.owner, 'POST', `/api/admin/training/uploads/${s2.body.uploadId}/complete`, { folderId: pub.id })).body.error.code).toBe('TRAINING_UPLOAD_FORMAT');
    const [r] = await ctx.sql<{ claimToken: string | null }[]>`SELECT claim_token FROM training_uploads WHERE id = ${s2.body.uploadId}`;
    expect(r!.claimToken).toBeNull();
    // 收尾：不传了（每人没传完的有上限，别占着后面的用例）
    await api(ctx.app, ctx.owner, 'POST', '/api/admin/training/uploads/cancel', { clientKey: k2, fileName: '坏.pdf', mime: 'application/pdf', sizeBytes: bad.length });
  });

  it('存储上限（Codex 安全审查 ec38502）：每人没传完的个数、24 小时开始次数、全库版本数', async () => {
    const pub = await folderOf((f) => f.kind === 'public');
    const start = (name: string) => api(ctx.app, ctx.owner, 'POST', '/api/admin/training/uploads', { clientKey: randomUUID(), fileName: name, mime: 'application/pdf', sizeBytes: 300 });
    try {
      // 前面的用例留了几个没传完的：上限设成「现有的 + 1」
      const [o] = await ctx.sql<{ n: number; d: number }[]>`
        SELECT count(*) FILTER (WHERE status = 'open')::int AS n, count(*)::int AS d FROM training_uploads WHERE created_by = ${ctx.ownerId}`;
      setTrainingQuotaForTest({ openUploads: o!.n + 1 });
      expect((await start('a.pdf')).status).toBe(200);
      const busy = await start('b.pdf');
      expect(busy.status).toBe(429);
      expect(busy.body.error.code).toBe('TRAINING_UPLOAD_BUSY');
      setTrainingQuotaForTest({ dailyUploads: o!.d + 1 });
      expect((await start('c.pdf')).body.error.code).toBe('TRAINING_DAILY_LIMIT');
      setTrainingQuotaForTest({ totalVersions: 0 });
      const r = await upload(PDF(321), '超额.pdf', 'application/pdf', { folderId: pub.id });
      expect(r.done.body.error.code).toBe('TRAINING_QUOTA');
    } finally {
      setTrainingQuotaForTest(null);
    }
  });

  it('接着传核对内容指纹；不传了：服务端作废登记，与完成互斥（Codex 审查 57dd2f6）', async () => {
    const pub = await folderOf((f) => f.kind === 'public');
    const big = PDF(TRAINING_CHUNK_BYTES + 10);
    const base = { fileName: '视频说明.pdf', mime: 'application/pdf', sizeBytes: big.length };
    // 同名、同大小但指纹不同（内容改过）：同一个编号不能接着传
    const clientKey = randomUUID();
    const s = await api(ctx.app, ctx.owner, 'POST', '/api/admin/training/uploads', { clientKey, ...base, fingerprint: 'aaaaaaaaaaaaaaaa' });
    expect(s.status).toBe(200);
    const other = await api(ctx.app, ctx.owner, 'POST', '/api/admin/training/uploads', { clientKey, ...base, fingerprint: 'bbbbbbbbbbbbbbbb' });
    expect(other.body.error.code).toBe('IDEMPOTENCY_CONFLICT');
    // 传了一块以后不传了：作废、丢掉块；之后传块、完成都拒绝，重新开始返回 cancelled
    await api(ctx.app, ctx.owner, 'PUT', `/api/admin/training/uploads/${s.body.uploadId}/chunks/0`, { data: big.subarray(0, TRAINING_CHUNK_BYTES).toString('base64') });
    const cancelled = await api(ctx.app, ctx.owner, 'POST', '/api/admin/training/uploads/cancel', { clientKey, ...base, fingerprint: 'aaaaaaaaaaaaaaaa' });
    expect(cancelled.body).toMatchObject({ status: 'cancelled', received: [] });
    expect((await api(ctx.app, ctx.owner, 'PUT', `/api/admin/training/uploads/${s.body.uploadId}/chunks/1`, { data: big.subarray(TRAINING_CHUNK_BYTES).toString('base64') })).body.error.code).toBe(
      'TRAINING_UPLOAD_CANCELLED',
    );
    expect((await api(ctx.app, ctx.owner, 'POST', `/api/admin/training/uploads/${s.body.uploadId}/complete`, { folderId: pub.id })).body.error.code).toBe('TRAINING_UPLOAD_CANCELLED');
    expect((await api(ctx.app, ctx.owner, 'POST', '/api/admin/training/uploads', { clientKey, ...base, fingerprint: 'aaaaaaaaaaaaaaaa' })).body.status).toBe('cancelled');
    // 万一有块赶在作废以后写进来（并发），定时清理也会清掉（Codex 安全审查 5cf662b）
    await ctx.sql`INSERT INTO training_upload_chunks (upload_id, seq, data) VALUES (${s.body.uploadId}, 1, ${Buffer.from('x')})`;
    await sweepTrainingUploads(ctx.sql, Date.now() + 10 * 60 * 60 * 1000);
    const [left] = await ctx.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM training_upload_chunks WHERE upload_id = ${s.body.uploadId}`;
    expect(left!.n).toBe(0);
    // 服务端还没见过的编号也能作废：先占住，原请求后到也开始不了
    const unseen = randomUUID();
    expect((await api(ctx.app, ctx.owner, 'POST', '/api/admin/training/uploads/cancel', { clientKey: unseen, ...base })).body.status).toBe('cancelled');
    expect((await api(ctx.app, ctx.owner, 'POST', '/api/admin/training/uploads', { clientKey: unseen, ...base })).body.status).toBe('cancelled');
    // 已经登记好的不能作废，原样回 done
    const done = await upload(PDF(400), '已传完.pdf', 'application/pdf', { folderId: pub.id });
    const late = await api(ctx.app, ctx.owner, 'POST', '/api/admin/training/uploads/cancel', {
      clientKey: done.clientKey,
      fileName: '已传完.pdf',
      mime: 'application/pdf',
      sizeBytes: PDF(400).length,
    });
    expect(late.body).toMatchObject({ status: 'done', fileId: done.done.body.fileId });
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

    // 读内容带版本（Codex 审查 e1d8be3）：带当前版本照常读；店员带旧版本（看的时候换了新版本）拒绝，不拿别的版本的片段
    const firstVersion = detail.versions.find((v) => v.versionNo === 1)!;
    const pinned = await ctx.app.inject({ method: 'GET', url: `/api/training/files/${file!.id}/content?v=${detail.file.current.id}`, headers: { cookie: ctx.clerk, range: 'bytes=0-4' } });
    expect(pinned.statusCode).toBe(206);
    const stale = await ctx.app.inject({ method: 'GET', url: `/api/training/files/${file!.id}/content?v=${firstVersion.id}`, headers: { cookie: ctx.clerk, range: 'bytes=0-4' } });
    expect(stale.statusCode).toBe(409);
    expect(JSON.parse(stale.payload).error.code).toBe('TRAINING_VERSION_CHANGED');
    expect((await ctx.app.inject({ method: 'GET', url: `/api/training/files/${file!.id}/content?v=${firstVersion.id}`, headers: { cookie: ctx.owner } })).statusCode).toBe(200);

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
    const cross = await ctx.app.inject({
      method: 'GET',
      url: `/api/training/files/${file!.id}/content?v=${firstVersion.id}`,
      headers: { cookie: ctx.owner, range: `bytes=${TRAINING_CHUNK_BYTES - 2}-${TRAINING_CHUNK_BYTES + 1}` },
    });
    expect(cross.statusCode).toBe(206);
    expect(cross.rawPayload.length).toBe(4);
    const dl = await ctx.app.inject({ method: 'GET', url: `/api/training/files/${file!.id}/content?download=1`, headers: { cookie: ctx.clerk } });
    expect(String(dl.headers['content-disposition'])).toMatch(/^attachment/);

    // 看过：带了页面打开的版本，是旧版本的不记（Codex 审查 57dd2f6）
    const staleView = await api(ctx.app, ctx.clerk, 'POST', `/api/training/files/${file!.id}/viewed`, { versionId: firstVersion.id });
    expect(staleView.body.error.code).toBe('TRAINING_VERSION_CHANGED');
    expect((await api(ctx.app, ctx.clerk, 'POST', `/api/training/files/${file!.id}/viewed`, { versionId: detail.file.current.id })).status).toBe(200);
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
    // 原样重提（没收到结果）：现在的内容就是要改成的，按改好了算（Codex 审查 a3f5310）
    const replay = await api(ctx.app, ctx.owner, 'PUT', `/api/admin/training/files/${file!.id}`, {
      title: file!.title,
      description: '',
      folderId: pub.id,
      active: false,
      sort: 100,
      version: file!.version,
    });
    expect(replay.status, JSON.stringify(replay.body)).toBe(200);
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

  it('Excel 防撑爆（Codex 审查 e1d8be3）：合并单元格裁到显示范围；成片的空行在解析前就拒绝', async () => {
    const pub = await folderOf((f) => f.kind === 'public');
    const base = buildXlsx({ name: '表', columns: [{ header: '甲' }, { header: '乙' }], rows: [['1', '2']] });
    // 合并到 XFD1048576：页面只铺 2 行 2 列，合并范围裁成 A1:B2
    const merged = patchSheet(base, (x) => x.replace('</sheetData>', '</sheetData><mergeCells count="1"><mergeCell ref="A1:XFD1048576"/></mergeCells>'));
    const m = await upload(merged, '合并.xlsx', XLSX_MIME, { folderId: pub.id });
    expect(m.done.status, JSON.stringify(m.done.body)).toBe(200);
    // 带了版本：员工带的不是这份文件的当前版本拒绝（Codex 审查 a3f5310）
    expect((await api(ctx.app, ctx.clerk, 'GET', `/api/training/files/${m.done.body.fileId}/sheet?v=999999`)).body.error.code).toBe('TRAINING_VERSION_CHANGED');
    const sheet = await api(ctx.app, ctx.clerk, 'GET', `/api/training/files/${m.done.body.fileId}/sheet?v=${m.done.body.versionId}`);
    expect(sheet.status, JSON.stringify(sheet.body)).toBe(200);
    expect(sheet.body.sheets[0].merges).toEqual([{ r1: 1, c1: 0, r2: 2, c2: 1 }]);
    // 同一份文件两个人同时读：等同一次解析，结果一样（Codex 审查 e9daa1c）
    const [a, b] = await Promise.all([
      api(ctx.app, ctx.owner, 'GET', `/api/training/files/${m.done.body.fileId}/sheet`),
      api(ctx.app, ctx.clerk, 'GET', `/api/training/files/${m.done.body.fileId}/sheet`),
    ]);
    expect(a.body).toEqual(b.body);
    // 15 万个空行（Codex 安全审查 f2dbf5a 把上限降到 12 万）：压缩后几 KB，解析前按结构规模拒绝；第二次读走缓存，同样拒绝
    const empty = patchSheet(base, (x) => x.replace('</sheetData>', `${Array.from({ length: 150_000 }, (_, i) => `<row r="${i + 3}"/>`).join('')}</sheetData>`));
    expect(empty.length).toBeLessThan(2 * 1024 * 1024);
    const e = await upload(empty, '空行.xlsx', XLSX_MIME, { folderId: pub.id });
    expect(e.done.status, JSON.stringify(e.done.body)).toBe(200);
    const bad = await api(ctx.app, ctx.clerk, 'GET', `/api/training/files/${e.done.body.fileId}/sheet`);
    expect(bad.body.error?.code, JSON.stringify(bad.body)).toBe('TRAINING_SHEET_INVALID');
    expect((await api(ctx.app, ctx.clerk, 'GET', `/api/training/files/${e.done.body.fileId}/sheet`)).body.error?.code).toBe('TRAINING_SHEET_INVALID');
    // 一格 32 MB 的字（压缩后几十 KB）：解压超过 8 MB 就拒绝（Codex 安全审查 57dd2f6）
    const huge = patchSheet(base, (x) => x.replace('>1<', `>${'字'.repeat(11 * 1024 * 1024)}<`));
    expect(huge.length).toBeLessThan(2 * 1024 * 1024);
    const h = await upload(huge, '大格子.xlsx', XLSX_MIME, { folderId: pub.id });
    expect(h.done.status, JSON.stringify(h.done.body)).toBe(200);
    expect((await api(ctx.app, ctx.clerk, 'GET', `/api/training/files/${h.done.body.fileId}/sheet`)).body.error?.code).toBe('TRAINING_SHEET_INVALID');
    // 五万个重复 / 重叠的合并区：只留不重叠的、总面积不超过显示的格子数（Codex 审查 ec38502）
    const manyMerges = patchSheet(base, (x) => x.replace('</sheetData>', `</sheetData><mergeCells count="50000">${'<mergeCell ref="A1:AN500"/>'.repeat(50_000)}</mergeCells>`));
    const mm = await upload(manyMerges, '重叠合并.xlsx', XLSX_MIME, { folderId: pub.id });
    const mms = await api(ctx.app, ctx.clerk, 'GET', `/api/training/files/${mm.done.body.fileId}/sheet`);
    expect(mms.status, JSON.stringify(mms.body).slice(0, 300)).toBe(200);
    expect(mms.body.sheets[0].merges).toEqual([{ r1: 1, c1: 0, r2: 2, c2: 1 }]);
    // 21 张表：只显示 20 张，标表格太大
    const many = buildWorkbook(Array.from({ length: 21 }, (_, i) => ({ name: `表${i + 1}`, widths: [10], rows: [{ cells: [`第 ${i + 1} 张`] }] })));
    const ms = await upload(many, '多表.xlsx', XLSX_MIME, { folderId: pub.id });
    const mss = await api(ctx.app, ctx.clerk, 'GET', `/api/training/files/${ms.done.body.fileId}/sheet`);
    expect(mss.body.sheets).toHaveLength(20);
    expect(mss.body.sheets[0].truncated).toBe(true);
    // 一格 5000 个字：页面里截到 2000 个字，标表格太大
    const long = patchSheet(base, (x) => x.replace('>1<', `>${'长'.repeat(5000)}<`));
    const l = await upload(long, '长格子.xlsx', XLSX_MIME, { folderId: pub.id });
    const ls = await api(ctx.app, ctx.clerk, 'GET', `/api/training/files/${l.done.body.fileId}/sheet`);
    expect(ls.body.sheets[0].rows[1][0]).toHaveLength(2001);
    expect(ls.body.sheets[0].truncated).toBe(true);
  });

  it('专用账号（平板、他店、设计师）不能看员工培训（Codex 安全审查 b638705）', async () => {
    const pub = await folderOf((f) => f.kind === 'public');
    const up = await upload(PDF(1000), 'special.pdf', 'application/pdf', { folderId: pub.id, title: '专用账号不能看' });
    expect(up.done.status, JSON.stringify(up.done.body)).toBe(200);
    const fileId = up.done.body.fileId;
    for (const role of ['tablet', 'other_store', 'designer'] as const) {
      const username = `train_${role}`;
      await createStaff(ctx.sql, { username, displayName: username, role, password: PASSWORD, mustChangePassword: false });
      const cookie = await login(ctx.app, username);
      for (const url of ['/api/training/folders', `/api/training/folders/${pub.id}/files`, `/api/training/files/${fileId}/sheet`, `/api/training/files/${fileId}/content`]) {
        expect((await api(ctx.app, cookie, 'GET', url)).status, `${role} ${url}`).toBe(403);
      }
      expect((await api(ctx.app, cookie, 'POST', `/api/training/files/${fileId}/viewed`, {})).status).toBe(403);
    }
    // 在职员工照常能看
    expect((await api(ctx.app, ctx.clerk, 'GET', `/api/training/files/${fileId}/content`)).status).toBe(200);
  });
});
