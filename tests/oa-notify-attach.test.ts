// OA-03 站内通知与附件（docs/OA.md 第 6 节）：notify() 发通知（同一件事没读的只留一条）、列表分页、未读数、标已读、只看自己的；
// 外发通道；附件上传（格式核对、缩略图）、下载头、谁能看、挂到单据上。
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NotificationPage, OaAttachment } from '../src/shared/oa';
import { attachmentsOf, bindAttachments, purgeStaleAttachments, registerAttachmentRef } from '../src/server/modules/oa/attachments';
import { notify, registerNotifyChannel } from '../src/server/modules/oa/notifications';
import { api, setup, type TestContext } from './helpers';

let ctx: TestContext;
let ownerId: number;
let clerkId: number;
beforeAll(async () => {
  ctx = await setup();
  const rows = await ctx.sql<{ id: number; username: string }[]>`SELECT id, username FROM staff WHERE username IN ('owner', 'clerk')`;
  ownerId = Number(rows.find((r) => r.username === 'owner')!.id);
  clerkId = Number(rows.find((r) => r.username === 'clerk')!.id);
});
afterAll(async () => ctx.close());

const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);
const b64 = (b: Buffer) => b.toString('base64');
const code = (r: { body: unknown }) => (r.body as { error: { code: string } }).error.code;

describe('OA-03 站内通知', () => {
  it('发通知：同一件事没读的只留一条；未读数、分页、标已读；只看得到自己的；外发通道收到', async () => {
    const sent: number[][] = [];
    registerNotifyChannel((ids) => sent.push([...ids]));
    await notify(ctx.sql, [clerkId], { kind: 'schedule_change', title: '排班变了', body: '明天早班', link: '/oa', ref: { type: 'schedule', id: 7 } });
    await notify(ctx.sql, [clerkId], { kind: 'schedule_change', title: '排班又变了', body: '明天晚班', link: '/oa', ref: { type: 'schedule', id: 7 } });
    for (let i = 0; i < 31; i += 1) await notify(ctx.sql, [clerkId, clerkId], { kind: 'system', title: `第 ${i} 条` });
    expect(sent).toHaveLength(33);
    expect(sent[2]).toEqual([clerkId]);

    let r = await api(ctx.app, ctx.clerk, 'GET', '/api/oa/notifications/unread-count');
    expect(r.body).toEqual({ unread: 32 });
    r = await api(ctx.app, ctx.clerk, 'GET', '/api/oa/notifications');
    const page = r.body as NotificationPage;
    expect(page.items).toHaveLength(30);
    expect(page.items[0]!.title).toBe('第 30 条');
    expect(page.nextBefore).not.toBeNull();
    r = await api(ctx.app, ctx.clerk, 'GET', `/api/oa/notifications?before=${page.nextBefore}`);
    const rest = (r.body as NotificationPage).items;
    expect(rest.map((x) => x.title)).toEqual(['第 0 条', '排班又变了']);
    expect(rest[1]).toMatchObject({ kind: 'schedule_change', body: '明天晚班', link: '/oa', readAt: null });

    // 别人看不到、标不了
    expect((await api(ctx.app, ctx.owner, 'GET', '/api/oa/notifications')).body).toMatchObject({ items: [], unread: 0 });
    await api(ctx.app, ctx.owner, 'POST', '/api/oa/notifications/read', { all: true });
    expect((await api(ctx.app, ctx.clerk, 'GET', '/api/oa/notifications/unread-count')).body).toEqual({ unread: 32 });

    // 标一条已读；读过以后同一件事再发，是新的一条
    r = await api(ctx.app, ctx.clerk, 'POST', '/api/oa/notifications/read', { ids: [rest[1]!.id] });
    expect(r.body).toEqual({ unread: 31 });
    await notify(ctx.sql, [clerkId], { kind: 'schedule_change', title: '排班第三次变', ref: { type: 'schedule', id: 7 } });
    r = await api(ctx.app, ctx.clerk, 'GET', '/api/oa/notifications?status=unread');
    expect((r.body as NotificationPage).items[0]!.title).toBe('排班第三次变');
    r = await api(ctx.app, ctx.clerk, 'POST', '/api/oa/notifications/read', { all: true });
    expect(r.body).toEqual({ unread: 0 });
    expect((await api(ctx.app, ctx.clerk, 'POST', '/api/oa/notifications/read', { ids: [] })).status).toBe(400);

    // 员工办公 v1.1 第 4 批：?breakdown=1 把系统通知未读（排除 im_message）单独拆出，防止「消息」Tab 与聊天未读重复计数
    await notify(ctx.sql, [clerkId], { kind: 'approval_todo', title: '有审批待办', link: '/oa/approvals' });
    const conv = await api<{ id: number }>(ctx.app, ctx.owner, 'POST', '/api/oa/im/direct', { staffId: clerkId });
    expect(conv.status, JSON.stringify(conv.body)).toBe(200);
    const sentMsg = await api(ctx.app, ctx.owner, 'POST', `/api/oa/im/conversations/${conv.body.id}/messages`, { clientKey: randomUUID(), kind: 'text', body: '测试合并红点' });
    expect(sentMsg.status, JSON.stringify(sentMsg.body)).toBe(201);
    expect((await api(ctx.app, ctx.clerk, 'GET', '/api/oa/notifications/unread-count')).body).toEqual({ unread: 2 });
    expect((await api(ctx.app, ctx.clerk, 'GET', '/api/oa/notifications/unread-count?breakdown=1')).body).toEqual({ unread: 2, systemUnread: 1 });
    await api(ctx.app, ctx.clerk, 'POST', '/api/oa/notifications/read', { all: true });
    expect((await api(ctx.app, ctx.clerk, 'GET', '/api/oa/notifications/unread-count?breakdown=1')).body).toEqual({ unread: 0, systemUnread: 0 });
  });
});

describe('OA-03 附件', () => {
  it('上传：核对格式与扩展名、缩略图；下载头；没挂到单据上只有上传的人看得到', async () => {
    const first = { clientKey: randomUUID(), fileName: '证明.png', mime: 'image/png', data: b64(PNG), thumb: b64(JPEG) };
    let r = await api(ctx.app, ctx.clerk, 'POST', '/api/oa/attachments', first);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const img = r.body as OaAttachment;
    expect(img).toMatchObject({ fileName: '证明.png', isImage: true, hasThumb: true, sizeBytes: PNG.length });
    // 原样重提：返回原来那一个，不再存一份；同一编号换了文件、换了人：拒绝
    r = await api(ctx.app, ctx.clerk, 'POST', '/api/oa/attachments', first);
    expect(r.status).toBe(200);
    expect((r.body as OaAttachment).id).toBe(img.id);
    const [cnt] = await ctx.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM oa_attachments WHERE client_key = ${first.clientKey}`;
    expect(cnt!.n).toBe(1);
    expect(code(await api(ctx.app, ctx.clerk, 'POST', '/api/oa/attachments', { ...first, fileName: '别的.png' }))).toBe('IDEMPOTENCY_CONFLICT');
    expect(code(await api(ctx.app, ctx.owner, 'POST', '/api/oa/attachments', first))).toBe('IDEMPOTENCY_CONFLICT');
    expect((await api(ctx.app, ctx.clerk, 'POST', '/api/oa/attachments', { ...first, clientKey: 'x' })).status).toBe(400);

    // 扩展名或文件头对不上
    r = await api(ctx.app, ctx.clerk, 'POST', '/api/oa/attachments', { clientKey: randomUUID(), fileName: '证明.pdf', mime: 'application/pdf', data: b64(PNG) });
    expect(code(r)).toBe('ATTACHMENT_INVALID');
    r = await api(ctx.app, ctx.clerk, 'POST', '/api/oa/attachments', { clientKey: randomUUID(), fileName: '证明.jpg', mime: 'image/png', data: b64(PNG) });
    expect(code(r)).toBe('ATTACHMENT_INVALID');
    r = await api(ctx.app, ctx.clerk, 'POST', '/api/oa/attachments', { clientKey: randomUUID(), fileName: 'a.exe', mime: 'application/x-msdownload', data: b64(PNG) });
    expect(r.status).toBe(400);
    // 非图片不能带缩略图；缩略图不是 JPEG
    r = await api(ctx.app, ctx.clerk, 'POST', '/api/oa/attachments', { clientKey: randomUUID(), fileName: 'a.txt', mime: 'text/plain', data: b64(Buffer.from('你好')), thumb: b64(JPEG) });
    expect(code(r)).toBe('ATTACHMENT_INVALID');
    r = await api(ctx.app, ctx.clerk, 'POST', '/api/oa/attachments', { clientKey: randomUUID(), fileName: 'b.png', mime: 'image/png', data: b64(PNG), thumb: b64(PNG) });
    expect(code(r)).toBe('ATTACHMENT_INVALID');

    // 文本：当附件下载、nosniff
    r = await api(ctx.app, ctx.clerk, 'POST', '/api/oa/attachments', { clientKey: randomUUID(), fileName: '说明.txt', mime: 'text/plain', data: b64(Buffer.from('<script>x</script>')) });
    const txt = r.body as OaAttachment;
    const dl = await ctx.app.inject({ method: 'GET', url: txt.url, headers: { cookie: ctx.clerk } });
    expect(dl.statusCode).toBe(200);
    expect(dl.headers['content-disposition']).toMatch(/^attachment; filename\*=UTF-8''/);
    expect(dl.headers['x-content-type-options']).toBe('nosniff');
    expect(dl.headers['cache-control']).toContain('no-store');
    const pic = await ctx.app.inject({ method: 'GET', url: img.url, headers: { cookie: ctx.clerk } });
    expect(pic.headers['content-disposition']).toMatch(/^inline/);
    const th = await ctx.app.inject({ method: 'GET', url: img.thumbUrl!, headers: { cookie: ctx.clerk } });
    expect(th.headers['content-type']).toBe('image/jpeg');
    expect(th.rawPayload.equals(JPEG)).toBe(true);

    // 没登录：不读正文直接拒绝
    const anon = await ctx.app.inject({ method: 'POST', url: '/api/oa/attachments', payload: { clientKey: randomUUID(), fileName: 'a.png', mime: 'image/png', data: b64(PNG) } });
    expect(anon.statusCode).toBe(401);
    // 别人：当不存在
    expect((await ctx.app.inject({ method: 'GET', url: img.url, headers: { cookie: ctx.owner } })).statusCode).toBe(404);
    expect((await ctx.app.inject({ method: 'GET', url: '/api/oa/attachments/999999', headers: { cookie: ctx.clerk } })).statusCode).toBe(404);
  });

  it('挂到单据上：只能挂自己传的、没挂过的；挂上以后按单据登记的办法看', async () => {
    const up = async (cookie: string, name: string) =>
      (await api(ctx.app, cookie, 'POST', '/api/oa/attachments', { clientKey: randomUUID(), fileName: name, mime: 'image/png', data: b64(PNG) })).body as OaAttachment;
    const a = await up(ctx.clerk, 'a.png');
    const b = await up(ctx.clerk, 'b.png');
    const other = await up(ctx.owner, 'c.png');
    registerAttachmentRef('test_doc', async (_db, actor, refId) => refId === 42 && actor.id === ownerId);
    const clerk = { id: clerkId } as Parameters<typeof bindAttachments>[2];
    // 别人的附件挂不上
    await expect(ctx.sql.begin((tx) => bindAttachments(tx, [a.id, other.id], clerk, { type: 'test_doc', id: 42 }))).rejects.toMatchObject({ code: 'ATTACHMENT_INVALID' });
    await ctx.sql.begin((tx) => bindAttachments(tx, [a.id, b.id], clerk, { type: 'test_doc', id: 42 }));
    // 挂过的不能再挂
    await expect(ctx.sql.begin((tx) => bindAttachments(tx, [a.id], clerk, { type: 'test_doc', id: 43 }))).rejects.toMatchObject({ code: 'ATTACHMENT_INVALID' });
    expect((await attachmentsOf(ctx.sql, { type: 'test_doc', id: 42 })).map((x) => x.fileName)).toEqual(['a.png', 'b.png']);
    // 单据的查看权限放行了总裁
    expect((await ctx.app.inject({ method: 'GET', url: a.url, headers: { cookie: ctx.owner } })).statusCode).toBe(200);
  });

  it('限额：没挂上的最多 30 个；24 小时内最多 300MB；没挂上的 24 小时后清掉，挂上的不动', async () => {
    const up = () => api(ctx.app, ctx.owner, 'POST', '/api/oa/attachments', { clientKey: randomUUID(), fileName: 'q.png', mime: 'image/png', data: b64(PNG) });
    await ctx.sql`DELETE FROM oa_attachments WHERE uploaded_by = ${ownerId}`;
    // 已有 30 个没挂上的
    await ctx.sql`
      INSERT INTO oa_attachments (client_key, uploaded_by, file_name, mime, size_bytes, sha256, data)
      SELECT gen_random_uuid(), ${ownerId}, 'p.png', 'image/png', 10, repeat('0', 64), '\\x00'::bytea FROM generate_series(1, 30)`;
    let r = await up();
    expect(code(r)).toBe('ATTACHMENT_QUOTA');
    // 过了 24 小时：没挂上的清掉
    await ctx.sql`UPDATE oa_attachments SET created_at = now() - interval '25 hours' WHERE uploaded_by = ${ownerId}`;
    expect(await purgeStaleAttachments(ctx.sql)).toBeGreaterThanOrEqual(30);
    expect((await up()).status).toBe(201);

    // 24 小时内已经传了 30 个 10MB（都挂到单据上了）：再传就超了；挂上的不清
    await ctx.sql`
      INSERT INTO oa_attachments (client_key, uploaded_by, file_name, mime, size_bytes, sha256, data, ref_type, ref_id, bound_at)
      SELECT gen_random_uuid(), ${ownerId}, 'b.png', 'image/png', 10485760, repeat('0', 64), '\\x00'::bytea, 'test_doc', 42, now() FROM generate_series(1, 30)`;
    r = await up();
    expect(code(r)).toBe('ATTACHMENT_QUOTA');
    await ctx.sql`UPDATE oa_attachments SET created_at = now() - interval '25 hours' WHERE uploaded_by = ${ownerId}`;
    await purgeStaleAttachments(ctx.sql);
    const [left] = await ctx.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM oa_attachments WHERE uploaded_by = ${ownerId} AND ref_type = 'test_doc'`;
    expect(left!.n).toBe(30);
    expect((await up()).status).toBe(201);
  });
});
